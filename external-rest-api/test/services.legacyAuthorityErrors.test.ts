import { beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { ControlApiError } from '../src/controlApiClient.js'
import { createDesktopAuthorization } from '../src/services/invitationsService.js'
import { ControlApiCredentialRejectedError, getMe, switchTeam } from '../src/services/meService.js'
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

// control-api's public session-end envelope (revoked, expired or invalid session).
const INVALID_SESSION_BODY = {
  error: { code: 'invalid_session', message: 'The session is not valid.', retryable: false },
}
const INVALID_SESSION_REJECTION = {
  status: 401,
  body: { error: { code: 'invalid_session' } },
}

function invalidSession(): ControlApiError {
  return new ControlApiError('control api failure', 401, INVALID_SESSION_BODY)
}

describe('legacy authority adapters', () => {
  beforeEach(() => {
    clientMock.controlApiRequest.mockReset()
    authTokenMock.verifyToken.mockReset()
  })

  it('maps every other /me and switch-team failure to absence, keeping outages and /me revocation', async () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})
    for (const status of [404, 401, 500]) {
      clientMock.controlApiRequest.mockRejectedValueOnce(upstream(status))
      if (status === 401) {
        // A bare 401 is the edge's service credential, never forwarded as a session end.
        const rejection = getMe(auth.userId, auth.teamId, auth.sessionToken)
        await expect(rejection).rejects.toBeInstanceOf(ControlApiCredentialRejectedError)
        await expect(rejection).rejects.not.toBeInstanceOf(ControlApiError)
      } else {
        await expect(getMe(auth.userId, auth.teamId, auth.sessionToken)).resolves.toBeNull()
      }

      clientMock.controlApiRequest.mockRejectedValueOnce(upstream(status))
      await expect(
        switchTeam(auth.userId, auth.email, 'team-2', auth.sessionToken)
      ).resolves.toBeNull()
    }
    // Service code writes no console output; the typed rejection above is the signal.
    expect(stderr).not.toHaveBeenCalled()
    stderr.mockRestore()

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

  it('keeps the current-team session end and outages, and maps every other failure to no team', async () => {
    for (const status of [403, 404, 401, 500]) {
      clientMock.controlApiRequest.mockRejectedValueOnce(upstream(status))
      await expect(getCurrentTeam(auth)).resolves.toBeNull()
    }

    clientMock.controlApiRequest.mockRejectedValueOnce(invalidSession())
    await expect(getCurrentTeam(auth)).rejects.toMatchObject(INVALID_SESSION_REJECTION)

    clientMock.controlApiRequest.mockRejectedValueOnce(upstream(503))
    await expect(getCurrentTeam(auth)).rejects.toMatchObject({ status: 503 })

    expect(clientMock.controlApiRequest).toHaveBeenCalledTimes(6)
  })

  it('keeps the rename session end, live demotion and outages, and maps the rest to not_found', async () => {
    clientMock.controlApiRequest.mockRejectedValueOnce(invalidSession())
    await expect(renameTeam(auth, 'Renamed')).rejects.toMatchObject(INVALID_SESSION_REJECTION)

    clientMock.controlApiRequest.mockRejectedValueOnce(upstream(403))
    await expect(renameTeam(auth, 'Renamed')).resolves.toEqual({ error: 'forbidden' })

    for (const status of [404, 401, 500]) {
      clientMock.controlApiRequest.mockRejectedValueOnce(upstream(status))
      await expect(renameTeam(auth, 'Renamed')).resolves.toEqual({ error: 'not_found' })
    }

    clientMock.controlApiRequest.mockRejectedValueOnce(upstream(503))
    await expect(renameTeam(auth, 'Renamed')).rejects.toMatchObject({ status: 503 })

    expect(clientMock.controlApiRequest).toHaveBeenCalledTimes(6)
  })

  it('keeps the member-read session end, live demotion and outages, and maps the rest to not_found', async () => {
    clientMock.controlApiRequest.mockRejectedValueOnce(invalidSession())
    await expect(updateMemberRole(auth, 'user-2', 'member')).rejects.toMatchObject(
      INVALID_SESSION_REJECTION
    )

    clientMock.controlApiRequest.mockRejectedValueOnce(upstream(403))
    await expect(updateMemberRole(auth, 'user-2', 'member')).resolves.toEqual({
      error: 'forbidden',
    })

    for (const status of [404, 401, 500]) {
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
    expect(clientMock.controlApiRequest).toHaveBeenCalledTimes(6)
    for (const [method] of clientMock.controlApiRequest.mock.calls) expect(method).toBe('GET')
  })

  it('keeps the member-delete session end, live demotion and outages, and maps the rest to not_found', async () => {
    clientMock.controlApiRequest.mockRejectedValueOnce(invalidSession())
    await expect(deleteMember(auth, 'user-2')).rejects.toMatchObject(INVALID_SESSION_REJECTION)

    clientMock.controlApiRequest.mockRejectedValueOnce(upstream(403))
    await expect(deleteMember(auth, 'user-2')).resolves.toEqual({ error: 'forbidden' })

    for (const status of [404, 401, 500]) {
      clientMock.controlApiRequest.mockRejectedValueOnce(upstream(status))
      await expect(deleteMember(auth, 'user-2')).resolves.toEqual({ error: 'not_found' })
    }

    clientMock.controlApiRequest.mockRejectedValueOnce(upstream(503))
    await expect(deleteMember(auth, 'user-2')).rejects.toMatchObject({ status: 503 })

    expect(clientMock.controlApiRequest).toHaveBeenCalledTimes(6)
  })

  it('relays the invalid_session envelope from GET /api/v1/team instead of answering no team', async () => {
    authTokenMock.verifyToken.mockReturnValue({ ...auth, exp: 9999999999 })
    clientMock.controlApiRequest.mockRejectedValueOnce(invalidSession())

    const response = await request(createApp())
      .get('/api/v1/team')
      .set('authorization', 'Bearer synthetic-session-token')
    expect(response.status).toBe(401)
    expect(response.body).toEqual(INVALID_SESSION_BODY)

    // Witness: the request reached the current-team read with the caller's session.
    expect(clientMock.controlApiRequest).toHaveBeenCalledTimes(1)
    expect(clientMock.controlApiRequest).toHaveBeenCalledWith(
      'GET',
      `/external/teams/${auth.teamId}/users/${auth.userId}/current`,
      { userSessionToken: 'synthetic-session-token' }
    )
  })

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
