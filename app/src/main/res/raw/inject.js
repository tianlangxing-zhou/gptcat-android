// GPTCat 手机/平板适配：低频 DOM 增强、图片桥、输入法自动聚焦门控。
(function (bridgeToken) {
  'use strict';

  if (window !== window.top || window.__gcInjected) return;
  window.__gcInjected = true;

  // 附加到站点自带「功能选单」里的两项本地功能（不再有自己的悬浮菜单）。
  var MENU_ITEMS = [
    { label: '下载任务', icon: '⬇️', action: 'downloads' },
    { label: '图片缓存', icon: '🧹', action: 'cache' }
  ];

  var EDITABLE_SELECTOR =
    'input:not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]),'
    + 'textarea,[contenteditable="true"],[role="textbox"]';

  var MAX_IMAGE_BYTES = 32 * 1024 * 1024;
  var CHUNK_BYTES = 48 * 1024;

  var timer = null;
  var pendingSince = 0;
  var idleToken = null;
  var suspended = false;
  var imageBusy = false;

  // 下载任务 / 图片缓存面板
  var panel = null;
  var panelKind = '';
  var tasksTimer = null;
  var tasks = [];
  var localTasks = [];

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

  /** 只保留点击序列合成，站点菜单里注入的行复用它。 */
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

  // ------------------------------------------- 站点「功能选单」里的本地功能

  // 站点菜单是它自己的组件（Naive UI 浮层），类名会变、每次发版都可能不同，
  // 所以这里不猜类名：只用文案找到它已有的行，把行容器和行模板记下来，
  // 把我们那两项「按同一个模板克隆」插进去，样式/间距天然跟站点一致。
  var MENU_ITEM_TEXTS = ['对话导出', '刷新会话', '预设提示词', '查看公告'];
  var MENU_ROW_SELECTOR =
    'button,[role="menuitem"],[role="option"],[role="button"],li,a,div,span';

  var menuHost = null;
  var menuTemplate = null;
  var menuProbed = 0;

  function shortText(node) {
    var text = (node.textContent || '').replace(/\s+/g, ' ').trim();
    return text.length > 0 && text.length <= 12 ? text : '';
  }

  /** 站点菜单里已有的行，用来定位容器与取行模板。只在需要时扫描一次。 */
  function siteMenuRows() {
    var nodes = document.querySelectorAll(MENU_ROW_SELECTOR);
    var found = [];

    for (var i = 0; i < nodes.length && found.length < 6; i++) {
      var node = nodes[i];
      if (node === document.body || own(node)) continue;

      var text = shortText(node);
      if (text && MENU_ITEM_TEXTS.indexOf(text) !== -1) found.push(node);
    }

    return found;
  }

  /** 兄弟里有几个「短文本行」，用来判断这个父节点是不是菜单的行容器。 */
  function rowLikeChildren(node) {
    var count = 0;

    for (var i = 0; i < node.children.length; i++) {
      var child = node.children[i];
      if (child.hasAttribute('data-gc-ui')) continue;
      if (shortText(child)) count++;
    }

    return count;
  }

  /**
   * 站点每一行都带图标（emoji 或 svg），所以「行节点」的文字并不等于纯文案，
   * 能精确匹配到文案的通常只是里面那个 label。把 label 的祖先收敛到容器的
   * 直接子节点，拿到的才是整行 —— 否则克隆出来的只有一截文字，样式全丢。
   */
  function rowFor(host, node) {
    var row = node;

    while (row.parentElement && row.parentElement !== host) row = row.parentElement;

    return row.parentElement === host ? row : node;
  }

  function findMenuHost() {
    var rows = siteMenuRows();

    for (var r = 0; r < rows.length; r++) {
      var node = rows[r];

      for (var up = 0; up < 4 && node.parentElement; up++) {
        node = node.parentElement;

        if (node === document.body) break;
        if (rowLikeChildren(node) < 3) continue;

        return { host: node, template: rowFor(node, rows[r]) };
      }
    }

    return null;
  }

  /** 摘掉克隆行从站点带过来的 data-*（我们自己的两个标记除外）。 */
  function stripDataAttrs(row) {
    if (!row.attributes || !row.removeAttribute) return;

    var names = [];

    for (var i = 0; i < row.attributes.length; i++) {
      var name = row.attributes[i].name || '';
      if (name.indexOf('data-') === 0 && name.indexOf('data-gc-') !== 0) names.push(name);
    }

    for (var j = 0; j < names.length; j++) row.removeAttribute(names[j]);
  }

  /** 行里承载文案的节点：最深、且文字刚好等于某个已知菜单项。 */
  function labelNodeIn(row) {
    var nodes = row.querySelectorAll ? row.querySelectorAll('*') : [];
    var found = null;

    for (var i = 0; i < nodes.length; i++) {
      var text = shortText(nodes[i]);
      if (text && MENU_ITEM_TEXTS.indexOf(text) !== -1) found = nodes[i];
    }

    return found;
  }

  /** 去掉站点那一行自带的图标，免得我们的文字配着别人的图标。 */
  function stripIcons(row, keep) {
    var nodes = row.querySelectorAll ? row.querySelectorAll('*') : [];

    for (var i = nodes.length - 1; i >= 0; i--) {
      var node = nodes[i];
      if (!node.parentElement) continue;
      if (keep && (node === keep || node.contains(keep))) continue;

      var tag = (node.tagName || '').toLowerCase();
      if (tag === 'svg' || tag === 'img' || tag === 'use') {
        node.parentElement.removeChild(node);
        continue;
      }

      var text = (node.textContent || '').trim();
      if (node.children.length === 0 && text && text.length <= 3) {
        node.parentElement.removeChild(node);
      }
    }
  }

  /** 点一下右上角的「功能选单」开关，把站点菜单收起来。 */
  function closeSiteMenu() {
    var nodes = document.querySelectorAll('button,[role="button"],div,span');

    for (var i = 0; i < nodes.length && i < 400; i++) {
      var node = nodes[i];
      if (own(node)) continue;

      var text = (node.textContent || '').replace(/\s+/g, ' ').trim();
      if (text !== '功能选单' || !visible(node)) continue;

      clickElement(node);
      return;
    }
  }

  function paintMenuEntries(host, template) {
    if (!host || !template || !template.cloneNode) return false;
    if (host.querySelector('[data-gc-menu-action]')) return true;

    MENU_ITEMS.forEach(function (item) {
      var row = template.cloneNode(true);

      if (row.removeAttribute) row.removeAttribute('id');
      row.setAttribute('data-gc-ui', '');
      row.setAttribute('data-gc-menu-action', item.action);

      // 站点每一行是 div[data-action=...]，靠事件委托分发动作。
      // 克隆行必须把这些 data-* 摘掉，否则点我们的项会连带触发它的动作。
      stripDataAttrs(row);

      var label = labelNodeIn(row);
      var caption = item.icon + ' ' + item.label;

      if (label && label !== row) {
        stripIcons(row, label);
        label.textContent = caption;
      } else {
        row.textContent = caption;
      }

      // 站点可能用事件委托读 index 选菜单项，捕获阶段先拦掉，别让它误触发。
      row.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        closeSiteMenu();
        runAction(item.action);
      }, true);

      host.appendChild(row);
    });

    return true;
  }

  /**
   * 菜单已渲染就把两项插进去；没渲染就什么都不做。
   * force=true 只在「用户点了功能选单开关」时用，此时才值得扫一次全页。
   */
  function syncMenuEntries(force) {
    if (menuHost && menuHost.isConnected
        && menuTemplate && menuTemplate.isConnected) {
      return paintMenuEntries(menuHost, menuTemplate);
    }

    menuHost = null;
    menuTemplate = null;

    if (!force) {
      // 站点菜单是挂在 body 下的浮层；没有浮层就不扫全页，避免拖慢聊天页。
      if (!document.querySelector('[role="menu"],[role="listbox"],[role="dialog"]')) {
        return false;
      }

      var now = Date.now();
      if (now - menuProbed < 1500) return false;
      menuProbed = now;
    }

    var found = findMenuHost();
    if (!found) return false;

    menuHost = found.host;
    menuTemplate = found.template;

    return paintMenuEntries(menuHost, menuTemplate);
  }

  // ---------------------------------------------------------------- 主题

  // 只为根页面和本插件 UI 提供浅色兜底，不覆写站点所有 div/button。
  var LIGHT_CSS =
    ':root{--gc-bg:#fff;--gc-fg:#1f2937;--gc-muted:#6b7280;'
    + '--gc-border:#e5e7eb;--gc-accent:#1f6feb;--gc-card:#f8fafc}'
    + 'html,body,#app{background-color:#fff;color:#1f1f1f;color-scheme:light;'
    + '-webkit-text-size-adjust:100%;text-size-adjust:100%}'
    + 'input,textarea,[contenteditable="true"]{color:#111}';

  function applyAdaptiveStyle() {
    var style = document.getElementById('gc-theme');

    if (!style) {
      style = mark(document.createElement('style'));
      style.id = 'gc-theme';
      (document.head || document.documentElement).appendChild(style);
    }

    if (style.textContent !== LIGHT_CSS) style.textContent = LIGHT_CSS;
  }

  // 插件自身 UI 的字体与自适应规则：站点所有 div/button 都不覆写。
  function applyPluginStyle() {
    if (document.getElementById('gc-adaptive')) return;

    var style = mark(document.createElement('style'));
    style.id = 'gc-adaptive';
    style.textContent =
      '[data-gc-ui]{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;'
      + '-webkit-tap-highlight-color:transparent}'
      + '@media (min-width:600px){'
      + '#gcPanel{width:min(480px,calc(100vw - 48px))!important;font-size:15px!important}'
      + '}';

    (document.head || document.documentElement).appendChild(style);
  }

  function refresh() {
    timer = null;
    idleToken = null;
    pendingSince = 0;

    if (suspended || document.hidden || !document.body) return;

    applyAdaptiveStyle();
    applyPluginStyle();
    enhanceChatLayout();
    syncMenuEntries(false);
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
  //
  // 第九轮修正（真机探针定位）：类名启发式不能只看“子串命中”。
  // 站点用 Tailwind 任意值类名承载输入区高度，例如
  //   flex flex-col text-sm keyboard-open:pb-[calc(var(--composer-height,100px))]
  // 这个类名里含 "composer" 子串，于是 [class*="composer"] 把**消息滚动区**
  // 误判成输入区 → 内容区里 AI 生成图的第一下点击被 isEditingSurface 直接吞掉。
  // （用户上传的裸 <img> 不在该容器里，所以没受影响 —— 这正是“上传图能点开、
  //  生成图点不开”的原因。）
  // 现在：强证据（真的可编辑元素/表单）直接成立；类名启发式必须同时满足
  // “容器内部确实存在可编辑元素”，纯布局容器一律放行。
  var EDITING_STRONG_SELECTOR =
    'input,textarea,select,option,[contenteditable="true"],[role="textbox"]';
  var EDITING_WEAK_SELECTOR =
    '[data-testid*="composer"],[data-testid*="chat-input"],[data-testid*="prompt"],'
    + '[class*="composer"],[class*="chat-input"],[class*="prompt"],'
    + '[class*="input-area"],[class*="input-container"]';

  function isEditingSurface(node) {
    if (!node || !node.closest) return false;
    if (node.closest('form')) return true;
    if (node.closest(EDITING_STRONG_SELECTOR)) return true;

    var weak = node.closest(EDITING_WEAK_SELECTOR);
    if (!weak) return false;

    return !!(weak.querySelector && weak.querySelector(EDITING_STRONG_SELECTOR));
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
  }

  function runAction(action) {
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

      actions.appendChild(panelButton('删除文件', function () {
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

    if (typeof window.confirm === 'function'
        && !window.confirm('删除该下载文件及任务记录？此操作不可撤销。')) return;

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

  var MAX_FILE_BYTES = 128 * 1024 * 1024;

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
        if (blob.size > MAX_FILE_BYTES) throw new Error('文件超过 128 MiB 限制');

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

    // 永远不能触发预览：自家 UI、头像，以及模型选择器/菜单这类真正的交互控件。
    if (image.closest(
      '[data-gc-ui],[class*="avatar"],'
      + '[role="menuitem"],[role="option"],[data-testid*="model"]'
    )) return;

    var rect = image.getBoundingClientRect();
    if (image.naturalWidth < 200 && rect.width < 160) return;

    // 站点常把「AI 生成图」包在 <a>/<button> 里，让它自己的灯箱先吃掉点击，
    // 而「用户上传的图」通常是裸 <img>。以前这里把 a/button 一律排除，
    // 结果生成图点一下进不了我们的预览（站点灯箱抢走了第一次点击）。
    // 现在只有"确实点在这张大图本身"才绕过容器规则：目标必须是 img 且屏上尺寸够大，
    // 这样工具栏图标、头像、按钮里的小图仍然让路给站点。
    if (image.closest('button,a,[role="button"]')
        && (target !== image || rect.width < 120 || rect.height < 120)) return;

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

  // 点「功能选单」开关后菜单是异步渲染的，稍等一下再把我们两项插进去。
  document.addEventListener('click', function (event) {
    var node = event.target;

    if (!node || !node.textContent) return;

    if (node.textContent.replace(/\s+/g, ' ').trim() !== '功能选单') return;

    window.setTimeout(function () { syncMenuEntries(true); }, 220);
  }, true);

  document.addEventListener('click', function (event) {
    // 点面板外面收起面板；面板自身的按钮都带 data-gc-ui。
    if (panel && panel.style.display === 'block' && !own(event.target)) closePanel();
  });

  document.addEventListener('keydown', function (event) {
    // 硬件键盘/平板键盘：按键意味着用户正在主动编辑，不做自动 blur。
    if (event.key === 'Escape') closePanel();
  });

  function onViewportChange() {
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
      closePanel();
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
    if (document.getElementById('gc-chat-layout-v7')) return;

    var style = mark(document.createElement('style'));
    style.id = 'gc-chat-layout-v7';
    style.textContent =
      'html,body{overscroll-behavior-y:contain!important;}'
      + '[data-gc-hidden-disclaimer]{display:none!important;}'
      // 站点「设置」弹窗的标签栏左端有一个 position:sticky + z-index:1 的渐变遮罩
      // （class 里带 sticky/z-1/md:hidden，只有 mask-image，纯装饰）。
      // 它默认 pointer-events:auto，正好压住第一枚标签，把「常规」的点击整块吃掉 ——
      // 表现就是「数据管理 能点、返回 常规 点不动」。tablist 的非 tab 子元素一律
      // 让它穿透；标签自身的点击不受影响（标签在遮罩下层，事件照常命中）。
      + '[role="tablist"]>:not([role="tab"]){pointer-events:none!important;}'
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
