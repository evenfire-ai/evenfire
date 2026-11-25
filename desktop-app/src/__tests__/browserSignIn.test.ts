import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  DESKTOP_EDGE_RECORD_KEYS,
  type EdgeContractRecord,
  type EdgeRecordKey,
  LOGIN_SCREEN_ROWS,
  SIGN_IN_URL_SHAPES,
  deriveEdgeRecord,
  edgeResponse,
  readEdgeRecord,
  readEdgeRecordsWithStatus,
} from '../../testSupport/edgeContractRecords.js'
import {
  BROWSER_SIGN_IN_DEADLINE_MS,
  BrowserSignInAttempts,
  type BrowserSignInBinding,
  type BrowserSignInClock,
  type BrowserSignInTimerHandle,
  createBrowserSignInSecrets,
  mapDesktopLoginErrorLink,
  mapRedeemAnswer,
  parseRedeemResult,
  s256Challenge,
} from '../browserSignIn.js'
import {
  DESKTOP_LOGIN_REFUSAL_REASONS,
  type DesktopLoginRefusalReason,
  type RedeemHttpAnswer,
  buildDesktopLoginErrorLink,
  buildLoginMethodsModel,
  compareBrowserSignInSnapshots,
  newerBrowserSignInSnapshot,
  parseDesktopLoginLink,
  readUsableOidc,
} from '../browserSignInModel.js'
import type {
  BrowserSignInEnd,
  BrowserSignInFailureReason,
  BrowserSignInSnapshot,
} from '../types.js'

const PROPERTY_RUNS = { numRuns: 2000, seed: 24112026 }

function loginScreenRow(label: string) {
  const row = LOGIN_SCREEN_ROWS.find(([rowLabel]) => rowLabel === label)
  if (!row) throw new Error(`LOGIN_SCREEN_ROWS has no row "${label}"`)
  return row
}

describe('edge records', () => {
  // The plan's key table: each record this PR reads, with the status it records.
  const RECORDED_STATUS: Record<EdgeRecordKey, number> = {
    'GET /api/v1/auth/methods password-and-oidc': 200,
    'GET /api/v1/auth/methods password': 200,
    'GET /api/v1/auth/methods not-found': 404,
    'GET /api/v1/auth/methods unavailable': 503,
    'POST /api/v1/oidc/desktop-sign-in/redeem signed-in': 200,
    'POST /api/v1/oidc/desktop-sign-in/redeem invalid': 400,
    'POST /api/v1/oidc/desktop-sign-in/redeem refused-account-disabled': 403,
    'POST /api/v1/oidc/desktop-sign-in/redeem unavailable': 409,
    'POST /api/v1/oidc/desktop-sign-in/redeem upgrade-required': 426,
    'POST /api/v1/oidc/desktop-sign-in/redeem issuance-unavailable': 503,
    'POST /api/v1/oidc/desktop-sign-in/redeem rate-limited': 429,
    'POST /api/v1/oidc/profile-flow/complete desktop-code-issued': 200,
  }

  it.each(DESKTOP_EDGE_RECORD_KEYS)('reads %s with its recorded status', key => {
    expect(readEdgeRecord(key).status).toBe(RECORDED_STATUS[key])
  })

  it('refuses a key outside the table', () => {
    // @ts-expect-error K20: a mistyped key is not an EdgeRecordKey.
    expect(() => readEdgeRecord('GET /api/v1/auth/methods pasword')).toThrow(
      'not a key this PR reads'
    )
  })

  it('derives a labelled record and leaves the recorded one as it was', () => {
    const key = 'GET /api/v1/auth/methods password'
    // A copy, so a reader that handed out one shared parse cannot change it too.
    const recorded = structuredClone(readEdgeRecord(key).body)
    // The edit empties the list it was given in place, so a shared parse would show the change
    // on the next read.
    const derived = deriveEdgeRecord(key, 'nothing-usable:empty', body => {
      const { methods } = body as { methods: unknown[] }
      methods.splice(0)
      return body
    })
    expect(derived.body).toEqual({ ...(recorded as object), methods: [] })
    expect(readEdgeRecord(key).body).toEqual(recorded)
    expect(() => deriveEdgeRecord(key, 'unchanged', body => body)).toThrow('changed nothing')
  })

  it('answers a record with its status, JSON body and retry-after', async () => {
    const record = readEdgeRecord('POST /api/v1/oidc/desktop-sign-in/redeem rate-limited')
    const response = edgeResponse(record)
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe(record.retryAfter)
    expect(await response.json()).toEqual(record.body)
  })
})

describe('login methods model', () => {
  it.each(LOGIN_SCREEN_ROWS)('builds %s', (_label, answer, model) => {
    expect(buildLoginMethodsModel(answer, { linksAvailable: true })).toEqual(model)
  })

  it('treats oidc as unusable when links cannot arrive', () => {
    const [, both, bothModel] = loginScreenRow('password-and-oidc')
    const [, oidcOnly] = loginScreenRow('oidc-only')
    // The same answer offers the provider while links can arrive.
    expect(buildLoginMethodsModel(both, { linksAvailable: true })).toEqual(bothModel)
    expect(bothModel).toMatchObject({ provider: { label: expect.any(String) } })

    expect(readUsableOidc(both, { linksAvailable: false })).toBeNull()
    expect(buildLoginMethodsModel(both, { linksAvailable: false })).toEqual({
      kind: 'methods',
      provider: null,
      password: true,
    })
    expect(buildLoginMethodsModel(oidcOnly, { linksAvailable: false })).toEqual({
      kind: 'misconfigured',
    })
  })
})

describe('signInUrl shape', () => {
  // Review Focus 3, through PR 2's parser. The non-string rows show that readUsableOidc returns
  // null for them without throwing; PR 2's parser also refuses them on its own.
  it.each(SIGN_IN_URL_SHAPES)(
    'readUsableOidc on %s is usable: %s',
    (_label, _usable, answer, expected) => {
      expect(readUsableOidc(answer, { linksAvailable: true })).toEqual(expected)
    }
  )
})

describe('snapshot order', () => {
  const NO_ATTEMPT: BrowserSignInSnapshot = { attemptId: null, phase: 'idle' }
  const END_STATES: readonly BrowserSignInEnd[] = [
    { outcome: 'signed_in' },
    { outcome: 'refused', reason: DESKTOP_LOGIN_REFUSAL_REASONS[0] },
    { outcome: 'cancelled' },
    { outcome: 'timed_out' },
    { outcome: 'failed' },
    { outcome: 'failed', reason: 'different_environment' },
    { outcome: 'replaced' },
  ]
  // A small id range, so equal ids, and so ties on the phase, come up often. Each attempt
  // reaches exactly one end state, so an ended snapshot's outcome is fixed by its id.
  const attemptId = fc.integer({ min: 0, max: 3 })
  const endFor = (id: number) => END_STATES[id % END_STATES.length]!
  const withAttempt: fc.Arbitrary<BrowserSignInSnapshot> = fc.oneof(
    attemptId.map(id => ({ attemptId: id, phase: 'idle' as const })),
    fc
      .tuple(attemptId, fc.constantFrom('waiting' as const, 'redeeming' as const))
      .map(([id, phase]) => ({ attemptId: id, phase })),
    attemptId.map(id => ({ attemptId: id, phase: 'ended' as const, ...endFor(id) }))
  )
  const snapshot: fc.Arbitrary<BrowserSignInSnapshot> = fc.oneof(
    fc.constant(NO_ATTEMPT),
    withAttempt
  )
  const compare = compareBrowserSignInSnapshots
  const fold = (snapshots: readonly BrowserSignInSnapshot[]) =>
    snapshots.reduce<BrowserSignInSnapshot>(
      (current, candidate) => newerBrowserSignInSnapshot(current, candidate),
      NO_ATTEMPT
    )

  it('ranks one attempt waiting, redeeming, ended, then idle', () => {
    const waiting: BrowserSignInSnapshot = { attemptId: 7, phase: 'waiting' }
    const redeeming: BrowserSignInSnapshot = { attemptId: 7, phase: 'redeeming' }
    const ended: BrowserSignInSnapshot = { attemptId: 7, phase: 'ended', outcome: 'cancelled' }
    const idle: BrowserSignInSnapshot = { attemptId: 7, phase: 'idle' }

    expect(newerBrowserSignInSnapshot(waiting, redeeming)).toBe(redeeming)
    expect(newerBrowserSignInSnapshot(redeeming, ended)).toBe(ended)
    // Main's idle after an acknowledgement clears the outcome, and a late replay of the
    // ended snapshot does not bring it back.
    expect(newerBrowserSignInSnapshot(ended, idle)).toBe(idle)
    expect(newerBrowserSignInSnapshot(idle, ended)).toBe(idle)
    expect(fold([idle, ended, redeeming, waiting])).toBe(idle)
  })

  it('keeps the current snapshot when the candidate is not strictly newer', () => {
    const current: BrowserSignInSnapshot = { attemptId: 2, phase: 'ended', outcome: 'cancelled' }
    const sameRank: BrowserSignInSnapshot = { attemptId: 2, phase: 'ended', outcome: 'timed_out' }
    expect(newerBrowserSignInSnapshot(current, sameRank)).toBe(current)
    expect(newerBrowserSignInSnapshot(current, { attemptId: 3, phase: 'waiting' })).toEqual({
      attemptId: 3,
      phase: 'waiting',
    })
  })

  it('is antisymmetric', () => {
    fc.assert(
      fc.property(snapshot, snapshot, (a, b) => {
        const forward = Math.sign(compare(a, b))
        const backward = Math.sign(compare(b, a))
        return forward + backward === 0
      }),
      PROPERTY_RUNS
    )
  })

  it('is transitive', () => {
    fc.assert(
      fc.property(snapshot, snapshot, snapshot, (a, b, c) => {
        if (compare(a, b) <= 0 && compare(b, c) <= 0) return compare(a, c) <= 0
        return true
      }),
      PROPERTY_RUNS
    )
  })

  it('is total: 0 only for equal ids and equal phases', () => {
    fc.assert(
      fc.property(snapshot, snapshot, (a, b) => {
        const same = a.attemptId === b.attemptId && a.phase === b.phase
        return (compare(a, b) === 0) === same
      }),
      PROPERTY_RUNS
    )
  })

  it('ranks a later attempt above every phase of an earlier one', () => {
    fc.assert(
      fc.property(withAttempt, withAttempt, (a, b) => {
        if (a.attemptId === null || b.attemptId === null || a.attemptId >= b.attemptId) {
          return true
        }
        return compare(a, b) < 0 && newerBrowserSignInSnapshot(b, a) === b
      }),
      PROPERTY_RUNS
    )
  })

  it('ranks a null attempt id below every id', () => {
    fc.assert(
      fc.property(withAttempt, b => {
        return (
          compare(NO_ATTEMPT, b) < 0 &&
          compare(b, NO_ATTEMPT) > 0 &&
          newerBrowserSignInSnapshot(b, NO_ATTEMPT) === b
        )
      }),
      PROPERTY_RUNS
    )
  })

  it('is idempotent: newer(newer(v, s), s) equals newer(v, s)', () => {
    fc.assert(
      fc.property(snapshot, snapshot, (v, s) => {
        const once = newerBrowserSignInSnapshot(v, s)
        expect(newerBrowserSignInSnapshot(once, s)).toEqual(once)
      }),
      PROPERTY_RUNS
    )
  })

  it('folds any permutation of a snapshot list to the same, greatest snapshot', () => {
    const listAndPermutation = fc
      .array(snapshot, { maxLength: 12 })
      .chain(list =>
        fc.tuple(
          fc.constant(list),
          fc.shuffledSubarray(list, { minLength: list.length, maxLength: list.length })
        )
      )
    fc.assert(
      fc.property(listAndPermutation, ([list, permutation]) => {
        const folded = fold(list)
        expect(fold(permutation)).toEqual(folded)
        for (const each of list) expect(compare(each, folded)).toBeLessThanOrEqual(0)
      }),
      PROPERTY_RUNS
    )
  })
})

/** The closed sets of D17: nothing else may cross IPC. */
const OUTCOMES: ReadonlySet<string> = new Set<BrowserSignInEnd['outcome']>([
  'signed_in',
  'refused',
  'cancelled',
  'timed_out',
  'failed',
  'replaced',
])
// A record, so a reason added to or removed from the type fails to compile here.
const FAILURE_REASONS = Object.keys({
  different_environment: true,
  unavailable: true,
  no_longer_available: true,
  environment_changed: true,
} satisfies Record<BrowserSignInFailureReason, true>) as BrowserSignInFailureReason[]

function expectClosedEnd(end: BrowserSignInEnd, label: string) {
  expect(OUTCOMES.has(end.outcome), label).toBe(true)
  const { outcome: _outcome, reason, ...rest } = end as { outcome: string; reason?: unknown }
  expect(rest, label).toEqual({})
  if (end.outcome === 'refused') {
    expect(DESKTOP_LOGIN_REFUSAL_REASONS, label).toContain(reason)
  } else if (end.outcome === 'failed' && reason !== undefined) {
    expect(FAILURE_REASONS, label).toContain(reason)
  } else {
    expect(Object.hasOwn(end, 'reason'), label).toBe(false)
  }
}

describe('end-state mapping', () => {
  const REDEEM_REFUSED: EdgeRecordKey =
    'POST /api/v1/oidc/desktop-sign-in/redeem refused-account-disabled'
  const REDEEM_SIGNED_IN: EdgeRecordKey = 'POST /api/v1/oidc/desktop-sign-in/redeem signed-in'

  type RedeemFailure = Exclude<RedeemHttpAnswer, { status: 200 }>

  /** A recorded answer as the transport hands it to the mapping (Task 7a proves that half). */
  function redeemFailure(record: EdgeContractRecord): RedeemFailure {
    return { status: record.status, bodyText: JSON.stringify(record.body) }
  }

  const recordedRefusal = readEdgeRecord(REDEEM_REFUSED)
  const recordedReason = (recordedRefusal.body as { reason: DesktopLoginRefusalReason }).reason

  /** The recorded 403 with its `reason` replaced (or removed, for `undefined`). */
  function refusedWith(label: string, reason: unknown): RedeemFailure {
    return redeemFailure(
      deriveEdgeRecord(REDEEM_REFUSED, label, body => {
        const { reason: _recorded, ...rest } = body as Record<string, unknown>
        return reason === undefined ? rest : { ...rest, reason }
      })
    )
  }

  /** [the record's key, the §5.2 end state] for every recorded redeem answer but the 200. */
  const RECORDED_REDEEM_ROWS: ReadonlyArray<readonly [EdgeRecordKey, BrowserSignInEnd]> = [
    ['POST /api/v1/oidc/desktop-sign-in/redeem invalid', { outcome: 'failed' }],
    [REDEEM_REFUSED, { outcome: 'refused', reason: recordedReason }],
    [
      'POST /api/v1/oidc/desktop-sign-in/redeem unavailable',
      { outcome: 'failed', reason: 'no_longer_available' },
    ],
    ['POST /api/v1/oidc/desktop-sign-in/redeem upgrade-required', { outcome: 'failed' }],
    ['POST /api/v1/oidc/desktop-sign-in/redeem rate-limited', { outcome: 'failed' }],
    ['POST /api/v1/oidc/desktop-sign-in/redeem issuance-unavailable', { outcome: 'failed' }],
  ]

  const REDEEM_ROWS: ReadonlyArray<
    readonly [label: string, answer: RedeemFailure, end: BrowserSignInEnd]
  > = [
    ...RECORDED_REDEEM_ROWS.map(
      ([key, end]) => [key, redeemFailure(readEdgeRecord(key)), end] as const
    ),
    // Every other reason in the set is passed through as it came, not only the recorded one.
    ...DESKTOP_LOGIN_REFUSAL_REASONS.filter(reason => reason !== recordedReason).map(reason => {
      const label = `refused-in-set:${reason}`
      return [label, refusedWith(label, reason), { outcome: 'refused', reason }] as const
    }),
    // The one reason outside PR 2's set that a conforming edge relays as a 403: the edge's
    // redeem allowlist is the shared REFUSAL_REASONS (`external-rest-api/src/routes/
    // oidcDesktopSignIn.ts` relayFailure), which lists it. Desktop ends it `failed` (D17).
    [
      'refused-outside-set:invitation_email_mismatch',
      refusedWith('refused-outside-set:invitation_email_mismatch', 'invitation_email_mismatch'),
      { outcome: 'failed' },
    ],
    [
      'refused-without-reason',
      refusedWith('refused-without-reason', undefined),
      { outcome: 'failed' },
    ],
    // The recorded body cut short, as a dropped connection leaves it: not JSON at all.
    [
      'refused-truncated-body',
      { status: 403, bodyText: JSON.stringify(recordedRefusal.body).slice(0, -1) },
      { outcome: 'failed' },
    ],
    // No answer: a network failure or the request timeout.
    ['unreachable', { status: 'unreachable' }, { outcome: 'failed' }],
  ]

  // A state Desktop itself made, so the links have the shape PR 2's builder requires.
  const { state } = createBrowserSignInSecrets()

  /** A refusal link from PR 2's builder, its query then edited as a hostile sender would. */
  function editedRefusalLink(edit: (params: URLSearchParams) => void): string {
    const link = new URL(
      buildDesktopLoginErrorLink({
        state,
        error: 'refused',
        reason: DESKTOP_LOGIN_REFUSAL_REASONS[0],
      })
    )
    edit(link.searchParams)
    return link.href
  }

  const LINK_ROWS: ReadonlyArray<readonly [label: string, rawUrl: string, end: BrowserSignInEnd]> =
    [
      ...DESKTOP_LOGIN_REFUSAL_REASONS.map(
        reason =>
          [
            `error=refused&reason=${reason}`,
            buildDesktopLoginErrorLink({ state, error: 'refused', reason }),
            { outcome: 'refused', reason },
          ] as const
      ),
      [
        'error=cancelled',
        buildDesktopLoginErrorLink({ state, error: 'cancelled' }),
        { outcome: 'cancelled' },
      ],
      [
        'error=unavailable',
        buildDesktopLoginErrorLink({ state, error: 'unavailable' }),
        { outcome: 'failed', reason: 'unavailable' },
      ],
      [
        'error=failed',
        buildDesktopLoginErrorLink({ state, error: 'failed' }),
        { outcome: 'failed' },
      ],
      // PR 2's builder never writes these two (it writes error=failed); a hostile page could.
      [
        'hostile error=refused&reason=invitation_email_mismatch',
        editedRefusalLink(params => params.set('reason', 'invitation_email_mismatch')),
        { outcome: 'failed' },
      ],
      [
        'hostile bare error=refused',
        editedRefusalLink(params => params.delete('reason')),
        { outcome: 'failed' },
      ],
    ]

  describe('G2-17 maps every redeem answer and every error link to its §5.2 row', () => {
    it.each(REDEEM_ROWS)('redeem %s', (label, answer, end) => {
      const mapped = mapRedeemAnswer(answer)
      expect(mapped, label).toEqual(end)
      expectClosedEnd(mapped, label)
    })

    it.each(LINK_ROWS)('link %s', (label, rawUrl, end) => {
      const link = parseDesktopLoginLink(rawUrl)
      if (link?.kind !== 'error') throw new Error(`"${label}" did not parse as an error link`)
      const mapped = mapDesktopLoginErrorLink(link)
      expect(mapped, label).toEqual(end)
      expectClosedEnd(mapped, label)
    })

    it('reads every recorded redeem answer but the 200', () => {
      const redeemKeys = DESKTOP_EDGE_RECORD_KEYS.filter(
        key =>
          key.startsWith('POST /api/v1/oidc/desktop-sign-in/redeem ') && key !== REDEEM_SIGNED_IN
      )
      expect(new Set(RECORDED_REDEEM_ROWS.map(([key]) => key))).toEqual(new Set(redeemKeys))
    })
  })

  // D17's tier-1 check: the edge's redeem refusals must stay inside PR 2's set. It reads the
  // whole file, so a refusal record PR 1 adds later is checked too.
  it('every 403 reason in edge.json is in the link-reason set', () => {
    const reasons = readEdgeRecordsWithStatus(403).flatMap(([key, record]) => {
      const body = record.body as { reason?: unknown } | null
      return body !== null && typeof body === 'object' && 'reason' in body
        ? [[key, body.reason] as const]
        : []
    })
    expect(reasons.map(([key]) => key)).toContain(REDEEM_REFUSED)
    for (const [key, reason] of reasons)
      expect(DESKTOP_LOGIN_REFUSAL_REASONS, key).toContain(reason)
  })
})

describe('redeem result', () => {
  const SIGNED_IN: EdgeRecordKey = 'POST /api/v1/oidc/desktop-sign-in/redeem signed-in'
  const recordedToken = (readEdgeRecord(SIGNED_IN).body as { token: string }).token

  /** The recorded 200 with `edit` applied to a copy of its body. */
  function signedIn(label: string, edit: (body: Record<string, unknown>) => unknown): unknown {
    return deriveEdgeRecord(SIGNED_IN, label, body => edit({ ...(body as object) })).body
  }

  function withMe(label: string, edit: (me: Record<string, unknown>) => unknown): unknown {
    return signedIn(label, body => ({ ...body, me: edit({ ...(body.me as object) }) }))
  }

  it('reads the recorded 200 as its token and me', () => {
    const { body } = readEdgeRecord(SIGNED_IN)
    expect(parseRedeemResult(body)).toEqual(body)
  })

  it('reads signed-in:token-4096-characters', () => {
    const token = recordedToken.padEnd(4096, 'x')
    const body = signedIn('signed-in:token-4096-characters', recorded => ({ ...recorded, token }))
    expect(parseRedeemResult(body)).toMatchObject({ token })
  })

  // Review Focus 4 at its source: a body the edge passes that Desktop cannot install.
  it.each([
    ['signed-in-without-me-id', withMe('signed-in-without-me-id', ({ id: _id, ...me }) => me)],
    ['unusable:me-id-empty', withMe('unusable:me-id-empty', me => ({ ...me, id: '' }))],
    [
      'unusable:me-id-not-a-string',
      withMe('unusable:me-id-not-a-string', me => ({ ...me, id: 1 })),
    ],
    ['unusable:me-null', signedIn('unusable:me-null', body => ({ ...body, me: null }))],
    ['unusable:token-empty', signedIn('unusable:token-empty', body => ({ ...body, token: '' }))],
    [
      'unusable:token-4097-characters',
      signedIn('unusable:token-4097-characters', body => ({
        ...body,
        token: recordedToken.padEnd(4097, 'x'),
      })),
    ],
    [
      'unusable:token-not-a-string',
      signedIn('unusable:token-not-a-string', body => ({ ...body, token: 42 })),
    ],
    ['unusable:body-null', signedIn('unusable:body-null', () => null)],
  ])('refuses %s', (_label, body) => {
    expect(() => parseRedeemResult(body)).toThrow('not a usable session')
  })
})

/**
 * A clock the test moves. `setWall` moves only the wall clock (a sleep, or the clock set forward
 * or back); `advance` moves both and runs each live timer that falls due. `runCallback` runs any
 * callback ever set, cleared or not, as a timer that fires after its clear would.
 */
function fakeClock(startMs = Date.UTC(2026, 10, 26, 9)) {
  let wallMs = startMs
  let elapsedMs = 0
  const callbacks: Array<() => void> = []
  const live = new Map<number, number>() // callback index → due on the elapsed scale
  const clock: BrowserSignInClock = {
    now: () => wallMs,
    setTimer: (callback, ms) => {
      callbacks.push(callback)
      live.set(callbacks.length - 1, elapsedMs + ms)
      // A number stands for Node's timer object; the store only hands it back to clearTimer.
      return (callbacks.length - 1) as unknown as BrowserSignInTimerHandle
    },
    clearTimer: handle => {
      live.delete(handle as unknown as number)
    },
  }
  return {
    clock,
    get wall() {
      return wallMs
    },
    setWall(ms: number) {
      wallMs = ms
    },
    advance(ms: number) {
      const target = elapsedMs + ms
      for (;;) {
        const due = [...live.entries()]
          .filter(([, dueAt]) => dueAt <= target)
          .sort(([a, dueA], [b, dueB]) => dueA - dueB || a - b)[0]
        if (!due) break
        wallMs += due[1] - elapsedMs
        elapsedMs = due[1]
        live.delete(due[0])
        callbacks[due[0]]!()
      }
      wallMs += target - elapsedMs
      elapsedMs = target
    },
    runCallback(index: number) {
      if (callbacks.length > 0) callbacks[index % callbacks.length]!()
    },
    liveTimers: () => live.size,
  }
}

/** Lets every push queued so far run. */
function flushPushes(): Promise<void> {
  return new Promise(resolve => queueMicrotask(resolve))
}

describe('attempt store', () => {
  const BINDING: BrowserSignInBinding = {
    environmentKey: 'https://api.example.test',
    profileId: 'profile-a',
    restBaseUrl: 'https://api.example.test',
  }
  const PUSH_FAILED = '[AppService] Browser sign-in state push failed'

  function attemptInput() {
    const { state, verifier } = createBrowserSignInSecrets()
    return { state, verifier, binding: BINDING, generation: 3 }
  }

  function newStore(clock = fakeClock(), clockOverrides: Partial<BrowserSignInClock> = {}) {
    const pushes: BrowserSignInSnapshot[] = []
    const warnings: Array<readonly [string, unknown]> = []
    const store = new BrowserSignInAttempts({
      push: snapshot => {
        pushes.push(snapshot)
      },
      warn: (message, error) => {
        warnings.push([message, error])
      },
      clock: { ...clock.clock, ...clockOverrides },
    })
    return { store, pushes, warnings, clock }
  }

  it('publishes each change once, after the caller returns', async () => {
    const { store, pushes } = newStore()
    const id = store.record(attemptInput())
    expect(pushes).toEqual([])
    await Promise.resolve()
    expect(pushes).toEqual([{ attemptId: id, phase: 'waiting' }])

    expect(store.beginRedeem(id)).toBe(true)
    expect(store.end(id, { outcome: 'signed_in' })).toBe(true)
    expect(pushes).toHaveLength(1)
    await Promise.resolve()
    // Each push carries the snapshot of its own change, not the latest one.
    expect(pushes).toEqual([
      { attemptId: id, phase: 'waiting' },
      { attemptId: id, phase: 'redeeming' },
      { attemptId: id, phase: 'ended', outcome: 'signed_in' },
    ])
  })

  it('logs a throwing push target once and never throws to the caller', async () => {
    const failure = new Error('the window is gone')
    const warnings: Array<readonly [string, unknown]> = []
    const store = new BrowserSignInAttempts({
      push: () => {
        throw failure
      },
      warn: (message, error) => {
        warnings.push([message, error])
      },
      clock: fakeClock().clock,
    })
    const id = store.record(attemptInput())
    await flushPushes()
    expect(warnings).toEqual([[PUSH_FAILED, failure]])
    expect(store.snapshot()).toEqual({ attemptId: id, phase: 'waiting' })
  })

  it('counts attempt ids up from 1 and sets the deadline 15 minutes after the record', () => {
    const { store, clock } = newStore()
    expect(BROWSER_SIGN_IN_DEADLINE_MS).toBe(900_000)
    const startedAt = clock.wall
    expect(store.record(attemptInput())).toBe(1)
    expect(store.current()).toMatchObject({
      id: 1,
      binding: BINDING,
      generation: 3,
      deadlineAtMs: startedAt + BROWSER_SIGN_IN_DEADLINE_MS,
      phase: 'waiting',
    })
    expect(store.record(attemptInput())).toBe(2)
  })

  // Review Focus 2, the D12 ruling: the timer ends a waiting attempt when it fires, whatever the
  // wall clock then says.
  it('ends a waiting attempt at the timer even after the clock moved back', async () => {
    const { store, pushes, clock } = newStore()
    const id = store.record(attemptInput())
    const { deadlineAtMs } = store.current()!
    clock.setWall(clock.wall - 60 * 60 * 1000)
    clock.advance(BROWSER_SIGN_IN_DEADLINE_MS)
    // A wall-clock check alone would leave it waiting for another hour.
    expect(clock.wall).toBe(deadlineAtMs - 60 * 60 * 1000)
    expect(store.snapshot()).toEqual({ attemptId: id, phase: 'ended', outcome: 'timed_out' })
    await flushPushes()
    expect(pushes).toEqual([
      { attemptId: id, phase: 'waiting' },
      { attemptId: id, phase: 'ended', outcome: 'timed_out' },
    ])
  })

  // A3-67 and D12: the wall-clock deadline also applies at a link match and at a read, as after
  // a sleep, when the timer has not run.
  it.each(['match', 'read'] as const)(
    'ends a waiting attempt timed_out at a %s once the wall clock reaches its deadline',
    reader => {
      const { store, clock } = newStore()
      const input = attemptInput()
      const id = store.record(input)
      const { deadlineAtMs } = store.current()!
      const read = () =>
        reader === 'match' ? store.matchWaiting(input.state)?.id : store.snapshot().phase

      clock.setWall(deadlineAtMs - 1)
      expect(read()).toBe(reader === 'match' ? id : 'waiting')
      expect(store.matchWaiting(attemptInput().state)).toBeNull()

      clock.setWall(deadlineAtMs)
      expect(read()).toBe(reader === 'match' ? undefined : 'ended')
      expect(store.snapshot()).toEqual({ attemptId: id, phase: 'ended', outcome: 'timed_out' })
      expect(clock.liveTimers()).toBe(0)
    }
  )

  it('ignores an acknowledgement for another id', async () => {
    const { store, pushes } = newStore()
    const id = store.record(attemptInput())
    // Not ended yet: nothing to acknowledge.
    expect(store.acknowledge(id)).toEqual({ attemptId: id, phase: 'waiting' })
    const ended = store.cancel()
    expect(ended).toEqual({ attemptId: id, phase: 'ended', outcome: 'cancelled' })
    expect(store.acknowledge(id + 1)).toEqual(ended)
    expect(store.acknowledge(id - 1)).toEqual(ended)
    await flushPushes()
    expect(pushes).toHaveLength(2)

    expect(store.acknowledge(id)).toEqual({ attemptId: id, phase: 'idle' })
    expect(store.acknowledge(id)).toEqual({ attemptId: id, phase: 'idle' })
    await flushPushes()
    expect(pushes.slice(2)).toEqual([{ attemptId: id, phase: 'idle' }])
  })

  // D6: the generation hook ends a waiting attempt `replaced`. It reads no clock (a bump past the
  // deadline is still `replaced`) and pushes nothing before its caller returns.
  it('ends a waiting attempt replaced on a bump, without a clock read or an inline push', async () => {
    let clockReads = 0
    const clock = fakeClock()
    const { store, pushes } = newStore(clock, {
      now: () => {
        clockReads += 1
        return clock.wall
      },
    })
    const id = store.record(attemptInput())
    await flushPushes()
    clock.setWall(store.current()!.deadlineAtMs + 1)
    const readsBefore = clockReads

    store.onGenerationAdvanced()
    expect(clockReads).toBe(readsBefore)
    expect(pushes).toEqual([{ attemptId: id, phase: 'waiting' }])
    expect(clock.liveTimers()).toBe(0)
    await flushPushes()
    expect(pushes.at(-1)).toEqual({ attemptId: id, phase: 'ended', outcome: 'replaced' })
  })

  it('never throws from a bump when the timer clear throws', async () => {
    const failure = new Error('clear failed')
    const { store, pushes, warnings, clock } = newStore(fakeClock(), {
      clearTimer: () => {
        throw failure
      },
    })
    const id = store.record(attemptInput())
    expect(() => store.onGenerationAdvanced()).not.toThrow()
    expect(warnings).toEqual([['[AppService] Browser sign-in timer clear failed', failure]])
    // The timer that was not cleared fires later and finds nothing waiting.
    clock.advance(BROWSER_SIGN_IN_DEADLINE_MS)
    expect(store.snapshot()).toEqual({ attemptId: id, phase: 'ended', outcome: 'replaced' })
    await flushPushes()
    expect(pushes).toHaveLength(2)
  })

  it('lets a cleared timer that still fires end nothing', () => {
    const { store, clock } = newStore()
    store.record(attemptInput())
    const second = store.record(attemptInput())
    clock.runCallback(0)
    expect(store.snapshot()).toEqual({ attemptId: second, phase: 'waiting' })
  })

  // D10 and D12: once redeeming, only the install's own end applies; the deadline has stopped.
  it('leaves a redeeming attempt to its install: no bump, cancel or deadline ends it', () => {
    const { store, clock } = newStore()
    const id = store.record(attemptInput())
    expect(store.beginRedeem(id)).toBe(true)
    expect(store.beginRedeem(id)).toBe(false)
    expect(clock.liveTimers()).toBe(0)
    store.onGenerationAdvanced()
    expect(store.cancel()).toEqual({ attemptId: id, phase: 'redeeming' })
    clock.setWall(clock.wall + 2 * BROWSER_SIGN_IN_DEADLINE_MS)
    expect(store.snapshot()).toEqual({ attemptId: id, phase: 'redeeming' })
    expect(store.endIfWaiting(id, { outcome: 'failed' })).toBe(false)

    expect(store.end(id, { outcome: 'signed_in' })).toBe(true)
    expect(store.end(id, { outcome: 'failed' })).toBe(false)
    expect(store.snapshot()).toEqual({ attemptId: id, phase: 'ended', outcome: 'signed_in' })
  })

  describe('T2 property over store operations', () => {
    const MINUTE = 60 * 1000
    type IdChoice = 'current' | 'previous' | 'unissued'
    type StoreOp =
      | { op: 'record' }
      | { op: 'match'; own: boolean }
      | { op: 'beginRedeem' | 'acknowledge'; id: IdChoice }
      | { op: 'end' | 'endIfWaiting'; id: IdChoice; end: BrowserSignInEnd }
      | { op: 'cancel' | 'bump' | 'checkDeadline' | 'read' | 'flush' }
      | { op: 'moveWallClock' | 'advanceTimers' | 'runCallback'; amount: number }

    const ENDS: readonly BrowserSignInEnd[] = [
      { outcome: 'signed_in' },
      { outcome: 'cancelled' },
      { outcome: 'timed_out' },
      { outcome: 'replaced' },
      { outcome: 'failed' },
      ...FAILURE_REASONS.map(reason => ({ outcome: 'failed', reason }) as const),
      ...DESKTOP_LOGIN_REFUSAL_REASONS.map(reason => ({ outcome: 'refused', reason }) as const),
    ]
    const idChoice = fc.constantFrom<IdChoice>('current', 'previous', 'unissued')
    const storeOp: fc.Arbitrary<StoreOp> = fc.oneof(
      fc.constant({ op: 'record' } as const),
      fc.boolean().map(own => ({ op: 'match', own }) as const),
      fc.record({
        op: fc.constantFrom<'beginRedeem' | 'acknowledge'>('beginRedeem', 'acknowledge'),
        id: idChoice,
      }),
      fc.record({
        op: fc.constantFrom<'end' | 'endIfWaiting'>('end', 'endIfWaiting'),
        id: idChoice,
        end: fc.constantFrom(...ENDS),
      }),
      fc
        .constantFrom<
          'cancel' | 'bump' | 'checkDeadline' | 'read' | 'flush'
        >('cancel', 'bump', 'checkDeadline', 'read', 'flush')
        .map(op => ({ op })),
      fc.record({
        op: fc.constant('moveWallClock' as const),
        amount: fc.integer({ min: -120 * MINUTE, max: 120 * MINUTE }),
      }),
      fc.record({
        op: fc.constant('advanceTimers' as const),
        amount: fc.integer({ min: 0, max: 20 * MINUTE }),
      }),
      fc.record({ op: fc.constant('runCallback' as const), amount: fc.nat() })
    )
    const SNAPSHOT_KEYS = new Set(['attemptId', 'phase', 'outcome', 'reason'])
    const PHASE_SEQUENCES = [
      ['waiting'],
      ['waiting', 'redeeming'],
      ['waiting', 'redeeming', 'ended'],
      ['waiting', 'ended'],
    ]

    it('publishes per attempt a prefix of waiting, redeeming, ended or waiting, ended, ending once', async () => {
      await fc.assert(
        fc.asyncProperty(fc.array(storeOp, { maxLength: 40 }), async ops => {
          const { store, pushes, clock } = newStore()
          const secrets: string[] = []
          let recorded = 0
          const idOf = (choice: IdChoice) => {
            const current = store.current()?.id ?? 0
            return choice === 'current'
              ? current
              : choice === 'previous'
                ? current - 1
                : current + 1
          }
          for (const step of ops) {
            switch (step.op) {
              case 'record': {
                const input = attemptInput()
                secrets.push(input.state, input.verifier)
                expect(store.record(input)).toBe(++recorded)
                break
              }
              case 'match':
                store.matchWaiting(step.own ? (store.current()?.state ?? '') : attemptInput().state)
                break
              case 'beginRedeem':
                store.beginRedeem(idOf(step.id))
                break
              case 'acknowledge':
                store.acknowledge(idOf(step.id))
                break
              case 'end':
                store.end(idOf(step.id), step.end)
                break
              case 'endIfWaiting':
                store.endIfWaiting(idOf(step.id), step.end)
                break
              case 'cancel':
                store.cancel()
                break
              case 'bump':
                store.onGenerationAdvanced()
                break
              case 'checkDeadline':
                store.checkDeadline()
                break
              case 'read':
                store.snapshot()
                break
              case 'flush':
                await flushPushes()
                break
              case 'moveWallClock':
                clock.setWall(clock.wall + step.amount)
                break
              case 'advanceTimers':
                clock.advance(step.amount)
                break
              case 'runCallback':
                clock.runCallback(step.amount)
                break
            }
          }
          const final = store.snapshot()
          await flushPushes()

          const phasesById = new Map<number, string[]>()
          for (const snapshot of pushes) {
            expect([...Object.keys(snapshot)].filter(key => !SNAPSHOT_KEYS.has(key))).toEqual([])
            for (const value of Object.values(snapshot)) expect(secrets).not.toContain(value)
            if (snapshot.attemptId === null) throw new Error('a push without an attempt id')
            const phases = phasesById.get(snapshot.attemptId) ?? []
            phases.push(snapshot.phase)
            phasesById.set(snapshot.attemptId, phases)
          }
          // Every recorded id is published, in the order the ids were issued.
          expect([...phasesById.keys()]).toEqual(
            Array.from({ length: recorded }, (_, index) => index + 1)
          )
          for (const phases of phasesById.values()) {
            const acknowledged = phases.at(-1) === 'idle'
            const beforeIdle = acknowledged ? phases.slice(0, -1) : phases
            // `ended` is pushed at most once and nothing but one `idle` follows it.
            expect(PHASE_SEQUENCES).toContainEqual(beforeIdle)
            if (acknowledged) expect(beforeIdle.at(-1)).toBe('ended')
          }
          if (recorded === 0) {
            expect(pushes).toEqual([])
            expect(final).toEqual({ attemptId: null, phase: 'idle' })
            return
          }
          // V14 and the last push agree, and so do V13 and the attempt's last phase.
          expect(pushes.at(-1)).toEqual(final)
          const current = store.current()!
          const currentPhases = phasesById.get(current.id)!.filter(phase => phase !== 'idle')
          expect(currentPhases.at(-1)).toBe(current.phase)
        }),
        PROPERTY_RUNS
      )
    })
  })
})

describe('secrets', () => {
  it('computes the RFC 7636 S256 challenge', () => {
    // RFC 7636 Appendix B.
    expect(s256Challenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
    )
  })

  it('creates distinct 43-character base64url verifier and state', () => {
    const made = Array.from({ length: 64 }, () => createBrowserSignInSecrets())
    for (const secrets of made) {
      expect(secrets.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(secrets.state).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(secrets.challenge).toBe(s256Challenge(secrets.verifier))
    }
    const values = made.flatMap(secrets => [secrets.verifier, secrets.state])
    expect(new Set(values).size).toBe(values.length)
  })
})
