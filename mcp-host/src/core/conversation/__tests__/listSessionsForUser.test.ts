import { beforeEach, describe, expect, it } from 'vitest'
import { serializeSessionKey } from '../../../session/types'
import { ConversationManager } from '../conversation'

describe('ConversationManager.listSessionsForUser', () => {
  let manager: ConversationManager

  beforeEach(() => {
    manager = new ConversationManager()
  })

  it('returns empty array when no conversations exist', () => {
    expect(manager.listSessionsForUser('u-1:rpc:')).toEqual([])
  })

  it('returns only conversations whose key startsWith the prefix', async () => {
    const keyA = serializeSessionKey({
      userId: 'u-1',
      channelType: 'rpc',
      channelId: 'agent-x',
      threadId: 'chat-1',
    })
    const keyB = serializeSessionKey({
      userId: 'u-2',
      channelType: 'rpc',
      channelId: 'agent-x',
      threadId: 'chat-2',
    })
    const keyC = serializeSessionKey({
      userId: 'u-1',
      channelType: 'telegram',
      channelId: 'tg-1',
      threadId: 'thread-1',
    })
    await manager.getOrCreate(keyA)
    await manager.getOrCreate(keyB)
    await manager.getOrCreate(keyC)

    const result = manager.listSessionsForUser('u-1:rpc:')

    expect(result).toHaveLength(1)
    expect(result[0].agent).toBe('agent-x')
    expect(result[0].chatId).toBe('chat-1')
  })

  it('extracts agent and chatId correctly even if auth.sub contains a colon', async () => {
    const keyWithColonSub = `admin:u-99:rpc:agent-y:chat-7`
    await manager.getOrCreate(keyWithColonSub)
    const result = manager.listSessionsForUser('admin:u-99:rpc:')
    expect(result).toHaveLength(1)
    expect(result[0].agent).toBe('agent-y')
    expect(result[0].chatId).toBe('chat-7')
  })

  it('skips malformed entries (no colon after prefix) without throwing', async () => {
    await manager.getOrCreate('u-1:rpc:')
    expect(manager.listSessionsForUser('u-1:rpc:')).toEqual([])
  })

  it('returns a snapshot: agent, chatId, and the Conversation itself for handler use', async () => {
    const key = serializeSessionKey({
      userId: 'u-1',
      channelType: 'rpc',
      channelId: 'agent-x',
      threadId: 'chat-1',
    })
    const conv = await manager.getOrCreate(key)
    const result = manager.listSessionsForUser('u-1:rpc:')
    expect(result[0].conversation).toBe(conv)
    expect(result[0].key).toBe(key)
  })
})

describe('ConversationManager.getSessionByKey', () => {
  let manager: ConversationManager

  beforeEach(() => {
    manager = new ConversationManager()
  })

  it('returns undefined when no conversation exists for the key', () => {
    expect(manager.getSessionByKey('user-1:rpc:agent-x:chat-1')).toBeUndefined()
  })

  it('returns the conversation when the key matches', async () => {
    const key = serializeSessionKey({
      userId: 'user-1',
      channelType: 'rpc',
      channelId: 'agent-x',
      threadId: 'chat-1',
    })
    const conv = await manager.getOrCreate(key)
    expect(manager.getSessionByKey(key)).toBe(conv)
  })

  it('returns undefined when the key differs by even one character', async () => {
    const keyA = serializeSessionKey({
      userId: 'user-1',
      channelType: 'rpc',
      channelId: 'agent-x',
      threadId: 'chat-1',
    })
    const keyB = serializeSessionKey({
      userId: 'user-2',
      channelType: 'rpc',
      channelId: 'agent-x',
      threadId: 'chat-1',
    })
    await manager.getOrCreate(keyA)
    expect(manager.getSessionByKey(keyB)).toBeUndefined()
  })
})
