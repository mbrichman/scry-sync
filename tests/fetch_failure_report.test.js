// Per-file fetch failure reporting: classifier, failure records, wire payloads.
import { describe, it, expect, afterEach, beforeEach } from 'vitest';

const adapter = require('../chrome/chatgpt_adapter.js');
const scrySync = require('../chrome/scry_sync.js');
const scryClient = require('../chrome/scry_client.js');
const { classifyFetchFailure, buildChatGptIngestPayload, fetchChatGptFileBlobs } = adapter;

beforeEach(() => {
  adapter._setChatGptGate(adapter.createChatGptGate({ spacing: { list: 0, body: 0, asset: 0 }, warn: () => {} }));
});

const err = (message, props = {}) => Object.assign(new Error(message), props);

describe('classifyFetchFailure', () => {
  it.each([
    [404, 'not_found'], [403, 'forbidden'], [401, 'forbidden'], [410, 'gone'],
    [429, 'rate_limited'], [500, 'server_error'], [503, 'server_error'],
  ])('explicit status %i -> %s', (status, reason) => {
    expect(classifyFetchFailure(err('x', { status }))).toEqual({ reason, status });
  });
  it('falls back to a status in the message', () => {
    expect(classifyFetchFailure(new Error('https://h/p: 404'))).toEqual({ reason: 'not_found', status: 404 });
    expect(classifyFetchFailure(new Error('bytes 410 from h'))).toEqual({ reason: 'gone', status: 410 });
  });
  it('size skips are too_large', () => {
    expect(classifyFetchFailure(new Error('skipped: 9 bytes exceeds CHATGPT_DOCUMENT_MAX_BYTES')).reason).toBe('too_large');
    expect(classifyFetchFailure(new Error('skipped: 9 bytes exceeds CHATGPT_GENUI_MAX_BYTES')).reason).toBe('too_large');
  });
  it('network-ish errors', () => {
    expect(classifyFetchFailure(new TypeError('Failed to fetch')).reason).toBe('network');
    expect(classifyFetchFailure(new Error('bytes fetch threw for host h (x) -- is that host in manifest host_permissions?')).reason).toBe('network');
  });
  it('unknown -> other', () => {
    expect(classifyFetchFailure(new Error('weird')).reason).toBe('other');
    expect(classifyFetchFailure(new Error('weird')).status).toBeNull();
  });
  it('vendor error JSON: file_not_found -> not_found, user_mismatch -> forbidden', () => {
    expect(classifyFetchFailure(err('no signed URL (x)', { noSignedUrl: true, status: 200, vendorError: 'file_not_found' })))
      .toEqual({ reason: 'not_found', status: 200 });
    expect(classifyFetchFailure(err('no signed URL (x)', { noSignedUrl: true, status: 200, vendorError: 'user_mismatch' })).reason).toBe('forbidden');
  });
  it('no signed URL: other error codes stay transient; 403 is forbidden', () => {
    expect(classifyFetchFailure(err('no signed URL (x)', { noSignedUrl: true, status: 200, vendorErrorOther: 'weird_code' })).reason).toBe('no_signed_url');
    expect(classifyFetchFailure(err('no signed URL (x)', { noSignedUrl: true, status: 404, statuses: [404, 403] })).reason).toBe('forbidden');
    expect(classifyFetchFailure(err('no signed URL (a: 404 | b: 404)', { noSignedUrl: true, status: 404, statuses: [404, 404] })))
      .toEqual({ reason: 'no_signed_url', status: 404 });
    expect(classifyFetchFailure(new Error('no signed URL (/x: 502)'))).toEqual({ reason: 'no_signed_url', status: 502 });
  });
  it('a rate-limit error that exhausted retries classifies as rate_limited', () => {
    expect(classifyFetchFailure(new adapter.ChatGptRateLimitError('429', 1000)).reason).toBe('rate_limited');
  });
});

const IMG = 'file_' + 'c'.repeat(32);
const DOC = 'file_' + 'a'.repeat(32);
const GURL = 'https://images.openai.com/static-rsc-4/tokX?purpose=inline';
const jsonResp = (status, body) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => body });

function body3() {
  const mk = (id, parent, message) => ({ id, parent, children: [], message });
  const user = { author: { role: 'user' }, recipient: 'all', content: { content_type: 'text', parts: ['hi'] },
    metadata: { attachments: [{ id: DOC, name: 'n.md', mime_type: 'text/markdown', size: 3 }] } };
  const asst = { author: { role: 'assistant' }, recipient: 'all',
    content: { content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer', asset_pointer: `file-service://${IMG}` }] },
    metadata: { model_dil_v2: { appData: { opGenui: { componentResults: { a: { componentName: 'AsyncImage', status: 'done',
      state: { images: [{ content_url: GURL, title: 'T' }] } } } } } } } };
  const mapping = { n0: mk('n0', null, user), n1: mk('n1', 'n0', asst) };
  mapping.n0.children.push('n1');
  return { conversation_id: 'conv-1', current_node: 'n1', mapping };
}

describe('fetchChatGptFileBlobs failure records', () => {
  afterEach(() => { delete global.fetch; delete global.FileReader; });

  it('carries id/kind/reason/status for image, document and genui', async () => {
    global.FileReader = class { readAsDataURL() { this.result = 'data:image/png;base64,QUJD'; this.onloadend(); } };
    global.fetch = async (url) => {
      if (url.includes(`/files/${IMG}/download`) && !url.includes('?')) return jsonResp(200, { status: 'error', error_code: 'file_not_found' });
      if (url.includes(DOC)) return jsonResp(403, {});
      if (url === GURL) return { ok: false, status: 404, headers: { get: () => null }, blob: async () => ({}) };
      return jsonResp(404, {});
    };
    const { blobs, failures } = await fetchChatGptFileBlobs('tok', body3(), null);
    expect(blobs).toEqual([]);
    const by = Object.fromEntries(failures.map((f) => [f.kind, f]));
    expect(by.image).toMatchObject({ id: IMG, kind: 'image', reason: 'not_found', status: 200 });
    expect(by.document).toMatchObject({ id: DOC, kind: 'document', reason: 'forbidden' });
    expect(by.genui).toMatchObject({ kind: 'genui', reason: 'not_found', status: 404 });
    expect(by.genui.id).toMatch(/^genui_[0-9a-f]{32}$/);
    expect(by.image.pointer).toBeTruthy();
    expect(typeof by.image.onBranch).toBe('boolean');
  });

  it('too-large document is too_large', async () => {
    const b = body3();
    b.mapping.n0.message.metadata.attachments[0].size = adapter.CHATGPT_DOCUMENT_MAX_BYTES + 1;
    global.fetch = async () => jsonResp(404, {});
    global.FileReader = class {};
    const { failures } = await fetchChatGptFileBlobs('tok', b, null);
    expect(failures.find((f) => f.kind === 'document')).toMatchObject({ id: DOC, reason: 'too_large' });
  });
});

describe('buildChatGptIngestPayload failures + report', () => {
  const b = { conversation_id: 'c', mapping: {} };
  it('omits file_failures when empty, no fetch_report unless given', () => {
    const p = buildChatGptIngestPayload(b, [], null, [], null);
    expect('file_failures' in p).toBe(false);
    expect('fetch_report' in p).toBe(false);
    expect(Object.keys(buildChatGptIngestPayload(b))).toEqual(Object.keys(b));
  });
  it('maps, skips id-less, truncates error, attaches report', () => {
    const rep = { attempted: 3, stored: 0, failed: 3, client_version: '3.4.0' };
    const p = buildChatGptIngestPayload(b, [], null, [
      { id: 'f1', kind: 'image', reason: 'not_found', status: 200, onBranch: true, error: 'e'.repeat(900) },
      { kind: 'image', reason: 'other', error: 'no id' },
    ], rep);
    expect(p.file_failures).toHaveLength(1);
    expect(p.file_failures[0]).toEqual({ file_uuid: 'f1', kind: 'image', reason: 'not_found', status: 200, on_branch: true, error: 'e'.repeat(500) });
    expect(p.fetch_report).toEqual(rep);
  });
});

describe('Claude path', () => {
  afterEach(() => { delete global.fetch; delete global.FileReader; delete global.classifyFetchFailure; delete global.collectAllFiles; });
  const convData = { uuid: 'u', chat_messages: [{ uuid: 'm1', files: [
    { file_uuid: 'a1', file_kind: 'image', file_name: 'x.png', preview_url: '/api/o/files/a1/preview' },
    { file_uuid: 'b2', file_kind: 'image', file_name: 'y.png', preview_url: '/api/o/files/b2/preview' },
  ] }] };

  it('collects failures and buildIngestPayload sends them', async () => {
    global.classifyFetchFailure = classifyFetchFailure;
    global.collectAllFiles = require('../chrome/utils.js').collectAllFiles;
    global.fetch = async (url) => {
      if (url.includes('a1')) return { ok: false, status: 404 };
      throw new TypeError('Failed to fetch');
    };
    const failures = [];
    const blobs = await scryClient.fetchConversationFileBlobs(convData, { failures });
    expect(blobs).toEqual([]);
    expect(failures.map((f) => [f.id, f.kind, f.reason, f.status])).toEqual([
      ['a1', 'claude_file', 'not_found', 404], ['b2', 'claude_file', 'network', null]]);
    const report = { attempted: 2, stored: 0, failed: 2, client_version: 'test' };
    const p = scrySync.buildIngestPayload(convData, {}, blobs, failures, report);
    expect(p.file_failures.map((f) => [f.file_uuid, f.reason, f.on_branch])).toEqual([['a1', 'not_found', true], ['b2', 'network', true]]);
    expect(p.fetch_report).toEqual(report);
  });

  it('buildIngestPayload without failures is unchanged', () => {
    const p = scrySync.buildIngestPayload(convData, {}, []);
    expect('file_failures' in p).toBe(false);
    expect('fetch_report' in p).toBe(false);
  });
});
