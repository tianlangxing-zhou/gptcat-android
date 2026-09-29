// GPTCat 移动端适配：变化驱动的快捷入口 + 分块传输图片。
(function (bridgeToken) {
  'use strict';
  if (window !== window.top || window.__gcInjected) return;
  window.__gcInjected = true;

  var ITEMS = [
    { key: '__model__', icon: '🤖', label: '切换模型' },
    { key: 'GPT官方镜像', icon: '🪞' },
    { key: '香蕉 2 绘图', icon: '🍌' },
    { key: '深度研究', icon: '🔍' },
    { key: '思维导图', icon: '🧠' },
    { key: '返回首页', icon: '🏠' },
    { key: '升级套餐', icon: '⭐' }
  ];
  var MODEL = /GPT|Gemini|Claude|Deepseek|Grok|Auto/i;
  var SELECTOR = 'div,section,li,button,a,span,p,h3,h4';
  var EXCLUDED_MODEL = '[class*="drawer"],[class*="sider"],[class*="dropdown"],[class*="popover"],[class*="menu"]';
  var MAX_IMAGE_BYTES = 32 * 1024 * 1024;
  var CHUNK_BYTES = 48 * 1024;
  var fab = null, menu = null, rows = [], targets = [];
  var timer = null, lastScan = 0, suspended = false, imageBusy = false;
  var menuTimer = null, suppressClick = false, fabX = null, fabY = null, dragBound = false;

  function own(node) {
    var el = node && (node.nodeType === 1 ? node : node.parentElement);
    return !!(el && el.closest && el.closest('[data-gc-ui]'));
  }

  function mark(node) { node.setAttribute('data-gc-ui', ''); return node; }

  function visible(node) {
    if (node.closest('[hidden],[aria-hidden="true"]')) return false;
    var rect = node.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    var style = window.getComputedStyle(node);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  }

  // 一次查询同时寻找所有入口，排除自己的按钮和菜单，避免自匹配/递归点击。
  function scanTargets() {
    var result = new Array(ITEMS.length);
    var nodes = document.querySelectorAll(SELECTOR);
    var modelTop = Infinity;
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (own(node)) continue;
      var text = (node.textContent || '').trim();
      if (!text || text.length > 100) continue;
      var checkedVisible = false;
      for (var j = 1; j < ITEMS.length; j++) {
        var key = ITEMS[j].key;
        if (text.length > key.length + 60 || text.indexOf(key) === -1) continue;
        if (!checkedVisible && !visible(node)) break;
        checkedVisible = true;
        if (!result[j] || result[j].contains(node)) result[j] = node;
      }
      if (text.length > 40 || !MODEL.test(text) || node.closest(EXCLUDED_MODEL)) continue;
      if (!checkedVisible && !visible(node)) continue;
      var rect = node.getBoundingClientRect();
      if (rect.left < 0 || rect.right > window.innerWidth || rect.top < 0 || rect.top > 260) continue;
      if (!result[0] || result[0].contains(node) || rect.top < modelTop) {
        result[0] = node;
        modelTop = rect.top;
      }
    }
    return result;
  }

  function clickElement(el) {
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function (type) {
      var EventType = typeof PointerEvent === 'function' && type.indexOf('pointer') === 0
        ? PointerEvent : MouseEvent;
      el.dispatchEvent(new EventType(type, { bubbles: true, cancelable: true, view: window }));
    });
  }

  function hide() {
    if (menu) menu.style.display = 'none';
    if (fab) fab.setAttribute('aria-expanded', 'false');
    if (menuTimer !== null) { window.clearTimeout(menuTimer); menuTimer = null; }
  }

  // 菜单贴着 FAB 弹出：FAB 在右半屏菜单向左开，反之向右开；垂直优先在 FAB 上方
  function placeMenu() {
    var fr = fab.getBoundingClientRect();
    var mw = 160, mh = 12 + ITEMS.length * 42;
    var left = fr.right > window.innerWidth / 2 ? fr.right - mw : fr.left;
    var top = fr.top - mh - 10;
    if (top < 8) top = fr.bottom + 10;
    menu.style.left = Math.max(4, Math.min(window.innerWidth - mw - 4, left)) + 'px';
    menu.style.top = top + 'px';
    menu.style.right = 'auto';
    menu.style.bottom = 'auto';
  }

  // 恢复上次拖拽保存的 FAB 位置（localStorage 持久化）
  function applyFabPos() {
    try {
      var raw = localStorage.getItem('gcFabPos');
      if (raw) {
        var p = JSON.parse(raw);
        if (isFinite(p.x) && isFinite(p.y)) { fabX = p.x; fabY = p.y; }
      }
    } catch (e) { }
    if (fabX == null) return;
    fab.style.left = fabX + 'px';
    fab.style.top = fabY + 'px';
    fab.style.right = 'auto';
    fab.style.bottom = 'auto';
  }

  // FAB 可随意拖拽：位移超 12px 视为拖拽(不触发点击)，松开记忆位置；拖拽时收起菜单
  var dragState = null;
  function bindFabDrag() {
    if (typeof PointerEvent !== 'function') return;
    fab.addEventListener('pointerdown', function (e) {
      dragState = { sx: e.clientX, sy: e.clientY, ox: fab.offsetLeft, oy: fab.offsetTop, moved: false };
    });
    if (dragBound) return;
    dragBound = true;
    document.addEventListener('pointermove', function (e) {
      if (!dragState) return;
      var dx = e.clientX - dragState.sx, dy = e.clientY - dragState.sy;
      if (!dragState.moved && Math.abs(dx) + Math.abs(dy) > 12) dragState.moved = true;
      if (dragState.moved) {
        fabX = Math.max(4, Math.min(window.innerWidth - 52, dragState.ox + dx));
        fabY = Math.max(4, Math.min(window.innerHeight - 52, dragState.oy + dy));
        fab.style.left = fabX + 'px';
        fab.style.top = fabY + 'px';
        fab.style.right = 'auto';
        fab.style.bottom = 'auto';
        hide();
      }
    }, true);
    document.addEventListener('pointerup', function () {
      if (!dragState) return;
      if (dragState.moved) {
        suppressClick = true;
        try { localStorage.setItem('gcFabPos', JSON.stringify({ x: fabX, y: fabY })); } catch (e) { }
      }
      dragState = null;
    }, true);
  }

  // 菜单展开后 4 秒无操作自动隐藏（点击菜单重置计时）
  function startMenuTimer() {
    if (menuTimer !== null) window.clearTimeout(menuTimer);
    menuTimer = window.setTimeout(hide, 4000);
  }

  function build() {
    if (fab) fab.remove();
    if (menu) menu.remove();
    rows = [];
    fab = mark(document.createElement('button'));
    fab.id = 'gcFab';
    fab.type = 'button';
    fab.textContent = '⚡';
    fab.setAttribute('aria-label', '快捷入口');
    fab.setAttribute('aria-expanded', 'false');
    fab.setAttribute('aria-controls', 'gcMenu');
    fab.style.cssText = 'position:fixed;right:16px;bottom:110px;width:48px;height:48px;'
      + 'border:0;border-radius:50%;background:rgba(31,111,235,.92);color:#fff;display:none;'
      + 'align-items:center;justify-content:center;font-size:22px;z-index:2147483000;'
      + 'box-shadow:0 4px 12px rgba(0,0,0,.25);cursor:pointer;user-select:none;touch-action:none;';
    menu = mark(document.createElement('div'));
    menu.id = 'gcMenu';
    menu.style.cssText = 'position:fixed;right:16px;bottom:168px;z-index:2147483000;display:none;'
      + 'background:#fff;border:1px solid #e5e7eb;border-radius:12px;'
      + 'box-shadow:0 6px 24px rgba(0,0,0,.15);padding:6px;min-width:150px;';
    fab.addEventListener('click', function (e) {
      e.stopPropagation();
      if (suppressClick) { suppressClick = false; return; }
      var opening = menu.style.display !== 'block';
      if (opening) { placeMenu(); menu.style.display = 'block'; startMenuTimer(); }
      else hide();
      fab.setAttribute('aria-expanded', String(opening));
    });
    menu.addEventListener('pointerdown', startMenuTimer);
    ITEMS.forEach(function (item, index) {
      var row = mark(document.createElement('button'));
      row.type = 'button';
      row.textContent = item.icon + '  ' + (item.label || item.key);
      row.style.cssText = 'display:block;width:100%;border:0;background:#fff;text-align:left;'
        + 'padding:10px 14px;border-radius:8px;font-size:14px;color:#1f2937;cursor:pointer;';
      row.addEventListener('click', function (event) {
        event.stopPropagation();
        // 点击时刷新目标，以应对框架替换节点和只改 CSS 的路由切换。
        targets = scanTargets();
        hide();
        if (targets[index]) clickElement(targets[index]);
        schedule();
      });
      rows.push(row);
      menu.appendChild(row);
    });
    document.body.appendChild(fab);
    document.body.appendChild(menu);
    bindFabDrag();
    applyFabPos();
  }

  function applyLightTheme() {
    if (document.getElementById('gc-light')) return;
    var style = mark(document.createElement('style'));
    style.id = 'gc-light';
    style.textContent = 'html,body,#app,[class*="n-config-provider"],'
      + '[class*="n-"]:not([data-gc-ui]),div:not([data-gc-ui]),section:not([data-gc-ui]),'
      + 'li:not([data-gc-ui]),header:not([data-gc-ui]),main:not([data-gc-ui]),article:not([data-gc-ui])'
      + '{background-color:#fff !important;color:#1f1f1f !important}'
      + 'input,textarea,[contenteditable="true"]{background:#fff !important;color:#111 !important;'
      + 'border:1px solid #d0d0d0 !important}'
      + 'button:not([data-gc-ui]),[role="button"]:not([data-gc-ui])'
      + '{background-color:#fff !important;color:#1f1f1f !important}'
      + 'a,span,p,h1,h2,h3,h4,h5,h6{color:#1f1f1f !important}';
    (document.head || document.documentElement).appendChild(style);
  }

  function refresh() {
    timer = null;
    if (suspended || document.hidden || !document.body) return;
    lastScan = Date.now();
    applyLightTheme();
    targets = scanTargets();
    var available = targets.some(Boolean);
    if (!available && (!fab || !document.body.contains(fab))) return;
    if (!fab || !menu || !document.body.contains(fab) || !document.body.contains(menu)) build();
    fab.style.display = available ? 'flex' : 'none';
    rows.forEach(function (row, index) { row.style.display = targets[index] ? 'block' : 'none'; });
    if (!available) hide();
  }

  function schedule() {
    if (timer !== null || suspended || document.hidden) return;
    timer = window.setTimeout(refresh, Math.max(0, 1000 - (Date.now() - lastScan)));
  }

  function ownMutation(record) {
    if (own(record.target)) return true;
    if (record.type !== 'childList') return false;
    var changed = Array.prototype.slice.call(record.addedNodes)
      .concat(Array.prototype.slice.call(record.removedNodes));
    return changed.length > 0 && changed.every(own);
  }

  var observer = new MutationObserver(function (records) {
    if (records.some(function (record) { return !ownMutation(record); })) schedule();
  });

  function observe() {
    observer.observe(document.documentElement, {
      subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'aria-hidden']
    });
  }

  function readChunk(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result).split(',')[1]); };
      reader.onerror = function () { reject(new Error('图片读取失败')); };
      reader.readAsDataURL(blob);
    });
  }

  function sendBlob(blob, bridge) {
    if (!blob.size || blob.size > MAX_IMAGE_BYTES) return Promise.reject(new Error('图片超过 32 MiB 或为空'));
    var id = bridge.beginImage(bridgeToken, blob.size);
    if (!id) return Promise.reject(new Error('无法创建图片缓存'));
    var offset = 0;
    function next() {
      if (suspended) return Promise.reject(new Error('页面已离开'));
      if (offset >= blob.size) {
        if (!bridge.finishImage(bridgeToken, id)) throw new Error('图片打开失败');
        return;
      }
      return readChunk(blob.slice(offset, offset + CHUNK_BYTES)).then(function (encoded) {
        if (!bridge.appendImage(bridgeToken, id, encoded)) throw new Error('图片传输失败');
        offset += CHUNK_BYTES;
        return next();
      });
    }
    return Promise.resolve().then(next).catch(function (error) {
      bridge.cancelImage(bridgeToken, id);
      throw error;
    });
  }

  document.addEventListener('click', function (event) {
    var image = event.target;
    var bridge = window.GptCatBridge;
    if (!bridge || typeof bridge.openImage !== 'function' || !image) return;
    if (image.tagName !== 'IMG') {
      // 站点常在图片上盖透明覆盖层/工具条：target 不是 <img> 时，按点击坐标反查被覆盖的大图
      image = null;
      if (event.target.closest && event.target.closest('[data-gc-ui]')) return;
      var x = event.clientX, y = event.clientY;
      var all = document.querySelectorAll('img');
      for (var i = 0; i < all.length; i++) {
        var hit = all[i].getBoundingClientRect();
        if (hit.width < 160) continue;
        if (x >= hit.left && x <= hit.right && y >= hit.top && y <= hit.bottom) {
          image = all[i];
          break;
        }
      }
      if (!image) return;
    }
    if (image.closest('[data-gc-ui],[class*="avatar"],[class*="toolbar"],[class*="header"],[class*="sider"]')) return;
    if (image.naturalWidth < 200 && image.getBoundingClientRect().width < 160) return;
    var source = image.currentSrc || image.src;
    if (!source || imageBusy) return;
    if (/^https?:\/\//i.test(source)) {
      if (!bridge.openImage(bridgeToken, source)) return;
    } else if (/^(blob:|data:image\/)/i.test(source) && typeof bridge.beginImage === 'function') {
      imageBusy = true;
      // Blob/FileReader 不绘制 canvas，保留原始格式，避免生成超大的 PNG 字符串。
      fetch(source).then(function (response) {
        if (!response.ok) throw new Error('无法读取图片');
        return response.blob();
      }).then(function (blob) { return sendBlob(blob, bridge); }).catch(function (error) {
        if (!suspended) window.alert('图片打开失败：' + error.message);
      }).then(function () { imageBusy = false; });
    } else return;
    event.preventDefault();
    event.stopPropagation();
  }, true);

  document.addEventListener('click', function (event) { if (!own(event.target)) hide(); });
  document.addEventListener('keydown', function (event) { if (event.key === 'Escape') hide(); });
  window.addEventListener('resize', schedule);
  window.addEventListener('popstate', schedule);
  window.addEventListener('hashchange', schedule);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      hide();
    } else schedule();
  });
  window.addEventListener('pagehide', function () {
    suspended = true;
    observer.disconnect();
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
  });
  window.addEventListener('pageshow', function () {
    suspended = false;
    observe();
    schedule();
  });
  observe();
  refresh();
})('__GC_BRIDGE_TOKEN__');
