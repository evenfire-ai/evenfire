import { describe, expect, it, vi } from 'vitest'
import { CodexLlmProxyClient, resolveCodexProxyRuntimeUrl } from '../codexLlmProxyClient'

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
    })
    expect(fetchFn.mock.calls[0][0]).toBe(
      'http://codex-llm-proxy.control-plane.svc.cluster.local:8080/internal/runtime/v1/codex/completions'
    )
    expect(result.text).toBe('hello')
    expect(result.toolCalls).toEqual([
      { type: 'tool_call', id: 'c1', name: 'echo', arguments: { x: 1 } },
    ])
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
})
