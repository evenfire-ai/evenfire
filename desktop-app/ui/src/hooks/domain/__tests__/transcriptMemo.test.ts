import { describe, expect, it } from 'vitest'
import type { AgentChatMessage } from '../../../uiTypes'
import { createTranscriptMemo, transcriptMemoKey } from '../transcriptMemo'

const LIMITS = { maxChats: 2, maxMessages: 3, maxAttachmentBase64Chars: 10 }

function message(id: string, dataBase64?: string): AgentChatMessage {
  return {
    id,
    role: 'user',
    content: id,
    timestamp: 1,
    ...(dataBase64 !== undefined
      ? { attachments: [{ name: `${id}.png`, mimeType: 'image/png', dataBase64 }] }
      : {}),
  } as AgentChatMessage
}

function entry(...messages: AgentChatMessage[]) {
  return { messages, hasOlderMessages: false, loadedLocalMessageCount: messages.length }
}

const scopeA = 'true:env:user:team-1'
const scopeB = 'true:env:user:team-2'

describe('transcriptMemo', () => {
  it('returns the stored entry by reference', () => {
    const memo = createTranscriptMemo(LIMITS)
    const stored = entry(message('m1'))
    memo.set(transcriptMemoKey(scopeA, 'host-a', 'chat-1'), stored)
    expect(memo.get(transcriptMemoKey(scopeA, 'host-a', 'chat-1'))).toBe(stored)
  })

  it('evicts the least recently used chat, counting a get as a use', () => {
    const memo = createTranscriptMemo(LIMITS)
    const k1 = transcriptMemoKey(scopeA, 'host-a', 'chat-1')
    const k2 = transcriptMemoKey(scopeA, 'host-a', 'chat-2')
    const k3 = transcriptMemoKey(scopeA, 'host-a', 'chat-3')
    memo.set(k1, entry(message('m1')))
    memo.set(k2, entry(message('m2')))
    expect(memo.get(k1)).toBeDefined()
    memo.set(k3, entry(message('m3')))
    expect(memo.get(k2)).toBeUndefined()
    expect(memo.get(k1)).toBeDefined()
    expect(memo.get(k3)).toBeDefined()
  })

  it('keeps auth scopes apart', () => {
    const memo = createTranscriptMemo(LIMITS)
    memo.set(transcriptMemoKey(scopeA, 'host-a', 'chat-1'), entry(message('m1')))
    expect(memo.get(transcriptMemoKey(scopeB, 'host-a', 'chat-1'))).toBeUndefined()
    expect(memo.get(transcriptMemoKey(scopeA, 'host-a', 'chat-1'))).toBeDefined()
  })

  it('deleteAgent removes only that Host', () => {
    const memo = createTranscriptMemo(LIMITS)
    memo.set(transcriptMemoKey(scopeA, 'host-a', 'chat-1'), entry(message('m1')))
    memo.set(transcriptMemoKey(scopeA, 'host-b', 'chat-1'), entry(message('m2')))
    memo.deleteAgent('host-a')
    expect(memo.get(transcriptMemoKey(scopeA, 'host-a', 'chat-1'))).toBeUndefined()
    expect(memo.get(transcriptMemoKey(scopeA, 'host-b', 'chat-1'))).toBeDefined()
  })

  it('clear removes every entry', () => {
    const memo = createTranscriptMemo(LIMITS)
    const key = transcriptMemoKey(scopeA, 'host-a', 'chat-1')
    memo.set(key, entry(message('m1')))
    expect(memo.get(key)).toBeDefined()
    memo.clear()
    expect(memo.get(key)).toBeUndefined()
  })

  it.each([
    ['an empty transcript', entry()],
    ['a transcript longer than maxMessages', entry(...['a', 'b', 'c', 'd'].map(id => message(id)))],
    ['attachments above the base64 budget', entry(message('m1', '12345678901'))],
  ])('does not store %s, and drops the previous entry for that chat', (_label, rejected) => {
    const memo = createTranscriptMemo(LIMITS)
    const key = transcriptMemoKey(scopeA, 'host-a', 'chat-1')
    // Positive control: an entry at the limits is stored.
    memo.set(key, entry(message('m1', '1234567890'), message('m2'), message('m3')))
    expect(memo.get(key)).toBeDefined()
    memo.set(key, rejected)
    expect(memo.get(key)).toBeUndefined()
  })
})
