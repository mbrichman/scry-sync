# Scry Sync — Development Guide

Chrome extension (MV3, `chrome/`) that pushes Claude.ai and ChatGPT conversations into the owner's Scry instance. **Sync-only** (no file export — Scry is the archive) and **Chrome-only** (the Firefox tree was retired in v2.8.0). The server side lives in the `scry` repo; its `CLAUDE.md` and decision trace govern any change that touches the ingest / reconcile / verify contracts.

## Layout

- `chrome/manifest.json` — the only manifest. Bump `"version"` on every user-visible change.
- `chrome/utils.js` — pure Claude helpers (branch walk, model names, file collection) + shared pure utilities (`mergeStorageData`, `mergeScrySetting`) + backup/restore + diagnostics.
- `chrome/scry_sync.js` — pure sync helpers: `buildIngestPayload`, `withRetry`, `runPool`, selection.
- `chrome/scry_client.js` — impure: Scry HTTP (`postToScry`, `reconcileWithScry(scry, items, sourceType)`, `verifyDeletableWithScry`), Claude fetchers (`listClaudeConversations`, `fetchConversationBody`, org-id auto-detect — `detectClaudeOrgId`/`selectClaudeOrgId`, no tab relay), and the continuous-sync status-line helpers shared by the popup and the dashboard footer (`formatRelativeTime`, `formatSourceStatus`, `getContinuousSyncStates`).
- `chrome/chatgpt_adapter.js` — ChatGPT source: pure transforms + impure chatgpt.com fetchers (`getChatGptAccessToken`, `listAllChatGptConversations`, `fetchChatGptConversation`, `fetchChatGptFileBlobs` — bounded pool, default concurrency 3 — `buildChatGptIngestPayload`). `buildChatGptFileBlob` recovers a real image mime (magic-byte sniff, then file_name extension) when chatgpt.com's byte response carries none.
- `chrome/sources.js` — the `SOURCES` registry (`claude`, `chatgpt`): everything the shared sync core and the continuous-sync orchestrator need to enumerate / sync-one / reconcile / classify errors for a source, plus each source's error-classification helpers. `SOURCES.chatgpt.syncOne` reports sub-item status ("images N/M", "rate limited — waiting Ns") via `ctx.onStatus` when a caller sets one.
- `chrome/sync_core.js` — the shared sync core: `syncBatch`/`reconcileAndSync`, the ONE implementation of "sync a batch for a source", used by the dashboard, the popup, and the continuous engine. `syncBatch`'s `opts.onStatus` is attached to `ctx.onStatus` for the call's duration.
- `chrome/dashboard_model.js` — pure model behind the unified dashboard: which source tabs to show (`visibleSourceTabs`), tab labels (`tabLabel`), row mapping (`toRow`), the synced-status badge (`syncedBadge`), and the popup's site-detection helper (`detectSyncTarget`).
- `chrome/continuous_sync.js` — the background engine: pure planning/state machine + `runAllContinuousSyncs`. Loaded by `background.js` via `importScripts` (order matters: `utils`, `scry_sync`, `scry_client`, `chatgpt_adapter`, `sources`, `sync_core`, `continuous_sync`).
- `chrome/background.js` — alarms (15-min incremental, daily deep reconcile).
- `chrome/browse.*` — the unified dashboard (one page, a tab per visible source: Claude always on, ChatGPT only when enabled in Options and not signed out of chatgpt.com). Claude enumeration is a direct credentialed fetch (`listClaudeConversations`/`detectClaudeOrgId`), not a claude.ai tab relay. Load order: `utils`, `scry_sync`, `scry_client`, `chatgpt_adapter`, `sources`, `sync_core`, `dashboard_model`, `browse`.
- `chrome/popup.*` — site-aware sync: detects claude.ai vs. chatgpt.com from the active tab (`dashboard_model.detectSyncTarget`) and syncs via `SOURCES[source].syncOne`. Load order: `popup-theme`, `utils`, `scry_sync`, `scry_client`, `chatgpt_adapter`, `sources`, `dashboard_model`, `popup`.
- `chrome/options.*` — Scry connection (URL/token/concurrency, its own Save) + a Sources block (Claude: org id auto-detected/editable + continuous sync; ChatGPT: enable + continuous sync — each Sources checkbox persists itself immediately via `mergeScrySetting`, no separate Save step) + Backup & Restore + Model Display (Claude only).
- The standalone ChatGPT page (`chrome/chatgpt.html`/`chrome/chatgpt.js`) was retired — folded into the dashboard's ChatGPT tab. `chrome/jszip.min.js` stays: `background.js` still injects it into claude.ai tabs alongside `content.js`, even though nothing calls into it anymore.
- `tests/` — vitest over the pure surface. Run `npx vitest run` from the repo root.

## Rules

- **Bodies go to Scry verbatim.** Never prune a conversation client-side (Claude branch or ChatGPT `mapping`); Scry prunes server-side so import and fidelity verification agree by construction.
- **File bytes travel as `files[]`** — `{ file_uuid, file_name, file_type, file_variant, data }`. For ChatGPT, `file_uuid` is the asset id after `://` (`file_<hex>` / `file-<b62>`), matching Scry's `extract_asset_id`; that is the key Scry links the message's image record to.
- **Adding a source = implementing the `SOURCES` contract** (enumerate → `{uuid, updated_at, title}`, syncOne, reconcile, errorDomain, isStubError, optional isSignedOutError, own `stateKey`, `isEnabled`). Do not add a second orchestrator.
- **Sources are opt-in per user.** Claude is on by default; every other source defaults off (`scry.<source>Enabled`).
- **Capture only for ChatGPT.** No delete-from-ChatGPT until Scry's `verify-deletable` can prove a `mapping` capture. Claude's delete flow stays server-authoritative: Scry clears an id in the same run it is deleted.
- **Failures must be visible.** A per-item failure that only reaches `console.warn` reads as success to the user (v2.7.2 shipped that way and "images aren't coming over" was the result). Surface counts and the first error in the status line.
- **MV3 gotcha:** reloading the extension does NOT refresh the running service worker. After changing anything `background.js` imports, terminate the SW on `chrome://extensions` (or toggle the extension off/on). Diagnostic: manual path works, continuous doesn't ⇒ stale SW.
- **Test-first** for pure helpers; when a fetcher is involved, stub `global.fetch` as `tests/chatgpt_adapter.test.js` does. Mutation-check new tests (revert the product line, confirm the test fails).
- **Commit/push only when asked.** PRs need the same dual clearance as the `scry` repo (code-reviewer + Oracle GATE) before merge. Record merges and reversals in the scry decision trace.
- Keep `docs/CHANGELOG.md` current (one `## [X.Y.Z]` entry per version) and move finished items in `docs/TODO.md`.

## Live-measured facts worth not re-deriving

- chatgpt.com media: `GET backend-api/files/:id/download` is the route that returns a signed URL for image_gen `sediment://` assets; `files/download/:id` and the conversation-scoped attachment route 404. The signed URL is on chatgpt.com itself and needs the session (cookies + bearer); `*.oaiusercontent.com` URLs are signature-authorised and reject credentials.
- A pointer on an off-branch (regenerated-away) node 404s everywhere; that is expected, not a failure.
- `/api/auth/session` failing = not signed in; treat as "do nothing", not as a failure streak.
