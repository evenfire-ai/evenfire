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
  app.use((req, _res, next) => {
    ;(req as express.Request & { correlationId?: string }).correlationId =
      'request-external-members'
    next()
  })
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

  it('requires an explicit reason and Idempotency-Key before retiring a managed user', async () => {
    await request(makeApp())
      .delete('/external/members/target-1')
      .expect(400, { error: 'reason_required' })
    expect(directoryMock.deleteManagedUserForUser).not.toHaveBeenCalled()

    await request(makeApp())
      .delete('/external/members/target-1')
      .send({ reason: 'manager retirement' })
      .expect(400, { error: 'idempotency_key_required' })
    expect(directoryMock.deleteManagedUserForUser).not.toHaveBeenCalled()
  })

  it('passes the authenticated platform actor inputs, idempotency key, and correlation id to managed retirement', async () => {
    directoryMock.deleteManagedUserForUser.mockResolvedValueOnce({
      deleted: { ok: true, id: 'target-1' },
      outcome: { outcome: 'retired', operationId: 'op-1' },
    })

    await request(makeApp())
      .delete('/external/members/target-1')
      .set('Idempotency-Key', 'external-delete-1')
      .send({ reason: 'manager retirement' })
      .expect(200, { ok: true, id: 'target-1' })

    expect(directoryMock.deleteManagedUserForUser).toHaveBeenCalledWith('manager-1', 'target-1', {
      reason: 'manager retirement',
      idempotencyKey: 'external-delete-1',
      requestId: 'request-external-members',
    })
  })

  it.each([
    ['invalid_retirement_input', 400],
    ['idempotency_conflict', 409],
    ['retirement_conflict', 409],
  ] as const)('maps governed retirement error %s to its route contract', async (error, status) => {
    directoryMock.deleteManagedUserForUser.mockResolvedValueOnce({ error })

    await request(makeApp())
      .delete('/external/members/target-1')
      .set('Idempotency-Key', `external-${error}`)
      .send({ reason: 'manager retirement' })
      .expect(status, { error })
  })
})
