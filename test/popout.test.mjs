import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function openPopout({ search = '', requestFullscreen, webkitRequestFullscreen, exitFullscreen, webkitExitFullscreen } = {}) {
  let html = '';
  try {
    html = readFileSync(new URL('../public/popout.html', import.meta.url), 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const documentListeners = new Map();
  const windowListeners = new Map();
  const elements = new Map();
  const navigations = [];
  const requestTargets = [];
  const exits = [];
  const location = new URL('https://player.example.test/popout' + search);
  function addListener(collection, name, handler) {
    if (!collection.has(name)) collection.set(name, []);
    collection.get(name).push(handler);
  }
  function element(id) {
    const attributes = new Map();
    const listeners = new Map();
    const node = {
      id, dataset: {}, style: {}, disabled: false, hidden: false, textContent: '',
      allow: '', allowFullscreen: false, referrerPolicy: '', title: '',
      setAttribute(name, value) { attributes.set(name, String(value)); },
      getAttribute(name) { return attributes.get(name) ?? null; },
      addEventListener(name, handler) { addListener(listeners, name, handler); },
      click() {
        if (node.disabled) return Promise.resolve();
        const event = { target: node, preventDefault() {} };
        const handlers = [...(listeners.get('click') || [])];
        if (typeof node.onclick === 'function') handlers.push(node.onclick);
        return Promise.all(handlers.map(handler => handler(event)));
      },
      set src(value) {
        navigations.push({ src: String(value), allow: node.allow, allowFullscreen: node.allowFullscreen, referrerPolicy: node.referrerPolicy, title: node.title });
      },
    };
    elements.set(id, node);
    return node;
  }
  const document = {
    readyState: 'loading', fullscreenElement: null, webkitFullscreenElement: null,
    documentElement: element('html'),
    getElementById(id) { return elements.get(id) || element(id); },
    addEventListener(name, handler) { addListener(documentListeners, name, handler); },
  };
  const window = {
    location,
    addEventListener(name, handler) { addListener(windowListeners, name, handler); },
  };
  function dispatch(collection, name) {
    return Promise.all((collection.get(name) || []).map(handler => handler({ type: name })));
  }
  const main = document.getElementById('popout');
  const environment = { document, main, change: name => dispatch(documentListeners, name) };
  if (requestFullscreen) main.requestFullscreen = function () { requestTargets.push(this); return requestFullscreen(environment); };
  if (webkitRequestFullscreen) main.webkitRequestFullscreen = function () { requestTargets.push(this); return webkitRequestFullscreen(environment); };
  if (exitFullscreen) document.exitFullscreen = function () { exits.push('standard'); return exitFullscreen(environment); };
  if (webkitExitFullscreen) document.webkitExitFullscreen = function () { exits.push('webkit'); return webkitExitFullscreen(environment); };
  const context = vm.createContext({ window, document, location, URL, URLSearchParams, console });
  for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) vm.runInContext(script[1], context);
  return {
    document, main, navigations, requestTargets, exits,
    element: id => document.getElementById(id),
    click: () => document.getElementById('fullscreen-button').click(),
    load: () => dispatch(windowListeners, 'load'),
    change: name => dispatch(documentListeners, name),
  };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

function playerUrl(page) {
  assert.equal(page.navigations.length, 1, 'the independent page must configure and navigate exactly one player frame');
  return new URL(page.navigations[0].src, 'https://player.example.test/popout');
}

test('navigates only to the same-origin player with fullscreen and referrer permissions already set', () => {
  const page = openPopout();
  const url = playerUrl(page);
  assert.equal(url.origin, 'https://player.example.test');
  assert.equal(url.pathname, '/player');
  assert.equal(url.searchParams.get('videoId'), 'M7lc1UVf-VE');
  const first = page.navigations[0];
  assert.equal(first.referrerPolicy, 'strict-origin-when-cross-origin');
  assert.equal(first.allowFullscreen, true);
  assert.ok(first.allow.split(/[;\s]+/).includes('fullscreen'));
  assert.ok(first.allow.split(/[;\s]+/).includes('picture-in-picture'));
  assert.ok(first.title.trim(), 'the video frame needs an accessible title');
});

test('uses only valid eleven-character video IDs and never accepts an external frame URL', () => {
  for (const [value, expected] of [
    ['dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['aqz-KE-bpKQ', 'aqz-KE-bpKQ'],
    ['', 'M7lc1UVf-VE'],
    ['short', 'M7lc1UVf-VE'],
    ['dQw4w9WgXcQ!', 'M7lc1UVf-VE'],
    ['dQw4w9Wg Xc', 'M7lc1UVf-VE'],
    ['dQw4w9WgXcQ\n', 'M7lc1UVf-VE'],
    ['dQw4w9WgXcQ\r\n', 'M7lc1UVf-VE'],
    ['https://other.example/evil', 'M7lc1UVf-VE'],
  ]) {
    const page = openPopout({ search: '?videoId=' + encodeURIComponent(value) + '&url=https://other.example/evil' });
    const url = playerUrl(page);
    assert.equal(url.origin, 'https://player.example.test');
    assert.equal(url.pathname, '/player');
    assert.equal(url.searchParams.get('videoId'), expected);
  }
});

test('waits for a click by default and synchronizes standard fullscreen entry and exit', async () => {
  const page = openPopout({
    requestFullscreen({ document, main, change }) { document.fullscreenElement = main; return change('fullscreenchange'); },
    exitFullscreen({ document, change }) { document.fullscreenElement = null; return change('fullscreenchange'); },
  });
  await page.load();
  assert.equal(page.requestTargets.length, 0, 'ordinary pages must not request fullscreen automatically');
  await page.click();
  assert.deepEqual(page.requestTargets, [page.main]);
  assert.equal(page.element('fullscreen-button').getAttribute('aria-pressed'), 'true');
  assert.match(page.element('fullscreen-button').textContent, /종료/);
  await page.click();
  assert.deepEqual(page.exits, ['standard']);
  assert.equal(page.element('fullscreen-button').getAttribute('aria-pressed'), 'false');
  assert.match(page.element('fullscreen-button').textContent, /시작/);
});

test('attempts automatic fullscreen once and lets the user retry after rejection', async () => {
  let rejectAutomatic;
  let attempts = 0;
  const automatic = new Promise((resolve, reject) => { rejectAutomatic = reject; });
  const page = openPopout({
    search: '?fullscreen=1',
    requestFullscreen({ document, main, change }) {
      attempts += 1;
      if (attempts === 1) return automatic;
      document.fullscreenElement = main;
      return change('fullscreenchange');
    },
  });
  const load = page.load();
  await page.load();
  assert.equal(page.requestTargets.length, 1);
  assert.equal(page.element('fullscreen-button').disabled, true);
  await page.click();
  assert.equal(page.requestTargets.length, 1, 'a pending attempt must not create a second request');
  rejectAutomatic(new Error('user activation required'));
  await load;
  await settle();
  assert.equal(page.element('fullscreen-status').hidden, false);
  assert.match(page.element('fullscreen-status').textContent, /전체화면 시작/);
  assert.equal(page.element('fullscreen-button').disabled, false);
  await page.click();
  assert.equal(page.requestTargets.length, 2);
  assert.equal(page.element('fullscreen-button').getAttribute('aria-pressed'), 'true');
});

test('does not report successful fullscreen from a resolved request without actual fullscreen state', async () => {
  const page = openPopout({ search: '?fullscreen=1', requestFullscreen() {} });
  await page.load();
  await settle();
  assert.equal(page.requestTargets.length, 1);
  assert.equal(page.element('fullscreen-button').getAttribute('aria-pressed'), 'false');
  assert.equal(page.element('fullscreen-status').hidden, false);
  assert.match(page.element('fullscreen-status').textContent, /전체화면 시작/);
  assert.equal(page.element('fullscreen-button').disabled, false);
});

test('keeps unsupported fullscreen visible and retryable if the API becomes available', async () => {
  const page = openPopout();
  await page.click();
  assert.equal(page.element('fullscreen-status').hidden, false);
  assert.ok(page.element('fullscreen-status').textContent.trim());
  assert.equal(page.element('fullscreen-button').disabled, false);
  let retries = 0;
  page.main.requestFullscreen = () => { retries += 1; page.document.fullscreenElement = page.main; return page.change('fullscreenchange'); };
  await page.click();
  assert.equal(retries, 1);
  assert.equal(page.element('fullscreen-button').getAttribute('aria-pressed'), 'true');
});

test('recovers from a rejected manual fullscreen request and preserves its retry instruction', async () => {
  let attempts = 0;
  const page = openPopout({ requestFullscreen({ document, main, change }) {
    attempts += 1;
    if (attempts === 1) return Promise.reject(new Error('denied'));
    document.fullscreenElement = main;
    return change('fullscreenchange');
  } });
  await page.click();
  assert.equal(page.element('fullscreen-button').disabled, false);
  assert.equal(page.element('fullscreen-status').hidden, false);
  assert.match(page.element('fullscreen-status').textContent, /전체화면 시작/);
  await page.click();
  assert.equal(attempts, 2);
  assert.equal(page.element('fullscreen-status').hidden, true);
});

test('supports the prefixed fullscreen API and keeps labels synchronized with host events', async () => {
  const page = openPopout({
    webkitRequestFullscreen({ document, main }) { document.webkitFullscreenElement = main; },
    webkitExitFullscreen({ document }) { document.webkitFullscreenElement = null; },
  });
  await page.click();
  await page.change('webkitfullscreenchange');
  assert.deepEqual(page.requestTargets, [page.main]);
  assert.equal(page.element('fullscreen-button').getAttribute('aria-pressed'), 'true');
  assert.match(page.element('fullscreen-button').textContent, /종료/);
  await page.click();
  await page.change('webkitfullscreenchange');
  assert.deepEqual(page.exits, ['webkit']);
  assert.equal(page.element('fullscreen-button').getAttribute('aria-pressed'), 'false');
  page.document.fullscreenElement = page.main;
  await page.change('fullscreenchange');
  assert.equal(page.element('fullscreen-button').getAttribute('aria-pressed'), 'true');
  page.document.fullscreenElement = null;
  await page.change('fullscreenchange');
  assert.equal(page.element('fullscreen-button').getAttribute('aria-pressed'), 'false');
});
