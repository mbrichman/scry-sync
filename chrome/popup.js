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
// Sourced from chrome.storage.local "continuousSync" (written by
// continuous_sync.js's runContinuousSync, driven by the alarms in
// background.js). Purely a read/render of persisted state — no sync logic
// here, matching the split between the engine and the UI everywhere else in
// this popup.

function formatRelativeTime(ms) {
  const diffMin = Math.round((Date.now() - ms) / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hr ago`;
  return `${Math.round(diffHr / 24)} d ago`;
}

function getContinuousSyncState() {
  return new Promise((resolve) =>
    chrome.storage.local.get(['continuousSync'], (r) => resolve(r.continuousSync || null)));
}

async function renderAutoSyncStatus() {
  const el = document.getElementById('autoSyncStatus');
  if (!el) return;

  // The options-page off-switch beats any state: say "off", not a stale
  // last-sync time or error.
  const scry = await new Promise((resolve) =>
    chrome.storage.local.get(['scry'], (r) => resolve(r.scry || {})));
  if (scry.continuousSync === false) {
    el.textContent = 'Auto-sync: off';
    el.className = 'auto-sync-status';
    return;
  }

  const state = await getContinuousSyncState();

  if (!state || (!state.lastSyncAt && !state.lastError)) {
    el.textContent = ''; // never woken yet (e.g. just installed)
    el.className = 'auto-sync-status';
    return;
  }

  if ((state.consecutiveFailures || 0) >= 3 && state.lastError) {
    const since = state.lastSyncAt ? formatRelativeTime(state.lastSyncAt) : 'install';
    const shortError = state.lastError.length > 60 ? `${state.lastError.slice(0, 57)}…` : state.lastError;
    el.textContent = `Auto-sync failing since ${since} — ${shortError}`;
    el.className = 'auto-sync-status error';
    return;
  }

  if (state.lastSyncAt) {
    el.textContent = `Auto-sync: ${formatRelativeTime(state.lastSyncAt)} · ${state.lastPushed || 0} pushed`;
    el.className = 'auto-sync-status';
    return;
  }

  el.textContent = '';
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
