import { afterEach, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { createHash } from 'node:crypto'
import {
  type BrowserSignInHarness,
  type HarnessHold,
  type HoldPoint,
  cleanupBrowserSignInHarness,
  createBrowserSignInHarness,
  harnessDriverUsers,
} from '../../testSupport/browserSignInHarness.js'
import {
  type EdgeRecordKey,
  edgeResponse,
  readEdgeRecord,
} from '../../testSupport/edgeContractRecords.js'
import { BROWSER_SIGN_IN_DEADLINE_MS, createDesktopLoginLinkHandler } from '../browserSignIn.js'
import {
  buildDesktopLoginCodeLink,
  buildDesktopLoginErrorLink,
  parseDesktopLoginPageUrl,
} from '../browserSignInModel.js'
import {
  type EvenfireDeepLinkRouter,
  createEvenfireDeepLinkRouter,
} from '../evenfireDeepLinkRouter.js'
import type { BrowserSignInEnd, BrowserSignInSnapshot } from '../types.js'

/**
 * The A6 oracle for Desktop's browser sign-in (state model §4, §7): deterministic rows for the
 * generation hook at every first bump reachable while an attempt waits (G2-6), the op-level
 * queue (N-1), and the race of a restore with a start (A3-62), then an `fc.commands` model over
 * the real `AppService` with `fc.scheduler` interleavings, checked against an independent
 * reference model after every command.
 *
 * Bodies outside the feature contract (G-5) come from the harness. Its discovery answer is the
 * shape of the edge's own route, `external-rest-api/src/routes/desktop.ts:11-17`, with
 * `externalRestApiBaseUrl` set to the profile's canonical endpoint.
 */

afterEach(async () => {
  vi.useRealTimers()
  await cleanupBrowserSignInHarness()
})

const UNTIL_TURN_LIMIT = 200
const METHODS_PATH = '/api/v1/auth/methods'
const REDEEM_PATH = '/api/v1/oidc/desktop-sign-in/redeem'
const REDEEM_SIGNED_IN = 'POST /api/v1/oidc/desktop-sign-in/redeem signed-in'
const PASSWORD_LOGIN_ROUTE = 'POST /api/v1/auth/password-login'
const GOOGLE_LOGIN_ROUTE = 'POST /api/v1/auth/google'
const HUB_SETUP_ROUTE = 'POST /api/v1/invitations-flow/desktop-setup/complete'
const HUB_SETUP_PATH = '/api/v1/invitations-flow/desktop-setup/complete'
const SIXTEEN_MINUTES_MS = 16 * 60 * 1000

// Copied from `appService.browserSignIn.test.ts`, whose helpers are private to that file.

/** Drains until `reached`. The owner queue is not awaited: the point may be a hold under it. */
async function until(harness: BrowserSignInHarness, reached: () => boolean, what: string) {
  for (let turn = 0; !reached(); turn += 1) {
    if (turn >= UNTIL_TURN_LIMIT) throw new Error(`${what} was not reached`)
    await harness.drain({ owner: false })
  }
}

/** The values from `from` up to `to`, both included. */
function consecutive(from: number, to: number): number[] {
  return Array.from({ length: Math.max(0, to - from + 1) }, (_, index) => from + index)
}

function fetchesTo(harness: BrowserSignInHarness, method: string, path: string) {
  return harness.fetches.filter(
    record => record.value.method === method && new URL(record.value.url).pathname === path
  )
}

/** Every snapshot pushed for `attemptId`, in order, with its record. */
function pushesOf(harness: BrowserSignInHarness, attemptId: number) {
  return harness.pushes.filter(record => record.value.attemptId === attemptId)
}

function snapshotsOf(harness: BrowserSignInHarness, attemptId: number): BrowserSignInSnapshot[] {
  return pushesOf(harness, attemptId).map(record => record.value)
}

/** The end states pushed for `attemptId`, in order. */
function endStatesOf(harness: BrowserSignInHarness, attemptId: number): string[] {
  return snapshotsOf(harness, attemptId).flatMap(snapshot =>
    snapshot.phase === 'ended' ? [snapshot.outcome] : []
  )
}

/** The code the edge recorded issuing, of the shape PR 2's link builder requires. */
function recordedCode(): string {
  const { code } = readEdgeRecord('POST /api/v1/oidc/profile-flow/complete desktop-code-issued')
    .body as { code: string }
  return code
}

/** A code link from PR 2's builder, as the Profile UI sends it. */
function codeLink(state: string, environment: string, code = recordedCode()): string {
  return buildDesktopLoginCodeLink({ state, code, environment })
}

/** Starts an attempt and reads its state from the page URL it opened. */
async function startAttempt(
  harness: BrowserSignInHarness
): Promise<{ attemptId: number; state: string }> {
  const { attemptId } = await harness.service.startBrowserSignIn()
  const opened = harness.opens.at(-1)
  const state = opened ? parseDesktopLoginPageUrl(opened.value)?.state : undefined
  if (!state) throw new Error(`attempt ${attemptId} opened no page with a state`)
  return { attemptId, state }
}

type Settled<T> = { ok: true; value: T } | { ok: false; code: string }

/** Records how `promise` settles, without awaiting it: a rejection is read as its message. */
function track<T>(promise: Promise<T>): { result: Settled<T> | null; done: Promise<void> } {
  const tracked: { result: Settled<T> | null; done: Promise<void> } = {
    result: null,
    done: Promise.resolve(),
  }
  tracked.done = promise.then(
    value => {
      tracked.result = { ok: true, value }
    },
    (error: unknown) => {
      // Recorded, not dropped: the caller asserts the code it expects.
      tracked.result = { ok: false, code: error instanceof Error ? error.message : String(error) }
    }
  )
  return tracked
}

/** A failing answer from a driver route, as the edge's 401 in `authClient.passwordLogin.test.ts`. */
function unauthorized(): Response {
  return new Response(JSON.stringify({ error: 'invalid_credentials' }), {
    status: 401,
    statusText: 'Unauthorized',
    headers: { 'content-type': 'application/json' },
  })
}

/** The hub's answer for an unknown setup, the 404 `completeDesktopSetup` maps to its own code. */
function setupNotFound(): Response {
  return new Response(JSON.stringify({ error: 'not_found' }), {
    status: 404,
    statusText: 'Not Found',
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * S9 (state model §4.2) at quiescence: no attempt whose last push is `waiting` has a `bumpLog`
 * entry after its waiting push.
 */
function expectS9(harness: BrowserSignInHarness): void {
  const lastByAttempt = new Map<number, (typeof harness.pushes)[number]>()
  for (const record of harness.pushes) {
    if (record.value.attemptId !== null) lastByAttempt.set(record.value.attemptId, record)
  }
  for (const [attemptId, last] of lastByAttempt) {
    if (last.value.phase !== 'waiting') continue
    const waitingSeq = pushesOf(harness, attemptId).find(
      record => record.value.phase === 'waiting'
    )?.seq
    expect(
      harness.bumpLog.filter(bump => bump.seq > (waitingSeq ?? Infinity)),
      `S9: attempt ${attemptId} waits after a bump`
    ).toEqual([])
  }
}

type FirstBumpEvent = Readonly<{
  /** The test name's label: the event and its first bump's call site. */
  label: string
  keptToken?: boolean
  /** Makes the event's later bumps in the same op unreachable where it can (M2). */
  prepare?: (harness: BrowserSignInHarness) => void
  run: (harness: BrowserSignInHarness) => Promise<unknown>
  /** What the event settles to; a rejection is matched on its message. */
  settles: RegExp | 'resolves'
}>

/**
 * G2-6: every first bump reachable while an attempt waits (state model §6), one per event, keyed
 * on its function (line numbers at this head): restore's commit (`restoreSavedSessionOnce`),
 * an environment change (`applyRuntimeEnvironmentChange`), a re-select of the active profile
 * (`selectRuntimeConfigWithGeneration`, same boundary), Google login, desktop setup and password
 * login (op 1 of each, with a failing answer so no later bump in the same op runs), logout, and
 * start's own bump.
 */
const EIGHT_FIRST_BUMPS: ReadonlyArray<FirstBumpEvent> = [
  {
    label: 'restore (restoreSavedSessionOnce commit)',
    keptToken: true,
    run: harness => harness.service.getSessionState(),
    settles: 'resolves',
  },
  {
    label: 'environment change to B (applyRuntimeEnvironmentChange)',
    run: harness => harness.service.selectRuntimeConfig(harness.envs.B.optionId),
    settles: 'resolves',
  },
  {
    label: 're-select of A (selectRuntimeConfigWithGeneration, same boundary)',
    run: harness => harness.service.selectRuntimeConfig(harness.envs.A.optionId),
    settles: 'resolves',
  },
  {
    label: 'Google login, refused (googleLogin op 1)',
    prepare: harness => {
      harness.routes[GOOGLE_LOGIN_ROUTE] = unauthorized
    },
    run: harness => harness.service.googleLogin('fake-google-id-token'),
    settles: /^401 Unauthorized/,
  },
  {
    label: 'password login, refused (passwordLogin op 1)',
    prepare: harness => {
      harness.routes[PASSWORD_LOGIN_ROUTE] = unauthorized
    },
    run: harness => harness.service.passwordLogin('user-b@example.test', 'fake-password'),
    settles: /httpStatus=401$/,
  },
  {
    label: 'desktop setup, not found (completeDesktopSetup op 1)',
    prepare: harness => {
      harness.routes[HUB_SETUP_ROUTE] = setupNotFound
    },
    run: harness =>
      harness.service.completeDesktopSetup('user-d@example.test', 'fake-setup-authorization-token'),
    settles: /^desktop_setup_not_found$/,
  },
  {
    label: 'logout (logout)',
    run: harness => harness.service.logout(),
    settles: 'resolves',
  },
  {
    label: "start's own bump (startBrowserSignIn op 1)",
    run: harness => harness.service.startBrowserSignIn(),
    settles: 'resolves',
  },
]

describe('the generation hook at every first bump (G2-6)', () => {
  it.each(EIGHT_FIRST_BUMPS.map(event => [event.label, event] as const))(
    'G2-6 %s ends a waiting attempt replaced at once',
    async (_label, event) => {
      const harness = await createBrowserSignInHarness({
        linksAvailable: true,
        keptToken: event.keptToken ?? false,
      })
      const { service } = harness
      event.prepare?.(harness)
      const { attemptId } = await startAttempt(harness)
      await harness.drain()
      const startBump = harness.bumpLog.at(-1)
      expect(startBump?.value).toBe(service.getSessionGeneration())
      const startBumpIndex = harness.bumpLog.length - 1
      const pushesBefore = pushesOf(harness, attemptId).length
      expect(snapshotsOf(harness, attemptId)).toEqual([{ attemptId, phase: 'waiting' }])

      const outcome = track(event.run(harness))
      await outcome.done
      await harness.drain()

      if (event.settles === 'resolves') expect(outcome.result).toMatchObject({ ok: true })
      else
        expect(outcome.result).toMatchObject({
          ok: false,
          code: expect.stringMatching(event.settles),
        })
      // The attempt's next push is its end, `replaced`.
      const next = pushesOf(harness, attemptId)[pushesBefore]
      expect(next?.value).toEqual({ attemptId, phase: 'ended', outcome: 'replaced' })
      expect(endStatesOf(harness, attemptId)).toEqual(['replaced'])
      expectS9(harness)
      // From start's bump on, the observer saw every advance: a bump that bypassed the setter
      // leaves a gap, even when a later bump in the same op ends the attempt.
      const values = harness.bumpLog.slice(startBumpIndex).map(record => record.value)
      expect(values).toEqual(consecutive(startBump?.value ?? 0, service.getSessionGeneration()))
      // The end was pushed by the event's first bump, before its second one.
      const eventBumps = harness.bumpLog.slice(startBumpIndex + 1)
      expect(eventBumps.length).toBeGreaterThan(0)
      const second = eventBumps[1]
      if (second) expect(next?.seq).toBeLessThan(second.seq)
    }
  )
})

/** Desktop setup with the hub's answer (E31/E32), as T0-1 sends it. */
function completeSetup(harness: BrowserSignInHarness) {
  return harness.service.completeDesktopSetup(
    'user-d@example.test',
    'fake-setup-authorization-token'
  )
}

/**
 * Runs `body`, then cleans the harness up and gives the timers back. When `body` fails, its error
 * is the one thrown, so fast-check shrinks and reports the run's own failure; a cleanup failure
 * after it is logged beside it rather than put in its place.
 */
async function cleanUpAfter(body: () => Promise<void>): Promise<void> {
  try {
    await body()
  } catch (error) {
    vi.useRealTimers()
    await cleanupBrowserSignInHarness().catch((cleanupError: unknown) => {
      console.warn('model: the harness cleanup also failed after a failed run:', cleanupError)
    })
    throw error
  }
  vi.useRealTimers()
  await cleanupBrowserSignInHarness()
}

describe('the owner queue, op by op (N-1), and a restore racing a start (A3-62)', () => {
  it('N-1 a start queued behind a password login wins, and the login rejects stale', async () => {
    const harness = await createBrowserSignInHarness({ linksAvailable: true, keptToken: true })
    const { service } = harness
    // The owner is held inside the restore's reservation op, at its token read.
    const read = harness.hold('restoreTokenRead')
    const restore = track(service.getSessionState())
    await until(harness, () => read.reached, "the restore's token read")
    const generation = service.getSessionGeneration()

    const login = track(service.passwordLogin('user-b@example.test', 'fake-password'))
    const start = track(service.startBrowserSignIn())
    await harness.drain({ owner: false })
    // Both op 1s wait behind the held op.
    expect(service.getSessionGeneration()).toBe(generation)
    expect(harness.fetches).toEqual([])
    read.release()
    await Promise.all([restore.done, login.done, start.done])
    await harness.drain()

    // Password's op 1 bumped, then start's op 1, queued before password's next op, bumped again.
    expect(harness.bumpLog.map(record => record.value)).toEqual([generation + 1, generation + 2])
    expect(login.result).toEqual({ ok: false, code: 'stale_session_generation' })
    expect(fetchesTo(harness, 'POST', '/api/v1/auth/password-login')).toEqual([])
    expect(start.result).toEqual({ ok: true, value: { attemptId: 1 } })
    expect(snapshotsOf(harness, 1)).toEqual([{ attemptId: 1, phase: 'waiting' }])
    expect(fetchesTo(harness, 'GET', METHODS_PATH)).toHaveLength(1)
    // The restore no longer owned the session once the generation had moved.
    expect(restore.result).toMatchObject({ ok: true, value: { authenticated: false } })
    expect(service.getSessionPresence()).toEqual({ hasToken: false, hasMe: false })
    expectS9(harness)
  })

  it("N-1 held at the restore's chat-store bind, the restore signs in first and the queued start is refused", async () => {
    // The brief's first counterexample names this hold point. The restore's commit op has already
    // set the token when it reaches the bind, and goes on to sign in once released, so the
    // queued start finds a session at op 1 (D4). The op-level order is the row above's.
    const harness = await createBrowserSignInHarness({ linksAvailable: true, keptToken: true })
    const { service } = harness
    const bind = harness.hold('restoreChatBind')
    const restore = track(service.getSessionState())
    await until(harness, () => bind.reached, "the restore's chat-store bind")
    const generation = service.getSessionGeneration()

    const login = track(service.passwordLogin('user-b@example.test', 'fake-password'))
    const start = track(service.startBrowserSignIn())
    await harness.drain({ owner: false })
    expect(service.getSessionGeneration()).toBe(generation)
    bind.release()
    await Promise.all([restore.done, login.done, start.done])
    await harness.drain()

    expect(restore.result).toMatchObject({
      ok: true,
      value: { authenticated: true, me: { id: harnessDriverUsers.restore.id } },
    })
    expect(start.result).toEqual({ ok: false, code: 'browser_sign_in_requires_signout' })
    expect(fetchesTo(harness, 'GET', METHODS_PATH)).toEqual([])
    expect(harness.pushes).toEqual([])
    // The restore's commit, password's op 1, then password's install, which replaces the session.
    expect(harness.bumpLog.map(record => record.value)).toEqual(
      consecutive(generation + 1, generation + 3)
    )
    expect(login.result).toMatchObject({
      ok: true,
      value: { authenticated: true, me: { id: harnessDriverUsers.password.id } },
    })
  })

  it('N-1 setup queued at Γ8 is refused auth_transition_in_progress before the settle step', async () => {
    const harness = await createBrowserSignInHarness({ linksAvailable: true })
    const { service, envs } = harness
    const { attemptId, state } = await startAttempt(harness)
    const bind = harness.hold('installChatBind')
    expect(service.acceptDesktopLoginLink(codeLink(state, envs.A.restBaseUrl))).toBe(true)
    await until(harness, () => bind.reached, "the install's chat-store bind")

    const setup = track(completeSetup(harness))
    await harness.drain({ owner: false })
    expect(setup.result).toBeNull()
    bind.release()
    await setup.done
    await harness.drain()

    // The install op ended the attempt signed in; setup's op 1, queued before the install's
    // settle op, still found the redeem counted, so it is refused as in progress, not for the
    // session.
    expect(endStatesOf(harness, attemptId)).toEqual(['signed_in'])
    expect(setup.result).toEqual({ ok: false, code: 'auth_transition_in_progress' })
    expect(fetchesTo(harness, 'POST', HUB_SETUP_PATH)).toEqual([])
    // Then the settle op ran: setup is now refused for the session.
    await expect(completeSetup(harness)).rejects.toThrow(/^desktop_setup_requires_signout$/)
    expect(service.getSessionPresence()).toEqual({ hasToken: true, hasMe: true })
  })

  it('A3-62 gives one outcome whichever of restore and start commits first', async () => {
    const orders = new Set<'start first' | 'restore first'>()
    await fc.assert(
      fc.asyncProperty(fc.scheduler(), async scheduler => {
        const harness = await createBrowserSignInHarness({
          scheduler,
          linksAvailable: true,
          keptToken: true,
        })
        await cleanUpAfter(async () => {
          const { service } = harness
          const start = track(service.startBrowserSignIn())
          // Start's op 1 runs and dispatches its methods read; the scheduler holds the answer.
          await new Promise<void>(resolve => setImmediate(resolve))
          expect(fetchesTo(harness, 'GET', METHODS_PATH)).toHaveLength(1)
          expect(start.result).toBeNull()
          // A replaced renderer's boot restores the kept token (E15).
          const restore = track(service.getSessionState())
          await harness.drain()
          await Promise.all([start.done, restore.done])
          await harness.drain()

          // One outcome: signed in by the saved session, and no attempt left waiting.
          expect(restore.result).toMatchObject({
            ok: true,
            value: { authenticated: true, me: { id: harnessDriverUsers.restore.id } },
          })
          expect(service.getSessionPresence()).toEqual({ hasToken: true, hasMe: true })
          expect(fetchesTo(harness, 'GET', METHODS_PATH)).toHaveLength(1)
          expectS9(harness)
          if (start.result?.ok) {
            orders.add('start first')
            expect(start.result.value).toEqual({ attemptId: 1 })
            expect(snapshotsOf(harness, 1)).toEqual([
              { attemptId: 1, phase: 'waiting' },
              { attemptId: 1, phase: 'ended', outcome: 'replaced' },
            ])
            expect(harness.opens).toHaveLength(1)
          } else {
            orders.add('restore first')
            expect(start.result).toEqual({ ok: false, code: 'stale_session_generation' })
            expect(harness.pushes).toEqual([])
            expect(harness.opens).toEqual([])
          }
        })
      }),
      { numRuns: 24, seed: 24112026 }
    )
    expect([...orders].sort()).toEqual(['restore first', 'start first'])
  })
})

describe('acknowledging an overdue attempt (D12)', () => {
  it('D12 acknowledging an overdue waiting attempt answers waiting, pushes nothing, and the next read ends it', async () => {
    const harness = await createBrowserSignInHarness({ linksAvailable: true })
    const { service, clock } = harness
    const { attemptId } = await startAttempt(harness)
    await harness.drain()
    const pushesBefore = harness.pushes.length
    // Past the deadline on the wall clock, with the timer not fired and no check run.
    clock.advance(SIXTEEN_MINUTES_MS, 'wallOnly')
    expect(clock.pendingTimers()).toBe(1)

    // The acknowledgement does not apply the deadline: the attempt has not ended, so there is
    // nothing to acknowledge.
    expect(service.acknowledgeBrowserSignInResult(attemptId)).toEqual({
      attemptId,
      phase: 'waiting',
    })
    await harness.drain()
    expect(harness.pushes).toHaveLength(pushesBefore)

    // A read applies it.
    const timedOut = { attemptId, phase: 'ended', outcome: 'timed_out' }
    expect(service.getBrowserSignInState()).toEqual(timedOut)
    await harness.drain()
    expect(harness.pushes.slice(pushesBefore).map(record => record.value)).toEqual([timedOut])
    expect(SIXTEEN_MINUTES_MS).toBeGreaterThan(BROWSER_SIGN_IN_DEADLINE_MS)
  })
})

// The generated model (state model §7). The reference model is written from design §10.1, §7.6
// and state model §5.2, never from the implementation, and reads no private field of the
// service: only command results, the harness's boundary records and the two read-only seams.
//
// How a run goes (M3a–M3h):
// - Each command issues its call without awaiting a promise a hold could block, then drains. Gaps
//   come only from holds: `Hold(point)` sets one hold and makes the call that reaches it, so no
//   other caller takes it (N-5). A hold that needs an earlier gap builds it with the same calls.
// - While an owner op is held, the commands whose op 1 the model knows queue behind it. Their op
//   1s then run in FIFO order (N-1). After them, one command with work left runs alone; with two
//   or more, the scheduler orders their outside awaits, so their results are checked against
//   their allowed sets and the model takes the outcome it observes.
// - `Date` follows the browser sign-in clock (the restore's 5 s gate reads it); every other timer
//   is real. Each run ends by releasing what is held, then `Settle`.
// - S5, L6, L7 and L8 are renderer predicates (Tasks 12, 13). The token-store admission clause of
//   quiescence is vacuous with the fake store; the quit-drain scenarios check it.

type Env = 'A' | 'B' | 'C'
/** Whose session: the kept token's user, a password or Google login's, or the redeem's. */
type Who = 'kept' | 'password' | 'google' | 'browser'
type OwnerHold = 'restoreTokenRead' | 'restoreChatBind' | 'installChatBind' | 'installTokenWrite'
type Gap = 'Γ2' | 'Γ3' | 'Γ4' | 'Γ5' | 'Γ6' | 'Γ8'
type WitnessEvent =
  | 'Bump'
  | 'Cancel'
  | 'Start'
  | 'DeliverCode'
  | 'AdvanceClock'
  | 'ReplaceRenderer'
  | 'Read'
  | 'other'
type RedeemAnswer =
  | 'signed-in'
  | 'invalid'
  | 'refused-account-disabled'
  | 'unavailable'
  | 'rate-limited'
  | 'issuance-unavailable'
type MethodsAnswer = 'password-and-oidc' | 'password-only' | 'unavailable'
type ClockVia = 'wallOnly' | 'timers' | 'resume' | 'read'
type StateChoice = 'current' | 'previous' | 'random'
type EnvChoice = 'same' | 'variant' | 'other'
type ErrorKind = 'refused' | 'cancelled' | 'unavailable' | 'failed'

type ModelAttempt = {
  id: number
  env: Env
  phase: 'waiting' | 'redeeming' | 'ended'
  /** The wall-clock deadline, checked at a resume, a link, a read (D12). */
  deadlineMs: number
  /** V16's schedule: it fires on this, whatever the wall clock says (D12 ruling). */
  timerDueMs: number
  /** A bump after it began redeeming: its install ends it `replaced` (D2). */
  bumpedWhileRedeeming: boolean
}

/** A command queued behind a held owner op, whose op 1 has not run (N-1). */
type Queued =
  | { kind: 'start'; tracked: Tracked<unknown> }
  | { kind: 'password'; ok: boolean; tracked: Tracked<unknown> }
  | { kind: 'setup'; tracked: Tracked<unknown> }
  | { kind: 'logout'; tracked: Tracked<unknown> }
  | { kind: 'select'; target: Env; tracked: Tracked<unknown> }
  | { kind: 'handoff'; target: Env; bumpsAtIssue: number; tracked: Tracked<unknown> }
  | { kind: 'link'; link: AcceptedLink }

type Model = {
  env: Env
  exists: Record<Env, boolean>
  session: Who | null
  /** Whose token the token store keeps for the active environment. */
  stored: Who | null
  /** The restore's 5 s retry gate (`getSessionState`): the environment and wall time of its last try. */
  gate: { env: Env; atMs: number } | null
  /** Logins in flight that count (D11): password, Google, and a redeem. */
  count: number
  bumps: number
  lastId: number
  attempt: ModelAttempt | null
  envOf: Map<number, Env>
  snapshot: BrowserSignInSnapshot
  nowMs: number
  timerMs: number
  /** Start's outside awaits held (Γ2, Γ3). */
  start: null | {
    stage: 'methods' | 'open'
    bumpsAtOp1: number
    env: Env
    attemptId: number | null
  }
  /** A held redeem (Γ6). */
  redeem: null | { attemptId: number }
  /** A hold under an owner op, reached (Γ5, Γ8; the restore's token read). */
  ownerHold: OwnerHold | null
  queue: Queued[]
  windowOpen: boolean
  methodsFetches: number
  redeemFetches: number
}

type Tracked<T> = { result: Settled<T> | null; done: Promise<void> }

type AcceptedLink = Readonly<{
  kind: 'code' | 'error'
  state: string
  environment: string
  envChoice: EnvChoice
  code: string | null
  end: BrowserSignInEnd | null
}>

type RunStats = {
  /** How often each `<gap> <event>` pair was visited. */
  witness: Map<string, number>
  /** Commands run, by label (the generated runs' shape, for tuning the weights). */
  ran: Map<string, number>
  pushes: number
  acceptedLinks: number
  tokenWrites: number
  secretsScanned: number
}

type Real = {
  harness: BrowserSignInHarness
  runtimeConfig: RuntimeConfigModule
  router: EvenfireDeepLinkRouter
  windowRequests: number
  holds: Partial<Record<HoldPoint, HarnessHold>>
  pendingStart: Tracked<unknown> | null
  pendingRestore: Tracked<unknown> | null
  /** Each accepted link, with the seq of the record that follows its acceptance. */
  accepted: Array<AcceptedLink & { seq: number }>
  /** Codes and random states the generator made (G2-18). */
  generated: Set<string>
  /** Attempts a Cancel ended (S6). */
  cancelled: Set<number>
  redeemAnswerByCode: Map<string, RedeemAnswer>
  /** Calls not yet settled. */
  live: Set<Tracked<unknown>>
  stats: RunStats
}

type RuntimeConfigModule = typeof import('../config.js')

const DEADLINE = BROWSER_SIGN_IN_DEADLINE_MS
const RESTORE_RETRY_GATE_MS = 5_000
const REDEEM_ROUTE = 'POST /api/v1/oidc/desktop-sign-in/redeem'
const REFUSED_PASSWORD_EMAIL = 'refused-user-b@example.test'
const REFUSED_GOOGLE_TOKEN = 'fake-google-id-token-refused'
const NO_SNAPSHOT: BrowserSignInSnapshot = { attemptId: null, phase: 'idle' }

/** The model's coverage witness (M3h): every pair below must be visited. */
const WITNESS_REQUIRED: ReadonlyArray<readonly [Gap, WitnessEvent]> = [
  ['Γ2', 'Bump'],
  ['Γ2', 'Cancel'],
  ['Γ2', 'Start'],
  ['Γ3', 'Bump'],
  ['Γ3', 'Cancel'],
  ['Γ3', 'Start'],
  ['Γ4', 'Bump'],
  ['Γ4', 'Cancel'],
  ['Γ4', 'DeliverCode'],
  ['Γ4', 'AdvanceClock'],
  ['Γ5', 'DeliverCode'],
  ['Γ6', 'Bump'],
  ['Γ6', 'Cancel'],
  ['Γ6', 'Start'],
  ['Γ6', 'ReplaceRenderer'],
  ['Γ8', 'Bump'],
  ['Γ8', 'Cancel'],
  ['Γ8', 'Read'],
]

const REDEEM_RECORD_KEYS: Readonly<Record<RedeemAnswer, EdgeRecordKey>> = {
  'signed-in': 'POST /api/v1/oidc/desktop-sign-in/redeem signed-in',
  invalid: 'POST /api/v1/oidc/desktop-sign-in/redeem invalid',
  'refused-account-disabled': 'POST /api/v1/oidc/desktop-sign-in/redeem refused-account-disabled',
  unavailable: 'POST /api/v1/oidc/desktop-sign-in/redeem unavailable',
  'rate-limited': 'POST /api/v1/oidc/desktop-sign-in/redeem rate-limited',
  'issuance-unavailable': 'POST /api/v1/oidc/desktop-sign-in/redeem issuance-unavailable',
}

const METHODS_RECORD_KEYS: Readonly<Record<MethodsAnswer, EdgeRecordKey>> = {
  'password-and-oidc': 'GET /api/v1/auth/methods password-and-oidc',
  'password-only': 'GET /api/v1/auth/methods password',
  unavailable: 'GET /api/v1/auth/methods unavailable',
}

/** §5.2 for a redeem answer other than a usable 200, from the design's table. */
function redeemEnd(answer: Exclude<RedeemAnswer, 'signed-in'>): BrowserSignInEnd {
  switch (answer) {
    case 'refused-account-disabled':
      return {
        outcome: 'refused',
        reason: (readEdgeRecord(REDEEM_RECORD_KEYS[answer]).body as { reason: 'account_disabled' })
          .reason,
      }
    case 'unavailable':
      return { outcome: 'failed', reason: 'no_longer_available' }
    default:
      return { outcome: 'failed' }
  }
}

/** §5.2 for an `error` link. */
function errorLinkEnd(kind: ErrorKind): BrowserSignInEnd {
  switch (kind) {
    case 'refused':
      return { outcome: 'refused', reason: 'account_disabled' }
    case 'cancelled':
      return { outcome: 'cancelled' }
    case 'unavailable':
      return { outcome: 'failed', reason: 'unavailable' }
    case 'failed':
      return { outcome: 'failed' }
  }
}

function endedSnapshot(attemptId: number, end: BrowserSignInEnd): BrowserSignInSnapshot {
  return { attemptId, phase: 'ended', ...end } as BrowserSignInSnapshot
}

// The model's transitions, each one line of design §10.1 / state model §5.2.

function endAttempt(m: Model, end: BrowserSignInEnd): void {
  const attempt = m.attempt
  if (!attempt || attempt.phase === 'ended') return
  attempt.phase = 'ended'
  m.snapshot = endedSnapshot(attempt.id, end)
}

/** A generation advance: a waiting attempt ends `replaced`; a redeeming one is marked (D6, D9). */
function bump(m: Model): void {
  m.bumps += 1
  const attempt = m.attempt
  if (attempt?.phase === 'waiting') endAttempt(m, { outcome: 'replaced' })
  else if (attempt?.phase === 'redeeming') attempt.bumpedWhileRedeeming = true
}

/** The deadline on the wall clock, applied by a check that ran (D12). */
function checkDeadline(m: Model): void {
  const attempt = m.attempt
  if (attempt?.phase === 'waiting' && m.nowMs >= attempt.deadlineMs) {
    endAttempt(m, { outcome: 'timed_out' })
  }
}

function record(m: Model, env: Env): number {
  m.lastId += 1
  m.attempt = {
    id: m.lastId,
    env,
    phase: 'waiting',
    deadlineMs: m.nowMs + DEADLINE,
    timerDueMs: m.timerMs + DEADLINE,
    bumpedWhileRedeeming: false,
  }
  m.envOf.set(m.lastId, env)
  m.snapshot = { attemptId: m.lastId, phase: 'waiting' }
  return m.lastId
}

/** Op 1 of a start: its refusals, then its bump and its methods read (D3, D4, D10). */
function startOp1(m: Model): string | null {
  if (m.session !== null) return 'browser_sign_in_requires_signout'
  if (m.attempt?.phase === 'redeeming') return 'browser_sign_in_finishing'
  bump(m)
  m.methodsFetches += 1
  return null
}

/** Op 2 of a start: the re-assertions, then the methods answer, then the record (D5). */
function startOp2(
  m: Model,
  bumpsAtOp1: number,
  env: Env,
  answer: MethodsAnswer
): { refused: string } | { attemptId: number } {
  if (m.bumps !== bumpsAtOp1) return { refused: 'stale_session_generation' }
  if (answer === 'unavailable') return { refused: 'methods_unavailable' }
  if (answer === 'password-only') return { refused: 'browser_sign_in_not_offered' }
  return { attemptId: record(m, env) }
}

/** The redeem's install op and its settle step, alone (D2, D9, D11, §5.2). */
function installOp(m: Model, attemptId: number, answer: RedeemAnswer): void {
  const attempt = m.attempt
  if (attempt?.id === attemptId && attempt.phase === 'redeeming') {
    if (attempt.bumpedWhileRedeeming) endAttempt(m, { outcome: 'replaced' })
    else if (answer !== 'signed-in') endAttempt(m, redeemEnd(answer))
    else {
      m.bumps += 1
      m.session = 'browser'
      m.stored = 'browser'
      endAttempt(m, { outcome: 'signed_in' })
    }
  }
  m.count -= 1
}

/** A login that signs in: its install's bump, the session and its saved token. */
function signIn(m: Model, who: Who): void {
  bump(m)
  m.session = who
  m.stored = who
}

/** Logout, or a switch to another environment: two bumps, signed out, the old token cleared. */
function signOutWithTwoBumps(m: Model): void {
  bump(m)
  bump(m)
  m.session = null
  m.stored = null
}

function restoreGated(m: Model): boolean {
  return m.gate !== null && m.gate.env === m.env && m.nowMs - m.gate.atMs < RESTORE_RETRY_GATE_MS
}

// The real side.

/** Tracks a service call's promise; `drain` waits for it unless the model holds it. */
function startTracking<T>(real: Real, promise: Promise<T>): Tracked<T> {
  const tracked = track(promise)
  real.live.add(tracked)
  void tracked.done.then(() => real.live.delete(tracked))
  return tracked
}

function heldByModel(real: Real, m: Model, tracked: Tracked<unknown>): boolean {
  return (
    tracked === real.pendingStart ||
    tracked === real.pendingRestore ||
    m.queue.some(item => 'tracked' in item && item.tracked === tracked)
  )
}

function whoOfUser(userId: string | null): Who | null {
  if (userId === null) return null
  if (userId === harnessDriverUsers.restore.id) return 'kept'
  if (userId === harnessDriverUsers.password.id) return 'password'
  if (userId === harnessDriverUsers.google.id) return 'google'
  if (userId === redeemUserId()) return 'browser'
  throw new Error(`model: no user known by the id ${userId}`)
}

function redeemUserId(): string {
  return (readEdgeRecord(REDEEM_RECORD_KEYS['signed-in']).body as { me: { id: string } }).me.id
}

function recordedSessionToken(): string {
  return (readEdgeRecord(REDEEM_RECORD_KEYS['signed-in']).body as { token: string }).token
}

/** Whose token a saved token is, from the shapes the harness issues. */
function whoOfToken(token: string | undefined, session: Who | null): Who | null {
  if (token === undefined) return null
  if (token === recordedSessionToken()) return 'browser'
  if (token.startsWith('fake-password-session-token-')) return 'password'
  if (token.startsWith('fake-google-session-token-')) return 'google'
  if (token.startsWith('fake-switch-session-token-')) return session
  return 'kept'
}

function realSnapshot(real: Real): BrowserSignInSnapshot {
  return real.harness.pushes.at(-1)?.value ?? NO_SNAPSHOT
}

function realWho(real: Real): Who | null {
  return whoOfUser(real.harness.service.getCachedUserId())
}

/** The state an attempt's page carried (opens are 1:1 with recorded attempts, in id order). */
function stateOfAttempt(real: Real, attemptId: number): string | null {
  const opened = real.harness.opens[attemptId - 1]
  return opened ? (parseDesktopLoginPageUrl(opened.value)?.state ?? null) : null
}

function challengeOfAttempt(real: Real, attemptId: number): string | null {
  const opened = real.harness.opens[attemptId - 1]
  return opened ? (parseDesktopLoginPageUrl(opened.value)?.challenge ?? null) : null
}

function restOf(real: Real, env: Env): string {
  return real.harness.envs[env].restBaseUrl
}

function linkEnvironment(real: Real, env: Env, choice: EnvChoice): string {
  const bound = new URL(restOf(real, env))
  if (choice === 'same') return restOf(real, env)
  // A3-30: host case and a trailing slash name the same endpoint.
  if (choice === 'variant') return `${bound.protocol}//${bound.hostname.toUpperCase()}/`
  return restOf(real, env === 'B' ? 'A' : 'B')
}

const SETTLE_TURN_LIMIT = 50
/** Real time a drain may spend waiting for real I/O inside an owner op (see `drainOnce`). */
const OWNER_IO_WAIT_LIMIT_MS = 5_000
const OWNER_UNSETTLED = /^drain: the auth owner queue had not settled after \d+ turns/

/**
 * One harness drain. An owner op can wait on real file I/O (the GFS upload state a login over a
 * live session suspends and migrates), which the drain's `setImmediate` turns do not always cover.
 * That limit is retried in 5 ms steps of real time, up to `OWNER_IO_WAIT_LIMIT_MS`; an owner
 * queue still unsettled after that is a deadlock, and its error is thrown (L1).
 */
async function drainOnce(real: Real, m: Model): Promise<void> {
  const deadline = performance.now() + OWNER_IO_WAIT_LIMIT_MS
  for (;;) {
    try {
      await real.harness.drain({ owner: m.ownerHold === null })
      return
    } catch (error) {
      const slowIo = error instanceof Error && OWNER_UNSETTLED.test(error.message)
      if (!slowIo || performance.now() >= deadline) throw error
      await new Promise<void>(resolve => setTimeout(resolve, 5))
    }
  }
}

/**
 * Drains (the owner too, unless an owner op is held), then again while a call the model does not
 * hold is unsettled: a browser open awaits a dynamic import, which a drain's turns may not cover.
 */
async function drain(real: Real, m: Model): Promise<void> {
  for (let turn = 0; turn < SETTLE_TURN_LIMIT; turn += 1) {
    await drainOnce(real, m)
    if (![...real.live].some(tracked => !heldByModel(real, m, tracked))) return
  }
}

type Expected =
  | { settles: 'resolves'; value?: unknown }
  | { settles: 'rejects'; code: RegExp }
  | { settles: 'pending' }
  | { settles: 'either'; allowed: ReadonlyArray<Expected> }

function matches(result: Settled<unknown> | null, expected: Expected): boolean {
  switch (expected.settles) {
    case 'pending':
      return result === null
    case 'resolves':
      if (!result?.ok) return false
      if (expected.value === undefined) return true
      try {
        expect(result.value).toMatchObject(expected.value as object)
        return true
      } catch {
        // Not this arm: `matches` answers whether any allowed arm fits.
        return false
      }
    case 'rejects':
      return result !== null && !result.ok && expected.code.test(result.code)
    case 'either':
      return expected.allowed.some(arm => matches(result, arm))
  }
}

function expectSettled(label: string, tracked: Tracked<unknown> | null, expected: Expected): void {
  expect(
    { label, matched: matches(tracked?.result ?? null, expected) },
    `${label}: got ${JSON.stringify(tracked?.result)}, expected ${JSON.stringify(expected, (_k, v) => (v instanceof RegExp ? String(v) : v))}`
  ).toEqual({ label, matched: true })
}

const STALE = /^stale_session_generation$/
const SESSION_RESOLVES: Expected = { settles: 'resolves' }

/**
 * The model's gap before a command (state model §3.1), for the coverage witness. A command can
 * sit in more than one gap at once (a held open with a held redeem).
 */
function gapsOf(m: Model): Gap[] {
  const gaps: Gap[] = []
  if (m.ownerHold === 'installChatBind' || m.ownerHold === 'installTokenWrite') gaps.push('Γ8')
  if (m.ownerHold === 'restoreChatBind') gaps.push('Γ5')
  if (m.redeem) gaps.push('Γ6')
  if (m.start?.stage === 'open') gaps.push('Γ3')
  if (m.start?.stage === 'methods') gaps.push('Γ2')
  if (gaps.length === 0 && m.ownerHold === null && m.attempt?.phase === 'waiting') gaps.push('Γ4')
  return gaps
}

/**
 * The predicates of state model §4 that hold at any point, from the boundary records only (§4.1):
 * S1–S4, S6, S8 and C1–C3. S2's scan of what left the service is `checkSecrets`.
 */
function checkRecords(real: Real, m: Model): void {
  const { harness } = real
  const pushes = harness.pushes
  const redeems = fetchesTo(harness, 'POST', REDEEM_PATH)
  const attemptIds = new Set<number>()
  for (const record of pushes)
    if (record.value.attemptId !== null) attemptIds.add(record.value.attemptId)

  // C3: one browser open per recorded attempt, none for a start refused in op 1 or op 2.
  expect(harness.opens, 'C3: one open per recorded attempt').toHaveLength(m.lastId)
  // C2: one methods fetch per start that passed op 1, and per methods read.
  expect(fetchesTo(harness, 'GET', METHODS_PATH), 'C2: methods fetches').toHaveLength(
    m.methodsFetches
  )
  // C1: one redeem per code link that began a redeem, and no transport retry.
  expect(redeems, 'C1: redeem fetches').toHaveLength(m.redeemFetches)

  const challenges = new Map<string, number>()
  for (let id = 1; id <= m.lastId; id += 1) {
    const challenge = challengeOfAttempt(real, id)
    if (challenge) challenges.set(challenge, id)
  }
  const redeemsOf = new Map<number, typeof redeems>()
  for (const fetch of redeems) {
    const body = fetch.value.body as { code?: string; codeVerifier?: string }
    const attemptId = challenges.get(base64urlSha256(body.codeVerifier ?? ''))
    // S2: every fetch carrying a code and verifier belongs to an attempt and goes to its bound
    // REST URL and the redeem path.
    expect(attemptId, 'S2: a redeem whose verifier no attempt opened').toBeDefined()
    const env = m.envOf.get(attemptId ?? 0)
    expect(fetch.value.url, 'S2: the redeem goes to the bound REST URL').toBe(
      `${restOf(real, env ?? 'A')}${REDEEM_PATH}`
    )
    const list = redeemsOf.get(attemptId ?? 0) ?? []
    list.push(fetch)
    redeemsOf.set(attemptId ?? 0, list)
  }
  for (const fetch of harness.fetches) {
    const body = fetch.value.body as { code?: unknown; codeVerifier?: unknown } | undefined
    if (body && typeof body === 'object' && ('code' in body || 'codeVerifier' in body)) {
      expect(new URL(fetch.value.url).pathname, 'S2: a code or verifier off the redeem path').toBe(
        REDEEM_PATH
      )
    }
  }

  // S6: an attempt a Cancel ended keeps that one end: it is never installed.
  for (const attemptId of real.cancelled) {
    expect(endStatesOf(harness, attemptId), `S6: attempt ${attemptId}`).toEqual(['cancelled'])
  }

  for (const attemptId of attemptIds) {
    const own = pushesOf(harness, attemptId)
    const phases = own.map(record => record.value.phase)
    // S8: waiting, then redeeming, then ended (then idle once acknowledged), forward only.
    expect(phases.join(','), `S8: attempt ${attemptId}`).toMatch(
      /^waiting(,redeeming)?(,ended(,idle)?)?$/
    )
    // S3: at most one redeem per attempt.
    expect((redeemsOf.get(attemptId) ?? []).length, `S3: attempt ${attemptId}`).toBeLessThanOrEqual(
      1
    )
    const signedIn = own.find(
      record => record.value.phase === 'ended' && record.value.outcome === 'signed_in'
    )
    if (!signedIn) continue
    const waitingSeq = own[0]?.seq ?? 0
    // Attribution (§4.1 N2): the install's token write is the last write before the push.
    const write = harness.tokenWrites.filter(entry => entry.seq < signedIn.seq).at(-1)
    expect(write, `S1: attempt ${attemptId} has no token write`).toBeDefined()
    // S1: an accepted code link for this attempt's state and environment.
    const state = stateOfAttempt(real, attemptId)
    const env = m.envOf.get(attemptId) ?? 'A'
    expect(
      real.accepted.some(
        link =>
          link.kind === 'code' &&
          link.state === state &&
          link.envChoice !== 'other' &&
          link.seq < signedIn.seq
      ),
      `S1: attempt ${attemptId} was installed without an accepted code link`
    ).toBe(true)
    // S1, S3: one redeem, to the bound REST URL.
    expect(
      (redeemsOf.get(attemptId) ?? []).map(fetch => fetch.value.url),
      `S1: attempt ${attemptId}'s redeem`
    ).toEqual([`${restOf(real, env)}${REDEEM_PATH}`])
    // S1, S4: between the waiting push and the token write, the install's own bump only.
    const bumpsBetween = harness.bumpLog.filter(
      entry => entry.seq > waitingSeq && entry.seq < (write?.seq ?? 0)
    )
    expect(bumpsBetween, `S1/S4: attempt ${attemptId}'s bumps before its install`).toHaveLength(1)
    // S4: no bump between the token write and the end either.
    expect(
      harness.bumpLog.filter(entry => entry.seq > (write?.seq ?? 0) && entry.seq < signedIn.seq),
      `S4: attempt ${attemptId}`
    ).toEqual([])
  }
}

/**
 * S2 and D18 (G2-18): no generated code, no state an attempt's page carried and no verifier a
 * redeem sent appears in what left the service: its replies, its `console.*` lines, its token
 * writes and its pushes (`secretsSeen`). Checked first after each command, so a leak fails here
 * rather than on a later comparison it also breaks.
 */
function checkSecrets(real: Real, m: Model): void {
  const { harness } = real
  const secrets = new Set(real.generated)
  for (let id = 1; id <= m.lastId; id += 1) {
    const state = stateOfAttempt(real, id)
    if (state) secrets.add(state)
  }
  for (const fetch of fetchesTo(harness, 'POST', REDEEM_PATH)) {
    const body = fetch.value.body as { code?: string; codeVerifier?: string }
    if (body.code) secrets.add(body.code)
    if (body.codeVerifier) secrets.add(body.codeVerifier)
  }
  for (const secret of secrets) {
    expect(secret.length, 'G2-18: an empty secret proves nothing').toBeGreaterThan(0)
    expect(
      harness.secretsSeen.filter(text => text.includes(secret)),
      'G2-18: a code, verifier or state left the service'
    ).toEqual([])
  }
  real.stats.secretsScanned += secrets.size
}

function base64urlSha256(value: string): string {
  return createHash('sha256').update(value).digest('base64url')
}

/**
 * The predicates that hold at quiescence (§4.1): nothing held, nothing queued. S7, S9 and L1.
 * The reference model's snapshot and session are compared after every command (`run`).
 */
function checkQuiescent(real: Real, m: Model): void {
  const { harness } = real
  const snapshot = realSnapshot(real)
  // S7: a waiting attempt only while signed out, with no half-written session.
  if (snapshot.phase === 'waiting') {
    expect(harness.service.getSessionPresence(), 'S7').toEqual({ hasToken: false, hasMe: false })
  }
  // L1: every attempt but the newest has ended exactly once; none is left redeeming.
  for (let id = 1; id <= m.lastId; id += 1) {
    const own = pushesOf(harness, id)
    const ends = own.filter(record => record.value.phase === 'ended')
    expect(ends.length, `L1: attempt ${id}'s end states`).toBeLessThanOrEqual(1)
    if (id < m.lastId) expect(ends, `L1: attempt ${id} never ended`).toHaveLength(1)
    expect(own.at(-1)?.value.phase, `L1: attempt ${id} left redeeming`).not.toBe('redeeming')
  }
  // L1 (revision 2.3): a waiting attempt may be past its deadline only until a check runs; the
  // model ends it at every check that ran, and its timer on its own schedule.
  const attempt = m.attempt
  if (attempt?.phase === 'waiting') {
    expect(m.timerMs < attempt.timerDueMs, 'L1: the deadline timer has fired').toBe(true)
  }
  expectS9(harness)
}

/** After a window whose order the scheduler chose, the model takes the outcome it observed. */
function resyncFromObservation(real: Real, m: Model, readsBefore: number): void {
  m.session = realWho(real)
  const envKey = real.runtimeConfig.getActiveEnvKey()
  m.stored = whoOfToken(real.harness.storedSessionTokens().get(envKey), m.session)
  m.snapshot = realSnapshot(real)
  const ids = real.harness.pushes.flatMap(record =>
    record.value.attemptId === null ? [] : [record.value.attemptId]
  )
  const lastId = Math.max(0, ...ids)
  const known = m.attempt?.id ?? 0
  for (let id = known + 1; id <= lastId; id += 1) m.envOf.set(id, m.env)
  if (lastId > known) {
    m.attempt = {
      id: lastId,
      env: m.env,
      phase: 'waiting',
      deadlineMs: m.nowMs + DEADLINE,
      timerDueMs: m.timerMs + DEADLINE,
      bumpedWhileRedeeming: false,
    }
  }
  m.lastId = lastId
  const last = pushesOf(real.harness, lastId).at(-1)?.value
  if (m.attempt && last) {
    m.attempt.phase = last.phase === 'idle' ? 'ended' : last.phase
  }
  m.count = 0
  const reads = real.harness.tokenReads.slice(readsBefore)
  const lastRead = reads.at(-1)
  if (lastRead) {
    const env = (['A', 'B', 'C'] as const).find(name => envKeyOf(real, name) === lastRead.value)
    if (env) m.gate = { env, atMs: m.nowMs }
  }
}

function envKeyOf(real: Real, env: Env): string | null {
  const option = real.runtimeConfig
    .getDesktopRuntimeConfigState()
    .options.find(candidate => candidate.id === real.harness.envs[env].optionId)
  return option
    ? real.runtimeConfig.resolveEnvKey(option.externalRestApiBaseUrl, option.rpcProxyBaseUrl)
    : null
}

// The commands (state model §7.2). Each issues its service call without awaiting a promise a
// hold could block, then drains, then compares the real outcome with the model's.

/**
 * A command's body. It returns `false` when the command did nothing at its gap (a link the
 * pre-match dropped), so the coverage witness does not count it.
 */
type CommandBody = (m: Model, real: Real) => Promise<void | boolean>

class ModelCommand implements fc.AsyncCommand<Model, Real> {
  constructor(
    private readonly label: string,
    private readonly event: WitnessEvent,
    private readonly allowed: (m: Readonly<Model>) => boolean,
    private readonly body: CommandBody
  ) {}

  check(m: Readonly<Model>): boolean {
    return this.allowed(m)
  }

  async run(m: Model, real: Real): Promise<void> {
    const gaps = gapsOf(m)
    real.stats.ran.set(this.label, (real.stats.ran.get(this.label) ?? 0) + 1)
    const counts = await this.body(m, real)
    if (counts !== false) {
      for (const gap of gaps) {
        const pair = `${gap} ${this.event}`
        real.stats.witness.set(pair, (real.stats.witness.get(pair) ?? 0) + 1)
      }
    }
    checkSecrets(real, m)
    // Every push has run (drain), so the last one is V14.
    expect(realSnapshot(real), `${this.label}: the snapshot`).toEqual(m.snapshot)
    expect(realWho(real), `${this.label}: the session`).toBe(m.session)
    checkRecords(real, m)
    if (isQuiescent(m)) checkQuiescent(real, m)
  }

  /** The body alone, for a command that picks another at run time (`releaseAnyCommand`). */
  runBody(m: Model, real: Real): Promise<void | boolean> {
    return this.body(m, real)
  }

  toString(): string {
    return this.label
  }
}

function isQuiescent(m: Readonly<Model>): boolean {
  return m.ownerHold === null && m.start === null && m.redeem === null && m.queue.length === 0
}

const blocked = (m: Readonly<Model>) => m.ownerHold !== null
const free = (m: Readonly<Model>) => m.ownerHold === null

/** A hold the harness made, by point. */
function heldAt(real: Real, point: HoldPoint): HarnessHold {
  const hold = real.holds[point]
  if (!hold) throw new Error(`model: no ${point} hold to release`)
  delete real.holds[point]
  return hold
}

function makeHold(real: Real, point: HoldPoint): HarnessHold {
  const hold = real.harness.hold(point)
  real.holds[point] = hold
  return hold
}

/** A hold the command meant to reach. Not reaching it is a model or harness error, not a finding. */
function expectReached(label: string, hold: HarnessHold): void {
  if (!hold.reached) throw new Error(`model/harness: ${label} did not reach its hold`)
}

function sessionExpected(m: Model): Expected {
  return m.session === null
    ? { settles: 'resolves', value: { authenticated: false, me: null } }
    : { settles: 'resolves', value: { authenticated: true } }
}

/** `getSessionState` with no hold (E15), alone: the restore when one is due. */
function modelGetSessionState(m: Model): Expected {
  if (m.session !== null) return sessionExpected(m)
  if (restoreGated(m)) return sessionExpected(m)
  // The reservation op: a login in flight keeps the restore out, and sets no gate.
  if (m.count > 0) return sessionExpected(m)
  m.gate = { env: m.env, atMs: m.nowMs }
  if (m.stored === null) return sessionExpected(m)
  bump(m)
  m.session = m.stored
  return sessionExpected(m)
}

function attemptState(real: Real, m: Model, choice: StateChoice, random: string): string {
  const id = choice === 'current' ? m.lastId : m.lastId - 1
  const state = choice === 'random' || id < 1 ? null : stateOfAttempt(real, id)
  if (state !== null) return state
  real.generated.add(random)
  return random
}

function currentSeq(harness: BrowserSignInHarness): number {
  const lasts = [
    harness.fetches.at(-1)?.seq,
    harness.pushes.at(-1)?.seq,
    harness.opens.at(-1)?.seq,
    harness.bumpLog.at(-1)?.seq,
    harness.tokenWrites.at(-1)?.seq,
    harness.tokenReads.at(-1)?.seq,
  ]
  return Math.max(0, ...lasts.map(seq => seq ?? 0))
}

/** Delivers `rawUrl` through the router's `handle` (D8) and counts the acceptances. */
function deliver(real: Real, rawUrl: string, times: number): number {
  let accepted = 0
  for (let index = 0; index < times; index += 1) {
    const before = real.windowRequests
    real.router.handle(rawUrl)
    if (real.windowRequests > before) accepted += 1
  }
  return accepted
}

/** The pre-match (D9): the deadline applied, then the state matched against a waiting attempt. */
function preMatch(m: Model, choice: StateChoice): boolean {
  checkDeadline(m)
  return choice === 'current' && m.attempt?.phase === 'waiting'
}

/** The acceptance op, run inside the owner (D7, D9, D11, D17). Returns the redeem it began. */
function acceptanceOp(m: Model, link: AcceptedLink, attemptId: number): number | null {
  checkDeadline(m)
  const attempt = m.attempt
  if (!attempt || attempt.id !== attemptId || attempt.phase !== 'waiting') return null
  if (link.kind === 'error') {
    endAttempt(m, link.end ?? { outcome: 'failed' })
    return null
  }
  if (link.envChoice === 'other') {
    endAttempt(m, { outcome: 'failed', reason: 'different_environment' })
    return null
  }
  attempt.phase = 'redeeming'
  m.snapshot = { attemptId, phase: 'redeeming' }
  m.count += 1
  m.redeemFetches += 1
  return attemptId
}

function pushAccepted(real: Real, link: AcceptedLink, times: number): void {
  const seq = currentSeq(real.harness) + 0.5
  for (let index = 0; index < times; index += 1) real.accepted.push({ ...link, seq })
  real.stats.acceptedLinks += times
}

const startCommand = new ModelCommand(
  'Start',
  'Start',
  // At most one start queues behind a held owner op, so the opens keep the attempts' order.
  m => free(m) || !m.queue.some(item => item.kind === 'start'),
  async (m, real) => {
    const tracked = startTracking(real, real.harness.service.startBrowserSignIn())
    if (blocked(m)) {
      m.queue.push({ kind: 'start', tracked })
      await drain(real, m)
      expectSettled('Start (queued)', tracked, { settles: 'pending' })
      return
    }
    await drain(real, m)
    const refusal = startOp1(m)
    if (refusal)
      return expectSettled('Start', tracked, {
        settles: 'rejects',
        code: new RegExp(`^${refusal}$`),
      })
    const result = startOp2(m, m.bumps, m.env, 'password-and-oidc')
    expectSettled(
      'Start',
      tracked,
      'refused' in result
        ? { settles: 'rejects', code: new RegExp(`^${result.refused}$`) }
        : { settles: 'resolves', value: { attemptId: result.attemptId } }
    )
  }
)

const cancelCommand = new ModelCommand(
  'Cancel',
  'Cancel',
  () => true,
  async (m, real) => {
    const answer = real.harness.service.cancelBrowserSignIn()
    const attempt = m.attempt
    if (attempt?.phase === 'waiting') {
      endAttempt(m, { outcome: 'cancelled' })
      real.cancelled.add(attempt.id)
    }
    expect(answer, 'Cancel').toEqual(m.snapshot)
    await drain(real, m)
  }
)

const readCommand = new ModelCommand(
  'Read',
  'Read',
  () => true,
  async (m, real) => {
    const answer = real.harness.service.getBrowserSignInState()
    checkDeadline(m)
    expect(answer, 'Read').toEqual(m.snapshot)
    await drain(real, m)
  }
)

function ackCommand(choice: 'current' | 'older') {
  return new ModelCommand(
    `Ack(${choice})`,
    'other',
    m => m.lastId >= (choice === 'current' ? 1 : 2),
    async (m, real) => {
      const id = choice === 'current' ? m.lastId : m.lastId - 1
      const answer = real.harness.service.acknowledgeBrowserSignInResult(id)
      // D12, D13: an acknowledgement applies no deadline; only `ended(id)` becomes `idle(id)`.
      if (m.snapshot.phase === 'ended' && m.snapshot.attemptId === id) {
        m.snapshot = { attemptId: id, phase: 'idle' }
      }
      expect(answer, `Ack(${choice})`).toEqual(m.snapshot)
      await drain(real, m)
    }
  )
}

function advanceClockCommand(ms: number, via: ClockVia) {
  return new ModelCommand(
    `AdvanceClock(${ms}, ${via})`,
    'AdvanceClock',
    () => via !== 'timers' || ms >= 0,
    async (m, real) => {
      const { clock, service } = real.harness
      clock.advance(ms, via === 'timers' ? 'timers' : 'wallOnly')
      vi.setSystemTime(clock.now())
      m.nowMs += ms
      expect(clock.now(), 'the clock and the model').toBe(m.nowMs)
      if (via === 'timers') {
        m.timerMs += ms
        const attempt = m.attempt
        if (attempt?.phase === 'waiting' && m.timerMs >= attempt.timerDueMs) {
          endAttempt(m, { outcome: 'timed_out' })
        }
      }
      if (via === 'resume') {
        service.checkBrowserSignInDeadline()
        checkDeadline(m)
      }
      if (via === 'read') {
        const answer = service.getBrowserSignInState()
        checkDeadline(m)
        expect(answer, 'AdvanceClock(read)').toEqual(m.snapshot)
      }
      await drain(real, m)
    }
  )
}

function deliverCodeCommand(
  stateChoice: StateChoice,
  envChoice: EnvChoice,
  twice: boolean,
  code: string,
  randomState: string,
  answer: RedeemAnswer
) {
  return new ModelCommand(
    `DeliverCode(${stateChoice}, ${envChoice}${twice ? ', twice' : ''}, ${answer})`,
    'DeliverCode',
    () => true,
    async (m, real) => {
      real.generated.add(code)
      real.redeemAnswerByCode.set(code, answer)
      const state = attemptState(real, m, stateChoice, randomState)
      const env = m.envOf.get(m.lastId) ?? m.env
      const link: AcceptedLink = {
        kind: 'code',
        state,
        environment: linkEnvironment(real, env, envChoice),
        envChoice,
        code,
        end: null,
      }
      const times = twice ? 2 : 1
      const matched = preMatch(m, stateChoice)
      const accepted = deliver(real, codeLink(state, link.environment, code), times)
      // Only a matched link is accepted, and raises the window (A3-33).
      expect(accepted, 'DeliverCode: accepted at the pre-match').toBe(matched ? times : 0)
      if (accepted > 0) pushAccepted(real, link, accepted)
      if (matched && blocked(m)) {
        for (let index = 0; index < times; index += 1) m.queue.push({ kind: 'link', link })
        await drain(real, m)
        return true
      }
      await drain(real, m)
      // A dropped link does nothing at its gap: the witness does not count it.
      if (!matched) return false
      const attemptId = m.lastId
      const redeeming = acceptanceOp(m, link, attemptId)
      // The second delivery's op finds the attempt no longer waiting.
      if (twice) acceptanceOp(m, link, attemptId)
      if (redeeming !== null) installOp(m, redeeming, answer)
      return true
    }
  )
}

function deliverErrorCommand(kind: ErrorKind, stateChoice: StateChoice, randomState: string) {
  return new ModelCommand(
    `DeliverError(${kind}, ${stateChoice})`,
    'other',
    () => true,
    async (m, real) => {
      const state = attemptState(real, m, stateChoice, randomState)
      const link: AcceptedLink = {
        kind: 'error',
        state,
        environment: '',
        envChoice: 'same',
        code: null,
        end: errorLinkEnd(kind),
      }
      const raw = buildDesktopLoginErrorLink(
        kind === 'refused'
          ? { state, error: 'refused', reason: 'account_disabled' }
          : { state, error: kind }
      )
      const matched = preMatch(m, stateChoice)
      const accepted = deliver(real, raw, 1)
      expect(accepted, 'DeliverError: accepted at the pre-match').toBe(matched ? 1 : 0)
      if (accepted > 0) pushAccepted(real, link, 1)
      if (matched && blocked(m)) {
        m.queue.push({ kind: 'link', link })
        await drain(real, m)
        return
      }
      await drain(real, m)
      if (matched) acceptanceOp(m, link, m.lastId)
    }
  )
}

function deliverLaunchLinkCommand(randomState: string, code: string) {
  return new ModelCommand(
    'DeliverLaunchLink',
    'other',
    () => true,
    async (m, real) => {
      real.generated.add(code)
      const state = attemptState(real, m, 'current', randomState)
      const before = real.windowRequests
      const fetches = real.harness.fetches.length
      // A desktop-login link is never queued (D8, A3-31): the launch queue drops it.
      real.router.enqueuePending(codeLink(state, restOf(real, m.env), code))
      real.router.drainPending()
      await drain(real, m)
      expect(real.windowRequests, 'DeliverLaunchLink: no window').toBe(before)
      expect(real.harness.fetches, 'DeliverLaunchLink: no fetch').toHaveLength(fetches)
    }
  )
}

type BumpKind =
  | { kind: 'password'; ok: boolean }
  | { kind: 'google'; ok: boolean }
  | { kind: 'logout'; viaLink: boolean }
  | { kind: 'select'; target: Env }
  | { kind: 'handoff'; target: Env }
  | { kind: 'setup' }
  | { kind: 'restore' }
  | { kind: 'switchTeam' }

function bumpLabel(event: BumpKind): string {
  switch (event.kind) {
    case 'password':
    case 'google':
      return `Bump(${event.kind}, ${event.ok ? 'ok' : 'refused'})`
    case 'logout':
      return `Bump(logout${event.viaLink ? ', evenfire://logout' : ''})`
    case 'select':
    case 'handoff':
      return `Bump(${event.kind} ${event.target})`
    default:
      return `Bump(${event.kind})`
  }
}

/** Which bumps may queue behind a held owner op: those whose op 1 the model knows (N-1). */
function bumpQueues(event: BumpKind): boolean {
  if (event.kind === 'password' || event.kind === 'setup') return true
  if (event.kind === 'logout') return !event.viaLink
  if (event.kind === 'select' || event.kind === 'handoff') return event.target !== 'C'
  return false
}

function bumpAllowed(event: BumpKind, m: Readonly<Model>): boolean {
  if (blocked(m) && !bumpQueues(event)) return false
  switch (event.kind) {
    case 'select':
      return m.exists[event.target]
    case 'handoff':
      return m.exists[event.target]
    case 'switchTeam':
      return m.session !== null
    default:
      return true
  }
}

function settingUp(m: Model): string | null {
  if (m.count > 0) return 'auth_transition_in_progress'
  if (m.session !== null) return 'desktop_setup_requires_signout'
  return null
}

function selectEffect(m: Model, target: Env): void {
  if (target === m.env) {
    bump(m)
    bump(m)
    return
  }
  signOutWithTwoBumps(m)
  m.env = target
}

function issueBump(real: Real, event: BumpKind): Tracked<unknown> | null {
  const { service, envs } = real.harness
  switch (event.kind) {
    case 'password':
      return startTracking(
        real,
        service.passwordLogin(
          event.ok ? 'user-b@example.test' : REFUSED_PASSWORD_EMAIL,
          'fake-password'
        )
      )
    case 'google':
      return startTracking(
        real,
        service.googleLogin(event.ok ? 'fake-google-id-token' : REFUSED_GOOGLE_TOKEN)
      )
    case 'logout':
      if (event.viaLink) {
        // E20: `evenfire://logout` reaches the same `AppService.logout()` (`main.ts:120-123`).
        real.router.handle('evenfire://logout')
        return null
      }
      return startTracking(real, service.logout())
    case 'select':
      return startTracking(real, service.selectRuntimeConfig(envs[event.target].optionId))
    case 'handoff':
      return startTracking(
        real,
        service.selectRuntimeConfigForHandoff(
          envs[event.target].optionId,
          service.getSessionGeneration()
        )
      )
    case 'setup':
      return startTracking(real, completeSetup(real.harness))
    case 'restore':
      return startTracking(real, service.getSessionState())
    case 'switchTeam':
      return startTracking(real, service.switchTeam('team-switched'))
  }
}

function bumpCommand(event: BumpKind) {
  return new ModelCommand(
    bumpLabel(event),
    'Bump',
    m => bumpAllowed(event, m),
    async (m, real) => {
      const waitingWithNoLogin = m.attempt?.phase === 'waiting' && m.count === 0
      const signedOutWithNoLogin = m.session === null && m.count === 0
      const bumpsAtIssue = m.bumps
      const tracked = issueBump(real, event)
      if (blocked(m)) {
        if (!tracked) throw new Error('model: a queued bump must be tracked')
        if (event.kind === 'password') m.queue.push({ kind: 'password', ok: event.ok, tracked })
        else if (event.kind === 'setup') m.queue.push({ kind: 'setup', tracked })
        else if (event.kind === 'logout') m.queue.push({ kind: 'logout', tracked })
        else if (event.kind === 'select')
          m.queue.push({ kind: 'select', target: event.target, tracked })
        else if (event.kind === 'handoff') {
          m.queue.push({ kind: 'handoff', target: event.target, bumpsAtIssue, tracked })
        }
        await drain(real, m)
        expectSettled(`${bumpLabel(event)} (queued)`, tracked, { settles: 'pending' })
        return
      }
      await drain(real, m)
      let expected: Expected = SESSION_RESOLVES
      switch (event.kind) {
        case 'password':
        case 'google': {
          bump(m)
          if (event.ok) {
            signIn(m, event.kind)
            expected = { settles: 'resolves', value: { authenticated: true } }
          } else {
            expected = {
              settles: 'rejects',
              code: event.kind === 'password' ? /httpStatus=401$/ : /^401 Unauthorized/,
            }
          }
          break
        }
        case 'logout':
          signOutWithTwoBumps(m)
          break
        case 'select':
          selectEffect(m, event.target)
          break
        case 'handoff':
        case 'setup': {
          const refusal = settingUp(m)
          if (refusal) {
            expected = { settles: 'rejects', code: new RegExp(`^${refusal}$`) }
          } else if (event.kind === 'handoff') {
            selectEffect(m, event.target)
          } else {
            bump(m)
            expected = { settles: 'rejects', code: /^desktop_setup_not_found$/ }
          }
          break
        }
        case 'restore':
          expected = modelGetSessionState(m)
          break
        case 'switchTeam':
          bump(m)
          m.stored = m.session
          break
      }
      if (tracked) expectSettled(bumpLabel(event), tracked, expected)
      if (event.kind === 'setup' || event.kind === 'handoff') {
        // L3: a waiting attempt does not refuse setup or the handoff; their bump replaces it. L5:
        // signed out with no login in flight, nothing counts.
        if (waitingWithNoLogin || signedOutWithNoLogin) {
          expect(tracked?.result, `L3/L5: ${bumpLabel(event)}`).not.toEqual({
            ok: false,
            code: 'auth_transition_in_progress',
          })
        }
      }
    }
  )
}

type NoBumpKind = 'getLoginMethods' | 'getDependenciesHealth' | 'saveSame' | `delete ${Env}`

function noBumpCommand(kind: NoBumpKind) {
  const target = kind.startsWith('delete ') ? (kind.slice(-1) as Env) : null
  return new ModelCommand(
    `NoBump(${kind})`,
    'other',
    m => free(m) && (target === null || (m.exists[target] && m.env !== target)),
    async (m, real) => {
      const { service } = real.harness
      const bumpsBefore = real.harness.bumpLog.length
      let tracked: Tracked<unknown>
      if (kind === 'getLoginMethods') tracked = startTracking(real, service.getLoginMethods())
      else if (kind === 'getDependenciesHealth')
        tracked = startTracking(real, service.getDependenciesHealth())
      else if (kind === 'saveSame') {
        const current = service.getRuntimeConfigState().currentConfig
        if (!current) throw new Error('model: no active configuration to save')
        tracked = startTracking(real, service.saveRuntimeConfig({ ...current }))
      } else
        tracked = startTracking(
          real,
          service.deleteRuntimeConfig(real.harness.envs[target ?? 'B'].optionId)
        )
      await drain(real, m)
      if (kind === 'getLoginMethods') m.methodsFetches += 1
      if (target) m.exists[target] = false
      expectSettled(
        `NoBump(${kind})`,
        tracked,
        kind === 'getLoginMethods'
          ? { settles: 'resolves', value: { model: { kind: 'methods', password: true } } }
          : { settles: 'resolves' }
      )
      expect(real.harness.bumpLog, `NoBump(${kind}) advances nothing`).toHaveLength(bumpsBefore)
    }
  )
}

type EnterPoint = 'methods' | 'open' | 'redeem' | OwnerHold

/** A start may run to its end: signed out, nothing redeeming, nothing held. */
function canStart(m: Readonly<Model>): boolean {
  return (
    free(m) &&
    m.start === null &&
    m.redeem === null &&
    m.session === null &&
    m.attempt?.phase !== 'redeeming'
  )
}

/** A waiting attempt that no check would end now. */
function waitingInTime(m: Readonly<Model>): boolean {
  const attempt = m.attempt
  return (
    attempt?.phase === 'waiting' && m.nowMs < attempt.deadlineMs && m.timerMs < attempt.timerDueMs
  )
}

function canEnterRedeem(m: Readonly<Model>): boolean {
  return free(m) && m.redeem === null && (waitingInTime(m) || canStart(m))
}

function enterAllowed(point: EnterPoint, m: Readonly<Model>): boolean {
  if (blocked(m)) return false
  const attempt = m.attempt
  switch (point) {
    case 'methods':
    case 'open':
      return m.start === null && m.session === null && attempt?.phase !== 'redeeming'
    case 'redeem':
      return canEnterRedeem(m)
    case 'restoreTokenRead':
    case 'restoreChatBind':
      return (
        m.start === null &&
        m.redeem === null &&
        m.session === null &&
        m.count === 0 &&
        m.env !== 'C' &&
        !restoreGated(m) &&
        (point === 'restoreTokenRead' || m.stored === 'kept')
      )
    case 'installChatBind':
    case 'installTokenWrite':
      if (m.env === 'C') return false
      if (m.redeem !== null) {
        return attempt?.phase === 'redeeming' && !attempt.bumpedWhileRedeeming
      }
      return canEnterRedeem(m)
  }
}

/** A start run to its end with nothing held: the same call and model steps as `Start`. */
async function plainStart(m: Model, real: Real): Promise<void> {
  const tracked = startTracking(real, real.harness.service.startBrowserSignIn())
  await drain(real, m)
  if (startOp1(m)) throw new Error('model: a plain start passed its check but op 1 refuses')
  const result = startOp2(m, m.bumps, m.env, 'password-and-oidc')
  if (!('attemptId' in result)) throw new Error('model: a plain start recorded no attempt')
  expectSettled('Start (before a hold)', tracked, {
    settles: 'resolves',
    value: { attemptId: result.attemptId },
  })
}

/** Hold(redeem) and the waiting attempt's own code link, which reaches it (Γ6). */
async function enterRedeem(m: Model, real: Real): Promise<void> {
  if (!waitingInTime(m)) await plainStart(m, real)
  const hold = makeHold(real, 'redeem')
  const attemptId = m.lastId
  const state = stateOfAttempt(real, attemptId) ?? ''
  const code = `fake${String(attemptId).padStart(39, '0')}`
  real.generated.add(code)
  const link: AcceptedLink = {
    kind: 'code',
    state,
    environment: restOf(real, m.envOf.get(attemptId) ?? m.env),
    envChoice: 'same',
    code,
    end: null,
  }
  expect(deliver(real, codeLink(state, link.environment, code), 1)).toBe(1)
  pushAccepted(real, link, 1)
  await drain(real, m)
  checkDeadline(m)
  if (acceptanceOp(m, link, attemptId) === null) {
    throw new Error('model: Hold(redeem) did not begin a redeem')
  }
  m.redeem = { attemptId }
  expectReached('Hold(redeem)', hold)
}

/**
 * Hold(point) with the call that reaches it, so no other caller takes the hold (N-5). A hold
 * that needs an earlier gap enters it first with the same calls: a start for the redeem, the
 * held redeem for the install's holds (Γ8), and a waiting attempt for the restore's bind (Γ5).
 */
function enterCommand(point: EnterPoint) {
  return new ModelCommand(
    `Hold(${point})`,
    'other',
    m => enterAllowed(point, m),
    async (m, real) => {
      const { service } = real.harness
      switch (point) {
        case 'methods':
        case 'open': {
          const hold = makeHold(real, point)
          real.pendingStart = startTracking(real, service.startBrowserSignIn())
          await drain(real, m)
          if (startOp1(m)) throw new Error('model: Hold(start) passed its check but op 1 refuses')
          const bumpsAtOp1 = m.bumps
          let attemptId: number | null = null
          if (point === 'open') {
            const result = startOp2(m, bumpsAtOp1, m.env, 'password-and-oidc')
            if (!('attemptId' in result)) throw new Error('model: Hold(open) found no attempt')
            attemptId = result.attemptId
          }
          m.start = { stage: point, bumpsAtOp1, env: m.env, attemptId }
          expectReached(`Hold(${point})`, hold)
          return
        }
        case 'redeem':
          return enterRedeem(m, real)
        case 'restoreTokenRead':
        case 'restoreChatBind': {
          if (point === 'restoreChatBind' && canStart(m) && m.attempt?.phase !== 'waiting') {
            await plainStart(m, real)
          }
          const hold = makeHold(real, point)
          real.pendingRestore = startTracking(real, service.getSessionState())
          m.gate = { env: m.env, atMs: m.nowMs }
          m.ownerHold = point
          await drain(real, m)
          expectReached(`Hold(${point})`, hold)
          return
        }
        case 'installChatBind':
        case 'installTokenWrite': {
          if (m.redeem === null) await enterRedeem(m, real)
          const hold = makeHold(real, point)
          // The redeem answers 200; the install op's own bump and the session come first
          // (`installAuthenticatedLogin`), then the held bind or token write.
          heldAt(real, 'redeem').release(
            edgeResponse(readEdgeRecord(REDEEM_RECORD_KEYS['signed-in']))
          )
          m.redeem = null
          m.bumps += 1
          m.session = 'browser'
          m.ownerHold = point
          await drain(real, m)
          expectReached(`Hold(${point})`, hold)
          return
        }
      }
    }
  )
}

function releaseMethodsCommand(answer: MethodsAnswer) {
  return new ModelCommand(
    `Release(methods, ${answer})`,
    'other',
    m => free(m) && m.start?.stage === 'methods',
    async (m, real) => {
      const start = m.start
      if (!start) throw new Error('model: no start at its methods read')
      const tracked = real.pendingStart
      real.pendingStart = null
      heldAt(real, 'methods').release(edgeResponse(readEdgeRecord(METHODS_RECORD_KEYS[answer])))
      await drain(real, m)
      m.start = null
      const result = startOp2(m, start.bumpsAtOp1, start.env, answer)
      expectSettled(
        `Release(methods, ${answer})`,
        tracked,
        'refused' in result
          ? { settles: 'rejects', code: new RegExp(`^${result.refused}$`) }
          : { settles: 'resolves', value: { attemptId: result.attemptId } }
      )
    }
  )
}

function releaseOpenCommand(ok: boolean) {
  return new ModelCommand(
    `Release(open, ${ok ? 'opened' : 'failed'})`,
    'other',
    m => free(m) && m.start?.stage === 'open',
    async (m, real) => {
      const start = m.start
      if (!start) throw new Error('model: no start at its browser open')
      const tracked = real.pendingStart
      real.pendingStart = null
      heldAt(real, 'open').release(ok ? undefined : new Error('fake browser open failure'))
      await drain(real, m)
      m.start = null
      if (!ok && m.attempt?.id === start.attemptId && m.attempt.phase === 'waiting') {
        // A3-66: only a still-waiting attempt, by its id, ends `failed`.
        endAttempt(m, { outcome: 'failed' })
      }
      expectSettled(
        'Release(open)',
        tracked,
        ok
          ? { settles: 'resolves', value: { attemptId: start.attemptId } }
          : { settles: 'rejects', code: /^browser_open_failed$/ }
      )
    }
  )
}

function releaseRedeemCommand(answer: RedeemAnswer) {
  return new ModelCommand(
    `Release(redeem, ${answer})`,
    'other',
    m => free(m) && m.redeem !== null,
    async (m, real) => {
      const redeem = m.redeem
      if (!redeem) throw new Error('model: no held redeem')
      heldAt(real, 'redeem').release(edgeResponse(readEdgeRecord(REDEEM_RECORD_KEYS[answer])))
      await drain(real, m)
      m.redeem = null
      installOp(m, redeem.attemptId, answer)
    }
  )
}

type Remaining =
  | { kind: 'start'; bumpsAtOp1: number; env: Env; tracked: Tracked<unknown> }
  | { kind: 'password'; ok: boolean; bumpsAtOp1: number; tracked: Tracked<unknown> }
  | { kind: 'setup'; bumpsAtOp1: number; tracked: Tracked<unknown> }
  | { kind: 'redeem'; attemptId: number; answer: RedeemAnswer }
  | { kind: 'restore' }

/**
 * Release(owner hold): the held op completes, then the op 1s queued behind it run in FIFO order
 * (deterministic: N-1). After them, a single command with work left runs alone. With two or more,
 * the scheduler picks the order of their outside awaits: their results are checked against their
 * allowed sets, and the model takes the outcome it observes.
 */
const releaseOwnerCommand = new ModelCommand(
  'Release(owner)',
  'other',
  m => blocked(m),
  async (m, real) => {
    const point = m.ownerHold
    if (!point) throw new Error('model: no held owner op')
    const queued = m.queue.splice(0)
    const readsBefore = real.harness.tokenReads.length
    const restoreTracked = real.pendingRestore
    real.pendingRestore = null
    heldAt(real, point).release()
    m.ownerHold = null
    await drain(real, m)

    const settled: Array<[string, Tracked<unknown> | null, Expected]> = []
    const remaining: Remaining[] = []
    let restoreAfterRead: number | null = null
    let installSettles = false
    switch (point) {
      case 'restoreTokenRead':
        restoreAfterRead = m.bumps
        break
      case 'restoreChatBind':
        // The commit op sets the principal, then its bump (`restoreSavedSessionOnce`).
        bump(m)
        m.session = 'kept'
        settled.push([
          'the restore',
          restoreTracked,
          { settles: 'resolves', value: { authenticated: true } },
        ])
        break
      case 'installChatBind':
      case 'installTokenWrite':
        m.stored = 'browser'
        if (m.attempt?.phase === 'redeeming') endAttempt(m, { outcome: 'signed_in' })
        installSettles = true
        break
    }
    for (const item of queued) {
      switch (item.kind) {
        case 'start': {
          const refusal = startOp1(m)
          if (refusal)
            settled.push([
              'queued Start',
              item.tracked,
              { settles: 'rejects', code: new RegExp(`^${refusal}$`) },
            ])
          else
            remaining.push({
              kind: 'start',
              bumpsAtOp1: m.bumps,
              env: m.env,
              tracked: item.tracked,
            })
          break
        }
        case 'password':
          bump(m)
          m.count += 1
          remaining.push({
            kind: 'password',
            ok: item.ok,
            bumpsAtOp1: m.bumps,
            tracked: item.tracked,
          })
          break
        case 'setup': {
          const refusal = settingUp(m)
          if (refusal)
            settled.push([
              'queued setup',
              item.tracked,
              { settles: 'rejects', code: new RegExp(`^${refusal}$`) },
            ])
          else {
            bump(m)
            remaining.push({ kind: 'setup', bumpsAtOp1: m.bumps, tracked: item.tracked })
          }
          break
        }
        case 'logout':
          signOutWithTwoBumps(m)
          settled.push(['queued logout', item.tracked, SESSION_RESOLVES])
          break
        case 'select':
          selectEffect(m, item.target)
          settled.push(['queued select', item.tracked, SESSION_RESOLVES])
          break
        case 'handoff': {
          const refusal = m.bumps !== item.bumpsAtIssue ? 'stale_session_generation' : settingUp(m)
          if (refusal)
            settled.push([
              'queued handoff',
              item.tracked,
              { settles: 'rejects', code: new RegExp(`^${refusal}$`) },
            ])
          else {
            selectEffect(m, item.target)
            settled.push(['queued handoff', item.tracked, SESSION_RESOLVES])
          }
          break
        }
        case 'link': {
          const attemptId = m.lastId
          const began = acceptanceOp(m, item.link, attemptId)
          if (began !== null) {
            const answer = real.redeemAnswerByCode.get(item.link.code ?? '') ?? 'signed-in'
            remaining.push({ kind: 'redeem', attemptId: began, answer })
          }
          break
        }
      }
    }
    // The install's settle op was queued behind those op 1s (N-1).
    if (installSettles) m.count -= 1
    let restoreOwns = false
    if (restoreAfterRead !== null) {
      restoreOwns = m.bumps === restoreAfterRead && m.count === 0 && m.stored !== null
      if (restoreOwns) remaining.push({ kind: 'restore' })
    }

    if (remaining.length <= 1) {
      for (const work of remaining) {
        switch (work.kind) {
          case 'start': {
            const result = startOp2(m, work.bumpsAtOp1, work.env, 'password-and-oidc')
            settled.push([
              'queued Start',
              work.tracked,
              'refused' in result
                ? { settles: 'rejects', code: new RegExp(`^${result.refused}$`) }
                : { settles: 'resolves', value: { attemptId: result.attemptId } },
            ])
            break
          }
          case 'password':
            if (m.bumps !== work.bumpsAtOp1) {
              settled.push(['queued password', work.tracked, { settles: 'rejects', code: STALE }])
            } else if (work.ok) {
              signIn(m, 'password')
              settled.push([
                'queued password',
                work.tracked,
                { settles: 'resolves', value: { authenticated: true } },
              ])
            } else {
              settled.push([
                'queued password',
                work.tracked,
                { settles: 'rejects', code: /httpStatus=401$/ },
              ])
            }
            m.count -= 1
            break
          case 'setup':
            settled.push([
              'queued setup',
              work.tracked,
              m.bumps !== work.bumpsAtOp1
                ? { settles: 'rejects', code: STALE }
                : { settles: 'rejects', code: /^desktop_setup_not_found$/ },
            ])
            break
          case 'redeem':
            installOp(m, work.attemptId, work.answer)
            break
          case 'restore':
            bump(m)
            m.session = m.stored
            break
        }
      }
      if (restoreAfterRead !== null) {
        // A restore that no longer owns the session reads it at its own op: alone, that is now;
        // beside another command's work, either side of it.
        const owned = remaining.some(work => work.kind === 'restore')
        settled.push([
          'the restore',
          restoreTracked,
          owned || remaining.length === 0 ? sessionExpected(m) : SESSION_RESOLVES,
        ])
      }
      for (const [label, tracked, expected] of settled) expectSettled(label, tracked, expected)
      return
    }

    // Two or more commands with outside awaits left: the scheduler orders them.
    for (const [label, tracked, expected] of settled) expectSettled(label, tracked, expected)
    for (const work of remaining) {
      if (work.kind === 'start') {
        expectSettled('queued Start (either)', work.tracked, {
          settles: 'either',
          allowed: [{ settles: 'resolves' }, { settles: 'rejects', code: STALE }],
        })
      } else if (work.kind === 'password') {
        expectSettled('queued password (either)', work.tracked, {
          settles: 'either',
          allowed: [
            work.ok
              ? { settles: 'resolves', value: { authenticated: true } }
              : { settles: 'rejects', code: /httpStatus=401$/ },
            { settles: 'rejects', code: STALE },
          ],
        })
      } else if (work.kind === 'setup') {
        expectSettled('queued setup (either)', work.tracked, {
          settles: 'either',
          allowed: [
            { settles: 'rejects', code: /^desktop_setup_not_found$/ },
            { settles: 'rejects', code: STALE },
          ],
        })
      } else if (work.kind === 'redeem') {
        // Its install op ends it with the answer's end, or `replaced` when a bump from the
        // other commands' work came first (D2).
        const answerEnd = work.answer === 'signed-in' ? 'signed_in' : redeemEnd(work.answer).outcome
        expect(
          [[answerEnd], ['replaced']],
          `queued redeem of attempt ${work.attemptId} (either)`
        ).toContainEqual(endStatesOf(real.harness, work.attemptId))
      }
    }
    if (restoreAfterRead !== null)
      expectSettled('the restore (either)', restoreTracked, SESSION_RESOLVES)
    resyncFromObservation(real, m, readsBefore)
  }
)

/**
 * Release(point, answer) for one of the points held now, picked by `choice`: the owner op when it
 * is held (nothing else can run then), else the redeem, the methods read or the browser open.
 * Generated this way, a release always has something to release.
 */
function releaseAnyCommand(
  choice: number,
  methods: MethodsAnswer,
  opened: boolean,
  redeem: RedeemAnswer
) {
  const held = (m: Readonly<Model>): ModelCommand[] => {
    if (blocked(m)) return [releaseOwnerCommand]
    const commands: ModelCommand[] = []
    if (m.redeem !== null) commands.push(releaseRedeemCommand(redeem))
    if (m.start?.stage === 'methods') commands.push(releaseMethodsCommand(methods))
    if (m.start?.stage === 'open') commands.push(releaseOpenCommand(opened))
    return commands
  }
  return new ModelCommand(
    `Release(any #${choice}: methods ${methods}, open ${opened ? 'opened' : 'failed'}, redeem ${redeem})`,
    'other',
    m => held(m).length > 0,
    async (m, real) => {
      const options = held(m)
      const picked = options[choice % options.length]
      if (!picked) throw new Error('model: Release(any) found nothing held')
      return picked.runBody(m, real)
    }
  )
}

function bootCommand(kind: 'ReplaceRenderer' | 'Activate') {
  return new ModelCommand(
    kind,
    kind === 'ReplaceRenderer' ? 'ReplaceRenderer' : 'other',
    m => free(m) && (kind === 'ReplaceRenderer' ? m.windowOpen : !m.windowOpen),
    async (m, real) => {
      const { service } = real.harness
      m.windowOpen = true
      // The boot subscribes, reads the state, then the session (§7.2, D13).
      const read = service.getBrowserSignInState()
      checkDeadline(m)
      expect(read, `${kind}: the boot read`).toEqual(m.snapshot)
      const session = startTracking(real, service.getSessionState())
      await drain(real, m)
      expectSettled(`${kind}: the boot session`, session, modelGetSessionState(m))
      if (read.phase === 'ended') {
        // The renderer acknowledges the outcome it has shown.
        const answer = service.acknowledgeBrowserSignInResult(read.attemptId)
        if (m.snapshot.phase === 'ended' && m.snapshot.attemptId === read.attemptId) {
          m.snapshot = { attemptId: read.attemptId, phase: 'idle' }
        }
        expect(answer, `${kind}: the acknowledgement`).toEqual(m.snapshot)
        await drain(real, m)
      }
    }
  )
}

const closeWindowCommand = new ModelCommand(
  'CloseWindow',
  'other',
  m => m.windowOpen,
  async m => {
    // Main keeps pushing; with no window nothing takes the pushes (D13). Main's state is
    // unchanged, which is what this oracle reads.
    m.windowOpen = false
  }
)

const settleCommand = new ModelCommand(
  'Settle',
  'other',
  m => isQuiescent(m),
  async (m, real) => {
    await drain(real, m)
    checkQuiescent(real, m)
  }
)

const SECRET_ARB = fc.stringMatching(/^[A-Za-z0-9_-]{43}$/)
/** A kept token in three runs of four: the restore that Γ5 holds needs one. */
const KEPT_TOKEN_ARB = fc.constantFrom(true, true, true, false)
const ENV_ARB = fc.constantFrom<Env>('A', 'B', 'C')

/** The generated commands, weighted so the runs enter every gap of the witness. */
function commandArbitrary(): fc.Arbitrary<fc.AsyncCommand<Model, Real>> {
  const bumpKinds: fc.Arbitrary<BumpKind> = fc.oneof(
    fc.boolean().map(ok => ({ kind: 'password' as const, ok })),
    fc.boolean().map(ok => ({ kind: 'google' as const, ok })),
    fc.boolean().map(viaLink => ({ kind: 'logout' as const, viaLink })),
    ENV_ARB.map(target => ({ kind: 'select' as const, target })),
    ENV_ARB.map(target => ({ kind: 'handoff' as const, target })),
    fc.constant({ kind: 'setup' as const }),
    fc.constant({ kind: 'restore' as const }),
    fc.constant({ kind: 'switchTeam' as const })
  )
  const noBumpKinds = fc.constantFrom<NoBumpKind>(
    'getLoginMethods',
    'getDependenciesHealth',
    'saveSame',
    'delete B',
    'delete C'
  )
  // Weighted toward the gaps that need a waiting attempt first (Γ6, then Γ8) or a kept token.
  const enterPoints = fc.constantFrom<EnterPoint>(
    'methods',
    'methods',
    'methods',
    'open',
    'open',
    'open',
    'redeem',
    'redeem',
    'redeem',
    'restoreTokenRead',
    'restoreChatBind',
    'restoreChatBind',
    'restoreChatBind',
    'restoreChatBind',
    'installChatBind',
    'installChatBind',
    'installTokenWrite',
    'installTokenWrite'
  )
  const redeemAnswers = fc.constantFrom<RedeemAnswer>(
    'signed-in',
    'signed-in',
    'invalid',
    'refused-account-disabled',
    'unavailable',
    'rate-limited',
    'issuance-unavailable'
  )
  const releases = fc
    .tuple(
      fc.nat(),
      fc.constantFrom<MethodsAnswer>(
        'password-and-oidc',
        'password-and-oidc',
        'password-only',
        'unavailable'
      ),
      fc.boolean(),
      redeemAnswers
    )
    .map(([choice, methods, opened, redeem]) => releaseAnyCommand(choice, methods, opened, redeem))
  return fc.oneof(
    { weight: 5, arbitrary: fc.constant(startCommand) },
    { weight: 2, arbitrary: fc.constant(cancelCommand) },
    { weight: 2, arbitrary: fc.constant(readCommand) },
    {
      weight: 1,
      arbitrary: fc.constantFrom<'current' | 'older'>('current', 'older').map(ackCommand),
    },
    {
      weight: 2,
      arbitrary: fc
        .tuple(
          fc.constantFrom(1_000, 6_000, 14 * 60_000, 16 * 60_000, -60_000),
          fc.constantFrom<ClockVia>('wallOnly', 'timers', 'resume', 'read')
        )
        .map(([ms, via]) => advanceClockCommand(ms, via)),
    },
    {
      weight: 6,
      arbitrary: fc
        .tuple(
          fc.constantFrom<StateChoice>(
            'current',
            'current',
            'current',
            'current',
            'previous',
            'random'
          ),
          fc.constantFrom<EnvChoice>('same', 'same', 'variant', 'other'),
          fc.boolean(),
          SECRET_ARB,
          SECRET_ARB,
          redeemAnswers
        )
        .map(([state, env, twice, code, random, answer]) =>
          deliverCodeCommand(state, env, twice, code, random, answer)
        ),
    },
    {
      weight: 1,
      arbitrary: fc
        .tuple(
          fc.constantFrom<ErrorKind>('refused', 'cancelled', 'unavailable', 'failed'),
          fc.constantFrom<StateChoice>('current', 'random'),
          SECRET_ARB
        )
        .map(([kind, state, random]) => deliverErrorCommand(kind, state, random)),
    },
    {
      weight: 1,
      arbitrary: fc
        .tuple(SECRET_ARB, SECRET_ARB)
        .map(([random, code]) => deliverLaunchLinkCommand(random, code)),
    },
    { weight: 5, arbitrary: bumpKinds.map(bumpCommand) },
    { weight: 1, arbitrary: noBumpKinds.map(noBumpCommand) },
    { weight: 10, arbitrary: enterPoints.map(enterCommand) },
    // A held owner op blocks most commands; released often, the run moves on to other gaps.
    { weight: 5, arbitrary: releases },
    {
      weight: 2,
      arbitrary: fc.constantFrom(
        bootCommand('ReplaceRenderer'),
        bootCommand('ReplaceRenderer'),
        bootCommand('Activate'),
        closeWindowCommand
      ),
    },
    { weight: 1, arbitrary: fc.constant(settleCommand) }
  )
}

/** Releases whatever is still held, then evaluates the predicates at quiescence. */
const EPILOGUE: ReadonlyArray<fc.AsyncCommand<Model, Real>> = [
  releaseOwnerCommand,
  releaseRedeemCommand('signed-in'),
  releaseMethodsCommand('password-and-oidc'),
  releaseOpenCommand(true),
  settleCommand,
]

function newStats(): RunStats {
  return {
    witness: new Map(),
    ran: new Map(),
    pushes: 0,
    acceptedLinks: 0,
    tokenWrites: 0,
    secretsScanned: 0,
  }
}

/**
 * 256 runs by default. A run is about nine commands and takes about 10 ms, so 32 runs left some
 * witness pairs visited once or not at all, and the witness passed only by the seed's luck. At 256
 * every pair is visited at least four times, in about 2.5 s.
 */
const DEFAULT_MODEL_RUNS = 256

function modelRuns(): number {
  const raw = process.env.BROWSER_SIGN_IN_MODEL_RUNS
  if (raw === undefined || raw === '') return DEFAULT_MODEL_RUNS
  const runs = Number(raw)
  if (!Number.isSafeInteger(runs) || runs < 1) {
    throw new Error(`BROWSER_SIGN_IN_MODEL_RUNS must be a positive integer, got ${raw}`)
  }
  return runs
}

/** One generated run against a fresh harness, with `Date` faked to follow the browser sign-in clock. */
async function runModel(
  scheduler: fc.Scheduler,
  keptToken: boolean,
  commands: Iterable<fc.AsyncCommand<Model, Real>>,
  stats: RunStats
): Promise<void> {
  // The restore's 5 s gate reads `Date` (`getSessionState`); every other timer stays real.
  vi.useFakeTimers({ toFake: ['Date'] })
  let harness: BrowserSignInHarness
  try {
    harness = await createBrowserSignInHarness({ scheduler, linksAvailable: true, keptToken })
  } catch (error) {
    vi.useRealTimers()
    await cleanupBrowserSignInHarness().catch((cleanupError: unknown) => {
      console.warn('model: the harness cleanup also failed after a failed build:', cleanupError)
    })
    throw error
  }
  await cleanUpAfter(async () => {
    vi.setSystemTime(harness.clock.now())
    const runtimeConfig = await import('../config.js')
    const answerPassword = harness.routes[PASSWORD_LOGIN_ROUTE]
    const answerGoogle = harness.routes[GOOGLE_LOGIN_ROUTE]
    if (!answerPassword || !answerGoogle) throw new Error('model: the harness has no login routes')
    harness.routes[PASSWORD_LOGIN_ROUTE] = request =>
      (request.body as { email?: string }).email === REFUSED_PASSWORD_EMAIL
        ? unauthorized()
        : answerPassword(request)
    harness.routes[GOOGLE_LOGIN_ROUTE] = request =>
      (request.body as { idToken?: string }).idToken === REFUSED_GOOGLE_TOKEN
        ? unauthorized()
        : answerGoogle(request)
    harness.routes[HUB_SETUP_ROUTE] = setupNotFound
    const real: Real = {
      harness,
      runtimeConfig,
      router: undefined as unknown as EvenfireDeepLinkRouter,
      windowRequests: 0,
      holds: {},
      pendingStart: null,
      pendingRestore: null,
      accepted: [],
      generated: new Set(),
      cancelled: new Set(),
      redeemAnswerByCode: new Map(),
      live: new Set(),
      stats,
    }
    harness.routes[REDEEM_ROUTE] = request =>
      edgeResponse(
        readEdgeRecord(
          REDEEM_RECORD_KEYS[
            real.redeemAnswerByCode.get(String((request.body as { code?: unknown }).code)) ??
              'signed-in'
          ]
        )
      )
    real.router = createEvenfireDeepLinkRouter({
      appProtocol: 'evenfire',
      focusMainWindow: () => undefined,
      getWindow: () => null,
      handleSandboxUiDeepLink: () => false,
      handleGfsResourceDeepLink: () => false,
      handleDesktopLoginLink: createDesktopLoginLinkHandler({
        accept: rawUrl => harness.service.acceptDesktopLoginLink(rawUrl),
        requestMainWindow: () => {
          real.windowRequests += 1
        },
      }),
      isRendererReady: () => true,
      logout: () => harness.service.logout(),
      gfsResourceDeepLinkHost: 'gfs',
      requestMainWindow: () => undefined,
      sandboxUiDeepLinkHost: 'sandbox-ui',
      shouldAcceptSandboxUiProtocolLink: () => false,
      shouldAcceptGfsResourceProtocolLink: () => false,
    })
    const model: Model = {
      env: 'A',
      exists: { A: true, B: true, C: true },
      session: null,
      stored: keptToken ? 'kept' : null,
      gate: null,
      count: 0,
      bumps: 0,
      lastId: 0,
      attempt: null,
      envOf: new Map(),
      snapshot: NO_SNAPSHOT,
      nowMs: harness.clock.now(),
      timerMs: 0,
      start: null,
      redeem: null,
      ownerHold: null,
      queue: [],
      windowOpen: true,
      methodsFetches: 0,
      redeemFetches: 0,
    }
    // Every run begins with a waiting attempt (Γ4), as r12's runs begin with their request.
    await fc.asyncModelRun(() => ({ model, real }), [startCommand, ...commands, ...EPILOGUE])
    stats.pushes += harness.pushes.length
    stats.tokenWrites += harness.tokenWrites.length
  })
}

describe('the A6 model', () => {
  it('holds S1–S4, S6–S9, L1–L5 and C1–C3 under generated commands and holds', async () => {
    const stats = newStats()
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        KEPT_TOKEN_ARB,
        fc.commands([commandArbitrary()], { maxCommands: 24, size: '+1' }),
        (scheduler, keptToken, commands) => runModel(scheduler, keptToken, commands, stats)
      ),
      { numRuns: modelRuns(), seed: 24112026 }
    )

    // The coverage witness (M3h): a model that never reaches a gap proves nothing there.
    // What runs depends on the seed, fast-check's version (4.9.0) and the weights in
    // `commandArbitrary`: a missing pair means the runs no longer reach that gap, so change the
    // weights, never a predicate.
    const missing = WITNESS_REQUIRED.map(([gap, event]) => `${gap} ${event}`).filter(
      pair => !stats.witness.has(pair)
    )
    expect(
      missing,
      `the coverage witness: ${JSON.stringify([...stats.witness])}; commands run: ${JSON.stringify([...stats.ran])}`
    ).toEqual([])
  }, 180_000)

  it('G2-18 lets no code, verifier or state escape', async () => {
    const stats = newStats()
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        KEPT_TOKEN_ARB,
        fc.commands([commandArbitrary()], { maxCommands: 24, size: '+1' }),
        (scheduler, keptToken, commands) => runModel(scheduler, keptToken, commands, stats)
      ),
      { numRuns: 8, seed: 18112026 }
    )

    // K24: the scan read something. An empty collector passes any scan.
    expect(stats.pushes).toBeGreaterThan(0)
    expect(stats.acceptedLinks).toBeGreaterThan(0)
    expect(stats.tokenWrites).toBeGreaterThan(0)
    expect(stats.secretsScanned).toBeGreaterThan(0)
  }, 180_000)
})
