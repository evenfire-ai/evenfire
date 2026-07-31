import { beforeEach, describe, expect, it } from 'vitest'
import { Conversation, ConversationState } from '../../types'
import { InMemoryConversationStore, boundedTurns } from '../conversationStore'

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

function makeTurn(number: number) {
  return {
    number,
    user_input: `user ${number}`,
    response: `assistant ${number}`,
    tool_calls: [],
    started_at: new Date(`2026-01-01T00:00:0${number % 10}.000Z`),
    completed_at: new Date(`2026-01-01T00:00:0${number % 10}.500Z`),
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

  describe('listSessionSummariesByPrefix', () => {
    it('uses the same binary tie-breaker as session cursors', async () => {
      const updatedAt = new Date('2026-01-01T00:00:00.000Z')
      const upper = { ...makeConversation('u-1'), updated_at: updatedAt }
      const lower = { ...makeConversation('u-1'), updated_at: updatedAt }
      store.set('u-1:rpc:agent-x:B1', upper)
      store.set('u-1:rpc:agent-x:a1', lower)

      const first = await store.listSessionSummariesByPrefix('u-1:rpc:', { limit: 1 })
      expect(first.map(session => session.chatId)).toEqual(['B1'])

      const second = await store.listSessionSummariesByPrefix('u-1:rpc:', {
        limit: 1,
        cursor: {
          updatedAt: first[0]!.lastActivityAt,
          key: first[0]!.key,
        },
      })
      expect(second.map(session => session.chatId)).toEqual(['a1'])
    })

    it('projects agent and chat ids from an agent-scoped prefix', async () => {
      store.set('u-1:rpc:agent-x:chat-1', makeConversation('u-1'))
      store.set('u-1:rpc:agent-y:chat-2', makeConversation('u-1'))

      const summaries = await store.listSessionSummariesByPrefix('u-1:rpc:agent-x:', {
        agent: 'agent-x',
      })

      expect(summaries.map(session => [session.agent, session.chatId])).toEqual([
        ['agent-x', 'chat-1'],
      ])
    })

    it('preserves colons in chat ids under an agent-scoped prefix', async () => {
      store.set('u-1:rpc:agent-x:chat:with:colons', makeConversation('u-1'))

      const summaries = await store.listSessionSummariesByPrefix('u-1:rpc:agent-x:', {
        agent: 'agent-x',
      })

      expect(summaries.map(session => [session.agent, session.chatId])).toEqual([
        ['agent-x', 'chat:with:colons'],
      ])
    })

    it('preserves a trailing colon in a chat id under an unscoped prefix', async () => {
      store.set('u-1:rpc:agent-x:chat-trailing:', makeConversation('u-1'))

      const summaries = await store.listSessionSummariesByPrefix('u-1:rpc:')

      expect(summaries.map(session => [session.agent, session.chatId])).toEqual([
        ['agent-x', 'chat-trailing:'],
      ])
    })

    it('supports an agent literally named rpc when the scoped agent is explicit', async () => {
      store.set('u-1:rpc:rpc:chat-1', makeConversation('u-1'))

      const summaries = await store.listSessionSummariesByPrefix('u-1:rpc:rpc:', {
        agent: 'rpc',
      })

      expect(summaries.map(session => [session.agent, session.chatId])).toEqual([['rpc', 'chat-1']])
    })

    it('parses an unscoped prefix when the user subject contains :rpc:', async () => {
      const userId = 'subject:rpc:embedded'
      store.set(`${userId}:rpc:agent-x:chat-1`, makeConversation(userId))

      const summaries = await store.listSessionSummariesByPrefix(`${userId}:rpc:`)

      expect(summaries.map(session => [session.agent, session.chatId])).toEqual([
        ['agent-x', 'chat-1'],
      ])
    })

    it('does not list an overlapping colon-bearing owner for a shorter subject', async () => {
      const callerUserId = 'u1'
      const ownerUserId = 'u1:rpc:a'
      const key = `${ownerUserId}:rpc:agent-x:chat-1`
      store.set(key, makeConversation(ownerUserId))

      const ownerPage = await store.listSessionSummariesByPrefix(`${ownerUserId}:rpc:`)
      const callerPage = await store.listSessionSummariesByPrefix(`${callerUserId}:rpc:`)

      expect(ownerPage.map(summary => summary.key)).toEqual([key])
      expect(callerPage).toEqual([])
    })

    it('rejects malformed unscoped keys before applying the page limit', async () => {
      const malformedEmptyAgent = {
        ...makeConversation('u-1'),
        updated_at: new Date('2026-01-03T00:00:00.000Z'),
      }
      const malformedEmptyChat = {
        ...makeConversation('u-1'),
        updated_at: new Date('2026-01-02T00:00:00.000Z'),
      }
      const valid = {
        ...makeConversation('u-1'),
        updated_at: new Date('2026-01-01T00:00:00.000Z'),
      }
      store.set('u-1:rpc::missing-agent', malformedEmptyAgent)
      store.set('u-1:rpc:agent-x:', malformedEmptyChat)
      store.set('u-1:rpc:agent-x:chat-1', valid)

      const summaries = await store.listSessionSummariesByPrefix('u-1:rpc:', { limit: 1 })

      expect(summaries.map(session => [session.agent, session.chatId])).toEqual([
        ['agent-x', 'chat-1'],
      ])
    })

    it('counts user and assistant bubbles without counting tool storage rows', async () => {
      const conversation = makeConversation('u-1')
      conversation.turns = [
        {
          ...makeTurn(1),
          tool_calls: [
            {
              name: 'search',
              parameters: {},
              result: 'found',
            },
          ],
        },
      ]
      store.set('u-1:rpc:agent-x:chat-1', conversation)

      const [summary] = await store.listSessionSummariesByPrefix('u-1:rpc:')

      expect(summary?.messageCount).toBe(2)
    })
  })

  describe('boundedTurns', () => {
    const turns = [makeTurn(1), makeTurn(2), makeTurn(3)]

    it.each([0, -1, 1.5])('returns no turns for an unsafe limit of %s', limit => {
      expect(boundedTurns(turns, { limit })).toEqual([])
      expect(boundedTurns(turns, { limit, afterTurn: 0 })).toEqual([])
    })
  })

  describe('getSessionMessagesByKey', () => {
    it('returns only the requested turn window', async () => {
      const conv = makeConversation('u-1')
      conv.turns = [makeTurn(1), makeTurn(2), makeTurn(3), makeTurn(4)]
      store.set('u-1:rpc:agent-x:chat-1', conv)

      const page = await store.getSessionMessagesByKey('u-1:rpc:agent-x:chat-1', 'u-1:rpc:', {
        limit: 2,
        beforeTurn: 4,
      })

      expect(page?.agent).toBe('agent-x')
      expect(page?.chatId).toBe('chat-1')
      expect(page?.totalTurns).toBe(4)
      expect(page?.firstTurnNumber).toBe(1)
      expect(page?.lastTurnNumber).toBe(4)
      expect(page?.turns.map(turn => turn.number)).toEqual([2, 3])
    })

    it('does not read an overlapping colon-bearing owner through a shorter subject', async () => {
      const callerUserId = 'u1'
      const ownerUserId = 'u1:rpc:a'
      const key = `${ownerUserId}:rpc:agent-x:chat-1`
      const conversation = makeConversation(ownerUserId)
      conversation.turns = [makeTurn(1)]
      store.set(key, conversation)

      await expect(
        store.getSessionMessagesByKey(key, `${ownerUserId}:rpc:`)
      ).resolves.toMatchObject({ key, totalTurns: 1 })
      await expect(
        store.getSessionMessagesByKey(key, `${callerUserId}:rpc:`)
      ).resolves.toBeUndefined()
    })
  })
})
