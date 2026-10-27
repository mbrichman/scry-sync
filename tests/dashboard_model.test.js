// Tests for the pure dashboard model (chrome/dashboard_model.js) behind the
// unified dashboard (phase 3): which source tabs show, their labels, the
// row mapping shared by both sources, the synced-status badge, and the
// popup's site-detection helper. Synthetic data only — no fetch, no chrome.*.

import { describe, it, expect } from 'vitest';

const {
  visibleSourceTabs,
  tabLabel,
  toRow,
  badgeFromReconcile,
  badgeNeedsSync,
  detectSyncTarget,
  pickActiveSource,
  continuousStatusParts,
  syncDisabledMessage,
} = require('../chrome/dashboard_model.js');

describe('visibleSourceTabs: Claude is a per-source enable', () => {
  it('shows Claude when claudeEnabled is absent (existing installs keep working) or true', () => {
    expect(visibleSourceTabs({ scry: {} })).toEqual(['claude']);
    expect(visibleSourceTabs({ scry: { claudeEnabled: true } })).toEqual(['claude']);
  });
  it('hides Claude when claudeEnabled is false', () => {
    expect(visibleSourceTabs({ scry: { claudeEnabled: false } })).toEqual([]);
  });
  it('can show only ChatGPT', () => {
    expect(visibleSourceTabs({ scry: { claudeEnabled: false, chatgptEnabled: true }, signedIn: {} })).toEqual(['chatgpt']);
  });
  it('can show nothing at all (empty-state case)', () => {
    expect(visibleSourceTabs({ scry: { claudeEnabled: false, chatgptEnabled: true }, signedIn: { chatgpt: false } })).toEqual([]);
  });
});

describe('pickActiveSource', () => {
  it('keeps the remembered tab when it is visible', () => {
    expect(pickActiveSource(['claude', 'chatgpt'], 'chatgpt')).toBe('chatgpt');
  });
  it('falls back to the first visible tab', () => {
    expect(pickActiveSource(['chatgpt'], 'claude')).toBe('chatgpt');
    expect(pickActiveSource(['claude', 'chatgpt'], undefined)).toBe('claude');
  });
  it('is null when nothing is visible', () => {
    expect(pickActiveSource([], 'claude')).toBeNull();
  });
});

describe('continuousStatusParts', () => {
  const fmt = (label, enabled) => `${label}:${enabled ? 'on' : 'off'}`;
  it('omits Claude when claudeEnabled is false', () => {
    expect(continuousStatusParts({ claudeEnabled: false }, {}, fmt)).toEqual([]);
    expect(continuousStatusParts({ claudeEnabled: false, chatgptEnabled: true }, {}, fmt)).toEqual(['ChatGPT:on']);
  });
  it('includes Claude by default, off when its sub-toggle is off', () => {
    expect(continuousStatusParts({}, {}, fmt)).toEqual(['Claude:on']);
    expect(continuousStatusParts({ continuousSync: false }, {}, fmt)).toEqual(['Claude:off']);
  });
  it('omits ChatGPT unless enabled', () => {
    expect(continuousStatusParts({ chatgptEnabled: true, chatgptContinuousSync: false }, {}, fmt)).toEqual(['Claude:on', 'ChatGPT:off']);
  });
});

describe('syncDisabledMessage', () => {
  it('names Claude when it is disabled in Options', () => {
    expect(syncDisabledMessage('claude', { claudeEnabled: false })).toMatch(/Claude is disabled.*Options/);
  });
  it('is null when the source is enabled', () => {
    expect(syncDisabledMessage('claude', {})).toBeNull();
    expect(syncDisabledMessage('chatgpt', {})).toBeNull();
  });
});

describe('visibleSourceTabs', () => {
  it('Claude only when ChatGPT is not enabled', () => {
    expect(visibleSourceTabs({ scry: {}, signedIn: {} })).toEqual(['claude']);
    expect(visibleSourceTabs({ scry: { chatgptEnabled: false }, signedIn: { chatgpt: true } })).toEqual(['claude']);
  });

  it('both tabs when ChatGPT is enabled and signed in', () => {
    expect(visibleSourceTabs({ scry: { chatgptEnabled: true }, signedIn: { chatgpt: true } }))
      .toEqual(['claude', 'chatgpt']);
  });

  it('both tabs when ChatGPT is enabled and sign-in status is not yet known (undefined)', () => {
    expect(visibleSourceTabs({ scry: { chatgptEnabled: true }, signedIn: {} }))
      .toEqual(['claude', 'chatgpt']);
  });

  it('ChatGPT enabled but SIGNED OUT: hidden entirely — single source, no switcher', () => {
    const tabs = visibleSourceTabs({ scry: { chatgptEnabled: true }, signedIn: { chatgpt: false } });
    expect(tabs).toEqual(['claude']);
    expect(tabs).toHaveLength(1); // caller's cue to skip rendering a tab switcher
  });

  it('missing scry/signedIn arguments default safely to Claude-only', () => {
    expect(visibleSourceTabs()).toEqual(['claude']);
    expect(visibleSourceTabs({})).toEqual(['claude']);
  });
});

describe('tabLabel', () => {
  it('formats the count with thousands separators', () => {
    expect(tabLabel('claude', 1204)).toBe('Claude 1,204');
    expect(tabLabel('chatgpt', 318)).toBe('ChatGPT 318');
    expect(tabLabel('claude', 1000000)).toBe('Claude 1,000,000');
  });

  it('zero is a real count, not "unknown"', () => {
    expect(tabLabel('chatgpt', 0)).toBe('ChatGPT 0');
  });

  it('renders an em dash for a not-yet-known count', () => {
    expect(tabLabel('claude', null)).toBe('Claude —');
    expect(tabLabel('claude', undefined)).toBe('Claude —');
    expect(tabLabel('claude', NaN)).toBe('Claude —');
  });

  it('falls back to the raw source name for an unrecognized source', () => {
    expect(tabLabel('openwebui', 5)).toBe('openwebui 5');
  });
});

describe('toRow', () => {
  it('maps a Claude conversation (.name is the title)', () => {
    const row = toRow('claude', { uuid: 'abc-123', name: 'Synthetic fixture: garden planning', updated_at: '2026-09-20T10:00:00Z', model: 'claude-sonnet-4-5' });
    expect(row).toEqual({
      uuid: 'abc-123',
      title: 'Synthetic fixture: garden planning',
      updated_at: '2026-09-20T10:00:00Z',
      model: 'claude-sonnet-4-5',
      openUrl: 'https://claude.ai/chat/abc-123',
    });
  });

  it('maps a normalized ChatGPT list item (.title is the title)', () => {
    const row = toRow('chatgpt', { uuid: 'chat-xyz', title: 'Synthetic fixture: recipe scaling', updated_at: '2026-09-19T08:00:00Z' });
    expect(row).toEqual({
      uuid: 'chat-xyz',
      title: 'Synthetic fixture: recipe scaling',
      updated_at: '2026-09-19T08:00:00Z',
      model: null,
      openUrl: 'https://chatgpt.com/c/chat-xyz',
    });
  });

  it('falls back to "Untitled" when neither title field is present', () => {
    const row = toRow('claude', { uuid: 'no-name', updated_at: '2026-09-20T10:00:00Z' });
    expect(row.title).toBe('Untitled');
  });

  it('openUrl is null when there is no uuid to build it from', () => {
    const row = toRow('claude', { name: 'orphan' });
    expect(row.uuid).toBeNull();
    expect(row.openUrl).toBeNull();
  });
});

describe('badgeFromReconcile (server truth)', () => {
  const withBuckets = {
    to_resync: ['m', 'i', 's'],
    buckets: { missing: ['m'], incomplete: ['i'], stale: ['s'] },
  };

  it('each bucket maps to its own badge; otherwise synced', () => {
    expect(badgeFromReconcile('m', withBuckets)).toBe('missing');
    expect(badgeFromReconcile('i', withBuckets)).toBe('incomplete');
    expect(badgeFromReconcile('s', withBuckets)).toBe('stale');
    expect(badgeFromReconcile('ok', withBuckets)).toBe('synced');
  });

  it('without buckets: in to_resync -> needs-sync, else synced', () => {
    const report = { to_resync: ['a'], summary: {} };
    expect(badgeFromReconcile('a', report)).toBe('needs-sync');
    expect(badgeFromReconcile('b', report)).toBe('synced');
  });

  it('fallback NEVER yields missing (or incomplete/stale) when buckets are absent', () => {
    const report = { to_resync: ['a', 'b'] };
    for (const id of ['a', 'b', 'c']) {
      expect(['missing', 'incomplete', 'stale']).not.toContain(badgeFromReconcile(id, report));
    }
  });

  it('no report (failed/unreachable/unauthorized) -> unknown, never missing', () => {
    expect(badgeFromReconcile('a', null)).toBe('unknown');
    expect(badgeFromReconcile('a', undefined)).toBe('unknown');
    expect(badgeFromReconcile('a', 'oops')).toBe('unknown');
  });

  it('badgeNeedsSync is true for actionable badges only', () => {
    for (const b of ['missing', 'incomplete', 'stale', 'needs-sync']) expect(badgeNeedsSync(b)).toBe(true);
    for (const b of ['synced', 'unknown']) expect(badgeNeedsSync(b)).toBe(false);
  });
});

describe('detectSyncTarget', () => {
  it('claude.ai/chat/<uuid>', () => {
    expect(detectSyncTarget('https://claude.ai/chat/1b2c3d4e-5f60-4a1b-9c2d-3e4f5a6b7c8d'))
      .toEqual({ source: 'claude', uuid: '1b2c3d4e-5f60-4a1b-9c2d-3e4f5a6b7c8d' });
  });

  it('chatgpt.com/c/<id>', () => {
    expect(detectSyncTarget('https://chatgpt.com/c/abc123DEF'))
      .toEqual({ source: 'chatgpt', uuid: 'abc123DEF' });
  });

  it('chat.openai.com/c/<id> (legacy host, same shape)', () => {
    expect(detectSyncTarget('https://chat.openai.com/c/abc123'))
      .toEqual({ source: 'chatgpt', uuid: 'abc123' });
  });

  it('recognized source, but not a conversation page (e.g. the homepage) → source known, uuid null', () => {
    expect(detectSyncTarget('https://claude.ai/new')).toEqual({ source: 'claude', uuid: null });
    expect(detectSyncTarget('https://chatgpt.com/')).toEqual({ source: 'chatgpt', uuid: null });
  });

  it('a non-matching site → both null', () => {
    expect(detectSyncTarget('https://example.com/chat/123')).toEqual({ source: null, uuid: null });
    expect(detectSyncTarget('https://google.com/')).toEqual({ source: null, uuid: null });
  });

  it('missing/malformed input never throws', () => {
    expect(detectSyncTarget(null)).toEqual({ source: null, uuid: null });
    expect(detectSyncTarget(undefined)).toEqual({ source: null, uuid: null });
    expect(detectSyncTarget('')).toEqual({ source: null, uuid: null });
    expect(detectSyncTarget('not a url')).toEqual({ source: null, uuid: null });
  });
});

describe('badgeFromReconcile — tombstoned', () => {
  const { badgeFromReconcile, badgeNeedsSync } = require('../chrome/dashboard_model.js');
  it('renders a deliberately deleted conversation as tombstoned, never synced', () => {
    const report = { to_resync: [], buckets: { missing: [], incomplete: [], stale: [], complete: ['a'], tombstoned: ['t'] } };
    expect(badgeFromReconcile('t', report)).toBe('tombstoned');
    expect(badgeFromReconcile('a', report)).toBe('synced');
  });
  it('tombstoned is not actionable', () => {
    expect(badgeNeedsSync('tombstoned')).toBe(false);
  });
});
