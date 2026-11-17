import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createRpcRouter } from '../routes/rpc.js'

const authTokenMock = vi.hoisted(() => ({ verifyRpcToken: vi.fn() }))
const serviceMock = vi.hoisted(() => ({
  resolveHostConnectionForUser: vi.fn(),
  forwardHostMessageToHost: vi.fn(),
}))

vi.mock('../authToken.js', () => authTokenMock)
vi.mock('../services/mcpProxyService.js', () => serviceMock)

const VALID_CLAIMS = {
  sub: 'user-uuid-123',
  typ: 'user' as const,
  accessScope: 'team' as const,
  teamId: 'team-1',
  scopes: ['host:approval:write'],
  hostRefs: ['chatllm'],
  jti: 'j1',
  iat: 1,
  exp: 9999999999,
}

const MESSAGE_ONLY_CLAIMS = {
  ...VALID_CLAIMS,
  scopes: ['host:message:invoke'],
}

const MESSAGE_AND_SESSION_WRITE_CLAIMS = {
  ...VALID_CLAIMS,
  scopes: ['host:message:invoke', 'host:session:write'],
}

const HOST_CONNECTION = {
  name: 'chatllm',
  url: 'http://chatllm:8080',
  headers: {
    'x-clerum-edge-caller': 'rpc-proxy',
    'x-clerum-edge-host-ref': 'chatllm',
    'x-clerum-edge-user-id': 'user-uuid-123',
  },
}

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use(createRpcRouter())
  return app
}

function upstreamOk(): Response {
  return {
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => JSON.stringify({ ok: true }),
  } as unknown as Response
}

const originalFetch = globalThis.fetch

describe('POST /rpc/hosts/:hostRef/approvals/approve — shellAction', () => {
  beforeEach(() => {
    authTokenMock.verifyRpcToken.mockReturnValue(VALID_CLAIMS)
    serviceMock.resolveHostConnectionForUser.mockResolvedValue(HOST_CONNECTION)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    globalThis.fetch = originalFetch
  })

  it.each(['once', 'command', 'shell'] as const)(
    'forwards shellAction %s on the approve upstream body',
    async shellAction => {
      let capturedBody: string | undefined
      globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        capturedBody = init.body as string
        return upstreamOk()
      }) as unknown as typeof fetch

      await request(makeApp())
        .post('/rpc/hosts/chatllm/approvals/approve')
        .set('authorization', 'Bearer token')
        .send({
          toolCallId: 'tc-1',
          alwaysApprove: false,
          shellAction,
          userId: 'attacker-sub',
        })
        .expect(200)

      expect(JSON.parse(capturedBody!)).toEqual({
        userId: VALID_CLAIMS.sub,
        requestId: 'tc-1',
        alwaysApprove: false,
        shellAction,
      })
    }
  )

  it.each(['yolo', 'always', '', null, 1, true, 'ONCE', 'allow_all'])(
    'returns 400 for shellAction %j and does not call the host',
    async shellAction => {
      const fetchMock = vi.fn()
      globalThis.fetch = fetchMock as unknown as typeof fetch

      const res = await request(makeApp())
        .post('/rpc/hosts/chatllm/approvals/approve')
        .set('authorization', 'Bearer token')
        .send({ toolCallId: 'tc-1', shellAction })
        .expect(400)

      expect(res.body).toEqual({ error: 'shellAction must be once, command, or shell' })
      expect(fetchMock).not.toHaveBeenCalled()
      expect(serviceMock.resolveHostConnectionForUser).not.toHaveBeenCalled()
    }
  )

  it('omits shellAction when the approve body does not carry one', async () => {
    let capturedBody: string | undefined
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedBody = init.body as string
      return upstreamOk()
    }) as unknown as typeof fetch

    await request(makeApp())
      .post('/rpc/hosts/chatllm/approvals/approve')
      .set('authorization', 'Bearer token')
      .send({ toolCallId: 'tc-1', alwaysApprove: true })
      .expect(200)

    expect(JSON.parse(capturedBody!)).toEqual({
      userId: VALID_CLAIMS.sub,
      requestId: 'tc-1',
      alwaysApprove: true,
    })
  })
})

describe('POST /rpc/hosts/:hostRef/messages — first-message approvalMode', () => {
  beforeEach(() => {
    authTokenMock.verifyRpcToken.mockReturnValue(MESSAGE_ONLY_CLAIMS)
    serviceMock.resolveHostConnectionForUser.mockResolvedValue(HOST_CONNECTION)
    serviceMock.forwardHostMessageToHost.mockResolvedValue({ success: true, status: 'completed' })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    globalThis.fetch = originalFetch
  })

  it.each(['auto', 'yolo', null, ''])(
    'returns 403 when a message-only token carries approvalMode %j',
    async approvalMode => {
      const res = await request(makeApp())
        .post('/rpc/hosts/chatllm/messages')
        .set('authorization', 'Bearer token')
        .send({ content: 'hi', approvalMode })
        .expect(403)

      expect(res.body).toEqual({ error: 'Forbidden: missing scope' })
      expect(serviceMock.forwardHostMessageToHost).not.toHaveBeenCalled()
    }
  )

  it('returns 200 and omits approvalMode when a message-only token does not carry it', async () => {
    await request(makeApp())
      .post('/rpc/hosts/chatllm/messages')
      .set('authorization', 'Bearer token')
      .send({ content: 'hi', threadId: 'chat-1' })
      .expect(200)

    expect(serviceMock.forwardHostMessageToHost).toHaveBeenCalledTimes(1)
    const forwardedBody = serviceMock.forwardHostMessageToHost.mock.calls[0][1]
    expect(forwardedBody.content).toBe('hi')
    expect(forwardedBody).not.toHaveProperty('approvalMode')
  })

  it.each(['manual', 'auto', 'allow_all'] as const)(
    'forwards approvalMode %s when the token has host:session:write',
    async approvalMode => {
      authTokenMock.verifyRpcToken.mockReturnValue(MESSAGE_AND_SESSION_WRITE_CLAIMS)

      await request(makeApp())
        .post('/rpc/hosts/chatllm/messages')
        .set('authorization', 'Bearer token')
        .send({ content: 'hi', approvalMode, model: 'claude-haiku-4-5' })
        .expect(200)

      const forwardedBody = serviceMock.forwardHostMessageToHost.mock.calls[0][1]
      expect(forwardedBody.approvalMode).toBe(approvalMode)
      expect(forwardedBody.content).toBe('hi')
      expect(forwardedBody.model).toBe('claude-haiku-4-5')
      expect(forwardedBody.sender).toBe(VALID_CLAIMS.sub)
    }
  )

  it.each(['yolo', 'allow-all', '', null, 1])(
    'omits invalid approvalMode %j instead of forwarding it',
    async approvalMode => {
      authTokenMock.verifyRpcToken.mockReturnValue(MESSAGE_AND_SESSION_WRITE_CLAIMS)

      await request(makeApp())
        .post('/rpc/hosts/chatllm/messages')
        .set('authorization', 'Bearer token')
        .send({ content: 'hi', approvalMode })
        .expect(200)

      const forwardedBody = serviceMock.forwardHostMessageToHost.mock.calls[0][1]
      expect(forwardedBody.content).toBe('hi')
      expect(forwardedBody).not.toHaveProperty('approvalMode')
    }
  )
})
