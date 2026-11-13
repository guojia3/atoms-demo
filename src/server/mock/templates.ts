// 内置演示模板：无模型 / 模型失败时的一等公民，保证任何情况下都有可交互、可持久化的成品
export type TemplateKind = 'kanban' | 'calculator' | 'habit'

export function pickTemplate(prompt: string): TemplateKind {
  const p = prompt.toLowerCase()
  if (/计算|算式|calculator|加减乘除|房贷|汇率/.test(p)) return 'calculator'
  if (/打卡|习惯|habit|坚持|每日|todo|待办|清单/.test(p)) return 'habit'
  return 'kanban'
}

export function mockHtml(kind: TemplateKind, prompt: string): string {
  if (kind === 'calculator') return calculatorHtml(prompt)
  if (kind === 'habit') return habitHtml(prompt)
  return kanbanHtml(prompt)
}

function kanbanHtml(prompt: string): string {
  const subtitle = escapeHtml(prompt).slice(0, 90)
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>任务看板</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;background:#f6f7fb;color:#1f2333;min-height:100vh;padding:24px}
  .wrap{max-width:1080px;margin:0 auto}
  header{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:20px}
  h1{font-size:26px;letter-spacing:-.5px}
  .sub{color:#6b7280;font-size:13px;margin-top:6px;max-width:560px}
  .stats{display:flex;gap:8px}
  .pill{background:#fff;border:1px solid #e5e7eb;border-radius:999px;padding:6px 12px;font-size:12px;color:#4b5563}
  .composer{display:flex;gap:10px;background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:10px;margin-bottom:20px;box-shadow:0 8px 24px rgba(17,24,39,.05)}
  .composer input{flex:1;border:0;outline:none;font-size:15px;padding:8px 10px;background:transparent}
  .composer button{background:#4f46e5;color:#fff;border:0;border-radius:11px;padding:10px 18px;font-size:14px;cursor:pointer;font-weight:600}
  .composer button:hover{background:#4338ca}
  .board{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
  .col{background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:14px;min-height:260px}
  .col h2{font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:.08em;display:flex;justify-content:space-between;margin-bottom:12px}
  .card{background:#f9fafb;border:1px solid #eef0f4;border-radius:12px;padding:12px;margin-bottom:10px;transition:.15s}
  .card:hover{border-color:#c7d2fe;box-shadow:0 4px 12px rgba(79,70,229,.08)}
  .card p{font-size:14px;line-height:1.5;word-break:break-word}
  .card .row{display:flex;justify-content:space-between;align-items:center;margin-top:10px;gap:8px}
  .tag{font-size:11px;color:#4f46e5;background:#eef2ff;border-radius:999px;padding:3px 9px}
  .act{border:0;background:#fff;border:1px solid #e5e7eb;border-radius:8px;font-size:12px;padding:5px 9px;cursor:pointer;color:#374151}
  .act:hover{border-color:#4f46e5;color:#4f46e5}
  .act.done{color:#059669;border-color:#a7f3d0}
  .empty{color:#9ca3af;font-size:13px;text-align:center;padding:26px 0;border:1px dashed #e5e7eb;border-radius:10px}
  footer{margin-top:22px;text-align:center;color:#9ca3af;font-size:12px}
  @media (max-width:760px){.board{grid-template-columns:1fr}body{padding:16px}.composer{flex-wrap:wrap}.composer button{width:100%}}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div>
      <h1>今日任务看板</h1>
      <div class="sub">${subtitle || '把一件事拆成小步，逐张卡片推进。数据保存在浏览器，刷新后仍在。'}</div>
    </div>
    <div class="stats">
      <span class="pill" id="total">共 0 项</span>
      <span class="pill" id="progress">完成 0%</span>
    </div>
  </header>
  <div class="composer">
    <input id="input" placeholder="添加一项任务，回车或点击按钮" maxlength="80">
    <button id="add">添加任务</button>
  </div>
  <div class="board" id="board"></div>
  <footer>Atoms Demo 生成 · 点击卡片右侧按钮推进状态</footer>
</div>
<script>
(function(){
  var KEY = 'atoms_kanban_v1';
  var state = { cards: [] };
  var seq = 1;
  try {
    var saved = localStorage.getItem(KEY);
    if (saved) state = JSON.parse(saved);
    if (!Array.isArray(state.cards)) state.cards = [];
    state.cards.forEach(function(c){ if (c.id >= seq) seq = c.id + 1; });
  } catch (e) { state = { cards: [] }; }
  if (state.cards.length === 0) {
    state.cards = [
      { id: seq++, text: '确认需求与验收标准', status: 'todo' },
      { id: seq++, text: '搭出页面骨架', status: 'doing' },
      { id: seq++, text: '跑通第一条交互', status: 'done' }
    ];
  }
  var board = document.getElementById('board');
  var COLS = [
    { key: 'todo', name: '待办' },
    { key: 'doing', name: '进行中' },
    { key: 'done', name: '已完成' }
  ];
  function save(){ try { localStorage.setItem(KEY, JSON.stringify(state)); } catch(e){} }
  function render(){
    board.innerHTML = '';
    COLS.forEach(function(col){
      var items = state.cards.filter(function(c){ return c.status === col.key; });
      var el = document.createElement('div');
      el.className = 'col';
      el.innerHTML = '<h2>' + col.name + '<span>' + items.length + '</span></h2>';
      if (items.length === 0) {
        var empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = '暂无任务';
        el.appendChild(empty);
      }
      items.forEach(function(card){
        var c = document.createElement('div');
        c.className = 'card';
        var p = document.createElement('p');
        p.textContent = card.text;
        c.appendChild(p);
        var row = document.createElement('div');
        row.className = 'row';
        var tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = col.name;
        row.appendChild(tag);
        if (col.key !== 'done') {
          var btn = document.createElement('button');
          btn.className = 'act';
          btn.textContent = col.key === 'todo' ? '开始 →' : '完成 ✓';
          btn.addEventListener('click', function(){ move(card.id, col.key === 'todo' ? 'doing' : 'done'); });
          row.appendChild(btn);
        } else {
          var back = document.createElement('button');
          back.className = 'act done';
          back.textContent = '已完成 ✓';
          back.addEventListener('click', function(){ move(card.id, 'todo'); });
          row.appendChild(back);
        }
        c.appendChild(row);
        el.appendChild(c);
      });
      board.appendChild(el);
    });
    var done = state.cards.filter(function(c){ return c.status === 'done'; }).length;
    document.getElementById('total').textContent = '共 ' + state.cards.length + ' 项';
    document.getElementById('progress').textContent = state.cards.length ? ('完成 ' + Math.round(done * 100 / state.cards.length) + '%') : '完成 0%';
  }
  function move(id, status){
    state.cards.forEach(function(c){ if (c.id === id) c.status = status; });
    save(); render();
  }
  function addCard(){
    var input = document.getElementById('input');
    var text = input.value.trim();
    if (!text) return;
    state.cards.push({ id: seq++, text: text, status: 'todo' });
    input.value = '';
    save(); render();
  }
  document.getElementById('add').addEventListener('click', addCard);
  document.getElementById('input').addEventListener('keydown', function(e){ if (e.key === 'Enter') addCard(); });
  render();
})();
</script>
</body>
</html>`
}

function calculatorHtml(prompt: string): string {
  const subtitle = escapeHtml(prompt).slice(0, 90)
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>计算器</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;background:#0f172a;color:#e5e7eb;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
  .shell{width:100%;max-width:380px}
  .head{margin-bottom:16px}
  h1{font-size:22px}
  .sub{font-size:12px;color:#94a3b8;margin-top:6px}
  .display{background:#111c33;border:1px solid #23304d;border-radius:18px;padding:18px;text-align:right;margin-bottom:14px;min-height:104px;display:flex;flex-direction:column;justify-content:flex-end}
  .expr{font-size:13px;color:#64748b;min-height:18px;word-break:break-all}
  .value{font-size:38px;font-weight:600;letter-spacing:-1px;word-break:break-all}
  .keys{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
  .key{border:0;border-radius:14px;background:#1b2740;color:#e5e7eb;font-size:20px;padding:16px 0;cursor:pointer;transition:.12s;font-weight:500}
  .key:hover{background:#243354}
  .key.op{background:#1e2c49;color:#93c5fd}
  .key.eq{background:#4f46e5;color:#fff}
  .key.eq:hover{background:#4338ca}
  .key.fn{color:#fca5a5;font-size:16px}
  .history{margin-top:18px;background:#111c33;border:1px solid #23304d;border-radius:16px;padding:14px}
  .history h2{font-size:12px;color:#94a3b8;letter-spacing:.08em;margin-bottom:8px}
  .history ul{list-style:none;font-size:13px;color:#cbd5e1;display:flex;flex-direction:column;gap:6px;max-height:132px;overflow:auto}
  .history li{display:flex;justify-content:space-between;gap:10px}
  .history li span:last-child{color:#818cf8}
  .hint{color:#475569;font-size:12px;margin-top:8px}
  @media (max-width:420px){body{padding:14px}.value{font-size:32px}.key{padding:14px 0}}
</style>
</head>
<body>
<div class="shell">
  <div class="head">
    <h1>计算器</h1>
    <div class="sub">${subtitle || '支持四则运算与百分比，历史记录本地保存。'}</div>
  </div>
  <div class="display">
    <div class="expr" id="expr">&nbsp;</div>
    <div class="value" id="value">0</div>
  </div>
  <div class="keys" id="keys"></div>
  <div class="history">
    <h2>历史记录</h2>
    <ul id="history"><li><span style="color:#475569">暂无记录</span></li></ul>
    <div class="hint">数据保存在浏览器，刷新后仍在</div>
  </div>
</div>
<script>
(function(){
  var KEY = 'atoms_calc_history_v1';
  var history = [];
  try { var saved = localStorage.getItem(KEY); if (saved) history = JSON.parse(saved) || []; } catch(e) { history = []; }
  var expr = '';
  var valueEl = document.getElementById('value');
  var exprEl = document.getElementById('expr');
  var historyEl = document.getElementById('history');

  var KEYS = [
    { t: 'C', k: 'clear', cls: 'fn' }, { t: '⌫', k: 'back', cls: 'fn' }, { t: '%', k: '%', cls: 'op' }, { t: '÷', k: '/', cls: 'op' },
    { t: '7', k: '7' }, { t: '8', k: '8' }, { t: '9', k: '9' }, { t: '×', k: '*', cls: 'op' },
    { t: '4', k: '4' }, { t: '5', k: '5' }, { t: '6', k: '6' }, { t: '−', k: '-', cls: 'op' },
    { t: '1', k: '1' }, { t: '2', k: '2' }, { t: '3', k: '3' }, { t: '+', k: '+', cls: 'op' },
    { t: '0', k: '0' }, { t: '.', k: '.' }, { t: '=', k: 'eq', cls: 'eq' }
  ];

  function renderHistory(){
    if (history.length === 0) { historyEl.innerHTML = '<li><span style="color:#475569">暂无记录</span></li>'; return; }
    historyEl.innerHTML = '';
    history.slice(0, 8).forEach(function(h){
      var li = document.createElement('li');
      var a = document.createElement('span');
      a.textContent = h.expr;
      var b = document.createElement('span');
      b.textContent = '= ' + h.result;
      li.appendChild(a); li.appendChild(b);
      historyEl.appendChild(li);
    });
  }

  function compute(input){
    var safe = input.replace(/[×]/g, '*').replace(/[÷]/g, '/').replace(/[−]/g, '-');
    if (!/^[0-9+\-*/.()% ]+$/.test(safe)) return null;
    try {
      var fn = new Function('return (' + safe.replace(/%/g, '/100') + ')');
      var out = fn();
      if (typeof out !== 'number' || !isFinite(out)) return null;
      return Math.round(out * 100000000) / 100000000;
    } catch (e) { return null; }
  }

  function refresh(){
    exprEl.textContent = expr || '\\u00a0';
    if (!expr) { valueEl.textContent = '0'; return; }
    var res = compute(expr);
    valueEl.textContent = res === null ? '…' : String(res);
  }

  function press(k){
    if (k === 'clear') { expr = ''; refresh(); return; }
    if (k === 'back') { expr = expr.slice(0, -1); refresh(); return; }
    if (k === 'eq') {
      var res = compute(expr);
      if (res === null) { valueEl.textContent = '表达式有误'; return; }
      history.unshift({ expr: expr, result: String(res) });
      history = history.slice(0, 20);
      try { localStorage.setItem(KEY, JSON.stringify(history)); } catch(e){}
      expr = String(res);
      renderHistory(); refresh(); return;
    }
    if (expr.length > 60) return;
    expr += k;
    refresh();
  }

  var keysEl = document.getElementById('keys');
  KEYS.forEach(function(item){
    var btn = document.createElement('button');
    btn.className = 'key' + (item.cls ? ' ' + item.cls : '');
    btn.textContent = item.t;
    if (item.k === 'eq') btn.style.gridColumn = 'span 2';
    btn.addEventListener('click', function(){ press(item.k); });
    keysEl.appendChild(btn);
  });
  renderHistory(); refresh();
})();
</script>
</body>
</html>`
}

function habitHtml(prompt: string): string {
  const subtitle = escapeHtml(prompt).slice(0, 90)
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>习惯打卡</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;background:#f5f7f4;color:#1c2a22;min-height:100vh;padding:24px}
  .wrap{max-width:820px;margin:0 auto}
  h1{font-size:26px;letter-spacing:-.5px}
  .sub{color:#6b7a70;font-size:13px;margin-top:6px}
  .card{background:#fff;border:1px solid #e3eae4;border-radius:18px;padding:18px;margin-top:18px;box-shadow:0 10px 30px rgba(22,60,38,.05)}
  .composer{display:flex;gap:10px}
  .composer input{flex:1;border:1px solid #dfe7e1;border-radius:11px;padding:11px 13px;font-size:14px;outline:none}
  .composer input:focus{border-color:#16a34a}
  .composer button{border:0;border-radius:11px;background:#16a34a;color:#fff;padding:0 18px;font-size:14px;font-weight:600;cursor:pointer}
  .composer button:hover{background:#15803d}
  .summary{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px}
  .pill{font-size:12px;color:#4b5f52;background:#f0f5f1;border:1px solid #e3eae4;border-radius:999px;padding:6px 11px}
  .habit{padding:14px 0;border-bottom:1px solid #f0f3f0}
  .habit:last-child{border-bottom:0}
  .habit .top{display:flex;justify-content:space-between;align-items:center;gap:10px}
  .habit .name{font-size:15px;font-weight:600}
  .habit .meta{font-size:12px;color:#8a978f;margin-top:3px}
  .del{border:0;background:transparent;color:#c0c9c2;font-size:12px;cursor:pointer}
  .del:hover{color:#dc2626}
  .days{display:grid;grid-template-columns:repeat(7,1fr);gap:6px;margin-top:12px}
  .day{border:1px solid #e3eae4;background:#fbfcfb;border-radius:10px;padding:7px 0;text-align:center;cursor:pointer;font-size:11px;color:#7d8a81;transition:.12s}
  .day:hover{border-color:#86efac}
  .day.on{background:#dcfce7;border-color:#86efac;color:#166534;font-weight:600}
  .day .dot{display:block;width:6px;height:6px;border-radius:50%;background:#d6ded8;margin:5px auto 0}
  .day.on .dot{background:#16a34a}
  .bar{height:8px;border-radius:999px;background:#eff4f0;overflow:hidden;margin-top:14px}
  .bar div{height:100%;background:#16a34a;transition:width .2s}
  footer{text-align:center;color:#9aa69d;font-size:12px;margin-top:18px}
  @media (max-width:560px){body{padding:16px}.composer{flex-wrap:wrap}.composer button{padding:12px 16px;width:100%}.days{gap:4px}.day{font-size:10px}}
</style>
</head>
<body>
<div class="wrap">
  <h1>习惯打卡</h1>
  <div class="sub">${subtitle || '每天点一下，连续记录会自动保存。'}</div>
  <div class="card">
    <div class="composer">
      <input id="input" placeholder="新的习惯，如：读书 30 分钟" maxlength="40">
      <button id="add">添加</button>
    </div>
    <div class="summary">
      <span class="pill" id="s_total">0 个习惯</span>
      <span class="pill" id="s_today">今日完成 0</span>
      <span class="pill" id="s_streak">最长连续 0 天</span>
    </div>
    <div class="bar"><div id="bar" style="width:0%"></div></div>
  </div>
  <div class="card" id="list"></div>
  <footer>数据保存在浏览器，刷新后仍在</footer>
</div>
<script>
(function(){
  var KEY = 'atoms_habit_v1';
  var state = { habits: [], weekOffset: 0 };
  var seq = 1;
  try {
    var saved = localStorage.getItem(KEY);
    if (saved) state = JSON.parse(saved);
    if (!Array.isArray(state.habits)) state.habits = [];
    state.habits.forEach(function(h){ if (h.id >= seq) seq = h.id + 1; });
  } catch(e) { state = { habits: [] }; }
  if (state.habits.length === 0) {
    state.habits = [
      { id: seq++, name: '早起', days: [] },
      { id: seq++, name: '阅读 30 分钟', days: [] }
    ];
  }
  var list = document.getElementById('list');
  var WEEK = ['一','二','三','四','五','六','日'];

  function todayKey(){
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function pad(n){ return n < 10 ? '0' + n : String(n); }
  function dateKey(offset){
    var d = new Date();
    d.setDate(d.getDate() + offset);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function save(){ try { localStorage.setItem(KEY, JSON.stringify(state)); } catch(e){} }
  function streak(habit){
    var count = 0;
    for (var i = 0; i >= -60; i--) {
      var k = dateKey(i);
      if (habit.days.indexOf(k) !== -1) count++;
      else if (i < 0) break;
      else break;
    }
    return count;
  }
  function render(){
    list.innerHTML = '';
    var doneToday = 0;
    state.habits.forEach(function(h){
      if (h.days.indexOf(todayKey()) !== -1) doneToday++;
      var wrap = document.createElement('div');
      wrap.className = 'habit';
      var top = document.createElement('div');
      top.className = 'top';
      var box = document.createElement('div');
      var name = document.createElement('div');
      name.className = 'name';
      name.textContent = h.name;
      var meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = '连续 ' + streak(h) + ' 天 · 累计 ' + h.days.length + ' 次';
      box.appendChild(name); box.appendChild(meta);
      var del = document.createElement('button');
      del.className = 'del';
      del.textContent = '删除';
      del.addEventListener('click', function(){
        state.habits = state.habits.filter(function(x){ return x.id !== h.id; });
        save(); render();
      });
      top.appendChild(box); top.appendChild(del);
      wrap.appendChild(top);
      var days = document.createElement('div');
      days.className = 'days';
      for (var i = 6; i >= 0; i--) {
        var key = dateKey(-i);
        var d = document.createElement('div');
        d.className = 'day' + (h.days.indexOf(key) !== -1 ? ' on' : '');
        var w = new Date(); w.setDate(w.getDate() - i);
        d.innerHTML = WEEK[(w.getDay() + 6) % 7] + '<span class="dot"></span>';
        (function(habit, k, node){
          node.addEventListener('click', function(){
            var idx = habit.days.indexOf(k);
            if (idx === -1) habit.days.push(k);
            else habit.days.splice(idx, 1);
            save(); render();
          });
        })(h, key, d);
        days.appendChild(d);
      }
      wrap.appendChild(days);
      list.appendChild(wrap);
    });
    document.getElementById('s_total').textContent = state.habits.length + ' 个习惯';
    document.getElementById('s_today').textContent = '今日完成 ' + doneToday;
    var best = 0;
    state.habits.forEach(function(h){ var s = streak(h); if (s > best) best = s; });
    document.getElementById('s_streak').textContent = '最长连续 ' + best + ' 天';
    var pct = state.habits.length ? Math.round(doneToday * 100 / state.habits.length) : 0;
    document.getElementById('bar').style.width = pct + '%';
  }
  document.getElementById('add').addEventListener('click', function(){
    var input = document.getElementById('input');
    var name = input.value.trim();
    if (!name) return;
    state.habits.push({ id: seq++, name: name, days: [] });
    input.value = '';
    save(); render();
  });
  document.getElementById('input').addEventListener('keydown', function(e){
    if (e.key === 'Enter') document.getElementById('add').click();
  });
  render();
})();
</script>
</body>
</html>`
}

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
