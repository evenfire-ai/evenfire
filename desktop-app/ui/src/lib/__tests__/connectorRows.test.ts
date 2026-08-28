import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import type { RpcAgentConnectors, RpcConnector } from '../../../../src/types'
import { connectorRenderKey, connectorRowKey, deriveConnectorRows } from '../connectorRows'
import { formatMcpServerDisplayName } from '../format'

// T1 (fixture honesty): the input `RpcAgentConnectors[]` is the RAW output of
// rpc-proxy (`GET /api/v1/rpc/connectors`); the desktop client passes it through
// verbatim, so there is NO local producer to derive a fixture from. The
// authoritative producer is rpc-proxy (external). We therefore do NOT hand-write
// a "realistic" payload pretending to be rpc-proxy; instead the property-test
// below fuzzes the whole typed contract domain, and the real golden — if ever
// wanted — is captured from the producer-backed lane
// (`test/e2e-playwright/qa-recorder-connectors.spec.ts`), never by hand. The
// `connector()`/`agent()` helpers only build the typed contract domain (they are
// not standing in for another layer's serialization), which is legitimate.
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
  it('explodes two agents that share a (server, context) into two per-agent rows', () => {
    // Agent-centric model (spec §5.E): one row per (connector, agent). Two agents
    // that share the SAME grant `(server, context)` produce TWO rows — same
    // grantKey (the grant identity + busy anchor), distinct renderKey/agentName.
    const rows = deriveConnectorRows([
      agent('agent-zeta', 'ctx-team', [connector({ name: 'monday', status: 'authorized' })]),
      agent('agent-alpha', 'ctx-team', [connector({ name: 'monday', status: 'authorized' })]),
    ])
    expect(rows).toHaveLength(2)
    // Sorted by ... agent name as the final tie-break: alpha before zeta.
    expect(rows.map(r => r.agentName)).toEqual(['agent-alpha', 'agent-zeta'])
    // Both share the ONE grant identity.
    const grantKey = connectorRowKey('ctx-team', 'monday')
    expect(rows.map(r => r.grantKey)).toEqual([grantKey, grantKey])
    // But each row's React key is unique per (agent, context, server).
    expect(rows.map(r => r.renderKey)).toEqual([
      connectorRenderKey('agent-alpha', 'ctx-team', 'monday'),
      connectorRenderKey('agent-zeta', 'ctx-team', 'monday'),
    ])
    expect(new Set(rows.map(r => r.renderKey)).size).toBe(2)
  })

  it('keeps the same server in two contexts as two rows carrying their own agent', () => {
    const rows = deriveConnectorRows([
      agent('agent-beta', 'ctx-other', [connector({ name: 'shared-drive', status: 'authorized' })]),
      agent('agent-alpha', 'ctx-team', [
        connector({ name: 'shared-drive', status: 'requires_setup' }),
      ]),
    ])
    expect(rows).toHaveLength(2)
    // Sorted by display name then context: ctx-other before ctx-team.
    expect(rows.map(r => r.contextRef)).toEqual(['ctx-other', 'ctx-team'])
    expect(rows.map(r => r.agentName)).toEqual(['agent-beta', 'agent-alpha'])
  })

  it('collapses a single agent that lists the same connector twice (anomaly) by renderKey', () => {
    const rows = deriveConnectorRows([
      agent('agent-alpha', 'ctx-team', [
        connector({ name: 'monday', status: 'requires_setup' }),
        connector({ name: 'monday', status: 'authorized' }),
      ]),
    ])
    // Same (agent, context, server) collapses to ONE render row...
    expect(rows).toHaveLength(1)
    expect(rows[0]?.agentName).toBe('agent-alpha')
    // ...carrying the canonical (max STATUS_RANK) status of the grant.
    expect(rows[0]?.connector.status).toBe('authorized')
  })

  it('stamps every sibling row of a grant with the canonical (max STATUS_RANK) status', () => {
    // Status merge is now proved as: all rows of the SAME grantKey carry the
    // identical canonical status, regardless of the per-agent crude status.
    const rows = deriveConnectorRows([
      agent('agent-alpha', 'ctx-team', [connector({ name: 'monday', status: 'requires_setup' })]),
      agent('agent-zeta', 'ctx-team', [connector({ name: 'monday', status: 'authorized' })]),
    ])
    expect(rows).toHaveLength(2)
    const grantKey = connectorRowKey('ctx-team', 'monday')
    expect(rows.every(r => r.grantKey === grantKey)).toBe(true)
    // BOTH siblings show 'authorized' — coherent with the busy-state fold by grant.
    expect(rows.map(r => r.connector.status)).toEqual(['authorized', 'authorized'])
  })

  it('sorts by display name, then real name, then context, then agent', () => {
    const rows = deriveConnectorRows([
      agent('a1', 'ctx-b', [
        connector({ name: 'zebra' }),
        connector({ name: 'mcp-alpha' }), // display name "alpha"
      ]),
      agent('a2', 'ctx-a', [connector({ name: 'alpha-remote' })]), // display name "alpha"
    ])
    // Both "alpha*" share the display name → grouped first, ordered by REAL name
    // ("alpha-remote" < "mcp-alpha"); "zebra" last.
    expect(rows.map(r => [r.connector.name, r.contextRef, r.agentName])).toEqual([
      ['alpha-remote', 'ctx-a', 'a2'],
      ['mcp-alpha', 'ctx-b', 'a1'],
      ['zebra', 'ctx-b', 'a1'],
    ])
  })

  it('breaks ties on agent name when display/name/context all match', () => {
    const rows = deriveConnectorRows([
      agent('agent-zeta', 'ctx-team', [connector({ name: 'monday' })]),
      agent('agent-alpha', 'ctx-team', [connector({ name: 'monday' })]),
      agent('agent-mid', 'ctx-team', [connector({ name: 'monday' })]),
    ])
    expect(rows.map(r => r.agentName)).toEqual(['agent-alpha', 'agent-mid', 'agent-zeta'])
  })

  it('keeps contextless (oauth-user) grants clickable per-agent and exposes both keys', () => {
    const rows = deriveConnectorRows([
      agent('agent-alpha', null, [connector({ name: 'monday' })]),
      agent('agent-zeta', null, [connector({ name: 'monday' })]),
    ])
    // Two agents, no context → two per-agent rows (NOT deduplicated).
    expect(rows).toHaveLength(2)
    expect(rows.every(r => r.contextRef === null)).toBe(true)
    const grantKey = connectorRowKey(null, 'monday')
    expect(rows.every(r => r.grantKey === grantKey)).toBe(true)
    expect(rows.map(r => r.renderKey)).toEqual([
      connectorRenderKey('agent-alpha', null, 'monday'),
      connectorRenderKey('agent-zeta', null, 'monday'),
    ])
  })
})

/**
 * T2: `deriveConnectorRows` is a pure reconciliation with precedence
 * (`STATUS_RANK` folded per GRANT), an explode to one row per (agent, connector),
 * and a total sort order. Small name/context/agent pools maximise collisions so
 * grants actually merge AND multiple agents share a grant. The expected status
 * precedence is spelled out HERE (the test is the spec) rather than imported, so
 * a change to the module's ranking is caught, not mirrored.
 *
 * CAVEAT: each property targets the CORRECT key —
 *   - uniqueness is a property of renderKey (the React key),
 *   - status coherence is a property of grantKey (the grant identity).
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

  // Mirrors the module's documented sort contract (display, real name, context, agent).
  const sortRank = (row: {
    connector: RpcConnector
    contextRef: string | null
    agentName: string
  }) => [
    formatMcpServerDisplayName(row.connector.name),
    row.connector.name,
    row.contextRef ?? '',
    row.agentName,
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

        // (1) Total order: output non-decreasing under the sort contract
        //     (display, name, context, AGENT).
        for (let i = 1; i < rows.length; i++) {
          expect(lexCompare(sortRank(rows[i - 1]!), sortRank(rows[i]!))).toBeLessThanOrEqual(0)
        }

        // (2) No duplicate RENDER keys (the React key must be unique per row).
        expect(new Set(rows.map(r => r.renderKey)).size).toBe(rows.length)

        // (3) Bijection with the payload: every (agent, connector) pair maps to
        //     exactly one row, and no row invents an absent pair. The set of the
        //     rows' renderKeys equals the set of renderKeys derivable from the
        //     payload (agent-lists-same-name-twice collapses to one renderKey on
        //     BOTH sides, so equality still holds).
        const expected = new Set<string>()
        for (const agent of agents) {
          for (const c of agent.connectors) {
            expected.add(connectorRenderKey(agent.name, agent.contextRef, c.name))
          }
        }
        const actual = new Set(rows.map(r => r.renderKey))
        expect(actual.size).toBe(expected.size)
        for (const rk of expected) expect(actual.has(rk)).toBe(true)
        // Nothing invented: every row's (agentName, grantKey) is a real payload pair.
        for (const row of rows) {
          expect(row.renderKey).toBe(
            connectorRenderKey(row.agentName, row.contextRef, row.connector.name)
          )
          expect(row.grantKey).toBe(connectorRowKey(row.contextRef, row.connector.name))
          expect(expected.has(row.renderKey)).toBe(true)
        }

        // (4) Status coherence per GRANT: all rows sharing a grantKey carry an
        //     identical status, equal to the max STATUS_RANK of that grant's
        //     appearances in the payload.
        const grantMaxRank = new Map<string, number>()
        for (const agent of agents) {
          for (const c of agent.connectors) {
            const gk = connectorRowKey(agent.contextRef, c.name)
            grantMaxRank.set(gk, Math.max(grantMaxRank.get(gk) ?? -1, STATUS_RANK[c.status]))
          }
        }
        const seenStatusByGrant = new Map<string, RpcConnector['status']>()
        for (const row of rows) {
          // canonical == max rank of the grant
          expect(STATUS_RANK[row.connector.status]).toBe(grantMaxRank.get(row.grantKey))
          // siblings agree
          const prev = seenStatusByGrant.get(row.grantKey)
          if (prev !== undefined) expect(row.connector.status).toBe(prev)
          seenStatusByGrant.set(row.grantKey, row.connector.status)
        }
      })
    )
  })
})
