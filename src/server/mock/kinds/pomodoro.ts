// 番茄专注模板：25 分钟专注 / 5 分钟休息，开始暂停重置跳过、环形进度、每日完成次数持久化
import { escapeHtml, BASE_CSS } from './shared.js'

export function pomodoroHtml(prompt: string): string {
  const subtitle = escapeHtml(prompt).slice(0, 90)
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>番茄专注</title>
<style>
${BASE_CSS}
  body{background:#f6f7fb;color:#1f2333;display:flex;justify-content:center;padding:24px}
  .wrap{width:100%;max-width:520px}
  header{text-align:center;margin-bottom:18px}
  h1{font-size:26px;letter-spacing:-.5px}
  .sub{color:#6b7280;font-size:13px;margin-top:6px}
  .tabs{display:flex;gap:8px;justify-content:center;margin-bottom:22px}
  .tab{border:1px solid #e5e7eb;background:#fff;border-radius:999px;padding:7px 16px;font-size:13px;cursor:pointer;color:#6b7280}
  .tab:hover{border-color:#c7d2fe}
  .tab.on{background:#eef2ff;border-color:#c7d2fe;color:#4338ca;font-weight:600}
  .ring{width:240px;height:240px;border-radius:50%;margin:0 auto 22px;display:flex;align-items:center;justify-content:center;background:conic-gradient(#4f46e5 0deg, #4f46e5 0deg, #e2e8f0 0deg, #e2e8f0 360deg);transition:background .3s}
  .ring-inner{width:196px;height:196px;border-radius:50%;background:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;box-shadow:inset 0 0 0 1px #eef0f4}
  .time{font-size:42px;font-weight:700;letter-spacing:-1px;font-variant-numeric:tabular-nums}
  .phase{font-size:13px;color:#6b7280}
  .controls{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-bottom:20px}
  .btn{border:0;border-radius:12px;padding:12px 22px;font-size:14px;font-weight:600;cursor:pointer}
  .primary{background:#4f46e5;color:#fff}
  .primary:hover{background:#4338ca}
  .primary.break{background:#16a34a}
  .primary.break:hover{background:#15803d}
  .ghost{background:#fff;color:#4b5563;border:1px solid #e5e7eb}
  .ghost:hover{border-color:#4f46e5;color:#4f46e5}
  .stats{display:flex;gap:10px;justify-content:center}
  .pill{background:#fff;border:1px solid #e5e7eb;border-radius:999px;padding:8px 14px;font-size:12px;color:#4b5563}
  .pill b{color:#111827}
  .tip{margin-top:20px;text-align:center;color:#9ca3af;font-size:12px;line-height:1.7}
  .toast{position:fixed;left:50%;bottom:22px;transform:translateX(-50%) translateY(20px);background:#111827;color:#fff;font-size:13px;padding:10px 16px;border-radius:12px;opacity:0;pointer-events:none;transition:.25s;max-width:88vw;text-align:center}
  .toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
  @media (max-width:420px){body{padding:16px}.ring{width:210px;height:210px}.ring-inner{width:170px;height:170px}.time{font-size:36px}.controls .btn{padding:11px 16px}.sub{font-size:12px}}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>番茄专注</h1>
    <div class="sub">${subtitle || '专注 25 分钟，休息 5 分钟；进度自动保存，刷新页面也不丢失。'}</div>
  </header>
  <div class="tabs">
    <button class="tab on" id="tabFocus" type="button">专注 25 分钟</button>
    <button class="tab" id="tabBreak" type="button">休息 5 分钟</button>
  </div>
  <div class="ring" id="ring">
    <div class="ring-inner">
      <div class="time" id="time">25:00</div>
      <div class="phase" id="phase">准备开始</div>
    </div>
  </div>
  <div class="controls">
    <button class="btn primary" id="toggle" type="button">开始专注</button>
    <button class="btn ghost" id="reset" type="button">重置</button>
    <button class="btn ghost" id="skip" type="button">跳过</button>
  </div>
  <div class="stats">
    <span class="pill">今日完成 <b id="todayCount">0</b> 次</span>
    <span class="pill">累计 <b id="totalCount">0</b> 次</span>
  </div>
  <div class="tip">快捷键：空格暂停 / 继续。完成一次专注后自动进入 5 分钟休息，次数按日期保存。</div>
</div>
<div class="toast" id="toast"></div>
<script>
(function () {
  var KEY = 'atoms_pomodoro_v1';
  var DUR = { focus: 25 * 60 * 1000, break: 5 * 60 * 1000 };
  var state = { mode: 'focus', running: false, endAt: 0, remaining: DUR.focus, records: {} };
  try {
    var saved = localStorage.getItem(KEY);
    if (saved) {
      var p = JSON.parse(saved);
      if (p && (p.mode === 'focus' || p.mode === 'break')) state.mode = p.mode;
      if (p && typeof p.running === 'boolean') state.running = p.running;
      if (p && typeof p.endAt === 'number') state.endAt = p.endAt;
      if (p && typeof p.remaining === 'number' && p.remaining > 0 && p.remaining <= DUR[state.mode]) state.remaining = p.remaining;
      if (p && p.records && typeof p.records === 'object') state.records = p.records;
    }
  } catch (e) {}
  if (!state.records) state.records = {};

  function pad(n) { return n < 10 ? '0' + n : String(n); }
  function dayKey(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {} }

  var ringEl = document.getElementById('ring');
  var timeEl = document.getElementById('time');
  var phaseEl = document.getElementById('phase');
  var toggleEl = document.getElementById('toggle');
  var toastEl = document.getElementById('toast');
  var toastTimer = null;

  function toast(text) {
    toastEl.textContent = text;
    toastEl.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 2600);
  }

  function remainingMs() {
    if (state.running) {
      var left = state.endAt - Date.now();
      return left > 0 ? left : 0;
    }
    return state.remaining;
  }
  function totalCount() {
    var sum = 0;
    Object.keys(state.records).forEach(function (k) { sum += Number(state.records[k]) || 0; });
    return sum;
  }
  function todayCount() { return Number(state.records[dayKey(new Date())]) || 0; }

  function render() {
    var left = remainingMs();
    var secs = Math.ceil(left / 1000);
    timeEl.textContent = pad(Math.floor(secs / 60)) + ':' + pad(secs % 60);
    var isFocus = state.mode === 'focus';
    phaseEl.textContent = state.running
      ? (isFocus ? '专注中，保持节奏' : '休息中，放松一下')
      : (left >= DUR[state.mode] ? '准备开始' : '已暂停');
    var color = isFocus ? '#4f46e5' : '#16a34a';
    var pct = 1 - left / DUR[state.mode];
    if (pct < 0) pct = 0;
    if (pct > 1) pct = 1;
    var deg = Math.round(pct * 360);
    ringEl.style.background = 'conic-gradient(' + color + ' 0deg, ' + color + ' ' + deg + 'deg, #e2e8f0 ' + deg + 'deg, #e2e8f0 360deg)';
    toggleEl.textContent = state.running ? '暂停' : (left < DUR[state.mode] ? '继续' : (isFocus ? '开始专注' : '开始休息'));
    toggleEl.className = 'btn primary' + (isFocus ? '' : ' break');
    document.getElementById('tabFocus').className = 'tab' + (isFocus ? ' on' : '');
    document.getElementById('tabBreak').className = 'tab' + (isFocus ? '' : ' on');
    document.getElementById('todayCount').textContent = String(todayCount());
    document.getElementById('totalCount').textContent = String(totalCount());
  }

  function setMode(mode) {
    state.mode = mode;
    state.remaining = DUR[mode];
    state.running = false;
    state.endAt = 0;
    save();
    render();
  }

  function complete() {
    var finished = state.mode;
    state.running = false;
    state.endAt = 0;
    if (finished === 'focus') {
      var key = dayKey(new Date());
      state.records[key] = (Number(state.records[key]) || 0) + 1;
      setMode('break');
      toast('专注完成 +1，进入 5 分钟休息');
    } else {
      setMode('focus');
      toast('休息结束，准备下一轮专注');
    }
  }

  function tick() {
    if (!state.running) { render(); return; }
    if (Date.now() >= state.endAt) { complete(); return; }
    render();
  }

  document.getElementById('toggle').addEventListener('click', function () {
    if (state.running) {
      state.remaining = Math.max(1000, state.endAt - Date.now());
      state.running = false;
      state.endAt = 0;
    } else {
      state.running = true;
      state.endAt = Date.now() + state.remaining;
    }
    save();
    render();
  });
  document.getElementById('reset').addEventListener('click', function () {
    setMode(state.mode);
    toast('已重置当前计时');
  });
  document.getElementById('skip').addEventListener('click', function () {
    var to = state.mode === 'focus' ? 'break' : 'focus';
    setMode(to);
    toast(to === 'focus' ? '已跳过休息，开始专注' : '已跳过专注，先休息一下');
  });
  document.getElementById('tabFocus').addEventListener('click', function () { setMode('focus'); });
  document.getElementById('tabBreak').addEventListener('click', function () { setMode('break'); });
  document.addEventListener('keydown', function (e) {
    if (e.key === ' ' && document.activeElement === document.body) {
      e.preventDefault();
      document.getElementById('toggle').click();
    }
  });

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && state.running && Date.now() >= state.endAt) complete();
  });

  if (state.running && !state.endAt) state.running = false;
  save();
  render();
  setInterval(tick, 250);
  if (state.running && Date.now() >= state.endAt) complete();
})();
</script>
</body>
</html>`
}
