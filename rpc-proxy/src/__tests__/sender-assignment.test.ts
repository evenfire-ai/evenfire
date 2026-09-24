import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createRpcRouter } from '../routes/rpc.js'

const authTokenMock = vi.hoisted(() => ({
  verifyRpcToken: vi.fn(),
}))

const serviceMock = vi.hoisted(() => ({
  resolveHostConnectionForUser: vi.fn(),
  forwardHostMessageToHost: vi.fn(),
}))

vi.mock('../authToken.js', () => authTokenMock)
vi.mock('../services/mcpProxyService.js', () => serviceMock)

const VALID_CLAIMS = {
  sub: 'user-uuid-abc',
  typ: 'user' as const,
  accessScope: 'team' as const,
  teamId: 'team-1',
  scopes: ['host:message:invoke'],
  hostRefs: ['chatllm'],
  jti: 'j1',
  iat: 1,
  exp: 9999999999,
}

const HOST_CONNECTION = {
  name: 'chatllm',
  url: 'http://chatllm:8080',
  headers: {
    'x-clerum-edge-caller': 'rpc-proxy',
    'x-clerum-edge-host-ref': 'chatllm',
    'x-clerum-edge-user-id': 'user-uuid-abc',
  },
}

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use(createRpcRouter())
  return app
}

const originalFetch = globalThis.fetch

describe('POST /rpc/hosts/:hostRef/messages — sender assignment invariant', () => {
  beforeEach(() => {
    authTokenMock.verifyRpcToken.mockReturnValue(VALID_CLAIMS)
    serviceMock.resolveHostConnectionForUser.mockResolvedValue(HOST_CONNECTION)
    serviceMock.forwardHostMessageToHost.mockResolvedValue({ success: true, status: 'completed' })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    globalThis.fetch = originalFetch
  })

  it('forces host messages onto the authenticated rpc envelope', async () => {
    await request(makeApp())
      .post('/rpc/hosts/chatllm/messages')
      .set('authorization', 'Bearer token')
      .send({
        content: 'hi',
        channelType: 'slack',
        model: 'vision-model',
        modelSelectionRevision: 7,
        imageModel: { provider: 'untrusted', model: 'untrusted' },
        channelId: 'attacker-channel',
        hostRef: 'attacker-host',
        threadId: 'chat-1',
        sender: 'attacker-pretending-to-be-someone',
        metadata: {
          teamId: 'attacker-team',
          targetUserId: 'attacker-target',
          outputOverrides: { path: '/tmp/untrusted' },
        },
        targetUserId: 'attacker-target',
        outputOverrides: { path: '/tmp/untrusted' },
      })
      .expect(200)

    expect(serviceMock.forwardHostMessageToHost).toHaveBeenCalledTimes(1)
    const forwardedBody = serviceMock.forwardHostMessageToHost.mock.calls[0][1] as {
      messageId?: unknown
      traceContext?: unknown
    }
    // D1: messageId is now a PER-REQUEST unique idempotency id (random nonce),
    // NOT derived from content — a content-hash key would suppress legitimate
    // identical turns. Assert it is a non-empty string separately; every OTHER
    // envelope field is still server-derived and overrides client input.
    expect(typeof forwardedBody.messageId).toBe('string')
    expect(forwardedBody).not.toHaveProperty('imageModel')
    expect((forwardedBody.messageId as string).length).toBeGreaterThan(0)
    expect(forwardedBody).toMatchObject({
      content: 'hi',
      channelType: 'rpc',
      model: 'vision-model',
      modelSelectionRevision: 7,
      channelId: 'chatllm',
      hostRef: 'chatllm',
      sender: 'user-uuid-abc',
      metadata: { accessScope: 'team', teamId: 'team-1' },
      threadId: 'chat-1',
      attachments: undefined,
    })
    expect(forwardedBody.traceContext).toMatchObject({
      version: 1,
      origin: 'direct_chat',
      sessionId: 'chat-1',
    })
  })

  it('populates sender when the client omits the field entirely', async () => {
    await request(makeApp())
      .post('/rpc/hosts/chatllm/messages')
      .set('authorization', 'Bearer token')
      .send({ content: 'hi', channelType: 'rpc', channelId: 'chatllm', threadId: 'chat-1' })
      .expect(200)

    const forwardedBody = serviceMock.forwardHostMessageToHost.mock.calls[0][1]
    expect(forwardedBody.sender).toBe('user-uuid-abc')
    expect(forwardedBody.channelType).toBe('rpc')
    expect(forwardedBody.channelId).toBe('chatllm')
    expect(forwardedBody.hostRef).toBe('chatllm')
    expect(forwardedBody.metadata).toEqual({ accessScope: 'team', teamId: 'team-1' })
  })

  it('omits team identity for a user-scoped RPC token', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue({
      ...VALID_CLAIMS,
      accessScope: 'user',
      teamId: null,
    })

    await request(makeApp())
      .post('/rpc/hosts/chatllm/messages')
      .set('authorization', 'Bearer token')
      .send({ content: 'hi' })
      .expect(200)

    expect(serviceMock.resolveHostConnectionForUser).toHaveBeenCalledWith(
      'user-uuid-abc',
      'chatllm',
      'token',
      { teamId: null }
    )
    const forwardedBody = serviceMock.forwardHostMessageToHost.mock.calls[0][1]
    expect(forwardedBody.metadata).toEqual({ accessScope: 'user' })
  })
})

describe('POST /rpc/hosts/:hostRef/messages — structured file references (#666)', () => {
  const RID = '1234567890abcdef1234567890abcdef'
  const fileReference = {
    schemaVersion: 1,
    id: `gfs:main:${RID}@v3`,
    source: {
      kind: 'gfs',
      drive: 'main',
      resourceId: RID,
      gfsUri: `gfs://main/${RID}`,
      version: 3,
    },
    name: 'plan.md',
    declaredMediaType: 'text/markdown',
    detectedMediaType: 'text/markdown',
    class: 'markdown',
    detection: 'declared',
    mismatch: false,
    byteLength: 120,
    textReadable: true,
    reader: 'text',
    modelImageInput: 'unsupported',
  }

  beforeEach(() => {
    authTokenMock.verifyRpcToken.mockReturnValue(VALID_CLAIMS)
    serviceMock.resolveHostConnectionForUser.mockResolvedValue(HOST_CONNECTION)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('forwards the references verbatim and relays the accepted ids', async () => {
    serviceMock.forwardHostMessageToHost.mockResolvedValue({
      success: true,
      status: 'pending',
      taskId: 'task-1',
      acceptedFileReferenceIds: [fileReference.id],
    })
    const response = await request(makeApp())
      .post('/rpc/hosts/chatllm/messages')
      .set('authorization', 'Bearer token')
      .send({ content: 'Summarize the plan', threadId: 'chat-1', fileReferences: [fileReference] })
      .expect(200)

    expect(serviceMock.forwardHostMessageToHost).toHaveBeenCalledTimes(1)
    const forwardedBody = serviceMock.forwardHostMessageToHost.mock.calls[0][1]
    expect(forwardedBody.fileReferences).toEqual([fileReference])
    expect(response.body.acceptedFileReferenceIds).toEqual([fileReference.id])
  })

  it('leaves a malformed value for mcp-host to refuse with its typed code', async () => {
    serviceMock.forwardHostMessageToHost.mockResolvedValue({ success: true, status: 'completed' })
    await request(makeApp())
      .post('/rpc/hosts/chatllm/messages')
      .set('authorization', 'Bearer token')
      .send({ content: 'hi', fileReferences: { id: 'not-a-list' } })
      .expect(200)

    expect(serviceMock.forwardHostMessageToHost.mock.calls[0][1].fileReferences).toEqual({
      id: 'not-a-list',
    })
  })

  it('omits the field when the client sends no references', async () => {
    serviceMock.forwardHostMessageToHost.mockResolvedValue({ success: true, status: 'completed' })
    await request(makeApp())
      .post('/rpc/hosts/chatllm/messages')
      .set('authorization', 'Bearer token')
      .send({ content: 'hi', threadId: 'chat-1' })
      .expect(200)

    // Witness: the message was forwarded with its content.
    expect(serviceMock.forwardHostMessageToHost).toHaveBeenCalledTimes(1)
    const forwardedBody = serviceMock.forwardHostMessageToHost.mock.calls[0][1]
    expect(forwardedBody.content).toBe('hi')
    expect(forwardedBody).not.toHaveProperty('fileReferences')
  })
})

describe('POST /rpc/hosts/:hostRef/approvals/approve — userId identity invariant', () => {
  beforeEach(() => {
    authTokenMock.verifyRpcToken.mockReturnValue({
      ...VALID_CLAIMS,
      scopes: ['host:approval:write'],
    })
    serviceMock.resolveHostConnectionForUser.mockResolvedValue(HOST_CONNECTION)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    globalThis.fetch = originalFetch
  })

  it('forwards userId = auth.sub regardless of client-supplied userId', async () => {
    let capturedBody: string | undefined
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedBody = init.body as string
      return {
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => JSON.stringify({ ok: true }),
      } as unknown as Response
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await request(makeApp())
      .post('/rpc/hosts/chatllm/approvals/approve')
      .set('authorization', 'Bearer user-token')
      .send({ toolCallId: 'tc-1', userId: 'attacker-sub' })
      .expect(200)

    expect(capturedBody).toBeDefined()
    const parsed = JSON.parse(capturedBody!)
    expect(parsed.userId).toBe(VALID_CLAIMS.sub)
  })
})

describe('POST /rpc/hosts/:hostRef/approvals/deny — userId identity invariant', () => {
  beforeEach(() => {
    authTokenMock.verifyRpcToken.mockReturnValue({
      ...VALID_CLAIMS,
      scopes: ['host:approval:write'],
    })
    serviceMock.resolveHostConnectionForUser.mockResolvedValue(HOST_CONNECTION)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    globalThis.fetch = originalFetch
  })

  it('forwards userId = auth.sub regardless of client-supplied userId', async () => {
    let capturedBody: string | undefined
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedBody = init.body as string
      return {
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => JSON.stringify({ ok: true }),
      } as unknown as Response
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await request(makeApp())
      .post('/rpc/hosts/chatllm/approvals/deny')
      .set('authorization', 'Bearer user-token')
      .send({ toolCallId: 'tc-1', userId: 'attacker-sub' })
      .expect(200)

    expect(capturedBody).toBeDefined()
    const parsed = JSON.parse(capturedBody!)
    expect(parsed.userId).toBe(VALID_CLAIMS.sub)
  })
})
