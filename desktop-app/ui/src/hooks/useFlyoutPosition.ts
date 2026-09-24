import { useCallback, useLayoutEffect, useState } from 'react'
import type { RefObject } from 'react'
import { computeFlyoutPosition } from '@lib/flyoutPosition'
import type { FlyoutPlacement, FlyoutPosition } from '@lib/flyoutPosition'

type UseFlyoutPositionArgs = {
  anchorRef: RefObject<HTMLElement | null>
  flyoutRef: RefObject<HTMLElement | null>
  open: boolean
  placement: FlyoutPlacement
  // The confining ancestor. Its rect confines the flyout on the horizontal
  // axis (left/right) only; the vertical axis always uses the viewport,
  // whatever the placement — placement flips which side the flyout opens to,
  // not which axis the ancestor bounds. Defaults to the right-docked chat
  // drawer, whose ancestors clip overflow.
  boundsSelector?: string
  gap?: number
  inset?: number
}

// Positions a portaled flyout (rendered to document.body) at fixed viewport
// coordinates computed from its anchor, confined to the rect of `boundsSelector`
// (or the viewport when that ancestor is absent or has zero width — e.g. jsdom,
// or a full-screen mount outside the drawer). Recomputes on open, resize,
// capture-phase scroll, and any size change of the anchor, flyout, or bounds
// ancestor (which covers dragging the drawer's resize handle). Returns null
// until the first layout pass; render the flyout hidden at the origin until then
// so it never flashes in the top-left corner.
export function useFlyoutPosition({
  anchorRef,
  flyoutRef,
  open,
  placement,
  boundsSelector = '.chat-drawer',
  gap,
  inset,
}: UseFlyoutPositionArgs): FlyoutPosition | null {
  const [position, setPosition] = useState<FlyoutPosition | null>(null)

  const update = useCallback(() => {
    const anchor = anchorRef.current
    const flyout = flyoutRef.current
    if (!anchor || !flyout) return

    const anchorRect = anchor.getBoundingClientRect()
    const flyoutRect = flyout.getBoundingClientRect()
    const boundsEl = anchor.closest<HTMLElement>(boundsSelector)
    const boundsRect = boundsEl?.getBoundingClientRect()
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    // A zero-width bounds rect means the ancestor is absent or unlaid-out
    // (jsdom reports every rect as 0). Fall back to the full viewport so the
    // flyout is never clamped to a degenerate box.
    const bounds =
      boundsRect && boundsRect.width > 0
        ? { left: boundsRect.left, right: boundsRect.right, top: 0, bottom: viewportHeight }
        : { left: 0, right: viewportWidth, top: 0, bottom: viewportHeight }

    setPosition(computeFlyoutPosition({ anchorRect, flyoutRect, bounds, placement, gap, inset }))
  }, [anchorRef, boundsSelector, flyoutRef, gap, inset, placement])

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null)
      return
    }

    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    const anchor = anchorRef.current
    const boundsEl = anchor?.closest<HTMLElement>(boundsSelector)
    if (anchor) resizeObserver?.observe(anchor)
    if (flyoutRef.current) resizeObserver?.observe(flyoutRef.current)
    if (boundsEl) resizeObserver?.observe(boundsEl)

    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
      resizeObserver?.disconnect()
    }
  }, [anchorRef, boundsSelector, flyoutRef, open, update])

  return position
}
