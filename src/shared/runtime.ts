// 注入到沙箱 iframe 的运行时：存储替身 + KV 上报 + 错误采集 + 自检探针
// 注意：该脚本会以字符串形式被拼进 srcdoc，必须保持为纯 JS、不可依赖外部模块
export const SANDBOX_RUNTIME = String.raw`
(function () {
  if (window.__ATOMS_RUNTIME__) return;
  window.__ATOMS_RUNTIME__ = true;

  // QA 在离屏沙箱运行：禁止页面脚本把焦点抢进隐藏 iframe，避免影响用户正在操作的预览
  var nativeFocus = window.HTMLElement && window.HTMLElement.prototype.focus;
  if (nativeFocus) {
    window.HTMLElement.prototype.focus = function () {
      if (qaRunning) return;
      return nativeFocus.apply(this, arguments);
    };
  }
  var nativeWindowFocus = window.focus;
  if (nativeWindowFocus) {
    window.focus = function () {
      if (qaRunning) return;
      return nativeWindowFocus.apply(window, arguments);
    };
  }

  var INIT = window.__ATOMS_INIT__ || {};
  var initData = (INIT && INIT.data) || {};
  var localData = {};
  Object.keys(initData).forEach(function (k) { localData[k] = String(initData[k]); });
  var sessionData = {};

  function post(type, payload) {
    try {
      parent.postMessage(Object.assign({ type: type, source: 'atoms-sandbox' }, payload || {}), '*');
    } catch (e) { /* noop */ }
  }

  var queue = [];
  var flushTimer = null;
  var totalWrites = 0;
  function pushOp(op) {
    totalWrites++;
    queue.push(op);
    if (!flushTimer) flushTimer = setTimeout(flush, 250);
  }
  function flush() {
    flushTimer = null;
    if (!queue.length) return;
    var ops = queue;
    queue = [];
    post('atoms-kv', { ops: ops });
  }

  function createStorage(kind) {
    var mem = kind === 'local' ? localData : sessionData;
    return {
      getItem: function (k) {
        k = String(k);
        return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null;
      },
      setItem: function (k, v) {
        k = String(k); v = String(v);
        mem[k] = v;
        if (kind === 'local') pushOp({ op: 'set', key: k, value: v });
      },
      removeItem: function (k) {
        k = String(k);
        if (Object.prototype.hasOwnProperty.call(mem, k)) {
          delete mem[k];
          if (kind === 'local') pushOp({ op: 'del', key: k });
        }
      },
      clear: function () {
        Object.keys(mem).forEach(function (k) { delete mem[k]; });
        if (kind === 'local') pushOp({ op: 'clear' });
      },
      key: function (i) {
        var keys = Object.keys(mem);
        return i >= 0 && i < keys.length ? keys[i] : null;
      },
      get length() { return Object.keys(mem).length; }
    };
  }

  var localShim = createStorage('local');
  var sessionShim = createStorage('session');
  try {
    Object.defineProperty(window, 'localStorage', { configurable: true, get: function () { return localShim; } });
  } catch (e) { /* noop */ }
  try {
    Object.defineProperty(window, 'sessionStorage', { configurable: true, get: function () { return sessionShim; } });
  } catch (e) { /* noop */ }
  try { window.__atomsStorage = localShim; } catch (e) { /* noop */ }

  // 对话框替身：必须在页面脚本之前接管，避免原生 alert/confirm/prompt 阻塞父页面与验收探针
  var probing = false;
  var pendingConfirm = null;

  function toastHost() {
    var host = document.getElementById('__atoms_toast_host__');
    if (!host) {
      host = document.createElement('div');
      host.id = '__atoms_toast_host__';
      host.setAttribute('role', 'status');
      host.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:2147483647;display:flex;flex-direction:column;gap:6px;align-items:center;pointer-events:none;width:max-content;max-width:92vw';
      (document.body || document.documentElement).appendChild(host);
    }
    return host;
  }
  function showToast(text, warn) {
    try {
      var host = toastHost();
      var item = document.createElement('div');
      item.textContent = String(text == null ? '' : text).slice(0, 240);
      item.style.cssText = 'box-sizing:border-box;max-width:92vw;padding:8px 12px;border-radius:10px;font:13px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;color:#fff;background:' + (warn ? '#b45309' : '#18181b') + ';box-shadow:0 8px 24px rgba(0,0,0,.24);opacity:0;transform:translateY(6px);transition:opacity .16s,transform .16s';
      host.appendChild(item);
      setTimeout(function () {
        item.style.opacity = '1';
        item.style.transform = 'translateY(0)';
      }, 0);
      setTimeout(function () {
        item.style.opacity = '0';
        setTimeout(function () {
          if (item.parentNode) item.parentNode.removeChild(item);
        }, 200);
      }, 3000);
    } catch (e) { /* noop */ }
  }

  window.alert = function (message) {
    if (probing || qaRunning) return;
    showToast(message);
  };
  window.confirm = function (message) {
    // 探针模式与 QA 模式都不弹原生框；QA 在隔离沙箱内，自动确认以覆盖删除/清空流程
    if (qaRunning) return true;
    if (probing) return false;
    var text = String(message == null ? '' : message);
    var now = Date.now();
    if (pendingConfirm && now - pendingConfirm.at <= 3000 && pendingConfirm.text === text) {
      pendingConfirm = null;
      return true;
    }
    pendingConfirm = { text: text, at: now };
    showToast(text + '（3 秒内再次点击即可确认）', true);
    return false;
  };
  window.prompt = function (message) {
    if (!probing) showToast('此应用不支持系统输入框，请直接在页面内输入' + (message ? ('：' + String(message)) : ''));
    return null;
  };

  var errors = [];
  function recordError(message, source) {
    var text = String(message == null ? 'unknown error' : message).slice(0, 300);
    errors.push(text);
    if (errors.length > 30) errors.shift();
    post('atoms-error', { message: text, source: String(source || '') });
  }
  window.addEventListener('error', function (e) {
    var where = e && e.filename ? ' @' + String(e.filename).split('/').pop() : '';
    recordError((e && e.message) || 'Script error' + where, 'error');
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    var reason = e && e.reason;
    recordError('Unhandled rejection: ' + (reason && reason.message ? reason.message : reason), 'promise');
  }, true);
  var nativeConsoleError = console.error ? console.error.bind(console) : function () {};
  console.error = function () {
    try {
      recordError(Array.prototype.slice.call(arguments).join(' '), 'console');
    } catch (e) { /* noop */ }
    nativeConsoleError.apply(null, arguments);
  };

  var mutationCount = 0;
  var lastMutationAt = 0;
  try {
    new MutationObserver(function (records) {
      mutationCount += records.length;
      lastMutationAt = Date.now();
      scheduleHeight();
    }).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
  } catch (e) { /* noop */ }

  var clickCount = 0;
  var lastClickAt = 0;
  function onUserAction() { clickCount++; lastClickAt = Date.now(); }
  document.addEventListener('click', onUserAction, true);
  document.addEventListener('input', onUserAction, true);
  document.addEventListener('change', onUserAction, true);

  // 内容高度上报：分享页据此让 iframe 自适应，父容器不裁切
  var heightTimer = null;
  var lastHeight = 0;
  function reportHeight() {
    heightTimer = null;
    try {
      var body = document.body;
      var de = document.documentElement;
      var bodyHeight = body ? Math.max(body.getBoundingClientRect().height, body.scrollHeight) : 0;
      var docHeight = de ? de.scrollHeight : 0;
      var height = Math.ceil(Math.max(bodyHeight, docHeight));
      if (height > 0 && Math.abs(height - lastHeight) > 1) {
        lastHeight = height;
        post('atoms-height', { height: height, width: window.innerWidth });
      }
    } catch (e) { /* noop */ }
  }
  function scheduleHeight() {
    if (heightTimer) return;
    heightTimer = setTimeout(reportHeight, 120);
  }
  window.addEventListener('resize', scheduleHeight);

  var pickMode = false;
  function selectorFor(el) {
    if (!el || el.nodeType !== 1) return '';
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && parts.length < 4) {
      var part = node.tagName.toLowerCase();
      if (node.id) { part += '#' + node.id; parts.unshift(part); break; }
      var cls = (node.className && typeof node.className === 'string') ? node.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
      if (cls) part += '.' + cls;
      var siblings = node.parentNode ? Array.prototype.filter.call(node.parentNode.children, function (c) { return c.tagName === node.tagName; }) : [];
      if (siblings.length > 1) part += ':nth-of-type(' + (Array.prototype.indexOf.call(siblings, node) + 1) + ')';
      parts.unshift(part);
      node = node.parentNode;
    }
    return parts.join(' > ');
  }
  document.addEventListener('mouseover', function (e) {
    if (!pickMode || !e.target || e.target.nodeType !== 1) return;
    e.target.style.outline = '2px solid #6366f1';
    e.target.style.outlineOffset = '-2px';
  }, true);
  document.addEventListener('mouseout', function (e) {
    if (!pickMode || !e.target || e.target.nodeType !== 1) return;
    e.target.style.outline = '';
    e.target.style.outlineOffset = '';
  }, true);
  document.addEventListener('click', function (e) {
    if (!pickMode) return;
    e.preventDefault();
    e.stopPropagation();
    pickMode = false;
    var el = e.target;
    post('atoms-picked', {
      selector: selectorFor(el),
      tag: el && el.tagName ? el.tagName.toLowerCase() : '',
      text: ((el && (el.textContent || el.value || '')) || '').trim().slice(0, 80),
      html: ((el && el.outerHTML) || '').slice(0, 1200)
    });
  }, true);

  function collectMetrics() {
    var body = document.body || document.documentElement;
    return {
      elements: document.querySelectorAll('*').length,
      textLength: (body.innerText || body.textContent || '').trim().length,
      errors: errors.slice(0),
      errorCount: errors.length,
      clicks: clickCount,
      mutations: mutationCount,
      keys: Object.keys(localData).length,
      writes: totalWrites,
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 2,
      width: window.innerWidth,
      title: document.title || '',
      interactiveClicks: clickCount > 0 && mutationCount > 0 ? Math.min(clickCount, 5) : 0
    };
  }

  function runProbe(id) {
    probing = true;
    var beforeMut = mutationCount;
    var beforeWrites = totalWrites;
    // 首/中/尾各取 3 个，覆盖数字键、功能键与提交键，避免只点前几个漏掉关键交互
    var all = Array.prototype.slice.call(
      document.querySelectorAll('button, [role="button"], input[type="submit"], .key, .day, .act')
    );
    var candidates = [];
    function take(list) {
      for (var i = 0; i < list.length && candidates.length < 10; i++) {
        if (candidates.indexOf(list[i]) === -1) candidates.push(list[i]);
      }
    }
    if (all.length <= 10) {
      candidates = all;
    } else {
      var mid = Math.floor(all.length / 2);
      take(all.slice(0, 3));
      take(all.slice(mid - 1, mid + 2));
      take(all.slice(-3));
    }
    var simulated = 0;
    candidates.forEach(function (el) {
      try { el.click(); simulated++; } catch (e) { /* noop */ }
    });
    setTimeout(function () {
      // 先恢复手动模式，避免采集异常把 probing 状态永久留在探针模式
      probing = false;
      var metrics = collectMetrics();
      metrics.simulatedClicks = simulated;
      metrics.simulatedChanges = mutationCount - beforeMut;
      metrics.simulatedWrites = totalWrites - beforeWrites;
      metrics.probedAt = Date.now();
      post('atoms-probe-result', { id: id, metrics: metrics });
      scheduleHeight();
    }, 500);
    // 兜底：页面脚本卡死时最多 8 秒后退出探针模式
    setTimeout(function () { probing = false; }, 8000);
  }

  // ---------- QA 测试阶段：扫描实际 DOM 功能，执行确定性用例 ----------
  var qaRunning = false;

  function qaText(el) {
    return String((el && (el.innerText || el.textContent)) || '').replace(/\s+/g, ' ').trim();
  }
  function qaHasAny(text, words) {
    for (var i = 0; i < words.length; i++) if (text.indexOf(words[i]) >= 0) return true;
    return false;
  }
  function qaVisible(el) {
    try {
      var r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    } catch (e) { return false; }
  }
  function qaButtons() {
    return Array.prototype.slice.call(document.querySelectorAll('button, [role="button"], input[type="submit"]'))
      .filter(function (el) { return qaVisible(el) && !el.disabled; });
  }
  function qaInputs() {
    return Array.prototype.slice.call(document.querySelectorAll('input, textarea'))
      .filter(function (el) { return qaVisible(el) && !el.disabled && el.type !== 'hidden'; });
  }
  function qaItemCount() {
    var nodes = document.querySelectorAll(
      'li, [data-item], .item, .task, .note, .record, .habit, .board .card, .col .card, #list > *, [id*="list"] > *, [id*="List"] > *, [class*="list"] > *, [class*="List"] > *, [id*="history"] > *, [class*="history"] > *'
    );
    var count = 0;
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var cls = el.className && typeof el.className === 'string' ? el.className : '';
      if (cls.indexOf('empty') >= 0) continue;
      var tag = el.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEMPLATE') continue;
      count++;
    }
    return count;
  }
  function qaPrimaryButton() {
    var words = ['添加', '新增', '保存', '提交', '开始', '生成', '记录', '确定', '创建', '加入', '购买', '发送'];
    var list = qaButtons();
    for (var i = 0; i < list.length; i++) if (qaHasAny(qaText(list[i]), words)) return list[i];
    return null;
  }
  function qaDestructiveButton(words) {
    var list = qaButtons();
    for (var i = 0; i < list.length; i++) if (qaHasAny(qaText(list[i]), words)) return list[i];
    return null;
  }
  function qaSetInput(el, value) {
    var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  var qaTicks = {};
  var qaTickSeq = 0;
  function resolveQaTick(id) {
    var fn = qaTicks[id];
    if (fn) {
      delete qaTicks[id];
      fn();
    }
  }
  // 隐藏 iframe 里 setTimeout 会被浏览器钳制到 ~1s；改为让父页面计时后回传 tick
  function qaWait(ms) {
    return new Promise(function (resolve) {
      var id = 'w' + (++qaTickSeq);
      qaTicks[id] = resolve;
      post('atoms-qa-wait', { id: id, ms: ms });
      setTimeout(function () { resolveQaTick(id); }, Math.max(1200, ms + 1000));
    });
  }
  function qaSnapshot() {
    return {
      mutations: mutationCount,
      writes: totalWrites,
      errors: errors.length,
      items: qaItemCount(),
      text: qaText(document.body)
    };
  }
  function qaChanged(before) {
    var after = qaSnapshot();
    return after.mutations > before.mutations || after.writes > before.writes ||
      after.items !== before.items || after.text !== before.text;
  }
  /** 只扫描应用自身代码与 DOM，排除注入的运行时/初始化脚本，避免把 QA 代码误判为页面功能 */
  function qaAppContent() {
    var code = '';
    var scripts = document.querySelectorAll('script');
    for (var i = 0; i < scripts.length; i++) {
      var t = scripts[i].textContent || '';
      if (t.indexOf('__ATOMS_RUNTIME__') >= 0 || t.indexOf('__ATOMS_INIT__') >= 0 || t.indexOf('atoms-qa-') >= 0) continue;
      code += t;
    }
    var bodyHtml = '';
    try { bodyHtml = document.body ? document.body.innerHTML : ''; } catch (e) { /* noop */ }
    return { code: code, html: bodyHtml };
  }

  function qaFeatures() {
    var primary = qaPrimaryButton();
    var buttons = qaButtons();
    var inputs = qaInputs();
    var secondary = buttons.filter(function (el) { return el !== primary && !qaHasAny(qaText(el), ['删除', '移除', '清空', '重置', '退出', '注销']); });
    var app = qaAppContent();
    var hint = app.code + ' ' + app.html;
    var itemCount = qaItemCount();
    var listLike =
      /<(ul|ol)[\s>]/i.test(app.html) ||
      /id="[^"]*(list|history)|class="[^"]*(list|history)/i.test(app.html);
    return {
      hasInput: inputs.length > 0,
      hasPrimary: Boolean(primary),
      hasSecondary: secondary.length > 0,
      // 删除/清空按钮可能只在有数据后出现；只按实际按钮或脚本能力判断，避免把需求文案当成功能
      hasDelete: Boolean(qaDestructiveButton(['删除', '移除'])) || /删除|移除/.test(app.code),
      hasClear: Boolean(qaDestructiveButton(['清空', '重置', '全部删除'])) || /清空|重置|全部删除/.test(app.code),
      hasList: itemCount > 0 || listLike || /card|grid/i.test(app.html),
      itemCount: itemCount,
      listLike: listLike,
      // 只在页面脚本确实使用存储或已经发生写入时才生成持久化用例
      hasStorage: /localStorage|sessionStorage/i.test(app.code) || totalWrites > 0 || Object.keys(localData).length > 0,
      // 只有存在输入框且页面声明了键盘/滑动交互时才生成键盘用例
      hasKeyboard: inputs.length > 0 && /keydown|keyup|keypress|ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Enter|touchstart|touchmove|swipe/i.test(hint),
      overflow: document.documentElement.scrollWidth > window.innerWidth + 2,
      width: window.innerWidth
    };
  }

  /** 破坏性用例前确保列表里有数据；没有则先走一次主流程创建 */
  function qaEnsureItem() {
    if (qaItemCount() > 0) return Promise.resolve(true);
    var primary = qaPrimaryButton();
    var input = qaInputs()[0];
    if (!primary) return Promise.resolve(false);
    var before = qaSnapshot();
    if (input) qaSetInput(input, 'QA 用例项');
    try { primary.click(); } catch (e) { /* noop */ }
    return qaWait(180).then(function () {
      return qaItemCount() > 0 || qaChanged(before);
    });
  }

  function qaRemoveLoop(left) {
    if (left <= 0) return Promise.resolve();
    var btn = qaDestructiveButton(['删除', '移除']);
    if (!btn) return Promise.resolve();
    try { btn.click(); } catch (e) { /* noop */ }
    return qaWait(140).then(function () { return qaRemoveLoop(left - 1); });
  }

  function qaRunCase(kind, spec) {
    var primary = qaPrimaryButton();
    var input = qaInputs()[0];
    var before = qaSnapshot();
    var result = { ok: false, evidence: '' };
    var ok = false;
    spec = spec || {};
    function done(ok, evidence) { result.ok = ok; result.evidence = evidence; return result; }
    try {
      if (kind === 'load') {
        var text = qaText(document.body);
        ok = document.querySelectorAll('*').length >= 5 && text.length >= 8 && errors.length === 0;
        return done(ok, ok ? '页面已加载，未捕获 JS 报错' : '元素/文本不足或存在 ' + errors.length + ' 条报错');
      }
      if (kind === 'viewport') {
        ok = document.documentElement.scrollWidth <= window.innerWidth + 2;
        return done(ok, ok ? window.innerWidth + 'px 下无横向溢出' : window.innerWidth + 'px 下出现横向溢出');
      }
      if (kind === 'main-flow') {
        if (!primary) return done(false, '未找到主要按钮');
        if (input) qaSetInput(input, 'QA 测试项');
        primary.click();
        return qaWait(180).then(function () {
          var changed = qaChanged(before);
          return done(changed, changed ? '点击「' + qaText(primary) + '」后有界面/数据变化' : '点击「' + qaText(primary) + '」后无变化');
        });
      }
      if (kind === 'buttons') {
        // 前序删除用例可能把带按钮的记录清空；先确保页面有可操作记录再测次要按钮
        return qaEnsureItem().then(function () {
          var list = qaButtons().filter(function (el) { return el !== primary && !qaHasAny(qaText(el), ['删除', '移除', '清空', '重置', '退出', '注销']); }).slice(0, 2);
          if (list.length === 0) return done(false, '未找到可测试的次要按钮');
          list.forEach(function (el) { try { el.click(); } catch (e) { /* noop */ } });
          return qaWait(160).then(function () {
            var newErrors = errors.length - before.errors;
            return done(newErrors === 0, newErrors === 0 ? '点击 ' + list.length + ' 个按钮未产生新报错' : '点击按钮产生 ' + newErrors + ' 条报错');
          });
        });
      }
      if (kind === 'invalid-input') {
        if (!input || !primary) return done(false, '缺少输入框或主要按钮');
        qaSetInput(input, '');
        primary.click();
        return qaWait(140).then(function () {
          var newErrors = errors.length - before.errors;
          return done(newErrors === 0, newErrors === 0 ? '空输入未导致崩溃' : '空输入产生 ' + newErrors + ' 条报错');
        });
      }
      if (kind === 'delete') {
        return qaEnsureItem().then(function (ready) {
          if (!ready) return done(false, '没有可删除的记录，且无法通过主流程创建');
          var del = qaDestructiveButton(['删除', '移除']);
          if (!del) return done(false, '执行中删除按钮消失');
          var itemsBefore = qaItemCount();
          var snap = qaSnapshot();
          try { del.click(); } catch (e) { /* noop */ }
          return qaWait(180).then(function () {
            var decreased = qaItemCount() < itemsBefore || qaChanged(snap);
            return done(decreased, decreased ? '删除后记录数 ' + itemsBefore + '→' + qaItemCount() : '删除后记录数未减少');
          });
        });
      }
      if (kind === 'clear') {
        return qaEnsureItem().then(function (ready) {
          if (!ready) return done(false, '列表为空，且无法通过主流程创建记录');
          var clear = qaDestructiveButton(['清空', '重置', '全部删除']);
          if (!clear) return done(false, '执行中清空按钮消失');
          var snap = qaSnapshot();
          try { clear.click(); } catch (e) { /* noop */ }
          return qaWait(200).then(function () {
            var empty = qaItemCount() === 0;
            return done(empty || qaChanged(snap), empty ? '清空后列表为空' : '清空后列表仍有 ' + qaItemCount() + ' 条');
          });
        });
      }
      if (kind === 'persistence') {
        var keys = Object.keys(localData).filter(function (k) { return String(localData[k] || '').length > 0; });
        var items = qaItemCount();
        var expectItems = Boolean(spec.expectItems);
        var readable = keys.length > 0 && (!expectItems || items > 0);
        var prefix = spec.reload ? '刷新后 ' : '';
        return done(
          readable,
          readable
            ? prefix + 'localStorage ' + keys.length + ' 个键可读回' + (items ? '，页面恢复 ' + items + ' 条记录' : '')
            : prefix + '未检测到可读回的数据' + (expectItems && keys.length ? '（页面未恢复列表）' : '')
        );
      }
      if (kind === 'double-click') {
        if (!primary) return done(false, '未找到主要按钮');
        primary.click();
        primary.click();
        return qaWait(180).then(function () {
          var newErrors = errors.length - before.errors;
          return done(newErrors === 0, newErrors === 0 ? '快速双击未产生报错' : '快速双击产生 ' + newErrors + ' 条报错');
        });
      }
      if (kind === 'keyboard') {
        if (!input) return done(false, '未找到输入框');
        qaSetInput(input, 'QA 键盘项');
        var snap = qaSnapshot();
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
        return qaWait(180).then(function () {
          var newErrors = errors.length - before.errors;
          var changed = qaChanged(snap);
          return done(newErrors === 0, newErrors === 0 ? (changed ? '回车后界面有变化' : '回车未产生报错') : '回车键产生 ' + newErrors + ' 条报错');
        });
      }
      if (kind === 'last-delete') {
        return qaEnsureItem().then(function (ready) {
          if (!ready) return done(false, '没有可删除的记录，且无法通过主流程创建');
          if (!qaDestructiveButton(['删除', '移除'])) return done(false, '执行中删除按钮消失');
          return qaRemoveLoop(10).then(function () {
            return done(qaItemCount() === 0, qaItemCount() === 0 ? '删除到最后一条后列表为空' : '仍有 ' + qaItemCount() + ' 条未删除');
          });
        });
      }
      return done(false, '未知用例类型');
    } catch (err) {
      return done(false, '执行异常：' + (err && err.message ? err.message : 'unknown'));
    }
  }

  function qaPostInventory(id) {
    post('atoms-qa-inventory', { id: id, features: qaFeatures() });
  }

  async function qaExecutePlan(id, specs) {
    if (qaRunning) return;
    qaRunning = true;
    var started = Date.now();
    var cases = [];
    var passedCount = 0;
    var failedCount = 0;
    try {
      for (var i = 0; i < specs.length; i++) {
        var spec = specs[i] || {};
        var caseStarted = Date.now();
        var outcome;
        try {
          outcome = await qaRunCase(spec.kind, spec);
        } catch (err) {
          outcome = { ok: false, evidence: '执行异常：' + (err && err.message ? err.message : 'unknown') };
        }
        if (outcome.ok) passedCount += 1; else failedCount += 1;
        cases.push({
          id: 'qa' + (i + 1),
          kind: spec.kind,
          title: spec.title || spec.kind,
          status: outcome.ok ? 'passed' : 'failed',
          evidence: outcome.evidence || '',
          durationMs: Date.now() - caseStarted
        });
        post('atoms-qa-progress', {
          id: id,
          index: i + 1,
          total: specs.length,
          passed: passedCount,
          failed: failedCount,
          title: spec.title || spec.kind,
          status: outcome.ok ? 'passed' : 'failed'
        });
        await qaWait(80);
      }
      post('atoms-qa-result', {
        id: id,
        cases: cases,
        durationMs: Date.now() - started,
        width: window.innerWidth
      });
    } finally {
      qaRunning = false;
    }
  }

  window.addEventListener('message', function (event) {
    var data = event.data || {};
    if (typeof data !== 'object') return;
    if (data.type === 'atoms-probe') { runProbe(data.id); return; }
    if (data.type === 'atoms-qa-start') { qaPostInventory(data.id); return; }
    if (data.type === 'atoms-qa-plan' && Array.isArray(data.cases)) { qaExecutePlan(data.id, data.cases); return; }
    if (data.type === 'atoms-qa-tick') { resolveQaTick(data.id); return; }
    if (data.type === 'atoms-pick-start') {
      pickMode = true;
      try { document.body.style.cursor = 'crosshair'; } catch (e) { /* noop */ }
      setTimeout(function () { pickMode = false; try { document.body.style.cursor = ''; } catch (e) { /* noop */ } }, 8000);
      return;
    }
    if (data.type === 'atoms-kv-sync' && data.data) {
      Object.keys(data.data).forEach(function (k) { localData[k] = String(data.data[k]); });
      return;
    }
    if (data.type === 'atoms-flush') { flush(); return; }
  });

  post('atoms-ready', { title: document.title || '' });
  window.addEventListener('load', function () {
    setTimeout(function () {
      post('atoms-rendered', collectMetrics());
      reportHeight();
    }, 60);
  });
  scheduleHeight();
})();
`
