# Atoms Demo

输入一句话，生成一个**可运行、可交互、可验收、可发布**的单页应用。
面向「一句话生成应用」场景，完整实现：需求拆解 → 双路并行生成 → 浏览器沙箱实测 → 逐条验收 → 赛马择优 → 版本保存 → 公网分享。

## 快速开始（本地）

要求 Node.js ≥ 24（使用内置 `node:sqlite`，无需原生编译）。

```bash
npm install
cp .env.example .env      # 可选；不配 Key 会自动进入 MOCK 模式
npm run dev               # 服务端 3000 + Vite 5173
# 打开 http://localhost:5173
```

生产模式（单进程，服务端托管构建产物）：

```bash
npm run build
npm start                 # 默认 http://localhost:3000
```

无模型 Key 时：`MOCK_MODE=1` 或未配置供应商，自动使用内置模板（任务看板 / 计算器 / 习惯打卡），整条链路依然可用。

### 端到端冒烟

```bash
npm start                       # 另开终端
SMOKE_BASE_URL=http://localhost:3000 npm run smoke
```

覆盖：游客创建 → 双路候选 → 赛马择优 → 版本 v1 → 发布 `/s/:slug` → 访客 KV 持久化与隔离 → 编辑 v2 → 一键修复 v3。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | 3000 | 服务端口 |
| `DATABASE_PATH` | `./data/atoms.db` | SQLite 路径，生产建议 `/data/atoms.db` |
| `MOCK_MODE` | 0 | `1` 强制演示模式 |
| `RACE_COUNT` | 2 | 候选路数：2 = 双路赛马，1 = 单路 |
| `PROBE_TIMEOUT_MS` | 15000 | 浏览器实测等待上限（按候选数累加） |
| `BODY_LIMIT` | 1mb | JSON 请求体上限，超出返回 413 |
| `GENERATION_RATE_LIMIT` | 20 | 每用户每小时生成次数（创建/编辑/修复/重试都计入），超限 429 + `Retry-After` |
| `PUBLIC_ORIGIN` | - | 额外允许的前端来源（逗号分隔，如 `https://app.example.com`）；同源始终放行 |
| `LLM_PROVIDERS` | - | JSON 数组，主备供应商（推荐） |
| `LLM_BASE_URL` / `LLM_MODELS` / `LLM_API_KEY` | - | 单供应商简化配置 |
| `DOMAIN` | - | 可选：Caddy 用域名。示例部署不采用（固定 HTTP + IP 直连） |

> **在线 Demo**：`http://43.143.42.252`（HTTP + IP 直连，示例部署未启用域名与 HTTPS）。`Caddyfile` 与 compose 的 `tls` profile 为可选方案，可按需启用。
> 安全：所有响应带 `X-Content-Type-Options`、`X-Frame-Options: DENY`、`Referrer-Policy`、`Permissions-Policy` 与 CSP（`frame-ancestors 'none'`）；状态变更请求校验 `Origin`/`Referer`（无来源的 curl/smoke 与服务端调用放行）。
> Cookie：会话 Cookie 始终 `HttpOnly + SameSite=Lax`；代码在 HTTPS（含反代 `X-Forwarded-Proto: https`）时自动加 `Secure`。**当前 HTTP + IP 交付下不会启用 `Secure`，属已知限制而非缺陷**（HTTP 下带 `Secure` 的 Cookie 会被浏览器直接丢弃）。

`LLM_PROVIDERS` 示例（第一个为主，失败自动切换）：

```env
LLM_PROVIDERS=[{"name":"deepseek","baseUrl":"https://api.deepseek.com/v1","apiKey":"","model":"deepseek-chat"},{"name":"qwen","baseUrl":"https://dashscope.aliyuncs.com/compatible-mode/v1","apiKey":"","model":"qwen-plus"}]
```

> Key 只存在于服务端进程内；`/api/config` 仅返回是否已配置，不暴露 Key 与 Base URL。

## 功能与实现

- **游客优先**：首次访问透明创建 guest 会话（HttpOnly Cookie），可随时升级为邮箱账号并保留项目。
- **需求拆解**：规划智能体输出标题、页面、功能、数据、验收清单；清单进入后续逐条验收。
- **双路赛马**：并行生成 2 个候选（真实模型时按供应商轮换），各自静态检查 + 浏览器实测 + 清单打分，按总分择优保存。
- **沙箱预览**：`iframe srcdoc` + CSP，`sandbox` 不给 `allow-same-origin`；外部资源与网络请求被禁止。
- **浏览器实测**：注入 runtime 采集渲染、报错、点击后变化、localStorage 写入、375px 横向溢出，并模拟点击首/中/尾按钮。
- **数据持久化**：覆写沙箱内 `localStorage/sessionStorage`，批量同步到服务端 SQLite KV；所有者与分享访客按 scope 隔离。
- **版本与发布**：每次成功迭代生成完整快照版本；发布固定当前版本，`/s/:slug` 公开只读访问。
- **编辑迭代**：优先要求模型输出 `find/replace` 局部补丁，补丁无法唯一定位时自动回退全量重写；失败不覆盖当前版本。
- **点选编辑**：沙箱内点选元素后，把 selector、标签、文本与 HTML 片段作为上下文随修改要求提交。
- **一键修复**：验收未通过时，将失败项 + Console 报错整理成 fix 指令，一键发起修复迭代。
- **断线恢复**：SSE 运行事件带单调序号，内存缓冲 400 条，支持 `from` 回放；进程重启把 running 标记为 interrupted。

## 评分模型（100 分）

| 部分 | 分值 | 来源 |
| --- | --- | --- |
| 静态完整性 | 10 | doctype / 闭合 / 内联脚本 / viewport / 无外链 / 体积 |
| 浏览器实测 | 50 | 渲染 10、无报错 10、交互 15、持久化 10、移动端 5 |
| 验收清单 | 40 | 有模型时逐条判定，无模型时按实测指标可解释映射 |

实测数据由客户端沙箱探针上报；服务端不内嵌无头浏览器，超时按 0 分继续收尾，保证任务不悬挂。

## 部署（国内云主机 + Docker）

一键部署（服务器初始化 + rsync + 上传 `.env` + 构建启动 + 健康检查）：

```bash
SSH_TARGET=user@your-host ./deploy/deploy.sh   # 替换为你的服务器地址
```

> `DOMAIN=app.example.com ./deploy/deploy.sh` 走 Caddy 自动 HTTPS，属可选方案。

详见 [deploy/README.md](deploy/README.md)。手动部署：

```bash
cp .env.example .env      # 填模型 Key（可选）
docker compose up -d --build
# http://<host>/（容器映射 80->3000；也可直连 3000，需防火墙放行）
```

- SQLite 与上传数据挂载在命名卷 `atoms-data` 的 `/data`；`docker compose down` 不会丢数据。
- 镜像在服务器（x86_64）本地构建；`.dockerignore` 保证 `.env` 不进入镜像层。
- HTTPS（域名 + Caddy + 443）为可选能力，示例部署未启用；如需启用：`.env` 设 `DOMAIN`、安全组放行 80/443，执行 `docker compose --profile tls up -d --build`。

## 目录

```
src/server/         Express + SQLite：认证、项目/版本、运行编排、SSE、分享、KV
src/server/agents/  planner / engineer / reviewer 三个智能体
src/server/verify/  静态检查与实测评分
src/server/mock/    无模型时的三套内置交互模板
src/client/         React 19 + Vite 6 + Tailwind v4：首页、工作区、分享页
src/shared/         沙箱 runtime（存储替身 / 错误采集 / 探针 / 点选）
script/smoke.ts     端到端冒烟
docs/说明文档.md     设计说明、取舍与验收记录
```

## 已知边界

- 无 Key 的演示模式只使用内置模板，编辑为「增量提示」而非真实语义修改；接入模型后启用补丁迭代。
- 分享页为公开只读（数据按访客隔离），未实现作者二次编辑分享版本的权限模型。
- 单机 SQLite + 内存事件缓冲，适合演示与单实例；多实例需换 Redis/Postgres 并做事件广播。
- 沙箱探针按「首/中/尾」采样按钮，复杂应用可能漏掉关键交互，报告会注明未收到实测。
