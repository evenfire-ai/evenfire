import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createRpcRouter } from '../routes/rpc.js'

// spec 11 U1 — the proactive connectors read-model route. It REUSES the
// `mcp:servers:list` scope, derives `userId` from the signed session subject
// (`auth.sub`), and passes the control-api payload through. These tests prove
// the scope gate, the session-derived identity, and passthrough.

const authTokenMock = vi.hoisted(() => ({ verifyRpcToken: vi.fn() }))
const controlApiMock = vi.hoisted(() => {
  // The route does `error instanceof ControlApiConnectorsRejectedError`, so the
  // mocked module must expose the real class shape — otherwise the import is
  // undefined and the instanceof check throws.
  class ControlApiConnectorsRejectedError extends Error {
    constructor(readonly status: 401 | 403) {
      super(`Control API rejected connectors read (${status})`)
      this.name = 'ControlApiConnectorsRejectedError'
    }
  }
  return {
    ControlApiConnectorsRejectedError,
    fetchUserConnectorsFromControlApi: vi.fn(),
    fetchHostConnectionFromControlApi: vi.fn(),
    requestHostWakeFromControlApi: vi.fn(),
  }
})
// createRpcRouter also imports the proxy service barrel; stub it so the module
// graph loads without real upstreams.
const serviceMock = vi.hoisted(() => ({
  listAllowedServersForUser: vi.fn(),
  resolveServerConnectionForUser: vi.fn(),
  resolveHostConnectionForUser: vi.fn(),
  validateRpcRequest: vi.fn(),
  forwardRpcToServer: vi.fn(),
  forwardHostMessageToHost: vi.fn(),
  forwardHostActivity: vi.fn(),
  forwardHostStatus: vi.fn(),
  forwardHostHealth: vi.fn(),
  forwardTaskResultFromHost: vi.fn(),
  forwardCancelToHost: vi.fn(),
  UpstreamHostError: class extends Error {},
}))

vi.mock('../authToken.js', () => authTokenMock)
vi.mock('../services/controlApiRestService.js', () => controlApiMock)
vi.mock('../services/mcpProxyService.js', () => serviceMock)

function claims(scopes: string[], sub = 'user-uuid-123') {
  return {
    sub,
    typ: 'user' as const,
    accessScope: 'team' as const,
    teamId: 'team-1',
    scopes,
    hostRefs: ['agent-a'],
    jti: 'j1',
    iat: 1,
    exp: 9999999999,
  }
}

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use(createRpcRouter())
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _n: express.NextFunction) => {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' })
    }
  )
  return app
}

beforeEach(() => {
  authTokenMock.verifyRpcToken.mockReset()
  controlApiMock.fetchUserConnectorsFromControlApi.mockReset()
})
afterEach(() => vi.clearAllMocks())

describe('GET /rpc/connectors', () => {
  it('401 without a bearer token', async () => {
    const res = await request(makeApp()).get('/rpc/connectors')
    expect(res.status).toBe(401)
    expect(controlApiMock.fetchUserConnectorsFromControlApi).not.toHaveBeenCalled()
  })

  it('403 when the token lacks mcp:servers:list', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue(claims(['mcp:server:invoke']))
    const res = await request(makeApp()).get('/rpc/connectors').set('authorization', 'Bearer tok')
    expect(res.status).toBe(403)
    expect(controlApiMock.fetchUserConnectorsFromControlApi).not.toHaveBeenCalled()
  })

  it('derives userId from the session subject and passes the payload through', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue(claims(['mcp:servers:list'], 'user-abc'))
    const payload = {
      userId: 'user-abc',
      agents: [
        {
          name: 'agent-a',
          contextRef: 'ctx-1',
          connectors: [
            {
              name: 'gdrive',
              provider: 'google',
              authKind: 'oauth-user',
              grantScope: 'user',
              status: 'requires_setup',
            },
          ],
        },
      ],
    }
    controlApiMock.fetchUserConnectorsFromControlApi.mockResolvedValue(payload)

    const res = await request(makeApp()).get('/rpc/connectors').set('authorization', 'Bearer tok')

    expect(res.status).toBe(200)
    expect(res.body).toEqual(payload)
    // userId is the signed subject — NOT any client-supplied value.
    expect(controlApiMock.fetchUserConnectorsFromControlApi).toHaveBeenCalledWith('user-abc', 'tok')
  })

  it('surfaces a control-api failure as 500 (route next(error))', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue(claims(['mcp:servers:list']))
    controlApiMock.fetchUserConnectorsFromControlApi.mockRejectedValue(new Error('boom'))
    const res = await request(makeApp()).get('/rpc/connectors').set('authorization', 'Bearer tok')
    expect(res.status).toBe(500)
  })

  // H2 — a control-api 401 must reach the client AS 401, not collapse to 500.
  // The desktop only refreshes the rpc access token on 401 (or a scope 403);
  // a 500 is non-refreshable, so an expired token surfaced as 500 would leave
  // the panel permanently stuck.
  it('maps a control-api 401 to a client 401 (keeps token refresh alive)', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue(claims(['mcp:servers:list']))
    controlApiMock.fetchUserConnectorsFromControlApi.mockRejectedValue(
      new controlApiMock.ControlApiConnectorsRejectedError(401)
    )
    const res = await request(makeApp()).get('/rpc/connectors').set('authorization', 'Bearer tok')
    expect(res.status).toBe(401)
  })

  it('maps a control-api 403 to a client 403 (not 500)', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue(claims(['mcp:servers:list']))
    controlApiMock.fetchUserConnectorsFromControlApi.mockRejectedValue(
      new controlApiMock.ControlApiConnectorsRejectedError(403)
    )
    const res = await request(makeApp()).get('/rpc/connectors').set('authorization', 'Bearer tok')
    expect(res.status).toBe(403)
  })
})
