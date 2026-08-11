import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
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

  it('forwards a governed member-retirement reason, replay key, and correlation id', async () => {
    authTokenMock.verifyToken.mockReturnValueOnce(claims)
    memberManagementMock.deleteManagedUser.mockResolvedValueOnce({ ok: true })

    await request(makeApp())
      .delete('/members/user-2')
      .set('authorization', 'Bearer good-token')
      .set('Idempotency-Key', 'retire-user-2-v1')
      .set('x-correlation-id', '11111111-1111-4111-8111-111111111111')
      .send({ reason: 'team access no longer required' })
      .expect(200, { ok: true })

    expect(memberManagementMock.deleteManagedUser).toHaveBeenCalledWith('user-2', 'good-token', {
      reason: 'team access no longer required',
      idempotencyKey: 'retire-user-2-v1',
      correlationId: '11111111-1111-4111-8111-111111111111',
    })
  })

  it.each([
    [{}, 'Retirement reason is required'],
    [{ reason: 'team access no longer required' }, 'Idempotency-Key header is required'],
  ])('rejects missing governed-retirement inputs', async (body, expectedError) => {
    authTokenMock.verifyToken.mockReturnValueOnce(claims)

    const requestBuilder = request(makeApp())
      .delete('/members/user-2')
      .set('authorization', 'Bearer good-token')
      .send(body)
    const response = await requestBuilder

    expect(response.status).toBe(400)
    expect(response.body).toEqual({ error: expectedError })
    expect(memberManagementMock.deleteManagedUser).not.toHaveBeenCalled()
  })
})
