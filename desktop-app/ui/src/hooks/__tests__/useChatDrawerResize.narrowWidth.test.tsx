// @vitest-environment jsdom
import type { RefObject } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import {
  CHAT_DRAWER_DEFAULT_WIDTH,
  CHAT_DRAWER_MIN_PANEL_WIDTH,
  useChatDrawerResize,
} from '../useChatDrawerResize'

// Mini-spec 05: below CHAT_DRAWER_MIN_PANEL_WIDTH (846 = MIN 340 + GUTTER 46 +
// EMBED_FLOOR 460) the docked drawer can't coexist with the embed, so the hook
// reports `panelTooNarrow` and the caller suppresses it WITHOUT losing intent.
// And within the valid range, a transient narrowing must not permanently shrink
// the drawer — the requested width is restored on re-widen (absorbs L2).
//
// The panel width is driven through the REAL producer path: the hook's
// ResizeObserver callback (which IS its `sync`) re-reads the panel's clientWidth.
// A stubbed ResizeObserver captures that callback so the test can fire it after
// mutating the measured width, exactly as a window resize would at runtime.

type MutablePanel = { clientWidth: number }

function makeHarness(initialWidth: number) {
  const panel: MutablePanel = { clientWidth: initialWidth }
  const ref = { current: panel } as unknown as RefObject<HTMLElement | null>
  let fire: () => void = () => {}
  vi.stubGlobal(
    'ResizeObserver',
    class {
      private cb: () => void
      constructor(cb: () => void) {
        this.cb = cb
        fire = () => cb()
      }
      observe() {}
      disconnect() {}
    }
  )
  const resizeTo = (next: number) => {
    panel.clientWidth = next
    act(() => fire())
  }
  return { ref, resizeTo }
}

describe('useChatDrawerResize narrow-width suppression', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('reports panelTooNarrow just below the threshold and not at it', () => {
    const { ref, resizeTo } = makeHarness(2000)
    const { result } = renderHook(() => useChatDrawerResize(ref, true))
    expect(result.current.panelTooNarrow).toBe(false)

    // One pixel below the threshold: suppressed.
    resizeTo(CHAT_DRAWER_MIN_PANEL_WIDTH - 1) // 845
    expect(result.current.panelTooNarrow).toBe(true)

    // Exactly at the threshold: visible again.
    resizeTo(CHAT_DRAWER_MIN_PANEL_WIDTH) // 846
    expect(result.current.panelTooNarrow).toBe(false)
  })

  it('never reports panelTooNarrow while the panel is unmeasured (0, e.g. mount)', () => {
    const { ref } = makeHarness(0)
    const { result } = renderHook(() => useChatDrawerResize(ref, true))
    // clientWidth 0 must NOT count as "too narrow" — that would flash-suppress the
    // drawer on mount before the first real measurement.
    expect(result.current.panelTooNarrow).toBe(false)
  })
})

describe('useChatDrawerResize width restore on re-widen (L2)', () => {
  beforeEach(() => {
    // Run rAF synchronously so a drag's apply() is observable within act().
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0)
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', () => {})
  })
  afterEach(() => vi.unstubAllGlobals())

  it('restores the requested width after a transient narrowing', () => {
    const { ref, resizeTo } = makeHarness(2000)
    const { result } = renderHook(() => useChatDrawerResize(ref, true))
    expect(result.current.width).toBe(CHAT_DRAWER_DEFAULT_WIDTH) // 420

    // Drag the drawer to a requested 600px on the wide panel. The right edge
    // falls back to window.innerWidth - 18 (jsdom innerWidth = 1024 → 1006), so a
    // pointer at 406 requests 1006 - 406 = 600.
    act(() =>
      result.current.onResizeHandleMouseDown({
        button: 0,
        clientX: 1006,
        preventDefault: vi.fn(),
        currentTarget: { closest: () => null },
      } as unknown as React.MouseEvent<HTMLElement>)
    )
    act(() => window.dispatchEvent(new MouseEvent('mousemove', { clientX: 406 })))
    act(() => window.dispatchEvent(new MouseEvent('mouseup')))
    expect(result.current.width).toBe(600)

    // Narrow the panel within the valid range: the applied width re-clamps DOWN
    // to preserve the embed floor (1000 - 506 = 494) but stays visible.
    resizeTo(1000)
    expect(result.current.panelTooNarrow).toBe(false)
    expect(result.current.width).toBe(494)

    // Re-widen: the drawer must return to the 600 the user requested, not stay at
    // the transient minimum (the L2 bug: it used to stick at 494 forever).
    resizeTo(2000)
    expect(result.current.width).toBe(600)
  })
})
