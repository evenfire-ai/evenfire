import { describe, expect, it } from 'vitest'
import { serializeSessionKey } from '../../session/types'
import {
  SYSTEM_USER_KEY,
  deriveUserKey,
  deriveUserKeyFromSessionKey,
  deriveUserKeyFromSource,
} from '../userKey'

const HEX16 = /^[0-9a-f]{16}$/

describe('deriveUserKey', () => {
  it('is stable: same input produces the same key', () => {
    expect(deriveUserKey('123', 'telegram')).toBe(deriveUserKey('123', 'telegram'))
  })

  it('produces a 16-char lowercase hex key', () => {
    expect(deriveUserKey('123', 'telegram')).toMatch(HEX16)
  })

  it('is channel-namespaced: same sender on different channels yields different keys', () => {
    expect(deriveUserKey('123', 'telegram')).not.toBe(deriveUserKey('123', 'slack'))
  })

  it('separates different senders on the same channel', () => {
    expect(deriveUserKey('123', 'telegram')).not.toBe(deriveUserKey('124', 'telegram'))
  })

  it('is path-safe for malicious senders (no traversal characters leak through)', () => {
    expect(deriveUserKey('../../etc/passwd', 'rpc')).toMatch(HEX16)
    expect(deriveUserKey('a/b/c', 'rpc')).toMatch(HEX16)
    expect(deriveUserKey('x\0y', 'rpc')).toMatch(HEX16)
    // distinct malicious inputs still map to distinct keys (no collapse)
    expect(deriveUserKey('../../etc/passwd', 'rpc')).not.toBe(deriveUserKey('a/b/c', 'rpc'))
  })

  it('maps an empty / whitespace-only sender to the system key', () => {
    expect(deriveUserKey('', 'telegram')).toBe(SYSTEM_USER_KEY)
    expect(deriveUserKey('   ', 'telegram')).toBe(SYSTEM_USER_KEY)
    expect(deriveUserKey(null, 'telegram')).toBe(SYSTEM_USER_KEY)
    expect(deriveUserKey(undefined, 'telegram')).toBe(SYSTEM_USER_KEY)
  })

  it('trims the sender so padded variants resolve to the same key', () => {
    expect(deriveUserKey('  123  ', 'telegram')).toBe(deriveUserKey('123', 'telegram'))
  })
})

describe('deriveUserKeyFromSource', () => {
  it('returns the system key when there is no source message', () => {
    expect(deriveUserKeyFromSource(undefined)).toBe(SYSTEM_USER_KEY)
    expect(deriveUserKeyFromSource(null)).toBe(SYSTEM_USER_KEY)
  })

  it('matches deriveUserKey for the message sender + channel', () => {
    const source = { sender: 'U999', channelType: 'slack' as const }
    expect(deriveUserKeyFromSource(source)).toBe(deriveUserKey('U999', 'slack'))
  })
})

describe('deriveUserKeyFromSessionKey', () => {
  it('matches deriveUserKey for the first two segments', () => {
    const key = serializeSessionKey({ userId: 'U999', channelType: 'slack', channelId: 'C1' })
    expect(deriveUserKeyFromSessionKey(key)).toBe(deriveUserKey('U999', 'slack'))
  })

  it('agrees with deriveUserKeyFromSource for the same logical session', () => {
    const source = { sender: 'U999', channelType: 'slack' as const, channelId: 'C1' }
    const key = serializeSessionKey({
      userId: source.sender,
      channelType: source.channelType,
      channelId: source.channelId,
    })
    expect(deriveUserKeyFromSessionKey(key)).toBe(deriveUserKeyFromSource(source))
  })

  it('maps the anonymous/internal system fallback to the system key', () => {
    // TaskExecutor builds this sessionKey for tasks without a source message.
    const key = serializeSessionKey({ userId: 'anonymous', channelType: 'internal', channelId: '' })
    expect(deriveUserKeyFromSessionKey(key)).toBe(SYSTEM_USER_KEY)
    expect(deriveUserKeyFromSessionKey(key)).toBe(deriveUserKeyFromSource(undefined))
  })

  it('maps a malformed sessionKey to the system key', () => {
    expect(deriveUserKeyFromSessionKey('not-a-session-key')).toBe(SYSTEM_USER_KEY)
  })

  it('agrees with fromSource for an empty sender on a real channel (no split-brain)', () => {
    // TaskExecutor maps an empty sender to `anonymous` when building the
    // sessionKey, so both derivation paths must land on the same root.
    const source = { sender: '', channelType: 'telegram' as const }
    const key = serializeSessionKey({
      userId: source.sender || 'anonymous',
      channelType: source.channelType,
      channelId: 'C1',
    })
    expect(deriveUserKeyFromSource(source)).toBe(deriveUserKeyFromSessionKey(key))
  })

  it('treats a real sender named "anonymous" on a real channel as a real user', () => {
    // Only the exact source-less fallback (anonymous + internal) is system;
    // "anonymous" on telegram is a real user and must agree with fromSource.
    const key = serializeSessionKey({
      userId: 'anonymous',
      channelType: 'telegram',
      channelId: 'C1',
    })
    expect(deriveUserKeyFromSessionKey(key)).not.toBe(SYSTEM_USER_KEY)
    expect(deriveUserKeyFromSessionKey(key)).toBe(
      deriveUserKeyFromSource({ sender: 'anonymous', channelType: 'telegram' })
    )
  })
})
