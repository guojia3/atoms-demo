/**
 * 工作台预览区六阶段进度回归（浏览器 + fake-llm）：
 * 1) 无预览：完整阶段列表；生成阶段高亮
 * 2) 首候选预览：收成顶部细条；赛马等待
 * 3) QA、验收、完成：阶段切换与报告两块
 * 4) 失败、停止：不误显示完成
 * 5) 375px：折叠“当前：阶段 n/6”，可展开六阶段，无横向溢出
 * 需先 npm run build；脚本自行启动 fake-llm、应用实例与无头 Chrome。
 */
import fs from 'node:fs'
import { spawn } from 'node:child_process'

const APP_PORT = 3470
const FAKE_PORT = 3996
const CDP_PORT = 9364
const BASE = `http://127.0.0.1:${APP_PORT}`
const DB = '/tmp/atoms-stage-check.db'
const PROFILE = '/tmp/qa-stage-progress-chrome'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
  send(method, params = {}) {
    return new Promise((res, rej) => {
      const id = ++this.id
      this.pending.set(id, { resolve: res, reject: rej })
      this.ws.send(JSON.stringify({ id, method, params }))
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
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
  return r.result.value
}

function startProc(cmd, args, env) {
  const child = spawn(cmd, args, { cwd: process.cwd(), env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', (d) => process.env.STAGE_VERBOSE && process.stdout.write(String(d)))
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

async function stageInfo(cdp) {
  return evalIn(
    cdp,
    `(() => {
      const el = document.querySelector('[data-stage-panel]')
      const full = document.querySelector('[data-stage-panel="full"]')
      const compact = document.querySelector('[data-stage-panel="compact"]')
      const cur = document.querySelector('[aria-current="step"]')
      const text = document.body.innerText
      return {
        full: Boolean(full),
        compact: Boolean(compact),
        overall: el ? el.getAttribute('data-stage-overall') : null,
        current: el ? el.getAttribute('data-stage-current') : null,
        summary: el ? el.getAttribute('data-stage-summary') : null,
        currentText: cur ? cur.textContent.replace(/\\s+/g, ' ').trim() : null,
        raceWait: /等待其余候选/.test(text),
        qaTimeline: /QA 测试/.test(text),
        reportSections: /QA 测试结果/.test(text) && /验收判定/.test(text),
        overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      }
    })()`,
  )
}

async function expandCompact(cdp) {
  return evalIn(
    cdp,
    `(() => {
      const btn = document.querySelector('button[aria-controls="stage-progress-expanded"]')
      if (!btn) return false
      if (btn.getAttribute('aria-expanded') !== 'true') btn.click()
      return true
    })()`,
  )
}

async function stageTitles(cdp) {
  return evalIn(cdp, `[...document.querySelectorAll('[data-stage-panel] li[title]')].map((li) => li.getAttribute('title'))`)
}

async function projectOf(cdp, id) {
  const json = await evalIn(cdp, `fetch('/api/projects/${id}').then((r) => r.json()).catch(() => null)`).catch(() => null)
  return json?.project || null
}

async function screenshot(cdp, name) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }).catch(() => null)
  if (!shot?.data) return
  fs.mkdirSync('test/results', { recursive: true })
  fs.writeFileSync(`test/results/${name}`, Buffer.from(shot.data, 'base64'))
}

async function createViaUI(cdp, prompt) {
  await cdp.send('Page.navigate', { url: BASE })
  await cdp.waitLoad()
  const submittedAt = Date.now()
  const submitted = await evalIn(
    cdp,
    `(async () => {
      const ta = document.querySelector('textarea')
      if (!ta) return 'no-textarea'
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
      setter.call(ta, ${JSON.stringify(prompt)})
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 120))
      const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('开始生成'))
      if (!btn || btn.disabled) return 'no-button'
      btn.click()
      return 'sent'
    })()`,
  )
  let projectId = ''
  const start = Date.now()
  while (Date.now() - start < 15000) {
    const path = await evalIn(cdp, 'location.pathname').catch(() => '')
    if (/^\/p\/[^/]+/.test(path)) { projectId = path.split('/')[2]; break }
    await sleep(100)
  }
  if (!projectId) throw new Error(`未进入项目页（${submitted}）`)
  return { projectId, submittedAt }
}

async function watchStages(cdp, projectId, submittedAt, timeoutMs = 30000, shotPrefix = '') {
  const start = Date.now()
  const transitions = []
  let lastKey = null
  let fullSeen = false
  let compactSeen = false
  let raceSeen = false
  let qaSeen = false
  let raceWaitSeen = false
  let qaTimelineSeen = false
  let compactSummaryDuringRun = ''
  let firstFullAt = -1
  let firstCompactAt = -1
  let final = null
  while (Date.now() - start < timeoutMs) {
    const info = await stageInfo(cdp)
    if (info.full && !fullSeen) {
      fullSeen = true
      firstFullAt = Date.now() - submittedAt
      if (shotPrefix) await screenshot(cdp, `${shotPrefix}-full.png`)
    }
    if (info.compact && !compactSeen) {
      compactSeen = true
      firstCompactAt = Date.now() - submittedAt
      compactSummaryDuringRun = info.summary || ''
      if (shotPrefix) await screenshot(cdp, `${shotPrefix}-compact.png`)
    }
    if (info.current && info.current !== lastKey) {
      transitions.push({ key: info.current, at: Date.now() - submittedAt, panel: info.full ? 'full' : 'compact' })
      lastKey = info.current
    }
    if (info.current === 'race') {
      raceSeen = true
      if (info.raceWait) raceWaitSeen = true
    }
    if (info.current === 'qa') {
      qaSeen = true
      if (info.qaTimeline && !info.reportSections) qaTimelineSeen = true
    }
    if (info.overall === 'done' || info.overall === 'failed' || info.overall === 'stopped') {
      final = info
      break
    }
    await sleep(80)
  }
  const project = await projectOf(cdp, projectId)
  if (shotPrefix && final) await screenshot(cdp, `${shotPrefix}-done.png`)
  return {
    transitions,
    fullSeen,
    compactSeen,
    raceSeen,
    qaSeen,
    raceWaitSeen,
    qaTimelineSeen,
    compactSummaryDuringRun,
    firstFullAt,
    firstCompactAt,
    final,
    project,
  }
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

  const fake = startProc('node', ['test/fake-llm.mjs'], { FAKE_LLM_PORT: String(FAKE_PORT), RACE_SLOW_MS: '1500' })
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
    RACE_GRACE_MS: '8000',
    RACE_LOW_SCORE_GRACE_MS: '8000',
    PROBE_TIMEOUT_MS: '5000',
    GENERATION_RATE_LIMIT: '100',
  })

  const chrome = spawn(
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', 'about:blank'],
    { stdio: 'ignore' },
  )

  try {
    if (!(await waitHealth(`${BASE}/api/health`))) throw new Error('应用实例未就绪')
    if (!(await waitHealth(`http://127.0.0.1:${FAKE_PORT}/stats`))) throw new Error('fake-llm 未就绪')
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

    // 场景 1：慢生成 → 无预览完整阶段列表 → QA → 完成
    console.log('[stage1] 无预览完整阶段列表 + QA + 完成')
    let mark = cdp.events.length
    const s1 = await createViaUI(cdp, 'SLOWCREATE 做一个记录工具，支持添加、删除、清空，刷新后数据还在')
    const w1 = await watchStages(cdp, s1.projectId, s1.submittedAt, 30000, 'stage1')
    const tr1 = w1.transitions.map((t) => t.key)
    record('未出首候选时显示完整阶段列表', w1.fullSeen && w1.transitions.some((t) => t.panel === 'full'), `fullAt=${w1.firstFullAt}ms`)
    record('生成阶段高亮', tr1.includes('generate'), tr1.join('→'))
    record('首候选出现后收成顶部细条', w1.compactSeen, `compactAt=${w1.firstCompactAt}ms`)
    record('QA 阶段在时间线与阶段条中一致', w1.qaSeen && w1.qaTimelineSeen, `qaSeen=${w1.qaSeen} timeline=${w1.qaTimelineSeen}`)
    record('完成后显示完成且六阶段全勾选', w1.final?.overall === 'done' && /^完成/.test(w1.final?.summary || ''), `summary=${w1.final?.summary}`)
    await expandCompact(cdp)
    const titles1 = await stageTitles(cdp)
    record('完成态六阶段状态可读', titles1.length === 6 && titles1.every((t) => /已完成/.test(t || '')), titles1.join(' / '))
    record('报告含 QA 结果与验收判定两块', Boolean(w1.final?.reportSections), '')
    const score1 = w1.project?.versions?.[0]?.score
    record('完成摘要含版本与得分', Boolean(score1 != null && (w1.final?.summary || '').includes(`${score1} 分`)), `score=${score1} summary=${w1.final?.summary}`)
    record('无 console 异常', cdp.events.slice(mark).filter((e) => e.method === 'Runtime.exceptionThrown').length === 0, '')

    // 场景 2：首候选快、慢候选等待 → 赛马阶段
    console.log('[stage2] 首候选预览后的赛马等待')
    mark = cdp.events.length
    const s2 = await createViaUI(cdp, 'RACESLOWB 做一个记录工具，支持添加和删除')
    const w2 = await watchStages(cdp, s2.projectId, s2.submittedAt, 30000, 'stage2')
    record('首候选预览后进入赛马并等待其余候选', w2.compactSeen && w2.raceSeen && w2.transitions.some((t) => t.key === 'race'), w2.transitions.map((t) => t.key).join('→'))
    record('赛马阶段与左侧“等待其余候选”一致', w2.raceSeen && w2.raceWaitSeen, `race=${w2.raceSeen} wait=${w2.raceWaitSeen}`)
    record('赛马后进入 QA 并最终完成', w2.qaSeen && w2.final?.overall === 'done', `qa=${w2.qaSeen} summary=${w2.final?.summary}`)
    record('赛马场景无 console 异常', cdp.events.slice(mark).filter((e) => e.method === 'Runtime.exceptionThrown').length === 0, '')

    // 场景 3：双路生成失败 → 失败，不误显示完成
    console.log('[stage3] 生成失败')
    const s3 = await createViaUI(cdp, 'HTTP402 做一个记录工具')
    const w3 = await watchStages(cdp, s3.projectId, s3.submittedAt, 20000, 'stage3')
    record('失败显示失败且不显示完成', w3.final?.overall === 'failed' && w3.final?.summary === '失败', `overall=${w3.final?.overall} summary=${w3.final?.summary}`)
    record('失败态当前阶段不标完成', w3.transitions.every((t) => t.key !== 'done'), w3.transitions.map((t) => t.key).join('→'))

    // 场景 4：生成中停止 → 已停止
    console.log('[stage4] 用户停止')
    const s4 = await createViaUI(cdp, 'SLOWCREATE 做一个记录工具')
    await waitHealth(`${BASE}/api/health`, 1000)
    const stopStart = Date.now()
    let stopOk = false
    while (Date.now() - stopStart < 5000) {
      const clicked = await evalIn(
        cdp,
        `(() => { const b=[...document.querySelectorAll('button')].find((x)=>(x.textContent||'').trim()==='停止'); if(!b) return false; b.click(); return true })()`,
      )
      if (clicked) { stopOk = true; break }
      await sleep(100)
    }
    const w4 = await watchStages(cdp, s4.projectId, s4.submittedAt, 15000, 'stage4')
    record('停止显示已停止且不显示完成', stopOk && w4.final?.overall === 'stopped' && w4.final?.summary === '已停止', `stopped=${stopOk} overall=${w4.final?.overall} summary=${w4.final?.summary}`)

    // 场景 5：375px 折叠 + 展开
    console.log('[stage5] 375px 折叠与展开')
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: true })
    mark = cdp.events.length
    const s5 = await createViaUI(cdp, 'SLOWCREATE 做一个记录工具，支持添加和删除')
    // 切到预览面板
    await evalIn(cdp, `(() => { const b=[...document.querySelectorAll('button')].find((x)=>(x.textContent||'').trim()==='预览'); if(b) b.click(); return Boolean(b) })()`)
    await sleep(200)
    const mobileFull = await stageInfo(cdp)
    record('375 未出预览时完整阶段列表不横向溢出', mobileFull.full && !mobileFull.overflow, `overflow=${mobileFull.overflow}`)
    const w5 = await watchStages(cdp, s5.projectId, s5.submittedAt, 30000, 'stage5')
    const mobileEnd = await stageInfo(cdp)
    record(
      '375 运行中折叠为“当前：阶段 n/6”',
      w5.compactSeen && /^当前：/.test(w5.compactSummaryDuringRun),
      `during=${w5.compactSummaryDuringRun}`,
    )
    record('375 完成后折叠摘要显示完成', /^完成/.test(mobileEnd.summary || ''), `final=${mobileEnd.summary}`)
    await expandCompact(cdp)
    const mobileTitles = await stageTitles(cdp)
    const mobileExpanded = await stageInfo(cdp)
    await screenshot(cdp, 'stage5-mobile-expanded.png')
    record('375 可展开查看六阶段', mobileTitles.length === 6 && !mobileExpanded.overflow, `titles=${mobileTitles.length} overflow=${mobileExpanded.overflow}`)
    record('375 全程无横向溢出', !mobileFull.overflow && !mobileExpanded.overflow, '')
    record('375 无 console 异常', cdp.events.slice(mark).filter((e) => e.method === 'Runtime.exceptionThrown').length === 0, '')

    fs.writeFileSync(
      '/tmp/atoms-stage-check-result.json',
      JSON.stringify(
        {
          scenario1: { transitions: w1.transitions, final: w1.final, score: w1.project?.versions?.[0]?.score, titles: titles1 },
          scenario2: { transitions: w2.transitions, final: w2.final },
          scenario3: { transitions: w3.transitions, final: w3.final },
          scenario4: { transitions: w4.transitions, final: w4.final },
          scenario5: { transitions: w5.transitions, final: mobileEnd, titles: mobileTitles },
        },
        null,
        2,
      ),
    )
    cdp.close()
  } finally {
    chrome.kill('SIGTERM')
    app.kill('SIGTERM')
    fake.kill('SIGTERM')
  }

  const failed = results.filter((r) => !r.pass).length
  console.log(`\n[stage-progress] 合计 ${results.length} 项，通过 ${results.length - failed} 项，失败 ${failed} 项`)
  process.exit(failed ? 1 : 0)
}

main().catch((err) => {
  console.error('[stage-progress] 异常：', err)
  process.exit(1)
})
