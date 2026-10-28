// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ConfigProvider } from 'antd'
import { AuthContext } from '../../contexts/AuthContext'
import type { AuthContextValue } from '../../contexts/AuthContext'
import { installAntdDomEnvironment } from '../../test/antdDomEnvironment'
import { AuthPage } from '../AuthPage'

afterEach(() => {
  cleanup()
})

beforeEach(() => {
  installAntdDomEnvironment()
  ;(window as unknown as { clerum: unknown }).clerum = {
    auth: { probeLocalhostReachable: vi.fn().mockResolvedValue(false) },
  }
})

const makeAuthValue = (overrides: Partial<AuthContextValue> = {}) =>
  ({
    busy: false,
    isAuthenticated: false,
    email: '',
    password: '',
    runtimeConfigSetupName: '',
    runtimeConfigSetupExternalRestApiBaseUrl: '',
    authTransitioning: false,
    backendSwitchHint: null,
    runtimeConfigState: {
      configured: true,
      isLocalhost: false,
      selectorVisible: true,
      activeOptionId: null,
      envKey: 'env-test-key',
      storagePath: '/tmp/evenfire-runtime-config',
      options: [],
    },
    setEmail: vi.fn(),
    setPassword: vi.fn(),
    setRuntimeConfigSetupName: vi.fn(),
    setRuntimeConfigSetupExternalRestApiBaseUrl: vi.fn(),
    setStatus: vi.fn(),
    handlePasswordLogin: vi.fn().mockResolvedValue(undefined),
    handleSwitchLoginBackend: vi.fn().mockResolvedValue(undefined),
    handleSaveRuntimeConfig: vi.fn().mockResolvedValue(null),
    handleDeleteRuntimeConfig: vi.fn().mockResolvedValue(undefined),
    handleSelectRuntimeConfig: vi.fn().mockResolvedValue(null),
    handleClearRuntimeConfigSelection: vi.fn().mockResolvedValue(null),
    ...overrides,
  }) as unknown as AuthContextValue

function renderAuthPage(auth: Partial<AuthContextValue> = {}) {
  return render(
    <AuthContext.Provider value={makeAuthValue(auth)}>
      <ConfigProvider theme={{ token: { motion: false } }}>
        <AuthPage />
      </ConfigProvider>
    </AuthContext.Provider>
  )
}

interface AuthActions {
  startTransition: () => void
  failLogin: () => void
}

function StatefulAuthPage({ actions }: { actions: AuthActions }) {
  const [busy, setBusy] = useState(false)
  const [authTransitioning, setAuthTransitioning] = useState(false)
  const [isAuthenticated, setIsAuthenticated] = useState(false)

  const handlePasswordLogin = async () => {
    setBusy(true)
    setAuthTransitioning(true)
  }

  actions.startTransition = () => {
    setBusy(true)
    setAuthTransitioning(true)
  }
  actions.failLogin = () => {
    setBusy(false)
    setAuthTransitioning(false)
    setIsAuthenticated(false)
  }

  return (
    <AuthContext.Provider
      value={makeAuthValue({
        busy,
        authTransitioning,
        isAuthenticated,
        email: 'person@example.com',
        password: 'secret',
        handlePasswordLogin,
      })}
    >
      <ConfigProvider theme={{ token: { motion: false } }}>
        <AuthPage />
      </ConfigProvider>
    </AuthContext.Provider>
  )
}

describe('AuthPage busy controls', () => {
  it('disables credential inputs and prevents opening the environment selector while busy', async () => {
    const user = userEvent.setup()
    const setEmail = vi.fn()
    const setPassword = vi.fn()
    renderAuthPage({
      busy: true,
      email: 'person@example.com',
      password: 'secret',
      setEmail,
      setPassword,
    })

    const email = screen.getByRole('textbox', { name: 'Email' }) as HTMLInputElement
    const password = screen.getByLabelText('Password') as HTMLInputElement
    const environmentSwitch = screen.getByRole('button', {
      name: 'Open environment selector',
    }) as HTMLButtonElement

    expect(email.disabled).toBe(true)
    expect(password.disabled).toBe(true)
    expect(environmentSwitch.disabled).toBe(true)

    await user.type(email, 'ignored@example.com')
    await user.type(password, 'ignored')
    await user.click(environmentSwitch)

    expect(setEmail).not.toHaveBeenCalled()
    expect(setPassword).not.toHaveBeenCalled()
    expect(environmentSwitch.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('Environment')).toBeNull()
  })

  it('closes an open environment menu when authentication begins', async () => {
    const user = userEvent.setup()
    const actions: AuthActions = { startTransition: () => {}, failLogin: () => {} }
    render(<StatefulAuthPage actions={actions} />)

    const environmentSwitch = screen.getByRole('button', {
      name: 'Open environment selector',
    }) as HTMLButtonElement
    await user.click(environmentSwitch)
    expect(environmentSwitch.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('Environment')).toBeTruthy()

    act(() => actions.startTransition())

    await waitFor(() => expect(environmentSwitch.disabled).toBe(true))
    expect(environmentSwitch.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('button', { name: 'Add environment' })).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('main')))
  })

  it('does not steal sign-in status focus when an open menu was left for the form', async () => {
    const user = userEvent.setup()
    const actions: AuthActions = { startTransition: () => {}, failLogin: () => {} }
    render(<StatefulAuthPage actions={actions} />)

    const environmentSwitch = screen.getByRole('button', {
      name: 'Open environment selector',
    }) as HTMLButtonElement
    const password = screen.getByLabelText('Password') as HTMLInputElement
    await user.click(environmentSwitch)
    password.focus()
    await user.keyboard('{Enter}')

    const status = screen.getByRole('status')
    await waitFor(() => expect(environmentSwitch.disabled).toBe(true))
    expect(environmentSwitch.getAttribute('aria-expanded')).toBe('false')
    await waitFor(() => expect(document.activeElement).toBe(status))
  })

  it('moves focus from a focused closed environment trigger when authentication begins', async () => {
    const actions: AuthActions = { startTransition: () => {}, failLogin: () => {} }
    render(<StatefulAuthPage actions={actions} />)

    const environmentSwitch = screen.getByRole('button', {
      name: 'Open environment selector',
    }) as HTMLButtonElement
    environmentSwitch.focus()
    expect(environmentSwitch.getAttribute('aria-expanded')).toBe('false')

    act(() => actions.startTransition())

    await waitFor(() => expect(environmentSwitch.disabled).toBe(true))
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('main')))
  })

  it('announces sign-in progress and restores password focus after a failed login', async () => {
    const user = userEvent.setup()
    const actions: AuthActions = { startTransition: () => {}, failLogin: () => {} }
    render(<StatefulAuthPage actions={actions} />)

    const email = screen.getByRole('textbox', { name: 'Email' }) as HTMLInputElement
    const password = screen.getByLabelText('Password') as HTMLInputElement
    password.focus()
    await user.keyboard('{Enter}')

    await waitFor(() => expect(email.disabled).toBe(true))
    expect(password.disabled).toBe(true)
    const status = screen.getByRole('status')
    expect(status.textContent).toContain('Signing in...')
    expect(status.getAttribute('aria-live')).toBe('polite')
    expect(status.closest('button')).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(status))

    act(() => actions.failLogin())

    await waitFor(() => expect(password.disabled).toBe(false))
    await waitFor(() => expect(document.activeElement).toBe(password))
  })
})
