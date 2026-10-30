import { beforeEach, describe, expect, it, vi } from 'vitest'
import { insertInvitationForTeams } from '../src/services/directory/invitationStore.js'

const dbModule = vi.hoisted(() => ({
  poolQuery: vi.fn(),
}))

vi.mock('../src/db.js', () => ({
  pool: { query: dbModule.poolQuery },
}))

describe('invitation expiration policy', () => {
  beforeEach(() => {
    dbModule.poolQuery.mockReset()
  })

  async function insert(purpose?: 'member_invitation' | 'password_reset') {
    const normalizedPurpose = purpose || 'member_invitation'
    const createdAt = new Date('2026-10-26T12:00:00.000Z')
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes('WITH inserted AS')) {
        const ttlHours = Number(values?.[6])
        return {
          rows: [
            {
              id: 'invitation-1',
              team_id: null,
              invitee_name: 'Setup member',
              email: 'member@example.invalid',
              role: 'member',
              token: 'synthetic-invitation-token',
              status: 'pending',
              purpose: normalizedPurpose,
              created_at: createdAt,
              expires_at: new Date(createdAt.getTime() + ttlHours * 60 * 60 * 1000),
              accepted_at: null,
              accepted_user_id: null,
              team_name: null,
            },
          ],
          rowCount: 1,
        }
      }
      if (sql.includes('FROM invitation_teams it')) return { rows: [], rowCount: 0 }
      throw new Error(`unexpected invitation query: ${sql}`)
    })

    const result = await insertInvitationForTeams(
      { query },
      {
        inviteeName: 'Setup member',
        email: 'member@example.invalid',
        purpose,
        status: 'pending',
      }
    )
    const insertValues = query.mock.calls[0]?.[1] as unknown[]
    return { result, insertValues }
  }

  it('uses seven days for password-setup resends and 48 hours for dedicated resets', async () => {
    const setup = await insert()
    expect(setup.result.invitation.purpose).toBe('member_invitation')
    expect(setup.insertValues[5]).toBe('member_invitation')
    expect(setup.insertValues[6]).toBe('168')
    expect(
      setup.result.invitation.expires_at.getTime() - setup.result.invitation.created_at.getTime()
    ).toBe(168 * 60 * 60 * 1000)

    const reset = await insert('password_reset')
    expect(reset.result.invitation.purpose).toBe('password_reset')
    expect(reset.insertValues[5]).toBe('password_reset')
    expect(reset.insertValues[6]).toBe('48')
    expect(
      reset.result.invitation.expires_at.getTime() - reset.result.invitation.created_at.getTime()
    ).toBe(48 * 60 * 60 * 1000)
  })
})
