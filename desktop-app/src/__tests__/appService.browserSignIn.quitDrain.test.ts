import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  type BrowserSignInHarness,
  type HoldPoint,
  type KeychainCall,
  type RealTokenStoreHandle,
  cleanupBrowserSignInHarness,
  createBrowserSignInHarness,
} from '../../testSupport/browserSignInHarness.js'
import { edgeResponse, readEdgeRecord } from '../../testSupport/edgeContractRecords.js'
import { BROWSER_SIGN_IN_DEADLINE_MS } from '../browserSignIn.js'
import { buildDesktopLoginCodeLink, parseDesktopLoginPageUrl } from '../browserSignInModel.js'
import type { BrowserSignInSnapshot } from '../types.js'

/**
 * Browser sign-in under the macOS quit drain (state model revision 2.2: A3-69, A3-71, A3-72,
 * A3-73). The harness builds the service with the real `TokenStore` on `darwin` and `keytar`
 * mocked, so the store's admission (V33) runs around every keychain call. The tests call
 * `closeTokenStoreAdmission()`, `waitForTokenStoreOperations()` and `openTokenStoreAdmission()`
 * themselves, standing in for `main.ts`'s `will-quit` (E39), the drain's end (E41) and a window
 * request that cancels the deferral (E40). A3-70, the main-level half, is in
 * `main.browserSignIn.test.ts`.
 *
 * A run that ends by exit (E41 first) is terminal: at the resolution of
 * `waitForTokenStoreOperations()` only the S and C predicates are checked (§4.1, X2). Quiescence
 * here also means no token-store call is left queued behind closed admission.
 *
 * Bodies outside the feature contract (G-5) come from the harness.
 */

afterEach(cleanupBrowserSignInHarness)

const hostPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')

afterAll(() => {
  expect(Object.getOwnPropertyDescriptor(process, 'platform')).toEqual(hostPlatformDescriptor)
})

const UNTIL_TURN_LIMIT = 200
const METHODS_PATH = '/api/v1/auth/methods'
const REDEEM_PATH = '/api/v1/oidc/desktop-sign-in/redeem'
const REDEEM_SIGNED_IN = 'POST /api/v1/oidc/desktop-sign-in/redeem signed-in'
/** Another environment's key, of the shape `tokenStore.ts:76` requires, for the deferring op. */
const DEFERRING_ENV_KEY = 'quit_drain-0123456789ab'

// Copied from `appService.browserSignIn.test.ts`, whose helpers are private to that file.

/** Drains until `reached`. The owner queue is not awaited: the point may be a hold under it. */
async function until(harness: BrowserSignInHarness, reached: () => boolean, what: string) {
  for (let turn = 0; !reached(); turn += 1) {
    if (turn >= UNTIL_TURN_LIMIT) throw new Error(`${what} was not reached`)
    await harness.drain({ owner: false })
  }
}

function fetchesTo(harness: BrowserSignInHarness, method: string, path: string) {
  return harness.fetches.filter(
    record => record.value.method === method && new URL(record.value.url).pathname === path
  )
}

function methodsFetches(harness: BrowserSignInHarness) {
  return fetchesTo(harness, 'GET', METHODS_PATH)
}

function snapshotsOf(harness: BrowserSignInHarness, attemptId: number): BrowserSignInSnapshot[] {
  return harness.pushes
    .map(record => record.value)
    .filter(snapshot => snapshot.attemptId === attemptId)
}

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

/** The session token the edge recorded for `signed-in`. */
function recordedSessionToken(): string {
  return (readEdgeRecord(REDEEM_SIGNED_IN).body as { token: string }).token
}

/** A code link from PR 2's builder, as the Profile UI sends it. */
function codeLink(state: string, environment: string): string {
  return buildDesktopLoginCodeLink({ state, code: recordedCode(), environment })
}

type StartedAttempt = Readonly<{ attemptId: number; state: string; challenge: string }>

/** Starts an attempt and reads its state and challenge from the page URL it opened. */
async function startAttempt(harness: BrowserSignInHarness): Promise<StartedAttempt> {
  const { attemptId } = await harness.service.startBrowserSignIn()
  const opened = harness.opens.at(-1)
  const page = opened ? parseDesktopLoginPageUrl(opened.value) : null
  if (!page) throw new Error(`attempt ${attemptId} opened no page with a state`)
  return { attemptId, state: page.state, challenge: page.challenge }
}

// The quit drain.

function realStore(harness: BrowserSignInHarness): RealTokenStoreHandle {
  if (!harness.realTokenStore) throw new Error('the harness was built without realTokenStore')
  return harness.realTokenStore
}

/** The accounts of the keychain calls of `method` from `from` on, in order. */
function keychainAccounts(
  store: RealTokenStoreHandle,
  method: KeychainCall['method'],
  from = 0
): string[] {
  return store.keychainCalls
    .slice(from)
    .filter(call => call.value.method === method)
    .map(call => call.value.account)
}

/** As `accountFor` (`tokenStore.ts:90-93`) builds it. */
function accountOf(envKey: string): string {
  return `session-token::${envKey}`
}

type DeferredQuit = Readonly<{ release: () => Promise<void> }>

/**
 * Defers a macOS quit the same way in every scenario (N-3). An admitted token-store operation,
 * the deferring op, is held on its keychain call: a direct read of another environment's token.
 * Admission then closes with it in flight, as `will-quit` closes it (E39), and the quit waits
 * for it. The operation under test comes after, so its token-store call queues behind closed
 * admission, not behind this hold. `release` lets the deferring op end and waits until it has:
 * with no token found, the store goes on to its file fallbacks (`tokenStore.ts:289-321`).
 */
async function deferQuit(harness: BrowserSignInHarness): Promise<DeferredQuit> {
  const store = realStore(harness)
  const hold = store.holdKeychainRead(DEFERRING_ENV_KEY)
  const read = store.store.getSessionToken(DEFERRING_ENV_KEY)
  await until(harness, () => hold.reached, "the deferring op's keychain read")
  expect(store.closeTokenStoreAdmission()).toBe(true)
  return {
    release: async () => {
      hold.release()
      await expect(read).resolves.toBeNull()
    },
  }
}

/** Copies of the records the S and C predicates read, taken at one moment. */
type Records = Readonly<{
  bumpLog: BrowserSignInHarness['bumpLog']
  fetches: BrowserSignInHarness['fetches']
  pushes: BrowserSignInHarness['pushes']
  secretsSeen: string[]
  tokenWrites: BrowserSignInHarness['tokenWrites']
}>

function recordsOf(harness: BrowserSignInHarness): Records {
  return {
    bumpLog: [...harness.bumpLog],
    fetches: [...harness.fetches],
    pushes: [...harness.pushes],
    secretsSeen: [...harness.secretsSeen],
    tokenWrites: [...harness.tokenWrites],
  }
}

function base64urlSha256(value: string): string {
  return createHash('sha256').update(value).digest('base64url')
}

/**
 * S1–S4, C1 and C2 (state model §4.2, §4.4) for one start, one accepted code link from the
 * attempt's own environment and one install token write. They read only the records, so they
 * also serve at the exit point of a terminal run.
 */
function expectSafetyAndCost(
  harness: BrowserSignInHarness,
  attempt: StartedAttempt,
  records: Records,
  label: string
): void {
  const pathOf = (url: string) => new URL(url).pathname
  const redeems = records.fetches.filter(
    record => record.value.method === 'POST' && pathOf(record.value.url) === REDEEM_PATH
  )
  // S1, S3, C1: one redeem, to the attempt's REST URL, with the link's code and the verifier
  // whose challenge the opened page carried.
  expect(
    redeems.map(record => record.value.url),
    label
  ).toEqual([`${harness.envs.A.restBaseUrl}${REDEEM_PATH}`])
  const body = redeems[0]?.value.body as { code?: string; codeVerifier?: string } | undefined
  expect(body?.code, label).toBe(recordedCode())
  expect(base64urlSha256(body?.codeVerifier ?? ''), label).toBe(attempt.challenge)
  // C2: one methods fetch for the one start.
  expect(
    records.fetches.filter(
      record => record.value.method === 'GET' && pathOf(record.value.url) === METHODS_PATH
    ),
    label
  ).toHaveLength(1)
  // S1, S4: after the attempt's waiting push, the only bump is the install's own
  // (`appService.ts:2119`), and it comes before the install's token write.
  const waitingSeq = records.pushes.find(
    record => record.value.attemptId === attempt.attemptId && record.value.phase === 'waiting'
  )?.seq
  expect(waitingSeq, label).toBeTypeOf('number')
  const bumpsAfterWaiting = records.bumpLog.filter(record => record.seq > (waitingSeq ?? 0))
  expect(bumpsAfterWaiting, label).toHaveLength(1)
  expect(records.tokenWrites, label).toHaveLength(1)
  expect(bumpsAfterWaiting[0]?.seq, label).toBeLessThan(records.tokenWrites[0]?.seq ?? 0)
  // S2 (and D18): neither the code, the verifier nor the state left the service.
  for (const secret of [recordedCode(), body?.codeVerifier ?? '', attempt.state]) {
    expect(secret, label).not.toBe('')
    expect(
      records.secretsSeen.filter(text => text.includes(secret)),
      label
    ).toEqual([])
  }
}

describe('the harness with the real token store', () => {
  it('runs the store on darwin with keytar mocked, and gives the host platform back', async () => {
    const host = Object.getOwnPropertyDescriptor(process, 'platform')
    if (!host) throw new Error('Node process.platform descriptor is unavailable')
    // Whatever the host, the store must see darwin, and the host's platform must come back.
    Object.defineProperty(process, 'platform', { ...host, value: 'linux' })
    try {
      const harness = await createBrowserSignInHarness({ realTokenStore: true, keptToken: true })
      expect(process.platform).toBe('darwin')
      const store = realStore(harness)

      // The restore reads the kept token through the real store and the mocked keychain.
      await expect(harness.service.getSessionState()).resolves.toMatchObject({
        authenticated: true,
      })
      expect(keychainAccounts(store, 'getPassword')).toEqual([accountOf(store.activeEnvKey)])
      // Admission is gated on darwin: a held read is admitted, so closing reports it (E39).
      const hold = store.holdKeychainRead(DEFERRING_ENV_KEY)
      const read = store.store.getSessionToken(DEFERRING_ENV_KEY)
      await until(harness, () => hold.reached, 'the held keychain read')
      expect(store.closeTokenStoreAdmission()).toBe(true)
      hold.release()
      await expect(read).resolves.toBeNull()

      await cleanupBrowserSignInHarness()
      expect(process.platform).toBe('linux')
    } finally {
      // A failed run is cleaned up here, before the host comes back: `afterEach` would put back
      // the platform the harness found, which is this test's `linux`.
      try {
        await cleanupBrowserSignInHarness()
      } finally {
        Object.defineProperty(process, 'platform', host)
      }
    }
  })
})

describe('browser sign-in under the macOS quit drain', () => {
  it('A3-69 a deferred quit leaves a waiting attempt alone', async () => {
    // No window while the quit is deferred: nothing takes the pushes (D13).
    const harness = await createBrowserSignInHarness({
      linksAvailable: true,
      realTokenStore: true,
      withoutPushTarget: true,
    })
    const { service, clock } = harness
    const store = realStore(harness)
    const first = await startAttempt(harness)
    const quit = await deferQuit(harness)
    const readsBefore = harness.tokenReads.length
    const keychainBefore = store.keychainCalls.length

    // A read: the attempt still waits.
    expect(service.getBrowserSignInState()).toEqual({
      attemptId: first.attemptId,
      phase: 'waiting',
    })
    // The deadline: past it on the wall clock, the resume check ends the attempt. The end waits
    // in the snapshot (V14), however often it is read, until it is acknowledged.
    clock.advance(BROWSER_SIGN_IN_DEADLINE_MS, 'wallOnly')
    service.checkBrowserSignInDeadline()
    const timedOut = { attemptId: first.attemptId, phase: 'ended', outcome: 'timed_out' }
    expect(service.getBrowserSignInState()).toEqual(timedOut)
    expect(service.getBrowserSignInState()).toEqual(timedOut)
    expect(service.acknowledgeBrowserSignInResult(first.attemptId)).toEqual({
      attemptId: first.attemptId,
      phase: 'idle',
    })

    // A start, then Cancel.
    const start = service.startBrowserSignIn()
    await harness.drain({ owner: false })
    expect(harness.opens).toHaveLength(2)
    const second = first.attemptId + 1
    await expect(start).resolves.toEqual({ attemptId: second })
    const cancelled = { attemptId: second, phase: 'ended', outcome: 'cancelled' }
    expect(service.cancelBrowserSignIn()).toEqual(cancelled)
    expect(service.getBrowserSignInState()).toEqual(cancelled)

    // None of them called the token store, and no owner op waits on it.
    await harness.drain()
    expect(harness.tokenReads).toHaveLength(readsBefore)
    expect(harness.tokenWrites).toEqual([])
    expect(store.keychainCalls.slice(keychainBefore)).toEqual([])

    // E41: the deferring op settles, so the drain completes and the quit goes on to exit.
    let drained = false
    const exit = store.waitForTokenStoreOperations().then(() => {
      drained = true
      return recordsOf(harness)
    })
    await harness.drain({ owner: false })
    expect(drained).toBe(false)
    await quit.release()
    const atExit = await exit

    // Terminal (X2): S and C only. No redeem (C1), one methods fetch per start (C2), and one
    // browser open per attempt (C3).
    expect(service.getBrowserSignInState()).toEqual(cancelled)
    expect(
      atExit.fetches.filter(record => new URL(record.value.url).pathname === REDEEM_PATH)
    ).toEqual([])
    expect(
      atExit.fetches.filter(record => new URL(record.value.url).pathname === METHODS_PATH)
    ).toHaveLength(2)
    expect(harness.opens).toHaveLength(2)
  })

  const A3_71_RUNS: ReadonlyArray<Readonly<{ label: string; point: HoldPoint }>> = [
    { label: 'run 1, the redeem held', point: 'redeem' },
    { label: "run 2, the install's chat-store bind held", point: 'installChatBind' },
  ]

  async function redeemSettlingDuringDeferredQuit(
    run: (typeof A3_71_RUNS)[number],
    order: 'window first' | 'drain first'
  ): Promise<void> {
    const label = `${run.label}, ${order}`
    const harness = await createBrowserSignInHarness({ linksAvailable: true, realTokenStore: true })
    const { service, envs } = harness
    const store = realStore(harness)
    const attempt = await startAttempt(harness)
    const held = harness.hold(run.point)
    expect(service.acceptDesktopLoginLink(codeLink(attempt.state, envs.A.restBaseUrl))).toBe(true)
    await until(harness, () => held.reached, `${label}: the held call`)
    const quit = await deferQuit(harness)
    const keychainBefore = store.keychainCalls.length

    // The install op goes on during the deferral and reaches its token write
    // (`appService.ts:2132`), which queues behind closed admission: the store is called, the
    // keychain is not.
    held.release(
      run.point === 'redeem' ? edgeResponse(readEdgeRecord(REDEEM_SIGNED_IN)) : undefined
    )
    await until(
      harness,
      () => harness.tokenWrites.length > 0,
      `${label}: the install's token write`
    )
    await harness.drain({ owner: false })
    const token = recordedSessionToken()
    const account = accountOf(store.activeEnvKey)
    expect(
      harness.tokenWrites.map(record => record.value),
      label
    ).toEqual([token])
    expect(keychainAccounts(store, 'setPassword', keychainBefore), label).toEqual([])
    // The session is set in memory (`appService.ts:2123-2124`); the attempt waits on its
    // install op, still redeeming.
    expect(service.getSessionPresence(), label).toEqual({ hasToken: true, hasMe: true })
    expect(snapshotsOf(harness, attempt.attemptId).at(-1), label).toEqual({
      attemptId: attempt.attemptId,
      phase: 'redeeming',
    })

    if (order === 'window first') {
      // E40: a window request reopens admission, and the queued write runs.
      store.openTokenStoreAdmission()
      await harness.drain({ owner: false })
      expect(keychainAccounts(store, 'setPassword', keychainBefore), label).toEqual([account])
      expect(store.keychain.get(account), label).toBe(token)
      await quit.release()
      await harness.drain()
      // Quiescence (the install's tail reads a file, real I/O): signed_in, nothing unsettled.
      expect(endStatesOf(harness, attempt.attemptId), label).toEqual(['signed_in'])
      expect(store.unsettledCalls(), label).toBe(0)
      expectSafetyAndCost(harness, attempt, recordsOf(harness), label)
      return
    }

    // E41 first: the deferring op settles, and the drain completes with the write still queued.
    let drained = false
    const exit = store.waitForTokenStoreOperations().then(() => {
      drained = true
      return {
        records: recordsOf(harness),
        keychainWrites: keychainAccounts(store, 'setPassword', keychainBefore),
        saved: store.keychain.has(account),
        last: snapshotsOf(harness, attempt.attemptId).at(-1),
      }
    })
    await harness.drain({ owner: false })
    expect(drained, label).toBe(false)
    await quit.release()
    const atExit = await exit

    // Terminal (X2): the code is spent and the token never saved; no end state was pushed.
    expect(atExit.keychainWrites, label).toEqual([])
    expect(atExit.saved, label).toBe(false)
    expect(atExit.last, label).toEqual({ attemptId: attempt.attemptId, phase: 'redeeming' })
    expectSafetyAndCost(harness, attempt, atExit.records, label)
  }

  it.each(['window first', 'drain first'] as const)(
    'A3-71 a redeem that settles during a deferred quit: %s',
    async order => {
      for (const run of A3_71_RUNS) {
        await redeemSettlingDuringDeferredQuit(run, order)
        // Each run needs its own harness: V33 is module state.
        await cleanupBrowserSignInHarness()
      }
    }
  )

  it("A3-72 a quit during the install's admitted token write waits for it", async () => {
    const harness = await createBrowserSignInHarness({ linksAvailable: true, realTokenStore: true })
    const { service, envs } = harness
    const store = realStore(harness)
    const attempt = await startAttempt(harness)
    const write = harness.hold('installTokenWrite')
    expect(service.acceptDesktopLoginLink(codeLink(attempt.state, envs.A.restBaseUrl))).toBe(true)
    await until(harness, () => write.reached, "the install's keychain write")
    const account = accountOf(store.activeEnvKey)

    // The write is admitted: it reached the keychain. With it in flight, admission closes and
    // the quit is deferred (E39). This write is the admitted operation, so the scenario needs no
    // other deferring op.
    expect(keychainAccounts(store, 'setPassword')).toEqual([account])
    expect(store.closeTokenStoreAdmission()).toBe(true)
    let drained = false
    const exit = store.waitForTokenStoreOperations().then(() => {
      drained = true
      return { records: recordsOf(harness), saved: store.keychain.get(account) }
    })
    await harness.drain({ owner: false })
    expect(drained).toBe(false)
    expect(store.keychain.has(account)).toBe(false)

    // E41 once the write settles: the token is saved before exit (X2), so the next launch
    // restores the session (E15).
    write.release()
    const atExit = await exit
    expect(atExit.saved).toBe(recordedSessionToken())
    expectSafetyAndCost(harness, attempt, atExit.records, 'A3-72')
  })

  it('A3-73 a deferred quit blocks only owner ops that call the token store', async () => {
    const harness = await createBrowserSignInHarness({
      linksAvailable: true,
      realTokenStore: true,
      keptToken: true,
    })
    const { service } = harness
    const store = realStore(harness)
    const quit = await deferQuit(harness)
    const keychainBefore = store.keychainCalls.length
    const account = accountOf(store.activeEnvKey)

    // A restore (E15): its owner op reads the kept token (`appService.ts:1936`), and the read
    // queues behind closed admission.
    const restore = service.getSessionState()
    await until(
      harness,
      () => harness.tokenReads.some(record => record.value === store.activeEnvKey),
      "the restore's token read"
    )
    const start = service.startBrowserSignIn()
    await harness.drain({ owner: false })

    // Before E40: the keychain saw no read, and start's op 1 waits behind the restore's owner
    // op: no methods fetch, no attempt.
    expect(store.keychainCalls.slice(keychainBefore)).toEqual([])
    expect(methodsFetches(harness)).toEqual([])
    expect(harness.pushes).toEqual([])
    expect(harness.opens).toEqual([])

    // E40: the restore's read runs, and then the start proceeds.
    store.openTokenStoreAdmission()
    await harness.drain({ owner: false })
    const restoreRead = store.keychainCalls
      .slice(keychainBefore)
      .find(record => record.value.method === 'getPassword' && record.value.account === account)
    const methods = methodsFetches(harness)
    expect(restoreRead).toBeDefined()
    expect(methods).toHaveLength(1)
    expect(restoreRead?.seq).toBeLessThan(methods[0]?.seq ?? 0)
    await expect(start).resolves.toEqual({ attemptId: 1 })
    // Start's op 1 ran right after the restore's read op and advanced the generation, so the
    // restore no longer owns the session (`ownsRestore`) and leaves it signed out (D3).
    await expect(restore).resolves.toMatchObject({ authenticated: false })

    await quit.release()
    await harness.drain()
    expect(snapshotsOf(harness, 1)).toEqual([{ attemptId: 1, phase: 'waiting' }])
    // Quiescence: S7 holds, and no token-store call is left queued or in flight.
    expect(service.getSessionPresence()).toEqual({ hasToken: false, hasMe: false })
    expect(store.unsettledCalls()).toBe(0)
  })
})
