import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createExternalTeamsRouter } from '../src/routes/external/teams.js'
import { createExternalUsersRouter } from '../src/routes/external/users.js'
import { signExternalSessionToken } from '../src/utils/auth/externalSessionAuthToken.js'

const directory = vi.hoisted(() => ({
  listTeams: vi.fn(),
  listMembers: vi.fn(),
  findMemberRole: vi.fn(),
  getTeamContexts: vi.fn(),
  getTeamAgents: vi.fn(),
}))
const authority = vi.hoisted(() => ({
  validateLegacyUserSession: vi.fn(),
  getLiveTeamMembership: vi.fn(),
}))
const rateLimit = vi.hoisted(() => ({ checkAndIncrement: vi.fn() }))

vi.mock('../src/services/directory/index.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/services/directory/index.js')>()),
  ...directory,
}))
vi.mock('../src/services/auth/userSessionService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/services/auth/userSessionService.js')>()),
  validateLegacyUserSession: authority.validateLegacyUserSession,
}))
vi.mock('../src/services/access/liveTeamAuthorization.js', () => ({
  getLiveTeamMembership: authority.getLiveTeamMembership,
}))
vi.mock('../src/services/rateLimiterService.js', () => rateLimit)

const member = {
  id: 'teammate-1',
  email: 'teammate@example.com',
  name: 'Teammate',
  role: 'member',
  status: 'active',
}
const memberReads = [
  ['member list', '/external/teams/team-1/members'],
  ['member role', '/external/teams/team-1/members/teammate-1/role'],
] as const
const directoryPath = '/external/users/user-1/team-directory'

function app() {
  const value = express()
  const gateway = { listResource: vi.fn(async () => []) }
  value.use(createExternalUsersRouter(gateway as never))
  value.use(createExternalTeamsRouter(gateway as never))
  return value
}

function sessionToken(userId = 'user-1') {
  // A selected-team claim is not authority for any of these reads.
  return signExternalSessionToken({
    userId,
    email: `${userId}@example.com`,
    teamId: 'team-1',
    role: 'admin',
    authGeneration: 1,
  })
}

function expectLiveMembership(userId: string, teamId: string) {
  expect(authority.getLiveTeamMembership).toHaveBeenCalledWith(
    userId,
    teamId,
    expect.objectContaining({ onDatabaseFailure: expect.any(Function) })
  )
}

describe('external member visibility', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    authority.validateLegacyUserSession.mockImplementation(async (_token, claims) => ({
      status: 'valid',
      identity: { jti: 'member-visibility-session', userId: claims.userId },
    }))
    authority.getLiveTeamMembership.mockResolvedValue({ teamId: 'team-1', role: 'member' })
    directory.listTeams.mockResolvedValue({
      currentTeamId: 'team-1',
      items: [{ id: 'team-1', name: 'Core Team', role: 'member' }],
    })
    directory.listMembers.mockResolvedValue([member])
    directory.findMemberRole.mockResolvedValue({ role: 'member' })
    directory.getTeamContexts.mockResolvedValue({ contextIds: [] })
    directory.getTeamAgents.mockResolvedValue({ agentNames: [] })
    rateLimit.checkAndIncrement.mockResolvedValue({
      allowed: true,
      remaining: 9,
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
      count: 1,
      backendAvailable: true,
    })
  })

  describe.each(['admin', 'inviter', 'member'] as const)('current %s', role => {
    beforeEach(() => {
      authority.getLiveTeamMembership.mockResolvedValue({ teamId: 'team-1', role })
      directory.listTeams.mockResolvedValue({
        currentTeamId: 'team-1',
        items: [{ id: 'team-1', name: 'Core Team', role }],
      })
    })

    it('lists directory members with only the dev member fields', async () => {
      directory.listMembers.mockResolvedValue([
        { ...member, display_name: 'Private display name', channels: { emails: ['private'] } },
      ])

      const response = await request(app())
        .get(directoryPath)
        .set('x-user-session-token', sessionToken())
        .expect(200)

      expect(response.body).toEqual({
        currentTeamId: 'team-1',
        truncated: false,
        complete: true,
        partialErrors: [],
        items: [
          {
            team: { id: 'team-1', name: 'Core Team', role },
            members: [member],
            contextIds: [],
            agentNames: [],
          },
        ],
      })
      expect(directory.listTeams).toHaveBeenCalledWith('user-1', 'team-1')
      expect(directory.listMembers).toHaveBeenCalledWith('team-1')
    })

    it('reads the team member list', async () => {
      const response = await request(app())
        .get(memberReads[0][1])
        .set('x-user-session-token', sessionToken())
        .expect(200)

      expect(response.body).toEqual({ items: [member] })
      expectLiveMembership('user-1', 'team-1')
      expect(directory.listMembers).toHaveBeenCalledWith('team-1')
    })

    it('reads another team member role', async () => {
      const response = await request(app())
        .get(memberReads[1][1])
        .set('x-user-session-token', sessionToken())
        .expect(200)

      expect(response.body).toEqual({ role: 'member' })
      expectLiveMembership('user-1', 'team-1')
      expect(directory.findMemberRole).toHaveBeenCalledWith('team-1', 'teammate-1')
    })
  })

  it('reports a failed member source as incomplete for a plain member', async () => {
    directory.listMembers.mockRejectedValue(new Error('member source unavailable'))

    const response = await request(app())
      .get(directoryPath)
      .set('x-user-session-token', sessionToken())
      .expect(200)

    expect(directory.listMembers).toHaveBeenCalledWith('team-1')
    expect(response.body.complete).toBe(false)
    expect(response.body.partialErrors).toEqual([
      { teamId: 'team-1', source: 'members', code: 'unavailable' },
    ])
    expect(response.body.items[0].members).toEqual([])
  })

  it('denies another user directory after checking live session authority', async () => {
    const token = sessionToken()
    await request(app())
      .get('/external/users/unrelated-user/team-directory')
      .set('x-user-session-token', token)
      .expect(403, { error: 'Forbidden' })

    // User matching runs before directory membership enumeration.
    expect(authority.validateLegacyUserSession).toHaveBeenCalledWith(
      token,
      expect.objectContaining({ userId: 'user-1' }),
      expect.anything()
    )
    expect(directory.listTeams).not.toHaveBeenCalled()
    expect(directory.listMembers).not.toHaveBeenCalled()
  })

  describe.each(memberReads)('%s authorization', (_name, path) => {
    it.each([
      ['an unrelated user', 'unrelated-user', 'team-1'],
      ['a removed member with stale admin claims', 'user-1', 'team-1'],
      ['a cross-team id', 'user-1', 'other-team'],
    ])('denies %s after reading live membership', async (_case, userId, teamId) => {
      authority.getLiveTeamMembership.mockResolvedValue(null)

      await request(app())
        .get(path.replace('team-1', teamId))
        .set('x-user-session-token', sessionToken(userId))
        .expect(403, { error: 'Forbidden' })

      expectLiveMembership(userId, teamId)
      expect(directory.listMembers).not.toHaveBeenCalled()
      expect(directory.findMemberRole).not.toHaveBeenCalled()
    })
  })

  it.each([['directory', directoryPath], ...memberReads])(
    'denies a revoked session before the %s handler',
    async (_name, path) => {
      const token = sessionToken()
      authority.validateLegacyUserSession.mockResolvedValue({
        status: 'revoked',
        reason: 'legacy_token_revoked',
      })

      await request(app()).get(path).set('x-user-session-token', token).expect(401, {
        error: 'Unauthorized',
      })

      // A revoked session short-circuits before live team membership or data reads.
      expect(authority.validateLegacyUserSession).toHaveBeenCalledWith(
        token,
        expect.objectContaining({ userId: 'user-1' }),
        expect.anything()
      )
      expect(authority.getLiveTeamMembership).not.toHaveBeenCalled()
      expect(directory.listTeams).not.toHaveBeenCalled()
      expect(directory.listMembers).not.toHaveBeenCalled()
      expect(directory.findMemberRole).not.toHaveBeenCalled()
    }
  )
})
