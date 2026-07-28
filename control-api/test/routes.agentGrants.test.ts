import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import type { K8sGateway } from '../src/k8s.js'
import { createAdminTeamsRouter } from '../src/routes/admin/teams.js'
import { createAdminUsersRouter } from '../src/routes/admin/users.js'
import { MAX_DELETED_ACCESS_HISTORY } from '../src/services/directory/accessReconciliation.js'

const svc = vi.hoisted(() => ({
  addMemberToTeam: vi.fn(),
  adminDeleteTeam: vi.fn(),
  adminDeleteUser: vi.fn(),
  createAdminUser: vi.fn(),
  createInvitation: vi.fn(),
  createInvitationForTeams: vi.fn(),
  createPasswordSetupInvitationForUser: vi.fn(),
  createTeam: vi.fn(),
  findMembership: vi.fn(),
  getAdminUserContext: vi.fn(),
  getTeamAgents: vi.fn(),
  getTeamById: vi.fn(),
  getTeamContexts: vi.fn(),
  getUserAgents: vi.fn(),
  getUserContexts: vi.fn(),
  listAllPendingInvitationsAdmin: vi.fn(),
  listAllTeams: vi.fn(),
  listMembers: vi.fn(),
  listPendingInvitationsForTeam: vi.fn(),
  listTeamAgentsByTeam: vi.fn(),
  listTeamContextsByTeam: vi.fn(),
  listTeams: vi.fn(),
  listUsers: vi.fn(),
  renameTeam: vi.fn(),
  resendInvitation: vi.fn(),
  revokePendingInvitation: vi.fn(),
  setTeamAgents: vi.fn(),
  setTeamContexts: vi.fn(),
  setUserAgents: vi.fn(),
  setUserContexts: vi.fn(),
  softDeleteMember: vi.fn(),
  updateAdminUserContext: vi.fn(),
  updateMemberRole: vi.fn(),
}))

const serviceErrors = vi.hoisted(() => ({
  AgentGrantPreconditionError: class AgentGrantPreconditionError extends Error {},
}))

vi.mock('../src/services/directory/index.js', () => ({
  ...svc,
  AgentGrantPreconditionError: serviceErrors.AgentGrantPreconditionError,
}))

const TEST_ADMIN_SUB = '11111111-1111-4111-8111-111111111111'
const gatewayStub = { listResource: vi.fn(async () => []) }

function createApp() {
  const app = express()
  const router = express.Router()
  router.use((req, _res, next) => {
    ;(req as unknown as { adminAuth: { sub: string } }).adminAuth = { sub: TEST_ADMIN_SUB }
    next()
  })
  router.use(createAdminUsersRouter(gatewayStub as unknown as K8sGateway))
  router.use(createAdminTeamsRouter(gatewayStub as unknown as K8sGateway))
  app.use(express.json())
  app.use(router)
  return app
}

describe('routes/admin agent grants', () => {
  beforeEach(() => {
    Object.values(svc).forEach(fn => fn.mockReset())
    gatewayStub.listResource.mockReset()
    gatewayStub.listResource.mockResolvedValue([])
  })

  it('returns deleted history and requires a complete, valid precondition', async () => {
    gatewayStub.listResource.mockImplementation(async plural =>
      plural === 'hosts' ? [{ metadata: { name: 'agent-live' } }] : []
    )
    svc.getUserAgents.mockResolvedValue({ userId: 'u1', agentNames: ['agent-live', 'agent-old'] })
    svc.getTeamAgents.mockResolvedValue({ teamId: 't1', agentNames: ['agent-live', 'agent-old'] })
    const app = createApp()

    await request(app)
      .get('/admin/users/u1/agents')
      .expect(200)
      .expect({
        userId: 'u1',
        agentNames: ['agent-live'],
        deletedAgentNames: ['agent-old'],
        deletedHistoryLimit: MAX_DELETED_ACCESS_HISTORY,
      })
    await request(app)
      .get('/admin/teams/t1/agents')
      .expect(200)
      .expect({
        teamId: 't1',
        agentNames: ['agent-live'],
        deletedAgentNames: ['agent-old'],
        deletedHistoryLimit: MAX_DELETED_ACCESS_HISTORY,
      })
    await request(app)
      .put('/admin/users/u1/agents')
      .send({ agentNames: ['agent-live'] })
      .expect(428, { error: 'agent_grant_precondition_required' })
    await request(app)
      .put('/admin/teams/t1/agents')
      .send({ agentNames: ['agent-live'], expectedCurrentAgentNames: 'agent-live' })
      .expect(400, { error: 'invalid_agent_grant_precondition' })
  })

  it('derives the durable replacement server-side and forwards the full CAS snapshot', async () => {
    gatewayStub.listResource.mockImplementation(async plural =>
      plural === 'hosts' ? [{ metadata: { name: 'agent-live' } }] : []
    )
    svc.getUserAgents.mockResolvedValue({ userId: 'u1', agentNames: ['agent-live', 'agent-old'] })
    svc.getTeamAgents.mockResolvedValue({ teamId: 't1', agentNames: ['agent-live', 'agent-old'] })
    svc.setUserAgents.mockResolvedValue({ userId: 'u1', agentNames: ['agent-live', 'agent-old'] })
    svc.setTeamAgents.mockResolvedValue({ teamId: 't1', agentNames: ['agent-live', 'agent-old'] })
    const body = {
      agentNames: ['agent-live'],
      replacementAgentNames: ['agent-live', 'forged-agent'],
      expectedCurrentAgentNames: ['agent-old', 'agent-live'],
    }
    const app = createApp()

    await request(app).put('/admin/users/u1/agents').send(body).expect(200)
    await request(app).put('/admin/teams/t1/agents').send(body).expect(200)

    expect(svc.setUserAgents).toHaveBeenCalledWith(
      'u1',
      ['agent-live', 'agent-old'],
      TEST_ADMIN_SUB,
      body.expectedCurrentAgentNames
    )
    expect(svc.setTeamAgents).toHaveBeenCalledWith(
      't1',
      ['agent-live', 'agent-old'],
      TEST_ADMIN_SUB,
      body.expectedCurrentAgentNames
    )
  })

  it('rejects stale and ABA snapshots before they can supply deleted history', async () => {
    gatewayStub.listResource.mockImplementation(async plural =>
      plural === 'hosts' ? [{ metadata: { name: 'agent-live' } }] : []
    )
    svc.getUserAgents.mockResolvedValue({
      userId: 'u1',
      agentNames: ['agent-live', 'deleted-from-a'],
    })
    svc.getTeamAgents.mockResolvedValue({
      teamId: 't1',
      agentNames: ['agent-live', 'deleted-from-a'],
    })
    const body = {
      agentNames: ['agent-live'],
      expectedCurrentAgentNames: ['agent-live', 'deleted-from-b'],
    }
    const app = createApp()

    await request(app)
      .put('/admin/users/u1/agents')
      .send(body)
      .expect(412, { error: 'precondition_failed' })
    await request(app)
      .put('/admin/teams/t1/agents')
      .send(body)
      .expect(412, { error: 'precondition_failed' })
    expect(svc.setUserAgents).not.toHaveBeenCalled()
    expect(svc.setTeamAgents).not.toHaveBeenCalled()
  })

  it('allows only one concurrent replacement for the same complete snapshot', async () => {
    gatewayStub.listResource.mockImplementation(async plural =>
      plural === 'hosts' ? [{ metadata: { name: 'agent-live' } }] : []
    )
    const app = createApp()
    const stale = ['agent-live', 'agent-deleted']

    for (const [path, getCurrent, replace, identity] of [
      ['/admin/users/u1/agents', svc.getUserAgents, svc.setUserAgents, 'userId'],
      ['/admin/teams/t1/agents', svc.getTeamAgents, svc.setTeamAgents, 'teamId'],
    ]) {
      let current = stale
      getCurrent.mockImplementation(async () => ({ [identity]: path.includes('/users/') ? 'u1' : 't1', agentNames: current }))
      replace.mockImplementation(async (_id: string, replacement: string[], _operator: string, expected: string[]) => {
        if (!accessSetsEqual(expected, current)) throw new serviceErrors.AgentGrantPreconditionError()
        current = replacement
        return { [identity]: path.includes('/users/') ? 'u1' : 't1', agentNames: replacement }
      })

      const responses = await Promise.all([
        request(app).put(path).send({ agentNames: [], expectedCurrentAgentNames: stale }),
        request(app).put(path).send({ agentNames: [], expectedCurrentAgentNames: stale }),
      ])
      expect(responses.map(response => response.status).sort()).toEqual([200, 412])
      expect(current).toEqual(['agent-deleted'])
    }
  })

  it('maps deleted-history overflow and the locked setter precondition to the public contract', async () => {
    const retained = Array.from(
      { length: MAX_DELETED_ACCESS_HISTORY + 1 },
      (_value, index) => `agent-deleted-${index}`
    )
    gatewayStub.listResource.mockImplementation(async plural =>
      plural === 'hosts' ? [{ metadata: { name: 'agent-live' } }] : []
    )
    svc.getUserAgents.mockResolvedValue({ userId: 'u1', agentNames: ['agent-live', ...retained] })
    svc.getTeamAgents.mockResolvedValue({ teamId: 't1', agentNames: ['agent-live'] })
    svc.setTeamAgents.mockRejectedValue(new serviceErrors.AgentGrantPreconditionError())
    const app = createApp()

    await request(app)
      .put('/admin/users/u1/agents')
      .send({ agentNames: ['agent-live'], expectedCurrentAgentNames: ['agent-live', ...retained] })
      .expect(409, {
        error: 'deleted_agent_history_limit_exceeded',
        deletedHistoryLimit: MAX_DELETED_ACCESS_HISTORY,
      })
    await request(app)
      .put('/admin/teams/t1/agents')
      .send({ agentNames: ['agent-live'], expectedCurrentAgentNames: ['agent-live'] })
      .expect(412, { error: 'precondition_failed' })
    expect(svc.setUserAgents).not.toHaveBeenCalled()
  })

  it('reports a reconciliation outage without attempting an agent-grant update', async () => {
    gatewayStub.listResource.mockRejectedValue(new Error('k8s unavailable'))
    svc.getUserContexts.mockResolvedValue({ userId: 'u1', contextIds: ['ctx-live'] })
    svc.getTeamAgents.mockResolvedValue({ teamId: 't1', agentNames: ['agent-live'] })
    const app = createApp()

    await request(app)
      .get('/admin/users/u1/contexts')
      .expect(503, { error: 'context_reconciliation_unavailable' })
    await request(app)
      .get('/admin/teams/t1/agents')
      .expect(503, { error: 'agent_reconciliation_unavailable' })
    expect(svc.setTeamAgents).not.toHaveBeenCalled()
  })
})

function accessSetsEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every(value => right.includes(value))
}
