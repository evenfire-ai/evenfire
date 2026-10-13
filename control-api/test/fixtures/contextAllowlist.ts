import type { Mock } from 'vitest'
import { config } from '../../src/config.js'
import { attachServerToContext } from '../../src/services/contextAllowlist.js'
import type { MockGateway } from '../mockGateway.js'

/**
 * Seed a Context CR (CRD-required fields only) and write its allowlist through
 * the real allowlist writer, so the `spec.mcpServers` shape the access gates
 * read is the one production writes.
 */
export async function seedAllowlistedContext(
  gateway: MockGateway,
  name: string,
  servers: string[],
  namespace: string = config.mcpServersNamespace
): Promise<void> {
  await gateway.createResource(
    'contexts',
    { metadata: { name }, spec: { contextId: name, mcpServers: [] } },
    namespace
  )
  for (const server of servers) {
    await attachServerToContext(gateway as never, { name, namespace }, server)
  }
}

/**
 * Seed an agent's Host CR in the hosts namespace with the CRD-required fields
 * (`host`, `contextRef`, an LLM `secretRef`). Hand-written: no exported
 * producer builds Host CRs.
 */
export async function seedAgentHost(
  gateway: MockGateway,
  name: string,
  contextRef: string,
  spec: Record<string, unknown> = {}
): Promise<void> {
  await gateway.createResource(
    'hosts',
    {
      metadata: { name },
      spec: { host: name, contextRef, secretRef: `${name}-llm`, ...spec },
    },
    config.hostsNamespace
  )
}

/**
 * Who belongs to what, keyed by user id. `contexts` answers the
 * `getUserContexts` read (`FROM user_contexts`), `agents` the `getUserAgents`
 * read (`FROM user_agents`). A user not listed has no rows.
 */
export interface Membership {
  contexts?: Record<string, string[]>
  agents?: Record<string, string[]>
}

type QueryResult = { rows: unknown[]; rowCount: number }

/**
 * Unit stand-in for the two membership reads: answers by the queried user id
 * (`values[0]`), so a reader that asks for the wrong user gets that user's
 * (usually empty) rows instead of the intended ones. Returns `null` for any
 * other SQL so a suite with its own pool fake can delegate the rest.
 *
 * Hand-written by necessity (the readers' SQL runs, the table does not); the
 * real-table contract (`lifecycle_state`, team tables not counting) belongs
 * to suites that run against a real Postgres.
 */
export function membershipResult(
  sql: unknown,
  values: unknown,
  membership: Membership
): QueryResult | null {
  const text = typeof sql === 'string' ? sql : ''
  const userId = Array.isArray(values) ? String(values[0]) : ''
  if (text.includes('FROM user_contexts')) {
    const ids = membership.contexts?.[userId] ?? []
    return { rows: ids.map(context_id => ({ context_id })), rowCount: ids.length }
  }
  if (text.includes('FROM user_agents')) {
    const names = membership.agents?.[userId] ?? []
    return { rows: names.map(agent_name => ({ agent_name })), rowCount: names.length }
  }
  return null
}

/**
 * Install `membershipResult` as the suite's mocked `pool.query`. Every other
 * query goes to `otherwise` (default: no rows).
 */
export function membership(
  poolQuery: Mock,
  value: Membership,
  otherwise: (sql: unknown, values: unknown) => Promise<QueryResult> = () =>
    Promise.resolve({ rows: [], rowCount: 0 })
): void {
  poolQuery.mockImplementation((sql: unknown, values: unknown) => {
    const answered = membershipResult(sql, values, value)
    return answered ? Promise.resolve(answered) : otherwise(sql, values)
  })
}
