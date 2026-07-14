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
