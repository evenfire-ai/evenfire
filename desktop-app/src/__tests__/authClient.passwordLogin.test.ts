import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthClient } from '../authClient'
import { ApiError } from '../httpClient'

function stubLoginResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        statusText: status === 429 ? 'Too Many Requests' : 'Unauthorized',
        headers,
      })
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

async function loginError(): Promise<ApiError> {
  const error = await new AuthClient().passwordLogin('user@example.com', 'secret').catch(e => e)
  expect(error).toBeInstanceOf(ApiError)
  return error as ApiError
}

describe('AuthClient.passwordLogin errors', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('carries the status and the wait of a rate-limited login at the end of the message', async () => {
    const fetchMock = stubLoginResponse(
      429,
      { error: 'rate_limited', retryAfterSeconds: 17 },
      { 'retry-after': '17' }
    )

    const error = await loginError()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(error.status).toBe(429)
    expect(error.message).toMatch(/ httpStatus=429 retryAfterSeconds=17$/)
  })

  it('states the status alone when the response has no usable wait', async () => {
    stubLoginResponse(429, { error: 'rate_limited' })

    const error = await loginError()

    expect(error.message).toMatch(/ httpStatus=429$/)
  })

  it('leaves any other failure unchanged', async () => {
    stubLoginResponse(401, { error: 'invalid_credentials' })

    const error = await loginError()

    expect(error.status).toBe(401)
    expect(error.message).toContain('invalid_credentials')
    expect(error.message).not.toContain('httpStatus=')
  })
})
