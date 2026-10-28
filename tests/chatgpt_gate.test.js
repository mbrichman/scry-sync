// Tests for the ChatGPT global request gate (chrome/chatgpt_adapter.js's
// createChatGptGate): ONE chatgpt.com request in flight at a time, minimum
// spacing between starts by request kind, and a shared cooldown on 429 that
// every lane honours. All clocks are injected -- no real sleeps, synthetic data.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const adapter = require('../chrome/chatgpt_adapter.js');
const {
  createChatGptGate,
  _setChatGptGate,
  ChatGptRateLimitError,
  withChatGptRateLimitRetry,
  _fetchChatGptAsset,
  fetchChatGptConversation,
  listChatGptConversations,
  fetchChatGptFileBlobs,
  CHATGPT_MIN_SPACING_MS,
  CHATGPT_COOLDOWN_SCHEDULE_MS,
  CHATGPT_IMAGE_POOL_DEFAULT,
  CHATGPT_REQUEST_TIMEOUT_MS,
} = adapter;

// A fake clock: sleep() advances time instantly.
function fakeEnv(start = 1_000_000) {
  let t = start;
  const sleeps = [];
  return {
    now: () => t,
    sleep: async (ms) => { sleeps.push(ms); t += ms; },
    advance: (ms) => { t += ms; },
    sleeps,
  };
}

function makeGate(extra = {}) {
  const env = fakeEnv();
  const warns = [];
  const pings = [];
  const gate = createChatGptGate({
    now: env.now, sleep: env.sleep,
    keepalive: () => pings.push(env.now()),
    warn: (...a) => warns.push(a.join(' ')),
    ...extra,
  });
  return { env, gate, warns, pings };
}

describe('constants', () => {
  it('are the designed values, in one place', () => {
    expect(CHATGPT_MIN_SPACING_MS).toEqual({ list: 400, body: 1000, asset: 750 });
    expect(CHATGPT_COOLDOWN_SCHEDULE_MS).toEqual([60000, 120000, 240000, 480000, 900000]);
    expect(CHATGPT_IMAGE_POOL_DEFAULT).toBe(2);
  });
});

describe('gate: serialization and spacing', () => {
  it('runs at most one request at a time even when many are queued at once', async () => {
    const { gate } = makeGate();
    let inFlight = 0, peak = 0;
    const job = () => gate.run('body', async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await Promise.resolve(); await Promise.resolve();
      inFlight--;
    });
    await Promise.all([job(), job(), job(), job()]);
    expect(peak).toBe(1);
  });

  it('spaces request STARTS by kind (list 400, body 1000, asset 750)', async () => {
    const { env, gate } = makeGate();
    const starts = [];
    const go = (kind) => gate.run(kind, async () => { starts.push([kind, env.now()]); });
    await Promise.all([go('list'), go('list'), go('body'), go('asset'), go('body')]);
    const gap = (i) => starts[i][1] - starts[i - 1][1];
    expect(starts.map((s) => s[0])).toEqual(['list', 'list', 'body', 'asset', 'body']);
    expect(gap(1)).toBeGreaterThanOrEqual(400);
    expect(gap(2)).toBeGreaterThanOrEqual(1000);
    expect(gap(3)).toBeGreaterThanOrEqual(750);
    expect(gap(4)).toBeGreaterThanOrEqual(1000);
  });

  it('returns the request value and propagates its error without wedging the queue', async () => {
    const { gate } = makeGate();
    await expect(gate.run('list', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(gate.run('list', async () => 'fine')).resolves.toBe('fine');
  });
});

describe('gate: shared cooldown on 429', () => {
  it('puts ALL lanes in cooldown: nothing starts until the cooldown passes', async () => {
    const { env, gate } = makeGate();
    const t0 = env.now();
    gate.report429({ status: 429, headers: new Headers() });
    const starts = [];
    await Promise.all(['list', 'body', 'asset'].map((k) => gate.run(k, async () => { starts.push(env.now()); })));
    for (const s of starts) expect(s - t0).toBeGreaterThanOrEqual(60000);
  });

  it('Retry-After (seconds) wins over the schedule', () => {
    const { env, gate } = makeGate();
    const ms = gate.report429({ status: 429, headers: new Headers({ 'Retry-After': '7' }) });
    expect(ms).toBe(7000);
    expect(gate.getState().cooldownUntil).toBe(env.now() + 7000);
  });

  it('escalates 60s, 120s, 240s, 480s, 900s and then stays at 900s', () => {
    const { env, gate } = makeGate();
    const got = [];
    for (let i = 0; i < 7; i++) {
      got.push(gate.report429({ status: 429, headers: new Headers() }));
      env.advance(got[i] + 1000); // cooldown over, new 429 soon after
    }
    expect(got).toEqual([60000, 120000, 240000, 480000, 900000, 900000, 900000]);
  });

  it('resets to the start of the schedule after 10 quiet minutes', () => {
    const { env, gate } = makeGate();
    const first = gate.report429({ status: 429, headers: new Headers() });
    env.advance(first + 1000);
    expect(gate.report429({ status: 429, headers: new Headers() })).toBe(120000);
    env.advance(120000 + 10 * 60 * 1000 + 1);
    expect(gate.report429({ status: 429, headers: new Headers() })).toBe(60000);
  });

  it('logs ALL response headers once per cooldown, with the fixed prefix', () => {
    const { env, gate, warns } = makeGate();
    const headers = new Headers({ 'cf-ray': 'abc123', 'x-synthetic': 'yes' });
    gate.report429({ status: 429, headers });
    gate.report429({ status: 429, headers }); // still inside the same cooldown
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('Scry ChatGPT 429 headers:');
    expect(warns[0]).toContain('429');
    expect(warns[0]).toContain('cf-ray');
    expect(warns[0]).toContain('abc123');
    expect(warns[0]).toContain('x-synthetic');
    env.advance(61000);
    gate.report429({ status: 429, headers });
    expect(warns).toHaveLength(2); // a NEW cooldown logs again
  });

  it('a second 429 inside the same cooldown does not extend or escalate it', () => {
    const { gate } = makeGate();
    gate.report429({ status: 429, headers: new Headers() });
    const until = gate.getState().cooldownUntil;
    gate.report429({ status: 429, headers: new Headers() });
    expect(gate.getState().cooldownUntil).toBe(until);
    expect(gate.getState().cooldownsThisRun).toBe(1);
  });

  it('counts cooldowns per run and resetRun clears the count', () => {
    const { env, gate } = makeGate();
    gate.report429({ status: 429, headers: new Headers() });
    env.advance(61000);
    gate.report429({ status: 429, headers: new Headers() });
    expect(gate.getState().cooldownsThisRun).toBe(2);
    gate.resetRun();
    expect(gate.getState().cooldownsThisRun).toBe(0);
  });
});

describe('gate: service-worker keepalive', () => {
  it('pings every 20s during a wait longer than 20s', async () => {
    const { env, gate, pings } = makeGate();
    gate.report429({ status: 429, headers: new Headers({ 'Retry-After': '65' }) });
    await gate.waitForCooldown();
    expect(pings.length).toBeGreaterThanOrEqual(3);
    expect(env.sleeps.every((s) => s <= 20000)).toBe(true);
  });

  it('does not ping for short waits', async () => {
    const { gate, pings } = makeGate();
    await gate.run('body', async () => {});
    await gate.run('body', async () => {}); // waits 1000ms spacing
    expect(pings).toEqual([]);
  });

  it('is a no-op by default when chrome.runtime does not exist', async () => {
    const env = fakeEnv();
    const gate = createChatGptGate({ now: env.now, sleep: env.sleep, warn: () => {} });
    gate.report429({ status: 429, headers: new Headers({ 'Retry-After': '45' }) });
    await expect(gate.waitForCooldown()).resolves.toBeUndefined();
  });
});

describe('adapter requests go through the gate', () => {
  let h;
  beforeEach(() => { h = makeGate(); _setChatGptGate(h.gate); });
  afterEach(() => { _setChatGptGate(createChatGptGate({ spacing: { list: 0, body: 0, asset: 0 } })); delete global.fetch; });

  const ok = (body) => ({ ok: true, status: 200, headers: new Headers(), json: async () => body });
  const r429 = (headers) => ({ ok: false, status: 429, headers: new Headers(headers || {}), json: async () => ({}) });

  it('list pages and conversation bodies are spaced by their kind', async () => {
    const times = [];
    global.fetch = async (url) => { times.push([url, h.env.now()]); return ok({ items: [] }); };
    await listChatGptConversations('tok', { offset: 0, limit: 5 });
    await fetchChatGptConversation('tok', 'c1');
    expect(times[1][1] - times[0][1]).toBeGreaterThanOrEqual(1000);
  });

  it('a 429 on one request throws ChatGptRateLimitError and cools down every lane', async () => {
    let n = 0;
    global.fetch = async () => { n++; return n === 1 ? r429() : ok({ ok: true }); };
    const t0 = h.env.now();
    await expect(fetchChatGptConversation('tok', 'c1')).rejects.toBeInstanceOf(ChatGptRateLimitError);
    expect(h.gate.getState().cooldownUntil - t0).toBe(60000);
    await listChatGptConversations('tok', { offset: 0, limit: 5 });
    expect(h.env.now() - t0).toBeGreaterThanOrEqual(60000);
  });

  it('the asset metadata request AND the byte request both pass through the gate', async () => {
    const times = [];
    global.fetch = async (url) => {
      times.push(h.env.now());
      if (url.includes('/download')) return ok({ status: 'success', download_url: 'https://files.oaiusercontent.com/x', mime_type: 'image/png' });
      return { ok: true, status: 200, headers: new Headers({ 'content-type': 'image/png' }), blob: async () => ({}) };
    };
    global.FileReader = class { readAsDataURL() { this.result = 'data:image/png;base64,AAAA'; this.onloadend(); } };
    await _fetchChatGptAsset('tok', 'sediment://file_abc', null, 'conv-1');
    delete global.FileReader;
    expect(times).toHaveLength(2);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(750);
  });

  it('a 429 on the byte fetch is a rate-limit error that cools the gate down', async () => {
    global.fetch = async (url) => {
      if (url.includes('/download')) return ok({ status: 'success', download_url: 'https://files.oaiusercontent.com/x' });
      return r429({ 'retry-after': '9' });
    };
    await expect(_fetchChatGptAsset('tok', 'sediment://file_abc', null, 'c')).rejects.toBeInstanceOf(ChatGptRateLimitError);
    expect(h.gate.getState().cooldownUntil - h.env.now()).toBe(9000);
  });

  it('image pool default is 2 and everything is still serialized by the gate', async () => {
    let inFlight = 0, peak = 0;
    global.fetch = async (url) => {
      if (url.includes('/download')) {
        inFlight++; peak = Math.max(peak, inFlight);
        await Promise.resolve();
        inFlight--;
        return ok({ status: 'success', download_url: 'https://files.oaiusercontent.com/x', mime_type: 'image/png' });
      }
      return { ok: true, status: 200, headers: new Headers({ 'content-type': 'image/png' }), blob: async () => ({}) };
    };
    global.FileReader = class { readAsDataURL() { this.result = 'data:image/png;base64,AAAA'; this.onloadend(); } };
    const mapping = {};
    for (let i = 0; i < 6; i++) {
      mapping[`n${i}`] = { id: `n${i}`, parent: null, children: [], message: { author: { role: 'tool' }, recipient: 'all',
        content: { content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer', asset_pointer: `sediment://file_${i}` }] } } };
    }
    const out = await fetchChatGptFileBlobs('tok', { conversation_id: 'c', mapping }, null);
    delete global.FileReader;
    expect(out.blobs).toHaveLength(6);
    expect(peak).toBe(1);
  });
});

describe('withChatGptRateLimitRetry waits on the gate cooldown', () => {
  it('defaults to 3 retries and sleeps on the gate, not a private timer', async () => {
    const { env, gate } = makeGate();
    let calls = 0;
    const retries = [];
    await expect(withChatGptRateLimitRetry(async () => {
      calls++;
      gate.report429({ status: 429, headers: new Headers() });
      throw new ChatGptRateLimitError(null, 60000);
    }, { gate, onRetry: (ms) => retries.push(ms) })).rejects.toBeInstanceOf(ChatGptRateLimitError);
    expect(calls).toBe(4);
    expect(retries).toHaveLength(3);
    expect(env.sleeps.length).toBeGreaterThan(0);
  });
});


describe('gate: request timeout', () => {
  function timerEnv() {
    const timers = [];
    return {
      timers,
      setTimeout: (fn, ms) => { const h = { fn, ms, cleared: false }; timers.push(h); return h; },
      clearTimeout: (h) => { h.cleared = true; },
    };
  }
  afterEach(() => { delete global.fetch; });

  it('the timeout constant lives with the other tunables', () => {
    expect(CHATGPT_REQUEST_TIMEOUT_MS).toBe(60000);
  });

  it('aborts a hung fetch as an ordinary failure (not a 429) and does not wedge the queue', async () => {
    const te = timerEnv();
    const { gate } = makeGate({ setTimeout: te.setTimeout, clearTimeout: te.clearTimeout });
    global.fetch = (url, init) => new Promise((resolve, reject) => {
      if (url.includes('hang')) init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      else resolve({ ok: true, status: 200, headers: new Headers(), json: async () => ({ fine: true }) });
    });
    const hung = gate.run('body', () => gate.fetchWith('hung req', 'https://x/hang', {}, async (r) => r.json()));
    const next = gate.run('body', () => gate.fetchWith('next req', 'https://x/ok', {}, async (r) => r.json()));
    await new Promise((r) => setTimeout(r, 0));
    expect(te.timers[0].ms).toBe(60000);
    te.timers[0].fn(); // the 60s timer fires
    const err = await hung.catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ChatGptRateLimitError);
    expect(err.message).toMatch(/hung req.*timed out after 60s/);
    await expect(next).resolves.toEqual({ fine: true });
    expect(gate.getState().cooldownUntil).toBe(0);
    expect(gate.getState().cooldownsThisRun).toBe(0);
  });

  it('also covers a stalled body read, and clears the timer on success', async () => {
    const te = timerEnv();
    const { gate } = makeGate({ setTimeout: te.setTimeout, clearTimeout: te.clearTimeout });
    global.fetch = async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({}) });
    await gate.run('body', () => gate.fetchWith('ok', 'https://x', {}, async (r) => r.json()));
    expect(te.timers[0].cleared).toBe(true);
    global.fetch = async (url, init) => ({
      ok: true, status: 200, headers: new Headers(),
      json: () => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted')))),
    });
    const p = gate.run('body', () => gate.fetchWith('slow body', 'https://x', {}, async (r) => r.json()));
    await new Promise((r) => setTimeout(r, 0));
    te.timers[1].fn();
    await expect(p).rejects.toThrow(/slow body.*timed out/);
  });
});
