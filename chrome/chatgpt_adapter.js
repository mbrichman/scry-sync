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

// Should this message appear in an export? Drops system prompts, visually
// hidden scaffolding, and empty/zero-weight turns. Tool messages are kept only
// when they carry visible text (e.g. DALL·E / code output shown to the user).
function isDisplayableChatGptMessage(message) {
  if (!message || !message.author) return false;
  const role = message.author.role;
  if (role === 'system') return false;

  const meta = message.metadata || {};
  if (meta.is_visually_hidden_from_conversation === true) return false;

  // weight 0 marks a superseded/■ pruned turn in some payloads.
  if (message.weight === 0) return false;

  return chatGptMessageText(message).trim().length > 0;
}

// Extract displayable text from a ChatGPT message's content, across the content
// types the web app produces. Image parts in multimodal_text are rendered as a
// markdown placeholder (this PoC does not fetch image bytes).
function chatGptMessageText(message) {
  const content = message && message.content;
  if (!content) return '';

  const type = content.content_type;

  // text / multimodal_text: `parts` is an array of strings and/or asset objects.
  if (Array.isArray(content.parts)) {
    return content.parts.map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object') {
        // image_asset_pointer and friends — render a stable placeholder.
        if (part.content_type === 'image_asset_pointer' || part.asset_pointer) {
          return `![image](${part.asset_pointer || 'image'})`;
        }
        if (typeof part.text === 'string') return part.text;
      }
      return '';
    }).filter(Boolean).join('\n');
  }

  // code: the source lives on content.text; wrap it fenced.
  if (type === 'code' && typeof content.text === 'string') {
    const lang = content.language && content.language !== 'unknown' ? content.language : '';
    return '```' + lang + '\n' + content.text + '\n```';
  }

  // execution_output / tether_* and other text-bearing types.
  if (typeof content.text === 'string') return content.text;

  return '';
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

// Reduce a raw ChatGPT conversation body to a source-agnostic shape. This is the
// adapter's contract: whatever the source, we produce { id, title, created_at,
// updated_at, model, messages: [{ role, text, model, created_at }] }. That shape
// is what a future buildIngestPayload-style step (or the exporter below) consumes.
function normalizeChatGptConversation(data) {
  const branch = getChatGptBranch(data).filter(isDisplayableChatGptMessage);
  const convModel = data.default_model_slug || null;

  const messages = branch.map((m) => ({
    role: m.author && m.author.role ? m.author.role : 'unknown',
    text: chatGptMessageText(m),
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
// ChatGPT body or an already-normalized object (duck-typed on `messages`).
function convertChatGptToMarkdown(dataOrNormalized) {
  const conv = Array.isArray(dataOrNormalized && dataOrNormalized.messages)
    ? dataOrNormalized
    : normalizeChatGptConversation(dataOrNormalized);

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

// The normalized JSON export — pretty-printed, source-agnostic shape.
function chatGptConversationToJson(data) {
  return JSON.stringify(normalizeChatGptConversation(data), null, 2);
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

function chatGptAuthHeaders(token) {
  return { 'Accept': 'application/json', 'Authorization': `Bearer ${token}` };
}

// One page of the conversation list.
async function listChatGptConversations(token, { offset = 0, limit = 28 } = {}) {
  const url = `${CHATGPT_ORIGIN}/backend-api/conversations?offset=${offset}&limit=${limit}&order=updated`;
  const resp = await fetch(url, { credentials: 'include', headers: chatGptAuthHeaders(token) });
  if (!resp.ok) throw new Error(`conversations list ${resp.status}`);
  return resp.json();
}

// Enumerate ALL conversations by paginating until exhausted. `onProgress(count)`
// is called after each page so the UI can show progress.
async function listAllChatGptConversations(token, onProgress) {
  const limit = 100;
  let offset = 0;
  const all = [];
  for (;;) {
    const page = await listChatGptConversations(token, { offset, limit });
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
async function fetchChatGptConversation(token, conversationId) {
  const url = `${CHATGPT_ORIGIN}/backend-api/conversation/${conversationId}`;
  const resp = await fetch(url, { credentials: 'include', headers: chatGptAuthHeaders(token) });
  if (!resp.ok) throw new Error(`conversation ${conversationId}: ${resp.status}`);
  return resp.json();
}

// Node (vitest): expose the PURE surface for testing. Browser: these are globals.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    getChatGptBranch,
    findDeepestLeaf,
    isDisplayableChatGptMessage,
    chatGptMessageText,
    chatGptTimeToIso,
    normalizeChatGptConversation,
    convertChatGptToMarkdown,
    chatGptConversationToJson,
    slugifyChatGptTitle,
  };
}
