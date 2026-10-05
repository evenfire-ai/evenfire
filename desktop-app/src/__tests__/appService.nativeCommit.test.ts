import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cleanupNativeCommitTestHarness,
  createNativeCommitTestHarness,
  deferred,
} from '../../testSupport/appService.nativeCommitTestHarness.js'

afterEach(cleanupNativeCommitTestHarness)

describe('AppService native auth and environment commit ordering', () => {
  it('rejects desktop setup while preserving the active authenticated environment', async () => {
    const { service, runtimeConfig, restA, restB } = await createNativeCommitTestHarness()
    const me = { id: 'user-a', email: 'user-a@example.test', teamId: 'team-a' }
    service.authClient = {
      googleLogin: vi.fn().mockResolvedValue({ token: 'synthetic-session-a', me }),
    } as never
    const setupRequest = vi.fn().mockResolvedValue({
      valid: true,
      email: 'user-a@example.test',
      externalRestApiBaseUrl: restB,
      rpcProxyBaseUrl: 'https://rpc-b.example.test',
      appName: 'Environment B',
    })
    const serviceInternals = service as unknown as {
      memberRegistrationServiceClient: { completeDesktopSetup: typeof setupRequest }
      completeDesktopSetup: (email: string, authorizationToken: string) => Promise<unknown>
      getSessionGeneration: () => number
    }
    serviceInternals.memberRegistrationServiceClient = { completeDesktopSetup: setupRequest }

    await service.googleLogin('synthetic-google-token')
    const runtimeBeforeSetup = runtimeConfig.getDesktopRuntimeConfigState()
    const generationBeforeSetup = serviceInternals.getSessionGeneration()
    const gfsScopeBeforeSetup = service.gfsScopeIdentity

    await expect(
      serviceInternals.completeDesktopSetup('user-a@example.test', 'synthetic-setup-token')
    ).rejects.toThrow('desktop_setup_requires_signout')

    expect(setupRequest).not.toHaveBeenCalled()
    expect(runtimeConfig.getDesktopRuntimeConfigState()).toEqual(runtimeBeforeSetup)
    expect(runtimeConfig.config.externalRestApiBaseUrl).toBe(restA)
    expect(service.sessionToken).toBe('synthetic-session-a')
    expect(service.getCachedUserId()).toBe('user-a')
    await expect(service.getSessionState()).resolves.toMatchObject({ authenticated: true, me })
    expect(serviceInternals.getSessionGeneration()).toBe(generationBeforeSetup)
    expect(service.gfsScopeIdentity).toEqual(gfsScopeBeforeSetup)
  })

  it('keeps a pending environment selection ahead of a login commit', async () => {
    const { service, runtimeConfig, restA, restB, optionB } = await createNativeCommitTestHarness()
    const loginStarted = deferred<void>()
    const releaseLogin = deferred<void>()
    let handoffRequestRest = ''
    service.authClient = {
      googleLogin: vi.fn(async (token: string) => {
        const requestRest = runtimeConfig.config.externalRestApiBaseUrl
        if (token === 'handoff-login') {
          handoffRequestRest = requestRest
          loginStarted.resolve()
          await releaseLogin.promise
          return requestRest === restA
            ? { token: 'synthetic-session-a-next', me: { id: 'user-a' } }
            : { token: 'synthetic-session-b', me: { id: 'user-b' } }
        }
        return { token: 'synthetic-session-a', me: { id: 'user-a' } }
      }),
    } as never
    await service.googleLogin('initial-login')

    let handoffLogin: Promise<unknown> | null = null
    const selectReal = runtimeConfig.selectDesktopRuntimeConfigOption.bind(runtimeConfig)
    vi.spyOn(runtimeConfig, 'selectDesktopRuntimeConfigOption').mockImplementation(async id => {
      if (id === optionB.id) handoffLogin = service.googleLogin('handoff-login')
      await selectReal(id)
    })

    const selection = service.selectRuntimeConfig(optionB.id)
    const selectionOutcome = await selection.then(
      value => ({ status: 'fulfilled' as const, value }),
      reason => ({ status: 'rejected' as const, reason })
    )
    await loginStarted.promise
    releaseLogin.resolve()
    const loginOutcome = await handoffLogin

    expect(selectionOutcome.status).toBe('fulfilled')
    expect(handoffRequestRest).toBe(restB)
    expect(loginOutcome).toMatchObject({ authenticated: true, me: { id: 'user-b' } })
    expect(runtimeConfig.getDesktopRuntimeConfigState().activeOptionId).toBe(optionB.id)
    await expect(service.getSessionState()).resolves.toMatchObject({
      authenticated: true,
      me: { id: 'user-b' },
    })
    await expect(service.listGfsUploadSessions()).resolves.toEqual([])
    expect(service.gfsScopeIdentity).toMatchObject({
      ownerId: 'user-b',
      environmentKey: runtimeConfig.getDesktopRuntimeConfigState().envKey,
      baseUrl: restB,
    })
  })
})
