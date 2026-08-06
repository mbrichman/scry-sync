// Continuous background sync — chrome.alarms-driven incremental push (every 15
// minutes) + a daily deep reconcile, on top of the existing manual sync engine
// (scry_sync.js / scry_client.js). This file holds:
//   - the PURE planning/state-machine helpers (unit-tested, no chrome.* calls)
//   - the impure orchestrator runContinuousSync(kind) that wires them to
//     chrome.storage.local, claude.ai enumeration, and Scry's ingest/reconcile
//     endpoints.
//
// All persistent state lives under chrome.storage.local key "continuousSync" —
// the service worker is ephemeral (MV3), so nothing here relies on module-level
// mutable state surviving between wakes.

const CONTINUOUS_STORAGE_KEY = 'continuousSync';

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
// only a 'claude' domain failure touches backoffMs/nextAllowedAt — a Scry-side
// failure (mini unreachable) must not throttle claude.ai enumeration, since
// claude.ai itself is fine. `running` is always cleared: the wake is over.
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
  const domain = result && result.domain === 'scry' ? 'scry' : 'claude';
  s.errorDomain = domain;
  if (domain === 'claude') {
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

// The stub-guard throw from fetchConversationBody: claude.ai returned 200 with
// an empty body for a conversation that looks like it should have content.
function isStubFetchError(err) {
  const msg = (err && err.message) || '';
  return /empty body \(stub\) after retries$/.test(msg);
}

// After a stub failure, Scry's reconcile (called with just that id) is the
// authority on whether the conversation is still wanted:
//   'wanted'     — in to_resync: a real conversation stubbing transiently.
//                  The failure stands and keeps pinning the watermark.
//   'tombstoned' — deliberately deleted in Scry (reconcile counts it terminal,
//                  never to_resync). Permanent skip: cache the uuid so it is
//                  never fetched again.
//   'unwanted'   — not in to_resync, not tombstoned (e.g. already complete).
//                  Skip this wake only; no permanent cache (a later edit bumps
//                  updated_at and must sync normally).
// Fails safe: a malformed report reads as 'wanted' — the watermark never
// advances past a conversation on a guess.
function classifyStubAfterReconcile(report, uuid) {
  if (!report || !Array.isArray(report.to_resync)) return 'wanted';
  if (report.to_resync.includes(uuid)) return 'wanted';
  const tombstoned = report.summary && report.summary.tombstoned;
  return tombstoned >= 1 ? 'tombstoned' : 'unwanted';
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

// Read/write the single continuousSync state blob.
function _getState() {
  return new Promise((resolve) =>
    chrome.storage.local.get([CONTINUOUS_STORAGE_KEY], (r) =>
      resolve(Object.assign(defaultContinuousSyncState(), r[CONTINUOUS_STORAGE_KEY] || {}))));
}
function _setState(state) {
  return new Promise((resolve) => chrome.storage.local.set({ [CONTINUOUS_STORAGE_KEY]: state }, resolve));
}

function _applyBadge(state) {
  const b = badgeStateAfter(state);
  if (b.clear) {
    chrome.action.setBadgeText({ text: '' });
  } else {
    chrome.action.setBadgeBackgroundColor({ color: b.color });
    chrome.action.setBadgeText({ text: b.text });
  }
}

// A thrown Error's message tells us which side failed: fetchConversationBody /
// listClaudeConversations throw "fetch conversation…" / "fetch conversation
// list…"; everything else (ingest HTTP …, ingest rejected, reconcile HTTP …)
// originates on the Scry side. There's no typed error contract in the existing
// sync helpers to key off instead, so this pattern match is the practical
// signal — a reasonable target for a future slice if it proves too coarse.
function _domainForError(err) {
  const msg = (err && err.message) || String(err || '');
  return /^fetch conversation/.test(msg) ? 'claude' : 'scry';
}

// Sync a list of conversation objects one at a time (bounded pool, reusing the
// manual-sync concurrency setting), catching per-item failures rather than
// aborting the whole batch — mirrors browse.js's syncCandidateList.
//
// A stub failure (claude.ai 200 with an empty body) gets a second opinion from
// Scry's reconcile before it may pin the watermark: a conversation Scry has
// deliberately tombstoned (or already holds complete) counts as a deliberate
// SKIP — success for watermark purposes — not a failure. Only a
// server-authoritative "not wanted" can do this; a reconcile error keeps the
// failure (fail safe: never advance the watermark on a guess).
// Returns { pushed, succeeded, firstFailure, tombstonedSkips }.
async function _syncBatch(orgId, scry, items) {
  const concurrency = (scry.concurrency && scry.concurrency > 0) ? scry.concurrency : 4;
  let pushed = 0;
  const succeeded = [];
  const tombstonedSkips = [];
  let firstFailure = null;
  await runPool(items, concurrency, async (c) => {
    try {
      await syncOneConversation(orgId, c.uuid, scry);
      pushed++;
      succeeded.push(c);
      return;
    } catch (e) {
      if (isStubFetchError(e)) {
        try {
          const report = await reconcileWithScry(scry, [c.uuid]);
          const cls = classifyStubAfterReconcile(report, c.uuid);
          if (cls !== 'wanted') {
            console.warn('Scry continuous sync: skipping', c.uuid,
              cls === 'tombstoned' ? '(stub at claude, tombstoned in Scry — permanent skip)'
                                   : '(stub at claude, not wanted by Scry)');
            succeeded.push(c);
            if (cls === 'tombstoned') tombstonedSkips.push(c.uuid);
            return;
          }
        } catch (_re) { /* reconcile unreachable — keep the original failure */ }
      }
      console.error('Scry continuous sync: failed for', c.uuid, e);
      if (!firstFailure) firstFailure = { uuid: c.uuid, updatedAt: c.updated_at, err: e };
    }
  });
  return { pushed, succeeded, firstFailure, tombstonedSkips };
}

async function _runIncremental(orgId, scry, state) {
  let conversations;
  try {
    conversations = await listClaudeConversations(orgId);
  } catch (e) {
    return { ok: false, domain: 'claude', error: e.message || String(e) };
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
    const report = await reconcileWithScry(scry, plan.pending.map((c) => c.uuid));
    if (report && Array.isArray(report.to_resync)) wantedIds = report.to_resync;
  } catch (_e) { /* fall back to syncing everything pending */ }

  const toSync = selectWantedToSync(plan.pending, wantedIds, INCREMENTAL_BATCH_CAP);

  if (toSync.length === 0) {
    // Scry already has everything pending — pass it all.
    const newWatermark = computeWatermarkAfter(plan.pending, wantedIds, [], state.watermark);
    return { ok: true, pushed: 0, newWatermark };
  }

  const { pushed, succeeded, firstFailure, tombstonedSkips } = await _syncBatch(orgId, scry, toSync);

  if (pushed === 0 && succeeded.length === 0) {
    // Total failure — nothing to safely advance the watermark past. (A wake of
    // pure skips is a success: succeeded carries them for the watermark.)
    const err = firstFailure ? firstFailure.err : new Error('all conversations in batch failed to sync');
    return { ok: false, domain: _domainForError(err), error: err.message || String(err), addSkipUuids: tombstonedSkips };
  }

  // Advance over unwanted + synced items; stop just before the earliest wanted
  // item that didn't sync (failed or beyond the cap).
  const newWatermark = computeWatermarkAfter(
    plan.pending, wantedIds, succeeded.map((c) => c.uuid), state.watermark);

  return { ok: true, pushed, newWatermark, addSkipUuids: tombstonedSkips };
}

async function _runDeepReconcile(orgId, scry) {
  let conversations;
  try {
    conversations = await listClaudeConversations(orgId);
  } catch (e) {
    return { ok: false, domain: 'claude', error: e.message || String(e) };
  }

  let report;
  try {
    report = await reconcileWithScry(scry, conversations.map((c) => c.uuid));
  } catch (e) {
    return { ok: false, domain: 'scry', error: e.message || String(e) };
  }

  const toSync = planDeepReconcile(conversations, report.to_resync);
  if (toSync.length === 0) return { ok: true, pushed: 0 };

  const { pushed, succeeded, firstFailure, tombstonedSkips } = await _syncBatch(orgId, scry, toSync);
  if (pushed === 0 && succeeded.length === 0) {
    const err = firstFailure ? firstFailure.err : new Error('all conversations in to_resync failed to sync');
    return { ok: false, domain: _domainForError(err), error: err.message || String(err), addSkipUuids: tombstonedSkips };
  }
  // Deep reconcile doesn't move the incremental watermark — it's an
  // independent, exhaustive catch-up pass, not a walk from a cursor.
  return { ok: true, pushed, addSkipUuids: tombstonedSkips };
}

// Run one wake of continuous sync. kind is 'incremental' or 'deep'. Safe to
// call from a chrome.alarms listener — reads/writes all its state from
// chrome.storage.local so it tolerates the service worker being recycled
// between wakes.
async function runContinuousSync(kind) {
  const nowMs = Date.now();
  const state = await _getState();

  const scry = await loadScrySettings();
  const orgId = await readOrgIdFromStorage();
  const configured = Boolean(scry && scry.url && orgId);

  const gate = shouldRun(Object.assign({}, state, { configured }), nowMs);
  if (!gate.run) return { ran: false, reason: gate.reason };

  await _setState(Object.assign({}, state, { running: nowMs }));

  let result;
  try {
    result = kind === 'deep'
      ? await _runDeepReconcile(orgId, scry)
      : await _runIncremental(orgId, scry, state);
  } catch (e) {
    // Anything unexpected (a bug, not a modeled claude/scry failure) — file it
    // under scry so it never throttles claude.ai enumeration on a guess.
    result = { ok: false, domain: 'scry', error: e.message || String(e) };
  }

  const newState = applyResult(state, result, nowMs);
  await _setState(newState);
  _applyBadge(newState);
  return { ran: true, result, state: newState };
}

// Browser: expose globally (loaded via importScripts in the service worker).
// Node (vitest): export the pure surface for testing.
if (typeof module !== 'undefined' && module.exports) {
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
    CONTINUOUS_STORAGE_KEY,
    RUNNING_STALE_MS,
    INCREMENTAL_BATCH_CAP,
  };
}
