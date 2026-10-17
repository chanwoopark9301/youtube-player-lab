import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchTranscript, TranscriptError } from '../lib/youtube-transcript.js';

const VIDEO = 'M7lc1UVf-VE';
// Public /sw.js_data JSPB reduced from the successful 2026-10-17 probe.
const BOOTSTRAP = ")]}'\n" + JSON.stringify([['yt.sw.adr', null, [[['en', 'US']], 'public-fixture-config']]]);
// Reduced to the fields consumed from the successful 2026-10-17 public response.
const manual = { languageCode: 'en', baseUrl: 'https://www.youtube.com/api/timedtext?v=M7lc1UVf-VE&lang=en&signature=private-signed-value&fmt=srv3' };
const generated = { ...manual, kind: 'asr' };
const payload = {
  events: [{ tStartMs: 10349, dDurationMs: 1000, segs: [{ utf8: 'JEFF POSNICK: Hey, everybody.' }] }],
};
const jsonResponse = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const bootstrapResponse = () => new Response(BOOTSTRAP, { headers: { 'content-type': 'application/json' } });
const playerResponse = (tracks = [manual, generated]) => jsonResponse({
  playabilityStatus: { status: 'OK' },
  captions: { playerCaptionsTracklistRenderer: { captionTracks: tracks } },
});

function fixture({ bootstrap = bootstrapResponse, player = () => playerResponse(), captions = () => jsonResponse(payload) } = {}) {
  const calls = [];
  const responses = [bootstrap, player, captions];
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
  assert.equal(f.calls[0].url.href, 'https://www.youtube.com/sw.js_data');
  assert.equal(f.calls.some(call => call.url.pathname === '/watch'), false, 'caption retrieval must not request a watch page');
  assert.equal(f.calls[1].url.pathname, '/youtubei/v1/player');
  assert.equal(f.calls[1].options.method, 'POST');
  assert.equal(f.calls[1].url.searchParams.get('key'), 'public-fixture-config');
  assert.deepEqual(JSON.parse(f.calls[1].options.body), {
    context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38' } }, videoId: VIDEO,
  });
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
    { bootstrap: () => new Response('rate limited', { status: 429 }), count: 1 },
    { bootstrap: () => new Response('forbidden', { status: 403 }), count: 1 },
    { bootstrap: () => new Response('<div class="g-recaptcha"></div>', { headers: { 'content-type': 'text/html' } }), count: 1 },
    { bootstrap: () => new Response('', { status: 302, headers: { location: 'https://consent.youtube.com/m' } }), count: 1 },
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

test('annotates failures with the exact bootstrap, player or captions stage without exposing request URLs', async () => {
  for (const stage of ['bootstrap', 'player', 'captions']) {
    const f = fixture({ [stage]: () => { throw new Error('request failed: ' + manual.baseUrl); } });
    await assert.rejects(fetchTranscript(VIDEO, { fetchImpl: f.fetchImpl }), error => {
      assert.equal(error.code, 'network');
      assert.equal(error.stage, stage);
      assert.doesNotMatch(JSON.stringify(error), /signature|private-signed-value|https:/);
      return true;
    });
  }
});

test('retains a blocked stage and performs no later request after a block at any step', async () => {
  for (const [index, stage] of ['bootstrap', 'player', 'captions'].entries()) {
    const f = fixture({ [stage]: () => new Response('blocked', { status: 403 }) });
    await assert.rejects(fetchTranscript(VIDEO, { fetchImpl: f.fetchImpl }), error => {
      assert.equal(error.code, 'blocked');
      assert.equal(error.stage, stage);
      return true;
    });
    assert.equal(f.calls.length, index + 1);
  }
});

test('rejects malformed player or caption data rather than returning an empty success', async () => {
  for (const overrides of [
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

test('rejects malformed, missing or misplaced bootstrap keys without falling back to a watch page', async () => {
  for (const text of [
    JSON.stringify([['yt.sw.adr', null, [[], 'public-fixture-config']]]),
    ")]}'\n{broken",
    ")]}'\n[]",
    ")]}'\n" + JSON.stringify([['yt.sw.adr', null, []]]),
    ")]}'\n" + JSON.stringify([['yt.sw.adr', null, [[], null]]]),
    ")]}'\n" + JSON.stringify([['yt.sw.adr', null, [[], 'short']]]),
    ")]}'\n" + JSON.stringify([['yt.sw.adr', null, [[], 'x'.repeat(101)]]]),
    ")]}'\n" + JSON.stringify([['yt.sw.adr', null, [[], 'public key?with=parameters']]]),
    ")]}'\n" + JSON.stringify([['yt.sw.adr', null, [[], null, 'public-fixture-config']]]),
  ]) {
    const f = fixture({ bootstrap: () => new Response(text, { headers: { 'content-type': 'application/json' } }) });
    await assert.rejects(fetchTranscript(VIDEO, { fetchImpl: f.fetchImpl }), error => {
      assert.equal(error.code, 'invalid_response');
      assert.equal(error.stage, 'bootstrap');
      assert.doesNotMatch(JSON.stringify(error), /public-fixture-config|public key/);
      return true;
    });
    assert.equal(f.calls.length, 1);
  }
});

test('enforces the body limit from both Content-Length and streamed bytes', async () => {
  let cancelled = false;
  const oversized = () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)); },
    cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'application/json' } });
  for (const bootstrap of [
    () => new Response(BOOTSTRAP, { headers: { 'content-type': 'application/json', 'content-length': String(4 * 1024 * 1024 + 1) } }),
    oversized,
  ]) {
    const f = fixture({ bootstrap });
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
