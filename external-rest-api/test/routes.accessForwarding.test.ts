import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import {
  PASSWORD_CREDENTIAL_CHANGED_RESPONSE,
  PASSWORD_NOT_SET_RESPONSE,
} from '../../control-api/src/routes/external/passwordErrorResponses.js'
import { createMeRouter } from '../src/routes/me.js'
import { createTeamRouter } from '../src/routes/team.js'

const authTokenMock = vi.hoisted(() => ({
  verifyToken: vi.fn(),
}))

const meServiceMock = vi.hoisted(() => ({
  getMyContexts: vi.fn(),
  getMyAgents: vi.fn(),
  getMyTeamDirectory: vi.fn(),
  getMe: vi.fn(),
  listTeams: vi.fn(),
  switchTeam: vi.fn(),
  updatePassword: vi.fn(),
  updateProfile: vi.fn(),
}))

const teamServiceMock = vi.hoisted(() => ({
  getTeamContexts: vi.fn(),
  getTeamAgents: vi.fn(),
  createTeamForUser: vi.fn(),
  deleteMember: vi.fn(),
  getCurrentTeam: vi.fn(),
  inviteMember: vi.fn(),
  listMembers: vi.fn(),
  renameTeam: vi.fn(),
  updateMemberRole: vi.fn(),
}))

vi.mock('../src/authToken.js', () => authTokenMock)
vi.mock('../src/services/meService.js', () => meServiceMock)
vi.mock('../src/services/teamService.js', () => teamServiceMock)

describe('routes/access forwarding', () => {
  const claims = {
    userId: 'user-1',
    email: 'user@example.com',
    teamId: 'team-1',
    role: 'member' as const,
    exp: 9999999999,
  }

  beforeEach(() => {
    authTokenMock.verifyToken.mockReset()
    meServiceMock.getMyContexts.mockReset()
    meServiceMock.getMyAgents.mockReset()
    meServiceMock.getMyTeamDirectory.mockReset()
    meServiceMock.getMe.mockReset()
    meServiceMock.listTeams.mockReset()
    meServiceMock.switchTeam.mockReset()
    meServiceMock.updatePassword.mockReset()
    meServiceMock.updateProfile.mockReset()
    teamServiceMock.getTeamContexts.mockReset()
    teamServiceMock.getTeamAgents.mockReset()
    teamServiceMock.createTeamForUser.mockReset()
    teamServiceMock.deleteMember.mockReset()
    teamServiceMock.getCurrentTeam.mockReset()
    teamServiceMock.inviteMember.mockReset()
    teamServiceMock.listMembers.mockReset()
    teamServiceMock.renameTeam.mockReset()
    teamServiceMock.updateMemberRole.mockReset()
  })

  function appWith(routerFactory: () => express.Router) {
    const app = express()
    app.use(express.json())
    app.use(routerFactory())
    return app
  }

  async function preparePasswordApiError(response: {
    status: number
    body: unknown
    headers?: Record<string, string>
  }) {
    authTokenMock.verifyToken.mockReturnValue(claims)
    const actualService = await vi.importActual<typeof import('../src/services/meService.js')>(
      '../src/services/meService.js'
    )
    meServiceMock.updatePassword.mockImplementation(actualService.updatePassword)
    return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(response.body), {
        status: response.status,
        headers: { 'content-type': 'application/json', ...response.headers },
      })
    )
  }

  it('forwards /me/contexts and /me/agents with claim-bound userId', async () => {
    authTokenMock.verifyToken.mockReturnValue(claims)
    meServiceMock.getMyContexts.mockResolvedValue({ userId: 'user-1', contextIds: ['ctx-a'] })
    meServiceMock.getMyAgents.mockResolvedValue({ userId: 'user-1', agentNames: ['agent-a'] })
    const app = appWith(createMeRouter)

    await request(app)
      .get('/me/contexts')
      .set('authorization', 'Bearer good-token')
      .expect(200)
      .expect({ userId: 'user-1', contextIds: ['ctx-a'] })
    expect(meServiceMock.getMyContexts).toHaveBeenCalledWith('user-1', 'good-token')

    await request(app)
      .get('/me/agents')
      .set('authorization', 'Bearer good-token')
      .expect(200)
      .expect({ userId: 'user-1', agentNames: ['agent-a'] })
    expect(meServiceMock.getMyAgents).toHaveBeenCalledWith('user-1', 'good-token')
  })

  it('forwards /team/contexts and /team/agents with claim-bound teamId', async () => {
    authTokenMock.verifyToken.mockReturnValue(claims)
    teamServiceMock.getTeamContexts.mockResolvedValue({ teamId: 'team-1', contextIds: ['ctx-a'] })
    teamServiceMock.getTeamAgents.mockResolvedValue({ teamId: 'team-1', agentNames: ['agent-a'] })
    const app = appWith(createTeamRouter)

    await request(app)
      .get('/team/contexts')
      .set('authorization', 'Bearer good-token')
      .expect(200)
      .expect({ teamId: 'team-1', contextIds: ['ctx-a'] })
    expect(teamServiceMock.getTeamContexts).toHaveBeenCalledWith('team-1', 'good-token')

    await request(app)
      .get('/team/agents')
      .set('authorization', 'Bearer good-token')
      .expect(200)
      .expect({ teamId: 'team-1', agentNames: ['agent-a'] })
    expect(teamServiceMock.getTeamAgents).toHaveBeenCalledWith('team-1', 'good-token')
  })

  it('forwards initial /me/teams/directory with claim-bound userId', async () => {
    authTokenMock.verifyToken.mockReturnValue(claims)
    meServiceMock.getMyTeamDirectory.mockResolvedValue({
      currentTeamId: 'team-1',
      truncated: false,
      items: [
        {
          team: { id: 'team-1', name: 'Alpha', role: 'member' },
          members: [],
          contextIds: ['ctx-a'],
          agentNames: ['agent-a'],
        },
      ],
    })
    const app = appWith(createMeRouter)

    await request(app)
      .get('/me/teams/directory')
      .set('authorization', 'Bearer good-token')
      .expect(200)
      .expect({
        currentTeamId: 'team-1',
        truncated: false,
        items: [
          {
            team: { id: 'team-1', name: 'Alpha', role: 'member' },
            members: [],
            contextIds: ['ctx-a'],
            agentNames: ['agent-a'],
          },
        ],
      })
    expect(meServiceMock.getMyTeamDirectory).toHaveBeenCalledWith('user-1', 'good-token')
  })

  it('maps the Control API credential-changed response to actionable password guidance', async () => {
    const upstreamFetch = await preparePasswordApiError(PASSWORD_CREDENTIAL_CHANGED_RESPONSE)
    const app = appWith(createMeRouter)

    try {
      await request(app)
        .put('/me/password')
        .set('authorization', 'Bearer good-token')
        .send({ currentPassword: 'synthetic-current', newPassword: 'synthetic-next-password' })
        .expect(409)
        .expect({
          error: 'Your password changed during this request. Sign in again with your new password.',
        })
      expect(upstreamFetch).toHaveBeenCalledTimes(1)
    } finally {
      upstreamFetch.mockRestore()
    }
  })

  it('preserves the password-not-set message for the existing Control API 409 response', async () => {
    const upstreamFetch = await preparePasswordApiError(PASSWORD_NOT_SET_RESPONSE)
    const app = appWith(createMeRouter)

    try {
      await request(app)
        .put('/me/password')
        .set('authorization', 'Bearer good-token')
        .send({ currentPassword: 'synthetic-current', newPassword: 'synthetic-next-password' })
        .expect(409)
        .expect({ error: 'Password is not set' })
      expect(upstreamFetch).toHaveBeenCalledTimes(1)
    } finally {
      upstreamFetch.mockRestore()
    }
  })

  it('maps password-work contention to a sanitized 429 and permits a later retry', async () => {
    const upstreamFetch = await preparePasswordApiError({
      status: 429,
      body: { error: 'verification_busy', internal: 'owner row details' },
      headers: { 'retry-after': '13', 'x-ratelimit-remaining': '0' },
    })
    const app = appWith(createMeRouter)

    try {
      const denied = await request(app)
        .put('/me/password')
        .set('authorization', 'Bearer good-token')
        .send({ currentPassword: 'synthetic-current', newPassword: 'synthetic-next-password' })
        .expect(429)

      expect(denied.body).toEqual({ error: 'rate_limited', retryAfterSeconds: 13 })
      expect(denied.headers['retry-after']).toBe('13')
      expect(denied.headers['x-ratelimit-remaining']).toBeUndefined()
      expect(JSON.stringify(denied.body)).not.toContain('verification_busy')
      expect(JSON.stringify(denied.body)).not.toContain('owner row')
      expect(upstreamFetch).toHaveBeenCalledTimes(1)

      upstreamFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ updated: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
      await request(app)
        .put('/me/password')
        .set('authorization', 'Bearer good-token')
        .send({ currentPassword: 'synthetic-current', newPassword: 'synthetic-next-password' })
        .expect(200)
        .expect({ updated: true })
      expect(upstreamFetch).toHaveBeenCalledTimes(2)
    } finally {
      upstreamFetch.mockRestore()
    }
  })

  it('maps password authority outage to a sanitized bounded 503', async () => {
    const upstreamFetch = await preparePasswordApiError({
      status: 503,
      body: { error: 'authority_failure', sql: 'private query text' },
      headers: { 'retry-after': '1200', 'x-ratelimit-remaining': '0' },
    })
    const app = appWith(createMeRouter)

    try {
      const response = await request(app)
        .put('/me/password')
        .set('authorization', 'Bearer good-token')
        .send({ currentPassword: 'synthetic-current', newPassword: 'synthetic-next-password' })
        .expect(503)

      expect(response.body).toEqual({ error: 'authority_unavailable', retryAfterSeconds: 900 })
      expect(response.headers['retry-after']).toBe('900')
      expect(response.headers['x-ratelimit-remaining']).toBeUndefined()
      expect(JSON.stringify(response.body)).not.toContain('authority_failure')
      expect(JSON.stringify(response.body)).not.toContain('private query')
      expect(upstreamFetch).toHaveBeenCalledOnce()
    } finally {
      upstreamFetch.mockRestore()
    }
  })

  it('rate limits initial /me/teams/directory per authenticated user', async () => {
    authTokenMock.verifyToken.mockReturnValue({
      ...claims,
      userId: 'rate-user',
    })
    meServiceMock.getMyTeamDirectory.mockResolvedValue({
      currentTeamId: 'team-1',
      items: [],
    })
    const app = appWith(createMeRouter)

    for (let i = 0; i < 10; i += 1) {
      await request(app)
        .get('/me/teams/directory')
        .set('authorization', 'Bearer good-token')
        .expect(200)
    }

    const limited = await request(app)
      .get('/me/teams/directory')
      .set('authorization', 'Bearer good-token')
      .expect(429)

    expect(limited.headers['retry-after']).toMatch(/^\d+$/)
    expect(limited.headers['x-ratelimit-limit']).toBe('10')
    expect(limited.headers['x-ratelimit-remaining']).toBe('0')
    expect(meServiceMock.getMyTeamDirectory).toHaveBeenCalledTimes(10)
  })

  it('rejects unauthorized callers', async () => {
    authTokenMock.verifyToken.mockReturnValue(null)
    const app = appWith(createMeRouter)
    await request(app).get('/me/contexts').set('authorization', 'Bearer bad-token').expect(401)
  })
})
