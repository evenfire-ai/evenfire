import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cleanupNativeCommitTestHarness,
  createNativeCommitTestHarness,
} from '../../testSupport/appService.nativeCommitTestHarness.js'
import { testLoginResult } from '../../testSupport/authTestFixtures.js'
import { readPendingExternalLogoutIntent } from '../pendingExternalLogout.js'

afterEach(cleanupNativeCommitTestHarness)

describe('AppService logout recovery ownership', () => {
  it('fails closed and fences restart restore when strict token removal fails', async () => {
    const { service, runtimeConfig, userDataDir } = await createNativeCommitTestHarness()
    const getMe = vi.fn()
    service.authClient = {
      googleLogin: vi.fn().mockResolvedValue(testLoginResult()),
      getMe,
    } as never
    await service.googleLogin('initial-login')
    service.tokenStore.clearSessionTokenStrictly = vi
      .fn()
      .mockRejectedValue(new Error('keychain unavailable'))

    await expect(service.logout()).resolves.toBeTypeOf('number')

    expect(service.getCachedUserId()).toBeNull()
    expect(service.sessionToken).toBeNull()
    expect(readPendingExternalLogoutIntent(userDataDir, runtimeConfig.getActiveEnvKey())).toEqual({
      intent: 'logout-pending',
    })
    await expect(service.getSessionState()).resolves.toEqual({ authenticated: false, me: null })
    expect(getMe).not.toHaveBeenCalled()
  })
})
