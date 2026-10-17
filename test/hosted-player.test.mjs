import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const playerOrigin = 'https://player.example.test';

function openWrapper({ openai } = {}) {
  let html = '';
  try {
    html = readFileSync(new URL('../public/hosted-player.html', import.meta.url), 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  html = html.replaceAll('__PLAYER_ORIGIN__', playerOrigin);
  const frameListeners = new Map();
  const windowListeners = new Map();
  const elements = new Map();
  const sent = [];
  const navigations = [];
  const parent = {};
  function element(id) {
    const listeners = new Map();
    const node = {
      id, disabled: false, hidden: false, textContent: '', dataset: {}, style: {},
      addEventListener(name, handler) {
        if (!listeners.has(name)) listeners.set(name, []);
        listeners.get(name).push(handler);
      },
      setAttribute(name, value) { node[name] = value; },
      removeAttribute(name) { delete node[name]; },
      click() {
        if (node.disabled) return Promise.resolve();
        const event = { target: node, preventDefault() {} };
        const handlers = [...(listeners.get('click') || [])];
        if (typeof node.onclick === 'function') handlers.push(node.onclick);
        return Promise.all(handlers.map(handler => handler(event)));
      },
    };
    elements.set(id, node);
    return node;
  }
  const frame = {
    referrerPolicy: '',
    allow: '',
    contentWindow: {
      postMessage(message, targetOrigin) {
        sent.push({ message: JSON.parse(JSON.stringify(message)), targetOrigin });
      },
    },
    addEventListener(name, handler) {
      frameListeners.set(name, handler);
    },
    set src(value) {
      navigations.push({
        src: value,
        referrerPolicy: this.referrerPolicy,
        hasLoadListener: frameListeners.has('load'),
      });
    },
  };
  const window = {
    parent, openai,
    addEventListener(name, handler) {
      if (!windowListeners.has(name)) windowListeners.set(name, []);
      windowListeners.get(name).push(handler);
    },
  };
  function dispatch(name, event) {
    for (const handler of windowListeners.get(name) || []) handler(event);
  }
  const document = {
    documentElement: { dataset: {} },
    getElementById(id) {
      if (id === 'hosted-player') return frame;
      return elements.get(id) || element(id);
    },
    querySelectorAll(selector) {
      return selector === 'button' ? ['popup-button', 'expand-button', 'inline-button'].map(id => document.getElementById(id)) : [];
    },
  };
  const context = vm.createContext({ window, document, URL, setTimeout, clearTimeout, console });
  for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    vm.runInContext(script[1], context);
  }
  return {
    sent,
    navigations,
    parent,
    child: frame.contentWindow,
    element: id => document.getElementById(id),
    dataset: document.documentElement.dataset,
    click: id => document.getElementById(id).click(),
    load() { frameListeners.get('load')?.(); },
    message(source, data) { dispatch('message', { source, data }); },
    setGlobals(globals) {
      if (window.openai) Object.assign(window.openai, globals);
      dispatch('openai:set_globals', { detail: { globals } });
    },
  };
}

function videoMessage(videoId) {
  return { method: 'ui/notifications/tool-result', params: { structuredContent: { videoId } } };
}

test('sets the referrer policy and load listener before navigating to the HTTPS player', () => {
  const wrapper = openWrapper();
  assert.deepEqual(wrapper.navigations, [{
    src: 'https://player.example.test/player',
    referrerPolicy: 'strict-origin-when-cross-origin',
    hasLoadListener: true,
  }]);
});

test('queues only the latest valid parent video until the child loads', () => {
  const wrapper = openWrapper();
  wrapper.message(wrapper.parent, videoMessage('M7lc1UVf-VE'));
  wrapper.message(wrapper.parent, videoMessage('dQw4w9WgXcQ'));
  assert.deepEqual(wrapper.sent, []);
  wrapper.load();
  assert.deepEqual(wrapper.sent, [{
    message: videoMessage('dQw4w9WgXcQ'),
    targetOrigin: 'https://player.example.test',
  }]);
  wrapper.load();
  assert.equal(wrapper.sent.length, 1, 'a consumed queued video must not be resent');
});

test('rejects unrelated sources, unrelated methods, and malformed video IDs', () => {
  const wrapper = openWrapper();
  wrapper.message({}, videoMessage('M7lc1UVf-VE'));
  wrapper.message(wrapper.child, videoMessage('M7lc1UVf-VE'));
  for (const videoId of ['', 'short', 'M7lc1UVf-VE!', 'M7lc1UVf V', null, undefined, 12345678901, ['M7lc1UVf-VE']]) {
    wrapper.message(wrapper.parent, videoMessage(videoId));
  }
  wrapper.message(wrapper.parent, { method: 'other', params: { structuredContent: { videoId: 'M7lc1UVf-VE' } } });
  wrapper.message(wrapper.parent, null);
  wrapper.message(wrapper.parent, {});
  wrapper.load();
  assert.deepEqual(wrapper.sent, []);
  wrapper.message(wrapper.parent, videoMessage('M7lc1UVf-VE'));
  assert.deepEqual(wrapper.sent, [{
    message: videoMessage('M7lc1UVf-VE'),
    targetOrigin: 'https://player.example.test',
  }], 'a valid parent message still forwards after rejected messages');
});

test('forwards subsequent parent videos to the exact player origin with only the video ID', () => {
  const wrapper = openWrapper();
  wrapper.load();
  wrapper.message(wrapper.parent, {
    jsonrpc: '2.0',
    id: 7,
    method: 'ui/notifications/tool-result',
    params: {
      content: [{ type: 'text', text: 'private host content' }],
      structuredContent: { videoId: 'aqz-KE-bpKQ', secret: 'private host field' },
      _meta: { token: 'private host metadata' },
    },
  });
  assert.deepEqual(wrapper.sent, [{
    message: videoMessage('aqz-KE-bpKQ'),
    targetOrigin: 'https://player.example.test',
  }]);
});

const buttons = ['popup-button', 'expand-button', 'inline-button'];
const settle = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function requestedMode(request) {
  return JSON.parse(JSON.stringify(request));
}

test('popup requests PiP once and records the actual returned mode', async () => {
  const requests = [];
  const wrapper = openWrapper({ openai: {
    displayMode: 'inline',
    async requestDisplayMode(request) {
      requests.push(requestedMode(request));
      return { mode: 'pip' };
    },
  } });
  await wrapper.click('popup-button');
  await settle();
  assert.deepEqual(requests, [{ mode: 'pip' }]);
  assert.equal(wrapper.dataset.displayMode, 'pip');
});

test('expand waits for confirmed PiP before requesting fullscreen and blocks duplicate clicks in flight', async () => {
  const requests = [];
  const pip = deferred();
  const fullscreen = deferred();
  const wrapper = openWrapper({ openai: {
    displayMode: 'inline',
    requestDisplayMode(request) {
      requests.push(requestedMode(request));
      return request.mode === 'pip' ? pip.promise : fullscreen.promise;
    },
  } });
  const operation = wrapper.click('expand-button');
  assert.deepEqual(requests, [{ mode: 'pip' }]);
  for (const id of buttons) assert.equal(wrapper.element(id).disabled, true, `${id} must be disabled during the request`);
  await wrapper.click('popup-button');
  await wrapper.click('expand-button');
  await wrapper.click('inline-button');
  assert.deepEqual(requests, [{ mode: 'pip' }], 'disabled buttons must not issue competing requests');
  pip.resolve({ mode: 'pip' });
  await settle();
  assert.deepEqual(requests, [{ mode: 'pip' }, { mode: 'fullscreen' }]);
  for (const id of buttons) assert.equal(wrapper.element(id).disabled, true, `${id} must stay disabled through fullscreen`);
  fullscreen.resolve({ mode: 'fullscreen' });
  await operation;
  await settle();
  assert.equal(wrapper.dataset.displayMode, 'fullscreen');
  assert.equal(wrapper.element('popup-button').disabled, false);
});

test('expand stops after PiP rejection and permits a later retry', async () => {
  const requests = [];
  const wrapper = openWrapper({ openai: {
    displayMode: 'inline',
    async requestDisplayMode(request) {
      requests.push(requestedMode(request));
      throw new Error('PiP denied by host');
    },
  } });
  await wrapper.click('expand-button');
  await settle();
  assert.deepEqual(requests, [{ mode: 'pip' }]);
  assert.equal(wrapper.dataset.displayMode, 'inline');
  assert.equal(wrapper.element('expand-button').disabled, false);
  assert.ok(wrapper.element('display-status').textContent.trim(), 'the host rejection must be visible');
  await wrapper.click('expand-button');
  await settle();
  assert.deepEqual(requests, [{ mode: 'pip' }, { mode: 'pip' }]);
});

test('expand does not request fullscreen when the host returns a different actual mode', async () => {
  const requests = [];
  const openai = {
    displayMode: 'inline',
    async requestDisplayMode(request) {
      requests.push(requestedMode(request));
      openai.displayMode = 'pip';
      return { mode: 'inline' };
    },
  };
  const wrapper = openWrapper({ openai });
  await wrapper.click('expand-button');
  await settle();
  assert.deepEqual(requests, [{ mode: 'pip' }]);
  assert.equal(wrapper.dataset.displayMode, 'inline', 'an explicit actual result must take precedence over a stale global mode');
  assert.equal(wrapper.element('expand-button').disabled, false);
});

test('verifies undefined request results against synchronous host globals before expanding', async () => {
  const requests = [];
  const openai = {
    displayMode: 'inline',
    async requestDisplayMode(request) {
      requests.push(requestedMode(request));
      openai.displayMode = request.mode;
    },
  };
  const wrapper = openWrapper({ openai });
  await wrapper.click('expand-button');
  await settle();
  assert.deepEqual(requests, [{ mode: 'pip' }, { mode: 'fullscreen' }]);
  assert.equal(wrapper.dataset.displayMode, 'fullscreen');
});

test('does not claim PiP success or request fullscreen when neither result nor globals confirm a mode', async () => {
  const requests = [];
  const wrapper = openWrapper({ openai: {
    async requestDisplayMode(request) {
      requests.push(requestedMode(request));
    },
  } });
  await wrapper.click('expand-button');
  await settle();
  assert.deepEqual(requests, [{ mode: 'pip' }]);
  assert.notEqual(wrapper.dataset.displayMode, 'pip');
  assert.notEqual(wrapper.dataset.displayMode, 'fullscreen');
  assert.ok(wrapper.element('display-status').textContent.trim(), 'an unconfirmed result must remain visible');
  assert.equal(wrapper.element('expand-button').disabled, false);
});

test('keeps confirmed PiP state and recovers controls after fullscreen rejection', async () => {
  const requests = [];
  const wrapper = openWrapper({ openai: {
    displayMode: 'inline',
    async requestDisplayMode(request) {
      requests.push(requestedMode(request));
      if (request.mode === 'pip') return { mode: 'pip' };
      throw new Error('Fullscreen denied by host');
    },
  } });
  await wrapper.click('expand-button');
  await settle();
  assert.deepEqual(requests, [{ mode: 'pip' }, { mode: 'fullscreen' }]);
  assert.equal(wrapper.dataset.displayMode, 'pip');
  assert.equal(wrapper.element('inline-button').disabled, false);
  assert.ok(wrapper.element('display-status').textContent.trim());
});

test('inline requests the inline mode and records the actual result', async () => {
  const requests = [];
  const wrapper = openWrapper({ openai: {
    displayMode: 'pip',
    async requestDisplayMode(request) {
      requests.push(requestedMode(request));
      return { mode: 'inline' };
    },
  } });
  await wrapper.click('inline-button');
  await settle();
  assert.deepEqual(requests, [{ mode: 'inline' }]);
  assert.equal(wrapper.dataset.displayMode, 'inline');
});

test('disables display controls and gives a status when no host display API is available', async () => {
  const wrapper = openWrapper();
  for (const id of buttons) {
    assert.equal(wrapper.element(id).disabled, true, `${id} must be disabled without the host API`);
    await wrapper.click(id);
  }
  assert.ok(wrapper.element('display-status').textContent.trim(), 'unsupported display controls need a short status');
});

test('synchronizes actual host display mode from openai:set_globals without issuing requests', () => {
  const requests = [];
  const wrapper = openWrapper({ openai: {
    displayMode: 'inline',
    async requestDisplayMode(request) { requests.push(requestedMode(request)); },
  } });
  for (const displayMode of ['pip', 'fullscreen', 'inline']) {
    wrapper.setGlobals({ displayMode });
    assert.equal(wrapper.dataset.displayMode, displayMode);
  }
  assert.deepEqual(requests, []);
});
