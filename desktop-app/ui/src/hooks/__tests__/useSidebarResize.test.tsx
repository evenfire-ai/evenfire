// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampSidebarWidth,
  getSidebarMaxWidth,
  getVisibleSidebarWidth,
  useSidebarResize,
} from '../useSidebarResize'

function SidebarResizeHandle() {
  const resize = useSidebarResize()
  return (
    <div
      aria-label="Resize sidebar"
      aria-valuemax={resize.maxWidth}
      aria-valuemin={SIDEBAR_MIN_WIDTH}
      aria-valuenow={resize.width}
      onKeyDown={resize.onKeyDown}
      onLostPointerCapture={resize.onLostPointerCapture}
      onPointerCancel={resize.onPointerCancel}
      onPointerDown={resize.onPointerDown}
      onPointerMove={resize.onPointerMove}
      onPointerUp={resize.onPointerUp}
      role="separator"
      tabIndex={0}
    />
  )
}

class TestPointerEvent extends MouseEvent {
  pointerId: number
  isPrimary: boolean

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init)
    this.pointerId = init.pointerId ?? 0
    this.isPrimary = init.isPrimary ?? true
  }
}

describe('sidebar width rules', () => {
  it.each([
    [-100, SIDEBAR_MIN_WIDTH],
    [SIDEBAR_MIN_WIDTH, SIDEBAR_MIN_WIDTH],
    [SIDEBAR_DEFAULT_WIDTH, SIDEBAR_DEFAULT_WIDTH],
    [900, SIDEBAR_MAX_WIDTH],
  ])('clamps requested width %i to %i', (requested, expected) => {
    expect(clampSidebarWidth(requested)).toBe(expected)
  })

  it('preserves a preferred width while applying a live viewport cap', () => {
    expect(getSidebarMaxWidth(900)).toBe(440)
    expect(getVisibleSidebarWidth(460, 900)).toBe(440)
    expect(getVisibleSidebarWidth(460, 700)).toBe(240)
    expect(getVisibleSidebarWidth(460, 1200)).toBe(460)
  })
})

describe('useSidebarResize', () => {
  beforeEach(() => {
    vi.stubGlobal('innerWidth', 1200)
    vi.stubGlobal('PointerEvent', TestPointerEvent)
    Object.defineProperty(window, 'PointerEvent', {
      configurable: true,
      value: TestPointerEvent,
    })
    window.localStorage.clear()
  })

  afterEach(() => {
    cleanup()
    document.body.classList.remove('sidebar-resizing')
    vi.unstubAllGlobals()
  })

  it('captures pointer resizing, commits on release, and rolls back on cancellation', () => {
    const { container } = render(<SidebarResizeHandle />)
    const handle = container.querySelector('[role="separator"]') as HTMLElement
    const setPointerCapture = vi.fn()
    Object.defineProperty(handle, 'setPointerCapture', { value: setPointerCapture })

    fireEvent.pointerDown(handle, { button: 0, clientX: 100, pointerId: 3 })
    expect(setPointerCapture).toHaveBeenCalledWith(3)
    expect(document.body.classList.contains('sidebar-resizing')).toBe(true)
    fireEvent.pointerMove(handle, { clientX: 170, pointerId: 3 })
    expect(handle.getAttribute('aria-valuenow')).toBe('398')
    expect(window.localStorage.getItem('clerum.ui.sidebarWidth')).toBeNull()
    fireEvent.pointerCancel(handle, { pointerId: 3 })
    expect(handle.getAttribute('aria-valuenow')).toBe(String(SIDEBAR_DEFAULT_WIDTH))
    expect(window.localStorage.getItem('clerum.ui.sidebarWidth')).toBeNull()
    expect(document.body.classList.contains('sidebar-resizing')).toBe(false)

    fireEvent.pointerDown(handle, { button: 0, clientX: 100, pointerId: 4 })
    fireEvent.pointerMove(handle, { clientX: 170, pointerId: 4 })
    fireEvent.pointerUp(handle, { clientX: 170, pointerId: 4 })
    expect(window.localStorage.getItem('clerum.ui.sidebarWidth')).toBe('398')
    expect(handle.getAttribute('aria-valuenow')).toBe('398')
  })

  it('supports arrow, Home, and End resizing and clamps to the live window width', () => {
    render(<SidebarResizeHandle />)
    const handle = screen.getByRole('separator', { name: 'Resize sidebar' })

    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(handle.getAttribute('aria-valuenow')).toBe('352')
    fireEvent.keyDown(handle, { key: 'Home' })
    expect(handle.getAttribute('aria-valuenow')).toBe(String(SIDEBAR_MIN_WIDTH))
    fireEvent.keyDown(handle, { key: 'End' })
    expect(handle.getAttribute('aria-valuenow')).toBe(String(SIDEBAR_MAX_WIDTH))

    vi.stubGlobal('innerWidth', 900)
    fireEvent(window, new Event('resize'))
    expect(handle.getAttribute('aria-valuemax')).toBe('440')
    expect(handle.getAttribute('aria-valuenow')).toBe('440')
    expect(window.localStorage.getItem('clerum.ui.sidebarWidth')).toBe('460')
  })

  it('keeps keyboard commits within the current desktop maximum', () => {
    vi.stubGlobal('innerWidth', 760)
    render(<SidebarResizeHandle />)
    const handle = screen.getByRole('separator', { name: 'Resize sidebar' })

    expect(handle.getAttribute('aria-valuemax')).toBe('300')
    expect(handle.getAttribute('aria-valuenow')).toBe('300')
    fireEvent.keyDown(handle, { key: 'ArrowRight' })

    expect(handle.getAttribute('aria-valuenow')).toBe('300')
    expect(window.localStorage.getItem('clerum.ui.sidebarWidth')).toBe('300')

    vi.stubGlobal('innerWidth', 900)
    fireEvent(window, new Event('resize'))
    expect(handle.getAttribute('aria-valuenow')).toBe('300')
  })

  it('keeps pointer commits within the current desktop maximum', () => {
    vi.stubGlobal('innerWidth', 760)
    render(<SidebarResizeHandle />)
    const handle = screen.getByRole('separator', { name: 'Resize sidebar' })

    fireEvent.pointerDown(handle, { button: 0, clientX: 100, pointerId: 5 })
    fireEvent.pointerMove(handle, { clientX: 124, pointerId: 5 })
    expect(handle.getAttribute('aria-valuenow')).toBe('300')
    fireEvent.pointerUp(handle, { clientX: 124, pointerId: 5 })

    expect(window.localStorage.getItem('clerum.ui.sidebarWidth')).toBe('300')
    vi.stubGlobal('innerWidth', 900)
    fireEvent(window, new Event('resize'))
    expect(handle.getAttribute('aria-valuenow')).toBe('300')
  })

  it('uses a valid stored preference and ignores malformed storage', () => {
    window.localStorage.setItem('clerum.ui.sidebarWidth', '420')
    const { unmount } = render(<SidebarResizeHandle />)
    expect(screen.getByRole('separator').getAttribute('aria-valuenow')).toBe('420')

    unmount()
    window.localStorage.setItem('clerum.ui.sidebarWidth', 'nope')
    render(<SidebarResizeHandle />)
    expect(screen.getByRole('separator').getAttribute('aria-valuenow')).toBe(
      String(SIDEBAR_DEFAULT_WIDTH)
    )
  })
})
