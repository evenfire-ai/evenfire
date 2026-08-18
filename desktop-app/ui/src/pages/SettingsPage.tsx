import { type FormEvent, useEffect, useMemo, useState } from 'react'
import { useAuthContext } from '@contexts/AuthContext'
import { Button, Field, IconButton, SelectInput, TabButton, TextInput } from '@components/Common'
import { PluginPermissions } from '@components/PluginPermissions'
import {
  IconBell,
  IconConnectors,
  IconDesktopNotifications,
  IconSettings,
  IconThemeSun,
  IconVolume,
  IconVolumeOff,
} from '@components/SidebarNav/icons'
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
import type {
  DependencyHealth,
  DesktopAppInfo,
  DesktopReleaseStatus,
  ExternalChannelsSummary,
  ProfileSettingsOpenOptions,
} from '../../../src/types'
import type { SettingsPageProps } from './SettingsPage.types'

type NotificationPreferenceSection = 'inApp' | 'desktop'
type SettingsTab = 'account' | 'appearance' | 'notifications' | 'plugins' | 'social' | 'information'

type EndpointDiagnostics = {
  appInfo: DesktopAppInfo | null
  releaseStatus: DesktopReleaseStatus | null
  dependencyHealth: DependencyHealth | null
  releaseError: string
  healthError: string
  checkedAt: string | null
  loading: boolean
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
    <div className="settings-field">
      <div className="settings-radio-list">
        {NOTIFICATION_PREFERENCE_OPTIONS.map(option => (
          <label
            key={option.value}
            className={`settings-radio-option${option.value === value ? ' is-selected' : ''}`}
            htmlFor={`${id}-${option.value}`}
            title={option.description}
          >
            <input
              id={`${id}-${option.value}`}
              type="radio"
              name={id}
              value={option.value}
              aria-labelledby={`${labelledBy} ${id}-${option.value}-title`}
              aria-describedby={`${id}-${option.value}-description`}
              checked={option.value === value}
              onChange={() => onChange(option.value)}
            />
            <span className="settings-radio-copy">
              <span id={`${id}-${option.value}-title`} className="settings-radio-title">
                {option.label}
              </span>
              <span id={`${id}-${option.value}-description`} className="visually-hidden">
                {option.description}
              </span>
            </span>
          </label>
        ))}
      </div>
    </div>
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
    <div className="settings-field settings-field--compact">
      <div className="settings-radio-list">
        {THEME_MODE_OPTIONS.map(option => (
          <label
            key={option.value}
            className={`settings-radio-option${option.value === value ? ' is-selected' : ''}`}
            htmlFor={`${id}-${option.value}`}
            title={option.description}
          >
            <input
              id={`${id}-${option.value}`}
              type="radio"
              name={id}
              value={option.value}
              aria-labelledby={`${labelledBy} ${id}-${option.value}-title`}
              aria-describedby={`${id}-${option.value}-description`}
              checked={option.value === value}
              onChange={() => onChange(option.value)}
            />
            <span className="settings-radio-copy">
              <span id={`${id}-${option.value}-title`} className="settings-radio-title">
                {option.label}
              </span>
              <span id={`${id}-${option.value}-description`} className="visually-hidden">
                {option.description}
              </span>
            </span>
          </label>
        ))}
      </div>
    </div>
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
  const label = volume === 0 ? 'Muted' : `${volume}%`
  const applyVolume = (nextValue: string | number, options: { preview?: boolean } = {}) => {
    const nextVolume = sanitizeNotificationVolume(nextValue)
    onChange(nextVolume)
    if (options.preview) onPreview(nextVolume)
  }

  return (
    <div className="settings-field">
      <label className="settings-volume-label" htmlFor="settings-notification-sound-volume">
        Alert volume
      </label>
      <div className="settings-volume-row">
        <IconButton
          className="settings-volume-mute-button"
          aria-pressed={volume === 0}
          label={volume === 0 ? 'Notification sounds muted' : 'Mute notification sounds'}
          onClick={() => onChange(0)}
          variant="soft"
        >
          {volume === 0 ? <IconVolumeOff /> : <IconVolume />}
        </IconButton>
        <input
          id="settings-notification-sound-volume"
          className="settings-volume-slider"
          type="range"
          min="0"
          max="100"
          step="1"
          value={volume}
          aria-valuetext={label}
          onChange={event => applyVolume(event.currentTarget.value)}
          onPointerUp={event => applyVolume(event.currentTarget.value, { preview: true })}
          onKeyUp={event => {
            if (
              event.key === 'ArrowLeft' ||
              event.key === 'ArrowRight' ||
              event.key === 'ArrowUp' ||
              event.key === 'ArrowDown' ||
              event.key === 'Home' ||
              event.key === 'End' ||
              event.key === 'PageUp' ||
              event.key === 'PageDown'
            ) {
              applyVolume(event.currentTarget.value, { preview: true })
            }
          }}
        />
        <TextInput
          className="settings-volume-input"
          type="number"
          min="0"
          max="100"
          step="1"
          inputMode="numeric"
          aria-label="Notification sound volume percentage"
          value={volume}
          onChange={event => applyVolume(event.currentTarget.value)}
          onBlur={event => applyVolume(event.currentTarget.value, { preview: true })}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              applyVolume(event.currentTarget.value, { preview: true })
            }
          }}
        />
      </div>
    </div>
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

  return (
    <section className="page settings-page">
      <div className="page-header">
        <h2>Settings</h2>
      </div>

      <div className="page-tabs settings-tabs" role="tablist" aria-label="Settings sections">
        <TabButton
          active={activeSettingsTab === 'account'}
          className="page-tab"
          id="settings-tab-account"
          role="tab"
          aria-controls="settings-panel-account"
          onClick={() => setActiveSettingsTab('account')}
        >
          Account
        </TabButton>
        <TabButton
          active={activeSettingsTab === 'appearance'}
          className="page-tab"
          id="settings-tab-appearance"
          role="tab"
          aria-controls="settings-panel-appearance"
          onClick={() => setActiveSettingsTab('appearance')}
        >
          Appearance
        </TabButton>
        <TabButton
          active={activeSettingsTab === 'notifications'}
          className="page-tab"
          id="settings-tab-notifications"
          role="tab"
          aria-controls="settings-panel-notifications"
          onClick={() => setActiveSettingsTab('notifications')}
        >
          Notifications
        </TabButton>
        <TabButton
          active={activeSettingsTab === 'plugins'}
          className="page-tab"
          id="settings-tab-plugins"
          role="tab"
          aria-controls="settings-panel-plugins"
          onClick={() => setActiveSettingsTab('plugins')}
        >
          Plugin permissions
        </TabButton>
        {hasSocialChannelsAccess ? (
          <TabButton
            active={activeSettingsTab === 'social'}
            className="page-tab"
            id="settings-tab-social"
            role="tab"
            aria-controls="settings-panel-social"
            onClick={() => setActiveSettingsTab('social')}
          >
            Social channels
          </TabButton>
        ) : null}
        <TabButton
          active={activeSettingsTab === 'information'}
          className="page-tab"
          id="settings-tab-information"
          role="tab"
          aria-controls="settings-panel-information"
          onClick={() => setActiveSettingsTab('information')}
        >
          Information
        </TabButton>
      </div>

      <div className="page-layout settings-layout">
        {activeSettingsTab === 'account' ? (
          <section
            className="settings-tab-panel"
            id="settings-panel-account"
            role="tabpanel"
            aria-labelledby="settings-tab-account"
          >
            <section className="page-card settings-card" aria-labelledby="settings-account-heading">
              <div className="page-card__header">
                <div className="settings-card-title-row">
                  <span className="settings-card-title-icon" aria-hidden="true">
                    <IconSettings />
                  </span>
                  <div>
                    <h3 id="settings-account-heading">Account</h3>
                    <p className="muted">Manage your Evenfire account details in Profile UI.</p>
                  </div>
                </div>
              </div>
              <div className="settings-form settings-account-summary">
                <div className="settings-readonly-row">
                  <span className="settings-readonly-label">Account name</span>
                  <span>{me?.name || me?.email || 'Unknown account'}</span>
                </div>
                <div className="settings-readonly-row">
                  <span className="settings-readonly-label">Email</span>
                  <span>{me?.email || email || 'No email'}</span>
                </div>
              </div>
              <div className="settings-actions settings-account-actions">
                <Button
                  type="button"
                  color="neutral"
                  onClick={() =>
                    void handleOpenProfileSettings({ section: 'profile', action: 'password' })
                  }
                >
                  Update password
                </Button>
                <Button
                  type="button"
                  onClick={() => void handleOpenProfileSettings({ section: 'profile' })}
                >
                  Edit
                </Button>
              </div>
            </section>
          </section>
        ) : null}

        {activeSettingsTab === 'appearance' ? (
          <section
            className="settings-tab-panel"
            id="settings-panel-appearance"
            role="tabpanel"
            aria-labelledby="settings-tab-appearance"
          >
            <section className="page-card settings-card" aria-labelledby="settings-theme-heading">
              <div className="page-card__header">
                <div className="settings-card-title-row">
                  <span className="settings-card-title-icon" aria-hidden="true">
                    <IconThemeSun />
                  </span>
                  <div>
                    <h3 id="settings-theme-heading">Theme</h3>
                    <p className="muted">Choose the desktop app color mode.</p>
                  </div>
                </div>
              </div>
              <div className="settings-form">
                <ThemePreferenceField
                  id="settings-theme-mode"
                  labelledBy="settings-theme-heading"
                  value={themeMode}
                  onChange={onThemeModeChange}
                />
              </div>
            </section>
          </section>
        ) : null}

        {activeSettingsTab === 'plugins' ? (
          <section
            className="settings-tab-panel"
            id="settings-panel-plugins"
            role="tabpanel"
            aria-labelledby="settings-tab-plugins"
          >
            <PluginPermissions />
          </section>
        ) : null}

        {activeSettingsTab === 'notifications' ? (
          <section
            className="settings-tab-panel"
            id="settings-panel-notifications"
            role="tabpanel"
            aria-labelledby="settings-tab-notifications"
          >
            <form
              className="page-card settings-card"
              onSubmit={event => handleSubmit(event, 'inApp')}
            >
              <div className="page-card__header">
                <div className="settings-card-title-row">
                  <span className="settings-card-title-icon" aria-hidden="true">
                    <IconBell />
                  </span>
                  <div>
                    <h3 id="settings-in-app-heading">In App Notifications</h3>
                    <p className="muted">
                      Choose when agent replies and app updates appear in the notification bell.
                    </p>
                  </div>
                </div>
              </div>
              <div className="settings-form">
                <NotificationPreferenceField
                  id="settings-in-app-notifications"
                  labelledBy="settings-in-app-heading"
                  value={draftSettings.inApp}
                  onChange={value => updateDraftSetting('inApp', value)}
                />

                {hasInAppChanges && (
                  <div className="settings-actions">
                    <Button type="submit" disabled={savingSection === 'inApp'}>
                      {savingSection === 'inApp' ? 'Saving...' : 'Save changes'}
                    </Button>
                  </div>
                )}
              </div>
            </form>

            <form
              className="page-card settings-card"
              onSubmit={event => handleSubmit(event, 'desktop')}
            >
              <div className="page-card__header">
                <div className="settings-card-title-row">
                  <span className="settings-card-title-icon" aria-hidden="true">
                    <IconDesktopNotifications />
                  </span>
                  <div>
                    <h3 id="settings-desktop-heading">Desktop notifications</h3>
                    <p className="muted">{permissionLabel}</p>
                  </div>
                </div>
              </div>
              <div className="settings-form">
                <NotificationPreferenceField
                  id="settings-desktop-notifications"
                  labelledBy="settings-desktop-heading"
                  value={draftSettings.desktop}
                  onChange={value => updateDraftSetting('desktop', value)}
                />

                {hasDesktopChanges && (
                  <div className="settings-actions">
                    <Button type="submit" disabled={savingSection === 'desktop'}>
                      {savingSection === 'desktop' ? 'Saving...' : 'Save changes'}
                    </Button>
                  </div>
                )}
              </div>
            </form>

            <section
              className="page-card settings-card"
              aria-labelledby="settings-channel-fallback-heading"
            >
              <div className="page-card__header">
                <div className="settings-card-title-row">
                  <span className="settings-card-title-icon" aria-hidden="true">
                    <IconBell />
                  </span>
                  <div>
                    <h3 id="settings-channel-fallback-heading">Channel fallback</h3>
                    <p className="muted">
                      SDK workflow notifications are delivered to the desktop app first. Choose
                      whether Telegram or Slack should receive them if the desktop app does not
                      acknowledge in time.
                    </p>
                  </div>
                </div>
              </div>
              <div className="settings-form settings-channel-fallback-form">
                <Field label="Preferred fallback channel" htmlFor="settings-preferred-medium">
                  <SelectInput
                    id="settings-preferred-medium"
                    value={draftPreferredMedium ?? ''}
                    disabled={
                      channelNotificationPreferencesLoading ||
                      channelNotificationPreferences.verifiedMedia.length === 0
                    }
                    onChange={event => {
                      const value = event.target.value
                      setDraftPreferredMedium(
                        value === 'telegram' || value === 'slack' ? value : null
                      )
                    }}
                  >
                    <option value="">
                      {channelNotificationPreferences.verifiedMedia.length > 1
                        ? 'Most recently verified channel'
                        : 'No verified channel'}
                    </option>
                    {channelNotificationPreferences.verifiedMedia.map(medium => (
                      <option key={medium} value={medium}>
                        {medium === 'telegram' ? 'Telegram' : 'Slack'}
                      </option>
                    ))}
                  </SelectInput>
                </Field>
                <label className="settings-checkbox-option">
                  <input
                    type="checkbox"
                    checked={draftChannelFallbackEnabled}
                    disabled={channelNotificationPreferencesLoading}
                    onChange={event => setDraftChannelFallbackEnabled(event.target.checked)}
                  />
                  <span>Allow Telegram/Slack fallback when desktop delivery is unavailable</span>
                </label>
                {hasChannelPreferenceChanges ? (
                  <div className="settings-actions">
                    <Button
                      type="button"
                      disabled={channelNotificationPreferencesSaving}
                      onClick={() =>
                        void onSaveChannelNotificationPreferences({
                          preferredMedium: draftPreferredMedium,
                          channelFallbackEnabled: draftChannelFallbackEnabled,
                        })
                      }
                    >
                      {channelNotificationPreferencesSaving ? 'Saving...' : 'Save changes'}
                    </Button>
                  </div>
                ) : null}
              </div>
            </section>

            <section
              className="page-card settings-card"
              aria-labelledby="settings-notification-sound-heading"
            >
              <div className="page-card__header">
                <div className="settings-card-title-row">
                  <span className="settings-card-title-icon" aria-hidden="true">
                    <IconVolume />
                  </span>
                  <div>
                    <h3 id="settings-notification-sound-heading">Notification sound</h3>
                    <p className="muted">Manage the alert volume for notification sounds.</p>
                  </div>
                </div>
              </div>
              <div className="settings-form">
                <NotificationSoundVolumeField
                  value={notificationSettings.soundVolume}
                  onChange={onNotificationSoundVolumeChange}
                  onPreview={onPlayNotificationSoundPreview}
                />
              </div>
            </section>
          </section>
        ) : null}

        {activeSettingsTab === 'information' ? (
          <section
            className="settings-tab-panel"
            id="settings-panel-information"
            role="tabpanel"
            aria-labelledby="settings-tab-information"
          >
            <section className="page-card settings-card" aria-label="Connection endpoints">
              <div className="settings-form">
                <dl className="settings-runtime-details settings-runtime-details--diagnostics">
                  <div>
                    <dt>Desktop app version</dt>
                    <dd>
                      {endpointDiagnostics.appInfo?.version ||
                        endpointDiagnostics.releaseStatus?.currentVersion ||
                        getVersionValue(null, { loading: endpointDiagnostics.loading })}
                    </dd>
                  </div>
                  <div>
                    <dt>External REST API URL</dt>
                    <dd>{activeRuntimeConfig?.externalRestApiBaseUrl || 'Not configured'}</dd>
                  </div>
                  <div>
                    <dt>External REST API version</dt>
                    <dd>
                      {getVersionValue(endpointDiagnostics.releaseStatus?.externalRestApiVersion, {
                        loading: endpointDiagnostics.loading,
                      })}
                    </dd>
                  </div>
                  <div>
                    <dt>RPC proxy URL</dt>
                    <dd>
                      {activeRuntimeConfig?.rpcProxyBaseUrl ||
                        'Will be discovered from External REST API'}
                    </dd>
                  </div>
                  <div>
                    <dt>RPC proxy version</dt>
                    <dd>
                      {getVersionValue(endpointDiagnostics.releaseStatus?.rpcProxyVersion, {
                        loading: endpointDiagnostics.loading,
                      })}
                    </dd>
                  </div>
                  <div>
                    <dt>Release ID</dt>
                    <dd>
                      {endpointDiagnostics.releaseStatus?.releaseId ||
                        getVersionValue(null, { loading: endpointDiagnostics.loading })}
                    </dd>
                  </div>
                  <div>
                    <dt>Desktop target version</dt>
                    <dd>
                      {endpointDiagnostics.releaseStatus
                        ? endpointDiagnostics.releaseStatus.latestVersion
                        : getVersionValue(null, { loading: endpointDiagnostics.loading })}
                    </dd>
                  </div>
                  <div>
                    <dt>Minimum desktop version</dt>
                    <dd>
                      {endpointDiagnostics.releaseStatus
                        ? endpointDiagnostics.releaseStatus.minimumVersion
                        : getVersionValue(null, { loading: endpointDiagnostics.loading })}
                    </dd>
                  </div>
                  <div>
                    <dt>Update required</dt>
                    <dd>
                      {endpointDiagnostics.releaseStatus
                        ? endpointDiagnostics.releaseStatus.updateRequired
                          ? 'Yes'
                          : 'No'
                        : endpointDiagnostics.loading
                          ? 'Checking...'
                          : 'Not checked'}
                    </dd>
                  </div>
                  <div>
                    <dt>Release URL</dt>
                    <dd>{endpointDiagnostics.releaseStatus?.releaseUrl || 'Not reported'}</dd>
                  </div>
                  <div>
                    <dt>External REST API health</dt>
                    <dd>{getHealthLabel(endpointDiagnostics.dependencyHealth?.externalRestApi)}</dd>
                  </div>
                  <div>
                    <dt>RPC proxy health</dt>
                    <dd>{getHealthLabel(endpointDiagnostics.dependencyHealth?.rpcProxy)}</dd>
                  </div>
                  <div>
                    <dt>Last checked</dt>
                    <dd>{endpointDiagnostics.checkedAt || 'Not checked'}</dd>
                  </div>
                </dl>
                {endpointDiagnostics.releaseError ? (
                  <p className="settings-runtime-diagnostic-error" role="alert">
                    Release check failed: {endpointDiagnostics.releaseError}
                  </p>
                ) : null}
                {endpointDiagnostics.healthError ? (
                  <p className="settings-runtime-diagnostic-error" role="alert">
                    Health check failed: {endpointDiagnostics.healthError}
                  </p>
                ) : null}
              </div>
            </section>
          </section>
        ) : null}

        {activeSettingsTab === 'social' && hasSocialChannelsAccess ? (
          <section
            className="settings-tab-panel"
            id="settings-panel-social"
            role="tabpanel"
            aria-labelledby="settings-tab-social"
          >
            <section
              className="page-card settings-card"
              aria-labelledby="settings-social-channels-heading"
            >
              <div className="page-card__header">
                <div className="settings-card-title-row">
                  <span className="settings-card-title-icon" aria-hidden="true">
                    <IconConnectors />
                  </span>
                  <div>
                    <h3 id="settings-social-channels-heading">Social channels</h3>
                    <p className="muted">Connect and manage authorized external conversations.</p>
                  </div>
                </div>
              </div>
              <div className="settings-social-channel-list">
                {availableSocialMedia.map(medium => {
                  const label = socialChannelLabel(medium)
                  const connected = connectedSocialMedia.has(medium)
                  return (
                    <div className="settings-social-channel-row" key={medium}>
                      <div className="settings-social-channel-copy">
                        <span className="settings-social-channel-name">
                          {connected ? `${label} connected` : `Setup ${label}`}
                        </span>
                        <span className="muted">
                          {connected
                            ? `Manage your connected ${label} conversations in Profile UI.`
                            : `Connect ${label} from Profile UI to use it with this account.`}
                        </span>
                      </div>
                      <Button
                        type="button"
                        color={connected ? 'neutral' : 'primary'}
                        onClick={() =>
                          void handleOpenProfileSettings({ section: 'social', network: medium })
                        }
                      >
                        {connected ? 'Manage' : 'Setup'}
                      </Button>
                    </div>
                  )
                })}
              </div>
            </section>
          </section>
        ) : null}
      </div>
    </section>
  )
}
