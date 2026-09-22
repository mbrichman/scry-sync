// Continuous background sync — chrome.alarms-driven incremental push (every 15
// minutes) + a daily deep reconcile, on top of the shared sync core (syncBatch/
// reconcileAndSync in sync_core.js) and the SOURCES registry (sources.js) that
// also back the manual sync UIs (browse.js, chatgpt.js). This file holds:
//   - the PURE planning/state-machine helpers (unit-tested, no chrome.* calls)
//   - the impure orchestrator runContinuousSync(kind, sourceName) that wires a
//     single source to chrome.storage.local + the shared sync core, and
//     runAllContinuousSyncs(kind) that runs every source in SOURCES
//     sequentially
//
// Each source persists its own state under its own chrome.storage.local key
// (see SOURCES[*].stateKey) — Claude keeps the original "continuousSync" key
// unchanged so nothing on already-installed machines resets. The service
// worker is ephemeral (MV3), so nothing here relies on module-level mutable
// state surviving between wakes.

const CONTINUOUS_STORAGE_KEY = 'continuousSync';
const CONTINUOUS_STORAGE_KEY_CHATGPT = 'continuousSync:chatgpt';

// A wake that finds `running` younger than this is treated as still in flight
// and no-ops; older than this, a prior run is assumed crashed/killed and this
// wake proceeds anyway (the service worker can be terminated mid-run with no
// chance to clear the flag itself).
const RUNNING_STALE_MS = 10 * 60 * 1000;

// Incremental wakes sync at most this many conversations per wake; anything
// beyond that is left pending for the next wake (overflow: true).
const INCREMENTAL_BATCH_CAP = 50;

// Exponential backoff schedule for claude.ai enumeration failures (429/5xx):
// 15m -> 30m -> 60m, capped.
const BACKOFF_START_MS = 15 * 60 * 1000;
const BACKOFF_CAP_MS = 60 * 60 * 1000;

function defaultContinuousSyncState() {
  return {
    watermark: null,          // ISO ts: max updated_at fully synced by an incremental wake
    lastSyncAt: null,         // ms epoch of the last successful wake (either kind)
    lastPushed: 0,            // conversations pushed in the last successful wake
    consecutiveFailures: 0,   // consecutive failed wakes, across both failure domains
    lastError: null,          // message from the most recent failure
    errorDomain: null,        // 'claude' | 'scry' | null — which side the last failure was on
    backoffMs: null,          // current claude-domain backoff amount (for escalation)
    nextAllowedAt: null,      // ms epoch; claude.ai enumeration gated until this passes
    running: null,            // ms epoch a run started, or null; guards overlapping wakes
    skipUuids: [],            // uuids tombstoned in Scry (server-confirmed): they enumerate
                              // at claude.ai forever but must never sync or pin the watermark
  };
}

// Plan an incremental wake: which conversations to sync, and where the
// watermark should land afterward.
//
// `conversations` need not be pre-sorted — this defensively sorts. Only
// conversations strictly newer than `watermark` (null = never synced, i.e.
// everything is pending) are eligible. Within that pending set we sync the
// OLDEST first and cap the batch at INCREMENTAL_BATCH_CAP: advancing the
// watermark only to the boundary of what was actually included means anything
// left over from an oversized backlog is picked up — never silently skipped —
// by the next wake(s), since it's still newer than the new watermark.
function planIncremental(conversations, watermark, _nowMs) {
  // First run (no watermark): history is already in Scry — bulk import plus
  // the daily deep reconcile own completeness. Sync nothing and initialize
  // the watermark to the newest conversation seen, so incremental means
  // strictly NEW from here on. (Treating null as "everything pending" put a
  // multi-day oldest-first backlog crawl ahead of new conversations.)
  if (watermark == null) {
    const newest = (conversations || [])
      .filter((c) => !Number.isNaN(Date.parse(c && c.updated_at)))
      .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))[0];
    return { toSync: [], pending: [], newWatermark: newest ? newest.updated_at : null, overflow: false };
  }

  const wm = Date.parse(watermark);

  const pending = (conversations || [])
    .filter((c) => {
      const t = Date.parse(c && c.updated_at);
      return !Number.isNaN(t) && t > wm;
    })
    .sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at));

  const overflow = pending.length > INCREMENTAL_BATCH_CAP;
  const toSync = pending.slice(0, INCREMENTAL_BATCH_CAP);

  const newWatermark = toSync.length > 0
    ? toSync[toSync.length - 1].updated_at
    : (watermark == null ? null : watermark);

  // `pending` is the FULL ascending eligible list (uncapped) — the
  // reconcile-first path needs it to pass already-captured items for free.
  return { toSync, pending, newWatermark, overflow };
}

// Reconcile-first selection: of the pending (ascending) list, keep only what
// Scry actually wants (to_resync), oldest-first, capped. A null want-list
// means reconcile was unreachable — every pending item is wanted (the old
// push-everything behavior; never skip on a guess).
function selectWantedToSync(pending, toResyncIds, cap) {
  const wanted = toResyncIds == null ? null : new Set(toResyncIds);
  return (pending || [])
    .filter((c) => c && (wanted == null || wanted.has(c.uuid)))
    .slice(0, cap);
}

// Where the watermark may land after a wake: walk the pending list (ascending)
// and advance over items that are either unwanted (Scry already holds them
// complete — passable without syncing) or synced this wake; stop just before
// the earliest wanted item that didn't sync (failed or beyond the cap). A null
// want-list treats everything as wanted (old truncation behavior).
function computeWatermarkAfter(pending, wantedIds, syncedUuids, priorWatermark) {
  const wanted = wantedIds == null ? null : new Set(wantedIds);
  const synced = new Set(syncedUuids || []);
  let last = priorWatermark;
  for (const c of pending || []) {
    const isWanted = wanted == null || wanted.has(c.uuid);
    if (isWanted && !synced.has(c.uuid)) break;
    last = c.updated_at;
  }
  return last;
}

// Next backoff delay (ms) given the previous one: 15m -> 30m -> 60m, capped.
// No prior backoff (null/0/undefined) starts the schedule at 15m.
function nextBackoff(prevMs) {
  if (!prevMs || prevMs <= 0) return BACKOFF_START_MS;
  return Math.min(prevMs * 2, BACKOFF_CAP_MS);
}

// Should this wake actually do anything? Honors (in order): missing
// config (state.configured === false, set by the orchestrator from the
// scry/org-id settings — absent/undefined is treated as configured, so callers
// that don't care about this axis can omit it), an unexpired claude.ai backoff
// window, and an overlapping run (unless it's stale, i.e. abandoned by a killed
// service worker).
function shouldRun(state, nowMs) {
  const s = state || {};

  // The user's explicit off-switch (options page). Checked first so the popup
  // can say "off" rather than a confusing backoff/unconfigured reason.
  // Absent/undefined = enabled: existing installs keep syncing by default.
  if (s.continuousSyncEnabled === false) return { run: false, reason: 'disabled' };

  if (s.configured === false) return { run: false, reason: 'unconfigured' };

  if (typeof s.running === 'number') {
    const age = nowMs - s.running;
    if (age <= RUNNING_STALE_MS) return { run: false, reason: 'already-running' };
    // else: stale — a prior run never cleared the flag; proceed.
  }

  if (typeof s.nextAllowedAt === 'number' && nowMs < s.nextAllowedAt) {
    return { run: false, reason: 'backoff' };
  }

  return { run: true, reason: 'ok' };
}

// Badge to show after a wake. Silent (cleared) unless the last >=3 wakes all
// failed, regardless of which failure domain — a red "!" is the only signal;
// the popup status line carries the detail.
function badgeStateAfter(state) {
  const n = (state && state.consecutiveFailures) || 0;
  if (n >= 3) return { text: '!', color: '#d93025' };
  return { clear: true };
}

// Fold a wake's result into persisted state.
//
// result:
//   success  — { ok: true, pushed: <n>, newWatermark?: <iso> }
//              (newWatermark omitted, e.g. a deep reconcile, leaves watermark as-is)
//   failure  — { ok: false, domain: 'claude' | 'scry', error: <message> }
//   either may carry addSkipUuids: uuids newly confirmed tombstoned in Scry —
//   merged (deduplicated) into state.skipUuids even on a failed wake, so a
//   tombstone learned before an unrelated failure is never re-fetched.
//
// A success clears all failure/backoff bookkeeping. A failure increments the
// consecutive-failure counter and records the error regardless of domain, but
// only a SOURCE-domain failure (anything other than 'scry' — 'claude',
// 'chatgpt', or any future source name) touches backoffMs/nextAllowedAt — a
// Scry-side failure (mini unreachable) must not throttle the source's own
// enumeration, since the source itself is fine. `running` is always cleared:
// the wake is over. `result.domain` defaults to 'claude' when omitted, which
// preserves every pre-existing caller/test that only ever set 'claude' or
// 'scry'.
function applyResult(state, result, nowMs) {
  const s = Object.assign({}, defaultContinuousSyncState(), state, { running: null });

  if (result && result.ok) {
    s.consecutiveFailures = 0;
    s.lastError = null;
    s.errorDomain = null;
    s.backoffMs = null;
    s.nextAllowedAt = null;
    s.lastSyncAt = nowMs;
    s.lastPushed = typeof result.pushed === 'number' ? result.pushed : 0;
    if (result.newWatermark !== undefined) s.watermark = result.newWatermark;
    return _mergeSkipUuids(s, result);
  }

  s.consecutiveFailures = (state && state.consecutiveFailures || 0) + 1;
  s.lastError = (result && result.error) || 'unknown error';
  const domain = (result && result.domain) || 'claude';
  s.errorDomain = domain;
  if (domain !== 'scry') {
    const priorBackoff = state && state.backoffMs;
    s.backoffMs = nextBackoff(priorBackoff);
    s.nextAllowedAt = nowMs + s.backoffMs;
  }
  // scry-domain failure: backoffMs / nextAllowedAt intentionally untouched.
  return _mergeSkipUuids(s, result);
}

function _mergeSkipUuids(s, result) {
  if (result && Array.isArray(result.addSkipUuids) && result.addSkipUuids.length) {
    s.skipUuids = Array.from(new Set([...(s.skipUuids || []), ...result.addSkipUuids]));
  }
  return s;
}

// Drop permanently-skipped (tombstoned) uuids from an enumerated list before
// planning — they list at claude.ai forever but are terminal in Scry.
function filterSkippedConversations(conversations, skipUuids) {
  const skip = new Set(skipUuids || []);
  return (conversations || []).filter((c) => c && !skip.has(c.uuid));
}

// Map a reconcile report's to_resync ids onto the enumerated conversation
// objects (needed for the actual sync — reconcile returns ids, not bodies).
// Ids no longer present in the enumerated list (deleted at the source since
// enumeration) are silently dropped rather than erroring.
function planDeepReconcile(conversations, toResyncIds) {
  const idSet = new Set(toResyncIds || []);
  return (conversations || []).filter((c) => c && idSet.has(c.uuid));
}

// --- impure orchestrator -----------------------------------------------
//
// SOURCES, SOURCE_ORDER, and the per-source pure error-classification helpers
// (normalizeChatGptListItem, isChatGptSignedOutError, chatgptErrorDomain,
// _domainForError, isStubFetchError, classifyStubAfterReconcile) now live in
// chrome/sources.js, loaded before this file, so browse.js/chatgpt.js can use
// SOURCES without loading the alarm engine. Resolved here the same way this
// file already resolves chatgpt_adapter.js's globals: a bare reference when
// sources.js has already run in the same global scope (browser/service
// worker), a require() fallback in Node (vitest).
function _sourcesModule() {
  return (typeof SOURCES !== 'undefined')
    ? {
        SOURCES, SOURCE_ORDER, normalizeChatGptListItem, isChatGptSignedOutError,
        chatgptErrorDomain, _domainForError, isStubFetchError, classifyStubAfterReconcile,
      }
    : require('./sources.js');
}
function _sources() { return _sourcesModule().SOURCES; }
function _sourceOrder() { return _sourcesModule().SOURCE_ORDER; }

// The shared sync core (syncBatch/reconcileAndSync) — same resolution
// pattern. Loaded before this file everywhere (see load-order comment above).
function _syncCore() {
  return (typeof syncBatch !== 'undefined' && typeof reconcileAndSync !== 'undefined')
    ? { syncBatch, reconcileAndSync }
    : require('./sync_core.js');
}

// Read/write a continuous-sync state blob under `key` (defaults to the
// original single "continuousSync" key, so any existing caller that doesn't
// pass one keeps working unchanged). `storage` defaults to chrome.storage.local
// but is an explicit parameter so it can be swapped for an in-memory stub in
// tests — no global chrome.* needed to unit-test state-key isolation.
function _getState(key = CONTINUOUS_STORAGE_KEY, storage = (typeof chrome !== 'undefined' ? chrome.storage.local : null)) {
  return new Promise((resolve) =>
    storage.get([key], (r) =>
      resolve(Object.assign(defaultContinuousSyncState(), r[key] || {}))));
}
function _setState(state, key = CONTINUOUS_STORAGE_KEY, storage = (typeof chrome !== 'undefined' ? chrome.storage.local : null)) {
  return new Promise((resolve) => storage.set({ [key]: state }, resolve));
}

// Apply an already-computed badge descriptor ({clear:true} or {text,color}).
function _renderBadge(b) {
  if (b.clear) {
    chrome.action.setBadgeText({ text: '' });
  } else {
    chrome.action.setBadgeBackgroundColor({ color: b.color });
    chrome.action.setBadgeText({ text: b.text });
  }
}
function _applyBadge(state) {
  _renderBadge(badgeStateAfter(state));
}

// Badge across ALL sources: '!' if ANY source's persisted state has >=3
// consecutive failures, regardless of which source ran most recently. Reuses
// badgeStateAfter (single-state) by folding to the worst consecutiveFailures
// seen, so the failure-count → badge decision stays defined in exactly one
// place.
function badgeStateAfterAll(states) {
  const maxFailures = Math.max(0, ...(states || []).map((s) => (s && s.consecutiveFailures) || 0));
  return badgeStateAfter({ consecutiveFailures: maxFailures });
}

// Thin call into the shared sync core (chrome/sync_core.js's syncBatch): kept
// as a named function here — rather than calling syncBatch directly at each
// call site — so the two call sites below (_runIncremental, and previously
// _runDeepReconcile) read the same way they did before the extraction.
// Returns { pushed, succeeded: [{item, result}], failed, firstFailure,
// tombstonedSkips } — see sync_core.js for the full contract.
function _syncBatch(source, ctx, scry, items) {
  return _syncCore().syncBatch(source, ctx, scry, items);
}

// Classify an enumerate() failure: for chatgpt, "not signed in" is not a
// failure at all (point 3) — it short-circuits to { signedOut: true } before
// touching any failure/backoff bookkeeping. Shared by both the incremental
// and deep-reconcile wakes, since both start by enumerating.
function _classifyEnumerateError(source, e) {
  if (source.isSignedOutError && source.isSignedOutError(e)) {
    return { signedOut: true, error: e.message || String(e) };
  }
  return { ok: false, domain: source.errorDomain(e), error: e.message || String(e) };
}

async function _runIncremental(source, ctx, scry, state) {
  let conversations;
  try {
    conversations = await source.enumerate(ctx);
  } catch (e) {
    return _classifyEnumerateError(source, e);
  }

  // Known-tombstoned conversations enumerate forever; drop them before planning.
  const eligible = filterSkippedConversations(conversations, state.skipUuids);

  const plan = planIncremental(eligible, state.watermark, Date.now());
  if (!plan.pending || plan.pending.length === 0) {
    // Nothing pending (or first run: plan.newWatermark is the init-to-newest).
    return { ok: true, pushed: 0, newWatermark: plan.newWatermark };
  }

  // See what's already there: ask Scry which pending items it actually needs.
  // Items it holds complete are passed by the watermark without ever being
  // fetched. Reconcile unreachable → null → everything pending is wanted (the
  // old push-everything behavior; never skip on a guess).
  let wantedIds = null;
  try {
    // Pass full objects (uuid + updated_at) so reconcile can detect staleness —
    // a pending item Scry holds "complete" but that grew at the source must
    // re-sync, or continued conversations never propagate their additions.
    const report = await source.reconcile(scry, plan.pending);
    if (report && Array.isArray(report.to_resync)) wantedIds = report.to_resync;
  } catch (_e) { /* fall back to syncing everything pending */ }

  const toSync = selectWantedToSync(plan.pending, wantedIds, INCREMENTAL_BATCH_CAP);

  if (toSync.length === 0) {
    // Scry already has everything pending — pass it all.
    const newWatermark = computeWatermarkAfter(plan.pending, wantedIds, [], state.watermark);
    return { ok: true, pushed: 0, newWatermark };
  }

  const { pushed, succeeded, firstFailure, tombstonedSkips } = await _syncBatch(source, ctx, scry, toSync);

  if (pushed === 0 && succeeded.length === 0) {
    // Total failure — nothing to safely advance the watermark past. (A wake of
    // pure skips is a success: succeeded carries them for the watermark.)
    const err = firstFailure ? firstFailure.error : new Error('all conversations in batch failed to sync');
    return { ok: false, domain: source.errorDomain(err), error: err.message || String(err), addSkipUuids: tombstonedSkips };
  }

  // Advance over unwanted + synced items; stop just before the earliest wanted
  // item that didn't sync (failed or beyond the cap).
  const newWatermark = computeWatermarkAfter(
    plan.pending, wantedIds, succeeded.map((s) => s.item.uuid), state.watermark);

  return { ok: true, pushed, newWatermark, addSkipUuids: tombstonedSkips };
}

// Uses the shared core's reconcileAndSync: enumerate (here) → reconcile → map
// to_resync onto the enumerated list → sync exactly that (all inside
// reconcileAndSync). A reconcile-phase throw is caught here and filed under
// 'scry' — reconcileAndSync deliberately rethrows rather than guessing which
// domain that is, since it doesn't know whether it's being called from the
// continuous engine (always 'scry' for a reconcile failure) or a manual UI.
async function _runDeepReconcile(source, ctx, scry) {
  let conversations;
  try {
    conversations = await source.enumerate(ctx);
  } catch (e) {
    return _classifyEnumerateError(source, e);
  }

  let outcome;
  try {
    outcome = await _syncCore().reconcileAndSync(source, ctx, scry, conversations);
  } catch (e) {
    return { ok: false, domain: 'scry', error: e.message || String(e) };
  }

  const { toSync, pushed, succeeded, firstFailure, tombstonedSkips } = outcome;
  if (toSync.length === 0) return { ok: true, pushed: 0 };

  if (pushed === 0 && succeeded.length === 0) {
    const err = firstFailure ? firstFailure.error : new Error('all conversations in to_resync failed to sync');
    return { ok: false, domain: source.errorDomain(err), error: err.message || String(err), addSkipUuids: tombstonedSkips };
  }
  // Deep reconcile doesn't move the incremental watermark — it's an
  // independent, exhaustive catch-up pass, not a walk from a cursor.
  return { ok: true, pushed, addSkipUuids: tombstonedSkips };
}

// Run one wake of continuous sync for one source. kind is 'incremental' or
// 'deep'; sourceName defaults to 'claude' so this keeps its original
// signature/behaviour for every existing caller (background.js's old alarm
// wiring, if anything still calls it directly). Safe to call from a
// chrome.alarms listener — reads/writes all its state from
// chrome.storage.local so it tolerates the service worker being recycled
// between wakes.
async function runContinuousSync(kind, sourceName = 'claude') {
  const source = _sources()[sourceName];
  if (!source) throw new Error(`Scry continuous sync: unknown source "${sourceName}"`);

  const nowMs = Date.now();
  const state = await _getState(source.stateKey);

  const scry = await loadScrySettings();
  const { configured, ctx } = await source.configure(scry);

  const gate = shouldRun(Object.assign({}, state, {
    configured,
    continuousSyncEnabled: source.isEnabled(scry),
  }), nowMs);
  if (!gate.run) return { ran: false, reason: gate.reason };

  await _setState(Object.assign({}, state, { running: nowMs }), source.stateKey);

  let result;
  try {
    result = kind === 'deep'
      ? await _runDeepReconcile(source, ctx, scry)
      : await _runIncremental(source, ctx, scry, state);
  } catch (e) {
    // Anything unexpected (a bug, not a modeled source/scry failure) — file it
    // under scry so it never throttles the source's own enumeration on a guess.
    result = { ok: false, domain: 'scry', error: e.message || String(e) };
  }

  if (result && result.signedOut) {
    // Signed-out is not a failure (point 3): leave consecutiveFailures/
    // backoff/badge bookkeeping untouched, just clear `running` and record
    // why, so the popup can say so without it reading as a failure streak.
    const revertedState = Object.assign({}, state, {
      running: null,
      lastError: result.error || 'not signed in',
    });
    await _setState(revertedState, source.stateKey);
    return { ran: false, reason: 'signed-out', state: revertedState };
  }

  const newState = applyResult(state, result, nowMs);
  await _setState(newState, source.stateKey);
  _applyBadge(newState);
  return { ran: true, result, state: newState };
}

// Run every source in SOURCES, in order, SEQUENTIALLY (never concurrently —
// two sources syncing at once have no reason to interleave their requests to
// two unrelated vendors, and sequential keeps each wake's console output
// readable). Returns { claude: <runContinuousSync result>, chatgpt: <...> }.
// After both have run, recomputes the badge across BOTH sources' persisted
// state (each individual runContinuousSync call above already applied its
// OWN single-source badge, which would otherwise leave the badge reflecting
// only whichever source happened to run last).
//
// `runOne`/`getState`/`applyBadge` are dependency-injected (default to the
// real impure implementations) so ordering + badge-aggregation can be unit
// tested without touching chrome.* or fetch at all.
async function runAllContinuousSyncs(kind, {
  runOne = runContinuousSync,
  getState = _getState,
  applyBadge = _renderBadge,
} = {}) {
  const sourceOrder = _sourceOrder();
  const sources = _sources();
  const results = {};
  for (const name of sourceOrder) {
    results[name] = await runOne(kind, name);
  }
  const states = await Promise.all(sourceOrder.map((name) => getState(sources[name].stateKey)));
  applyBadge(badgeStateAfterAll(states));
  return results;
}

// Browser: expose globally (loaded via importScripts in the service worker).
// Node (vitest): export the pure surface for testing. SOURCES/SOURCE_ORDER and
// the per-source helpers now live in sources.js (see _sourcesModule above);
// re-exported here too so tests/continuous_sync.test.js's existing
// `require('../chrome/continuous_sync.js')` imports keep working unchanged.
// syncBatch/reconcileAndSync (sync_core.js) are re-exported as well — the test
// suite uses them to assert this engine and the manual-sync UIs call the SAME
// function, not a duplicate.
if (typeof module !== 'undefined' && module.exports) {
  const { SOURCES, SOURCE_ORDER, normalizeChatGptListItem, isChatGptSignedOutError,
    chatgptErrorDomain, isStubFetchError, classifyStubAfterReconcile } = _sourcesModule();
  const { syncBatch, reconcileAndSync } = _syncCore();
  module.exports = {
    defaultContinuousSyncState,
    planIncremental,
    nextBackoff,
    shouldRun,
    badgeStateAfter,
    applyResult,
    planDeepReconcile,
    isStubFetchError,
    classifyStubAfterReconcile,
    filterSkippedConversations,
    selectWantedToSync,
    computeWatermarkAfter,
    runContinuousSync,
    runAllContinuousSyncs,
    badgeStateAfterAll,
    normalizeChatGptListItem,
    isChatGptSignedOutError,
    chatgptErrorDomain,
    SOURCES,
    SOURCE_ORDER,
    syncBatch,
    reconcileAndSync,
    CONTINUOUS_STORAGE_KEY,
    CONTINUOUS_STORAGE_KEY_CHATGPT,
    RUNNING_STALE_MS,
    INCREMENTAL_BATCH_CAP,
    _getState,
    _setState,
  };
}
