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
  refreshRuntimeConfigState = async () => runtimeConfigModule!.getDesktopRuntimeConfigState()
) {
  const selectRuntimeConfig = vi.fn(async (optionId: string) => {
    await runtimeConfigModule!.selectDesktopRuntimeConfigOption(optionId)
    return runtimeConfigModule!.getDesktopRuntimeConfigState()
  })
  const setPendingDesktopEnvironmentSetup = vi.fn()
  const setStatus = vi.fn()
  const handler = createDesktopEnvironmentSetupHandler({
    getAuthState,
    refreshRuntimeConfigState,
    handleSelectRuntimeConfig: selectRuntimeConfig,
    onSessionNeedsLoad: vi.fn(async () => undefined),
    setPendingDesktopEnvironmentSetup,
    setStatus,
  })
  return { handler, selectRuntimeConfig, setPendingDesktopEnvironmentSetup, setStatus }
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

  it('keeps the first environment link when another arrives during verification', async () => {
    const finishRefreshes: Array<() => void> = []
    const runtimeConfigState = await runtimeConfigModule!.getDesktopRuntimeConfigState()
    const refreshRuntimeConfigState = () =>
      new Promise<typeof runtimeConfigState>(resolve => {
        finishRefreshes.push(() => resolve(runtimeConfigState))
      })
    const { handler } = createHandler(
      () => ({ booting: false, busy: false, authTransitioning: false, isAuthenticated: false }),
      refreshRuntimeConfigState
    )

    const first = handler(targetEnvironment)
    const second = handler(otherEnvironment)
    finishRefreshes.forEach(finishRefresh => finishRefresh())
    await Promise.all([first, second])

    const finalState = await runtimeConfigModule!.getDesktopRuntimeConfigState()
    expect(finalState.currentConfig?.externalRestApiBaseUrl).toBe(
      `${targetEnvironment.externalRestApiBaseUrl}/api/v1`
    )
  })
})

describe('Desktop environment origin matching', () => {
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

  it('selects the unique saved REST profile when the link omits RPC', async () => {
    const state = await runtimeConfigModule!.getDesktopRuntimeConfigState()
    const savedTarget = state.options.find(
      option =>
        option.externalRestApiBaseUrl === `${targetEnvironment.externalRestApiBaseUrl}/api/v1`
    )
    if (!savedTarget) throw new Error('The config producer did not return the saved REST profile')
    const { handler, selectRuntimeConfig, setPendingDesktopEnvironmentSetup } = createHandler(
      () => ({ booting: false, busy: false, authTransitioning: false, isAuthenticated: false })
    )

    await handler({ ...targetEnvironment, rpcProxyBaseUrl: '' })

    expect(selectRuntimeConfig).toHaveBeenCalledWith(savedTarget.id)
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
      rpcProxyBaseUrl: '',
    })

    const finalState = await runtimeConfigModule!.getDesktopRuntimeConfigState()
    expect(selectRuntimeConfig).toHaveBeenCalledWith(savedTarget.id)
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

  it('rejects an omitted RPC when multiple saved profiles share the REST origin', async () => {
    await runtimeConfigModule!.saveDesktopRuntimeConfig({
      appName: 'Second API profile',
      externalRestApiBaseUrl: targetEnvironment.externalRestApiBaseUrl,
      rpcProxyBaseUrl: 'https://second-rpc.example.test',
    })
    const { handler, selectRuntimeConfig, setPendingDesktopEnvironmentSetup, setStatus } =
      createHandler(() => ({
        booting: false,
        busy: false,
        authTransitioning: false,
        isAuthenticated: false,
      }))

    await handler({ ...targetEnvironment, rpcProxyBaseUrl: '' })

    expect(selectRuntimeConfig).not.toHaveBeenCalled()
    expect(setPendingDesktopEnvironmentSetup).toHaveBeenCalledWith(null)
    expect(setStatus).toHaveBeenCalledWith(
      expect.stringMatching(/multiple saved environments use this REST host/i),
      'error'
    )
  })
})
