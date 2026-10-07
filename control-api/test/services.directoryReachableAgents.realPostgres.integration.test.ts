import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { initDb, pool } from '../src/db.js'
import { getReachableAgentNames } from '../src/services/directory/index.js'
import { retireDesktopUser } from '../src/services/directory/users.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'
import './realPostgres.requirement.ts'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

function quoteIdent(value: string): string {
  return '"' + value.replace(/"/g, '""') + '"'
}

function databaseUrl(base: string, database: string): string {
  const url = new URL(base)
  url.pathname = '/' + database
  return url.toString()
}

describeRealPostgres('getReachableAgentNames (real PostgreSQL)', () => {
  const database = 'directory_reachable_agents_' + randomBytes(6).toString('hex')
  let adminPool: Pool | undefined
  let testPool: Pool
  let connectSpy: { mockRestore(): void } | undefined
  let querySpy: { mockRestore(): void } | undefined

  beforeAll(async () => {
    if (!adminUrl) throw new Error('CONTROL_API_REAL_PG_ADMIN_URL is required')

    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query('CREATE DATABASE ' + quoteIdent(database))
    testPool = new Pool({ connectionString: databaseUrl(adminUrl, database) })
    await initDb({ connect: () => testPool.connect() })

    connectSpy = vi
      .spyOn(pool, 'connect')
      .mockImplementation((() => testPool.connect()) as typeof pool.connect)
    querySpy = vi
      .spyOn(pool, 'query')
      .mockImplementation(((text: string, values?: unknown[]) =>
        testPool.query(text, values)) as unknown as typeof pool.query)
  }, 60_000)

  afterAll(async () => {
    try {
      querySpy?.mockRestore()
      connectSpy?.mockRestore()
      await endPoolAndWaitForClients(testPool)
      if (adminPool) {
        await adminPool.query(
          'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
          [database]
        )
        await adminPool.query('DROP DATABASE IF EXISTS ' + quoteIdent(database))
      }
    } finally {
      await adminPool?.end()
    }
  }, 60_000)

  async function seedUser(label: string): Promise<string> {
    const id = randomUUID()
    await testPool.query('INSERT INTO users (id, email, name) VALUES ($1, $2, $3)', [
      id,
      label + '-' + id + '@example.test',
      label,
    ])
    return id
  }

  async function seedTeam(name: string): Promise<string> {
    const result = await testPool.query<{ id: string }>(
      'INSERT INTO teams (name) VALUES ($1) RETURNING id::text',
      [name]
    )
    return result.rows[0].id
  }

  async function seedMembership(teamId: string, userId: string): Promise<void> {
    await testPool.query(
      "INSERT INTO team_members (team_id, user_id, role, status) VALUES ($1, $2, 'member', 'active')",
      [teamId, userId]
    )
  }

  async function seedDirectGrant(userId: string, agentName: string): Promise<void> {
    await testPool.query('INSERT INTO user_agents (user_id, agent_name) VALUES ($1, $2)', [
      userId,
      agentName,
    ])
  }

  async function seedTeamGrant(teamId: string, agentName: string): Promise<void> {
    await testPool.query('INSERT INTO team_agents (team_id, agent_name) VALUES ($1, $2)', [
      teamId,
      agentName,
    ])
  }

  it('C7: combines direct grants and active-team grants in sorted order with one query', async () => {
    const userId = await seedUser('direct-and-team')
    const teamId = await seedTeam('direct-and-team')
    await seedMembership(teamId, userId)
    await seedDirectGrant(userId, 'host-z-direct')
    await seedTeamGrant(teamId, 'host-a-team')

    vi.mocked(pool.query).mockClear()
    expect(await getReachableAgentNames(userId)).toEqual({
      userId,
      agentNames: ['host-a-team', 'host-z-direct'],
    })
    expect(pool.query).toHaveBeenCalledTimes(1)
    expect(pool.query).toHaveBeenCalledWith(expect.any(String), [userId])
  })

  it('C7: deduplicates a direct grant shared by two active teams', async () => {
    const userId = await seedUser('duplicate-grants')
    const firstTeamId = await seedTeam('duplicate-grants-first')
    const secondTeamId = await seedTeam('duplicate-grants-second')
    await seedMembership(firstTeamId, userId)
    await seedMembership(secondTeamId, userId)
    await seedDirectGrant(userId, 'host-shared')
    await seedTeamGrant(firstTeamId, 'host-shared')
    await seedTeamGrant(secondTeamId, 'host-shared')

    const grants = await testPool.query(
      `SELECT agent_name FROM user_agents WHERE user_id = $1
       UNION ALL
       SELECT agent_name FROM team_agents WHERE team_id IN ($2, $3)`,
      [userId, firstTeamId, secondTeamId]
    )
    expect(grants.rows).toEqual([
      { agent_name: 'host-shared' },
      { agent_name: 'host-shared' },
      { agent_name: 'host-shared' },
    ])
    expect(await getReachableAgentNames(userId, testPool)).toEqual({
      userId,
      agentNames: ['host-shared'],
    })
  })

  it("C7: isolates another user's direct grants and active-team grants", async () => {
    const userId = await seedUser('isolated-subject')
    const otherUserId = await seedUser('isolated-other')
    const teamId = await seedTeam('isolated-subject')
    const otherTeamId = await seedTeam('isolated-other')
    await seedMembership(teamId, userId)
    await seedMembership(otherTeamId, otherUserId)
    await seedDirectGrant(userId, 'host-subject-direct')
    await seedTeamGrant(teamId, 'host-subject-team')
    await seedDirectGrant(otherUserId, 'host-other-direct')
    await seedTeamGrant(otherTeamId, 'host-other-team')

    expect(await getReachableAgentNames(otherUserId, testPool)).toEqual({
      userId: otherUserId,
      agentNames: ['host-other-direct', 'host-other-team'],
    })
    expect(await getReachableAgentNames(userId, testPool)).toEqual({
      userId,
      agentNames: ['host-subject-direct', 'host-subject-team'],
    })
  })

  it('C7: excludes a deleted membership while retaining reachability through the second active team', async () => {
    const userId = await seedUser('membership-removal')
    const firstTeamId = await seedTeam('membership-removal-first')
    const secondTeamId = await seedTeam('membership-removal-second')
    await seedMembership(firstTeamId, userId)
    await seedMembership(secondTeamId, userId)
    await seedTeamGrant(firstTeamId, 'host-first-only')
    await seedTeamGrant(firstTeamId, 'host-shared')
    await seedTeamGrant(secondTeamId, 'host-second-only')
    await seedTeamGrant(secondTeamId, 'host-shared')

    expect(await getReachableAgentNames(userId)).toEqual({
      userId,
      agentNames: ['host-first-only', 'host-second-only', 'host-shared'],
    })

    const removed = await testPool.query(
      "UPDATE team_members SET status = 'deleted' WHERE team_id = $1 AND user_id = $2 RETURNING status",
      [firstTeamId, userId]
    )
    expect(removed.rows).toEqual([{ status: 'deleted' }])
    const firstTeamGrants = await testPool.query(
      'SELECT agent_name FROM team_agents WHERE team_id = $1 ORDER BY agent_name ASC',
      [firstTeamId]
    )
    expect(firstTeamGrants.rows).toEqual([
      { agent_name: 'host-first-only' },
      { agent_name: 'host-shared' },
    ])
    const secondMembership = await testPool.query(
      'SELECT status FROM team_members WHERE team_id = $1 AND user_id = $2',
      [secondTeamId, userId]
    )
    expect(secondMembership.rows).toEqual([{ status: 'active' }])
    expect(await getReachableAgentNames(userId)).toEqual({
      userId,
      agentNames: ['host-second-only', 'host-shared'],
    })
  })

  it('C7: excludes a retained retired user while direct grants and active membership remain', async () => {
    const userId = await seedUser('retained-retired')
    const teamId = await seedTeam('retained-retired')
    const adminId = randomUUID()
    // Retirement resolves this actor without authenticating; the fixture hash is never used for login.
    await testPool.query(
      `INSERT INTO control_admin_users
         (id, username, email, password_hash, role, status, session_version)
       VALUES ($1, $2, $3, 'real-pg-replace-test', 'admin', 'active', 1)`,
      [adminId, 'retirement-' + adminId, 'retirement-' + adminId + '@example.test']
    )
    await seedMembership(teamId, userId)
    await seedDirectGrant(userId, 'host-retired-direct')
    await seedTeamGrant(teamId, 'host-retired-team')

    expect(await getReachableAgentNames(userId)).toEqual({
      userId,
      agentNames: ['host-retired-direct', 'host-retired-team'],
    })

    const retirement = await retireDesktopUser(
      { kind: 'control_admin', controlAdminId: adminId },
      userId,
      'Reachability lifecycle integration test',
      randomUUID(),
      randomUUID(),
      { retainWithoutLinkHistory: true }
    )
    expect(retirement).toMatchObject({ id: userId, outcome: 'retired', replayed: false })

    const retainedUser = await testPool.query(
      `SELECT lifecycle_state, retired_at, retirement_operation_id::text, lifecycle_version::text
         FROM users WHERE id = $1`,
      [userId]
    )
    expect(retainedUser.rows).toHaveLength(1)
    expect(retainedUser.rows[0]).toMatchObject({
      lifecycle_state: 'retired',
      retirement_operation_id: retirement.operationId,
      lifecycle_version: String(retirement.lifecycleVersion),
    })
    expect(retainedUser.rows[0].retired_at).not.toBeNull()

    const directGrants = await testPool.query(
      'SELECT agent_name FROM user_agents WHERE user_id = $1',
      [userId]
    )
    expect(directGrants.rows).toEqual([{ agent_name: 'host-retired-direct' }])
    const membership = await testPool.query(
      'SELECT team_id::text, status FROM team_members WHERE user_id = $1',
      [userId]
    )
    expect(membership.rows).toEqual([{ team_id: teamId, status: 'active' }])
    const teamGrants = await testPool.query(
      'SELECT agent_name FROM team_agents WHERE team_id = $1',
      [teamId]
    )
    expect(teamGrants.rows).toEqual([{ agent_name: 'host-retired-team' }])
    const audit = await testPool.query(
      `SELECT actor_control_admin_id::text, status, outcome, lifecycle_version::text,
              lifecycle_operation_id::text
         FROM desktop_user_retirement_operations
        WHERE lifecycle_operation_id = $1`,
      [retirement.operationId]
    )
    expect(audit.rows).toEqual([
      {
        actor_control_admin_id: adminId,
        status: 'completed',
        outcome: 'retired',
        lifecycle_version: String(retirement.lifecycleVersion),
        lifecycle_operation_id: retirement.operationId,
      },
    ])
    expect(await getReachableAgentNames(userId)).toEqual({ userId, agentNames: [] })
  })
})
