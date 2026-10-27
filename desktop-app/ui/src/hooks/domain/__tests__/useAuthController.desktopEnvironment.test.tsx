// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AppService } from '../../../../../src/appService'
import type { DesktopRuntimeConfigState } from '../../../../../src/types'
import { testSessionTokenWithExpiry } from '../../../../../testSupport/authTestFixtures'
import { useAuthController } from '../useAuthController'
import { wrapLikeElectronIpc } from './__fixtures__/ipcErrors'

const mocks = vi.hoisted(() => ({
  clearQueryCache: vi.fn(),
  completeDesktopSetup: vi.fn(),
  getRuntimeConfigState: vi.fn(),
  getSessionGeneration: vi.fn(),
  onDesktopEnvironmentSetup: vi.fn(),
  onDesktopSetupToken: vi.fn(),
  onExternalLogout: vi.fn(),
  onSessionStateChanged: vi.fn(),
  onSessionExpired: vi.fn(),
  saveRuntimeConfig: vi.fn(),
  selectRuntimeConfig: vi.fn(),
  selectRuntimeConfigForHandoff: vi.fn(),
  setStatus: vi.fn(),
  loadSession: vi.fn(),
}))

vi.mock('@lib/queryClient', () => ({
  desktopQueryClient: { clear: mocks.clearQueryCache },
}))

const targetEnvironment = {
  appName: 'Example tenant',
  externalRestApiBaseUrl: 'https://api.example.test',
}
const targetRpcProxyBaseUrl = 'https://rpc.example.test'

const otherEnvironment = {
  appName: 'Other tenant',
  externalRestApiBaseUrl: 'https://other-api.example.test',
  rpcProxyBaseUrl: 'https://other-rpc.example.test',
}

type DesktopEnvironmentSetupPayload = {
  externalRestApiBaseUrl: string
  appName?: string
}
type DesktopSetupTokenPayload = { email: string; authorizationToken: string }

let desktopEnvironmentSetupListener:
  | ((payload: DesktopEnvironmentSetupPayload) => void | Promise<void>)
  | null = null
let desktopSetupTokenListener:
  | ((payload: DesktopSetupTokenPayload) => void | Promise<void>)
  | null = null
let sessionExpiredListener: (() => void) | null = null
let sessionStateChangedListener: (() => void) | null = null
let confirmDesktopEnvironmentSetupForTest: (() => Promise<void>) | null = null
let selectRuntimeConfigForTest: ((id: string) => Promise<DesktopRuntimeConfigState | null>) | null =
  null
let setBootingForTest: ((value: boolean) => void) | null = null
let setAuthenticatedForTest: ((value: boolean) => void) | null = null
let setTemporarySessionExpiryForTest: ((value: number | null) => void) | null = null
let runtimeConfigModule: typeof import('../../../../../src/config') | null = null
let nativeAppService: AppService | null = null
let runtimeConfigDirectory = ''
const syntheticKeychain = new Map<string, string>()
const originalOnboardingPreview = process.env.EVENFIRE_ONBOARDING_PREVIEW
const frozenProfileIdMilliseconds = 1790000000000

function Probe() {
  const auth = useAuthController({
    setStatus: mocks.setStatus,
    onSessionNeedsLoad: mocks.loadSession,
  })
  setBootingForTest = auth.setBooting
  setAuthenticatedForTest = auth.setIsAuthenticated
  setTemporarySessionExpiryForTest = auth.setTemporarySessionExpiresAt
  confirmDesktopEnvironmentSetupForTest = auth.handleConfirmDesktopEnvironmentSetup
  selectRuntimeConfigForTest = auth.handleSelectRuntimeConfig

  return (
    <>
      <div data-testid="configuration-loaded">{auth.runtimeConfigState ? 'yes' : 'no'}</div>
      <div data-testid="pending-environment">
        {auth.pendingDesktopEnvironmentSetup?.externalRestApiBaseUrl || 'none'}
      </div>
      <div data-testid="is-authenticated">{auth.isAuthenticated ? 'yes' : 'no'}</div>
      <div data-testid="pending-rpc">
        {auth.pendingDesktopEnvironmentSetup?.rpcProxyBaseUrl || 'none'}
      </div>
      <div data-testid="setup-complete">{auth.desktopEnvironmentSetupComplete ? 'yes' : 'no'}</div>
      <div data-testid="temporary-expiry">{auth.temporarySessionExpiresAt ?? 'none'}</div>
      <div data-testid="active-environment">
        {auth.runtimeConfigState?.activeOptionId || 'none'}
      </div>
      <div data-testid="active-rest">
        {auth.runtimeConfigState?.currentConfig?.externalRestApiBaseUrl || 'none'}
      </div>
    </>
  )
}

async function dispatchDesktopEnvironmentLink(
  payload: DesktopEnvironmentSetupPayload = targetEnvironment
) {
  if (!desktopEnvironmentSetupListener) {
    throw new Error('Desktop environment listener was not registered')
  }
  await act(async () => {
    await desktopEnvironmentSetupListener?.(payload)
  })
}

async function savedTargetOptionId(): Promise<string> {
  const state = await runtimeConfigModule!.getDesktopRuntimeConfigState()
  const option = state.options.find(
    candidate =>
      candidate.externalRestApiBaseUrl === `${targetEnvironment.externalRestApiBaseUrl}/api/v1` &&
      candidate.rpcProxyBaseUrl === `${targetRpcProxyBaseUrl}/rpc`
  )
  if (!option) throw new Error('The runtime config producer did not return the saved target')
  return option.id
}

beforeEach(async () => {
  vi.clearAllMocks()
  syntheticKeychain.clear()
  vi.spyOn(Date, 'now').mockReturnValue(frozenProfileIdMilliseconds)
  desktopEnvironmentSetupListener = null
  desktopSetupTokenListener = null
  sessionExpiredListener = null
  sessionStateChangedListener = null
  confirmDesktopEnvironmentSetupForTest = null
  selectRuntimeConfigForTest = null
  setBootingForTest = null
  setAuthenticatedForTest = null
  runtimeConfigModule = null
  nativeAppService = null
  delete process.env.EVENFIRE_ONBOARDING_PREVIEW
  runtimeConfigDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'evenfire-desktop-env-test-'))
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
    safeStorage: { isEncryptionAvailable: () => false },
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
    rpcProxyBaseUrl: `${targetRpcProxyBaseUrl}/rpc`,
  })
  await runtimeConfigModule.saveDesktopRuntimeConfig(otherEnvironment)
  const { AppService } = await import('../../../../../src/appService')
  nativeAppService = new AppService()
  ;(
    nativeAppService as unknown as {
      tokenStore: { clearSessionToken: ReturnType<typeof vi.fn> }
    }
  ).tokenStore.clearSessionToken = vi.fn().mockResolvedValue(undefined)

  mocks.getRuntimeConfigState.mockImplementation(async () =>
    runtimeConfigModule!.getDesktopRuntimeConfigState()
  )
  mocks.selectRuntimeConfig.mockImplementation(async (optionId: string) => {
    await runtimeConfigModule!.selectDesktopRuntimeConfigOption(optionId)
    return runtimeConfigModule!.getDesktopRuntimeConfigState()
  })
  mocks.getSessionGeneration.mockImplementation(async () =>
    nativeAppService!.getSessionGeneration()
  )
  mocks.selectRuntimeConfigForHandoff.mockImplementation(
    async (optionId: string, expectedSessionGeneration: number) => {
      try {
        return await nativeAppService!.selectRuntimeConfigForHandoff(
          optionId,
          expectedSessionGeneration
        )
      } catch (error) {
        throw wrapLikeElectronIpc(
          'auth:selectRuntimeConfigForHandoff',
          error instanceof Error ? error : new Error(String(error))
        )
      }
    }
  )
  mocks.loadSession.mockImplementation(async () => {
    setBootingForTest?.(false)
    setAuthenticatedForTest?.(nativeAppService!.getCachedUserId() !== null)
  })
  mocks.onDesktopSetupToken.mockImplementation(listener => {
    desktopSetupTokenListener = listener
    return () => undefined
  })
  mocks.onExternalLogout.mockReturnValue(() => undefined)
  mocks.onSessionStateChanged.mockImplementation((listener: () => void) => {
    sessionStateChangedListener = listener
    return () => undefined
  })
  mocks.onSessionExpired.mockImplementation((listener: () => void) => {
    sessionExpiredListener = listener
    return () => undefined
  })
  mocks.onDesktopEnvironmentSetup.mockImplementation(
    (listener: (payload: DesktopEnvironmentSetupPayload) => void | Promise<void>) => {
      desktopEnvironmentSetupListener = listener
      return () => undefined
    }
  )
  window.clerum = {
    ...window.clerum,
    auth: {
      ...window.clerum?.auth,
      getRuntimeConfigState: mocks.getRuntimeConfigState,
      getSessionGeneration: mocks.getSessionGeneration,
      saveRuntimeConfig: mocks.saveRuntimeConfig,
      selectRuntimeConfig: mocks.selectRuntimeConfig,
      selectRuntimeConfigForHandoff: mocks.selectRuntimeConfigForHandoff,
      onDesktopEnvironmentSetup: mocks.onDesktopEnvironmentSetup,
      onDesktopSetupToken: mocks.onDesktopSetupToken,
      completeDesktopSetup: mocks.completeDesktopSetup,
      onExternalLogout: mocks.onExternalLogout,
      onSessionStateChanged: mocks.onSessionStateChanged,
      onSessionExpired: mocks.onSessionExpired,
    },
  }
})

afterEach(async () => {
  cleanup()
  await nativeAppService?.prepareForQuit()
  vi.restoreAllMocks()
  vi.doUnmock('electron')
  vi.resetModules()
  await fsp.rm(runtimeConfigDirectory, { recursive: true, force: true })
  if (originalOnboardingPreview === undefined) delete process.env.EVENFIRE_ONBOARDING_PREVIEW
  else process.env.EVENFIRE_ONBOARDING_PREVIEW = originalOnboardingPreview
})

describe('Desktop environment handoff', () => {
  it('reloads auth state after main reports an unverified logout result', async () => {
    render(<Probe />)
    await waitFor(() => expect(mocks.onSessionStateChanged).toHaveBeenCalledOnce())
    const loadCount = mocks.loadSession.mock.calls.length

    await act(async () => {
      sessionStateChangedListener?.()
      await Promise.resolve()
    })

    expect(mocks.loadSession).toHaveBeenCalledTimes(loadCount + 1)
    expect(mocks.loadSession).toHaveBeenLastCalledWith({ preserveNav: true })
  })

  it('clears the temporary-session disclosure and reloads auth on main-process expiry', async () => {
    render(<Probe />)
    await waitFor(() => expect(mocks.onSessionExpired).toHaveBeenCalledOnce())
    const expiresAt = Date.now() + 60_000
    act(() => setTemporarySessionExpiryForTest?.(expiresAt))
    expect(screen.getByTestId('temporary-expiry')).toHaveTextContent(String(expiresAt))

    await act(async () => {
      sessionExpiredListener?.()
      await Promise.resolve()
    })

    await waitFor(() =>
      expect(mocks.setStatus).toHaveBeenCalledWith(
        'Your temporary session ended. Please sign in again.',
        'info'
      )
    )
    expect(mocks.loadSession).toHaveBeenCalledWith({ preserveNav: true })
    expect(screen.getByTestId('temporary-expiry')).toHaveTextContent('none')
  })

  it.each(['generation failure', 'authentication starts', 'invalid REST endpoint'])(
    'clears the first dialog when a second link meets %s',
    async failure => {
      const first = { externalRestApiBaseUrl: 'https://first-api.example.test', appName: 'First' }
      render(<Probe />)
      await waitFor(() =>
        expect(screen.getByTestId('configuration-loaded')).toHaveTextContent('yes')
      )
      await dispatchDesktopEnvironmentLink(first)
      expect(screen.getByTestId('pending-environment')).toHaveTextContent(
        first.externalRestApiBaseUrl
      )
      if (failure === 'generation failure')
        mocks.getSessionGeneration.mockRejectedValueOnce(new Error('fixture IPC unavailable'))
      else if (failure === 'authentication starts')
        mocks.getSessionGeneration.mockImplementationOnce(async () => {
          await act(async () => setBootingForTest?.(true))
          return nativeAppService!.getSessionGeneration()
        })
      await dispatchDesktopEnvironmentLink({
        externalRestApiBaseUrl:
          failure === 'invalid REST endpoint'
            ? 'file:///invalid'
            : 'https://second-api.example.test',
      })
      expect(screen.getByTestId('pending-environment')).toHaveTextContent('none')
      expect(mocks.saveRuntimeConfig).not.toHaveBeenCalled()
      expect(mocks.setStatus).toHaveBeenLastCalledWith(
        failure === 'generation failure'
          ? 'Could not verify the desktop session. Try opening the link again.'
          : failure === 'authentication starts'
            ? 'Finish the current authentication action, then reopen this desktop link.'
            : expect.stringContaining('Desktop setup link rejected:'),
        failure === 'authentication starts' ? 'info' : 'error'
      )
    }
  )

  it('rejects confirmation when native login completes after selection of a newly saved profile', async () => {
    const linked = { externalRestApiBaseUrl: 'https://new-api.example.test', appName: 'New' }
    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('configuration-loaded')).toHaveTextContent('yes'))
    await dispatchDesktopEnvironmentLink(linked)
    await runtimeConfigModule!.saveDesktopRuntimeConfig({
      ...linked,
      rpcProxyBaseUrl: 'https://rpc-new.example.test',
    })
    const other = runtimeConfigModule!
      .getDesktopRuntimeConfigState()
      .options.find(
        option => option.externalRestApiBaseUrl === otherEnvironment.externalRestApiBaseUrl
      )!
    await runtimeConfigModule!.selectDesktopRuntimeConfigOption(other.id)
    const { AuthClient } = await import('../../../../../src/authClient')
    vi.spyOn(AuthClient.prototype, 'passwordLogin').mockResolvedValue({
      token: testSessionTokenWithExpiry(),
      me: {
        id: 'new-user',
        email: 'new@example.test',
        name: 'New',
        picture: null,
        teamId: 'team-a',
        teamName: 'A',
        role: 'member',
      },
    })
    vi.spyOn(AuthClient.prototype, 'getMe').mockResolvedValue({
      id: 'new-user',
      email: 'new@example.test',
      name: 'New',
      picture: null,
      teamId: 'team-a',
      teamName: 'A',
      role: 'member',
    })
    const { TokenStore } = await import('../../../../../src/tokenStore')
    ;(nativeAppService as unknown as { tokenStore: InstanceType<typeof TokenStore> }).tokenStore =
      new TokenStore()
    mocks.selectRuntimeConfigForHandoff.mockImplementationOnce(async (id, generation) => {
      const selection = await nativeAppService!.selectRuntimeConfigForHandoff(id, generation)
      await nativeAppService!.passwordLogin('new@example.test', 'synthetic-password')
      return selection
    })
    mocks.loadSession.mockClear()
    await act(async () => confirmDesktopEnvironmentSetupForTest?.())
    expect(nativeAppService!.getCachedUserId()).toBe('new-user')
    expect(mocks.loadSession).not.toHaveBeenCalled()
    expect(screen.getByTestId('pending-environment')).toHaveTextContent('none')
    expect(mocks.setStatus.mock.calls.filter(([, tone]) => tone === 'success')).toEqual([])
    expect(mocks.setStatus).toHaveBeenLastCalledWith(
      'The desktop session changed while processing this link. Open it again.',
      'info'
    )
  })

  it('reports verification failure after confirmation selects a newly saved profile', async () => {
    const linked = { externalRestApiBaseUrl: 'https://new-api.example.test', appName: 'New' }
    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('configuration-loaded')).toHaveTextContent('yes'))
    await dispatchDesktopEnvironmentLink(linked)
    await runtimeConfigModule!.saveDesktopRuntimeConfig({
      ...linked,
      rpcProxyBaseUrl: 'https://rpc-new.example.test',
    })
    const other = runtimeConfigModule!
      .getDesktopRuntimeConfigState()
      .options.find(
        option => option.externalRestApiBaseUrl === otherEnvironment.externalRestApiBaseUrl
      )!
    await runtimeConfigModule!.selectDesktopRuntimeConfigOption(other.id)
    mocks.selectRuntimeConfigForHandoff.mockImplementationOnce(async (id, generation) => {
      const selection = await nativeAppService!.selectRuntimeConfigForHandoff(id, generation)
      mocks.getSessionGeneration.mockRejectedValueOnce(new Error('fixture IPC unavailable'))
      return selection
    })
    await act(async () => confirmDesktopEnvironmentSetupForTest?.())
    expect(screen.getByTestId('pending-environment')).toHaveTextContent('none')
    expect(mocks.selectRuntimeConfigForHandoff).toHaveBeenCalledOnce()
    expect(mocks.loadSession).toHaveBeenCalledOnce()
    expect(nativeAppService!.getRuntimeConfigState().currentConfig?.externalRestApiBaseUrl).toBe(
      linked.externalRestApiBaseUrl
    )
    expect(mocks.setStatus.mock.calls.filter(([, tone]) => tone === 'success')).toEqual([])
    expect(mocks.setStatus).toHaveBeenLastCalledWith(
      'Could not verify the desktop session. Try opening the link again.',
      'error'
    )
  })

  it('completes a verified linked setup with exactly one trusted success notification', async () => {
    const linked = {
      externalRestApiBaseUrl: 'https://new-api.example.test',
      appName: 'Untrusted Profile label',
    }
    const { AuthClient } = await import('../../../../../src/authClient')
    vi.spyOn(AuthClient.prototype, 'getDesktopEnvironment').mockResolvedValue({
      externalRestApiBaseUrl: linked.externalRestApiBaseUrl,
      rpcProxyBaseUrl: 'https://new-rpc.example.test',
      appName: 'Discovered environment',
    })
    mocks.saveRuntimeConfig.mockImplementationOnce((config, generation) =>
      nativeAppService!.saveRuntimeConfig(config, generation)
    )
    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('configuration-loaded')).toHaveTextContent('yes'))
    await dispatchDesktopEnvironmentLink(linked)
    mocks.setStatus.mockClear()

    await act(async () => confirmDesktopEnvironmentSetupForTest?.())

    const state = nativeAppService!.getRuntimeConfigState()
    const selected = state.options.find(option => option.id === state.activeOptionId)
    expect(selected).toMatchObject({
      externalRestApiBaseUrl: linked.externalRestApiBaseUrl,
      rpcProxyBaseUrl: 'https://new-rpc.example.test',
    })
    expect(screen.getByTestId('active-environment')).toHaveTextContent(state.activeOptionId!)
    expect(screen.getByTestId('active-rest')).toHaveTextContent(linked.externalRestApiBaseUrl)
    expect(screen.getByTestId('setup-complete')).toHaveTextContent('yes')
    expect(screen.getByTestId('pending-environment')).toHaveTextContent('none')
    expect(mocks.saveRuntimeConfig).toHaveBeenCalledOnce()
    expect(mocks.selectRuntimeConfigForHandoff).not.toHaveBeenCalled()
    expect(mocks.setStatus.mock.calls.filter(([, tone]) => tone === 'success')).toEqual([
      ['Desktop environment saved.', 'success'],
    ])
    expect(mocks.setStatus.mock.calls.some(([message]) => message.includes(linked.appName))).toBe(
      false
    )
  })

  it('rejects a saved linked profile when another native profile becomes active before verification', async () => {
    const linked = { externalRestApiBaseUrl: 'https://new-api.example.test', appName: 'New' }
    const other = runtimeConfigModule!
      .getDesktopRuntimeConfigState()
      .options.find(
        option => option.externalRestApiBaseUrl === otherEnvironment.externalRestApiBaseUrl
      )!
    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('configuration-loaded')).toHaveTextContent('yes'))
    await dispatchDesktopEnvironmentLink(linked)
    mocks.setStatus.mockClear()
    mocks.saveRuntimeConfig.mockImplementationOnce(async (config, generation) => {
      await nativeAppService!.saveRuntimeConfig(config, generation)
      await nativeAppService!.selectRuntimeConfig(other.id)
      return nativeAppService!.getRuntimeConfigState()
    })
    await act(async () => confirmDesktopEnvironmentSetupForTest?.())
    const state = nativeAppService!.getRuntimeConfigState()
    expect(state.activeOptionId).toBe(other.id)
    expect(
      state.options.some(option => option.externalRestApiBaseUrl === linked.externalRestApiBaseUrl)
    ).toBe(true)
    expect(screen.getByTestId('pending-environment')).toHaveTextContent('none')
    expect(screen.getByTestId('setup-complete')).toHaveTextContent('no')
    expect(mocks.setStatus).toHaveBeenLastCalledWith(
      'Desktop environment setup could not verify the confirmed REST and RPC endpoints.',
      'error'
    )
    expect(mocks.setStatus.mock.calls.some(([, tone]) => tone === 'success')).toBe(false)
  })

  it('refuses a confirmation save result for a different REST profile', async () => {
    const linked = { externalRestApiBaseUrl: 'https://new-api.example.test', appName: 'New' }
    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('configuration-loaded')).toHaveTextContent('yes'))
    await dispatchDesktopEnvironmentLink(linked)
    // Native config produces the intervening profile; the IPC result is its real state.
    mocks.saveRuntimeConfig.mockImplementationOnce(async () => {
      await nativeAppService!.saveRuntimeConfig(otherEnvironment)
      return nativeAppService!.getRuntimeConfigState()
    })
    await act(async () => confirmDesktopEnvironmentSetupForTest?.())
    expect(screen.getByTestId('pending-environment')).toHaveTextContent('none')
    expect(screen.getByTestId('setup-complete')).toHaveTextContent('no')
    expect(mocks.setStatus).toHaveBeenLastCalledWith(
      'Desktop environment setup could not verify the confirmed REST and RPC endpoints.',
      'error'
    )
  })

  it('rejects duplicate saved matches that appear while the setup dialog is open', async () => {
    const linked = { externalRestApiBaseUrl: 'https://new-api.example.test', appName: 'New' }
    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('configuration-loaded')).toHaveTextContent('yes'))
    await dispatchDesktopEnvironmentLink(linked)
    for (const suffix of ['one', 'two']) {
      await runtimeConfigModule!.saveDesktopRuntimeConfig({
        externalRestApiBaseUrl: `${linked.externalRestApiBaseUrl}/${suffix}`,
        rpcProxyBaseUrl: `https://rpc-${suffix}.example.test`,
        appName: suffix,
      })
    }
    // Preserve producer-written metadata and emulate legacy duplicate profile files.
    const state = runtimeConfigModule!.getDesktopRuntimeConfigState()
    for (const option of state.options.filter(option => ['one', 'two'].includes(option.appName))) {
      if (!option.configPath) throw new Error('The config producer did not persist the profile')
      const saved = JSON.parse(await fsp.readFile(option.configPath, 'utf8'))
      await fsp.writeFile(
        option.configPath,
        JSON.stringify({ ...saved, externalRestApiBaseUrl: linked.externalRestApiBaseUrl })
      )
    }
    vi.resetModules()
    runtimeConfigModule = await import('../../../../../src/config')
    const other = runtimeConfigModule
      .getDesktopRuntimeConfigState()
      .options.find(
        option => option.externalRestApiBaseUrl === otherEnvironment.externalRestApiBaseUrl
      )!
    await runtimeConfigModule.selectDesktopRuntimeConfigOption(other.id)
    mocks.saveRuntimeConfig.mockClear()
    mocks.selectRuntimeConfigForHandoff.mockClear()
    await act(async () => confirmDesktopEnvironmentSetupForTest?.())
    expect(screen.getByTestId('pending-environment')).toHaveTextContent('none')
    expect(mocks.saveRuntimeConfig).not.toHaveBeenCalled()
    expect(mocks.selectRuntimeConfigForHandoff).not.toHaveBeenCalled()
    expect(runtimeConfigModule.getDesktopRuntimeConfigState().activeOptionId).toBe(other.id)
    expect(mocks.setStatus).toHaveBeenLastCalledWith(
      'Desktop setup link rejected because multiple saved environments use this REST API.',
      'error'
    )
  })

  it('preserves a native login that starts while setup confirmation rereads configuration', async () => {
    const linkedEnvironment = {
      appName: 'New tenant',
      externalRestApiBaseUrl: 'https://new-api.example.test/api/v1',
    }
    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('configuration-loaded')).toHaveTextContent('yes'))
    await dispatchDesktopEnvironmentLink(linkedEnvironment)
    expect(screen.getByTestId('pending-environment')).toHaveTextContent(
      linkedEnvironment.externalRestApiBaseUrl
    )

    const stateBeforeConfirmation = await runtimeConfigModule!.getDesktopRuntimeConfigState()
    let finishRefresh: ((state: DesktopRuntimeConfigState) => void) | undefined
    mocks.getRuntimeConfigState.mockClear()
    mocks.getRuntimeConfigState.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finishRefresh = resolve
        })
    )
    mocks.saveRuntimeConfig.mockImplementationOnce(async config => {
      await runtimeConfigModule!.saveDesktopRuntimeConfig({
        ...config,
        rpcProxyBaseUrl: 'https://rpc.new-api.example.test',
      })
      return runtimeConfigModule!.getDesktopRuntimeConfigState()
    })

    let confirmation: Promise<void> | undefined
    await act(async () => {
      confirmation = confirmDesktopEnvironmentSetupForTest?.()
      await Promise.resolve()
    })
    await waitFor(() => expect(finishRefresh).toBeTypeOf('function'))

    let finishLogin!: (result: {
      token: string
      me: {
        id: string
        email: string
        name: string
        picture: null
        teamId: string
        teamName: string
        role: string
      }
    }) => void
    let reportLoginStarted!: () => void
    const loginStarted = new Promise<void>(resolve => {
      reportLoginStarted = resolve
    })
    const loginResult = new Promise<{
      token: string
      me: {
        id: string
        email: string
        name: string
        picture: null
        teamId: string
        teamName: string
        role: string
      }
    }>(resolve => {
      finishLogin = resolve
    })
    const native = nativeAppService as unknown as {
      authClient: {
        passwordLogin: ReturnType<typeof vi.fn>
        getMe: ReturnType<typeof vi.fn>
      }
      tokenStore: { setSessionToken: ReturnType<typeof vi.fn> }
    }
    native.authClient = {
      passwordLogin: vi.fn(() => {
        reportLoginStarted()
        return loginResult
      }),
      getMe: vi.fn().mockResolvedValue({
        id: 'refresh-race-user',
        email: 'refresh-race@example.test',
        name: 'Refresh Race User',
        picture: null,
        teamId: 'team-b',
        teamName: 'Team B',
        role: 'member',
      }),
    }
    native.tokenStore.setSessionToken = vi.fn().mockResolvedValue(undefined)
    let login!: Promise<unknown>
    await act(async () => {
      login = nativeAppService!.passwordLogin('refresh-race@example.test', 'synthetic-password')
      await loginStarted
    })
    finishRefresh?.(await runtimeConfigModule!.getDesktopRuntimeConfigState())
    await act(async () => confirmation)

    finishLogin({
      token: testSessionTokenWithExpiry(),
      me: {
        id: 'refresh-race-user',
        email: 'refresh-race@example.test',
        name: 'Refresh Race User',
        picture: null,
        teamId: 'team-b',
        teamName: 'Team B',
        role: 'member',
      },
    })
    await act(async () => login)
    await act(async () => setAuthenticatedForTest?.(true))

    const saveRuntimeConfigCallCount = mocks.saveRuntimeConfig.mock.calls.length
    mocks.saveRuntimeConfig.mockReset()
    const finalState = await runtimeConfigModule!.getDesktopRuntimeConfigState()
    expect(saveRuntimeConfigCallCount).toBe(0)
    expect(mocks.selectRuntimeConfig).not.toHaveBeenCalled()
    expect(mocks.selectRuntimeConfigForHandoff).not.toHaveBeenCalled()
    expect(finalState.activeOptionId).toBe(stateBeforeConfirmation.activeOptionId)
    expect(
      finalState.options.some(
        option => option.externalRestApiBaseUrl === linkedEnvironment.externalRestApiBaseUrl
      )
    ).toBe(false)
    expect(screen.getByTestId('is-authenticated')).toHaveTextContent('yes')
    expect(screen.getByTestId('pending-environment')).toHaveTextContent('none')
    expect(mocks.setStatus).toHaveBeenLastCalledWith(
      'The desktop session changed while processing this link. Open it again.',
      'info'
    )
  })

  it('rejects a same-origin REST path conflict added before setup confirmation', async () => {
    const linkedEnvironment = {
      appName: 'New tenant',
      externalRestApiBaseUrl: 'https://new-api.example.test/api/v1',
    }
    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('configuration-loaded')).toHaveTextContent('yes'))
    await dispatchDesktopEnvironmentLink(linkedEnvironment)
    expect(screen.getByTestId('pending-environment')).toHaveTextContent(
      linkedEnvironment.externalRestApiBaseUrl
    )

    await runtimeConfigModule!.saveDesktopRuntimeConfig({
      appName: 'Other API path',
      externalRestApiBaseUrl: 'https://new-api.example.test/api/v2',
      rpcProxyBaseUrl: 'https://rpc.new-api.example.test',
    })
    mocks.setStatus.mockClear()

    await act(async () => confirmDesktopEnvironmentSetupForTest?.())

    expect(mocks.saveRuntimeConfig).not.toHaveBeenCalled()
    expect(screen.getByTestId('pending-environment')).toHaveTextContent('none')
    expect(mocks.setStatus).toHaveBeenCalledWith(
      'Desktop setup link rejected because this REST host is already saved with a different API endpoint.',
      'error'
    )
  })

  it('asks the user to sign out when native desktop setup rejects an active session', async () => {
    mocks.completeDesktopSetup.mockRejectedValue(
      wrapLikeElectronIpc('auth:completeDesktopSetup', new Error('desktop_setup_requires_signout'))
    )
    render(<Probe />)

    await waitFor(() => expect(desktopSetupTokenListener).toBeTypeOf('function'))
    await act(async () => {
      desktopSetupTokenListener?.({
        email: 'user@example.test',
        authorizationToken: 'synthetic-setup-token',
      })
    })

    await waitFor(() =>
      expect(mocks.setStatus).toHaveBeenCalledWith(
        'Sign out before setting up another desktop environment.',
        'error'
      )
    )
  })

  it('explains an authentication transition when desktop setup is temporarily blocked', async () => {
    mocks.completeDesktopSetup.mockRejectedValue(
      wrapLikeElectronIpc('auth:completeDesktopSetup', new Error('auth_transition_in_progress'))
    )
    render(<Probe />)

    await waitFor(() => expect(desktopSetupTokenListener).toBeTypeOf('function'))
    await act(async () => {
      desktopSetupTokenListener?.({
        email: 'user@example.test',
        authorizationToken: 'synthetic-setup-token',
      })
    })

    await waitFor(() =>
      expect(mocks.setStatus).toHaveBeenCalledWith(
        'Finish the current authentication action, then try desktop setup again.',
        'error'
      )
    )
  })

  it('explains when the desktop session changes during setup', async () => {
    mocks.completeDesktopSetup.mockRejectedValue(
      wrapLikeElectronIpc('auth:completeDesktopSetup', new Error('stale_session_generation'))
    )
    render(<Probe />)

    await waitFor(() => expect(desktopSetupTokenListener).toBeTypeOf('function'))
    await act(async () => {
      desktopSetupTokenListener?.({
        email: 'user@example.test',
        authorizationToken: 'synthetic-setup-token',
      })
    })

    await waitFor(() =>
      expect(mocks.setStatus).toHaveBeenCalledWith(
        'The desktop session changed while setup was in progress. Try desktop setup again.',
        'error'
      )
    )
  })

  it('switches to a saved environment matching its REST endpoint', async () => {
    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('configuration-loaded')).toHaveTextContent('yes'))
    const targetOptionId = await savedTargetOptionId()
    const generationBeforeHandoff = nativeAppService!.getSessionGeneration()
    mocks.loadSession.mockClear()

    await dispatchDesktopEnvironmentLink({
      ...targetEnvironment,
      externalRestApiBaseUrl: `${targetEnvironment.externalRestApiBaseUrl}/api/v1`,
    })

    expect(mocks.selectRuntimeConfigForHandoff).toHaveBeenCalledWith(
      targetOptionId,
      generationBeforeHandoff
    )
    expect(mocks.clearQueryCache).toHaveBeenCalledOnce()
    expect(mocks.loadSession).toHaveBeenCalledWith({ preserveNav: true })
    expect(screen.getByTestId('pending-environment')).toHaveTextContent('none')
    expect(nativeAppService!.getRuntimeConfigState().activeOptionId).toBe(targetOptionId)
    expect(screen.getByTestId('active-rest')).toHaveTextContent(
      `${targetEnvironment.externalRestApiBaseUrl}/api/v1`
    )
    expect(mocks.setStatus.mock.calls.filter(([, tone]) => tone === 'success')).toEqual([
      [
        'Environment selected: Example tenant (api.example.test).',
        'success',
        undefined,
        { global: false, toast: true },
      ],
    ])
  })

  it('preserves successful manual selection feedback through the native producer', async () => {
    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('configuration-loaded')).toHaveTextContent('yes'))
    const targetOptionId = await savedTargetOptionId()
    mocks.selectRuntimeConfig.mockImplementationOnce(id =>
      nativeAppService!.selectRuntimeConfig(id)
    )
    mocks.setStatus.mockClear()

    await act(async () => {
      await selectRuntimeConfigForTest?.(targetOptionId)
    })

    expect(nativeAppService!.getRuntimeConfigState().activeOptionId).toBe(targetOptionId)
    expect(screen.getByTestId('active-environment')).toHaveTextContent(targetOptionId)
    expect(mocks.clearQueryCache).toHaveBeenCalledOnce()
    expect(mocks.selectRuntimeConfigForHandoff).not.toHaveBeenCalled()
    expect(mocks.setStatus.mock.calls.filter(([, tone]) => tone === 'success')).toEqual([
      [
        'Environment selected: Example tenant (api.example.test).',
        'success',
        undefined,
        { global: false, toast: true },
      ],
    ])
  })

  it('retains a verified native selection when subsequent session loading fails', async () => {
    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('configuration-loaded')).toHaveTextContent('yes'))
    const targetOptionId = await savedTargetOptionId()
    mocks.loadSession.mockRejectedValueOnce(new Error('fixture session unavailable'))

    await dispatchDesktopEnvironmentLink({
      ...targetEnvironment,
      externalRestApiBaseUrl: `${targetEnvironment.externalRestApiBaseUrl}/api/v1`,
    })

    expect(nativeAppService!.getRuntimeConfigState().activeOptionId).toBe(targetOptionId)
    expect(mocks.selectRuntimeConfigForHandoff).toHaveBeenCalledOnce()
    expect(mocks.setStatus.mock.calls.filter(([, tone]) => tone === 'success')).toHaveLength(1)
    expect(mocks.setStatus).toHaveBeenLastCalledWith(
      'Could not load the selected desktop environment: fixture session unavailable',
      'error'
    )
    expect(screen.getByTestId('pending-environment')).toHaveTextContent('none')
  })

  it('rejects a handoff response selecting a different native profile', async () => {
    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('configuration-loaded')).toHaveTextContent('yes'))
    const otherOptionId = nativeAppService!.getRuntimeConfigState().activeOptionId
    if (!otherOptionId) throw new Error('The config producer did not return the active profile')
    mocks.selectRuntimeConfigForHandoff.mockImplementationOnce((_id, generation) =>
      nativeAppService!.selectRuntimeConfigForHandoff(otherOptionId, generation)
    )
    mocks.loadSession.mockClear()

    await dispatchDesktopEnvironmentLink({
      ...targetEnvironment,
      externalRestApiBaseUrl: `${targetEnvironment.externalRestApiBaseUrl}/api/v1`,
    })

    expect(nativeAppService!.getRuntimeConfigState().activeOptionId).toBe(otherOptionId)
    expect(mocks.loadSession).not.toHaveBeenCalled()
    expect(mocks.setStatus.mock.calls.filter(([, tone]) => tone === 'success')).toEqual([])
    expect(mocks.setStatus).toHaveBeenLastCalledWith(
      'Failed to switch environment: Selected desktop environment does not match the requested saved profile.',
      'error'
    )
    expect(screen.getByTestId('pending-environment')).toHaveTextContent('none')
  })

  it('does not load a saved environment when generation changes after selection', async () => {
    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('configuration-loaded')).toHaveTextContent('yes'))
    const targetOptionId = await savedTargetOptionId()
    const initialGeneration = nativeAppService!.getSessionGeneration()
    const otherOption = (await runtimeConfigModule!.getDesktopRuntimeConfigState()).options.find(
      option => option.id !== targetOptionId && option.id !== '__localhost__'
    )
    if (!otherOption) throw new Error('The runtime config producer did not return a second profile')
    mocks.loadSession.mockClear()
    mocks.selectRuntimeConfigForHandoff.mockImplementationOnce(
      async (optionId: string, expectedGeneration: number) => {
        const selection = await nativeAppService!.selectRuntimeConfigForHandoff(
          optionId,
          expectedGeneration
        )
        await nativeAppService!.selectRuntimeConfigForHandoff(
          otherOption.id,
          selection.sessionGeneration
        )
        return selection
      }
    )

    await dispatchDesktopEnvironmentLink({
      ...targetEnvironment,
      externalRestApiBaseUrl: `${targetEnvironment.externalRestApiBaseUrl}/api/v1`,
    })

    expect(mocks.selectRuntimeConfigForHandoff).toHaveBeenCalledWith(
      targetOptionId,
      initialGeneration
    )
    expect(mocks.loadSession).not.toHaveBeenCalled()
    expect(screen.getByTestId('pending-environment')).toHaveTextContent('none')
    expect(nativeAppService!.getRuntimeConfigState().activeOptionId).toBe(otherOption.id)
    expect(mocks.setStatus.mock.calls.filter(([, tone]) => tone === 'success')).toEqual([])
    expect(mocks.setStatus).toHaveBeenCalledWith(
      'The desktop session changed while processing this link. Open it again.',
      'info'
    )
  })

  it('opens the active matching environment without prompting for setup', async () => {
    const targetOptionId = await savedTargetOptionId()
    await runtimeConfigModule!.selectDesktopRuntimeConfigOption(targetOptionId)

    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('configuration-loaded')).toHaveTextContent('yes'))
    await dispatchDesktopEnvironmentLink({
      ...targetEnvironment,
      externalRestApiBaseUrl: `${targetEnvironment.externalRestApiBaseUrl}/api/v1`,
    })

    expect(mocks.selectRuntimeConfigForHandoff).not.toHaveBeenCalled()
    expect(screen.getByTestId('pending-environment')).toHaveTextContent('none')
    expect(mocks.setStatus).toHaveBeenCalledWith(
      'This link points to the active Evenfire Desktop environment.',
      'success'
    )
  })

  it('selects a saved environment by its REST endpoint', async () => {
    await runtimeConfigModule!.saveDesktopRuntimeConfig({
      ...targetEnvironment,
      externalRestApiBaseUrl: `${targetEnvironment.externalRestApiBaseUrl}/api/v1`,
      rpcProxyBaseUrl: `${targetRpcProxyBaseUrl}/rpc`,
    })
    const state = await runtimeConfigModule!.getDesktopRuntimeConfigState()
    const otherOption = state.options.find(
      option => option.externalRestApiBaseUrl === otherEnvironment.externalRestApiBaseUrl
    )
    if (!otherOption) throw new Error('The runtime config producer did not return the other target')
    await runtimeConfigModule!.selectDesktopRuntimeConfigOption(otherOption.id)

    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('configuration-loaded')).toHaveTextContent('yes'))
    const generationBeforeHandoff = nativeAppService!.getSessionGeneration()
    await dispatchDesktopEnvironmentLink({
      ...targetEnvironment,
      externalRestApiBaseUrl: `${targetEnvironment.externalRestApiBaseUrl}/api/v1`,
    })

    expect(mocks.selectRuntimeConfigForHandoff).toHaveBeenCalledWith(
      await savedTargetOptionId(),
      generationBeforeHandoff
    )
    expect(screen.getByTestId('pending-environment')).toHaveTextContent('none')
    expect(screen.getByTestId('pending-rpc')).toHaveTextContent('none')
    expect(
      (await runtimeConfigModule!.getDesktopRuntimeConfigState()).options.find(
        option =>
          option.externalRestApiBaseUrl === `${targetEnvironment.externalRestApiBaseUrl}/api/v1`
      )?.rpcProxyBaseUrl
    ).toBe(`${targetRpcProxyBaseUrl}/rpc`)
  })

  it('selects a saved REST profile without saving or rediscovering its RPC when the link omits RPC', async () => {
    await runtimeConfigModule!.saveDesktopRuntimeConfig({
      ...targetEnvironment,
      appName: 'Example base API',
      rpcProxyBaseUrl: targetRpcProxyBaseUrl,
    })
    const state = await runtimeConfigModule!.getDesktopRuntimeConfigState()
    const pathBasedTarget = state.options.find(
      option =>
        option.externalRestApiBaseUrl === `${targetEnvironment.externalRestApiBaseUrl}/api/v1`
    )
    if (!pathBasedTarget)
      throw new Error('The config producer did not return the path-based target')
    await runtimeConfigModule!.deleteDesktopRuntimeConfigOption(pathBasedTarget.id)

    const savedTarget = (await runtimeConfigModule!.getDesktopRuntimeConfigState()).options.find(
      option =>
        option.externalRestApiBaseUrl === targetEnvironment.externalRestApiBaseUrl &&
        option.rpcProxyBaseUrl === targetRpcProxyBaseUrl
    )
    if (!savedTarget) throw new Error('The config producer did not return the saved REST profile')
    // The frozen Date.now value makes the historical slug+timestamp collision
    // deterministic. Deleting one profile must never remove its same-name peer.
    expect(savedTarget.id).not.toBe(pathBasedTarget.id)
    const other = (await runtimeConfigModule!.getDesktopRuntimeConfigState()).options.find(
      option => option.id !== savedTarget.id && option.id !== '__localhost__'
    )
    if (!other) throw new Error('The config producer did not return the other saved profile')
    await runtimeConfigModule!.selectDesktopRuntimeConfigOption(other.id)

    const { AppService } = await import('../../../../../src/appService')
    const service = new AppService()
    const serviceInternals = service as unknown as {
      authClient: { getDesktopEnvironment: ReturnType<typeof vi.fn> }
      applyRuntimeEnvironmentChange: (operation: () => Promise<void>) => Promise<void>
      saveRuntimeConfig: typeof service.saveRuntimeConfig
    }
    serviceInternals.authClient = {
      getDesktopEnvironment: vi.fn().mockResolvedValue({
        externalRestApiBaseUrl: targetEnvironment.externalRestApiBaseUrl,
        rpcProxyBaseUrl: 'https://rpc.untrusted-discovery.test',
        appName: 'Discovered tenant',
      }),
    }
    serviceInternals.applyRuntimeEnvironmentChange = operation => operation()
    mocks.saveRuntimeConfig.mockImplementation(serviceInternals.saveRuntimeConfig.bind(service))

    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('configuration-loaded')).toHaveTextContent('yes'))
    const generationBeforeHandoff = nativeAppService!.getSessionGeneration()
    await dispatchDesktopEnvironmentLink(targetEnvironment)

    await act(async () => {
      await confirmDesktopEnvironmentSetupForTest?.()
    })

    const finalState = await runtimeConfigModule!.getDesktopRuntimeConfigState()
    expect(finalState.options.find(option => option.id === savedTarget.id)).toMatchObject({
      externalRestApiBaseUrl: targetEnvironment.externalRestApiBaseUrl,
      rpcProxyBaseUrl: targetRpcProxyBaseUrl,
      appName: 'Example base API',
    })
    expect(serviceInternals.authClient.getDesktopEnvironment).not.toHaveBeenCalled()
    expect(mocks.saveRuntimeConfig).not.toHaveBeenCalled()
    expect(mocks.selectRuntimeConfigForHandoff).toHaveBeenCalledWith(
      savedTarget.id,
      generationBeforeHandoff
    )
    expect(finalState.activeOptionId).toBe(savedTarget.id)
    expect(screen.getByTestId('pending-environment')).toHaveTextContent('none')
  })

  it('rechecks saved REST profiles when setup is confirmed', async () => {
    const linkedEnvironment = {
      appName: 'New tenant',
      externalRestApiBaseUrl: 'https://new-api.example.test',
    }
    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('configuration-loaded')).toHaveTextContent('yes'))
    await dispatchDesktopEnvironmentLink(linkedEnvironment)
    expect(screen.getByTestId('pending-environment')).toHaveTextContent(
      linkedEnvironment.externalRestApiBaseUrl
    )

    await runtimeConfigModule!.saveDesktopRuntimeConfig({
      ...linkedEnvironment,
      rpcProxyBaseUrl: 'https://rpc.new-api.example.test',
    })
    const savedOption = (await runtimeConfigModule!.getDesktopRuntimeConfigState()).options.find(
      option => option.externalRestApiBaseUrl === linkedEnvironment.externalRestApiBaseUrl
    )
    if (!savedOption) throw new Error('The config producer did not return the newly saved profile')
    const currentOption = (await runtimeConfigModule!.getDesktopRuntimeConfigState()).options.find(
      option => option.externalRestApiBaseUrl === otherEnvironment.externalRestApiBaseUrl
    )
    if (!currentOption) throw new Error('The config producer did not return the current profile')
    await runtimeConfigModule!.selectDesktopRuntimeConfigOption(currentOption.id)
    const generationBeforeConfirmation = nativeAppService!.getSessionGeneration()

    await act(async () => {
      await confirmDesktopEnvironmentSetupForTest?.()
    })

    expect(mocks.saveRuntimeConfig).not.toHaveBeenCalled()
    expect(mocks.selectRuntimeConfig).not.toHaveBeenCalled()
    expect(mocks.selectRuntimeConfigForHandoff).toHaveBeenCalledWith(
      savedOption.id,
      generationBeforeConfirmation
    )
    expect(screen.getByTestId('pending-environment')).toHaveTextContent('none')
    expect((await runtimeConfigModule!.getDesktopRuntimeConfigState()).activeOptionId).toBe(
      savedOption.id
    )
    expect(screen.getByTestId('active-environment')).toHaveTextContent(savedOption.id)
    expect(screen.getByTestId('active-rest')).toHaveTextContent(
      linkedEnvironment.externalRestApiBaseUrl
    )
    expect(mocks.setStatus.mock.calls.filter(([, tone]) => tone === 'success')).toEqual([
      [
        'Environment selected: New tenant (new-api.example.test).',
        'success',
        undefined,
        { global: false, toast: true },
      ],
    ])
  })

  it('keeps the exact active REST profile when a same-origin sibling appears before confirmation', async () => {
    const linkedEnvironment = {
      appName: 'Acme Corp, verified secure workspace with an unbounded link-provided label',
      externalRestApiBaseUrl: 'https://new-api.example.test/api/v1',
    }
    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('configuration-loaded')).toHaveTextContent('yes'))
    await dispatchDesktopEnvironmentLink(linkedEnvironment)
    expect(screen.getByTestId('pending-environment')).toHaveTextContent(
      linkedEnvironment.externalRestApiBaseUrl
    )

    await runtimeConfigModule!.saveDesktopRuntimeConfig({
      appName: 'Active target',
      externalRestApiBaseUrl: linkedEnvironment.externalRestApiBaseUrl,
      rpcProxyBaseUrl: 'https://rpc.new-api.example.test/v1',
    })
    await runtimeConfigModule!.saveDesktopRuntimeConfig({
      appName: 'Sibling target',
      externalRestApiBaseUrl: 'https://new-api.example.test/api/v2',
      rpcProxyBaseUrl: 'https://rpc.new-api.example.test/v2',
    })
    const state = await runtimeConfigModule!.getDesktopRuntimeConfigState()
    const exactTarget = state.options.find(
      option => option.externalRestApiBaseUrl === linkedEnvironment.externalRestApiBaseUrl
    )
    if (!exactTarget) throw new Error('The config producer did not return the exact REST profile')
    await runtimeConfigModule!.selectDesktopRuntimeConfigOption(exactTarget.id)

    await act(async () => {
      await confirmDesktopEnvironmentSetupForTest?.()
    })

    expect(mocks.saveRuntimeConfig).not.toHaveBeenCalled()
    expect(mocks.selectRuntimeConfig).not.toHaveBeenCalled()
    expect(screen.getByTestId('pending-environment')).toHaveTextContent('none')
    expect(mocks.setStatus).toHaveBeenLastCalledWith(
      'This link points to the active Evenfire Desktop environment.',
      'success'
    )
  })

  it('does not let runtime discovery overwrite another saved REST profile', async () => {
    const setupEnvironment = {
      appName: 'Setup tenant',
      externalRestApiBaseUrl: 'https://setup-api.example.test',
      rpcProxyBaseUrl: '',
    }
    await runtimeConfigModule!.saveDesktopRuntimeConfig(setupEnvironment)
    const setupOption = (await runtimeConfigModule!.getDesktopRuntimeConfigState()).options.find(
      option => option.externalRestApiBaseUrl === setupEnvironment.externalRestApiBaseUrl
    )
    const discoveryTarget = (
      await runtimeConfigModule!.getDesktopRuntimeConfigState()
    ).options.find(
      option => option.externalRestApiBaseUrl === otherEnvironment.externalRestApiBaseUrl
    )
    if (!setupOption || !discoveryTarget) {
      throw new Error('The config producer did not return the test profiles')
    }
    await runtimeConfigModule!.selectDesktopRuntimeConfigOption(setupOption.id)

    const { AppService } = await import('../../../../../src/appService')
    const service = new AppService()
    const serviceInternals = service as unknown as {
      authClient: { getDesktopEnvironment: ReturnType<typeof vi.fn> }
      applyRuntimeEnvironmentChange: (operation: () => Promise<void>) => Promise<void>
      saveRuntimeConfig: typeof service.saveRuntimeConfig
    }
    serviceInternals.authClient = {
      getDesktopEnvironment: vi.fn().mockResolvedValue({
        externalRestApiBaseUrl: otherEnvironment.externalRestApiBaseUrl,
        rpcProxyBaseUrl: 'https://rpc.overwrite.test',
        appName: 'Overwritten tenant',
      }),
    }
    serviceInternals.applyRuntimeEnvironmentChange = operation => operation()

    await service.saveRuntimeConfig(setupEnvironment)

    const finalState = await runtimeConfigModule!.getDesktopRuntimeConfigState()
    expect(serviceInternals.authClient.getDesktopEnvironment).toHaveBeenCalledOnce()
    expect(finalState.activeOptionId).toBe(setupOption.id)
    expect(finalState.options.find(option => option.id === discoveryTarget.id)).toMatchObject({
      externalRestApiBaseUrl: otherEnvironment.externalRestApiBaseUrl,
      rpcProxyBaseUrl: otherEnvironment.rpcProxyBaseUrl,
      appName: otherEnvironment.appName,
    })
  })

  it('does not report setup complete when discovery returns another REST origin', async () => {
    const linkedEnvironment = {
      appName: 'New tenant',
      externalRestApiBaseUrl: 'https://new-api.example.test',
    }
    const { AppService } = await import('../../../../../src/appService')
    const service = new AppService()
    const serviceInternals = service as unknown as {
      authClient: { getDesktopEnvironment: ReturnType<typeof vi.fn> }
      applyRuntimeEnvironmentChange: (operation: () => Promise<void>) => Promise<void>
      saveRuntimeConfig: typeof service.saveRuntimeConfig
    }
    serviceInternals.authClient = {
      getDesktopEnvironment: vi.fn().mockResolvedValue({
        externalRestApiBaseUrl: otherEnvironment.externalRestApiBaseUrl,
        rpcProxyBaseUrl: 'https://rpc.overwrite.test',
        appName: 'Other tenant',
      }),
    }
    mocks.saveRuntimeConfig.mockImplementation(serviceInternals.saveRuntimeConfig.bind(service))

    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('configuration-loaded')).toHaveTextContent('yes'))
    await dispatchDesktopEnvironmentLink(linkedEnvironment)
    await act(async () => {
      await confirmDesktopEnvironmentSetupForTest?.()
    })

    const finalState = await runtimeConfigModule!.getDesktopRuntimeConfigState()
    const savedTarget = finalState.options.find(
      option => option.externalRestApiBaseUrl === linkedEnvironment.externalRestApiBaseUrl
    )
    const existingOther = finalState.options.find(
      option => option.externalRestApiBaseUrl === otherEnvironment.externalRestApiBaseUrl
    )
    expect(serviceInternals.authClient.getDesktopEnvironment).toHaveBeenCalledOnce()
    expect(finalState.activeOptionId).toBe(savedTarget?.id)
    expect(savedTarget?.rpcProxyBaseUrl).toBe('')
    expect(existingOther).toMatchObject(otherEnvironment)
    expect(screen.getByTestId('setup-complete')).toHaveTextContent('no')
    expect(screen.getByTestId('pending-environment')).toHaveTextContent('none')
    expect(mocks.setStatus).toHaveBeenLastCalledWith(
      'Desktop environment setup could not verify the confirmed REST and RPC endpoints.',
      'error'
    )
  })

  it('does not announce an unverified linked setup or echo its untrusted label', async () => {
    const linkedEnvironment = {
      appName: 'Unverified Tenant Name',
      externalRestApiBaseUrl: 'https://new-api.example.test',
    }
    mocks.saveRuntimeConfig.mockImplementationOnce(async config => {
      await runtimeConfigModule!.saveDesktopRuntimeConfig({ ...config, rpcProxyBaseUrl: '' })
      return runtimeConfigModule!.getDesktopRuntimeConfigState()
    })
    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('configuration-loaded')).toHaveTextContent('yes'))
    await dispatchDesktopEnvironmentLink(linkedEnvironment)

    await act(async () => confirmDesktopEnvironmentSetupForTest?.())

    expect(mocks.setStatus).toHaveBeenLastCalledWith(
      'Desktop environment setup could not verify the confirmed REST and RPC endpoints.',
      'error'
    )
    expect(mocks.setStatus.mock.calls.some(([, tone]) => tone === 'success')).toBe(false)
    expect(mocks.setStatus.mock.calls).not.toContainEqual(
      expect.arrayContaining([expect.stringContaining(linkedEnvironment.appName)])
    )
    expect(screen.getByTestId('setup-complete')).toHaveTextContent('no')
  })

  it('clears linked setup confirmation when saving hits an auth transition', async () => {
    mocks.saveRuntimeConfig.mockRejectedValueOnce(
      wrapLikeElectronIpc('auth:saveRuntimeConfig', new Error('auth_transition_in_progress'))
    )
    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('configuration-loaded')).toHaveTextContent('yes'))
    await dispatchDesktopEnvironmentLink({
      appName: 'Linked tenant',
      externalRestApiBaseUrl: 'https://new-api.example.test',
    })
    expect(screen.getByTestId('pending-environment')).toHaveTextContent(
      'https://new-api.example.test'
    )

    await act(async () => confirmDesktopEnvironmentSetupForTest?.())

    expect(screen.getByTestId('pending-environment')).toHaveTextContent('none')
    expect(mocks.setStatus).toHaveBeenCalledWith(
      'Finish the current authentication action, then reopen this desktop link.',
      'info'
    )
  })

  it('clears linked setup confirmation when confirmation meets an auth operation', async () => {
    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('configuration-loaded')).toHaveTextContent('yes'))
    await dispatchDesktopEnvironmentLink({
      appName: 'Linked tenant',
      externalRestApiBaseUrl: 'https://new-api.example.test',
    })
    expect(screen.getByTestId('pending-environment')).toHaveTextContent(
      'https://new-api.example.test'
    )
    await act(async () => setBootingForTest?.(true))

    await act(async () => confirmDesktopEnvironmentSetupForTest?.())

    expect(screen.getByTestId('pending-environment')).toHaveTextContent('none')
    expect(mocks.setStatus).toHaveBeenCalledWith(
      'Finish the current authentication action, then reopen this desktop link.',
      'info'
    )
  })

  it('leaves RPC discovery to the backend for a REST-only environment link', async () => {
    const linkedEnvironment = {
      appName: 'New tenant',
      externalRestApiBaseUrl: 'https://new-api.example.test',
    }

    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('configuration-loaded')).toHaveTextContent('yes'))
    await dispatchDesktopEnvironmentLink(linkedEnvironment)

    expect(screen.getByTestId('pending-environment')).toHaveTextContent(
      linkedEnvironment.externalRestApiBaseUrl
    )
    expect(screen.getByTestId('pending-rpc')).toHaveTextContent('none')
  })

  it('reports a stale native environment selection instead of silently stopping', async () => {
    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('configuration-loaded')).toHaveTextContent('yes'))
    mocks.loadSession.mockClear()
    mocks.selectRuntimeConfigForHandoff.mockRejectedValueOnce(
      wrapLikeElectronIpc(
        'auth:selectRuntimeConfigForHandoff',
        new Error('stale_session_generation')
      )
    )

    await dispatchDesktopEnvironmentLink({
      ...targetEnvironment,
      externalRestApiBaseUrl: `${targetEnvironment.externalRestApiBaseUrl}/api/v1`,
    })

    expect(mocks.setStatus).toHaveBeenCalledWith(
      'The desktop session changed while processing this link. Open it again.',
      'info'
    )
    expect(mocks.loadSession).not.toHaveBeenCalled()
  })

  it('keeps a fresh login and rejects a stale environment setup confirmation', async () => {
    const linkedEnvironment = {
      appName: 'Linked target',
      externalRestApiBaseUrl: 'https://new-api.example.test/api/v1',
    }
    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('configuration-loaded')).toHaveTextContent('yes'))
    await dispatchDesktopEnvironmentLink(linkedEnvironment)
    expect(screen.getByTestId('pending-environment')).toHaveTextContent(
      linkedEnvironment.externalRestApiBaseUrl
    )

    await runtimeConfigModule!.saveDesktopRuntimeConfig({
      ...linkedEnvironment,
      rpcProxyBaseUrl: 'https://rpc.new-api.example.test',
    })
    const otherOption = (await runtimeConfigModule!.getDesktopRuntimeConfigState()).options.find(
      option => option.externalRestApiBaseUrl === otherEnvironment.externalRestApiBaseUrl
    )
    if (!otherOption) throw new Error('The config producer did not return the current profile')
    await runtimeConfigModule!.selectDesktopRuntimeConfigOption(otherOption.id)

    const app = nativeAppService as unknown as {
      authClient: {
        passwordLogin: ReturnType<typeof vi.fn>
        getMe: ReturnType<typeof vi.fn>
      }
      tokenStore: { setSessionToken: ReturnType<typeof vi.fn> }
    }
    app.authClient = {
      passwordLogin: vi.fn().mockResolvedValue({
        token: testSessionTokenWithExpiry(),
        me: {
          id: 'user-a',
          email: 'user-a@example.test',
          name: 'User A',
          picture: null,
          teamId: 'team-a',
          teamName: 'Team A',
          role: 'member',
        },
      }),
      getMe: vi.fn().mockResolvedValue({
        id: 'user-a',
        email: 'user-a@example.test',
        name: 'User A',
        picture: null,
        teamId: 'team-a',
        teamName: 'Team A',
        role: 'member',
      }),
    }
    app.tokenStore.setSessionToken = vi.fn().mockResolvedValue(undefined)
    await nativeAppService!.passwordLogin('user-a@example.test', 'synthetic-password')
    await act(async () => sessionStateChangedListener?.())
    expect(screen.getByTestId('is-authenticated')).toHaveTextContent('yes')
    mocks.setStatus.mockClear()

    await act(async () => confirmDesktopEnvironmentSetupForTest?.())

    expect(mocks.selectRuntimeConfigForHandoff).not.toHaveBeenCalled()
    expect(screen.getByTestId('pending-environment')).toHaveTextContent('none')
    expect(mocks.setStatus).toHaveBeenLastCalledWith(
      'The desktop session changed while processing this link. Open it again.',
      'info'
    )
  })

  it('does not let a desktop link select the built-in Localhost environment', async () => {
    const state = await runtimeConfigModule!.getDesktopRuntimeConfigState()
    const localhostOption = state.options.find(option => option.id === '__localhost__')
    if (!localhostOption) throw new Error('The runtime config producer did not return Localhost')

    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('configuration-loaded')).toHaveTextContent('yes'))
    await dispatchDesktopEnvironmentLink({
      appName: localhostOption.appName,
      externalRestApiBaseUrl: localhostOption.externalRestApiBaseUrl,
    })

    expect(mocks.selectRuntimeConfigForHandoff).not.toHaveBeenCalled()
    expect(screen.getByTestId('pending-environment')).toHaveTextContent('none')
    expect(mocks.setStatus).toHaveBeenCalledWith(
      expect.stringMatching(/Localhost.*cannot be opened from a link/i),
      'error'
    )
  })

  it('does not offer setup when the saved environment list cannot be verified', async () => {
    mocks.getRuntimeConfigState.mockImplementationOnce(async () =>
      runtimeConfigModule!.getDesktopRuntimeConfigState()
    )
    mocks.getRuntimeConfigState.mockRejectedValueOnce(new Error('IPC unavailable'))

    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('configuration-loaded')).toHaveTextContent('yes'))
    await dispatchDesktopEnvironmentLink()

    expect(mocks.selectRuntimeConfigForHandoff).not.toHaveBeenCalled()
    expect(screen.getByTestId('pending-environment')).toHaveTextContent('none')
    expect(mocks.setStatus).toHaveBeenCalledWith(
      'Could not verify the desktop environment. Try opening it again.',
      'error'
    )
  })

  it('clears a pending setup confirmation when its configuration refresh fails', async () => {
    const linkedEnvironment = {
      appName: 'New tenant',
      externalRestApiBaseUrl: 'https://new-api.example.test/api/v1',
    }
    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('configuration-loaded')).toHaveTextContent('yes'))
    await dispatchDesktopEnvironmentLink(linkedEnvironment)
    expect(screen.getByTestId('pending-environment')).toHaveTextContent(
      linkedEnvironment.externalRestApiBaseUrl
    )

    mocks.getRuntimeConfigState.mockRejectedValueOnce(new Error('IPC unavailable'))
    await act(async () => confirmDesktopEnvironmentSetupForTest?.())

    await waitFor(() => expect(screen.getByTestId('pending-environment')).toHaveTextContent('none'))
    expect(mocks.setStatus).toHaveBeenCalledWith(
      'Could not verify the desktop environment. Try opening it again.',
      'error'
    )
  })

  it('rejects a REST API path when another path on the same host is saved', async () => {
    const linkedEnvironment = {
      appName: 'API v2 tenant',
      externalRestApiBaseUrl: `${targetEnvironment.externalRestApiBaseUrl}/api/v2`,
    }
    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('configuration-loaded')).toHaveTextContent('yes'))
    await dispatchDesktopEnvironmentLink(linkedEnvironment)
    expect(screen.getByTestId('pending-environment')).toHaveTextContent('none')
    expect(mocks.saveRuntimeConfig).not.toHaveBeenCalled()
    expect(mocks.setStatus).toHaveBeenCalledWith(
      'Desktop setup link rejected because this REST host is already saved with a different API endpoint.',
      'error'
    )
  })
})
