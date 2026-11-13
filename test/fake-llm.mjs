// QA 专用假模型服务：OpenAI 兼容 /v1/chat/completions，按提示词关键词注入异常
// 用法：FAKE_LLM_PORT=3999 node test/fake-llm.mjs
import http from 'node:http'

const PORT = Number(process.env.FAKE_LLM_PORT || 3999)

const CHECKLIST = [
  '首屏可直接使用，无白屏或明显错位',
  '至少 2 处可交互控件（按钮 / 输入 / 选项）',
  '操作后界面有即时反馈（列表、数值或状态变化）',
  '刷新页面后，之前写入的数据仍然存在',
  '375px 宽度下无横向滚动条',
  '浏览器控制台无未捕获的 JS 报错',
]

const PLAN = {
  title: 'QA 假模型测试应用',
  summary: '由假模型服务生成的验收用单页应用，用于验证生成、验收、版本与异常路径。',
  views: ['主界面：录入与列表', '数据区：计数与清空', '状态区：空态提示'],
  features: ['添加条目', '清空列表', '刷新后数据保留', '375px 可用'],
  design: '浅色背景 + 白色卡片 + 单一主色，圆角与留白统一',
  data: 'localStorage（由沙箱运行时同步到云端，键名保持不变）',
  checklist: CHECKLIST,
}

const QA_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>QA Demo</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;background:#f6f7fb;color:#1f2333;min-height:100vh;padding:24px}
  .wrap{max-width:720px;margin:0 auto}
  header{margin-bottom:18px}
  h1{font-size:26px;letter-spacing:-.5px}
  .sub{color:#6b7280;font-size:13px;margin-top:6px}
  .card{background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:16px;margin-bottom:14px;box-shadow:0 8px 24px rgba(17,24,39,.05)}
  .bar{display:flex;gap:10px;margin-bottom:14px}
  .bar input{flex:1;border:1px solid #e5e7eb;border-radius:11px;padding:11px 12px;font-size:14px;outline:none}
  .bar input:focus{border-color:#4f46e5}
  .bar button{border:0;background:#4f46e5;color:#fff;border-radius:11px;padding:11px 18px;font-size:14px;font-weight:600;cursor:pointer}
  .bar button:hover{background:#4338ca}
  ul{list-style:none;display:flex;flex-direction:column;gap:8px;min-height:80px}
  li{display:flex;justify-content:space-between;align-items:center;gap:10px;background:#f9fafb;border:1px solid #eef0f4;border-radius:11px;padding:11px 12px;font-size:14px}
  li button{border:1px solid #e5e7eb;background:#fff;border-radius:8px;padding:5px 9px;font-size:12px;cursor:pointer;color:#374151}
  li button:hover{border-color:#4f46e5;color:#4f46e5}
  .empty{color:#9ca3af;font-size:13px;text-align:center;padding:24px 0;border:1px dashed #e5e7eb;border-radius:10px}
  .stats{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:14px;color:#6b7280;font-size:13px}
  .stats button{border:1px solid #e5e7eb;background:#fff;border-radius:8px;padding:6px 10px;font-size:12px;cursor:pointer}
  footer{margin-top:20px;color:#9ca3af;font-size:12px;text-align:center}
  @media (max-width:420px){body{padding:14px}.bar{flex-wrap:wrap}.bar button{width:100%}}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1 id="qa-title">QA Demo</h1>
    <div class="sub">假模型服务生成的验收样例：可添加、可删除、刷新后数据仍在。</div>
  </header>
  <div class="card">
    <div class="bar">
      <input id="qa-input" placeholder="输入一条记录，回车或点击添加" maxlength="80">
      <button id="qa-add">添加</button>
    </div>
    <ul id="qa-list"></ul>
    <div class="stats">
      <span>共 <strong id="qa-count">0</strong> 条 · 已保存到 localStorage</span>
      <button id="qa-clear">清空</button>
    </div>
  </div>
  <footer>Atoms QA 假模型 · 用于测试生成与验收链路，不代表真实模型质量</footer>
</div>
<script>
(function(){
  var KEY = 'qa_demo_items_v1';
  var items = [];
  try {
    var saved = localStorage.getItem(KEY);
    if (saved) items = JSON.parse(saved) || [];
    if (!Array.isArray(items)) items = [];
  } catch (e) { items = []; }
  var list = document.getElementById('qa-list');
  var input = document.getElementById('qa-input');
  var count = document.getElementById('qa-count');
  function save(){ try { localStorage.setItem(KEY, JSON.stringify(items)); } catch(e){} }
  function render(){
    list.innerHTML = '';
    if (items.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = '暂无记录，先添加一条试试';
      list.appendChild(empty);
    }
    items.forEach(function(item, idx){
      var li = document.createElement('li');
      var span = document.createElement('span');
      span.textContent = item;
      li.appendChild(span);
      var btn = document.createElement('button');
      btn.textContent = '删除';
      btn.addEventListener('click', function(){
        items.splice(idx, 1);
        save(); render();
      });
      li.appendChild(btn);
      list.appendChild(li);
    });
    count.textContent = String(items.length);
  }
  function add(){
    var text = input.value.trim();
    if (!text) return;
    items.push(text);
    input.value = '';
    save(); render();
  }
  document.getElementById('qa-add').addEventListener('click', add);
  input.addEventListener('keydown', function(e){ if (e.key === 'Enter') add(); });
  document.getElementById('qa-clear').addEventListener('click', function(){
    items = [];
    save(); render();
  });
  save();
  render();
})();
</script>
</body>
</html>`

const QA_HTML_V2 = QA_HTML.replace(
  '<h1 id="qa-title">QA Demo</h1>',
  '<h1 id="qa-title">QA Demo 已修改</h1>',
)

const attempts = new Map()

function hashText(text) {
  let h = 0
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0
  return h.toString(16)
}

function roleOf(body) {
  const sys = String(body?.messages?.[0]?.content || '')
  if (sys.includes('产品规划师')) return 'planner'
  if (sys.includes('验收官')) return 'reviewer'
  if (sys.includes('增量修改') || sys.includes('JSON 补丁')) return 'patch'
  if (sys.includes('前端工程师')) return 'engineer'
  return 'unknown'
}

function textOf(body) {
  return (body?.messages || []).map((m) => String(m.content || '')).join('\n')
}

function json(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function sseHead(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
}

async function streamText(res, text, opts = {}) {
  sseHead(res)
  if (opts.delayMs) await sleep(opts.delayMs)
  const size = opts.chunk || 500
  const gap = opts.gap || 30
  for (let i = 0; i < text.length; i += size) {
    const delta = text.slice(i, i + size)
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`)
    if (gap) await sleep(gap)
  }
  if (opts.cut) {
    res.end()
    return
  }
  res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}

function planFor(body) {
  const text = textOf(body)
  if (text.includes('BADPLAN')) {
    return '抱歉，我无法按 JSON 格式输出方案：这是一段故意破坏规划解析的文本。'
  }
  return PLAN
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/v1/models') {
    json(res, 200, { object: 'list', data: [{ id: 'fake-a' }, { id: 'fake-b' }] })
    return
  }
  if (req.method !== 'POST' || !req.url?.startsWith('/v1/chat/completions')) {
    json(res, 404, { error: 'not found' })
    return
  }
  let body
  try {
    const raw = await new Promise((resolve) => {
      let data = ''
      req.on('data', (chunk) => {
        data += chunk
      })
      req.on('end', () => resolve(data))
    })
    body = JSON.parse(raw || '{}')
  } catch {
    json(res, 400, { error: 'bad json' })
    return
  }

  const role = roleOf(body)
  const text = textOf(body)
  const model = String(body.model || 'fake-a')
  const key = `${role}:${model}:${text.length}:${hashText(text)}`
  const count = (attempts.get(key) || 0) + 1
  attempts.set(key, count)
  console.log(`[fake-llm] role=${role} model=${model} attempt=${count} len=${text.length}`)

  // 402：工程师请求直接失败（规划仍成功），用于验证创作兜底
  if (role === 'engineer' && text.includes('HTTP402')) {
    json(res, 402, { error: { message: 'Payment Required（QA 注入）' } })
    return
  }
  // 429：首次失败、重试成功，用于验证退避重试
  if (role === 'engineer' && text.includes('FLAKY429') && count % 2 === 1) {
    json(res, 429, { error: { message: 'Rate limit（QA 注入一次）' } })
    return
  }
  // 断流：只输出半截 HTML 就关闭，验证不完整产物的处理
  if (role === 'engineer' && text.includes('CUTSTREAM')) {
    await streamText(res, QA_HTML.slice(0, 1200), { cut: true, gap: 10 })
    return
  }
  // 坏 HTML：静态检查必然失败（PATCHFAILOKFULL 走“补丁失败→全量重写成功”路径）
  if (role === 'engineer' && (text.includes('BADHTML') || text.includes('BADPATCH')) && !text.includes('PATCHFAILOKFULL')) {
    await streamText(res, '这是一段没有 HTML 结构的文本，无法通过静态检查。', { gap: 5 })
    return
  }
  // 慢生成：用于 SSE 断线重连与停止测试
  if (role === 'engineer' && (text.includes('SLOWCREATE') || text.includes('SLOWSTOP'))) {
    await streamText(res, QA_HTML, { delayMs: 2500, gap: 120, chunk: 800 })
    return
  }

  if (role === 'planner') {
    const content = planFor(body)
    await streamText(res, typeof content === 'string' ? content : JSON.stringify(content), { gap: 5 })
    return
  }

  if (role === 'patch') {
    if (text.includes('PATCHFAILOKFULL')) {
      await streamText(res, JSON.stringify({ patches: [{ find: 'PATCH_FAIL_ANCHOR_404', replace: 'nope' }] }), { gap: 5 })
      return
    }
    if (text.includes('BADPATCH')) {
      await streamText(res, JSON.stringify({ patches: [{ find: 'QA_PATCH_TARGET_UNIQUE_42', replace: 'nope' }] }), { gap: 5 })
      return
    }
    if (text.includes('PATCHFULL')) {
      await streamText(res, JSON.stringify({ full: QA_HTML_V2 }), { gap: 5 })
      return
    }
    // 默认走局部补丁：只改标题，验证 Patch 命中与版本演进
    await streamText(
      res,
      JSON.stringify({ patches: [{ find: '<h1 id="qa-title">QA Demo</h1>', replace: '<h1 id="qa-title">QA Demo 已修改</h1>' }] }),
      { gap: 5 },
    )
    return
  }

  if (role === 'reviewer') {
    if (text.includes('REVIEWFAIL')) {
      json(res, 500, { error: { message: 'Reviewer unavailable（QA 注入）' } })
      return
    }
    const review = CHECKLIST.map((t, i) => ({ id: `c${i + 1}`, pass: true, evidence: `假模型验收：第 ${i + 1} 条依据实测数据判定通过` }))
    await streamText(res, JSON.stringify(review), { gap: 5 })
    return
  }

  if (role === 'engineer') {
    await streamText(res, QA_HTML, { gap: 30 })
    return
  }

  json(res, 400, { error: `unknown role` })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[fake-llm] listening on http://127.0.0.1:${PORT}/v1`)
})
