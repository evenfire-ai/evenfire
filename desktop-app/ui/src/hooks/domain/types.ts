import type { BrowserSignInSnapshot, LoginMethodsModel } from '../../../../src/types'
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

/** What the login screen shows: main's model, or `loading` until one for the binding arrives. */
export type LoginScreenModel = { kind: 'loading' } | LoginMethodsModel

/** What `useLoginMethods` needs from the controller that owns it. */
export type UseLoginMethodsParams = Readonly<{
  /** Re-reads the runtime config state after a binding change fails (D15, A3-65). */
  refreshRuntimeConfigState: () => Promise<unknown>
}>

export interface UseLoginMethodsResult {
  model: LoginScreenModel
  /** Reads the model for the current binding. Stable, and it never throws. */
  refresh: () => void
  /**
   * Runs one binding-changing call (D15): moves the request epoch and shows `loading` before
   * the call, and reads the model again when it settles. The call's own result or error is
   * returned unchanged. Stable.
   */
  runBindingChange: <T>(call: () => Promise<T>) => Promise<T>
}
