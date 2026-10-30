import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createMeRouter } from '../src/routes/me.js'
import { createTeamRouter } from '../src/routes/team.js'

const mocks = vi.hoisted(() => ({
  controlApiRequest: vi.fn(),
  verifyToken: vi.fn(),
}))

vi.mock('../src/controlApiClient.js', () => ({
  controlApiRequest: mocks.controlApiRequest,
}))
vi.mock('../src/authToken.js', () => ({
  verifyToken: mocks.verifyToken,
}))

function app() {
  const value = express()
  value.use(express.json())
  value.use(createMeRouter())
  value.use(createTeamRouter())
  return value
}

describe('legacy team-switch compatibility', () => {
  beforeEach(() => {
    mocks.controlApiRequest.mockReset()
    mocks.verifyToken.mockReset()
    // Native V1 tokens: the original A token, the B token that A -> B mints, and
    // the new A token that B -> A mints. All three are accepted here, so a
    // regression that keeps returning the previous team's token is observable.
    const tokenTeams: Record<string, string> = {
      'team-a-token': 'team-a',
      'team-b-token': 'team-b',
      'team-a-return-token': 'team-a',
      'synthetic-team-b-token': 'team-b',
    }
    mocks.verifyToken.mockImplementation((token: string) => {
      const teamId = tokenTeams[token]
      if (!teamId) return null
      return {
        userId: 'user-1',
        email: 'user@example.com',
        teamId,
        role: 'admin',
        exp: 9_999_999_999,
        sessionContract: 'v1',
      }
    })
  })

  it('uses the replacement v1 token for the next team-targeted mutation', async () => {
    mocks.controlApiRequest.mockImplementation(
      async (method: string, path: string, options: Record<string, unknown>) => {
        if (method === 'GET' && path === '/external/users/user-1/memberships/team-b') {
          return { team_id: 'team-b', team_name: 'Team B', role: 'admin' }
        }
        if (method === 'POST' && path === '/external/auth/session-token') {
          expect(options).toMatchObject({
            userSessionToken: 'team-a-token',
            body: { userId: 'user-1', teamId: 'team-b', role: 'admin' },
          })
          return { token: 'synthetic-team-b-token', sessionContract: 'v1', deprecated: true }
        }
        if (method === 'PUT' && path === '/external/teams/team-b/name') {
          expect(options).toMatchObject({ userSessionToken: 'synthetic-team-b-token' })
          return { id: 'team-b', name: 'Renamed Team B' }
        }
        throw new Error(`unexpected Control API request: ${method} ${path}`)
      }
    )

    const switchResponse = await request(app())
      .post('/me/switch-team')
      .set('authorization', 'Bearer team-a-token')
      .send({ teamId: 'team-b' })
      .expect(200)

    expect(switchResponse.body.token).toBe('synthetic-team-b-token')

    await request(app())
      .put('/team/name')
      .set('authorization', `Bearer ${switchResponse.body.token}`)
      .send({ name: 'Renamed Team B' })
      .expect(200)

    const paths = mocks.controlApiRequest.mock.calls.map(call => String(call[1]))
    expect(paths).toContain('/external/teams/team-b/name')
    expect(paths).not.toContain('/external/teams/team-a/name')
  })

  // Native V1 A -> B -> A with no browser cookie and no V2 opt-in. The edge's
  // verifyToken and controlApiRequest are mocked, so this pins the forwarding
  // contract only: each read must carry the newest token a switch returned and
  // land on the requested team. It does not prove Control API token issuance.
  it('keeps A -> B -> A native v1 switches on the newest returned token', async () => {
    const tokenTeams: Record<string, string> = {
      'team-a-token': 'team-a',
      'team-b-token': 'team-b',
      'team-a-return-token': 'team-a',
    }
    // The minted token is a pure function of the bearer used and the requested
    // team, never of the call order.
    const mintedTokens: Record<string, string> = {
      'team-a-token:team-b': 'team-b-token',
      'team-b-token:team-a': 'team-a-return-token',
    }
    const teamNames: Record<string, string> = { 'team-a': 'Team A', 'team-b': 'Team B' }
    let lastMembership: { token: string; teamId: string } | undefined

    mocks.controlApiRequest.mockImplementation(
      async (method: string, path: string, options: Record<string, unknown>) => {
        if (method === 'GET' && path.startsWith('/external/users/user-1/memberships/')) {
          const teamId = decodeURIComponent(
            path.slice('/external/users/user-1/memberships/'.length)
          )
          lastMembership = { token: String(options.userSessionToken), teamId }
          return { team_id: teamId, team_name: teamNames[teamId], role: 'admin' }
        }
        if (method === 'POST' && path === '/external/auth/session-token') {
          const sessionToken = String(options.userSessionToken)
          const body = options.body as { userId: string; teamId: string; role: string }
          // The switch forwards the bearer it was called with and the team its
          // own membership lookup resolved.
          expect(lastMembership).toEqual({ token: sessionToken, teamId: body.teamId })
          expect(tokenTeams[sessionToken]).toBeDefined()
          expect(body.teamId).not.toBe(tokenTeams[sessionToken])
          return {
            token: mintedTokens[`${sessionToken}:${body.teamId}`],
            sessionContract: 'v1',
            deprecated: true,
          }
        }
        if (method === 'GET' && path === '/external/users/user-1/me') {
          // Answer from the forwarded bearer, never from call order.
          const teamId = tokenTeams[String(options.userSessionToken)]
          expect(options.query).toMatchObject({ teamId })
          return {
            id: 'user-1',
            email: 'user@example.com',
            name: 'User One',
            teamId,
            teamName: teamNames[teamId],
            role: 'admin',
            profile: { displayName: 'User One', channels: null },
          }
        }
        if (method === 'GET' && path === '/external/users/user-1/teams') {
          const teamId = tokenTeams[String(options.userSessionToken)]
          expect(options.query).toMatchObject({ currentTeamId: teamId })
          return {
            currentTeamId: teamId,
            items: [
              { id: 'team-a', name: 'Team A', role: 'admin' },
              { id: 'team-b', name: 'Team B', role: 'admin' },
            ],
          }
        }
        throw new Error(`unexpected Control API request: ${method} ${path}`)
      }
    )

    async function switchTo(token: string, teamId: string): Promise<string> {
      // No origin, sec-fetch-site or x-evenfire-session-contract header: this is
      // the idle native client path.
      const response = await request(app())
        .post('/me/switch-team')
        .set('authorization', `Bearer ${token}`)
        .send({ teamId })
        .expect(200)
      // Liveness: the switch really returned a token, and a non-browser caller
      // gets no cookie.
      expect(response.body.token).toBe(mintedTokens[`${token}:${teamId}`])
      expect(response.headers['set-cookie']).toBeUndefined()
      return String(response.body.token)
    }

    async function expectTeamReads(token: string, teamId: string): Promise<void> {
      const me = await request(app()).get('/me').set('authorization', `Bearer ${token}`).expect(200)
      expect(me.body.teamId).toBe(teamId)
      const teams = await request(app())
        .get('/me/teams')
        .set('authorization', `Bearer ${token}`)
        .expect(200)
      expect(teams.body.currentTeamId).toBe(teamId)
    }

    await expectTeamReads('team-a-token', 'team-a')
    const teamBToken = await switchTo('team-a-token', 'team-b')
    await expectTeamReads(teamBToken, 'team-b')
    const teamAReturnToken = await switchTo(teamBToken, 'team-a')
    expect(teamAReturnToken).not.toBe('team-a-token')
    await expectTeamReads(teamAReturnToken, 'team-a')
  })
})
