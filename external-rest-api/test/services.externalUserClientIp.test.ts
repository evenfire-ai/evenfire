import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  loginWithGoogle,
  loginWithPassword,
  logoutUserSession,
  renewUserSession,
} from '../src/services/authService.js'
import { switchTeam } from '../src/services/meService.js'
import { issueRpcAccessToken } from '../src/services/rpcService.js'
import { createTeamForUser } from '../src/services/teamService.js'

const client = vi.hoisted(() => ({ controlApiRequest: vi.fn() }))
vi.mock('../src/controlApiClient.js', () => client)

/**
 * E-4: the edge no longer sends the `x-evenfire-client-ip` alias. The canonical
 * `x-external-client-ip` header is added by `controlApiClient` from the request
 * context for every call, so the services must pass no extra header at all.
 * `test/controlApiClient.test.ts` pins that the canonical header still travels.
 */
describe('external-user client identity forwarding', () => {
  beforeEach(() => {
    client.controlApiRequest.mockReset()
  })

  it('sends no extra header from the four auth service calls', async () => {
    client.controlApiRequest
      .mockResolvedValueOnce({ token: 'synthetic-google-session' })
      .mockResolvedValueOnce({ token: 'synthetic-password-session' })
      .mockResolvedValueOnce({ token: 'synthetic-renewed-session', expiresInSeconds: 3600 })
      .mockResolvedValueOnce({ revoked: true })

    await loginWithGoogle({ idToken: 'synthetic-google-id-token' })
    await loginWithPassword('user@example.invalid', 'synthetic-password', 'v2')
    await renewUserSession('synthetic-session-token')
    await logoutUserSession('synthetic-session-token')

    expect(client.controlApiRequest).toHaveBeenNthCalledWith(
      1,
      'POST',
      '/external/auth/google-login',
      { body: { idToken: 'synthetic-google-id-token' } }
    )
    expect(client.controlApiRequest).toHaveBeenNthCalledWith(
      2,
      'POST',
      '/external/auth/password-login',
      {
        body: {
          email: 'user@example.invalid',
          password: 'synthetic-password',
          sessionContract: 'v2',
        },
      }
    )
    expect(client.controlApiRequest).toHaveBeenNthCalledWith(
      3,
      'POST',
      '/external/auth/session/renew',
      { userSessionToken: 'synthetic-session-token' }
    )
    expect(client.controlApiRequest).toHaveBeenNthCalledWith(
      4,
      'POST',
      '/external/auth/session/logout',
      { userSessionToken: 'synthetic-session-token' }
    )
  })

  it('sends no extra header from team creation, team switch or RPC issuance', async () => {
    client.controlApiRequest
      .mockResolvedValueOnce({ id: 'synthetic-team-id', name: 'Synthetic Team' })
      .mockResolvedValueOnce({ token: 'synthetic-created-session' })
      .mockResolvedValueOnce({
        team_id: 'synthetic-next-team-id',
        team_name: 'Synthetic Next Team',
        role: 'member',
      })
      .mockResolvedValueOnce({ token: 'synthetic-switched-session' })
      .mockResolvedValueOnce({ token: 'synthetic-rpc-token' })

    await createTeamForUser(
      {
        userId: 'synthetic-member-id',
        email: 'member@example.invalid',
        sessionToken: 'synthetic-session-token',
      },
      'Synthetic Team'
    )
    await switchTeam(
      'synthetic-member-id',
      'member@example.invalid',
      'synthetic-next-team-id',
      'synthetic-session-token'
    )
    await issueRpcAccessToken(
      'synthetic-session-token',
      ['host:message:invoke'],
      ['synthetic-agent']
    )

    expect(client.controlApiRequest).toHaveBeenNthCalledWith(1, 'POST', '/external/teams', {
      body: { userId: 'synthetic-member-id', name: 'Synthetic Team' },
      userSessionToken: 'synthetic-session-token',
    })
    expect(client.controlApiRequest).toHaveBeenNthCalledWith(
      2,
      'POST',
      '/external/auth/session-token',
      {
        body: {
          userId: 'synthetic-member-id',
          email: 'member@example.invalid',
          teamId: 'synthetic-team-id',
          role: 'admin',
        },
        userSessionToken: 'synthetic-session-token',
      }
    )
    expect(client.controlApiRequest).toHaveBeenNthCalledWith(
      3,
      'GET',
      '/external/users/synthetic-member-id/memberships/synthetic-next-team-id',
      { userSessionToken: 'synthetic-session-token' }
    )
    expect(client.controlApiRequest).toHaveBeenNthCalledWith(
      4,
      'POST',
      '/external/auth/session-token',
      {
        body: {
          userId: 'synthetic-member-id',
          email: 'member@example.invalid',
          teamId: 'synthetic-next-team-id',
          role: 'member',
        },
        userSessionToken: 'synthetic-session-token',
      }
    )
    expect(client.controlApiRequest).toHaveBeenNthCalledWith(5, 'POST', '/external/rpc/token', {
      body: {
        sessionToken: 'synthetic-session-token',
        scopes: ['host:message:invoke'],
        hostRefs: ['synthetic-agent'],
      },
    })
  })
})
