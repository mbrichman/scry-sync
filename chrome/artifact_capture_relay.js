// ISOLATED-world relay on https://claude.ai/artifact/* (document_start). Learns
// the MAIN-world script's nonce from its first 'hello', then forwards only
// nonce-tagged 'db' messages to the background. Inert unless the background
// opened this tab for capture (it ignores messages for unregistered tabs).
// v3.7.0: also hosts the export driver (artifact_export_ui.js, loaded first in
// the same registration): on a background 'artifactExportRun' message it arms
// the MAIN script, drives Claude's Export menu and replies with the files.
(() => {
  const SRC = 'scry-artifact-capture';
  let nonce = null;
  let driver = null;
  const getDriver = () => {
    if (!driver && globalThis.ScryArtifactExport) {
      driver = globalThis.ScryArtifactExport.create({
        document,
        post: (m) => window.postMessage({ source: 'scry-artifact-relay', nonce, ...m }, window.location.origin),
      });
    }
    return driver;
  };
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== SRC) return;
    if (e.data.type === 'hello') { if (!nonce) nonce = e.data.nonce; return; }
    if (!nonce || e.data.nonce !== nonce) return;
    if (e.data.type === 'export_file' || e.data.type === 'export_name') { const d = getDriver(); if (d) d.onMainMessage(e.data); return; }
    if (e.data.type !== 'db') return;
    try {
      chrome.runtime.sendMessage({
        action: 'artifactDbCapture', collection: e.data.collection, status: e.data.status,
        docs: e.data.docs, nextCursor: e.data.nextCursor,
      }).catch(() => {});
    } catch { /* extension context gone */ }
  });
  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || msg.action !== 'artifactExportRun') return false;
      const d = getDriver();
      if (!d || !nonce) { sendResponse({ offered: [], captured: [], failed: [{ format: '*', reason: 'no_driver' }], clicks: [] }); return false; }
      d.run({ title: msg.title, timeoutMs: msg.timeoutMs, onlyFormats: msg.onlyFormats, loadMs: msg.loadMs })
        .then(sendResponse, () => sendResponse({ offered: [], captured: [], failed: [{ format: '*', reason: 'driver_error' }], clicks: [] }));
      return true;
    });
  } catch { /* not in an extension context (tests) */ }
  window.postMessage({ source: 'scry-artifact-relay', type: 'ready' }, window.location.origin);
})();
