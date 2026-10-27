import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { TokenStore } from '../../../../../src/tokenStore'
import type {
  DesktopRuntimeConfigHandoffSelection,
  DesktopRuntimeConfigState,
} from '../../../../../src/types'
import { testSessionTokenWithExpiry } from '../../../../../testSupport/authTestFixtures'
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
const syntheticKeychain = new Map<string, string>()
type NativeHandoffProducer = {
  authClient: {
    passwordLogin: ReturnType<typeof vi.fn>
    getMe: ReturnType<typeof vi.fn>
  }
  tokenStore: TokenStore
  sessionToken: string | null
  passwordLogin: (email: string, password: string) => Promise<unknown>
  getSessionGeneration: () => number
  getRuntimeConfigState: () => DesktopRuntimeConfigState
  prepareForQuit: () => Promise<void>
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
    passwordLogin: vi.fn().mockResolvedValue({
      token: testSessionTokenWithExpiry(),
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
    getMe: vi.fn().mockResolvedValue({
      id: 'handoff-user',
      email: 'handoff@example.test',
      name: 'Handoff User',
      picture: null,
      teamId: 'team-a',
      teamName: 'Team A',
      role: 'member',
    }),
  }
  nativeProducer.suspendDesktopGfsUploadsForAuthBoundary = vi.fn(async () => {})
}

async function ensureNativeSession(): Promise<void> {
  if (!nativeProducer.sessionToken)
    await nativeProducer.passwordLogin('handoff@example.test', 'synthetic-password')
}

beforeEach(async () => {
  syntheticKeychain.clear()
  runtimeConfigDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'evenfire-deep-link-test-'))
  vi.doUnmock('electron')
  vi.resetModules()
  vi.doMock('keytar', () => ({
    getPassword: vi.fn(
      async (service: string, account: string) =>
        syntheticKeychain.get(`${service}\u0000${account}`) ?? null
    ),
    setPassword: vi.fn(async (service: string, account: string, password: string) => {
      syntheticKeychain.set(`${service}\u0000${account}`, password)
    }),
    deletePassword: vi.fn(async (service: string, account: string) =>
      syntheticKeychain.delete(`${service}\u0000${account}`)
    ),
    findCredentials: vi.fn(async (service: string) =>
      [...syntheticKeychain.entries()]
        .filter(([key]) => key.startsWith(`${service}\u0000`))
        .map(([key, password]) => ({ account: key.slice(service.length + 1), password }))
    ),
  }))
  vi.doMock('electron', () => ({
    app: {
      getPath: vi.fn(() => runtimeConfigDirectory),
      isPackaged: true,
      isReady: vi.fn(() => true),
      setName: vi.fn(),
    },
    safeStorage: { isEncryptionAvailable: vi.fn(() => false) },
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
  await nativeProducer?.prepareForQuit()
  vi.restoreAllMocks()
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
  onSessionNeedsLoad: () => Promise<void> = vi.fn(async () => {}),
  getSessionGenerationOverride?: () => Promise<number>
) {
  const getCurrentAuthState = getAuthState
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
    setPendingDesktopEnvironmentSetup,
    setStatus,
  })
  return {
    handler,
    onSessionNeedsLoad,
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

  it('requests setup confirmation cleanup when environment verification fails', async () => {
    const refreshRuntimeConfigState = vi.fn(async () => {
      throw new Error('runtime config unavailable')
    })
    const { handler, setPendingDesktopEnvironmentSetup, setStatus } = createHandler(
      () => ({ booting: false, busy: false, authTransitioning: false, isAuthenticated: false }),
      refreshRuntimeConfigState
    )

    await handler(targetEnvironment)

    expect(setPendingDesktopEnvironmentSetup).toHaveBeenCalledWith(null)
    expect(setStatus).toHaveBeenCalledWith(
      'Could not verify the desktop environment. Try opening it again.',
      'error'
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
    await nativeProducer.passwordLogin('handoff@example.test', 'synthetic-password')
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
      await nativeProducer.passwordLogin('handoff@example.test', 'synthetic-password')
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
      await nativeProducer.passwordLogin('handoff@example.test', 'synthetic-password')
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

  it('does not load a selected environment when login completes after selection returns', async () => {
    const savedTarget = (await runtimeConfigModule!.getDesktopRuntimeConfigState()).options.find(
      option =>
        option.externalRestApiBaseUrl === `${targetEnvironment.externalRestApiBaseUrl}/api/v1`
    )
    if (!savedTarget) throw new Error('The config producer did not return the saved target')
    let generationReads = 0
    const getSessionGeneration = vi.fn(async () => {
      generationReads += 1
      if (generationReads === 3) {
        await nativeProducer.passwordLogin('handoff@example.test', 'synthetic-password')
      }
      return nativeProducer.getSessionGeneration()
    })
    const {
      handler,
      selectRuntimeConfig,
      setPendingDesktopEnvironmentSetup,
      onSessionNeedsLoad,
      setStatus,
    } = createHandler(
      () => ({ booting: false, busy: false, authTransitioning: false, isAuthenticated: false }),
      undefined,
      undefined,
      getSessionGeneration
    )

    await handler({
      ...targetEnvironment,
      externalRestApiBaseUrl: `${targetEnvironment.externalRestApiBaseUrl}/api/v1`,
    })

    expect(selectRuntimeConfig).toHaveBeenCalledWith(savedTarget.id, expect.any(Number))
    expect(onSessionNeedsLoad).not.toHaveBeenCalled()
    expect(setPendingDesktopEnvironmentSetup).toHaveBeenCalledWith(null)
    expect(setStatus).toHaveBeenCalledWith(
      'The desktop session changed while processing this link. Open it again.',
      'info'
    )
  })

  it('rejects an environment link before confirmation while authenticated', async () => {
    await ensureNativeSession()
    const refreshRuntimeConfigState = vi.fn(async () =>
      runtimeConfigModule!.getDesktopRuntimeConfigState()
    )
    const { handler, selectRuntimeConfig, setPendingDesktopEnvironmentSetup, setStatus } =
      createHandler(
        () => ({ booting: false, busy: false, authTransitioning: false, isAuthenticated: true }),
        refreshRuntimeConfigState
      )

    await handler({
      ...targetEnvironment,
      externalRestApiBaseUrl: `${targetEnvironment.externalRestApiBaseUrl}/api/v1`,
    })

    expect(refreshRuntimeConfigState).toHaveBeenCalledOnce()
    expect(selectRuntimeConfig).not.toHaveBeenCalled()
    expect(setPendingDesktopEnvironmentSetup).toHaveBeenCalledWith(null)
    expect(nativeProducer.getCachedUserId()).toBe('handoff-user')
    expect(setPendingDesktopEnvironmentSetup).toHaveBeenLastCalledWith(null)
    expect(setStatus).toHaveBeenLastCalledWith(
      'Log out before selecting another desktop environment.',
      'info'
    )
  })

  it('rechecks the generation before exposing a new-profile setup confirmation', async () => {
    let generationReads = 0
    const getSessionGeneration = async () => {
      generationReads += 1
      if (generationReads === 3) {
        await nativeProducer.passwordLogin('handoff@example.test', 'synthetic-password')
      }
      return nativeProducer.getSessionGeneration()
    }
    const { handler, setPendingDesktopEnvironmentSetup, setStatus } = createHandler(
      () => ({ booting: false, busy: false, authTransitioning: false, isAuthenticated: false }),
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

  it('rejects an authenticated environment link until the user logs out', async () => {
    await ensureNativeSession()
    const { handler, selectRuntimeConfig, setStatus } = createHandler(() => ({
      booting: false,
      busy: false,
      authTransitioning: false,
      isAuthenticated: true,
    }))

    await handler({
      ...targetEnvironment,
      externalRestApiBaseUrl: `${targetEnvironment.externalRestApiBaseUrl}/api/v1`,
    })

    expect(selectRuntimeConfig).not.toHaveBeenCalled()
    expect(nativeProducer.getCachedUserId()).toBe('handoff-user')
    expect(setStatus).toHaveBeenLastCalledWith(
      'Log out before selecting another desktop environment.',
      'info'
    )
  })

  it('treats a Profile link to the authenticated environment as a harmless no-op', async () => {
    await ensureNativeSession()
    const activeConfig = await runtimeConfigModule!.getDesktopRuntimeConfigState()
    const activeEnvironment = activeConfig.currentConfig
    if (!activeEnvironment) throw new Error('The authenticated environment is not configured')

    const {
      handler,
      selectRuntimeConfig,
      setStatus,
      setPendingDesktopEnvironmentSetup,
      onSessionNeedsLoad,
    } = createHandler(() => ({
      booting: false,
      busy: false,
      authTransitioning: false,
      isAuthenticated: true,
    }))

    await handler({
      appName: activeEnvironment.appName,
      externalRestApiBaseUrl: activeEnvironment.externalRestApiBaseUrl,
    })

    expect(selectRuntimeConfig).not.toHaveBeenCalled()
    expect(onSessionNeedsLoad).not.toHaveBeenCalled()
    expect(nativeProducer.getCachedUserId()).toBe('handoff-user')
    expect((await runtimeConfigModule!.getDesktopRuntimeConfigState()).activeOptionId).toBe(
      activeConfig.activeOptionId
    )
    expect(setPendingDesktopEnvironmentSetup).toHaveBeenCalledWith(null)
    expect(setStatus).toHaveBeenLastCalledWith(
      'This link points to the active Evenfire Desktop environment.',
      'success'
    )
  })

  it('rejects a saved-environment selection when login wins during verification', async () => {
    const state = await runtimeConfigModule!.getDesktopRuntimeConfigState()
    const savedTarget = state.options.find(
      option =>
        option.externalRestApiBaseUrl === `${targetEnvironment.externalRestApiBaseUrl}/api/v1`
    )
    if (!savedTarget) throw new Error('The config producer did not return the saved REST profile')

    let finishRefresh!: () => void
    let reportRefreshStarted!: () => void
    const refreshStarted = new Promise<void>(resolve => {
      reportRefreshStarted = resolve
    })
    const refreshRuntimeConfigState = () =>
      new Promise<typeof state>(resolve => {
        finishRefresh = () => resolve(state)
        reportRefreshStarted()
      })
    let authenticated = false
    const { handler, selectRuntimeConfig, setPendingDesktopEnvironmentSetup } = createHandler(
      () => ({
        booting: false,
        busy: false,
        authTransitioning: false,
        isAuthenticated: authenticated,
      }),
      refreshRuntimeConfigState
    )

    const handling = handler({
      ...targetEnvironment,
      externalRestApiBaseUrl: `${targetEnvironment.externalRestApiBaseUrl}/api/v1`,
    })
    await refreshStarted
    await nativeProducer.passwordLogin('login-wins@example.test', 'synthetic-password')
    authenticated = true
    finishRefresh()
    await handling

    expect(selectRuntimeConfig).not.toHaveBeenCalled()
    expect(setPendingDesktopEnvironmentSetup).toHaveBeenLastCalledWith(null)
    expect(nativeProducer.getCachedUserId()).toBe('handoff-user')
  })

  it('reports a signed-out environment reload failure without changing authentication state', async () => {
    const onSessionNeedsLoad = vi.fn(async () => {
      throw new Error('runtime reload unavailable')
    })
    const { handler, selectRuntimeConfig, setStatus } = createHandler(
      () => ({ booting: false, busy: false, authTransitioning: false, isAuthenticated: false }),
      undefined,
      onSessionNeedsLoad
    )

    await handler({
      ...targetEnvironment,
      externalRestApiBaseUrl: `${targetEnvironment.externalRestApiBaseUrl}/api/v1`,
    })

    expect(selectRuntimeConfig).toHaveBeenCalledOnce()
    expect(onSessionNeedsLoad).toHaveBeenCalledWith({ preserveNav: true })
    expect(setStatus).toHaveBeenLastCalledWith(
      'Could not load the selected desktop environment: runtime reload unavailable',
      'error'
    )
  })

  it('does not replace a newer login status with a stale signed-out reload failure', async () => {
    const onSessionNeedsLoad = vi.fn(async () => {
      await nativeProducer.passwordLogin('handoff@example.test', 'synthetic-password')
      throw new Error('stale runtime reload')
    })
    const { handler, selectRuntimeConfig, setStatus } = createHandler(
      () => ({
        booting: false,
        busy: false,
        authTransitioning: false,
        isAuthenticated: Boolean(nativeProducer.sessionToken),
      }),
      undefined,
      onSessionNeedsLoad
    )

    await handler({
      ...targetEnvironment,
      externalRestApiBaseUrl: `${targetEnvironment.externalRestApiBaseUrl}/api/v1`,
    })

    expect(selectRuntimeConfig).toHaveBeenCalledOnce()
    expect(onSessionNeedsLoad).toHaveBeenCalledWith({ preserveNav: true })
    expect(setStatus).toHaveBeenLastCalledWith(
      'The desktop session changed while processing this link. Open it again.',
      'info'
    )
    expect(setStatus).not.toHaveBeenCalledWith(
      'Could not load the selected desktop environment: stale runtime reload',
      'error'
    )
  })

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

    const { handler, selectRuntimeConfig, setPendingDesktopEnvironmentSetup, setStatus } =
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
})
