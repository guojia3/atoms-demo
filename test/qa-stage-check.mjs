/**
 * QA 测试阶段回归（浏览器 + fake-llm）：
 * 1) QA 全通过：时间线、用例覆盖、刷新持久化、KV 隔离、预览不抢焦点
 * 2) QA 失败 → 一键修复 → 复测通过
 * 3) 连续两轮修复失败 → blocked、停止自动修复、服务端 409
 * 4) 2048 模板：用例只覆盖实际功能（无输入/删除/清空/键盘用例）
 * 需先 npm run build；脚本自行启动 fake-llm、应用实例与无头 Chrome。
 */
import fs from 'node:fs'
import { spawn } from 'node:child_process'

const APP_PORT = 3462
const FAKE_PORT = 3998
const CDP_PORT = 9352
const BASE = `http://127.0.0.1:${APP_PORT}`
const DB = '/tmp/atoms-qa-stage.db'
const PROFILE = '/tmp/qa-qa-stage-chrome'

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

async function evalIn(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error('求值异常：' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
  return r.result.value
}

function startProc(cmd, args, env) {
  const child = spawn(cmd, args, { cwd: process.cwd(), env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', (d) => process.env.QA_STAGE_VERBOSE && process.stdout.write(String(d)))
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

async function projectOf(id) {
  const res = await api('GET', `/api/projects/${id}`)
  return res.json?.project || null
}

async function waitRunDone(projectId, timeoutMs = 35000) {
  const start = Date.now()
  let latest = null
  while (Date.now() - start < timeoutMs) {
    latest = await projectOf(projectId)
    if (latest && latest.versions.length > 0 && !latest.activeRunId) return { project: latest, elapsed: Date.now() - start }
    await sleep(180)
  }
  return { project: latest, elapsed: -1 }
}

async function waitNewRun(projectId, prevVersions, excludeRunId = null, timeoutMs = 10000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const project = await projectOf(projectId)
    if (
      project &&
      ((project.activeRunId && project.activeRunId !== excludeRunId) || project.versions.length > prevVersions)
    ) {
      return project
    }
    await sleep(120)
  }
  return null
}

function latestReport(project) {
  return (project?.messages || []).filter((m) => m.kind === 'report' && m.meta?.qa).pop()?.meta || null
}

async function openProject(cdp, projectId) {
  await cdp.send('Page.navigate', { url: `${BASE}/p/${projectId}` })
  await cdp.waitLoad()
  // 等 Workspace 建立 SSE（ui=1），否则服务端不会等待 QA
  await sleep(600)
}

async function watchRun(cdp, projectId, timeoutMs = 35000) {
  const start = Date.now()
  let sawQa = false
  let focusStolen = false
  let activeSeen = false
  while (Date.now() - start < timeoutMs) {
    const project = await projectOf(projectId)
    if (project?.activeRunId) activeSeen = true
    if (activeSeen && !project?.activeRunId) break
    const text = await evalIn(cdp, 'document.body.innerText').catch(() => '')
    if (/QA 测试/.test(text) && /正在执行/.test(text)) sawQa = true
    const tag = await evalIn(cdp, 'document.activeElement ? document.activeElement.tagName : ""').catch(() => '')
    if (tag === 'IFRAME') focusStolen = true
    await sleep(120)
  }
  return { sawQa, focusStolen }
}

async function clickFix(cdp) {
  return evalIn(
    cdp,
    `(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '一键修复')
      if (!btn) return false
      btn.click()
      return true
    })()`,
  )
}

async function hasFixButton(cdp) {
  return evalIn(
    cdp,
    `Boolean([...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '一键修复'))`,
  )
}

async function waitForText(cdp, re, timeoutMs = 5000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const text = await evalIn(cdp, 'document.body.innerText').catch(() => '')
    if (re.test(text)) return true
    await sleep(150)
  }
  return false
}

async function waitForQaRunning(cdp, timeoutMs = 15000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const text = await evalIn(cdp, 'document.body.innerText').catch(() => '')
    // 进入 QA 阶段后编辑区重新可用（chatBusy=false），以此区分“时间线预留的 QA 步骤”
    const hasComposer = await evalIn(cdp, 'Boolean(document.querySelector("textarea"))').catch(() => false)
    if (hasComposer && /QA 测试/.test(text) && /正在执行/.test(text)) return true
    await sleep(80)
  }
  return false
}

async function sendEditDuringQa(cdp, content) {
  return evalIn(
    cdp,
    `(async () => {
      const ta = document.querySelector('textarea')
      if (!ta) return 'no-textarea'
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
      setter.call(ta, ${JSON.stringify(content)})
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 80))
      const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '发送')
      if (!btn || btn.disabled) return 'no-button'
      btn.click()
      return 'sent'
    })()`,
  )
}

const results = []
function record(name, pass, detail) {
  results.push({ name, pass })
  console.log(`  ${pass ? 'PASS' : 'FAIL'} ${name}${detail ? `（${detail}）` : ''}`)
}

async function main() {
  fs.rmSync(DB, { force: true })
  fs.rmSync(`${DB}-wal`, { force: true })
  fs.rmSync(`${DB}-shm`, { force: true })
  fs.rmSync(PROFILE, { recursive: true, force: true })

  const fake = startProc('node', ['test/fake-llm.mjs'], { FAKE_LLM_PORT: String(FAKE_PORT) })
  const providers = JSON.stringify([
    { name: 'fake-a', baseUrl: `http://127.0.0.1:${FAKE_PORT}/v1`, apiKey: 'qa', model: 'fake-a' },
  ])
  const app = startProc('node', ['node_modules/tsx/dist/cli.mjs', 'src/server/index.ts'], {
    PORT: String(APP_PORT),
    DATABASE_PATH: DB,
    NODE_ENV: 'production',
    MOCK_MODE: '0',
    LLM_PROVIDERS: providers,
    RACE_COUNT: '1',
    PROBE_TIMEOUT_MS: '5000',
    QA_TIMEOUT_MS: '25000',
    GENERATION_RATE_LIMIT: '100',
  })

  const chrome = spawn(
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    [
      '--headless=new',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${PROFILE}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--hide-scrollbars',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

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
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
    await cdp.send('Network.setCookie', { name: 'atoms_sid', value: sid, url: BASE, path: '/', httpOnly: true, secure: false })

    // 场景 1：QA 全部通过
    console.log('[scenario1] QA 通过、时间线、持久化、隔离与焦点')
    const c1 = await api('POST', '/api/projects', { prompt: '做一个记录工具，支持添加、删除和清空' })
    if (c1.status !== 201) throw new Error('创建失败：' + c1.status + ' ' + c1.text.slice(0, 200))
    const p1 = c1.json.projectId
    await openProject(cdp, p1)
    const watch1 = await watchRun(cdp, p1)
    const done1 = await waitRunDone(p1)
    const report1 = latestReport(done1.project)
    const qa1 = report1?.qa
    const kinds1 = (qa1?.cases || []).map((c) => c.kind)
    const kv1 = await api('GET', `/api/projects/${p1}/kv`)
    record('时间线出现 QA 测试步骤', watch1.sawQa, `sawQa=${watch1.sawQa}`)
    record('QA 全部通过且用例数在 8-10 条', Boolean(qa1) && qa1.failed === 0 && qa1.total >= 8 && qa1.total <= 10, `total=${qa1?.total} failed=${qa1?.failed}`)
    record('QA 总耗时控制在 12s 内', Boolean(qa1) && qa1.durationMs <= 12000, `durationMs=${qa1?.durationMs}`)
    record('QA 覆盖加载/主流程/表单/删除/清空/持久化', ['load', 'viewport', 'main-flow', 'invalid-input', 'delete', 'clear', 'last-delete', 'persistence'].every((k) => kinds1.includes(k)), kinds1.join(','))
    record('每条 QA 用例都有执行结果和证据', Boolean(qa1) && qa1.cases.every((c) => (c.status === 'passed' || c.status === 'failed') && c.evidence), '')
    const reportText1 = JSON.stringify(report1 || {})
    record('报告不含未执行/未验证行', !/未执行|未验证/.test(reportText1), '')
    record('刷新持久化用例真实恢复页面', Boolean((qa1?.cases || []).find((c) => c.kind === 'persistence')?.evidence.includes('刷新后')), (qa1?.cases || []).find((c) => c.kind === 'persistence')?.evidence || '')
    record('验收只保留有 QA 证据的条目且满分', Boolean(report1?.acceptance) && report1.acceptance.score === 40 && report1.acceptance.items.every((i) => i.caseIds.length > 0), `score=${report1?.acceptance?.score} items=${report1?.acceptance?.items?.length}`)
    record('最终分数 = 静态 + 实测 + 验收', done1.project.versions[0].score === 100 && report1.parts.checklist === 40, `score=${done1.project.versions[0].score} parts=${JSON.stringify(report1.parts)}`)
    record('QA 未污染正式项目 KV', !Object.values(kv1.json?.data || {}).some((v) => /QA 测试项|QA 用例项|QA 键盘项/.test(String(v))), JSON.stringify(kv1.json?.data || {}).slice(0, 120))
    record('QA 运行期间未抢预览焦点', !watch1.focusStolen, `focusStolen=${watch1.focusStolen}`)
    record('预览仍为最终成品', (done1.project.html || '').includes('QA Demo'), '')

    // 场景 2：QA 失败 → 一键修复 → 复测通过
    console.log('[scenario2] QA 失败 + 一键修复复测')
    const c2 = await api('POST', '/api/projects', { prompt: 'QABROKEN 做一个记录工具，支持添加和清空' })
    const p2 = c2.json.projectId
    await openProject(cdp, p2)
    await watchRun(cdp, p2)
    const done2a = await waitRunDone(p2)
    const report2a = latestReport(done2a.project)
    record('不完整页面触发 QA 失败', Boolean(report2a?.qa) && report2a.qa.failed > 0, `failed=${report2a?.qa?.failed} cases=${report2a?.qa?.total}`)
    record('QA 失败后出现一键修复且未 blocked', Boolean(report2a?.qa) && report2a.qa.blocked !== true && (await hasFixButton(cdp)), `blocked=${report2a?.qa?.blocked}`)
    const clicked2 = await clickFix(cdp)
    record('点击一键修复能启动新一轮', clicked2 && Boolean(await waitNewRun(p2, done2a.project.versions.length)), `clicked=${clicked2}`)
    const done2b = await waitRunDone(p2)
    const report2b = latestReport(done2b.project)
    const failedKinds2 = report2a.qa.cases.filter((c) => c.status === 'failed').map((c) => c.kind)
    const retest2 = [...failedKinds2, failedKinds2.includes('load') ? 'viewport' : 'load']
    record('修复后 QA 复测通过', Boolean(report2b?.qa) && report2b.qa.failed === 0 && report2b.qa.repairRounds === 1, `failed=${report2b?.qa?.failed} rounds=${report2b?.qa?.repairRounds}`)
    record(
      '修复轮只复测失败用例 + 1 条冒烟并合并历史证据',
      Boolean(report2b?.qa) &&
        (report2b.qa.retested || []).join(',') === retest2.join(',') &&
        report2b.qa.cases.length === report2a.qa.cases.length &&
        (report2b.qa.retested || []).length < report2b.qa.cases.length,
      `retested=${(report2b?.qa?.retested || []).join(',')} cases=${report2b?.qa?.cases?.length}`,
    )
    record('修复后保存新版本且得分恢复', done2b.project.versions.length === 2 && done2b.project.versions[0].score >= 70, `versions=${done2b.project.versions.length} score=${done2b.project.versions[0].score}`)

    // 场景 3：连续两轮失败 → blocked、停止自动修复
    console.log('[scenario3] 两轮修复后停止')
    const c3 = await api('POST', '/api/projects', { prompt: 'QABROKENALWAYS 做一个记录工具，支持添加和清空' })
    const p3 = c3.json.projectId
    await openProject(cdp, p3)
    await watchRun(cdp, p3)
    const done3a = await waitRunDone(p3)
    const report3a = latestReport(done3a.project)
    record('首轮 QA 失败且未 blocked', Boolean(report3a?.qa) && report3a.qa.failed > 0 && report3a.qa.blocked !== true, `failed=${report3a?.qa?.failed}`)
    if (!(await clickFix(cdp))) throw new Error('首轮修复按钮不可用')
    await waitNewRun(p3, done3a.project.versions.length)
    const done3b = await waitRunDone(p3)
    const report3b = latestReport(done3b.project)
    record('第 1 轮修复后仍失败但未 blocked', Boolean(report3b?.qa) && report3b.qa.failed > 0 && report3b.qa.blocked !== true && report3b.qa.repairRounds === 1, `rounds=${report3b?.qa?.repairRounds} blocked=${report3b?.qa?.blocked}`)
    record('第 1 轮只复测失败项并保留历史用例', Boolean(report3b?.qa) && (report3b.qa.retested || []).length === 2 && report3b.qa.cases.length === report3a.qa.cases.length, `retested=${(report3b?.qa?.retested || []).join(',')} cases=${report3b?.qa?.cases?.length}`)
    if (!(await clickFix(cdp))) throw new Error('第二轮修复按钮不可用')
    await waitNewRun(p3, done3b.project.versions.length)
    const done3c = await waitRunDone(p3)
    const report3c = latestReport(done3c.project)
    const conclusion3 = (done3c.project.messages || []).filter((m) => m.kind === 'conclusion').pop()?.content || ''
    record('第 2 轮后 blocked 并停止自动修复', Boolean(report3c?.qa) && report3c.qa.blocked === true && report3c.qa.repairRounds === 2, `rounds=${report3c?.qa?.repairRounds} blocked=${report3c?.qa?.blocked}`)
    record('blocked 后报告显示修复上限', await waitForText(cdp, /修复上限/, 5000), '')
    record('blocked 后不再显示一键修复', !(await hasFixButton(cdp)), '')
    record('blocked 结论说明两轮修复上限', /两轮修复/.test(conclusion3), conclusion3.slice(0, 100))
    const again3 = await api('POST', `/api/projects/${p3}/messages`, { content: '再修复一次', mode: 'fix' })
    record('服务端拒绝超过 2 轮的修复请求', again3.status === 409, `status=${again3.status}`)

    // 场景 4：2048 模板只生成实际功能用例
    console.log('[scenario4] 2048 成品用例只覆盖实际功能')
    const c4 = await api('POST', '/api/projects', { prompt: 'BADHTML 做一个 2048 数字合并游戏' })
    const p4 = c4.json.projectId
    await openProject(cdp, p4)
    await watchRun(cdp, p4)
    const done4 = await waitRunDone(p4)
    const report4 = latestReport(done4.project)
    const qa4 = report4?.qa
    const kinds4 = (qa4?.cases || []).map((c) => c.kind)
    record('2048 成品 QA 全部通过', Boolean(qa4) && qa4.failed === 0 && qa4.total >= 4, `total=${qa4?.total} failed=${qa4?.failed}`)
    record('2048 不生成输入/删除/清空/键盘用例', !kinds4.includes('invalid-input') && !kinds4.includes('keyboard') && !kinds4.includes('delete') && !kinds4.includes('clear') && !kinds4.includes('last-delete'), kinds4.join(','))
    record('2048 仍覆盖加载与主流程', kinds4.includes('load') && kinds4.includes('viewport') && kinds4.includes('main-flow'), kinds4.join(','))
    record('2048 使用兜底模板但 QA 正常执行', done4.project.versions[0].source === 'fallback' && Boolean(report4?.fallback), `source=${done4.project.versions[0].source}`)

    // 场景 5：QA 运行中发起新编辑 → 取消旧 QA，对新版本重新 QA
    console.log('[scenario5] QA 运行中编辑：取消旧 QA 并复测新版本')
    const c5 = await api('POST', '/api/projects', { prompt: '做一个记录工具，支持添加、删除和清空' })
    const p5 = c5.json.projectId
    await openProject(cdp, p5)
    const before5 = await projectOf(p5)
    const qaRunning5 = await waitForQaRunning(cdp)
    const send5 = qaRunning5 ? await sendEditDuringQa(cdp, '把标题改成 QA Demo 已修改') : 'qa-not-running'
    record('QA 运行中仍可继续编辑成品', qaRunning5 && send5 === 'sent', `qaRunning=${qaRunning5} send=${send5}`)
    const newRun5 = await waitNewRun(p5, 1, before5?.activeRunId || null)
    record('新编辑立即启动新一轮', Boolean(newRun5?.activeRunId), `active=${newRun5?.activeRunId || '—'}`)
    const done5 = await waitRunDone(p5, 40000)
    const reports5 = (done5.project.messages || []).filter((m) => m.kind === 'report')
    const report5 = latestReport(done5.project)
    record('旧 QA 被取消，只保留新版本报告', reports5.length === 1 && done5.project.versions.length === 2, `reports=${reports5.length} versions=${done5.project.versions.length}`)
    record('新版本重新完成 QA 且通过', Boolean(report5?.qa) && report5.qa.failed === 0 && report5.qa.total >= 8, `total=${report5?.qa?.total} failed=${report5?.qa?.failed}`)
    record('普通编辑重跑全量 QA 而非修复复测', Boolean(report5?.qa) && !report5.qa.retested, `retested=${(report5?.qa?.retested || []).join(',') || '—'}`)
    record('编辑后的页面进入新版本', (done5.project.html || '').includes('QA Demo 已修改'), '')

    cdp.close()
  } finally {
    chrome.kill('SIGTERM')
    app.kill('SIGTERM')
    fake.kill('SIGTERM')
  }

  const failed = results.filter((r) => !r.pass).length
  console.log(`\n[qa-stage] 合计 ${results.length} 项，通过 ${results.length - failed} 项，失败 ${failed} 项`)
  process.exit(failed ? 1 : 0)
}

main().catch((err) => {
  console.error('[qa-stage] 异常：', err)
  process.exit(1)
})
