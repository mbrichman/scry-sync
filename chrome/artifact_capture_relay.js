// ISOLATED-world relay on https://claude.ai/artifact/* (document_start). Learns
// the MAIN-world script's nonce from its first 'hello', then forwards only
// nonce-tagged 'db' messages to the background. Inert unless the background
// opened this tab for capture (it ignores messages for unregistered tabs).
(() => {
  const SRC = 'scry-artifact-capture';
  let nonce = null;
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== SRC) return;
    if (e.data.type === 'hello') { if (!nonce) nonce = e.data.nonce; return; }
    if (!nonce || e.data.nonce !== nonce || e.data.type !== 'db') return;
    try {
      chrome.runtime.sendMessage({
        action: 'artifactDbCapture', collection: e.data.collection, status: e.data.status,
        docs: e.data.docs, nextCursor: e.data.nextCursor,
      }).catch(() => {});
    } catch { /* extension context gone */ }
  });
  window.postMessage({ source: 'scry-artifact-relay', type: 'ready' }, window.location.origin);
})();
