// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ConfigProvider } from 'antd'
import { LOCALHOST_RUNTIME_CONFIG_OPTION_ID } from '../../constants/runtimeConfig'
import { AuthContext } from '../../contexts/AuthContext'
import type { AuthContextValue } from '../../contexts/AuthContext'
import { installAntdDomEnvironment } from '../../test/antdDomEnvironment'
import { AuthPage } from '../AuthPage'

afterEach(() => {
  cleanup()
})

// The environment dock probes for a local Evenfire and only lists Localhost
// when one answers, so these tests must say whether one is running.
let probeLocalhostReachable = vi.fn()

beforeEach(() => {
  installAntdDomEnvironment()
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

function renderAuthPageWithoutMotion(auth?: Partial<AuthContextValue>) {
  return render(
    <AuthContext.Provider value={makeAuthValue(auth)}>
      <ConfigProvider theme={{ token: { motion: false } }}>
        <AuthPage />
      </ConfigProvider>
    </AuthContext.Provider>
  )
}

function StatefulAuthPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  return (
    <AuthContext.Provider value={makeAuthValue({ email, password, setEmail, setPassword })}>
      <AuthPage />
    </AuthContext.Provider>
  )
}

async function openEnvironmentSetup(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByLabelText('Open environment selector'))
  await user.click(screen.getByLabelText('Add environment'))
}

describe('AuthPage', () => {
  it('gives the sign-in card consistent inner spacing', () => {
    renderAuthPage()

    const cardBody = document.querySelector('.ant-card-body') as HTMLElement
    expect(cardBody.style.padding).toBe('32px')
  })

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
    expect(localhost.getAttribute('aria-pressed')).toBe('false')

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

  it('preserves selection, keyboard dismissal, delete confirmation, and outside-click dismissal', async () => {
    const user = userEvent.setup()
    const handleDeleteRuntimeConfig = vi.fn().mockResolvedValue(undefined)
    const option = {
      id: 'production',
      label: 'Production',
      source: 'file' as const,
      configPath: '/profile/production.json',
      externalRestApiBaseUrl: 'https://evenfire.example.com',
      rpcProxyBaseUrl: 'https://rpc.evenfire.example.com',
      appName: 'Production',
    }

    renderAuthPageWithoutMotion({
      runtimeConfigState: {
        configured: true,
        isLocalhost: false,
        selectorVisible: true,
        activeOptionId: option.id,
        envKey: 'env-test-key',
        storagePath: '/tmp/evenfire-runtime-config',
        options: [option],
      },
      handleDeleteRuntimeConfig,
    })

    const toggle = screen.getByRole('button', { name: 'Open environment selector' })
    await user.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('button', { name: 'Production' }).getAttribute('aria-pressed')).toBe(
      'true'
    )

    await user.keyboard('{Escape}')
    await waitFor(() => expect(toggle.getAttribute('aria-expanded')).toBe('false'))
    expect(document.activeElement).toBe(toggle)

    await user.click(toggle)
    await user.click(screen.getByRole('button', { name: 'Delete Production environment' }))
    const dialog = screen.getByRole('dialog', { name: 'Delete environment?' })
    expect(dialog).toBeTruthy()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Cancel' })).toBe(document.activeElement)
    )

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    await user.click(toggle)
    await user.click(screen.getByRole('button', { name: 'Delete Production environment' }))
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(handleDeleteRuntimeConfig).toHaveBeenCalledTimes(1)
    expect(handleDeleteRuntimeConfig).toHaveBeenCalledWith(option.id)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
  })

  it('closes the environment popup on outside click without stealing the new focus', async () => {
    const user = userEvent.setup()
    renderAuthPage()

    const toggle = screen.getByRole('button', { name: 'Open environment selector' })
    const email = screen.getByLabelText('Email')
    await user.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')

    await user.click(email)

    await waitFor(() => expect(toggle.getAttribute('aria-expanded')).toBe('false'))
    expect(document.activeElement).toBe(email)
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

  it('keeps native input types and context-owned email/password editing', async () => {
    const user = userEvent.setup()
    render(<StatefulAuthPage />)

    const email = screen.getByRole('textbox', { name: 'Email' }) as HTMLInputElement
    const password = screen.getByLabelText('Password') as HTMLInputElement
    expect(email.id).toBe('email-input')
    expect(email.type).toBe('email')
    expect(password.id).toBe('password-input')
    expect(password.type).toBe('password')

    await user.tab()
    expect(document.activeElement).toBe(email)
    await user.type(email, 'person@example.com')
    expect(document.activeElement).toBe(email)
    await user.tab()
    expect(document.activeElement).toBe(password)
    await user.type(password, 'correct horse battery staple')

    expect(email.value).toBe('person@example.com')
    expect(password.value).toBe('correct horse battery staple')
    const signIn = screen.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement
    expect(signIn.disabled).toBe(false)
    expect(signIn.classList.contains('ant-btn-primary')).toBe(true)
  })

  it('submits valid credentials by Enter exactly once and blocks invalid or busy submits', async () => {
    const user = userEvent.setup()
    const handlePasswordLogin = vi.fn()
    const { rerender } = renderAuthPage({
      email: 'person@example.com',
      password: 'secret',
      handlePasswordLogin,
    })

    const password = screen.getByLabelText('Password')
    password.focus()
    await user.keyboard('{Enter}')
    expect(handlePasswordLogin).toHaveBeenCalledTimes(1)

    rerender(
      <AuthContext.Provider
        value={makeAuthValue({ email: 'invalid-email', password: 'secret', handlePasswordLogin })}
      >
        <AuthPage />
      </AuthContext.Provider>
    )
    screen.getByLabelText('Password').focus()
    await user.keyboard('{Enter}')
    expect(handlePasswordLogin).toHaveBeenCalledTimes(1)

    rerender(
      <AuthContext.Provider
        value={makeAuthValue({
          email: 'person@example.com',
          password: 'secret',
          busy: true,
          handlePasswordLogin,
        })}
      >
        <AuthPage />
      </AuthContext.Provider>
    )
    expect((screen.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement).disabled).toBe(
      true
    )
    expect(handlePasswordLogin).toHaveBeenCalledTimes(1)
  })

  it('keeps sign-in progress visible without replacing its busy owner', () => {
    renderAuthPage({ email: 'person@example.com', password: 'secret', authTransitioning: true })

    expect((screen.getByRole('button', { name: /Signing in/ }) as HTMLButtonElement).disabled).toBe(
      false
    )
    expect(screen.getByRole('button', { name: /Signing in/ }).textContent).toContain(
      'Signing in...'
    )
  })

  it('retains valid runtime values when save fails and preserves cancel behavior', async () => {
    const user = userEvent.setup()
    const handleSaveRuntimeConfig = vi.fn().mockResolvedValue(null)
    const runtimeConfigSetupName = 'Production'
    const runtimeConfigSetupExternalRestApiBaseUrl = 'https://api.example.com'
    renderAuthPage({
      runtimeConfigSetupName,
      runtimeConfigSetupExternalRestApiBaseUrl,
      handleSaveRuntimeConfig,
    })

    await openEnvironmentSetup(user)
    const name = screen.getByLabelText('Environment name') as HTMLInputElement
    const url = screen.getByLabelText('External REST API') as HTMLInputElement
    expect(name.type).toBe('text')
    expect(url.type).toBe('url')
    expect(name.value).toBe(runtimeConfigSetupName)
    expect(url.value).toBe(runtimeConfigSetupExternalRestApiBaseUrl)

    await user.click(screen.getByRole('button', { name: 'Save environment' }))
    expect(handleSaveRuntimeConfig).toHaveBeenCalledTimes(1)
    expect(screen.getByLabelText('Environment name')).toBeTruthy()
    expect((screen.getByLabelText('External REST API') as HTMLInputElement).value).toBe(
      runtimeConfigSetupExternalRestApiBaseUrl
    )

    await user.click(screen.getByRole('button', { name: 'Go back to login' }))
    expect(screen.getByLabelText('Email')).toBeTruthy()
    expect(screen.queryByLabelText('Environment name')).toBeNull()
  })

  it('saves valid runtime configuration exactly once from Enter', async () => {
    const user = userEvent.setup()
    const handleSaveRuntimeConfig = vi.fn().mockResolvedValue({ id: 'runtime-config' })
    renderAuthPage({
      runtimeConfigSetupName: 'Production',
      runtimeConfigSetupExternalRestApiBaseUrl: 'https://api.example.com',
      handleSaveRuntimeConfig,
    })
    await openEnvironmentSetup(user)

    const url = screen.getByLabelText('External REST API')
    url.focus()
    await user.keyboard('{Enter}')

    await waitFor(() => expect(handleSaveRuntimeConfig).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByLabelText('Environment name')).toBeNull())
  })

  it('blocks a malformed environment URL and disables duplicate runtime submissions while busy', async () => {
    const user = userEvent.setup()
    const handleSaveRuntimeConfig = vi.fn()
    renderAuthPage({
      runtimeConfigSetupName: 'Production',
      runtimeConfigSetupExternalRestApiBaseUrl: 'not-a-url',
      handleSaveRuntimeConfig,
    })
    await openEnvironmentSetup(user)

    await user.click(screen.getByRole('button', { name: 'Save environment' }))
    expect(handleSaveRuntimeConfig).not.toHaveBeenCalled()

    cleanup()
    const { rerender } = renderAuthPage({
      runtimeConfigSetupName: 'Production',
      runtimeConfigSetupExternalRestApiBaseUrl: 'https://api.example.com',
      handleSaveRuntimeConfig,
    })
    await openEnvironmentSetup(user)
    rerender(
      <AuthContext.Provider
        value={makeAuthValue({
          busy: true,
          runtimeConfigSetupName: 'Production',
          runtimeConfigSetupExternalRestApiBaseUrl: 'https://api.example.com',
          handleSaveRuntimeConfig,
        })}
      >
        <AuthPage />
      </AuthContext.Provider>
    )
    expect(
      (screen.getByRole('button', { name: 'Save environment' }) as HTMLButtonElement).disabled
    ).toBe(true)
    expect(
      (screen.getByRole('button', { name: 'Go back to login' }) as HTMLButtonElement).disabled
    ).toBe(true)
  })

  it('normalizes forgot-password email, reports success/failure and disables while pending', async () => {
    const user = userEvent.setup()
    let resolveForgotPassword!: () => void
    const openForgotPassword = vi.fn(
      () => new Promise<void>(resolve => (resolveForgotPassword = resolve))
    )
    ;(window as unknown as { clerum: { auth: Record<string, unknown> } }).clerum.auth = {
      probeLocalhostReachable,
      openForgotPassword,
    }
    const setStatus = vi.fn()
    renderAuthPage({ email: ' Person@Example.COM ', setStatus })

    const forgotPasswordButton = screen.getByRole('button', { name: 'Forgot password' })
    expect(forgotPasswordButton.classList.contains('ant-btn-variant-text')).toBe(true)
    expect(forgotPasswordButton.querySelector('.ant-typography-secondary')).not.toBeNull()

    await user.click(forgotPasswordButton)
    expect(openForgotPassword).toHaveBeenCalledWith('person@example.com')
    expect(
      (screen.getByRole('button', { name: 'Forgot password' }) as HTMLButtonElement).disabled
    ).toBe(true)
    resolveForgotPassword()
    await screen.findByRole('button', { name: 'Forgot password' })
    expect(
      (screen.getByRole('button', { name: 'Forgot password' }) as HTMLButtonElement).disabled
    ).toBe(false)
    expect(setStatus).toHaveBeenCalledWith('Password reset opened in your browser.', 'success')

    const rejected = vi.fn().mockRejectedValue(new Error('browser unavailable'))
    ;(window as unknown as { clerum: { auth: Record<string, unknown> } }).clerum.auth = {
      probeLocalhostReachable,
      openForgotPassword: rejected,
    }
    await user.click(screen.getByRole('button', { name: 'Forgot password' }))
    expect(setStatus).toHaveBeenCalledWith('Password reset could not be opened.', 'error')
  })

  it('retains the backend warning and disables its retry action while busy', () => {
    renderAuthPage({
      busy: true,
      backendSwitchHint: {
        targetOptionId: LOCALHOST_RUNTIME_CONFIG_OPTION_ID,
        targetLabel: 'Localhost',
        activeLabel: 'Production',
      },
    })

    expect(screen.getByText(/Couldn’t reach/)).toBeTruthy()
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: /Switch to Localhost & retry/ }) as HTMLButtonElement)
        .disabled
    ).toBe(true)
  })
})
