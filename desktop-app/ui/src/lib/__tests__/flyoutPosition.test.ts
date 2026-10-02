import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { computeFlyoutPosition } from '../flyoutPosition'
import type { FlyoutBounds, FlyoutPlacement } from '../flyoutPosition'

// A tall viewport so vertical clamping never interferes with the horizontal cases.
const DRAWER: FlyoutBounds = { left: 660, right: 1000, top: 0, bottom: 800 }
const WIDE: FlyoutBounds = { left: 0, right: 2000, top: 0, bottom: 2000 }
const INSET = 8

describe('computeFlyoutPosition — right-of (submenu)', () => {
  it('flips to the anchor left side and clamps inside the bounds when the right side overflows', () => {
    // Anchor hugs the drawer's right edge, so opening rightward would overflow.
    const anchorRect = { left: 880, right: 900, top: 100, bottom: 120 }
    const { left, top } = computeFlyoutPosition({
      anchorRect,
      flyoutRect: { width: 210, height: 300 },
      bounds: DRAWER,
      placement: 'right-of',
    })
    // Actually flipped to the anchor's LEFT: the whole flyout ends at or before
    // the anchor's left edge. Containment alone (below) does NOT prove this —
    // the no-flip candidate (782) also fits inside the bounds via the clamp, so
    // an assertion on bounds only would stay green if the flip logic were
    // removed. Pin the exact left (flip 664 -> clamped to the inset edge 668).
    expect(left).toBe(668)
    expect(left + 210).toBeLessThanOrEqual(anchorRect.left)
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

// Property-based coverage (T2) for the pure geometry: the case tests above pin
// a handful of hand-picked rects, but flip/clamp precedence has far more
// combinations than a human enumerates. The domain invariant that must hold for
// EVERY input where the flyout fits inside the inset area is containment: the
// result never crosses any inset edge. (When the flyout is larger than the area
// the clamp intentionally pins the near edge and lets the far one overflow, so
// the property is conditioned on fitting.) Idempotence/composability from the
// T2 checklist don't apply — this is a single-pass placement, not a merge.
describe('computeFlyoutPosition — containment property', () => {
  const EPS = 1e-9
  it('keeps a flyout that fits inside the inset area fully within it, for any anchor/placement', () => {
    fc.assert(
      fc.property(
        fc.record({
          boundsLeft: fc.integer({ min: 0, max: 1000 }),
          boundsTop: fc.integer({ min: 0, max: 1000 }),
          boundsW: fc.integer({ min: 100, max: 2000 }),
          boundsH: fc.integer({ min: 100, max: 2000 }),
          inset: fc.integer({ min: 0, max: 24 }),
          gap: fc.integer({ min: 0, max: 24 }),
          anchorLeft: fc.integer({ min: -500, max: 2500 }),
          anchorTop: fc.integer({ min: -500, max: 2500 }),
          anchorW: fc.integer({ min: 0, max: 300 }),
          anchorH: fc.integer({ min: 0, max: 300 }),
          // Fraction (0..100%) of the available area used for the flyout size,
          // so the flyout fits inside the inset area by construction.
          widthPct: fc.integer({ min: 0, max: 100 }),
          heightPct: fc.integer({ min: 0, max: 100 }),
          placement: fc.constantFrom<FlyoutPlacement>('right-of', 'below'),
        }),
        p => {
          const bounds: FlyoutBounds = {
            left: p.boundsLeft,
            right: p.boundsLeft + p.boundsW,
            top: p.boundsTop,
            bottom: p.boundsTop + p.boundsH,
          }
          const area = {
            left: bounds.left + p.inset,
            right: bounds.right - p.inset,
            top: bounds.top + p.inset,
            bottom: bounds.bottom - p.inset,
          }
          const areaW = area.right - area.left
          const areaH = area.bottom - area.top
          // boundsW/H >= 100 and inset <= 24 keep the inset area non-degenerate.
          const width = (areaW * p.widthPct) / 100
          const height = (areaH * p.heightPct) / 100
          const { left, top } = computeFlyoutPosition({
            anchorRect: {
              left: p.anchorLeft,
              right: p.anchorLeft + p.anchorW,
              top: p.anchorTop,
              bottom: p.anchorTop + p.anchorH,
            },
            flyoutRect: { width, height },
            bounds,
            placement: p.placement,
            gap: p.gap,
            inset: p.inset,
          })
          expect(left).toBeGreaterThanOrEqual(area.left - EPS)
          expect(left + width).toBeLessThanOrEqual(area.right + EPS)
          expect(top).toBeGreaterThanOrEqual(area.top - EPS)
          expect(top + height).toBeLessThanOrEqual(area.bottom + EPS)
        }
      ),
      { numRuns: 10000 }
    )
  })
})
