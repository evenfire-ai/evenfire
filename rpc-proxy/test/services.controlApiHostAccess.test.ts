import { describe, expect, it, vi } from 'vitest'
import { fetchHostConnectionFromControlApi } from '../src/services/controlApiRestService.js'

const BINDING = {
  runId: '00000000-0000-4000-8000-000000000123',
  sessionId: 'session-a',
  origin: 'direct_chat' as const,
}

const HOST_ACCESS_URL = /\/rpc\/access\/users\/user-1\/mcp-hosts\/host-a$/

// Liveness witness of every case: the client made exactly one call, with the
// method the binding selects, to the host-access URL.
function expectOneCall(fetchImpl: ReturnType<typeof vi.fn>, method: 'GET' | 'POST'): void {
  expect(fetchImpl).toHaveBeenCalledOnce()
  const [url, init] = fetchImpl.mock.calls[0]!
  expect(String(url)).toMatch(HOST_ACCESS_URL)
  expect(init).toMatchObject({ method })
}

describe('control-api canonical host access client', () => {
  it('resolves an ordinary send with one GET to the parent host-access URL', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            userId: 'user-1',
            hostRef: 'host-a',
            url: 'http://host-a.mcp-host.svc.cluster.local:8080',
            edgeAssertion: 'edge-assertion-fixture',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
    )

    await expect(
      fetchHostConnectionFromControlApi('user-1', 'host-a', 'signed-rpc-token', {
        fetchImpl: fetchImpl as typeof fetch,
      })
    ).resolves.toEqual({
      name: 'host-a',
      url: 'http://host-a.mcp-host.svc.cluster.local:8080',
      headers: {},
      edgeAssertion: 'edge-assertion-fixture',
    })

    expect(fetchImpl).toHaveBeenCalledOnce()
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(String(url)).toMatch(/\/rpc\/access\/users\/user-1\/mcp-hosts\/host-a$/)
    expect(init).toMatchObject({ method: 'GET' })
  })

  it('resolves and binds with one POST to the existing host-access URL', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            userId: 'user-1',
            hostRef: 'host-a',
            url: 'http://host-a.mcp-host.svc.cluster.local:8080',
            bindingStatus: 'recorded',
            edgeAssertion: 'edge-assertion-fixture',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
    )

    await expect(
      fetchHostConnectionFromControlApi('user-1', 'host-a', 'signed-rpc-token', {
        directRunBinding: BINDING,
        fetchImpl: fetchImpl as typeof fetch,
      })
    ).resolves.toEqual({
      name: 'host-a',
      url: 'http://host-a.mcp-host.svc.cluster.local:8080',
      headers: {},
      attributionBindingStatus: 'recorded',
      edgeAssertion: 'edge-assertion-fixture',
    })

    expect(fetchImpl).toHaveBeenCalledOnce()
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(String(url)).toMatch(/\/rpc\/access\/users\/user-1\/mcp-hosts\/host-a$/)
    expect(init).toMatchObject({ method: 'POST' })
    expect(JSON.parse(String(init?.body))).toEqual(BINDING)
  })

  it.each([
    [401, { rejected: true, status: 401 }],
    [403, { denied: true, code: 'host_access_denied' }],
    [409, { rejected: true, status: 409 }],
  ] as const)('returns a Control API %s on a direct-run lookup as %o', async (status, refusal) => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'redacted' }), {
          status,
          headers: { 'content-type': 'application/json' },
        })
    )

    await expect(
      fetchHostConnectionFromControlApi('user-1', 'host-a', 'signed-rpc-token', {
        directRunBinding: BINDING,
        fetchImpl: fetchImpl as typeof fetch,
      })
    ).resolves.toEqual(refusal)
    expectOneCall(fetchImpl, 'POST')
  })

  const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json', ...headers },
        })
    )

  // control-api reports the denial reason in this header; its 403 body is always
  // exactly {"error":"Forbidden"}. Pinned literally so the test fails if the two
  // services ever disagree on the name.
  const REASON_HEADER = 'x-host-access-denial-reason'
  const FORBIDDEN_BODY = { error: 'Forbidden' }

  // R1-M6: the denial reason (read from the response header, never the body)
  // decides whether Desktop may treat the loss as a revocation. Only the two
  // reasons that prove removed access map to `host_access_revoked`;
  // `subject_mismatch` is a request-shape error (R3-L8).
  it.each([
    ['team_membership_missing', 'host_access_revoked'],
    ['directory_grant_missing', 'host_access_revoked'],
    ['subject_mismatch', 'host_access_denied'],
    ['host_disabled', 'host_access_denied'],
    ['host_missing', 'host_access_denied'],
    ['host_claim_missing', 'host_access_denied'],
    ['unheard_of_reason', 'host_access_denied'],
  ])('a non-direct-run 403 with reason %s resolves to the denial %s', async (reason, code) => {
    const fetchImpl = jsonResponse(403, FORBIDDEN_BODY, { [REASON_HEADER]: reason })

    await expect(
      fetchHostConnectionFromControlApi('user-1', 'host-a', 'signed-rpc-token', {
        fetchImpl: fetchImpl as typeof fetch,
      })
    ).resolves.toEqual({ denied: true, code })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('a non-direct-run 403 without the reason header resolves to host_access_denied', async () => {
    const fetchImpl = jsonResponse(403, FORBIDDEN_BODY)

    await expect(
      fetchHostConnectionFromControlApi('user-1', 'host-a', 'signed-rpc-token', {
        fetchImpl: fetchImpl as typeof fetch,
      })
    ).resolves.toEqual({ denied: true, code: 'host_access_denied' })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('a non-direct-run 403 with an unknown header value resolves to host_access_denied', async () => {
    const fetchImpl = jsonResponse(403, FORBIDDEN_BODY, { [REASON_HEADER]: 'a_reason_added_later' })

    await expect(
      fetchHostConnectionFromControlApi('user-1', 'host-a', 'signed-rpc-token', {
        fetchImpl: fetchImpl as typeof fetch,
      })
    ).resolves.toEqual({ denied: true, code: 'host_access_denied' })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('a non-direct-run 403 with a non-JSON body still honours the header', async () => {
    // A revoking reason: a denied-anyway reason would pass even if the header
    // were ignored.
    const fetchImpl = vi.fn(
      async () =>
        new Response('not json', {
          status: 403,
          headers: { [REASON_HEADER]: 'team_membership_missing' },
        })
    )

    await expect(
      fetchHostConnectionFromControlApi('user-1', 'host-a', 'signed-rpc-token', {
        fetchImpl: fetchImpl as typeof fetch,
      })
    ).resolves.toEqual({ denied: true, code: 'host_access_revoked' })
  })

  it('a reason present only in the body (legacy shape) is ignored', async () => {
    // Proves the body is never read: the same reason maps to host_access_revoked
    // when it arrives as the header (see the table above) but not from the body.
    const fetchImpl = jsonResponse(403, { error: 'Forbidden', reason: 'team_membership_missing' })

    await expect(
      fetchHostConnectionFromControlApi('user-1', 'host-a', 'signed-rpc-token', {
        fetchImpl: fetchImpl as typeof fetch,
      })
    ).resolves.toEqual({ denied: true, code: 'host_access_denied' })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('a non-direct-run 404 resolves to host_access_denied on the parent path', async () => {
    const fetchImpl = jsonResponse(404, { error: 'not found' })

    await expect(
      fetchHostConnectionFromControlApi('user-1', 'host-a', 'signed-rpc-token', {
        fetchImpl: fetchImpl as typeof fetch,
      })
    ).resolves.toEqual({ denied: true, code: 'host_access_denied' })
    expect(fetchImpl).toHaveBeenCalledOnce()
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(String(url)).toMatch(/\/rpc\/access\/users\/user-1\/mcp-hosts\/host-a$/)
    expect(init).toMatchObject({ method: 'GET' })
  })

  it('a direct-run-bound 404 is an unavailable authority and posts the binding to the parent path', async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ error: 'not found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        })
    )

    await expect(
      fetchHostConnectionFromControlApi('user-1', 'host-a', 'signed-rpc-token', {
        directRunBinding: BINDING,
        fetchImpl: fetchImpl as typeof fetch,
      })
    ).resolves.toEqual({ unavailable: true, cause: 'http_status', status: 404 })
    expectOneCall(fetchImpl, 'POST')
    expect(fetchImpl.mock.calls[0]![1]).toMatchObject({ body: JSON.stringify(BINDING) })
  })

  // A status that is not an answer about access: the authority is unavailable,
  // on both methods, and the status is kept for the log line.
  it.each([
    [400, 'GET'],
    [429, 'GET'],
    [500, 'GET'],
    [503, 'GET'],
    [400, 'POST'],
    [429, 'POST'],
    [500, 'POST'],
    [503, 'POST'],
  ] as const)('a %s on %s is an unavailable authority with its status', async (status, method) => {
    const fetchImpl = jsonResponse(status, { error: 'upstream detail' })

    await expect(
      fetchHostConnectionFromControlApi('user-1', 'host-a', 'signed-rpc-token', {
        ...(method === 'POST' ? { directRunBinding: BINDING } : {}),
        fetchImpl: fetchImpl as typeof fetch,
      })
    ).resolves.toEqual({ unavailable: true, cause: 'http_status', status })
    expectOneCall(fetchImpl, method)
  })

  it.each([401, 409] as const)('a %s on GET is a rejection', async status => {
    const fetchImpl = jsonResponse(status, { error: 'x' })

    await expect(
      fetchHostConnectionFromControlApi('user-1', 'host-a', 'signed-rpc-token', {
        fetchImpl: fetchImpl as typeof fetch,
      })
    ).resolves.toEqual({ rejected: true, status })
    expectOneCall(fetchImpl, 'GET')
  })

  it.each([
    ['userId mismatch', { userId: 'someone-else', hostRef: 'host-a', url: 'http://h:8080' }],
    ['hostRef mismatch', { userId: 'user-1', hostRef: 'host-b', url: 'http://h:8080' }],
    ['empty url', { userId: 'user-1', hostRef: 'host-a', url: ' ' }],
    ['missing url', { userId: 'user-1', hostRef: 'host-a' }],
    ['a JSON array body', []],
  ])('a 200 with %s resolves to host_access_denied', async (_label, body) => {
    const fetchImpl = jsonResponse(200, body)

    await expect(
      fetchHostConnectionFromControlApi('user-1', 'host-a', 'signed-rpc-token', {
        fetchImpl: fetchImpl as typeof fetch,
      })
    ).resolves.toEqual({ denied: true, code: 'host_access_denied' })
    expectOneCall(fetchImpl, 'GET')
  })

  it.each([
    ['team_membership_missing', 'host_access_revoked'],
    ['host_disabled', 'host_access_denied'],
    [undefined, 'host_access_denied'],
  ])('a direct-run 403 (reason %s) resolves to the denial %s', async (reason, code) => {
    const fetchImpl = jsonResponse(403, FORBIDDEN_BODY, reason ? { [REASON_HEADER]: reason } : {})

    await expect(
      fetchHostConnectionFromControlApi('user-1', 'host-a', 'signed-rpc-token', {
        directRunBinding: BINDING,
        fetchImpl: fetchImpl as typeof fetch,
      })
    ).resolves.toEqual({ denied: true, code })
    expectOneCall(fetchImpl, 'POST')
  })

  it.each([401, 409] as const)('a %s carries no denial code', async status => {
    const fetchImpl = jsonResponse(
      status,
      { error: 'x', reason: 'team_membership_missing' },
      { [REASON_HEADER]: 'team_membership_missing' }
    )

    await expect(
      fetchHostConnectionFromControlApi('user-1', 'host-a', 'signed-rpc-token', {
        directRunBinding: BINDING,
        fetchImpl: fetchImpl as typeof fetch,
      })
    ).resolves.toEqual({ rejected: true, status })
    expectOneCall(fetchImpl, 'POST')
  })

  // A control-api older than rpc-proxy authorizes the Host without issuing an
  // edge assertion. That answer cannot authorize a Host request: the routes
  // answer it as 503 `authority_unavailable`.
  it.each([
    ['missing', {}],
    ['empty', { edgeAssertion: '' }],
    ['a number', { edgeAssertion: 42 }],
    ['null', { edgeAssertion: null }],
  ])('a 200 with the edge assertion %s is an unavailable authority', async (_label, extra) => {
    const fetchImpl = jsonResponse(200, {
      userId: 'user-1',
      hostRef: 'host-a',
      url: 'http://host-a.mcp-host.svc.cluster.local:8080',
      ...extra,
    })

    await expect(
      fetchHostConnectionFromControlApi('user-1', 'host-a', 'signed-rpc-token', {
        fetchImpl: fetchImpl as typeof fetch,
      })
    ).resolves.toEqual({ unavailable: true, cause: 'edge_assertion_missing' })
    expectOneCall(fetchImpl, 'GET')
  })

  // The binding status is read only on POST: on GET an invalid value is ignored
  // and the connection is returned.
  it.each([
    ['POST', { unavailable: true, cause: 'invalid_binding_status' }],
    [
      'GET',
      {
        name: 'host-a',
        url: 'http://host-a.mcp-host.svc.cluster.local:8080',
        headers: {},
        edgeAssertion: 'edge-assertion-fixture',
      },
    ],
  ] as const)('a 200 with an invalid bindingStatus on %s returns %o', async (method, outcome) => {
    const fetchImpl = jsonResponse(200, {
      userId: 'user-1',
      hostRef: 'host-a',
      url: 'http://host-a.mcp-host.svc.cluster.local:8080',
      bindingStatus: 'not-a-status',
      edgeAssertion: 'edge-assertion-fixture',
    })

    await expect(
      fetchHostConnectionFromControlApi('user-1', 'host-a', 'signed-rpc-token', {
        ...(method === 'POST' ? { directRunBinding: BINDING } : {}),
        fetchImpl: fetchImpl as typeof fetch,
      })
    ).resolves.toEqual(outcome)
    expectOneCall(fetchImpl, method)
  })

  // The client holds no catch: what fetch or response.json() throws reaches the
  // one caller (resolveV1HostConnection), which classifies it.
  it('a fetch rejection propagates', async () => {
    const failure = new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } })
    const fetchImpl = vi.fn(async () => {
      throw failure
    })

    await expect(
      fetchHostConnectionFromControlApi('user-1', 'host-a', 'signed-rpc-token', {
        fetchImpl: fetchImpl as typeof fetch,
      })
    ).rejects.toBe(failure)
    expectOneCall(fetchImpl, 'GET')
  })

  it.each([
    ['a non-JSON 200', () => new Response('<html></html>', { status: 200 })],
    ['a 204 without a body', () => new Response(null, { status: 204 })],
  ])('%s propagates', async (_label, response) => {
    const fetchImpl = vi.fn(async () => response())

    await expect(
      fetchHostConnectionFromControlApi('user-1', 'host-a', 'signed-rpc-token', {
        fetchImpl: fetchImpl as typeof fetch,
      })
    ).rejects.toBeInstanceOf(SyntaxError)
    expectOneCall(fetchImpl, 'GET')
  })

  it('a JSON null 200 propagates', async () => {
    const fetchImpl = jsonResponse(200, null)

    await expect(
      fetchHostConnectionFromControlApi('user-1', 'host-a', 'signed-rpc-token', {
        fetchImpl: fetchImpl as typeof fetch,
      })
    ).rejects.toBeInstanceOf(TypeError)
    expectOneCall(fetchImpl, 'GET')
  })
})
