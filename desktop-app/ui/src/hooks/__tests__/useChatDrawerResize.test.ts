import { describe, expect, it } from 'vitest'
import {
  CHAT_DRAWER_MIN_WIDTH,
  clampWidth,
  computeChatDrawerOverlay,
  widthForCursor,
} from '../useChatDrawerResize'

// R2-M1: the drawer resize hook's pure logic (clamp, overlay flip, drag mapping)
// had no direct coverage — an inverted min/max, a flipped overlay comparison, or a
// reversed drag direction would leave every DOM-level test green. These pin the
// three pieces at their boundaries so a sign/comparison mistake turns red.

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

  it('tightens the dynamic max to panelWidth - margin on a narrow panel', () => {
    // panelWidth 600 - VIEWPORT_MARGIN 80 = 520, below the 820 absolute ceiling.
    expect(clampWidth(5000, 600)).toBe(520)
  })

  it('falls back to the absolute ceiling when the panel is unmeasured (<= 0)', () => {
    expect(clampWidth(5000, 0)).toBe(820)
  })
})

describe('computeChatDrawerOverlay', () => {
  // embedWidth = panelWidth - drawerWidth - GUTTER_EXTRA(46); overlay when < OVERLAY_EMBED_MIN(460).
  it('does not overlay when the embed column is exactly at the threshold (460)', () => {
    // 966 - 460 - 46 = 460 -> not below 460 -> false
    expect(computeChatDrawerOverlay(966, 460)).toBe(false)
  })

  it('overlays as soon as the embed column drops one pixel below the threshold', () => {
    // 965 - 460 - 46 = 459 -> below 460 -> true
    expect(computeChatDrawerOverlay(965, 460)).toBe(true)
  })

  it('does not overlay on a wide panel', () => {
    expect(computeChatDrawerOverlay(2000, 420)).toBe(false)
  })

  it('overlays on a narrow panel', () => {
    expect(computeChatDrawerOverlay(800, 420)).toBe(true)
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
