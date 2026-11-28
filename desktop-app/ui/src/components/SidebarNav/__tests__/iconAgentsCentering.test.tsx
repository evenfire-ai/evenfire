// @vitest-environment jsdom
/**
 * IconAgents centering — same defect class as BUG-79 (IconSettings): the
 * robot glyph's ink box is biased in the 24×24 viewBox, and every housing
 * that grid-centers the svg (agents row circle, sidebar nav) inherits the
 * bias, so the glyph looks off-center inside its circle. Screenshot-free
 * proof: recompute the ink bounding box of the path data and require it to
 * be centered on (12, 12) after the rendered <g> translate.
 *
 * The path uses M/C/H/V/Z only. Cubic segments stay inside the convex hull
 * of their control points, and every extreme here (antenna ball top y=0.5,
 * body bottom y=21, ear edges x=0/x=24) is reached by an on-curve point, so
 * collecting on-curve points plus cubic control points yields the exact ink
 * box for this path.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { IconAgents } from '../icons'

afterEach(() => cleanup())

function parseTranslate(transform: string | null): [number, number] {
  if (!transform) return [0, 0]
  const match = /translate\((-?\d*\.?\d+)[ ,]+(-?\d*\.?\d+)\)/.exec(transform)
  if (!match) return [0, 0]
  return [parseFloat(match[1]!), parseFloat(match[2]!)]
}

type Cursor = { x: number; y: number; command: string | null }

/** Absolute M/C/H/V points plus cubic control points (hull bound). */
function pathInkPoints(d: string): Array<[number, number]> {
  const tokens = d.match(/[MCHVZ]|-?\d*\.?\d+/g) ?? []
  const points: Array<[number, number]> = []
  const cursor: Cursor = { x: 0, y: 0, command: null }
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!
    if (/[A-Za-z]/.test(token)) {
      cursor.command = token
      continue
    }
    const value = parseFloat(token)
    if (cursor.command === 'M' || cursor.command === 'C') {
      cursor.x = value
      cursor.y = parseFloat(tokens[index + 1]!)
      index += 1
      points.push([cursor.x, cursor.y])
    } else if (cursor.command === 'H') {
      cursor.x = value
      points.push([cursor.x, cursor.y])
    } else if (cursor.command === 'V') {
      cursor.y = value
      points.push([cursor.x, cursor.y])
    }
  }
  return points
}

describe('IconAgents centering (agents row circle)', () => {
  it('keeps the robot glyph ink box centered in the 24×24 viewBox', () => {
    const { container } = render(<IconAgents />)
    const svg = container.querySelector('svg')
    const group = svg?.querySelector('g')
    const path = svg?.querySelector('path')
    expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24')
    expect(path?.getAttribute('d')).toBeTruthy()

    const [dx, dy] = parseTranslate(group?.getAttribute('transform') ?? null)
    const points = pathInkPoints(path!.getAttribute('d')!).map(
      ([x, y]) => [x + dx, y + dy] as [number, number]
    )
    const xs = points.map(point => point[0])
    const ys = points.map(point => point[1])
    const box = {
      left: Math.min(...xs),
      right: Math.max(...xs),
      top: Math.min(...ys),
      bottom: Math.max(...ys),
    }

    // Ears at x 0 and 24; antenna ball top 0.5; body bottom 21 — before the
    // translate the vertical center is 10.75, biased 1.25 units high.
    expect(box.left + (box.right - box.left) / 2).toBeCloseTo(12, 10)
    expect(box.top + (box.bottom - box.top) / 2).toBeCloseTo(12, 10)
  })
})
