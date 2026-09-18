#!/bin/zsh
set -u
cd -- "$(dirname -- "$0")" || exit 1
XINGHE_NODE="$(command -v node 2>/dev/null || true)"
if [[ -z "$XINGHE_NODE" && -x "$HOME/.local/bin/node" ]]; then
  XINGHE_NODE="$HOME/.local/bin/node"
fi
if [[ -z "$XINGHE_NODE" ]]; then
  print '未找到 Node.js（服务端运行环境）。请安装 24.15 或更新的 24 系列版本后重试。'
  read -r '?按回车关闭窗口…'
  exit 1
fi
if ! "$XINGHE_NODE" -e 'const [major,minor]=process.versions.node.split(".").map(Number);process.exit((major===22&&minor>=23)||(major===24&&minor>=15)?0:1)'; then
  print '当前运行环境版本未受支持。本机启动支持 22.23 以上的 22 系列或 24.15 以上的 24 系列；建议安装 24 系列。'
  read -r '?按回车关闭窗口…'
  exit 1
fi
print '正在打开管理员密码恢复页面，请保持项目服务运行。'
"$XINGHE_NODE" deploy/admin-recovery.mjs
XINGHE_STATUS=$?
if (( XINGHE_STATUS != 0 )); then
  print '密码恢复入口未打开，请保留上面的错误信息。'
  read -r '?按回车关闭窗口…'
fi
exit "$XINGHE_STATUS"
