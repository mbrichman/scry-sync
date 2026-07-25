// Scry client — the imperative side of syncing (fetch + POST), shared by the
// popup ("sync current chat") and the dashboard ("sync all / last N days").
// Pure transforms live in scry_sync.js; conversation/branch/image helpers in
// utils.js. All three are loaded as globals before this file.

// --- settings + sync-state (chrome.storage.local) ---

function loadScrySettings() {
  return new Promise((resolve) =>
    chrome.storage.local.get(['scry'], (r) => resolve(r.scry || {})));
}

function getScrySyncedMap() {
  return new Promise((resolve) =>
    chrome.storage.local.get(['scrySyncedMap'], (r) => resolve(r.scrySyncedMap || {})));
}

function setScrySyncedMap(map) {
  return new Promise((resolve) => chrome.storage.local.set({ scrySyncedMap: map }, resolve));
}

// --- helpers ---

function scryOriginPattern(url) {
  try {
    return new URL(url).origin + '/*';
  } catch {
    return null;
  }
}

// Ensure the extension holds host permission for the configured Scry origin
// (granted via optional_host_permissions). Resolves true/false.
function ensureScryPermission(url) {
  const pattern = scryOriginPattern(url);
  if (!pattern) return Promise.resolve(false);
  return new Promise((resolve) =>
    chrome.permissions.request({ origins: [pattern] }, resolve));
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// True if a fetched body is a soft-empty STUB: a 200 with no chat_messages for a
// conversation that actually had content. Claude's body endpoint occasionally
// returns the conversation object with an empty chat_messages array (under
// parallel load / tree-render flakiness on older conversations). A genuinely
// empty new chat has no title AND created_at == updated_at (no message was ever
// written); anything titled, or with updated_at != created_at, must have had at
// least one message — so an empty chat_messages there is a stub, not real.
// Mirrors Scry's _archive_is_empty_stub so both sides gate identically.
function conversationBodyIsStub(data) {
  if (!data || typeof data !== 'object') return false;
  if (Array.isArray(data.chat_messages) && data.chat_messages.length > 0) return false;
  const name = (data.name || '').trim();
  const created = data.created_at;
  const updated = data.updated_at;
  return Boolean(name) || (created != null && updated != null && created !== updated);
}

// Fetch a conversation's full body from claude.ai (credentialed; works from an
// extension page because host_permissions includes claude.ai). Retries a
// soft-empty stub a few times, then THROWS rather than returning it — so the
// caller never archives an empty shell and reconcile keeps it in to_resync.
async function fetchConversationBody(orgId, conversationUuid) {
  const url = `https://claude.ai/api/organizations/${orgId}/chat_conversations/${conversationUuid}?tree=True&rendering_mode=messages&render_all_tools=true`;
  let last = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 600 * attempt));
    const resp = await fetch(url, { credentials: 'include', headers: { 'Accept': 'application/json' } });
    if (!resp.ok) throw new Error(`fetch conversation ${resp.status}`);
    last = await resp.json();
    if (!conversationBodyIsStub(last)) return last;
  }
  throw new Error(`fetch conversation ${conversationUuid}: empty body (stub) after retries`);
}

// Fetch the image bytes for a conversation's current branch, keyed by file_uuid
// as base64 data URLs (Scry can't fetch claude.ai's authenticated preview URLs).
async function fetchConversationImageDataUrls(convData) {
  const map = {};
  for (const message of getCurrentBranch(convData)) {
    for (const file of getMessageImageFiles(message)) {
      if (!file.file_uuid || map[file.file_uuid]) continue;
      const url = imageAssetUrl(file);
      if (!url) continue;
      try {
        const resp = await fetch(url, { credentials: 'include' });
        if (!resp.ok) { console.warn(`Scry sync: image fetch ${resp.status} for ${url}`); continue; }
        map[file.file_uuid] = await blobToDataUrl(await resp.blob());
      } catch (e) {
        console.warn('Scry sync: image fetch error', url, e);
      }
    }
  }
  return map;
}

// Fetch the ORIGINAL bytes of every uploaded file across the whole conversation
// tree (images, PDFs, scanned docs, binaries) as base64 data URLs. These are the
// bytes the Anthropic export omits; only the extension's authenticated session
// can retrieve them. Returned shape matches Scry's ingest `files[]` contract.
async function fetchConversationFileBlobs(convData) {
  const out = [];
  for (const f of collectAllFiles(convData)) {
    try {
      const resp = await fetch(f.url, { credentials: 'include' });
      if (!resp.ok) { console.warn(`Scry sync: file fetch ${resp.status} for ${f.url}`); continue; }
      out.push({
        file_uuid: f.file_uuid,
        file_name: f.file_name,
        file_type: f.file_type,
        file_variant: f.file_variant,
        data: await blobToDataUrl(await resp.blob()),
      });
    } catch (e) {
      console.warn('Scry sync: file fetch error', f.url, e);
    }
  }
  return out;
}

// Ask Scry which of the enumerated conversation ids still need (re-)syncing.
// Sends the full id set; gets back { to_resync: [...], summary: {...}, extra }.
// This is the completeness gate: it catches both conversations Scry never got
// (missing) and ones it got but couldn't fully capture (incomplete).
async function reconcileWithScry(scry, sourceIds) {
  const url = `${scry.url.replace(/\/+$/, '')}/api/conversations/reconcile`;
  const headers = { 'Content-Type': 'application/json' };
  if (scry.token) headers['Authorization'] = `Bearer ${scry.token}`;
  const resp = await fetch(url, {
    method: 'POST', headers,
    body: JSON.stringify({ source_type: 'claude', source_ids: sourceIds }),
  });
  if (!resp.ok) throw new Error(`reconcile HTTP ${resp.status}`);
  return resp.json();
}

// POST a built payload to Scry's ingest endpoint.
async function postToScry(scry, payload) {
  const ingestUrl = `${scry.url.replace(/\/+$/, '')}/api/conversations/ingest`;
  const headers = { 'Content-Type': 'application/json' };
  if (scry.token) headers['Authorization'] = `Bearer ${scry.token}`;
  const resp = await fetch(ingestUrl, { method: 'POST', headers, body: JSON.stringify(payload) });
  let body = null;
  try { body = await resp.json(); } catch { /* non-JSON error page */ }
  return { ok: resp.ok, status: resp.status, body };
}

// Sync one conversation end-to-end: fetch body → fetch images → build payload →
// POST. Returns { status, updatedAt }. Throws on any failure.
async function syncOneConversation(orgId, conversationUuid, scry) {
  const data = await fetchConversationBody(orgId, conversationUuid);
  const images = await fetchConversationImageDataUrls(data);
  const fileBlobs = await fetchConversationFileBlobs(data);
  const payload = buildIngestPayload(data, images, fileBlobs);
  // Retry transient failures — the Flask dev server can drop a large image-heavy
  // POST ("Failed to fetch"), and 5xx is worth another try; 4xx/auth is not.
  const resp = await withRetry(
    () => postToScry(scry, payload),
    { retries: 2, delayMs: 500, shouldRetry: ({ threw, result }) => threw || (result && result.status >= 500) }
  );
  if (!resp.ok) throw new Error(`ingest HTTP ${resp.status}`);
  if (!resp.body || !resp.body.success) {
    throw new Error((resp.body && resp.body.error) || 'ingest rejected');
  }
  return { status: resp.body.status, updatedAt: data.updated_at };
}

// In Node (vitest), expose the pure helpers for testing.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { conversationBodyIsStub };
}
