/**
 * What chart data gets repaired (with a warning) and what gets rejected (with a
 * message naming the field).
 */
import { describe, expect, it } from 'vitest'
import { ChartDataError, coerceNumber, normalizeChartData } from '../chartData'

const bar = { chartType: 'bar' as const }

function expectRejected(fn: () => unknown): string {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(ChartDataError)
    return (err as Error).message
  }
  throw new Error('expected the input to be rejected')
}

describe('coerceNumber', () => {
  it('reads the numeric forms models write', () => {
    expect(coerceNumber(42)).toBe(42)
    expect(coerceNumber('120')).toBe(120)
    expect(coerceNumber('1,234.5')).toBe(1234.5)
    expect(coerceNumber('$1,200')).toBe(1200)
    expect(coerceNumber('45%')).toBe(45)
    expect(coerceNumber('-17.5')).toBe(-17.5)
    expect(coerceNumber('1.2K')).toBe(1200)
    expect(coerceNumber('3M')).toBe(3_000_000)
  })

  it('reads accounting parentheses, a plus sign and the scale words as written', () => {
    expect(coerceNumber('(1,200)')).toBe(-1200)
    expect(coerceNumber('($45.5)')).toBe(-45.5)
    expect(coerceNumber('+12')).toBe(12)
    expect(coerceNumber('\u221212.5')).toBe(-12.5)
    expect(coerceNumber('2.5bn')).toBe(2_500_000_000)
    expect(coerceNumber('4mn')).toBe(4_000_000)
    expect(coerceNumber('987,65')).toBe(987.65)
    expect(coerceNumber('1.234,50')).toBe(1234.5)
    expect(coerceNumber("1'234.50")).toBe(1234.5)
  })

  it('reads no number out of units, a lowercase m or a locale-dependent grouping', () => {
    expect(coerceNumber('100 MB')).toBeUndefined()
    expect(coerceNumber('12 kg')).toBeUndefined()
    expect(coerceNumber('5m')).toBeUndefined()
    expect(coerceNumber('1.200')).toBeUndefined()
    expect(coerceNumber('~5')).toBeUndefined()
  })

  it('refuses text with no number rather than defaulting to zero', () => {
    expect(coerceNumber('none')).toBeUndefined()
    expect(coerceNumber('')).toBeUndefined()
    expect(coerceNumber(null)).toBeUndefined()
    expect(coerceNumber(NaN)).toBeUndefined()
    expect(coerceNumber(Infinity)).toBeUndefined()
  })
})

describe('normalizeChartData — repairs', () => {
  it('reads values written as strings and says it did', () => {
    const r = normalizeChartData(
      { labels: ['a', 'b'], datasets: [{ label: 'x', data: ['120', '190'] }] },
      bar
    )
    expect(r.datasets[0].data).toEqual([120, 190])
    expect(r.warnings.join(' ')).toContain('written as text')
  })

  it('reads comma decimals when the series writes them unambiguously, and lists what it read', () => {
    const r = normalizeChartData(
      { labels: ['A', 'B', 'C'], datasets: [{ data: ['1.234,50', '987,65', '1.200'] }] },
      bar
    )
    expect(r.datasets[0].data).toEqual([1234.5, 987.65, 1200])
    const note = r.warnings.join(' ')
    expect(note).toContain("'987,65' as 987.65")
    expect(note).toContain("'1.200' as 1200")
  })

  it('reads dot decimals when the series writes them unambiguously', () => {
    const r = normalizeChartData(
      { labels: ['A', 'B'], datasets: [{ data: ['1,234.50', '1.200'] }] },
      bar
    )
    expect(r.datasets[0].data).toEqual([1234.5, 1.2])
  })

  it('reads accounting parentheses as negative', () => {
    const r = normalizeChartData(
      { labels: ['A', 'B'], datasets: [{ data: ['(1,200)', '500'] }] },
      bar
    )
    expect(r.datasets[0].data).toEqual([-1200, 500])
  })

  it('uses a numeric x as the category on a line chart and says so', () => {
    const r = normalizeChartData(
      {
        datasets: [
          {
            data: [
              { x: 10, y: 2 },
              { x: 20, y: 3 },
            ],
          },
        ],
      },
      { chartType: 'line' }
    )
    expect(r.labels).toEqual(['10', '20'])
    expect(r.datasets[0].data).toEqual([2, 3])
    const note = r.warnings.join(' ')
    expect(note).toContain('{x, y}')
    expect(note).not.toContain('{label, value}')
    expect(note).not.toContain('numbered')
  })

  it('reads [x, y] pairs on a scatter and [label, value] pairs on a category chart', () => {
    const scatter = normalizeChartData(
      {
        datasets: [
          {
            data: [
              [1, 2],
              [2, 3],
            ],
          },
        ],
      },
      { chartType: 'scatter' }
    )
    expect(scatter.datasets[0].data).toEqual([
      { x: 1, y: 2 },
      { x: 2, y: 3 },
    ])
    const bars = normalizeChartData(
      {
        datasets: [
          {
            data: [
              ['Jan', 5],
              ['Feb', 7],
            ],
          },
        ],
      },
      bar
    )
    expect(bars.labels).toEqual(['Jan', 'Feb'])
    expect(bars.datasets[0].data).toEqual([5, 7])
  })

  it('does not note missing labels for a gauge, which draws none', () => {
    const r = normalizeChartData({ datasets: [{ data: [72] }] }, { chartType: 'gauge' })
    expect(r.warnings.join(' ')).not.toContain('labels')
  })

  it('reads {label, value} records and adopts their labels', () => {
    const r = normalizeChartData(
      {
        datasets: [
          {
            label: 'Spend',
            data: [
              { label: 'Compute', value: 268 },
              { label: 'Storage', value: 120 },
            ],
          },
        ],
      },
      bar
    )
    expect(r.datasets[0].data).toEqual([268, 120])
    expect(r.labels).toEqual(['Compute', 'Storage'])
  })

  it('accepts the {name, count} synonyms', () => {
    const r = normalizeChartData(
      {
        datasets: [
          {
            data: [
              { name: 'A', count: 3 },
              { name: 'B', count: 5 },
            ],
          },
        ],
      },
      bar
    )
    expect(r.datasets[0].data).toEqual([3, 5])
    expect(r.labels).toEqual(['A', 'B'])
  })

  it('numbers the positions when labels are missing on a category chart', () => {
    const r = normalizeChartData({ datasets: [{ data: [1, 2, 3] }] }, bar)
    expect(r.labels).toEqual(['1', '2', '3'])
    expect(r.warnings.join(' ')).toContain('labels')
  })

  it('reconciles a label count that disagrees with the values', () => {
    const r = normalizeChartData(
      { labels: ['Jan', 'Feb'], datasets: [{ data: [1, 2, 3, 4, 5] }] },
      { chartType: 'line' }
    )
    expect(r.labels).toHaveLength(5)
    expect(r.warnings.join(' ')).toContain('the missing labels were numbered 3..5')
    expect(r.warnings.join(' ')).toContain('one label per value')
  })

  it('says labels past the last value were left out', () => {
    const r = normalizeChartData({ labels: ['a', 'b', 'c'], datasets: [{ data: [1] }] }, bar)
    expect(r.labels).toEqual(['a'])
    expect(r.warnings.join(' ')).toContain('the labels past 1 were left out')
  })

  it('keeps nulls as gaps rather than plotting them as zero', () => {
    const r = normalizeChartData(
      { labels: ['a', 'b', 'c'], datasets: [{ data: [1, null, 3] }] },
      { chartType: 'line' }
    )
    expect(r.datasets[0].data).toEqual([1, null, 3])
  })

  it('warns when every value is zero, because the plot will look empty', () => {
    const r = normalizeChartData({ labels: ['a', 'b'], datasets: [{ data: [0, 0] }] }, bar)
    expect(r.warnings.join(' ')).toContain('empty plot')
  })

  it('turns plain numbers into coordinates for a scatter and says so', () => {
    const r = normalizeChartData({ datasets: [{ data: [5, 9, 3] }] }, { chartType: 'scatter' })
    expect(r.datasets[0].data).toEqual([
      { x: 0, y: 5 },
      { x: 1, y: 9 },
      { x: 2, y: 3 },
    ])
    expect(r.warnings.join(' ')).toContain('index')
  })

  it('gives a bubble point a default radius when none was sent', () => {
    const r = normalizeChartData(
      { datasets: [{ data: [{ x: 1, y: 2 }] }] },
      { chartType: 'bubble' }
    )
    expect(r.datasets[0].data[0]).toMatchObject({ x: 1, y: 2 })
    expect((r.datasets[0].data[0] as { r: number }).r).toBeGreaterThan(0)
  })

  it('notes that a single-series type drops the extra datasets', () => {
    const r = normalizeChartData(
      { labels: ['a'], datasets: [{ data: [1] }, { data: [2] }] },
      { chartType: 'funnel' }
    )
    expect(r.warnings.join(' ')).toContain('`data.datasets[1]`: "funnel" draws a single series')
    const gauge = normalizeChartData(
      { datasets: [{ data: [40] }, { data: [50] }, { data: [60] }] },
      { chartType: 'gauge' }
    )
    expect(gauge.warnings.join(' ')).toContain('`data.datasets[1..2]`')
  })

  it('carries explicit colors through untouched', () => {
    const r = normalizeChartData(
      { labels: ['a'], datasets: [{ data: [1], backgroundColor: '#ff0000', fill: true }] },
      bar
    )
    expect(r.datasets[0].backgroundColor).toBe('#ff0000')
    expect(r.datasets[0].fill).toBe(true)
  })

  it('says a pie cannot show values below zero, and a bar chart says nothing', () => {
    const data = { labels: ['Loss', 'North', 'South'], datasets: [{ data: [-10, 20, -3] }] }
    const pie = normalizeChartData(data, { chartType: 'pie' })
    expect(pie.datasets[0].data).toEqual([-10, 20, -3])
    expect(pie.warnings.join(' ')).toContain(
      '`data.datasets[0]` has 2 value(s) below zero, which a pie cannot show'
    )
    expect(normalizeChartData(data, bar).warnings.join(' ')).not.toContain('below zero')
  })
})

describe('normalizeChartData — rejections', () => {
  it('rejects a missing data argument', () => {
    expect(expectRejected(() => normalizeChartData(undefined, bar))).toContain('`data` is required')
  })

  it('rejects datasets that are absent or empty', () => {
    expect(expectRejected(() => normalizeChartData({}, bar))).toContain('datasets')
    expect(expectRejected(() => normalizeChartData({ datasets: [] }, bar))).toContain('empty')
  })

  it('rejects an empty series instead of drawing a blank plot', () => {
    const msg = expectRejected(() =>
      normalizeChartData({ labels: [], datasets: [{ data: [] }] }, bar)
    )
    expect(msg).toContain('data.datasets[0].data')
    expect(msg).toContain('empty')
  })

  it('rejects objects with no numeric value and names the fix', () => {
    const msg = expectRejected(() =>
      normalizeChartData({ datasets: [{ data: [{ label: 'a', amountish: 3 }] }] }, bar)
    )
    expect(msg).toContain('data.datasets[0].data[0]')
    expect(msg).toContain('value')
  })

  it('rejects text that holds no number', () => {
    const msg = expectRejected(() =>
      normalizeChartData({ labels: ['a'], datasets: [{ data: ['none'] }] }, bar)
    )
    expect(msg).toContain('holds no number')
  })

  it('rejects a value with a unit and names the unit', () => {
    const msg = expectRejected(() =>
      normalizeChartData({ labels: ['a', 'b'], datasets: [{ data: ['100 MB', 5] }] }, bar)
    )
    expect(msg).toContain('data.datasets[0].data[0]')
    expect(msg).toContain("'MB'")
  })

  it('rejects a lowercase m instead of reading it as million', () => {
    const msg = expectRejected(() =>
      normalizeChartData({ labels: ['a'], datasets: [{ data: ['5m'] }] }, bar)
    )
    expect(msg).toContain("'5m'")
    expect(msg).toContain('5M')
  })

  it('rejects a grouping that reads two ways when nothing else settles it', () => {
    const msg = expectRejected(() =>
      normalizeChartData({ labels: ['a'], datasets: [{ data: ['1.200'] }] }, bar)
    )
    expect(msg).toContain('1.2 or 1200')
    expect(msg).toContain('JSON numbers')
  })

  it('rejects a series that mixes dot and comma decimals', () => {
    const msg = expectRejected(() =>
      normalizeChartData({ labels: ['a', 'b'], datasets: [{ data: ['1,234.50', '987,65'] }] }, bar)
    )
    expect(msg).toContain('JSON numbers')
  })

  it('rejects NaN and Infinity', () => {
    expect(
      expectRejected(() => normalizeChartData({ datasets: [{ data: [NaN] }] }, bar))
    ).toContain('finite')
    expect(
      expectRejected(() => normalizeChartData({ datasets: [{ data: [Infinity] }] }, bar))
    ).toContain('finite')
  })

  it('rejects a series that is entirely null', () => {
    expect(
      expectRejected(() => normalizeChartData({ datasets: [{ data: [null, null] }] }, bar))
    ).toContain('no usable value')
  })

  it('requires labels for a slice chart, which is unreadable without them', () => {
    const msg = expectRejected(() =>
      normalizeChartData({ datasets: [{ data: [1, 2, 3] }] }, { chartType: 'pie' })
    )
    expect(msg).toContain('labels')
  })

  it('rejects a scatter point missing a coordinate', () => {
    const msg = expectRejected(() =>
      normalizeChartData({ datasets: [{ data: [{ x: 1 }] }] }, { chartType: 'scatter' })
    )
    expect(msg).toContain('`x` and `y`')
  })

  it('names the point shape when a scatter point is neither a pair nor an object', () => {
    const msg = expectRejected(() =>
      normalizeChartData({ datasets: [{ data: [true] }] }, { chartType: 'scatter' })
    )
    expect(msg).toContain('{x, y}')
  })

  it('rejects a data field that is not an array', () => {
    expect(expectRejected(() => normalizeChartData({ datasets: [{ data: 42 }] }, bar))).toContain(
      'must be an array'
    )
  })
})

describe('normalizeChartData — field paths', () => {
  it('names the fields where the caller keeps the chart', () => {
    const opts = { chartType: 'pie', path: 'data.charts[2]' }
    expect(expectRejected(() => normalizeChartData({ datasets: [{ data: [1] }] }, opts))).toContain(
      '`data.charts[2].labels`'
    )
    expect(expectRejected(() => normalizeChartData({ datasets: [] }, opts))).toContain(
      '`data.charts[2].datasets`'
    )
    const { warnings } = normalizeChartData(
      { labels: ['a', 'b', 'c'], datasets: [{ data: ['1', 2] }] },
      { chartType: 'bar', path: 'data.charts[0]' }
    )
    expect(warnings.join(' ')).toContain('data.charts[0].datasets[0]')
    expect(warnings.join(' ')).toContain('`data.charts[0].labels` had 3 entries')
  })

  it('keeps naming `data` for callers that pass no path', () => {
    expect(expectRejected(() => normalizeChartData({ datasets: [] }, bar))).toContain(
      '`data.datasets`'
    )
  })
})

describe('values that name their label', () => {
  it('keep their order when their labels name none of the given ones', () => {
    const pairs = normalizeChartData(
      {
        labels: ['Mon', 'Tue', 'Wed'],
        datasets: [
          {
            data: [
              [0, 5],
              [1, 6],
              [2, 7],
            ],
          },
        ],
      },
      { chartType: 'line' }
    )
    expect(pairs.labels).toEqual(['Mon', 'Tue', 'Wed'])
    expect(pairs.datasets[0].data).toEqual([5, 6, 7])
    expect(pairs.warnings.join(' ')).toContain('name none of `data.labels`')
    const captions = normalizeChartData(
      {
        labels: ['Q1', 'Q2', 'Q3'],
        datasets: [
          {
            data: [
              { label: 'Revenue', value: 10 },
              { label: 'Revenue', value: 11 },
              { label: 'Revenue', value: 12 },
            ],
          },
        ],
      },
      { chartType: 'bar' }
    )
    expect(captions.datasets[0].data).toEqual([10, 11, 12])
  })

  it('match the given labels whatever their case', () => {
    const r = normalizeChartData(
      {
        labels: ['Jan', 'Feb'],
        datasets: [
          {
            data: [
              { label: 'feb', value: 2 },
              { label: 'jan', value: 1 },
            ],
          },
        ],
      },
      { chartType: 'bar' }
    )
    expect(r.labels).toEqual(['Jan', 'Feb'])
    expect(r.datasets[0].data).toEqual([1, 2])
  })

  it('are placed at their label, not in the order sent', () => {
    const r = normalizeChartData(
      {
        labels: ['Jan', 'Feb'],
        datasets: [
          {
            label: 'Rev',
            data: [
              { label: 'Feb', value: 200 },
              { label: 'Jan', value: 100 },
            ],
          },
        ],
      },
      bar
    )
    expect(r.labels).toEqual(['Jan', 'Feb'])
    expect(r.datasets[0].data).toEqual([100, 200])
    expect(r.warnings.join(' ')).toContain('placed at that label')
  })

  it('line series up by label, leaving a gap where a series has no value', () => {
    const r = normalizeChartData(
      {
        datasets: [
          {
            label: 'North',
            data: [
              ['Jan', 1],
              ['Feb', 2],
              ['Mar', 3],
            ],
          },
          {
            label: 'South',
            data: [
              { label: 'Mar', value: 30 },
              { label: 'Jan', value: 10 },
            ],
          },
        ],
      },
      { chartType: 'line' }
    )
    expect(r.labels).toEqual(['Jan', 'Feb', 'Mar'])
    expect(r.datasets[1].data).toEqual([10, null, 30])
  })
})

describe('single-series charts', () => {
  it('count only the series they draw when numbering missing labels', () => {
    const r = normalizeChartData(
      {
        labels: ['Start', 'Sales', 'Costs'],
        datasets: [
          { label: 'Delta', data: [100, 50, -30] },
          { label: 'Other', data: [1, 2, 3, 4, 5] },
        ],
      },
      { chartType: 'waterfall' }
    )
    expect(r.labels).toEqual(['Start', 'Sales', 'Costs'])
  })
})
