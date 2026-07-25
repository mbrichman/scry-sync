// Tests for the soft-empty (stub) guard: Claude's body endpoint can return a
// 200 with an EMPTY chat_messages array for a conversation that actually had
// content (seen under parallel load on older conversations). Archiving that stub
// would pass Scry's message-count check trivially (0 == 0) and read a false
// green — making the conversation wrongly deletion-eligible while we hold an
// empty shell. The extension must recognise the stub and refuse to archive it,
// so it stays in reconcile's to_resync. This predicate mirrors Scry's
// _archive_is_empty_stub exactly (symmetric gate on both sides).
import { describe, test, expect } from 'vitest';
const { conversationBodyIsStub } = require('../chrome/scry_client.js');

describe('conversationBodyIsStub', () => {
  test('a body with messages is never a stub', () => {
    expect(conversationBodyIsStub({
      name: 'x', created_at: 'a', updated_at: 'b',
      chat_messages: [{ uuid: 'm1' }],
    })).toBe(false);
  });

  test('titled + empty chat_messages is a stub (Claude titles from content)', () => {
    expect(conversationBodyIsStub({
      name: 'Legal document management platforms',
      created_at: '2025-10-16T04:57:34Z', updated_at: '2025-10-16T04:58:02Z',
      chat_messages: [],
    })).toBe(true);
  });

  test('untitled but updated != created is a stub (a message was written)', () => {
    expect(conversationBodyIsStub({
      name: '', created_at: '2025-08-17T22:47:48Z', updated_at: '2025-08-17T22:48:10Z',
      chat_messages: [],
    })).toBe(true);
  });

  test('genuinely empty new chat (no title AND created == updated) is NOT a stub', () => {
    expect(conversationBodyIsStub({
      name: '', created_at: '2025-09-07T04:04:03Z', updated_at: '2025-09-07T04:04:03Z',
      chat_messages: [],
    })).toBe(false);
  });

  test('missing chat_messages key with a title is a stub', () => {
    expect(conversationBodyIsStub({
      name: 'Something', created_at: 'a', updated_at: 'a',
    })).toBe(true);
  });

  test('null / non-object is not a stub', () => {
    expect(conversationBodyIsStub(null)).toBe(false);
    expect(conversationBodyIsStub(undefined)).toBe(false);
  });
});
