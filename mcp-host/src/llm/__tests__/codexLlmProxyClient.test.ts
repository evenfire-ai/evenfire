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
