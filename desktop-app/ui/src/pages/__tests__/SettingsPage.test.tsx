// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StyleProvider, createCache } from '@ant-design/cssinjs'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  DESKTOP_COMMANDS,
  formatDesktopShortcut,
  platformFromNavigator,
} from '../../../../src/desktopCommands'
import { AuthContext } from '../../contexts/AuthContext'
import type { AuthContextValue } from '../../contexts/AuthContext'
import { installAntdDomEnvironment } from '../../test/antdDomEnvironment'
import { SettingsPage } from '../SettingsPage'
import type { SettingsPageProps } from '../SettingsPage.types'

const makeAuthValue = (overrides: Partial<AuthContextValue> = {}): AuthContextValue => ({
  booting: false,
  busy: false,
  statusText: 'Ready.',
  statusTone: 'info',
  isAuthenticated: true,
  me: {
    id: 'user-1',
    email: 'user@example.com',
    name: 'User',
    picture: null,
    teamId: null,
    teamName: null,
    role: null,
  },
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
  backendSwitchHint: null,
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
  onSaveNotificationSettings: vi.fn(async () => 'default' as const),
  channelNotificationPreferences: {
    preferredMedium: null,
    channelFallbackEnabled: false,
    verifiedMedia: [],
  },
  channelNotificationPreferencesLoading: false,
  channelNotificationPreferencesSaving: false,
  onSaveChannelNotificationPreferences: vi.fn(async () => undefined),
}

function renderSettingsPage(
  auth?: Partial<AuthContextValue>,
  props: Partial<SettingsPageProps> = {}
) {
  return render(
    <AuthContext.Provider value={makeAuthValue(auth)}>
      <SettingsPage {...defaultSettingsProps} {...props} />
    </AuthContext.Provider>
  )
}

describe('SettingsPage', () => {
  beforeEach(() => {
    installAntdDomEnvironment()
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        socialChannels: {
          getSummary: vi.fn(async () => ({ targets: [], accounts: [] })),
        },
        pluginSdk: {
          listGrants: vi.fn(async () => []),
          activity: vi.fn(async () => []),
          revoke: vi.fn(async () => undefined),
          clearActivity: vi.fn(async () => undefined),
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

    const informationTable = screen.getByRole('table')
    const informationRows = within(informationTable)
      .getAllByRole('row')
      .map(row => [
        within(row).getByRole('rowheader').textContent,
        within(row).getByRole('cell').textContent,
      ])
    expect(screen.queryByRole('columnheader')).toBeNull()
    expect(informationRows).toHaveLength(13)
    expect(informationRows.slice(0, 12)).toEqual([
      ['Desktop app version', '0.1.249'],
      ['External REST API URL', 'http://127.0.0.1:8091'],
      ['External REST API version', '0.1.50'],
      ['RPC proxy URL', 'http://127.0.0.1:8094'],
      ['RPC proxy version', '0.1.36'],
      ['Release ID', 'master-abc123'],
      ['Desktop target version', '0.1.250'],
      ['Minimum desktop version', '0.1.250'],
      ['Update required', 'Yes'],
      ['Release URL', 'https://github.com/your-org/evenfire/releases/tag/desktop-app-0.1.250'],
      ['External REST API health', 'OK'],
      ['RPC proxy health', 'OK'],
    ])
    expect(informationRows[12]?.[0]).toBe('Last checked')
    expect(informationRows[12]?.[1]).not.toBe('Not checked')
    expect(
      Array.from(
        informationTable.querySelectorAll<HTMLElement>(
          '.ant-table-tbody > tr > th, .ant-table-tbody > tr > td'
        )
      ).every(cell => cell.style.border === '0px')
    ).toBe(true)

    expect(screen.queryByRole('button', { name: 'Endpoint' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Add custom endpoint' })).toBeNull()
    expect(await screen.findByText('0.1.249')).toBeTruthy()
    expect(screen.getByText('0.1.50')).toBeTruthy()
    expect(screen.getByText('0.1.36')).toBeTruthy()
    expect(screen.getByText('http://127.0.0.1:8091')).toBeTruthy()
    expect(screen.getByText('http://127.0.0.1:8094')).toBeTruthy()

    expect(vi.mocked(window.clerum.auth.getDesktopReleaseStatus)).toHaveBeenCalledTimes(1)
  })

  it('renders the read-only Shortcuts tab from the authoritative registry', async () => {
    const user = userEvent.setup()
    renderSettingsPage()

    await user.click(screen.getByRole('tab', { name: 'Shortcuts' }))

    const visibleCommands = DESKTOP_COMMANDS.filter(
      command => command.visibleInSettings && command.defaultBinding
    )
    expect(screen.getAllByRole('row')).toHaveLength(visibleCommands.length + 1)
    const platform = platformFromNavigator(navigator.platform)
    for (const command of visibleCommands) {
      expect(screen.getByText(command.label)).toBeTruthy()
      expect(
        screen.getAllByText(formatDesktopShortcut(command.defaultBinding!, platform)).length
      ).toBeGreaterThan(0)
    }
    expect(screen.queryByRole('button', { name: /save|reset/i })).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('opens Shortcuts when requested by a registered command', () => {
    render(
      <AuthContext.Provider value={makeAuthValue()}>
        <SettingsPage {...defaultSettingsProps} shortcutsFocusRequestId={1} />
      </AuthContext.Provider>
    )
    expect(screen.getByRole('tabpanel', { name: 'Shortcuts' })).toBeTruthy()
  })

  it('routes the theme selection through the existing theme owner', async () => {
    const user = userEvent.setup()
    const onThemeModeChange = vi.fn()
    renderSettingsPage(undefined, { onThemeModeChange })

    await user.click(screen.getByRole('tab', { name: 'Appearance' }))
    await user.click(screen.getByRole('radio', { name: /Light/ }))

    expect(onThemeModeChange).toHaveBeenCalledWith('light')
  })

  it('saves notification choices through the existing save callback', async () => {
    const user = userEvent.setup()
    const onSaveNotificationSettings = vi.fn(async () => 'granted' as const)
    const onNotify = vi.fn()
    renderSettingsPage(undefined, { onSaveNotificationSettings, onNotify })

    await user.click(screen.getByRole('tab', { name: 'Notifications' }))
    await user.click(
      screen.getAllByRole('radio', { name: /Show while I'm elsewhere in Evenfire/ })[0]!
    )
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(onSaveNotificationSettings).toHaveBeenCalledWith(
      {
        ...defaultSettingsProps.notificationSettings,
        inApp: 'when_app_focused_away_from_chat',
      },
      { requestDesktopPermission: false }
    )
    expect(onNotify).toHaveBeenCalledWith('In app notification settings saved.', 'success')
  })

  it('requests desktop notification permission only through the existing desktop save action', async () => {
    const user = userEvent.setup()
    const onSaveNotificationSettings = vi.fn(async () => 'denied' as const)
    const onNotify = vi.fn()
    renderSettingsPage(undefined, { onSaveNotificationSettings, onNotify })

    await user.click(screen.getByRole('tab', { name: 'Notifications' }))
    await user.click(
      screen.getByRole('radio', { name: /Desktop notifications Always show notifications/ })
    )
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(onSaveNotificationSettings).toHaveBeenCalledWith(
      { ...defaultSettingsProps.notificationSettings, desktop: 'always' },
      { requestDesktopPermission: true }
    )
    expect(onNotify).toHaveBeenCalledWith(
      'Settings saved. Desktop notifications are blocked by system permission.',
      'error'
    )
  })

  it('saves the verified fallback channel through the existing preference owner', async () => {
    const user = userEvent.setup()
    const onSaveChannelNotificationPreferences = vi.fn(async () => undefined)
    renderSettingsPage(undefined, {
      channelNotificationPreferences: {
        preferredMedium: null,
        channelFallbackEnabled: false,
        verifiedMedia: ['telegram', 'slack'],
      },
      onSaveChannelNotificationPreferences,
    })

    await user.click(screen.getByRole('tab', { name: 'Notifications' }))
    const channelSelect = screen.getByRole('combobox', { name: 'Preferred fallback channel' })
    await user.click(channelSelect)
    fireEvent.keyDown(channelSelect, { key: 'ArrowDown', keyCode: 40, which: 40 })
    fireEvent.keyDown(channelSelect, { key: 'Enter', keyCode: 13, which: 13 })
    await user.click(
      screen.getByRole('checkbox', {
        name: 'Allow Telegram/Slack fallback when desktop delivery is unavailable',
      })
    )
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(onSaveChannelNotificationPreferences).toHaveBeenCalledWith({
      preferredMedium: 'telegram',
      channelFallbackEnabled: true,
    })
  })

  it('disables notification submission while the existing save is pending', async () => {
    const user = userEvent.setup()
    let resolveSave: ((permission: 'default') => void) | undefined
    const onSaveNotificationSettings = vi.fn(
      () =>
        new Promise<'default'>(resolve => {
          resolveSave = resolve
        })
    )
    renderSettingsPage(undefined, { onSaveNotificationSettings })

    await user.click(screen.getByRole('tab', { name: 'Notifications' }))
    await user.click(
      screen.getAllByRole('radio', { name: /Show while I'm elsewhere in Evenfire/ })[0]!
    )
    const saveButton = screen.getByRole('button', { name: 'Save changes' })
    await user.click(saveButton)

    const savingButton = screen.getByRole('button', { name: 'Saving...' })
    expect(savingButton.hasAttribute('disabled')).toBe(true)
    expect(onSaveNotificationSettings).toHaveBeenCalledTimes(1)

    resolveSave?.('default')
  })

  it('retains volume ownership and previews the normalized value on Enter', async () => {
    const user = userEvent.setup()
    const onNotificationSoundVolumeChange = vi.fn()
    const onPlayNotificationSoundPreview = vi.fn()
    function StatefulVolumeSettingsPage() {
      const [volume, setVolume] = useState(defaultSettingsProps.notificationSettings.soundVolume)
      return (
        <AuthContext.Provider value={makeAuthValue()}>
          <SettingsPage
            {...defaultSettingsProps}
            notificationSettings={{
              ...defaultSettingsProps.notificationSettings,
              soundVolume: volume,
            }}
            onNotificationSoundVolumeChange={value => {
              onNotificationSoundVolumeChange(value)
              setVolume(value)
            }}
            onPlayNotificationSoundPreview={onPlayNotificationSoundPreview}
          />
        </AuthContext.Provider>
      )
    }
    render(<StatefulVolumeSettingsPage />)

    await user.click(screen.getByRole('tab', { name: 'Notifications' }))
    const volumeInput = screen.getByRole('spinbutton', {
      name: 'Notification sound volume percentage',
    })
    await user.clear(volumeInput)
    await user.type(volumeInput, '70')
    expect((volumeInput as HTMLInputElement).value).toBe('70')
    expect(onNotificationSoundVolumeChange).toHaveBeenCalledWith(70)
    await user.keyboard('{Enter}')

    expect(onNotificationSoundVolumeChange).toHaveBeenLastCalledWith(70)
    expect(onPlayNotificationSoundPreview).toHaveBeenLastCalledWith(70)

    const slider = screen.getByRole('slider')
    expect(slider.closest('.ant-slider')?.parentElement?.style.flexGrow).toBe('1')
    slider.focus()
    expect(document.activeElement).toBe(slider)
    fireEvent.keyDown(slider, { key: 'ArrowRight', keyCode: 39, which: 39 })
    fireEvent.keyUp(slider, { key: 'ArrowRight', keyCode: 39, which: 39 })
    expect(slider.getAttribute('aria-valuenow')).toBe('71')
    expect(onNotificationSoundVolumeChange).toHaveBeenLastCalledWith(71)
    expect(onPlayNotificationSoundPreview).toHaveBeenLastCalledWith(71)
  })

  it('separates the notification setting sections', async () => {
    const user = userEvent.setup()
    renderSettingsPage()

    await user.click(screen.getByRole('tab', { name: 'Notifications' }))

    const section = screen.getByRole('heading', { name: 'In App Notifications' }).closest('section')
    expect(section?.classList.contains('ant-flex-gap-small')).toBe(true)
  })

  it('applies aligned title spacing to every titled settings tab', async () => {
    const titledTabs = [
      { tab: 'Account', headings: ['Account'], iconAligned: true },
      { tab: 'Appearance', headings: ['Theme'], iconAligned: true },
      {
        tab: 'Notifications',
        headings: [
          'In App Notifications',
          'Desktop notifications',
          'Channel fallback',
          'Notification sound',
        ],
        iconAligned: true,
      },
      { tab: 'Plugin permissions', headings: ['Plugin permissions'], iconAligned: false },
      { tab: 'Shortcuts', headings: ['Keyboard shortcuts'], iconAligned: true },
      { tab: 'Social channels', headings: ['Social channels'], iconAligned: true },
    ]
    vi.mocked(window.clerum.socialChannels.getSummary).mockResolvedValue({
      targets: [
        {
          id: 'social-target-1',
          medium: 'telegram',
          agentName: 'Agent',
          channelName: 'Channel',
          botLabel: 'Bot',
          botUsername: null,
          status: 'ready',
        },
      ],
      accounts: [],
    })

    for (const { tab, headings, iconAligned } of titledTabs) {
      const user = userEvent.setup()
      const styleContainer = document.createElement('div')
      document.body.append(styleContainer)
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
      const view = render(
        <StyleProvider cache={createCache()} container={styleContainer}>
          <QueryClientProvider client={queryClient}>
            <AuthContext.Provider value={makeAuthValue()}>
              <SettingsPage {...defaultSettingsProps} />
            </AuthContext.Provider>
          </QueryClientProvider>
        </StyleProvider>
      )

      try {
        if (tab !== 'Account') {
          const tabElement =
            tab === 'Social channels'
              ? await screen.findByRole('tab', { name: tab })
              : screen.getByRole('tab', { name: tab })
          await user.click(tabElement)
        }

        for (const name of headings) {
          const heading = screen.getByRole('heading', { name })
          if (iconAligned) {
            expect(heading.parentElement?.classList.contains('ant-flex-align-center')).toBe(true)
          }
        }

        const typographyStyles = Array.from(styleContainer.querySelectorAll('style'))
          .map(style => style.textContent)
          .join('\n')
        expect(typographyStyles).toContain('--ant-typography-title-margin-top:0px')
        expect(typographyStyles).toContain('--ant-typography-title-margin-bottom:0px')
      } finally {
        view.unmount()
        queryClient.clear()
        styleContainer.remove()
      }
    }
  })
})
