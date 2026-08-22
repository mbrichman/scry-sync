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
function collectChatGptImagePointers(data) {
  const out = [];
  const seen = new Set();
  const push = (p) => { if (p && !seen.has(p)) { seen.add(p); out.push(p); } };

  for (const message of getChatGptBranch(data)) {
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
async function fetchChatGptImageDataUrl(token, pointer, accountId) {
  const id = String(pointer || '').replace(/^\w[\w+.-]*:\/\//, ''); // strip scheme://
  if (!id) return null;
  const meta = await chatGptApiGet(
    `${CHATGPT_API}/files/download/${encodeURIComponent(id)}?inline=false`, token, accountId);
  if (!meta || meta.status !== 'success' || !meta.download_url) return null;
  const resp = await fetch(meta.download_url, { credentials: 'omit' });
  if (!resp.ok) throw new Error(`image bytes ${resp.status}`);
  const dataUrl = await _blobToDataUrl(await resp.blob());
  // Prefer the real content-type over FileReader's guess.
  const ct = resp.headers.get('content-type') || meta.mime_type;
  return ct ? dataUrl.replace(/^data:[^;,]*/, `data:${ct}`) : dataUrl;
}

// Resolve many pointers concurrently into a { pointer -> data URL } map. Failures
// are logged and omitted (those images stay placeholders). `onEach()` fires after
// each pointer settles so the UI can show progress.
async function fetchChatGptImageDataUrls(token, pointers, accountId, onEach) {
  const map = {};
  await Promise.all((pointers || []).map(async (pointer) => {
    try {
      const url = await fetchChatGptImageDataUrl(token, pointer, accountId);
      if (url) map[pointer] = url;
    } catch (e) {
      console.warn('ChatGPT export: image resolve failed for', pointer, e);
    } finally {
      if (onEach) onEach();
    }
  }));
  return map;
}

// Node (vitest): expose the PURE surface for testing. Browser: these are globals.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    getChatGptBranch,
    findDeepestLeaf,
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
