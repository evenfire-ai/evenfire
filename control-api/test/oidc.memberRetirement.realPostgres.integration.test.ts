import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { initDb, pool } from '../src/db.js'
import { adminDeleteTeam } from '../src/services/directory/teams.js'
import { adminDeleteUser, retireDesktopUser } from '../src/services/directory/users.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'
import './realPostgres.requirement.js'
import { waitForDatabaseConnectionsToClose } from './realPostgresCleanup.ts'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

describeRealPostgres('OIDC-linked member retirement on real PostgreSQL', () => {
  const database = `oidc_member_retirement_${randomBytes(6).toString('hex')}`
  const actorId = randomUUID()
  const connectionId = 'oidc-retirement-connection'
  let adminPool: Pool
  let testPool: Pool
  let corePoolConnectSpy: ReturnType<typeof vi.spyOn>

  async function seedUser(label: string): Promise<string> {
    const id = randomUUID()
    await testPool.query(`INSERT INTO users (id, email, name) VALUES ($1, $2, $3)`, [
      id,
      `${label}-${id}@fixture.test`,
      label,
    ])
    return id
  }

  async function seedLinkedUser(label: string): Promise<string> {
    const id = await seedUser(label)
    await testPool.query(
      `INSERT INTO oidc_connections (id, issuer, client_id)
       VALUES ($1, 'https://issuer.example.test', 'fixture-client') ON CONFLICT DO NOTHING`,
      [connectionId]
    )
    await testPool.query(
      `INSERT INTO user_oidc_links (connection_id, issuer, subject, user_id)
       VALUES ($1, 'https://issuer.example.test', $2, $3::uuid)`,
      [connectionId, `subject-${id}`, id]
    )
    return id
  }

  async function seedTeamWithMembers(userIds: readonly string[]): Promise<string> {
    const teamId = randomUUID()
    await testPool.query(`INSERT INTO teams (id, name) VALUES ($1, $2)`, [
      teamId,
      `oidc-retirement-team-${teamId}`,
    ])
    for (const userId of userIds) {
      await testPool.query(
        `INSERT INTO team_members (team_id, user_id, role, status) VALUES ($1, $2, 'admin', 'active')`,
        [teamId, userId]
      )
    }
    return teamId
  }

  async function retire(userId: string, key: string) {
    return retireDesktopUser(
      { kind: 'control_admin', controlAdminId: actorId },
      userId,
      'oidc-linked member retired',
      key,
      `${key}-request`
    )
  }

  beforeAll(async () => {
    if (!adminUrl) throw new Error('CONTROL_API_REAL_PG_ADMIN_URL is required')
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdent(database)}`)
    testPool = new Pool({ connectionString: databaseUrl(adminUrl, database) })
    await initDb({ connect: () => testPool.connect() })
    corePoolConnectSpy = vi
      .spyOn(pool, 'connect')
      .mockImplementation((() => testPool.connect()) as typeof pool.connect)
    await testPool.query(
      `INSERT INTO control_admin_users (id, username, password_hash, role, status)
       VALUES ($1, $2, 'fixture-password-hash', 'admin', 'active')`,
      [actorId, `oidc-retirement-actor-${actorId}`]
    )
  }, 60_000)

  afterAll(async () => {
    try {
      corePoolConnectSpy?.mockRestore()
      await endPoolAndWaitForClients(testPool)
      if (!adminPool) return
      await waitForDatabaseConnectionsToClose(adminPool, database)
      await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdent(database)}`)
    } finally {
      await adminPool?.end()
    }
  })

  it('retires a linked member as a retained row', async () => {
    const userId = await seedLinkedUser('linked-retire')

    const result = await retireDesktopUser(
      { kind: 'control_admin', controlAdminId: actorId },
      userId,
      'oidc-linked member retired',
      'oidc-retire-linked-v1',
      'oidc-retire-linked-request-v1'
    )

    expect(result).toMatchObject({ id: userId, outcome: 'retired', replayed: false })
    const user = await testPool.query(`SELECT lifecycle_state FROM users WHERE id = $1::uuid`, [
      userId,
    ])
    expect(user.rows).toEqual([{ lifecycle_state: 'retired' }])
    const links = await testPool.query(`SELECT 1 FROM user_oidc_links WHERE user_id = $1::uuid`, [
      userId,
    ])
    expect(links.rowCount).toBe(1)
  })

  it('still hard-deletes an unlinked member without history while member sign-in is off', async () => {
    const userId = await seedUser('unlinked-retire')

    const result = await retireDesktopUser(
      { kind: 'control_admin', controlAdminId: actorId },
      userId,
      'no history',
      'oidc-retire-unlinked-v1',
      'oidc-retire-unlinked-request-v1'
    )

    expect(result).toMatchObject({ id: userId, outcome: 'deleted' })
    const user = await testPool.query(`SELECT 1 FROM users WHERE id = $1::uuid`, [userId])
    expect(user.rowCount).toBe(0)
  })

  it('deletes a team whose last member was retired as a retained row', async () => {
    const userId = await seedLinkedUser('last-member-retire')
    const teamId = await seedTeamWithMembers([userId])
    expect(await retire(userId, 'oidc-retire-last-member-v1')).toMatchObject({
      outcome: 'retired',
    })
    // The retired row keeps its membership row, still marked active.
    const kept = await testPool.query(
      `SELECT status FROM team_members WHERE team_id = $1 AND user_id = $2::uuid`,
      [teamId, userId]
    )
    expect(kept.rows).toEqual([{ status: 'active' }])

    await expect(adminDeleteTeam(teamId)).resolves.toEqual({ ok: true, id: teamId })

    const team = await testPool.query(`SELECT 1 FROM teams WHERE id = $1`, [teamId])
    expect(team.rowCount).toBe(0)
    // team_members cascades from teams; the retired user row stays.
    const memberships = await testPool.query(`SELECT 1 FROM team_members WHERE team_id = $1`, [
      teamId,
    ])
    expect(memberships.rowCount).toBe(0)
    const user = await testPool.query(`SELECT lifecycle_state FROM users WHERE id = $1::uuid`, [
      userId,
    ])
    expect(user.rows).toEqual([{ lifecycle_state: 'retired' }])
  })

  it('still refuses to delete a team that has an active member next to a retired one', async () => {
    const retiredId = await seedLinkedUser('retired-next-to-active')
    const activeId = await seedUser('active-next-to-retired')
    const teamId = await seedTeamWithMembers([retiredId, activeId])
    expect(await retire(retiredId, 'oidc-retire-next-to-active-v1')).toMatchObject({
      outcome: 'retired',
    })

    await expect(adminDeleteTeam(teamId)).resolves.toEqual({ error: 'team_not_empty' })

    const team = await testPool.query(`SELECT 1 FROM teams WHERE id = $1`, [teamId])
    expect(team.rowCount).toBe(1)
  })

  it('refuses adminDeleteUser for a linked member', async () => {
    const userId = await seedLinkedUser('linked-admin-delete')

    await expect(adminDeleteUser(userId)).resolves.toEqual({ error: 'linked_identity' })

    const user = await testPool.query(`SELECT 1 FROM users WHERE id = $1::uuid`, [userId])
    expect(user.rowCount).toBe(1)
  })

  it('still hard-deletes an unlinked member through adminDeleteUser', async () => {
    const userId = await seedUser('unlinked-admin-delete')

    await expect(adminDeleteUser(userId)).resolves.toEqual({ ok: true, id: userId })

    const user = await testPool.query(`SELECT 1 FROM users WHERE id = $1::uuid`, [userId])
    expect(user.rowCount).toBe(0)
  })
})
