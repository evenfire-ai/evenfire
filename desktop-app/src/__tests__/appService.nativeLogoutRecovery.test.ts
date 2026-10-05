import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cleanupNativeCommitTestHarness,
  createNativeCommitTestHarness,
  deferred,
} from '../../testSupport/appService.nativeCommitTestHarness.js'

afterEach(cleanupNativeCommitTestHarness)

describe('AppService logout recovery ownership', () => {
  it('fails closed when token removal completes after the runtime boundary changes', async () => {
    const { service, runtimeConfig, optionB, restB } = await createNativeCommitTestHarness()
    service.authClient = {
      googleLogin: vi.fn().mockResolvedValue({ token: 'session-a', me: { id: 'user-a' } }),
    } as never
    await service.googleLogin('initial-login')

    const tokenRemovalStarted = deferred<void>()
    const releaseTokenRemoval = deferred<void>()
    service.tokenStore.clearSessionToken = vi.fn(async () => {
      tokenRemovalStarted.resolve()
      await releaseTokenRemoval.promise
    })

    const logout = service.logout().then(
      value => ({ status: 'fulfilled' as const, value }),
      reason => ({ status: 'rejected' as const, reason })
    )
    await tokenRemovalStarted.promise
    await runtimeConfig.selectDesktopRuntimeConfigOption(optionB.id)
    const testService = service as unknown as { sessionGeneration: number }
    testService.sessionGeneration += 1
    releaseTokenRemoval.resolve()
    const logoutOutcome = await logout

    expect(logoutOutcome.status).toBe('rejected')
    expect(service.getCachedUserId()).toBeNull()
    await expect(service.listGfsUploadSessions()).rejects.toThrow(
      'GFS upload dispatch is unavailable without an active authenticated scope'
    )
    expect(service.gfsScopeIdentity).toBeNull()
    expect(runtimeConfig.getDesktopRuntimeConfigState().currentConfig.externalRestApiBaseUrl).toBe(
      restB
    )
  })
})
