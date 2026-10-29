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
 *   2. **Per-view rate-limit:** ≤1 accepted request / 30 s.
 *
 * Expiry model: every successful mint records a wall-clock `expiresAt`.
 * Whether a refresh is due is decided against that wall clock, never against
 * how long a timer has been waiting — timers may not advance while the
 * machine sleeps, so a timer alone would wake up long after the cookie died.
 *
 * Visibility model:
 *   - mounted + visible → timer armed for `expiresAt - lead`.
 *   - parent hidden / minimized → cancel timer, cookie expires naturally.
 *   - parent shown / restored / focused, or the host resumes / unlocks →
 *     refresh now if the attempt is already due, otherwise re-arm the timer
 *     for the remaining time.
 *   - mint fails → retry with backoff until the cookie has been dead for a
 *     grace period, then surface the error. The loop stays alive (and the
 *     sender pinned): an embed request, a top-level 401 or the window / host
 *     returning resumes it.
 *   - unmount → stop for good.
 */

export const SANDBOX_UI_REFRESH_IPC_CHANNEL = 'clerum:sandbox-ui:request-refresh'

// rpc-proxy issues cookies with Max-Age=300. Refreshing 30 s before that
// gives the request itself headroom — re-mint at exp - 30 s.
export const SANDBOX_UI_COOKIE_TTL_MS = 5 * 60 * 1000
export const SANDBOX_UI_REFRESH_LEAD_MS = 30 * 1000
export const SANDBOX_UI_REFRESH_INTERVAL_MS = SANDBOX_UI_COOKIE_TTL_MS - SANDBOX_UI_REFRESH_LEAD_MS

export const SANDBOX_UI_RATE_LIMIT_MS = 30 * 1000

/** Delay before each consecutive retry of a failed mint; the last repeats. */
export const SANDBOX_UI_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 5_000, 15_000, 30_000]
/** How long past the cookie's expiry (or the first failure, if later) retries continue. */
export const SANDBOX_UI_RETRY_GRACE_MS = 60 * 1000

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
  /** Hard-reloads the embed after a mint that recovers a top-level 401. */
  reload: () => void
  onError: (err: Error) => void
  /** A mint succeeded after `onError` reported that retries had run out. */
  onRecovered: () => void
  /**
   * Wall-clock time the initial mint was requested. The cookie's lifetime is
   * counted from the server's issue time, so the request start is the
   * conservative anchor. Defaults to `now()` at start.
   */
  mintedAt?: number
  /** Wall clock; injectable so tests can move it independently of timers. */
  now?: () => number
}

type RefreshTrigger = 'timer' | 'retry' | 'return' | 'ipc' | 'unauthorized'

type ParentVisibilityHandlers = {
  hide: () => void
  minimize: () => void
  show: () => void
  restore: () => void
  focus: () => void
} | null

type ActiveRefresh = Omit<StartSandboxUiRefreshArgs, 'now' | 'mintedAt'> & {
  now: () => number
  timer: ReturnType<typeof setTimeout> | null
  parentHandlers: ParentVisibilityHandlers
  stopped: boolean
  inflight: Promise<void> | null
  expiresAt: number
  /** Wall-clock time of the next scheduled attempt; null once retries are exhausted. */
  nextAttemptAt: number | null
  consecutiveFailures: number
  retryDeadline: number | null
  /** Incremented by every successful mint (the initial one is 0). */
  mintSeq: number
  reloadOnNextMint: boolean
  /** The mint that recovered a top-level 401; a 401 under it is not retried again. */
  unauthorizedRecoveryMintSeq: number | null
  /** Last time a return event or a 401 reopened retries after they ran out. */
  lastResumeAt: number | null
  /** `onError` fired and no mint has succeeded since. */
  errorReported: boolean
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

function armTimer(ref: ActiveRefresh): void {
  clearTimer(ref)
  if (ref.stopped || ref.nextAttemptAt === null) return
  if (!isParentVisible(ref)) return
  const trigger: RefreshTrigger = ref.consecutiveFailures > 0 ? 'retry' : 'timer'
  ref.timer = setTimeout(
    () => {
      ref.timer = null
      void runRefresh(ref, trigger)
    },
    Math.max(0, ref.nextAttemptAt - ref.now())
  )
}

function onHostReturn(ref: ActiveRefresh): void {
  if (ref.stopped || ref.inflight) return
  if (!isParentVisible(ref)) return
  if (ref.nextAttemptAt === null) {
    if (tryResumeExhausted(ref)) void runRefresh(ref, 'return')
    return
  }
  if (ref.now() >= ref.nextAttemptAt) {
    void runRefresh(ref, 'return')
    return
  }
  armTimer(ref)
}

function startRetryEpisode(ref: ActiveRefresh): void {
  ref.consecutiveFailures = 0
  ref.retryDeadline = null
}

/**
 * Reopens retries for a loop that gave up. Focus events and 401 navigations
 * can arrive in bursts, so together they get one resume per rate-limit window.
 */
function tryResumeExhausted(ref: ActiveRefresh): boolean {
  const now = ref.now()
  if (ref.lastResumeAt !== null && now - ref.lastResumeAt < SANDBOX_UI_RATE_LIMIT_MS) return false
  ref.lastResumeAt = now
  startRetryEpisode(ref)
  return true
}

/**
 * Every scheduled retry lands before its episode's deadline, so an attempt
 * starting well past it means the host was asleep or hidden in between: the
 * old outage window says nothing about now, and this attempt gets a fresh one.
 * The slack absorbs a timer that merely fires late.
 */
function isRetryEpisodeStale(ref: ActiveRefresh): boolean {
  if (ref.retryDeadline === null) return false
  const slack = SANDBOX_UI_RETRY_DELAYS_MS[SANDBOX_UI_RETRY_DELAYS_MS.length - 1]!
  return ref.now() > ref.retryDeadline + slack
}

function runRefresh(ref: ActiveRefresh, trigger: RefreshTrigger): Promise<void> {
  if (ref.stopped) return Promise.resolve()
  if (ref.inflight) return ref.inflight
  if (isRetryEpisodeStale(ref)) startRetryEpisode(ref)
  // Suspend the timer until we know the outcome.
  clearTimer(ref)
  const attempt = attemptMint(ref, trigger).finally(() => {
    if (ref.inflight === attempt) ref.inflight = null
  })
  ref.inflight = attempt
  return attempt
}

async function attemptMint(ref: ActiveRefresh, trigger: RefreshTrigger): Promise<void> {
  const requestedAt = ref.now()
  try {
    const { setCookie } = await ref.refresh(ref.recipeNs, ref.recipeName)
    if (ref.stopped) return
    await ref.installCookie(setCookie)
  } catch (err) {
    if (ref.stopped) return
    console.error(`[SandboxUI] refresh failed (trigger=${trigger}):`, err)
    scheduleRetry(ref, err instanceof Error ? err : new Error(String(err)))
    return
  }
  if (ref.stopped) return
  ref.expiresAt = requestedAt + SANDBOX_UI_COOKIE_TTL_MS
  ref.nextAttemptAt = ref.expiresAt - SANDBOX_UI_REFRESH_LEAD_MS
  ref.mintSeq += 1
  startRetryEpisode(ref)
  lastRefreshAtBySender.set(ref.webContentsId, ref.now())
  if (ref.reloadOnNextMint) {
    ref.reloadOnNextMint = false
    ref.unauthorizedRecoveryMintSeq = ref.mintSeq
    ref.reload()
  }
  armTimer(ref)
  // Cleared only here, after reload() and armTimer(): if either throws, the
  // next successful mint still owes the renderer its recovery signal. A
  // throwing listener must not leave the loop without a timer either.
  if (ref.errorReported) {
    ref.errorReported = false
    try {
      ref.onRecovered()
    } catch (err) {
      console.error('[SandboxUI] refresh recovery listener failed:', err)
    }
  }
}

function scheduleRetry(ref: ActiveRefresh, err: Error): void {
  const now = ref.now()
  // A cookie that died while the machine slept would leave no retry window
  // at all if the deadline were anchored on `expiresAt` alone.
  ref.retryDeadline ??= Math.max(ref.expiresAt, now) + SANDBOX_UI_RETRY_GRACE_MS
  const delays = SANDBOX_UI_RETRY_DELAYS_MS
  const delay = delays[Math.min(ref.consecutiveFailures, delays.length - 1)]!
  ref.consecutiveFailures += 1
  if (now + delay > ref.retryDeadline) {
    ref.nextAttemptAt = null
    ref.errorReported = true
    ref.onError(err)
    return
  }
  ref.nextAttemptAt = now + delay
  armTimer(ref)
}

export function startSandboxUiRefresh(args: StartSandboxUiRefreshArgs): void {
  cancelSandboxUiRefresh()

  const { now = Date.now, mintedAt, ...rest } = args
  const expiresAt = (mintedAt ?? now()) + SANDBOX_UI_COOKIE_TTL_MS
  const ref: ActiveRefresh = {
    ...rest,
    now,
    timer: null,
    parentHandlers: null,
    stopped: false,
    inflight: null,
    expiresAt,
    nextAttemptAt: expiresAt - SANDBOX_UI_REFRESH_LEAD_MS,
    consecutiveFailures: 0,
    retryDeadline: null,
    mintSeq: 0,
    reloadOnNextMint: false,
    unauthorizedRecoveryMintSeq: null,
    lastResumeAt: null,
    errorReported: false,
  }

  senderToRefreshContext.set(args.webContentsId, ref)
  // The just-completed mint counts as t=0 for rate-limit accounting so an
  // immediate IPC retry from a flaky embed gets dropped.
  lastRefreshAtBySender.set(args.webContentsId, now())
  activeRefresh = ref

  if (!args.parentWindow.isDestroyed()) {
    // Inlined per-event registration so TypeScript resolves each
    // BrowserWindow.on overload statically — a generic `on(eventStr, ...)`
    // call falls through to the `'will-resize'` overload.
    const handlers = {
      hide: (): void => clearTimer(ref),
      minimize: (): void => clearTimer(ref),
      show: (): void => onHostReturn(ref),
      restore: (): void => onHostReturn(ref),
      focus: (): void => onHostReturn(ref),
    }
    args.parentWindow.on('hide', handlers.hide)
    args.parentWindow.on('minimize', handlers.minimize)
    args.parentWindow.on('show', handlers.show)
    args.parentWindow.on('restore', handlers.restore)
    args.parentWindow.on('focus', handlers.focus)
    ref.parentHandlers = handlers
  }

  armTimer(ref)
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
    ref.parentWindow.removeListener('focus', ref.parentHandlers.focus)
  }
  ref.parentHandlers = null
}

/**
 * The host came back from sleep or a screen lock (`powerMonitor`). Same rule
 * as the parent window returning: refresh now if due, else re-arm.
 */
export function notifySandboxUiHostResumed(): void {
  if (activeRefresh) onHostReturn(activeRefresh)
}

/**
 * Embed-side IPC entry point. Resolves senderId via the pinning map and
 * per-view rate-limit (≤1 accepted request / 30 s). Throws when the sender
 * is unpinned or rate-limited so the embed sees an error and doesn't retry
 * in a tight loop. Resumes a loop whose retries were exhausted.
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
  if (ref.now() - last < SANDBOX_UI_RATE_LIMIT_MS) {
    console.warn('[SandboxUI] refresh rate-limited for sender', senderId)
    throw new Error('sandbox-ui refresh: rate-limited')
  }
  // Counted on acceptance, not only on success: a failing mint no longer
  // stops the loop, so the embed must not be able to drive it faster.
  lastRefreshAtBySender.set(senderId, ref.now())
  if (ref.nextAttemptAt === null) startRetryEpisode(ref)
  await runRefresh(ref, 'ipc')
}

/**
 * The embed's top-level document came back 401 (an expired cookie leaves a
 * dead error page with no script to ask for a refresh). Re-mints and reloads,
 * at most once per mint.
 *
 * A 401 under the cookie minted for the previous recovery is ignored only
 * while that cookie should still be valid and no newer mint is in flight:
 * only then does it mean the server rejected a fresh cookie, and reloading
 * again would loop. Once that cookie expired (a failing timer mint, a long
 * minimize) the 401 is the expected outcome and must still be recovered, or
 * the embed stays on a dead page; a newer mint in flight brings a different
 * cookie, so reloading under it is a new attempt rather than a loop.
 */
export function handleSandboxUiUnauthorizedNavigation(webContentsId: number): void {
  const ref = senderToRefreshContext.get(webContentsId)
  if (!ref || ref.stopped) return
  const recoveryCookieRejected =
    ref.unauthorizedRecoveryMintSeq === ref.mintSeq && !ref.inflight && ref.now() < ref.expiresAt
  if (recoveryCookieRejected) return
  const exhausted = ref.nextAttemptAt === null
  // A pending recovery is already being retried — unless its retries ran out,
  // in which case this 401 is the only signal left that can reopen them.
  if (ref.reloadOnNextMint && !exhausted) return
  ref.reloadOnNextMint = true
  if (ref.inflight) return
  if (exhausted && !tryResumeExhausted(ref)) return
  void runRefresh(ref, 'unauthorized')
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
