// Tests for the export capture (v3.7.0): the allow-listed UI driver, the MAIN-world
// capture wrappers, the tab/window flow, payload pieces and the planner.
// Synthetic fixtures only; no real claude.ai / Scry.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
const nodeCrypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');
const A = require('../chrome/artifacts.js');
const X = require('../chrome/artifact_export_ui.js');
const scriptingStub = { registerContentScripts: vi.fn(async () => {}), unregisterContentScripts: vi.fn(async () => {}) };
globalThis.chrome = { scripting: scriptingStub };

const sha = (buf) => nodeCrypto.createHash('sha256').update(buf).digest('hex');
const b64 = (s) => Buffer.from(s).toString('base64');
const MD = 'synthetic # markdown';
const PDF = '%PDF-1.7 synthetic';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';

// ---------- a tiny fake DOM ----------
class El {
  constructor(tag, attrs = {}, text = '') { this.tagName = tag.toUpperCase(); this.attrs = attrs; this.text = text; this.children = []; this.parentElement = null; this.onclick = null; }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  get textContent() { return this.text + this.children.map((c) => c.textContent).join(' '); }
  add(c) { c.parentElement = this; this.children.push(c); return c; }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((c) => c !== this); this.parentElement = null; }
  querySelectorAll() { const out = []; const walk = (e) => { for (const c of e.children) { out.push(c); walk(c); } }; walk(this); return out; }
  click() { if (this.onclick) this.onclick(); }
}

// A page that behaves like Claude's artifact view. `formats` = button names in the dialog.
function mkPage({ title = 'Synthetic Title', formats, tip = false, driverRef, files = {}, noFile = [], sharePane = false }) {
  const root = new El('body');
  const clicked = [];
  const track = (el, label) => { const o = el.onclick; el.onclick = () => { clicked.push(label); o && o(); }; return el; };
  const banner = root.add(new El('header', { 'aria-label': 'Artifact controls' }));
  let menu = null;
  let dialog = null;
  const titleBtn = banner.add(new El('button', {}, title));
  titleBtn.onclick = () => {
    menu = root.add(new El('div', { role: 'menu', 'aria-label': 'Artifact options' }));
    for (const n of ['Share', 'Export', 'Pin', 'Rename', 'Duplicate', 'Refresh', 'Permissions', 'Delete']) {
      const mi = menu.add(new El('div', { role: 'menuitem' }, n));
      mi.onclick = () => {
        if (n !== 'Export') return;
        menu.remove();
        dialog = root.add(new El('div', { role: 'dialog' }));
        const rg = dialog.add(new El('div', { role: 'radiogroup', 'aria-label': 'Share or export' }));
        const exportRadio = rg.add(new El('div', { role: 'radio' }, 'Export'));
        const list = new El('ul', {}, 'Download as');
        if (sharePane) {
          rg.add(new El('div', { role: 'radio', 'aria-checked': 'true' }, 'Share'));
          dialog.add(new El('button', {}, 'Copy private link'));
          dialog.add(new El('button', { role: 'switch' }, 'Show in Artifacts list'));
          dialog.add(new El('button', {}, 'Invite'));
          dialog.add(new El('input', { role: 'textbox', 'aria-label': 'Add people' }));
          exportRadio.onclick = () => { dialog.add(list); };
        } else dialog.add(list);
        for (const f of formats) {
          const key = f.toLowerCase().split(/[ ,]/)[0];
          const b = list.add(new El('button', {}, f));
          b.onclick = () => {
            const file = files[key];
            if (file && !noFile.includes(key)) setTimeout(() => driverRef.current.onMainMessage({ type: 'export_file', id: Math.random(), via: 'blob', ...file }), 5);
          };
        }
        dialog.add(new El('button', {}, 'Close')).onclick = () => { dialog.remove(); dialog = null; };
      };
    }
  };
  if (tip) {
    const t = root.add(new El('div', { role: 'dialog' }, 'Duplicate this artifact'));
    t.add(new El('button', {}, 'Got it'));
    t.add(new El('button', {}, 'Dismiss')).onclick = () => t.remove();
  }
  // record every click by accessible name (test-side spy over the whole tree)
  const spy = () => { for (const e of root.querySelectorAll()) if (!e.__spied) { e.__spied = true; const o = e.onclick; e.onclick = () => { clicked.push((e.getAttribute('role') || e.tagName.toLowerCase()) + ':' + e.textContent.replace(/\s+/g, ' ').trim()); o && o(); }; } };
  return { document: { querySelectorAll: () => { spy(); return root.querySelectorAll(); } }, clicked, root };
}
const DOC_FORMATS = ['Word , Editable .docx document', 'PDF , Document for printing and sharing', 'Markdown , Plain-text .md file', 'More formats and apps'];
const DOC_FILES = { markdown: { content_type: 'text/markdown', size: MD.length, b64: b64(MD) }, pdf: { content_type: 'application/pdf', size: PDF.length, b64: b64(PDF) } };

function mkDriver(page, extra = {}) {
  const ref = {};
  const posts = [];
  const d = X.create({ document: page.document, post: (m) => posts.push(m), sleep: async (ms) => { await new Promise((r) => setTimeout(r, Math.min(ms, 2))); }, ...extra });
  ref.current = d;
  return { d, ref, posts };
}

describe('click allow-list (pure)', () => {
  it('permits only the five kinds, by role and accessible name', () => {
    const ok = { inBanner: true, inDialog: true, inTipDialog: true, title: 'My Long Title' };
    expect(X.clickAllowed('title', 'button', 'My Long Title', ok)).toBe(true);
    expect(X.clickAllowed('title', 'button', 'My Long Title', { ...ok, inBanner: false })).toBe(false);
    expect(X.clickAllowed('title', 'button', 'Delete', { ...ok, title: 'Delete' })).toBe(false);
    expect(X.clickAllowed('export', 'menuitem', 'Export')).toBe(true);
    for (const n of ['Share', 'Pin', 'Rename', 'Duplicate', 'Refresh', 'Permissions', 'Delete', 'Show all comments', 'Version history', 'Open in desktop app']) {
      expect(X.clickAllowed('export', 'menuitem', n)).toBe(false);
      expect(X.clickAllowed('format', 'button', n, ok)).toBe(false);
    }
    expect(X.clickAllowed('export', 'button', 'Export')).toBe(false);          // wrong role
    expect(X.clickAllowed('format', 'button', 'Markdown , Plain-text .md file', ok)).toBe(true);
    expect(X.clickAllowed('format', 'button', 'PDF , Document', ok)).toBe(true);
    expect(X.clickAllowed('format', 'button', 'PNG', ok)).toBe(true);
    expect(X.clickAllowed('format', 'button', 'Word , Editable .docx document', ok)).toBe(false);
    expect(X.clickAllowed('format', 'button', 'More formats and apps', ok)).toBe(false);
    expect(X.clickAllowed('dismiss', 'button', 'Dismiss', ok)).toBe(true);
    expect(X.clickAllowed('dismiss', 'button', 'Got it', ok)).toBe(false);
    expect(X.clickAllowed('dismiss', 'button', 'Dismiss', { ...ok, inTipDialog: false })).toBe(false);
    expect(X.clickAllowed('close', 'button', 'Close', ok)).toBe(true);
    expect(X.clickAllowed('close', 'button', 'Close', { ...ok, inDialog: false })).toBe(false);
    expect(X.clickAllowed('anything-else', 'button', 'Export', ok)).toBe(false);
  });
  it('format selection never includes Word', () => {
    expect(X.selectExportFormats(['word', 'pdf', 'markdown'])).toEqual({ wanted: ['markdown', 'pdf'], subtype: 'document' });
    expect(X.selectExportFormats(['markdown'])).toEqual({ wanted: ['markdown'], subtype: 'document' });
    expect(X.selectExportFormats(['png'])).toEqual({ wanted: ['png'], subtype: 'whiteboard' });
    expect(X.selectExportFormats(['word'])).toEqual({ wanted: [], subtype: null });
    expect(X.formatKeyOf('Word , Editable')).toBe('word');
  });
});

const clk = () => { let t = 0; return { now: () => t, sleep: async (ms) => { t += ms; await new Promise((r) => setTimeout(r, 0)); } }; };
describe('export driver (fake DOM)', () => {
  it('document type: dismisses the tip, exports Markdown and PDF, never Word, never touches other items', async () => {
    const ref = {};
    const page = mkPage({ formats: DOC_FORMATS, tip: true, driverRef: ref, files: DOC_FILES });
    const { d, ref: r, posts } = mkDriver(page);
    ref.current = d;
    const res = await d.run({ title: 'Synthetic Title', timeoutMs: 500, loadMs: 200 });
    expect(res.offered.sort()).toEqual(['markdown', 'pdf', 'word']);
    expect(res.subtype).toBe('document');
    expect(res.captured.map((c) => c.format)).toEqual(['markdown', 'pdf']);
    expect(res.failed).toEqual([]);
    expect(posts.map((p) => p.type)).toEqual(['arm', 'disarm']);
    // the ONLY things clicked, by role:name prefix
    const names = page.clicked;
    expect(names[0]).toBe('button:Dismiss');
    expect(names.filter((n) => /Delete|Rename|Duplicate|Share|Permissions|Pin|Refresh|Word|More formats|Got it/.test(n))).toEqual([]);
    expect(names.some((n) => n.startsWith('button:Synthetic Title'))).toBe(true);
    expect(names.some((n) => n === 'menuitem:Export')).toBe(true);
    expect(names.filter((n) => n.startsWith('button:Markdown')).length).toBe(1);
    expect(names.filter((n) => n.startsWith('button:PDF')).length).toBe(1);
    expect(names.at(-1)).toBe('button:Close');
    expect(new Set(res.clicks)).toEqual(new Set(['dismiss', 'title', 'export', 'format', 'close']));
  });

  it('whiteboard: only the PNG row', async () => {
    const ref = {};
    const page = mkPage({ formats: ['PNG'], driverRef: ref, files: { png: { content_type: 'image/png', size: 7, b64: PNG.toString('base64') } } });
    const { d } = mkDriver(page);
    ref.current = d;
    const res = await d.run({ title: 'Synthetic Title', timeoutMs: 500, loadMs: 200 });
    expect(res.subtype).toBe('whiteboard');
    expect(res.captured.map((c) => c.format)).toEqual(['png']);
  });

  it('a format that produces no file times out and is reported', async () => {
    const ref = {};
    const page = mkPage({ formats: DOC_FORMATS, driverRef: ref, files: DOC_FILES, noFile: ['pdf'] });
    const { d } = mkDriver(page);
    ref.current = d;
    const res = await d.run({ title: 'Synthetic Title', timeoutMs: 40, loadMs: 200 });
    expect(res.captured.map((c) => c.format)).toEqual(['markdown']);
    expect(res.failed).toEqual([{ format: 'pdf', reason: 'timeout' }]);
  });

  it('title button not found / blob of the wrong type is ignored', async () => {
    const ref = {};
    const page = mkPage({ title: 'Some Other Title', formats: DOC_FORMATS, driverRef: ref, files: DOC_FILES });
    const { d } = mkDriver(page);
    ref.current = d;
    const res = await d.run({ title: 'Totally Different', timeoutMs: 30, loadMs: 20 });
    expect(res.failed).toEqual([{ format: '*', reason: 'title_button_not_found' }]);
    expect(page.clicked).toEqual([]);
    // a pdf-typed blob does not satisfy a markdown request
    const ref2 = {};
    const page2 = mkPage({ formats: ['Markdown , x'], driverRef: ref2, files: { markdown: { content_type: 'application/pdf', size: 3, b64: 'AAAA' } } });
    const m = mkDriver(page2);
    ref2.current = m.d;
    const r2 = await m.d.run({ title: 'Synthetic Title', timeoutMs: 40, loadMs: 200 });
    expect(r2.failed).toEqual([{ format: 'markdown', reason: 'timeout' }]);
  });

  it('menu that ignores click() but opens on a pointer press: pointer fallback on the same button', async () => {
    const ref = {};
    const page = mkPage({ formats: DOC_FORMATS, driverRef: ref, files: DOC_FILES });
    const banner = page.root.children[0];
    const tb = banner.children[0];
    const open = tb.onclick;
    tb.onclick = null;                                   // click() does nothing
    const seen = [];
    tb.dispatchEvent = (ev) => { seen.push(ev.type); if (ev.type === 'pointerdown') open(); return true; };
    class Ev { constructor(type, o) { this.type = type; Object.assign(this, o); } }
    page.document.defaultView = { MouseEvent: Ev, PointerEvent: Ev, KeyboardEvent: Ev };
    const { d } = mkDriver(page, clk());
    ref.current = d;
    const res = await d.run({ title: 'Synthetic Title', timeoutMs: 1e7, loadMs: 200 });   // fake clock: file delivery is real-time
    expect(res.failed).toEqual([]);
    expect(res.captured.map((c) => c.format)).toEqual(['markdown', 'pdf']);
    expect(res.clicks).toContain('title:pointer');
    expect(seen[0]).toBe('pointerdown');
    expect(res.probe.map((p) => p.stage).slice(0, 3)).toEqual(['before', 'after_click', 'after_pointer']);
  });

  it('menu that never opens: menu_not_opened with a probe of every stage, nothing else clicked', async () => {
    const ref = {};
    const page = mkPage({ formats: DOC_FORMATS, driverRef: ref, files: DOC_FILES });
    const tb = page.root.children[0].children[0];
    tb.onclick = null;
    tb.dispatchEvent = () => true;
    class Ev { constructor(type, o) { this.type = type; Object.assign(this, o); } }
    page.document.defaultView = { MouseEvent: Ev, PointerEvent: Ev, KeyboardEvent: Ev };
    const { d } = mkDriver(page, clk());
    ref.current = d;
    const res = await d.run({ title: 'Synthetic Title', timeoutMs: 30, loadMs: 50 });
    expect(res.failed).toEqual([{ format: '*', reason: 'menu_not_opened' }]);
    expect(res.probe.map((p) => p.stage)).toEqual(['before', 'after_click', 'after_pointer', 'after_enter']);
    expect(res.clicks).toEqual(['title', 'title:pointer', 'title:enter']);
    expect(Object.keys(res.probe[0]).sort()).toEqual(['connected', 'dialogs', 'expanded', 'focus', 'items', 'menus', 'stage', 'vis']);
  });

  it('a click the allow-list refuses throws and is reported, not performed', async () => {
    const ref = {};
    // title equals a destructive menu item name: refused
    const page = mkPage({ title: 'Delete', formats: DOC_FORMATS, driverRef: ref, files: DOC_FILES });
    const { d } = mkDriver(page);
    ref.current = d;
    const res = await d.run({ title: 'Delete', timeoutMs: 30, loadMs: 20 });
    expect(res.failed[0].reason).toBe('blocked_click');
    expect(page.clicked.some((n) => /Delete/.test(n))).toBe(false);
  });
});

describe('share pane, no formats, partial success', () => {
  it('radio is allowed only as the exact "Export" radio inside the "Share or export" radiogroup of a dialog', () => {
    const ok = { inDialog: true, inExportRadiogroup: true };
    expect(X.clickAllowed('radio', 'radio', 'Export', ok)).toBe(true);
    expect(X.clickAllowed('radio', 'radio', 'Share', ok)).toBe(false);
    expect(X.clickAllowed('radio', 'radio', 'Export', { inDialog: true })).toBe(false);
    expect(X.clickAllowed('radio', 'radio', 'Export', { inExportRadiogroup: true })).toBe(false);
    expect(X.clickAllowed('radio', 'button', 'Export', ok)).toBe(false);
    expect(X.clickAllowed('radio', 'switch', 'Export', ok)).toBe(false);
    for (const [role, name] of [['button', 'Copy private link'], ['switch', 'Show in Artifacts list'], ['button', 'Invite'], ['textbox', 'Add people'], ['radio', 'Share']]) {
      for (const kind of ['radio', 'title', 'export', 'format', 'dismiss', 'close']) expect(X.clickAllowed(kind, role, name, { inDialog: true, inExportRadiogroup: true, inTipDialog: true })).toBe(false);
    }
  });
  it('dialog opens on the Share pane: clicks only the Export radio, then proceeds', async () => {
    const ref = {};
    const page = mkPage({ formats: DOC_FORMATS, driverRef: ref, files: DOC_FILES, sharePane: true });
    const { d } = mkDriver(page);
    ref.current = d;
    const res = await d.run({ title: 'Synthetic Title', timeoutMs: 500, loadMs: 200 });
    expect(res.captured.map((c) => c.format)).toEqual(['markdown', 'pdf']);
    expect(res.clicks).toContain('radio');
    expect(page.clicked.filter((n) => n.startsWith('radio:'))).toEqual(['radio:Export']);
    expect(page.clicked.filter((n) => /Copy private link|Show in Artifacts|Invite|Share|radio:Share|Add people/.test(n) && !n.startsWith('menuitem:Share'))).toEqual([]);
    expect(page.clicked.some((n) => n === 'menuitem:Share')).toBe(false);
  });
  it('Word-only offer or an unrecognised pane reports no_formats_offered', async () => {
    const ref = {};
    const page = mkPage({ formats: ['Word , Editable .docx document'], driverRef: ref, files: {} });
    const { d } = mkDriver(page);
    ref.current = d;
    const res = await d.run({ title: 'Synthetic Title', timeoutMs: 30, loadMs: 100 });
    expect(res.failed).toEqual([{ format: '*', reason: 'no_formats_offered' }]);
    const ref2 = {};
    const page2 = mkPage({ formats: [], driverRef: ref2, files: {} });
    const m = mkDriver(page2);
    ref2.current = m.d;
    const r2 = await m.d.run({ title: 'Synthetic Title', timeoutMs: 30, loadMs: 100 });
    expect(r2.failed).toEqual([{ format: '*', reason: 'no_formats_offered' }]);
  });
  it('markdown: text/plain only counts with a .md filename; pdf blob is not markdown', () => {
    expect(X.fileMatchesFormat('markdown', { content_type: 'text/plain' })).toBe(false);
    expect(X.fileMatchesFormat('markdown', { content_type: 'text/plain', filename: 'x.md' })).toBe(true);
    expect(X.fileMatchesFormat('markdown', { content_type: 'text/markdown' })).toBe(true);
    expect(X.fileMatchesFormat('markdown', { content_type: 'application/pdf', filename: 'x.pdf' })).toBe(false);
  });
});

describe('MAIN-world capture script', () => {
  function mkEnv() {
    const listeners = [];
    const posted = [];
    class FakeURL extends URL { static n = 0; static createObjectURL() { return `blob:https://claude.ai/abc${FakeURL.n++ || ''}`; } }
    class Anchor { constructor(attrs) { this.attrs = attrs; this.tagName = 'A'; this.href = attrs.href; this.realClicks = 0; } hasAttribute(k) { return k in this.attrs; } getAttribute(k) { return this.attrs[k] ?? null; } click() { this.realClicks++; } }
    class ET { dispatchEvent() { return true; } }
    const win = {
      location: { origin: 'https://claude.ai', href: 'https://claude.ai/artifact/x' },
      addEventListener: (t, fn) => listeners.push({ t, fn }),
      removeEventListener: (t, fn) => { const i = listeners.findIndex((l) => l.fn === fn); if (i >= 0) listeners.splice(i, 1); },
      postMessage: (m) => { posted.push(m); setTimeout(() => listeners.filter((l) => l.t === 'message').forEach((l) => l.fn({ source: win, data: m })), 0); },
      crypto: nodeCrypto.webcrypto, HTMLAnchorElement: Anchor, EventTarget: ET,
      fetch: async () => ({ ok: true, status: 200, headers: { get: () => null }, clone() { return this; } }),
    };
    win.window = win;
    vm.runInNewContext(fs.readFileSync('chrome/artifact_capture_main.js', 'utf8'), { ...win, window: win, URL: FakeURL, crypto: nodeCrypto.webcrypto, btoa, console });
    const nonce = posted.find((m) => m.type === 'hello').nonce;
    const send = async (type) => { win.postMessage({ source: 'scry-artifact-relay', nonce, type }); await new Promise((r) => setTimeout(r, 5)); };
    return { win, posted, FakeURL, Anchor, ET, send, nonce };
  }
  const wait = () => new Promise((r) => setTimeout(r, 15));

  it('unarmed: touches nothing', async () => {
    const e = mkEnv();
    const a = new e.Anchor({ download: 'x.md', href: 'blob:https://claude.ai/abc' });
    a.click.call(a);
    e.FakeURL.createObjectURL({ type: 'text/markdown', size: 1, arrayBuffer: async () => new ArrayBuffer(1) });
    await wait();
    expect(e.posted.filter((m) => m.type.startsWith('export'))).toEqual([]);
  });

  it('armed: reads the Blob, suppresses the <a download> click, reads the filename; disarm restores', async () => {
    const e = mkEnv();
    await e.send('arm');
    const bytes = new TextEncoder().encode(MD);
    const blob = { type: 'text/markdown', size: bytes.length, arrayBuffer: async () => bytes.buffer };
    const url = e.FakeURL.createObjectURL(blob);
    const a = new e.Anchor({ download: 'Synthetic Name.md', href: url });
    e.Anchor.prototype.click.call(a);
    await wait();
    expect(a.realClicks).toBe(0);                       // real download suppressed
    const file = e.posted.find((m) => m.type === 'export_file');
    expect(file).toMatchObject({ content_type: 'text/markdown', size: bytes.length, via: 'blob', b64: b64(MD) });
    expect(e.posted.find((m) => m.type === 'export_name')).toMatchObject({ id: file.id, filename: 'Synthetic Name.md' });
    // dispatched click events on the anchor are suppressed too
    const b = new e.Anchor({ download: 'n.pdf', href: url });
    expect(e.ET.prototype.dispatchEvent.call(b, { type: 'click' })).toBe(true);
    expect(b.realClicks).toBe(0);
    await e.send('disarm');
    const c = new e.Anchor({ download: 'z', href: url });
    e.Anchor.prototype.click.call(c);
    expect(c.realClicks).toBe(1);                        // restored
  });

  it('a reused <a download> is suppressed and captured on every click', async () => {
    const e = mkEnv();
    await e.send('arm');
    const mk = (str) => { const bytes = new TextEncoder().encode(str); return { type: 'text/markdown', size: bytes.length, arrayBuffer: async () => bytes.buffer }; };
    const a = new e.Anchor({ download: 'one.md', href: '' });
    a.href = e.FakeURL.createObjectURL(mk('first'));
    e.Anchor.prototype.click.call(a);
    a.href = e.FakeURL.createObjectURL(mk('second'));
    a.attrs.download = 'two.pdf';
    e.Anchor.prototype.click.call(a);
    await wait();
    expect(a.realClicks).toBe(0);
    expect(e.posted.filter((m) => m.type === 'export_name').map((m) => m.filename)).toEqual(['one.md', 'two.pdf']);
  });

  it('ignores arm messages with the wrong nonce', async () => {
    const e = mkEnv();
    e.win.postMessage({ source: 'scry-artifact-relay', nonce: 'WRONG', type: 'arm' });
    await wait();
    e.FakeURL.createObjectURL({ type: 'x', size: 1, arrayBuffer: async () => new ArrayBuffer(1) });
    await wait();
    expect(e.posted.some((m) => m.type === 'export_file')).toBe(false);
  });

  it('armed: a fetch response with Content-Disposition attachment is captured', async () => {
    const body = new TextEncoder().encode(PDF);
    const stub = async () => ({ ok: true, status: 200, headers: { get: (h) => ({ 'content-disposition': 'attachment; filename="a.pdf"', 'content-type': 'application/pdf' })[h.toLowerCase()] || null }, clone() { return this; }, arrayBuffer: async () => body.buffer });
    const e2 = (() => {
      const listeners = []; const posted = [];
      const win = { location: { origin: 'https://claude.ai', href: 'https://claude.ai/artifact/x' }, addEventListener: (t, fn) => listeners.push({ t, fn }), removeEventListener() {}, postMessage: (m) => { posted.push(m); setTimeout(() => listeners.filter((l) => l.t === 'message').forEach((l) => l.fn({ source: win, data: m })), 0); }, crypto: nodeCrypto.webcrypto, fetch: stub };
      win.window = win;
      vm.runInNewContext(fs.readFileSync('chrome/artifact_capture_main.js', 'utf8'), { ...win, window: win, URL, crypto: nodeCrypto.webcrypto, btoa, console });
      return { win, posted, nonce: posted.find((m) => m.type === 'hello').nonce };
    })();
    e2.win.postMessage({ source: 'scry-artifact-relay', nonce: e2.nonce, type: 'arm' });
    await wait();
    await e2.win.fetch('https://claude.ai/api/whatever');
    await wait();
    expect(e2.posted.find((m) => m.type === 'export_file')).toMatchObject({ via: 'fetch', content_type: 'application/pdf', filename: 'a.pdf', b64: b64(PDF) });
  });
});

describe('relay hosts the driver', () => {
  it('forwards nonce-matching export messages to the driver and answers artifactExportRun', async () => {
    const listeners = []; const posted = [];
    const win = { location: { origin: 'https://claude.ai', href: 'x' }, addEventListener: (t, fn) => listeners.push(fn), postMessage: (m) => { posted.push(m); setTimeout(() => listeners.forEach((l) => l({ source: win, data: m })), 0); } };
    win.window = win;
    const onMsg = [];
    const seen = [];
    const ctx = { ...win, window: win, document: {}, chrome: { runtime: { sendMessage: () => Promise.resolve(), onMessage: { addListener: (f) => onMsg.push(f) } } },
      globalThis: { ScryArtifactExport: { create: () => ({ onMainMessage: (m) => seen.push(m), run: async (o) => ({ offered: ['pdf'], captured: [], failed: [], clicks: [], title: o.title }) }) } } };
    ctx.globalThis.globalThis = ctx.globalThis;
    vm.runInNewContext(fs.readFileSync('chrome/artifact_capture_relay.js', 'utf8'), ctx);
    const fire = (d) => win.postMessage(d);
    fire({ source: 'scry-artifact-capture', type: 'hello', nonce: 'N1' });
    fire({ source: 'scry-artifact-capture', type: 'export_file', nonce: 'BAD', id: 1 });
    fire({ source: 'scry-artifact-capture', type: 'export_file', nonce: 'N1', id: 2 });
    await new Promise((r) => setTimeout(r, 20));
    expect(seen.map((m) => m.id)).toEqual([2]);
    const reply = await new Promise((res) => { const keep = onMsg[0]({ action: 'artifactExportRun', title: 'T' }, {}, res); expect(keep).toBe(true); });
    expect(reply.offered).toEqual(['pdf']);
  });
});

describe('prepareArtifactExports', () => {
  it('fixed paths, own sha256, manifest source export, png as origin export, Word refused', async () => {
    const r = await A.prepareArtifactExports([
      { format: 'markdown', content_type: 'text/markdown; charset=utf-8', size: MD.length, b64: b64(MD) },
      { format: 'pdf', content_type: 'application/pdf', size: PDF.length, b64: b64(PDF) },
      { format: 'png', content_type: 'image/png', size: 7, b64: PNG.toString('base64') },
      { format: 'word', content_type: 'application/x', size: 1, b64: 'AA==' },
    ]);
    expect(r.files.map((f) => f.path)).toEqual(['export/document.md', 'export/document.pdf']);
    expect(r.files[0]).toMatchObject({ content_type: 'text/markdown', sha256: sha(MD), data_b64: b64(MD) });
    expect(r.manifest).toEqual([
      { path: 'export/document.md', size: MD.length, content_type: 'text/markdown', sha256: sha(MD), source: 'export' },
      { path: 'export/document.pdf', size: PDF.length, content_type: 'application/pdf', sha256: sha(PDF), source: 'export' },
    ]);
    expect(r.png).toEqual({ data_b64: PNG.toString('base64'), origin: 'export' });
    expect(r.failed).toEqual([{ format: 'word', reason: 'unwanted_format' }]);
    expect(r.captured.map((c) => c.format)).toEqual(['markdown', 'pdf', 'png']);
  });
  it('validates content and size', async () => {
    const r = await A.prepareArtifactExports([
      { format: 'pdf', content_type: 'application/pdf', b64: b64('notpdf') },
      { format: 'png', content_type: 'image/png', b64: b64('notpng') },
      { format: 'markdown', content_type: 'text/markdown', b64: Buffer.from([0xff, 0xfe, 0xfd]).toString('base64') },
      { format: 'markdown', content_type: 'text/markdown', b64: b64('ok text but long') },
    ], 10);
    expect(r.failed.map((f) => f.reason)).toEqual(['bad_content', 'bad_content', 'bad_content', 'too_large']);
  });
});

describe('export planner', () => {
  const item = { id: ID1, updated_at: 'u1' };
  const now = 1_000_000_000_000;
  const full = { exports: { 'export/document.md': 'a', 'export/document.pdf': 'b' }, png_origin: 'thumbnail' };
  it('missing exports / png_origin (old server) = unknown -> capture, once per updated_at', () => {
    expect(A.artifactExportNeeded({}, item, { now })).toBe(true);
    expect(A.artifactExportNeeded({ exports: {} }, item, { now })).toBe(true);
    const memo = { [ID1]: { updated_at: 'u1', at: now, ok: true } };
    expect(A.artifactExportNeeded({}, item, { exportTried: memo, now })).toBe(false);
    expect(A.artifactExportNeeded({}, { ...item, updated_at: 'u2' }, { exportTried: memo, now })).toBe(true);
  });
  it('has both document exports, or an export png: not needed; one missing: needed', () => {
    expect(A.artifactExportNeeded(full, item, { now })).toBe(false);
    expect(A.artifactExportNeeded({ exports: {}, png_origin: 'export' }, item, { now })).toBe(false);
    expect(A.artifactExportNeeded({ exports: { 'export/document.md': 'a' }, png_origin: 'thumbnail' }, item, { now })).toBe(true);
    expect(A.artifactExportNeeded({ exports: {}, png_origin: 'thumbnail' }, item, { now })).toBe(true);
  });
  it('7-day backoff keyed by (id, updated_at) after a failure', () => {
    const t = { [ID1]: { updated_at: 'u1', at: now - 1000, ok: false } };
    expect(A.artifactExportNeeded({ exports: {}, png_origin: 'thumbnail' }, item, { exportTried: t, now })).toBe(false);
    expect(A.artifactExportNeeded({ exports: {}, png_origin: 'thumbnail' }, { ...item, updated_at: 'u2' }, { exportTried: t, now })).toBe(true);
    expect(A.artifactExportNeeded({ exports: {}, png_origin: 'thumbnail' }, item, { exportTried: { [ID1]: { updated_at: 'u1', at: now - 8 * 86400000, ok: false } }, now })).toBe(true);
  });
  it('planArtifact: typed detail with a missing export -> missing_export; plain detail never', () => {
    const typed = { files: [{ path: 'artifact-type/a.js' }] };
    const e = { updated_at: 'u1', files: {}, has_png: true, exports: {}, png_origin: 'thumbnail' };
    expect(A.planArtifact(item, e, { detail: typed, now })).toEqual({ capture: true, reason: 'missing_export' });
    expect(A.planArtifact(item, e, { detail: { files: [] }, now }).capture).toBe(false);
    expect(A.planArtifact(item, { ...e, exports: full.exports }, { detail: typed, now }).capture).toBe(false);
  });
});

// ---------- tab / window flow ----------

function mkFlow({ replies, withWindows = true }) {
  const log = [];
  const queue = replies.slice();
  const tabs = {
    create: vi.fn(async (o) => { log.push(['tab.create', o.active]); return { id: 10 }; }),
    remove: vi.fn(async (id) => { log.push(['tab.remove', id]); }),
    sendMessage: vi.fn(async (id, m) => { log.push(['send', id, m.onlyFormats || null]); const r = queue.shift(); if (r instanceof Error) throw r; return r; }),
  };
  const windows = withWindows ? {
    create: vi.fn(async (o) => { log.push(['win.create', o.focused, o.type]); return { id: 99, tabs: [{ id: 55 }] }; }),
    remove: vi.fn(async (id) => { log.push(['win.remove', id]); }),
    getLastFocused: vi.fn(async () => ({ id: 7 })),
    update: vi.fn(async (id, o) => { log.push(['win.update', id, o.focused]); }),
  } : null;
  return { tabs, windows, log };
}
const base = { sleep: async () => {}, pollMs: 0 };
const cap = (format) => ({ format, content_type: format === 'pdf' ? 'application/pdf' : 'text/markdown', size: 3, b64: b64(format === 'pdf' ? PDF : MD) });

describe('captureArtifactExportsViaTab', () => {
  beforeEach(() => { scriptingStub.registerContentScripts.mockClear(); scriptingStub.unregisterContentScripts.mockClear(); });
  it('default: inactive tab, closed afterwards, scripts unregistered', async () => {
    const f = mkFlow({ replies: [{ offered: ['markdown', 'pdf'], subtype: 'document', captured: [cap('markdown'), cap('pdf')], failed: [] }] });
    const r = await A.captureArtifactExportsViaTab('/artifact/x', { ...base, tabs: f.tabs, windows: f.windows, scripting: scriptingStub, title: 'T' });
    expect(r.mode).toBe('tab');
    expect(r.captured).toHaveLength(2);
    expect(f.log).toEqual([['tab.create', false], ['send', 10, null], ['tab.remove', 10]]);
    expect(scriptingStub.unregisterContentScripts.mock.calls.length).toBe(2);
    expect(f.windows.create).not.toHaveBeenCalled();
  });
  it('a timed-out format falls back ONCE to a focused normal window for that format only', async () => {
    const f = mkFlow({ replies: [
      { offered: ['markdown', 'pdf'], subtype: 'document', captured: [cap('markdown')], failed: [{ format: 'pdf', reason: 'timeout' }] },
      { offered: ['markdown', 'pdf'], subtype: 'document', captured: [cap('pdf')], failed: [] },
    ] });
    const r = await A.captureArtifactExportsViaTab('/artifact/x', { ...base, tabs: f.tabs, windows: f.windows, scripting: scriptingStub, title: 'T' });
    expect(r.mode).toBe('window');
    expect(r.captured.map((c) => c.format)).toEqual(['markdown', 'pdf']);
    expect(r.failed).toEqual([]);
    expect(f.log).toEqual([['tab.create', false], ['send', 10, null], ['tab.remove', 10], ['win.create', true, 'normal'], ['send', 55, ['pdf']], ['win.remove', 99], ['win.update', 7, true]]);
  });
  it('a menu/dialog that never renders in the background tab retries the whole run ONCE in a window', async () => {
    // Live finding 2026-11-18: in an inactive tab Claude's menu never rendered
    // (menu_not_opened on every artifact); a visible page opens it fine.
    for (const reason of ['title_button_not_found', 'menu_not_opened', 'dialog_not_found']) {
      const f = mkFlow({ replies: [
        { offered: [], subtype: null, captured: [], failed: [{ format: '*', reason }] },
        { offered: ['markdown', 'pdf'], subtype: 'document', captured: [cap('markdown'), cap('pdf')], failed: [] },
      ] });
      const r = await A.captureArtifactExportsViaTab('/artifact/x', { ...base, tabs: f.tabs, windows: f.windows, scripting: scriptingStub, title: 'T' });
      expect(r.mode).toBe('window');
      expect(r.subtype).toBe('document');
      expect(r.captured.map((c) => c.format)).toEqual(['markdown', 'pdf']);
      expect(r.failed).toEqual([]);
      expect(f.log).toEqual([['tab.create', false], ['send', 10, null], ['tab.remove', 10], ['win.create', true, 'normal'], ['send', 55, null], ['win.remove', 99], ['win.update', 7, true]]);
    }
  });
  it('the retry window takes focus (menus close in an unfocused document) and focus goes back afterwards', async () => {
    const f = mkFlow({ replies: [{ offered: [], subtype: null, captured: [], failed: [] }] });
    await A.captureArtifactExportsViaTab('/artifact/x', { ...base, tabs: f.tabs, windows: f.windows, scripting: scriptingStub, exportMode: 'window' });
    expect(f.log).toEqual([['win.create', true, 'normal'], ['send', 55, null], ['win.remove', 99], ['win.update', 7, true]]);
    // No previously focused window (or the lookup fails): nothing to restore, no throw.
    const f2 = mkFlow({ replies: [{ offered: [], subtype: null, captured: [], failed: [] }] });
    f2.windows.getLastFocused = vi.fn(async () => { throw new Error('none'); });
    const r2 = await A.captureArtifactExportsViaTab('/artifact/x', { ...base, tabs: f2.tabs, windows: f2.windows, scripting: scriptingStub, exportMode: 'window' });
    expect(r2.failed).toEqual([]);
    expect(f2.log.at(-1)).toEqual(['win.remove', 99]);
  });
  it('a UI failure in the window too is reported once, not retried again', async () => {
    const u = { offered: [], subtype: null, captured: [], failed: [{ format: '*', reason: 'menu_not_opened' }] };
    const f = mkFlow({ replies: [u, u, u] });
    const r = await A.captureArtifactExportsViaTab('/artifact/x', { ...base, tabs: f.tabs, windows: f.windows, scripting: scriptingStub });
    expect(r.mode).toBe('window');
    expect(r.failed).toEqual([{ format: '*', reason: 'menu_not_opened' }]);
    expect(f.tabs.sendMessage).toHaveBeenCalledTimes(2);
  });
  it('blocked_click never falls back (the allow-list said no)', async () => {
    const f = mkFlow({ replies: [{ offered: [], subtype: null, captured: [], failed: [{ format: '*', reason: 'blocked_click' }] }] });
    const r = await A.captureArtifactExportsViaTab('/artifact/x', { ...base, tabs: f.tabs, windows: f.windows, scripting: scriptingStub });
    expect(r.mode).toBe('tab');
    expect(f.windows.create).not.toHaveBeenCalled();
  });
  it('timeout in the window too: reported, not retried a third time', async () => {
    const t = { offered: ['png'], subtype: 'whiteboard', captured: [], failed: [{ format: 'png', reason: 'timeout' }] };
    const f = mkFlow({ replies: [t, t, t] });
    const r = await A.captureArtifactExportsViaTab('/artifact/x', { ...base, tabs: f.tabs, windows: f.windows, scripting: scriptingStub });
    expect(r.mode).toBe('window');
    expect(r.failed).toEqual([{ format: 'png', reason: 'timeout' }]);
    expect(f.tabs.sendMessage).toHaveBeenCalledTimes(2);
  });
  it('forced modes do not fall back', async () => {
    const t = { offered: ['png'], subtype: 'whiteboard', captured: [], failed: [{ format: 'png', reason: 'timeout' }] };
    const f = mkFlow({ replies: [t] });
    const r = await A.captureArtifactExportsViaTab('/artifact/x', { ...base, tabs: f.tabs, windows: f.windows, scripting: scriptingStub, exportMode: 'tab' });
    expect(r.mode).toBe('tab');
    expect(f.windows.create).not.toHaveBeenCalled();
    const f2 = mkFlow({ replies: [{ offered: [], subtype: null, captured: [], failed: [] }] });
    const r2 = await A.captureArtifactExportsViaTab('/artifact/x', { ...base, tabs: f2.tabs, windows: f2.windows, scripting: scriptingStub, exportMode: 'window' });
    expect(r2.mode).toBe('window');
    expect(f2.tabs.create).not.toHaveBeenCalled();
  });
  it('waits for the content script, always closes the tab, never opens a bad url', async () => {
    const f = mkFlow({ replies: [new Error('Could not establish connection. Receiving end does not exist.'), { offered: [], subtype: null, captured: [], failed: [] }] });
    const r = await A.captureArtifactExportsViaTab('/artifact/x', { ...base, tabs: f.tabs, windows: f.windows, scripting: scriptingStub });
    expect(r.failed).toEqual([]);
    expect(f.tabs.sendMessage).toHaveBeenCalledTimes(2);
    const f2 = mkFlow({ replies: [new Error('boom')] });
    const r2 = await A.captureArtifactExportsViaTab('/artifact/x', { ...base, tabs: f2.tabs, windows: f2.windows, scripting: scriptingStub });
    expect(r2.failed).toEqual([{ format: '*', reason: 'no_driver' }]);
    expect(f2.log.at(-1)).toEqual(['tab.remove', 10]);
    const f3 = mkFlow({ replies: [] });
    const r3 = await A.captureArtifactExportsViaTab('https://evil.example/x', { ...base, tabs: f3.tabs, windows: f3.windows, scripting: scriptingStub });
    expect(r3.failed).toEqual([{ format: '*', reason: 'bad_open_url' }]);
    expect(f3.log).toEqual([]);
  });
  it('registers one MAIN + one isolated script; the isolated one loads the driver first', async () => {
    await A.registerArtifactCaptureScripts(scriptingStub);
    const l = scriptingStub.registerContentScripts.mock.calls.at(-1)[0];
    expect(l).toHaveLength(2);
    expect(l[1].js).toEqual(['artifact_export_ui.js', 'artifact_capture_relay.js']);
    expect(l[0].js).toEqual(['artifact_capture_main.js']);
  });
});

// ---------- collector end to end ----------

const bytesOf = (s) => new TextEncoder().encode(s);
const HTML = bytesOf('<html>synthetic page</html>');
function mkResp(status, body, ct) {
  return { status, ok: status >= 200 && status < 300, headers: { get: (h) => (h.toLowerCase() === 'content-type' ? ct || null : null) }, json: async () => body,
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) };
}
function setupNet({ items, state = { artifacts: {} } }) {
  const ingests = []; const calls = [];
  const typedDetail = (id) => ({ ver: 'v2', viewerOrigin: `https://${id}.frame.claudeusercontent.com`, assetToken: 'ASSETTOKEN',
    files: [{ path: 'index.html', size: HTML.length, contentType: 'text/html', sha256: sha(HTML) }, { path: 'artifact-type/app.js', size: 99, contentType: 'text/javascript', sha256: 'ff' }] });
  global.fetch = vi.fn(async (url, init = {}) => {
    const u = String(url);
    calls.push(u);
    if (u.startsWith('https://claude.ai/api/frame/artifacts?')) return mkResp(200, { artifacts: items, hosted_total: items.length });
    for (const it of items) {
      if (u.startsWith(`https://claude.ai/api/frame/${it.id}?`)) return mkResp(200, it.kind === 'snippet' ? { ver: 'v1', viewerOrigin: `https://${it.id}.frame.claudeusercontent.com`, assetToken: 'A', files: [{ path: 'main.py', size: 3, contentType: 'text/x-python', sha256: sha('abc') }] } : typedDetail(it.id));
      if (u.includes('_thumb')) return mkResp(200, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9]), 'image/png');
      if (u.includes(`${it.id}.frame.claudeusercontent.com/_f/`)) return u.includes('main.py') ? mkResp(200, bytesOf('abc'), 'text/x-python') : mkResp(200, HTML, 'text/html');
      if (u.includes(`${it.id}.frame.claudeusercontent.com/_thumb`)) return mkResp(200, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9]), 'image/png');
    }
    if (u.endsWith('/api/artifacts/state')) return mkResp(200, state);
    if (u.endsWith('/api/artifacts/ingest')) { ingests.push(JSON.parse(init.body)); return mkResp(200, { success: true }); }
    return mkResp(500, {});
  });
  return { ingests, calls };
}
const fastGate = () => A.createArtifactGate({ spacing: { list: 0, detail: 0, file: 0, thumb: 0, tab: 0 }, sleep: async () => {} });
const scry = { url: 'http://scry.test', token: 'SERVICETOKEN-0123456789' };
const thumbItem = (id, o = {}) => ({ id, kind: 'page', open_url: `/artifact/${id.slice(0, 4)}`, title: 'Synthetic Title', created_at: 'c', updated_at: 'u1', source: 'chat', thumbnail_url: `https://${id}.frame.claudeusercontent.com/_f/v1/_thumb.img?__frame_t=THUMBTOKEN`, ...o });
function exportTabs(replies) {
  const f = mkFlow({ replies });
  // db tab capture uses tabs.create too: give it an onCreate that does nothing
  return f;
}
const run = (f, extra = {}) => A.runArtifactCollector({ gate: fastGate(), orgId: 'org', scry, tabs: f.tabs, windows: f.windows, scripting: scriptingStub, sleep: async () => { await new Promise((r) => setTimeout(r, 2)); }, session: { idleMs: 3, firstCallMs: 5, maxMs: 30 }, pngTried: {}, exportTried: {}, ...extra });

describe('collector: export capture', () => {
  let orig;
  beforeEach(() => { orig = global.fetch; });
  afterEach(() => { global.fetch = orig; vi.restoreAllMocks(); });

  it('document type: export files + manifest source, subtype, report; thumbnail stays', async () => {
    const net = setupNet({ items: [thumbItem(ID1)] });
    const f = exportTabs([{ offered: ['word', 'pdf', 'markdown'], subtype: 'document', captured: [cap('markdown'), cap('pdf')], failed: [] }]);
    const exportTried = {};
    const sum = await run(f, { exportTried });
    expect(sum).toMatchObject({ captured: 1, failed: 0 });
    const p = net.ingests[0];
    expect(p.artifact.subtype).toBe('document');
    expect(p.files.map((x) => x.path).sort()).toEqual(['export/document.md', 'export/document.pdf', 'index.html']);
    expect(p.manifest.filter((m) => m.source === 'export').map((m) => m.path)).toEqual(['export/document.md', 'export/document.pdf']);
    expect(p.png.origin).toBe('thumbnail');
    expect(p.fetch_report.export).toMatchObject({ mode: 'tab', formats_offered: ['word', 'pdf', 'markdown'], failed: [] });
    expect(p.fetch_report.export.captured).toEqual([{ format: 'markdown', bytes: MD.length, content_type: 'text/markdown' }, { format: 'pdf', bytes: PDF.length, content_type: 'application/pdf' }]);
    expect(typeof p.fetch_report.export.ms).toBe('number');
    expect(exportTried[ID1]).toMatchObject({ ok: true, updated_at: 'u1' });
    const all = JSON.stringify(p.fetch_report);
    expect(all).not.toContain('Synthetic Title');
  });

  it('whiteboard: PNG goes in png with origin export; thumbnail not used', async () => {
    const net = setupNet({ items: [thumbItem(ID2)] });
    const f = exportTabs([{ offered: ['png'], subtype: 'whiteboard', captured: [{ format: 'png', content_type: 'image/png', size: 7, b64: PNG.toString('base64') }], failed: [] }]);
    await run(f);
    const p = net.ingests[0];
    expect(p.artifact.subtype).toBe('whiteboard');
    expect(p.png).toEqual({ data_b64: PNG.toString('base64'), origin: 'export' });
    expect(p.files.map((x) => x.path)).toEqual(['index.html']);
    expect(net.calls.some((u) => u.includes('_thumb'))).toBe(false);
  });

  it('export failure: still ingests (thumbnail origin), records failure and backs off 7 days', async () => {
    const net = setupNet({ items: [thumbItem(ID1)] });
    const f = exportTabs([{ offered: ['markdown', 'pdf'], subtype: 'document', captured: [cap('markdown')], failed: [{ format: 'pdf', reason: 'timeout' }] }, { offered: ['markdown', 'pdf'], subtype: 'document', captured: [], failed: [{ format: 'pdf', reason: 'timeout' }] }]);
    const exportTried = {};
    await run(f, { exportTried, exportMode: 'tab' });
    expect(net.ingests[0].fetch_report.export.failed).toEqual([{ format: 'pdf', reason: 'timeout' }]);
    expect(exportTried[ID1]).toMatchObject({ ok: false, updated_at: 'u1' });
    // next run, same updated_at, Scry still lacks the pdf: no export attempt
    const sends = f.tabs.sendMessage.mock.calls.length;
    const net2 = setupNet({ items: [thumbItem(ID1)], state: { artifacts: { [ID1]: { updated_at: 'u1', version: 'v2', files: { 'index.html': sha(HTML) }, has_png: true, exports: { 'export/document.md': 'a' }, png_origin: 'thumbnail' } } } });
    const sum = await run(f, { exportTried });
    expect(sum.captured).toBe(0);
    expect(f.tabs.sendMessage.mock.calls.length).toBe(sends);
    expect(net2.ingests).toHaveLength(0);
  });

  it('planner path: unchanged typed artifact missing its pdf is re-captured (missing_export)', async () => {
    const net = setupNet({ items: [thumbItem(ID1)], state: { artifacts: { [ID1]: { updated_at: 'u1', version: 'v2', files: { 'index.html': sha(HTML) }, has_png: true, exports: { 'export/document.md': 'a' }, png_origin: 'thumbnail' } } } });
    const f = exportTabs([{ offered: ['markdown', 'pdf'], subtype: 'document', captured: [cap('markdown'), cap('pdf')], failed: [] }]);
    const sum = await run(f);
    expect(sum.captured).toBe(1);
    expect(net.ingests[0].files.map((x) => x.path)).toContain('export/document.pdf');
  });

  it('no export capture for plain pages, and none when disabled by ctx', async () => {
    const net = setupNet({ items: [thumbItem(ID1, { kind: 'snippet' })] });
    const f = exportTabs([]);
    await run(f);
    expect(f.tabs.sendMessage).not.toHaveBeenCalled();
    expect(net.ingests[0].artifact.subtype).toBeNull();
  });

  it('logs carry no titles or tokens', async () => {
    setupNet({ items: [thumbItem(ID1)] });
    const logs = [];
    for (const m of ['log', 'warn', 'error']) vi.spyOn(console, m).mockImplementation((...a) => logs.push(a.join(' ')));
    const f = exportTabs([{ offered: ['markdown'], subtype: 'document', captured: [cap('markdown')], failed: [] }]);
    await run(f);
    for (const t of ['Synthetic Title', 'THUMBTOKEN', 'SERVICETOKEN', 'ASSETTOKEN']) expect(logs.join('\n')).not.toContain(t);
  });
});

const uid = (i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

describe('collector: no formats, cap, persistence, partial', () => {
  let orig;
  beforeEach(() => { orig = global.fetch; });
  afterEach(() => { global.fetch = orig; vi.restoreAllMocks(); });
  const NONE = { offered: [], subtype: null, captured: [], failed: [{ format: '*', reason: 'no_formats_offered' }] };
  const stateFor = (id, extra = {}) => ({ [id]: { updated_at: 'u1', version: 'v2', files: { 'index.html': sha(HTML) }, has_png: true, exports: {}, png_origin: 'thumbnail', ...extra } });

  it('M1: no formats offered is a failure with 7-day backoff, never a success memo', async () => {
    const net = setupNet({ items: [thumbItem(ID1)] });
    const f = mkFlow({ replies: [NONE] });
    const exportTried = {};
    await run(f, { exportTried });
    expect(net.ingests[0].fetch_report.export.failed).toEqual([{ format: '*', reason: 'no_formats_offered' }]);
    expect(exportTried[ID1]).toMatchObject({ ok: false, updated_at: 'u1' });
    const sends = f.tabs.sendMessage.mock.calls.length;
    setupNet({ items: [thumbItem(ID1)], state: { artifacts: stateFor(ID1) } });
    const sum = await run(f, { exportTried });
    expect(sum.captured).toBe(0);
    expect(f.tabs.sendMessage.mock.calls.length).toBe(sends);
  });

  it('M2: at most ARTIFACT_EXPORT_MAX_PER_RUN missing_export recaptures per run; the rest are deferred', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => uid(i + 1));
    setupNet({ items: ids.map((id) => thumbItem(id)), state: { artifacts: Object.assign({}, ...ids.map((id) => stateFor(id))) } });
    const f = mkFlow({ replies: ids.map(() => ({ offered: ['png'], subtype: 'whiteboard', captured: [], failed: [] })) });
    const sum = await run(f);
    expect(A.ARTIFACT_EXPORT_MAX_PER_RUN).toBe(10);
    expect(sum.captured).toBe(10);
    expect(sum.export_deferred).toBe(2);
    expect(f.tabs.sendMessage).toHaveBeenCalledTimes(10);
  });

  it('M3: backoffs are persisted as each artifact finishes, so a later abort keeps them', async () => {
    setupNet({ items: [thumbItem(ID1), thumbItem(ID2)] });
    const g = global.fetch;
    global.fetch = vi.fn(async (u, i) => (String(u).startsWith(`https://claude.ai/api/frame/${ID2}?`) ? mkResp(429, {}) : g(u, i)));
    const f = mkFlow({ replies: [NONE] });
    const exportTried = {};
    const snaps = [];
    const gate = A.createArtifactGate({ spacing: { list: 0, detail: 0, file: 0, thumb: 0, tab: 0 }, sleep: async () => {}, schedule: [0] });
    const sum = await A.runArtifactCollector({ gate, orgId: 'org', scry, tabs: f.tabs, windows: f.windows, scripting: scriptingStub, sleep: async () => { await new Promise((r) => setTimeout(r, 2)); }, session: { idleMs: 3, firstCallMs: 5, maxMs: 30 }, pngTried: {}, exportTried, persist: async () => { snaps.push(JSON.parse(JSON.stringify(exportTried))); } });
    expect(sum.aborted).toBe('rate_limited');
    expect(snaps.length).toBeGreaterThanOrEqual(1);
    expect(snaps[0][ID1]).toMatchObject({ ok: false });
  });

  it('L5: partial success marks captured formats done and retries only the failed one after backoff', async () => {
    setupNet({ items: [thumbItem(ID1)] });
    const f = mkFlow({ replies: [{ offered: ['markdown', 'pdf'], subtype: 'document', captured: [cap('markdown')], failed: [{ format: 'pdf', reason: 'timeout' }] }] });
    const exportTried = {};
    let t = 1_000_000_000_000;
    await run(f, { exportTried, exportMode: 'tab', now: () => t });
    expect(exportTried[ID1]).toMatchObject({ ok: false, done: ['markdown'], failed: ['pdf'] });
    // after the 7-day backoff: only the failed format is requested
    t += 8 * 86400000;
    setupNet({ items: [thumbItem(ID1)], state: { artifacts: stateFor(ID1, { exports: { 'export/document.md': 'a' } }) } });
    f.tabs.sendMessage.mockImplementationOnce(async (id, m) => { expect(m.onlyFormats).toEqual(['pdf', 'png']); return { offered: ['markdown', 'pdf'], subtype: 'document', captured: [cap('pdf')], failed: [] }; });
    const sum = await run(f, { exportTried, exportMode: 'tab', now: () => t });
    expect(sum.captured).toBe(1);
    expect(exportTried[ID1]).toMatchObject({ ok: true, done: ['markdown', 'pdf'] });
  });
});

describe('snippets', () => {
  let orig;
  beforeEach(() => { orig = global.fetch; });
  afterEach(() => { global.fetch = orig; });
  it('a snippet is captured like a page: files fetched, type = its content type, reason recorded', async () => {
    const net = setupNet({ items: [thumbItem(ID1, { kind: 'snippet', thumbnail_url: null })] });
    const sum = await run(mkFlow({ replies: [] }));
    expect(sum).toMatchObject({ captured: 1, failed: 0 });
    const p = net.ingests[0];
    expect(p.artifact.type).toBe('text/x-python');
    expect(p.files.map((x) => x.path)).toEqual(['main.py']);
    expect(p.fetch_report.snippet).toEqual({ files: 1, content_type: 'text/x-python', reason: null });
  });
  it('a snippet whose files cannot be fetched records why', async () => {
    const net = setupNet({ items: [thumbItem(ID1, { kind: 'snippet', thumbnail_url: null })] });
    const g = global.fetch;
    global.fetch = vi.fn(async (u, i) => (String(u).includes('/_f/') ? mkResp(404, {}, 'application/json') : g(u, i)));
    await run(mkFlow({ replies: [] }));
    expect(net.ingests[0].fetch_report.snippet.reason).toBe('download_failed');
    expect(net.ingests[0].files).toEqual([]);
  });
});

describe('diagnostics: export test (dry run)', () => {
  let orig;
  beforeEach(() => { orig = global.fetch; });
  afterEach(() => { global.fetch = orig; });
  it('tests one document and one whiteboard artifact, reports sizes only, pushes nothing', async () => {
    const net = setupNet({ items: [thumbItem(ID1), thumbItem(ID2)] });
    const f = mkFlow({ replies: [
      { offered: ['word', 'pdf', 'markdown'], subtype: 'document', captured: [cap('markdown'), cap('pdf')], failed: [] },
      { offered: ['png'], subtype: 'whiteboard', captured: [], failed: [{ format: 'png', reason: 'timeout' }] },
      { offered: ['png'], subtype: 'whiteboard', captured: [], failed: [{ format: 'png', reason: 'timeout' }] },
    ] });
    const d = await A.runArtifactDiagnostics({ gate: fastGate(), orgId: 'org', tabs: f.tabs, windows: f.windows, scripting: scriptingStub, sleep: async () => { await new Promise((r) => setTimeout(r, 2)); }, session: { idleMs: 3, firstCallMs: 5, maxMs: 30 } });
    expect(d.exports.map((e) => e.subtype)).toEqual(['document', 'whiteboard']);
    expect(d.exports[0].captured).toEqual([{ format: 'markdown', bytes: MD.length, content_type: 'text/markdown' }, { format: 'pdf', bytes: PDF.length, content_type: 'application/pdf' }]);
    expect(d.exports[1].failed).toEqual([{ format: 'png', reason: 'timeout' }]);
    expect(net.calls.some((u) => u.includes('/api/artifacts/ingest'))).toBe(false);
    const text = A.formatArtifactDiagnostics(d);
    expect(text).toContain('EXPORT TEST (document)');
    expect(text).toContain('captured markdown: 20 bytes');
    expect(text).toContain('failed png: timeout');
    expect(text).not.toContain('b64');
    for (const t of ['Synthetic Title', 'THUMBTOKEN', MD, b64(MD)]) expect(text).not.toContain(t);
    expect(JSON.stringify(d.exports)).not.toContain(b64(MD));
  });
});

describe('release', () => {
  it('manifest version is 3.7.0 and still has no static artifact content scripts', () => {
    const m = JSON.parse(fs.readFileSync('chrome/manifest.json', 'utf8'));
    expect(m.version).toBe('3.7.0');
    expect(JSON.stringify(m.content_scripts)).not.toContain('artifact_');
    expect(m.permissions).toContain('tabs');
  });
});
