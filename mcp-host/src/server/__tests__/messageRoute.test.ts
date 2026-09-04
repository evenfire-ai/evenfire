import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Request, Response } from 'express'
import type { TrustedEdgeActionContextV2 } from '@clerum/action-context-contracts'
import { config } from '../../config'
import { ConversationError, ConversationErrorCode } from '../../core/errors'
import { handleMessageRoute } from '../routes'
import { makeHandlers } from './testHelpers'

interface CapturedRes {
  statusCode?: number
  jsonBody?: unknown
  res: Response
}

function makeRes(): CapturedRes {
  const captured: { statusCode?: number; jsonBody?: unknown } = {}
  const res = {
    writeHead: vi.fn().mockImplementation((status: number) => {
      captured.statusCode = status
      return res
    }),
    end: vi.fn().mockImplementation((body?: string) => {
      if (typeof body === 'string') {
        try {
          captured.jsonBody = JSON.parse(body)
        } catch {
          captured.jsonBody = body
        }
      }
      return res
    }),
  } as unknown as Response
  return {
    get statusCode() {
      return captured.statusCode
    },
    get jsonBody() {
      return captured.jsonBody
    },
    res,
  }
}

describe('handleMessageRoute — rpc sender identity invariant', () => {
  // Tests assume auth is enabled (production / minikube default).
  beforeEach(() => {
    ;(config as { enableAuth: boolean }).enableAuth = true
  })
  afterEach(() => {
    ;(config as { enableAuth: boolean }).enableAuth = true
  })

  it('overwrites sender with auth.sub for channelType=rpc (defense-in-depth)', async () => {
    const messageHandler = vi.fn().mockResolvedValue({ success: true, status: 'completed' })
    const req = {
      runtimeCaller: { caller: 'rpc-proxy', hostRef: 'chatllm', userId: 'legit-user' },
      body: {
        sender: 'attacker-pretending-to-be-victim',
        channelType: 'rpc',
        channelId: 'agent-x',
        threadId: 'chat-1',
        content: 'hi',
        timestamp: 'now',
        messageId: 'm1',
        hostRef: 'chatllm',
      },
      query: {},
    } as unknown as Request
    const captured = makeRes()
    await handleMessageRoute(req, captured.res, makeHandlers({ messageHandler }))
    expect(messageHandler).toHaveBeenCalledTimes(1)
    const forwarded = messageHandler.mock.calls[0][0]
    expect(forwarded.sender).toBe('legit-user')
  })

  it('strips spoofed authority metadata and attaches immutable v2 provenance', async () => {
    const messageHandler = vi.fn().mockResolvedValue({ success: true, status: 'completed' })
    const actionContextV2 = {
      version: 2,
      userId: '11111111-1111-4111-8111-111111111111',
      sid: '22222222-2222-4222-8222-222222222222',
      sessionVersion: 3,
      delegationJti: '33333333-3333-4333-8333-333333333333',
      operationId: 'chat.message.invoke',
      resource: {
        environmentId: 'cluster.local/evenfire',
        type: 'host',
        canonicalId: 'host:mcp-host/chatllm',
        logicalId: 'mcp-host/chatllm',
        displayName: 'chatllm',
      },
      target: {
        hostRef: 'mcp-host/chatllm',
        channelType: 'rpc',
        channelId: 'chatllm',
        messageId: '44444444-4444-4444-8444-444444444444',
      },
      targetHash: `ath2_${'a'.repeat(43)}`,
      accessPathId: `ap1_${'b'.repeat(43)}`,
      authorizationRevision: `ar1_${'c'.repeat(43)}`,
      pathKind: 'direct',
      effectiveTeamId: null,
      behaviorBindingHash: `bh2_${'d'.repeat(43)}`,
      behavior: {
        budget: { state: 'known', value: 'direct-budget' },
        credentialPolicy: { state: 'known', value: null },
        approvalPolicy: { state: 'known', value: null },
        filesystemScope: { state: 'known', value: null },
        runtime: { state: 'known', value: 'runtime-a' },
        providerModelPolicy: { state: 'known', value: 'models-a' },
        audit: { state: 'known', value: 'audit-a' },
      },
      checkedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    } satisfies TrustedEdgeActionContextV2
    const req = {
      runtimeCaller: {
        caller: 'rpc-proxy',
        hostRef: 'chatllm',
        userId: actionContextV2.userId,
        actionContextV2,
      },
      body: {
        sender: 'attacker',
        channelType: 'rpc',
        channelId: 'chatllm',
        content: 'hi',
        timestamp: 'now',
        messageId: actionContextV2.target.messageId,
        hostRef: 'chatllm',
        model: 'attacker-model',
        authorityV2: { accessPathId: 'attacker-path' },
        metadata: {
          teamId: 'attacker-team',
          budget: 'attacker-budget',
          provider: 'attacker-provider',
          model: 'attacker-model',
          auditOwner: 'attacker-owner',
          harmlessLabel: 'presentation',
        },
      },
      query: {},
    } as unknown as Request
    const captured = makeRes()

    await handleMessageRoute(req, captured.res, makeHandlers({ messageHandler }))

    expect(captured.statusCode).toBe(200)
    const forwarded = messageHandler.mock.calls[0][0]
    expect(forwarded.sender).toBe(actionContextV2.userId)
    expect(forwarded.model).toBeUndefined()
    expect(forwarded.metadata).toEqual({ harmlessLabel: 'presentation' })
    expect(forwarded.authorityV2).toMatchObject({
      version: 2,
      userId: actionContextV2.userId,
      sessionVersion: 3,
      accessPathId: actionContextV2.accessPathId,
      effectiveTeamId: null,
    })
  })

  it('rejects a messageId that differs from the trusted v2 operation target', async () => {
    const messageHandler = vi.fn()
    const req = {
      runtimeCaller: {
        caller: 'rpc-proxy',
        hostRef: 'chatllm',
        userId: '11111111-1111-4111-8111-111111111111',
        actionContextV2: {
          operationId: 'chat.message.invoke',
          target: {
            channelType: 'rpc',
            channelId: 'chatllm',
            messageId: 'trusted-message-id',
          },
        },
      },
      body: {
        sender: 'attacker',
        channelType: 'rpc',
        channelId: 'chatllm',
        content: 'hi',
        timestamp: 'now',
        messageId: 'substituted-message-id',
        hostRef: 'chatllm',
      },
      query: {},
    } as unknown as Request
    const captured = makeRes()
    await handleMessageRoute(req, captured.res, makeHandlers({ messageHandler }))
    expect(captured.statusCode).toBe(403)
    expect(messageHandler).not.toHaveBeenCalled()
  })

  it('returns 401 for channelType=rpc when edge user context is missing', async () => {
    const messageHandler = vi.fn()
    const req = {
      body: {
        sender: 'someone',
        channelType: 'rpc',
        channelId: 'agent-x',
        threadId: 'chat-1',
        content: 'hi',
        timestamp: 'now',
        messageId: 'm1',
        hostRef: 'chatllm',
      },
      query: {},
    } as unknown as Request
    const captured = makeRes()
    await handleMessageRoute(req, captured.res, makeHandlers({ messageHandler }))
    expect(captured.statusCode).toBe(401)
    expect(messageHandler).not.toHaveBeenCalled()
  })

  it('leaves sender unchanged for non-rpc channels', async () => {
    const messageHandler = vi.fn().mockResolvedValue({ success: true, status: 'completed' })
    const req = {
      runtimeCaller: {
        caller: 'channel-reader',
        hostRef: 'chatllm',
        channelType: 'slack',
        channelId: 'C1',
        sender: '@user123',
      },
      body: {
        sender: '@user123',
        channelType: 'slack',
        channelId: 'C1',
        threadId: 't1',
        content: 'hi',
        timestamp: 'now',
        messageId: 'm1',
        hostRef: 'chatllm',
      },
      query: {},
    } as unknown as Request
    const captured = makeRes()
    await handleMessageRoute(req, captured.res, makeHandlers({ messageHandler }))
    expect(messageHandler).toHaveBeenCalledTimes(1)
    const forwarded = messageHandler.mock.calls[0][0]
    expect(forwarded.sender).toBe('@user123')
  })

  it('rejects channelType=rpc without rpc-proxy edge context even when auth is disabled', async () => {
    ;(config as { enableAuth: boolean }).enableAuth = false
    const messageHandler = vi.fn().mockResolvedValue({ success: true, status: 'completed' })
    const req = {
      body: {
        sender: 'dev-user',
        channelType: 'rpc',
        channelId: 'agent-x',
        threadId: 'chat-1',
        content: 'hi',
        timestamp: 'now',
        messageId: 'm1',
        hostRef: 'chatllm',
      },
      query: {},
    } as unknown as Request
    const captured = makeRes()
    await handleMessageRoute(req, captured.res, makeHandlers({ messageHandler }))
    expect(captured.statusCode).toBe(401)
    expect(messageHandler).not.toHaveBeenCalled()
  })

  it('rejects channel-reader attempts to smuggle channelType=rpc', async () => {
    const messageHandler = vi.fn().mockResolvedValue({ success: true, status: 'completed' })
    const req = {
      runtimeCaller: {
        caller: 'channel-reader',
        hostRef: 'chatllm',
        channelType: 'telegram',
        channelId: 'tg-chat-1',
        sender: '123456',
      },
      body: {
        sender: '123456',
        channelType: 'rpc',
        channelId: 'agent-x',
        threadId: 'chat-1',
        content: 'hi',
        timestamp: 'now',
        messageId: 'm1',
        hostRef: 'chatllm',
      },
      query: {},
    } as unknown as Request
    const captured = makeRes()
    await handleMessageRoute(req, captured.res, makeHandlers({ messageHandler }))
    expect(captured.statusCode).toBe(401)
    expect(messageHandler).not.toHaveBeenCalled()
  })

  it('rejects rpc-proxy attempts to submit provider channel messages', async () => {
    const messageHandler = vi.fn().mockResolvedValue({ success: true, status: 'completed' })
    const req = {
      runtimeCaller: { caller: 'rpc-proxy', hostRef: 'chatllm', userId: 'legit-user' },
      body: {
        sender: '123456',
        channelType: 'telegram',
        channelId: 'tg-chat-1',
        content: 'hi',
        timestamp: 'now',
        messageId: 'm1',
        hostRef: 'chatllm',
      },
      query: {},
    } as unknown as Request
    const captured = makeRes()
    await handleMessageRoute(req, captured.res, makeHandlers({ messageHandler }))
    expect(captured.statusCode).toBe(403)
    expect(messageHandler).not.toHaveBeenCalled()
  })

  it('maps persisted ownership mismatches to a generic 403', async () => {
    const messageHandler = vi
      .fn()
      .mockRejectedValue(
        new ConversationError('sensitive ownership detail', ConversationErrorCode.OwnershipMismatch)
      )
    const req = {
      runtimeCaller: { caller: 'rpc-proxy', hostRef: 'chatllm', userId: 'legit-user' },
      body: {
        sender: 'legit-user',
        channelType: 'rpc',
        channelId: 'agent-x',
        threadId: 'chat-1',
        content: 'hi',
        timestamp: 'now',
        messageId: 'm1',
        hostRef: 'chatllm',
      },
      query: {},
    } as unknown as Request
    const captured = makeRes()

    await handleMessageRoute(req, captured.res, makeHandlers({ messageHandler }))

    expect(captured.statusCode).toBe(403)
    expect(captured.jsonBody).toEqual({ success: false, error: 'session access denied' })
  })
})

describe('handleMessageRoute — async response serialization', () => {
  beforeEach(() => {
    ;(config as { enableAuth: boolean }).enableAuth = true
  })
  afterEach(() => {
    ;(config as { enableAuth: boolean }).enableAuth = true
  })

  // Regression: the piggybacked-model path (R2 "Option A") wraps the handler in
  // an async IIFE (it must persist `message.model` before enqueue), so the async
  // branch can return a Promise. If the route does not AWAIT it, `json()`
  // JSON.stringify's a Promise to `{}` and the async ack's `taskId` is dropped —
  // the desktop then treats a background task as a sync reply and never
  // subscribes to its progress.
  it('awaits a Promise-returning handler on async=true so the ack (taskId) survives', async () => {
    const ack = { success: true, status: 'processing', taskId: 'task-abc' }
    // mockReturnValue(Promise.resolve(...)) — a genuine Promise, mirroring the
    // piggyback wrapper — NOT a synchronously-returned object.
    const messageHandler = vi.fn().mockReturnValue(Promise.resolve(ack))
    const req = {
      runtimeCaller: { caller: 'rpc-proxy', hostRef: 'chatllm', userId: 'legit-user' },
      body: {
        sender: 'legit-user',
        channelType: 'rpc',
        channelId: 'agent-x',
        threadId: 'chat-1',
        content: 'hi',
        timestamp: 'now',
        messageId: 'm1',
        hostRef: 'chatllm',
      },
      query: { async: 'true' },
    } as unknown as Request
    const captured = makeRes()
    await handleMessageRoute(req, captured.res, makeHandlers({ messageHandler }))
    expect(messageHandler).toHaveBeenCalledWith(expect.objectContaining({ sender: 'legit-user' }), {
      async: true,
    })
    expect(captured.statusCode).toBe(200)
    expect(captured.jsonBody).toEqual(ack)
  })

  it('serializes a synchronously-returned ack unchanged on async=true', async () => {
    const ack = { success: true, status: 'processing', taskId: 'task-sync' }
    // The non-piggyback async path returns its ack synchronously; awaiting a
    // non-thenable is a harmless no-op and the body must be identical.
    const messageHandler = vi.fn().mockReturnValue(ack)
    const req = {
      runtimeCaller: { caller: 'rpc-proxy', hostRef: 'chatllm', userId: 'legit-user' },
      body: {
        sender: 'legit-user',
        channelType: 'rpc',
        channelId: 'agent-x',
        threadId: 'chat-1',
        content: 'hi',
        timestamp: 'now',
        messageId: 'm1',
        hostRef: 'chatllm',
      },
      query: { async: 'true' },
    } as unknown as Request
    const captured = makeRes()
    await handleMessageRoute(req, captured.res, makeHandlers({ messageHandler }))
    expect(captured.statusCode).toBe(200)
    expect(captured.jsonBody).toEqual(ack)
  })
})
