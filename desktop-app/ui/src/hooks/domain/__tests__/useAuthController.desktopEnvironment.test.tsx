// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { useAuthController } from '../useAuthController'
import { wrapLikeElectronIpc } from './__fixtures__/ipcErrors'

const mocks = vi.hoisted(() => ({
  clearQueryCache: vi.fn(),
  completeDesktopSetup: vi.fn(),
  getRuntimeConfigState: vi.fn(),
  getSessionGeneration: vi.fn(),
  logoutForEnvironmentMismatch: vi.fn(),
  onDesktopEnvironmentSetup: vi.fn(),
  onDesktopSetupToken: vi.fn(),
  onExternalLogout: vi.fn(),
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
  rpcProxyBaseUrl: 'https://rpc.example.test',
}

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
let confirmDesktopEnvironmentSetupForTest: (() => Promise<void>) | null = null
let confirmDesktopEnvironmentSwitchForTest: (() => void) | null = null
let cancelDesktopEnvironmentSwitchForTest: (() => void) | null = null
let setBootingForTest: ((value: boolean) => void) | null = null
let setAuthenticatedForTest: ((value: boolean) => void) | null = null
let runtimeConfigModule: typeof import('../../../../../src/config') | null = null
let runtimeConfigDirectory = ''
let nativeSessionGeneration = 0
const originalOnboardingPreview = process.env.EVENFIRE_ONBOARDING_PREVIEW
const frozenProfileIdMilliseconds = 1790000000000

function Probe() {
  const auth = useAuthController({
    setStatus: mocks.setStatus,
    onSessionNeedsLoad: mocks.loadSession,
    logoutForEnvironmentMismatch: mocks.logoutForEnvironmentMismatch,
  })
  setBootingForTest = auth.setBooting
  setAuthenticatedForTest = auth.setIsAuthenticated
  confirmDesktopEnvironmentSetupForTest = auth.handleConfirmDesktopEnvironmentSetup
  confirmDesktopEnvironmentSwitchForTest = auth.handleConfirmDesktopEnvironmentSwitchConfirmation
  cancelDesktopEnvironmentSwitchForTest = auth.handleCancelDesktopEnvironmentSwitchConfirmation

  return (
    <>
      <div data-testid="configuration-loaded">{auth.runtimeConfigState ? 'yes' : 'no'}</div>
      <div data-testid="pending-environment">
        {auth.pendingDesktopEnvironmentSetup?.externalRestApiBaseUrl || 'none'}
      </div>
      <div data-testid="pending-environment-switch">
        {auth.pendingDesktopEnvironmentSwitchConfirmation?.targetExternalRestApiBaseUrl || 'none'}
      </div>
      <div data-testid="is-authenticated">{auth.isAuthenticated ? 'yes' : 'no'}</div>
      <div data-testid="pending-rpc">
        {auth.pendingDesktopEnvironmentSetup?.rpcProxyBaseUrl || 'none'}
      </div>
      <div data-testid="setup-complete">{auth.desktopEnvironmentSetupComplete ? 'yes' : 'no'}</div>
    </>
  )
}

async function dispatchDesktopEnvironmentLink(payload = targetEnvironment) {
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
      candidate.rpcProxyBaseUrl === `${targetEnvironment.rpcProxyBaseUrl}/rpc`
  )
  if (!option) throw new Error('The runtime config producer did not return the saved target')
  return option.id
}

beforeEach(async () => {
  vi.clearAllMocks()
  vi.spyOn(Date, 'now').mockReturnValue(frozenProfileIdMilliseconds)
  desktopEnvironmentSetupListener = null
  desktopSetupTokenListener = null
  confirmDesktopEnvironmentSetupForTest = null
  confirmDesktopEnvironmentSwitchForTest = null
  cancelDesktopEnvironmentSwitchForTest = null
  setBootingForTest = null
  setAuthenticatedForTest = null
  runtimeConfigModule = null
  delete process.env.EVENFIRE_ONBOARDING_PREVIEW
  nativeSessionGeneration = 0
  runtimeConfigDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'evenfire-desktop-env-test-'))
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

  mocks.getRuntimeConfigState.mockImplementation(async () =>
    runtimeConfigModule!.getDesktopRuntimeConfigState()
  )
  mocks.selectRuntimeConfig.mockImplementation(async (optionId: string) => {
    await runtimeConfigModule!.selectDesktopRuntimeConfigOption(optionId)
    return runtimeConfigModule!.getDesktopRuntimeConfigState()
  })
  mocks.getSessionGeneration.mockImplementation(async () => nativeSessionGeneration)
  mocks.selectRuntimeConfigForHandoff.mockImplementation(
    async (optionId: string, expectedSessionGeneration: number) => {
      if (expectedSessionGeneration !== nativeSessionGeneration) {
        throw new Error('stale_session_generation')
      }
      await runtimeConfigModule!.selectDesktopRuntimeConfigOption(optionId)
      nativeSessionGeneration += 1
      return {
        runtimeConfigState: await runtimeConfigModule!.getDesktopRuntimeConfigState(),
        sessionGeneration: nativeSessionGeneration,
      }
    }
  )
  mocks.loadSession.mockImplementation(async () => setBootingForTest?.(false))
  mocks.logoutForEnvironmentMismatch.mockImplementation(async () => {
    setAuthenticatedForTest?.(false)
    nativeSessionGeneration += 1
    return nativeSessionGeneration
  })
  mocks.onDesktopSetupToken.mockImplementation(listener => {
    desktopSetupTokenListener = listener
    return () => undefined
  })
  mocks.onExternalLogout.mockReturnValue(() => undefined)
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
    },
  }
})

afterEach(async () => {
  cleanup()
  vi.restoreAllMocks()
  vi.doUnmock('electron')
  vi.resetModules()
  await fsp.rm(runtimeConfigDirectory, { recursive: true, force: true })
  if (originalOnboardingPreview === undefined) delete process.env.EVENFIRE_ONBOARDING_PREVIEW
  else process.env.EVENFIRE_ONBOARDING_PREVIEW = originalOnboardingPreview
})

describe('Desktop environment handoff', () => {
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

  it('switches to a saved environment matching its REST endpoint', async () => {
    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('configuration-loaded')).toHaveTextContent('yes'))
    const targetOptionId = await savedTargetOptionId()
    mocks.loadSession.mockClear()

    await dispatchDesktopEnvironmentLink({
      ...targetEnvironment,
      externalRestApiBaseUrl: `${targetEnvironment.externalRestApiBaseUrl}/api/v1`,
    })

    expect(mocks.selectRuntimeConfigForHandoff).toHaveBeenCalledWith(targetOptionId, 0)
    expect(mocks.clearQueryCache).toHaveBeenCalledOnce()
    expect(mocks.loadSession).toHaveBeenCalledWith({ preserveNav: true })
    expect(screen.getByTestId('pending-environment')).toHaveTextContent('none')
    expect(mocks.setStatus).toHaveBeenCalledWith(
      expect.stringContaining('Environment selected: Example tenant'),
      'success',
      undefined,
      { global: false, toast: true }
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
      'Opening Example tenant in Evenfire Desktop.',
      'success'
    )
  })

  it('selects a saved REST environment without trusting the linked RPC proxy', async () => {
    await runtimeConfigModule!.saveDesktopRuntimeConfig({
      ...targetEnvironment,
      externalRestApiBaseUrl: `${targetEnvironment.externalRestApiBaseUrl}/api/v1`,
      rpcProxyBaseUrl: `${targetEnvironment.rpcProxyBaseUrl}/rpc`,
    })
    const state = await runtimeConfigModule!.getDesktopRuntimeConfigState()
    const otherOption = state.options.find(
      option => option.externalRestApiBaseUrl === otherEnvironment.externalRestApiBaseUrl
    )
    if (!otherOption) throw new Error('The runtime config producer did not return the other target')
    await runtimeConfigModule!.selectDesktopRuntimeConfigOption(otherOption.id)

    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('configuration-loaded')).toHaveTextContent('yes'))
    await dispatchDesktopEnvironmentLink({
      ...targetEnvironment,
      externalRestApiBaseUrl: `${targetEnvironment.externalRestApiBaseUrl}/api/v1`,
      rpcProxyBaseUrl: 'https://rpc.attacker.test',
    })

    expect(mocks.selectRuntimeConfigForHandoff).toHaveBeenCalledWith(await savedTargetOptionId(), 0)
    expect(screen.getByTestId('pending-environment')).toHaveTextContent('none')
    expect(screen.getByTestId('pending-rpc')).toHaveTextContent('none')
    expect(
      (await runtimeConfigModule!.getDesktopRuntimeConfigState()).options.find(
        option =>
          option.externalRestApiBaseUrl === `${targetEnvironment.externalRestApiBaseUrl}/api/v1`
      )?.rpcProxyBaseUrl
    ).toBe(`${targetEnvironment.rpcProxyBaseUrl}/rpc`)
  })

  it('selects a saved REST profile without saving or rediscovering its RPC when the link omits RPC', async () => {
    await runtimeConfigModule!.saveDesktopRuntimeConfig({
      ...targetEnvironment,
      appName: 'Example base API',
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
        option.rpcProxyBaseUrl === targetEnvironment.rpcProxyBaseUrl
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
    await dispatchDesktopEnvironmentLink(targetEnvironment)

    await act(async () => {
      await confirmDesktopEnvironmentSetupForTest?.()
    })

    const finalState = await runtimeConfigModule!.getDesktopRuntimeConfigState()
    expect(finalState.options.find(option => option.id === savedTarget.id)).toMatchObject({
      externalRestApiBaseUrl: targetEnvironment.externalRestApiBaseUrl,
      rpcProxyBaseUrl: targetEnvironment.rpcProxyBaseUrl,
      appName: 'Example base API',
    })
    expect(serviceInternals.authClient.getDesktopEnvironment).not.toHaveBeenCalled()
    expect(mocks.saveRuntimeConfig).not.toHaveBeenCalled()
    expect(mocks.selectRuntimeConfigForHandoff).toHaveBeenCalledWith(savedTarget.id, 0)
    expect(finalState.activeOptionId).toBe(savedTarget.id)
    expect(screen.getByTestId('pending-environment')).toHaveTextContent('none')
  })

  it('rechecks saved REST profiles when setup is confirmed', async () => {
    const linkedEnvironment = {
      appName: 'New tenant',
      externalRestApiBaseUrl: 'https://new-api.example.test',
      rpcProxyBaseUrl: '',
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

    await act(async () => {
      await confirmDesktopEnvironmentSetupForTest?.()
    })

    expect(mocks.saveRuntimeConfig).not.toHaveBeenCalled()
    expect(mocks.selectRuntimeConfig).toHaveBeenCalledWith(savedOption.id)
    expect(screen.getByTestId('pending-environment')).toHaveTextContent('none')
    expect((await runtimeConfigModule!.getDesktopRuntimeConfigState()).activeOptionId).toBe(
      savedOption.id
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
      rpcProxyBaseUrl: 'https://rpc.untrusted.test',
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
    serviceInternals.applyRuntimeEnvironmentChange = operation => operation()
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

  it('does not retain an RPC proxy supplied by a new environment link', async () => {
    const linkedEnvironment = {
      appName: 'New tenant',
      externalRestApiBaseUrl: 'https://new-api.example.test',
      rpcProxyBaseUrl: 'https://rpc.attacker.test',
    }

    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('configuration-loaded')).toHaveTextContent('yes'))
    await dispatchDesktopEnvironmentLink(linkedEnvironment)

    expect(screen.getByTestId('pending-environment')).toHaveTextContent(
      linkedEnvironment.externalRestApiBaseUrl
    )
    expect(screen.getByTestId('pending-rpc')).toHaveTextContent('none')
  })

  it('keeps the current session when the user cancels a REST environment switch', async () => {
    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('configuration-loaded')).toHaveTextContent('yes'))
    await act(async () => setAuthenticatedForTest?.(true))
    mocks.logoutForEnvironmentMismatch.mockClear()
    mocks.clearQueryCache.mockClear()

    let handoff!: Promise<void>
    await act(async () => {
      handoff = Promise.resolve(
        desktopEnvironmentSetupListener!({
          ...targetEnvironment,
          externalRestApiBaseUrl: `${targetEnvironment.externalRestApiBaseUrl}/api/v1`,
        })
      )
    })
    await waitFor(() =>
      expect(screen.getByTestId('pending-environment-switch')).toHaveTextContent(
        `${targetEnvironment.externalRestApiBaseUrl}/api/v1`
      )
    )

    expect(mocks.logoutForEnvironmentMismatch).not.toHaveBeenCalled()
    expect(mocks.clearQueryCache).not.toHaveBeenCalled()
    expect(screen.getByTestId('pending-environment')).toHaveTextContent('none')

    await act(async () => cancelDesktopEnvironmentSwitchForTest?.())
    await act(async () => handoff)

    expect(mocks.logoutForEnvironmentMismatch).not.toHaveBeenCalled()
    expect(mocks.selectRuntimeConfigForHandoff).not.toHaveBeenCalled()
    expect(mocks.clearQueryCache).not.toHaveBeenCalled()
    expect(screen.getByTestId('is-authenticated')).toHaveTextContent('yes')
    expect(screen.getByTestId('pending-environment-switch')).toHaveTextContent('none')
  })

  it('does not log out a newer session after the switch confirmation is open', async () => {
    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('configuration-loaded')).toHaveTextContent('yes'))
    await act(async () => setAuthenticatedForTest?.(true))
    mocks.logoutForEnvironmentMismatch.mockClear()

    let handoff!: Promise<void>
    await act(async () => {
      handoff = Promise.resolve(
        desktopEnvironmentSetupListener!({
          ...targetEnvironment,
          externalRestApiBaseUrl: `${targetEnvironment.externalRestApiBaseUrl}/api/v1`,
        })
      )
    })
    await waitFor(() =>
      expect(screen.getByTestId('pending-environment-switch')).toHaveTextContent(
        `${targetEnvironment.externalRestApiBaseUrl}/api/v1`
      )
    )

    nativeSessionGeneration += 1
    await act(async () => confirmDesktopEnvironmentSwitchForTest?.())
    await act(async () => handoff)

    expect(mocks.logoutForEnvironmentMismatch).not.toHaveBeenCalled()
    expect(mocks.selectRuntimeConfigForHandoff).not.toHaveBeenCalled()
    expect(screen.getByTestId('pending-environment')).toHaveTextContent('none')
  })

  it('logs out and selects the linked saved environment after switch confirmation', async () => {
    const state = await runtimeConfigModule!.getDesktopRuntimeConfigState()
    const otherOption = state.options.find(
      option => option.externalRestApiBaseUrl === otherEnvironment.externalRestApiBaseUrl
    )
    if (!otherOption) throw new Error('The runtime config producer did not return the other target')
    await runtimeConfigModule!.selectDesktopRuntimeConfigOption(otherOption.id)

    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('configuration-loaded')).toHaveTextContent('yes'))
    await act(async () => setAuthenticatedForTest?.(true))
    mocks.selectRuntimeConfig.mockClear()
    mocks.setStatus.mockClear()

    let handoff!: Promise<void>
    await act(async () => {
      handoff = Promise.resolve(
        desktopEnvironmentSetupListener!({
          ...targetEnvironment,
          externalRestApiBaseUrl: `${targetEnvironment.externalRestApiBaseUrl}/api/v1`,
        })
      )
    })
    await waitFor(() =>
      expect(screen.getByTestId('pending-environment-switch')).toHaveTextContent(
        `${targetEnvironment.externalRestApiBaseUrl}/api/v1`
      )
    )
    expect(mocks.logoutForEnvironmentMismatch).not.toHaveBeenCalled()
    await act(async () => confirmDesktopEnvironmentSwitchForTest?.())
    await act(async () => handoff)

    expect(mocks.logoutForEnvironmentMismatch).toHaveBeenCalledOnce()
    expect(mocks.selectRuntimeConfigForHandoff).toHaveBeenCalledWith(await savedTargetOptionId(), 1)
    expect(screen.getByTestId('pending-environment')).toHaveTextContent('none')
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
      rpcProxyBaseUrl: localhostOption.rpcProxyBaseUrl,
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

  it('adds a REST API path when only another path on the same host is saved', async () => {
    const linkedEnvironment = {
      appName: 'API v2 tenant',
      externalRestApiBaseUrl: `${targetEnvironment.externalRestApiBaseUrl}/api/v2`,
      rpcProxyBaseUrl: '',
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
        ...linkedEnvironment,
        rpcProxyBaseUrl: 'https://rpc.example.test/api-v2',
      }),
    }
    serviceInternals.applyRuntimeEnvironmentChange = operation => operation()
    mocks.saveRuntimeConfig.mockImplementation(serviceInternals.saveRuntimeConfig.bind(service))

    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('configuration-loaded')).toHaveTextContent('yes'))
    await dispatchDesktopEnvironmentLink(linkedEnvironment)
    expect(screen.getByTestId('pending-environment')).toHaveTextContent(
      linkedEnvironment.externalRestApiBaseUrl
    )

    await act(async () => {
      await confirmDesktopEnvironmentSetupForTest?.()
    })

    const finalState = await runtimeConfigModule!.getDesktopRuntimeConfigState()
    const savedTarget = finalState.options.find(
      option => option.externalRestApiBaseUrl === linkedEnvironment.externalRestApiBaseUrl
    )
    const originalTarget = finalState.options.find(
      option =>
        option.externalRestApiBaseUrl === `${targetEnvironment.externalRestApiBaseUrl}/api/v1`
    )
    expect(serviceInternals.authClient.getDesktopEnvironment).toHaveBeenCalledOnce()
    expect(savedTarget?.rpcProxyBaseUrl).toBe('https://rpc.example.test/api-v2')
    expect(originalTarget).toBeDefined()
    expect(finalState.activeOptionId).toBe(savedTarget?.id)
    expect(screen.getByTestId('setup-complete')).toHaveTextContent('yes')
    expect(screen.getByTestId('pending-environment')).toHaveTextContent('none')
  })
})
