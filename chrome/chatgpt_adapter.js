// ChatGPT source adapter (read-only proof of concept).
//
// This is the ChatGPT counterpart to the Claude-specific layer that lives in
// content.js + utils.js. It proves the data path end-to-end — enumerate, fetch a
// body, flatten the branch, render markdown/JSON — WITHOUT touching the Scry
// sync pipeline or backend. Nothing here posts to Scry.
//
// Split, like the Claude side, into:
//   - PURE transforms (Node/vitest-testable): tree flatten, text extraction,
//     normalization, markdown/JSON rendering. No fetch, no chrome.*.
//   - IMPURE browser fetchers: talk to chatgpt.com's backend-api. These reference
//     the browser `fetch`; they are never called from Node tests.
//
// Two things differ from the Claude adapter and are worth knowing up front:
//   1. Auth. Claude uses cookies only. ChatGPT needs a bearer token pulled from
//      https://chatgpt.com/api/auth/session, sent as `Authorization: Bearer …`.
//   2. Shape. Claude returns chat_messages[] + current_leaf_message_uuid. ChatGPT
//      returns a `mapping` object (node-id -> {message, parent, children}) with
//      `current_node` as the leaf. getChatGptBranch walks it the same way
//      getCurrentBranch walks Claude's flat tree.

// ===== Constants =====

const CHATGPT_ORIGIN = 'https://chatgpt.com';
const CHATGPT_API = 'https://chatgpt.com/backend-api';

// ===== PURE: branch reconstruction =====

// Reconstruct the visible message branch from a ChatGPT conversation body.
// Walks parent pointers from `current_node` (the leaf) up to the root, then
// reverses so the result reads oldest-first. Returns the raw node.message
// objects (unfiltered) — filtering to displayable turns is a separate step so
// it can be tested and tuned independently.
function getChatGptBranch(data) {
  const mapping = data && data.mapping;
  if (!mapping || typeof mapping !== 'object') return [];

  // Prefer the explicit leaf pointer. Fall back to the deepest leaf node (no
  // children) if current_node is missing/dangling, mirroring the Claude
  // adapter's "no usable leaf -> best effort" fallback.
  let leaf = data.current_node;
  if (!leaf || !mapping[leaf]) {
    leaf = findDeepestLeaf(mapping);
  }
  if (!leaf || !mapping[leaf]) return [];

  const branch = [];
  let nodeId = leaf;
  const guard = new Set(); // cycle guard — malformed mappings shouldn't hang
  while (nodeId && mapping[nodeId] && !guard.has(nodeId)) {
    guard.add(nodeId);
    const node = mapping[nodeId];
    if (node.message) branch.unshift(node.message);
    nodeId = node.parent;
  }
  return branch;
}

// Fallback leaf finder: the childless node with the longest path back to a root.
// Only used when current_node is unusable.
function findDeepestLeaf(mapping) {
  const depthTo = (id) => {
    let d = 0;
    let cur = id;
    const seen = new Set();
    while (cur && mapping[cur] && !seen.has(cur)) {
      seen.add(cur);
      d++;
      cur = mapping[cur].parent;
    }
    return d;
  };
  let best = null;
  let bestDepth = -1;
  for (const [id, node] of Object.entries(mapping)) {
    const children = (node && node.children) || [];
    if (children.length === 0) {
      const d = depthTo(id);
      if (d > bestDepth) { bestDepth = d; best = id; }
    }
  }
  return best;
}

// ===== PURE: message classification + text extraction =====

// Does a tool `execution_output` message carry rendered images (code-interpreter
// plots)? Those live in metadata.aggregate_result.messages[].image_url.
function _hasExecutionImages(message) {
  const msgs = message && message.metadata && message.metadata.aggregate_result
    && message.metadata.aggregate_result.messages;
  return Array.isArray(msgs) && msgs.some((m) => m && m.message_type === 'image');
}

// Does a multimodal_text message contain an image part?
function _hasMultimodalImage(message) {
  const parts = message && message.content && message.content.parts;
  return Array.isArray(parts) && parts.some((p) =>
    p && typeof p === 'object' && p.content_type === 'image_asset_pointer');
}

// Port of chatgpt-exporter's shouldSkipMessageInExport (pionxzh/chatgpt-exporter,
// src/api.ts) plus the system/context skips it applies during the branch walk.
// This is the authority on what NEVER belongs in an export:
//   - no content
//   - recipient !== 'all'  → the message is addressed to a tool, not the user
//     (assistant calling python/browser/dalle). THE key filter my first pass missed.
//   - thoughts / reasoning_recap → hidden chain-of-thought
//   - is_visually_hidden_from_conversation → internal system scaffolding
//   - system role, model_editable_context, user_editable_context → prompts/memory
//   - tool role: only kept when it actually renders an image to the user
function shouldSkipChatGptMessage(message) {
  if (!message || !message.content || !message.author) return true;

  // Addressed to a tool, not shown to the user.
  if (message.recipient && message.recipient !== 'all') return true;

  const type = message.content.content_type;
  if (type === 'thoughts' || type === 'reasoning_recap') return true;

  const meta = message.metadata || {};
  if (meta.is_visually_hidden_from_conversation === true) return true;

  const role = message.author.role;
  if (role === 'system') return true;
  if (type === 'model_editable_context' || type === 'user_editable_context') return true;

  if (role === 'tool') {
    if (message.author.name === 'file_search') return true;
    if (!_hasExecutionImages(message) && !_hasMultimodalImage(message)) return true;
  }

  return false;
}

// Should this message appear in an export? Applies the skip rules above, then
// drops anything that renders to empty text (a bare zero-weight/blank turn).
function isDisplayableChatGptMessage(message) {
  if (shouldSkipChatGptMessage(message)) return false;
  if (message.weight === 0) return false; // superseded/pruned turn
  return chatGptMessageText(message).trim().length > 0;
}

// Render one image pointer to a markdown image. When `imageMap` has a fetched
// data URL for the pointer, that is inlined (so the image actually displays);
// otherwise the raw pointer is left as a placeholder.
function _renderImage(pointer, imageMap) {
  const src = (imageMap && imageMap[pointer]) || pointer || 'image';
  return `![image](${src})`;
}

// Extract displayable text from a ChatGPT message's content, across the content
// types the web app produces. Pass `imageMap` ({ pointer -> data URL }, from
// fetchChatGptImageDataUrls) to inline fetched image bytes; omit it to leave
// images as `sediment://` placeholders.
function chatGptMessageText(message, imageMap = {}) {
  const content = message && message.content;
  if (!content) return '';

  const type = content.content_type;

  // text / multimodal_text: `parts` is an array of strings and/or asset objects.
  if (Array.isArray(content.parts)) {
    return content.parts.map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object') {
        if (part.content_type === 'image_asset_pointer' || part.asset_pointer) {
          return _renderImage(part.asset_pointer, imageMap);
        }
        if (part.content_type === 'audio_transcription' && typeof part.text === 'string') {
          return `[audio] ${part.text}`;
        }
        if (typeof part.text === 'string') return part.text;
      }
      return '';
    }).filter(Boolean).join('\n');
  }

  // code (plugin/tool source): wrap fenced.
  if (type === 'code' && typeof content.text === 'string') {
    const lang = content.language && content.language !== 'unknown' ? content.language : '';
    return '```' + lang + '\n' + content.text + '\n```';
  }

  // execution_output: prefer rendered images (code-interpreter plots) over text.
  if (type === 'execution_output') {
    if (_hasExecutionImages(message)) {
      return message.metadata.aggregate_result.messages
        .filter((m) => m && m.message_type === 'image')
        .map((m) => _renderImage(m.image_url, imageMap))
        .join('\n');
    }
    if (typeof content.text === 'string') return content.text;
  }

  // tether_browsing_display / other result-bearing types.
  if (typeof content.result === 'string') return content.result;

  // tether_quote and any other text-bearing type.
  if (typeof content.text === 'string') return content.text;

  return '';
}

// Collect every unique image asset pointer in the visible branch that would be
// rendered: multimodal image parts (`image_asset_pointer`) and code-interpreter
// output images (`aggregate_result.messages[].image_url`). These are the pointers
// fetchChatGptImageDataUrls resolves to bytes. Pure/testable.
//
// By default only the visible branch is walked (what the exporters render).
// Pass { wholeTree: true } to walk EVERY node — the Scry push uses that so the
// bytes travel with the verbatim, unpruned archive Scry keeps: an image on a
// regenerated-away sibling is still part of the record Scry holds.
function collectChatGptImagePointers(data, { wholeTree = false } = {}) {
  const out = [];
  const seen = new Set();
  const push = (p) => { if (p && !seen.has(p)) { seen.add(p); out.push(p); } };

  const messages = wholeTree
    ? Object.values((data && data.mapping) || {}).map((n) => n && n.message).filter(Boolean)
    : getChatGptBranch(data);
  for (const message of messages) {
    const content = message && message.content;
    if (content && content.content_type === 'multimodal_text' && Array.isArray(content.parts)) {
      for (const part of content.parts) {
        if (part && typeof part === 'object' && part.content_type === 'image_asset_pointer') {
          push(part.asset_pointer);
        }
      }
    }
    if (_hasExecutionImages(message)) {
      for (const m of message.metadata.aggregate_result.messages) {
        if (m && m.message_type === 'image') push(m.image_url);
      }
    }
  }
  return out;
}

// ===== PURE: normalization =====

// ChatGPT timestamps are epoch SECONDS (float). Claude uses ISO strings. This
// PoC normalizes to ISO so downstream rendering is source-agnostic. Accepts a
// number (epoch seconds) or an already-ISO string; returns null if unparseable.
function chatGptTimeToIso(t) {
  if (t == null) return null;
  if (typeof t === 'number') return new Date(t * 1000).toISOString();
  if (typeof t === 'string') {
    // Numeric string -> epoch seconds; otherwise assume already a date string.
    const asNum = Number(t);
    if (!Number.isNaN(asNum) && t.trim() !== '') return new Date(asNum * 1000).toISOString();
    const d = new Date(t);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

// Determine the conversation's model slug. ChatGPT rarely sets a top-level
// default_model_slug, so — like chatgpt-exporter — fall back to the first
// message metadata that carries one.
function extractChatGptModelSlug(data) {
  if (data && data.default_model_slug) return data.default_model_slug;
  const mapping = (data && data.mapping) || {};
  for (const node of Object.values(mapping)) {
    const slug = node && node.message && node.message.metadata && node.message.metadata.model_slug;
    if (slug) return slug;
  }
  return null;
}

// Reduce a raw ChatGPT conversation body to a source-agnostic shape. This is the
// adapter's contract: whatever the source, we produce { id, title, created_at,
// updated_at, model, messages: [{ role, text, model, created_at }] }. That shape
// is what a future buildIngestPayload-style step (or the exporter below) consumes.
function normalizeChatGptConversation(data, imageMap = {}) {
  const branch = getChatGptBranch(data).filter(isDisplayableChatGptMessage);
  const convModel = extractChatGptModelSlug(data);

  const messages = branch.map((m) => ({
    role: m.author && m.author.role ? m.author.role : 'unknown',
    text: chatGptMessageText(m, imageMap),
    model: (m.metadata && m.metadata.model_slug) || convModel || null,
    created_at: chatGptTimeToIso(m.create_time),
  }));

  return {
    id: data.conversation_id || data.id || null,
    title: (data.title || '').trim() || 'Untitled conversation',
    created_at: chatGptTimeToIso(data.create_time),
    updated_at: chatGptTimeToIso(data.update_time),
    model: convModel,
    messages,
  };
}

// ===== PURE: rendering =====

const CHATGPT_ROLE_LABELS = {
  user: 'You',
  assistant: 'ChatGPT',
  tool: 'Tool',
  unknown: 'Message',
};

// Render a normalized (or raw) conversation to Markdown. Accepts either a raw
// ChatGPT body or an already-normalized object (duck-typed on `messages`). When
// given a raw body, pass `imageMap` to inline fetched image bytes; an
// already-normalized object has its image sources baked in already.
function convertChatGptToMarkdown(dataOrNormalized, imageMap = {}) {
  const conv = Array.isArray(dataOrNormalized && dataOrNormalized.messages)
    ? dataOrNormalized
    : normalizeChatGptConversation(dataOrNormalized, imageMap);

  const lines = [];
  lines.push(`# ${conv.title}`);
  lines.push('');
  const metaBits = [];
  if (conv.model) metaBits.push(`**Model:** ${conv.model}`);
  if (conv.created_at) metaBits.push(`**Created:** ${conv.created_at}`);
  if (conv.updated_at) metaBits.push(`**Updated:** ${conv.updated_at}`);
  if (conv.id) metaBits.push(`**Source:** ChatGPT (\`${conv.id}\`)`);
  if (metaBits.length) {
    lines.push(metaBits.join('  \n'));
    lines.push('');
  }
  lines.push('---');
  lines.push('');

  for (const msg of conv.messages) {
    const label = CHATGPT_ROLE_LABELS[msg.role] || CHATGPT_ROLE_LABELS.unknown;
    lines.push(`## ${label}`);
    lines.push('');
    lines.push(msg.text);
    lines.push('');
  }

  return lines.join('\n').trimEnd() + '\n';
}

// The normalized JSON export — pretty-printed, source-agnostic shape. Pass
// `imageMap` to inline fetched image bytes into message text.
function chatGptConversationToJson(data, imageMap = {}) {
  return JSON.stringify(normalizeChatGptConversation(data, imageMap), null, 2);
}

// Filesystem-safe slug from a title, for export filenames.
function slugifyChatGptTitle(title) {
  const base = (title || 'chatgpt-conversation')
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60);
  return base || 'chatgpt-conversation';
}

// ===== IMPURE: browser fetchers (chatgpt.com backend-api) =====
// These are only exercised in the browser (the PoC page). They reference the
// global `fetch`, so they are intentionally excluded from the Node export block.

// Thrown on HTTP 429, carrying the server's Retry-After (ms). Mirrors
// chatgpt-exporter's RateLimitError so callers can back off instead of failing.
class ChatGptRateLimitError extends Error {
  constructor(retryAfterHeader) {
    super('ChatGPT rate limit (429) — wait and retry.');
    this.name = 'ChatGptRateLimitError';
    const secs = retryAfterHeader != null ? parseInt(retryAfterHeader, 10) : NaN;
    this.retryAfterMs = Number.isFinite(secs) && secs > 0 ? secs * 1000 : 30000;
  }
}

// Pull the session access token. Every backend-api read needs it as a bearer.
// Relies on the browser's chatgpt.com session cookies (host_permissions grants
// credentialed cross-origin fetch from the extension page).
async function getChatGptAccessToken() {
  const resp = await fetch(`${CHATGPT_ORIGIN}/api/auth/session`, {
    credentials: 'include',
    headers: { 'Accept': 'application/json' },
  });
  if (!resp.ok) throw new Error(`auth/session ${resp.status} — are you signed in to chatgpt.com?`);
  const data = await resp.json();
  if (!data || !data.accessToken) throw new Error('No access token in session — sign in to chatgpt.com first.');
  return data.accessToken;
}

// ChatGPT's edge expects the bearer under BOTH Authorization and X-Authorization
// (chatgpt-exporter sends both). accountId, when known, targets a team workspace
// via Chatgpt-Account-Id. Note: this PoC page runs off-origin, so it cannot read
// the `_account` cookie to auto-detect a team workspace — team support is a
// follow-up (see docs/TODO.md); personal accounts work with token alone.
function chatGptAuthHeaders(token, accountId) {
  const h = {
    'Accept': 'application/json',
    'Authorization': `Bearer ${token}`,
    'X-Authorization': `Bearer ${token}`,
  };
  if (accountId) h['Chatgpt-Account-Id'] = accountId;
  return h;
}

// Credentialed backend-api GET with 429 awareness.
async function chatGptApiGet(url, token, accountId) {
  const resp = await fetch(url, { credentials: 'include', headers: chatGptAuthHeaders(token, accountId) });
  if (resp.status === 429) throw new ChatGptRateLimitError(resp.headers.get('Retry-After'));
  if (!resp.ok) throw new Error(`${url}: ${resp.status}`);
  return resp.json();
}

// One page of the conversation list.
async function listChatGptConversations(token, { offset = 0, limit = 28, accountId = null } = {}) {
  const url = `${CHATGPT_API}/conversations?offset=${offset}&limit=${limit}`;
  return chatGptApiGet(url, token, accountId);
}

// Enumerate ALL conversations by paginating until exhausted. `onProgress(count)`
// is called after each page so the UI can show progress. A 429 is surfaced to the
// caller (with retryAfterMs) rather than silently retried.
async function listAllChatGptConversations(token, onProgress, accountId) {
  const limit = 100;
  let offset = 0;
  const all = [];
  for (;;) {
    const page = await listChatGptConversations(token, { offset, limit, accountId });
    const items = (page && page.items) || [];
    all.push(...items);
    if (onProgress) onProgress(all.length);
    const total = page && typeof page.total === 'number' ? page.total : null;
    if (items.length < limit || (total != null && all.length >= total)) break;
    offset += limit;
  }
  return all;
}

// Fetch one conversation's full body (the mapping tree).
async function fetchChatGptConversation(token, conversationId, accountId) {
  const url = `${CHATGPT_API}/conversation/${conversationId}`;
  return chatGptApiGet(url, token, accountId);
}

// ===== PURE: asset ids + the files[] record =====

// The id token after the pointer's scheme: `sediment://file_<hex>` -> file_<hex>,
// `file-service://file-<b62>` -> file-<b62>. MUST agree with Scry's
// extract_asset_id (db/services/chatgpt_media_resolver.py): that id is the
// file_uuid Scry stores the bytes under AND the key attach_download_urls links
// a message's image record to. Anchored after "://" on purpose — the scheme
// name "file-service" itself matches file[-_][A-Za-z0-9]+ and must not win.
const _ASSET_ID_AFTER_SCHEME_RE = /:\/\/(file[-_][A-Za-z0-9]+)/;
function chatGptAssetId(pointer) {
  if (typeof pointer !== 'string' || !pointer) return null;
  const m = _ASSET_ID_AFTER_SCHEME_RE.exec(pointer);
  return m ? m[1] : null;
}

const _MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

// One entry of Scry's ingest files[] contract (the same shape the Claude path
// sends): { file_uuid, file_name, file_type, file_variant, data }. `meta` is the
// files/download response (file_name, mime_type); `dataUrl` the fetched bytes.
function buildChatGptFileBlob(pointer, meta, dataUrl) {
  const id = chatGptAssetId(pointer);
  if (!id || typeof dataUrl !== 'string' || !dataUrl) return null;
  const m = meta || {};
  const urlMime = (/^data:([^;,]+)/.exec(dataUrl) || [])[1] || null;
  const fileType = m.mime_type || urlMime || 'application/octet-stream';
  const ext = _MIME_EXT[fileType] || (fileType.split('/')[1] || 'bin');
  return {
    file_uuid: id,
    file_name: m.file_name || `${id}.${ext}`,
    file_type: fileType,
    file_variant: 'original',
    data: dataUrl,
  };
}

// ===== IMPURE: image byte capture =====

function _blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// Resolve a single asset pointer (sediment:// or file-service://) to a data URL.
// Two hops, mirroring chatgpt-exporter's fetchImageFromPointer:
//   1. GET backend-api/files/download/:id  -> a short-lived signed download_url
//   2. fetch(download_url)                 -> the actual bytes
// The bytes host (e.g. *.oaiusercontent.com) must be in host_permissions for the
// extension to read the cross-origin response. Returns null on any failure so the
// renderer falls back to a placeholder rather than aborting the export.
// Fetch options for a signed download_url: session-credentialed when the URL
// is on chatgpt.com/openai.com, anonymous otherwise (see _fetchChatGptAsset).
function _bytesFetchOptions(downloadUrl, token, accountId) {
  let host = '';
  try { host = new URL(downloadUrl).host.toLowerCase(); } catch { /* fall through */ }
  const sameSite = host === 'chatgpt.com' || host.endsWith('.chatgpt.com')
    || host === 'chat.openai.com' || host.endsWith('.openai.com');
  if (sameSite) {
    const headers = chatGptAuthHeaders(token, accountId);
    delete headers['Accept']; // bytes, not JSON
    return { credentials: 'include', headers };
  }
  return { credentials: 'omit' };
}

// Resolve one asset pointer to { meta, dataUrl }. Two endpoints are tried,
// because chatgpt.com serves the two pointer schemes differently and the
// reference implementation (pionxzh/chatgpt-exporter) uses BOTH:
//   1. GET backend-api/files/download/:id                       (file-service://, older)
//   2. GET backend-api/conversation/:convId/attachment/:id/download  (sediment://, newer)
// Each returns { status: 'success', download_url, file_name?, mime_type? }.
// Any failure THROWS with the endpoint + HTTP status in the message so the
// caller can show it -- a silent null here is how "images aren't coming over"
// went unexplained on the first live run.
async function _fetchChatGptAsset(token, pointer, accountId, conversationId) {
  const id = String(pointer || '').replace(/^\w[\w+.-]*:\/\//, ''); // strip scheme://
  if (!id) throw new Error(`unusable pointer "${pointer}"`);
  // Order matters only for speed; all are tried until one returns a signed URL.
  // Measured live 2026-09-21: files/download/:id and the conversation-scoped
  // attachment route BOTH 404 for image_gen sediment:// assets on a personal
  // account. files/:id/download is the route the reference implementation's
  // fetchImageFromPointer uses; kept first.
  const eid = encodeURIComponent(id);
  const attempts = [
    `${CHATGPT_API}/files/${eid}/download`,
    `${CHATGPT_API}/files/download/${eid}?inline=false`,
  ];
  if (conversationId) {
    const ecid = encodeURIComponent(conversationId);
    attempts.push(`${CHATGPT_API}/files/${eid}/download?conversation_id=${ecid}`);
    attempts.push(`${CHATGPT_API}/conversation/${ecid}/attachment/${eid}/download`);
  }
  let meta = null;
  const errors = [];
  for (const url of attempts) {
    try {
      const m = await chatGptApiGet(url, token, accountId);
      if (m && m.status === 'success' && m.download_url) { meta = m; break; }
      errors.push(`${url.replace(CHATGPT_API, '')}: status=${m && m.status}`);
    } catch (e) {
      if (e instanceof ChatGptRateLimitError) throw e;
      errors.push(`${url.replace(CHATGPT_API, '')}: ${e.message}`);
    }
  }
  if (!meta) throw new Error(`no signed URL (${errors.join(' | ')})`);
  // The signed download_url lives on one of two kinds of host. A separate media
  // host (*.oaiusercontent.com) is authorised by the signature alone and
  // rejects cookies/headers -> credentials omitted. chatgpt.com itself (the
  // estuary/content route, measured live 2026-09-21: 403 with credentials
  // omitted) wants the session -> cookies + bearer, like every other
  // backend-api call.
  let resp;
  const fetchOpts = _bytesFetchOptions(meta.download_url, token, accountId);
  try {
    resp = await fetch(meta.download_url, fetchOpts);
  } catch (e) {
    let host = '?';
    try { host = new URL(meta.download_url).host; } catch { /* leave ? */ }
    throw new Error(`bytes fetch threw for host ${host} (${e.message}) -- is that host in manifest host_permissions?`);
  }
  if (!resp.ok) throw new Error(`bytes ${resp.status} from ${new URL(meta.download_url).host}`);
  const raw = await _blobToDataUrl(await resp.blob());
  // Prefer the real content-type over FileReader's guess.
  const ct = resp.headers.get('content-type') || meta.mime_type;
  const dataUrl = ct ? raw.replace(/^data:[^;,]*/, `data:${ct.split(';')[0].trim()}`) : raw;
  return { meta: { ...meta, mime_type: (ct || meta.mime_type || '').split(';')[0].trim() || meta.mime_type }, dataUrl };
}

async function fetchChatGptImageDataUrl(token, pointer, accountId, conversationId) {
  try {
    const got = await _fetchChatGptAsset(token, pointer, accountId, conversationId);
    return got ? got.dataUrl : null;
  } catch (e) {
    if (e instanceof ChatGptRateLimitError) throw e;
    console.warn('ChatGPT export: image resolve failed for', pointer, e.message);
    return null;
  }
}

// Fetch the ORIGINAL bytes of every image asset in the conversation (whole tree)
// as Scry files[] records -- the ChatGPT analog of the Claude path's
// fetchConversationFileBlobs. Returns { blobs, failures }: a failure never
// aborts the push, but it is RETURNED (pointer + reason), not just logged, so
// the page can say "2 of 3 images failed: ..." instead of "Pushed ✓".
//
// Each failure carries `onBranch`: an image on the VISIBLE branch that cannot
// be fetched is a real problem; an image on a dead sibling (a regenerated-away
// attempt) that chatgpt.com no longer serves is ordinary -- measured live
// 2026-09-21: every route 404s for such a pointer while the on-branch images
// fetch fine. The page reports the two differently.
async function fetchChatGptFileBlobs(token, body, accountId, onEach) {
  const pointers = collectChatGptImagePointers(body, { wholeTree: true });
  const branchPointers = new Set(collectChatGptImagePointers(body));
  const conversationId = body && (body.conversation_id || body.id) || null;
  const blobs = [];
  const failures = [];
  await Promise.all(pointers.map(async (pointer) => {
    const onBranch = branchPointers.has(pointer);
    try {
      const got = await withChatGptRateLimitRetry(
        () => _fetchChatGptAsset(token, pointer, accountId, conversationId));
      const rec = buildChatGptFileBlob(pointer, got.meta, got.dataUrl);
      if (rec) blobs.push(rec);
      else failures.push({ pointer, onBranch, error: 'could not build files[] record (no asset id or empty bytes)' });
    } catch (e) {
      if (onBranch) console.warn('ChatGPT push: file fetch failed for', pointer, e);
      failures.push({ pointer, onBranch, error: e.message || String(e) });
    } finally {
      if (onEach) onEach();
    }
  }));
  return { blobs, failures };
}

// ===== PURE: the Scry ingest contract =====

// Build the payload POSTed to Scry's /api/conversations/ingest.
//
// Scry expects the VERBATIM ChatGPT body. It performs the current_node -> root
// branch walk SERVER-SIDE, so the import path and the fidelity-verification
// path prune with the same code and agree by construction. That is why this
// deliberately does NOT prune, and does not reuse normalizeChatGptConversation
// (which is for the export/preview renderers): a client that pruned would put a
// second branch rule in a second language, and any drift between the two would
// read as a permanent capture gap on the server.
//
// It also does NOT inline image bytes into message text the way the export path
// does — that would push base64 into Scry's message content AND into the
// archived raw_json. Image bytes travel separately as fileBlobs, matching the
// Claude path's files[] contract:
//   [{ file_uuid, file_name, file_type, file_variant, data }]
// Populated for ChatGPT by fetchChatGptFileBlobs (image assets, whole tree).
//
// `fallbackConversationId` is the id the LIST endpoint gave us for this body.
// Scry keys the row and the archive on `conversation_id`; a body without one
// would import with no source id and skip fidelity capture entirely (the
// archive is only written when there is an id to attach it to). The fallback
// is only used when the body carries none — a body's own id always wins.
function buildChatGptIngestPayload(body, fileBlobs = [], fallbackConversationId = null) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const payload = { ...body };
  if (!payload.conversation_id && fallbackConversationId) {
    payload.conversation_id = fallbackConversationId;
  }
  if (Array.isArray(fileBlobs) && fileBlobs.length) payload.files = fileBlobs;
  return payload;
}

// Run `fn` and, on a ChatGptRateLimitError, wait the server's Retry-After and
// try again (up to `maxRetries` more times). Any other error propagates
// untouched. `sleep`/`onRetry` are injectable so this is testable in Node and
// so the page can show "rate limited, waiting Ns" instead of going quiet.
async function withChatGptRateLimitRetry(fn, { maxRetries = 2, sleep = null, onRetry = null } = {}) {
  const doSleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof ChatGptRateLimitError) || attempt >= maxRetries) throw e;
      if (onRetry) onRetry(e.retryAfterMs);
      await doSleep(e.retryAfterMs);
    }
  }
}

// Node (vitest): expose the PURE surface for testing. Browser: these are globals.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    getChatGptBranch,
    findDeepestLeaf,
    buildChatGptIngestPayload,
    withChatGptRateLimitRetry,
    ChatGptRateLimitError,
    chatGptAssetId,
    buildChatGptFileBlob,
    _fetchChatGptAsset,
    fetchChatGptFileBlobs,
    _bytesFetchOptions,
    shouldSkipChatGptMessage,
    isDisplayableChatGptMessage,
    chatGptMessageText,
    chatGptTimeToIso,
    extractChatGptModelSlug,
    collectChatGptImagePointers,
    normalizeChatGptConversation,
    convertChatGptToMarkdown,
    chatGptConversationToJson,
    slugifyChatGptTitle,
  };
}
