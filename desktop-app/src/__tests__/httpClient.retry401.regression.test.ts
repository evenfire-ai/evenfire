import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, requestJson, setSessionInvalidationHandler } from '../httpClient.js'

vi.mock('../config.js', () => ({
  config: { requestTimeoutMs: 1000 },
}))

afterEach(() => {
  setSessionInvalidationHandler(undefined)
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('requestJson transient retry authorization failures', () => {
  it('invalidates the matching session once when the retry attempt returns 401', async () => {
    vi.useFakeTimers()
    const invalidate = vi.fn()
    setSessionInvalidationHandler(invalidate)
    const networkFailure = Object.assign(new Error('socket reset'), { code: 'ECONNRESET' })
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(networkFailure)
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)

    const request = requestJson('GET', 'http://rest.example.test/me', {
      token: 'session-token-for-retry',
      retryTransientOnce: true,
    }).catch(error => error)
    await vi.advanceTimersByTimeAsync(250)

    await expect(request).resolves.toBeInstanceOf(ApiError)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(invalidate).toHaveBeenCalledExactlyOnceWith('session-token-for-retry', undefined)
  })
})
