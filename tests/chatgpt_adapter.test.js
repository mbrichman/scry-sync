// Tests for the ChatGPT read-only adapter's PURE transforms: reconstruct the
// visible branch from ChatGPT's `mapping` tree (the analog of Claude's
// current-branch walk), filter out system/hidden/empty turns, extract text
// across content types, normalize to the source-agnostic shape, and render
// markdown/JSON.

import { describe, it, expect } from 'vitest';

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
