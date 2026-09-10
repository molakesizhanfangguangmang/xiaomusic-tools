/* 小爱音箱「工具」一层页 —— tools.js
   纯 vanilla；外部依赖 0(无 CDN)；与 delete-song/tool.js 一致，同一 AuthStaticFiles + 会话 cookie 下
   以 same-origin fetch 读同目录工具注册表 ./tools.json，把每个 item 渲染成可点卡片。
   点某张卡片 → location 跳到该 item.url 的二级页(根绝对 /static/...)，符合 doc_frontend §3.3 无<base>惯例。
   本文件不修改任何工具注册表内容(tools.json 是纯数据)；对 disabled 工具仅置灰不跳转。 */
(function () {
  'use strict';

  /* 工具注册表，与本站点相对（./tools.json 与 ./index.html 同目录）。 */
  var REGISTRY_URL = './tools.json';

  /* 三个 DOM 目标，全部在本 index.html 里存在（见下方自查说明）。 */
  var elStatus = null;   // #tt-status
  var elGrid   = null;   // #tt-grid (ul)
  var elCount  = null;   // #tt-count

  function setStatus(kind, html) {
    /* kind ∈ ok|info|warn|error；同 delete-song 状态条语义。 */
    elStatus.className = 'tt-status tt-status-' + (kind || 'info');
    elStatus.innerHTML = html || '';
    elStatus.hidden = false;
  }
  function hideStatus() { elStatus.hidden = true; elStatus.innerHTML = ''; }

  function showCount(n) {
    elCount.textContent = '共 ' + n + ' 个可用工具（点击卡片进入对应工具页）。';
    elCount.hidden = false;
  }
  function hideCount() { elCount.hidden = true; }

  /* 401/403（会话失效或未过 AuthStaticFiles/Basic 鉴权）友好提示。 */
  function authBanner(resp) {
    var code = resp && resp.status ? resp.status : '';
    var go = document.createElement('button');
    go.type = 'button';
    go.className = 'tt-auth-go';
    go.textContent = '重新登录后返回本页';
    go.onclick = function () {
      /* 顶层导航到一个受保护的 /static 页，让浏览器弹出标准 Basic 登录框；
         登录成功后点浏览器「返回」，或直接回到注册表地址。 */
      window.location.href = '/static/xiaomusic_tools/tools.json';
    };
    setStatus('warn', '<strong>登录态缺失(' + (code || '401/403') + ')</strong>：读取工具注册表需要先通过面板鉴权。');
    elStatus.appendChild(go);
  }

  /* 渲染 registry.items：每项一张卡片。 */
  function render(items) {
    var list = Array.isArray(items) ? items : [];
    var usable = 0;

    list.forEach(function (item) {
      if (!item || typeof item !== 'object') { return; }
      var li = document.createElement('li');
      li.className = 'tt-card';

      var icon = document.createElement('div');
      icon.className = 'tt-icon';
      icon.textContent = item.icon || '🧰';

      var title = document.createElement('div');
      title.className = 'tt-title';
      var tspan = document.createElement('span');
      tspan.textContent = item.title || item.id || '?';
      title.appendChild(tspan);
      if (item.disabled) {
        var badge = document.createElement('span');
        badge.className = 'tt-badge';
        badge.textContent = '未开放';
        title.appendChild(badge);
      }

      var desc = document.createElement('p');
      desc.className = 'tt-desc';
      desc.textContent = item.desc || '';

      li.appendChild(icon);
      li.appendChild(title);
      li.appendChild(desc);

      if (item.disabled) {
        li.classList.add('tt-disabled');
        li.title = '该工具暂未开放';
      } else {
        usable++;
        /* 用相对可读 id 而不是全局 onclick：确保不与其他页面的管理 js 抢事件、作用域最小。
           跳转用 item.url（registry 内为根绝对 /static/...，无 <base> 下稳定直达）。 */
        var url = item.url || '#';
        li.setAttribute('data-jump', url);
        li.setAttribute('role', 'button');
        li.setAttribute('tabindex', '0');
        li.setAttribute('aria-label', '进入工具：' + (item.title || item.id || ''));
        li.addEventListener('click', function (u) {
          return function () { if (u && u !== '#') { window.location.href = u; } };
        }(url));
        li.addEventListener('keydown', function (u) {
          return function (e) {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (u && u !== '#') { window.location.href = u; } }
          };
        }(url));
      }

      elGrid.appendChild(li);
    });

    if (list.length === 0) {
      var empty = document.createElement('li');
      empty.className = 'tt-empty';
      empty.textContent = '注册表里暂无工具。';
      elGrid.appendChild(empty);
      hideCount();
    } else {
      showCount(usable);
    }
  }

  function load() {
    /* GET 工具注册表；与工具页同源、同带会话 cookie。 */
    fetch(REGISTRY_URL, { credentials: 'same-origin' })
      .then(function (resp) {
        if (resp.status === 401 || resp.status === 403) { authBanner(resp); throw new Error('auth'); }
        if (!resp.ok) { throw new Error('http-' + resp.status); }
        return resp.json();
      })
      .then(function (reg) {
        var items = reg && Array.isArray(reg.items) ? reg.items : [];
        render(items);
      })
      .catch(function (err) {
        if (err && err.message === 'auth') { return; } /* 已出登录提示，不再重复报错 */
        setStatus('error',
          '读取注册表 <code>' + REGISTRY_URL + '</code> 失败(' + (err && err.message ? err.message : '未知') + ')。' +
          '若确认已登录请重试；此页文件需与 tools.json 一起部署在同一 static 目录。');
      });
  }

  function init() {
    elStatus = document.getElementById('tt-status');
    elGrid   = document.getElementById('tt-grid');
    elCount  = document.getElementById('tt-count');
    /* DOM 自查：以上三 id 均在本 index.html 中；若页面骨架不完整则静默终止，避免反复注入。 */
    if (!elStatus || !elGrid || !elCount) { return; }
    load();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
