// Shared utility functions for Scry Sync

// Helper function to reconstruct the current branch from the message tree
function getCurrentBranch(data) {
  const messages = data.chat_messages;
  if (!messages || messages.length === 0) {
    return [];
  }

  // Create a map of UUID to message for quick lookup
  const messageMap = new Map();
  messages.forEach(msg => {
    messageMap.set(msg.uuid, msg);
  });

  // No usable leaf pointer (missing, or pointing outside the returned messages):
  // fall back to all messages in array order so a conversation that HAS content
  // but no current_leaf is still captured rather than dropped. Mirrors the
  // server-side current_branch_messages fallback.
  const leaf = data.current_leaf_message_uuid;
  if (!leaf || !messageMap.has(leaf)) {
    return messages.slice();
  }

  // Trace back from the current leaf to the root
  const branch = [];
  let currentUuid = leaf;
  
  while (currentUuid && messageMap.has(currentUuid)) {
    const message = messageMap.get(currentUuid);
    branch.unshift(message); // Add to beginning to maintain order
    currentUuid = message.parent_message_uuid;
    
    // Stop if we hit the root (parent UUID that doesn't exist in our messages)
    if (!messageMap.has(currentUuid)) {
      break;
    }
  }
  
  return branch;
}

// ===== Image file handling =====
// Claude stores uploaded/pasted images on each message in a `files` (or legacy
// `files_v2`) array with `file_kind === 'image'`. Each entry carries relative
// preview_url / thumbnail_url paths served under https://claude.ai, fetchable
// same-origin with credentials. These helpers are shared by the markdown/text
// renderers (for inline references) and the export handlers (to bundle bytes).

// Derive an image extension from the original file name; default to .png.
function getImageExtension(fileName) {
  const m = typeof fileName === 'string' ? fileName.match(/\.([a-zA-Z0-9]+)$/) : null;
  return m ? `.${m[1].toLowerCase()}` : '.png';
}

// Deterministic, collision-free filename for a stored image. Keyed on file_uuid
// so the inline markdown reference and the saved zip entry always agree without
// any shared dedup state between the renderer and the export handler.
function imageAssetName(file) {
  return `${file.file_uuid || 'image'}${getImageExtension(file.file_name)}`;
}

// Absolute, credentialed-fetchable URL for the best available image variant
// (full-size preview preferred, thumbnail as fallback). Returns null if none.
function imageAssetUrl(file) {
  const rel = file.preview_url
    || file.thumbnail_url
    || (file.preview_asset && file.preview_asset.url)
    || (file.thumbnail_asset && file.thumbnail_asset.url);
  if (!rel) return null;
  return /^https?:\/\//.test(rel) ? rel : `https://claude.ai${rel}`;
}

// Image files attached to a single message (uploaded/pasted images only).
function getMessageImageFiles(message) {
  const out = [];
  for (const list of [message.files, message.files_v2]) {
    if (!Array.isArray(list)) continue;
    for (const f of list) {
      if (f && f.file_kind === 'image' && imageAssetUrl(f)) out.push(f);
    }
  }
  return out;
}

// Collect every image across the current branch with the info needed to fetch
// and name the saved file. De-duplicated by asset name (same file referenced
// twice is stored once). Used by export handlers to bundle image bytes.
function collectImageFiles(data) {
  const out = [];
  const seen = new Set();
  for (const message of getCurrentBranch(data)) {
    for (const f of getMessageImageFiles(message)) {
      const name = imageAssetName(f);
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ url: imageAssetUrl(f), name, fileName: f.file_name || name });
    }
  }
  return out;
}

// ===== Full-fidelity file capture (ANY file kind) =====
// The endgame is deleting conversations off Claude's servers, so we must capture
// the ORIGINAL bytes of every uploaded file — not just images. Claude retains the
// original for non-text-extractable files (image/scanned PDFs, binaries) and
// exposes it on the message's file entry as `document_asset.url`
// (file_variant 'original'); images expose preview/thumbnail. The Anthropic export
// omits all of these bytes, so the extension (with its authenticated session) is
// the only thing that can fetch them.

// Absolute url. Relative claude.ai paths are resolved against the origin.
function _absClaudeUrl(rel) {
  if (!rel) return null;
  return /^https?:\/\//.test(rel) ? rel : `https://claude.ai${rel}`;
}

// Best credentialed-fetchable asset for any file entry, with its variant.
// Documents → the original bytes; images → preview, then thumbnail. null if none.
function fileAssetRef(file) {
  if (!file) return null;
  if (file.document_asset && file.document_asset.url) {
    return {
      url: _absClaudeUrl(file.document_asset.url),
      variant: file.document_asset.file_variant || 'original',
    };
  }
  const preview = file.preview_url || (file.preview_asset && file.preview_asset.url);
  if (preview) {
    return {
      url: _absClaudeUrl(preview),
      variant: (file.preview_asset && file.preview_asset.file_variant) || 'preview',
    };
  }
  const thumb = file.thumbnail_url || (file.thumbnail_asset && file.thumbnail_asset.url);
  if (thumb) return { url: _absClaudeUrl(thumb), variant: 'thumbnail' };
  return null;
}

// Every fetchable file across the WHOLE conversation tree (all branches, both
// `files` and legacy `files_v2`) with the metadata Scry needs to store and key
// each blob. De-duplicated by (file_uuid, variant). Iterates all chat_messages
// (not just the current branch) so files on abandoned branches are captured too.
function collectAllFiles(data) {
  const out = [];
  const seen = new Set();
  const messages = Array.isArray(data && data.chat_messages) ? data.chat_messages : [];
  for (const message of messages) {
    for (const list of [message.files, message.files_v2]) {
      if (!Array.isArray(list)) continue;
      for (const f of list) {
        if (!f || !f.file_uuid) continue;
        const ref = fileAssetRef(f);
        if (!ref || !ref.url) continue;
        const key = `${f.file_uuid}:${ref.variant}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          file_uuid: f.file_uuid,
          file_name: f.file_name || null,
          file_type: f.file_type || null,
          file_variant: ref.variant,
          file_kind: f.file_kind || null,
          url: ref.url,
        });
      }
    }
  }
  return out;
}

// ----- Model utilities -----

// Default model timeline for null models — each entry is when that model became the default
const DEFAULT_MODEL_TIMELINE = [
  { date: new Date('2024-01-01'), model: 'claude-3-sonnet-20240229' },
  { date: new Date('2024-06-20'), model: 'claude-3-5-sonnet-20240620' },
  { date: new Date('2024-10-22'), model: 'claude-3-5-sonnet-20241022' },
  { date: new Date('2025-02-24'), model: 'claude-3-7-sonnet-20250219' },
  { date: new Date('2025-05-22'), model: 'claude-sonnet-4-20250514' },
  { date: new Date('2025-09-29'), model: 'claude-sonnet-4-5-20250929' },
  { date: new Date('2026-02-17'), model: 'claude-sonnet-4-6' }
];

// Returns conversation.model if set; otherwise infers from created_at via the timeline
function inferModel(conversation) {
  if (conversation.model) {
    return conversation.model;
  }
  const conversationDate = new Date(conversation.created_at);
  for (let i = DEFAULT_MODEL_TIMELINE.length - 1; i >= 0; i--) {
    if (conversationDate >= DEFAULT_MODEL_TIMELINE[i].date) {
      return DEFAULT_MODEL_TIMELINE[i].model;
    }
  }
  return DEFAULT_MODEL_TIMELINE[0].model;
}

// Format a model ID like `claude-sonnet-4-5-20250929` into "Claude Sonnet 4.5".
// Schema reference: https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions
// Handles three documented shapes for the sonnet/opus/haiku families:
//   - Dateless 4.6+:        claude-{name}-{major}-{minor}            (canonical snapshot)
//   - Dated pre-4.6:        claude-{name}-{major}-{minor}-{YYYYMMDD}
//   - Convenience alias:    claude-{name}-{major}-{minor}            (resolves to most recent dated snapshot)
// Unknown families (anything not in `(sonnet|opus|haiku)`) fall through to raw display.
function formatModelName(model) {
  if (!model || !model.startsWith('claude-')) {
    return model || 'Unknown';
  }

  // New format: claude-{type}-{major}[-{minor}][-{date}]
  const newFormatMatch = model.match(/^claude-(sonnet|opus|haiku)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/i);
  if (newFormatMatch) {
    const [, modelType, major, minor] = newFormatMatch;
    const modelName = modelType.charAt(0).toUpperCase() + modelType.slice(1);
    const version = minor ? `${major}.${minor}` : major;
    return `Claude ${modelName} ${version}`;
  }

  // Old format: claude-{major}[-{minor}]-{type}-{date}
  const oldFormatMatch = model.match(/^claude-(\d+)(?:-(\d+))?-(sonnet|opus|haiku)-\d{8}$/i);
  if (oldFormatMatch) {
    const [, major, minor, modelType] = oldFormatMatch;
    const modelName = modelType.charAt(0).toUpperCase() + modelType.slice(1);
    const version = minor ? `${major}.${minor}` : major;
    return `Claude ${modelName} ${version}`;
  }

  return model;
}

// Returns CSS badge class name based on the model family
function getModelBadgeClass(model) {
  if (!model) return '';
  if (model.includes('sonnet')) return 'sonnet';
  if (model.includes('opus')) return 'opus';
  if (model.includes('haiku')) return 'haiku';
  return '';
}

// ----- Extension data backup / restore -----

// Download all extension storage (local + sync) as a structured JSON file.
// onComplete(success, message) reports the result so each caller can show it
// its own way (options page status line vs. browse-page toast).
function backupExtensionData(onComplete) {
  chrome.storage.local.get(null, (local) => {
    chrome.storage.sync.get(null, (sync) => {
      const backup = {
        _meta: {
          app: 'claude-exporter',
          backupVersion: 1,
          extensionVersion: chrome.runtime.getManifest().version,
          createdAt: new Date().toISOString()
        },
        local: local || {},
        sync: sync || {}
      };
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const now = new Date();
      const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
      const hms = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
      a.download = `claude-exporter-backup-${ymd}-${hms}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      const snapCount = Object.keys(backup.local.modelSnapshots || {}).length;
      const exportCount = Object.keys(backup.local.exportTimestamps || {}).length;
      if (onComplete) onComplete(true, `Backup exported — ${snapCount} model snapshot(s), ${exportCount} export record(s).`);
    });
  });
}

// Conservative merge: for each top-level key in `backup`, if the key is absent
// locally, copy it over; if both sides are plain objects (UUID-keyed records
// like exportTimestamps / modelSnapshots), merge their sub-keys with local
// winning on overlap. Scalar conflicts (org ID, date format, etc.) keep the
// local value untouched.
function mergeStorageData(current, backup) {
  const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const result = { ...current };
  for (const [key, backupVal] of Object.entries(backup || {})) {
    if (!(key in current)) {
      result[key] = backupVal;
    } else if (isPlainObject(current[key]) && isPlainObject(backupVal)) {
      result[key] = { ...backupVal, ...current[key] };
    }
    // else: scalar conflict — current value is already in result, keep it
  }
  return result;
}

// Show a modal letting the user choose merge vs replace BEFORE the OS file
// picker opens. onConfirm(mode) fires with 'merge' / 'replace' when the user
// commits, or null on Cancel / Esc / overlay click. The caller is responsible
// for opening the file picker after a non-null mode.
function showImportModeModal(onConfirm) {
  if (!document.getElementById('claude-exporter-modal-styles')) {
    const style = document.createElement('style');
    style.id = 'claude-exporter-modal-styles';
    style.textContent = `
      .ce-modal-overlay {
        position: fixed; inset: 0; background: rgba(0, 0, 0, 0.55);
        display: flex; align-items: center; justify-content: center;
        z-index: 100000; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      }
      .ce-modal {
        background: var(--bg-body, #ffffff);
        color: var(--text-primary, #2c313a);
        padding: 22px 24px;
        border-radius: 8px;
        max-width: 480px; width: 90%;
        box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
        border: 1px solid var(--border-color, #e2e4e9);
      }
      .ce-modal h2 { margin: 0 0 14px; font-size: 17px; font-weight: 600; }
      .ce-modal-info {
        background: var(--section-bg, var(--bg-card, #f8f9fa));
        padding: 10px 12px;
        border-radius: 5px;
        margin-bottom: 14px;
        font-size: 13px;
        line-height: 1.5;
        border: 1px solid var(--border-color, #e2e4e9);
      }
      .ce-modal-option {
        display: block; padding: 10px 12px; border-radius: 5px;
        margin-bottom: 8px; cursor: pointer;
        border: 1px solid var(--border-color, #e2e4e9);
        background: var(--bg-body, #ffffff);
        font-size: 13px;
      }
      .ce-modal-option:hover { border-color: var(--primary-color, #5d44e8); }
      .ce-modal-option input { margin-right: 6px; vertical-align: middle; }
      .ce-modal-option strong { font-weight: 600; }
      .ce-modal-option-desc {
        display: block; margin: 4px 0 0 22px;
        font-size: 12px;
        color: var(--text-secondary, #666666);
      }
      .ce-modal-actions {
        display: flex; justify-content: flex-end; gap: 10px; margin-top: 16px;
      }
      .ce-modal-actions button {
        padding: 8px 16px; border-radius: 5px; border: none;
        cursor: pointer; font-size: 14px;
        display: inline-flex; align-items: center; justify-content: center;
        line-height: 1;
      }
      .ce-modal-cancel {
        background: var(--section-bg, var(--bg-card, #e9ecef));
        color: var(--text-primary, #2c313a);
        border: 1px solid var(--border-color, #e2e4e9) !important;
      }
      .ce-modal-import {
        background: var(--primary-color, #5d44e8);
        color: #ffffff;
      }
      .ce-modal-import:hover { background: var(--primary-hover, #4a35ba); }
    `;
    document.head.appendChild(style);
  }

  // Remove any stale modal before showing a new one
  const stale = document.querySelector('.ce-modal-overlay');
  if (stale) stale.remove();

  const overlay = document.createElement('div');
  overlay.className = 'ce-modal-overlay';
  overlay.innerHTML = `
    <div class="ce-modal" role="dialog" aria-modal="true" aria-labelledby="ce-modal-title">
      <h2 id="ce-modal-title">Import Backup</h2>
      <div class="ce-modal-info">
        Choose how the imported data should be combined with your current data, then pick a backup file.
      </div>
      <label class="ce-modal-option">
        <input type="radio" name="ce-import-mode" value="merge" checked>
        <strong>Merge with current data</strong>
        <span class="ce-modal-option-desc">Adds entries not present locally; keeps your current values when they overlap.</span>
      </label>
      <label class="ce-modal-option">
        <input type="radio" name="ce-import-mode" value="replace">
        <strong>Replace all current data</strong>
        <span class="ce-modal-option-desc">Overwrites everything with this backup's contents.</span>
      </label>
      <div class="ce-modal-actions">
        <button type="button" class="ce-modal-cancel">Cancel</button>
        <button type="button" class="ce-modal-import">Choose File&hellip;</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const cleanup = (mode) => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    onConfirm(mode);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') cleanup(null);
    else if (e.key === 'Enter') cleanup(overlay.querySelector('input[name="ce-import-mode"]:checked').value);
  };
  document.addEventListener('keydown', onKey);

  overlay.querySelector('.ce-modal-cancel').addEventListener('click', () => cleanup(null));
  overlay.querySelector('.ce-modal-import').addEventListener('click', () => {
    cleanup(overlay.querySelector('input[name="ce-import-mode"]:checked').value);
  });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(null); });

  // Focus the default radio so keyboard users can act immediately
  const firstRadio = overlay.querySelector('input[name="ce-import-mode"]');
  if (firstRadio) firstRadio.focus();
}

// Import extension storage from a file produced by backupExtensionData.
// Validates the file, then writes to local + sync using the supplied mode
// ('merge' or 'replace'). The mode choice is made BEFORE the file picker
// opens (see showImportModeModal), so this function just executes.
function importBackup(file, mode, onComplete) {
  const reader = new FileReader();
  reader.onload = (e) => {
    let backup;
    try {
      backup = JSON.parse(e.target.result);
    } catch (err) {
      if (onComplete) onComplete(false, 'Import failed: the file is not valid JSON.');
      return;
    }

    if (!backup || typeof backup !== 'object' || !backup._meta ||
        backup._meta.app !== 'claude-exporter' || typeof backup.local !== 'object') {
      if (onComplete) onComplete(false, 'Import failed: this does not look like a Scry Sync backup file.');
      return;
    }

    const snapCount = Object.keys(backup.local.modelSnapshots || {}).length;
    const exportCount = Object.keys(backup.local.exportTimestamps || {}).length;
    const syncData = (backup.sync && typeof backup.sync === 'object') ? backup.sync : {};

    if (mode === 'replace') {
      chrome.storage.local.set(backup.local, () => {
        chrome.storage.sync.set(syncData, () => {
          if (onComplete) onComplete(true, `Import complete (replace) — ${snapCount} model snapshot(s), ${exportCount} export record(s) restored. Reload any open Claude pages and the browse page to see the changes.`);
        });
      });
    } else {
      // Merge: missing keys added, conflicts keep local
      chrome.storage.local.get(null, (currentLocal) => {
        chrome.storage.sync.get(null, (currentSync) => {
          const mergedLocal = mergeStorageData(currentLocal || {}, backup.local);
          const mergedSync = mergeStorageData(currentSync || {}, syncData);
          chrome.storage.local.set(mergedLocal, () => {
            chrome.storage.sync.set(mergedSync, () => {
              if (onComplete) onComplete(true, `Import complete (merge) — added missing entries from backup, kept your current values on overlap. Reload any open Claude pages and the browse page to see the changes.`);
            });
          });
        });
      });
    }
  };
  reader.readAsText(file);
}

// ----- Error capture & diagnostics -----
// Captures unhandled errors and rejected promises into a ring buffer in
// chrome.storage.local. The user can later download a sanitized diagnostics
// bundle (Options page → Contact & Diagnostics) to attach to a bug report.
// Sanitization runs at capture time: any UUID-looking substring (chat / org /
// project IDs that may appear in fetch URLs or stack traces) is replaced with
// "<id>" so we never persist identifiers.

const CE_UUID_REGEX = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const CE_ERROR_LOG_MAX = 50;

function sanitizeForDiagnostics(value) {
  if (typeof value !== 'string') return value;
  return value.replace(CE_UUID_REGEX, '<id>');
}

function initErrorCapture(context) {
  if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;

  // Re-entry guard: if our own push() throws, don't loop into the listener.
  let suppressed = false;

  const push = (entry) => {
    if (suppressed) return;
    suppressed = true;
    try {
      chrome.storage.local.get(['errorLog'], (result) => {
        try {
          const log = Array.isArray(result.errorLog) ? result.errorLog : [];
          log.push(entry);
          if (log.length > CE_ERROR_LOG_MAX) {
            log.splice(0, log.length - CE_ERROR_LOG_MAX);
          }
          chrome.storage.local.set({ errorLog: log }, () => { suppressed = false; });
        } catch (e) { suppressed = false; }
      });
    } catch (e) { suppressed = false; }
  };

  const target = (typeof globalThis !== 'undefined') ? globalThis : self;

  target.addEventListener('error', (event) => {
    push({
      ts: new Date().toISOString(),
      level: 'error',
      context,
      msg: sanitizeForDiagnostics(String(event.message || '')),
      source: event.filename ? sanitizeForDiagnostics(String(event.filename)) : null,
      line: event.lineno || null,
      col: event.colno || null,
      stack: event.error && event.error.stack ? sanitizeForDiagnostics(String(event.error.stack)) : null
    });
  });

  target.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const msg = reason && reason.message ? String(reason.message)
              : (reason !== undefined ? String(reason) : '(no reason)');
    push({
      ts: new Date().toISOString(),
      level: 'unhandledrejection',
      context,
      msg: sanitizeForDiagnostics(msg),
      stack: reason && reason.stack ? sanitizeForDiagnostics(String(reason.stack)) : null
    });
  });
}

// Build a sanitized diagnostics bundle and trigger a download. Callers may
// pass an onComplete(success, message) callback for status reporting.
function generateDiagnostics(onComplete) {
  const manifest = chrome.runtime.getManifest();

  chrome.storage.local.get(
    ['errorLog', 'modelSnapshots', 'exportTimestamps', 'dateFormat', 'timeFormat', 'modelDisplay'],
    (local) => {
      chrome.storage.sync.get(['organizationId'], (sync) => {
        const errorLog = Array.isArray(local.errorLog) ? local.errorLog : [];
        const diagnostics = {
          _meta: {
            app: 'claude-exporter',
            diagnosticsVersion: 1,
            generatedAt: new Date().toISOString()
          },
          extension: {
            name: manifest.name,
            version: manifest.version
          },
          environment: {
            userAgent: (typeof navigator !== 'undefined' && navigator.userAgent) || null,
            platform: (typeof navigator !== 'undefined' && navigator.platform) || null,
            language: (typeof navigator !== 'undefined' && navigator.language) || null
          },
          preferences: {
            dateFormat: local.dateFormat || 'mdy',
            timeFormat: local.timeFormat || '12h',
            modelDisplay: local.modelDisplay === 'current' ? 'current' : 'original',
            orgIdConfigured: !!(sync && sync.organizationId)
          },
          counts: {
            modelSnapshots: Object.keys(local.modelSnapshots || {}).length,
            exportTimestamps: Object.keys(local.exportTimestamps || {}).length,
            errors: errorLog.length
          },
          errors: errorLog
        };

        const now = new Date();
        const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
        const hms = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;

        const blob = new Blob([JSON.stringify(diagnostics, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `claude-exporter-diagnostics-${ymd}-${hms}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        if (onComplete) {
          onComplete(true, `Diagnostics downloaded — ${errorLog.length} error(s) captured, all IDs redacted.`);
        }
      });
    }
  );
}

// Functions are available globally in the browser context
// In Node (vitest), expose them via module.exports for testing
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    getCurrentBranch,
    getImageExtension,
    imageAssetName,
    imageAssetUrl,
    getMessageImageFiles,
    collectImageFiles,
    fileAssetRef,
    collectAllFiles,
    DEFAULT_MODEL_TIMELINE,
    inferModel,
    formatModelName,
    getModelBadgeClass,
    backupExtensionData,
    importBackup,
    mergeStorageData,
    sanitizeForDiagnostics,
  };
}
