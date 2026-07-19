import { randomUUID } from 'node:crypto'
import type { Message } from './types'

export interface TraceContextV1 {
  version: 1
  runId: string
  sessionId?: string | null
  origin: 'channel_event' | 'direct_chat' | 'api'
  correlationRefs: readonly string[]
}

const MAX_CORRELATION_REFS = 16
const MAX_CORRELATION_REF_LENGTH = 256

function correlationRefs(candidates: Array<string | undefined>): string[] {
  return candidates
    .map(value => value?.trim())
    .filter(
      (value): value is string =>
        value !== undefined && value.length > 0 && value.length <= MAX_CORRELATION_REF_LENGTH
    )
    .filter((value, index, refs) => refs.indexOf(value) === index)
    .slice(0, MAX_CORRELATION_REFS)
}

export function mintChannelTraceContext(message: Message): TraceContextV1 {
  const providerEventId = message.providerIdentity?.providerEventId?.trim()
  const deliveryId = message.messageId.trim()
  return {
    version: 1,
    runId: randomUUID(),
    sessionId: null,
    origin: 'channel_event',
    correlationRefs: correlationRefs([
      providerEventId ? `provider-event:${providerEventId}` : undefined,
      deliveryId ? `channel-delivery:${deliveryId}` : undefined,
      message.threadId ? `provider-thread:${message.threadId}` : undefined,
    ]),
  }
}

export function isTraceContextV1(value: unknown): value is TraceContextV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const context = value as Record<string, unknown>
  const allowedKeys = new Set(['version', 'runId', 'sessionId', 'origin', 'correlationRefs'])
  if (Object.keys(context).some(key => !allowedKeys.has(key))) return false
  if (context.version !== 1 || typeof context.runId !== 'string' || !context.runId.trim())
    return false
  if (
    context.sessionId !== undefined &&
    context.sessionId !== null &&
    (typeof context.sessionId !== 'string' || !context.sessionId.trim())
  ) {
    return false
  }
  if (!['channel_event', 'direct_chat', 'api'].includes(context.origin as string)) return false
  return (
    Array.isArray(context.correlationRefs) &&
    context.correlationRefs.length <= MAX_CORRELATION_REFS &&
    context.correlationRefs.every(
      ref => typeof ref === 'string' && ref.length > 0 && ref.length <= MAX_CORRELATION_REF_LENGTH
    )
  )
}
