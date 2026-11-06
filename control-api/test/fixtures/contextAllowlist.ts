import type { Mock } from 'vitest'
import { randomUUID } from 'node:crypto'
import { config } from '../../src/config.js'
import type { DbClient } from '../../src/db.js'
import { attachServerToContext } from '../../src/services/contextAllowlist.js'
import { setUserAgents } from '../../src/services/directory/agentAccess.js'
import { setUserContexts } from '../../src/services/directory/contextAccess.js'
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
  // The broker's Host-entry read (`hostAccessForUser`) also names user_agents in
  // a subquery, so it is matched first. Unit stand-in: direct agent rows only;
  // lifecycle_state and team membership are covered against real Postgres.
  if (text.includes('lifecycle_state') && text.includes('team_agents')) {
    const hostName = Array.isArray(values) ? String(values[1]) : ''
    const allowed = (membership.agents?.[userId] ?? []).includes(hostName)
    return allowed ? { rows: [{ allowed: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 }
  }
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

/**
 * Real-Postgres seed: an active user whose direct Context and agent access is
 * written by the production writers (`setUserContexts`, `setUserAgents`), so
 * the readers the gates use run against the rows production writes. Only the
 * two direct tables are touched: a seed that also wrote team_contexts /
 * team_agents would hide a reader that wrongly counted team access.
 *
 * Requires the suite's db mock to route `pool` and `withTransaction` to the
 * test database. Returns the user id.
 */
export async function seedActiveMember(
  db: Pick<DbClient, 'query'>,
  access: { contexts?: string[]; agents?: string[] }
): Promise<string> {
  const operatorId = await seedControlAdmin(db)
  const created = await db.query(`INSERT INTO users (email) VALUES ($1) RETURNING id::text AS id`, [
    `member-${randomUUID()}@example.test`,
  ])
  const userId = String((created.rows[0] as { id: string }).id)
  if (access.contexts?.length) await setUserContexts(userId, access.contexts, operatorId)
  if (access.agents?.length) await setUserAgents(userId, access.agents, operatorId)
  return userId
}

/** Real-Postgres seed: an active control admin, usable as a writer's operator. */
export async function seedControlAdmin(db: Pick<DbClient, 'query'>): Promise<string> {
  const id = randomUUID()
  await db.query(
    `INSERT INTO control_admin_users (id, username, password_hash, role, status)
     VALUES ($1, $2, 'real-pg-fixture', 'admin', 'active')`,
    [id, `fixture-admin-${id}`]
  )
  return id
}
