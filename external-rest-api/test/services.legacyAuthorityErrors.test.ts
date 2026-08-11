import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ControlApiError } from '../src/controlApiClient.js'
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

  it('maps only an explicit missing user or membership to absence', async () => {
    clientMock.controlApiRequest.mockRejectedValueOnce(upstream(404))
    await expect(getMe(auth.userId, auth.teamId, auth.sessionToken)).resolves.toBeNull()

    clientMock.controlApiRequest.mockRejectedValueOnce(upstream(503))
    await expect(getMe(auth.userId, auth.teamId, auth.sessionToken)).rejects.toMatchObject({
      status: 503,
    })

    clientMock.controlApiRequest.mockRejectedValueOnce(upstream(404))
    await expect(
      switchTeam(auth.userId, auth.email, 'team-2', auth.sessionToken)
    ).resolves.toBeNull()

    clientMock.controlApiRequest.mockRejectedValueOnce(upstream(503))
    await expect(
      switchTeam(auth.userId, auth.email, 'team-2', auth.sessionToken)
    ).rejects.toMatchObject({ status: 503 })
  })

  it('does not convert current-team authority outages into an empty team', async () => {
    clientMock.controlApiRequest.mockRejectedValueOnce(upstream(404))
    await expect(getCurrentTeam(auth)).resolves.toBeNull()

    clientMock.controlApiRequest.mockRejectedValueOnce(upstream(503))
    await expect(getCurrentTeam(auth)).rejects.toMatchObject({ status: 503 })
  })

  it('keeps rename denial, absence, and authority unavailability distinct', async () => {
    clientMock.controlApiRequest.mockRejectedValueOnce(upstream(403))
    await expect(renameTeam(auth, 'Renamed')).resolves.toEqual({ error: 'forbidden' })

    clientMock.controlApiRequest.mockRejectedValueOnce(upstream(404))
    await expect(renameTeam(auth, 'Renamed')).resolves.toEqual({ error: 'not_found' })

    clientMock.controlApiRequest.mockRejectedValueOnce(upstream(503))
    await expect(renameTeam(auth, 'Renamed')).rejects.toMatchObject({ status: 503 })
  })

  it('keeps member-read denial distinct from missing targets and outages', async () => {
    clientMock.controlApiRequest.mockRejectedValueOnce(upstream(403))
    await expect(updateMemberRole(auth, 'user-2', 'member')).resolves.toEqual({
      error: 'forbidden',
    })

    clientMock.controlApiRequest.mockRejectedValueOnce(upstream(404))
    await expect(updateMemberRole(auth, 'user-2', 'member')).resolves.toEqual({
      error: 'not_found',
    })

    clientMock.controlApiRequest.mockRejectedValueOnce(upstream(503))
    await expect(updateMemberRole(auth, 'user-2', 'member')).rejects.toMatchObject({
      status: 503,
    })
  })

  it('keeps member-delete denial distinct from missing targets and outages', async () => {
    clientMock.controlApiRequest.mockRejectedValueOnce(upstream(403))
    await expect(deleteMember(auth, 'user-2')).resolves.toEqual({ error: 'forbidden' })

    clientMock.controlApiRequest.mockRejectedValueOnce(upstream(404))
    await expect(deleteMember(auth, 'user-2')).resolves.toEqual({ error: 'not_found' })

    clientMock.controlApiRequest.mockRejectedValueOnce(upstream(503))
    await expect(deleteMember(auth, 'user-2')).rejects.toMatchObject({ status: 503 })
  })
})
