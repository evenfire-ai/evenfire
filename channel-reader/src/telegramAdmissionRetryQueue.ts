import { serialize } from 'node:v8'
import type { TraceContextV1 } from './traceContext'
import type { Message } from './types'

export const TELEGRAM_ADMISSION_RETRY_MAX_EVENTS = 64
export const TELEGRAM_ADMISSION_RETRY_MAX_ACCOUNTED_BYTES = 1024 * 1024

const RETAINED_ENTRY_BOOKKEEPING_RESERVE_BYTES = 256
const OBJECT_GRAPH_NODE_BYTES = 64
const OBJECT_GRAPH_SLOT_BYTES = 8

export interface PendingTelegramAdmissionRetry {
  message: Message
  traceContext: TraceContextV1
  eventKey: string
  streamKey: string
  retryAt: number
  retryUsed: boolean
  inFlight: boolean
  rescheduled: boolean
}

export interface TelegramAdmissionRetryBufferSnapshot {
  events: number
  accountedBytes: number
  streams: number
}

export type TelegramRetryEnqueueResult =
  | { status: 'retained'; entry: PendingTelegramAdmissionRetry }
  | { status: 'duplicate'; entry: PendingTelegramAdmissionRetry }
  | { status: 'full' }
  | { status: 'unaccountable' }

type RetryAccounting = { bytes: number } | null

/**
 * Account serialized payload plus a conservative estimate of its retained JS object graph.
 * Unsupported values fail closed; string length alone never stands in for retained memory.
 */
export function accountedTelegramAdmissionRetryBytes(
  entry: PendingTelegramAdmissionRetry
): RetryAccounting {
  try {
    const serializedBytes = serialize(entry).byteLength
    const seen = new WeakSet<object>()
    const pending: object[] = [entry]
    let objectNodes = 0
    let propertyAndCollectionSlots = 0

    while (pending.length > 0) {
      const current = pending.pop()!
      if (seen.has(current)) continue
      seen.add(current)
      objectNodes += 1

      if (
        current instanceof Date ||
        ArrayBuffer.isView(current) ||
        current instanceof ArrayBuffer
      ) {
        continue
      }
      if (current instanceof Map) {
        propertyAndCollectionSlots += current.size * 2
        for (const [key, value] of current) {
          if (key !== null && typeof key === 'object') pending.push(key)
          if (value !== null && typeof value === 'object') pending.push(value)
        }
        continue
      }
      if (current instanceof Set) {
        propertyAndCollectionSlots += current.size
        for (const value of current) {
          if (value !== null && typeof value === 'object') pending.push(value)
        }
        continue
      }

      const keys = Object.keys(current)
      propertyAndCollectionSlots += keys.length
      for (const key of keys) {
        const value = (current as Record<string, unknown>)[key]
        if (value !== null && typeof value === 'object') pending.push(value)
      }
    }

    const bytes =
      serializedBytes +
      objectNodes * OBJECT_GRAPH_NODE_BYTES +
      propertyAndCollectionSlots * OBJECT_GRAPH_SLOT_BYTES +
      RETAINED_ENTRY_BOOKKEEPING_RESERVE_BYTES
    return Number.isSafeInteger(bytes) && bytes > 0 ? { bytes } : null
  } catch {
    return null
  }
}

/**
 * Process-local, count- and object-graph-bounded scheduler storage for the one R66-M1 retry.
 * FIFO is enforced per conversation + Host/CommunicationChannel stream. Due heads are selected
 * round-robin across streams. This queue is deliberately volatile and is not an inbox.
 */
export class TelegramAdmissionRetryQueue {
  private readonly byStream = new Map<string, PendingTelegramAdmissionRetry[]>()
  private readonly byEventKey = new Map<string, PendingTelegramAdmissionRetry>()
  private readonly entryBytes = new Map<PendingTelegramAdmissionRetry, number>()
  private lastDispatchedStreamKey: string | null = null
  private retainedBytes = 0

  get snapshot(): TelegramAdmissionRetryBufferSnapshot {
    return {
      events: this.byEventKey.size,
      accountedBytes: this.retainedBytes,
      streams: this.byStream.size,
    }
  }

  get(eventKey: string): PendingTelegramAdmissionRetry | undefined {
    return this.byEventKey.get(eventKey)
  }

  hasEvent(eventKey: string): boolean {
    return this.byEventKey.has(eventKey)
  }

  hasStream(streamKey: string): boolean {
    return this.byStream.has(streamKey)
  }

  enqueue(
    value: Omit<PendingTelegramAdmissionRetry, 'inFlight' | 'rescheduled'>
  ): TelegramRetryEnqueueResult {
    const existing = this.byEventKey.get(value.eventKey)
    if (existing) return { status: 'duplicate', entry: existing }
    if (this.byEventKey.size >= TELEGRAM_ADMISSION_RETRY_MAX_EVENTS) return { status: 'full' }

    const entry: PendingTelegramAdmissionRetry = {
      ...value,
      inFlight: false,
      rescheduled: false,
    }
    const accounting = accountedTelegramAdmissionRetryBytes(entry)
    if (!accounting) return { status: 'unaccountable' }
    if (this.retainedBytes + accounting.bytes > TELEGRAM_ADMISSION_RETRY_MAX_ACCOUNTED_BYTES) {
      return { status: 'full' }
    }

    const stream = this.byStream.get(entry.streamKey)
    if (stream) stream.push(entry)
    else this.byStream.set(entry.streamKey, [entry])
    this.byEventKey.set(entry.eventKey, entry)
    this.entryBytes.set(entry, accounting.bytes)
    this.retainedBytes += accounting.bytes
    return { status: 'retained', entry }
  }

  /** Convert a first-attempt FIFO follower into its one delayed retry. */
  scheduleRetry(
    entry: PendingTelegramAdmissionRetry,
    retryAt: number
  ): 'scheduled' | 'full' | 'not-retained' {
    if (this.byEventKey.get(entry.eventKey) !== entry) return 'not-retained'
    if (entry.retryUsed) return 'not-retained'

    const previousBytes = this.entryBytes.get(entry)
    if (previousBytes === undefined) return 'not-retained'
    const previousRetryAt = entry.retryAt
    const previousRetryUsed = entry.retryUsed
    const previousRescheduled = entry.rescheduled
    entry.retryAt = retryAt
    entry.retryUsed = true
    entry.rescheduled = true
    entry.inFlight = false

    const accounting = accountedTelegramAdmissionRetryBytes(entry)
    if (
      !accounting ||
      this.retainedBytes - previousBytes + accounting.bytes >
        TELEGRAM_ADMISSION_RETRY_MAX_ACCOUNTED_BYTES
    ) {
      entry.retryAt = previousRetryAt
      entry.retryUsed = previousRetryUsed
      entry.rescheduled = previousRescheduled
      this.finish(entry, Date.now())
      return 'full'
    }

    this.retainedBytes += accounting.bytes - previousBytes
    this.entryBytes.set(entry, accounting.bytes)
    return 'scheduled'
  }

  /** Start at most one currently due stream head, using round-robin stream order. */
  takeDue(now: number): PendingTelegramAdmissionRetry | null {
    const streams = [...this.byStream.keys()]
    if (streams.length === 0) return null
    const lastIndex = this.lastDispatchedStreamKey
      ? streams.indexOf(this.lastDispatchedStreamKey)
      : -1
    const startIndex = lastIndex < 0 ? 0 : (lastIndex + 1) % streams.length

    for (let offset = 0; offset < streams.length; offset += 1) {
      const streamKey = streams[(startIndex + offset) % streams.length]
      const head = this.byStream.get(streamKey)?.[0]
      if (!head || head.inFlight || head.retryAt > now) continue
      head.inFlight = true
      head.rescheduled = false
      this.lastDispatchedStreamKey = streamKey
      return head
    }
    return null
  }

  /**
   * Complete one target. Its FIFO follower (if any) becomes immediately eligible at the
   * completion time; it still gets its own first attempt and one-retry budget.
   */
  finish(entry: PendingTelegramAdmissionRetry, now: number): void {
    if (this.byEventKey.get(entry.eventKey) !== entry) return
    const stream = this.byStream.get(entry.streamKey)
    if (!stream) return
    const index = stream.indexOf(entry)
    if (index < 0) return

    stream.splice(index, 1)
    this.byEventKey.delete(entry.eventKey)
    const bytes = this.entryBytes.get(entry) ?? 0
    this.entryBytes.delete(entry)
    this.retainedBytes = Math.max(0, this.retainedBytes - bytes)
    entry.inFlight = false

    if (stream.length === 0) {
      this.byStream.delete(entry.streamKey)
      return
    }
    if (!stream[0].inFlight) stream[0].retryAt = now
  }

  clear(): TelegramAdmissionRetryBufferSnapshot {
    const previous = this.snapshot
    this.byStream.clear()
    this.byEventKey.clear()
    this.entryBytes.clear()
    this.lastDispatchedStreamKey = null
    this.retainedBytes = 0
    return previous
  }
}
