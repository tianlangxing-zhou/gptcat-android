// GPTCat 手机/平板适配：低频 DOM 增强、图片桥、输入法自动聚焦门控。
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
    { key: '升级套餐', icon: '⭐' },
    { key: '下载任务', icon: '⬇️', action: 'downloads' },
    { key: '图片缓存', icon: '🧹', action: 'cache' },
    { key: '深色模式', icon: '🌙', action: 'theme' }
  ];

  // 避免扫描聊天正文中的所有 div/section/p；入口通常只存在于交互区或导航区。
  var SELECTOR =
    'button,a,[role="button"],[role="menuitem"],[role="tab"],li,h3,h4,nav span,aside span,nav div,aside div';

  var EDITABLE_SELECTOR =
    'input:not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]),'
    + 'textarea,[contenteditable="true"],[role="textbox"]';

  var MAX_IMAGE_BYTES = 32 * 1024 * 1024;
  var CHUNK_BYTES = 48 * 1024;

  var fab = null;
  var menu = null;
  var rows = [];
  var targets = [];

  var timer = null;
  var pendingSince = 0;
  var idleToken = null;
  var suspended = false;
  var imageBusy = false;

  var menuTimer = null;
  var suppressClick = false;
  var fabX = null;
  var fabY = null;
  var dragBound = false;
  var dragState = null;

  var dockTimer = null;
  var docked = false;

  // 下载任务 / 设置面板与深浅色
  var panel = null;
  var panelKind = '';
  var tasksTimer = null;
  var tasks = [];
  var localTasks = [];
  var THEME_KEY = 'gcTheme';

  // 只有用户真实点到可编辑控件，才给后续 focus 一个很短的许可窗口。
  var keyboardArmedUntil = 0;
  var keyboardArmedTarget = null;

  function own(node) {
    var el = node && (node.nodeType === 1 ? node : node.parentElement);
    return !!(el && el.closest && el.closest('[data-gc-ui]'));
  }

  function mark(node) {
    node.setAttribute('data-gc-ui', '');
    return node;
  }

  function viewportWidth() {
    return window.visualViewport
      ? Math.max(1, window.visualViewport.width)
      : Math.max(1, window.innerWidth);
  }

  function viewportHeight() {
    return window.visualViewport
      ? Math.max(1, window.visualViewport.height)
      : Math.max(1, window.innerHeight);
  }

  function editable(node) {
    if (!node || node.nodeType !== 1) return null;

    if (node.matches && node.matches(EDITABLE_SELECTOR)) return node;
    return node.closest ? node.closest(EDITABLE_SELECTOR) : null;
  }

  function bridgeHideKeyboard() {
    var bridge = window.GptCatBridge;
    if (bridge && typeof bridge.hideKeyboard === 'function') {
      try {
        bridge.hideKeyboard(bridgeToken);
      } catch (e) { }
    }
  }

  function suppressKeyboard() {
    keyboardArmedUntil = 0;
    keyboardArmedTarget = null;

    var active = editable(document.activeElement);
    if (active && typeof active.blur === 'function') {
      try {
        active.blur();
      } catch (e) { }
    }

    bridgeHideKeyboard();
  }

  // 原生层在 page start / 历史路由 / resume 时会调用。
  window.__gcSuppressKeyboard = suppressKeyboard;

  function armKeyboardFromPointer(event) {
    var target = editable(event.target);
    if (!target) {
      keyboardArmedUntil = 0;
      keyboardArmedTarget = null;
      return;
    }

    keyboardArmedTarget = target;
    keyboardArmedUntil = Date.now() + 1800;
  }

  if (typeof PointerEvent === 'function') {
    document.addEventListener('pointerdown', armKeyboardFromPointer, true);
  } else {
    document.addEventListener('touchstart', armKeyboardFromPointer, true);
    document.addEventListener('mousedown', armKeyboardFromPointer, true);
  }

  document.addEventListener('focusin', function (event) {
    var target = editable(event.target);
    if (!target) return;

    var allowed =
      Date.now() <= keyboardArmedUntil
      && (keyboardArmedTarget === target
          || (keyboardArmedTarget
              && keyboardArmedTarget.contains
              && keyboardArmedTarget.contains(target))
          || (target.contains
              && keyboardArmedTarget
              && target.contains(keyboardArmedTarget)));

    if (allowed) {
      keyboardArmedUntil = 0;
      keyboardArmedTarget = null;
      return;
    }

    // 历史会话/SPA 恢复自动 focus：立即撤销，不允许它唤起输入法。
    window.setTimeout(function () {
      if (document.activeElement === target && typeof target.blur === 'function') {
        try {
          target.blur();
        } catch (e) { }
      }
      bridgeHideKeyboard();
    }, 0);
  }, true);

  function visible(node) {
    if (node.closest('[hidden],[aria-hidden="true"]')) return false;

    var rect = node.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;

    var style = window.getComputedStyle(node);
    return style.visibility !== 'hidden'
      && style.display !== 'none'
      && style.opacity !== '0';
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
      var EventType =
        typeof PointerEvent === 'function' && type.indexOf('pointer') === 0
          ? PointerEvent
          : MouseEvent;

      el.dispatchEvent(new EventType(type, {
        bubbles: true,
        cancelable: true,
        view: window
      }));
    });
  }

  function cancelMenuTimer() {
    if (menuTimer !== null) {
      window.clearTimeout(menuTimer);
      menuTimer = null;
    }
  }

  function hide() {
    if (menu) menu.style.display = 'none';
    if (fab) fab.setAttribute('aria-expanded', 'false');

    cancelMenuTimer();
    scheduleDock();
  }

  function placeMenu() {
    if (!fab || !menu) return;

    var fr = fab.getBoundingClientRect();
    var vw = viewportWidth();
    var vh = viewportHeight();

    var mw = vw >= 600 ? 196 : 160;
    var mh = Math.min(vh - 16, 12 + ITEMS.length * (vw >= 600 ? 48 : 42));

    var left = fr.right > vw / 2 ? fr.right - mw : fr.left;
    var top = fr.top - mh - 10;

    if (top < 8) top = fr.bottom + 10;

    menu.style.width = mw + 'px';
    menu.style.maxHeight = Math.max(120, vh - 16) + 'px';
    menu.style.overflowY = 'auto';
    menu.style.left = Math.max(4, Math.min(vw - mw - 4, left)) + 'px';
    menu.style.top = Math.max(8, Math.min(vh - 8, top)) + 'px';
    menu.style.right = 'auto';
    menu.style.bottom = 'auto';
  }

  function clampFabPosition() {
    if (fabX == null || fabY == null) return;

    var size = viewportWidth() >= 600 ? 54 : 48;
    fabX = Math.max(4, Math.min(viewportWidth() - size - 4, fabX));
    fabY = Math.max(4, Math.min(viewportHeight() - size - 4, fabY));

    fab.style.left = fabX + 'px';
    fab.style.top = fabY + 'px';
    fab.style.right = 'auto';
    fab.style.bottom = 'auto';
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

    clampFabPosition();
  }

  function bindFabDrag() {
    if (typeof PointerEvent !== 'function') return;

    fab.addEventListener('pointerdown', function (event) {
      cancelDock();

      dragState = {
        sx: event.clientX,
        sy: event.clientY,
        ox: fab.offsetLeft,
        oy: fab.offsetTop,
        moved: false
      };
    });

    if (dragBound) return;
    dragBound = true;

    document.addEventListener('pointermove', function (event) {
      if (!dragState) return;

      var dx = event.clientX - dragState.sx;
      var dy = event.clientY - dragState.sy;

      if (!dragState.moved && Math.abs(dx) + Math.abs(dy) > 12) {
        dragState.moved = true;
      }

      if (!dragState.moved) return;

      var size = viewportWidth() >= 600 ? 54 : 48;

      fabX = Math.max(
        4,
        Math.min(viewportWidth() - size - 4, dragState.ox + dx)
      );

      fabY = Math.max(
        4,
        Math.min(viewportHeight() - size - 4, dragState.oy + dy)
      );

      fab.style.left = fabX + 'px';
      fab.style.top = fabY + 'px';
      fab.style.right = 'auto';
      fab.style.bottom = 'auto';
      hide();
    }, true);

    document.addEventListener('pointerup', function () {
      if (!dragState) return;

      if (dragState.moved) {
        suppressClick = true;

        try {
          localStorage.setItem(
            'gcFabPos',
            JSON.stringify({ x: fabX, y: fabY })
          );
        } catch (e) { }
      }

      dragState = null;
      scheduleDock();
    }, true);
  }

  function startMenuTimer() {
    cancelMenuTimer();
    menuTimer = window.setTimeout(hide, 4000);
  }

  // 空闲后把闪电收进最近的侧边，只留一小截；点一下再展开。
  var DOCK_PEEK = 12;

  function dockSide() {
    if (!fab || fab.style.display === 'none') return;
    if (menu && menu.style.display === 'block') return;

    var vw = viewportWidth();
    var size = vw >= 600 ? 54 : 48;
    var center = (fabX != null ? fabX : fab.offsetLeft) + size / 2;
    var dir = center <= vw / 2 ? -1 : 1;

    docked = true;
    fab.style.transition = 'transform .24s ease, opacity .24s ease';
    fab.style.transform =
      'translateX(' + dir * (size - DOCK_PEEK) + 'px) scale(.9)';
    fab.style.opacity = '.62';
  }

  function undock() {
    if (!docked) return;

    docked = false;
    fab.style.transform = '';
    fab.style.opacity = '';
  }

  function scheduleDock() {
    if (dockTimer !== null) window.clearTimeout(dockTimer);

    dockTimer = window.setTimeout(function () {
      dockTimer = null;

      if (!suspended
          && !document.hidden
          && fab
          && menu
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
      'position:fixed;right:16px;bottom:110px;width:48px;height:48px;'
      + 'border:0;border-radius:50%;background:var(--gc-accent,#1f6feb);color:#fff;display:none;'
      + 'align-items:center;justify-content:center;font-size:22px;z-index:2147483000;'
      + 'box-shadow:0 4px 12px rgba(0,0,0,.25);cursor:pointer;user-select:none;touch-action:none;';

    menu = mark(document.createElement('div'));
    menu.id = 'gcMenu';
    menu.style.cssText =
      'position:fixed;right:16px;bottom:168px;z-index:2147483000;display:none;'
      + 'background:var(--gc-bg,#fff);border:1px solid var(--gc-border,#e5e7eb);border-radius:12px;'
      + 'box-shadow:0 6px 24px rgba(0,0,0,.15);padding:6px;min-width:150px;'
      + 'box-sizing:border-box;overscroll-behavior:contain;';

    fab.addEventListener('click', function (event) {
      event.stopPropagation();

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
      row.className = 'gc-menu-row';
      row.textContent = item.icon + '  ' + (item.label || item.key);
      row.style.cssText =
        'display:block;width:100%;border:0;background:var(--gc-bg,#fff);text-align:left;'
        + 'padding:10px 14px;border-radius:8px;font-size:14px;'
        + 'color:var(--gc-fg,#1f2937);cursor:pointer;';

      row.addEventListener('click', function (event) {
        event.stopPropagation();

        if (item.action) {
          hide();
          runAction(item.action);
          return;
        }

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
    syncMenuLabels();
    scheduleDock();
  }

  // ---------------------------------------------------------------- 深色模式

  var LIGHT_CSS =
    ':root{--gc-bg:#fff;--gc-fg:#1f2937;--gc-muted:#6b7280;'
    + '--gc-border:#e5e7eb;--gc-accent:#1f6feb;--gc-card:#f8fafc}'
    + 'html,body,#app{background-color:#fff;color:#1f1f1f;color-scheme:light;'
    + '-webkit-text-size-adjust:100%;text-size-adjust:100%}'
    + 'input,textarea,[contenteditable="true"]{color:#111}';

  // 站点本身是浅色设计，用一次整体反色得到真正可读的深色，再把图片/视频反回来。
  var DARK_CSS =
    ':root{--gc-bg:#171b24;--gc-fg:#e6e8ee;--gc-muted:#9aa3b2;'
    + '--gc-border:#2a303c;--gc-accent:#5b8def;--gc-card:#1d2230}'
    + 'html{background:#10131a!important;'
    + '-webkit-filter:invert(.92) hue-rotate(180deg);filter:invert(.92) hue-rotate(180deg)}'
    + 'html,body,#app{background-color:#10131a;color:#e6e8ee;color-scheme:dark}'
    + 'img,video,picture,canvas,svg,iframe,[data-gc-ui],'
    + '[data-gc-ui] *{-webkit-filter:invert(1) hue-rotate(180deg);'
    + 'filter:invert(1) hue-rotate(180deg)}';

  function themeMode() {
    try {
      return localStorage.getItem(THEME_KEY) || 'auto';
    } catch (e) {
      return 'auto';
    }
  }

  function systemDark() {
    return typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function isDark() {
    var mode = themeMode();
    if (mode === 'dark') return true;
    if (mode === 'light') return false;
    return systemDark();
  }

  function themeLabel() {
    var mode = themeMode();
    return mode === 'dark' ? '深色' : (mode === 'light' ? '浅色' : '跟随系统');
  }

  function applyTheme(sync) {
    var dark = isDark();
    var style = document.getElementById('gc-theme');

    if (!style) {
      style = mark(document.createElement('style'));
      style.id = 'gc-theme';
      (document.head || document.documentElement).appendChild(style);
    }

    var css = dark ? DARK_CSS : LIGHT_CSS;
    if (style.textContent !== css) style.textContent = css;

    var bridge = window.GptCatBridge;
    if (sync && bridge && typeof bridge.setTheme === 'function') {
      try {
        bridge.setTheme(bridgeToken, dark ? 'dark' : 'light');
      } catch (e) { }
    }

    if (rows.length) syncMenuLabels();
  }

  function toggleTheme() {
    var next = isDark() ? 'light' : 'dark';

    try {
      localStorage.setItem(THEME_KEY, next);
    } catch (e) { }

    applyTheme(true);
    setDownloadChip(next === 'dark' ? '已切换到深色模式' : '已切换到浅色模式', false);
    hideDownloadChipLater(2200);
  }

  function syncMenuLabels() {
    for (var i = 0; i < rows.length && i < ITEMS.length; i++) {
      var item = ITEMS[i];
      if (!item.action) continue;

      if (item.action === 'theme') {
        rows[i].textContent = item.icon + '  ' + item.key + '：' + themeLabel();
      } else {
        rows[i].textContent = item.icon + '  ' + item.key;
      }
    }
  }

  // 只为根页面和本插件 UI 提供浅色/自适应兜底，不覆写站点所有 div/button。
  function applyAdaptiveStyle() {
    if (document.getElementById('gc-adaptive')) return;

    var style = mark(document.createElement('style'));
    style.id = 'gc-adaptive';
    style.textContent =
      '[data-gc-ui]{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;'
      + '-webkit-tap-highlight-color:transparent}'
      + '@media (min-width:600px){'
      + '#gcFab{width:54px!important;height:54px!important;font-size:24px!important;'
      + 'right:24px!important;bottom:96px!important}'
      + '#gcMenu{border-radius:14px!important;padding:8px!important}'
      + '#gcMenu .gc-menu-row{font-size:15px!important;padding:12px 16px!important}'
      + '}'
      + '@media (orientation:landscape) and (max-height:520px){'
      + '#gcFab{bottom:28px!important}'
      + '#gcMenu .gc-menu-row{padding-top:8px!important;padding-bottom:8px!important}'
      + '}';

    (document.head || document.documentElement).appendChild(style);
  }

  function refresh() {
    timer = null;
    idleToken = null;
    pendingSince = 0;

    if (suspended || document.hidden || !document.body) return;

    applyAdaptiveStyle();
    applyTheme(false);
    enhanceChatLayout();
    targets = scanTargets();

    if (!fab
        || !menu
        || !document.body.contains(fab)
        || !document.body.contains(menu)) {
      build();
    }

    // 闪电常驻：下载任务/图片缓存/深色模式属于本地功能，不依赖站点按钮。
    fab.style.display = 'flex';

    rows.forEach(function (row, index) {
      // 本地功能项始终可用；页面入口项跟着页面按钮出现或消失。
      row.style.display =
        ITEMS[index].action || targets[index] ? 'block' : 'none';
    });

    if (!targets.some(Boolean) && !tasks.length) hide();
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

  // DOM 连续更新时合并扫描；流式回答最长约 2 秒才强制刷新一次。
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
    if (records.some(function (record) {
      return !ownMutation(record);
    })) {
      schedule();
    }
  });

  function observe() {
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      // 动画/过渡会高频改 style，因此不监听 style。
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
    if (!id) {
      return Promise.reject(new Error('无法创建图片缓存'));
    }

    var offset = 0;

    function next() {
      if (suspended) {
        return Promise.reject(new Error('页面已离开'));
      }

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

    return Promise.resolve()
      .then(next)
      .catch(function (error) {
        bridge.cancelImage(bridgeToken, id);
        throw error;
      });
  }

  // 第七轮：图片命中不再“穿透”点击点寻找下层图片。
  // 旧版 elementsFromPoint() 会在模型切换菜单/按钮下面发现背景 IMG，
  // 从而误进入图片预览。现在只接受真实图片目标或明确的非交互图片容器。
  function isInteractiveUi(node) {
    if (!node || !node.closest) return false;

    return !!node.closest(
      'button,a,input,textarea,select,option,label,summary,'
      + '[role="button"],[role="menu"],[role="menuitem"],[role="listbox"],'
      + '[role="option"],[role="combobox"],[role="tab"],[role="dialog"],'
      + '[aria-haspopup],[aria-expanded],[contenteditable="true"],'
      + 'header,nav,[data-testid*="model"],[data-testid*="selector"],'
      + '[data-testid*="menu"],[class*="model-selector"],[class*="modelPicker"],'
      + '[class*="model-picker"],[class*="dropdown"],[class*="popover"]'
    );
  }


  // 第八轮：输入区/文本选择专用保护。
  // 即使 composer 或输入框容器本身带背景图，也不能因为选择文字而触发图片预览。
  function isEditingSurface(node) {
    if (!node || !node.closest) return false;

    return !!node.closest(
      'input,textarea,select,option,[contenteditable="true"],[role="textbox"],'
      + 'form,[data-testid*="composer"],[data-testid*="chat-input"],'
      + '[data-testid*="prompt"],[class*="composer"],[class*="chat-input"],'
      + '[class*="prompt"],[class*="input-area"],[class*="input-container"]'
    );
  }

  function hasActiveTextSelection() {
    try {
      var selection = window.getSelection ? window.getSelection() : null;
      return !!(selection && !selection.isCollapsed && String(selection).length > 0);
    } catch (e) {
      return false;
    }
  }

  function imageFromActualTarget(target, x, y) {
    if (!target || target.nodeType !== 1) return null;

    if (isEditingSurface(target)) return null;

    if (target.tagName === 'IMG') return target;

    if (isInteractiveUi(target)) return null;

    var container = target.closest
      ? target.closest('picture,figure,[data-image],[data-testid*="image"]')
      : null;

    if (!container || isInteractiveUi(container)) return null;

    var candidates = container.querySelectorAll('img');
    for (var i = 0; i < candidates.length && i < 6; i++) {
      var image = candidates[i];
      var rect = image.getBoundingClientRect();

      if (rect.width <= 0 || rect.height <= 0) continue;
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
        return image;
      }
    }

    return null;
  }


  // 第六轮：系统下载 + 网页内轻量进度提示。
  var activeDownloads = Object.create(null);

  function downloadChip() {
    var chip = document.getElementById('gcDownloadChip');
    if (chip) return chip;

    chip = mark(document.createElement('button'));
    chip.id = 'gcDownloadChip';
    chip.type = 'button';
    chip.style.cssText =
      'position:fixed;right:14px;bottom:calc(78px + env(safe-area-inset-bottom));'
      + 'max-width:min(360px,calc(100vw - 28px));display:none;z-index:2147483100;'
      + 'border:0;border-radius:12px;padding:10px 14px;background:rgba(17,24,39,.94);'
      + 'color:#fff;font-size:13px;line-height:1.35;text-align:left;'
      + 'box-shadow:0 4px 18px rgba(0,0,0,.24);cursor:pointer;';

    document.body.appendChild(chip);
    return chip;
  }

  function setDownloadChip(text, clickable) {
    var chip = downloadChip();
    chip.textContent = text;
    chip.style.display = 'block';
    chip.style.cursor = clickable ? 'pointer' : 'default';

    if (!clickable) chip.onclick = null;
  }

  function hideDownloadChipLater(delay) {
    window.setTimeout(function () {
      var chip = document.getElementById('gcDownloadChip');
      if (chip) chip.style.display = 'none';
    }, delay || 3000);
  }

  function formatBytes(value) {
    var bytes = Number(value);
    if (!isFinite(bytes) || bytes < 0) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) {
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }
    return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
  }

  // ------------------------------------------------------------- 面板

  function panelButton(label, handler) {
    var button = mark(document.createElement('button'));
    button.type = 'button';
    button.textContent = label;
    button.style.cssText =
      'border:1px solid var(--gc-border,#e5e7eb);background:var(--gc-card,#f8fafc);'
      + 'color:var(--gc-accent,#1f6feb);border-radius:8px;padding:7px 12px;'
      + 'font-size:13px;cursor:pointer;';

    button.addEventListener('click', function (event) {
      event.stopPropagation();
      handler();
    });

    return button;
  }

  function panelEl() {
    if (panel) return panel;

    panel = mark(document.createElement('div'));
    panel.id = 'gcPanel';
    panel.style.cssText =
      'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);'
      + 'width:min(420px,calc(100vw - 32px));max-height:72vh;overflow:auto;display:none;'
      + 'background:var(--gc-bg,#fff);color:var(--gc-fg,#1f2937);'
      + 'border:1px solid var(--gc-border,#e5e7eb);border-radius:14px;'
      + 'box-shadow:0 12px 40px rgba(0,0,0,.28);z-index:2147483200;padding:14px;'
      + 'box-sizing:border-box;font-size:14px;overscroll-behavior:contain;';

    var header = mark(document.createElement('div'));
    header.style.cssText =
      'display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;';

    var title = mark(document.createElement('div'));
    title.id = 'gcPanelTitle';
    title.style.cssText = 'font-weight:600;font-size:15px;';

    var close = mark(document.createElement('button'));
    close.type = 'button';
    close.textContent = '✕';
    close.style.cssText =
      'border:0;background:transparent;color:var(--gc-muted,#6b7280);'
      + 'font-size:16px;cursor:pointer;padding:4px 8px;';

    close.addEventListener('click', function (event) {
      event.stopPropagation();
      closePanel();
    });

    header.appendChild(title);
    header.appendChild(close);

    var body = mark(document.createElement('div'));
    body.id = 'gcPanelBody';

    panel.appendChild(header);
    panel.appendChild(body);
    document.body.appendChild(panel);

    return panel;
  }

  function panelBody() {
    return document.getElementById('gcPanelBody');
  }

  function openPanel(kind) {
    panelEl();
    panelKind = kind;

    panel.style.display = 'block';
    document.getElementById('gcPanelTitle').textContent =
      kind === 'downloads' ? '下载任务' : '图片缓存';

    // 面板打开时把闪电展开，避免它缩在侧边看不见。
    cancelDock();

    if (kind === 'downloads') {
      refreshTasks();
    } else {
      renderCache('');
    }
  }

  function closePanel() {
    panelKind = '';

    if (panel) panel.style.display = 'none';
    if (tasksTimer !== null) {
      window.clearTimeout(tasksTimer);
      tasksTimer = null;
    }

    if (tasks.length) schedule();
    scheduleDock();
  }

  function runAction(action) {
    if (action === 'theme') {
      toggleTheme();
      return;
    }

    openPanel(action === 'downloads' ? 'downloads' : 'cache');
  }

  function refreshTasks() {
    var bridge = window.GptCatBridge;

    if (bridge && typeof bridge.listDownloads === 'function') {
      var items = null;

      try {
        items = JSON.parse(String(bridge.listDownloads(bridgeToken) || '[]'));
      } catch (e) {
        items = null;
      }

      if (items && items.length) {
        for (var i = 0; i < items.length; i++) {
          var item = items[i];
          if (!item || !item.id) continue;

          if (findTask(item.id)) {
            updateTask(item.id, item);
          } else {
            addTask(item);
          }
        }
      }
    }

    renderTasks();

    if (panelKind === 'downloads') {
      tasksTimer = window.setTimeout(refreshTasks, 1500);
    }
  }

  function renderTasks() {
    if (!panel || panelKind !== 'downloads') return;

    var body = panelBody();
    if (!body) return;

    body.textContent = '';

    if (!tasks.length) {
      var empty = mark(document.createElement('div'));
      empty.textContent = '暂无下载任务';
      empty.style.cssText = 'color:var(--gc-muted,#6b7280);padding:12px 2px;';
      body.appendChild(empty);
      return;
    }

    tasks.forEach(function (task) {
      var row = mark(document.createElement('div'));
      row.style.cssText =
        'border:1px solid var(--gc-border,#e5e7eb);border-radius:10px;'
        + 'padding:10px;margin-bottom:8px;';

      var head = mark(document.createElement('div'));
      head.style.cssText = 'display:flex;justify-content:space-between;gap:8px;';

      var name = mark(document.createElement('span'));
      name.textContent = task.name || '下载文件';
      name.style.cssText = 'font-weight:600;word-break:break-all;';

      var status = mark(document.createElement('span'));
      status.textContent = statusText(task.status)
        + (task.percent >= 0 ? ' ' + Math.round(task.percent) + '%' : '');
      status.style.cssText =
        'color:var(--gc-muted,#6b7280);white-space:nowrap;font-size:12px;';

      head.appendChild(name);
      head.appendChild(status);

      var track = mark(document.createElement('div'));
      track.style.cssText =
        'height:5px;border-radius:3px;background:var(--gc-border,#eceff3);'
        + 'margin:8px 0;overflow:hidden;';

      var fill = mark(document.createElement('div'));
      var percent = task.status === 'success'
        ? 100
        : Math.max(0, Math.min(100, task.percent >= 0 ? task.percent : 0));
      fill.style.cssText = 'height:100%;width:' + percent + '%;background:'
        + (task.status === 'failed' ? '#ef4444' : 'var(--gc-accent,#1f6feb)') + ';';

      track.appendChild(fill);

      var actions = mark(document.createElement('div'));
      actions.style.cssText = 'display:flex;gap:8px;align-items:center;';

      var size = mark(document.createElement('span'));
      size.textContent = task.total > 0
        ? formatBytes(task.downloaded || 0) + ' / ' + formatBytes(task.total)
        : (task.downloaded > 0 ? formatBytes(task.downloaded) : '');
      size.style.cssText =
        'flex:1;color:var(--gc-muted,#9ca3af);font-size:12px;';

      actions.appendChild(size);

      if (task.status === 'success') {
        actions.appendChild(panelButton('打开', function () {
          openTask(task.id);
        }));
      }

      actions.appendChild(panelButton('移除', function () {
        removeTask(task.id);
      }));

      row.appendChild(head);
      row.appendChild(track);
      row.appendChild(actions);
      body.appendChild(row);
    });
  }

  function openTask(id) {
    var bridge = window.GptCatBridge;
    if (!bridge || typeof bridge.openDownloadedFile !== 'function') return;

    try {
      bridge.openDownloadedFile(bridgeToken, id);
    } catch (e) { }
  }

  function removeTask(id) {
    var bridge = window.GptCatBridge;

    if (bridge && typeof bridge.removeDownload === 'function') {
      try {
        bridge.removeDownload(bridgeToken, id);
      } catch (e) { }
    }

    for (var i = 0; i < tasks.length; i++) {
      if (tasks[i].id === id) {
        tasks.splice(i, 1);
        break;
      }
    }

    renderTasks();
  }

  function renderCache(message) {
    var body = panelBody();
    if (!body) return;

    body.textContent = '';

    var stats = { images: 0, imageBytes: 0, webBytes: 0 };
    var bridge = window.GptCatBridge;

    if (bridge && typeof bridge.cacheStats === 'function') {
      try {
        stats = JSON.parse(String(bridge.cacheStats(bridgeToken) || '{}')) || stats;
      } catch (e) { }
    }

    function line(label, value) {
      var row = mark(document.createElement('div'));
      row.style.cssText = 'display:flex;justify-content:space-between;padding:4px 0;';

      var left = mark(document.createElement('span'));
      left.textContent = label;
      left.style.cssText = 'color:var(--gc-muted,#6b7280);';

      var right = mark(document.createElement('span'));
      right.textContent = value;

      row.appendChild(left);
      row.appendChild(right);
      body.appendChild(row);
    }

    line('图片缓存文件', stats.images + ' 个');
    line('图片缓存占用', formatBytes(stats.imageBytes) || '0 B');
    line('网页缓存占用', formatBytes(stats.webBytes) || '0 B');

    var actions = mark(document.createElement('div'));
    actions.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;';

    actions.appendChild(panelButton('清理图片缓存', function () {
      clearCache('images');
    }));
    actions.appendChild(panelButton('清理网页缓存', function () {
      clearCache('web');
    }));
    actions.appendChild(panelButton('全部清理', function () {
      clearCache('all');
    }));

    body.appendChild(actions);

    var result = mark(document.createElement('div'));
    result.id = 'gcPanelResult';
    result.textContent = message || '';
    result.style.cssText =
      'color:var(--gc-accent,#1f6feb);margin-top:10px;min-height:18px;font-size:13px;';

    body.appendChild(result);

    var note = mark(document.createElement('div'));
    note.textContent = '清理网页缓存不会退出登录';
    note.style.cssText =
      'color:var(--gc-muted,#9ca3af);margin-top:8px;font-size:12px;';

    body.appendChild(note);
  }

  function clearCache(kind) {
    var bridge = window.GptCatBridge;
    if (!bridge || typeof bridge.clearCache !== 'function') {
      renderCache('当前版本不支持清理');
      return;
    }

    var freed = 0;
    var web = false;

    try {
      var parsed = JSON.parse(String(bridge.clearCache(bridgeToken, kind) || '{}')) || {};
      freed = Number(parsed.images) || 0;
      web = !!parsed.web;
    } catch (e) { }

    renderCache('已清理 ' + (formatBytes(freed) || '0 B')
      + (web ? '，网页缓存已清空' : ''));
  }

  // ------------------------------------------------------------- 下载任务

  var MAX_FILE_BYTES = 512 * 1024 * 1024;

  function statusText(status) {
    if (status === 'success') return '已完成';
    if (status === 'failed') return '失败';
    if (status === 'paused') return '已暂停';
    if (status === 'pending') return '等待中';
    if (status === 'running') return '下载中';
    return '处理中';
  }

  function addTask(task) {
    for (var i = 0; i < tasks.length; i++) {
      if (tasks[i].id === task.id) {
        tasks[i] = mergeTask(tasks[i], task);
        renderTasks();
        return;
      }
    }

    tasks.unshift(task);
    if (tasks.length > 20) tasks.length = 20;
    renderTasks();
    schedule();
  }

  function mergeTask(base, patch) {
    var merged = {};

    for (var key in base) {
      if (Object.prototype.hasOwnProperty.call(base, key)) merged[key] = base[key];
    }
    for (var name in patch) {
      if (Object.prototype.hasOwnProperty.call(patch, name)) merged[name] = patch[name];
    }

    return merged;
  }

  function updateTask(id, patch) {
    for (var i = 0; i < tasks.length; i++) {
      if (tasks[i].id !== id) continue;

      tasks[i] = mergeTask(tasks[i], patch);
      renderTasks();
      return;
    }
  }

  function findTask(id) {
    for (var i = 0; i < tasks.length; i++) {
      if (tasks[i].id === id) return tasks[i];
    }
    return null;
  }

  /** 单个系统任务的进度轮询：同时更新提示条与任务列表。 */
  function trackDownload(id, name) {
    var bridge = window.GptCatBridge;
    if (!bridge || typeof bridge.getDownloadProgress !== 'function') return;

    activeDownloads[id] = true;
    addTask({ id: id, name: name, status: 'pending', percent: -1, downloaded: 0, total: -1 });

    function poll() {
      if (!activeDownloads[id] || suspended) return;

      var raw = '';
      try {
        raw = String(bridge.getDownloadProgress(bridgeToken, id) || '');
      } catch (e) {
        raw = '';
      }

      var parts = raw.split('|');
      var status = parts[0] || 'unknown';
      var percent = Number(parts[1]);
      var downloaded = Number(parts[2]);
      var total = Number(parts[3]);

      if (status === 'success') {
        delete activeDownloads[id];
        updateTask(id, { status: 'success', percent: 100, downloaded: downloaded, total: total });
        setDownloadChip('下载完成：' + name + ' · 点击打开', true);

        var chip = downloadChip();
        chip.onclick = function () {
          try {
            bridge.openDownloadedFile(bridgeToken, id);
          } catch (e) { }
        };

        hideDownloadChipLater(8000);
        schedule();
        return;
      }

      if (status === 'failed') {
        delete activeDownloads[id];
        updateTask(id, { status: 'failed' });
        setDownloadChip('下载失败：' + name, false);
        hideDownloadChipLater(4500);
        return;
      }

      if (status === 'unknown') {
        // DownloadManager 刚入队时偶尔短暂查不到，容忍几轮。
        var misses = (trackDownload._misses || 0) + 1;
        trackDownload._misses = misses;
        if (misses > 8) {
          delete activeDownloads[id];
          updateTask(id, { status: 'failed' });
          setDownloadChip('无法读取下载状态：' + name, false);
          hideDownloadChipLater(3500);
          return;
        }
      } else {
        trackDownload._misses = 0;
      }

      updateTask(id, {
        status: status,
        percent: percent,
        downloaded: downloaded,
        total: total
      });

      var detail = '';
      if (percent >= 0) {
        detail = Math.max(0, Math.min(100, percent)) + '%';
      } else if (downloaded > 0) {
        detail = formatBytes(downloaded);
      }

      setDownloadChip(
        (status === 'paused' ? '下载已暂停：' : '正在下载：')
          + name
          + (detail ? ' · ' + detail : ''),
        false);

      window.setTimeout(poll, 900);
    }

    poll();
  }

  /** 网页生成的 blob:/data: 文件：取回内容后分块落盘到「下载」。 */
  function blobDownload(url, name) {
    var bridge = window.GptCatBridge;
    var fileName = name || '佐助下载';

    if (!bridge || typeof bridge.beginFile !== 'function') {
      setDownloadChip('当前版本无法保存该文件：' + fileName, false);
      hideDownloadChipLater(4500);
      return;
    }

    var taskId = 'blob:' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    addTask({ id: taskId, name: fileName, status: 'running', percent: 0, downloaded: 0, total: -1 });
    setDownloadChip('正在准备文件：' + fileName, false);

    fetch(url)
      .then(function (response) {
        if (!response || !response.ok) {
          throw new Error('HTTP ' + (response ? response.status : '未知'));
        }
        return response.blob();
      })
      .then(function (blob) {
        if (!blob || !blob.size) throw new Error('文件为空');
        if (blob.size > MAX_FILE_BYTES) throw new Error('文件超过 512 MiB 限制');

        var id = bridge.beginFile(bridgeToken, fileName, blob.type || '', blob.size);
        if (!id) throw new Error('无法开始保存');

        var offset = 0;
        var chunks = Math.max(1, Math.ceil(blob.size / CHUNK_BYTES));

        function next() {
          if (suspended) throw new Error('页面已离开');

          if (offset >= blob.size) {
            var saved = bridge.finishFile(bridgeToken, id);
            if (!saved) throw new Error('保存失败');

            updateTask(taskId, {
              id: saved,
              name: fileName,
              status: 'success',
              percent: 100,
              downloaded: blob.size,
              total: blob.size
            });

            setDownloadChip('已保存到 下载/' + '佐助：' + fileName, false);
            hideDownloadChipLater(5000);
            schedule();
            return null;
          }

          var slice = blob.slice(offset, offset + CHUNK_BYTES);

          return readChunk(slice).then(function (encoded) {
            if (!bridge.appendFile(bridgeToken, id, encoded)) {
              bridge.cancelFile(bridgeToken, id);
              throw new Error('写入中断');
            }

            offset += CHUNK_BYTES;
            updateTask(taskId, {
              percent: Math.min(99, Math.round(offset * 100 / blob.size)),
              downloaded: Math.min(offset, blob.size),
              total: blob.size
            });

            return next();
          });
        }

        return Promise.resolve().then(next);
      })
      .catch(function (error) {
        updateTask(taskId, { status: 'failed' });
        setDownloadChip(
          '保存失败：' + fileName + '（' + (error && error.message ? error.message : '未知原因') + '）',
          false);
        hideDownloadChipLater(5000);
      });
  }

  window.__gcBlobDownload = function (url, mime) {
    var name = '佐助下载';

    try {
      var path = String(url).split('/').pop().split('?')[0];
      if (path && path.length <= 80) name = decodeURIComponent(path);
    } catch (e) { }

    if (mime) name = name + extensionOf(mime);

    blobDownload(url, name);
  };

  function extensionOf(mime) {
    if (/zip/i.test(mime)) return '.zip';
    if (/pdf/i.test(mime)) return '.pdf';
    if (/json/i.test(mime)) return '.json';
    if (/csv/i.test(mime)) return '.csv';
    if (/plain/i.test(mime)) return '.txt';
    if (/png/i.test(mime)) return '.png';
    if (/jpe?g/i.test(mime)) return '.jpg';
    return '';
  }

  /** 原生 DownloadListener 已接手 http(s) 下载时回调，补上提示与任务项。 */
  window.__gcOnNativeDownload = function (id, name) {
    if (!id) return;
    var task = findTask(id);
    if (task) return;

    addTask({ id: id, name: name || '下载文件', status: 'pending', percent: -1, downloaded: 0, total: -1 });
    setDownloadChip('开始下载：' + (name || '下载文件'), true);

    var chip = downloadChip();
    chip.onclick = function () {
      openPanel('downloads');
    };

    hideDownloadChipLater(4000);
    trackDownload(id, name || '下载文件');
  };

  window.__gcDownloadFailed = function (name) {
    setDownloadChip('下载未能开始：' + (name || '该文件') + '，可长按链接重试', false);
    hideDownloadChipLater(5000);
  };

  /** 判断元素文字是否明确表示下载动作。 */
  function downloadText(node) {
    if (!node) return false;

    var raw = (node.textContent || '').trim();
    if (!raw || raw.length > 30) return false;
    if (!/下载|导出|保存到本地|download|export/i.test(raw)) return false;

    return !/(下载任务|不限|下载量)/i.test(raw);
  }

  /** 非 a 元素：向上找一层带 href 的容器，找不到就交给原生兜底。 */
  function linkFrom(node) {
    if (!node || !node.closest) return null;

    var anchor = node.closest('a[href]');
    if (anchor) return anchor;

    var box = node.closest('button,[role="button"],li,div,span');
    if (!box) return null;

    return box.querySelector ? box.querySelector('a[href]') : null;
  }

  function fileNameFrom(anchor, href) {
    var named = '';

    if (anchor && anchor.getAttribute) {
      named = anchor.getAttribute('download') || '';
    }

    if (named) return named;

    try {
      named = decodeURIComponent(href.split('/').pop().split('?')[0].split('#')[0]);
    } catch (e) {
      named = '';
    }

    if (!named || named.length > 80 || named.indexOf('=') >= 0) {
      named = '佐助下载-' + Date.now() + extensionOf('');
    }

    return named;
  }

  document.addEventListener('click', function (event) {
    var bridge = window.GptCatBridge;
    var target = event.target;

    if (!target || !target.closest) return;
    if (own(target)) return;
    if (isEditingSurface(target)) return;

    var anchor = linkFrom(target);
    var href = anchor && anchor.href ? String(anchor.href) : '';
    var actionable = downloadText(anchor) || downloadText(target);

    if (!href) {
      // 没有可直接使用的链接：交回站点自身处理，原生 DownloadListener 会兜底。
      if (actionable) setDownloadChip('正在交给系统处理…', false);
      return;
    }

    if (!/^(https?:|blob:|data:)/i.test(href)) return;

    var marked = !!(anchor && anchor.hasAttribute && anchor.hasAttribute('download'));
    var fileLike =
      /\.(zip|7z|rar|pdf|doc|docx|xls|xlsx|ppt|pptx|csv|apk|png|jpg|jpeg|gif|webp|txt|md|json|mp3|wav|mp4)(\?|#|$)/i
        .test(href);

    if (!marked && !fileLike && !actionable) return;

    var downloadName = fileNameFrom(anchor, href);

    if (/^blob:|^data:/i.test(href)) {
      event.preventDefault();
      event.stopPropagation();
      blobDownload(href, downloadName);
      return;
    }

    if (!bridge || typeof bridge.downloadFile !== 'function') return;

    var id = '';
    try {
      id = String(bridge.downloadFile(bridgeToken, href, downloadName) || '');
    } catch (e) {
      id = '';
    }

    if (id === 'permission') {
      event.preventDefault();
      event.stopPropagation();
      setDownloadChip('请允许存储权限，然后再次点击下载', false);
      hideDownloadChipLater(4500);
      return;
    }

    if (/^\d+$/.test(id)) {
      event.preventDefault();
      event.stopPropagation();
      addTask({ id: id, name: downloadName, status: 'pending', percent: -1, downloaded: 0, total: -1 });
      setDownloadChip('开始下载：' + downloadName, true);

      var chip = downloadChip();
      chip.onclick = function () {
        openPanel('downloads');
      };

      hideDownloadChipLater(4000);
      trackDownload(id, downloadName);
      return;
    }

    // 直接入队失败：不拦截站点行为，让原生兜底并给出可见反馈。
    setDownloadChip('正在交给系统处理：' + downloadName, false);
    hideDownloadChipLater(4000);
  }, true);


  // 标记本次指针是否始于交互 UI / 输入区。
  // 输入区使用更长保护窗口，因为长按选字、拖动选择柄通常持续更久。
  var interactivePointerUntil = 0;
  var editingPointerUntil = 0;

  function markInteractivePointer(event) {
    if (isEditingSurface(event.target)) {
      editingPointerUntil = Date.now() + 2200;
      interactivePointerUntil = Math.max(interactivePointerUntil, Date.now() + 900);
      return;
    }

    if (isInteractiveUi(event.target)) {
      interactivePointerUntil = Date.now() + 700;
    }
  }

  if (typeof PointerEvent === 'function') {
    document.addEventListener('pointerdown', markInteractivePointer, true);
  } else {
    document.addEventListener('touchstart', markInteractivePointer, true);
    document.addEventListener('mousedown', markInteractivePointer, true);
  }

  document.addEventListener('click', function (event) {
    var target = event.target;
    var bridge = window.GptCatBridge;

    if (!bridge || typeof bridge.openImage !== 'function' || !target) return;
    if (target.closest && target.closest('[data-gc-ui]')) return;

    // 输入框、composer、contenteditable 或正在选择文字时，永远优先文本交互。
    // 这能覆盖“输入框背景是一张图片”的场景。
    if (isEditingSurface(target)) return;
    if (Date.now() <= editingPointerUntil) return;
    if (hasActiveTextSelection()) return;

    // 如果这次操作最初按下的是模型菜单/按钮，即使站点在 click 前替换了 DOM，
    // 也不允许同一手势继续进入图片预览。
    if (Date.now() <= interactivePointerUntil && target.tagName !== 'IMG') return;

    // 模型选择器、顶部按钮、下拉菜单等交互 UI 永远优先；
    // 即使它们背后恰好存在图片，也不能触发预览。
    if (isInteractiveUi(target) && target.tagName !== 'IMG') return;

    var image = imageFromActualTarget(target, event.clientX, event.clientY);
    if (!image) return;

    if (isEditingSurface(image)) return;

    if (image.closest(
      '[data-gc-ui],[class*="avatar"],button,a,[role="button"],'
      + '[role="menuitem"],[role="option"],[data-testid*="model"]'
    )) return;

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
          if (!suspended) {
            window.alert('图片打开失败：' + error.message);
          }
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
    // 硬件键盘/平板键盘：按键意味着用户正在主动编辑，不做自动 blur。
    if (event.key === 'Escape') hide();
  });

  function onViewportChange() {
    if (fabX != null) clampFabPosition();

    if (menu && menu.style.display === 'block') {
      placeMenu();
    }

    enhanceChatLayout();
    schedule();
  }

  window.addEventListener('resize', onViewportChange);

  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', onViewportChange);
    window.visualViewport.addEventListener('scroll', onViewportChange);
  }

  // 浏览历史切换时先压掉网页自动 focus，再安排快捷入口刷新。
  window.addEventListener('popstate', function () {
    suppressKeyboard();
    schedule();
  });

  window.addEventListener('hashchange', function () {
    suppressKeyboard();
    schedule();
  });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      if (timer !== null) window.clearTimeout(timer);

      timer = null;
      pendingSince = 0;
      hide();
      suppressKeyboard();
    } else {
      // 从后台回来不恢复自动弹出的键盘。
      suppressKeyboard();
      schedule();
    }
  });

  window.addEventListener('pagehide', function () {
    suspended = true;
    observer.disconnect();

    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    pendingSince = 0;

    if (idleToken !== null
        && typeof window.cancelIdleCallback === 'function') {
      window.cancelIdleCallback(idleToken);
    }

    idleToken = null;
    suppressKeyboard();
  });

  window.addEventListener('pageshow', function () {
    suspended = false;
    suppressKeyboard();
    observe();
    schedule();
  });




  // 第六轮：结构识别版聊天布局。
  // 不依赖某个固定 class；通过“靠近底部的真实编辑控件”反推 composer。
  function visibleRect(node) {
    if (!node || !node.getBoundingClientRect) return null;

    var rect = node.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;

    var style = window.getComputedStyle(node);
    if (style.display === 'none'
        || style.visibility === 'hidden'
        || style.opacity === '0') {
      return null;
    }

    return rect;
  }

  function findComposerInput() {
    var nodes = document.querySelectorAll(EDITABLE_SELECTOR);
    var vh = viewportHeight();
    var best = null;
    var bestScore = -Infinity;

    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (own(node) || node.disabled || node.readOnly) continue;

      var rect = visibleRect(node);
      if (!rect || rect.width < 120 || rect.bottom < vh * 0.42) continue;

      // 越靠近底部、越宽越像聊天输入框；顶部搜索框自然会被降权。
      var score = rect.bottom + Math.min(rect.width, viewportWidth()) * 0.08;
      if (score > bestScore) {
        best = node;
        bestScore = score;
      }
    }

    return best;
  }

  function findComposerShell(input) {
    if (!input) return null;

    var vh = viewportHeight();
    var vw = viewportWidth();
    var node = input;
    var best = input.parentElement || input;

    for (var depth = 0; node && node !== document.body && depth < 8; depth++) {
      var rect = visibleRect(node);
      if (rect
          && rect.bottom > vh * 0.58
          && rect.width >= Math.min(360, vw * 0.42)
          && rect.height <= Math.min(320, vh * 0.42)) {
        best = node;
      }

      var meta = (
        (node.getAttribute && node.getAttribute('data-testid')) || ''
      ) + ' ' + (node.className && typeof node.className === 'string'
        ? node.className : '');

      if (node.tagName === 'FORM'
          || /composer|prompt|chat[-_ ]?input|message[-_ ]?input/i.test(meta)) {
        best = node;
        break;
      }

      node = node.parentElement;
    }

    return best;
  }

  function clearLayoutMarks() {
    var oldComposer = document.querySelectorAll('[data-gc-composer-shell]');
    for (var i = 0; i < oldComposer.length; i++) {
      oldComposer[i].removeAttribute('data-gc-composer-shell');
    }

    var oldDual = document.querySelectorAll(
      '[data-gc-dual-root],[data-gc-tablet-sidebar],[data-gc-tablet-main]'
    );
    for (var j = 0; j < oldDual.length; j++) {
      oldDual[j].removeAttribute('data-gc-dual-root');
      oldDual[j].removeAttribute('data-gc-tablet-sidebar');
      oldDual[j].removeAttribute('data-gc-tablet-main');
    }
  }

  function commonAncestor(a, b) {
    if (!a || !b) return null;

    var seen = [];
    var node = a;
    for (var i = 0; node && i < 12; i++, node = node.parentElement) {
      seen.push(node);
    }

    node = b;
    for (var j = 0; node && j < 12; j++, node = node.parentElement) {
      if (seen.indexOf(node) !== -1) return node;
    }

    return null;
  }

  function directChild(root, node) {
    if (!root || !node) return null;
    var current = node;

    while (current && current.parentElement !== root) {
      current = current.parentElement;
    }

    return current && current.parentElement === root ? current : null;
  }

  function enhanceTabletDualPane(mainHint) {
    if (viewportWidth() < 840) return;

    var vh = viewportHeight();
    var vw = viewportWidth();

    var mainCandidates = document.querySelectorAll(
      'main,[role="main"],[data-testid*="main"],[class*="main"]'
    );
    var main = mainHint || null;
    var mainArea = 0;

    for (var i = 0; i < mainCandidates.length; i++) {
      var mr = visibleRect(mainCandidates[i]);
      if (!mr || mr.width < vw * 0.42 || mr.height < vh * 0.45) continue;

      var area = mr.width * mr.height;
      if (area > mainArea) {
        main = mainCandidates[i];
        mainArea = area;
      }
    }

    var sideCandidates = document.querySelectorAll(
      'aside,nav,[role="navigation"],[data-testid*="sidebar"],[class*="sidebar"]'
    );
    var sidebar = null;
    var sideScore = -Infinity;

    for (var j = 0; j < sideCandidates.length; j++) {
      var candidate = sideCandidates[j];
      if (main && main.contains(candidate)) continue;

      var sr = visibleRect(candidate);
      if (!sr
          || sr.width < 150
          || sr.width > Math.min(420, vw * 0.46)
          || sr.height < vh * 0.42
          || sr.left > vw * 0.48) {
        continue;
      }

      var score = sr.height - sr.left;
      if (score > sideScore) {
        sidebar = candidate;
        sideScore = score;
      }
    }

    if (!main || !sidebar || main === sidebar) return;

    var root = commonAncestor(sidebar, main);
    if (!root || root === document.body || root === document.documentElement) return;

    var rootRect = visibleRect(root);
    if (!rootRect || rootRect.width < 720 || rootRect.height < vh * 0.55) return;

    var sideChild = directChild(root, sidebar);
    var mainChild = directChild(root, main);
    if (!sideChild || !mainChild || sideChild === mainChild) return;

    var sideRect = visibleRect(sideChild);
    var mainRect = visibleRect(mainChild);
    if (!sideRect || !mainRect) return;

    sideChild.setAttribute('data-gc-tablet-sidebar', '');
    mainChild.setAttribute('data-gc-tablet-main', '');

    // 已经是双栏时只做宽度/滚动增强；只有明显堆叠时才把共同父级改成 grid。
    if (mainRect.left < sideRect.right - 24) {
      root.setAttribute('data-gc-dual-root', '');
    }
  }

  function hideNearbyDisclaimer(shell) {
    if (!shell) return;

    var shellRect = visibleRect(shell);
    if (!shellRect) return;

    var scope = shell.parentElement || shell;
    var parent = scope.parentElement;
    if (parent) scope = parent;

    var nodes = scope.querySelectorAll(
      'small,p,span,div,[data-testid*="disclaimer"],[class*="disclaimer"],[class*="footer"]'
    );
    var limit = Math.min(nodes.length, 220);

    for (var i = 0; i < limit; i++) {
      var node = nodes[i];
      if (own(node) || node === shell || shell.contains(node)) continue;

      var text = (node.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text || text.length > 140) continue;

      var rect = visibleRect(node);
      if (!rect) continue;

      // 只看 composer 附近的小字区域，避免误伤聊天正文。
      if (Math.abs(rect.top - shellRect.bottom) > 150
          && Math.abs(rect.bottom - shellRect.top) > 150) {
        continue;
      }

      var lower = text.toLowerCase();
      var chatgptNotice =
        lower.indexOf('chatgpt') !== -1
        && /(犯错|错误|核实|重要|mistake|check|verify|important)/i.test(text);

      var knownChinese =
        /可能.{0,8}(犯错|错误)|核查.{0,8}重要|核实.{0,8}重要/.test(text);

      if (chatgptNotice || knownChinese) {
        node.setAttribute('data-gc-hidden-disclaimer', '');
      }
    }
  }

  function ensureChatLayoutStyle() {
    if (document.getElementById('gc-chat-layout-v6')) return;

    var style = mark(document.createElement('style'));
    style.id = 'gc-chat-layout-v6';
    style.textContent =
      'html,body{overscroll-behavior-y:contain!important;}'
      + '[data-gc-hidden-disclaimer]{display:none!important;}'
      + '[data-gc-composer-shell]{'
      + 'position:sticky!important;bottom:0!important;z-index:2147481000!important;'
      + 'margin-top:auto!important;padding-bottom:max(env(safe-area-inset-bottom),4px)!important;'
      + 'background:inherit;'
      + '}'
      + '[data-gc-composer-shell] textarea,'
      + '[data-gc-composer-shell] [contenteditable="true"],'
      + '[data-gc-composer-shell] [role="textbox"]{'
      + 'scroll-margin-bottom:96px;'
      + '}'
      + '@media(min-width:840px){'
      + '[data-gc-dual-root]{display:grid!important;'
      + 'grid-template-columns:minmax(230px,300px) minmax(0,1fr)!important;'
      + 'align-items:stretch!important;width:100%!important;}'
      + '[data-gc-tablet-sidebar]{grid-column:1!important;min-width:0!important;'
      + 'max-width:300px!important;height:100dvh!important;overflow:auto!important;'
      + 'position:sticky!important;top:0!important;}'
      + '[data-gc-tablet-main]{grid-column:2!important;min-width:0!important;'
      + 'width:100%!important;max-width:none!important;}'
      + '}';

    (document.head || document.documentElement).appendChild(style);
  }

  function enhanceChatLayout() {
    try {
      ensureChatLayoutStyle();
      clearLayoutMarks();

      var input = findComposerInput();
      var shell = findComposerShell(input);
      if (shell) {
        shell.setAttribute('data-gc-composer-shell', '');
        hideNearbyDisclaimer(shell);
      }

      var mainHint = shell && shell.closest
        ? shell.closest('main,[role="main"]')
        : null;
      enhanceTabletDualPane(mainHint);
    } catch (e) { }
  }

  // 跟随系统时，系统切换深浅色要即时生效。
  if (typeof window.matchMedia === 'function') {
    var media = window.matchMedia('(prefers-color-scheme: dark)');
    var onSchemeChange = function () {
      if (themeMode() === 'auto') applyTheme(true);
    };

    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', onSchemeChange);
    } else if (typeof media.addListener === 'function') {
      media.addListener(onSchemeChange);
    }
  }

  applyTheme(true);
  observe();
  refresh();
})('__GC_BRIDGE_TOKEN__');
