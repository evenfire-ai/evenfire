import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import type { ConnectorAccessSummary } from '../../components/McpServerTable.types'
import type { ContextResource } from '../api'
import {
  contextNamesForConnector,
  mergeAccessSummaries,
  sortAccessPrincipals,
} from '../connectorAccess'

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]]
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map(rest => [item, ...rest])
  )
}

const shortString = fc.string({ maxLength: 16 })
const principalArbitrary = fc.record({ id: shortString, label: shortString })
const accessSummaryArbitrary: fc.Arbitrary<ConnectorAccessSummary> = fc.record({
  agents: fc.array(principalArbitrary, { maxLength: 12 }),
  users: fc.array(principalArbitrary, { maxLength: 12 }),
  teams: fc.array(principalArbitrary, { maxLength: 12 }),
})

const accessGroups = ['agents', 'users', 'teams'] as const

function comparePrincipals(
  left: { id: string; label: string },
  right: { id: string; label: string }
) {
  return left.label.localeCompare(right.label) || left.id.localeCompare(right.id)
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

  it('uniquely preserves and deterministically orders arbitrary principal unions', () => {
    fc.assert(
      fc.property(fc.array(accessSummaryArbitrary, { maxLength: 20 }), summaries => {
        const merged = mergeAccessSummaries(summaries)

        for (const group of accessGroups) {
          const inputIds = new Set(
            summaries.flatMap(summary => summary[group].map(item => item.id))
          )
          const outputIds = merged[group].map(item => item.id)
          expect(new Set(outputIds).size).toBe(outputIds.length)
          expect(new Set(outputIds)).toEqual(inputIds)
          expect(merged[group]).toEqual(sortAccessPrincipals(merged[group]))
          expect(merged[group]).toEqual([...merged[group]].sort(comparePrincipals))
        }

        expect(mergeAccessSummaries([merged])).toEqual(merged)
      })
    )
  })

  it('is permutation-stable and idempotent for arbitrary summaries', () => {
    fc.assert(
      fc.property(
        fc.array(accessSummaryArbitrary, { maxLength: 15 }).chain(summaries =>
          fc
            .shuffledSubarray(summaries, {
              minLength: summaries.length,
              maxLength: summaries.length,
            })
            .map(shuffled => ({ shuffled, summaries }))
        ),
        ({ shuffled, summaries }) => {
          expect(mergeAccessSummaries(shuffled)).toEqual(mergeAccessSummaries(summaries))
          if (summaries.length > 0) {
            const [summary] = summaries
            expect(mergeAccessSummaries([summary, summary])).toEqual(
              mergeAccessSummaries([summary])
            )
          }
        }
      )
    )
  })

  it('chooses the compare-min principal for duplicate ids regardless of order', () => {
    fc.assert(
      fc.property(shortString, shortString, shortString, (id, firstLabel, secondLabel) => {
        const first = { id, label: firstLabel }
        const second = { id, label: secondLabel }
        const expected = [first, second].sort(comparePrincipals)[0]
        const summary = (agents: (typeof first)[]): ConnectorAccessSummary => ({
          agents,
          users: [],
          teams: [],
        })

        expect(mergeAccessSummaries([summary([first, second])]).agents).toEqual([expected])
        expect(mergeAccessSummaries([summary([second, first])]).agents).toEqual([expected])
      })
    )
  })

  it('sorts arbitrary principals deterministically without mutating the input', () => {
    fc.assert(
      fc.property(fc.array(principalArbitrary, { maxLength: 50 }), principals => {
        const snapshot = principals.map(principal => ({ ...principal }))
        const expected = [...principals].sort(comparePrincipals)

        expect(sortAccessPrincipals(principals)).toEqual(expected)
        expect(sortAccessPrincipals(principals)).toEqual(sortAccessPrincipals(principals))
        expect(principals).toEqual(snapshot)
      })
    )
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

  it('returns only unique, non-blank, sorted names from arbitrary current allowlists', () => {
    const contextArbitrary: fc.Arbitrary<ContextResource> = shortString.chain(contextName =>
      fc.record({
        metadata: fc.constant({ name: contextName }),
        spec: fc.record({
          contextId: fc.constant(contextName),
          description: shortString,
          mcpServers: fc.array(shortString, { maxLength: 12 }),
          sharedFileSystems: fc.constant([]),
        }),
        status: fc.constant({ sharedFileSystems: [] }),
      })
    )

    fc.assert(
      fc.property(
        fc.array(contextArbitrary, { maxLength: 30 }),
        shortString,
        (generatedContexts, connectorName) => {
          const actual = contextNamesForConnector(generatedContexts, connectorName)
          const expected = Array.from(
            new Set(
              generatedContexts
                .filter(context => context.spec?.mcpServers.includes(connectorName))
                .map(context => String(context.metadata?.name ?? '').trim())
                .filter(Boolean)
            )
          ).sort((left, right) => left.localeCompare(right))

          expect(actual).toEqual(expected)
          expect(actual.every(contextName => contextName.trim().length > 0)).toBe(true)
          expect(new Set(actual).size).toBe(actual.length)
        }
      )
    )
  })

  it('is permutation-stable and returns none when arbitrary allowlists omit the connector', () => {
    const namedContextArbitrary = fc.record({
      name: shortString,
      connectors: fc.array(shortString, { maxLength: 10 }),
    })

    fc.assert(
      fc.property(
        fc
          .array(namedContextArbitrary, { maxLength: 25 })
          .chain(entries =>
            fc
              .shuffledSubarray(entries, { minLength: entries.length, maxLength: entries.length })
              .map(shuffled => ({ entries, shuffled }))
          ),
        shortString,
        ({ entries, shuffled }, connectorName) => {
          const toContexts = (items: typeof entries): ContextResource[] =>
            items.map(({ name, connectors }) => ({
              metadata: { name },
              spec: { contextId: name, mcpServers: connectors },
            }))
          expect(contextNamesForConnector(toContexts(shuffled), connectorName)).toEqual(
            contextNamesForConnector(toContexts(entries), connectorName)
          )

          const withoutConnector = entries.map(entry => ({
            ...entry,
            connectors: entry.connectors.filter(name => name !== connectorName),
          }))
          expect(contextNamesForConnector(toContexts(withoutConnector), connectorName)).toEqual([])
        }
      )
    )
  })
})
