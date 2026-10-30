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

// --- Back-off tuning: ALL the knobs in one place -----------------------------
// Context: the 15-minute incremental sync is fine, but the INITIAL catch-up
// against a fresh Scry host (a deep reconcile finding thousands of missing
// conversations and pushing them all at once, several conversations x several
// images in parallel) gets heavily rate limited by chatgpt.com. The owner's
// ruling: "we need to back off significantly". So every chatgpt.com request
// goes through ONE serialized gate (createChatGptGate below); a 429 puts every
// lane in a shared cooldown; and the deep pass runs in capped slices.
//
// Minimum gap between request STARTS, by kind (ms). One request in flight at a
// time, so these are also the ceiling on request rate.
const CHATGPT_MIN_SPACING_MS = { list: 400, body: 1000, asset: 750 };
// Shared cooldown after a 429 with no usable Retry-After: escalates per
// consecutive cooldown, capped at the last entry.
const CHATGPT_COOLDOWN_SCHEDULE_MS = [60000, 120000, 240000, 480000, 900000];
// The escalation resets after this long with no 429 (measured from the end of
// the previous cooldown, so a 15-minute cooldown does not itself count).
const CHATGPT_COOLDOWN_RESET_MS = 10 * 60 * 1000;
// Never honour a Retry-After longer than this.
const CHATGPT_COOLDOWN_MAX_MS = 60 * 60 * 1000;
// A wait longer than this pings chrome.runtime every KEEPALIVE_MS so the MV3
// service worker is not killed mid-batch.
const CHATGPT_KEEPALIVE_MS = 20000;
// A wake that hits this many cooldowns aborts its remaining batch.
const CHATGPT_ABORT_AFTER_COOLDOWNS = 3;
// Per-conversation image pool default (the gate serializes anyway; this just
// bounds how much work sits queued).
const CHATGPT_IMAGE_POOL_DEFAULT = 2;
// Largest document upload (metadata `size`, bytes) the extension will fetch and
// push. Bigger ones are reported in failures[], never silently dropped.
const CHATGPT_DOCUMENT_MAX_BYTES = 25 * 1024 * 1024;
// Same cap for vendor-resolved generated-UI pictures (images.openai.com).
const CHATGPT_GENUI_MAX_BYTES = 25 * 1024 * 1024;
// Batch concurrency for ChatGPT (SOURCES.chatgpt.concurrency).
const CHATGPT_BATCH_CONCURRENCY = 1;
// The deep reconcile pushes at most this many conversations per pass; the rest
// is left for catch-up passes scheduled CHATGPT_CATCHUP_DELAY_MS apart.
const CHATGPT_DEEP_SLICE = 150;
const CHATGPT_CATCHUP_DELAY_MS = 20 * 60 * 1000;
const CHATGPT_CATCHUP_ALARM = 'continuousSync:chatgpt:catchup';
// A gated request (headers AND body) that takes longer than this is aborted
// and fails like any ordinary error (NOT as a 429), so one hung fetch cannot
// wedge the single global queue.
const CHATGPT_REQUEST_TIMEOUT_MS = 60000;
// Rate-limit retries per request (each one waits on the gate's cooldown).
const CHATGPT_RATE_LIMIT_RETRIES = 3;

// --- resolver for scry_sync.js's runPool (browser global / Node module) ---
// Mirrors the pattern sources.js/sync_core.js use for each other's globals.
// scry_sync.js loads before this file everywhere (browse.html, chatgpt
// continuous-sync via background.js) so the global is present in the browser;
// Node (vitest) requires it directly.
function _runPool() {
  return (typeof runPool !== 'undefined') ? runPool : require('./scry_sync.js').runPool;
}

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

// Collect fresh DOCUMENT uploads (md, txt, pdf, docx, csv...). chatgpt.com
// records them ONLY in message.metadata.attachments[] -- there is no content
// part -- as { id, name, mime_type, size }. Images appear there too (with the
// same id as their image_asset_pointer), so image/* entries (or a missing mime
// with an image extension) and any id collectChatGptImagePointers already
// yields are excluded: those are fetched by the image path. Same walk as the
// image collector; on the branch pass hidden/tool messages are skipped, while
// wholeTree (the Scry push) visits every node. De-duplicated by id. Pure.
function collectChatGptDocumentAttachments(data, { wholeTree = false } = {}) {
  const imageIds = new Set(
    collectChatGptImagePointers(data, { wholeTree }).map(chatGptAssetId).filter(Boolean));
  const out = [];
  const seen = new Set();
  const messages = wholeTree
    ? Object.values((data && data.mapping) || {}).map((n) => n && n.message).filter(Boolean)
    : getChatGptBranch(data).filter((m) => !shouldSkipChatGptMessage(m));
  for (const message of messages) {
    const atts = message && message.metadata && message.metadata.attachments;
    if (!Array.isArray(atts)) continue;
    for (const a of atts) {
      if (!a || typeof a !== 'object' || typeof a.id !== 'string' || !a.id) continue;
      if (seen.has(a.id) || imageIds.has(a.id)) continue;
      const mime = typeof a.mime_type === 'string' ? a.mime_type : '';
      const isImage = mime
        ? mime.toLowerCase().startsWith('image/')
        : _mimeFromFileName(a.name) !== null;
      if (isImage) continue;
      seen.add(a.id);
      out.push({ id: a.id, name: a.name, mime_type: a.mime_type, size: a.size });
    }
  }
  return out;
}

// ===== PURE: generated-UI pictures (AsyncImage / AsyncImageGroup) =====

// CONTRACT shared with the Scry server renderer: the files[] file_uuid of a
// generated-UI picture is "genui_" + the first 32 hex chars of the SHA-256 of
// its content_url string (UTF-8). Do not change without changing the server.
async function genuiFileUuid(contentUrl) {
  const bytes = new TextEncoder().encode(String(contentUrl));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  return 'genui_' + hex.slice(0, 32);
}

// Pictures the vendor already resolved for <AsyncImage/> tags live in the
// conversation body: message.metadata.model_dil_v2.appData.opGenui
// .componentResults{ id: { componentName, status, state:{ images:[...] } } }.
// Non-image components (link cards, carousels, maps) have no images array and
// are ignored. Same message walk as the other collectors; de-duplicated by
// content_url. Async only because the derived id uses Web Crypto.
async function collectChatGptGenuiImages(data, { wholeTree = false } = {}) {
  const messages = wholeTree
    ? Object.values((data && data.mapping) || {}).map((n) => n && n.message).filter(Boolean)
    : getChatGptBranch(data).filter((m) => !shouldSkipChatGptMessage(m));
  const out = [];
  const seen = new Set();
  for (const message of messages) {
    const md = message && message.metadata;
    const results = md && md.model_dil_v2 && md.model_dil_v2.appData
      && md.model_dil_v2.appData.opGenui && md.model_dil_v2.appData.opGenui.componentResults;
    if (!results || typeof results !== 'object') continue;
    for (const comp of Object.values(results)) {
      const images = comp && comp.state && comp.state.images;
      if (!Array.isArray(images) || !images.length) continue;
      for (const img of images) {
        const url = img && img.content_url;
        if (typeof url !== 'string' || !url || seen.has(url)) continue;
        seen.add(url);
        out.push({
          id: await genuiFileUuid(url),
          content_url: url,
          thumbnail_url: img.thumbnail_url || null,
          title: typeof img.title === 'string' ? img.title : '',
          query: typeof img.image_search_query === 'string' ? img.image_search_query : '',
          source_url: img.original_content_url || img.url || null,
          message_id: (message && message.id) || null,
          index: out.length,
        });
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

// Thrown on HTTP 429, carrying how long to wait (ms). Mirrors
// chatgpt-exporter's RateLimitError so callers can back off instead of failing.
// `cooldownMs`, when given (the gate's actual shared cooldown), wins over the
// Retry-After header; with neither, the legacy 30s default.
class ChatGptRateLimitError extends Error {
  constructor(retryAfterHeader, cooldownMs) {
    super('ChatGPT rate limit (429) — wait and retry.');
    this.name = 'ChatGptRateLimitError';
    const secs = retryAfterHeader != null ? parseInt(retryAfterHeader, 10) : NaN;
    this.retryAfterMs = Number.isFinite(cooldownMs) && cooldownMs > 0
      ? cooldownMs
      : (Number.isFinite(secs) && secs > 0 ? secs * 1000 : 30000);
  }
}

// ===== IMPURE: the global request gate =====
//
// EVERY chatgpt.com request (auth/session, list pages, conversation bodies,
// asset metadata and bytes) runs through chatGptGate.run(kind, fn):
//   - serialized: at most ONE request in flight;
//   - spaced: a request does not START until CHATGPT_MIN_SPACING_MS[kind] after
//     the previous start;
//   - cooled down: when ANY request gets a 429 (report429), no lane sends
//     anything until the cooldown ends.
// `now`/`sleep`/`keepalive`/`warn` are injectable so it is testable with a fake
// clock. State is in-memory; the continuous-sync engine carries a cooldown
// across service-worker restarts via nextAllowedAt.
function _defaultKeepalive() {
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.getPlatformInfo === 'function') {
      // Any extension API call resets the MV3 service-worker idle timer.
      const r = chrome.runtime.getPlatformInfo(() => {});
      if (r && typeof r.catch === 'function') r.catch(() => {});
    }
  } catch (_e) { /* keepalive is best-effort */ }
}

function _headerDump(headers) {
  const out = [];
  if (headers && typeof headers.forEach === 'function') {
    headers.forEach((value, name) => out.push(`${name}: ${value}`));
  }
  return out.join(' | ');
}

function _parseRetryAfterMs(headers, nowMs) {
  const raw = headers && typeof headers.get === 'function' ? headers.get('Retry-After') : null;
  if (raw == null || raw === '') return null;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs > 0) return Math.min(secs * 1000, CHATGPT_COOLDOWN_MAX_MS);
  const date = Date.parse(raw);
  if (!Number.isNaN(date) && date > nowMs) return Math.min(date - nowMs, CHATGPT_COOLDOWN_MAX_MS);
  return null;
}

function createChatGptGate(opts = {}) {
  const now = opts.now || (() => Date.now());
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const keepalive = opts.keepalive || _defaultKeepalive;
  const warn = opts.warn || ((...a) => console.warn(...a));
  const spacing = opts.spacing || CHATGPT_MIN_SPACING_MS;
  const schedule = opts.schedule || CHATGPT_COOLDOWN_SCHEDULE_MS;
  const resetAfterMs = opts.resetAfterMs != null ? opts.resetAfterMs : CHATGPT_COOLDOWN_RESET_MS;
  const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : CHATGPT_REQUEST_TIMEOUT_MS;
  const setT = opts.setTimeout || ((fn, ms) => setTimeout(fn, ms));
  const clearT = opts.clearTimeout || ((h) => clearTimeout(h));
  let onCooldown = opts.onCooldown || null;   // (cooldownUntil, level) -> void, at the moment of a 429
  let onKeepalive = opts.onKeepalive || null; // () -> void, on every keepalive tick of a long wait

  let tail = Promise.resolve();
  let lastStart = -Infinity;
  let cooldownUntil = 0;
  let last429At = -Infinity;
  let level = 0;
  let cooldownsThisRun = 0;

  // Sleep `ms`; a wait longer than CHATGPT_KEEPALIVE_MS is chopped into
  // KEEPALIVE_MS slices with a keepalive ping around each.
  async function wait(ms) {
    if (!(ms > 0)) return;
    if (ms <= CHATGPT_KEEPALIVE_MS) { await sleep(ms); return; }
    let left = ms;
    while (left > 0) {
      keepalive();
      if (onKeepalive) { try { onKeepalive(); } catch (_e) { /* best-effort */ } }
      const step = Math.min(left, CHATGPT_KEEPALIVE_MS);
      await sleep(step);
      left -= step;
    }
  }

  async function waitReady(kind) {
    const gap = spacing[kind] != null ? spacing[kind] : spacing.body;
    for (;;) {
      const t = now();
      const readyAt = Math.max(cooldownUntil, lastStart + gap);
      if (t >= readyAt) return;
      await wait(readyAt - t);
    }
  }

  function run(kind, fn) {
    const p = tail.then(async () => {
      await waitReady(kind);
      lastStart = now();
      return fn();
    });
    tail = p.then(() => {}, () => {});
    return p;
  }

  // Record a 429 (`resp`: anything with .status and .headers). Starts a shared
  // cooldown and returns its length in ms; a 429 landing INSIDE an existing
  // cooldown neither extends nor escalates it.
  function report429(resp) {
    const t = now();
    if (t < cooldownUntil) return cooldownUntil - t;
    if (t - Math.max(last429At, cooldownUntil) >= resetAfterMs) level = 0;
    const retryAfter = _parseRetryAfterMs(resp && resp.headers, t);
    const dur = retryAfter != null ? retryAfter : schedule[Math.min(level, schedule.length - 1)];
    level++;
    cooldownUntil = t + dur;
    last429At = t;
    cooldownsThisRun++;
    // Whether a real 429 carries Retry-After was UNKNOWN when this was written
    // (a 200 carries no rate-limit headers at all) -- log everything, once.
    if (onCooldown) { try { onCooldown(cooldownUntil, level); } catch (_e) { /* persistence is best-effort */ } }
    warn(`Scry ChatGPT 429 headers: status ${(resp && resp.status) || 429} | ${_headerDump(resp && resp.headers)}`);
    return dur;
  }

  // Restore a persisted cooldown after the service worker was recycled: carry
  // the cooldown end and the escalation level forward unless the last cooldown
  // ended more than the reset window ago (then escalation starts over).
  function seed(persisted) {
    const until = persisted && persisted.cooldownUntil;
    if (typeof until !== 'number') return;
    if (now() - until >= resetAfterMs) return;
    cooldownUntil = Math.max(cooldownUntil, until);
    level = Math.max(level, Number(persisted.level) || 0);
  }

  // One gated fetch, bounded by a timeout. `handler(resp)` reads the response
  // (429 check, status, body) INSIDE the timeout, so a stalled body read is
  // covered too. A timeout throws an ordinary Error (not a rate limit); an
  // error thrown by fetch() itself is tagged `fetchPhase`.
  async function fetchWith(label, url, init, handler) {
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let timedOut = false;
    const timer = setT(() => { timedOut = true; if (ac) ac.abort(); }, timeoutMs);
    const timeoutErr = () => new Error(`${label}: request timed out after ${Math.round(timeoutMs / 1000)}s`);
    try {
      let resp;
      try {
        resp = await fetch(url, ac ? { ...init, signal: ac.signal } : init);
      } catch (e) {
        if (timedOut) throw timeoutErr();
        e.fetchPhase = true;
        throw e;
      }
      try {
        return await handler(resp);
      } catch (e) {
        if (timedOut && !(e instanceof ChatGptRateLimitError)) throw timeoutErr();
        throw e;
      }
    } finally {
      clearT(timer);
    }
  }

  async function waitForCooldown() {
    const ms = cooldownUntil - now();
    if (ms > 0) await wait(ms);
  }

  return {
    run,
    report429,
    fetchWith,
    seed,
    setOnCooldown(fn) { onCooldown = fn || null; },
    setOnKeepalive(fn) { onKeepalive = fn || null; },
    waitForCooldown,
    resetRun() { cooldownsThisRun = 0; },
    getState() { return { cooldownUntil, cooldownsThisRun, level }; },
  };
}

let chatGptGate = createChatGptGate();
// Test seam: swap in a gate with a fake clock.
function _setChatGptGate(gate) { chatGptGate = gate; }

// On a 429 response: start the shared cooldown and throw the typed error.
function _throwIfRateLimited(resp) {
  if (resp.status !== 429) return;
  const ms = chatGptGate.report429(resp);
  throw new ChatGptRateLimitError(resp.headers && resp.headers.get ? resp.headers.get('Retry-After') : null, ms);
}

// Pull the session access token. Every backend-api read needs it as a bearer.
// Relies on the browser's chatgpt.com session cookies (host_permissions grants
// credentialed cross-origin fetch from the extension page).
async function getChatGptAccessToken() {
  const data = await chatGptGate.run('list', () => chatGptGate.fetchWith(
    'auth/session', `${CHATGPT_ORIGIN}/api/auth/session`,
    { credentials: 'include', headers: { 'Accept': 'application/json' } },
    async (resp) => {
      _throwIfRateLimited(resp);
      if (!resp.ok) throw new Error(`auth/session ${resp.status} — are you signed in to chatgpt.com?`);
      return resp.json();
    }));
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

// Error with an HTTP status attached, so classifyFetchFailure need not parse text.
function _statusError(message, status, hop) {
  const e = new Error(message);
  e.status = status;
  if (hop) e.hop = hop;
  return e;
}

// Classify a thrown fetch error into the wire `reason` vocabulary + HTTP status.
// Prefers e.status / e.vendorError; falls back to a status number in the message.
function classifyFetchFailure(err, hop) {
  const msg = String((err && err.message) || err || '');
  hop = hop || (err && err.hop) || 'metadata';
  let status = (err && Number.isInteger(err.status)) ? err.status : null;
  if (/^skipped:/.test(msg) && /MAX_BYTES/.test(msg)) return { reason: 'too_large', status };
  if (err && err.noSignedUrl) return _classifyNoSignedUrl(err, status);
  if (/^no signed URL/.test(msg)) {
    const m = msg.match(/\b([1-5]\d\d)\b/);
    return { reason: 'no_signed_url', status: status != null ? status : (m ? Number(m[1]) : null) };
  }
  const vendor = err && err.vendorError;
  if (vendor === 'file_not_found') return { reason: 'not_found', status };
  if (vendor === 'user_mismatch') return { reason: 'forbidden', status };
  if (status == null && !/fetch threw/.test(msg)) {
    const m = msg.match(/\b([1-5]\d\d)\b/);
    if (m) status = Number(m[1]);
  }
  if (status === 429) return { reason: 'rate_limited', status };
  if (status != null && status >= 500 && status <= 599) return { reason: 'server_error', status };
  // Bytes hop: a FRESH signed URL that fails 401/403/404/410 means signature,
  // expiry or credentials -- not "dead at source". Only 'direct' (anonymous
  // vendor-resolved pictures, no signed URL) treats 404/410 as the vendor's answer.
  if (hop !== 'bytes') {
    if (status === 404) return { reason: 'not_found', status };
    if (status === 403 || status === 401) return { reason: 'forbidden', status };
    if (status === 410) return { reason: 'gone', status };
  }
  if (err instanceof ChatGptRateLimitError) return { reason: 'rate_limited', status: status != null ? status : 429 };
  if (status == null) {
    if (/bytes fetch threw|failed to fetch|networkerror|network|load failed/i.test(msg)) return { reason: 'network', status };
    if (err instanceof TypeError && /fetch|network|load failed/i.test(msg)) return { reason: 'network', status };
  }
  return { reason: 'other', status };
}

// Aggregate of the metadata routes. Precedence: transient > forbidden > dead.
// A dead class is assigned only when EVERY attempt was a definite dead answer.
function _classifyNoSignedUrl(err, status) {
  if (err.transient) {
    return { reason: err.transientReason || 'no_signed_url', status };
  }
  const statuses = Array.isArray(err.statuses) ? err.statuses : [];
  if (err.vendorError === 'user_mismatch' || statuses.some((n) => n === 401 || n === 403)) {
    return { reason: 'forbidden', status: statuses.find((n) => n === 401 || n === 403) || status };
  }
  if (err.vendorError === 'file_not_found') return { reason: 'not_found', status };
  if (statuses.includes(404)) return { reason: 'not_found', status: 404 };
  if (statuses.includes(410)) return { reason: 'gone', status: 410 };
  return { reason: 'no_signed_url', status };
}

// Credentialed backend-api GET with 429 awareness, through the global gate.
// `kind` ('list' | 'body' | 'asset') picks the gate's minimum spacing.
async function chatGptApiGet(url, token, accountId, kind = 'body') {
  return chatGptGate.run(kind, () => chatGptGate.fetchWith(
    url, url, { credentials: 'include', headers: chatGptAuthHeaders(token, accountId) },
    async (resp) => {
      _throwIfRateLimited(resp);
      if (!resp.ok) throw _statusError(`${url}: ${resp.status}`, resp.status, 'metadata');
      return resp.json();
    }));
}

// One page of the conversation list.
async function listChatGptConversations(token, { offset = 0, limit = 28, accountId = null } = {}) {
  const url = `${CHATGPT_API}/conversations?offset=${offset}&limit=${limit}`;
  return chatGptApiGet(url, token, accountId, 'list');
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

// Has this page (newest-first, as chatgpt.com lists them) reached the
// watermark? True when the OLDEST item on the page is at or behind it, i.e.
// every later page is older still and the incremental wake does not need it.
// A null watermark (first run) never stops early. Pure.
function chatGptPageReachesWatermark(items, watermarkIso) {
  if (!watermarkIso || !Array.isArray(items) || items.length === 0) return false;
  const wm = Date.parse(watermarkIso);
  if (Number.isNaN(wm)) return false;
  const times = items.map((it) => Date.parse(chatGptTimeToIso(it && it.update_time))).filter((t) => !Number.isNaN(t));
  if (times.length === 0) return false;
  return Math.min(...times) <= wm;
}

// Enumerate only what an incremental wake needs: pages newest-first until one
// reaches the watermark. The full list for 3,400 conversations is ~35 requests
// every 15 minutes — measured as the cause of chatgpt.com 429s (2026-10-19);
// with a current watermark this is one or two. Returns every item fetched
// (the planner filters by watermark); the daily deep reconcile keeps using
// listAllChatGptConversations.
async function listChatGptConversationsSince(token, watermarkIso, accountId, onProgress) {
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
    if (chatGptPageReachesWatermark(items, watermarkIso)) break;
    offset += limit;
  }
  return all;
}

// Fetch one conversation's full body (the mapping tree).
async function fetchChatGptConversation(token, conversationId, accountId) {
  const url = `${CHATGPT_API}/conversation/${conversationId}`;
  return chatGptApiGet(url, token, accountId, 'body');
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

// Magic-byte signatures, base64-encoded (the base64 alphabet aligns on 3-byte/
// 4-char boundaries, so a fixed byte signature at offset 0 always maps to a
// fixed base64 PREFIX — no decoding needed). Checked in this order; first
// match wins.
const _MAGIC_PREFIXES = [
  { prefix: 'iVBORw0KGgo', mime: 'image/png' },   // 89 50 4E 47 0D 0A 1A 0A
  { prefix: '/9j/', mime: 'image/jpeg' },          // FF D8 FF
  { prefix: 'UklGR', mime: 'image/webp' },         // "RIFF"
  { prefix: 'R0lGOD', mime: 'image/gif' },         // "GIF8"
];

// Sniff an image mime type from a data URL's base64 payload. Returns null if
// the payload doesn't start with a known signature (never a false positive —
// no signature check is a substring match, only a prefix match).
function _sniffImageMimeFromDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const comma = dataUrl.indexOf(',');
  if (comma === -1) return null;
  const payload = dataUrl.slice(comma + 1);
  for (const { prefix, mime } of _MAGIC_PREFIXES) {
    if (payload.startsWith(prefix)) return mime;
  }
  return null;
}

const _EXT_MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };

// Last-resort mime guess from the file_name extension chatgpt.com's metadata
// response carried, when the bytes themselves didn't match a known signature.
function _mimeFromFileName(fileName) {
  if (typeof fileName !== 'string') return null;
  const m = /\.([a-zA-Z0-9]+)$/.exec(fileName);
  return m ? (_EXT_MIME[m[1].toLowerCase()] || null) : null;
}

// One entry of Scry's ingest files[] contract (the same shape the Claude path
// sends): { file_uuid, file_name, file_type, file_variant, data }. `meta` is the
// files/download response (file_name, mime_type); `dataUrl` the fetched bytes.
//
// chatgpt.com's byte response sometimes carries no content-type at all, which
// resolves to application/octet-stream here — measured live on the owner's
// bulk push: 28/88 image blobs stored this way (23 JPEGs, 5 PNGs), all
// correctly-fetched image bytes wearing the wrong label. When the resolved
// mime is missing, generic (octet-stream), or not an image/* type at all,
// recover the real type: (a) sniff the actual bytes via a magic-byte
// signature — the most reliable signal, since it reads what was actually
// fetched rather than trusting a header; (b) fall back to the file_name
// extension; (c) otherwise leave it as octet-stream rather than guess wrong.
// The data URL's own `data:<mime>` prefix is rewritten to match, so Scry's
// decoder and the view agree with file_type on what the bytes are.
function buildChatGptFileBlob(pointer, meta, dataUrl) {
  const id = chatGptAssetId(pointer);
  if (!id || typeof dataUrl !== 'string' || !dataUrl) return null;
  const m = meta || {};
  const urlMime = (/^data:([^;,]+)/.exec(dataUrl) || [])[1] || null;
  let fileType = m.mime_type || urlMime || 'application/octet-stream';

  if (!fileType.startsWith('image/') || fileType === 'application/octet-stream') {
    const inferred = _sniffImageMimeFromDataUrl(dataUrl) || _mimeFromFileName(m.file_name);
    if (inferred) fileType = inferred;
  }

  const ext = _MIME_EXT[fileType] || (fileType.split('/')[1] || 'bin');
  const fixedDataUrl = dataUrl.replace(/^data:[^;,]*/, `data:${fileType}`);
  return {
    file_uuid: id,
    file_name: m.file_name || `${id}.${ext}`,
    file_type: fileType,
    file_variant: 'original',
    data: fixedDataUrl,
  };
}

// files[] record for a document attachment. file_uuid is the attachment id
// itself (documents have no pointer). Name/type prefer the message metadata,
// then the download route's answer, then the byte response's content-type.
function buildChatGptDocumentBlob(att, meta, dataUrl) {
  if (!att || !att.id || typeof dataUrl !== 'string' || !dataUrl) return null;
  const m = meta || {};
  const urlMime = (/^data:([^;,]+)/.exec(dataUrl) || [])[1] || null;
  const fileType = att.mime_type || m.mime_type || urlMime || 'application/octet-stream';
  return {
    file_uuid: att.id,
    file_name: att.name || m.file_name || att.id,
    file_type: fileType,
    file_variant: 'original',
    data: dataUrl.replace(/^data:[^;,]*/, `data:${fileType.split(';')[0].trim()}`),
  };
}

// files[] record for a generated-UI picture. file_uuid is the derived id (see
// genuiFileUuid). Type: response content-type if it is an image/*, else
// magic-byte sniff, else the generic fallback. Name: sanitized title/query.
function buildChatGptGenuiBlob(entry, meta, dataUrl) {
  if (!entry || !entry.id || typeof dataUrl !== 'string' || !dataUrl) return null;
  const m = meta || {};
  const urlMime = (/^data:([^;,]+)/.exec(dataUrl) || [])[1] || null;
  let fileType = (m.mime_type || urlMime || '').split(';')[0].trim().toLowerCase();
  if (!fileType.startsWith('image/')) {
    fileType = _sniffImageMimeFromDataUrl(dataUrl) || 'application/octet-stream';
  }
  const ext = _MIME_EXT[fileType] || (fileType.split('/')[1] || 'bin');
  const base = String(entry.title || entry.query || entry.id)
    .replace(/[^A-Za-z0-9._ -]+/g, '').trim().replace(/\s+/g, '_').slice(0, 80) || entry.id;
  return {
    file_uuid: entry.id,
    file_name: `${base}.${ext}`,
    file_type: fileType,
    file_variant: 'original',
    data: dataUrl.replace(/^data:[^;,]*/, `data:${fileType}`),
  };
}

// Anonymous, gated fetch of one generated-UI picture. images.openai.com serves
// it with no cookies/auth (credentials omitted, no Authorization header).
async function _fetchChatGptGenuiBytes(contentUrl) {
  let u = null;
  try { u = new URL(contentUrl); } catch { throw new Error('unusable content_url'); }
  const host = u.host;
  const { resp, raw } = await chatGptGate.run('asset', async () => {
    try {
      return await chatGptGate.fetchWith('bytes', contentUrl, { credentials: 'omit' }, async (r) => {
        _throwIfRateLimited(r);
        if (!r.ok) throw _statusError(`bytes ${r.status} from ${host}`, r.status, 'direct');
        const len = Number(r.headers && r.headers.get && r.headers.get('content-length'));
        if (len > CHATGPT_GENUI_MAX_BYTES) throw new Error(`skipped: ${len} bytes exceeds CHATGPT_GENUI_MAX_BYTES`);
        const blob = await r.blob();
        if (blob && blob.size > CHATGPT_GENUI_MAX_BYTES) throw new Error(`skipped: ${blob.size} bytes exceeds CHATGPT_GENUI_MAX_BYTES`);
        return { resp: r, raw: await _blobToDataUrl(blob) };
      });
    } catch (e) {
      if (e && e.fetchPhase) {
        throw new Error(`bytes fetch threw for host ${host} (${e.message}) -- is that host in manifest host_permissions?`);
      }
      throw e;
    }
  });
  const ct = (resp.headers.get('content-type') || '').split(';')[0].trim();
  return { meta: { mime_type: ct }, dataUrl: raw };
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
  const statuses = [];
  const vendorCodes = [];
  let transient = null; // first transient attempt: {reason}
  for (const url of attempts) {
    try {
      const m = await chatGptApiGet(url, token, accountId, 'asset');
      if (m && m.status === 'success' && m.download_url) { meta = m; break; }
      const code = m && m.status === 'error' ? (m.error_code || 'unknown') : null;
      if (code) vendorCodes.push(code);
      if (!code || (code !== 'file_not_found' && code !== 'user_mismatch')) {
        transient = transient || { reason: 'no_signed_url' };
      }
      errors.push(`${url.replace(CHATGPT_API, '')}: status=${m && m.status}${code ? ` error_code=${code}` : ''}`);
    } catch (e) {
      if (e instanceof ChatGptRateLimitError) throw e;
      if (Number.isInteger(e && e.status)) {
        statuses.push(e.status);
        if (e.status === 429) transient = transient || { reason: 'rate_limited' };
        else if (e.status >= 500) transient = transient || { reason: 'server_error' };
        else if (![401, 403, 404, 410].includes(e.status)) transient = transient || { reason: 'no_signed_url' };
      } else {
        transient = transient || { reason: 'network' };
      }
      errors.push(`${url.replace(CHATGPT_API, '')}: ${e.message}`);
    }
  }
  if (!meta) {
    const err = new Error(`no signed URL (${errors.join(' | ')})`);
    err.noSignedUrl = true;
    err.statuses = statuses;
    // The metadata route answers HTTP 200 {status:'error', error_code} for dead ids.
    err.status = vendorCodes.length ? 200 : (statuses.length ? statuses[0] : null);
    const vc = vendorCodes.includes('file_not_found') ? 'file_not_found'
      : vendorCodes.includes('user_mismatch') ? 'user_mismatch' : null;
    if (vc) err.vendorError = vc;
    else if (vendorCodes.length) err.vendorErrorOther = vendorCodes[0];
    if (transient) { err.transient = true; err.transientReason = transient.reason; }
    throw err;
  }
  // The signed download_url lives on one of two kinds of host. A separate media
  // host (*.oaiusercontent.com) is authorised by the signature alone and
  // rejects cookies/headers -> credentials omitted. chatgpt.com itself (the
  // estuary/content route, measured live 2026-09-21: 403 with credentials
  // omitted) wants the session -> cookies + bearer, like every other
  // backend-api call.
  const fetchOpts = _bytesFetchOptions(meta.download_url, token, accountId);
  const { resp, raw } = await chatGptGate.run('asset', async () => {
    let host = '?';
    try { host = new URL(meta.download_url).host; } catch { /* leave ? */ }
    try {
      return await chatGptGate.fetchWith('bytes', meta.download_url, fetchOpts, async (r) => {
        _throwIfRateLimited(r);
        if (!r.ok) throw _statusError(`bytes ${r.status} from ${host}`, r.status, 'bytes');
        return { resp: r, raw: await _blobToDataUrl(await r.blob()) };
      });
    } catch (e) {
      if (e && e.fetchPhase) {
        throw new Error(`bytes fetch threw for host ${host} (${e.message}) -- is that host in manifest host_permissions?`);
      }
      throw e;
    }
  });
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
//
// Pointers are run through a BOUNDED pool (default concurrency CHATGPT_IMAGE_POOL_DEFAULT), not
// Promise.all — measured live: a 36-image conversation firing all 36
// metadata+byte fetches at once earned a 429 storm that exhausted
// withChatGptRateLimitRetry's two retries and lost every single image.
// `opts.concurrency` lets a caller tune it; onEach/failures/onBranch
// semantics are unchanged.
async function fetchChatGptFileBlobs(token, body, accountId, onEach, opts = {}) {
  const pointers = collectChatGptImagePointers(body, { wholeTree: true });
  const branchPointers = new Set(collectChatGptImagePointers(body));
  const conversationId = body && (body.conversation_id || body.id) || null;
  const blobs = [];
  const failures = [];
  const concurrency = (opts.concurrency && opts.concurrency > 0) ? opts.concurrency : CHATGPT_IMAGE_POOL_DEFAULT;
  const pool = _runPool();
  await pool(pointers, concurrency, async (pointer) => {
    const onBranch = branchPointers.has(pointer);
    try {
      const got = await withChatGptRateLimitRetry(
        () => _fetchChatGptAsset(token, pointer, accountId, conversationId));
      const rec = buildChatGptFileBlob(pointer, got.meta, got.dataUrl);
      if (rec) blobs.push(rec);
      else failures.push({ pointer, id: chatGptAssetId(pointer), kind: 'image', reason: 'other', status: null, onBranch, error: 'could not build files[] record (no asset id or empty bytes)' });
    } catch (e) {
      if (onBranch) console.warn('ChatGPT push: file fetch failed for', pointer, e);
      failures.push({ pointer, id: chatGptAssetId(pointer), kind: 'image', ...classifyFetchFailure(e), onBranch, error: e.message || String(e) });
    } finally {
      if (onEach) onEach();
    }
  });

  // Fresh document uploads: same gate, same pool, same failure surfacing.
  const branchDocIds = new Set(collectChatGptDocumentAttachments(body).map((d) => d.id));
  const docs = collectChatGptDocumentAttachments(body, { wholeTree: true });
  await pool(docs, concurrency, async (att) => {
    const onBranch = branchDocIds.has(att.id);
    try {
      if (typeof att.size === 'number' && att.size > CHATGPT_DOCUMENT_MAX_BYTES) {
        failures.push({ pointer: att.id, id: att.id, kind: 'document', name: att.name, reason: 'too_large', status: null, onBranch,
          error: `skipped: ${att.size} bytes exceeds CHATGPT_DOCUMENT_MAX_BYTES` });
        return;
      }
      const got = await withChatGptRateLimitRetry(
        () => _fetchChatGptAsset(token, att.id, accountId, conversationId));
      const rec = buildChatGptDocumentBlob(att, got.meta, got.dataUrl);
      if (rec) blobs.push(rec);
      else failures.push({ pointer: att.id, id: att.id, kind: 'document', name: att.name, reason: 'other', status: null, onBranch, error: 'could not build files[] record (empty bytes)' });
    } catch (e) {
      if (onBranch) console.warn('ChatGPT push: document fetch failed for', att.id, e);
      failures.push({ pointer: att.id, id: att.id, kind: 'document', name: att.name, ...classifyFetchFailure(e), onBranch, error: e.message || String(e) });
    } finally {
      if (onEach) onEach();
    }
  });
  // Vendor-resolved generated-UI pictures: same gate, pool and retry.
  const branchGenui = new Set((await collectChatGptGenuiImages(body)).map((g) => g.id));
  const genui = await collectChatGptGenuiImages(body, { wholeTree: true });
  // The collector already de-dups by content_url (and so by derived id); every
  // collected item is fetched and calls onEach, so "files N/M" reaches M.
  await pool(genui, concurrency, async (g) => {
    const onBranch = branchGenui.has(g.id);
    let pointer = g.content_url;
    try { const u = new URL(g.content_url); pointer = u.host + u.pathname; } catch { pointer = 'unparseable-url'; }
    const name = g.title || g.query || g.id;
    try {
      const got = await withChatGptRateLimitRetry(() => _fetchChatGptGenuiBytes(g.content_url));
      const rec = buildChatGptGenuiBlob(g, got.meta, got.dataUrl);
      if (rec) blobs.push(rec);
      else failures.push({ pointer, id: g.id, kind: 'genui', name, reason: 'other', status: null, onBranch, error: 'could not build files[] record (empty bytes)' });
    } catch (e) {
      if (onBranch) console.warn('ChatGPT push: generated picture fetch failed for', pointer, e);
      failures.push({ pointer, id: g.id, kind: 'genui', name, ...classifyFetchFailure(e, 'direct'), onBranch, error: e.message || String(e) });
    } finally {
      if (onEach) onEach();
    }
  });
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
// Map collected failures ({id, kind, reason, status, onBranch, error, ...}) to the
// ingest wire shape. Entries without an id are skipped (server keys on file_uuid).
function toWireFileFailures(failures) {
  if (!Array.isArray(failures)) return [];
  return failures.filter((f) => f && f.id).map((f) => ({
    file_uuid: f.id,
    kind: f.kind || 'image',
    reason: f.reason || 'other',
    status: Number.isInteger(f.status) ? f.status : null,
    on_branch: !!f.onBranch,
    error: String(f.error == null ? '' : f.error).replace(/https?:\/\/\S+/g, '<url>').slice(0, 500),
  }));
}

function buildChatGptIngestPayload(body, fileBlobs = [], fallbackConversationId = null, fileFailures = [], fetchReport = null) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const payload = { ...body };
  if (!payload.conversation_id && fallbackConversationId) {
    payload.conversation_id = fallbackConversationId;
  }
  if (Array.isArray(fileBlobs) && fileBlobs.length) payload.files = fileBlobs;
  const wire = toWireFileFailures(fileFailures);
  if (wire.length) payload.file_failures = wire;
  if (fetchReport) payload.fetch_report = fetchReport;
  return payload;
}

// Run `fn` and, on a ChatGptRateLimitError, wait out the gate's shared
// cooldown and try again (up to `maxRetries` more times). Only THIS request is
// retried; the wait is the gate's cooldown (which every other lane honours too),
// not a private timer. Any other error propagates untouched. `sleep` (when
// given) replaces the gate wait with the error's retryAfterMs -- kept for
// callers/tests that inject a clock; `gate` is injectable too; `onRetry(ms)`
// lets the page show "rate limited, waiting Ns" instead of going quiet.
async function withChatGptRateLimitRetry(fn, { maxRetries = CHATGPT_RATE_LIMIT_RETRIES, sleep = null, onRetry = null, gate = null } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof ChatGptRateLimitError) || attempt >= maxRetries) throw e;
      if (onRetry) onRetry(e.retryAfterMs);
      if (sleep) await sleep(e.retryAfterMs);
      else await (gate || chatGptGate).waitForCooldown();
    }
  }
}

// Node (vitest): expose the PURE surface for testing. Browser: these are globals.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    getChatGptBranch,
    findDeepestLeaf,
    buildChatGptIngestPayload,
    classifyFetchFailure,
    toWireFileFailures,
    withChatGptRateLimitRetry,
    ChatGptRateLimitError,
    createChatGptGate,
    _setChatGptGate,
    get chatGptGate() { return chatGptGate; },
    chatGptApiGet,
    listChatGptConversations,
    fetchChatGptConversation,
    CHATGPT_MIN_SPACING_MS,
    CHATGPT_COOLDOWN_SCHEDULE_MS,
    CHATGPT_COOLDOWN_RESET_MS,
    CHATGPT_ABORT_AFTER_COOLDOWNS,
    CHATGPT_IMAGE_POOL_DEFAULT,
    CHATGPT_DOCUMENT_MAX_BYTES,
    collectChatGptDocumentAttachments,
    collectChatGptGenuiImages,
    genuiFileUuid,
    buildChatGptGenuiBlob,
    CHATGPT_GENUI_MAX_BYTES,
    buildChatGptDocumentBlob,
    CHATGPT_BATCH_CONCURRENCY,
    CHATGPT_DEEP_SLICE,
    CHATGPT_CATCHUP_DELAY_MS,
    CHATGPT_CATCHUP_ALARM,
    CHATGPT_RATE_LIMIT_RETRIES,
    CHATGPT_REQUEST_TIMEOUT_MS,
    chatGptAssetId,
    buildChatGptFileBlob,
    chatGptPageReachesWatermark,
    listChatGptConversationsSince,
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
