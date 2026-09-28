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
  // Element to resolve the confining ancestor (`boundsSelector`) from, when the
  // position anchor is itself portaled OUT of that ancestor. `closest()` walks
  // the DOM tree, so a portaled anchor (e.g. a submenu button rendered inside a
  // menu that portals to document.body) can no longer reach `.chat-drawer` and
  // would fall back to the full viewport. This ref must live INSIDE the
  // confining ancestor (e.g. the still-in-tree trigger). Defaults to
  // `anchorRef`, so omitting it preserves today's behavior exactly.
  boundsAnchorRef?: RefObject<HTMLElement | null>
  // Optional dependency that forces a reposition when its value changes, even
  // though no resize/scroll/ResizeObserver notification fired. Needed when this
  // flyout's anchor is a DOM child of ANOTHER portaled flyout: when that parent
  // repositions through a batched React commit, the anchor moves with it, but a
  // position-only change emits no ResizeObserver callback, so `update` never
  // re-runs and this flyout keeps the pre-move offset. Pass the parent's
  // committed `FlyoutPosition` here to re-measure after it commits. Omitting it
  // leaves behavior byte-for-byte unchanged — the recompute effect no-ops.
  recomputeKey?: unknown
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
  boundsAnchorRef,
  recomputeKey,
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
    // Resolve the confining ancestor from `boundsAnchorRef` when supplied — the
    // position anchor may be portaled out of that ancestor and unable to reach
    // it via `closest`.
    const boundsAnchor = boundsAnchorRef?.current ?? anchor
    const boundsEl = boundsAnchor.closest<HTMLElement>(boundsSelector)
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
  }, [anchorRef, boundsAnchorRef, boundsSelector, flyoutRef, gap, inset, placement])

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
    // Observe the same confining ancestor `update()` resolves, so dragging the
    // drawer's resize handle re-positions the flyout even when the position
    // anchor is portaled out of the drawer.
    const boundsEl = (boundsAnchorRef?.current ?? anchor)?.closest<HTMLElement>(boundsSelector)
    if (anchor) resizeObserver?.observe(anchor)
    if (flyoutRef.current) resizeObserver?.observe(flyoutRef.current)
    if (boundsEl) resizeObserver?.observe(boundsEl)

    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
      resizeObserver?.disconnect()
    }
  }, [anchorRef, boundsAnchorRef, boundsSelector, flyoutRef, open, update])

  // Recompute after a dependency that shifts the anchor's on-screen position
  // WITHOUT emitting a resize/scroll notification of its own — e.g. a PARENT
  // flyout that repositioned through a batched React commit. When this flyout's
  // anchor is a DOM child of that parent, the anchor moved, but a position-only
  // change fires no ResizeObserver, so `update` never re-runs. Passing the
  // parent's committed position as `recomputeKey` re-measures after it commits.
  // Guarded on `!== undefined` so callers that omit it are byte-for-byte
  // unchanged (no extra render). Kept separate from the observer effect above so
  // it never churns the resize/scroll subscription.
  useLayoutEffect(() => {
    if (open && recomputeKey !== undefined) update()
  }, [open, recomputeKey, update])

  return position
}
