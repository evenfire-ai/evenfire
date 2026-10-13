import * as React from 'react'
import { SIDEBAR_WIDTH_KEY } from '@constants/navigation'

export const SIDEBAR_MIN_WIDTH = 192
export const SIDEBAR_DEFAULT_WIDTH = 328
export const SIDEBAR_MAX_WIDTH = 460
export const SIDEBAR_CONTENT_FLOOR = 460
const SIDEBAR_KEY_STEP = 24

export function clampSidebarWidth(width: number): number {
  return Math.round(Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, width)))
}

export function getSidebarMaxWidth(viewportWidth: number): number {
  return Math.max(
    SIDEBAR_MIN_WIDTH,
    Math.min(SIDEBAR_MAX_WIDTH, viewportWidth - SIDEBAR_CONTENT_FLOOR)
  )
}

export function getVisibleSidebarWidth(requestedWidth: number, viewportWidth: number): number {
  return Math.min(clampSidebarWidth(requestedWidth), getSidebarMaxWidth(viewportWidth))
}

function readPreferredWidth(): number {
  if (typeof window === 'undefined') return SIDEBAR_DEFAULT_WIDTH
  try {
    const value = window.localStorage.getItem(SIDEBAR_WIDTH_KEY)
    const parsed = value === null ? Number.NaN : Number(value)
    return Number.isFinite(parsed) ? clampSidebarWidth(parsed) : SIDEBAR_DEFAULT_WIDTH
  } catch {
    return SIDEBAR_DEFAULT_WIDTH
  }
}

type ActiveDrag = {
  pointerId: number
  startX: number
  startWidth: number
  candidate: number | null
  captureTarget: HTMLElement
  removalObserver: MutationObserver | null
}

function releaseDragResources(drag: ActiveDrag | null): void {
  if (!drag) return
  drag.removalObserver?.disconnect()
  try {
    if (
      !drag.captureTarget.hasPointerCapture ||
      drag.captureTarget.hasPointerCapture(drag.pointerId)
    ) {
      drag.captureTarget.releasePointerCapture?.(drag.pointerId)
    }
  } catch {
    // A removed handle or browser-canceled gesture may already have released capture.
  }
}

export type SidebarResizeControls = ReturnType<typeof useSidebarResize>

export function useSidebarResize(compactMode = false) {
  const [viewportWidth, setViewportWidth] = React.useState(() =>
    typeof window === 'undefined' ? 1280 : window.innerWidth
  )
  const [preferredWidth, setPreferredWidth] = React.useState(() =>
    compactMode ? SIDEBAR_DEFAULT_WIDTH : readPreferredWidth()
  )
  const [dragWidth, setDragWidth] = React.useState<number | null>(null)
  const activeDragRef = React.useRef<ActiveDrag | null>(null)
  const wasCompactRef = React.useRef(compactMode)
  const width = getVisibleSidebarWidth(dragWidth ?? preferredWidth, viewportWidth)
  const widthRef = React.useRef(width)
  widthRef.current = width
  const maxWidth = getSidebarMaxWidth(viewportWidth)
  const maxWidthRef = React.useRef(maxWidth)
  maxWidthRef.current = maxWidth

  React.useEffect(() => {
    const updateViewportWidth = () => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', updateViewportWidth)
    return () => window.removeEventListener('resize', updateViewportWidth)
  }, [])

  React.useLayoutEffect(() => {
    if (wasCompactRef.current && !compactMode) setPreferredWidth(readPreferredWidth())
    wasCompactRef.current = compactMode
  }, [compactMode])

  const commitWidth = React.useCallback(
    (nextWidth: number, unchangedWidth: number) => {
      if (compactMode) return
      const next = clampSidebarWidth(Math.min(nextWidth, maxWidthRef.current))
      if (next === unchangedWidth) return
      setPreferredWidth(next)
      try {
        window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(next))
      } catch {
        // Keep the live preference if storage is unavailable.
      }
    },
    [compactMode]
  )

  const clearDrag = React.useCallback(() => {
    const drag = activeDragRef.current
    activeDragRef.current = null
    releaseDragResources(drag)
    setDragWidth(null)
    document.body.classList.remove('sidebar-resizing')
  }, [])

  React.useLayoutEffect(() => {
    if (compactMode) clearDrag()
  }, [clearDrag, compactMode])

  React.useEffect(
    () => () => {
      const drag = activeDragRef.current
      activeDragRef.current = null
      releaseDragResources(drag)
      document.body.classList.remove('sidebar-resizing')
    },
    []
  )

  const onPointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (compactMode || event.button !== 0 || event.isPrimary === false) return
      event.preventDefault()
      const target = event.currentTarget
      try {
        target.setPointerCapture?.(event.pointerId)
      } catch {
        // Continue with element-delivered pointer events when capture is unavailable.
      }
      const drag: ActiveDrag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startWidth: widthRef.current,
        candidate: null,
        captureTarget: target,
        removalObserver: null,
      }
      activeDragRef.current = drag
      if (typeof MutationObserver !== 'undefined' && document.documentElement) {
        drag.removalObserver = new MutationObserver(() => {
          if (activeDragRef.current === drag && !target.isConnected) clearDrag()
        })
        drag.removalObserver.observe(document.documentElement, { childList: true, subtree: true })
      }
      document.body.classList.add('sidebar-resizing')
    },
    [clearDrag, compactMode]
  )

  const onPointerMove = React.useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      const drag = activeDragRef.current
      if (!drag || drag.pointerId !== event.pointerId) return
      if (compactMode || !drag.captureTarget.isConnected) {
        clearDrag()
        return
      }
      const candidate = clampSidebarWidth(
        Math.min(maxWidthRef.current, drag.startWidth + event.clientX - drag.startX)
      )
      drag.candidate = candidate
      setDragWidth(candidate)
    },
    [clearDrag, compactMode]
  )

  const onPointerUp = React.useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      const drag = activeDragRef.current
      if (!drag || drag.pointerId !== event.pointerId) return
      if (compactMode || !drag.captureTarget.isConnected) {
        clearDrag()
        return
      }
      if (drag.candidate !== null) commitWidth(drag.candidate, drag.startWidth)
      clearDrag()
    },
    [clearDrag, commitWidth, compactMode]
  )

  const onPointerCancel = React.useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (activeDragRef.current?.pointerId === event.pointerId) clearDrag()
    },
    [clearDrag]
  )

  const onLostPointerCapture = onPointerCancel

  const onKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      const drag = activeDragRef.current
      if (event.key === 'Escape' && drag) {
        event.preventDefault()
        clearDrag()
        return
      }

      let next: number
      switch (event.key) {
        case 'ArrowLeft':
          next = widthRef.current - SIDEBAR_KEY_STEP
          break
        case 'ArrowRight':
          next = widthRef.current + SIDEBAR_KEY_STEP
          break
        case 'Home':
          next = SIDEBAR_MIN_WIDTH
          break
        case 'End':
          next = maxWidthRef.current
          break
        default:
          return
      }
      event.preventDefault()
      commitWidth(next, widthRef.current)
    },
    [clearDrag, commitWidth]
  )

  return {
    width,
    maxWidth,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onLostPointerCapture,
    onKeyDown,
  }
}
