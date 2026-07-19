import type { ChatNotificationPreference, NotificationSettings } from '@/uiTypes'

export const NOTIFICATION_SETTINGS_STORAGE_KEY = 'clerum.ui.notificationSettings'

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  inApp: 'when_app_focused_away_from_chat',
  desktop: 'when_app_unfocused',
  soundVolume: 50,
}

export const NOTIFICATION_PREFERENCE_OPTIONS: ReadonlyArray<{
  value: ChatNotificationPreference
  label: string
  description: string
}> = [
  {
    value: 'always',
    label: 'Always show notifications',
    description:
      'Agent replies and app updates create notifications, including while you view related content.',
  },
  {
    value: 'when_app_focused_away_from_chat',
    label: "Show while I'm elsewhere in Evenfire",
    description: 'Agent replies and app updates notify you while you work elsewhere in Evenfire.',
  },
  {
    value: 'when_app_unfocused',
    label: "Show only when I'm away from Evenfire",
    description: 'Notifications appear only after the Evenfire window loses focus.',
  },
]
