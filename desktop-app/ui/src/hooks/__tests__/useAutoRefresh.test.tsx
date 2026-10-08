// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { focusManager } from '@tanstack/react-query'
import { act, cleanup, renderHook } from '@testing-library/react'
import { AUTO_REFRESH_POLL_INTERVAL_MS, AUTO_REFRESH_STALE_AFTER_MS } from '@constants/autoRefresh'
import { useAutoRefresh } from '../useAutoRefresh'
import type { AutoRefreshOptions } from '../useAutoRefresh.types'

/**
 * One refresh scheduler for every surface that shows the connectors catalog
 * (#991 follow-up). The deadline is anchored to a run's START, so a slow reply
 * never pushes the next poll out; at most one run is in flight, and focus /
 * manual refreshes join it instead of stacking a second request.
 */

const POLL = AUTO_REFRESH_POLL_INTERVAL_MS
const STALE = AUTO_REFRESH_STALE_AFTER_MS

type Deferred = { resolve: () => void }

/** A refresh whose replies are released by the test, counting concurrency. */
function controlledRefresh() {
  const pending: Deferred[] = []
  let inFlight = 0
  let maxInFlight = 0
  const refresh = vi.fn(
    () =>
      new Promise<void>(resolve => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        pending.push({
          resolve: () => {
            inFlight -= 1
            resolve()
          },
        })
      })
  )
  return {
    refresh,
    releaseNext: async () => {
      await act(async () => {
        pending.shift()?.resolve()
      })
    },
    get maxInFlight() {
      return maxInFlight
    },
  }
}

/** A refresh that replies after `delayMs` of (fake) time. */
function delayedRefresh(delayMs: number) {
  return vi.fn(() => new Promise<void>(resolve => window.setTimeout(resolve, delayMs)))
}

function renderAutoRefresh(initial: AutoRefreshOptions) {
  return renderHook((options: AutoRefreshOptions) => useAutoRefresh(options), {
    initialProps: initial,
  })
}

const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

describe('useAutoRefresh', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
    focusManager.setFocused(undefined)
  })

  it('refreshes on enable when stale and polls from the START of that run', async () => {
    // Initial reply takes 100ms. A completion-anchored poll would fire at
    // 60_100 (or skip, seeing data only 59_900ms old); the start-anchored one
    // fires at exactly 60_000.
    const refresh = delayedRefresh(100)
    renderAutoRefresh({ enabled: true, refresh, isStale: () => true })
    expect(refresh).toHaveBeenCalledTimes(1)

    await advance(POLL - 1)
    expect(refresh).toHaveBeenCalledTimes(1)
    await advance(1)
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('polls even when the cache still looks fresh at the deadline', async () => {
    const refresh = vi.fn(async () => undefined)
    renderAutoRefresh({ enabled: true, refresh, isStale: () => false })
    await advance(0)
    expect(refresh).not.toHaveBeenCalled()

    await advance(POLL)
    expect(refresh).toHaveBeenCalledTimes(1)
    await advance(POLL)
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('passes the staleness window to isStale on enable', async () => {
    const isStale = vi.fn(() => false)
    renderAutoRefresh({ enabled: true, refresh: vi.fn(async () => undefined), isStale })
    expect(isStale).toHaveBeenCalledWith(STALE)
  })

  it('a reply crossing the deadline never overlaps: next run at completion, then deadline cadence', async () => {
    const refresh = delayedRefresh(70_000)
    let inFlight = 0
    let maxInFlight = 0
    const tracked = vi.fn(async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      try {
        await refresh()
      } finally {
        inFlight -= 1
      }
    })
    renderAutoRefresh({ enabled: true, refresh: tracked, isStale: () => true })
    expect(tracked).toHaveBeenCalledTimes(1)

    // The 60s deadline passes while the first run is still in flight.
    await advance(POLL)
    expect(tracked).toHaveBeenCalledTimes(1)

    // It completes at 70s; the missed deadline runs once, immediately.
    await advance(70_000 - POLL)
    expect(tracked).toHaveBeenCalledTimes(2)

    // That run started at 70s → its deadline is 130s (it is still in flight
    // then, since it takes 70s), so the third run starts on completion at 140s.
    await advance(69_999)
    expect(tracked).toHaveBeenCalledTimes(2)
    await advance(1)
    expect(tracked).toHaveBeenCalledTimes(3)
    expect(maxInFlight).toBe(1)
  })

  it('a reply crossing the deadline resumes the deadline cadence once replies are fast again', async () => {
    let call = 0
    const refresh = vi.fn(
      () =>
        new Promise<void>(resolve => {
          call += 1
          window.setTimeout(resolve, call === 1 ? 70_000 : 10)
        })
    )
    renderAutoRefresh({ enabled: true, refresh, isStale: () => true })
    await advance(70_000)
    // Second run started at 70s on completion of the first.
    expect(refresh).toHaveBeenCalledTimes(2)
    await advance(POLL - 1)
    expect(refresh).toHaveBeenCalledTimes(2)
    await advance(1)
    expect(refresh).toHaveBeenCalledTimes(3)
  })

  it('focus and manual refresh overlapping an in-flight run join it (one fetch)', async () => {
    const ctl = controlledRefresh()
    focusManager.setFocused(false)
    const { result } = renderAutoRefresh({
      enabled: true,
      refresh: ctl.refresh,
      isStale: () => true,
    })
    expect(ctl.refresh).toHaveBeenCalledTimes(1)

    let manualSettled = false
    await act(async () => {
      focusManager.setFocused(true)
      void result.current.refreshNow().then(() => {
        manualSettled = true
      })
    })
    expect(ctl.refresh).toHaveBeenCalledTimes(1)
    expect(manualSettled).toBe(false)

    await ctl.releaseNext()
    expect(manualSettled).toBe(true)
    expect(ctl.refresh).toHaveBeenCalledTimes(1)
    expect(ctl.maxInFlight).toBe(1)
  })

  it('a focus refresh when stale resets the poll deadline', async () => {
    const refresh = vi.fn(async () => undefined)
    let stale = false
    focusManager.setFocused(false)
    renderAutoRefresh({ enabled: true, refresh, isStale: () => stale })

    await advance(40_000)
    stale = true
    await act(async () => {
      focusManager.setFocused(true)
    })
    expect(refresh).toHaveBeenCalledTimes(1)

    // The original deadline (60s) no longer fires; the next one is 40s + 60s.
    stale = false
    await advance(POLL - 1)
    expect(refresh).toHaveBeenCalledTimes(1)
    await advance(1)
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('focus does not refresh when the cache is fresh', async () => {
    const refresh = vi.fn(async () => undefined)
    focusManager.setFocused(false)
    renderAutoRefresh({ enabled: true, refresh, isStale: () => false })
    await act(async () => {
      focusManager.setFocused(true)
    })
    expect(refresh).not.toHaveBeenCalled()
  })

  it('a manual refresh runs even when fresh and resets the poll deadline', async () => {
    const refresh = vi.fn(async () => undefined)
    const { result } = renderAutoRefresh({ enabled: true, refresh, isStale: () => false })

    await advance(30_000)
    await act(async () => {
      await result.current.refreshNow()
    })
    expect(refresh).toHaveBeenCalledTimes(1)

    await advance(POLL - 1)
    expect(refresh).toHaveBeenCalledTimes(1)
    await advance(1)
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('disabled: no initial refresh, no timer, no focus listener', async () => {
    const refresh = vi.fn(async () => undefined)
    focusManager.setFocused(false)
    renderAutoRefresh({ enabled: false, refresh, isStale: () => true })
    expect(vi.getTimerCount()).toBe(0)

    await act(async () => {
      focusManager.setFocused(true)
    })
    await advance(POLL * 3)
    expect(refresh).not.toHaveBeenCalled()
  })

  it('disabling stops the poll and a completion afterwards does not re-arm it', async () => {
    const ctl = controlledRefresh()
    const { rerender } = renderAutoRefresh({
      enabled: true,
      refresh: ctl.refresh,
      isStale: () => true,
    })
    expect(ctl.refresh).toHaveBeenCalledTimes(1)

    rerender({ enabled: false, refresh: ctl.refresh, isStale: () => true })
    await ctl.releaseNext()
    expect(vi.getTimerCount()).toBe(0)
    await advance(POLL * 3)
    expect(ctl.refresh).toHaveBeenCalledTimes(1)
  })

  it('unmount clears the timer and the focus subscription', async () => {
    const refresh = vi.fn(async () => undefined)
    focusManager.setFocused(false)
    const { unmount } = renderAutoRefresh({ enabled: true, refresh, isStale: () => false })
    expect(vi.getTimerCount()).toBe(1)

    unmount()
    expect(vi.getTimerCount()).toBe(0)
    await act(async () => {
      focusManager.setFocused(true)
    })
    await advance(POLL * 3)
    expect(refresh).not.toHaveBeenCalled()
  })

  it('a new refresh/isStale identity on rerender neither refetches nor moves the deadline', async () => {
    const first = vi.fn(async () => undefined)
    const { rerender } = renderAutoRefresh({ enabled: true, refresh: first, isStale: () => true })
    expect(first).toHaveBeenCalledTimes(1)

    await advance(30_000)
    const second = vi.fn(async () => undefined)
    rerender({ enabled: true, refresh: second, isStale: () => true })
    rerender({ enabled: true, refresh: second, isStale: () => true })
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()

    // The deadline set by the first run (60s) still holds, and uses the
    // latest refresh.
    await advance(POLL - 30_000)
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).toHaveBeenCalledTimes(1)
  })

  it('a rejected refresh does not break the chain', async () => {
    const refresh = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(undefined)
    renderAutoRefresh({ enabled: true, refresh, isStale: () => true })
    await advance(POLL)
    expect(refresh).toHaveBeenCalledTimes(2)
  })
})
