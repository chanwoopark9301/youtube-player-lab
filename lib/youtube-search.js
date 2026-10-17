const YOUTUBE_ORIGIN = 'https://www.youtube.com';
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 12000;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export class CatalogError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CatalogError';
    this.code = code;
  }
}

function invalidResponse() {
  return new CatalogError('invalid_response', 'YouTube 응답에서 영상 정보를 확인하지 못했어요.');
}

async function boundedText(response) {
  const declaredSize = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_BODY_BYTES) {
    await response.body?.cancel();
    throw invalidResponse();
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0, text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        await reader.cancel();
        throw invalidResponse();
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    if (error instanceof CatalogError) throw error;
    if (error instanceof TypeError && error.code === 'ERR_ENCODING_INVALID_ENCODED_DATA') throw invalidResponse();
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function fetchText(url, fetchImpl, accept) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new CatalogError('network', 'YouTube 요청 시간이 초과됐어요. 잠시 뒤 다시 시도해 주세요.'));
    }, REQUEST_TIMEOUT_MS);
  });
  try {
    return await Promise.race([deadline, (async () => {
      const response = await fetchImpl(url, { signal: controller.signal, headers: { accept } });
      if ([401, 403, 429].includes(response.status)) {
        await response.body?.cancel();
        throw new CatalogError('blocked', 'YouTube가 이 서버의 요청을 제한했어요.');
      }
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status >= 500) throw new CatalogError('network', 'YouTube 서버에 일시적으로 연결하지 못했어요.');
        throw invalidResponse();
      }
      return await boundedText(response);
    })()]);
  } catch (error) {
    if (error instanceof CatalogError) throw error;
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError' || controller.signal.aborted) {
      throw new CatalogError('network', 'YouTube 요청 시간이 초과됐어요. 잠시 뒤 다시 시도해 주세요.');
    }
    throw new CatalogError('network', 'YouTube에 연결하지 못했어요. 잠시 뒤 다시 시도해 주세요.');
  } finally {
    clearTimeout(timer);
  }
}

function parseInitialData(html) {
  const marker = /(?:\b(?:var|let|const)\s+ytInitialData\s*=|\bwindow\[['"]ytInitialData['"]\]\s*=)/.exec(html);
  if (!marker) {
    if (/unusual traffic|confirm.{0,40}not a bot|google\.com\/sorry|consent\.(?:youtube|google)\.com|before you continue to youtube/i.test(html)) {
      throw new CatalogError('blocked', 'YouTube가 서버 요청에 확인 절차를 요구했어요.');
    }
    throw invalidResponse();
  }
  let start = marker.index + marker[0].length;
  while (/\s/.test(html[start] || '') && start < html.length) start++;
  if (html[start] !== '{') throw invalidResponse();
  let depth = 0, quoted = false, escaped = false;
  for (let index = start; index < html.length; index++) {
    const character = html[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === '{') depth++;
    else if (character === '}' && --depth === 0) {
      try {
        return JSON.parse(html.slice(start, index + 1));
      } catch {
        throw invalidResponse();
      }
    }
  }
  throw invalidResponse();
}

function renderedText(value) {
  if (typeof value?.simpleText === 'string') return value.simpleText.trim();
  if (!Array.isArray(value?.runs)) return '';
  return value.runs.map(run => typeof run?.text === 'string' ? run.text : '').join('').trim();
}

function collectVideos(data, limit) {
  const contents = data?.contents;
  const searchContents = contents?.twoColumnSearchResultsRenderer?.primaryContents
    ?? contents?.singleColumnSearchResultsRenderer
    ?? contents?.sectionListRenderer;
  if (!searchContents || typeof searchContents !== 'object' || Array.isArray(searchContents)) throw invalidResponse();
  const stack = [searchContents], seen = new Set(), videos = [];
  while (stack.length && videos.length < limit) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    const video = node.videoRenderer;
    if (video && typeof video.videoId === 'string' && VIDEO_ID.test(video.videoId) && !seen.has(video.videoId)) {
      const title = renderedText(video.title);
      if (title) {
        seen.add(video.videoId);
        videos.push({
          videoId: video.videoId,
          title,
          channel: renderedText(video.ownerText) || renderedText(video.longBylineText) || renderedText(video.shortBylineText),
          watchUrl: YOUTUBE_ORIGIN + '/watch?v=' + video.videoId,
        });
      }
    }
    const children = Object.values(node);
    for (let index = children.length - 1; index >= 0; index--) {
      if (children[index] && typeof children[index] === 'object') stack.push(children[index]);
    }
  }
  return videos;
}

export async function searchVideos(query, { limit = 5, fetchImpl = fetch } = {}) {
  if (typeof query !== 'string') throw new CatalogError('invalid_query', '검색어를 입력해 주세요.');
  query = query.trim();
  if (!query || [...query].length > 160 || /[\u0000-\u001f\u007f]/.test(query)) {
    throw new CatalogError('invalid_query', '검색어는 1자 이상 160자 이하로 입력해 주세요.');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 8) throw new CatalogError('invalid_limit', '검색 후보 수는 1개 이상 8개 이하로 지정해 주세요.');
  const url = new URL('/results', YOUTUBE_ORIGIN);
  url.searchParams.set('search_query', query);
  url.searchParams.set('hl', 'ko');
  url.searchParams.set('gl', 'KR');
  const html = await fetchText(url, fetchImpl, 'text/html');
  const videos = collectVideos(parseInitialData(html), limit);
  return { query, source: 'youtube-public-search', sourceUrl: url.href, videos };
}

export async function getVideoMetadata(videoId, { fetchImpl = fetch } = {}) {
  if (typeof videoId !== 'string' || !VIDEO_ID.test(videoId)) throw new CatalogError('invalid_video_id', '올바른 YouTube 영상 ID가 필요해요.');
  const watchUrl = YOUTUBE_ORIGIN + '/watch?v=' + videoId;
  const url = new URL('/oembed', YOUTUBE_ORIGIN);
  url.searchParams.set('url', watchUrl);
  url.searchParams.set('format', 'json');
  const text = await fetchText(url, fetchImpl, 'application/json');
  let data;
  try { data = JSON.parse(text); } catch { throw invalidResponse(); }
  if (typeof data?.title !== 'string' || !data.title.trim() || typeof data?.author_name !== 'string' || !data.author_name.trim()) throw invalidResponse();
  return { videoId, title: data.title.trim(), channel: data.author_name.trim(), watchUrl };
}
