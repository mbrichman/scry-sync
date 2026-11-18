// ISOLATED-world export driver on https://claude.ai/artifact/* (registered with
// the relay, only while a capture tab is open). Drives Claude's OWN Export menu:
// dismiss the tip, open the title menu, click "Export", read the offered
// formats, click the wanted format button(s) and collect the files the MAIN
// script captures. It never inspects or logs titles/contents/bytes.
//
// SAFETY: every click goes through guardedClick(), which checks an allow-list of
// (kind, role, accessible name). The only things this script will ever click:
//   title    - the button in the "Artifact controls" banner named like the artifact
//   export   - the menuitem named exactly "Export"
//   format   - a button inside the export dialog whose name starts "Markdown", "PDF" or "PNG"
//   dismiss  - the button "Dismiss" inside the "Duplicate this artifact" tip dialog
//   close    - the button "Close" inside a dialog
// Delete / Rename / Duplicate / Share / Permissions / Word / anything else throws.
(() => {
  const FORMAT_PREFIXES = { markdown: 'markdown', pdf: 'pdf', png: 'png' };
  const WANTED_PREFIXES = ['Markdown', 'PDF', 'PNG'];
  const DENY = /^(share|pin|rename|duplicate|refresh|permissions|delete|word|more formats|show all comments|version history|open in desktop app)\b/i;
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

  function roleOf(el) {
    const r = el && el.getAttribute && el.getAttribute('role');
    if (r) return String(r).toLowerCase();
    const tag = String((el && el.tagName) || '').toLowerCase();
    return tag === 'button' ? 'button' : tag;
  }
  function nameOf(el) {
    const a = el && el.getAttribute && el.getAttribute('aria-label');
    return norm(a || (el && el.textContent) || '');
  }
  // "Markdown , Plain-text .md file" -> 'markdown'; Word -> 'word'; unknown -> null.
  function formatKeyOf(name) {
    const n = norm(name).toLowerCase();
    for (const [k, p] of Object.entries(FORMAT_PREFIXES)) if (n.startsWith(p)) return k;
    if (n.startsWith('word')) return 'word';
    return null;
  }
  function titleMatches(name, title) {
    const a = norm(name).toLowerCase();
    const b = norm(title).toLowerCase();
    if (!a || !b) return false;
    return a === b || (Math.min(a.length, b.length) >= 8 && (a.startsWith(b) || b.startsWith(a)));
  }
  // Pure allow-list. `ctx` = { title, inBanner, inTipDialog, inDialog }.
  function clickAllowed(kind, role, name, ctx = {}) {
    const n = norm(name);
    switch (kind) {
      case 'title': return role === 'button' && ctx.inBanner === true && titleMatches(n, ctx.title) && !DENY.test(n);
      case 'export': return role === 'menuitem' && n === 'Export';
      case 'format': return role === 'button' && ctx.inDialog === true && WANTED_PREFIXES.some((p) => n.startsWith(p)) && !DENY.test(n);
      case 'dismiss': return role === 'button' && ctx.inTipDialog === true && n === 'Dismiss';
      case 'close': return role === 'button' && ctx.inDialog === true && n === 'Close';
      default: return false;
    }
  }
  // Which formats to take, given the offered keys. Never Word.
  function selectExportFormats(offered) {
    const o = new Set(offered || []);
    const wanted = [];
    let subtype = null;
    if (o.has('markdown')) { subtype = 'document'; wanted.push('markdown'); if (o.has('pdf')) wanted.push('pdf'); }
    else if (o.has('png')) { subtype = 'whiteboard'; wanted.push('png'); }
    return { wanted, subtype };
  }
  function fileMatchesFormat(fmt, file) {
    const ct = String((file && file.content_type) || '').split(';')[0].trim().toLowerCase();
    const fn = String((file && file.filename) || '').toLowerCase();
    if (fmt === 'markdown') return ['text/markdown', 'text/x-markdown', 'text/plain'].includes(ct) || /\.(md|markdown)$/.test(fn);
    if (fmt === 'pdf') return ct === 'application/pdf' || fn.endsWith('.pdf');
    if (fmt === 'png') return ct === 'image/png' || fn.endsWith('.png');
    return false;
  }

  function create(env) {
    const doc = env.document;
    const sleep = env.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const now = env.now || Date.now;
    const post = env.post;            // (msg) -> void : talks to the MAIN script (arm / disarm)
    const files = [];                 // everything the MAIN script reported
    const names = new Map();          // id -> filename (export_name)
    const clicks = [];                // kinds of the clicks made (never names)

    function onMainMessage(d) {
      if (!d) return;
      if (d.type === 'export_file') files.push({ id: d.id, via: d.via, content_type: d.content_type, size: d.size, filename: d.filename || names.get(d.id) || null, too_large: d.too_large, b64: d.b64 });
      else if (d.type === 'export_name') {
        names.set(d.id, d.filename);
        const f = files.find((x) => x.id === d.id);
        if (f && !f.filename) f.filename = d.filename;
      }
    }

    const all = (root) => Array.from((root || doc).querySelectorAll('*'));
    const within = (el, pred) => { for (let p = el; p; p = p.parentElement) if (pred(p)) return true; return false; };
    const isDialog = (el) => roleOf(el) === 'dialog';
    const dialogs = () => all().filter(isDialog);
    const tipDialog = () => dialogs().find((d) => /duplicate this artifact/i.test(norm(d.textContent))) || null;
    const exportDialog = () => dialogs().find((d) => /download as/i.test(norm(d.textContent)) || all(d).some((e) => roleOf(e) === 'radio' && nameOf(e) === 'Export')) || null;
    const isBanner = (el) => /artifact controls/i.test(norm(el.getAttribute && el.getAttribute('aria-label')));

    function guardedClick(kind, el, extra = {}) {
      const role = roleOf(el);
      const name = nameOf(el);
      const ctx = {
        title: extra.title,
        inBanner: within(el, isBanner),
        inTipDialog: within(el, (p) => isDialog(p) && /duplicate this artifact/i.test(norm(p.textContent))),
        inDialog: within(el, isDialog),
      };
      if (!clickAllowed(kind, role, name, ctx)) throw new Error('blocked_click');
      clicks.push(kind);
      el.click();
    }

    async function waitFor(fn, ms, step = 200) {
      const t0 = now();
      for (;;) {
        const v = fn();
        if (v) return v;
        if (now() - t0 >= ms) return null;
        await sleep(step);
      }
    }

    async function dismissTip() {
      const tip = tipDialog();
      if (!tip) return;
      const btn = all(tip).find((e) => roleOf(e) === 'button' && nameOf(e) === 'Dismiss');
      if (btn) { guardedClick('dismiss', btn); await sleep(200); }
    }

    const menuExportItem = () => all().find((e) => roleOf(e) === 'menuitem' && nameOf(e) === 'Export') || null;
    const titleButton = (title) => {
      const banner = all().find(isBanner);
      if (!banner) return null;
      return all(banner).find((e) => roleOf(e) === 'button' && titleMatches(nameOf(e), title)) || null;
    };
    const formatButtons = () => {
      const d = exportDialog();
      return d ? all(d).filter((e) => roleOf(e) === 'button' && formatKeyOf(nameOf(e))) : [];
    };

    // Open the export dialog from scratch (tip, title button, Export item).
    async function openExportDialog(title, timeoutMs) {
      if (exportDialog()) return null;
      await dismissTip();
      const tb = await waitFor(() => titleButton(title), timeoutMs);
      if (!tb) return 'title_button_not_found';
      guardedClick('title', tb, { title });
      const item = await waitFor(menuExportItem, 5000);
      if (!item) return 'menu_not_opened';
      guardedClick('export', item);
      const d = await waitFor(exportDialog, 5000);
      if (!d) return 'dialog_not_found';
      await dismissTip();
      return null;
    }

    async function closeDialog() {
      const d = exportDialog();
      if (!d) return;
      const btn = all(d).find((e) => roleOf(e) === 'button' && nameOf(e) === 'Close');
      if (btn) { guardedClick('close', btn); await sleep(200); }
    }

    async function waitForFile(fmt, mark, ms) {
      const t0 = now();
      for (;;) {
        const f = files.slice(mark).find((x) => fileMatchesFormat(fmt, x));
        if (f) {
          if (!f.filename) await sleep(300);   // the anchor's filename may trail the blob
          return f;
        }
        if (now() - t0 >= ms) return null;
        await sleep(200);
      }
    }

    // opts: { title, timeoutMs, onlyFormats?: [...] , loadMs }
    async function run(opts = {}) {
      const timeoutMs = opts.timeoutMs || 20000;
      const out = { offered: [], subtype: null, captured: [], failed: [], clicks };
      post({ type: 'arm' });
      try {
        const err = await openExportDialog(opts.title, opts.loadMs || 20000);
        if (err) { out.failed.push({ format: '*', reason: err }); return out; }
        const keys = new Set();
        for (const b of formatButtons()) { const k = formatKeyOf(nameOf(b)); if (k) keys.add(k); }
        out.offered = Array.from(keys);
        const sel = selectExportFormats(out.offered);
        out.subtype = sel.subtype;
        const wanted = opts.onlyFormats ? sel.wanted.filter((f) => opts.onlyFormats.includes(f)) : sel.wanted;
        for (const fmt of wanted) {
          const reopen = await openExportDialog(opts.title, 10000);
          if (reopen) { out.failed.push({ format: fmt, reason: reopen }); continue; }
          const btn = formatButtons().find((b) => formatKeyOf(nameOf(b)) === fmt);
          if (!btn) { out.failed.push({ format: fmt, reason: 'format_button_not_found' }); continue; }
          const mark = files.length;
          guardedClick('format', btn);
          const f = await waitForFile(fmt, mark, timeoutMs);
          if (!f) { out.failed.push({ format: fmt, reason: 'timeout' }); continue; }
          if (f.too_large || !f.b64) { out.failed.push({ format: fmt, reason: f.too_large ? 'too_large' : 'no_bytes' }); continue; }
          out.captured.push({ format: fmt, content_type: f.content_type, size: f.size, via: f.via, b64: f.b64 });
        }
        await closeDialog();
      } catch (e) {
        out.failed.push({ format: '*', reason: e && e.message === 'blocked_click' ? 'blocked_click' : 'driver_error' });
      } finally {
        post({ type: 'disarm' });
      }
      return out;
    }
    return { run, onMainMessage, clicks };
  }

  const api = { create, clickAllowed, selectExportFormats, fileMatchesFormat, formatKeyOf, titleMatches, WANTED_PREFIXES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof globalThis !== 'undefined') globalThis.ScryArtifactExport = api;
})();
