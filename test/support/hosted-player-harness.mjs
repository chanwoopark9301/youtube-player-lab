import { readFileSync } from 'node:fs';
import vm from 'node:vm';

export const playerOrigin = 'https://player.example.test';
export const videoMessage = videoId => ({ method: 'ui/notifications/tool-result', params: { structuredContent: { videoId } } });
export const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

export function openWrapper({ openai, parentPostMessage = true, topLevel = false, openFunction = () => null } = {}) {
  const html = readFileSync(new URL('../../public/hosted-player.html', import.meta.url), 'utf8').replaceAll('__PLAYER_ORIGIN__', playerOrigin);
  const frameListeners = new Map(), windowListeners = new Map(), elements = new Map(), timers = new Map();
  const sent = [], outgoing = [], opened = [], navigations = [];
  let nextTimer = 0;
  const clone = value => JSON.parse(JSON.stringify(value));
  function element(id, tagName = 'DIV', attributes = '') {
    const listeners = new Map();
    const node = {
      id, tagName, hidden: /\bhidden\b/.test(attributes), disabled: /\bdisabled\b/.test(attributes), textContent: '', dataset: {}, style: {},
      addEventListener(name, handler) {
        if (!listeners.has(name)) listeners.set(name, []);
        listeners.get(name).push(handler);
      },
      setAttribute(name, value) { node[name] = value; },
      getAttribute(name) { return node[name] ?? null; },
      removeAttribute(name) { delete node[name]; },
      click() {
        if (node.disabled) return Promise.resolve();
        const event = { target: node, preventDefault() {} };
        const handlers = [...(listeners.get('click') || [])];
        if (typeof node.onclick === 'function') handlers.push(node.onclick);
        return Promise.all(handlers.map(handler => handler(event)));
      },
    };
    for (const [, name, value] of attributes.matchAll(/([\w-]+)="([^"]*)"/g)) node[name] = value;
    elements.set(id, node);
    return node;
  }
  for (const [, tag, attributes, id] of html.matchAll(/<(\w+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) element(id, tag.toUpperCase(), attributes);
  const frame = elements.get('hosted-player');
  Object.assign(frame, {
    referrerPolicy: '',
    contentWindow: { postMessage(message, targetOrigin) { sent.push({ message: clone(message), targetOrigin }); } },
    addEventListener(name, handler) { frameListeners.set(name, handler); },
  });
  Object.defineProperty(frame, 'src', { set(value) {
    navigations.push({ src: value, referrerPolicy: this.referrerPolicy, hasLoadListener: frameListeners.has('load') });
  } });
  const parent = parentPostMessage ? { postMessage(message) { outgoing.push(clone(message)); } } : {};
  const window = {
    openai,
    location: { href: playerOrigin + '/wrapper', origin: playerOrigin },
    open(...args) { opened.push(args); return openFunction(...args); },
    addEventListener(name, handler) {
      if (!windowListeners.has(name)) windowListeners.set(name, []);
      windowListeners.get(name).push(handler);
    },
  };
  window.self = window;
  window.parent = topLevel ? window : parent;
  window.top = topLevel ? window : parent;
  const document = {
    documentElement: { dataset: {} },
    getElementById: id => elements.get(id) ?? null,
    querySelectorAll: selector => selector === 'button' ? [...elements.values()].filter(node => node.tagName === 'BUTTON') : [],
  };
  const context = vm.createContext({ window, document, URL, URLSearchParams,
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
  });
  for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) vm.runInContext(script[1], context);
  function dispatch(name, event) { for (const handler of windowListeners.get(name) || []) handler(event); }
  return {
    html, sent, outgoing, opened, navigations, parent: window.parent, child: frame.contentWindow, document, timers,
    dataset: document.documentElement.dataset,
    element: id => document.getElementById(id),
    click: id => document.getElementById(id).click(),
    load() { frameListeners.get('load')?.(); },
    message(source, data) { dispatch('message', { source, data }); },
    receive(data, source = window.parent) { dispatch('message', { source, data }); },
    respond(request, result) { dispatch('message', { source: window.parent, data: { jsonrpc: '2.0', id: request.id, result } }); },
    fail(request) { dispatch('message', { source: window.parent, data: { jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'denied' } } }); },
    flushTimers() { const batch = [...timers.entries()]; timers.clear(); for (const [, timer] of batch) timer.callback(); },
  };
}
