import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createContextSharedFilesystemsRouter } from '../src/routes/contextSharedFilesystems.js'

const authTokenMock = vi.hoisted(() => ({
  verifyToken: vi.fn(),
}))

const controlApiClientMock = vi.hoisted(() => ({
  controlApiRequest: vi.fn(),
  controlApiStreamRequest: vi.fn(),
}))

vi.mock('../src/authToken.js', () => authTokenMock)
vi.mock('../src/controlApiClient.js', () => ({
  ...controlApiClientMock,
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

const claims = {
  userId: 'user-1',
  email: 'user@example.com',
  teamId: 'team-1',
  role: 'member' as const,
  exp: 9_999_999_999,
}

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use(createContextSharedFilesystemsRouter())
  return app
}

beforeEach(() => {
  authTokenMock.verifyToken.mockReset()
  controlApiClientMock.controlApiRequest.mockReset()
  controlApiClientMock.controlApiStreamRequest.mockReset()
})

describe('GET /me/contexts/:contextId/shared-filesystems', () => {
  it('forwards to control-api with the user session token', async () => {
    authTokenMock.verifyToken.mockReturnValue(claims)
    controlApiClientMock.controlApiRequest.mockResolvedValue({
      items: [
        {
          name: 'team-mission',
          mountPath: '/workspace/team-mission',
          phase: 'Mounted',
          pvcName: 'pvc-1',
          message: null,
        },
      ],
    })

    const res = await request(buildApp())
      .get('/me/contexts/ctx-a/shared-filesystems')
      .set('authorization', 'Bearer good-token')
    expect(res.status).toBe(200)
    expect(res.body.items).toHaveLength(1)
    expect(controlApiClientMock.controlApiRequest).toHaveBeenCalledWith(
      'GET',
      '/external/contexts/ctx-a/shared-filesystems',
      { userSessionToken: 'good-token' }
    )
  })

  it('returns 401 without a bearer token', async () => {
    authTokenMock.verifyToken.mockReturnValue(null)
    const res = await request(buildApp()).get('/me/contexts/ctx-a/shared-filesystems')
    expect(res.status).toBe(401)
    expect(controlApiClientMock.controlApiRequest).not.toHaveBeenCalled()
  })
})

describe('Method gating', () => {
  it('responds 405 to writes on the SFS subtree', async () => {
    authTokenMock.verifyToken.mockReturnValue(claims)
    const app = buildApp()

    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      const res = await request(app)
        [method]('/me/contexts/ctx-a/shared-filesystems')
        .set('authorization', 'Bearer good')
      expect(res.status).toBe(405)
    }
    for (const method of ['post', 'delete'] as const) {
      const res = await request(app)
        [method]('/me/contexts/ctx-a/shared-filesystems/team-mission/proxy/files')
        .set('authorization', 'Bearer good')
      expect(res.status).toBe(405)
    }
    expect(controlApiClientMock.controlApiRequest).not.toHaveBeenCalled()
  })

  it('uses the identity-aware stream client for proxy reads', async () => {
    authTokenMock.verifyToken.mockReturnValue(claims)
    controlApiClientMock.controlApiStreamRequest.mockResolvedValue(
      new Response('file-data', {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      })
    )

    const res = await request(buildApp())
      .get('/me/contexts/ctx-a/shared-filesystems/team-mission/proxy/files?download=1')
      .set('authorization', 'Bearer good-token')

    expect(res.status).toBe(200)
    expect(res.body).toEqual(Buffer.from('file-data'))
    expect(controlApiClientMock.controlApiStreamRequest).toHaveBeenCalledWith(
      'GET',
      '/external/contexts/ctx-a/shared-filesystems/team-mission/proxy/files?download=1',
      { userSessionToken: 'good-token', throwOnHttpError: false }
    )
  })

  it('preserves upstream error status, body, and retry headers for proxy reads', async () => {
    authTokenMock.verifyToken.mockReturnValue(claims)
    controlApiClientMock.controlApiStreamRequest.mockResolvedValue(
      new Response(JSON.stringify({ error: 'forbidden' }), {
        status: 429,
        headers: {
          'content-type': 'application/json',
          'retry-after': '7',
        },
      })
    )

    const res = await request(buildApp())
      .get('/me/contexts/ctx-a/shared-filesystems/team-mission/proxy/files')
      .set('authorization', 'Bearer good-token')

    expect(res.status).toBe(429)
    expect(res.body).toEqual({ error: 'forbidden' })
    expect(res.headers['retry-after']).toBe('7')
  })

  it('forwards HEAD without draining an upstream response body', async () => {
    authTokenMock.verifyToken.mockReturnValue(claims)
    const getReader = vi.fn(() => {
      throw new Error('HEAD body must not be read')
    })
    const cancel = vi.fn(() => Promise.reject(new Error('upstream disconnect')))
    controlApiClientMock.controlApiStreamRequest.mockResolvedValue({
      status: 200,
      headers: new Headers({
        'content-type': 'application/octet-stream',
        'content-length': '1234',
      }),
      body: { getReader, cancel },
    } as unknown as Response)

    const res = await request(buildApp())
      .head('/me/contexts/ctx-a/shared-filesystems/team-mission/proxy/files?download=1')
      .set('authorization', 'Bearer good-token')

    expect(res.status).toBe(200)
    expect(res.headers['content-length']).toBe('1234')
    expect(getReader).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledOnce()
    expect(controlApiClientMock.controlApiStreamRequest).toHaveBeenCalledWith(
      'HEAD',
      '/external/contexts/ctx-a/shared-filesystems/team-mission/proxy/files?download=1',
      { userSessionToken: 'good-token', throwOnHttpError: false }
    )
  })
})
