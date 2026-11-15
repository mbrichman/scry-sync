// Artifact collector — captures the owner's claude.ai artifacts (the
// /api/frame/* surface) and pushes them to Scry (/api/artifacts/*).
//
// Layout: PURE helpers first (planner, manifest/payload builders, download
// strategies, db-capture session, text formatting) — all vitest-covered — then
// the IMPURE collector (gated claude.ai fetches, the background-tab db
// capture, the Scry POST, the job runner with its storage-backed status).
//
// PRIVACY: nothing here logs artifact titles, contents, file bytes or tokens
// (asset/frame/consent/sync tokens). Logs and the status/diagnostic text carry
// ids, counts, HTTP statuses, content types and byte sizes only.

const ARTIFACT_VENDOR_PREFIX = 'artifact-type/';
const ARTIFACT_MAX_FILE_BYTES = 25 * 1024 * 1024;
const ARTIFACT_LIST_LIMIT = 48;
const ARTIFACT_LIST_MAX_PAGES = 20;
const ARTIFACT_PNG_RETRY_MS = 7 * 24 * 3600 * 1000;
const ARTIFACT_ALARM = 'scry-artifacts';
const ARTIFACT_RETRY_ALARM = 'scry-artifacts-retry';   // one-shot deferral; never touches the daily alarm
const ARTIFACT_ALARM_DELAY_MIN = 45;      // off the 15-min / daily sync wakes
const ARTIFACT_ALARM_PERIOD_MIN = 1440;
const ARTIFACT_RUN_KEY = 'artifactsRun';  // chrome.storage.local: status the options page renders
const ARTIFACT_PNG_TRIED_KEY = 'artifactsPngTried';
const ARTIFACT_RUN_STALE_MS = 2 * 3600 * 1000;
const ARTIFACT_DB_FIRST_CALL_MS = 20000;
const ARTIFACT_DB_IDLE_MS = 5000;
const ARTIFACT_DB_MAX_MS = 45000;
const ARTIFACT_GATE_SPACING_MS = { list: 1000, detail: 1000, file: 1000, thumb: 1000, tab: 1000 };

function _artRequire(name) {
  return (typeof module !== 'undefined' && module.exports) ? require(name) : null;
}

// ===================== PURE: paths, types, manifest =====================

function artifactIsVendorPath(path) {
  return typeof path === 'string' && path.startsWith(ARTIFACT_VENDOR_PREFIX);
}

function artifactBaseContentType(ct) {
  return String(ct || '').split(';')[0].trim().toLowerCase();
}

// Manifest as Scry wants it: every file the vendor lists, vendor app included.
function buildArtifactManifest(files) {
  return (Array.isArray(files) ? files : [])
    .filter((f) => f && typeof f.path === 'string')
    .map((f) => ({
      path: f.path, size: Number(f.size) || 0,
      content_type: f.contentType || f.content_type || '', sha256: f.sha256 || '',
    }));
}

// Split a detail's files into what we upload, what is the vendor app (never
// uploaded) and what is over the size cap (recorded, not uploaded).
function selectArtifactFiles(files, maxBytes = ARTIFACT_MAX_FILE_BYTES) {
  const upload = [];
  const oversize = [];
  let vendor = 0;
  for (const f of Array.isArray(files) ? files : []) {
    if (!f || typeof f.path !== 'string') continue;
    if (artifactIsVendorPath(f.path)) { vendor++; continue; }
    if ((Number(f.size) || 0) > maxBytes) { oversize.push({ path: f.path, size: Number(f.size) || 0 }); continue; }
    upload.push(f);
  }
  return { upload, vendor, oversize };
}

function artifactMainFile(files) {
  const own = (Array.isArray(files) ? files : []).filter((f) => f && !artifactIsVendorPath(f.path));
  return own.find((f) => f.path === 'index.html') || own[0] || null;
}

// "typed" when the manifest carries the vendor app; else the main document's
// content type: html | svg | markdown | code. A snippet is stored as its
// content type (e.g. "text/x-python"), falling back to "code".
function inferArtifactType({ kind, manifest, mainContentType } = {}) {
  if ((manifest || []).some((f) => artifactIsVendorPath(f.path))) return 'typed';
  const ct = artifactBaseContentType(mainContentType);
  if (kind === 'snippet') return ct || 'code';
  if (ct === 'text/html' || ct === 'application/xhtml+xml') return 'html';
  if (ct === 'image/svg+xml') return 'svg';
  if (ct === 'text/markdown' || ct === 'text/x-markdown') return 'markdown';
  return 'code';
}

// ===================== PURE: list, state, planner =====================

function extractArtifactCursor(resp) {
  if (!resp || typeof resp !== 'object') return null;
  for (const k of ['next_cursor', 'nextCursor', 'cursor', 'next', 'next_page_token']) {
    const v = resp[k];
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

function normalizeArtifactList(resp) {
  const arr = resp && Array.isArray(resp.artifacts) ? resp.artifacts : [];
  return arr.filter((a) => a && typeof a.id === 'string' && a.id);
}

function artifactOwnFileShas(files) {
  const out = {};
  for (const f of Array.isArray(files) ? files : []) {
    if (f && typeof f.path === 'string' && !artifactIsVendorPath(f.path) && f.sha256) out[f.path] = f.sha256;
  }
  return out;
}

// True when the detail's own (non-vendor) file shas differ from Scry's stored
// ones. Vendor-app churn alone never counts: those bytes are not stored.
function artifactManifestChanged(detailFiles, stateFiles) {
  const now = artifactOwnFileShas(detailFiles);
  const had = {};
  for (const [p, s] of Object.entries(stateFiles || {})) if (!artifactIsVendorPath(p)) had[p] = s;
  const a = Object.keys(now);
  if (a.length !== Object.keys(had).length) return true;
  return a.some((p) => had[p] !== now[p]);
}

function _artNewer(a, b) {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return Boolean(a) && a !== b;
  return ta > tb;
}

// Decide one artifact. `detail` is optional (fetched lazily by the collector
// for artifacts the list alone calls unchanged). Returns {capture, reason}.
function planArtifact(item, entry, { detail = null, pngTried = null, now = Date.now() } = {}) {
  if (entry && entry.tombstoned) return { capture: false, reason: 'tombstoned' };
  if (!entry) return { capture: true, reason: 'new' };
  if (_artNewer(item.updated_at, entry.updated_at)) return { capture: true, reason: 'updated' };
  if (detail) {
    if (artifactManifestChanged(detail.files, entry.files)) return { capture: true, reason: 'manifest_changed' };
    if (detail.ver != null && entry.version != null && String(detail.ver) !== String(entry.version)) {
      return { capture: true, reason: 'version_changed' };
    }
  }
  if (!entry.has_png && item.thumbnail_url) {
    const tried = pngTried && pngTried[item.id];
    if (!(typeof tried === 'number' && now - tried < ARTIFACT_PNG_RETRY_MS)) return { capture: true, reason: 'missing_png' };
  }
  return { capture: false, reason: 'unchanged' };
}

// Pass 1 over the whole list (no details). `needsDetail` lists the ids the
// list alone calls unchanged: the collector fetches their detail and re-plans
// each with planArtifact to catch a manifest sha change.
function planArtifactCaptures(list, state, opts = {}) {
  const known = (state && state.artifacts) || {};
  const capture = [];
  const skip = [];
  const needsDetail = [];
  for (const item of list || []) {
    const d = planArtifact(item, known[item.id], opts);
    if (d.capture) capture.push({ id: item.id, reason: d.reason });
    else if (d.reason === 'unchanged') { skip.push({ id: item.id, reason: d.reason }); needsDetail.push(item.id); }
    else skip.push({ id: item.id, reason: d.reason });
  }
  return { capture, skip, needsDetail };
}

// ===================== PURE: bytes, hashing, payload =====================

function artifactBytesToBase64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function artifactSha256Hex(bytes) {
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Does `expected` (the detail's sha256, hex or base64) match the computed hex?
function artifactShaMatches(expected, hex) {
  if (!expected) return true;
  const e = String(expected).trim();
  if (e.toLowerCase() === hex) return true;
  try {
    // No Node APIs: the MV3 service worker has no Buffer.
    const bin = atob(e);
    let raw = '';
    for (let i = 0; i < bin.length; i++) raw += bin.charCodeAt(i).toString(16).padStart(2, '0');
    return raw === hex;
  } catch { return false; }
}

// Verify + encode one downloaded file. Mismatch -> {ok:false, reason:'sha_mismatch'}: never sent.
async function prepareArtifactFile(file, bytes, contentType) {
  const hex = await artifactSha256Hex(bytes);
  if (!artifactShaMatches(file.sha256, hex)) return { ok: false, reason: 'sha_mismatch', path: file.path };
  return {
    ok: true,
    entry: {
      path: file.path,
      content_type: file.contentType || file.content_type || contentType || '',
      sha256: hex, data_b64: artifactBytesToBase64(bytes),
    },
  };
}

function buildArtifactPayload({ item, detail, manifest, type, files, db, comments, png, fetchReport }) {
  const dbKeys = db ? Object.keys(db) : [];
  return {
    artifact: {
      id: item.id, open_url: item.open_url || null, title: item.title || null,
      kind: item.kind || null, source: item.source || null, type,
      created_at: item.created_at || null, updated_at: item.updated_at || null,
      version: detail && detail.ver != null ? detail.ver : null,
    },
    manifest,
    files,
    db: dbKeys.length ? db : null,
    comments: comments && comments.length ? comments : null,
    png: png || null,
    fetch_report: fetchReport || null,
  };
}

// ===================== PURE: download strategies =====================

function artifactViewerOrigin(detail, id) {
  const fallback = `https://${id}.frame.claudeusercontent.com`;
  try {
    const u = new URL(detail && detail.viewerOrigin);
    if (u.protocol === 'https:' && u.hostname.endsWith('.claudeusercontent.com')) return u.origin;
  } catch { /* use fallback */ }
  return fallback;
}

function artifactIsFrameHost(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname.endsWith('.claudeusercontent.com');
  } catch { return false; }
}

function _encPath(p) { return p.split('/').map(encodeURIComponent).join('/'); }

// Ordered candidates for fetching one page file (or, with file=null, the
// single-document page of an artifact with files:[]). The download method was
// UNVERIFIED when this was written; the diagnostics button reports which won.
function buildArtifactDownloadStrategies({ detail, id, file }) {
  const origin = artifactViewerOrigin(detail, id);
  const token = detail && detail.assetToken ? String(detail.assetToken) : '';
  const vers = [];
  const detailVer = detail && detail.ver != null ? String(detail.ver) : null;
  const srcVer = file && file.src && file.src.ver != null ? String(file.src.ver) : null;
  if (detailVer) vers.push(['detail-ver', detailVer]);
  if (srcVer && srcVer !== detailVer) vers.push(['src-ver', srcVer]);
  const paths = file ? [['', _encPath(file.path)]] : [['@root', ''], ['@index.html', 'index.html']];
  const out = [];
  const add = (name, url, init) => out.push({ name, url, init: { ...init, redirect: 'error' } });
  for (const [vname, ver] of vers) {
    for (const [pname, p] of paths) {
      const base = `${origin}/_f/${encodeURIComponent(ver)}/${p}`;
      const tq = `${base}${base.includes('?') ? '&' : '?'}__frame_t=${encodeURIComponent(token)}`;
      add(`token-query/${vname}${pname}`, tq, { credentials: 'omit' });
      if (vname === 'detail-ver') {
        add(`token-query+cookies/${vname}${pname}`, tq, { credentials: 'include' });
        add(`token-header-bearer/${vname}${pname}`, base, { credentials: 'omit', headers: { Authorization: `Bearer ${token}` } });
        add(`token-header-x-frame-t/${vname}${pname}`, base, { credentials: 'omit', headers: { 'x-frame-t': token } });
      }
    }
  }
  return out;
}

// ===================== PURE: db capture session =====================

// Accumulates the parent page's /api/frame/db/*/call responses for one
// background tab. Finishes ARTIFACT_DB_IDLE_MS after the last call (once any
// call was seen), when nothing arrives within firstCallMs, or at maxMs.
function createArtifactDbSession(opts = {}) {
  const now = opts.now || Date.now;
  const firstCallMs = opts.firstCallMs != null ? opts.firstCallMs : ARTIFACT_DB_FIRST_CALL_MS;
  const idleMs = opts.idleMs != null ? opts.idleMs : ARTIFACT_DB_IDLE_MS;
  const maxMs = opts.maxMs != null ? opts.maxMs : ARTIFACT_DB_MAX_MS;
  const t0 = now();
  let last = null;
  let calls = 0;
  let failed = 0;
  const cols = new Map();   // collection -> Map(docId -> doc)

  function add(msg) {
    if (!msg || typeof msg.collection !== 'string') return;
    last = now();
    calls++;
    if (msg.status != null && !(msg.status >= 200 && msg.status < 300)) { failed++; return; }
    if (!cols.has(msg.collection)) cols.set(msg.collection, new Map());
    const m = cols.get(msg.collection);
    for (const d of Array.isArray(msg.docs) ? msg.docs : []) {
      if (!d || d.id == null) continue;
      const prev = m.get(d.id);
      if (!prev || (Number(d.version) || 0) >= (Number(prev.version) || 0)) m.set(d.id, d);
    }
  }

  function status() {
    const t = now();
    if (t - t0 >= maxMs) return { done: true, reason: 'timeout' };
    if (last === null) return t - t0 >= firstCallMs ? { done: true, reason: 'no_calls' } : { done: false, reason: null };
    return t - last >= idleMs ? { done: true, reason: 'idle' } : { done: false, reason: null };
  }

  function result() {
    const db = {};
    let comments = null;
    let docs = 0;
    for (const [name, m] of cols) {
      const arr = Array.from(m.values());
      docs += arr.length;
      if (name === 'comments') comments = arr; else db[name] = arr;
    }
    return {
      db: Object.keys(db).length ? db : null,
      comments,
      stats: { calls, failed_calls: failed, collections: cols.size, docs },
    };
  }
  return { add, status, result };
}

// ===================== PURE: text for the UI =====================

function formatArtifactRunSummary(s) {
  if (!s) return '';
  const parts = [`listed ${s.listed || 0}`, `captured ${s.captured || 0}`, `skipped ${s.skipped || 0}`, `failed ${s.failed || 0}`];
  if (s.aborted) parts.push(`aborted: ${s.aborted}`);
  return parts.join(' | ');
}

// Diagnostics render. Only counts, statuses, content types, sizes, strategy names.
function formatArtifactDiagnostics(d) {
  if (!d) return '';
  const L = [];
  L.push(`Scry Sync artifacts test capture (client ${d.client_version || '?'})`);
  if (d.error) L.push(`ERROR: ${d.error}`);
  const l = d.list;
  if (l) {
    L.push(`LIST: status ${l.status}, items ${l.items}, hosted_total ${l.hosted_total ?? '-'}, pages ${l.pages}, cursor_seen ${l.cursor_seen}, truncated ${l.truncated}`);
    L.push(`  kinds ${JSON.stringify(l.kinds)} sources ${JSON.stringify(l.sources)} with_thumbnail ${l.with_thumbnail}`);
    L.push(`  response keys: ${(l.keys || []).join(',')}`);
  }
  for (const a of d.artifacts || []) {
    L.push(`ARTIFACT ${a.id} (${a.kind}/${a.type_guess})`);
    L.push(`  DETAIL: status ${a.detail.status}, files ${a.detail.files}, own ${a.detail.own}, vendor ${a.detail.vendor}, vendor_bytes ${a.detail.vendor_bytes}, assetToken ${a.detail.has_asset_token ? 'yes' : 'no'}, viewerOrigin ${a.detail.viewer_origin_ok ? 'ok' : 'bad'}`);
    for (const t of a.downloads || []) {
      L.push(`  DOWNLOAD ${t.strategy}: ${t.error ? 'error ' + t.error : 'status ' + t.status} ct ${t.content_type || '-'} bytes ${t.bytes ?? '-'} sha ${t.sha_match === null ? 'n/a' : t.sha_match ? 'match' : 'MISMATCH'}`);
    }
    if (a.downloads && a.downloads.length) {
      const w = a.downloads.filter((t) => t.working).map((t) => t.strategy);
      L.push(`  WORKING STRATEGIES: ${w.length ? w.join(', ') : 'NONE'}`);
    }
    if (a.thumbnail) L.push(`  THUMBNAIL: ${a.thumbnail.error ? 'error ' + a.thumbnail.error : 'status ' + a.thumbnail.status} ct ${a.thumbnail.content_type || '-'} bytes ${a.thumbnail.bytes ?? '-'}`);
    if (a.db) L.push(`  DB TAB CAPTURE: finished ${a.db.reason}, calls ${a.db.calls}, failed_calls ${a.db.failed_calls}, collections ${a.db.collections}, docs ${a.db.docs}, comments ${a.db.comments}, ms ${a.db.ms}`);
  }
  L.push(`SUMMARY: working download strategies = ${(d.working_strategies || []).join(', ') || 'NONE'}; thumbnail fetchable = ${d.thumbnail_ok === null ? 'untested' : d.thumbnail_ok}; tab db capture = ${d.db_ok === null ? 'untested (no typed artifact)' : d.db_ok}`);
  return L.join('\n');
}

// ===================== IMPURE: gate + gated requests =====================

class ArtifactAbort extends Error {
  constructor(reason) { super(`artifact run aborted: ${reason}`); this.name = 'ArtifactAbort'; this.reason = reason; }
}
class _ArtifactRateLimited extends Error {}

// One serialized, spaced, cooling-down gate for every claude.ai / frame request:
// the ChatGPT gate's machinery (>=1 s between starts, shared 429 cooldown with
// keepalive), with the 429 header dump replaced by a header-free line.
function createArtifactGate(opts = {}) {
  const make = typeof createChatGptGate === 'function' ? createChatGptGate : _artRequire('./chatgpt_adapter.js').createChatGptGate;
  return make({
    spacing: ARTIFACT_GATE_SPACING_MS,
    warn: () => console.warn('Scry artifacts: HTTP 429 from claude.ai, cooling down'),
    ...opts,
  });
}

// mode: 'json' | 'bytes' | 'status'. Returns {status, ok, contentType, json?, bytes?}.
// A 429 starts the shared cooldown and the request is retried once after it;
// a second 429 (or a second cooldown in the run) aborts the run.
async function artifactGatedFetch(gate, kind, url, init, mode) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await gate.run(kind, () => gate.fetchWith(kind, url, init, async (resp) => {
        if (resp.status === 429) {
          gate.report429(resp);
          if (gate.getState().cooldownsThisRun >= 2) throw new ArtifactAbort('rate_limited');
          throw new _ArtifactRateLimited();
        }
        const out = { status: resp.status, ok: resp.ok, contentType: (resp.headers && resp.headers.get('content-type')) || null };
        if (resp.ok && mode === 'json') { try { out.json = await resp.json(); } catch { out.json = null; } }
        else if (resp.ok && mode === 'bytes') out.bytes = new Uint8Array(await resp.arrayBuffer());
        return out;
      }));
    } catch (e) {
      if (e instanceof _ArtifactRateLimited) {
        if (attempt === 1) throw new ArtifactAbort('rate_limited');
        await gate.waitForCooldown();
        continue;
      }
      throw e;
    }
  }
  throw new ArtifactAbort('rate_limited');
}

// Verified contract: cookies plus EXACTLY one extra header.
const _FRAME_HEADERS = { 'x-frame-cp': 'go' };

async function fetchArtifactList(gate, orgId) {
  const items = [];
  const seen = new Set();
  const meta = { status: null, pages: 0, hosted_total: null, cursor_seen: false, truncated: false, keys: [] };
  let cursor = null;
  let offsetTried = false;
  for (let page = 0; page < ARTIFACT_LIST_MAX_PAGES; page++) {
    let url = `https://claude.ai/api/frame/artifacts?rel=mine&empty=exclude&limit=${ARTIFACT_LIST_LIMIT}&org=${encodeURIComponent(orgId)}&with_folder=true&sort=last_viewed`;
    if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
    else if (page > 0) url += `&offset=${items.length}`;
    const r = await artifactGatedFetch(gate, 'list', url, { credentials: 'include', headers: _FRAME_HEADERS }, 'json');
    meta.status = r.status;
    if (!r.ok || !r.json) { if (page === 0) throw new Error(`artifact list ${r.status}`); break; }
    meta.pages++;
    if (page === 0) { meta.keys = Object.keys(r.json); meta.hosted_total = r.json.hosted_total ?? null; }
    let added = 0;
    for (const a of normalizeArtifactList(r.json)) if (!seen.has(a.id)) { seen.add(a.id); items.push(a); added++; }
    const next = extractArtifactCursor(r.json);
    if (next && next !== cursor) { cursor = next; meta.cursor_seen = true; continue; }
    cursor = null;
    // No cursor: if the vendor says there are more, try ONE offset page defensively.
    if (typeof meta.hosted_total === 'number' && items.length < meta.hosted_total && !offsetTried && added > 0) { offsetTried = true; continue; }
    break;
  }
  meta.truncated = typeof meta.hosted_total === 'number' && items.length < meta.hosted_total;
  return { items, meta };
}

async function fetchArtifactDetail(gate, orgId, id) {
  const url = `https://claude.ai/api/frame/${encodeURIComponent(id)}?org=${encodeURIComponent(orgId)}&via=user_open&bk=reboot&actor=id&vt=1&rw=1`;
  const r = await artifactGatedFetch(gate, 'detail', url, { credentials: 'include', headers: _FRAME_HEADERS }, 'json');
  return { status: r.status, detail: r.ok ? r.json : null };
}

// Run ONE strategy; returns {strategy, status, content_type, bytes, sha_match, working, data?}.
async function attemptArtifactDownload(gate, strategy, expectSha) {
  const rec = { strategy: strategy.name, status: null, content_type: null, bytes: null, sha_match: null, working: false };
  try {
    if (!artifactIsFrameHost(strategy.url)) { rec.error = 'bad_host'; return rec; }
    const r = await artifactGatedFetch(gate, 'file', strategy.url, strategy.init, 'bytes');
    rec.status = r.status;
    rec.content_type = r.contentType;
    if (r.ok && r.bytes) {
      rec.bytes = r.bytes.length;
      if (expectSha) {
        const hex = await artifactSha256Hex(r.bytes);
        rec.sha_match = artifactShaMatches(expectSha, hex);
      }
      rec.working = r.bytes.length > 0 && rec.sha_match !== false;
      if (rec.working || rec.sha_match === false) rec._bytes = r.bytes;
    }
  } catch (e) {
    if (e instanceof ArtifactAbort) throw e;
    rec.error = (e && e.name) || 'error';
  }
  return rec;
}

// Try strategies in order (preferred name first) until one works.
async function downloadArtifactFile(gate, strategies, expectSha, preferred) {
  const ordered = preferred
    ? [...strategies.filter((s) => s.name.split('@')[0] === preferred), ...strategies.filter((s) => s.name.split('@')[0] !== preferred)]
    : strategies;
  const attempts = [];
  for (const s of ordered) {
    const rec = await attemptArtifactDownload(gate, s, expectSha);
    attempts.push(rec);
    if (rec.working) return { ok: true, bytes: rec._bytes, contentType: rec.content_type, strategy: rec.strategy, attempts };
  }
  return { ok: false, attempts };
}

async function fetchArtifactThumbnail(gate, url) {
  const rec = { status: null, content_type: null, bytes: null };
  if (!url || !artifactIsFrameHost(url)) { rec.error = 'no_thumbnail_url'; return rec; }
  try {
    const r = await artifactGatedFetch(gate, 'thumb', url, { credentials: 'omit', redirect: 'error' }, 'bytes');
    rec.status = r.status;
    rec.content_type = r.contentType;
    if (r.ok && r.bytes) { rec.bytes = r.bytes.length; rec._bytes = r.bytes; }
  } catch (e) {
    if (e instanceof ArtifactAbort) throw e;
    rec.error = (e && e.name) || 'error';
  }
  return rec;
}

// ===================== IMPURE: background-tab db capture =====================

const _artSessions = new Map();   // tabId -> db session

// Wired from background.js's runtime.onMessage: the isolated-world relay on
// claude.ai/artifact/* forwards each captured db call here.
function handleArtifactDbMessage(msg, sender) {
  const tabId = sender && sender.tab && sender.tab.id;
  const s = _artSessions.get(tabId);
  if (s) s.add(msg);
  return Boolean(s);
}

// The tab URL must be on claude.ai; open_url may be relative.
function artifactTabUrl(openUrl) {
  try {
    const u = new URL(openUrl, 'https://claude.ai');
    return u.origin === 'https://claude.ai' && u.pathname.startsWith('/artifact/') ? u.href : null;
  } catch { return null; }
}

const ARTIFACT_SCRIPT_IDS = ['scry-artifact-main', 'scry-artifact-relay'];

// The capture scripts exist ONLY while a collector tab is open: registered
// just before tabs.create, unregistered in `finally`. With the feature off (or
// between runs) nothing is injected into claude.ai/artifact/* pages.
async function registerArtifactCaptureScripts(scripting) {
  await unregisterArtifactCaptureScripts(scripting);   // clear a stale registration
  await scripting.registerContentScripts([
    { id: ARTIFACT_SCRIPT_IDS[0], matches: ['https://claude.ai/artifact/*'], js: ['artifact_capture_main.js'], runAt: 'document_start', world: 'MAIN', persistAcrossSessions: false },
    { id: ARTIFACT_SCRIPT_IDS[1], matches: ['https://claude.ai/artifact/*'], js: ['artifact_capture_relay.js'], runAt: 'document_start', persistAcrossSessions: false },
  ]);
}
async function unregisterArtifactCaptureScripts(scripting) {
  try { await scripting.unregisterContentScripts({ ids: ARTIFACT_SCRIPT_IDS }); } catch { /* not registered */ }
}

// One background tab at a time (callers are sequential). Always closes the tab.
async function captureArtifactDbViaTab(openUrl, deps = {}) {
  const tabs = deps.tabs || chrome.tabs;
  const scripting = deps.scripting || chrome.scripting;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now || Date.now;
  const url = artifactTabUrl(openUrl);
  if (!url) return { db: null, comments: null, stats: { calls: 0, failed_calls: 0, collections: 0, docs: 0 }, reason: 'bad_open_url', ms: 0 };
  const session = createArtifactDbSession({ now, ...(deps.session || {}) });
  const started = now();
  let tab = null;
  try {
    await registerArtifactCaptureScripts(scripting);
    tab = await tabs.create({ url, active: false });
    _artSessions.set(tab.id, session);
    let st = session.status();
    while (!st.done) {
      await sleep(deps.pollMs || 500);
      if (deps.keepalive) deps.keepalive();
      st = session.status();
    }
    return { ...session.result(), reason: st.reason, ms: now() - started };
  } finally {
    if (tab && tab.id != null) {
      _artSessions.delete(tab.id);
      try { await tabs.remove(tab.id); } catch { /* already closed */ }
    }
    await unregisterArtifactCaptureScripts(scripting);
  }
}

// ===================== IMPURE: Scry client =====================

function _scryBase(scry) { return String(scry.url || '').replace(/\/+$/, ''); }

async function fetchScryArtifactState(scry) {
  const resp = await fetch(`${_scryBase(scry)}/api/artifacts/state`, {
    headers: { Authorization: `Bearer ${scry.token}`, Accept: 'application/json' },
  });
  if (!resp.ok) throw new Error(`scry artifacts state ${resp.status}`);
  const body = await resp.json();
  return { artifacts: (body && body.artifacts) || {} };
}

async function postScryArtifact(scry, payload) {
  const resp = await fetch(`${_scryBase(scry)}/api/artifacts/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${scry.token}` },
    body: JSON.stringify(payload),
  });
  let body = null;
  try { body = await resp.json(); } catch { /* non-JSON */ }
  return { ok: resp.ok, status: resp.status, body };
}

// ===================== IMPURE: capture one artifact =====================

function _clientVersion() {
  return typeof getClientVersion === 'function' ? getClientVersion() : 'test';
}

async function captureOneArtifact(ctx, item, knownDetail) {
  const { gate, orgId, scry } = ctx;
  const report = {
    client_version: _clientVersion(), strategy: null, files_attempted: 0, files_sent: 0,
    files_failed: [], oversize: [], vendor_files_skipped: 0, sha_mismatch: [], thumbnail: null, db: null,
  };
  let detail = knownDetail;
  if (!detail) {
    const d = await fetchArtifactDetail(gate, orgId, item.id);
    if (!d.detail) throw new Error(`detail ${d.status}`);
    detail = d.detail;
  }
  const manifest = buildArtifactManifest(detail.files);
  const sel = selectArtifactFiles(detail.files);
  report.vendor_files_skipped = sel.vendor;
  report.oversize = sel.oversize;

  const out = [];
  let mainContentType = null;
  const fail = (path, reason, status) => report.files_failed.push({ path, reason, status: status ?? null });
  const download = async (file) => {
    report.files_attempted++;
    const strategies = buildArtifactDownloadStrategies({ detail, id: item.id, file });
    const r = await downloadArtifactFile(gate, strategies, file ? file.sha256 : null, ctx.strategy);
    if (!r.ok) {
      const last = r.attempts[r.attempts.length - 1] || {};
      const mism = r.attempts.some((a) => a.sha_match === false);
      return { error: mism ? 'sha_mismatch' : 'download_failed', status: last.status };
    }
    ctx.strategy = r.strategy.split('@')[0];
    report.strategy = ctx.strategy;
    return r;
  };

  if (sel.upload.length === 0 && manifest.length === sel.vendor) {
    // Single-document page: files:[] (or vendor-only) — fetch the page itself.
    const r = await download(null);
    if (r.error) fail('index.html', r.error, r.status);
    else {
      const prepared = await prepareArtifactFile({ path: 'index.html', contentType: artifactBaseContentType(r.contentType) }, r.bytes, r.contentType);
      out.push(prepared.entry);
      manifest.push({ path: 'index.html', size: r.bytes.length, content_type: prepared.entry.content_type, sha256: prepared.entry.sha256 });
      mainContentType = prepared.entry.content_type;
      report.files_sent++;
    }
  } else {
    for (const f of sel.upload) {
      const r = await download(f);
      if (r.error) { fail(f.path, r.error, r.status); if (r.error === 'sha_mismatch') report.sha_mismatch.push(f.path); continue; }
      const prepared = await prepareArtifactFile(f, r.bytes, r.contentType);
      if (!prepared.ok) { fail(f.path, prepared.reason, null); report.sha_mismatch.push(f.path); continue; }
      out.push(prepared.entry);
      report.files_sent++;
    }
    const main = artifactMainFile(detail.files);
    mainContentType = main ? (main.contentType || main.content_type) : null;
  }

  const type = inferArtifactType({ kind: item.kind, manifest, mainContentType });

  let db = null;
  let comments = null;
  if (type === 'typed') {
    const cap = await captureArtifactDbViaTab(item.open_url, { tabs: ctx.tabs, sleep: ctx.sleep, keepalive: ctx.keepalive, session: ctx.session, scripting: ctx.scripting });
    db = cap.db;
    comments = cap.comments;
    report.db = { ...cap.stats, reason: cap.reason, ms: cap.ms };
  }

  let png = null;
  if (item.thumbnail_url) {
    const t = await fetchArtifactThumbnail(gate, item.thumbnail_url);
    report.thumbnail = { status: t.status, content_type: t.content_type, bytes: t.bytes, error: t.error || null };
    if (t._bytes && t._bytes.length && artifactBaseContentType(t.content_type).startsWith('image/')) {
      png = { data_b64: artifactBytesToBase64(t._bytes), origin: 'thumbnail' };
    } else if (ctx.pngTried) ctx.pngTried[item.id] = ctx.now();
  }

  const payload = buildArtifactPayload({ item, detail, manifest, type, files: out, db, comments, png, fetchReport: report });
  let resp = await postScryArtifact(scry, payload);
  if (!resp.ok && resp.status >= 500) resp = await postScryArtifact(scry, payload);
  if (!resp.ok) throw new Error(`artifact ingest HTTP ${resp.status}`);
  return { type, files_sent: out.length, files_failed: report.files_failed.length, png: Boolean(png) };
}

// ===================== IMPURE: the collector run =====================

async function runArtifactCollector(deps) {
  const ctx = {
    gate: deps.gate || createArtifactGate(), orgId: deps.orgId, scry: deps.scry,
    tabs: deps.tabs, sleep: deps.sleep, keepalive: deps.keepalive, session: deps.session, scripting: deps.scripting,
    now: deps.now || Date.now, pngTried: deps.pngTried || {}, strategy: null,
  };
  const progress = deps.onProgress || (() => {});
  ctx.gate.resetRun();
  const sum = { listed: 0, captured: 0, skipped: 0, failed: 0, aborted: null, errors: [] };
  try {
    progress('listing artifacts');
    const { items, meta } = await fetchArtifactList(ctx.gate, ctx.orgId);
    sum.listed = items.length;
    sum.truncated = meta.truncated;
    progress('reading Scry state');
    const state = await fetchScryArtifactState(ctx.scry);
    const plan = planArtifactCaptures(items, state, { pngTried: ctx.pngTried, now: ctx.now() });
    const byId = new Map(items.map((i) => [i.id, i]));
    const details = new Map();
    const todo = plan.capture.slice();
    for (const id of plan.needsDetail) {
      progress(`checking ${id.slice(0, 8)} manifest`);
      try {
        const d = await fetchArtifactDetail(ctx.gate, ctx.orgId, id);
        if (!d.detail) { sum.failed++; sum.errors.push({ id, reason: `detail_${d.status}` }); continue; }
        details.set(id, d.detail);
        const dec = planArtifact(byId.get(id), state.artifacts[id], { detail: d.detail, pngTried: ctx.pngTried, now: ctx.now() });
        if (dec.capture) todo.push({ id, reason: dec.reason });
      } catch (e) { if (e instanceof ArtifactAbort) throw e; sum.failed++; sum.errors.push({ id, reason: 'detail_error' }); }
    }
    const detailFailed = new Set(sum.errors.map((e) => e.id));
    sum.skipped = items.filter((i) => !detailFailed.has(i.id)).length - todo.length;
    let n = 0;
    for (const t of todo) {
      n++;
      progress(`capturing ${n}/${todo.length}`);
      try {
        await captureOneArtifact(ctx, byId.get(t.id), details.get(t.id) || null);
        sum.captured++;
      } catch (e) {
        if (e instanceof ArtifactAbort) throw e;
        sum.failed++;
        sum.errors.push({ id: t.id, reason: (e && e.message) || 'error' });
        console.warn(`Scry artifacts: capture failed for ${t.id}: ${(e && e.message) || 'error'}`);
      }
    }
  } catch (e) {
    if (e instanceof ArtifactAbort) sum.aborted = e.reason;
    else { sum.aborted = 'error'; sum.errors.push({ id: null, reason: (e && e.message) || 'error' }); }
  }
  return sum;
}

// ===================== IMPURE: dry-run diagnostics =====================

function _countBy(arr, key) {
  const o = {};
  for (const a of arr) { const k = String(a[key] ?? 'none'); o[k] = (o[k] || 0) + 1; }
  return o;
}

// List + detail + one file download per strategy + thumbnail + (one typed
// artifact) the tab capture. Pushes NOTHING to Scry.
async function runArtifactDiagnostics(deps) {
  const gate = deps.gate || createArtifactGate();
  const progress = deps.onProgress || (() => {});
  gate.resetRun();
  const d = { client_version: _clientVersion(), list: null, artifacts: [], working_strategies: [], thumbnail_ok: null, db_ok: null };
  try {
    progress('listing artifacts');
    const { items, meta } = await fetchArtifactList(gate, deps.orgId);
    d.list = {
      status: meta.status, items: items.length, hosted_total: meta.hosted_total, pages: meta.pages,
      cursor_seen: meta.cursor_seen, truncated: meta.truncated, keys: meta.keys,
      kinds: _countBy(items, 'kind'), sources: _countBy(items, 'source'),
      with_thumbnail: items.filter((i) => i.thumbnail_url).length,
    };
    // Probe up to 6 details: process the first plain artifact and the first typed one.
    const picked = [];
    const done = { typed: false, plain: false };
    const working = new Set();
    let probes = 0;
    for (const item of items) {
      if ((done.typed && done.plain) || probes >= 6) break;
      probes++;
      progress(`probing artifact ${probes}`);
      const det = await fetchArtifactDetail(gate, deps.orgId, item.id);
      const rec = { id: item.id, kind: item.kind, type_guess: '?', detail: { status: det.status, files: 0, own: 0, vendor: 0, vendor_bytes: 0, has_asset_token: false, viewer_origin_ok: false }, downloads: [], thumbnail: null, db: null };
      if (det.detail) {
        const dt = det.detail;
        const manifest = buildArtifactManifest(dt.files);
        const sel = selectArtifactFiles(dt.files, Infinity);
        const typed = sel.vendor > 0;
        if (done[typed ? 'typed' : 'plain']) continue;
        done[typed ? 'typed' : 'plain'] = true;
        rec.type_guess = inferArtifactType({ kind: item.kind, manifest, mainContentType: (artifactMainFile(dt.files) || {}).contentType });
        rec.detail = {
          status: det.status, files: manifest.length, own: sel.upload.length, vendor: sel.vendor,
          vendor_bytes: (dt.files || []).filter((f) => artifactIsVendorPath(f.path)).reduce((a, f) => a + (Number(f.size) || 0), 0),
          has_asset_token: Boolean(dt.assetToken), viewer_origin_ok: artifactIsFrameHost(dt.viewerOrigin),
        };
        // One file: the smallest own file (never the 8 MB vendor app).
        const own = sel.upload.slice().sort((a, b) => (a.size || 0) - (b.size || 0))[0] || null;
        const strategies = buildArtifactDownloadStrategies({ detail: dt, id: item.id, file: own });
        progress(`download test ${probes}`);
        for (const s of strategies) {
          const r = await attemptArtifactDownload(gate, s, own ? own.sha256 : null);
          delete r._bytes;
          rec.downloads.push(r);
          if (r.working) working.add(r.strategy.split('@')[0]);
        }
        if (item.thumbnail_url && !picked.some((p) => p.thumbnail)) {
          const t = await fetchArtifactThumbnail(gate, item.thumbnail_url);
          rec.thumbnail = { status: t.status, content_type: t.content_type, bytes: t.bytes, error: t.error || null };
          d.thumbnail_ok = Boolean(t.bytes && artifactBaseContentType(t.content_type).startsWith('image/'));
        }
        if (typed) {
          progress('background tab db capture');
          const cap = await captureArtifactDbViaTab(item.open_url, { tabs: deps.tabs, sleep: deps.sleep, keepalive: deps.keepalive, session: deps.session, scripting: deps.scripting });
          rec.db = { ...cap.stats, reason: cap.reason, ms: cap.ms, comments: cap.comments ? cap.comments.length : 0 };
          d.db_ok = cap.stats.docs > 0;
        }
      }
      picked.push(rec);
    }
    d.artifacts = picked;
    d.working_strategies = Array.from(working);
  } catch (e) {
    d.error = e instanceof ArtifactAbort ? `aborted: ${e.reason}` : ((e && e.message) || 'error');
  }
  return d;
}

// ===================== IMPURE: job runner (alarm + manual) =====================

function _storageGet(keys) { return new Promise((r) => chrome.storage.local.get(keys, r)); }
function _storageSet(obj) { return new Promise((r) => chrome.storage.local.set(obj, r)); }

async function _artifactsOrgId() {
  const stored = typeof readOrgIdFromStorage === 'function' ? await readOrgIdFromStorage() : null;
  if (stored) return stored;
  return detectClaudeOrgId();
}

// mode: 'collect' | 'diagnose'. Progress and the final text land in
// chrome.storage.local[artifactsRun] for the options page.
async function runArtifactsJob(mode, { scheduled = false } = {}) {
  const prev = (await _storageGet([ARTIFACT_RUN_KEY]))[ARTIFACT_RUN_KEY];
  if (prev && prev.state === 'running' && Date.now() - prev.startedAt < ARTIFACT_RUN_STALE_MS) return { started: false, reason: 'already-running' };
  // A worker killed mid-capture leaves the capture scripts registered: clear them
  // first (after the already-running check, so a live run is never disturbed).
  await unregisterArtifactCaptureScripts(chrome.scripting);
  const scry = await loadScrySettings();
  if (scheduled && scry.artifactsEnabled !== true) return { started: false, reason: 'disabled' };
  if (scry.claudeEnabled === false) return { started: false, reason: 'claude-disabled' };
  if (mode === 'collect' && !(scry.url && scry.token)) return { started: false, reason: 'scry-not-configured' };
  if (scheduled) {
    // Do not overlap a continuous-sync wake (its own `running` guard, 10 min stale).
    const cs = (await _storageGet(['continuousSync'])).continuousSync;
    if (cs && typeof cs.running === 'number' && Date.now() - cs.running < 10 * 60 * 1000) {
      chrome.alarms.create(ARTIFACT_RETRY_ALARM, { delayInMinutes: 10 });
      return { started: false, reason: 'continuous-sync-running' };
    }
  }
  const startedAt = Date.now();
  const write = (patch) => _storageSet({ [ARTIFACT_RUN_KEY]: { mode, startedAt, ...patch } });
  await write({ state: 'running', progress: 'starting' });
  const keepalive = () => { try { chrome.runtime.getPlatformInfo(() => {}); } catch { /* best-effort */ } };
  const timer = setInterval(keepalive, 20000);
  try {
    const orgId = await _artifactsOrgId();
    const onProgress = (p) => { write({ state: 'running', progress: p }).catch(() => {}); };
    if (mode === 'diagnose') {
      const d = await runArtifactDiagnostics({ orgId, tabs: chrome.tabs, keepalive, onProgress });
      await write({ state: 'done', finishedAt: Date.now(), text: formatArtifactDiagnostics(d) });
    } else {
      const pngTried = (await _storageGet([ARTIFACT_PNG_TRIED_KEY]))[ARTIFACT_PNG_TRIED_KEY] || {};
      const sum = await runArtifactCollector({ orgId, scry, tabs: chrome.tabs, keepalive, onProgress, pngTried });
      await _storageSet({ [ARTIFACT_PNG_TRIED_KEY]: pngTried });
      const lines = [formatArtifactRunSummary(sum)];
      for (const e of sum.errors.slice(0, 10)) lines.push(`  ${e.id || '-'}: ${e.reason}`);
      console.log(`Scry artifacts: ${formatArtifactRunSummary(sum)}`);
      await write({ state: 'done', finishedAt: Date.now(), text: lines.join('\n'), summary: { ...sum, errors: undefined } });
    }
  } catch (e) {
    await write({ state: 'done', finishedAt: Date.now(), text: `ERROR: ${(e && e.message) || 'error'}` });
  } finally {
    clearInterval(timer);
  }
  return { started: true };
}

// Idempotent alarm registration that never pushes a pending alarm out.
async function registerArtifactAlarm() {
  const existing = await new Promise((r) => chrome.alarms.get(ARTIFACT_ALARM, r));
  if (existing) return;
  chrome.alarms.create(ARTIFACT_ALARM, { delayInMinutes: ARTIFACT_ALARM_DELAY_MIN, periodInMinutes: ARTIFACT_ALARM_PERIOD_MIN });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ARTIFACT_VENDOR_PREFIX, ARTIFACT_MAX_FILE_BYTES, ARTIFACT_ALARM, ARTIFACT_RETRY_ALARM, ARTIFACT_RUN_KEY, runArtifactsJob, registerArtifactCaptureScripts, unregisterArtifactCaptureScripts,
    artifactIsVendorPath, buildArtifactManifest, selectArtifactFiles, artifactMainFile, inferArtifactType,
    extractArtifactCursor, normalizeArtifactList, artifactManifestChanged, planArtifact, planArtifactCaptures,
    artifactBytesToBase64, artifactSha256Hex, artifactShaMatches, prepareArtifactFile, buildArtifactPayload,
    artifactViewerOrigin, artifactIsFrameHost, buildArtifactDownloadStrategies, createArtifactDbSession,
    formatArtifactRunSummary, formatArtifactDiagnostics, artifactTabUrl,
    ArtifactAbort, createArtifactGate, artifactGatedFetch, fetchArtifactList, fetchArtifactDetail,
    attemptArtifactDownload, downloadArtifactFile, fetchArtifactThumbnail, handleArtifactDbMessage,
    captureArtifactDbViaTab, captureOneArtifact, runArtifactCollector, runArtifactDiagnostics,
  };
}
