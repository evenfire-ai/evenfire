import { type FormEvent, useEffect, useMemo, useState } from 'react'
import {
  ApiOutlined,
  AudioMutedOutlined,
  BellOutlined,
  DesktopOutlined,
  SettingOutlined,
  SoundOutlined,
  SunOutlined,
} from '@ant-design/icons'
import { useAuthContext } from '@contexts/AuthContext'
import {
  Alert,
  Button,
  Card,
  Checkbox,
  ConfigProvider,
  Descriptions,
  Flex,
  InputNumber,
  Radio,
  Select,
  Slider,
  Table,
  Tabs,
  Typography,
} from 'antd'
import { PluginPermissions } from '@components/PluginPermissions'
import { NOTIFICATION_PREFERENCE_OPTIONS } from '@constants/notificationSettings'
import {
  LOCALHOST_RUNTIME_CONFIG_OPTION_ID,
  createLocalhostRuntimeConfigOption,
} from '@constants/runtimeConfig'
import { THEME_MODE_OPTIONS } from '@constants/theme'
import { sanitizeNotificationVolume } from '@lib/notifications'
import type {
  ChatNotificationPreference,
  DesktopNotificationPermission,
  ThemeMode,
  Tone,
} from '@/uiTypes'
import {
  DESKTOP_COMMANDS,
  formatDesktopShortcut,
  platformFromNavigator,
} from '../../../src/desktopCommands'
import type {
  DependencyHealth,
  DesktopAppInfo,
  DesktopReleaseStatus,
  ExternalChannelsSummary,
  ProfileSettingsOpenOptions,
} from '../../../src/types'
import type { SettingsPageProps } from './SettingsPage.types'

type NotificationPreferenceSection = 'inApp' | 'desktop'
type SettingsTab =
  | 'account'
  | 'appearance'
  | 'notifications'
  | 'plugins'
  | 'shortcuts'
  | 'social'
  | 'information'

type EndpointDiagnostics = {
  appInfo: DesktopAppInfo | null
  releaseStatus: DesktopReleaseStatus | null
  dependencyHealth: DependencyHealth | null
  releaseError: string
  healthError: string
  checkedAt: string | null
  loading: boolean
}

const SETTINGS_TITLE_THEME = {
  components: {
    Typography: {
      titleMarginTop: 0,
      titleMarginBottom: 0,
    },
  },
}

function getPermissionLabel(permission: DesktopNotificationPermission): string {
  if (permission === 'granted') return 'Desktop notification permission granted.'
  if (permission === 'denied') return 'Desktop notifications are blocked by system permission.'
  if (permission === 'unsupported') return 'Desktop notifications are not available here.'
  return 'Desktop notification permission has not been requested.'
}

function getSaveToast(
  permission: DesktopNotificationPermission,
  section: NotificationPreferenceSection
): {
  text: string
  tone: Tone
} {
  if (section === 'inApp') {
    return { text: 'In app notification settings saved.', tone: 'success' }
  }
  if (permission === 'denied') {
    return {
      text: 'Settings saved. Desktop notifications are blocked by system permission.',
      tone: 'error',
    }
  }
  if (permission === 'unsupported') {
    return {
      text: 'Settings saved. Desktop notifications are not available in this environment.',
      tone: 'info',
    }
  }
  if (permission === 'default') {
    return {
      text: 'Settings saved. Desktop notification permission has not been granted yet.',
      tone: 'info',
    }
  }
  return { text: 'Notification settings saved.', tone: 'success' }
}

function NotificationPreferenceField({
  id,
  labelledBy,
  value,
  onChange,
}: {
  id: string
  labelledBy: string
  value: ChatNotificationPreference
  onChange: (value: ChatNotificationPreference) => void
}) {
  return (
    <Radio.Group
      aria-labelledby={labelledBy}
      name={id}
      value={value}
      onChange={event => onChange(event.target.value)}
    >
      <Flex vertical gap="small">
        {NOTIFICATION_PREFERENCE_OPTIONS.map(option => (
          <Radio
            key={option.value}
            id={`${id}-${option.value}`}
            value={option.value}
            title={option.description}
            aria-labelledby={`${labelledBy} ${id}-${option.value}-title`}
            aria-describedby={`${id}-${option.value}-description`}
          >
            <span id={`${id}-${option.value}-title`}>{option.label}</span>
            <span id={`${id}-${option.value}-description`} className="visually-hidden">
              {option.description}
            </span>
          </Radio>
        ))}
      </Flex>
    </Radio.Group>
  )
}

function ThemePreferenceField({
  id,
  labelledBy,
  value,
  onChange,
}: {
  id: string
  labelledBy: string
  value: ThemeMode
  onChange: (value: ThemeMode) => void
}) {
  return (
    <Radio.Group
      aria-labelledby={labelledBy}
      name={id}
      value={value}
      onChange={event => onChange(event.target.value)}
    >
      <Flex vertical gap="small">
        {THEME_MODE_OPTIONS.map(option => (
          <Radio
            key={option.value}
            id={`${id}-${option.value}`}
            value={option.value}
            title={option.description}
            aria-labelledby={`${labelledBy} ${id}-${option.value}-title`}
            aria-describedby={`${id}-${option.value}-description`}
          >
            <span id={`${id}-${option.value}-title`}>{option.label}</span>
            <span id={`${id}-${option.value}-description`} className="visually-hidden">
              {option.description}
            </span>
          </Radio>
        ))}
      </Flex>
    </Radio.Group>
  )
}

function NotificationSoundVolumeField({
  value,
  onChange,
  onPreview,
}: {
  value: number
  onChange: (value: number) => void
  onPreview: (value: number) => void
}) {
  const volume = sanitizeNotificationVolume(value)
  const volumeLabel = volume === 0 ? 'Muted' : `${volume}%`
  const applyVolume = (nextValue: string | number, options: { preview?: boolean } = {}) => {
    const nextVolume = sanitizeNotificationVolume(nextValue)
    onChange(nextVolume)
    if (options.preview) onPreview(nextVolume)
  }

  return (
    <Flex align="center" gap="middle" wrap>
      <Typography.Text id="settings-notification-sound-label">Alert volume</Typography.Text>
      <Button
        aria-label={volume === 0 ? 'Notification sounds muted' : 'Mute notification sounds'}
        aria-pressed={volume === 0}
        htmlType="button"
        icon={volume === 0 ? <AudioMutedOutlined /> : <SoundOutlined />}
        onClick={() => onChange(0)}
      />
      <Flex flex={1}>
        <Slider
          className="settings-notification-volume-slider"
          ariaLabelledByForHandle="settings-notification-sound-label"
          ariaValueTextFormatterForHandle={() => volumeLabel}
          min={0}
          max={100}
          step={1}
          value={volume}
          onChange={nextVolume => applyVolume(nextVolume)}
          onChangeComplete={nextVolume => applyVolume(nextVolume, { preview: true })}
        />
      </Flex>
      <InputNumber
        className="settings-notification-volume-input"
        aria-label="Notification sound volume percentage"
        type="number"
        min={0}
        max={100}
        step={1}
        inputMode="numeric"
        value={volume}
        onChange={nextVolume => applyVolume(nextVolume ?? '')}
        onBlur={() => applyVolume(volume, { preview: true })}
        onPressEnter={() => applyVolume(volume, { preview: true })}
      />
    </Flex>
  )
}

function getDiagnosticErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || 'Unknown error')
}

function getVersionValue(value: string | null | undefined, options: { loading: boolean }): string {
  if (value) return value
  return options.loading ? 'Checking...' : 'Not reported'
}

function getHealthLabel(status: { ok: boolean; detail?: string } | undefined): string {
  if (!status) return 'Not checked'
  if (status.ok) return status.detail ? `OK - ${status.detail}` : 'OK'
  return status.detail ? `Failed - ${status.detail}` : 'Failed'
}

function socialChannelLabel(medium: string): string {
  const normalized = medium.trim().toLowerCase()
  if (normalized === 'telegram') return 'Telegram'
  if (normalized === 'slack') return 'Slack'
  return normalized ? normalized.charAt(0).toUpperCase() + normalized.slice(1) : 'Channel'
}

export function SettingsPage({
  shortcutsFocusRequestId = 0,
  notificationSettings,
  desktopNotificationPermission,
  themeMode,
  onNotify,
  onThemeModeChange,
  onNotificationSoundVolumeChange,
  onPlayNotificationSoundPreview,
  onSaveNotificationSettings,
  channelNotificationPreferences,
  channelNotificationPreferencesLoading,
  channelNotificationPreferencesSaving,
  onSaveChannelNotificationPreferences,
}: SettingsPageProps) {
  const { runtimeConfigState, me, email } = useAuthContext()
  const [draftSettings, setDraftSettings] = useState(notificationSettings)
  const [savingSection, setSavingSection] = useState<NotificationPreferenceSection | null>(null)
  const [activeSettingsTab, setActiveSettingsTab] = useState<SettingsTab>('account')
  const [endpointDiagnostics, setEndpointDiagnostics] = useState<EndpointDiagnostics>({
    appInfo: null,
    releaseStatus: null,
    dependencyHealth: null,
    releaseError: '',
    healthError: '',
    checkedAt: null,
    loading: false,
  })
  const [draftPreferredMedium, setDraftPreferredMedium] = useState<'telegram' | 'slack' | null>(
    channelNotificationPreferences.preferredMedium
  )
  const [draftChannelFallbackEnabled, setDraftChannelFallbackEnabled] = useState(
    channelNotificationPreferences.channelFallbackEnabled
  )
  const [socialChannelsSummary, setSocialChannelsSummary] = useState<ExternalChannelsSummary>({
    targets: [],
    accounts: [],
  })
  const [socialChannelsLoading, setSocialChannelsLoading] = useState(true)
  const shortcutPlatform = platformFromNavigator(navigator.platform)
  const shortcutCommands = DESKTOP_COMMANDS.filter(
    command => command.visibleInSettings && command.defaultBinding
  ).sort((left, right) => left.order - right.order)

  useEffect(() => {
    if (shortcutsFocusRequestId > 0) setActiveSettingsTab('shortcuts')
  }, [shortcutsFocusRequestId])

  const runtimeConfigOptions = runtimeConfigState?.options || []
  const activeRuntimeConfigId = runtimeConfigState?.activeOptionId ?? ''
  const activeRuntimeConfig =
    runtimeConfigOptions.find(option => option.id === activeRuntimeConfigId) ??
    (activeRuntimeConfigId === LOCALHOST_RUNTIME_CONFIG_OPTION_ID
      ? createLocalhostRuntimeConfigOption()
      : null)
  const availableSocialMedia = useMemo(
    () =>
      Array.from(
        new Set(
          socialChannelsSummary.targets
            .map(target => target.medium.trim().toLowerCase())
            .filter(Boolean)
        )
      ).sort((left, right) => left.localeCompare(right)),
    [socialChannelsSummary.targets]
  )
  const connectedSocialMedia = useMemo(() => {
    const authorizedTargetIds = new Set(socialChannelsSummary.targets.map(target => target.id))
    return new Set(
      socialChannelsSummary.accounts
        .filter(
          account =>
            !account.disabledAt &&
            (account.targets || []).some(target => authorizedTargetIds.has(target.id))
        )
        .map(account => account.medium.trim().toLowerCase())
        .filter(Boolean)
    )
  }, [socialChannelsSummary.accounts, socialChannelsSummary.targets])
  const hasSocialChannelsAccess = availableSocialMedia.length > 0

  useEffect(() => {
    setDraftSettings(previous => ({
      ...previous,
      inApp: notificationSettings.inApp,
      desktop: notificationSettings.desktop,
    }))
  }, [notificationSettings.inApp, notificationSettings.desktop])

  useEffect(() => {
    let cancelled = false
    setSocialChannelsLoading(true)
    void window.clerum.socialChannels
      .getSummary()
      .then(summary => {
        if (!cancelled) setSocialChannelsSummary(summary)
      })
      .catch(error => {
        console.warn('[SettingsPage] Could not load social channels', error)
        if (!cancelled) setSocialChannelsSummary({ targets: [], accounts: [] })
      })
      .finally(() => {
        if (!cancelled) setSocialChannelsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!socialChannelsLoading && !hasSocialChannelsAccess && activeSettingsTab === 'social') {
      setActiveSettingsTab('account')
    }
  }, [activeSettingsTab, hasSocialChannelsAccess, socialChannelsLoading])

  useEffect(() => {
    if (activeSettingsTab !== 'information') return undefined
    let cancelled = false

    setEndpointDiagnostics(previous => ({
      ...previous,
      loading: true,
      releaseError: '',
      healthError: '',
    }))

    const loadEndpointDiagnostics = async () => {
      const [appInfoResult, releaseStatusResult, healthResult] = await Promise.allSettled([
        window.clerum.auth.getDesktopAppInfo(),
        window.clerum.auth.getDesktopReleaseStatus(),
        window.clerum.auth.getDependenciesHealth(),
      ])
      if (cancelled) return

      setEndpointDiagnostics({
        appInfo: appInfoResult.status === 'fulfilled' ? appInfoResult.value : null,
        releaseStatus:
          releaseStatusResult.status === 'fulfilled' ? releaseStatusResult.value : null,
        dependencyHealth: healthResult.status === 'fulfilled' ? healthResult.value : null,
        releaseError:
          releaseStatusResult.status === 'rejected'
            ? getDiagnosticErrorMessage(releaseStatusResult.reason)
            : '',
        healthError:
          healthResult.status === 'rejected' ? getDiagnosticErrorMessage(healthResult.reason) : '',
        checkedAt: new Date().toLocaleString(),
        loading: false,
      })
    }

    void loadEndpointDiagnostics()

    return () => {
      cancelled = true
    }
  }, [activeRuntimeConfigId, activeSettingsTab])

  const hasInAppChanges = draftSettings.inApp !== notificationSettings.inApp
  const hasDesktopChanges = draftSettings.desktop !== notificationSettings.desktop
  const hasChannelPreferenceChanges =
    draftPreferredMedium !== channelNotificationPreferences.preferredMedium ||
    draftChannelFallbackEnabled !== channelNotificationPreferences.channelFallbackEnabled

  useEffect(() => {
    setDraftPreferredMedium(channelNotificationPreferences.preferredMedium)
    setDraftChannelFallbackEnabled(channelNotificationPreferences.channelFallbackEnabled)
  }, [
    channelNotificationPreferences.channelFallbackEnabled,
    channelNotificationPreferences.preferredMedium,
  ])

  const permissionLabel = useMemo(
    () => getPermissionLabel(desktopNotificationPermission),
    [desktopNotificationPermission]
  )

  const updateDraftSetting = (
    key: NotificationPreferenceSection,
    value: ChatNotificationPreference
  ) => {
    setDraftSettings(previous => ({ ...previous, [key]: value }))
  }

  const handleSubmit = async (
    event: FormEvent<HTMLFormElement>,
    key: NotificationPreferenceSection
  ) => {
    event.preventDefault()
    const hasChanges = key === 'inApp' ? hasInAppChanges : hasDesktopChanges
    if (!hasChanges || savingSection === key) return
    try {
      setSavingSection(key)
      const permission = await onSaveNotificationSettings(
        { ...notificationSettings, [key]: draftSettings[key] },
        { requestDesktopPermission: key === 'desktop' }
      )
      const toast = getSaveToast(permission, key)
      onNotify(toast.text, toast.tone)
    } catch (error) {
      onNotify(
        `Could not save notification settings: ${
          error instanceof Error ? error.message : String(error)
        }`,
        'error'
      )
    } finally {
      setSavingSection(null)
    }
  }

  const handleOpenProfileSettings = async (options?: ProfileSettingsOpenOptions) => {
    try {
      await window.clerum.auth.openProfileSettings(me?.email || email, options)
      onNotify('Profile settings opened in your browser.', 'success')
    } catch (error) {
      onNotify(
        `Could not open profile settings: ${error instanceof Error ? error.message : String(error)}`,
        'error'
      )
    }
  }

  const settingsContent = (
    <Flex vertical gap="middle">
      {activeSettingsTab === 'shortcuts' ? (
        <Card
          title={
            <Flex align="center" gap="small">
              <SettingOutlined aria-hidden="true" />
              <Typography.Title id="settings-shortcuts-heading" level={3}>
                Keyboard shortcuts
              </Typography.Title>
            </Flex>
          }
        >
          <Flex vertical gap="middle">
            <Typography.Text type="secondary">
              Desktop commands available from the keyboard.
            </Typography.Text>
            <Table
              aria-label="Keyboard shortcuts"
              columns={[
                {
                  title: 'Shortcut',
                  key: 'shortcut',
                  render: (_, command) => (
                    <kbd>{formatDesktopShortcut(command.defaultBinding!, shortcutPlatform)}</kbd>
                  ),
                },
                {
                  title: 'Action',
                  key: 'action',
                  render: (_, command) => (
                    <Flex vertical>
                      <Typography.Text strong>{command.label}</Typography.Text>
                      <Typography.Text type="secondary">{command.description}</Typography.Text>
                    </Flex>
                  ),
                },
              ]}
              dataSource={shortcutCommands}
              pagination={false}
              rowKey="id"
              size="small"
            />
          </Flex>
        </Card>
      ) : null}

      {activeSettingsTab === 'account' ? (
        <Card
          title={
            <Flex align="center" gap="small">
              <SettingOutlined aria-hidden="true" />
              <Typography.Title id="settings-account-heading" level={3}>
                Account
              </Typography.Title>
            </Flex>
          }
        >
          <Flex vertical gap="middle">
            <Typography.Text type="secondary">
              Manage your Evenfire account details in Profile UI.
            </Typography.Text>
            <Descriptions
              column={1}
              size="small"
              items={[
                {
                  key: 'account-name',
                  label: 'Account name',
                  children: me?.name || me?.email || 'Unknown account',
                },
                { key: 'email', label: 'Email', children: me?.email || email || 'No email' },
              ]}
            />
            <Flex gap="small" wrap>
              <Button
                htmlType="button"
                onClick={() =>
                  void handleOpenProfileSettings({ section: 'profile', action: 'password' })
                }
              >
                Update password
              </Button>
              <Button
                htmlType="button"
                onClick={() => void handleOpenProfileSettings({ section: 'profile' })}
                type="primary"
              >
                Edit
              </Button>
            </Flex>
          </Flex>
        </Card>
      ) : null}

      {activeSettingsTab === 'appearance' ? (
        <Card
          title={
            <Flex align="center" gap="small">
              <SunOutlined aria-hidden="true" />
              <Typography.Title id="settings-theme-heading" level={3}>
                Theme
              </Typography.Title>
            </Flex>
          }
        >
          <Flex vertical gap="middle">
            <Typography.Text type="secondary">Choose the desktop app color mode.</Typography.Text>
            <ThemePreferenceField
              id="settings-theme-mode"
              labelledBy="settings-theme-heading"
              value={themeMode}
              onChange={onThemeModeChange}
            />
          </Flex>
        </Card>
      ) : null}

      {activeSettingsTab === 'plugins' ? (
        <Flex vertical gap="middle">
          <PluginPermissions />
        </Flex>
      ) : null}

      {activeSettingsTab === 'notifications' ? (
        <Flex vertical gap="small" component="section">
          <form onSubmit={event => handleSubmit(event, 'inApp')}>
            <Card
              title={
                <Flex align="center" gap="small">
                  <BellOutlined aria-hidden="true" />
                  <Typography.Title id="settings-in-app-heading" level={3}>
                    In App Notifications
                  </Typography.Title>
                </Flex>
              }
            >
              <Flex vertical gap="middle">
                <Typography.Text type="secondary">
                  Choose when agent replies and app updates appear in the notification bell.
                </Typography.Text>
                <NotificationPreferenceField
                  id="settings-in-app-notifications"
                  labelledBy="settings-in-app-heading"
                  value={draftSettings.inApp}
                  onChange={value => updateDraftSetting('inApp', value)}
                />
                {hasInAppChanges ? (
                  <Button htmlType="submit" disabled={savingSection === 'inApp'} type="primary">
                    {savingSection === 'inApp' ? 'Saving...' : 'Save changes'}
                  </Button>
                ) : null}
              </Flex>
            </Card>
          </form>

          <form onSubmit={event => handleSubmit(event, 'desktop')}>
            <Card
              title={
                <Flex align="center" gap="small">
                  <DesktopOutlined aria-hidden="true" />
                  <Typography.Title id="settings-desktop-heading" level={3}>
                    Desktop notifications
                  </Typography.Title>
                </Flex>
              }
            >
              <Flex vertical gap="middle">
                <Typography.Text type="secondary">{permissionLabel}</Typography.Text>
                <NotificationPreferenceField
                  id="settings-desktop-notifications"
                  labelledBy="settings-desktop-heading"
                  value={draftSettings.desktop}
                  onChange={value => updateDraftSetting('desktop', value)}
                />
                {hasDesktopChanges ? (
                  <Button htmlType="submit" disabled={savingSection === 'desktop'} type="primary">
                    {savingSection === 'desktop' ? 'Saving...' : 'Save changes'}
                  </Button>
                ) : null}
              </Flex>
            </Card>
          </form>

          <Card
            title={
              <Flex align="center" gap="small">
                <BellOutlined aria-hidden="true" />
                <Typography.Title id="settings-channel-fallback-heading" level={3}>
                  Channel fallback
                </Typography.Title>
              </Flex>
            }
          >
            <Flex vertical gap="middle">
              <Typography.Text type="secondary">
                SDK workflow notifications are delivered to the desktop app first. Choose whether
                Telegram or Slack should receive them if the desktop app does not acknowledge in
                time.
              </Typography.Text>
              <Flex vertical gap="small">
                <label id="settings-preferred-medium-label" htmlFor="settings-preferred-medium">
                  Preferred fallback channel
                </label>
                <Select
                  id="settings-preferred-medium"
                  aria-labelledby="settings-preferred-medium-label"
                  value={draftPreferredMedium ?? ''}
                  disabled={
                    channelNotificationPreferencesLoading ||
                    channelNotificationPreferences.verifiedMedia.length === 0
                  }
                  options={[
                    {
                      value: '',
                      label:
                        channelNotificationPreferences.verifiedMedia.length > 1
                          ? 'Most recently verified channel'
                          : 'No verified channel',
                    },
                    ...channelNotificationPreferences.verifiedMedia.map(medium => ({
                      value: medium,
                      label: medium === 'telegram' ? 'Telegram' : 'Slack',
                    })),
                  ]}
                  onChange={value =>
                    setDraftPreferredMedium(
                      value === 'telegram' || value === 'slack' ? value : null
                    )
                  }
                />
              </Flex>
              <Checkbox
                checked={draftChannelFallbackEnabled}
                disabled={channelNotificationPreferencesLoading}
                onChange={event => setDraftChannelFallbackEnabled(event.target.checked)}
              >
                Allow Telegram/Slack fallback when desktop delivery is unavailable
              </Checkbox>
              {hasChannelPreferenceChanges ? (
                <Button
                  htmlType="button"
                  disabled={channelNotificationPreferencesSaving}
                  onClick={() =>
                    void onSaveChannelNotificationPreferences({
                      preferredMedium: draftPreferredMedium,
                      channelFallbackEnabled: draftChannelFallbackEnabled,
                    })
                  }
                  type="primary"
                >
                  {channelNotificationPreferencesSaving ? 'Saving...' : 'Save changes'}
                </Button>
              ) : null}
            </Flex>
          </Card>

          <Card
            className="settings-notification-sound-card"
            title={
              <Flex align="center" gap="small">
                <SoundOutlined aria-hidden="true" />
                <Typography.Title id="settings-notification-sound-heading" level={3}>
                  Notification sound
                </Typography.Title>
              </Flex>
            }
          >
            <Flex vertical gap="middle">
              <Typography.Text type="secondary">
                Manage the alert volume for notification sounds.
              </Typography.Text>
              <NotificationSoundVolumeField
                value={notificationSettings.soundVolume}
                onChange={onNotificationSoundVolumeChange}
                onPreview={onPlayNotificationSoundPreview}
              />
            </Flex>
          </Card>
        </Flex>
      ) : null}

      {activeSettingsTab === 'information' ? (
        <Card aria-label="Connection endpoints">
          <Flex vertical gap="middle">
            <Table
              bordered={false}
              columns={[
                {
                  key: 'label',
                  dataIndex: 'label',
                  rowScope: 'row',
                  render: (label: string) => (
                    <Typography.Text type="secondary">{label}</Typography.Text>
                  ),
                },
                { key: 'value', dataIndex: 'value' },
              ]}
              dataSource={[
                {
                  key: 'desktop-version',
                  label: 'Desktop app version',
                  value:
                    endpointDiagnostics.appInfo?.version ||
                    endpointDiagnostics.releaseStatus?.currentVersion ||
                    getVersionValue(null, { loading: endpointDiagnostics.loading }),
                },
                {
                  key: 'rest-url',
                  label: 'External REST API URL',
                  value: activeRuntimeConfig?.externalRestApiBaseUrl || 'Not configured',
                },
                {
                  key: 'rest-version',
                  label: 'External REST API version',
                  value: getVersionValue(
                    endpointDiagnostics.releaseStatus?.externalRestApiVersion,
                    {
                      loading: endpointDiagnostics.loading,
                    }
                  ),
                },
                {
                  key: 'rpc-url',
                  label: 'RPC proxy URL',
                  value:
                    activeRuntimeConfig?.rpcProxyBaseUrl ||
                    'Will be discovered from External REST API',
                },
                {
                  key: 'rpc-version',
                  label: 'RPC proxy version',
                  value: getVersionValue(endpointDiagnostics.releaseStatus?.rpcProxyVersion, {
                    loading: endpointDiagnostics.loading,
                  }),
                },
                {
                  key: 'release-id',
                  label: 'Release ID',
                  value:
                    endpointDiagnostics.releaseStatus?.releaseId ||
                    getVersionValue(null, { loading: endpointDiagnostics.loading }),
                },
                {
                  key: 'target-version',
                  label: 'Desktop target version',
                  value: endpointDiagnostics.releaseStatus
                    ? endpointDiagnostics.releaseStatus.latestVersion
                    : getVersionValue(null, { loading: endpointDiagnostics.loading }),
                },
                {
                  key: 'minimum-version',
                  label: 'Minimum desktop version',
                  value: endpointDiagnostics.releaseStatus
                    ? endpointDiagnostics.releaseStatus.minimumVersion
                    : getVersionValue(null, { loading: endpointDiagnostics.loading }),
                },
                {
                  key: 'update-required',
                  label: 'Update required',
                  value: endpointDiagnostics.releaseStatus
                    ? endpointDiagnostics.releaseStatus.updateRequired
                      ? 'Yes'
                      : 'No'
                    : endpointDiagnostics.loading
                      ? 'Checking...'
                      : 'Not checked',
                },
                {
                  key: 'release-url',
                  label: 'Release URL',
                  value: endpointDiagnostics.releaseStatus?.releaseUrl || 'Not reported',
                },
                {
                  key: 'rest-health',
                  label: 'External REST API health',
                  value: getHealthLabel(endpointDiagnostics.dependencyHealth?.externalRestApi),
                },
                {
                  key: 'rpc-health',
                  label: 'RPC proxy health',
                  value: getHealthLabel(endpointDiagnostics.dependencyHealth?.rpcProxy),
                },
                {
                  key: 'last-checked',
                  label: 'Last checked',
                  value: endpointDiagnostics.checkedAt || 'Not checked',
                },
              ]}
              pagination={false}
              rowKey="key"
              showHeader={false}
              size="small"
              styles={{
                body: {
                  cell: { background: 'transparent', border: 0, fontWeight: 400 },
                },
              }}
            />
            {endpointDiagnostics.releaseError ? (
              <Alert
                showIcon
                type="error"
                title={`Release check failed: ${endpointDiagnostics.releaseError}`}
              />
            ) : null}
            {endpointDiagnostics.healthError ? (
              <Alert
                showIcon
                type="error"
                title={`Health check failed: ${endpointDiagnostics.healthError}`}
              />
            ) : null}
          </Flex>
        </Card>
      ) : null}

      {activeSettingsTab === 'social' && hasSocialChannelsAccess ? (
        <Card
          title={
            <Flex align="center" gap="small">
              <ApiOutlined aria-hidden="true" />
              <Typography.Title id="settings-social-channels-heading" level={3}>
                Social channels
              </Typography.Title>
            </Flex>
          }
        >
          <Flex vertical gap="middle">
            <Typography.Text type="secondary">
              Connect and manage authorized external conversations.
            </Typography.Text>
            <Flex vertical gap="middle">
              {availableSocialMedia.map(medium => {
                const label = socialChannelLabel(medium)
                const connected = connectedSocialMedia.has(medium)
                return (
                  <Flex align="center" gap="middle" justify="space-between" key={medium} wrap>
                    <Flex vertical>
                      <Typography.Text strong>
                        {connected ? `${label} connected` : `Setup ${label}`}
                      </Typography.Text>
                      <Typography.Text type="secondary">
                        {connected
                          ? `Manage your connected ${label} conversations in Profile UI.`
                          : `Connect ${label} from Profile UI to use it with this account.`}
                      </Typography.Text>
                    </Flex>
                    <Button
                      htmlType="button"
                      onClick={() =>
                        void handleOpenProfileSettings({ section: 'social', network: medium })
                      }
                      type={connected ? 'default' : 'primary'}
                    >
                      {connected ? 'Manage' : 'Setup'}
                    </Button>
                  </Flex>
                )
              })}
            </Flex>
          </Flex>
        </Card>
      ) : null}
    </Flex>
  )
  const settingsContentWithTitleTheme = (
    <ConfigProvider theme={SETTINGS_TITLE_THEME}>{settingsContent}</ConfigProvider>
  )

  const settingsTabItems = [
    {
      key: 'account',
      label: 'Account',
      children: activeSettingsTab === 'account' ? settingsContentWithTitleTheme : null,
    },
    {
      key: 'appearance',
      label: 'Appearance',
      children: activeSettingsTab === 'appearance' ? settingsContentWithTitleTheme : null,
    },
    {
      key: 'notifications',
      label: 'Notifications',
      children: activeSettingsTab === 'notifications' ? settingsContentWithTitleTheme : null,
    },
    {
      key: 'plugins',
      label: 'Plugin permissions',
      children: activeSettingsTab === 'plugins' ? settingsContentWithTitleTheme : null,
    },
    ...(hasSocialChannelsAccess
      ? [
          {
            key: 'social',
            label: 'Social channels',
            children: activeSettingsTab === 'social' ? settingsContentWithTitleTheme : null,
          },
        ]
      : []),
    {
      key: 'shortcuts',
      label: 'Shortcuts',
      children: activeSettingsTab === 'shortcuts' ? settingsContentWithTitleTheme : null,
    },
    {
      key: 'information',
      label: 'Information',
      children: activeSettingsTab === 'information' ? settingsContentWithTitleTheme : null,
    },
  ]

  return (
    <Flex vertical gap="middle">
      <Typography.Title level={2}>Settings</Typography.Title>

      <Tabs
        aria-label="Settings sections"
        activeKey={activeSettingsTab}
        destroyOnHidden
        items={settingsTabItems}
        onChange={key => setActiveSettingsTab(key as SettingsTab)}
      />
    </Flex>
  )
}
