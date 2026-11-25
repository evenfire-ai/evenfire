export declare const CLERUM_OAUTH_PROTOCOL: 'clerum:'
export declare const SANDBOX_UI_DEEP_LINK_HOST: 'app'
export declare const SANDBOX_UI_DEEP_LINK_PROTOCOL: 'evenfire:'
export declare const SANDBOX_UI_WEB_LINK_PATH: '/open/apps'
export declare const GFS_RESOURCE_DEEP_LINK_HOST: 'files'
export declare const GFS_RESOURCE_WEB_LINK_PATH: '/open/files'

export type SandboxUiDeepLinkTarget = {
  appRef: string
  path?: string
  teamId?: string
}

export type SandboxUiDeepLinkEnvelope = SandboxUiDeepLinkTarget & {
  id: number
}

export type GfsResourceDeepLinkTarget = {
  uri: string
}

export type GfsResourceDeepLinkEnvelope = GfsResourceDeepLinkTarget & {
  id: number
  /** Main-issued renderer navigation generation captured when this link activates. */
  userNavigationGenerationAtActivation: number
}

export type SandboxUiDeepLinkParts = {
  recipeNs: string
  recipeName: string
  /** Optional client-side SPA pathname. Query strings and fragments are not shared. */
  path?: string
  teamId?: string
}

export function normalizeSandboxUiRoute(rawPath?: string): string | undefined | null
export function buildSandboxUiDeepLink(parts: SandboxUiDeepLinkParts): string
export function buildSandboxUiWebLink(
  profileUiBaseUrl: string,
  parts: SandboxUiDeepLinkParts
): string
export function parseSandboxUiDeepLink(rawUrl: string): SandboxUiDeepLinkTarget | null
export function sandboxUiDeepLinkTargetsEqual(
  left: SandboxUiDeepLinkTarget,
  right: SandboxUiDeepLinkTarget
): boolean
export function normalizeGfsResourceUri(uri: string): string | null
export function buildGfsResourceDeepLink(uri: string): string
export function buildGfsResourceWebLink(profileUiBaseUrl: string, uri: string): string
export function parseGfsResourceDeepLink(rawUrl: string): GfsResourceDeepLinkTarget | null
/** Accepts canonical GFS URIs, evenfire://files links, and Profile /open/files URLs. */
export function parseGfsResourceLink(rawLink: string): GfsResourceDeepLinkTarget | null

/** The Profile UI page that starts a Desktop sign-in. */
export declare const DESKTOP_LOGIN_PATH: '/desktop-login'
/** The `evenfire://` host of the links that end a Desktop sign-in. */
export declare const DESKTOP_LOGIN_DEEP_LINK_HOST: 'desktop-login'
export declare const DESKTOP_LOGIN_ERRORS: readonly [
  'refused',
  'cancelled',
  'unavailable',
  'failed',
]
/** The refusal reasons a Desktop sign-in link may carry. */
export declare const DESKTOP_LOGIN_REFUSAL_REASONS: readonly [
  'account_disabled',
  'identity_conflict',
  'account_needs_attention',
  'email_claim_missing',
  'email_unverified',
  'not_eligible',
  'no_account',
  'provider_configuration',
]
export type DesktopLoginError = (typeof DESKTOP_LOGIN_ERRORS)[number]
export type DesktopLoginRefusalReason = (typeof DESKTOP_LOGIN_REFUSAL_REASONS)[number]
export type DesktopLoginPageValues = { challenge: string; state: string }
export type DesktopLoginFragment =
  | ({ valid: true } & DesktopLoginPageValues)
  | { valid: false; state: string | null }
export type DesktopLoginLink =
  | { kind: 'code'; state: string; code: string; environment: string }
  | { kind: 'error'; state: string; error: 'refused'; reason: DesktopLoginRefusalReason }
  | { kind: 'error'; state: string; error: 'cancelled' | 'unavailable' | 'failed' }

/**
 * Returns `origin + DESKTOP_LOGIN_PATH` for an https URL of at most 2048 characters with no user
 * info, query or fragment and the exact `/desktop-login` pathname; otherwise null.
 */
export function parseDesktopLoginSignInUrl(rawUrl: string): string | null
/** `<signInUrl>#challenge=<c>&state=<s>`. Throws on a bad signInUrl, challenge or state. */
export function buildDesktopLoginPageUrl(signInUrl: string, values: DesktopLoginPageValues): string
export function parseDesktopLoginPageUrl(
  rawUrl: string
): ({ signInUrl: string } & DesktopLoginPageValues) | null
/**
 * Takes the hash with or without its `#`. It needs exactly one `challenge` and one `state` and no
 * other key. An invalid fragment still returns its state when that alone is well formed.
 */
export function parseDesktopLoginFragment(hash: string): DesktopLoginFragment
/** Throws on a bad state, code or environment. */
export function buildDesktopLoginCodeLink(values: {
  state: string
  code: string
  environment: string
}): string
/**
 * Writes `error=failed`, with no reason, for `refused` with an unlisted or missing reason. A
 * reason on any other error is not written. Throws on a bad state or an unknown error.
 */
export function buildDesktopLoginErrorLink(values: {
  state: string
  error: DesktopLoginError
  reason?: string
}): string
/**
 * Strict: null for another scheme, host, port or path, an unknown error, or an unknown, extra or
 * duplicate parameter. `refused` with an unlisted or missing reason reads as `failed`.
 */
export function parseDesktopLoginLink(rawUrl: string): DesktopLoginLink | null
