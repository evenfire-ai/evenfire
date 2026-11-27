import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ControlApiError,
  ControlApiNonJsonResponseError,
  ControlApiTransportError,
  controlApiBinaryRequestWithStatus,
  controlApiRequest,
  controlApiRequestWithStatus,
  controlApiStreamRequest,
  isControlApiServiceCredentialRejection,
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

async function captureTransportError(
  work: () => Promise<unknown>
): Promise<ControlApiTransportError> {
  try {
    await work()
  } catch (error) {
    expect(error).toBeInstanceOf(ControlApiTransportError)
    return error as ControlApiTransportError
  }
  throw new Error('expected control-api transport request to reject')
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
})

describe("controlApiClient: control-api's service-credential refusal header", () => {
  afterEach(() => vi.unstubAllGlobals())

  const REFUSAL_HEADER = 'x-internal-service-auth-refusal'

  /** control-api's bare 401 body with the gate's refusal header, at `status` and `value`. */
  function answersWithRefusalHeader(status: number, value: string) {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status,
          headers: { 'content-type': 'application/json', [REFUSAL_HEADER]: value },
        })
      )
    )
  }

  const request = () =>
    controlApiRequest('POST', '/external/invitations/desktop-authorization', { body: {} })

  it('keeps it on a 401 with its one value, and reads that 401 as a credential refusal', async () => {
    answersWithRefusalHeader(401, 'service_credential_rejected')

    const error = await captureError(request)

    expect(error.status).toBe(401)
    expect(error.headers).toEqual({ [REFUSAL_HEADER]: 'service_credential_rejected' })
    expect(isControlApiServiceCredentialRejection(error)).toBe(true)
  })

  it.each([
    ['a 403', 403, 'service_credential_rejected'],
    ['a 503', 503, 'service_credential_rejected'],
    ['a 401 with another value', 401, 'session_rejected'],
    ['a 401 with the value in another case', 401, 'Service_Credential_Rejected'],
  ])('drops it on %s', async (_label, status, value) => {
    answersWithRefusalHeader(status, value)

    const error = await captureError(request)

    expect(error.status).toBe(status)
    expect(error.headers).not.toHaveProperty(REFUSAL_HEADER)
    expect(isControlApiServiceCredentialRejection(error)).toBe(false)
  })
})

describe('ControlApiError.code', () => {
  it.each([
    [{ error: 'invalid_password' }, 'invalid_password'],
    [null, null],
    [undefined, null],
    [{ error: 400 }, null],
    [{ message: 'invalid_password' }, null],
    [['invalid_password'], null],
  ])('exposes only a string structured error code from %j', (body, code) => {
    expect(new ControlApiError('private', 400, body).code).toBe(code)
  })
})

describe('controlApiClient transport classification', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('classifies rejected GET dispatch as a read without exposing the transport error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('private URL and token')))

    const error = await captureTransportError(() =>
      controlApiRequestWithStatus('GET', '/external/invitations/token/proof')
    )

    expect(error.operation).toBe('read')
    expect(error.phase).toBe('dispatch')
    expect(error.message).not.toContain('private URL')
    expect(error.message).not.toContain('token')
  })

  it('classifies a rejected mutation response read without exposing its body error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: vi.fn().mockRejectedValue(new Error('private proof body')),
      })
    )

    const error = await captureTransportError(() =>
      controlApiRequestWithStatus('POST', '/external/invitations/password-token', {
        body: { token: 'synthetic-proof' },
      })
    )

    expect(error.operation).toBe('mutation')
    expect(error.phase).toBe('response')
    expect(error.message).not.toContain('private proof')
  })
})

describe('controlApiClient non-JSON bodies', () => {
  afterEach(() => vi.unstubAllGlobals())

  // Callers that give a meaning to a status (the GFS watch among them) tell a
  // body control-api never wrote apart by this class, so it must not be the
  // plain error with the upstream status, whatever that status is.
  it.each([
    ['a 4xx HTML page', 413, 'text/html', '<html>Too Large</html>'],
    ['a 5xx HTML page', 503, 'text/html', '<html>Unavailable</html>'],
    ['a 2xx text body', 200, 'text/plain', 'ok'],
  ])('answers %s with the synthetic 502', async (_name, status, contentType, body) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(body, {
          status,
          headers: { 'content-type': contentType, 'x-request-id': 'req-1' },
        })
      )
    )

    const error = await captureError(() =>
      controlApiRequestWithStatus('PUT', '/external/gfs/watch', { body: {} })
    )

    expect(error).toBeInstanceOf(ControlApiNonJsonResponseError)
    expect(error.status).toBe(502)
    expect((error as ControlApiNonJsonResponseError).upstreamStatus).toBe(status)
    expect(error.body).toEqual({ error: 'Upstream returned non-JSON body', status })
    expect(error.headers).toEqual({ 'x-request-id': 'req-1' })
  })
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
