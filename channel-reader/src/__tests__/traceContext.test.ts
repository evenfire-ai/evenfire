import { describe, expect, it } from 'vitest'
import { isTraceContextV1, mintChannelTraceContext } from '../traceContext'
import type { Message } from '../types'

const message: Message = {
  channelType: 'telegram',
  channelId: '424242',
  sender: '123456',
  content: 'hello',
  timestamp: new Date('2026-07-11T08:00:00.000Z'),
  messageId: '9001',
  threadId: 'thread-1',
  providerIdentity: {
    medium: 'telegram',
    providerUserId: '123456',
    providerChannelId: '424242',
    providerEventId: 'telegram:424242:9001',
  },
}

describe('TraceContextV1 channel-reader contract', () => {
  it('mints the mcp-host-compatible channel context', () => {
    const context = mintChannelTraceContext(message)
    expect(context).toMatchObject({
      version: 1,
      origin: 'channel_event',
      sessionId: null,
      correlationRefs: [
        'provider-event:telegram:424242:9001',
        'channel-delivery:9001',
        'provider-thread:thread-1',
      ],
    })
    expect(context.runId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    )
    expect(isTraceContextV1(context)).toBe(true)
  })

  it('rejects values outside the local wire contract', () => {
    expect(isTraceContextV1({ ...mintChannelTraceContext(message), unexpected: 'value' })).toBe(
      false
    )
  })
})
