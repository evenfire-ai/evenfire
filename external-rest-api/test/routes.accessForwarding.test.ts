import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
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

    await request(app)
      .get('/me/teams/directory')
      .set('authorization', 'Bearer good-token')
      .expect(429)

    expect(meServiceMock.getMyTeamDirectory).toHaveBeenCalledTimes(10)
  })

  it('rejects unauthorized callers', async () => {
    authTokenMock.verifyToken.mockReturnValue(null)
    const app = appWith(createMeRouter)
    await request(app).get('/me/contexts').set('authorization', 'Bearer bad-token').expect(401)
  })

  it('does not expose a user bearer on browser team creation or switch responses', async () => {
    authTokenMock.verifyToken.mockReturnValue(claims)
    teamServiceMock.createTeamForUser.mockResolvedValue({
      team: { id: 'team-2', name: 'New Team', role: 'admin' },
      token: 'replayable-user-token',
    })
    meServiceMock.switchTeam.mockResolvedValue({
      team: { id: 'team-2', name: 'New Team', role: 'admin' },
      token: 'replayable-user-token',
    })

    const teamResponse = await request(appWith(createTeamRouter))
      .post('/team')
      .set('authorization', 'Bearer good-token')
      .set('origin', 'http://localhost:3001')
      .send({ name: 'New Team' })
      .expect(201)
    const switchResponse = await request(appWith(createMeRouter))
      .post('/me/switch-team')
      .set('authorization', 'Bearer good-token')
      .set('sec-fetch-site', 'same-origin')
      .send({ teamId: 'team-2' })
      .expect(200)

    expect(teamResponse.body).toEqual({
      team: { id: 'team-2', name: 'New Team', role: 'admin' },
    })
    expect(switchResponse.body).toEqual({
      team: { id: 'team-2', name: 'New Team', role: 'admin' },
    })
    expect(String(teamResponse.headers['set-cookie'])).toContain(
      'profile_session=replayable-user-token'
    )
    expect(String(switchResponse.headers['set-cookie'])).toContain(
      'profile_session=replayable-user-token'
    )
  })
})
