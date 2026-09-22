// Tests for chrome/scry_client.js's Claude org-id auto-detection — the same
// selection rule content.js's detectOrgId message handler has always used,
// now reachable WITHOUT a claude.ai tab (chrome/browse.js's dashboard no
// longer relays through content.js for this). selectClaudeOrgId is the pure
// half (fixture arrays, no fetch); detectClaudeOrgId is the impure fetch +
// persist wrapper around it, covered separately with a stubbed fetch/chrome.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const { selectClaudeOrgId, detectClaudeOrgId } = require('../chrome/scry_client.js');

describe('selectClaudeOrgId', () => {
  it('prefers the org with "chat" capability over the first in the list', () => {
    const orgs = [
      { uuid: 'api-org', capabilities: ['api'] },
      { uuid: 'chat-org', capabilities: ['chat', 'api'] },
    ];
    expect(selectClaudeOrgId(orgs)).toBe('chat-org');
  });

  it('falls back to the first org when none declares "chat"', () => {
    const orgs = [
      { uuid: 'first-org', capabilities: ['api'] },
      { uuid: 'second-org', capabilities: [] },
    ];
    expect(selectClaudeOrgId(orgs)).toBe('first-org');
  });

  it('falls back to the first org when capabilities is missing entirely', () => {
    const orgs = [{ uuid: 'only-org' }];
    expect(selectClaudeOrgId(orgs)).toBe('only-org');
  });

  it('a single chat-capable org is chosen directly', () => {
    expect(selectClaudeOrgId([{ uuid: 'solo', capabilities: ['chat'] }])).toBe('solo');
  });

  it('empty or non-array input → null, never throws', () => {
    expect(selectClaudeOrgId([])).toBeNull();
    expect(selectClaudeOrgId(null)).toBeNull();
    expect(selectClaudeOrgId(undefined)).toBeNull();
    expect(selectClaudeOrgId('not-an-array')).toBeNull();
  });

  it('a chosen org with no uuid → null rather than undefined/garbage', () => {
    expect(selectClaudeOrgId([{ capabilities: ['chat'] }])).toBeNull();
  });
});

describe('detectClaudeOrgId', () => {
  let stored;
  beforeEach(() => {
    stored = {};
    global.chrome = {
      storage: { sync: { set: (obj, cb) => { Object.assign(stored, obj); if (cb) cb(); } } },
    };
  });
  afterEach(() => { delete global.chrome; delete global.fetch; });

  it('fetches, selects via the chat-capability rule, and persists to chrome.storage.sync', async () => {
    global.fetch = async (url, opts) => {
      expect(url).toBe('https://claude.ai/api/organizations');
      expect(opts.credentials).toBe('include');
      return { ok: true, json: async () => ([{ uuid: 'org-a', capabilities: ['api'] }, { uuid: 'org-b', capabilities: ['chat'] }]) };
    };
    const orgId = await detectClaudeOrgId();
    expect(orgId).toBe('org-b');
    expect(stored.organizationId).toBe('org-b');
  });

  it('throws on a non-OK response', async () => {
    global.fetch = async () => ({ ok: false, status: 403 });
    await expect(detectClaudeOrgId()).rejects.toThrow(/403/);
  });

  it('throws when no organizations are returned', async () => {
    global.fetch = async () => ({ ok: true, json: async () => [] });
    await expect(detectClaudeOrgId()).rejects.toThrow(/no organizations/);
  });
});
