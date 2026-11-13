// 习惯打卡模板：一周七天打卡、连续天数、今日进度、新增/删除，localStorage 持久化
import { escapeHtml, BASE_CSS } from './shared.js'

export function habitHtml(prompt: string): string {
  const subtitle = escapeHtml(prompt).slice(0, 90)
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>习惯打卡</title>
<style>
${BASE_CSS}
  body{background:#f6f7fb;color:#1f2333;padding:24px}
  .wrap{max-width:820px;margin:0 auto}
  header{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:18px}
  h1{font-size:26px;letter-spacing:-.5px}
  .sub{color:#6b7280;font-size:13px;margin-top:6px;max-width:520px}
  .stats{display:flex;gap:8px}
  .pill{background:#fff;border:1px solid #e5e7eb;border-radius:999px;padding:6px 12px;font-size:12px;color:#4b5563}
  .bar{height:8px;background:#e5e7eb;border-radius:999px;overflow:hidden;margin-bottom:20px}
  .bar i{display:block;height:100%;width:0;background:#16a34a;border-radius:999px;transition:width .2s}
  .composer{display:flex;gap:10px;background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:10px;margin-bottom:20px;box-shadow:0 8px 24px rgba(17,24,39,.05)}
  .composer input{flex:1;min-width:0;border:0;outline:none;font-size:15px;padding:8px 10px;background:transparent}
  .composer button{background:#16a34a;color:#fff;border:0;border-radius:11px;padding:10px 18px;font-size:14px;cursor:pointer;font-weight:600}
  .composer button:hover{background:#15803d}
  .week{display:flex;align-items:center;justify-content:space-between;gap:10px;background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:10px 12px;margin-bottom:14px}
  .week button{border:1px solid #e5e7eb;background:#fff;border-radius:9px;padding:6px 12px;font-size:13px;cursor:pointer;color:#374151}
  .week button:hover{border-color:#16a34a;color:#16a34a}
  .week button:disabled{opacity:.4;cursor:default;border-color:#e5e7eb;color:#9ca3af}
  .weeklabel{font-size:13px;color:#4b5563;font-weight:600}
  .habit{background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:14px;margin-bottom:12px}
  .habit-top{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}
  .name{font-size:15px;font-weight:600;word-break:break-word}
  .tagline{display:flex;gap:6px;align-items:center}
  .streak{font-size:11px;color:#15803d;background:#dcfce7;border-radius:999px;padding:3px 9px;white-space:nowrap}
  .del{border:1px solid #e5e7eb;background:#fff;border-radius:8px;font-size:12px;padding:4px 9px;cursor:pointer;color:#6b7280}
  .del:hover{border-color:#fca5a5;color:#dc2626}
  .days{display:grid;grid-template-columns:repeat(7,1fr);gap:6px}
  .day{border:1px solid #eef0f4;background:#f9fafb;border-radius:10px;padding:8px 0;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:4px;color:#6b7280}
  .day:hover{border-color:#86efac}
  .day b{font-size:11px;font-weight:500}
  .day i{width:22px;height:22px;border-radius:999px;border:1px solid #d1d5db;display:flex;align-items:center;justify-content:center;font-size:12px;font-style:normal;background:#fff}
  .day.on{background:#f0fdf4;border-color:#86efac;color:#15803d}
  .day.on i{background:#16a34a;border-color:#16a34a;color:#fff}
  .day.today{border-color:#16a34a;box-shadow:0 0 0 2px #dcfce7}
  .day:disabled{cursor:default;opacity:.45}
  .empty{color:#9ca3af;font-size:13px;text-align:center;padding:30px 0;border:1px dashed #e5e7eb;border-radius:14px}
  footer{margin-top:20px;text-align:center;color:#9ca3af;font-size:12px}
  @media (max-width:760px){body{padding:16px}.composer{flex-wrap:wrap}.composer button{width:100%}.day b{font-size:10px}.day i{width:19px;height:19px;font-size:11px}}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div>
      <h1>习惯打卡</h1>
      <div class="sub">${subtitle || '每天一个小勾，连续打卡不掉线；数据自动保存，换设备登录也能看到。'}</div>
    </div>
    <div class="stats">
      <span class="pill" id="today">今日 0 / 0</span>
      <span class="pill" id="weekpct">本周 0%</span>
    </div>
  </header>
  <div class="bar"><i id="bar"></i></div>
  <div class="composer">
    <input id="input" placeholder="新增一个习惯，比如「每天喝 8 杯水」" maxlength="30">
    <button id="add" type="button">添加习惯</button>
  </div>
  <div class="week">
    <button id="prev" type="button">‹ 上一周</button>
    <span class="weeklabel" id="weeklabel"></span>
    <button id="next" type="button">下一周 ›</button>
  </div>
  <div id="list"></div>
  <footer>Atoms Demo 生成 · 点击日期圆圈切换打卡状态，连续天数按最近打卡自动计算</footer>
</div>
<script>
(function () {
  var KEY = 'atoms_habit_v1';
  var state = { habits: [] };
  var weekOffset = 0;
  var seq = 1;
  try {
    var saved = localStorage.getItem(KEY);
    if (saved) state = JSON.parse(saved);
    if (!state || !Array.isArray(state.habits)) state = { habits: [] };
    state.habits.forEach(function (h) {
      if (!h.checks) h.checks = {};
      if (h.id >= seq) seq = h.id + 1;
    });
  } catch (e) { state = { habits: [] }; }
  if (state.habits.length === 0) {
    state.habits = [
      { id: seq++, name: '早起喝水', checks: {} },
      { id: seq++, name: '运动 20 分钟', checks: {} },
      { id: seq++, name: '阅读 10 页', checks: {} }
    ];
  }
  var WEEK_LABELS = ['一', '二', '三', '四', '五', '六', '日'];

  function pad(n) { return n < 10 ? '0' + n : String(n); }
  function dayKey(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function weekStart(offset) {
    var now = new Date();
    var base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var dow = (base.getDay() + 6) % 7;
    base.setDate(base.getDate() - dow + offset * 7);
    return base;
  }
  function weekDays(offset) {
    var start = weekStart(offset);
    var list = [];
    for (var i = 0; i < 7; i++) {
      var d = new Date(start);
      d.setDate(start.getDate() + i);
      list.push(d);
    }
    return list;
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {} }

  function streak(habit) {
    var n = 0;
    var d = new Date();
    if (!habit.checks[dayKey(d)]) d.setDate(d.getDate() - 1);
    for (var i = 0; i < 400; i++) {
      if (habit.checks[dayKey(d)]) { n++; d.setDate(d.getDate() - 1); } else break;
    }
    return n;
  }

  var listEl = document.getElementById('list');
  function render() {
    var todayKey = dayKey(new Date());
    var days = weekDays(weekOffset);
    var start = days[0];
    var end = days[6];
    document.getElementById('weeklabel').textContent =
      weekOffset === 0 ? '本周' :
      (start.getMonth() + 1) + '/' + start.getDate() + ' - ' + (end.getMonth() + 1) + '/' + end.getDate();
    document.getElementById('next').disabled = weekOffset >= 0;

    listEl.innerHTML = '';
    if (state.habits.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = '还没有习惯，先在上方添加一个吧';
      listEl.appendChild(empty);
    }
    state.habits.forEach(function (habit) {
      var card = document.createElement('div');
      card.className = 'habit';
      var top = document.createElement('div');
      top.className = 'habit-top';
      var name = document.createElement('div');
      name.className = 'name';
      name.textContent = habit.name;
      var tagline = document.createElement('div');
      tagline.className = 'tagline';
      var st = streak(habit);
      var streakEl = document.createElement('span');
      streakEl.className = 'streak';
      streakEl.textContent = st > 0 ? '连续 ' + st + ' 天' : '尚未开始';
      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'del';
      del.textContent = '删除';
      del.addEventListener('click', function () {
        state.habits = state.habits.filter(function (h) { return h.id !== habit.id; });
        save();
        render();
      });
      tagline.appendChild(streakEl);
      tagline.appendChild(del);
      top.appendChild(name);
      top.appendChild(tagline);
      card.appendChild(top);

      var grid = document.createElement('div');
      grid.className = 'days';
      days.forEach(function (d, i) {
        var key = dayKey(d);
        var on = !!habit.checks[key];
        var future = key > todayKey;
        var cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'day' + (on ? ' on' : '') + (key === todayKey ? ' today' : '');
        cell.disabled = future;
        var b = document.createElement('b');
        b.textContent = WEEK_LABELS[i];
        var i2 = document.createElement('i');
        i2.textContent = String(d.getDate());
        cell.appendChild(b);
        cell.appendChild(i2);
        cell.addEventListener('click', function () {
          if (future) return;
          if (habit.checks[key]) delete habit.checks[key];
          else habit.checks[key] = true;
          save();
          render();
        });
        grid.appendChild(cell);
      });
      card.appendChild(grid);
      listEl.appendChild(card);
    });

    var todayDone = 0;
    state.habits.forEach(function (h) { if (h.checks[todayKey]) todayDone++; });
    var weekDone = 0;
    var weekTotal = state.habits.length * 7;
    state.habits.forEach(function (h) {
      days.forEach(function (d) { if (h.checks[dayKey(d)]) weekDone++; });
    });
    var pct = weekTotal ? Math.round(weekDone * 100 / weekTotal) : 0;
    document.getElementById('today').textContent = '今日 ' + todayDone + ' / ' + state.habits.length;
    document.getElementById('weekpct').textContent = '本周 ' + pct + '%';
    document.getElementById('bar').style.width = pct + '%';
  }

  function addHabit() {
    var input = document.getElementById('input');
    var text = input.value.trim();
    if (!text) return;
    state.habits.push({ id: seq++, name: text.slice(0, 30), checks: {} });
    input.value = '';
    save();
    render();
  }
  document.getElementById('add').addEventListener('click', addHabit);
  document.getElementById('input').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); addHabit(); }
  });
  document.getElementById('prev').addEventListener('click', function () { weekOffset -= 1; render(); });
  document.getElementById('next').addEventListener('click', function () { if (weekOffset < 0) { weekOffset += 1; render(); } });

  save();
  render();
})();
</script>
</body>
</html>`
}
