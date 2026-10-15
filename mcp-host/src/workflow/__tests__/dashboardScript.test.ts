/**
 * The dashboard's page script, run on its own against a minimal DOM and a
 * Chart stub, with chart specs written here rather than produced by the tool.
 */
import { describe, expect, it } from 'vitest'
import { safeJsonForScript } from '../dashboardHtml'
import { dashboardScript } from '../dashboardScript'

interface Config {
  type: string
  data: { labels: unknown[]; datasets: Array<Record<string, unknown>> }
  options: Record<string, any>
  plugins: Array<{ afterDatasetsDraw: (chart: unknown) => void }>
}

interface FakeChart {
  id: string
  config: Config
  data: Config['data']
  options: Config['options']
  updates: unknown[]
  resized: number
  destroyed: boolean
}

interface Page {
  charts: Map<string, FakeChart>
  /** Text of each note that replaced a chart's container. */
  notes: string[]
  /** Ids of the canvases whose container was removed. */
  removed: string[]
  setVars(vars: Record<string, string>): void
  /** Fire a media query's change, or a window event such as "beforeprint". */
  emit(name: string): void
  /** Ids of the charts destroyed after a failed draw. */
  destroyed: string[]
}

const VARS = {
  '--chart-1': '#0f172a',
  '--chart-2': '#16a34a',
  '--surface': '#ffffff',
  '--text': '#111111',
  '--text-muted': '#475569',
  '--border': '#e2e8f0',
  '--accent': '#3b82f6',
  '--font': 'Inter',
}

/**
 * Run the script for `specs`. Every spec id has a canvas unless listed in
 * `absent`; `sparklines` are the KPI trend canvases. `throwOn` ids make the
 * stub register the chart and then throw, as Chart.js does for an unknown type.
 */
function runScript(
  specs: unknown[],
  opts: {
    chartLibrary?: boolean
    absent?: string[]
    sparklines?: string[]
    throwOn?: string[]
    failUpdateOn?: string[]
  } = {}
): Page {
  let vars: Record<string, string> = VARS
  const charts = new Map<string, FakeChart>()
  const byCanvas = new Map<string, FakeChart>()
  const notes: string[] = []
  const removed: string[] = []
  const listeners: Record<string, Array<() => void>> = {}
  const listen = (name: string, fn: () => void) => (listeners[name] ??= []).push(fn)
  const canvas = (id: string) => ({
    id,
    getAttribute: () => '[1,3,2]',
    parentNode: {
      replaceWith: (note: { textContent: string }) => notes.push(note.textContent),
      remove: () => removed.push(id),
    },
  })
  const ids = (specs as Array<{ id: string }>).map(s => s.id)
  const document = {
    documentElement: {},
    getElementById: (id: string) =>
      ids.includes(id) && !opts.absent?.includes(id) ? canvas(id) : null,
    querySelectorAll: () => (opts.sparklines ?? []).map(canvas),
    createElement: () => ({ className: '', textContent: '' }),
  }
  const window = {
    matchMedia: (query: string) => ({
      addEventListener: (_: string, fn: () => void) => listen(query, fn),
    }),
    addEventListener: listen,
  }
  const getComputedStyle = () => ({ getPropertyValue: (name: string) => vars[name] ?? '' })
  function Chart(this: FakeChart, el: { id: string }, config: Config) {
    Object.assign(this, {
      id: el.id,
      config,
      data: config.data,
      options: config.options,
      updates: [],
      resized: 0,
      destroyed: false,
    })
    byCanvas.set(el.id, this)
    if (opts.throwOn?.includes(el.id)) throw new Error('"x" is not a registered controller.')
    Object.assign(this, {
      update: (mode?: unknown) => {
        if (opts.failUpdateOn?.includes(el.id)) throw new Error('update failed')
        this.updates.push(mode)
      },
      resize: () => this.resized++,
    })
    charts.set(el.id, this)
  }
  Chart.getChart = (el: { id: string }) => {
    const chart = byCanvas.get(el.id)
    return chart && { destroy: () => (chart.destroyed = true) }
  }
  const source = dashboardScript(safeJsonForScript(specs))
  new Function('document', 'window', 'getComputedStyle', 'Chart', source)(
    document,
    window,
    getComputedStyle,
    opts.chartLibrary === false ? undefined : Chart
  )
  return {
    charts,
    notes,
    removed,
    setVars: next => {
      vars = next
    },
    emit: name => (listeners[name] ?? []).forEach(fn => fn()),
    get destroyed() {
      return [...byCanvas.values()].filter(c => c.destroyed).map(c => c.id)
    },
  }
}

function spec(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    type: 'bar',
    labels: ['a', 'b'],
    datasets: [{ label: 's', data: [1, 2], backgroundColor: '$chart-0', borderColor: '$chart-0' }],
    axes: 'cartesian',
    indexAxis: 'x',
    stacked: false,
    legend: true,
    ...extra,
  }
}

describe('dashboardScript', () => {
  it('embeds the specs as given, without reading "$" patterns in them', () => {
    const labels = ['$&', "$'", '$`', '$1', '$$']
    const page = runScript([spec('c0', { labels })])
    expect(page.charts.get('c0')!.data.labels).toEqual(labels)
    expect(dashboardScript('[]')).not.toContain('__CHARTS__')
  })

  it('paints color tokens from the page variables and passes other colors through', () => {
    const page = runScript([
      spec('c0', {
        datasets: [
          {
            data: [1, 2],
            backgroundColor: ['$chart-0', '$chart-8', '#abcdef', '$chart-1@0.2'],
            borderColor: '$surface',
            pointBackgroundColor: '$accent@0.5',
          },
        ],
      }),
    ])
    const ds = page.charts.get('c0')!.data.datasets[0]
    expect(ds.backgroundColor).toEqual(['#0f172a', '#16a34a', '#abcdef', 'rgba(22,163,74,0.2)'])
    expect(ds.borderColor).toBe('#ffffff')
    expect(ds.pointBackgroundColor).toBe('rgba(59,130,246,0.5)')
  })

  it('tints a six-digit hex variable for an alpha and leaves any other color as it is', () => {
    const page = runScript([
      spec('c0', { datasets: [{ data: [1], backgroundColor: '$chart-0@0.2' }] }),
    ])
    const ds = page.charts.get('c0')!.data.datasets[0]
    expect(ds.backgroundColor).toBe('rgba(15,23,42,0.2)')
    page.setVars({ ...VARS, '--chart-1': 'rgb(1 2 3)' })
    page.emit('(prefers-color-scheme: dark)')
    expect(ds.backgroundColor).toBe('rgb(1 2 3)')
  })

  it('skips a spec without a canvas and draws the rest', () => {
    const page = runScript([spec('c0'), spec('c1')], { absent: ['c0'] })
    expect([...page.charts.keys()]).toEqual(['c1'])
    expect(page.notes).toEqual([])
  })

  it('replaces each chart with a note and drops the sparklines when Chart.js is missing', () => {
    const page = runScript([spec('c0'), spec('c1')], {
      chartLibrary: false,
      sparklines: ['sparkline-0'],
    })
    expect(page.notes).toEqual([
      'This chart could not be drawn: the chart library did not load',
      'This chart could not be drawn: the chart library did not load',
    ])
    expect(page.removed).toEqual(['sparkline-0'])
  })

  it('destroys a chart Chart.js registered before it threw, and draws the others', () => {
    const page = runScript([spec('c0'), spec('c1')], {
      throwOn: ['c0', 'sparkline-0'],
      sparklines: ['sparkline-0', 'sparkline-1'],
    })
    expect(page.notes).toEqual([
      'This chart could not be drawn: "x" is not a registered controller.',
    ])
    expect(page.destroyed).toEqual(['c0', 'sparkline-0'])
    expect(page.removed).toEqual(['sparkline-0'])
    expect([...page.charts.keys()]).toEqual(['c1', 'sparkline-1'])
  })

  it('draws a gauge as a half dial with its reading and maximum printed inside', () => {
    const page = runScript([
      spec('g', {
        type: 'doughnut',
        axes: 'none',
        legend: false,
        gauge: { value: '42', max: '100' },
      }),
    ])
    const chart = page.charts.get('g')!
    expect(chart.options).toMatchObject({
      rotation: -90,
      circumference: 180,
      cutout: '70%',
      plugins: { tooltip: { enabled: false } },
    })
    expect(chart.options.scales).toBeUndefined()

    const printed: Array<[string, number, number]> = []
    const ctx = {
      save: () => undefined,
      restore: () => undefined,
      fillText: (text: string, x: number, y: number) => printed.push([text, x, y]),
    }
    const [readout] = chart.config.plugins
    readout.afterDatasetsDraw({
      ctx,
      getDatasetMeta: () => ({ data: [{ x: 100, y: 80, innerRadius: 60 }] }),
    })
    // 0.45 of the inner radius, between 16 and 40 px.
    expect(printed).toEqual([
      ['42', 100, 80 - 27 * 0.7],
      ['/ 100', 100, 80 - 27 * 0.05],
    ])
    printed.length = 0
    readout.afterDatasetsDraw({ ctx, getDatasetMeta: () => ({ data: [] }) })
    expect(printed).toEqual([])
    expect(runScript([spec('b')]).charts.get('b')!.config.plugins).toEqual([])
  })

  it('repaints every chart on a scheme or print change, past one that fails to update', () => {
    const page = runScript([spec('c0'), spec('c1')], {
      failUpdateOn: ['c0'],
      sparklines: ['sparkline-0'],
    })
    page.setVars({ ...VARS, '--chart-1': '#e2e8f0', '--accent': '#60a5fa' })
    page.emit('(prefers-color-scheme: dark)')
    const second = page.charts.get('c1')!
    expect(second.data.datasets[0].borderColor).toBe('#e2e8f0')
    // A plain update: update('none') would keep the previous scheme's colors.
    expect(second.updates).toEqual([undefined])
    const spark = page.charts.get('sparkline-0')!
    expect(spark.data.datasets[0].borderColor).toBe('#60a5fa')
    expect(spark.updates).toEqual([undefined])

    page.setVars(VARS)
    page.emit('print')
    expect(second.data.datasets[0].borderColor).toBe('#0f172a')
    expect(second.updates).toEqual([undefined, undefined])
  })

  it('resizes every chart before printing', () => {
    const page = runScript([spec('c0')], { sparklines: ['sparkline-0'] })
    page.emit('beforeprint')
    expect([...page.charts.values()].map(c => c.resized)).toEqual([1, 1])
  })

  it('builds the axes the spec names', () => {
    const page = runScript([
      spec('cart', { stacked: true, xAxisLabel: 'Month' }),
      spec('radial', { type: 'radar', axes: 'radial' }),
      spec('none', { type: 'pie', axes: 'none' }),
    ])
    const scales = (id: string) => page.charts.get(id)!.options.scales
    expect(scales('cart').x).toMatchObject({
      stacked: true,
      beginAtZero: true,
      title: { display: true, text: 'Month', color: '#475569' },
    })
    expect(scales('cart').y.title).toEqual({ display: false })
    expect(scales('radial').r.ticks).toEqual({ color: '#475569', backdropColor: '#ffffff' })
    expect(scales('none')).toBeUndefined()
    for (const chart of page.charts.values()) expect(chart.options.animation).toBe(false)
  })
})
