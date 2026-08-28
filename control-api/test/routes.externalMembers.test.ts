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
    const externalReq = req as express.Request & {
      externalAuth?: { userId: string }
      externalSessionAuthority?: {
        contract: 'v1'
        userId: string
        authGeneration: number
        issuedAt: number
        tokenHash: string
      }
    }
    externalReq.externalAuth = {
      userId: 'manager-1',
    }
    externalReq.externalSessionAuthority = {
      contract: 'v1',
      userId: 'manager-1',
      authGeneration: 1,
      issuedAt: 1_787_931_018,
      tokenHash: 'external-members-test-token',
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
      'Full Name',
      expect.objectContaining({ contract: 'v1', userId: 'manager-1' })
    )
  })

  it('rejects raw invitation emails longer than 320 characters before directory work', async () => {
    const overlongEmail = `${'a'.repeat(315)}@a.com`

    await request(makeApp())
      .post('/external/members/invitations')
      .send({
        email: overlongEmail,
        teams: [{ teamId: 'team-1', role: 'member' }],
      })
      .expect(400, { error: 'invalid_email' })

    expect(directoryMock.createManagedInvitationForUser).not.toHaveBeenCalled()
  })

  it.each([
    ['a missing domain dot', 'invitee@example'],
    ['a second at sign', 'invitee@@example.com'],
    ['whitespace', 'invitee @example.com'],
    ['pathological dotted input', `!@!${'!.'.repeat(100)}@`],
  ])('rejects bounded invitation email with %s before directory work', async (_case, email) => {
    await request(makeApp())
      .post('/external/members/invitations')
      .send({
        email,
        teams: [{ teamId: 'team-1', role: 'member' }],
      })
      .expect(400, { error: 'invalid_email' })

    expect(directoryMock.createManagedInvitationForUser).not.toHaveBeenCalled()
  })

  it.each(['invitee@.example.com', 'invitee@example.com.'])(
    'preserves bounded legacy domain-dot acceptance for %s',
    async email => {
      directoryMock.createManagedInvitationForUser.mockResolvedValueOnce({
        invitation: { id: 'inv-compat', token: 'secret' },
      })

      await request(makeApp())
        .post('/external/members/invitations')
        .send({
          email,
          teams: [{ teamId: 'team-1', role: 'member' }],
        })
        .expect(201, { id: 'inv-compat' })

      expect(directoryMock.createManagedInvitationForUser).toHaveBeenCalledWith(
        'manager-1',
        email,
        [{ teamId: 'team-1', role: 'member' }],
        '',
        expect.objectContaining({ contract: 'v1', userId: 'manager-1' })
      )
    }
  )

  it('rejects non-string invitation email input before directory work', async () => {
    await request(makeApp())
      .post('/external/members/invitations')
      .send({
        email: { address: 'invitee@example.com' },
        teams: [{ teamId: 'team-1', role: 'member' }],
      })
      .expect(400, { error: 'invalid_email' })

    expect(directoryMock.createManagedInvitationForUser).not.toHaveBeenCalled()
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

    expect(directoryMock.deleteManagedUserForUser).toHaveBeenCalledWith(
      'manager-1',
      'target-1',
      {
        reason: 'manager retirement',
        idempotencyKey: 'external-delete-1',
        requestId: 'request-external-members',
      },
      expect.objectContaining({ contract: 'v1', userId: 'manager-1' })
    )
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
