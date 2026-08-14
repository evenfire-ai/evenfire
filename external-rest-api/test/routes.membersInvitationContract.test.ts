import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createExternalMembersRouter } from '../../control-api/src/routes/external/members.js'
import { createMembersRouter } from '../src/routes/members.js'

const authTokenMock = vi.hoisted(() => ({
  verifyToken: vi.fn(),
}))

const directoryMock = vi.hoisted(() => ({
  createManagedInvitationForUser: vi.fn(),
  deleteManagedMemberForUser: vi.fn(),
  deleteManagedUserForUser: vi.fn(),
  externalManagedInvitationResponse: vi.fn((value: Record<string, unknown>) => value),
  listManageableTeamsForUser: vi.fn(),
  listManagedMembersForUser: vi.fn(),
  listManagedPendingInvitationsForUser: vi.fn(),
  resendManagedInvitationForUser: vi.fn(),
  revokeManagedInvitationForUser: vi.fn(),
  updateManagedMemberRoleForUser: vi.fn(),
}))

const rateLimitMock = vi.hoisted(() => ({
  checkAndIncrement: vi.fn(),
}))

vi.mock('../src/authToken.js', () => authTokenMock)
vi.mock('../../control-api/src/middleware/externalSessionAuth.js', () => ({
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
vi.mock('../../control-api/src/services/directory/index.js', () => directoryMock)
vi.mock('../../control-api/src/services/rateLimiterService.js', () => rateLimitMock)

const claims = {
  userId: 'user-1',
  email: 'user@example.com',
  teamId: 'team-1',
  role: 'admin' as const,
  exp: 9999999999,
}

function makeControlApp() {
  const app = express()
  app.use(express.json())
  app.use(createExternalMembersRouter())
  return app
}

function makeExternalApp() {
  const app = express()
  app.use(express.json())
  app.use(createMembersRouter())
  return app
}

describe('member invitation cross-service error contract', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    authTokenMock.verifyToken.mockReturnValue(claims)
    rateLimitMock.checkAndIncrement.mockResolvedValue({
      allowed: true,
      count: 1,
      remaining: 29,
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('preserves the authoritative invalid-email response through the real client parser', async () => {
    const controlApp = makeControlApp()
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      const upstream = await request(controlApp).post('/external/members/invitations').send(body)

      return new Response(JSON.stringify(upstream.body), {
        status: upstream.status,
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    await request(makeExternalApp())
      .post('/members/invite')
      .set('authorization', 'Bearer good-token')
      .send({ email: 'not-an-email', teams: [] })
      .expect(400, { error: 'Valid email is required' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse(String(init?.body))).toEqual({
      email: 'not-an-email',
      name: '',
      teams: [],
    })
    expect(rateLimitMock.checkAndIncrement).toHaveBeenCalledWith(
      'external_member_mutation:user:manager-1',
      10
    )
    expect(directoryMock.createManagedInvitationForUser).not.toHaveBeenCalled()
  })
})
