import { describe, expect, it } from 'vitest'
import { isTraceContextV1, mintOrReuseDirectTraceContext } from './traceContext.js'

describe('TraceContextV1 rpc-proxy contract', () => {
  it('mints a direct-chat context with the durable Desktop chat id', () => {
    const context = mintOrReuseDirectTraceContext({
      authorityScope: 'user-1:host-1',
      deliveryId: 'delivery-1',
      sessionId: 'desktop-chat-1',
      requestId: 'edge-request-1',
      origin: 'direct_chat',
    })
    expect(context).toMatchObject({
      version: 1,
      sessionId: 'desktop-chat-1',
      origin: 'direct_chat',
      correlationRefs: [
        'delivery:delivery-1',
        'desktop-chat:desktop-chat-1',
        'edge-request:edge-request-1',
      ],
    })
    expect(context.runId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    )
    expect(isTraceContextV1(context)).toBe(true)
  })

  it('retains context for a duplicate durable delivery id', () => {
    const first = mintOrReuseDirectTraceContext({
      authorityScope: 'user-1:host-1',
      deliveryId: 'duplicate-delivery',
      sessionId: 'chat-1',
      requestId: 'request-1',
      origin: 'direct_chat',
    })
    const duplicate = mintOrReuseDirectTraceContext({
      authorityScope: 'user-1:host-1',
      deliveryId: 'duplicate-delivery',
      sessionId: 'chat-1',
      requestId: 'request-2',
      origin: 'direct_chat',
    })
    expect(duplicate).toBe(first)
    expect(duplicate.runId).toBe(first.runId)
    expect(duplicate.correlationRefs).toContain('edge-request:request-1')
    expect(duplicate.correlationRefs).not.toContain('edge-request:request-2')
  })

  it('does not reuse a caller idempotency key across authority scopes', () => {
    const first = mintOrReuseDirectTraceContext({
      authorityScope: 'user-1:host-1',
      deliveryId: 'shared-key',
      origin: 'direct_chat',
    })
    const second = mintOrReuseDirectTraceContext({
      authorityScope: 'user-2:host-1',
      deliveryId: 'shared-key',
      origin: 'direct_chat',
    })
    expect(second.runId).not.toBe(first.runId)
  })

  it('rejects values outside the local wire contract', () => {
    const context = mintOrReuseDirectTraceContext({
      authorityScope: 'user-1:host-1',
      deliveryId: 'contract-check',
      origin: 'api',
    })
    expect(isTraceContextV1({ ...context, unexpected: 'value' })).toBe(false)
  })
})
