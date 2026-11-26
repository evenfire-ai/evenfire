/**
 * Desktop's browser sign-in in the main process, without its network calls: the one attempt, its
 * snapshot and its deadline (state model V13 to V16; D1, D12, D13), the PKCE secrets, the
 * end-state mapping (state model §5.2, D17), and main's `desktop-login` link handler (D8).
 *
 * It imports neither Electron nor `httpClient.ts` nor `config.ts`. `AppService` owns the requests
 * and the auth owner queue, and passes the clock in, so tests drive the deadline themselves.
 */
import { createHash, randomBytes } from 'node:crypto'
import {
  DESKTOP_LOGIN_REFUSAL_REASONS,
  type DesktopLoginLink,
  type DesktopLoginRefusalReason,
  type RedeemHttpAnswer,
} from './browserSignInModel.js'
import type { BrowserSignInEnd, BrowserSignInSnapshot, LoginResult, SessionMe } from './types.js'

/** How long an attempt waits for its link (design §10.1). */
export const BROWSER_SIGN_IN_DEADLINE_MS = 15 * 60 * 1000

/** What `setTimeout` returns in the main process. The store only hands it back to `clearTimer`. */
export type BrowserSignInTimerHandle = ReturnType<typeof setTimeout>

/**
 * The wall clock and the deadline timer. `AppService` passes `{ now: Date.now, setTimer:
 * setTimeout, clearTimer: clearTimeout }` as they are.
 */
export type BrowserSignInClock = Readonly<{
  now: () => number
  setTimer: (callback: () => void, ms: number) => BrowserSignInTimerHandle
  clearTimer: (handle: BrowserSignInTimerHandle) => void
}>

/** The environment an attempt was started for, as `captureAuthEnvironmentBinding` returns it. */
export type BrowserSignInBinding = Readonly<{
  environmentKey: string
  profileId: string | null
  restBaseUrl: string
}>

/** V13. Its `state` and `verifier` never leave the main process (D18). */
export type BrowserSignInAttempt = Readonly<{
  id: number
  state: string
  verifier: string
  binding: BrowserSignInBinding
  generation: number
  deadlineAtMs: number
  phase: 'waiting' | 'redeeming' | 'ended'
}>

/** 32 random bytes are 43 base64url characters. */
const SECRET_BYTES = 32

/** The RFC 7636 S256 challenge: the base64url SHA-256 of the verifier. */
export function s256Challenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

/** A fresh verifier and state, each of 43 base64url characters, and the verifier's challenge. */
export function createBrowserSignInSecrets(): Readonly<{
  verifier: string
  state: string
  challenge: string
}> {
  const verifier = randomBytes(SECRET_BYTES).toString('base64url')
  const state = randomBytes(SECRET_BYTES).toString('base64url')
  return Object.freeze({ verifier, state, challenge: s256Challenge(verifier) })
}

const NO_ATTEMPT: BrowserSignInSnapshot = Object.freeze({ attemptId: null, phase: 'idle' })

/**
 * V14's ended value, built field by field, so only the closed values cross IPC (D17, D18) even
 * when a caller's end object carries more.
 */
function endedSnapshot(attemptId: number, end: BrowserSignInEnd): BrowserSignInSnapshot {
  switch (end.outcome) {
    case 'refused':
      return { attemptId, phase: 'ended', outcome: 'refused', reason: end.reason }
    case 'failed':
      return end.reason === undefined
        ? { attemptId, phase: 'ended', outcome: 'failed' }
        : { attemptId, phase: 'ended', outcome: 'failed', reason: end.reason }
    default:
      return { attemptId, phase: 'ended', outcome: end.outcome }
  }
}

/**
 * The one browser sign-in attempt (V13), its snapshot (V14), its id counter (V15) and its deadline
 * timer (V16). Each attempt moves forward only: waiting, then redeeming, then ended, or waiting,
 * then ended (D1). Every snapshot change is pushed once, after the caller returns (D6, D13).
 * It does not check the generation or the binding; `AppService` does, inside its owner queue (D7).
 */
export class BrowserSignInAttempts {
  private readonly push: (snapshot: BrowserSignInSnapshot) => void
  private readonly warn: (message: string, errorClass: string) => void
  private readonly clock: BrowserSignInClock
  private lastId = 0
  private attempt: BrowserSignInAttempt | null = null
  private timer: BrowserSignInTimerHandle | null = null
  private stored: BrowserSignInSnapshot = NO_ATTEMPT

  constructor(
    deps: Readonly<{
      push: (snapshot: BrowserSignInSnapshot) => void
      /**
       * Gets fixed text and the error's class, never the error, whose message may carry a URL
       * (D18).
       */
      warn: (message: string, errorClass: string) => void
      clock: BrowserSignInClock
    }>
  ) {
    this.push = deps.push
    this.warn = deps.warn
    this.clock = deps.clock
  }

  /** The latest attempt in any phase, or null before the first. */
  current(): BrowserSignInAttempt | null {
    return this.attempt
  }

  /**
   * Records a waiting attempt with the next id and arms its deadline timer. It replaces the
   * current record and ends nothing (decision 4): start's generation bump has already ended a
   * waiting predecessor `replaced` (D3, D6).
   *
   * Precondition: never while an attempt is redeeming. Called then, it would drop that attempt
   * without an end state. The store does not check it: L1 rests on D3's bump and on the
   * service's refusal of a start while redeeming (D10).
   *
   * The timer is armed before anything is written, so a throwing `setTimer` leaves the store as
   * it was: no waiting attempt without its timer, and no id issued.
   */
  record(
    input: Readonly<{
      state: string
      verifier: string
      binding: BrowserSignInBinding
      generation: number
    }>
  ): number {
    const id = this.lastId + 1
    const deadlineAtMs = this.clock.now() + BROWSER_SIGN_IN_DEADLINE_MS
    const timer = this.clock.setTimer(() => this.onTimer(id), BROWSER_SIGN_IN_DEADLINE_MS)
    this.disarmTimer()
    this.lastId = id
    const { environmentKey, profileId, restBaseUrl } = input.binding
    this.attempt = Object.freeze({
      id,
      state: input.state,
      verifier: input.verifier,
      binding: Object.freeze({ environmentKey, profileId, restBaseUrl }),
      generation: input.generation,
      deadlineAtMs,
      phase: 'waiting',
    })
    this.timer = timer
    this.publish({ attemptId: id, phase: 'waiting' })
    return id
  }

  /** The waiting attempt whose state is `state`, once the deadline is applied; otherwise null. */
  matchWaiting(state: string): BrowserSignInAttempt | null {
    this.checkDeadline()
    const attempt = this.attempt
    return attempt !== null && attempt.phase === 'waiting' && attempt.state === state
      ? attempt
      : null
  }

  /** Waiting to redeeming, for attempt `id` only. The deadline stops here (D12). */
  beginRedeem(id: number): boolean {
    const attempt = this.attempt
    if (attempt === null || attempt.id !== id || attempt.phase !== 'waiting') return false
    this.disarmTimer()
    this.attempt = Object.freeze({ ...attempt, phase: 'redeeming' })
    this.publish({ attemptId: id, phase: 'redeeming' })
    return true
  }

  /** Ends attempt `id`, waiting or redeeming. Once it has ended, this does nothing (D1). */
  end(id: number, end: BrowserSignInEnd): boolean {
    const attempt = this.attempt
    if (attempt === null || attempt.id !== id || attempt.phase === 'ended') return false
    this.finish(attempt, end)
    return true
  }

  /** Ends attempt `id` only while it waits, as a failed browser open does (A3-66). */
  endIfWaiting(id: number, end: BrowserSignInEnd): boolean {
    const attempt = this.attempt
    if (attempt === null || attempt.id !== id || attempt.phase !== 'waiting') return false
    this.finish(attempt, end)
    return true
  }

  /** A waiting attempt ends `cancelled`; a redeeming one is left to finish (D10). Returns V14. */
  cancel(): BrowserSignInSnapshot {
    const attempt = this.attempt
    if (attempt !== null && attempt.phase === 'waiting') {
      this.finish(attempt, { outcome: 'cancelled' })
    }
    return this.stored
  }

  /**
   * The generation hook (D6): a waiting attempt ends `replaced`. It reads no clock, pushes nothing
   * before it returns and never throws. A redeeming attempt is left to the install check (D9).
   */
  onGenerationAdvanced(): void {
    const attempt = this.attempt
    if (attempt !== null && attempt.phase === 'waiting') {
      this.finish(attempt, { outcome: 'replaced' })
    }
  }

  /** A waiting attempt at or past its wall-clock deadline ends `timed_out` (D12). */
  checkDeadline(): void {
    const attempt = this.attempt
    if (
      attempt !== null &&
      attempt.phase === 'waiting' &&
      this.clock.now() >= attempt.deadlineAtMs
    ) {
      this.finish(attempt, { outcome: 'timed_out' })
    }
  }

  /** V14, once the deadline is applied (A3-67). */
  snapshot(): BrowserSignInSnapshot {
    this.checkDeadline()
    return this.stored
  }

  /**
   * `ended` for `attemptId` becomes `idle` for it (D13). An acknowledgement for another id, or
   * while nothing has ended, is ignored (A3-54). Returns V14.
   */
  acknowledge(attemptId: number): BrowserSignInSnapshot {
    const stored = this.stored
    if (stored.phase === 'ended' && stored.attemptId === attemptId) {
      this.publish({ attemptId, phase: 'idle' })
    }
    return this.stored
  }

  /**
   * The D12 ruling: the timer ends its own attempt when it fires, if that attempt still waits,
   * whatever the wall clock says. A timer that fires after its attempt left `waiting` or was
   * replaced does nothing.
   */
  private onTimer(id: number): void {
    const attempt = this.attempt
    if (attempt === null || attempt.id !== id || attempt.phase !== 'waiting') return
    this.timer = null
    this.finish(attempt, { outcome: 'timed_out' })
  }

  private finish(attempt: BrowserSignInAttempt, end: BrowserSignInEnd): void {
    this.disarmTimer()
    this.attempt = Object.freeze({ ...attempt, phase: 'ended' })
    this.publish(endedSnapshot(attempt.id, end))
  }

  private disarmTimer(): void {
    const timer = this.timer
    if (timer === null) return
    this.timer = null
    try {
      this.clock.clearTimer(timer)
    } catch (error) {
      // The generation hook must not throw (D6). A timer that still fires finds its attempt no
      // longer waiting, or another attempt, and does nothing (onTimer).
      this.warn(
        '[AppService] Browser sign-in timer clear failed',
        error instanceof Error ? error.name : typeof error
      )
    }
  }

  /** Every V14 write: store the snapshot, then push that same snapshot after the caller returns. */
  private publish(snapshot: BrowserSignInSnapshot): void {
    const captured = Object.freeze(snapshot)
    this.stored = captured
    queueMicrotask(() => {
      try {
        this.push(captured)
      } catch (error) {
        // A throw here would be an uncaught exception in the main process (D6). The snapshot
        // stays in V14, so the renderer's next read still finds it (D13).
        this.warn(
          '[AppService] Browser sign-in state push failed',
          error instanceof Error ? error.name : typeof error
        )
      }
    })
  }
}

/**
 * Main's `desktop-login` link handler, which the deep-link router calls (D8). `accept` is the
 * service's acceptance: it reads the link and says whether it matched the waiting attempt. Only a
 * matched link raises the window (A3-33); on macOS that request also cancels a deferred quit
 * (A3-70). An unmatched link requests nothing. The link is never logged (D18).
 */
export function createDesktopLoginLinkHandler(
  deps: Readonly<{
    accept: (rawUrl: string) => boolean
    requestMainWindow: () => void
  }>
): (rawUrl: string) => void {
  return rawUrl => {
    if (deps.accept(rawUrl)) deps.requestMainWindow()
  }
}

/** The edge's own bound on a session token (`external-rest-api/src/routes/oidcDesktopSignIn.ts`). */
const SESSION_TOKEN_MAX_LENGTH = 4096
const UNUSABLE_REDEEM_RESULT = 'The browser sign-in answer is not a usable session'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * A redeem 200's `{ token, me }`. It throws when Desktop could not install it: a token that is
 * not a string of 1 to 4096 characters, or a `me` without a non-empty string `id` (Review
 * Focus 4). The rest of `me` is password login's shape, which the edge relays as it is.
 */
export function parseRedeemResult(body: unknown): LoginResult {
  if (!isRecord(body)) throw new Error(UNUSABLE_REDEEM_RESULT)
  const { token, me } = body
  if (typeof token !== 'string' || token.length < 1 || token.length > SESSION_TOKEN_MAX_LENGTH) {
    throw new Error(UNUSABLE_REDEEM_RESULT)
  }
  if (!isRecord(me) || typeof me.id !== 'string' || me.id.length === 0) {
    throw new Error(UNUSABLE_REDEEM_RESULT)
  }
  return { token, me: me as SessionMe }
}

function isDesktopLoginRefusalReason(value: unknown): value is DesktopLoginRefusalReason {
  return (
    typeof value === 'string' &&
    (DESKTOP_LOGIN_REFUSAL_REASONS as readonly string[]).includes(value)
  )
}

/** The `reason` of a redeem 403 body when it is in PR 2's closed set; otherwise null (D17). */
function refusalReasonOf(bodyText: string): DesktopLoginRefusalReason | null {
  let body: unknown
  try {
    body = JSON.parse(bodyText)
  } catch {
    // §5.2, "Redeem 403 with another reason": a body that is not JSON names no reason in the
    // set, so the attempt ends `failed`, which is the row's end state. The body is not logged:
    // it is the server's answer (D18).
    return null
  }
  return isRecord(body) && isDesktopLoginRefusalReason(body.reason) ? body.reason : null
}

/**
 * A redeem answer other than 200, as its §5.2 row (D17): a 403 whose reason is in PR 2's set is
 * `refused` with it, a 409 is `failed(no_longer_available)`, and every other status, and no
 * answer at all, is `failed`. The parameter type leaves out the 200 arm, so `status` alone tells
 * the two arms that remain apart; a caller picks out the 200 arm with `'body' in answer`.
 */
export function mapRedeemAnswer(
  answer: Exclude<RedeemHttpAnswer, { status: 200 }>
): BrowserSignInEnd {
  if (answer.status === 'unreachable') return { outcome: 'failed' }
  switch (answer.status) {
    case 403: {
      const reason = refusalReasonOf(answer.bodyText)
      return reason === null ? { outcome: 'failed' } : { outcome: 'refused', reason }
    }
    case 409:
      return { outcome: 'failed', reason: 'no_longer_available' }
    default:
      // 400, 426, 429, 503 and any other status.
      return { outcome: 'failed' }
  }
}

/**
 * An `error` link as its §5.2 row (D17). PR 2's parser has already read a refusal with an
 * unlisted or missing reason as `failed` (A-7), so a `refused` link's reason is in the set.
 */
export function mapDesktopLoginErrorLink(
  link: Extract<DesktopLoginLink, { kind: 'error' }>
): BrowserSignInEnd {
  switch (link.error) {
    case 'refused':
      return { outcome: 'refused', reason: link.reason }
    case 'cancelled':
      return { outcome: 'cancelled' }
    case 'unavailable':
      return { outcome: 'failed', reason: 'unavailable' }
    case 'failed':
      return { outcome: 'failed' }
    default: {
      // A new error kind in PR 2's link type fails to compile here. At run time the parser
      // returns only the four kinds above; anything else would still end the attempt once.
      const unhandled: never = link
      void unhandled
      return { outcome: 'failed' }
    }
  }
}
