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
const ARTIFACT_TOO_LARGE_KEY = 'artifactsTooLarge';
const ARTIFACT_EXPORT_TRIED_KEY = 'artifactsExportTried';   // {id: {updated_at, at, ok}}
const ARTIFACT_EXPORT_RETRY_MS = 7 * 24 * 3600 * 1000;
const ARTIFACT_EXPORT_MAX_PER_RUN = 10;    // missing_export recaptures per run; the rest drain on later runs
const ARTIFACT_EXPORT_TIMEOUT_MS = 20000;
const ARTIFACT_EXPORT_LOAD_MS = 30000;
const ARTIFACT_EXPORT_PATHS = { markdown: 'export/document.md', pdf: 'export/document.pdf' };
const ARTIFACT_EXPORT_TYPES = { markdown: 'text/markdown', pdf: 'application/pdf', png: 'image/png' };
// Scry caps one ingest request (db/services/claude_artifact_service.py): 200 MB, 500 files.
const ARTIFACT_MAX_REQUEST_BYTES = 190 * 1024 * 1024;   // safety margin under 200 MB
const ARTIFACT_MAX_REQUEST_FILES = 500;
const ARTIFACT_TOO_LARGE_RETRY_MS = 7 * 24 * 3600 * 1000;
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
      content_type: f.contentType || f.content_type || '', sha256: artifactNormalizeSha(f.sha256),
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
    if (f && typeof f.path === 'string' && !artifactIsVendorPath(f.path) && f.sha256) out[f.path] = artifactNormalizeSha(f.sha256);
  }
  return out;
}

// True when the detail's own (non-vendor) file shas differ from Scry's stored
// ones. Vendor-app churn alone never counts: those bytes are not stored.
function artifactManifestChanged(detailFiles, stateFiles) {
  const now = artifactOwnFileShas(detailFiles);
  const had = {};
  for (const [p, s] of Object.entries(stateFiles || {})) if (!artifactIsVendorPath(p)) had[p] = artifactNormalizeSha(s);
  const a = Object.keys(now);
  if (a.length !== Object.keys(had).length) return true;
  return a.some((p) => had[p] !== now[p]);
}

function artifactDetailIsTyped(detail) {
  return (Array.isArray(detail && detail.files) ? detail.files : []).some((f) => f && artifactIsVendorPath(f.path));
}

// Export backoff: a failed export attempt for (id, updated_at) is not retried for 7 days.
function artifactExportBackoffActive(map, item, now) {
  const t = map && map[item.id];
  return Boolean(t && t.ok === false && t.updated_at === (item.updated_at || null) && typeof t.at === 'number' && now - t.at < ARTIFACT_EXPORT_RETRY_MS);
}

// Does a typed artifact still need its export capture? `entry` is Scry's state
// row. Missing `exports` / `png_origin` (an old server) means "unknown":
// capture, but only once per updated_at (the ok memo), so an old server does
// not cause a daily recapture.
function artifactExportNeeded(entry, item, { exportTried = null, now = Date.now() } = {}) {
  if (artifactExportBackoffActive(exportTried, item, now)) return false;
  const t = exportTried && exportTried[item.id];
  const doneHere = Boolean(t && t.ok === true && t.updated_at === (item.updated_at || null));   // partial (ok:false) never counts as done
  const ex = entry && entry.exports;
  const po = entry && entry.png_origin;
  if (ex === undefined || ex === null || po === undefined) return !doneHere;
  const haveDoc = Boolean(ex[ARTIFACT_EXPORT_PATHS.markdown] && ex[ARTIFACT_EXPORT_PATHS.pdf]);
  if (haveDoc || po === 'export') return false;
  return !doneHere;
}

function _artNewer(a, b) {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return Boolean(a) && a !== b;
  return ta > tb;
}

// Decide one artifact. `detail` is optional (fetched lazily by the collector
// for artifacts the list alone calls unchanged). Returns {capture, reason}.
function planArtifact(item, entry, { detail = null, pngTried = null, exportTried = null, now = Date.now() } = {}) {
  if (entry && entry.tombstoned) return { capture: false, reason: 'tombstoned' };
  if (!entry) return { capture: true, reason: 'new' };
  if (_artNewer(item.updated_at, entry.updated_at)) return { capture: true, reason: 'updated' };
  if (detail) {
    if (artifactManifestChanged(detail.files, entry.files)) return { capture: true, reason: 'manifest_changed' };
    if (detail.ver != null && entry.version != null && String(detail.ver) !== String(entry.version)) {
      return { capture: true, reason: 'version_changed' };
    }
  }
  if (detail && artifactDetailIsTyped(detail) && artifactExportNeeded(entry, item, { exportTried, now })) {
    return { capture: true, reason: 'missing_export' };
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

// Vendor sha256 -> lowercase hex (it may arrive hex or base64). No Node APIs
// (the MV3 service worker has no Buffer). Unparseable input is returned lowercased.
function artifactNormalizeSha(v) {
  if (v == null || v === '') return '';
  const e = String(v).trim();
  if (/^[0-9a-fA-F]{64}$/.test(e)) return e.toLowerCase();
  try {
    const bin = atob(e);
    let hex = '';
    for (let i = 0; i < bin.length; i++) hex += bin.charCodeAt(i).toString(16).padStart(2, '0');
    if (hex.length === 64) return hex;
  } catch { /* not base64 */ }
  return e.toLowerCase();
}

// Does `expected` (the detail's sha256, hex or base64) match the computed hex?
function artifactShaMatches(expected, hex) {
  if (!expected) return true;
  return artifactNormalizeSha(expected) === hex;
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

function buildArtifactPayload({ item, detail, manifest, type, files, db, comments, png, fetchReport, subtype = null }) {
  const dbKeys = db ? Object.keys(db) : [];
  return {
    artifact: {
      id: item.id, open_url: item.open_url || null, title: item.title || null,
      kind: item.kind || null, source: item.source || null, type,
      created_at: item.created_at || null, updated_at: item.updated_at || null,
      version: detail && detail.ver != null ? detail.ver : null,
      subtype: subtype || null,
    },
    manifest,
    files,
    db: dbKeys.length ? db : null,
    comments: comments && comments.length ? comments : null,
    png: png || null,
    fetch_report: fetchReport || null,
  };
}

// ===================== PURE: export files =====================

function artifactBase64ToBytes(b64) {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Format-specific sanity check of a captured export. Returns null when fine.
function artifactExportInvalid(format, bytes) {
  if (!bytes || !bytes.length) return 'empty';
  if (format === 'pdf') return String.fromCharCode(...bytes.subarray(0, 4)) === '%PDF' ? null : 'bad_content';
  if (format === 'png') return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 ? null : 'bad_content';
  if (format === 'markdown') {
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); return null; } catch { return 'bad_content'; }
  }
  return 'unwanted_format';
}

// Turn the driver's captured[] ({format, content_type, size, b64}) into ingest
// pieces. Fixed paths; sha256 computed here; Word / unknown formats refused.
async function prepareArtifactExports(captured, maxBytes = ARTIFACT_MAX_FILE_BYTES) {
  const res = { files: [], manifest: [], png: null, captured: [], failed: [] };
  for (const c of Array.isArray(captured) ? captured : []) {
    if (!c || !ARTIFACT_EXPORT_TYPES[c.format]) { res.failed.push({ format: (c && c.format) || '?', reason: 'unwanted_format' }); continue; }
    const bytes = c.b64 ? artifactBase64ToBytes(c.b64) : null;
    if (bytes && bytes.length > maxBytes) { res.failed.push({ format: c.format, reason: 'too_large' }); continue; }
    const bad = artifactExportInvalid(c.format, bytes);
    if (bad) { res.failed.push({ format: c.format, reason: bad }); continue; }
    res.captured.push({ format: c.format, bytes: bytes.length, content_type: artifactBaseContentType(c.content_type) });
    if (c.format === 'png') { res.png = { data_b64: c.b64, origin: 'export' }; continue; }
    const sha = await artifactSha256Hex(bytes);
    const path = ARTIFACT_EXPORT_PATHS[c.format];
    res.files.push({ path, content_type: ARTIFACT_EXPORT_TYPES[c.format], sha256: sha, data_b64: c.b64 });
    res.manifest.push({ path, size: bytes.length, content_type: ARTIFACT_EXPORT_TYPES[c.format], sha256: sha, source: 'export' });
  }
  return res;
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
  if (s.too_large && s.too_large.length) parts.push(`too_large ${s.too_large.length}`);
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
  for (const e of d.exports || []) {
    L.push(`EXPORT TEST (${e.subtype || 'unknown subtype'}): mode ${e.mode}, offered [${(e.offered || []).join(', ')}], ms ${e.ms}`);
    for (const c of e.captured) L.push(`  captured ${c.format}: ${c.bytes} bytes, ${c.content_type || '-'}`);
    for (const f of e.failed) L.push(`  failed ${f.format}: ${f.reason}`);
    if (e.clicks && e.clicks.length) L.push(`  clicks: ${e.clicks.join(', ')}`);
    for (const p of e.probe || []) L.push(`  probe ${p.stage}: focus ${p.focus} vis ${p.vis} expanded ${p.expanded} connected ${p.connected} menus ${p.menus} items ${p.items} dialogs ${p.dialogs}`);
  }
  L.push(`SUMMARY: working download strategies = ${(d.working_strategies || []).join(', ') || 'NONE'}; thumbnail fetchable = ${d.thumbnail_ok === null ? 'untested' : d.thumbnail_ok}; tab db capture = ${d.db_ok === null ? 'untested (no typed artifact)' : d.db_ok}; export capture = ${d.export_ok === null || d.export_ok === undefined ? 'untested' : d.export_ok}`);
  return L.join('\n');
}

// ===================== IMPURE: gate + gated requests =====================

class ArtifactAbort extends Error {
  constructor(reason) { super(`artifact run aborted: ${reason}`); this.name = 'ArtifactAbort'; this.reason = reason; }
}
class _ArtifactRateLimited extends Error {}
class ArtifactTooLarge extends Error {
  constructor(reason) { super(`artifact too large: ${reason}`); this.name = 'ArtifactTooLarge'; this.reason = reason; }
}

// Encoded request size estimate: base64 per file + JSON for the rest.
function estimateArtifactRequestBytes({ fileSizes = [], extraJson = 0 }) {
  let n = 4096 + extraJson;
  for (const sz of fileSizes) n += Math.ceil((Number(sz) || 0) / 3) * 4 + 200;
  return n;
}

// Remembered "too large" artifacts retry after 7 days, or at once if updated_at changed.
function artifactTooLargeBackoffActive(map, item, now) {
  const e = map && map[item.id];
  return Boolean(e && e.updated_at === (item.updated_at || null) && typeof e.at === 'number' && now - e.at < ARTIFACT_TOO_LARGE_RETRY_MS);
}

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
    { id: ARTIFACT_SCRIPT_IDS[1], matches: ['https://claude.ai/artifact/*'], js: ['artifact_export_ui.js', 'artifact_capture_relay.js'], runAt: 'document_start', persistAcrossSessions: false },
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

// ===================== IMPURE: export capture via Claude's own Export menu =====================

const _NO_RECEIVER = /receiving end does not exist|could not establish connection/i;

// One attempt in one tab (mode 'tab': inactive tab) or one briefly FOCUSED
// normal window (mode 'window'). Always closes what it opened and unregisters the scripts.
async function _exportAttempt(url, mode, deps, only) {
  const tabs = deps.tabs || chrome.tabs;
  const windows = deps.windows || (typeof chrome !== 'undefined' ? chrome.windows : null);
  const scripting = deps.scripting || chrome.scripting;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now || Date.now;
  const timeoutMs = deps.exportTimeoutMs || ARTIFACT_EXPORT_TIMEOUT_MS;
  const loadMs = deps.exportLoadMs || ARTIFACT_EXPORT_LOAD_MS;
  let tabId = null;
  let winId = null;
  let prevWinId = null;
  try {
    await registerArtifactCaptureScripts(scripting);
    if (mode === 'window') {
      // FOCUSED: Claude's menus close themselves when the document has no focus
      // (live 2026-11-18: menu_not_opened in an inactive tab AND in an unfocused
      // window). Focus goes back to the previous window in `finally`.
      try { const pw = await windows.getLastFocused(); prevWinId = pw && pw.id != null ? pw.id : null; } catch { prevWinId = null; }
      const w = await windows.create({ url, focused: true, type: 'normal' });
      winId = w.id;
      tabId = w.tabs && w.tabs[0] ? w.tabs[0].id : null;
      if (tabId == null) return { offered: [], subtype: null, captured: [], failed: [{ format: '*', reason: 'no_tab' }] };
    } else {
      tabId = (await tabs.create({ url, active: false })).id;
    }
    const msg = { action: 'artifactExportRun', title: deps.title || '', timeoutMs, loadMs, onlyFormats: only || undefined };
    const t0 = now();
    for (;;) {
      try {
        const budget = (only ? only.length : 2) * (timeoutMs + 15000) + loadMs + 30000;
        let timer;
        const resp = await Promise.race([
          tabs.sendMessage(tabId, msg),
          new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('driver_timeout')), budget); }),
        ]).finally(() => clearTimeout(timer));
        if (resp && Array.isArray(resp.captured)) return resp;
        return { offered: [], subtype: null, captured: [], failed: [{ format: '*', reason: 'no_driver' }] };
      } catch (e) {
        if (_NO_RECEIVER.test((e && e.message) || '') && now() - t0 < loadMs) { if (deps.keepalive) deps.keepalive(); await sleep(deps.pollMs || 500); continue; }
        return { offered: [], subtype: null, captured: [], failed: [{ format: '*', reason: /driver_timeout/.test((e && e.message) || '') ? 'driver_timeout' : 'no_driver' }] };
      }
    }
  } finally {
    if (winId != null) { try { await windows.remove(winId); } catch { /* already closed */ } }
    else if (tabId != null) { try { await tabs.remove(tabId); } catch { /* already closed */ } }
    if (prevWinId != null) { try { await windows.update(prevWinId, { focused: true }); } catch { /* gone */ } }
    await unregisterArtifactCaptureScripts(scripting);
  }
}

const _EXPORT_UI_RETRY = new Set(['title_button_not_found', 'menu_not_opened', 'dialog_not_found']);

// deps.exportMode: undefined = inactive tab, falling back ONCE to a focused
// window for formats that timed out; 'tab' / 'window' force one mode.
// Returns {offered, subtype, captured[{format,content_type,size,b64,...}], failed[], mode, ms}.
async function captureArtifactExportsViaTab(openUrl, deps = {}) {
  const tabs = deps.tabs || chrome.tabs;
  const now = deps.now || Date.now;
  const t0 = now();
  const empty = (reason) => ({ offered: [], subtype: null, captured: [], failed: [{ format: '*', reason }], mode: 'tab', ms: 0 });
  const url = artifactTabUrl(openUrl);
  if (!url) return empty('bad_open_url');
  if (!tabs || typeof tabs.sendMessage !== 'function') return empty('no_driver');
  let mode = deps.exportMode === 'window' ? 'window' : 'tab';
  let res = await _exportAttempt(url, mode, deps, deps.onlyFormats || null);
  // Claude's menu/dialog can fail to render in an inactive tab (seen live
  // 2026-11-18: menu_not_opened on every artifact): redo the whole run, once,
  // in a focused window. blocked_click is never retried.
  const uiFailed = res.failed.some((f) => f.format === '*' && _EXPORT_UI_RETRY.has(f.reason));
  if (mode === 'tab' && !deps.exportMode && uiFailed) {
    const r2 = await _exportAttempt(url, 'window', deps, deps.onlyFormats || null);
    return { ...r2, mode: 'window', ms: now() - t0 };
  }
  const timedOut = res.failed.filter((f) => f.reason === 'timeout').map((f) => f.format);
  if (mode === 'tab' && !deps.exportMode && timedOut.length) {
    const r2 = await _exportAttempt(url, 'window', deps, timedOut);
    mode = 'window';
    res = {
      offered: res.offered.length ? res.offered : r2.offered,
      subtype: res.subtype || r2.subtype,
      captured: res.captured.concat(r2.captured),
      failed: res.failed.filter((f) => !timedOut.includes(f.format)).concat(r2.failed),
    };
  }
  return { ...res, mode, ms: now() - t0 };
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

// Did Scry's ingest answer say the preview image was not stored? Scry (PR #349)
// replies png: {status: 'rejected', reason, http_status}; the other signals are
// kept defensively.
function artifactPngRejected(body) {
  if (!body || typeof body !== 'object') return false;
  const p = body.png;
  return body.png_rejected === true || body.png_stored === false || body.has_png === false
    || Boolean(p && typeof p === 'object' && (p.status === 'rejected' || p.rejected === true || p.stored === false || p.accepted === false));
}

function _clientVersion() {
  return typeof getClientVersion === 'function' ? getClientVersion() : 'test';
}

async function captureOneArtifact(ctx, item, knownDetail) {
  let exportMemo = null;
  const { gate, orgId, scry } = ctx;
  const report = {
    client_version: _clientVersion(), strategy: null, files_attempted: 0, files_sent: 0,
    files_failed: [], oversize: [], vendor_files_skipped: 0, sha_mismatch: [], thumbnail: null, db: null, export: null, snippet: null,
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
  // Before downloading anything: the manifest sizes already say whether it can fit.
  if (sel.upload.length + 1 > ARTIFACT_MAX_REQUEST_FILES) throw new ArtifactTooLarge('too_large');
  if (estimateArtifactRequestBytes({ fileSizes: sel.upload.map((f) => f.size), extraJson: JSON.stringify(manifest).length }) > ARTIFACT_MAX_REQUEST_BYTES) throw new ArtifactTooLarge('too_large');

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
  if (item.kind === 'snippet') {
    // A snippet is stored as its content type; record what its detail offered.
    mainContentType = mainContentType || item.content_type || item.contentType || detail.content_type || detail.contentType || null;
    report.snippet = {
      files: manifest.length, content_type: artifactBaseContentType(mainContentType) || null,
      reason: out.length ? null : (report.files_failed[0] ? report.files_failed[0].reason : 'no_files'),
    };
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

  let exportPieces = null;
  let subtype = null;
  if (type === 'typed' && ctx.exports !== false) {
    if (artifactExportBackoffActive(ctx.exportTried, item, ctx.now())) {
      report.export = { skipped: 'backoff' };
    } else {
      let cap;
      const prior = ctx.exportTried && ctx.exportTried[item.id];
      const priorDone = prior && prior.updated_at === (item.updated_at || null) && Array.isArray(prior.done) ? prior.done : [];
      const onlyFormats = priorDone.length ? ['markdown', 'pdf', 'png'].filter((f) => !priorDone.includes(f)) : undefined;
      try {
        cap = await captureArtifactExportsViaTab(item.open_url, {
          onlyFormats,
          tabs: ctx.tabs, windows: ctx.windows, sleep: ctx.sleep, keepalive: ctx.keepalive, scripting: ctx.scripting,
          title: item.title, exportMode: ctx.exportMode, now: ctx.now, ...(ctx.exportOpts || {}),
        });
      } catch (e) {
        cap = { offered: [], subtype: null, captured: [], failed: [{ format: '*', reason: 'tab_error' }], mode: 'tab', ms: 0 };
      }
      exportPieces = await prepareArtifactExports(cap.captured);
      const failed = cap.failed.concat(exportPieces.failed);
      subtype = cap.subtype || null;
      report.export = { mode: cap.mode, formats_offered: cap.offered, captured: exportPieces.captured, failed, ms: cap.ms };
      for (const f of exportPieces.files) out.push(f);
      for (const m of exportPieces.manifest) manifest.push(m);
      if (ctx.exportTried) {
        // Failures back off at once (only the failed formats are retried later);
        // captured formats are marked done only after Scry accepts the ingest.
        const done = Array.from(new Set(priorDone.concat(exportPieces.captured.map((c) => c.format))));
        const failedFormats = failed.map((f) => f.format);
        if (failed.length) ctx.exportTried[item.id] = { updated_at: item.updated_at || null, at: ctx.now(), ok: false, done: priorDone, failed: failedFormats };
        exportMemo = { updated_at: item.updated_at || null, at: ctx.now(), ok: failed.length === 0, done, failed: failedFormats };
      }
    }
  }

  let png = exportPieces && exportPieces.png ? exportPieces.png : null;
  if (!png && item.thumbnail_url) {
    const t = await fetchArtifactThumbnail(gate, item.thumbnail_url);
    report.thumbnail = { status: t.status, content_type: t.content_type, bytes: t.bytes, error: t.error || null };
    if (t._bytes && t._bytes.length && artifactBaseContentType(t.content_type).startsWith('image/')) {
      png = { data_b64: artifactBytesToBase64(t._bytes), origin: 'thumbnail' };
    } else if (ctx.pngTried) ctx.pngTried[item.id] = ctx.now();
  }

  const payload = buildArtifactPayload({ item, detail, manifest, type, files: out, db, comments, png, fetchReport: report, subtype });
  if (out.length + (png ? 1 : 0) > ARTIFACT_MAX_REQUEST_FILES) throw new ArtifactTooLarge('too_large');
  const actual = out.reduce((a, f) => a + f.data_b64.length + 200, 0) + (png ? png.data_b64.length : 0)
    + JSON.stringify([manifest, db, comments, report]).length + 4096;
  if (actual > ARTIFACT_MAX_REQUEST_BYTES) throw new ArtifactTooLarge('too_large');
  let resp = await postScryArtifact(scry, payload);
  if (!resp.ok && resp.status >= 500) resp = await postScryArtifact(scry, payload);
  if (resp.status === 413) throw new ArtifactTooLarge('too_large_server');
  if (!resp.ok) throw new Error(`artifact ingest HTTP ${resp.status}`);
  // A rejected preview must not make the planner re-capture as missing_png every run.
  if (png && png.origin === 'thumbnail' && artifactPngRejected(resp.body) && ctx.pngTried) ctx.pngTried[item.id] = ctx.now();
  if (exportMemo && ctx.exportTried) ctx.exportTried[item.id] = exportMemo;   // ok:true, or ok:false carrying the now-ingested done formats
  return { type, files_sent: out.length, files_failed: report.files_failed.length, png: Boolean(png) };
}

// ===================== IMPURE: the collector run =====================

async function runArtifactCollector(deps) {
  const ctx = {
    gate: deps.gate || createArtifactGate(), orgId: deps.orgId, scry: deps.scry,
    tabs: deps.tabs, sleep: deps.sleep, keepalive: deps.keepalive, session: deps.session, scripting: deps.scripting,
    now: deps.now || Date.now, pngTried: deps.pngTried || {}, tooLarge: deps.tooLarge || {}, strategy: null,
    windows: deps.windows, exportMode: deps.exportMode, exportTried: deps.exportTried || {}, exportOpts: deps.exportOpts, exports: deps.exports,
  };
  const progress = deps.onProgress || (() => {});
  ctx.gate.resetRun();
  const sum = { listed: 0, captured: 0, skipped: 0, failed: 0, too_large: [], aborted: null, errors: [] };
  try {
    progress('listing artifacts');
    const { items, meta } = await fetchArtifactList(ctx.gate, ctx.orgId);
    sum.listed = items.length;
    sum.truncated = meta.truncated;
    progress('reading Scry state');
    const state = await fetchScryArtifactState(ctx.scry);
    const plan = planArtifactCaptures(items, state, { pngTried: ctx.pngTried, exportTried: ctx.exportTried, now: ctx.now() });
    const byId = new Map(items.map((i) => [i.id, i]));
    const details = new Map();
    const todo = plan.capture.slice();
    for (const id of plan.needsDetail) {
      progress(`checking ${id.slice(0, 8)} manifest`);
      try {
        const d = await fetchArtifactDetail(ctx.gate, ctx.orgId, id);
        if (!d.detail) { sum.failed++; sum.errors.push({ id, reason: `detail_${d.status}` }); continue; }
        details.set(id, d.detail);
        const dec = planArtifact(byId.get(id), state.artifacts[id], { detail: d.detail, pngTried: ctx.pngTried, exportTried: ctx.exportTried, now: ctx.now() });
        if (dec.capture) todo.push({ id, reason: dec.reason });
      } catch (e) { if (e instanceof ArtifactAbort) throw e; sum.failed++; sum.errors.push({ id, reason: 'detail_error' }); }
    }
    const detailFailed = new Set(sum.errors.map((e) => e.id));
    sum.skipped = items.filter((i) => !detailFailed.has(i.id)).length - todo.length;
    let n = 0;
    let exportOnly = 0;
    for (const t of todo) {
      n++;
      progress(`capturing ${n}/${todo.length}`);
      const it = byId.get(t.id);
      if (t.reason === 'missing_export') {
        if (exportOnly >= ARTIFACT_EXPORT_MAX_PER_RUN) { sum.export_deferred = (sum.export_deferred || 0) + 1; continue; }
        exportOnly++;
      }
      if (artifactTooLargeBackoffActive(ctx.tooLarge, it, ctx.now())) {
        sum.too_large.push({ id: t.id, reason: ctx.tooLarge[t.id].reason, backoff: true });
        continue;
      }
      try {
        try {
          await captureOneArtifact(ctx, byId.get(t.id), details.get(t.id) || null);
          sum.captured++;
          delete ctx.tooLarge[t.id];
        } finally {
          // Persist backoffs as each artifact finishes, so a later abort or a killed worker keeps them.
          if (deps.persist) { try { await deps.persist(); } catch { /* best-effort */ } }
        }
      } catch (e) {
        if (e instanceof ArtifactAbort) throw e;
        if (e instanceof ArtifactTooLarge) {
          ctx.tooLarge[t.id] = { updated_at: it.updated_at || null, at: ctx.now(), reason: e.reason };
          sum.too_large.push({ id: t.id, reason: e.reason });
          continue;
        }
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
  const d = { client_version: _clientVersion(), list: null, artifacts: [], working_strategies: [], thumbnail_ok: null, db_ok: null, exports: [], export_ok: null };
  const typedItems = [];
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
        if (typed) typedItems.push(item);
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
    // Dry-run export test: one document-type and one whiteboard artifact if present.
    // Bytes are measured and dropped; nothing is saved and nothing goes to Scry.
    if (deps.exportTest !== false) {
      const seen = new Set();
      let tests = 0;
      for (const item of typedItems) {
        if (tests >= 4 || (seen.has('document') && seen.has('whiteboard'))) break;
        tests++;
        progress(`export test ${tests}`);
        let cap;
        try {
          cap = await captureArtifactExportsViaTab(item.open_url, { tabs: deps.tabs, windows: deps.windows, sleep: deps.sleep, keepalive: deps.keepalive, scripting: deps.scripting, title: item.title, exportMode: deps.exportMode, ...(deps.exportOpts || {}) });
        } catch { cap = { offered: [], subtype: null, captured: [], failed: [{ format: '*', reason: 'tab_error' }], mode: 'tab', ms: 0 }; }
        const prep = await prepareArtifactExports(cap.captured);
        if (cap.subtype && seen.has(cap.subtype)) continue;
        if (cap.subtype) seen.add(cap.subtype);
        d.exports.push({ subtype: cap.subtype, mode: cap.mode, offered: cap.offered, captured: prep.captured, failed: cap.failed.concat(prep.failed), ms: cap.ms, clicks: cap.clicks || [], probe: cap.probe || [] });
      }
      d.export_ok = d.exports.length ? d.exports.some((e) => e.captured.length > 0) : null;
    }
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
      const d = await runArtifactDiagnostics({ orgId, tabs: chrome.tabs, windows: chrome.windows, keepalive, onProgress, exportMode: scry.artifactsExportMode });
      await write({ state: 'done', finishedAt: Date.now(), text: formatArtifactDiagnostics(d) });
    } else {
      const pngTried = (await _storageGet([ARTIFACT_PNG_TRIED_KEY]))[ARTIFACT_PNG_TRIED_KEY] || {};
      const tooLarge = (await _storageGet([ARTIFACT_TOO_LARGE_KEY]))[ARTIFACT_TOO_LARGE_KEY] || {};
      const exportTried = (await _storageGet([ARTIFACT_EXPORT_TRIED_KEY]))[ARTIFACT_EXPORT_TRIED_KEY] || {};
      const persist = () => _storageSet({ [ARTIFACT_PNG_TRIED_KEY]: pngTried, [ARTIFACT_TOO_LARGE_KEY]: tooLarge, [ARTIFACT_EXPORT_TRIED_KEY]: exportTried });
      const sum = await runArtifactCollector({ orgId, scry, tabs: chrome.tabs, windows: chrome.windows, keepalive, onProgress, pngTried, tooLarge, exportTried, exportMode: scry.artifactsExportMode, persist });
      await _storageSet({ [ARTIFACT_PNG_TRIED_KEY]: pngTried, [ARTIFACT_TOO_LARGE_KEY]: tooLarge, [ARTIFACT_EXPORT_TRIED_KEY]: exportTried });
      const lines = [formatArtifactRunSummary(sum)];
      for (const e of sum.errors.slice(0, 10)) lines.push(`  ${e.id || '-'}: ${e.reason}`);
      for (const e of (sum.too_large || []).slice(0, 10)) lines.push(`  ${e.id}: ${e.reason}${e.backoff ? ' (backoff)' : ''}`);
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
    ArtifactTooLarge, estimateArtifactRequestBytes, artifactTooLargeBackoffActive, ARTIFACT_MAX_REQUEST_BYTES,
    artifactBytesToBase64, artifactNormalizeSha, artifactPngRejected, artifactSha256Hex, artifactShaMatches, prepareArtifactFile, buildArtifactPayload,
    artifactViewerOrigin, artifactIsFrameHost, buildArtifactDownloadStrategies, createArtifactDbSession,
    formatArtifactRunSummary, formatArtifactDiagnostics, artifactTabUrl,
    ArtifactAbort, createArtifactGate, artifactGatedFetch, fetchArtifactList, fetchArtifactDetail,
    attemptArtifactDownload, downloadArtifactFile, fetchArtifactThumbnail, handleArtifactDbMessage,
    captureArtifactDbViaTab, captureArtifactExportsViaTab, prepareArtifactExports, artifactExportNeeded, artifactExportBackoffActive, artifactDetailIsTyped, ARTIFACT_EXPORT_PATHS, ARTIFACT_EXPORT_TRIED_KEY, ARTIFACT_EXPORT_MAX_PER_RUN, captureOneArtifact, runArtifactCollector, runArtifactDiagnostics,
  };
}
