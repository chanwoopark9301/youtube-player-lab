import assert from 'node:assert/strict';
import test from 'node:test';
import { CatalogError, getVideoMetadata, searchVideos } from '../lib/youtube-search.js';

const item = (videoId, title, channel) => ({ videoRenderer: { videoId, title: { runs: [{ text: title }] }, ownerText: { runs: [{ text: channel }] } } });
const initialData = items => ({ contents: { twoColumnSearchResultsRenderer: { primaryContents: { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: items } }] } } } } });
const page = (items, prefix = 'var ytInitialData =') => '<!doctype html><html><script>' + prefix + JSON.stringify(initialData(items)) + ';</script></html>';
const htmlResponse = html => new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
const jsonResponse = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const typed = code => error => error instanceof CatalogError && error.code === code;

test('public search returns real renderer fields, trims query, and uses only a fixed YouTube URL', async () => {
  const requests = [];
  const result = await searchVideos('  기타 강의  ', { fetchImpl: async (url, options) => {
    requests.push({ url: new URL(url), options });
    return htmlResponse(page([item('MdJG6pwYQqk', 'IFrame tutorial', 'Pixel Grid UI'), item('M7lc1UVf-VE', 'Developers Live', 'Google for Developers')]));
  } });
  assert.equal(result.query, '기타 강의');
  assert.equal(result.source, 'youtube-public-search');
  assert.equal(requests[0].url.origin, 'https://www.youtube.com');
  assert.equal(requests[0].url.pathname, '/results');
  assert.equal(requests[0].url.searchParams.get('search_query'), '기타 강의');
  assert.equal(result.sourceUrl, requests[0].url.href);
  assert.ok(requests[0].options.signal instanceof AbortSignal);
  const headers = new Headers(requests[0].options.headers);
  assert.equal(headers.has('cookie'), false);
  assert.equal(headers.has('authorization'), false);
  assert.deepEqual(result.videos, [
    { videoId: 'MdJG6pwYQqk', title: 'IFrame tutorial', channel: 'Pixel Grid UI', watchUrl: 'https://www.youtube.com/watch?v=MdJG6pwYQqk' },
    { videoId: 'M7lc1UVf-VE', title: 'Developers Live', channel: 'Google for Developers', watchUrl: 'https://www.youtube.com/watch?v=M7lc1UVf-VE' },
  ]);
});

test('search drops malformed IDs and duplicates and applies the requested candidate limit', async () => {
  const html = page([item('short', 'bad', 'bad'), item('M7lc1UVf-VE', 'first', 'one'), item('M7lc1UVf-VE', 'duplicate', 'two'), item(12345678901, 'numeric', 'bad'), item('dQw4w9WgXcQ', 'second', 'two'), item('aqz-KE-bpKQ', 'third', 'three')]);
  const result = await searchVideos('tutorial', { limit: 2, fetchImpl: async () => htmlResponse(html) });
  assert.deepEqual(result.videos.map(video => [video.videoId, video.title]), [['M7lc1UVf-VE', 'first'], ['dQw4w9WgXcQ', 'second']]);
});

test('balanced JSON extraction preserves brace, quote, slash, and HTML-like title text without running scripts', async () => {
  const title = 'Title } { " quote \\ slash </script><script>globalThis.searchProbeExecuted=true</script>';
  globalThis.searchProbeExecuted = false;
  const html = page([item('M7lc1UVf-VE', title, '<b>channel</b>')], 'window["ytInitialData"] = ');
  const result = await searchVideos('literal text', { fetchImpl: async () => htmlResponse(html) });
  assert.equal(result.videos[0].title, title);
  assert.equal(result.videos[0].channel, '<b>channel</b>');
  assert.equal(globalThis.searchProbeExecuted, false);
  delete globalThis.searchProbeExecuted;
});

test('valid empty results remain empty instead of inventing fallback candidates', async () => {
  const result = await searchVideos('unlikely query', { fetchImpl: async () => htmlResponse(page([])) });
  assert.deepEqual(result.videos, []);
});

test('invalid query and limit fail before making any external request', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('must not fetch'); };
  for (const query of ['', '   ', null, undefined, 42, 'a'.repeat(161)]) await assert.rejects(searchVideos(query, { fetchImpl }), typed('invalid_query'));
  for (const limit of [0, 9, 1.5, '5', null, NaN]) await assert.rejects(searchVideos('valid', { limit, fetchImpl }), typed('invalid_limit'));
  assert.equal(calls, 0);
});

test('block and rate limit responses are typed and never retried with another route', async () => {
  for (const status of [403, 429]) {
    let calls = 0;
    await assert.rejects(searchVideos('valid', { fetchImpl: async () => { calls++; return new Response('blocked', { status }); } }), typed('blocked'));
    assert.equal(calls, 1);
  }
});

test('a challenge page is a blocked response even when the HTTP status is successful', async () => {
  await assert.rejects(searchVideos('valid', { fetchImpl: async () => htmlResponse('<html>Our systems have detected unusual traffic from your computer network. https://www.google.com/sorry/index</html>') }), typed('blocked'));
});

test('malformed or missing initial JSON is an invalid response rather than empty search', async () => {
  for (const html of ['<html>not search data</html>', '<script>var ytInitialData = {"contents":</script>', '<script>var ytInitialData = [];</script>']) {
    await assert.rejects(searchVideos('valid', { fetchImpl: async () => htmlResponse(html) }), typed('invalid_response'));
  }
});

test('network and timeout failures become typed errors and do not leak raw error details', async () => {
  for (const cause of [new TypeError('secret connection details'), new DOMException('The operation timed out', 'TimeoutError'), new DOMException('The operation was aborted', 'AbortError')]) {
    await assert.rejects(searchVideos('valid', { fetchImpl: async () => { throw cause; } }), error => typed('network')(error) && !error.message.includes('secret connection details'));
  }
});

test('a response larger than four MiB is rejected before parsing', async () => {
  const oversized = 'x'.repeat(4 * 1024 * 1024 + 1);
  await assert.rejects(searchVideos('valid', { fetchImpl: async () => htmlResponse(oversized) }), typed('invalid_response'));
});

test('oEmbed resolves a known ID to title and author with no API key', async () => {
  const requests = [];
  const result = await getVideoMetadata('M7lc1UVf-VE', { fetchImpl: async (url, options) => {
    requests.push({ url: new URL(url), options });
    return jsonResponse({ title: 'YouTube Developers Live', author_name: 'Google for Developers', html: '<iframe>ignored</iframe>' });
  } });
  assert.equal(requests[0].url.origin, 'https://www.youtube.com');
  assert.equal(requests[0].url.pathname, '/oembed');
  assert.equal(requests[0].url.searchParams.get('url'), 'https://www.youtube.com/watch?v=M7lc1UVf-VE');
  assert.equal(requests[0].url.searchParams.get('format'), 'json');
  assert.equal(requests[0].url.searchParams.has('key'), false);
  assert.ok(requests[0].options.signal instanceof AbortSignal);
  assert.deepEqual(result, { videoId: 'M7lc1UVf-VE', title: 'YouTube Developers Live', channel: 'Google for Developers', watchUrl: 'https://www.youtube.com/watch?v=M7lc1UVf-VE' });
});

test('oEmbed rejects malformed IDs without fetching and rejects invalid metadata', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return jsonResponse({ title: 'title', author_name: 'channel' }); };
  for (const videoId of ['short', 'M7lc1UVf-VE!', 12345678901, null, ['M7lc1UVf-VE']]) await assert.rejects(getVideoMetadata(videoId, { fetchImpl }), typed('invalid_video_id'));
  assert.equal(calls, 0);
  for (const body of [{}, { title: {}, author_name: 'channel' }, { title: 'title', author_name: [] }]) {
    await assert.rejects(getVideoMetadata('M7lc1UVf-VE', { fetchImpl: async () => jsonResponse(body) }), typed('invalid_response'));
  }
});
