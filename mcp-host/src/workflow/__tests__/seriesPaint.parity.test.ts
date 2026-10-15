// The PNG chart and the dashboard paint the same chart alike: each color of
// each series plays the same role (palette color, its tint, the caller's color
// or its tint) in both outputs, although one writes hex and the other tokens.
import { describe, expect, it } from 'vitest'
import { normalizeChartData } from '../chartData'
import { paintedDatasets } from '../chartGenerator'
import { CHART_THEMES } from '../chartThemes'
import { prepareDashboardChart } from '../dashboardCharts'
import { tintOf } from '../seriesPaint'

const theme = CHART_THEMES.light

const KINDS = [
  'bar',
  'horizontalBar',
  'stackedBar',
  'line',
  'area',
  'stackedArea',
  'radar',
  'scatter',
  'bubble',
  'mixedBarLine',
] as const

const XY = new Set(['scatter', 'bubble'])

/** Two series; the caller's colors, if any, on the first. */
function chartData(kind: string, own: Record<string, string>) {
  const values = XY.has(kind)
    ? (k: number) => [
        { x: 1, y: 2 * k, ...(kind === 'bubble' ? { r: 4 } : {}) },
        { x: 2, y: 3 * k, ...(kind === 'bubble' ? { r: 6 } : {}) },
      ]
    : (k: number) => [1 * k, 2 * k, 3 * k]
  return {
    ...(XY.has(kind) ? {} : { labels: ['a', 'b', 'c'] }),
    datasets: [
      { label: 'One', data: values(1), ...own },
      { label: 'Two', data: values(2) },
    ],
  }
}

type Palette = { color: string; tint: string }

/** What each color of a series is, independent of how the output writes it. */
function roles(ds: Record<string, unknown>, palette: Palette, own: Record<string, string>) {
  const name = (value: unknown): string => {
    if (value === undefined) return 'none'
    if (value === palette.color) return 'palette'
    if (value === palette.tint) return 'palette tint'
    for (const [key, color] of Object.entries(own)) {
      if (value === color) return `own ${key}`
      if (value === tintOf(color)) return `own ${key} tint`
    }
    return `other ${JSON.stringify(value)}`
  }
  return {
    border: name(ds.borderColor),
    fill: name(ds.backgroundColor),
    points: name(ds.pointBackgroundColor),
  }
}

function pngRoles(kind: string, own: Record<string, string>) {
  const normalized = normalizeChartData(chartData(kind, own), { chartType: kind })
  const { datasets } = paintedDatasets(
    kind,
    normalized.datasets as never,
    normalized.labels,
    theme,
    {},
    []
  )
  return datasets.map((ds, i) => {
    const color = theme.palette[i % theme.palette.length]
    return roles(ds as unknown as Record<string, unknown>, { color, tint: `${color}33` }, own)
  })
}

function dashboardRoles(kind: string, own: Record<string, string>) {
  const prepared = prepareDashboardChart({ type: kind, ...chartData(kind, own) }, 'charts[0]')
  expect(prepared.error).toBeUndefined()
  return prepared.chart!.datasets.map((ds, i) =>
    roles(ds, { color: `$chart-${i}`, tint: `$chart-${i}@0.2` }, own)
  )
}

const OWN_COLORS: Array<Record<string, string>> = [
  {},
  { borderColor: '#ff0000' },
  { borderColor: '#f00' },
  { borderColor: 'red' },
  { borderColor: 'rgb(255, 0, 0)' },
  { backgroundColor: '#22c55e' },
  { borderColor: 'red', backgroundColor: '#22c55e' },
]

describe('the PNG chart and the dashboard paint a series alike', () => {
  for (const kind of KINDS) {
    it.each(OWN_COLORS)(`${kind} with %j`, own => {
      expect(pngRoles(kind, own)).toEqual(dashboardRoles(kind, own))
    })
  }
})

describe('how a series is painted', () => {
  it('fills a stacked area in its solid color: the areas do not overlap', () => {
    for (const each of [pngRoles('stackedArea', {}), dashboardRoles('stackedArea', {})]) {
      expect(each[0]).toEqual({ border: 'palette', fill: 'palette', points: 'palette' })
    }
  })

  it('draws the points of a radar in the series color, over its tinted web', () => {
    for (const each of [pngRoles('radar', {}), dashboardRoles('radar', {})]) {
      expect(each[0]).toEqual({ border: 'palette', fill: 'palette tint', points: 'palette' })
    }
  })

  it("tints a line's fill and colors its points from the caller's line color", () => {
    const own = { borderColor: '#f00' }
    for (const each of [pngRoles('area', own), dashboardRoles('area', own)]) {
      expect(each[0]).toEqual({
        border: 'own borderColor',
        fill: 'own borderColor tint',
        points: 'own borderColor',
      })
    }
  })

  it("keeps a caller's fill on scatter marks", () => {
    const own = { backgroundColor: '#22c55e' }
    for (const each of [pngRoles('scatter', own), dashboardRoles('scatter', own)]) {
      expect(each[0]).toEqual({ border: 'palette', fill: 'own backgroundColor', points: 'none' })
    }
  })

  it('falls back to the palette tint for a color chart.js cannot read', () => {
    const own = { borderColor: 'oklch(0.6 0.2 30)' }
    for (const each of [pngRoles('line', own), dashboardRoles('line', own)]) {
      expect(each[0]).toEqual({
        border: 'own borderColor',
        fill: 'palette tint',
        points: 'own borderColor',
      })
    }
  })
})
