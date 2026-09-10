/* 小爱音箱「上传工具」页 —— tool.js
   纯 vanilla，无外部依赖；选 zip → POST /api/xtools/upload → 提示结果。
   接口由 xiaomusic-tools 补丁(xtools.py)提供，同源。 */
(function () {
  'use strict';

  var UPLOAD_URL = '/api/xtools/upload';

  var elFile, elDrop, elFilename, elOverwrite, elSubmit, elStatus, elForm;

  function setStatus(kind, html) {
    if (!elStatus) { return; }
    elStatus.className = 'tt-status tt-status-' + (kind || 'info');
    elStatus.innerHTML = html || '';
    elStatus.hidden = false;
  }
  function hideStatus() { if (elStatus) { elStatus.hidden = true; elStatus.innerHTML = ''; } }

  function humanSize(n) {
    if (n < 1024) { return n + ' B'; }
    if (n < 1024 * 1024) { return (n / 1024).toFixed(1) + ' KB'; }
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  function pickFile(f) {
    if (!f) { return; }
    if (!/\.zip$/i.test(f.name)) {
      setStatus('error', '请选择 <code>.zip</code> 插件包。');
      return;
    }
    elFilename.textContent = f.name + '（' + humanSize(f.size) + '）';
    elDrop.classList.add('has-file');
    elSubmit.disabled = false;
    hideStatus();
  }

  function doUpload(ev) {
    ev.preventDefault();
    var f = elFile.files && elFile.files[0];
    if (!f) { setStatus('warn', '请先选择插件包。'); return; }

    var fd = new FormData();
    fd.append('file', f, f.name);
    fd.append('overwrite', elOverwrite.checked ? 'true' : 'false');

    elSubmit.disabled = true;
    setStatus('info', '正在上传…');

    fetch(UPLOAD_URL, { method: 'POST', body: fd, credentials: 'same-origin' })
      .then(function (resp) {
        return resp.text().then(function (t) {
          var data;
          try { data = JSON.parse(t); } catch (e) { data = null; }
          return { ok: resp.ok, status: resp.status, data: data, raw: t };
        });
      })
      .then(function (r) {
        if (r.ok && r.data && r.data.ok) {
          var name = r.data.title || r.data.id;
          var act = r.data.replaced ? '已覆盖安装' : '已安装';
          setStatus('ok',
            '<strong>' + act + '：' + name + '</strong>（id <code>' + r.data.id + '</code>）' +
            '<br>前往 <a href="/static/xiaomusic_tools/index.html">工具列表</a> 查看（如未出现请刷新该页）。');
          elFile.value = '';
          elFilename.textContent = '支持 .zip；需含 manifest.json 与入口页';
          elDrop.classList.remove('has-file');
        } else {
          var detail = (r.data && (r.data.detail || r.data.message)) || r.raw || '未知错误';
          if (Array.isArray(detail)) { detail = JSON.stringify(detail); }
          setStatus('error',
            '上传失败（HTTP ' + r.status + '）：' + String(detail) +
            '<br><span class="ut-muted">若提示“接口仅支持 0.6.1”，说明当前 xiaomusic 版本不受支持，接口已自动停用。</span>');
        }
      })
      .catch(function (err) {
        setStatus('error', '请求出错：' + (err && err.message ? err.message : '未知'));
      })
      .then(function () {
        elSubmit.disabled = !(elFile.files && elFile.files[0]);
      });
  }

  function init() {
    elForm = document.getElementById('ut-form');
    elFile = document.getElementById('ut-file');
    elDrop = document.getElementById('ut-drop');
    elFilename = document.getElementById('ut-filename');
    elOverwrite = document.getElementById('ut-overwrite');
    elSubmit = document.getElementById('ut-submit');
    elStatus = document.getElementById('ut-status');
    if (!elForm || !elFile || !elDrop || !elSubmit) { return; }

    elFile.addEventListener('change', function () {
      pickFile(elFile.files && elFile.files[0]);
    });

    ['dragenter', 'dragover'].forEach(function (ev) {
      elDrop.addEventListener(ev, function (e) {
        e.preventDefault(); e.stopPropagation();
        elDrop.classList.add('is-drag');
      });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      elDrop.addEventListener(ev, function (e) {
        e.preventDefault(); e.stopPropagation();
        elDrop.classList.remove('is-drag');
      });
    });
    elDrop.addEventListener('drop', function (e) {
      var dt = e.dataTransfer;
      if (dt && dt.files && dt.files.length) {
        elFile.files = dt.files;
        pickFile(dt.files[0]);
      }
    });

    elForm.addEventListener('submit', doUpload);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
