/**
 * Native PowerPoint charts: how a chart spec is read, and the pptxgenjs
 * arguments it becomes.
 */
import { describe, expect, it } from 'vitest'
import { ChartSpecError, type NativeChart, nativeChartArgs, readNativeChart } from '../pptxCharts'

const style = { colors: ['#111111', '#222222'], textColor: '#000000', mutedColor: '#666666' }
const pptx = {
  charts: { BAR: 'bar', LINE: 'line', PIE: 'pie', AREA: 'area', DOUGHNUT: 'doughnut' },
} as const

describe('readNativeChart', () => {
  it('reads labels and datasets nested under data or at the top', () => {
    const nested = readNativeChart(
      { type: 'bar', data: { labels: ['a', 'b'], datasets: [{ label: 'x', data: [1, '1,200'] }] } },
      'slides[0].chart',
      []
    )
    expect(nested).toEqual({
      type: 'bar',
      labels: ['a', 'b'],
      series: [{ name: 'x', values: [1, 1200] }],
    })
    const top = readNativeChart(
      { type: 'line', labels: ['a'], datasets: [{ label: 'x', data: [2] }] },
      'c',
      []
    )
    expect(top?.series[0].values).toEqual([2])
  })

  it('draws a bar chart when no type is given, and says so', () => {
    const warnings: string[] = []
    const chart = readNativeChart({ labels: ['a'], datasets: [{ data: [1] }] }, 'c', warnings)
    expect(chart?.type).toBe('bar')
    expect(warnings[0]).toContain('c.type was missing')
  })

  it('has nothing to read without data', () => {
    expect(readNativeChart({ type: 'bar' }, 'c', [])).toBeUndefined()
  })

  it('names the field of a type PowerPoint cannot draw, and the way out', () => {
    expect(() =>
      readNativeChart({ type: 'radar', labels: ['a'], datasets: [{ data: [1] }] }, 'c', [])
    ).toThrow(ChartSpecError)
    expect(() =>
      readNativeChart({ type: 'radar', labels: ['a'], datasets: [{ data: [1] }] }, 'c', [])
    ).toThrow(/c\.type "radar" has no native PowerPoint chart.*clerum__generate_chart/)
  })
})

describe('a pie or doughnut reads only the series it draws', () => {
  it('is not rejected for a value in a series it leaves out', () => {
    const warnings: string[] = []
    const chart = readNativeChart(
      {
        type: 'pie',
        labels: ['A', 'B'],
        datasets: [{ data: [60, 40] }, { data: ['n/a'] }],
      },
      'c',
      warnings
    )
    expect(chart?.series).toEqual([{ name: '#1', values: [60, 40] }])
    expect(warnings.join(' ')).toContain('1 more were left out')
  })

  it('takes no decimal convention and no category from it', () => {
    // Alone, '1.250' reads two ways and is refused; a dropped '1,100.5' must not settle it.
    expect(() =>
      readNativeChart(
        { type: 'doughnut', labels: ['A'], datasets: [{ data: ['1.250'] }, { data: ['1,100.5'] }] },
        'c',
        []
      )
    ).toThrow(ChartSpecError)
    const labelled = readNativeChart(
      {
        type: 'pie',
        datasets: [
          {
            data: [
              { label: 'A', value: 1 },
              { label: 'B', value: 2 },
            ],
          },
          { data: [{ label: 'C', value: 3 }] },
        ],
      },
      'c',
      []
    )
    expect(labelled?.labels).toEqual(['A', 'B'])
  })
})

describe('nativeChartArgs', () => {
  const chart = (over: Partial<NativeChart>): NativeChart => ({
    type: 'bar',
    labels: ['a', 'b'],
    series: [{ name: 's', values: [1, 2] }],
    ...over,
  })

  it('maps each type to the pptxgenjs chart and bar direction', () => {
    expect(nativeChartArgs(chart({ type: 'horizontalBar' }), style, pptx).options.barDir).toBe(
      'bar'
    )
    expect(nativeChartArgs(chart({ type: 'stackedArea' }), style, pptx).type).toBe('area')
    expect(nativeChartArgs(chart({ type: 'doughnut' }), style, pptx).type).toBe('doughnut')
  })

  it('gives a lone bar series one color, not one per bar', () => {
    expect(nativeChartArgs(chart({}), style, pptx).options.chartColors).toEqual(['#111111'])
  })

  it('formats values with their decimals, grouped from a thousand', () => {
    const small = nativeChartArgs(chart({ series: [{ name: 's', values: [1.5, 2] }] }), style, pptx)
    expect(small.options.dataLabelFormatCode).toBe('[>=1000]#,##0;[<=-1000]-#,##0;General')
    const large = nativeChartArgs(
      chart({ series: [{ name: 's', values: [1200.25, 3] }] }),
      style,
      pptx
    )
    expect(large.options.dataLabelFormatCode).toBe('#,##0.00')
    expect(large.options.valAxisLabelFormatCode).toBe('#,##0')
  })
})
