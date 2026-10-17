import { afterEach, describe, expect, it, vi } from 'vitest'
import { config } from '../config.js'
import {
  ControlApiError,
  controlApiPassthroughGet,
  controlApiRequest,
} from '../controlApiClient.js'

describe('controlApiPassthroughGet', () => {
  afterEach(() => vi.restoreAllMocks())

  it('GETs control-api with the path + raw query appended verbatim and relays status/content-type/body', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<html>ok</html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    )

    const result = await controlApiPassthroughGet(
      '/oauth-callback/google-gmail',
      '?state=S&code=C&scope=a%20b'
    )

    expect(result).toEqual({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: '<html>ok</html>',
    })
    const base = config.controlApiBaseUrl.replace(/\/+$/, '')
    const calledUrl = String(fetchMock.mock.calls[0][0])
    // path + raw query appended byte-for-byte (no re-encoding of %20).
    expect(calledUrl).toBe(`${base}/oauth-callback/google-gmail?state=S&code=C&scope=a%20b`)
  })

  it('does NOT throw on a non-2xx control-api response — it relays it', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"error":"invalid_state"}', {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })
    )

    const result = await controlApiPassthroughGet('/oauth-callback/google-gmail', '?state=bad')

    expect(result.status).toBe(400)
    expect(result.body).toBe('{"error":"invalid_state"}')
  })

  it('sends the external-rest-api service-token headers', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('ok', { status: 200 }))

    await controlApiPassthroughGet('/oauth-callback/x', '')

    const init = fetchMock.mock.calls[0][1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers['x-service-token']).toBe(config.controlApiServiceName)
    expect(headers['authorization']).toContain('Bearer ')
  })

  it('captures only safe rate-limit headers from a rejected Control API request', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: 'rate_limited', details: { retryAfterSeconds: 17 } },
        }),
        {
          status: 429,
          headers: {
            'content-type': 'application/json',
            'retry-after': '17',
            'x-ratelimit-limit': '30',
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': '1900000000',
            'x-internal-bucket': 'secret-internal-bucket',
          },
        }
      )
    )

    const error = await controlApiRequest('GET', '/external/test').catch(
      (caught: unknown) => caught
    )

    expect(error).toBeInstanceOf(ControlApiError)
    expect((error as ControlApiError).responseHeaders).toEqual({
      'retry-after': '17',
      'x-ratelimit-limit': '30',
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': '1900000000',
    })
  })
})
