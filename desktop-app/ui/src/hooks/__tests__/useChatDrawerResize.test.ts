import { describe, expect, it } from 'vitest'
import { CHAT_DRAWER_MIN_WIDTH, clampWidth, widthForCursor } from '../useChatDrawerResize'

// R2-M1: the drawer resize hook's pure logic (clamp, drag mapping) had no direct
// coverage — an inverted min/max or a reversed drag direction would leave every
// DOM-level test green. These pin the pieces at their boundaries so a
// sign/comparison mistake turns red.

// EMBED_FLOOR (460) + GUTTER_EXTRA (46) = 506 reserved for the docked embed.
const EMBED_RESERVE = 506

describe('clampWidth', () => {
  it('floors a below-minimum request at CHAT_DRAWER_MIN_WIDTH', () => {
    expect(clampWidth(100, 2000)).toBe(CHAT_DRAWER_MIN_WIDTH) // 340
  })

  it('returns an in-range request rounded to a whole pixel', () => {
    expect(clampWidth(500.4, 2000)).toBe(500)
    expect(clampWidth(400.6, 2000)).toBe(401)
  })

  it('caps at the absolute ceiling (820) even on a very wide panel', () => {
    expect(clampWidth(5000, 3000)).toBe(820)
  })

  it('falls back to the absolute ceiling when the panel is unmeasured (<= 0)', () => {
    expect(clampWidth(5000, 0)).toBe(820)
  })
})

describe('clampWidth embed floor (docked sizing)', () => {
  // The dynamic max reserves EMBED_FLOOR + GUTTER_EXTRA for the app embed so a
  // narrowing panel shrinks the drawer instead of collapsing the embed. This is
  // the exact function the ResizeObserver `sync` re-clamps the width with, so
  // these cases mirror the runtime re-clamp on window narrowing.
  it('caps the drawer so exactly EMBED_FLOOR (460) of embed remains as the panel narrows', () => {
    // panel 1200 - 506 = 694 (below the 820 ceiling): drawer maxes at 694,
    // leaving embed = 1200 - 694 - 46(gutter) = 460 = EMBED_FLOOR.
    const panelWidth = 1200
    const width = clampWidth(5000, panelWidth)
    expect(width).toBe(panelWidth - EMBED_RESERVE) // 694
    expect(panelWidth - width - 46).toBe(460) // embed floor preserved
  })

  it('re-clamps a previously-wide width down when the panel shrinks below the reserve', () => {
    // A width picked at a wide panel (e.g. 700) no longer fits once the panel is
    // 1000 wide: dynamic max = 1000 - 506 = 494, so the width is pulled to 494.
    expect(clampWidth(700, 1000)).toBe(494)
  })

  it('never shrinks the drawer below CHAT_DRAWER_MIN_WIDTH when the panel is very narrow', () => {
    // panel 700 - 506 = 194, floored back up to MIN (340). Below this the embed
    // simply keeps shrinking and scrolls; the drawer holds its minimum.
    expect(clampWidth(5000, 700)).toBe(CHAT_DRAWER_MIN_WIDTH) // 340
    expect(clampWidth(300, 700)).toBe(CHAT_DRAWER_MIN_WIDTH) // 340
  })
})

describe('widthForCursor', () => {
  // The drawer's right edge is fixed; width = rightEdge - pointerX. A leftward drag
  // (smaller pointerX) must WIDEN the drawer, a rightward drag must narrow it.
  it('maps the cursor to rightEdge - pointerX, clamped', () => {
    expect(widthForCursor(1000, 400, 2000)).toBe(600)
  })

  it('widens as the cursor moves left (smaller pointerX)', () => {
    expect(widthForCursor(1000, 300, 2000)).toBeGreaterThan(widthForCursor(1000, 400, 2000))
  })

  it('narrows toward the minimum as the cursor moves right past the min', () => {
    expect(widthForCursor(1000, 900, 2000)).toBe(CHAT_DRAWER_MIN_WIDTH) // rightEdge-pointerX = 100 -> 340
  })
})
