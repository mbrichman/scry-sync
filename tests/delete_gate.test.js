// Tests for the Phase-3 delete gate's pure client helper. The extension deletes
// from Claude ONLY the ids Scry cleared as `deletable` in the same verify pass;
// partitionDeletableReport splits Scry's report into exactly that cleared set
// plus the blocked verdicts (with reasons) to surface. Everything else in the
// flow is credentialed fetch/DELETE, exercised manually against the live site.
import { describe, test, expect } from 'vitest';
const { partitionDeletableReport } = require('../chrome/scry_client.js');

describe('partitionDeletableReport', () => {
  test('splits deletable from blocked, carrying reasons/titles', () => {
    const report = {
      summary: { total: 3, deletable: 1, blocked: 2 },
      results: [
        { source_id: 'a', title: 'ok one', deletable: true, reasons: [] },
        { source_id: 'b', title: 'stale', deletable: false,
          reasons: ['live has 3 message(s), archive has 2 — re-sync'] },
        { source_id: 'c', title: 'no bytes', deletable: false,
          reasons: ['1 file original(s) missing bytes'] },
      ],
    };
    const { cleared, blocked } = partitionDeletableReport(report);
    expect(cleared).toEqual(['a']);
    expect(blocked.map((b) => b.source_id)).toEqual(['b', 'c']);
    expect(blocked[0].reasons[0]).toMatch(/re-sync/);
    expect(blocked[1].title).toBe('no bytes');
  });

  test('nothing cleared when every verdict is blocked', () => {
    const report = { results: [
      { source_id: 'x', deletable: false, reasons: ['not captured in Scry'] },
    ] };
    const { cleared, blocked } = partitionDeletableReport(report);
    expect(cleared).toEqual([]);
    expect(blocked).toHaveLength(1);
  });

  test('empty / missing report yields empty partitions (never throws)', () => {
    expect(partitionDeletableReport({ results: [] })).toEqual({ cleared: [], blocked: [] });
    expect(partitionDeletableReport({})).toEqual({ cleared: [], blocked: [] });
    expect(partitionDeletableReport(null)).toEqual({ cleared: [], blocked: [] });
  });

  test('a blocked verdict with no reasons array still partitions cleanly', () => {
    const { blocked } = partitionDeletableReport({ results: [
      { source_id: 'y', deletable: false },
    ] });
    expect(blocked[0].reasons).toEqual([]);
  });
});
