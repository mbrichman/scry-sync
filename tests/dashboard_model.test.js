// Tests for the pure dashboard model (chrome/dashboard_model.js) behind the
// unified dashboard (phase 3): which source tabs show, their labels, the
// row mapping shared by both sources, the synced-status badge, and the
// popup's site-detection helper. Synthetic data only — no fetch, no chrome.*.

import { describe, it, expect } from 'vitest';

const {
  visibleSourceTabs,
  tabLabel,
  toRow,
  syncedBadge,
  detectSyncTarget,
} = require('../chrome/dashboard_model.js');

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
    const row = toRow('claude', { uuid: 'abc-123', name: 'Bear Roaring with Light', updated_at: '2026-09-20T10:00:00Z', model: 'claude-sonnet-4-5' });
    expect(row).toEqual({
      uuid: 'abc-123',
      title: 'Bear Roaring with Light',
      updated_at: '2026-09-20T10:00:00Z',
      model: 'claude-sonnet-4-5',
      openUrl: 'https://claude.ai/chat/abc-123',
    });
  });

  it('maps a normalized ChatGPT list item (.title is the title)', () => {
    const row = toRow('chatgpt', { uuid: 'chat-xyz', title: 'Image request fourth wing', updated_at: '2026-09-19T08:00:00Z' });
    expect(row).toEqual({
      uuid: 'chat-xyz',
      title: 'Image request fourth wing',
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

describe('syncedBadge', () => {
  it('no local record at all → missing', () => {
    expect(syncedBadge(null)).toBe('missing');
    expect(syncedBadge(undefined)).toBe('missing');
    expect(syncedBadge({ syncedAt: null, updatedAt: '2026-09-20T10:00:00Z' })).toBe('missing');
  });

  it('synced at or after the current updated_at → synced', () => {
    expect(syncedBadge({ syncedAt: '2026-09-20T11:00:00Z', updatedAt: '2026-09-20T10:00:00Z' })).toBe('synced');
    expect(syncedBadge({ syncedAt: '2026-09-20T10:00:00Z', updatedAt: '2026-09-20T10:00:00Z' })).toBe('synced');
  });

  it('synced before the current updated_at (conversation grew since) → stale', () => {
    expect(syncedBadge({ syncedAt: '2026-09-20T09:00:00Z', updatedAt: '2026-09-20T10:00:00Z' })).toBe('stale');
  });

  it('malformed dates → unknown, never a guess', () => {
    expect(syncedBadge({ syncedAt: 'not-a-date', updatedAt: '2026-09-20T10:00:00Z' })).toBe('unknown');
    expect(syncedBadge({ syncedAt: '2026-09-20T10:00:00Z', updatedAt: null })).toBe('unknown');
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
