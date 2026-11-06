import { type FocusEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { WorkspaceTabOverflowOptions, WorkspaceTabScrollState } from './types'

const SCROLL_EPSILON = 1
const WHEEL_LINE_PIXELS = 16

export function useWorkspaceTabOverflow({
  tabs,
  activeTabId,
  stripRef,
}: WorkspaceTabOverflowOptions) {
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const leftButtonRef = useRef<HTMLButtonElement | null>(null)
  const rightButtonRef = useRef<HTMLButtonElement | null>(null)
  const keyboardArrowFocusRef = useRef(false)
  const focusAfterOverflowRef = useRef(false)
  const activeTabToRevealRef = useRef<string | null>(null)
  const previousActiveTabIdRef = useRef<string | null>(null)
  const [scrollState, setScrollState] = useState<WorkspaceTabScrollState>({
    hasOverflow: false,
    canScrollLeft: false,
    canScrollRight: false,
  })
  const updateScrollState = useCallback(() => {
    const scroller = scrollerRef.current
    const strip = stripRef.current
    const list = scroller?.firstElementChild as HTMLElement | null
    if (!scroller || !strip || !list) return

    const stripWidth = strip.clientWidth
    if (stripWidth <= 0) return

    const originalStyle = list.getAttribute('style')
    const styleSeparator = originalStyle && !originalStyle.trimEnd().endsWith(';') ? ';' : ''
    let fullWidthContent: number
    try {
      list.setAttribute(
        'style',
        `${originalStyle ?? ''}${styleSeparator}width: ${stripWidth}px !important;`
      )
      fullWidthContent = list.scrollWidth
    } finally {
      if (originalStyle === null) list.removeAttribute('style')
      else list.setAttribute('style', originalStyle)
      // Restore the live list layout before reading viewport navigation geometry.
      scroller.getBoundingClientRect()
    }

    const hasOverflow = fullWidthContent - stripWidth > SCROLL_EPSILON
    if (!hasOverflow && scroller.scrollLeft !== 0) scroller.scrollLeft = 0
    const maximum = Math.max(0, scroller.scrollWidth - scroller.clientWidth)
    const next: WorkspaceTabScrollState = {
      hasOverflow,
      canScrollLeft: scroller.scrollLeft > SCROLL_EPSILON,
      canScrollRight: scroller.scrollLeft < maximum - SCROLL_EPSILON,
    }
    if (!next.hasOverflow && keyboardArrowFocusRef.current) {
      const focused = document.activeElement
      if (focused === leftButtonRef.current || focused === rightButtonRef.current) {
        focusAfterOverflowRef.current = true
      }
    }
    setScrollState(current =>
      current.hasOverflow === next.hasOverflow &&
      current.canScrollLeft === next.canScrollLeft &&
      current.canScrollRight === next.canScrollRight
        ? current
        : next
    )
  }, [stripRef])

  const updateScrollAvailability = useCallback(() => {
    const scroller = scrollerRef.current
    const strip = stripRef.current
    if (!scroller || !strip) return
    const stripWidth = strip.clientWidth
    const viewportWidth = scroller.clientWidth
    const maximum = Math.max(0, scroller.scrollWidth - viewportWidth)
    if (
      stripWidth > 0 &&
      !strip.querySelector('.chat-view-tabs__scroll-button') &&
      viewportWidth === stripWidth &&
      maximum <= SCROLL_EPSILON &&
      scroller.scrollLeft !== 0
    ) {
      scroller.scrollLeft = 0
    }
    const canScrollLeft = scroller.scrollLeft > SCROLL_EPSILON
    const canScrollRight = scroller.scrollLeft < maximum - SCROLL_EPSILON
    setScrollState(current =>
      current.canScrollLeft === canScrollLeft && current.canScrollRight === canScrollRight
        ? current
        : { ...current, canScrollLeft, canScrollRight }
    )
  }, [stripRef])

  const getTabNodes = useCallback(() => {
    const list = scrollerRef.current?.firstElementChild
    return list
      ? Array.from(list.children).filter((node): node is HTMLElement => node instanceof HTMLElement)
      : []
  }, [])

  const scrollTabIntoView = useCallback(
    (tab: HTMLElement, direction?: 'left' | 'right') => {
      const scroller = scrollerRef.current
      if (!scroller || scroller.clientWidth <= 0) return false
      const viewportLeft = scroller.getBoundingClientRect().left + scroller.clientLeft
      const viewportRight = viewportLeft + scroller.clientWidth
      const rect = tab.getBoundingClientRect()
      let nextScrollLeft = scroller.scrollLeft
      if (direction === 'right') {
        nextScrollLeft += Math.max(0, rect.right - viewportRight)
      } else if (direction === 'left') {
        nextScrollLeft += Math.min(0, rect.left - viewportLeft)
      } else if (rect.left < viewportLeft - SCROLL_EPSILON) {
        nextScrollLeft += rect.left - viewportLeft
      } else if (rect.right > viewportRight + SCROLL_EPSILON) {
        nextScrollLeft += rect.right - viewportRight
      }
      scroller.scrollLeft = Math.max(
        0,
        Math.min(scroller.scrollWidth - scroller.clientWidth, nextScrollLeft)
      )
      updateScrollAvailability()
      return true
    },
    [updateScrollAvailability]
  )

  const scrollToNearestHiddenTab = (direction: 'left' | 'right') => {
    const scroller = scrollerRef.current
    if (!scroller) return
    const viewportLeft = scroller.getBoundingClientRect().left + scroller.clientLeft
    const viewportRight = viewportLeft + scroller.clientWidth
    const candidates = getTabNodes()
    const tab =
      direction === 'right'
        ? candidates.find(
            node => node.getBoundingClientRect().right > viewportRight + SCROLL_EPSILON
          )
        : candidates
            .slice()
            .reverse()
            .find(node => node.getBoundingClientRect().left < viewportLeft - SCROLL_EPSILON)
    if (tab) scrollTabIntoView(tab, direction)
  }

  const handleWheel = useCallback(
    (event: WheelEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      const scroller = scrollerRef.current
      if (!scroller) return
      const maximum = Math.max(0, scroller.scrollWidth - scroller.clientWidth)
      if (maximum <= SCROLL_EPSILON) return
      const scale =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? WHEEL_LINE_PIXELS
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? scroller.clientWidth
            : 1
      // Trackpads may report both axes for a diagonal gesture. Use the dominant
      // component and resolve ties horizontally.
      const axisDelta =
        Math.abs(event.deltaX) >= Math.abs(event.deltaY) ? event.deltaX : event.deltaY
      const delta = axisDelta * scale
      if (delta === 0) return
      const nextScrollLeft = Math.max(0, Math.min(maximum, scroller.scrollLeft + delta))
      if (Math.abs(nextScrollLeft - scroller.scrollLeft) <= SCROLL_EPSILON) return
      event.preventDefault()
      scroller.scrollLeft = nextScrollLeft
      updateScrollAvailability()
    },
    [updateScrollAvailability]
  )

  const revealPendingTab = useCallback(() => {
    const targetId = activeTabToRevealRef.current
    const scroller = scrollerRef.current
    if (!targetId || !scroller || scroller.clientWidth <= 0) return
    const hasMeasuredOverflow = scroller.scrollWidth - scroller.clientWidth > SCROLL_EPSILON
    const hasScrollControls = Boolean(
      stripRef.current?.querySelector('.chat-view-tabs__scroll-button')
    )
    // Settle the control widths before consuming the identity-change request.
    if (hasMeasuredOverflow !== hasScrollControls) return
    const activeTab = getTabNodes().find(node => node.dataset.workspaceTabId === targetId)
    if (!activeTab) return
    if (scrollTabIntoView(activeTab)) activeTabToRevealRef.current = null
  }, [getTabNodes, scrollTabIntoView, stripRef])

  const requestFocusReveal = useCallback(
    (tabId: string) => {
      activeTabToRevealRef.current = tabId
      revealPendingTab()
    },
    [revealPendingTab]
  )

  useLayoutEffect(() => {
    if (previousActiveTabIdRef.current === activeTabId) return
    previousActiveTabIdRef.current = activeTabId
    activeTabToRevealRef.current = activeTabId
  }, [activeTabId])

  useLayoutEffect(() => {
    const targetId = activeTabToRevealRef.current
    if (targetId && !tabs.some(tab => tab.id === targetId)) {
      activeTabToRevealRef.current = null
    }
  }, [tabs])

  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    const measure = () => {
      updateScrollState()
      revealPendingTab()
    }
    const handleScroll = () => {
      updateScrollAvailability()
      revealPendingTab()
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(scroller)
    if (scroller.firstElementChild) observer?.observe(scroller.firstElementChild)
    window.addEventListener('resize', measure)
    scroller.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
      scroller.removeEventListener('scroll', handleScroll)
    }
  }, [tabs, activeTabId, updateScrollState, updateScrollAvailability, revealPendingTab])

  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    scroller.addEventListener('wheel', handleWheel, { passive: false })
    return () => scroller.removeEventListener('wheel', handleWheel)
  }, [handleWheel])

  useLayoutEffect(() => {
    revealPendingTab()
  }, [activeTabId, tabs, scrollState.hasOverflow, revealPendingTab])

  useLayoutEffect(() => {
    if (scrollState.hasOverflow || !focusAfterOverflowRef.current) return
    focusAfterOverflowRef.current = false
    // A user who deliberately moved focus while measurements settled keeps it.
    if (document.activeElement && document.activeElement !== document.body) return
    const strip = stripRef.current
    const activeTab = strip?.querySelector<HTMLElement>(
      '.chat-view-tab.is-active .chat-view-tab__select'
    )
    const rovingTab = strip?.querySelector<HTMLElement>(
      '.chat-view-tabs__list [role="tab"][tabindex="0"]'
    )
    ;(activeTab ?? rovingTab ?? strip)?.focus({ preventScroll: true })
  }, [scrollState.hasOverflow, stripRef])

  const focusProps = {
    onFocus: (event: FocusEvent<HTMLButtonElement>) => {
      keyboardArrowFocusRef.current = event.currentTarget.matches(':focus-visible')
    },
    onKeyDown: () => {
      keyboardArrowFocusRef.current = true
    },
    onPointerDown: () => {
      keyboardArrowFocusRef.current = false
    },
    onBlur: () => {
      keyboardArrowFocusRef.current = false
    },
  }

  return {
    scrollerRef,
    hasOverflow: scrollState.hasOverflow,
    requestFocusReveal,
    leftButtonProps: {
      ...focusProps,
      ref: leftButtonRef,
      'aria-disabled': !scrollState.canScrollLeft,
      onClick: () => {
        if (scrollState.canScrollLeft) scrollToNearestHiddenTab('left')
      },
    },
    rightButtonProps: {
      ...focusProps,
      ref: rightButtonRef,
      'aria-disabled': !scrollState.canScrollRight,
      onClick: () => {
        if (scrollState.canScrollRight) scrollToNearestHiddenTab('right')
      },
    },
  }
}
