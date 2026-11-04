import { beforeEach, describe, expect, it, vi } from 'vitest'
import bcrypt from 'bcryptjs'
import { readFileSync } from 'node:fs'
import {
  acceptInvitationById,
  acceptInvitationForEmail,
  createInvitationForTeams,
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

// The acceptance's user lock. Its text differs from the multi-line password
// setup lock, so a match cannot hit that statement.
const ACCEPTANCE_USER_LOCK =
  'SELECT id, email, name, picture, password_hash, lifecycle_state, lifecycle_version FROM users WHERE id = $1 FOR NO KEY UPDATE'
const MANAGER_USER_LOCK = 'SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE'

type AcceptanceInvitationFixture = {
  id: string
  team_id: string | null
  invitee_name: string | null
  email: string
  role: string
  token: string
  status: string
  purpose: string
  created_at: Date
  expires_at: Date
  accepted_at: Date | null
  accepted_user_id: string | null
  team_name: string | null
}

type AcceptanceUserFixture = {
  lifecycle_state: string
  lifecycle_version: number
  password_hash?: string | null
}

// A dispatcher for one acceptance: the unlocked user read of
// ensureInvitationUser and the locked user row can disagree, as when a
// lifecycle change commits while the acceptance waits on the user lock.
function acceptanceQueries(options: {
  invitation: AcceptanceInvitationFixture
  unlockedUser: AcceptanceUserFixture
  lockedUser: AcceptanceUserFixture
}) {
  const state = {
    status: options.invitation.status,
    membershipWrites: 0,
    acceptanceWrites: 0,
  }
  const userRow = (fixture: AcceptanceUserFixture) => ({
    id: TARGET,
    email: options.invitation.email,
    name: 'Target',
    picture: null,
    password_hash: fixture.password_hash ?? null,
    lifecycle_state: fixture.lifecycle_state,
    lifecycle_version: fixture.lifecycle_version,
  })
  const query = async (sql: string) => {
    if (sql.includes('FROM invitations i')) {
      return {
        rows: [
          {
            ...options.invitation,
            status: state.status,
            accepted_user_id: state.status === 'accepted' ? TARGET : null,
          },
        ],
        rowCount: 1,
      }
    }
    if (sql.includes(ACCEPTANCE_USER_LOCK)) {
      return { rows: [userRow(options.lockedUser)], rowCount: 1 }
    }
    if (sql.includes('FROM users') && sql.includes('WHERE email = $1')) {
      return { rows: [userRow(options.unlockedUser)], rowCount: 1 }
    }
    if (sql.includes('INSERT INTO profiles')) return { rows: [], rowCount: 0 }
    if (sql.includes("SET status = 'accepted'")) {
      if (state.status !== 'pending') return { rows: [], rowCount: 0 }
      state.status = 'accepted'
      state.acceptanceWrites += 1
      return { rows: [{ id: options.invitation.id }], rowCount: 1 }
    }
    if (sql.includes('FROM invitation_teams it') && sql.includes('JOIN teams')) {
      return { rows: [{ team_id: TEAM_A, team_name: 'Team A', role: 'member' }], rowCount: 1 }
    }
    if (sql.includes('INSERT INTO team_members')) {
      state.membershipWrites += 1
      return { rows: [], rowCount: 1 }
    }
    throw new Error(`unexpected query: ${sql.slice(0, 40)}`)
  }
  return { state, query }
}

// Acceptance lock order: an unlocked invitation read, then the user lock with
// the target id, then the locked invitation read, then the membership write.
function expectUsersBeforeInvitations(
  calls: ReadonlyArray<ReadonlyArray<unknown>>,
  options: { membershipWrite: boolean }
) {
  const statements = calls.map(call => String(call[0]))
  const unlockedRead = statements.findIndex(
    statement => statement.includes('FROM invitations i') && !statement.includes('FOR UPDATE')
  )
  const userLock = statements.findIndex(statement => statement.includes(ACCEPTANCE_USER_LOCK))
  const invitationLock = statements.findIndex(statement => statement.includes('FOR UPDATE OF i'))
  const membershipWrite = statements.findIndex(statement =>
    statement.includes('INSERT INTO team_members')
  )
  expect(unlockedRead).toBe(0)
  expect(userLock).toBeGreaterThan(unlockedRead)
  expect(calls[userLock]?.[1]).toEqual([TARGET])
  expect(invitationLock).toBeGreaterThan(userLock)
  if (options.membershipWrite) {
    expect(membershipWrite).toBeGreaterThan(invitationLock)
  } else {
    expect(membershipWrite).toBe(-1)
  }
}

// Managed resend and revoke: the manager's user row, then the invitation row,
// then the invitation teams, then the (no-op) manager re-lock and the
// manager's team_members rows.
function expectManagerBeforeInvitation(calls: ReadonlyArray<ReadonlyArray<unknown>>) {
  const statements = calls.map(call => String(call[0]))
  expect(statements).toHaveLength(5)
  expect(statements[0]).toContain(MANAGER_USER_LOCK)
  expect(calls[0]?.[1]).toEqual([MANAGER])
  expect(statements[1]).toContain('FOR UPDATE OF i')
  expect(statements[2]).toContain('FROM invitation_teams it')
  expect(statements[3]).toContain(MANAGER_USER_LOCK)
  expect(statements[4]).toContain('FOR UPDATE OF tm')
}

async function queryWithDatabaseClock(sql: string, values?: unknown[]) {
  if (sql.includes('clock_timestamp()')) {
    return { rows: [{ db_now: new Date('2026-09-01T12:00:00.000Z') }], rowCount: 1 }
  }
  return mocks.query(sql, values)
}

async function queryWithPasswordWorkLease(sql: string, values?: unknown[]) {
  if (sql.includes('SET LOCAL synchronous_commit = on')) {
    return { rows: [], rowCount: 0 }
  }
  if (sql.includes("set_config('app.password_admission_protocol', 'v2', true)")) {
    return { rows: [{ set_config: 'v2' }], rowCount: 1 }
  }
  if (sql.includes('INSERT INTO password_verification_work')) {
    return { rows: [{ singleton: true }], rowCount: 1 }
  }
  if (sql.includes('DELETE FROM password_verification_work')) {
    return { rows: [{ singleton: true }], rowCount: 1 }
  }
  return queryWithDatabaseClock(sql, values)
}

function activeInvitationWindow() {
  return {
    created_at: new Date(Date.now() - 60_000),
    expires_at: new Date(Date.now() + 60_000),
  }
}

describe('directory privacy and atomic authorization', () => {
  beforeEach(() => {
    mocks.query.mockReset()
    mocks.withTransaction.mockReset()
    mocks.appendEvents.mockClear()
    mocks.registerInvitation.mockReset()
    mocks.registerInvitation.mockResolvedValue(undefined)
    mocks.withTransaction.mockImplementation(async (work, _client, hooks) => {
      const result = await work({ query: queryWithPasswordWorkLease })
      const callbacks = hooks as { onCommitAcknowledged?: () => void } | undefined
      callbacks?.onCommitAcknowledged?.()
      return result
    })
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
              token: 'synthetic-must-never-serialize',
              status: 'pending',
              purpose: 'member_invitation',
              ...activeInvitationWindow(),
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
      if (sql.includes('SELECT tm.team_id, tm.role')) {
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
    expect(result[0]).not.toHaveProperty('assignment_count')
    expect(JSON.stringify(result)).not.toContain('synthetic-must-never-serialize')
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

  it('allows a legacy caller to change their own role through the shared transaction', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ user_id: MANAGER, role: 'admin' }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ team_id: TEAM_A, user_id: MANAGER, role: 'inviter', status: 'active' }],
        rowCount: 1,
      })
    const result = await updateManagedMemberRoleForUser(MANAGER, MANAGER, TEAM_A, 'inviter')
    expect(result).toMatchObject({ membership: { role: 'inviter', status: 'active' } })
    expect(mocks.withTransaction).toHaveBeenCalledOnce()
  })

  it('allows a legacy caller to delete their own membership through the shared transaction', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ user_id: MANAGER, role: 'admin' }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ team_id: TEAM_A, user_id: MANAGER, role: 'admin', status: 'deleted' }],
        rowCount: 1,
      })
    const result = await deleteManagedMemberForUser(MANAGER, MANAGER, TEAM_A)
    expect(result).toMatchObject({ deleted: { status: 'deleted' } })
    expect(mocks.withTransaction).toHaveBeenCalledOnce()
  })

  it('does not re-lock the caller before the membership locks', async () => {
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

    const result = await updateManagedMemberRoleForUser(MANAGER, TARGET, TEAM_A, 'inviter', {
      contract: 'v1',
      userId: MANAGER,
      tokenHash: 'legacy-token-hash',
      issuedAt: Math.floor(Date.now() / 1000),
      authGeneration: 1,
    })

    expect(result).toEqual({
      membership: { team_id: TEAM_A, user_id: TARGET, role: 'inviter', status: 'active' },
    })
    expect(String(mocks.query.mock.calls[0]?.[0])).toContain('FROM team_members')
    expect(String(mocks.query.mock.calls[0]?.[0])).toContain('FOR UPDATE')
    expect(
      mocks.query.mock.calls.some(call =>
        String(call[0]).includes('external_user_session_security_epochs')
      )
    ).toBe(false)
    // Witness: the mutation completed and emitted its UPDATE.
    expect(String(mocks.query.mock.calls[1]?.[0])).toContain('UPDATE team_members')
    expect(mocks.appendEvents).toHaveBeenCalledTimes(1)
  })

  it('locks invitation authority and denies inviter-to-admin assignment before mutation', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ id: MANAGER }], rowCount: 1 })
      .mockResolvedValueOnce({
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
    // Lock order: the manager's user row, then its team_members rows.
    expect(String(mocks.query.mock.calls[0]?.[0])).toBe(
      'SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE'
    )
    expect(mocks.query.mock.calls[0]?.[1]).toEqual([MANAGER])
    expect(String(mocks.query.mock.calls[1]?.[0])).toContain('FROM team_members tm')
    expect(String(mocks.query.mock.calls[1]?.[0])).toContain('FOR UPDATE OF tm')
    expect(mocks.query).toHaveBeenCalledTimes(2)
    expect(mocks.registerInvitation).not.toHaveBeenCalled()
  })

  it('omits the invitation capability from managed creation results', async () => {
    let transactionDepth = 0
    mocks.withTransaction.mockImplementation(async work => {
      transactionDepth += 1
      try {
        return await work({ query: queryWithDatabaseClock })
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
      token: 'synthetic-must-never-leave-control-api',
      status: 'draft',
      purpose: 'member_invitation',
      ...activeInvitationWindow(),
      accepted_at: null,
      accepted_user_id: null,
      team_name: 'Team A',
    }
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("WHERE status = 'draft'")) return { rows: [], rowCount: 0 }
      if (sql.includes('SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE')) {
        return { rows: [{ id: MANAGER }], rowCount: 1 }
      }
      if (sql.includes('FROM team_members') && sql.includes('FOR UPDATE')) {
        return { rows: [{ team_id: TEAM_A, role: 'admin' }], rowCount: 1 }
      }
      if (sql.includes('UPDATE users') && sql.includes('SET name')) {
        return { rows: [{ id: TARGET }], rowCount: 1 }
      }
      if (sql.includes('INSERT INTO profiles')) return { rows: [], rowCount: 1 }
      if (sql.includes('WITH inserted AS')) return { rows: [invitation], rowCount: 1 }
      if (sql.includes('INSERT INTO invitation_teams')) return { rows: [], rowCount: 1 }
      if (sql.includes('FROM invitation_teams it') && sql.includes('JOIN teams')) {
        return {
          rows: [{ team_id: TEAM_A, team_name: 'Team A', role: 'member' }],
          rowCount: 1,
        }
      }
      if (sql.includes("SET status = 'pending'")) {
        if (!sql.includes("AND status = 'draft'")) return { rows: [], rowCount: 0 }
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

  it('activates a delivered generic invitation from the draft state', async () => {
    const invitation = {
      id: '00000000-0000-4000-8000-000000000200',
      team_id: null,
      invitee_name: 'Invitee',
      email: 'invitee@example.test',
      role: 'member',
      token: MANAGER,
      status: 'draft',
      purpose: 'member_invitation',
      ...activeInvitationWindow(),
      accepted_at: null,
      accepted_user_id: null,
      team_name: null,
    }
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("WHERE status = 'draft'")) return { rows: [], rowCount: 0 }
      if (sql.includes('WITH inserted AS')) return { rows: [invitation], rowCount: 1 }
      if (sql.includes('FROM invitation_teams it')) return { rows: [], rowCount: 0 }
      if (sql.includes("SET status = 'pending'")) {
        if (!sql.includes("AND status = 'draft'")) return { rows: [], rowCount: 0 }
        return { rows: [{ ...invitation, status: 'pending' }], rowCount: 1 }
      }
      throw new Error(`unexpected query: ${sql.slice(0, 40)}`)
    })

    const result = await createInvitationForTeams({
      inviteeName: 'Invitee',
      email: invitation.email,
    })
    expect(result).toMatchObject({ id: invitation.id, status: 'pending' })
    expect(mocks.registerInvitation).toHaveBeenCalledOnce()
  })

  it('does not apply inviter-controlled names to an existing user during acceptance', async () => {
    const invitation = {
      id: '00000000-0000-4000-8000-000000000200',
      team_id: TEAM_A,
      invitee_name: 'Untrusted inviter label',
      email: 'target@example.com',
      role: 'member',
      token: 'synthetic-invitation-token',
      status: 'pending',
      purpose: 'member_invitation',
      ...activeInvitationWindow(),
      accepted_at: null,
      accepted_user_id: null,
      team_name: 'Team A',
    }
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("$2 = '' AND i.token = $1")) {
        return { rows: [invitation], rowCount: 1 }
      }
      if (sql.includes(ACCEPTANCE_USER_LOCK)) {
        return {
          rows: [
            {
              id: TARGET,
              email: invitation.email,
              name: 'Original user name',
              picture: null,
              password_hash: null,
              lifecycle_state: 'active',
              lifecycle_version: 1,
            },
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
    // Lock order: the user row before the invitation row and the membership
    // write; the caller issues from that locked row.
    expect(result).toMatchObject({ lockedUser: { lifecycleState: 'active', lifecycleVersion: 1 } })
    expectUsersBeforeInvitations(mocks.query.mock.calls, { membershipWrite: true })
    const sql = mocks.query.mock.calls.map(call => String(call[0])).join('\n')
    expect(sql).toContain('FOR UPDATE OF i')
    expect(sql).toContain("AND status = 'pending'")
    expect(sql).not.toContain('UPDATE users')
    expect(sql).not.toContain('UPDATE profiles')
  })

  it('replays a general invitation acceptance for the same user and rejects password-reset use', async () => {
    const invitation = {
      id: '00000000-0000-4000-8000-000000000200',
      team_id: TEAM_A,
      invitee_name: 'Target',
      email: 'target@example.com',
      role: 'member',
      token: 'synthetic-single-use-token',
      status: 'pending',
      purpose: 'member_invitation',
      ...activeInvitationWindow(),
      accepted_at: null,
      accepted_user_id: null,
      team_name: 'Team A',
    }
    let status = invitation.status
    let membershipWrites = 0
    let acceptanceWrites = 0
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("$2 = '' AND i.token = $1")) {
        return {
          rows: [
            {
              ...invitation,
              status,
              accepted_user_id: status === 'accepted' ? TARGET : null,
            },
          ],
          rowCount: 1,
        }
      }
      if (sql.includes(ACCEPTANCE_USER_LOCK)) {
        return {
          rows: [
            {
              id: TARGET,
              email: invitation.email,
              name: 'Target',
              picture: null,
              password_hash: null,
              lifecycle_state: 'active',
              lifecycle_version: 1,
            },
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
              name: 'Target',
              picture: null,
              password_hash: null,
            },
          ],
          rowCount: 1,
        }
      }
      if (sql.includes('INSERT INTO profiles')) return { rows: [], rowCount: 0 }
      if (sql.includes('UPDATE profiles')) return { rows: [], rowCount: 1 }
      if (sql.includes("SET status = 'accepted'")) {
        if (status !== 'pending') return { rows: [], rowCount: 0 }
        status = 'accepted'
        acceptanceWrites += 1
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

    const first = await acceptInvitationForEmail(invitation.email, invitation.token)
    expect(first).toMatchObject({ data: { accepted: true, userId: TARGET } })
    mocks.query.mockClear()
    const replay = await acceptInvitationForEmail(invitation.email, invitation.token)
    expect(replay).toMatchObject({
      data: { accepted: true, userId: TARGET, replay: true },
    })
    // The replay takes the user lock before the accepted invitation row too.
    expectUsersBeforeInvitations(mocks.query.mock.calls, { membershipWrite: false })
    // The replay repeats the retained payload and only adds the replay signal.
    if (!('data' in first) || !('data' in replay)) {
      throw new Error('acceptance replay did not return data')
    }
    expect(replay.data).toEqual({ ...first.data, replay: true })
    expect(membershipWrites).toBe(1)
    expect(acceptanceWrites).toBe(1)

    status = 'pending'
    const passwordReset = { ...invitation, purpose: 'password_reset' }
    mocks.query.mockImplementationOnce(async () => ({ rows: [passwordReset], rowCount: 1 }))
    await expect(acceptInvitationForEmail(invitation.email, invitation.token)).resolves.toEqual({
      error: 'not_pending',
    })
  })

  it('locks the user before the invitation when accepting by id', async () => {
    const invitation = {
      id: '00000000-0000-4000-8000-000000000201',
      team_id: TEAM_A,
      invitee_name: 'Target',
      email: 'target@example.com',
      role: 'member',
      token: 'synthetic-desktop-access-token',
      status: 'pending',
      purpose: 'admin_desktop_access',
      ...activeInvitationWindow(),
      accepted_at: null,
      accepted_user_id: null,
      team_name: 'Team A',
    }
    const dispatcher = acceptanceQueries({
      invitation,
      unlockedUser: { lifecycle_state: 'active', lifecycle_version: 1 },
      lockedUser: { lifecycle_state: 'active', lifecycle_version: 1 },
    })
    mocks.query.mockImplementation(dispatcher.query)

    await expect(acceptInvitationById(invitation.email, invitation.id)).resolves.toMatchObject({
      data: { accepted: true, userId: TARGET, status: 'accepted' },
    })
    expectUsersBeforeInvitations(mocks.query.mock.calls, { membershipWrite: true })
    const statements = mocks.query.mock.calls.map(call => String(call[0]))
    expect(statements[0]).toContain('i.id::text = $1')
    expect(dispatcher.state.acceptanceWrites).toBe(1)
    expect(dispatcher.state.membershipWrites).toBe(1)
  })

  it.each([
    ['token', () => acceptInvitationForEmail('target@example.com', 'synthetic-retired-token')],
    [
      'id',
      () => acceptInvitationById('target@example.com', '00000000-0000-4000-8000-000000000202'),
    ],
  ] as const)(
    'refuses acceptance by %s when the locked user row is retired',
    async (_lookup, accept) => {
      const invitation = {
        id: '00000000-0000-4000-8000-000000000202',
        team_id: TEAM_A,
        invitee_name: 'Target',
        email: 'target@example.com',
        role: 'member',
        token: 'synthetic-retired-token',
        status: 'pending',
        purpose: 'member_invitation',
        ...activeInvitationWindow(),
        accepted_at: null,
        accepted_user_id: null,
        team_name: 'Team A',
      }
      // The unlocked read predates a retirement that committed while the
      // acceptance waited on the user lock.
      const dispatcher = acceptanceQueries({
        invitation,
        unlockedUser: { lifecycle_state: 'active', lifecycle_version: 1 },
        lockedUser: { lifecycle_state: 'retired', lifecycle_version: 2 },
      })
      mocks.query.mockImplementation(dispatcher.query)

      await expect(accept()).resolves.toEqual({ error: 'user_retired' })
      const statements = mocks.query.mock.calls.map(call => String(call[0]))
      // Witness: the decision followed the user lock taken for the target.
      const userLock = statements.findIndex(statement => statement.includes(ACCEPTANCE_USER_LOCK))
      expect(userLock).toBeGreaterThan(0)
      expect(mocks.query.mock.calls[userLock]?.[1]).toEqual([TARGET])
      expect(statements.some(statement => statement.includes('INSERT INTO team_members'))).toBe(
        false
      )
      expect(statements.some(statement => statement.includes("SET status = 'accepted'"))).toBe(
        false
      )
      expect(dispatcher.state.status).toBe('pending')
    }
  )

  it('returns the lifecycle generation of the locked user row', async () => {
    const invitation = {
      id: '00000000-0000-4000-8000-000000000203',
      team_id: TEAM_A,
      invitee_name: 'Target',
      email: 'target@example.com',
      role: 'member',
      token: 'synthetic-generation-token',
      status: 'pending',
      purpose: 'member_invitation',
      ...activeInvitationWindow(),
      accepted_at: null,
      accepted_user_id: null,
      team_name: 'Team A',
    }
    // A password change committed between the unlocked read and the lock.
    const dispatcher = acceptanceQueries({
      invitation,
      unlockedUser: { lifecycle_state: 'active', lifecycle_version: 1, password_hash: null },
      lockedUser: {
        lifecycle_state: 'active',
        lifecycle_version: 2,
        password_hash: 'synthetic-stored-hash',
      },
    })
    mocks.query.mockImplementation(dispatcher.query)

    const result = await acceptInvitationForEmail(invitation.email, invitation.token)

    expect(result).toMatchObject({
      data: { accepted: true, authGeneration: 2, lifecycleState: 'active', passwordPending: false },
      lockedUser: { lifecycleState: 'active', lifecycleVersion: 2 },
    })
    expect(dispatcher.state.membershipWrites).toBe(1)
  })

  it('serializes invitation acceptance behind a concurrent manager revocation', async () => {
    const invitation = {
      id: '00000000-0000-4000-8000-000000000200',
      team_id: TEAM_A,
      invitee_name: 'Invitee',
      email: 'invitee@example.com',
      role: 'member',
      token: 'synthetic-invitation-token',
      status: 'pending',
      purpose: 'member_invitation',
      ...activeInvitationWindow(),
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
    let acceptanceUserReads = 0

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
        if (sql.includes(MANAGER_USER_LOCK)) {
          return { rows: [{ id: MANAGER }], rowCount: 1 }
        }
        // The acceptance resolves and locks its user before it queues on the
        // invitation row the revocation holds.
        if (sql.includes(ACCEPTANCE_USER_LOCK) || sql.includes('WHERE email = $1')) {
          acceptanceUserReads += 1
          return {
            rows: [
              {
                id: TARGET,
                email: invitation.email,
                name: 'Invitee',
                picture: null,
                password_hash: null,
                lifecycle_state: 'active',
                lifecycle_version: 1,
              },
            ],
            rowCount: 1,
          }
        }
        if (sql.includes('INSERT INTO profiles')) return { rows: [], rowCount: 0 }
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
    // Witness: the acceptance passed its unlocked read and locked its user, so
    // the refusal came from the locked invitation row after the revocation.
    expect(acceptanceUserReads).toBe(2)
    expect(membershipWrites).toBe(0)
  })

  it('locks and conditionally consumes password-reset invitations before password writes', async () => {
    const invitation = {
      id: '00000000-0000-4000-8000-000000000200',
      team_id: null,
      invitee_name: 'Target',
      email: 'target@example.com',
      role: 'member',
      token: 'synthetic-password-reset-token',
      status: 'pending',
      purpose: 'password_reset',
      ...activeInvitationWindow(),
      accepted_at: null,
      accepted_user_id: null,
      team_name: null,
    }

    for (const operation of [
      () =>
        setInvitationPasswordForUser(
          TARGET,
          invitation.email,
          invitation.id,
          'synthetic-valid-password'
        ),
      () =>
        setInvitationPasswordForEmail(invitation.email, invitation.id, 'synthetic-valid-password'),
    ]) {
      mocks.query.mockReset()
      mocks.query.mockImplementation(async (sql: string) => {
        if (
          sql.includes('FROM invitations i') &&
          (sql.includes('i.id::text = $1') || sql.includes('i.token = $1'))
        ) {
          return {
            rows: [
              sql.includes('FOR UPDATE OF i') ? { ...invitation, status: 'accepted' } : invitation,
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
      expect(sql).not.toContain('SET password_hash')
    }
  })

  it('accepts a member invitation before first password setup', async () => {
    const invitation = {
      id: '00000000-0000-4000-8000-000000000200',
      team_id: TEAM_A,
      invitee_name: 'New user',
      email: 'new-user@example.com',
      role: 'member',
      token: 'synthetic-member-setup-token',
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
    let lifecycleVersion = 1
    let lifecycleAdvances = 0
    mocks.query.mockImplementation(async (sql: string) => {
      if (
        sql.includes('FROM invitations i') &&
        (sql.includes('i.token = $1') || sql.includes('i.id::text = $1'))
      ) {
        return {
          rows: [
            { ...invitation, status, accepted_user_id: status === 'accepted' ? TARGET : null },
          ],
          rowCount: 1,
        }
      }
      if (sql.includes(ACCEPTANCE_USER_LOCK)) {
        return {
          rows: [
            {
              id: TARGET,
              email: invitation.email,
              name: 'New user',
              picture: null,
              password_hash: passwordHash,
              lifecycle_state: 'active',
              lifecycle_version: lifecycleVersion,
            },
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
              lifecycle_state: 'active',
              lifecycle_version: lifecycleVersion,
            },
          ],
          rowCount: 1,
        }
      }
      if (sql.includes('INSERT INTO profiles')) return { rows: [], rowCount: 0 }
      if (sql.includes('UPDATE profiles')) return { rows: [], rowCount: 1 }
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
        lifecycleVersion += 1
        lifecycleAdvances += 1
        return { rows: [{ lifecycle_version: lifecycleVersion }], rowCount: 1 }
      }
      if (
        sql.includes('SELECT id') &&
        sql.includes('FROM users') &&
        sql.includes('FOR NO KEY UPDATE')
      ) {
        return { rows: [{ id: TARGET, lifecycle_version: lifecycleVersion }], rowCount: 1 }
      }
      if (sql.includes('external_user_session_security_epochs')) return { rows: [], rowCount: 1 }
      if (sql.includes('UPDATE external_user_sessions')) return { rows: [], rowCount: 0 }
      throw new Error(`unexpected query: ${sql.slice(0, 40)}`)
    })

    await expect(
      acceptInvitationForEmail(invitation.email, invitation.token, invitation.id)
    ).resolves.toMatchObject({ data: { accepted: true, userId: TARGET, status: 'accepted' } })
    expectUsersBeforeInvitations(mocks.query.mock.calls, { membershipWrite: true })
    await expect(
      setInvitationPasswordForUser(
        TARGET,
        invitation.email,
        invitation.id,
        'synthetic-valid-password'
      )
    ).resolves.toMatchObject({ data: { passwordUpdated: true, status: 'accepted' } })
    expect(status).toBe('accepted')
    expect(passwordHash).not.toBeNull()
    expect(membershipWrites).toBe(1)
    expect(lifecycleVersion).toBe(2)
    expect(lifecycleAdvances).toBe(1)

    expect(membershipWrites).toBe(1)
  })

  it('rejects email-only password setup for a member invitation', async () => {
    const invitation = {
      id: '00000000-0000-4000-8000-000000000200',
      team_id: TEAM_A,
      invitee_name: 'Existing user',
      email: 'existing@example.com',
      role: 'member',
      token: 'synthetic-consumed-member-token',
      status: 'accepted',
      purpose: 'member_invitation',
      created_at: new Date(),
      expires_at: new Date(Date.now() + 60_000),
      accepted_at: new Date(),
      accepted_user_id: TARGET,
      team_name: 'Team A',
    }
    mocks.query.mockImplementation(async (sql: string) => {
      if (
        sql.includes('FROM invitations i') &&
        (sql.includes('i.token = $1') || sql.includes('i.id::text = $1'))
      ) {
        return { rows: [invitation], rowCount: 1 }
      }
      throw new Error(`unexpected query: ${sql.slice(0, 40)}`)
    })

    await expect(
      setInvitationPasswordForEmail(invitation.email, invitation.id, 'attacker-password')
    ).resolves.toEqual({ error: 'not_found' })
    const sql = mocks.query.mock.calls.map(call => String(call[0])).join('\n')
    expect(sql).not.toContain('SET password_hash')
    expect(sql).not.toContain('external_user_session_security_epochs')
  })

  it('sends a managed resend from one locked transaction', async () => {
    const invitation = {
      id: '00000000-0000-4000-8000-000000000200',
      team_id: TEAM_A,
      invitee_name: 'Invitee',
      email: 'invitee@example.com',
      role: 'member',
      token: 'synthetic-invitation-token',
      status: 'pending',
      purpose: 'member_invitation',
      ...activeInvitationWindow(),
      accepted_at: null,
      accepted_user_id: null,
      team_name: 'Team A',
    }
    let transactionDepth = 0
    mocks.withTransaction.mockImplementation(async work => {
      transactionDepth += 1
      try {
        return await work({ query: queryWithDatabaseClock })
      } finally {
        transactionDepth -= 1
      }
    })
    mocks.registerInvitation.mockImplementation(async () => {
      expect(transactionDepth).toBe(0)
    })
    mocks.query
      .mockResolvedValueOnce({ rows: [{ id: MANAGER }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [invitation], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ team_id: TEAM_A, team_name: 'Team A', role: 'member' }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ id: MANAGER }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ team_id: TEAM_A, role: 'admin' }], rowCount: 1 })

    await expect(resendManagedInvitationForUser(MANAGER, invitation.id)).resolves.toEqual({
      resent: true,
      id: invitation.id,
      email: invitation.email,
    })
    expectManagerBeforeInvitation(mocks.query.mock.calls)
    expect(mocks.registerInvitation).toHaveBeenCalledOnce()
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
        ...activeInvitationWindow(),
        accepted_at: null,
        accepted_user_id: null,
        team_name: 'Team A',
      }
      mocks.query
        .mockResolvedValueOnce({ rows: [{ id: MANAGER }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [invitation], rowCount: 1 })
        .mockResolvedValueOnce({
          rows: [{ team_id: TEAM_A, team_name: 'Team A', role: 'member' }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [{ id: MANAGER }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })

      const result =
        operation === 'resend'
          ? await resendManagedInvitationForUser(MANAGER, invitation.id)
          : await revokeManagedInvitationForUser(MANAGER, invitation.id)

      expect(result).toEqual({ error: 'forbidden' })
      expectManagerBeforeInvitation(mocks.query.mock.calls)
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

  it('does not re-lock the caller before the member-removal membership locks', async () => {
    mocks.query
      .mockResolvedValueOnce({
        rows: [
          { user_id: MANAGER, role: 'admin' },
          { user_id: TARGET, role: 'member' },
        ],
        rowCount: 2,
      })
      .mockResolvedValueOnce({
        rows: [{ team_id: TEAM_A, user_id: TARGET, role: 'member', status: 'deleted' }],
        rowCount: 1,
      })

    const result = await deleteManagedMemberForUser(MANAGER, TARGET, TEAM_A, {
      contract: 'v1',
      userId: MANAGER,
      tokenHash: 'legacy-token-hash',
      issuedAt: Math.floor(Date.now() / 1000),
      authGeneration: 1,
    })

    expect(result).toEqual({
      deleted: { team_id: TEAM_A, user_id: TARGET, role: 'member', status: 'deleted' },
    })
    expect(String(mocks.query.mock.calls[0]?.[0])).toContain('FROM team_members')
    expect(String(mocks.query.mock.calls[0]?.[0])).toContain('FOR UPDATE')
    expect(
      mocks.query.mock.calls.some(call =>
        String(call[0]).includes('external_user_session_security_epochs')
      )
    ).toBe(false)
    // Witness: the removal completed and emitted its UPDATE.
    expect(String(mocks.query.mock.calls[1]?.[0])).toContain('UPDATE team_members')
    expect(mocks.appendEvents).toHaveBeenCalledTimes(1)
  })

  it('changes a password and revokes every session in one conditional transaction', async () => {
    const currentHash = await bcrypt.hash('synthetic-current-password', 4)
    mocks.query
      .mockResolvedValueOnce({ rows: [{ password_hash: currentHash }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ lifecycle_version: 2 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: MANAGER, lifecycle_version: 2 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 2 })

    await expect(
      updateUserPassword(
        MANAGER,
        'manager@example.com',
        'synthetic-current-password',
        'next-password'
      )
    ).resolves.toEqual({ updated: true })

    expect(mocks.withTransaction).toHaveBeenCalledTimes(2)
    const passwordUpdate = String(mocks.query.mock.calls[1]?.[0])
    expect(passwordUpdate).toContain('SET password_hash = $3')
    expect(passwordUpdate).toContain('lifecycle_version = lifecycle_version + 1')
    expect(passwordUpdate).toContain('AND password_hash = $4')
    expect(passwordUpdate).toContain('RETURNING lifecycle_version')
    expect(String(mocks.query.mock.calls[2]?.[0])).toContain('FOR NO KEY UPDATE')
    expect(String(mocks.query.mock.calls[3]?.[0])).toContain(
      'INSERT INTO external_user_session_security_epochs'
    )
    expect(String(mocks.query.mock.calls[4]?.[0])).toContain('UPDATE external_user_sessions')
    expect(
      mocks.query.mock.calls.filter(([sql]) =>
        String(sql).includes('lifecycle_version = lifecycle_version + 1')
      )
    ).toHaveLength(1)
  })

  it('treats wildcard characters literally, excludes channels, and returns one bounded page without a cursor', async () => {
    mocks.query.mockResolvedValue({
      rows: Array.from({ length: 25 }, (_, index) => ({
        id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        email: `person-${index}@example.com`,
        name: `Person ${index}`,
        display_name: `Person ${index}`,
        sort_key: `person ${String(index).padStart(2, '0')}`,
        channels: { emails: ['secret@example.com'] },
      })),
      rowCount: 25,
    })

    const result = await searchDirectory(TEAM_A, '%_')

    // Witness: the search ran once, with the escaped pattern.
    expect(mocks.query).toHaveBeenCalledTimes(1)
    const [sql, values] = mocks.query.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('ILIKE $2 ESCAPE')
    expect(sql).not.toContain('p.channels')
    expect(sql).toMatch(/ORDER BY sort_key ASC, u\.id ASC\s+LIMIT 25$/)
    expect(values).toEqual([TEAM_A, '%\\%\\_%'])
    expect(result.items).toHaveLength(25)
    expect(result).not.toHaveProperty('nextCursor')
    expect(JSON.stringify(result)).not.toContain('channels')
    expect(JSON.stringify(result)).not.toContain('secret@example.com')
  })

  function functionBody(source: string, name: string): string | null {
    const start = source.indexOf(`function ${name}(`)
    if (start === -1) return null
    const end = source.indexOf('\n}\n', start)
    return end === -1 ? null : source.slice(start, end)
  }

  // Text fix, not behaviour: the locked read already serializes writers, so no
  // behaviour test can reach this predicate. The witness proves the extractor
  // finds the same predicate in the acceptance path.
  it('pins the conditional revoke predicate in the service body', () => {
    const source = readFileSync(
      new URL('../src/services/directory/membership.ts', import.meta.url),
      'utf8'
    )
    const revokeBody = functionBody(source, 'revokeManagedInvitationForUser')
    expect(revokeBody).toContain(
      "UPDATE invitations SET status = 'revoked' WHERE id = $1 AND status = 'pending'"
    )
    expect(functionBody(source, 'acceptPendingMembershipInvitation')).toContain(
      "AND status = 'pending'"
    )
    // Negative control: a copy without the predicate no longer satisfies it.
    expect(revokeBody!.replace("AND status = 'pending'", '')).not.toContain(
      "AND status = 'pending'"
    )
  })
})
