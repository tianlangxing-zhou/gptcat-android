// GPTCat 移动端适配注入脚本
// 在页面内注入“快捷入口”悬浮按钮(FAB)，按文本匹配定位站内功能卡片并触发其点击。
// 找不到目标(如登录页)时自动隐藏，SPA 路由切换后自动恢复。
(function () {
  if (window.__gcInjected) return;
  window.__gcInjected = true;

  // 顶部模型选择按钮的匹配关键词（模型名动态变化：GPT-4O-mini / ChatGPT 5.6 Sol 等）
  var MODEL_KEYWORDS = ['GPT', 'Gemini', 'Claude', 'Deepseek', 'Grok', 'Auto'];

  var ITEMS = [
    { key: '__model__', icon: '🤖', label: '切换模型' },
    { key: 'GPT官方镜像', icon: '🪞' },
    { key: '香蕉 2 绘图', icon: '🍌' },
    { key: '深度研究', icon: '🔍' },
    { key: '思维导图', icon: '🧠' }
  ];

  // 找包含目标文本的“最内层”元素（点击后事件冒泡到卡片容器，触发框架的 onClick）
  function findByText(txt) {
    var nodes = document.querySelectorAll('div,section,li,button,a,span,p,h3,h4');
    var best = null;
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var t = (n.textContent || '').trim();
      if (t.indexOf(txt) !== -1 && t.length <= txt.length + 60) {
        if (!best || (best !== n && best.contains(n))) best = n;
      }
    }
    return best;
  }

  function clickEl(el) {
    if (!el) return false;
    var types = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
    for (var i = 0; i < types.length; i++) {
      var type = types[i];
      var Ctor = (typeof PointerEvent === 'function' && type.indexOf('pointer') === 0)
        ? PointerEvent : MouseEvent;
      try {
        el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, view: window }));
      } catch (e) { /* ignore */ }
    }
    return true;
  }

  // 打开顶部模型选择下拉：只匹配视口内顶部 header 的元素，
  // 排除隐藏抽屉/侧栏/弹层（naive-ui 抽屉 DOM 常驻但被移出视口）
  function openModelMenu() {
    var nodes = document.querySelectorAll('div,span,button,p');
    var cand = null, candTop = 1e9;
    var W = window.innerWidth;
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var t = (n.textContent || '').trim();
      if (!t || t.length > 40) continue;
      var hit = false;
      for (var j = 0; j < MODEL_KEYWORDS.length; j++) {
        if (t.indexOf(MODEL_KEYWORDS[j]) !== -1) { hit = true; break; }
      }
      if (!hit) continue;
      if (n.closest && n.closest('[class*="drawer"],[class*="sider"],[class*="dropdown"],[class*="popover"],[class*="menu"]')) continue;
      var r = n.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.left < 0 || r.right > W) continue;
      if (r.top < 0 || r.top > 260) continue;
      if (cand && cand.contains(n)) { cand = n; continue; }
      if (r.top < candTop) { cand = n; candTop = r.top; }
    }
    if (cand) clickEl(cand);
  }

  var fab = null, menu = null, open = false;

  function build() {
    fab = document.createElement('div');
    fab.id = 'gcFab';
    fab.textContent = '⚡';
    fab.style.cssText = 'position:fixed;right:16px;bottom:110px;width:48px;height:48px;'
      + 'border-radius:50%;background:rgba(31,111,235,.92);color:#fff;display:flex;'
      + 'align-items:center;justify-content:center;font-size:22px;z-index:2147483000;'
      + 'box-shadow:0 4px 12px rgba(0,0,0,.25);cursor:pointer;user-select:none;';
    fab.addEventListener('click', function (e) { e.stopPropagation(); toggle(); });
    document.body.appendChild(fab);

    menu = document.createElement('div');
    menu.id = 'gcMenu';
    menu.style.cssText = 'position:fixed;right:16px;bottom:168px;z-index:2147483000;display:none;'
      + 'background:#fff;border:1px solid #e5e7eb;border-radius:12px;'
      + 'box-shadow:0 6px 24px rgba(0,0,0,.15);padding:6px;min-width:150px;';
    ITEMS.forEach(function (it) {
      var row = document.createElement('div');
      row.textContent = it.icon + '  ' + (it.label || it.key);
      row.style.cssText = 'padding:10px 14px;border-radius:8px;font-size:14px;color:#1f2937;cursor:pointer;';
      row.addEventListener('click', function () {
        if (it.key === '__model__') { openModelMenu(); hide(); return; }
        var el = findByText(it.key);
        if (el) { clickEl(el); hide(); }
      });
      menu.appendChild(row);
    });
    document.body.appendChild(menu);
  }

  function toggle() {
    if (!menu) return;
    open = !open;
    menu.style.display = open ? 'block' : 'none';
  }
  function hide() { open = false; if (menu) menu.style.display = 'none'; }

  function available() {
    return ITEMS.some(function (it) { return !!findByText(it.key); });
  }

  function destroy() {
    if (fab) { fab.remove(); fab = null; }
    if (menu) { menu.remove(); menu = null; }
    open = false;
  }

  // 点击对话里生成的图片 → 原生全屏查看 + 保存到相册
  // 站点常在图片上盖透明覆盖层/工具条，click 的 target 未必是 <img>：
  // 依次回退 closest('img') → 按点击坐标反查被覆盖的大图 → 容器背景图
  function hookImages() {
    if (window.__gcImgHook) return;
    window.__gcImgHook = true;
    document.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      if (t.closest('#gcFab,#gcMenu,[class*="avatar"]')) return;
      var img = null, src = null, minW = 160;
      var direct = t.closest('img');
      if (direct) {
        var r0 = direct.getBoundingClientRect();
        if ((direct.naturalWidth || 0) < 200 && r0.width < minW) return;
        img = direct;
        src = img.currentSrc || img.src;
      }
      if (!src) {
        // 覆盖层挡住图片：按点击坐标找视口内被覆盖的大图
        var x = e.clientX, y = e.clientY;
        var all = document.querySelectorAll('img');
        for (var k = 0; k < all.length; k++) {
          var r = all[k].getBoundingClientRect();
          if (r.width < minW) continue;
          if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
            img = all[k];
            src = img.currentSrc || img.src;
            break;
          }
        }
      }
      if (!src) {
        // 图片不是 <img> 而是容器背景图
        var el = t;
        for (var i = 0; i < 4 && el; i++) {
          var bi = getComputedStyle(el).backgroundImage;
          if (bi && bi.indexOf('url(') === 0) {
            src = bi.slice(bi.indexOf('(') + 1).replace(/["']/g, '').replace(/\)$/, '');
            break;
          }
          el = el.parentElement;
        }
      }
      if (!src) return;
      e.preventDefault();
      e.stopPropagation();
      var isData = src.indexOf('data:image') === 0;
      var isBlob = src.indexOf('blob:') === 0;
      if ((isData || isBlob) && img) {
        try {
          var cv = document.createElement('canvas');
          cv.width = img.naturalWidth || img.width || 512;
          cv.height = img.naturalHeight || img.height || 512;
          cv.getContext('2d').drawImage(img, 0, 0);
          window.GptCatBridge.openImage(cv.toDataURL('image/png'));
          return;
        } catch (err) { /* canvas 被跨域污染 → 走 URL */ }
      }
      if (isData || src.indexOf('http') === 0) {
        window.GptCatBridge.openImage(src);
      }
    }, true);
  }

  // 强制白底黑字（用户要求：APP 内页面白底黑字）
  function applyLightTheme() {
    if (document.getElementById('gc-light')) return;
    var s = document.createElement('style');
    s.id = 'gc-light';
    s.textContent = ''
      + 'html,body,#app,[class*="n-config-provider"],[class*="n-"]:not(#gcFab):not(#gcMenu),'
      + 'div:not(#gcFab):not(#gcMenu),section:not(#gcFab):not(#gcMenu),'
      + 'li:not(#gcFab):not(#gcMenu),header:not(#gcFab):not(#gcMenu),'
      + 'main:not(#gcFab):not(#gcMenu),article:not(#gcFab):not(#gcMenu)'
      + '{background-color:#ffffff !important;color:#1f1f1f !important}'
      + 'input,textarea,[contenteditable="true"]{background:#ffffff !important;color:#111111 !important;'
      + 'border:1px solid #d0d0d0 !important}'
      + 'button,[role="button"]{background-color:#ffffff !important;color:#1f1f1f !important}'
      + 'a,span,p,h1,h2,h3,h4,h5,h6{color:#1f1f1f !important}';
    (document.head || document.documentElement).appendChild(s);
  }

  // SPA 路由/重渲染后自动增删，保证只在功能页出现
  function ensure() {
    applyLightTheme();
    hookImages();
    if (!available()) { destroy(); return; }
    if (!document.body.contains(fab)) build();
  }

  setInterval(ensure, 1500);
  ensure();
})();
