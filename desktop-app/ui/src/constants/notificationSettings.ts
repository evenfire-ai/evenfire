import type { ChatNotificationPreference, NotificationSettings } from '@/uiTypes'

export const NOTIFICATION_SETTINGS_STORAGE_KEY = 'clerum.ui.notificationSettings'

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  inApp: 'when_app_focused_away_from_chat',
  desktop: 'when_app_unfocused',
  soundVolume: 50,
}

export const CHAT_NOTIFICATION_PREFERENCE_OPTIONS: ReadonlyArray<{
  value: ChatNotificationPreference
  label: string
  description: string
}> = [
  {
    value: 'always',
    label: 'Always show chat responses',
    description: 'Every agent response creates a notification, including the chat you are viewing.',
  },
  {
    value: 'when_app_focused_away_from_chat',
    label: "Show only when I'm away from the chat but still focused on the app",
    description: 'Responses notify you while you are working elsewhere in Evenfire.',
  },
  {
    value: 'when_app_unfocused',
    label: "Show only when I'm away from the app",
    description: 'Responses notify you only after the Evenfire window loses focus.',
  },
]
