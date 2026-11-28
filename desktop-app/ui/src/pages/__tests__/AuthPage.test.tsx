// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BrowserSignInAttempts } from '../../../../src/browserSignIn'
import { buildLoginMethodsModel } from '../../../../src/browserSignInModel'
import type { BrowserSignInSnapshot, LoginMethodsModel } from '../../../../src/types'
import { FakeBrowserSignInClock } from '../../../../testSupport/browserSignInClock'
import { LOGIN_SCREEN_ROWS, deriveEdgeRecord } from '../../../../testSupport/edgeContractRecords'
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

/** The login model main builds for a `LOGIN_SCREEN_ROWS` answer (design §10.1). */
function modelOf(label: string): LoginMethodsModel {
  const row = LOGIN_SCREEN_ROWS.find(([rowLabel]) => rowLabel === label)
  if (!row) throw new Error(`LOGIN_SCREEN_ROWS has no row "${label}"`)
  return buildLoginMethodsModel(row[1], { linksAvailable: true })
}

const PASSWORD_FORM = modelOf('password')
const BOTH_METHODS = modelOf('password-and-oidc')
const UNREACHABLE = modelOf('unreachable')
const MISCONFIGURED = modelOf('nothing-usable:empty')

function providerLabel(model: LoginMethodsModel): string {
  if (model.kind !== 'methods' || !model.provider) throw new Error('the model offers no provider')
  return model.provider.label
}

const CONTINUE = `Continue with ${providerLabel(BOTH_METHODS)}`

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
  // The password form: what the page showed before it read the login model.
  loginScreen: PASSWORD_FORM,
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
  // The controller's cancel never rejects; it resolves once main has answered.
  handleCancelBrowserSignIn: vi.fn().mockResolvedValue(undefined),
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

/** The text of the screen's one status line, or null when it shows none. */
function statusLine(): string | null {
  return screen.queryByRole('status')?.textContent ?? null
}

/** The "Continue with <label>" button, or null when the screen does not offer the provider. */
function providerButton(label = providerLabel(BOTH_METHODS)): HTMLButtonElement | null {
  return screen.queryByRole('button', { name: `Continue with ${label}` })
}

function requiredProviderButton(label?: string): HTMLButtonElement {
  const button = providerButton(label)
  expect(button, 'the screen offers the provider').not.toBeNull()
  return button as HTMLButtonElement
}

function inputLabelled(label: string): HTMLInputElement {
  return screen.getByLabelText(label) as HTMLInputElement
}

describe('AuthPage: the login screen from main’s model (design §10.1)', () => {
  it.each(LOGIN_SCREEN_ROWS.map(([label, answer]) => [label, answer] as const))(
    'renders %s',
    (_label, answer) => {
      const model = buildLoginMethodsModel(answer, { linksAvailable: true })
      renderAuthPage({ loginScreen: model })

      const passwordForm = screen.queryByLabelText('Email')
      const retry = screen.queryByRole('button', { name: 'Retry' })
      switch (model.kind) {
        case 'methods': {
          const { provider } = model
          if (provider) {
            expect(providerButton(provider.label), 'the provider is offered').not.toBeNull()
          } else {
            expect(
              screen.queryByRole('button', { name: /^Continue with / }),
              'no provider is offered'
            ).toBeNull()
          }
          expect(passwordForm !== null, 'the password form shows exactly when offered').toBe(
            model.password
          )
          const both = provider !== null && model.password
          expect(
            screen.queryByText('Sign in with a password') !== null,
            'the password form is headed as the secondary action below a provider'
          ).toBe(both)
          expect(
            document.querySelector('.auth-card__divider') !== null,
            'a divider separates the two methods'
          ).toBe(both)
          expect(retry, 'a usable model has no Retry').toBeNull()
          break
        }
        case 'misconfigured':
        case 'unreachable':
          expect(
            screen.queryByText(
              model.kind === 'misconfigured'
                ? "This environment's sign-in isn't set up correctly."
                : "Can't reach this environment."
            ),
            'the screen says why it offers nothing'
          ).not.toBeNull()
          expect(retry, 'Retry is offered').not.toBeNull()
          expect(passwordForm, 'no form and no guess').toBeNull()
          expect(screen.queryByRole('button', { name: /^Continue with / })).toBeNull()
          break
      }
    }
  )

  it('shows a status line and no form while the model loads', () => {
    renderAuthPage({ loginScreen: { kind: 'loading' } })

    expect(statusLine(), 'the screen says it is loading').toBe('Loading sign-in options…')
    expect(screen.queryByLabelText('Email'), 'no form before the model').toBeNull()
    expect(screen.queryByRole('button', { name: /^Continue with / })).toBeNull()
  })

  it('reads the methods when the login screen shows', () => {
    const refreshLoginMethods = vi.fn()
    renderAuthPage({ refreshLoginMethods })

    expect(refreshLoginMethods, 'one read when the screen shows').toHaveBeenCalledTimes(1)
  })

  it('Retry re-reads the methods', async () => {
    const user = userEvent.setup()
    for (const model of [UNREACHABLE, MISCONFIGURED]) {
      const refreshLoginMethods = vi.fn()
      const { unmount } = renderAuthPage({ loginScreen: model, refreshLoginMethods })
      expect(
        refreshLoginMethods,
        'the screen read the methods when it showed'
      ).toHaveBeenCalledTimes(1)
      const retry = screen.queryByRole('button', { name: 'Retry' })
      expect(retry, `${model.kind} offers Retry`).not.toBeNull()

      await user.click(retry as HTMLButtonElement)
      expect(
        refreshLoginMethods,
        `Retry on ${model.kind} reads the methods again`
      ).toHaveBeenCalledTimes(2)
      unmount()
    }
  })

  // R-40 (final review FR-T2): these screens show no form, so no failed password login can offer
  // "Switch to … & retry". The environment dock is how the person reaches another environment.
  it.each([
    ['unreachable', UNREACHABLE],
    ['misconfigured', MISCONFIGURED],
  ] as const)('R-40 keeps the environment dock usable on the %s screen', (kind, model) => {
    expect(model.kind, `main's model is ${kind}`).toBe(kind)
    renderAuthPage({ loginScreen: model })

    expect(
      screen.queryByRole('button', { name: 'Retry' }),
      'the error screen shows, with Retry'
    ).not.toBeNull()
    const dock = screen.queryByRole('button', { name: 'Open environment selector' })
    expect(dock, 'the environment dock is offered').not.toBeNull()
    expect((dock as HTMLButtonElement).disabled, 'the environment dock is usable').toBe(false)
  })

  // A binding change in flight sets `busy`, and the auth flows that run one set the raw
  // `authTransitioning` (completing desktop setup sets both).
  it.each(['busy', 'authTransitioning'] as const)(
    'disables Retry while %s is set, so no read races a binding change (Task 13 review)',
    async flag => {
      const user = userEvent.setup()
      const refreshLoginMethods = vi.fn()
      const page = (auth: Partial<AuthContextValue>) => (
        <AuthContext.Provider
          value={makeAuthValue({ loginScreen: UNREACHABLE, refreshLoginMethods, ...auth })}
        >
          <AuthPage />
        </AuthContext.Provider>
      )
      const retry = () => screen.getByRole('button', { name: 'Retry' }) as HTMLButtonElement

      const { rerender } = render(page({ [flag]: true }))
      const reads = refreshLoginMethods.mock.calls.length
      expect(retry().disabled, `Retry is disabled while ${flag} is set`).toBe(true)
      await user.click(retry())
      expect(refreshLoginMethods, 'no read is sent').toHaveBeenCalledTimes(reads)

      // Positive control: once the action settles, Retry reads again.
      rerender(page({ [flag]: false }))
      expect(retry().disabled, 'Retry is usable once the action settles').toBe(false)
      await user.click(retry())
      // `refreshLoginMethods` keeps its identity, so the rerender reads nothing by itself.
      expect(refreshLoginMethods, 'Retry reads the methods').toHaveBeenCalledTimes(reads + 1)
    }
  )

  it('starts a browser sign-in from Continue', async () => {
    const user = userEvent.setup()
    const handleStartBrowserSignIn = vi.fn()
    renderAuthPage({ loginScreen: BOTH_METHODS, handleStartBrowserSignIn })

    await user.click(requiredProviderButton())

    expect(handleStartBrowserSignIn).toHaveBeenCalledTimes(1)
  })

  it('shows a waiting browser sign-in with Cancel, and keeps Continue offered', async () => {
    const user = userEvent.setup()
    const handleCancelBrowserSignIn = vi.fn().mockResolvedValue(undefined)
    renderAuthPage({
      loginScreen: BOTH_METHODS,
      browserSignIn: MAIN.waiting,
      handleCancelBrowserSignIn,
    })

    expect(statusLine(), 'the panel says where to finish').toBe('Finish signing in in your browser')
    // A new start replaces an attempt whose page was closed.
    expect(requiredProviderButton().disabled, 'Continue stays usable while waiting').toBe(false)
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(handleCancelBrowserSignIn, 'Cancel reaches the controller').toHaveBeenCalledTimes(1)
  })

  it('M4 disables Cancel while the cancel call is in flight (Task 12 review)', async () => {
    const user = userEvent.setup()
    let answer: () => void = () => undefined
    const handleCancelBrowserSignIn = vi.fn(
      () =>
        new Promise<void>(resolve => {
          answer = resolve
        })
    )
    renderAuthPage({
      loginScreen: BOTH_METHODS,
      browserSignIn: MAIN.waiting,
      handleCancelBrowserSignIn,
    })
    const cancel = () => screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement
    expect(cancel().disabled, 'Cancel is usable while waiting').toBe(false)

    await user.click(cancel())
    expect(handleCancelBrowserSignIn, 'the cancel is in flight').toHaveBeenCalledTimes(1)
    expect(cancel().disabled, 'Cancel is disabled while its call is in flight').toBe(true)
    await user.click(cancel())
    expect(handleCancelBrowserSignIn, 'a second click sends nothing').toHaveBeenCalledTimes(1)

    // Main answers, and the attempt still waits (here, the view has not changed).
    await act(async () => {
      answer()
    })
    expect(cancel().disabled, 'Cancel is usable again once main answered').toBe(false)
  })

  it('G2-14c disables the password form and provider button and hides Cancel while redeeming', () => {
    const credentials = { email: 'member@example.test', password: 'fake-password' }
    // Positive control: with these credentials and nothing running, the form is usable.
    const { unmount } = renderAuthPage({ loginScreen: BOTH_METHODS, ...credentials })
    expect(passwordSubmit().disabled, 'the password submit is usable before redeeming').toBe(false)
    unmount()

    // Main redeems: the view says so, and the controller returns the widened flag (decision 8).
    // `busy` stays clear, as it does while an attempt redeems (D14).
    renderAuthPage({
      loginScreen: BOTH_METHODS,
      browserSignIn: MAIN.redeeming,
      authTransitioning: true,
      busy: false,
      ...credentials,
    })

    expect(inputLabelled('Email').disabled, 'the email input is disabled while redeeming').toBe(
      true
    )
    expect(
      inputLabelled('Password').disabled,
      'the password input is disabled while redeeming'
    ).toBe(true)
    expect(passwordSubmit().disabled, 'the password submit is disabled while redeeming').toBe(true)
    expect(
      requiredProviderButton().disabled,
      'the provider button is disabled while redeeming'
    ).toBe(true)
    expect(
      screen.queryByRole('button', { name: 'Cancel' }),
      'Cancel is hidden while redeeming'
    ).toBeNull()
    expect(statusLine(), 'the panel says it is finishing').toBe('Finishing sign-in…')
    expect(screen.queryByText('Signing in...'), 'one progress line at a time (R-15)').toBeNull()
  })

  it('G2-14d disables Continue while a handoff confirm runs', () => {
    // Positive control: nothing runs, so Continue is usable.
    const { unmount } = renderAuthPage({ loginScreen: BOTH_METHODS })
    expect(requiredProviderButton().disabled, 'Continue is usable when nothing runs').toBe(false)
    unmount()

    // A desktop-environment link's confirm sets the raw flag alone while it reads the session
    // (`handleConfirmDesktopEnvironmentSetup`, A3-68); no attempt exists.
    renderAuthPage({ loginScreen: BOTH_METHODS, authTransitioning: true, busy: false })
    expect(
      requiredProviderButton().disabled,
      'Continue is disabled while a handoff confirm runs'
    ).toBe(true)
  })

  it.each(['booting', 'busy'] as const)('disables Continue while %s is set', flag => {
    renderAuthPage({ loginScreen: BOTH_METHODS, [flag]: true })

    expect(requiredProviderButton().disabled, `Continue is disabled while ${flag}`).toBe(true)
  })

  it('renders a provider label with markup as text', () => {
    // Within the edge's 80-character bound, so main offers the provider (a longer label would
    // make the screen `misconfigured` and prove nothing).
    const label = '<img src=x onerror=alert(1)><b>Sign-in</b>'
    const answer = deriveEdgeRecord(
      'GET /api/v1/auth/methods password-and-oidc',
      'password-and-oidc:label-with-markup',
      recorded => {
        const body = recorded as { oidc: Record<string, unknown> }
        return { ...body, oidc: { ...body.oidc, label } }
      }
    )
    const model = buildLoginMethodsModel(
      { status: 200, body: answer.body },
      { linksAvailable: true }
    )
    expect(model, 'main offers the provider with the label as sent').toEqual({
      kind: 'methods',
      provider: { label },
      password: true,
    })
    renderAuthPage({ loginScreen: model })

    const button = requiredProviderButton(label)
    expect(button.textContent, 'the label reads as text').toBe(`Continue with ${label}`)
    expect(button.querySelector('img, b'), 'no element came from the label').toBeNull()
  })
})
