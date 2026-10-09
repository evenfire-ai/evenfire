import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type {
  DesktopRuntimeConfigHandoffSelection,
  DesktopRuntimeConfigState,
} from '../../../../../src/types'
import { createDesktopEnvironmentSetupHandler } from '../desktopEnvironmentHandoff'

const targetEnvironment = {
  appName: 'Example tenant',
  externalRestApiBaseUrl: 'https://api.example.test',
  rpcProxyBaseUrl: 'https://rpc.example.test',
}

const otherEnvironment = {
  appName: 'Other tenant',
  externalRestApiBaseUrl: 'https://other-api.example.test',
  rpcProxyBaseUrl: 'https://other-rpc.example.test',
}

const currentEnvironment = {
  appName: 'Current tenant',
  externalRestApiBaseUrl: 'https://current-api.example.test',
  rpcProxyBaseUrl: 'https://current-rpc.example.test',
}

let runtimeConfigModule: typeof import('../../../../../src/config') | null = null
let runtimeConfigDirectory = ''
type NativeHandoffProducer = {
  authClient: { googleLogin: ReturnType<typeof vi.fn> }
  tokenStore: {
    clearSessionToken: ReturnType<typeof vi.fn>
    getSessionToken: ReturnType<typeof vi.fn>
    setSessionToken: ReturnType<typeof vi.fn>
  }
  sessionToken: string | null
  googleLogin: (token: string) => Promise<unknown>
  getSessionGeneration: () => number
  getRuntimeConfigState: () => DesktopRuntimeConfigState
  logout: () => Promise<number>
  selectRuntimeConfigForHandoff: (
    optionId: string,
    expectedSessionGeneration: number
  ) => Promise<DesktopRuntimeConfigHandoffSelection>
  suspendDesktopGfsUploadsForAuthBoundary: () => Promise<void>
}
let nativeProducer: NativeHandoffProducer

async function initializeNativeProducer(): Promise<void> {
  const { AppService } = await import('../../../../../src/appService')
  nativeProducer = new AppService() as unknown as NativeHandoffProducer
  nativeProducer.authClient = {
    googleLogin: vi.fn().mockResolvedValue({
      token: 'synthetic-handoff-session',
      me: {
        id: 'handoff-user',
        email: 'handoff@example.test',
        name: 'Handoff User',
        picture: null,
        teamId: 'team-a',
        teamName: 'Team A',
        role: 'member',
      },
    }),
  }
  nativeProducer.tokenStore = {
    clearSessionToken: vi.fn().mockResolvedValue(undefined),
    getSessionToken: vi.fn().mockResolvedValue(null),
    setSessionToken: vi.fn().mockResolvedValue(undefined),
  }
  nativeProducer.suspendDesktopGfsUploadsForAuthBoundary = vi.fn(async () => {})
}

async function ensureNativeSession(): Promise<void> {
  if (!nativeProducer.sessionToken) await nativeProducer.googleLogin('synthetic-google-token')
}

async function logoutThroughNativeProducer(): Promise<number | null> {
  await ensureNativeSession()
  try {
    return await nativeProducer.logout()
  } catch {
    return null
  }
}

beforeEach(async () => {
  runtimeConfigDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'evenfire-deep-link-test-'))
  vi.doUnmock('electron')
  vi.resetModules()
  vi.doMock('electron', () => ({
    app: {
      getPath: vi.fn(() => runtimeConfigDirectory),
      isPackaged: true,
      isReady: vi.fn(() => true),
      setName: vi.fn(),
    },
  }))
  runtimeConfigModule = await import('../../../../../src/config')
  await runtimeConfigModule.saveDesktopRuntimeConfig({
    ...targetEnvironment,
    externalRestApiBaseUrl: `${targetEnvironment.externalRestApiBaseUrl}/api/v1`,
    rpcProxyBaseUrl: `${targetEnvironment.rpcProxyBaseUrl}/rpc`,
  })
  await runtimeConfigModule.saveDesktopRuntimeConfig(otherEnvironment)
  await runtimeConfigModule.saveDesktopRuntimeConfig(currentEnvironment)
  await initializeNativeProducer()
})

afterEach(async () => {
  vi.doUnmock('electron')
  vi.resetModules()
  await fsp.rm(runtimeConfigDirectory, { recursive: true, force: true })
  nativeProducer = undefined as unknown as NativeHandoffProducer
})

function createHandler(
  getAuthState: () => {
    booting: boolean
    busy: boolean
    authTransitioning: boolean
    isAuthenticated: boolean
  },
  refreshRuntimeConfigState: () => Promise<
    Awaited<ReturnType<typeof import('../../../../../src/config').getDesktopRuntimeConfigState>>
  > = async () => runtimeConfigModule!.getDesktopRuntimeConfigState(),
  logoutForEnvironmentMismatch?: () => Promise<number | null>,
  onSessionNeedsLoad: () => Promise<void> = vi.fn(async () => {}),
  requestEnvironmentSwitchConfirmation: (details: {
    activeEnvironmentName: string
    activeExternalRestApiBaseUrl: string
    targetEnvironmentName: string
    targetExternalRestApiBaseUrl: string
  }) => Promise<boolean> = vi.fn(async () => true),
  getSessionGenerationOverride?: () => Promise<number>
) {
  let signedOutGeneration: number | null = null
  const getCurrentAuthState = () => {
    const state = getAuthState()
    return {
      ...state,
      isAuthenticated:
        signedOutGeneration === nativeProducer.getSessionGeneration()
          ? false
          : state.isAuthenticated,
    }
  }
  const logout = vi.fn(async () => {
    const result = logoutForEnvironmentMismatch
      ? await logoutForEnvironmentMismatch()
      : await (async () => {
          await ensureNativeSession()
          return nativeProducer.logout()
        })()
    if (typeof result === 'number') signedOutGeneration = result
    return result
  })
  const selectRuntimeConfig = vi.fn(
    async (
      optionId: string,
      expectedGeneration?: number
    ): Promise<DesktopRuntimeConfigHandoffSelection | null> =>
      nativeProducer.selectRuntimeConfigForHandoff(
        optionId,
        expectedGeneration ?? nativeProducer.getSessionGeneration()
      )
  )
  const setPendingDesktopEnvironmentSetup = vi.fn()
  const setStatus = vi.fn()
  const handler = createDesktopEnvironmentSetupHandler({
    getAuthState: getCurrentAuthState,
    getSessionGeneration:
      getSessionGenerationOverride ?? (async () => nativeProducer.getSessionGeneration()),
    refreshRuntimeConfigState,
    handleSelectRuntimeConfig: selectRuntimeConfig,
    onSessionNeedsLoad,
    logoutForEnvironmentMismatch: logout,
    requestEnvironmentSwitchConfirmation,
    setPendingDesktopEnvironmentSetup,
    setStatus,
  })
  return {
    handler,
    onSessionNeedsLoad,
    logout,
    requestEnvironmentSwitchConfirmation,
    selectRuntimeConfig,
    setPendingDesktopEnvironmentSetup,
    setStatus,
    nativeProducer,
  }
}

describe('Desktop environment handoff concurrency', () => {
  it.each([
    ['booting', { booting: true, busy: false, authTransitioning: false, isAuthenticated: false }],
    ['busy', { booting: false, busy: true, authTransitioning: false, isAuthenticated: false }],
    [
      'auth-transitioning',
      { booting: false, busy: false, authTransitioning: true, isAuthenticated: false },
    ],
  ])('ignores environment links while authentication is %s', async (_state, authState) => {
    const { handler, selectRuntimeConfig, setPendingDesktopEnvironmentSetup } = createHandler(
      () => authState
    )

    await handler(targetEnvironment)

    expect(selectRuntimeConfig).not.toHaveBeenCalled()
    expect(setPendingDesktopEnvironmentSetup).toHaveBeenCalledWith(null)
  })

  it('rechecks the auth operation state after runtime configuration loads', async () => {
    let finishRefresh: (() => void) | undefined
    let reportRefreshStarted!: () => void
    const refreshStarted = new Promise<void>(resolve => {
      reportRefreshStarted = resolve
    })
    const runtimeConfigState = await runtimeConfigModule!.getDesktopRuntimeConfigState()
    const originalActiveOptionId = runtimeConfigState.activeOptionId
    const refreshRuntimeConfigState = () => {
      reportRefreshStarted()
      return new Promise<typeof runtimeConfigState>(resolve => {
        finishRefresh = () => resolve(runtimeConfigState)
      })
    }
    let busy = false
    const { handler, selectRuntimeConfig, setPendingDesktopEnvironmentSetup, setStatus } =
      createHandler(
        () => ({ booting: false, busy, authTransitioning: false, isAuthenticated: false }),
        refreshRuntimeConfigState
      )

    const handling = handler({
      ...targetEnvironment,
      externalRestApiBaseUrl: `${targetEnvironment.externalRestApiBaseUrl}/api/v1`,
    })
    await refreshStarted
    busy = true
    finishRefresh?.()
    await handling

    expect(selectRuntimeConfig).not.toHaveBeenCalled()
    expect(setPendingDesktopEnvironmentSetup).toHaveBeenCalledWith(null)
    expect((await runtimeConfigModule!.getDesktopRuntimeConfigState()).activeOptionId).toBe(
      originalActiveOptionId
    )
    expect(setStatus).toHaveBeenCalledWith(
      'Finish the current authentication action, then reopen this desktop link.',
      'info'
    )
  })

  it('discards a link when the native session generation changes during config refresh', async () => {
    let finishRefresh!: (state: DesktopRuntimeConfigState) => void
    let reportRefreshStarted!: () => void
    const refreshStarted = new Promise<void>(resolve => {
      reportRefreshStarted = resolve
    })
    const runtimeConfigState = await runtimeConfigModule!.getDesktopRuntimeConfigState()
    const refreshRuntimeConfigState = () =>
      new Promise<DesktopRuntimeConfigState>(resolve => {
        finishRefresh = resolve
        reportRefreshStarted()
      })
    const { handler, selectRuntimeConfig, setPendingDesktopEnvironmentSetup, setStatus } =
      createHandler(
        () => ({ booting: false, busy: false, authTransitioning: false, isAuthenticated: false }),
        refreshRuntimeConfigState
      )

    const handling = handler(targetEnvironment)
    await refreshStarted
    await nativeProducer.googleLogin('synthetic-login-during-config-refresh')
    finishRefresh(runtimeConfigState)
    await handling

    expect(selectRuntimeConfig).not.toHaveBeenCalled()
    expect(setPendingDesktopEnvironmentSetup).toHaveBeenCalledWith(null)
    expect(setStatus).toHaveBeenCalledWith(
      'The desktop session changed while processing this link. Open it again.',
      'info'
    )
  })

  it('passes the captured generation to native selection across an auth race', async () => {
    const savedTarget = (await runtimeConfigModule!.getDesktopRuntimeConfigState()).options.find(
      option =>
        option.externalRestApiBaseUrl === `${targetEnvironment.externalRestApiBaseUrl}/api/v1`
    )
    if (!savedTarget) throw new Error('The config producer did not return the saved target')
    const { handler, selectRuntimeConfig, setPendingDesktopEnvironmentSetup, onSessionNeedsLoad } =
      createHandler(() => ({
        booting: false,
        busy: false,
        authTransitioning: false,
        isAuthenticated: false,
      }))
    const expectedGeneration = nativeProducer.getSessionGeneration()
    selectRuntimeConfig.mockImplementationOnce(async (optionId, requestedGeneration) => {
      await nativeProducer.googleLogin('synthetic-login-before-native-selection')
      try {
        return await nativeProducer.selectRuntimeConfigForHandoff(
          optionId,
          requestedGeneration ?? expectedGeneration
        )
      } catch {
        return null
      }
    })

    await handler({
      ...targetEnvironment,
      externalRestApiBaseUrl: `${targetEnvironment.externalRestApiBaseUrl}/api/v1`,
    })

    expect(selectRuntimeConfig).toHaveBeenCalledWith(savedTarget.id, expectedGeneration)
    expect(onSessionNeedsLoad).not.toHaveBeenCalled()
    expect(setPendingDesktopEnvironmentSetup).toHaveBeenCalledWith(null)
  })

  it('does not load a selected environment after the generation changes post-selection', async () => {
    const savedTarget = (await runtimeConfigModule!.getDesktopRuntimeConfigState()).options.find(
      option =>
        option.externalRestApiBaseUrl === `${targetEnvironment.externalRestApiBaseUrl}/api/v1`
    )
    if (!savedTarget) throw new Error('The config producer did not return the saved target')
    const {
      handler,
      selectRuntimeConfig,
      setPendingDesktopEnvironmentSetup,
      onSessionNeedsLoad,
      setStatus,
    } = createHandler(() => ({
      booting: false,
      busy: false,
      authTransitioning: false,
      isAuthenticated: false,
    }))
    selectRuntimeConfig.mockImplementationOnce(async (optionId, expectedGeneration) => {
      const selection = await nativeProducer.selectRuntimeConfigForHandoff(
        optionId,
        expectedGeneration ?? nativeProducer.getSessionGeneration()
      )
      await nativeProducer.googleLogin('synthetic-login-after-native-selection')
      return selection
    })

    await handler({
      ...targetEnvironment,
      externalRestApiBaseUrl: `${targetEnvironment.externalRestApiBaseUrl}/api/v1`,
    })

    expect(selectRuntimeConfig).toHaveBeenCalledOnce()
    expect(onSessionNeedsLoad).not.toHaveBeenCalled()
    expect(setPendingDesktopEnvironmentSetup).toHaveBeenCalledWith(null)
    expect(setStatus).toHaveBeenCalledWith(
      'The desktop session changed while processing this link. Open it again.',
      'info'
    )
  })

  it('stops after logout when a newer native login wins before the handoff continues', async () => {
    let isAuthenticated = true
    const logout = vi.fn(async () => {
      await ensureNativeSession()
      const generation = await nativeProducer.logout()
      isAuthenticated = false
      await nativeProducer.googleLogin('synthetic-login-after-handoff-logout')
      return generation
    })
    const { handler, selectRuntimeConfig, setPendingDesktopEnvironmentSetup, setStatus } =
      createHandler(
        () => ({
          booting: false,
          busy: false,
          authTransitioning: false,
          isAuthenticated,
        }),
        undefined,
        logout,
        vi.fn(async () => {})
      )

    await handler({
      ...targetEnvironment,
      externalRestApiBaseUrl: `${targetEnvironment.externalRestApiBaseUrl}/api/v1`,
    })

    expect(logout).toHaveBeenCalledOnce()
    expect(selectRuntimeConfig).not.toHaveBeenCalled()
    expect(setPendingDesktopEnvironmentSetup).toHaveBeenCalledWith(null)
    expect(setStatus).toHaveBeenCalledWith(
      'The desktop session changed while processing this link. Open it again.',
      'info'
    )
  })

  it('keeps the new-session status when reload rejects after changing generation', async () => {
    const setPendingDesktopEnvironmentSetup = vi.fn()
    const setStatus = vi.fn()
    const initialGeneration = nativeProducer.getSessionGeneration()
    const handler = createDesktopEnvironmentSetupHandler({
      getAuthState: () => ({
        booting: false,
        busy: false,
        authTransitioning: false,
        isAuthenticated: true,
      }),
      getSessionGeneration: async () => nativeProducer.getSessionGeneration(),
      refreshRuntimeConfigState: async () => runtimeConfigModule!.getDesktopRuntimeConfigState(),
      handleSelectRuntimeConfig: vi.fn(async () => null),
      onSessionNeedsLoad: async () => {
        await nativeProducer.googleLogin('synthetic-login-before-reload-error')
        throw new Error('stale reload')
      },
      requestEnvironmentSwitchConfirmation: async () => true,
      logoutForEnvironmentMismatch: async () => initialGeneration,
      setPendingDesktopEnvironmentSetup,
      setStatus,
    })

    await handler({
      ...targetEnvironment,
      externalRestApiBaseUrl: `${targetEnvironment.externalRestApiBaseUrl}/api/v1`,
    })

    expect(setStatus).toHaveBeenCalledWith(
      'The desktop session changed while processing this link. Open it again.',
      'info'
    )
    expect(setStatus).not.toHaveBeenCalledWith(
      'Could not verify your sign-in state before switching desktop environments.',
      'error'
    )
  })

  it('reports a generation change after a successful signed-out reload', async () => {
    const setPendingDesktopEnvironmentSetup = vi.fn()
    const setStatus = vi.fn()
    const initialGeneration = nativeProducer.getSessionGeneration()
    let isAuthenticated = true
    const handler = createDesktopEnvironmentSetupHandler({
      getAuthState: () => ({
        booting: false,
        busy: false,
        authTransitioning: false,
        isAuthenticated,
      }),
      getSessionGeneration: async () => nativeProducer.getSessionGeneration(),
      refreshRuntimeConfigState: async () => runtimeConfigModule!.getDesktopRuntimeConfigState(),
      handleSelectRuntimeConfig: vi.fn(async () => null),
      onSessionNeedsLoad: async () => {
        await nativeProducer.googleLogin('synthetic-login-during-session-reload')
        isAuthenticated = false
      },
      requestEnvironmentSwitchConfirmation: async () => true,
      logoutForEnvironmentMismatch: async () => initialGeneration,
      setPendingDesktopEnvironmentSetup,
      setStatus,
    })

    await handler({
      ...targetEnvironment,
      externalRestApiBaseUrl: `${targetEnvironment.externalRestApiBaseUrl}/api/v1`,
    })

    expect(setPendingDesktopEnvironmentSetup).toHaveBeenCalledWith(null)
    expect(setStatus).toHaveBeenCalledWith(
      'The desktop session changed while processing this link. Open it again.',
      'info'
    )
  })

  it('rechecks the generation before exposing a new-profile setup confirmation', async () => {
    let generationReads = 0
    const getSessionGeneration = async () => {
      generationReads += 1
      if (generationReads === 3) {
        await nativeProducer.googleLogin('synthetic-login-before-setup-confirmation')
      }
      return nativeProducer.getSessionGeneration()
    }
    const { handler, setPendingDesktopEnvironmentSetup, setStatus } = createHandler(
      () => ({ booting: false, busy: false, authTransitioning: false, isAuthenticated: false }),
      undefined,
      undefined,
      undefined,
      undefined,
      getSessionGeneration
    )

    await handler({
      appName: 'New tenant',
      externalRestApiBaseUrl: 'https://brand-new-api.example.test/api/v1',
    })

    expect(generationReads).toBe(3)
    expect(setPendingDesktopEnvironmentSetup).toHaveBeenCalledWith(null)
    expect(setPendingDesktopEnvironmentSetup).not.toHaveBeenCalledWith(
      expect.objectContaining({
        externalRestApiBaseUrl: 'https://brand-new-api.example.test/api/v1',
      })
    )
    expect(setStatus).toHaveBeenCalledWith(
      'The desktop session changed while processing this link. Open it again.',
      'info'
    )
  })

  it.each([
    {
      outcome: 'selects the linked saved environment',
      externalRestApiBaseUrl: `${targetEnvironment.externalRestApiBaseUrl}/api/v1`,
      action: 'select',
    },
    {
      outcome: 'prompts to add the linked environment',
      externalRestApiBaseUrl: 'https://unconfigured-api.example.test/api/v1',
      action: 'prompt',
    },
  ])('waits for logout to finish, then $outcome', async ({ externalRestApiBaseUrl, action }) => {
    const state = await runtimeConfigModule!.getDesktopRuntimeConfigState()
    const savedTarget = state.options.find(
      option =>
        option.externalRestApiBaseUrl === `${targetEnvironment.externalRestApiBaseUrl}/api/v1`
    )
    if (!savedTarget) throw new Error('The config producer did not return the saved REST profile')
    const initialGeneration = nativeProducer.getSessionGeneration()

    let busy = false
    let isAuthenticated = true
    let finishLogout: () => void = () => {}
    let reportLogoutStarted: () => void = () => {}
    const logoutStarted = new Promise<void>(resolve => {
      reportLogoutStarted = resolve
    })
    const logoutFinished = new Promise<void>(resolve => {
      finishLogout = resolve
    })
    nativeProducer.tokenStore.clearSessionToken.mockImplementationOnce(async () => {
      reportLogoutStarted()
      await logoutFinished
    })
    const logout = vi.fn(async () => {
      busy = true
      await ensureNativeSession()
      const generation = await nativeProducer.logout()
      isAuthenticated = false
      busy = false
      return generation
    })
    const { handler, selectRuntimeConfig, setPendingDesktopEnvironmentSetup } = createHandler(
      () => ({ booting: false, busy, authTransitioning: false, isAuthenticated }),
      undefined,
      logout,
      undefined
    )

    const handling = handler({ ...targetEnvironment, externalRestApiBaseUrl })
    await logoutStarted

    expect(busy).toBe(true)
    expect(selectRuntimeConfig).not.toHaveBeenCalled()
    expect(setPendingDesktopEnvironmentSetup).toHaveBeenCalledWith(null)

    finishLogout()
    await handling

    expect(busy).toBe(false)
    expect(logout).toHaveBeenCalledOnce()
    if (action === 'select') {
      const logoutGeneration = await logout.mock.results[0]?.value
      expect(logoutGeneration).not.toBe(initialGeneration)
      expect(selectRuntimeConfig).toHaveBeenCalledWith(savedTarget.id, logoutGeneration)
      const selection = await selectRuntimeConfig.mock.results[0]?.value
      expect(selection?.sessionGeneration).toBe(nativeProducer.getSessionGeneration())
      expect(setPendingDesktopEnvironmentSetup).toHaveBeenLastCalledWith(null)
    } else {
      expect(selectRuntimeConfig).not.toHaveBeenCalled()
      expect(setPendingDesktopEnvironmentSetup).toHaveBeenLastCalledWith({
        ...targetEnvironment,
        externalRestApiBaseUrl,
        rpcProxyBaseUrl: '',
      })
    }
  })

  it('selects an exact saved REST endpoint when a same-origin sibling is also saved', async () => {
    await runtimeConfigModule!.saveDesktopRuntimeConfig({
      appName: 'Sibling API profile',
      externalRestApiBaseUrl: `${targetEnvironment.externalRestApiBaseUrl}/api/v2`,
      rpcProxyBaseUrl: 'https://sibling-rpc.example.test',
    })
    const state = await runtimeConfigModule!.getDesktopRuntimeConfigState()
    const exactTarget = state.options.find(
      option =>
        option.externalRestApiBaseUrl === `${targetEnvironment.externalRestApiBaseUrl}/api/v1`
    )
    if (!exactTarget) throw new Error('The config producer did not return the exact REST profile')
    const { handler, selectRuntimeConfig, setPendingDesktopEnvironmentSetup, setStatus } =
      createHandler(() => ({
        booting: false,
        busy: false,
        authTransitioning: false,
        isAuthenticated: false,
      }))
    const expectedGeneration = nativeProducer.getSessionGeneration()

    await handler({
      ...targetEnvironment,
      externalRestApiBaseUrl: `${targetEnvironment.externalRestApiBaseUrl}/api/v1`,
    })

    const finalState = await runtimeConfigModule!.getDesktopRuntimeConfigState()
    expect(selectRuntimeConfig).toHaveBeenCalledWith(exactTarget.id, expectedGeneration)
    expect(finalState.activeOptionId).toBe(exactTarget.id)
    expect(setPendingDesktopEnvironmentSetup).toHaveBeenLastCalledWith(null)
    expect(setStatus).not.toHaveBeenCalledWith(
      'Desktop setup link rejected because this REST host is already saved with a different API endpoint.',
      'error'
    )
  })

  it('selects an exact REST profile added during logout despite a same-origin sibling', async () => {
    let authenticated = true
    let targetId = ''
    const logout = vi.fn(async () => {
      await ensureNativeSession()
      const generation = await nativeProducer.logout()
      await runtimeConfigModule!.saveDesktopRuntimeConfig({
        appName: 'New exact target',
        externalRestApiBaseUrl: 'https://new-api.example.test/api/v1',
        rpcProxyBaseUrl: 'https://rpc.new-api.example.test/v1',
      })
      await runtimeConfigModule!.saveDesktopRuntimeConfig({
        appName: 'New sibling target',
        externalRestApiBaseUrl: 'https://new-api.example.test/api/v2',
        rpcProxyBaseUrl: 'https://rpc.new-api.example.test/v2',
      })
      const state = await runtimeConfigModule!.getDesktopRuntimeConfigState()
      targetId =
        state.options.find(
          option => option.externalRestApiBaseUrl === 'https://new-api.example.test/api/v1'
        )?.id ?? ''
      authenticated = false
      return generation
    })
    const { handler, selectRuntimeConfig, setPendingDesktopEnvironmentSetup, setStatus } =
      createHandler(
        () => ({
          booting: false,
          busy: false,
          authTransitioning: false,
          isAuthenticated: authenticated,
        }),
        undefined,
        logout,
        undefined
      )

    await handler({
      appName: 'New target',
      externalRestApiBaseUrl: 'https://new-api.example.test/api/v1',
    })

    expect(logout).toHaveBeenCalledOnce()
    expect(selectRuntimeConfig).toHaveBeenCalledWith(targetId, await logout.mock.results[0]?.value)
    expect(setPendingDesktopEnvironmentSetup).toHaveBeenLastCalledWith(null)
    expect(setStatus).not.toHaveBeenCalledWith(
      'Desktop setup link rejected because this REST host is already saved with a different API endpoint.',
      'error'
    )
  })

  it('asks before logging out to switch from an authenticated environment', async () => {
    const requestEnvironmentSwitchConfirmation = vi.fn(async () => false)
    const {
      handler,
      logout,
      requestEnvironmentSwitchConfirmation: requestConfirmation,
      selectRuntimeConfig,
      setPendingDesktopEnvironmentSetup,
    } = createHandler(
      () => ({ booting: false, busy: false, authTransitioning: false, isAuthenticated: true }),
      undefined,
      undefined,
      undefined,
      requestEnvironmentSwitchConfirmation
    )

    await handler({
      ...targetEnvironment,
      externalRestApiBaseUrl: `${targetEnvironment.externalRestApiBaseUrl}/api/v1`,
    })

    expect(requestConfirmation).toHaveBeenCalledWith({
      activeEnvironmentName: 'Current tenant',
      activeExternalRestApiBaseUrl: currentEnvironment.externalRestApiBaseUrl,
      targetEnvironmentName: targetEnvironment.appName,
      targetExternalRestApiBaseUrl: `${targetEnvironment.externalRestApiBaseUrl}/api/v1`,
    })
    expect(logout).not.toHaveBeenCalled()
    expect(selectRuntimeConfig).not.toHaveBeenCalled()
    expect(setPendingDesktopEnvironmentSetup).not.toHaveBeenCalled()
  })

  it('keeps the current environment when token removal fails during handoff logout', async () => {
    let rendererAuthenticated = true
    nativeProducer.tokenStore.clearSessionToken.mockRejectedValueOnce(
      new Error('secure storage unavailable')
    )
    const logoutForEnvironmentMismatch = vi.fn(logoutThroughNativeProducer)
    const onSessionNeedsLoad = vi.fn(async () => {
      rendererAuthenticated = true
    })
    const { handler, selectRuntimeConfig, setPendingDesktopEnvironmentSetup } = createHandler(
      () => ({
        booting: false,
        busy: false,
        authTransitioning: false,
        isAuthenticated: rendererAuthenticated,
      }),
      undefined,
      logoutForEnvironmentMismatch,
      onSessionNeedsLoad
    )

    await handler({
      ...targetEnvironment,
      externalRestApiBaseUrl: `${targetEnvironment.externalRestApiBaseUrl}/api/v1`,
    })

    expect(nativeProducer.tokenStore.clearSessionToken).toHaveBeenCalledOnce()
    expect(onSessionNeedsLoad).toHaveBeenCalledWith({ preserveNav: true })
    expect(rendererAuthenticated).toBe(true)
    expect(selectRuntimeConfig).not.toHaveBeenCalled()
    expect(setPendingDesktopEnvironmentSetup).toHaveBeenLastCalledWith(null)
    expect(setPendingDesktopEnvironmentSetup).not.toHaveBeenCalledWith(
      expect.objectContaining({ externalRestApiBaseUrl: expect.any(String) })
    )
  })

  it('keeps the current environment when a failed logout leaves the live session active', async () => {
    let rendererAuthenticated = true
    nativeProducer.tokenStore.clearSessionToken.mockRejectedValueOnce(
      new Error('secure storage unavailable')
    )
    const logoutForEnvironmentMismatch = vi.fn(logoutThroughNativeProducer)
    const onSessionNeedsLoad = vi.fn(async () => {
      rendererAuthenticated = true
    })
    const {
      handler,
      onSessionNeedsLoad: onSessionNeedsLoadSpy,
      selectRuntimeConfig,
      setPendingDesktopEnvironmentSetup,
    } = createHandler(
      () => ({
        booting: false,
        busy: false,
        authTransitioning: false,
        isAuthenticated: rendererAuthenticated,
      }),
      undefined,
      logoutForEnvironmentMismatch,
      onSessionNeedsLoad
    )

    await handler({
      ...targetEnvironment,
      externalRestApiBaseUrl: `${targetEnvironment.externalRestApiBaseUrl}/api/v1`,
    })

    expect(onSessionNeedsLoadSpy).toHaveBeenCalledWith({ preserveNav: true })
    expect(rendererAuthenticated).toBe(true)
    expect(selectRuntimeConfig).not.toHaveBeenCalled()
    expect(setPendingDesktopEnvironmentSetup).toHaveBeenCalledWith(null)
  })

  it('keeps a session reload error visible when handoff logout did not commit', async () => {
    nativeProducer.tokenStore.clearSessionToken.mockRejectedValueOnce(
      new Error('secure storage unavailable')
    )
    const onSessionNeedsLoad = vi.fn(async () => {
      throw new Error('session read unavailable')
    })
    const { handler, setStatus } = createHandler(
      () => ({
        booting: false,
        busy: false,
        authTransitioning: false,
        isAuthenticated: true,
      }),
      undefined,
      vi.fn(logoutThroughNativeProducer),
      onSessionNeedsLoad
    )

    await handler({
      ...targetEnvironment,
      externalRestApiBaseUrl: `${targetEnvironment.externalRestApiBaseUrl}/api/v1`,
    })

    expect(onSessionNeedsLoad).toHaveBeenCalledWith({ preserveNav: true })
    expect(setStatus).toHaveBeenLastCalledWith(
      'Could not reload the current desktop session: session read unavailable',
      'error'
    )
  })

  it.each([
    {
      targetKind: 'saved target',
      externalRestApiBaseUrl: `${targetEnvironment.externalRestApiBaseUrl}/api/v1`,
      loginOutcome: 'supersedes by generation only',
      loginState: null,
    },
    {
      targetKind: 'saved target',
      externalRestApiBaseUrl: `${targetEnvironment.externalRestApiBaseUrl}/api/v1`,
      loginOutcome: 'starts',
      loginState: { busy: true, authTransitioning: true, isAuthenticated: false },
    },
    {
      targetKind: 'saved target',
      externalRestApiBaseUrl: `${targetEnvironment.externalRestApiBaseUrl}/api/v1`,
      loginOutcome: 'completes',
      loginState: { busy: false, authTransitioning: false, isAuthenticated: true },
    },
    {
      targetKind: 'new target',
      externalRestApiBaseUrl: 'https://new-api.example.test',
      loginOutcome: 'starts',
      loginState: { busy: true, authTransitioning: true, isAuthenticated: false },
    },
    {
      targetKind: 'new target',
      externalRestApiBaseUrl: 'https://new-api.example.test',
      loginOutcome: 'completes',
      loginState: { busy: false, authTransitioning: false, isAuthenticated: true },
    },
  ])(
    'does not continue toward a $targetKind when a newer session owner $loginOutcome during the second config read',
    async ({ externalRestApiBaseUrl, loginState }) => {
      let authState = {
        booting: false,
        busy: false,
        authTransitioning: false,
        isAuthenticated: true,
      }
      let refreshCount = 0
      let finishSecondRefresh!: () => void
      let reportSecondRefreshStarted!: () => void
      const secondRefreshStarted = new Promise<void>(resolve => {
        reportSecondRefreshStarted = resolve
      })
      const runtimeConfigState = await runtimeConfigModule!.getDesktopRuntimeConfigState()
      const refreshRuntimeConfigState = () => {
        refreshCount += 1
        if (refreshCount === 1) return Promise.resolve(runtimeConfigState)
        return new Promise<typeof runtimeConfigState>(resolve => {
          finishSecondRefresh = () => resolve(runtimeConfigState)
          reportSecondRefreshStarted()
        })
      }
      const logoutForEnvironmentMismatch = vi.fn(async () => {
        await ensureNativeSession()
        const generation = await nativeProducer.logout()
        authState = { ...authState, isAuthenticated: false }
        return generation
      })
      const onSessionNeedsLoad = vi.fn(async () => {})
      const { handler, selectRuntimeConfig, setPendingDesktopEnvironmentSetup } = createHandler(
        () => authState,
        refreshRuntimeConfigState,
        logoutForEnvironmentMismatch,
        onSessionNeedsLoad
      )

      const handling = handler({ ...targetEnvironment, externalRestApiBaseUrl })
      await secondRefreshStarted
      const loginCompletion: { finish?: () => void } = {}
      let pendingLogin: Promise<unknown> | null = null
      if (loginState) {
        const loginResultValue = {
          token: 'synthetic-new-session',
          me: {
            id: 'new-handoff-user',
            email: 'new-handoff@example.test',
            name: 'New Handoff User',
            picture: null,
            teamId: 'team-b',
            teamName: 'Team B',
            role: 'member',
          },
        }
        let reportLoginStarted!: () => void
        const loginStarted = new Promise<void>(resolve => {
          reportLoginStarted = resolve
        })
        const loginResult = new Promise<typeof loginResultValue>(resolve => {
          loginCompletion.finish = () => resolve(loginResultValue)
        })
        nativeProducer.authClient.googleLogin.mockImplementationOnce(() => {
          reportLoginStarted()
          return loginResult
        })
        const login = nativeProducer.googleLogin('synthetic-new-google-login')
        pendingLogin = login
        await loginStarted
        authState = { ...authState, ...loginState }
        if (loginState.isAuthenticated) {
          loginCompletion.finish?.()
          await login
        }
      } else {
        const activeOptionId = nativeProducer.getRuntimeConfigState().activeOptionId
        if (!activeOptionId) throw new Error('The config producer did not select an active profile')
        await nativeProducer.selectRuntimeConfigForHandoff(
          activeOptionId,
          nativeProducer.getSessionGeneration()
        )
      }
      finishSecondRefresh()
      await handling

      if (pendingLogin && loginCompletion.finish) {
        loginCompletion.finish()
        await pendingLogin
      }

      expect(selectRuntimeConfig).not.toHaveBeenCalled()
      expect(setPendingDesktopEnvironmentSetup).toHaveBeenCalledWith(null)
      expect(setPendingDesktopEnvironmentSetup).not.toHaveBeenCalledWith(
        expect.objectContaining({ externalRestApiBaseUrl })
      )
      expect(onSessionNeedsLoad).not.toHaveBeenCalled()
    }
  )

  it('keeps the first environment link when another arrives during verification', async () => {
    const finishRefreshes: Array<() => void> = []
    const runtimeConfigState = await runtimeConfigModule!.getDesktopRuntimeConfigState()
    let reportRefreshStarted!: () => void
    const refreshStarted = new Promise<void>(resolve => {
      reportRefreshStarted = resolve
    })
    const refreshRuntimeConfigState = () =>
      new Promise<typeof runtimeConfigState>(resolve => {
        finishRefreshes.push(() => resolve(runtimeConfigState))
        reportRefreshStarted()
      })
    const { handler } = createHandler(
      () => ({ booting: false, busy: false, authTransitioning: false, isAuthenticated: false }),
      refreshRuntimeConfigState
    )

    const first = handler({
      ...targetEnvironment,
      externalRestApiBaseUrl: `${targetEnvironment.externalRestApiBaseUrl}/api/v1`,
    })
    const second = handler(otherEnvironment)
    await refreshStarted
    finishRefreshes.forEach(finishRefresh => finishRefresh())
    await Promise.all([first, second])

    const finalState = await runtimeConfigModule!.getDesktopRuntimeConfigState()
    expect(finalState.currentConfig?.externalRestApiBaseUrl).toBe(
      `${targetEnvironment.externalRestApiBaseUrl}/api/v1`
    )
  })
})

describe('Desktop environment REST endpoint matching', () => {
  it('keeps an exact active REST endpoint when a same-origin sibling is saved', async () => {
    await runtimeConfigModule!.saveDesktopRuntimeConfig({
      appName: 'Sibling API profile',
      externalRestApiBaseUrl: `${targetEnvironment.externalRestApiBaseUrl}/api/v2`,
      rpcProxyBaseUrl: 'https://sibling-rpc.example.test',
    })
    const state = await runtimeConfigModule!.getDesktopRuntimeConfigState()
    const exactTarget = state.options.find(
      option =>
        option.externalRestApiBaseUrl === `${targetEnvironment.externalRestApiBaseUrl}/api/v1`
    )
    if (!exactTarget) throw new Error('The config producer did not return the exact REST profile')
    await runtimeConfigModule!.selectDesktopRuntimeConfigOption(exactTarget.id)

    const { handler, logout, selectRuntimeConfig, setPendingDesktopEnvironmentSetup, setStatus } =
      createHandler(() => ({
        booting: false,
        busy: false,
        authTransitioning: false,
        isAuthenticated: false,
      }))

    await handler({
      ...targetEnvironment,
      appName: 'Acme Corp, verified secure workspace with an unbounded link-provided label',
      externalRestApiBaseUrl: `${targetEnvironment.externalRestApiBaseUrl}/api/v1`,
    })

    expect(logout).not.toHaveBeenCalled()
    expect(selectRuntimeConfig).not.toHaveBeenCalled()
    expect(setPendingDesktopEnvironmentSetup).toHaveBeenLastCalledWith(null)
    expect(setStatus).toHaveBeenLastCalledWith(
      'This link points to the active Evenfire Desktop environment.',
      'success'
    )
  })

  it.each([
    [
      'a REST host suffix',
      {
        ...targetEnvironment,
        externalRestApiBaseUrl: 'https://api.example.test.evil.tld',
      },
    ],
    [
      'a different REST port',
      {
        ...targetEnvironment,
        externalRestApiBaseUrl: 'https://api.example.test:8443',
      },
    ],
    [
      'a downgraded REST scheme',
      {
        ...targetEnvironment,
        externalRestApiBaseUrl: 'http://api.example.test',
      },
    ],
  ])('does not switch to a saved environment with %s', async (_case, linkedEnvironment) => {
    const { handler, selectRuntimeConfig, setPendingDesktopEnvironmentSetup } = createHandler(
      () => ({ booting: false, busy: false, authTransitioning: false, isAuthenticated: false })
    )

    await handler(linkedEnvironment)

    expect(selectRuntimeConfig).not.toHaveBeenCalled()
    expect(setPendingDesktopEnvironmentSetup).toHaveBeenCalledWith({
      ...linkedEnvironment,
      rpcProxyBaseUrl: '',
    })
  })

  it('selects the exact saved REST profile when the link omits RPC', async () => {
    const state = await runtimeConfigModule!.getDesktopRuntimeConfigState()
    const savedTarget = state.options.find(
      option =>
        option.externalRestApiBaseUrl === `${targetEnvironment.externalRestApiBaseUrl}/api/v1`
    )
    if (!savedTarget) throw new Error('The config producer did not return the saved REST profile')
    const { handler, selectRuntimeConfig, setPendingDesktopEnvironmentSetup } = createHandler(
      () => ({ booting: false, busy: false, authTransitioning: false, isAuthenticated: false })
    )
    const expectedGeneration = nativeProducer.getSessionGeneration()

    await handler({
      ...targetEnvironment,
      externalRestApiBaseUrl: `${targetEnvironment.externalRestApiBaseUrl}/api/v1`,
    })

    expect(selectRuntimeConfig).toHaveBeenCalledWith(savedTarget.id, expectedGeneration)
    expect(setPendingDesktopEnvironmentSetup).toHaveBeenCalledWith(null)
  })

  it('selects the saved REST profile when the link host has a terminal DNS dot', async () => {
    const state = await runtimeConfigModule!.getDesktopRuntimeConfigState()
    const savedTarget = state.options.find(
      option =>
        option.externalRestApiBaseUrl === `${targetEnvironment.externalRestApiBaseUrl}/api/v1`
    )
    if (!savedTarget) throw new Error('The config producer did not return the saved REST profile')
    const { handler, selectRuntimeConfig, setPendingDesktopEnvironmentSetup } = createHandler(
      () => ({ booting: false, busy: false, authTransitioning: false, isAuthenticated: false })
    )
    const expectedGeneration = nativeProducer.getSessionGeneration()

    await handler({
      ...targetEnvironment,
      externalRestApiBaseUrl: 'https://api.example.test./api/v1',
    })

    const finalState = await runtimeConfigModule!.getDesktopRuntimeConfigState()
    expect(selectRuntimeConfig).toHaveBeenCalledWith(savedTarget.id, expectedGeneration)
    expect(setPendingDesktopEnvironmentSetup).toHaveBeenCalledWith(null)
    expect(finalState.options).toHaveLength(state.options.length)
    expect(finalState.currentConfig?.externalRestApiBaseUrl).toBe(
      `${targetEnvironment.externalRestApiBaseUrl}/api/v1`
    )
  })

  it('updates a saved profile when saving its terminal-dot REST spelling', async () => {
    const state = await runtimeConfigModule!.getDesktopRuntimeConfigState()
    const savedTarget = state.options.find(
      option =>
        option.externalRestApiBaseUrl === `${targetEnvironment.externalRestApiBaseUrl}/api/v1`
    )
    if (!savedTarget) throw new Error('The config producer did not return the saved REST profile')

    await runtimeConfigModule!.saveDesktopRuntimeConfig({
      ...targetEnvironment,
      externalRestApiBaseUrl: 'https://api.example.test./api/v1',
      rpcProxyBaseUrl: `${targetEnvironment.rpcProxyBaseUrl}/rpc`,
    })

    const finalState = await runtimeConfigModule!.getDesktopRuntimeConfigState()
    expect(finalState.options).toHaveLength(state.options.length)
    expect(finalState.activeOptionId).toBe(savedTarget.id)
    expect(finalState.currentConfig?.externalRestApiBaseUrl).toBe(
      `${targetEnvironment.externalRestApiBaseUrl}/api/v1`
    )
  })

  it.each(['one saved profile', 'multiple saved profiles'])(
    'rejects a different REST API path when %s already uses the same origin',
    async profileCount => {
      if (profileCount === 'multiple saved profiles') {
        await runtimeConfigModule!.saveDesktopRuntimeConfig({
          appName: 'Second API profile',
          externalRestApiBaseUrl: targetEnvironment.externalRestApiBaseUrl,
          rpcProxyBaseUrl: 'https://second-rpc.example.test',
        })
      }
      const { handler, selectRuntimeConfig, setPendingDesktopEnvironmentSetup, setStatus } =
        createHandler(() => ({
          booting: false,
          busy: false,
          authTransitioning: false,
          isAuthenticated: false,
        }))

      await handler({
        ...targetEnvironment,
        externalRestApiBaseUrl: `${targetEnvironment.externalRestApiBaseUrl}/other`,
      })

      expect(selectRuntimeConfig).not.toHaveBeenCalled()
      expect(setPendingDesktopEnvironmentSetup).toHaveBeenCalledWith(null)
      expect(setStatus).toHaveBeenCalledWith(
        'Desktop setup link rejected because this REST host is already saved with a different API endpoint.',
        'error'
      )
    }
  )

  it('rechecks duplicate saved REST profiles after logout before selecting', async () => {
    let authenticated = true
    const logout = vi.fn(async () => {
      await ensureNativeSession()
      const generation = await nativeProducer.logout()
      const before = await runtimeConfigModule!.getDesktopRuntimeConfigState()
      const original = before.options.find(
        option =>
          option.externalRestApiBaseUrl === `${targetEnvironment.externalRestApiBaseUrl}/api/v1`
      )
      if (!original?.configPath) throw new Error('The config producer did not persist the target')
      await runtimeConfigModule!.saveDesktopRuntimeConfig({
        appName: 'Second exact REST profile',
        externalRestApiBaseUrl: `${targetEnvironment.externalRestApiBaseUrl}/api/v2`,
        rpcProxyBaseUrl: 'https://second-rpc.example.test',
      })
      const afterSave = await runtimeConfigModule!.getDesktopRuntimeConfigState()
      const duplicate = afterSave.options.find(
        option => option.appName === 'Second exact REST profile'
      )
      if (!duplicate?.configPath)
        throw new Error('The config producer did not persist the duplicate')
      const configPaths: string[] = []
      for (const option of [original, duplicate]) {
        if (!option.configPath) throw new Error('The config producer did not persist the profile')
        configPaths.push(option.configPath)
      }
      for (const configPath of configPaths) {
        const contents = JSON.parse(await fsp.readFile(configPath, 'utf8')) as {
          externalRestApiBaseUrl: string
        }
        contents.externalRestApiBaseUrl = `${targetEnvironment.externalRestApiBaseUrl}/api/v1`
        await fsp.writeFile(configPath, JSON.stringify(contents), 'utf8')
      }
      vi.resetModules()
      runtimeConfigModule = await import('../../../../../src/config')
      const refreshed = await runtimeConfigModule.getDesktopRuntimeConfigState()
      const current = refreshed.options.find(
        option => option.externalRestApiBaseUrl === currentEnvironment.externalRestApiBaseUrl
      )
      if (!current) throw new Error('The config producer did not return the active profile')
      await runtimeConfigModule.selectDesktopRuntimeConfigOption(current.id)
      authenticated = false
      return generation
    })
    const refreshRuntimeConfigState = vi.fn(async () =>
      runtimeConfigModule!.getDesktopRuntimeConfigState()
    )
    const { handler, selectRuntimeConfig, setPendingDesktopEnvironmentSetup, setStatus } =
      createHandler(
        () => ({
          booting: false,
          busy: false,
          authTransitioning: false,
          isAuthenticated: authenticated,
        }),
        refreshRuntimeConfigState,
        logout,
        vi.fn(async () => {})
      )

    await handler({
      ...targetEnvironment,
      externalRestApiBaseUrl: `${targetEnvironment.externalRestApiBaseUrl}/api/v1`,
    })

    expect(refreshRuntimeConfigState).toHaveBeenCalledTimes(2)
    expect(logout).toHaveBeenCalledOnce()
    expect(selectRuntimeConfig).not.toHaveBeenCalled()
    expect(setPendingDesktopEnvironmentSetup).toHaveBeenCalledWith(null)
    expect(setStatus).toHaveBeenCalledWith(
      'Desktop setup link rejected because multiple saved environments use this REST API.',
      'error'
    )
  })

  it('reports an auth transition that starts during the post-logout config read', async () => {
    let authState = {
      booting: false,
      busy: false,
      authTransitioning: false,
      isAuthenticated: true,
    }
    let refreshCount = 0
    let finishSecondRefresh!: () => void
    let reportSecondRefreshStarted!: () => void
    const secondRefreshStarted = new Promise<void>(resolve => {
      reportSecondRefreshStarted = resolve
    })
    const runtimeConfigState = await runtimeConfigModule!.getDesktopRuntimeConfigState()
    const refreshRuntimeConfigState = () => {
      refreshCount += 1
      if (refreshCount === 1) return Promise.resolve(runtimeConfigState)
      return new Promise<typeof runtimeConfigState>(resolve => {
        finishSecondRefresh = () => resolve(runtimeConfigState)
        reportSecondRefreshStarted()
      })
    }
    const logout = vi.fn(async () => {
      await ensureNativeSession()
      const generation = await nativeProducer.logout()
      authState = { ...authState, isAuthenticated: false }
      return generation
    })
    const { handler, selectRuntimeConfig, setPendingDesktopEnvironmentSetup, setStatus } =
      createHandler(
        () => authState,
        refreshRuntimeConfigState,
        logout,
        vi.fn(async () => {})
      )

    const handling = handler({
      ...targetEnvironment,
      externalRestApiBaseUrl: `${targetEnvironment.externalRestApiBaseUrl}/api/v1`,
    })
    await secondRefreshStarted
    let finishLogin!: () => void
    let reportLoginStarted!: () => void
    const loginStarted = new Promise<void>(resolve => {
      reportLoginStarted = resolve
    })
    const loginResultValue = {
      token: 'synthetic-post-logout-login',
      me: {
        id: 'post-logout-user',
        email: 'post-logout@example.test',
        name: 'Post Logout User',
        picture: null,
        teamId: 'team-b',
        teamName: 'Team B',
        role: 'member',
      },
    }
    const loginResult = new Promise<typeof loginResultValue>(resolve => {
      finishLogin = () => resolve(loginResultValue)
    })
    nativeProducer.authClient.googleLogin.mockImplementationOnce(() => {
      reportLoginStarted()
      return loginResult
    })
    const login = nativeProducer.googleLogin('synthetic-post-logout-login')
    await loginStarted
    authState = { ...authState, busy: true, authTransitioning: true }
    finishSecondRefresh()
    await handling
    finishLogin()
    await login

    expect(logout).toHaveBeenCalledOnce()
    expect(selectRuntimeConfig).not.toHaveBeenCalled()
    expect(setPendingDesktopEnvironmentSetup).toHaveBeenCalledWith(null)
    expect(setStatus).toHaveBeenCalledWith(
      'The desktop session changed while processing this link. Open it again.',
      'info'
    )
  })
})
