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
    // Only a newer control-api (version skew).
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

  // Only a newer control-api (version skew).
  it('a non-direct-run 403 with an unknown header value resolves to host_access_denied', async () => {
    const fetchImpl = jsonResponse(403, FORBIDDEN_BODY, { [REASON_HEADER]: 'a_reason_added_later' })

    await expect(
      fetchHostConnectionFromControlApi('user-1', 'host-a', 'signed-rpc-token', {
        fetchImpl: fetchImpl as typeof fetch,
      })
    ).resolves.toEqual({ denied: true, code: 'host_access_denied' })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  // Hardening: control-api's `users.ts:74` always writes a JSON body.
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

  // Hardening: no control-api version sent the reason in the body; the 403 body
  // was always {"error":"Forbidden"}.
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

  // Not route-written: the `app.ts:304` fallthrough under version skew, or a
  // Kubernetes 404 that control-api's error handler forwards.
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

  // Not route-written: the `app.ts:304` fallthrough under version skew, or a
  // Kubernetes 404 that control-api's error handler forwards.
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
  // GET 400: hardening, the route never writes it. POST 400: route-written
  // (`users.ts:272`). 429 and 500: through control-api's error handler (a
  // forwarded Kubernetes 429; `next(error)` at `users.ts:252,329`). 503: an
  // intermediary only.
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

  // 401 without the gate's mark: caller token or a forwarded upstream 401. GET
  // 409: hardening, the route never writes it.
  it.each([401, 409] as const)('a %s on GET is a rejection', async status => {
    const fetchImpl = jsonResponse(status, { error: 'x' })

    await expect(
      fetchHostConnectionFromControlApi('user-1', 'host-a', 'signed-rpc-token', {
        fetchImpl: fetchImpl as typeof fetch,
      })
    ).resolves.toEqual({ rejected: true, status })
    expectOneCall(fetchImpl, 'GET')
  })

  // Hardening, every row: the authorizer returns the request's own userId and
  // hostRef and always builds the url (`rpcHostAccessAuthorizer.ts:43-44,77-84`),
  // and the route never writes a JSON array.
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

  // Hardening: control-api sets the reason header only in `denyHostAccess`
  // (`users.ts:73`).
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
  // 'missing': only a control-api older than the edge assertion. 'empty',
  // 'a number' and 'null': hardening, the route always writes a signed assertion.
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
  // Hardening: the route writes only `recorded` and `unavailable`
  // (`users.ts:306,325`).
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
  // Transport.
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

  // Hardening: the route never writes either answer.
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

  // Hardening: the route never writes it.
  it('a JSON null 200 propagates', async () => {
    const fetchImpl = jsonResponse(200, null)

    await expect(
      fetchHostConnectionFromControlApi('user-1', 'host-a', 'signed-rpc-token', {
        fetchImpl: fetchImpl as typeof fetch,
      })
    ).rejects.toBeInstanceOf(TypeError)
    expectOneCall(fetchImpl, 'GET')
  })

  // J1 (R1-L7): control-api's service gate marks its 401 with this header and
  // value (`internalServiceAuth.ts`); the producer answers themselves are pinned
  // in `internal-service-gate-refusal.producerInterop.test.ts`. Every row below
  // but the 401 with the header absent is hardening: a shape control-api does
  // not write. Pinned literally.
  const GATE_REFUSAL_HEADER = 'x-internal-service-auth-refusal'
  const GATE_REFUSAL_VALUE = 'service_credential_rejected'

  const answerWith = (
    status: number,
    headers: Array<[string, string]>,
    body: BodyInit | null = JSON.stringify({ error: 'Unauthorized' })
  ) =>
    vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(body, { status, headers: [['content-type', 'application/json'], ...headers] })
    )

  const callWith = (fetchImpl: ReturnType<typeof answerWith>, method: 'GET' | 'POST') =>
    fetchHostConnectionFromControlApi('user-1', 'host-a', 'signed-rpc-token', {
      ...(method === 'POST' ? { directRunBinding: BINDING } : {}),
      fetchImpl: fetchImpl as typeof fetch,
    })

  // 'absent' is control-api's own unmarked 401: the caller's RPC token
  // (`rpcAccessAuth.ts`, `users.ts:98`), or an upstream 401 control-api forwards
  // through its error handler.
  const UNMARKED_401_HEADERS: Array<{ label: string; headers: Array<[string, string]> }> = [
    { label: 'absent', headers: [] },
    { label: 'empty', headers: [[GATE_REFUSAL_HEADER, '']] },
    { label: 'another value', headers: [[GATE_REFUSAL_HEADER, 'caller_token_rejected']] },
    {
      label: 'sent twice',
      headers: [
        [GATE_REFUSAL_HEADER, GATE_REFUSAL_VALUE],
        [GATE_REFUSAL_HEADER, GATE_REFUSAL_VALUE],
      ],
    },
    {
      label: 'in another case',
      headers: [[GATE_REFUSAL_HEADER, GATE_REFUSAL_VALUE.toUpperCase()]],
    },
  ]

  it.each(
    UNMARKED_401_HEADERS.flatMap(row =>
      (['GET', 'POST'] as const).map(method => ({ ...row, method }))
    )
  )(
    'a 401 with the refusal header $label on $method is a rejection',
    async ({ headers, method }) => {
      const fetchImpl = answerWith(401, headers)

      await expect(callWith(fetchImpl, method)).resolves.toEqual({ rejected: true, status: 401 })
      expectOneCall(fetchImpl, method)
    }
  )

  it.each(['GET', 'POST'] as const)(
    'the exact refusal header on a 409 on %s keeps the rejection',
    async method => {
      const fetchImpl = answerWith(409, [[GATE_REFUSAL_HEADER, GATE_REFUSAL_VALUE]])

      await expect(callWith(fetchImpl, method)).resolves.toEqual({ rejected: true, status: 409 })
      expectOneCall(fetchImpl, method)
    }
  )

  it.each(['GET', 'POST'] as const)(
    'the exact refusal header on a 403 on %s keeps the denial',
    async method => {
      const fetchImpl = answerWith(
        403,
        [[GATE_REFUSAL_HEADER, GATE_REFUSAL_VALUE]],
        JSON.stringify(FORBIDDEN_BODY)
      )

      await expect(callWith(fetchImpl, method)).resolves.toEqual({
        denied: true,
        code: 'host_access_denied',
      })
      expectOneCall(fetchImpl, method)
    }
  )

  it('the exact refusal header on a GET 404 keeps the denial', async () => {
    const fetchImpl = answerWith(404, [[GATE_REFUSAL_HEADER, GATE_REFUSAL_VALUE]])

    await expect(callWith(fetchImpl, 'GET')).resolves.toEqual({
      denied: true,
      code: 'host_access_denied',
    })
    expectOneCall(fetchImpl, 'GET')
  })

  it.each([
    [404, 'POST'],
    [500, 'GET'],
    [500, 'POST'],
  ] as const)(
    'the exact refusal header on a %s on %s keeps the unavailable status',
    async (status, method) => {
      const fetchImpl = answerWith(status, [[GATE_REFUSAL_HEADER, GATE_REFUSAL_VALUE]])

      await expect(callWith(fetchImpl, method)).resolves.toEqual({
        unavailable: true,
        cause: 'http_status',
        status,
      })
      expectOneCall(fetchImpl, method)
    }
  )

  it.each([
    [
      'GET',
      {
        name: 'host-a',
        url: 'http://host-a.mcp-host.svc.cluster.local:8080',
        headers: {},
        edgeAssertion: 'edge-assertion-fixture',
      },
    ],
    [
      'POST',
      {
        name: 'host-a',
        url: 'http://host-a.mcp-host.svc.cluster.local:8080',
        headers: {},
        attributionBindingStatus: 'recorded',
        edgeAssertion: 'edge-assertion-fixture',
      },
    ],
  ] as const)(
    'the exact refusal header on a valid 200 on %s keeps the connection',
    async (method, connection) => {
      const fetchImpl = answerWith(
        200,
        [[GATE_REFUSAL_HEADER, GATE_REFUSAL_VALUE]],
        JSON.stringify({
          userId: 'user-1',
          hostRef: 'host-a',
          url: 'http://host-a.mcp-host.svc.cluster.local:8080',
          ...(method === 'POST' ? { bindingStatus: 'recorded' } : {}),
          edgeAssertion: 'edge-assertion-fixture',
        })
      )

      await expect(callWith(fetchImpl, method)).resolves.toEqual(connection)
      expectOneCall(fetchImpl, method)
    }
  )

  // The body is drained best effort; a failing body stream does not change the
  // verdict the header gives.
  it.each([
    [
      'marked',
      [[GATE_REFUSAL_HEADER, GATE_REFUSAL_VALUE]],
      { unavailable: true, cause: 'service_credential_rejected' },
    ],
    ['unmarked', [], { rejected: true, status: 401 }],
  ] as const)(
    'a 401 (%s) whose body stream fails keeps the verdict of its header',
    async (_label, headers, refusal) => {
      const failingBody = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(new Error('body stream failed'))
        },
      })
      const fetchImpl = answerWith(401, [...headers], failingBody)

      await expect(callWith(fetchImpl, 'GET')).resolves.toEqual(refusal)
      expectOneCall(fetchImpl, 'GET')
    }
  )
})
