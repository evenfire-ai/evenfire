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

/** Minimum content-panel width at which the docked drawer and the app embed can
 *  still coexist: the drawer already pinned to its own minimum (340) PLUS the
 *  embed at its legible floor (460) PLUS the fixed gutter term (46) = 846. Below
 *  this the two no longer fit side by side, so there is no split to show and the
 *  drawer auto-suppresses (the app takes the full width). Derived from its three
 *  inputs — never a bare literal — so it always tracks them if any one moves. */
export const CHAT_DRAWER_MIN_PANEL_WIDTH =
  CHAT_DRAWER_MIN_WIDTH + CHAT_DRAWER_GUTTER_EXTRA + CHAT_DRAWER_EMBED_FLOOR

/** Clamp a user-requested width to the panel-independent absolute bounds
 *  [MIN, MAX_ABSOLUTE], rounded to a whole pixel. This is what we persist as the
 *  user's INTENT (`requestedWidth`): it must survive a transient narrowing so a
 *  later widen can restore it. The dynamic embed-floor cap is applied on top at
 *  render time via `clampWidth(requestedWidth, panelWidth)`, never baked into the
 *  stored intent (that was the L2 "shrinks and never reverts" bug). */
function clampRequested(requested: number): number {
  return Math.round(Math.max(CHAT_DRAWER_MIN_WIDTH, Math.min(CHAT_DRAWER_MAX_ABSOLUTE, requested)))
}

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

export type ChatDrawerResize = {
  /** Current drawer width in px, already clamped to the live panel. */
  width: number
  /** True while a drag is in progress (for handle feedback). */
  isResizing: boolean
  /** True when the content panel is measured (> 0) and narrower than
   *  `CHAT_DRAWER_MIN_PANEL_WIDTH`: the drawer can't coexist with the embed, so
   *  the caller suppresses it (hides it, app takes full width) WITHOUT touching
   *  the user's open/closed intent, and shows it again on re-widen. Stays `false`
   *  while the panel is unmeasured (0, e.g. during mount) so the drawer is never
   *  suppressed on a phantom zero width. */
  panelTooNarrow: boolean
  /** mousedown handler for the drag handle on the drawer's left edge. */
  onResizeHandleMouseDown: (event: React.MouseEvent<HTMLElement>) => void
  /** keydown handler for the (focusable) drag handle — arrow/Home/End resize. */
  onResizeHandleKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void
}

export function useChatDrawerResize(
  contentPanelRef: RefObject<HTMLElement | null>,
  active: boolean
): ChatDrawerResize {
  // `requestedWidth` is the user's INTENT (drag/keyboard target); the rendered
  // width is `clampWidth(requestedWidth, panelWidth)`. Separating them is what
  // lets a transient narrowing shrink the applied width WITHOUT losing the
  // requested one, so a later widen restores it (L2 fix). `panelWidth` is the
  // live content-panel measurement kept in state so the render re-clamps and the
  // narrow-threshold re-derives whenever the panel resizes.
  const [requestedWidth, setRequestedWidth] = React.useState(CHAT_DRAWER_DEFAULT_WIDTH)
  const [panelWidth, setPanelWidth] = React.useState(0)
  const [isResizing, setIsResizing] = React.useState(false)
  const width = clampWidth(requestedWidth, panelWidth)
  const panelTooNarrow = panelWidth > 0 && panelWidth < CHAT_DRAWER_MIN_PANEL_WIDTH
  // Mirrors the rendered width so the pointer/keyboard handlers (stable
  // callbacks) can read the current applied value as the base for a relative
  // resize without re-subscribing on every width change.
  const widthRef = React.useRef(width)
  widthRef.current = width
  // Teardown of an in-progress drag, stored so a cleanup effect can invoke it
  // if the drawer hides or the hook unmounts mid-drag (see below).
  const endDragRef = React.useRef<(() => void) | null>(null)

  // Track the live content-panel width while the drawer is DESIRED (available &&
  // open), not only while visible — the panel stays mounted when the drawer is
  // suppressed for being too narrow, and we must keep measuring it to notice the
  // re-widen that brings the drawer back. A ResizeObserver on the panel also
  // fires on window resize (the panel is full-height flex), so no separate
  // window listener is needed. Storing the measurement re-derives both the
  // clamped width and `panelTooNarrow`; because the drawer is `position: fixed`
  // and the gutter is `padding-right` on a child, neither its visibility nor its
  // width changes the panel's `clientWidth` — so there is no feedback loop and no
  // flicker at the threshold.
  React.useEffect(() => {
    if (!active) return
    const panel = contentPanelRef.current
    if (!panel) return
    const sync = () => {
      const measured = readPanelWidth(contentPanelRef)
      setPanelWidth(prev => (prev === measured ? prev : measured))
    }
    sync()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(sync)
    observer.observe(panel)
    return () => observer.disconnect()
  }, [active, contentPanelRef])

  const onResizeHandleMouseDown = React.useCallback((event: React.MouseEvent<HTMLElement>) => {
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
      // Record the raw cursor target as the requested intent (clamped only to
      // the absolute bounds); the render applies the dynamic embed-floor cap on
      // top, so the drag stops following the cursor at the cap yet the intent
      // is preserved for a later widen.
      setRequestedWidth(clampRequested(rightEdge - pointerX))
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
  }, [])

  // Keyboard resize for the focusable separator handle (WAI-ARIA window-splitter
  // pattern): with `aria-orientation="vertical"`, Left/Right move the splitter.
  // The drawer is right-docked, so ArrowLeft widens it (mirroring a leftward
  // drag) and ArrowRight narrows it; Home/End jump to the drawer's max/min.
  const onResizeHandleKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLElement>) => {
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
    // Arrows step from the current APPLIED width so the splitter visibly moves
    // on every press even when the requested intent sits above the dynamic cap;
    // Home/End set an absolute intent. The render clamps to the live panel.
    setRequestedWidth(clampRequested(requested))
  }, [])

  // If the drawer hides or the hook unmounts while a drag is live, tear it down
  // so window listeners and the body cursor/user-select overrides never leak.
  React.useEffect(() => {
    if (active) return
    endDragRef.current?.()
  }, [active])
  React.useEffect(() => () => endDragRef.current?.(), [])

  return {
    width,
    isResizing,
    panelTooNarrow,
    onResizeHandleMouseDown,
    onResizeHandleKeyDown,
  }
}
