import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { config } from '../src/config.js'
import { initDb, pool } from '../src/db.js'
import type { K8sGateway } from '../src/k8s.js'
import { rootLogger } from '../src/observability/logger.js'
import type { RpcAccessClaims } from '../src/profileTypes.js'
import { authorizeRpcHostAccess } from '../src/services/access/rpcHostAccessAuthorizer.js'
import {
  completeControlAdminInvitation,
  createControlAdminInvitation,
  findAdminByLogin,
  getPendingControlAdminInvitation,
  listControlAdmins,
  markControlAdminInvitationOpened,
  revokeControlAdminInvitation,
} from '../src/services/adminAuthService.js'
import { getCurrentTeam } from '../src/services/directory/index.js'
import { passwordLoginData } from '../src/services/directory/login.js'
import {
  acceptInvitationById,
  createSilentInvitationForTeams,
} from '../src/services/directory/membership.js'
import { retireDesktopUser } from '../src/services/directory/users.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'
import './realPostgres.requirement.ts'
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

function uniqueEmail(label: string): string {
  return `${label}-${randomUUID()}@example.test`
}

describeRealPostgres('control admin replace-inviter invitations on real PostgreSQL', () => {
  const database = `control_admin_replace_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? 'postgresql://postgres@db.example.com/postgres',
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

  async function revokeOperatorLink(adminId: string): Promise<void> {
    await testPool.query(
      `UPDATE gfs_desktop_operator_links
          SET state = 'revoked',
              revoked_at = NOW(),
              revoked_by_type = 'control_admin',
              revoked_by_id = $1::uuid,
              revocation_reason = 'test revoke',
              row_version = row_version + 1
        WHERE control_admin_id = $1::uuid
          AND state = 'active'`,
      [adminId]
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

  async function teamRole(teamId: string, userId: string): Promise<string | undefined> {
    const result = await testPool.query(
      `SELECT role FROM team_members WHERE team_id = $1::uuid AND user_id = $2::uuid AND status = 'active'`,
      [teamId, userId]
    )
    return (result.rows[0] as { role?: string } | undefined)?.role
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
    await endPoolAndWaitForClients(testPool)
    if (!adminPool) return
    try {
      await waitForDatabaseConnectionsToClose(adminPool, database)
      await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdent(database)}`)
    } finally {
      await adminPool.end()
    }
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
    const memberInvitation = await testPool.query(
      `INSERT INTO invitations (email, role, status, purpose)
       VALUES ($1, 'member', 'pending', 'member_invitation') RETURNING id::text AS id`,
      [clientEmail]
    )
    const memberInvitationId = (memberInvitation.rows[0] as { id: string }).id

    await revokeControlAdminInvitation(invitation.id)

    expect(await adminInvitationStatus(invitation.id)).toBe('revoked')
    expect(await desktopInvitationStatus(desktopInvitationId)).toBe('revoked')
    expect(await desktopInvitationStatus(unrelatedDesktopInvitationId)).toBe('pending')
    expect(await desktopInvitationStatus(memberInvitationId)).toBe('pending')
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
    await testPool.query(
      `INSERT INTO workflow_approval_medium_challenges
         (user_id, medium, provider_user_id, code_hash, expires_at)
       VALUES ($1::uuid, 'telegram', $2, 'example-code-hash', NOW() + INTERVAL '10 minutes')`,
      [inviterDesktopId, `tg-${inviterDesktopId}`]
    )
    const otherAdmin = await seedAdmin('other-ops')
    const otherEmail = uniqueEmail('other-client')
    const otherInvitation = await createControlAdminInvitation(otherEmail, otherAdmin.id)
    if ('error' in otherInvitation) throw new Error(otherInvitation.error)
    const otherDesktopInvitationId = await inviteDesktopAccess(otherEmail)

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
      passwordLoginData({ email: inviter.email, password: 'example-password' })
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
    const challenge = await testPool.query(
      `SELECT consumed_at IS NOT NULL AS consumed
         FROM workflow_approval_medium_challenges WHERE user_id = $1::uuid`,
      [inviterDesktopId]
    )
    expect(challenge.rows).toEqual([{ consumed: true }])
    const audit = await testPool.query(
      `SELECT actor_admin_id::text AS actor, target_admin_id::text AS target
         FROM control_admin_deletion_audit WHERE target_admin_id = $1::uuid`,
      [inviter.id]
    )
    expect(audit.rows).toEqual([{ actor: completed.id, target: inviter.id }])
    const deletedEvent = await testPool.query(
      `SELECT payload_metadata->>'reason_code' AS reason_code,
              payload_metadata->>'detail_ref' AS detail_ref
         FROM administrative_events
        WHERE action = 'control_admin_deleted' AND target_human_sub = $1`,
      [inviter.id]
    )
    expect(deletedEvent.rows).toEqual([
      {
        reason_code: 'control_admin_replaced',
        detail_ref: `control_admin_invitation:${handover.id}`,
      },
    ])

    expect(await adminInvitationStatus(handover.id)).toBe('accepted')
    expect(await desktopInvitationStatus(clientDesktopInvitationId)).toBe('accepted')
    expect(await adminInvitationStatus(stray.id)).toBe('revoked')
    expect(await desktopInvitationStatus(strayDesktopInvitationId)).toBe('revoked')
    // Only the inviter's own invitations are revoked.
    expect(await adminInvitationStatus(otherInvitation.id)).toBe('pending')
    expect(await desktopInvitationStatus(otherDesktopInvitationId)).toBe('pending')
  })

  it('finds the inviter desktop user by operator link after an admin email change', async () => {
    const inviter = await seedAdmin('moved-ops')
    const linkedDesktopId = await seedDesktopUser(inviter.email)
    await seedOperatorLink(linkedDesktopId, inviter.id)
    const team = await seedTeam('Moved')
    await addTeamMember(team, linkedDesktopId, 'admin')
    // completeControlAdminEmailChangeRequest updates control_admin_users only.
    const movedEmail = uniqueEmail('moved-ops')
    await testPool.query(`UPDATE control_admin_users SET email = $2 WHERE id = $1::uuid`, [
      inviter.id,
      movedEmail,
    ])
    const bystanderId = await seedDesktopUser(movedEmail)
    const bystanderTeam = await seedTeam('Bystander')
    await addTeamMember(bystanderTeam, bystanderId, 'member')

    const clientEmail = uniqueEmail('moved-client')
    const handover = await createControlAdminInvitation(clientEmail, inviter.id, {
      replaceInviter: true,
    })
    if ('error' in handover) throw new Error(handover.error)
    const clientDesktopInvitationId = await inviteDesktopAccess(clientEmail)
    const completed = await completeControlAdminInvitation({
      email: clientEmail,
      invitationId: handover.id,
      username: `moved-${randomUUID().slice(0, 8)}`,
      passwordHash: 'real-pg-replace-client',
    })
    if ('error' in completed) throw new Error(completed.error)
    const accepted = await acceptInvitationById(clientEmail, clientDesktopInvitationId)
    if ('error' in accepted) throw new Error(String(accepted.error))

    expect(await desktopLifecycle(linkedDesktopId)).toBe('retired')
    expect(await teamRole(team, accepted.data.userId)).toBe('admin')
    expect(await desktopLifecycle(bystanderId)).toBe('active')
    expect(await teamRole(bystanderTeam, accepted.data.userId)).toBeUndefined()
  })

  it('never downgrades a role the new admin already holds or was invited with', async () => {
    const inviter = await seedAdmin('keep-ops')
    const inviterDesktopId = await seedDesktopUser(inviter.email)
    const heldTeam = await seedTeam('Held')
    const invitedTeam = await seedTeam('Invited')
    await addTeamMember(heldTeam, inviterDesktopId, 'member')
    await addTeamMember(invitedTeam, inviterDesktopId, 'member')
    const clientEmail = uniqueEmail('keep-client')
    const clientDesktopId = await seedDesktopUser(clientEmail)
    await addTeamMember(heldTeam, clientDesktopId, 'admin')
    const handover = await createControlAdminInvitation(clientEmail, inviter.id, {
      replaceInviter: true,
    })
    if ('error' in handover) throw new Error(handover.error)
    const desktopInvitation = await createSilentInvitationForTeams({
      inviteeName: clientEmail,
      email: clientEmail,
      teamAssignments: [{ teamId: invitedTeam, role: 'admin' }],
      fallbackRole: 'member',
      purpose: 'admin_desktop_access',
    })

    const completed = await completeControlAdminInvitation({
      email: clientEmail,
      invitationId: handover.id,
      username: `keep-${randomUUID().slice(0, 8)}`,
      passwordHash: 'real-pg-replace-client',
    })
    if ('error' in completed) throw new Error(completed.error)
    expect(await teamRole(heldTeam, clientDesktopId)).toBe('admin')
    const accepted = await acceptInvitationById(clientEmail, desktopInvitation.id)
    if ('error' in accepted) throw new Error(String(accepted.error))

    expect(accepted.data.userId).toBe(clientDesktopId)
    expect(await teamRole(heldTeam, clientDesktopId)).toBe('admin')
    expect(await teamRole(invitedTeam, clientDesktopId)).toBe('admin')
  })

  it('reactivates a deleted membership with the inviter role, not its stale role', async () => {
    const inviter = await seedAdmin('stale-ops')
    const inviterDesktopId = await seedDesktopUser(inviter.email)
    const team = await seedTeam('Stale')
    await addTeamMember(team, inviterDesktopId, 'member')
    const clientEmail = uniqueEmail('stale-client')
    const clientDesktopId = await seedDesktopUser(clientEmail)
    await testPool.query(
      `INSERT INTO team_members (team_id, user_id, role, status) VALUES ($1::uuid, $2::uuid, 'admin', 'deleted')`,
      [team, clientDesktopId]
    )
    const handover = await createControlAdminInvitation(clientEmail, inviter.id, {
      replaceInviter: true,
    })
    if ('error' in handover) throw new Error(handover.error)

    const completed = await completeControlAdminInvitation({
      email: clientEmail,
      invitationId: handover.id,
      username: `stale-${randomUUID().slice(0, 8)}`,
      passwordHash: 'real-pg-replace-client',
    })
    if ('error' in completed) throw new Error(completed.error)

    expect(await teamRole(team, clientDesktopId)).toBe('member')
  })

  it('keeps the fallback team of a legacy single-team desktop invitation', async () => {
    const inviter = await seedAdmin('legacy-ops')
    const inviterDesktopId = await seedDesktopUser(inviter.email)
    const inviterTeam = await seedTeam('Legacy inviter')
    const legacyTeam = await seedTeam('Legacy invited')
    await addTeamMember(inviterTeam, inviterDesktopId, 'member')
    const clientEmail = uniqueEmail('legacy-client')
    const handover = await createControlAdminInvitation(clientEmail, inviter.id, {
      replaceInviter: true,
    })
    if ('error' in handover) throw new Error(handover.error)
    // Written before invitation_teams existed: only invitations.team_id is set.
    const legacy = await testPool.query(
      `INSERT INTO invitations (team_id, email, role, status, purpose)
       VALUES ($1::uuid, $2, 'admin', 'pending', 'admin_desktop_access') RETURNING id::text AS id`,
      [legacyTeam, clientEmail]
    )
    const legacyInvitationId = (legacy.rows[0] as { id: string }).id

    const completed = await completeControlAdminInvitation({
      email: clientEmail,
      invitationId: handover.id,
      username: `legacy-${randomUUID().slice(0, 8)}`,
      passwordHash: 'real-pg-replace-client',
    })
    if ('error' in completed) throw new Error(completed.error)
    const accepted = await acceptInvitationById(clientEmail, legacyInvitationId)
    if ('error' in accepted) throw new Error(String(accepted.error))

    expect(await teamRole(legacyTeam, accepted.data.userId)).toBe('admin')
    expect(await teamRole(inviterTeam, accepted.data.userId)).toBe('member')
  })

  it('never hands over the roles of an already retired same-email desktop user', async () => {
    const inviter = await seedAdmin('retired-desk-ops')
    const retiredDesktopId = await seedDesktopUser(inviter.email)
    const team = await seedTeam('Retired desk')
    await addTeamMember(team, retiredDesktopId, 'admin')
    const retirer = await seedAdmin('retirer-ops')
    await retireDesktopUser(
      { kind: 'control_admin', controlAdminId: retirer.id },
      retiredDesktopId,
      'real-pg earlier retirement',
      `earlier-${retiredDesktopId}`,
      null,
      { retainWithoutLinkHistory: true }
    )
    expect(await desktopLifecycle(retiredDesktopId)).toBe('retired')

    const clientEmail = uniqueEmail('retired-desk-client')
    const handover = await createControlAdminInvitation(clientEmail, inviter.id, {
      replaceInviter: true,
    })
    if ('error' in handover) throw new Error(handover.error)
    const clientDesktopInvitationId = await inviteDesktopAccess(clientEmail)
    const completed = await completeControlAdminInvitation({
      email: clientEmail,
      invitationId: handover.id,
      username: `retired-desk-${randomUUID().slice(0, 8)}`,
      passwordHash: 'real-pg-replace-client',
    })
    if ('error' in completed) throw new Error(completed.error)
    const accepted = await acceptInvitationById(clientEmail, clientDesktopInvitationId)
    if ('error' in accepted) throw new Error(String(accepted.error))

    expect(await adminStatus(inviter.id)).toBe('disabled')
    expect(await teamRole(team, accepted.data.userId)).toBeUndefined()
    const retirement = await testPool.query(
      `SELECT retirement_reason FROM users WHERE id = $1::uuid`,
      [retiredDesktopId]
    )
    expect(retirement.rows).toEqual([{ retirement_reason: 'real-pg earlier retirement' }])
  })

  it('refuses a hand-over that has nobody to receive the inviter team roles', async () => {
    const inviter = await seedAdmin('nobody-ops')
    const inviterDesktopId = await seedDesktopUser(inviter.email)
    const team = await seedTeam('Nobody')
    await addTeamMember(team, inviterDesktopId, 'admin')
    const clientEmail = uniqueEmail('nobody-client')
    const handover = await createControlAdminInvitation(clientEmail, inviter.id, {
      replaceInviter: true,
    })
    if ('error' in handover) throw new Error(handover.error)

    await expect(
      completeControlAdminInvitation({
        email: clientEmail,
        invitationId: handover.id,
        username: `nobody-${randomUUID().slice(0, 8)}`,
        passwordHash: 'real-pg-replace-client',
      })
    ).resolves.toEqual({ error: 'replace_inviter_receiver_missing' })

    expect(await adminInvitationStatus(handover.id)).toBe('pending')
    expect(await adminStatus(inviter.id)).toBe('active')
    expect(await desktopLifecycle(inviterDesktopId)).toBe('active')
    expect(await teamRole(team, inviterDesktopId)).toBe('admin')
    const admins = await testPool.query(
      `SELECT 1 FROM control_admin_users WHERE lower(email) = lower($1)`,
      [clientEmail]
    )
    expect(admins.rowCount).toBe(0)
  })

  it('accepts one of two concurrent hand-overs from the same inviter without a deadlock', async () => {
    const inviter = await seedAdmin('twin-ops')
    const emails = [uniqueEmail('twin-a'), uniqueEmail('twin-b')]
    const invitations = []
    for (const email of emails) {
      const invitation = await createControlAdminInvitation(email, inviter.id, {
        replaceInviter: true,
      })
      if ('error' in invitation) throw new Error(invitation.error)
      invitations.push(invitation)
    }

    const results = await Promise.all(
      invitations.map((invitation, index) =>
        completeControlAdminInvitation({
          email: emails[index],
          invitationId: invitation.id,
          username: `twin-${index}-${randomUUID().slice(0, 8)}`,
          passwordHash: 'real-pg-replace-client',
        })
      )
    )

    const winners = results.filter(result => !('error' in result))
    expect(winners).toHaveLength(1)
    expect(results.filter(result => 'error' in result)).toEqual([{ error: 'not_found' }])
    expect(await adminStatus(inviter.id)).toBe('disabled')
  })

  it('denies the retired inviter team-granted host access although its team rows stay active', async () => {
    const inviter = await seedAdmin('rpc-ops')
    const inviterDesktopId = await seedDesktopUser(inviter.email)
    const team = await seedTeam('Rpc')
    await addTeamMember(team, inviterDesktopId, 'admin')
    const hostRef = `host-${randomUUID().slice(0, 8)}`
    await testPool.query(`INSERT INTO team_agents (team_id, agent_name) VALUES ($1::uuid, $2)`, [
      team,
      hostRef,
    ])
    const gateway = {
      listResource: async (plural: string, namespace: string) => {
        expect(plural).toBe('hosts')
        expect(namespace).toBe(config.hostsNamespace)
        return [{ metadata: { name: hostRef }, spec: { enabled: true } }]
      },
    } as unknown as K8sGateway
    // A token minted before the handover stays valid until it expires.
    const claims: RpcAccessClaims = {
      sub: inviterDesktopId,
      typ: 'user',
      accessScope: 'team',
      teamId: team,
      role: 'admin',
      scopes: ['host:message:invoke'],
      hostRefs: [hostRef],
      jti: randomUUID(),
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
    }
    await expect(
      authorizeRpcHostAccess(gateway, claims, inviterDesktopId, hostRef)
    ).resolves.toMatchObject({ authorized: true })

    const clientEmail = uniqueEmail('rpc-client')
    const handover = await createControlAdminInvitation(clientEmail, inviter.id, {
      replaceInviter: true,
    })
    if ('error' in handover) throw new Error(handover.error)
    await inviteDesktopAccess(clientEmail)
    const completed = await completeControlAdminInvitation({
      email: clientEmail,
      invitationId: handover.id,
      username: `rpc-${randomUUID().slice(0, 8)}`,
      passwordHash: 'real-pg-replace-client',
    })
    if ('error' in completed) throw new Error(completed.error)

    // Retirement, like every other retirement path, keeps team_members; the
    // users.lifecycle_state join in getCurrentTeam is what closes team access.
    const rows = await testPool.query(
      `SELECT status FROM team_members WHERE team_id = $1::uuid AND user_id = $2::uuid`,
      [team, inviterDesktopId]
    )
    expect(rows.rows).toEqual([{ status: 'active' }])
    await expect(getCurrentTeam(inviterDesktopId, team)).resolves.toBeNull()
    await expect(
      authorizeRpcHostAccess(gateway, claims, inviterDesktopId, hostRef)
    ).resolves.toEqual({ authorized: false, reason: 'team_membership_missing' })
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
      // Observe an early rejection here instead of as an unhandled rejection.
      completion.catch(() => undefined)
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
  }, 15_000)

  it('refuses a hand-over when a retired desktop user holds the invitee email', async () => {
    const inviter = await seedAdmin('retired-receiver-ops')
    const inviterDesktopId = await seedDesktopUser(inviter.email)
    const team = await seedTeam('Retired receiver')
    await addTeamMember(team, inviterDesktopId, 'admin')
    const clientEmail = uniqueEmail('retired-receiver')
    const retiredReceiverId = await seedDesktopUser(clientEmail)
    const retirer = await seedAdmin('retired-receiver-actor')
    await retireDesktopUser(
      { kind: 'control_admin', controlAdminId: retirer.id },
      retiredReceiverId,
      'invitee already retired',
      `retired-receiver-${retiredReceiverId}`,
      null,
      { retainWithoutLinkHistory: true }
    )
    const handover = await createControlAdminInvitation(clientEmail, inviter.id, {
      replaceInviter: true,
    })
    if ('error' in handover) throw new Error(handover.error)
    const desktopInvitationId = await inviteDesktopAccess(clientEmail)

    await expect(
      completeControlAdminInvitation({
        email: clientEmail,
        invitationId: handover.id,
        username: `retired-receiver-${randomUUID().slice(0, 8)}`,
        passwordHash: 'real-pg-replace-client',
      })
    ).resolves.toEqual({ error: 'replace_inviter_receiver_missing' })

    expect(await adminInvitationStatus(handover.id)).toBe('pending')
    expect(await desktopInvitationStatus(desktopInvitationId)).toBe('pending')
    expect(await adminStatus(inviter.id)).toBe('active')
    expect(await desktopLifecycle(inviterDesktopId)).toBe('active')
    expect(await desktopLifecycle(retiredReceiverId)).toBe('retired')
    expect(await teamRole(team, inviterDesktopId)).toBe('admin')
  })

  it('refuses a hand-over onto the inviter own desktop email', async () => {
    const inviter = await seedAdmin('self-ops')
    const desktopEmail = inviter.email
    const inviterDesktopId = await seedDesktopUser(desktopEmail)
    await seedOperatorLink(inviterDesktopId, inviter.id)
    const team = await seedTeam('Self')
    await addTeamMember(team, inviterDesktopId, 'admin')
    await testPool.query(`UPDATE control_admin_users SET email = $2 WHERE id = $1::uuid`, [
      inviter.id,
      uniqueEmail('self-moved'),
    ])
    const handover = await createControlAdminInvitation(desktopEmail, inviter.id, {
      replaceInviter: true,
    })
    if ('error' in handover) throw new Error(handover.error)
    await inviteDesktopAccess(desktopEmail)

    await expect(
      completeControlAdminInvitation({
        email: desktopEmail,
        invitationId: handover.id,
        username: `self-${randomUUID().slice(0, 8)}`,
        passwordHash: 'real-pg-replace-client',
      })
    ).resolves.toEqual({ error: 'replace_inviter_receiver_missing' })

    expect(await adminInvitationStatus(handover.id)).toBe('pending')
    expect(await adminStatus(inviter.id)).toBe('active')
    expect(await desktopLifecycle(inviterDesktopId)).toBe('active')
    expect(await teamRole(team, inviterDesktopId)).toBe('admin')
    const link = await testPool.query(
      `SELECT state FROM gfs_desktop_operator_links WHERE control_admin_id = $1::uuid`,
      [inviter.id]
    )
    expect(link.rows).toEqual([{ state: 'active' }])
  })

  it('retires the desktop user named by a revoked operator link', async () => {
    const inviter = await seedAdmin('revoked-link-ops')
    const linkedDesktopId = await seedDesktopUser(inviter.email)
    await seedOperatorLink(linkedDesktopId, inviter.id)
    const team = await seedTeam('Revoked link')
    await addTeamMember(team, linkedDesktopId, 'admin')
    await revokeOperatorLink(inviter.id)
    await testPool.query(`UPDATE control_admin_users SET email = $2 WHERE id = $1::uuid`, [
      inviter.id,
      uniqueEmail('revoked-link-moved'),
    ])
    const clientEmail = uniqueEmail('revoked-link-client')
    const handover = await createControlAdminInvitation(clientEmail, inviter.id, {
      replaceInviter: true,
    })
    if ('error' in handover) throw new Error(handover.error)
    const clientDesktopInvitationId = await inviteDesktopAccess(clientEmail)

    const completed = await completeControlAdminInvitation({
      email: clientEmail,
      invitationId: handover.id,
      username: `revoked-link-${randomUUID().slice(0, 8)}`,
      passwordHash: 'real-pg-replace-client',
    })
    if ('error' in completed) throw new Error(completed.error)
    const accepted = await acceptInvitationById(clientEmail, clientDesktopInvitationId)
    if ('error' in accepted) throw new Error(String(accepted.error))

    expect(await adminStatus(inviter.id)).toBe('disabled')
    expect(await desktopLifecycle(linkedDesktopId)).toBe('retired')
    expect(await teamRole(team, accepted.data.userId)).toBe('admin')
  })

  it('does not retire a bystander when the operator link is revoked and the admin email changed', async () => {
    const inviter = await seedAdmin('revoked-bystander-ops')
    const linkedDesktopId = await seedDesktopUser(inviter.email)
    await seedOperatorLink(linkedDesktopId, inviter.id)
    const team = await seedTeam('Revoked bystander inviter')
    await addTeamMember(team, linkedDesktopId, 'admin')
    await revokeOperatorLink(inviter.id)
    const movedEmail = uniqueEmail('revoked-bystander-moved')
    await testPool.query(`UPDATE control_admin_users SET email = $2 WHERE id = $1::uuid`, [
      inviter.id,
      movedEmail,
    ])
    const bystanderId = await seedDesktopUser(movedEmail)
    const bystanderTeam = await seedTeam('Revoked bystander')
    await addTeamMember(bystanderTeam, bystanderId, 'member')
    const clientEmail = uniqueEmail('revoked-bystander-client')
    const handover = await createControlAdminInvitation(clientEmail, inviter.id, {
      replaceInviter: true,
    })
    if ('error' in handover) throw new Error(handover.error)
    const clientDesktopInvitationId = await inviteDesktopAccess(clientEmail)

    const completed = await completeControlAdminInvitation({
      email: clientEmail,
      invitationId: handover.id,
      username: `revoked-bystander-${randomUUID().slice(0, 8)}`,
      passwordHash: 'real-pg-replace-client',
    })
    if ('error' in completed) throw new Error(completed.error)
    const accepted = await acceptInvitationById(clientEmail, clientDesktopInvitationId)
    if ('error' in accepted) throw new Error(String(accepted.error))

    expect(await desktopLifecycle(linkedDesktopId)).toBe('retired')
    expect(await teamRole(team, accepted.data.userId)).toBe('admin')
    expect(await desktopLifecycle(bystanderId)).toBe('active')
    expect(await teamRole(bystanderTeam, bystanderId)).toBe('member')
    expect(await teamRole(bystanderTeam, accepted.data.userId)).toBeUndefined()
  })

  it('does not retire another admin desktop user that only shares the inviter email', async () => {
    const adminA = await seedAdmin('owner-ops')
    const sharedEmail = adminA.email
    const desktopX = await seedDesktopUser(sharedEmail)
    await seedOperatorLink(desktopX, adminA.id)
    const team = await seedTeam('Owner')
    await addTeamMember(team, desktopX, 'admin')
    await testPool.query(`UPDATE control_admin_users SET email = $2 WHERE id = $1::uuid`, [
      adminA.id,
      uniqueEmail('owner-moved'),
    ])
    const adminB = await seedAdmin('borrowed-ops')
    await testPool.query(`UPDATE control_admin_users SET email = $2 WHERE id = $1::uuid`, [
      adminB.id,
      sharedEmail,
    ])
    const clientEmail = uniqueEmail('borrowed-client')
    const handover = await createControlAdminInvitation(clientEmail, adminB.id, {
      replaceInviter: true,
    })
    if ('error' in handover) throw new Error(handover.error)
    const clientDesktopInvitationId = await inviteDesktopAccess(clientEmail)

    const completed = await completeControlAdminInvitation({
      email: clientEmail,
      invitationId: handover.id,
      username: `borrowed-${randomUUID().slice(0, 8)}`,
      passwordHash: 'real-pg-replace-client',
    })
    if ('error' in completed) throw new Error(completed.error)
    const accepted = await acceptInvitationById(clientEmail, clientDesktopInvitationId)
    if ('error' in accepted) throw new Error(String(accepted.error))

    expect(await adminStatus(adminB.id)).toBe('disabled')
    expect(await adminStatus(adminA.id)).toBe('active')
    expect(await desktopLifecycle(desktopX)).toBe('active')
    expect(await teamRole(team, desktopX)).toBe('admin')
    expect(await teamRole(team, accepted.data.userId)).toBeUndefined()
    const link = await testPool.query(
      `SELECT state FROM gfs_desktop_operator_links WHERE control_admin_id = $1::uuid`,
      [adminA.id]
    )
    expect(link.rows).toEqual([{ state: 'active' }])
  })

  it('does not fall back to email when link history names a retired desktop user', async () => {
    const inviter = await seedAdmin('history-retired-ops')
    const linkedDesktopId = await seedDesktopUser(inviter.email)
    await seedOperatorLink(linkedDesktopId, inviter.id)
    const team = await seedTeam('History retired')
    await addTeamMember(team, linkedDesktopId, 'admin')
    await revokeOperatorLink(inviter.id)
    const retirer = await seedAdmin('history-retired-actor')
    await retireDesktopUser(
      { kind: 'control_admin', controlAdminId: retirer.id },
      linkedDesktopId,
      'linked user already retired',
      `history-retired-${linkedDesktopId}`,
      null
    )
    const movedEmail = uniqueEmail('history-retired-moved')
    await testPool.query(`UPDATE control_admin_users SET email = $2 WHERE id = $1::uuid`, [
      inviter.id,
      movedEmail,
    ])
    const bystanderId = await seedDesktopUser(movedEmail)
    const bystanderTeam = await seedTeam('History bystander')
    await addTeamMember(bystanderTeam, bystanderId, 'member')
    const clientEmail = uniqueEmail('history-retired-client')
    const handover = await createControlAdminInvitation(clientEmail, inviter.id, {
      replaceInviter: true,
    })
    if ('error' in handover) throw new Error(handover.error)
    const clientDesktopInvitationId = await inviteDesktopAccess(clientEmail)

    const completed = await completeControlAdminInvitation({
      email: clientEmail,
      invitationId: handover.id,
      username: `history-retired-${randomUUID().slice(0, 8)}`,
      passwordHash: 'real-pg-replace-client',
    })
    if ('error' in completed) throw new Error(completed.error)
    const accepted = await acceptInvitationById(clientEmail, clientDesktopInvitationId)
    if ('error' in accepted) throw new Error(String(accepted.error))

    expect(await adminStatus(inviter.id)).toBe('disabled')
    expect(await desktopLifecycle(bystanderId)).toBe('active')
    expect(await teamRole(bystanderTeam, accepted.data.userId)).toBeUndefined()
    expect(await teamRole(team, accepted.data.userId)).toBeUndefined()
    const retirement = await testPool.query(
      `SELECT retirement_reason FROM users WHERE id = $1::uuid`,
      [linkedDesktopId]
    )
    expect(retirement.rows).toEqual([{ retirement_reason: 'linked user already retired' }])
  })

  it('rejects a direct acceptance of a replaceInviter invitation that skips the hand-over', async () => {
    const inviter = await seedAdmin('n1-ops')
    const email = uniqueEmail('n1-client')
    const invitation = await createControlAdminInvitation(email, inviter.id, {
      replaceInviter: true,
    })
    if ('error' in invitation) throw new Error(invitation.error)

    await expect(
      testPool.query(
        `UPDATE control_admin_invitations
            SET status = 'accepted', accepted_at = NOW()
          WHERE id = $1::uuid`,
        [invitation.id]
      )
    ).rejects.toThrow(/replace_inviter_requires_current_control_api/)

    expect(await adminInvitationStatus(invitation.id)).toBe('pending')
    expect(await adminStatus(inviter.id)).toBe('active')
  })

  it('logs a skip when the inviter is already inactive and still completes', async () => {
    const inviter = await seedAdmin('skip-log-ops')
    const inviterDesktopId = await seedDesktopUser(inviter.email)
    const email = uniqueEmail('skip-log-client')
    const invitation = await createControlAdminInvitation(email, inviter.id, {
      replaceInviter: true,
    })
    if ('error' in invitation) throw new Error(invitation.error)
    await testPool.query(`UPDATE control_admin_users SET status = 'disabled' WHERE id = $1::uuid`, [
      inviter.id,
    ])
    const warn = vi.spyOn(rootLogger, 'warn').mockImplementation(() => undefined as never)

    const completed = await completeControlAdminInvitation({
      email,
      invitationId: invitation.id,
      username: `skip-log-${randomUUID().slice(0, 8)}`,
      passwordHash: 'real-pg-replace-client',
    })

    expect(completed).toMatchObject({ email, status: 'active' })
    expect(await desktopLifecycle(inviterDesktopId)).toBe('active')
    expect(await adminInvitationStatus(invitation.id)).toBe('accepted')
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'control_admin_replace_inviter_skipped',
        invitationId: invitation.id,
        inviterAdminId: inviter.id,
      }),
      expect.any(String)
    )
    const payload = warn.mock.calls.find(
      call =>
        call[0] &&
        typeof call[0] === 'object' &&
        (call[0] as { event?: string }).event === 'control_admin_replace_inviter_skipped'
    )?.[0] as Record<string, unknown>
    expect(payload).not.toHaveProperty('email')
    expect(JSON.stringify(payload)).not.toContain(email)
    expect(JSON.stringify(payload)).not.toContain(inviter.email)
    warn.mockRestore()
  })

  it('revokes an opened invitation the inviter still has in progress', async () => {
    const inviter = await seedAdmin('opened-revoke-ops')
    const clientEmail = uniqueEmail('opened-revoke-client')
    const handover = await createControlAdminInvitation(clientEmail, inviter.id, {
      replaceInviter: true,
    })
    if ('error' in handover) throw new Error(handover.error)
    await inviteDesktopAccess(clientEmail)
    const openedEmail = uniqueEmail('opened-revoke-other')
    const opened = await createControlAdminInvitation(openedEmail, inviter.id)
    if ('error' in opened) throw new Error(opened.error)
    const openedDesktopId = await inviteDesktopAccess(openedEmail)
    await markControlAdminInvitationOpened(opened.id)
    expect(await adminInvitationStatus(opened.id)).toBe('opened')

    const completed = await completeControlAdminInvitation({
      email: clientEmail,
      invitationId: handover.id,
      username: `opened-revoke-${randomUUID().slice(0, 8)}`,
      passwordHash: 'real-pg-replace-client',
    })
    if ('error' in completed) throw new Error(completed.error)

    expect(await adminInvitationStatus(opened.id)).toBe('revoked')
    expect(await desktopInvitationStatus(openedDesktopId)).toBe('revoked')
  })

  it('completes a hand-over when the inviter has no team roles and no receiver', async () => {
    const inviter = await seedAdmin('norole-ops')
    const inviterDesktopId = await seedDesktopUser(inviter.email)
    const clientEmail = uniqueEmail('norole-client')
    const handover = await createControlAdminInvitation(clientEmail, inviter.id, {
      replaceInviter: true,
    })
    if ('error' in handover) throw new Error(handover.error)

    const completed = await completeControlAdminInvitation({
      email: clientEmail,
      invitationId: handover.id,
      username: `norole-${randomUUID().slice(0, 8)}`,
      passwordHash: 'real-pg-replace-client',
    })

    expect(completed).toMatchObject({ email: clientEmail, status: 'active' })
    expect(await adminStatus(inviter.id)).toBe('disabled')
    expect(await desktopLifecycle(inviterDesktopId)).toBe('retired')
    expect(await adminInvitationStatus(handover.id)).toBe('accepted')
  })

  it('does not treat an expired desktop invitation as a receiver', async () => {
    const inviter = await seedAdmin('expired-receiver-ops')
    const inviterDesktopId = await seedDesktopUser(inviter.email)
    const team = await seedTeam('Expired receiver')
    await addTeamMember(team, inviterDesktopId, 'admin')
    const clientEmail = uniqueEmail('expired-receiver')
    const handover = await createControlAdminInvitation(clientEmail, inviter.id, {
      replaceInviter: true,
    })
    if ('error' in handover) throw new Error(handover.error)
    const desktopInvitationId = await inviteDesktopAccess(clientEmail)
    await testPool.query(
      `UPDATE invitations SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1::uuid`,
      [desktopInvitationId]
    )

    await expect(
      completeControlAdminInvitation({
        email: clientEmail,
        invitationId: handover.id,
        username: `expired-receiver-${randomUUID().slice(0, 8)}`,
        passwordHash: 'real-pg-replace-client',
      })
    ).resolves.toEqual({ error: 'replace_inviter_receiver_missing' })

    expect(await adminInvitationStatus(handover.id)).toBe('pending')
    expect(await adminStatus(inviter.id)).toBe('active')
    expect(await desktopLifecycle(inviterDesktopId)).toBe('active')
    expect(await teamRole(team, inviterDesktopId)).toBe('admin')
  })

  it('keeps replaceInviter on an opened invitation listed as pending password', async () => {
    const inviter = await seedAdmin('opened-list-ops')
    const email = uniqueEmail('opened-list-client')
    const invitation = await createControlAdminInvitation(email, inviter.id, {
      replaceInviter: true,
    })
    if ('error' in invitation) throw new Error(invitation.error)
    await markControlAdminInvitationOpened(invitation.id)

    const listed = await listControlAdmins()
    expect(listed.invitations.find(item => item.id === invitation.id)).toBeUndefined()
    expect(listed.admins.find(item => item.invitationId === invitation.id)).toMatchObject({
      status: 'pending_password',
      replaceInviter: true,
      invitedByAdminId: inviter.id,
    })
  })

  it('refuses a new invitation once the inviter is no longer active', async () => {
    const inviter = await seedAdmin('inactive-create-ops')
    await testPool.query(`UPDATE control_admin_users SET status = 'disabled' WHERE id = $1::uuid`, [
      inviter.id,
    ])
    const email = uniqueEmail('inactive-create')

    await expect(
      createControlAdminInvitation(email, inviter.id, { replaceInviter: true })
    ).resolves.toEqual({ error: 'inviter_not_active' })
    const rows = await testPool.query(
      `SELECT 1 FROM control_admin_invitations WHERE lower(email) = lower($1)`,
      [email]
    )
    expect(rows.rowCount).toBe(0)
  })

  it('does not insert an invitation that was waiting on the inviter row lock', async () => {
    const inviter = await seedAdmin('create-lock-ops')
    const email = uniqueEmail('create-lock')
    const blocker = await testPool.connect()
    try {
      await blocker.query('BEGIN')
      await blocker.query(`SELECT 1 FROM control_admin_users WHERE id = $1::uuid FOR UPDATE`, [
        inviter.id,
      ])
      const creating = createControlAdminInvitation(email, inviter.id, { replaceInviter: true })
      creating.catch(() => undefined)
      for (let attempt = 0; ; attempt += 1) {
        const waiting = await adminPool.query(
          `SELECT 1 FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock'`,
          [database]
        )
        if ((waiting.rowCount ?? 0) > 0) break
        if (attempt >= 100) throw new Error('invitation insert never waited on the inviter lock')
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      await blocker.query(
        `UPDATE control_admin_users SET status = 'disabled' WHERE id = $1::uuid`,
        [inviter.id]
      )
      await blocker.query('COMMIT')
      await expect(creating).resolves.toEqual({ error: 'inviter_not_active' })
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined)
      blocker.release()
    }

    const rows = await testPool.query(
      `SELECT 1 FROM control_admin_invitations WHERE lower(email) = lower($1)`,
      [email]
    )
    expect(rows.rowCount).toBe(0)
  }, 15_000)
})
