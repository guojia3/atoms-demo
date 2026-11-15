/**
 * 赛马策略 A 回归：首候选提前预览、45s 上限（测试用 1.5s）、<70 分放宽（3s）、
 * 慢候选胜出替换、早期交互不串数据、取消上游请求、刷新恢复。
 * 需先 npm run build；脚本自行启动 fake-llm 与应用实例。
 */
import fs from 'node:fs'
import { spawn } from 'node:child_process'

const APP_PORT = 3450
const FAKE_PORT = 3997
const CDP_PORT = 9351
const BASE = `http://127.0.0.1:${APP_PORT}`
const DB = '/tmp/atoms-race-check.db'
const PROFILE = '/tmp/qa-race-chrome'
const GRACE_MS = Number(process.env.RACE_TEST_GRACE || 4000)
const LOW_SCORE_GRACE_MS = Number(process.env.RACE_TEST_LOW_GRACE || 6000)
const SLOW_MS = Number(process.env.RACE_TEST_SLOW || 5000)
const ONLY_FIRST = process.env.RACE_TEST_ONLY === '1'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const jar = new Map()
async function api(method, route, body) {
  const headers = {}
  if (jar.size) headers.cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(BASE + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  for (const sc of res.headers.getSetCookie?.() || []) {
    const pair = sc.split(';')[0]
    const idx = pair.indexOf('=')
    if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim())
  }
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { json = null }
  return { status: res.status, json, text }
}
async function fakeStats() {
  const res = await fetch(`http://127.0.0.1:${FAKE_PORT}/stats`)
  return res.json()
}
async function resetFakeStats() {
  await fetch(`http://127.0.0.1:${FAKE_PORT}/stats/reset`, { method: 'POST' })
}

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.id = 0
    this.pending = new Map()
    this.events = []
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id) {
        const p = this.pending.get(msg.id)
        if (!p) return
        this.pending.delete(msg.id)
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result)
        return
      }
      this.events.push(msg)
    })
  }
  ready() {
    return new Promise((res, rej) => {
      this.ws.addEventListener('open', res, { once: true })
      this.ws.addEventListener('error', () => rej(new Error('CDP 连接失败')), { once: true })
    })
  }
  send(method, params = {}, sessionId) {
    return new Promise((res, rej) => {
      const id = ++this.id
      this.pending.set(id, { resolve: res, reject: rej })
      const payload = { id, method, params }
      if (sessionId) payload.sessionId = sessionId
      this.ws.send(JSON.stringify(payload))
    })
  }
  waitLoad(timeout = 20000) {
    return new Promise((res) => {
      const timer = setTimeout(res, timeout)
      const onMsg = (ev) => {
        const m = JSON.parse(ev.data)
        if (m.method !== 'Page.loadEventFired') return
        clearTimeout(timer)
        this.ws.removeEventListener('message', onMsg)
        res()
      }
      this.ws.addEventListener('message', onMsg)
    })
  }
  close() { this.ws.close() }
}

async function evalIn(cdp, expression, target) {
  const params = { expression, returnByValue: true, awaitPromise: true }
  const r = await cdp.send('Runtime.evaluate', params, target?.sessionId)
  if (r.exceptionDetails) throw new Error('求值异常：' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
  return r.result.value
}

async function attachSandbox(cdp) {
  const { targetInfos } = await cdp.send('Target.getTargets')
  const frames = targetInfos.filter((t) => t.type === 'iframe')
  if (!frames.length) return null
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: frames[frames.length - 1].targetId, flatten: true })
  await cdp.send('Runtime.enable', {}, sessionId)
  await sleep(200)
  return { sessionId }
}

async function waitPreview(cdp, timeoutMs = 5000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const text = await evalIn(cdp, 'document.body.innerText').catch(() => '')
    if (text.includes('候选预览')) return Date.now() - start
    await sleep(80)
  }
  return -1
}

async function waitEnd(projectId, timeoutMs = 20000) {
  const start = Date.now()
  let latest = null
  while (Date.now() - start < timeoutMs) {
    const res = await api('GET', `/api/projects/${projectId}`)
    latest = res.json?.project || null
    if (latest && !latest.activeRunId) return { project: latest, elapsed: Date.now() - start }
    await sleep(200)
  }
  return { project: latest, elapsed: -1 }
}

async function waitDone(projectId, timeoutMs = 20000) {
  const start = Date.now()
  let latest = null
  while (Date.now() - start < timeoutMs) {
    const res = await api('GET', `/api/projects/${projectId}`)
    latest = res.json?.project || null
    if (latest && latest.versions.length > 0 && !latest.activeRunId) return { project: latest, elapsed: Date.now() - start }
    await sleep(200)
  }
  return { project: latest, elapsed: -1 }
}

const results = []
function record(name, pass, detail) {
  results.push({ name, pass })
  console.log(`  ${pass ? 'PASS' : 'FAIL'} ${name}${detail ? `（${detail}）` : ''}`)
}

function startProc(cmd, args, env) {
  const child = spawn(cmd, args, { cwd: process.cwd(), env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', (d) => process.env.RACE_TEST_VERBOSE && process.stdout.write(String(d)))
  child.stderr.on('data', (d) => process.stdout.write(String(d)))
  return child
}

async function waitHealth(url, timeoutMs = 20000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url)
      if (res.ok) return true
    } catch { /* noop */ }
    await sleep(200)
  }
  return false
}

async function openProject(cdp, projectId) {
  const t0 = Date.now()
  await cdp.send('Page.navigate', { url: `${BASE}/p/${projectId}` })
  await cdp.waitLoad()
  const previewMs = await waitPreview(cdp)
  return { t0, previewMs }
}

async function main() {
  fs.rmSync(DB, { force: true })
  fs.rmSync(`${DB}-wal`, { force: true })
  fs.rmSync(`${DB}-shm`, { force: true })
  fs.rmSync(PROFILE, { recursive: true, force: true })

  const fake = startProc('node', ['test/fake-llm.mjs'], {
    FAKE_LLM_PORT: String(FAKE_PORT),
    RACE_SLOW_MS: String(SLOW_MS),
  })
  const providers = JSON.stringify([
    { name: 'fake-a', baseUrl: `http://127.0.0.1:${FAKE_PORT}/v1`, apiKey: 'qa', model: 'fake-a' },
    { name: 'fake-b', baseUrl: `http://127.0.0.1:${FAKE_PORT}/v1`, apiKey: 'qa', model: 'fake-b' },
  ])
  const app = startProc('node', ['node_modules/tsx/dist/cli.mjs', 'src/server/index.ts'], {
    PORT: String(APP_PORT),
    DATABASE_PATH: DB,
    NODE_ENV: 'production',
    MOCK_MODE: '0',
    LLM_PROVIDERS: providers,
    RACE_COUNT: '2',
    RACE_GRACE_MS: String(GRACE_MS),
    RACE_LOW_SCORE_GRACE_MS: String(LOW_SCORE_GRACE_MS),
    PROBE_TIMEOUT_MS: '5000',
    GENERATION_RATE_LIMIT: '100',
  })

  const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', 'about:blank',
  ], { stdio: 'ignore' })

  try {
    if (!(await waitHealth(`${BASE}/api/health`))) throw new Error('应用实例未就绪')
    if (!(await waitHealth(`http://127.0.0.1:${FAKE_PORT}/stats`))) throw new Error('fake-llm 未就绪')
    await api('GET', '/api/me')
    const sid = jar.get('atoms_sid')
    if (!sid) throw new Error('未拿到游客会话')

    let ver = null
    for (let i = 0; i < 60 && !ver; i++) {
      try { ver = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json() } catch { await sleep(150) }
    }
    if (!ver) throw new Error('Chrome 未就绪')
    const target = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json()
    const cdp = new CDP(target.webSocketDebuggerUrl)
    await cdp.ready()
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Network.enable')
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
    await cdp.send('Network.setCookie', { name: 'atoms_sid', value: sid, url: BASE, path: '/', httpOnly: true, secure: false })

    // 场景 1：首候选高分 + 慢候选超过上限 → 首候选立即预览、慢候选被取消
    console.log('[scenario1] 首候选预览 + 超时取消')
    await resetFakeStats()
    const c1 = await api('POST', '/api/projects', { prompt: 'RACESLOWB 做一个任务看板，支持添加和删除' })
    if (c1.status !== 201) throw new Error('创建失败：' + c1.status + ' ' + c1.text.slice(0, 200))
    const p1 = c1.json.projectId
    const open1 = await openProject(cdp, p1)
    const done1 = await waitDone(p1, Math.max(15000, GRACE_MS + 8000))
    record('首候选在慢候选完成前已预览', open1.previewMs >= 0 && open1.previewMs < 1200, `首预览=${open1.previewMs}ms（上限 ${GRACE_MS}ms）`)
    record('到达上限后取消慢候选并定稿', done1.project?.versions.length === 1 && done1.project.versions[0].score === 100, `耗时=${done1.elapsed}ms v=${done1.project?.versions.length} 分=${done1.project?.versions[0]?.score}`)
    const stats1 = await fakeStats()
    record('上游慢请求被真正中止', stats1.engineerAborted >= 1 && stats1.abortedModels.includes('fake-b'), `aborted=${stats1.engineerAborted} models=${stats1.abortedModels.join(',')}`)
    record('取消不产生重复版本', done1.project?.versions.length === 1, `versions=${done1.project?.versions.length}`)

    if (!ONLY_FIRST) {
    // 场景 2：首候选 <70 → 放宽到 90s（测试 3s），慢候选在放宽期内胜出并替换预览；早期交互不串数据
    console.log('[scenario2] 低分首候选放宽 + 慢候选胜出替换 + 早期数据隔离')
    await resetFakeStats()
    const c2 = await api('POST', '/api/projects', { prompt: 'RACELOW RACESLOWB 做一个任务看板，支持添加和删除' })
    if (c2.status !== 201) throw new Error('创建失败：' + c2.status)
    const p2 = c2.json.projectId
    const open2 = await openProject(cdp, p2)
    // 等首候选探针回报/评分完成后，再模拟用户在早期预览里的交互，避免影响低分事实
    await sleep(2600)
    const ctx = await attachSandbox(cdp)
    if (ctx) {
      await evalIn(cdp, `localStorage.setItem('early_marker', 'should-not-leak')`, ctx)
    }
    const done2 = await waitDone(p2, 20000)
    const report2 = (done2.project?.messages || []).filter((m) => m.kind === 'report').pop()
    const race2 = report2?.meta?.race || []
    const adopted2 = race2.find((r) => r.adopted)
    const low2 = race2.find((r) => r.score < 70)
    const kv2 = await api('GET', `/api/projects/${p2}/kv`)
    record('首候选低分时自动放宽等待上限', Boolean(low2) && done2.project?.versions.length === 1, `低分候选=${low2?.score ?? '—'} v=${done2.project?.versions.length}`)
    record('慢候选在放宽期内胜出并定稿', adopted2?.model === 'fake-b' && done2.project?.versions[0]?.model === 'fake-b', `采用=${adopted2?.model ?? '—'} v.model=${done2.project?.versions[0]?.model}`)
    record('胜者不是首候选时预览被替换', (done2.project?.html || '').includes('QA Demo'), `html包含QA Demo=${(done2.project?.html || '').includes('QA Demo')}`)
    record('早期预览交互未写入最终 KV', !Object.prototype.hasOwnProperty.call(kv2.json?.data || {}, 'early_marker'), `keys=${Object.keys(kv2.json?.data || {}).join(',') || '空'}`)
    record('放宽期内慢候选未被中止', (await fakeStats()).engineerAborted === 0, `aborted=${(await fakeStats()).engineerAborted}`)
    record('每轮只保存一个版本', done2.project?.versions.length === 1, `versions=${done2.project?.versions.length}`)
    }

    if (!ONLY_FIRST) {
    // 场景 3：早期预览期间刷新 → 断线重连、重复 candidate 事件不重复建版本
    console.log('[scenario3] 预览期间刷新恢复')
    await resetFakeStats()
    const c3 = await api('POST', '/api/projects', { prompt: 'RACESLOWB 做一个任务看板' })
    const p3 = c3.json.projectId
    const mark3 = cdp.events.length
    await cdp.send('Page.navigate', { url: `${BASE}/p/${p3}` })
    await cdp.waitLoad()
    await waitPreview(cdp, 5000)
    await cdp.send('Page.reload')
    await cdp.waitLoad()
    const done3 = await waitDone(p3, 20000)
    const exceptions = cdp.events.slice(mark3).filter((e) => e.method === 'Runtime.exceptionThrown')
    record('刷新后自动恢复并只保存一个版本', done3.project?.versions.length === 1, `versions=${done3.project?.versions.length} 耗时=${done3.elapsed}ms`)
    record('刷新恢复过程无 JS 异常', exceptions.length === 0, exceptions[0]?.params?.exceptionDetails?.exception?.description?.slice(0, 100) || '0')

    // 场景 4：二维码需求 + 两路模型失败 + 无匹配模板 → 必须失败，不得用看板冒充
    console.log('[scenario4] 二维码无匹配模板：失败而非兜底')
    const c4 = await api('POST', '/api/projects', { prompt: '生成一个二维码工具，支持历史记录及回放 BADHTML' })
    const p4 = c4.json.projectId
    await sleep(400)
    const end4 = await waitEnd(p4, 20000)
    const text4 = (end4.project?.messages || []).map((m) => m.content).join('\n')
    record('无匹配模板时直接失败且不保存版本', end4.project?.versions.length === 0, `versions=${end4.project?.versions.length}`)
    record('失败提示说明内置模板不匹配', /没有匹配的内置模板|避免用无关模板/.test(text4), text4.replace(/\s+/g, ' ').slice(0, 120))

    // 场景 5：二维码需求 + 首路非法 + 次路模型成功 → 采用模型页面，不允许兜底
    console.log('[scenario5] 二维码首路失败、次路模型成功')
    const c5 = await api('POST', '/api/projects', { prompt: '生成一个二维码工具，支持历史记录及回放 QRFALLBACKA' })
    const p5 = c5.json.projectId
    const done5 = await waitDone(p5, 20000)
    record('二维码需求最终保存模型页面', done5.project?.versions[0]?.model === 'fake-b' && (done5.project?.html || '').includes('二维码工具'), `model=${done5.project?.versions[0]?.model} title=${((done5.project?.html || '').match(/<title>[^<]*/) || [])[0]}`)
    record('二维码需求未采用兜底模板', !(done5.project?.html || '').includes('今日任务看板'), 'html 不含任务看板')

    // 场景 6：任务看板 + 首路兜底（可匹配）+ 次路模型低分 → 模型优先，不允许兜底胜出
    console.log('[scenario6] 兜底不能压过模型候选')
    await resetFakeStats()
    const c6 = await api('POST', '/api/projects', { prompt: 'QRFALLBACKA MODEL_LOW 做一个任务看板' })
    const p6 = c6.json.projectId
    await openProject(cdp, p6)
    const done6 = await waitDone(p6, 20000)
    const report6 = (done6.project?.messages || []).filter((m) => m.kind === 'report').pop()
    const race6 = report6?.meta?.race || []
    const fallback6 = race6.find((r) => r.source === 'fallback')
    const adopted6 = race6.find((r) => r.adopted)
    record('兜底候选存在但不被采用', Boolean(fallback6) && fallback6.adopted === false && adopted6?.source === 'model', `fallback=${fallback6?.score ?? '—'} adopted=${adopted6?.model ?? '—'}/${adopted6?.source ?? '—'}`)
    record('兜底候选得分更高也不得胜出', Boolean(fallback6 && adopted6 && fallback6.score > adopted6.score), `fallback=${fallback6?.score ?? '—'} model=${adopted6?.score ?? '—'}`)
    record('最终版本为模型页面并替换预览', done6.project?.versions[0]?.model === 'fake-b' && (done6.project?.html || '').includes('低分候选'), `model=${done6.project?.versions[0]?.model} html低分=${(done6.project?.html || '').includes('低分候选')}`)

    // 场景 7：任务看板 + 两路模型失败 → 允许匹配模板兜底，但必须明确标注
    console.log('[scenario7] 匹配模板兜底：明确标注')
    const c7 = await api('POST', '/api/projects', { prompt: 'BADHTML 做一个任务看板，支持添加和删除' })
    const p7 = c7.json.projectId
    const done7 = await waitDone(p7, 20000)
    const report7 = (done7.project?.messages || []).filter((m) => m.kind === 'report').pop()
    const versionMsg7 = (done7.project?.messages || []).filter((m) => m.kind === 'version').pop()
    record('匹配模板时允许兜底且来源为 fallback', done7.project?.versions[0]?.source === 'fallback', `source=${done7.project?.versions[0]?.source} model=${done7.project?.versions[0]?.model}`)
    record('兜底报告与版本明确标注演示兜底', Boolean(report7?.meta?.fallback) && /演示兜底/.test((report7?.meta?.notes || []).join('；')) && /演示兜底模板/.test(versionMsg7?.content || ''), `fallback=${report7?.meta?.fallback} notes=${(report7?.meta?.notes || []).join('；').slice(0, 80)}`)
    }
    cdp.close()
  } finally {
    chrome.kill('SIGTERM')
    app.kill('SIGTERM')
    fake.kill('SIGTERM')
  }

  const failed = results.filter((r) => !r.pass).length
  console.log(`\n[race-strategy] 合计 ${results.length} 项，通过 ${results.length - failed} 项，失败 ${failed} 项`)
  process.exit(failed ? 1 : 0)
}

main().catch((err) => {
  console.error('[race-strategy] 异常：', err)
  process.exit(1)
})
