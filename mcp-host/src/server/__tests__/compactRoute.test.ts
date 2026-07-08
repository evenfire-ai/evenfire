/**
 * T1.1 — route-level tests for `POST /v1/runtime/compact`.
 *
 * The handler delegates the actual compaction work to a `CompactionHandler`
 * injected at server-construction time. These tests pin the contract between
 * the route and the discriminated `CompactionResult` shape:
 *
 *   200 ok                 → { ok, before, after, focus }
 *   400 missing sessionKey → {"error":"sessionKey required"}
 *   404 not_found          → {"error":"session not found"}
 *   409 pending_approval   → {"error":"cannot compact while approval pending"}
 *   409 session_busy       → {"error":"session is currently busy ..."}
 *   500 error              → {"error": <handler message>}
 *   501 no handler wired   → {"error":"Compaction handler not configured"}
 */
import { describe, expect, it, vi } from 'vitest'
import type { Request, Response } from 'express'
import { handleCompactionRoute } from '../routes'
import type { CompactionHandler } from '../types'
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

function makeReq(body: Record<string, unknown>, query: Record<string, string> = {}): Request {
  return { body, query } as unknown as Request
}

describe('handleCompactionRoute', () => {
  it('returns 200 with counts when the handler succeeds', async () => {
    const compactionHandler: CompactionHandler = vi.fn().mockResolvedValue({
      kind: 'ok',
      before: 42,
      after: 12,
      focus: 'authentication flow',
    })
    const captured = makeRes()
    await handleCompactionRoute(
      makeReq({ sessionKey: 'sess-1', focus: 'authentication flow' }),
      captured.res,
      makeHandlers({ compactionHandler })
    )
    expect(captured.statusCode).toBe(200)
    expect(captured.jsonBody).toEqual({
      ok: true,
      before: 42,
      after: 12,
      focus: 'authentication flow',
    })
    expect(compactionHandler).toHaveBeenCalledWith({
      sessionKey: 'sess-1',
      focus: 'authentication flow',
      useMainLlm: undefined,
    })
  })

  it('accepts focus from query string and forwards useMainLlm', async () => {
    const compactionHandler: CompactionHandler = vi.fn().mockResolvedValue({
      kind: 'ok',
      before: 10,
      after: 5,
      focus: 'billing',
    })
    const captured = makeRes()
    await handleCompactionRoute(
      makeReq({ sessionKey: 'sess-1', useMainLlm: true }, { focus: 'billing' }),
      captured.res,
      makeHandlers({ compactionHandler })
    )
    expect(captured.statusCode).toBe(200)
    expect(compactionHandler).toHaveBeenCalledWith({
      sessionKey: 'sess-1',
      focus: 'billing',
      useMainLlm: true,
    })
  })

  it('returns 400 when sessionKey is missing', async () => {
    const compactionHandler: CompactionHandler = vi.fn()
    const captured = makeRes()
    await handleCompactionRoute(makeReq({}), captured.res, makeHandlers({ compactionHandler }))
    expect(captured.statusCode).toBe(400)
    expect(compactionHandler).not.toHaveBeenCalled()
  })

  it('returns 404 when the session does not exist', async () => {
    const compactionHandler: CompactionHandler = vi.fn().mockResolvedValue({ kind: 'not_found' })
    const captured = makeRes()
    await handleCompactionRoute(
      makeReq({ sessionKey: 'ghost' }),
      captured.res,
      makeHandlers({ compactionHandler })
    )
    expect(captured.statusCode).toBe(404)
    expect(captured.jsonBody).toEqual({ error: 'session not found' })
  })

  it('returns 409 with explicit message when an approval is pending', async () => {
    const compactionHandler: CompactionHandler = vi
      .fn()
      .mockResolvedValue({ kind: 'pending_approval' })
    const captured = makeRes()
    await handleCompactionRoute(
      makeReq({ sessionKey: 'sess-1' }),
      captured.res,
      makeHandlers({ compactionHandler })
    )
    expect(captured.statusCode).toBe(409)
    expect(captured.jsonBody).toEqual({ error: 'cannot compact while approval pending' })
  })

  it('returns 409 when the session is currently busy', async () => {
    const compactionHandler: CompactionHandler = vi.fn().mockResolvedValue({ kind: 'session_busy' })
    const captured = makeRes()
    await handleCompactionRoute(
      makeReq({ sessionKey: 'sess-1' }),
      captured.res,
      makeHandlers({ compactionHandler })
    )
    expect(captured.statusCode).toBe(409)
    expect((captured.jsonBody as { error: string }).error).toContain('busy')
  })

  it('returns 500 when the handler reports an internal error', async () => {
    const compactionHandler: CompactionHandler = vi.fn().mockResolvedValue({
      kind: 'error',
      message: 'LLM provider not initialized',
    })
    const captured = makeRes()
    await handleCompactionRoute(
      makeReq({ sessionKey: 'sess-1' }),
      captured.res,
      makeHandlers({ compactionHandler })
    )
    expect(captured.statusCode).toBe(500)
    expect((captured.jsonBody as { error: string }).error).toBe('LLM provider not initialized')
  })

  it('returns 501 when no compactionHandler is wired', async () => {
    const captured = makeRes()
    await handleCompactionRoute(makeReq({ sessionKey: 'sess-1' }), captured.res, makeHandlers({}))
    expect(captured.statusCode).toBe(501)
    expect((captured.jsonBody as { error: string }).error).toContain('not configured')
  })
})
