/**
 * Tests for server/httpUtils.ts
 * Step 4.3 (G-04)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as http from 'http'
import {
  badRequest,
  forbidden,
  json,
  readBody,
  setCorsHeaders,
  unauthorized,
} from '../../server/httpUtils'

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeMockResponse(): http.ServerResponse {
  const headers: Record<string, string> = {}
  return {
    setHeader: vi.fn((name: string, value: string) => {
      headers[name] = value
    }),
    getHeader: vi.fn((name: string) => headers[name]),
    writeHead: vi.fn(),
    end: vi.fn(),
    _headers: headers,
  } as unknown as http.ServerResponse
}

function makeRequest(chunks: string[]): http.IncomingMessage {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {}
  const req = {
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      listeners[event] = listeners[event] ?? []
      listeners[event].push(cb)
    }),
    emit: (event: string, ...args: unknown[]) => {
      ;(listeners[event] ?? []).forEach(cb => cb(...args))
    },
  } as unknown as http.IncomingMessage
  return req
}

// ─── setCorsHeaders ──────────────────────────────────────────────────────────

describe('setCorsHeaders', () => {
  let origEnv: string | undefined

  beforeEach(() => {
    origEnv = process.env.CLERUM_ALLOWED_ORIGINS
  })

  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env.CLERUM_ALLOWED_ORIGINS
    } else {
      process.env.CLERUM_ALLOWED_ORIGINS = origEnv
    }
  })

  it('sets Access-Control-Allow-Origin when origin is in allowed list', () => {
    process.env.CLERUM_ALLOWED_ORIGINS = 'https://app.example.com'
    const res = makeMockResponse()
    setCorsHeaders(res, 'https://app.example.com')
    expect(res.setHeader).toHaveBeenCalledWith(
      'Access-Control-Allow-Origin',
      'https://app.example.com'
    )
  })

  it('sets Vary: Origin when origin is allowed', () => {
    process.env.CLERUM_ALLOWED_ORIGINS = 'https://app.example.com'
    const res = makeMockResponse()
    setCorsHeaders(res, 'https://app.example.com')
    expect(res.setHeader).toHaveBeenCalledWith('Vary', 'Origin')
  })

  it('does NOT set Access-Control-Allow-Origin when origin is not in allowed list', () => {
    process.env.CLERUM_ALLOWED_ORIGINS = 'https://app.example.com'
    const res = makeMockResponse()
    setCorsHeaders(res, 'https://evil.com')
    const calls = (res.setHeader as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0])
    expect(calls).not.toContain('Access-Control-Allow-Origin')
  })

  it('does NOT set origin header when CLERUM_ALLOWED_ORIGINS is empty (blocks all)', () => {
    process.env.CLERUM_ALLOWED_ORIGINS = ''
    const res = makeMockResponse()
    setCorsHeaders(res, 'https://any.com')
    const calls = (res.setHeader as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0])
    expect(calls).not.toContain('Access-Control-Allow-Origin')
  })

  it('does NOT set origin header when no origin is passed', () => {
    process.env.CLERUM_ALLOWED_ORIGINS = 'https://app.example.com'
    const res = makeMockResponse()
    setCorsHeaders(res) // no origin
    const calls = (res.setHeader as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0])
    expect(calls).not.toContain('Access-Control-Allow-Origin')
  })

  it('always sets Access-Control-Allow-Methods regardless of origin', () => {
    process.env.CLERUM_ALLOWED_ORIGINS = ''
    const res = makeMockResponse()
    setCorsHeaders(res)
    expect(res.setHeader).toHaveBeenCalledWith(
      'Access-Control-Allow-Methods',
      'GET, POST, PUT, DELETE, OPTIONS'
    )
  })
})

// ─── readBody ────────────────────────────────────────────────────────────────

describe('readBody', () => {
  it('reads a complete body from request stream', async () => {
    const req = makeRequest([])
    const promise = readBody(req)

    ;(req as unknown as { emit: (e: string, ...a: unknown[]) => void }).emit('data', 'hello ')
    ;(req as unknown as { emit: (e: string, ...a: unknown[]) => void }).emit('data', 'world')
    ;(req as unknown as { emit: (e: string, ...a: unknown[]) => void }).emit('end')

    const body = await promise
    expect(body).toBe('hello world')
  })

  it('resolves with empty string for empty body', async () => {
    const req = makeRequest([])
    const promise = readBody(req)
    ;(req as unknown as { emit: (e: string, ...a: unknown[]) => void }).emit('end')
    const body = await promise
    expect(body).toBe('')
  })

  it('rejects on stream error', async () => {
    const req = makeRequest([])
    const promise = readBody(req)
    ;(req as unknown as { emit: (e: string, ...a: unknown[]) => void }).emit(
      'error',
      new Error('stream broken')
    )
    await expect(promise).rejects.toThrow('stream broken')
  })
})

// ─── json / unauthorized / forbidden / badRequest helpers ────────────────────

describe('json helper', () => {
  it('writes correct status code and JSON content-type', () => {
    const res = makeMockResponse()
    json(res, 200, { ok: true })
    expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' })
    expect(res.end).toHaveBeenCalledWith(JSON.stringify({ ok: true }))
  })
})

describe('unauthorized helper', () => {
  it('sends 401 with default error message', () => {
    const res = makeMockResponse()
    unauthorized(res)
    expect(res.writeHead).toHaveBeenCalledWith(401, { 'Content-Type': 'application/json' })
  })
})

describe('forbidden helper', () => {
  it('sends 403 with default error message', () => {
    const res = makeMockResponse()
    forbidden(res)
    expect(res.writeHead).toHaveBeenCalledWith(403, { 'Content-Type': 'application/json' })
  })
})

describe('badRequest helper', () => {
  it('sends 400 with provided error message', () => {
    const res = makeMockResponse()
    badRequest(res, 'missing field')
    expect(res.writeHead).toHaveBeenCalledWith(400, { 'Content-Type': 'application/json' })
    expect(res.end).toHaveBeenCalledWith(JSON.stringify({ error: 'missing field' }))
  })
})
