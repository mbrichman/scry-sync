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

// The "Synced" column is SERVER TRUTH from Scry's reconcile, never the
// browser-local scrySyncedMap (that is a hint only: a fresh Chrome profile has
// an empty map while Scry holds everything). `report` is the (merged) reconcile
// response for the row's source: { to_resync, summary, extra, buckets? }.
//
// Returns 'missing' | 'incomplete' | 'stale' | 'needs-sync' | 'synced' | 'unknown'.
//  - no usable report (failed / unreachable / unauthorized) -> 'unknown',
//    NEVER 'missing': "no answer" must not masquerade as "Scry lacks it".
//  - report.buckets present -> exact bucket, else 'synced'.
//  - buckets absent (older server) -> in to_resync = 'needs-sync' (we cannot
//    tell missing from incomplete/stale), otherwise 'synced'.
function badgeFromReconcile(uuid, report) {
  if (!report || typeof report !== 'object') return 'unknown';
  const b = report.buckets;
  if (b && typeof b === 'object') {
    if ((b.missing || []).includes(uuid)) return 'missing';
    if ((b.incomplete || []).includes(uuid)) return 'incomplete';
    if ((b.stale || []).includes(uuid)) return 'stale';
    // Deleted in Scry on purpose (tombstone blocks resurrection): Scry does
    // NOT hold it, and it is not wanted either — never let it read as synced.
    if ((b.tombstoned || []).includes(uuid)) return 'tombstoned';
    return 'synced';
  }
  return (report.to_resync || []).includes(uuid) ? 'needs-sync' : 'synced';
}

// Badges that mean "Scry needs this pushed". 'unknown' is not actionable.
function badgeNeedsSync(badge) {
  return badge === 'missing' || badge === 'incomplete' || badge === 'stale' || badge === 'needs-sync';
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
    badgeFromReconcile,
    badgeNeedsSync,
    detectSyncTarget,
  };
}
