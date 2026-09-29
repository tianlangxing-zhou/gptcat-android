// GPTCat 移动端适配：低频变化驱动的快捷入口 + 分块传输图片。
(function (bridgeToken) {
  'use strict';
  if (window !== window.top || window.__gcInjected) return;
  window.__gcInjected = true;

  var ITEMS = [
    { key: 'GPT官方镜像', icon: '🪞' },
    { key: '香蕉 2 绘图', icon: '🍌' },
    { key: '深度研究', icon: '🔍' },
    { key: '思维导图', icon: '🧠' },
    { key: '返回首页', icon: '🏠' },
    { key: '升级套餐', icon: '⭐' }
  ];

  // 避免每次变化都遍历聊天正文里的所有 div/section/p。
  // 快捷入口通常位于可交互元素、导航或侧边栏中。
  var SELECTOR =
    'button,a,[role="button"],[role="menuitem"],[role="tab"],li,h3,h4,nav span,aside span,nav div,aside div';

  var MAX_IMAGE_BYTES = 32 * 1024 * 1024;
  var CHUNK_BYTES = 48 * 1024;

  var fab = null, menu = null, rows = [], targets = [];
  var timer = null, pendingSince = 0, idleToken = null;
  var suspended = false, imageBusy = false;
  var menuTimer = null, suppressClick = false, fabX = null, fabY = null, dragBound = false;
  var dockTimer = null, docked = false;

  function own(node) {
    var el = node && (node.nodeType === 1 ? node : node.parentElement);
    return !!(el && el.closest && el.closest('[data-gc-ui]'));
  }

  function mark(node) {
    node.setAttribute('data-gc-ui', '');
    return node;
  }

  function visible(node) {
    if (node.closest('[hidden],[aria-hidden="true"]')) return false;
    var rect = node.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    var style = window.getComputedStyle(node);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  }

  function scanTargets() {
    var result = new Array(ITEMS.length);
    var remaining = ITEMS.length;
    var nodes = document.querySelectorAll(SELECTOR);

    for (var i = 0; i < nodes.length && remaining > 0; i++) {
      var node = nodes[i];
      if (own(node)) continue;

      var raw = node.textContent || '';
      if (!raw || raw.length > 100) continue;
      var text = raw.trim();
      if (!text) continue;

      var checkedVisible = false;
      for (var j = 0; j < ITEMS.length; j++) {
        if (result[j]) continue;

        var key = ITEMS[j].key;
        if (text.length > key.length + 60 || text.indexOf(key) === -1) continue;

        if (!checkedVisible && !visible(node)) break;
        checkedVisible = true;
        result[j] = node;
        remaining--;
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
    if (menuTimer !== null) {
      window.clearTimeout(menuTimer);
      menuTimer = null;
    }
    scheduleDock();
  }

  function placeMenu() {
    var fr = fab.getBoundingClientRect();
    var mw = 160, mh = 12 + ITEMS.length * 42;
    var left = fr.right > window.innerWidth / 2 ? fr.right - mw : fr.left;
    var top = fr.top - mh - 10;
    if (top < 8) top = fr.bottom + 10;

    menu.style.left = Math.max(4, Math.min(window.innerWidth - mw - 4, left)) + 'px';
    menu.style.top = Math.max(8, top) + 'px';
    menu.style.right = 'auto';
    menu.style.bottom = 'auto';
  }

  function applyFabPos() {
    try {
      var raw = localStorage.getItem('gcFabPos');
      if (raw) {
        var p = JSON.parse(raw);
        if (isFinite(p.x) && isFinite(p.y)) {
          fabX = p.x;
          fabY = p.y;
        }
      }
    } catch (e) { }

    if (fabX == null) return;
    fabX = Math.max(4, Math.min(window.innerWidth - 52, fabX));
    fabY = Math.max(4, Math.min(window.innerHeight - 52, fabY));
    fab.style.left = fabX + 'px';
    fab.style.top = fabY + 'px';
    fab.style.right = 'auto';
    fab.style.bottom = 'auto';
  }

  var dragState = null;

  function bindFabDrag() {
    if (typeof PointerEvent !== 'function') return;

    fab.addEventListener('pointerdown', function (e) {
      cancelDock();
      dragState = {
        sx: e.clientX,
        sy: e.clientY,
        ox: fab.offsetLeft,
        oy: fab.offsetTop,
        moved: false
      };
    });

    if (dragBound) return;
    dragBound = true;

    document.addEventListener('pointermove', function (e) {
      if (!dragState) return;

      var dx = e.clientX - dragState.sx;
      var dy = e.clientY - dragState.sy;
      if (!dragState.moved && Math.abs(dx) + Math.abs(dy) > 12) {
        dragState.moved = true;
      }

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
        try {
          localStorage.setItem('gcFabPos', JSON.stringify({ x: fabX, y: fabY }));
        } catch (e) { }
      }

      dragState = null;
      scheduleDock();
    }, true);
  }

  function startMenuTimer() {
    if (menuTimer !== null) window.clearTimeout(menuTimer);
    menuTimer = window.setTimeout(hide, 4000);
  }

  function dockSide() {
    if (!fab || fab.style.display === 'none') return;
    if (menu && menu.style.display === 'block') return;

    var cx = fabX != null ? fabX : fab.offsetLeft;
    docked = true;
    fab.style.transition = 'transform .25s ease';
    fab.style.transform =
      'translateX(' + (cx < window.innerWidth / 2 ? -30 : 30) + 'px)';
  }

  function undock() {
    if (!docked) return;
    docked = false;
    fab.style.transform = '';
  }

  function scheduleDock() {
    if (dockTimer !== null) window.clearTimeout(dockTimer);
    dockTimer = window.setTimeout(function () {
      dockTimer = null;
      if (!suspended && !document.hidden && fab && menu
          && menu.style.display !== 'block') {
        dockSide();
      }
    }, 3000);
  }

  function cancelDock() {
    if (dockTimer !== null) {
      window.clearTimeout(dockTimer);
      dockTimer = null;
    }
    undock();
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
    fab.style.cssText =
      'position:fixed;right:16px;bottom:110px;width:48px;height:48px;' +
      'border:0;border-radius:50%;background:rgba(31,111,235,.92);color:#fff;display:none;' +
      'align-items:center;justify-content:center;font-size:22px;z-index:2147483000;' +
      'box-shadow:0 4px 12px rgba(0,0,0,.25);cursor:pointer;user-select:none;touch-action:none;';

    menu = mark(document.createElement('div'));
    menu.id = 'gcMenu';
    menu.style.cssText =
      'position:fixed;right:16px;bottom:168px;z-index:2147483000;display:none;' +
      'background:#fff;border:1px solid #e5e7eb;border-radius:12px;' +
      'box-shadow:0 6px 24px rgba(0,0,0,.15);padding:6px;min-width:150px;';

    fab.addEventListener('click', function (e) {
      e.stopPropagation();
      if (suppressClick) {
        suppressClick = false;
        return;
      }

      cancelDock();
      var opening = menu.style.display !== 'block';
      if (opening) {
        placeMenu();
        menu.style.display = 'block';
        startMenuTimer();
      } else {
        hide();
      }
      fab.setAttribute('aria-expanded', String(opening));
    });

    menu.addEventListener('pointerdown', startMenuTimer);

    ITEMS.forEach(function (item, index) {
      var row = mark(document.createElement('button'));
      row.type = 'button';
      row.textContent = item.icon + '  ' + (item.label || item.key);
      row.style.cssText =
        'display:block;width:100%;border:0;background:#fff;text-align:left;' +
        'padding:10px 14px;border-radius:8px;font-size:14px;color:#1f2937;cursor:pointer;';

      row.addEventListener('click', function (event) {
        event.stopPropagation();
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

  // 只给页面根部和输入区域提供浅色兜底，不再强制重写所有 div/li/button 的样式。
  function applyLightTheme() {
    if (document.getElementById('gc-light')) return;

    var style = mark(document.createElement('style'));
    style.id = 'gc-light';
    style.textContent =
      'html,body,#app{background-color:#fff;color:#1f1f1f;color-scheme:light}' +
      'input,textarea,[contenteditable="true"]{color:#111}' +
      '[data-gc-ui]{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}';
    (document.head || document.documentElement).appendChild(style);
  }

  function refresh() {
    timer = null;
    idleToken = null;
    pendingSince = 0;

    if (suspended || document.hidden || !document.body) return;

    applyLightTheme();
    targets = scanTargets();

    var available = targets.some(Boolean);
    if (!available && (!fab || !document.body.contains(fab))) return;

    if (!fab || !menu || !document.body.contains(fab) || !document.body.contains(menu)) {
      build();
    }

    fab.style.display = available ? 'flex' : 'none';
    rows.forEach(function (row, index) {
      row.style.display = targets[index] ? 'block' : 'none';
    });

    if (!available) hide();
  }

  function runRefreshWhenIdle() {
    timer = null;
    if (suspended || document.hidden) return;

    if (typeof window.requestIdleCallback === 'function') {
      idleToken = window.requestIdleCallback(refresh, { timeout: 300 });
    } else {
      refresh();
    }
  }

  // 变化后 700ms 安静期再扫描；若页面持续变化，最多约 2 秒也会刷新一次。
  function schedule() {
    if (suspended || document.hidden) return;

    var now = Date.now();
    if (!pendingSince) pendingSince = now;

    if (timer !== null) window.clearTimeout(timer);

    var elapsed = now - pendingSince;
    var delay = elapsed >= 2000 ? 0 : Math.min(700, 2000 - elapsed);
    timer = window.setTimeout(runRefreshWhenIdle, delay);
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
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      // 去掉 style：动画/过渡常频繁修改 style，容易造成无意义扫描。
      attributeFilter: ['class', 'hidden', 'aria-hidden']
    });
  }

  function readChunk(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        resolve(String(reader.result).split(',')[1]);
      };
      reader.onerror = function () {
        reject(new Error('图片读取失败'));
      };
      reader.readAsDataURL(blob);
    });
  }

  function sendBlob(blob, bridge) {
    if (!blob.size || blob.size > MAX_IMAGE_BYTES) {
      return Promise.reject(new Error('图片超过 32 MiB 或为空'));
    }

    var id = bridge.beginImage(bridgeToken, blob.size);
    if (!id) return Promise.reject(new Error('无法创建图片缓存'));

    var offset = 0;

    function next() {
      if (suspended) return Promise.reject(new Error('页面已离开'));

      if (offset >= blob.size) {
        if (!bridge.finishImage(bridgeToken, id)) {
          throw new Error('图片打开失败');
        }
        return;
      }

      return readChunk(blob.slice(offset, offset + CHUNK_BYTES))
        .then(function (encoded) {
          if (!bridge.appendImage(bridgeToken, id, encoded)) {
            throw new Error('图片传输失败');
          }
          offset += CHUNK_BYTES;
          return next();
        });
    }

    return Promise.resolve().then(next).catch(function (error) {
      bridge.cancelImage(bridgeToken, id);
      throw error;
    });
  }

  function imageAtPoint(x, y) {
    if (typeof document.elementsFromPoint !== 'function') return null;

    var stack = document.elementsFromPoint(x, y);
    for (var i = 0; i < stack.length; i++) {
      if (stack[i] && stack[i].tagName === 'IMG') return stack[i];
    }
    return null;
  }

  document.addEventListener('click', function (event) {
    var image = event.target;
    var bridge = window.GptCatBridge;

    if (!bridge || typeof bridge.openImage !== 'function' || !image) return;
    if (image.closest && image.closest('[data-gc-ui]')) return;

    if (image.tagName !== 'IMG') {
      // 只检查点击坐标下的元素栈，不再遍历页面所有图片并逐个计算布局。
      image = imageAtPoint(event.clientX, event.clientY);
      if (!image) return;
    }

    if (image.closest('[data-gc-ui],[class*="avatar"]')) return;

    var rect = image.getBoundingClientRect();
    if (image.naturalWidth < 200 && rect.width < 160) return;

    var source = image.currentSrc || image.src;
    if (!source || imageBusy) return;

    if (/^https?:\/\//i.test(source)) {
      if (!bridge.openImage(bridgeToken, source)) return;
    } else if (/^(blob:|data:image\/)/i.test(source)
        && typeof bridge.beginImage === 'function') {
      imageBusy = true;

      fetch(source)
        .then(function (response) {
          if (!response.ok) throw new Error('无法读取图片');
          return response.blob();
        })
        .then(function (blob) {
          return sendBlob(blob, bridge);
        })
        .catch(function (error) {
          if (!suspended) window.alert('图片打开失败：' + error.message);
        })
        .then(function () {
          imageBusy = false;
        });
    } else {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
  }, true);

  document.addEventListener('click', function (event) {
    if (!own(event.target)) hide();
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') hide();
  });

  window.addEventListener('resize', function () {
    if (fabX != null) applyFabPos();
    schedule();
  });
  window.addEventListener('popstate', schedule);
  window.addEventListener('hashchange', schedule);

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      pendingSince = 0;
      hide();
    } else {
      schedule();
    }
  });

  window.addEventListener('pagehide', function () {
    suspended = true;
    observer.disconnect();

    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    pendingSince = 0;

    if (idleToken !== null && typeof window.cancelIdleCallback === 'function') {
      window.cancelIdleCallback(idleToken);
    }
    idleToken = null;
  });

  window.addEventListener('pageshow', function () {
    suspended = false;
    observe();
    schedule();
  });

  observe();
  refresh();
})('__GC_BRIDGE_TOKEN__');
