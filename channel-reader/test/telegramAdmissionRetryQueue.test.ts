import { describe, expect, it } from 'vitest'
import { buildTelegramOperationalMessage } from '../src/channels/telegramOperationalMessage'
import {
  type PendingTelegramAdmissionRetry,
  TELEGRAM_ADMISSION_RETRY_MAX_ACCOUNTED_BYTES,
  TELEGRAM_ADMISSION_RETRY_MAX_EVENTS,
  TelegramAdmissionRetryQueue,
  accountedTelegramAdmissionRetryBytes,
} from '../src/telegramAdmissionRetryQueue'
import { mintChannelTraceContext } from '../src/traceContext'
import type { Message } from '../src/types'

function pending(
  id: number,
  options: { streamKey?: string; content?: string } = {}
): Omit<PendingTelegramAdmissionRetry, 'inFlight' | 'rescheduled'> {
  const chatId = options.streamKey ?? 'chat-a'
  const content = options.content ?? `event-${id}`
  const target = {
    hostRef: 'host-a',
    communicationChannelNamespace: 'channels',
    communicationChannelName: 'telegram-a',
  }
  const message: Message = buildTelegramOperationalMessage({
    text: content,
    chatId,
    chatType: 'private',
    senderId: '1234',
    senderUsername: 'queue-test-user',
    senderIsBot: false,
    hasSenderChat: false,
    messageId: id,
    date: 1_792_080_000,
    rawMessage: {
      message_id: id,
      chat: { id: chatId, type: 'private' },
      from: { id: 1234, username: 'queue-test-user', is_bot: false },
      text: content,
      entities: Array.from({ length: 16 }, (_, index) => ({
        type: 'bold',
        offset: index,
        length: 1,
      })),
      photo: Array.from({ length: 4 }, (_, index) => ({
        file_id: `photo-${index}`,
        file_unique_id: `unique-${index}`,
        width: 512,
        height: 512,
        file_size: 12_345,
      })),
    },
    allowedSenders: null,
    expectedChatType: 'private',
    requireMention: false,
    botId: 4_242,
    botUsernameLower: 'task106_test_bot',
    providerTarget: target,
    providerEventId: `telegram:${chatId}:${id}`,
  })!
  return {
    message,
    traceContext: mintChannelTraceContext(message),
    eventKey: `event-${id}`,
    streamKey: options.streamKey ?? 'chat-a',
    retryAt: 0,
    retryUsed: true,
  }
}

describe('Telegram admission retry queue', () => {
  it('enforces the exact event-count ceiling without evicting retained work', () => {
    const queue = new TelegramAdmissionRetryQueue()
    for (let index = 0; index < TELEGRAM_ADMISSION_RETRY_MAX_EVENTS; index += 1) {
      expect(queue.enqueue(pending(index, { streamKey: 'same-conversation' })).status).toBe(
        'retained'
      )
    }

    const before = queue.snapshot
    expect(before.events).toBe(TELEGRAM_ADMISSION_RETRY_MAX_EVENTS)
    expect(queue.enqueue(pending(TELEGRAM_ADMISSION_RETRY_MAX_EVENTS)).status).toBe('full')
    expect(queue.snapshot).toEqual(before)
    expect(queue.hasEvent('event-0')).toBe(true)
  })

  it('accounts 64 producer-shaped messages within the selected one-MiB budget', () => {
    const queue = new TelegramAdmissionRetryQueue()
    for (let index = 0; index < TELEGRAM_ADMISSION_RETRY_MAX_EVENTS; index += 1) {
      expect(
        queue.enqueue(
          pending(index, {
            streamKey: `chat-${index}`,
            content: 'x'.repeat(4_096),
          })
        ).status
      ).toBe('retained')
    }
    expect(queue.snapshot.events).toBe(64)
    expect(queue.snapshot.accountedBytes).toBeLessThan(TELEGRAM_ADMISSION_RETRY_MAX_ACCOUNTED_BYTES)
    expect(queue.snapshot.accountedBytes).toBeGreaterThan(queue.snapshot.events * 4_096)
  })

  it('retains the largest fitting producer payload and rejects the next byte', () => {
    const queue = new TelegramAdmissionRetryQueue()
    let low = 0
    let high = TELEGRAM_ADMISSION_RETRY_MAX_ACCOUNTED_BYTES
    let largestFitting: ReturnType<typeof pending> | undefined

    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      const candidate = pending(1, { content: 'x'.repeat(middle) })
      const bytes = accountedTelegramAdmissionRetryBytes({
        ...candidate,
        inFlight: false,
        rescheduled: false,
      })?.bytes
      if (bytes === undefined || bytes > TELEGRAM_ADMISSION_RETRY_MAX_ACCOUNTED_BYTES) {
        high = middle - 1
      } else {
        largestFitting = candidate
        low = middle + 1
      }
    }

    expect(largestFitting).toBeDefined()
    expect(queue.enqueue(largestFitting!).status).toBe('retained')
    expect(queue.snapshot.accountedBytes).toBeLessThanOrEqual(
      TELEGRAM_ADMISSION_RETRY_MAX_ACCOUNTED_BYTES
    )
    const nextPayload = pending(2, { content: `${largestFitting!.message.content}x` })
    expect(
      accountedTelegramAdmissionRetryBytes({
        ...nextPayload,
        inFlight: false,
        rescheduled: false,
      })!.bytes
    ).toBeGreaterThan(TELEGRAM_ADMISSION_RETRY_MAX_ACCOUNTED_BYTES)
    expect(queue.enqueue(nextPayload).status).toBe('full')
    expect(queue.snapshot.events).toBe(1)
    expect(queue.hasEvent('event-1')).toBe(true)
  })

  it('preserves FIFO and round-robin fairness across generated stream interleavings', () => {
    let randomState = 0x66_01
    const nextRandom = (maximum: number): number => {
      randomState = (randomState * 1_103_515_245 + 12_345) >>> 0
      return randomState % maximum
    }

    for (let trial = 0; trial < 32; trial += 1) {
      const remaining = Array.from({ length: 8 }, (_, streamIndex) =>
        Array.from({ length: 8 }, (_, sequence) => ({
          id: trial * 1_000 + streamIndex * 8 + sequence,
          streamKey: `trial-${trial}-chat-${streamIndex}`,
        }))
      )
      const interleaving: Array<{ id: number; streamKey: string }> = []
      while (remaining.some(stream => stream.length > 0)) {
        const eligible = remaining.flatMap((stream, index) => (stream.length ? [index] : []))
        interleaving.push(remaining[eligible[nextRandom(eligible.length)]]!.shift()!)
      }

      const queue = new TelegramAdmissionRetryQueue()
      const expectedByStream = new Map<string, number[]>()
      for (const value of interleaving) {
        const result = queue.enqueue(pending(value.id, { streamKey: value.streamKey }))
        expect(result.status).toBe('retained')
        const expected = expectedByStream.get(value.streamKey) ?? []
        expected.push(value.id)
        expectedByStream.set(value.streamKey, expected)
      }

      const dispatchedByStream = new Map<string, number[]>()
      const dispatchStreamOrder: string[] = []
      while (queue.snapshot.events > 0) {
        const entry = queue.takeDue(0)
        expect(entry).not.toBeNull()
        if (!entry) break
        const dispatched = dispatchedByStream.get(entry.streamKey) ?? []
        dispatched.push(Number(entry.eventKey.slice('event-'.length)))
        dispatchedByStream.set(entry.streamKey, dispatched)
        dispatchStreamOrder.push(entry.streamKey)
        queue.finish(entry, 0)
      }

      expect(dispatchedByStream).toEqual(expectedByStream)
      expect(new Set(dispatchStreamOrder).size).toBe(8)
      for (let prefix = 1; prefix <= 32; prefix += 1) {
        const counts = new Map<string, number>()
        for (const streamKey of dispatchStreamOrder.slice(0, prefix)) {
          counts.set(streamKey, (counts.get(streamKey) ?? 0) + 1)
        }
        const values = [...counts.values()]
        expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(1)
      }
    }
  })

  it('deduplicates retained event keys and clears volatile work on shutdown', () => {
    const queue = new TelegramAdmissionRetryQueue()
    const first = queue.enqueue(pending(1))
    expect(first.status).toBe('retained')
    const duplicate = queue.enqueue(pending(1))
    expect(duplicate.status).toBe('duplicate')
    expect(queue.snapshot.events).toBe(1)
    expect(queue.clear()).toMatchObject({ events: 1, streams: 1 })
    expect(queue.snapshot).toEqual({ events: 0, accountedBytes: 0, streams: 0 })
  })
})
