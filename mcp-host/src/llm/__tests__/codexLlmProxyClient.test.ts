import { describe, expect, it, vi } from 'vitest'
import { LlmErrorCode } from '../../core/errors'
import {
  CodexLlmProxyClient,
  CodexProxyError,
  resolveCodexProxyRuntimeUrl,
} from '../codexLlmProxyClient'
import { CodexSubscriptionProvider } from '../codexSubscription'
import { classifyFailoverClass } from '../failover/classify'

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
  it('streams only to the server-owned runtime Service URL and ignores a caller-supplied URL', async () => {
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
      message: 'proxy stream failed with 413 (payload_too_large)',
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
