// @vitest-environment jsdom
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { CHAT_DRAWER_DEFAULT_WIDTH, useChatDrawerResize } from '../useChatDrawerResize'

// Re-entrant drag leak: a second mousedown during an active drag used to
// overwrite `endDragRef.current` without ending the first drag. The first
// drag's teardown then hit its own `endDragRef.current !== endDrag` guard and
// could never remove its `onMove` — leaving it pinned to `window` forever. From
// then on a bare `mousemove` (no button, isResizing false) resized the drawer.
// A right-click on the 8px strip while the left button is held triggers the
// double entry. This pins the fix: a stray mousemove after the interaction must
// NOT resize the drawer.

function mousedown(result: ReturnType<typeof renderHook>['result'], clientX: number) {
  const event = {
    button: 0,
    clientX,
    preventDefault: vi.fn(),
    currentTarget: { closest: () => null },
  } as unknown as React.MouseEvent<HTMLElement>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  act(() => (result.current as any).onResizeHandleMouseDown(event))
}

describe('useChatDrawerResize re-entrant drag leak', () => {
  beforeEach(() => {
    // Run rAF synchronously so a leaked onMove's apply() (which schedules via
    // requestAnimationFrame) is observable within the same act().
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0)
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', () => {})
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not resize on a bare mousemove after a re-entrant mousedown + mouseup', () => {
    const ref = createRef<HTMLElement>()
    const { result } = renderHook(() => useChatDrawerResize(ref, true))
    expect(result.current.width).toBe(CHAT_DRAWER_DEFAULT_WIDTH) // 420

    // Drag #1 starts.
    mousedown(result, 500)
    expect(result.current.isResizing).toBe(true)

    // Second mousedown while drag #1 is still live (the right-click-strip
    // re-entry). Must end drag #1, never orphan its onMove.
    mousedown(result, 500)

    // Release the button.
    act(() => window.dispatchEvent(new MouseEvent('mouseup')))
    expect(result.current.isResizing).toBe(false)

    const settledWidth = result.current.width

    // A stray mousemove with no drag in progress must NOT resize the drawer.
    act(() => window.dispatchEvent(new MouseEvent('mousemove', { clientX: 50 })))
    expect(result.current.width).toBe(settledWidth)
    expect(result.current.isResizing).toBe(false)
  })

  // L1: the `if (event.button !== 0) return` guard on the mousedown handler had
  // no direct coverage — the reentry test above fires `button: 0` on both
  // mousedowns, so an inverted or deleted guard stayed green there. A right-click
  // over the 8px strip while the left button is held (button 2) must be a no-op:
  // it must not start/alter a drag, and no stray resize may follow the release.
  it('ignores a non-left mousedown during an active drag and starts no second drag', () => {
    const ref = createRef<HTMLElement>()
    const { result } = renderHook(() => useChatDrawerResize(ref, true))

    // Left button starts drag #1.
    const leftPreventDefault = vi.fn()
    act(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (result.current as any).onResizeHandleMouseDown({
        button: 0,
        clientX: 500,
        preventDefault: leftPreventDefault,
        currentTarget: { closest: () => null },
      } as unknown as React.MouseEvent<HTMLElement>)
    )
    // Inverted guard (`=== 0`) would ignore this and never start the drag.
    expect(result.current.isResizing).toBe(true)
    expect(leftPreventDefault).toHaveBeenCalledTimes(1)

    // Right button (button 2) mousedown WHILE drag #1 is live. The guard returns
    // before touching anything — no preventDefault, drag #1 untouched.
    const rightPreventDefault = vi.fn()
    act(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (result.current as any).onResizeHandleMouseDown({
        button: 2,
        clientX: 50,
        preventDefault: rightPreventDefault,
        currentTarget: { closest: () => null },
      } as unknown as React.MouseEvent<HTMLElement>)
    )
    // A deleted guard would let this proceed and call preventDefault.
    expect(rightPreventDefault).not.toHaveBeenCalled()
    // Drag #1 is still the one and only active drag.
    expect(result.current.isResizing).toBe(true)

    // Release drag #1.
    act(() => window.dispatchEvent(new MouseEvent('mouseup')))
    expect(result.current.isResizing).toBe(false)
    const settledWidth = result.current.width

    // The button-2 mousedown installed no second, orphanable drag: a bare
    // mousemove after release must not resize.
    act(() => window.dispatchEvent(new MouseEvent('mousemove', { clientX: 10 })))
    expect(result.current.width).toBe(settledWidth)
    expect(result.current.isResizing).toBe(false)
  })
})
