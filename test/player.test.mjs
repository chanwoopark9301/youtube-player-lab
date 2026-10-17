import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function openPlayer({ search = '', effectiveOrigin = 'https://actual.example.test:8443' } = {}) {
  const html = readFileSync(new URL('../public/player.html', import.meta.url), 'utf8');
  const elements = new Map();
  const listeners = new Map();
  const navigations = [];
  const constructors = [];
  const cues = [];
  const connections = [], loads=[];
  const parent = {};
  const location = new URL('https://location.example.test/player' + search);
  function element(tagName = 'div') {
    let id = '';
    let src = '';
    const node = {
      tagName: tagName.toUpperCase(), dataset: {}, style: {},
      hidden: false, disabled: false, value: '', textContent: '',
      scrollTop: 0, scrollHeight: 0, referrerPolicy: '', allow: '', allowFullscreen: false,
      get id() { return id; },
      set id(value) { id = value; elements.set(value, node); },
      get src() { return src; },
      set src(value) {
        src = String(value);
        if (node.tagName === 'IFRAME') navigations.push({
          element: node, src, allow: node.allow,
          allowFullscreen: node.allowFullscreen, referrerPolicy: node.referrerPolicy,
        });
      },
      setAttribute(name, value) {
        if (name.toLowerCase() === 'allowfullscreen') node.allowFullscreen = true;
        else node[name === 'referrerpolicy' ? 'referrerPolicy' : name] = value;
      },
      append(...children) { for (const child of children) child.parentNode = node; },
      appendChild(child) { node.append(child); return child; },
      replaceWith(replacement) { if (replacement.id) elements.set(replacement.id, replacement); },
      addEventListener() {},
    };
    return node;
  }
  const document = {
    referrer: '', head: element('head'), body: element('body'), documentElement: element('html'),
    createElement: element,
    getElementById(id) {
      if (!elements.has(id)) { const node = element(); node.id = id; }
      return elements.get(id);
    },
  };
  const YT = {
    Player: function Player(target, options) {
      const frame = typeof target === 'string' ? document.getElementById(target) : target;
      this.getIframe = () => frame;
      this.cueVideoById = videoId => cues.push(videoId);
      this.loadVideoById = videoId => loads.push(videoId);
      this.getVideoData = () => ({video_id:loads.at(-1)||'M7lc1UVf-VE'});
      this.getPlayerState = () => 1;
      this.getCurrentTime = () => 12.5;
      constructors.push({ frame, options, player: this });
    },
  };
  const window = {
    parent, origin: effectiveOrigin, location, YT,
    createYouTubeSessionClient(connection,adapter){connections.push({connection,adapter});return {stop(){}}},
    addEventListener(name, handler) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(handler);
    },
  };
  const context = vm.createContext({
    window, document, location, YT, URL, URLSearchParams,
    setTimeout: () => 1, clearTimeout() {}, console,
  });
  for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    vm.runInContext(script[1], context);
  }
  return {
    navigations, constructors, cues, parent, connections, loads,
    apiReady() {
      assert.equal(typeof window.onYouTubeIframeAPIReady, 'function', 'the player must register the YouTube API callback');
      window.onYouTubeIframeAPIReady();
    },
    ready() {
      assert.equal(constructors.length, 1, 'the player must bind exactly one YouTube player');
      const binding = constructors[0];
      binding.options.events.onReady({ target: binding.player });
    },
    message(source, data) {
      for (const handler of listeners.get('message') || []) handler({ source, data });
    },
  };
}

function videoMessage(videoId) {
  return { method: 'ui/notifications/tool-result', params: { structuredContent: { videoId } } };
}

function navigation(runtime) {
  assert.equal(runtime.navigations.length, 1, 'the app must configure and navigate its own iframe before binding the YouTube API');
  return runtime.navigations[0];
}

test('sets fullscreen and referrer permissions before navigating the official iframe and binds that frame', () => {
  const runtime = openPlayer();
  runtime.apiReady();
  const first = navigation(runtime);
  const url = new URL(first.src);
  assert.equal(url.protocol, 'https:');
  assert.ok(['www.youtube.com', 'www.youtube-nocookie.com'].includes(url.hostname));
  assert.equal(url.pathname, '/embed/M7lc1UVf-VE');
  assert.equal(url.searchParams.get('enablejsapi'), '1');
  assert.equal(url.searchParams.get('controls'), '1');
  assert.equal(url.searchParams.get('fs'), '1');
  assert.ok(first.allow.split(/[;\s]+/).includes('fullscreen'), 'fullscreen must be allowed at navigation time');
  assert.equal(first.allowFullscreen, true, 'legacy fullscreen permission must be set at navigation time');
  assert.equal(first.referrerPolicy, 'strict-origin-when-cross-origin');
  assert.equal(runtime.constructors.length, 1);
  assert.equal(runtime.constructors[0].frame, first.element, 'YouTube must bind the preconfigured iframe');
});

test('cues the latest parent video received before YouTube is ready', () => {
  const runtime = openPlayer();
  runtime.message(runtime.parent, videoMessage('dQw4w9WgXcQ'));
  runtime.apiReady();
  runtime.message(runtime.parent, videoMessage('aqz-KE-bpKQ'));
  assert.deepEqual(runtime.cues, [], 'video commands must wait for readiness');
  runtime.ready();
  assert.deepEqual(runtime.cues, ['aqz-KE-bpKQ']);
});

test('rejects spoofed sources and malformed video IDs before and after readiness', () => {
  const runtime = openPlayer();
  function rejectedMessages() {
    runtime.message({}, videoMessage('dQw4w9WgXcQ'));
    for (const videoId of [null, undefined, '', 'short', 'M7lc1UVf-VE!', 'M7lc1UVf VE', 12345678901, ['dQw4w9WgXcQ']]) {
      runtime.message(runtime.parent, videoMessage(videoId));
    }
    runtime.message(runtime.parent, { method: 'unrelated', params: { structuredContent: { videoId: 'dQw4w9WgXcQ' } } });
    runtime.message(runtime.parent, null);
    runtime.message(runtime.parent, {});
  }
  rejectedMessages();
  runtime.apiReady();
  runtime.ready();
  rejectedMessages();
  assert.deepEqual(runtime.cues, []);
  runtime.message(runtime.parent, videoMessage('aqz-KE-bpKQ'));
  assert.deepEqual(runtime.cues, ['aqz-KE-bpKQ'], 'a valid parent video must still apply after rejected messages');
});

test('uses a valid initial videoId query in the iframe without an extra ready-time cue', () => {
  const runtime = openPlayer({ search: '?videoId=dQw4w9WgXcQ' });
  runtime.apiReady();
  assert.equal(new URL(navigation(runtime).src).pathname, '/embed/dQw4w9WgXcQ');
  runtime.ready();
  assert.deepEqual(runtime.cues, []);
});

test('falls back to the official default for malformed initial videoId queries', () => {
  for (const value of ['', 'short', 'M7lc1UVf-VE!', 'M7lc1UVf VE', '<script>bad']) {
    const runtime = openPlayer({ search: '?videoId=' + encodeURIComponent(value) });
    runtime.apiReady();
    assert.equal(new URL(navigation(runtime).src).pathname, '/embed/M7lc1UVf-VE', `invalid query ${JSON.stringify(value)} must use the default`);
  }
});

test('sends the actual effective HTTP(S) origin rather than the URL origin', () => {
  for (const effectiveOrigin of ['https://actual.example.test:8443', 'http://localhost:8787']) {
    const runtime = openPlayer({ effectiveOrigin });
    runtime.apiReady();
    assert.equal(new URL(navigation(runtime).src).searchParams.get('origin'), effectiveOrigin);
  }
});

test('omits the origin parameter for opaque and non-HTTP execution origins', () => {
  for (const effectiveOrigin of ['null', 'codex-sandbox://player', 'file://', 'data:text/html,test']) {
    const runtime = openPlayer({ effectiveOrigin });
    runtime.apiReady();
    assert.equal(new URL(navigation(runtime).src).searchParams.has('origin'), false, `execution origin ${effectiveOrigin} must not become a player origin parameter`);
  }
});

test('connects UI-only session credentials after YouTube readiness and reads actual API state',()=>{
  const runtime=openPlayer();
  const connection={playerRef:'a'.repeat(43),reportKey:'b'.repeat(43)};
  const data={method:'ui/notifications/tool-result',params:{structuredContent:{videoId:'M7lc1UVf-VE'},_meta:{playerConnection:connection}}};
  runtime.message({},data);
  runtime.apiReady();runtime.ready();
  assert.equal(runtime.connections.length,0,'a spoofed parent must not attach a session');
  runtime.message(runtime.parent,data);
  assert.equal(runtime.connections.length,1);
  const adapter=runtime.connections[0].adapter;
  assert.equal(adapter.read().currentTime,12.5);
  assert.equal(adapter.read().state,'playing');
  adapter.select('jNQXAC9IVRw');
  assert.deepEqual(runtime.loads,['jNQXAC9IVRw']);
  runtime.message(runtime.parent,data);
  assert.equal(runtime.connections.length,1,'duplicate tool notification must not replace its own connection');
});

test('a recovered YouTube playback clears an earlier error from observed session state',()=>{
  const runtime=openPlayer();runtime.apiReady();runtime.ready();
  runtime.message(runtime.parent,{method:'ui/notifications/tool-result',params:{structuredContent:{videoId:'M7lc1UVf-VE'},_meta:{playerConnection:{playerRef:'a'.repeat(43),reportKey:'b'.repeat(43)}}}});
  const events=runtime.constructors[0].options.events;
  const adapter=runtime.connections[0].adapter;
  events.onError({data:5});assert.equal(adapter.read().state,'error');
  events.onStateChange({data:1});
  assert.equal(adapter.read().state,'playing');
  assert.equal(adapter.read().error,undefined);
});
