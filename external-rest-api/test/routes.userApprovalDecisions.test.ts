import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { ControlApiError } from '../src/controlApiClient.js'
import { createUserApprovalDecisionsRouter } from '../src/routes/userApprovalDecisions.js'

const authTokenMock = vi.hoisted(() => ({
  verifyToken: vi.fn(),
}))

const userApprovalDecisionsServiceMock = vi.hoisted(() => ({
  listPendingUserApprovalDecisions: vi.fn(),
  decideUserApprovalDecision: vi.fn(),
}))

vi.mock('../src/authToken.js', () => authTokenMock)
vi.mock('../src/services/userApprovalDecisionsService.js', () => userApprovalDecisionsServiceMock)

describe('routes/userApprovalDecisions', () => {
  const claims = {
    userId: 'user-1',
    email: 'user@example.com',
    teamId: 'team-1',
    role: 'member' as const,
    exp: 9999999999,
  }

  beforeEach(() => {
    authTokenMock.verifyToken.mockReset()
    userApprovalDecisionsServiceMock.listPendingUserApprovalDecisions.mockReset()
    userApprovalDecisionsServiceMock.decideUserApprovalDecision.mockReset()
  })

  function makeApp() {
    const app = express()
    app.use(express.json())
    app.use(createUserApprovalDecisionsRouter())
    return app
  }

  it('requires authentication for listing', async () => {
    const app = makeApp()
    await request(app).get('/workflow-approvals').expect(401)
    expect(userApprovalDecisionsServiceMock.listPendingUserApprovalDecisions).not.toHaveBeenCalled()
  })

  it('forwards pending approval list with claim-bound session token', async () => {
    authTokenMock.verifyToken.mockReturnValueOnce(claims)
    userApprovalDecisionsServiceMock.listPendingUserApprovalDecisions.mockResolvedValueOnce({
      items: [{ id: 'approval-1' }],
    })
    const app = makeApp()

    const response = await request(app)
      .get('/workflow-approvals?limit=12')
      .set('authorization', 'Bearer good-token')
      .expect(200)

    expect(response.body).toEqual({ items: [{ id: 'approval-1' }] })
    expect(userApprovalDecisionsServiceMock.listPendingUserApprovalDecisions).toHaveBeenCalledWith(
      'good-token',
      12
    )
  })

  it('uses the default pending approval list limit', async () => {
    authTokenMock.verifyToken.mockReturnValueOnce(claims)
    userApprovalDecisionsServiceMock.listPendingUserApprovalDecisions.mockResolvedValueOnce({
      items: [],
    })
    const app = makeApp()

    await request(app)
      .get('/workflow-approvals')
      .set('authorization', 'Bearer good-token')
      .expect(200)

    expect(userApprovalDecisionsServiceMock.listPendingUserApprovalDecisions).toHaveBeenCalledWith(
      'good-token',
      20
    )
  })

  it('rejects invalid list limit', async () => {
    authTokenMock.verifyToken.mockReturnValueOnce(claims)
    const app = makeApp()

    const response = await request(app)
      .get('/workflow-approvals?limit=-2')
      .set('authorization', 'Bearer good-token')
      .expect(400)

    expect(response.body.error).toContain('limit')
    expect(userApprovalDecisionsServiceMock.listPendingUserApprovalDecisions).not.toHaveBeenCalled()
  })

  it('forwards approval decisions with session token', async () => {
    authTokenMock.verifyToken.mockReturnValueOnce(claims)
    userApprovalDecisionsServiceMock.decideUserApprovalDecision.mockResolvedValueOnce({ ok: true })
    const app = makeApp()

    const response = await request(app)
      .post('/workflow-approvals/approval-1/decide')
      .set('authorization', 'Bearer good-token')
      .send({ decision: 'approve', note: 'looks good' })
      .expect(200)

    expect(response.body).toEqual({ ok: true })
    expect(userApprovalDecisionsServiceMock.decideUserApprovalDecision).toHaveBeenCalledWith(
      'good-token',
      'approval-1',
      'approve',
      'looks good'
    )
  })

  it('rejects invalid decision values', async () => {
    authTokenMock.verifyToken.mockReturnValueOnce(claims)
    const app = makeApp()

    const response = await request(app)
      .post('/workflow-approvals/approval-1/decide')
      .set('authorization', 'Bearer good-token')
      .send({ decision: 'maybe' })
      .expect(400)

    expect(response.body.error).toContain('approve')
    expect(userApprovalDecisionsServiceMock.decideUserApprovalDecision).not.toHaveBeenCalled()
  })

  it('rejects missing decision bodies', async () => {
    authTokenMock.verifyToken.mockReturnValueOnce(claims)
    const app = makeApp()

    const response = await request(app)
      .post('/workflow-approvals/approval-1/decide')
      .set('authorization', 'Bearer good-token')
      .expect(400)

    expect(response.body.error).toContain('approve')
    expect(userApprovalDecisionsServiceMock.decideUserApprovalDecision).not.toHaveBeenCalled()
  })

  it('rejects blank approval ids after route param trimming', async () => {
    authTokenMock.verifyToken.mockReturnValueOnce(claims)
    const app = makeApp()

    const response = await request(app)
      .post('/workflow-approvals/%20/decide')
      .set('authorization', 'Bearer good-token')
      .send({ decision: 'approve' })
      .expect(400)

    expect(response.body.error).toContain('approvalId')
    expect(userApprovalDecisionsServiceMock.decideUserApprovalDecision).not.toHaveBeenCalled()
  })

  it('rejects overlong decision notes', async () => {
    authTokenMock.verifyToken.mockReturnValueOnce(claims)
    const app = makeApp()

    const response = await request(app)
      .post('/workflow-approvals/approval-1/decide')
      .set('authorization', 'Bearer good-token')
      .send({ decision: 'deny', note: 'x'.repeat(1001) })
      .expect(400)

    expect(response.body.error).toContain('note')
    expect(userApprovalDecisionsServiceMock.decideUserApprovalDecision).not.toHaveBeenCalled()
  })

  it('propagates expected control-api errors from pending list', async () => {
    authTokenMock.verifyToken.mockReturnValueOnce(claims)
    userApprovalDecisionsServiceMock.listPendingUserApprovalDecisions.mockRejectedValueOnce(
      new ControlApiError('gone', 410, { error: 'expired' })
    )
    const app = makeApp()

    const response = await request(app)
      .get('/workflow-approvals')
      .set('authorization', 'Bearer good-token')
      .expect(410)

    expect(response.body).toEqual({ error: 'expired' })
  })

  it('propagates expected control-api errors with message fallback bodies', async () => {
    authTokenMock.verifyToken.mockReturnValueOnce(claims)
    userApprovalDecisionsServiceMock.decideUserApprovalDecision.mockRejectedValueOnce(
      new ControlApiError('conflict', 409, 'not-json')
    )
    const app = makeApp()

    const response = await request(app)
      .post('/workflow-approvals/approval-1/decide')
      .set('authorization', 'Bearer good-token')
      .send({ decision: 'deny' })
      .expect(409)

    expect(response.body).toEqual({ error: 'conflict' })
  })

  it('delegates unexpected service errors to the express error handler', async () => {
    authTokenMock.verifyToken.mockReturnValueOnce(claims)
    userApprovalDecisionsServiceMock.listPendingUserApprovalDecisions.mockRejectedValueOnce(
      new Error('boom')
    )
    const app = makeApp()

    await request(app)
      .get('/workflow-approvals')
      .set('authorization', 'Bearer good-token')
      .expect(500)
  })
})
