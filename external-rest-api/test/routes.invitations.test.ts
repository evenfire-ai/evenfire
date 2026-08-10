import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createInvitationsRouter } from '../src/routes/invitations.js'

const authTokenMock = vi.hoisted(() => ({
  verifyToken: vi.fn(),
}))

const invitationsServiceMock = vi.hoisted(() => ({
  acceptInvitation: vi.fn(),
  createDesktopAuthorization: vi.fn(),
  getInvitationByToken: vi.fn(),
  listPendingInvitations: vi.fn(),
  setupInvitationPassword: vi.fn(),
}))

vi.mock('../src/authToken.js', () => authTokenMock)
vi.mock('../src/services/invitationsService.js', () => invitationsServiceMock)

describe('routes/invitations', () => {
  beforeEach(() => {
    authTokenMock.verifyToken.mockReset()
    Object.values(invitationsServiceMock).forEach(fn => fn.mockReset())
  })

  function makeApp() {
    const app = express()
    app.use(express.json())
    app.use(createInvitationsRouter())
    return app
  }

  it('clears the revoked invitation session after setting the password', async () => {
    invitationsServiceMock.acceptInvitation.mockResolvedValue({
      data: {
        accepted: true,
        userId: 'user-1',
        email: 'invitee@example.com',
        teamId: null,
        teamName: null,
        role: 'member',
        token: 'invited-session-token',
      },
    })
    invitationsServiceMock.setupInvitationPassword.mockResolvedValue({
      data: { id: 'inv-1', passwordUpdated: true },
    })

    const res = await request(makeApp())
      .post('/invitations/password')
      .set('x-evenfire-session-contract', 'v2')
      .send({
        token: 'invitation-link-token',
        email: 'invitee@example.com',
        invitationId: 'inv-1',
        password: 'user123!',
      })
      .expect(200)

    expect(res.body).toEqual({
      id: 'inv-1',
      passwordUpdated: true,
      reauthenticationRequired: true,
    })
    expect(String(res.headers['set-cookie'])).toContain('profile_session=;')
    expect(String(res.headers['set-cookie'])).not.toContain('invited-session-token')
    expect(String(res.headers['set-cookie'])).toContain('HttpOnly')
    expect(authTokenMock.verifyToken).not.toHaveBeenCalled()
    expect(invitationsServiceMock.acceptInvitation).toHaveBeenCalledWith(
      'invitation-link-token',
      'invitee@example.com',
      'v2'
    )
    expect(invitationsServiceMock.setupInvitationPassword).toHaveBeenCalledWith(
      {
        userId: 'user-1',
        email: 'invitee@example.com',
        sessionToken: 'invited-session-token',
      },
      'inv-1',
      'user123!'
    )
  })

  it('falls back to invitation token flow when an old bearer token is invalid', async () => {
    authTokenMock.verifyToken.mockReturnValue(null)
    invitationsServiceMock.acceptInvitation.mockResolvedValue({
      data: {
        accepted: true,
        userId: 'user-1',
        email: 'invitee@example.com',
        teamId: null,
        teamName: null,
        role: 'member',
        token: 'fresh-session-token',
      },
    })
    invitationsServiceMock.setupInvitationPassword.mockResolvedValue({
      data: { id: 'inv-1', passwordUpdated: true },
    })

    await request(makeApp())
      .post('/invitations/password')
      .set('authorization', 'Bearer stale-token')
      .send({
        token: 'invitation-link-token',
        email: 'invitee@example.com',
        invitationId: 'inv-1',
        password: 'user123!',
      })
      .expect(200)

    expect(authTokenMock.verifyToken).toHaveBeenCalledWith('stale-token')
    expect(invitationsServiceMock.setupInvitationPassword).toHaveBeenCalledWith(
      expect.objectContaining({ sessionToken: 'fresh-session-token' }),
      'inv-1',
      'user123!'
    )
  })

  it('sets invitation password with a valid bearer token without accepting again', async () => {
    authTokenMock.verifyToken.mockReturnValue({
      userId: 'user-1',
      email: 'invitee@example.com',
      teamId: '',
      role: 'member',
      exp: 9999999999,
    })
    invitationsServiceMock.setupInvitationPassword.mockResolvedValue({
      data: { id: 'inv-1', passwordUpdated: true },
    })

    await request(makeApp())
      .post('/invitations/password')
      .set('authorization', 'Bearer fresh-session-token')
      .send({
        invitationId: 'inv-1',
        password: 'user123!',
      })
      .expect(200)

    expect(authTokenMock.verifyToken).toHaveBeenCalledWith('fresh-session-token')
    expect(invitationsServiceMock.acceptInvitation).not.toHaveBeenCalled()
    expect(invitationsServiceMock.setupInvitationPassword).toHaveBeenCalledWith(
      {
        userId: 'user-1',
        email: 'invitee@example.com',
        sessionToken: 'fresh-session-token',
      },
      'inv-1',
      'user123!'
    )
  })

  it('accepts invitations by setting a profile cookie without echoing the bearer token', async () => {
    invitationsServiceMock.acceptInvitation.mockResolvedValue({
      data: {
        accepted: true,
        userId: 'user-1',
        email: 'invitee@example.com',
        teamId: 'team-1',
        teamName: 'Team 1',
        role: 'member',
        token: 'accepted-session-token',
      },
    })

    const res = await request(makeApp())
      .post('/invitations/accept')
      .send({ token: 'invitation-link-token', email: 'invitee@example.com' })
      .expect(200)

    expect(res.body.token).toBeUndefined()
    expect(res.body).toMatchObject({
      accepted: true,
      userId: 'user-1',
      email: 'invitee@example.com',
    })
    expect(String(res.headers['set-cookie'])).toContain('profile_session=accepted-session-token')
    expect(String(res.headers['set-cookie'])).toContain('HttpOnly')
  })

  it('rejects password setup without a bearer token or invitation token identity', async () => {
    await request(makeApp())
      .post('/invitations/password')
      .send({
        invitationId: 'inv-1',
        password: 'user123!',
      })
      .expect(401)

    expect(invitationsServiceMock.acceptInvitation).not.toHaveBeenCalled()
    expect(invitationsServiceMock.setupInvitationPassword).not.toHaveBeenCalled()
  })

  it('rate limits repeated invitation password attempts', async () => {
    const app = makeApp()

    for (let i = 0; i < 10; i++) {
      await request(app)
        .post('/invitations/password')
        .set('x-forwarded-for', '198.51.100.10')
        .send({})
        .expect(400)
    }

    await request(app)
      .post('/invitations/password')
      .set('x-forwarded-for', '198.51.100.10')
      .send({})
      .expect(429)
  })
})
