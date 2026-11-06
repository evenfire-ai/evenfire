// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampSidebarWidth,
  getSidebarMaxWidth,
  getVisibleSidebarWidth,
  useSidebarResize,
} from '../useSidebarResize'

function SidebarResizeHandle({
  compactMode = false,
  mounted = true,
  onResizeReady,
}: {
  compactMode?: boolean
  mounted?: boolean
  onResizeReady?: (value: ReturnType<typeof useSidebarResize>) => void
} = {}) {
  const resize = useSidebarResize(compactMode)
  onResizeReady?.(resize)
  return (
    <>
      <output data-testid="sidebar-width">{resize.width}</output>
      {mounted && !compactMode ? (
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
      ) : null}
    </>
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

  it('cancels an active drag when compact mode removes the separator', () => {
    window.localStorage.setItem('clerum.ui.sidebarWidth', '420')
    const { container, rerender } = render(<SidebarResizeHandle />)
    const handle = screen.getByRole('separator', { name: 'Resize sidebar' })
    const setPointerCapture = vi.fn()
    const releasePointerCapture = vi.fn()
    Object.defineProperty(handle, 'setPointerCapture', { value: setPointerCapture })
    Object.defineProperty(handle, 'hasPointerCapture', { value: () => true })
    Object.defineProperty(handle, 'releasePointerCapture', { value: releasePointerCapture })

    fireEvent.pointerDown(handle, { button: 0, clientX: 100, pointerId: 12 })
    fireEvent.pointerMove(handle, { clientX: 138, pointerId: 12 })
    expect(screen.getByTestId('sidebar-width').textContent).toBe('458')
    expect(window.localStorage.getItem('clerum.ui.sidebarWidth')).toBe('420')
    expect(document.body.classList.contains('sidebar-resizing')).toBe(true)

    rerender(<SidebarResizeHandle compactMode />)
    expect(screen.queryByRole('separator', { name: 'Resize sidebar' })).toBeNull()
    expect(screen.getByTestId('sidebar-width').textContent).toBe('420')
    expect(document.body.classList.contains('sidebar-resizing')).toBe(false)
    expect(releasePointerCapture).toHaveBeenCalledWith(12)
    expect(window.localStorage.getItem('clerum.ui.sidebarWidth')).toBe('420')

    rerender(<SidebarResizeHandle />)
    const reopenedHandle = screen.getByRole('separator', { name: 'Resize sidebar' })
    fireEvent.pointerUp(reopenedHandle, { clientX: 138, pointerId: 12 })
    expect(screen.getByTestId('sidebar-width').textContent).toBe('420')
    expect(window.localStorage.getItem('clerum.ui.sidebarWidth')).toBe('420')
    expect(container.querySelector('[role="separator"]')).toBe(reopenedHandle)
  })

  it('cancels synchronously at the compact breakpoint before a queued commit', () => {
    window.localStorage.setItem('clerum.ui.sidebarWidth', '460')
    let controls: ReturnType<typeof useSidebarResize> | undefined
    const { container } = render(
      <SidebarResizeHandle onResizeReady={value => (controls = value)} />
    )
    const handle = container.querySelector('[role="separator"]') as HTMLElement
    const releasePointerCapture = vi.fn()
    Object.defineProperty(handle, 'setPointerCapture', { value: vi.fn() })
    Object.defineProperty(handle, 'hasPointerCapture', { value: () => true })
    Object.defineProperty(handle, 'releasePointerCapture', { value: releasePointerCapture })

    fireEvent.pointerDown(handle, { button: 0, clientX: 460, pointerId: 42 })
    fireEvent.pointerMove(handle, { clientX: 450, pointerId: 42 })
    expect(screen.getByTestId('sidebar-width').textContent).toBe('450')

    controls!.cancelActiveDrag()
    fireEvent.pointerUp(handle, { clientX: 450, pointerId: 42 })

    expect(window.localStorage.getItem('clerum.ui.sidebarWidth')).toBe('460')
    expect(document.body.classList.contains('sidebar-resizing')).toBe(false)
    expect(releasePointerCapture).toHaveBeenCalledWith(42)
  })

  it('cancels an active drag if the separator is removed outside a breakpoint change', async () => {
    const { rerender } = render(<SidebarResizeHandle />)
    const handle = screen.getByRole('separator', { name: 'Resize sidebar' })
    const releasePointerCapture = vi.fn()
    Object.defineProperty(handle, 'setPointerCapture', { value: vi.fn() })
    Object.defineProperty(handle, 'hasPointerCapture', { value: () => true })
    Object.defineProperty(handle, 'releasePointerCapture', { value: releasePointerCapture })

    fireEvent.pointerDown(handle, { button: 0, clientX: 100, pointerId: 13 })
    fireEvent.pointerMove(handle, { clientX: 170, pointerId: 13 })
    rerender(<SidebarResizeHandle mounted={false} />)

    await waitFor(() => {
      expect(document.body.classList.contains('sidebar-resizing')).toBe(false)
    })
    expect(screen.getByTestId('sidebar-width').textContent).toBe(String(SIDEBAR_DEFAULT_WIDTH))
    expect(releasePointerCapture).toHaveBeenCalledWith(13)
    expect(window.localStorage.getItem('clerum.ui.sidebarWidth')).toBeNull()

    rerender(<SidebarResizeHandle />)
    const reopenedHandle = screen.getByRole('separator', { name: 'Resize sidebar' })
    fireEvent.pointerUp(reopenedHandle, { clientX: 170, pointerId: 13 })
    expect(screen.getByTestId('sidebar-width').textContent).toBe(String(SIDEBAR_DEFAULT_WIDTH))
    expect(window.localStorage.getItem('clerum.ui.sidebarWidth')).toBeNull()
  })

  it('cancels an active drag on Escape without persisting its temporary width', () => {
    render(<SidebarResizeHandle />)
    const handle = screen.getByRole('separator', { name: 'Resize sidebar' })
    const releasePointerCapture = vi.fn()
    Object.defineProperty(handle, 'setPointerCapture', { value: vi.fn() })
    Object.defineProperty(handle, 'hasPointerCapture', { value: () => true })
    Object.defineProperty(handle, 'releasePointerCapture', { value: releasePointerCapture })

    fireEvent.pointerDown(handle, { button: 0, clientX: 100, pointerId: 14 })
    fireEvent.pointerMove(handle, { clientX: 170, pointerId: 14 })
    fireEvent.keyDown(handle, { key: 'Escape' })

    expect(screen.getByTestId('sidebar-width').textContent).toBe(String(SIDEBAR_DEFAULT_WIDTH))
    expect(document.body.classList.contains('sidebar-resizing')).toBe(false)
    expect(window.localStorage.getItem('clerum.ui.sidebarWidth')).toBeNull()
    expect(releasePointerCapture).toHaveBeenCalledWith(14)
    fireEvent.pointerUp(handle, { clientX: 170, pointerId: 14 })
    expect(window.localStorage.getItem('clerum.ui.sidebarWidth')).toBeNull()
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

  it('clamps and persists keyboard input that exceeds the live maximum', () => {
    vi.stubGlobal('innerWidth', 900)
    window.localStorage.setItem('clerum.ui.sidebarWidth', '430')
    render(<SidebarResizeHandle />)
    const handle = screen.getByRole('separator', { name: 'Resize sidebar' })

    expect(handle.getAttribute('aria-valuemax')).toBe('440')
    expect(handle.getAttribute('aria-valuenow')).toBe('430')
    fireEvent.keyDown(handle, { key: 'ArrowRight' })

    expect(handle.getAttribute('aria-valuenow')).toBe('440')
    expect(window.localStorage.getItem('clerum.ui.sidebarWidth')).toBe('440')
  })

  it('preserves eligible pointer intent above the live maximum', () => {
    vi.stubGlobal('innerWidth', 900)
    window.localStorage.setItem('clerum.ui.sidebarWidth', '420')
    render(<SidebarResizeHandle />)
    const handle = screen.getByRole('separator', { name: 'Resize sidebar' })

    fireEvent.pointerDown(handle, { button: 0, clientX: 100, pointerId: 6 })
    fireEvent.pointerMove(handle, { clientX: 140, pointerId: 6 })
    expect(handle.getAttribute('aria-valuenow')).toBe('440')
    expect(window.localStorage.getItem('clerum.ui.sidebarWidth')).toBe('420')
    fireEvent.pointerUp(handle, { clientX: 140, pointerId: 6 })

    expect(handle.getAttribute('aria-valuenow')).toBe('440')
    expect(window.localStorage.getItem('clerum.ui.sidebarWidth')).toBe('460')
  })

  it('preserves a wider preference when keyboard resize is blocked at the maximum', () => {
    vi.stubGlobal('innerWidth', 900)
    window.localStorage.setItem('clerum.ui.sidebarWidth', '460')
    render(<SidebarResizeHandle />)
    const handle = screen.getByRole('separator', { name: 'Resize sidebar' })

    expect(handle.getAttribute('aria-valuemax')).toBe('440')
    expect(handle.getAttribute('aria-valuenow')).toBe('440')
    fireEvent.keyDown(handle, { key: 'ArrowRight' })

    expect(handle.getAttribute('aria-valuenow')).toBe('440')
    expect(window.localStorage.getItem('clerum.ui.sidebarWidth')).toBe('460')

    vi.stubGlobal('innerWidth', 1200)
    fireEvent(window, new Event('resize'))
    expect(handle.getAttribute('aria-valuenow')).toBe('460')
  })

  it('preserves a wider preference when pointer resize is blocked at the maximum', () => {
    vi.stubGlobal('innerWidth', 900)
    window.localStorage.setItem('clerum.ui.sidebarWidth', '460')
    render(<SidebarResizeHandle />)
    const handle = screen.getByRole('separator', { name: 'Resize sidebar' })

    fireEvent.pointerDown(handle, { button: 0, clientX: 100, pointerId: 5 })
    fireEvent.pointerMove(handle, { clientX: 124, pointerId: 5 })
    expect(handle.getAttribute('aria-valuenow')).toBe('440')
    fireEvent.pointerUp(handle, { clientX: 124, pointerId: 5 })

    expect(window.localStorage.getItem('clerum.ui.sidebarWidth')).toBe('460')
    vi.stubGlobal('innerWidth', 1200)
    fireEvent(window, new Event('resize'))
    expect(handle.getAttribute('aria-valuenow')).toBe('460')
  })

  it('persists the last effective pointer intent after a later capped move', async () => {
    window.localStorage.setItem('clerum.ui.sidebarWidth', '460')
    const { container } = render(<SidebarResizeHandle />)
    let handle = container.querySelector('[role="separator"]') as HTMLElement

    fireEvent.pointerDown(handle, { button: 0, clientX: 460, pointerId: 41 })
    fireEvent.pointerMove(handle, { clientX: 450, pointerId: 41 })
    expect(screen.getByTestId('sidebar-width').textContent).toBe('450')

    vi.stubGlobal('innerWidth', 800)
    fireEvent(window, new Event('resize'))
    await waitFor(() => expect(screen.getByTestId('sidebar-width').textContent).toBe('340'))

    handle = container.querySelector('[role="separator"]') as HTMLElement
    fireEvent.pointerMove(handle, { clientX: 430, pointerId: 41 })
    expect(screen.getByTestId('sidebar-width').textContent).toBe('340')
    fireEvent.pointerUp(handle, { clientX: 430, pointerId: 41 })

    vi.stubGlobal('innerWidth', 1200)
    fireEvent(window, new Event('resize'))
    await waitFor(() => expect(screen.getByTestId('sidebar-width').textContent).toBe('450'))
    expect(window.localStorage.getItem('clerum.ui.sidebarWidth')).toBe('450')
  })

  it('persists a visible return-to-cap movement as the last eligible pointer intent', () => {
    vi.stubGlobal('innerWidth', 760)
    window.localStorage.setItem('clerum.ui.sidebarWidth', '460')
    const { container } = render(<SidebarResizeHandle />)
    const handle = container.querySelector('[role="separator"]') as HTMLElement
    expect(screen.getByTestId('sidebar-width').textContent).toBe('300')

    fireEvent.pointerDown(handle, { button: 0, clientX: 300, pointerId: 43 })
    fireEvent.pointerMove(handle, { clientX: 292, pointerId: 43 })
    expect(screen.getByTestId('sidebar-width').textContent).toBe('292')
    fireEvent.pointerMove(handle, { clientX: 320, pointerId: 43 })
    expect(screen.getByTestId('sidebar-width').textContent).toBe('300')
    fireEvent.pointerUp(handle, { clientX: 320, pointerId: 43 })

    expect(window.localStorage.getItem('clerum.ui.sidebarWidth')).toBe('320')
    vi.stubGlobal('innerWidth', 1200)
    fireEvent(window, new Event('resize'))
    expect(screen.getByTestId('sidebar-width').textContent).toBe('320')
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
