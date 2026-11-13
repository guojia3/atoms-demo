// 任务看板模板：新增 / 编辑 / 删除 / 三列推进，localStorage 持久化
import { escapeHtml, BASE_CSS } from './shared.js'

export function kanbanHtml(prompt: string): string {
  const subtitle = escapeHtml(prompt).slice(0, 90)
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>任务看板</title>
<style>
${BASE_CSS}
  body{background:#f6f7fb;color:#1f2333;padding:24px}
  .wrap{max-width:1080px;margin:0 auto}
  header{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:20px}
  h1{font-size:26px;letter-spacing:-.5px}
  .sub{color:#6b7280;font-size:13px;margin-top:6px;max-width:560px}
  .stats{display:flex;gap:8px}
  .pill{background:#fff;border:1px solid #e5e7eb;border-radius:999px;padding:6px 12px;font-size:12px;color:#4b5563}
  .composer{display:flex;gap:10px;background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:10px;margin-bottom:20px;box-shadow:0 8px 24px rgba(17,24,39,.05)}
  .composer input{flex:1;min-width:0;border:0;outline:none;font-size:15px;padding:8px 10px;background:transparent}
  .composer button{background:#4f46e5;color:#fff;border:0;border-radius:11px;padding:10px 18px;font-size:14px;cursor:pointer;font-weight:600}
  .composer button:hover{background:#4338ca}
  .board{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
  .col{background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:14px;min-height:260px}
  .col h2{font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:.08em;display:flex;justify-content:space-between;margin-bottom:12px}
  .card{background:#f9fafb;border:1px solid #eef0f4;border-radius:12px;padding:12px;margin-bottom:10px;transition:.15s}
  .card:hover{border-color:#c7d2fe;box-shadow:0 4px 12px rgba(79,70,229,.08)}
  .card p{font-size:14px;line-height:1.5;word-break:break-word}
  .edit-input{width:100%;border:1px solid #c7d2fe;border-radius:8px;padding:7px 9px;font-size:14px;outline:none;background:#fff}
  .card .row{display:flex;justify-content:space-between;align-items:center;margin-top:10px;gap:6px;flex-wrap:wrap}
  .tag{font-size:11px;color:#4f46e5;background:#eef2ff;border-radius:999px;padding:3px 9px}
  .actions{display:flex;gap:6px;flex-wrap:wrap}
  .act{border:1px solid #e5e7eb;background:#fff;border-radius:8px;font-size:12px;padding:5px 9px;cursor:pointer;color:#374151}
  .act:hover{border-color:#4f46e5;color:#4f46e5}
  .act.danger:hover{border-color:#fca5a5;color:#dc2626}
  .act.primary{color:#4f46e5;border-color:#c7d2fe}
  .empty{color:#9ca3af;font-size:13px;text-align:center;padding:26px 0;border:1px dashed #e5e7eb;border-radius:10px}
  footer{margin-top:22px;text-align:center;color:#9ca3af;font-size:12px}
  @media (max-width:760px){body{padding:16px}.board{grid-template-columns:1fr}.col{min-height:0}.composer{flex-wrap:wrap}.composer button{width:100%}}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div>
      <h1>今日任务看板</h1>
      <div class="sub">${subtitle || '把一件事拆成小步，逐张卡片推进；支持新增、编辑、删除，数据刷新后仍在。'}</div>
    </div>
    <div class="stats">
      <span class="pill" id="total">共 0 项</span>
      <span class="pill" id="progress">完成 0%</span>
    </div>
  </header>
  <div class="composer">
    <input id="input" placeholder="添加一项任务，回车或点击按钮" maxlength="80">
    <button id="add" type="button">添加任务</button>
  </div>
  <div class="board" id="board"></div>
  <footer>Atoms Demo 生成 · 点击卡片按钮推进状态，编辑可改文案，删除会立即移除</footer>
</div>
<script>
(function () {
  var KEY = 'atoms_kanban_v2';
  var state = { cards: [] };
  var seq = 1;
  var editingId = null;
  try {
    var saved = localStorage.getItem(KEY);
    if (saved) state = JSON.parse(saved);
    if (!state || !Array.isArray(state.cards)) state = { cards: [] };
    state.cards.forEach(function (c) { if (c.id >= seq) seq = c.id + 1; });
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

  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {} }
  function move(id, status) {
    state.cards.forEach(function (c) { if (c.id === id) c.status = status; });
    save(); render();
  }
  function remove(id) {
    state.cards = state.cards.filter(function (c) { return c.id !== id; });
    if (editingId === id) editingId = null;
    save(); render();
  }
  function startEdit(id) { editingId = id; render(); }
  function commitEdit(id, value) {
    var text = String(value || '').trim();
    if (text) state.cards.forEach(function (c) { if (c.id === id) c.text = text.slice(0, 80); });
    editingId = null; save(); render();
  }

  function actionButton(label, cls, onClick) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'act' + (cls ? ' ' + cls : '');
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    return btn;
  }

  function render() {
    board.innerHTML = '';
    COLS.forEach(function (col) {
      var items = state.cards.filter(function (c) { return c.status === col.key; });
      var el = document.createElement('div');
      el.className = 'col';
      var head = document.createElement('h2');
      head.textContent = col.name;
      var count = document.createElement('span');
      count.textContent = String(items.length);
      head.appendChild(count);
      el.appendChild(head);
      if (items.length === 0) {
        var empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = '暂无任务';
        el.appendChild(empty);
      }
      items.forEach(function (card) {
        var c = document.createElement('div');
        c.className = 'card';
        if (editingId === card.id) {
          var input = document.createElement('input');
          input.className = 'edit-input';
          input.maxLength = 80;
          input.value = card.text;
          c.appendChild(input);
          var editRow = document.createElement('div');
          editRow.className = 'row';
          var tagEdit = document.createElement('span');
          tagEdit.className = 'tag';
          tagEdit.textContent = '编辑中';
          editRow.appendChild(tagEdit);
          var acts = document.createElement('div');
          acts.className = 'actions';
          acts.appendChild(actionButton('保存', 'primary', function () { commitEdit(card.id, input.value); }));
          acts.appendChild(actionButton('取消', '', function () { editingId = null; render(); }));
          editRow.appendChild(acts);
          c.appendChild(editRow);
          input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); commitEdit(card.id, input.value); }
            if (e.key === 'Escape') { editingId = null; render(); }
          });
          el.appendChild(c);
          setTimeout(function () { try { input.focus(); input.setSelectionRange(input.value.length, input.value.length); } catch (err) {} }, 0);
          return;
        }
        var p = document.createElement('p');
        p.textContent = card.text;
        c.appendChild(p);
        var row = document.createElement('div');
        row.className = 'row';
        var tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = col.name;
        row.appendChild(tag);
        var buttons = document.createElement('div');
        buttons.className = 'actions';
        buttons.appendChild(actionButton('编辑', '', function () { startEdit(card.id); }));
        buttons.appendChild(actionButton('删除', 'danger', function () { remove(card.id); }));
        if (col.key === 'todo') buttons.appendChild(actionButton('开始 →', 'primary', function () { move(card.id, 'doing'); }));
        if (col.key === 'doing') buttons.appendChild(actionButton('完成 ✓', 'primary', function () { move(card.id, 'done'); }));
        if (col.key === 'done') buttons.appendChild(actionButton('退回 ↺', '', function () { move(card.id, 'todo'); }));
        row.appendChild(buttons);
        c.appendChild(row);
        el.appendChild(c);
      });
      board.appendChild(el);
    });
    var done = state.cards.filter(function (c) { return c.status === 'done'; }).length;
    document.getElementById('total').textContent = '共 ' + state.cards.length + ' 项';
    document.getElementById('progress').textContent = state.cards.length ? ('完成 ' + Math.round(done * 100 / state.cards.length) + '%') : '完成 0%';
  }

  function addCard() {
    var input = document.getElementById('input');
    var text = input.value.trim();
    if (!text) return;
    state.cards.push({ id: seq++, text: text.slice(0, 80), status: 'todo' });
    input.value = '';
    save(); render();
  }
  document.getElementById('add').addEventListener('click', addCard);
  document.getElementById('input').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); addCard(); }
  });
  save(); render();
})();
</script>
</body>
</html>`
}
