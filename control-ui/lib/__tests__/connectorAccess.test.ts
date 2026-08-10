import { describe, expect, it } from 'vitest'
import type { ConnectorAccessSummary } from '../../components/McpServerTable.types'
import { contextNamesForConnector, mergeAccessSummaries } from '../connectorAccess'

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]]
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map(rest => [item, ...rest])
  )
}

describe('mergeAccessSummaries invariants', () => {
  const summaries: ConnectorAccessSummary[] = [
    {
      agents: [{ id: 'agent-b', label: 'Beta' }],
      teams: [{ id: 'team-1', label: 'Platform' }],
      users: [{ id: 'user-1', label: 'Grace' }],
    },
    {
      agents: [
        { id: 'agent-a', label: 'Alpha' },
        { id: 'agent-b', label: 'Beta duplicate' },
      ],
      teams: [{ id: 'team-2', label: 'Research' }],
      users: [{ id: 'user-2', label: 'Ada' }],
    },
    {
      agents: [],
      teams: [{ id: 'team-1', label: 'Platform duplicate' }],
      users: [{ id: 'user-1', label: 'Grace duplicate' }],
    },
  ]

  it('preserves every principal id exactly once and orders each group deterministically', () => {
    const merged = mergeAccessSummaries(summaries)

    expect(merged.agents.map(item => item.id)).toEqual(['agent-a', 'agent-b'])
    expect(merged.teams.map(item => item.id)).toEqual(['team-1', 'team-2'])
    expect(merged.users.map(item => item.id)).toEqual(['user-2', 'user-1'])
    for (const group of Object.values(merged)) {
      expect(new Set(group.map(item => item.id)).size).toBe(group.length)
    }
  })

  it('is stable across input permutations and idempotent after reconciliation', () => {
    const expected = mergeAccessSummaries(summaries)
    for (const order of permutations(summaries)) {
      expect(mergeAccessSummaries(order)).toEqual(expected)
    }
    expect(mergeAccessSummaries([expected, expected])).toEqual(expected)
  })
})

describe('contextNamesForConnector invariants', () => {
  const contexts = [
    {
      metadata: { name: 'zeta' },
      spec: { contextId: 'zeta', mcpServers: ['search'] },
    },
    {
      metadata: { name: 'alpha' },
      spec: { contextId: 'alpha', mcpServers: ['search', 'other'] },
    },
    {
      metadata: { name: 'unused' },
      spec: { contextId: 'unused', mcpServers: [] },
    },
  ]

  it('is unique, sorted, permutation-stable, and ignores legacy connector contextRef state', () => {
    const expected = ['alpha', 'zeta']
    for (const order of permutations(contexts)) {
      expect(contextNamesForConnector(order, 'search')).toEqual(expected)
    }
    expect(contextNamesForConnector(contexts, 'removed-from-all-contexts')).toEqual([])
  })
})
