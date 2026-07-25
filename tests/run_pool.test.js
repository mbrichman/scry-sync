// Tests for runPool — the bounded-concurrency worker pool that lets the bulk
// sync process several conversations at once instead of strictly one at a time.

import { describe, it, expect } from 'vitest';

const { runPool } = require('../chrome/scry_sync.js');

describe('runPool', () => {
  it('runs the worker over every item exactly once', async () => {
    const items = [1, 2, 3, 4, 5, 6, 7];
    const seen = [];
    await runPool(items, 3, async (x) => { seen.push(x); });
    expect(seen.sort((a, b) => a - b)).toEqual(items);
  });

  it('passes the index as the second arg', async () => {
    const idx = [];
    await runPool(['a', 'b', 'c'], 2, async (_x, i) => { idx.push(i); });
    expect(idx.sort()).toEqual([0, 1, 2]);
  });

  it('never exceeds the concurrency limit in flight', async () => {
    let inFlight = 0, peak = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    await runPool(items, 4, async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    });
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1); // actually parallelized
  });

  it('caps concurrency at the item count', async () => {
    let inFlight = 0, peak = 0;
    await runPool([1, 2], 8, async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    });
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('handles an empty list without running the worker', async () => {
    let ran = false;
    await runPool([], 4, async () => { ran = true; });
    expect(ran).toBe(false);
  });

  it('completes all items even when concurrency is 1 (sequential)', async () => {
    const order = [];
    await runPool([1, 2, 3], 1, async (x) => {
      order.push(x);
      await new Promise((r) => setTimeout(r, 1));
    });
    expect(order).toEqual([1, 2, 3]); // strict order when serial
  });
});
