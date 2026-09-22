// Capture unhandled errors for diagnostics (sanitized, stored in chrome.storage.local)
if (typeof initErrorCapture === 'function') initErrorCapture('popup');

// Claude org id — stored value first, direct credentialed auto-detect
// (chrome/scry_client.js's detectClaudeOrgId) otherwise. No tab relay: this
// works even when the active tab is the one being synced, not some other
// open claude.ai tab.
async function ensureClaudeOrgId() {
  const stored = await readOrgIdFromStorage();
  if (stored) return stored;
  return detectClaudeOrgId(); // throws if it fails — caller surfaces the message
}

// Which source + conversation id the ACTIVE TAB is looking at — the pure
// rule lives in dashboard_model.js's detectSyncTarget (shared with the
// dashboard) so both "claude.ai/chat/<uuid>" and "chatgpt.com/c/<id>" are
// recognized the same way everywhere. { source: null, uuid: null } on any
// other site.
async function getActiveTabSyncTarget() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return detectSyncTarget(tab && tab.url);
}

// Reflect the active tab's site on the Sync button: enabled + targeted at
// the right source when it's a specific Claude/ChatGPT conversation page,
// disabled with an explanatory hint everywhere else (including a source's
// non-conversation pages, e.g. the claude.ai homepage).
async function updateSyncButtonForActiveTab() {
  const button = document.getElementById('syncCurrent');
  if (!button) return;
  const { source, uuid } = await getActiveTabSyncTarget();
  if (!source) {
    button.disabled = true;
    button.title = 'Open a claude.ai or chatgpt.com conversation to sync it';
  } else if (!uuid) {
    button.disabled = true;
    button.title = `Open a specific ${source === 'claude' ? 'Claude' : 'ChatGPT'} conversation to sync it`;
  } else {
    button.disabled = false;
    button.title = '';
  }
}

function showStatus(message, type = 'info') {
  const statusEl = document.getElementById('status');
  statusEl.className = `status ${type}`;
  if (type === 'error' && message.includes('Options')) {
    statusEl.innerHTML = message.replace('Options', '<a href="#" id="statusOpenOptions">Options</a>');
    document.getElementById('statusOpenOptions').addEventListener('click', (e) => {
      e.preventDefault();
      chrome.runtime.openOptionsPage();
    });
  } else {
    statusEl.textContent = message;
  }
  if (type === 'success') {
    setTimeout(() => { statusEl.textContent = ''; statusEl.className = ''; }, 3000);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const manifest = chrome.runtime.getManifest();
  document.getElementById('header-title').textContent = manifest.name;
  document.getElementById('header-version').textContent = `v${manifest.version}`;
  renderAutoSyncStatus();
  updateSyncButtonForActiveTab();
});

// --- continuous background sync status line ---
// Sourced from chrome.storage.local under each source's own state key
// ("continuousSync" for Claude, "continuousSync:chatgpt" for ChatGPT — see
// SOURCES in sources.js), written by runContinuousSync /
// runAllContinuousSyncs, driven by the alarms in background.js. Purely a
// read/render of persisted state — no sync logic here, matching the split
// between the engine and the UI everywhere else in this popup.
//
// formatRelativeTime / getContinuousSyncStates / formatSourceStatus now live
// in chrome/scry_client.js (moved there this phase so the dashboard's footer
// status line can share them too — see chrome/browse.js's
// renderContinuousFooter) and are loaded as globals before this file.

async function renderAutoSyncStatus() {
  const el = document.getElementById('autoSyncStatus');
  if (!el) return;

  const scry = await new Promise((resolve) =>
    chrome.storage.local.get(['scry'], (r) => resolve(r.scry || {})));
  const claudeEnabled = scry.continuousSync !== false;
  // ChatGPT has two gates (SOURCES.chatgpt.isEnabled in sources.js):
  // the source itself (default OFF) and its continuous sub-toggle.
  const chatgptSourceEnabled = scry.chatgptEnabled === true;
  const chatgptSyncEnabled = chatgptSourceEnabled && scry.chatgptContinuousSync !== false;

  const states = await getContinuousSyncStates();

  const claudeLine = formatSourceStatus('Claude', claudeEnabled, states.claude);
  // ChatGPT never turned on at all → omit its line entirely rather than
  // showing "ChatGPT: off" or a stale "not signed in".
  const chatgptLine = chatgptSourceEnabled
    ? formatSourceStatus('ChatGPT', chatgptSyncEnabled, states.chatgpt)
    : null;

  const parts = [claudeLine, chatgptLine].filter(Boolean);
  if (parts.length === 0) {
    el.textContent = '';
    el.className = 'auto-sync-status';
    return;
  }

  const anyFailing = [states.claude, states.chatgpt].some(
    (s) => s && (s.consecutiveFailures || 0) >= 3 && s.lastError);
  el.textContent = parts.join(' · ');
  el.className = 'auto-sync-status' + (anyFailing ? ' error' : '');
}

// Sync the conversation currently open in the claude.ai tab.
document.getElementById('syncCurrent').addEventListener('click', async () => {
  const button = document.getElementById('syncCurrent');
  button.disabled = true;
  showStatus('Syncing…', 'info');

  try {
    const scry = await loadScrySettings();
    if (!scry.url) throw new Error('Set your Scry URL in Options first.');

    const { source, uuid } = await getActiveTabSyncTarget();
    if (!source) throw new Error('Open a claude.ai or chatgpt.com conversation first.');
    if (!uuid) throw new Error(`No conversation detected — open a specific ${source === 'claude' ? 'Claude' : 'ChatGPT'} chat.`);

    const granted = await ensureScryPermission(scry.url);
    if (!granted) throw new Error('Host permission for Scry was declined.');

    // SOURCES[source].syncOne (chrome/sources.js) — the same per-conversation
    // logic the dashboard and continuous sync use. ctx is built fresh per
    // click: Claude needs orgId up front; ChatGPT's syncOne fetches its own
    // token when ctx.token is absent, and defaults wantImages to true
    // (ctx.wantImages !== false) — images on, matching the dashboard's default.
    let ctx = {};
    if (source === 'claude') {
      const orgId = await ensureClaudeOrgId();
      if (!orgId) throw new Error('Could not determine organization ID. Set it in Options.');
      ctx = { orgId };
    }

    const result = await SOURCES[source].syncOne(ctx, { uuid }, scry);

    // Record the synced version so the dashboard's skip-unchanged agrees.
    // ChatGPT's syncOne result has no updatedAt (unlike Claude's) — fall back
    // to "now", same as the dashboard's per-row sync does for the same reason.
    const syncedMap = await getScrySyncedMap();
    syncedMap[uuid] = result.updatedAt || new Date().toISOString();
    await setScrySyncedMap(syncedMap);

    showStatus(`Synced to Scry (${result.status}) ✓`, 'success');
  } catch (error) {
    showStatus(error.message, 'error');
  } finally {
    button.disabled = false;
    await updateSyncButtonForActiveTab();
  }
});

document.getElementById('openDashboard').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('browse.html') });
});

document.getElementById('openSettings').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});
