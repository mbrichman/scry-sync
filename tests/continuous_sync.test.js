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
