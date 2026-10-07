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
  getSessionState: () => Promise<{ authenticated: boolean }>
  handleSandboxUiDeepLink: (rawUrl: string) => boolean
  isRendererReady: () => boolean
  logout: () => Promise<unknown>
  reportLogoutFailure: (error: unknown) => void
  maxPendingUrls?: number
  requestMainWindow: () => void
  sandboxUiDeepLinkHost: string
  shouldAcceptSandboxUiProtocolLink: (rawUrl: string) => boolean
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
  const maxPendingUrls = options.maxPendingUrls ?? DEFAULT_MAX_PENDING_EVENFIRE_URLS

  const getReadyWindow = () => {
    const window = options.getWindow()
    if (!window || window.isDestroyed() || !options.isRendererReady()) return null
    return window
  }

  const enqueuePending = (rawUrl: string): void => {
    if (pendingEvenfireUrls.includes(rawUrl)) return
    pendingEvenfireUrls.push(rawUrl)
    if (pendingEvenfireUrls.length > maxPendingUrls) {
      pendingEvenfireUrls.shift()
    }
  }

  const sendDesktopEnvironmentSetup = (parsed: URL, rawUrl: string): void => {
    const externalRestApiBaseUrl = parsed.searchParams.get('externalRestApiBaseUrl') || ''
    const rpcProxyBaseUrl = parsed.searchParams.get('rpcProxyBaseUrl') || ''
    const appName =
      parsed.searchParams.get('tenantName') || parsed.searchParams.get('appName') || ''
    if (!externalRestApiBaseUrl) return

    const window = getReadyWindow()
    if (window) {
      options.focusMainWindow()
      window.webContents.send('auth:desktopEnvironmentSetup', {
        externalRestApiBaseUrl,
        rpcProxyBaseUrl,
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

  const reportLogoutFailure = async (error: unknown): Promise<void> => {
    try {
      options.reportLogoutFailure(error)
    } catch {
      // Logging must not turn this fire-and-forget protocol into an unhandled
      // rejection or prevent the renderer from reflecting the auth state.
    }

    let authenticated: boolean
    try {
      authenticated = (await options.getSessionState()).authenticated
    } catch (stateError) {
      try {
        options.reportLogoutFailure(stateError)
      } catch {
        // The protocol has no failure response channel.
      }
      return
    }
    if (authenticated) return

    const window = options.getWindow()
    if (!window || window.isDestroyed()) return
    options.focusMainWindow()
    window.webContents.send('auth:externalLogout')
  }

  const handle = (rawUrl: string): void => {
    let parsed: URL
    try {
      parsed = new URL(rawUrl)
    } catch {
      return
    }
    if (parsed.protocol !== `${appProtocol}:`) return

    const hostname = parsed.hostname.toLowerCase()
    if (hostname === sandboxUiDeepLinkHost) {
      if (!options.shouldAcceptSandboxUiProtocolLink(rawUrl)) return
      options.handleSandboxUiDeepLink(rawUrl)
      return
    }

    if (hostname === 'logout') {
      void options.logout().then(
        () => {
          const window = options.getWindow()
          if (!window || window.isDestroyed()) return
          options.focusMainWindow()
          window.webContents.send('auth:externalLogout')
        },
        error => {
          // The in-memory session can already be cleared when persisted-token
          // deletion fails. Report that state change to the renderer, but never
          // emit success while the service still considers the user signed in.
          void reportLogoutFailure(error)
        }
      )
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
