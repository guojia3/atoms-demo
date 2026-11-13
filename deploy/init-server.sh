#!/usr/bin/env bash
# 服务器初始化（Ubuntu/Debian 为主，CentOS 兼容）：swap、Docker、Compose、rsync、目录
# 用法（由 deploy.sh 通过 ssh 执行，也可登录服务器后手动 bash 执行）
#   APP_DIR=/opt/atoms bash init-server.sh
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/atoms}"
APP_OWNER="${APP_OWNER:-root}"
SWAP_SIZE="${SWAP_SIZE:-2G}"

echo "[1/5] 检查系统"
if [ "$(id -u)" -ne 0 ]; then
  echo "请用 root 或 sudo 执行" >&2
  exit 1
fi

if command -v apt-get >/dev/null 2>&1; then
  PKG=apt
elif command -v dnf >/dev/null 2>&1; then
  PKG=dnf
elif command -v yum >/dev/null 2>&1; then
  PKG=yum
else
  echo "未识别的包管理器（需要 apt/dnf/yum）" >&2
  exit 1
fi
echo "包管理器: $PKG"

echo "[2/5] 配置 swap（当前无 swap 时创建 $SWAP_SIZE）"
if swapon --show 2>/dev/null | grep -q .; then
  echo "已有 swap，跳过"
else
  fallocate -l "$SWAP_SIZE" /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "swap 已启用"
fi

echo "[3/5] 安装基础工具与 Docker"
if [ "$PKG" = "apt" ]; then
  apt-get update -y
  DEBIAN_FRONTEND=noninteractive apt-get install -y rsync curl ca-certificates
else
  "$PKG" install -y rsync curl ca-certificates
fi

if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose 插件缺失，尝试安装 docker-compose-plugin"
  if [ "$PKG" = "apt" ]; then
    apt-get install -y docker-compose-plugin
  else
    "$PKG" install -y docker-compose-plugin
  fi
fi
docker compose version

echo "[4/5] 准备应用目录 $APP_DIR"
mkdir -p "$APP_DIR"
if id "$APP_OWNER" >/dev/null 2>&1; then
  chown "$APP_OWNER:$APP_OWNER" "$APP_DIR"
  echo "目录属主：$APP_OWNER"
fi

echo "[5/5] 防火墙提示"
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw allow 3000/tcp
  echo "已放行 ufw 80/443/3000"
else
  echo "主机 ufw 未启用；请在云服务商控制台「防火墙」放行所需端口（示例部署使用 TCP 80）"
fi

echo "服务器初始化完成"
docker --version
docker compose version
