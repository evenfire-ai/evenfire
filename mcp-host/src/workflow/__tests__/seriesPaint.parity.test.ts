// The PNG chart and the dashboard paint the same chart alike: each color of
// each series plays the same role (palette color, its tint, the caller's color
// or its tint) in both outputs, although one writes hex and the other tokens.
import { describe, expect, it } from 'vitest'
import { normalizeChartData } from '../chartData'
import { paintedDatasets } from '../chartDatasets'
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

type Own = Record<string, string | string[]>

/** Two series; the caller's colors, if any, on the first. */
function chartData(kind: string, own: Own) {
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
function roles(ds: Record<string, unknown>, palette: Palette, own: Own) {
  const name = (value: unknown): string => {
    if (value === undefined) return 'none'
    if (Array.isArray(value)) return `[${value.map(name).join(', ')}]`
    if (value === palette.color) return 'palette'
    if (value === palette.tint) return 'palette tint'
    for (const [key, colors] of Object.entries(own)) {
      for (const [i, color] of (Array.isArray(colors) ? colors : [colors]).entries()) {
        const which = Array.isArray(colors) ? `own ${key}[${i}]` : `own ${key}`
        if (value === color) return which
        if (value === tintOf(color)) return `${which} tint`
      }
    }
    return `other ${JSON.stringify(value)}`
  }
  return {
    border: name(ds.borderColor),
    fill: name(ds.backgroundColor),
    points: name(ds.pointBackgroundColor),
  }
}

function pngRoles(kind: string, own: Own) {
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

/** The first dataset each output draws. */
function pngDataset(kind: string, own: Own): Record<string, unknown> {
  const normalized = normalizeChartData(chartData(kind, own), { chartType: kind })
  const { datasets } = paintedDatasets(
    kind,
    normalized.datasets as never,
    normalized.labels,
    theme,
    {},
    []
  )
  return datasets[0] as unknown as Record<string, unknown>
}

function dashboardDataset(kind: string, own: Own): Record<string, unknown> {
  return prepareDashboardChart({ type: kind, ...chartData(kind, own) }, 'charts[0]').chart!
    .datasets[0]
}

function dashboardRoles(kind: string, own: Own) {
  const prepared = prepareDashboardChart({ type: kind, ...chartData(kind, own) }, 'charts[0]')
  expect(prepared.error).toBeUndefined()
  return prepared.chart!.datasets.map((ds, i) =>
    roles(ds, { color: `$chart-${i}`, tint: `$chart-${i}@0.2` }, own)
  )
}

const OWN_COLORS: Own[] = [
  {},
  { borderColor: ['#ff0000', '#00ff00', '#0000ff'] },
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

  it('fills a bubble in its solid color, as both outputs did before', () => {
    for (const each of [pngRoles('bubble', {}), dashboardRoles('bubble', {})]) {
      expect(each[0]).toEqual({ border: 'palette', fill: 'palette', points: 'none' })
    }
  })

  it("draws a caller's bar color as the outline it is, over the palette fill", () => {
    // A white or transparent border must not hide the bar it outlines.
    for (const borderColor of ['#f00', '#ffffff', 'transparent']) {
      const own = { borderColor }
      for (const each of [pngRoles('stackedBar', own), dashboardRoles('stackedBar', own)]) {
        expect(each[0]).toEqual({ border: 'own borderColor', fill: 'palette', points: 'none' })
      }
      expect(pngDataset('stackedBar', own).borderWidth).toBe(2)
      expect(dashboardDataset('stackedBar', own).borderWidth).toBe(2)
    }
    expect(pngDataset('bar', {}).borderWidth).toBeUndefined()
    expect(dashboardDataset('bar', {}).borderWidth).toBeUndefined()
  })

  it('reads an empty borderColor list as no color', () => {
    const own = { borderColor: [] as string[] }
    for (const kind of ['bar', 'scatter', 'line'] as const) {
      expect(pngRoles(kind, own)[0].fill).toBe(kind === 'line' ? 'palette tint' : 'palette')
      expect(dashboardRoles(kind, own)[0].fill).toBe(kind === 'line' ? 'palette tint' : 'palette')
    }
  })

  it('wraps a short color list over a fill list with gaps, as Chart.js wraps it', () => {
    const own = {
      borderColor: ['#ff0000', '#00ff00'],
      backgroundColor: ['#0000ff', '#0000ff', 'brand'],
    }
    // A stacked area is filled in the series color, so its gap takes the wrapped border color.
    for (const each of [pngDataset('stackedArea', own), dashboardDataset('stackedArea', own)]) {
      expect(each.backgroundColor).toEqual(['#0000ff', '#0000ff', '#ff0000'])
    }
  })

  it("colors each scatter point and line point with the caller's color for it", () => {
    const own = { borderColor: ['#ff0000', '#00ff00'] }
    for (const each of [pngRoles('scatter', own), dashboardRoles('scatter', own)]) {
      expect(each[0].fill).toBe('[own borderColor[0], own borderColor[1]]')
    }
    // A short list wraps over the values, as Chart.js wraps it.
    for (const each of [pngRoles('line', own), dashboardRoles('line', own)]) {
      expect(each[0].points).toBe('[own borderColor[0], own borderColor[1]]')
    }
  })

  it('leaves out a color that is not a CSS color, in both outputs, with a warning', () => {
    const own = { borderColor: 'brand-blue' }
    expect(pngRoles('stackedArea', own)).toEqual(dashboardRoles('stackedArea', own))
    expect(pngRoles('stackedArea', own)[0]).toEqual({
      border: 'palette',
      fill: 'palette',
      points: 'palette',
    })
    const warnings: string[] = []
    const normalized = normalizeChartData(chartData('stackedArea', own), {
      chartType: 'stackedArea',
    })
    paintedDatasets(
      'stackedArea',
      normalized.datasets as never,
      normalized.labels,
      theme,
      {},
      warnings
    )
    expect(warnings.join(' ')).toContain('"brand-blue" is not a CSS color')
  })

  it('does not call a full list of slice colors short when one is not a CSS color', () => {
    const warnings: string[] = []
    const data = {
      labels: ['A', 'B', 'C'],
      datasets: [{ data: [1, 2, 3], backgroundColor: ['#f00', 'brand', '#00f'] }],
    }
    const normalized = normalizeChartData(data, { chartType: 'pie' })
    paintedDatasets('pie', normalized.datasets as never, normalized.labels, theme, {}, warnings)
    expect(warnings.join(' ')).toContain('"brand" is not a CSS color')
    expect(warnings.join(' ')).not.toContain('color(s) for 3 slices')
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
