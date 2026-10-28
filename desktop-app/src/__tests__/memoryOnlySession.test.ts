import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  MEMORY_ONLY_SESSION_MAX_AGE_MS,
  isMemoryOnlySessionExpired,
  memoryOnlySessionDeadline,
  memoryOnlySessionDeadlines,
  memoryOnlySessionReplacementDeadline,
  memoryOnlySessionReplacementDeadlines,
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

  it('keeps server and local bounds in elapsed time when the wall clock moves backward', () => {
    const wallNow = 2_000_000_000_000
    const monotonicNow = 120_000
    const twelveHour = memoryOnlySessionDeadlines(
      tokenWithExpiry(wallNow / 1000 + 12 * 60 * 60),
      wallNow,
      monotonicNow
    )
    const twentyFourHour = memoryOnlySessionDeadlines(
      tokenWithExpiry(wallNow / 1000 + 36 * 60 * 60),
      wallNow,
      monotonicNow
    )

    expect(twelveHour).toEqual({
      expiresAt: wallNow + 12 * 60 * 60 * 1000,
      expiresAtMonotonicMs: monotonicNow + 12 * 60 * 60 * 1000,
    })
    expect(twentyFourHour).toEqual({
      expiresAt: wallNow + MEMORY_ONLY_SESSION_MAX_AGE_MS,
      expiresAtMonotonicMs: monotonicNow + MEMORY_ONLY_SESSION_MAX_AGE_MS,
    })
    expect(
      isMemoryOnlySessionExpired(
        twelveHour.expiresAt,
        wallNow - 2 * 60 * 60 * 1000,
        twelveHour.expiresAtMonotonicMs,
        monotonicNow + 12 * 60 * 60 * 1000
      )
    ).toBe(true)
    expect(
      isMemoryOnlySessionExpired(
        twentyFourHour.expiresAt,
        wallNow + 25 * 60 * 60 * 1000,
        twentyFourHour.expiresAtMonotonicMs,
        monotonicNow + 1 * 60 * 60 * 1000
      )
    ).toBe(true)
  })

  it('preserves the server and local deadline bounds across generated valid expirations', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1_900_000_000, max: 2_200_000_000 }),
        fc.integer({ min: 1, max: 48 * 60 * 60 }),
        (nowSeconds, lifetimeSeconds) => {
          const now = nowSeconds * 1000
          const serverDeadline = (nowSeconds + lifetimeSeconds) * 1000
          const deadline = memoryOnlySessionDeadline(
            tokenWithExpiry(nowSeconds + lifetimeSeconds),
            now
          )

          expect(deadline).toBe(Math.min(serverDeadline, now + MEMORY_ONLY_SESSION_MAX_AGE_MS))
          expect(isMemoryOnlySessionExpired(deadline, now)).toBe(false)
          expect(isMemoryOnlySessionExpired(deadline, deadline)).toBe(true)
          expect(isMemoryOnlySessionExpired(deadline, deadline + 1)).toBe(true)
        }
      ),
      { numRuns: 10000 }
    )
  })

  it('never extends the original lease when any later credential is committed', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1_900_000_000, max: 2_200_000_000 }),
        fc.integer({ min: 1, max: 48 * 60 * 60 }),
        fc.integer({ min: 1, max: 48 * 60 * 60 }),
        (nowSeconds, initialLifetimeSeconds, replacementLifetimeSeconds) => {
          const now = nowSeconds * 1000
          const initialDeadline = memoryOnlySessionDeadline(
            tokenWithExpiry(nowSeconds + initialLifetimeSeconds),
            now
          )
          const replacementDeadline = memoryOnlySessionReplacementDeadline(
            initialDeadline,
            tokenWithExpiry(nowSeconds + replacementLifetimeSeconds),
            now
          )

          expect(replacementDeadline).toBeLessThanOrEqual(initialDeadline)
          expect(replacementDeadline).toBeLessThanOrEqual(
            (nowSeconds + replacementLifetimeSeconds) * 1000
          )
        }
      ),
      { numRuns: 10000 }
    )
  })

  it('never extends either clock bound when a replacement token has a later expiry', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1_900_000_000, max: 2_200_000_000 }),
        fc.integer({ min: 2 * 60 * 60, max: 23 * 60 * 60 }),
        fc.integer({ min: 1, max: 48 * 60 * 60 }),
        fc.integer({ min: 1_000, max: 60 * 60 * 1000 }),
        (nowSeconds, initialLifetimeSeconds, replacementLifetimeSeconds, elapsed) => {
          const wallNow = nowSeconds * 1000
          const monotonicNow = elapsed
          const current = memoryOnlySessionDeadlines(
            tokenWithExpiry(nowSeconds + initialLifetimeSeconds),
            wallNow,
            monotonicNow
          )
          const replacement = memoryOnlySessionReplacementDeadlines(
            current,
            tokenWithExpiry(nowSeconds + initialLifetimeSeconds + replacementLifetimeSeconds),
            wallNow + elapsed,
            monotonicNow + elapsed
          )

          expect(replacement.expiresAt).toBeLessThanOrEqual(current.expiresAt)
          expect(replacement.expiresAtMonotonicMs).toBeLessThanOrEqual(current.expiresAtMonotonicMs)
        }
      ),
      { numRuns: 10_000 }
    )
  })
})
