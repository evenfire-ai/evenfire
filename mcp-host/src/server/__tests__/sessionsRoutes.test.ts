import { describe, expect, it, vi } from 'vitest'
import type { Request, Response } from 'express'
import {
  handleContextBreakdownRoute,
  handleSessionMessagesRoute,
  handleSessionsListRoute,
} from '../routes'
import type { ContextBreakdownHandler, SessionMessagesHandler, SessionsListHandler } from '../types'
import { encodeSessionsCursor, sessionsCursorScope } from '../wireProjections'
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

function makeReqWithAuth(sub: string): Request {
  return {
    runtimeCaller: { caller: 'rpc-proxy', hostRef: 'chatllm', userId: sub },
    query: {},
  } as unknown as Request
}

describe('handleSessionsListRoute', () => {
  it('returns 200 with items array for the authenticated user', async () => {
    const sessionsListHandler: SessionsListHandler = vi.fn().mockReturnValue({
      items: [
        { agent: 'chatllm', chatId: 'c1', turnCount: 3, lastActivityAt: '2026-04-22T00:00:00Z' },
      ],
    })
    const req = makeReqWithAuth('user-1')
    const captured = makeRes()
    await handleSessionsListRoute(req, captured.res, makeHandlers({ sessionsListHandler }))
    expect(captured.statusCode).toBe(200)
    expect(captured.jsonBody).toEqual({
      items: [
        { agent: 'chatllm', chatId: 'c1', turnCount: 3, lastActivityAt: '2026-04-22T00:00:00Z' },
      ],
    })
    expect(sessionsListHandler).toHaveBeenCalledWith('user-1', {
      agent: undefined,
      limit: undefined,
      cursor: undefined,
    })
  })

  it('normalizes pagination query parameters before calling the handler', async () => {
    const sessionsListHandler: SessionsListHandler = vi.fn().mockReturnValue({
      items: [],
      nextCursor: 'next-page',
    })
    const req = {
      ...makeReqWithAuth('user-1'),
      query: {
        limit: '500',
        cursor: encodeSessionsCursor(
          '2026-04-22T00:00:00.000Z',
          'k1',
          sessionsCursorScope('user-1')
        ),
      },
    } as unknown as Request
    const captured = makeRes()

    await handleSessionsListRoute(req, captured.res, makeHandlers({ sessionsListHandler }))

    expect(captured.statusCode).toBe(200)
    expect(sessionsListHandler).toHaveBeenCalledWith('user-1', {
      agent: undefined,
      limit: 100,
      cursor: encodeSessionsCursor('2026-04-22T00:00:00.000Z', 'k1', sessionsCursorScope('user-1')),
    })
    expect(captured.jsonBody).toEqual({ items: [], nextCursor: 'next-page' })
  })

  it('defaults a cursor-only catalog request to 50 sessions', async () => {
    const sessionsListHandler: SessionsListHandler = vi.fn().mockReturnValue({ items: [] })
    const cursor = encodeSessionsCursor(
      '2026-04-22T00:00:00.000Z',
      'chat-1',
      sessionsCursorScope('user-1')
    )
    const req = {
      ...makeReqWithAuth('user-1'),
      query: { cursor },
    } as unknown as Request
    const captured = makeRes()

    await handleSessionsListRoute(req, captured.res, makeHandlers({ sessionsListHandler }))

    expect(sessionsListHandler).toHaveBeenCalledWith('user-1', {
      agent: undefined,
      limit: 50,
      cursor,
    })
  })

  it('passes a validated agent scope to the catalog handler before pagination', async () => {
    const sessionsListHandler: SessionsListHandler = vi.fn().mockReturnValue({ items: [] })
    const req = {
      ...makeReqWithAuth('user-1'),
      query: { agent: 'chatllm', limit: '25' },
    } as unknown as Request
    const captured = makeRes()

    await handleSessionsListRoute(req, captured.res, makeHandlers({ sessionsListHandler }))

    expect(captured.statusCode).toBe(200)
    expect(sessionsListHandler).toHaveBeenCalledWith('user-1', {
      agent: 'chatllm',
      limit: 25,
      cursor: undefined,
    })
  })

  it('rejects a cursor issued for another agent scope', async () => {
    const sessionsListHandler: SessionsListHandler = vi.fn().mockReturnValue({ items: [] })
    const req = {
      ...makeReqWithAuth('user-1'),
      query: {
        agent: 'agent-b',
        cursor: encodeSessionsCursor(
          '2026-04-22T00:00:00.000Z',
          'chat-1',
          sessionsCursorScope('user-1', 'agent-a')
        ),
      },
    } as unknown as Request
    const captured = makeRes()

    await handleSessionsListRoute(req, captured.res, makeHandlers({ sessionsListHandler }))

    expect(captured.statusCode).toBe(400)
    expect(sessionsListHandler).not.toHaveBeenCalled()
  })

  it('rejects malformed session cursors instead of treating them as page one', async () => {
    const sessionsListHandler: SessionsListHandler = vi.fn()
    const req = {
      ...makeReqWithAuth('user-1'),
      query: { cursor: 'not-json' },
    } as unknown as Request
    const captured = makeRes()

    await handleSessionsListRoute(req, captured.res, makeHandlers({ sessionsListHandler }))

    expect(captured.statusCode).toBe(400)
    expect(sessionsListHandler).not.toHaveBeenCalled()
  })

  it('rejects malformed limits instead of silently changing the request', async () => {
    const sessionsListHandler: SessionsListHandler = vi.fn()
    const req = {
      ...makeReqWithAuth('user-1'),
      query: { limit: 'not-a-number' },
    } as unknown as Request
    const captured = makeRes()

    await handleSessionsListRoute(req, captured.res, makeHandlers({ sessionsListHandler }))

    expect(captured.statusCode).toBe(400)
    expect(sessionsListHandler).not.toHaveBeenCalled()
  })

  it.each([
    ['fractional limit', { limit: '1.5' }],
    ['hexadecimal limit', { limit: '0x10' }],
    ['exponential limit', { limit: '1e2' }],
    ['repeated limit', { limit: ['1', '2'] }],
    ['repeated cursor', { cursor: ['one', 'two'] }],
    ['repeated agent', { agent: ['agent-a', 'agent-b'] }],
    ['bracketed agent', { 'agent[]': 'agent-a' }],
    ['dot agent', { agent: '.' }],
    ['colon-bearing agent', { agent: 'agent:other' }],
    ['control-bearing agent', { agent: 'agent\nother' }],
  ])('rejects %s query input', async (_label, query) => {
    const sessionsListHandler: SessionsListHandler = vi.fn()
    const req = {
      ...makeReqWithAuth('user-1'),
      query,
    } as unknown as Request
    const captured = makeRes()

    await handleSessionsListRoute(req, captured.res, makeHandlers({ sessionsListHandler }))

    expect(captured.statusCode).toBe(400)
    expect(sessionsListHandler).not.toHaveBeenCalled()
  })

  it('returns 501 when sessionsListHandler is not configured', async () => {
    const req = makeReqWithAuth('user-1')
    const captured = makeRes()
    await handleSessionsListRoute(req, captured.res, makeHandlers({ sessionsListHandler: null }))
    expect(captured.statusCode).toBe(501)
  })

  it('validates a malformed cursor before reporting an unavailable list handler', async () => {
    const req = {
      ...makeReqWithAuth('user-1'),
      query: { cursor: 'not-json' },
    } as unknown as Request
    const captured = makeRes()

    await handleSessionsListRoute(
      req,
      captured.res,
      makeHandlers({ sessionsListHandler: null })
    )

    expect(captured.statusCode).toBe(400)
    expect(captured.jsonBody).toEqual({ error: 'Invalid sessions cursor' })
  })

  it('returns 401 if req.auth is missing', async () => {
    const req = {} as Request
    const captured = makeRes()
    await handleSessionsListRoute(req, captured.res, makeHandlers({ sessionsListHandler: vi.fn() }))
    expect(captured.statusCode).toBe(401)
  })

  it('returns 500 when sessionsListHandler throws', async () => {
    const sessionsListHandler: SessionsListHandler = vi
      .fn()
      .mockRejectedValue(new Error('db unavailable'))
    const req = makeReqWithAuth('user-1')
    const captured = makeRes()
    await handleSessionsListRoute(req, captured.res, makeHandlers({ sessionsListHandler }))
    expect(captured.statusCode).toBe(500)
    expect((captured.jsonBody as { error: string }).error).toBe('db unavailable')
  })
})

function makeReqWithParams(sub: string, agent: string, chatId: string): Request {
  return {
    runtimeCaller: { caller: 'rpc-proxy', hostRef: 'chatllm', userId: sub },
    params: { agent, chatId },
    query: {},
  } as unknown as Request
}

describe('handleSessionMessagesRoute', () => {
  it('returns 200 with the transcript when the session exists for this user', async () => {
    const sessionMessagesHandler: SessionMessagesHandler = vi.fn().mockReturnValue({
      agent: 'chatllm',
      chatId: 'c1',
      totalTurns: 1,
      oldestTurnNumber: 1,
      latestTurnNumber: 1,
      hasMoreBefore: false,
      hasMoreAfter: false,
      turns: [
        { number: 1, user_input: 'hello', response: 'hi', started_at: '2026-04-22T00:00:00Z' },
      ],
    })
    const req = makeReqWithParams('user-1', 'chatllm', 'c1')
    const captured = makeRes()
    await handleSessionMessagesRoute(req, captured.res, makeHandlers({ sessionMessagesHandler }))
    expect(captured.statusCode).toBe(200)
    expect(captured.jsonBody).toEqual({
      agent: 'chatllm',
      chatId: 'c1',
      totalTurns: 1,
      oldestTurnNumber: 1,
      latestTurnNumber: 1,
      hasMoreBefore: false,
      hasMoreAfter: false,
      turns: [
        { number: 1, user_input: 'hello', response: 'hi', started_at: '2026-04-22T00:00:00Z' },
      ],
    })
    expect(sessionMessagesHandler).toHaveBeenCalledWith('user-1', 'chatllm', 'c1', {
      limit: undefined,
      beforeTurn: undefined,
      afterTurn: undefined,
    })
  })

  it('normalizes bounded history pagination before calling the handler', async () => {
    const sessionMessagesHandler: SessionMessagesHandler = vi.fn().mockReturnValue({
      agent: 'chatllm',
      chatId: 'c1',
      totalTurns: 30,
      oldestTurnNumber: 11,
      latestTurnNumber: 20,
      hasMoreBefore: true,
      hasMoreAfter: true,
      turns: [],
    })
    const req = {
      ...makeReqWithParams('user-1', 'chatllm', 'c1'),
      query: { limit: '500', beforeTurn: '21' },
    } as unknown as Request
    const captured = makeRes()

    await handleSessionMessagesRoute(req, captured.res, makeHandlers({ sessionMessagesHandler }))

    expect(captured.statusCode).toBe(200)
    expect(sessionMessagesHandler).toHaveBeenCalledWith('user-1', 'chatllm', 'c1', {
      limit: 200,
      beforeTurn: 21,
      afterTurn: undefined,
    })
  })

  it.each([
    ['beforeTurn', '21', { beforeTurn: 21, afterTurn: undefined }],
    ['afterTurn', '0', { beforeTurn: undefined, afterTurn: 0 }],
  ])('defaults a %s-only transcript request to 80 turns', async (name, value, cursors) => {
    const sessionMessagesHandler: SessionMessagesHandler = vi.fn().mockReturnValue({
      agent: 'chatllm',
      chatId: 'c1',
      totalTurns: 0,
      hasMoreBefore: false,
      hasMoreAfter: false,
      turns: [],
    })
    const req = {
      ...makeReqWithParams('user-1', 'chatllm', 'c1'),
      query: { [name]: value },
    } as unknown as Request
    const captured = makeRes()

    await handleSessionMessagesRoute(req, captured.res, makeHandlers({ sessionMessagesHandler }))

    expect(sessionMessagesHandler).toHaveBeenCalledWith('user-1', 'chatllm', 'c1', {
      limit: 80,
      ...cursors,
    })
  })

  it('rejects simultaneous beforeTurn and afterTurn cursors', async () => {
    const sessionMessagesHandler: SessionMessagesHandler = vi.fn()
    const req = {
      ...makeReqWithParams('user-1', 'chatllm', 'c1'),
      query: { beforeTurn: '10', afterTurn: '20' },
    } as unknown as Request
    const captured = makeRes()

    await handleSessionMessagesRoute(req, captured.res, makeHandlers({ sessionMessagesHandler }))

    expect(captured.statusCode).toBe(400)
    expect(sessionMessagesHandler).not.toHaveBeenCalled()
  })

  it.each([
    ['beforeTurn', 'abc'],
    ['beforeTurn', '0'],
    ['beforeTurn', '1.5'],
    ['beforeTurn', '0x10'],
    ['beforeTurn', '1e2'],
    ['afterTurn', 'abc'],
    ['afterTurn', '-1'],
    ['afterTurn', '1.5'],
    ['limit', '1.5'],
    ['limit', '0x10'],
    ['limit', '1e2'],
  ])('rejects malformed %s cursors', async (name, value) => {
    const sessionMessagesHandler: SessionMessagesHandler = vi.fn()
    const req = {
      ...makeReqWithParams('user-1', 'chatllm', 'c1'),
      query: { [name]: value },
    } as unknown as Request
    const captured = makeRes()

    await handleSessionMessagesRoute(req, captured.res, makeHandlers({ sessionMessagesHandler }))

    expect(captured.statusCode).toBe(400)
    expect(sessionMessagesHandler).not.toHaveBeenCalled()
  })

  it('rejects repeated message pagination parameters', async () => {
    const sessionMessagesHandler: SessionMessagesHandler = vi.fn()
    const req = {
      ...makeReqWithParams('user-1', 'chatllm', 'c1'),
      query: { limit: ['1', '2'] },
    } as unknown as Request
    const captured = makeRes()

    await handleSessionMessagesRoute(req, captured.res, makeHandlers({ sessionMessagesHandler }))

    expect(captured.statusCode).toBe(400)
    expect(sessionMessagesHandler).not.toHaveBeenCalled()
  })

  it('rejects bracketed message pagination parameters', async () => {
    const sessionMessagesHandler: SessionMessagesHandler = vi.fn()
    const req = {
      ...makeReqWithParams('user-1', 'chatllm', 'c1'),
      query: { 'beforeTurn[]': '1' },
    } as unknown as Request
    const captured = makeRes()

    await handleSessionMessagesRoute(req, captured.res, makeHandlers({ sessionMessagesHandler }))

    expect(captured.statusCode).toBe(400)
    expect(sessionMessagesHandler).not.toHaveBeenCalled()
  })

  it.each([
    ['dot agent', '.', 'chat-1'],
    ['colon-bearing agent', 'agent:other', 'chat-1'],
    ['dot-dot chat id', 'agent', '..'],
    ['separator-bearing chat id', 'agent', 'nested/chat'],
    ['control-bearing agent', 'agent\nother', 'chat-1'],
    ['control-bearing chat id', 'agent', 'chat\nother'],
  ])('rejects unsafe %s route segments', async (_label, agent, chatId) => {
    const sessionMessagesHandler: SessionMessagesHandler = vi.fn()
    const req = makeReqWithParams('user-1', agent, chatId)
    const captured = makeRes()

    await handleSessionMessagesRoute(req, captured.res, makeHandlers({ sessionMessagesHandler }))

    expect(captured.statusCode).toBe(400)
    expect(sessionMessagesHandler).not.toHaveBeenCalled()
  })

  it('returns 404 with the canonical body when the session does not exist', async () => {
    const sessionMessagesHandler: SessionMessagesHandler = vi.fn().mockReturnValue(null)
    const req = makeReqWithParams('user-1', 'chatllm', 'c-missing')
    const captured = makeRes()
    await handleSessionMessagesRoute(req, captured.res, makeHandlers({ sessionMessagesHandler }))
    expect(captured.statusCode).toBe(404)
    expect(captured.jsonBody).toEqual({ error: 'session not found' })
  })

  it('returns 404 with the SAME body when the session exists for another user (enumeration-defense)', async () => {
    // Simulate the handler impl: it returns null both when missing and when owned by someone else.
    // The route must not distinguish.
    const sessionMessagesHandler: SessionMessagesHandler = vi.fn().mockReturnValue(null)
    const req = makeReqWithParams('user-1', 'chatllm', 'c-belongs-to-user-2')
    const captured = makeRes()
    await handleSessionMessagesRoute(req, captured.res, makeHandlers({ sessionMessagesHandler }))
    expect(captured.statusCode).toBe(404)
    expect(captured.jsonBody).toEqual({ error: 'session not found' })
  })

  it('returns 400 if agent or chatId is missing from params', async () => {
    const sessionMessagesHandler: SessionMessagesHandler = vi.fn()
    const req = {
      runtimeCaller: { caller: 'rpc-proxy', hostRef: 'chatllm', userId: 'user-1' },
      params: { agent: '', chatId: '' },
      query: {},
    } as unknown as Request
    const captured = makeRes()
    await handleSessionMessagesRoute(req, captured.res, makeHandlers({ sessionMessagesHandler }))
    expect(captured.statusCode).toBe(400)
  })

  it('returns 401 if req.auth is missing', async () => {
    const req = { params: { agent: 'chatllm', chatId: 'c1' }, query: {} } as unknown as Request
    const captured = makeRes()
    await handleSessionMessagesRoute(
      req,
      captured.res,
      makeHandlers({ sessionMessagesHandler: vi.fn() })
    )
    expect(captured.statusCode).toBe(401)
  })

  it('returns 501 when sessionMessagesHandler is not configured', async () => {
    const req = makeReqWithParams('user-1', 'chatllm', 'c1')
    const captured = makeRes()
    await handleSessionMessagesRoute(
      req,
      captured.res,
      makeHandlers({ sessionMessagesHandler: null })
    )
    expect(captured.statusCode).toBe(501)
  })

  it('validates malformed pagination before reporting an unavailable messages handler', async () => {
    const req = {
      ...makeReqWithParams('user-1', 'chatllm', 'c1'),
      query: { limit: '1.5' },
    } as unknown as Request
    const captured = makeRes()

    await handleSessionMessagesRoute(
      req,
      captured.res,
      makeHandlers({ sessionMessagesHandler: null })
    )

    expect(captured.statusCode).toBe(400)
    expect(captured.jsonBody).toEqual({ error: 'limit must be a positive integer' })
  })

  it('returns 500 when sessionMessagesHandler throws', async () => {
    const sessionMessagesHandler: SessionMessagesHandler = vi
      .fn()
      .mockRejectedValue(new Error('db unavailable'))
    const req = makeReqWithParams('user-1', 'chatllm', 'c1')
    const captured = makeRes()
    await handleSessionMessagesRoute(req, captured.res, makeHandlers({ sessionMessagesHandler }))
    expect(captured.statusCode).toBe(500)
    expect((captured.jsonBody as { error: string }).error).toBe('db unavailable')
  })
})

describe('handleContextBreakdownRoute (F1.5)', () => {
  const wire = {
    buckets: { messages: 100, systemTools: 30, metaContext: 10, systemPrompt: 5 },
    totalInputTokens: 32900,
    maxTokens: 100000,
    fillRatio: 0.329,
    cacheHitRate: 0.3,
    capturedAtTurn: 3,
  }

  it('returns 200 with the breakdown when the session has a snapshot', async () => {
    const contextBreakdownHandler: ContextBreakdownHandler = vi
      .fn()
      .mockReturnValue({ breakdown: wire })
    const req = makeReqWithParams('user-1', 'chatllm', 'c1')
    const captured = makeRes()
    await handleContextBreakdownRoute(req, captured.res, makeHandlers({ contextBreakdownHandler }))
    expect(captured.statusCode).toBe(200)
    expect(captured.jsonBody).toEqual({ breakdown: wire })
    expect(contextBreakdownHandler).toHaveBeenCalledWith('user-1', 'chatllm', 'c1')
  })

  it('returns 200 with breakdown:null when the session exists but has no snapshot yet', async () => {
    const contextBreakdownHandler: ContextBreakdownHandler = vi
      .fn()
      .mockReturnValue({ breakdown: null })
    const req = makeReqWithParams('user-1', 'chatllm', 'c1')
    const captured = makeRes()
    await handleContextBreakdownRoute(req, captured.res, makeHandlers({ contextBreakdownHandler }))
    expect(captured.statusCode).toBe(200)
    expect(captured.jsonBody).toEqual({ breakdown: null })
  })

  it('returns 404 with the canonical body when the session does not exist (enumeration-defense)', async () => {
    const contextBreakdownHandler: ContextBreakdownHandler = vi.fn().mockReturnValue(null)
    const req = makeReqWithParams('user-1', 'chatllm', 'c-missing')
    const captured = makeRes()
    await handleContextBreakdownRoute(req, captured.res, makeHandlers({ contextBreakdownHandler }))
    expect(captured.statusCode).toBe(404)
    expect(captured.jsonBody).toEqual({ error: 'session not found' })
  })

  it('returns 401 when the rpc edge caller context is missing (userSub never from client)', async () => {
    const req = { params: { agent: 'chatllm', chatId: 'c1' } } as unknown as Request
    const captured = makeRes()
    await handleContextBreakdownRoute(
      req,
      captured.res,
      makeHandlers({ contextBreakdownHandler: vi.fn() })
    )
    expect(captured.statusCode).toBe(401)
  })

  it('returns 401 when the caller is not rpc-proxy', async () => {
    const req = {
      runtimeCaller: { caller: 'channel-reader', hostRef: 'chatllm', userId: 'user-1' },
      params: { agent: 'chatllm', chatId: 'c1' },
    } as unknown as Request
    const captured = makeRes()
    await handleContextBreakdownRoute(
      req,
      captured.res,
      makeHandlers({ contextBreakdownHandler: vi.fn() })
    )
    expect(captured.statusCode).toBe(401)
  })

  it('returns 400 if agent or chatId is missing', async () => {
    const req = {
      runtimeCaller: { caller: 'rpc-proxy', hostRef: 'chatllm', userId: 'user-1' },
      params: { agent: '', chatId: '' },
    } as unknown as Request
    const captured = makeRes()
    await handleContextBreakdownRoute(
      req,
      captured.res,
      makeHandlers({ contextBreakdownHandler: vi.fn() })
    )
    expect(captured.statusCode).toBe(400)
    expect(captured.jsonBody).toEqual({ error: 'Invalid agent or chatId' })
  })

  it('rejects unsafe route segments', async () => {
    const contextBreakdownHandler: ContextBreakdownHandler = vi.fn()
    const req = makeReqWithParams('user-1', 'agent:other', 'c1')
    const captured = makeRes()
    await handleContextBreakdownRoute(req, captured.res, makeHandlers({ contextBreakdownHandler }))
    expect(captured.statusCode).toBe(400)
    expect(contextBreakdownHandler).not.toHaveBeenCalled()
  })

  it('returns 501 when contextBreakdownHandler is not configured', async () => {
    const req = makeReqWithParams('user-1', 'chatllm', 'c1')
    const captured = makeRes()
    await handleContextBreakdownRoute(
      req,
      captured.res,
      makeHandlers({ contextBreakdownHandler: null })
    )
    expect(captured.statusCode).toBe(501)
  })

  it('returns 500 when the handler throws', async () => {
    const contextBreakdownHandler: ContextBreakdownHandler = vi
      .fn()
      .mockRejectedValue(new Error('db unavailable'))
    const req = makeReqWithParams('user-1', 'chatllm', 'c1')
    const captured = makeRes()
    await handleContextBreakdownRoute(req, captured.res, makeHandlers({ contextBreakdownHandler }))
    expect(captured.statusCode).toBe(500)
    expect((captured.jsonBody as { error: string }).error).toBe('db unavailable')
  })
})
