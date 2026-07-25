import { describe, it, expect } from 'vitest';
import scrySync from '../chrome/scry_sync.js';

const { buildIngestPayload, selectConversationsSince, filterUnsynced, withRetry } = scrySync;

// A small conversation tree: m1 (human, with an image) -> m2 (assistant), plus
// m3 an abandoned edit branching off root that is NOT on the current path.
function sampleConversation() {
  return {
    uuid: 'conv-1',
    name: 'Design chat',
    created_at: '2026-07-24T10:00:00Z',
    updated_at: '2026-07-24T10:05:00Z',
    current_leaf_message_uuid: 'm2',
    chat_messages: [
      {
        uuid: 'm1',
        parent_message_uuid: '00000000-0000-0000-0000-000000000000',
        sender: 'human',
        text: 'look at this',
        files: [
          { file_uuid: 'u1', file_name: 'shot.png', file_kind: 'image', preview_url: '/api/o/files/u1/preview' },
        ],
      },
      { uuid: 'm2', parent_message_uuid: 'm1', sender: 'assistant', text: 'nice' },
      { uuid: 'm3', parent_message_uuid: 'm1', sender: 'assistant', text: 'abandoned edit' },
    ],
  };
}

describe('buildIngestPayload', () => {
  it('carries conversation identity + timestamps for Scry idempotency', () => {
    const p = buildIngestPayload(sampleConversation(), {});
    expect(p.uuid).toBe('conv-1');
    expect(p.name).toBe('Design chat');
    expect(p.created_at).toBe('2026-07-24T10:00:00Z');
    expect(p.updated_at).toBe('2026-07-24T10:05:00Z');
  });

  it('prunes to the current branch (drops abandoned edits)', () => {
    const p = buildIngestPayload(sampleConversation(), {});
    expect(p.chat_messages.map(m => m.uuid)).toEqual(['m1', 'm2']);
  });

  it('attaches the base64 data_url to the matching image file', () => {
    const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
    const p = buildIngestPayload(sampleConversation(), { u1: dataUrl });
    const img = p.chat_messages[0].files[0];
    expect(img.data_url).toBe(dataUrl);
    expect(img.file_type).toBe('image/png'); // derived from the data URL
  });

  it('leaves an image without fetched bytes untouched (no data_url)', () => {
    const p = buildIngestPayload(sampleConversation(), {}); // no bytes for u1
    expect(p.chat_messages[0].files[0].data_url).toBeUndefined();
  });

  it('does not mutate the source conversation', () => {
    const conv = sampleConversation();
    buildIngestPayload(conv, { u1: 'data:image/png;base64,AAA' });
    expect(conv.chat_messages[0].files[0].data_url).toBeUndefined();
  });
});

describe('selectConversationsSince', () => {
  const convs = [
    { uuid: 'a', updated_at: '2026-07-24T09:00:00Z' },
    { uuid: 'b', updated_at: '2026-07-20T09:00:00Z' },
    { uuid: 'c', updated_at: '2026-07-10T09:00:00Z' },
  ];

  it('returns only conversations updated at/after the cutoff', () => {
    const cutoff = Date.parse('2026-07-19T00:00:00Z');
    expect(selectConversationsSince(convs, cutoff).map(c => c.uuid)).toEqual(['a', 'b']);
  });

  it('returns everything when cutoff is null (full sync)', () => {
    expect(selectConversationsSince(convs, null)).toHaveLength(3);
  });
});

describe('filterUnsynced', () => {
  const convs = [
    { uuid: 'a', updated_at: '2026-07-24T10:05:00Z' }, // already synced at this ts
    { uuid: 'b', updated_at: '2026-07-24T10:00:00Z' }, // synced earlier, changed since
    { uuid: 'c', updated_at: '2026-07-24T09:00:00Z' }, // never synced
  ];
  const synced = { a: '2026-07-24T10:05:00Z', b: '2026-07-24T09:00:00Z' };

  it('drops conversations already synced at their current updated_at', () => {
    expect(filterUnsynced(convs, synced).map(c => c.uuid)).toEqual(['b', 'c']);
  });

  it('returns all when nothing has been synced yet', () => {
    expect(filterUnsynced(convs, {})).toHaveLength(3);
  });
});

describe('withRetry', () => {
  it('returns immediately on success without retrying', async () => {
    let calls = 0;
    const r = await withRetry(() => { calls++; return 'ok'; }, { delayMs: 0 });
    expect(r).toBe('ok');
    expect(calls).toBe(1);
  });

  it('retries a throwing fn (transient "Failed to fetch") and eventually succeeds', async () => {
    let calls = 0;
    const r = await withRetry(async () => {
      calls++;
      if (calls < 3) throw new TypeError('Failed to fetch');
      return 'ok';
    }, { retries: 3, delayMs: 0 });
    expect(r).toBe('ok');
    expect(calls).toBe(3);
  });

  it('gives up after the retry budget and rethrows', async () => {
    let calls = 0;
    await expect(
      withRetry(() => { calls++; throw new Error('boom'); }, { retries: 2, delayMs: 0 })
    ).rejects.toThrow('boom');
    expect(calls).toBe(3); // initial + 2 retries
  });

  it('retries a retryable result (5xx) then returns the success', async () => {
    let calls = 0;
    const shouldRetry = ({ threw, result }) => threw || (result && result.status >= 500);
    const r = await withRetry(async () => {
      calls++;
      return { status: calls < 2 ? 503 : 200 };
    }, { retries: 3, delayMs: 0, shouldRetry });
    expect(r.status).toBe(200);
    expect(calls).toBe(2);
  });

  it('does NOT retry a non-retryable result (4xx)', async () => {
    let calls = 0;
    const shouldRetry = ({ threw, result }) => threw || (result && result.status >= 500);
    const r = await withRetry(async () => { calls++; return { status: 401 }; },
      { retries: 3, delayMs: 0, shouldRetry });
    expect(r.status).toBe(401);
    expect(calls).toBe(1);
  });
});
