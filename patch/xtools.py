"""xiaomusic_tools 插件上传接口（xiaomusic-tools 工具区的上传/卸载端点）。

本文件属「xiaomusic-tools」增强包，独立于上游 hanxi/xiaomusic 代码。
仅新增一个 router 并在 api/routers/__init__.py 里注册；不改动上游任何既有逻辑。

能力：
    POST /api/xtools/upload      上传一个插件包（zip），解到 static/xiaomusic_tools/<id>/
    GET  /api/xtools/list        列出已安装插件
    POST /api/xtools/uninstall   卸载某个插件（删目录 + 从 tools.json 移除）

插件包格式（zip）：
    <pkg>/manifest.json   必填，{id, title, icon, desc, version, entry?}
    <pkg>/index.html      必填（入口页）
    <pkg>/tool.js         可选
    <pkg>/tool.css        可选
    <pkg>/...             其余任意静态文件

版本约束：只保证 hanxi/xiaomusic v0.6.1。版本不符时本接口整体拒绝服务（安全退出），
不影响音乐服务本身——它只是「不挂载」，绝不会导致启动失败。
"""

import io
import json
import os
import shutil
import zipfile

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

try:
    from xiaomusic import __version__ as XIAOMUSIC_VERSION
except Exception:  # 极端情况：包结构异动，安全退出（不阻断启动）
    XIAOMUSIC_VERSION = "unknown"

router = APIRouter()

# 只保证这个上游版本；其它版本一律拒绝（安全退出），避免在未知布局上写坏别人的容器。
SUPPORTED_VERSIONS = {"0.6.1"}

# 本 patch 自身的目录：<repo>/api/routers/xtools.py -> 上溯三级 = xiaomusic 包根
_XT_PKG_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TOOLS_DIR = os.path.join(_XT_PKG_ROOT, "static", "xiaomusic_tools")
TOOLS_JSON = os.path.join(TOOLS_DIR, "tools.json")

# 单包大小上限（防呆）：8 MiB
MAX_PKG_BYTES = 8 * 1024 * 1024
# id 允许的字符：字母数字短横下划线
import re

_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")


def _current_version() -> str:
    """运行时读取上游版本（不缓存，避免热更新/测试时读到旧值）。"""
    try:
        import xiaomusic

        return getattr(xiaomusic, "__version__", XIAOMUSIC_VERSION)
    except Exception:
        return XIAOMUSIC_VERSION


def _version_ok() -> bool:
    return _current_version() in SUPPORTED_VERSIONS


def _load_registry() -> dict:
    """读 tools.json；不存在或损坏时返回一个最小可写骨架。"""
    if not os.path.isfile(TOOLS_JSON):
        return {"version": 1, "items": []}
    try:
        with open(TOOLS_JSON, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return {"version": 1, "items": []}
        data.setdefault("version", 1)
        if not isinstance(data.get("items"), list):
            data["items"] = []
        return data
    except Exception:
        # 损坏时不覆盖，交给上层报错，避免把用户数据冲掉
        raise HTTPException(status_code=500, detail="tools.json 读取失败或格式损坏")


def _save_registry(reg: dict) -> None:
    os.makedirs(TOOLS_DIR, exist_ok=True)
    tmp = TOOLS_JSON + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(reg, f, ensure_ascii=False, indent=2)
    os.replace(tmp, TOOLS_JSON)


def _safe_members(zf: zipfile.ZipFile):
    """过滤 zip 成员，拒绝绝对路径与 ../ 越界（zip slip），返回 (zipinfo, 归一化相对路径)。"""
    out = []
    for info in zf.infolist():
        name = info.filename
        if not name or name.endswith("/"):
            continue
        # 统一分隔符
        raw = name.replace("\\", "/")
        # 拒绝对路径（Windows 盘符如 C:/ 也算）
        if raw.startswith("/") or re.match(r"^[A-Za-z]:", raw):
            raise HTTPException(status_code=400, detail=f"插件包内含非法路径: {name}")
        # 归一化：去掉开头的 "./"（但保留前导斜杠判断已在上面做完）
        norm = raw
        while norm.startswith("./"):
            norm = norm[2:]
        parts = norm.split("/")
        # 拒绝任何 .. 段（越界）与空段（连续斜杠等异常）
        if any(p == ".." for p in parts):
            raise HTTPException(status_code=400, detail=f"插件包内含非法路径: {name}")
        norm = "/".join(p for p in parts if p not in ("", "."))
        if not norm:
            continue
        out.append((info, norm))
    return out


def _strip_common_prefix(paths):
    """若包内所有文件都在同一个顶层目录下（如 pkg/…），返回该前缀以便剥掉。"""
    if not paths:
        return ""
    first_seg = paths[0].split("/")[0]
    for p in paths:
        if p.split("/")[0] != first_seg:
            return ""
    return first_seg + "/"


@router.get("/api/xtools/list", summary="列出已安装的 xiaomusic-tools 插件")
async def xtools_list():
    if not _version_ok():
        raise HTTPException(
            status_code=503,
            detail=f"xiaomusic-tools 上传接口仅支持 xiaomusic {sorted(SUPPORTED_VERSIONS)}，"
                   f"当前版本 {_current_version()}，已自动停用。",
        )
    reg = _load_registry()
    return {"ok": True, "version": _current_version(), "items": reg.get("items", [])}


@router.post("/api/xtools/upload", summary="上传并安装一个 xiaomusic-tools 插件包(zip)")
async def xtools_upload(file: UploadFile = File(...), overwrite: bool = Form(False)):
    if not _version_ok():
        raise HTTPException(
            status_code=503,
            detail=f"xiaomusic-tools 上传接口仅支持 xiaomusic {sorted(SUPPORTED_VERSIONS)}，"
                   f"当前版本 {_current_version()}，已自动停用。",
        )

    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="空文件")
    if len(raw) > MAX_PKG_BYTES:
        raise HTTPException(status_code=413, detail=f"包过大（上限 {MAX_PKG_BYTES // 1024 // 1024} MiB）")

    try:
        zf = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile:
        raise HTTPException(status_code=400, detail="不是有效的 zip 文件")

    members = _safe_members(zf)
    names = [n for _, n in members]
    prefix = _strip_common_prefix(names)

    # 找 manifest.json（允许位于被剥离的顶层目录之下）
    if (prefix + "manifest.json") not in names and "manifest.json" not in names:
        raise HTTPException(status_code=400, detail="插件包缺少 manifest.json")
    mf_path = prefix + "manifest.json" if (prefix + "manifest.json") in names else "manifest.json"
    try:
        manifest = json.loads(zf.read(mf_path).decode("utf-8"))
    except Exception:
        raise HTTPException(status_code=400, detail="manifest.json 不是合法 JSON")

    pid = str(manifest.get("id") or "").strip()
    if not _ID_RE.match(pid):
        raise HTTPException(status_code=400, detail="manifest.id 缺失或非法（限字母数字-_，≤64）")

    title = str(manifest.get("title") or pid)
    icon = str(manifest.get("icon") or "🧰")
    desc = str(manifest.get("desc") or "")
    entry = str(manifest.get("entry") or "index.html")
    ver = str(manifest.get("version") or "")

    if (prefix + entry) not in names and entry not in names:
        raise HTTPException(status_code=400, detail=f"manifest.entry 指向的文件不存在: {entry}")

    target_dir = os.path.join(TOOLS_DIR, pid)
    if os.path.isdir(target_dir) and not overwrite:
        raise HTTPException(status_code=409, detail=f"插件 {pid} 已存在（可用 overwrite=true 覆盖）")

    # 解包（先解到临时目录再原子替换，失败不留下半截）
    staging = target_dir + ".__staging__"
    if os.path.isdir(staging):
        shutil.rmtree(staging, ignore_errors=True)
    os.makedirs(staging, exist_ok=True)
    try:
        for info, norm in members:
            rel = norm[len(prefix):] if prefix and norm.startswith(prefix) else norm
            if not rel:
                continue
            dest = os.path.join(staging, rel)
            # 二次边界校验
            if not os.path.abspath(dest).startswith(os.path.abspath(staging) + os.sep):
                raise HTTPException(status_code=400, detail=f"非法落点: {rel}")
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with zf.open(info) as src, open(dest, "wb") as out:
                shutil.copyfileobj(src, out)
    except HTTPException:
        shutil.rmtree(staging, ignore_errors=True)
        raise

    if os.path.isdir(target_dir):
        shutil.rmtree(target_dir, ignore_errors=True)
    os.rename(staging, target_dir)

    # 注册进 tools.json
    reg = _load_registry()
    items = reg["items"]
    url = f"/static/xiaomusic_tools/{pid}/{entry}"
    entry_item = {
        "id": pid,
        "title": title,
        "icon": icon,
        "url": url,
        "desc": desc,
        "disabled": False,
    }
    replaced = False
    for i, it in enumerate(items):
        if isinstance(it, dict) and it.get("id") == pid:
            items[i] = entry_item
            replaced = True
            break
    if not replaced:
        items.append(entry_item)
    _save_registry(reg)

    return {
        "ok": True,
        "id": pid,
        "title": title,
        "version": ver,
        "url": url,
        "replaced": replaced,
        "installed_at": target_dir,
    }


@router.post("/api/xtools/uninstall", summary="卸载一个 xiaomusic-tools 插件")
async def xtools_uninstall(id: str = Form(...)):
    if not _version_ok():
        raise HTTPException(
            status_code=503,
            detail=f"xiaomusic-tools 上传接口仅支持 xiaomusic {sorted(SUPPORTED_VERSIONS)}，"
                   f"当前版本 {_current_version()}，已自动停用。",
        )

    pid = (id or "").strip()
    if not _ID_RE.match(pid):
        raise HTTPException(status_code=400, detail="id 非法")

    target_dir = os.path.join(TOOLS_DIR, pid)
    if not os.path.isdir(target_dir):
        raise HTTPException(status_code=404, detail=f"未找到插件 {pid}")

    shutil.rmtree(target_dir, ignore_errors=True)

    reg = _load_registry()
    before = len(reg["items"])
    reg["items"] = [it for it in reg["items"] if not (isinstance(it, dict) and it.get("id") == pid)]
    _save_registry(reg)

    return {"ok": True, "id": pid, "removed": before - len(reg["items"])}
