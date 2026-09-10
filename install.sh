#!/usr/bin/env bash
# =============================================================================
# install.sh — xiaomusic「工具区 + 插件上传接口」一键安装包
#
# 适用：hanxi/xiaomusic v0.6.1（本包只保证该版本）。跑在具备 docker 的宿主机上。
# 目标容器默认名 xiaomusic（用 -c/--container 或环境变量 CONTAINER 覆盖）。
#
# 本包做两件事，各自幂等、各自可回滚：
#   A. 静态工具区：把 static/xiaomusic_tools 整棵拷进容器，
#      在 default 主页尾部幂等插一行入口引用（标记 xtools_entry）。
#   B. 上传接口补丁：拷入 api/routers/xtools.py，并在 api/routers/__init__.py
#      里幂等插入两行注册（标记 xtools_patch）。这一步会改到 /app/xiaomusic 的
#      .py 文件——见下方「关于改 .py」。
#
# 关于改 .py（重要）：
#   B 步会给容器里的 api/routers/__init__.py 加两行。该文件 bake 在镜像里，
#   所以：容器重建(rm/compose up --force-recreate)会把它打回原版、上传接口随之消失，
#   重跑本脚本即可恢复。日常 start/stop/restart 不受影响。
#   本脚本改动前会：① 先备份 __init__.py 到宿主当前目录；② 对改后文件做语法检查，
#   不通过就中止、不写入。万一服务起不来：SSH 上宿主机、
#   docker cp 备份文件回去 + docker restart，即可恢复（见 uninstall.sh 说明）。
#
# 用法：
#   ./install.sh                 # 默认容器 xiaomusic
#   ./install.sh -c myxiaomusic
#   ./install.sh --no-patch      # 只装静态工具区，不打上传接口补丁
#   ./install.sh --dry-run
#   ./install.sh --force         # 越过「主页存在非本注入引用」护栏
# =============================================================================

set -u

readonly MARKER_TOKEN='xtools_entry'
readonly INJECT_LINE='<!--xtools_entry--><script src="/static/xiaomusic_tools/entry/tools-entry.js"></script>'

readonly PKG_DIR="$(cd "$(dirname "$0")" && pwd)"
readonly TREE_SRC="$PKG_DIR/static/xiaomusic_tools"
readonly CONT_STATIC='/app/xiaomusic/static'
readonly CONT_DEF_INDEX="$CONT_STATIC/default/index.html"

CONTAINER="${CONTAINER:-xiaomusic}"
DRY_RUN=0
FORCE=0
DO_PATCH=1

info() { printf '\033[0;36m[info]\033[0m %s\n' "$*"; }
warn() { printf '\033[0;33m[warn]\033[0m %s\n' "$*"; }
err()  { printf '\033[0;31m[error]\033[0m %s\n' "$*" >&2; }

usage() { sed -n '2,40p' "$0"; }

while [ $# -gt 0 ]; do
  case "$1" in
    -c|--container) CONTAINER="$2"; shift 2 ;;
    --no-patch)     DO_PATCH=0; shift ;;
    --dry-run)      DRY_RUN=1; shift ;;
    --force)        FORCE=1; shift ;;
    -h|--help)      usage; exit 0 ;;
    *) err "未知参数: $1"; usage; exit 2 ;;
  esac
done

[ -n "$CONTAINER" ] || { err "container 名不能为空"; exit 2; }
command -v docker >/dev/null 2>&1 || { err "找不到 docker 命令（本包需在能执行 docker 的宿主机上运行）"; exit 1; }
docker ps --format '{{.Names}}' | grep -qx "$CONTAINER" || {
  err "找不到正在运行的容器「$CONTAINER」。先用 docker ps 确认名字，再用 -c <名> 重试。"; exit 1; }

tmpd="$(mktemp -d "${TMPDIR:-/tmp}/xtools_install.XXXXXX")" || { err "mktemp 失败"; exit 1; }
trap 'rm -rf "$tmpd"' EXIT

# ---------------------------------------------------------------------------
# A. 静态工具区
# ---------------------------------------------------------------------------
info "目标容器: $CONTAINER  (dry-run=$DRY_RUN force=$FORCE patch=$DO_PATCH)"

[ -d "$TREE_SRC" ] || { err "缺少 static/xiaomusic_tools 目录（请勿单独移动 install.sh）"; exit 3; }

if [ "$DRY_RUN" -eq 1 ]; then
  info "[dry-run] 将执行: docker cp '$TREE_SRC' '$CONTAINER:$CONT_STATIC/'"
else
  docker cp "$TREE_SRC" "$CONTAINER:$CONT_STATIC/" >/dev/null 2>&1 \
    || { err "拷入静态工具区失败（容器内 $CONT_STATIC 是否可写？）"; exit 4; }
  info "静态工具区已拷入。"
fi

# 主页幂等插行
inject_index() {
  local host_src="$tmpd/index.html"
  if [ "$DRY_RUN" -eq 1 ]; then
    info "[dry-run] 将在 $CONT_DEF_INDEX 末尾幂等追加一行:"
    printf '        %s\n' "$INJECT_LINE"
    return 0
  fi
  if ! docker cp "$CONTAINER:$CONT_DEF_INDEX" "$host_src" >/dev/null 2>&1; then
    err "拉取主页 $CONT_DEF_INDEX 失败；请人工核对。"; return 4
  fi
  if ! grep -qi '<html' "$host_src"; then
    if [ "$FORCE" -eq 1 ]; then
      warn "--force：主页缺 <html>，仍继续插行（操作者确认无冲突）。"
    else
      err "主页不像 HTML（缺 <html>），为避免破坏内容已中止。必要时加 --force。"; return 2
    fi
  fi
  if grep -q "$MARKER_TOKEN" "$host_src"; then
    info "主页已含工具标记($MARKER_TOKEN)，跳过插行。"; return 0
  fi
  if grep -q 'tools-entry\.js' "$host_src"; then
    warn "主页已引用 tools-entry.js 但不带本标记（可能是旧版/手工加的）。"
    if [ "$FORCE" -eq 1 ]; then
      warn "--force：仍追加一行带标记引用。"
    else
      err "为避免插出重复入口已中止。确认无冲突后加 --force 重试。"; return 2
    fi
  fi
  if [ -s "$host_src" ] && [ "$(tail -c1 "$host_src" | od -An -tx1 | tr -d ' \n')" != '0a' ]; then
    printf '\n' >> "$host_src"
  fi
  printf '%s\n' "$INJECT_LINE" >> "$host_src"
  docker cp "$host_src" "$CONTAINER:$CONT_DEF_INDEX" >/dev/null 2>&1 \
    || { err "写回主页失败"; return 4; }
  info "主页已幂等追加一行入口引用。"
  return 0
}
if ! inject_index; then
  rc=$?; err "主页插行未完成(rc=$rc)。"; exit "$rc"
fi

# ---------------------------------------------------------------------------
# B. 上传接口补丁
# ---------------------------------------------------------------------------
if [ "$DO_PATCH" -eq 1 ]; then
  info "打上传接口补丁..."
  PATCH_SH="$PKG_DIR/patch/patch_xtools.sh"
  if [ ! -f "$PATCH_SH" ]; then
    warn "未找到 patch/patch_xtools.sh，跳过补丁（仅静态工具区已装）。"
  else
    if [ "$DRY_RUN" -eq 1 ]; then
      sh "$PATCH_SH" -c "$CONTAINER" --dry-run || { err "补丁预检失败"; exit 5; }
    else
      sh "$PATCH_SH" -c "$CONTAINER" || { err "补丁失败；静态工具区已装但上传接口未生效。"; exit 5; }
    fi
  fi
else
  info "--no-patch：跳过上传接口补丁。"
fi

# ---------------------------------------------------------------------------
# C. 重启（补丁脚本内部已重启；这里若只装静态也重启一次以刷新主页）
# ---------------------------------------------------------------------------
if [ "$DRY_RUN" -eq 1 ]; then
  info "[dry-run] 将执行: docker restart '$CONTAINER'（如补丁脚本已重启则跳过）"
  info "[dry-run] 未做任何写入。"
  exit 0
fi

if [ "$DO_PATCH" -eq 0 ]; then
  docker restart "$CONTAINER" >/dev/null 2>&1 || { err "docker restart 失败"; exit 6; }
  info "已重启。"
fi

info "完成。"
info "  工具区：  http://<host>:58090/static/xiaomusic_tools/index.html"
info "  上传工具： 上面的「工具」页里点「上传工具」，或直接 /static/xiaomusic_tools/upload-tool/index.html"
if [ "$DO_PATCH" -eq 1 ]; then
  info "  接口自检： curl -s http://<host>:58090/api/xtools/list"
fi
info "  卸载/回滚：./uninstall.sh"
exit 0
