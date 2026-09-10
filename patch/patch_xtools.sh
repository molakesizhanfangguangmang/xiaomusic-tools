#!/usr/bin/env bash
# =============================================================================
# patch_xtools.sh — 给 xiaomusic 容器打上「插件上传接口」(xtools) 补丁
#
# 做的事（就两件，且都幂等）：
#   1) docker cp xtools.py  ->  <容器>:/app/xiaomusic/api/routers/xtools.py
#   2) 在 <容器>:/app/xiaomusic/api/routers/__init__.py 里插入带标记的两行：
#        from xiaomusic.api.routers import xtools   # xtools_patch
#        app.include_router(xtools.router, tags=["工具上传"])  # xtools_patch
#
# 幂等：已含 xtools_patch 标记则跳过，不重复插入。
# 回滚：unpatch_xtools.sh 按同一标记删除这两行并删掉 xtools.py。
# 安全：插入前先把 __init__.py 拉回宿主机备份（含时间戳），失败可原样放回。
#
# 用法：
#   ./patch_xtools.sh                     # 默认容器名 xiaomusic
#   ./patch_xtools.sh -c myxiaomusic
#   ./patch_xtools.sh --dry-run
# =============================================================================

set -u

readonly MARK_PREFIX='xtools_patch'
readonly CONT_API_DIR='/app/xiaomusic/api/routers'
readonly CONT_INIT="$CONT_API_DIR/__init__.py"
readonly CONT_XTOOLS="$CONT_API_DIR/xtools.py"

readonly PKG_DIR="$(cd "$(dirname "$0")" && pwd)"
readonly SRC_XTOOLS="$PKG_DIR/xtools.py"

CONTAINER="${CONTAINER:-xiaomusic}"
DRY_RUN=0

info() { printf '\033[0;36m[info]\033[0m %s\n' "$*"; }
warn() { printf '\033[0;33m[warn]\033[0m %s\n' "$*"; }
err()  { printf '\033[0;31m[error]\033[0m %s\n' "$*" >&2; }

while [ $# -gt 0 ]; do
  case "$1" in
    -c|--container) CONTAINER="$2"; shift 2 ;;
    --dry-run)      DRY_RUN=1; shift ;;
    -h|--help)      sed -n '2,22p' "$0"; exit 0 ;;
    *) err "未知参数: $1"; exit 2 ;;
  esac
done

[ -f "$SRC_XTOOLS" ] || { err "找不到同目录的 xtools.py（本脚本须与它在一起）"; exit 3; }
command -v docker >/dev/null 2>&1 || { err "找不到 docker 命令"; exit 1; }
docker ps --format '{{.Names}}' | grep -qx "$CONTAINER" || {
  err "找不到运行中的容器「$CONTAINER」；用 -c <名> 指定"; exit 1; }

tmpd="$(mktemp -d "${TMPDIR:-/tmp}/${MARK_PREFIX}.XXXXXX")" || { err "mktemp 失败"; exit 1; }
cleanup() { rm -rf "$tmpd"; }
trap cleanup EXIT

host_init="$tmpd/__init__.py"
stamp="$(date +%s)"

# 拉取容器内 __init__.py
if ! docker cp "$CONTAINER:$CONT_INIT" "$host_init" >/dev/null 2>&1; then
  err "拉取 $CONT_INIT 失败；该文件应存在于 v0.6.1 镜像中，请确认容器与版本"; exit 4
fi
grep -q '<html' "$host_init" && { err "$CONT_INIT 不是 python 文件？中止"; exit 4; }

# 备份（放宿主 CWD，便于出事手工放回）
bak="./__init__.py.bak_$stamp"
cp -p "$host_init" "$bak" 2>/dev/null || warn "备份到 $bak 失败（继续）"

if grep -q "$MARK_PREFIX" "$host_init"; then
  info "已含 $MARK_PREFIX 标记，补丁已打过，跳过插入。"
else
  info "插入两行注册代码（标记 $MARK_PREFIX）..."
  python3 - "$host_init" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding='utf-8').read()
imp = "from xiaomusic.api.routers import xtools  # xtools_patch\n"
inc = '    app.include_router(xtools.router, tags=["工具上传"])  # xtools_patch\n'
if '# xtools_patch' in s:
    print("already-patched"); sys.exit(0)

# 把 xtools 追加进既有的 from ... import ( ... ) 块
import re
m = re.search(r'from xiaomusic\.api\.routers import \(([^)]*)\)', s)
if m:
    inner = m.group(1)
    if 'xtools' not in inner:
        new_inner = inner.rstrip()
        if not new_inner.endswith(','):
            new_inner += ','
        new_inner += '\n    xtools,\n'
        s = s[:m.start(1)] + new_inner + s[m.end(1):]
else:
    # 没有括号块：在 def register_routers 前插一行独立 import
    idx = s.find('def register_routers')
    if idx < 0:
        print("anchor-missing"); sys.exit(3)
    s = s[:idx] + imp + s[idx:]

# 在 register_routers 函数体末尾插入 include_router
m2 = re.search(r'(def register_routers\(app\):.*?)(\n\ndef |\Z)', s, re.S)
if not m2:
    print("func-missing"); sys.exit(3)
body = m2.group(1)
if 'xtools.router' not in body:
    # 找到函数体最后一行的缩进
    lines = body.rstrip('\n').split('\n')
    lines.append('    app.include_router(xtools.router, tags=["工具上传"])  # xtools_patch')
    body_new = '\n'.join(lines) + '\n'
    s = s[:m2.start(1)] + body_new + s[m2.end(1):]

open(p, 'w', encoding='utf-8').write(s)
print("patched")
PY
  rc=$?
  if [ "$rc" -ne 0 ]; then
    err "插入失败（rc=$rc）；未改动容器内容。"
    exit 5
  fi
fi

# 校验语法（容器里有 python，用宿主 python 也行）——用宿主的 python3 编译检查
if command -v python3 >/dev/null 2>&1; then
  if ! python3 -m py_compile "$host_init" >/dev/null 2>&1; then
    err "改后的 __init__.py 语法检查未通过！已中止，未写入容器。原始备份见 $bak"
    exit 6
  fi
  info "语法检查通过。"
fi

if [ "$DRY_RUN" -eq 1 ]; then
  info "[dry-run] 将执行:"
  info "  docker cp '$SRC_XTOOLS' '$CONTAINER:$CONT_XTOOLS'"
  info "  docker cp '$host_init' '$CONTAINER:$CONT_INIT'"
  info "  docker restart '$CONTAINER'"
  info "[dry-run] 未做任何写入。"
  exit 0
fi

docker cp "$SRC_XTOOLS" "$CONTAINER:$CONT_XTOOLS" >/dev/null 2>&1 || { err "拷入 xtools.py 失败"; exit 7; }
docker cp "$host_init" "$CONTAINER:$CONT_INIT" >/dev/null 2>&1 || { err "写回 __init__.py 失败"; exit 7; }

info "文件就位，重启容器使其生效..."
docker restart "$CONTAINER" >/dev/null 2>&1 || { err "docker restart 失败"; exit 8; }

info "完成。稍候可验证： curl -s http://<host>:58090/api/xtools/list"
info "备份：$bak （如需回滚用 ./unpatch_xtools.sh）"
exit 0
