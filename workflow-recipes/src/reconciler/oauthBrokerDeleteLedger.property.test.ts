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
 *
 * I1  No token ADDED since the process started or the recipe was deleted:
 *     no Secret delete.
 * I2  After an ADDED with no later recorded delete or provisioning, a pass
 *     at or above the watermark (the highest generation recorded or
 *     provisioned since the recipe was last deleted) deletes.
 * I3  A pass below the highest generation that provisioned the token does
 *     not delete it.
 * I4  A delete whose DELETE was sent before an ADDED (or a recipe deletion)
 *     records nothing; with neither in between it is recorded.
 * I5  The NetworkPolicy side skips the recorded pass until the TTL expires,
 *     and deletes for a different uid or a higher generation.
 */

const NAME = 'r'
const UID = 'uid-1'
const MAX_GENERATION = 6

type Op =
  | { kind: 'provision'; generation: number }
  | { kind: 'pass'; generation: number }
  | { kind: 'beginDelete'; generation: number }
  | { kind: 'endDelete'; failed: boolean }
  | { kind: 'invalidateSecret' }
  | { kind: 'addedElsewhere' }
  | { kind: 'invalidate' }

const generationArb = fc.integer({ min: 0, max: MAX_GENERATION })

const opArb: fc.Arbitrary<Op> = fc.oneof(
  generationArb.map(generation => ({ kind: 'provision' as const, generation })),
  generationArb.map(generation => ({ kind: 'pass' as const, generation })),
  generationArb.map(generation => ({ kind: 'beginDelete' as const, generation })),
  fc.boolean().map(failed => ({ kind: 'endDelete' as const, failed })),
  fc.constant({ kind: 'invalidateSecret' as const }),
  fc.constant({ kind: 'addedElsewhere' as const }),
  fc.constant({ kind: 'invalidate' as const })
)

function ref(generation: number, uid = UID): OAuthBrokerLedgerRecipe {
  return { name: NAME, uid, generation }
}

/** What a caller observed; never the ledger's internal entry. */
interface Observed {
  tokenSeen: boolean
  /** Highest generation recorded or provisioned since the last recipe deletion. */
  watermark: number
  /** Highest generation provisioned since the last recipe deletion. */
  provisioned: number
  /** An ADDED landed after the last recorded delete or provisioning. */
  addedAfterLastWrite: boolean
  inFlight?: { generation: number; epoch: number; raced: boolean }
}

function freshObserved(): Observed {
  return { tokenSeen: false, watermark: -1, provisioned: -1, addedAfterLastWrite: false }
}

function allAnswers(ledger: OAuthBrokerDeleteLedger): boolean[] {
  const answers: boolean[] = []
  for (const uid of [UID, 'uid-2']) {
    for (let generation = 0; generation <= MAX_GENERATION; generation++) {
      answers.push(ledger.shouldDeleteSecret(ref(generation, uid)))
    }
  }
  return answers
}

function checkPass(ledger: OAuthBrokerDeleteLedger, seen: Observed, generation: number): void {
  const answer = ledger.shouldDeleteSecret(ref(generation))
  const where = `gen${generation} observed=${JSON.stringify(seen)}`
  if (!seen.tokenSeen) expect(answer, `I1 ${where}`).toBe(false)
  if (generation < seen.provisioned) expect(answer, `I3 ${where}`).toBe(false)
  if (seen.tokenSeen && seen.addedAfterLastWrite && generation >= seen.watermark) {
    expect(answer, `I2 ${where}`).toBe(true)
  }
}

function step(ledger: OAuthBrokerDeleteLedger, seen: Observed, op: Op): void {
  switch (op.kind) {
    case 'provision':
      ledger.noteSecretProvisioned(ref(op.generation))
      seen.provisioned = Math.max(seen.provisioned, op.generation)
      seen.watermark = Math.max(seen.watermark, op.generation)
      seen.addedAfterLastWrite = false
      return
    case 'pass':
      checkPass(ledger, seen, op.generation)
      return
    case 'beginDelete':
      // The WRC sends the DELETE only when the ledger allows it, and the
      // per-recipe queue keeps one in flight.
      if (seen.inFlight || !ledger.shouldDeleteSecret(ref(op.generation))) return
      seen.inFlight = {
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
      const before = allAnswers(ledger)
      const recorded = ledger.recordSecretDelete(ref(inFlight.generation), inFlight.epoch)
      if (inFlight.raced) {
        expect(recorded, `I4 raced gen${inFlight.generation}`).toBe(false)
        expect(allAnswers(ledger), `I4 records nothing gen${inFlight.generation}`).toEqual(before)
        return
      }
      // Liveness witness for I4: an undisturbed delete is recorded.
      expect(recorded, `I4 undisturbed gen${inFlight.generation}`).toBe(true)
      seen.watermark = Math.max(seen.watermark, inFlight.generation)
      seen.addedAfterLastWrite = false
      return
    }
    case 'invalidateSecret':
      ledger.invalidateSecret(NAME)
      seen.tokenSeen = true
      seen.addedAfterLastWrite = true
      if (seen.inFlight) seen.inFlight.raced = true
      return
    case 'addedElsewhere':
      ledger.invalidateSecret('other')
      return
    case 'invalidate': {
      ledger.invalidate(NAME)
      const inFlight = seen.inFlight
      Object.assign(seen, freshObserved())
      if (inFlight) seen.inFlight = { ...inFlight, raced: true }
      return
    }
  }
}

describe('OAuthBrokerDeleteLedger observable properties', () => {
  it('I1-I4 hold over provision, pass, beginDelete/endDelete, invalidateSecret and invalidate', () => {
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
        ledger.noteSecretProvisioned(ref(provisioned))
        ledger.invalidateSecret(NAME)
        for (let generation = 0; generation <= MAX_GENERATION; generation++) {
          expect(ledger.shouldDeleteSecret(ref(generation))).toBe(generation >= provisioned)
        }
      }),
      { numRuns: 500 }
    )
  })

  it('I5 the NetworkPolicy side honours the TTL and a uid or generation change', () => {
    fc.assert(
      fc.property(
        fc.record({
          uid: fc.constantFrom(UID, 'uid-2'),
          generation: generationArb,
          recordedAt: fc.integer({ min: 0, max: 10 * OAUTH_BROKER_NP_TTL_MS }),
        }),
        fc.record({
          uid: fc.constantFrom(UID, 'uid-2'),
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
})
