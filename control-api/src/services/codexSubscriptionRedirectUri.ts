/** Public OAuth client shipped with the Codex CLI — device-code only for Evenfire. */
export const PUBLIC_CODEX_CLI_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'

/** Same-origin proxy path control-ui uses before forwarding to control-api. */
export const CODEX_BROWSER_CALLBACK_PROXY_PATH =
  '/control-api/api/v1/auth/codex-subscription/callback'

export const CODEX_BROWSER_RETURN_PATH = '/llm-models/providers/codex-subscription'

export function isPublicCodexCliClient(clientId: string): boolean {
  return clientId === PUBLIC_CODEX_CLI_CLIENT_ID
}

export function normalizeControlUiOrigin(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('control-ui base URL is not a valid URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('control-ui base URL must use http or https')
  }
  if (!url.hostname) {
    throw new Error('control-ui base URL is missing a host')
  }
  const path = url.pathname.replace(/\/+$/, '')
  if (path.length > 0) {
    throw new Error('control-ui base URL must not include a path')
  }
  return `${url.protocol}//${url.host}`
}

export function isLoopbackHttpOrigin(origin: string): boolean {
  try {
    const url = new URL(origin)
    return (
      url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
    )
  } catch {
    return false
  }
}

/**
 * Resolve the deployment control-ui origin. In local loopback profiles the live
 * browser Origin may differ from the declared ConfigMap port; accept it only
 * when both sides are loopback HTTP.
 */
export function resolveCodexControlUiBaseUrl(
  configuredBaseUrl: string,
  originHeader: string | undefined
): string {
  const configured = normalizeControlUiOrigin(configuredBaseUrl)
  if (!originHeader) return configured
  try {
    const requestOrigin = normalizeControlUiOrigin(originHeader)
    if (isLoopbackHttpOrigin(configured) && isLoopbackHttpOrigin(requestOrigin)) {
      return requestOrigin
    }
  } catch {
    return configured
  }
  return configured
}

/**
 * Derive the OAuth callback from the public control-ui origin. OpenAI must see
 * this exact value in authorize and token exchange.
 */
export function buildCodexBrowserRedirectUri(controlUiBaseUrl: string): string {
  return `${normalizeControlUiOrigin(controlUiBaseUrl)}${CODEX_BROWSER_CALLBACK_PROXY_PATH}`
}

/** Public host seen by the browser after the control-ui proxy forwards the callback. */
export function resolveCodexCallbackControlUiBaseUrl(input: {
  configuredBaseUrl: string
  forwardedHost?: string | null
  forwardedProto?: string | null
  originHeader?: string | null
}): string {
  const configured = resolveCodexControlUiBaseUrl(
    input.configuredBaseUrl,
    input.originHeader ?? undefined
  )
  const forwardedHost = input.forwardedHost?.split(',')[0]?.trim()
  const forwardedProto = input.forwardedProto?.split(',')[0]?.trim()
  if (!forwardedHost || !forwardedProto) return configured
  try {
    const forwarded = normalizeControlUiOrigin(`${forwardedProto}://${forwardedHost}`)
    if (forwarded === configured) return forwarded
    if (isLoopbackHttpOrigin(configured) && isLoopbackHttpOrigin(forwarded)) return forwarded
  } catch {
    return configured
  }
  return configured
}

export function buildCodexBrowserReturnLocation(outcome: string): string {
  return `${CODEX_BROWSER_RETURN_PATH}?codex_oauth=${encodeURIComponent(outcome)}`
}
