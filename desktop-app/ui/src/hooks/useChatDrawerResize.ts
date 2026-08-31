import * as React from 'react'
import type { RefObject } from 'react'

/**
 * Session-only sizing for the Cursor-style chat drawer. The drawer and the app
 * embed are ALWAYS docked side by side — there is no overlay/float mode.
 *
 * The app embed is a native Electron `WebContentsView`: it paints on top of the
 * whole renderer DOM regardless of z-index. A "float the drawer over the embed"
 * mode is therefore physically impossible — the native view would simply cover
 * the drawer. So the drawer stays docked at all times, the embed lives in its
 * own column shrunk by `padding-right`, and when the embed's column gets too
 * narrow the embed scrolls horizontally within it (its own `overflow-x`) rather
 * than ever overlapping the drawer.
 *
 * The width is deliberately NOT persisted (no localStorage): it resets to the
 * default on every launch by design. The drawer is right-docked at
 * `right: var(--space-4)` with a fixed right edge, so a leftward drag widens it
 * (`newWidth = drawerRightEdge - cursorX`) and a rightward drag narrows it.
 *
 * Docked sizing reserves a legible floor for the embed: the dynamic max width
 * is `panelWidth - EMBED_FLOOR - GUTTER_EXTRA`, so as the window narrows the
 * drawer auto-shrinks (via the ResizeObserver `sync` re-clamp) down to its own
 * minimum while keeping ~`EMBED_FLOOR`px of embed. Once the drawer hits its
 * minimum and the panel keeps shrinking, the embed simply scrolls.
 */

/** Hard floor — below this the drawer's own chrome (composer, header, switcher)
 *  starts to overflow. Also the minimum the resize drag can reach. */
export const CHAT_DRAWER_MIN_WIDTH = 340
/** Default session width (matches the top of the old CSS clamp). */
export const CHAT_DRAWER_DEFAULT_WIDTH = 420
/** Generous absolute ceiling for the drag. */
export const CHAT_DRAWER_MAX_ABSOLUTE = 820
/** Width step for arrow-key resize (WAI-ARIA window-splitter pattern). */
const CHAT_DRAWER_KEY_STEP = 24
/** Legible floor reserved for the app embed's column while docked. The drawer's
 *  dynamic max width is capped so at least this much embed remains; once the
 *  window is too narrow for both this floor AND the drawer's own minimum, the
 *  embed keeps shrinking and scrolls via its own `overflow-x` (never overlaps
 *  the drawer). Reuses the value of the removed overlay threshold. */
const CHAT_DRAWER_EMBED_FLOOR = 460
/** Fixed term added beside `--chat-drawer-width` in the embed gutter, mirroring
 *  the CSS `--app-header-utilities-width` term `var(--space-2) + 36px`
 *  (space-2 = 10px). Kept in sync with styles.css by hand. */
const CHAT_DRAWER_GUTTER_EXTRA = 46
/** Fallback for the drawer's fixed right edge if the element can't be measured
 *  (`--space-4` = 18px). */
const CHAT_DRAWER_RIGHT_INSET = 18

function readPanelWidth(ref: RefObject<HTMLElement | null>): number {
  return ref.current?.clientWidth ?? 0
}

/** Clamp a requested width to [MIN, dynamicMax], rounded to a whole pixel. The
 *  dynamic max reserves `EMBED_FLOOR + GUTTER_EXTRA` for the docked embed so a
 *  narrowing window shrinks the drawer instead of collapsing the embed. */
export function clampWidth(requested: number, panelWidth: number): number {
  const dynamicMax =
    panelWidth > 0
      ? Math.max(
          CHAT_DRAWER_MIN_WIDTH,
          Math.min(
            CHAT_DRAWER_MAX_ABSOLUTE,
            panelWidth - CHAT_DRAWER_EMBED_FLOOR - CHAT_DRAWER_GUTTER_EXTRA
          )
        )
      : CHAT_DRAWER_MAX_ABSOLUTE
  return Math.round(Math.max(CHAT_DRAWER_MIN_WIDTH, Math.min(dynamicMax, requested)))
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
  /** True while a drag is in progress (for handle feedback). */
  isResizing: boolean
  /** mousedown handler for the drag handle on the drawer's left edge. */
  onResizeHandleMouseDown: (event: React.MouseEvent<HTMLElement>) => void
  /** keydown handler for the (focusable) drag handle — arrow/Home/End resize. */
  onResizeHandleKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void
}

export function useChatDrawerResize(
  contentPanelRef: RefObject<HTMLElement | null>,
  active: boolean
): ChatDrawerResize {
  const [width, setWidth] = React.useState(CHAT_DRAWER_DEFAULT_WIDTH)
  const [isResizing, setIsResizing] = React.useState(false)
  const widthRef = React.useRef(width)
  widthRef.current = width
  // Teardown of an in-progress drag, stored so a cleanup effect can invoke it
  // if the drawer hides or the hook unmounts mid-drag (see below).
  const endDragRef = React.useRef<(() => void) | null>(null)

  // Keep the width inside the dynamic clamp as the content panel resizes. A
  // ResizeObserver on the content panel also fires on window resize (the panel
  // is full-height flex), so no separate window listener is needed. As the
  // panel narrows this re-clamp shrinks the drawer to preserve the embed floor.
  React.useEffect(() => {
    if (!active) return
    const panel = contentPanelRef.current
    if (!panel) return
    const sync = () => {
      const panelWidth = readPanelWidth(contentPanelRef)
      const clamped = clampWidth(widthRef.current, panelWidth)
      setWidth(prev => (clamped === prev ? prev : clamped))
    }
    sync()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(sync)
    observer.observe(panel)
    return () => observer.disconnect()
  }, [active, contentPanelRef])

  const onResizeHandleMouseDown = React.useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      // Only the left button starts a drag; ignore middle/right so a right-click
      // over the 8px strip while the left button is held can't open a second,
      // re-entrant drag.
      if (event.button !== 0) return
      event.preventDefault()
      // End any drag still in progress before installing a new one, so the
      // previous drag's window listeners/rAF are always torn down first — a
      // re-entrant mousedown must never orphan an earlier drag's `onMove`.
      endDragRef.current?.()
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
      }
      const onMove = (moveEvent: MouseEvent) => {
        pointerX = moveEvent.clientX
        if (!frame) frame = window.requestAnimationFrame(apply)
      }
      // Teardown. Each closure removes its OWN listeners/rAF unconditionally,
      // BEFORE the guard, so a superseded drag can always detach itself and can
      // never leave this closure's `onMove` pinned to `window` (the leak this
      // ordering fixes). The guard then protects ONLY the shared state
      // (body style, isResizing, endDragRef) so a superseded drag's late
      // teardown doesn't clobber the drag that replaced it. Also runs on `blur`
      // (mouse released outside the window never fires `mouseup`) and from the
      // cleanup effect below.
      const endDrag = () => {
        if (frame) window.cancelAnimationFrame(frame)
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', endDrag)
        window.removeEventListener('blur', endDrag)
        if (endDragRef.current !== endDrag) return
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
    [contentPanelRef]
  )

  // Keyboard resize for the focusable separator handle (WAI-ARIA window-splitter
  // pattern): with `aria-orientation="vertical"`, Left/Right move the splitter.
  // The drawer is right-docked, so ArrowLeft widens it (mirroring a leftward
  // drag) and ArrowRight narrows it; Home/End jump to the drawer's max/min.
  const onResizeHandleKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      let requested: number
      switch (event.key) {
        case 'ArrowLeft':
          requested = widthRef.current + CHAT_DRAWER_KEY_STEP
          break
        case 'ArrowRight':
          requested = widthRef.current - CHAT_DRAWER_KEY_STEP
          break
        case 'Home':
          requested = CHAT_DRAWER_MAX_ABSOLUTE
          break
        case 'End':
          requested = CHAT_DRAWER_MIN_WIDTH
          break
        default:
          return
      }
      event.preventDefault()
      const panelWidth = readPanelWidth(contentPanelRef)
      const next = clampWidth(requested, panelWidth)
      setWidth(next)
    },
    [contentPanelRef]
  )

  // If the drawer hides or the hook unmounts while a drag is live, tear it down
  // so window listeners and the body cursor/user-select overrides never leak.
  React.useEffect(() => {
    if (active) return
    endDragRef.current?.()
  }, [active])
  React.useEffect(() => () => endDragRef.current?.(), [])

  return { width, isResizing, onResizeHandleMouseDown, onResizeHandleKeyDown }
}
