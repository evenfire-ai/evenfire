import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { ControlApiError } from '../src/controlApiClient.js'
import { createRpcRouter } from '../src/routes/rpc.js'

const rpcServiceMock = vi.hoisted(() => ({ issueRpcAccessToken: vi.fn() }))
vi.mock('../src/services/rpcService.js', () => rpcServiceMock)

const authTokenMock = vi.hoisted(() => ({ verifyToken: vi.fn() }))
vi.mock('../src/authToken.js', () => authTokenMock)

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use(createRpcRouter())
  return app
}

describe('routes/rpc /rpc/token', () => {
  beforeEach(() => {
    rpcServiceMock.issueRpcAccessToken.mockReset()
    authTokenMock.verifyToken.mockReset()
    authTokenMock.verifyToken.mockReturnValue({
      userId: 'u1',
      email: 'u@example.com',
      teamId: null,
      role: 'member',
      exp: 9_999_999_999,
    })
  })

  it('returns a bounded public envelope without reflecting the control-api denial body', async () => {
    rpcServiceMock.issueRpcAccessToken.mockRejectedValue(
      new ControlApiError('secret internal topology', 403, {
        error: 'secret-internal-reason',
        path: '/internal/control-api',
      })
    )

    const res = await request(buildApp())
      .post('/rpc/token')
      .set('authorization', 'Bearer session-xyz')
      .send({ scopes: ['desktop:view'], hostRefs: ['pro-agent'] })

    expect(res.status).toBe(403)
    expect(res.body).toEqual({
      error: {
        code: 'forbidden',
        message: 'The requested operation is not allowed.',
        correlationId: expect.any(String),
        retryable: false,
      },
    })
    expect(JSON.stringify(res.body)).not.toContain('secret-internal-reason')
    expect(JSON.stringify(res.body)).not.toContain('/internal/control-api')
  })

  it.each(['desktop_requires_team', 'no_permitted_scopes'])(
    'preserves approved safe RPC denial reason %s',
    async reason => {
      rpcServiceMock.issueRpcAccessToken.mockRejectedValue(
        new ControlApiError('private upstream denial', 403, { error: reason })
      )

      const res = await request(buildApp())
        .post('/rpc/token')
        .set('authorization', 'Bearer session-xyz')
        .send({ scopes: ['desktop:view'], hostRefs: ['pro-agent'] })

      expect(res.status).toBe(403)
      expect(res.body).toEqual({
        error: {
          code: 'forbidden',
          message: 'The requested operation is not allowed.',
          correlationId: expect.any(String),
          retryable: false,
          details: { reason },
        },
      })
      expect(JSON.stringify(res.body)).not.toContain('private upstream denial')
    }
  )

  it('returns the issued token on success', async () => {
    rpcServiceMock.issueRpcAccessToken.mockResolvedValue({
      token: 't',
      accessScope: 'user',
      teamId: null,
      scopes: ['host:message:invoke'],
      hostRefs: ['pro-agent'],
      expiresInSeconds: 300,
    })

    const res = await request(buildApp())
      .post('/rpc/token')
      .set('authorization', 'Bearer session-xyz')
      .send({ scopes: ['host:message:invoke'], hostRefs: ['pro-agent'] })

    expect(res.status).toBe(200)
    expect(res.body.token).toBe('t')
    expect(rpcServiceMock.issueRpcAccessToken).toHaveBeenCalledWith(
      'session-xyz',
      ['host:message:invoke'],
      ['pro-agent'],
      '::ffff:127.0.0.1'
    )
  })
})
