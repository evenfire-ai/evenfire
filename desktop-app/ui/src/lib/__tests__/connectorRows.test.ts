import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import type { RpcAgentConnectors, RpcConnector } from '../../../../src/types'
import { connectorRowKey, deriveConnectorRows } from '../connectorRows'
import { formatMcpServerDisplayName } from '../format'

function connector(overrides: Partial<RpcConnector> & Pick<RpcConnector, 'name'>): RpcConnector {
  return { status: 'requires_setup', ...overrides }
}

function agent(
  name: string,
  contextRef: string | null,
  connectors: RpcConnector[]
): RpcAgentConnectors {
  return { name, contextRef, connectors }
}

describe('deriveConnectorRows', () => {
  it('dedups two agents that share a (server, context) into one row', () => {
    const rows = deriveConnectorRows([
      agent('agent-zeta', 'ctx-team', [connector({ name: 'monday', status: 'authorized' })]),
      agent('agent-alpha', 'ctx-team', [connector({ name: 'monday', status: 'authorized' })]),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.usedByAgents).toEqual(['agent-alpha', 'agent-zeta'])
  })

  it('keeps the same server in two contexts as two adjacent rows', () => {
    const rows = deriveConnectorRows([
      agent('agent-beta', 'ctx-other', [connector({ name: 'shared-drive', status: 'authorized' })]),
      agent('agent-alpha', 'ctx-team', [
        connector({ name: 'shared-drive', status: 'requires_setup' }),
      ]),
    ])
    expect(rows).toHaveLength(2)
    // Sorted by display name then context: ctx-other before ctx-team.
    expect(rows.map(r => r.contextRef)).toEqual(['ctx-other', 'ctx-team'])
  })

  it('picks the alphabetically-first agent as the representative', () => {
    const rows = deriveConnectorRows([
      agent('agent-zeta', 'ctx-team', [connector({ name: 'monday' })]),
      agent('agent-alpha', 'ctx-team', [connector({ name: 'monday' })]),
      agent('agent-mid', 'ctx-team', [connector({ name: 'monday' })]),
    ])
    expect(rows[0]?.representativeAgent).toBe('agent-alpha')
  })

  it('sorts by display name, then real name, then context', () => {
    const rows = deriveConnectorRows([
      agent('a1', 'ctx-b', [
        connector({ name: 'zebra' }),
        connector({ name: 'mcp-alpha' }), // display name "alpha"
      ]),
      agent('a2', 'ctx-a', [connector({ name: 'alpha-remote' })]), // display name "alpha"
    ])
    // Both "alpha*" share the display name → grouped first, ordered by REAL name
    // ("alpha-remote" < "mcp-alpha"); "zebra" last.
    expect(rows.map(r => [r.connector.name, r.contextRef])).toEqual([
      ['alpha-remote', 'ctx-a'],
      ['mcp-alpha', 'ctx-b'],
      ['zebra', 'ctx-b'],
    ])
  })

  it('defensively prefers the most-connected status if a group diverges', () => {
    const rows = deriveConnectorRows([
      agent('agent-alpha', 'ctx-team', [connector({ name: 'monday', status: 'requires_setup' })]),
      agent('agent-zeta', 'ctx-team', [connector({ name: 'monday', status: 'authorized' })]),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.connector.status).toBe('authorized')
  })

  it('groups connectors with no context together and exposes the row key', () => {
    const rows = deriveConnectorRows([
      agent('agent-alpha', null, [connector({ name: 'monday' })]),
      agent('agent-zeta', null, [connector({ name: 'monday' })]),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.contextRef).toBeNull()
    expect(rows[0]?.key).toBe(connectorRowKey(null, 'monday'))
  })
})

/**
 * T2: `deriveConnectorRows` is a pure reconciliation with precedence
 * (`STATUS_RANK`), dedup by `(server, context)`, and a total sort order. Small
 * name/context/agent pools maximise collisions so groups actually merge. The
 * expected status precedence is spelled out HERE (the test is the spec) rather
 * than imported, so a change to the module's ranking is caught, not mirrored.
 */
describe('deriveConnectorRows — property-based invariants (T2)', () => {
  const STATUS_RANK: Record<RpcConnector['status'], number> = {
    authorized: 2,
    requires_setup: 1,
    no_oauth: 0,
  }

  const statusArb = fc.constantFrom<RpcConnector['status']>(
    'authorized',
    'requires_setup',
    'no_oauth'
  )
  // Include a display-name collision ('monday' vs 'mcp-monday') and an empty
  // string to probe the null-vs-'' context sentinel.
  const nameArb = fc.constantFrom('monday', 'mcp-monday', 'clickup', 'shared-drive')
  const contextArb = fc.oneof(fc.constant(null), fc.constantFrom('ctx-a', 'ctx-b', ''))
  const agentNameArb = fc.constantFrom('agent-a', 'agent-b', 'agent-c', 'agent-d')

  const agentArb: fc.Arbitrary<RpcAgentConnectors> = fc.record({
    name: agentNameArb,
    contextRef: contextArb,
    connectors: fc.array(fc.record({ name: nameArb, status: statusArb }), { maxLength: 5 }),
  })
  const agentsArb = fc.array(agentArb, { maxLength: 6 })

  // Mirrors the module's documented sort contract (display, real name, context).
  const sortRank = (row: { connector: RpcConnector; contextRef: string | null }) => [
    formatMcpServerDisplayName(row.connector.name),
    row.connector.name,
    row.contextRef ?? '',
  ]
  const lexCompare = (a: string[], b: string[]) => {
    for (let i = 0; i < a.length; i++) {
      const c = (a[i] ?? '').localeCompare(b[i] ?? '')
      if (c !== 0) return c
    }
    return 0
  }

  it('holds the 4 invariants for arbitrary payloads', () => {
    fc.assert(
      fc.property(agentsArb, agents => {
        const rows = deriveConnectorRows(agents)

        // (1) Total order: output non-decreasing under the sort contract.
        for (let i = 1; i < rows.length; i++) {
          expect(lexCompare(sortRank(rows[i - 1]!), sortRank(rows[i]!))).toBeLessThanOrEqual(0)
        }

        // (2) No duplicate row keys.
        expect(new Set(rows.map(r => r.key)).size).toBe(rows.length)

        // (3) No agent that references a (server, context) group disappears from
        //     that row's USED BY.
        for (const agent of agents) {
          for (const c of agent.connectors) {
            const row = rows.find(r => r.key === connectorRowKey(agent.contextRef, c.name))
            expect(row).toBeDefined()
            expect(row!.usedByAgents).toContain(agent.name)
          }
        }

        // (4) Row status = the max STATUS_RANK among the group's agents.
        for (const row of rows) {
          let maxRank = -1
          for (const agent of agents) {
            for (const c of agent.connectors) {
              if (connectorRowKey(agent.contextRef, c.name) === row.key) {
                maxRank = Math.max(maxRank, STATUS_RANK[c.status])
              }
            }
          }
          expect(STATUS_RANK[row.connector.status]).toBe(maxRank)
        }
      })
    )
  })
})
