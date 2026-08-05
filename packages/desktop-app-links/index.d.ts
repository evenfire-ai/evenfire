export declare const CLERUM_OAUTH_PROTOCOL: 'clerum:'
export declare const SANDBOX_UI_DEEP_LINK_HOST: 'app'
export declare const SANDBOX_UI_DEEP_LINK_PROTOCOL: 'evenfire:'
export declare const SANDBOX_UI_WEB_LINK_PATH: '/open/apps'

export type SandboxUiDeepLinkTarget = {
  appRef: string
  path?: string
  teamId?: string
}

export type SandboxUiDeepLinkEnvelope = SandboxUiDeepLinkTarget & {
  id: number
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
