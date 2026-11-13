/**
 * 端到端冒烟脚本：创建 → SSE 双路赛马 → 择优保存 → 编辑迭代 → 修复迭代 → 发布 → 分享 KV 持久化与隔离
 * 用法：SMOKE_BASE_URL=http://localhost:3100 npm run smoke
 */
const BASE = (process.env.SMOKE_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '')

class Jar {
  private cookies = new Map<string, string>()

  absorb(res: Response): void {
    const getSetCookie = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie
    const list = typeof getSetCookie === 'function' ? getSetCookie.call(res.headers) : []
    for (const raw of list) {
      const pair = raw.split(';')[0] || ''
      const idx = pair.indexOf('=')
      if (idx > 0) this.cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim())
    }
  }

  header(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
  }
}

async function call<T>(
  jar: Jar,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; data: T }> {
  const res = await fetch(`${BASE}${path}`, {
    method: init.method || 'GET',
    headers: {
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(jar.header() ? { cookie: jar.header() } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  })
  jar.absorb(res)
  const text = await res.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  return { status: res.status, data: data as T }
}

const METRICS = {
  elements: 160,
  textLength: 520,
  errors: [],
  errorCount: 0,
  clicks: 3,
  mutations: 12,
  keys: 2,
  writes: 3,
  overflowX: false,
  width: 1280,
  title: 'Atoms Smoke',
  interactiveClicks: 3,
  simulatedClicks: 8,
  simulatedChanges: 12,
  simulatedWrites: 2,
}

interface RunOutcome {
  raceCount: number
  adopted: number
  score?: number
  versionSeq?: number
  doneSeen: boolean
}

/** 消费运行 SSE；收到候选列表后代替浏览器探针上报实测数据 */
async function consumeRun(jar: Jar, runId: string): Promise<RunOutcome> {
  const res = await fetch(`${BASE}/api/runs/${runId}/events`, { headers: { cookie: jar.header() } })
  jar.absorb(res)
  if (!res.body) throw new Error('SSE 无响应体')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const outcome: RunOutcome = { raceCount: 0, adopted: 0, doneSeen: false }
  const reported = new Set<string>()

  while (!outcome.doneSeen) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const blocks = buffer.split('\n\n')
    buffer = blocks.pop() || ''
    for (const block of blocks) {
      const dataLine = block.split('\n').find((line) => line.startsWith('data:'))
      if (!dataLine) continue
      let event: { type?: string; data?: any }
      try {
        event = JSON.parse(dataLine.slice(5).trim())
      } catch {
        continue
      }
      if (event.type === 'candidates') {
        const list = (event.data?.candidates || []) as Array<{ id: string }>
        outcome.raceCount = list.length
        for (const c of list) {
          if (reported.has(c.id)) continue
          reported.add(c.id)
          await call(jar, `/api/candidates/${c.id}/report`, { method: 'POST', body: { metrics: METRICS } })
        }
      }
      if (event.type === 'report') {
        outcome.adopted = (event.data?.race || []).filter((r: { adopted: boolean }) => r.adopted).length
        outcome.score = event.data?.score
      }
      if (event.type === 'version') outcome.versionSeq = event.data?.seq
      if (event.type === 'done') outcome.doneSeen = true
    }
  }
  return outcome
}

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  PASS  ${label}${detail ? `（${detail}）` : ''}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? `（${detail}）` : ''}`)
  }
}

async function main(): Promise<void> {
  console.log(`[smoke] base = ${BASE}`)
  const jar = new Jar()

  const health = await call<{ ok: boolean; mock: boolean }>(jar, '/api/health')
  check('GET /api/health', health.status === 200 && health.data?.ok === true, `mock=${health.data?.mock}`)

  const me = await call<{ user: { kind: string } }>(jar, '/api/me')
  check('GET /api/me 透明游客', me.status === 200 && me.data?.user?.kind === 'guest')

  const created = await call<{ projectId: string; runId: string }>(jar, '/api/projects', {
    method: 'POST',
    body: { prompt: '做一个任务看板，支持添加任务、在待办/进行中/已完成之间推进，刷新后数据还在' },
  })
  check('POST /api/projects', created.status === 201 && !!created.data?.projectId)
  const projectId = created.data.projectId

  const createOutcome = await consumeRun(jar, created.data.runId)
  check('SSE 双路候选', createOutcome.raceCount === 2, `收到 ${createOutcome.raceCount} 路`)
  check('赛马择优唯一', createOutcome.adopted === 1, `报告分数 ${createOutcome.score}`)
  check('自动保存版本', createOutcome.versionSeq === 1, `v${createOutcome.versionSeq}`)
  check('SSE 正常结束', createOutcome.doneSeen && createOutcome.score != null)

  const publish = await call<{ slug: string; path: string }>(jar, `/api/projects/${projectId}/publish`, { method: 'POST' })
  check('POST publish', publish.status === 200 && !!publish.data?.slug, publish.data?.path)
  const slug = publish.data.slug

  const visitorA = new Jar()
  const share = await call<{ html: string; title: string }>(visitorA, `/api/share/${slug}`)
  check('GET /s/:slug 公开可访问', share.status === 200 && (share.data?.html || '').length > 2000)
  const kvWrite = await call(visitorA, `/api/share/${slug}/kv`, {
    method: 'POST',
    body: { ops: [{ op: 'set', key: 'smoke_key', value: 'smoke_value' }] },
  })
  check('访客数据写入', kvWrite.status === 200)
  const kvRead = await call<{ data: Record<string, string> }>(visitorA, `/api/share/${slug}/kv`)
  check('访客数据刷新后仍存在', kvRead.data?.data?.smoke_key === 'smoke_value')

  const visitorB = new Jar()
  await call(visitorB, `/api/share/${slug}`, {})
  const kvB = await call<{ data: Record<string, string> }>(visitorB, `/api/share/${slug}/kv`)
  check('不同访客数据隔离', Object.keys(kvB.data?.data || {}).length === 0)

  // 编辑迭代（Patch 优先；mock 模式下为增量插入）
  const edit = await call<{ runId: string }>(jar, `/api/projects/${projectId}/messages`, {
    method: 'POST',
    body: { content: '把主色改成绿色，并在底部增加一个统计栏' },
  })
  check('POST 编辑消息', edit.status === 201 && !!edit.data?.runId)
  const editOutcome = await consumeRun(jar, edit.data.runId)
  check('编辑迭代保存 v2', editOutcome.versionSeq === 2, `v${editOutcome.versionSeq}`)
  const detail = await call<{ project: { html: string; versions: Array<{ seq: number }> } }>(jar, `/api/projects/${projectId}`)
  check('编辑产物为新版本', (detail.data?.project?.html || '') !== (share.data?.html || ''))
  check('版本历史累加', (detail.data?.project?.versions || []).length === 2)

  // 一键修复（fix 模式）仍走编辑链路
  const fix = await call<{ runId: string }>(jar, `/api/projects/${projectId}/messages`, {
    method: 'POST',
    body: { mode: 'fix', content: '修复：点击按钮后数据没有保存，请检查 localStorage 读写' },
  })
  check('POST 一键修复', fix.status === 201 && !!fix.data?.runId)
  const fixOutcome = await consumeRun(jar, fix.data.runId)
  check('修复迭代保存 v3', fixOutcome.versionSeq === 3, `v${fixOutcome.versionSeq}`)

  // 游客升级邮箱 + 登录后项目保留
  const email = `smoke-${Date.now()}@example.com`
  const password = 'smoke-pass-123'
  const register = await call<{ user: { kind: string; email: string }; upgraded: boolean }>(jar, '/api/auth/register', {
    method: 'POST',
    body: { email, password, name: 'Smoke' },
  })
  check('游客升级邮箱', register.status === 200 && register.data?.upgraded === true && register.data?.user?.email === email)
  const afterRegister = await call<{ projects: Array<{ id: string }> }>(jar, '/api/projects')
  check('升级后项目保留', (afterRegister.data?.projects || []).some((p) => p.id === projectId))

  await call(jar, '/api/auth/logout', { method: 'POST' })
  const login = await call<{ user: { kind: string; email: string } }>(jar, '/api/auth/login', {
    method: 'POST',
    body: { email, password },
  })
  check('邮箱密码登录', login.status === 200 && login.data?.user?.email === email)
  const afterLogin = await call<{ projects: Array<{ id: string }> }>(jar, '/api/projects')
  check('换设备登录后项目可见', (afterLogin.data?.projects || []).some((p) => p.id === projectId))

  console.log(failures === 0 ? '\n[smoke] 全部通过 ✅' : `\n[smoke] 失败 ${failures} 项 ❌`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('[smoke] 异常：', err)
  process.exit(1)
})
