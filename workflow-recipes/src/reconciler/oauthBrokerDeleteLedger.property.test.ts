import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  OAUTH_BROKER_NP_TTL_MS,
  OAuthBrokerDeleteLedger,
  type OAuthBrokerLedgerRecipe,
} from './oauthBrokerDeleteLedger'

/**
 * Observable invariants of the ledger, checked over random event sequences.
 * The harness does not rebuild the ledger's entries: it records only what a
 * caller can see (which events happened, in which order) and asserts
 * implications on the answers. Cases no invariant speaks about stay free.
 * "Current uid" is the uid of the live recipe object under the name.
 *
 * I1  No token ADDED since the process started, or since the finalizer
 *     observed the token gone: no Secret delete. A finalizer start
 *     (`forgetRecipe`) alone does not clear the token-seen bit.
 * I2  Token seen, and armed (an ADDED since the last write for the current
 *     uid, or no write for it since the last finalizer start or
 *     recreation): a pass at or above the watermark deletes.
 * I3  A pass below the highest generation that provisioned the token for
 *     the current uid does not delete it.
 * I4  A delete whose DELETE was sent before an ADDED, or before the
 *     finalizer observed the token gone, records nothing; otherwise it is
 *     recorded, across a finalizer start too.
 * I5  The NetworkPolicy side skips a covered pass until the TTL expires,
 *     and deletes for a different uid or a higher generation.
 * I6  Idempotence (#759 anti-storm): after a recorded delete or
 *     provisioning for the current uid, with no ADDED since, a pass at or
 *     below the watermark does not delete.
 * I7  The finalizer's token DELETE result: 2xx/404 with no ADDED in flight
 *     clears the token-seen bit; a raced ADDED, a failed DELETE or one
 *     never sent keeps it.
 */

const NAME = 'r'
const MAX_GENERATION = 6

type FinalizeOutcome = 'deleted' | 'gone' | 'failed' | 'notAttempted'

type Op =
  | { kind: 'provision'; generation: number }
  | { kind: 'pass'; generation: number }
  | { kind: 'beginDelete'; generation: number }
  | { kind: 'endDelete'; failed: boolean }
  | { kind: 'invalidateSecret' }
  | { kind: 'addedElsewhere' }
  | { kind: 'forgetRecipe' }
  | { kind: 'recreate' }
  | { kind: 'finalize'; outcome: FinalizeOutcome; racedAdded: boolean }

const generationArb = fc.integer({ min: 0, max: MAX_GENERATION })

const opArb: fc.Arbitrary<Op> = fc.oneof(
  generationArb.map(generation => ({ kind: 'provision' as const, generation })),
  generationArb.map(generation => ({ kind: 'pass' as const, generation })),
  generationArb.map(generation => ({ kind: 'beginDelete' as const, generation })),
  fc.boolean().map(failed => ({ kind: 'endDelete' as const, failed })),
  fc.constant({ kind: 'invalidateSecret' as const }),
  fc.constant({ kind: 'addedElsewhere' as const }),
  fc.constant({ kind: 'forgetRecipe' as const }),
  fc.constant({ kind: 'recreate' as const }),
  fc
    .record({
      outcome: fc.constantFrom<FinalizeOutcome>('deleted', 'gone', 'failed', 'notAttempted'),
      racedAdded: fc.boolean(),
    })
    .map(({ outcome, racedAdded }) => ({ kind: 'finalize' as const, outcome, racedAdded }))
)

function ref(generation: number, uid: string): OAuthBrokerLedgerRecipe {
  return { name: NAME, uid, generation }
}

/** What a caller observed; never the ledger's internal entry. */
interface Observed {
  uid: string
  /** Every uid the name has carried, for the records-nothing check. */
  uids: string[]
  tokenSeen: boolean
  /** Highest generation recorded or provisioned for the current uid since the last finalizer start. */
  watermark: number
  /** Highest generation provisioned for the current uid since the last finalizer start. */
  provisioned: number
  /** An ADDED, a finalizer start or a recreation landed after the last write for the current uid. */
  armed: boolean
  inFlight?: { uid: string; generation: number; epoch: number; raced: boolean }
}

function freshObserved(): Observed {
  return {
    uid: 'uid-1',
    uids: ['uid-1'],
    tokenSeen: false,
    watermark: -1,
    provisioned: -1,
    armed: true,
  }
}

/** The ledger no longer holds a write for the current uid. */
function forgetCurrentUid(seen: Observed): void {
  seen.watermark = -1
  seen.provisioned = -1
  seen.armed = true
}

/** A write (recorded delete or provisioning) for the current uid. */
function noteWrite(seen: Observed, generation: number, provisioned: boolean): void {
  if (provisioned) seen.provisioned = Math.max(seen.provisioned, generation)
  // A write below the watermark leaves the ledger's entry as it is.
  if (generation < seen.watermark) return
  seen.watermark = generation
  seen.armed = false
}

function allAnswers(ledger: OAuthBrokerDeleteLedger, seen: Observed): boolean[] {
  const answers: boolean[] = []
  for (const uid of [...seen.uids, 'uid-never']) {
    for (let generation = 0; generation <= MAX_GENERATION; generation++) {
      answers.push(ledger.shouldDeleteSecret(ref(generation, uid)))
    }
  }
  return answers
}

function checkPass(ledger: OAuthBrokerDeleteLedger, seen: Observed, generation: number): void {
  const answer = ledger.shouldDeleteSecret(ref(generation, seen.uid))
  const where = `gen${generation} observed=${JSON.stringify(seen)}`
  if (!seen.tokenSeen) expect(answer, `I1 ${where}`).toBe(false)
  if (generation < seen.provisioned) expect(answer, `I3 ${where}`).toBe(false)
  if (seen.tokenSeen && seen.armed && generation >= seen.watermark) {
    expect(answer, `I2 ${where}`).toBe(true)
  }
  if (!seen.armed && generation <= seen.watermark) {
    expect(answer, `I6 ${where}`).toBe(false)
  }
}

function added(ledger: OAuthBrokerDeleteLedger, seen: Observed): void {
  ledger.invalidateSecret(NAME)
  seen.tokenSeen = true
  seen.armed = true
  if (seen.inFlight) seen.inFlight.raced = true
}

function step(ledger: OAuthBrokerDeleteLedger, seen: Observed, op: Op): void {
  switch (op.kind) {
    case 'provision':
      // The per-recipe queue serialises passes for one name: the recreated
      // recipe cannot provision while the old uid's pass holds a DELETE.
      if (seen.inFlight && seen.inFlight.uid !== seen.uid) return
      ledger.noteSecretProvisioned(ref(op.generation, seen.uid))
      noteWrite(seen, op.generation, true)
      return
    case 'pass':
      checkPass(ledger, seen, op.generation)
      return
    case 'beginDelete':
      // The WRC sends the DELETE only when the ledger allows it, and the
      // per-recipe queue keeps one in flight.
      if (seen.inFlight || !ledger.shouldDeleteSecret(ref(op.generation, seen.uid))) return
      seen.inFlight = {
        uid: seen.uid,
        generation: op.generation,
        epoch: ledger.secretEpoch(NAME),
        raced: false,
      }
      return
    case 'endDelete': {
      const inFlight = seen.inFlight
      if (!inFlight) return
      seen.inFlight = undefined
      // A failed DELETE is never recorded.
      if (op.failed) return
      const before = allAnswers(ledger, seen)
      const recorded = ledger.recordSecretDelete(
        ref(inFlight.generation, inFlight.uid),
        inFlight.epoch
      )
      if (inFlight.raced) {
        expect(recorded, `I4 raced gen${inFlight.generation}`).toBe(false)
        expect(allAnswers(ledger, seen), `I4 records nothing gen${inFlight.generation}`).toEqual(
          before
        )
        return
      }
      // Liveness witness for I4: an undisturbed delete is recorded.
      expect(recorded, `I4 undisturbed gen${inFlight.generation}`).toBe(true)
      if (inFlight.uid === seen.uid) {
        noteWrite(seen, inFlight.generation, false)
      } else {
        // The old uid's entry replaced whatever the name held; the current
        // uid has no write in the ledger any more.
        forgetCurrentUid(seen)
      }
      return
    }
    case 'invalidateSecret':
      added(ledger, seen)
      return
    case 'addedElsewhere':
      ledger.invalidateSecret('other')
      return
    case 'forgetRecipe':
      // The finalizer starts: both entries go, the token-seen bit stays, and
      // an in-flight DELETE is not raced (the epoch did not move).
      ledger.forgetRecipe(NAME)
      forgetCurrentUid(seen)
      return
    case 'recreate': {
      // The recipe is recreated under the same name, whether or not its
      // finalizer ran in this process.
      const uid = `uid-${seen.uids.length + 1}`
      seen.uids.push(uid)
      seen.uid = uid
      forgetCurrentUid(seen)
      return
    }
    case 'finalize': {
      ledger.forgetRecipe(NAME)
      forgetCurrentUid(seen)
      if (op.outcome === 'notAttempted') return
      const epochBeforeDelete = ledger.secretEpoch(NAME)
      if (op.racedAdded) added(ledger, seen)
      if (op.outcome === 'failed') return
      const cleared = ledger.noteSecretGone(NAME, epochBeforeDelete)
      expect(cleared, `I7 ${op.outcome} racedAdded=${op.racedAdded}`).toBe(!op.racedAdded)
      if (!cleared) return
      seen.tokenSeen = false
      // An ensure DELETE in flight read a non-zero epoch; it no longer matches.
      if (seen.inFlight) seen.inFlight.raced = true
      return
    }
  }
}

describe('OAuthBrokerDeleteLedger observable properties', () => {
  it('I1-I4, I6 and I7 hold over provision, pass, delete, ADDED, finalizer and recreation sequences', () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 40 }), ops => {
        const ledger = new OAuthBrokerDeleteLedger()
        const seen = freshObserved()
        for (const op of ops) {
          step(ledger, seen, op)
          for (let generation = 0; generation <= MAX_GENERATION; generation++) {
            checkPass(ledger, seen, generation)
          }
        }
      }),
      { numRuns: 5000 }
    )
  })

  it('I2/I3 are reachable: an ADDED after provisioning arms the watermark and nothing below it', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: MAX_GENERATION }), provisioned => {
        const ledger = new OAuthBrokerDeleteLedger()
        ledger.noteSecretProvisioned(ref(provisioned, 'uid-1'))
        ledger.invalidateSecret(NAME)
        for (let generation = 0; generation <= MAX_GENERATION; generation++) {
          expect(ledger.shouldDeleteSecret(ref(generation, 'uid-1'))).toBe(
            generation >= provisioned
          )
        }
      }),
      { numRuns: 500 }
    )
  })

  it('I6/I2 are reachable: a recorded delete disarms its generation, a recreation re-arms every generation', () => {
    fc.assert(
      fc.property(generationArb, recorded => {
        const ledger = new OAuthBrokerDeleteLedger()
        ledger.invalidateSecret(NAME)
        expect(ledger.recordSecretDelete(ref(recorded, 'uid-1'), ledger.secretEpoch(NAME))).toBe(
          true
        )
        for (let generation = 0; generation <= MAX_GENERATION; generation++) {
          expect(ledger.shouldDeleteSecret(ref(generation, 'uid-1'))).toBe(generation > recorded)
          expect(ledger.shouldDeleteSecret(ref(generation, 'uid-2'))).toBe(true)
        }
      }),
      { numRuns: 500 }
    )
  })

  it('I5 the NetworkPolicy side honours the TTL and a uid or generation change', () => {
    fc.assert(
      fc.property(
        fc.record({
          uid: fc.constantFrom('uid-1', 'uid-2'),
          generation: generationArb,
          recordedAt: fc.integer({ min: 0, max: 10 * OAUTH_BROKER_NP_TTL_MS }),
        }),
        fc.record({
          uid: fc.constantFrom('uid-1', 'uid-2'),
          generation: generationArb,
          elapsed: fc.oneof(
            fc.integer({ min: 0, max: OAUTH_BROKER_NP_TTL_MS - 1 }),
            fc.integer({ min: OAUTH_BROKER_NP_TTL_MS, max: 2 * OAUTH_BROKER_NP_TTL_MS })
          ),
        }),
        (recorded, query) => {
          const ledger = new OAuthBrokerDeleteLedger()
          ledger.recordPolicyDelete(ref(recorded.generation, recorded.uid), recorded.recordedAt)
          const answer = ledger.shouldDeletePolicy(
            ref(query.generation, query.uid),
            recorded.recordedAt + query.elapsed
          )
          const covered =
            query.uid === recorded.uid &&
            query.generation <= recorded.generation &&
            query.elapsed < OAUTH_BROKER_NP_TTL_MS
          expect(answer, `I5 ${JSON.stringify({ recorded, query })}`).toBe(!covered)
        }
      ),
      { numRuns: 5000 }
    )
  })

  it('I5 over recordPolicyDelete sequences: a late lower generation keeps the watermark, a new uid replaces it', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            uid: fc.constantFrom('uid-1', 'uid-2'),
            generation: generationArb,
            advance: fc.integer({ min: 0, max: OAUTH_BROKER_NP_TTL_MS / 2 }),
          }),
          { minLength: 1, maxLength: 12 }
        ),
        fc.integer({ min: 0, max: 2 * OAUTH_BROKER_NP_TTL_MS }),
        (records, elapsed) => {
          const ledger = new OAuthBrokerDeleteLedger()
          let now = 0
          let observed: { uid: string; generation: number; at: number } | undefined
          for (const record of records) {
            now += record.advance
            ledger.recordPolicyDelete(ref(record.generation, record.uid), now)
            observed =
              observed !== undefined && observed.uid === record.uid
                ? {
                    uid: record.uid,
                    generation: Math.max(observed.generation, record.generation),
                    at: now,
                  }
                : { uid: record.uid, generation: record.generation, at: now }
            for (const uid of ['uid-1', 'uid-2']) {
              for (let generation = 0; generation <= MAX_GENERATION; generation++) {
                const at = now + elapsed
                const covered =
                  uid === observed.uid &&
                  generation <= observed.generation &&
                  at < observed.at + OAUTH_BROKER_NP_TTL_MS
                expect(
                  ledger.shouldDeletePolicy(ref(generation, uid), at),
                  `I5 seq ${JSON.stringify({ records, elapsed, uid, generation })}`
                ).toBe(!covered)
              }
            }
          }
        }
      ),
      { numRuns: 2000 }
    )
  })
})
