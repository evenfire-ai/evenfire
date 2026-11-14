import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { type DbTransactionClient, type DbTransactionOptions, initDb } from '../src/db.js'
import {
  deleteManagedMemberForUser,
  deleteManagedUserForUser,
  updateManagedMemberRoleForUser,
} from '../src/services/directory/membership.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

// Managed member removal and role change lock one team's team_members rows
// ORDER BY user_id. Managed retirement locks the manager's and the target's
// rows across every team of the target. Both must follow one global order,
// (team_id, user_id), or a retirement of B by A and a removal (or demotion)
// of A by B on a shared team deadlock. Each case orders the two writers with a
// gate transaction so that the race is forced, not hoped for.

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe.sequential : describe.skip
const runtimeRoles = [
  'control_api_runtime',
  'trace_maintenance_runtime',
  'workflow_recipes_runtime',
] as const

const producerDatabase = vi.hoisted(() => ({ pool: undefined as Pool | undefined }))

vi.mock('../src/db.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/db.js')>()
  const pool = {
    query: (text: string, values?: unknown[]) => producerDatabase.pool!.query(text, values),
  }
  const withTransaction = <T>(
    work: (db: DbTransactionClient) => Promise<T>,
    _txPool?: Pool,
    options: DbTransactionOptions = {}
  ): Promise<T> => {
    return actual.withTransaction(work, producerDatabase.pool!, options)
  }
  return { ...actual, pool, withTransaction }
})

function databaseUrl(baseUrl: string, database: string): string {
  const value = new URL(baseUrl)
  value.pathname = `/${database}`
  return value.toString()
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

/** Two random UUIDs in PostgreSQL uuid order (byte order = lower-case text order). */
function orderedUuids(): [string, string] {
  const [first, second] = [randomUUID(), randomUUID()].sort()
  return [first!, second!]
}

function sqlState(reason: unknown): unknown {
  return reason !== null && typeof reason === 'object' && 'code' in reason
    ? (reason as { code?: unknown }).code
    : undefined
}

describeRealPostgres('managed directory writers share one team_members lock order', () => {
  const database = `control_api_directory_lock_order_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres',
    database
  )
  let adminPool: Pool
  let databasePool: Pool

  async function backendPid(client: PoolClient): Promise<number> {
    const result = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
    return result.rows[0]!.pid
  }

  async function waitForBlockedBy(blockerPid: number): Promise<number> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const result = await databasePool.query<{ pid: number }>(
        `SELECT activity.pid
           FROM pg_stat_activity activity
          WHERE activity.datname = current_database()
            AND $1::int = ANY(pg_blocking_pids(activity.pid))
          ORDER BY activity.pid
          LIMIT 1`,
        [blockerPid]
      )
      if (result.rows[0]?.pid) return result.rows[0].pid
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('expected the member writer to block on the gate row lock')
  }

  // The retirement is blocked behind the gate or behind the member writer
  // queued first on the same row; either way it waits in a team_members lock.
  async function waitForOtherBlockedTeamMembersLock(excludedPids: number[]): Promise<number> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const result = await databasePool.query<{ pid: number }>(
        `SELECT activity.pid
           FROM pg_stat_activity activity
          WHERE activity.datname = current_database()
            AND activity.pid <> ALL($1::int[])
            AND cardinality(pg_blocking_pids(activity.pid)) > 0
            AND activity.query LIKE '%team_members%'
          ORDER BY activity.pid
          LIMIT 1`,
        [excludedPids]
      )
      if (result.rows[0]?.pid) return result.rows[0].pid
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('expected the retirement to block in its team_members lock')
  }

  async function holdMembershipRow(teamId: string, userId: string): Promise<PoolClient> {
    const gate = await databasePool.connect()
    try {
      await gate.query('BEGIN')
      const locked = await gate.query(
        `SELECT 1
           FROM team_members
          WHERE team_id = $1
            AND user_id = $2
          FOR UPDATE`,
        [teamId, userId]
      )
      expect(locked.rowCount).toBe(1)
    } catch (error) {
      await gate.query('ROLLBACK')
      gate.release()
      throw error
    }
    return gate
  }

  /**
   * Admins A < B (uuid order) share every team in `teamIds` (sorted).
   */
  async function seedAdmins(label: string, teamCount: number) {
    const [userA, userB] = orderedUuids()
    const teamIds = Array.from({ length: teamCount }, () => randomUUID()).sort()
    await databasePool.query(
      `INSERT INTO users(id, email, name, lifecycle_state, lifecycle_version)
       VALUES ($1, $2, 'Admin A', 'active', 1),
              ($3, $4, 'Admin B', 'active', 1)`,
      [userA, `${label}-a-${userA}@example.test`, userB, `${label}-b-${userB}@example.test`]
    )
    for (const teamId of teamIds) {
      await databasePool.query(`INSERT INTO teams(id, name) VALUES ($1, $2)`, [teamId, label])
      await databasePool.query(
        `INSERT INTO team_members(team_id, user_id, role, status)
         VALUES ($1, $2, 'admin', 'active'),
                ($1, $3, 'admin', 'active')`,
        [teamId, userA, userB]
      )
    }
    return { userA, userB, teamIds }
  }

  async function membershipRows(userIds: string[]) {
    const result = await databasePool.query<{
      team_id: string
      user_id: string
      role: string
      status: string
    }>(
      `SELECT team_id::text AS team_id, user_id::text AS user_id, role, status
         FROM team_members
        WHERE user_id = ANY($1::uuid[])
        ORDER BY team_id, user_id`,
      [userIds]
    )
    return result.rows
  }

  /**
   * A retires B while B changes A's membership on `contestedTeam`. The gate
   * holds (contestedTeam, A), the first row the member writer locks. The member
   * writer queues on it first, then the retirement queues behind it; the gate
   * then commits and both proceed.
   */
  async function raceRetirementAgainstMemberWriter(options: {
    userA: string
    userB: string
    contestedTeam: string
    memberWriter: () => Promise<unknown>
  }) {
    const gate = await holdMembershipRow(options.contestedTeam, options.userA)
    let gateOpen = true
    try {
      const gatePid = await backendPid(gate)
      const memberWriter = options.memberWriter()
      const memberWriterSettled = memberWriter.then(
        value => ({ status: 'fulfilled' as const, value }),
        (reason: unknown) => ({ status: 'rejected' as const, reason })
      )
      const memberWriterPid = await waitForBlockedBy(gatePid)

      const retirement = deleteManagedUserForUser(options.userA, options.userB, {
        reason: 'synthetic lock order retirement',
        idempotencyKey: `synthetic-lock-order-${randomBytes(8).toString('hex')}`,
        requestId: null,
      })
      const retirementSettled = retirement.then(
        value => ({ status: 'fulfilled' as const, value }),
        (reason: unknown) => ({ status: 'rejected' as const, reason })
      )
      const retirementPid = await waitForOtherBlockedTeamMembersLock([gatePid, memberWriterPid])

      await gate.query('COMMIT')
      gateOpen = false
      const [memberWriterOutcome, retirementOutcome] = await Promise.all([
        memberWriterSettled,
        retirementSettled,
      ])
      return { memberWriterPid, retirementPid, memberWriterOutcome, retirementOutcome }
    } finally {
      if (gateOpen) await gate.query('ROLLBACK')
      gate.release()
    }
  }

  function expectNoDeadlock(outcomes: Array<{ status: string; reason?: unknown }>): void {
    const states = outcomes
      .filter(outcome => outcome.status === 'rejected')
      .map(outcome => sqlState(outcome.reason))
    expect(states).not.toContain('40P01')
    // Witness: both writers settled without any rejection at all.
    expect(states).toEqual([])
    expect(outcomes).toHaveLength(2)
  }

  async function expectRetirementRolledBack(userB: string): Promise<void> {
    const user = await databasePool.query<{ lifecycle_state: string }>(
      `SELECT lifecycle_state FROM users WHERE id = $1`,
      [userB]
    )
    expect(user.rows).toEqual([{ lifecycle_state: 'active' }])
    const operations = await databasePool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM desktop_user_retirement_operations
        WHERE target_user_id = $1`,
      [userB]
    )
    expect(operations.rows).toEqual([{ count: '0' }])
  }

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`DROP ROLE IF EXISTS ${runtimeRoles.join(', ')}`)
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(database)}`)
    databasePool = new Pool({ connectionString })
    producerDatabase.pool = databasePool
    await initDb({ connect: () => databasePool.connect() })
  })

  afterAll(async () => {
    try {
      await endPoolAndWaitForClients(databasePool)
      if (adminPool) {
        await adminPool.query(
          `SELECT pg_terminate_backend(pid)
           FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [database]
        )
        await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)}`)
        await adminPool.query(`DROP ROLE IF EXISTS ${runtimeRoles.join(', ')}`)
      }
    } finally {
      await adminPool?.end()
    }
  })

  it('lets a member removal and a retirement on a shared team both finish without a deadlock', async () => {
    const { userA, userB, teamIds } = await seedAdmins('lock-order-remove', 1)
    const [team] = teamIds as [string]

    const race = await raceRetirementAgainstMemberWriter({
      userA,
      userB,
      contestedTeam: team,
      memberWriter: () => deleteManagedMemberForUser(userB, userA, team),
    })

    // Witness: both writers really waited, so the schedule was the racing one.
    expect(race.memberWriterPid).toBeGreaterThan(0)
    expect(race.retirementPid).toBeGreaterThan(0)
    expect(race.retirementPid).not.toBe(race.memberWriterPid)
    expectNoDeadlock([race.memberWriterOutcome, race.retirementOutcome])
    expect(race.memberWriterOutcome).toEqual({
      status: 'fulfilled',
      value: { deleted: { team_id: team, user_id: userA, role: 'admin', status: 'deleted' } },
    })
    // The retirement re-reads A's row after the removal committed: A no longer
    // manages the team, so the retirement is refused.
    expect(race.retirementOutcome).toEqual({
      status: 'fulfilled',
      value: { error: 'forbidden_uncontrolled_teams' },
    })
    await expect(membershipRows([userA, userB])).resolves.toEqual([
      { team_id: team, user_id: userA, role: 'admin', status: 'deleted' },
      { team_id: team, user_id: userB, role: 'admin', status: 'active' },
    ])
    await expectRetirementRolledBack(userB)
  })

  it('lets a role demotion and a retirement on a shared team both finish without a deadlock', async () => {
    const { userA, userB, teamIds } = await seedAdmins('lock-order-demote', 1)
    const [team] = teamIds as [string]

    const race = await raceRetirementAgainstMemberWriter({
      userA,
      userB,
      contestedTeam: team,
      memberWriter: () => updateManagedMemberRoleForUser(userB, userA, team, 'member'),
    })

    expect(race.memberWriterPid).toBeGreaterThan(0)
    expect(race.retirementPid).toBeGreaterThan(0)
    expect(race.retirementPid).not.toBe(race.memberWriterPid)
    expectNoDeadlock([race.memberWriterOutcome, race.retirementOutcome])
    expect(race.memberWriterOutcome).toEqual({
      status: 'fulfilled',
      value: { membership: { team_id: team, user_id: userA, role: 'member', status: 'active' } },
    })
    // A is a member now, which cannot retire anyone.
    expect(race.retirementOutcome).toEqual({
      status: 'fulfilled',
      value: { error: 'forbidden_uncontrolled_teams' },
    })
    await expect(membershipRows([userA, userB])).resolves.toEqual([
      { team_id: team, user_id: userA, role: 'member', status: 'active' },
      { team_id: team, user_id: userB, role: 'admin', status: 'active' },
    ])
    await expectRetirementRolledBack(userB)
  })

  it('orders the retirement locks by team first when A and B share two teams', async () => {
    const { userA, userB, teamIds } = await seedAdmins('lock-order-two-teams', 2)
    const [firstTeam, secondTeam] = teamIds as [string, string]

    // The removal targets the second team: a retirement that locked every
    // target row before the manager rows would already hold (second, B).
    const race = await raceRetirementAgainstMemberWriter({
      userA,
      userB,
      contestedTeam: secondTeam,
      memberWriter: () => deleteManagedMemberForUser(userB, userA, secondTeam),
    })

    expect(race.memberWriterPid).toBeGreaterThan(0)
    expect(race.retirementPid).toBeGreaterThan(0)
    expect(race.retirementPid).not.toBe(race.memberWriterPid)
    expectNoDeadlock([race.memberWriterOutcome, race.retirementOutcome])
    expect(race.memberWriterOutcome).toEqual({
      status: 'fulfilled',
      value: {
        deleted: { team_id: secondTeam, user_id: userA, role: 'admin', status: 'deleted' },
      },
    })
    expect(race.retirementOutcome).toEqual({
      status: 'fulfilled',
      value: { error: 'forbidden_uncontrolled_teams' },
    })
    await expect(membershipRows([userA, userB])).resolves.toEqual([
      { team_id: firstTeam, user_id: userA, role: 'admin', status: 'active' },
      { team_id: firstTeam, user_id: userB, role: 'admin', status: 'active' },
      { team_id: secondTeam, user_id: userA, role: 'admin', status: 'deleted' },
      { team_id: secondTeam, user_id: userB, role: 'admin', status: 'active' },
    ])
    await expectRetirementRolledBack(userB)
  })
})
