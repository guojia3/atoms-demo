/**
 * 375px 独立复核：无头 Chrome + CDP，实测首页 / 工作台 / 分享页
 * 用法：QA_BASE=http://127.0.0.1:3200 node test/mobile-check.mjs
 * 判定：视口 375×812、页面无横向溢出、无 CSP 拦截、关键区域可见
 * 截图输出：test/results/mobile-*.png
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const BASE = (process.env.QA_BASE || 'http://127.0.0.1:3200').replace(/\/+$/, '')
const PORT = 9333
const RESULT_DIR = path.resolve('test/results')

const METRICS = {
  elements: 42,
  textLength: 600,
  errors: [],
  errorCount: 0,
  clicks: 5,
  mutations: 10,
  keys: 1,
  writes: 3,
  overflowX: false,
  width: 375,
  title: 'Mobile QA',
  interactiveClicks: 3,
  simulatedClicks: 3,
  simulatedChanges: 3,
  simulatedWrites: 2,
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
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  return { status: res.status, json, text }
}

async function consumeRun(runId) {
  const res = await fetch(`${BASE}/api/runs/${runId}/events`, { headers: { cookie: [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ') } })
  if (!res.body) throw new Error('SSE 无响应体')
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
      try {
        event = JSON.parse(line.slice(5).trim())
      } catch {
        continue
      }
      if (event.type === 'candidates') {
        for (const c of event.data?.candidates || []) {
          if (reported.has(c.id)) continue
          reported.add(c.id)
          await api('POST', `/api/candidates/${c.id}/report`, { metrics: METRICS })
        }
      }
      if (event.type === 'done') {
        await reader.cancel().catch(() => {})
        return
      }
    }
  }
}

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.id = 0
    this.pending = new Map()
    this.events = []
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
      this.events.push(msg)
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
  waitEvent(method, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1)
        reject(new Error(`等待 ${method} 超时`))
      }, timeoutMs)
      const waiter = {
        match: (msg) => msg.method === method,
        resolve: (msg) => {
          clearTimeout(timer)
          resolve(msg)
        },
      }
      this.waiters.push(waiter)
    })
  }
  close() {
    this.ws.close()
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

const results = []
function record(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`  ${pass ? 'PASS' : 'FAIL'} ${name}${detail ? `（${detail}）` : ''}`)
}

async function main() {
  fs.mkdirSync(RESULT_DIR, { recursive: true })

  console.log('[mobile] 准备被测项目')
  await api('GET', '/api/me')
  const created = await api('POST', '/api/projects', { prompt: '做一个任务看板，支持添加任务、在三列之间推进，刷新后数据还在' })
  if (created.status !== 201) throw new Error(`创建项目失败：${created.status}`)
  await consumeRun(created.json.runId)
  const published = await api('POST', `/api/projects/${created.json.projectId}/publish`)
  if (published.status !== 200) throw new Error(`发布失败：${published.status}`)
  const slug = published.json.slug
  const pages = [
    { key: 'home', name: '首页', path: '/', must: ['Atoms', '一句话'] },
    { key: 'workspace', name: '工作台', path: `/p/${created.json.projectId}`, must: ['预览', '版本'] },
    { key: 'share', name: '发布页', path: `/s/${slug}`, must: ['任务看板'] },
  ]

  const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--user-data-dir=/tmp/qa-chrome-375',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    'about:blank',
  ], { stdio: 'ignore' })

  try {
    let version = null
    for (let i = 0; i < 60 && !version; i++) {
      try {
        version = await getJson(`http://127.0.0.1:${PORT}/json/version`)
      } catch {
        await new Promise((r) => setTimeout(r, 150))
      }
    }
    if (!version) throw new Error('Chrome 调试端口未就绪')
    const target = await getJson(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })
    const cdp = new CDP(target.webSocketDebuggerUrl)
    await cdp.ready()
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Log.enable')
    await cdp.send('Network.enable')
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 375,
      height: 812,
      deviceScaleFactor: 2,
      mobile: true,
    })
    await cdp.send('Network.setCookie', {
      name: 'atoms_sid',
      value: jar.get('atoms_sid'),
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true,
      secure: false,
    })

    for (const page of pages) {
      cdp.events = []
      const loaded = cdp.waitEvent('Page.loadEventFired', 15000)
      await cdp.send('Page.navigate', { url: `${BASE}${page.path}` })
      await loaded
      await new Promise((r) => setTimeout(r, 1800))

      const info = await evalExpr(cdp, `(() => {
        const vw = window.innerWidth
        const bad = [...document.querySelectorAll('body *')]
          .filter((el) => {
            const r = el.getBoundingClientRect()
            return r.width > 0 && r.right > vw + 1
          })
          .slice(0, 6)
          .map((el) => ({ tag: el.tagName, cls: String(el.className || '').slice(0, 48), right: Math.round(el.getBoundingClientRect().right) }))
        return {
          innerWidth: vw,
          docScrollWidth: document.documentElement.scrollWidth,
          bodyScrollWidth: document.body.scrollWidth,
          overflowX: document.documentElement.scrollWidth > vw + 1,
          bad,
          title: document.title,
          text: document.body.innerText.slice(0, 2000),
        }
      })()`)

      const csp = cdp.events
        .filter((e) => e.method === 'Log.entryAdded')
        .map((e) => e.params.entry)
        .filter((e) => e.source === 'security' || /Content Security Policy|Refused to/i.test(e.text))
      const errors = cdp.events
        .filter((e) => e.method === 'Runtime.exceptionThrown')
        .map((e) => e.params.exceptionDetails.text)

      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      const file = path.join(RESULT_DIR, `mobile-${page.key}-375.png`)
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'))

      const missing = page.must.filter((word) => !info.text.includes(word))
      record(`${page.name} 375px 无横向溢出`, !info.overflowX && info.docScrollWidth <= 376, `inner=${info.innerWidth} scroll=${info.docScrollWidth}${info.bad.length ? ` 越界=${JSON.stringify(info.bad)}` : ''}`)
      record(`${page.name} 375px 关键内容可见`, missing.length === 0, missing.length ? `缺少：${missing.join('、')}` : info.text.replace(/\s+/g, ' ').slice(0, 60))
      record(`${page.name} 无 CSP 拦截/JS 异常`, csp.length === 0 && errors.length === 0, csp.length ? csp[0].text.slice(0, 120) : errors[0] || `screenshot=${path.basename(file)}`)
    }
    cdp.close()
  } finally {
    chrome.kill('SIGTERM')
  }

  const failed = results.filter((r) => !r.pass).length
  console.log(`\n[mobile] 合计 ${results.length} 项，通过 ${results.length - failed} 项，失败 ${failed} 项`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('[mobile] 异常：', err)
  process.exit(1)
})
