import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createExternalWorkflowsRouter } from '../src/routes/workflows.js'

const authTokenMock = vi.hoisted(() => ({
  verifyToken: vi.fn(),
}))

const controlApiClientMock = vi.hoisted(() => ({
  controlApiRequest: vi.fn(),
  controlApiRequestWithStatus: vi.fn(),
  controlApiBinaryRequestWithStatus: vi.fn(),
  ControlApiError: class ControlApiError extends Error {
    status: number
    body: unknown
    constructor(message: string, status: number, body: unknown) {
      super(message)
      this.status = status
      this.body = body
    }
  },
}))

vi.mock('../src/authToken.js', () => authTokenMock)
vi.mock('../src/controlApiClient.js', () => controlApiClientMock)

describe('routes/workflows', () => {
  const claims = {
    userId: 'user-1',
    email: 'user@example.com',
    teamId: 'team-1',
    role: 'member' as const,
    exp: 9999999999,
  }

  beforeEach(() => {
    authTokenMock.verifyToken.mockReset()
    controlApiClientMock.controlApiRequest.mockReset()
    controlApiClientMock.controlApiRequestWithStatus.mockReset()
    controlApiClientMock.controlApiBinaryRequestWithStatus.mockReset()
  })

  function makeApp() {
    const app = express()
    app.use(express.json())
    app.use('/api/v1', createExternalWorkflowsRouter())
    return app
  }

  it('forwards one exact action delegation for a v2 workflow trigger', async () => {
    authTokenMock.verifyToken.mockReturnValueOnce({ ...claims, sessionContract: 'v2' })
    controlApiClientMock.controlApiRequestWithStatus.mockResolvedValueOnce({
      status: 201,
      data: { runId: 'run-1' },
    })

    await request(makeApp())
      .post('/api/v1/workflows/sandbox-recipes/recipe-a/trigger')
      .set('authorization', 'Bearer user-session-token')
      .set('idempotency-key', 'trigger-1')
      .set('x-evenfire-action-delegation', 'opaque-v2-delegation')
      .send({ inputs: {} })
      .expect(201)

    expect(controlApiClientMock.controlApiRequestWithStatus).toHaveBeenCalledWith(
      'POST',
      '/external/workflows/sandbox-recipes/recipe-a/trigger',
      {
        userSessionToken: 'user-session-token',
        body: { inputs: {} },
        extraHeaders: {
          'idempotency-key': 'trigger-1',
          'x-evenfire-action-delegation': 'opaque-v2-delegation',
        },
      }
    )
  })

  it('fails a v2 workflow request closed when the action delegation is absent', async () => {
    authTokenMock.verifyToken.mockReturnValueOnce({ ...claims, sessionContract: 'v2' })

    const response = await request(makeApp())
      .get('/api/v1/workflows/sandbox-recipes/recipe-a')
      .set('authorization', 'Bearer user-session-token')
      .expect(400)

    expect(response.body).toEqual({ error: 'invalid_action_delegation' })
    expect(controlApiClientMock.controlApiRequest).not.toHaveBeenCalled()
  })

  it('lists run-scoped workflow artifacts through Control API with the user session token', async () => {
    authTokenMock.verifyToken.mockReturnValueOnce(claims)
    controlApiClientMock.controlApiRequest.mockResolvedValueOnce({
      artifacts: [{ name: 'custom-sdk-result.json' }],
    })

    const app = makeApp()
    const res = await request(app)
      .get('/api/v1/workflows/sandbox-recipes/recipe-a/runs/run-123/artifacts')
      .set('authorization', 'Bearer user-session-token')
      .expect(200)

    expect(res.body).toEqual({ artifacts: [{ name: 'custom-sdk-result.json' }] })
    expect(controlApiClientMock.controlApiRequest).toHaveBeenCalledWith(
      'GET',
      '/external/workflows/sandbox-recipes/recipe-a/runs/run-123/artifacts',
      { userSessionToken: 'user-session-token' }
    )
  })

  it('uses the bounded request correlation ID when a route-local upstream error has none', async () => {
    authTokenMock.verifyToken.mockReturnValueOnce(claims)
    controlApiClientMock.controlApiRequest.mockRejectedValueOnce(
      new controlApiClientMock.ControlApiError('private', 404, { error: { code: 'not_found' } })
    )

    const res = await request(makeApp())
      .get('/api/v1/workflows/sandbox-recipes/recipe-a/runs/run-123/artifacts')
      .set('authorization', 'Bearer user-session-token')
      .set('x-correlation-id', 'workflow_ID-42')

    expect(res.status).toBe(404)
    expect(res.body.error.correlationId).toBe('workflow_ID-42')
  })

  it('proxies run-scoped workflow artifact downloads without using latest-run routes', async () => {
    authTokenMock.verifyToken.mockReturnValueOnce(claims)
    controlApiClientMock.controlApiBinaryRequestWithStatus.mockResolvedValueOnce({
      status: 200,
      body: Buffer.from('artifact-bytes'),
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': '14',
        'content-disposition': 'attachment; filename="custom-sdk-result.json"',
      },
    })

    const app = makeApp()
    const res = await request(app)
      .get(
        '/api/v1/workflows/sandbox-recipes/recipe-a/runs/run-123/artifacts/custom-sdk-result.json/download'
      )
      .set('authorization', 'Bearer user-session-token')
      .expect(200)

    expect(Buffer.from(res.body).toString()).toBe('artifact-bytes')
    expect(res.headers['content-disposition']).toBe('attachment; filename="custom-sdk-result.json"')
    expect(controlApiClientMock.controlApiBinaryRequestWithStatus).toHaveBeenCalledWith(
      'GET',
      '/external/workflows/sandbox-recipes/recipe-a/runs/run-123/artifacts/custom-sdk-result.json/download',
      { userSessionToken: 'user-session-token' }
    )
  })
})
