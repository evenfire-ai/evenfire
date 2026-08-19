import { describe, expect, it } from 'vitest'
import { sessionPartsFromPrefixedKey, userIdFromStructuredSessionKey } from '../sessionKeyParts'

describe('sessionPartsFromPrefixedKey', () => {
  it('preserves scoped chat ids when the explicit agent matches the prefix', () => {
    expect(
      sessionPartsFromPrefixedKey(
        'subject:rpc:embedded:rpc:rpc:chat:trailing:',
        'subject:rpc:embedded:rpc:rpc:',
        'rpc'
      )
    ).toEqual({ agent: 'rpc', chatId: 'chat:trailing:' })
  })

  it('rejects an explicit scoped agent that does not match the prefix', () => {
    expect(
      sessionPartsFromPrefixedKey('u-1:rpc:agent-a:chat-1', 'u-1:rpc:agent-a:', 'agent-b')
    ).toBeNull()
  })

  it('preserves trailing colons in unscoped chat ids', () => {
    expect(sessionPartsFromPrefixedKey('u-1:rpc:agent-a:chat:', 'u-1:rpc:')).toEqual({
      agent: 'agent-a',
      chatId: 'chat:',
    })
  })
})

describe('userIdFromStructuredSessionKey', () => {
  it('preserves a colon-bearing owner by removing only the exact suffix', () => {
    expect(
      userIdFromStructuredSessionKey({
        sessionKey: 'subject:rpc:embedded:rpc:agent-x:chat-1',
        channelType: 'rpc',
        channelId: 'agent-x',
        threadId: 'chat-1',
      })
    ).toBe('subject:rpc:embedded')
  })

  it('uses serialized defaults and rejects missing or mismatched structure', () => {
    expect(
      userIdFromStructuredSessionKey({
        sessionKey: 'subject:rpc:default:default',
        channelType: 'rpc',
        channelId: null,
        threadId: null,
      })
    ).toBe('subject')
    expect(
      userIdFromStructuredSessionKey({
        sessionKey: 'subject:rpc:agent-x:chat-1',
        channelType: 'rpc',
        channelId: 'other-agent',
        threadId: 'chat-1',
      })
    ).toBeNull()
    expect(
      userIdFromStructuredSessionKey({
        sessionKey: 'subject:rpc:agent-x:chat-1',
        channelType: null,
        channelId: 'agent-x',
        threadId: 'chat-1',
      })
    ).toBeNull()
  })
})
