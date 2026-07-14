import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

function errorResponse(status: number, body: string): Response {
  return {
    ok: false,
    status,
    statusText: 'Error',
    text: () => Promise.resolve(body),
  } as unknown as Response
}

function transientFetchError(message = 'fetch failed', code = 'ECONNRESET'): Error {
  const error = new TypeError(message)
  Object.assign(error, { cause: { code } })
  return error
}

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
})
