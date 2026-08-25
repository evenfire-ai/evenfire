// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { LOCALHOST_RUNTIME_CONFIG_OPTION_ID } from '../../constants/runtimeConfig'
import { AuthContext } from '../../contexts/AuthContext'
import type { AuthContextValue } from '../../contexts/AuthContext'
import { useOnboardingController } from '../../hooks/domain/useOnboardingController'
import { OnboardingPage } from '../OnboardingPage'

afterEach(() => {
  cleanup()
})

let probeLocalhostReachable = vi.fn()
let openDeploymentDocs = vi.fn()

beforeEach(() => {
  probeLocalhostReachable = vi.fn().mockResolvedValue(false)
  openDeploymentDocs = vi.fn().mockResolvedValue({ opened: true })
  ;(window as unknown as { clerum: unknown }).clerum = {
    auth: { probeLocalhostReachable, openDeploymentDocs },
  }
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
    configured: false,
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
  runtimeConfigMissing: true,
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

/** Drives the page with the real controller, so routing is exercised end to end. */
function OnboardingHarness() {
  const onboarding = useOnboardingController()
  return <OnboardingPage onboarding={onboarding} />
}

function renderOnboarding(auth?: Partial<AuthContextValue>) {
  return render(
    <AuthContext.Provider value={makeAuthValue(auth)}>
      <OnboardingHarness />
    </AuthContext.Provider>
  )
}

describe('OnboardingPage', () => {
  it('opens on Q1 with the three origin answers', () => {
    renderOnboarding()

    expect(screen.getByText('Do you already have an Evenfire server?')).toBeTruthy()
    expect(screen.getByRole('button', { name: /My team already uses Evenfire/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /I have a server address/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /No, I’m just getting started/ })).toBeTruthy()
    // The first step is the one with no way back; Q1's second answer is its skip.
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull()
  })

  it('routes the invited answer to the invitation step with its existing handler', async () => {
    const user = userEvent.setup()
    const handleStartDesktopSetup = vi.fn()

    renderOnboarding({ email: 'invited@example.com', handleStartDesktopSetup })

    await user.click(screen.getByRole('button', { name: /My team already uses Evenfire/ }))

    expect(screen.getByLabelText('Email')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Continue setup' }))

    expect(handleStartDesktopSetup).toHaveBeenCalledTimes(1)
  })

  it('routes the have-an-address answer straight to the manual environment form', async () => {
    const user = userEvent.setup()

    renderOnboarding()

    await user.click(screen.getByRole('button', { name: /I have a server address/ }))

    expect(screen.getByLabelText('Environment name')).toBeTruthy()
    expect(screen.getByLabelText('External REST API')).toBeTruthy()
  })

  it('sends the getting-started answer to the self-hosted step while path A is unavailable', async () => {
    const user = userEvent.setup()

    renderOnboarding()

    await user.click(screen.getByRole('button', { name: /No, I’m just getting started/ }))

    // Q2 is skipped entirely rather than offering a choice with one real answer.
    expect(screen.queryByText('How do you want to run Evenfire?')).toBeNull()
    expect(screen.getByText('Run Evenfire yourself')).toBeTruthy()
  })

  it('keeps the self-hosted step neutral about where the server runs', async () => {
    const user = userEvent.setup()

    renderOnboarding()
    await user.click(screen.getByRole('button', { name: /No, I’m just getting started/ }))

    const step = screen.getByText('Run Evenfire yourself').closest('section')
    const copy = step?.textContent || ''
    // Self-hosting means any cluster the user controls (spec §5.4). No install
    // command, no RAM figure, no loopback default, no single deployment shape.
    expect(copy).not.toMatch(/minikube|docker|127\.0\.0\.1|localhost|GB|RAM|your machine/i)
  })

  it('opens the deployment guide without writing an environment', async () => {
    const user = userEvent.setup()
    const handleSaveRuntimeConfig = vi.fn()

    renderOnboarding({ handleSaveRuntimeConfig })
    await user.click(screen.getByRole('button', { name: /No, I’m just getting started/ }))
    await user.click(screen.getByRole('button', { name: 'Open the deployment guide' }))

    expect(openDeploymentDocs).toHaveBeenCalledTimes(1)
    // No argument: the renderer never names a URL for the main process (spec §6.8).
    expect(openDeploymentDocs).toHaveBeenCalledWith()
    expect(handleSaveRuntimeConfig).not.toHaveBeenCalled()
  })

  it('hands the self-hosted path to the manual environment form', async () => {
    const user = userEvent.setup()

    renderOnboarding()
    await user.click(screen.getByRole('button', { name: /No, I’m just getting started/ }))
    await user.click(screen.getByRole('button', { name: /I have a server — enter its address/ }))

    expect(screen.getByLabelText('Environment name')).toBeTruthy()
  })

  it('walks back to the previous step, and to Q1 from a two-step path', async () => {
    const user = userEvent.setup()

    renderOnboarding()
    await user.click(screen.getByRole('button', { name: /No, I’m just getting started/ }))
    await user.click(screen.getByRole('button', { name: /I have a server — enter its address/ }))

    expect(screen.getByLabelText('Environment name')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByText('Run Evenfire yourself')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByText('Do you already have an Evenfire server?')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull()
  })

  it('offers the local cluster when one answers, and selects the existing option', async () => {
    const user = userEvent.setup()
    const handleSelectRuntimeConfig = vi.fn()
    probeLocalhostReachable.mockResolvedValue(true)

    renderOnboarding({ handleSelectRuntimeConfig })
    await user.click(screen.getByRole('button', { name: /I have a server address/ }))

    const hint = await screen.findByRole('button', { name: 'Use Localhost' })
    // The probe takes no URL argument (spec §5.6).
    expect(probeLocalhostReachable).toHaveBeenCalledWith()

    await user.click(hint)

    // Reuses the built-in Localhost option rather than saving a duplicate
    // environment that points at the same address.
    expect(handleSelectRuntimeConfig).toHaveBeenCalledWith(LOCALHOST_RUNTIME_CONFIG_OPTION_ID)
  })

  it('shows no local-cluster hint when nothing answers', async () => {
    const user = userEvent.setup()

    renderOnboarding()
    await user.click(screen.getByRole('button', { name: /I have a server address/ }))

    await screen.findByLabelText('Environment name')
    expect(probeLocalhostReachable).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: 'Use Localhost' })).toBeNull()
  })

  it('keeps the Localhost escape hatch reachable from onboarding', async () => {
    const user = userEvent.setup()
    const handleSelectRuntimeConfig = vi.fn()

    renderOnboarding({ handleSelectRuntimeConfig })

    await user.click(screen.getByLabelText('Open environment selector'))
    await user.click(screen.getByRole('button', { name: 'Localhost' }))

    expect(handleSelectRuntimeConfig).toHaveBeenCalledWith(LOCALHOST_RUNTIME_CONFIG_OPTION_ID)
  })

  it('saves through the same submit path as the AuthPage environment form', async () => {
    const user = userEvent.setup()
    const handleSaveRuntimeConfig = vi.fn().mockResolvedValue(null)

    renderOnboarding({
      handleSaveRuntimeConfig,
      runtimeConfigSetupName: 'Production',
      runtimeConfigSetupExternalRestApiBaseUrl: 'https://evenfire.example.com',
    })

    await user.click(screen.getByRole('button', { name: /I have a server address/ }))
    await user.click(screen.getByRole('button', { name: 'Save environment' }))

    expect(handleSaveRuntimeConfig).toHaveBeenCalledTimes(1)
  })
})
