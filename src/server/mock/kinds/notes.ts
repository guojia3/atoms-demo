// Markdown 笔记模板：多笔记新建/搜索/删除、标题与正文自动保存、简易 Markdown 预览
import { escapeHtml, BASE_CSS } from './shared.js'

export function notesHtml(prompt: string): string {
  const subtitle = escapeHtml(prompt).slice(0, 90)
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Markdown 笔记</title>
<style>
${BASE_CSS}
  body{background:#f6f7fb;color:#1f2333;padding:24px}
  .app{max-width:980px;margin:0 auto;display:grid;grid-template-columns:270px 1fr;gap:16px;align-items:start}
  .side,.main{min-width:0}
  .side{background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:14px;box-shadow:0 8px 24px rgba(17,24,39,.05)}
  .side-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px}
  .side-head h1{font-size:17px;letter-spacing:-.3px}
  .new{background:#4f46e5;color:#fff;border:0;border-radius:9px;padding:7px 12px;font-size:12px;font-weight:600;cursor:pointer}
  .new:hover{background:#4338ca}
  .search{width:100%;border:1px solid #e5e7eb;border-radius:9px;padding:8px 10px;font-size:13px;outline:none;margin-bottom:10px}
  .search:focus{border-color:#c7d2fe}
  .list{list-style:none;display:flex;flex-direction:column;gap:6px;max-height:420px;overflow:auto}
  .item{border:1px solid #eef0f4;background:#f9fafb;border-radius:11px;padding:9px 11px;cursor:pointer;transition:.15s}
  .item:hover{border-color:#c7d2fe}
  .item.on{background:#eef2ff;border-color:#c7d2fe}
  .item .t{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .item .s{font-size:11px;color:#9ca3af;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .item.on .t{color:#4338ca}
  .noresult{color:#9ca3af;font-size:12px;text-align:center;padding:18px 0}
  .main{background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:16px;box-shadow:0 8px 24px rgba(17,24,39,.05);min-height:520px;display:flex;flex-direction:column}
  .title{width:100%;min-width:0;border:0;outline:none;font-size:20px;font-weight:700;padding:4px 2px 10px;border-bottom:1px solid #eef0f4;background:transparent}
  .meta{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:10px 0;flex-wrap:wrap}
  .status{font-size:12px;color:#9ca3af}
  .tools{display:flex;gap:6px}
  .tool{border:1px solid #e5e7eb;background:#fff;border-radius:8px;font-size:12px;padding:5px 10px;cursor:pointer;color:#4b5563}
  .tool:hover{border-color:#4f46e5;color:#4f46e5}
  .tool.danger:hover{border-color:#fca5a5;color:#dc2626}
  .editor{flex:1;min-height:360px;width:100%;min-width:0;border:1px solid #eef0f4;border-radius:12px;padding:12px;font-size:14px;line-height:1.7;outline:none;resize:vertical;background:#fcfcfd;color:#1f2333}
  .editor:focus{border-color:#c7d2fe;background:#fff}
  .preview{flex:1;min-height:360px;border:1px solid #eef0f4;border-radius:12px;padding:14px 16px;font-size:14px;line-height:1.75;overflow:auto;background:#fcfcfd}
  .preview h1{font-size:22px;margin:6px 0 10px;letter-spacing:-.5px}
  .preview h2{font-size:18px;margin:14px 0 8px}
  .preview h3{font-size:15px;margin:12px 0 6px}
  .preview p{margin:6px 0;color:#374151}
  .preview li{margin:4px 0 4px 18px;color:#374151}
  .preview blockquote{border-left:3px solid #c7d2fe;background:#f8faff;padding:6px 12px;margin:8px 0;color:#4b5563;border-radius:0 8px 8px 0}
  .preview hr{border:0;border-top:1px solid #eef0f4;margin:14px 0}
  .preview a{color:#4f46e5}
  .preview .muted{color:#9ca3af}
  .foot{font-size:11px;color:#9ca3af;margin-top:10px}
  @media (max-width:760px){body{padding:16px}.app{grid-template-columns:1fr}.list{max-height:190px}.main{min-height:420px}.editor,.preview{min-height:280px}}
</style>
</head>
<body>
<div class="app">
  <aside class="side">
    <div class="side-head">
      <h1>Markdown 笔记</h1>
      <button class="new" id="new" type="button">+ 新建</button>
    </div>
    <input class="search" id="search" placeholder="搜索标题或正文">
    <ul class="list" id="list"></ul>
  </aside>
  <main class="main">
    <input class="title" id="title" placeholder="笔记标题" maxlength="60">
    <div class="meta">
      <span class="status" id="status">已保存</span>
      <div class="tools">
        <button class="tool" id="toggle" type="button">预览</button>
        <button class="tool danger" id="remove" type="button">删除</button>
      </div>
    </div>
    <textarea class="editor" id="editor" placeholder="开始输入，支持 # 标题、- 列表、**加粗**、*斜体*、> 引用"></textarea>
    <div class="preview" id="preview" hidden></div>
    <div class="foot">内容自动保存到云端 · 刷新或换设备登录后仍在</div>
  </main>
</div>
<script>
(function () {
  var KEY = 'atoms_notes_v1';
  var state = { notes: [], selected: null };
  var seq = 1;
  var saveTimer = null;
  var previewMode = false;

  function now() { return Date.now(); }
  function welcome() {
    return {
      id: seq++,
      title: '欢迎使用 Markdown 笔记',
      content: '# 欢迎使用 Markdown 笔记\\n\\n- 支持 **加粗** 与 *斜体*\\n- 左侧可新建、搜索、切换笔记\\n- 输入内容自动保存，刷新后仍在\\n\\n> 选中左侧笔记，在下方开始记录。',
      updatedAt: now()
    };
  }
  try {
    var saved = localStorage.getItem(KEY);
    if (saved) {
      var p = JSON.parse(saved);
      if (p && Array.isArray(p.notes)) {
        state.notes = p.notes.filter(function (n) { return n && typeof n.id === 'number' && typeof n.content === 'string'; });
        if (typeof p.selected === 'number') state.selected = p.selected;
      }
    }
  } catch (e) { state.notes = []; }
  state.notes.forEach(function (n) {
    if (!n.title) n.title = '未命名笔记';
    if (typeof n.updatedAt !== 'number') n.updatedAt = now();
    if (n.id >= seq) seq = n.id + 1;
  });
  if (state.notes.length === 0) state.notes.push(welcome());
  if (!state.notes.some(function (n) { return n.id === state.selected; })) state.selected = state.notes[0].id;

  var listEl = document.getElementById('list');
  var titleEl = document.getElementById('title');
  var editorEl = document.getElementById('editor');
  var previewEl = document.getElementById('preview');
  var statusEl = document.getElementById('status');
  var searchEl = document.getElementById('search');
  var toggleEl = document.getElementById('toggle');

  function save() {
    state.selected = currentId();
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
  }
  function currentId() { return state.selected; }
  function currentNote() {
    var id = currentId();
    var found = null;
    state.notes.forEach(function (n) { if (n.id === id) found = n; });
    return found;
  }
  function currentNoteSafe() {
    var n = currentNote();
    if (!n) {
      n = state.notes[0] || null;
      if (n) state.selected = n.id;
    }
    return n;
  }

  function pad(n) { return n < 10 ? '0' + n : String(n); }
  function formatDate(ts) {
    var d = new Date(ts);
    return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function escapeText(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function inlineFormat(s) {
    return s
      .replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>')
      .replace(/\\*([^*]+)\\*/g, '<em>$1</em>')
      .replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^)\\s]+)\\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  }
  function renderMarkdown(src) {
    var esc = escapeText(src || '');
    var lines = esc.split('\\n');
    var html = '';
    var listOpen = false;
    function closeList() {
      if (listOpen) { html += '</ul>'; listOpen = false; }
    }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line.trim()) { closeList(); continue; }
      if (/^### (.*)$/.test(line)) { closeList(); html += '<h3>' + inlineFormat(line.slice(4)) + '</h3>'; continue; }
      if (/^## (.*)$/.test(line)) { closeList(); html += '<h2>' + inlineFormat(line.slice(3)) + '</h2>'; continue; }
      if (/^# (.*)$/.test(line)) { closeList(); html += '<h1>' + inlineFormat(line.slice(2)) + '</h1>'; continue; }
      if (/^&gt; /.test(line)) { closeList(); html += '<blockquote>' + inlineFormat(line.slice(5)) + '</blockquote>'; continue; }
      if (/^---$/.test(line)) { closeList(); html += '<hr>'; continue; }
      if (/^- /.test(line)) {
        if (!listOpen) { html += '<ul>'; listOpen = true; }
        html += '<li>' + inlineFormat(line.slice(2)) + '</li>';
        continue;
      }
      closeList();
      html += '<p>' + inlineFormat(line) + '</p>';
    }
    closeList();
    return html || '<p class="muted">还没有内容，开始写点什么吧。</p>';
  }

  function renderList() {
    var keyword = searchEl.value.trim().toLowerCase();
    listEl.innerHTML = '';
    var shown = 0;
    state.notes.slice().sort(function (a, b) { return b.updatedAt - a.updatedAt; }).forEach(function (n) {
      if (keyword && (n.title + ' ' + n.content).toLowerCase().indexOf(keyword) === -1) return;
      shown++;
      var li = document.createElement('li');
      li.className = 'item' + (n.id === currentId() ? ' on' : '');
      var t = document.createElement('div');
      t.className = 't';
      t.textContent = n.title || '未命名笔记';
      var s = document.createElement('div');
      s.className = 's';
      s.textContent = formatDate(n.updatedAt) + ' · ' + n.content.replace(/[#>*\\-]/g, ' ').replace(/\\s+/g, ' ').trim().slice(0, 40);
      li.appendChild(t);
      li.appendChild(s);
      li.addEventListener('click', function () { selectNote(n.id); });
      listEl.appendChild(li);
    });
    if (!shown) {
      var empty = document.createElement('li');
      empty.className = 'noresult';
      empty.textContent = keyword ? '没有匹配的笔记' : '还没有笔记，点右上角新建';
      listEl.appendChild(empty);
    }
  }

  function renderEditor() {
    var n = currentNoteSafe();
    if (!n) return;
    titleEl.value = n.title || '';
    editorEl.value = n.content || '';
    updateMeta();
    if (previewMode) renderPreview();
  }
  function updateMeta() {
    var n = currentNoteSafe();
    var chars = (editorEl.value || '').replace(/\\s/g, '').length;
    statusEl.textContent = chars + ' 字 · 已保存';
  }
  function renderPreview() {
    previewEl.innerHTML = renderMarkdown(editorEl.value);
  }

  function flush() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    commit();
  }
  function commit() {
    var n = currentNoteSafe();
    if (!n) return;
    n.title = titleEl.value.trim().slice(0, 60) || '未命名笔记';
    n.content = editorEl.value;
    n.updatedAt = now();
    statusEl.textContent = (editorEl.value || '').replace(/\\s/g, '').length + ' 字 · 已保存';
    save();
    renderList();
    if (previewMode) renderPreview();
  }
  function scheduleSave() {
    statusEl.textContent = '保存中…';
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { saveTimer = null; commit(); }, 280);
  }

  function selectNote(id) {
    if (id === currentId()) return;
    flush();
    state.selected = id;
    var n = currentNote();
    if (!n) return;
    save();
    renderList();
    renderEditor();
    titleEl.focus();
  }
  function createNote() {
    flush();
    var n = { id: seq++, title: '新笔记', content: '', updatedAt: now() };
    state.notes.push(n);
    state.selected = n.id;
    save();
    renderList();
    renderEditor();
    titleEl.focus();
    titleEl.setSelectionRange(0, titleEl.value.length);
  }
  function removeNote() {
    var n = currentNoteSafe();
    if (!n) return;
    if (!confirm('删除「' + (n.title || '未命名笔记') + '」？此操作不可撤销。')) return;
    state.notes = state.notes.filter(function (x) { return x.id !== n.id; });
    if (state.notes.length === 0) state.notes.push(welcome());
    state.selected = state.notes[0].id;
    save();
    renderList();
    renderEditor();
    if (previewMode) renderPreview();
  }

  document.getElementById('new').addEventListener('click', createNote);
  document.getElementById('remove').addEventListener('click', removeNote);
  toggleEl.addEventListener('click', function () {
    previewMode = !previewMode;
    toggleEl.textContent = previewMode ? '编辑' : '预览';
    editorEl.hidden = previewMode;
    previewEl.hidden = !previewMode;
    if (previewMode) renderPreview();
  });
  titleEl.addEventListener('input', scheduleSave);
  editorEl.addEventListener('input', function () {
    updateMeta();
    scheduleSave();
    if (previewMode) renderPreview();
  });
  searchEl.addEventListener('input', renderList);
  window.addEventListener('beforeunload', function () { flush(); });

  renderList();
  renderEditor();
  save();
})();
</script>
</body>
</html>`
}
