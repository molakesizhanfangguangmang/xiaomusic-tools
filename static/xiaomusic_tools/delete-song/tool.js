/* =========================================================================
 * 删除已下载歌曲工具 —— tool.js（vanilla，无 CDN 依赖，可离线）
 *
 * 职责（依据 doc_backend / doc_frontend 已核对的接口与语义）：
 *   1. GET  /musiclist
 *        - 名单源。doc_backend §5(a): 取返回对象中键值为 download/ 目录名键数组的键
 *        - 内核 regen 时把 download/ 组键改名为「下载」→ 默认取 data["下载"]
 *        - 兜底也认 data["download"]（若未来配置改名键）
 *        - 每项为“文件名去扩展名的名字键”，删除接口需要的正是这个值
 *   2. 单选渲染；仅一项被选中时「删除」按钮可用
 *   3. 二级确认弹窗（显示文件名 + 不可撤销）→ 确认后
 *   4. POST /delmusic  body {"name": "<名字键>"}  contentType: application/json
 *        - 形参与 content-type 与 downloadtool.html 惯用（$.ajax contentType
 *          application/json + JSON.stringify）一致；这里用 fetch 复刻同样 wire，
 *          且把 Accept 设为 application/json（后端回裸字符串 "success"，FastAPI
 *          JSONResponse 包裹为带引号的字符串）
 *   5. 删除后重 GET /musiclist —— 判定成功以“该键从「下载」组消失”为准
 *        （del_music 可能因名字缺失/物理删失败而静默返回 "success"，不能信任响应体，
 *         见 doc_backend §1/§3 —— 这是本页的关键校验逻辑）
 *   6. 确认删除成功后，另 POST /refreshmusictag 洗掉 cache/tag_cache.json 残留旧标签
 *        （doc_backend §4：delmusic 只 os.remove download/*.mp3，不自动清 tag_cache；
 *         /refreshmusictag 才把 tag_cache 重建到现盘集合）。清单这一步为"接残影"补救，
 *         不改变删除成功/失败的判据（以第 5 步键是否消失为准）。
 *
 * 鉴权（doc_frontend §3）：
 *   - static 与 /musiclist 同由 AuthStaticFiles/verification 与会话 cookie 保护。
 *   - 若某一步收到 401/403（会话失效/凭据错），本页不发删除，给出提示并提供
 *     「跳转触发 Basic 鉴权」入口：对仍要求鉴权的根路径做一次顶层导航，浏览器
 *     会弹出 HTTP Basic 凭据框；通过后刷新本页继续。
 * ========================================================================= */
(function () {
  "use strict";

  var DOMAIN_KEY_DOWNLOAD = "下载";   // music_library gen 时 download/ 目录组的键名
  var DOMAIN_KEY_RAW = "download";    // 兜底：若该键名未随内核改名
  var URL_MUSICLIST = "/musiclist";
  var URL_DELMUSIC = "/delmusic";
  // tag_cache 残留清洁端点的取舍（依据 doc_backend §4 实测结论）：
  //   - POST /refreshmusictag  -> music_library.refresh_music_tag；会把 cache/tag_cache.json 整 dump {} 后按现盘文件重建，
  //     因此"删某首歌后残留的旧标签条目"由这一支真正洗掉（doc_backend §4）。
  //   - POST /api/music/refreshlist -> 只是 gen_music_list() 刷"列表/播放缓存"（doc_backend L341），不碰 tag_cache。
  // 删除确认流完成后要清的正是 tag_cache 残留 ⇒ 选 /refreshmusictag 并注释（另两者之一不具备清 tag 语义）。
  var URL_REFRESH_TAG = "/refreshmusictag";
  // 顶层导航会触发浏览器 Basic 鉴权对话框的“受保护”URL（同一 AuthStaticFiles）
  var URL_AUTH_TRIGGER = "/static/default/index.html";

  /* ---------- DOM ---------- */
  var $status = document.getElementById("dt-status");
  var $hint = document.getElementById("dt-hint");
  var $list = document.getElementById("dt-list");
  var $count = document.getElementById("dt-count");
  var $deleteBtn = document.getElementById("dt-delete-btn");
  var $modal = document.getElementById("dt-modal");
  var $modalName = document.getElementById("dt-modal-name");
  var $cancelBtn = document.getElementById("dt-cancel-btn");
  var $confirmBtn = document.getElementById("dt-confirm-btn");

  var currentSongs = [];   // {name: <名字键>}
  var selectedName = null;

  /* ---------- 小工具 ---------- */
  function setStatus(kind, text, withRetry) {
    $status.hidden = false;
    $status.className = "dt-status dt-status-" + kind;
    $status.textContent = text || "";
    var rb = $status.querySelector("button.dt-retry");
    if (rb) rb.parentNode.removeChild(rb);
    if (withRetry && kind === "error") {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "dt-retry";
      b.textContent = "重试";
      b.addEventListener("click", loadList);
      $status.appendChild(b);
    }
    return $status;
  }
  function clearStatus() {
    $status.hidden = true;
    $status.textContent = "";
  }
  function showHint(html) {
    $hint.hidden = false;
    $hint.innerHTML = html;
  }
  function hideHint() {
    $hint.hidden = true;
    $hint.innerHTML = "";
  }
  function setCount(s) {
    $count.hidden = !s;
    if (s) $count.textContent = s;
  }

  function normalizeItem(item) {
    if (typeof item === "string") return item;
    if (item && typeof item === "object") {
      return (item.name || item.title || item.id || JSON.stringify(item));
    }
    return String(item);
  }

  /* ---------- 请求封装：统一鉴权/网络错误处理 ---------- */
  function apiReq(method, url, body) {
    var opts = {
      method: method,
      headers: { Accept: "application/json" },
      credentials: "same-origin"   // 带上同源会话 cookie（xiaomusic_auth_session）
    };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    return fetch(url, opts).then(function (res) {
      if (res.status === 401 || res.status === 403) {
        var e = new Error("auth");
        e.auth = true;
        throw e;
      }
      if (!res.ok) {
        throw new Error("HTTP " + res.status);
      }
      return res.text().then(function (t) {
        // 响应可能是 JSON 字符串或纯文本；尽力统一成可读字符串
        if (!t) return "";
        if (t[0] === '"') { try { return JSON.parse(t); } catch (x) { return t; } }
        try { JSON.parse(t); return JSON.parse(t); } catch (x) { return t; }
      });
    });
  }

  /* ---------- 鉴权失败界面 ---------- */
  function showAuthError() {
    setStatus("error", "鉴权未通过 / 会话已失效（401/403）。此页面需要已登录的小爱音箱会话存取 /musiclist。");
    showHint("点击下方按钮将跳转到受保护页面以触发浏览器 HTTP Basic 登录框；登录成功后请返回本页重试。");
    var go = document.createElement("button");
    go.id = "dt-auth-go";
    go.type = "button";
    go.className = "dt-btn";
    go.textContent = "触发一次 Basic 登录后返回";
    go.addEventListener("click", function () {
      window.location.href = URL_AUTH_TRIGGER;
    });
    $status.appendChild(go);
  }

  /* ---------- 拉取并渲染「已下载」名单 ---------- */
  function extractDownloadList(data) {
    if (!data || typeof data !== "object") return null;
    if (Array.isArray(data[DOMAIN_KEY_DOWNLOAD])) return data[DOMAIN_KEY_DOWNLOAD];
    if (Array.isArray(data[DOMAIN_KEY_RAW])) return data[DOMAIN_KEY_RAW];
    return null;
  }

  function loadList() {
    clearStatus(); hideHint(); setCount("");
    $list.innerHTML = "";            // 渲染占位
    var li = document.createElement("li");
    li.className = "dt-loading";
    li.textContent = "加载已下载列表中…";
    $list.appendChild(li);
    resetSelection();

    apiReq("GET", URL_MUSICLIST).then(function (data) {
      var raw = extractDownloadList(data);
      if (!raw) {
        $list.innerHTML = "";
        setStatus("error", "接口返回里找不到「已下载」分组（预期键 “下载” 或 “download”）。可能是 /musiclist 返回结构随内核变化。");
        return;
      }
      buildFromRaw(raw);
    }).catch(function (err) {
      if (err && err.auth) { showAuthError(); return; }
      $list.innerHTML = "";
      setStatus("error", "加载已下载列表失败：" + (err && err.message ? err.message : "网络错误") + "。请确认后端可达后重试。", true);
    });
  }

  // 把名字键数组转成 {name} 列表并绘制。顶层初始加载用（会摆一条友好 info 状态条）。
  function buildFromRaw(rawArr) {
    currentSongs = rawArr.map(normalizeItem)
      .filter(function (n) { return !!n && n !== "undefined"; })
      .map(function (n) { return { name: String(n) }; });
    if (currentSongs.length) {
      setStatus("info", "已加载 " + currentSongs.length + " 首已下载歌曲。单选一首后可删除（不支持批量/一键清空）。");
    }
    paintList(currentSongs, true);
  }

  // 纯绘制名单 DOM + 计数；setEmpty 置状态条为“空/仅提示”
  function paintList(songs, setEmpty) {
    $list.innerHTML = "";
    if (!songs.length) {
      setCount("");
      if (setEmpty) setStatus("info", "暂无已下载歌曲。download/ 目录为空或不含受支持音乐文件。");
      return;
    }
    setCount("共 " + songs.length + " 首（download 区）");

    songs.forEach(function (s) {
      var li = document.createElement("li");
      li.className = "dt-item";
      li.setAttribute("data-name", s.name);

      var label = document.createElement("label");
      label.className = "dt-row";
      // 展示：名字键（前端可见名）+ 它是 download 区的名字键（去扩展名）
      label.innerHTML =
        '<span class="dt-radio-wrap"><input type="radio" name="dt-song" value=""></span>' +
        '<span class="dt-song-name"></span>' +
        '<span class="dt-meta">download 区 · 整首文件</span>';
      var radio = label.querySelector("input");
      radio.value = s.name;
      label.querySelector(".dt-song-name").textContent = s.name;

      li.appendChild(label);
      li.addEventListener("click", function () {
        radio.checked = true;
        selectSong(s.name);
      });
      $list.appendChild(li);
    });
  }

  function selectSong(name) {
    selectedName = name;
    $deleteBtn.disabled = false;
  }
  function resetSelection() {
    selectedName = null;
    $deleteBtn.disabled = true;
    Array.prototype.forEach.call(document.querySelectorAll('#dt-list input[name="dt-song"]'),
      function (r) { r.checked = false; });
  }

  /* ---------- 二级确认弹窗 → 发删除 ---------- */
  var _confirmOnClick = null;   // 当前挂到【确认删除】上的“发请求”闭包

  function openModal() {
    if (!selectedName) return;
    $modalName.textContent = selectedName;
    $confirmBtn.textContent = "确认删除";
    closeModalHandlers();                 // 清掉可能残留的旧处理器再重挂一次
    _confirmOnClick = function () { sendDelete(selectedName); };
    $confirmBtn.addEventListener("click", _confirmOnClick);
    $confirmBtn.disabled = false;
    $modal.hidden = false;
  }
  function closeModal() {
    $modal.hidden = true;
    closeModalHandlers();
    $confirmBtn.disabled = false;
  }
  function closeModalHandlers() {
    if (_confirmOnClick) {
      $confirmBtn.removeEventListener("click", _confirmOnClick);
      _confirmOnClick = null;
    }
  }

  function sendDelete(name) {
    if (!name) return;
    // 点击【确认删除】即完成二次确认 → 关闭弹窗并真正发删除
    closeModal();
    $deleteBtn.disabled = true;
    setStatus("info", "正在永久删除 “" + name + "” …");

    apiReq("POST", URL_DELMUSIC, { name: name }).then(function () {
      // 响应不可信（永远 "success"，名字不存在/删失败也只回 success）→
      // 重新取名单确认该键消失才是“真删”判据（doc_backend §1/§3）
      return verifyGone(name).then(function (gone) {
        if (gone) {
          // 键已从「下载」名单消失 = 真删成功（以名单为准）。随后补一发
          // /refreshmusictag 洗掉 cache/tag_cache.json 残留旧条（doc_backend §4），
          // 属“擦残影”，不改变成功/失败判据。refreshmusictag 是整 dump {} 重扫
          // 全盘重建标签，可能较慢，故 fire-and-forget 并容忍其失败（失败仅换类提示）。
          resetSelection();
          return washTagCacheResidue().then(function () {
            setStatus("ok", "已删除 “" + name + "”，且 tag 缓存残影已随 /refreshmusictag 一并清洗。该曲已从已下载(download)名单消失。");
          }).catch(function () {
            setStatus("ok", "已删除 “" + name + "”（已从已下载名单消失）。但 tag 缓存清洗(/refreshmusictag)未成功，歌曲标签里可能短暂残留该歌条目。");
          });
        } else {
          currentSongs = currentSongs.filter(function (s) { return s.name !== name; });
          paintList(currentSongs, false);
          setStatus("warn", "删除请求已发出（/delmusic 返回 200 success），但刷新名单后该曲仍在。内核重扫可能未收敛；请勿重复狂点删除同名单曲，稍候刷新查看。");
        }
      });
    }).catch(function (err) {
      if (err && err.auth) { showAuthError(); return; }
      // 未能确认成功删除：保留旧名单原样，仅提示，让用户自查重试
      paintList(currentSongs, false);
      setStatus("error", "删除请求失败：" + (err && err.message ? err.message : "网络错误") + "，未确认删除。", true);
    });
  }

  // 删除后重新 GET /musiclist：判定“该键是否消失”，并用最新名单重绘 DOM
  function verifyGone(name) {
    return apiReq("GET", URL_MUSICLIST).then(function (data) {
      var raw = extractDownloadList(data);
      if (!raw) return true;                       // 取不到名单则保守当作“没了”，避免误报仍存在
      currentSongs = raw.map(normalizeItem)
        .filter(function (n) { return !!n && n !== "undefined"; })
        .map(function (n) { return { name: String(n) }; });
      paintList(currentSongs, false);              // 只画 DOM/计数，不覆盖后续结果状态
      return currentSongs.filter(function (s) { return s.name === name; }).length === 0;
    });
  }

  // 删除成功后补洗 tag_cache 残留。POST /refreshmusictag（music.py:322）＝把
  // cache/tag_cache.json dump {} 后按现盘文件全量重建标签，是 doc_backend §4 实证里
  // 唯一真正清掉“已删歌旧标签条”的端点；/api/music/refreshlist(L341)只 gen_music_list
  // 不碰 tag_cache，故这里选前者。返回一个可 then/catch 的 Promise，不影响删除判据。
  function washTagCacheResidue() {
    return apiReq("POST", URL_REFRESH_TAG);
  }

  /* ---------- 事件接线 ---------- */
  $deleteBtn.addEventListener("click", openModal);
  $cancelBtn.addEventListener("click", closeModal);
  $modal.addEventListener("click", function (e) { if (e.target === $modal) closeModal(); });
  window.addEventListener("keydown", function (e) { if (e.key === "Escape" && !$modal.hidden) closeModal(); });

  // 初始化自动加载
  loadList();
})();
