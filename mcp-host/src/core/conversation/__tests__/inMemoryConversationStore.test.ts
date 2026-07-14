import { beforeEach, describe, expect, it } from 'vitest'
import { Conversation, ConversationState } from '../../types'
import { InMemoryConversationStore } from '../conversationStore'

function makeConversation(userId: string): Conversation {
  return {
    id: `conv-${userId}`,
    user_id: userId,
    state: ConversationState.Idle,
    turns: [],
    auto_approved_tools: new Set(),
    created_at: new Date(),
    updated_at: new Date(),
  }
}

describe('InMemoryConversationStore', () => {
  let store: InMemoryConversationStore

  beforeEach(() => {
    store = new InMemoryConversationStore()
  })

  describe('get / set / has', () => {
    it('get returns undefined for a missing key', () => {
      expect(store.get('missing')).toBeUndefined()
    })

    it('has returns false for a missing key', () => {
      expect(store.has('missing')).toBe(false)
    })

    it('set then get round-trips the same Conversation reference', () => {
      const conv = makeConversation('u-1')
      store.set('u-1:rpc:agent-x:chat-1', conv)
      expect(store.get('u-1:rpc:agent-x:chat-1')).toBe(conv)
    })

    it('has returns true after set', () => {
      store.set('u-1:rpc:agent-x:chat-1', makeConversation('u-1'))
      expect(store.has('u-1:rpc:agent-x:chat-1')).toBe(true)
    })

    it('set on an existing key replaces the value', () => {
      const first = makeConversation('u-1')
      const second = makeConversation('u-1')
      store.set('k', first)
      store.set('k', second)
      expect(store.get('k')).toBe(second)
      expect(store.get('k')).not.toBe(first)
    })
  })

  describe('listByPrefix', () => {
    it('returns [] on an empty store', () => {
      expect(store.listByPrefix('anything')).toEqual([])
    })

    it('with empty prefix returns every entry', () => {
      const a = makeConversation('u-1')
      const b = makeConversation('u-2')
      store.set('u-1:rpc:agent-x:chat-1', a)
      store.set('u-2:rpc:agent-x:chat-1', b)
      const result = store.listByPrefix('')
      expect(result).toHaveLength(2)
      const keys = result.map(r => r.key).sort()
      expect(keys).toEqual(['u-1:rpc:agent-x:chat-1', 'u-2:rpc:agent-x:chat-1'])
    })

    it('returns only entries whose key starts with the prefix', () => {
      const a = makeConversation('u-1')
      const b = makeConversation('u-2')
      const c = makeConversation('u-1')
      store.set('u-1:rpc:agent-x:chat-1', a)
      store.set('u-2:rpc:agent-x:chat-2', b)
      store.set('u-1:telegram:chan:thread', c)
      const result = store.listByPrefix('u-1:rpc:')
      expect(result).toHaveLength(1)
      expect(result[0].key).toBe('u-1:rpc:agent-x:chat-1')
      expect(result[0].conversation).toBe(a)
    })

    it('returns the same Conversation reference (not a copy)', () => {
      const conv = makeConversation('u-1')
      store.set('u-1:rpc:agent-x:chat-1', conv)
      const result = store.listByPrefix('u-1:rpc:')
      expect(result[0].conversation).toBe(conv)
    })

    it('respects prefix boundaries (trailing colon matters)', () => {
      // Key "alice-extra:..." must NOT be returned for prefix "alice:".
      // This is the defense against userIds that share a prefix with another
      // userId followed by ":" — e.g. "alice" vs "alice-extra".
      store.set('alice-extra:rpc:agent-x:chat-1', makeConversation('alice-extra'))
      store.set('alice:rpc:agent-x:chat-1', makeConversation('alice'))
      const result = store.listByPrefix('alice:')
      expect(result).toHaveLength(1)
      expect(result[0].key).toBe('alice:rpc:agent-x:chat-1')
    })

    it('returns [] when no keys match', () => {
      store.set('u-1:rpc:agent-x:chat-1', makeConversation('u-1'))
      expect(store.listByPrefix('u-2:')).toEqual([])
    })
  })
})
