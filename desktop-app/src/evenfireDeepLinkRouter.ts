import {
  DESKTOP_ENVIRONMENT_DEEP_LINK_HOST,
  DESKTOP_SETUP_DEEP_LINK_HOST,
  parseDesktopEnvironmentDeepLink,
  parseDesktopSetupDeepLink,
} from '@clerum/desktop-app-links'

type RendererTarget = {
  isDestroyed: () => boolean
  webContents: {
    send: (channel: string, payload?: unknown) => void
  }
}

/** Return values are ignored: each handler decides on its own whether the link has any effect. */
export type EvenfireDeepLinkHandler = (rawUrl: string) => void

type EvenfireDeepLinkRouterOptions<TWindow extends RendererTarget> = {
  appProtocol: string
  focusMainWindow: () => void
  getWindow: () => TWindow | null
  isRendererReady: () => boolean
  logout: () => Promise<unknown>
  maxPendingUrls?: number
  /** Receives only the lowercased host of the evicted link, never the link itself. */
  onPendingUrlDropped?: (host: string) => void
  requestMainWindow: () => void
  /** Hosts resolved by the caller (e.g. `app`, `files`); keys are matched case-insensitively. */
  routes: Readonly<Record<string, EvenfireDeepLinkHandler>>
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
  const maxPendingUrls = options.maxPendingUrls ?? DEFAULT_MAX_PENDING_EVENFIRE_URLS

  const getReadyWindow = () => {
    const window = options.getWindow()
    if (!window || window.isDestroyed() || !options.isRendererReady()) return null
    return window
  }

  const reportDroppedPendingUrl = (dropped: string | undefined): void => {
    if (!options.onPendingUrlDropped) return
    let host = 'unknown'
    try {
      host = new URL(dropped ?? '').hostname.toLowerCase()
    } catch {
      // Startup argv is enqueued unvalidated, so the evicted entry may not be a URL at all.
    }
    try {
      options.onPendingUrlDropped(host)
    } catch {
      // Reporting is best effort: a throwing reporter must not abort the startup enqueue loop
      // or the second-instance handoff that called enqueuePending.
    }
  }

  const enqueuePending = (rawUrl: string): void => {
    if (pendingEvenfireUrls.includes(rawUrl)) return
    pendingEvenfireUrls.push(rawUrl)
    if (pendingEvenfireUrls.length > maxPendingUrls) {
      const dropped = pendingEvenfireUrls.shift()
      reportDroppedPendingUrl(dropped)
    }
  }

  const sendDesktopEnvironmentSetup = (rawUrl: string): void => {
    const target = parseDesktopEnvironmentDeepLink(rawUrl)
    if (!target) return
    const { externalRestApiBaseUrl, appName } = target

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

  const sendDesktopSetupToken = (rawUrl: string): void => {
    const target = parseDesktopSetupDeepLink(rawUrl)
    if (!target) return
    const { email, authorizationToken } = target

    const window = getReadyWindow()
    if (window) {
      options.focusMainWindow()
      window.webContents.send('auth:desktopSetupToken', { email, authorizationToken })
      return
    }

    enqueuePending(rawUrl)
    options.requestMainWindow()
  }

  const logout = (): void => {
    void options.logout().finally(() => {
      const window = options.getWindow()
      if (!window || window.isDestroyed()) return
      options.focusMainWindow()
      window.webContents.send('auth:externalLogout')
    })
  }

  // A Map, not an object lookup: a host such as `__proto__` must resolve to "no route" instead of
  // an inherited Object.prototype member, which would throw and abort the caller's forEach.
  const routes = new Map<string, EvenfireDeepLinkHandler>()
  const addRoute = (host: string, handler: EvenfireDeepLinkHandler): void => {
    const key = host.toLowerCase()
    if (routes.has(key)) {
      throw new Error(`Duplicate evenfire deep-link route for host "${key}"`)
    }
    routes.set(key, handler)
  }
  addRoute('logout', logout)
  addRoute(DESKTOP_ENVIRONMENT_DEEP_LINK_HOST, sendDesktopEnvironmentSetup)
  addRoute(DESKTOP_SETUP_DEEP_LINK_HOST, sendDesktopSetupToken)
  for (const [host, handler] of Object.entries(options.routes)) {
    addRoute(host, handler)
  }

  const handle = (rawUrl: string): void => {
    let parsed: URL
    try {
      parsed = new URL(rawUrl)
    } catch {
      return
    }
    if (parsed.protocol !== `${appProtocol}:`) return

    routes.get(parsed.hostname.toLowerCase())?.(rawUrl)
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
