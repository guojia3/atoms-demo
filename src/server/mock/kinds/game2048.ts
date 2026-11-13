// 2048 模板：方向键 / WASD / 移动端滑动，合并计分、胜负判定、重新开始、最高分持久化
import { escapeHtml, BASE_CSS } from './shared.js'

export function game2048Html(prompt: string): string {
  const subtitle = escapeHtml(prompt).slice(0, 90)
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>2048</title>
<style>
${BASE_CSS}
  body{background:#faf8ef;color:#776e65;display:flex;justify-content:center;padding:24px}
  .wrap{width:100%;max-width:460px}
  header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}
  h1{font-size:32px;letter-spacing:-1px;color:#776e65}
  .sub{font-size:12px;color:#8f8578;margin-top:4px;max-width:270px;line-height:1.5}
  .hud{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:16px 0 12px}
  .box{background:#bbada0;color:#fff;border-radius:10px;padding:7px 14px;min-width:78px;text-align:center}
  .box span{display:block;font-size:10px;letter-spacing:.08em;color:#eee4da}
  .box strong{font-size:20px;display:block;margin-top:2px}
  .btn{border:0;border-radius:10px;padding:10px 14px;font-size:13px;font-weight:600;cursor:pointer;background:#8f7a66;color:#f9f6f2}
  .btn:hover{background:#7c6855}
  .board-wrap{position:relative}
  .board{display:grid;grid-template-columns:repeat(4,1fr);grid-template-rows:repeat(4,1fr);gap:8px;background:#bbada0;border-radius:14px;padding:8px;aspect-ratio:1;touch-action:none;user-select:none}
  .cell{border-radius:9px;background:#cdc1b4;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:22px;color:#776e65}
  .tile{background:#eee4da}
  .t4{background:#ede0c8}
  .t8{background:#f2b179;color:#f9f6f2}
  .t16{background:#f59563;color:#f9f6f2}
  .t32{background:#f67c5f;color:#f9f6f2}
  .t64{background:#f65e3b;color:#f9f6f2}
  .t128{background:#edcf72;color:#f9f6f2;font-size:19px}
  .t256{background:#edcc61;color:#f9f6f2;font-size:19px}
  .t512{background:#edc850;color:#f9f6f2;font-size:19px}
  .t1024{background:#edc53f;color:#f9f6f2;font-size:16px}
  .t2048{background:#edc22e;color:#f9f6f2;font-size:16px}
  .tbig{background:#3c3a32;color:#f9f6f2;font-size:14px}
  .overlay{position:absolute;inset:0;background:rgba(250,248,239,.82);border-radius:14px;display:flex;align-items:center;justify-content:center;padding:16px;text-align:center}
  .overlay[hidden]{display:none}
  .panel h2{font-size:22px;color:#776e65;margin-bottom:8px}
  .panel p{font-size:13px;color:#8f8578;line-height:1.6;margin-bottom:14px}
  .oacts{display:flex;gap:8px;justify-content:center;flex-wrap:wrap}
  .oacts .btn{background:#8f7a66}
  .oacts .ghost{background:#cdc1b4}
  .tip{margin-top:14px;font-size:12px;color:#8f8578;line-height:1.6}
  @media (max-width:420px){body{padding:14px}h1{font-size:26px}.cell{font-size:18px}.t128,.t256,.t512{font-size:16px}.t1024,.t2048{font-size:13px}}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div>
      <h1>2048</h1>
      <div class="sub">${subtitle || '方向键 / WASD / 手机滑动移动方块，相同数字合并，冲击 2048。'}</div>
    </div>
    <button class="btn" id="restart" type="button">重新开始</button>
  </header>
  <div class="hud">
    <div class="box"><span>得分</span><strong id="score">0</strong></div>
    <div class="box"><span>最高分</span><strong id="best">0</strong></div>
  </div>
  <div class="board-wrap">
    <div class="board" id="board"></div>
    <div class="overlay" id="overlay" hidden>
      <div class="panel">
        <h2 id="oTitle">达成 2048</h2>
        <p id="oText">继续挑战更高分，或者再来一局。</p>
        <div class="oacts">
          <button class="btn ghost" id="oContinue" type="button">继续挑战</button>
          <button class="btn" id="oRestart" type="button">重新开始</button>
        </div>
      </div>
    </div>
  </div>
  <div class="tip">操作：方向键或 WASD；手机在棋盘上滑动。每次移动会生成一个新方块（2 或 4）。最高分与当前局面自动保存。</div>
</div>
<script>
(function () {
  var KEY_STATE = 'atoms_2048_state_v1';
  var KEY_BEST = 'atoms_2048_best_v1';
  var state = { board: [], score: 0, won: false };
  var best = 0;

  function readBest() {
    try {
      var v = Number(localStorage.getItem(KEY_BEST) || 0);
      if (isFinite(v) && v > 0) best = Math.floor(v);
    } catch (e) { best = 0; }
  }
  function readState() {
    try {
      var raw = localStorage.getItem(KEY_STATE);
      if (!raw) return false;
      var parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.board) || parsed.board.length !== 16) return false;
      var ok = parsed.board.every(function (n) { return typeof n === 'number' && isFinite(n) && n >= 0; });
      if (!ok) return false;
      state.board = parsed.board.slice(0);
      state.score = Number(parsed.score) || 0;
      state.won = !!parsed.won;
      return true;
    } catch (e) { return false; }
  }
  function save() {
    try {
      localStorage.setItem(KEY_STATE, JSON.stringify(state));
      localStorage.setItem(KEY_BEST, String(best));
    } catch (e) {}
  }
  function newGame() {
    state.board = new Array(16).fill(0);
    state.score = 0;
    state.won = false;
    spawn();
    spawn();
    save();
    hideOverlay();
    render();
  }
  function emptyIndexes() {
    var list = [];
    for (var i = 0; i < 16; i++) if (state.board[i] === 0) list.push(i);
    return list;
  }
  function spawn() {
    var list = emptyIndexes();
    if (!list.length) return;
    var idx = list[Math.floor(Math.random() * list.length)];
    state.board[idx] = Math.random() < 0.9 ? 2 : 4;
  }
  function slideLine(values) {
    var vals = values.filter(function (v) { return v !== 0; });
    var out = [];
    var gained = 0;
    for (var i = 0; i < vals.length; i++) {
      if (i + 1 < vals.length && vals[i] === vals[i + 1]) {
        var merged = vals[i] * 2;
        out.push(merged);
        gained += merged;
        i++;
      } else {
        out.push(vals[i]);
      }
    }
    while (out.length < 4) out.push(0);
    return { line: out, gained: gained };
  }
  function linesFor(dir) {
    var lines = [];
    for (var r = 0; r < 4; r++) {
      var row = [];
      for (var c = 0; c < 4; c++) {
        if (dir === 'left') row.push(r * 4 + c);
        else if (dir === 'right') row.push(r * 4 + (3 - c));
        else if (dir === 'up') row.push(c * 4 + r);
        else row.push((3 - c) * 4 + r);
      }
      lines.push(row);
    }
    return lines;
  }
  function canMove() {
    var b = state.board;
    for (var i = 0; i < 16; i++) if (b[i] === 0) return true;
    for (var r = 0; r < 4; r++) {
      for (var c = 0; c < 4; c++) {
        var v = b[r * 4 + c];
        if (c < 3 && v === b[r * 4 + c + 1]) return true;
        if (r < 3 && v === b[(r + 1) * 4 + c]) return true;
      }
    }
    return false;
  }
  function move(dir) {
    var next = state.board.slice(0);
    var totalGain = 0;
    var changed = false;
    linesFor(dir).forEach(function (line) {
      var values = line.map(function (i) { return state.board[i]; });
      var res = slideLine(values);
      totalGain += res.gained;
      line.forEach(function (idx, k) {
        if (next[idx] !== res.line[k]) changed = true;
        next[idx] = res.line[k];
      });
    });
    if (!changed) return;
    state.score += totalGain;
    state.board = next;
    if (state.score > best) best = state.score;
    spawn();
    save();
    render();
    checkEnd();
  }
  function checkEnd() {
    if (state.board.some(function (v) { return v >= 2048; }) && !state.won) {
      state.won = true;
      save();
      showOverlay('达成 2048', '你合并出了 2048 方块，可以继续挑战更高分。', true);
      return;
    }
    if (!canMove()) {
      showOverlay('游戏结束', '没有可移动或可合并的方块了，得分 ' + state.score + '。', false);
    }
  }
  function showOverlay(title, text, withContinue) {
    var overlay = document.getElementById('overlay');
    document.getElementById('oTitle').textContent = title;
    document.getElementById('oText').textContent = text;
    document.getElementById('oContinue').style.display = withContinue ? '' : 'none';
    overlay.hidden = false;
  }
  function hideOverlay() {
    document.getElementById('overlay').hidden = true;
  }
  function render() {
    var board = document.getElementById('board');
    board.innerHTML = '';
    state.board.forEach(function (v) {
      var cell = document.createElement('div');
      cell.className = 'cell';
      if (v > 0) {
        cell.className += ' tile t' + (v <= 2048 ? v : 'big');
        cell.textContent = String(v);
      }
      board.appendChild(cell);
    });
    document.getElementById('score').textContent = String(state.score);
    document.getElementById('best').textContent = String(best);
  }

  document.getElementById('restart').addEventListener('click', newGame);
  document.getElementById('oRestart').addEventListener('click', newGame);
  document.getElementById('oContinue').addEventListener('click', hideOverlay);

  document.addEventListener('keydown', function (e) {
    var k = e.key;
    var dir = null;
    if (k === 'ArrowLeft' || k === 'a' || k === 'A') dir = 'left';
    else if (k === 'ArrowRight' || k === 'd' || k === 'D') dir = 'right';
    else if (k === 'ArrowUp' || k === 'w' || k === 'W') dir = 'up';
    else if (k === 'ArrowDown' || k === 's' || k === 'S') dir = 'down';
    if (!dir) return;
    e.preventDefault();
    if (!canMove()) return;
    hideOverlay();
    move(dir);
  });

  var touchX = 0;
  var touchY = 0;
  var boardEl = document.getElementById('board');
  boardEl.addEventListener('touchstart', function (e) {
    var t = e.touches && e.touches[0];
    if (!t) return;
    touchX = t.clientX;
    touchY = t.clientY;
  }, { passive: true });
  boardEl.addEventListener('touchmove', function (e) {
    if (e.cancelable) e.preventDefault();
  }, { passive: false });
  boardEl.addEventListener('touchend', function (e) {
    var t = e.changedTouches && e.changedTouches[0];
    if (!t) return;
    var dx = t.clientX - touchX;
    var dy = t.clientY - touchY;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return;
    if (!canMove()) return;
    hideOverlay();
    if (Math.abs(dx) > Math.abs(dy)) move(dx > 0 ? 'right' : 'left');
    else move(dy > 0 ? 'down' : 'up');
  }, { passive: true });

  readBest();
  if (!readState()) newGame();
  else { render(); checkEnd(); }
})();
</script>
</body>
</html>`
}
