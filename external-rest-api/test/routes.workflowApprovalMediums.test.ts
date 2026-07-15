import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createWorkflowApprovalMediumsRouter } from '../src/routes/workflowApprovalMediums.js'

const serviceMock = vi.hoisted(() => ({
  createWorkflowApprovalMediumLinkSession: vi.fn(),
  createWorkflowApprovalMediumChallenge: vi.fn(),
  confirmWorkflowApprovalMediumChallenge: vi.fn(),
  listApprovalChannelTargets: vi.fn(),
  listWorkflowApprovalMediums: vi.fn(),
  preferWorkflowApprovalMedium: vi.fn(),
  updateWorkflowApprovalMediumDisplayName: vi.fn(),
  disableWorkflowApprovalMedium: vi.fn(),
}))
const authTokenMock = vi.hoisted(() => ({
  verifyToken: vi.fn(),
}))

vi.mock('../src/services/workflowApprovalMediumsService.js', () => serviceMock)
vi.mock('../src/authToken.js', () => authTokenMock)

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use(createWorkflowApprovalMediumsRouter())
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    }
  )
  return app
}

describe('routes/workflowApprovalMediums', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    authTokenMock.verifyToken.mockReset()
  })

  it('requires a user session for medium challenge creation', async () => {
    await request(makeApp()).post('/workflow-approval-mediums/challenges').send({}).expect(401)
    expect(serviceMock.createWorkflowApprovalMediumChallenge).not.toHaveBeenCalled()
  })

  it('creates a reader-driven link session for Telegram enrollment', async () => {
    authTokenMock.verifyToken.mockReturnValueOnce({ userId: 'user-1', exp: 9999999999 })
    serviceMock.createWorkflowApprovalMediumLinkSession.mockResolvedValueOnce({
      linkSessionId: 'session-1',
      nonce: 'nonce-123',
      expiresAt: '2026-06-01T10:00:00.000Z',
      deepLinkUrl: 'https://t.me/clerum_approval_bot?start=nonce-123',
    })

    const res = await request(makeApp())
      .post('/workflow-approval-mediums/link-sessions')
      .set('Authorization', 'Bearer session-token')
      .send({ medium: 'telegram' })
      .expect(202)

    expect(res.body).toMatchObject({
      linkSessionId: 'session-1',
      deepLinkUrl: 'https://t.me/clerum_approval_bot?start=nonce-123',
    })
    expect(serviceMock.createWorkflowApprovalMediumLinkSession).toHaveBeenCalledWith(
      'session-token',
      {
        medium: 'telegram',
        providerWorkspaceId: null,
        targetId: null,
      }
    )
  })

  it('creates a first-party delivered challenge for a third-party medium identity', async () => {
    authTokenMock.verifyToken.mockReturnValueOnce({ userId: 'user-1', exp: 9999999999 })
    serviceMock.createWorkflowApprovalMediumChallenge.mockResolvedValueOnce({
      challengeId: 'challenge-1',
      expiresAt: '2026-05-03T12:00:00.000Z',
      delivery: { channel: 'first-party-email' },
    })

    const res = await request(makeApp())
      .post('/workflow-approval-mediums/challenges')
      .set('Authorization', 'Bearer session-token')
      .send({
        medium: 'slack',
        providerUserId: 'U123',
        providerWorkspaceId: 'T123',
      })
      .expect(202)

    expect(res.body).toMatchObject({
      challengeId: 'challenge-1',
      delivery: { channel: 'first-party-email' },
    })
    expect(serviceMock.createWorkflowApprovalMediumChallenge).toHaveBeenCalledWith(
      'session-token',
      {
        medium: 'slack',
        providerUserId: 'U123',
        providerWorkspaceId: 'T123',
        providerChannelId: null,
      }
    )
  })

  it('rejects Telegram manual provider identity challenges', async () => {
    authTokenMock.verifyToken.mockReturnValueOnce({ userId: 'user-1', exp: 9999999999 })

    await request(makeApp())
      .post('/workflow-approval-mediums/challenges')
      .set('Authorization', 'Bearer session-token')
      .send({
        medium: 'telegram',
        providerUserId: '123',
        providerChannelId: '123',
      })
      .expect(400, { error: 'telegram_target_required' })

    expect(serviceMock.createWorkflowApprovalMediumChallenge).not.toHaveBeenCalled()
  })

  it('creates a Telegram provider-event challenge for a selected target', async () => {
    authTokenMock.verifyToken.mockReturnValueOnce({ userId: 'user-1', exp: 9999999999 })
    serviceMock.createWorkflowApprovalMediumChallenge.mockResolvedValueOnce({
      challengeId: 'challenge-1',
      expiresAt: '2026-06-02T12:00:00.000Z',
      code: '123456',
      delivery: { channel: 'telegram-provider-event' },
    })

    const res = await request(makeApp())
      .post('/workflow-approval-mediums/challenges')
      .set('Authorization', 'Bearer session-token')
      .send({
        medium: 'telegram',
        targetId: 'telegram:target',
      })
      .expect(202)

    expect(res.body).toMatchObject({
      challengeId: 'challenge-1',
      code: '123456',
      delivery: { channel: 'telegram-provider-event' },
    })
    expect(serviceMock.createWorkflowApprovalMediumChallenge).toHaveBeenCalledWith(
      'session-token',
      {
        medium: 'telegram',
        providerWorkspaceId: null,
        providerChannelId: null,
        targetId: 'telegram:target',
      }
    )
  })

  it('rejects malformed confirmation codes before reaching control-api', async () => {
    authTokenMock.verifyToken.mockReturnValueOnce({ userId: 'user-1', exp: 9999999999 })
    await request(makeApp())
      .post('/workflow-approval-mediums/challenges/99999999-8888-7777-6666-555555555555/confirm')
      .set('Authorization', 'Bearer session-token')
      .send({ code: '12345x' })
      .expect(400)

    expect(serviceMock.confirmWorkflowApprovalMediumChallenge).not.toHaveBeenCalled()
  })

  it('confirms, lists, prefers, renames, and disables verified medium accounts', async () => {
    authTokenMock.verifyToken
      .mockReturnValueOnce({ userId: 'user-1', exp: 9999999999 })
      .mockReturnValueOnce({ userId: 'user-1', exp: 9999999999 })
      .mockReturnValueOnce({ userId: 'user-1', exp: 9999999999 })
      .mockReturnValueOnce({ userId: 'user-1', exp: 9999999999 })
      .mockReturnValueOnce({ userId: 'user-1', exp: 9999999999 })
    serviceMock.confirmWorkflowApprovalMediumChallenge.mockResolvedValueOnce({
      ok: true,
      accountId: 'account-1',
    })
    serviceMock.listWorkflowApprovalMediums.mockResolvedValueOnce({ items: [{ id: 'account-1' }] })
    serviceMock.preferWorkflowApprovalMedium.mockResolvedValueOnce({
      ok: true,
      account: { id: 'account-1', isPreferred: true },
    })
    serviceMock.updateWorkflowApprovalMediumDisplayName.mockResolvedValueOnce({
      ok: true,
      account: { id: 'account-1', displayName: 'Leadership' },
    })
    serviceMock.disableWorkflowApprovalMedium.mockResolvedValueOnce(undefined)

    await request(makeApp())
      .post('/workflow-approval-mediums/challenges/99999999-8888-7777-6666-555555555555/confirm')
      .set('Authorization', 'Bearer session-token')
      .send({ code: '123456' })
      .expect(200)
    await request(makeApp())
      .get('/workflow-approval-mediums')
      .set('Authorization', 'Bearer session-token')
      .expect(200)
    await request(makeApp())
      .put('/workflow-approval-mediums/99999999-8888-7777-6666-555555555555/preference')
      .set('Authorization', 'Bearer session-token')
      .expect(200)
    await request(makeApp())
      .patch('/workflow-approval-mediums/99999999-8888-7777-6666-555555555555/display-name')
      .set('Authorization', 'Bearer session-token')
      .send({ displayName: '  Leadership  ' })
      .expect(200)
    await request(makeApp())
      .delete('/workflow-approval-mediums/99999999-8888-7777-6666-555555555555')
      .set('Authorization', 'Bearer session-token')
      .expect(204)

    expect(serviceMock.confirmWorkflowApprovalMediumChallenge).toHaveBeenCalledWith(
      'session-token',
      '99999999-8888-7777-6666-555555555555',
      '123456'
    )
    expect(serviceMock.listWorkflowApprovalMediums).toHaveBeenCalledWith('session-token', {
      includeDisabled: false,
    })
    expect(serviceMock.preferWorkflowApprovalMedium).toHaveBeenCalledWith(
      'session-token',
      '99999999-8888-7777-6666-555555555555'
    )
    expect(serviceMock.updateWorkflowApprovalMediumDisplayName).toHaveBeenCalledWith(
      'session-token',
      '99999999-8888-7777-6666-555555555555',
      'Leadership'
    )
    expect(serviceMock.disableWorkflowApprovalMedium).toHaveBeenCalledWith(
      'session-token',
      '99999999-8888-7777-6666-555555555555'
    )
  })

  it('rejects invalid workflow approval medium display names before control-api', async () => {
    authTokenMock.verifyToken.mockReturnValue({ userId: 'user-1', exp: 9999999999 })

    await request(makeApp())
      .patch('/workflow-approval-mediums/99999999-8888-7777-6666-555555555555/display-name')
      .set('Authorization', 'Bearer session-token')
      .send({})
      .expect(400, { error: 'display_name_required' })

    await request(makeApp())
      .patch('/workflow-approval-mediums/99999999-8888-7777-6666-555555555555/display-name')
      .set('Authorization', 'Bearer session-token')
      .send({ displayName: 123 })
      .expect(400, { error: 'display_name_must_be_string' })

    expect(serviceMock.updateWorkflowApprovalMediumDisplayName).not.toHaveBeenCalled()
  })

  it('passes includeDisabled when listing workflow approval mediums', async () => {
    authTokenMock.verifyToken.mockReturnValueOnce({ userId: 'user-1', exp: 9999999999 })
    serviceMock.listWorkflowApprovalMediums.mockResolvedValueOnce({
      items: [{ id: 'account-disabled', disabledAt: '2026-06-05T18:00:00.000Z' }],
    })

    await request(makeApp())
      .get('/workflow-approval-mediums?includeDisabled=true')
      .set('Authorization', 'Bearer session-token')
      .expect(200)

    expect(serviceMock.listWorkflowApprovalMediums).toHaveBeenCalledWith('session-token', {
      includeDisabled: true,
    })
  })

  it('lists approval channel targets for the authenticated user session', async () => {
    authTokenMock.verifyToken.mockReturnValueOnce({ userId: 'user-1', exp: 9999999999 })
    serviceMock.listApprovalChannelTargets.mockResolvedValueOnce({
      items: [{ id: 'telegram:target', medium: 'telegram' }],
    })

    const res = await request(makeApp())
      .get('/workflow-approval-mediums/targets')
      .set('Authorization', 'Bearer session-token')
      .expect(200)

    expect(res.body.items).toHaveLength(1)
    expect(serviceMock.listApprovalChannelTargets).toHaveBeenCalledWith('session-token')
  })
})
