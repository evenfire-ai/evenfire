// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { useAuthController } from '../useAuthController'

const mocks = vi.hoisted(() => ({
  clearQueryCache: vi.fn(),
  getRuntimeConfigState: vi.fn(),
  onDesktopEnvironmentSetup: vi.fn(),
  onDesktopSetupToken: vi.fn(),
  onExternalLogout: vi.fn(),
  selectRuntimeConfig: vi.fn(),
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

type DesktopEnvironmentSetupPayload = typeof targetEnvironment

let desktopEnvironmentSetupListener:
  | ((payload: DesktopEnvironmentSetupPayload) => void | Promise<void>)
  | null = null
let setBootingForTest: ((value: boolean) => void) | null = null
let setAuthenticatedForTest: ((value: boolean) => void) | null = null
let runtimeConfigModule: typeof import('../../../../../src/config') | null = null
let runtimeConfigDirectory = ''
const originalOnboardingPreview = process.env.EVENFIRE_ONBOARDING_PREVIEW

function Probe() {
  const auth = useAuthController({
    setStatus: mocks.setStatus,
    onSessionNeedsLoad: mocks.loadSession,
  })
  setBootingForTest = auth.setBooting
  setAuthenticatedForTest = auth.setIsAuthenticated

  return (
    <>
      <div data-testid="configuration-loaded">{auth.runtimeConfigState ? 'yes' : 'no'}</div>
      <div data-testid="pending-environment">
        {auth.pendingDesktopEnvironmentSetup?.externalRestApiBaseUrl || 'none'}
      </div>
      <div data-testid="pending-rpc">
        {auth.pendingDesktopEnvironmentSetup?.rpcProxyBaseUrl || 'none'}
      </div>
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
  desktopEnvironmentSetupListener = null
  setBootingForTest = null
  setAuthenticatedForTest = null
  runtimeConfigModule = null
  delete process.env.EVENFIRE_ONBOARDING_PREVIEW
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
  mocks.loadSession.mockImplementation(async () => setBootingForTest?.(false))
  mocks.onDesktopSetupToken.mockReturnValue(() => undefined)
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
      selectRuntimeConfig: mocks.selectRuntimeConfig,
      onDesktopEnvironmentSetup: mocks.onDesktopEnvironmentSetup,
      onDesktopSetupToken: mocks.onDesktopSetupToken,
      onExternalLogout: mocks.onExternalLogout,
    },
  }
})

afterEach(async () => {
  cleanup()
  vi.doUnmock('electron')
  vi.resetModules()
  await fsp.rm(runtimeConfigDirectory, { recursive: true, force: true })
  if (originalOnboardingPreview === undefined) delete process.env.EVENFIRE_ONBOARDING_PREVIEW
  else process.env.EVENFIRE_ONBOARDING_PREVIEW = originalOnboardingPreview
})

describe('Desktop environment handoff', () => {
  it('switches to a saved environment matching both service origins', async () => {
    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('configuration-loaded')).toHaveTextContent('yes'))
    const targetOptionId = await savedTargetOptionId()
    mocks.loadSession.mockClear()

    await dispatchDesktopEnvironmentLink()

    expect(mocks.selectRuntimeConfig).toHaveBeenCalledWith(targetOptionId)
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
    await dispatchDesktopEnvironmentLink()

    expect(mocks.selectRuntimeConfig).not.toHaveBeenCalled()
    expect(screen.getByTestId('pending-environment')).toHaveTextContent('none')
    expect(mocks.setStatus).toHaveBeenCalledWith(
      'Opening Example tenant in Evenfire Desktop.',
      'success'
    )
  })

  it('rejects a link that proposes a different RPC proxy for a saved REST environment', async () => {
    await runtimeConfigModule!.saveDesktopRuntimeConfig({
      ...targetEnvironment,
      externalRestApiBaseUrl: `${targetEnvironment.externalRestApiBaseUrl}/api/v1`,
      rpcProxyBaseUrl: `${targetEnvironment.rpcProxyBaseUrl}/rpc`,
    })

    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('configuration-loaded')).toHaveTextContent('yes'))
    await dispatchDesktopEnvironmentLink({
      ...targetEnvironment,
      rpcProxyBaseUrl: 'https://rpc.attacker.test',
    })

    expect(mocks.selectRuntimeConfig).not.toHaveBeenCalled()
    expect(screen.getByTestId('pending-environment')).toHaveTextContent('none')
    expect(screen.getByTestId('pending-rpc')).toHaveTextContent('none')
    expect(
      (await runtimeConfigModule!.getDesktopRuntimeConfigState()).options.find(
        option =>
          option.externalRestApiBaseUrl === `${targetEnvironment.externalRestApiBaseUrl}/api/v1`
      )?.rpcProxyBaseUrl
    ).toBe(`${targetEnvironment.rpcProxyBaseUrl}/rpc`)
    expect(mocks.setStatus).toHaveBeenCalledWith(
      expect.stringMatching(/RPC proxy.*saved environment/i),
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

  it('does not switch away from another saved environment while signed in', async () => {
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

    await dispatchDesktopEnvironmentLink()

    expect(mocks.selectRuntimeConfig).not.toHaveBeenCalled()
    expect(screen.getByTestId('pending-environment')).toHaveTextContent('none')
    expect(mocks.setStatus).toHaveBeenCalledWith(
      expect.stringMatching(/sign out.*before opening another/i),
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
      rpcProxyBaseUrl: localhostOption.rpcProxyBaseUrl,
    })

    expect(mocks.selectRuntimeConfig).not.toHaveBeenCalled()
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

    expect(mocks.selectRuntimeConfig).not.toHaveBeenCalled()
    expect(screen.getByTestId('pending-environment')).toHaveTextContent('none')
    expect(mocks.setStatus).toHaveBeenCalledWith(
      'Could not verify the desktop environment. Try opening it again.',
      'error'
    )
  })
})
