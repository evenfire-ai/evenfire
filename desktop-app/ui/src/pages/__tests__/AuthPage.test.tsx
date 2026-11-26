// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BrowserSignInAttempts } from '../../../../src/browserSignIn'
import type { BrowserSignInSnapshot } from '../../../../src/types'
import { FakeBrowserSignInClock } from '../../../../testSupport/browserSignInClock'
import { LOCALHOST_RUNTIME_CONFIG_OPTION_ID } from '../../constants/runtimeConfig'
import { AuthContext } from '../../contexts/AuthContext'
import type { AuthContextValue } from '../../contexts/AuthContext'
import { AuthPage } from '../AuthPage'

afterEach(() => {
  cleanup()
})

const BINDING = Object.freeze({
  environmentKey: 'fixture_env-0123456789ab',
  profileId: null,
  restBaseUrl: 'https://edge-fixture.example.test',
})

/**
 * What a real attempt store pushes for one attempt as it waits, then redeems: the renderer is fed
 * main's own snapshots (T1).
 */
async function captureMainSnapshots() {
  const pushes: BrowserSignInSnapshot[] = []
  const store = new BrowserSignInAttempts({
    push: snapshot => {
      pushes.push(snapshot)
    },
    warn: (message, error) => {
      throw new Error(`unexpected browser sign-in store warning: ${message}`, { cause: error })
    },
    clock: new FakeBrowserSignInClock(),
  })
  const attemptId = store.record({
    state: 'fake-state-1',
    verifier: 'fake-verifier-1',
    binding: BINDING,
    generation: 1,
  })
  if (!store.beginRedeem(attemptId)) throw new Error(`attempt ${attemptId} did not begin to redeem`)
  // The store pushes each snapshot on a microtask.
  await new Promise<void>(resolve => setTimeout(resolve, 0))
  const pushed = (phase: 'waiting' | 'redeeming') => {
    const snapshot = pushes.find(item => item.phase === phase)
    if (!snapshot) throw new Error(`the store pushed no ${phase} snapshot`)
    return snapshot
  }
  return Object.freeze({ waiting: pushed('waiting'), redeeming: pushed('redeeming') })
}

const MAIN = await captureMainSnapshots()

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
  loginScreen: { kind: 'loading' },
  browserSignIn: { attemptId: null, phase: 'idle' },
  refreshLoginMethods: vi.fn(),
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
  handleStartBrowserSignIn: vi.fn(),
  handleCancelBrowserSignIn: vi.fn(),
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
  // The invitation email form moved to onboarding's invited step.
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

/** The password form's submit, with whatever label it shows. */
function passwordSubmit(): HTMLButtonElement {
  const form = screen.getByLabelText('Password').closest('form')
  const submit = form?.querySelector('button[type="submit"]')
  if (!(submit instanceof HTMLButtonElement)) throw new Error('the password form has no submit')
  return submit
}

describe('AuthPage: the password submit (R-15)', () => {
  it('R-15 says "Signing in..." for a password sign-in, not while a browser sign-in redeems', () => {
    // A password sign-in in flight: the controller sets `busy` and the raw flag.
    const { unmount } = renderAuthPage({
      busy: true,
      authTransitioning: true,
      email: 'member@example.test',
      password: 'fake-password',
    })
    expect(passwordSubmit().textContent, 'a password sign-in shows its progress').toBe(
      'Signing in...'
    )
    unmount()

    // A browser sign-in redeems: the controller returns the widened flag (decision 8).
    renderAuthPage({
      authTransitioning: true,
      browserSignIn: MAIN.redeeming,
      email: 'member@example.test',
      password: 'fake-password',
    })
    expect(passwordSubmit().textContent, 'redeeming is not a password sign-in').toBe('Sign in')
    expect(screen.queryByText('Signing in...')).toBeNull()
  })
})

type EnvironmentChangeControlRow = Readonly<{
  control: string
  /** What the screen holds for the control to show and be usable. */
  auth: Partial<AuthContextValue>
  /** Brings the control on screen, when that takes a step. */
  show?: (user: ReturnType<typeof userEvent.setup>) => Promise<void>
}>

/** The page's controls that change the binding outside the dock (R-38; Task 14a review I-1). */
const ENVIRONMENT_CHANGE_CONTROLS: readonly EnvironmentChangeControlRow[] = [
  {
    control: 'Save environment',
    auth: {
      runtimeConfigSetupName: 'Environment D',
      runtimeConfigSetupExternalRestApiBaseUrl: 'https://api-d.example.test',
    },
    show: async user => {
      await user.click(screen.getByLabelText('Open environment selector'))
      await user.click(screen.getByLabelText('Add environment'))
    },
  },
  {
    control: 'Switch to Localhost & retry',
    auth: {
      backendSwitchHint: {
        targetOptionId: LOCALHOST_RUNTIME_CONFIG_OPTION_ID,
        targetLabel: 'Localhost',
        activeLabel: 'Production',
      },
    },
  },
]

describe('AuthPage: environment changes and a browser sign-in (R-38)', () => {
  it.each(ENVIRONMENT_CHANGE_CONTROLS.map(row => [row.control, row] as const))(
    'R-38 disables %s while a browser sign-in redeems',
    async (_control, row) => {
      const user = userEvent.setup()
      const page = (auth: Partial<AuthContextValue>) => (
        <AuthContext.Provider value={makeAuthValue({ ...row.auth, ...auth })}>
          <AuthPage />
        </AuthContext.Provider>
      )
      const control = () => screen.getByRole('button', { name: row.control }) as HTMLButtonElement

      // Positive control: a waiting attempt sets nothing (D14), so the change stays offered.
      const { rerender } = render(page({ browserSignIn: MAIN.waiting }))
      await row.show?.(user)
      expect(control().disabled, `${row.control} is usable while a browser sign-in waits`).toBe(
        false
      )

      // Main redeems: the controller returns the widened flag (decision 8).
      rerender(page({ browserSignIn: MAIN.redeeming, authTransitioning: true }))
      expect(control().disabled, `${row.control} is disabled while a browser sign-in redeems`).toBe(
        true
      )
    }
  )
})
