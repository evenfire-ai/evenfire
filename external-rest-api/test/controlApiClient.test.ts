import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ControlApiError,
  controlApiBinaryRequestWithStatus,
  controlApiRequest,
  controlApiRequestWithStatus,
  controlApiStreamRequest,
} from '../src/controlApiClient.js'
import { withExternalRequestContext } from '../src/requestContext.js'

const ALLOWED_HEADERS = {
  'retry-after': '17',
  'x-ratelimit-limit': '30',
  'x-ratelimit-remaining': '0',
  'x-ratelimit-reset': '1776000000',
  'x-request-id': '11111111-2222-4333-8444-555555555555',
}

function rateLimitedResponse() {
  return new Response(JSON.stringify({ error: 'Too Many Requests' }), {
    status: 429,
    headers: {
      ...ALLOWED_HEADERS,
      'set-cookie': 'internal-session=must-not-leak',
      server: 'control-api-internal',
      'x-internal-debug': 'must-not-leak',
    },
  })
}

async function captureError(work: () => Promise<unknown>): Promise<ControlApiError> {
  try {
    await work()
  } catch (error) {
    expect(error).toBeInstanceOf(ControlApiError)
    return error as ControlApiError
  }
  throw new Error('expected control-api request to reject')
}

describe('controlApiClient error headers', () => {
  afterEach(() => vi.unstubAllGlobals())

  it.each([
    ['JSON request', () => controlApiRequestWithStatus('GET', '/external/gfs/resources')],
    [
      'binary request',
      () => controlApiBinaryRequestWithStatus('GET', '/external/gfs/proxy/resource-id'),
    ],
    ['stream request', () => controlApiStreamRequest('GET', '/external/gfs/proxy/resource-id')],
  ] as const)('%s preserves only the public error-header allowlist', async (_name, work) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(rateLimitedResponse()))

    const error = await captureError(work)

    expect(error.status).toBe(429)
    expect(error.headers).toEqual(ALLOWED_HEADERS)
    expect(error.headers).not.toHaveProperty('set-cookie')
    expect(error.headers).not.toHaveProperty('server')
    expect(error.headers).not.toHaveProperty('x-internal-debug')
  })

  it.each([
    [413, '209715200', '209715200'],
    [413, '0007', '7'],
    [413, '-1', undefined],
    [413, '9007199254740992', undefined],
    [413, 'not-a-number', undefined],
    [409, '209715200', undefined],
  ] as const)(
    'for status %s forwards only a bounded 413 upload-length value %s',
    async (status, uploadLength, expected) => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ error: 'upstream' }), {
            status,
            headers: {
              'content-type': 'application/json',
              'upload-length': uploadLength,
              'x-internal-secret': 'must-not-leak',
            },
          })
        )
      )

      const error = await captureError(() =>
        controlApiRequestWithStatus('PUT', '/external/gfs/resources/id/content')
      )

      expect(error.responseHeaders['upload-length']).toBe(expected)
      expect(error.responseHeaders).not.toHaveProperty('x-internal-secret')
    }
  )
})

describe('controlApiClient request identity', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('forwards the proxy-attested client IP on non-GFS control-api calls', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await new Promise<void>((resolve, reject) => {
      withExternalRequestContext(
        {
          ip: '203.0.113.41',
          socket: { remoteAddress: '10.0.0.10' },
        } as never,
        {},
        () => {
          void controlApiRequest('GET', '/external/members')
            .then(() => resolve())
            .catch(reject)
        }
      )
    })

    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-external-client-ip': '203.0.113.41' }),
      })
    )
  })
})
