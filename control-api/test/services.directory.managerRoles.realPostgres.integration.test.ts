import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import {
  deleteManagedUserForUser,
  listManagedPendingInvitationsForUser,
  revokeManagedInvitationForUser,
} from '../src/services/directory/membership.js'
import { createUser, createUserHomeDatabase } from './helpers/userHomeRealPostgres.js'

const holder = vi.hoisted(() => ({ pool: undefined as Pool | undefined }))
vi.mock('../src/db.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/db.js')>()
  return {
    ...actual,
    pool: { query: (...args: Parameters<Pool['query']>) => holder.pool!.query(...args) },
    withTransaction: ((work, txPool, options) =>
      actual.withTransaction(
        work,
        txPool ?? holder.pool,
        options
      )) as typeof actual.withTransaction,
  }
})

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

describeRealPostgres('team manager role lookup on PostgreSQL', () => {
  let adminPool: Pool
  let database: Awaited<ReturnType<typeof createUserHomeDatabase>>

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl! })
    database = await createUserHomeDatabase(adminUrl!, adminPool)
    holder.pool = database.pool
  }, 60_000)
  afterAll(async () => {
    try {
      holder.pool = undefined
      if (database) {
        await database.closeConnections()
        await adminPool.query(`DROP DATABASE "${database.database}"`)
      }
    } finally {
      await adminPool?.end()
    }
  }, 60_000)

  async function fixture() {
    const manager = await createUser(database.pool, 'Manager')
    const member = await createUser(database.pool, 'Member')
    const target = await createUser(database.pool, 'Target')
    const team = randomUUID()
    await database.pool.query('INSERT INTO teams(id,name) VALUES ($1,$2)', [team, 'Managed team'])
    await database.pool.query(
      `INSERT INTO team_members(team_id,user_id,role,status)
       VALUES ($1,$2,'admin','active'),($1,$3,'member','active'),($1,$4,'member','active')`,
      [team, manager, member, target]
    )
    return { manager, member, target, team }
  }

  async function invitation(team: string) {
    const result = await database.pool.query<{ id: string; email: string }>(
      `INSERT INTO invitations(team_id,email,role,purpose,status)
       VALUES ($1,$2,'member','member_invitation','pending') RETURNING id::text,email`,
      [team, `${randomUUID()}@example.test`]
    )
    const row = result.rows[0]!
    await database.pool.query(
      `INSERT INTO invitation_teams(invitation_id,team_id,role) VALUES ($1,$2,'member')`,
      [row.id, team]
    )
    return row
  }

  it('authorizes invitation revocation through the shared team-control check', async () => {
    const f = await fixture()
    const item = await invitation(f.team)
    expect(await revokeManagedInvitationForUser(f.member, item.id)).toEqual({ error: 'forbidden' })
    expect(await revokeManagedInvitationForUser(f.manager, item.id)).toEqual({
      revoked: true,
      id: item.id,
      email: item.email,
    })
    expect(
      (await database.pool.query('SELECT status FROM invitations WHERE id=$1', [item.id])).rows
    ).toEqual([{ status: 'revoked' }])
  })

  it('lists a pending invitation with the manager actions determined by membership', async () => {
    const f = await fixture()
    const item = await invitation(f.team)
    expect(await listManagedPendingInvitationsForUser(f.member)).toEqual([])
    expect(await listManagedPendingInvitationsForUser(f.manager)).toEqual([
      expect.objectContaining({ id: item.id, canCancel: true, canResend: true }),
    ])
  })

  it('allows an authorized manager to retire a managed user', async () => {
    const f = await fixture()
    const retirement = {
      reason: 'Manager role test',
      idempotencyKey: randomUUID(),
      requestId: null,
    }
    expect(await deleteManagedUserForUser(f.member, f.target, retirement)).toEqual({
      error: 'forbidden_uncontrolled_teams',
    })
    const result = await deleteManagedUserForUser(f.manager, f.target, retirement)
    expect(result).toMatchObject({ deleted: { ok: true, id: f.target } })
    expect(
      (await database.pool.query('SELECT id FROM users WHERE id=$1', [f.target])).rows
    ).toHaveLength(0)
  })
})
