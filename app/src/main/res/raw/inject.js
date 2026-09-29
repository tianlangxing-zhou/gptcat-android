// GPTCat 移动端适配注入脚本
// 在页面内注入“快捷入口”悬浮按钮(FAB)，按文本匹配定位站内功能卡片并触发其点击。
// 找不到目标(如登录页)时自动隐藏，SPA 路由切换后自动恢复。
(function () {
  if (window.__gcInjected) return;
  window.__gcInjected = true;

  var ITEMS = [
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

  var fab = null, menu = null, open = false;

  function build() {
    fab = document.createElement('div');
    fab.textContent = '⚡';
    fab.style.cssText = 'position:fixed;right:16px;bottom:110px;width:48px;height:48px;'
      + 'border-radius:50%;background:rgba(31,111,235,.92);color:#fff;display:flex;'
      + 'align-items:center;justify-content:center;font-size:22px;z-index:2147483000;'
      + 'box-shadow:0 4px 12px rgba(0,0,0,.25);cursor:pointer;user-select:none;';
    fab.addEventListener('click', function (e) { e.stopPropagation(); toggle(); });
    document.body.appendChild(fab);

    menu = document.createElement('div');
    menu.style.cssText = 'position:fixed;right:16px;bottom:168px;z-index:2147483000;display:none;'
      + 'background:#fff;border:1px solid #e5e7eb;border-radius:12px;'
      + 'box-shadow:0 6px 24px rgba(0,0,0,.15);padding:6px;min-width:150px;';
    ITEMS.forEach(function (it) {
      var row = document.createElement('div');
      row.textContent = it.icon + '  ' + it.key;
      row.style.cssText = 'padding:10px 14px;border-radius:8px;font-size:14px;color:#1f2937;cursor:pointer;';
      row.addEventListener('click', function () {
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

  // SPA 路由/重渲染后自动增删，保证只在功能页出现
  function ensure() {
    if (!available()) { destroy(); return; }
    if (!document.body.contains(fab)) build();
  }

  setInterval(ensure, 1500);
  ensure();
})();
