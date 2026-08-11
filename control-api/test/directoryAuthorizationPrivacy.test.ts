import { beforeEach, describe, expect, it, vi } from 'vitest'
import bcrypt from 'bcryptjs'
import {
  DirectorySearchCursorError,
  acceptInvitationForEmail,
  createManagedInvitationForUser,
  deleteManagedMemberForUser,
  listManagedMembersForUser,
  listManagedPendingInvitationsForUser,
  resendManagedInvitationForUser,
  revokeManagedInvitationForUser,
  searchDirectory,
  setInvitationPasswordForEmail,
  setInvitationPasswordForUser,
  updateManagedMemberRoleForUser,
  updateUserPassword,
} from '../src/services/directory/membership.js'

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
  appendEvents: vi.fn().mockResolvedValue(undefined),
  registerInvitation: vi.fn(),
}))

vi.mock('../src/db.js', () => ({
  pool: { query: mocks.query },
  withTransaction: mocks.withTransaction,
}))
vi.mock('../src/services/tracing/controlApiPermissionEvents.js', () => ({
  appendControlApiPermissionEventsInTransaction: mocks.appendEvents,
}))
vi.mock('../src/services/invitationFlowRegistrationService.js', () => ({
  registerAndSendInvitation: mocks.registerInvitation,
}))

const MANAGER = '00000000-0000-4000-8000-000000000001'
const TARGET = '00000000-0000-4000-8000-000000000002'
const TEAM_A = '00000000-0000-4000-8000-000000000010'
const TEAM_SECRET = '00000000-0000-4000-8000-000000000099'

describe('directory privacy and atomic authorization', () => {
  beforeEach(() => {
    mocks.query.mockReset()
    mocks.withTransaction.mockReset()
    mocks.appendEvents.mockClear()
    mocks.registerInvitation.mockReset()
    mocks.registerInvitation.mockResolvedValue(undefined)
    mocks.withTransaction.mockImplementation(async work => work({ query: mocks.query }))
  })

  it('projects managed members only through teams the caller currently manages', async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          id: TARGET,
          email: 'target@example.com',
          name: 'Target',
          picture: null,
          display_name: 'Target',
          teams: [{ id: TEAM_A, name: 'Team A', role: 'member', managerRole: 'admin' }],
        },
      ],
      rowCount: 1,
    })

    const result = await listManagedMembersForUser(MANAGER, TARGET)

    expect(result[0]?.teams).toEqual([
      expect.objectContaining({ id: TEAM_A, name: 'Team A', role: 'member' }),
    ])
    const sql = String(mocks.query.mock.calls[0]?.[0])
    expect(sql).toContain('JOIN managed_teams mt ON mt.team_id = target_tm.team_id')
    expect(sql).not.toContain('LEFT JOIN managed_teams mt ON mt.team_id = target_tm.team_id')
    expect(JSON.stringify(result)).not.toContain(TEAM_SECRET)
  })

  it('projects invitation assignments only through the manager scope and omits secrets', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT DISTINCT i.id')) {
        return {
          rows: [
            {
              id: '00000000-0000-4000-8000-000000000200',
              team_id: TEAM_SECRET,
              invitee_name: 'Invitee',
              email: 'invitee@example.com',
              role: 'admin',
              token: 'must-never-serialize',
              status: 'pending',
              purpose: 'member_invitation',
              created_at: new Date('2026-08-10T12:00:00Z'),
              expires_at: new Date('2026-08-11T12:00:00Z'),
              accepted_at: null,
              accepted_user_id: null,
              assignment_count: 2,
              team_name: 'Secret Team',
            },
          ],
          rowCount: 1,
        }
      }
      if (sql.includes('FROM invitation_teams it')) {
        expect(sql).toContain('manager.user_id::text = $2')
        return {
          rows: [
            {
              invitation_id: '00000000-0000-4000-8000-000000000200',
              team_id: TEAM_A,
              team_name: 'Team A',
              role: 'member',
            },
          ],
          rowCount: 1,
        }
      }
      if (sql.includes('SELECT team_id, role')) {
        return { rows: [{ team_id: TEAM_A, role: 'admin' }], rowCount: 1 }
      }
      throw new Error(`unexpected query: ${sql.slice(0, 40)}`)
    })

    const result = await listManagedPendingInvitationsForUser(MANAGER)

    expect(result[0]?.teams).toEqual([{ id: TEAM_A, name: 'Team A', role: 'member' }])
    expect(JSON.stringify(result)).not.toContain(TEAM_SECRET)
    expect(JSON.stringify(result)).not.toContain('Secret Team')
    expect(result[0]).not.toHaveProperty('team_id')
    expect(result[0]).not.toHaveProperty('team_name')
    expect(result[0]).not.toHaveProperty('role')
    expect(JSON.stringify(result)).not.toContain('must-never-serialize')
    expect(result[0]).toMatchObject({ canCancel: false, canResend: false })
  })

  it('locks manager and target authority in the same transaction as a role mutation', async () => {
    mocks.query
      .mockResolvedValueOnce({
        rows: [
          { user_id: MANAGER, role: 'admin' },
          { user_id: TARGET, role: 'member' },
        ],
        rowCount: 2,
      })
      .mockResolvedValueOnce({
        rows: [{ team_id: TEAM_A, user_id: TARGET, role: 'inviter', status: 'active' }],
        rowCount: 1,
      })

    const result = await updateManagedMemberRoleForUser(MANAGER, TARGET, TEAM_A, 'inviter')

    expect(result).toEqual({
      membership: { team_id: TEAM_A, user_id: TARGET, role: 'inviter', status: 'active' },
    })
    expect(mocks.withTransaction).toHaveBeenCalledTimes(1)
    expect(String(mocks.query.mock.calls[0]?.[0])).toContain('FOR UPDATE')
    expect(String(mocks.query.mock.calls[0]?.[0])).toContain('user_id = ANY($2::uuid[])')
    expect(String(mocks.query.mock.calls[1]?.[0])).toContain('UPDATE team_members')
    expect(mocks.appendEvents).toHaveBeenCalledTimes(1)
  })

  it('locks invitation authority and denies inviter-to-admin assignment before mutation', async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [{ team_id: TEAM_A, role: 'inviter' }],
      rowCount: 1,
    })

    await expect(
      createManagedInvitationForUser(
        MANAGER,
        'invitee@example.com',
        [{ teamId: TEAM_A, role: 'admin' }],
        'Invitee'
      )
    ).resolves.toEqual({ error: 'forbidden' })

    expect(mocks.withTransaction).toHaveBeenCalledTimes(1)
    expect(String(mocks.query.mock.calls[0]?.[0])).toContain('FOR UPDATE')
    expect(mocks.query).toHaveBeenCalledTimes(1)
    expect(mocks.registerInvitation).not.toHaveBeenCalled()
  })

  it('omits the invitation capability from managed creation results', async () => {
    let transactionDepth = 0
    mocks.withTransaction.mockImplementation(async work => {
      transactionDepth += 1
      try {
        return await work({ query: mocks.query })
      } finally {
        transactionDepth -= 1
      }
    })
    mocks.registerInvitation.mockImplementation(async () => {
      expect(transactionDepth).toBe(0)
    })
    const invitation = {
      id: '00000000-0000-4000-8000-000000000200',
      team_id: TEAM_A,
      invitee_name: 'Invitee',
      email: 'invitee@example.com',
      role: 'member',
      token: 'must-never-leave-control-api',
      status: 'draft',
      purpose: 'member_invitation',
      created_at: new Date('2026-08-10T12:00:00Z'),
      expires_at: new Date('2026-08-11T12:00:00Z'),
      accepted_at: null,
      accepted_user_id: null,
      team_name: 'Team A',
    }
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("WHERE status = 'draft'")) return { rows: [], rowCount: 0 }
      if (sql.includes('FROM team_members') && sql.includes('FOR UPDATE')) {
        return { rows: [{ team_id: TEAM_A, role: 'admin' }], rowCount: 1 }
      }
      if (sql.includes('UPDATE users') && sql.includes('SET name')) {
        return { rows: [{ id: TARGET }], rowCount: 1 }
      }
      if (sql.includes('INSERT INTO profiles')) return { rows: [], rowCount: 1 }
      if (sql.includes('WITH inserted AS')) return { rows: [invitation], rowCount: 1 }
      if (sql.includes('INSERT INTO invitation_teams')) return { rows: [], rowCount: 1 }
      if (sql.includes('INSERT INTO invitation_delivery_commands')) {
        return { rows: [{ id: '00000000-0000-4000-8000-000000000300' }], rowCount: 1 }
      }
      if (sql.includes('FROM invitation_delivery_commands c')) {
        return { rows: [invitation], rowCount: 1 }
      }
      if (sql.includes('UPDATE invitation_delivery_commands')) return { rows: [], rowCount: 1 }
      if (sql.includes('FROM invitation_teams it') && sql.includes('JOIN teams')) {
        return {
          rows: [{ team_id: TEAM_A, team_name: 'Team A', role: 'member' }],
          rowCount: 1,
        }
      }
      if (sql.includes("SET status = 'pending'")) {
        return { rows: [{ ...invitation, status: 'pending' }], rowCount: 1 }
      }
      throw new Error(`unexpected query: ${sql.slice(0, 40)}`)
    })

    const result = await createManagedInvitationForUser(
      MANAGER,
      invitation.email,
      [{ teamId: TEAM_A, role: 'member' }],
      'Untrusted inviter label'
    )

    expect(result).toMatchObject({ invitation: { id: invitation.id, status: 'pending' } })
    expect(JSON.stringify(result)).not.toContain(invitation.token)
    expect((result as { invitation: Record<string, unknown> }).invitation).not.toHaveProperty(
      'token'
    )
    const sql = mocks.query.mock.calls.map(call => String(call[0])).join('\n')
    expect(sql).not.toContain('UPDATE users')
    expect(sql).not.toContain('INSERT INTO profiles')
  })

  it('leaves a delivered draft unusable when manager authority changes before activation', async () => {
    const invitation = {
      id: '00000000-0000-4000-8000-000000000200',
      team_id: TEAM_A,
      invitee_name: 'Invitee',
      email: 'invitee@example.com',
      role: 'member',
      token: 'inert-until-activation',
      status: 'draft',
      purpose: 'member_invitation',
      created_at: new Date('2026-08-10T12:00:00Z'),
      expires_at: new Date('2026-08-11T12:00:00Z'),
      accepted_at: null,
      accepted_user_id: null,
      team_name: 'Team A',
    }
    let transactionDepth = 0
    let managerChecks = 0
    mocks.withTransaction.mockImplementation(async work => {
      transactionDepth += 1
      try {
        return await work({ query: mocks.query })
      } finally {
        transactionDepth -= 1
      }
    })
    mocks.registerInvitation.mockImplementation(async () => {
      expect(transactionDepth).toBe(0)
    })
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("WHERE status = 'draft'")) return { rows: [], rowCount: 0 }
      if (sql.includes('FROM team_members') && sql.includes('FOR UPDATE')) {
        managerChecks += 1
        return managerChecks === 1
          ? { rows: [{ team_id: TEAM_A, role: 'admin' }], rowCount: 1 }
          : { rows: [], rowCount: 0 }
      }
      if (sql.includes('WITH inserted AS')) return { rows: [invitation], rowCount: 1 }
      if (sql.includes('INSERT INTO invitation_teams')) return { rows: [], rowCount: 1 }
      if (sql.includes('INSERT INTO invitation_delivery_commands')) {
        return { rows: [{ id: '00000000-0000-4000-8000-000000000300' }], rowCount: 1 }
      }
      if (sql.includes('FROM invitation_delivery_commands c')) {
        return { rows: [invitation], rowCount: 1 }
      }
      if (sql.includes('FROM invitation_teams it') && sql.includes('JOIN teams')) {
        return {
          rows: [{ team_id: TEAM_A, team_name: 'Team A', role: 'member' }],
          rowCount: 1,
        }
      }
      if (sql.includes('UPDATE invitation_delivery_commands')) return { rows: [], rowCount: 1 }
      if (sql.includes("SET status = 'revoked'")) return { rows: [], rowCount: 1 }
      throw new Error(`unexpected query: ${sql.slice(0, 40)}`)
    })

    await expect(
      createManagedInvitationForUser(
        MANAGER,
        invitation.email,
        [{ teamId: TEAM_A, role: 'member' }],
        ''
      )
    ).resolves.toEqual({ error: 'forbidden' })

    const sql = mocks.query.mock.calls.map(call => String(call[0])).join('\n')
    expect(managerChecks).toBe(2)
    expect(sql).toContain("SET status = 'revoked'")
    expect(sql).not.toContain("SET status = 'pending'")
  })

  it('does not apply inviter-controlled names to an existing user during acceptance', async () => {
    const invitation = {
      id: '00000000-0000-4000-8000-000000000200',
      team_id: TEAM_A,
      invitee_name: 'Untrusted inviter label',
      email: 'target@example.com',
      role: 'member',
      token: 'invitation-token',
      status: 'pending',
      purpose: 'member_invitation',
      created_at: new Date('2026-08-10T12:00:00Z'),
      expires_at: new Date('2026-08-11T12:00:00Z'),
      accepted_at: null,
      accepted_user_id: null,
      team_name: 'Team A',
    }
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("WHERE ($1 <> '' AND i.token = $1)")) {
        return { rows: [invitation], rowCount: 1 }
      }
      if (sql.includes('FROM users') && sql.includes('WHERE email = $1')) {
        return {
          rows: [
            {
              id: TARGET,
              email: invitation.email,
              name: 'Original user name',
              picture: null,
              password_hash: null,
            },
          ],
          rowCount: 1,
        }
      }
      if (sql.includes('UPDATE users') && sql.includes('SET name')) {
        return {
          rows: [
            {
              id: TARGET,
              email: invitation.email,
              name: invitation.invitee_name,
              picture: null,
              password_hash: null,
            },
          ],
          rowCount: 1,
        }
      }
      if (sql.includes('INSERT INTO profiles') || sql.includes('UPDATE profiles')) {
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes('FROM invitation_teams it') && sql.includes('JOIN teams')) {
        return {
          rows: [{ team_id: TEAM_A, team_name: 'Team A', role: 'member' }],
          rowCount: 1,
        }
      }
      if (sql.includes('INSERT INTO team_members')) return { rows: [], rowCount: 1 }
      if (sql.includes("SET status = 'accepted'")) return { rows: [], rowCount: 1 }
      if (sql.includes('WHERE i.token = $1')) {
        return {
          rows: [{ ...invitation, status: 'accepted', accepted_user_id: TARGET }],
          rowCount: 1,
        }
      }
      throw new Error(`unexpected query: ${sql.slice(0, 40)}`)
    })

    const result = await acceptInvitationForEmail(invitation.email, invitation.token)

    expect(result).toMatchObject({ data: { accepted: true, userId: TARGET } })
    const sql = mocks.query.mock.calls.map(call => String(call[0])).join('\n')
    expect(sql).toContain('FOR UPDATE OF i')
    expect(sql).toContain("AND status = 'pending'")
    expect(sql).not.toContain('UPDATE users')
    expect(sql).not.toContain('UPDATE profiles')
  })

  it('allows exactly one general invitation acceptance and rejects password-reset use', async () => {
    const invitation = {
      id: '00000000-0000-4000-8000-000000000200',
      team_id: TEAM_A,
      invitee_name: 'Target',
      email: 'target@example.com',
      role: 'member',
      token: 'single-use-token',
      status: 'pending',
      purpose: 'member_invitation',
      created_at: new Date('2026-08-10T12:00:00Z'),
      expires_at: new Date('2026-08-11T12:00:00Z'),
      accepted_at: null,
      accepted_user_id: null,
      team_name: 'Team A',
    }
    let status = invitation.status
    let membershipWrites = 0
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("WHERE ($1 <> '' AND i.token = $1)")) {
        return { rows: [{ ...invitation, status }], rowCount: 1 }
      }
      if (sql.includes('FROM users') && sql.includes('WHERE email = $1')) {
        return {
          rows: [
            {
              id: TARGET,
              email: invitation.email,
              name: 'Target',
              picture: null,
              password_hash: null,
            },
          ],
          rowCount: 1,
        }
      }
      if (sql.includes('INSERT INTO profiles')) return { rows: [], rowCount: 0 }
      if (sql.includes("SET status = 'accepted'")) {
        if (status !== 'pending') return { rows: [], rowCount: 0 }
        status = 'accepted'
        return { rows: [{ id: invitation.id }], rowCount: 1 }
      }
      if (sql.includes('FROM invitation_teams it') && sql.includes('JOIN teams')) {
        return {
          rows: [{ team_id: TEAM_A, team_name: 'Team A', role: 'member' }],
          rowCount: 1,
        }
      }
      if (sql.includes('INSERT INTO team_members')) {
        membershipWrites += 1
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes('WHERE i.token = $1')) {
        return {
          rows: [{ ...invitation, status, accepted_user_id: TARGET }],
          rowCount: 1,
        }
      }
      throw new Error(`unexpected query: ${sql.slice(0, 40)}`)
    })

    await expect(
      acceptInvitationForEmail(invitation.email, invitation.token)
    ).resolves.toMatchObject({ data: { accepted: true, userId: TARGET } })
    await expect(acceptInvitationForEmail(invitation.email, invitation.token)).resolves.toEqual({
      error: 'not_pending',
    })
    expect(membershipWrites).toBe(1)

    status = 'pending'
    const passwordReset = { ...invitation, purpose: 'password_reset' }
    mocks.query.mockImplementationOnce(async () => ({ rows: [passwordReset], rowCount: 1 }))
    await expect(acceptInvitationForEmail(invitation.email, invitation.token)).resolves.toEqual({
      error: 'not_pending',
    })
  })

  it('serializes invitation acceptance behind a concurrent manager revocation', async () => {
    const invitation = {
      id: '00000000-0000-4000-8000-000000000200',
      team_id: TEAM_A,
      invitee_name: 'Invitee',
      email: 'invitee@example.com',
      role: 'member',
      token: 'invitation-token',
      status: 'pending',
      purpose: 'member_invitation',
      created_at: new Date('2026-08-10T12:00:00Z'),
      expires_at: new Date('2026-08-11T12:00:00Z'),
      accepted_at: null,
      accepted_user_id: null,
      team_name: 'Team A',
    }
    let status = invitation.status
    let rowOwner: symbol | null = null
    const rowWaiters: Array<() => void> = []
    let releaseManagerCheck!: () => void
    const managerCheckMayFinish = new Promise<void>(resolve => {
      releaseManagerCheck = resolve
    })
    let managerCheckStarted!: () => void
    const managerCheckIsRunning = new Promise<void>(resolve => {
      managerCheckStarted = resolve
    })
    let membershipWrites = 0

    mocks.withTransaction.mockImplementation(async work => {
      const transaction = Symbol('invitation-transaction')
      const acquireRow = async () => {
        if (rowOwner === transaction) return
        while (rowOwner) await new Promise<void>(resolve => rowWaiters.push(resolve))
        rowOwner = transaction
      }
      const releaseRow = () => {
        if (rowOwner !== transaction) return
        rowOwner = null
        rowWaiters.shift()?.()
      }
      const query = vi.fn(async (sql: string) => {
        if (sql.includes('FROM invitations i')) {
          if (sql.includes('FOR UPDATE OF i')) await acquireRow()
          if (sql.includes("i.status = 'pending'") && status !== 'pending') {
            return { rows: [], rowCount: 0 }
          }
          return { rows: [{ ...invitation, status }], rowCount: 1 }
        }
        if (sql.includes('FROM invitation_teams it') && sql.includes('JOIN teams')) {
          return {
            rows: [{ team_id: TEAM_A, team_name: 'Team A', role: 'member' }],
            rowCount: 1,
          }
        }
        if (sql.includes('FROM team_members') && sql.includes('FOR UPDATE')) {
          managerCheckStarted()
          await managerCheckMayFinish
          return { rows: [{ team_id: TEAM_A, role: 'admin' }], rowCount: 1 }
        }
        if (sql.includes("SET status = 'revoked'")) {
          if (status !== 'pending') return { rows: [], rowCount: 0 }
          status = 'revoked'
          return { rows: [], rowCount: 1 }
        }
        if (sql.includes("SET status = 'accepted'")) {
          if (status !== 'pending') return { rows: [], rowCount: 0 }
          status = 'accepted'
          return { rows: [{ id: invitation.id }], rowCount: 1 }
        }
        if (sql.includes('INSERT INTO team_members')) {
          membershipWrites += 1
          return { rows: [], rowCount: 1 }
        }
        throw new Error(`unexpected query: ${sql.slice(0, 40)}`)
      })
      try {
        return await work({ query })
      } finally {
        releaseRow()
      }
    })

    const revoke = revokeManagedInvitationForUser(MANAGER, invitation.id)
    await managerCheckIsRunning
    const accept = acceptInvitationForEmail(invitation.email, invitation.token)
    await Promise.resolve()
    releaseManagerCheck()

    await expect(revoke).resolves.toMatchObject({ revoked: true })
    await expect(accept).resolves.toEqual({ error: 'not_pending' })
    expect(status).toBe('revoked')
    expect(membershipWrites).toBe(0)
  })

  it('locks and conditionally consumes password-reset invitations before password writes', async () => {
    const invitation = {
      id: '00000000-0000-4000-8000-000000000200',
      team_id: null,
      invitee_name: 'Target',
      email: 'target@example.com',
      role: 'member',
      token: 'password-reset-token',
      status: 'pending',
      purpose: 'password_reset',
      created_at: new Date('2026-08-10T12:00:00Z'),
      expires_at: new Date('2026-08-11T12:00:00Z'),
      accepted_at: null,
      accepted_user_id: null,
      team_name: null,
    }

    for (const operation of [
      () => setInvitationPasswordForUser(TARGET, invitation.email, invitation.id, 'valid-password'),
      () =>
        setInvitationPasswordForEmail(
          invitation.email,
          invitation.token,
          invitation.id,
          'valid-password'
        ),
    ]) {
      mocks.query.mockReset()
      mocks.query.mockImplementation(async (sql: string) => {
        if (
          sql.includes('FROM invitations i') &&
          (sql.includes('WHERE i.id::text = $1') || sql.includes('WHERE i.token = $1'))
        ) {
          return { rows: [invitation], rowCount: 1 }
        }
        if (sql.includes('FROM users') && sql.includes('WHERE email = $1')) {
          return {
            rows: [
              {
                id: TARGET,
                email: invitation.email,
                name: 'Target',
                picture: null,
                password_hash: 'old-password-hash',
              },
            ],
            rowCount: 1,
          }
        }
        if (sql.includes('INSERT INTO profiles')) return { rows: [], rowCount: 0 }
        if (sql.includes("SET status = 'accepted'")) return { rows: [], rowCount: 0 }
        throw new Error(`unexpected query: ${sql.slice(0, 40)}`)
      })

      await expect(operation()).resolves.toEqual({ error: 'not_pending' })
      const sql = mocks.query.mock.calls.map(call => String(call[0])).join('\n')
      expect(sql).toContain('FOR UPDATE OF i')
      expect(sql).toContain("AND status = 'pending'")
      expect(sql).not.toContain('SET password_hash')
    }
  })

  it('atomically accepts a pending member invitation with first password setup', async () => {
    const invitation = {
      id: '00000000-0000-4000-8000-000000000200',
      team_id: TEAM_A,
      invitee_name: 'New user',
      email: 'new-user@example.com',
      role: 'member',
      token: 'member-setup-token',
      status: 'pending',
      purpose: 'member_invitation',
      created_at: new Date(),
      expires_at: new Date(Date.now() + 60_000),
      accepted_at: null,
      accepted_user_id: null,
      team_name: 'Team A',
    }
    let status = invitation.status
    let passwordHash: string | null = null
    let membershipWrites = 0
    mocks.query.mockImplementation(async (sql: string) => {
      if (
        sql.includes('FROM invitations i') &&
        (sql.includes('WHERE i.token = $1') || sql.includes('WHERE i.id::text = $1'))
      ) {
        return {
          rows: [
            { ...invitation, status, accepted_user_id: status === 'accepted' ? TARGET : null },
          ],
          rowCount: 1,
        }
      }
      if (sql.includes('FROM users') && sql.includes('WHERE email = $1')) {
        return {
          rows: [
            {
              id: TARGET,
              email: invitation.email,
              name: 'New user',
              picture: null,
              password_hash: passwordHash,
            },
          ],
          rowCount: 1,
        }
      }
      if (sql.includes('INSERT INTO profiles')) return { rows: [], rowCount: 0 }
      if (sql.includes("SET status = 'accepted'")) {
        if (status !== 'pending') return { rows: [], rowCount: 0 }
        status = 'accepted'
        return { rows: [{ id: invitation.id }], rowCount: 1 }
      }
      if (sql.includes('FROM invitation_teams it') && sql.includes('JOIN teams')) {
        return {
          rows: [{ team_id: TEAM_A, team_name: 'Team A', role: 'member' }],
          rowCount: 1,
        }
      }
      if (sql.includes('INSERT INTO team_members')) {
        membershipWrites += 1
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes('SET password_hash = $2')) {
        passwordHash = 'stored-hash'
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes('SELECT id') && sql.includes('FROM users') && sql.includes('FOR UPDATE')) {
        return { rows: [{ id: TARGET }], rowCount: 1 }
      }
      if (sql.includes('external_user_session_security_epochs')) return { rows: [], rowCount: 1 }
      if (sql.includes('UPDATE external_user_sessions')) return { rows: [], rowCount: 0 }
      throw new Error(`unexpected query: ${sql.slice(0, 40)}`)
    })

    await expect(
      setInvitationPasswordForEmail(
        invitation.email,
        invitation.token,
        invitation.id,
        'valid-password'
      )
    ).resolves.toMatchObject({ data: { passwordUpdated: true, status: 'accepted' } })
    expect(status).toBe('accepted')
    expect(passwordHash).not.toBeNull()
    expect(membershipWrites).toBe(1)

    await expect(
      setInvitationPasswordForEmail(
        invitation.email,
        invitation.token,
        invitation.id,
        'another-password'
      )
    ).resolves.toEqual({ error: 'not_pending' })
    expect(membershipWrites).toBe(1)
  })

  it('rejects token-authenticated password setup after invitation acceptance', async () => {
    const invitation = {
      id: '00000000-0000-4000-8000-000000000200',
      team_id: TEAM_A,
      invitee_name: 'Existing user',
      email: 'existing@example.com',
      role: 'member',
      token: 'consumed-member-token',
      status: 'accepted',
      purpose: 'member_invitation',
      created_at: new Date(),
      expires_at: new Date(Date.now() + 60_000),
      accepted_at: new Date(),
      accepted_user_id: TARGET,
      team_name: 'Team A',
    }
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM invitations i') && sql.includes('WHERE i.token = $1')) {
        return { rows: [invitation], rowCount: 1 }
      }
      throw new Error(`unexpected query: ${sql.slice(0, 40)}`)
    })

    await expect(
      setInvitationPasswordForEmail(
        invitation.email,
        invitation.token,
        invitation.id,
        'attacker-password'
      )
    ).resolves.toEqual({ error: 'not_pending' })
    const sql = mocks.query.mock.calls.map(call => String(call[0])).join('\n')
    expect(sql).toContain('FOR UPDATE OF i')
    expect(sql).not.toContain('SET password_hash')
    expect(sql).not.toContain('external_user_session_security_epochs')
  })

  it('sends a managed resend from a durable command without holding authority locks', async () => {
    const invitation = {
      id: '00000000-0000-4000-8000-000000000200',
      team_id: TEAM_A,
      invitee_name: 'Invitee',
      email: 'invitee@example.com',
      role: 'member',
      token: 'invitation-token',
      status: 'pending',
      purpose: 'member_invitation',
      created_at: new Date('2026-08-10T12:00:00Z'),
      expires_at: new Date('2026-08-11T12:00:00Z'),
      accepted_at: null,
      accepted_user_id: null,
      team_name: 'Team A',
    }
    let transactionDepth = 0
    mocks.withTransaction.mockImplementation(async work => {
      transactionDepth += 1
      try {
        return await work({ query: mocks.query })
      } finally {
        transactionDepth -= 1
      }
    })
    mocks.registerInvitation.mockImplementation(async () => {
      expect(transactionDepth).toBe(0)
    })
    mocks.query
      .mockResolvedValueOnce({ rows: [invitation], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ team_id: TEAM_A, team_name: 'Team A', role: 'member' }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ team_id: TEAM_A, role: 'admin' }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ id: '00000000-0000-4000-8000-000000000300' }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })

    await expect(resendManagedInvitationForUser(MANAGER, invitation.id)).resolves.toEqual({
      resent: true,
      id: invitation.id,
      email: invitation.email,
    })
    expect(String(mocks.query.mock.calls[3]?.[0])).toContain(
      'INSERT INTO invitation_delivery_commands'
    )
    expect(String(mocks.query.mock.calls[4]?.[0])).toContain('UPDATE invitation_delivery_commands')
  })

  it.each(['resend', 'revoke'] as const)(
    'prevents %s after the locked manager authority is gone',
    async operation => {
      const invitation = {
        id: '00000000-0000-4000-8000-000000000200',
        team_id: TEAM_A,
        invitee_name: 'Invitee',
        email: 'invitee@example.com',
        role: 'member',
        token: 'secret',
        status: 'pending',
        purpose: 'member_invitation',
        created_at: new Date('2026-08-10T12:00:00Z'),
        expires_at: new Date('2026-08-11T12:00:00Z'),
        accepted_at: null,
        accepted_user_id: null,
        team_name: 'Team A',
      }
      mocks.query
        .mockResolvedValueOnce({ rows: [invitation], rowCount: 1 })
        .mockResolvedValueOnce({
          rows: [{ team_id: TEAM_A, team_name: 'Team A', role: 'member' }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })

      const result =
        operation === 'resend'
          ? await resendManagedInvitationForUser(MANAGER, invitation.id)
          : await revokeManagedInvitationForUser(MANAGER, invitation.id)

      expect(result).toEqual({ error: 'forbidden' })
      expect(String(mocks.query.mock.calls[0]?.[0])).toContain('FOR UPDATE OF i')
      expect(String(mocks.query.mock.calls[2]?.[0])).toContain('FOR UPDATE')
      expect(mocks.query).toHaveBeenCalledTimes(3)
      expect(mocks.registerInvitation).not.toHaveBeenCalled()
    }
  )

  it('does not mutate when the locked manager membership is already revoked', async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [{ user_id: TARGET, role: 'member' }],
      rowCount: 1,
    })

    await expect(deleteManagedMemberForUser(MANAGER, TARGET, TEAM_A)).resolves.toEqual({
      error: 'forbidden',
    })
    expect(mocks.query).toHaveBeenCalledTimes(1)
    expect(mocks.appendEvents).not.toHaveBeenCalled()
  })

  it('changes a password and revokes every session in one conditional transaction', async () => {
    const currentHash = await bcrypt.hash('current-password', 4)
    mocks.query
      .mockResolvedValueOnce({ rows: [{ password_hash: currentHash }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: MANAGER }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: MANAGER }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 2 })

    await expect(
      updateUserPassword(MANAGER, 'manager@example.com', 'current-password', 'next-password')
    ).resolves.toEqual({ updated: true })

    expect(mocks.withTransaction).toHaveBeenCalledTimes(1)
    const passwordUpdate = String(mocks.query.mock.calls[1]?.[0])
    expect(passwordUpdate).toContain('AND password_hash = $4')
    expect(String(mocks.query.mock.calls[2]?.[0])).toContain('FOR UPDATE')
    expect(String(mocks.query.mock.calls[3]?.[0])).toContain(
      'INSERT INTO external_user_session_security_epochs'
    )
    expect(String(mocks.query.mock.calls[4]?.[0])).toContain('UPDATE external_user_sessions')
  })

  it('treats wildcard characters literally, excludes channels, and publishes a stable cursor', async () => {
    mocks.query.mockImplementation(async (sql: string, values: unknown[]) => {
      expect(sql).toContain('ILIKE $2 ESCAPE')
      expect(sql).not.toContain('p.channels')
      expect(values[1]).toBe('%\\%\\_%')
      expect(values[4]).toBe(26)
      return {
        rows: Array.from({ length: 26 }, (_, index) => ({
          id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
          email: `person-${index}@example.com`,
          name: `Person ${index}`,
          display_name: `Person ${index}`,
          sort_key: `person ${String(index).padStart(2, '0')}`,
          channels: { emails: ['secret@example.com'] },
        })),
        rowCount: 26,
      }
    })

    const result = await searchDirectory(TEAM_A, '%_')

    expect(result.items).toHaveLength(25)
    expect(result.nextCursor).toMatch(/^ds1\./)
    expect(JSON.stringify(result)).not.toContain('channels')
    expect(JSON.stringify(result)).not.toContain('secret@example.com')
    await expect(
      searchDirectory(TEAM_A, '%_', `${result.nextCursor}tampered`)
    ).rejects.toBeInstanceOf(DirectorySearchCursorError)
  })
})
