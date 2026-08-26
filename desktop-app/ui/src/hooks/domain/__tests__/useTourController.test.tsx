// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { TOUR_SEEN_STORAGE_KEY } from '../../../constants/tour'
import { useTourController } from '../useTourController'

const params = (overrides: Partial<Parameters<typeof useTourController>[0]> = {}) => ({
  isAuthenticated: true,
  catalogSettled: true,
  blockedByOtherModal: false,
  ...overrides,
})

beforeEach(() => {
  window.localStorage.clear()
  vi.useRealTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useTourController', () => {
  it('shows once for an authenticated user who has not seen it', () => {
    const { result } = renderHook(() => useTourController(params()))
    expect(result.current.visible).toBe(true)
  })

  it('never shows while signed out', () => {
    const { result } = renderHook(() => useTourController(params({ isAuthenticated: false })))
    expect(result.current.visible).toBe(false)
  })

  it('never shows again once the flag is set', () => {
    window.localStorage.setItem(TOUR_SEEN_STORAGE_KEY, 'true')
    const { result } = renderHook(() => useTourController(params()))
    expect(result.current.visible).toBe(false)
  })

  it('writes the flag on first paint, not on completion', () => {
    renderHook(() => useTourController(params()))
    // Painted once and already durable: a force-quit mid-tour does not earn a
    // second showing.
    expect(window.localStorage.getItem(TOUR_SEEN_STORAGE_KEY)).toBe('true')
  })

  it('uses exactly the documented key', () => {
    renderHook(() => useTourController(params()))
    expect(Object.keys(window.localStorage)).toContain('clerum.ui.tourSeen')
  })

  it('treats a throwing storage read as seen', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    try {
      const { result } = renderHook(() => useTourController(params()))
      expect(result.current.visible).toBe(false)
    } finally {
      getItem.mockRestore()
    }
  })

  it('still shows when the storage write throws, and does not crash', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    try {
      const { result } = renderHook(() => useTourController(params()))
      expect(result.current.visible).toBe(true)
    } finally {
      setItem.mockRestore()
    }
  })

  it('waits for the catalog, then opens when the grace elapses', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useTourController(params({ catalogSettled: false })))

    expect(result.current.visible).toBe(false)

    act(() => {
      vi.advanceTimersByTime(2_000)
    })

    expect(result.current.visible).toBe(true)
  })

  it('opens immediately once the catalog settles, without waiting out the grace', () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(props => useTourController(props), {
      initialProps: params({ catalogSettled: false }),
    })

    expect(result.current.visible).toBe(false)

    rerender(params({ catalogSettled: true }))

    expect(result.current.visible).toBe(true)
  })

  it('yields to another modal, and returns once it closes', () => {
    const { result, rerender } = renderHook(props => useTourController(props), {
      initialProps: params({ blockedByOtherModal: true }),
    })

    expect(result.current.visible).toBe(false)

    rerender(params({ blockedByOtherModal: false }))

    expect(result.current.visible).toBe(true)
  })

  it('stays closed after dismissal', () => {
    const { result } = renderHook(() => useTourController(params()))

    act(() => result.current.dismiss())

    expect(result.current.visible).toBe(false)
  })
})
