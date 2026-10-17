import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchTranscript, TranscriptError } from '../lib/youtube-transcript.js';

const VIDEO = 'M7lc1UVf-VE';
const WATCH = '<html><script>ytcfg.set({"INNERTUBE_API_KEY":"public-fixture-config"});</script></html>';
// Reduced to the fields consumed from the successful 2026-10-17 public response.
const manual = { languageCode: 'en', baseUrl: 'https://www.youtube.com/api/timedtext?v=M7lc1UVf-VE&lang=en&signature=private-signed-value&fmt=srv3' };
const generated = { ...manual, kind: 'asr' };
const payload = {
  events: [{ tStartMs: 10349, dDurationMs: 1000, segs: [{ utf8: 'JEFF POSNICK: Hey, everybody.' }] }],
};
const jsonResponse = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const watchResponse = () => new Response(WATCH, { headers: { 'content-type': 'text/html' } });
const playerResponse = (tracks = [manual, generated]) => jsonResponse({
  playabilityStatus: { status: 'OK' },
  captions: { playerCaptionsTracklistRenderer: { captionTracks: tracks } },
});

function fixture({ watch = watchResponse, player = () => playerResponse(), captions = () => jsonResponse(payload) } = {}) {
  const calls = [];
  const responses = [watch, player, captions];
  return {
    calls,
    fetchImpl: async (input, options) => {
      const url = new URL(input);
      calls.push({ url, options });
      const response = responses[calls.length - 1];
      if (!response) throw new Error('unexpected fourth HTTP request');
      return response(url, options);
    },
  };
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, error => error instanceof TranscriptError && error.code === code);
}

test('fetches public timed captions in seconds and returns canonical provenance without signed URLs', async () => {
  const f = fixture();
  const result = await fetchTranscript(VIDEO, { fetchImpl: f.fetchImpl });
  assert.deepEqual(result, {
    videoId: VIDEO, language: 'en', source: 'youtube-public-captions',
    sourceUrl: 'https://www.youtube.com/watch?v=M7lc1UVf-VE', generated: false,
    cues: [{ start: 10.349, duration: 1, text: 'JEFF POSNICK: Hey, everybody.' }],
  });
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls[0].url.href, 'https://www.youtube.com/watch?v=M7lc1UVf-VE');
  assert.equal(f.calls[1].url.pathname, '/youtubei/v1/player');
  assert.equal(f.calls[1].options.method, 'POST');
  assert.equal(JSON.parse(f.calls[1].options.body).videoId, VIDEO);
  assert.equal(f.calls[2].url.pathname, '/api/timedtext');
  assert.equal(f.calls[2].url.searchParams.get('fmt'), 'json3');
  for (const { options } of f.calls) {
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.signal, f.calls[0].options.signal, 'all stages share one deadline');
    assert.equal(options.headers?.authorization, undefined);
  }
  assert.doesNotMatch(JSON.stringify(result), /signature|private-signed-value|public-fixture-config/);
});

test('selects the requested language before English and prefers manual captions within that language', async () => {
  const korean = { languageCode: 'ko', baseUrl: manual.baseUrl.replace('lang=en', 'lang=ko') };
  const f = fixture({ player: () => playerResponse([manual, { ...korean, kind: 'asr' }, korean]) });
  const result = await fetchTranscript(VIDEO, { language: 'ko', fetchImpl: f.fetchImpl });
  assert.equal(result.language, 'ko');
  assert.equal(result.generated, false);
  assert.equal(f.calls[2].url.searchParams.get('lang'), 'ko');
});

test('reports generated captions and joins JSON3 text runs without treating text as HTML', async () => {
  const f = fixture({ player: () => playerResponse([generated]), captions: () => jsonResponse({ events: [
    { tStartMs: 0, dDurationMs: 1500, segs: [{ utf8: 'one ' }, { utf8: '<two>\nthree' }] },
    { tStartMs: 1500, dDurationMs: 0, segs: [{ utf8: '   ' }] },
  ] }) });
  const result = await fetchTranscript(VIDEO, { fetchImpl: f.fetchImpl });
  assert.equal(result.generated, true);
  assert.deepEqual(result.cues, [{ start: 0, duration: 1.5, text: 'one <two>\nthree' }]);
});

test('does not mistake a caption discussing access challenges for an actual challenge response', async () => {
  const f = fixture({ captions: () => jsonResponse({ events: [
    { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'The unusual traffic page may show g-recaptcha.' }] },
  ] }) });
  const result = await fetchTranscript(VIDEO, { fetchImpl: f.fetchImpl });
  assert.equal(result.cues[0].text, 'The unusual traffic page may show g-recaptcha.');
});

test('rejects invalid IDs and malformed language before making any HTTP request', async () => {
  for (const videoId of ['', 'short', VIDEO + '\n', VIDEO + '!', 'https://www.youtube.com/watch?v=' + VIDEO, null, [VIDEO]]) {
    const f = fixture();
    await rejectsCode(fetchTranscript(videoId, { fetchImpl: f.fetchImpl }), 'invalid_input');
    assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  await rejectsCode(fetchTranscript(VIDEO, { language: '../ko', fetchImpl: f.fetchImpl }), 'invalid_input');
  assert.equal(f.calls.length, 0);
});

test('returns unavailable when the player denies playback or has no public caption tracks', async () => {
  for (const data of [{ playabilityStatus: { status: 'ERROR', reason: 'Video unavailable' } },
    { playabilityStatus: { status: 'OK' } }]) {
    const f = fixture({ player: () => jsonResponse(data) });
    await rejectsCode(fetchTranscript(VIDEO, { fetchImpl: f.fetchImpl }), 'unavailable');
    assert.equal(f.calls.length, 2);
  }
});

test('stops on access challenges and HTTP blocks without trying another client or caption URL', async () => {
  const scenarios = [
    { watch: () => new Response('rate limited', { status: 429 }), count: 1 },
    { watch: () => new Response('forbidden', { status: 403 }), count: 1 },
    { watch: () => new Response('<div class="g-recaptcha"></div>', { headers: { 'content-type': 'text/html' } }), count: 1 },
    { watch: () => new Response('', { status: 302, headers: { location: 'https://consent.youtube.com/m' } }), count: 1 },
    { player: () => jsonResponse({ playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'Sign in to confirm you’re not a bot' } }), count: 2 },
    { player: () => playerResponse([{ ...manual, baseUrl: manual.baseUrl + '&exp=xpe' }]), count: 2 },
    { captions: () => new Response('<div class="g-recaptcha"></div>', { headers: { 'content-type': 'text/html' } }), count: 3 },
  ];
  for (const { count, ...overrides } of scenarios) {
    const f = fixture(overrides);
    await rejectsCode(fetchTranscript(VIDEO, { fetchImpl: f.fetchImpl }), 'blocked');
    assert.equal(f.calls.length, count);
  }
});

test('refuses arbitrary hosts, non-HTTPS, credentials, paths and mismatched IDs from upstream captions', async () => {
  for (const baseUrl of [
    'https://evil.example/api/timedtext?v=' + VIDEO,
    'http://www.youtube.com/api/timedtext?v=' + VIDEO,
    'https://user:secret@www.youtube.com/api/timedtext?v=' + VIDEO,
    'https://www.youtube.com:444/api/timedtext?v=' + VIDEO,
    'https://www.youtube.com/videoplayback?v=' + VIDEO,
    'https://www.youtube.com/api/timedtext?v=jNQXAC9IVRw',
  ]) {
    const f = fixture({ player: () => playerResponse([{ ...manual, baseUrl }]) });
    await rejectsCode(fetchTranscript(VIDEO, { fetchImpl: f.fetchImpl }), 'invalid_response');
    assert.equal(f.calls.length, 2);
  }
});

test('maps transport failures to a sanitized network error', async () => {
  const f = fixture({ captions: () => { throw new Error('failed: ' + manual.baseUrl); } });
  await assert.rejects(fetchTranscript(VIDEO, { fetchImpl: f.fetchImpl }), error => {
    assert.ok(error instanceof TranscriptError);
    assert.equal(error.code, 'network');
    assert.doesNotMatch(error.message, /signature|private-signed-value|https:/);
    return true;
  });
  assert.equal(f.calls.length, 3);
});

test('rejects malformed player or caption data rather than returning an empty success', async () => {
  for (const overrides of [
    { watch: () => new Response('<html>missing configuration</html>', { headers: { 'content-type': 'text/html' } }) },
    { player: () => new Response('{broken', { headers: { 'content-type': 'application/json' } }) },
    { player: () => jsonResponse({}) },
    { captions: () => new Response('', { headers: { 'content-type': 'application/json' } }) },
    { captions: () => jsonResponse({ wrong: [] }) },
    { captions: () => jsonResponse({ events: [{ tStartMs: -10, dDurationMs: 100, segs: [{ utf8: 'bad time' }] }] }) },
    { captions: () => jsonResponse({ events: [{ tStartMs: 0, dDurationMs: -10, segs: [{ utf8: 'bad duration' }] }] }) },
    { captions: () => jsonResponse({ events: [{ tStartMs: 0, dDurationMs: 10, segs: [{ utf8: {} }] }] }) },
  ]) {
    const f = fixture(overrides);
    await rejectsCode(fetchTranscript(VIDEO, { fetchImpl: f.fetchImpl }), 'invalid_response');
  }
  const f = fixture({ captions: () => jsonResponse({ events: [] }) });
  await rejectsCode(fetchTranscript(VIDEO, { fetchImpl: f.fetchImpl }), 'unavailable');
});

test('enforces the body limit from both Content-Length and streamed bytes', async () => {
  let cancelled = false;
  const oversized = () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)); },
    cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'text/html' } });
  for (const watch of [
    () => new Response(WATCH, { headers: { 'content-type': 'text/html', 'content-length': String(4 * 1024 * 1024 + 1) } }),
    oversized,
  ]) {
    const f = fixture({ watch });
    await rejectsCode(fetchTranscript(VIDEO, { fetchImpl: f.fetchImpl }), 'invalid_response');
    assert.equal(f.calls.length, 1);
  }
  assert.equal(cancelled, true);
});

test('one twelve-second deadline releases a stalled request even if a fetch implementation ignores abort', async t => {
  let expire;
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    if (delay === 12000) expire = callback;
    return 1;
  });
  t.mock.method(globalThis, 'clearTimeout', () => {});
  const f = fixture({ player: () => { queueMicrotask(() => expire()); return new Promise(() => {}); } });
  await rejectsCode(fetchTranscript(VIDEO, { fetchImpl: f.fetchImpl }), 'network');
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].options.signal.aborted, true);
});
