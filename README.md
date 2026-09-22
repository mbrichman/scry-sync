# Scry Sync

A Chrome extension that pushes your **Claude.ai** and **ChatGPT** conversations — verbatim, with their image bytes and original files — into your own [Scry](https://github.com/mbrichman/scry) instance. Sync-only by design: Scry is the archive.

Chrome only. (The Firefox tree was retired in v2.8.0.)

## What it does

- **Claude.ai** — sync the open conversation from the popup, or bulk-sync from the dashboard; continuous background sync every 15 minutes plus a daily reconcile against Scry; a server-gated **delete-from-Claude** flow that only removes what Scry has proven it holds completely.
- **ChatGPT** — opt-in (Options → *Enable ChatGPT*). Push selected conversations from the ChatGPT page, or let continuous background sync handle new ones. Images generated in the conversation are captured as files. Capture only: no delete path until Scry can prove a ChatGPT capture completely enough to delete against.
- Everything runs in your browser against the sites you are already signed in to. Nothing is sent anywhere except your Scry.

## Setup

1. Load `chrome/` as an unpacked extension (`chrome://extensions` → *Load unpacked*).
2. Open the extension's Options: set your Scry URL and service token, then enable the sources you use.
3. Sign in to claude.ai and/or chatgpt.com in this browser profile.

After updating the extension, also terminate its service worker (or toggle the extension off and on) — an MV3 reload does not refresh the running background worker.

## Development

- Pure helpers are unit-tested with vitest: `npx vitest run` from the repo root.
- Changes land via a PR reviewed before merge; see `docs/CHANGELOG.md` for history and `docs/TODO.md` for what is pending.
