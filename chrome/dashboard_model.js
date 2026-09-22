// Pure model for the unified dashboard (chrome/browse.js) — phase 3 of
// unifying the two source pages (the Claude "Browse" page and the retired
// ChatGPT PoC page) into one dashboard with source tabs. Everything here is
// Node/vitest-testable: no fetch, no chrome.*, no DOM.
//
// Also carries the popup's (chrome/popup.js) site-detection helper —
// `detectSyncTarget` — since it is the same "which source, which id" shape
// this file already owns, and popup.js is the other page that needs a pure,
// independently-testable answer to "what am I looking at" rather than a third
// copy of URL-parsing logic.

// --- source tabs ---------------------------------------------------------

const SOURCE_LABELS = { claude: 'Claude', chatgpt: 'ChatGPT' };

// Ordered list of source names whose TAB should be shown on the dashboard.
// Claude is always on (never gated — "Claude always on" per the owner's
// ruling). ChatGPT's tab requires BOTH the source being enabled
// (scry.chatgptEnabled === true) AND not being known-signed-out —
// `signedIn.chatgpt === false` is the only thing that hides it; `undefined`/
// `null` (not checked yet, or checked and fine) still shows it. A signed-out
// state is detected by the caller via getChatGptAccessToken failing with
// isChatGptSignedOutError (chrome/sources.js) and fed back in here — this
// function never does any detection itself.
//
// A single visible source means "no switcher" — that's a rendering decision
// for the caller (browse.js), not something this function encodes; it always
// just returns the ordered list.
function visibleSourceTabs({ scry, signedIn } = {}) {
  const s = scry || {};
  const signed = signedIn || {};
  const tabs = ['claude'];
  const chatgptEnabled = s.chatgptEnabled === true;
  const chatgptSignedOut = signed.chatgpt === false;
  if (chatgptEnabled && !chatgptSignedOut) tabs.push('chatgpt');
  return tabs;
}

// "Claude  1,204" — the tab label the mockup calls "keep the numbers" for.
// `count` is the enumerated conversation count for that source; null/undefined/
// non-finite renders as an em dash (still loading, or enumeration failed).
function tabLabel(source, count) {
  const name = SOURCE_LABELS[source] || source;
  return `${name} ${_formatCount(count)}`;
}

// Manual thousands-separator formatter — deliberately NOT Number.toLocaleString,
// so this has no ICU/environment dependency and is exact everywhere the same way.
function _formatCount(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  const neg = n < 0;
  const digits = Math.abs(Math.trunc(n)).toString();
  const withCommas = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + withCommas;
}

// --- row mapping -----------------------------------------------------------

const SOURCE_CHAT_URL = {
  claude: (uuid) => `https://claude.ai/chat/${uuid}`,
  chatgpt: (uuid) => `https://chatgpt.com/c/${uuid}`,
};

// Map one enumerated item (either a Claude conversation object — `.name` is
// the title — or a normalizeChatGptListItem-shaped ChatGPT item — `.title` —
// plus whatever `.model` the caller has already resolved for it, e.g. via
// browse.js's getDisplayModel for Claude) onto the table row shape shared by
// both sources. `openUrl` is the conversation's page AT THE SOURCE — the
// per-row "open at source" action the owner ruled every row keeps.
function toRow(source, item) {
  const it = item || {};
  const uuid = it.uuid || null;
  const title = (source === 'claude' ? (it.name || it.title) : (it.title || it.name)) || 'Untitled';
  const buildUrl = SOURCE_CHAT_URL[source];
  return {
    uuid,
    title,
    updated_at: it.updated_at || null,
    model: it.model || null,
    openUrl: (buildUrl && uuid) ? buildUrl(uuid) : null,
  };
}

// --- synced badge ------------------------------------------------------------

// Classify one row's sync status from a LOCAL synced-map comparison — the
// same "has this browser pushed the current version" signal browse.js has
// always tracked (chrome/scry_client.js's scrySyncedMap: uuid -> last-synced
// source updated_at), reframed from the old table's green dot into the
// mockup's "Synced" column badge. This is a client-side proxy, not a live
// Scry-side truth (that needs the Reconcile action's server round trip) —
// good enough for an at-a-glance table cell.
//
// `entry`: null/undefined (no local record at all — never synced from this
// browser) or { syncedAt: <ISO, the source updated_at last pushed>,
// updatedAt: <ISO, the conversation's CURRENT updated_at> }.
// Returns 'missing' | 'stale' | 'synced' | 'unknown'.
function syncedBadge(entry) {
  if (!entry || !entry.syncedAt) return 'missing';
  if (!entry.updatedAt) return 'unknown';
  const synced = Date.parse(entry.syncedAt);
  const updated = Date.parse(entry.updatedAt);
  if (Number.isNaN(synced) || Number.isNaN(updated)) return 'unknown';
  return synced >= updated ? 'synced' : 'stale';
}

// --- popup: which source/conversation is the active tab looking at? --------

// claude.ai/chat/<uuid> (uuid = a v4 UUID) vs chatgpt.com/c/<id> (id shape
// varies — not always a UUID). `url` is the active tab's full URL (as
// chrome.tabs.query hands it over). Returns { source, uuid }; both null when
// the URL doesn't match a known source or isn't a conversation page (e.g. the
// claude.ai homepage, or a non-matching site entirely).
function detectSyncTarget(url) {
  if (typeof url !== 'string' || !url) return { source: null, uuid: null };
  let u;
  try { u = new URL(url); } catch { return { source: null, uuid: null }; }

  if (u.hostname === 'claude.ai') {
    const m = u.pathname.match(/\/chat\/([a-f0-9-]+)/i);
    return { source: 'claude', uuid: m ? m[1] : null };
  }
  if (u.hostname === 'chatgpt.com' || u.hostname === 'chat.openai.com') {
    const m = u.pathname.match(/\/c\/([a-zA-Z0-9-]+)/);
    return { source: 'chatgpt', uuid: m ? m[1] : null };
  }
  return { source: null, uuid: null };
}

// Browser: expose globally. Node (vitest): export.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SOURCE_LABELS,
    visibleSourceTabs,
    tabLabel,
    toRow,
    syncedBadge,
    detectSyncTarget,
  };
}
