import { beforeEach, describe, expect, it, vi } from 'vitest'
import { logoutUserSession, renewUserSession } from '../src/services/authService.js'
import { switchTeam } from '../src/services/meService.js'
import { createTeamForUser } from '../src/services/teamService.js'

const client = vi.hoisted(() => ({ controlApiRequest: vi.fn() }))
vi.mock('../src/controlApiClient.js', () => client)

const clientIp = '198.51.100.52'
const headers = { 'x-evenfire-client-ip': clientIp }

describe('external-user client IP forwarding', () => {
  beforeEach(() => {
    client.controlApiRequest.mockReset()
  })

  it('forwards the trusted client IP for renewal and logout lifecycle calls', async () => {
    client.controlApiRequest
      .mockResolvedValueOnce({ token: 'renewed', expiresInSeconds: 3600 })
      .mockResolvedValueOnce({ revoked: true })

    await renewUserSession('session-token', clientIp)
    await logoutUserSession('session-token', clientIp)

    expect(client.controlApiRequest).toHaveBeenNthCalledWith(
      1,
      'POST',
      '/external/auth/session/renew',
      {
        userSessionToken: 'session-token',
        extraHeaders: headers,
      }
    )
    expect(client.controlApiRequest).toHaveBeenNthCalledWith(
      2,
      'POST',
      '/external/auth/session/logout',
      {
        userSessionToken: 'session-token',
        extraHeaders: headers,
      }
    )
  })

  it('forwards the trusted client IP only on the session-token calls for team changes', async () => {
    client.controlApiRequest
      .mockResolvedValueOnce({ id: 'team-1', name: 'Team One' })
      .mockResolvedValueOnce({ token: 'created-token' })
      .mockResolvedValueOnce({ team_id: 'team-2', team_name: 'Team Two', role: 'member' })
      .mockResolvedValueOnce({ token: 'switched-token' })

    await createTeamForUser(
      { userId: 'user-1', email: 'user@example.test', sessionToken: 'session-token' },
      'Team One',
      clientIp
    )
    await switchTeam('user-1', 'user@example.test', 'team-2', 'session-token', clientIp)

    expect(client.controlApiRequest).toHaveBeenNthCalledWith(
      2,
      'POST',
      '/external/auth/session-token',
      expect.objectContaining({ extraHeaders: headers })
    )
    expect(client.controlApiRequest).toHaveBeenNthCalledWith(
      4,
      'POST',
      '/external/auth/session-token',
      expect.objectContaining({ extraHeaders: headers })
    )
  })
})
