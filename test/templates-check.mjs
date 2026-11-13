/**
 * 种子成品交互回归：无头 Chrome + CDP，逐个打开 6 个发布页并逐个点击首页成品卡进入，在沙箱 iframe 内真实操作
 * 用法：先启动被测服务（MOCK_MODE=1），再 QA_BASE=http://127.0.0.1:3300 node test/templates-check.mjs
 * 判定：无 JS 异常 / 无 CSP 拦截 / 375px 无横向溢出 / 每个成品关键交互与 localStorage 持久化生效
 * 截图输出：test/results/tpl-*.png
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

const BASE = (process.env.QA_BASE || 'http://127.0.0.1:3300').replace(/\/+$/, '')
const PORT = 9335
const RESULT_DIR = path.resolve('test/results')
const ONLY = process.env.ONLY || ''

const CASES = [
  { slug: 'k7m2x9', kind: 'kanban', name: '任务看板', must: ['今日任务看板', '添加任务'] },
  { slug: 'h3t6w8', kind: 'habit', name: '习惯打卡', must: ['习惯打卡', '添加习惯'] },
  { slug: 'g2a4m8', kind: 'game2048', name: '2048', must: ['2048', '最高分'] },
  { slug: 'p6f3k9', kind: 'pomodoro', name: '番茄专注', must: ['番茄专注', '开始专注'] },
  { slug: 'm4n8t2', kind: 'notes', name: 'Markdown 笔记', must: ['Markdown 笔记', '预览'] },
  { slug: 'e5x7b3', kind: 'expense', name: '记账本', must: ['记账本', '记一笔'] },
]

const INTERACT = {
  kanban: `(() => {
    var input = document.getElementById('input');
    input.value = 'QA 新增任务';
    document.getElementById('add').click();
    var card = [].slice.call(document.querySelectorAll('.card')).filter(function (c) {
      return c.textContent.indexOf('QA 新增任务') >= 0;
    })[0];
    if (!card) return { ok: false, detail: '新增任务未出现' };
    var startBtn = [].slice.call(card.querySelectorAll('button')).filter(function (b) {
      return b.textContent.indexOf('开始') >= 0;
    })[0];
    if (startBtn) startBtn.click();
    var moved = [].slice.call(document.querySelectorAll('.card')).filter(function (c) {
      return c.textContent.indexOf('QA 新增任务') >= 0;
    })[0];
    var inDoing = moved && moved.textContent.indexOf('进行中') >= 0;
    var editBtn = moved && [].slice.call(moved.querySelectorAll('button')).filter(function (b) {
      return b.textContent === '编辑';
    })[0];
    if (editBtn) editBtn.click();
    var editInput = document.querySelector('.edit-input');
    if (editInput) {
      editInput.value = 'QA 已编辑任务';
      var saveBtn = [].slice.call(document.querySelectorAll('.act')).filter(function (b) {
        return b.textContent === '保存';
      })[0];
      if (saveBtn) saveBtn.click();
    }
    var edited = [].slice.call(document.querySelectorAll('.card')).filter(function (c) {
      return c.textContent.indexOf('QA 已编辑任务') >= 0;
    }).length > 0;
    var storage = localStorage.getItem('atoms_kanban_v2') || '';
    return { ok: inDoing && edited, detail: '新增/推进=' + inDoing + ' 编辑=' + edited + ' 存储=' + (storage.indexOf('QA 已编辑任务') >= 0) };
  })()`,
  habit: `(() => {
    var today = document.querySelector('.day.today');
    if (!today) return { ok: false, detail: '缺少今日打卡格' };
    today.click();
    var on = document.querySelector('.day.today').className.indexOf('on') >= 0 || document.querySelector('.day.today i').textContent !== '';
    var input = document.getElementById('input');
    input.value = 'QA 新习惯';
    document.getElementById('add').click();
    var added = [].slice.call(document.querySelectorAll('.name')).filter(function (n) {
      return n.textContent.indexOf('QA 新习惯') >= 0;
    }).length > 0;
    var storage = localStorage.getItem('atoms_habit_v1') || '';
    return { ok: added, detail: '今日打卡=' + on + ' 新增=' + added + ' 存储=' + (storage.indexOf('QA 新习惯') >= 0) };
  })()`,
  game2048: `(() => {
    var board = document.getElementById('board');
    var before = document.querySelectorAll('.cell.tile').length;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    var afterKey = document.querySelectorAll('.cell.tile').length;
    var st = new Event('touchstart', { bubbles: true });
    Object.defineProperty(st, 'touches', { value: [{ clientX: 200, clientY: 320 }] });
    board.dispatchEvent(st);
    var end = new Event('touchend', { bubbles: true });
    Object.defineProperty(end, 'changedTouches', { value: [{ clientX: 200, clientY: 160 }] });
    board.dispatchEvent(end);
    var score = document.getElementById('score').textContent;
    var best = localStorage.getItem('atoms_2048_best_v1');
    var state = localStorage.getItem('atoms_2048_state_v1');
    document.getElementById('restart').click();
    var reset = document.getElementById('score').textContent === '0' && document.querySelectorAll('.cell.tile').length === 2;
    return { ok: before >= 2 && afterKey >= 2 && best !== null && state !== null && reset, detail: '初始=' + before + ' 方向键后=' + afterKey + ' 得分=' + score + ' 最高分=' + best + ' 重开=' + reset };
  })()`,
  pomodoro: `(async () => {
    var toggle = document.getElementById('toggle');
    var t0 = document.getElementById('time').textContent;
    toggle.click();
    var running = toggle.textContent === '暂停';
    // 同一毫秒内连点会得到「剩余=整段」的边界态，间隔一拍以模拟真实操作
    await new Promise(function (r) { setTimeout(r, 300); });
    toggle.click();
    var paused = toggle.textContent === '继续';
    var pausedText = toggle.textContent;
    document.getElementById('skip').click();
    var modeBreak = document.getElementById('tabBreak').className.indexOf('on') >= 0;
    var t1 = document.getElementById('time').textContent;
    var storage = localStorage.getItem('atoms_pomodoro_v1') || '';
    return { ok: running && paused && modeBreak, detail: '初始=' + t0 + ' 开始=' + running + ' 暂停=' + paused + '(' + pausedText + ') 跳过休息=' + modeBreak + ' 时间=' + t1 + ' 存储=' + storage.length };
  })()`,
  notes: `(async () => {
    document.getElementById('new').click();
    var title = document.getElementById('title').value;
    var editor = document.getElementById('editor');
    editor.value = '## QA 标题\\n\\n- **加粗** 与 *斜体*';
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('toggle').click();
    var preview = document.getElementById('preview');
    var shown = !preview.hidden && preview.innerText.indexOf('QA 标题') >= 0 && preview.querySelector('strong') !== null;
    // 自动保存是 280ms 防抖，等一拍再读存储
    await new Promise(function (r) { setTimeout(r, 500); });
    var storage = localStorage.getItem('atoms_notes_v1') || '';
    return { ok: title === '新笔记' && shown && storage.indexOf('QA 标题') >= 0, detail: '新建=' + title + ' 预览=' + shown + ' 存储=' + (storage.indexOf('QA 标题') >= 0) };
  })()`,
  expense: `(() => {
    function set(el, v) {
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    set(document.getElementById('amount'), '25.5');
    set(document.getElementById('note'), 'QA 午餐');
    document.getElementById('add').click();
    var total = document.getElementById('total').textContent;
    var listed = [].slice.call(document.querySelectorAll('.row')).filter(function (r) {
      return r.textContent.indexOf('QA 午餐') >= 0;
    }).length > 0;
    set(document.getElementById('amount'), '-1');
    document.getElementById('add').click();
    var err = document.getElementById('error').textContent;
    var storage = localStorage.getItem('atoms_expense_v1') || '';
    return { ok: listed && err.indexOf('大于 0') >= 0, detail: '新增=' + listed + ' 合计=' + total + ' 校验=' + err + ' 存储=' + (storage.indexOf('QA 午餐') >= 0) };
  })()`,
}

const STORAGE_KEYS = {
  kanban: 'atoms_kanban_v2',
  habit: 'atoms_habit_v1',
  game2048: 'atoms_2048_best_v1',
  pomodoro: 'atoms_pomodoro_v1',
  notes: 'atoms_notes_v1',
  expense: 'atoms_expense_v1',
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

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

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

function frames(node, out = []) {
  out.push(node)
  for (const child of node.childFrames || []) frames(child, out)
  return out
}

/** 沙箱 iframe 是独立 target（OOPIF），需要 autoAttach 后在其会话里执行 */
async function findSandbox(cdp, mark, timeoutMs = 9000) {
  const start = Date.now()
  const enabled = new Set()
  while (Date.now() - start < timeoutMs) {
    const events = cdp.events.slice(mark)
    for (const e of events) {
      if (e.method === 'Target.attachedToTarget' && e.params.targetInfo.type === 'iframe' && !enabled.has(e.params.sessionId)) {
        enabled.add(e.params.sessionId)
        try { await cdp.send('Runtime.enable', {}, e.params.sessionId) } catch { /* noop */ }
      }
    }
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]
      if (e.method === 'Runtime.executionContextCreated' && enabled.has(e.sessionId) && e.params.context.auxData?.isDefault) {
        return { sessionId: e.sessionId, contextId: e.params.context.id }
      }
    }
    await sleep(150)
  }
  const tree = await cdp.send('Page.getFrameTree')
  let pageText = ''
  try { pageText = await evalIn(cdp, 'document.body.innerText.slice(0, 300)') } catch { /* noop */ }
  const targets = cdp.events.slice(mark).filter((e) => e.method === 'Target.attachedToTarget').map((e) => e.params.targetInfo.type)
  throw new Error('未找到沙箱 iframe 执行上下文；页面文本=' + pageText.replace(/\s+/g, ' ') + '；frames=' + frames(tree.frameTree).map((f) => f.frame.url || 'about:blank').join('|') + '；attached=' + targets.join(','))
}

const results = []
function record(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`  ${pass ? 'PASS' : 'FAIL'} ${name}${detail ? `（${detail}）` : ''}`)
}

async function apiCheck() {
  const r = await fetch(BASE + '/api/samples')
  const json = await r.json()
  const samples = json.samples || []
  const slugs = new Set(samples.map((s) => s.slug))
  const kinds = new Set(samples.map((s) => s.kind))
  record('首页样例 6 个且无重复入口', samples.length === 6 && slugs.size === samples.length, `count=${samples.length} slug=${slugs.size}`)
  record('样例覆盖 6 种品类且不含 calculator', kinds.size === 6 && !kinds.has('calculator'), `kinds=${[...kinds].join(',')}`)
}

/** 从首页成品卡逐个点击进入（SPA 路由，不触发 load 事件），验证无死链且沙箱内容正常加载 */
async function homeClickCheck(cdp) {
  const samples = (await getJson(BASE + '/api/samples')).samples || []
  const picked = samples.filter((s) => !ONLY || s.kind === ONLY)
  for (const s of picked) {
    const c = CASES.find((x) => x.kind === s.kind)
    if (!c) continue
    const mark = cdp.events.length
    const loaded = cdp.waitEvent('Page.loadEventFired')
    await cdp.send('Page.navigate', { url: `${BASE}/` })
    await loaded
    await sleep(600)
    const title = JSON.stringify(c.name)
    const selector = `(() => [...document.querySelectorAll('a[href^="/s/"]')].filter((a) => a.textContent.indexOf(${title}) >= 0)[0])()`
    let link = await evalIn(cdp, selector + ' ? true : false')
    for (let i = 0; i < 20 && !link; i++) {
      await sleep(200)
      link = await evalIn(cdp, selector + ' ? true : false')
    }
    if (!link) {
      record(`${c.name}：首页成品卡点击进入`, false, '首页未找到该成品卡')
      continue
    }
    await evalIn(cdp, `${selector}.click()`)
    let pathname = ''
    for (let i = 0; i < 25; i++) {
      pathname = await evalIn(cdp, 'location.pathname')
      if (pathname === `/s/${c.slug}`) break
      await sleep(200)
    }
    let loadedText = ''
    let buttons = 0
    let contentOk = false
    if (pathname === `/s/${c.slug}`) {
      try {
        const ctx = await findSandbox(cdp, mark)
        const probe = await evalIn(cdp, '(() => ({ text: document.body.innerText.slice(0, 600), buttons: document.querySelectorAll("button").length }))()', ctx)
        loadedText = probe.text
        buttons = probe.buttons
        // 仅校验品类标题与存在可操作按钮：成品自身有持久化状态，二次进入的文案可能与首次不同
        contentOk = loadedText.includes(c.must[0]) && buttons >= 1
      } catch (err) { loadedText = err.message }
    }
    record(`${c.name}：首页成品卡点击进入`, pathname === `/s/${c.slug}` && contentOk,
      `path=${pathname} 沙箱=${contentOk ? `已加载（可操作按钮 ${buttons} 个）` : loadedText.replace(/\s+/g, ' ').slice(0, 80)}`)
  }
}

async function main() {
  fs.mkdirSync(RESULT_DIR, { recursive: true })
  await apiCheck()

  const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--user-data-dir=/tmp/qa-templates-chrome',
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
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true })

    for (const c of ONLY ? CASES.filter((x) => x.kind === ONLY) : CASES) {
      const mark = cdp.events.length
      const loaded = cdp.waitEvent('Page.loadEventFired')
      await cdp.send('Page.navigate', { url: `${BASE}/s/${c.slug}` })
      await loaded
      await sleep(1600)

      const ctx = await findSandbox(cdp, mark)
      const parentInfo = await evalIn(cdp, `(() => ({
        innerWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        text: document.body.innerText.slice(0, 400)
      }))()`)
      const frameInfo = await evalIn(cdp, `(() => ({
        innerWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        bad: [...document.querySelectorAll('body *')].filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.right > window.innerWidth + 1;
        }).slice(0, 4).map((el) => el.tagName + '.' + String(el.className || '').slice(0, 24) + '@' + Math.round(el.getBoundingClientRect().right)),
        text: document.body.innerText.slice(0, 600)
      }))()`, ctx)

      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      fs.writeFileSync(path.join(RESULT_DIR, `tpl-${c.kind}-375.png`), Buffer.from(shot.data, 'base64'))

      const missing = c.must.filter((w) => !frameInfo.text.includes(w))
      record(`${c.name}：沙箱内容加载`, missing.length === 0, missing.length ? '缺少：' + missing.join('、') : frameInfo.text.replace(/\s+/g, ' ').slice(0, 60))
      record(`${c.name}：375px 无横向溢出`, parentInfo.scrollWidth <= 376 && frameInfo.scrollWidth <= frameInfo.innerWidth + 1, `外层=${parentInfo.scrollWidth}/${parentInfo.innerWidth} 沙箱=${frameInfo.scrollWidth}/${frameInfo.innerWidth}${frameInfo.bad.length ? ' 越界=' + frameInfo.bad.join('|') : ''}`)

      let act
      try { act = await evalIn(cdp, INTERACT[c.kind], ctx) } catch (err) { act = { ok: false, detail: err.message } }
      record(`${c.name}：关键交互`, Boolean(act && act.ok), act && act.detail ? act.detail : 'result=' + JSON.stringify(act))

      // 等待 KV 同步队列真正落库（无头 Chrome 对后台定时器有节流，固定 sleep 不可靠），
      // 轮询服务端 KV 直到写入可见，再刷新，避免与页面加载竞态
      await sleep(300)
      const savedKey = STORAGE_KEYS[c.kind]
      const cookieList = await cdp.send('Network.getCookies', { urls: [BASE] })
      const vid = (cookieList.cookies || []).find((x) => x.name === 'atoms_vid')?.value || ''
      let polled = 0
      if (vid) {
        for (let i = 0; i < 25; i++) {
          const res = await fetch(`${BASE}/api/share/${c.slug}/kv`, { headers: { cookie: `atoms_vid=${vid}` } })
          const json = await res.json().catch(() => ({ data: {} }))
          const val = json?.data?.[savedKey]
          if (typeof val === 'string' && val.length > 0) { polled = val.length; break }
          await sleep(200)
        }
      }
      const before = await evalIn(cdp, `localStorage.getItem(${JSON.stringify(savedKey)})`, ctx)
      const mark2 = cdp.events.length
      const reloaded = cdp.waitEvent('Page.loadEventFired')
      await cdp.send('Page.navigate', { url: `${BASE}/s/${c.slug}` })
      await reloaded
      await sleep(1600)
      const ctx2 = await findSandbox(cdp, mark2)
      const after = await evalIn(cdp, `localStorage.getItem(${JSON.stringify(savedKey)})`, ctx2)
      record(`${c.name}：数据持久化（刷新后仍在）`, after !== null && after.length > 0, `写入=${before ? before.length : 0} 字节，落库=${polled}，刷新后=${after ? after.length : 0} 字节`)

      const events = cdp.events.slice(mark)
      const errors = events.filter((e) => e.method === 'Runtime.exceptionThrown')
        .map((e) => e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text)
      const csp = events.filter((e) => e.method === 'Log.entryAdded').map((e) => e.params.entry)
        .filter((e) => e.source === 'security' || /Content Security Policy|Refused to/i.test(e.text))
      record(`${c.name}：无 JS 异常 / 无 CSP 拦截`, errors.length === 0 && csp.length === 0,
        errors[0]?.slice(0, 120) || csp[0]?.text?.slice(0, 120) || `screenshot=tpl-${c.kind}-375.png`)
    }
    await homeClickCheck(cdp)
    cdp.close()
  } finally {
    chrome.kill('SIGTERM')
  }

  const failed = results.filter((r) => !r.pass).length
  console.log(`\n[templates] 合计 ${results.length} 项，通过 ${results.length - failed} 项，失败 ${failed} 项`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('[templates] 异常：', err)
  process.exit(1)
})
