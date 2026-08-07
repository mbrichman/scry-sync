// reconcileWithScry payload construction — the staleness fix. When callers pass
// conversation objects {uuid, updated_at}, the request must carry
// source_updated_ats so Scry can detect a grown ("stale") conversation. Bare id
// strings stay backward-compatible (no source_updated_ats). Synthetic only.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const { reconcileWithScry } = require('../chrome/scry_client.js');

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
