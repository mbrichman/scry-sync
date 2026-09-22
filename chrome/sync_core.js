// The shared sync core: ONE implementation of "sync a batch of items for a
// source" and "reconcile then sync", used by all three callers that used to
// carry their own near-identical copy — the continuous background engine
// (continuous_sync.js's _syncBatch/_runDeepReconcile), the Claude dashboard's
// manual sync (browse.js's syncCandidateList/reconcileAndSync), and the
// ChatGPT page's push (chatgpt.js's pushSelectedToScry, which had a THIRD copy
// of the per-conversation fetch/post loop on top of that).
//
// `source` is a SOURCES entry (chrome/sources.js): { name, syncOne, reconcile,
// isStubError, errorDomain, ... }. Progress/cancellation are INJECTED callbacks
// (onProgress, signal) so this file stays free of any UI coupling — each
// caller wires its own progress bar / status line / cancel button to them.
// Trigger/planning (the alarm-driven watermark walk vs. a manual button over a
// selection) is deliberately NOT here — that stays per-caller (continuous_sync.js
// keeps its state machine; browse.js/chatgpt.js keep their own selection UI).
//
// Load order: utils.js, scry_sync.js, scry_client.js, chatgpt_adapter.js,
// sources.js, sync_core.js, [continuous_sync.js — background service worker
// only].

// --- resolvers for globals defined in earlier-loaded files (browser) /
// required modules (Node/vitest). Mirrors the pattern continuous_sync.js
// already uses for chatgpt_adapter.js's globals.
function _runPool() {
  return (typeof runPool !== 'undefined') ? runPool : require('./scry_sync.js').runPool;
}
function _classifyStubAfterReconcile() {
  return (typeof classifyStubAfterReconcile !== 'undefined')
    ? classifyStubAfterReconcile
    : require('./sources.js').classifyStubAfterReconcile;
}

// Map a reconcile report's to_resync ids onto the enumerated conversation
// objects (reconcile returns ids, not bodies). Ids no longer present in the
// enumerated list (deleted at the source since enumeration) are silently
// dropped rather than erroring. Same semantics as continuous_sync.js's
// planDeepReconcile (kept there too, and separately tested, since the pure
// planning suite it lives alongside is unit-tested on its own) — duplicated
// here as a small private helper rather than reached for across files, since
// sync_core.js loads BEFORE continuous_sync.js and must not depend on it.
function _mapToResync(conversations, toResyncIds) {
  const idSet = new Set(toResyncIds || []);
  return (conversations || []).filter((c) => c && idSet.has(c.uuid));
}

// Sync a list of items one at a time (bounded pool). Per-item failures are
// caught and collected rather than aborting the whole batch.
//
// A stub failure (source.isStubError(e) — currently only Claude's claude.ai
// 200-with-empty-body) gets a second opinion from Scry's reconcile before it
// may count as a failure: a conversation Scry has deliberately tombstoned (or
// already holds complete) counts as a deliberate SKIP — success — not a
// failure. Only a server-authoritative "not wanted" can do this; a reconcile
// error keeps the original failure (fail safe: never guess). ChatGPT's
// isStubError is always false, so this path never triggers for it.
//
// `signal` (an AbortSignal-like `{ aborted }`) is checked before each item
// starts: once aborted, remaining not-yet-started items are neither synced
// nor counted as failed (they simply don't appear in the result). An item
// already in flight when the abort lands still runs to completion — aborting
// stops new work, it doesn't cancel a request mid-flight.
//
// `onProgress({ done, total, item, ok })` is called (and awaited, if it
// returns a promise) after each item that actually ran — a stub-skip counts
// as `ok: true`. `onStubReconcile({ item, report, classification })` is an
// optional hook fired right after a stub's reconcile-based classification is
// decided, for callers that want visibility into that path specifically.
//
// Returns { pushed, succeeded: [{item, result}], failed: [{item, error}],
// firstFailure, tombstonedSkips }. `succeeded` carries `source.syncOne`'s
// return value per item (null for a stub-skip, which never called syncOne
// successfully) so a caller can summarize source-specific per-item detail —
// e.g. the ChatGPT page's "K image files stored" report.
async function syncBatch(source, ctx, scry, items, opts = {}) {
  const { onProgress, signal, onStubReconcile } = opts;
  const pool = _runPool();
  const classify = _classifyStubAfterReconcile();
  const concurrency = (opts.concurrency && opts.concurrency > 0)
    ? opts.concurrency
    : ((scry && scry.concurrency && scry.concurrency > 0) ? scry.concurrency : 4);

  const list = items || [];
  const total = list.length;
  let pushed = 0;
  let done = 0;
  const succeeded = [];
  const failed = [];
  const tombstonedSkips = [];
  let firstFailure = null;

  await pool(list, concurrency, async (item) => {
    // Checked before each item starts: an abort mid-batch leaves everything
    // not-yet-started out of both succeeded and failed.
    if (signal && signal.aborted) return;

    try {
      const result = await source.syncOne(ctx, item, scry);
      pushed++;
      succeeded.push({ item, result });
      done++;
      if (onProgress) await onProgress({ done, total, item, ok: true });
      return;
    } catch (e) {
      if (source.isStubError(e)) {
        try {
          const report = await source.reconcile(scry, [item.uuid]);
          const cls = classify(report, item.uuid);
          if (onStubReconcile) onStubReconcile({ item, report, classification: cls });
          if (cls !== 'wanted') {
            console.warn(`Scry sync (${source.name}): skipping`, item.uuid,
              cls === 'tombstoned' ? '(stub at source, tombstoned in Scry — permanent skip)'
                                   : '(stub at source, not wanted by Scry)');
            succeeded.push({ item, result: null });
            if (cls === 'tombstoned') tombstonedSkips.push(item.uuid);
            done++;
            if (onProgress) await onProgress({ done, total, item, ok: true });
            return;
          }
        } catch (_re) { /* reconcile unreachable — keep the original failure */ }
      }
      console.error(`Scry sync (${source.name}): failed for`, item.uuid, e);
      const failure = { item, error: e };
      failed.push(failure);
      if (!firstFailure) firstFailure = failure;
      done++;
      if (onProgress) await onProgress({ done, total, item, ok: false });
    }
  });

  return { pushed, succeeded, failed, firstFailure, tombstonedSkips };
}

// Reconcile, then sync exactly what Scry says it still wants. Enumeration is
// the CALLER's job (it differs per caller: a tab-relay for browse.js, a
// direct fetch for the continuous engine) — this takes the already-enumerated,
// normalized list ({uuid, updated_at, ...}).
//
// `source.reconcile(scry, conversations)` is called with full objects
// (staleness-aware: a conversation Scry holds "complete" but that grew at the
// source since is still surfaced in to_resync). If reconcile throws, this
// rethrows — the caller decides which failure domain that is (e.g. the
// continuous engine files it under 'scry'; browse.js shows a toast).
//
// `cap`, if given, truncates the wanted list before syncing (the continuous
// engine's INCREMENTAL_BATCH_CAP semantics are applied by the caller if it
// wants that — deep reconcile today passes no cap, matching its "exhaustive
// catch-up pass" behavior).
//
// Returns { report, toSync, ...syncBatch's result }.
async function reconcileAndSync(source, ctx, scry, conversations, opts = {}) {
  const { onProgress, signal, cap } = opts;
  const report = await source.reconcile(scry, conversations);
  let toSync = _mapToResync(conversations, report && report.to_resync);
  if (typeof cap === 'number' && cap >= 0) toSync = toSync.slice(0, cap);
  const batchResult = await syncBatch(source, ctx, scry, toSync, { onProgress, signal });
  return { report, toSync, ...batchResult };
}

// Browser: expose globally. Node (vitest): export.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { syncBatch, reconcileAndSync };
}
