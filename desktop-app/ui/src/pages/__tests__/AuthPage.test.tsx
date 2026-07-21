// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { LOCALHOST_RUNTIME_CONFIG_OPTION_ID } from '../../constants/runtimeConfig'
import { AuthContext } from '../../contexts/AuthContext'
import type { AuthContextValue } from '../../contexts/AuthContext'
import { AuthPage } from '../AuthPage'

afterEach(() => {
  cleanup()
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
  it('asks for invitation email when no environment is configured', async () => {
    const user = userEvent.setup()
    const handleStartDesktopSetup = vi.fn()
    const setEmail = vi.fn()

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
      setEmail,
      handleStartDesktopSetup,
    })

    expect(screen.getByLabelText('Email')).toBeTruthy()
    expect(screen.queryByLabelText('Password')).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Continue setup' }))

    expect(handleStartDesktopSetup).toHaveBeenCalledTimes(1)
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

  it('shows localhost in the environment menu even when no options are configured', async () => {
    const user = userEvent.setup()
    const handleSelectRuntimeConfig = vi.fn()

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

    expect(screen.getByRole('button', { name: 'Localhost' })).toBeTruthy()
    expect(
      screen.getByRole('button', { name: 'Localhost' }).getAttribute('aria-current')
    ).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Localhost' }))

    expect(handleSelectRuntimeConfig).toHaveBeenCalledWith(LOCALHOST_RUNTIME_CONFIG_OPTION_ID)
  })
})
