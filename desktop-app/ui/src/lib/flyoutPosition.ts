// Pure geometry for a portaled flyout (submenu / dropdown). Kept free of the
// DOM and `window` so it is unit-testable under jsdom, which performs no layout.
// The runtime wiring (reading rects, listeners, ResizeObserver) lives in
// `@hooks/useFlyoutPosition`. Semantics mirror GfsResourceMenu's
// `positionSubmenu`/`positionPanel`: prefer a side, flip to the opposite side
// when the preferred side would cross the bounds, then clamp inside the bounds.

export type FlyoutPlacement = 'right-of' | 'below'

// Only the fields the geometry reads. A DOMRect satisfies this shape.
export type FlyoutAnchorRect = {
  left: number
  right: number
  top: number
  bottom: number
}

export type FlyoutSize = {
  width: number
  height: number
}

// The rectangle the flyout must stay inside, in viewport coordinates. The
// caller supplies the confining ancestor's rect (e.g. `.chat-drawer`) for the
// axis that must be confined and the viewport for the other axis.
export type FlyoutBounds = {
  left: number
  right: number
  top: number
  bottom: number
}

export type ComputeFlyoutPositionArgs = {
  anchorRect: FlyoutAnchorRect
  flyoutRect: FlyoutSize
  bounds: FlyoutBounds
  placement: FlyoutPlacement
  gap?: number
  inset?: number
}

export type FlyoutPosition = {
  left: number
  top: number
}

const DEFAULT_GAP = 6
const DEFAULT_INSET = 8

function clamp(value: number, min: number, max: number): number {
  // `max` can fall below `min` when the flyout is wider/taller than the bounds;
  // keep the near edge pinned rather than letting the range invert.
  return Math.min(Math.max(min, value), Math.max(min, max))
}

export function computeFlyoutPosition({
  anchorRect,
  flyoutRect,
  bounds,
  placement,
  gap = DEFAULT_GAP,
  inset = DEFAULT_INSET,
}: ComputeFlyoutPositionArgs): FlyoutPosition {
  // Inset the usable area so the flyout never touches the confining edge.
  const area = {
    left: bounds.left + inset,
    right: bounds.right - inset,
    top: bounds.top + inset,
    bottom: bounds.bottom - inset,
  }

  if (placement === 'right-of') {
    const preferredLeft = anchorRect.right + gap
    // Flip to the anchor's left side when opening rightward would overflow.
    const opensLeft = preferredLeft + flyoutRect.width > area.right
    const candidateLeft = opensLeft ? anchorRect.left - flyoutRect.width - gap : preferredLeft
    const left = clamp(candidateLeft, area.left, area.right - flyoutRect.width)
    const top = clamp(anchorRect.top, area.top, area.bottom - flyoutRect.height)
    return { left, top }
  }

  // 'below': drop under the anchor, flip above only when there is room above.
  const preferredTop = anchorRect.bottom + gap
  const opensAbove =
    preferredTop + flyoutRect.height > area.bottom &&
    anchorRect.top - gap - flyoutRect.height >= area.top
  const candidateTop = opensAbove ? anchorRect.top - flyoutRect.height - gap : preferredTop
  const top = clamp(candidateTop, area.top, area.bottom - flyoutRect.height)
  const left = clamp(anchorRect.left, area.left, area.right - flyoutRect.width)
  return { left, top }
}
