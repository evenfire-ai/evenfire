import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { AuthClient } from '../authClient.js'
import { ApiError } from '../httpClient.js'
import { RpcProxyClient } from '../rpcProxyClient.js'
import { HOST_ACCESS_REVOKED_MESSAGE } from '../upstreamErrors.js'

vi.mock('../config.js', () => ({
  config: {
    rpcProxyBaseUrl: 'http://proxy',
    externalRestApiBaseUrl: 'http://rest',
    enableDevLoginUi: false,
    requestTimeoutMs: 60000,
    appName: 'test',
  },
}))

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubResponse(status: number, statusText: string, body: string, headers = {}) {
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(body, { status, statusText, headers }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  )
  expect(error).toBeInstanceOf(ApiError)
  return error as ApiError
}

describe('AuthClient RPC mint revocation', () => {
  it('D3: confirms a complete mint revocation with the original status and raw body', async () => {
    const session = randomUUID()
    const requested = ['host-a', 'host-b']
    const body = JSON.stringify({
      error: 'host_access_denied',
      code: 'host_access_revoked',
      revokedHostRefs: requested,
    })
    const fetchMock = stubResponse(403, 'Forbidden', body, { 'retry-after': '7' })

    const error = await rejection(
      new AuthClient().issueRpcToken(session, ['host:message:invoke'], requested)
    )

    expect(error.message).toBe(HOST_ACCESS_REVOKED_MESSAGE)
    expect(error.status).toBe(403)
    expect(error.bodyText).toBe(body)
    expect(error.retryAfter).toBe('7')
    expect(fetchMock.mock.calls.length).toBe(1)
    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe('http://rest/api/v1/rpc/token')
    expect(options?.method).toBe('POST')
    expect(new Headers(options?.headers).get('authorization') === 'Bearer ' + session).toBe(true)
    expect(typeof options?.body).toBe('string')
    expect(JSON.parse(options?.body as string)).toEqual({
      scopes: ['host:message:invoke'],
      hostRefs: requested,
    })
  })

  it('D4: keeps a partial multi-Host list uncertain without invoking the default classifier', async () => {
    const session = randomUUID()
    const requested = ['host-a', 'host-b']
    const body = JSON.stringify({
      error: 'host_access_denied',
      code: 'host_access_revoked',
      revokedHostRefs: ['host-a'],
    })
    const fetchMock = stubResponse(403, 'Forbidden', body)

    const error = await rejection(
      new AuthClient().issueRpcToken(session, ['host:message:invoke'], requested)
    )

    expect(error.message).toBe('403 Forbidden: host-access-denied')
    expect(error.status).toBe(403)
    expect(error.bodyText).toBe(body)
    expect(fetchMock.mock.calls.length).toBe(1)
    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe('http://rest/api/v1/rpc/token')
    expect(options?.method).toBe('POST')
    expect(typeof options?.body).toBe('string')
    expect(JSON.parse(options?.body as string)).toEqual({
      scopes: ['host:message:invoke'],
      hostRefs: requested,
    })
  })

  it('D5: preserves the default classifier for RPC-proxy code-only denials', async () => {
    const rpcAccess = randomUUID()
    const body = JSON.stringify({
      error: 'Forbidden: user cannot access this host',
      code: 'host_access_revoked',
    })
    const fetchMock = stubResponse(403, 'Forbidden', body)

    const error = await rejection(new RpcProxyClient().listServers(rpcAccess))

    expect(error.message).toBe(HOST_ACCESS_REVOKED_MESSAGE)
    expect(error.status).toBe(403)
    expect(error.bodyText).toBe(body)
    expect(fetchMock.mock.calls.length).toBe(1)
    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe('http://proxy/api/v1/rpc/servers')
    expect(options?.method).toBe('GET')
    expect(new Headers(options?.headers).get('authorization') === 'Bearer ' + rpcAccess).toBe(true)
  })

  it('D6-http: preserves the exact generic 500 failure despite a revocation-shaped body', async () => {
    const session = randomUUID()
    const body = JSON.stringify({
      error: 'upstream unavailable',
      code: 'host_access_revoked',
      revokedHostRefs: ['host-a'],
    })
    const fetchMock = stubResponse(500, 'Internal Server Error', body)

    const error = await rejection(
      new AuthClient().issueRpcToken(session, ['host:message:invoke'], ['host-a'])
    )

    expect(error.message).toBe('500 Internal Server Error: upstream unavailable')
    expect(error.status).toBe(500)
    expect(error.bodyText).toBe(body)
    expect(fetchMock.mock.calls.length).toBe(1)
    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe('http://rest/api/v1/rpc/token')
    expect(options?.method).toBe('POST')
  })

  it('D6-network: rethrows the original network error by object identity', async () => {
    const session = randomUUID()
    const failure = new Error('Network operation interrupted')
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(failure)
    vi.stubGlobal('fetch', fetchMock)

    const error = await new AuthClient()
      .issueRpcToken(session, ['host:message:invoke'], ['host-a'])
      .then(
        () => null,
        (caught: unknown) => caught
      )

    expect(error).toBe(failure)
    expect(fetchMock.mock.calls.length).toBe(1)
    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe('http://rest/api/v1/rpc/token')
    expect(options?.method).toBe('POST')
  })
})
