import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { useSubscriptionCapabilities } from '../useSubscriptionCapabilities'

const load = vi.hoisted(() => vi.fn())

vi.mock('../../subscriptionCapabilities', () => ({
  loadSubscriptionCapabilities: load,
}))

beforeEach(() => {
  load.mockReset()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('useSubscriptionCapabilities', () => {
  it('loads safe provider flags and exposes explicit retry', async () => {
    load.mockResolvedValueOnce({
      providers: {
        'codex-subscription': { enabled: true },
        'grok-subscription': { enabled: false },
      },
    })
    const { result } = renderHook(() => useSubscriptionCapabilities())

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.capabilities?.providers['codex-subscription'].enabled).toBe(true)
    expect(result.current.capabilities?.providers['grok-subscription'].enabled).toBe(false)
    expect(result.current.error).toBeNull()

    load.mockResolvedValueOnce({
      providers: {
        'codex-subscription': { enabled: false },
        'grok-subscription': { enabled: true },
      },
    })
    act(() => result.current.retry())
    await waitFor(() =>
      expect(result.current.capabilities?.providers['grok-subscription'].enabled).toBe(true)
    )
    // Retry re-runs the load through the shared cache; it never forces a refresh.
    expect(load).toHaveBeenNthCalledWith(2, { signal: expect.any(AbortSignal) })
  })

  it('keeps a previously confirmed provider enabled during a transient failure', async () => {
    load.mockResolvedValueOnce({
      providers: {
        'codex-subscription': { enabled: true },
        'grok-subscription': { enabled: true },
      },
    })
    const { result } = renderHook(() => useSubscriptionCapabilities())
    await waitFor(() => expect(result.current.capabilities).not.toBeNull())

    load.mockRejectedValueOnce(Object.assign(new Error('Temporarily unavailable'), { status: 429 }))
    act(() => result.current.retry())
    await waitFor(() => expect(result.current.error).not.toBeNull())
    expect(result.current.capabilities?.providers['grok-subscription'].enabled).toBe(true)
  })

  it('does not probe until the consumer is enabled and cancels on disable', async () => {
    load.mockReturnValue(new Promise(() => undefined))
    const { rerender } = renderHook(({ enabled }) => useSubscriptionCapabilities({ enabled }), {
      initialProps: { enabled: false },
    })
    expect(load).not.toHaveBeenCalled()
    rerender({ enabled: true })
    expect(load).toHaveBeenCalledOnce()
    const signal = load.mock.calls[0][0].signal as AbortSignal
    rerender({ enabled: false })
    expect(signal.aborted).toBe(true)
  })

  it('limits automatic throttle recovery to one attempt and cancels it on unmount', async () => {
    vi.useFakeTimers()
    load.mockRejectedValue(
      Object.assign(new Error('Try again in 12 seconds.'), {
        status: 429,
        retryAtMs: Date.now() + 12_000,
      })
    )
    const { result, unmount } = renderHook(() => useSubscriptionCapabilities())
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.error?.status).toBe(429)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(load).toHaveBeenCalledTimes(2)
    unmount()
    expect((load.mock.calls[1][0].signal as AbortSignal).aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('does not automatically retry ordinary failures or deliver an unmounted result', async () => {
    vi.useFakeTimers()
    load.mockRejectedValueOnce(Object.assign(new Error('Unavailable'), { status: 503 }))
    const { result, unmount } = renderHook(() => useSubscriptionCapabilities())
    await act(async () => {
      await Promise.resolve()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(load).toHaveBeenCalledOnce()
    expect(result.current.error?.status).toBe(503)
    let resolve!: (value: unknown) => void
    load.mockReturnValueOnce(
      new Promise(onResolve => {
        resolve = onResolve
      })
    )
    act(() => result.current.retry())
    unmount()
    await act(async () => {
      resolve({
        providers: {
          'codex-subscription': { enabled: true },
          'grok-subscription': { enabled: true },
        },
      })
      await Promise.resolve()
    })
    expect(result.current.capabilities).toBeNull()
  })
})
