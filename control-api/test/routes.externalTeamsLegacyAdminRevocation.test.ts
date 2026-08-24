import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createExternalTeamsRouter } from '../src/routes/external/teams.js'

const userId = '11111111-1111-4111-8111-111111111111'
const teamId = '22222222-2222-4222-8222-222222222222'
const targetUserId = '33333333-3333-4333-8333-333333333333'
const staleAdminToken = 'same-valid-v1-token-minted-while-admin'

const auth = vi.hoisted(() => ({ authenticateExternalUserSession: vi.fn() }))
const database = vi.hoisted(() => ({ query: vi.fn() }))
const rateLimit = vi.hoisted(() => ({ checkAndIncrement: vi.fn() }))
const directory = vi.hoisted(() => ({
  createManagedInvitationForUser: vi.fn(),
  createTeamForUser: vi.fn(),
  deleteManagedMemberForUser: vi.fn(),
  findMemberRole: vi.fn(),
  getCurrentTeam: vi.fn(),
  getTeamAgents: vi.fn(),
  getTeamContexts: vi.fn(),
  listMembers: vi.fn(),
  renameTeamForUser: vi.fn(),
  updateManagedMemberRoleForUser: vi.fn(),
}))

vi.mock('../src/services/auth/externalSessionAuthentication.js', () => auth)
vi.mock('../src/db.js', () => ({ pool: database }))
vi.mock('../src/services/rateLimiterService.js', () => rateLimit)
vi.mock('../src/services/directory/index.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/services/directory/index.js')>()),
  ...directory,
}))

type AdminMutation = Readonly<{
  name: string
  invoke: (server: express.Express) => request.Test
  handler: keyof Pick<
    typeof directory,
    'renameTeamForUser' | 'updateManagedMemberRoleForUser' | 'deleteManagedMemberForUser'
  >
}>

const mutations: readonly AdminMutation[] = [
  {
    name: 'rename team',
    invoke: server =>
      request(server).put(`/external/teams/${teamId}/name`).send({ name: 'Renamed' }),
    handler: 'renameTeamForUser',
  },
  {
    name: 'change member role',
    invoke: server =>
      request(server)
        .patch(`/external/teams/${teamId}/members/${targetUserId}/role`)
        .send({ role: 'member' }),
    handler: 'updateManagedMemberRoleForUser',
  },
  {
    name: 'delete member',
    invoke: server => request(server).delete(`/external/teams/${teamId}/members/${targetUserId}`),
    handler: 'deleteManagedMemberForUser',
  },
]

function app() {
  const server = express()
  server.use(express.json())
  server.use(createExternalTeamsRouter({} as never))
  return server
}

describe('legacy V1 live-admin revocation on real external team routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    auth.authenticateExternalUserSession.mockResolvedValue({
      status: 'authenticated',
      contract: 'v1',
      claims: {
        userId,
        email: 'admin@example.test',
        teamId,
        role: 'admin',
        authGeneration: 1,
        iat: 1_787_596_800,
        exp: 1_791_907_200,
      },
      authorityContext: {
        contract: 'v1',
        userId,
        tokenHash: 'a'.repeat(64),
        issuedAt: 1_787_596_800,
      },
    })
    rateLimit.checkAndIncrement.mockResolvedValue({
      allowed: true,
      count: 1,
      remaining: 9,
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
    })
    directory.renameTeamForUser.mockResolvedValue({ team: { id: teamId, name: 'Renamed' } })
    directory.updateManagedMemberRoleForUser.mockResolvedValue({
      membership: { userId: targetUserId, teamId, role: 'member' },
    })
    directory.deleteManagedMemberForUser.mockResolvedValue({ deleted: { userId: targetUserId } })
  })

  for (const mutation of mutations) {
    it.each([
      ['demoted', { rows: [{ team_id: teamId, role: 'member' }], rowCount: 1 }],
      ['membership removed', { rows: [], rowCount: 0 }],
    ])(`rejects ${mutation.name} with the same token after %s`, async (_state, membership) => {
      database.query.mockResolvedValue(membership)

      const response = await mutation.invoke(app()).set('x-user-session-token', staleAdminToken)

      expect(response.status).toBe(403)
      expect(directory[mutation.handler]).not.toHaveBeenCalled()
      expect(database.query).toHaveBeenCalledWith(expect.stringContaining("tm.status = 'active'"), [
        userId,
        teamId,
      ])
    })

    it(`allows ${mutation.name} only when the same token resolves to a current admin`, async () => {
      database.query.mockResolvedValue({
        rows: [{ team_id: teamId, role: 'admin' }],
        rowCount: 1,
      })

      const response = await mutation.invoke(app()).set('x-user-session-token', staleAdminToken)

      expect(response.status).toBe(200)
      expect(directory[mutation.handler]).toHaveBeenCalledOnce()
    })
  }
})
