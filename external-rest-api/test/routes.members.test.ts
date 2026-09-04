import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { ControlApiError } from '../src/controlApiClient.js'
import { createMembersRouter } from '../src/routes/members.js'

const authTokenMock = vi.hoisted(() => ({
  verifyToken: vi.fn(),
}))

const memberManagementMock = vi.hoisted(() => ({
  cancelManagedInvitation: vi.fn(),
  deleteManagedMember: vi.fn(),
  deleteManagedUser: vi.fn(),
  getManagedMember: vi.fn(),
  inviteManagedMember: vi.fn(),
  listManageableTeams: vi.fn(),
  listManagedInvitations: vi.fn(),
  listManagedMembers: vi.fn(),
  resendManagedInvitation: vi.fn(),
  updateManagedMemberRole: vi.fn(),
}))

vi.mock('../src/authToken.js', () => authTokenMock)
vi.mock('../src/services/memberManagementService.js', () => memberManagementMock)

const claims = {
  userId: 'user-1',
  email: 'user@example.com',
  teamId: 'team-1',
  role: 'admin' as const,
  exp: 9999999999,
}
const TARGET_USER_ID = '11111111-1111-4111-8111-111111111111'

function makeApp() {
  const app = express()
  app.set('trust proxy', 1)
  app.use(express.json())
  app.use(createMembersRouter())
  return app
}

describe('routes/members', () => {
  beforeEach(() => {
    authTokenMock.verifyToken.mockReset()
    Object.values(memberManagementMock).forEach(fn => fn.mockReset())
  })

  it('forwards invitee name to the managed invitation service', async () => {
    authTokenMock.verifyToken.mockReturnValueOnce(claims)
    memberManagementMock.inviteManagedMember.mockResolvedValueOnce({ id: 'inv-1' })

    await request(makeApp())
      .post('/members/invite')
      .set('authorization', 'Bearer good-token')
      .send({
        email: 'INVITEE@EXAMPLE.COM',
        name: '  Full Name  ',
        teams: [{ teamId: 'team-1', role: 'inviter' }],
      })
      .expect(201, { id: 'inv-1' })

    expect(memberManagementMock.inviteManagedMember).toHaveBeenCalledWith(
      'invitee@example.com',
      '  Full Name  ',
      [{ teamId: 'team-1', role: 'inviter' }],
      'good-token'
    )
  })

  it('forwards bounded invitation role candidates to the Control API authority unchanged', async () => {
    authTokenMock.verifyToken.mockReturnValueOnce(claims)
    memberManagementMock.inviteManagedMember.mockResolvedValueOnce({ id: 'inv-roles' })

    await request(makeApp())
      .post('/members/invite')
      .set('authorization', 'Bearer good-token')
      .send({
        email: 'invitee@example.com',
        teams: [
          { teamId: 'team-admin', role: 'admin' },
          { teamId: 'team-alias', role: 'leader' },
          { teamId: 'team-case', role: 'ADMIN' },
          { teamId: 'team-invalid', role: 'unexpected' },
          { teamId: 'team-default' },
        ],
      })
      .expect(201, { id: 'inv-roles' })

    expect(memberManagementMock.inviteManagedMember).toHaveBeenCalledWith(
      'invitee@example.com',
      undefined,
      [
        { teamId: 'team-admin', role: 'admin' },
        { teamId: 'team-alias', role: 'leader' },
        { teamId: 'team-case', role: 'ADMIN' },
        { teamId: 'team-invalid', role: 'unexpected' },
        { teamId: 'team-default' },
      ],
      'good-token'
    )
  })

  it('rejects raw invitation emails longer than 320 characters before Control API work', async () => {
    authTokenMock.verifyToken.mockReturnValueOnce(claims)
    const overlongEmail = `${'a'.repeat(315)}@a.com`

    await request(makeApp())
      .post('/members/invite')
      .set('authorization', 'Bearer good-token')
      .send({
        email: overlongEmail,
        teams: [{ teamId: 'team-1', role: 'member' }],
      })
      .expect(400, { error: 'Valid email is required' })

    expect(memberManagementMock.inviteManagedMember).not.toHaveBeenCalled()
  })

  it('rejects pathological overlong invitation email input before Control API work', async () => {
    authTokenMock.verifyToken.mockReturnValueOnce(claims)

    await request(makeApp())
      .post('/members/invite')
      .set('authorization', 'Bearer good-token')
      .send({
        email: `!@!${'!.'.repeat(200)}@`,
        teams: [{ teamId: 'team-1', role: 'member' }],
      })
      .expect(400, { error: 'Valid email is required' })

    expect(memberManagementMock.inviteManagedMember).not.toHaveBeenCalled()
  })

  it('rejects non-string invitation email input before Control API work', async () => {
    authTokenMock.verifyToken.mockReturnValueOnce(claims)

    await request(makeApp())
      .post('/members/invite')
      .set('authorization', 'Bearer good-token')
      .send({
        email: { address: 'invitee@example.com' },
        teams: [{ teamId: 'team-1', role: 'member' }],
      })
      .expect(400, { error: 'Valid email is required' })

    expect(memberManagementMock.inviteManagedMember).not.toHaveBeenCalled()
  })

  it('forwards bounded invalid email input to the authoritative Control API validator', async () => {
    authTokenMock.verifyToken.mockReturnValueOnce(claims)
    memberManagementMock.inviteManagedMember.mockRejectedValueOnce(
      new ControlApiError('invalid invitation email', 400, { error: 'invalid_email' })
    )

    await request(makeApp())
      .post('/members/invite')
      .set('authorization', 'Bearer good-token')
      .send({
        email: 'not-an-email',
        teams: [{ teamId: 'team-1', role: 'member' }],
      })
      .expect(400, { error: 'Valid email is required' })

    expect(memberManagementMock.inviteManagedMember).toHaveBeenCalledWith(
      'not-an-email',
      undefined,
      [{ teamId: 'team-1', role: 'member' }],
      'good-token'
    )
  })

  it('preserves invalid-email precedence when no valid team assignment is provided', async () => {
    authTokenMock.verifyToken.mockReturnValueOnce(claims)
    memberManagementMock.inviteManagedMember.mockRejectedValueOnce(
      new ControlApiError('invalid invitation email', 400, { error: 'invalid_email' })
    )

    await request(makeApp())
      .post('/members/invite')
      .set('authorization', 'Bearer good-token')
      .send({ email: 'not-an-email', teams: [] })
      .expect(400, { error: 'Valid email is required' })

    expect(memberManagementMock.inviteManagedMember).toHaveBeenCalledWith(
      'not-an-email',
      undefined,
      [],
      'good-token'
    )
  })

  it.each([
    ['an overlong name', { name: 'a'.repeat(121), teams: [] }],
    [
      'too many teams',
      {
        teams: Array.from({ length: 51 }, (_, index) => ({
          teamId: `team-${index}`,
          role: 'member',
        })),
      },
    ],
  ])('preserves invalid-email precedence with %s', async (_case, extraBody) => {
    authTokenMock.verifyToken.mockReturnValueOnce(claims)
    memberManagementMock.inviteManagedMember.mockRejectedValueOnce(
      new ControlApiError('invalid invitation email', 400, { error: 'invalid_email' })
    )

    await request(makeApp())
      .post('/members/invite')
      .set('authorization', 'Bearer good-token')
      .send({ email: 'not-an-email', ...extraBody })
      .expect(400, { error: 'Valid email is required' })

    expect(memberManagementMock.inviteManagedMember).toHaveBeenCalledOnce()
  })

  it('preserves the public assignment error after authoritative validation', async () => {
    authTokenMock.verifyToken.mockReturnValueOnce(claims)
    memberManagementMock.inviteManagedMember.mockRejectedValueOnce(
      new ControlApiError('invalid invitation payload', 400, { error: 'invalid_payload' })
    )

    await request(makeApp())
      .post('/members/invite')
      .set('authorization', 'Bearer good-token')
      .send({ email: 'invitee@example.com', teams: [] })
      .expect(400, { error: 'Email and at least one team are required' })

    expect(memberManagementMock.inviteManagedMember).toHaveBeenCalledWith(
      'invitee@example.com',
      undefined,
      [],
      'good-token'
    )
  })

  it('rejects overlong invitee names', async () => {
    authTokenMock.verifyToken.mockReturnValueOnce(claims)
    memberManagementMock.inviteManagedMember.mockRejectedValueOnce(
      new ControlApiError('invalid invitation name', 400, { error: 'invalid_name' })
    )

    await request(makeApp())
      .post('/members/invite')
      .set('authorization', 'Bearer good-token')
      .send({
        email: 'invitee@example.com',
        name: 'a'.repeat(121),
        teams: [{ teamId: 'team-1', role: 'member' }],
      })
      .expect(400, { error: 'Name is too long' })

    expect(memberManagementMock.inviteManagedMember).toHaveBeenCalledWith(
      'invitee@example.com',
      'a'.repeat(121),
      [{ teamId: 'team-1', role: 'member' }],
      'good-token'
    )
  })

  it('preserves a short name after trimming an overlong raw padded value', async () => {
    authTokenMock.verifyToken.mockReturnValueOnce(claims)
    memberManagementMock.inviteManagedMember.mockResolvedValueOnce({ id: 'inv-padded' })

    await request(makeApp())
      .post('/members/invite')
      .set('authorization', 'Bearer good-token')
      .send({
        email: 'invitee@example.com',
        name: `${' '.repeat(121)}Alice`,
        teams: [{ teamId: 'team-1', role: 'member' }],
      })
      .expect(201, { id: 'inv-padded' })

    expect(memberManagementMock.inviteManagedMember).toHaveBeenCalledWith(
      'invitee@example.com',
      `${' '.repeat(121)}Alice`,
      [{ teamId: 'team-1', role: 'member' }],
      'good-token'
    )
  })

  it('forwards the original overlength name instead of fabricating a sentinel', async () => {
    authTokenMock.verifyToken.mockReturnValueOnce(claims)
    memberManagementMock.inviteManagedMember.mockRejectedValueOnce(
      new ControlApiError('invalid invitation name', 400, { error: 'invalid_name' })
    )

    await request(makeApp())
      .post('/members/invite')
      .set('authorization', 'Bearer good-token')
      .send({
        email: 'invitee@example.com',
        name: `${' '.repeat(10)}${'a'.repeat(121)}`,
        teams: [{ teamId: 'team-1', role: 'member' }],
      })
      .expect(400, { error: 'Name is too long' })

    const [, forwardedName] = memberManagementMock.inviteManagedMember.mock.calls[0]
    expect(forwardedName).toBe(`${' '.repeat(10)}${'a'.repeat(121)}`)
  })

  it('preserves the public team-count error after authoritative validation', async () => {
    authTokenMock.verifyToken.mockReturnValueOnce(claims)
    memberManagementMock.inviteManagedMember.mockRejectedValueOnce(
      new ControlApiError('too many invitation teams', 400, { error: 'too_many_teams' })
    )

    await request(makeApp())
      .post('/members/invite')
      .set('authorization', 'Bearer good-token')
      .send({
        email: 'invitee@example.com',
        teams: Array.from({ length: 51 }, (_, index) => ({
          teamId: `team-${index}`,
          role: 'member',
        })),
      })
      .expect(400, { error: 'Too many teams selected' })

    const originalTeams = Array.from({ length: 51 }, (_, index) => ({
      teamId: `team-${index}`,
      role: 'member',
    }))
    expect(memberManagementMock.inviteManagedMember).toHaveBeenCalledWith(
      'invitee@example.com',
      undefined,
      originalTeams,
      'good-token'
    )
  })

  it('forwards a governed member-retirement reason, replay key, and correlation id', async () => {
    authTokenMock.verifyToken.mockReturnValueOnce(claims)
    memberManagementMock.deleteManagedUser.mockResolvedValueOnce({ ok: true })

    await request(makeApp())
      .delete(`/members/${TARGET_USER_ID}`)
      .set('authorization', 'Bearer good-token')
      .set('Idempotency-Key', 'retire-user-2-v1')
      .set('x-correlation-id', '11111111-1111-4111-8111-111111111111')
      .send({ reason: 'team access no longer required' })
      .expect(200, { ok: true })

    expect(memberManagementMock.deleteManagedUser).toHaveBeenCalledWith(
      TARGET_USER_ID,
      'good-token',
      {
        reason: 'team access no longer required',
        idempotencyKey: 'retire-user-2-v1',
        correlationId: '11111111-1111-4111-8111-111111111111',
      }
    )
  })

  it.each([
    [{}, 'Retirement reason is required'],
    [{ reason: 'team access no longer required' }, 'Idempotency-Key header is required'],
  ])(
    'rejects missing governed-retirement inputs before they reach Control API',
    async (body, expectedError) => {
      authTokenMock.verifyToken.mockReturnValueOnce(claims)

      const response = await request(makeApp())
        .delete(`/members/${TARGET_USER_ID}`)
        .set('authorization', 'Bearer good-token')
        .send(body)

      expect(response.status).toBe(400)
      expect(response.body).toEqual({ error: expectedError })
      expect(memberManagementMock.deleteManagedUser).not.toHaveBeenCalled()
    }
  )

  it('rate-limits retirement attempts by the verified subject despite changing user inputs', async () => {
    authTokenMock.verifyToken.mockReturnValue({ ...claims, userId: 'rate-limited-user' })
    memberManagementMock.deleteManagedUser.mockResolvedValue({ ok: true })

    for (let attempt = 1; attempt <= 30; attempt++) {
      await request(makeApp())
        .delete(`/members/${TARGET_USER_ID}`)
        .set('authorization', 'Bearer good-token')
        .set('x-forwarded-for', '198.51.100.10')
        .set('Idempotency-Key', `retire-attempt-${attempt}`)
        .send({ reason: `retirement attempt ${attempt}` })
        .expect(200)
    }

    await request(makeApp())
      .delete(`/members/${TARGET_USER_ID}`)
      .set('authorization', 'Bearer good-token')
      .set('x-forwarded-for', '198.51.100.10')
      .set('Idempotency-Key', 'retire-attempt-31')
      .set('x-correlation-id', '22222222-2222-4222-8222-222222222222')
      .send({ reason: 'changed reason cannot bypass the verified-actor bucket' })
      .expect(429)

    expect(memberManagementMock.deleteManagedUser).toHaveBeenCalledTimes(30)
  })

  it.each([
    ['reason', { reason: 'x'.repeat(513) }, { 'Idempotency-Key': 'valid-key' }],
    ['idempotency key', { reason: 'valid reason' }, { 'Idempotency-Key': 'x'.repeat(257) }],
  ])(
    'rejects an overlong retirement %s before it reaches Control API',
    async (_field, body, headers) => {
      authTokenMock.verifyToken.mockReturnValueOnce({ ...claims, userId: `bounded-${_field}` })

      const response = await request(makeApp())
        .delete(`/members/${TARGET_USER_ID}`)
        .set('authorization', 'Bearer good-token')
        .set(headers)
        .send(body)

      expect(response.status).toBe(400)
      expect(memberManagementMock.deleteManagedUser).not.toHaveBeenCalled()
    }
  )
})
