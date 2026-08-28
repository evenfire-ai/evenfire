import type {
  DesktopNotificationPermission,
  NotificationSettings,
  ThemeMode,
  Tone,
} from '@/uiTypes'
import type { UserNotificationPreferences } from '../../../src/types'

export type SettingsPageProps = {
  shortcutsFocusRequestId?: number
  notificationSettings: NotificationSettings
  desktopNotificationPermission: DesktopNotificationPermission
  themeMode: ThemeMode
  onNotify: (message: string, tone: Tone) => void
  onThemeModeChange: (themeMode: ThemeMode) => void
  onNotificationSoundVolumeChange: (volume: number) => void
  onPlayNotificationSoundPreview: (volume: number) => void
  onSaveNotificationSettings: (
    settings: NotificationSettings,
    options?: { requestDesktopPermission?: boolean }
  ) => Promise<DesktopNotificationPermission>
  channelNotificationPreferences: UserNotificationPreferences
  channelNotificationPreferencesLoading: boolean
  channelNotificationPreferencesSaving: boolean
  onSaveChannelNotificationPreferences: (next: {
    preferredMedium: 'telegram' | 'slack' | null
    channelFallbackEnabled: boolean
  }) => Promise<void>
}
