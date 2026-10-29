// The SOURCES registry: everything the shared sync core (chrome/sync_core.js)
// and the continuous-sync orchestrator (chrome/continuous_sync.js) need to
// know to enumerate, sync one item, reconcile, and classify errors for a
// single source (claude, chatgpt), plus each source's pure error-
// classification helpers.
//
// Split out of continuous_sync.js (2026-09) so browse.js and chatgpt.js can
// pull in SOURCES (and, via sync_core.js, syncBatch/reconcileAndSync, which
// key off it) WITHOUT loading the alarm-driven background engine —
// continuous_sync.js keeps the planning/state-machine helpers and the
// orchestrator; this file keeps the per-source contract.
//
// Load order: utils.js, scry_sync.js, scry_client.js, chatgpt_adapter.js,
// sources.js, sync_core.js, [continuous_sync.js — background service worker
// only].

// --- resolvers for chatgpt_adapter.js globals (browser) / module (Node) ---
// chatgpt_adapter.js is loaded before this file as a global in the browser;
// required by module in Node (vitest). Mirrors scry_sync.js's _currentBranch.
function _chatGptTimeToIso() {
  return (typeof chatGptTimeToIso !== 'undefined')
    ? chatGptTimeToIso
    : require('./chatgpt_adapter.js').chatGptTimeToIso;
}
function _ChatGptRateLimitErrorCtor() {
  return (typeof ChatGptRateLimitError !== 'undefined')
    ? ChatGptRateLimitError
    : require('./chatgpt_adapter.js').ChatGptRateLimitError;
}

// The chatgpt back-off knobs and the global request gate live in
// chatgpt_adapter.js (browser: bare globals; Node: module).
function _chatGptAdapter() {
  return (typeof CHATGPT_DEEP_SLICE !== 'undefined')
    ? {
        CHATGPT_DEEP_SLICE, CHATGPT_BATCH_CONCURRENCY, CHATGPT_ABORT_AFTER_COOLDOWNS,
        gate: () => chatGptGate,
      }
    : (() => {
        const m = require('./chatgpt_adapter.js');
        return {
          CHATGPT_DEEP_SLICE: m.CHATGPT_DEEP_SLICE,
          CHATGPT_BATCH_CONCURRENCY: m.CHATGPT_BATCH_CONCURRENCY,
          CHATGPT_ABORT_AFTER_COOLDOWNS: m.CHATGPT_ABORT_AFTER_COOLDOWNS,
          gate: () => m.chatGptGate,
        };
      })();
}
const _CG = _chatGptAdapter();

// An AbortSignal-like { aborted } that reads true once the wake has hit
// `limit` rate-limit cooldowns (syncBatch checks `.aborted` before starting
// each item). Getter-backed, so it reflects the gate live.
function cooldownAbortSignal(getState, limit) {
  return { get aborted() { return ((getState() || {}).cooldownsThisRun || 0) >= limit; } };
}

// Normalize one item from ChatGPT's conversation-list endpoint to the
// {uuid, updated_at, title} shape the planning helpers share with Claude
// (they only ever look at uuid/updated_at). The list endpoint's update_time
// has been observed as both an ISO string and epoch seconds — chatGptTimeToIso
// tolerates both.
function normalizeChatGptListItem(item) {
  const toIso = _chatGptTimeToIso();
  return {
    uuid: item && item.id,
    updated_at: toIso(item && item.update_time),
    title: (item && item.title) || null,
  };
}

// Pure classification: does this error mean "not signed in to chatgpt.com" —
// getChatGptAccessToken's two failure modes (non-OK auth/session, including
// 401/403; or a 200 with no accessToken in the body) — rather than a real
// sync failure? A signed-out wake is NOT a failure (no consecutiveFailures
// bump, no badge, no backoff): the user simply hasn't opened chatgpt.com in
// this browser profile, which is an everyday state, not an error condition.
function isChatGptSignedOutError(err) {
  const msg = (err && err.message) || String(err || '');
  return /^auth\/session \d+/.test(msg) || /^No access token in session/.test(msg);
}

// Which side a ChatGPT-domain failure is on: the SOURCES.chatgpt.errorDomain
// implementation. A rate limit (429) is always chatgpt-domain (worth backing
// off claude.ai-style); otherwise classify by message prefix — every error
// chatgpt_adapter.js/this file throw for a chatgpt.com-side failure starts
// with one of these. Anything else (ingest HTTP …, ingest rejected) is Scry's
// side, matching the Claude path's _domainForError default.
function chatgptErrorDomain(err) {
  const RateLimitCtor = _ChatGptRateLimitErrorCtor();
  if (err instanceof RateLimitCtor) return 'chatgpt';
  const msg = (err && err.message) || String(err || '');
  if (/^https:\/\/chatgpt\.com/.test(msg)) return 'chatgpt';
  if (/^auth\/session/.test(msg)) return 'chatgpt';
  if (/^fetch conversation/.test(msg)) return 'chatgpt';
  if (/^chatgpt/i.test(msg)) return 'chatgpt';
  return 'scry';
}

// A thrown Error's message tells us which side failed: fetchConversationBody /
// listClaudeConversations throw "fetch conversation…" / "fetch conversation
// list…"; everything else (ingest HTTP …, ingest rejected, reconcile HTTP …)
// originates on the Scry side. There's no typed error contract in the existing
// sync helpers to key off instead, so this pattern match is the practical
// signal — a reasonable target for a future slice if it proves too coarse.
function _domainForError(err) {
  const msg = (err && err.message) || String(err || '');
  return /^fetch conversation/.test(msg) ? 'claude' : 'scry';
}

// The stub-guard throw from fetchConversationBody: claude.ai returned 200 with
// an empty body for a conversation that looks like it should have content.
function isStubFetchError(err) {
  const msg = (err && err.message) || '';
  return /empty body \(stub\) after retries$/.test(msg);
}

// After a stub failure, Scry's reconcile (called with just that id) is the
// authority on whether the conversation is still wanted:
//   'wanted'     — in to_resync: a real conversation stubbing transiently.
//                  The failure stands and keeps pinning the watermark.
//   'tombstoned' — deliberately deleted in Scry (reconcile counts it terminal,
//                  never to_resync). Permanent skip: cache the uuid so it is
//                  never fetched again.
//   'unwanted'   — not in to_resync, not tombstoned (e.g. already complete).
//                  Skip this wake only; no permanent cache (a later edit bumps
//                  updated_at and must sync normally).
// Fails safe: a malformed report reads as 'wanted' — the watermark never
// advances past a conversation on a guess.
function classifyStubAfterReconcile(report, uuid) {
  if (!report || !Array.isArray(report.to_resync)) return 'wanted';
  if (report.to_resync.includes(uuid)) return 'wanted';
  const tombstoned = report.summary && report.summary.tombstoned;
  return tombstoned >= 1 ? 'tombstoned' : 'unwanted';
}

// --- source registry -----------------------------------------------------
// Everything the shared sync core (syncBatch/reconcileAndSync) and the
// continuous-sync orchestrator need to know to run a source. The pure
// planning helpers in continuous_sync.js (planIncremental, selectWantedToSync,
// computeWatermarkAfter, applyResult, shouldRun, badgeStateAfter, nextBackoff,
// planDeepReconcile, filterSkippedConversations) are reused UNCHANGED by every
// source — they only ever look at {uuid, updated_at}.
const SOURCES = {
  claude: {
    name: 'claude',
    stateKey: 'continuousSync',
    // Two gates, parallel to chatgpt: claudeEnabled (the source on/off,
    // DEFAULT ON when absent so existing installs keep working) AND the
    // continuousSync background-wake sub-toggle.
    isEnabled: (scry) => scry.claudeEnabled !== false && scry.continuousSync !== false,
    configure: async (scry) => {
      const orgId = await readOrgIdFromStorage();
      return { configured: Boolean(scry && scry.url && orgId), ctx: { orgId } };
    },
    enumerate: (ctx) => listClaudeConversations(ctx.orgId),
    syncOne: (ctx, item, scry) => syncOneConversation(ctx.orgId, item.uuid, scry),
    reconcile: (scry, items) => reconcileWithScry(scry, items),
    errorDomain: _domainForError,
    isStubError: isStubFetchError,
    // No isSignedOutError: claude.ai auth is cookie-based and has no
    // "signed out" state distinct from an ordinary claude-domain failure.
  },
  chatgpt: {
    name: 'chatgpt',
    stateKey: 'continuousSync:chatgpt',
    // Two gates, unlike claude's single default-on toggle: chatgptEnabled
    // (DEFAULT FALSE when absent — an existing install must not start hitting
    // chatgpt.com on its next wake just because this shipped) AND the
    // continuous-sync sub-toggle (default-on once the source itself is on).
    isEnabled: (scry) => scry.chatgptEnabled === true && scry.chatgptContinuousSync !== false,
    // Back-off (see the tuning block at the top of chatgpt_adapter.js):
    // batches run one conversation at a time; a deep pass pushes at most
    // deepSlice conversations (the rest is caught up by scheduled passes);
    // each wake starts with a clean cooldown count, carries an unexpired
    // cooldown into nextAllowedAt, and aborts its batch after
    // CHATGPT_ABORT_AFTER_COOLDOWNS cooldowns.
    concurrency: _CG.CHATGPT_BATCH_CONCURRENCY,
    deepSlice: _CG.CHATGPT_DEEP_SLICE,
    beginWake: () => _CG.gate().resetRun(),
    cooldownState: () => _CG.gate().getState(),
    // Persisted-cooldown plumbing (continuous_sync.js): restore the gate's
    // cooldown/level at wake start, be told the moment a 429 starts one, and
    // be ticked from the gate's keepalive during long waits (heartbeat).
    seedCooldown: (persisted) => _CG.gate().seed(persisted),
    onCooldown: (cb) => { _CG.gate().setOnCooldown(cb); return () => _CG.gate().setOnCooldown(null); },
    onKeepalive: (cb) => { _CG.gate().setOnKeepalive(cb); return () => _CG.gate().setOnKeepalive(null); },
    abortSignal: () => cooldownAbortSignal(() => _CG.gate().getState(), _CG.CHATGPT_ABORT_AFTER_COOLDOWNS),
    // Unlike claude, "configured" here does NOT check auth — a missing/expired
    // chatgpt.com session is the SEPARATE signed-out path, checked per wake by
    // enumerate() below, not a persistent configuration gate.
    configure: async (scry) => ({ configured: Boolean(scry && scry.url), ctx: {} }),
    // `hint.watermark` (set by the incremental wake) lets enumeration stop at
    // the first page that reaches the watermark instead of listing the whole
    // account every 15 minutes. Absent (deep reconcile, dashboard) → full list.
    enumerate: async (ctx, hint = {}) => {
      const token = await getChatGptAccessToken();
      ctx.token = token; // one auth/session call per wake; syncOne reuses it
      const items = hint && hint.watermark
        ? await listChatGptConversationsSince(token, hint.watermark)
        : await listAllChatGptConversations(token);
      return items.map(normalizeChatGptListItem);
    },
    // `ctx.wantImages` (default true — matches continuous sync's original
    // "images always included" behavior) lets the manual ChatGPT page opt
    // OUT via its "Include image bytes" checkbox without a second copy of
    // this function. A per-image fetch failure is recorded on the returned
    // `imageFailures` but never fails the push — capture-fidelity gaps on
    // images are reported, not treated as a reason to drop the conversation.
    //
    // `ctx.onStatus(text)`, when present (set by sync_core.js's syncBatch from
    // its `opts.onStatus`), gets the SUB-item status the phase-2 refactor into
    // the shared sync core dropped: "rate limited — waiting Ns" while
    // fetchChatGptConversation backs off a 429, and "files N/M" while each
    // image is fetched. Both are best-effort UI hints — never called when no
    // caller asked for them.
    syncOne: async (ctx, item, scry) => {
      const token = ctx.token || await getChatGptAccessToken();
      const body = await withChatGptRateLimitRetry(
        () => fetchChatGptConversation(token, item.uuid),
        ctx.onStatus ? { onRetry: (ms) => ctx.onStatus(`rate limited — waiting ${Math.round(ms / 1000)}s`) } : {}
      );
      const wantImages = ctx.wantImages !== false;
      let blobs = [];
      let imageFailures = [];
      if (wantImages) {
        const total = collectChatGptImagePointers(body, { wholeTree: true }).length
          + (typeof collectChatGptDocumentAttachments === 'function'
            ? collectChatGptDocumentAttachments(body, { wholeTree: true }).length : 0);
        let done = 0;
        const onEach = ctx.onStatus
          ? () => { done++; ctx.onStatus(`files ${done}/${total}`); }
          : undefined;
        const got = await fetchChatGptFileBlobs(token, body, null, onEach);
        blobs = got.blobs;
        imageFailures = got.failures;
      }
      const payload = buildChatGptIngestPayload(body, blobs, item.uuid);
      const resp = await withRetry(
        () => postToScry(scry, payload),
        { retries: 2, delayMs: 500, shouldRetry: ({ threw, result }) => threw || (result && result.status >= 500) }
      );
      if (!resp.ok) throw new Error(`ingest HTTP ${resp.status}`);
      if (!resp.body || !resp.body.success) {
        throw new Error((resp.body && resp.body.error) || 'ingest rejected');
      }
      return {
        status: resp.body.status,
        filesStored: typeof resp.body.files_stored === 'number' ? resp.body.files_stored : 0,
        imageFailures,
      };
    },
    reconcile: (scry, items) => reconcileWithScry(scry, items, 'chatgpt'),
    errorDomain: chatgptErrorDomain,
    isStubError: () => false, // ChatGPT has no soft-empty-stub concept.
    isSignedOutError: isChatGptSignedOutError,
  },
};
const SOURCE_ORDER = ['claude', 'chatgpt'];

// Browser: expose globally (loaded via a <script> tag / importScripts, before
// sync_core.js and continuous_sync.js everywhere). Node (vitest): export.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SOURCES,
    SOURCE_ORDER,
    cooldownAbortSignal,
    normalizeChatGptListItem,
    isChatGptSignedOutError,
    chatgptErrorDomain,
    _domainForError,
    isStubFetchError,
    classifyStubAfterReconcile,
  };
}
