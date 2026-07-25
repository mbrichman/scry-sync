// Tests for full-fidelity file capture: the extension must fetch the ORIGINAL
// bytes of every uploaded file (image-PDFs, scanned docs, binaries the Anthropic
// export omits) — not just images — and the ingest payload must carry the raw
// full-tree JSON plus those file blobs so Scry can prove complete capture before
// anything is deleted from Claude.

import { describe, it, expect } from 'vitest';

const utils = require('../chrome/utils.js');
const scrySync = require('../chrome/scry_sync.js');
const { fileAssetRef, collectAllFiles } = utils;
const { buildIngestPayload } = scrySync;

describe('fileAssetRef', () => {
  it('prefers the document original for docs', () => {
    const ref = fileAssetRef({
      file_kind: 'document', file_uuid: 'd1',
      document_asset: { url: '/api/o/files/d1/document_pdf', file_variant: 'original' },
      thumbnail_asset: { url: '/api/o/files/d1/thumbnail' },
    });
    expect(ref).toEqual({ url: 'https://claude.ai/api/o/files/d1/document_pdf', variant: 'original' });
  });

  it('falls back to the image preview', () => {
    const ref = fileAssetRef({ file_kind: 'image', file_uuid: 'i1', preview_url: '/api/o/files/i1/preview' });
    expect(ref.url).toBe('https://claude.ai/api/o/files/i1/preview');
    expect(ref.variant).toBe('preview');
  });

  it('falls back to the thumbnail when nothing else', () => {
    const ref = fileAssetRef({ file_uuid: 't1', thumbnail_asset: { url: '/api/o/files/t1/thumbnail' } });
    expect(ref.url).toBe('https://claude.ai/api/o/files/t1/thumbnail');
    expect(ref.variant).toBe('thumbnail');
  });

  it('returns null when there is no fetchable asset', () => {
    expect(fileAssetRef({ file_uuid: 'x', file_name: 'note.txt' })).toBeNull();
  });

  it('leaves already-absolute urls untouched', () => {
    const ref = fileAssetRef({ file_uuid: 'a', document_asset: { url: 'https://claude.ai/api/o/files/a/document_pdf' } });
    expect(ref.url).toBe('https://claude.ai/api/o/files/a/document_pdf');
  });
});

describe('collectAllFiles', () => {
  const conv = () => ({
    uuid: 'c1',
    current_leaf_message_uuid: 'm2',
    chat_messages: [
      {
        uuid: 'm1', parent_message_uuid: 'root',
        files: [
          { file_uuid: 'd1', file_name: 'scan.pdf', file_type: 'application/pdf', file_kind: 'document',
            document_asset: { url: '/api/o/files/d1/document_pdf', file_variant: 'original' } },
          { file_uuid: 'i1', file_name: 'shot.png', file_kind: 'image', preview_url: '/api/o/files/i1/preview' },
        ],
      },
      // A DIFFERENT branch (not the current leaf) — its files must still be captured.
      {
        uuid: 'm1b', parent_message_uuid: 'root',
        files: [{ file_uuid: 'd2', file_name: 'other.bin', file_kind: 'document',
                  document_asset: { url: '/api/o/files/d2/document_pdf', file_variant: 'original' } }],
      },
      { uuid: 'm2', parent_message_uuid: 'm1', text: 'ok' },
    ],
  });

  it('collects every fetchable file across ALL branches, not just the current one', () => {
    const files = collectAllFiles(conv());
    expect(files.map(f => f.file_uuid).sort()).toEqual(['d1', 'd2', 'i1']);
  });

  it('carries the metadata Scry needs to store and key each blob', () => {
    const files = collectAllFiles(conv());
    const doc = files.find(f => f.file_uuid === 'd1');
    expect(doc).toMatchObject({
      file_uuid: 'd1', file_name: 'scan.pdf', file_type: 'application/pdf',
      file_variant: 'original', url: 'https://claude.ai/api/o/files/d1/document_pdf',
    });
  });

  it('de-duplicates by (file_uuid, variant)', () => {
    const dupe = conv();
    dupe.chat_messages[2].files = [dupe.chat_messages[0].files[0]]; // same d1/original again
    const files = collectAllFiles(dupe);
    expect(files.filter(f => f.file_uuid === 'd1')).toHaveLength(1);
  });

  it('skips entries with no fetchable asset', () => {
    const files = collectAllFiles({
      chat_messages: [{ uuid: 'm1', files: [{ file_uuid: 'txt', file_name: 'note.txt' }] }],
    });
    expect(files).toEqual([]);
  });
});

describe('buildIngestPayload — fidelity fields', () => {
  const conv = () => ({
    uuid: 'c1', name: 'X', created_at: 't0', updated_at: 't1',
    current_leaf_message_uuid: 'm1',
    chat_messages: [{ uuid: 'm1', parent_message_uuid: 'root', sender: 'human', text: 'hi',
                      tool_uses: [{ name: 'profile' }] }],
  });

  it('includes the verbatim full-tree JSON as raw_json', () => {
    const data = conv();
    const p = buildIngestPayload(data, {}, []);
    expect(p.raw_json).toBe(data);
    // and it still carries the block the pruned messages drop
    expect(p.raw_json.chat_messages[0].tool_uses[0].name).toBe('profile');
  });

  it('carries the fetched file blobs under files[]', () => {
    const blobs = [{ file_uuid: 'd1', file_name: 'scan.pdf', file_type: 'application/pdf',
                     file_variant: 'original', data: 'data:application/pdf;base64,AAA' }];
    const p = buildIngestPayload(conv(), {}, blobs);
    expect(p.files).toEqual(blobs);
  });

  it('defaults files to an empty array when none supplied', () => {
    const p = buildIngestPayload(conv(), {});
    expect(p.files).toEqual([]);
  });
});
