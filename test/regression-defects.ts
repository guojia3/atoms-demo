/**
 * 缺陷回归：DEF-01/02/03/04/05/07/08 + Patch 校验与回退
 * 用法：npx tsx test/regression-defects.ts
 * 说明：脚本自带两套隔离服务（Mock 3300 / 假模型 3301 + fake-llm 3998），不修改 data/atoms.db
 */
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const PORT_MOCK = 3300
const PORT_FAKE = 3301
const PORT_LLM = 3998
const BASE_MOCK = `http://127.0.0.1:${PORT_MOCK}`
const BASE_FAKE = `http://127.0.0.1:${PORT_FAKE}`
const DB_MOCK = path.resolve('data/qa-regression-mock.db')
const DB_FAKE = path.resolve('data/qa-regression-fake.db')

const FULL_METRICS = {
  elements: 42,
  textLength: 600,
  errors: [] as string[],
  errorCount: 0,
  clicks: 5,
  mutations: 10,
  keys: 1,
  writes: 3,
  overflowX: false,
  width: 375,
  title: 'QA Regression',
  interactiveClicks: 3,
  simulatedClicks: 3,
  simulatedChanges: 3,
  simulatedWrites: 2,
}

class Jar {
  cookies = new Map<string, string>()

  absorb(res: Response): void {
    const list: string[] = (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() || []
    for (const sc of list) {
      const pair = sc.split(';')[0]
      const idx = pair.indexOf('=')
      if (idx > 0) this.cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim())
    }
  }

  header(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
  }
}

interface Reply {
  status: number
  json: any
  text: string
  headers: Headers
}

async function call(
  jar: Jar | null,
  base: string,
  method: string,
  route: string,
  opts: { body?: unknown; raw?: string; headers?: Record<string, string> } = {},
): Promise<Reply> {
  const headers: Record<string, string> = { ...(opts.headers || {}) }
  if (jar && jar.header()) headers.cookie = jar.header()
  let body: string | undefined
  if (opts.raw !== undefined) {
    body = opts.raw
    headers['content-type'] = headers['content-type'] || 'application/json'
  } else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body)
    headers['content-type'] = 'application/json'
  }
  const res = await fetch(`${base}${route}`, { method, headers, body })
  if (jar) jar.absorb(res)
  const text = await res.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  return { status: res.status, json, text, headers: res.headers }
}

interface RunEvent {
  seq?: number
  type: string
  data: any
}

/** 消费 SSE；收到 candidates 自动回填实测数据，直到 done 或超时 */
async function consumeRun(
  jar: Jar,
  base: string,
  runId: string,
  opts: { timeoutMs?: number; autoProbe?: boolean; onEvent?: (e: RunEvent) => Promise<void> | void } = {},
): Promise<RunEvent[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000)
  const events: RunEvent[] = []
  try {
    const res = await fetch(`${base}/api/runs/${runId}/events`, {
      headers: { cookie: jar.header() },
      signal: controller.signal,
    })
    if (!res.ok || !res.body) throw new Error(`SSE 连接失败：${res.status}`)
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const blocks = buffer.split('\n\n')
      buffer = blocks.pop() || ''
      for (const block of blocks) {
        const line = block.split('\n').find((l) => l.startsWith('data:'))
        if (!line) continue
        let event: RunEvent
        try {
          event = JSON.parse(line.slice(5).trim())
        } catch {
          continue
        }
        events.push(event)
        if (event.type === 'candidates' && opts.autoProbe !== false) {
          for (const candidate of event.data?.candidates || []) {
            await call(jar, base, 'POST', `/api/candidates/${candidate.id}/report`, { body: { metrics: FULL_METRICS } })
          }
        }
        if (opts.onEvent) await opts.onEvent(event)
        if (event.type === 'done') {
          await reader.cancel().catch(() => {})
          return events
        }
      }
    }
    return events
  } finally {
    clearTimeout(timer)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForHealth(base: string, timeoutMs = 20_000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${base}/api/health`)
      if (res.ok) return
    } catch {
      /* retry */
    }
    await sleep(200)
  }
  throw new Error(`服务未就绪：${base}`)
}

function cleanDb(file: string): void {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true })
}

const logs = new Map<string, string[]>()

function startApp(name: string, port: number, db: string, env: Record<string, string>): ChildProcess {
  cleanDb(db)
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_PATH: db,
      GENERATION_RATE_LIMIT: '20',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const buffer: string[] = []
  logs.set(name, buffer)
  const collect = (chunk: Buffer) => buffer.push(chunk.toString())
  child.stdout?.on('data', collect)
  child.stderr?.on('data', collect)
  return child
}

async function stopChild(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  await sleep(800)
  if (child.exitCode === null) child.kill('SIGKILL')
}

let failures = 0
let passes = 0

async function test(id: string, title: string, fn: () => Promise<string | void>): Promise<void> {
  try {
    const detail = await fn()
    passes += 1
    console.log(`  PASS  ${id} ${title}${detail ? `（${detail}）` : ''}`)
  } catch (err) {
    failures += 1
    console.log(`  FAIL  ${id} ${title} → ${(err as Error).message}`)
  }
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message)
}

async function main(): Promise<void> {
  const mock = startApp('mock', PORT_MOCK, DB_MOCK, {
    MOCK_MODE: '1',
    RACE_COUNT: '1',
    PROBE_TIMEOUT_MS: '2000',
    GENERATION_RATE_LIMIT: '3',
    BODY_LIMIT: '128kb',
    PUBLIC_ORIGIN: 'http://allowed.example',
    NODE_ENV: 'production',
  })
  const llm = spawn(process.execPath, ['test/fake-llm.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, FAKE_LLM_PORT: String(PORT_LLM) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const llmLog: string[] = []
  llm.stdout?.on('data', (d: Buffer) => llmLog.push(d.toString()))
  logs.set('fake-llm', llmLog)
  const fake = startApp('fake', PORT_FAKE, DB_FAKE, {
    MOCK_MODE: '0',
    RACE_COUNT: '1',
    PROBE_TIMEOUT_MS: '2000',
    LLM_PROVIDERS: '[]',
    LLM_BASE_URL: `http://127.0.0.1:${PORT_LLM}/v1`,
    LLM_MODELS: 'fake-a',
    LLM_API_KEY: 'fake-key',
    GENERATION_RATE_LIMIT: '20',
  })

  try {
    await waitForHealth(BASE_MOCK)
    await waitForHealth(BASE_FAKE)
    try {
      await fetch(`http://127.0.0.1:${PORT_LLM}/v1/models`)
    } catch {
      throw new Error('假模型服务未就绪')
    }

    console.log('[regression] 安全基线（DEF-02/03）')
    await test('DEF-03', '安全响应头与 CSP（API 与页面）', async () => {
      const api = await call(null, BASE_MOCK, 'GET', '/api/health')
      assert(api.status === 200, `health=${api.status}`)
      const must: Array<[string, string]> = [
        ['x-content-type-options', 'nosniff'],
        ['x-frame-options', 'DENY'],
        ['referrer-policy', 'strict-origin-when-cross-origin'],
      ]
      for (const [name, expected] of must) assert(api.headers.get(name) === expected, `${name} 缺失或错误`)
      assert(/camera=\(\)/.test(api.headers.get('permissions-policy') || ''), 'Permissions-Policy 缺失')
      assert(/frame-ancestors 'none'/.test(api.headers.get('content-security-policy') || ''), 'CSP 缺少 frame-ancestors')
      assert(api.headers.get('x-powered-by') === null, 'X-Powered-By 未移除')

      const page = await call(null, BASE_MOCK, 'GET', '/')
      assert(page.status === 200, `首页=${page.status}（需先 npm run build）`)
      assert(page.headers.get('x-content-type-options') === 'nosniff', '页面缺少 nosniff')
      assert(/frame-ancestors 'none'/.test(page.headers.get('content-security-policy') || ''), '页面 CSP 缺失')
      return 'API/页面均含 5 类头，且无 X-Powered-By'
    })

    await test('DEF-02a', '超大请求体返回 413（上限 128kb）', async () => {
      const r = await call(null, BASE_MOCK, 'POST', '/api/projects', { raw: 'x'.repeat(256 * 1024) })
      assert(r.status === 413, `实际 ${r.status}`)
      assert(/请求体过大/.test(r.json?.error || ''), '413 文案缺失')
      return '413 + JSON error'
    })

    await test('DEF-02b', '畸形 JSON 返回 400', async () => {
      const r = await call(null, BASE_MOCK, 'POST', '/api/projects', { raw: '{"prompt":' })
      assert(r.status === 400, `实际 ${r.status}`)
      assert(/合法的 JSON/.test(r.json?.error || ''), '400 文案缺失')
      return '400 + JSON error'
    })

    console.log('[regression] 会话与跨站（DEF-04/05）')
    await test('DEF-04', 'HTTPS 下 Cookie 自动 Secure，HTTP 不加', async () => {
      const https = await call(new Jar(), BASE_MOCK, 'GET', '/api/me', { headers: { 'x-forwarded-proto': 'https' } })
      const secureCookie = https.headers.get('set-cookie') || ''
      assert(/HttpOnly/i.test(secureCookie), 'HTTPS Cookie 缺 HttpOnly')
      assert(/SameSite=Lax/i.test(secureCookie), 'HTTPS Cookie 缺 SameSite=Lax')
      assert(/; Secure/i.test(secureCookie), 'HTTPS Cookie 缺 Secure')

      const plain = await call(new Jar(), BASE_MOCK, 'GET', '/api/me')
      const plainCookie = plain.headers.get('set-cookie') || ''
      assert(/atoms_sid=/.test(plainCookie), 'HTTP 未下发会话 Cookie')
      assert(!/; Secure/i.test(plainCookie), 'HTTP 直连不应加 Secure')
      return 'HTTPS=Secure+HttpOnly+SameSite；HTTP=不加 Secure'
    })

    await test('DEF-05', '跨站 Origin 拒绝，同源/配置源/无来源放行', async () => {
      const evil = await call(new Jar(), BASE_MOCK, 'POST', '/api/projects', {
        body: { prompt: '跨站来源测试应用' },
        headers: { origin: 'https://evil.example' },
      })
      assert(evil.status === 403, `跨站实际 ${evil.status}`)
      const same = await call(new Jar(), BASE_MOCK, 'POST', '/api/projects', {
        body: { prompt: '同源来源测试应用' },
        headers: { origin: BASE_MOCK },
      })
      assert(same.status === 201, `同源实际 ${same.status}`)
      const none = await call(new Jar(), BASE_MOCK, 'POST', '/api/projects', { body: { prompt: '无来源测试应用' } })
      assert(none.status === 201, `curl/smoke 无 Origin 实际 ${none.status}`)
      const configured = await call(new Jar(), BASE_MOCK, 'POST', '/api/projects', {
        body: { prompt: '配置来源测试应用' },
        headers: { origin: 'http://allowed.example' },
      })
      assert(configured.status === 201, `PUBLIC_ORIGIN 实际 ${configured.status}`)
      return 'evil=403；同源/无来源/PUBLIC_ORIGIN=201'
    })

    console.log('[regression] 生成限流（DEF-01）')
    await test('DEF-01', '游客 3 次后 429，升级账号共享同一配额', async () => {
      const jar = new Jar()
      for (let i = 1; i <= 3; i++) {
        const r = await call(jar, BASE_MOCK, 'POST', '/api/projects', { body: { prompt: `限流测试应用 ${i} 号` } })
        assert(r.status === 201, `第 ${i} 次实际 ${r.status}`)
      }
      const limited = await call(jar, BASE_MOCK, 'POST', '/api/projects', { body: { prompt: '限流测试应用 4 号' } })
      assert(limited.status === 429, `第 4 次实际 ${limited.status}`)
      const retryAfter = Number(limited.headers.get('retry-after') || 0)
      assert(retryAfter > 0 && retryAfter <= 3600, `Retry-After=${retryAfter}`)
      assert(/上限/.test(limited.json?.error || ''), '429 文案缺失')

      const email = `reg-${Date.now()}@example.com`
      const upgrade = await call(jar, BASE_MOCK, 'POST', '/api/auth/register', {
        body: { email, password: 'RegPass1234', name: 'QA' },
      })
      assert(upgrade.status === 200, `升级账号=${upgrade.status}`)
      const afterUpgrade = await call(jar, BASE_MOCK, 'POST', '/api/projects', { body: { prompt: '升级后仍应限流' } })
      assert(afterUpgrade.status === 429, `升级后第 1 次实际 ${afterUpgrade.status}`)
      return `3×201 → 429，Retry-After=${retryAfter}s；升级后仍 429`
    })

    console.log('[regression] 分享标注（DEF-07）')
    await test('DEF-07', '模板版本与回退版本均标记为内置示例', async () => {
      const jar = new Jar()
      const created = await call(jar, BASE_MOCK, 'POST', '/api/projects', {
        body: { prompt: '做一个任务看板，支持添加任务并在三列之间推进' },
      })
      assert(created.status === 201, `创建=${created.status}`)
      await consumeRun(jar, BASE_MOCK, created.json.runId)
      const detail1 = await call(jar, BASE_MOCK, 'GET', `/api/projects/${created.json.projectId}`)
      const v1 = detail1.json.project.versions[0]
      assert(v1, '未生成 v1')

      const published1 = await call(jar, BASE_MOCK, 'POST', `/api/projects/${created.json.projectId}/publish`)
      const share1 = await call(null, BASE_MOCK, 'GET', `/api/share/${published1.json.slug}`)
      assert(share1.json.mock === true, `v1 mock=${share1.json.mock}`)
      assert(share1.json.source === 'mock', `v1 source=${share1.json.source}`)
      assert(share1.json.model === 'atoms-mock', `v1 model=${share1.json.model}`)

      const edit = await call(jar, BASE_MOCK, 'POST', `/api/projects/${created.json.projectId}/messages`, {
        body: { content: '把主色改成绿色' },
      })
      assert(edit.status === 201, `编辑=${edit.status}`)
      await consumeRun(jar, BASE_MOCK, edit.json.runId)
      const restored = await call(jar, BASE_MOCK, 'POST', `/api/projects/${created.json.projectId}/versions/${v1.id}/restore`)
      assert(restored.status === 200, `回退=${restored.status}`)
      await call(jar, BASE_MOCK, 'POST', `/api/projects/${created.json.projectId}/publish`)
      const share2 = await call(null, BASE_MOCK, 'GET', `/api/share/${published1.json.slug}`)
      assert(share2.json.mock === true, `回退版本 mock=${share2.json.mock}`)
      assert(share2.json.source === 'restore', `回退 source=${share2.json.source}`)
      return 'v1(mock)=true；restore=true 且 source=restore'
    })

    console.log('[regression] Patch 校验与回退')
    await test('PATCH-UNIT', 'find 唯一性校验、失败返回 null、提示词强化', async () => {
      const eng = await import('../src/server/agents/engineer.js')
      const parsed = eng.parsePatchOutput('```json\n{"patches":[{"find":"<h1 id=\\"qa-title\\">QA Demo</h1>","replace":"<h1 id=\\"qa-title\\">QA Demo 已修改</h1>"}]}\n```')
      assert(parsed?.patches?.length === 1, '围栏 JSON 未解析')
      const html = '<div class="card">A</div><div class="card">A</div>'
      assert(eng.applyPatches(html, [{ find: '<div class="card">A</div>', replace: 'B' }]) === null, '重复 find 未拒绝')
      assert(eng.applyPatches('<div>keep</div>', [{ find: '<span>missing</span>', replace: 'X' }]) === null, '缺失 find 未拒绝')
      const applied = eng.applyPatches('<div class="card">A</div>', [{ find: '<div class="card">A</div>', replace: '<div class="card">B</div>' }])
      assert(applied === '<div class="card">B</div>', '唯一命中替换失败')
      assert(eng.PATCH_SYSTEM.includes('唯一') && eng.PATCH_SYSTEM.includes('find') && eng.PATCH_SYSTEM.includes('full'), '提示词缺少关键约束')
      return '重复/缺失拒绝，唯一命中生效，提示词含唯一锚点/full 约束'
    })

    await test('PATCH-FALLBACK', '补丁失败后回退全量重写并保存新版本', async () => {
      const jar = new Jar()
      const created = await call(jar, BASE_FAKE, 'POST', '/api/projects', {
        body: { prompt: '做一个任务看板，支持添加与删除条目' },
      })
      assert(created.status === 201, `创建=${created.status}`)
      await consumeRun(jar, BASE_FAKE, created.json.runId, { timeoutMs: 30_000 })
      const before = await call(jar, BASE_FAKE, 'GET', `/api/projects/${created.json.projectId}`)
      assert(before.json.project.versions.length === 1, `创建后版本=${before.json.project.versions.length}`)

      const edit = await call(jar, BASE_FAKE, 'POST', `/api/projects/${created.json.projectId}/messages`, {
        body: { content: 'PATCHFAILOKFULL 把标题改成绿色' },
      })
      assert(edit.status === 201, `编辑=${edit.status}`)
      await consumeRun(jar, BASE_FAKE, edit.json.runId, { timeoutMs: 40_000 })
      const after = await call(jar, BASE_FAKE, 'GET', `/api/projects/${created.json.projectId}`)
      assert(after.json.project.versions.length === 2, `回退后版本=${after.json.project.versions.length}`)
      // listVersions 按 seq 倒序返回，最新版本在 [0]
      assert(after.json.project.versions[0].source === 'edit', `v2 source=${after.json.project.versions[0].source}`)
      return '补丁 find 未命中 → 全量重写成功 → v2'
    })

    console.log('[regression] 停止终态（DEF-08）')
    await test('DEF-08', '生成中停止保持 stopped，且不产生版本', async () => {
      const jar = new Jar()
      const created = await call(jar, BASE_FAKE, 'POST', '/api/projects', { body: { prompt: 'SLOWSTOP 做一个任务看板' } })
      assert(created.status === 201, `创建=${created.status}`)
      let stopped = false
      const events = await consumeRun(jar, BASE_FAKE, created.json.runId, {
        timeoutMs: 25_000,
        autoProbe: false,
        onEvent: async (event) => {
          if (!stopped && event.type === 'step' && event.data?.key === 'generate' && event.data?.status === 'running') {
            stopped = true
            await call(jar, BASE_FAKE, 'POST', `/api/runs/${created.json.runId}/stop`)
          }
        },
      })
      const done = [...events].reverse().find((e) => e.type === 'done')
      assert(done?.data?.status === 'stopped', `停止瞬间 done=${done?.data?.status}`)

      await sleep(6000)
      const project = await call(jar, BASE_FAKE, 'GET', `/api/projects/${created.json.projectId}`)
      assert(project.json.project.versions.length === 0, `停止后产生 ${project.json.project.versions.length} 个版本`)
      const replay = await consumeRun(jar, BASE_FAKE, created.json.runId, { autoProbe: false, timeoutMs: 10_000 })
      const snapshot = replay.find((e) => e.type === 'snapshot')?.data?.run
      const finalDone = [...replay].reverse().find((e) => e.type === 'done')
      assert(snapshot?.status === 'stopped', `最终 run.status=${snapshot?.status}`)
      assert(finalDone?.data?.status !== 'failed', `终态被覆盖为 ${finalDone?.data?.status}`)
      return 'stopped 保持，versions=0'
    })

    console.log(`\n[regression] 合计 ${passes + failures} 项，通过 ${passes} 项，失败 ${failures} 项`)
  } finally {
    await stopChild(mock)
    await stopChild(fake)
    await stopChild(llm)
    if (failures > 0) {
      for (const [name, lines] of logs) {
        console.log(`\n[server:${name}] 最近日志：`)
        console.log(lines.join('').slice(-4000))
      }
    }
  }
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(async (err) => {
  console.error('[regression] 异常：', err)
  process.exit(1)
})
