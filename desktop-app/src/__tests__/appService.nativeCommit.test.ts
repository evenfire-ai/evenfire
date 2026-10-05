import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cleanupNativeCommitTestHarness,
  createNativeCommitTestHarness,
  deferred,
} from '../../testSupport/appService.nativeCommitTestHarness.js'

afterEach(cleanupNativeCommitTestHarness)

describe('AppService native auth and environment commit ordering', () => {
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
            ? { token: 'session-a-next', me: { id: 'user-a' } }
            : { token: 'session-b', me: { id: 'user-b' } }
        }
        return { token: 'session-a', me: { id: 'user-a' } }
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
