import assert from 'node:assert/strict';
import test from 'node:test';
import { openWrapper, playerOrigin, tick, videoMessage } from './support/hosted-player-harness.mjs';

const openRequests = app => app.outgoing.filter(item => item.method === 'ui/open-link');
const expectedURL = (videoId = 'M7lc1UVf-VE', fullscreen = false) => playerOrigin + '/popout?videoId=' + videoId + (fullscreen ? '&fullscreen=1' : '');
const buttons = ['popup-button', 'expand-button'];

async function initialize(app, hostCapabilities = { openLinks: {} }) {
  const request = app.outgoing.find(item => item.method === 'ui/initialize');
  assert.ok(request, 'the component must initialize the standard MCP Apps bridge');
  assert.deepEqual(request.params.appCapabilities.availableDisplayModes, ['inline', 'fullscreen']);
  app.respond(request, { protocolVersion: '2026-01-26', hostInfo: { name: 'test-host', version: '1' }, hostCapabilities, hostContext: { displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'] } });
  await tick();
  assert.ok(app.outgoing.some(item => item.method === 'ui/notifications/initialized'));
}
function assertManualLink(app, url) {
  const link = app.element('external-link');
  assert.ok(link, 'an explicit manual navigation fallback must exist');
  assert.equal(link.hidden, false);
  assert.equal(link.href, url);
  assert.equal(link.target, '_blank');
  assert.ok(link.rel.split(/\s+/).includes('noopener'));
  assert.equal(app.element('display-status').hidden, false);
  assert.ok(app.element('display-status').textContent.trim());
}
function assertNoVerifiedWindowClaim(app) {
  assert.doesNotMatch(app.element('display-status').textContent, /창(?:이|을)?\s*열(?:렸|었)|전체화면(?:으로)?\s*(?:전환)?\s*(?:완료|성공|됐|되었)/, 'navigation acknowledgment is not proof of a window or fullscreen');
}

test('popup opens the independent own-origin page through the standard host navigation API', async () => {
  const compatibilityCalls = [];
  const app = openWrapper({ openai: { openExternal: args => compatibilityCalls.push(args), requestDisplayMode() { throw new Error('display modes are not external navigation'); } } });
  await initialize(app);
  const action = app.click('popup-button');
  const request = openRequests(app)[0];
  assert.deepEqual(request.params, { url: expectedURL() });
  app.respond(request, {});
  await action;
  assert.deepEqual(compatibilityCalls, [], 'the standard bridge takes priority when openLinks is advertised');
  assert.deepEqual(app.opened, []);
  assert.equal(app.outgoing.some(item => item.method === 'ui/request-display-mode'), false);
  for (const id of buttons) assert.equal(app.element(id).disabled, false);
  assert.equal(app.element('inline-button'), null, 'an external window does not need a host inline-mode control');
  assertManualLink(app, expectedURL());
  assertNoVerifiedWindowClaim(app);
});

test('expand requests fullscreen on the new page and retains the latest video after relay consumption', async () => {
  const app = openWrapper();
  await initialize(app);
  app.receive(videoMessage('dQw4w9WgXcQ'));
  app.load();
  app.receive(videoMessage('aqz-KE-bpKQ'));
  const action = app.click('expand-button');
  const request = openRequests(app)[0];
  assert.deepEqual(request.params, { url: expectedURL('aqz-KE-bpKQ', true) });
  app.respond(request, {});
  await action;
  assert.equal(openRequests(app).length, 1, 'one user click issues one navigation request');
  assertNoVerifiedWindowClaim(app);
});

test('compatibility navigation opens externally when the host does not advertise openLinks', async () => {
  const calls = [];
  const app = openWrapper({ openai: { openExternal: args => calls.push(JSON.parse(JSON.stringify(args))) } });
  await initialize(app, {});
  await app.click('expand-button');
  assert.deepEqual(calls, [{ href: expectedURL('M7lc1UVf-VE', true), redirectUrl: false }]);
  assert.deepEqual(openRequests(app), []);
  assert.deepEqual(app.opened, []);
  assertNoVerifiedWindowClaim(app);
});

test('a top-level browser opens a real separate popup with noopener', async () => {
  const app = openWrapper({ topLevel: true, openFunction: () => ({}) });
  await app.click('popup-button');
  assert.equal(app.opened.length, 1);
  assert.deepEqual(app.opened[0], [expectedURL(), '_blank', 'popup=yes,width=960,height=600,noopener']);
  assert.deepEqual(app.outgoing, []);
  assertNoVerifiedWindowClaim(app);
});

test('a null popup handle never causes an automatic second navigation', async () => {
  const app = openWrapper({ topLevel: true, openFunction: () => null });
  await app.click('expand-button');
  app.flushTimers();
  await tick();
  assert.equal(app.opened.length, 1, 'noopener can return null for a successful open, so a fallback must remain manual');
  assertManualLink(app, expectedURL('M7lc1UVf-VE', true));
  assertNoVerifiedWindowClaim(app);
});

test('navigation rejects video IDs from other sources and malformed or unrelated messages', async () => {
  const app = openWrapper();
  await initialize(app);
  app.receive(videoMessage('dQw4w9WgXcQ'));
  app.receive(videoMessage('aqz-KE-bpKQ'), {});
  for (const videoId of ['https://evil.test/x', '../player', 'M7lc1UVf-VE&url=evil', null, 12345678901, ['aqz-KE-bpKQ']]) app.receive(videoMessage(videoId));
  app.receive({ method: 'other', params: { structuredContent: { videoId: 'aqz-KE-bpKQ' } } });
  const action = app.click('popup-button');
  const request = openRequests(app)[0];
  assert.equal(request.params.url, expectedURL('dQw4w9WgXcQ'));
  app.respond(request, {});
  await action;
});

test('compatibility navigation works without the standard postMessage bridge', async () => {
  const calls = [];
  const app = openWrapper({ parentPostMessage: false, openai: { openExternal: args => calls.push(JSON.parse(JSON.stringify(args))) } });
  await app.click('popup-button');
  assert.deepEqual(calls, [{ href: expectedURL(), redirectUrl: false }]);
  assertNoVerifiedWindowClaim(app);
});

test('an embedded host without external navigation provides a manual secure link', async () => {
  const app = openWrapper();
  await initialize(app, {});
  for (const id of buttons) assert.equal(app.element(id).disabled, false, 'lack of PiP support must not disable external navigation');
  await app.click('popup-button');
  assert.deepEqual(openRequests(app), [], 'ui/open-link must only be sent for a declared host capability');
  assert.deepEqual(app.opened, [], 'embedded frames must not silently substitute window.open');
  assertManualLink(app, expectedURL());
});

test('an embedded page with no bridge provides a manual link instead of claiming success', async () => {
  const app = openWrapper({ parentPostMessage: false });
  await app.click('expand-button');
  assert.deepEqual(app.outgoing, []);
  assert.deepEqual(app.opened, []);
  assertManualLink(app, expectedURL('M7lc1UVf-VE', true));
  assertNoVerifiedWindowClaim(app);
});

test('an initialization still in flight does not trigger an embedded browser popup', async () => {
  const app = openWrapper();
  const action = app.click('popup-button');
  await action;
  assert.deepEqual(openRequests(app), []);
  assert.deepEqual(app.opened, []);
  assertManualLink(app, expectedURL());
});

test('pending standard navigation blocks duplicates, then times out to a manual fallback without another automatic open', async () => {
  const compatibilityCalls = [];
  const app = openWrapper({ openai: { openExternal: args => compatibilityCalls.push(args) } });
  await initialize(app);
  const action = app.click('popup-button');
  for (const id of buttons) assert.equal(app.element(id).disabled, true);
  await app.click('popup-button');
  await app.click('expand-button');
  assert.equal(openRequests(app).length, 1);
  app.flushTimers();
  await action;
  await tick();
  for (const id of buttons) assert.equal(app.element(id).disabled, false);
  assert.equal(openRequests(app).length, 1);
  assert.deepEqual(compatibilityCalls, [], 'a timeout may follow a successful host navigation and must not spawn a duplicate');
  assert.deepEqual(app.opened, []);
  assertManualLink(app, expectedURL());
  app.respond(openRequests(app)[0], {});
  await tick();
  assertManualLink(app, expectedURL());
});

test('host rejection recovers controls and allows an explicit user retry', async () => {
  const app = openWrapper();
  await initialize(app);
  const first = app.click('popup-button');
  app.fail(openRequests(app)[0]);
  await first;
  assertManualLink(app, expectedURL());
  for (const id of buttons) assert.equal(app.element(id).disabled, false);
  const retry = app.click('popup-button');
  assert.equal(openRequests(app).length, 2);
  app.respond(openRequests(app)[1], {});
  await retry;
  assertNoVerifiedWindowClaim(app);
});

test('spoofed responses cannot complete navigation and only the real parent can ping', async () => {
  const app = openWrapper();
  await initialize(app);
  const action = app.click('popup-button');
  const request = openRequests(app)[0];
  app.receive({ jsonrpc: '2.0', id: request.id, result: {} }, {});
  app.receive({ jsonrpc: '2.0', id: 'ping-foreign', method: 'ping' }, {});
  await tick();
  assert.equal(app.element('popup-button').disabled, true);
  assert.equal(app.outgoing.some(item => item.id === 'ping-foreign'), false);
  app.receive({ jsonrpc: '2.0', id: 'ping-host', method: 'ping' });
  assert.deepEqual(app.outgoing.find(item => item.id === 'ping-host'), { jsonrpc: '2.0', id: 'ping-host', result: {} });
  app.respond(request, {});
  await action;
  assert.equal(app.element('popup-button').disabled, false);
});

test('a stalled compatibility navigation releases controls and leaves a manual fallback', async () => {
  const calls = [];
  const app = openWrapper({ parentPostMessage: false, openai: { openExternal(args) { calls.push(args); return new Promise(() => {}); } } });
  const action = app.click('expand-button');
  for (const id of buttons) assert.equal(app.element(id).disabled, true);
  await app.click('popup-button');
  assert.equal(calls.length, 1);
  app.flushTimers();
  await action;
  for (const id of buttons) assert.equal(app.element(id).disabled, false);
  assert.equal(calls.length, 1);
  assert.deepEqual(app.opened, []);
  assertManualLink(app, expectedURL('M7lc1UVf-VE', true));
});
