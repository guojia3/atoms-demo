# Atoms Demo

输入一句话，生成一个**可运行、可交互、可验收、可发布**的单页应用。
面向「一句话生成应用」场景，完整实现：需求拆解 → 双路并行生成 → 浏览器沙箱实测 → 逐条验收 → 赛马择优 → 对最终胜者执行 QA 测试与验收映射 → 版本保存 → 公网分享。

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

无模型 Key 时：`MOCK_MODE=1` 或未配置供应商，自动使用内置模板（任务看板 / 习惯打卡 / 2048 / 番茄专注 / Markdown 笔记 / 记账本，按提示词自动路由），整条链路依然可用。

首页「推荐成品」来自种子账号 `seed-owner` 的 6 个已发布项目（一个品类一个入口），启动时自动补齐并幂等更新；已下线的种子成品在服务启动时从库中删除。

### 端到端冒烟

```bash
npm start                       # 另开终端
SMOKE_BASE_URL=http://localhost:3000 npm run smoke
```

覆盖：游客创建 → 双路候选 → 赛马择优 → 版本 v1 → 发布 `/s/:slug` → 访客 KV 持久化与隔离 → 编辑 v2 → 一键修复 v3。

内置成品回归（无头 Chrome + CDP，真实操作 6 个发布页并检查 375px、console、刷新持久化）：

```bash
MOCK_MODE=1 PORT=3300 DATABASE_PATH=/tmp/atoms-tpl-check.db npm start   # 或 npx tsx src/server/index.ts
QA_BASE=http://127.0.0.1:3300 node test/templates-check.mjs              # ONLY=kanban 可只跑单个
```

手机复测 BUG 回归（2048 分享页 375/390 布局、工作台/分享页 0 原生对话框、探针时效与评分）：

```bash
MOCK_MODE=1 PORT=3400 DATABASE_PATH=/tmp/atoms-mobile-bugs.db NODE_ENV=production npm start
QA_BASE=http://127.0.0.1:3400 node test/mobile-bugs-check.mjs            # 截图输出 test/results/bug2048-*.png
```

赛马策略与兜底回归（自带 fake-llm 与应用实例，覆盖首候选预览、45/90s、替换、KV 隔离、二维码兜底）：

```bash
node test/race-strategy-check.mjs
RACE_TEST_GRACE=45000 RACE_TEST_SLOW=60000 RACE_TEST_ONLY=1 node test/race-strategy-check.mjs  # 字面 45s 上限
```

QA 阶段回归（自带 fake-llm + 应用实例 + 无头 Chrome，覆盖 QA 通过、失败一键修复、两轮上限、刷新持久化、KV 隔离、无未执行行、预览不抢焦点、2048 只测实际功能）：

```bash
npm run build
node test/qa-stage-check.mjs
```

工作台阶段进度回归（无预览完整阶段列表、首候选后顶部细条、赛马等待、QA、验收、完成、失败/停止、375 折叠与展开）：

```bash
node test/stage-progress-check.mjs
```

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | 3000 | 服务端口 |
| `DATABASE_PATH` | `./data/atoms.db` | SQLite 路径，生产建议 `/data/atoms.db` |
| `MOCK_MODE` | 0 | `1` 强制演示模式 |
| `RACE_COUNT` | 2 | 候选路数：2 = 双路赛马，1 = 单路 |
| `RACE_GRACE_MS` | 45000 | 首候选就绪后等待其余候选的上限；到期取消慢候选 |
| `RACE_LOW_SCORE_GRACE_MS` | 90000 | 首候选得分低于 70 时自动放宽的等待上限 |
| `QA_ENABLED` | 1 | 浏览器 UI 在线时是否运行 QA 测试阶段；`0` 关闭 |
| `QA_TIMEOUT_MS` | 25000 | 服务端等待 QA 结果的上限（含刷新复验），超时回退探针 + 清单 |
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
- **登录页默认登录**：首次进入默认选中「登录」，可手动切换到「注册」；注册态保留可选昵称字段，两态文案与提交逻辑不变。
- **需求拆解**：规划智能体输出标题、页面、功能、数据、验收清单；清单进入后续逐条验收。
- **双路赛马**：并行生成 2 个候选（真实模型时按供应商轮换），各自静态检查 + 浏览器实测 + 清单打分，按总分择优保存。
- **沙箱预览**：`iframe srcdoc` + CSP，`sandbox` 不给 `allow-same-origin`；外部资源与网络请求被禁止。
- **浏览器实测**：注入 runtime 采集渲染、报错、点击后变化、localStorage 写入、375px 横向溢出，并模拟点击首/中/尾按钮。
- **数据持久化**：覆写沙箱内 `localStorage/sessionStorage`，批量同步到服务端 SQLite KV；所有者与分享访客按 scope 隔离。
- **版本与发布**：每次成功迭代生成完整快照版本；发布固定当前版本，`/s/:slug` 公开只读访问。
- **编辑迭代**：优先要求模型输出 `find/replace` 局部补丁，补丁无法唯一定位时自动回退全量重写；失败不覆盖当前版本。
- **点选编辑**：沙箱内点选元素后，把 selector、标签、文本与 HTML 片段作为上下文随修改要求提交。
- **一键修复**：QA 失败且未达上限时，将失败验收项 + QA 失败用例 + Console 报错整理成 fix 指令；最多 2 轮，每轮只复测失败用例 + 1 条冒烟并合并历史证据，2 轮后停在报告、不再提供修复。
- **QA 测试**：定稿并对最终胜者挂载预览后，在独立隐藏沙箱（375×800、空 KV、不同步）扫描实际 DOM，按“有什么测什么”生成 2–10 条确定性用例（加载/主流程/表单/键盘/删除/清空/刷新持久化/双击）；持久化用例回灌数据到全新文档验证恢复；逐条上报进度与结果，QA 结束卸载沙箱，不影响正式 KV 与预览焦点。
- **验收映射**：只收录“需求 → 已实现功能 → 已执行 QA 用例 → 结果”闭环的条目；非核心未实现直接省略，核心缺失触发修复，两轮后仍缺失则本次生成失败、不发布；分数只基于有 QA 证据的条目。
- **断线恢复**：SSE 运行事件带单调序号，内存缓冲 400 条，支持 `from` 回放；进程重启把 running 标记为 interrupted。
- **性能**：启动时对 JS/CSS/HTML 预生成 brotli + gzip（br 优先、gzip 回退），静态资源体积约 −73%~−82%；SSE 保持不压缩/不缓冲；探针管道候选 HTML/KV 并行拉取、隐藏沙箱共用稳定期、探针串行。
- **首候选预览（策略 A）**：首个候选通过静态检查后立即预览并标注“候选预览”；其余候选最多等 45s（首候选 <70 分自动放宽到 90s），到期真正 abort 慢请求；择优来源优先级 `model > mock > fallback`，早期交互只在胜者为该候选时合并到正式 KV。
- **工作台阶段进度**：预览区实时显示六阶段——需求规划 → 生成 → 赛马 → 测试 → 验收 → 完成。首候选前居中展示完整阶段列表与当前动作说明；首候选后收成顶部细条，不遮挡成品。375px 折叠为“当前：赛马 3/6”+ 细进度条，可展开查看六阶段；QA 跳过标“已跳过”，失败/停止不会误显示“完成”。
- **兜底一致性**：真实模型失败时只有明确命中 6 类内置模板才允许兜底，并标注“演示兜底”；二维码等未匹配需求不会被默认看板冒充，直接失败并提示重试。
- **界面设计**：参考 atoms.dev 官方产品的设计语言、原创实现——纸灰画布（`#f6f6f6`）+ 纯白表面 + 1px 描边 + 单一钴蓝强调（`#4267ff`）+ 胶囊控件 + 系统字体栈（IBM Plex Sans / SF Pro / PingFang），token 定义在 [src/client/styles.css](src/client/styles.css)，桌面/平板/手机三档响应式。

## 评分模型（100 分）

| 部分 | 分值 | 来源 |
| --- | --- | --- |
| 静态完整性 | 10 | doctype / 闭合 / 内联脚本 / viewport / 无外链 / 体积 |
| 浏览器实测 | 50 | 渲染 10、无报错 10、交互 15、持久化 10、移动端 5 |
| 验收清单 | 40 | 有模型时逐条判定；浏览器 UI 在线时改由 QA 用例证据映射，只计有已执行用例的条目 |

实测数据由客户端沙箱探针上报；服务端不内嵌无头浏览器，超时按 0 分继续收尾，保证任务不悬挂。QA 同样由浏览器隐藏沙箱执行并回传结果，无 UI 连接时自动跳过并沿用探针 + 清单评分。

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
src/server/mock/    无模型时的六套内置交互模板（src/server/mock/kinds/）
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
- QA 用例来自 DOM 启发式（按钮/输入/列表/存储/键盘声明），复杂手势、拖拽、Canvas 内部状态与业务规则漏洞可能漏判；不使用 localStorage 的持久化方式不覆盖。
- 阶段进度由当前 run 的 SSE 状态推导；report→done 很短时“验收”可能只在完成态中显示为已完成，不会停在验收；刷新已完成项目直接显示“完成”与版本/得分。
