import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  MAX_HEARTBEAT_INTERVAL_MS,
  startSseHeartbeat,
} from '../src/sseHeartbeat.js'

const architectureDoc = new URL(
  '../../docs/architecture/grok-subscription-transport-contract.md',
  import.meta.url
)

describe('heartbeat interval documentation', () => {
  it('states the default and the maximum interval config accepts', () => {
    const doc = readFileSync(architectureDoc, 'utf8')
    const stated = /`GROK_LLM_PROXY_HEARTBEAT_INTERVAL_MS`\s+\(default (\d+), at most (\d+)\)/.exec(
      doc
    )
    expect(stated, 'the doc must state the heartbeat default and maximum').not.toBeNull()
    expect({ default: Number(stated![1]), max: Number(stated![2]) }).toEqual({
      default: DEFAULT_HEARTBEAT_INTERVAL_MS,
      max: MAX_HEARTBEAT_INTERVAL_MS,
    })
  })
})

class FakeResponse extends EventEmitter {
  readonly writes: string[] = []
  writableEnded = false
  destroyed = false
  write(chunk: string): boolean {
    this.writes.push(chunk)
    return true
  }
}

describe('startSseHeartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('writes one SSE comment per interval, first at +interval, and counts each', () => {
    const res = new FakeResponse()
    const beats: number[] = []
    const stop = startSseHeartbeat(res, new AbortController().signal, 1_000, () => beats.push(1))

    vi.advanceTimersByTime(999)
    expect(res.writes).toEqual([])
    vi.advanceTimersByTime(1)
    expect(res.writes).toEqual([': keepalive\n\n'])
    vi.advanceTimersByTime(2_000)
    expect(res.writes).toHaveLength(3)
    expect(beats).toHaveLength(3)
    stop()
  })

  it('never writes after stop, and never waits on drain', () => {
    const res = new FakeResponse()
    const stop = startSseHeartbeat(res, new AbortController().signal, 1_000, () => {})
    vi.advanceTimersByTime(1_000)
    // Witness: the heartbeat was running before stop.
    expect(res.writes).toHaveLength(1)
    stop()
    vi.advanceTimersByTime(10_000)
    expect(res.writes).toHaveLength(1)
    expect(res.listenerCount('drain')).toBe(0)
  })

  it.each([
    [
      'the response already ended',
      (res: FakeResponse): void => {
        res.writableEnded = true
      },
    ],
    [
      'the socket was destroyed',
      (res: FakeResponse): void => {
        res.destroyed = true
      },
    ],
  ] as const)('skips the write when %s', (_case, close) => {
    const res = new FakeResponse()
    const stop = startSseHeartbeat(res, new AbortController().signal, 1_000, () => {})
    vi.advanceTimersByTime(1_000)
    // Witness: the tick runs and writes while the response is open.
    expect(res.writes).toHaveLength(1)
    close(res)
    vi.advanceTimersByTime(3_000)
    expect(res.writes).toHaveLength(1)
    stop()
  })

  it('skips the write once the attempt signal aborted', () => {
    const res = new FakeResponse()
    const abort = new AbortController()
    const stop = startSseHeartbeat(res, abort.signal, 1_000, () => {})
    vi.advanceTimersByTime(1_000)
    expect(res.writes).toHaveLength(1)
    abort.abort()
    vi.advanceTimersByTime(3_000)
    expect(res.writes).toHaveLength(1)
    stop()
  })

  it('rejects an interval that is not a positive integer', () => {
    const res = new FakeResponse()
    for (const interval of [0, -1, 1.5, Number.NaN]) {
      expect(() => startSseHeartbeat(res, new AbortController().signal, interval, () => {})).toThrow(
        /heartbeat interval must be a positive integer/
      )
    }
  })
})
