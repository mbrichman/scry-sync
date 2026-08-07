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

// --- background/service-worker enumeration (no content-script relay) ---
//
// browse.js's loadOrgId/loadConversations enumerate via a message relay to an
// open claude.ai tab's content script (sendMessageToClaudeTab). The background
// service worker that drives continuous sync has no guaranteed tab to relay
// through, so these fetch claude.ai directly — the same credentialed pattern
// fetchConversationBody already uses below, which works from ANY extension
// context (popup, background, dashboard) because host_permissions grants
// https://claude.ai/*; no open tab is required for that fetch to carry the
// browser's claude.ai session cookies.

// Last-detected org id (chrome.storage.sync 'organizationId'), written by the
// popup/dashboard's tab-based auto-detect. Continuous sync reads it rather
// than re-running auto-detect, since it has no tab to detect from.
function readOrgIdFromStorage() {
  return new Promise((resolve) =>
    chrome.storage.sync.get(['organizationId'], (r) => resolve(r.organizationId || null)));
}

// List all of the account's conversations. Mirrors content.js's
// fetchAllConversations, minus the tab-relay requirement.
async function listClaudeConversations(orgId) {
  const url = `https://claude.ai/api/organizations/${orgId}/chat_conversations`;
  const resp = await fetch(url, { credentials: 'include', headers: { 'Accept': 'application/json' } });
  if (!resp.ok) throw new Error(`fetch conversation list ${resp.status}`);
  return resp.json();
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

// Ask Scry which of the enumerated conversations still need (re-)syncing.
// `items` may be plain id strings OR conversation objects {uuid, updated_at}.
// When updated_at is available we send it as source_updated_ats so Scry can
// detect STALENESS — a conversation that grew at the source since last sync.
// Without it, a continued conversation reads as 'complete' and never re-syncs
// (its stored copy is internally consistent, just not current). Gets back
// { to_resync: [...], summary: {...}, extra } — to_resync = missing +
// incomplete + stale.
async function reconcileWithScry(scry, items) {
  const url = `${scry.url.replace(/\/+$/, '')}/api/conversations/reconcile`;
  const headers = { 'Content-Type': 'application/json' };
  if (scry.token) headers['Authorization'] = `Bearer ${scry.token}`;

  const sourceIds = [];
  const sourceUpdatedAts = {};
  for (const it of (items || [])) {
    if (it && typeof it === 'object') {
      if (!it.uuid) continue;
      sourceIds.push(it.uuid);
      if (it.updated_at) sourceUpdatedAts[it.uuid] = it.updated_at;
    } else if (it) {
      sourceIds.push(it);
    }
  }

  const body = { source_type: 'claude', source_ids: sourceIds };
  if (Object.keys(sourceUpdatedAts).length) body.source_updated_ats = sourceUpdatedAts;

  const resp = await fetch(url, {
    method: 'POST', headers, body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`reconcile HTTP ${resp.status}`);
  return resp.json();
}

// Ask Scry which conversations are CLEARED for deletion from the source. Each
// item is { source_id, live_body } where live_body is the conversation's tree
// just fetched LIVE from Claude. Scry clears one only if capture is complete AND
// the live body still matches the stored archive message-for-message — the
// fresh, content-level proof the other checks (Scry-internal / trusts-archive /
// stale snapshot) can't give. Server-authoritative: we delete ONLY what this
// returns as deletable. Returns { summary, results:[{source_id, deletable, ...}] }.
async function verifyDeletableWithScry(scry, items) {
  const url = `${scry.url.replace(/\/+$/, '')}/api/conversations/verify-deletable`;
  const headers = { 'Content-Type': 'application/json' };
  if (scry.token) headers['Authorization'] = `Bearer ${scry.token}`;
  const resp = await fetch(url, {
    method: 'POST', headers,
    body: JSON.stringify({ source_type: 'claude', conversations: items }),
  });
  if (!resp.ok) throw new Error(`verify-deletable HTTP ${resp.status}`);
  return resp.json();
}

// Partition a verify-deletable report into cleared ids + blocked verdicts. Pure
// so it can be unit-tested; the caller deletes ONLY `cleared`.
function partitionDeletableReport(report) {
  const cleared = [];
  const blocked = [];
  for (const r of (report && report.results) || []) {
    if (r.deletable) {
      cleared.push(r.source_id);
    } else {
      blocked.push({ source_id: r.source_id, title: r.title, reasons: r.reasons || [] });
    }
  }
  return { cleared, blocked };
}

// Delete a conversation from claude.ai (credentialed; IRREVERSIBLE at the
// source). Only ever called for ids Scry cleared as deletable in the SAME run.
// Returns { ok, status }.
async function deleteClaudeConversation(orgId, conversationUuid) {
  const url = `https://claude.ai/api/organizations/${orgId}/chat_conversations/${conversationUuid}`;
  const resp = await fetch(url, {
    method: 'DELETE', credentials: 'include', headers: { 'Accept': 'application/json' },
  });
  return { ok: resp.ok, status: resp.status };
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
  module.exports = { conversationBodyIsStub, partitionDeletableReport, reconcileWithScry };
}
