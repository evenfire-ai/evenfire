import { BrowserWindow, WebContentsView, session } from 'electron'
import path from 'node:path'
import { touchSandboxUiPartition } from './sandboxUiPartitionGc.js'
import {
  applySandboxUiNavigationPolicies,
  applySandboxUiPartitionPolicies,
} from './sandboxUiPartitionPolicies.js'

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

export type SandboxUiBounds = {
  x: number
  y: number
  width: number
  height: number
  dpr?: number
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
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { screen } = require('electron') as typeof import('electron')
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
  onClosed?: () => void
  /**
   * Spec §9.9 — recipe-author Connect button affordance. Fired when the
   * embed navigates to `clerum://oauth?clientId=…`. The driver's only
   * job is to forward; the AppService method this points at calls
   * rpc-proxy for the provider authorize URL and `shell.openExternal`s it.
   */
  onOauthAuthorize?: (oauthClientId: string, background: boolean) => void
}

type ActiveView = {
  view: WebContentsView
  recipeNs: string
  recipeName: string
  partition: string
  parentWindow: BrowserWindow
  rpcProxyOrigin: string
}

let active: ActiveView | null = null

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

export function partitionFor(recipeNs: string, recipeName: string): string {
  // Per-recipe partition — Chromium isolates storage (cookies, IndexedDB,
  // localStorage, service workers) by partition. The launch-time GC pass
  // walks all `persist:sandbox-ui-*` partitions and wipes the ones the user
  // no longer has ACL for.
  return `persist:sandbox-ui-${recipeNs}-${recipeName}`
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
    onClosed,
  } = args

  if (parentWindow.isDestroyed()) {
    throw new Error('parent window is destroyed')
  }
  if (!recipeNs.trim() || !recipeName.trim()) {
    throw new Error('recipeNs and recipeName are required')
  }

  // Tear down any existing view before mounting (one-at-a-time embed). The
  // per-recipe partition is left in place so storage survives a re-mount
  // within the ACL window.
  await teardownActive('replaced')

  const partition = partitionFor(recipeNs, recipeName)
  const proxyOriginUrl = new URL(rpcProxyUrl).toString().replace(/\/+$/, '')
  const allowedNavigationPrefix =
    `${proxyOriginUrl}/api/v1/sandbox-ui/` +
    `${encodeURIComponent(recipeNs)}/${encodeURIComponent(recipeName)}/view/`

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
  applySandboxUiNavigationPolicies(
    view.webContents,
    allowedNavigationPrefix,
    (oauthClientId, background) => {
      args.onOauthAuthorize?.(oauthClientId, background)
    }
  )

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

  active = {
    view,
    recipeNs,
    recipeName,
    partition,
    parentWindow,
    rpcProxyOrigin: proxyOriginUrl,
  }

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

  const viewPath = defaultPath && defaultPath.startsWith('/') ? defaultPath : '/'
  const url =
    `${proxyOriginUrl}/api/v1/sandbox-ui/` +
    `${encodeURIComponent(recipeNs)}/${encodeURIComponent(recipeName)}/view${viewPath}`
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

/**
 * Unmount the active view (no-op if nothing is mounted). Called on user
 * "Close" / navigate-away. Leaves the per-recipe partition intact so a
 * re-mount within the ACL window is fast.
 */
export async function unmountSandboxUiView(): Promise<void> {
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
