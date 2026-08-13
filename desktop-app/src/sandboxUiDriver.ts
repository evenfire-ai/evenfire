import { BrowserWindow, WebContentsView, screen, session } from 'electron'
import path from 'node:path'
import { getActiveEnvKey } from './config.js'
import { extractSandboxUiViewRoute, normalizeSandboxUiRoute } from './sandboxUiDeepLinks.js'
import { touchSandboxUiPartition } from './sandboxUiPartitionGc.js'
import {
  applySandboxUiNavigationPolicies,
  applySandboxUiPartitionPolicies,
  isSandboxUiNavigationWithinPrefix as isNavigationWithinPrefix,
} from './sandboxUiPartitionPolicies.js'
import { wireDesktopShortcutRouting } from './shortcutRouter.js'

/**
 * Sandbox UI embed driver. Owns the lifecycle of the single active
 * `WebContentsView` that hosts a recipe's sandbox UI inside the main
 * desktop window.
 *
 * One-at-a-time embed: the driver is a singleton. Mounting recipe B while A
 * is up tears down A first; A's per-recipe Electron partition is left intact
 * so a quick A → B → A round-trip doesn't lose cookies/storage (the launch-
 * time GC pass handles eventual eviction).
 *
 * Cookie installation: the rpc-proxy session-mint runs in the main process
 * (via `RpcProxyClient.mintSandboxUiSession`). Its raw Set-Cookie value is
 * parsed and written into the partition's session BEFORE the first `view/*`
 * navigation, so the cookie is on the very first request. The proxy also
 * validates the cookie's recipeNs/recipeName claim against the URL path on
 * every hit, so a partition that ended up with a cookie minted for a
 * different recipe still gets rejected with 401 by rpc-proxy — the JWT
 * claim binding is the second line of defence.
 *
 * Hardened webPreferences:
 *   nodeIntegration:false  — no Node API exposed to embed JS
 *   contextIsolation:true  — preload runs in its own world
 *   sandbox:true           — Chromium sandbox (OS-level)
 *   webSecurity:true       — same-origin policy enforced
 *   no `remote`            — Electron's deprecated remote module never on
 */

export const SANDBOX_UI_COOKIE_NAME = 'clerum_sandbox_ui_session'
const CLIENT_ROUTE_HANDOFF_TIMEOUT_MS = 30_000

export type SandboxUiBounds = {
  x: number
  y: number
  width: number
  height: number
  dpr?: number
}

export type SandboxUiFindResult = {
  requestId: number
  activeMatchOrdinal: number
  matches: number
  finalUpdate: boolean
}

function toViewBounds(
  bounds: SandboxUiBounds,
  parentWindow: BrowserWindow
): { x: number; y: number; width: number; height: number } {
  // Renderer's CSS pixels and macOS points diverge when the user is on a
  // scaled display (e.g. "Larger Text" mode reports devicePixelRatio=2.4
  // to the renderer while the screen's scaleFactor stays at 2.0).
  // WebContentsView.setBounds expects points, so multiply by dpr/scaleFactor
  // — a no-op when they match (the common 1× / 2× case).
  const sf = screen.getDisplayMatching(parentWindow.getBounds()).scaleFactor
  const dpr = bounds.dpr ?? sf
  if (Math.abs(dpr - sf) < 0.01) {
    return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
  }
  const factor = dpr / sf
  return {
    x: Math.round(bounds.x * factor),
    y: Math.round(bounds.y * factor),
    width: Math.round(bounds.width * factor),
    height: Math.round(bounds.height * factor),
  }
}

export type MountSandboxUiArgs = {
  recipeNs: string
  recipeName: string
  setCookie: string
  rpcProxyUrl: string
  defaultPath?: string
  parentWindow: BrowserWindow
  bounds: SandboxUiBounds
  routePath?: string
  onClosed?: () => void
  /**
   * Spec §9.9 — recipe-author Connect button affordance. Fired when the
   * embed navigates to `clerum://oauth?clientId=…`. The driver's only
   * job is to forward; the AppService method this points at calls
   * rpc-proxy for the provider authorize URL and `shell.openExternal`s it.
   */
  onOauthAuthorize?: (oauthClientId: string, background: boolean) => void
  /**
   * Fired when the embed navigates to `gfs://<drive>/<resource>` — a plugin
   * rendering a link to a shared file. The driver only forwards; the host
   * resolves the URI with the USER's session and shows it in the Desktop's own
   * viewer, so a click reveals nothing to the plugin.
   */
  onGfsOpen?: (uri: string) => void
}

type ActiveView = {
  view: WebContentsView
  recipeNs: string
  recipeName: string
  defaultPath: string
  partition: string
  parentWindow: BrowserWindow
  rpcProxyOrigin: string
  cleanupClientRouteHandoff?: () => void
  cleanupParentClosed?: () => void
  cleanupShortcutRouting?: () => void
  cleanupFindResults?: () => void
  activeFindRequestId?: number
}

let active: ActiveView | null = null
let mountGeneration = 0

export const isSandboxUiNavigationWithinPrefix = isNavigationWithinPrefix

export function getActiveSandboxUi(): {
  recipeNs: string
  recipeName: string
  appRef: string
  webContentsId: number
} | null {
  if (!active) return null
  return {
    recipeNs: active.recipeNs,
    recipeName: active.recipeName,
    appRef: `${active.recipeNs}/${active.recipeName}`,
    webContentsId: active.view.webContents.id,
  }
}

export function getActiveSandboxUiLocation(): {
  recipeNs: string
  recipeName: string
  path?: string
} | null {
  if (!active) return null
  if (active.view.webContents.isDestroyed()) return null
  const path = resolveSandboxUiSharePath({
    currentUrl: active.view.webContents.getURL(),
    rpcProxyOrigin: active.rpcProxyOrigin,
    recipeNs: active.recipeNs,
    recipeName: active.recipeName,
    defaultPath: active.defaultPath,
  })
  return {
    recipeNs: active.recipeNs,
    recipeName: active.recipeName,
    ...(path ? { path } : {}),
  }
}

export function resolveSandboxUiSharePath(input: {
  currentUrl: string
  rpcProxyOrigin: string
  recipeNs: string
  recipeName: string
  defaultPath: string
}): string | undefined {
  if (!input.currentUrl.trim()) return undefined
  const currentPath = extractSandboxUiViewRoute(input)
  if (currentPath === null) throw new Error('Cannot read the current app route')
  return currentPath === sharedPathForDefaultPath(input.defaultPath) ? undefined : currentPath
}

export function partitionFor(envKey: string, recipeNs: string, recipeName: string): string {
  // Per-(environment, recipe) partition — Chromium isolates storage (cookies,
  // IndexedDB, localStorage, service workers) by partition. `envKey` (spec §5.2)
  // scopes it so the same recipe ns/name in two clusters never shares KasmVNC
  // cookies/storage. The launch-time GC pass walks the current env's
  // `persist:sandbox-ui-${envKey}-*` partitions and wipes the ones the user no
  // longer has ACL for; other environments' partitions are left untouched.
  return `persist:sandbox-ui-${envKey}-${recipeNs}-${recipeName}`
}

/**
 * Pull the cookie value out of a Set-Cookie header. Accepts either a
 * single value or an array (Node's `getSetCookie()` API). Returns null
 * when the named cookie is absent or the header is malformed.
 */
export function extractSandboxUiCookie(
  setCookie: string | string[],
  name: string = SANDBOX_UI_COOKIE_NAME
): string | null {
  const list = Array.isArray(setCookie) ? setCookie : [setCookie]
  const prefix = `${name}=`
  for (const header of list) {
    if (header.startsWith(prefix)) {
      const rest = header.slice(prefix.length)
      const end = rest.indexOf(';')
      return end === -1 ? rest : rest.slice(0, end)
    }
  }
  return null
}

/**
 * Pull the Path attribute out of a Set-Cookie header. Falls back to
 * '/api/v1/sandbox-ui/<ns>/<name>/' if the header omits it (rpc-proxy
 * always sets it, but we never want to install a cookie at a wider path
 * than the one the server intended).
 */
export function extractSandboxUiPath(
  setCookie: string | string[],
  recipeNs: string,
  recipeName: string
): string {
  const list = Array.isArray(setCookie) ? setCookie : [setCookie]
  for (const header of list) {
    const match = /;\s*Path=([^;]+)/i.exec(header)
    const captured = match?.[1]
    if (captured) return captured.trim()
  }
  return `/api/v1/sandbox-ui/${encodeURIComponent(recipeNs)}/${encodeURIComponent(recipeName)}/`
}

/**
 * Write a session cookie into the per-recipe Electron partition. Used both
 * at mount-time (initial cookie) and at refresh-time (rotated cookie). The
 * cookie is keyed on `(name, path)` so calling this with a fresh value at
 * the same Path replaces the existing entry — the embed sees the new JWT
 * on its next request without any `view/*` reload.
 */
async function writeSandboxUiCookie(args: {
  rpcProxyOrigin: string
  recipeNs: string
  recipeName: string
  setCookie: string | string[]
  partition: string
}): Promise<void> {
  const { rpcProxyOrigin, recipeNs, recipeName, setCookie, partition } = args
  const cookieValue = extractSandboxUiCookie(setCookie)
  if (!cookieValue) {
    throw new Error(`session response did not include ${SANDBOX_UI_COOKIE_NAME} cookie`)
  }
  const cookiePath = extractSandboxUiPath(setCookie, recipeNs, recipeName)
  const ses = session.fromPartition(partition)
  await ses.cookies.set({
    url: `${rpcProxyOrigin}${cookiePath}`,
    name: SANDBOX_UI_COOKIE_NAME,
    value: cookieValue,
    path: cookiePath,
    httpOnly: true,
    sameSite: 'strict',
    // Mirror the proxy's Secure attribute when it's serving https.
    secure: rpcProxyOrigin.startsWith('https:'),
  })
}

/**
 * Refresh the active partition's session cookie. No-op when nothing is
 * mounted (refresh can race with teardown). Throws on a missing cookie
 * value or a partition write error so the caller can surface a refresh
 * failure to the user.
 */
export async function installSandboxUiCookie(setCookie: string | string[]): Promise<void> {
  if (!active) return
  const expectedPath =
    `/api/v1/sandbox-ui/${encodeURIComponent(active.recipeNs)}/` +
    `${encodeURIComponent(active.recipeName)}/`
  const cookiePath = extractSandboxUiPath(setCookie, active.recipeNs, active.recipeName)
  if (cookiePath !== expectedPath) {
    throw new Error(`sandbox-ui refresh cookie path ${cookiePath} does not match the active recipe`)
  }
  await writeSandboxUiCookie({
    rpcProxyOrigin: active.rpcProxyOrigin,
    recipeNs: active.recipeNs,
    recipeName: active.recipeName,
    setCookie,
    partition: active.partition,
  })
}

async function teardownActive(reason: 'replaced' | 'closed' | 'parent_closed'): Promise<void> {
  if (!active) return
  const current = active
  active = null
  try {
    current.cleanupClientRouteHandoff?.()
    current.cleanupParentClosed?.()
    current.cleanupShortcutRouting?.()
    current.cleanupFindResults?.()
    if (!current.view.webContents.isDestroyed()) {
      current.view.webContents.stopFindInPage('clearSelection')
    }
    // contentView.removeChildView is the documented teardown step; it both
    // detaches the view from layout AND severs the parent's ownership ref.
    if (!current.parentWindow.isDestroyed()) {
      current.parentWindow.contentView.removeChildView(current.view)
    }
    // Closing the webContents stops loading + frees the renderer process.
    if (!current.view.webContents.isDestroyed()) {
      current.view.webContents.close()
    }
  } catch (err) {
    console.error('[SandboxUI] teardown error:', err, 'reason:', reason)
  }
}

export async function mountSandboxUiView(args: MountSandboxUiArgs): Promise<void> {
  const {
    recipeNs,
    recipeName,
    setCookie,
    rpcProxyUrl,
    defaultPath,
    parentWindow,
    bounds,
    routePath,
    onClosed,
  } = args

  if (parentWindow.isDestroyed()) {
    throw new Error('parent window is destroyed')
  }
  if (!recipeNs.trim() || !recipeName.trim()) {
    throw new Error('recipeNs and recipeName are required')
  }

  // Publish intent before the first await. A newer mount or unmount invalidates
  // this operation while cookie installation is in flight, preventing an older
  // request from attaching a view after the user has moved on.
  const generation = ++mountGeneration

  // Tear down any existing view before mounting (one-at-a-time embed). The
  // per-recipe partition is left in place so storage survives a re-mount
  // within the ACL window.
  await teardownActive('replaced')
  if (generation !== mountGeneration) return

  const partition = partitionFor(getActiveEnvKey(), recipeNs, recipeName)
  const proxyOriginUrl = new URL(rpcProxyUrl).toString().replace(/\/+$/, '')
  const viewPath = resolveSandboxUiDefaultPath(defaultPath)
  const clientRoutePath = normalizeSandboxUiRoute(routePath || '')
  const sharedViewPath = sharedPathForDefaultPath(viewPath)
  const allowedNavigationPrefix =
    `${proxyOriginUrl}/api/v1/sandbox-ui/` +
    `${encodeURIComponent(recipeNs)}/${encodeURIComponent(recipeName)}/view`

  // Install the session cookie BEFORE creating the view so the very first
  // navigation request carries it. The proxy enforces the recipe binding
  // claim on every request — installing on a stale partition would still
  // fail closed at rpc-proxy.
  await writeSandboxUiCookie({
    rpcProxyOrigin: proxyOriginUrl,
    recipeNs,
    recipeName,
    setCookie,
    partition,
  })
  if (generation !== mountGeneration) return
  if (parentWindow.isDestroyed()) {
    throw new Error('parent window is destroyed')
  }

  // Apply default-deny permission + download policy on the partition's
  // Session before the view is constructed so the very first navigation
  // already runs under those rules.
  const ses = session.fromPartition(partition)
  applySandboxUiPartitionPolicies(ses)

  const view = new WebContentsView({
    webPreferences: {
      partition,
      // The embed preload exposes `clerum.requestSessionRefresh()` so an
      // embed can recover from an SSE 401 between scheduled refreshes. The
      // handler in main process gates the call by the IPC pinning map +
      // 30 s rate-limit.
      preload: path.join(__dirname, 'sandboxUiEmbedPreload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      // Defence-in-depth — no spell-check / no auto form-fill is required,
      // but Electron defaults already disable those for sandboxed
      // partitions. Audit if upgrading Electron majors.
    },
  })

  view.setBounds(toViewBounds(bounds, parentWindow))

  // Pin top-level navigation to this recipe's `view/*` prefix; everything
  // else (links to other origins, target=_blank, window.open) goes to the
  // OS browser or is dropped. `clerum://oauth?clientId=…` is intercepted
  // and handed back to the AppService.
  applySandboxUiNavigationPolicies(view.webContents, allowedNavigationPrefix, {
    onOauthAuthorize: (oauthClientId, background) => {
      args.onOauthAuthorize?.(oauthClientId, background)
    },
    onGfsOpen: uri => {
      args.onGfsOpen?.(uri)
    },
  })

  // The closed callback fires when the renderer gives up the view (parent
  // window closed, teardown via removeChildView, or the embed crashed).
  // For now we only wire the parent-window-closed case so the renderer can
  // re-render its picker; teardown via `unmountSandboxUiView` is a
  // synchronous user action (no callback needed).
  const onParentClosed = (): void => {
    void teardownActive('parent_closed')
    onClosed?.()
  }
  parentWindow.once('closed', onParentClosed)
  const cleanupParentClosed = (): void => {
    parentWindow.removeListener('closed', onParentClosed)
  }

  active = {
    view,
    recipeNs,
    recipeName,
    defaultPath: viewPath,
    partition,
    parentWindow,
    rpcProxyOrigin: proxyOriginUrl,
    cleanupParentClosed,
  }

  active.cleanupShortcutRouting = wireDesktopShortcutRouting({
    source: 'sandbox',
    sourceWebContents: view.webContents,
    trustedRenderer: parentWindow.webContents,
    isCurrentSource: () => active?.view.webContents.id === view.webContents.id,
  })

  parentWindow.contentView.addChildView(view)
  // Re-apply bounds after attach. On macOS at fractional DPR (e.g. 2.4 on a
  // "More Space" scaled display), setBounds called pre-attach lands the view
  // in a slightly offset coordinate system; re-applying after addChildView
  // forces it into the parent's now-resolved coords.
  view.setBounds(toViewBounds(bounds, parentWindow))

  // Record the mount as the partition's most recent access so the next
  // launch's LRU GC has fresh data. Fire-and-forget; a write failure is
  // logged inside the GC module and must not block the mount.
  void touchSandboxUiPartition(`${recipeNs}/${recipeName}`).catch(err => {
    console.warn('[SandboxUI] touchSandboxUiPartition failed:', err)
  })

  const url =
    `${proxyOriginUrl}/api/v1/sandbox-ui/` +
    `${encodeURIComponent(recipeNs)}/${encodeURIComponent(recipeName)}/view${encodeSandboxUiDefaultPath(
      viewPath
    )}`
  if (clientRoutePath && clientRoutePath !== sharedViewPath) {
    const encodedClientRoutePath = encodeSandboxUiRoutePath(clientRoutePath)
    const clientRouteUrl =
      `${proxyOriginUrl}/api/v1/sandbox-ui/` +
      `${encodeURIComponent(recipeNs)}/${encodeURIComponent(recipeName)}/view${encodedClientRoutePath}`
    let lastNavigation = { url: '', status: 0 }
    let handoffFinished = false
    let handoffTimeout: NodeJS.Timeout | null = null
    const cleanupClientRouteHandoff = () => {
      if (handoffFinished) return
      handoffFinished = true
      if (handoffTimeout) clearTimeout(handoffTimeout)
      view.webContents.removeListener('did-navigate', onDidNavigate)
      view.webContents.removeListener('did-finish-load', onDidFinishLoad)
    }
    const onDidNavigate = (
      _event: Electron.Event,
      navigatedUrl: string,
      httpResponseCode: number
    ) => {
      lastNavigation = { url: navigatedUrl, status: httpResponseCode }
    }
    const onDidFinishLoad = () => {
      if (!active || active.view !== view || view.webContents.isDestroyed()) {
        cleanupClientRouteHandoff()
        return
      }
      if (
        !canApplySandboxUiClientRoute({
          allowedNavigationPrefix,
          currentUrl: view.webContents.getURL(),
          navigatedUrl: lastNavigation.url,
          httpResponseCode: lastNavigation.status,
        })
      ) {
        if (
          lastNavigation.status >= 200 &&
          lastNavigation.status < 400 &&
          !isSandboxUiNavigationWithinPrefix(view.webContents.getURL(), allowedNavigationPrefix)
        ) {
          console.warn(
            '[SandboxUI] client route handoff abandoned after navigation left the app prefix:',
            view.webContents.getURL()
          )
          cleanupClientRouteHandoff()
        }
        return
      }
      void applySandboxUiClientRoute(view.webContents, clientRouteUrl)
        .then(applied => {
          if (!applied) {
            console.warn('[SandboxUI] client route handoff did not update the app URL')
          }
          cleanupClientRouteHandoff()
        })
        .catch(err => {
          console.warn('[SandboxUI] client route handoff failed:', err)
          cleanupClientRouteHandoff()
        })
    }
    view.webContents.on('did-navigate', onDidNavigate)
    view.webContents.on('did-finish-load', onDidFinishLoad)
    handoffTimeout = setTimeout(() => {
      console.warn('[SandboxUI] client route handoff timed out before the app became ready')
      cleanupClientRouteHandoff()
    }, CLIENT_ROUTE_HANDOFF_TIMEOUT_MS)
    if (active && active.view === view) {
      active.cleanupClientRouteHandoff = cleanupClientRouteHandoff
    }
  }
  // Drop the HTTP cache on every open so a stale entry from a prior
  // broken pod can't keep painting after the recipe is healthy. The
  // partition is persistent (cookies, IndexedDB, localStorage all
  // survive), only `Cache` is wiped — clearStorageData would also
  // nuke the session cookie and break auth on the very next request.
  // Fire-and-forget; loadURL re-issues unconditional GETs once the
  // cache directory is gone.
  void session
    .fromPartition(partition)
    .clearCache()
    .catch(err => {
      console.warn('[SandboxUI] clearCache failed:', err)
    })
  // No await — the load runs concurrently with the renderer animation.
  // The view is already attached + has bounds, so the user sees the URL
  // resolve into the embed naturally.
  void view.webContents.loadURL(url)
}

export async function applySandboxUiClientRoute(
  webContents: Pick<WebContentsView['webContents'], 'executeJavaScript' | 'isDestroyed'>,
  targetUrl: string
): Promise<boolean> {
  if (webContents.isDestroyed()) return false
  const serializedTarget = JSON.stringify(targetUrl)
  return Boolean(
    await webContents.executeJavaScript(`(() => {
      const targetUrl = new URL(${serializedTarget}).href;
      const previousUrl = window.location.href;
      if (new URL(previousUrl).href === targetUrl) return true;
      window.history.replaceState(window.history.state, '', targetUrl);
      window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
      return new URL(window.location.href).href === targetUrl;
    })()`)
  )
}

export function resolveSandboxUiDefaultPath(defaultPath?: string): string {
  const rawDefaultPath = String(defaultPath || '')
  if (!rawDefaultPath.trim()) return '/'
  const normalized = normalizeSandboxUiDefaultPath(rawDefaultPath)
  if (normalized) return normalized
  console.warn('[SandboxUI] Invalid recipe defaultPath; falling back to "/":', rawDefaultPath)
  return '/'
}

function encodeSandboxUiRoutePath(routePath: string): string {
  return routePath
    .split('/')
    .map((segment, index) => (index === 0 ? '' : encodeURIComponent(segment)))
    .join('/')
}

function firstDefaultPathMetaIndex(defaultPath: string): number | undefined {
  const firstQueryIndex = defaultPath.indexOf('?')
  const firstHashIndex = defaultPath.indexOf('#')
  return [firstQueryIndex, firstHashIndex].filter(index => index !== -1).sort((a, b) => a - b)[0]
}

function sharedPathForDefaultPath(defaultPath: string): string {
  const firstMetaIndex = firstDefaultPathMetaIndex(defaultPath)
  const pathname = firstMetaIndex === undefined ? defaultPath : defaultPath.slice(0, firstMetaIndex)
  return normalizeSandboxUiRoute(pathname || '/') || '/'
}

function normalizeSandboxUiDefaultMetadata(metadata: string): string | null {
  const hashIndex = metadata.indexOf('#')
  if (hashIndex === -1) return metadata
  const hashRouteStart = hashIndex + 1
  const hashRemainder = metadata.slice(hashRouteStart)
  const hashQueryIndex = hashRemainder.indexOf('?')
  const hashRoute = hashQueryIndex === -1 ? hashRemainder : hashRemainder.slice(0, hashQueryIndex)
  if (!hashRoute.startsWith('/')) return metadata
  const normalizedHashRoute = normalizeSandboxUiRoute(hashRoute)
  if (!normalizedHashRoute) return null
  return (
    metadata.slice(0, hashRouteStart) +
    normalizedHashRoute +
    (hashQueryIndex === -1 ? '' : hashRemainder.slice(hashQueryIndex))
  )
}

function encodeSandboxUiDefaultMetadata(metadata: string): string {
  const hashIndex = metadata.indexOf('#')
  if (hashIndex === -1) return metadata
  const hashRouteStart = hashIndex + 1
  const hashRemainder = metadata.slice(hashRouteStart)
  const hashQueryIndex = hashRemainder.indexOf('?')
  const hashRoute = hashQueryIndex === -1 ? hashRemainder : hashRemainder.slice(0, hashQueryIndex)
  if (!hashRoute.startsWith('/')) return metadata
  return (
    metadata.slice(0, hashRouteStart) +
    encodeSandboxUiRoutePath(hashRoute) +
    (hashQueryIndex === -1 ? '' : hashRemainder.slice(hashQueryIndex))
  )
}

function encodeSandboxUiDefaultPath(defaultPath: string): string {
  const firstMetaIndex = firstDefaultPathMetaIndex(defaultPath)
  const pathname = firstMetaIndex === undefined ? defaultPath : defaultPath.slice(0, firstMetaIndex)
  const metadata = firstMetaIndex === undefined ? '' : defaultPath.slice(firstMetaIndex)
  return `${encodeSandboxUiRoutePath(pathname || '/')}${encodeSandboxUiDefaultMetadata(metadata)}`
}

function normalizeSandboxUiDefaultPath(rawPath: string): string | null {
  const routePath = String(rawPath || '')
  if (!routePath.trim()) return '/'
  if (
    routePath.length > 4096 ||
    routePath.includes('\\') ||
    /[\u0000-\u001f\u007f\u2028\u2029]/.test(routePath)
  ) {
    return null
  }
  const firstMetaIndex = firstDefaultPathMetaIndex(routePath)
  const pathname = firstMetaIndex === undefined ? routePath : routePath.slice(0, firstMetaIndex)
  const metadata = firstMetaIndex === undefined ? '' : routePath.slice(firstMetaIndex)
  const normalizedPathname = normalizeSandboxUiRoute(pathname || '/')
  if (!normalizedPathname) return null
  const normalizedMetadata = normalizeSandboxUiDefaultMetadata(metadata)
  if (normalizedMetadata === null) return null
  return `${normalizedPathname}${normalizedMetadata}`
}

export function canApplySandboxUiClientRoute(input: {
  allowedNavigationPrefix: string
  currentUrl: string
  navigatedUrl: string
  httpResponseCode: number
}): boolean {
  return (
    isSandboxUiNavigationWithinPrefix(input.currentUrl, input.allowedNavigationPrefix) &&
    isSandboxUiNavigationWithinPrefix(input.navigatedUrl, input.allowedNavigationPrefix) &&
    input.httpResponseCode >= 200 &&
    input.httpResponseCode < 400
  )
}

/**
 * Unmount the active view (no-op if nothing is mounted). Called on user
 * "Close" / navigate-away. Leaves the per-recipe partition intact so a
 * re-mount within the ACL window is fast.
 */
export async function unmountSandboxUiView(): Promise<void> {
  mountGeneration += 1
  await teardownActive('closed')
}

/**
 * Move/resize the active view. The renderer fires this on resize / scroll /
 * sidebar-collapse so the embed visually tracks its slot div.
 */
export function setSandboxUiBounds(bounds: SandboxUiBounds): void {
  if (!active) return
  active.view.setBounds(toViewBounds(bounds, active.parentWindow))
}

/**
 * Hide the native WebContentsView while renderer-owned overlays are open.
 * WebContentsView always paints above the renderer DOM regardless of CSS
 * z-index, so visibility is the reliable way to let menus and toasts win.
 */
export function setSandboxUiVisible(visible: boolean): void {
  if (!active) return
  active.view.setVisible(visible)
}

type FindableSandboxWebContents = Pick<
  WebContentsView['webContents'],
  'findInPage' | 'on' | 'removeListener'
>

export function beginSandboxUiFind(
  webContents: FindableSandboxWebContents,
  query: string,
  options: { forward: boolean; findNext: boolean },
  onResult: (result: SandboxUiFindResult) => void,
  isCurrent: () => boolean = () => true
): { requestId: number; cleanup: () => void } {
  let requestId = -1
  const listener = (_event: Electron.Event, result: Electron.FoundInPageResult) => {
    if (!isCurrent() || result.requestId !== requestId) return
    onResult({
      requestId: result.requestId,
      activeMatchOrdinal: result.activeMatchOrdinal,
      matches: result.matches,
      finalUpdate: result.finalUpdate,
    })
  }
  webContents.on('found-in-page', listener)
  requestId = webContents.findInPage(query, options)
  return {
    requestId,
    cleanup: () => webContents.removeListener('found-in-page', listener),
  }
}

export function findInActiveSandboxUi(
  query: string,
  options: { forward: boolean; findNext: boolean },
  onResult: (result: SandboxUiFindResult) => void
): number | null {
  if (!active || active.view.webContents.isDestroyed()) return null
  const current = active
  const webContents = current.view.webContents
  current.cleanupFindResults?.()
  const session = beginSandboxUiFind(
    webContents,
    query,
    options,
    onResult,
    () => active === current
  )
  current.cleanupFindResults = session.cleanup
  current.activeFindRequestId = session.requestId
  return session.requestId
}

export function stopActiveSandboxUiFind(): void {
  if (!active) return
  active.cleanupFindResults?.()
  active.cleanupFindResults = undefined
  active.activeFindRequestId = undefined
  if (!active.view.webContents.isDestroyed()) {
    active.view.webContents.stopFindInPage('clearSelection')
  }
}

export async function captureSandboxUiPreview(): Promise<string | null> {
  if (!active) return null
  if (active.view.webContents.isDestroyed()) return null
  const image = await active.view.webContents.capturePage()
  if (image.isEmpty()) return null
  return image.toDataURL()
}

/**
 * Hard-reload an embed's webContents in place. Pure + injectable so the
 * decision (skip a torn-down view, otherwise cache-busting reload) is unit
 * tested without Electron. Returns whether a reload was actually issued.
 *
 * `reloadIgnoringCache` is the browser "hard refresh": it re-issues the
 * navigation with no-cache request headers so freshly-arrived server data
 * (e.g. a new inbox item) is fetched instead of repainting a stale
 * HTTP-cached response — the same stale-pod concern the mount path guards
 * with `clearCache()`.
 */
export function reloadSandboxUiWebContents(
  webContents: { isDestroyed(): boolean; reloadIgnoringCache(): void } | null | undefined
): boolean {
  if (!webContents || webContents.isDestroyed()) return false
  webContents.reloadIgnoringCache()
  return true
}

/**
 * Reload the active embed in place (user-initiated "Refresh"). No-op when
 * nothing is mounted or the view was already torn down. This is the only
 * in-place refresh path — without it, the embed's content stays as of its
 * initial `loadURL` until the user navigates away and back (which remounts).
 */
export function reloadActiveSandboxUiView(): void {
  reloadSandboxUiWebContents(active?.view.webContents)
}

export type SandboxUiOauthCompletedPayload = {
  oauthClientId: string
  provider: string
}

/**
 * Spec §9.9 — push the OAuth completion envelope into the active embed.
 * Called by `main.ts`'s `open-url` handler after the provider redirect
 * lands in the OS browser, control-api stores the grant, and the success
 * page bounces to `clerum://oauth-completed`. The embed preload exposes
 * this as `clerum.onOauthCompleted(callback)` to recipe JS.
 *
 * No-op when no embed is mounted (deep-link arrives after the user closed
 * the embed). The recipe can re-trigger Connect if it cares.
 */
export function dispatchSandboxUiOauthCompleted(payload: SandboxUiOauthCompletedPayload): void {
  if (!active) return
  if (active.view.webContents.isDestroyed()) return
  active.view.webContents.send('clerum:sandbox-ui:oauth-completed', payload)
}
