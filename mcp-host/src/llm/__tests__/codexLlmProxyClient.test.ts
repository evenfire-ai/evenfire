import { describe, expect, it, vi } from 'vitest'
import {
  buildCodexProxyEnvelope,
  hashCodexCompletionRequest,
  parseCodexCompletionRequest,
} from '@clerum/llm-provider-attempt-contract'
import { LlmErrorCode } from '../../core/errors'
import {
  CodexLlmProxyClient,
  CodexProxyError,
  resolveCodexProxyRuntimeUrl,
} from '../codexLlmProxyClient'
import { CodexSubscriptionProvider } from '../codexSubscription'
import { classifyFailoverClass } from '../failover/classify'
import { CodexAuthorizeError } from '../providerAttemptAuthorizer'
import { closedPortUrl, fetchFailure, silentServer } from './connectFailureFixtures'

function sse(frames: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const payload = frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('')
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(payload))
      controller.close()
    },
  })
}

describe('CodexLlmProxyClient', () => {
  it('sends the exact measured V2 envelope and refuses an independent deadline or hash', async () => {
    const parsed = parseCodexCompletionRequest({
      schemaVersion: 'codex-completion-request.v2',
      requestId: 'req-visual',
      idempotencyKey: 'idem-visual',
      provider: 'codex-subscription',
      model: 'gpt-5.1',
      deadlineMs: 1000,
      messages: [
        {
          role: 'user',
          content: 'image redacted',
          contentParts: [{ type: 'text', text: 'image redacted' }],
        },
      ],
    })
    if (!parsed.ok) throw new Error(parsed.message)
    const input = {
      request: parsed.value,
      requestHash: hashCodexCompletionRequest(parsed.value),
      executionTicket: 'fixture-ticket',
    }
    const measured = buildCodexProxyEnvelope(input)
    if (!measured.ok) throw new Error(measured.message)
    const fetchFn = vi.fn<typeof fetch>(
      async () => new Response(sse([{ type: 'done', outcome: 'success' }]))
    )
    const client = new CodexLlmProxyClient({
      runtimeUrl: 'http://proxy/completions',
      readPlatformJwt: () => 'fixture-only',
      fetchFn,
    })
    await client.stream({ ...input, deadlineMs: 1000 })
    expect(JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body))).toEqual(measured.value)
    expect(measured.value).not.toHaveProperty('deadlineMs')
    await expect(client.stream({ ...input, deadlineMs: 2000 })).rejects.toMatchObject({
      code: 'invalid_request',
      dispatched: false,
    })
    await expect(client.stream({ ...input, requestHash: 'a'.repeat(64) })).rejects.toMatchObject({
      code: 'request_hash_mismatch',
      dispatched: false,
    })
    expect(fetchFn).toHaveBeenCalledOnce()
  })

  it.each(['html', 'json'])(
    'keeps a %s 413 terminal rather than treating it as unavailable',
    async format => {
      const fetchFn = vi.fn(
        async () =>
          new Response(
            format === 'html'
              ? '<h1>Too large</h1>'
              : JSON.stringify({ error: 'payload_too_large' }),
            { status: 413 }
          )
      )
      const client = new CodexLlmProxyClient({
        runtimeUrl: 'http://proxy/internal/runtime/v1/codex/completions',
        readPlatformJwt: () => 'test-jwt',
        fetchFn,
      })
      await expect(
        client.stream({ executionTicket: 'test-ticket', requestHash: 'a'.repeat(64), request: {} })
      ).rejects.toMatchObject({ code: 'payload_too_large', dispatched: true })
      expect(fetchFn).toHaveBeenCalledOnce()
    }
  )

  it('streams to the frozen runtime Service URL and never accepts a caller URL', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      body: sse([
        { type: 'text', text: 'hello' },
        { type: 'tool_call', id: 'c1', name: 'echo', arguments: { x: 1 } },
        { type: 'done', outcome: 'success' },
      ]),
    })
    const client = new CodexLlmProxyClient({
      runtimeUrl: resolveCodexProxyRuntimeUrl(
        'http://codex-llm-proxy.control-plane.svc.cluster.local:8080'
      ),
      readPlatformJwt: () => 'platform-jwt',
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    const result = await client.stream({
      executionTicket: 'ticket-123456',
      requestHash: 'a'.repeat(64),
      request: { model: 'gpt-5.3-codex' },
      // Not part of the input type: a caller must not be able to redirect the hop.
      url: 'https://attacker.example/backend-api/codex/responses',
      runtimeUrl: 'https://attacker.example/internal/runtime/v1/codex/completions',
    } as never)
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(fetchFn.mock.calls[0][0]).toBe(
      'http://codex-llm-proxy.control-plane.svc.cluster.local:8080/internal/runtime/v1/codex/completions'
    )
    const sent = JSON.parse(fetchFn.mock.calls[0][1].body)
    expect(Object.keys(sent).sort()).toEqual(['executionTicket', 'request', 'requestHash'])
    expect(JSON.stringify(sent)).not.toContain('attacker.example')
    expect(result.text).toBe('hello')
    expect(result.toolCalls).toEqual([
      { type: 'tool_call', id: 'c1', name: 'echo', arguments: { x: 1 } },
    ])
  })

  // The proxy reports the tool-call limit on two wire paths: a 422 JSON body
  // before any stream frame, or an SSE error frame after one. Both must reach
  // the provider classifier with the proxy's code intact.
  it.each([
    {
      path: '422 JSON body before streaming',
      response: {
        ok: false,
        status: 422,
        json: async () => ({ error: 'tool_call_limit_exceeded' }),
      },
      message: 'proxy stream failed with 422 (tool_call_limit_exceeded)',
    },
    {
      path: 'SSE error frame after a text frame',
      response: {
        ok: true,
        body: sse([
          { type: 'text', text: 'partial' },
          { type: 'error', code: 'tool_call_limit_exceeded' },
        ]),
      },
      message: 'proxy stream failed with tool_call_limit_exceeded',
    },
  ])('surfaces tool_call_limit_exceeded from the $path', async ({ response, message }) => {
    const fetchFn = vi.fn().mockResolvedValue(response)
    const client = new CodexLlmProxyClient({
      runtimeUrl: resolveCodexProxyRuntimeUrl(
        'http://codex-llm-proxy.control-plane.svc.cluster.local:8080'
      ),
      readPlatformJwt: () => 'platform-jwt',
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    const err = await client
      .stream({ executionTicket: 'ticket-123456', requestHash: 'a'.repeat(64), request: {} })
      .then(
        () => undefined,
        (e: unknown) => e
      )
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(err).toBeInstanceOf(CodexProxyError)
    expect(err).toMatchObject({ code: 'tool_call_limit_exceeded', message })

    const classified = new CodexSubscriptionProvider('gpt-5.3-codex', {} as never).classifyError(
      err
    )
    expect(classified.code).toBe(LlmErrorCode.ToolCallLimitExceeded)
    expect(classified.retryable).toBe(false)
    expect(classifyFailoverClass(classified.code, classified.retryable)).toBeNull()
  })

  // #731 — the proxy's body parser refuses an envelope over its limit with
  // `reject(res, 413, 'payload_too_large')` (codex-llm-proxy/src/server.ts).
  // That is a size refusal of this conversation, not a failed API call.
  it('T-R2-6a classifies the proxy 413 payload_too_large as ContextLengthExceeded', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 413,
      json: async () => ({ error: 'payload_too_large' }),
    })
    const client = new CodexLlmProxyClient({
      runtimeUrl: resolveCodexProxyRuntimeUrl(
        'http://codex-llm-proxy.control-plane.svc.cluster.local:8080'
      ),
      readPlatformJwt: () => 'platform-jwt',
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    const err = await client
      .stream({ executionTicket: 'ticket-123456', requestHash: 'a'.repeat(64), request: {} })
      .then(
        () => undefined,
        (e: unknown) => e
      )
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(err).toMatchObject({
      code: 'payload_too_large',
      message: 'Codex request is too large; use fewer or smaller images, or reduce context',
    })

    const classified = new CodexSubscriptionProvider('gpt-5.3-codex', {} as never).classifyError(
      err
    )
    expect(classified).toMatchObject({
      code: LlmErrorCode.ContextLengthExceeded,
      retryable: false,
      providerCode: 'payload_too_large',
    })
    expect(classifyFailoverClass(classified.code, classified.retryable)).toBeNull()
  })

  // #731 — the upstream refuses a request over the model's context window with
  // `context_length_exceeded`. The proxy forwards that code as a 400 before any
  // frame, or as an SSE error frame after one. Retrying the same conversation
  // cannot succeed, so it must not read as a transient outage.
  it.each([
    {
      path: '400 JSON body before streaming',
      response: {
        ok: false,
        status: 400,
        json: async () => ({ error: 'context_length_exceeded' }),
      },
      message: 'proxy stream failed with 400 (context_length_exceeded)',
    },
    {
      path: 'SSE error frame after a text frame',
      response: {
        ok: true,
        body: sse([
          { type: 'text', text: 'partial' },
          { type: 'error', code: 'context_length_exceeded' },
        ]),
      },
      message: 'proxy stream failed with context_length_exceeded',
    },
  ])(
    'T-R7-2d classifies the upstream context_length_exceeded from the $path as ContextLengthExceeded',
    async ({ response, message }) => {
      const fetchFn = vi.fn().mockResolvedValue(response)
      const client = new CodexLlmProxyClient({
        runtimeUrl: resolveCodexProxyRuntimeUrl(
          'http://codex-llm-proxy.control-plane.svc.cluster.local:8080'
        ),
        readPlatformJwt: () => 'platform-jwt',
        fetchFn: fetchFn as unknown as typeof fetch,
      })
      const err = await client
        .stream({ executionTicket: 'ticket-123456', requestHash: 'a'.repeat(64), request: {} })
        .then(
          () => undefined,
          (e: unknown) => e
        )
      expect(fetchFn).toHaveBeenCalledTimes(1)
      expect(err).toBeInstanceOf(CodexProxyError)
      expect(err).toMatchObject({ code: 'context_length_exceeded', message })

      const classified = new CodexSubscriptionProvider('gpt-5.3-codex', {} as never).classifyError(
        err
      )
      expect(classified).toMatchObject({
        code: LlmErrorCode.ContextLengthExceeded,
        retryable: false,
        providerCode: 'context_length_exceeded',
      })
      expect(classifyFailoverClass(classified.code, classified.retryable)).toBeNull()
    }
  )

  // T-MB-5 — the proxy answers `408 { error: 'request_timeout' }` when the
  // body upload overruns its read deadline. The body never reached the
  // upstream, so this is not an outage: it must not enter failover cooldown.
  it('T-MB-5a classifies the proxy 408 request_timeout as a non-retryable ApiCallFailed', async () => {
    const fetchFn = vi.fn(async () => Response.json({ error: 'request_timeout' }, { status: 408 }))
    const client = new CodexLlmProxyClient({
      runtimeUrl: resolveCodexProxyRuntimeUrl(
        'http://codex-llm-proxy.control-plane.svc.cluster.local:8080'
      ),
      readPlatformJwt: () => 'platform-jwt',
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    const err = await client
      .stream({ executionTicket: 'ticket-123456', requestHash: 'a'.repeat(64), request: {} })
      .then(
        () => undefined,
        (e: unknown) => e
      )
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(err).toBeInstanceOf(CodexProxyError)
    expect(err).toMatchObject({
      code: 'request_timeout',
      message: 'proxy stream failed with 408 (request_timeout)',
    })

    const classified = new CodexSubscriptionProvider('gpt-5.3-codex', {} as never).classifyError(
      err
    )
    expect(classified).toMatchObject({
      code: LlmErrorCode.ApiCallFailed,
      retryable: false,
      providerCode: 'request_timeout',
    })
    expect(classifyFailoverClass(classified.code, classified.retryable)).toBeNull()
  })

  // T-TE-1 (D4) — the proxy passes control-api's redeem refusal through as
  // `403 { error: 'ticket_expired' }` when the ticket died while the request
  // was queued. Nothing reached the provider, so a re-authorized retry is the
  // remedy. `ticket_replayed` / `ticket_invalid` are defects and stay terminal.
  it.each([
    { error: 'ticket_expired', status: 403, retryable: true, failover: 'provider_unavailable' },
    { error: 'ticket_replayed', status: 409, retryable: false, failover: null },
    { error: 'ticket_invalid', status: 403, retryable: false, failover: null },
  ] as const)(
    'T-TE-1a classifies the proxy $status $error as ApiCallFailed with retryable=$retryable',
    async ({ error, status, retryable, failover }) => {
      const fetchFn = vi.fn(async () => Response.json({ error }, { status }))
      const client = new CodexLlmProxyClient({
        runtimeUrl: resolveCodexProxyRuntimeUrl(
          'http://codex-llm-proxy.control-plane.svc.cluster.local:8080'
        ),
        readPlatformJwt: () => 'platform-jwt',
        fetchFn: fetchFn as unknown as typeof fetch,
      })
      const err = await client
        .stream({ executionTicket: 'ticket-123456', requestHash: 'a'.repeat(64), request: {} })
        .then(
          () => undefined,
          (e: unknown) => e
        )
      expect(fetchFn).toHaveBeenCalledTimes(1)
      expect(err).toBeInstanceOf(CodexProxyError)
      expect(err).toMatchObject({
        code: error,
        message: `proxy stream failed with ${status} (${error})`,
        dispatched: true,
      })

      const classified = new CodexSubscriptionProvider('gpt-5.3-codex', {} as never).classifyError(
        err
      )
      expect(classified).toMatchObject({
        code: LlmErrorCode.ApiCallFailed,
        retryable,
        providerCode: error,
      })
      expect(classifyFailoverClass(classified.code, classified.retryable)).toBe(failover)
    }
  )

  // The proxy's total stream cap arrives as 504 before any frame, or as an SSE
  // error frame after one. The attempt spent its whole budget, so the same
  // request would spend it again elsewhere: no retry, no failover.
  it.each([
    {
      path: '504 JSON body before streaming',
      response: {
        ok: false,
        status: 504,
        json: async () => ({ error: 'stream_duration_exceeded' }),
      },
      message: 'proxy stream failed with 504 (stream_duration_exceeded)',
    },
    {
      path: 'SSE error frame after a text frame',
      response: {
        ok: true,
        body: sse([
          { type: 'text', text: 'partial' },
          { type: 'error', code: 'stream_duration_exceeded' },
        ]),
      },
      message: 'proxy stream failed with stream_duration_exceeded',
    },
  ])('surfaces stream_duration_exceeded from the $path', async ({ response, message }) => {
    const fetchFn = vi.fn().mockResolvedValue(response)
    const client = new CodexLlmProxyClient({
      runtimeUrl: resolveCodexProxyRuntimeUrl(
        'http://codex-llm-proxy.control-plane.svc.cluster.local:8080'
      ),
      readPlatformJwt: () => 'platform-jwt',
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    const err = await client
      .stream({ executionTicket: 'ticket-123456', requestHash: 'a'.repeat(64), request: {} })
      .then(
        () => undefined,
        (e: unknown) => e
      )
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(err).toBeInstanceOf(CodexProxyError)
    expect(err).toMatchObject({ code: 'stream_duration_exceeded', message })

    const provider = new CodexSubscriptionProvider('gpt-5.3-codex', {} as never)
    const classified = provider.classifyError(err)
    expect(classified.code).toBe(LlmErrorCode.StreamDurationExceeded)
    expect(classified.retryable).toBe(false)
    expect(classifyFailoverClass(classified.code, classified.retryable)).toBeNull()
    // Witness: the idle cut is an outage on the same classifier and does fail over.
    const idle = provider.classifyError(
      new CodexProxyError(
        'provider_unavailable',
        'proxy stream failed with 503 (provider_unavailable)'
      )
    )
    expect(classifyFailoverClass(idle.code, idle.retryable)).toBe('provider_unavailable')
  })

  // The proxy writes `: keepalive` SSE comments while the upstream is silent,
  // before and between data frames, and a comment can straddle two reads.
  it('ignores proxy keepalive comments around and between data frames', async () => {
    const encoder = new TextEncoder()
    const chunks = [
      ': keepalive\n\n: keep',
      'alive\n\n',
      'data: {"type":"text","text":"hel"}\n\n: keepalive\n\n',
      'data: {"type":"text","text":"lo"}\n\n',
      ': keepalive\n\ndata: {"type":"done","outcome":"success"}\n\n',
    ]
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
          controller.close()
        },
      }),
    })
    const client = new CodexLlmProxyClient({
      runtimeUrl: resolveCodexProxyRuntimeUrl('http://codex-llm-proxy:8080'),
      readPlatformJwt: () => 'platform-jwt',
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    const result = await client.stream({
      executionTicket: 'ticket-123456',
      requestHash: 'a'.repeat(64),
      request: { model: 'gpt-5.3-codex' },
    })
    expect(result.text).toBe('hello')
    expect(result.toolCalls).toEqual([])
    expect(result.outcome).toBe('success')
  })

  it('refuses a runtime URL that is not absolute', () => {
    expect(
      () =>
        new CodexLlmProxyClient({
          runtimeUrl: '/internal/runtime/v1/codex/completions',
          readPlatformJwt: () => 'platform-jwt',
        })
    ).toThrow(/absolute server-owned URL/)
  })

  it('fails closed when aborted before the proxy hop', async () => {
    const client = new CodexLlmProxyClient({
      runtimeUrl:
        'http://codex-llm-proxy.control-plane.svc.cluster.local:8080/internal/runtime/v1/codex/completions',
      readPlatformJwt: () => 'platform-jwt',
      fetchFn: vi.fn() as unknown as typeof fetch,
    })
    const signal = AbortSignal.abort()
    await expect(
      client.stream({
        executionTicket: 'ticket-123456',
        requestHash: 'a'.repeat(64),
        request: {},
        signal,
      })
    ).rejects.toMatchObject({ code: 'canceled' })
    expect(client['options'].fetchFn).not.toHaveBeenCalled()
  })

  it('surfaces the proxy error code with the HTTP status', async () => {
    const client = new CodexLlmProxyClient({
      runtimeUrl: resolveCodexProxyRuntimeUrl(
        'http://codex-llm-proxy.control-plane.svc.cluster.local:8080'
      ),
      readPlatformJwt: () => 'platform-jwt',
      fetchFn: vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({ error: 'origin_denied' }),
      }) as unknown as typeof fetch,
    })
    await expect(
      client.stream({
        executionTicket: 'ticket-123456',
        requestHash: 'a'.repeat(64),
        request: {},
      })
    ).rejects.toMatchObject({
      code: 'origin_denied',
      message: 'proxy stream failed with 403 (origin_denied)',
    })
  })

  it('refreshes the platform JWT once and retries the proxy hop after HTTP 401', async () => {
    let jwt = 'stale-jwt'
    const refreshOnUnauthorized = vi.fn(async () => {
      jwt = 'fresh-jwt'
    })
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ error: 'Unauthorized' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        body: sse([
          { type: 'text', text: 'ok' },
          { type: 'done', outcome: 'success' },
        ]),
      })
    const client = new CodexLlmProxyClient({
      runtimeUrl: resolveCodexProxyRuntimeUrl(
        'http://codex-llm-proxy.control-plane.svc.cluster.local:8080'
      ),
      readPlatformJwt: () => jwt,
      refreshOnUnauthorized,
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    const result = await client.stream({
      executionTicket: 'ticket-123456',
      requestHash: 'a'.repeat(64),
      request: {},
    })
    expect(refreshOnUnauthorized).toHaveBeenCalledTimes(1)
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(fetchFn.mock.calls[0][1].headers.authorization).toBe('Bearer stale-jwt')
    expect(fetchFn.mock.calls[1][1].headers.authorization).toBe('Bearer fresh-jwt')
    expect(result.text).toBe('ok')
  })

  it('fails closed when the proxy emits an SSE error frame after headers', async () => {
    const client = new CodexLlmProxyClient({
      runtimeUrl: resolveCodexProxyRuntimeUrl(
        'http://codex-llm-proxy.control-plane.svc.cluster.local:8080'
      ),
      readPlatformJwt: () => 'platform-jwt',
      fetchFn: vi.fn().mockResolvedValue({
        ok: true,
        body: sse([{ type: 'error', code: 'origin_denied' }]),
      }) as unknown as typeof fetch,
    })
    await expect(
      client.stream({
        executionTicket: 'ticket-123456',
        requestHash: 'a'.repeat(64),
        request: {},
      })
    ).rejects.toMatchObject({ code: 'origin_denied' })
  })

  it('marks only the pre-stream abort as never dispatched', async () => {
    const runtimeUrl = resolveCodexProxyRuntimeUrl(
      'http://codex-llm-proxy.control-plane.svc.cluster.local:8080'
    )

    const abortedClient = new CodexLlmProxyClient({
      runtimeUrl,
      readPlatformJwt: () => 'platform-jwt',
      fetchFn: vi.fn() as unknown as typeof fetch,
    })
    await expect(
      abortedClient.stream({
        executionTicket: 'ticket-123456',
        requestHash: 'a'.repeat(64),
        request: {},
        signal: AbortSignal.abort(),
      })
    ).rejects.toMatchObject({ code: 'canceled', dispatched: false })

    // The request left the process before control-api answered, so a denial is
    // not proof that nothing was billed.
    const deniedClient = new CodexLlmProxyClient({
      runtimeUrl,
      readPlatformJwt: () => 'platform-jwt',
      fetchFn: vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({ error: 'origin_denied' }),
      }) as unknown as typeof fetch,
    })
    await expect(
      deniedClient.stream({
        executionTicket: 'ticket-123456',
        requestHash: 'a'.repeat(64),
        request: {},
      })
    ).rejects.toMatchObject({ code: 'origin_denied', dispatched: true })

    // An error frame arrives mid-stream: the upstream call is already running.
    const framedClient = new CodexLlmProxyClient({
      runtimeUrl,
      readPlatformJwt: () => 'platform-jwt',
      fetchFn: vi.fn().mockResolvedValue({
        ok: true,
        body: sse([{ type: 'error', code: 'rate_limited' }]),
      }) as unknown as typeof fetch,
    })
    await expect(
      framedClient.stream({
        executionTicket: 'ticket-123456',
        requestHash: 'a'.repeat(64),
        request: {},
      })
    ).rejects.toMatchObject({ code: 'rate_limited', dispatched: true })
  })
})

// G1-6 (#720): a 429 is a rate limit, whether or not its body carries JSON,
// and its `Retry-After` (delta-seconds 1..3600) travels on the error.
describe('CodexLlmProxyClient rate limits', () => {
  const INPUT = {
    executionTicket: 'ticket-123456',
    requestHash: 'a'.repeat(64),
    request: {},
  }

  async function failure(response: Response) {
    const fetchFn = vi.fn<typeof fetch>(async () => response)
    const client = new CodexLlmProxyClient({
      runtimeUrl: 'http://proxy/completions',
      readPlatformJwt: () => 'platform-jwt',
      fetchFn,
    })
    const err = await client.stream(INPUT).then(
      () => undefined,
      (e: unknown) => e
    )
    return { err, fetchFn }
  }

  it('G1-6a reads a 429 with no JSON code as rate_limited with its Retry-After', async () => {
    const { err, fetchFn } = await failure(
      new Response('<html><body>Too Many Requests</body></html>', {
        status: 429,
        headers: { 'content-type': 'text/html', 'retry-after': '7' },
      })
    )
    // Liveness witness: the proxy hop ran and got the 429.
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(err).toBeInstanceOf(CodexProxyError)
    expect(err).toMatchObject({ code: 'rate_limited', retryAfterMs: 7000 })
  })

  it('G1-6b carries the Retry-After of a JSON rate_limited reply', async () => {
    const { err, fetchFn } = await failure(
      Response.json({ error: 'rate_limited' }, { status: 429, headers: { 'retry-after': '2' } })
    )
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(err).toMatchObject({ code: 'rate_limited', retryAfterMs: 2000 })
  })

  it.each(['0', '3601', 'soon', '1.5', 'Wed, 21 Oct 2026 07:28:00 GMT', ''])(
    'G1-6c drops the Retry-After value %j instead of guessing',
    async value => {
      const { err, fetchFn } = await failure(
        Response.json({ error: 'rate_limited' }, { status: 429, headers: { 'retry-after': value } })
      )
      expect(fetchFn).toHaveBeenCalledTimes(1)
      expect(err).toMatchObject({ code: 'rate_limited' })
      expect((err as CodexProxyError).retryAfterMs).toBeUndefined()
    }
  )

  it('G1-6c keeps the JSON code a 429 carries', async () => {
    const { err } = await failure(Response.json({ error: 'budget_denied' }, { status: 429 }))
    expect(err).toMatchObject({ code: 'budget_denied' })
  })

  // G1-11 (#720, review R1-B1): a limiter in the control-api shape answers a
  // reason phrase, not a code. On a 429 only a machine code wins.
  it('G1-11c reads a 429 whose JSON error is a reason phrase as rate_limited', async () => {
    const { err, fetchFn } = await failure(
      Response.json(
        { error: 'Too Many Requests', retryAfterSeconds: 4 },
        { status: 429, headers: { 'retry-after': '4' } }
      )
    )
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(err).toMatchObject({ code: 'rate_limited', retryAfterMs: 4000 })
  })

  it('G1-11c leaves the JSON error of a non-429 as it is', async () => {
    const { err, fetchFn } = await failure(
      Response.json({ error: 'Service Unavailable' }, { status: 503 })
    )
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(err).toMatchObject({ code: 'Service Unavailable' })
  })

  it('G1-6c keeps an HTML 502 as provider_unavailable with no Retry-After', async () => {
    const { err, fetchFn } = await failure(
      new Response('<html><body>502 Bad Gateway</body></html>', {
        status: 502,
        headers: { 'content-type': 'text/html', 'retry-after': '5' },
      })
    )
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(err).toMatchObject({ code: 'provider_unavailable' })
    expect((err as CodexProxyError).retryAfterMs).toBeUndefined()
  })
})

// G1-7 (#720): a proxy that no live process answered is control_plane_unavailable;
// a failure that may have reached one keeps its current shape.
describe('CodexLlmProxyClient control-plane reachability', () => {
  const INPUT = {
    executionTicket: 'ticket-123456',
    requestHash: 'a'.repeat(64),
    request: {},
  }

  function clientAt(runtimeUrl: string, fetchFn?: typeof fetch): CodexLlmProxyClient {
    return new CodexLlmProxyClient({
      runtimeUrl: resolveCodexProxyRuntimeUrl(runtimeUrl),
      readPlatformJwt: () => 'platform-jwt',
      ...(fetchFn ? { fetchFn } : {}),
    })
  }

  it('G1-7a reads a refused connection as control_plane_unavailable', async () => {
    const url = await closedPortUrl()
    // Witness: the platform fetch fails this way against the closed port.
    const raw = await fetch(`${url}/probe`).catch((caught: unknown) => caught)
    expect(raw).toBeInstanceOf(TypeError)
    expect((raw as { cause?: { code?: unknown } }).cause?.code).toBe('ECONNREFUSED')
    const err = await clientAt(url)
      .stream(INPUT)
      .catch((caught: unknown) => caught)
    expect(err).toBeInstanceOf(CodexProxyError)
    expect(err).toMatchObject({ code: 'control_plane_unavailable' })
    expect((err as Error).message).toContain('ECONNREFUSED')
  })

  it.each(['ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT'])(
    'G1-7b reads a %s fetch failure as control_plane_unavailable',
    async code => {
      const fetchFn = vi.fn<typeof fetch>(async () => {
        throw fetchFailure(code)
      })
      await expect(clientAt('http://proxy.invalid', fetchFn).stream(INPUT)).rejects.toMatchObject({
        name: 'CodexProxyError',
        code: 'control_plane_unavailable',
      })
      expect(fetchFn).toHaveBeenCalledTimes(1)
    }
  )

  it('G1-7c rethrows a reset connection unchanged', async () => {
    const failure = fetchFailure('ECONNRESET')
    const fetchFn = vi.fn<typeof fetch>(async () => {
      throw failure
    })
    await expect(clientAt('http://proxy.invalid', fetchFn).stream(INPUT)).rejects.toBe(failure)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('G1-7d rejects with the abort reason when the caller aborts a request in flight', async () => {
    const server = await silentServer()
    try {
      const controller = new AbortController()
      const reason = new Error('caller gave up')
      const pending = clientAt(server.url)
        .stream({ ...INPUT, signal: controller.signal })
        .catch((caught: unknown) => caught)
      // Witness: the request reached a live process before the abort.
      await server.received
      controller.abort(reason)
      expect(await pending).toBe(reason)
    } finally {
      await server.close()
    }
  })

  it('G1-7d rethrows a connect-phase code unchanged once the caller aborted', async () => {
    const controller = new AbortController()
    const failure = fetchFailure('ECONNREFUSED')
    const fetchFn = vi.fn<typeof fetch>(async () => {
      controller.abort(new Error('caller gave up'))
      throw failure
    })
    await expect(
      clientAt('http://proxy.invalid', fetchFn).stream({ ...INPUT, signal: controller.signal })
    ).rejects.toBe(failure)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('G1-7e leaves an error raised after the response started unchanged', async () => {
    const failure = fetchFailure('ECONNREFUSED')
    const fetchFn = vi.fn<typeof fetch>(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(failure)
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } }
        )
    )
    await expect(clientAt('http://proxy.invalid', fetchFn).stream(INPUT)).rejects.toBe(failure)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
})

// G1-8 (#720): the classifier's answer for the two codes G1 adds on the wire.
describe('CodexSubscriptionProvider G1 classification', () => {
  const provider = new CodexSubscriptionProvider('gpt-5.3-codex', {} as never)

  async function proxyReply(response: Response): Promise<unknown> {
    const fetchFn = vi.fn<typeof fetch>(async () => response)
    const err = await new CodexLlmProxyClient({
      runtimeUrl: 'http://proxy/completions',
      readPlatformJwt: () => 'platform-jwt',
      fetchFn,
    })
      .stream({ executionTicket: 'ticket-123456', requestHash: 'a'.repeat(64), request: {} })
      .catch((caught: unknown) => caught)
    // Liveness witness: the proxy hop ran.
    expect(fetchFn).toHaveBeenCalledTimes(1)
    return err
  }

  it('G1-8a keeps an upstream 4xx terminal with no failover', async () => {
    const err = await proxyReply(
      Response.json({ error: 'upstream_rejected', upstreamStatus: 404 }, { status: 422 })
    )
    const classified = provider.classifyError(err)
    expect(classified).toMatchObject({
      code: LlmErrorCode.ApiCallFailed,
      retryable: false,
      providerCode: 'upstream_rejected',
      providerDispatched: true,
      // Review R1-H2: a 402 and a 404 no longer read the same downstream.
      httpStatus: 404,
    })
    expect(classifyFailoverClass(classified.code, classified.retryable)).toBeNull()
  })

  it('G1-8c reads the upstream status from an SSE error frame', async () => {
    const err = await proxyReply(
      new Response(sse([{ type: 'error', code: 'upstream_rejected', upstreamStatus: 402 }]), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    )
    expect(err).toMatchObject({ code: 'upstream_rejected', upstreamStatus: 402 })
    expect(provider.classifyError(err)).toMatchObject({
      code: LlmErrorCode.ApiCallFailed,
      httpStatus: 402,
    })
  })

  it.each([200, 404.5, '404', 600])(
    'G1-8d ignores an upstreamStatus of %j that is not an integer 4xx',
    async upstreamStatus => {
      const err = await proxyReply(
        Response.json({ error: 'upstream_rejected', upstreamStatus }, { status: 422 })
      )
      // Witness: the code still arrived; only the status was refused.
      expect(err).toMatchObject({ code: 'upstream_rejected' })
      expect((err as { upstreamStatus?: number }).upstreamStatus).toBeUndefined()
      expect(provider.classifyError(err).httpStatus).toBeUndefined()
    }
  )

  it('G1-8e reads upstreamStatus only for upstream_rejected', async () => {
    const err = await proxyReply(
      Response.json({ error: 'provider_unavailable', upstreamStatus: 404 }, { status: 503 })
    )
    expect(err).toMatchObject({ code: 'provider_unavailable' })
    expect((err as { upstreamStatus?: number }).upstreamStatus).toBeUndefined()
  })

  it('G1-8b labels a gateway control_plane_unavailable reply as a control-plane outage', async () => {
    const err = await proxyReply(
      Response.json({ error: 'control_plane_unavailable' }, { status: 503 })
    )
    const classified = provider.classifyError(err)
    expect(LlmErrorCode.ControlPlaneUnavailable).toBe('LLM_CONTROL_PLANE_UNAVAILABLE')
    expect(classified).toMatchObject({
      code: LlmErrorCode.ControlPlaneUnavailable,
      retryable: true,
      providerCode: 'control_plane_unavailable',
      providerDispatched: true,
    })
    // Same failover class as the outage label it replaces.
    expect(classifyFailoverClass(classified.code, classified.retryable)).toBe(
      'provider_unavailable'
    )
  })

  it('G1-8b labels a refused proxy connection as a control-plane outage', async () => {
    const url = await closedPortUrl()
    const err = await new CodexLlmProxyClient({
      runtimeUrl: resolveCodexProxyRuntimeUrl(url),
      readPlatformJwt: () => 'platform-jwt',
    })
      .stream({ executionTicket: 'ticket-123456', requestHash: 'a'.repeat(64), request: {} })
      .catch((caught: unknown) => caught)
    expect(err).toMatchObject({ code: 'control_plane_unavailable' })
    expect(provider.classifyError(err)).toMatchObject({
      code: LlmErrorCode.ControlPlaneUnavailable,
      retryable: true,
      providerCode: 'control_plane_unavailable',
    })
  })

  it('G1-8b labels an authorize that reached no gateway as a control-plane outage, not dispatched', () => {
    const classified = provider.classifyError(
      new CodexAuthorizeError(
        'control_plane_unavailable',
        'authorize could not reach the control plane (ECONNREFUSED)'
      )
    )
    expect(classified).toMatchObject({
      code: LlmErrorCode.ControlPlaneUnavailable,
      retryable: true,
      providerCode: 'control_plane_unavailable',
      providerDispatched: false,
    })
    expect(classifyFailoverClass(classified.code, classified.retryable)).toBe(
      'provider_unavailable'
    )
  })

  it('G1-8c still labels provider_unavailable as an overload', async () => {
    const err = await proxyReply(Response.json({ error: 'provider_unavailable' }, { status: 503 }))
    expect(provider.classifyError(err)).toMatchObject({
      code: LlmErrorCode.ModelOverloaded,
      retryable: true,
    })
  })
})
