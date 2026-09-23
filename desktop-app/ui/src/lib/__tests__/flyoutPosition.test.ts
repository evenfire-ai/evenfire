import { describe, expect, it } from 'vitest'
import { computeFlyoutPosition } from '../flyoutPosition'
import type { FlyoutBounds } from '../flyoutPosition'

// A tall viewport so vertical clamping never interferes with the horizontal cases.
const DRAWER: FlyoutBounds = { left: 660, right: 1000, top: 0, bottom: 800 }
const WIDE: FlyoutBounds = { left: 0, right: 2000, top: 0, bottom: 2000 }
const INSET = 8

describe('computeFlyoutPosition — right-of (submenu)', () => {
  it('flips to the anchor left side and clamps inside the bounds when the right side overflows', () => {
    // Anchor hugs the drawer's right edge, so opening rightward would overflow.
    const { left, top } = computeFlyoutPosition({
      anchorRect: { left: 880, right: 900, top: 100, bottom: 120 },
      flyoutRect: { width: 210, height: 300 },
      bounds: DRAWER,
      placement: 'right-of',
    })
    // Never crosses the inset drawer edges.
    expect(left).toBeGreaterThanOrEqual(DRAWER.left)
    expect(left + 210).toBeLessThanOrEqual(DRAWER.right - INSET)
    // Vertically aligned to the anchor's top.
    expect(top).toBe(100)
  })

  it('opens to the right when there is room', () => {
    const { left } = computeFlyoutPosition({
      anchorRect: { left: 80, right: 100, top: 100, bottom: 120 },
      flyoutRect: { width: 210, height: 300 },
      bounds: WIDE,
      placement: 'right-of',
      gap: 6,
    })
    // anchor.right + gap = 106; fits, so no flip.
    expect(left).toBe(106)
  })

  it('clamps the top so a low anchor keeps the flyout inside the bounds', () => {
    const { top } = computeFlyoutPosition({
      anchorRect: { left: 700, right: 720, top: 780, bottom: 800 },
      flyoutRect: { width: 210, height: 300 },
      bounds: DRAWER,
      placement: 'right-of',
    })
    // maxTop = (bottom - inset) - height = 792 - 300 = 492.
    expect(top).toBe(492)
  })
})

describe('computeFlyoutPosition — below (dropdown)', () => {
  it('drops under the anchor, left-aligned, clamped into the bounds', () => {
    const { left, top } = computeFlyoutPosition({
      anchorRect: { left: 100, right: 200, top: 100, bottom: 120 },
      flyoutRect: { width: 210, height: 150 },
      bounds: DRAWER,
      placement: 'below',
      gap: 6,
    })
    // Left anchor (100) is left of the inset drawer edge (668), so it clamps in.
    expect(left).toBe(DRAWER.left + INSET)
    expect(left + 210).toBeLessThanOrEqual(DRAWER.right - INSET)
    // Drops below: anchor.bottom + gap.
    expect(top).toBe(126)
  })

  it('keeps the full-screen anchor left when the viewport has room', () => {
    const { left, top } = computeFlyoutPosition({
      anchorRect: { left: 300, right: 420, top: 60, bottom: 84 },
      flyoutRect: { width: 240, height: 200 },
      bounds: WIDE,
      placement: 'below',
      gap: 6,
    })
    expect(left).toBe(300)
    expect(top).toBe(90)
  })

  it('flips above the anchor only when the drop below overflows and there is room above', () => {
    const { top } = computeFlyoutPosition({
      anchorRect: { left: 700, right: 800, top: 500, bottom: 520 },
      flyoutRect: { width: 210, height: 300 },
      bounds: { left: 660, right: 1000, top: 0, bottom: 600 },
      placement: 'below',
      gap: 6,
    })
    // Below (526 + 300 = 826) overflows bottom (600 - 8 = 592); above fits
    // (500 - 6 - 300 = 194 >= 8), so it opens above.
    expect(top).toBe(194)
  })
})
