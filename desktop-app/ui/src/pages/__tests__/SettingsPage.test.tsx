// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AuthContext } from '../../contexts/AuthContext'
import type { AuthContextValue } from '../../contexts/AuthContext'
import { SettingsPage } from '../SettingsPage'
import type { SettingsPageProps } from '../SettingsPage.types'

const makeAuthValue = (overrides: Partial<AuthContextValue> = {}): AuthContextValue => ({
  booting: false,
  busy: false,
  statusText: 'Ready.',
  statusTone: 'info',
  isAuthenticated: true,
  me: { email: 'user@example.com', name: 'User' },
  email: 'user@example.com',
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
  runtimeConfigMissing: true,
  showRuntimeConfigSelector: true,
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

const defaultSettingsProps: SettingsPageProps = {
  notificationSettings: {
    inApp: 'always',
    desktop: 'when_app_unfocused',
    soundVolume: 50,
  },
  desktopNotificationPermission: 'default',
  themeMode: 'dark',
  onNotify: vi.fn(),
  onThemeModeChange: vi.fn(),
  onNotificationSoundVolumeChange: vi.fn(),
  onPlayNotificationSoundPreview: vi.fn(),
  onSaveNotificationSettings: vi.fn(async () => 'default'),
  channelNotificationPreferences: {
    preferredMedium: null,
    channelFallbackEnabled: false,
    verifiedMedia: [],
  },
  channelNotificationPreferencesLoading: false,
  channelNotificationPreferencesSaving: false,
  onSaveChannelNotificationPreferences: vi.fn(async () => undefined),
}

function renderSettingsPage(auth?: Partial<AuthContextValue>) {
  return render(
    <AuthContext.Provider value={makeAuthValue(auth)}>
      <SettingsPage {...defaultSettingsProps} />
    </AuthContext.Provider>
  )
}

describe('SettingsPage', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        socialChannels: {
          getSummary: vi.fn(async () => ({ targets: [], accounts: [] })),
        },
        auth: {
          getDesktopAppInfo: vi.fn(async () => ({
            appName: 'Evenfire',
            version: '0.1.249',
            isPackaged: false,
          })),
          getDesktopReleaseStatus: vi.fn(async () => ({
            checked: true,
            currentVersion: '0.1.249',
            latestVersion: '0.1.250',
            minimumVersion: '0.1.250',
            updateRequired: true,
            releaseUrl: 'https://github.com/your-org/evenfire/releases/tag/desktop-app-0.1.250',
            releaseId: 'master-abc123',
            releaseTag: 'desktop-app-0.1.250',
            externalRestApiVersion: '0.1.50',
            rpcProxyVersion: '0.1.36',
          })),
          getDependenciesHealth: vi.fn(async () => ({
            externalRestApi: { ok: true },
            rpcProxy: { ok: true },
          })),
        },
      },
    })
  })

  afterEach(() => {
    cleanup()
    delete (window as { clerum?: unknown }).clerum
    vi.clearAllMocks()
  })

  it('shows endpoint diagnostics instead of the endpoint selector', async () => {
    const user = userEvent.setup()

    renderSettingsPage({
      runtimeConfigState: {
        configured: true,
        isLocalhost: true,
        selectorVisible: true,
        activeOptionId: '__localhost__',
        envKey: 'env-test-key',
        storagePath: '/tmp/evenfire-runtime-config',
        options: [
          {
            id: '__localhost__',
            label: 'Localhost',
            source: 'localhost',
            configPath: null,
            externalRestApiBaseUrl: 'http://127.0.0.1:8091',
            rpcProxyBaseUrl: 'http://127.0.0.1:8094',
            appName: 'Evenfire',
          },
        ],
      },
    })

    await user.click(screen.getByRole('tab', { name: 'Information' }))

    expect(screen.queryByRole('button', { name: 'Endpoint' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Add custom endpoint' })).toBeNull()
    expect(await screen.findByText('0.1.249')).toBeTruthy()
    expect(screen.getByText('0.1.50')).toBeTruthy()
    expect(screen.getByText('0.1.36')).toBeTruthy()
    expect(screen.getByText('http://127.0.0.1:8091')).toBeTruthy()
    expect(screen.getByText('http://127.0.0.1:8094')).toBeTruthy()

    const auth = (window.clerum as { auth: { getDesktopReleaseStatus: ReturnType<typeof vi.fn> } })
      .auth
    expect(auth.getDesktopReleaseStatus).toHaveBeenCalledTimes(1)
  })
})
