import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ControlApiError } from '../../external-rest-api/src/controlApiClient.js'
import { sanitizeControlApiPublicError } from '../../external-rest-api/src/http/publicApiError.js'
import { ApiError, requestJson } from '../src/httpClient.js'

vi.mock('../src/config.js', () => ({
  config: {
    requestTimeoutMs: 5000,
  },
}))

function okResponse(body?: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: () => Promise.resolve(body !== undefined ? JSON.stringify(body) : ''),
  } as unknown as Response
}

function errorResponse(status: number, body: string, headers?: Record<string, string>): Response {
  return {
    ok: false,
    status,
    statusText: 'Error',
    text: () => Promise.resolve(body),
    headers: new Headers(headers),
  } as unknown as Response
}

function transientFetchError(message = 'fetch failed', code = 'ECONNRESET'): Error {
  const error = new TypeError(message)
  Object.assign(error, { cause: { code } })
  return error
}

describe('requestJson — error message formatting', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('unpacks an enveloped {code,message} error instead of "[object Object]"', async () => {
    const fetchSpy = vi.mocked(global.fetch)
    fetchSpy.mockResolvedValueOnce(
      errorResponse(
        403,
        JSON.stringify({
          ok: false,
          error: { code: 'forbidden', message: 'not authorized to read this resource' },
        })
      )
    )

    const error = await requestJson('GET', 'http://localhost/gfs/file').catch(e => e)

    expect(error).toBeInstanceOf(ApiError)
    expect(error.message).toBe('403 Error: forbidden: not authorized to read this resource')
    expect(error.bodyText).toContain('not authorized to read this resource')
  })

  it('keeps a plain-string error and a top-level message field as before', async () => {
    const fetchSpy = vi.mocked(global.fetch)
    fetchSpy.mockResolvedValueOnce(
      errorResponse(409, JSON.stringify({ error: 'version_conflict', message: 'stale write' }))
    )

    const error = await requestJson('GET', 'http://localhost/x').catch(e => e)

    expect(error.message).toBe('409 Error: version_conflict - stale write')
  })
})

describe('requestJson — transient retry', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('retries one transient network failure when explicitly enabled', async () => {
    const fetchSpy = vi.mocked(global.fetch)
    fetchSpy.mockRejectedValueOnce(transientFetchError('socket hang up'))
    fetchSpy.mockResolvedValueOnce(okResponse({ ok: true }))

    const result = await requestJson<{ ok: boolean }>('GET', 'http://localhost/test', {
      retryTransientOnce: true,
    })

    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(result).toEqual({ ok: true })
  })

  it('retries one transient ECONNREFUSED when explicitly enabled', async () => {
    const fetchSpy = vi.mocked(global.fetch)
    fetchSpy.mockRejectedValueOnce(transientFetchError('connect refused', 'ECONNREFUSED'))
    fetchSpy.mockResolvedValueOnce(okResponse({ ok: true }))

    const result = await requestJson<{ ok: boolean }>('GET', 'http://localhost/test', {
      retryTransientOnce: true,
    })

    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(result).toEqual({ ok: true })
  })

  it('does not retry transient failures when retryTransientOnce is disabled', async () => {
    const fetchSpy = vi.mocked(global.fetch)
    fetchSpy.mockRejectedValueOnce(transientFetchError())

    await expect(
      requestJson('GET', 'http://localhost/test', {
        retryTransientOnce: false,
      })
    ).rejects.toThrow(/fetch failed/i)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('does not retry HTTP errors because they are not transport failures', async () => {
    const fetchSpy = vi.mocked(global.fetch)
    fetchSpy.mockResolvedValueOnce(errorResponse(503, '{"error":"busy"}'))

    await expect(
      requestJson('GET', 'http://localhost/test', {
        retryTransientOnce: true,
      })
    ).rejects.toBeInstanceOf(ApiError)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('formats the real External REST typed envelope without object stringification', async () => {
    const produced = sanitizeControlApiPublicError(
      new ControlApiError('raw', 403, { error: 'escalation_rejected' }),
      new Set([403])
    )
    expect(produced).not.toBeNull()
    vi.mocked(global.fetch).mockResolvedValueOnce(
      errorResponse(403, JSON.stringify(produced!.body))
    )

    await expect(requestJson('PUT', 'http://localhost/test')).rejects.toThrow(
      /403 Error: forbidden: The requested operation is not allowed\./
    )
    await expect(Promise.resolve(JSON.stringify(produced!.body))).resolves.not.toContain(
      '[object Object]'
    )
  })

  it('preserves Retry-After on HTTP errors for bounded upload lifecycle retries', async () => {
    const fetchSpy = vi.mocked(global.fetch)
    fetchSpy.mockResolvedValueOnce(
      errorResponse(429, '{"error":"quota_exceeded"}', { 'retry-after': '7' })
    )

    await expect(requestJson('POST', 'http://localhost/upload')).rejects.toMatchObject({
      status: 429,
      retryAfter: '7',
    })
  })
})
