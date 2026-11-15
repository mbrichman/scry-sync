// Tests for the artifact collector (chrome/artifacts.js). Synthetic fixtures only.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
const nodeCrypto = require('node:crypto');
const A = require('../chrome/artifacts.js');
const scriptingStub = { registerContentScripts: vi.fn(async () => {}), unregisterContentScripts: vi.fn(async () => {}) };
globalThis.chrome = { scripting: scriptingStub };

const sha = (buf) => nodeCrypto.createHash('sha256').update(buf).digest('hex');
const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';

describe('paths / manifest / type', () => {
  const files = [
    { path: 'index.html', size: 10, contentType: 'text/html', sha256: 'aa' },
    { path: 'artifact-type/app.js', size: 8_000_000, contentType: 'text/javascript', sha256: 'bb' },
    { path: 'big.bin', size: 26 * 1024 * 1024, contentType: 'application/octet-stream', sha256: 'cc' },
    { path: 'SKILL.md', size: 5, contentType: 'text/markdown', sha256: 'dd' },
  ];
  it('manifest lists every file including the vendor app', () => {
    const m = A.buildArtifactManifest(files);
    expect(m.map((f) => f.path)).toContain('artifact-type/app.js');
    expect(m[0]).toEqual({ path: 'index.html', size: 10, content_type: 'text/html', sha256: 'aa' });
  });
  it('never uploads vendor files and records oversize files', () => {
    const sel = A.selectArtifactFiles(files);
    expect(sel.upload.map((f) => f.path)).toEqual(['index.html', 'SKILL.md']);
    expect(sel.vendor).toBe(1);
    expect(sel.oversize).toEqual([{ path: 'big.bin', size: 26 * 1024 * 1024 }]);
  });
  it('infers type', () => {
    const typedM = A.buildArtifactManifest(files);
    expect(A.inferArtifactType({ kind: 'page', manifest: typedM, mainContentType: 'text/html' })).toBe('typed');
    const m = [{ path: 'index.html' }];
    expect(A.inferArtifactType({ kind: 'page', manifest: m, mainContentType: 'text/html; charset=utf-8' })).toBe('html');
    expect(A.inferArtifactType({ kind: 'page', manifest: m, mainContentType: 'image/svg+xml' })).toBe('svg');
    expect(A.inferArtifactType({ kind: 'page', manifest: m, mainContentType: 'text/markdown' })).toBe('markdown');
    expect(A.inferArtifactType({ kind: 'page', manifest: m, mainContentType: 'text/x-python' })).toBe('code');
    expect(A.inferArtifactType({ kind: 'snippet', manifest: [], mainContentType: 'text/x-python' })).toBe('text/x-python');
  });
  it('main file prefers index.html over other own files', () => {
    expect(A.artifactMainFile([{ path: 'a.css' }, { path: 'index.html' }]).path).toBe('index.html');
  });
});

describe('planner', () => {
  const item = (o = {}) => ({ id: ID1, updated_at: '2026-11-10T00:00:00Z', thumbnail_url: 'https://x.frame.claudeusercontent.com/t', ...o });
  const entry = (o = {}) => ({ updated_at: '2026-11-10T00:00:00Z', version: '3', files: { 'index.html': 'aa' }, has_png: true, tombstoned: false, ...o });
  it('new id', () => expect(A.planArtifact(item(), undefined)).toEqual({ capture: true, reason: 'new' }));
  it('newer updated_at', () => expect(A.planArtifact(item({ updated_at: '2026-11-11T00:00:00Z' }), entry()).reason).toBe('updated'));
  it('same -> unchanged', () => expect(A.planArtifact(item(), entry())).toEqual({ capture: false, reason: 'unchanged' }));
  it('tombstoned beats everything', () => {
    expect(A.planArtifact(item({ updated_at: '2030-01-01T00:00:00Z' }), entry({ tombstoned: true }))).toEqual({ capture: false, reason: 'tombstoned' });
  });
  it('manifest sha change (own files) recaptures; vendor churn does not', () => {
    const d = { ver: '3', files: [{ path: 'index.html', sha256: 'zz' }] };
    expect(A.planArtifact(item(), entry(), { detail: d }).reason).toBe('manifest_changed');
    const dv = { ver: '3', files: [{ path: 'index.html', sha256: 'aa' }, { path: 'artifact-type/x.js', sha256: 'new' }] };
    expect(A.planArtifact(item(), entry(), { detail: dv }).capture).toBe(false);
  });
  it('missing png recaptures unless recently tried', () => {
    expect(A.planArtifact(item(), entry({ has_png: false })).reason).toBe('missing_png');
    const now = Date.now();
    expect(A.planArtifact(item(), entry({ has_png: false }), { pngTried: { [ID1]: now - 1000 }, now }).capture).toBe(false);
    expect(A.planArtifact(item(), entry({ has_png: false }), { pngTried: { [ID1]: now - 8 * 86400000 }, now }).capture).toBe(true);
  });
  it('no thumbnail -> missing png is not a reason', () => {
    expect(A.planArtifact(item({ thumbnail_url: null }), entry({ has_png: false })).capture).toBe(false);
  });
  it('plan lists needsDetail only for unchanged, skips tombstoned', () => {
    const list = [item(), item({ id: ID2 }), item({ id: 'x3' })];
    const state = { artifacts: { [ID1]: entry(), 'x3': entry({ tombstoned: true }) } };
    const p = A.planArtifactCaptures(list, state);
    expect(p.capture.map((c) => c.id)).toEqual([ID2]);
    expect(p.needsDetail).toEqual([ID1]);
    expect(p.skip.find((s) => s.id === 'x3').reason).toBe('tombstoned');
  });
});

describe('list helpers', () => {
  it('extracts a cursor defensively', () => {
    expect(A.extractArtifactCursor({ next_cursor: 'abc' })).toBe('abc');
    expect(A.extractArtifactCursor({ nextCursor: 'q' })).toBe('q');
    expect(A.extractArtifactCursor({ artifacts: [] })).toBe(null);
    expect(A.extractArtifactCursor(null)).toBe(null);
  });
  it('normalizes', () => {
    expect(A.normalizeArtifactList({ artifacts: [{ id: 'a' }, null, {}] })).toHaveLength(1);
    expect(A.normalizeArtifactList({})).toEqual([]);
  });
});

describe('hash + payload', () => {
  it('base64 + sha verify', async () => {
    const bytes = new TextEncoder().encode('<p>synthetic</p>');
    const ok = await A.prepareArtifactFile({ path: 'index.html', sha256: sha(bytes), contentType: 'text/html' }, bytes, null);
    expect(ok.ok).toBe(true);
    expect(Buffer.from(ok.entry.data_b64, 'base64').toString()).toBe('<p>synthetic</p>');
    expect(ok.entry.sha256).toBe(sha(bytes));
    const bad = await A.prepareArtifactFile({ path: 'index.html', sha256: 'deadbeef' }, bytes, null);
    expect(bad).toEqual({ ok: false, reason: 'sha_mismatch', path: 'index.html' });
  });
  it('accepts a base64 sha256 and uppercase hex', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const hex = sha(bytes);
    expect((await A.prepareArtifactFile({ path: 'a', sha256: hex.toUpperCase() }, bytes)).ok).toBe(true);
    expect((await A.prepareArtifactFile({ path: 'a', sha256: Buffer.from(hex, 'hex').toString('base64') }, bytes)).ok).toBe(true);
  });
  it('payload shape: nulls for empty db/comments/png, no tokens', () => {
    const p = A.buildArtifactPayload({
      item: { id: ID1, open_url: '/artifact/s', title: 'T', kind: 'page', source: 'chat', created_at: 'c', updated_at: 'u' },
      detail: { ver: 'v9', assetToken: 'SECRET' }, manifest: [], type: 'html', files: [], db: {}, comments: [], png: null, fetchReport: { a: 1 },
    });
    expect(p.db).toBeNull(); expect(p.comments).toBeNull(); expect(p.png).toBeNull();
    expect(p.artifact.version).toBe('v9');
    expect(JSON.stringify(p)).not.toContain('SECRET');
  });
});

describe('download strategies', () => {
  const detail = { viewerOrigin: `https://${ID1}.frame.claudeusercontent.com`, ver: 'v1', assetToken: 'TOK' };
  it('token-query is first, on the frame host', () => {
    const s = A.buildArtifactDownloadStrategies({ detail, id: ID1, file: { path: 'dir/a b.html', src: { ver: 'v0' } } });
    expect(s[0].name).toBe('token-query/detail-ver');
    expect(s[0].url).toBe(`https://${ID1}.frame.claudeusercontent.com/_f/v1/dir/a%20b.html?__frame_t=TOK`);
    expect(s.map((x) => x.name)).toContain('token-query/src-ver');
    expect(s.some((x) => x.name.startsWith('token-header-bearer'))).toBe(true);
  });
  it('single page tries root and index.html', () => {
    const s = A.buildArtifactDownloadStrategies({ detail, id: ID1, file: null });
    expect(s.filter((x) => x.name.startsWith('token-query/detail-ver')).map((x) => x.name)).toEqual(['token-query/detail-ver@root', 'token-query/detail-ver@index.html']);
  });
  it('a foreign viewerOrigin is never used (token must not leave the frame domain)', () => {
    const s = A.buildArtifactDownloadStrategies({ detail: { ...detail, viewerOrigin: 'https://evil.example.com' }, id: ID1, file: { path: 'a' } });
    expect(s.every((x) => A.artifactIsFrameHost(x.url))).toBe(true);
    expect(A.artifactIsFrameHost('https://evil.example.com/x')).toBe(false);
    expect(A.artifactIsFrameHost('http://a.frame.claudeusercontent.com/x')).toBe(false);
  });
});

describe('db capture session', () => {
  it('finishes idle after the last call, merges docs, splits comments', () => {
    let t = 0;
    const s = A.createArtifactDbSession({ now: () => t, idleMs: 5000, firstCallMs: 20000, maxMs: 45000 });
    expect(s.status().done).toBe(false);
    s.add({ collection: 'items', status: 200, docs: [{ id: 'a', version: 1, data: {} }] });
    t = 1000;
    s.add({ collection: 'items', status: 200, docs: [{ id: 'a', version: 2, data: { n: 1 } }, { id: 'b', version: 1 }] });
    s.add({ collection: 'comments', status: 200, docs: [{ id: 'c1' }] });
    t = 3000; expect(s.status().done).toBe(false);
    t = 6001; expect(s.status()).toEqual({ done: true, reason: 'idle' });
    const r = s.result();
    expect(r.db.items).toHaveLength(2);
    expect(r.db.items.find((d) => d.id === 'a').version).toBe(2);
    expect(r.comments).toEqual([{ id: 'c1' }]);
    expect(r.db.comments).toBeUndefined();
    expect(r.stats).toEqual({ calls: 3, failed_calls: 0, collections: 2, docs: 3 });
  });
  it('no calls -> no_calls at firstCallMs; timeout at maxMs', () => {
    let t = 0;
    const s = A.createArtifactDbSession({ now: () => t });
    t = 20000; expect(s.status()).toEqual({ done: true, reason: 'no_calls' });
    let t2 = 0;
    const s2 = A.createArtifactDbSession({ now: () => t2 });
    s2.add({ collection: 'x', status: 200, docs: [] });
    t2 = 44000; s2.add({ collection: 'x', status: 200, docs: [] });
    t2 = 45000; expect(s2.status().reason).toBe('timeout');
  });
  it('failed calls are counted, not stored', () => {
    const s = A.createArtifactDbSession({ now: () => 0 });
    s.add({ collection: 'x', status: 403, docs: [{ id: 'z' }] });
    expect(s.result().db).toBeNull();
    expect(s.result().stats.failed_calls).toBe(1);
  });
});

describe('tab url', () => {
  it('only claude.ai/artifact urls, relative allowed', () => {
    expect(A.artifactTabUrl('/artifact/abc')).toBe('https://claude.ai/artifact/abc');
    expect(A.artifactTabUrl('https://evil.example/artifact/abc')).toBe(null);
    expect(A.artifactTabUrl('https://claude.ai/other')).toBe(null);
  });
});

// ---------- collector end-to-end with a stubbed network ----------

const bytesOf = (s) => new TextEncoder().encode(s);
const HTML = bytesOf('<html>synthetic page</html>');
const SKILL = bytesOf('# skill');
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

function mkResp(status, body, ct) {
  const isBytes = body instanceof Uint8Array;
  return {
    status, ok: status >= 200 && status < 300,
    headers: { get: (h) => (h.toLowerCase() === 'content-type' ? ct || null : null) },
    json: async () => body, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    _isBytes: isBytes,
  };
}

function setupNetwork({ workingStrategy = 'token-query', failTyped = false } = {}) {
  const calls = [];
  const ingests = [];
  const D1 = { ver: 'v1', viewerOrigin: `https://${ID1}.frame.claudeusercontent.com`, assetToken: 'ASSETTOKEN', syncToken: 'SYNCTOKEN',
    files: [{ path: 'index.html', size: HTML.length, contentType: 'text/html', sha256: sha(HTML), src: { slug: 's', ver: 'v1' } }] };
  const D2 = { ver: 'v2', viewerOrigin: `https://${ID2}.frame.claudeusercontent.com`, assetToken: 'ASSETTOKEN2',
    files: [
      { path: 'index.html', size: HTML.length, contentType: 'text/html', sha256: sha(HTML) },
      { path: 'SKILL.md', size: SKILL.length, contentType: 'text/markdown', sha256: sha(SKILL) },
      { path: 'artifact-type/app.js', size: 8_000_000, contentType: 'text/javascript', sha256: 'ff' },
    ] };
  const list = { artifacts: [
    { id: ID1, kind: 'page', open_url: `/artifact/one`, title: 'Synthetic One', created_at: 'c1', updated_at: 'u1', source: 'chat', thumbnail_url: `https://${ID1}.frame.claudeusercontent.com/_f/v1/_thumb.img?__frame_t=THUMBTOKEN` },
    { id: ID2, kind: 'page', open_url: `/artifact/two`, title: 'Synthetic Two', created_at: 'c2', updated_at: 'u2', source: 'chat', thumbnail_url: null },
  ], hosted_total: 2 };
  global.fetch = vi.fn(async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.startsWith('https://claude.ai/api/frame/artifacts?')) { expect(init.headers).toEqual({ 'x-frame-cp': 'go' }); expect(init.credentials).toBe('include'); return mkResp(200, list); }
    if (u.startsWith(`https://claude.ai/api/frame/${ID1}?`)) return mkResp(200, D1);
    if (u.startsWith(`https://claude.ai/api/frame/${ID2}?`)) return mkResp(200, D2);
    if (u.includes('_thumb.img')) return mkResp(200, PNG, 'image/png');
    if (u.includes('.frame.claudeusercontent.com/_f/')) {
      const ok = workingStrategy === 'token-query' && u.includes('__frame_t=');
      if (!ok) return mkResp(404, {}, 'application/json');
      if (u.includes('index.html')) return mkResp(200, HTML, 'text/html');
      if (u.includes('SKILL.md')) return mkResp(200, SKILL, 'text/markdown');
      return mkResp(404, {}, null);
    }
    if (u.endsWith('/api/artifacts/state')) return mkResp(200, { artifacts: {} });
    if (u.endsWith('/api/artifacts/ingest')) { ingests.push(JSON.parse(init.body)); return mkResp(200, { success: true }); }
    return mkResp(500, {});
  });
  return { calls, ingests };
}

function mkTabs(onCreate) {
  const closed = [];
  return {
    closed,
    create: vi.fn(async () => { setTimeout(onCreate, 0); return { id: 7 }; }),
    remove: vi.fn(async (id) => { closed.push(id); }),
  };
}
const fastGate = () => A.createArtifactGate({ spacing: { list: 0, detail: 0, file: 0, thumb: 0, tab: 0 }, sleep: async () => {} });
const QUICK = { idleMs: 5, firstCallMs: 10, maxMs: 50 };
const scry = { url: 'http://scry.test', token: 'SERVICETOKEN-0123456789' };

describe('collector run', () => {
  let origFetch;
  beforeEach(() => { origFetch = global.fetch; });
  afterEach(() => { global.fetch = origFetch; vi.restoreAllMocks(); });

  it('captures a plain page and a typed artifact; vendor files never uploaded; tab closed', async () => {
    const net = setupNetwork();
    const tabs = mkTabs(() => {
      A.handleArtifactDbMessage({ collection: 'items', status: 200, docs: [{ id: 'r1', data: { x: 1 }, version: 1 }] }, { tab: { id: 7 } });
      A.handleArtifactDbMessage({ collection: 'comments', status: 200, docs: [{ id: 'c1' }] }, { tab: { id: 7 } });
    });
    const sum = await A.runArtifactCollector({
      gate: fastGate(), orgId: 'org', scry, tabs, sleep: async () => { await new Promise((r) => setTimeout(r, 5)); },
      session: { idleMs: 15, firstCallMs: 1000, maxMs: 5000 }, pngTried: {},
    });
    expect(sum).toMatchObject({ listed: 2, captured: 2, failed: 0, aborted: null });
    expect(net.ingests).toHaveLength(2);
    const plain = net.ingests.find((p) => p.artifact.id === ID1);
    expect(plain.artifact.type).toBe('html');
    expect(plain.files.map((f) => f.path)).toEqual(['index.html']);
    expect(plain.png).toMatchObject({ origin: 'thumbnail' });
    expect(plain.db).toBeNull();
    const typed = net.ingests.find((p) => p.artifact.id === ID2);
    expect(typed.artifact.type).toBe('typed');
    expect(typed.files.map((f) => f.path).sort()).toEqual(['SKILL.md', 'index.html']);
    expect(typed.manifest.map((m) => m.path)).toContain('artifact-type/app.js');
    expect(typed.db.items).toHaveLength(1);
    expect(typed.comments).toEqual([{ id: 'c1' }]);
    expect(tabs.closed).toEqual([7]);
    expect(net.calls.some((c) => c.url.includes('artifact-type'))).toBe(false);
    // no token in any ingest body
    const all = JSON.stringify(net.ingests);
    for (const t of ['ASSETTOKEN', 'SYNCTOKEN', 'THUMBTOKEN', 'SERVICETOKEN']) expect(all).not.toContain(t);
    // every request that is not to Scry is spaced through the gate; ingest used the service token
    const ing = net.calls.find((c) => c.url.endsWith('/api/artifacts/ingest'));
    expect(ing.init.headers.Authorization).toBe(`Bearer ${scry.token}`);
  });

  it('skips unchanged artifacts after a manifest check, and tombstoned ones', async () => {
    const net = setupNetwork();
    const stateResp = { artifacts: {
      [ID1]: { updated_at: 'u1', version: 'v1', files: { 'index.html': sha(HTML) }, has_png: true, tombstoned: false },
      [ID2]: { updated_at: 'u2', version: 'v2', files: {}, has_png: true, tombstoned: true },
    } };
    const f = global.fetch;
    global.fetch = vi.fn(async (u, i) => (String(u).endsWith('/api/artifacts/state') ? mkResp(200, stateResp) : f(u, i)));
    const sum = await A.runArtifactCollector({ gate: fastGate(), orgId: 'org', scry, tabs: mkTabs(() => {}), session: QUICK, sleep: async () => { await new Promise((r) => setTimeout(r, 2)); }, pngTried: {} });
    expect(sum).toMatchObject({ listed: 2, captured: 0, skipped: 2, failed: 0 });
    expect(net.ingests).toHaveLength(0);
  });

  it('sha mismatch: file not sent, reported', async () => {
    const net = setupNetwork();
    const f = global.fetch;
    global.fetch = vi.fn(async (u, i) => (String(u).includes('/_f/v1/index.html') && String(u).includes(ID1) ? mkResp(200, bytesOf('tampered'), 'text/html') : f(u, i)));
    await A.runArtifactCollector({ gate: fastGate(), orgId: 'org', scry, tabs: mkTabs(() => {}), session: QUICK, sleep: async () => { await new Promise((r) => setTimeout(r, 2)); }, pngTried: {} });
    const plain = net.ingests.find((p) => p.artifact.id === ID1);
    expect(plain.files).toEqual([]);
    expect(plain.fetch_report.sha_mismatch).toEqual(['index.html']);
  });

  it('a page with files:[] is fetched as a single document', async () => {
    const net = setupNetwork();
    const f = global.fetch;
    global.fetch = vi.fn(async (u, i) => {
      const s = String(u);
      if (s.startsWith(`https://claude.ai/api/frame/${ID1}?`)) return mkResp(200, { ver: 'v1', viewerOrigin: `https://${ID1}.frame.claudeusercontent.com`, assetToken: 'T', files: [] });
      return f(u, i);
    });
    await A.runArtifactCollector({ gate: fastGate(), orgId: 'org', scry, tabs: mkTabs(() => {}), session: QUICK, sleep: async () => { await new Promise((r) => setTimeout(r, 2)); }, pngTried: {} });
    const plain = net.ingests.find((p) => p.artifact.id === ID1);
    expect(plain.files.map((x) => x.path)).toEqual(['index.html']);
    expect(plain.manifest.map((m) => m.path)).toEqual(['index.html']);
    expect(plain.artifact.type).toBe('html');
  });

  it('two 429s abort the run (no spinning)', async () => {
    setupNetwork();
    global.fetch = vi.fn(async () => mkResp(429, {}));
    const gate = A.createArtifactGate({ spacing: { list: 0, detail: 0, file: 0, thumb: 0, tab: 0 }, sleep: async () => {}, schedule: [0] });
    const sum = await A.runArtifactCollector({ gate, orgId: 'org', scry, tabs: mkTabs(() => {}), session: QUICK, sleep: async () => { await new Promise((r) => setTimeout(r, 2)); }, pngTried: {} });
    expect(sum.aborted).toBe('rate_limited');
    expect(global.fetch.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('logs carry no tokens or titles', async () => {
    setupNetwork();
    const logs = [];
    for (const m of ['log', 'warn', 'error']) vi.spyOn(console, m).mockImplementation((...a) => logs.push(a.join(' ')));
    await A.runArtifactCollector({ gate: fastGate(), orgId: 'org', scry, tabs: mkTabs(() => {}), session: QUICK, sleep: async () => { await new Promise((r) => setTimeout(r, 2)); }, pngTried: {} });
    const all = logs.join('\n');
    for (const t of ['ASSETTOKEN', 'THUMBTOKEN', 'SERVICETOKEN', 'Synthetic']) expect(all).not.toContain(t);
  });
});

describe('diagnostics', () => {
  let origFetch;
  beforeEach(() => { origFetch = global.fetch; });
  afterEach(() => { global.fetch = origFetch; });

  it('reports the working strategy without pushing to Scry or leaking tokens/titles', async () => {
    const net = setupNetwork();
    const tabs = mkTabs(() => { A.handleArtifactDbMessage({ collection: 'items', status: 200, docs: [{ id: 'r' }] }, { tab: { id: 7 } }); });
    const d = await A.runArtifactDiagnostics({ gate: fastGate(), orgId: 'org', tabs, sleep: async () => { await new Promise((r) => setTimeout(r, 5)); }, session: { idleMs: 15, firstCallMs: 1000, maxMs: 5000 } });
    expect(d.working_strategies).toContain('token-query/detail-ver');
    expect(d.working_strategies.some((n) => n.startsWith('token-header'))).toBe(false);
    expect(d.thumbnail_ok).toBe(true);
    expect(d.db_ok).toBe(true);
    expect(net.calls.some((c) => c.url.includes('/api/artifacts/'))).toBe(false);
    expect(tabs.closed).toEqual([7]);
    const text = A.formatArtifactDiagnostics(d);
    expect(text).toContain('WORKING STRATEGIES: token-query/detail-ver');
    for (const t of ['ASSETTOKEN', 'THUMBTOKEN', 'Synthetic', 'SYNCTOKEN']) expect(text).not.toContain(t);
    expect(text).toContain('DB TAB CAPTURE');
  });

  it('says NONE when no strategy works', async () => {
    setupNetwork({ workingStrategy: 'none' });
    const d = await A.runArtifactDiagnostics({ gate: fastGate(), orgId: 'org', tabs: mkTabs(() => {}), sleep: async () => {}, session: { idleMs: 1, firstCallMs: 1, maxMs: 5 } });
    expect(d.working_strategies).toEqual([]);
    expect(A.formatArtifactDiagnostics(d)).toContain('WORKING STRATEGIES: NONE');
  });
});

describe('content scripts', () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  function mkWindow() {
    const listeners = [];
    const posted = [];
    const win = {
      location: { origin: 'https://claude.ai', href: 'https://claude.ai/artifact/x' },
      addEventListener: (t, fn) => listeners.push(fn),
      postMessage: (m) => { posted.push(m); setTimeout(() => listeners.forEach((l) => l({ source: win, data: m })), 0); },
      crypto: nodeCrypto.webcrypto,
    };
    win.window = win;
    return { win, posted };
  }
  it('main world wraps fetch and records collection + docs, never the token', async () => {
    const { win, posted } = mkWindow();
    win.fetch = async () => ({ ok: true, status: 200, clone() { return { json: async () => ({ docs: [{ id: 'd1' }], nextCursor: null }) }; } });
    vm.runInNewContext(fs.readFileSync('chrome/artifact_capture_main.js', 'utf8'), { ...win, window: win, crypto: nodeCrypto.webcrypto, URL, console });
    await win.fetch('https://claude.ai/api/frame/db/abc/call?org=o', { method: 'POST', body: JSON.stringify({ token: 'SECRETTOKEN', verb: 'query', collection: 'items', limit: 10 }) });
    await new Promise((r) => setTimeout(r, 10));
    const db = posted.find((m) => m.type === 'db');
    expect(db).toMatchObject({ collection: 'items', status: 200, docs: [{ id: 'd1' }] });
    expect(JSON.stringify(posted)).not.toContain('SECRETTOKEN');
    // unrelated fetches are untouched
    const before = posted.length;
    await win.fetch('https://claude.ai/api/other', { method: 'POST', body: '{}' });
    await new Promise((r) => setTimeout(r, 10));
    expect(posted.length).toBe(before);
  });
  it('relay forwards only nonce-matching db messages', async () => {
    const { win, posted } = mkWindow();
    const sent = [];
    const chromeStub = { runtime: { sendMessage: (m) => { sent.push(m); return Promise.resolve(); } } };
    vm.runInNewContext(fs.readFileSync('chrome/artifact_capture_relay.js', 'utf8'), { ...win, window: win, chrome: chromeStub });
    const fire = (data) => win.postMessage(data);
    fire({ source: 'scry-artifact-capture', type: 'hello', nonce: 'N1' });
    fire({ source: 'scry-artifact-capture', type: 'db', nonce: 'WRONG', collection: 'x', status: 200, docs: [] });
    fire({ source: 'scry-artifact-capture', type: 'db', nonce: 'N1', collection: 'items', status: 200, docs: [{ id: 'a' }], nextCursor: null });
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ action: 'artifactDbCapture', collection: 'items' });
  });
});

describe('review fixes', () => {
  it('sha matching works without Buffer (MV3 service worker), hex and base64', async () => {
    const bytes = new Uint8Array([9, 8, 7]);
    const hex = sha(bytes);
    const b64 = Buffer.from(hex, 'hex').toString('base64');
    const saved = globalThis.Buffer;
    try {
      globalThis.Buffer = undefined;
      expect(A.artifactShaMatches(hex, hex)).toBe(true);
      expect(A.artifactShaMatches(b64, hex)).toBe(true);
      expect(A.artifactShaMatches('AAAA', hex)).toBe(false);
      expect(A.artifactShaMatches('!!notb64!!', hex)).toBe(false);
      expect(A.artifactBytesToBase64(bytes)).toBe(saved.from(bytes).toString('base64'));
    } finally { globalThis.Buffer = saved; }
  });

  it('every token-carrying download and the thumbnail fetch use redirect:error', async () => {
    const s = A.buildArtifactDownloadStrategies({ detail: { ver: 'v', assetToken: 'T' }, id: ID1, file: { path: 'a', src: { ver: 'w' } } });
    expect(s.length).toBeGreaterThan(3);
    expect(s.every((x) => x.init.redirect === 'error')).toBe(true);
    const calls = [];
    const orig = global.fetch;
    global.fetch = vi.fn(async (u, init) => { calls.push(init); return mkResp(200, PNG, 'image/png'); });
    await A.fetchArtifactThumbnail(fastGate(), `https://${ID1}.frame.claudeusercontent.com/_thumb.img?__frame_t=X`);
    global.fetch = orig;
    expect(calls[0].redirect).toBe('error');
  });

  it('capture scripts are registered only around the tab and always unregistered', async () => {
    const order = [];
    const scripting = {
      registerContentScripts: vi.fn(async (l) => { order.push('register'); expect(l.map((x) => x.world || 'ISOLATED')).toEqual(['MAIN', 'ISOLATED']); expect(l[0].persistAcrossSessions).toBe(false); }),
      unregisterContentScripts: vi.fn(async () => { order.push('unregister'); }),
    };
    const tabs = { create: vi.fn(async () => { order.push('create'); return { id: 3 }; }), remove: vi.fn(async () => { order.push('remove'); }) };
    await A.captureArtifactDbViaTab('/artifact/x', { tabs, scripting, sleep: async () => {}, session: { firstCallMs: 0 }, pollMs: 0 });
    expect(order).toEqual(['unregister', 'register', 'create', 'remove', 'unregister']);
    // tab creation fails -> still unregistered
    order.length = 0;
    tabs.create = vi.fn(async () => { throw new Error('boom'); });
    await expect(A.captureArtifactDbViaTab('/artifact/x', { tabs, scripting, sleep: async () => {} })).rejects.toThrow();
    expect(order.at(-1)).toBe('unregister');
    // bad url: nothing registered
    order.length = 0;
    await A.captureArtifactDbViaTab('https://evil.example/x', { tabs, scripting });
    expect(order).toEqual([]);
  });

  it('manifest has no static artifact content scripts', () => {
    const m = JSON.parse(require('node:fs').readFileSync('chrome/manifest.json', 'utf8'));
    expect(JSON.stringify(m.content_scripts)).not.toContain('artifact_capture');
    expect(m.permissions).toContain('scripting');
  });

  describe('runArtifactsJob gating', () => {
    let store; let settings; let alarms;
    beforeEach(() => {
      store = {}; settings = { url: 'http://s', token: 'tok' }; alarms = [];
      globalThis.chrome = {
        scripting: scriptingStub,
        storage: { local: {
          get: (keys, cb) => cb(Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => k in store).map((k) => [k, store[k]]))),
          set: (o, cb) => { Object.assign(store, JSON.parse(JSON.stringify(o))); cb && cb(); },
        } },
        alarms: { create: (name, info) => alarms.push({ name, info }) },
        runtime: { getPlatformInfo: () => {} },
      };
      globalThis.loadScrySettings = async () => settings;
      globalThis.readOrgIdFromStorage = async () => null;
      globalThis.detectClaudeOrgId = async () => { throw new Error('stop'); };
    });
    afterEach(() => { delete globalThis.loadScrySettings; delete globalThis.readOrgIdFromStorage; delete globalThis.detectClaudeOrgId; globalThis.chrome = { scripting: scriptingStub }; });

    it('scheduled run with the flag off does nothing', async () => {
      expect(await A.runArtifactsJob('collect', { scheduled: true })).toEqual({ started: false, reason: 'disabled' });
      expect(store.artifactsRun).toBeUndefined();
    });
    it('claude disabled', async () => {
      settings = { ...settings, claudeEnabled: false, artifactsEnabled: true };
      expect((await A.runArtifactsJob('collect')).reason).toBe('claude-disabled');
    });
    it('already running', async () => {
      store.artifactsRun = { state: 'running', startedAt: Date.now() };
      expect((await A.runArtifactsJob('collect')).reason).toBe('already-running');
    });
    it('collect needs a configured Scry', async () => {
      settings = {};
      expect((await A.runArtifactsJob('collect')).reason).toBe('scry-not-configured');
    });
    it('deferral uses a separate one-shot alarm, never the daily one', async () => {
      settings = { ...settings, artifactsEnabled: true };
      store.continuousSync = { running: Date.now() - 1000 };
      const r = await A.runArtifactsJob('collect', { scheduled: true });
      expect(r.reason).toBe('continuous-sync-running');
      expect(alarms).toEqual([{ name: A.ARTIFACT_RETRY_ALARM, info: { delayInMinutes: 10 } }]);
      expect(alarms.some((a) => a.name === A.ARTIFACT_ALARM)).toBe(false);
    });
  });
});
