// The unified Scry Sync dashboard (phase 3): one page, one table, a tab per
// enabled+signed-in source (Claude always on; ChatGPT only when enabled in
// Options AND not signed out of chatgpt.com). Replaces the old Claude-only
// "Browse" page + the retired standalone ChatGPT page (chrome/chatgpt.html,
// deleted this phase).
//
// Claude enumeration goes through the credentialed direct fetch
// (listClaudeConversations / detectClaudeOrgId in chrome/scry_client.js) —
// NOT the claude.ai tab-relay (sendMessageToClaudeTab) the old page used.
// content.js (the tab-relay's other half) is kept only for the in-page
// Claude buttons; this page no longer depends on it, or on an open claude.ai
// tab at all.

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

// ===== State =====

// Which source tab is showing. Remembered in chrome.storage.local
// (scryActiveSourceTab) so a reload/reopen returns to where the user left off.
let activeSource = 'claude';

// The 'scry' settings blob (url/token/chatgptEnabled/...), loaded once at
// page load. A settings change made in Options takes effect on next load —
// same as every other preference this page reads (see the pageshow listener
// below), not live.
let scrySettingsCache = {};

// Tri-state per source: null = not yet checked (or not applicable), true/false
// once known. Only chatgpt currently has a signed-out concept.
const signedIn = { chatgpt: null };

// Per-source sync context — exactly what chrome/sources.js's SOURCES entries
// need as their `ctx` argument. sourceCtx.chatgpt.token is populated as a
// SIDE EFFECT of SOURCES.chatgpt.enumerate(ctx) (it sets ctx.token itself),
// which is also how "one auth/session call per page load, cached in ctx" is
// satisfied without a separate token-fetch step here.
const sourceCtx = { claude: {}, chatgpt: { wantImages: true } };

// Per-source enumerated items — Claude: raw chat_conversations objects (each
// with `.model` overwritten to inferModel(conv), matching the old page's
// behavior) — ChatGPT: normalizeChatGptListItem-shaped {uuid, updated_at, title}.
const sourceItems = { claude: [], chatgpt: [] };
const sourceLoaded = { claude: false, chatgpt: false };
const sourceLoadError = { claude: null, chatgpt: null };

let filteredConversations = []; // rows (dashboard_model.toRow shape + _modelInfo/_synced) for the ACTIVE source, filtered+sorted
let allRowsForActiveSource = []; // unfiltered rows for the active source (stats)
let currentSort = 'updated_desc';
let sortStack = []; // multi-level sort: [{field, direction}, ...]
let selectedConversations = new Set(); // uuids selected in the ACTIVE source's table; cleared on tab switch
let lastCheckedIndex = null;
let exportTimestamps = {}; // scrySyncedMap: uuid -> last-synced source updated_at (both sources share this map; uuids don't collide across sources)
let modelSnapshots = {}; // Claude only, written by content.js
let statusFilter = 'all'; // 'all' | 'new' | 'synced'
let dateFormat = 'mdy';
let timeFormat = '12h';
let modelDisplay = 'original';

// ===== preference loaders (unchanged from the pre-phase-3 page) =====

async function loadExportTimestamps() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['scrySyncedMap'], (result) => {
      exportTimestamps = result.scrySyncedMap || {};
      resolve();
    });
  });
}

async function loadModelSnapshots() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['modelSnapshots'], (result) => {
      modelSnapshots = result.modelSnapshots || {};
      resolve();
    });
  });
}

// Resolve which model to show for a Claude conversation. Honors the
// modelDisplay preference ('original' default, or 'current'). When the chat
// has been bounced (current differs from first-seen), `bounced` is true and
// the `*` marker shows the "other" model in its tooltip. Claude only — the
// dashboard has no cheap per-conversation model for ChatGPT (only the full
// conversation body carries model_slug, not the list endpoint), so the
// ChatGPT tab's Model column shows an em dash instead (documented in
// modelCellHtml below).
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
      bounced,
    };
  }
  return { model: conv.model, other: conv.model, otherLabel: '', bounced: false };
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

async function loadActiveSourceTabPref() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['scryActiveSourceTab'], (result) => resolve(result.scryActiveSourceTab || 'claude'));
  });
}

function saveActiveSourceTabPref(source) {
  return new Promise((resolve) => chrome.storage.local.set({ scryActiveSourceTab: source }, resolve));
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

// When user navigates back to this page from the options page (bfcache hit),
// reload so changed preferences (model display, date/time format, sources
// enabled, etc.) take effect without a manual refresh.
window.addEventListener('pageshow', (event) => {
  if (event.persisted) window.location.reload();
});

// ===== init =====

document.addEventListener('DOMContentLoaded', async () => {
  initTheme();
  // Wire up UI listeners immediately so the chrome stays interactive while
  // sources are still loading.
  setupEventListeners();

  await loadExportTimestamps();
  await loadModelSnapshots();
  await loadDateTimePrefs();
  await loadModelDisplayPref();
  scrySettingsCache = await loadScrySettings();
  renderConnStatus();
  renderContinuousFooter();

  activeSource = await loadActiveSourceTabPref();
  const initialTabs = computeVisibleTabs();
  if (!initialTabs.includes(activeSource)) activeSource = 'claude';
  renderTabs();
  showLoadingTable();

  // Load every currently-visible source in parallel — the mockup keeps real
  // counts on EVERY tab, not just the active one, and this also means
  // switching tabs afterward is instant (already cached) rather than a
  // second network round trip.
  await Promise.allSettled(initialTabs.map((s) => loadSourceWithErrorHandling(s)));

  // ChatGPT may have just been discovered signed-out — recompute visibility
  // and fall back to Claude if the active tab disappeared out from under it.
  const finalTabs = computeVisibleTabs();
  if (!finalTabs.includes(activeSource)) activeSource = 'claude';
  renderTabs();
  renderActiveSource();
});

// ===== source tabs =====

function computeVisibleTabs() {
  return visibleSourceTabs({ scry: scrySettingsCache, signedIn });
}

function renderConnStatus() {
  const el = document.getElementById('scryConnStatus');
  if (!el) return;
  // Reflects whether Scry is CONFIGURED (a URL is set), not a live health
  // ping — Options → Test Connection already covers actual reachability, and
  // pinging Scry on every dashboard load just to light a dot felt like an
  // unwarranted extra round trip for the same answer.
  const configured = Boolean(scrySettingsCache && scrySettingsCache.url);
  el.innerHTML = configured
    ? 'Scry: connected <span class="conn-dot connected">●</span>'
    : 'Scry: not configured <span class="conn-dot">●</span>';
}

async function renderContinuousFooter() {
  const el = document.getElementById('continuousFooter');
  if (!el) return;
  const scry = scrySettingsCache || {};
  const claudeEnabled = scry.continuousSync !== false;
  const chatgptSourceEnabled = scry.chatgptEnabled === true;
  const chatgptSyncEnabled = chatgptSourceEnabled && scry.chatgptContinuousSync !== false;
  const states = await getContinuousSyncStates();
  const claudeLine = formatSourceStatus('Claude', claudeEnabled, states.claude);
  const chatgptLine = chatgptSourceEnabled ? formatSourceStatus('ChatGPT', chatgptSyncEnabled, states.chatgpt) : null;
  const parts = [claudeLine, chatgptLine].filter(Boolean);
  el.textContent = parts.length ? `Continuous: ${parts.join(' · ')}` : '';
}

function renderTabs() {
  const container = document.getElementById('sourceTabs');
  if (!container) return;
  const tabs = computeVisibleTabs();
  if (!tabs.includes(activeSource)) activeSource = 'claude';

  // A single visible source (Claude, always) means no switcher at all.
  if (tabs.length <= 1) {
    container.style.display = 'none';
    container.innerHTML = '';
    updateActionControlsForSource();
    return;
  }

  container.style.display = 'flex';
  container.innerHTML = tabs.map((s) => {
    const count = sourceLoaded[s] ? (sourceItems[s] || []).length : null;
    const label = tabLabel(s, count);
    return `<button type="button" class="source-tab${s === activeSource ? ' active' : ''}" data-source="${escapeHtml(s)}">${escapeHtml(label)}</button>`;
  }).join('');
  container.querySelectorAll('.source-tab').forEach((btn) => {
    btn.addEventListener('click', () => switchSourceTab(btn.dataset.source));
  });
  updateActionControlsForSource();
}

// Delete-from-source is offered ONLY for Claude (the owner's ruling — Scry
// cannot yet prove a ChatGPT capture completely enough to delete against);
// the search placeholder names the active source for clarity.
function updateActionControlsForSource() {
  const deleteBtn = document.getElementById('deleteFromClaudeBtn');
  if (deleteBtn) deleteBtn.style.display = activeSource === 'claude' ? '' : 'none';
  const searchInput = document.getElementById('searchInput');
  if (searchInput) {
    searchInput.placeholder = `Search ${activeSource === 'claude' ? 'Claude' : 'ChatGPT'} conversations by title...`;
  }
}

function showLoadingTable() {
  const tableContent = document.getElementById('tableContent');
  if (!tableContent) return;
  tableContent.innerHTML = '<div class="loading"><div class="spinner"></div><div>Loading conversations…</div></div>';
}

async function switchSourceTab(source) {
  if (source === activeSource) return;
  const tabs = computeVisibleTabs();
  if (!tabs.includes(source)) return;

  activeSource = source;
  selectedConversations.clear();
  lastCheckedIndex = null;
  saveActiveSourceTabPref(source);
  renderTabs();

  if (!sourceLoaded[source]) {
    showLoadingTable();
    await loadSourceWithErrorHandling(source);
  } else {
    renderActiveSource();
  }
}

// ===== enumeration (no tab relay) =====

// Auto-detect first (no claude.ai tab needed — chrome/scry_client.js's
// detectClaudeOrgId is a direct credentialed fetch), fall back to whatever is
// already stored, and only then surface a friendly error. Cached on
// sourceCtx.claude for the life of the page.
async function ensureOrgId() {
  if (sourceCtx.claude.orgId) return sourceCtx.claude.orgId;
  const stored = await readOrgIdFromStorage();
  if (stored) {
    sourceCtx.claude.orgId = stored;
    return stored;
  }
  try {
    const detected = await detectClaudeOrgId();
    sourceCtx.claude.orgId = detected;
    return detected;
  } catch (e) {
    throw new Error(`Could not detect your Claude organization ID (${e.message}). Make sure you're signed in to claude.ai, or set it manually in Options.`);
  }
}

async function loadSource(source) {
  if (source === 'claude') {
    const orgId = await ensureOrgId();
    const raw = await SOURCES.claude.enumerate({ orgId });
    sourceItems.claude = raw.map((conv) => ({ ...conv, model: inferModel(conv) }));
    return;
  }
  if (source === 'chatgpt') {
    try {
      // SOURCES.chatgpt.enumerate sets sourceCtx.chatgpt.token as a side
      // effect — "one auth/session call per page load, cached in ctx".
      const raw = await SOURCES.chatgpt.enumerate(sourceCtx.chatgpt);
      signedIn.chatgpt = true;
      sourceItems.chatgpt = raw;
    } catch (e) {
      if (isChatGptSignedOutError(e)) {
        // Not a failure — an everyday state. Hide the tab (visibleSourceTabs
        // reacts to signedIn.chatgpt === false) rather than show an error.
        signedIn.chatgpt = false;
        sourceItems.chatgpt = [];
        return;
      }
      throw e;
    }
    return;
  }
}

async function loadSourceWithErrorHandling(source) {
  sourceLoadError[source] = null;
  try {
    await loadSource(source);
  } catch (e) {
    console.error(`Scry Sync: failed to load ${source} conversations`, e);
    sourceLoadError[source] = e.message || String(e);
  }
  sourceLoaded[source] = true;
  renderTabs();
  if (source === activeSource) renderActiveSource();
}

function renderActiveSource() {
  if (sourceLoadError[activeSource]) {
    showError(`Failed to load ${activeSource === 'claude' ? 'Claude' : 'ChatGPT'} conversations: ${sourceLoadError[activeSource]}`);
    updateStats();
    return;
  }
  applyFiltersAndSort();
}

// ===== rows, filtering, sorting =====

// Map the active source's raw enumerated items onto table rows
// (dashboard_model.toRow), attaching the Claude-only rich model info and the
// synced-status classification every row needs.
function buildActiveRows() {
  const raw = sourceItems[activeSource] || [];
  return raw.map((it) => {
    const row = toRow(activeSource, it);
    if (activeSource === 'claude') {
      const modelInfo = getDisplayModel(it);
      row.model = modelInfo.model;
      row._modelInfo = modelInfo;
    }
    row._synced = syncedBadge({ syncedAt: exportTimestamps[row.uuid] || null, updatedAt: row.updated_at });
    return row;
  });
}

function applyFiltersAndSort() {
  const searchInput = document.getElementById('searchInput');
  const searchTerm = (searchInput ? searchInput.value : '').toLowerCase();

  const rows = buildActiveRows();
  allRowsForActiveSource = rows;

  filteredConversations = rows.filter((row) => {
    const matchesSearch = !searchTerm || row.title.toLowerCase().includes(searchTerm);
    let matchesStatus = true;
    if (statusFilter === 'new') matchesStatus = row._synced !== 'synced';
    else if (statusFilter === 'synced') matchesStatus = row._synced === 'synced';
    return matchesSearch && matchesStatus;
  });

  sortConversations();
  lastCheckedIndex = null;
  displayConversations();
  updateStats();
}

function sortConversations() {
  if (sortStack.length === 0) {
    const [field, direction] = currentSort.split('_');
    sortStack = [{ field, direction }];
  }

  filteredConversations.sort((a, b) => {
    for (const { field, direction } of sortStack) {
      let aVal, bVal;
      switch (field) {
        case 'name':
          aVal = a.title.toLowerCase();
          bVal = b.title.toLowerCase();
          break;
        case 'updated':
          aVal = a.updated_at ? new Date(a.updated_at) : new Date(0);
          bVal = b.updated_at ? new Date(b.updated_at) : new Date(0);
          break;
        case 'model':
          aVal = formatModelName(a.model || '').toLowerCase();
          bVal = formatModelName(b.model || '').toLowerCase();
          break;
        default:
          continue;
      }
      let comparison = 0;
      if (aVal > bVal) comparison = 1;
      else if (aVal < bVal) comparison = -1;
      if (comparison !== 0) return direction === 'asc' ? comparison : -comparison;
    }
    return 0;
  });
}

function handleColumnSort(field) {
  const existingIndex = sortStack.findIndex((s) => s.field === field);
  if (existingIndex === 0) {
    sortStack[0].direction = sortStack[0].direction === 'asc' ? 'desc' : 'asc';
  } else if (existingIndex > 0) {
    const [sortCriterion] = sortStack.splice(existingIndex, 1);
    sortStack.unshift(sortCriterion);
  } else {
    sortStack.unshift({ field, direction: 'asc' });
  }
  applyFiltersAndSort();
}

function getSortIndicator(field) {
  const sortIndex = sortStack.findIndex((s) => s.field === field);
  if (sortIndex !== 0) return '';
  const { direction } = sortStack[sortIndex];
  const primaryArrow = direction === 'asc' ? '↑' : '↓';
  const secondaryArrow = direction === 'asc' ? '↓' : '↑';
  return ` <span class="sort-indicator">${primaryArrow}<sub>${secondaryArrow}</sub></span>`;
}

// ===== table rendering =====

function syncedCellHtml(row) {
  const status = row._synced;
  if (status === 'synced') {
    const syncedAt = exportTimestamps[row.uuid];
    const rel = syncedAt ? formatRelativeTime(Date.parse(syncedAt)) : '';
    return `<span class="synced-badge synced">✓${rel ? ' ' + escapeHtml(rel) : ''}</span>`;
  }
  if (status === 'stale') return '<span class="synced-badge stale">! stale</span>';
  if (status === 'missing') return '<span class="synced-badge missing">missing</span>';
  return '<span class="synced-badge unknown">?</span>';
}

// Claude gets the rich badge + bounced-model tooltip (unchanged from the
// pre-phase-3 page); ChatGPT has no cheap per-conversation model at
// enumeration time (only the full conversation body carries model_slug — see
// chatgpt_adapter.js's extractChatGptModelSlug — and fetching every body just
// to populate a table column isn't worth the cost), so its Model column
// renders an em dash.
function modelCellHtml(row) {
  if (activeSource !== 'claude') {
    return '<span class="model-none">—</span>';
  }
  const info = row._modelInfo || { model: row.model, other: row.model, otherLabel: '', bounced: false };
  if (!info.model) return '<span class="model-none">—</span>';
  const badgeClass = getModelBadgeClass(info.model);
  if (info.bounced) {
    return `<span class="model-cell" title="${escapeHtml(info.otherLabel)} ${escapeHtml(formatModelName(info.other))}"><span class="model-badge ${badgeClass}">${escapeHtml(formatModelName(info.model))}</span><span class="model-bounced ${badgeClass}">*</span></span>`;
  }
  return `<span class="model-badge ${badgeClass}">${escapeHtml(formatModelName(info.model))}</span>`;
}

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
          <th class="sortable" data-sort="name">Title${getSortIndicator('name')}</th>
          <th class="sortable" data-sort="updated">Updated${getSortIndicator('updated')}</th>
          <th>Synced</th>
          <th class="sortable" data-sort="model">Model${getSortIndicator('model')}</th>
          <th>Actions</th>
          <th class="checkbox-col">
            <input type="checkbox" id="selectAll" class="select-all-checkbox" ${selectedConversations.size > 0 ? 'checked' : ''}>
          </th>
        </tr>
      </thead>
      <tbody>
  `;

  filteredConversations.forEach((row, index) => {
    const updatedDt = row.updated_at ? new Date(row.updated_at) : null;
    const updatedDate = updatedDt ? formatDate(updatedDt) : '';
    const updatedTime = updatedDt ? formatTime(updatedDt) : '';

    html += `
      <tr data-id="${escapeHtml(row.uuid || '')}">
        <td>
          <div class="conversation-name">
            <a href="${escapeHtml(row.openUrl || '#')}" target="_blank" title="${escapeHtml(row.title)}">
              ${escapeHtml(row.title)}
            </a>
          </div>
        </td>
        <td class="date">${escapeHtml(updatedDate)}${updatedTime ? `<br><span class="time">${escapeHtml(updatedTime)}</span>` : ''}</td>
        <td>${syncedCellHtml(row)}</td>
        <td>${modelCellHtml(row)}</td>
        <td>
          <div class="actions">
            <button class="btn-small btn-sync" data-id="${escapeHtml(row.uuid || '')}" data-name="${escapeHtml(row.title)}">
              Sync
            </button>
          </div>
        </td>
        <td class="checkbox-col">
          <input type="checkbox" class="conversation-checkbox" data-id="${escapeHtml(row.uuid || '')}" data-index="${index}" ${selectedConversations.has(row.uuid) ? 'checked' : ''}>
        </td>
      </tr>
    `;
  });

  html += `
      </tbody>
    </table>
  `;

  // Security: all user-provided data above is escaped with escapeHtml(); the
  // HTML structure itself is static/trusted template code.
  tableContent.innerHTML = html;

  document.querySelectorAll('.btn-sync').forEach((btn) => {
    btn.addEventListener('click', (e) => syncOneRow(e.target.dataset.id, e.target.dataset.name));
  });
  document.querySelectorAll('.conversation-checkbox').forEach((checkbox) => {
    checkbox.addEventListener('click', handleCheckboxChange);
  });
  const selectAllCheckbox = document.getElementById('selectAll');
  if (selectAllCheckbox) selectAllCheckbox.addEventListener('click', handleSelectAll);
  document.querySelectorAll('.sortable').forEach((header) => {
    header.addEventListener('click', () => handleColumnSort(header.dataset.sort));
  });

  const syncSelected = document.getElementById('syncSelectedBtn');
  const syncRecent = document.getElementById('syncRecentBtn');
  const reconcile = document.getElementById('reconcileBtn');
  const deleteFromClaude = document.getElementById('deleteFromClaudeBtn');
  if (syncSelected) syncSelected.disabled = false;
  if (syncRecent) syncRecent.disabled = false;
  if (reconcile) reconcile.disabled = false;
  if (deleteFromClaude) deleteFromClaude.disabled = activeSource !== 'claude';
}

// ===== selection =====

function handleCheckboxChange(e) {
  const checkbox = e.target;
  const conversationId = checkbox.dataset.id;
  const currentIndex = parseInt(checkbox.dataset.index);

  if (e.shiftKey && lastCheckedIndex !== null) {
    const start = Math.min(lastCheckedIndex, currentIndex);
    const end = Math.max(lastCheckedIndex, currentIndex);
    const checkboxes = document.querySelectorAll('.conversation-checkbox');
    const isChecking = checkbox.checked;
    for (let i = start; i <= end; i++) {
      const cb = checkboxes[i];
      if (cb) {
        cb.checked = isChecking;
        const id = cb.dataset.id;
        if (isChecking) selectedConversations.add(id);
        else selectedConversations.delete(id);
      }
    }
  } else if (checkbox.checked) {
    selectedConversations.add(conversationId);
  } else {
    selectedConversations.delete(conversationId);
  }

  lastCheckedIndex = currentIndex;
  updateSelectAllCheckbox();
}

function handleSelectAll(e) {
  const checkboxes = document.querySelectorAll('.conversation-checkbox');
  if (e.target.checked) {
    checkboxes.forEach((checkbox) => {
      checkbox.checked = true;
      selectedConversations.add(checkbox.dataset.id);
    });
  } else {
    checkboxes.forEach((checkbox) => { checkbox.checked = false; });
    selectedConversations.clear();
  }
  lastCheckedIndex = null;
}

function updateSelectAllCheckbox() {
  const selectAllCheckbox = document.getElementById('selectAll');
  if (!selectAllCheckbox) return;
  selectAllCheckbox.checked = selectedConversations.size > 0;
}

function updateStats() {
  const stats = document.getElementById('stats');
  if (!stats) return;
  const total = allRowsForActiveSource.length;
  const newCount = allRowsForActiveSource.filter((r) => r._synced !== 'synced').length;
  stats.textContent = `Showing ${filteredConversations.length} of ${total} (${newCount} new/updated)`;
}

// Auto-select every not-yet-synced row in the active source (used after
// "Mark all as new").
function autoSelectNewUpdated() {
  selectedConversations.clear();
  filteredConversations.forEach((row) => {
    if (row._synced !== 'synced' && row.uuid) selectedConversations.add(row.uuid);
  });
  displayConversations();
}

function showError(message) {
  const tableContent = document.getElementById('tableContent');
  const errorDiv = document.createElement('div');
  errorDiv.className = 'error';
  errorDiv.textContent = message;
  tableContent.innerHTML = '';
  tableContent.appendChild(errorDiv);
}

function showToast(message, isError = false) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.style.background = isError ? '#d32f2f' : '#333';
  toast.classList.add('show');
  setTimeout(() => { toast.classList.remove('show'); }, 3000);
}

// ===== Scry sync =====

async function refreshSyncStatus() {
  await loadExportTimestamps();
  applyFiltersAndSort();
}

// Sync a list of raw items (from sourceItems[activeSource]) via the shared
// sync core, with the bounded pool + progress modal. Returns
// { synced, failed, cancelled }. ctx.onStatus (wired through syncBatch's
// opts.onStatus) surfaces ChatGPT's "images N/M" / "rate limited — waiting
// Ns" sub-status as a transient suffix on the progress text, reverting to the
// base header once the in-flight item finishes.
async function syncCandidateList(candidates, scry, headerText) {
  const total = candidates.length;

  const progressModal = document.getElementById('progressModal');
  const progressBar = document.getElementById('progressBar');
  const progressText = document.getElementById('progressText');
  const progressStats = document.getElementById('progressStats');
  progressBar.style.width = '0%';
  progressStats.textContent = '';
  progressText.textContent = headerText;
  progressModal.style.display = 'block';

  const signal = { aborted: false };
  document.getElementById('cancelExport').onclick = () => {
    signal.aborted = true;
    progressModal.style.display = 'none';
    showToast('Sync cancelled', true);
  };

  const syncedMap = await getScrySyncedMap();
  let synced = 0, failed = 0;
  const source = SOURCES[activeSource];
  const ctx = sourceCtx[activeSource];

  const result = await syncBatch(source, ctx, scry, candidates, {
    signal,
    onStatus: (text) => {
      progressText.textContent = text ? `${headerText} — ${text}` : headerText;
    },
    onProgress: async ({ done, item, ok }) => {
      if (ok) synced++; else failed++;
      syncedMap[item.uuid] = item.updated_at;
      progressBar.style.width = `${Math.round((done / total) * 100)}%`;
      progressText.textContent = headerText;
      progressStats.textContent = `${synced} synced, ${failed} failed of ${total}`;
      await setScrySyncedMap(syncedMap);
    },
  });

  for (const { item, result: r } of result.succeeded) {
    syncedMap[item.uuid] = (r && r.updatedAt) || item.updated_at;
  }
  await setScrySyncedMap(syncedMap);

  progressModal.style.display = 'none';
  await refreshSyncStatus();
  if (result.failed.length > 0) {
    console.warn('Scry sync failures:', result.failed.map(
      ({ item, error }) => `${item.title || item.name || item.uuid}: ${error.message}`));
  }
  return { synced, failed, cancelled: signal.aborted };
}

// "Sync selected" — the checkbox-driven bulk action. Replaces the old
// Claude-only "Sync all to Scry" button: select-all (the header checkbox) +
// Sync selected covers the same "sync everything" case without a second,
// redundant button.
async function syncSelectedToScry() {
  const scry = await loadScrySettings();
  if (!scry.url) { showToast('Set your Scry URL in Options first', true); return; }
  if (!(await ensureScryPermission(scry.url))) { showToast('Host permission for Scry was declined', true); return; }
  if (selectedConversations.size === 0) {
    showToast('Select conversation(s) to sync first (checkbox) — or use "Sync last N days"', true);
    return;
  }

  const raw = sourceItems[activeSource] || [];
  const candidates = raw.filter((it) => selectedConversations.has(it.uuid));
  const total = candidates.length;
  const r = await syncCandidateList(candidates, scry, `Syncing ${total} conversation${total === 1 ? '' : 's'} to Scry…`);
  if (r.cancelled) return;
  if (r.failed > 0) {
    showToast(`Synced ${r.synced}/${total} to Scry — ${r.failed} failed (see console)`, true);
  } else {
    showToast(`Synced ${r.synced} conversation${r.synced === 1 ? '' : 's'} to Scry ✓`);
  }
}

// "Sync last N days" — independent of the checkbox selection; syncs whatever
// in the active source's already-loaded list is new/changed in that window.
async function syncRecentToScry(days) {
  const scry = await loadScrySettings();
  if (!scry.url) { showToast('Set your Scry URL in Options first', true); return; }
  if (!(await ensureScryPermission(scry.url))) { showToast('Host permission for Scry was declined', true); return; }

  let candidates = (sourceItems[activeSource] || []).slice();
  candidates = selectConversationsSince(candidates, Date.now() - days * 86400000);
  const syncedMap = await getScrySyncedMap();
  candidates = filterUnsynced(candidates, syncedMap);

  const total = candidates.length;
  if (total === 0) { showToast('Nothing to sync — Scry is up to date'); return; }

  const r = await syncCandidateList(candidates, scry, `Syncing ${total} conversation${total === 1 ? '' : 's'} to Scry…`);
  if (r.cancelled) return;
  if (r.failed > 0) {
    showToast(`Synced ${r.synced}/${total} to Scry — ${r.failed} failed (see console)`, true);
  } else {
    showToast(`Synced ${r.synced} conversation${r.synced === 1 ? '' : 's'} to Scry ✓`);
  }
}

// Reconcile against Scry: ask which enumerated conversations are missing or
// incompletely captured, then re-sync exactly those. For Claude this is the
// completeness gate run before Delete; for ChatGPT it's just "catch me up".
async function reconcileAndSyncUI() {
  const scry = await loadScrySettings();
  if (!scry.url) { showToast('Set your Scry URL in Options first', true); return; }
  if (!(await ensureScryPermission(scry.url))) { showToast('Host permission for Scry was declined', true); return; }

  const source = SOURCES[activeSource];
  const ctx = sourceCtx[activeSource];
  const items = (sourceItems[activeSource] || []).filter((c) => c && c.uuid);
  if (items.length === 0) { showToast('Nothing to reconcile — load conversations first', true); return; }
  showToast(`Reconciling ${items.length} conversations with Scry…`);

  const progressModal = document.getElementById('progressModal');
  const progressBar = document.getElementById('progressBar');
  const progressText = document.getElementById('progressText');
  const progressStats = document.getElementById('progressStats');

  const signal = { aborted: false };
  document.getElementById('cancelExport').onclick = () => {
    signal.aborted = true;
    progressModal.style.display = 'none';
    showToast('Sync cancelled', true);
  };

  const syncedMap = await getScrySyncedMap();
  let synced = 0, failed = 0;
  let modalShown = false;

  let outcome;
  try {
    outcome = await reconcileAndSync(source, ctx, scry, items, {
      signal,
      onStatus: (text) => {
        if (modalShown) progressText.textContent = text ? `Reconcile: re-syncing… — ${text}` : 'Reconcile: re-syncing…';
      },
      onProgress: async ({ done, total, item, ok }) => {
        if (!modalShown) {
          modalShown = true;
          progressBar.style.width = '0%';
          progressStats.textContent = '';
          progressText.textContent = `Reconcile: re-syncing ${total}…`;
          progressModal.style.display = 'block';
        }
        if (ok) synced++; else failed++;
        syncedMap[item.uuid] = item.updated_at;
        progressBar.style.width = `${Math.round((done / total) * 100)}%`;
        progressText.textContent = `Reconcile: re-syncing ${total}…`;
        progressStats.textContent = `${synced} synced, ${failed} failed of ${total}`;
        await setScrySyncedMap(syncedMap);
      },
    });
  } catch (e) {
    console.error('Reconcile failed', e);
    showToast(`Reconcile failed: ${e.message}`, true);
    return;
  }

  const { report, toSync } = outcome;
  const s = report.summary || {};
  console.log('Scry reconcile:', s, 'extra(in Scry, not listed):', report.extra);

  if (modalShown) {
    for (const { item, result: r } of outcome.succeeded) {
      syncedMap[item.uuid] = (r && r.updatedAt) || item.updated_at;
    }
    await setScrySyncedMap(syncedMap);
    progressModal.style.display = 'none';
    await refreshSyncStatus();
  }

  if (toSync.length === 0) {
    showToast(`✓ Scry holds all ${s.complete || items.length} conversations with full fidelity`);
    return;
  }
  if (signal.aborted) return;

  const breakdown = `${s.missing || 0} missing + ${s.incomplete || 0} incomplete + ${s.stale || 0} stale`;
  showToast(
    outcome.failed.length > 0
      ? `Reconcile (${breakdown}): re-synced ${synced}/${toSync.length} — ${outcome.failed.length} failed (see console)`
      : `Reconciled (${breakdown}) ✓ re-synced ${synced}. Run again to confirm 0 remaining.`,
    outcome.failed.length > 0,
  );
}

// Phase 3 — the gated delete. CLAUDE ONLY (the owner's ruling; the button is
// hidden on every other tab and this guards it too). Logic is UNCHANGED from
// the pre-phase-3 page: fetch each selected conversation's body LIVE from
// Claude, ask Scry's verify-deletable gate which are cleared, confirm, then
// delete only the cleared ids.
async function deleteSelectedFromClaude() {
  if (activeSource !== 'claude') return;

  const scry = await loadScrySettings();
  if (!scry.url) { showToast('Set your Scry URL in Options first', true); return; }
  if (!(await ensureScryPermission(scry.url))) { showToast('Host permission for Scry was declined', true); return; }
  const orgId = sourceCtx.claude.orgId;
  if (!orgId) { showToast('Organization not detected yet — try again in a moment', true); return; }

  const selected = (sourceItems.claude || []).filter((c) => selectedConversations.has(c.uuid));
  if (selected.length === 0) {
    showToast('Select the conversation(s) to delete first (checkbox)', true);
    return;
  }

  const progressModal = document.getElementById('progressModal');
  const progressBar = document.getElementById('progressBar');
  const progressText = document.getElementById('progressText');
  const progressStats = document.getElementById('progressStats');
  progressBar.style.width = '0%';
  progressStats.textContent = '';
  progressText.textContent = `Verifying ${selected.length} conversation(s) live against Scry…`;
  progressModal.style.display = 'block';

  let cancelled = false;
  document.getElementById('cancelExport').onclick = () => {
    cancelled = true; progressModal.style.display = 'none'; showToast('Delete cancelled', true);
  };

  const concurrency = (scry.concurrency && scry.concurrency > 0) ? scry.concurrency : 4;
  const items = [];
  const fetchFailed = [];
  let done = 0;
  await runPool(selected, concurrency, async (conv) => {
    if (cancelled) return;
    try {
      const live = await fetchConversationBody(orgId, conv.uuid);
      items.push({ source_id: conv.uuid, live_body: live });
    } catch (e) {
      fetchFailed.push(`${conv.name || conv.uuid}: ${e.message}`);
    }
    done++;
    progressBar.style.width = `${Math.round((done / selected.length) * 100)}%`;
    progressStats.textContent = `${done}/${selected.length} fetched`;
  });
  if (cancelled) return;

  let report;
  try {
    report = await verifyDeletableWithScry(scry, items);
  } catch (e) {
    progressModal.style.display = 'none';
    console.error('verify-deletable failed', e);
    showToast(`Delete gate failed: ${e.message}`, true);
    return;
  }
  progressModal.style.display = 'none';

  const { cleared, blocked } = partitionDeletableReport(report);
  console.log('Delete gate summary:', report.summary,
              '\ncleared:', cleared, '\nblocked:', blocked, '\nfetch failures:', fetchFailed);

  if (cleared.length === 0) {
    showToast(`0 cleared for deletion — ${blocked.length} blocked, ${fetchFailed.length} fetch-failed (see console)`, true);
    return;
  }

  const skipped = blocked.length + fetchFailed.length;
  const msg =
    `Permanently delete ${cleared.length} conversation(s) from Claude?\n\n` +
    `Each is verified fully captured in Scry — its live body still matches the ` +
    `stored archive message-for-message.\n\n` +
    (skipped > 0
      ? `${skipped} selected were NOT cleared (${blocked.length} blocked, ` +
        `${fetchFailed.length} fetch-failed) and will be SKIPPED — see console.\n\n`
      : '') +
    `This CANNOT be undone at Claude. Scry keeps its copy.`;
  if (!window.confirm(msg)) { showToast('Delete cancelled'); return; }

  const clearedSet = new Set(cleared);
  const toDelete = selected.filter((c) => clearedSet.has(c.uuid));
  progressText.textContent = `Deleting ${toDelete.length} from Claude…`;
  progressBar.style.width = '0%';
  progressStats.textContent = '';
  progressModal.style.display = 'block';

  let deleted = 0, failed = 0, ddone = 0;
  const delFailures = [];
  for (const conv of toDelete) {
    if (cancelled) break;
    try {
      const r = await deleteClaudeConversation(orgId, conv.uuid);
      if (!r.ok) throw new Error(`DELETE ${r.status}`);
      deleted++;
      selectedConversations.delete(conv.uuid);
    } catch (e) {
      failed++;
      delFailures.push(`${conv.name || conv.uuid}: ${e.message}`);
      console.error('Claude delete failed for', conv.uuid, e);
    }
    ddone++;
    progressBar.style.width = `${Math.round((ddone / toDelete.length) * 100)}%`;
    progressStats.textContent = `${deleted} deleted, ${failed} failed of ${toDelete.length}`;
    await new Promise((r) => setTimeout(r, 300));
  }
  progressModal.style.display = 'none';
  if (delFailures.length) console.warn('Claude delete failures:', delFailures);
  if (deleted > 0) await loadSourceWithErrorHandling('claude');
  showToast(
    failed > 0
      ? `Deleted ${deleted}/${toDelete.length} from Claude — ${failed} failed (see console)`
      : `Deleted ${deleted} from Claude ✓ (Scry keeps the copy)`,
    failed > 0,
  );
}

// Sync a single conversation from its row's Sync button, via the shared sync
// core (so a Claude stub gets the same reconcile-based skip smarts as the
// bulk paths — one behavior improvement over the old page's direct
// syncOneConversation call).
async function syncOneRow(uuid, title) {
  const scry = await loadScrySettings();
  if (!scry.url) { showToast('Set your Scry URL in Options first', true); return; }
  if (!(await ensureScryPermission(scry.url))) { showToast('Host permission for Scry was declined', true); return; }

  const source = SOURCES[activeSource];
  const ctx = sourceCtx[activeSource];
  const item = (sourceItems[activeSource] || []).find((it) => it.uuid === uuid);
  if (!item) { showToast('Conversation not found — try reloading', true); return; }

  showToast(`Syncing ${title || uuid}…`);
  try {
    const result = await syncBatch(source, ctx, scry, [item]);
    if (result.failed.length > 0) throw result.failed[0].error;

    const syncedMap = await getScrySyncedMap();
    const succ = result.succeeded[0];
    syncedMap[uuid] = (succ && succ.result && succ.result.updatedAt) || item.updated_at;
    await setScrySyncedMap(syncedMap);
    await refreshSyncStatus();
    showToast('Synced to Scry ✓');
  } catch (e) {
    console.error('Scry sync failed for', uuid, e);
    showToast(`Sync failed: ${e.message}`, true);
  }
}

// ===== event listeners =====

function setupEventListeners() {
  const settingsBtn = document.getElementById('settingsBtn');
  const settingsDropdown = document.getElementById('settingsDropdown');

  settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    settingsDropdown.classList.toggle('open');
    if (settingsDropdown.classList.contains('open')) {
      const orgDisplay = document.getElementById('orgIdDisplay');
      const orgId = sourceCtx.claude.orgId;
      if (orgId) {
        orgDisplay.textContent = orgId.substring(0, 8) + '...';
        orgDisplay.title = orgId;
      } else {
        orgDisplay.textContent = 'Not set';
      }
      const theme = document.documentElement.getAttribute('data-theme') || 'dark';
      document.getElementById('themeLabel').textContent = theme === 'dark' ? 'Dark' : 'Light';
    }
  });

  document.addEventListener('click', () => {
    settingsDropdown.classList.remove('open');
  });
  settingsDropdown.addEventListener('click', (e) => { e.stopPropagation(); });

  document.getElementById('themeToggle').addEventListener('click', () => {
    toggleTheme();
    const theme = document.documentElement.getAttribute('data-theme') || 'dark';
    document.getElementById('themeLabel').textContent = theme === 'dark' ? 'Dark' : 'Light';
  });

  document.getElementById('settingsOrgId').addEventListener('click', async () => {
    const orgId = sourceCtx.claude.orgId;
    if (!orgId) { showToast('No org ID set', true); return; }
    try {
      await navigator.clipboard.writeText(orgId);
      showToast('Org ID copied to clipboard');
    } catch (e) {
      showToast('Failed to copy org ID', true);
    }
    settingsDropdown.classList.remove('open');
  });

  document.getElementById('editOrgId').addEventListener('click', () => {
    window.location.href = chrome.runtime.getURL('options.html');
  });

  document.getElementById('advancedOptions').addEventListener('click', () => {
    window.location.href = chrome.runtime.getURL('options.html');
  });

  // Scoped to the ACTIVE source's conversations — a Claude-tab click doesn't
  // touch ChatGPT's sync state and vice versa.
  document.getElementById('markAllExported').addEventListener('click', async () => {
    const ids = (sourceItems[activeSource] || []).map((c) => c.uuid).filter(Boolean);
    const now = new Date().toISOString();
    for (const id of ids) exportTimestamps[id] = now;
    await setScrySyncedMap(exportTimestamps);
    applyFiltersAndSort();
    settingsDropdown.classList.remove('open');
    showToast(`Marked ${ids.length} conversations as exported`);
  });

  document.getElementById('markAllNew').addEventListener('click', async () => {
    const ids = (sourceItems[activeSource] || []).map((c) => c.uuid).filter(Boolean);
    for (const id of ids) delete exportTimestamps[id];
    await setScrySyncedMap(exportTimestamps);
    selectedConversations.clear();
    applyFiltersAndSort();
    autoSelectNewUpdated();
    settingsDropdown.classList.remove('open');
    showToast(`Marked ${ids.length} conversations as new`);
  });

  document.getElementById('backupData').addEventListener('click', () => {
    backupExtensionData((success, message) => showToast(message, !success));
    settingsDropdown.classList.remove('open');
  });

  let pendingImportMode = null;
  document.getElementById('restoreData').addEventListener('click', () => {
    settingsDropdown.classList.remove('open');
    showImportModeModal((mode) => {
      if (mode === null) return;
      pendingImportMode = mode;
      document.getElementById('restoreFileBrowse').click();
    });
  });

  document.getElementById('restoreFileBrowse').addEventListener('change', (event) => {
    const file = event.target.files[0];
    event.target.value = '';
    const mode = pendingImportMode;
    pendingImportMode = null;
    if (!file || !mode) return;
    importBackup(file, mode, (success, message) => showToast(message, !success));
  });

  const searchInput = document.getElementById('searchInput');
  searchInput.addEventListener('input', (e) => {
    const searchBox = document.getElementById('searchBox');
    if (e.target.value) searchBox.classList.add('has-text');
    else searchBox.classList.remove('has-text');
    applyFiltersAndSort();
  });

  document.getElementById('clearSearch').addEventListener('click', () => {
    document.getElementById('searchInput').value = '';
    document.getElementById('searchBox').classList.remove('has-text');
    applyFiltersAndSort();
  });

  const filterBtn = document.getElementById('filterBtn');
  const filterDropdown = document.getElementById('filterDropdown');
  filterBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    filterDropdown.classList.toggle('open');
  });
  document.addEventListener('click', () => { filterDropdown.classList.remove('open'); });
  filterDropdown.addEventListener('click', (e) => { e.stopPropagation(); });

  document.querySelectorAll('.filter-option').forEach((option) => {
    option.addEventListener('click', () => {
      statusFilter = option.dataset.value;
      document.querySelectorAll('.filter-option').forEach((o) => o.classList.remove('selected'));
      option.classList.add('selected');
      filterBtn.classList.toggle('active', statusFilter !== 'all');
      filterDropdown.classList.remove('open');
      applyFiltersAndSort();
    });
  });
  document.querySelector('.filter-option[data-value="all"]').classList.add('selected');

  const syncSelectedBtn = document.getElementById('syncSelectedBtn');
  if (syncSelectedBtn) syncSelectedBtn.addEventListener('click', () => syncSelectedToScry());

  const syncRecentBtn = document.getElementById('syncRecentBtn');
  if (syncRecentBtn) {
    syncRecentBtn.addEventListener('click', () => {
      const days = parseInt(document.getElementById('syncRecentDays').value, 10);
      syncRecentToScry(Number.isFinite(days) && days > 0 ? days : 7);
    });
  }

  const reconcileBtn = document.getElementById('reconcileBtn');
  if (reconcileBtn) reconcileBtn.addEventListener('click', () => reconcileAndSyncUI());

  const deleteFromClaudeBtn = document.getElementById('deleteFromClaudeBtn');
  if (deleteFromClaudeBtn) deleteFromClaudeBtn.addEventListener('click', () => deleteSelectedFromClaude());
}
