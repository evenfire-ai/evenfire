import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, requestJson } from '../httpClient.js'
import { RpcProxyClient } from '../rpcProxyClient.js'
import {
  ERROR_EXCERPT_MAX_CHARS,
  HOST_ACCESS_DENIED_MESSAGE,
  HOST_ACCESS_REVOKED_MESSAGE,
  boundedErrorExcerpt,
  hostAccessDenialMessage,
} from '../upstreamErrors.js'

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
  const fetchMock = vi.fn(async () => new Response(body, { status, statusText, headers }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e
  )
  expect(error).toBeInstanceOf(ApiError)
  return error as ApiError
}

// The rpc-proxy own-denial body, exactly as the cross-layer contract defines it.
const denialBody = (code?: string) =>
  JSON.stringify({ error: 'Forbidden: user cannot access this host', ...(code ? { code } : {}) })

describe('requestJson Host-access 403 mapping', () => {
  it('maps code host_access_revoked to the single confirmed-revocation message', async () => {
    const fetchMock = stubResponse(403, 'Forbidden', denialBody('host_access_revoked'), {
      'retry-after': '7',
    })

    const error = await rejection(requestJson('GET', 'http://proxy/x'))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(error.message).toBe(HOST_ACCESS_REVOKED_MESSAGE)
    expect(error.message).toBe('403 Forbidden: host_access_revoked')
    expect(error.status).toBe(403)
    expect(error.bodyText).toBe(denialBody('host_access_revoked'))
    expect(error.retryAfter).toBe('7')
  })

  it('maps code host_access_denied to a message that is not a confirmed revocation', async () => {
    stubResponse(403, 'Forbidden', denialBody('host_access_denied'))

    const error = await rejection(requestJson('GET', 'http://proxy/x'))

    expect(error.message).toBe(HOST_ACCESS_DENIED_MESSAGE)
    expect(error.message).toBe('403 Forbidden: host_access_denied')
    expect(error.message).not.toContain('host_access_revoked')
  })

  it.each([
    [
      'a JSON body whose error is the revoked token but has no code',
      '{"error":"host_access_revoked"}',
    ],
    ['the pre-contract denial body without a code', denialBody()],
    ['a text body ending in the revoked token', 'Forbidden: host_access_revoked'],
    ['a JSON message field carrying the revoked token', '{"message":"host_access_revoked"}'],
    ['a code of another kind', '{"code":"missing_scope","error":"host_access_revoked"}'],
  ])('never forges a confirmed revocation from %s', async (_label, body) => {
    const fetchMock = stubResponse(403, 'Forbidden', body)

    const error = await rejection(requestJson('GET', 'http://proxy/x'))

    // Liveness witness: the 403 path ran and produced the ordinary status text.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(error.message.startsWith('403 Forbidden: ')).toBe(true)
    expect(error.status).toBe(403)
    expect(error.message).not.toContain('host_access_revoked')
  })

  it('leaves a non-403 body that mentions the token as an ordinary failure', async () => {
    stubResponse(502, 'Bad Gateway', '{"code":"host_access_revoked"}')

    const error = await rejection(requestJson('GET', 'http://proxy/x'))

    expect(error.message.startsWith('502 Bad Gateway: ')).toBe(true)
    expect(error.message).not.toContain('host_access_revoked')
  })
})

describe('bounded upstream error excerpts', () => {
  const HUGE = 'y'.repeat(100 * 1024)

  it('keeps a 100 KB body out of the requestJson message but on bodyText, status first', async () => {
    const body = JSON.stringify({ detail: HUGE })
    stubResponse(500, 'Internal Server Error', body)

    const error = await rejection(requestJson('GET', 'http://proxy/x'))

    expect(error.message.startsWith('500 Internal Server Error: ')).toBe(true)
    expect(error.message.length).toBeLessThan(600)
    expect(error.bodyText).toBe(body)
    expect(error.status).toBe(500)
    expect(/^(\d{3}) /.exec(error.message)?.[1]).toBe('500')
  })

  it('bounds an oversized error string and message field of a JSON body', async () => {
    stubResponse(400, 'Bad Request', JSON.stringify({ error: HUGE, message: HUGE }))

    const error = await rejection(requestJson('GET', 'http://proxy/x'))

    expect(error.message.startsWith('400 Bad Request: ')).toBe(true)
    expect(error.message.length).toBeLessThan(600)
  })

  it.each([
    ['prewarmHost', (c: RpcProxyClient) => c.prewarmHost('t', 'host'), 'Prewarm failed (500): '],
    [
      'approveToolCall',
      (c: RpcProxyClient) => c.approveToolCall('t', 'host', 'task', 'tool'),
      'Approve failed (500): ',
    ],
    [
      'listArtifacts',
      (c: RpcProxyClient) => c.listArtifacts('t', 'host'),
      'List artifacts failed (500): ',
    ],
    [
      'getHostModels',
      (c: RpcProxyClient) => c.getHostModels('t', 'host', 'chat'),
      'Get host models failed (500): ',
    ],
    [
      'setHostModel',
      (c: RpcProxyClient) => c.setHostModel('t', 'host', 'chat', 'model'),
      'Set host model failed (500): ',
    ],
  ])('bounds the raw-fetch message of %s', async (_name, call, prefix) => {
    const fetchMock = stubResponse(500, 'Internal Server Error', HUGE)

    const error = await rejection(call(new RpcProxyClient()))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(error.message.startsWith(prefix)).toBe(true)
    expect(error.message.length).toBeLessThan(600)
    expect(error.bodyText).toBe(HUGE)
    expect(error.status).toBe(500)
  })
})

describe('upstreamErrors helpers', () => {
  it('collapses whitespace, cuts at the bound with an ellipsis and defuses reserved tokens', () => {
    expect(boundedErrorExcerpt('  a\n\n b\t c  ')).toBe('a b c')
    const cut = boundedErrorExcerpt('z'.repeat(ERROR_EXCERPT_MAX_CHARS + 50))
    expect(cut).toBe(`${'z'.repeat(ERROR_EXCERPT_MAX_CHARS)}…`)
    const defused = boundedErrorExcerpt('a host_access_revoked and HOST_ACCESS_DENIED here')
    expect(defused).toBe('a host-access-revoked and host-access-DENIED here')
  })

  it('decides Host-access messages from the parsed code of a 403 only', () => {
    expect(hostAccessDenialMessage(403, '{"code":"host_access_revoked"}')).toBe(
      HOST_ACCESS_REVOKED_MESSAGE
    )
    expect(hostAccessDenialMessage(403, '{"code":"host_access_denied"}')).toBe(
      HOST_ACCESS_DENIED_MESSAGE
    )
    expect(hostAccessDenialMessage(401, '{"code":"host_access_revoked"}')).toBeNull()
    expect(hostAccessDenialMessage(403, 'host_access_revoked')).toBeNull()
    expect(hostAccessDenialMessage(403, '{"error":"host_access_revoked"}')).toBeNull()
    expect(hostAccessDenialMessage(403, '')).toBeNull()
  })
})
