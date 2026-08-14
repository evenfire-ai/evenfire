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

function makeApp() {
  const app = express()
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
      'Full Name',
      [{ teamId: 'team-1', role: 'inviter' }],
      'good-token'
    )
  })

  it('preserves exact public invitation-role normalization before forwarding', async () => {
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
      '',
      [
        { teamId: 'team-admin', role: 'admin' },
        { teamId: 'team-default', role: 'member' },
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
      '',
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
      '',
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
      '',
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

    expect(memberManagementMock.inviteManagedMember).toHaveBeenCalledOnce()
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

    expect(memberManagementMock.inviteManagedMember).toHaveBeenCalledOnce()
  })
})
