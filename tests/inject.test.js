'use strict';
// Node 标准库驱动的 DOM/bridge 模型测试；不替代真实 Android WebView 验证。
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const script = fs.readFileSync(path.join(__dirname, '../app/src/main/res/raw/inject.js'), 'utf8');

function environment() {
  const state = { now: 100000, queries: 0, timers: new Map(), sequence: 0, observers: [], alerts: [] };
  class Event {
    constructor(type, values = {}) { this.type = type; Object.assign(this, values); }
    stopPropagation() { this.stopped = true; }
    preventDefault() { this.prevented = true; }
  }
  class Events {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(listener);
    }
    dispatchEvent(event) {
      if (!event.target) event.target = this;
      for (const callback of this.listeners.get(event.type) || []) callback(event);
      return !event.prevented;
    }
  }
  class Element extends Events {
    constructor(tag, text = '') {
      super(); this.tagName = tag.toUpperCase(); this.nodeType = 1;
      this.children = []; this.parentElement = null; this.attrs = {}; this._text = text;
      this.style = {};
      Object.defineProperty(this.style, 'cssText', {set: value => {
        for (const item of value.split(';')) {
          const colon = item.indexOf(':');
          if (colon >= 0) this.style[item.slice(0, colon).trim()] = item.slice(colon + 1).trim();
        }
      }});
      this.rect = {width: 140, height: 40, top: 50, left: 10, right: 150};
    }
    get textContent() { return this._text + this.children.map(node => node.textContent).join(''); }
    set textContent(value) { this._text = value; this.children = []; }
    setAttribute(key, value) { this.attrs[key] = String(value); }
    appendChild(node) { if (node.parentElement) node.remove(); this.children.push(node); node.parentElement = this; return node; }
    remove() {
      if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this);
      this.parentElement = null;
    }
    contains(node) { return !!node && (node === this || this.children.some(child => child.contains(node))); }
    getBoundingClientRect() { return this.rect; }
    matches(selector) {
      if (selector[0] === '#') return this.id === selector.slice(1);
      let match = selector.match(/^\[class\*="(.+)"\]$/);
      if (match) return (this.attrs.class || '').includes(match[1]);
      match = selector.match(/^\[([^=]+)="(.+)"\]$/);
      if (match) return this.attrs[match[1]] === match[2];
      match = selector.match(/^\[([^=]+)\]$/);
      if (match) return Object.hasOwn(this.attrs, match[1]);
      return this.tagName.toLowerCase() === selector.toLowerCase();
    }
    closest(selectors) {
      for (let node = this; node; node = node.parentElement) {
        if (selectors.split(',').some(selector => node.matches(selector))) return node;
      }
      return null;
    }
  }
  const document = new Events();
  document.documentElement = new Element('html');
  document.head = document.documentElement.appendChild(new Element('head'));
  document.body = document.documentElement.appendChild(new Element('body'));
  document.hidden = false;
  function all(node) { return [node, ...node.children.flatMap(all)]; }
  document.createElement = tag => new Element(tag);
  document.querySelectorAll = selector => {
    state.queries++;
    return all(document.documentElement).filter(node => selector.split(',').some(part => node.matches(part)));
  };
  document.getElementById = id => all(document.documentElement).find(node => node.id === id) || null;
  class Observer {
    constructor(callback) { this.callback = callback; state.observers.push(this); }
    observe() { this.active = true; }
    disconnect() { this.active = false; }
    trigger(records) { if (this.active) this.callback(records); }
  }
  class Reader {
    readAsDataURL(blob) {
      blob.arrayBuffer().then(buffer => {
        this.result = 'data:application/octet-stream;base64,' + Buffer.from(buffer).toString('base64');
        this.onload();
      }).catch(error => { this.error = error; this.onerror(); });
    }
  }
  const window = new Events();
  window.top = window;
  window.innerWidth = 480;
  window.getComputedStyle = node => ({visibility: 'visible', display: 'block', opacity: '1', ...node.style});
  window.setTimeout = (callback, delay) => {
    const id = ++state.sequence; state.timers.set(id, {callback, due: state.now + delay}); return id;
  };
  window.clearTimeout = id => state.timers.delete(id);
  window.alert = text => state.alerts.push(text);
  const sandbox = {window, document, MutationObserver: Observer, MouseEvent: Event, PointerEvent: Event,
    FileReader: Reader, Date: class extends Date { static now() { return state.now; } },
    fetch: source => state.fetch(source), console};
  const context = vm.createContext(sandbox);
  const env = {
    window, document, state, Element, Event,
    add(tag, text, props = {}) { const node = Object.assign(new Element(tag, text), props); return document.body.appendChild(node); },
    run() { vm.runInContext(script, context); },
    mutate(target = document.body, type = 'childList', extra = {}) {
      state.observers.forEach(observer => observer.trigger([{target, type, addedNodes: [], removedNodes: [], ...extra}]));
    },
    advance(ms) {
      const end = state.now + ms;
      for (let guard = 0; guard < 100; guard++) {
        const next = [...state.timers].filter(([, timer]) => timer.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        state.timers.delete(next[0]); state.now = next[1].due; next[1].callback();
      }
      state.now = end;
    },
    imageClick(image) { const event = new Event('click', {target: image}); document.dispatchEvent(event); return event; }
  };
  return env;
}

async function settle(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('asynchronous image transfer did not settle');
}

test('idle page has no periodic scans and injection is idempotent', () => {
  const env = environment(); env.add('button', '深度研究'); env.run();
  assert.equal(env.state.queries, 1);
  env.advance(60000);
  assert.equal(env.state.queries, 1);
  env.run();
  assert.equal(env.state.queries, 1);
  assert.equal(env.state.observers.length, 1);
});

test('shortcut targets page content once and disappears when page content is removed', () => {
  const env = environment(); const card = env.add('button', '深度研究'); let clicks = 0;
  card.addEventListener('click', () => clicks++); env.run();
  const menu = env.document.getElementById('gcMenu');
  menu.children[2].dispatchEvent(new env.Event('click'));
  assert.equal(clicks, 1);
  card.remove(); env.mutate(); env.advance(1000);
  assert.equal(env.document.getElementById('gcFab').style.display, 'none');
  assert.equal(menu.style.display, 'none');
});

test('SPA mutation bursts coalesce and own UI mutations do not rescan', () => {
  const env = environment(); const card = env.add('button', '深度研究'); env.run();
  for (let i = 0; i < 1000; i++) env.mutate(card, 'characterData');
  assert.equal(env.state.timers.size, 1); env.advance(1000);
  assert.equal(env.state.queries, 2);
  env.mutate(env.document.getElementById('gcMenu'), 'attributes');
  env.advance(1000); assert.equal(env.state.queries, 2);
});

test('hidden pages suspend scanning and BFCache-style pageshow resumes it', () => {
  const env = environment(); env.run(); const initial = env.state.queries;
  env.document.hidden = true; env.document.dispatchEvent(new env.Event('visibilitychange'));
  env.mutate(); env.advance(5000); assert.equal(env.state.queries, initial);
  env.document.hidden = false; env.document.dispatchEvent(new env.Event('visibilitychange'));
  env.advance(1000); assert.equal(env.state.queries, initial + 1);
  env.window.dispatchEvent(new env.Event('pagehide')); env.mutate(); env.advance(5000);
  assert.equal(env.state.queries, initial + 1);
  env.window.dispatchEvent(new env.Event('pageshow')); env.advance(1000);
  assert.equal(env.state.queries, initial + 2);
});

test('hidden targets are excluded; model name alone does not create a shortcut', () => {
  const env = environment(); const hidden = env.add('button', '深度研究'); hidden.setAttribute('hidden', '');
  env.run(); assert.equal(env.document.getElementById('gcFab'), null);
  // “切换模型”入口已按需求移除：只有模型名的页面不应出现快捷入口。
  env.add('button', 'ChatGPT 5.6 Sol'); env.mutate(); env.advance(1000);
  assert.equal(env.document.getElementById('gcFab'), null);
  env.add('button', '深度研究'); env.mutate(); env.advance(1000);
  const menu = env.document.getElementById('gcMenu');
  assert.equal(menu.children[2].style.display, 'block');
  assert.equal(menu.children[3].style.display, 'none');
});

test('image clicks retain site behavior without a bridge and when native rejects input', () => {
  const env = environment(); const img = env.add('img', '', {src: 'https://cdn.example/a.png', naturalWidth: 800});
  env.run(); assert.equal(env.imageClick(img).prevented, undefined);
  let calls = 0;
  env.window.GptCatBridge = {openImage(token, url) { calls++; assert.equal(url, img.src); return false; }};
  assert.equal(env.imageClick(img).prevented, undefined);
  env.window.GptCatBridge.openImage = () => true;
  assert.equal(env.imageClick(img).prevented, true); assert.equal(calls, 1);
});

test('blob image transfer preserves bytes and bounds each bridge chunk to 64 KiB', async () => {
  const env = environment(); const input = Buffer.alloc(160000);
  for (let i = 0; i < input.length; i++) input[i] = i % 251;
  const chunks = []; let finished = false;
  env.window.GptCatBridge = {
    openImage() { throw new Error('blob must not be passed as an Intent URL'); },
    beginImage(token, size) { assert.equal(size, input.length); return 'transfer'; },
    appendImage(token, id, encoded) { assert.equal(id, 'transfer'); assert.ok(encoded.length <= 65536); chunks.push(Buffer.from(encoded, 'base64')); return true; },
    finishImage(token, id) { finished = true; return true; },
    cancelImage() { assert.fail('unexpected cancellation'); }
  };
  env.state.fetch = async () => ({ok: true, blob: async () => new Blob([input], {type: 'image/png'})});
  const img = env.add('img', '', {src: 'blob:test', naturalWidth: 800}); env.run();
  assert.equal(env.imageClick(img).prevented, true);
  await settle(() => finished);
  assert.deepEqual(Buffer.concat(chunks), input); assert.equal(chunks.length, 4);
  assert.deepEqual(env.state.alerts, []);
});

test('failed chunk cancels its transfer and reports the failure', async () => {
  const env = environment(); let cancelled = false;
  env.window.GptCatBridge = {openImage() {}, beginImage() {return 'transfer';}, appendImage() {return false;},
    finishImage() {assert.fail('incomplete transfer');}, cancelImage() {cancelled = true;}};
  env.state.fetch = async () => ({ok: true, blob: async () => new Blob([Buffer.alloc(100)])});
  const img = env.add('img', '', {src: 'data:image/png;base64,AAAA', naturalWidth: 800}); env.run(); env.imageClick(img);
  await settle(() => env.state.alerts.length > 0); assert.equal(cancelled, true);
});

test('oversized images are rejected before opening a native transfer', async () => {
  const env = environment();
  env.window.GptCatBridge = {openImage() {}, beginImage() {assert.fail('oversized transfer');}};
  env.state.fetch = async () => ({ok: true, blob: async () => ({size: 32 * 1024 * 1024 + 1})});
  const img = env.add('img', '', {src: 'blob:large', naturalWidth: 800}); env.run(); env.imageClick(img);
  await settle(() => env.state.alerts.length > 0); assert.match(env.state.alerts[0], /32 MiB/);
});
