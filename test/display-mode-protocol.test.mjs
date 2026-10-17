import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function openApp({ openai } = {}) {
  const elements = new Map();
  const listeners = new Map();
  const outgoing = [];
  const timers = new Map();
  let nextTimer = 0;
  const parent = { postMessage: message => outgoing.push(JSON.parse(JSON.stringify(message))) };
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      id, hidden: false, disabled: false, textContent: '', dataset: {}, style: {},
      contentWindow: { postMessage() {} },
      addEventListener(name, listener) { this[name] = listener; },
      setAttribute(name, value) { this[name] = value; },
    });
    return elements.get(id);
  }
  const document = { documentElement: { dataset: {} }, getElementById: element };
  const window = { parent, openai, addEventListener: (name, listener) => listeners.set(name, listener) };
  const context = vm.createContext({ window, document, URL,
    setTimeout: callback => { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id),
  });
  const html = readFileSync(new URL('../public/hosted-player.html', import.meta.url), 'utf8').replaceAll('__PLAYER_ORIGIN__', 'https://player.example.test');
  for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) vm.runInContext(script[1], context);
  return {
    outgoing, document, parent, timers, element,
    receive(data, source = parent) { listeners.get('message')?.({ data, source }); },
    respond(request, result) { this.receive({ jsonrpc: '2.0', id: request.id, result }); },
    click(id) { return element(id).click?.(); },
    setGlobals(globals) { listeners.get('openai:set_globals')?.({ detail: { globals } }); },
  };
}

const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
async function initialize(app, modes = ['inline', 'pip', 'fullscreen']) {
  const request = app.outgoing.find(item => item.method === 'ui/initialize');
  assert.ok(request, 'the component must initialize the standard MCP Apps bridge');
  assert.deepEqual(request.params.appCapabilities.availableDisplayModes, ['inline', 'pip', 'fullscreen']);
  app.respond(request, { protocolVersion: '2026-01-26', hostInfo: { name: 'test-host', version: '1' }, hostCapabilities: {}, hostContext: { displayMode: 'inline', availableDisplayModes: modes } });
  await tick();
  assert.ok(app.outgoing.some(item => item.method === 'ui/notifications/initialized'));
}
const requests = app => app.outgoing.filter(item => item.method === 'ui/request-display-mode');

test('standard bridge requests pip then fullscreen only after a pip grant', async () => {
  const app = openApp();
  await initialize(app);
  const action = app.click('expand-button');
  assert.deepEqual(requests(app).map(item => item.params.mode), ['pip']);
  assert.equal(app.element('popup-button').disabled, true);
  app.respond(requests(app)[0], { mode: 'pip' });
  await tick();
  assert.deepEqual(requests(app).map(item => item.params.mode), ['pip', 'fullscreen']);
  app.respond(requests(app)[1], { mode: 'fullscreen' });
  await action;
  assert.equal(app.document.documentElement.dataset.displayMode, 'fullscreen');
  assert.equal(app.element('popup-button').disabled, false);
});

test('a different granted mode stops the two-step sequence', async () => {
  const app = openApp();
  await initialize(app);
  const action = app.click('expand-button');
  app.respond(requests(app)[0], { mode: 'inline' });
  await action;
  assert.equal(requests(app).length, 1);
  assert.equal(app.document.documentElement.dataset.displayMode, 'inline');
  assert.ok(app.element('display-status').textContent);
});

test('spoofed responses and host context changes cannot advance the sequence', async () => {
  const app = openApp();
  await initialize(app);
  const action = app.click('expand-button');
  const request = requests(app)[0];
  app.receive({ jsonrpc: '2.0', id: request.id, result: { mode: 'pip' } }, {});
  app.receive({ method: 'ui/notifications/host-context-changed', params: { displayMode: 'fullscreen' } }, {});
  await tick();
  assert.equal(requests(app).length, 1);
  assert.equal(app.document.documentElement.dataset.displayMode, 'inline');
  app.respond(request, { mode: 'pip' });
  await tick();
  app.respond(requests(app)[1], { mode: 'fullscreen' });
  await action;
});

test('unsupported pip stays disabled and a pending request times out without claiming success', async () => {
  const unsupported = openApp();
  await initialize(unsupported, ['inline', 'fullscreen']);
  assert.equal(unsupported.element('popup-button').disabled, true);
  assert.equal(unsupported.element('expand-button').disabled, true);
  assert.equal(requests(unsupported).length, 0);
  const app = openApp();
  await initialize(app);
  const action = app.click('popup-button');
  for (const callback of [...app.timers.values()]) callback();
  await action;
  assert.equal(app.element('popup-button').disabled, false);
  assert.equal(app.document.documentElement.dataset.displayMode, 'inline');
  assert.ok(app.element('display-status').textContent);
});

test('answers host ping but ignores ping from other frames', async () => {
  const app = openApp();
  await initialize(app);
  app.receive({ jsonrpc: '2.0', id: 'ping-foreign', method: 'ping' }, {});
  assert.equal(app.outgoing.some(item => item.id === 'ping-foreign'), false);
  app.receive({ jsonrpc: '2.0', id: 'ping-host', method: 'ping' });
  assert.deepEqual(app.outgoing.find(item => item.id === 'ping-host'), { jsonrpc: '2.0', id: 'ping-host', result: {} });
});

test('a stalled compatibility API also releases the display controls after timeout', async () => {
  const app = openApp({ openai: { displayMode: 'inline', requestDisplayMode: () => new Promise(() => {}) } });
  app.click('popup-button');
  assert.equal(app.element('popup-button').disabled, true);
  for (const callback of [...app.timers.values()]) callback();
  await tick();
  assert.equal(app.element('popup-button').disabled, false);
  assert.equal(app.document.documentElement.dataset.displayMode, 'inline');
  assert.ok(app.element('display-status').textContent);
});

test('unsupported popup notice survives later host globals and tracks changing host modes', async () => {
  const app = openApp();
  await initialize(app, ['inline', 'fullscreen']);
  app.receive({ method: 'ui/notifications/host-context-changed', params: { displayMode: 'fullscreen' } });
  // The native host sends this separate compatibility notification as well.
  app.setGlobals({ theme: 'light' });
  assert.equal(app.element('display-status').hidden, false);
  assert.ok(app.element('display-status').textContent);
  assert.equal(app.document.documentElement.dataset.availableDisplayModes, 'inline,fullscreen');
  app.receive({ method: 'ui/notifications/host-context-changed', params: { availableDisplayModes: ['inline', 'pip', 'fullscreen'] } });
  assert.equal(app.element('popup-button').disabled, false);
  assert.equal(app.element('display-status').hidden, true);
});

test('a failed inline return is not hidden by the unsupported-popup explanation', async () => {
  const app = openApp();
  await initialize(app, ['inline', 'fullscreen']);
  const capabilityNotice = app.element('display-status').textContent;
  const action = app.click('inline-button');
  const request = requests(app)[0];
  app.receive({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'declined' } });
  await action;
  assert.notEqual(app.element('display-status').textContent, capabilityNotice);
  const failureNotice = app.element('display-status').textContent;
  app.setGlobals({ theme: 'light' });
  assert.equal(app.element('display-status').textContent, failureNotice);
});
