import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { randomUUID } from 'node:crypto'
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

  it('relays the control-api denial reason instead of a generic 403', async () => {
    rpcServiceMock.issueRpcAccessToken.mockResolvedValue({ error: 'desktop_requires_team' })

    const res = await request(buildApp())
      .post('/rpc/token')
      .set('authorization', 'Bearer session-xyz')
      .send({ scopes: ['desktop:view'], hostRefs: ['pro-agent'] })

    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'desktop_requires_team' })
  })

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
  })
  it('E4: relays only the allowed revocation fields when the service result has an extra field', async () => {
    const sessionToken = randomUUID()
    const scopes = ['host:message:invoke']
    const hostRefs = ['host-a', 'host-b']
    rpcServiceMock.issueRpcAccessToken.mockResolvedValue({
      error: 'host_access_denied',
      code: 'host_access_revoked',
      revokedHostRefs: hostRefs,
      extraServiceField: true,
    })

    const res = await request(buildApp())
      .post('/rpc/token')
      .set('authorization', 'Bearer ' + sessionToken)
      .send({ scopes, hostRefs })

    expect(res.status).toBe(403)
    expect(res.body).toEqual({
      error: 'host_access_denied',
      code: 'host_access_revoked',
      revokedHostRefs: hostRefs,
    })
    expect(rpcServiceMock.issueRpcAccessToken.mock.calls.length).toBe(1)
    const [forwardedSession, forwardedScopes, forwardedHostRefs] =
      rpcServiceMock.issueRpcAccessToken.mock.calls[0]
    expect(forwardedSession === sessionToken).toBe(true)
    expect(forwardedScopes).toEqual(scopes)
    expect(forwardedHostRefs).toEqual(hostRefs)
  })
})
