// @vitest-environment jsdom
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { useRecentOverviewLimit } from '../useRecentOverviewLimit'

let viewportHeight = 600
let viewportWidth = 800

function rectangle(top: number, height: number, width = viewportWidth): DOMRect {
  return {
    top,
    bottom: top + height,
    left: 0,
    right: width,
    height,
    width,
    x: 0,
    y: top,
    toJSON: () => ({}),
  }
}

function Overview({
  count = 12,
  showHome = true,
  active = true,
}: {
  count?: number
  showHome?: boolean
  active?: boolean
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const limit = useRecentOverviewLimit(ref, active, count, `${count}-${showHome}`)
  return (
    <div ref={ref} data-testid="layout" data-limit={limit}>
      <output>{limit}</output>
      {showHome && <button data-gfs-overview-destination="home">My home</button>}
      <button data-gfs-overview-destination="shared">Shared with me</button>
    </div>
  )
}

beforeEach(() => {
  viewportHeight = 600
  viewportWidth = 800
  vi.stubGlobal('ResizeObserver', undefined)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return this.dataset.testid === 'layout' ? viewportHeight : 0
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    if (this.dataset.testid === 'layout') return rectangle(100, viewportHeight)
    const layout = this.closest<HTMLElement>('[data-testid="layout"]')
    const expanded = layout?.dataset.limit === '10'
    const scrollTop = layout?.scrollTop ?? 0
    if (this.dataset.gfsOverviewDestination === 'home') {
      return rectangle((expanded ? 480 : 280) - scrollTop, 40)
    }
    if (this.dataset.gfsOverviewDestination === 'shared') {
      return rectangle((expanded ? 540 : 340) - scrollTop, 40)
    }
    return rectangle(0, 0)
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('useRecentOverviewLimit', () => {
  it('shows up to ten only when both destination rows fit', () => {
    const { rerender } = render(<Overview />)
    expect(screen.getByText('10')).toBeTruthy()

    viewportHeight = 400
    act(() => window.dispatchEvent(new Event('resize')))
    expect(screen.getByText('5')).toBeTruthy()

    viewportHeight = 600
    act(() => window.dispatchEvent(new Event('resize')))
    expect(screen.getByText('10')).toBeTruthy()

    rerender(<Overview showHome={false} />)
    expect(screen.getByText('5')).toBeTruthy()
  })

  it('remeasures after content or width changes and does not need ten for five files', () => {
    const { rerender } = render(<Overview count={5} />)
    expect(screen.getByText('5')).toBeTruthy()
    rerender(<Overview count={6} />)
    expect(screen.getByText('10')).toBeTruthy()
    viewportHeight = 400
    viewportWidth = 700
    act(() => window.dispatchEvent(new Event('resize')))
    expect(screen.getByText('5')).toBeTruthy()
    rerender(<Overview count={6} active={false} />)
    expect(screen.getByText('5')).toBeTruthy()
  })

  it('evaluates visibility at the top even when the user has scrolled', () => {
    const { rerender } = render(<Overview count={5} />)
    screen.getByTestId('layout').scrollTop = 150
    rerender(<Overview count={12} />)
    expect(screen.getByText('10')).toBeTruthy()
  })

  it('responds to panel resizing without a window resize and disconnects the observer', () => {
    let notifyResize: ResizeObserverCallback | undefined
    const disconnect = vi.fn()
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          notifyResize = callback
        }
        observe() {}
        disconnect = disconnect
      }
    )
    const { unmount } = render(<Overview />)
    expect(screen.getByText('10')).toBeTruthy()
    viewportHeight = 400
    act(() => notifyResize?.([], {} as ResizeObserver))
    expect(screen.getByText('5')).toBeTruthy()
    unmount()
    expect(disconnect).toHaveBeenCalledOnce()
  })
})
