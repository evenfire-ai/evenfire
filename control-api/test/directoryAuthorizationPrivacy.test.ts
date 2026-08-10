import { beforeEach, describe, expect, it, vi } from 'vitest'
import bcrypt from 'bcryptjs'
import {
  DirectorySearchCursorError,
  createManagedInvitationForUser,
  deleteManagedMemberForUser,
  listManagedMembersForUser,
  listManagedPendingInvitationsForUser,
  resendManagedInvitationForUser,
  revokeManagedInvitationForUser,
  searchDirectory,
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
      .mockResolvedValueOnce({ rows: [], rowCount: 2 })

    await expect(
      updateUserPassword(MANAGER, 'manager@example.com', 'current-password', 'next-password')
    ).resolves.toEqual({ updated: true })

    expect(mocks.withTransaction).toHaveBeenCalledTimes(1)
    const passwordUpdate = String(mocks.query.mock.calls[1]?.[0])
    expect(passwordUpdate).toContain('AND password_hash = $4')
    expect(String(mocks.query.mock.calls[2]?.[0])).toContain('UPDATE external_user_sessions')
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
