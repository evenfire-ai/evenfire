import { randomUUID } from 'node:crypto'

export interface TraceContextV1 {
  version: 1
  runId: string
  sessionId?: string | null
  origin: 'channel_event' | 'direct_chat' | 'api'
  correlationRefs: readonly string[]
}

type DirectTraceContextInput = {
  authorityScope: string
  deliveryId: string
  sessionId?: string
  requestId?: string
  origin: 'direct_chat' | 'api'
}

const MAX_CORRELATION_REFS = 16
const MAX_CORRELATION_REF_LENGTH = 256
const DELIVERY_CONTEXT_TTL_MS = 30 * 60 * 1000
const MAX_DELIVERY_CONTEXTS = 2048
const contextsByDeliveryId = new Map<string, { context: TraceContextV1; expiresAt: number }>()

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

function trimContextCache(now: number): void {
  for (const [deliveryId, entry] of contextsByDeliveryId) {
    if (entry.expiresAt <= now) contextsByDeliveryId.delete(deliveryId)
  }
  while (contextsByDeliveryId.size >= MAX_DELIVERY_CONTEXTS) {
    const oldestDeliveryId = contextsByDeliveryId.keys().next().value
    if (!oldestDeliveryId) break
    contextsByDeliveryId.delete(oldestDeliveryId)
  }
}

export function mintOrReuseDirectTraceContext(input: DirectTraceContextInput): TraceContextV1 {
  const deliveryId = input.deliveryId.trim()
  const authorityScope = input.authorityScope.trim()
  if (!deliveryId || !authorityScope)
    throw new Error('trace delivery and authority scope are required')
  const cacheKey = `${authorityScope}\u0000${deliveryId}`
  const now = Date.now()
  const existing = contextsByDeliveryId.get(cacheKey)
  if (existing && existing.expiresAt > now) return existing.context

  trimContextCache(now)
  const sessionId = input.sessionId?.trim() || null
  const context: TraceContextV1 = {
    version: 1,
    runId: randomUUID(),
    sessionId,
    origin: input.origin,
    correlationRefs: correlationRefs([
      `delivery:${deliveryId}`,
      sessionId ? `desktop-chat:${sessionId}` : undefined,
      input.requestId ? `edge-request:${input.requestId}` : undefined,
    ]),
  }
  contextsByDeliveryId.set(cacheKey, { context, expiresAt: now + DELIVERY_CONTEXT_TTL_MS })
  return context
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
