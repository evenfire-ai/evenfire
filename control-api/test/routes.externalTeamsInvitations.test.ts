import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createExternalTeamsRouter } from '../src/routes/external/teams.js'

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

vi.mock('../src/middleware/externalSessionAuth.js', () => ({
  requireValidExternalSessionToken: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction
  ) => {
    ;(req as express.Request & { externalAuth?: { userId: string } }).externalAuth = {
      userId: 'manager-1',
    }
    next()
  },
  requireExternalTeamParamMatch:
    () => (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
      next(),
  requireExternalUserParamMatch:
    () => (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
      next(),
  requireExternalRole:
    () => (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
      next(),
  rejectBodyUserTeamMismatch: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction
  ) => next(),
}))
vi.mock('../src/services/directory/index.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/services/directory/index.js')>()),
  ...directory,
}))

function app() {
  const value = express()
  value.use(express.json())
  value.use(createExternalTeamsRouter({} as never))
  return value
}

describe('legacy external team invitation responses', () => {
  beforeEach(() => vi.clearAllMocks())

  it('never serializes the invitation acceptance capability', async () => {
    directory.createManagedInvitationForUser.mockResolvedValueOnce({
      invitation: { id: 'inv-1', token: 'must-never-leave-control-api' },
    })

    const response = await request(app())
      .post('/external/teams/team-1/invitations')
      .send({ email: 'invitee@example.com', name: 'Invitee', role: 'member' })

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ id: 'inv-1' })
    expect(JSON.stringify(response.body)).not.toContain('must-never-leave-control-api')
  })
})
