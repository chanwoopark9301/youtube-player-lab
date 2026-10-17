import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const playerOrigin = 'https://player.example.test';

function openWrapper() {
  let html = '';
  try {
    html = readFileSync(new URL('../public/hosted-player.html', import.meta.url), 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  html = html.replaceAll('__PLAYER_ORIGIN__', playerOrigin);
  const frameListeners = new Map();
  const windowListeners = new Map();
  const sent = [];
  const navigations = [];
  const parent = {};
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
    parent,
    addEventListener(name, handler) {
      windowListeners.set(name, handler);
    },
  };
  const document = {
    getElementById(id) {
      assert.equal(id, 'hosted-player');
      return frame;
    },
  };
  const context = vm.createContext({ window, document, URL });
  for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    vm.runInContext(script[1], context);
  }
  return {
    sent,
    navigations,
    parent,
    child: frame.contentWindow,
    load() { frameListeners.get('load')?.(); },
    message(source, data) { windowListeners.get('message')?.({ source, data }); },
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
