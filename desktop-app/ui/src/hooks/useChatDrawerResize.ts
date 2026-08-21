import * as React from 'react'
import type { RefObject } from 'react'

/**
 * Session-only sizing + overlay policy for the Cursor-style chat drawer.
 *
 * The width is deliberately NOT persisted (no localStorage): it resets to the
 * default on every launch by design. The drawer is right-docked at
 * `right: var(--space-4)` with a fixed right edge, so a leftward drag widens it
 * (`newWidth = drawerRightEdge - cursorX`) and a rightward drag narrows it.
 *
 * When the app embed's remaining column would be squeezed below
 * `OVERLAY_EMBED_MIN`, the drawer stops pushing the embed and floats over it —
 * the caller drops the embed gutter and the drawer's own `position: fixed`
 * z-index does the rest.
 */

/** Hard floor — below this the drawer's own chrome (composer, header, switcher)
 *  starts to overflow. Also the minimum the resize drag can reach. */
export const CHAT_DRAWER_MIN_WIDTH = 340
/** Default session width (matches the top of the old CSS clamp). */
export const CHAT_DRAWER_DEFAULT_WIDTH = 420
/** Generous absolute ceiling for the drag. */
const CHAT_DRAWER_MAX_ABSOLUTE = 820
/** Always leave at least this much of the content panel for the app embed, so
 *  even at the widest drag the embed never collapses to nothing. */
const CHAT_DRAWER_VIEWPORT_MARGIN = 80
/** Fixed term added beside `--chat-drawer-width` in the embed gutter, mirroring
 *  the CSS `--app-header-utilities-width` term `var(--space-2) + 36px`
 *  (space-2 = 10px). Kept in sync with styles.css by hand. */
const CHAT_DRAWER_GUTTER_EXTRA = 46
/** Flip to overlay once the app embed column would drop below this width. */
const CHAT_DRAWER_OVERLAY_EMBED_MIN = 460
/** Fallback for the drawer's fixed right edge if the element can't be measured
 *  (`--space-4` = 18px). */
const CHAT_DRAWER_RIGHT_INSET = 18

function readPanelWidth(ref: RefObject<HTMLElement | null>): number {
  return ref.current?.clientWidth ?? 0
}

/** Clamp a requested width to [MIN, dynamicMax], rounded to a whole pixel. */
export function clampWidth(requested: number, panelWidth: number): number {
  const dynamicMax =
    panelWidth > 0
      ? Math.max(
          CHAT_DRAWER_MIN_WIDTH,
          Math.min(CHAT_DRAWER_MAX_ABSOLUTE, panelWidth - CHAT_DRAWER_VIEWPORT_MARGIN)
        )
      : CHAT_DRAWER_MAX_ABSOLUTE
  return Math.round(Math.max(CHAT_DRAWER_MIN_WIDTH, Math.min(dynamicMax, requested)))
}

/** True when the app embed column would fall below the overlay threshold at the
 *  given content-panel and drawer widths — the drawer then floats over the embed
 *  instead of pushing it. Pure decision extracted from `recomputeOverlay` so the
 *  `< OVERLAY_EMBED_MIN` flip is unit-testable at the boundary. */
export function computeChatDrawerOverlay(panelWidth: number, drawerWidth: number): boolean {
  const embedWidth = panelWidth - drawerWidth - CHAT_DRAWER_GUTTER_EXTRA
  return embedWidth < CHAT_DRAWER_OVERLAY_EMBED_MIN
}

/** Width the drawer should take for a cursor at `pointerX`, given the drawer's
 *  fixed right edge. Leftward drag (smaller `pointerX`) widens, rightward narrows
 *  (`rightEdge - pointerX`); result is clamped to the panel. Extracted so the drag
 *  direction is unit-testable (an inverted mapping would otherwise pass every test). */
export function widthForCursor(rightEdge: number, pointerX: number, panelWidth: number): number {
  return clampWidth(rightEdge - pointerX, panelWidth)
}

export type ChatDrawerResize = {
  /** Current drawer width in px (session-only state). */
  width: number
  /** True while the drawer should float over the embed instead of pushing it. */
  isOverlay: boolean
  /** True while a drag is in progress (for handle feedback). */
  isResizing: boolean
  /** mousedown handler for the drag handle on the drawer's left edge. */
  onResizeHandleMouseDown: (event: React.MouseEvent<HTMLElement>) => void
}

export function useChatDrawerResize(
  contentPanelRef: RefObject<HTMLElement | null>,
  active: boolean
): ChatDrawerResize {
  const [width, setWidth] = React.useState(CHAT_DRAWER_DEFAULT_WIDTH)
  const [isOverlay, setIsOverlay] = React.useState(false)
  const [isResizing, setIsResizing] = React.useState(false)
  const widthRef = React.useRef(width)
  widthRef.current = width
  // Teardown of an in-progress drag, stored so a cleanup effect can invoke it
  // if the drawer hides or the hook unmounts mid-drag (see below).
  const endDragRef = React.useRef<(() => void) | null>(null)

  // `overrideWidth` lets callers decide overlay from the width they just set
  // this tick instead of `widthRef.current`, which still holds the previous
  // render's value (avoids a one-frame-stale overlay flip during a drag).
  const recomputeOverlay = React.useCallback(
    (overrideWidth?: number) => {
      const panelWidth = readPanelWidth(contentPanelRef)
      if (panelWidth <= 0) return
      const nextWidth = overrideWidth ?? widthRef.current
      setIsOverlay(computeChatDrawerOverlay(panelWidth, nextWidth))
    },
    [contentPanelRef]
  )

  // Keep the width inside the dynamic clamp as the content panel resizes, and
  // refresh the overlay decision. A ResizeObserver on the content panel also
  // fires on window resize (the panel is full-height flex), so no separate
  // window listener is needed.
  React.useEffect(() => {
    if (!active) return
    const panel = contentPanelRef.current
    if (!panel) return
    const sync = () => {
      const panelWidth = readPanelWidth(contentPanelRef)
      const clamped = clampWidth(widthRef.current, panelWidth)
      setWidth(prev => (clamped === prev ? prev : clamped))
      recomputeOverlay(clamped)
    }
    sync()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(sync)
    observer.observe(panel)
    return () => observer.disconnect()
  }, [active, contentPanelRef, recomputeOverlay])

  const onResizeHandleMouseDown = React.useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      event.preventDefault()
      // The drawer's right edge is fixed while docked; measure it once from the
      // live element (robust to any transformed ancestor) so the width tracks
      // `rightEdge - cursorX` for the whole drag.
      const drawerEl = event.currentTarget.closest('.chat-drawer')
      const rightEdge = drawerEl
        ? drawerEl.getBoundingClientRect().right
        : window.innerWidth - CHAT_DRAWER_RIGHT_INSET

      let frame = 0
      let pointerX = event.clientX
      const apply = () => {
        frame = 0
        const panelWidth = readPanelWidth(contentPanelRef)
        const next = widthForCursor(rightEdge, pointerX, panelWidth)
        setWidth(next)
        recomputeOverlay(next)
      }
      const onMove = (moveEvent: MouseEvent) => {
        pointerX = moveEvent.clientX
        if (!frame) frame = window.requestAnimationFrame(apply)
      }
      // Idempotent teardown. Also runs on `blur` (mouse released outside the
      // window never fires `mouseup`) and from the cleanup effect below.
      const endDrag = () => {
        if (endDragRef.current !== endDrag) return
        if (frame) window.cancelAnimationFrame(frame)
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', endDrag)
        window.removeEventListener('blur', endDrag)
        document.body.style.userSelect = ''
        document.body.style.cursor = ''
        endDragRef.current = null
        setIsResizing(false)
      }
      endDragRef.current = endDrag
      document.body.style.userSelect = 'none'
      document.body.style.cursor = 'col-resize'
      setIsResizing(true)
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', endDrag)
      window.addEventListener('blur', endDrag)
    },
    [contentPanelRef, recomputeOverlay]
  )

  // If the drawer hides or the hook unmounts while a drag is live, tear it down
  // so window listeners and the body cursor/user-select overrides never leak.
  React.useEffect(() => {
    if (active) return
    endDragRef.current?.()
  }, [active])
  React.useEffect(() => () => endDragRef.current?.(), [])

  return { width, isOverlay, isResizing, onResizeHandleMouseDown }
}
