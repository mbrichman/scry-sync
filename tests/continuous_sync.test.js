// Tests for the pure planning/state-machine helpers behind continuous background
// sync (chrome.alarms-driven incremental push + daily deep reconcile). The
// imperative orchestrator (runContinuousSync) wires these to chrome.storage +
// the existing claude.ai/Scry fetch helpers and is exercised manually — these
// tests cover every decision the engine makes: what to sync, when to back off,
// when to run at all, and what state a wake leaves behind. Synthetic data only.

import { describe, it, expect } from 'vitest';

const {
  planIncremental,
  nextBackoff,
  shouldRun,
  badgeStateAfter,
  applyResult,
  planDeepReconcile,
  defaultContinuousSyncState,
  RUNNING_STALE_MS,
  INCREMENTAL_BATCH_CAP,
} = require('../chrome/continuous_sync.js');

function conv(uuid, updatedAt) {
  return { uuid, name: `conv ${uuid}`, updated_at: updatedAt };
}

describe('planIncremental', () => {
  it('returns nothing to sync and keeps the watermark on an empty conversation list', () => {
    const r = planIncremental([], '2026-07-01T00:00:00Z', Date.parse('2026-07-01T00:00:00Z'));
    expect(r.toSync).toEqual([]);
    expect(r.newWatermark).toBe('2026-07-01T00:00:00Z');
    expect(r.overflow).toBe(false);
  });

  it('with no prior watermark (null), syncs NOTHING and initializes the watermark to the newest conversation', () => {
    // First-run semantics: history is already in Scry (bulk import + deep
    // reconcile cover completeness); treating null as "everything pending"
    // put a multi-day oldest-first backlog crawl AHEAD of new conversations
    // — the live bug this test pins down. Incremental means new-only.
    const convs = [conv('a', '2026-07-01T00:00:00Z'), conv('b', '2026-07-02T00:00:00Z')];
    const r = planIncremental(convs, null, Date.parse('2026-07-03T00:00:00Z'));
    expect(r.toSync).toEqual([]);
    expect(r.newWatermark).toBe('2026-07-02T00:00:00Z');
    expect(r.overflow).toBe(false);
  });

  it('with no prior watermark and no conversations, watermark stays null', () => {
    const r = planIncremental([], null, Date.parse('2026-07-03T00:00:00Z'));
    expect(r.toSync).toEqual([]);
    expect(r.newWatermark).toBe(null);
  });

  it('partial overlap: only includes conversations updated after the watermark', () => {
    const convs = [
      conv('old', '2026-07-01T00:00:00Z'),
      conv('boundary', '2026-07-05T00:00:00Z'),
      conv('new1', '2026-07-06T00:00:00Z'),
      conv('new2', '2026-07-07T00:00:00Z'),
    ];
    const wm = '2026-07-05T00:00:00Z';
    const r = planIncremental(convs, wm, Date.parse('2026-07-08T00:00:00Z'));
    expect(r.toSync.map((c) => c.uuid)).toEqual(['new1', 'new2']); // boundary itself excluded (not strictly newer)
    expect(r.newWatermark).toBe('2026-07-07T00:00:00Z');
    expect(r.overflow).toBe(false);
  });

  it('caps the batch at 50 and flags overflow, advancing the watermark only to the synced boundary', () => {
    // 60 conversations, all newer than the watermark, oldest-to-newest.
    const convs = Array.from({ length: 60 }, (_, i) =>
      conv(`c${i}`, `2026-07-01T00:${String(i).padStart(2, '0')}:00Z`));
    const r = planIncremental(convs, '2026-06-30T00:00:00Z', Date.parse('2026-07-02T00:00:00Z'));
    expect(r.toSync).toHaveLength(INCREMENTAL_BATCH_CAP);
    expect(r.overflow).toBe(true);
    // The oldest-pending 50 are chosen first (indices 0..49), so the watermark
    // advances only to c49's timestamp — never past the 10 still-unsynced items.
    expect(r.toSync.map((c) => c.uuid)).toEqual(convs.slice(0, 50).map((c) => c.uuid));
    expect(r.newWatermark).toBe('2026-07-01T00:49:00Z');
  });

  it('a follow-up call with the advanced watermark picks up exactly what overflowed, converging to no overflow', () => {
    const convs = Array.from({ length: 60 }, (_, i) =>
      conv(`c${i}`, `2026-07-01T00:${String(i).padStart(2, '0')}:00Z`));
    const first = planIncremental(convs, '2026-06-30T00:00:00Z', Date.parse('2026-07-02T00:00:00Z'));
    const second = planIncremental(convs, first.newWatermark, Date.parse('2026-07-02T00:05:00Z'));
    expect(second.toSync).toHaveLength(10);
    expect(second.overflow).toBe(false);
    expect(second.toSync.map((c) => c.uuid)).toEqual(convs.slice(50).map((c) => c.uuid));
    expect(second.newWatermark).toBe('2026-07-01T00:59:00Z');
  });

  it('ignores conversations with an unparseable updated_at rather than throwing', () => {
    const convs = [conv('a', 'not-a-date'), conv('b', '2026-07-02T00:00:00Z')];
    const r = planIncremental(convs, '2026-07-01T00:00:00Z', Date.parse('2026-07-03T00:00:00Z'));
    expect(r.toSync.map((c) => c.uuid)).toEqual(['b']);
  });
});

describe('nextBackoff', () => {
  it('starts at 15 minutes from no prior backoff', () => {
    expect(nextBackoff(null)).toBe(15 * 60 * 1000);
    expect(nextBackoff(0)).toBe(15 * 60 * 1000);
    expect(nextBackoff(undefined)).toBe(15 * 60 * 1000);
  });

  it('doubles 15 -> 30 -> 60', () => {
    expect(nextBackoff(15 * 60 * 1000)).toBe(30 * 60 * 1000);
    expect(nextBackoff(30 * 60 * 1000)).toBe(60 * 60 * 1000);
  });

  it('caps at 60 minutes and does not grow further', () => {
    expect(nextBackoff(60 * 60 * 1000)).toBe(60 * 60 * 1000);
    expect(nextBackoff(120 * 60 * 1000)).toBe(60 * 60 * 1000);
  });
});

describe('shouldRun', () => {
  const now = Date.parse('2026-07-01T12:00:00Z');

  it('runs by default with a fresh/empty state', () => {
    const r = shouldRun(defaultContinuousSyncState(), now);
    expect(r).toEqual({ run: true, reason: 'ok' });
  });

  it('no-ops silently when not configured (scry url / org id missing)', () => {
    const r = shouldRun({ ...defaultContinuousSyncState(), configured: false }, now);
    expect(r.run).toBe(false);
    expect(r.reason).toBe('unconfigured');
  });

  it('honors an unexpired backoff window (nextAllowedAt in the future)', () => {
    const r = shouldRun({ ...defaultContinuousSyncState(), nextAllowedAt: now + 60000 }, now);
    expect(r.run).toBe(false);
    expect(r.reason).toBe('backoff');
  });

  it('runs once nextAllowedAt has passed', () => {
    const r = shouldRun({ ...defaultContinuousSyncState(), nextAllowedAt: now - 1 }, now);
    expect(r.run).toBe(true);
  });

  it('blocks an overlapping run while the running flag is fresh', () => {
    const r = shouldRun({ ...defaultContinuousSyncState(), running: now - 60000 }, now);
    expect(r.run).toBe(false);
    expect(r.reason).toBe('already-running');
  });

  it('treats a running flag older than the staleness timeout as abandoned and proceeds', () => {
    const r = shouldRun({ ...defaultContinuousSyncState(), running: now - RUNNING_STALE_MS - 1 }, now);
    expect(r.run).toBe(true);
  });

  it('running flag exactly at the staleness boundary is still considered fresh (< not <=)', () => {
    const r = shouldRun({ ...defaultContinuousSyncState(), running: now - RUNNING_STALE_MS }, now);
    expect(r.run).toBe(false);
  });
});

describe('badgeStateAfter', () => {
  it('clears the badge under the failure threshold', () => {
    expect(badgeStateAfter({ consecutiveFailures: 0 })).toEqual({ clear: true });
    expect(badgeStateAfter({ consecutiveFailures: 1 })).toEqual({ clear: true });
    expect(badgeStateAfter({ consecutiveFailures: 2 })).toEqual({ clear: true });
  });

  it('shows the red badge at exactly 3 consecutive failures', () => {
    const b = badgeStateAfter({ consecutiveFailures: 3 });
    expect(b.clear).toBeUndefined();
    expect(b.text).toBe('!');
    expect(typeof b.color).toBe('string');
  });

  it('keeps showing the badge beyond 3 failures', () => {
    expect(badgeStateAfter({ consecutiveFailures: 10 }).text).toBe('!');
  });

  it('treats a missing/undefined counter as zero (clears)', () => {
    expect(badgeStateAfter({})).toEqual({ clear: true });
  });
});

describe('applyResult — generalized source domain (ChatGPT support)', () => {
  const now = Date.parse('2026-07-01T12:00:00Z');

  it('any non-scry domain (e.g. chatgpt) triggers backoff, same as claude', () => {
    const prior = defaultContinuousSyncState();
    const next = applyResult(prior, { ok: false, domain: 'chatgpt', error: 'rate limited' }, now);
    expect(next.consecutiveFailures).toBe(1);
    expect(next.errorDomain).toBe('chatgpt');
    expect(next.backoffMs).toBe(15 * 60 * 1000);
    expect(next.nextAllowedAt).toBe(now + 15 * 60 * 1000);
  });

  it('a scry-domain failure still never triggers backoff, regardless of which source reported it', () => {
    const prior = defaultContinuousSyncState();
    const next = applyResult(prior, { ok: false, domain: 'scry', error: 'mini unreachable' }, now);
    expect(next.errorDomain).toBe('scry');
    expect(next.backoffMs).toBeNull();
    expect(next.nextAllowedAt).toBeNull();
  });
});

describe('applyResult', () => {
  const now = Date.parse('2026-07-01T12:00:00Z');

  it('a success resets failures/backoff/error state and records the watermark + push count', () => {
    const prior = {
      ...defaultContinuousSyncState(),
      consecutiveFailures: 2,
      lastError: 'boom',
      errorDomain: 'claude',
      backoffMs: 30 * 60 * 1000,
      nextAllowedAt: now - 1,
      running: now - 1000,
    };
    const next = applyResult(prior, { ok: true, pushed: 5, newWatermark: '2026-07-01T11:00:00Z' }, now);
    expect(next.consecutiveFailures).toBe(0);
    expect(next.lastError).toBeNull();
    expect(next.errorDomain).toBeNull();
    expect(next.backoffMs).toBeNull();
    expect(next.nextAllowedAt).toBeNull();
    expect(next.running).toBeNull();
    expect(next.lastSyncAt).toBe(now);
    expect(next.lastPushed).toBe(5);
    expect(next.watermark).toBe('2026-07-01T11:00:00Z');
  });

  it('a success with no watermark change (e.g. deep reconcile) leaves the prior watermark alone', () => {
    const prior = { ...defaultContinuousSyncState(), watermark: '2026-07-01T00:00:00Z' };
    const next = applyResult(prior, { ok: true, pushed: 0 }, now);
    expect(next.watermark).toBe('2026-07-01T00:00:00Z');
  });

  it('a claude-domain failure increments failures, records the error, and sets an escalating backoff', () => {
    const prior = defaultContinuousSyncState();
    const next = applyResult(prior, { ok: false, domain: 'claude', error: 'claude 429' }, now);
    expect(next.consecutiveFailures).toBe(1);
    expect(next.lastError).toBe('claude 429');
    expect(next.errorDomain).toBe('claude');
    expect(next.backoffMs).toBe(15 * 60 * 1000);
    expect(next.nextAllowedAt).toBe(now + 15 * 60 * 1000);
  });

  it('a second consecutive claude-domain failure escalates the backoff (15 -> 30)', () => {
    const prior = applyResult(defaultContinuousSyncState(), { ok: false, domain: 'claude', error: 'e1' }, now);
    const later = now + 20 * 60 * 1000;
    const next = applyResult(prior, { ok: false, domain: 'claude', error: 'e2' }, later);
    expect(next.consecutiveFailures).toBe(2);
    expect(next.backoffMs).toBe(30 * 60 * 1000);
    expect(next.nextAllowedAt).toBe(later + 30 * 60 * 1000);
  });

  it('a scry-domain failure increments failures and records the error but does NOT touch claude backoff/nextAllowedAt', () => {
    const prior = defaultContinuousSyncState();
    const next = applyResult(prior, { ok: false, domain: 'scry', error: 'mini unreachable' }, now);
    expect(next.consecutiveFailures).toBe(1);
    expect(next.lastError).toBe('mini unreachable');
    expect(next.errorDomain).toBe('scry');
    expect(next.backoffMs).toBeNull();
    expect(next.nextAllowedAt).toBeNull();
  });

  it('a scry-domain failure does not clear a claude backoff already in effect', () => {
    const prior = {
      ...defaultContinuousSyncState(),
      backoffMs: 15 * 60 * 1000,
      nextAllowedAt: now + 15 * 60 * 1000,
      consecutiveFailures: 1,
    };
    const next = applyResult(prior, { ok: false, domain: 'scry', error: 'mini down' }, now);
    expect(next.backoffMs).toBe(15 * 60 * 1000);
    expect(next.nextAllowedAt).toBe(now + 15 * 60 * 1000);
    expect(next.consecutiveFailures).toBe(2);
  });

  it('always clears the running flag, win or lose', () => {
    const prior = { ...defaultContinuousSyncState(), running: now - 500 };
    expect(applyResult(prior, { ok: true, pushed: 0 }, now).running).toBeNull();
    expect(applyResult(prior, { ok: false, domain: 'scry', error: 'x' }, now).running).toBeNull();
  });
});

describe('planDeepReconcile', () => {
  const convs = [conv('a', '2026-07-01T00:00:00Z'), conv('b', '2026-07-02T00:00:00Z'), conv('c', '2026-07-03T00:00:00Z')];

  it('maps to_resync ids onto the matching enumerated conversation objects', () => {
    const r = planDeepReconcile(convs, ['b', 'c']);
    expect(r.map((c) => c.uuid)).toEqual(['b', 'c']);
  });

  it('ignores to_resync ids no longer present in the enumerated list', () => {
    const r = planDeepReconcile(convs, ['a', 'ghost-uuid']);
    expect(r.map((c) => c.uuid)).toEqual(['a']);
  });

  it('returns an empty list when to_resync is empty', () => {
    expect(planDeepReconcile(convs, [])).toEqual([]);
  });

  it('never throws on missing/undefined inputs', () => {
    expect(planDeepReconcile(null, null)).toEqual([]);
    expect(planDeepReconcile(convs, undefined)).toEqual([]);
  });
});

// --- stub-skip: conversations tombstoned in Scry must not pin the watermark ---
// Live bug: two chats tombstoned in Scry (deliberately deleted empty stubs)
// still enumerate at claude.ai; their body fetch correctly throws "empty body
// (stub) after retries", the failure pinned the incremental watermark, and the
// walk retried them every wake forever. The fix: on a stub failure, ask Scry's
// reconcile about that one id — only a server-authoritative "not wanted"
// (tombstoned/complete) lets the watermark advance past it.

const {
  isStubFetchError,
  classifyStubAfterReconcile,
  filterSkippedConversations,
} = require('../chrome/continuous_sync.js');

describe('isStubFetchError', () => {
  it('matches the stub-after-retries error thrown by fetchConversationBody', () => {
    const e = new Error('fetch conversation 11111111-2222-3333-4444-555555555555: empty body (stub) after retries');
    expect(isStubFetchError(e)).toBe(true);
  });

  it('does not match other claude-side fetch errors', () => {
    expect(isStubFetchError(new Error('fetch conversation 403'))).toBe(false);
    expect(isStubFetchError(new Error('fetch conversation list 500'))).toBe(false);
  });

  it('does not match scry-side errors, and never throws on junk', () => {
    expect(isStubFetchError(new Error('ingest HTTP 500'))).toBe(false);
    expect(isStubFetchError(null)).toBe(false);
    expect(isStubFetchError(undefined)).toBe(false);
    expect(isStubFetchError('string')).toBe(false);
  });
});

describe('classifyStubAfterReconcile', () => {
  const report = (toResync, tombstoned) => ({
    success: true,
    summary: { enumerated: 1, tombstoned },
    to_resync: toResync,
  });

  it('id still in to_resync → wanted (real conversation stubbing transiently; keep pinning)', () => {
    expect(classifyStubAfterReconcile(report(['u1'], 0), 'u1')).toBe('wanted');
  });

  it('id absent and tombstoned counted → tombstoned (permanent skip)', () => {
    expect(classifyStubAfterReconcile(report([], 1), 'u1')).toBe('tombstoned');
  });

  it('id absent, nothing tombstoned → unwanted (e.g. already complete; skip this wake, no permanent cache)', () => {
    expect(classifyStubAfterReconcile(report([], 0), 'u1')).toBe('unwanted');
  });

  it('fails safe: malformed/missing report → wanted (never advance the watermark on a guess)', () => {
    expect(classifyStubAfterReconcile(null, 'u1')).toBe('wanted');
    expect(classifyStubAfterReconcile({}, 'u1')).toBe('wanted');
    expect(classifyStubAfterReconcile({ to_resync: null }, 'u1')).toBe('wanted');
  });
});

describe('filterSkippedConversations', () => {
  const convs = [conv('a', '2026-07-01T00:00:00Z'), conv('b', '2026-07-02T00:00:00Z')];

  it('drops permanently-skipped uuids from the enumerated list', () => {
    expect(filterSkippedConversations(convs, ['a']).map((c) => c.uuid)).toEqual(['b']);
  });

  it('is a no-op with an empty or missing skip list', () => {
    expect(filterSkippedConversations(convs, []).map((c) => c.uuid)).toEqual(['a', 'b']);
    expect(filterSkippedConversations(convs, undefined).map((c) => c.uuid)).toEqual(['a', 'b']);
    expect(filterSkippedConversations(null, ['a'])).toEqual([]);
  });
});

describe('skipUuids state', () => {
  it('default state starts with an empty skip list', () => {
    expect(defaultContinuousSyncState().skipUuids).toEqual([]);
  });

  it('a successful wake merges newly-learned tombstoned uuids, deduplicated', () => {
    const state = Object.assign(defaultContinuousSyncState(), { skipUuids: ['old'] });
    const s = applyResult(state, { ok: true, pushed: 1, newWatermark: '2026-07-02T00:00:00Z', addSkipUuids: ['old', 'new'] }, 1000);
    expect(s.skipUuids.sort()).toEqual(['new', 'old']);
  });

  it('a failed wake still keeps tombstones learned before the failure', () => {
    const state = defaultContinuousSyncState();
    const s = applyResult(state, { ok: false, domain: 'claude', error: 'x', addSkipUuids: ['t1'] }, 1000);
    expect(s.skipUuids).toEqual(['t1']);
    expect(s.consecutiveFailures).toBe(1);
  });

  it('old persisted state without skipUuids is upgraded to an empty list', () => {
    const s = applyResult({ watermark: '2026-07-01T00:00:00Z' }, { ok: true, pushed: 0 }, 1000);
    expect(s.skipUuids).toEqual([]);
  });
});

// --- reconcile-first incremental: see what's already there before pushing ---
// The incremental walk used to push everything newer than the watermark and
// let idempotent ingest discard re-pushes — fine in steady state, wasteful in
// catch-up (re-fetching weeks of already-captured conversations 50 per wake).
// Now the wake reconciles its pending set first: items Scry already holds
// complete are PASSED by the watermark without fetching; the batch cap applies
// only to genuinely wanted syncs. Reconcile unreachable → sync everything
// pending (the old behavior): never skip on a guess.

const {
  selectWantedToSync,
  computeWatermarkAfter,
} = require('../chrome/continuous_sync.js');

describe('selectWantedToSync', () => {
  const pending = [
    conv('a', '2026-07-01T00:00:00Z'),
    conv('b', '2026-07-02T00:00:00Z'),
    conv('c', '2026-07-03T00:00:00Z'),
  ];

  it('keeps only conversations the server wants, oldest-first, capped', () => {
    expect(selectWantedToSync(pending, ['c', 'a'], 10).map((c) => c.uuid)).toEqual(['a', 'c']);
    expect(selectWantedToSync(pending, ['c', 'a'], 1).map((c) => c.uuid)).toEqual(['a']);
  });

  it('null to_resync (reconcile unavailable) → everything pending is wanted (old behavior), still capped', () => {
    expect(selectWantedToSync(pending, null, 10).map((c) => c.uuid)).toEqual(['a', 'b', 'c']);
    expect(selectWantedToSync(pending, null, 2).map((c) => c.uuid)).toEqual(['a', 'b']);
  });

  it('empty want-list with a real report → nothing to sync', () => {
    expect(selectWantedToSync(pending, [], 10)).toEqual([]);
  });
});

describe('computeWatermarkAfter', () => {
  const pending = [
    conv('a', '2026-07-01T00:00:00Z'),
    conv('b', '2026-07-02T00:00:00Z'),
    conv('c', '2026-07-03T00:00:00Z'),
    conv('d', '2026-07-04T00:00:00Z'),
  ];
  const prior = '2026-06-30T00:00:00Z';

  it('advances over unwanted (already-in-Scry) items without them being synced', () => {
    // Only 'c' wanted and synced: a, b are passable because Scry has them.
    expect(computeWatermarkAfter(pending, ['c'], ['c'], prior)).toBe('2026-07-04T00:00:00Z');
  });

  it('stops just before the earliest wanted item that did not sync', () => {
    // b and d wanted, only d synced → cannot pass b; watermark lands on a.
    expect(computeWatermarkAfter(pending, ['b', 'd'], ['d'], prior)).toBe('2026-07-01T00:00:00Z');
  });

  it('keeps the prior watermark when the very first pending item is wanted and unsynced', () => {
    expect(computeWatermarkAfter(pending, ['a'], [], prior)).toBe(prior);
  });

  it('advances to the end when everything wanted synced', () => {
    expect(computeWatermarkAfter(pending, ['a', 'd'], ['a', 'd'], prior)).toBe('2026-07-04T00:00:00Z');
  });

  it('null wanted (reconcile unavailable) → every pending item is wanted (old truncation behavior)', () => {
    expect(computeWatermarkAfter(pending, null, ['a', 'b'], prior)).toBe('2026-07-02T00:00:00Z');
    expect(computeWatermarkAfter(pending, null, [], prior)).toBe(prior);
  });

  it('empty pending → prior watermark unchanged', () => {
    expect(computeWatermarkAfter([], ['x'], [], prior)).toBe(prior);
  });
});

// --- user-facing enable/disable toggle (options page → scry.continuousSync) ---
describe('continuous sync enable toggle', () => {
  it('an explicit disabled setting stops wakes with reason "disabled"', () => {
    expect(shouldRun({ continuousSyncEnabled: false }, 1000)).toEqual({ run: false, reason: 'disabled' });
  });

  it('absent or true flag means enabled — default-on so existing installs keep syncing', () => {
    expect(shouldRun({}, 1000).run).toBe(true);
    expect(shouldRun({ continuousSyncEnabled: true }, 1000).run).toBe(true);
    expect(shouldRun({ continuousSyncEnabled: undefined }, 1000).run).toBe(true);
  });

  it('disabled wins over backoff/running/unconfigured — the user turned it off, say so', () => {
    const s = { continuousSyncEnabled: false, configured: false, nextAllowedAt: 999999, running: 900 };
    expect(shouldRun(s, 1000).reason).toBe('disabled');
  });
});

// --- ChatGPT continuous sync: source registry + multi-source orchestration ---
// SOURCES.chatgpt plugs ChatGPT's list/fetch/ingest into the SAME pure
// planning helpers tested above (they only ever look at {uuid, updated_at}).
// These tests cover the source-specific pieces: normalizing the ChatGPT list
// endpoint's shape, classifying its errors (including "signed out ≠
// failure"), the two-gate enable toggle, per-source state-key isolation, and
// runAllContinuousSyncs's sequential ordering + cross-source badge.

const {
  SOURCES,
  SOURCE_ORDER,
  normalizeChatGptListItem,
  isChatGptSignedOutError,
  badgeStateAfterAll,
  runAllContinuousSyncs,
  CONTINUOUS_STORAGE_KEY,
  CONTINUOUS_STORAGE_KEY_CHATGPT,
  _getState,
  _setState,
} = require('../chrome/continuous_sync.js');
const { ChatGptRateLimitError } = require('../chrome/chatgpt_adapter.js');

describe('normalizeChatGptListItem', () => {
  it('normalizes an ISO update_time', () => {
    const r = normalizeChatGptListItem({ id: 'c1', update_time: '2026-07-01T00:00:00.000Z', title: 'Hi there' });
    expect(r).toEqual({ uuid: 'c1', updated_at: '2026-07-01T00:00:00.000Z', title: 'Hi there' });
  });

  it('normalizes an epoch-seconds update_time', () => {
    const r = normalizeChatGptListItem({ id: 'c2', update_time: 1700000000 });
    expect(r.uuid).toBe('c2');
    expect(r.updated_at).toBe(new Date(1700000000 * 1000).toISOString());
    expect(r.title).toBeNull();
  });

  it('normalizes a numeric-string epoch seconds value too (list endpoint inconsistency)', () => {
    const r = normalizeChatGptListItem({ id: 'c3', update_time: '1700000000' });
    expect(r.updated_at).toBe(new Date(1700000000 * 1000).toISOString());
  });

  it('is tolerant of a missing/unparseable update_time rather than throwing', () => {
    expect(normalizeChatGptListItem({ id: 'c4', update_time: null }).updated_at).toBeNull();
    expect(normalizeChatGptListItem({ id: 'c5' }).updated_at).toBeNull();
    expect(() => normalizeChatGptListItem(null)).not.toThrow();
  });
});

describe('SOURCES.chatgpt.errorDomain', () => {
  it('classifies a rate-limit error as chatgpt-domain', () => {
    expect(SOURCES.chatgpt.errorDomain(new ChatGptRateLimitError('30'))).toBe('chatgpt');
  });

  it('classifies a chatgpt.com backend-api URL error as chatgpt-domain', () => {
    expect(SOURCES.chatgpt.errorDomain(new Error('https://chatgpt.com/backend-api/conversation/x: 500'))).toBe('chatgpt');
  });

  it('classifies an auth/session error as chatgpt-domain', () => {
    expect(SOURCES.chatgpt.errorDomain(new Error('auth/session 401 — are you signed in to chatgpt.com?'))).toBe('chatgpt');
  });

  it('classifies a "fetch conversation" prefixed error as chatgpt-domain', () => {
    expect(SOURCES.chatgpt.errorDomain(new Error('fetch conversation abc: boom'))).toBe('chatgpt');
  });

  it('classifies an ingest-side failure as scry-domain (the default)', () => {
    expect(SOURCES.chatgpt.errorDomain(new Error('ingest HTTP 500'))).toBe('scry');
    expect(SOURCES.chatgpt.errorDomain(new Error('ingest rejected'))).toBe('scry');
    expect(SOURCES.chatgpt.errorDomain(new Error('reconcile HTTP 503'))).toBe('scry');
  });
});

describe('isChatGptSignedOutError', () => {
  it('matches the auth/session non-OK message (any status, incl. 401/403)', () => {
    expect(isChatGptSignedOutError(new Error('auth/session 401 — are you signed in to chatgpt.com?'))).toBe(true);
    expect(isChatGptSignedOutError(new Error('auth/session 403 — are you signed in to chatgpt.com?'))).toBe(true);
    expect(isChatGptSignedOutError(new Error('auth/session 500 — are you signed in to chatgpt.com?'))).toBe(true);
  });

  it('matches the missing-accessToken message', () => {
    expect(isChatGptSignedOutError(new Error('No access token in session — sign in to chatgpt.com first.'))).toBe(true);
  });

  it('does not match an unrelated chatgpt-domain error (a real sync failure)', () => {
    expect(isChatGptSignedOutError(new Error('https://chatgpt.com/backend-api/conversations?offset=0&limit=100: 500'))).toBe(false);
    expect(isChatGptSignedOutError(new ChatGptRateLimitError('30'))).toBe(false);
  });

  it('never throws on junk', () => {
    expect(isChatGptSignedOutError(null)).toBe(false);
    expect(isChatGptSignedOutError(undefined)).toBe(false);
    expect(isChatGptSignedOutError('string')).toBe(false);
  });
});

// Owner ruling (2026-09-21): ChatGPT needs its OWN default-off enable gate —
// existing installs must not start hitting chatgpt.com just because this
// shipped — layered under the existing continuous-sync sub-toggle.
describe('SOURCES.chatgpt.isEnabled', () => {
  it('absent chatgptEnabled → false (default OFF, unlike claude)', () => {
    expect(SOURCES.chatgpt.isEnabled({})).toBe(false);
  });

  it('chatgptEnabled true, continuous sub-toggle absent → true (default-on once the source itself is on)', () => {
    expect(SOURCES.chatgpt.isEnabled({ chatgptEnabled: true })).toBe(true);
  });

  it('chatgptEnabled true, continuous sub-toggle explicitly false → false', () => {
    expect(SOURCES.chatgpt.isEnabled({ chatgptEnabled: true, chatgptContinuousSync: false })).toBe(false);
  });

  it('chatgptEnabled false wins even if the sub-toggle is true — the source gate is the outer one', () => {
    expect(SOURCES.chatgpt.isEnabled({ chatgptEnabled: false, chatgptContinuousSync: true })).toBe(false);
  });
});

describe('SOURCES.claude.isEnabled (unchanged: default-on)', () => {
  it('absent/undefined continuousSync → true', () => {
    expect(SOURCES.claude.isEnabled({})).toBe(true);
  });
  it('explicit false → false', () => {
    expect(SOURCES.claude.isEnabled({ continuousSync: false })).toBe(false);
  });
});

describe('badgeStateAfterAll', () => {
  it('clears when every source is under the failure threshold', () => {
    expect(badgeStateAfterAll([{ consecutiveFailures: 0 }, { consecutiveFailures: 2 }])).toEqual({ clear: true });
  });

  it('shows the badge when ANY source is at/over the threshold, even if others are healthy', () => {
    const b = badgeStateAfterAll([{ consecutiveFailures: 0 }, { consecutiveFailures: 3 }]);
    expect(b.clear).toBeUndefined();
    expect(b.text).toBe('!');
  });

  it('treats missing/null per-source state as zero failures rather than throwing', () => {
    expect(badgeStateAfterAll([null, undefined, {}])).toEqual({ clear: true });
    expect(badgeStateAfterAll([])).toEqual({ clear: true });
    expect(badgeStateAfterAll(undefined)).toEqual({ clear: true });
  });
});

// --- state-key isolation: a chatgpt write must never touch the claude blob ---
// _getState/_setState are factored to take (key, storage) so this is
// testable with an in-memory storage stub — no chrome.storage.local, no
// global chrome.* at all.
function makeStorageStub(initial = {}) {
  const store = { ...initial };
  return {
    get: (keys, cb) => {
      const r = {};
      (keys || []).forEach((k) => {
        if (Object.prototype.hasOwnProperty.call(store, k)) r[k] = store[k];
      });
      cb(r);
    },
    set: (obj, cb) => { Object.assign(store, obj); if (cb) cb(); },
    _store: store,
  };
}

describe('state-key isolation (_getState / _setState)', () => {
  it('reads each source from its own independent key', async () => {
    const storage = makeStorageStub({
      continuousSync: { watermark: 'claude-wm' },
      'continuousSync:chatgpt': { watermark: 'chatgpt-wm' },
    });
    const claudeState = await _getState(CONTINUOUS_STORAGE_KEY, storage);
    const chatgptState = await _getState(CONTINUOUS_STORAGE_KEY_CHATGPT, storage);
    expect(claudeState.watermark).toBe('claude-wm');
    expect(chatgptState.watermark).toBe('chatgpt-wm');
  });

  it('writing the chatgpt state never touches the claude blob', async () => {
    const storage = makeStorageStub({
      continuousSync: { watermark: 'claude-wm', consecutiveFailures: 0 },
    });
    const newChatGptState = applyResult(
      defaultContinuousSyncState(), { ok: false, domain: 'chatgpt', error: 'boom' }, 1000);
    await _setState(newChatGptState, CONTINUOUS_STORAGE_KEY_CHATGPT, storage);

    expect(storage._store[CONTINUOUS_STORAGE_KEY].watermark).toBe('claude-wm');
    expect(storage._store[CONTINUOUS_STORAGE_KEY].consecutiveFailures).toBe(0);
    expect(storage._store[CONTINUOUS_STORAGE_KEY_CHATGPT].errorDomain).toBe('chatgpt');
    expect(storage._store[CONTINUOUS_STORAGE_KEY_CHATGPT].consecutiveFailures).toBe(1);
  });

  it('an unset key reads back the default state, not the other source\'s', async () => {
    const storage = makeStorageStub({ continuousSync: { watermark: 'claude-wm' } });
    const chatgptState = await _getState(CONTINUOUS_STORAGE_KEY_CHATGPT, storage);
    expect(chatgptState).toEqual(defaultContinuousSyncState());
  });
});

describe('runAllContinuousSyncs', () => {
  it('runs every SOURCES entry sequentially in SOURCE_ORDER (claude, then chatgpt)', async () => {
    expect(SOURCE_ORDER).toEqual(['claude', 'chatgpt']);
    const calls = [];
    const runOne = async (kind, name) => {
      calls.push(name);
      return { ran: true, result: { ok: true, pushed: 0 } };
    };
    const getState = async () => defaultContinuousSyncState();
    const applyBadge = () => {};
    const results = await runAllContinuousSyncs('incremental', { runOne, getState, applyBadge });
    expect(calls).toEqual(['claude', 'chatgpt']);
    expect(Object.keys(results)).toEqual(['claude', 'chatgpt']);
  });

  it('never runs the two sources concurrently — chatgpt only starts after claude resolves', async () => {
    const events = [];
    const runOne = async (kind, name) => {
      events.push(`${name}:start`);
      await new Promise((r) => setTimeout(r, 5));
      events.push(`${name}:end`);
      return { ran: true };
    };
    const getState = async () => defaultContinuousSyncState();
    await runAllContinuousSyncs('incremental', { runOne, getState, applyBadge: () => {} });
    expect(events).toEqual(['claude:start', 'claude:end', 'chatgpt:start', 'chatgpt:end']);
  });

  it('applies the badge computed across BOTH sources\' persisted state, not just the one that ran last', async () => {
    const runOne = async () => ({ ran: true });
    const getState = async (key) => (key === CONTINUOUS_STORAGE_KEY_CHATGPT
      ? { ...defaultContinuousSyncState(), consecutiveFailures: 5 }
      : { ...defaultContinuousSyncState(), consecutiveFailures: 0 });
    let appliedBadge = null;
    await runAllContinuousSyncs('incremental', { runOne, getState, applyBadge: (b) => { appliedBadge = b; } });
    expect(appliedBadge.text).toBe('!');
  });

  it('clears the badge when neither source is failing', async () => {
    const runOne = async () => ({ ran: true });
    const getState = async () => defaultContinuousSyncState();
    let appliedBadge = null;
    await runAllContinuousSyncs('deep', { runOne, getState, applyBadge: (b) => { appliedBadge = b; } });
    expect(appliedBadge).toEqual({ clear: true });
  });
});
