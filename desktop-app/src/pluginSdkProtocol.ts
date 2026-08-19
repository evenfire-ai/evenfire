/**
 * Plugin UI SDK wire contract.
 *
 * Shared by three worlds that never share a module graph at runtime: the
 * embed preload (isolated world, no Node), the main process, and the trusted
 * renderer. Keep this file free of Electron and Node imports so all three can
 * type against it.
 *
 * One invoke channel carries every capability call and one carries batched
 * consent, so the broker (`pluginSdkBroker.ts`) is the single place a request
 * can be gated and audited. Adding a capability must never mean adding a
 * channel.
 */

export const PLUGIN_SDK_VERSION = '1.0.0'
export const PLUGIN_SDK_PROTOCOL = 1

/** Embed → main: one capability call. */
export const PLUGIN_SDK_REQUEST_CHANNEL = 'clerum:plugin-sdk:request'
/** Embed → main: batched consent for 1..8 capabilities in one modal. */
export const PLUGIN_SDK_PERMISSIONS_CHANNEL = 'clerum:plugin-sdk:request-permissions'
/** Embed → main: read grant state without prompting. */
export const PLUGIN_SDK_PERMISSION_STATE_CHANNEL = 'clerum:plugin-sdk:permissions'
/** Embed → main: which capability ids this host build implements. */
export const PLUGIN_SDK_CAPABILITIES_CHANNEL = 'clerum:plugin-sdk:capabilities'
/** Main → embed: events (theme, permission changes, session, notification clicks). */
export const PLUGIN_SDK_EVENT_CHANNEL = 'clerum:plugin-sdk:event'

/** Main → trusted renderer: open the consent modal. */
export const PLUGIN_SDK_CONSENT_REQUESTED_CHANNEL = 'pluginSdk:consentRequested'
/** Main → trusted renderer: withdraw a pending prompt (embed died, timeout). */
export const PLUGIN_SDK_CONSENT_CANCELLED_CHANNEL = 'pluginSdk:consentCancelled'
/** Trusted renderer → main: the user's decision. */
export const PLUGIN_SDK_CONSENT_RESOLVE_CHANNEL = 'pluginSdk:resolveConsent'

/** Hard ceiling on rows in one prompt (spec §9.5). */
export const PLUGIN_SDK_MAX_BATCH = 8

export type PluginSdkErrorCode =
  | 'unsupported_capability'
  | 'unsupported_version'
  | 'invalid_request'
  | 'unauthenticated'
  | 'permission_denied'
  | 'permission_revoked'
  | 'rate_limited'
  | 'not_found'
  | 'payload_too_large'
  | 'unavailable'
  | 'internal'

export type PluginSdkError = {
  code: PluginSdkErrorCode
  /** Safe for the plugin to display. Never carries upstream internals. */
  message: string
  /** True when an identical later call may succeed without user action. */
  retryable: boolean
}

export type PluginSdkResponse<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: PluginSdkError }

export type PluginSdkRequest = {
  v: number
  capability: string
  params?: Record<string, unknown>
}

export type PluginSdkPermissionsRequest = {
  v: number
  capabilities: string[]
}

export type PluginSdkPermissionsResult = {
  /** Every requested id is present. */
  granted: Record<string, boolean>
  /** True when the user allowed every requested capability. */
  all: boolean
}

export type PluginSdkPermissionStateResult = {
  granted: Record<string, boolean>
}

export type PluginSdkCapabilitiesResult = {
  capabilities: string[]
  version: string
}

export type PluginTheme = 'light' | 'dark'

export type PluginSdkEvent =
  | { type: 'theme.changed'; theme: PluginTheme }
  | { type: 'permission.changed'; capability: string; granted: boolean }
  | { type: 'session.changed'; authenticated: boolean }
  | { type: 'notification.clicked'; ref: string | null }

/** Sensitivity tier — drives prompt ordering and audit verbosity (spec §6). */
export type PluginCapabilityTier = 'personal' | 'workspace' | 'ambient'

/** One row of a consent prompt, as the trusted renderer receives it. */
export type PluginConsentRow = {
  capability: string
  title: string
  dataDescription: string
  tier: PluginCapabilityTier
}

export type PluginConsentRequest = {
  promptId: string
  pluginId: string
  pluginTitle: string
  rows: PluginConsentRow[]
  /** How many prompts this plugin has already shown this mount (spec §9.5). */
  priorPromptCount: number
}

export type PluginConsentResolution = {
  promptId: string
  /** Capability ids the user left checked. Everything else counts as denied. */
  allowed: string[]
}

/**
 * Views the TRUSTED renderer consumes (Settings → Plugin permissions).
 *
 * They live here rather than beside their producers because `renderer.d.ts` —
 * and therefore the UI's tsconfig — types against this module, and this module
 * is the only one in the SDK with no Node or Electron imports. Pointing the UI
 * at `pluginSdkRuntime.ts` would drag Electron's types into the Vite project.
 */
export type PluginGrantView = {
  pluginId: string
  pluginTitle: string
  capability: string
  title: string
  dataDescription: string
  tier: string
  grantedAt: string
  lastUsedAt: string | null
}

export type PluginAuditEntryView = {
  ts: string
  userId: string
  pluginId: string
  capability: string
  outcome: string
  consent?: string
  surface?: string
  shape?: { fields?: string[]; count?: number; bytes?: number }
  code?: string
}

export function sdkError(
  code: PluginSdkErrorCode,
  message: string,
  retryable = false
): { ok: false; error: PluginSdkError } {
  return { ok: false, error: { code, message, retryable } }
}

export function sdkOk<T>(data: T): { ok: true; data: T } {
  return { ok: true, data }
}
