// 注入到沙箱 iframe 的运行时：存储替身 + KV 上报 + 错误采集 + 自检探针
// 注意：该脚本会以字符串形式被拼进 srcdoc，必须保持为纯 JS、不可依赖外部模块
export const SANDBOX_RUNTIME = String.raw`
(function () {
  if (window.__ATOMS_RUNTIME__) return;
  window.__ATOMS_RUNTIME__ = true;

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
    }).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
  } catch (e) { /* noop */ }

  var clickCount = 0;
  var lastClickAt = 0;
  function onUserAction() { clickCount++; lastClickAt = Date.now(); }
  document.addEventListener('click', onUserAction, true);
  document.addEventListener('input', onUserAction, true);
  document.addEventListener('change', onUserAction, true);

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
      var metrics = collectMetrics();
      metrics.simulatedClicks = simulated;
      metrics.simulatedChanges = mutationCount - beforeMut;
      metrics.simulatedWrites = totalWrites - beforeWrites;
      metrics.probedAt = Date.now();
      post('atoms-probe-result', { id: id, metrics: metrics });
    }, 500);
  }

  window.addEventListener('message', function (event) {
    var data = event.data || {};
    if (typeof data !== 'object') return;
    if (data.type === 'atoms-probe') { runProbe(data.id); return; }
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
    setTimeout(function () { post('atoms-rendered', collectMetrics()); }, 60);
  });
})();
`
