/* =========================================================================
 * 从链接下载音频 —— tool.js（vanilla，无 CDN）
 *
 * 职责（对照 xiaomusic v0.6.1 上游 router 只读核实）：
 *   1. POST /downloadonemusic  body {"url":<必填>,"name":<可选>}
 *        file.py online: download_one_music(config,url,name,download_root)
 *        -> 内部 yt-dlp --no-playlist -x --audio-format mp3 --audio-quality 0 \
 *           [--proxy][--cookies] -o <title 或 name>.%(ext)s <url>，落 download/
 *        -> 成功(exit 0)后自动 gen_all_music_list + update_all_playlist
 *        响应 {"ret":"OK","task_id":"..."}
 *   2. GET  /download_progress?task_id=<id>
 *        → {"ret":"OK","task_id","total","completed","progress":int,"status":
 *           downloading|paused|completed|failed|stopped,"current_song"}
 *   3. POST /stop_download?task_id=<id>   （task_id 走 query，非 body）
 *   4. 完成后：GET /musiclist  取键"下载"（download/ 名字键数组）做“新增可见”判断
 *
 * 鉴权：file/music router 的下载与名单端点多数带 Depends(verification)（会话）→
 * 401/403 时本页不发请求，仅给「触发一次 Basic 登录」跳转（同删除工具的 auth 文案）。
 *
 * 诚实边界（给使用者）：本页不改任何后端 .py。真正抓取强依赖容器内 yt-dlp +
 * 配置文件里的 cookie / 代理；B 站对高并发脚本有 HTTP 412 风控，属运行环境问题而非本页能解。
 * ========================================================================= */
(function () {
  "use strict";

  var DOMAIN_KEY_DOWNLOAD = "下载";
  var DOMAIN_KEY_RAW = "download";
  var URL_START = "/downloadonemusic";
  var URL_STOP = "/stop_download";
  var URL_PROGRESS = "/download_progress";
  var URL_LIST = "/musiclist";
  var URL_AUTH_TRIGGER = "/static/default/index.html";
  var POLL_MS = 1500;

  var $form = document.getElementById("bu-form");
  var $url = document.getElementById("bu-url");
  var $name = document.getElementById("bu-name");
  var $start = document.getElementById("bu-start");
  var $stop = document.getElementById("bu-stop");
  var $status = document.getElementById("bu-status");
  var $hint = document.getElementById("bu-hint");
  var $task = document.getElementById("bu-task");
  var $taskCur = document.getElementById("bu-task-cur");
  var $taskPct = document.getElementById("bu-task-pct");
  var $barFill = document.getElementById("bu-bar-fill");
  var $taskNote = document.getElementById("bu-task-note");

  var activeTaskStart = null;   // {id,url,name}
  var _timer = null;
  var _preNames = [];           // 开始前 download 区名字键快照（用于完成后差集）
  var _busy = false;

  /* ---------- 小工具 ---------- */
  function setStatus(kind, text, withRetry) {
    $status.hidden = false;
    $status.className = "bu-status bu-status-" + (kind || "info");
    $status.textContent = text || "";
    var rb = $status.querySelector("button.bu-retry");
    if (rb) rb.parentNode.removeChild(rb);
    if (withRetry && kind === "error") {
      var b = document.createElement("button");
      b.type = "button"; b.className = "bu-retry"; b.textContent = "重试";
      b.addEventListener("click", function () { doStart(); });
      $status.appendChild(b);
    }
    removeAuthGo();
    return $status;
  }
  var _authGo = null;
  function removeAuthGo() {
    if (_authGo) { _authGo.remove(); _authGo = null; }
  }
  function showAuthError() {
    setStatus("error", "鉴权未通过 / 会话已失效(401/403)。此页需要已登录的小爱音箱会话才能发起/查看下载。");
    showHint("点击下方按钮将跳转到受保护页面触发浏览器 HTTP Basic 登录框；登录成功后返回本页重试。");
    _authGo = document.createElement("button");
    _authGo.id = "bu-auth-go"; _authGo.type = "button";
    _authGo.className = "bu-btn"; _authGo.textContent = "触发一次 Basic 登录后返回";
    _authGo.addEventListener("click", function () { window.location.href = URL_AUTH_TRIGGER; });
    $status.appendChild(_authGo);
  }
  function clearStatus() { $status.hidden = true; removeAuthGo(); }
  function showHint(html) { $hint.hidden = false; $hint.innerHTML = html; }
  function hideHint() { $hint.hidden = true; $hint.innerHTML = ""; }
  function showTask(on) { $task.hidden = !on; hideHint(); }

  function setBusy(b) {
    _busy = b;
    $url.disabled = b; $name.disabled = b; $start.disabled = (b || !trim($url.value));
    $stop.disabled = !(b && activeTaskStart);
  }
  function trim(s) { return (s || "").replace(/^\s+|\s+$/g, ""); }

  /* ---------- HTTP 封装（同删除工具：Accept json，自动反序列化裸串） ---------- */
  function apiReq(method, url, body) {
    var opts = {
      method: method,
      headers: { Accept: "application/json" },
      credentials: "same-origin"
    };
    if (body !== undefined) {
      if (typeof body === "string") {
        // query 形态（如 /stop_download?task_id=xx）
        opts.headers["Content-Type"] = "application/x-www-form-urlencoded";
        opts.body = body;
      } else {
        opts.headers["Content-Type"] = "application/json";
        opts.body = JSON.stringify(body);
      }
    }
    return fetch(url, opts).then(function (res) {
      if (res.status === 401 || res.status === 403) { var e = new Error("auth"); e.auth = true; throw e; }
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.text().then(function (t) {
        if (!t) return "";
        if (t[0] === '"') { try { return JSON.parse(t); } catch (x) { return t; } }
        try { return JSON.parse(t); } catch (x) { return t; }
      });
    });
  }

  /* ---------- 名单差集判断哪个歌名新出现 ---------- */
  function plainDownloadNames(data) {
    if (!data || typeof data !== "object") return null;
    if (Array.isArray(data[DOMAIN_KEY_DOWNLOAD])) return data[DOMAIN_KEY_DOWNLOAD];
    if (Array.isArray(data[DOMAIN_KEY_RAW])) return data[DOMAIN_KEY_RAW];
    return null;
  }
  function snapshotNames() {
    return apiReq("GET", URL_LIST).then(function (data) {
      var raw = plainDownloadNames(data);
      return raw ? raw.map(String) : [];
    }).catch(function () { return []; });
  }

  /* ---------- 发起 ---------- */
  function doStart() {
    var u = trim($url.value);
    if (!u) return;
    var n = trim($name.value);
    // 启动前把现有 download 名单快照下来，好在完成后做“新歌可辨”的差集
    snapshotNames().then(function (pre) {
      _preNames = pre;
      return apiReq("POST", URL_START, n ? { url: u, name: n } : { url: u });
    }).then(function (res) {
      if (!res || !res.task_id || res.ret !== "OK") {
        setStatus("error", "后端未返回任务(可能 URL 被拒或后端异常)：" + (res && res.ret || "无任务 id"), true);
        setBusy(false);
        return;
      }
      hideHint();
      var id = res.task_id;
      activeTaskStart = { id: id, url: u, name: n };
      setStatus("info", "任务已创建(" + id.slice(0, 8) + "…)：正在交给后端 yt-dlp 解析并下载…");
      showTask(true);
      setBusy(true);
      $taskCur.textContent = "正在解析 / 下载音轨…";
      setPct(0, "…");
      _timer = setInterval(function () { poll(id); }, POLL_MS);
    }).catch(function (err) {
      if (err && err.auth) { showAuthError(); }
      else setStatus("error", "发起下载失败：" + (err && err.message || "网络错误") + "。", true);
      setBusy(false);
    });
  }

  /* ---------- 轮询 ---------- */
  function setPct(pct, label) {
    pct = Math.max(0, Math.min(100, Math.round(pct || 0)));
    $barFill.style.width = pct + "%";
    $taskPct.textContent = (typeof label === "string" ? label : pct + "%");
  }
  function poll(id) {
    apiReq("GET", URL_PROGRESS + "?task_id=" + encodeURIComponent(id)).then(function (d) {
      if (!d || d.ret === "Not found") { return finishStale(); }
      var st = d.status;
      var cur = d.current_song || "";
      var pct = typeof d.progress === "number" ? d.progress : 0;

      if (st === "downloadong") { /* 防上游笔误，正常不进 */ }
      if (st === "downloading") {
        $taskCur.textContent = cur ? "下载中：" + cur : "下载中…";
        $taskCur.className = "bu-task-cur";
        setPct(pct);
      } else if (st === "paused") {
        $taskCur.textContent = "（已暂停）" + (cur || "");
        setPct(pct);
      } else if (st === "stopped") {
        stopTimer();
        showTask(false);
        setBusy(false);
        setStatus("warn", "下载已被停止（任务 " + id.slice(0, 8) + "）。download/ 里可能有 yt-dlp 中间残留，请在下一次「已下载」里查看或清理。");
      } else if (st === "failed") {
        stopTimer();
        showTask(false);
        setBusy(false);
        setStatus("error", "下载失败。后端反馈：'" + (cur || "未知") + "'。常见原因：URL 无法解析 / 目标站需 cookie(cookies 未配) 或风控(412)。可重试或换链接。", true);
      } else if (st === "completed") {
        stopTimer();
        showTask(false);
        setBusy(false);
        finishOk(d);
      } else {
        // 其它未知态继续等
      }
    }).catch(function (err) {
      if (err && err.auth) { stopTimer(); showTask(false); setBusy(false); showAuthError(); }
      // 瞬时网络错误则下一 tick 继续
    });
  }
  function stopTimer() { if (_timer) { clearInterval(_timer); _timer = null; } }

  function finishStale() {
    stopTimer(); showTask(false); setBusy(false);
    setStatus("warn", "任务记录已不存在（可能已完成并被清理，或多个实例重启过）。去「已下载」里确认结果。");
  }

  /* 完成后差集对比，给出“新增了哪个歌名” */
  function finishOk(d) {
    var curSong = d.current_song || "";
    snapshotNames().then(function (after) {
      var gained = [];
      var s1 = {}; (after || []).forEach(function (x) { s1[x] = 1; });
      (_preNames || []).forEach(function (x) { delete s1[x]; });
      gained = Object.keys(s1);
      if (gained.length) {
        var disp = gained.slice(0, 3).join("、") + (gained.length > 3 ? "…" : "");
        setStatus("ok", "下载完成。download/ 已新增：" + disp + "。去主页/删除工具可见。");
        setStatusForNew(disp);
      } else {
        // 名字键未体现在名单差集：可能同名覆盖已有、或扫描延迟。
        var hintMe = (activeTaskStart && activeTaskStart.name) || "";
        setStatus("ok", "下载任务已完成但名单差集未见新键（可能与已有同名覆盖，或 rescan 尚未收敛）" +
            (hintMe ? "；本地名：“" + hintMe + "”。" : "。"));
      }
      activeTaskStart = null;
    }).catch(function () {
      setStatus("ok", "下载任务已完成。可去主页「已下载」里确认新歌。");
      activeTaskStart = null;
    });
  }
  function setStatusForNew(_d) { /* 占位：前端仅提示；如需可高亮待后续扩展 */ }

  /* ---------- 停止 ---------- */
  function doStop() {
    if (!_busy || !activeTaskStart) return;
    var id = activeTaskStart.id;
    setStatus("info", "正在停止任务 " + id.slice(0, 8) + "…");
    apiReq("POST", URL_STOP + "?task_id=" + encodeURIComponent(id)).then(function (r) {
      var msg = (r && r.message) || "";
      setStatus("warn", (r && r.ret === "OK" ? "已发送停止指令。" : "停止未成功：" + (msg || "未知")) +
          " 停止以轮询状态 `stopped` 为准。");
    }).catch(function (err) {
      if (err && err.auth) showAuthError();
      else setStatus("error", "请求停止失败：" + (err && err.message || "网络错误") + "，可稍后再试。", true);
    });
  }

  /* ---------- 事件 ---------- */
  function refreshStartBtn() {
    if (_busy) return;
    $start.disabled = !trim($url.value);
  }
  $url.addEventListener("input", function () { clearStatus(); hideHint(); refreshStartBtn(); });
  $name.addEventListener("input", function () { if (!_busy) { clearStatus(); hideHint(); } });
  $form.addEventListener("submit", function (e) {
    e.preventDefault();
    if (_busy) return;
    clearStatus();
    doStart();
  });
  $stop.addEventListener("click", doStop);

  refreshStartBtn();
})();
