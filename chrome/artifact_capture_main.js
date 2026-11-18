// MAIN-world content script on https://claude.ai/artifact/* (document_start).
// Wraps window.fetch and records the JSON RESPONSES of the page's own
// /api/frame/db/<id>/call queries, so the extension can store a typed
// artifact's database rows. Only {collection, docs, nextCursor, status} leave
// this script. The request token and the request body are never recorded.
// Registered dynamically by the background ONLY while a collector capture tab is
// open (chrome.scripting.registerContentScripts), so it is absent otherwise.
// EXPORT capture (v3.7.0): while the isolated relay has ARMED this script (a
// nonce'd message), it also (a) wraps URL.createObjectURL to read Blobs the
// page builds for Claude's own Export menu, (b) intercepts clicks on
// <a download> (suppressing the real download, reading the suggested filename),
// and (c) notes fetch responses with Content-Disposition: attachment. File
// bytes leave only as base64 to the relay. Disarming restores every wrapper.
// The nonce only filters accidental noise; it is NOT authentication (any script
// in this world can read it).
(() => {
  if (window.__scryArtifactCapture) return;
  window.__scryArtifactCapture = true;
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(12))).map((b) => b.toString(16).padStart(2, '0')).join('');
  const SRC = 'scry-artifact-capture';
  const DB_CALL = /^\/api\/frame\/db\/[^/]+\/call\/?$/;
  const post = (msg) => window.postMessage({ source: SRC, nonce, ...msg }, window.location.origin);
  const hello = () => post({ type: 'hello' });
  window.addEventListener('message', (e) => {
    if (e.source === window && e.data && e.data.source === 'scry-artifact-relay' && e.data.type === 'ready') hello();
  });
  hello();

  function dbCallInfo(input) {
    try {
      const raw = typeof input === 'string' ? input : (input && input.url) || String(input);
      const u = new URL(raw, window.location.href);
      return DB_CALL.test(u.pathname) ? u : null;
    } catch { return null; }
  }
  function collectionOf(init, input) {
    // Body shape {token, verb, collection, limit}: read ONLY verb + collection.
    try {
      const body = init && typeof init.body === 'string' ? init.body : null;
      if (body) { const j = JSON.parse(body); return { verb: j.verb, collection: j.collection }; }
    } catch { /* fall through */ }
    return null;
  }

  // ---------- export capture (armed only on request) ----------
  const EXPORT_MAX_BYTES = 25 * 1024 * 1024;
  let armed = false;
  let seq = 0;
  const saved = {};
  const blobIds = new Map();      // blob: URL -> id
  const handled = new WeakSet();  // anchors already intercepted
  const b64 = (buf) => {
    const u8 = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const postFile = (id, via, contentType, buf, filename) => {
    const size = buf ? buf.byteLength : 0;
    post({ type: 'export_file', id, via, content_type: contentType || '', size, filename: filename || null,
      too_large: size > EXPORT_MAX_BYTES, b64: buf && size <= EXPORT_MAX_BYTES ? b64(buf) : null });
  };
  const isBlob = (o) => o && typeof o === 'object' && typeof o.arrayBuffer === 'function' && typeof o.size === 'number';
  const parseDisposition = (cd) => {
    const m = /filename\*?=(?:UTF-8'')?"?([^";]+)/i.exec(cd || '');
    try { return m ? decodeURIComponent(m[1]) : null; } catch { return m ? m[1] : null; }
  };
  const isDownloadAnchor = (el) => {
    try { return Boolean(el && el.tagName === 'A' && el.hasAttribute('download')); } catch { return false; }
  };
  function interceptAnchor(a) {
    // Returns true when the click was taken over (the real download suppressed).
    if (!armed || !isDownloadAnchor(a) || handled.has(a)) return false;
    handled.add(a);
    const name = a.getAttribute('download') || null;
    const href = String(a.href || '');
    if (blobIds.has(href)) { post({ type: 'export_name', id: blobIds.get(href), filename: name }); return true; }
    try {
      const u = new URL(href, window.location.href);
      if (u.origin === window.location.origin) {
        const id = ++seq;
        saved.fetch.call(window, u.href, { credentials: 'include' }).then(async (r) => {
          if (r.ok) postFile(id, 'anchor', r.headers.get('content-type'), await r.arrayBuffer(), name || parseDisposition(r.headers.get('content-disposition')));
        }).catch(() => {});
      }
    } catch { /* unparseable href */ }
    return true;
  }
  function arm() {
    if (armed) return;
    armed = true;
    saved.createObjectURL = URL.createObjectURL;
    URL.createObjectURL = function scryCreateObjectURL(obj) {
      const url = saved.createObjectURL.apply(this, arguments);
      try {
        if (armed && isBlob(obj)) {
          const id = ++seq;
          blobIds.set(url, id);
          obj.arrayBuffer().then((buf) => postFile(id, 'blob', obj.type, buf, null)).catch(() => {});
        }
      } catch { /* never break the page */ }
      return url;
    };
    const A = window.HTMLAnchorElement && window.HTMLAnchorElement.prototype;
    if (A) {
      saved.click = A.click;
      A.click = function scryAnchorClick() {
        try { if (interceptAnchor(this)) return undefined; } catch { /* fall through */ }
        return saved.click.apply(this, arguments);
      };
    }
    const ET = window.EventTarget && window.EventTarget.prototype;
    if (ET) {
      saved.dispatchEvent = ET.dispatchEvent;
      ET.dispatchEvent = function scryDispatch(ev) {
        try { if (ev && ev.type === 'click' && interceptAnchor(this)) return true; } catch { /* fall through */ }
        return saved.dispatchEvent.apply(this, arguments);
      };
    }
    saved.listener = (e) => {
      try {
        const a = e.target && e.target.closest ? e.target.closest('a[download]') : null;
        if (a && interceptAnchor(a)) { e.preventDefault(); e.stopImmediatePropagation(); }
      } catch { /* ignore */ }
    };
    if (window.addEventListener) window.addEventListener('click', saved.listener, true);
  }
  function disarm() {
    if (!armed) return;
    armed = false;
    if (saved.createObjectURL) URL.createObjectURL = saved.createObjectURL;
    const A = window.HTMLAnchorElement && window.HTMLAnchorElement.prototype;
    if (A && saved.click) A.click = saved.click;
    const ET = window.EventTarget && window.EventTarget.prototype;
    if (ET && saved.dispatchEvent) ET.dispatchEvent = saved.dispatchEvent;
    if (saved.listener && window.removeEventListener) window.removeEventListener('click', saved.listener, true);
    blobIds.clear();
  }
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.source !== 'scry-artifact-relay' || d.nonce !== nonce) return;
    if (d.type === 'arm') arm();
    else if (d.type === 'disarm') disarm();
  });
  saved.fetch = window.fetch;

  const orig = window.fetch;
  window.fetch = function scryWrappedFetch(input, init) {
    const p = orig.apply(this, arguments);
    try {
      if (armed) {
        p.then((resp) => {
          const cd = resp && resp.headers && resp.headers.get && resp.headers.get('content-disposition');
          if (cd && /attachment/i.test(cd)) {
            const id = ++seq;
            resp.clone().arrayBuffer().then((buf) => postFile(id, 'fetch', resp.headers.get('content-type'), buf, parseDisposition(cd))).catch(() => {});
          }
        }).catch(() => {});
      }
    } catch { /* never break the page's fetch */ }
    try {
      if (dbCallInfo(input)) {
        const info = collectionOf(init, input);
        if (info && info.verb === 'query' && typeof info.collection === 'string') {
          p.then((resp) => {
            const status = resp.status;
            if (!resp.ok) { post({ type: 'db', collection: info.collection, status, docs: [], nextCursor: null }); return; }
            resp.clone().json().then((j) => {
              post({ type: 'db', collection: info.collection, status, docs: Array.isArray(j && j.docs) ? j.docs : [], nextCursor: (j && j.nextCursor) || null });
            }).catch(() => {});
          }).catch(() => {});
        }
      }
    } catch { /* never break the page's fetch */ }
    return p;
  };
})();
