import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Request, Response } from 'express'
import { config } from '../../config'
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
})
