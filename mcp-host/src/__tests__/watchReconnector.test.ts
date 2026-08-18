import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WatchReconnector } from '../k8sClient.js'

describe('WatchReconnector', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  // The regression this class exists for: @kubernetes/client-node reports the
  // apiserver's routine watch timeout as done(null), NOT an error. Reconnecting
  // only on a truthy error left the watcher dead for the life of the pod.
  it('reconnects after a close that reported no error', async () => {
    const r = new WatchReconnector()
    const restart = vi.fn().mockResolvedValue(undefined)
    r.begin()
    r.connected()

    r.schedule('watch closed', restart)
    expect(restart).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1_000)
    expect(restart).toHaveBeenCalledTimes(1)
  })

  it('backs off exponentially up to the 30s ceiling while reconnects fail', async () => {
    const r = new WatchReconnector()
    const restart = vi.fn().mockRejectedValue(new Error('apiserver unreachable'))
    r.begin()

    r.schedule('watch closed', restart)
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 32_000]) {
      await vi.advanceTimersByTimeAsync(delay)
    }

    // 1s, 2s, 4s, 8s, 16s, then capped at 30s — never a hot loop.
    expect(restart).toHaveBeenCalledTimes(7)
  })

  it('resets the backoff once a watch is re-established', async () => {
    const r = new WatchReconnector()
    const restart = vi.fn().mockResolvedValue(undefined)
    r.begin()

    r.schedule('watch closed', restart)
    await vi.advanceTimersByTimeAsync(1_000)
    r.schedule('watch closed', restart)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(restart).toHaveBeenCalledTimes(2)

    // A successful (re)connection puts the next close back on the 1s floor.
    r.connected()
    r.schedule('watch closed', restart)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(restart).toHaveBeenCalledTimes(3)
  })

  it('does not reconnect after cancel()', async () => {
    const r = new WatchReconnector()
    const restart = vi.fn().mockResolvedValue(undefined)
    r.begin()

    r.schedule('watch closed', restart)
    r.cancel()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(restart).not.toHaveBeenCalled()
  })

  it('ignores a schedule() issued after cancel()', async () => {
    const r = new WatchReconnector()
    const restart = vi.fn().mockResolvedValue(undefined)
    r.begin()
    r.cancel()

    r.schedule('watch closed', restart)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(restart).not.toHaveBeenCalled()
  })

  it('collapses concurrent schedules into one pending reconnect', async () => {
    const r = new WatchReconnector()
    const restart = vi.fn().mockResolvedValue(undefined)
    r.begin()

    r.schedule('watch closed', restart)
    r.schedule('watch closed', restart)
    r.schedule('watch closed', restart)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(restart).toHaveBeenCalledTimes(1)
  })
})
