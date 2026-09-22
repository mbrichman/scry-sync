// Tests for the shared sync core (chrome/sync_core.js): syncBatch and
// reconcileAndSync, the ONE implementation of "sync a batch of items for a
// source" that used to be duplicated three ways — continuous_sync.js's
// _syncBatch/_runDeepReconcile, browse.js's syncCandidateList/reconcileAndSync,
// and chatgpt.js's own per-conversation fetch/post loop. Synthetic sources and
// fake reconcile/syncOne implementations only — no fetch, no chrome.*.

import { describe, it, expect } from 'vitest';

const { syncBatch, reconcileAndSync } = require('../chrome/sync_core.js');

function item(uuid, updated_at = '2026-07-01T00:00:00Z') {
  return { uuid, updated_at };
}

// A minimal SOURCES-shaped fake. `syncOneImpl` may throw to simulate a
// failure; `reconcileImpl` backs both the stub-reconcile path (called with a
// single-id array) and reconcileAndSync's up-front reconcile (called with the
// full list).
function fakeSource(overrides = {}) {
  return {
    name: 'fake',
    syncOne: async () => ({ status: 'ok' }),
    reconcile: async () => ({ to_resync: [], summary: {} }),
    isStubError: () => false,
    errorDomain: () => 'fake',
    ...overrides,
  };
}

describe('syncBatch', () => {
  it('syncs every item and reports pushed/succeeded with syncOne\'s return value carried through', async () => {
    const source = fakeSource({
      syncOne: async (ctx, it) => ({ status: 'ok', echo: it.uuid }),
    });
    const items = [item('a'), item('b'), item('c')];
    const result = await syncBatch(source, {}, {}, items);

    expect(result.pushed).toBe(3);
    expect(result.failed).toEqual([]);
    expect(result.firstFailure).toBeNull();
    expect(result.tombstonedSkips).toEqual([]);
    expect(result.succeeded).toHaveLength(3);
    expect(result.succeeded.map((s) => s.item.uuid).sort()).toEqual(['a', 'b', 'c']);
    // Each succeeded entry carries syncOne's own return value.
    const byUuid = Object.fromEntries(result.succeeded.map((s) => [s.item.uuid, s.result]));
    expect(byUuid.a).toEqual({ status: 'ok', echo: 'a' });
  });

  it('calls onProgress after each item with {done, total, item, ok}, and awaits a promise-returning callback', async () => {
    const source = fakeSource({
      syncOne: async (ctx, it) => { if (it.uuid === 'bad') throw new Error('boom'); return { status: 'ok' }; },
    });
    const items = [item('a'), item('bad'), item('c')];
    const calls = [];
    const order = [];
    await syncBatch(source, {}, {}, items, {
      concurrency: 1, // deterministic order for this assertion
      onProgress: async ({ done, total, item: it, ok }) => {
        await new Promise((r) => setTimeout(r, 1)); // proves awaiting works
        order.push(`progress:${it.uuid}`);
        calls.push({ done, total, uuid: it.uuid, ok });
      },
    });
    expect(calls).toEqual([
      { done: 1, total: 3, uuid: 'a', ok: true },
      { done: 2, total: 3, uuid: 'bad', ok: false },
      { done: 3, total: 3, uuid: 'c', ok: true },
    ]);
    expect(order).toEqual(['progress:a', 'progress:bad', 'progress:c']);
  });

  it('isolates a per-item failure: other items still sync, and the batch never rejects', async () => {
    const source = fakeSource({
      syncOne: async (ctx, it) => {
        if (it.uuid === 'b') throw new Error('b failed');
        return { status: 'ok' };
      },
    });
    const items = [item('a'), item('b'), item('c')];
    const result = await syncBatch(source, {}, {}, items);

    expect(result.pushed).toBe(2);
    expect(result.succeeded.map((s) => s.item.uuid).sort()).toEqual(['a', 'c']);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].item.uuid).toBe('b');
    expect(result.failed[0].error.message).toBe('b failed');
    expect(result.firstFailure).toBe(result.failed[0]);
  });

  it('abort mid-batch: items not yet started are neither synced nor counted as failed', async () => {
    const started = [];
    const source = fakeSource({
      syncOne: async (ctx, it) => { started.push(it.uuid); return { status: 'ok' }; },
    });
    const items = [item('a'), item('b'), item('c'), item('d')];
    const signal = { aborted: false };

    const result = await syncBatch(source, {}, {}, items, {
      concurrency: 1,
      signal,
      onProgress: async ({ item: it }) => {
        // Abort right after 'a' completes — 'b', 'c', 'd' must never start.
        if (it.uuid === 'a') signal.aborted = true;
      },
    });

    expect(started).toEqual(['a']);
    expect(result.pushed).toBe(1);
    expect(result.succeeded.map((s) => s.item.uuid)).toEqual(['a']);
    expect(result.failed).toEqual([]);
    // total is fixed up front — abort doesn't change the denominator callers saw.
  });

  it('per-item failures never abort the batch, even many at once', async () => {
    const source = fakeSource({
      syncOne: async (ctx, it) => { throw new Error(`${it.uuid} always fails`); },
    });
    const items = [item('a'), item('b'), item('c')];
    const result = await syncBatch(source, {}, {}, items);
    expect(result.pushed).toBe(0);
    expect(result.failed).toHaveLength(3);
  });

  describe('stub -> reconcile classification (moved intact from continuous_sync.js)', () => {
    function stubSource(reconcileReport) {
      return fakeSource({
        syncOne: async () => { throw new Error('fetch conversation x: empty body (stub) after retries'); },
        isStubError: (e) => /empty body \(stub\) after retries$/.test(e.message || ''),
        reconcile: async (_scry, ids) => reconcileReport(ids),
      });
    }

    it('still wanted after reconcile: the original failure stands', async () => {
      const source = stubSource(() => ({ to_resync: ['a'], summary: { tombstoned: 0 } }));
      const result = await syncBatch(source, {}, {}, [item('a')]);
      expect(result.pushed).toBe(0);
      expect(result.succeeded).toEqual([]);
      expect(result.failed).toHaveLength(1);
    });

    it('tombstoned after reconcile: counted as a success (skip) and reported in tombstonedSkips', async () => {
      const source = stubSource(() => ({ to_resync: [], summary: { tombstoned: 1 } }));
      const result = await syncBatch(source, {}, {}, [item('a')]);
      expect(result.pushed).toBe(0); // never actually synced — a skip, not a push
      expect(result.failed).toEqual([]);
      expect(result.succeeded).toHaveLength(1);
      expect(result.succeeded[0]).toEqual({ item: item('a'), result: null });
      expect(result.tombstonedSkips).toEqual(['a']);
    });

    it('unwanted (already complete) after reconcile: a skip, but NOT added to tombstonedSkips', async () => {
      const source = stubSource(() => ({ to_resync: [], summary: { tombstoned: 0 } }));
      const result = await syncBatch(source, {}, {}, [item('a')]);
      expect(result.succeeded).toHaveLength(1);
      expect(result.tombstonedSkips).toEqual([]);
    });

    it('reconcile unreachable during the stub check: keeps the original failure (fail safe)', async () => {
      const source = stubSource(() => { throw new Error('reconcile HTTP 500'); });
      const result = await syncBatch(source, {}, {}, [item('a')]);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].error.message).toMatch(/empty body \(stub\)/);
    });

    it('fires onStubReconcile with the classification', async () => {
      const source = stubSource(() => ({ to_resync: [], summary: { tombstoned: 1 } }));
      const seen = [];
      await syncBatch(source, {}, {}, [item('a')], {
        onStubReconcile: (info) => seen.push(info),
      });
      expect(seen).toHaveLength(1);
      expect(seen[0].item.uuid).toBe('a');
      expect(seen[0].classification).toBe('tombstoned');
    });
  });

  it('respects an explicit concurrency option', async () => {
    let inFlight = 0, peak = 0;
    const source = fakeSource({
      syncOne: async () => {
        inFlight++; peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return { status: 'ok' };
      },
    });
    const items = Array.from({ length: 10 }, (_, i) => item(`c${i}`));
    await syncBatch(source, {}, {}, items, { concurrency: 3 });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it('falls back to scry.concurrency when no explicit concurrency option is given (matches the pre-extraction default)', async () => {
    let inFlight = 0, peak = 0;
    const source = fakeSource({
      syncOne: async () => {
        inFlight++; peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return { status: 'ok' };
      },
    });
    const items = Array.from({ length: 10 }, (_, i) => item(`c${i}`));
    await syncBatch(source, {}, { concurrency: 2 }, items);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('defaults to concurrency 4 when neither the option nor scry.concurrency is set', async () => {
    let inFlight = 0, peak = 0;
    const source = fakeSource({
      syncOne: async () => {
        inFlight++; peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return { status: 'ok' };
      },
    });
    const items = Array.from({ length: 10 }, (_, i) => item(`c${i}`));
    await syncBatch(source, {}, {}, items);
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  it('an empty item list resolves cleanly with all-zero counts', async () => {
    const result = await syncBatch(fakeSource(), {}, {}, []);
    expect(result).toEqual({ pushed: 0, succeeded: [], failed: [], firstFailure: null, tombstonedSkips: [] });
  });

  describe('opts.onStatus pass-through', () => {
    it('attaches onStatus to ctx so a source\'s syncOne can call it', async () => {
      const seen = [];
      const source = fakeSource({
        syncOne: async (ctx, it) => {
          if (ctx.onStatus) ctx.onStatus(`working on ${it.uuid}`);
          return { status: 'ok' };
        },
      });
      const ctx = {};
      await syncBatch(source, ctx, {}, [item('a')], {
        onStatus: (text) => seen.push(text),
      });
      expect(seen).toEqual(['working on a']);
    });

    it('restores ctx.onStatus to its PRIOR value after the batch (ctx can outlive one call)', async () => {
      const priorOnStatus = () => {};
      const ctx = { onStatus: priorOnStatus };
      const source = fakeSource({ syncOne: async () => ({ status: 'ok' }) });
      await syncBatch(source, ctx, {}, [item('a')], { onStatus: () => {} });
      expect(ctx.onStatus).toBe(priorOnStatus);
    });

    it('deletes ctx.onStatus after the batch when ctx had none before', async () => {
      const ctx = {};
      const source = fakeSource({ syncOne: async () => ({ status: 'ok' }) });
      await syncBatch(source, ctx, {}, [item('a')], { onStatus: () => {} });
      expect(Object.prototype.hasOwnProperty.call(ctx, 'onStatus')).toBe(false);
    });

    it('no opts.onStatus given → ctx is left untouched (no onStatus key added)', async () => {
      const ctx = {};
      const source = fakeSource({ syncOne: async () => ({ status: 'ok' }) });
      await syncBatch(source, ctx, {}, [item('a')]);
      expect(Object.prototype.hasOwnProperty.call(ctx, 'onStatus')).toBe(false);
    });
  });
});

describe('reconcileAndSync', () => {
  const conversations = [item('a'), item('b'), item('c'), item('d')];

  it('maps to_resync ids onto the enumerated list and syncs exactly those', async () => {
    const syncedUuids = [];
    const source = fakeSource({
      reconcile: async () => ({ to_resync: ['b', 'd'], summary: { missing: 2 } }),
      syncOne: async (ctx, it) => { syncedUuids.push(it.uuid); return { status: 'ok' }; },
    });
    const result = await reconcileAndSync(source, {}, {}, conversations);

    expect(result.toSync.map((c) => c.uuid)).toEqual(['b', 'd']);
    expect(syncedUuids.sort()).toEqual(['b', 'd']);
    expect(result.pushed).toBe(2);
    expect(result.report.to_resync).toEqual(['b', 'd']);
  });

  it('ignores to_resync ids no longer present in the enumerated list', async () => {
    const source = fakeSource({
      reconcile: async () => ({ to_resync: ['a', 'ghost'], summary: {} }),
    });
    const result = await reconcileAndSync(source, {}, {}, conversations);
    expect(result.toSync.map((c) => c.uuid)).toEqual(['a']);
  });

  it('applies cap to the wanted (to_resync) list before syncing', async () => {
    const syncedUuids = [];
    const source = fakeSource({
      reconcile: async () => ({ to_resync: ['a', 'b', 'c', 'd'], summary: {} }),
      syncOne: async (ctx, it) => { syncedUuids.push(it.uuid); return { status: 'ok' }; },
    });
    const result = await reconcileAndSync(source, {}, {}, conversations, { cap: 2 });
    expect(result.toSync).toHaveLength(2);
    expect(syncedUuids).toHaveLength(2);
    expect(result.pushed).toBe(2);
  });

  it('an empty to_resync syncs nothing (pushed: 0) without erroring', async () => {
    const source = fakeSource({ reconcile: async () => ({ to_resync: [], summary: { complete: 4 } }) });
    const result = await reconcileAndSync(source, {}, {}, conversations);
    expect(result.toSync).toEqual([]);
    expect(result.pushed).toBe(0);
  });

  it('propagates a reconcile throw to the caller rather than swallowing it', async () => {
    const source = fakeSource({
      reconcile: async () => { throw new Error('reconcile HTTP 503'); },
    });
    await expect(reconcileAndSync(source, {}, {}, conversations)).rejects.toThrow('reconcile HTTP 503');
  });

  it('passes onProgress/signal through to the underlying syncBatch', async () => {
    const source = fakeSource({ reconcile: async () => ({ to_resync: ['a', 'b'], summary: {} }) });
    const progressed = [];
    await reconcileAndSync(source, {}, {}, conversations, {
      onProgress: ({ item: it }) => progressed.push(it.uuid),
    });
    expect(progressed.sort()).toEqual(['a', 'b']);
  });
});

// --- proves continuous_sync.js and the manual-sync UIs (browse.js,
// chatgpt.js) share ONE implementation, not a copy each. browse.js/chatgpt.js
// are page controllers (document/chrome.* dependent) with no vitest coverage
// of their own — same as before this extraction — so the identity check is on
// the module boundary they both load: chrome/sync_core.js. Node's require()
// cache guarantees every require('../chrome/sync_core.js') in this process,
// continuous_sync.js's internal resolver included, returns the SAME object.
describe('single shared implementation (no duplicate sync loop)', () => {
  it('continuous_sync.js resolves to the exact same syncBatch/reconcileAndSync as chrome/sync_core.js', () => {
    const syncCore = require('../chrome/sync_core.js');
    const continuousSync = require('../chrome/continuous_sync.js');
    expect(continuousSync.syncBatch).toBe(syncCore.syncBatch);
    expect(continuousSync.reconcileAndSync).toBe(syncCore.reconcileAndSync);
  });
});
