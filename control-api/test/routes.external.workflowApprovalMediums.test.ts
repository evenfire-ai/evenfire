import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createExternalWorkflowApprovalMediumsRouter } from '../src/routes/external/workflow-approval-mediums.routes.js'

const identityServiceMock = vi.hoisted(() => ({
  confirmMediumChallenge: vi.fn(),
  createMediumChallenge: vi.fn(),
}))

const preferenceServiceMock = vi.hoisted(() => ({
  listVerifiedMediumAccountsWithPreference: vi.fn(),
  preferVerifiedMediumAccount: vi.fn(),
  updateVerifiedMediumAccountDisplayName: vi.fn(),
}))

const providerEventMock = vi.hoisted(() => ({
  attachTelegramTargetsToAccounts: vi.fn(),
  disableVerifiedMediumAccountWithTelegramAssociations: vi.fn(),
  isTelegramProviderEventChallengeForUser: vi.fn(),
}))

const telegramTargetMock = vi.hoisted(() => ({
  createTelegramProviderEventChallenge: vi.fn(),
  listTelegramApprovalTargets: vi.fn(),
}))

const slackTargetMock = vi.hoisted(() => ({
  attachSlackTargetsToAccounts: vi.fn(),
  listSlackApprovalTargets: vi.fn(),
  resolveSlackProviderEventTarget: vi.fn(),
}))

const teamsTargetMock = vi.hoisted(() => ({
  attachTeamsTargetsToAccounts: vi.fn(),
  listTeamsApprovalTargets: vi.fn(),
  resolveTeamsProviderEventTarget: vi.fn(),
}))

const linkSessionMock = vi.hoisted(() => ({
  createMediumLinkSession: vi.fn(),
}))
const rateLimitMock = vi.hoisted(() => ({ checkAndIncrement: vi.fn() }))

vi.mock('../src/middleware/externalSessionAuth.js', () => ({
  requireValidExternalSessionToken: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction
  ) => {
    ;(req as express.Request & { externalAuth?: { userId: string } }).externalAuth = {
      userId: 'user-1',
    }
    next()
  },
}))

vi.mock('../src/middleware/mcpHostHttpMetrics.js', () => ({
  mcpHostHttpMetrics:
    () => (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
      next(),
}))

vi.mock('../src/services/workflowApprovalMediumIdentityService.js', () => identityServiceMock)
vi.mock('../src/services/workflowApprovalMediumPreferenceService.js', () => preferenceServiceMock)
vi.mock(
  '../src/services/workflowApprovalMediumTelegramProviderEventService.js',
  () => providerEventMock
)
vi.mock(
  '../src/services/workflowApprovalMediumTelegramVerificationService.js',
  () => telegramTargetMock
)
vi.mock('../src/services/workflowApprovalMediumSlackVerificationService.js', () => slackTargetMock)
vi.mock('../src/services/workflowApprovalMediumTeamsVerificationService.js', () => teamsTargetMock)
vi.mock('../src/services/workflowApprovalMediumLinkSessionService.js', () => linkSessionMock)
vi.mock('../src/services/rateLimiterService.js', () => rateLimitMock)

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use(createExternalWorkflowApprovalMediumsRouter({} as never))
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    }
  )
  return app
}

describe('external workflow approval medium routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    rateLimitMock.checkAndIncrement.mockResolvedValue({
      allowed: true,
      count: 1,
      remaining: 29,
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
    })
    linkSessionMock.createMediumLinkSession.mockReset()
    slackTargetMock.attachSlackTargetsToAccounts.mockImplementation(
      async (_gateway: unknown, _userId: string, accounts: unknown[]) => accounts
    )
    teamsTargetMock.attachTeamsTargetsToAccounts.mockImplementation(
      async (_gateway: unknown, _userId: string, accounts: unknown[]) => accounts
    )
  })

  it('rejects Telegram manual provider identity challenges', async () => {
    await request(makeApp())
      .post('/external/workflow-approval-mediums/challenges')
      .send({ medium: 'telegram', providerUserId: '123', providerChannelId: '123' })
      .expect(400, { error: 'telegram_target_required' })

    expect(identityServiceMock.createMediumChallenge).not.toHaveBeenCalled()
    expect(telegramTargetMock.createTelegramProviderEventChallenge).not.toHaveBeenCalled()
  })

  it('rejects Telegram target challenges that include manual provider identity', async () => {
    await request(makeApp())
      .post('/external/workflow-approval-mediums/challenges')
      .send({
        medium: 'telegram',
        providerUserId: '123',
        targetId: 'telegram:target',
      })
      .expect(400, { error: 'telegram_provider_identity_not_allowed' })

    expect(identityServiceMock.createMediumChallenge).not.toHaveBeenCalled()
    expect(telegramTargetMock.createTelegramProviderEventChallenge).not.toHaveBeenCalled()
  })

  it('keeps non-Telegram and non-Slack legacy challenges available', async () => {
    identityServiceMock.createMediumChallenge.mockResolvedValueOnce({
      id: 'challenge-1',
      expiresAt: '2026-06-02T12:00:00.000Z',
    })

    await request(makeApp())
      .post('/external/workflow-approval-mediums/challenges')
      .send({
        medium: 'discord',
        providerUserId: 'D123',
        providerWorkspaceId: 'guild-1',
      })
      .expect(202)

    expect(identityServiceMock.createMediumChallenge).toHaveBeenCalledWith({
      userId: 'user-1',
      identity: {
        medium: 'discord',
        providerUserId: 'D123',
        providerWorkspaceId: 'guild-1',
        providerChannelId: null,
      },
    })
  })

  it('creates Telegram target-scoped provider-event challenges', async () => {
    telegramTargetMock.createTelegramProviderEventChallenge.mockResolvedValueOnce({
      challengeId: 'challenge-1',
      code: '123456',
      expiresAt: '2026-06-02T12:00:00.000Z',
      target: { id: 'telegram:target', medium: 'telegram' },
    })

    await request(makeApp())
      .post('/external/workflow-approval-mediums/challenges')
      .send({ medium: 'telegram', targetId: 'telegram:target' })
      .expect(202)

    expect(telegramTargetMock.createTelegramProviderEventChallenge).toHaveBeenCalledWith({
      gateway: {},
      userId: 'user-1',
      targetId: 'telegram:target',
    })
  })

  it('rejects Telegram link sessions because Telegram verification must be target-scoped', async () => {
    linkSessionMock.createMediumLinkSession.mockRejectedValueOnce(
      new Error('telegram_target_required')
    )

    await request(makeApp())
      .post('/external/workflow-approval-mediums/link-sessions')
      .send({ medium: 'telegram' })
      .expect(400, { error: 'telegram_target_required' })
  })

  it('rejects Slack generic challenges because Slack verification must be target-scoped', async () => {
    await request(makeApp())
      .post('/external/workflow-approval-mediums/challenges')
      .send({
        medium: 'slack',
        providerUserId: 'U123',
        providerWorkspaceId: 'T123',
        providerChannelId: 'D123',
      })
      .expect(400, { error: 'slack_target_required' })
  })

  it('creates Slack link sessions for reader-driven channel-scoped enrollment', async () => {
    linkSessionMock.createMediumLinkSession.mockResolvedValueOnce({
      id: 'link-session-1',
      nonce: '123456',
      expiresAt: '2026-06-16T12:00:00.000Z',
      deepLinkUrl: null,
    })

    await request(makeApp())
      .post('/external/workflow-approval-mediums/link-sessions')
      .send({ medium: 'slack', providerWorkspaceId: 'T123' })
      .expect(202, {
        linkSessionId: 'link-session-1',
        nonce: '123456',
        expiresAt: '2026-06-16T12:00:00.000Z',
        deepLinkUrl: null,
      })

    expect(linkSessionMock.createMediumLinkSession).toHaveBeenCalledWith({
      userId: 'user-1',
      medium: 'slack',
      providerWorkspaceId: 'T123',
    })
  })

  it('rejects Slack link sessions without a workspace', async () => {
    linkSessionMock.createMediumLinkSession.mockRejectedValueOnce(
      new Error('slack_workspace_id_required')
    )

    await request(makeApp())
      .post('/external/workflow-approval-mediums/link-sessions')
      .send({ medium: 'slack' })
      .expect(400, { error: 'slack_workspace_id_required' })
  })

  it('creates Teams link sessions with the selected thread reply preference', async () => {
    teamsTargetMock.resolveTeamsProviderEventTarget.mockResolvedValueOnce({
      id: 'teams:target',
      medium: 'teams',
      providerWorkspaceId: 'tenant-1',
      channelNamespace: 'channels',
      channelName: 'teams-a',
    })
    linkSessionMock.createMediumLinkSession.mockResolvedValueOnce({
      id: 'link-session-1',
      nonce: '123456',
      expiresAt: '2026-06-16T12:00:00.000Z',
      deepLinkUrl: null,
    })

    await request(makeApp())
      .post('/external/workflow-approval-mediums/link-sessions')
      .send({ medium: 'teams', targetId: 'teams:target', replyInThreads: false })
      .expect(202)

    expect(linkSessionMock.createMediumLinkSession).toHaveBeenCalledWith({
      userId: 'user-1',
      medium: 'teams',
      providerWorkspaceId: 'tenant-1',
      communicationChannelRef: 'channels/teams-a',
      replyInThreads: false,
    })
  })

  it('lists disabled medium accounts only when requested', async () => {
    preferenceServiceMock.listVerifiedMediumAccountsWithPreference.mockResolvedValueOnce([
      {
        id: 'account-1',
        medium: 'telegram',
        providerUserId: '777',
        providerChannelId: '777',
        disabledAt: '2026-06-05T18:00:00.000Z',
      },
    ])
    providerEventMock.attachTelegramTargetsToAccounts.mockResolvedValueOnce([
      {
        id: 'account-1',
        medium: 'telegram',
        providerUserId: '777',
        providerChannelId: '777',
        disabledAt: '2026-06-05T18:00:00.000Z',
        targets: [],
      },
    ])

    await request(makeApp())
      .get('/external/workflow-approval-mediums?includeDisabled=true')
      .expect(200)

    expect(preferenceServiceMock.listVerifiedMediumAccountsWithPreference).toHaveBeenCalledWith(
      'user-1',
      { includeDisabled: true }
    )
    expect(providerEventMock.attachTelegramTargetsToAccounts).toHaveBeenCalledWith(
      {},
      'user-1',
      expect.arrayContaining([expect.objectContaining({ id: 'account-1' })])
    )
    expect(slackTargetMock.attachSlackTargetsToAccounts).toHaveBeenCalledWith(
      {},
      'user-1',
      expect.arrayContaining([expect.objectContaining({ id: 'account-1' })])
    )
    expect(teamsTargetMock.attachTeamsTargetsToAccounts).toHaveBeenCalledWith(
      {},
      'user-1',
      expect.arrayContaining([expect.objectContaining({ id: 'account-1' })])
    )
  })

  it('rate limits medium reads before listing accounts', async () => {
    rateLimitMock.checkAndIncrement.mockResolvedValueOnce({
      allowed: false,
      count: 31,
      remaining: 0,
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
    })

    const response = await request(makeApp()).get('/external/workflow-approval-mediums')

    expect(response.status).toBe(429)
    expect(rateLimitMock.checkAndIncrement).toHaveBeenCalledWith(
      'external_workflow_approval_medium_read:user:user-1',
      30
    )
    expect(preferenceServiceMock.listVerifiedMediumAccountsWithPreference).not.toHaveBeenCalled()
  })

  it('rate limits medium mutations before creating challenges', async () => {
    rateLimitMock.checkAndIncrement.mockResolvedValueOnce({
      allowed: false,
      count: 11,
      remaining: 0,
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
    })

    const response = await request(makeApp())
      .post('/external/workflow-approval-mediums/challenges')
      .send({ medium: 'email', providerUserId: 'user@example.com' })

    expect(response.status).toBe(429)
    expect(response.headers['retry-after']).toBeDefined()
    expect(rateLimitMock.checkAndIncrement).toHaveBeenCalledWith(
      'external_workflow_approval_medium_mutation:user:user-1',
      10
    )
    expect(identityServiceMock.createMediumChallenge).not.toHaveBeenCalled()
  })

  it('deletes workflow approval medium records through the Telegram association service', async () => {
    providerEventMock.disableVerifiedMediumAccountWithTelegramAssociations.mockResolvedValueOnce(
      true
    )

    await request(makeApp())
      .delete('/external/workflow-approval-mediums/99999999-8888-7777-6666-555555555555')
      .expect(204)

    expect(
      providerEventMock.disableVerifiedMediumAccountWithTelegramAssociations
    ).toHaveBeenCalledWith({
      gateway: {},
      userId: 'user-1',
      accountId: '99999999-8888-7777-6666-555555555555',
    })
  })

  it('updates workflow approval medium display names for the authenticated user', async () => {
    preferenceServiceMock.updateVerifiedMediumAccountDisplayName.mockResolvedValueOnce({
      id: '99999999-8888-7777-6666-555555555555',
      displayName: 'Leadership',
    })

    await request(makeApp())
      .patch(
        '/external/workflow-approval-mediums/99999999-8888-7777-6666-555555555555/display-name'
      )
      .send({ displayName: '  Leadership  ' })
      .expect(200, {
        ok: true,
        account: {
          id: '99999999-8888-7777-6666-555555555555',
          displayName: 'Leadership',
        },
      })

    expect(preferenceServiceMock.updateVerifiedMediumAccountDisplayName).toHaveBeenCalledWith({
      userId: 'user-1',
      accountId: '99999999-8888-7777-6666-555555555555',
      displayName: 'Leadership',
    })
  })

  it('rejects invalid workflow approval medium display names', async () => {
    await request(makeApp())
      .patch(
        '/external/workflow-approval-mediums/99999999-8888-7777-6666-555555555555/display-name'
      )
      .send({})
      .expect(400, { error: 'display_name_required' })

    await request(makeApp())
      .patch(
        '/external/workflow-approval-mediums/99999999-8888-7777-6666-555555555555/display-name'
      )
      .send({ displayName: 123 })
      .expect(400, { error: 'display_name_must_be_string' })

    expect(preferenceServiceMock.updateVerifiedMediumAccountDisplayName).not.toHaveBeenCalled()
  })
})
