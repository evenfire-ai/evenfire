import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import type { K8sGateway } from '../src/k8s.js'
import { createAdminRouter } from '../src/routes/admin/index.js'

const svc = vi.hoisted(() => ({
  adminDeleteTeam: vi.fn(),
  adminDeleteUser: vi.fn(),
  createInvitation: vi.fn(),
  createInvitationForTeams: vi.fn(),
  createTeam: vi.fn(),
  findMembership: vi.fn(),
  getAdminUserContext: vi.fn(),
  getTeamAgents: vi.fn(),
  getTeamById: vi.fn(),
  getTeamContexts: vi.fn(),
  getUserAgents: vi.fn(),
  getUserContexts: vi.fn(),
  listTeamsByAgent: vi.fn(),
  listTeamsByContext: vi.fn(),
  listUsersByAgent: vi.fn(),
  listUsersByContext: vi.fn(),
  listUsers: vi.fn(),
  listMembers: vi.fn(),
  listPendingInvitationsForTeam: vi.fn(),
  listTeams: vi.fn(),
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

vi.mock('../src/services/directory/index.js', () => svc)

describe('routes/profileAdmin', () => {
  const gatewayStub = {
    listResource: vi.fn(async () => []),
    getResource: vi.fn(async () => ({}) as never),
    createResource: vi.fn(async () => ({}) as never),
    updateResource: vi.fn(async () => ({}) as never),
    deleteResource: vi.fn(async () => ({}) as never),
    listSecrets: vi.fn(async () => []),
    createSecret: vi.fn(async () => ({}) as never),
    updateSecret: vi.fn(async () => ({}) as never),
    deleteSecret: vi.fn(async () => ({}) as never),
    getHostOverview: vi.fn(async () => ({}) as never),
  }

  beforeEach(() => {
    Object.values(svc).forEach(fn => fn.mockReset())
    ;(gatewayStub.listResource as any).mockReset()
    ;(gatewayStub.getResource as any).mockReset()
    ;(gatewayStub.createResource as any).mockReset()
    ;(gatewayStub.updateResource as any).mockReset()
    ;(gatewayStub.deleteResource as any).mockReset()
    ;(gatewayStub.listSecrets as any).mockReset()
    ;(gatewayStub.createSecret as any).mockReset()
    ;(gatewayStub.updateSecret as any).mockReset()
    ;(gatewayStub.deleteSecret as any).mockReset()
    ;(gatewayStub.getHostOverview as any).mockReset()
    ;(gatewayStub.listSecrets as any).mockResolvedValue([])
    ;(gatewayStub.listResource as any).mockResolvedValue([])
  })

  it('supports positive admin profile flow', async () => {
    ;(gatewayStub.listResource as any).mockImplementation(async (plural: string) => {
      if (plural === 'contexts') {
        return [{ metadata: { name: 'ctx-a' }, spec: { contextId: 'ctx-a' } }]
      }
      if (plural === 'hosts') {
        return [{ metadata: { name: 'agent-a' }, spec: { enabled: true } }]
      }
      return []
    })
    svc.listUsers.mockResolvedValue([{ id: 'u1' }])
    svc.setUserContexts.mockResolvedValue({ userId: 'u1', contextIds: ['ctx-a'] })
    svc.getUserContexts.mockResolvedValue({ userId: 'u1', contextIds: ['ctx-a'] })
    svc.setUserAgents.mockResolvedValue({ userId: 'u1', agentNames: ['agent-a'] })
    svc.getUserAgents.mockResolvedValue({ userId: 'u1', agentNames: ['agent-a'] })
    svc.setTeamContexts.mockResolvedValue({ teamId: 't1', contextIds: ['ctx-a'] })
    svc.getTeamContexts.mockResolvedValue({ teamId: 't1', contextIds: ['ctx-a'] })
    svc.setTeamAgents.mockResolvedValue({ teamId: 't1', agentNames: ['agent-a'] })
    svc.getTeamAgents.mockResolvedValue({ teamId: 't1', agentNames: ['agent-a'] })
    svc.createInvitation.mockResolvedValue({ id: 'inv1' })
    svc.createInvitationForTeams.mockResolvedValue({ id: 'inv1' })
    svc.listUsersByContext.mockResolvedValue([{ id: 'u1', email: 'u@example.com' }])
    svc.listTeamsByContext.mockResolvedValue([{ id: 't1', name: 'team-1' }])
    svc.listUsersByAgent.mockResolvedValue([{ id: 'u1', email: 'u@example.com' }])
    svc.listTeamsByAgent.mockResolvedValue([{ id: 't1', name: 'team-1' }])

    const app = express()
    app.use(express.json())
    app.use(createAdminRouter(gatewayStub as unknown as K8sGateway))

    await request(app).get('/admin/users?q=test').expect(200)
    await request(app)
      .put('/admin/users/u1/contexts')
      .send({ contextIds: ['ctx-a'] })
      .expect(200)
    await request(app).get('/admin/users/u1/contexts').expect(200)
    await request(app)
      .put('/admin/users/u1/agents')
      .send({ agentNames: ['agent-a'] })
      .expect(200)
    await request(app).get('/admin/users/u1/agents').expect(200)
    await request(app)
      .put('/admin/teams/t1/contexts')
      .send({ contextIds: ['ctx-a'] })
      .expect(200)
    await request(app).get('/admin/teams/t1/contexts').expect(200)
    await request(app)
      .put('/admin/teams/t1/agents')
      .send({ agentNames: ['agent-a'] })
      .expect(200)
    await request(app).get('/admin/teams/t1/agents').expect(200)
    svc.getTeamById.mockResolvedValue({ id: 't1', name: 'team-1' })
    svc.listPendingInvitationsForTeam.mockResolvedValue([
      {
        id: 'inv-1',
        team_id: 't1',
        email: 'pending@example.com',
        role: 'member',
        status: 'pending',
        created_at: new Date('2026-01-01T00:00:00.000Z'),
      },
    ])
    const pendingRes = await request(app).get('/admin/teams/t1/invitations').expect(200)
    expect(pendingRes.body.items).toHaveLength(1)
    expect(svc.listPendingInvitationsForTeam).toHaveBeenCalledWith('t1')
    await request(app)
      .post('/admin/teams/t1/invitations')
      .send({ name: 'User Name', email: 'u@example.com', role: 'member' })
      .expect(200)
    expect(svc.createInvitation).toHaveBeenCalledWith('t1', 'User Name', 'u@example.com', 'member')
    await request(app)
      .post('/admin/invitations')
      .send({ name: 'Teamless User', email: 'teamless@example.com', role: 'member' })
      .expect(200)
    expect(svc.createInvitationForTeams).toHaveBeenCalledWith({
      inviteeName: 'Teamless User',
      email: 'teamless@example.com',
      purpose: 'member_invitation',
      teamAssignments: [],
      fallbackRole: 'member',
    })
    const byContext = await request(app).get('/admin/contexts/ctx-a/users').expect(200)
    expect(byContext.body.items).toHaveLength(1)
    const teamsByContext = await request(app).get('/admin/contexts/ctx-a/teams').expect(200)
    expect(teamsByContext.body.items).toHaveLength(1)
    const usersByAgent = await request(app).get('/admin/agents/agent-a/users').expect(200)
    expect(usersByAgent.body.items).toHaveLength(1)
    const teamsByAgent = await request(app).get('/admin/agents/agent-a/teams').expect(200)
    expect(teamsByAgent.body.items).toHaveLength(1)
  })

  it('rejects Control UI member invitations when an active member already uses the email', async () => {
    svc.listUsers.mockResolvedValue([{ id: 'user-1', email: 'existing@example.com' }])

    const app = express()
    app.use(express.json())
    app.use(createAdminRouter(gatewayStub as unknown as K8sGateway))

    const res = await request(app)
      .post('/admin/invitations')
      .send({ name: 'Existing Member', email: 'existing@example.com', role: 'member' })
      .expect(409)

    expect(res.body).toEqual({
      error: 'member_email_exists',
      message:
        'A member with this email already exists. Open the existing member and add them to more teams instead.',
      memberId: 'user-1',
      email: 'existing@example.com',
    })
    expect(svc.createInvitationForTeams).not.toHaveBeenCalled()
  })

  it('returns deleted context history but active-only agent grants for admin user/team views', async () => {
    ;(gatewayStub.listResource as any).mockImplementation(async (plural: string) => {
      if (plural === 'contexts') {
        return [{ metadata: { name: 'ctx-live' }, spec: { contextId: 'ctx-alias' } }]
      }
      if (plural === 'hosts') {
        return [{ metadata: { name: 'agent-live' }, spec: { enabled: false } }]
      }
      return []
    })
    svc.getUserContexts.mockResolvedValue({ userId: 'u1', contextIds: ['ctx-live', 'ctx-old'] })
    svc.getUserAgents.mockResolvedValue({
      userId: 'u1',
      agentNames: ['agent-live', 'agent-old'],
    })
    svc.getTeamContexts.mockResolvedValue({ teamId: 't1', contextIds: ['ctx-live', 'ctx-old'] })
    svc.getTeamAgents.mockResolvedValue({
      teamId: 't1',
      agentNames: ['agent-live', 'agent-old'],
    })

    const app = express()
    app.use(express.json())
    app.use(createAdminRouter(gatewayStub as unknown as K8sGateway))

    await request(app)
      .get('/admin/users/u1/contexts')
      .expect(200)
      .expect({ userId: 'u1', contextIds: ['ctx-live'], deletedContextIds: ['ctx-old'] })
    await request(app)
      .get('/admin/users/u1/agents')
      .expect(200)
      .expect({ userId: 'u1', agentNames: ['agent-live'] })
    await request(app)
      .get('/admin/teams/t1/contexts')
      .expect(200)
      .expect({ teamId: 't1', contextIds: ['ctx-live'], deletedContextIds: ['ctx-old'] })
    await request(app)
      .get('/admin/teams/t1/agents')
      .expect(200)
      .expect({ teamId: 't1', agentNames: ['agent-live'] })
  })

  it('preserves deleted context history but drops stale agent grants on admin updates', async () => {
    ;(gatewayStub.listResource as any).mockImplementation(async (plural: string) => {
      if (plural === 'contexts') {
        return [{ metadata: { name: 'ctx-live' }, spec: { contextId: 'ctx-alias' } }]
      }
      if (plural === 'hosts') {
        return [{ metadata: { name: 'agent-live' }, spec: { enabled: false } }]
      }
      return []
    })
    svc.getUserContexts.mockResolvedValue({ userId: 'u1', contextIds: ['ctx-old'] })
    svc.setUserContexts.mockResolvedValue({ userId: 'u1', contextIds: ['ctx-live', 'ctx-old'] })
    svc.setUserAgents.mockResolvedValue({
      userId: 'u1',
      agentNames: ['agent-live'],
    })
    svc.setTeamAgents.mockResolvedValue({
      teamId: 't1',
      agentNames: ['agent-live'],
    })

    const app = express()
    app.use(express.json())
    app.use(createAdminRouter(gatewayStub as unknown as K8sGateway))

    await request(app)
      .put('/admin/users/u1/contexts')
      .send({ contextIds: ['ctx-live', 'ctx-stale-submit'] })
      .expect(200)
      .expect({ userId: 'u1', contextIds: ['ctx-live'], deletedContextIds: ['ctx-old'] })
    expect(svc.setUserContexts).toHaveBeenCalledWith('u1', ['ctx-live', 'ctx-old'])

    await request(app)
      .put('/admin/users/u1/agents')
      .send({ agentNames: ['agent-live', 'agent-stale-submit'] })
      .expect(200)
      .expect({ userId: 'u1', agentNames: ['agent-live'] })
    expect(svc.setUserAgents).toHaveBeenCalledWith('u1', ['agent-live'])

    await request(app)
      .put('/admin/teams/t1/agents')
      .send({ agentNames: ['agent-live', 'agent-stale-submit'] })
      .expect(200)
      .expect({ teamId: 't1', agentNames: ['agent-live'] })
    expect(svc.setTeamAgents).toHaveBeenCalledWith('t1', ['agent-live'])
  })

  it('returns structured 503s when admin access reconciliation is unavailable', async () => {
    ;(gatewayStub.listResource as any).mockRejectedValue(new Error('k8s unavailable'))
    svc.getUserContexts.mockResolvedValue({ userId: 'u1', contextIds: ['ctx-live'] })
    svc.getTeamAgents.mockResolvedValue({ teamId: 't1', agentNames: ['agent-live'] })

    const app = express()
    app.use(express.json())
    app.use(createAdminRouter(gatewayStub as unknown as K8sGateway))

    await request(app)
      .get('/admin/users/u1/contexts')
      .expect(503)
      .expect({ error: 'context_reconciliation_unavailable' })
    await request(app)
      .put('/admin/teams/t1/agents')
      .send({ agentNames: ['agent-live'] })
      .expect(503)
      .expect({ error: 'agent_reconciliation_unavailable' })
  })

  it('handles invalid payloads and not-found branches', async () => {
    svc.renameTeam.mockResolvedValue(null)
    svc.updateAdminUserContext.mockResolvedValue(null)

    const app = express()
    app.use(express.json())
    app.use(createAdminRouter(gatewayStub as unknown as K8sGateway))

    await request(app).post('/admin/teams').send({ userId: '', name: '' }).expect(400)
    await request(app)
      .post('/admin/teams/t1/invitations')
      .send({ name: '', email: '', role: 'bad-role' })
      .expect(400)
    await request(app)
      .patch('/admin/teams/t1/members/u1/role')
      .send({ role: 'bad-role' })
      .expect(400)
    await request(app).put('/admin/teams/t1/name').send({ name: ' ' }).expect(400)
    await request(app).put('/admin/users/u1/context').send({ email: 'a@b.com' }).expect(404)
    await request(app).put('/admin/teams/t1/name').send({ name: 'new' }).expect(404)
  })

  it('creates admin teams without seeding a membership', async () => {
    svc.createTeam.mockResolvedValue({ id: 't-new', name: 'New Team' })

    const app = express()
    app.use(express.json())
    app.use(createAdminRouter(gatewayStub as unknown as K8sGateway))

    const res = await request(app)
      .post('/admin/teams')
      .send({ userId: 'legacy-user-id', name: 'New Team' })
      .expect(200)

    expect(res.body).toEqual({ id: 't-new', name: 'New Team' })
    expect(svc.createTeam).toHaveBeenCalledWith('New Team')
  })

  it('rejects malformed teamless invitation ids before database lookup', async () => {
    const app = express()
    app.use(express.json())
    app.use(createAdminRouter(gatewayStub as unknown as K8sGateway))

    await request(app).post('/admin/invitations/not-a-uuid/resend').expect(400)
    await request(app).delete('/admin/invitations/not-a-uuid').expect(400)

    expect(svc.resendInvitation).not.toHaveBeenCalled()
    expect(svc.revokePendingInvitation).not.toHaveBeenCalled()
  })

  it('passes optional member name updates through user context route', async () => {
    svc.updateAdminUserContext.mockResolvedValue({
      id: 'u1',
      email: 'member@example.com',
      name: 'Member Name',
      picture: null,
      displayName: 'Member Name',
      channels: {
        emails: [],
        telegramHandles: [],
        slackUserNames: [],
        telegramIds: [],
        discordUserNames: [],
        whatsappNumbers: [],
      },
    })

    const app = express()
    app.use(express.json())
    app.use(createAdminRouter(gatewayStub as unknown as K8sGateway))

    await request(app)
      .put('/admin/users/u1/context')
      .send({
        email: 'member@example.com',
        name: 'Member Name',
        channels: {
          emails: [],
          telegramHandles: [],
          slackUserNames: [],
          telegramIds: [],
          discordUserNames: [],
          whatsappNumbers: [],
        },
      })
      .expect(200)

    expect(svc.updateAdminUserContext).toHaveBeenCalledWith(
      'u1',
      'member@example.com',
      'Member Name',
      {
        emails: [],
        telegramHandles: [],
        slackUserNames: [],
        telegramIds: [],
        discordUserNames: [],
        whatsappNumbers: [],
      }
    )
  })

  it('DELETE /admin/teams/:teamId returns 200 or 404', async () => {
    const app = express()
    app.use(express.json())
    app.use(createAdminRouter(gatewayStub as unknown as K8sGateway))

    svc.adminDeleteTeam.mockResolvedValueOnce({ ok: true, id: 't1' })
    const ok = await request(app).delete('/admin/teams/t1').expect(200)
    expect(ok.body).toEqual({ deleted: true, id: 't1' })

    svc.adminDeleteTeam.mockResolvedValueOnce({ error: 'not_found' })
    await request(app).delete('/admin/teams/missing').expect(404)
  })

  it('DELETE /admin/teams/:teamId returns 409 when the team still has members', async () => {
    const app = express()
    app.use(express.json())
    app.use(createAdminRouter(gatewayStub as unknown as K8sGateway))

    svc.adminDeleteTeam.mockResolvedValueOnce({ error: 'team_not_empty' })

    const conflict = await request(app).delete('/admin/teams/t1').expect(409)
    expect(conflict.body).toEqual({ error: 'team_not_empty' })
  })

  it('DELETE /admin/teams/:teamId returns 409 when audit history retains the team', async () => {
    const app = express()
    app.use(express.json())
    app.use(createAdminRouter(gatewayStub as unknown as K8sGateway))

    for (const constraint of [
      'workflow_recipe_allowed_teams_audit_target_team_id_fkey',
      'team_workflow_grants_audit_target_team_id_fkey',
    ]) {
      const fkError = Object.assign(new Error('foreign key violation'), {
        code: '23503',
        constraint,
      })
      svc.adminDeleteTeam.mockRejectedValueOnce(fkError)

      const conflict = await request(app).delete('/admin/teams/t1').expect(409)
      expect(conflict.body).toEqual({ error: 'team_has_audit_history' })
    }
  })

  it('DELETE /admin/users/:userId returns 200 or 404', async () => {
    const app = express()
    app.use(express.json())
    app.use(createAdminRouter(gatewayStub as unknown as K8sGateway))

    svc.adminDeleteUser.mockResolvedValueOnce({ ok: true, id: 'u1' })
    const ok = await request(app).delete('/admin/users/u1').expect(200)
    expect(ok.body).toEqual({ deleted: true, id: 'u1' })

    svc.adminDeleteUser.mockResolvedValueOnce({ error: 'not_found' })
    await request(app).delete('/admin/users/missing').expect(404)
  })
})
