import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  DESKTOP_EDGE_RECORD_KEYS,
  type EdgeRecordKey,
  LOGIN_SCREEN_ROWS,
  SIGN_IN_URL_SHAPES,
  deriveEdgeRecord,
  edgeResponse,
  readEdgeRecord,
} from '../../testSupport/edgeContractRecords.js'
import {
  DESKTOP_LOGIN_REFUSAL_REASONS,
  buildLoginMethodsModel,
  compareBrowserSignInSnapshots,
  newerBrowserSignInSnapshot,
  readUsableOidc,
} from '../browserSignInModel.js'
import type { BrowserSignInEnd, BrowserSignInSnapshot } from '../types.js'

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
