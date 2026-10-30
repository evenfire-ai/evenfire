import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { resolveAgentCatalogAvailability } from '../agentCatalogAvailability'

describe('resolveAgentCatalogAvailability', () => {
  it('keeps a selected agent checking when a catalog request has no confirmed current-scope data', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), agent => {
        expect(
          resolveAgentCatalogAvailability({
            selectedAgent: agent,
            loading: true,
            error: null,
            catalogMatchesSession: false,
            agentNames: [agent],
          })
        ).toBe('checking')
      }),
      { numRuns: 250 }
    )
  })

  it('keeps unclassified settled errors blocked even with a matching cached catalog', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), selectedAgent => {
        expect(
          resolveAgentCatalogAvailability({
            selectedAgent,
            loading: false,
            error: 'catalog unavailable',
            catalogMatchesSession: true,
            agentNames: [selectedAgent],
          })
        ).toBe('error')
      }),
      { numRuns: 250 }
    )
  })

  it('keeps a confirmed current-scope agent available during an ordinary catalog refresh', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), selectedAgent => {
        expect(
          resolveAgentCatalogAvailability({
            selectedAgent,
            loading: true,
            error: null,
            catalogMatchesSession: true,
            agentNames: [selectedAgent, 'another-agent'],
          })
        ).toBe('available')
      }),
      { numRuns: 250 }
    )
  })

  it('keeps a confirmed current-scope agent available after a parsed HTTP 5xx refresh failure', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 500, max: 599 }),
        fc.string({ minLength: 1 }),
        (status, selectedAgent) => {
          expect(
            resolveAgentCatalogAvailability({
              selectedAgent,
              loading: false,
              error: `Error invoking remote method 'access:refreshCatalog': Error: ${status} Server Error: producer body`,
              catalogMatchesSession: true,
              agentNames: [selectedAgent, 'another-agent'],
            })
          ).toBe('available')
        }
      ),
      { numRuns: 250 }
    )
  })

  it('keeps a confirmed current-scope agent available after a network refresh failure', () => {
    expect(
      resolveAgentCatalogAvailability({
        selectedAgent: 'agent-x',
        loading: false,
        error: "Error invoking remote method 'access:refreshCatalog': TypeError: fetch failed",
        catalogMatchesSession: true,
        agentNames: ['agent-x', 'agent-y'],
      })
    ).toBe('available')
  })

  it('does not use a transient failure to grant an agent outside the confirmed catalog scope', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), selectedAgent => {
        expect(
          resolveAgentCatalogAvailability({
            selectedAgent,
            loading: false,
            error: 'Error invoking remote method: Error: 500 Server Error',
            catalogMatchesSession: false,
            agentNames: [selectedAgent],
          })
        ).toBe('error')
      }),
      { numRuns: 250 }
    )
  })

  it.each([400, 401, 403, 404])(
    'keeps a confirmed catalog blocked after non-server HTTP %i failures',
    status => {
      expect(
        resolveAgentCatalogAvailability({
          selectedAgent: 'agent-x',
          loading: true,
          error: `Error invoking remote method 'access:refreshCatalog': Error: ${status} HTTP Error: producer body`,
          catalogMatchesSession: true,
          agentNames: ['agent-x'],
        })
      ).toBe('error')
    }
  )

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
