import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthClient } from '../authClient'
import { ApiError } from '../httpClient'

function stubLoginResponse(status: number, body: string, headers: Record<string, string> = {}) {
  const fetchMock = vi.fn(
    async () => new Response(body, { status, statusText: 'Server Answer', headers })
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

async function loginFailure(): Promise<Error> {
  const error = await new AuthClient().passwordLogin('user@example.com', 'secret').catch(e => e)
  expect(error).toBeInstanceOf(Error)
  return error as Error
}

async function loginApiError(): Promise<ApiError> {
  const error = await loginFailure()
  expect(error).toBeInstanceOf(ApiError)
  return error as ApiError
}

describe('AuthClient.passwordLogin errors', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('carries the status and the wait of a rate-limited login at the end of the message', async () => {
    const body = JSON.stringify({ error: 'rate_limited', retryAfterSeconds: 17 })
    const fetchMock = stubLoginResponse(429, body, { 'retry-after': '17' })

    const error = await loginApiError()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(error.status).toBe(429)
    expect(error.message).toMatch(/ httpStatus=429 retryAfterSeconds=17$/)
    expect(error.retryAfter).toBe('17')
    expect(error.bodyText).toBe(body)
  })

  it('states the status alone when the response has no wait', async () => {
    stubLoginResponse(429, JSON.stringify({ error: 'rate_limited' }))

    const error = await loginApiError()

    expect(error.message).toMatch(/ httpStatus=429$/)
  })

  it.each([
    ['an HTTP date', 'Wed, 21 Oct 2026 07:28:00 GMT'],
    ['zero', '0'],
    ['a negative number', '-5'],
    ['a fraction', '1.5'],
    ['text', 'abc'],
    ['an exponent', '1e3'],
    ['an unsafe integer', '9007199254740993'],
  ])('gives no wait for a Retry-After of %s', async (_label, retryAfter) => {
    stubLoginResponse(429, JSON.stringify({ error: 'rate_limited' }), {
      'retry-after': retryAfter,
    })

    const error = await loginApiError()

    expect(error.message).toMatch(/ httpStatus=429$/)
    expect(error.message).not.toContain('retryAfterSeconds=')
    // The header stays available on the error for logs.
    expect(error.retryAfter).toBe(retryAfter)
  })

  it('marks any other server answer with its own status and keeps the error fields', async () => {
    const body = JSON.stringify({ error: 'invalid_credentials' })
    stubLoginResponse(401, body, { 'retry-after': '17' })

    const error = await loginApiError()

    expect(error.status).toBe(401)
    expect(error.bodyText).toBe(body)
    expect(error.retryAfter).toBe('17')
    expect(error.message).toContain('invalid_credentials')
    expect(error.message).toMatch(/ httpStatus=401$/)
  })

  it.each([
    [401, JSON.stringify({ error: 'httpStatus=429' })],
    [500, 'upstream said httpStatus=429'],
    [502, 'gateway failed httpStatus=429 retryAfterSeconds=900'],
    [503, 'unavailable signInTransport=noResponse'],
    [401, 'denied httpStatus=429 signInTransport=noResponse'],
  ])('never lets a %i body imitate the transport marker', async (status, body) => {
    stubLoginResponse(status, body, { 'retry-after': '17' })

    const error = await loginApiError()

    expect(error.status).toBe(status)
    expect(error.message.endsWith(` httpStatus=${status}`)).toBe(true)
    expect(error.message).not.toContain('retryAfterSeconds=')
    expect(error.message).not.toContain('signInTransport=')
    expect(error.bodyText).toBe(body)
  })

  it('reads a real 429 with the same body as that 429, with its own wait', async () => {
    stubLoginResponse(429, 'gateway failed httpStatus=500 retryAfterSeconds=900', {
      'retry-after': '17',
    })

    const error = await loginApiError()

    expect(error.message).toMatch(/ httpStatus=429 retryAfterSeconds=17$/)
    expect(error.message).not.toContain('retryAfterSeconds=900')
    expect(error.message).not.toContain('httpStatus=500')
  })

  it('marks a failure with no HTTP answer as such and keeps the cause', async () => {
    const cause = new TypeError('fetch failed httpStatus=429')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw cause
      })
    )

    const error = await loginFailure()

    expect(error).not.toBeInstanceOf(ApiError)
    expect(error.message).toMatch(/ signInTransport=noResponse$/)
    expect(error.message).toContain('fetch failed')
    expect(error.message).not.toContain('httpStatus=')
    expect(error.cause).toBe(cause)
  })

  it('marks a 200 answer that is not JSON the same way, even when the body has the token', async () => {
    stubLoginResponse(200, 'signInTransport=noResponse httpStatus=401')

    const error = await loginFailure()

    expect(error).not.toBeInstanceOf(ApiError)
    expect(error.message).toMatch(/ signInTransport=noResponse$/)
    expect(error.message).not.toMatch(/httpStatus=401$/)
  })

  it('returns the login result on success', async () => {
    const result = { sessionToken: 'token', me: { id: 'user' } }
    stubLoginResponse(200, JSON.stringify(result))

    await expect(new AuthClient().passwordLogin('user@example.com', 'secret')).resolves.toEqual(
      result
    )
  })
})
