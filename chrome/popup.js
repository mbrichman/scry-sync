// Capture unhandled errors for diagnostics (sanitized, stored in chrome.storage.local)
if (typeof initErrorCapture === 'function') initErrorCapture('popup');

// Get organization ID from storage (fallback)
async function getStoredOrgId() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(['organizationId'], (result) => resolve(result.organizationId));
  });
}

// Auto-detect organization ID via content script, fall back to stored.
async function getOrgId() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && tab.url.includes('claude.ai')) {
      const response = await new Promise((resolve) => {
        chrome.tabs.sendMessage(tab.id, { action: 'detectOrgId' }, (res) => {
          resolve(chrome.runtime.lastError ? null : res);
        });
      });
      if (response && response.success && response.orgId) {
        chrome.storage.sync.set({ organizationId: response.orgId });
        return response.orgId;
      }
    }
  } catch (e) {
    console.log('Auto-detect org ID failed, falling back to stored:', e);
  }
  return getStoredOrgId();
}

// Current conversation UUID from the active claude.ai tab URL.
async function getCurrentConversationId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) return null;
  const match = new URL(tab.url).pathname.match(/\/chat\/([a-f0-9-]+)/);
  return match ? match[1] : null;
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
});

// --- continuous background sync status line ---
// Sourced from chrome.storage.local under each source's own state key
// ("continuousSync" for Claude, "continuousSync:chatgpt" for ChatGPT — see
// SOURCES in continuous_sync.js), written by runContinuousSync /
// runAllContinuousSyncs, driven by the alarms in background.js. Purely a
// read/render of persisted state — no sync logic here, matching the split
// between the engine and the UI everywhere else in this popup.

function formatRelativeTime(ms) {
  const diffMin = Math.round((Date.now() - ms) / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hr ago`;
  return `${Math.round(diffHr / 24)} d ago`;
}

function getContinuousSyncStates() {
  return new Promise((resolve) =>
    chrome.storage.local.get(['continuousSync', 'continuousSync:chatgpt'], (r) =>
      resolve({ claude: r.continuousSync || null, chatgpt: r['continuousSync:chatgpt'] || null })));
}

// One source's compact status fragment: "<Label>: off" / "not yet synced" /
// "synced 12 min ago" / "failing since 2 hr ago — <error>" / a plain
// non-failure lastError (e.g. ChatGPT's "not signed in to chatgpt.com" — see
// continuous_sync.js's runContinuousSync 'signed-out' path, which records
// lastError WITHOUT bumping consecutiveFailures, so it must not be rendered
// as a failure streak).
function formatSourceStatus(label, enabled, state) {
  if (!enabled) return `${label}: off`;
  if (!state || (!state.lastSyncAt && !state.lastError)) return `${label}: not yet synced`;

  if ((state.consecutiveFailures || 0) >= 3 && state.lastError) {
    const since = state.lastSyncAt ? formatRelativeTime(state.lastSyncAt) : 'install';
    const shortError = state.lastError.length > 40 ? `${state.lastError.slice(0, 37)}…` : state.lastError;
    return `${label}: failing since ${since} — ${shortError}`;
  }

  if (state.lastError && !(state.consecutiveFailures > 0)) {
    return `${label}: ${state.lastError}`;
  }

  if (state.lastSyncAt) return `${label}: synced ${formatRelativeTime(state.lastSyncAt)}`;

  return `${label}: —`;
}

async function renderAutoSyncStatus() {
  const el = document.getElementById('autoSyncStatus');
  if (!el) return;

  const scry = await new Promise((resolve) =>
    chrome.storage.local.get(['scry'], (r) => resolve(r.scry || {})));
  const claudeEnabled = scry.continuousSync !== false;
  // ChatGPT has two gates (SOURCES.chatgpt.isEnabled in continuous_sync.js):
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

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || !tab.url.includes('claude.ai')) {
      throw new Error('Open a claude.ai conversation first.');
    }

    const orgId = await getOrgId();
    if (!orgId) throw new Error('Could not determine organization ID. Set it in Options.');
    const conversationId = await getCurrentConversationId();
    if (!conversationId) throw new Error('No conversation detected — open a claude.ai chat.');

    const granted = await ensureScryPermission(scry.url);
    if (!granted) throw new Error('Host permission for Scry was declined.');

    const result = await syncOneConversation(orgId, conversationId, scry);

    // Record the synced version so the dashboard's skip-unchanged agrees.
    const syncedMap = await getScrySyncedMap();
    syncedMap[conversationId] = result.updatedAt;
    await setScrySyncedMap(syncedMap);

    showStatus(`Synced to Scry (${result.status}) ✓`, 'success');
  } catch (error) {
    showStatus(error.message, 'error');
  } finally {
    button.disabled = false;
  }
});

document.getElementById('openDashboard').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('browse.html') });
});

document.getElementById('openSettings').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});
