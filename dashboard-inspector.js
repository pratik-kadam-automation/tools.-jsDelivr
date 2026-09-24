/* Dashboard Inspector — mobile bookmarklet
   Live data (WebSocket / Socket.IO / SSE / fetch / XHR JSON) + tap-to-trace
   a value on screen back to the message and JSON path it came from. */
(function () {
  if (window.__dbgInsp) { window.__dbgInsp.show(); return; }

  var MAXH = 20;                 // history per key
  var L = {};                    // key -> {n, hist:[{t,j,s,c,src}]}
  var OPEN = {};
  var paused = false, picking = false, timer = 0, total = 0, tab = 'live';
  var picked = null, watchObs = null, watchEl = null, watchLog = [], lastIn = null;
  var sockets = new Set(), cache = null, erudaReady = false;

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function now() {
    var d = new Date();
    return d.toLocaleTimeString([], { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
  }
  function short(v, n) {
    var s = v === undefined ? '(missing in latest message)' : (typeof v === 'string' ? v : JSON.stringify(v));
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  /* ---------------- UI ---------------- */
  var host = document.createElement('div');
  host.style.cssText = 'all:initial';
  var root = host.attachShadow({ mode: 'open' });
  root.innerHTML =
    '<style>' +
    '.p{position:fixed;left:0;right:0;bottom:0;height:55vh;z-index:2147483647;background:#1b2330;color:#d5dde8;' +
    'font:12px/1.45 -apple-system,Roboto,"Segoe UI",sans-serif;display:flex;flex-direction:column;' +
    'border-top:3px solid #f2a93b;box-shadow:0 -6px 20px rgba(0,0,0,.45)}' +
    '.p.top{top:0;bottom:auto;border-top:0;border-bottom:3px solid #f2a93b}' +
    '.p.min{height:auto}.p.min .tabs,.p.min .flt,.p.min .body{display:none}' +
    '.bar,.tabs{display:flex;flex-wrap:wrap;gap:4px;padding:5px;background:#232d3d}' +
    '.tabs{padding-top:0}' +
    'button{font:inherit;font-size:13px;background:#2e3a4d;color:#d5dde8;border:1px solid #3d4c63;border-radius:5px;padding:6px 9px}' +
    'button.on{background:#f2a93b;color:#1b2330;border-color:#f2a93b;font-weight:600}' +
    '.flt{margin:0 5px 4px;padding:7px;font-size:16px;background:#141a24;color:#d5dde8;border:1px solid #3d4c63;border-radius:5px}' +
    '.body{flex:1;overflow:auto;padding:2px 8px 8px;-webkit-overflow-scrolling:touch}' +
    'details{border-bottom:1px solid #2e3a4d;padding:2px 0}summary{padding:5px 0}' +
    '.k{color:#f2a93b;font-weight:600;word-break:break-all}.m{color:#8a98ad;font-size:11px}' +
    '.val{color:#5fd4e8;font-weight:700}.warn{color:#ff8a65;margin:3px 0}.ok{color:#8bd98b}' +
    'pre{white-space:pre-wrap;word-break:break-all;margin:4px 0;color:#c6e3ff;font:11.5px/1.4 ui-monospace,Menlo,Consolas,monospace}' +
    '.row{padding:7px 0;border-bottom:1px solid #2e3a4d}.hr{padding:3px 0;border-bottom:1px dotted #2e3a4d;word-break:break-all;font-family:ui-monospace,Menlo,monospace;font-size:11px}' +
    '.st{padding:3px 8px;background:#141a24;color:#8a98ad;font-size:11px}' +
    '.sec{padding:6px 0;border-bottom:1px solid #3d4c63}.acts{display:flex;flex-wrap:wrap;gap:4px;margin:5px 0}' +
    '.hl{position:fixed;pointer-events:none;border:2px solid #ff3dcb;background:rgba(255,61,203,.15);z-index:2147483646;display:none}' +
    'h4{margin:8px 0 3px;font-size:12px;color:#8a98ad;font-weight:600}' +
    '</style>' +
    '<div class="hl"></div>' +
    '<div class="p">' +
    '<div class="bar">' +
    '<button data-a="pick">🎯 Pick value</button><button data-a="tools">🛠 Tools</button>' +
    '<button data-a="pause">⏸ Pause</button><button data-a="reconnect">🔄 Resend</button>' +
    '<button data-a="clear">🗑</button><button data-a="copyall">📋 All</button>' +
    '<button data-a="flip">⇅</button><button data-a="min">▁</button><button data-a="close">✕</button>' +
    '</div>' +
    '<div class="tabs"><button data-t="live">Live data</button><button data-t="pick">Picked</button><button data-t="watch">Watch</button></div>' +
    '<input class="flt" placeholder="Filter by topic, tag or value">' +
    '<div class="body"></div><div class="st"></div></div>';
  document.documentElement.appendChild(host);

  var P = root.querySelector('.p'), body = root.querySelector('.body'), st = root.querySelector('.st'),
      flt = root.querySelector('.flt'), hl = root.querySelector('.hl');
  flt.oninput = function () { render(); };

  function status(msg) { st.textContent = msg; status.until = Date.now() + 2500; clearTimeout(status.t); status.t = setTimeout(function () { render(); }, 2600); }
  function schedule() { if (!timer) timer = setTimeout(render, 300); }
  function setMin(on) { P.classList.toggle('min', on); }

  /* ---------------- capture ---------------- */
  function add(key, j, s, src, dir) {
    if (paused) return;
    key = key.slice(0, 120);
    var e = L[key] || (L[key] = { n: 0, hist: [] });
    var t = now();
    if (s.length > 20000) s = s.slice(0, 20000) + '\n… (truncated for display)';
    e.n++; total++;
    e.hist.unshift({ t: t, j: j, s: s, c: short(s.replace(/\s+/g, ' '), 180), src: src });
    if (e.hist.length > MAXH) e.hist.pop();
    if (dir === 'IN') lastIn = { k: key, t: t };
    schedule();
  }

  function sub(o) {
    if (!o || typeof o !== 'object') return '';
    var v = o.id != null ? o.id : (o.topic != null ? o.topic : null);
    return v != null && typeof v !== 'object' ? ':' + String(v).slice(0, 60) : '';
  }
  function keyOf(j) {
    if (Array.isArray(j) && typeof j[0] === 'string') {
      return { k: j[0] + sub(j[1]), j: j.length === 2 ? j[1] : j.slice(1) };
    }
    if (j && typeof j === 'object' && !Array.isArray(j)) {
      var t = j.topic != null ? j.topic : (j.type != null ? j.type : (j.event != null ? j.event : j.name));
      var dv = j.deviceId != null ? j.deviceId : (j.device_id != null ? j.device_id : (j.gateway_id != null ? j.gateway_id : (j.machineId != null ? j.machineId : j.id)));
      var base = t != null && typeof t !== 'object' ? String(t) : 'msg';
      var dev = dv != null && typeof dv !== 'object' && dv !== t ? ' @ ' + dv : '';
      return { k: base + dev, j: j };
    }
    return { k: 'msg', j: j };
  }

  function one(prefix, src, v) {
    if (typeof v !== 'string') return;
    var body = v;
    if (/^\d+[\[{]/.test(v)) {                        // Socket.IO / Engine.IO framing: 42[...]
      try { JSON.parse(v); } catch (e) { body = v.replace(/^\d+/, ''); }
    } else if (/^\d*$/.test(v) && /socket\.io/.test(src)) {
      return;                                         // ping/pong/connect control packets
    }
    var j;
    try { j = JSON.parse(body); } catch (e) { add(prefix + ' text', null, v, src, 'IN'); return; }
    var r = keyOf(j);
    add(prefix + ' ' + r.k, r.j, JSON.stringify(r.j, null, 2) || String(r.j), src, prefix === 'WS-OUT' ? 'OUT' : 'IN');
  }

  function ingest(prefix, src, raw) {
    if (paused) return;
    if (typeof raw !== 'string') {
      add(prefix + ' [binary]', null, '[' + (raw && (raw.byteLength || raw.size) || '?') + ' bytes binary frame]', src, 'IN');
      return;
    }
    (raw.indexOf('\x1e') >= 0 ? raw.split('\x1e') : [raw]).forEach(function (p) { one(prefix, src, p); });
  }

  // Engine.IO v3 polling: "97:42[...]2:40"
  function eio3(t) {
    var out = [], i = 0;
    while (i < t.length) {
      var c = t.indexOf(':', i); if (c < 0) break;
      var n = parseInt(t.slice(i, c), 10); if (isNaN(n)) break;
      out.push(t.substr(c + 1, n)); i = c + 1 + n;
    }
    return out.length ? out : [t];
  }

  function pathOf(u) { try { return new URL(u, location.href).pathname; } catch (e) { return String(u); } }

  function httpIn(url, text) {
    if (paused || typeof text !== 'string' || text.length > 800000) return;
    url = String(url || '');
    if (/socket\.io/.test(url)) {
      (/^\d+:/.test(text) ? eio3(text) : text.split('\x1e')).forEach(function (p) { one('WS', 'poll ' + pathOf(url), p); });
      return;
    }
    var j; try { j = JSON.parse(text); } catch (e) { return; }
    add('HTTP ' + pathOf(url), j, JSON.stringify(j, null, 2), url, 'IN');
  }

  // incoming WebSocket + SSE messages (works for sockets opened before this ran)
  var D = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data');
  Object.defineProperty(MessageEvent.prototype, 'data', {
    configurable: true,
    get: function () {
      var v = D.get.call(this), tg = this.target;
      if (!this.__dbg) {
        if (window.WebSocket && tg instanceof WebSocket) { this.__dbg = 1; sockets.add(tg); ingest('WS', tg.url, v); }
        else if (window.EventSource && tg instanceof EventSource) { this.__dbg = 1; ingest('SSE', tg.url, v); }
      }
      return v;
    }
  });
  var wsSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function (v) { sockets.add(this); ingest('WS-OUT', this.url, v); return wsSend.apply(this, arguments); };

  if (window.fetch) {
    var of = window.fetch;
    window.fetch = function (input) {
      var p = of.apply(this, arguments);
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      p.then(function (res) {
        try {
          var ct = res.headers.get('content-type') || '';
          if (/json|text\/plain/.test(ct) || /socket\.io/.test(url)) res.clone().text().then(function (t) { httpIn(url, t); }, function () {});
        } catch (e) {}
      }, function () {});
      return p;
    };
  }
  var xo = XMLHttpRequest.prototype.open, xs = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__dbgu = u; return xo.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () {
    var x = this;
    x.addEventListener('load', function () {
      try {
        if (x.responseType === '' || x.responseType === 'text') httpIn(x.__dbgu, x.responseText);
        else if (x.responseType === 'json') httpIn(x.__dbgu, JSON.stringify(x.response));
      } catch (e) {}
    });
    return xs.apply(this, arguments);
  };

  /* ---------------- pick & trace ---------------- */
  function textOf(el) {
    if (!el) return '';
    var t = /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) ? el.value : (el.innerText !== undefined ? el.innerText : el.textContent);
    return String(t || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  }
  function descr(el) {
    var s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    var c = el.getAttribute('class');
    if (c) s += '.' + c.trim().split(/\s+/).slice(0, 2).join('.');
    return s;
  }
  function cssPath(el) {
    var a = [];
    for (var e = el; e && e.nodeType === 1 && a.length < 5 && e !== document.body; e = e.parentElement) a.unshift(descr(e));
    return a.join(' > ');
  }
  function idTokens(el) {
    var out = [];
    for (var e = el, d = 0; e && e.nodeType === 1 && d < 10; e = e.parentElement, d++) {
      for (var i = 0; i < e.attributes.length; i++) {
        var a = e.attributes[i];
        if ((a.name === 'id' || /id$/.test(a.name)) && a.value.length >= 3 && a.value.length <= 60) out.push(a.value);
      }
    }
    return out;
  }

  function numsIn(text) {
    var r = [], m, re = /-?\d+(?:\.\d+)?/g;
    text = text.replace(/(\d),(?=\d{3}\b)/g, '$1');
    while ((m = re.exec(text)) && r.length < 6) {
      var dec = (m[0].split('.')[1] || '').length;
      r.push({ v: parseFloat(m[0]), tol: 0.5 * Math.pow(10, -dec) + 1e-9 });
    }
    return r;
  }
  function walk(o, pa, cb, d, cnt) {
    if (cnt.n > 60000 || d > 14 || o === null || o === undefined) return;
    if (typeof o === 'object') {
      for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) walk(o[k], pa.concat(k), cb, d + 1, cnt);
    } else { cnt.n++; cb(pa, o); }
  }
  function pstr(pa) {
    return pa.map(function (k) { return /^\d+$/.test(k) ? '[' + k + ']' : '.' + k; }).join('').replace(/^\./, '') || '(whole message)';
  }
  function getPath(o, pa) {
    for (var i = 0; i < pa.length; i++) { if (o === null || typeof o !== 'object') return undefined; o = o[pa[i]]; }
    return o;
  }
  function score(v, nums, low) {
    var n = typeof v === 'number' ? v : (typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v) ? parseFloat(v) : NaN);
    if (!isNaN(n)) {
      for (var i = 0; i < nums.length; i++) {
        var d = Math.abs(n - nums[i].v);
        if (d < 1e-9) return 0;
        if (d <= nums[i].tol) return 1;
      }
      return -1;
    }
    if (typeof v === 'boolean') return low === String(v) ? 0 : -1;
    if (typeof v === 'string' && low.length >= 2) {
      var s = v.toLowerCase().trim();
      if (s === low) return 0;
      if (low.length >= 3 && s.length >= 3 && s.length <= 200 && (s.indexOf(low) >= 0 || low.indexOf(s) >= 0)) return 2;
    }
    return -1;
  }
  function findMatches(text) {
    var nums = numsIn(text), low = text.toLowerCase(), out = [], seen = {}, cnt = { n: 0 };
    if (!nums.length && low.length < 2) return out;
    Object.keys(L).forEach(function (k) {
      var e = L[k];
      e.hist.forEach(function (x, hi) {
        if (x.j === null || x.j === undefined) return;
        walk(x.j, [], function (pa, v) {
          var id = k + '|' + pa.join('\u0001');
          if (seen[id]) return;
          var sc = score(v, nums, low);
          if (sc < 0) return;
          seen[id] = 1;
          out.push({ k: k, pa: pa, v: v, hi: hi, t: x.t, sc: sc, latest: hi ? getPath(e.hist[0].j, pa) : v });
        }, 0, cnt);
      });
    });
    out.sort(function (a, b) { return a.sc - b.sc || a.hi - b.hi; });
    return out.slice(0, 40);
  }

  function setPicked(el) {
    picked = el; cache = null; placeHl();
  }
  function placeHl() {
    if (!picked || !picked.isConnected) { hl.style.display = 'none'; return; }
    var r = picked.getBoundingClientRect();
    hl.style.cssText = 'display:block;left:' + (r.left - 2) + 'px;top:' + (r.top - 2) + 'px;width:' + r.width + 'px;height:' + r.height + 'px';
  }
  setInterval(placeHl, 400);

  document.addEventListener('click', function (e) {
    if (!picking) return;
    var path = e.composedPath ? e.composedPath() : [];
    if (path.indexOf(host) >= 0) return;
    if (e.target.closest && e.target.closest('#eruda')) return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    picking = false; setPicked(e.target); setMin(false); tab = 'pick'; render();
  }, true);

  function startWatch() {
    if (!picked) return;
    if (watchObs) watchObs.disconnect();
    watchEl = picked; watchLog = [];
    var last = textOf(watchEl);
    watchLog.unshift({ t: now(), s: last, note: 'watch started', li: lastIn });
    watchObs = new MutationObserver(function () {
      var s = textOf(watchEl);
      if (s !== last) {
        last = s;
        watchLog.unshift({ t: now(), s: s, li: lastIn });
        if (watchLog.length > 150) watchLog.pop();
        schedule();
      }
    });
    watchObs.observe(watchEl, { subtree: true, childList: true, characterData: true, attributes: true });
    tab = 'watch'; render();
  }

  /* ---------------- Eruda (Elements, Console, Network, Resources, Sources) ---------------- */
  function eruda(cb) {
    if (window.eruda && erudaReady) { cb(); return; }
    if (window.eruda) { try { window.eruda.init(); } catch (e) {} erudaReady = true; cb(); return; }
    status('Loading tools…');
    var s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/eruda';
    s.onload = function () { window.eruda.init(); erudaReady = true; cb(); };
    s.onerror = function () { status('Tools failed to load. Check internet or the page blocks external scripts.'); };
    document.body.appendChild(s);
  }

  function copy(t) {
    function fb() {
      var ta = document.createElement('textarea');
      ta.value = t; ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.appendChild(ta); ta.focus(); ta.select();
      try { document.execCommand('copy'); status('Copied'); } catch (e) { status('Copy failed'); }
      ta.remove();
    }
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(t).then(function () { status('Copied'); }, fb);
    else fb();
  }

  /* ---------------- actions ---------------- */
  function act(a) {
    if (a === 'pick' || a === 'repick') { picking = !picking || a === 'repick'; if (picking) { setMin(true); status('Tap any value on the dashboard…'); } render(); }
    else if (a === 'tools') eruda(function () { window.eruda.show(); setMin(true); });
    else if (a === 'elements') { if (picked) eruda(function () { try { window.eruda.show('elements'); var el = window.eruda.get('elements'); if (el && el.select) el.select(picked); } catch (e) {} setMin(true); }); }
    else if (a === 'pause') { paused = !paused; render(); }
    else if (a === 'clear') { L = {}; OPEN = {}; total = 0; cache = null; render(); }
    else if (a === 'reconnect') {
      if (!sockets.size) { status('No socket seen yet. Wait for one update, then try again.'); return; }
      sockets.forEach(function (s) { try { s.close(); } catch (e) {} });
      sockets.clear(); cache = null;
      status('Socket closed. Socket.IO dashboards reconnect and resend all current values.');
    }
    else if (a === 'copyall') {
      var o = {}; Object.keys(L).forEach(function (k) { o[k] = L[k].hist[0].j !== null ? L[k].hist[0].j : L[k].hist[0].s; });
      copy(JSON.stringify(o, null, 2));
    }
    else if (a === 'flip') P.classList.toggle('top');
    else if (a === 'min') setMin(!P.classList.contains('min'));
    else if (a === 'close') { picking = false; host.style.display = 'none'; hl.style.display = 'none'; }
    else if (a === 'parent') { if (picked && picked.parentElement && picked.parentElement !== document.body) setPicked(picked.parentElement); render(); }
    else if (a === 'watch') startWatch();
    else if (a === 'unwatch') { if (watchObs) watchObs.disconnect(); watchObs = null; watchEl = null; render(); }
    else if (a === 'research') { cache = null; render(); }
  }

  root.addEventListener('click', function (e) {
    var t = e.target;
    var sm = t.closest('summary');
    if (sm) { OPEN[sm.parentNode.dataset.k] = !sm.parentNode.open; return; }
    var b = t.closest('[data-a]'); if (b) { act(b.dataset.a); return; }
    var tb = t.closest('[data-t]'); if (tb) { tab = tb.dataset.t; render(); return; }
    var c = t.closest('[data-copy]'); if (c) { var h = L[c.dataset.copy]; if (h) copy(h.hist[0].s); return; }
    var f = t.closest('[data-go]'); if (f) { flt.value = f.dataset.go; OPEN[f.dataset.go] = true; tab = 'live'; render(); }
  });

  /* ---------------- render ---------------- */
  function renderLive() {
    var q = flt.value.trim().toLowerCase(), h = '';
    Object.keys(L).sort().forEach(function (k) {
      var e = L[k], x = e.hist[0];
      if (q && (k + ' ' + x.s).toLowerCase().indexOf(q) < 0) return;
      h += '<details data-k="' + esc(k) + '"' + (OPEN[k] ? ' open' : '') + '><summary><span class="k">' + esc(k) +
        '</span> <span class="m">' + x.t + ' · ' + e.n + ' msgs</span></summary>' +
        '<div class="acts"><button data-copy="' + esc(k) + '">Copy JSON</button></div>' +
        '<div class="m">' + esc(short(x.src || '', 100)) + '</div><pre>' + esc(x.s) + '</pre>';
      if (e.hist.length > 1) {
        var hk = k + ' #hist';
        h += '<details data-k="' + esc(hk) + '"' + (OPEN[hk] ? ' open' : '') + '><summary class="m">Last ' + e.hist.length + ' values</summary>' +
          e.hist.map(function (y) { return '<div class="hr"><span class="m">' + y.t + '</span> ' + esc(y.c) + '</div>'; }).join('') + '</details>';
      }
      h += '</details>';
    });
    return h || '<p class="m">Waiting for data. If the dashboard only sends changes, tap 🔄 Resend to make it send every current value again.</p>';
  }

  function renderPick() {
    if (!picked) return '<p class="m">Tap 🎯 Pick value, then tap the number or text on the dashboard you want to check.</p>';
    var text = textOf(picked), h = '<div class="sec">';
    if (!picked.isConnected) h += '<div class="warn">The dashboard redrew this element. Tap 🎯 Re-pick.</div>';
    h += '<div>Shows: <span class="val">' + esc(text || '(no text — tap ⬆ Parent)') + '</span></div>' +
      '<div class="m">' + esc(cssPath(picked)) + '</div>' +
      '<div class="acts"><button data-a="parent">⬆ Parent</button><button data-a="watch">👁 Watch changes</button>' +
      '<button data-a="elements">🛠 Open in Elements</button><button data-a="repick">🎯 Re-pick</button><button data-a="research">↻ Search again</button></div>';
    var at = [];
    for (var i = 0; i < picked.attributes.length && at.length < 12; i++) at.push(picked.attributes[i].name + '="' + short(picked.attributes[i].value, 60) + '"');
    if (at.length) h += '<details data-k="#attrs"' + (OPEN['#attrs'] ? ' open' : '') + '><summary class="m">Attributes</summary><pre>' + esc(at.join('\n')) + '</pre></details>';
    h += '</div>';

    if (!cache || cache.el !== picked || cache.text !== text || Date.now() - cache.at > 2000) {
      cache = { el: picked, text: text, at: Date.now(), res: text ? findMatches(text) : [] };
    }
    var res = cache.res;
    h += '<h4>Where this value is in the data</h4>';
    if (!text) h += '<p class="m">No text on this element.</p>';
    else if (!res.length) {
      h += '<div class="warn">Not found in captured data.</div><p class="m">Possible reasons: the value was sent before the inspector started (tap 🔄 Resend), ' +
        'the widget converts or scales it (unit, ×10, decimals), or it comes from a source not captured here.</p>';
    } else {
      res.forEach(function (m) {
        h += '<div class="row" data-go="' + esc(m.k) + '"><span class="k">' + esc(m.k) + '</span><br>' +
          esc(pstr(m.pa)) + ' = <span class="val">' + esc(short(m.v, 80)) + '</span>' +
          (m.sc === 1 ? ' <span class="m">(rounded on screen)</span>' : '') + (m.sc === 2 ? ' <span class="m">(partial text)</span>' : '') +
          ' <span class="m">' + m.t + '</span>';
        if (m.hi > 0) h += '<div class="warn">⚠ Screen shows an older value (' + m.hi + ' messages ago). Latest value here: ' + esc(short(m.latest, 80)) + '</div>';
        else h += '<div class="ok">✓ matches the latest message</div>';
        h += '</div>';
      });
    }
    var tok = idTokens(picked), linked = Object.keys(L).filter(function (k) {
      return tok.some(function (t) { return k.indexOf(t) >= 0; });
    });
    if (linked.length) {
      h += '<h4>Messages linked to this widget by id</h4>' + linked.map(function (k) {
        return '<div class="row" data-go="' + esc(k) + '"><span class="k">' + esc(k) + '</span><br><span class="m">' + esc(L[k].hist[0].c) + '</span></div>';
      }).join('');
    }
    return h;
  }

  function renderWatch() {
    if (!watchEl) return '<p class="m">Pick a value, then tap 👁 Watch changes to log every time it changes on screen.</p>';
    var h = '<div class="sec"><span class="m">' + esc(cssPath(watchEl)) + '</span>' +
      '<div class="acts"><button data-a="unwatch">Stop watching</button></div>' +
      (watchEl.isConnected ? '' : '<div class="warn">The dashboard replaced this element, so changes are no longer seen. Re-pick and watch again.</div>') + '</div>';
    h += watchLog.map(function (w) {
      return '<div class="row"><span class="m">' + w.t + '</span> <span class="val">' + esc(w.s || '(empty)') + '</span>' +
        (w.note ? ' <span class="m">' + w.note + '</span>' : '') +
        (w.li ? '<br><span class="m">last data in: ' + esc(w.li.k) + ' at ' + w.li.t + '</span>' : '') + '</div>';
    }).join('');
    return h;
  }

  function render() {
    timer = 0;
    root.querySelectorAll('[data-t]').forEach(function (b) { b.classList.toggle('on', b.dataset.t === tab); });
    root.querySelector('[data-a="pick"]').classList.toggle('on', picking);
    root.querySelector('[data-a="pause"]').classList.toggle('on', paused);
    root.querySelector('[data-a="pause"]').textContent = paused ? '▶ Resume' : '⏸ Pause';
    flt.style.display = tab === 'live' ? '' : 'none';
    body.innerHTML = tab === 'live' ? renderLive() : tab === 'pick' ? renderPick() : renderWatch();
    if (Date.now() < (status.until || 0)) return;
    st.textContent = (picking ? 'Tap a value on the dashboard… | ' : '') + (paused ? 'PAUSED | ' : '') +
      total + ' msgs, ' + Object.keys(L).length + ' topics, ' + sockets.size + ' sockets';
  }

  window.__dbgInsp = { show: function () { host.style.display = ''; setMin(false); render(); } };
  render();
})();
