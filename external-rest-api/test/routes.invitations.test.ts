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
vi.mock('../src/services/invitationPasswordService.js', () => ({
  setupInvitationPassword: invitationsServiceMock.setupInvitationPassword,
  setupInvitationPasswordWithToken: invitationsServiceMock.setupInvitationPasswordWithToken,
}))

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

  it('clears the revoked invitation session after setting the password', async () => {
    invitationsServiceMock.getInvitationByToken.mockResolvedValue({
      id: 'inv-1',
      email: 'invitee@example.com',
      purpose: 'member_invitation',
      status: 'pending',
    })
    invitationsServiceMock.acceptInvitation.mockResolvedValue({
      data: {
        userId: 'user-1',
        email: 'invitee@example.com',
        token: 'synthetic-invited-session-token',
      },
    })
    invitationsServiceMock.setupInvitationPassword.mockResolvedValue({
      data: { id: 'inv-1', passwordUpdated: true },
    })

    const res = await request(makeApp())
      .post('/invitations/password')
      .set('x-evenfire-session-contract', 'v2')
      .send({
        token: 'synthetic-invitation-link-token',
        email: 'invitee@example.com',
        invitationId: 'inv-1',
        password: 'synthetic-user123!',
      })
      .expect(200)

    expect(res.body).toEqual({
      id: 'inv-1',
      passwordUpdated: true,
      reauthenticationRequired: true,
    })
    expect(String(res.headers['set-cookie'])).toContain('profile_session=;')
    expect(String(res.headers['set-cookie'])).not.toContain('synthetic-invited-session-token')
    expect(String(res.headers['set-cookie'])).toContain('HttpOnly')
    expect(authTokenMock.verifyToken).not.toHaveBeenCalled()
    expect(invitationsServiceMock.getInvitationByToken).toHaveBeenCalledWith(
      'synthetic-invitation-link-token'
    )
    expect(invitationsServiceMock.acceptInvitation).toHaveBeenCalledWith(
      'synthetic-invitation-link-token',
      'invitee@example.com',
      'v2'
    )
    expect(invitationsServiceMock.setupInvitationPassword).toHaveBeenCalledWith(
      {
        userId: 'user-1',
        email: 'invitee@example.com',
        sessionToken: 'synthetic-invited-session-token',
      },
      'inv-1',
      'synthetic-user123!'
    )
    expect(invitationsServiceMock.setupInvitationPasswordWithToken).not.toHaveBeenCalled()
  })

  it('requires reauthentication after password reset and never restores a session', async () => {
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
        reauthenticationRequired: true,
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
      reauthenticationRequired: true,
    })
    expect(res.body).not.toHaveProperty('token')
    expect(String(res.headers['set-cookie'])).toContain('profile_session=;')
    expect(String(res.headers['set-cookie'])).toContain('HttpOnly')
    expect(invitationsServiceMock.acceptInvitation).not.toHaveBeenCalled()
    expect(invitationsServiceMock.setupInvitationPassword).not.toHaveBeenCalled()
    expect(invitationsServiceMock.setupInvitationPasswordWithToken).toHaveBeenCalledWith(
      'Synthetic-verified-password-reset-link',
      'invitee@example.com',
      'inv-1',
      'Synthetic-new-password-123'
    )
  })

  it('uses the additive reset route without preview or invitation acceptance', async () => {
    invitationsServiceMock.setupInvitationPasswordWithToken.mockResolvedValue({
      data: {
        id: 'reset-1',
        email: 'invitee@example.com',
        purpose: 'password_reset',
        status: 'accepted',
        passwordUpdated: true,
        reauthenticationRequired: true,
      },
    })

    const res = await request(makeApp())
      .post('/invitations/password-reset')
      .set('x-forwarded-for', '198.51.100.12')
      .send({
        token: 'Synthetic-reset-proof',
        email: 'Invitee@Example.com',
        invitationId: 'reset-1',
        password: 'Synthetic-new-password-123',
      })
      .expect(200)

    expect(res.body).toMatchObject({
      id: 'reset-1',
      passwordUpdated: true,
      reauthenticationRequired: true,
    })
    expect(res.body).not.toHaveProperty('token')
    expect(String(res.headers['set-cookie'])).toContain('profile_session=;')
    expect(invitationsServiceMock.getInvitationByToken).not.toHaveBeenCalled()
    expect(invitationsServiceMock.acceptInvitation).not.toHaveBeenCalled()
    expect(invitationsServiceMock.setupInvitationPassword).not.toHaveBeenCalled()
    expect(invitationsServiceMock.setupInvitationPasswordWithToken).toHaveBeenCalledWith(
      'Synthetic-reset-proof',
      'invitee@example.com',
      'reset-1',
      'Synthetic-new-password-123'
    )
  })

  it.each([
    {
      source: 'invalid_password',
      status: 400,
      code: 'invalid_password',
      message: 'Password must be between 8 and 256 characters',
    },
    {
      source: 'invalid_invitation',
      status: 400,
      code: 'invalid_invitation',
      message: 'This recovery link is invalid or expired',
    },
    {
      source: 'not_found',
      status: 404,
      code: 'not_found',
      message: 'Invitation not found',
    },
    {
      source: 'forbidden',
      status: 403,
      code: 'forbidden',
      message: 'Invitation is invalid or unavailable',
    },
    {
      source: 'not_accepted',
      status: 409,
      code: 'invitation_not_accepted',
      message: 'Invitation must be accepted before setting a password',
    },
    {
      source: 'not_pending',
      status: 409,
      code: 'invitation_not_pending',
      message: 'Invitation has already been used',
    },
    {
      source: 'expired',
      status: 410,
      code: 'expired',
      message: 'Invitation has expired',
    },
  ] as const)(
    'returns stable reset code and safe message for $source without a session cookie',
    async ({ source, status, code, message }) => {
      invitationsServiceMock.setupInvitationPasswordWithToken.mockResolvedValue({
        error: source,
      })

      const res = await request(makeApp())
        .post('/invitations/password-reset')
        .set(
          'x-forwarded-for',
          {
            invalid_password: '198.51.100.151',
            invalid_invitation: '198.51.100.152',
            not_found: '198.51.100.153',
            forbidden: '198.51.100.154',
            not_accepted: '198.51.100.155',
            not_pending: '198.51.100.156',
            expired: '198.51.100.157',
          }[source]
        )
        .send({
          token: 'Synthetic-reset-proof',
          email: 'invitee@example.com',
          invitationId: 'reset-1',
          password: 'Synthetic-new-password-123',
        })
        .expect(status)

      expect(res.body).toEqual({ error: code, message })
      expect(res.headers['set-cookie']).toBeUndefined()
    }
  )

  it('keeps legacy reset error responses unchanged for existing invitation clients', async () => {
    invitationsServiceMock.getInvitationByToken.mockResolvedValue({
      id: 'reset-1',
      email: 'invitee@example.com',
      purpose: 'password_reset',
      status: 'pending',
    })
    invitationsServiceMock.setupInvitationPasswordWithToken.mockResolvedValue({
      error: 'invalid_password',
    })

    const res = await request(makeApp())
      .post('/invitations/password')
      .set('x-forwarded-for', '198.51.100.199')
      .send({
        token: 'Synthetic-reset-proof',
        email: 'invitee@example.com',
        invitationId: 'reset-1',
        password: 'Synthetic-new-password-123',
      })
      .expect(400)

    expect(res.body).toEqual({ error: 'Password must be between 8 and 256 characters' })
    expect(res.headers['set-cookie']).toBeUndefined()
  })

  it('uses non-enumerating wording when a reset row does not match the verified link', async () => {
    invitationsServiceMock.getInvitationByToken.mockResolvedValue({
      id: 'current-reset-row',
      email: 'invitee@example.com',
      purpose: 'password_reset',
      status: 'pending',
    })
    invitationsServiceMock.setupInvitationPasswordWithToken.mockResolvedValue({
      error: 'forbidden',
    })

    const res = await request(makeApp())
      .post('/invitations/password')
      .send({
        token: 'Synthetic-verified-password-reset-link',
        email: 'invitee@example.com',
        invitationId: 'stale-reset-row',
        password: 'Synthetic-new-password-123',
      })
      .expect(403)

    expect(res.body).toEqual({ error: 'Invitation is invalid or unavailable' })
    expect(JSON.stringify(res.body)).not.toContain('invitee@example.com')
    expect(res.headers['set-cookie']).toBeUndefined()
    expect(invitationsServiceMock.setupInvitationPasswordWithToken).toHaveBeenCalledWith(
      'Synthetic-verified-password-reset-link',
      'invitee@example.com',
      'stale-reset-row',
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

  it.each([
    ['bearer header', 'authorization', 'Bearer synthetic-stale-token'],
    ['profile session cookie', 'cookie', 'profile_session=synthetic-stale-token'],
  ])(
    'fails closed with 401 when an invalid %s is presented alongside an invitation link',
    async (_source, header, value) => {
      authTokenMock.verifyToken.mockReturnValue(null)
      invitationsServiceMock.getInvitationByToken.mockResolvedValue({
        id: 'inv-1',
        email: 'invitee@example.com',
        purpose: 'member_invitation',
        status: 'pending',
      })
      // The invitation-link path would succeed if it were reached.
      invitationsServiceMock.acceptInvitation.mockResolvedValue({
        data: {
          userId: 'user-1',
          email: 'invitee@example.com',
          token: 'synthetic-invited-session-token',
        },
      })
      invitationsServiceMock.setupInvitationPassword.mockResolvedValue({
        data: { id: 'inv-1', passwordUpdated: true },
      })

      const res = await request(makeApp())
        .post('/invitations/password')
        // Own rate-limit bucket: the module-level limiter is shared across this file.
        .set('x-forwarded-for', '203.0.113.20')
        .set(header, value)
        .send({
          token: 'synthetic-invitation-link-token',
          email: 'invitee@example.com',
          invitationId: 'inv-1',
          password: 'synthetic-user123!',
        })
        .expect(401)

      expect(res.body).toEqual({ error: 'Unauthorized' })
      // Liveness: the presented credential was verified and rejected.
      expect(authTokenMock.verifyToken).toHaveBeenCalledWith('synthetic-stale-token')
      expect(invitationsServiceMock.getInvitationByToken).toHaveBeenCalledWith(
        'synthetic-invitation-link-token'
      )
      expect(invitationsServiceMock.acceptInvitation).not.toHaveBeenCalled()
      expect(invitationsServiceMock.setupInvitationPassword).not.toHaveBeenCalled()
      expect(invitationsServiceMock.setupInvitationPasswordWithToken).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['an empty bearer header', '203.0.113.31', { authorization: 'Bearer ' }],
    ['an empty authorization header', '203.0.113.32', { authorization: '' }],
    ['a non-bearer authorization header', '203.0.113.33', { authorization: 'Basic dXNlcjpwdw==' }],
    ['a malformed authorization header', '203.0.113.34', { authorization: 'garbage' }],
    ['an empty profile session cookie', '203.0.113.35', { cookie: 'profile_session=' }],
    [
      'a non-bearer authorization header next to a session cookie',
      '203.0.113.36',
      { authorization: 'Basic dXNlcjpwdw==', cookie: 'profile_session=synthetic-cookie-session' },
    ],
  ])(
    'fails closed with 401 for %s presented alongside an invitation link',
    async (_case, ip, headers: Record<string, string>) => {
      // The verifier accepts any token it is given, so a 401 here can only come
      // from the presented credential being empty or malformed.
      authTokenMock.verifyToken.mockReturnValue({
        userId: 'user-1',
        email: 'invitee@example.com',
        teamId: '',
        role: 'member',
        exp: 9999999999,
      })
      invitationsServiceMock.getInvitationByToken.mockResolvedValue({
        id: 'inv-1',
        email: 'invitee@example.com',
        purpose: 'member_invitation',
        status: 'pending',
      })
      // The invitation-link path would succeed if it were reached.
      invitationsServiceMock.acceptInvitation.mockResolvedValue({
        data: {
          userId: 'user-1',
          email: 'invitee@example.com',
          token: 'synthetic-invited-session-token',
        },
      })
      invitationsServiceMock.setupInvitationPassword.mockResolvedValue({
        data: { id: 'inv-1', passwordUpdated: true },
      })

      let pending = request(makeApp()).post('/invitations/password').set('x-forwarded-for', ip)
      for (const [name, value] of Object.entries(headers)) pending = pending.set(name, value)
      const res = await pending
        .send({
          token: 'synthetic-invitation-link-token',
          email: 'invitee@example.com',
          invitationId: 'inv-1',
          password: 'synthetic-user123!',
        })
        .expect(401)

      expect(res.body).toEqual({ error: 'Unauthorized' })
      // Liveness: the route reached the credential decision.
      expect(invitationsServiceMock.getInvitationByToken).toHaveBeenCalledWith(
        'synthetic-invitation-link-token'
      )
      expect(authTokenMock.verifyToken).not.toHaveBeenCalled()
      expect(invitationsServiceMock.acceptInvitation).not.toHaveBeenCalled()
      expect(invitationsServiceMock.setupInvitationPassword).not.toHaveBeenCalled()
      expect(invitationsServiceMock.setupInvitationPasswordWithToken).not.toHaveBeenCalled()
    }
  )

  it('uses the bearer header over a session cookie when both are presented', async () => {
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
      .set('x-forwarded-for', '203.0.113.37')
      .set('authorization', 'Bearer fresh-session-token')
      .set('cookie', 'profile_session=synthetic-cookie-session')
      .send({ invitationId: 'inv-1', password: 'synthetic-user123!' })
      .expect(200)

    expect(authTokenMock.verifyToken).toHaveBeenCalledTimes(1)
    expect(authTokenMock.verifyToken).toHaveBeenCalledWith('fresh-session-token')
    expect(invitationsServiceMock.acceptInvitation).not.toHaveBeenCalled()
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
        password: 'synthetic-user123!',
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
      'synthetic-user123!'
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
      .send({ token: 'synthetic-invitation-link-token', email: 'invitee@example.com' })
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

  it('accepts a replay without publishing a profile session', async () => {
    invitationsServiceMock.acceptInvitation
      .mockResolvedValueOnce({
        data: {
          accepted: true,
          userId: 'user-1',
          email: 'invitee@example.com',
          teamId: 'team-1',
          teamName: 'Team 1',
          role: 'member',
          token: 'synthetic-first-session-token',
        },
      })
      .mockResolvedValueOnce({
        data: {
          accepted: true,
          userId: 'user-1',
          email: 'invitee@example.com',
          teamId: 'team-1',
          teamName: 'Team 1',
          role: 'member',
          replay: true,
        },
      })

    const first = await request(makeApp())
      .post('/invitations/accept')
      .set('x-forwarded-for', '198.51.100.201')
      .send({ token: 'synthetic-invitation-link-token', email: 'invitee@example.com' })
      .expect(200)
    const replay = await request(makeApp())
      .post('/invitations/accept')
      .set('x-forwarded-for', '198.51.100.202')
      .send({ token: 'synthetic-invitation-link-token', email: 'invitee@example.com' })
      .expect(200)

    // Positive control: the first acceptance still publishes the session.
    expect(String(first.headers['set-cookie'])).toContain(
      'profile_session=synthetic-first-session-token'
    )
    expect(first.body).not.toHaveProperty('replay')
    expect(replay.body).toMatchObject({
      accepted: true,
      userId: 'user-1',
      email: 'invitee@example.com',
      replay: true,
    })
    expect(replay.body).not.toHaveProperty('token')
    expect(replay.headers['set-cookie']).toBeUndefined()
    expect(invitationsServiceMock.acceptInvitation).toHaveBeenCalledTimes(2)
  })

  it('refuses password setup for a replayed accepted invitation and reaches the password call for a pending one', async () => {
    invitationsServiceMock.getInvitationByToken.mockResolvedValue({
      id: 'inv-1',
      email: 'invitee@example.com',
      purpose: 'member_invitation',
      status: 'accepted',
    })
    invitationsServiceMock.acceptInvitation
      .mockResolvedValueOnce({
        data: {
          accepted: true,
          userId: 'user-1',
          email: 'invitee@example.com',
          teamId: null,
          teamName: null,
          role: 'member',
          replay: true,
        },
      })
      .mockResolvedValueOnce({
        data: {
          accepted: true,
          userId: 'user-1',
          email: 'invitee@example.com',
          teamId: null,
          teamName: null,
          role: 'member',
          token: 'synthetic-invited-session-token',
        },
      })
    invitationsServiceMock.setupInvitationPassword.mockResolvedValue({
      data: { id: 'inv-1', passwordUpdated: true },
    })

    const replayed = await request(makeApp())
      .post('/invitations/password')
      .set('x-forwarded-for', '198.51.100.203')
      .send({
        token: 'synthetic-accepted-invitation-link',
        email: 'invitee@example.com',
        invitationId: 'inv-1',
        password: 'synthetic-user123!',
      })
      .expect(400)

    // `error` is unchanged and `code` is the stable machine signal stream A can
    // match without parsing the human message.
    expect(replayed.body).toEqual({
      error: 'Invitation is not pending',
      code: 'invitation_not_pending',
    })
    expect(replayed.headers['set-cookie']).toBeUndefined()
    expect(invitationsServiceMock.setupInvitationPassword).not.toHaveBeenCalled()
    expect(invitationsServiceMock.setupInvitationPasswordWithToken).not.toHaveBeenCalled()

    // Positive control: the same request for a pending invitation receives a
    // session, reaches the password change and clears the replaced cookie.
    const pending = await request(makeApp())
      .post('/invitations/password')
      .set('x-forwarded-for', '198.51.100.204')
      .send({
        token: 'synthetic-pending-invitation-link',
        email: 'invitee@example.com',
        invitationId: 'inv-1',
        password: 'synthetic-user123!',
      })
      .expect(200)

    expect(invitationsServiceMock.setupInvitationPassword).toHaveBeenCalledWith(
      {
        userId: 'user-1',
        email: 'invitee@example.com',
        sessionToken: 'synthetic-invited-session-token',
      },
      'inv-1',
      'synthetic-user123!'
    )
    expect(String(pending.headers['set-cookie'])).toContain('profile_session=;')
    expect(invitationsServiceMock.acceptInvitation).toHaveBeenCalledTimes(2)
  })

  it('refuses an invalid password before the sessionless fallback consumes a pending invitation', async () => {
    const state = { invitation: 'pending' as 'pending' | 'accepted', acceptCalls: 0 }
    invitationsServiceMock.getInvitationByToken.mockImplementation(async () => ({
      id: 'inv-1',
      email: 'invitee@example.com',
      purpose: 'member_invitation',
      status: state.invitation,
    }))
    invitationsServiceMock.acceptInvitation.mockImplementation(async () => {
      state.acceptCalls += 1
      if (state.invitation === 'accepted') {
        return {
          data: {
            accepted: true,
            userId: 'user-1',
            email: 'invitee@example.com',
            replay: true,
          },
        }
      }
      // Model the producer's one-time transition: only this call consumes it.
      state.invitation = 'accepted'
      return {
        data: {
          accepted: true,
          userId: 'user-1',
          email: 'invitee@example.com',
          token: 'synthetic-invited-session-token',
        },
      }
    })
    invitationsServiceMock.setupInvitationPassword.mockResolvedValue({
      data: { id: 'inv-1', passwordUpdated: true },
    })

    const invalidPasswords = ['short', '        ', 'x'.repeat(257)]
    for (const [index, password] of invalidPasswords.entries()) {
      const rejected = await request(makeApp())
        .post('/invitations/password')
        .set('x-forwarded-for', `198.51.100.${210 + index}`)
        .send({
          token: 'synthetic-pending-invitation-link',
          email: 'invitee@example.com',
          invitationId: 'inv-1',
          password,
        })
        .expect(400)
      expect(rejected.body).toEqual({
        error: 'Password must be between 8 and 256 characters',
      })
      expect(rejected.headers['set-cookie']).toBeUndefined()
      // Read the modeled producer state back: each refusal left it pending.
      expect(state.invitation).toBe('pending')
    }
    expect(invitationsServiceMock.acceptInvitation).not.toHaveBeenCalled()
    expect(invitationsServiceMock.setupInvitationPassword).not.toHaveBeenCalled()

    // Liveness: a valid retry still consumes the invitation and succeeds. Its
    // cleared profile cookie is the positive witness for the invalid requests'
    // no-cookie assertions above.
    const accepted = await request(makeApp())
      .post('/invitations/password')
      .set('x-forwarded-for', '198.51.100.220')
      .send({
        token: 'synthetic-pending-invitation-link',
        email: 'invitee@example.com',
        invitationId: 'inv-1',
        password: 'synthetic-user123!',
      })
      .expect(200)
    expect(String(accepted.headers['set-cookie'])).toContain('profile_session=;')
    expect(String(accepted.headers['set-cookie'])).toContain('HttpOnly')
    expect(state.invitation).toBe('accepted')
    expect(state.acceptCalls).toBe(1)
    expect(invitationsServiceMock.setupInvitationPassword).toHaveBeenCalledWith(
      {
        userId: 'user-1',
        email: 'invitee@example.com',
        sessionToken: 'synthetic-invited-session-token',
      },
      'inv-1',
      'synthetic-user123!'
    )

    // The consumed state is real: the same fallback now receives the replay
    // refusal instead of a second password write.
    const replayed = await request(makeApp())
      .post('/invitations/password')
      .set('x-forwarded-for', '198.51.100.221')
      .send({
        token: 'synthetic-pending-invitation-link',
        email: 'invitee@example.com',
        invitationId: 'inv-1',
        password: 'synthetic-user123!',
      })
      .expect(400)
    expect(replayed.body).toEqual({
      error: 'Invitation is not pending',
      code: 'invitation_not_pending',
    })
    expect(state.acceptCalls).toBe(2)
    expect(invitationsServiceMock.setupInvitationPassword).toHaveBeenCalledTimes(1)
  })

  it('keeps the invited-session 502 when a non-replay acceptance has no token', async () => {
    invitationsServiceMock.getInvitationByToken.mockResolvedValue({
      id: 'inv-1',
      email: 'invitee@example.com',
      purpose: 'member_invitation',
      status: 'pending',
    })
    const acceptedWithoutSession = {
      data: {
        accepted: true,
        userId: 'user-1',
        email: 'invitee@example.com',
        teamId: null,
        teamName: null,
        role: 'member',
      },
    }
    invitationsServiceMock.acceptInvitation
      .mockResolvedValueOnce(acceptedWithoutSession)
      .mockResolvedValueOnce({
        data: { ...acceptedWithoutSession.data, token: 'synthetic-invited-session-token' },
      })
    invitationsServiceMock.setupInvitationPassword.mockResolvedValue({
      data: { id: 'inv-1', passwordUpdated: true },
    })

    const broken = await request(makeApp())
      .post('/invitations/password')
      .set('x-forwarded-for', '198.51.100.205')
      .send({
        token: 'synthetic-pending-invitation-link',
        email: 'invitee@example.com',
        invitationId: 'inv-1',
        password: 'synthetic-user123!',
      })
      .expect(502)

    expect(broken.body).toEqual({ error: 'Failed to start invited session' })
    expect(broken.headers['set-cookie']).toBeUndefined()
    expect(invitationsServiceMock.setupInvitationPassword).not.toHaveBeenCalled()

    // Positive witness: the same branch succeeds once the non-replay response
    // carries the invited session.
    await request(makeApp())
      .post('/invitations/password')
      .set('x-forwarded-for', '198.51.100.206')
      .send({
        token: 'synthetic-pending-invitation-link',
        email: 'invitee@example.com',
        invitationId: 'inv-1',
        password: 'synthetic-user123!',
      })
      .expect(200)
    expect(invitationsServiceMock.setupInvitationPassword).toHaveBeenCalledTimes(1)
    expect(invitationsServiceMock.acceptInvitation).toHaveBeenCalledTimes(2)
  })

  it('rejects password setup without a bearer token or invitation token identity', async () => {
    await request(makeApp())
      .post('/invitations/password')
      .send({
        invitationId: 'inv-1',
        password: 'synthetic-user123!',
      })
      .expect(401)

    expect(invitationsServiceMock.acceptInvitation).not.toHaveBeenCalled()
    expect(invitationsServiceMock.setupInvitationPassword).not.toHaveBeenCalled()
    expect(invitationsServiceMock.setupInvitationPasswordWithToken).not.toHaveBeenCalled()
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
      .post('/invitations/password-reset')
      .set('x-forwarded-for', '198.51.100.10')
      .send({})
      .expect(429)

    expect(limited.headers['retry-after']).toMatch(/^\d+$/)
    expect(limited.headers['x-ratelimit-limit']).toBe('10')
    expect(limited.headers['x-ratelimit-remaining']).toBe('0')
  })
})
