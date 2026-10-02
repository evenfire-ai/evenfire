import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ENTITY_CHANGE_STREAM_IDLE_TIMEOUT_MS,
  watchEntityChangeStreamLiveness,
} from '../entityChangeStreamLiveness'

describe('watchEntityChangeStreamLiveness', () => {
  afterEach(() => vi.useRealTimers())

  it('resets on each received frame and reconnects once when the stream goes idle', () => {
    vi.useFakeTimers()
    const onIdle = vi.fn()
    const liveness = watchEntityChangeStreamLiveness(onIdle)

    vi.advanceTimersByTime(ENTITY_CHANGE_STREAM_IDLE_TIMEOUT_MS - 1)
    liveness.receivedFrame()
    vi.advanceTimersByTime(ENTITY_CHANGE_STREAM_IDLE_TIMEOUT_MS - 1)
    expect(onIdle).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(onIdle).toHaveBeenCalledOnce()
    liveness.receivedFrame()
    vi.advanceTimersByTime(ENTITY_CHANGE_STREAM_IDLE_TIMEOUT_MS)
    expect(onIdle).toHaveBeenCalledOnce()
  })

  it('clears the pending timeout when the consumer stops', () => {
    vi.useFakeTimers()
    const onIdle = vi.fn()
    const liveness = watchEntityChangeStreamLiveness(onIdle)
    liveness.dispose()

    vi.advanceTimersByTime(ENTITY_CHANGE_STREAM_IDLE_TIMEOUT_MS)
    expect(onIdle).not.toHaveBeenCalled()
  })
})
