// 记账本模板：金额/分类/备注/日期录入、合计统计、分类筛选、删除，localStorage 持久化
import { escapeHtml, BASE_CSS } from './shared.js'

export function expenseHtml(prompt: string): string {
  const subtitle = escapeHtml(prompt).slice(0, 90)
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>记账本</title>
<style>
${BASE_CSS}
  body{background:#f6f7fb;color:#1f2333;padding:24px}
  .wrap{max-width:760px;margin:0 auto}
  header{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:18px}
  h1{font-size:26px;letter-spacing:-.5px}
  .sub{color:#6b7280;font-size:13px;margin-top:6px;max-width:520px}
  .cards{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:18px}
  .card{background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:12px 14px}
  .card span{font-size:11px;color:#9ca3af;letter-spacing:.05em}
  .card strong{display:block;font-size:20px;margin-top:4px;font-variant-numeric:tabular-nums}
  .card.today strong{color:#4f46e5}
  .form{background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:14px;margin-bottom:16px;box-shadow:0 8px 24px rgba(17,24,39,.05)}
  .grid{display:grid;grid-template-columns:1.2fr 1fr 1fr;gap:10px;margin-bottom:10px}
  .field{display:flex;flex-direction:column;gap:5px}
  .field label{font-size:11px;color:#9ca3af;letter-spacing:.04em}
  .field input,.field select{border:1px solid #e5e7eb;border-radius:10px;padding:9px 10px;font-size:14px;outline:none;background:#fff;color:#1f2333;min-width:0}
  .field input:focus,.field select:focus{border-color:#c7d2fe}
  .note-row{display:flex;gap:10px}
  .note-row .field{flex:1}
  .add{background:#4f46e5;color:#fff;border:0;border-radius:11px;padding:11px 20px;font-size:14px;font-weight:600;cursor:pointer;white-space:nowrap}
  .add:hover{background:#4338ca}
  .error{color:#dc2626;font-size:12px;min-height:16px;margin-top:6px}
  .filters{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}
  .chip{border:1px solid #e5e7eb;background:#fff;border-radius:999px;padding:5px 12px;font-size:12px;cursor:pointer;color:#6b7280}
  .chip:hover{border-color:#c7d2fe}
  .chip.on{background:#eef2ff;border-color:#c7d2fe;color:#4338ca;font-weight:600}
  .list{display:flex;flex-direction:column;gap:8px}
  .row{display:flex;align-items:center;gap:12px;background:#fff;border:1px solid #e5e7eb;border-radius:13px;padding:11px 14px}
  .badge{font-size:11px;background:#eef2ff;color:#4338ca;border-radius:999px;padding:4px 9px;white-space:nowrap}
  .info{flex:1;min-width:0}
  .info .t{font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .info .d{font-size:11px;color:#9ca3af;margin-top:2px}
  .amount{font-size:15px;font-weight:700;color:#dc2626;font-variant-numeric:tabular-nums;white-space:nowrap}
  .del{border:1px solid #e5e7eb;background:#fff;border-radius:8px;font-size:12px;padding:5px 9px;cursor:pointer;color:#6b7280;flex-shrink:0}
  .del:hover{border-color:#fca5a5;color:#dc2626}
  .empty{color:#9ca3af;font-size:13px;text-align:center;padding:30px 0;border:1px dashed #e5e7eb;border-radius:13px}
  footer{margin-top:20px;text-align:center;color:#9ca3af;font-size:12px}
  @media (max-width:760px){body{padding:16px}.grid{grid-template-columns:1fr 1fr}.grid .field:first-child{grid-column:1 / -1}.cards{grid-template-columns:repeat(2,1fr)}.card.today{grid-column:1 / -1}.note-row{flex-wrap:wrap}.row{gap:8px}.info .t{font-size:13px}}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div>
      <h1>记账本</h1>
      <div class="sub">${subtitle || '记录每一笔花销，自动汇总合计与今日支出；数据保存在云端，刷新后仍在。'}</div>
    </div>
  </header>
  <div class="cards">
    <div class="card"><span>总支出</span><strong id="total">¥0.00</strong></div>
    <div class="card today"><span>今日支出</span><strong id="todayTotal">¥0.00</strong></div>
    <div class="card"><span>笔数</span><strong id="count">0</strong></div>
  </div>
  <div class="form">
    <div class="grid">
      <div class="field">
        <label>金额（元）</label>
        <input id="amount" type="number" min="0.01" step="0.01" placeholder="0.00">
      </div>
      <div class="field">
        <label>分类</label>
        <select id="category"></select>
      </div>
      <div class="field">
        <label>日期</label>
        <input id="date" type="date">
      </div>
    </div>
    <div class="note-row">
      <div class="field">
        <label>备注</label>
        <input id="note" placeholder="比如：午餐 / 地铁 / 咖啡" maxlength="40">
      </div>
      <button class="add" id="add" type="button">记一笔</button>
    </div>
    <div class="error" id="error"></div>
  </div>
  <div class="filters" id="filters"></div>
  <div class="list" id="list"></div>
  <footer>Atoms Demo 生成 · 点击分类标签筛选，删除会即时更新合计</footer>
</div>
<script>
(function () {
  var KEY = 'atoms_expense_v1';
  var CATS = ['餐饮', '交通', '购物', '居住', '娱乐', '其他'];
  var state = { items: [], filter: '全部' };
  var seq = 1;

  function pad(n) { return n < 10 ? '0' + n : String(n); }
  function todayKey() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  try {
    var saved = localStorage.getItem(KEY);
    if (saved) {
      var p = JSON.parse(saved);
      if (p && Array.isArray(p.items)) {
        state.items = p.items.filter(function (x) {
          return x && typeof x.amount === 'number' && isFinite(x.amount) && x.amount > 0;
        });
      }
      if (p && typeof p.filter === 'string') state.filter = p.filter;
    }
  } catch (e) { state.items = []; }
  state.items.forEach(function (x) {
    if (typeof x.id !== 'number') x.id = seq++;
    if (x.id >= seq) seq = x.id + 1;
    if (!x.category || CATS.indexOf(x.category) === -1) x.category = '其他';
    if (!x.date) x.date = todayKey();
    if (!x.note) x.note = x.category;
  });
  if (state.items.length === 0) {
    state.items = [
      { id: seq++, amount: 32.5, category: '餐饮', note: '午餐', date: todayKey() },
      { id: seq++, amount: 12, category: '交通', note: '地铁往返', date: todayKey() }
    ];
  }
  if (CATS.indexOf(state.filter) === -1) state.filter = '全部';

  var amountEl = document.getElementById('amount');
  var categoryEl = document.getElementById('category');
  var dateEl = document.getElementById('date');
  var noteEl = document.getElementById('note');
  var errorEl = document.getElementById('error');
  var listEl = document.getElementById('list');
  var filtersEl = document.getElementById('filters');

  CATS.forEach(function (c) {
    var opt = document.createElement('option');
    opt.value = c;
    opt.textContent = c;
    categoryEl.appendChild(opt);
  });
  dateEl.value = todayKey();

  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {} }
  function money(n) { return '¥' + n.toFixed(2); }
  function formatDate(s) { return s === todayKey() ? '今天' : s; }

  function renderFilters() {
    filtersEl.innerHTML = '';
    ['全部'].concat(CATS).forEach(function (c) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip' + (state.filter === c ? ' on' : '');
      chip.textContent = c;
      chip.addEventListener('click', function () {
        state.filter = c;
        save();
        render();
      });
      filtersEl.appendChild(chip);
    });
  }

  function render() {
    var items = state.items.slice().sort(function (a, b) {
      if (a.date === b.date) return b.id - a.id;
      return a.date < b.date ? 1 : -1;
    });
    var shown = state.filter === '全部' ? items : items.filter(function (x) { return x.category === state.filter; });
    listEl.innerHTML = '';
    if (shown.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = state.filter === '全部' ? '还没有记录，先记一笔吧' : '该分类下暂无记录';
      listEl.appendChild(empty);
    }
    shown.forEach(function (item) {
      var row = document.createElement('div');
      row.className = 'row';
      var badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = item.category;
      var info = document.createElement('div');
      info.className = 'info';
      var t = document.createElement('div');
      t.className = 't';
      t.textContent = item.note;
      var d = document.createElement('div');
      d.className = 'd';
      d.textContent = formatDate(item.date);
      info.appendChild(t);
      info.appendChild(d);
      var amount = document.createElement('span');
      amount.className = 'amount';
      amount.textContent = '-' + money(item.amount);
      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'del';
      del.textContent = '删除';
      del.addEventListener('click', function () {
        state.items = state.items.filter(function (x) { return x.id !== item.id; });
        save();
        render();
      });
      row.appendChild(badge);
      row.appendChild(info);
      row.appendChild(amount);
      row.appendChild(del);
      listEl.appendChild(row);
    });

    var total = 0;
    var today = 0;
    state.items.forEach(function (x) {
      total += x.amount;
      if (x.date === todayKey()) today += x.amount;
    });
    document.getElementById('total').textContent = money(total);
    document.getElementById('todayTotal').textContent = money(today);
    document.getElementById('count').textContent = String(state.items.length);
  }

  function addItem() {
    errorEl.textContent = '';
    var raw = amountEl.value.trim();
    var amount = parseFloat(raw);
    if (!raw || !isFinite(amount) || amount <= 0) {
      errorEl.textContent = '请输入大于 0 的金额';
      amountEl.focus();
      return;
    }
    if (amount > 999999) {
      errorEl.textContent = '金额过大，请分笔记录';
      return;
    }
    var category = categoryEl.value;
    if (CATS.indexOf(category) === -1) category = '其他';
    var date = dateEl.value || todayKey();
    var note = noteEl.value.trim().slice(0, 40) || category;
    state.items.push({ id: seq++, amount: Math.round(amount * 100) / 100, category: category, note: note, date: date });
    amountEl.value = '';
    noteEl.value = '';
    noteEl.focus();
    save();
    render();
  }

  document.getElementById('add').addEventListener('click', addItem);
  amountEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); addItem(); } });
  noteEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); addItem(); } });

  save();
  renderFilters();
  render();
})();
</script>
</body>
</html>`
}
