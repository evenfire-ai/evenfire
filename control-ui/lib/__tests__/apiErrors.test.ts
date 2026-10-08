import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  apiGet,
  apiSend,
  formatApiError,
  handleControlUIUnauthorized,
  retryAfterSeconds,
  setControlUIReadPrincipal,
  setGlobalAuthErrorHandler,
} from '../api'
import { __resetReadRequestCacheForTests } from '../readRequestCache'

describe('handleControlUIUnauthorized', () => {
  it('clears the legacy browser token and invokes the registered session-expiry handler', () => {
    const handler = vi.fn()
    window.localStorage.setItem('controlUiAdminToken', 'synthetic-test-token')
    setGlobalAuthErrorHandler(handler)

    handleControlUIUnauthorized()

    expect(window.localStorage.getItem('controlUiAdminToken')).toBeNull()
    expect(handler).toHaveBeenCalledOnce()
  })
})

describe('formatApiError', () => {
  it('preserves a nested structured error without rendering object Object', () => {
    const text = JSON.stringify({
      error: {
        code: 'already_exists',
        message: 'a resource with this name already exists',
      },
    })
    const error = formatApiError(
      new Response(text, { status: 409, statusText: 'Conflict' }),
      text
    ) as Error & { status?: number; code?: string; body?: Record<string, unknown> }

    expect(error.message).toBe('409 Conflict - a resource with this name already exists')
    expect(error.message).not.toContain('[object Object]')
    expect(error.status).toBe(409)
    expect(error.code).toBe('already_exists')
    expect(error.body).toEqual({
      error: {
        code: 'already_exists',
        message: 'a resource with this name already exists',
      },
    })
  })

  it('keeps a server 429 message and numeric retry timing when statusText is empty', () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const text = JSON.stringify({
      error: 'Too Many Requests',
      code: 'rate_limited',
      message: 'This request limit has been reached. Try again in 12 seconds.',
      retryAfterSeconds: 12,
    })
    const error = formatApiError(
      new Response(text, {
        status: 429,
        statusText: '',
        headers: { 'content-type': 'application/json', 'retry-after': '12' },
      }),
      text
    ) as Error & {
      retryAfterSeconds?: number
      retryAtMs?: number
      code?: string
      body?: Record<string, unknown>
    }

    expect(error.message).toBe('This request limit has been reached. Try again in 12 seconds.')
    expect(error.status).toBe(429)
    expect(error.code).toBe('rate_limited')
    expect(error.body).toEqual({
      error: 'Too Many Requests',
      code: 'rate_limited',
      message: 'This request limit has been reached. Try again in 12 seconds.',
      retryAfterSeconds: 12,
    })
    expect(error.retryAfterSeconds).toBe(12)
    expect(error.retryAtMs).toBe(Date.parse('2026-01-01T00:00:12.000Z'))
  })

  it.each([
    ['numeric header', { header: '17', body: '{}' }, 17],
    ['HTTP-date header', { header: 'Wed, 01 Jan 2026 00:00:30 GMT', body: '{}' }, 30],
    ['body fallback', { header: 'invalid', body: '{"retryAfterSeconds":9}' }, 9],
  ] as const)('parses a useful 429 retry interval from %s', (_name, payload, expectedSeconds) => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const headers = new Headers()
    headers.set('retry-after', payload.header)
    expect(retryAfterSeconds(headers, JSON.parse(payload.body) as Record<string, unknown>)).toBe(
      expectedSeconds
    )
  })

  it('uses bounded 429 copy when timing is missing or invalid', () => {
    for (const header of ['', 'zero', '0', '-1', 'Wed, 01 Jan 2025 00:00:00 GMT']) {
      const error = formatApiError(
        new Response(JSON.stringify({ error: 'Too Many Requests' }), {
          status: 429,
          statusText: '',
          headers: { 'retry-after': header },
        }),
        JSON.stringify({ error: 'Too Many Requests' })
      ) as Error & { retryAfterSeconds?: number; retryAtMs?: number }
      expect(error.message).toBe('Too many requests. Try again later.')
      expect(error.retryAfterSeconds).toBeUndefined()
      expect(error.retryAtMs).toBeUndefined()
    }
  })

  it('attaches producer 429 metadata from apiGet without changing conflict formatting', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: 'Slow down', retryAfterSeconds: 4 }), {
        status: 429,
        statusText: '',
        headers: { 'retry-after': '4' },
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    const error = (await apiGet('/api/v1/admin/example').catch(reason => reason)) as Error & {
      status?: number
      retryAfterSeconds?: number
    }

    expect(error.message).toBe('Slow down')
    expect(error.status).toBe(429)
    expect(error.retryAfterSeconds).toBe(4)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('attaches 429 metadata from apiSend and never automatically replays the write', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: 'Write limit reached', retryAfterSeconds: 3 }), {
        status: 429,
        statusText: '',
        headers: { 'retry-after': '3' },
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(apiSend('POST', '/api/v1/admin/example', { value: 1 })).rejects.toMatchObject({
      message: 'Write limit reached',
      status: 429,
      retryAfterSeconds: 3,
    })
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
  __resetReadRequestCacheForTests()
  setControlUIReadPrincipal('admin-test', 'admin')
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  __resetReadRequestCacheForTests()
})
