import { beforeEach, describe, expect, it, vi } from 'vitest'
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

describe('legacy authority adapters', () => {
  beforeEach(() => {
    clientMock.controlApiRequest.mockReset()
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
    expect(stderr).toHaveBeenCalledTimes(1)
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

  it('does not convert current-team authority outages into an empty team', async () => {
    for (const status of [404, 401, 500]) {
      clientMock.controlApiRequest.mockRejectedValueOnce(upstream(status))
      await expect(getCurrentTeam(auth)).resolves.toBeNull()
    }

    clientMock.controlApiRequest.mockRejectedValueOnce(upstream(503))
    await expect(getCurrentTeam(auth)).rejects.toMatchObject({ status: 503 })

    expect(clientMock.controlApiRequest).toHaveBeenCalledTimes(4)
  })

  it('maps every rename failure except an outage to not_found', async () => {
    for (const status of [403, 404, 401, 500]) {
      clientMock.controlApiRequest.mockRejectedValueOnce(upstream(status))
      await expect(renameTeam(auth, 'Renamed')).resolves.toEqual({ error: 'not_found' })
    }

    clientMock.controlApiRequest.mockRejectedValueOnce(upstream(503))
    await expect(renameTeam(auth, 'Renamed')).rejects.toMatchObject({ status: 503 })

    expect(clientMock.controlApiRequest).toHaveBeenCalledTimes(5)
  })

  it('maps every member-read failure except an outage to not_found', async () => {
    for (const status of [403, 404, 401, 500]) {
      clientMock.controlApiRequest.mockRejectedValueOnce(upstream(status))
      await expect(updateMemberRole(auth, 'user-2', 'member')).resolves.toEqual({
        error: 'not_found',
      })
    }

    clientMock.controlApiRequest.mockRejectedValueOnce(upstream(503))
    await expect(updateMemberRole(auth, 'user-2', 'member')).rejects.toMatchObject({
      status: 503,
    })

    expect(clientMock.controlApiRequest).toHaveBeenCalledTimes(5)
  })

  it('maps every member-delete failure except an outage to not_found', async () => {
    for (const status of [403, 404, 401, 500]) {
      clientMock.controlApiRequest.mockRejectedValueOnce(upstream(status))
      await expect(deleteMember(auth, 'user-2')).resolves.toEqual({ error: 'not_found' })
    }

    clientMock.controlApiRequest.mockRejectedValueOnce(upstream(503))
    await expect(deleteMember(auth, 'user-2')).rejects.toMatchObject({ status: 503 })

    expect(clientMock.controlApiRequest).toHaveBeenCalledTimes(5)
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
