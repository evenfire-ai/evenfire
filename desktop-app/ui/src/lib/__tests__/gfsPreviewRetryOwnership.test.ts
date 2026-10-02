// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { retireClosedGfsPreviewOwners } from '../gfsPreviewRetryOwnership'

describe('retireClosedGfsPreviewOwners', () => {
  afterEach(() => vi.useRealTimers())

  it('cancels retry and invalidates pending refresh only for the closed final owner', () => {
    vi.useFakeTimers()
    const closedUri = 'gfs://main/closed'
    const openUri = 'gfs://main/open'
    const previousOwners = new Set([closedUri, openUri])
    const retryTimers = new Map<string, number>()
    const retryAttempts = new Map([
      [closedUri, 2],
      [openUri, 1],
    ])
    const refreshGenerations = new Map([
      [closedUri, 4],
      [openUri, 9],
    ])
    const closedRetry = vi.fn()
    const openRetry = vi.fn()
    retryTimers.set(closedUri, window.setTimeout(closedRetry, 5000))
    retryTimers.set(openUri, window.setTimeout(openRetry, 5000))

    retireClosedGfsPreviewOwners(
      previousOwners,
      new Set([openUri]),
      retryTimers,
      retryAttempts,
      refreshGenerations,
      timer => window.clearTimeout(timer)
    )
    vi.advanceTimersByTime(5000)

    expect(closedRetry).not.toHaveBeenCalled()
    expect(openRetry).toHaveBeenCalledOnce()
    expect(retryTimers.has(closedUri)).toBe(false)
    expect(retryAttempts.has(closedUri)).toBe(false)
    expect(refreshGenerations.get(closedUri)).toBe(5)
    expect(previousOwners).toEqual(new Set([openUri]))
  })
})
