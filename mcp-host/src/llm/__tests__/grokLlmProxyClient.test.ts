import { describe, expect, it, vi } from 'vitest'
import { GrokLlmProxyClient, resolveGrokProxyRuntimeUrl } from '../grokLlmProxyClient'

const RUNTIME_BASE = 'http://grok-llm-proxy.control-plane.svc.cluster.local:8080'
const RUNTIME_URL = `${RUNTIME_BASE}/internal/runtime/v1/grok/completions`

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

function client(fetchFn: unknown, extra: { refreshOnUnauthorized?: () => Promise<void> } = {}) {
  return new GrokLlmProxyClient({
    runtimeUrl: resolveGrokProxyRuntimeUrl(RUNTIME_BASE),
    readPlatformJwt: () => 'platform-jwt',
    fetchFn: fetchFn as typeof fetch,
    ...extra,
  })
}

const STREAM_INPUT = {
  executionTicket: 'ticket-123456',
  requestHash: 'a'.repeat(64),
  request: { model: 'grok-4.6' },
}

describe('GrokLlmProxyClient', () => {
  it('streams only to the server-owned Grok runtime URL and ignores a caller-supplied URL', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      body: sse([
        { type: 'text', text: 'hello' },
        { type: 'tool_call', id: 'c1', name: 'echo', arguments: { x: 1 } },
        { type: 'done', outcome: 'success', usage: { inputTokens: 3, outputTokens: 5 } },
      ]),
    })
    const result = await client(fetchFn).stream({
      ...STREAM_INPUT,
      // Not part of the input type: a caller must not be able to redirect the hop.
      url: 'https://attacker.example/v1/responses',
      runtimeUrl: 'https://attacker.example/internal/runtime/v1/grok/completions',
    } as never)
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(fetchFn.mock.calls[0][0]).toBe(RUNTIME_URL)
    const sent = JSON.parse(fetchFn.mock.calls[0][1].body)
    expect(Object.keys(sent).sort()).toEqual(['executionTicket', 'request', 'requestHash'])
    expect(JSON.stringify(sent)).not.toContain('attacker.example')
    expect(result.text).toBe('hello')
    expect(result.toolCalls).toEqual([
      { type: 'tool_call', id: 'c1', name: 'echo', arguments: { x: 1 } },
    ])
    expect(result.outcome).toBe('success')
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 5 })
  })

  it('refuses a runtime URL that is not absolute', () => {
    expect(
      () =>
        new GrokLlmProxyClient({
          runtimeUrl: '/internal/runtime/v1/grok/completions',
          readPlatformJwt: () => 'platform-jwt',
        })
    ).toThrow(/absolute server-owned URL/)
  })

  it('fails closed when aborted before the proxy hop', async () => {
    const fetchFn = vi.fn()
    await expect(
      client(fetchFn).stream({ ...STREAM_INPUT, signal: AbortSignal.abort() })
    ).rejects.toMatchObject({ code: 'canceled', dispatched: false })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('surfaces the proxy error code with the HTTP status', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: 'origin_denied' }),
    })
    await expect(client(fetchFn).stream(STREAM_INPUT)).rejects.toMatchObject({
      name: 'GrokProxyError',
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
    const grok = new GrokLlmProxyClient({
      runtimeUrl: resolveGrokProxyRuntimeUrl(RUNTIME_BASE),
      readPlatformJwt: () => jwt,
      refreshOnUnauthorized,
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    const result = await grok.stream(STREAM_INPUT)
    expect(refreshOnUnauthorized).toHaveBeenCalledTimes(1)
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(fetchFn.mock.calls[0][1].headers.authorization).toBe('Bearer stale-jwt')
    expect(fetchFn.mock.calls[1][1].headers.authorization).toBe('Bearer fresh-jwt')
    expect(result.text).toBe('ok')
  })

  it('refreshes at most once when the retried hop is still unauthorized', async () => {
    const refreshOnUnauthorized = vi.fn(async () => undefined)
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: 'unauthorized' }),
    })
    await expect(
      client(fetchFn, { refreshOnUnauthorized }).stream(STREAM_INPUT)
    ).rejects.toMatchObject({ code: 'unauthorized' })
    expect(refreshOnUnauthorized).toHaveBeenCalledTimes(1)
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('fails closed when the proxy emits an SSE error frame after headers', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      body: sse([
        { type: 'text', text: 'partial' },
        { type: 'error', code: 'origin_denied' },
      ]),
    })
    await expect(client(fetchFn).stream(STREAM_INPUT)).rejects.toMatchObject({
      code: 'origin_denied',
      dispatched: true,
    })
  })

  it('reports a missing terminal frame as an unknown outcome', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      body: sse([{ type: 'text', text: 'cut off' }]),
    })
    await expect(client(fetchFn).stream(STREAM_INPUT)).resolves.toMatchObject({
      text: 'cut off',
      outcome: 'unknown',
    })
  })

  it('marks only the pre-stream abort as never dispatched', async () => {
    await expect(
      client(vi.fn()).stream({ ...STREAM_INPUT, signal: AbortSignal.abort() })
    ).rejects.toMatchObject({ code: 'canceled', dispatched: false })

    // The request left the process before the proxy answered, so a denial is
    // not proof that nothing was billed.
    const denied = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: 'origin_denied' }),
    })
    await expect(client(denied).stream(STREAM_INPUT)).rejects.toMatchObject({
      code: 'origin_denied',
      dispatched: true,
    })

    // An error frame arrives mid-stream: the upstream call is already running.
    const framed = vi.fn().mockResolvedValue({
      ok: true,
      body: sse([{ type: 'error', code: 'rate_limited' }]),
    })
    await expect(client(framed).stream(STREAM_INPUT)).rejects.toMatchObject({
      code: 'rate_limited',
      dispatched: true,
    })

    const bodiless = vi.fn().mockResolvedValue({ ok: true, body: null })
    await expect(client(bodiless).stream(STREAM_INPUT)).rejects.toMatchObject({
      code: 'provider_unavailable',
      dispatched: true,
    })
  })
})
