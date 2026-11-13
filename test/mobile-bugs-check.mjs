/**
 * 手机复测 BUG-01 / BUG-02 回归：无头 Chrome + CDP
 * BUG-01：2048 分享页 375/390 棋盘完整可见、无横向溢出、刷新后局面保留；桌面 1440 不回归
 * BUG-02：工作台探针 0 原生对话框、按时返回且评分包含实测分；notes 删除按钮走 toast + 二次点击确认
 * 用法：先启动被测服务（MOCK_MODE=1 且 NODE_ENV=production），再
 *       QA_BASE=http://127.0.0.1:3400 node test/mobile-bugs-check.mjs
 * 截图输出：test/results/bug2048-375.png、bug2048-390.png、bug2048-1440.png、bug-notes-dialog.png
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

const BASE = (process.env.QA_BASE || 'http://127.0.0.1:3400').replace(/\/+$/, '')
const PORT = 9336
const RESULT_DIR = path.resolve('test/results')
const CHROME_PROFILE = '/tmp/qa-mobile-bugs-chrome'
const SHARE_2048 = '/s/g2a4m8'
const SHARE_NOTES = '/s/m4n8t2'

const jar = new Map()
function cookieHeader() {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
}
async function api(method, route, body) {
  const headers = {}
  if (jar.size) headers.cookie = cookieHeader()
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(`${BASE}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const list = res.headers.getSetCookie?.() || []
  for (const sc of list) {
    const pair = sc.split(';')[0]
    const idx = pair.indexOf('=')
    if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim())
  }
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
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
      // 双保险：若出现原生对话框，先记录再关闭，避免测试悬挂
      if (msg.method === 'Page.javascriptDialogOpening') {
        this.send('Page.handleJavaScriptDialog', { accept: false }, msg.sessionId).catch(() => {})
      }
    })
  }
  ready() {
    return new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true })
      this.ws.addEventListener('error', () => reject(new Error('CDP 连接失败')), { once: true })
    })
  }
  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.id
      this.pending.set(id, { resolve, reject })
      const payload = { id, method, params }
      if (sessionId) payload.sessionId = sessionId
      this.ws.send(JSON.stringify(payload))
    })
  }
  waitEvent(method, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待 ' + method + ' 超时')), timeoutMs)
      const onMsg = (ev) => {
        const msg = JSON.parse(ev.data)
        if (msg.method !== method) return
        clearTimeout(timer)
        this.ws.removeEventListener('message', onMsg)
        resolve(msg)
      }
      this.ws.addEventListener('message', onMsg)
    })
  }
  close() { this.ws.close() }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getJson(url, init) {
  const res = await fetch(url, init)
  if (!res.ok) throw new Error(url + ' → ' + res.status)
  return res.json()
}

async function evalIn(cdp, expression, target) {
  const params = { expression, returnByValue: true, awaitPromise: true }
  if (target) params.contextId = target.contextId
  const r = await cdp.send('Runtime.evaluate', params, target?.sessionId)
  if (r.exceptionDetails) throw new Error('页面求值异常：' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
  return r.result.value
}

/** 沙箱 iframe 是独立 target（OOPIF），autoAttach 后在会话内启用 Runtime/Page 并返回默认上下文 */
async function findSandbox(cdp, mark, timeoutMs = 12000) {
  const start = Date.now()
  const enabled = new Set()
  while (Date.now() - start < timeoutMs) {
    const events = cdp.events.slice(mark)
    for (const e of events) {
      if (e.method === 'Target.attachedToTarget' && e.params.targetInfo.type === 'iframe' && !enabled.has(e.params.sessionId)) {
        enabled.add(e.params.sessionId)
        await cdp.send('Runtime.enable', {}, e.params.sessionId).catch(() => {})
        await cdp.send('Page.enable', {}, e.params.sessionId).catch(() => {})
      }
    }
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]
      if (e.method === 'Runtime.executionContextCreated' && enabled.has(e.sessionId) && e.params.context.auxData?.isDefault) {
        return { sessionId: e.sessionId, contextId: e.params.context.id }
      }
    }
    await sleep(120)
  }
  throw new Error('未找到沙箱 iframe 执行上下文')
}

function dialogCount(cdp, since) {
  return cdp.events.slice(since).filter((e) => e.method === 'Page.javascriptDialogOpening').length
}

const results = []
function record(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`  ${pass ? 'PASS' : 'FAIL'} ${name}${detail ? `（${detail}）` : ''}`)
}

async function setViewport(cdp, width, height) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: width < 800 })
}

async function screenshot(cdp, file) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  fs.writeFileSync(path.join(RESULT_DIR, file), Buffer.from(shot.data, 'base64'))
}

async function navigate(cdp, url) {
  const mark = cdp.events.length
  const loaded = cdp.waitEvent('Page.loadEventFired')
  await cdp.send('Page.navigate', { url })
  await loaded
  return mark
}

/** BUG-02：工作台生成 notes 模板时自动探针；要求 0 原生对话框、实测分进入报告、评分不因弹窗掉分 */
async function workspaceProbeCheck(cdp) {
  console.log('[bug02] 工作台：创建含 confirm 的 notes 应用并等待自动探针')
  await setViewport(cdp, 1440, 900)
  const created = await api('POST', '/api/projects', { prompt: '做一个 Markdown 笔记应用，支持新建、搜索、删除，刷新后数据还在' })
  if (created.status !== 201) throw new Error('创建项目失败：' + created.status + ' ' + created.text.slice(0, 200))
  const projectId = created.json.projectId
  // 创建后立刻进入工作台，保证 run 仍处于等待探针回报的阶段
  const mark = await navigate(cdp, `${BASE}/p/${projectId}`)
  await sleep(600)
  const pageInfo = await evalIn(
    cdp,
    `(() => ({ text: document.body.innerText.slice(0, 160), iframes: document.querySelectorAll('iframe').length }))()`,
  ).catch(() => ({ text: 'N/A', iframes: -1 }))
  const runActiveAtOpen = (await api('GET', `/api/projects/${projectId}`)).json?.project?.activeRunId || null
  await findSandbox(cdp, mark).catch(() => {})
  let detail = null
  const started = Date.now()
  for (let i = 0; i < 90; i++) {
    const res = await api('GET', `/api/projects/${projectId}`)
    detail = res.json?.project || null
    if (detail && detail.versions?.length > 0) break
    await sleep(500)
  }
  if (!detail || !detail.versions?.length) throw new Error('等待生成版本超时')
  const report = (detail.messages || []).filter((m) => m.kind === 'report').pop()
  const probePart = report?.meta?.parts?.probe
  const versionScore = detail.versions[0].score
  const probeMetrics = report?.meta?.metrics
  const elapsed = ((Date.now() - started) / 1000).toFixed(1)
  record(
    '工作台探针 0 原生对话框且实测分进入报告',
    dialogCount(cdp, mark) === 0 && typeof probePart === 'number' && probePart >= 40,
    `dialog=${dialogCount(cdp, mark)} 实测分=${probePart}/50 模拟点击=${probeMetrics?.simulatedClicks ?? '—'} 等待=${elapsed}s run=${runActiveAtOpen ? 'active' : 'none'} iframe=${pageInfo.iframes} 页面=${pageInfo.text.replace(/\s+/g, ' ').slice(0, 60)}`,
  )
  record('工作台生成评分 ≥ 70（探针不再超时）', typeof versionScore === 'number' && versionScore >= 70, `v1 评分=${versionScore}`)
  return projectId
}

/** BUG-02：notes 分享页手动删除需二次点击确认；探针模式静默拒绝破坏性操作且按时返回 */
async function notesDialogCheck(cdp) {
  console.log('[bug02] 笔记分享页：手动二次确认 + 探针 dialog 监听')
  await setViewport(cdp, 375, 812)
  const mark = await navigate(cdp, `${BASE}${SHARE_NOTES}`)
  await sleep(900)
  const ctx = await findSandbox(cdp, mark)
  const dialogsBefore = dialogCount(cdp, mark)
  const counts = async () => evalIn(cdp, `document.querySelectorAll('.item').length`, ctx)
  // 新建一条笔记，便于观测删除结果
  await evalIn(cdp, `document.getElementById('new').click()`, ctx)
  await sleep(300)
  const before = await counts()
  // 首次点击删除：不执行，toast 提示 3 秒内再次点击
  await evalIn(cdp, `document.getElementById('remove').click()`, ctx)
  await sleep(250)
  const afterFirst = await counts()
  const toast = await evalIn(
    cdp,
    `(() => { const h = document.getElementById('__atoms_toast_host__'); return h ? h.innerText : '' })()`,
    ctx,
  )
  record('手动删除首次点击不执行 + toast 提示二次确认', before === 2 && afterFirst === 2 && toast.includes('再次点击'), `笔记=${before}→${afterFirst} toast=${toast.replace(/\s+/g, ' ').slice(0, 40)}`)
  await screenshot(cdp, 'bug-notes-dialog.png')
  // 3 秒内二次点击：确认删除
  await evalIn(cdp, `document.getElementById('remove').click()`, ctx)
  await sleep(350)
  const afterSecond = await counts()
  record('3 秒内二次点击确认删除成功', afterSecond === 1, `笔记=${before}→${afterSecond}`)
  // 探针：桌面端探针点击新/删也不会触发原生对话框，且 9s 内返回
  const probeStart = Date.now()
  await evalIn(
    cdp,
    `window.__qaProbe = null;
     window.addEventListener('message', function (e) {
       if (e.data && e.data.type === 'atoms-probe-result') window.__qaProbe = { id: e.data.id, metrics: e.data.metrics, at: Date.now() };
     });
     document.querySelector('iframe').contentWindow.postMessage({ type: 'atoms-probe', id: 'qa-dialog' }, '*'); true`,
    undefined,
  )
  let probe = null
  for (let i = 0; i < 50; i++) {
    probe = await evalIn(cdp, 'window.__qaProbe', undefined)
    if (probe) break
    await sleep(200)
  }
  const probeElapsed = Date.now() - probeStart
  const dialogsDuring = dialogCount(cdp, mark) - dialogsBefore
  record(
    '含 confirm 页面探针 9s 内返回且 0 原生对话框',
    Boolean(probe) && probeElapsed < 9000 && dialogsDuring === 0 && (probe.metrics?.simulatedClicks || 0) >= 1,
    probe ? `耗时=${probeElapsed}ms dialog=${dialogsDuring} 点击=${probe.metrics?.simulatedClicks} 报错=${probe.metrics?.errorCount}` : `未返回（${probeElapsed}ms）`,
  )
  // 探针结束后恢复手动模式：再次单击删除应重新出现 toast，而不是直接删除
  await evalIn(cdp, `document.getElementById('remove').click()`, ctx)
  await sleep(250)
  const toast2 = await evalIn(
    cdp,
    `(() => { const h = document.getElementById('__atoms_toast_host__'); return h ? h.innerText : '' })()`,
    ctx,
  )
  record('探针结束后 probing 状态已清理（恢复手动二次确认）', toast2.includes('再次点击'), `toast=${toast2.replace(/\s+/g, ' ').slice(0, 40)}`)
}

/** BUG-01：2048 分享页窄屏布局；桌面回归另测 */
async function game2048Layout(cdp, width, height, screenshotName) {
  await setViewport(cdp, width, height)
  const mark = await navigate(cdp, `${BASE}${SHARE_2048}`)
  await sleep(1000)
  const ctx = await findSandbox(cdp, mark)
  const info = await evalIn(
    cdp,
    `(() => {
      const board = document.getElementById('board');
      const cells = board.querySelectorAll('.cell');
      const rows = [...cells].reduce((m, c) => { const t = Math.round(c.getBoundingClientRect().top); m[t] = 1; return m; }, {});
      const br = board.getBoundingClientRect();
      const sub = document.querySelector('.sub');
      const tip = document.querySelector('.tip');
      const iframeHeight = window.innerHeight;
      return {
        innerWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        boardWidth: Math.round(br.width),
        boardBottom: Math.round(br.bottom),
        iframeHeight,
        rowCount: Object.keys(rows).length,
        cellCount: cells.length,
        subHidden: !sub || getComputedStyle(sub).display === 'none',
        tipHidden: !tip || getComputedStyle(tip).display === 'none',
      };
    })()`,
    ctx,
  )
  const parent = await evalIn(
    cdp,
    `(() => {
      const f = document.querySelector('iframe');
      return {
        innerWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
        frameTop: Math.round(f.getBoundingClientRect().top + window.scrollY),
        frameHeight: Math.round(f.getBoundingClientRect().height),
        frameBottom: Math.round(f.getBoundingClientRect().bottom + window.scrollY),
      };
    })()`,
  )
  if (screenshotName) await screenshot(cdp, screenshotName)
  const noOverflow = parent.scrollWidth <= parent.innerWidth + 1 && info.scrollWidth <= info.innerWidth + 1
  record(
    `${width}px 棋盘四行完整可见、无横向溢出`,
    info.cellCount === 16 && info.rowCount === 4 && info.boardBottom <= info.iframeHeight && noOverflow,
    `棋盘=${info.boardWidth}px 底部=${info.boardBottom}/${info.iframeHeight} 行=${info.rowCount} 外层宽=${parent.scrollWidth}/${parent.innerWidth} 沙箱宽=${info.scrollWidth}/${info.innerWidth}`,
  )
  return { info, parent, ctx, mark }
}

async function main() {
  fs.mkdirSync(RESULT_DIR, { recursive: true })
  fs.rmSync(CHROME_PROFILE, { recursive: true, force: true })
  const health = await api('GET', '/api/health')
  if (health.status !== 200) throw new Error('被测服务不可用：' + health.status)
  // 先建立游客会话：/api/health 不下发 Cookie，必须先拿到 atoms_sid 再注入浏览器
  await api('GET', '/api/me')
  const sid = jar.get('atoms_sid')
  if (!sid) throw new Error('未拿到游客会话 Cookie')

  const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${CHROME_PROFILE}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    'about:blank',
  ], { stdio: 'ignore' })

  try {
    let version = null
    for (let i = 0; i < 60 && !version; i++) {
      try { version = await getJson(`http://127.0.0.1:${PORT}/json/version`) } catch { await sleep(150) }
    }
    if (!version) throw new Error('Chrome 调试端口未就绪')
    const target = await getJson(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })
    const cdp = new CDP(target.webSocketDebuggerUrl)
    await cdp.ready()
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Log.enable')
    await cdp.send('Network.enable')
    await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
    await cdp.send('Network.setCookie', {
      name: 'atoms_sid',
      value: sid,
      url: BASE,
      path: '/',
      httpOnly: true,
      secure: false,
    })

    await workspaceProbeCheck(cdp)
    await notesDialogCheck(cdp)

    console.log('[bug01] 2048 分享页 375 / 390 / 1440')
    const r375 = await game2048Layout(cdp, 375, 812, 'bug2048-375.png')
    record(
      '375px 紧凑布局（副标题与提示隐藏、棋盘限宽）',
      r375.info.subHidden && r375.info.tipHidden && r375.info.boardWidth <= 360,
      `副标题隐藏=${r375.info.subHidden} 提示隐藏=${r375.info.tipHidden} 棋盘=${r375.info.boardWidth}px`,
    )

    // 刷新后局面保留：先在 375 视口走一步，等 KV 落库后刷新
    await evalIn(cdp, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))`, r375.ctx)
    await sleep(900)
    await setViewport(cdp, 375, 812)
    const reloadMark = await navigate(cdp, `${BASE}${SHARE_2048}`)
    await sleep(1000)
    const ctx2 = await findSandbox(cdp, reloadMark)
    const persisted = await evalIn(
      cdp,
      `(() => { try { const raw = localStorage.getItem('atoms_2048_state_v1'); if (!raw) return null; const s = JSON.parse(raw); return { tiles: s.board.filter((n) => n > 0).length, score: s.score }; } catch (e) { return null; } })()`,
      ctx2,
    )
    record('375px 刷新后局面保留', Boolean(persisted && persisted.tiles >= 2), persisted ? `方块=${persisted.tiles} 得分=${persisted.score}` : '无本地状态')

    const r390 = await game2048Layout(cdp, 390, 844, 'bug2048-390.png')
    record(
      '390px 紧凑布局（副标题与提示隐藏、棋盘限宽）',
      r390.info.subHidden && r390.info.tipHidden && r390.info.boardWidth <= 360,
      `副标题隐藏=${r390.info.subHidden} 提示隐藏=${r390.info.tipHidden} 棋盘=${r390.info.boardWidth}px`,
    )

    const r1440 = await game2048Layout(cdp, 1440, 900, 'bug2048-1440.png')
    record(
      '桌面 1440 不回归（棋盘 460px 上限、16 格完整）',
      r1440.info.boardWidth <= 460 && r1440.info.boardWidth >= 300 && r1440.info.cellCount === 16 && r1440.info.rowCount === 4,
      `棋盘=${r1440.info.boardWidth}px 格=${r1440.info.cellCount} 行=${r1440.info.rowCount}`,
    )

    const errors = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown')
    const csp = cdp.events.filter((e) => e.method === 'Log.entryAdded').map((e) => e.params.entry)
      .filter((e) => e.source === 'security' || /Content Security Policy|Refused to/i.test(e.text))
    record('全流程无 JS 异常 / 无 CSP 拦截', errors.length === 0 && csp.length === 0,
      errors[0]?.params?.exceptionDetails?.exception?.description?.slice(0, 120) || csp[0]?.text?.slice(0, 120) || 'screenshots=bug2048-375/390/1440.png')
    cdp.close()
  } finally {
    chrome.kill('SIGTERM')
  }

  const failed = results.filter((r) => !r.pass).length
  console.log(`\n[mobile-bugs] 合计 ${results.length} 项，通过 ${results.length - failed} 项，失败 ${failed} 项`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('[mobile-bugs] 异常：', err)
  process.exit(1)
})
