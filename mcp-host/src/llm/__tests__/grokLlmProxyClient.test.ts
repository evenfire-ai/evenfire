import { describe, expect, it, vi } from 'vitest'
import { GrokLlmProxyClient, resolveGrokProxyRuntimeUrl } from '../grokLlmProxyClient'

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

describe('GrokLlmProxyClient', () => {
  it('streams to the frozen Grok runtime path and never accepts a caller URL', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      body: sse([
        { type: 'text', text: 'hello' },
        { type: 'done', outcome: 'success' },
      ]),
    })
    const client = new GrokLlmProxyClient({
      runtimeUrl: resolveGrokProxyRuntimeUrl(
        'http://grok-llm-proxy.control-plane.svc.cluster.local:8080'
      ),
      readPlatformJwt: () => 'platform-jwt',
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    const result = await client.stream({
      executionTicket: 'ticket-123456',
      requestHash: 'a'.repeat(64),
      request: { model: 'grok-4.6' },
    })
    expect(fetchFn.mock.calls[0][0]).toBe(
      'http://grok-llm-proxy.control-plane.svc.cluster.local:8080/internal/runtime/v1/grok/completions'
    )
    expect(result.text).toBe('hello')
  })
})
