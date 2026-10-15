import { describe, expect, it } from 'vitest'
import {
  MEMORY_ONLY_SESSION_MAX_AGE_MS,
  isMemoryOnlySessionExpired,
  memoryOnlySessionDeadline,
} from '../memoryOnlySession.js'

function tokenWithExpiry(expSeconds: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url')
  return `header.${payload}.signature`
}

describe('memory-only session lifetime', () => {
  it('caps the local lease at 24 hours without extending an earlier server expiry', () => {
    const now = 2_000_000_000_000
    expect(
      memoryOnlySessionDeadline(tokenWithExpiry((now + 36 * 60 * 60 * 1000) / 1000), now)
    ).toBe(now + MEMORY_ONLY_SESSION_MAX_AGE_MS)
    expect(memoryOnlySessionDeadline(tokenWithExpiry((now + 2 * 60 * 60 * 1000) / 1000), now)).toBe(
      now + 2 * 60 * 60 * 1000
    )
  })

  it('requires a valid future server expiration and treats its boundary as expired', () => {
    const now = 2_000_000_000_000
    expect(() => memoryOnlySessionDeadline('not-a-jwt', now)).toThrow('expiry claim')
    expect(() => memoryOnlySessionDeadline(tokenWithExpiry(now / 1000), now)).toThrow('expired')
    expect(isMemoryOnlySessionExpired(now, now)).toBe(true)
    expect(isMemoryOnlySessionExpired(now + 1, now)).toBe(false)
  })
})
