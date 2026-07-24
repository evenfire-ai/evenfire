import { DEFAULT_NOTIFICATION_SETTINGS } from '@constants/notificationSettings'
import type {
  AppNotificationKind,
  ChatNotificationPreference,
  NotificationSettings,
} from '@/uiTypes'

type ChatNotificationDeliveryContext = {
  appFocused: boolean
  activeChatVisible: boolean
}

export function sanitizeNotificationPreference(
  value: unknown,
  fallback: ChatNotificationPreference
): ChatNotificationPreference {
  if (
    value === 'always' ||
    value === 'when_app_focused_away_from_chat' ||
    value === 'when_app_unfocused'
  ) {
    return value
  }
  return fallback
}

export function sanitizeNotificationVolume(value: unknown, fallback = 50): number {
  const numericValue =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  if (!Number.isFinite(numericValue)) return fallback
  return Math.min(100, Math.max(0, Math.round(numericValue)))
}

export function sanitizeNotificationSettings(value: unknown): NotificationSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return DEFAULT_NOTIFICATION_SETTINGS
  }
  const candidate = value as Partial<Record<keyof NotificationSettings, unknown>>
  return {
    inApp: sanitizeNotificationPreference(candidate.inApp, DEFAULT_NOTIFICATION_SETTINGS.inApp),
    desktop: sanitizeNotificationPreference(
      candidate.desktop,
      DEFAULT_NOTIFICATION_SETTINGS.desktop
    ),
    soundVolume: sanitizeNotificationVolume(
      candidate.soundVolume,
      DEFAULT_NOTIFICATION_SETTINGS.soundVolume
    ),
  }
}

export function shouldDeliverChatResponseNotification(
  preference: ChatNotificationPreference,
  context: ChatNotificationDeliveryContext
): boolean {
  if (preference === 'always') return true
  if (preference === 'when_app_focused_away_from_chat') {
    return context.appFocused && !context.activeChatVisible
  }
  return !context.appFocused
}

export function notificationPreviewText(kind: AppNotificationKind, value: string): string {
  const normalized = value.trim()
  if (kind === 'sdk_notification') return normalized
  const maxLength = 250
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`
}

export function notificationKindLabel(kind: AppNotificationKind): string {
  if (kind === 'approval_required') return 'Approval needed'
  if (kind === 'workflow_completed') return 'Workflow completed'
  if (kind === 'sdk_notification') return 'Plugin notification'
  return 'Agent reply'
}
