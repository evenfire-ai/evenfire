import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { OAuthBrokerDeleteLedger, type OAuthBrokerLedgerRecipe } from './oauthBrokerDeleteLedger'

const NAMES = ['a', 'b'] as const
const UIDS = ['uid-1', 'uid-2', 'uid-3'] as const
const MAX_GENERATION = 6

type Op =
  | { kind: 'record'; recipe: OAuthBrokerLedgerRecipe }
  | { kind: 'provision'; recipe: OAuthBrokerLedgerRecipe }
  | { kind: 'invalidateSecret'; name: string }
  | { kind: 'invalidate'; name: string }

/** What the ledger must remember per recipe name for the Secret side. */
interface ModelEntry {
  uid: string
  watermark: number
  /** An ADDED landed after the last delete recorded at the watermark. */
  rearmed: boolean
}

const recipeArb = fc.record({
  name: fc.constantFrom(...NAMES),
  uid: fc.constantFrom(...UIDS),
  generation: fc.integer({ min: 0, max: MAX_GENERATION }),
})

const opArb: fc.Arbitrary<Op> = fc.oneof(
  recipeArb.map(recipe => ({ kind: 'record' as const, recipe })),
  recipeArb.map(recipe => ({ kind: 'provision' as const, recipe })),
  fc.constantFrom(...NAMES).map(name => ({ kind: 'invalidateSecret' as const, name })),
  fc.constantFrom(...NAMES).map(name => ({ kind: 'invalidate' as const, name }))
)

function allQueries(): OAuthBrokerLedgerRecipe[] {
  const queries: OAuthBrokerLedgerRecipe[] = []
  for (const name of NAMES) {
    for (const uid of UIDS) {
      for (let generation = 0; generation <= MAX_GENERATION; generation++) {
        queries.push({ name, uid, generation })
      }
    }
  }
  return queries
}

const QUERIES = allQueries()

function answers(ledger: OAuthBrokerDeleteLedger): boolean[] {
  return QUERIES.map(query => ledger.shouldDeleteSecret(query))
}

function record(ledger: OAuthBrokerDeleteLedger, recipe: OAuthBrokerLedgerRecipe): void {
  // Sequential operations: no invalidation lands while the DELETE is in flight.
  expect(ledger.recordSecretDelete(recipe, ledger.secretEpoch(recipe.name))).toBe(true)
}

function apply(ledger: OAuthBrokerDeleteLedger, op: Op): void {
  if (op.kind === 'record') record(ledger, op.recipe)
  else if (op.kind === 'provision') ledger.noteSecretProvisioned(op.recipe)
  else if (op.kind === 'invalidateSecret') ledger.invalidateSecret(op.name)
  else ledger.invalidate(op.name)
}

/** A recorded delete and a provisioned token raise the watermark the same way. */
function applyToModel(model: Map<string, ModelEntry>, seen: Set<string>, op: Op): void {
  if (op.kind === 'invalidate') {
    model.delete(op.name)
    seen.delete(op.name)
    return
  }
  if (op.kind === 'invalidateSecret') {
    seen.add(op.name)
    const entry = model.get(op.name)
    if (entry) entry.rearmed = true
    return
  }
  const { name, uid, generation = 0 } = op.recipe
  const entry = model.get(name)
  if (!entry || entry.uid !== uid) {
    model.set(name, { uid: uid as string, watermark: generation, rearmed: false })
  } else if (generation >= entry.watermark) {
    model.set(name, { uid: entry.uid, watermark: generation, rearmed: false })
  }
}

function checkAgainstModel(
  ledger: OAuthBrokerDeleteLedger,
  model: Map<string, ModelEntry>,
  seen: Set<string>
): void {
  for (const query of QUERIES) {
    const entry = model.get(query.name)
    const generation = query.generation ?? 0
    const actual = ledger.shouldDeleteSecret(query)
    const where = `${query.name}/${query.uid}/gen${generation} model=${JSON.stringify(entry)}`

    // No token ADDED since the process started or the recipe was deleted:
    // there is no token to reap.
    if (!seen.has(query.name)) {
      expect(actual, `no token seen must skip: ${where}`).toBe(false)
      continue
    }
    // A recipe never recorded, or recreated under the same name, always deletes.
    if (!entry || entry.uid !== query.uid) {
      expect(actual, `uid change must delete: ${where}`).toBe(true)
      continue
    }
    if (generation < entry.watermark) {
      // Monotonic watermark: an older generation stays covered, including
      // after an ADDED invalidation.
      expect(actual, `below the watermark must skip: ${where}`).toBe(false)
    } else if (generation > entry.watermark) {
      expect(actual, `above the watermark must delete: ${where}`).toBe(true)
    } else {
      expect(actual, `at the watermark deletes only when re-armed: ${where}`).toBe(entry.rearmed)
    }
  }
}

describe('OAuthBrokerDeleteLedger Secret-side properties', () => {
  it('matches the token-seen / uid / watermark / re-arm model over record, provision, invalidateSecret and invalidate', () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 30 }), ops => {
        const ledger = new OAuthBrokerDeleteLedger()
        const model = new Map<string, ModelEntry>()
        const seen = new Set<string>()
        for (const op of ops) {
          apply(ledger, op)
          applyToModel(model, seen, op)
          checkAgainstModel(ledger, model, seen)
        }
      }),
      { numRuns: 5000 }
    )
  })

  it('record is idempotent', () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 30 }), recipeArb, (ops, recipe) => {
        const ledger = new OAuthBrokerDeleteLedger()
        for (const op of ops) apply(ledger, op)
        record(ledger, recipe)
        const once = answers(ledger)
        record(ledger, recipe)
        expect(answers(ledger)).toEqual(once)
        // Liveness witness: the recorded pass itself is now skipped.
        expect(ledger.shouldDeleteSecret(recipe)).toBe(false)
      }),
      { numRuns: 5000 }
    )
  })

  it('an invalidation re-arms only generations at or above the watermark', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...UIDS),
        fc.integer({ min: 1, max: MAX_GENERATION }),
        (uid, watermark) => {
          const ledger = new OAuthBrokerDeleteLedger()
          ledger.invalidateSecret('a')
          record(ledger, { name: 'a', uid, generation: watermark })
          ledger.invalidateSecret('a')
          for (let generation = 0; generation <= MAX_GENERATION; generation++) {
            expect(ledger.shouldDeleteSecret({ name: 'a', uid, generation })).toBe(
              generation >= watermark
            )
          }
        }
      ),
      { numRuns: 500 }
    )
  })
})
