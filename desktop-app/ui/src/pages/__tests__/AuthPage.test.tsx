// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { LOCALHOST_RUNTIME_CONFIG_OPTION_ID } from '../../constants/runtimeConfig'
import { AuthContext } from '../../contexts/AuthContext'
import type { AuthContextValue } from '../../contexts/AuthContext'
import { AuthPage } from '../AuthPage'

afterEach(() => {
  cleanup()
})

// The environment dock probes for a local Evenfire and only lists Localhost
// when one answers, so these tests must say whether one is running.
let probeLocalhostReachable = vi.fn()

beforeEach(() => {
  probeLocalhostReachable = vi.fn().mockResolvedValue(false)
  ;(window as unknown as { clerum: unknown }).clerum = { auth: { probeLocalhostReachable } }
})

const makeAuthValue = (overrides: Partial<AuthContextValue> = {}): AuthContextValue => ({
  booting: false,
  busy: false,
  statusText: 'Ready.',
  statusTone: 'info',
  isAuthenticated: false,
  me: null,
  email: '',
  password: '',
  desktopSetupAuthorizationToken: '',
  desktopSetupStarted: false,
  desktopEnvironmentSetupComplete: false,
  runtimeConfigSetupName: '',
  runtimeConfigSetupExternalRestApiBaseUrl: '',
  runtimeConfigSetupRpcProxyBaseUrl: '',
  authTransitioning: false,
  runtimeConfigState: {
    configured: true,
    isLocalhost: false,
    selectorVisible: true,
    activeOptionId: null,
    envKey: 'env-test-key',
    storagePath: '/tmp/evenfire-runtime-config',
    options: [],
  },
  desktopReleaseStatus: null,
  pendingDesktopEnvironmentSetup: null,
  backendSwitchHint: null,
  runtimeConfigMissing: false,
  showRuntimeConfigSelector: false,
  dependencyHealth: null,
  hasDependencyOutage: false,
  setBooting: vi.fn(),
  setEmail: vi.fn(),
  setPassword: vi.fn(),
  setDesktopSetupAuthorizationToken: vi.fn(),
  setDesktopEnvironmentSetupComplete: vi.fn(),
  setPendingDesktopEnvironmentSetup: vi.fn(),
  setRuntimeConfigSetupName: vi.fn(),
  setRuntimeConfigSetupExternalRestApiBaseUrl: vi.fn(),
  setRuntimeConfigSetupRpcProxyBaseUrl: vi.fn(),
  setStatus: vi.fn(),
  loadSession: vi.fn(),
  handlePasswordLogin: vi.fn(),
  handleSwitchLoginBackend: vi.fn(),
  handleStartDesktopSetup: vi.fn(),
  handleCompleteDesktopSetup: vi.fn(),
  handleSaveRuntimeConfig: vi.fn(),
  handleDeleteRuntimeConfig: vi.fn(),
  handleSelectRuntimeConfig: vi.fn(),
  handleClearRuntimeConfigSelection: vi.fn(),
  handleCancelDesktopEnvironmentSetup: vi.fn(),
  handleConfirmDesktopEnvironmentSetup: vi.fn(),
  handleOpenDesktopRelease: vi.fn(),
  handleLogout: vi.fn(),
  ...overrides,
})

function renderAuthPage(auth?: Partial<AuthContextValue>) {
  return render(
    <AuthContext.Provider value={makeAuthValue(auth)}>
      <AuthPage />
    </AuthContext.Provider>
  )
}

describe('AuthPage', () => {
  // The invitation email form moved to onboarding's invited step (spec §5.5).
  // AuthPage has one mode again, and must keep it even if it is somehow
  // rendered without an environment — the unauthenticated branch routes that
  // case to OnboardingPage instead.
  it('renders sign-in only, never the invitation form, when no environment is configured', () => {
    const handleStartDesktopSetup = vi.fn()

    renderAuthPage({
      runtimeConfigMissing: true,
      runtimeConfigState: {
        configured: false,
        isLocalhost: false,
        selectorVisible: true,
        activeOptionId: null,
        envKey: 'env-test-key',
        storagePath: '/tmp/evenfire-runtime-config',
        options: [],
      },
      email: 'new-user@example.com',
      handleStartDesktopSetup,
    })

    expect(screen.getByLabelText('Email')).toBeTruthy()
    expect(screen.getByLabelText('Password')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Continue setup' })).toBeNull()
    expect(handleStartDesktopSetup).not.toHaveBeenCalled()
  })

  it('hides login while adding an environment and can return to login', async () => {
    const user = userEvent.setup()

    renderAuthPage()

    expect(screen.getByLabelText('Email')).toBeTruthy()
    expect(screen.getByLabelText('Password')).toBeTruthy()

    await user.click(screen.getByLabelText('Open environment selector'))
    await user.click(screen.getByLabelText('Add environment'))

    expect(screen.getByLabelText('Environment name')).toBeTruthy()
    expect(screen.getByLabelText('External REST API')).toBeTruthy()
    expect(screen.queryByLabelText('Email')).toBeNull()
    expect(screen.queryByLabelText('Password')).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Go back to login' }))

    expect(screen.getByLabelText('Email')).toBeTruthy()
    expect(screen.getByLabelText('Password')).toBeTruthy()
    expect(screen.queryByLabelText('Environment name')).toBeNull()
  })

  it('shows localhost in the environment menu when one is detected', async () => {
    const user = userEvent.setup()
    const handleSelectRuntimeConfig = vi.fn()
    probeLocalhostReachable.mockResolvedValue(true)

    renderAuthPage({
      runtimeConfigMissing: true,
      runtimeConfigState: {
        configured: false,
        isLocalhost: false,
        selectorVisible: true,
        activeOptionId: null,
        envKey: 'env-test-key',
        storagePath: '/tmp/evenfire-runtime-config',
        options: [],
      },
      handleSelectRuntimeConfig,
    })

    await user.click(screen.getByLabelText('Open environment selector'))

    const localhost = await screen.findByRole('button', { name: 'Localhost' })
    expect(localhost.getAttribute('aria-current')).toBeNull()

    await user.click(localhost)

    expect(handleSelectRuntimeConfig).toHaveBeenCalledWith(LOCALHOST_RUNTIME_CONFIG_OPTION_ID)
  })

  it('omits localhost from the environment menu when nothing is running', async () => {
    const user = userEvent.setup()

    renderAuthPage()

    await user.click(screen.getByLabelText('Open environment selector'))

    expect(screen.queryByRole('button', { name: 'Localhost' })).toBeNull()
  })

  it('keeps localhost listed while it is the active environment', async () => {
    const user = userEvent.setup()

    // A local cluster that went down mid-session must not silently vanish from
    // the menu the user is currently pointed at.
    renderAuthPage({
      runtimeConfigState: {
        configured: true,
        isLocalhost: true,
        selectorVisible: true,
        activeOptionId: LOCALHOST_RUNTIME_CONFIG_OPTION_ID,
        envKey: 'env-test-key',
        storagePath: '/tmp/evenfire-runtime-config',
        options: [],
      },
    })

    await user.click(screen.getByLabelText('Open environment selector'))

    expect(screen.getByRole('button', { name: 'Localhost' })).toBeTruthy()
  })

  it('offers a switch-and-retry action when a backend-mismatch hint is present', async () => {
    const user = userEvent.setup()
    const handleSwitchLoginBackend = vi.fn()

    renderAuthPage({
      backendSwitchHint: {
        targetOptionId: LOCALHOST_RUNTIME_CONFIG_OPTION_ID,
        targetLabel: 'Localhost',
        activeLabel: 'Production',
      },
      handleSwitchLoginBackend,
    })

    const switchButton = screen.getByRole('button', { name: /Switch to Localhost & retry/ })
    expect(switchButton).toBeTruthy()

    await user.click(switchButton)

    expect(handleSwitchLoginBackend).toHaveBeenCalledTimes(1)
  })

  it('shows no switch affordance when there is no backend-mismatch hint', () => {
    renderAuthPage({ backendSwitchHint: null })

    expect(screen.queryByRole('button', { name: /Switch to .* & retry/ })).toBeNull()
  })
})
