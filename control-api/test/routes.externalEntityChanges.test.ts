import { describe, expect, it, vi } from 'vitest'
import { isEntityChangeExternalSessionCurrent } from '../src/routes/external/entityChanges.routes.js'

const sessionAuth = vi.hoisted(() => ({
  isCurrentExternalSession: vi.fn(),
  requireValidExternalSessionToken: vi.fn(),
}))

vi.mock('../src/middleware/externalSessionAuth.js', () => sessionAuth)

describe('external entity-change stream authorization', () => {
  it('stops delivery after the authenticated session token expires', async () => {
    const claims = {
      userId: 'user-1',
      email: 'user@example.test',
      teamId: 'team-1',
      role: 'member' as const,
      authGeneration: 1,
      exp: 1_000,
    }
    sessionAuth.isCurrentExternalSession.mockReset().mockResolvedValue(true)

    await expect(isEntityChangeExternalSessionCurrent(claims, 999_000)).resolves.toBe(true)
    await expect(isEntityChangeExternalSessionCurrent(claims, 1_000_000)).resolves.toBe(false)
    expect(sessionAuth.isCurrentExternalSession).toHaveBeenCalledOnce()
  })
})
