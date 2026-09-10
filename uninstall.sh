#!/usr/bin/env bash
# =============================================================================
# uninstall.sh — 卸载/回滚 xiaomusic「工具区 + 插件上传接口」
#
# 分两件，各自独立：
#   B. 撤上传接口补丁（默认做）：删掉 __init__.py 里带 xtools_patch 标记的行、
#      还原 import 块、删掉 api/routers/xtools.py，然后重启。
#   A. 撤静态工具区（默认不做）：删掉主页里带 xtools_entry 标记的那一行；
#      除非给 --remove-static，否则**保留** static/xiaomusic_tools 目录
#      （里面可能有你上传的插件，误删不可逆）。
#
# 用法：
#   ./uninstall.sh                  # 只撤接口补丁（保留工具区与主页入口）
#   ./uninstall.sh --no-patch       # 只处理主页入口，不动接口
#   ./uninstall.sh --remove-static  # 连 static/xiaomusic_tools 目录一起删除（谨慎）
#   ./uninstall.sh -c myxiaomusic
#   ./uninstall.sh --dry-run
# =============================================================================

set -u

readonly MARKER_TOKEN='xtools_entry'
readonly MARKER_PATCH='xtools_patch'
readonly CONT_STATIC='/app/xiaomusic/static'
readonly CONT_DEF_INDEX="$CONT_STATIC/default/index.html"
readonly CONT_TOOLS_DIR="$CONT_STATIC/xiaomusic_tools"

readonly PKG_DIR="$(cd "$(dirname "$0")" && pwd)"

CONTAINER="${CONTAINER:-xiaomusic}"
DRY_RUN=0
DO_PATCH=1
REMOVE_STATIC=0

info() { printf '\033[0;36m[info]\033[0m %s\n' "$*"; }
warn() { printf '\033[0;33m[warn]\033[0m %s\n' "$*"; }
err()  { printf '\033[0;31m[error]\033[0m %s\n' "$*" >&2; }

while [ $# -gt 0 ]; do
  case "$1" in
    -c|--container)  CONTAINER="$2"; shift 2 ;;
    --no-patch)      DO_PATCH=0; shift ;;
    --remove-static) REMOVE_STATIC=1; shift ;;
    --dry-run)       DRY_RUN=1; shift ;;
    -h|--help)       sed -n '2,22p' "$0"; exit 0 ;;
    *) err "未知参数: $1"; exit 2 ;;
  esac
done

command -v docker >/dev/null 2>&1 || { err "找不到 docker 命令"; exit 1; }
docker ps --format '{{.Names}}' | grep -qx "$CONTAINER" || {
  err "找不到运行中的容器「$CONTAINER」；用 -c <名> 指定"; exit 1; }

tmpd="$(mktemp -d "${TMPDIR:-/tmp}/xtools_uninstall.XXXXXX")" || { err "mktemp 失败"; exit 1; }
trap 'rm -rf "$tmpd"' EXIT

# ---------------------------------------------------------------------------
# B. 撤补丁
# ---------------------------------------------------------------------------
if [ "$DO_PATCH" -eq 1 ]; then
  UNPATCH="$PKG_DIR/patch/unpatch_xtools.sh"
  if [ -f "$UNPATCH" ]; then
    info "撤回上传接口补丁..."
    sh "$UNPATCH" -c "$CONTAINER" ${DRY_RUN:+$([ "$DRY_RUN" -eq 1 ] && echo --dry-run)} \
      || { err "撤补丁失败"; exit 4; }
  else
    warn "未找到 patch/unpatch_xtools.sh，跳过撤补丁。"
  fi
else
  info "--no-patch：跳过接口回滚。"
fi

# ---------------------------------------------------------------------------
# A. 主页入口 & 静态目录
# ---------------------------------------------------------------------------
host_src="$tmpd/index.html"
if docker cp "$CONTAINER:$CONT_DEF_INDEX" "$host_src" >/dev/null 2>&1; then
  if grep -q "$MARKER_TOKEN" "$host_src"; then
    if [ "$DRY_RUN" -eq 1 ]; then
      info "[dry-run] 将从主页删除含 $MARKER_TOKEN 的行"
    else
      grep -v "$MARKER_TOKEN" "$host_src" > "$tmpd/index.new" && \
        docker cp "$tmpd/index.new" "$CONTAINER:$CONT_DEF_INDEX" >/dev/null 2>&1 && \
        info "已从主页删除工具入口行。" || warn "主页入口行删除失败。"
    fi
  else
    info "主页无 $MARKER_TOKEN 标记，跳过。"
  fi
else
  warn "拉取主页失败，跳过入口清理。"
fi

if [ "$REMOVE_STATIC" -eq 1 ]; then
  if [ "$DRY_RUN" -eq 1 ]; then
    info "[dry-run] 将删除容器内 $CONT_TOOLS_DIR（含你上传的插件，不可逆）"
  else
    docker exec "$CONTAINER" rm -rf "$CONT_TOOLS_DIR" >/dev/null 2>&1 && \
      info "已删除 $CONT_TOOLS_DIR。" || warn "删除静态目录失败。"
  fi
else
  info "保留 static/xiaomusic_tools（含你上传的插件）；如需一并删除加 --remove-static。"
fi

if [ "$DRY_RUN" -eq 1 ]; then
  info "[dry-run] 未做任何写入。"; exit 0
fi

docker restart "$CONTAINER" >/dev/null 2>&1 || warn "docker restart 失败，请手动重启。"
info "回滚流程结束。"
exit 0
