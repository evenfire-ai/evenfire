/**
 * The page in the browser: each chart draws on its own, series stay legible in
 * light, dark and print, and charts are complete when printed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { DASHBOARD_THEMES } from '../dashboardThemes'
import { INTERNAL_TOOLS } from '../internalTools'

let outputDir: string

beforeEach(() => {
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-dash-page-'))
})

afterEach(() => {
  fs.rmSync(outputDir, { recursive: true, force: true })
})

async function page(args: Record<string, unknown>): Promise<string> {
  const tool = INTERNAL_TOOLS.find(t => t.name === 'clerum__generate_dashboard')!
  const r = await tool.execute({ filename: 'd.html', ...args }, outputDir)
  expect(r.success).toBe(true)
  return fs.readFileSync(r.artifact!.path, 'utf8')
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map(i => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

describe('series colors', () => {
  it('stand out from the card in every theme and mode (WCAG 1.4.11, 3:1)', () => {
    const weak: string[] = []
    for (const theme of Object.values(DASHBOARD_THEMES)) {
      for (const mode of ['light', 'dark'] as const) {
        const colors = theme[mode]
        for (const color of colors.chart) {
          const ratio = contrast(color, colors.surface)
          if (ratio < 3) weak.push(`${theme.name}/${mode} ${color} ${ratio.toFixed(2)}:1`)
        }
      }
    }
    expect(weak).toEqual([])
  })

  it('switch with the color scheme and print in the light set', async () => {
    const html = await page({
      data: { title: 'T', charts: [{ type: 'bar', labels: ['a'], datasets: [{ data: [1] }] }] },
    })
    const { light, dark } = DASHBOARD_THEMES.default
    const darkBlock = /@media \(prefers-color-scheme: dark\) \{([\s\S]*?)\n\}/.exec(html)![1]
    expect(darkBlock).toContain(`--chart-1: ${dark.chart[0]};`)
    const printBlock = /@media print \{([\s\S]*?)\n\}/.exec(html)![1]
    expect(printBlock).toContain(`--chart-1: ${light.chart[0]};`)
    expect(printBlock).toContain(`--text: ${light.text};`)
  })
})

interface LegendItem {
  text: string
  datasetIndex: number
}

interface ChartOptions {
  animation?: boolean
  plugins: { legend: { labels: { sort?: (a: LegendItem, b: LegendItem) => number } } }
  scales?: {
    r?: { ticks: unknown; grid: { color: string }; pointLabels: { color: string } }
    x?: { beginAtZero?: boolean; grace?: string }
    y?: { beginAtZero?: boolean; grace?: string }
  }
}

interface FakeChart {
  config: {
    type: string
    data: { datasets: Array<Record<string, unknown>> }
    options: ChartOptions
  }
  updates: number
}

/** Run the page script against a minimal DOM and a Chart stub. */
function runPageScript(
  html: string,
  opts: { failOn?: string; vars: Record<string, string> }
): {
  charts: Map<string, FakeChart>
  notes: string[]
  emitMediaChange: () => void
  setVars: (vars: Record<string, string>) => void
} {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1])
  const pageScript = scripts[scripts.length - 1]
  let vars = opts.vars
  const charts = new Map<string, FakeChart>()
  const notes: string[] = []
  const listeners: Array<() => void> = []
  const canvas = (id: string) => ({
    id,
    getAttribute: () => '[1,3,2]',
    parentNode: {
      replaceWith: (note: { textContent: string }) => notes.push(note.textContent),
      remove: () => undefined,
    },
  })
  const sparkIds = [...html.matchAll(/id="(sparkline-\d+)"/g)].map(m => m[1])
  const document = {
    documentElement: {},
    getElementById: (id: string) => (html.includes(`id="${id}"`) ? canvas(id) : null),
    querySelectorAll: () => sparkIds.map(canvas),
    createElement: () => ({ className: '', textContent: '' }),
  }
  const window = {
    matchMedia: () => ({ addEventListener: (_: string, fn: () => void) => listeners.push(fn) }),
    addEventListener: () => undefined,
  }
  const getComputedStyle = () => ({ getPropertyValue: (name: string) => vars[name] ?? '' })
  function Chart(this: FakeChart, el: { id: string }, config: FakeChart['config']) {
    if (el.id === opts.failOn) throw new Error('"x" is not a registered controller.')
    this.config = config
    this.updates = 0
    Object.assign(this, {
      data: config.data,
      update: () => this.updates++,
      resize: () => undefined,
    })
    charts.set(el.id, this)
  }
  Chart.getChart = () => undefined
  new Function('document', 'window', 'getComputedStyle', 'Chart', pageScript)(
    document,
    window,
    getComputedStyle,
    Chart
  )
  return {
    charts,
    notes,
    emitMediaChange: () => listeners.forEach(fn => fn()),
    setVars: next => {
      vars = next
    },
  }
}

const LIGHT = {
  '--chart-1': '#0f172a',
  '--chart-2': '#16a34a',
  '--text-muted': '#475569',
  '--border': '#e2e8f0',
  '--accent': '#3b82f6',
}
const DARK = {
  '--surface': '#1e293b',
  '--chart-1': '#e2e8f0',
  '--chart-2': '#4ade80',
  '--text-muted': '#cbd5e1',
  '--border': '#334155',
  '--accent': '#60a5fa',
}

const TWO_CHARTS_AND_A_SPARKLINE = {
  data: {
    title: 'T',
    kpis: [{ label: 'k', value: 1, sparkline: [1, 3, 2] }],
    charts: [
      { type: 'bar', labels: ['a'], datasets: [{ label: 'first', data: [1] }] },
      {
        type: 'line',
        labels: ['a', 'b'],
        datasets: [
          { label: 's1', data: [1, 2] },
          { label: 's2', data: [2, 1] },
        ],
      },
    ],
  },
}

describe('page script', () => {
  it('draws the other charts and the sparklines when one chart throws', async () => {
    const html = await page(TWO_CHARTS_AND_A_SPARKLINE)
    const run = runPageScript(html, { failOn: 'chart-0', vars: LIGHT })
    expect(run.notes).toEqual([
      'This chart could not be drawn: "x" is not a registered controller.',
    ])
    expect([...run.charts.keys()]).toEqual(['chart-1', 'sparkline-0'])
  })

  it('reads series colors from the page and repaints them when the scheme changes', async () => {
    const html = await page(TWO_CHARTS_AND_A_SPARKLINE)
    const run = runPageScript(html, { vars: LIGHT })
    const line = run.charts.get('chart-1')!
    expect(line.config.data.datasets.map(d => d.borderColor)).toEqual(['#0f172a', '#16a34a'])
    expect(line.config.data.datasets[0].backgroundColor).toBe('rgba(15,23,42,0.2)')

    run.setVars(DARK)
    run.emitMediaChange()
    expect(line.config.data.datasets.map(d => d.borderColor)).toEqual(['#e2e8f0', '#4ade80'])
    expect(line.updates).toBeGreaterThan(0)
  })

  it('draws without animation so a print or PDF capture shows finished charts', async () => {
    const html = await page(TWO_CHARTS_AND_A_SPARKLINE)
    const run = runPageScript(html, { vars: LIGHT })
    for (const chart of run.charts.values()) expect(chart.config.options.animation).toBe(false)
  })

  it('lists a mixed chart legend in series order although the lines draw on top', async () => {
    const html = await page({
      data: {
        title: 'T',
        charts: [
          {
            type: 'mixedBarLine',
            labels: ['a', 'b'],
            datasets: [
              { label: 'Bars', data: [1, 2] },
              { label: 'Line', data: [2, 1] },
            ],
          },
        ],
      },
    })
    const run = runPageScript(html, { vars: LIGHT })
    const sort = run.charts.get('chart-0')!.config.options.plugins.legend.labels.sort
    expect(sort).toBeTypeOf('function')
    const items = [
      { text: 'Line', datasetIndex: 1 },
      { text: 'Bars', datasetIndex: 0 },
    ]
    expect(items.sort(sort).map(i => i.text)).toEqual(['Bars', 'Line'])
  })

  it('colors the radial scale of radar and polar charts from the theme', async () => {
    const html = await page({
      data: {
        title: 'T',
        charts: [
          { type: 'radar', labels: ['a', 'b', 'c'], datasets: [{ label: 'p', data: [1, 2, 3] }] },
        ],
      },
    })
    const run = runPageScript(html, { vars: DARK })
    const r = run.charts.get('chart-0')!.config.options.scales!.r!
    expect(r.ticks).toEqual({ color: '#cbd5e1', backdropColor: '#1e293b' })
    expect(r.grid.color).toBe('#334155')
    expect(r.pointLabels.color).toBe('#cbd5e1')
  })

  it('starts stacked value axes at zero and draws scatter points whole at the edge', async () => {
    const html = await page({
      data: {
        title: 'T',
        charts: [
          {
            type: 'stackedArea',
            labels: ['a', 'b'],
            datasets: [{ data: [4, 5] }, { data: [6, 7] }],
          },
          {
            type: 'scatter',
            datasets: [
              {
                data: [
                  { x: 1, y: 2 },
                  { x: 3, y: 4 },
                ],
              },
            ],
          },
          { type: 'line', labels: ['a', 'b'], datasets: [{ data: [4, 5] }] },
        ],
      },
    })
    const run = runPageScript(html, { vars: LIGHT })
    const scales = (id: string) => run.charts.get(id)!.config.options.scales!
    expect(scales('chart-0').y!.beginAtZero).toBe(true)
    expect(scales('chart-1').x!).not.toHaveProperty('grace')
    expect(scales('chart-1').y!).not.toHaveProperty('grace')
    expect(run.charts.get('chart-1')!.config.data.datasets[0].clip).toBe(false)
    expect(scales('chart-2').y!).not.toHaveProperty('beginAtZero')
  })
})

describe('dashboard notes and figures', () => {
  const dashboard = () => INTERNAL_TOOLS.find(t => t.name === 'clerum__generate_dashboard')!

  it('puts a note about lost content before repeated repair notes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-dash-notes-'))
    try {
      const charts = Array.from({ length: 12 }, () => ({
        type: 'bar',
        labels: ['a'],
        datasets: [{ data: ['2'] }],
      }))
      charts.push({
        type: 'funnel',
        labels: ['a'],
        datasets: [{ data: [1] }, { data: [2] }] as never,
      })
      const result = await dashboard().execute(
        { filename: 'n.html', inlineChartJs: false, data: { title: 'T', charts } },
        dir
      )
      expect(result.success, result.error).toBe(true)
      const notes = result.content ?? ''
      expect(notes).toContain('extra dataset(s) were dropped')
      expect(notes.indexOf('dropped')).toBeLessThan(notes.indexOf('written as text'))
      expect(notes).toContain('(9 more like it.)')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('prints table numbers as written, structured cells as text, and a year unGrouped', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-dash-cells-'))
    try {
      const result = await dashboard().execute(
        {
          filename: 'c.html',
          data: {
            title: 'T',
            status: 'Red',
            kpis: [{ label: 'Year', value: 2026 }],
            tables: [{ headers: ['A', 'B'], rows: [[0.1 + 0.2, { name: 'Ana' }]] }],
          },
        },
        dir
      )
      expect(result.success, result.error).toBe(true)
      const html = fs.readFileSync(result.artifact!.path, 'utf8')
      expect(html).toContain('<td>0.3</td>')
      expect(html).toContain('{&quot;name&quot;:&quot;Ana&quot;}')
      expect(html).toContain('data-status="red"')
      expect(html).toMatch(/kpi-card__value">2026</)
      expect(result.content).toContain('held an object or a list')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
