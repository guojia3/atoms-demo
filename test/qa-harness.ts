// QA 测试轻量框架：断言、CookieJar、HTTP、SSE 消费与结果落盘（无第三方依赖）
import fs from 'node:fs'
import path from 'node:path'

export const BASE = (process.env.QA_BASE || 'http://127.0.0.1:3200').replace(/\/+$/, '')

export interface CaseMeta {
  id: string
  title: string
  priority: 'P0' | 'P1' | 'P2'
  /** 关联需求/验收项，如 R4、A4、H7 */
  req: string
  expected: string
  /** 可选的缺陷编号：断言失败时自动挂到该缺陷 */
  defect?: string
  severity?: 'S1' | 'S2' | 'S3' | 'S4'
}

export interface CaseResult extends CaseMeta {
  actual: string
  pass: boolean
  durationMs: number
}

const results: CaseResult[] = []

export class Jar {
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

  get(name: string): string | undefined {
    return this.cookies.get(name)
  }
}

export interface HttpResult {
  status: number
  json: any
  text: string
  headers: Headers
}

export async function http(
  jar: Jar | null,
  method: string,
  route: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<HttpResult> {
  const headers: Record<string, string> = { ...(extraHeaders || {}) }
  if (jar && jar.header()) headers.cookie = jar.header()
  const hasBody = body !== undefined
  if (hasBody) headers['content-type'] = 'application/json'
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers,
    body: hasBody ? JSON.stringify(body) : undefined,
  })
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

export function ok(cond: unknown, message: string): void {
  if (!cond) throw new Error(message)
}

export function eq(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) throw new Error(`${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}

/** 完整实测指标：静态 10 + 实测 50 + 清单 40 = 100 分 */
export const FULL_METRICS = {
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
  title: 'QA Demo',
  interactiveClicks: 3,
  simulatedClicks: 3,
  simulatedChanges: 3,
  simulatedWrites: 2,
}

export interface RunEvent {
  seq: number
  type: string
  data: any
  at?: string
}

/** 消费 SSE：自动为 candidates 回填实测数据，直到 done 或超时 */
export async function consumeRun(
  runId: string,
  jar: Jar,
  opts: { from?: number; autoProbe?: boolean; timeoutMs?: number; stopAt?: string; untilEnd?: boolean } = {},
): Promise<RunEvent[]> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000)
  const events: RunEvent[] = []
  try {
    const res = await fetch(`${BASE}/api/runs/${runId}/events?from=${opts.from ?? 0}`, {
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
        const dataLine = block
          .split('\n')
          .find((line) => line.startsWith('data:'))
        if (!dataLine) continue
        let event: RunEvent
        try {
          event = JSON.parse(dataLine.slice(5).trim())
        } catch {
          continue
        }
        events.push(event)
        if (event.type === 'candidates' && opts.autoProbe !== false) {
          for (const c of event.data?.candidates || []) {
            await http(jar, 'POST', `/api/candidates/${c.id}/report`, { metrics: FULL_METRICS })
          }
        }
        if (opts.stopAt && event.type === opts.stopAt) {
          await reader.cancel().catch(() => {})
          return events
        }
        if (event.type === 'done' && !opts.untilEnd) {
          await reader.cancel().catch(() => {})
          return events
        }
      }
    }
    return events
  } finally {
    clearTimeout(timeout)
  }
}

/** 等待某个条件成立（轮询） */
export async function waitFor<T>(fn: () => Promise<T | null | undefined>, timeoutMs: number, intervalMs = 200): Promise<T> {
  const start = Date.now()
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时（${timeoutMs}ms）`)
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

export async function runCase(meta: CaseMeta, fn: () => Promise<string | void>): Promise<void> {
  const startedAt = Date.now()
  try {
    const actual = await fn()
    results.push({ ...meta, actual: actual || '符合预期', pass: true, durationMs: Date.now() - startedAt })
    console.log(`PASS  ${meta.id} ${meta.title}`)
  } catch (err) {
    const actual = (err as Error).message || '未知错误'
    results.push({ ...meta, actual, pass: false, durationMs: Date.now() - startedAt })
    console.log(`FAIL  ${meta.id} ${meta.title} → ${actual}`)
  }
}

export function writeResults(name: string): { total: number; pass: number; fail: number } {
  const dir = path.resolve(process.cwd(), 'test/results')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(results, null, 2))
  const total = results.length
  const pass = results.filter((r) => r.pass).length
  console.log(`\n[${name}] 合计 ${total} 项，通过 ${pass} 项，失败 ${total - pass} 项`)
  for (const r of results.filter((x) => !x.pass)) {
    console.log(`  FAIL ${r.id} [${r.priority}] ${r.title} → ${r.actual}${r.defect ? `（缺陷 ${r.defect}）` : ''}`)
  }
  return { total, pass, fail: total - pass }
}
