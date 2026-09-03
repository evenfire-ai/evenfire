import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { deriveEffectiveSpend } from '../src/services/pluginWorkloadSdkFinalization.js'
import { isOauthBrokerProvider } from '../src/services/pluginWorkloadSdkSpendLedger.js'

/**
 * `deriveEffectiveSpend` is a pure `(floor, linkedCodex) -> spend` merge
 * with precedence rules, and it was covered only by hand-enumerated cases.
 * Two sibling defects in that merge were both cases enumeration missed — the shape
 * of that miss is what these properties close: they quantify over the whole
 * input space instead of the examples someone thought of.
 */

const OUTCOMES = ['exact', 'unknown', 'not_executed'] as const
const PROVIDERS = ['codex-subscription', 'openai', 'zai'] as const
const LINKED_OUTCOMES = ['success', 'error', 'canceled', 'unknown'] as const

/** A persisted floor row that always satisfies the table's token_pair_check. */
const persistedArb = fc
  .record({
    provider: fc.constantFrom(...PROVIDERS),
    outcome: fc.constantFrom(...OUTCOMES),
    tokens: fc.tuple(fc.nat({ max: 100_000 }), fc.nat({ max: 100_000 })),
  })
  .map(({ provider, outcome, tokens }) => ({
    provider,
    outcome,
    input_tokens: outcome === 'exact' ? tokens[0] : null,
    output_tokens: outcome === 'exact' ? tokens[1] : null,
  }))

const linkedArb = fc.option(
  fc.record({
    outcome: fc.constantFrom(...LINKED_OUTCOMES),
    usageInputTokens: fc.option(fc.nat({ max: 100_000 }), { nil: null }),
    usageOutputTokens: fc.option(fc.nat({ max: 100_000 }), { nil: null }),
  }),
  { nil: null }
)

/** Round-trip a derived spend back into the row shape it would be read from. */
function asRow(provider: string, spend: ReturnType<typeof deriveEffectiveSpend>) {
  return {
    provider,
    outcome: spend.outcome,
    input_tokens: spend.inputTokens,
    output_tokens: spend.outputTokens,
  }
}

describe('deriveEffectiveSpend properties', () => {
  it('is terminal for exact and not_executed floors', () => {
    fc.assert(
      fc.property(persistedArb, linkedArb, (persisted, linked) => {
        fc.pre(persisted.outcome !== 'unknown')
        const derived = deriveEffectiveSpend(persisted, linked)
        expect(derived.outcome).toBe(persisted.outcome)
        if (persisted.outcome === 'exact') {
          expect(derived.inputTokens).toBe(persisted.input_tokens)
          expect(derived.outputTokens).toBe(persisted.output_tokens)
        }
      })
    )
  })

  it('only ever lifts unknown, and only to exact backed by a complete token pair', () => {
    fc.assert(
      fc.property(persistedArb, linkedArb, (persisted, linked) => {
        fc.pre(persisted.outcome === 'unknown')
        const derived = deriveEffectiveSpend(persisted, linked)
        expect(['unknown', 'exact']).toContain(derived.outcome)

        const liftable =
          isOauthBrokerProvider(persisted.provider) &&
          linked?.outcome === 'success' &&
          Number.isInteger(linked.usageInputTokens) &&
          Number.isInteger(linked.usageOutputTokens)
        expect(derived.outcome === 'exact').toBe(Boolean(liftable))
      })
    )
  })

  it('never derives anything for a non-oauth-broker provider', () => {
    fc.assert(
      fc.property(persistedArb, linkedArb, (persisted, linked) => {
        fc.pre(!isOauthBrokerProvider(persisted.provider))
        expect(deriveEffectiveSpend(persisted, linked).outcome).toBe(persisted.outcome)
      })
    )
  })

  it('is idempotent: deriving from an already-derived row changes nothing', () => {
    fc.assert(
      fc.property(persistedArb, linkedArb, (persisted, linked) => {
        const once = deriveEffectiveSpend(persisted, linked)
        const twice = deriveEffectiveSpend(asRow(persisted.provider, once), linked)
        expect(twice).toEqual(once)
      })
    )
  })

  it('never fabricates a partial token pair', () => {
    fc.assert(
      fc.property(persistedArb, linkedArb, (persisted, linked) => {
        const { outcome, inputTokens, outputTokens } = deriveEffectiveSpend(persisted, linked)
        expect(outcome === 'exact').toBe(inputTokens !== null)
        expect(inputTokens === null).toBe(outputTokens === null)
      })
    )
  })
})
