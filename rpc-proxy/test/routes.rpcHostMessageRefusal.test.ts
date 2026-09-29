/**
 * #666 — the Host answers a refused message with HTTP 200 and a
 * `success:false` MessageResponse. Only the host resolution and the auth are
 * doubles: the real `forwardHostMessageToHost` runs against a fetch double, so
 * the client receives what the proxy's own forwarding produces.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createRpcRouter } from '../src/routes/rpc.js'

const authTokenMock = vi.hoisted(() => ({
  verifyRpcToken: vi.fn(),
}))

const resolveHostConnectionForUser = vi.hoisted(() => vi.fn())

vi.mock('../src/authToken.js', () => authTokenMock)
vi.mock('../src/services/mcpProxyService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/services/mcpProxyService.js')>()),
  resolveHostConnectionForUser,
}))

const refusal = {
  success: false,
  error: {
    code: 'FILE_REFERENCE_INVALID',
    message: 'Each file reference must appear once.',
    retryable: false,
    provider: 'unknown',
  },
}

describe('routes/rpc host message refusal (#666)', () => {
  beforeEach(() => {
    authTokenMock.verifyRpcToken.mockReturnValue({
      sub: 'user-1',
      typ: 'user',
      accessScope: 'team',
      teamId: 'team-1',
      scopes: ['host:message:invoke'],
      hostRefs: ['agent2'],
      jti: 'j1',
      iat: 1,
      exp: 9999999999,
    })
    resolveHostConnectionForUser.mockResolvedValue({
      name: 'agent2',
      url: 'http://agent2.mcp-host.svc.cluster.local:8080',
      headers: {},
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function makeApp() {
    const app = express()
    app.use(express.json())
    app.use(createRpcRouter())
    return app
  }

  function hostAnswers(status: number, body: unknown) {
    return vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    )
  }

  const send = () =>
    request(makeApp())
      .post('/rpc/hosts/agent2/messages')
      .set('authorization', 'Bearer token')
      .send({ content: 'summarize', channelType: 'rpc', sender: 'desktop-app' })

  it('relays a 200 FILE_REFERENCE_INVALID refusal to the client unchanged', async () => {
    const fetchMock = hostAnswers(200, refusal)

    const response = await send()

    // Witness: the message reached the Host's runtime endpoint once.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      'http://agent2.mcp-host.svc.cluster.local:8080/v1/runtime/messages'
    )
    expect(response.status).toBe(200)
    expect(response.body).toEqual(refusal)
  })

  it('turns the same refusal into a 502 when the Host answers it with a 400', async () => {
    const fetchMock = hostAnswers(400, refusal)

    const response = await send()

    // Control: this is why the Host answers refusals with 200.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(response.status).toBe(502)
    expect(response.body).toEqual({ error: 'Upstream host unavailable' })
  })
})
