import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
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
})

afterEach(async () => {
  vi.doUnmock('electron')
  vi.resetModules()
  await fsp.rm(runtimeConfigDirectory, { recursive: true, force: true })
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
  readSessionGeneration?: () => Promise<number>
) {
  let sessionGeneration = 0
  const getSessionGeneration = readSessionGeneration ?? (async () => sessionGeneration)
  const logout =
    logoutForEnvironmentMismatch ??
    vi.fn(async () => {
      sessionGeneration += 1
      return sessionGeneration
    })
  const selectRuntimeConfig = vi.fn(async (optionId: string, _expectedGeneration?: number) => {
    await runtimeConfigModule!.selectDesktopRuntimeConfigOption(optionId)
    sessionGeneration += 1
    return {
      runtimeConfigState: await runtimeConfigModule!.getDesktopRuntimeConfigState(),
      sessionGeneration,
    }
  })
  const setPendingDesktopEnvironmentSetup = vi.fn()
  const setStatus = vi.fn()
  const handler = createDesktopEnvironmentSetupHandler({
    getAuthState,
    getSessionGeneration,
    refreshRuntimeConfigState,
    handleSelectRuntimeConfig: selectRuntimeConfig,
    onSessionNeedsLoad,
    logoutForEnvironmentMismatch: logout,
    setPendingDesktopEnvironmentSetup,
    setStatus,
  })
  return {
    handler,
    onSessionNeedsLoad,
    selectRuntimeConfig,
    setPendingDesktopEnvironmentSetup,
    setStatus,
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
    expect(setPendingDesktopEnvironmentSetup).not.toHaveBeenCalled()
  })

  it('rechecks the auth operation state after runtime configuration loads', async () => {
    let finishRefresh: (() => void) | undefined
    const runtimeConfigState = await runtimeConfigModule!.getDesktopRuntimeConfigState()
    const refreshRuntimeConfigState = () =>
      new Promise<typeof runtimeConfigState>(resolve => {
        finishRefresh = () => resolve(runtimeConfigState)
      })
    let busy = false
    const { handler, selectRuntimeConfig, setPendingDesktopEnvironmentSetup } = createHandler(
      () => ({ booting: false, busy, authTransitioning: false, isAuthenticated: false }),
      refreshRuntimeConfigState
    )

    const handling = handler(targetEnvironment)
    busy = true
    finishRefresh?.()
    await handling

    expect(selectRuntimeConfig).not.toHaveBeenCalled()
    expect(setPendingDesktopEnvironmentSetup).not.toHaveBeenCalled()
  })

  it.each([
    {
      outcome: 'selects the linked saved environment',
      externalRestApiBaseUrl: `${targetEnvironment.externalRestApiBaseUrl}/api/v1`,
      action: 'select',
    },
    {
      outcome: 'prompts to add the linked environment',
      externalRestApiBaseUrl: `${targetEnvironment.externalRestApiBaseUrl}/other`,
      action: 'prompt',
    },
  ])('waits for logout to finish, then $outcome', async ({ externalRestApiBaseUrl, action }) => {
    const state = await runtimeConfigModule!.getDesktopRuntimeConfigState()
    const savedTarget = state.options.find(
      option =>
        option.externalRestApiBaseUrl === `${targetEnvironment.externalRestApiBaseUrl}/api/v1`
    )
    if (!savedTarget) throw new Error('The config producer did not return the saved REST profile')

    let sessionGeneration = 0
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
    const logout = vi.fn(async () => {
      busy = true
      reportLogoutStarted()
      await logoutFinished
      isAuthenticated = false
      busy = false
      sessionGeneration += 1
      return sessionGeneration
    })
    const { handler, selectRuntimeConfig, setPendingDesktopEnvironmentSetup } = createHandler(
      () => ({ booting: false, busy, authTransitioning: false, isAuthenticated }),
      undefined,
      logout,
      undefined,
      async () => sessionGeneration
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
      expect(selectRuntimeConfig).toHaveBeenCalledWith(savedTarget.id, 1)
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

  it('keeps the current environment when token removal fails during handoff logout', async () => {
    let rendererAuthenticated = true
    const clearSessionToken = vi.fn(async () => {
      throw new Error('secure storage unavailable')
    })
    const logoutForEnvironmentMismatch = vi.fn(async () => {
      try {
        await clearSessionToken()
      } catch {
        // AppService retains the active session when durable token removal fails.
      }
      return null
    })
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

    expect(clearSessionToken).toHaveBeenCalledOnce()
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
    const logoutForEnvironmentMismatch = vi.fn(async () => {
      // handleLogout reports a failed logout and resolves; the live session remains active.
      return null
    })
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

  it.each([
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
    'does not continue toward a $targetKind when a newer login $loginOutcome during the second config read',
    async ({ externalRestApiBaseUrl, loginState }) => {
      let sessionGeneration = 0
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
        sessionGeneration += 1
        authState = { ...authState, isAuthenticated: false }
        return sessionGeneration
      })
      const onSessionNeedsLoad = vi.fn(async () => {})
      const { handler, selectRuntimeConfig, setPendingDesktopEnvironmentSetup } = createHandler(
        () => authState,
        refreshRuntimeConfigState,
        logoutForEnvironmentMismatch,
        onSessionNeedsLoad,
        async () => sessionGeneration
      )

      const handling = handler({ ...targetEnvironment, externalRestApiBaseUrl })
      await secondRefreshStarted
      sessionGeneration += 1
      authState = { ...authState, ...loginState }
      finishSecondRefresh()
      await handling

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

    await handler({
      ...targetEnvironment,
      externalRestApiBaseUrl: `${targetEnvironment.externalRestApiBaseUrl}/api/v1`,
    })

    expect(selectRuntimeConfig).toHaveBeenCalledWith(savedTarget.id, 0)
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

    await handler({
      ...targetEnvironment,
      externalRestApiBaseUrl: 'https://api.example.test./api/v1',
    })

    const finalState = await runtimeConfigModule!.getDesktopRuntimeConfigState()
    expect(selectRuntimeConfig).toHaveBeenCalledWith(savedTarget.id, 0)
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
    'offers to add an unmatched REST path with %s on the same origin',
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
      expect(setPendingDesktopEnvironmentSetup).toHaveBeenCalledWith({
        ...targetEnvironment,
        externalRestApiBaseUrl: `${targetEnvironment.externalRestApiBaseUrl}/other`,
        rpcProxyBaseUrl: '',
      })
      expect(setStatus).not.toHaveBeenCalledWith(
        expect.stringMatching(/multiple saved environments/i),
        'error'
      )
    }
  )
})
