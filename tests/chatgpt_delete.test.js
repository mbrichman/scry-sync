// Tests for the gated ChatGPT delete (owner-ruled 2026-10-31). Synthetic ids and
// bodies only; fetch and the clock are injected. A delete counts as done ONLY
// when a follow-up GET sees 404 with code conversation_deleted.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const adapter = require('../chrome/chatgpt_adapter.js');
const sources = require('../chrome/sources.js');
const scryClient = require('../chrome/scry_client.js');
const {
  createChatGptGate, _setChatGptGate, ChatGptRateLimitError,
  deleteChatGptConversation, verifyChatGptDeleted, isDeletableChatGptId,
  runChatGptGatedDelete, CHATGPT_MIN_SPACING_MS,
} = adapter;

const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const ID3 = '33333333-3333-4333-8333-333333333333';

function makeGate() {
  let t = 1_000_000;
  const env = { now: () => t, sleep: async (ms) => { t += ms; } };
  const gate = createChatGptGate({ now: env.now, sleep: env.sleep, keepalive: () => {}, warn: () => {} });
  return { env, gate };
}
const json = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300, status, headers: new Headers(headers), json: async () => body,
});
const goneResp = () => json(404, { detail: { code: 'conversation_deleted', message: 'gone' } });

let h;
beforeEach(() => { h = makeGate(); _setChatGptGate(h.gate); });
afterEach(() => {
  _setChatGptGate(createChatGptGate({ spacing: { list: 0, body: 0, asset: 0, delete: 0 } }));
  delete global.fetch;
});

describe('id guard', () => {
  it('accepts plain UUIDs only', () => {
    expect(isDeletableChatGptId(ID1)).toBe(true);
    expect(isDeletableChatGptId('local-chatgpt:' + ID1)).toBe(false);
    expect(isDeletableChatGptId('not-a-uuid')).toBe(false);
    expect(isDeletableChatGptId(ID1 + '/extra')).toBe(false);
    expect(isDeletableChatGptId('')).toBe(false);
    expect(isDeletableChatGptId(null)).toBe(false);
  });
  it('delete and verify refuse bad ids without any network call', async () => {
    let calls = 0;
    global.fetch = async () => { calls++; return json(200, {}); };
    await expect(deleteChatGptConversation('tok', 'local-chatgpt:' + ID1)).rejects.toThrow(/refus/i);
    await expect(deleteChatGptConversation('tok', '../x')).rejects.toThrow(/refus/i);
    await expect(verifyChatGptDeleted('tok', 'nope')).rejects.toThrow(/refus/i);
    expect(calls).toBe(0);
  });
});

describe('deleteChatGptConversation', () => {
  it('sends PATCH {is_visible:false} to the conversation URL with the bearer headers', async () => {
    let seen;
    global.fetch = async (url, init) => { seen = { url, init }; return json(200, { success: true }); };
    const r = await deleteChatGptConversation('tok', ID1, 'acct-1');
    expect(seen.url).toBe(`https://chatgpt.com/backend-api/conversation/${ID1}`);
    expect(seen.init.method).toBe('PATCH');
    expect(JSON.parse(seen.init.body)).toEqual({ is_visible: false });
    expect(seen.init.headers['Authorization']).toBe('Bearer tok');
    expect(seen.init.headers['X-Authorization']).toBe('Bearer tok');
    expect(seen.init.headers['Chatgpt-Account-Id']).toBe('acct-1');
    expect(seen.init.headers['Content-Type']).toBe('application/json');
    expect(seen.init.credentials).toBe('include');
    expect(r).toEqual({ ok: true, status: 200 });
  });
  it('a non-2xx is returned as not ok', async () => {
    global.fetch = async () => json(403, {});
    expect(await deleteChatGptConversation('tok', ID1)).toEqual({ ok: false, status: 403 });
  });
  it('a 429 throws ChatGptRateLimitError and cools every lane', async () => {
    global.fetch = async () => json(429, {});
    const t0 = h.env.now();
    await expect(deleteChatGptConversation('tok', ID1)).rejects.toBeInstanceOf(ChatGptRateLimitError);
    expect(h.gate.getState().cooldownUntil - t0).toBe(60000);
  });
  it('goes through the gate: delete spacing is >= the body spacing and honours the cooldown', async () => {
    expect(CHATGPT_MIN_SPACING_MS.delete).toBeGreaterThanOrEqual(CHATGPT_MIN_SPACING_MS.body);
    const times = [];
    global.fetch = async () => { times.push(h.env.now()); return json(200, { success: true }); };
    await deleteChatGptConversation('tok', ID1);
    await deleteChatGptConversation('tok', ID2);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(CHATGPT_MIN_SPACING_MS.delete);
    h.gate.report429({ status: 429, headers: new Headers() });
    const t1 = h.env.now();
    await deleteChatGptConversation('tok', ID3);
    expect(times[2] - t1).toBeGreaterThanOrEqual(60000);
  });
});

describe('verifyChatGptDeleted', () => {
  it('true ONLY for 404 with code conversation_deleted', async () => {
    global.fetch = async (url, init) => { expect(init.method || 'GET').toBe('GET'); return goneResp(); };
    expect(await verifyChatGptDeleted('tok', ID1)).toBe(true);
  });
  it('accepts a top-level code too', async () => {
    global.fetch = async () => json(404, { code: 'conversation_deleted' });
    expect(await verifyChatGptDeleted('tok', ID1)).toBe(true);
  });
  it('false for 200, other 404, 5xx, and unparsable 404', async () => {
    for (const resp of [
      json(200, { title: 'x' }),
      json(404, { detail: { code: 'conversation_not_found' } }),
      json(404, { detail: 'Not found' }),
      json(500, { detail: { code: 'conversation_deleted' } }),
      { ok: false, status: 404, headers: new Headers(), json: async () => { throw new Error('bad'); } },
    ]) {
      global.fetch = async () => resp;
      expect(await verifyChatGptDeleted('tok', ID1)).toBe(false);
    }
  });
  it('a 429 throws a rate-limit error; routed through the gate', async () => {
    global.fetch = async () => json(429, {});
    await expect(verifyChatGptDeleted('tok', ID1)).rejects.toBeInstanceOf(ChatGptRateLimitError);
    expect(h.gate.getState().cooldownUntil).toBeGreaterThan(h.env.now());
  });
});

// ---- the flow ----
function flowDeps(over = {}) {
  const log = { fetched: [], patched: [], verified: [], confirmMsg: null, verifyItems: null };
  const deleted = new Set();
  global.fetch = async (url, init) => {
    const id = url.split('/').pop();
    if (init && init.method === 'PATCH') {
      log.patched.push(id);
      if (over.patchFail && over.patchFail.has(id)) return json(500, {});
      if (!over.noEffect) deleted.add(id);
      return json(200, { success: true });
    }
    if (deleted.has(id) && !(over.stillThere && over.stillThere.has(id))) { log.verified.push(id); return goneResp(); }
    if (log.patched.includes(id)) { log.verified.push(id); return json(200, { title: 'x' }); }
    log.fetched.push(id);
    return json(200, { id, mapping: { n: { synthetic: true } } });
  };
  const deps = {
    token: 'tok', accountId: null,
    selected: [{ uuid: ID1, name: 'one' }, { uuid: ID2, name: 'two' }, { uuid: ID3, name: 'three' }],
    verifyWithScry: async (items) => {
      log.verifyItems = items;
      return { results: items.map((it) => ({ source_id: it.source_id, deletable: !(over.blocked || []).includes(it.source_id), reasons: ['r'] })) };
    },
    confirm: async (info) => { log.confirmMsg = info; return over.confirm !== false; },
    onProgress: () => {},
    ...over.deps,
  };
  return { deps, log };
}

describe('runChatGptGatedDelete', () => {
  it('fetches bodies live and sends them VERBATIM with the cleared set; deletes only cleared ids', async () => {
    const { deps, log } = flowDeps({ blocked: [ID2] });
    const out = await runChatGptGatedDelete(deps);
    expect(log.fetched).toEqual([ID1, ID2, ID3]);
    expect(log.verifyItems.map((i) => i.source_id)).toEqual([ID1, ID2, ID3]);
    expect(log.verifyItems[0].live_body).toEqual({ id: ID1, mapping: { n: { synthetic: true } } });
    expect(log.patched).toEqual([ID1, ID3]);
    expect(out.deleted).toEqual([ID1, ID3]);
    expect(out.failed).toEqual([]);
    expect(out.blocked.map((b) => b.source_id)).toEqual([ID2]);
    expect(log.confirmMsg.cleared).toBe(2);
  });
  it('never deletes anything when the owner declines', async () => {
    const { deps, log } = flowDeps({ confirm: false });
    const out = await runChatGptGatedDelete(deps);
    expect(log.patched).toEqual([]);
    expect(out.cancelled).toBe(true);
  });
  it('never deletes when nothing is cleared', async () => {
    const { deps, log } = flowDeps({ blocked: [ID1, ID2, ID3] });
    const out = await runChatGptGatedDelete(deps);
    expect(log.patched).toEqual([]);
    expect(out.deleted).toEqual([]);
  });
  it('a failed verification is reported as a failure, not a delete', async () => {
    const { deps, log } = flowDeps({ stillThere: new Set([ID2]) });
    const out = await runChatGptGatedDelete(deps);
    expect(out.deleted).toEqual([ID1, ID3]);
    expect(out.failed.map((f) => f.source_id)).toEqual([ID2]);
    expect(out.failed[0].error).toMatch(/verif/i);
    expect(log.patched).toContain(ID2);
  });
  it('a PATCH that returns non-2xx is a failure and is not verified as deleted', async () => {
    const { deps } = flowDeps({ patchFail: new Set([ID1]) });
    const out = await runChatGptGatedDelete(deps);
    expect(out.failed.map((f) => f.source_id)).toEqual([ID1]);
    expect(out.deleted).toEqual([ID2, ID3]);
  });
  it('local-chatgpt: and non-UUID ids are skipped and reported, never fetched, sent, or deleted', async () => {
    const { deps, log } = flowDeps({ deps: {
      selected: [{ uuid: 'local-chatgpt:' + ID1, name: 'tmp' }, { uuid: 'junk', name: 'j' }, { uuid: ID2, name: 'two' }],
    } });
    const out = await runChatGptGatedDelete(deps);
    expect(out.refused.map((r) => r.source_id)).toEqual(['local-chatgpt:' + ID1, 'junk']);
    expect(log.fetched).toEqual([ID2]);
    expect(log.verifyItems.map((i) => i.source_id)).toEqual([ID2]);
    expect(log.patched).toEqual([ID2]);
  });
  it('an id the server did not mention is never deleted', async () => {
    const { deps, log } = flowDeps({ deps: {
      verifyWithScry: async () => ({ results: [{ source_id: ID1, deletable: true }] }),
    } });
    await runChatGptGatedDelete(deps);
    expect(log.patched).toEqual([ID1]);
  });
  it('a body-fetch failure excludes that id from verify and delete', async () => {
    const { deps, log } = flowDeps();
    const base = global.fetch;
    global.fetch = async (url, init) => (url.endsWith(ID2) && !(init && init.method) ? json(500, {}) : base(url, init));
    const out = await runChatGptGatedDelete(deps);
    expect(log.verifyItems.map((i) => i.source_id)).toEqual([ID1, ID3]);
    expect(out.fetchFailed).toHaveLength(1);
    expect(log.patched).toEqual([ID1, ID3]);
  });
  it('a 429 on delete backs off via the cooldown and retries, then succeeds', async () => {
    const { deps, log } = flowDeps({ deps: { selected: [{ uuid: ID1, name: 'one' }] } });
    const inner = global.fetch;
    let first = true;
    global.fetch = async (url, init) => {
      if (init && init.method === 'PATCH' && first) { first = false; return json(429, {}); }
      return inner(url, init);
    };
    const t0 = h.env.now();
    const out = await runChatGptGatedDelete(deps);
    expect(out.deleted).toEqual([ID1]);
    expect(h.env.now() - t0).toBeGreaterThanOrEqual(60000);
    expect(log.patched).toEqual([ID1]);
  });
  it('persistent 429s stop the run: remaining ids are reported unattempted, not failed-and-continued', async () => {
    const { deps, log } = flowDeps();
    const inner = global.fetch;
    global.fetch = async (url, init) => (init && init.method === 'PATCH' ? json(429, {}) : inner(url, init));
    const out = await runChatGptGatedDelete(deps);
    expect(out.deleted).toEqual([]);
    expect(out.rateLimited).toBe(true);
    expect(out.notAttempted.length).toBeGreaterThanOrEqual(2);
    expect(log.patched).toEqual([]);
  });
});

describe('contract and Scry client', () => {
  it('SOURCES declares delete for both claude and chatgpt', () => {
    expect(sources.SOURCES.claude.delete).toBe(true);
    expect(sources.SOURCES.chatgpt.delete).toBe(true);
  });
  it('verifyDeletableWithScry sends the source_type it is given (default claude)', async () => {
    const bodies = [];
    global.fetch = async (url, init) => { bodies.push([url, JSON.parse(init.body)]); return { ok: true, json: async () => ({ results: [] }) }; };
    const scry = { url: 'http://scry.test/', token: 't' };
    await scryClient.verifyDeletableWithScry(scry, [{ source_id: 'a', live_body: {} }]);
    await scryClient.verifyDeletableWithScry(scry, [{ source_id: 'b', live_body: {} }], 'chatgpt');
    expect(bodies[0][0]).toBe('http://scry.test/api/conversations/verify-deletable');
    expect(bodies[0][1].source_type).toBe('claude');
    expect(bodies[1][1].source_type).toBe('chatgpt');
    expect(bodies[1][1].conversations).toEqual([{ source_id: 'b', live_body: {} }]);
  });
});

describe('review follow-ups', () => {
  it('confirm skipped count includes ids left unfetched after a fetch-phase 429', async () => {
    const { deps, log } = flowDeps();
    const inner = global.fetch;
    global.fetch = async (url, init) => (url.endsWith(ID2) && !(init && init.method) ? json(429, {}) : inner(url, init));
    const out = await runChatGptGatedDelete(deps);
    expect(out.notAttempted.map((n) => n.source_id)).toEqual([ID3]);
    expect(log.confirmMsg.notAttempted).toBe(1);
    expect(log.confirmMsg.skipped).toBe(2); // ID2 fetch-failed + ID3 unfetched
  });
  it('PATCH ok but verify exhausts 429 retries: failure says it may have succeeded and to re-check', async () => {
    const { deps } = flowDeps({ deps: { selected: [{ uuid: ID1, name: 'one' }, { uuid: ID2, name: 'two' }] } });
    const inner = global.fetch;
    global.fetch = async (url, init) => {
      if (!(init && init.method) && inner.length >= 0 && (url.endsWith(ID1))) {
        // GET on ID1: body fetch first (before any PATCH) must work; after PATCH, 429.
        if (global.__patched) return json(429, {});
      }
      if (init && init.method === 'PATCH') global.__patched = true;
      return inner(url, init);
    };
    const out = await runChatGptGatedDelete(deps);
    delete global.__patched;
    expect(out.rateLimited).toBe(true);
    expect(out.failed.map((f) => f.source_id)).toEqual([ID1]);
    expect(out.failed[0].error).toMatch(/may have succeeded/i);
    expect(out.failed[0].error).toMatch(/re-check/i);
    expect(out.notAttempted.map((n) => n.source_id)).toEqual([ID2]);
  });
});
