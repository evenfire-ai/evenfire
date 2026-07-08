import type { BrowserWindow } from 'electron'

/**
 * Sandbox UI session refresh + IPC pinning.
 *
 * The Desktop App is the trusted refresh driver: ~270 s after the last
 * mint, while the embed is mounted and the parent window is visible, the
 * main process re-mints the per-recipe session cookie via the same
 * `POST /sandbox-ui/<ns>/<name>/session` endpoint that the initial open
 * called. The webview itself never sees the RPC JWT and never calls
 * `/session` directly.
 *
 * An embed MAY emit a one-shot recovery refresh via
 * `clerum.requestSessionRefresh()` when an SSE / fetch hits 401 because
 * the cookie just expired. That IPC is gated by:
 *
 *   1. **Pinning:** the embed's `webContents.id` is in the pinning map at
 *      mount time and removed at teardown. An IPC from a sender not in the
 *      map is dropped — the trust check is identity, not URL, because the
 *      embed loads from rpc-proxy and would fail `assertTrustedSender`.
 *   2. **Per-view rate-limit:** ≤1 refresh / 30 s.
 *
 * Visibility model:
 *   - mounted + visible → 270 s timer scheduled.
 *   - parent hidden / minimized → cancel timer, cookie expires naturally.
 *   - parent shown / restored → re-arm timer.
 *   - unmount / refresh fail → stop timer, surface error to the chrome.
 */

export const SANDBOX_UI_REFRESH_IPC_CHANNEL = 'clerum:sandbox-ui:request-refresh'

// rpc-proxy issues cookies with Max-Age=300. Refreshing 30 s before that
// gives the request itself headroom — re-mint at exp - 30 s.
export const SANDBOX_UI_COOKIE_TTL_MS = 5 * 60 * 1000
export const SANDBOX_UI_REFRESH_LEAD_MS = 30 * 1000
export const SANDBOX_UI_REFRESH_INTERVAL_MS = SANDBOX_UI_COOKIE_TTL_MS - SANDBOX_UI_REFRESH_LEAD_MS

export const SANDBOX_UI_RATE_LIMIT_MS = 30 * 1000

export type SandboxUiRefreshFn = (
  recipeNs: string,
  recipeName: string
) => Promise<{ setCookie: string | string[] }>

export type SandboxUiInstallCookieFn = (setCookie: string | string[]) => Promise<void>

export type StartSandboxUiRefreshArgs = {
  recipeNs: string
  recipeName: string
  webContentsId: number
  parentWindow: BrowserWindow
  refresh: SandboxUiRefreshFn
  installCookie: SandboxUiInstallCookieFn
  onError: (err: Error) => void
}

type ParentVisibilityHandlers = {
  hide: () => void
  minimize: () => void
  show: () => void
  restore: () => void
} | null

type ActiveRefresh = StartSandboxUiRefreshArgs & {
  timer: ReturnType<typeof setTimeout> | null
  parentHandlers: ParentVisibilityHandlers
  stopped: boolean
}

let activeRefresh: ActiveRefresh | null = null
const senderToRefreshContext = new Map<number, ActiveRefresh>()
const lastRefreshAtBySender = new Map<number, number>()

function clearTimer(ref: ActiveRefresh): void {
  if (ref.timer !== null) {
    clearTimeout(ref.timer)
    ref.timer = null
  }
}

function isParentVisible(ref: ActiveRefresh): boolean {
  if (ref.parentWindow.isDestroyed()) return false
  // isVisible() returns false when minimized on some platforms but not
  // others, so check both flags explicitly.
  return ref.parentWindow.isVisible() && !ref.parentWindow.isMinimized()
}

function scheduleNext(ref: ActiveRefresh): void {
  clearTimer(ref)
  if (ref.stopped) return
  if (!isParentVisible(ref)) return
  ref.timer = setTimeout(() => {
    void runRefresh(ref, 'timer')
  }, SANDBOX_UI_REFRESH_INTERVAL_MS)
}

async function runRefresh(ref: ActiveRefresh, trigger: 'timer' | 'ipc'): Promise<void> {
  if (ref.stopped) return
  // Suspend the timer until we know the outcome.
  clearTimer(ref)
  try {
    const { setCookie } = await ref.refresh(ref.recipeNs, ref.recipeName)
    if (ref.stopped) return
    await ref.installCookie(setCookie)
    lastRefreshAtBySender.set(ref.webContentsId, Date.now())
    // Reschedule — IPC-driven refresh resets the 270 s window so a
    // successful recovery push delays the next scheduled tick.
    scheduleNext(ref)
  } catch (err) {
    console.error(`[SandboxUI] refresh failed (trigger=${trigger}):`, err)
    ref.stopped = true
    senderToRefreshContext.delete(ref.webContentsId)
    ref.onError(err instanceof Error ? err : new Error(String(err)))
  }
}

export function startSandboxUiRefresh(args: StartSandboxUiRefreshArgs): void {
  cancelSandboxUiRefresh()

  const ref: ActiveRefresh = {
    ...args,
    timer: null,
    parentHandlers: null,
    stopped: false,
  }

  senderToRefreshContext.set(args.webContentsId, ref)
  // The just-completed mint counts as t=0 for rate-limit accounting so an
  // immediate IPC retry from a flaky embed gets dropped.
  lastRefreshAtBySender.set(args.webContentsId, Date.now())
  activeRefresh = ref

  if (!args.parentWindow.isDestroyed()) {
    // Inlined per-event registration so TypeScript resolves each
    // BrowserWindow.on overload statically — a generic `on(eventStr, ...)`
    // call falls through to the `'will-resize'` overload.
    const handlers = {
      hide: (): void => clearTimer(ref),
      minimize: (): void => clearTimer(ref),
      show: (): void => scheduleNext(ref),
      restore: (): void => scheduleNext(ref),
    }
    args.parentWindow.on('hide', handlers.hide)
    args.parentWindow.on('minimize', handlers.minimize)
    args.parentWindow.on('show', handlers.show)
    args.parentWindow.on('restore', handlers.restore)
    ref.parentHandlers = handlers
  }

  scheduleNext(ref)
}

export function cancelSandboxUiRefresh(): void {
  if (!activeRefresh) return
  const ref = activeRefresh
  activeRefresh = null
  ref.stopped = true
  clearTimer(ref)
  senderToRefreshContext.delete(ref.webContentsId)
  lastRefreshAtBySender.delete(ref.webContentsId)
  if (!ref.parentWindow.isDestroyed() && ref.parentHandlers) {
    ref.parentWindow.removeListener('hide', ref.parentHandlers.hide)
    ref.parentWindow.removeListener('minimize', ref.parentHandlers.minimize)
    ref.parentWindow.removeListener('show', ref.parentHandlers.show)
    ref.parentWindow.removeListener('restore', ref.parentHandlers.restore)
  }
  ref.parentHandlers = null
}

/**
 * Embed-side IPC entry point. Resolves senderId via the pinning map and
 * per-view rate-limit (≤1 refresh / 30 s). Throws when the sender is
 * unpinned or rate-limited so the embed sees an error and doesn't retry
 * in a tight loop.
 */
export async function handleEmbedRefreshRequest(senderId: number): Promise<void> {
  const ref = senderToRefreshContext.get(senderId)
  if (!ref) {
    console.warn('[SandboxUI] refresh request from unpinned sender', senderId)
    throw new Error('sandbox-ui refresh: unpinned sender')
  }
  if (ref.stopped) {
    throw new Error('sandbox-ui refresh: stopped')
  }
  const last = lastRefreshAtBySender.get(senderId) ?? 0
  if (Date.now() - last < SANDBOX_UI_RATE_LIMIT_MS) {
    console.warn('[SandboxUI] refresh rate-limited for sender', senderId)
    throw new Error('sandbox-ui refresh: rate-limited')
  }
  await runRefresh(ref, 'ipc')
}

/** ONLY for tests — resets module-level singleton state between cases. */
export function _resetSandboxUiRefreshForTests(): void {
  if (activeRefresh) {
    const ref = activeRefresh
    activeRefresh = null
    ref.stopped = true
    clearTimer(ref)
  }
  senderToRefreshContext.clear()
  lastRefreshAtBySender.clear()
}

/** ONLY for tests — observe the pinning map for a sender. */
export function _isPinnedForTests(senderId: number): boolean {
  return senderToRefreshContext.has(senderId)
}
