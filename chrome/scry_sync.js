// Scry sync — pure transforms for pushing Claude.ai conversations into Scry.
//
// The imperative loop (list → fetch bodies → fetch image bytes → POST) lives in
// the sync UI; these helpers hold the contract with Scry's
// POST /api/conversations/ingest endpoint so it can be unit-tested in isolation:
//   - buildIngestPayload: prune a conversation to its visible thread and attach
//     the fetched image bytes as base64 data_urls (Scry can't fetch claude.ai's
//     authenticated /preview URLs, so the bytes must travel in the payload).
//   - selectConversationsSince: the "sync last N days" incremental filter, run
//     against the conversation list's updated_at *before* fetching any bodies.

// getCurrentBranch is a global from utils.js in the browser; a module in Node.
function _currentBranch(data) {
  const fn = (typeof getCurrentBranch !== 'undefined')
    ? getCurrentBranch
    : require('./utils.js').getCurrentBranch;
  return fn(data);
}

// Pull the MIME type out of a data URL, e.g. "data:image/png;base64,..." -> "image/png".
function _mimeFromDataUrl(dataUrl) {
  const m = /^data:([^;,]+)[;,]/.exec(dataUrl || '');
  return m ? m[1] : undefined;
}

// Build the single-conversation payload POSTed to Scry's ingest endpoint.
//
// data          - a conversation fetched from claude.ai (raw API shape)
// imageDataUrls - map of file_uuid -> "data:<mime>;base64,..." for images whose
//                 bytes were already fetched. Images without an entry are left
//                 as-is (Scry renders a placeholder for them).
// fileBlobs     - the fetched ORIGINAL bytes of every uploaded file (images, PDFs,
//                 binaries) as [{ file_uuid, file_name, file_type, file_variant,
//                 data }]. These + raw_json are the full-fidelity capture Scry
//                 needs before a conversation can be deleted from Claude.
function buildIngestPayload(data, imageDataUrls = {}, fileBlobs = []) {
  const chat_messages = _currentBranch(data).map((msg) => {
    // Clone so we never mutate the caller's conversation.
    const out = JSON.parse(JSON.stringify(msg));
    if (Array.isArray(out.files)) {
      for (const file of out.files) {
        const dataUrl = file && file.file_uuid ? imageDataUrls[file.file_uuid] : undefined;
        if (dataUrl) {
          file.data_url = dataUrl;
          if (!file.file_type) {
            const mime = _mimeFromDataUrl(dataUrl);
            if (mime) file.file_type = mime;
          }
        }
      }
    }
    return out;
  });

  return {
    uuid: data.uuid,
    name: data.name,
    created_at: data.created_at,
    updated_at: data.updated_at,
    chat_messages,
    // The verbatim full-tree body — the fidelity backbone, immune to whatever the
    // structured importer above happens to prune or miss.
    raw_json: data,
    // Original file bytes fetched by the sync loop (base64).
    files: fileBlobs,
  };
}

// Filter a conversation list to those updated at/after `sinceMs` (epoch ms).
// `sinceMs === null` means a full sync — return everything.
function selectConversationsSince(conversations, sinceMs) {
  if (sinceMs == null) return conversations.slice();
  return conversations.filter((c) => {
    const t = Date.parse(c.updated_at);
    return !Number.isNaN(t) && t >= sinceMs;
  });
}

// Drop conversations Scry already has at their current version. `syncedMap` is
// { uuid -> last-synced updated_at (ISO) } persisted in chrome.storage; a
// conversation is skipped only when its updated_at hasn't advanced past what we
// last pushed. Avoids re-fetching/re-POSTing unchanged bodies on a re-sync.
function filterUnsynced(conversations, syncedMap = {}) {
  return conversations.filter((c) => {
    const last = syncedMap[c.uuid];
    if (!last) return true;
    return Date.parse(c.updated_at) > Date.parse(last);
  });
}

// Run `fn` with retries. Retries when the attempt throws (e.g. the Flask dev
// server dropping a large POST → "Failed to fetch") or when `shouldRetry` deems
// the returned result retryable (e.g. a 5xx). Backoff is linear: delayMs, 2×, 3×.
// After the budget is exhausted it rethrows the last error / returns the last
// result. `shouldRetry` receives { threw, err, result }; default retries only on throw.
async function withRetry(fn, { retries = 2, delayMs = 500, shouldRetry } = {}) {
  for (let attempt = 0; ; attempt++) {
    let result, err, threw = false;
    try {
      result = await fn(attempt);
    } catch (e) {
      threw = true;
      err = e;
    }
    const retryable = shouldRetry ? shouldRetry({ threw, err, result }) : threw;
    if (!retryable || attempt >= retries) {
      if (threw) throw err;
      return result;
    }
    await new Promise((r) => setTimeout(r, delayMs * (attempt + 1)));
  }
}

// Browser: expose globally. Node (vitest): export for testing.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildIngestPayload, selectConversationsSince, filterUnsynced, withRetry };
}
