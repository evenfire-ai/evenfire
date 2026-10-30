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
