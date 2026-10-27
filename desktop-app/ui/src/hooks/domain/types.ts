import type { AppNotification, Tone } from '../../uiTypes'

export type SetStatusFn = (
  message: string,
  tone?: Tone,
  payload?: unknown,
  options?: { global?: boolean; toast?: boolean; toastDurationMs?: number }
) => void

export type PushToastFn = (message: string, tone: Tone, options?: { durationMs?: number }) => void

export type PushNotificationInput = Omit<AppNotification, 'id' | 'read' | 'timestamp'> & {
  dedupeKey?: string
  timestamp?: number
}
