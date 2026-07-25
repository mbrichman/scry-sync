// Helper function to format datetime in local time for filenames
function getLocalDateTimeString() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

// Helper function to escape HTML to prevent XSS
function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Theme management
function initTheme() {
  const savedTheme = localStorage.getItem('theme');
  if (savedTheme) {
    document.documentElement.setAttribute('data-theme', savedTheme);
  } else {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
  }
}

function toggleTheme() {
  const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', newTheme);
  localStorage.setItem('theme', newTheme);
}

// State management
let allConversations = [];
let filteredConversations = [];
let allProjects = [];
let projectsMap = {}; // Map project UUID to project name
let orgId = null;
let currentSort = 'updated_desc';
let sortStack = []; // Track multi-level sorting: [{field: 'name', direction: 'asc'}, ...]
let selectedConversations = new Set(); // Track selected conversation IDs
let lastCheckedIndex = null; // Track last checked checkbox for shift+click range selection
let exportTimestamps = {}; // Map conversation UUID to last export timestamp
let modelSnapshots = {}; // Map conversation UUID to { firstSeen, current, ... } captured by content.js
let statusFilter = 'all'; // 'all', 'new', 'exported', or 'projects' (search scope = project names)
let dateFormat = 'mdy'; // 'mdy' or 'dmy'
let timeFormat = '12h'; // '12h' or '24h'
let modelDisplay = 'original'; // 'original' (first-seen) or 'current'

// Sync-state storage helper. Backed by scrySyncedMap { uuid -> last-synced
// updated_at }, so the table's status reflects what's been pushed to Scry.
async function loadExportTimestamps() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['scrySyncedMap'], (result) => {
      exportTimestamps = result.scrySyncedMap || {};
      resolve();
    });
  });
}

// Model snapshots are written by content.js whenever the conversation list is
// fetched (see recordModelSnapshots). They preserve the original model even
// after a chat is bounced to a newer one on model retirement.
async function loadModelSnapshots() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['modelSnapshots'], (result) => {
      modelSnapshots = result.modelSnapshots || {};
      resolve();
    });
  });
}

// Resolve which model to show for a conversation. Honors the modelDisplay
// preference ('original' default, or 'current'). When the chat has been
// bounced (current differs from first-seen), `bounced` is true and the
// `*` marker shows the "other" model in its tooltip.
function getDisplayModel(conv) {
  const snap = modelSnapshots[conv.uuid];
  if (snap && snap.firstSeen) {
    const original = snap.firstSeen;
    const current = snap.current || snap.firstSeen;
    const bounced = !!snap.current && snap.current !== snap.firstSeen;
    const useCurrent = modelDisplay === 'current';
    return {
      model: useCurrent ? current : original,
      other: useCurrent ? original : current,
      otherLabel: useCurrent ? 'Originally' : 'Currently',
      bounced
    };
  }
  return { model: conv.model, other: conv.model, otherLabel: '', bounced: false };
}

async function saveExportTimestamp(conversationId) {
  exportTimestamps[conversationId] = new Date().toISOString();
  return new Promise((resolve) => {
    chrome.storage.local.set({ exportTimestamps }, resolve);
  });
}

async function saveExportTimestamps(conversationIds) {
  const now = new Date().toISOString();
  for (const id of conversationIds) {
    exportTimestamps[id] = now;
  }
  return new Promise((resolve) => {
    chrome.storage.local.set({ exportTimestamps }, resolve);
  });
}

async function loadDateTimePrefs() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['dateFormat', 'timeFormat'], (result) => {
      dateFormat = result.dateFormat || 'mdy';
      timeFormat = result.timeFormat || '12h';
      resolve();
    });
  });
}

async function loadModelDisplayPref() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['modelDisplay'], (result) => {
      modelDisplay = result.modelDisplay === 'current' ? 'current' : 'original';
      resolve();
    });
  });
}

function formatDate(dt) {
  const m = dt.getMonth() + 1;
  const d = dt.getDate();
  const y = dt.getFullYear();
  return dateFormat === 'dmy' ? `${d}/${m}/${y}` : `${m}/${d}/${y}`;
}

function formatTime(dt) {
  if (timeFormat === '24h') {
    return dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  return dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });
}

function isNewOrUpdated(conv) {
  const lastExport = exportTimestamps[conv.uuid];
  if (!lastExport) return true; // Never exported
  return new Date(conv.updated_at) > new Date(lastExport);
}

// When user navigates back to this page from the options page (bfcache hit),
// reload so changed preferences (model display, date/time format, etc.) take
// effect without a manual refresh.
window.addEventListener('pageshow', (event) => {
  if (event.persisted) window.location.reload();
});

// Initialize on page load
document.addEventListener('DOMContentLoaded', async () => {
  initTheme();
  // Wire up UI listeners (settings dropdown, filters, search, etc.) immediately
  // so the chrome stays interactive while orgId / conversations are still loading.
  setupEventListeners();
  const loadingStart = Date.now();
  await loadOrgId();
  await loadExportTimestamps();
  await loadModelSnapshots();
  await loadDateTimePrefs();
  await loadModelDisplayPref();
  const elapsed = Date.now() - loadingStart;
  if (elapsed < 1000) await new Promise(r => setTimeout(r, 1000 - elapsed));
  const loadingText = document.getElementById('loadingText');
  if (loadingText) loadingText.textContent = 'Loading conversations...';
  await loadConversations();
});

// Load organization ID — auto-detect first, fall back to stored
async function loadOrgId() {
  // Try auto-detect via content script on a claude.ai tab
  try {
    const response = await sendMessageToClaudeTab('detectOrgId', {});
    if (response && response.success && response.orgId) {
      orgId = response.orgId;
      // Save for future use / fallback
      chrome.storage.sync.set({ organizationId: orgId });
      console.log('Auto-detected organization ID:', orgId);
      return;
    }
  } catch (e) {
    console.log('Auto-detect org ID failed, falling back to stored:', e);
  }

  // Fall back to stored org ID
  return new Promise((resolve) => {
    chrome.storage.sync.get(['organizationId'], (result) => {
      orgId = result.organizationId;
      if (!orgId) {
        showError('Organization ID not configured. Please open a claude.ai tab and reload this page, or configure it manually in the extension options.');
      }
      resolve();
    });
  });
}

// Helper function to find a claude.ai tab and send a message
function sendMessageToClaudeTab(action, data) {
  return new Promise((resolve, reject) => {
    // Find a claude.ai tab using callback
    chrome.tabs.query({ url: 'https://claude.ai/*' }, (tabs) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      if (!tabs || tabs.length === 0) {
        reject(new Error('Please open a claude.ai tab first to use this feature'));
        return;
      }

      // Send message to the first claude.ai tab
      chrome.tabs.sendMessage(tabs[0].id, { action, ...data }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (response && response.success) {
          resolve(response);
        } else {
          reject(new Error(response?.error || 'Request failed'));
        }
      });
    });
  });
}

// Load projects from API via content script
async function loadProjects() {
  if (!orgId) return [];

  try {
    const response = await sendMessageToClaudeTab('loadProjects', { orgId });
    const projects = response.projects;
    console.log(`Loaded ${projects.length} projects:`, projects);

    // Store projects globally and build map
    allProjects = projects;
    projectsMap = {};
    projects.forEach(project => {
      const projectId = project.uuid || project.id;
      const projectName = project.name || project.title || 'Untitled Project';
      projectsMap[projectId] = projectName;
    });

    return projects;
  } catch (error) {
    console.warn('Error loading projects:', error);
    return [];
  }
}

// Load all conversations
async function loadConversations() {
  if (!orgId) return;

  try {
    // Load projects first
    const projects = await loadProjects();

    const response = await sendMessageToClaudeTab('loadConversations', { orgId });
    allConversations = response.conversations;
    console.log(`Loaded ${allConversations.length} conversations`);

    // Log first conversation to see structure
    if (allConversations.length > 0) {
      console.log('Sample conversation structure:', allConversations[0]);
    }

    // Infer models for conversations with null model
    allConversations = allConversations.map(conv => ({
      ...conv,
      model: inferModel(conv)
    }));

    // Apply initial sort and display
    applyFiltersAndSort();
    
  } catch (error) {
    console.error('Error loading conversations:', error);
    showError(`Failed to load conversations: ${error.message}`);
  }
}

// Get project name for a conversation
function getProjectName(conversation) {
  const projectId = conversation.project_uuid || conversation.project_id || conversation.projectUuid;
  if (!projectId) return '-';
  return projectsMap[projectId] || '-';
}

// Apply filters and sorting
function applyFiltersAndSort() {
  const searchTerm = document.getElementById('searchInput').value.toLowerCase();

  // Filter conversations
  filteredConversations = allConversations.filter(conv => {
    // 'projects' mode: search scope becomes the project name, status filters do not apply
    if (statusFilter === 'projects') {
      if (!searchTerm) return true;
      const projectName = getProjectName(conv);
      return projectName && projectName !== '-' && projectName.toLowerCase().includes(searchTerm);
    }

    const matchesSearch = !searchTerm ||
      conv.name.toLowerCase().includes(searchTerm) ||
      (conv.summary && conv.summary.toLowerCase().includes(searchTerm));

    // Status filter
    let matchesStatus = true;
    if (statusFilter === 'new') {
      matchesStatus = isNewOrUpdated(conv);
    } else if (statusFilter === 'synced') {
      matchesStatus = !isNewOrUpdated(conv);
    }

    return matchesSearch && matchesStatus;
  });

  // Sort conversations
  sortConversations();

  // Reset last checked index when list changes
  lastCheckedIndex = null;

  // Update display
  displayConversations();
  updateStats();
}

// Sort conversations based on current sort setting
function sortConversations() {
  // If sortStack is empty, use currentSort from dropdown
  if (sortStack.length === 0) {
    const [field, direction] = currentSort.split('_');
    sortStack = [{field, direction}];
  }

  filteredConversations.sort((a, b) => {
    // Try each sort criterion in order until we find a difference
    for (const {field, direction} of sortStack) {
      let aVal, bVal;

      switch (field) {
        case 'name':
          aVal = a.name.toLowerCase();
          bVal = b.name.toLowerCase();
          break;
        case 'project':
          aVal = getProjectName(a).toLowerCase();
          bVal = getProjectName(b).toLowerCase();
          break;
        case 'created':
          aVal = new Date(a.created_at);
          bVal = new Date(b.created_at);
          break;
        case 'updated':
          aVal = new Date(a.updated_at);
          bVal = new Date(b.updated_at);
          break;
        case 'model':
          aVal = formatModelName(getDisplayModel(a).model || '').toLowerCase();
          bVal = formatModelName(getDisplayModel(b).model || '').toLowerCase();
          break;
        default:
          continue;
      }

      let comparison = 0;
      if (aVal > bVal) comparison = 1;
      else if (aVal < bVal) comparison = -1;

      if (comparison !== 0) {
        return direction === 'asc' ? comparison : -comparison;
      }
    }
    return 0;
  });
}

// Handle column header click for sorting
function handleColumnSort(field) {
  const existingIndex = sortStack.findIndex(s => s.field === field);

  if (existingIndex === 0) {
    // Clicking primary sort: toggle direction
    sortStack[0].direction = sortStack[0].direction === 'asc' ? 'desc' : 'asc';
  } else if (existingIndex > 0) {
    // Clicking a secondary sort: move it to primary position
    const [sortCriterion] = sortStack.splice(existingIndex, 1);
    sortStack.unshift(sortCriterion);
  } else {
    // New sort: add to front with ascending direction
    sortStack.unshift({field, direction: 'asc'});
  }

  applyFiltersAndSort();
}

// Get sort indicator for a column
function getSortIndicator(field) {
  const sortIndex = sortStack.findIndex(s => s.field === field);

  // Only show indicator for the primary (most recent) sort
  if (sortIndex !== 0) return '';

  const {direction} = sortStack[sortIndex];
  const primaryArrow = direction === 'asc' ? '↑' : '↓';
  const secondaryArrow = direction === 'asc' ? '↓' : '↑';

  return ` <span class="sort-indicator">${primaryArrow}<sub>${secondaryArrow}</sub></span>`;
}

// Display conversations in table
function displayConversations() {
  const tableContent = document.getElementById('tableContent');

  if (filteredConversations.length === 0) {
    tableContent.innerHTML = '<div class="no-results">No conversations found</div>';
    return;
  }

  let html = `
    <table>
      <thead>
        <tr>
          <th class="sortable" data-sort="name">Name${getSortIndicator('name')}</th>
          <th class="sortable" data-sort="project">Project${getSortIndicator('project')}</th>
          <th class="sortable" data-sort="updated">Updated${getSortIndicator('updated')}</th>
          <th class="sortable" data-sort="created">Created${getSortIndicator('created')}</th>
          <th class="sortable" data-sort="model">Model${getSortIndicator('model')}</th>
          <th>Actions</th>
          <th class="checkbox-col">
            <input type="checkbox" id="selectAll" class="select-all-checkbox" ${selectedConversations.size > 0 ? 'checked' : ''}>
          </th>
        </tr>
      </thead>
      <tbody>
  `;
  
  filteredConversations.forEach((conv, index) => {
    const updatedDt = new Date(conv.updated_at);
    const createdDt = new Date(conv.created_at);
    const updatedDate = formatDate(updatedDt);
    const updatedTime = formatTime(updatedDt);
    const createdDate = formatDate(createdDt);
    const createdTime = formatTime(createdDt);
    const modelInfo = getDisplayModel(conv);
    const modelBadgeClass = getModelBadgeClass(modelInfo.model);
    const projectName = getProjectName(conv);

    const newUpdated = isNewOrUpdated(conv);
    html += `
      <tr data-id="${escapeHtml(conv.uuid)}">
        <td>
          <div class="conversation-name">
            ${newUpdated ? '<span class="new-dot" title="Needs sync — new or changed since last sync to Scry"></span>' : ''}
            <a href="https://claude.ai/chat/${escapeHtml(conv.uuid)}" target="_blank" title="${escapeHtml(conv.name)}">
              ${escapeHtml(conv.name)}
            </a>
          </div>
        </td>
        <td>${escapeHtml(projectName)}</td>
        <td class="date">${escapeHtml(updatedDate)}<br><span class="time">${escapeHtml(updatedTime)}</span></td>
        <td class="date">${escapeHtml(createdDate)}<br><span class="time">${escapeHtml(createdTime)}</span></td>
        <td>
          ${modelInfo.bounced
            ? `<span class="model-cell" title="${modelInfo.otherLabel} ${escapeHtml(formatModelName(modelInfo.other))}"><span class="model-badge ${modelBadgeClass}">${escapeHtml(formatModelName(modelInfo.model))}</span><span class="model-bounced ${modelBadgeClass}">*</span></span>`
            : `<span class="model-badge ${modelBadgeClass}">${escapeHtml(formatModelName(modelInfo.model))}</span>`
          }
        </td>
        <td>
          <div class="actions">
            <button class="btn-small btn-sync" data-id="${escapeHtml(conv.uuid)}" data-name="${escapeHtml(conv.name)}">
              Sync
            </button>
          </div>
        </td>
        <td class="checkbox-col">
          <input type="checkbox" class="conversation-checkbox" data-id="${escapeHtml(conv.uuid)}" data-index="${index}" ${selectedConversations.has(conv.uuid) ? 'checked' : ''}>
        </td>
      </tr>
    `;
  });
  
  html += `
      </tbody>
    </table>
  `;

  // Security: All user-provided data in html has been sanitized with escapeHtml()
  // before concatenation. The HTML structure itself is static/trusted template code.
  tableContent.innerHTML = html;
  
  // Add per-row Sync button listeners
  document.querySelectorAll('.btn-sync').forEach(btn => {
    btn.addEventListener('click', (e) => {
      syncOne(e.target.dataset.id, e.target.dataset.name);
    });
  });

  // Add checkbox listeners (use 'click' instead of 'change' to capture shift key)
  document.querySelectorAll('.conversation-checkbox').forEach(checkbox => {
    checkbox.addEventListener('click', handleCheckboxChange);
  });

  // Add select all checkbox listener
  const selectAllCheckbox = document.getElementById('selectAll');
  if (selectAllCheckbox) {
    selectAllCheckbox.addEventListener('click', handleSelectAll);
  }

  // Add sortable header click listeners
  document.querySelectorAll('.sortable').forEach(header => {
    header.addEventListener('click', () => {
      handleColumnSort(header.dataset.sort);
    });
  });

  // Enable Scry sync buttons
  const syncAll = document.getElementById('syncAllScryBtn');
  const syncRecent = document.getElementById('syncRecentScryBtn');
  if (syncAll) syncAll.disabled = false;
  if (syncRecent) syncRecent.disabled = false;
}

// Handle individual checkbox change
function handleCheckboxChange(e) {
  const checkbox = e.target;
  const conversationId = checkbox.dataset.id;
  const currentIndex = parseInt(checkbox.dataset.index);

  // Handle shift+click for range selection
  if (e.shiftKey && lastCheckedIndex !== null) {
    const start = Math.min(lastCheckedIndex, currentIndex);
    const end = Math.max(lastCheckedIndex, currentIndex);

    // Get all checkboxes and select/deselect the range
    const checkboxes = document.querySelectorAll('.conversation-checkbox');
    const isChecking = checkbox.checked;

    for (let i = start; i <= end; i++) {
      const cb = checkboxes[i];
      if (cb) {
        cb.checked = isChecking;
        const id = cb.dataset.id;
        if (isChecking) {
          selectedConversations.add(id);
        } else {
          selectedConversations.delete(id);
        }
      }
    }
  } else {
    // Normal single checkbox toggle
    if (checkbox.checked) {
      selectedConversations.add(conversationId);
    } else {
      selectedConversations.delete(conversationId);
    }
  }

  // Update last checked index
  lastCheckedIndex = currentIndex;

  updateSelectAllCheckbox();
}

// Handle select all checkbox
function handleSelectAll(e) {
  const checkboxes = document.querySelectorAll('.conversation-checkbox');

  if (e.target.checked) {
    // Select all visible conversations
    checkboxes.forEach(checkbox => {
      checkbox.checked = true;
      selectedConversations.add(checkbox.dataset.id);
    });
  } else {
    // Deselect all
    checkboxes.forEach(checkbox => {
      checkbox.checked = false;
    });
    selectedConversations.clear();
  }

  // Reset last checked index when using select all
  lastCheckedIndex = null;

}

// Update select all checkbox state
function updateSelectAllCheckbox() {
  const selectAllCheckbox = document.getElementById('selectAll');
  if (!selectAllCheckbox) return;

  // Show header checkbox as checked when any conversations are selected
  selectAllCheckbox.checked = selectedConversations.size > 0;
}

// Update export button text based on selection
function updateStats() {
  const stats = document.getElementById('stats');
  const newCount = allConversations.filter(c => isNewOrUpdated(c)).length;
  stats.textContent = `Showing ${filteredConversations.length} of ${allConversations.length} conversations (${newCount} new/updated)`;
}

// Auto-select new/updated conversations
function autoSelectNewUpdated() {
  selectedConversations.clear();
  filteredConversations.forEach(conv => {
    if (isNewOrUpdated(conv)) {
      selectedConversations.add(conv.uuid);
    }
  });
  displayConversations();
}

// Export single conversation
// Trigger a browser download for an already-built Blob (e.g. a zip).
function showError(message) {
  const tableContent = document.getElementById('tableContent');
  const errorDiv = document.createElement('div');
  errorDiv.className = 'error';
  errorDiv.textContent = message;
  tableContent.innerHTML = '';
  tableContent.appendChild(errorDiv);
}

// Show toast notification
// ===== Scry sync =====

// Re-read sync state and repaint the table so status badges update after a sync.
async function refreshSyncStatus() {
  await loadExportTimestamps();
  applyFiltersAndSort();
  displayConversations();
  updateStats();
}

// Bulk sync. mode is 'all' or { days: N }.
async function syncToScry(mode) {
  const scry = await loadScrySettings();
  if (!scry.url) { showToast('Set your Scry URL in Options first', true); return; }
  if (!(await ensureScryPermission(scry.url))) { showToast('Host permission for Scry was declined', true); return; }
  if (!orgId) { showToast('Organization not detected yet — try again in a moment', true); return; }

  // Pick candidates: recent window (client-side) then drop already-synced versions.
  let candidates = allConversations.slice();
  if (mode !== 'all') {
    candidates = selectConversationsSince(candidates, Date.now() - mode.days * 86400000);
  }
  const syncedMap = await getScrySyncedMap();
  candidates = filterUnsynced(candidates, syncedMap);

  const total = candidates.length;
  if (total === 0) { showToast('Nothing to sync — Scry is up to date'); return; }

  // Reuse the progress modal.
  const progressModal = document.getElementById('progressModal');
  const progressBar = document.getElementById('progressBar');
  const progressText = document.getElementById('progressText');
  const progressStats = document.getElementById('progressStats');
  progressBar.style.width = '0%';
  progressStats.textContent = '';
  progressText.textContent = `Syncing ${total} conversation${total === 1 ? '' : 's'} to Scry…`;
  progressModal.style.display = 'block';

  let cancelled = false;
  document.getElementById('cancelExport').onclick = () => {
    cancelled = true;
    progressModal.style.display = 'none';
    showToast('Sync cancelled', true);
  };

  let synced = 0, failed = 0;
  const failures = [];

  for (let i = 0; i < total; i++) {
    if (cancelled) break;
    const conv = candidates[i];
    try {
      const result = await syncOneConversation(orgId, conv.uuid, scry);
      synced++;
      syncedMap[conv.uuid] = result.updatedAt || conv.updated_at;
    } catch (e) {
      failed++;
      failures.push(`${conv.name || conv.uuid}: ${e.message}`);
      console.error('Scry sync failed for', conv.uuid, e);
    }

    const done = i + 1;
    progressBar.style.width = `${Math.round((done / total) * 100)}%`;
    progressStats.textContent = `${synced} synced, ${failed} failed of ${total}`;
    await setScrySyncedMap(syncedMap); // persist incrementally so a crash resumes
    await new Promise((r) => setTimeout(r, 150)); // gentle pacing on claude.ai + Scry
  }

  progressModal.style.display = 'none';
  await refreshSyncStatus();
  if (cancelled) return;

  if (failed > 0) {
    console.warn('Scry sync failures:', failures);
    showToast(`Synced ${synced}/${total} to Scry — ${failed} failed (see console)`, true);
  } else {
    showToast(`Synced ${synced} conversation${synced === 1 ? '' : 's'} to Scry ✓`);
  }
}

// Sync a single conversation from the dashboard's per-row Sync button.
async function syncOne(conversationId, conversationName) {
  const scry = await loadScrySettings();
  if (!scry.url) { showToast('Set your Scry URL in Options first', true); return; }
  if (!(await ensureScryPermission(scry.url))) { showToast('Host permission for Scry was declined', true); return; }
  if (!orgId) { showToast('Organization not detected yet', true); return; }

  showToast(`Syncing ${conversationName || conversationId}…`);
  try {
    const result = await syncOneConversation(orgId, conversationId, scry);
    const syncedMap = await getScrySyncedMap();
    syncedMap[conversationId] = result.updatedAt;
    await setScrySyncedMap(syncedMap);
    await refreshSyncStatus();
    showToast(`Synced to Scry (${result.status}) ✓`);
  } catch (e) {
    console.error('Scry sync failed for', conversationId, e);
    showToast(`Sync failed: ${e.message}`, true);
  }
}

function showToast(message, isError = false) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.style.background = isError ? '#d32f2f' : '#333';
  toast.classList.add('show');
  
  setTimeout(() => {
    toast.classList.remove('show');
  }, 3000);
}

// Setup event listeners
function setupEventListeners() {
  // Settings dropdown
  const settingsBtn = document.getElementById('settingsBtn');
  const settingsDropdown = document.getElementById('settingsDropdown');

  settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    settingsDropdown.classList.toggle('open');
    // Update org ID display when opening
    if (settingsDropdown.classList.contains('open')) {
      const orgDisplay = document.getElementById('orgIdDisplay');
      if (orgId) {
        orgDisplay.textContent = orgId.substring(0, 8) + '...';
        orgDisplay.title = orgId;
      } else {
        orgDisplay.textContent = 'Not set';
      }
      // Update theme label
      const theme = document.documentElement.getAttribute('data-theme') || 'dark';
      document.getElementById('themeLabel').textContent = theme === 'dark' ? 'Dark' : 'Light';
    }
  });

  // Close dropdown when clicking outside
  document.addEventListener('click', () => {
    settingsDropdown.classList.remove('open');
  });
  settingsDropdown.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  // Theme toggle
  document.getElementById('themeToggle').addEventListener('click', () => {
    toggleTheme();
    const theme = document.documentElement.getAttribute('data-theme') || 'dark';
    document.getElementById('themeLabel').textContent = theme === 'dark' ? 'Dark' : 'Light';
  });

  // Click org ID row to copy full ID to clipboard
  document.getElementById('settingsOrgId').addEventListener('click', async () => {
    if (!orgId) {
      showToast('No org ID set', true);
      return;
    }
    try {
      await navigator.clipboard.writeText(orgId);
      showToast('Org ID copied to clipboard');
    } catch (e) {
      showToast('Failed to copy org ID', true);
    }
    settingsDropdown.classList.remove('open');
  });

  // Edit org ID — open options in the same tab so the back button returns here
  document.getElementById('editOrgId').addEventListener('click', () => {
    window.location.href = chrome.runtime.getURL('options.html');
  });

  // Advanced Options — open options in the same tab so the back button returns here
  document.getElementById('advancedOptions').addEventListener('click', () => {
    window.location.href = chrome.runtime.getURL('options.html');
  });

  // Mark all as exported
  document.getElementById('markAllExported').addEventListener('click', async () => {
    const ids = allConversations.map(c => c.uuid);
    await saveExportTimestamps(ids);
    displayConversations();
    updateStats();
    settingsDropdown.classList.remove('open');
    showToast(`Marked ${ids.length} conversations as exported`);
  });

  // Mark all as new
  document.getElementById('markAllNew').addEventListener('click', async () => {
    exportTimestamps = {};
    await new Promise(resolve => chrome.storage.local.set({ exportTimestamps: {} }, resolve));
    selectedConversations.clear();
    autoSelectNewUpdated();
    updateStats();
    settingsDropdown.classList.remove('open');
    showToast('All conversations marked as new');
  });

  // Backup / Restore Database submenu — shared logic lives in utils.js
  document.getElementById('backupData').addEventListener('click', () => {
    backupExtensionData((success, message) => showToast(message, !success));
    settingsDropdown.classList.remove('open');
  });

  // Import flow: mode-choice modal → file picker → import.
  // pendingImportMode bridges the async file-picker boundary.
  let pendingImportMode = null;

  document.getElementById('restoreData').addEventListener('click', () => {
    settingsDropdown.classList.remove('open');
    showImportModeModal((mode) => {
      if (mode === null) return; // user cancelled
      pendingImportMode = mode;
      document.getElementById('restoreFileBrowse').click();
    });
  });

  document.getElementById('restoreFileBrowse').addEventListener('change', (event) => {
    const file = event.target.files[0];
    event.target.value = ''; // allow re-selecting the same file later
    const mode = pendingImportMode;
    pendingImportMode = null; // consume; never reuse a stale mode
    if (!file || !mode) return;
    importBackup(file, mode, (success, message) => showToast(message, !success));
  });

  // Search input
  const searchInput = document.getElementById('searchInput');
  searchInput.addEventListener('input', (e) => {
    const searchBox = document.getElementById('searchBox');
    if (e.target.value) {
      searchBox.classList.add('has-text');
    } else {
      searchBox.classList.remove('has-text');
    }
    applyFiltersAndSort();
  });
  
  // Clear search
  document.getElementById('clearSearch').addEventListener('click', () => {
    document.getElementById('searchInput').value = '';
    document.getElementById('searchBox').classList.remove('has-text');
    applyFiltersAndSort();
  });

  // Filter dropdown
  const filterBtn = document.getElementById('filterBtn');
  const filterDropdown = document.getElementById('filterDropdown');

  filterBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    filterDropdown.classList.toggle('open');
  });

  document.addEventListener('click', () => {
    filterDropdown.classList.remove('open');
  });
  filterDropdown.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  document.querySelectorAll('.filter-option').forEach(option => {
    option.addEventListener('click', () => {
      statusFilter = option.dataset.value;
      // Update selected state
      document.querySelectorAll('.filter-option').forEach(o => o.classList.remove('selected'));
      option.classList.add('selected');
      // Search bar placeholder reflects the active scope
      document.getElementById('searchInput').placeholder = statusFilter === 'projects'
        ? 'Search projects by name...'
        : 'Search conversations by name...';
      // Update button state
      filterBtn.classList.toggle('active', statusFilter !== 'all');
      filterDropdown.classList.remove('open');
      applyFiltersAndSort();
    });
  });

  // Set initial selected state
  document.querySelector('.filter-option[data-value="all"]').classList.add('selected');

  // Export all button

  // Scry sync buttons
  const syncAllBtn = document.getElementById('syncAllScryBtn');
  if (syncAllBtn) {
    syncAllBtn.addEventListener('click', () => syncToScry('all'));
  }
  const syncRecentBtn = document.getElementById('syncRecentScryBtn');
  if (syncRecentBtn) {
    syncRecentBtn.addEventListener('click', () => {
      const days = parseInt(document.getElementById('syncRecentDays').value, 10);
      syncToScry({ days: Number.isFinite(days) && days > 0 ? days : 7 });
    });
  }
}
