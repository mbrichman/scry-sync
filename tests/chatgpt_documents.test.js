// Tests for ChatGPT DOCUMENT capture: a freshly uploaded md/txt/pdf/docx/csv
// appears ONLY in message.metadata.attachments[] (no content part), and is
// served by the same files/<id>/download routes the images use. Images appear
// in BOTH places; they must not be double-fetched.

import { describe, it, expect, afterEach, beforeEach } from 'vitest';

const adapter = require('../chrome/chatgpt_adapter.js');
const {
  collectChatGptDocumentAttachments,
  collectChatGptImagePointers,
  fetchChatGptFileBlobs,
  CHATGPT_DOCUMENT_MAX_BYTES,
} = adapter;

beforeEach(() => {
  adapter._setChatGptGate(adapter.createChatGptGate({ spacing: { list: 0, body: 0, asset: 0 }, warn: () => {} }));
});

const DOC_ID = 'file_' + 'a'.repeat(32);
const IMG_ID = 'file_' + 'b'.repeat(32);

function userMsg(attachments, extra = {}) {
  return {
    author: { role: 'user' }, recipient: 'all',
    content: { content_type: 'text', parts: ['see attached'] },
    metadata: { attachments },
    ...extra,
  };
}
function convo(nodes, current) {
  // nodes: [[id, parent, message]]
  const mapping = {};
  for (const [id, parent, message] of nodes) mapping[id] = { id, parent, children: [], message };
  for (const [id, parent] of nodes) if (parent) mapping[parent].children.push(id);
  return { conversation_id: 'conv-1', current_node: current, mapping };
}

describe('collectChatGptDocumentAttachments', () => {
  it('collects a document attachment as {id,name,mime_type,size}', () => {
    const body = convo([['n1', null, userMsg([{ id: DOC_ID, name: 'notes.md', mime_type: 'text/markdown', size: 42 }])]], 'n1');
    expect(collectChatGptDocumentAttachments(body)).toEqual([
      { id: DOC_ID, name: 'notes.md', mime_type: 'text/markdown', size: 42 },
    ]);
  });

  it('accepts legacy file- ids', () => {
    const body = convo([['n1', null, userMsg([{ id: 'file-AbC123xyz', name: 'a.pdf', mime_type: 'application/pdf', size: 1 }])]], 'n1');
    expect(collectChatGptDocumentAttachments(body).map((d) => d.id)).toEqual(['file-AbC123xyz']);
  });

  it('excludes image/* attachments', () => {
    const body = convo([['n1', null, userMsg([{ id: IMG_ID, name: 'p.png', mime_type: 'image/png', size: 9 }])]], 'n1');
    expect(collectChatGptDocumentAttachments(body)).toEqual([]);
  });

  it('treats a missing mime with an image extension as an image, otherwise a document', () => {
    const body = convo([['n1', null, userMsg([
      { id: IMG_ID, name: 'photo.JPG', size: 9 },
      { id: DOC_ID, name: 'data.csv', size: 9 },
    ])]], 'n1');
    expect(collectChatGptDocumentAttachments(body).map((d) => d.id)).toEqual([DOC_ID]);
  });

  it('excludes an attachment whose id an image pointer already yields', () => {
    const msg = userMsg([{ id: DOC_ID, name: 'weird.bin', mime_type: 'application/octet-stream', size: 3 }]);
    msg.content = { content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer', asset_pointer: `sediment://${DOC_ID}` }] };
    const body = convo([['n1', null, msg]], 'n1');
    expect(collectChatGptImagePointers(body)).toHaveLength(1);
    expect(collectChatGptDocumentAttachments(body)).toEqual([]);
  });

  it('de-duplicates by id', () => {
    const att = { id: DOC_ID, name: 'n.md', mime_type: 'text/markdown', size: 1 };
    const body = convo([['n1', null, userMsg([att])], ['n2', 'n1', userMsg([att, att])]], 'n2');
    expect(collectChatGptDocumentAttachments(body)).toHaveLength(1);
  });

  it('skips hidden messages on the branch pass but includes them on wholeTree', () => {
    const hidden = userMsg([{ id: DOC_ID, name: 'h.md', mime_type: 'text/markdown', size: 1 }],
      { metadata: { is_visually_hidden_from_conversation: true, attachments: [{ id: DOC_ID, name: 'h.md', mime_type: 'text/markdown', size: 1 }] } });
    const body = convo([['n1', null, hidden]], 'n1');
    expect(collectChatGptDocumentAttachments(body)).toEqual([]);
    expect(collectChatGptDocumentAttachments(body, { wholeTree: true })).toHaveLength(1);
  });

  it('wholeTree includes a dead sibling the branch pass does not', () => {
    const body = convo([
      ['root', null, userMsg([])],
      ['dead', 'root', userMsg([{ id: DOC_ID, name: 'd.md', mime_type: 'text/markdown', size: 1 }])],
      ['live', 'root', userMsg([])],
    ], 'live');
    expect(collectChatGptDocumentAttachments(body)).toEqual([]);
    expect(collectChatGptDocumentAttachments(body, { wholeTree: true })).toHaveLength(1);
  });

  it('ignores malformed bodies and attachments without an id', () => {
    expect(collectChatGptDocumentAttachments(null)).toEqual([]);
    const body = convo([['n1', null, userMsg([{ name: 'x.md' }, null, 'junk'])]], 'n1');
    expect(collectChatGptDocumentAttachments(body)).toEqual([]);
  });
});

describe('fetchChatGptFileBlobs — documents', () => {
  const jsonResp = (status, body) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => body });
  let calls;
  const install = (handler) => {
    calls = [];
    global.fetch = async (url, opts) => { calls.push(url); return handler(url, opts); };
    global.FileReader = class { readAsDataURL() { this.result = 'data:application/octet-stream;base64,QUJD'; this.onloadend(); } };
  };
  afterEach(() => { delete global.fetch; delete global.FileReader; });

  const docBody = (att) => convo([['n1', null, userMsg([att])]], 'n1');

  it('has a 25 MiB cap constant', () => {
    expect(CHATGPT_DOCUMENT_MAX_BYTES).toBe(25 * 1024 * 1024);
  });

  it('fetches a document into a files[] record keyed by the attachment id', async () => {
    install((url) => {
      if (url.includes(`/files/${DOC_ID}/download`)) return jsonResp(200, { status: 'success', download_url: 'https://files.oaiusercontent.com/d', file_name: 'route-name.md', mime_type: 'text/markdown' });
      if (url === 'https://files.oaiusercontent.com/d') return { ok: true, status: 200, headers: { get: (h) => h === 'content-type' ? 'text/markdown; charset=utf-8' : null }, blob: async () => ({}) };
      throw new Error('unexpected ' + url);
    });
    const out = await fetchChatGptFileBlobs('tok', docBody({ id: DOC_ID, name: 'notes.md', mime_type: 'text/markdown', size: 3 }), null);
    expect(out.failures).toEqual([]);
    expect(out.blobs).toEqual([{
      file_uuid: DOC_ID,
      file_name: 'notes.md',
      file_type: 'text/markdown',
      file_variant: 'original',
      data: 'data:text/markdown;base64,QUJD',
    }]);
  });

  it('falls back to the route file_name and mime when metadata lacks them', async () => {
    install((url) => {
      if (url.includes(`/files/${DOC_ID}/download`)) return jsonResp(200, { status: 'success', download_url: 'https://files.oaiusercontent.com/d', file_name: 'route.txt', mime_type: 'text/plain' });
      return { ok: true, status: 200, headers: { get: () => null }, blob: async () => ({}) };
    });
    const out = await fetchChatGptFileBlobs('tok', docBody({ id: DOC_ID, size: 3 }), null);
    expect(out.blobs[0].file_name).toBe('route.txt');
    expect(out.blobs[0].file_type).toBe('text/plain');
  });

  it('does not fetch an image attachment that is also an image pointer twice', async () => {
    install((url) => {
      if (url.includes('/download')) return jsonResp(200, { status: 'success', download_url: 'https://files.oaiusercontent.com/i', file_name: 'p.png', mime_type: 'image/png' });
      return { ok: true, status: 200, headers: { get: () => 'image/png' }, blob: async () => ({}) };
    });
    const msg = userMsg([{ id: IMG_ID, name: 'p.png', mime_type: 'image/png', size: 3 }]);
    msg.content = { content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer', asset_pointer: `sediment://${IMG_ID}` }] };
    const out = await fetchChatGptFileBlobs('tok', convo([['n1', null, msg]], 'n1'), null);
    expect(out.blobs).toHaveLength(1);
    expect(calls.filter((u) => u.includes('/download')).length).toBe(1);
  });

  it('surfaces an oversized document as a failure and never fetches it', async () => {
    install(() => { throw new Error('should not fetch'); });
    const size = CHATGPT_DOCUMENT_MAX_BYTES + 1;
    const out = await fetchChatGptFileBlobs('tok', docBody({ id: DOC_ID, name: 'big.pdf', mime_type: 'application/pdf', size }), null);
    expect(out.blobs).toEqual([]);
    expect(calls).toEqual([]);
    expect(out.failures).toHaveLength(1);
    expect(out.failures[0]).toMatchObject({ pointer: DOC_ID, id: DOC_ID, name: 'big.pdf' });
    expect(out.failures[0].error).toBe(`skipped: ${size} bytes exceeds CHATGPT_DOCUMENT_MAX_BYTES`);
  });

  it('a document route 404 becomes a failures entry and leaves other blobs alone', async () => {
    install((url) => {
      if (url.includes(IMG_ID) && url.includes('/files/') && url.endsWith('/download')) return jsonResp(200, { status: 'success', download_url: 'https://files.oaiusercontent.com/i', file_name: 'p.png', mime_type: 'image/png' });
      if (url === 'https://files.oaiusercontent.com/i') return { ok: true, status: 200, headers: { get: () => 'image/png' }, blob: async () => ({}) };
      return jsonResp(404, { detail: 'Not Found' });
    });
    const img = userMsg([{ id: IMG_ID, name: 'p.png', mime_type: 'image/png', size: 3 }]);
    img.content = { content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer', asset_pointer: `sediment://${IMG_ID}` }] };
    const doc = userMsg([{ id: DOC_ID, name: 'gone.md', mime_type: 'text/markdown', size: 3 }]);
    const out = await fetchChatGptFileBlobs('tok', convo([['n1', null, img], ['n2', 'n1', doc]], 'n2'), null);
    expect(out.blobs.map((b) => b.file_uuid)).toEqual([IMG_ID]);
    expect(out.failures).toHaveLength(1);
    expect(out.failures[0]).toMatchObject({ pointer: DOC_ID, id: DOC_ID, name: 'gone.md' });
    expect(out.failures[0].error).toMatch(/404/);
  });
});
