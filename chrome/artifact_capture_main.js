// MAIN-world content script on https://claude.ai/artifact/* (document_start).
// Wraps window.fetch and records the JSON RESPONSES of the page's own
// /api/frame/db/<id>/call queries, so the extension can store a typed
// artifact's database rows. Only {collection, docs, nextCursor, status} leave
// this script. The request token and the request body are never recorded.
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

  const orig = window.fetch;
  window.fetch = function scryWrappedFetch(input, init) {
    const p = orig.apply(this, arguments);
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
