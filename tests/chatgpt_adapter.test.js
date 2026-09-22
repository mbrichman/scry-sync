// Tests for the ChatGPT read-only adapter's PURE transforms: reconstruct the
// visible branch from ChatGPT's `mapping` tree (the analog of Claude's
// current-branch walk), filter out system/hidden/empty turns, extract text
// across content types, normalize to the source-agnostic shape, and render
// markdown/JSON.

import { describe, it, expect, afterEach } from 'vitest';

const {
  getChatGptBranch,
  shouldSkipChatGptMessage,
  isDisplayableChatGptMessage,
  chatGptMessageText,
  chatGptTimeToIso,
  extractChatGptModelSlug,
  collectChatGptImagePointers,
  normalizeChatGptConversation,
  convertChatGptToMarkdown,
  chatGptConversationToJson,
  slugifyChatGptTitle,
} = require('../chrome/chatgpt_adapter.js');

// A conversation with a multimodal image (user upload) and a code-interpreter
// output image (tool). current_node = out.
function makeImageConversation() {
  return {
    conversation_id: 'img-1',
    title: 'Image chat',
    current_node: 'out',
    mapping: {
      root: { id: 'root', message: { author: { role: 'system' }, recipient: 'all', content: { content_type: 'text', parts: [''] }, metadata: { is_visually_hidden_from_conversation: true } }, parent: null, children: ['u'] },
      u: {
        id: 'u',
        message: {
          author: { role: 'user' }, recipient: 'all',
          content: { content_type: 'multimodal_text', parts: ['look at this', { content_type: 'image_asset_pointer', asset_pointer: 'sediment://file_ABC' }] },
        },
        parent: 'root', children: ['out'],
      },
      out: {
        id: 'out',
        message: {
          author: { role: 'tool', name: 'python' }, recipient: 'all',
          content: { content_type: 'execution_output', text: '' },
          metadata: { aggregate_result: { messages: [{ message_type: 'image', image_url: 'sediment://file_PLOT' }] } },
        },
        parent: 'u', children: [],
      },
    },
  };
}

// A realistic conversation body. Tree:
//   root(system,hidden) -> u1(user) -> a1(assistant, OLD, superseded branch)
//                                   \-> a2(assistant, NEW) -> u2(user) -> a3(assistant, code)
// current_node = a3, so a1's branch must NOT appear.
function makeConversation() {
  return {
    conversation_id: 'conv-123',
    title: 'My Test Chat',
    create_time: 1700000000,       // epoch seconds
    update_time: 1700000900,
    default_model_slug: 'gpt-4o',
    current_node: 'a3',
    mapping: {
      root: {
        id: 'root',
        message: {
          id: 'root', author: { role: 'system' },
          content: { content_type: 'text', parts: [''] },
          metadata: { is_visually_hidden_from_conversation: true },
        },
        parent: null, children: ['u1'],
      },
      u1: {
        id: 'u1',
        message: {
          id: 'u1', author: { role: 'user' }, create_time: 1700000010,
          content: { content_type: 'text', parts: ['Hello there'] },
        },
        parent: 'root', children: ['a1', 'a2'],
      },
      a1: {
        id: 'a1',
        message: {
          id: 'a1', author: { role: 'assistant' },
          content: { content_type: 'text', parts: ['OLD superseded answer'] },
          metadata: { model_slug: 'gpt-4o' },
        },
        parent: 'u1', children: [],
      },
      a2: {
        id: 'a2',
        message: {
          id: 'a2', author: { role: 'assistant' }, create_time: 1700000020,
          content: { content_type: 'text', parts: ['Hi! How can I help?'] },
          metadata: { model_slug: 'gpt-4o' },
        },
        parent: 'u1', children: ['u2'],
      },
      u2: {
        id: 'u2',
        message: {
          id: 'u2', author: { role: 'user' },
          content: { content_type: 'text', parts: ['Show me code'] },
        },
        parent: 'a2', children: ['a3'],
      },
      a3: {
        id: 'a3',
        message: {
          id: 'a3', author: { role: 'assistant' },
          content: { content_type: 'code', language: 'python', text: 'print("hi")' },
          metadata: { model_slug: 'gpt-4o' },
        },
        parent: 'u2', children: [],
      },
    },
  };
}

describe('getChatGptBranch', () => {
  it('walks current_node to root and returns oldest-first', () => {
    const branch = getChatGptBranch(makeConversation());
    expect(branch.map((m) => m.id)).toEqual(['root', 'u1', 'a2', 'u2', 'a3']);
  });

  it('excludes the superseded (a1) branch', () => {
    const branch = getChatGptBranch(makeConversation());
    expect(branch.find((m) => m.id === 'a1')).toBeUndefined();
  });

  it('falls back to the deepest leaf when current_node is missing', () => {
    const conv = makeConversation();
    delete conv.current_node;
    const branch = getChatGptBranch(conv);
    expect(branch[branch.length - 1].id).toBe('a3'); // deepest path wins
  });

  it('returns [] for a body with no mapping', () => {
    expect(getChatGptBranch({})).toEqual([]);
  });
});

describe('isDisplayableChatGptMessage', () => {
  it('drops system and visually-hidden messages', () => {
    const conv = makeConversation();
    expect(isDisplayableChatGptMessage(conv.mapping.root.message)).toBe(false);
  });
  it('keeps normal user/assistant messages', () => {
    const conv = makeConversation();
    expect(isDisplayableChatGptMessage(conv.mapping.u1.message)).toBe(true);
    expect(isDisplayableChatGptMessage(conv.mapping.a2.message)).toBe(true);
  });
  it('drops empty and zero-weight turns', () => {
    expect(isDisplayableChatGptMessage({
      author: { role: 'assistant' }, content: { content_type: 'text', parts: [''] },
    })).toBe(false);
    expect(isDisplayableChatGptMessage({
      author: { role: 'assistant' }, weight: 0, content: { content_type: 'text', parts: ['x'] },
    })).toBe(false);
  });
});

describe('shouldSkipChatGptMessage (ported from chatgpt-exporter)', () => {
  const base = { author: { role: 'assistant' }, recipient: 'all', content: { content_type: 'text', parts: ['x'] } };
  it('skips messages addressed to a tool (recipient !== all)', () => {
    expect(shouldSkipChatGptMessage({ ...base, recipient: 'python' })).toBe(true);
    expect(shouldSkipChatGptMessage({ ...base, recipient: 'browser' })).toBe(true);
  });
  it('skips hidden reasoning content types', () => {
    expect(shouldSkipChatGptMessage({ ...base, content: { content_type: 'thoughts', thoughts: [] } })).toBe(true);
    expect(shouldSkipChatGptMessage({ ...base, content: { content_type: 'reasoning_recap', content: 'x' } })).toBe(true);
  });
  it('skips memory/custom-instruction context', () => {
    expect(shouldSkipChatGptMessage({ ...base, content: { content_type: 'model_editable_context', model_set_context: 'x' } })).toBe(true);
    expect(shouldSkipChatGptMessage({ ...base, content: { content_type: 'user_editable_context', user_profile: 'x', user_instructions: 'y' } })).toBe(true);
  });
  it('skips system and visually-hidden', () => {
    expect(shouldSkipChatGptMessage({ ...base, author: { role: 'system' } })).toBe(true);
    expect(shouldSkipChatGptMessage({ ...base, metadata: { is_visually_hidden_from_conversation: true } })).toBe(true);
  });
  it('skips file_search tool and text-only tool messages, keeps tool image output', () => {
    expect(shouldSkipChatGptMessage({ author: { role: 'tool', name: 'file_search' }, recipient: 'all', content: { content_type: 'text', parts: ['x'] } })).toBe(true);
    expect(shouldSkipChatGptMessage({ author: { role: 'tool' }, recipient: 'all', content: { content_type: 'execution_output', text: 'log' } })).toBe(true);
    const toolImage = {
      author: { role: 'tool' }, recipient: 'all',
      content: { content_type: 'execution_output', text: '' },
      metadata: { aggregate_result: { messages: [{ message_type: 'image', image_url: 'sediment://x' }] } },
    };
    expect(shouldSkipChatGptMessage(toolImage)).toBe(false);
  });
  it('keeps a normal assistant text message', () => {
    expect(shouldSkipChatGptMessage(base)).toBe(false);
  });
});

describe('recipient filtering in the branch', () => {
  it('excludes a tool-call node (recipient python) from normalized output', () => {
    const conv = {
      conversation_id: 'c',
      current_node: 'a',
      mapping: {
        root: { id: 'root', message: { author: { role: 'system' }, content: { content_type: 'text', parts: [''] } }, parent: null, children: ['u'] },
        u: { id: 'u', message: { author: { role: 'user' }, recipient: 'all', content: { content_type: 'text', parts: ['do it'] } }, parent: 'root', children: ['tc'] },
        tc: { id: 'tc', message: { author: { role: 'assistant' }, recipient: 'python', content: { content_type: 'code', text: 'run()' } }, parent: 'u', children: ['a'] },
        a: { id: 'a', message: { author: { role: 'assistant' }, recipient: 'all', content: { content_type: 'text', parts: ['done'] } }, parent: 'tc', children: [] },
      },
    };
    const n = normalizeChatGptConversation(conv);
    expect(n.messages.map((m) => m.text)).toEqual(['do it', 'done']);
  });
});

describe('extractChatGptModelSlug', () => {
  it('prefers default_model_slug', () => {
    expect(extractChatGptModelSlug({ default_model_slug: 'gpt-4o', mapping: {} })).toBe('gpt-4o');
  });
  it('falls back to the first message model_slug', () => {
    const data = { mapping: { n: { message: { metadata: { model_slug: 'gpt-5-1-thinking' } } } } };
    expect(extractChatGptModelSlug(data)).toBe('gpt-5-1-thinking');
  });
  it('returns null when none present', () => {
    expect(extractChatGptModelSlug({ mapping: {} })).toBeNull();
  });
});

describe('collectChatGptImagePointers', () => {
  it('collects multimodal + code-interpreter image pointers from the branch', () => {
    expect(collectChatGptImagePointers(makeImageConversation()))
      .toEqual(['sediment://file_ABC', 'sediment://file_PLOT']);
  });
  it('dedupes and returns [] when there are no images', () => {
    expect(collectChatGptImagePointers(makeConversation())).toEqual([]);
  });
});

describe('image byte inlining via imageMap', () => {
  const imageMap = {
    'sediment://file_ABC': 'data:image/png;base64,AAAA',
    'sediment://file_PLOT': 'data:image/png;base64,BBBB',
  };
  it('inlines a fetched data URL for a multimodal image part', () => {
    const msg = { content: { content_type: 'multimodal_text', parts: ['hi', { content_type: 'image_asset_pointer', asset_pointer: 'sediment://file_ABC' }] } };
    expect(chatGptMessageText(msg, imageMap)).toBe('hi\n![image](data:image/png;base64,AAAA)');
  });
  it('leaves a placeholder when the map has no entry', () => {
    const msg = { content: { content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'sediment://file_ABC' }] } };
    expect(chatGptMessageText(msg, {})).toBe('![image](sediment://file_ABC)');
  });
  it('inlines code-interpreter output images', () => {
    const n = normalizeChatGptConversation(makeImageConversation(), imageMap);
    expect(n.messages[0].text).toContain('![image](data:image/png;base64,AAAA)');
    expect(n.messages[1].text).toBe('![image](data:image/png;base64,BBBB)');
  });
  it('markdown embeds the data URIs end to end', () => {
    const md = convertChatGptToMarkdown(makeImageConversation(), imageMap);
    expect(md).toContain('data:image/png;base64,AAAA');
    expect(md).toContain('data:image/png;base64,BBBB');
    expect(md).not.toContain('sediment://');
  });
});

describe('chatGptMessageText', () => {
  it('joins text parts', () => {
    expect(chatGptMessageText({ content: { content_type: 'text', parts: ['a', 'b'] } }))
      .toBe('a\nb');
  });
  it('fences code with its language', () => {
    expect(chatGptMessageText({ content: { content_type: 'code', language: 'python', text: 'x=1' } }))
      .toBe('```python\nx=1\n```');
  });
  it('renders image parts in multimodal_text as a placeholder', () => {
    const text = chatGptMessageText({
      content: {
        content_type: 'multimodal_text',
        parts: ['look:', { content_type: 'image_asset_pointer', asset_pointer: 'file-service://abc' }],
      },
    });
    expect(text).toBe('look:\n![image](file-service://abc)');
  });
  it('falls back to content.text for execution_output', () => {
    expect(chatGptMessageText({ content: { content_type: 'execution_output', text: 'result 42' } }))
      .toBe('result 42');
  });
  it('returns empty string for missing content', () => {
    expect(chatGptMessageText({})).toBe('');
  });
});

describe('chatGptTimeToIso', () => {
  it('converts epoch seconds to ISO', () => {
    expect(chatGptTimeToIso(1700000000)).toBe('2023-11-14T22:13:20.000Z');
  });
  it('passes through an ISO string', () => {
    expect(chatGptTimeToIso('2023-11-14T22:13:20.000Z')).toBe('2023-11-14T22:13:20.000Z');
  });
  it('returns null for nullish input', () => {
    expect(chatGptTimeToIso(null)).toBeNull();
    expect(chatGptTimeToIso(undefined)).toBeNull();
  });
});

describe('normalizeChatGptConversation', () => {
  it('produces the source-agnostic shape with only displayable turns', () => {
    const n = normalizeChatGptConversation(makeConversation());
    expect(n.id).toBe('conv-123');
    expect(n.title).toBe('My Test Chat');
    expect(n.model).toBe('gpt-4o');
    expect(n.created_at).toBe('2023-11-14T22:13:20.000Z');
    // system/hidden root dropped; a1 branch excluded.
    expect(n.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(n.messages[0].text).toBe('Hello there');
    expect(n.messages[3].text).toBe('```python\nprint("hi")\n```');
  });

  it('defaults a blank title', () => {
    const n = normalizeChatGptConversation({ mapping: {}, title: '   ' });
    expect(n.title).toBe('Untitled conversation');
  });
});

describe('convertChatGptToMarkdown', () => {
  it('renders a header, metadata, and labeled turns', () => {
    const md = convertChatGptToMarkdown(makeConversation());
    expect(md).toContain('# My Test Chat');
    expect(md).toContain('**Model:** gpt-4o');
    expect(md).toContain('## You');
    expect(md).toContain('## ChatGPT');
    expect(md).toContain('Hello there');
    expect(md).toContain('```python');
    expect(md).not.toContain('OLD superseded answer');
  });

  it('accepts an already-normalized object', () => {
    const n = normalizeChatGptConversation(makeConversation());
    expect(convertChatGptToMarkdown(n)).toContain('# My Test Chat');
  });
});

describe('chatGptConversationToJson', () => {
  it('emits pretty normalized JSON', () => {
    const parsed = JSON.parse(chatGptConversationToJson(makeConversation()));
    expect(parsed.id).toBe('conv-123');
    expect(parsed.messages).toHaveLength(4);
  });
});

describe('slugifyChatGptTitle', () => {
  it('makes a filesystem-safe slug', () => {
    expect(slugifyChatGptTitle('Hello, World! (v2)')).toBe('hello-world-v2');
  });
  it('falls back when empty', () => {
    expect(slugifyChatGptTitle('')).toBe('chatgpt-conversation');
    expect(slugifyChatGptTitle('!!!')).toBe('chatgpt-conversation');
  });
});

// --- Scry ingest payload -----------------------------------------------------
//
// Scry expects the VERBATIM ChatGPT body: it performs the current_node -> root
// branch walk server-side, so the import path and the fidelity-verification
// path prune with the same code and agree by construction. The client must not
// prune, and must not inline image bytes into message text.

const { buildChatGptIngestPayload } = require('../chrome/chatgpt_adapter.js');

describe('buildChatGptIngestPayload', () => {
  const body = () => ({
    conversation_id: 'c-1',
    title: 'Fixture',
    create_time: 1700000000,
    update_time: 1700000100,
    current_node: 'a1',
    mapping: {
      root: { id: 'root', parent: null, children: ['u1'], message: null },
      u1: {
        id: 'u1', parent: 'root', children: ['a0', 'a1'],
        message: { author: { role: 'user' }, recipient: 'all',
                   content: { content_type: 'text', parts: ['hi'] } },
      },
      a0: {
        id: 'a0', parent: 'u1', children: [],
        message: { author: { role: 'assistant' }, recipient: 'all',
                   content: { content_type: 'text', parts: ['dead branch'] } },
      },
      a1: {
        id: 'a1', parent: 'u1', children: [],
        message: { author: { role: 'assistant' }, recipient: 'all',
                   content: { content_type: 'text', parts: ['live branch'] } },
      },
    },
  });

  it('sends the body verbatim — no client-side pruning', () => {
    const out = buildChatGptIngestPayload(body());
    // The dead sibling MUST still be there: Scry decides what the branch is,
    // and the archive it writes has to be the full tree.
    expect(Object.keys(out.mapping).sort()).toEqual(['a0', 'a1', 'root', 'u1']);
    expect(out.current_node).toBe('a1');
    expect(out.conversation_id).toBe('c-1');
  });

  it("does not mutate the caller's body", () => {
    const original = body();
    buildChatGptIngestPayload(original, [{ file_uuid: 'f1', data: 'x' }]);
    expect(original.files).toBeUndefined();
  });

  it('attaches files[] only when there are blobs', () => {
    expect(buildChatGptIngestPayload(body()).files).toBeUndefined();
    const withFiles = buildChatGptIngestPayload(body(), [
      { file_uuid: 'f1', file_name: 'a.png', file_type: 'image/png',
        file_variant: 'original', data: 'data:image/png;base64,AAAA' },
    ]);
    expect(withFiles.files).toHaveLength(1);
    expect(withFiles.files[0].file_uuid).toBe('f1');
  });

  it('returns null for a non-object body rather than posting junk', () => {
    expect(buildChatGptIngestPayload(null)).toBeNull();
    expect(buildChatGptIngestPayload('nope')).toBeNull();
  });
});

// ===== live-push hardening =====

describe('buildChatGptIngestPayload — identity fallback', () => {
  const { buildChatGptIngestPayload } = require('../chrome/chatgpt_adapter.js');
  const body = () => ({
    title: 'No id on the body',
    create_time: 1700000000,
    current_node: 'a1',
    mapping: { a1: { id: 'a1', parent: null, children: [], message: null } },
  });

  it('fills conversation_id from the list id when the body lacks one', () => {
    // Scry keys the row AND the archive on conversation_id; a body without it
    // would import with no source id and skip fidelity capture entirely.
    const out = buildChatGptIngestPayload(body(), [], 'list-id-9');
    expect(out.conversation_id).toBe('list-id-9');
  });

  it("never overrides a conversation_id the body already carries", () => {
    const b = { ...body(), conversation_id: 'body-id' };
    expect(buildChatGptIngestPayload(b, [], 'list-id-9').conversation_id).toBe('body-id');
  });

  it('leaves the body untouched when no fallback is given', () => {
    expect(buildChatGptIngestPayload(body()).conversation_id).toBeUndefined();
  });
});

describe('withChatGptRateLimitRetry', () => {
  const { withChatGptRateLimitRetry, ChatGptRateLimitError } = require('../chrome/chatgpt_adapter.js');

  it('returns the value when the call succeeds first time', async () => {
    const sleeps = [];
    const out = await withChatGptRateLimitRetry(async () => 'ok', { sleep: (ms) => { sleeps.push(ms); } });
    expect(out).toBe('ok');
    expect(sleeps).toEqual([]);
  });

  it('waits Retry-After and retries on a 429, then succeeds', async () => {
    let calls = 0;
    const sleeps = [];
    const retries = [];
    const out = await withChatGptRateLimitRetry(async () => {
      calls++;
      if (calls === 1) throw new ChatGptRateLimitError('7');
      return 'second';
    }, { sleep: (ms) => { sleeps.push(ms); }, onRetry: (ms) => retries.push(ms) });
    expect(out).toBe('second');
    expect(calls).toBe(2);
    expect(sleeps).toEqual([7000]);
    expect(retries).toEqual([7000]);
  });

  it('gives up after maxRetries and rethrows the rate-limit error', async () => {
    let calls = 0;
    const sleeps = [];
    await expect(withChatGptRateLimitRetry(async () => {
      calls++;
      throw new ChatGptRateLimitError(null); // no header -> 30s default
    }, { maxRetries: 2, sleep: (ms) => { sleeps.push(ms); } })).rejects.toBeInstanceOf(ChatGptRateLimitError);
    expect(calls).toBe(3);
    expect(sleeps).toEqual([30000, 30000]);
  });

  it('does not retry non-rate-limit errors', async () => {
    let calls = 0;
    await expect(withChatGptRateLimitRetry(async () => {
      calls++;
      throw new Error('500');
    }, { sleep: () => {} })).rejects.toThrow('500');
    expect(calls).toBe(1);
  });
});

// ===== image bytes on push: files[] contract =====

describe('chatGptAssetId', () => {
  const { chatGptAssetId } = require('../chrome/chatgpt_adapter.js');
  it('extracts the id token after the scheme for both pointer schemes', () => {
    // Must match Scry's extract_asset_id (db/services/chatgpt_media_resolver.py)
    // exactly — that is the key attach_download_urls links on.
    expect(chatGptAssetId('sediment://file_00000000433071f5a7944f9cdd26ddcd')).toBe('file_00000000433071f5a7944f9cdd26ddcd');
    expect(chatGptAssetId('file-service://file-AbC123xyz')).toBe('file-AbC123xyz');
  });
  it('is not fooled by the scheme name itself', () => {
    // "file-service" also matches file[-_][A-Za-z0-9]+ — the id must come from after "://".
    expect(chatGptAssetId('file-service://file-Q')).toBe('file-Q');
  });
  it('returns null for junk', () => {
    expect(chatGptAssetId(null)).toBeNull();
    expect(chatGptAssetId('')).toBeNull();
    expect(chatGptAssetId('https://example.com/x.png')).toBeNull();
    expect(chatGptAssetId('sediment://')).toBeNull();
  });
});

describe('collectChatGptImagePointers — whole tree option', () => {
  const { collectChatGptImagePointers } = require('../chrome/chatgpt_adapter.js');
  const img = (ptr) => ({ content_type: 'image_asset_pointer', asset_pointer: ptr });
  const data = {
    current_node: 'a1',
    mapping: {
      root: { id: 'root', parent: null, children: ['u1'], message: null },
      u1: { id: 'u1', parent: 'root', children: ['a0', 'a1'],
            message: { author: { role: 'user' }, recipient: 'all',
                       content: { content_type: 'multimodal_text', parts: [img('sediment://file_u'), 'hi'] } } },
      a0: { id: 'a0', parent: 'u1', children: [],
            message: { author: { role: 'tool', name: 't2uay3k.sj1i4kz' }, recipient: 'all',
                       content: { content_type: 'multimodal_text', parts: [img('sediment://file_dead')] } } },
      a1: { id: 'a1', parent: 'u1', children: [],
            message: { author: { role: 'tool', name: 't2uay3k.sj1i4kz' }, recipient: 'all',
                       content: { content_type: 'multimodal_text', parts: [img('sediment://file_live')] } } },
    },
  };
  it('defaults to the visible branch', () => {
    expect(collectChatGptImagePointers(data)).toEqual(['sediment://file_u', 'sediment://file_live']);
  });
  it('walks every node when wholeTree is set, still deduped', () => {
    const all = collectChatGptImagePointers(data, { wholeTree: true }).sort();
    expect(all).toEqual(['sediment://file_dead', 'sediment://file_live', 'sediment://file_u']);
  });
});

describe('buildChatGptFileBlob', () => {
  const { buildChatGptFileBlob } = require('../chrome/chatgpt_adapter.js');
  it('produces the Scry files[] record keyed by asset id', () => {
    const out = buildChatGptFileBlob('sediment://file_abc', { file_name: 'dragons.png', mime_type: 'image/png' }, 'data:image/png;base64,AAAA');
    expect(out).toEqual({
      file_uuid: 'file_abc', file_name: 'dragons.png', file_type: 'image/png',
      file_variant: 'original', data: 'data:image/png;base64,AAAA',
    });
  });
  it('falls back to a name derived from the id and the data URL mime when meta is thin', () => {
    const out = buildChatGptFileBlob('file-service://file-Zz9', {}, 'data:image/webp;base64,BBBB');
    expect(out.file_uuid).toBe('file-Zz9');
    expect(out.file_type).toBe('image/webp');
    expect(out.file_name).toBe('file-Zz9.webp');
  });
  it('returns null when the pointer has no id or there is no data', () => {
    expect(buildChatGptFileBlob('nope', {}, 'data:image/png;base64,AA')).toBeNull();
    expect(buildChatGptFileBlob('sediment://file_a', {}, null)).toBeNull();
  });
});

describe('_fetchChatGptAsset — endpoint fallback and loud failure', () => {
  const { _fetchChatGptAsset, fetchChatGptFileBlobs } = require('../chrome/chatgpt_adapter.js');
  const jsonResp = (status, body) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => body });
  let calls;
  const install = (handler) => {
    calls = [];
    global.fetch = async (url, opts) => { calls.push(url); return handler(url, opts); };
    global.FileReader = class { readAsDataURL() { this.result = 'data:application/octet-stream;base64,QUJD'; this.onloadend(); } };
  };
  afterEach(() => { delete global.fetch; delete global.FileReader; });

  it('falls back to the conversation-scoped attachment endpoint when files/download fails', async () => {
    install((url) => {
      if (url.includes('/files/download/')) return jsonResp(404, { detail: 'Not Found' });
      if (url.includes('/conversation/conv-1/attachment/file_abc/download')) return jsonResp(200, { status: 'success', download_url: 'https://files.oaiusercontent.com/x', file_name: 'a.png', mime_type: 'image/png' });
      if (url === 'https://files.oaiusercontent.com/x') return { ok: true, status: 200, headers: { get: (h) => h === 'content-type' ? 'image/png' : null }, blob: async () => ({}) };
      throw new Error('unexpected ' + url);
    });
    const got = await _fetchChatGptAsset('tok', 'sediment://file_abc', null, 'conv-1');
    expect(got.meta.file_name).toBe('a.png');
    expect(got.dataUrl.startsWith('data:image/png')).toBe(true);
    expect(calls.some((u) => u.includes('/files/download/file_abc'))).toBe(true);
    expect(calls.some((u) => u.includes('/conversation/conv-1/attachment/file_abc/download'))).toBe(true);
  });

  it('throws with both endpoint statuses when neither yields a signed URL', async () => {
    install(() => jsonResp(404, { detail: 'nope' }));
    await expect(_fetchChatGptAsset('tok', 'sediment://file_abc', null, 'conv-1')).rejects.toThrow(/files\/download.*404.*attachment\/file_abc\/download.*404/s);
  });

  it('fetchChatGptFileBlobs returns failures instead of swallowing them', async () => {
    install(() => jsonResp(403, {}));
    const body = { conversation_id: 'conv-1', current_node: 't1', mapping: {
      t1: { id: 't1', parent: null, children: [], message: { author: { role: 'tool' }, recipient: 'all',
            content: { content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'sediment://file_abc' }] } } } } };
    const out = await fetchChatGptFileBlobs('tok', body, null);
    expect(out.blobs).toEqual([]);
    expect(out.failures).toHaveLength(1);
    expect(out.failures[0].pointer).toBe('sediment://file_abc');
    expect(out.failures[0].error).toMatch(/403/);
  });
});

describe('_bytesFetchOptions', () => {
  const { _bytesFetchOptions } = require('../chrome/chatgpt_adapter.js');
  it('sends the session (cookies + bearer) when the signed URL is on chatgpt.com', () => {
    const o = _bytesFetchOptions('https://chatgpt.com/backend-api/estuary/content?id=file_x&sig=abc', 'tok', null);
    expect(o.credentials).toBe('include');
    expect(o.headers.Authorization).toBe('Bearer tok');
    expect(o.headers.Accept).toBeUndefined();
  });
  it('stays anonymous for the separate media host', () => {
    const o = _bytesFetchOptions('https://files.oaiusercontent.com/file-x?sig=abc', 'tok', null);
    expect(o).toEqual({ credentials: 'omit' });
  });
  it('is anonymous for junk URLs rather than leaking the token', () => {
    expect(_bytesFetchOptions('not a url', 'tok', null)).toEqual({ credentials: 'omit' });
  });
});
