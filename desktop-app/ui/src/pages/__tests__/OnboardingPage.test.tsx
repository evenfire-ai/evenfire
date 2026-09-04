// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
let openHostedSignup = vi.fn()

beforeEach(() => {
  probeLocalhostReachable = vi.fn().mockResolvedValue(false)
  openDeploymentDocs = vi.fn().mockResolvedValue({ opened: true })
  openHostedSignup = vi.fn().mockResolvedValue({ opened: true })
  ;(window as unknown as { clerum: unknown }).clerum = {
    auth: { probeLocalhostReachable, openDeploymentDocs, openHostedSignup },
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

  it('sends the getting-started answer to Q2, leading with the hosted option', async () => {
    const user = userEvent.setup()

    renderOnboarding()

    await user.click(screen.getByRole('button', { name: /No, I’m just getting started/ }))

    expect(screen.getByText('How do you want to run Evenfire?')).toBeTruthy()
    const options = screen.getAllByRole('button', { name: /Evenfire hosts it|run it myself/ })
    // Hosting is what someone just getting started should see first.
    expect(options[0]?.textContent).toContain('Evenfire hosts it for me')
  })

  it('does not promise a trial the hosted service cannot deliver yet', async () => {
    const user = userEvent.setup()

    renderOnboarding()
    await user.click(screen.getByRole('button', { name: /No, I’m just getting started/ }))

    const hosted = screen.getByRole('button', { name: /Evenfire hosts it for me/ })
    expect(hosted.textContent).not.toMatch(/free|trial|week|\d+\s*day/i)
  })

  it('steps back with the left arrow key', async () => {
    const user = userEvent.setup()

    renderOnboarding()
    await user.click(screen.getByRole('button', { name: /I have a server address/ }))
    expect(screen.getByLabelText('Environment name')).toBeTruthy()

    fireEvent.keyDown(window, { key: 'ArrowLeft' })

    expect(screen.getByText('Do you already have an Evenfire server?')).toBeTruthy()
  })

  it('leaves the arrow key alone while the user is typing an address', async () => {
    const user = userEvent.setup()

    renderOnboarding()
    await user.click(screen.getByRole('button', { name: /I have a server address/ }))

    const input = await screen.findByLabelText('External REST API')
    input.focus()
    fireEvent.keyDown(input, { key: 'ArrowLeft' })

    // Moving the caret must not throw the user out of the form.
    expect(screen.getByLabelText('External REST API')).toBeTruthy()
  })

  it('offers an undecided answer that compares the two run styles', async () => {
    const user = userEvent.setup()

    renderOnboarding()
    await user.click(screen.getByRole('button', { name: /No, I’m just getting started/ }))
    await user.click(screen.getByRole('button', { name: /I have no idea/ }))

    expect(screen.getByText('Which one is right for you?')).toBeTruthy()

    // Both options are described, each with an upside and a downside — a
    // comparison that only lists benefits is an advert, not a comparison.
    const compare = screen.getByText('Which one is right for you?').closest('section')
    const copy = compare?.textContent || ''
    expect(copy).toContain('Evenfire hosts it')
    expect(copy).toContain('You run it yourself')
    expect(screen.getAllByText('+').length).toBeGreaterThanOrEqual(2)
    expect(screen.getAllByText('−').length).toBe(2)
  })

  it('makes no cost claims while hosted signup does not exist', async () => {
    const user = userEvent.setup()

    renderOnboarding()
    await user.click(screen.getByRole('button', { name: /No, I’m just getting started/ }))
    await user.click(screen.getByRole('button', { name: /I have no idea/ }))

    const copy = screen.getByText('Which one is right for you?').closest('section')?.textContent
    expect(copy).not.toMatch(/free|trial|price|pricing|\$|per seat|subscription/i)
  })

  it('lets the undecided user commit to either run style', async () => {
    const user = userEvent.setup()

    renderOnboarding()
    await user.click(screen.getByRole('button', { name: /No, I’m just getting started/ }))
    await user.click(screen.getByRole('button', { name: /I have no idea/ }))
    await user.click(screen.getByRole('button', { name: 'I’ll run it myself' }))
    expect(screen.getByText('Run Evenfire yourself')).toBeTruthy()

    // Back returns to the comparison, not past it to Q2.
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByText('Which one is right for you?')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Evenfire hosts it' }))
    expect(screen.getByText('Evenfire hosts it for you')).toBeTruthy()
  })

  it('routes the hosted answer to a link-out step with a manual fallback', async () => {
    const user = userEvent.setup()
    const handleSaveRuntimeConfig = vi.fn()

    renderOnboarding({ handleSaveRuntimeConfig })
    await user.click(screen.getByRole('button', { name: /No, I’m just getting started/ }))
    await user.click(screen.getByRole('button', { name: /Evenfire hosts it for me/ }))

    expect(screen.getByText('Evenfire hosts it for you')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'See hosted Evenfire' }))
    expect(openHostedSignup).toHaveBeenCalledTimes(1)
    // No argument: the renderer never names a URL for the main process.
    expect(openHostedSignup).toHaveBeenCalledWith()
    expect(handleSaveRuntimeConfig).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: /I have a server — enter its address/ }))
    expect(screen.getByLabelText('Environment name')).toBeTruthy()
  })

  it('keeps the self-hosted step neutral about where the server runs', async () => {
    const user = userEvent.setup()

    renderOnboarding()
    await user.click(screen.getByRole('button', { name: /No, I’m just getting started/ }))
    await user.click(screen.getByRole('button', { name: /I’ll run it myself/ }))

    const step = screen.getByText('Run Evenfire yourself').closest('section')
    const copy = step?.textContent || ''
    // Self-hosting means any cluster the user controls. No install
    // command, no RAM figure, no loopback default, no single deployment shape.
    expect(copy).not.toMatch(/minikube|docker|127\.0\.0\.1|localhost|GB|RAM|your machine/i)
  })

  it('opens the deployment guide without writing an environment', async () => {
    const user = userEvent.setup()
    const handleSaveRuntimeConfig = vi.fn()

    renderOnboarding({ handleSaveRuntimeConfig })
    await user.click(screen.getByRole('button', { name: /No, I’m just getting started/ }))
    await user.click(screen.getByRole('button', { name: /I’ll run it myself/ }))
    await user.click(screen.getByRole('button', { name: 'Open the deployment guide' }))

    expect(openDeploymentDocs).toHaveBeenCalledTimes(1)
    // No argument: the renderer never names a URL for the main process.
    expect(openDeploymentDocs).toHaveBeenCalledWith()
    expect(handleSaveRuntimeConfig).not.toHaveBeenCalled()
  })

  it('hands the self-hosted path to the manual environment form', async () => {
    const user = userEvent.setup()

    renderOnboarding()
    await user.click(screen.getByRole('button', { name: /No, I’m just getting started/ }))
    await user.click(screen.getByRole('button', { name: /I’ll run it myself/ }))
    await user.click(screen.getByRole('button', { name: /I have a server — enter its address/ }))

    expect(screen.getByLabelText('Environment name')).toBeTruthy()
  })

  it('walks back through every step of the longest path to Q1', async () => {
    const user = userEvent.setup()

    renderOnboarding()
    await user.click(screen.getByRole('button', { name: /No, I’m just getting started/ }))
    await user.click(screen.getByRole('button', { name: /I’ll run it myself/ }))
    await user.click(screen.getByRole('button', { name: /I have a server — enter its address/ }))

    expect(screen.getByLabelText('Environment name')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByText('Run Evenfire yourself')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByText('How do you want to run Evenfire?')).toBeTruthy()

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

    // Presented as a plain option carrying its address, not a callout banner.
    const option = await screen.findByRole('button', { name: /Localhost/ })
    expect(option.textContent).toContain('http://127.0.0.1:8091')
    // The probe takes no URL argument.
    expect(probeLocalhostReachable).toHaveBeenCalledWith()

    await user.click(option)

    // Reuses the built-in Localhost option rather than saving a duplicate
    // environment that points at the same address.
    expect(handleSelectRuntimeConfig).toHaveBeenCalledWith(LOCALHOST_RUNTIME_CONFIG_OPTION_ID)
  })

  it('shows nothing about Localhost anywhere when nothing answers', async () => {
    const user = userEvent.setup()

    renderOnboarding()
    await user.click(screen.getByRole('button', { name: /I have a server address/ }))
    await screen.findByLabelText('Environment name')

    expect(probeLocalhostReachable).toHaveBeenCalledWith()
    expect(screen.queryByRole('button', { name: /Localhost/ })).toBeNull()

    // Not in the environment dock either — the menu must not advertise a
    // server that isn't running.
    await user.click(screen.getByLabelText('Open environment selector'))
    expect(screen.queryByRole('button', { name: /Localhost/ })).toBeNull()
  })

  it('keeps the Localhost escape hatch in the dock once one is detected', async () => {
    const user = userEvent.setup()
    const handleSelectRuntimeConfig = vi.fn()
    probeLocalhostReachable.mockResolvedValue(true)

    renderOnboarding({ handleSelectRuntimeConfig })

    await user.click(screen.getByLabelText('Open environment selector'))
    await user.click(await screen.findByRole('button', { name: 'Localhost' }))

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
