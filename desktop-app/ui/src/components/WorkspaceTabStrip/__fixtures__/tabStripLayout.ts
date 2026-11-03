/**
 * Synthetic jsdom geometry only: widths are assigned rectangles, NOT CSS flex bases.
 * No browser flex layout, min/max clamp, intrinsic sizing, native scroll, or CSS parsing
 * is simulated. In particular, 60/95px widths are deliberately impossible below the
 * production 96px minimum. Production geometry is accepted separately in Chromium.
 * Height 28, zero viewports and omitted active IDs are defensive hook-boundary inputs;
 * omitted IDs do not represent a valid selected-tab response from the real store.
 */
import { vi } from 'vitest'
import { fireEvent } from '@testing-library/react'

// Gap/control dimensions agree with production tokens/styles; the browser contract
// checks this agreement. The synthetic height is intentionally not a CSS claim.
export const SYNTHETIC_TAB_STRIP_METRICS = { gap: 6, controlWidth: 24, height: 28 } as const

const makeRect = (left: number, width: number): DOMRect =>
  ({
    left,
    right: left + width,
    top: 0,
    bottom: SYNTHETIC_TAB_STRIP_METRICS.height,
    width,
    height: SYNTHETIC_TAB_STRIP_METRICS.height,
    x: left,
    y: 0,
    toJSON: () => ({}),
  }) as DOMRect

export const installSyntheticTabStripLayout = (
  container: HTMLElement,
  initialAssignedWidths: number[],
  initialStripWidth: number
) => {
  const scroller = container.querySelector('.chat-view-tabs__scroller') as HTMLDivElement
  const strip = container.querySelector('.chat-view-tabs') as HTMLDivElement
  const list = scroller.firstElementChild as HTMLDivElement
  let widths = initialAssignedWidths
  let stripWidth = initialStripWidth
  let scrollLeft = 0
  const gap = SYNTHETIC_TAB_STRIP_METRICS.gap
  const scrollButtonWidth = SYNTHETIC_TAB_STRIP_METRICS.controlWidth
  const getScrollButtonCount = () =>
    container.querySelectorAll('.chat-view-tabs__scroll-button').length
  const getViewportLeft = () => (getScrollButtonCount() > 0 ? scrollButtonWidth : 0)
  const getViewportWidth = () => stripWidth - scrollButtonWidth * getScrollButtonCount()
  const getContentWidth = () =>
    widths.reduce((sum, width) => sum + width, 0) + gap * Math.max(0, widths.length - 1)
  Object.defineProperty(strip, 'clientWidth', {
    configurable: true,
    get: () => stripWidth,
  })
  Object.defineProperty(list, 'scrollWidth', {
    configurable: true,
    get: () => {
      // Recognize the hook request as a synthetic input, not proof that CSS parses it.
      const temporaryWidth = list
        .getAttribute('style')
        ?.match(/(?:^|;)\s*width:\s*([\d.]+)px\s*!important\s*;?/i)?.[1]
      return Math.max(
        temporaryWidth ? Number(temporaryWidth) : getViewportWidth(),
        getContentWidth()
      )
    },
  })
  const getMaximumScrollLeft = () => Math.max(0, getContentWidth() - getViewportWidth())
  Object.defineProperties(scroller, {
    clientLeft: { configurable: true, value: 0 },
    clientWidth: { configurable: true, get: getViewportWidth },
    scrollLeft: {
      configurable: true,
      get: () => scrollLeft,
      set: (value: number) => {
        scrollLeft = Math.max(0, Math.min(getMaximumScrollLeft(), value))
      },
    },
    scrollWidth: {
      configurable: true,
      get: () => Math.max(getContentWidth(), getViewportWidth()),
    },
    getBoundingClientRect: {
      configurable: true,
      value: () => makeRect(getViewportLeft(), getViewportWidth()),
    },
  })

  const syncTabRects = () => {
    const tabs = Array.from(container.querySelectorAll<HTMLElement>('.chat-view-tab'))
    tabs.forEach(tab => {
      Object.defineProperty(tab, 'getBoundingClientRect', {
        configurable: true,
        value: () => {
          const index = tabs.indexOf(tab)
          const left =
            getViewportLeft() + widths.slice(0, index).reduce((sum, width) => sum + width + gap, 0)
          return makeRect(left - scrollLeft, widths[index] ?? 120)
        },
      })
    })
  }
  syncTabRects()

  return {
    setStripWidth(nextWidth: number) {
      stripWidth = nextWidth
      scroller.scrollLeft = scrollLeft
    },
    resize(nextWidth: number) {
      stripWidth = nextWidth
      scroller.scrollLeft = scrollLeft
      fireEvent.resize(window)
      // Overflow controls take 24px on each edge. Re-measure after React renders
      // them (or removes them) so arrows use the remaining viewport width.
      fireEvent.resize(window)
    },
    measure() {
      scroller.scrollLeft = scrollLeft
      fireEvent.resize(window)
      fireEvent.resize(window)
    },
    setWidths(nextWidths: number[]) {
      widths = nextWidths
      syncTabRects()
      scroller.scrollLeft = scrollLeft
    },
    trackFutureTabRects() {
      const rectSpy = vi
        .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
        .mockImplementation(function (this: HTMLElement) {
          if (!this.classList.contains('chat-view-tab') || !container.contains(this)) {
            return makeRect(0, 0)
          }
          const tabs = Array.from(container.querySelectorAll<HTMLElement>('.chat-view-tab'))
          const index = tabs.indexOf(this)
          const left =
            getViewportLeft() + widths.slice(0, index).reduce((sum, width) => sum + width + gap, 0)
          return makeRect(left - scrollLeft, widths[index] ?? 120)
        })
      return () => rectSpy.mockRestore()
    },
    setScrollLeft(value: number) {
      scrollLeft = value
    },
    scrollLeft: () => scrollLeft,
    maximumScrollLeft: getMaximumScrollLeft,
    viewportWidth: getViewportWidth,
    syncTabRects,
  }
}
