import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createExternalMembersRouter } from '../src/routes/external/members.js'

const directoryMock = vi.hoisted(() => ({
  createManagedInvitationForUser: vi.fn(),
  deleteManagedMemberForUser: vi.fn(),
  deleteManagedUserForUser: vi.fn(),
  listManageableTeamsForUser: vi.fn(),
  listManagedMembersForUser: vi.fn(),
  listManagedPendingInvitationsForUser: vi.fn(),
  resendManagedInvitationForUser: vi.fn(),
  revokeManagedInvitationForUser: vi.fn(),
  updateManagedMemberRoleForUser: vi.fn(),
}))

vi.mock('../src/middleware/externalSessionAuth.js', () => ({
  requireValidExternalSessionToken: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction
  ) => {
    ;(req as express.Request & { externalAuth?: { userId: string } }).externalAuth = {
      userId: 'manager-1',
    }
    next()
  },
}))

vi.mock('../src/services/directory/index.js', () => directoryMock)

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use(createExternalMembersRouter())
  return app
}

describe('external members routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('passes invitee name through managed member invitations', async () => {
    directoryMock.createManagedInvitationForUser.mockResolvedValueOnce({
      invitation: { id: 'inv-1' },
    })

    await request(makeApp())
      .post('/external/members/invitations')
      .send({
        email: 'INVITEE@EXAMPLE.COM',
        name: '  Full Name  ',
        teams: [{ teamId: 'team-1', role: 'admin' }],
      })
      .expect(201, { id: 'inv-1' })

    expect(directoryMock.createManagedInvitationForUser).toHaveBeenCalledWith(
      'manager-1',
      'invitee@example.com',
      [{ teamId: 'team-1', role: 'admin' }],
      'Full Name'
    )
  })

  it('rejects overlong invitee names', async () => {
    await request(makeApp())
      .post('/external/members/invitations')
      .send({
        email: 'invitee@example.com',
        name: 'a'.repeat(121),
        teams: [{ teamId: 'team-1', role: 'member' }],
      })
      .expect(400, { error: 'invalid_name' })

    expect(directoryMock.createManagedInvitationForUser).not.toHaveBeenCalled()
  })

  it('does not disclose that a target belongs to hidden teams when deletion is denied', async () => {
    directoryMock.deleteManagedUserForUser.mockResolvedValueOnce({
      error: 'forbidden_uncontrolled_teams',
    })

    const response = await request(makeApp()).delete('/external/members/target-1')

    expect(response.status).toBe(403)
    expect(response.body).toEqual({ error: 'forbidden' })
    expect(JSON.stringify(response.body)).not.toContain('team')
    expect(JSON.stringify(response.body)).not.toContain('uncontrolled')
  })
})
