#!/usr/bin/env bash
# =============================================================================
# unpatch_xtools.sh — 回滚「插件上传接口」(xtools) 补丁
#
# 做的事：
#   1) 从 <容器>:/app/xiaomusic/api/routers/__init__.py 删除所有带 xtools_patch 标记的行，
#      并把 from ... import ( ... ) 里的 xtools, 一并去掉，恢复原状。
#   2) 删掉 <容器>:/app/xiaomusic/api/routers/xtools.py
#   3) docker restart 容器
#
# 用法：
#   ./unpatch_xtools.sh                 # 默认容器 xiaomusic
#   ./unpatch_xtools.sh -c myxiaomusic
#   ./unpatch_xtools.sh --dry-run
# =============================================================================

set -u

readonly MARK_PREFIX='xtools_patch'
readonly CONT_API_DIR='/app/xiaomusic/api/routers'
readonly CONT_INIT="$CONT_API_DIR/__init__.py"
readonly CONT_XTOOLS="$CONT_API_DIR/xtools.py"

CONTAINER="${CONTAINER:-xiaomusic}"
DRY_RUN=0

info() { printf '\033[0;36m[info]\033[0m %s\n' "$*"; }
warn() { printf '\033[0;33m[warn]\033[0m %s\n' "$*"; }
err()  { printf '\033[0;31m[error]\033[0m %s\n' "$*" >&2; }

while [ $# -gt 0 ]; do
  case "$1" in
    -c|--container) CONTAINER="$2"; shift 2 ;;
    --dry-run)      DRY_RUN=1; shift ;;
    -h|--help)      sed -n '2,16p' "$0"; exit 0 ;;
    *) err "未知参数: $1"; exit 2 ;;
  esac
done

command -v docker >/dev/null 2>&1 || { err "找不到 docker 命令"; exit 1; }
docker ps --format '{{.Names}}' | grep -qx "$CONTAINER" || {
  err "找不到运行中的容器「$CONTAINER」；用 -c <名> 指定"; exit 1; }

tmpd="$(mktemp -d "${TMPDIR:-/tmp}/${MARK_PREFIX}.unpatch.XXXXXX")" || { err "mktemp 失败"; exit 1; }
trap 'rm -rf "$tmpd"' EXIT

host_init="$tmpd/__init__.py"
docker cp "$CONTAINER:$CONT_INIT" "$host_init" >/dev/null 2>&1 || { err "拉取 __init__.py 失败"; exit 4; }

if ! grep -q "$MARK_PREFIX" "$host_init"; then
  info "未发现 $MARK_PREFIX 标记，补丁可能未打过。将仍然尝试删除 xtools.py。"
else
  python3 - "$host_init" <<'PY'
import re, sys
p = sys.argv[1]
s = open(p, encoding='utf-8').read()

# 1) 删除所有带标记的行
lines = [ln for ln in s.split('\n') if 'xtools_patch' not in ln]

# 2) 从 from ... import ( ... ) 块里去掉 xtools,
s2 = '\n'.join(lines)
m = re.search(r'(from xiaomusic\.api\.routers import \()([^)]*)(\))', s2)
if m:
    inner = m.group(2)
    keep = []
    for ln in inner.split('\n'):
        # 去掉整行就是 xtools, 的项
        if ln.strip() in ('xtools,', 'xtools'):
            continue
        keep.append(ln)
    # 去掉尾部的空白行，然后用 '\n' 重新拼装，保持 "import (\n    x,\n)" 的换行结构
    while keep and keep[-1].strip() == '':
        keep.pop()
    while keep and keep[0].strip() == '':
        keep.pop(0)
    s2 = s2[:m.start(2)] + '\n' + '\n'.join(keep) + '\n' + s2[m.end(2):]
open(p, 'w', encoding='utf-8').write(s2)
print("unpatched")
PY
  rc=$?
  [ "$rc" -eq 0 ] || { err "改写失败 rc=$rc"; exit 5; }

  if command -v python3 >/dev/null 2>&1; then
    python3 -m py_compile "$host_init" >/dev/null 2>&1 || { err "回滚后语法检查未通过！未写入。"; exit 6; }
    info "语法检查通过。"
  fi
fi

if [ "$DRY_RUN" -eq 1 ]; then
  info "[dry-run] 将执行:"
  info "  docker cp '$host_init' '$CONTAINER:$CONT_INIT'"
  info "  docker exec '$CONTAINER' rm -f '$CONT_XTOOLS'"
  info "  docker restart '$CONTAINER'"
  exit 0
fi

docker cp "$host_init" "$CONTAINER:$CONT_INIT" >/dev/null 2>&1 || { err "写回失败"; exit 7; }
docker exec "$CONTAINER" rm -f "$CONT_XTOOLS" >/dev/null 2>&1 || warn "删除 xtools.py 失败（可能本就不存在）"
info "重启容器..."
docker restart "$CONTAINER" >/dev/null 2>&1 || { err "docker restart 失败"; exit 8; }
info "已回滚。"
exit 0
