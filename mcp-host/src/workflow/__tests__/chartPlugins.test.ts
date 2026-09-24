/**
 * Number formatting is what the reader actually sees on a chart, so the shapes
 * it produces are pinned here rather than left to the renderer.
 */
import { describe, expect, it } from 'vitest'
import type { Chart } from 'chart.js'
import {
  type ValueLabelOptions,
  formatValue,
  sliceColors,
  valueLabelsPlugin,
} from '../chartPlugins'
import { CHART_THEMES } from '../internalTools'

const base: ValueLabelOptions = {
  format: 'auto',
  textColor: '#000000',
  backgroundColor: '#ffffff',
}

const fmt = (v: number, o: Partial<ValueLabelOptions> = {}): string =>
  formatValue(v, { ...base, ...o })

describe('formatValue', () => {
  it('groups thousands below the abbreviation threshold', () => {
    expect(fmt(1234)).toBe('1,234')
    expect(fmt(999)).toBe('999')
    expect(fmt(-1234)).toBe('-1,234')
  })

  it('abbreviates large numbers under auto', () => {
    expect(fmt(120_000)).toBe('120K')
    expect(fmt(3_400_000)).toBe('3.4M')
    expect(fmt(2_000_000_000)).toBe('2B')
  })

  it('always abbreviates under compact', () => {
    expect(fmt(1500, { format: 'compact' })).toBe('1.5K')
    expect(fmt(950, { format: 'compact' })).toBe('950')
  })

  it('keeps cents under currency and decimals under compact', () => {
    expect(fmt(4.99, { format: 'currency' })).toBe('$4.99')
    expect(fmt(0.25, { format: 'currency' })).toBe('$0.25')
    expect(fmt(1234.5, { format: 'currency' })).toBe('$1,234.50')
    expect(fmt(12.5, { format: 'compact' })).toBe('12.5')
  })

  it('prefixes the symbol under currency', () => {
    expect(fmt(1200, { format: 'currency' })).toBe('$1,200')
    expect(fmt(1_200_000, { format: 'currency' })).toBe('$1.2M')
    expect(fmt(1200, { format: 'currency', currencySymbol: '€' })).toBe('€1,200')
    expect(fmt(-500, { format: 'currency' })).toBe('-$500')
  })

  it('appends the sign under percent', () => {
    expect(fmt(94.5, { format: 'percent' })).toBe('94.5%')
    expect(fmt(12, { format: 'percent' })).toBe('12%')
  })

  it('honours an explicit decimal count', () => {
    expect(fmt(3.14159, { decimals: 2 })).toBe('3.14')
    expect(fmt(3, { decimals: 2 })).toBe('3')
  })

  it('keeps small fractions readable without an explicit count', () => {
    expect(fmt(0.5)).toBe('0.5')
    expect(fmt(12.5)).toBe('12.5')
  })

  it('returns nothing for a value that cannot be drawn', () => {
    expect(fmt(NaN)).toBe('')
    expect(fmt(Infinity)).toBe('')
  })
})

interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** A chart stand-in whose context records every label drawn. */
function fakeChart(
  datasets: number[][],
  at: (di: number, ei: number) => { x: number; y: number; width?: number },
  legend?: Box
) {
  const drawn: Box[] = []
  const ctx = {
    save() {},
    restore() {},
    measureText: (text: string) => ({ width: text.length * 7 }),
    strokeText() {},
    fillText(text: string, x: number, y: number) {
      drawn.push({ x: x - (text.length * 7) / 2, y: y - 7, w: text.length * 7, h: 14 })
    },
  }
  const chart = {
    ctx,
    config: { type: 'bar' },
    data: { datasets: datasets.map(data => ({ data })) },
    width: 200,
    height: 150,
    chartArea: { top: 30, bottom: 130, left: 20, right: 200 },
    legend: legend
      ? { left: legend.x, top: legend.y, right: legend.x + legend.w, bottom: legend.y + legend.h }
      : undefined,
    getDatasetMeta: (di: number) => ({
      hidden: false,
      data: datasets[di].map((_, ei) => ({ ...at(di, ei), base: 130 })),
    }),
  }
  return { chart: chart as unknown as Chart, drawn }
}

const overlaps = (a: Box, b: Box): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

describe('value labels', () => {
  it('skips a label that would print over one already drawn, across series', () => {
    const { chart, drawn } = fakeChart(
      [
        [12000, 8000, 9000],
        [11000, 8500, 9500],
      ],
      // Two series whose marks sit almost on top of each other.
      (di, ei) => ({ x: 40 + ei * 20 + di * 4, y: 60 })
    )
    valueLabelsPlugin({ ...base, fontScale: 1 }).afterDraw!(chart, {} as never, {})
    expect(drawn.length).toBeGreaterThan(0)
    for (let i = 0; i < drawn.length; i++) {
      for (let j = i + 1; j < drawn.length; j++) expect(overlaps(drawn[i], drawn[j])).toBe(false)
    }
  })

  it('keeps a label off the bars of the other series', () => {
    // Grouped bars 10px wide; the short bar's label is wider than its bar.
    const { chart, drawn } = fakeChart([[12000], [219.5]], (di, _ei) => ({
      x: 60 + di * 10,
      y: di === 0 ? 50 : 125,
      width: 10,
    }))
    valueLabelsPlugin({ ...base, fontScale: 1 }).afterDraw!(chart, {} as never, {})
    const tallBar = { x: 55, y: 50, w: 10, h: 80 }
    for (const box of drawn) {
      if (box.x + box.w / 2 > 65) expect(overlaps(box, tallBar)).toBe(false)
    }
    expect(drawn.length).toBe(1)
  })

  it('gives each ring of a doughnut its own share', () => {
    const drawn: string[] = []
    const datasets = [
      [50, 50],
      [10, 30],
    ]
    const chart = {
      ctx: {
        save() {},
        restore() {},
        measureText: (text: string) => ({ width: text.length * 7 }),
        strokeText() {},
        fillText(text: string) {
          drawn.push(text)
        },
      },
      config: { type: 'doughnut' },
      data: { datasets: datasets.map(data => ({ data })) },
      width: 400,
      height: 400,
      chartArea: { top: 0, bottom: 400, left: 0, right: 400 },
      getDatasetMeta: (di: number) => ({
        hidden: false,
        data: datasets[di].map((_, ei) => ({
          getCenterPoint: () => ({ x: 100 + ei * 150, y: 100 + di * 150 }),
          options: {},
        })),
      }),
    }
    valueLabelsPlugin({ ...base, fontScale: 1 }).afterDraw!(
      chart as unknown as Chart,
      {} as never,
      {}
    )
    expect(drawn).toEqual(expect.arrayContaining(['10 (25%)', '30 (75%)', '50 (50%)']))
  })

  it('keeps labels off the legend', () => {
    const legend = { x: 0, y: 40, w: 200, h: 30 }
    const { chart, drawn } = fakeChart([[5, 6]], (_, ei) => ({ x: 60 + ei * 80, y: 50 }), legend)
    valueLabelsPlugin({ ...base, fontScale: 1 }).afterDraw!(chart, {} as never, {})
    for (const box of drawn) expect(overlaps(box, legend)).toBe(false)
  })
})

describe('slice colors', () => {
  const palette = ['#1e40af', '#059669', '#dc2626']

  it('pads a short list from the palette rather than cycling it', () => {
    const { colors, padded } = sliceColors(4, ['#16a34a', '#f59e0b'], palette, '#ffffff')
    expect(colors.slice(0, 2)).toEqual(['#16a34a', '#f59e0b'])
    expect(new Set(colors).size).toBe(4)
    expect(padded).toBe(true)
  })

  it('shades the palette past its end, and never gives the last slice the first color', () => {
    const { colors, repeated } = sliceColors(8, undefined, palette, '#ffffff')
    expect(new Set(colors).size).toBe(8)
    expect(repeated).toBe(false)
    const many = sliceColors(40, undefined, palette, '#ffffff')
    expect(many.colors[39]).not.toBe(many.colors[0])
    expect(many.repeated).toBe(true)
  })

  it.each(Object.entries(CHART_THEMES))('gives %s at least 14 distinct slice colors', (_, t) => {
    const { colors, repeated } = sliceColors(14, undefined, t.palette, t.backgroundColor)
    expect(new Set(colors).size).toBe(14)
    expect(repeated).toBe(false)
  })
})

describe('chart themes', () => {
  const luminance = (hex: string): number => {
    const [r, g, b] = [1, 3, 5].map(i => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const contrast = (a: string, b: string): number => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
    return (hi + 0.05) / (lo + 0.05)
  }

  it.each(Object.entries(CHART_THEMES))('%s draws secondary text at 4.5:1 or more', (_, theme) => {
    expect(contrast(theme.mutedTextColor, theme.backgroundColor)).toBeGreaterThanOrEqual(4.5)
  })
})
