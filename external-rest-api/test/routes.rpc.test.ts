import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
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

const rpcDenialReasons = [
  'invalid_host_refs',
  'sandbox_ui_host_ref_required',
  'sandbox_ui_scope_required',
  'sandbox_ui_host_ref_exclusive',
  'host_access_denied',
  'direct_host_access_required',
  'desktop_requires_team',
  'no_permitted_scopes',
] as const

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

  it.each(rpcDenialReasons)(
    'relays the control-api denial reason %s instead of a generic 403',
    async reason => {
      rpcServiceMock.issueRpcAccessToken.mockResolvedValue({ error: reason })

      const res = await request(buildApp())
        .post('/rpc/token')
        .set('authorization', 'Bearer session-xyz')
        .send({ scopes: ['desktop:view'], hostRefs: ['pro-agent'] })

      expect(res.status).toBe(403)
      expect(res.body).toEqual({ error: reason })
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
      '127.0.0.1'
    )
  })
})
