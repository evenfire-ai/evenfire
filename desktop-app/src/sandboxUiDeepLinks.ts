import { normalizeSandboxUiRoute } from '@clerum/desktop-app-links'

export {
  SANDBOX_UI_DEEP_LINK_HOST,
  SANDBOX_UI_DEEP_LINK_PROTOCOL,
  SANDBOX_UI_WEB_LINK_PATH,
  buildSandboxUiDeepLink,
  buildSandboxUiWebLink,
  normalizeSandboxUiRoute,
  parseSandboxUiDeepLink,
  sandboxUiDeepLinkTargetsEqual,
} from '@clerum/desktop-app-links'
export type {
  SandboxUiDeepLinkEnvelope,
  SandboxUiDeepLinkParts,
  SandboxUiDeepLinkTarget,
} from '@clerum/desktop-app-links'

type SandboxUiViewRouteInput = {
  currentUrl: string
  rpcProxyOrigin: string
  recipeNs: string
  recipeName: string
}

export function extractSandboxUiViewRoute(input: SandboxUiViewRouteInput): string | null {
  let current: URL
  let proxy: URL
  try {
    current = new URL(input.currentUrl)
    proxy = new URL(input.rpcProxyOrigin)
  } catch {
    return null
  }
  if (current.origin !== proxy.origin) return null

  const prefix =
    `/api/v1/sandbox-ui/${encodeURIComponent(input.recipeNs)}/` +
    `${encodeURIComponent(input.recipeName)}/view`
  if (current.pathname !== prefix && !current.pathname.startsWith(`${prefix}/`)) return null

  const pathname = current.pathname.slice(prefix.length) || '/'
  return normalizeSandboxUiRoute(`${pathname}${current.search}${current.hash}`) ?? null
}
