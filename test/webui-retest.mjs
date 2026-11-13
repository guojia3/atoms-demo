/**
 * WEB10 版本回退 UI 复测：桌面视口真实点击“版本历史 → 恢复”
 * 用法：QA_BASE=http://127.0.0.1:3200 node test/webui-retest.mjs
 * 判定：恢复后生成新版本（不覆盖历史）、当前版本 HTML 与所选版本一致、toast 提示
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const BASE = (process.env.QA_BASE || 'http://127.0.0.1:3200').replace(/\/+$/, '')
const PORT = 9334
const RESULT_DIR = path.resolve('test/results')
const METRICS = {
  elements: 42, textLength: 600, errors: [], errorCount: 0, clicks: 5, mutations: 10, keys: 1,
  writes: 3, overflowX: false, width: 1280, title: 'WEB10', interactiveClicks: 3,
  simulatedClicks: 3, simulatedChanges: 3, simulatedWrites: 2,
}

const jar = new Map()
async function api(method, route, body) {
  const headers = {}
  if (jar.size) headers.cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
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
  try { json = text ? JSON.parse(text) : null } catch { json = null }
  return { status: res.status, json, text }
}

async function consumeRun(runId) {
  const res = await fetch(`${BASE}/api/runs/${runId}/events`, { headers: { cookie: [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ') } })
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const reported = new Set()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const blocks = buffer.split('\n\n')
    buffer = blocks.pop() || ''
    for (const block of blocks) {
      const line = block.split('\n').find((l) => l.startsWith('data:'))
      if (!line) continue
      let event
      try { event = JSON.parse(line.slice(5).trim()) } catch { continue }
      if (event.type === 'candidates') {
        for (const c of event.data?.candidates || []) {
          if (reported.has(c.id)) continue
          reported.add(c.id)
          await api('POST', `/api/candidates/${c.id}/report`, { metrics: METRICS })
        }
      }
      if (event.type === 'done') { await reader.cancel().catch(() => {}); return }
    }
  }
}

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.id = 0
    this.pending = new Map()
    this.waiters = []
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id) {
        const p = this.pending.get(msg.id)
        if (!p) return
        this.pending.delete(msg.id)
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result)
        return
      }
      for (const w of [...this.waiters]) {
        if (w.match(msg)) {
          this.waiters.splice(this.waiters.indexOf(w), 1)
          w.resolve(msg)
        }
      }
    })
  }
  ready() {
    return new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true })
      this.ws.addEventListener('error', () => reject(new Error('CDP 连接失败')), { once: true })
    })
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  waitEvent(method, timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`等待 ${method} 超时`)), timeoutMs)
      this.waiters.push({
        match: (msg) => msg.method === method,
        resolve: (msg) => { clearTimeout(timer); resolve(msg) },
      })
    })
  }
}

async function getJson(url, init) {
  const res = await fetch(url, init)
  if (!res.ok) throw new Error(`${url} → ${res.status}`)
  return res.json()
}

async function evalExpr(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(`页面求值异常：${r.exceptionDetails.text}`)
  return r.result.value
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
function check(label, pass, detail) {
  if (pass) console.log(`  PASS  ${label}（${detail}）`)
  else { failures += 1; console.log(`  FAIL  ${label} → ${detail}`) }
}

async function main() {
  fs.mkdirSync(RESULT_DIR, { recursive: true })

  console.log('[webui] 准备含 2 个版本的项目')
  await api('GET', '/api/me')
  const created = await api('POST', '/api/projects', { prompt: '做一个任务看板，支持添加任务并在三列之间推进' })
  await consumeRun(created.json.runId)
  const edit = await api('POST', `/api/projects/${created.json.projectId}/messages`, { content: '把主色改成绿色，并在底部增加一个统计栏' })
  await consumeRun(edit.json.runId)
  const before = await api('GET', `/api/projects/${created.json.projectId}`)
  const v1 = before.json.project.versions.find((v) => v.seq === 1)
  const v2 = before.json.project.versions.find((v) => v.seq === 2)
  if (!v1 || !v2) throw new Error('前置失败：未生成 v1/v2')
  const v1Html = (await api('GET', `/api/projects/${created.json.projectId}/versions/${v1.id}/html`)).json.html

  const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new', `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/qa-chrome-webui',
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', 'about:blank',
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
    await cdp.send('Network.enable')
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false })
    await cdp.send('Network.setCookie', {
      name: 'atoms_sid', value: jar.get('atoms_sid'), domain: '127.0.0.1', path: '/', httpOnly: true, secure: false,
    })
    const loaded = cdp.waitEvent('Page.loadEventFired', 15000)
    await cdp.send('Page.navigate', { url: `${BASE}/p/${created.json.projectId}` })
    await loaded
    await sleep(1800)

    const opened = await evalExpr(cdp, `(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === '版本历史')
      if (!btn) return { ok: false, text: document.body.innerText.slice(0, 200) }
      btn.click()
      return { ok: true }
    })()`)
    await sleep(400)
    const drawer = await evalExpr(cdp, `(() => ({
      heading: [...document.querySelectorAll('h2')].some((h) => h.innerText.trim() === '版本历史'),
      restoreButtons: [...document.querySelectorAll('button')].filter((b) => b.innerText.trim() === '恢复').length,
      versionLabels: [...document.querySelectorAll('span')].filter((s) => /^v\\d+$/.test(s.innerText.trim())).map((s) => s.innerText.trim()),
    }))()`)
    check('WEB10-A 打开版本历史抽屉', opened.ok && drawer.heading && drawer.restoreButtons === 2, opened.ok ? `抽屉 heading=${drawer.heading}，恢复按钮=${drawer.restoreButtons}，版本 ${drawer.versionLabels.join(',')}` : opened.text)

    const clicked = await evalExpr(cdp, `(() => {
      const buttons = [...document.querySelectorAll('button')].filter((b) => b.innerText.trim() === '恢复' && !b.disabled)
      if (!buttons.length) return false
      buttons[buttons.length - 1].click()
      return true
    })()`)
    check('WEB10-B 点击最早版本的“恢复”', clicked, clicked ? '已点击 v1 恢复' : '未找到可点击的恢复按钮')
    await sleep(2500)

    const ui = await evalExpr(cdp, `(() => ({
      text: document.body.innerText.slice(0, 800),
      toast: document.body.innerText.includes('已恢复为新的当前版本'),
      versionBadges: [...document.querySelectorAll('span')].filter((s) => /^v\\d+$/.test(s.innerText.trim())).map((s) => s.innerText.trim()),
    }))()`)
    const after = await api('GET', `/api/projects/${created.json.projectId}`)
    const versions = after.json.project.versions
    const current = versions.find((v) => v.id === after.json.project.currentVersionId)
    const currentHtml = (await api('GET', `/api/projects/${created.json.projectId}/versions/${current.id}/html`)).json.html
    check('WEB10-C 回退生成新版本且历史保留', versions.length === 3 && current.source === 'restore', `versions=${versions.length} current=v${current.seq}/${current.source}`)
    check('WEB10-D 当前版本内容等于 v1', currentHtml === v1Html, `HTML ${currentHtml.length} 字符，与 v1 一致=${currentHtml === v1Html}`)
    check('WEB10-E 页面 toast 与版本号更新', ui.toast, ui.toast ? `toast 可见，版本徽标 ${ui.versionBadges.join(',')}` : ui.text.slice(0, 120))

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    fs.writeFileSync(path.join(RESULT_DIR, 'webui-restore-1280.png'), Buffer.from(shot.data, 'base64'))
    cdp.ws.close()
  } finally {
    chrome.kill('SIGTERM')
  }

  console.log(`\n[webui] 合计 5 项，通过 ${5 - failures} 项，失败 ${failures} 项`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('[webui] 异常：', err)
  process.exit(1)
})
