import { describe, expect, it } from 'vitest'
import { type TourCensus, selectTourSteps } from '../tourDeck'

const census = (overrides: Partial<TourCensus> = {}): TourCensus => ({
  agentNames: [],
  contextIds: [],
  mcpServersByAgent: {},
  ...overrides,
})

describe('selectTourSteps', () => {
  it('always opens on Welcome and ends on Handoff', () => {
    const steps = selectTourSteps(census())
    expect(steps[0]).toBe('welcome')
    expect(steps[steps.length - 1]).toBe('handoff')
  })

  it('gives a user with nothing the three-step tour', () => {
    // An invited member whose admin has not authorized them: no step may
    // mention a capability they cannot reach.
    expect(selectTourSteps(census())).toEqual(['welcome', 'desktop', 'handoff'])
  })

  it('gives a seeded install Agents and Scope, but not Approvals or Apps', () => {
    const steps = selectTourSteps(census({ agentNames: ['chatllm'], contextIds: ['context1'] }))

    expect(steps).toEqual(['welcome', 'agents', 'scope', 'desktop', 'handoff'])
    // No connectors means the agent never asks for approval.
    expect(steps).not.toContain('approvals')
    expect(steps).not.toContain('apps')
  })

  it('offers Approvals once an agent actually has a connector', () => {
    const steps = selectTourSteps(
      census({ agentNames: ['a'], mcpServersByAgent: { a: ['github'] } })
    )

    expect(steps).toContain('approvals')
  })

  it('caps a rich environment at six steps, keeping the highest-priority four', () => {
    const steps = selectTourSteps(
      census({
        agentNames: ['a'],
        contextIds: ['c'],
        mcpServersByAgent: { a: ['github'] },
        sandboxUiAppCount: 3,
        workflowCount: 4,
        gfsRootCount: 2,
      })
    )

    // Everything qualifies; Plugins, Files and Desktop lose their slots.
    expect(steps).toEqual(['welcome', 'agents', 'approvals', 'scope', 'apps', 'handoff'])
    expect(steps).toHaveLength(6)
  })

  it('treats an unresolved app, plugin, or GFS source as absent', () => {
    // Undefined means "the query has not resolved". The tour shows fewer steps
    // rather than waiting on it.
    const unresolved = selectTourSteps(census({ agentNames: ['a'] }))
    const resolvedEmpty = selectTourSteps(
      census({ agentNames: ['a'], sandboxUiAppCount: 0, workflowCount: 0, gfsRootCount: 0 })
    )

    expect(unresolved).toEqual(resolvedEmpty)
    expect(unresolved).not.toContain('apps')
    expect(unresolved).not.toContain('plugins')
    expect(unresolved).not.toContain('files')
  })

  it('keeps canonical order regardless of which steps qualify', () => {
    const steps = selectTourSteps(
      census({ sandboxUiAppCount: 1, workflowCount: 1, gfsRootCount: 1 })
    )

    // No agents and no contexts, so the eligible middle steps are apps,
    // plugins, files and desktop — in table order, not census order.
    expect(steps).toEqual(['welcome', 'apps', 'plugins', 'files', 'desktop', 'handoff'])
  })
})
