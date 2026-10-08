import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cleanupNativeCommitTestHarness,
  createNativeCommitTestHarness,
} from '../../testSupport/appService.nativeCommitTestHarness.js'
import { testLoginResult } from '../../testSupport/authTestFixtures.js'

afterEach(cleanupNativeCommitTestHarness)

describe('AppService logout recovery ownership', () => {
  it('keeps the current session when token removal fails on the same runtime boundary', async () => {
    const { service } = await createNativeCommitTestHarness()
    service.authClient = {
      googleLogin: vi.fn().mockResolvedValue(testLoginResult()),
    } as never
    await service.googleLogin('initial-login')
    const assertAuthEnvironmentBinding = vi.spyOn(
      service as unknown as {
        assertAuthEnvironmentBinding: (binding: {
          environmentKey: string
          profileId: string | null
          restBaseUrl: string
        }) => void
      },
      'assertAuthEnvironmentBinding'
    )
    service.tokenStore.clearSessionToken = vi
      .fn()
      .mockRejectedValue(new Error('keychain unavailable'))

    await expect(service.logout()).rejects.toThrow('keychain unavailable')

    expect(service.getCachedUserId()).toBe('user-a')
    expect(service.sessionToken).toBe('synthetic-session-a')
    expect(assertAuthEnvironmentBinding).toHaveBeenCalledOnce()
    await expect(service.listGfsUploadSessions()).resolves.toEqual([])
  })
})
