/**
 * T3.1 — route-level tests for `GET /v1/runtime/sessions/search`.
 *
 * The handler delegates to an injected `SessionSearchHandler`. These tests
 * pin the bloqueante invariants from `T3.1-session-search.md §11.4`:
 *
 *   401  missing/invalid auth
 *   400  `q` missing
 *   200  results returned with auth.sub as the canonical user
 *   501  handler not wired (memory mode / feature OFF)
 *   500  handler raised
 *
 * Plus test #22: caller-supplied `?user=...` is silently ignored.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Request, Response } from 'express'
import { handleSessionSearchRoute } from '../routes'
import type { SessionSearchHandler } from '../types'
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

function makeReq(query: Record<string, string> = {}, auth?: { sub: string }): Request {
  const req = { query, body: {} } as unknown as Request
  if (auth) {
    ;(req as Request & { auth?: { sub: string } }).auth = auth
  }
  return req
}

describe('handleSessionSearchRoute', () => {
  it('#19 returns 401 when auth.sub is missing', async () => {
    const sessionSearchHandler: SessionSearchHandler = vi.fn()
    const captured = makeRes()
    await handleSessionSearchRoute(
      makeReq({ q: 'foo' }),
      captured.res,
      makeHandlers({ sessionSearchHandler })
    )
    expect(captured.statusCode).toBe(401)
    expect(sessionSearchHandler).not.toHaveBeenCalled()
  })

  it('#21 returns 400 when q is missing', async () => {
    const sessionSearchHandler: SessionSearchHandler = vi.fn()
    const captured = makeRes()
    await handleSessionSearchRoute(
      makeReq({}, { sub: 'alice@example.com' }),
      captured.res,
      makeHandlers({ sessionSearchHandler })
    )
    expect(captured.statusCode).toBe(400)
    expect(sessionSearchHandler).not.toHaveBeenCalled()
  })

  it('#22 uses auth.sub even when ?user= is supplied (bypass attempt)', async () => {
    const sessionSearchHandler: SessionSearchHandler = vi.fn().mockResolvedValue({
      results: [],
      total: 0,
    })
    const captured = makeRes()
    await handleSessionSearchRoute(
      makeReq({ q: 'pineapples', user: 'victim@example.com' }, { sub: 'alice@example.com' }),
      captured.res,
      makeHandlers({ sessionSearchHandler })
    )
    expect(captured.statusCode).toBe(200)
    expect(sessionSearchHandler).toHaveBeenCalledTimes(1)
    expect(
      (sessionSearchHandler as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0]
    ).toMatchObject({ userSub: 'alice@example.com' })
  })

  it('#23 returns the same shape produced by the handler ({ results, total })', async () => {
    const sessionSearchHandler: SessionSearchHandler = vi.fn().mockResolvedValue({
      results: [
        {
          snippet: 'hello <mark>foo</mark>',
          session_id: 's1',
          timestamp: '2026-05-22T00:00:00.000Z',
          channel: 'telegram',
          role: 'user',
        },
      ],
      total: 1,
    })
    const captured = makeRes()
    await handleSessionSearchRoute(
      makeReq({ q: 'foo' }, { sub: 'alice@example.com' }),
      captured.res,
      makeHandlers({ sessionSearchHandler })
    )
    expect(captured.statusCode).toBe(200)
    expect(captured.jsonBody).toMatchObject({
      total: 1,
      results: [{ session_id: 's1', channel: 'telegram', role: 'user' }],
    })
  })

  it('forwards channel + since + scope + limit (clamped) to the handler', async () => {
    const sessionSearchHandler: SessionSearchHandler = vi.fn().mockResolvedValue({
      results: [],
      total: 0,
    })
    const captured = makeRes()
    await handleSessionSearchRoute(
      makeReq(
        {
          q: 'foo',
          scope: 'all_channels',
          channel: 'telegram',
          since: '2026-01-01T00:00:00Z',
          limit: '1000',
        },
        { sub: 'alice@example.com' }
      ),
      captured.res,
      makeHandlers({ sessionSearchHandler })
    )
    expect(captured.statusCode).toBe(200)
    expect(
      (sessionSearchHandler as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0]
    ).toMatchObject({
      userSub: 'alice@example.com',
      query: 'foo',
      scope: 'all_channels',
      channelType: 'telegram',
      since: '2026-01-01T00:00:00Z',
      limit: 50,
    })
  })

  it('treats unknown scope as this_channel (no widening)', async () => {
    const sessionSearchHandler: SessionSearchHandler = vi.fn().mockResolvedValue({
      results: [],
      total: 0,
    })
    const captured = makeRes()
    await handleSessionSearchRoute(
      makeReq({ q: 'foo', scope: 'magic' }, { sub: 'alice@example.com' }),
      captured.res,
      makeHandlers({ sessionSearchHandler })
    )
    expect(captured.statusCode).toBe(200)
    expect(
      (sessionSearchHandler as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0]
    ).toMatchObject({ scope: 'this_channel' })
  })

  it('returns 501 when the handler is not wired (memory mode / flag OFF)', async () => {
    const captured = makeRes()
    await handleSessionSearchRoute(
      makeReq({ q: 'foo' }, { sub: 'alice@example.com' }),
      captured.res,
      makeHandlers({})
    )
    expect(captured.statusCode).toBe(501)
  })

  it('returns 500 when the handler raises', async () => {
    const sessionSearchHandler: SessionSearchHandler = vi
      .fn()
      .mockRejectedValue(new Error('FTS5 syntax error'))
    const captured = makeRes()
    await handleSessionSearchRoute(
      makeReq({ q: 'foo' }, { sub: 'alice@example.com' }),
      captured.res,
      makeHandlers({ sessionSearchHandler })
    )
    expect(captured.statusCode).toBe(500)
    expect((captured.jsonBody as { error: string }).error).toContain('FTS5 syntax error')
  })
})
