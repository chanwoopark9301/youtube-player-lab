export class TranscriptError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TranscriptError';
    this.code = code;
  }
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 12000;
const invalid = message => new TranscriptError('invalid_response', message);

async function readBody(response) {
  if (Number(response.headers.get('content-length')) > MAX_BODY_BYTES) {
    void response.body?.cancel().catch(() => {});
    throw invalid('YouTube returned a response larger than the allowed limit.');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        void reader.cancel().catch(() => {});
        throw invalid('YouTube returned a response larger than the allowed limit.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

function parseJSON(text) {
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('Invalid YouTube response.');
    return value;
  } catch {
    throw invalid('YouTube returned unreadable caption data.');
  }
}

function selectTrack(player, language) {
  const status = player.playabilityStatus?.status;
  if (typeof status !== 'string') throw invalid('YouTube returned no playback availability status.');
  if (status === 'LOGIN_REQUIRED' || /not a bot|captcha/i.test(player.playabilityStatus?.reason || '')) {
    throw new TranscriptError('blocked', 'YouTube requires authentication or an access check.');
  }
  if (status !== 'OK') throw new TranscriptError('unavailable', 'This video is unavailable for public caption retrieval.');
  const tracks = player.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (tracks === undefined || (Array.isArray(tracks) && tracks.length === 0)) {
    throw new TranscriptError('unavailable', 'No public captions were available for this video.');
  }
  if (!Array.isArray(tracks) || tracks.some(track => !track || typeof track.languageCode !== 'string' || typeof track.baseUrl !== 'string')) {
    throw invalid('YouTube returned an invalid caption track list.');
  }
  const preferences = [language.toLowerCase(), language.split('-')[0].toLowerCase(), 'en'];
  for (const code of preferences) {
    const matching = tracks.filter(track => track.languageCode.toLowerCase() === code);
    const track = matching.find(item => item.kind !== 'asr') || matching[0];
    if (track) return track;
  }
  return tracks.find(track => track.kind !== 'asr') || tracks[0];
}

function captionURL(track, videoId) {
  let url;
  try { url = new URL(track.baseUrl); } catch { throw invalid('YouTube returned an invalid caption URL.'); }
  if (url.protocol !== 'https:' || !['www.youtube.com', 'youtube.com'].includes(url.hostname) ||
      url.port || url.username || url.password || url.hash || url.pathname !== '/api/timedtext' || url.searchParams.get('v') !== videoId) {
    throw invalid('YouTube returned an unexpected caption destination.');
  }
  if (url.searchParams.get('exp') === 'xpe' || url.searchParams.has('pot')) {
    throw new TranscriptError('blocked', 'YouTube requires additional client verification for these captions.');
  }
  url.searchParams.set('fmt', 'json3');
  return url;
}

function parseCues(data) {
  if (!Array.isArray(data.events)) throw invalid('YouTube returned an invalid timed caption document.');
  const cues = [];
  for (const event of data.events) {
    if (!event || typeof event !== 'object') throw invalid('YouTube returned an invalid caption event.');
    if (event.segs === undefined) continue; // JSON3 also contains window/style events.
    if (!Array.isArray(event.segs) || !Number.isFinite(event.tStartMs) || event.tStartMs < 0 ||
        (event.dDurationMs !== undefined && (!Number.isFinite(event.dDurationMs) || event.dDurationMs < 0)) ||
        event.segs.some(segment => typeof segment?.utf8 !== 'string')) {
      throw invalid('YouTube returned invalid caption text or timing.');
    }
    const text = event.segs.map(segment => segment.utf8).join('').trim();
    if (text) cues.push({ start: event.tStartMs / 1000, duration: (event.dDurationMs || 0) / 1000, text });
  }
  if (!cues.length) throw new TranscriptError('unavailable', 'The public caption track contained no text.');
  return cues;
}

/**
 * Uses the public web-client flow also documented by youtube-transcript-api:
 * https://github.com/jdepoix/youtube-transcript-api
 * This is not the supported YouTube Data API; its response shape may change.
 * The player configuration contains a public web-client key, never a user key.
 */
export async function fetchTranscript(videoId, { language = 'ko', fetchImpl = fetch } = {}) {
  if (typeof videoId !== 'string' || videoId.length !== 11 || !/^[A-Za-z0-9_-]{11}$/.test(videoId) ||
      typeof language !== 'string' || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(language) || typeof fetchImpl !== 'function') {
    throw new TranscriptError('invalid_input', 'A valid YouTube video ID and caption language are required.');
  }
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new TranscriptError('network', 'Public caption retrieval timed out.'));
    }, TIMEOUT_MS);
  });
  const request = async (url, type, options = {}) => {
    if (controller.signal.aborted) throw new TranscriptError('network', 'Public caption retrieval timed out.');
    const response = await fetchImpl(url, { ...options, signal: controller.signal, credentials: 'omit', redirect: 'manual' });
    if ([401, 403, 429].includes(response.status) || (response.status >= 300 && response.status < 400)) {
      void response.body?.cancel().catch(() => {});
      throw new TranscriptError('blocked', 'YouTube blocked public caption retrieval or requires an access check.');
    }
    if ([404, 410].includes(response.status)) throw new TranscriptError('unavailable', 'The requested public video or captions were not found.');
    if (response.status >= 500) throw new TranscriptError('network', 'YouTube could not complete the caption request.');
    if (!response.ok) throw invalid('YouTube rejected the public caption request.');
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    const text = await readBody(response);
    const challengeMarkup = /<[^>]+class=["'][^"']*\bg-recaptcha\b|action=["']https:\/\/consent\.youtube\.com\/s/i.test(text);
    const challengeText = !text.includes('"INNERTUBE_API_KEY"') && /unusual traffic|sign in to confirm.{0,20}not a bot/i.test(text);
    if (contentType.includes('text/html') && (challengeMarkup || challengeText)) {
      throw new TranscriptError('blocked', 'YouTube requires an access check before returning captions.');
    }
    if (!contentType.includes(type)) throw invalid('YouTube returned an unexpected response format.');
    return text;
  };
  const retrieve = async () => {
    const sourceUrl = 'https://www.youtube.com/watch?v=' + videoId;
    const html = await request(sourceUrl, 'text/html');
    const publicKey = html.match(/"INNERTUBE_API_KEY":\s*"([A-Za-z0-9_-]+)"/)?.[1];
    if (!publicKey) throw invalid('YouTube did not expose a readable public player configuration.');
    // The upstream project's normal client configuration, with no retry/client switching on blocks.
    const player = parseJSON(await request('https://www.youtube.com/youtubei/v1/player?key=' + publicKey, 'application/json', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38' } }, videoId }),
    }));
    const track = selectTrack(player, language);
    const cues = parseCues(parseJSON(await request(captionURL(track, videoId), 'application/json')));
    return { videoId, language: track.languageCode, source: 'youtube-public-captions', sourceUrl, cues, generated: track.kind === 'asr' };
  };
  try {
    return await Promise.race([retrieve(), deadline]);
  } catch (error) {
    if (error instanceof TranscriptError) throw error;
    // Native fetch errors can contain signed URLs. Do not expose them to callers.
    throw new TranscriptError('network', 'The public caption request could not be completed.');
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
