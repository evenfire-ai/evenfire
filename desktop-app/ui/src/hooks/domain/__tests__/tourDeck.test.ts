import { describe, expect, it } from 'vitest'
import { type TourCensus, selectTourSteps } from '../tourDeck'

const census = (overrides: Partial<TourCensus> = {}): TourCensus => ({
  agentNames: [],
  mcpServersByAgent: {},
  ...overrides,
})

describe('selectTourSteps', () => {
  it('always opens on Welcome and ends on Handoff', () => {
    const steps = selectTourSteps(census())
    expect(steps[0]).toBe('welcome')
    expect(steps[steps.length - 1]).toBe('handoff')
  })

  it('gives a user with no agents the always-available capabilities', () => {
    // An invited member whose admin has not authorized them can still add
    // tools and use the file system; nothing here claims an agent they
    // cannot reach.
    expect(selectTourSteps(census())).toEqual([
      'welcome',
      'mcpServers',
      'files',
      'apps',
      'desktop',
      'handoff',
    ])
  })

  it('gives a seeded install its agent plus the always-available capabilities', () => {
    const steps = selectTourSteps(census({ agentNames: ['chatllm'] }))

    expect(steps).toEqual(['welcome', 'agents', 'mcpServers', 'files', 'apps', 'handoff'])
    // No connectors means the agent never asks for approval.
    expect(steps).not.toContain('approvals')
  })

  it('offers Approvals once an agent actually has a connector', () => {
    const steps = selectTourSteps(
      census({ agentNames: ['a'], mcpServersByAgent: { a: ['github'] } })
    )

    expect(steps).toContain('approvals')
  })

  it('caps a rich environment at six steps, keeping the highest-priority four', () => {
    const steps = selectTourSteps(
      census({ agentNames: ['a'], mcpServersByAgent: { a: ['github'] } })
    )

    // Everything qualifies; Apps and Desktop lose their slots.
    expect(steps).toEqual(['welcome', 'agents', 'approvals', 'mcpServers', 'files', 'handoff'])
    expect(steps).toHaveLength(6)
  })

  it('runs to the same length whatever the census says', () => {
    // Four middle candidates are unconditional, so the census can only change
    // which cards appear. A deck that came back shorter would mean a candidate
    // had silently become conditional.
    const censuses = [
      census(),
      census({ agentNames: ['a'] }),
      census({ mcpServersByAgent: { a: ['github'] } }),
      census({ agentNames: ['a'], mcpServersByAgent: { a: ['github'] } }),
    ]

    for (const c of censuses) {
      expect(selectTourSteps(c)).toHaveLength(6)
    }
  })

  it('leaves no candidate unreachable', () => {
    // Scope and Plugins were dead for exactly this reason: they were ranked
    // below four unconditional candidates, so the slots always ran out first
    // and their copy shipped to nobody. Every id the deck knows about has to
    // appear for some census.
    const reachable = new Set(
      [
        census(),
        census({ agentNames: ['a'] }),
        census({ mcpServersByAgent: { a: ['github'] } }),
        census({ agentNames: ['a'], mcpServersByAgent: { a: ['github'] } }),
      ].flatMap(selectTourSteps)
    )

    expect([...reachable].sort()).toEqual([
      'agents',
      'approvals',
      'apps',
      'desktop',
      'files',
      'handoff',
      'mcpServers',
      'welcome',
    ])
  })

  it('keeps canonical order regardless of which steps qualify', () => {
    const steps = selectTourSteps(census())

    // No agents and no connectors, so the four always-available cards take the
    // middle slots — in table order.
    expect(steps).toEqual(['welcome', 'mcpServers', 'files', 'apps', 'desktop', 'handoff'])
  })
})
