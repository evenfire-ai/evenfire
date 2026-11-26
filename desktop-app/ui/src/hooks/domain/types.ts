import type { BrowserSignInSnapshot } from '../../../../src/types'
import type { AppNotification, Tone } from '../../uiTypes'

export type SetStatusFn = (
  message: string,
  tone?: Tone,
  payload?: unknown,
  options?: { global?: boolean; toast?: boolean; toastDurationMs?: number }
) => void

export type PushToastFn = (message: string, tone: Tone, options?: { durationMs?: number }) => void

export type DesktopEnvironmentSwitchConfirmation = {
  activeEnvironmentName: string
  activeExternalRestApiBaseUrl: string
  targetEnvironmentName: string
  targetExternalRestApiBaseUrl: string
}

export type PushNotificationInput = Omit<AppNotification, 'id' | 'read' | 'timestamp'> & {
  dedupeKey?: string
  timestamp?: number
}

/** What `useBrowserSignIn` needs from the controller that owns it. */
export interface UseBrowserSignInParams {
  setStatus: SetStatusFn
  onSessionNeedsLoad: (options?: { preserveNav?: boolean }) => Promise<void>
  /** Re-reads the login model after a refused start (D5). */
  refreshLoginMethods: () => void
}

export interface UseBrowserSignInResult {
  /** Main's snapshot, the newest the renderer has seen (D13). */
  view: BrowserSignInSnapshot
  /** Reads the ref, which is written together with `view` (V32). */
  isRedeeming: () => boolean
  start: () => Promise<void>
  cancel: () => Promise<void>
}
