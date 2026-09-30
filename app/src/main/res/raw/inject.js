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
    { key: '升级套餐', icon: '⭐' }
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

  function dockSide() {
    if (!fab || fab.style.display === 'none') return;
    if (menu && menu.style.display === 'block') return;

    var cx = fabX != null ? fabX : fab.offsetLeft;
    docked = true;
    fab.style.transition = 'transform .25s ease';
    fab.style.transform =
      'translateX(' + (cx < viewportWidth() / 2 ? -30 : 30) + 'px)';
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
      + 'border:0;border-radius:50%;background:rgba(31,111,235,.92);color:#fff;display:none;'
      + 'align-items:center;justify-content:center;font-size:22px;z-index:2147483000;'
      + 'box-shadow:0 4px 12px rgba(0,0,0,.25);cursor:pointer;user-select:none;touch-action:none;';

    menu = mark(document.createElement('div'));
    menu.id = 'gcMenu';
    menu.style.cssText =
      'position:fixed;right:16px;bottom:168px;z-index:2147483000;display:none;'
      + 'background:#fff;border:1px solid #e5e7eb;border-radius:12px;'
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
        'display:block;width:100%;border:0;background:#fff;text-align:left;'
        + 'padding:10px 14px;border-radius:8px;font-size:14px;color:#1f2937;cursor:pointer;';

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

  // 只为根页面和本插件 UI 提供浅色/自适应兜底，不覆写站点所有 div/button。
  function applyAdaptiveStyle() {
    if (document.getElementById('gc-adaptive')) return;

    var style = mark(document.createElement('style'));
    style.id = 'gc-adaptive';
    style.textContent =
      'html,body,#app{background-color:#fff;color:#1f1f1f;color-scheme:light;'
      + '-webkit-text-size-adjust:100%;text-size-adjust:100%}'
      + 'input,textarea,[contenteditable="true"]{color:#111}'
      + '[data-gc-ui]{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;'
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
    enhanceChatLayout();
    targets = scanTargets();

    var available = targets.some(Boolean);

    if (!available && (!fab || !document.body.contains(fab))) {
      return;
    }

    if (!fab
        || !menu
        || !document.body.contains(fab)
        || !document.body.contains(menu)) {
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

  function trackDownload(id, name) {
    var bridge = window.GptCatBridge;
    if (!bridge || typeof bridge.getDownloadProgress !== 'function') return;

    activeDownloads[id] = true;

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
        setDownloadChip('下载完成：' + name + ' · 点击打开', true);

        var chip = downloadChip();
        chip.onclick = function () {
          try {
            bridge.openDownloadedFile(bridgeToken, id);
          } catch (e) { }
        };

        hideDownloadChipLater(8000);
        return;
      }

      if (status === 'failed') {
        delete activeDownloads[id];
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
          setDownloadChip('无法读取下载状态：' + name, false);
          hideDownloadChipLater(3500);
          return;
        }
      } else {
        trackDownload._misses = 0;
      }

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

  document.addEventListener('click', function (event) {
    var bridge = window.GptCatBridge;
    if (!bridge || typeof bridge.downloadFile !== 'function') return;

    var target = event.target && event.target.closest
      ? event.target.closest('a')
      : null;

    if (!target || !/^https?:\/\//i.test(target.href || '')) return;
    if (target.closest && target.closest('[data-gc-ui]')) return;

    var marked = target.hasAttribute('download');
    var fileLike =
      /\.(zip|7z|rar|pdf|doc|docx|xls|xlsx|ppt|pptx|csv|apk|png|jpg|jpeg|gif|webp|txt|md|json|mp3|wav|mp4)(\?|#|$)/i
        .test(target.href);

    if (!marked && !fileLike) return;

    var downloadName = target.getAttribute('download') || '';

    if (!downloadName) {
      try {
        downloadName = decodeURIComponent(
          target.href.split('/').pop().split('?')[0].split('#')[0]
        );
      } catch (e) {
        downloadName = '';
      }
    }

    if (!downloadName) downloadName = 'gptcat-download';

    var id = '';
    try {
      id = String(bridge.downloadFile(
        bridgeToken,
        target.href,
        downloadName
      ) || '');
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

    if (!/^\d+$/.test(id)) return;

    event.preventDefault();
    event.stopPropagation();
    setDownloadChip('正在准备下载：' + downloadName, false);
    trackDownload(id, downloadName);
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

  observe();
  refresh();
})('__GC_BRIDGE_TOKEN__');
