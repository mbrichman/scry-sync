// Tests for chrome/sources.js's SOURCES.chatgpt.syncOne consuming ctx.onStatus
// (chrome/sync_core.js's syncBatch threads opts.onStatus into ctx.onStatus —
// see tests/sync_core.test.js for that half). syncOne is impure (talks to
// chatgpt.com + Scry via bare globals, matching the file's existing
// browser-global convention — see sources.js's header comment), so this stubs
// every global it touches rather than hitting real network.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const { runPool } = require('../chrome/scry_sync.js');
const { SOURCES } = require('../chrome/sources.js');

const ORIGINAL = {};
const STUBBED_GLOBALS = [
  'getChatGptAccessToken', 'fetchChatGptConversation', 'withChatGptRateLimitRetry',
  'collectChatGptImagePointers', 'fetchChatGptFileBlobs', 'buildChatGptIngestPayload',
  'withRetry', 'postToScry', 'runPool',
];

beforeEach(() => {
  for (const name of STUBBED_GLOBALS) ORIGINAL[name] = global[name];
  global.runPool = runPool; // withRetry doesn't need it, but keep parity with the browser load order
  global.getChatGptAccessToken = async () => { throw new Error('should not be called — ctx.token was set'); };
  global.fetchChatGptConversation = async (token, uuid) => ({ conversation_id: uuid, mapping: {} });
  global.buildChatGptIngestPayload = (body, blobs) => ({ ...body, files: blobs });
  global.withRetry = async (fn) => fn(0);
  global.postToScry = async () => ({ ok: true, status: 200, body: { success: true, status: 'created', files_stored: 0 } });
});

afterEach(() => {
  for (const name of STUBBED_GLOBALS) {
    if (ORIGINAL[name] === undefined) delete global[name];
    else global[name] = ORIGINAL[name];
  }
});

describe('SOURCES.chatgpt.syncOne — ctx.onStatus', () => {
  it('reports "rate limited — waiting Ns" via ctx.onStatus when the conversation fetch backs off', async () => {
    global.withChatGptRateLimitRetry = async (fn, opts) => {
      if (opts && opts.onRetry) opts.onRetry(2500); // simulate one 429 backoff
      return fn();
    };
    global.collectChatGptImagePointers = () => [];
    global.fetchChatGptFileBlobs = async () => ({ blobs: [], failures: [] });

    const statuses = [];
    const ctx = { token: 'tok', wantImages: true, onStatus: (t) => statuses.push(t) };
    await SOURCES.chatgpt.syncOne(ctx, { uuid: 'conv-1' }, { url: 'http://x' });

    expect(statuses).toContain('rate limited — waiting 3s');
  });

  it('never calls onStatus when the fetch succeeds first try (no backoff)', async () => {
    global.withChatGptRateLimitRetry = async (fn) => fn();
    global.collectChatGptImagePointers = () => [];
    global.fetchChatGptFileBlobs = async () => ({ blobs: [], failures: [] });

    const statuses = [];
    const ctx = { token: 'tok', wantImages: false, onStatus: (t) => statuses.push(t) };
    await SOURCES.chatgpt.syncOne(ctx, { uuid: 'conv-1' }, { url: 'http://x' });

    expect(statuses).toEqual([]);
  });

  it('reports "images N/M" via ctx.onStatus as each image is fetched', async () => {
    global.withChatGptRateLimitRetry = async (fn) => fn();
    global.collectChatGptImagePointers = () => ['p1', 'p2', 'p3']; // total = 3
    global.fetchChatGptFileBlobs = async (token, body, accountId, onEach) => {
      onEach(); onEach(); onEach();
      return { blobs: [], failures: [] };
    };

    const statuses = [];
    const ctx = { token: 'tok', wantImages: true, onStatus: (t) => statuses.push(t) };
    await SOURCES.chatgpt.syncOne(ctx, { uuid: 'conv-1' }, { url: 'http://x' });

    expect(statuses).toEqual(['images 1/3', 'images 2/3', 'images 3/3']);
  });

  it('no ctx.onStatus set → fetchChatGptFileBlobs gets no onEach callback (undefined, not a no-op function)', async () => {
    global.withChatGptRateLimitRetry = async (fn) => fn();
    global.collectChatGptImagePointers = () => ['p1'];
    let receivedOnEach = 'unset';
    global.fetchChatGptFileBlobs = async (token, body, accountId, onEach) => {
      receivedOnEach = onEach;
      return { blobs: [], failures: [] };
    };

    const ctx = { token: 'tok', wantImages: true }; // no onStatus
    await SOURCES.chatgpt.syncOne(ctx, { uuid: 'conv-1' }, { url: 'http://x' });

    expect(receivedOnEach).toBeUndefined();
  });

  it('wantImages: false skips fetchChatGptFileBlobs entirely — no image status at all', async () => {
    global.withChatGptRateLimitRetry = async (fn) => fn();
    global.collectChatGptImagePointers = () => { throw new Error('should not be called when wantImages is false'); };
    global.fetchChatGptFileBlobs = async () => { throw new Error('should not be called when wantImages is false'); };

    const statuses = [];
    const ctx = { token: 'tok', wantImages: false, onStatus: (t) => statuses.push(t) };
    await SOURCES.chatgpt.syncOne(ctx, { uuid: 'conv-1' }, { url: 'http://x' });

    expect(statuses).toEqual([]);
  });
});
