// @vitest-environment jsdom
/**
 * BUG-79 — the settings gear must be centered in its 24×24 viewBox, because
 * every housing (sidebar nav icon, menu item icon, settings card tile)
 * grid-centers the svg box and inherits whatever bias the glyph itself
 * carries. Screenshot-free proof: recompute the arc-exact ink bounding box of
 * the rendered path data (endpoints plus the extreme points that actually lie
 * on each arc's sweep), apply the rendered <g> transform, and require the box
 * to be centered on (12, 12).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { IconSettings } from '../icons'

afterEach(() => cleanup())

interface ArcPoint {
  x1: number
  y1: number
  rx: number
  ry: number
  laf: number
  sf: number
  x2: number
  y2: number
}

/** Absolute M/h/v/l coordinates plus arc extremes, W3C F.6 endpoint→center. */
function pathInkPoints(d: string): Array<[number, number]> {
  const tokens = d.match(/[MmhHlLvVaAzZ]|-?\d*\.?\d+/g) ?? []
  const points: Array<[number, number]> = []
  let x = 0
  let y = 0
  let command: string | null = null
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!
    if (/[a-zA-Z]/.test(token)) {
      command = token
      if (command === 'M') command = 'L'
      continue
    }
    const value = parseFloat(token)
    if (command === 'M' || command === 'L') {
      x = value
      y = parseFloat(tokens[index + 1]!)
      index += 1
      points.push([x, y])
    } else if (command === 'h') {
      x += value
      points.push([x, y])
    } else if (command === 'v') {
      y += value
      points.push([x, y])
    } else if (command === 'l') {
      x += value
      y += parseFloat(tokens[index + 1]!)
      index += 1
      points.push([x, y])
    } else if (command === 'a') {
      const arc: ArcPoint = {
        x1: x,
        y1: y,
        rx: value,
        ry: parseFloat(tokens[index + 1]!),
        laf: parseFloat(tokens[index + 3]!),
        sf: parseFloat(tokens[index + 4]!),
        x2: x + parseFloat(tokens[index + 5]!),
        y2: y + parseFloat(tokens[index + 6]!),
      }
      index += 6
      points.push([arc.x2, arc.y2])
      const x1p = (arc.x1 - arc.x2) / 2
      const y1p = (arc.y1 - arc.y2) / 2
      const denominator = arc.rx * arc.rx * y1p * y1p + arc.ry * arc.ry * x1p * x1p
      if (denominator === 0) continue
      const numerator = arc.rx * arc.rx * arc.ry * arc.ry - denominator
      let coefficient = Math.sqrt(Math.max(0, numerator / denominator))
      if (arc.laf === arc.sf) coefficient = -coefficient
      const cx = (coefficient * arc.rx * y1p) / arc.ry + (arc.x1 + arc.x2) / 2
      const cy = (-coefficient * arc.ry * x1p) / arc.rx + (arc.y1 + arc.y2) / 2
      if (Math.abs(Math.hypot(arc.x1 - cx, arc.y1 - cy) - arc.rx) > 0.05) continue
      const startAngle = Math.atan2(arc.y1 - cy, arc.x1 - cx)
      const endAngle = Math.atan2(arc.y2 - cy, arc.x2 - cx)
      let sweep = endAngle - startAngle
      if (arc.sf === 1 && sweep < 0) sweep += 2 * Math.PI
      if (arc.sf === 0 && sweep > 0) sweep -= 2 * Math.PI
      for (const axis of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
        let delta = axis - startAngle
        if (arc.sf === 1 && delta < 0) delta += 2 * Math.PI
        if (arc.sf === 0 && delta > 0) delta -= 2 * Math.PI
        const onArc = arc.sf === 1 ? delta <= sweep + 0.01 : delta >= sweep - 0.01
        if (onArc) points.push([cx + arc.rx * Math.cos(axis), cy + arc.ry * Math.sin(axis)])
      }
      x = arc.x2
      y = arc.y2
    }
  }
  return points
}

function parseTranslate(transform: string | null): [number, number] {
  if (!transform) return [0, 0]
  const match = transform.match(/translate\(\s*(-?[\d.]+)[\s,]+(-?[\d.]+)?\s*\)/)
  if (!match) return [0, 0]
  return [parseFloat(match[1]!), match[2] === undefined ? 0 : parseFloat(match[2])]
}

describe('IconSettings centering (BUG-79)', () => {
  it('keeps the gear glyph ink box centered in the 24×24 viewBox', () => {
    const { container } = render(<IconSettings />)
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
    const centerX = (Math.min(...xs) + Math.max(...xs)) / 2
    const centerY = (Math.min(...ys) + Math.max(...ys)) / 2

    // The hub circle shares the group translate, so the whole glyph moves as
    // one; the corrected box must sit within 0.005 units of the viewBox center.
    expect(centerX).toBeGreaterThanOrEqual(12 - 0.005)
    expect(centerX).toBeLessThanOrEqual(12 + 0.005)
    expect(centerY).toBeGreaterThanOrEqual(12 - 0.005)
    expect(centerY).toBeLessThanOrEqual(12 + 0.005)
  })
})
