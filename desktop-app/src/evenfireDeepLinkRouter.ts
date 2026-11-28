import { DESKTOP_LOGIN_DEEP_LINK_HOST } from './browserSignInModel.js'

type RendererTarget = {
  isDestroyed: () => boolean
  webContents: {
    send: (channel: string, payload?: unknown) => void
  }
}

type EvenfireDeepLinkRouterOptions<TWindow extends RendererTarget> = {
  appProtocol: string
  focusMainWindow: () => void
  getWindow: () => TWindow | null
  handleSandboxUiDeepLink: (rawUrl: string) => boolean
  handleGfsResourceDeepLink: (rawUrl: string) => boolean
  /**
   * Main's `desktop-login` handler (D8). The router calls it synchronously and does nothing else
   * with the link: no send, no focus, no queue, no log.
   */
  handleDesktopLoginLink: (rawUrl: string) => void
  isRendererReady: () => boolean
  logout: () => Promise<unknown>
  gfsResourceDeepLinkHost: string
  maxPendingUrls?: number
  requestMainWindow: () => void
  sandboxUiDeepLinkHost: string
  shouldAcceptSandboxUiProtocolLink: (rawUrl: string) => boolean
  shouldAcceptGfsResourceProtocolLink: (rawUrl: string) => boolean
}

export type EvenfireDeepLinkRouter = {
  drainPending: () => void
  enqueuePending: (rawUrl: string) => void
  handle: (rawUrl: string) => void
}

const DEFAULT_MAX_PENDING_EVENFIRE_URLS = 20

export function createEvenfireDeepLinkRouter<TWindow extends RendererTarget>(
  options: EvenfireDeepLinkRouterOptions<TWindow>
): EvenfireDeepLinkRouter {
  const pendingEvenfireUrls: string[] = []
  const appProtocol = options.appProtocol.replace(/:$/, '').toLowerCase()
  const sandboxUiDeepLinkHost = options.sandboxUiDeepLinkHost.toLowerCase()
  const gfsResourceDeepLinkHost = options.gfsResourceDeepLinkHost.toLowerCase()
  const maxPendingUrls = options.maxPendingUrls ?? DEFAULT_MAX_PENDING_EVENFIRE_URLS

  const getReadyWindow = () => {
    const window = options.getWindow()
    if (!window || window.isDestroyed() || !options.isRendererReady()) return null
    return window
  }

  /**
   * The parsed link and its lower-cased host when `rawUrl` is an app-protocol URL; otherwise
   * null. `handle` and `enqueuePending` both classify through it, so they agree on every host in
   * any letter case.
   */
  const parseAppLink = (rawUrl: string): Readonly<{ parsed: URL; hostname: string }> | null => {
    let parsed: URL
    try {
      parsed = new URL(rawUrl)
    } catch {
      // Not a URL, so no link this router serves: it is dropped, as before. It is not logged,
      // because the string may carry a code or a token (D18).
      return null
    }
    if (parsed.protocol !== `${appProtocol}:`) return null
    return { parsed, hostname: parsed.hostname.toLowerCase() }
  }

  const enqueuePending = (rawUrl: string): void => {
    // A desktop-login link is never queued (D8, A3-31): it carries a code, and it would take the
    // slot of a queued setup link. The links main.ts queues are the ones the app was launched
    // with, and no attempt (kept in memory only) can be waiting for those.
    if (parseAppLink(rawUrl)?.hostname === DESKTOP_LOGIN_DEEP_LINK_HOST) return
    if (pendingEvenfireUrls.includes(rawUrl)) return
    pendingEvenfireUrls.push(rawUrl)
    if (pendingEvenfireUrls.length > maxPendingUrls) {
      pendingEvenfireUrls.shift()
    }
  }

  const sendDesktopEnvironmentSetup = (parsed: URL, rawUrl: string): void => {
    const externalRestApiBaseUrl = parsed.searchParams.get('externalRestApiBaseUrl') || ''
    const appName =
      parsed.searchParams.get('tenantName') || parsed.searchParams.get('appName') || ''
    if (!externalRestApiBaseUrl) return

    const window = getReadyWindow()
    if (window) {
      options.focusMainWindow()
      window.webContents.send('auth:desktopEnvironmentSetup', {
        externalRestApiBaseUrl,
        appName,
      })
      return
    }

    enqueuePending(rawUrl)
    options.requestMainWindow()
  }

  const sendDesktopSetupToken = (parsed: URL, rawUrl: string): void => {
    const email = parsed.searchParams.get('email') || ''
    const authorizationToken = parsed.searchParams.get('authorizationToken') || ''
    if (!email || !authorizationToken) return

    const window = getReadyWindow()
    if (window) {
      options.focusMainWindow()
      window.webContents.send('auth:desktopSetupToken', { email, authorizationToken })
      return
    }

    enqueuePending(rawUrl)
    options.requestMainWindow()
  }

  const handle = (rawUrl: string): void => {
    const appLink = parseAppLink(rawUrl)
    if (appLink === null) return
    const { parsed, hostname } = appLink

    if (hostname === DESKTOP_LOGIN_DEEP_LINK_HOST) {
      options.handleDesktopLoginLink(rawUrl)
      return
    }

    if (hostname === sandboxUiDeepLinkHost) {
      if (!options.shouldAcceptSandboxUiProtocolLink(rawUrl)) return
      options.handleSandboxUiDeepLink(rawUrl)
      return
    }

    if (hostname === gfsResourceDeepLinkHost) {
      if (!options.shouldAcceptGfsResourceProtocolLink(rawUrl)) return
      options.handleGfsResourceDeepLink(rawUrl)
      return
    }

    if (hostname === 'logout') {
      void options.logout().finally(() => {
        const window = options.getWindow()
        if (!window || window.isDestroyed()) return
        options.focusMainWindow()
        window.webContents.send('auth:externalLogout')
      })
      return
    }

    if (hostname === 'desktop-environment') {
      sendDesktopEnvironmentSetup(parsed, rawUrl)
      return
    }

    if (hostname === 'desktop-setup') {
      sendDesktopSetupToken(parsed, rawUrl)
    }
  }

  const drainPending = (): void => {
    if (!options.isRendererReady()) return
    const pendingBatch = pendingEvenfireUrls.splice(0)
    pendingBatch.forEach(handle)
  }

  return {
    drainPending,
    enqueuePending,
    handle,
  }
}
