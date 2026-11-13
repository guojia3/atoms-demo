#!/usr/bin/env bash
# 一键部署：初始化服务器 → rsync 代码 → 上传 .env → 构建启动 → 健康检查
#
# 用法：
#   SSH_TARGET=user@your-host ./deploy/deploy.sh
#   SSH_TARGET=user@your-host SSH_KEY=~/.ssh/id_ed25519 ./deploy/deploy.sh
#   SSH_TARGET=user@your-host DOMAIN=app.example.com ./deploy/deploy.sh   # 可选：启用 Caddy HTTPS
#   SSH_TARGET=user@your-host RUN_SMOKE=1 ./deploy/deploy.sh              # 部署后跑公网 smoke
#
# 说明：镜像在服务器（x86_64）本地构建，避免本机 arm64 与服务器架构不一致；
#      API Key 仅通过 scp 传入服务器 .env（chmod 600），不会写入镜像。
set -euo pipefail

cd "$(dirname "$0")/.."
GIT_COMMIT="${GIT_COMMIT:-$(git rev-parse --short HEAD)}"
APP_DIR="${APP_DIR:-/opt/atoms}"
SSH_PORT="${SSH_PORT:-22}"
SSH_TARGET="${SSH_TARGET:-}"
SSH_KEY="${SSH_KEY:-}"
APP_OWNER="${APP_OWNER:-${SSH_TARGET%@*}}"
HOST="${HOST:-${SSH_TARGET#*@}}"
PUBLIC_URL="${PUBLIC_URL:-http://$HOST:3000}"

if [ -z "$SSH_TARGET" ]; then
  echo "缺少 SSH_TARGET，例如：SSH_TARGET=user@your-host $0" >&2
  exit 1
fi
if [ ! -f .env ]; then
  echo "缺少 .env（需包含 LLM_PROVIDERS 等真实配置；可先 cp .env.example .env 再填写）" >&2
  exit 1
fi

SSH_OPTS=(-p "$SSH_PORT" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -o NumberOfPasswordPrompts=1)
SCP_OPTS=(-P "$SSH_PORT" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -o NumberOfPasswordPrompts=1)
if [ -n "$SSH_KEY" ]; then
  SSH_OPTS+=(-i "$SSH_KEY")
  SCP_OPTS+=(-i "$SSH_KEY")
fi

# 密码登录：通过 SSHPASS 环境变量交给 sshpass，脚本参数不落盘、不回显
SSH_PASSWORD="${SSH_PASSWORD:-}"
if [ -n "$SSH_PASSWORD" ]; then
  if ! command -v sshpass >/dev/null 2>&1; then
    echo "已提供 SSH_PASSWORD 但缺少 sshpass：macOS 可 brew install sshpass" >&2
    exit 1
  fi
  export SSHPASS="$SSH_PASSWORD"
  SSH_CMD=(sshpass -e ssh "${SSH_OPTS[@]}" "$SSH_TARGET")
  SCP_CMD=(sshpass -e scp "${SCP_OPTS[@]}")
  RSYNC_RSH="sshpass -e ssh ${SSH_OPTS[*]}"
else
  SSH_CMD=(ssh "${SSH_OPTS[@]}" "$SSH_TARGET")
  SCP_CMD=(scp "${SCP_OPTS[@]}")
  RSYNC_RSH="ssh ${SSH_OPTS[*]}"
fi

REMOTE_SUDO=""
if [ "$APP_OWNER" != "root" ]; then
  REMOTE_SUDO="sudo -n"
fi

echo "== 1/6 检查 SSH 连通 =="
"${SSH_CMD[@]}" "echo connected: \$(hostname) \$(uname -m)"

echo "== 2/6 服务器初始化（swap / Docker / Compose / rsync）=="
"${SSH_CMD[@]}" "$REMOTE_SUDO env APP_DIR='$APP_DIR' APP_OWNER='$APP_OWNER' bash -s" < deploy/init-server.sh

echo "== 3/6 同步代码（排除 .env / data / node_modules / dist）=="
rsync -az --delete \
  --exclude '.env' --exclude '.env.local' \
  --exclude 'node_modules' --exclude 'dist' --exclude 'data' \
  --exclude '.git' --exclude '*.log' \
  -e "$RSYNC_RSH" \
  ./ "$SSH_TARGET:$APP_DIR/"

echo "== 4/6 上传 .env 并收紧权限 =="
"${SCP_CMD[@]}" .env "$SSH_TARGET:$APP_DIR/.env"
"${SSH_CMD[@]}" "chmod 600 '$APP_DIR/.env'"

echo "== 5/6 构建并启动（GIT_COMMIT=$GIT_COMMIT）=="
if [ -n "${DOMAIN:-}" ]; then
  if [ -n "$REMOTE_SUDO" ]; then
    "${SSH_CMD[@]}" "cd '$APP_DIR' && sudo -n env DOMAIN='$DOMAIN' GIT_COMMIT='$GIT_COMMIT' docker compose --profile tls up -d --build"
  else
    "${SSH_CMD[@]}" "cd '$APP_DIR' && DOMAIN='$DOMAIN' GIT_COMMIT='$GIT_COMMIT' docker compose --profile tls up -d --build"
  fi
else
  if [ -n "$REMOTE_SUDO" ]; then
    "${SSH_CMD[@]}" "cd '$APP_DIR' && sudo -n env GIT_COMMIT='$GIT_COMMIT' docker compose up -d --build"
  else
    "${SSH_CMD[@]}" "cd '$APP_DIR' && GIT_COMMIT='$GIT_COMMIT' docker compose up -d --build"
  fi
fi

echo "== 6/6 健康检查 $PUBLIC_URL/api/health =="
for i in $(seq 1 40); do
  if curl -fsS --max-time 5 "$PUBLIC_URL/api/health" > /tmp/atoms-health.json 2>/dev/null; then
    cat /tmp/atoms-health.json
    echo
    echo "部署完成：$PUBLIC_URL"
    break
  fi
  if [ "$i" -eq 40 ]; then
    echo "健康检查超时，请检查：$SSH_TARGET 'cd $APP_DIR && $REMOTE_SUDO docker compose logs --tail=100'" >&2
    exit 1
  fi
  sleep 3
done

if [ "${RUN_SMOKE:-0}" = "1" ]; then
  echo "== 附加：公网 smoke（真实模型，耗时较长）=="
  SMOKE_BASE_URL="$PUBLIC_URL" npm run smoke
fi
