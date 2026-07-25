// Capture unhandled errors for diagnostics (sanitized, stored in chrome.storage.local)
if (typeof initErrorCapture === 'function') initErrorCapture('options');

// Load saved settings
document.addEventListener('DOMContentLoaded', () => {
  chrome.storage.sync.get(['organizationId'], (result) => {
    if (result.organizationId) {
      document.getElementById('orgId').value = result.organizationId;
      showStatus('status', 'Organization ID loaded from saved settings', 'success');
      setTimeout(() => hideStatus('status'), 2000);
    }
  });
});

// Save settings
document.getElementById('saveBtn').addEventListener('click', () => {
  const orgId = document.getElementById('orgId').value.trim();
  
  if (!orgId) {
    showStatus('status', 'Please enter an Organization ID', 'error');
    return;
  }
  
  // Validate UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(orgId)) {
    showStatus('status', 'Invalid Organization ID format. It should be a UUID like: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx', 'error');
    return;
  }
  
  chrome.storage.sync.set({ organizationId: orgId }, () => {
    showStatus('status', 'Settings saved successfully!', 'success');
  });
});

// Test connection
document.getElementById('testBtn').addEventListener('click', async () => {
  const orgId = document.getElementById('orgId').value.trim();
  
  if (!orgId) {
    showStatus('testStatus', 'Please save an Organization ID first', 'error');
    return;
  }
  
  showStatus('testStatus', 'Testing connection...', 'success');
  
  try {
    const response = await fetch(`https://claude.ai/api/organizations/${orgId}/chat_conversations`, {
      credentials: 'include',
      headers: {
        'Accept': 'application/json',
      }
    });
    
    if (response.ok) {
      const data = await response.json();
      showStatus('testStatus', `Success! Found ${data.length} conversations.`, 'success');
    } else if (response.status === 401) {
      showStatus('testStatus', 'Not authenticated. Please make sure you are logged into claude.ai', 'error');
    } else if (response.status === 403) {
      showStatus('testStatus', 'Access denied. The Organization ID might be incorrect.', 'error');
    } else {
      showStatus('testStatus', `Connection failed with status: ${response.status}`, 'error');
    }
  } catch (error) {
    showStatus('testStatus', `Connection error: ${error.message}`, 'error');
  }
});

// Backup all extension data to a file (shared logic lives in utils.js)
document.getElementById('backupBtn').addEventListener('click', () => {
  backupExtensionData((success, message) => {
    showStatus('backupStatus', message, success ? 'success' : 'error');
  });
});

// Restore extension data from a backup file. Flow: click → mode-choice modal
// → file picker → import. The mode is held in pendingImportMode across the
// async file-picker boundary.
let pendingImportMode = null;

document.getElementById('restoreBtn').addEventListener('click', () => {
  showImportModeModal((mode) => {
    if (mode === null) return; // user cancelled the modal
    pendingImportMode = mode;
    document.getElementById('restoreFile').click();
  });
});

document.getElementById('restoreFile').addEventListener('change', (event) => {
  const file = event.target.files[0];
  event.target.value = ''; // allow re-selecting the same file later
  const mode = pendingImportMode;
  pendingImportMode = null; // consume; never reuse a stale mode
  if (!file || !mode) return;
  importBackup(file, mode, (success, message) => {
    showStatus('backupStatus', message, success ? 'success' : 'error');
  });
});

// Date & Time format preferences (displayed in the browse view)
function loadDateTimeFormatPrefs() {
  chrome.storage.local.get(['dateFormat', 'timeFormat'], (result) => {
    document.getElementById('dateFormatSelect').value = result.dateFormat || 'mdy';
    document.getElementById('timeFormatSelect').value = result.timeFormat || '12h';
  });
}
loadDateTimeFormatPrefs();

document.getElementById('dateFormatSelect').addEventListener('change', (e) => {
  chrome.storage.local.set({ dateFormat: e.target.value }, () => {
    showStatus('dateTimeStatus', 'Date format saved. Reload the browse page to see the change.', 'success');
  });
});

document.getElementById('timeFormatSelect').addEventListener('change', (e) => {
  chrome.storage.local.set({ timeFormat: e.target.value }, () => {
    showStatus('dateTimeStatus', 'Time format saved. Reload the browse page to see the change.', 'success');
  });
});

// Model display preference (browse view's Model column)
function loadModelDisplayPref() {
  chrome.storage.local.get(['modelDisplay'], (result) => {
    const value = result.modelDisplay === 'current' ? 'current' : 'original';
    const radio = document.querySelector(`input[name="modelDisplay"][value="${value}"]`);
    if (radio) radio.checked = true;
  });
}
loadModelDisplayPref();

document.querySelectorAll('input[name="modelDisplay"]').forEach((radio) => {
  radio.addEventListener('change', (e) => {
    chrome.storage.local.set({ modelDisplay: e.target.value }, () => {
      showStatus('modelDisplayStatus', 'Model display preference saved. Reload the browse page to see the change.', 'success');
    });
  });
});

// Contact & Diagnostics
document.getElementById('emailDevLink').addEventListener('click', (e) => {
  e.preventDefault();
  const version = chrome.runtime.getManifest().version;
  const subject = encodeURIComponent(`Scry Sync Bug Report — v${version}`);
  const body = encodeURIComponent('Describe the issue here. If this is a bug, please attach a diagnostics file generated from the Options page.\n\n');
  window.location.href = `mailto:agoramachina@gmail.com?subject=${subject}&body=${body}`;
});

document.getElementById('generateDiagnosticsLink').addEventListener('click', (e) => {
  e.preventDefault();
  generateDiagnostics((success, message) => {
    showStatus('contactStatus', message, success ? 'success' : 'error');
  });
});

// Helper functions
function showStatus(elementId, message, type) {
  const statusEl = document.getElementById(elementId);
  statusEl.textContent = message;
  statusEl.className = `status ${type}`;
}

function hideStatus(elementId) {
  const statusEl = document.getElementById(elementId);
  statusEl.className = 'status';
}

// ===== Scry Sync settings =====

// Derive an "origin/*" match pattern for the optional host permission request.
function scryOriginPattern(url) {
  try {
    return new URL(url).origin + '/*';
  } catch {
    return null;
  }
}

// Load saved Scry settings into the form.
document.addEventListener('DOMContentLoaded', () => {
  chrome.storage.local.get(['scry'], (result) => {
    const scry = result.scry || {};
    if (scry.url) document.getElementById('scryUrl').value = scry.url;
    if (scry.token) document.getElementById('scryToken').value = scry.token;
    document.getElementById('scryConcurrency').value = scry.concurrency || 4;
  });
});

document.getElementById('saveScryBtn').addEventListener('click', () => {
  const url = document.getElementById('scryUrl').value.trim().replace(/\/+$/, '');
  const token = document.getElementById('scryToken').value.trim();

  if (!url || !scryOriginPattern(url)) {
    showStatus('scryStatus', 'Enter a valid Scry URL (e.g. http://localhost:5001)', 'error');
    return;
  }
  if (token && token.length < 16) {
    showStatus('scryStatus', 'Service token must be at least 16 characters', 'error');
    return;
  }

  // How many conversations the bulk sync processes at once. Clamp to a sane
  // range so a typo can't hammer claude.ai or stall on a huge value.
  let concurrency = parseInt(document.getElementById('scryConcurrency').value, 10);
  if (!Number.isFinite(concurrency)) concurrency = 4;
  concurrency = Math.max(1, Math.min(concurrency, 12));

  // Pre-request the host permission so the later sync fetch isn't blocked.
  chrome.permissions.request({ origins: [scryOriginPattern(url)] }, (granted) => {
    chrome.storage.local.set({ scry: { url, token, concurrency } }, () => {
      showStatus('scryStatus',
        granted ? 'Scry settings saved.' : 'Saved, but host permission was declined — sync will fail until granted.',
        granted ? 'success' : 'error');
      setTimeout(() => hideStatus('scryStatus'), 4000);
    });
  });
});

document.getElementById('testScryBtn').addEventListener('click', async () => {
  const url = document.getElementById('scryUrl').value.trim().replace(/\/+$/, '');
  const token = document.getElementById('scryToken').value.trim();
  const pattern = scryOriginPattern(url);
  if (!pattern) {
    showStatus('scryStatus', 'Enter a valid Scry URL first', 'error');
    return;
  }

  showStatus('scryStatus', 'Testing…', 'info');
  const granted = await new Promise((resolve) =>
    chrome.permissions.request({ origins: [pattern] }, resolve));
  if (!granted) {
    showStatus('scryStatus', 'Host permission declined — cannot reach Scry', 'error');
    return;
  }

  try {
    // A POST with a valid token but empty body returns 200 {success:false,...}
    // from the ingest endpoint — enough to confirm URL + token are accepted.
    const resp = await fetch(`${url}/api/conversations/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: '{}',
    });
    if (resp.status === 200) {
      showStatus('scryStatus', 'Connected — Scry URL and token accepted ✓', 'success');
    } else if (resp.status === 401) {
      showStatus('scryStatus', 'Reached Scry, but the service token was rejected (401)', 'error');
    } else if (resp.status === 503) {
      showStatus('scryStatus', 'Scry has no SCRY_SERVICE_TOKEN configured (503)', 'error');
    } else {
      showStatus('scryStatus', `Unexpected response from Scry: ${resp.status}`, 'error');
    }
  } catch (e) {
    showStatus('scryStatus', `Could not reach Scry: ${e.message}`, 'error');
  }
});
