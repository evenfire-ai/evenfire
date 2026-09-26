import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { initDb, pool } from '../src/db.js'
import {
  completeControlAdminInvitation,
  createControlAdminInvitation,
  findAdminByLogin,
  getPendingControlAdminInvitation,
  listControlAdmins,
  revokeControlAdminInvitation,
} from '../src/services/adminAuthService.js'
import { passwordLoginData } from '../src/services/directory/login.js'
import {
  acceptInvitationById,
  createSilentInvitationForTeams,
} from '../src/services/directory/membership.js'

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

function uniqueEmail(label: string): string {
  return `${label}-${randomUUID()}@example.test`
}

describeRealPostgres('control admin replace-inviter invitations on real PostgreSQL', () => {
  const database = `control_admin_replace_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres',
    database
  )
  let adminPool: Pool
  let testPool: Pool
  let connectSpy: ReturnType<typeof vi.spyOn>
  let querySpy: ReturnType<typeof vi.spyOn>

  async function seedAdmin(
    label: string
  ): Promise<{ id: string; username: string; email: string }> {
    const id = randomUUID()
    const username = `${label}-${id.slice(0, 8)}`
    const email = `${username}@example.test`
    await testPool.query(
      `INSERT INTO control_admin_users (id, username, email, password_hash, role, status, session_version)
       VALUES ($1, $2, $3, 'real-pg-replace-test', 'admin', 'active', 1)`,
      [id, username, email]
    )
    return { id, username, email }
  }

  async function seedDesktopUser(email: string): Promise<string> {
    const id = randomUUID()
    await testPool.query(`INSERT INTO users (id, email, name) VALUES ($1, $2, $3)`, [
      id,
      email,
      email,
    ])
    return id
  }

  async function seedTeam(name: string): Promise<string> {
    const result = await testPool.query(
      `INSERT INTO teams (name) VALUES ($1) RETURNING id::text AS id`,
      [name]
    )
    return (result.rows[0] as { id: string }).id
  }

  async function addTeamMember(teamId: string, userId: string, role: string): Promise<void> {
    await testPool.query(
      `INSERT INTO team_members (team_id, user_id, role, status) VALUES ($1::uuid, $2::uuid, $3, 'active')`,
      [teamId, userId, role]
    )
  }

  async function seedOperatorLink(userId: string, adminId: string): Promise<void> {
    await testPool.query(
      `INSERT INTO gfs_desktop_operator_links
         (id, lineage_id, generation, user_id, control_admin_id, state, source, created_by, row_version)
       VALUES (gen_random_uuid(), gen_random_uuid(), 1, $1::uuid, $2::uuid,
               'active', 'initial_setup', $2::uuid, 1)`,
      [userId, adminId]
    )
  }

  async function inviteDesktopAccess(email: string): Promise<string> {
    const invitation = await createSilentInvitationForTeams({
      inviteeName: email,
      email,
      teamAssignments: [],
      fallbackRole: 'member',
      purpose: 'admin_desktop_access',
    })
    return invitation.id
  }

  async function adminInvitationStatus(id: string): Promise<string | undefined> {
    const result = await testPool.query(
      `SELECT status FROM control_admin_invitations WHERE id = $1::uuid`,
      [id]
    )
    return (result.rows[0] as { status?: string } | undefined)?.status
  }

  async function desktopInvitationStatus(id: string): Promise<string | undefined> {
    const result = await testPool.query(`SELECT status FROM invitations WHERE id = $1::uuid`, [id])
    return (result.rows[0] as { status?: string } | undefined)?.status
  }

  async function adminStatus(id: string): Promise<string | undefined> {
    const result = await testPool.query(
      `SELECT status FROM control_admin_users WHERE id = $1::uuid`,
      [id]
    )
    return (result.rows[0] as { status?: string } | undefined)?.status
  }

  async function desktopLifecycle(id: string): Promise<string | undefined> {
    const result = await testPool.query(`SELECT lifecycle_state FROM users WHERE id = $1::uuid`, [
      id,
    ])
    return (result.rows[0] as { lifecycle_state?: string } | undefined)?.lifecycle_state
  }

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdent(database)}`)
    testPool = new Pool({ connectionString })
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
    querySpy?.mockRestore()
    connectSpy?.mockRestore()
    await testPool?.end()
    if (!adminPool) return
    await adminPool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [database]
    )
    await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdent(database)}`)
    await adminPool.end()
  })

  it('stores replaceInviter and exposes it with the inviter on every invitation read', async () => {
    const inviter = await seedAdmin('lister')
    const replacing = await createControlAdminInvitation(uniqueEmail('replacing'), inviter.id, {
      replaceInviter: true,
    })
    const plain = await createControlAdminInvitation(uniqueEmail('plain'), inviter.id)
    if ('error' in replacing || 'error' in plain) throw new Error('invitation insert failed')

    expect(replacing).toMatchObject({ replaceInviter: true, invitedByAdminId: inviter.id })
    expect(plain).toMatchObject({ replaceInviter: false, invitedByAdminId: inviter.id })

    const listed = await listControlAdmins()
    expect(listed.invitations.find(item => item.id === replacing.id)).toMatchObject({
      replaceInviter: true,
      invitedByAdminId: inviter.id,
    })
    expect(listed.invitations.find(item => item.id === plain.id)).toMatchObject({
      replaceInviter: false,
      invitedByAdminId: inviter.id,
    })
    await expect(
      getPendingControlAdminInvitation(testPool, replacing.id, replacing.email)
    ).resolves.toMatchObject({ replaceInviter: true, invitedByAdminId: inviter.id })
  })

  it('revokes the same-email desktop invitation with the admin invitation and leaves the inviter untouched', async () => {
    const inviter = await seedAdmin('revoker')
    const inviterDesktopId = await seedDesktopUser(inviter.email)
    const clientEmail = uniqueEmail('revoked-client')
    const invitation = await createControlAdminInvitation(clientEmail, inviter.id, {
      replaceInviter: true,
    })
    if ('error' in invitation) throw new Error(invitation.error)
    const desktopInvitationId = await inviteDesktopAccess(clientEmail)
    const unrelatedDesktopInvitationId = await inviteDesktopAccess(uniqueEmail('unrelated'))

    await revokeControlAdminInvitation(invitation.id)

    expect(await adminInvitationStatus(invitation.id)).toBe('revoked')
    expect(await desktopInvitationStatus(desktopInvitationId)).toBe('revoked')
    expect(await desktopInvitationStatus(unrelatedDesktopInvitationId)).toBe('pending')
    expect(await adminStatus(inviter.id)).toBe('active')
    expect(await desktopLifecycle(inviterDesktopId)).toBe('active')
    await expect(
      completeControlAdminInvitation({
        email: clientEmail,
        invitationId: invitation.id,
        username: `client-${randomUUID().slice(0, 8)}`,
        passwordHash: 'real-pg-replace-client',
      })
    ).resolves.toEqual({ error: 'not_found' })
  })
})
