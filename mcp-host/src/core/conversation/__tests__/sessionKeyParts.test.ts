import { describe, expect, it } from 'vitest'
import { sessionPartsFromPrefixedKey } from '../sessionKeyParts'

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
