import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { ControlApiError } from '../src/controlApiClient.js'
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
  setupInvitationPasswordWithToken: vi.fn(),
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
    app.set('trust proxy', 1)
    app.use(express.json())
    app.use(createInvitationsRouter())
    return app
  }

  it('sets invitation password by minting an invitation session from the link token', async () => {
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
      .send({
        token: 'invitation-link-token',
        email: 'invitee@example.com',
        invitationId: 'inv-1',
        password: 'user123!',
      })
      .expect(200)

    expect(res.body).toEqual({ id: 'inv-1', passwordUpdated: true })
    expect(String(res.headers['set-cookie'])).toContain('profile_session=invited-session-token')
    expect(String(res.headers['set-cookie'])).toContain('HttpOnly')
    expect(authTokenMock.verifyToken).not.toHaveBeenCalled()
    expect(invitationsServiceMock.acceptInvitation).toHaveBeenCalledWith(
      'invitation-link-token',
      'invitee@example.com'
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

  it('restores a password-reset session only after the password is updated', async () => {
    invitationsServiceMock.acceptInvitation.mockResolvedValue({
      data: {
        accepted: true,
        userId: 'user-1',
        email: 'invitee@example.com',
        teamId: null,
        teamName: null,
        role: 'member',
        token: 'Synthetic-pre-reset-session-token',
      },
    })
    invitationsServiceMock.setupInvitationPassword.mockResolvedValue({
      data: { id: 'inv-1', passwordUpdated: true },
    })
    invitationsServiceMock.getInvitationByToken.mockResolvedValue({
      id: 'inv-1',
      email: 'invitee@example.com',
      purpose: 'password_reset',
      status: 'pending',
    })
    invitationsServiceMock.setupInvitationPasswordWithToken.mockResolvedValue({
      data: {
        id: 'inv-1',
        email: 'invitee@example.com',
        purpose: 'password_reset',
        status: 'accepted',
        passwordUpdated: true,
        token: 'Synthetic-post-reset-session-token',
      },
    })

    const res = await request(makeApp())
      .post('/invitations/password')
      .send({
        token: 'Synthetic-verified-password-reset-link',
        email: 'invitee@example.com',
        invitationId: 'inv-1',
        password: 'Synthetic-new-password-123',
      })
      .expect(200)

    expect(res.body).toEqual({
      id: 'inv-1',
      email: 'invitee@example.com',
      purpose: 'password_reset',
      status: 'accepted',
      passwordUpdated: true,
    })
    expect(JSON.stringify(res.body)).not.toContain('Synthetic-post-reset-session-token')
    expect(String(res.headers['set-cookie'])).toContain(
      'profile_session=Synthetic-post-reset-session-token'
    )
    expect(String(res.headers['set-cookie'])).not.toContain('Synthetic-pre-reset-session-token')
    expect(invitationsServiceMock.acceptInvitation).not.toHaveBeenCalled()
    expect(invitationsServiceMock.setupInvitationPassword).not.toHaveBeenCalled()
    expect(invitationsServiceMock.setupInvitationPasswordWithToken).toHaveBeenCalledWith(
      'Synthetic-verified-password-reset-link',
      'invitee@example.com',
      'inv-1',
      'Synthetic-new-password-123'
    )
  })

  it('preserves only sanitized recovery saturation metadata', async () => {
    invitationsServiceMock.getInvitationByToken.mockResolvedValue({
      id: 'inv-1',
      email: 'invitee@example.com',
      purpose: 'password_reset',
      status: 'pending',
    })
    invitationsServiceMock.setupInvitationPasswordWithToken.mockRejectedValue(
      new ControlApiError(
        'internal authority detail with no public meaning',
        429,
        { error: 'rate_limited', retryAfterSeconds: 8 },
        { 'retry-after': '8' }
      )
    )

    const res = await request(makeApp())
      .post('/invitations/password')
      .send({
        token: 'Synthetic-verified-password-reset-link',
        email: 'invitee@example.com',
        invitationId: 'inv-1',
        password: 'Synthetic-new-password-123',
      })
      .expect(429)

    expect(res.body).toEqual({ error: 'rate_limited', retryAfterSeconds: 8 })
    expect(res.headers['retry-after']).toBe('8')
    expect(res.headers['x-ratelimit-limit']).toBeUndefined()
    expect(res.headers.ratelimit).toBeUndefined()
    expect(res.headers['set-cookie']).toBeUndefined()
  })

  it('returns a generic invalid-link response for rejected recovery proof', async () => {
    invitationsServiceMock.getInvitationByToken.mockResolvedValue({
      id: 'inv-1',
      email: 'invitee@example.com',
      purpose: 'password_reset',
      status: 'pending',
    })
    invitationsServiceMock.setupInvitationPasswordWithToken.mockResolvedValue({
      error: 'invalid_invitation',
    })

    const res = await request(makeApp())
      .post('/invitations/password')
      .send({
        token: 'Synthetic-invalid-recovery-proof',
        email: 'invitee@example.com',
        invitationId: 'inv-1',
        password: 'Synthetic-new-password-123',
      })
      .expect(400)

    expect(res.body).toEqual({ error: 'invalid_invitation' })
    expect(res.headers['set-cookie']).toBeUndefined()
  })

  it('does not expose preview lookup paths or recovery proofs when the signed link is invalid', async () => {
    invitationsServiceMock.getInvitationByToken.mockRejectedValue(
      new ControlApiError(
        'Control API GET /external/invitations/token/Synthetic-raw-proof failed (400)',
        400,
        { error: 'invalid_invitation' }
      )
    )

    const res = await request(makeApp())
      .post('/invitations/password')
      .send({
        token: 'Synthetic-raw-proof',
        email: 'invitee@example.com',
        invitationId: 'inv-1',
        password: 'Synthetic-new-password-123',
      })
      .expect(400)

    expect(res.body).toEqual({ error: 'invalid_invitation' })
    expect(JSON.stringify(res.body)).not.toContain('Synthetic-raw-proof')
    expect(JSON.stringify(res.body)).not.toContain('/external/invitations/token')
    expect(res.headers['set-cookie']).toBeUndefined()
    expect(invitationsServiceMock.setupInvitationPasswordWithToken).not.toHaveBeenCalled()
  })

  it('sanitizes rejected recovery proofs on the public invitation preview route', async () => {
    invitationsServiceMock.getInvitationByToken.mockRejectedValue(
      new ControlApiError(
        'Control API GET /external/invitations/token/Synthetic-raw-proof failed (400)',
        400,
        { error: 'invalid_invitation' }
      )
    )

    const res = await request(makeApp()).get('/invitations/token/Synthetic-raw-proof').expect(400)

    expect(res.body).toEqual({ error: 'invalid_invitation' })
    expect(JSON.stringify(res.body)).not.toContain('Synthetic-raw-proof')
    expect(JSON.stringify(res.body)).not.toContain('/external/invitations/token')
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

    const limited = await request(app)
      .post('/invitations/password')
      .set('x-forwarded-for', '198.51.100.10')
      .send({})
      .expect(429)

    expect(limited.headers['retry-after']).toMatch(/^\d+$/)
    expect(limited.headers['x-ratelimit-limit']).toBe('10')
    expect(limited.headers['x-ratelimit-remaining']).toBe('0')
  })
})
