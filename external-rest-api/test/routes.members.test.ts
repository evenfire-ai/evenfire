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

  it('rejects overlong invitee names', async () => {
    authTokenMock.verifyToken.mockReturnValueOnce(claims)

    await request(makeApp())
      .post('/members/invite')
      .set('authorization', 'Bearer good-token')
      .send({
        email: 'invitee@example.com',
        name: 'a'.repeat(121),
        teams: [{ teamId: 'team-1', role: 'member' }],
      })
      .expect(400, { error: 'Name is too long' })

    expect(memberManagementMock.inviteManagedMember).not.toHaveBeenCalled()
  })
})
