import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthClient } from '../authClient.js'
import { ApiError, requestJson } from '../httpClient.js'
import { RpcProxyClient, SandboxUiSessionError } from '../rpcProxyClient.js'
import { SharedFilesClient } from '../sharedFilesClient.js'
import {
  ERROR_EXCERPT_MAX_CHARS,
  HOST_ACCESS_DENIED_MESSAGE,
  HOST_ACCESS_REVOKED_MESSAGE,
  boundedErrorExcerpt,
  hostAccessDenialMessage,
  rpcTokenMintRevocationMessage,
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

describe('bounded upstream error excerpts at every remaining call site', () => {
  const HUGE = 'y'.repeat(100 * 1024)
  const BOUNDED = `${'y'.repeat(ERROR_EXCERPT_MAX_CHARS)}…`
  const signal = () => new AbortController().signal

  // Each entry drives one `boundedErrorExcerpt` call site through the public
  // method that owns it and names the exact message it must produce.
  const SITES: Array<[string, () => Promise<unknown>, string]> = [
    [
      'RpcProxyClient.mintSandboxUiSession',
      () => new RpcProxyClient().mintSandboxUiSession('t', 'ns', 'app'),
      `sandbox-ui session mint failed (500): ${BOUNDED}`,
    ],
    [
      'RpcProxyClient.requestSandboxUiOauthAuthorizeUrl',
      () => new RpcProxyClient().requestSandboxUiOauthAuthorizeUrl('t', 'ns', 'app', 'client'),
      `sandbox-ui authorize-url request failed (500): ${BOUNDED}`,
    ],
    [
      'RpcProxyClient.requestMcpOauthAuthorizeUrl',
      () => new RpcProxyClient().requestMcpOauthAuthorizeUrl('t', 'server'),
      `mcp-oauth authorize-url request failed (500): ${BOUNDED}`,
    ],
    [
      'RpcProxyClient.openHostStatusStream',
      () => new RpcProxyClient().openHostStatusStream('t', 'host', () => undefined, signal()),
      `Host stream failed (500): ${BOUNDED}`,
    ],
    [
      'RpcProxyClient.denyToolCall',
      () => new RpcProxyClient().denyToolCall('t', 'host', 'task', 'tool', 'reason'),
      `Deny failed (500): ${BOUNDED}`,
    ],
    [
      'RpcProxyClient.cancelTask',
      () => new RpcProxyClient().cancelTask('t', 'host', 'task'),
      `cancelTask failed (500): ${BOUNDED}`,
    ],
    [
      'RpcProxyClient.downloadArtifact',
      () => new RpcProxyClient().downloadArtifact('t', 'host', 'file.txt'),
      `Download artifact failed (500): ${BOUNDED}`,
    ],
    [
      'RpcProxyClient.getContextBreakdown',
      () => new RpcProxyClient().getContextBreakdown('t', 'host', 'agent', 'chat'),
      `Get context breakdown failed (500): ${BOUNDED}`,
    ],
    [
      'RpcProxyClient.postDesktopSession',
      () => new RpcProxyClient().postDesktopSession('t', 'host'),
      `Desktop session exchange failed: 500 ${BOUNDED}`,
    ],
    [
      'AuthClient.openWorkflowNotificationStream',
      () => new AuthClient().openWorkflowNotificationStream('t', () => undefined, signal()),
      `Notification stream failed (500): ${BOUNDED}`,
    ],
    [
      'AuthClient.downloadWorkflowRunArtifact',
      () => new AuthClient().downloadWorkflowRunArtifact('t', 'ns', 'flow', 'run', 'out.txt'),
      `Download workflow artifact failed (500): ${BOUNDED}`,
    ],
    [
      'SharedFilesClient.downloadFile',
      () => new SharedFilesClient().downloadFile('t', 'ctx', 'sfs', 'a.txt'),
      `500 Internal Server Error: ${BOUNDED}`,
    ],
  ]

  it.each(SITES)('bounds the upstream body in the message of %s', async (_name, call, message) => {
    const fetchMock = stubResponse(500, 'Internal Server Error', HUGE)

    const error = await call().then(
      () => null,
      (e: unknown) => e as Error & { status?: number; bodyText?: string; body?: string }
    )

    // Liveness witness: the request went out and the failure path really ran.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(error).toBeInstanceOf(Error)
    // The message carries the 512-character excerpt and nothing beyond it, while the
    // full upstream body stays on the typed error for diagnostics.
    expect(error?.message).toBe(message)
    expect(error?.message.length).toBeLessThan(700)
    const fullBody = error?.bodyText ?? error?.body
    if (fullBody !== undefined) expect(fullBody).toBe(HUGE)
  })

  it('keeps the typed status of the sandbox-ui session error while bounding its message', async () => {
    stubResponse(500, 'Internal Server Error', HUGE)

    const error = await new RpcProxyClient().mintSandboxUiSession('t', 'ns', 'app').then(
      () => null,
      (e: unknown) => e
    )

    expect(error).toBeInstanceOf(SandboxUiSessionError)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as SandboxUiSessionError).status).toBe(500)
    expect((error as SandboxUiSessionError).body).toBe(HUGE)
    expect((error as SandboxUiSessionError).bodyText).toBe(HUGE)
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

  it('cuts exactly above the bound: 511 and 512 characters are kept, 513 gets the ellipsis', () => {
    expect(ERROR_EXCERPT_MAX_CHARS).toBe(512)
    const kept511 = 'q'.repeat(ERROR_EXCERPT_MAX_CHARS - 1)
    const kept512 = 'q'.repeat(ERROR_EXCERPT_MAX_CHARS)
    const cut513 = 'q'.repeat(ERROR_EXCERPT_MAX_CHARS + 1)

    expect(boundedErrorExcerpt(kept511)).toBe(kept511)
    expect(boundedErrorExcerpt(kept512)).toBe(kept512)
    expect(boundedErrorExcerpt(cut513)).toBe(`${kept512}…`)
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

describe('RPC token mint revocation coverage', () => {
  const requested = ['host-a', 'host-b']
  const validBody = JSON.stringify({
    error: 'host_access_denied',
    code: 'host_access_revoked',
    revokedHostRefs: requested,
  })
  const bodyWith = (fields: Record<string, unknown>) =>
    JSON.stringify({
      error: 'host_access_denied',
      code: 'host_access_revoked',
      revokedHostRefs: requested,
      ...fields,
    })

  it('D1-full: confirms coverage of every requested Host', () => {
    expect(rpcTokenMintRevocationMessage(403, validBody, requested)).toBe(
      HOST_ACCESS_REVOKED_MESSAGE
    )
  })

  const negatives: Array<{
    name: string
    status: number
    body: string
    requested: unknown
  }> = [
    {
      name: 'partial coverage',
      status: 403,
      body: bodyWith({ revokedHostRefs: ['host-a'] }),
      requested,
    },
    {
      name: 'absent code',
      status: 403,
      body: JSON.stringify({ error: 'host_access_denied', revokedHostRefs: requested }),
      requested,
    },
    { name: 'wrong code', status: 403, body: bodyWith({ code: 'host_access_denied' }), requested },
    {
      name: 'reserved words only in error',
      status: 403,
      body: JSON.stringify({ error: 'host_access_revoked', revokedHostRefs: requested }),
      requested,
    },
    {
      name: 'reserved words only in message',
      status: 403,
      body: JSON.stringify({ message: 'host_access_revoked', revokedHostRefs: requested }),
      requested,
    },
    {
      name: 'reserved words in text',
      status: 403,
      body: 'Forbidden: host_access_revoked',
      requested,
    },
    { name: 'malformed JSON', status: 403, body: '{"code":"host_access_revoked"', requested },
    { name: 'null JSON', status: 403, body: 'null', requested },
    { name: 'array JSON', status: 403, body: '[' + validBody + ']', requested },
    { name: 'string JSON', status: 403, body: JSON.stringify('host_access_revoked'), requested },
    { name: 'number JSON', status: 403, body: '42', requested },
    {
      name: 'missing revoked list',
      status: 403,
      body: JSON.stringify({ error: 'host_access_denied', code: 'host_access_revoked' }),
      requested,
    },
    {
      name: 'non-array revoked list',
      status: 403,
      body: bodyWith({ revokedHostRefs: 'host-a' }),
      requested,
    },
    {
      name: 'non-string revoked element',
      status: 403,
      body: bodyWith({ revokedHostRefs: ['host-a', 'host-b', 42] }),
      requested,
    },
    { name: 'empty revoked list', status: 403, body: bodyWith({ revokedHostRefs: [] }), requested },
    { name: '401 status', status: 401, body: validBody, requested },
    { name: '500 status', status: 500, body: validBody, requested },
    { name: 'empty requested set', status: 403, body: validBody, requested: [] },
    { name: 'missing requested set', status: 403, body: validBody, requested: undefined },
    { name: 'non-array requested set', status: 403, body: validBody, requested: 'host-a' },
    {
      name: 'blank requested ref',
      status: 403,
      body: bodyWith({ revokedHostRefs: ['host-a', ' '] }),
      requested: ['host-a', ' '],
    },
    {
      name: 'wildcard requested ref',
      status: 403,
      body: bodyWith({ revokedHostRefs: ['host-a', '*'] }),
      requested: ['host-a', '*'],
    },
    { name: 'non-string requested ref', status: 403, body: validBody, requested: ['host-a', 42] },
  ]

  it.each(negatives)(
    'D1-negative: rejects $name with a same-test valid mint witness',
    ({ status, body, requested: refs }) => {
      expect(rpcTokenMintRevocationMessage(403, validBody, requested)).toBe(
        HOST_ACCESS_REVOKED_MESSAGE
      )
      expect(rpcTokenMintRevocationMessage(status, body, refs)).toBeNull()
    }
  )

  it('D1-canonical: trims and deduplicates requested refs before checking complete coverage', () => {
    expect(rpcTokenMintRevocationMessage(403, validBody, requested)).toBe(
      HOST_ACCESS_REVOKED_MESSAGE
    )
    expect(
      rpcTokenMintRevocationMessage(403, validBody, [' host-b ', 'host-a', 'host-b', ' host-a '])
    ).toBe(HOST_ACCESS_REVOKED_MESSAGE)
  })

  it('D2-legacy: recognizes the correct mint body using the published classifier', () => {
    expect(hostAccessDenialMessage(403, validBody)).toBe(HOST_ACCESS_REVOKED_MESSAGE)
  })

  it('D2-mint: recognizes the correct mint body with requested-Host validation', () => {
    expect(rpcTokenMintRevocationMessage(403, validBody, requested)).toBe(
      HOST_ACCESS_REVOKED_MESSAGE
    )
  })
})
