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
    mocks.verifyToken.mockImplementation((token: string) => {
      if (token === 'team-a-token') {
        return {
          userId: 'user-1',
          email: 'user@example.com',
          teamId: 'team-a',
          role: 'admin',
          exp: 9_999_999_999,
          sessionContract: 'v1',
        }
      }
      if (token === 'team-b-token') {
        return {
          userId: 'user-1',
          email: 'user@example.com',
          teamId: 'team-b',
          role: 'admin',
          exp: 9_999_999_999,
          sessionContract: 'v1',
        }
      }
      return null
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
          return { token: 'team-b-token', sessionContract: 'v1', deprecated: true }
        }
        if (method === 'PUT' && path === '/external/teams/team-b/name') {
          expect(options).toMatchObject({ userSessionToken: 'team-b-token' })
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

    expect(switchResponse.body.token).toBe('team-b-token')

    await request(app())
      .put('/team/name')
      .set('authorization', `Bearer ${switchResponse.body.token}`)
      .send({ name: 'Renamed Team B' })
      .expect(200)

    const paths = mocks.controlApiRequest.mock.calls.map(call => String(call[1]))
    expect(paths).toContain('/external/teams/team-b/name')
    expect(paths).not.toContain('/external/teams/team-a/name')
  })
})
