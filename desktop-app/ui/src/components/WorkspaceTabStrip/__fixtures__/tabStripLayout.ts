import { vi } from 'vitest'
import { fireEvent } from '@testing-library/react'

const makeRect = (left: number, width: number): DOMRect =>
  ({
    left,
    right: left + width,
    top: 0,
    bottom: 28,
    width,
    height: 28,
    x: left,
    y: 0,
    toJSON: () => ({}),
  }) as DOMRect

export const installTabStripLayout = (
  container: HTMLElement,
  initialWidths: number[],
  initialStripWidth: number
) => {
  const scroller = container.querySelector('.chat-view-tabs__scroller') as HTMLDivElement
  let widths = initialWidths
  let stripWidth = initialStripWidth
  let scrollLeft = 0
  const gap = 8
  const scrollButtonWidth = 24 // IconButton size="xs" in the live Common styles.
  const getScrollButtonCount = () =>
    container.querySelectorAll('.chat-view-tabs__scroll-button').length
  const getViewportLeft = () => (getScrollButtonCount() > 0 ? scrollButtonWidth : 0)
  const getViewportWidth = () => stripWidth - scrollButtonWidth * getScrollButtonCount()
  const getContentWidth = () =>
    widths.reduce((sum, width) => sum + width, 0) + gap * Math.max(0, widths.length - 1)
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
