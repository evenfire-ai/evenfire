import { type Session, type WebContents, shell } from 'electron'

/**
 * Sandbox-ui Session and webContents policies.
 *
 * Each per-recipe partition gets default-deny permission handlers, a
 * blanket download block, a will-navigate guard that pins the embed to
 * its own `view/*` URL space, and a setWindowOpenHandler that funnels
 * every `window.open()` call to the OS browser.
 *
 * The pure helpers (`shouldAllowEmbedPermission`, `classifyEmbedNavigation`)
 * are testable in isolation; the `apply*` functions wire them onto the
 * Electron objects.
 */

/**
 * Deny `media`, `geolocation`, `notifications`, `midiSysex`, `pointerLock`,
 * `serial`, `hid`, `bluetooth`, `usb`. Allow `fullscreen` only. Treated as
 * default-deny so future permissions added by Electron are rejected unless
 * explicitly enumerated.
 */
export function shouldAllowEmbedPermission(name: string): boolean {
  return name === 'fullscreen'
}

export type EmbedNavigationOutcome =
  /** URL is on the recipe's own view/* prefix — let it through. */
  | { kind: 'allow' }
  /** http(s) URL outside the recipe — punt to the OS browser. */
  | { kind: 'external'; url: string }
  /** `clerum://oauth?clientId=…` — recipe-author affordance for an OAuth
   *  Connect button. Driver fetches the provider authorize URL via
   *  rpc-proxy and opens it in the OS browser. `background` is true when
   *  `background=1` was included in the deep link. */
  | { kind: 'oauth_authorize'; oauthClientId: string; background: boolean }
  /** non-http(s) scheme or empty URL — drop silently. */
  | { kind: 'drop' }

/**
 * Classify a candidate navigation URL against the recipe's allowed
 * `view/*` prefix. Pure function — no Electron coupling, easy to test.
 */
export function classifyEmbedNavigation(
  rawUrl: string,
  allowedPrefix: string
): EmbedNavigationOutcome {
  if (!rawUrl) return { kind: 'drop' }
  if (rawUrl.startsWith(allowedPrefix)) return { kind: 'allow' }
  if (rawUrl.startsWith('clerum:')) {
    const parsed = parseClerumOauthAuthorize(rawUrl)
    return parsed
      ? { kind: 'oauth_authorize', oauthClientId: parsed.oauthClientId, background: parsed.background }
      : { kind: 'drop' }
  }
  if (rawUrl.startsWith('https://') || rawUrl.startsWith('http://')) {
    return { kind: 'external', url: rawUrl }
  }
  return { kind: 'drop' }
}

/**
 * Parse `clerum://oauth?clientId=<id>[&background=1]` (the recipe-author
 * affordance) and return `{ oauthClientId, background }`. Returns null for
 * any other clerum: URL — the `oauth-completed` deep link is consumed by the
 * main process's `open-url` handler, never by an embed navigation, so it
 * must not match here.
 */
export function parseClerumOauthAuthorize(
  rawUrl: string
): { oauthClientId: string; background: boolean } | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  if (url.protocol !== 'clerum:') return null
  if (url.hostname !== 'oauth') return null
  const oauthClientId = url.searchParams.get('clientId')?.trim()
  if (!oauthClientId) return null
  const background = url.searchParams.get('background') === '1'
  return { oauthClientId, background }
}

/**
 * Per-Session policy: permission handlers, download block. Idempotent —
 * calling on the same Session twice replaces the previous handler with
 * the same one. Each per-recipe partition's Session gets these once at
 * mount.
 */
export function applySandboxUiPartitionPolicies(ses: Session): void {
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(shouldAllowEmbedPermission(permission))
  })
  ses.setPermissionCheckHandler((_wc, permission) => {
    return shouldAllowEmbedPermission(permission)
  })
  // Ad-hoc `removeAllListeners` keeps repeat-mount of the same recipe
  // partition from stacking listeners across opens. Fresh `on` after.
  ses.removeAllListeners('will-download')
  ses.on('will-download', event => {
    event.preventDefault()
  })
}

/**
 * Per-WebContents policy: `will-navigate` guards top-level navigation,
 * `setWindowOpenHandler` enforces "every `window.open()` opens in the OS
 * browser".
 *
 * `onOauthAuthorize` (optional) is fired when the embed navigates to
 * `clerum://oauth?clientId=…` — the driver hands the clientId off to the
 * main process which fetches the provider authorize URL via rpc-proxy and
 * `shell.openExternal`s it.
 */
export function applySandboxUiNavigationPolicies(
  webContents: WebContents,
  allowedPrefix: string,
  onOauthAuthorize?: (oauthClientId: string, background: boolean) => void
): void {
  webContents.on('will-navigate', (event, url) => {
    const outcome = classifyEmbedNavigation(url, allowedPrefix)
    if (outcome.kind === 'allow') return
    event.preventDefault()
    if (outcome.kind === 'external') {
      void shell.openExternal(outcome.url)
    } else if (outcome.kind === 'oauth_authorize') {
      onOauthAuthorize?.(outcome.oauthClientId, outcome.background)
    }
  })
  webContents.setWindowOpenHandler(({ url }) => {
    // `window.open` always opens in OS browser (for http(s)).
    // `clerum://oauth?…` triggers the OAuth flow same as a top-level click;
    // non-http schemes otherwise drop silently.
    const outcome = classifyEmbedNavigation(url, allowedPrefix)
    if (outcome.kind === 'external') {
      void shell.openExternal(outcome.url)
    } else if (outcome.kind === 'oauth_authorize') {
      onOauthAuthorize?.(outcome.oauthClientId, outcome.background)
    }
    return { action: 'deny' }
  })
}
