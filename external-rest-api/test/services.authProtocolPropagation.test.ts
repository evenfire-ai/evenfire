import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loginWithGoogle, loginWithPassword } from '../src/services/authService.js'
import { switchTeam } from '../src/services/meService.js'
import { createTeamForUser } from '../src/services/teamService.js'

const mock = vi.hoisted(() => ({ controlApiRequest: vi.fn() }))

vi.mock('../src/controlApiClient.js', () => ({
  controlApiRequest: mock.controlApiRequest,
}))

describe('session protocol propagation to replacement tokens', () => {
  beforeEach(() => {
    mock.controlApiRequest.mockReset()
  })

  it('preserves v2 when switching teams', async () => {
    mock.controlApiRequest
      .mockResolvedValueOnce({ team_id: 'team-2', role: 'member', team_name: 'Beta' })
      .mockResolvedValueOnce({ token: 'next-session-token' })

    await switchTeam('user-1', 'user@example.com', 'team-2', 'current-session', 2)

    expect(mock.controlApiRequest).toHaveBeenNthCalledWith(
      2,
      'POST',
      '/external/auth/session-token',
      expect.objectContaining({
        body: {
          userId: 'user-1',
          email: 'user@example.com',
          teamId: 'team-2',
          role: 'member',
          authProtocolVersion: 2,
        },
      })
    )
  })

  it('preserves an absent version when switching a legacy session', async () => {
    mock.controlApiRequest
      .mockResolvedValueOnce({ team_id: 'team-2', role: 'member', team_name: 'Beta' })
      .mockResolvedValueOnce({ token: 'next-session-token' })

    await switchTeam('user-1', 'user@example.com', 'team-2', 'current-session')

    expect(mock.controlApiRequest).toHaveBeenNthCalledWith(
      2,
      'POST',
      '/external/auth/session-token',
      expect.objectContaining({
        body: {
          userId: 'user-1',
          email: 'user@example.com',
          teamId: 'team-2',
          role: 'member',
        },
      })
    )
  })

  it('preserves v2 when creating a team', async () => {
    mock.controlApiRequest
      .mockResolvedValueOnce({ id: 'team-2', name: 'Beta' })
      .mockResolvedValueOnce({ token: 'next-session-token' })

    await createTeamForUser(
      {
        userId: 'user-1',
        email: 'user@example.com',
        sessionToken: 'current-session',
        authProtocolVersion: 2,
      },
      'Beta'
    )

    expect(mock.controlApiRequest).toHaveBeenNthCalledWith(
      2,
      'POST',
      '/external/auth/session-token',
      expect.objectContaining({
        body: {
          userId: 'user-1',
          email: 'user@example.com',
          teamId: 'team-2',
          role: 'admin',
          authProtocolVersion: 2,
        },
      })
    )
  })

  it('preserves an absent version when creating a team from a legacy session', async () => {
    mock.controlApiRequest
      .mockResolvedValueOnce({ id: 'team-2', name: 'Beta' })
      .mockResolvedValueOnce({ token: 'next-session-token' })

    await createTeamForUser(
      {
        userId: 'user-1',
        email: 'user@example.com',
        sessionToken: 'current-session',
      },
      'Beta'
    )

    expect(mock.controlApiRequest).toHaveBeenNthCalledWith(
      2,
      'POST',
      '/external/auth/session-token',
      expect.objectContaining({
        body: {
          userId: 'user-1',
          email: 'user@example.com',
          teamId: 'team-2',
          role: 'admin',
        },
      })
    )
  })
})

describe('versioned login protocol selection', () => {
  beforeEach(() => {
    mock.controlApiRequest.mockReset()
    mock.controlApiRequest.mockResolvedValue({ token: 'session-token' })
  })

  it('selects the protocol-v2 Google login producer', async () => {
    await loginWithGoogle({ idToken: 'google-id-token' }, 2)

    expect(mock.controlApiRequest).toHaveBeenCalledWith('POST', '/external/auth/v2/google-login', {
      body: { idToken: 'google-id-token' },
    })
  })

  it('selects the protocol-v2 password login producer', async () => {
    await loginWithPassword('user@example.com', 'password', 2)

    expect(mock.controlApiRequest).toHaveBeenCalledWith(
      'POST',
      '/external/auth/v2/password-login',
      { body: { email: 'user@example.com', password: 'password' } }
    )
  })
})
