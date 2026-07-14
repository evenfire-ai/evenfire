import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import type { K8sGateway } from '../src/k8s.js'
import { createAdminRouter } from '../src/routes/admin/index.js'

const directorySvc = vi.hoisted(() => ({
  adminDeleteTeam: vi.fn(),
  adminDeleteUser: vi.fn(),
  createInvitation: vi.fn(),
  createTeamForUser: vi.fn(),
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
const mediumSvc = vi.hoisted(() => ({
  createMediumLinkSession: vi.fn(),
  disableVerifiedMediumAccount: vi.fn(),
  listVerifiedMediumAccountsWithPreference: vi.fn(),
  preferVerifiedMediumAccount: vi.fn(),
}))

vi.mock('../src/services/directory/index.js', () => directorySvc)
vi.mock('../src/services/workflowApprovalMediumIdentityService.js', () => ({
  disableVerifiedMediumAccount: mediumSvc.disableVerifiedMediumAccount,
}))
vi.mock('../src/services/workflowApprovalMediumLinkSessionService.js', () => ({
  createMediumLinkSession: mediumSvc.createMediumLinkSession,
}))
vi.mock('../src/services/workflowApprovalMediumPreferenceService.js', () => ({
  listVerifiedMediumAccountsWithPreference: mediumSvc.listVerifiedMediumAccountsWithPreference,
  preferVerifiedMediumAccount: mediumSvc.preferVerifiedMediumAccount,
}))

describe('routes/admin user workflow approval media', () => {
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

  function app() {
    const instance = express()
    instance.use(express.json())
    instance.use(createAdminRouter(gatewayStub as unknown as K8sGateway))
    return instance
  }

  beforeEach(() => {
    Object.values(directorySvc).forEach(fn => fn.mockReset())
    Object.values(mediumSvc).forEach(fn => fn.mockReset())
  })

  it('manages verified media without mutating profile contact channels', async () => {
    const accountId = '11111111-1111-4111-8111-111111111111'
    directorySvc.getAdminUserContext.mockResolvedValue({
      id: 'u1',
      email: 'user@example.com',
      channels: { emails: [], slackUserNames: [], telegramIds: [] },
    })
    mediumSvc.listVerifiedMediumAccountsWithPreference.mockResolvedValue([
      {
        id: accountId,
        userId: 'u1',
        medium: 'telegram',
        providerUserId: '9001',
        providerWorkspaceId: null,
        providerChannelId: '9001',
        isPreferred: true,
      },
    ])
    mediumSvc.createMediumLinkSession.mockResolvedValue({
      id: '22222222-2222-4222-8222-222222222222',
      nonce: 'nonce-a',
      expiresAt: '2026-06-01T00:10:00.000Z',
      deepLinkUrl: null,
    })
    mediumSvc.preferVerifiedMediumAccount.mockResolvedValue({
      id: accountId,
      userId: 'u1',
      medium: 'telegram',
      providerUserId: '9001',
      providerWorkspaceId: null,
      providerChannelId: '9001',
      isPreferred: true,
    })
    mediumSvc.disableVerifiedMediumAccount.mockResolvedValue(true)

    const listed = await request(app()).get('/admin/users/u1/workflow-approval-mediums').expect(200)
    expect(listed.body.items).toHaveLength(1)
    expect(mediumSvc.listVerifiedMediumAccountsWithPreference).toHaveBeenCalledWith('u1')

    const link = await request(app())
      .post('/admin/users/u1/workflow-approval-mediums/link-sessions')
      .send({ medium: 'slack', providerWorkspaceId: 'T123' })
      .expect(202)
    expect(link.body).toMatchObject({ nonce: 'nonce-a' })
    expect(mediumSvc.createMediumLinkSession).toHaveBeenCalledWith({
      userId: 'u1',
      medium: 'slack',
      providerWorkspaceId: 'T123',
    })

    await request(app())
      .put(`/admin/users/u1/workflow-approval-mediums/${accountId}/preference`)
      .expect(200)
    expect(mediumSvc.preferVerifiedMediumAccount).toHaveBeenCalledWith({
      userId: 'u1',
      accountId,
    })

    await request(app())
      .delete(`/admin/users/u1/workflow-approval-mediums/${accountId}`)
      .expect(204)
    expect(mediumSvc.disableVerifiedMediumAccount).toHaveBeenCalledWith({ userId: 'u1', accountId })
    expect(directorySvc.updateAdminUserContext).not.toHaveBeenCalled()
  })

  it('rejects link sessions for unknown users and Slack link sessions without workspace', async () => {
    directorySvc.getAdminUserContext.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'u1' })
    mediumSvc.createMediumLinkSession.mockRejectedValue(new Error('slack_workspace_id_required'))

    await request(app())
      .post('/admin/users/missing/workflow-approval-mediums/link-sessions')
      .send({ medium: 'telegram' })
      .expect(404)
    await request(app())
      .post('/admin/users/u1/workflow-approval-mediums/link-sessions')
      .send({ medium: 'slack' })
      .expect(400, { error: 'slack_workspace_id_required' })
  })

  it('rejects admin Telegram link sessions as target-scoped only', async () => {
    directorySvc.getAdminUserContext.mockResolvedValue({ id: 'u1' })
    mediumSvc.createMediumLinkSession.mockRejectedValue(new Error('telegram_target_required'))

    await request(app())
      .post('/admin/users/u1/workflow-approval-mediums/link-sessions')
      .send({ medium: 'telegram' })
      .expect(400, { error: 'telegram_target_required' })
  })
})
