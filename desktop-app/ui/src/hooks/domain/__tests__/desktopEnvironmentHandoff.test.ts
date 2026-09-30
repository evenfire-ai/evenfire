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
    ['a missing RPC endpoint', { ...targetEnvironment, rpcProxyBaseUrl: '' }],
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
})
