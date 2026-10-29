// Tests for ChatGPT generated-UI picture capture (AsyncImage / AsyncImageGroup):
// the vendor-resolved pictures sit in metadata.model_dil_v2.appData.opGenui
// .componentResults and are fetched anonymously from images.openai.com.

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

const adapter = require('../chrome/chatgpt_adapter.js');
const {
  collectChatGptGenuiImages, genuiFileUuid, fetchChatGptFileBlobs,
  CHATGPT_GENUI_MAX_BYTES, ChatGptRateLimitError,
} = adapter;

beforeEach(() => {
  adapter._setChatGptGate(adapter.createChatGptGate({ spacing: { list: 0, body: 0, asset: 0 }, warn: () => {} }));
});

const U = (n) => `https://images.openai.com/static-rsc-4/tok${n}?purpose=inline`;
const img = (n, extra = {}) => ({
  content_url: U(n), thumbnail_url: U(n) + '&t=1', content_size: { width: 4, height: 3 },
  image_search_query: `query ${n}`, original_content_url: `https://example.test/o${n}.jpg`,
  url: `https://example.test/p${n}`, title: `Pic ${n}`, ...extra,
});
function asst(id, componentResults, extra = {}) {
  return {
    id, author: { role: 'assistant' }, recipient: 'all',
    content: { content_type: 'text', parts: ['x'] },
    metadata: { model_dil_v2: { appData: { opGenui: { componentResults } } } },
    ...extra,
  };
}
function convo(nodes, current) {
  const mapping = {};
  for (const [id, parent, message] of nodes) mapping[id] = { id, parent, children: [], message };
  for (const [id, parent] of nodes) if (parent) mapping[parent].children.push(id);
  return { conversation_id: 'conv-1', current_node: current, mapping };
}
const user = { id: 'u', author: { role: 'user' }, recipient: 'all', content: { content_type: 'text', parts: ['hi'] }, metadata: {} };

function tree() {
  const m1 = asst('m1', { a: { componentName: 'AsyncImage', status: 'done', state: { images: [img(1)] } } });
  const m2 = asst('m2', { g: { componentName: 'AsyncImageGroup', status: 'done', state: { images: [img(2), img(3), img(4)] } } });
  const m3 = asst('m3', { l: { componentName: 'LinkCard', status: 'done', state: { title: 't' } },
    e: { componentName: 'Map', status: 'done', state: { images: [] } }, n: null });
  const hidden = asst('mh', { h: { componentName: 'AsyncImage', status: 'done', state: { images: [img(9)] } } },
    { recipient: 'python' });
  return convo([['n0', null, user], ['n1', 'n0', m1], ['n2', 'n1', m2], ['n3', 'n2', m3], ['nh', 'n3', hidden], ['n4', 'n3', asst('m4', {})]], 'n4');
}

describe('genuiFileUuid', () => {
  it('is genui_ + first 32 hex of sha256(utf8 content_url)', async () => {
    const url = 'https://images.openai.com/static-rsc-4/abc?purpose=inline';
    const hex = createHash('sha256').update(url, 'utf8').digest('hex').slice(0, 32);
    expect(await genuiFileUuid(url)).toBe('genui_' + hex);
    expect(hex).toHaveLength(32);
  });
});

describe('collectChatGptGenuiImages', () => {
  it('branch pass: single, group of 3, ignores link/map components and hidden tool turns', async () => {
    const out = await collectChatGptGenuiImages(tree());
    expect(out.map((o) => o.content_url)).toEqual([U(1), U(2), U(3), U(4)]);
    expect(out[0]).toEqual({
      id: await genuiFileUuid(U(1)), content_url: U(1), thumbnail_url: U(1) + '&t=1',
      title: 'Pic 1', query: 'query 1', source_url: 'https://example.test/o1.jpg',
      message_id: 'm1', index: 0,
    });
    expect(out.map((o) => o.index)).toEqual([0, 1, 2, 3]);
  });

  it('wholeTree includes the hidden tool message (and dead siblings)', async () => {
    const out = await collectChatGptGenuiImages(tree(), { wholeTree: true });
    expect(out.map((o) => o.content_url).sort()).toEqual([U(1), U(2), U(3), U(4), U(9)].sort());
  });

  it('de-duplicates by content_url', async () => {
    const m1 = asst('m1', { a: { state: { images: [img(1), img(1)] } } });
    const m2 = asst('m2', { a: { state: { images: [img(1)] } } });
    const out = await collectChatGptGenuiImages(convo([['n1', null, m1], ['n2', 'n1', m2]], 'n2'));
    expect(out).toHaveLength(1);
  });

  it('tolerates junk bodies', async () => {
    expect(await collectChatGptGenuiImages(null)).toEqual([]);
    expect(await collectChatGptGenuiImages({ mapping: {} })).toEqual([]);
  });
});

describe('fetchChatGptFileBlobs — generated pictures', () => {
  let calls;
  const JPEG_B64 = '/9j/4AAQ'; // starts with the JPEG signature prefix
  const install = (handler, { b64 = JPEG_B64 } = {}) => {
    calls = [];
    global.fetch = async (url, opts) => { calls.push({ url, opts }); return handler(url, opts); };
    global.FileReader = class { readAsDataURL() { this.result = `data:application/octet-stream;base64,${b64}`; this.onloadend(); } };
  };
  afterEach(() => { delete global.fetch; delete global.FileReader; });
  const okResp = (ct, size = 10, len = null) => ({
    ok: true, status: 200,
    headers: { get: (h) => (h === 'content-type' ? ct : h === 'content-length' ? len : null) },
    blob: async () => ({ size }),
  });
  const one = () => convo([['n1', null, asst('m1', { a: { state: { images: [img(1)] } } })]], 'n1');

  it('fetches anonymously, builds the record with the derived id', async () => {
    install(() => okResp('image/jpeg'));
    const out = await fetchChatGptFileBlobs('tok', one(), null);
    expect(out.failures).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(U(1));
    expect(calls[0].opts.credentials).toBe('omit');
    const hdrs = calls[0].opts.headers || {};
    expect(Object.keys(hdrs).map((k) => k.toLowerCase())).not.toContain('authorization');
    expect(out.blobs).toEqual([{
      file_uuid: await genuiFileUuid(U(1)), file_name: 'Pic_1.jpg', file_type: 'image/jpeg',
      file_variant: 'original', data: `data:image/jpeg;base64,${JPEG_B64}`,
    }]);
  });

  it('sniffs magic bytes when content-type is missing or generic', async () => {
    install(() => okResp('application/octet-stream'), { b64: 'iVBORw0KGgoAAAA' });
    const out = await fetchChatGptFileBlobs('tok', one(), null);
    expect(out.blobs[0].file_type).toBe('image/png');
    expect(out.blobs[0].file_name).toBe('Pic_1.png');
  });

  it('falls back to the query for the name when there is no title', async () => {
    install(() => okResp('image/webp'));
    const body = convo([['n1', null, asst('m1', { a: { state: { images: [img(1, { title: '' })] } } })]], 'n1');
    const out = await fetchChatGptFileBlobs('tok', body, null);
    expect(out.blobs[0].file_name).toBe('query_1.webp');
  });

  it('enforces the cap (content-length and blob size) as surfaced failures', async () => {
    expect(CHATGPT_GENUI_MAX_BYTES).toBe(25 * 1024 * 1024);
    install(() => okResp('image/jpeg', 10, String(CHATGPT_GENUI_MAX_BYTES + 1)));
    let out = await fetchChatGptFileBlobs('tok', one(), null);
    expect(out.blobs).toEqual([]);
    expect(out.failures[0].error).toMatch(/exceeds CHATGPT_GENUI_MAX_BYTES/);
    install(() => okResp('image/jpeg', CHATGPT_GENUI_MAX_BYTES + 1));
    out = await fetchChatGptFileBlobs('tok', one(), null);
    expect(out.failures[0].error).toMatch(/exceeds/);
  });

  it('a 404 is a failure with a token-free pointer', async () => {
    install(() => ({ ok: false, status: 404, headers: { get: () => null }, blob: async () => ({}) }));
    const out = await fetchChatGptFileBlobs('tok', one(), null);
    expect(out.blobs).toEqual([]);
    expect(out.failures).toHaveLength(1);
    const f = out.failures[0];
    expect(f.pointer).toBe('images.openai.com/static-rsc-4/tok1');
    expect(f.pointer).not.toMatch(/purpose|\?/);
    expect(f).toMatchObject({ id: await genuiFileUuid(U(1)), name: 'Pic 1', onBranch: true });
    expect(f.error).toMatch(/404/);
  });

  it('a persistent 429 surfaces as a failure after retries', async () => {
    const h = { sleeps: 0 };
    adapter._setChatGptGate(adapter.createChatGptGate({
      spacing: { list: 0, body: 0, asset: 0 }, warn: () => {},
      sleep: async () => { h.sleeps++; }, now: (() => { let t = 0; return () => (t += 1e6); })(),
    }));
    install(() => ({ ok: false, status: 429, headers: new Headers(), blob: async () => ({}) }));
    const out = await fetchChatGptFileBlobs('tok', one(), null);
    expect(out.blobs).toEqual([]);
    expect(out.failures).toHaveLength(1);
    expect(out.failures[0].error).toMatch(/429|rate/i);
  });

  it('skips pictures whose id is already in blobs and counts onEach per picture', async () => {
    install(() => okResp('image/jpeg'));
    let n = 0;
    const out = await fetchChatGptFileBlobs('tok', convo([['n1', null, asst('m1', { a: { state: { images: [img(1), img(2)] } } })]], 'n1'), null, () => { n++; });
    expect(out.blobs).toHaveLength(2);
    expect(n).toBe(2);
  });
});
