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

  it('hands the inviter team roles to the new admin and retires the inviter on acceptance', async () => {
    const inviter = await seedAdmin('evenfire-ops')
    const inviterDesktopId = await seedDesktopUser(inviter.email)
    await seedOperatorLink(inviterDesktopId, inviter.id)
    const defaultTeam = await seedTeam('Default')
    const secondTeam = await seedTeam('Second')
    await addTeamMember(defaultTeam, inviterDesktopId, 'admin')
    await addTeamMember(secondTeam, inviterDesktopId, 'member')
    await testPool.query(
      `INSERT INTO workflow_approval_medium_accounts
         (user_id, medium, provider_user_id, communication_channel_ref, verified_at)
       VALUES ($1::uuid, 'telegram', $2, 'ops-approval-channel', NOW())`,
      [inviterDesktopId, `tg-${inviterDesktopId}`]
    )

    const clientEmail = uniqueEmail('client')
    const handover = await createControlAdminInvitation(clientEmail, inviter.id, {
      replaceInviter: true,
    })
    if ('error' in handover) throw new Error(handover.error)
    const clientDesktopInvitationId = await inviteDesktopAccess(clientEmail)
    const strayEmail = uniqueEmail('stray')
    const stray = await createControlAdminInvitation(strayEmail, inviter.id)
    if ('error' in stray) throw new Error(stray.error)
    const strayDesktopInvitationId = await inviteDesktopAccess(strayEmail)

    const completed = await completeControlAdminInvitation({
      email: clientEmail,
      invitationId: handover.id,
      username: `client-${randomUUID().slice(0, 8)}`,
      passwordHash: 'real-pg-replace-client',
    })
    if ('error' in completed) throw new Error(completed.error)
    // Same order as POST /admin/auth/control-admin-invitations/complete (auth.ts:486-510).
    const accepted = await acceptInvitationById(clientEmail, clientDesktopInvitationId)
    if ('error' in accepted) throw new Error(String(accepted.error))

    const roles = await testPool.query(
      `SELECT team_id::text AS team_id, role, status FROM team_members WHERE user_id = $1::uuid`,
      [accepted.data.userId]
    )
    expect(roles.rows).toHaveLength(2)
    expect(roles.rows).toEqual(
      expect.arrayContaining([
        { team_id: defaultTeam, role: 'admin', status: 'active' },
        { team_id: secondTeam, role: 'member', status: 'active' },
      ])
    )

    // Both inviter logins fail.
    await expect(findAdminByLogin(inviter.username)).resolves.toMatchObject({
      status: 'disabled',
      sessionVersion: 2,
    })
    await expect(
      passwordLoginData({ email: inviter.email, password: 'irrelevant' })
    ).resolves.toEqual({ error: 'user_retired' })

    const desktop = await testPool.query(
      `SELECT lifecycle_state, lifecycle_version, retirement_reason,
              retired_by_control_admin_id::text AS retired_by
         FROM users WHERE id = $1::uuid`,
      [inviterDesktopId]
    )
    expect(desktop.rows).toEqual([
      {
        lifecycle_state: 'retired',
        lifecycle_version: '2',
        retirement_reason: 'control_admin_replaced',
        retired_by: completed.id,
      },
    ])
    const link = await testPool.query(
      `SELECT state, revocation_reason FROM gfs_desktop_operator_links WHERE control_admin_id = $1::uuid`,
      [inviter.id]
    )
    expect(link.rows).toEqual([{ state: 'revoked', revocation_reason: 'control_admin_replaced' }])
    const approvalMedium = await testPool.query(
      `SELECT disabled_at IS NOT NULL AS disabled
         FROM workflow_approval_medium_accounts WHERE user_id = $1::uuid`,
      [inviterDesktopId]
    )
    expect(approvalMedium.rows).toEqual([{ disabled: true }])
    const audit = await testPool.query(
      `SELECT actor_admin_id::text AS actor, target_admin_id::text AS target
         FROM control_admin_deletion_audit WHERE target_admin_id = $1::uuid`,
      [inviter.id]
    )
    expect(audit.rows).toEqual([{ actor: completed.id, target: inviter.id }])

    expect(await adminInvitationStatus(handover.id)).toBe('accepted')
    expect(await desktopInvitationStatus(clientDesktopInvitationId)).toBe('accepted')
    expect(await adminInvitationStatus(stray.id)).toBe('revoked')
    expect(await desktopInvitationStatus(strayDesktopInvitationId)).toBe('revoked')
  })

  it('raises an existing desktop user of the new admin to the inviter roles', async () => {
    const inviter = await seedAdmin('raise-ops')
    const inviterDesktopId = await seedDesktopUser(inviter.email)
    const team = await seedTeam('Raise')
    await addTeamMember(team, inviterDesktopId, 'admin')
    const clientEmail = uniqueEmail('existing-client')
    const clientDesktopId = await seedDesktopUser(clientEmail)
    await addTeamMember(team, clientDesktopId, 'member')
    const handover = await createControlAdminInvitation(clientEmail, inviter.id, {
      replaceInviter: true,
    })
    if ('error' in handover) throw new Error(handover.error)

    const completed = await completeControlAdminInvitation({
      email: clientEmail,
      invitationId: handover.id,
      username: `existing-${randomUUID().slice(0, 8)}`,
      passwordHash: 'real-pg-replace-client',
    })
    if ('error' in completed) throw new Error(completed.error)

    const role = await testPool.query(
      `SELECT role FROM team_members WHERE team_id = $1::uuid AND user_id = $2::uuid`,
      [team, clientDesktopId]
    )
    expect(role.rows).toEqual([{ role: 'admin' }])
    expect(await desktopLifecycle(inviterDesktopId)).toBe('retired')
  })

  it('behaves as today when replaceInviter is false', async () => {
    const inviter = await seedAdmin('plain-ops')
    const inviterDesktopId = await seedDesktopUser(inviter.email)
    const clientEmail = uniqueEmail('plain-client')
    const invitation = await createControlAdminInvitation(clientEmail, inviter.id)
    if ('error' in invitation) throw new Error(invitation.error)
    const stray = await createControlAdminInvitation(uniqueEmail('plain-stray'), inviter.id)
    if ('error' in stray) throw new Error(stray.error)

    const completed = await completeControlAdminInvitation({
      email: clientEmail,
      invitationId: invitation.id,
      username: `plain-${randomUUID().slice(0, 8)}`,
      passwordHash: 'real-pg-replace-client',
    })
    if ('error' in completed) throw new Error(completed.error)

    expect(await adminStatus(inviter.id)).toBe('active')
    expect(await desktopLifecycle(inviterDesktopId)).toBe('active')
    expect(await adminInvitationStatus(stray.id)).toBe('pending')
  })

  it('still completes when the inviter is already disabled or gone', async () => {
    const inviter = await seedAdmin('gone-ops')
    const inviterDesktopId = await seedDesktopUser(inviter.email)
    const disabledEmail = uniqueEmail('after-disable')
    const afterDisable = await createControlAdminInvitation(disabledEmail, inviter.id, {
      replaceInviter: true,
    })
    if ('error' in afterDisable) throw new Error(afterDisable.error)
    await testPool.query(`UPDATE control_admin_users SET status = 'disabled' WHERE id = $1::uuid`, [
      inviter.id,
    ])
    const orphanEmail = uniqueEmail('orphan')
    const orphan = await testPool.query(
      `INSERT INTO control_admin_invitations (email, invited_by_admin_id, replace_inviter)
       VALUES ($1, NULL, true) RETURNING id::text AS id`,
      [orphanEmail]
    )
    const orphanId = (orphan.rows[0] as { id: string }).id

    for (const [email, invitationId] of [
      [disabledEmail, afterDisable.id],
      [orphanEmail, orphanId],
    ] as const) {
      const completed = await completeControlAdminInvitation({
        email,
        invitationId,
        username: `late-${randomUUID().slice(0, 8)}`,
        passwordHash: 'real-pg-replace-client',
      })
      expect(completed).toMatchObject({ email, status: 'active' })
      expect(await adminInvitationStatus(invitationId)).toBe('accepted')
    }
    expect(await desktopLifecycle(inviterDesktopId)).toBe('active')
  })

  it('does not complete an invitation revoked while the acceptance is in flight', async () => {
    const inviter = await seedAdmin('race-ops')
    const email = uniqueEmail('race-client')
    const invitation = await createControlAdminInvitation(email, inviter.id)
    if ('error' in invitation) throw new Error(invitation.error)

    // A revoke (DELETE route, MCC cancel, or another invitation's replace step 4)
    // holds the row while the client's acceptance starts, then commits.
    const blocker = await testPool.connect()
    try {
      await blocker.query('BEGIN')
      await blocker.query(
        `UPDATE control_admin_invitations SET status = 'revoked' WHERE id = $1::uuid`,
        [invitation.id]
      )
      const completion = completeControlAdminInvitation({
        email,
        invitationId: invitation.id,
        username: `race-${randomUUID().slice(0, 8)}`,
        passwordHash: 'real-pg-replace-client',
      })
      for (let attempt = 0; ; attempt += 1) {
        const waiting = await adminPool.query(
          `SELECT 1 FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock'`,
          [database]
        )
        if ((waiting.rowCount ?? 0) > 0) break
        if (attempt >= 100)
          throw new Error('the acceptance never waited on the revoking transaction')
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      await blocker.query('COMMIT')
      await expect(completion).resolves.toEqual({ error: 'not_found' })
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined)
      blocker.release()
    }

    expect(await adminInvitationStatus(invitation.id)).toBe('revoked')
    const admins = await testPool.query(
      `SELECT 1 FROM control_admin_users WHERE lower(email) = lower($1)`,
      [email]
    )
    expect(admins.rowCount).toBe(0)
  })
})
