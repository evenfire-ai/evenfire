import { beforeEach, describe, expect, it, vi } from 'vitest'
import { listPendingInvitations } from '../src/services/directory/membership.js'

const db = vi.hoisted(() => ({ query: vi.fn() }))

vi.mock('../src/db.js', () => ({
  pool: db,
  withTransaction: vi.fn(),
}))

vi.mock('../src/services/invitationFlowRegistrationService.js', () => ({
  registerAndSendInvitation: vi.fn(),
}))

vi.mock('../src/services/tracing/controlApiPermissionEvents.js', () => ({
  appendControlApiPermissionEventsInTransaction: vi.fn(),
}))

describe('pending invitation list projection', () => {
  beforeEach(() => {
    db.query.mockReset()
  })

  it('never returns the invitation capability token', async () => {
    db.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: '11111111-1111-4111-8111-111111111111',
            team_id: '22222222-2222-4222-8222-222222222222',
            invitee_name: 'Invitee',
            email: 'invitee@example.com',
            role: 'member',
            token: 'live-secret-capability',
            status: 'pending',
            purpose: 'member_invitation',
            created_at: new Date('2026-08-10T00:00:00Z'),
            expires_at: new Date('2026-08-12T00:00:00Z'),
            accepted_at: null,
            accepted_user_id: null,
            team_name: 'Team',
          },
        ],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })

    const [item] = await listPendingInvitations('invitee@example.com')

    expect(item).toMatchObject({ id: '11111111-1111-4111-8111-111111111111' })
    expect(item).not.toHaveProperty('token')
    expect(db.query.mock.calls[0][0]).not.toContain('i.token')
  })
})
