# 部署指南（Docker + 云主机）

目标：把 Atoms Demo 部署到一台可公网访问的 Linux 云主机，数据落盘持久化。

示例部署为 HTTP + IP 直连，未启用域名与 HTTPS；`Caddyfile` 与 compose 的 `tls` profile 为可选方案，可按需启用。

## 一、准备工作

| 项目 | 说明 |
| --- | --- |
| 服务器 | 一台 x86_64 Linux 云主机，已开放 SSH 与 HTTP 端口 |
| SSH 访问 | 建议使用密钥；将公钥加入服务器 `~/.ssh/authorized_keys` |
| 权限 | SSH 用户需为 root，或可免密 sudo |
| 模型 Key | 可选；不配置时自动进入 MOCK 演示模式 |

API Key 只写入服务器 `/opt/atoms/.env`（权限 600），不打进镜像、不进仓库、不下发前端。

## 二、一键部署

在本机 `atoms-app` 目录执行（把 `user@your-host` 换成自己的服务器地址）：

```bash
# 默认：HTTP + IP 直连
SSH_TARGET=user@your-host ./deploy/deploy.sh

# 使用私钥
SSH_TARGET=user@your-host SSH_KEY=~/.ssh/id_ed25519 ./deploy/deploy.sh

# 可选：启用域名 + Caddy 自动 HTTPS（需放行 80/443）
SSH_TARGET=user@your-host DOMAIN=app.example.com ./deploy/deploy.sh

# 部署后跑公网 smoke（会真实调用模型，耗时较长）
SSH_TARGET=user@your-host PUBLIC_URL=http://your-host RUN_SMOKE=1 ./deploy/deploy.sh
```

脚本按顺序执行：SSH 连通性检查 → 服务器初始化（swap / Docker / Compose / rsync）→ rsync 同步代码 → scp 上传 `.env` 并 `chmod 600` → `docker compose up -d --build` → 轮询 `/api/health`。

## 三、服务器初始化明细（`deploy/init-server.sh`）

1. 校验 root 与包管理器（apt / dnf / yum）。
2. 无 swap 时创建 `/swapfile`（默认 2G）并写入 `/etc/fstab`。
3. 安装 `rsync`、`curl`、`ca-certificates`，用 `get.docker.com` 安装 Docker，`systemctl enable --now docker`。
4. 确认 `docker compose` 插件可用（缺失时安装 `docker-compose-plugin`）。
5. 创建 `/opt/atoms` 目录；如主机 ufw 启用则放行 80/443/3000，否则提示在云服务商控制台放行。

## 四、架构与构建说明

- 目标机为 x86_64，镜像在服务器本地构建（`docker compose build`），不跨架构，无需 buildx。
- 基础镜像 `node:24-alpine` 多架构可用；运行时用 `tsx` 直接跑 TypeScript，`node:sqlite` 为 Node 内置模块，无原生编译依赖。
- `.dockerignore` 已排除 `.env`、`node_modules`、`dist`、`data`，Key 不会进入镜像层。
- 数据保存在命名卷 `atoms-data`（容器内 `/data/atoms.db`），`docker compose down` 不删除数据；仅 `down -v` 会删除。

## 五、部署后验证

```bash
curl http://your-host/api/health
# 期望：HTTP 200，mock=false（配置了模型 Key 时），providers 与 .env 一致

SMOKE_BASE_URL=http://your-host npm run smoke
# 覆盖：游客创建 → 双路生成 → 预览 → 发布 → 分享 KV
```

浏览器打开 `http://your-host`，完成「输入需求 → 双路候选 → 验收报告 → 发布」。

安全响应头与 Cookie 预期（HTTP 部署）：

```bash
curl -sI http://your-host/ | grep -Ei 'content-security-policy|x-frame-options|referrer-policy|permissions-policy|x-content-type-options|x-powered-by'
# 期望：5 类安全头齐全，且无 X-Powered-By

curl -sI http://your-host/api/me | grep -i set-cookie
# 期望：HttpOnly; SameSite=Lax；HTTP 下不带 Secure
```

## 六、常用运维

```bash
ssh user@your-host
cd /opt/atoms
docker compose ps
docker compose logs -f --tail=200 atoms
docker compose up -d --build      # 更新代码后重新部署（本机重跑 deploy.sh 亦可）
```

## 七、排障

- `health` 不通：先看 `docker compose ps` 与 `logs`，再确认云服务商控制台防火墙已放行对应端口。
- 模型报 402：供应商余额不足；充值后在 `.env` 调整 `LLM_PROVIDERS` 顺序并 `docker compose up -d`。
- 构建慢：首次 `npm ci` 受服务器带宽影响；重试即可，Docker 层缓存会生效。
