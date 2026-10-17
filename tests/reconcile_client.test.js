// reconcileWithScry payload construction — the staleness fix. When callers pass
// conversation objects {uuid, updated_at}, the request must carry
// source_updated_ats so Scry can detect a grown ("stale") conversation. Bare id
// strings stay backward-compatible (no source_updated_ats). Synthetic only.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const { reconcileWithScry, chunkIds, mergeReconcileReports } = require('../chrome/scry_client.js');

let lastRequest;

beforeEach(() => {
  lastRequest = null;
  global.fetch = async (url, opts) => {
    lastRequest = { url, opts, body: JSON.parse(opts.body) };
    return { ok: true, json: async () => ({ to_resync: [], summary: {} }) };
  };
});

afterEach(() => { delete global.fetch; });

const scry = { url: 'http://host:5001', token: 'tok' };

describe('reconcileWithScry payload', () => {
  it('objects with updated_at → source_ids + source_updated_ats', async () => {
    await reconcileWithScry(scry, [
      { uuid: 'a', updated_at: '2026-08-01T00:00:00Z' },
      { uuid: 'b', updated_at: '2026-08-02T00:00:00Z' },
    ]);
    expect(lastRequest.body.source_ids).toEqual(['a', 'b']);
    expect(lastRequest.body.source_updated_ats).toEqual({
      a: '2026-08-01T00:00:00Z',
      b: '2026-08-02T00:00:00Z',
    });
  });

  it('bare id strings → source_ids only, no source_updated_ats (backward compatible)', async () => {
    await reconcileWithScry(scry, ['a', 'b']);
    expect(lastRequest.body.source_ids).toEqual(['a', 'b']);
    expect(lastRequest.body.source_updated_ats).toBeUndefined();
  });

  it('objects missing updated_at → id included, no timestamp for it', async () => {
    await reconcileWithScry(scry, [
      { uuid: 'a', updated_at: '2026-08-01T00:00:00Z' },
      { uuid: 'b' },
    ]);
    expect(lastRequest.body.source_ids).toEqual(['a', 'b']);
    expect(lastRequest.body.source_updated_ats).toEqual({ a: '2026-08-01T00:00:00Z' });
  });

  it('objects without uuid are skipped', async () => {
    await reconcileWithScry(scry, [{ updated_at: 'x' }, { uuid: 'a' }]);
    expect(lastRequest.body.source_ids).toEqual(['a']);
  });

  it('empty / missing input sends an empty id set', async () => {
    await reconcileWithScry(scry, []);
    expect(lastRequest.body.source_ids).toEqual([]);
    await reconcileWithScry(scry, undefined);
    expect(lastRequest.body.source_ids).toEqual([]);
  });

  it('sends auth header and correct endpoint', async () => {
    await reconcileWithScry(scry, ['a']);
    expect(lastRequest.url).toBe('http://host:5001/api/conversations/reconcile');
    expect(lastRequest.opts.headers.Authorization).toBe('Bearer tok');
  });
});

// source_type: the ChatGPT continuous-sync engine reuses this exact function
// (SOURCES.chatgpt.reconcile in continuous_sync.js) with a third argument;
// every pre-existing caller omits it and must keep getting 'claude'.
describe('reconcileWithScry source_type', () => {
  it('defaults to "claude" when the third argument is omitted (every existing caller)', async () => {
    await reconcileWithScry(scry, ['a']);
    expect(lastRequest.body.source_type).toBe('claude');
  });

  it('sends "chatgpt" when asked', async () => {
    await reconcileWithScry(scry, ['a'], 'chatgpt');
    expect(lastRequest.body.source_type).toBe('chatgpt');
  });

  it('still carries source_ids/source_updated_ats correctly alongside a non-default source_type', async () => {
    await reconcileWithScry(scry, [{ uuid: 'a', updated_at: '2026-08-01T00:00:00Z' }], 'chatgpt');
    expect(lastRequest.body.source_type).toBe('chatgpt');
    expect(lastRequest.body.source_ids).toEqual(['a']);
    expect(lastRequest.body.source_updated_ats).toEqual({ a: '2026-08-01T00:00:00Z' });
  });
});

describe('chunkIds', () => {
  it('splits into chunks of at most size, preserving order', () => {
    expect(chunkIds([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunkIds([1, 2], 2)).toEqual([[1, 2]]);
  });
  it('empty/invalid input -> no chunks; bad size -> one chunk', () => {
    expect(chunkIds([], 2)).toEqual([]);
    expect(chunkIds(undefined, 2)).toEqual([]);
    expect(chunkIds([1, 2, 3], 0)).toEqual([[1, 2, 3]]);
  });
});

describe('mergeReconcileReports', () => {
  it('concatenates lists, sums summary, merges buckets', () => {
    const m = mergeReconcileReports([
      { to_resync: ['a'], extra: ['x'], summary: { missing: 1, complete: 2 }, buckets: { missing: ['a'], incomplete: [], stale: [] } },
      { to_resync: ['b'], extra: [], summary: { stale: 1, complete: 3 }, buckets: { missing: [], incomplete: [], stale: ['b'] } },
    ]);
    expect(m.to_resync).toEqual(['a', 'b']);
    expect(m.extra).toEqual(['x']);
    expect(m.summary).toEqual({ missing: 1, complete: 5, stale: 1 });
    expect(m.buckets).toEqual({ missing: ['a'], incomplete: [], stale: ['b'] });
  });
  it('drops buckets entirely if any chunk lacks them (no half-truth)', () => {
    const m = mergeReconcileReports([
      { to_resync: ['a'], buckets: { missing: ['a'], incomplete: [], stale: [] } },
      { to_resync: ['b'] },
    ]);
    expect(m.buckets).toBeUndefined();
    expect(m.to_resync).toEqual(['a', 'b']);
  });
});
