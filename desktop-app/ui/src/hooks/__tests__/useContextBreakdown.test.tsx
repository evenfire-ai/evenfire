// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ContextBreakdownLite } from '../useChatStore'
import { useContextBreakdown } from '../useContextBreakdown'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const sampleBreakdown: ContextBreakdownLite = {
  buckets: { messages: 537, systemTools: 306, metaContext: 115, systemPrompt: 17 },
  totalInputTokens: 32_900,
  maxTokens: 100_000,
  fillRatio: 0.329,
  capturedAtTurn: 4,
}

function installClerum(getContextBreakdown: ReturnType<typeof vi.fn>) {
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    writable: true,
    value: { rpc: { getContextBreakdown } },
  })
}

afterEach(() => {
  delete (window as { clerum?: unknown }).clerum
  vi.useRealTimers()
})

describe('useContextBreakdown', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  it('is on-demand: nothing is fetched until fetchContextBreakdown is called', () => {
    const getContextBreakdown = vi.fn(async () => ({ breakdown: sampleBreakdown }))
    installClerum(getContextBreakdown)

    const { result } = renderHook(() => useContextBreakdown())

    expect(getContextBreakdown).not.toHaveBeenCalled()
    expect(result.current.getBreakdown('trader', 'c1')).toBeUndefined()
  })

  it('populates breakdownByTaskKey on fetch, keyed by (agentRef, chatId)', async () => {
    const getContextBreakdown = vi.fn(async () => ({ breakdown: sampleBreakdown }))
    installClerum(getContextBreakdown)

    const { result } = renderHook(() => useContextBreakdown())

    await act(async () => {
      await result.current.fetchContextBreakdown('trader', 'c1')
    })

    // agent is used as BOTH hostRef and agent (mirrors loadSessionMessages).
    expect(getContextBreakdown).toHaveBeenCalledWith('trader', 'trader', 'c1')
    expect(result.current.getBreakdown('trader', 'c1')).toEqual(sampleBreakdown)
    // A different chat remains untouched.
    expect(result.current.getBreakdown('trader', 'c2')).toBeUndefined()
  })

  it('stores null when the session has no snapshot', async () => {
    const getContextBreakdown = vi.fn(async () => ({ breakdown: null }))
    installClerum(getContextBreakdown)

    const { result } = renderHook(() => useContextBreakdown())

    await act(async () => {
      await result.current.fetchContextBreakdown('trader', 'c1')
    })

    expect(result.current.getBreakdown('trader', 'c1')).toBeNull()
  })

  it('de-dups a fresh result within the TTL (no second network call on re-open)', async () => {
    const getContextBreakdown = vi.fn(async () => ({ breakdown: sampleBreakdown }))
    installClerum(getContextBreakdown)

    const { result } = renderHook(() => useContextBreakdown())

    await act(async () => {
      await result.current.fetchContextBreakdown('trader', 'c1')
    })
    await act(async () => {
      await result.current.fetchContextBreakdown('trader', 'c1')
    })

    expect(getContextBreakdown).toHaveBeenCalledTimes(1)
  })

  it('refetches once the TTL has elapsed (stale-closure guard)', async () => {
    vi.useFakeTimers()
    const getContextBreakdown = vi.fn(async () => ({ breakdown: sampleBreakdown }))
    installClerum(getContextBreakdown)

    const { result } = renderHook(() => useContextBreakdown())

    await act(async () => {
      await result.current.fetchContextBreakdown('trader', 'c1')
    })
    expect(getContextBreakdown).toHaveBeenCalledTimes(1)

    // Advance well past BREAKDOWN_TTL_MS (15s) so the cached entry is stale.
    await act(async () => {
      vi.advanceTimersByTime(20_000)
      await result.current.fetchContextBreakdown('trader', 'c1')
    })
    expect(getContextBreakdown).toHaveBeenCalledTimes(2)
  })

  it('force bypasses the fresh/TTL short-circuit and re-probes immediately', async () => {
    const getContextBreakdown = vi.fn(async () => ({ breakdown: sampleBreakdown }))
    installClerum(getContextBreakdown)

    const { result } = renderHook(() => useContextBreakdown())

    await act(async () => {
      await result.current.fetchContextBreakdown('trader', 'c1')
    })
    expect(getContextBreakdown).toHaveBeenCalledTimes(1)

    // A normal call within the TTL is de-duped by the fresh short-circuit...
    await act(async () => {
      await result.current.fetchContextBreakdown('trader', 'c1')
    })
    expect(getContextBreakdown).toHaveBeenCalledTimes(1)

    // ...but a forced call re-probes even though the cached entry is still fresh.
    await act(async () => {
      await result.current.fetchContextBreakdown('trader', 'c1', { force: true })
    })
    expect(getContextBreakdown).toHaveBeenCalledTimes(2)
  })

  it('never throws on a failed fetch — leaves the prior value in place', async () => {
    const getContextBreakdown = vi.fn(async () => {
      throw new Error('network unreachable')
    })
    installClerum(getContextBreakdown)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const { result } = renderHook(() => useContextBreakdown())

    await act(async () => {
      await result.current.fetchContextBreakdown('trader', 'c1')
    })

    expect(result.current.getBreakdown('trader', 'c1')).toBeUndefined()
    await waitFor(() => expect(result.current.isLoading('trader', 'c1')).toBe(false))
    warnSpy.mockRestore()
  })
})
