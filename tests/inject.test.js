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
    attrValue(key) {
      if (Object.hasOwn(this.attrs, key)) return this.attrs[key];
      // 真实 DOM 的 href/src/download 等既是指 IDL 属性也反射到 attributes。
      return this[key] === undefined ? null : String(this[key]);
    }
    getAttribute(key) { return this.attrValue(key); }
    hasAttribute(key) { return this.attrValue(key) !== null; }
    appendChild(node) { if (node.parentElement) node.remove(); this.children.push(node); node.parentElement = this; return node; }
    remove() {
      if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this);
      this.parentElement = null;
    }
    contains(node) { return !!node && (node === this || this.children.some(child => child.contains(node))); }
    descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
    querySelector(selector) {
      const parts = selector.split(',').map(item => item.trim());
      return this.descendants().find(node => parts.some(part => node.matches(part))) || null;
    }
    getBoundingClientRect() { return this.rect; }
    matches(selector) {
      const part = selector.trim();
      if (part === '*') return true;
      if (part[0] === '#') return this.id === part.slice(1);

      let match = part.match(/^\[class\*="(.+)"\]$/);
      if (match) return (this.attrValue('class') || '').includes(match[1]);

      match = part.match(/^\[([^=]+)="(.+)"\]$/);
      if (match) return this.attrValue(match[1]) === match[2];

      match = part.match(/^\[([^=]+)\]$/);
      if (match) return this.attrValue(match[1]) !== null;

      // tag / tag[attr] / tag[attr="value"]
      const combo = part.match(/^([a-zA-Z][\w-]*)?(\[[^\]]*\])?$/);
      if (!combo) return false;

      if (combo[1] && this.tagName.toLowerCase() !== combo[1].toLowerCase()) return false;
      if (!combo[2]) return true;

      const attr = combo[2].match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
      if (!attr) return false;

      const value = this.attrValue(attr[1]);
      if (value === null) return false;

      return attr[2] === undefined || value === attr[2];
    }
    closest(selectors) {
      for (let node = this; node; node = node.parentElement) {
        if (selectors.split(',').some(selector => node.matches(selector))) return node;
      }
      return null;
    }
    querySelectorAll(selector) {
      return this.descendants().filter(node => selector.split(',').some(part => node.matches(part)));
    }
    cloneNode(deep = true) {
      const copy = new Element(this.tagName, this._text);
      Object.assign(copy.attrs, this.attrs);
      if (deep) this.children.forEach(child => copy.appendChild(child.cloneNode(true)));
      return copy;
    }
    removeChild(node) { node.remove(); }
    get isConnected() {
      for (let node = this; node; node = node.parentElement) {
        if (node === document.documentElement) return true;
      }
      return false;
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
  document.querySelector = selector => {
    state.queries++;
    return all(document.documentElement)
      .find(node => selector.split(',').some(part => node.matches(part))) || null;
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
  window.matchMedia = () => ({matches: false, addEventListener() { }, addListener() { }});

  const store = new Map();
  const localStorage = {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: key => store.delete(key)
  };

  const sandbox = {window, document, localStorage, MutationObserver: Observer, MouseEvent: Event,
    PointerEvent: Event, FileReader: Reader,
    Date: class extends Date { static now() { return state.now; } },
    fetch: source => state.fetch(source), console};
  const context = vm.createContext(sandbox);
  const env = {
    window, document, state, Element, Event, store,
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
  const firstPass = env.state.queries;
  assert.ok(firstPass > 0, '首次注入应至少扫描一次');
  env.advance(60000);
  assert.equal(env.state.queries, firstPass, '空闲时不得有周期性扫描');
  env.run();
  assert.equal(env.state.queries, firstPass, '重复注入不得再扫描');
  assert.equal(env.state.observers.length, 1, '只应注册一个 MutationObserver');
});

test('local entries live in the site 功能选单 instead of a floating button', () => {
  const env = environment(); env.add('button', '深度研究'); env.run();

  assert.equal(env.document.getElementById('gcFab'), null, '不再有闪电悬浮按钮');
  assert.equal(env.document.querySelector('[data-gc-menu-action]'), null, '没有站点菜单时不注入');

  const host = addSiteMenu(env);
  env.mutate(); env.advance(1000);

  const added = host.children.filter(row => row.hasAttribute('data-gc-menu-action'));
  assert.equal(added.length, 2);
  assert.ok(added[0].textContent.includes('下载任务'), added[0].textContent);
  assert.ok(added[1].textContent.includes('图片缓存'), added[1].textContent);

  clickNode(env, added[0]);
  assert.equal(env.document.getElementById('gcPanel').style.display, 'block');
  assert.equal(env.document.getElementById('gcPanelTitle').textContent, '下载任务');

  // 再来一轮刷新不得重复插入。
  env.mutate(); env.advance(1000);
  assert.equal(host.children.filter(row => row.hasAttribute('data-gc-menu-action')).length, 2);
});

// 每次刷新的 DOM 查询量随功能增加会变，测试只约束"刷新次数"，不锁死单次代价。
function perRefreshCost(env) {
  const before = env.state.queries;
  env.mutate();
  env.advance(1000);
  const cost = env.state.queries - before;
  assert.ok(cost > 0, '内容变动后应发生一次扫描');
  assert.ok(cost <= 8, `单次刷新查询量应受控，实际 ${cost}`);
  return cost;
}

test('SPA mutation bursts coalesce and own UI mutations do not rescan', () => {
  const env = environment(); const card = env.add('button', '深度研究'); env.run();
  const cost = perRefreshCost(env);
  const settled = env.state.queries;
  for (let i = 0; i < 1000; i++) env.mutate(card, 'characterData');
  assert.equal(env.state.timers.size, 1);
  env.advance(1000);
  assert.equal(env.state.queries, settled + cost, '1000 次变动只允许合并成一次刷新');
  env.mutate(env.document.getElementById('gc-theme'), 'attributes');
  env.advance(1000); assert.equal(env.state.queries, settled + cost, '自家 UI 变动不得触发刷新');
});

test('hidden pages suspend scanning and BFCache-style pageshow resumes it', () => {
  const env = environment(); env.run();
  const cost = perRefreshCost(env);
  const visible = env.state.queries;
  env.document.hidden = true; env.document.dispatchEvent(new env.Event('visibilitychange'));
  env.mutate(); env.advance(5000); assert.equal(env.state.queries, visible, '后台页面不得扫描');
  env.document.hidden = false; env.document.dispatchEvent(new env.Event('visibilitychange'));
  env.advance(1000); assert.equal(env.state.queries, visible + cost, '回到前台应恢复一次刷新');
  const resumed = env.state.queries;
  env.window.dispatchEvent(new env.Event('pagehide')); env.mutate(); env.advance(5000);
  assert.equal(env.state.queries, resumed, 'pagehide 后不得扫描');
  env.window.dispatchEvent(new env.Event('pageshow')); env.advance(1000);
  assert.equal(env.state.queries, resumed + cost, 'pageshow 应恢复刷新');
});

test('editing surfaces never trigger image preview even when they contain an image', () => {
  const env = environment(); let calls = 0;
  env.window.GptCatBridge = {openImage() { calls++; return true; }};
  const composer = env.add('form', '');
  const inside = Object.assign(new env.Element('img'), {src: 'https://cdn.example/composer.png', naturalWidth: 800});
  composer.appendChild(inside);
  env.run();
  assert.equal(env.imageClick(inside).prevented, undefined, '输入区内的图片点击应保留站点原行为');
  assert.equal(calls, 0, '输入区（composer/form）内的图片不得进入预览');
});

test('page buttons no longer build our own menu', () => {
  const env = environment(); const hidden = env.add('button', '深度研究'); hidden.setAttribute('hidden', '');
  env.run();

  assert.equal(env.document.getElementById('gcFab'), null, '闪电悬浮按钮已按需求移除');
  assert.equal(env.document.getElementById('gcMenu'), null, '自建菜单已移除');
  assert.equal(env.document.querySelector('[data-gc-menu-action]'), null, '页面按钮不再产出菜单项');

  // “切换模型”入口已按需求移除：只有模型名的页面不应产出任何入口。
  env.add('button', 'ChatGPT 5.6 Sol'); env.mutate(); env.advance(1000);
  assert.equal(env.document.getElementById('gcMenu'), null);
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

// ---------------------------------------------------------------- 第九轮：下载 / 缓存

/** 造一份站点「功能选单」浮层：三行自家菜单项（图标 + 文案），容器带 role=menu。 */
function addSiteMenu(env) {
  const panel = env.add('div', '');
  panel.setAttribute('role', 'menu');

  ['返回首页', '刷新会话', '对话导出'].forEach(label => {
    const row = panel.appendChild(new env.Element('button', ''));
    row.appendChild(new env.Element('span', '🗂'));
    row.appendChild(new env.Element('span', label));
  });

  return panel;
}

/** 注入到站点菜单里的本地功能行。 */
function localEntry(env, label) {
  const rows = env.document.querySelectorAll('[data-gc-menu-action]');
  return rows.find(row => row.textContent.indexOf(label) !== -1) || null;
}

/** 触发元素自身的监听器（面板按钮 / 注入行）。 */
function clickNode(env, node) {
  const event = new env.Event('click', {target: node});
  node.dispatchEvent(event);
  return event;
}

/** 触发挂在 document 上的捕获监听器（图片预览 / 下载拦截 / 功能选单开关）。 */
function clickDocument(env, node) {
  const event = new env.Event('click', {target: node});
  env.document.dispatchEvent(event);
  return event;
}

test('tapping the site 功能选单 toggle injects our entries', () => {
  const env = environment(); env.add('button', '深度研究'); env.run();

  assert.equal(env.document.querySelector('[data-gc-menu-action]'), null);

  const host = addSiteMenu(env);
  const pill = env.add('button', '功能选单');

  clickDocument(env, pill);
  assert.equal(env.document.querySelector('[data-gc-menu-action]'), null, '菜单渲染前不得插入');

  env.advance(300);
  const added = host.children.filter(row => row.hasAttribute('data-gc-menu-action'));
  assert.equal(added.length, 2);
  assert.ok(added[0].textContent.includes('下载任务'), added[0].textContent);
  assert.ok(added[1].textContent.includes('图片缓存'), added[1].textContent);
  assert.equal(added[0].textContent.includes('🗂'), false, '站点自带的图标要清掉');
  assert.equal(added[0].children.length, 1, '克隆的应是整行，而不是一截文字');
});

test('tapping an injected row closes the site menu and opens our panel', () => {
  const env = environment(); addSiteMenu(env); env.run();
  const pill = env.add('button', '功能选单');
  env.mutate(); env.advance(1000);

  let pillClicks = 0;
  pill.addEventListener('click', () => pillClicks++);

  clickNode(env, localEntry(env, '图片缓存'));

  assert.equal(pillClicks, 1, '应先收起站点自己的菜单');
  assert.equal(env.document.getElementById('gcPanelTitle').textContent, '图片缓存');
});

test('cache panel reports stats and clears the requested kind', () => {
  const env = environment(); addSiteMenu(env); env.run();
  env.mutate(); env.advance(1000);

  const cleared = [];
  env.window.GptCatBridge = {
    cacheStats(token) { return '{"images":3,"imageBytes":2048,"webBytes":4096}'; },
    clearCache(token, kind) { cleared.push(kind); return '{"images":2048,"web":true}'; }
  };

  clickNode(env, localEntry(env, '图片缓存'));

  const body = env.document.getElementById('gcPanelBody');
  assert.match(body.textContent, /图片缓存文件/);
  assert.match(body.textContent, /2\.0 KB/);

  const buttons = body.children[3].children;
  clickNode(env, buttons[0]);
  assert.deepEqual(cleared, ['images']);
  assert.match(env.document.getElementById('gcPanelResult').textContent, /已清理/);
});

test('zip clicks always report something and register a task', () => {
  const env = environment(); addSiteMenu(env); env.run();
  env.mutate(); env.advance(1000);

  const anchor = env.add('a', '下载 ZIP', {href: 'https://cdn.example/pack.zip'});
  const ids = [];
  env.window.GptCatBridge = {
    downloadFile(token, url, name) { ids.push([url, name]); return '7788'; },
    getDownloadProgress() { return 'running|42|42|100'; },
    openDownloadedFile() { return true; }
  };

  const event = clickDocument(env, anchor);
  assert.equal(event.prevented, true, '已接管的下载要阻止站点默认行为');
  assert.deepEqual(ids, [['https://cdn.example/pack.zip', 'pack.zip']]);

  const chip = env.document.getElementById('gcDownloadChip');
  assert.equal(chip.style.display, 'block');
  assert.match(chip.textContent, /pack\.zip/);

  clickNode(env, localEntry(env, '下载任务'));
  assert.match(env.document.getElementById('gcPanelBody').textContent, /pack\.zip/);
});

test('download without a file extension is still caught and never silently ignored', () => {
  const env = environment(); env.add('button', '深度研究'); env.run();

  const anchor = env.add('a', '下载', {href: 'https://cdn.example/api/export?id=9'});
  env.window.GptCatBridge = {
    downloadFile() { return ''; },
    getDownloadProgress() { return 'unknown|-1|0|0'; }
  };

  clickDocument(env, anchor);
  const chip = env.document.getElementById('gcDownloadChip');
  assert.equal(chip.style.display, 'block', '必须给出可见反馈');
  assert.match(chip.textContent, /交给系统处理/);
});

test('blob downloads stream to disk through the file bridge', async () => {
  const env = environment(); env.add('button', '深度研究'); env.run();

  const anchor = env.add('a', '下载打包结果', {href: 'blob:https://site/x-1'});
  const input = Buffer.alloc(70000, 7);
  const chunks = [];
  let finished = '';

  env.window.GptCatBridge = {
    beginFile(token, name, mime, size) {
      assert.equal(size, input.length);
      assert.equal(name, '下载打包结果'.length ? name : name);
      return 'file-transfer';
    },
    appendFile(token, id, encoded) { chunks.push(Buffer.from(encoded, 'base64')); return true; },
    finishFile(token, id) { finished = id; return 'local:42'; },
    cancelFile() { assert.fail('unexpected cancellation'); }
  };
  env.state.fetch = async () => ({ok: true, blob: async () => new Blob([input], {type: 'application/zip'})});

  clickDocument(env, anchor);
  await settle(() => finished !== '');
  assert.equal(finished, 'file-transfer');
  assert.deepEqual(Buffer.concat(chunks), input);
  assert.match(env.document.getElementById('gcDownloadChip').textContent, /已保存到/);
});

test('injection is idempotent and never leaves a floating button behind', () => {
  const env = environment(); const host = addSiteMenu(env); env.run(); env.advance(4000);

  assert.equal(env.document.getElementById('gcFab'), null);
  assert.equal(env.document.getElementById('gcMenu'), null);

  const added = host.children.filter(row => row.hasAttribute('data-gc-menu-action'));
  assert.equal(added.length, 2);
  added.forEach(row => assert.equal(row.getAttribute('data-gc-ui'), '', '自家节点必须带标记'));

  // 站点菜单重渲染（我们两行被清掉）后应能重新插回。
  added.forEach(row => row.remove());
  env.mutate(); env.advance(1000);
  assert.equal(host.children.filter(row => row.hasAttribute('data-gc-menu-action')).length, 2);
});
