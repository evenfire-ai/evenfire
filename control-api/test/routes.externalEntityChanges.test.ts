import { describe, expect, it, vi } from 'vitest'
import { isEntityChangeExternalSessionCurrent } from '../src/routes/external/entityChanges.routes.js'

const sessionAuth = vi.hoisted(() => ({
  requireValidExternalSessionToken: vi.fn(),
}))
const currentness = vi.hoisted(() => ({ observe: vi.fn() }))

vi.mock('../src/middleware/externalSessionAuth.js', () => sessionAuth)
vi.mock('../src/services/auth/externalSessionCurrentnessObserver.js', () => ({
  observeExternalSessionCurrentness: currentness.observe,
}))

describe('external entity-change stream authorization', () => {
  it('observes original authenticated V2 authority instead of its V1 projection', async () => {
    const authentication = {
      status: 'authenticated' as const,
      contract: 'v2' as const,
      tokenClaims: {
        sub: 'user-1',
        sid: 'sid-1',
        jti: 'jti-1',
        sv: 1,
        exp: 10_000,
      },
      authorityContext: {
        contract: 'v2' as const,
        userId: 'user-1',
        sid: 'sid-1',
        jti: 'jti-1',
        sessionVersion: 1,
      },
      claims: {
        userId: 'user-1',
        email: 'user@example.test',
        teamId: null,
        role: 'member' as const,
        exp: 10_000,
        iat: 1,
        sessionContract: 'v2',
        sid: 'sid-1',
        jti: 'jti-1',
        sv: 1,
        ver: 2,
      },
      policy: {},
    }
    currentness.observe.mockReset().mockResolvedValue({ status: 'current' })

    await expect(isEntityChangeExternalSessionCurrent(authentication as never)).resolves.toEqual({
      status: 'current',
    })
    expect(currentness.observe).toHaveBeenCalledWith(authentication, {})
  })

  it('preserves unavailable as a retryable authority state', async () => {
    const authentication = {
      status: 'authenticated' as const,
      contract: 'v1' as const,
      tokenClaims: { userId: 'user-1', iat: 999, exp: 1_000, authGeneration: 1 },
      authorityContext: {
        contract: 'v1' as const,
        userId: 'user-1',
        tokenHash: 'fingerprint-1',
        issuedAt: 999,
        authGeneration: 1,
      },
      claims: {
        userId: 'user-1',
        email: 'user@example.test',
        teamId: 'team-1',
        role: 'member' as const,
        authGeneration: 1,
        exp: 1_000,
        iat: 999,
      },
      policy: {},
    }
    const error = new Error('database unavailable')
    currentness.observe.mockResolvedValue({ status: 'unavailable', error })

    await expect(isEntityChangeExternalSessionCurrent(authentication as never)).resolves.toEqual({
      status: 'unavailable',
      error,
    })
  })

  it('uses the original authority context for observer rechecks', async () => {
    const authentication = {
      status: 'authenticated' as const,
      contract: 'v1' as const,
      tokenClaims: { userId: 'user-1', iat: 999, exp: 1_000, authGeneration: 1 },
      authorityContext: {
        contract: 'v1' as const,
        userId: 'user-1',
        tokenHash: 'fingerprint-1',
        issuedAt: 999,
        authGeneration: 1,
      },
      claims: {
        userId: 'user-1',
        email: 'user@example.test',
        teamId: 'team-1',
        role: 'member' as const,
        authGeneration: 1,
        exp: 1_000,
        iat: 999,
      },
      policy: {},
    }
    currentness.observe.mockResolvedValue({ status: 'denied', reason: 'revoked' })

    await expect(isEntityChangeExternalSessionCurrent(authentication as never)).resolves.toEqual({
      status: 'denied',
      reason: 'revoked',
    })
    expect(currentness.observe).toHaveBeenCalledWith(authentication, {})
  })
})
