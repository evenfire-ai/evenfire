import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createExternalMembersRouter } from '../src/routes/external/members.js'

const directoryMock = vi.hoisted(() => ({
  createManagedInvitationForUser: vi.fn(),
  deleteManagedMemberForUser: vi.fn(),
  deleteManagedUserForUser: vi.fn(),
  externalManagedInvitationResponse: vi.fn((value: Record<string, unknown>) => {
    const { token: _token, ...safe } = value
    return safe
  }),
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

const rateLimitMock = vi.hoisted(() => ({
  checkAndIncrement: vi.fn(),
}))
vi.mock('../src/services/rateLimiterService.js', () => rateLimitMock)

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use(createExternalMembersRouter())
  return app
}

describe('external members routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    rateLimitMock.checkAndIncrement.mockResolvedValue({
      allowed: true,
      count: 1,
      remaining: 29,
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
    })
  })

  it('passes invitee name through managed member invitations', async () => {
    directoryMock.createManagedInvitationForUser.mockResolvedValueOnce({
      invitation: { id: 'inv-1', token: 'secret' },
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

  it('rate limits member reads before directory access', async () => {
    rateLimitMock.checkAndIncrement.mockResolvedValueOnce({
      allowed: false,
      count: 31,
      remaining: 0,
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
    })

    const response = await request(makeApp()).get('/external/members')

    expect(response.status).toBe(429)
    expect(rateLimitMock.checkAndIncrement).toHaveBeenCalledWith(
      'external_member_read:user:manager-1',
      30
    )
    expect(directoryMock.listManagedMembersForUser).not.toHaveBeenCalled()
  })

  it('rate limits member mutations before invitation creation', async () => {
    rateLimitMock.checkAndIncrement.mockResolvedValueOnce({
      allowed: false,
      count: 11,
      remaining: 0,
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
    })

    const response = await request(makeApp())
      .post('/external/members/invitations')
      .send({ email: 'invitee@example.com', teams: [] })

    expect(response.status).toBe(429)
    expect(response.headers['retry-after']).toBeDefined()
    expect(rateLimitMock.checkAndIncrement).toHaveBeenCalledWith(
      'external_member_mutation:user:manager-1',
      10
    )
    expect(directoryMock.createManagedInvitationForUser).not.toHaveBeenCalled()
  })
})
