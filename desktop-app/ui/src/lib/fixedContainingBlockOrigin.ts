/**
 * Viewport origin of the block a `position: fixed` element is laid out
 * against. Normally that is the viewport (origin 0,0), but a transform/filter
 * ancestor (e.g. a backdrop-filtered, scrollable modal) becomes the fixed
 * containing block, so `left`/`top` are measured from its (possibly scrolled)
 * box. The offset between where the element is drawn and its own inline
 * left/top is that origin; a viewport position is translated by it.
 */
export function fixedContainingBlockOrigin(element: HTMLElement): { left: number; top: number } {
  const rect = element.getBoundingClientRect()
  return {
    left: rect.left - (parseFloat(element.style.left) || 0),
    top: rect.top - (parseFloat(element.style.top) || 0),
  }
}
