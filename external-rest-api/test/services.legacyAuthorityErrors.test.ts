import { beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { ControlApiError } from '../src/controlApiClient.js'
import { createDesktopAuthorization } from '../src/services/invitationsService.js'
import { getMe, switchTeam } from '../src/services/meService.js'
import {
  deleteMember,
  getCurrentTeam,
  renameTeam,
  updateMemberRole,
} from '../src/services/teamService.js'

const clientMock = vi.hoisted(() => ({ controlApiRequest: vi.fn() }))
vi.mock('../src/controlApiClient.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/controlApiClient.js')>()
  return { ...actual, controlApiRequest: clientMock.controlApiRequest }
})

const authTokenMock = vi.hoisted(() => ({ verifyToken: vi.fn() }))
vi.mock('../src/authToken.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/authToken.js')>()
  return { ...actual, verifyToken: authTokenMock.verifyToken }
})

const auth = {
  userId: 'user-1',
  email: 'user@example.com',
  teamId: 'team-1',
  role: 'admin' as const,
  sessionToken: 'session-token',
}

function upstream(status: number): ControlApiError {
  return new ControlApiError('control api failure', status, {
    error: status === 503 ? 'authority_unavailable' : 'not_found',
  })
}

// The body control-api sends with every bare 401: requireValidExternalSessionToken for a
// missing or ended session (control-api/src/middleware/externalSessionAuth.ts) and
// its service-credential guard (control-api/src/middleware/internalServiceAuth.ts) when it
// refuses this edge's credential. The two cannot be told apart.
const BARE_UNAUTHORIZED_BODY = { error: 'Unauthorized' }
const BARE_UNAUTHORIZED_REJECTION = { status: 401, body: BARE_UNAUTHORIZED_BODY }

function bareUnauthorized(): ControlApiError {
  return new ControlApiError('control api failure', 401, BARE_UNAUTHORIZED_BODY)
}

describe('legacy authority adapters', () => {
  beforeEach(() => {
    clientMock.controlApiRequest.mockReset()
    authTokenMock.verifyToken.mockReset()
  })

  it('maps every other /me and switch-team failure to absence, keeping outages, /me revocation and the switch-team bare 401', async () => {
    for (const status of [404, 500]) {
      clientMock.controlApiRequest.mockRejectedValueOnce(upstream(status))
      await expect(getMe(auth.userId, auth.teamId, auth.sessionToken)).resolves.toBeNull()

      clientMock.controlApiRequest.mockRejectedValueOnce(upstream(status))
      await expect(
        switchTeam(auth.userId, auth.email, 'team-2', auth.sessionToken)
      ).resolves.toBeNull()
    }
    // Witness: each getMe and switchTeam case reached control-api once.
    expect(clientMock.controlApiRequest).toHaveBeenCalledTimes(4)
    expect(
      clientMock.controlApiRequest.mock.calls.filter(
        ([method, path]) => method === 'GET' && path === `/external/users/${auth.userId}/me`
      )
    ).toHaveLength(2)

    // /me: a bare 401 is no verdict on the session (it may be this edge's refused
    // credential), so it reads as absence.
    clientMock.controlApiRequest.mockRejectedValueOnce(bareUnauthorized())
    await expect(getMe(auth.userId, auth.teamId, auth.sessionToken)).resolves.toBeNull()

    // switch-team: control-api's membership read answers an ended session with the bare
    // 401; it is relayed, never read as "not a member".
    clientMock.controlApiRequest.mockRejectedValueOnce(bareUnauthorized())
    await expect(
      switchTeam(auth.userId, auth.email, 'team-2', auth.sessionToken)
    ).rejects.toMatchObject(BARE_UNAUTHORIZED_REJECTION)

    clientMock.controlApiRequest.mockRejectedValueOnce(
      new ControlApiError('control api failure', 401, {
        error: { code: 'invalid_session', message: 'The session is not valid.', retryable: false },
      })
    )
    await expect(getMe(auth.userId, auth.teamId, auth.sessionToken)).rejects.toMatchObject({
      status: 401,
      body: { error: { code: 'invalid_session' } },
    })

    clientMock.controlApiRequest.mockRejectedValueOnce(upstream(503))
    await expect(getMe(auth.userId, auth.teamId, auth.sessionToken)).rejects.toMatchObject({
      status: 503,
    })

    clientMock.controlApiRequest.mockRejectedValueOnce(upstream(503))
    await expect(
      switchTeam(auth.userId, auth.email, 'team-2', auth.sessionToken)
    ).rejects.toMatchObject({ status: 503 })

    expect(clientMock.controlApiRequest).toHaveBeenCalledTimes(9)
  })

  it('keeps the current-team bare 401 and outages, and maps every other failure to no team', async () => {
    for (const status of [403, 404, 500]) {
      clientMock.controlApiRequest.mockRejectedValueOnce(upstream(status))
      await expect(getCurrentTeam(auth)).resolves.toBeNull()
    }

    clientMock.controlApiRequest.mockRejectedValueOnce(bareUnauthorized())
    await expect(getCurrentTeam(auth)).rejects.toMatchObject(BARE_UNAUTHORIZED_REJECTION)

    clientMock.controlApiRequest.mockRejectedValueOnce(upstream(503))
    await expect(getCurrentTeam(auth)).rejects.toMatchObject({ status: 503 })

    expect(clientMock.controlApiRequest).toHaveBeenCalledTimes(5)
  })

  it('keeps the rename bare 401, live demotion and outages, and maps the rest to not_found', async () => {
    clientMock.controlApiRequest.mockRejectedValueOnce(bareUnauthorized())
    await expect(renameTeam(auth, 'Renamed')).rejects.toMatchObject(BARE_UNAUTHORIZED_REJECTION)

    clientMock.controlApiRequest.mockRejectedValueOnce(upstream(403))
    await expect(renameTeam(auth, 'Renamed')).resolves.toEqual({ error: 'forbidden' })

    for (const status of [404, 500]) {
      clientMock.controlApiRequest.mockRejectedValueOnce(upstream(status))
      await expect(renameTeam(auth, 'Renamed')).resolves.toEqual({ error: 'not_found' })
    }

    clientMock.controlApiRequest.mockRejectedValueOnce(upstream(503))
    await expect(renameTeam(auth, 'Renamed')).rejects.toMatchObject({ status: 503 })

    expect(clientMock.controlApiRequest).toHaveBeenCalledTimes(5)
  })

  it('keeps the member-read bare 401, live demotion and outages, and maps the rest to not_found', async () => {
    clientMock.controlApiRequest.mockRejectedValueOnce(bareUnauthorized())
    await expect(updateMemberRole(auth, 'user-2', 'member')).rejects.toMatchObject(
      BARE_UNAUTHORIZED_REJECTION
    )

    clientMock.controlApiRequest.mockRejectedValueOnce(upstream(403))
    await expect(updateMemberRole(auth, 'user-2', 'member')).resolves.toEqual({
      error: 'forbidden',
    })

    for (const status of [404, 500]) {
      clientMock.controlApiRequest.mockRejectedValueOnce(upstream(status))
      await expect(updateMemberRole(auth, 'user-2', 'member')).resolves.toEqual({
        error: 'not_found',
      })
    }

    clientMock.controlApiRequest.mockRejectedValueOnce(upstream(503))
    await expect(updateMemberRole(auth, 'user-2', 'member')).rejects.toMatchObject({
      status: 503,
    })

    // Every case stops at the existence read: the PATCH is never sent.
    expect(clientMock.controlApiRequest).toHaveBeenCalledTimes(5)
    for (const [method] of clientMock.controlApiRequest.mock.calls) expect(method).toBe('GET')
  })

  it('keeps the member-delete bare 401, live demotion and outages, and maps the rest to not_found', async () => {
    clientMock.controlApiRequest.mockRejectedValueOnce(bareUnauthorized())
    await expect(deleteMember(auth, 'user-2')).rejects.toMatchObject(BARE_UNAUTHORIZED_REJECTION)

    clientMock.controlApiRequest.mockRejectedValueOnce(upstream(403))
    await expect(deleteMember(auth, 'user-2')).resolves.toEqual({ error: 'forbidden' })

    for (const status of [404, 500]) {
      clientMock.controlApiRequest.mockRejectedValueOnce(upstream(status))
      await expect(deleteMember(auth, 'user-2')).resolves.toEqual({ error: 'not_found' })
    }

    clientMock.controlApiRequest.mockRejectedValueOnce(upstream(503))
    await expect(deleteMember(auth, 'user-2')).rejects.toMatchObject({ status: 503 })

    expect(clientMock.controlApiRequest).toHaveBeenCalledTimes(5)
  })

  it("relays control-api's bare 401 from GET /api/v1/team instead of answering no team", async () => {
    authTokenMock.verifyToken.mockReturnValue({ ...auth, exp: 9999999999 })
    clientMock.controlApiRequest.mockRejectedValueOnce(bareUnauthorized())

    const response = await request(createApp())
      .get('/api/v1/team')
      .set('authorization', 'Bearer synthetic-session-token')
    expect(response.status).toBe(401)
    expect(response.body).toEqual(BARE_UNAUTHORIZED_BODY)

    // Witness: the request reached the current-team read with the caller's session.
    expect(clientMock.controlApiRequest).toHaveBeenCalledTimes(1)
    expect(clientMock.controlApiRequest).toHaveBeenCalledWith(
      'GET',
      `/external/teams/${auth.teamId}/users/${auth.userId}/current`,
      { userSessionToken: 'synthetic-session-token' }
    )
  })

  it("relays control-api's bare 401 from the switch-team membership read instead of 'not a member'", async () => {
    authTokenMock.verifyToken.mockReturnValue({ ...auth, exp: 9999999999 })
    clientMock.controlApiRequest.mockRejectedValueOnce(bareUnauthorized())

    const response = await request(createApp())
      .post('/api/v1/me/switch-team')
      .set('authorization', 'Bearer synthetic-session-token')
      .send({ teamId: 'team-2' })
    expect(response.status).toBe(401)
    expect(response.body).toEqual(BARE_UNAUTHORIZED_BODY)

    // Witness: exactly one control-api call, the membership read with the caller's
    // session. The count also proves no /external/auth/session-token call was made.
    expect(clientMock.controlApiRequest).toHaveBeenCalledTimes(1)
    expect(clientMock.controlApiRequest).toHaveBeenCalledWith(
      'GET',
      `/external/users/${auth.userId}/memberships/team-2`,
      { userSessionToken: 'synthetic-session-token' }
    )
  })

  it("still answers 'not a member' when control-api's membership read says not_found", async () => {
    authTokenMock.verifyToken.mockReturnValue({ ...auth, exp: 9999999999 })
    // control-api/src/routes/external/users.ts:222
    clientMock.controlApiRequest.mockRejectedValueOnce(
      new ControlApiError('control api failure', 404, { error: 'not_found' })
    )

    const response = await request(createApp())
      .post('/api/v1/me/switch-team')
      .set('authorization', 'Bearer synthetic-session-token')
      .send({ teamId: 'team-2' })
    expect(response.status).toBe(403)
    expect(response.body).toEqual({ error: 'You are not a member of this team' })

    expect(clientMock.controlApiRequest).toHaveBeenCalledTimes(1)
    expect(clientMock.controlApiRequest).toHaveBeenCalledWith(
      'GET',
      `/external/users/${auth.userId}/memberships/team-2`,
      { userSessionToken: 'synthetic-session-token' }
    )
  })

  const teamMutationRoutes = [
    {
      name: 'PUT /api/v1/team/name',
      send: (app: ReturnType<typeof createApp>) =>
        request(app)
          .put('/api/v1/team/name')
          .set('authorization', 'Bearer synthetic-session-token')
          .send({ name: 'Renamed' }),
      call: [
        'PUT',
        `/external/teams/${auth.teamId}/name`,
        { body: { name: 'Renamed' }, userSessionToken: 'synthetic-session-token' },
      ],
    },
    {
      name: 'PATCH /api/v1/team/members/:userId/role',
      send: (app: ReturnType<typeof createApp>) =>
        request(app)
          .patch('/api/v1/team/members/user-2/role')
          .set('authorization', 'Bearer synthetic-session-token')
          .send({ role: 'member' }),
      call: [
        'GET',
        `/external/teams/${auth.teamId}/members/user-2/role`,
        { userSessionToken: 'synthetic-session-token' },
      ],
    },
    {
      name: 'DELETE /api/v1/team/members/:userId',
      send: (app: ReturnType<typeof createApp>) =>
        request(app)
          .delete('/api/v1/team/members/user-2')
          .set('authorization', 'Bearer synthetic-session-token'),
      call: [
        'DELETE',
        `/external/teams/${auth.teamId}/members/user-2`,
        { userSessionToken: 'synthetic-session-token' },
      ],
    },
  ] as const

  for (const route of teamMutationRoutes) {
    it(`relays control-api's bare 401 from ${route.name} instead of answering not found`, async () => {
      authTokenMock.verifyToken.mockReturnValue({ ...auth, exp: 9999999999 })
      clientMock.controlApiRequest.mockRejectedValueOnce(bareUnauthorized())

      const response = await route.send(createApp())
      expect(response.status).toBe(401)
      expect(response.body).toEqual(BARE_UNAUTHORIZED_BODY)

      // Witness: exactly one control-api call, the route's first read or write with the
      // caller's session; nothing after it was sent.
      expect(clientMock.controlApiRequest).toHaveBeenCalledTimes(1)
      expect(clientMock.controlApiRequest).toHaveBeenCalledWith(...route.call)
    })
  }

  it('does not convert desktop-authorization authority outages into bad passwords', async () => {
    clientMock.controlApiRequest.mockRejectedValueOnce(
      new ControlApiError('Control API rejected the password', 401, { error: 'invalid_password' })
    )
    await expect(createDesktopAuthorization(auth, 'wrong-password')).resolves.toEqual({
      error: 'invalid_password',
    })

    clientMock.controlApiRequest.mockRejectedValueOnce(upstream(503))
    await expect(createDesktopAuthorization(auth, 'correct-password')).rejects.toMatchObject({
      status: 503,
    })
  })
})
