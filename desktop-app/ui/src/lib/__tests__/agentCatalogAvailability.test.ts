import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { resolveAgentCatalogAvailability } from '../agentCatalogAvailability'

describe('resolveAgentCatalogAvailability', () => {
  it('keeps a selected agent checking while a catalog request is active', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.string(), (agent, previousError) => {
        expect(
          resolveAgentCatalogAvailability({
            selectedAgent: agent,
            loading: true,
            error: previousError,
            catalogMatchesSession: false,
            agentNames: [agent],
          })
        ).toBe('checking')
      }),
      { numRuns: 250 }
    )
  })

  it('reports a settled query error ahead of any cached catalog scope', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.boolean(),
        fc.array(fc.string()),
        (selectedAgent, catalogMatchesSession, agentNames) => {
          expect(
            resolveAgentCatalogAvailability({
              selectedAgent,
              loading: false,
              error: 'catalog unavailable',
              catalogMatchesSession,
              agentNames,
            })
          ).toBe('error')
        }
      ),
      { numRuns: 500 }
    )
  })

  it('allows availability only from a settled, error-free current catalog', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        (selectedAgent, loading, hasError, catalogMatchesSession) => {
          const error = hasError ? 'catalog unavailable' : null
          const canUseCatalog = !loading && !hasError && catalogMatchesSession
          const result = resolveAgentCatalogAvailability({
            selectedAgent,
            loading,
            error,
            catalogMatchesSession,
            agentNames: [selectedAgent],
          })

          expect(result === 'available').toBe(canUseCatalog)
          if (result !== 'available') expect(result).not.toBe('ready')
        }
      ),
      { numRuns: 500 }
    )
  })

  it('requires explicit selection when a settled current catalog omits the retained agent', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.array(fc.string()), (agent, names) => {
        expect(
          resolveAgentCatalogAvailability({
            selectedAgent: agent,
            loading: false,
            error: null,
            catalogMatchesSession: true,
            agentNames: names.filter(name => name !== agent),
          })
        ).toBe('unavailable')
      }),
      { numRuns: 250 }
    )
  })

  it('does not show catalog status when no agent is selected', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), (loading, hasError) => {
        expect(
          resolveAgentCatalogAvailability({
            selectedAgent: null,
            loading,
            error: hasError ? 'catalog unavailable' : null,
            catalogMatchesSession: false,
            agentNames: [],
          })
        ).toBe('ready')
      }),
      { numRuns: 100 }
    )
  })
})
