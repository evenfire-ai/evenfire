/**
 * What the dashboard writes and what it tells the agent: bad parts are isolated
 * and named, attributes cannot carry markup, and Chart.js is inlined only when used.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { INTERNAL_TOOLS, loadChartJsBundle } from '../internalTools'
import type { InternalToolResult } from '../types'

let outputDir: string

beforeEach(() => {
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-dash-render-'))
})

afterEach(() => {
  fs.rmSync(outputDir, { recursive: true, force: true })
})

function run(args: Record<string, unknown>): Promise<InternalToolResult> {
  const tool = INTERNAL_TOOLS.find(t => t.name === 'clerum__generate_dashboard')!
  return tool.execute({ filename: 'd.html', ...args }, outputDir)
}

async function render(args: Record<string, unknown>): Promise<{ html: string; notes: string }> {
  const r = await run(args)
  expect(r.error).toBeUndefined()
  expect(r.success).toBe(true)
  return { html: fs.readFileSync(r.artifact!.path, 'utf8'), notes: r.content ?? '' }
}

const blocks = (list: unknown[]) => ({ template: 'custom', data: { title: 'T', blocks: list } })

/** The chart specs the page script receives. */
function chartSpecs(html: string): Array<Record<string, unknown>> {
  const m = /var charts = (\[.*?\]);\n/s.exec(html)
  return m ? JSON.parse(m[1]) : []
}

describe('markup injection', () => {
  it('never interpolates a spacer size it does not know', async () => {
    const { html } = await render(
      blocks([
        { type: 'narrative', content: 'ok' },
        { type: 'spacer', size: 'md"><img src=x onerror="alert(1)">' },
      ])
    )
    expect(html).not.toContain('<img')
    expect(html).toContain('<div class="dashboard-spacer dashboard-spacer--md"></div>')
  })

  it('keeps status, severity and accent attributes to their known values', async () => {
    const { html } = await render({
      template: 'operations-pulse',
      data: {
        title: 'T',
        status: '"><b>x</b>',
        services: [{ name: 'API', status: '"><i>y</i>' }],
        incidents: [{ time: '1', title: 't', severity: '"><u>z</u>' }],
        kpis: [
          { label: 'k', value: 1, accent: '"><s>w</s>', deltaDirection: '"><q>', delta: '+1' },
        ],
      },
    })
    expect(html).not.toMatch(/<(b|i|u|s|q)>/)
  })
  it('escapes the notice that replaces a bad card', async () => {
    const { html } = await render({
      data: { title: 'T', kpis: [{ label: 'ok', value: 1 }, '<img src=x onerror=alert(1)>'] },
    })
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img src=x')
  })
})

describe('one bad part never takes the page down', () => {
  it('reports a chart block without a spec in place', async () => {
    const r = await run(blocks([{ type: 'narrative', content: 'Still here' }, { type: 'chart' }]))
    expect(r.success).toBe(true)
    const html = fs.readFileSync(r.artifact!.path, 'utf8')
    expect(html).toContain('Still here')
    expect(html).toContain('data.blocks[1] could not be shown')
    expect(r.content).toContain(
      "data.blocks[1] is a 'chart' block and needs spec: {type, labels, datasets}"
    )
  })

  it('reports a missing chart inside a grid in its own card', async () => {
    const { html, notes } = await render(
      blocks([
        {
          type: 'charts-grid',
          items: [null, { type: 'bar', title: 'Fine', labels: ['a'], datasets: [{ data: [1] }] }],
        },
      ])
    )
    expect(html).toContain('This chart could not be drawn')
    expect(chartSpecs(html)).toHaveLength(1)
    expect(notes).toContain('data.blocks[0].items[0] must be a chart object')
  })

  it('draws a service with no status in a neutral card instead of failing the dashboard', async () => {
    const { html } = await render({
      template: 'operations-pulse',
      data: { title: 'T', services: [{ name: 'API' }, { name: 'DB', status: 'healthy' }] },
    })
    expect(html).toContain('<div class="health-card" data-status="unknown">')
    expect(html).toContain('UNKNOWN')
    expect(html).toContain('data-status="healthy"')
  })

  it('keeps the other KPI cards when one cannot be shown', async () => {
    const { html, notes } = await render({
      data: {
        title: 'T',
        kpis: [
          { label: 'good', value: '1' },
          { label: 'bad', value: '' },
        ],
      },
    })
    expect(html).toContain('<p class="kpi-card__value">1</p>')
    expect(html).toContain('data.kpis[1].value is missing')
    expect(notes).toContain('data.kpis[1].value is missing')
  })

  it('keeps the other incidents and services when one cannot be shown', async () => {
    const { html, notes } = await render({
      template: 'operations-pulse',
      data: {
        title: 'T',
        services: [{ name: 'API', status: 'healthy' }, { status: 'down' }],
        incidents: [{ time: '10:00', title: 'Kept incident' }, '11:00 DB down'],
      },
    })
    expect(html).toContain('<h3 class="health-card__name">API</h3>')
    expect(html).toContain('Kept incident')
    expect(notes).toContain('data.services[1].name is missing')
    expect(notes).toContain('data.incidents[1] must be an incident object {time, title}')
  })

  it('isolates a bad entry in a fixed template', async () => {
    const { html, notes } = await render({
      data: {
        title: 'T',
        tables: [{ rows: [['x']] }, { headers: ['A'], rows: [['kept']] }],
        sections: [{ type: 'narrative', content: { text: 'x' } }],
      },
    })
    expect(html).toContain('kept')
    expect(notes).toContain('data.tables[0].headers must be a non-empty array')
    expect(notes).toContain('data.sections[0].content must be text')
  })
})

describe('custom blocks read the shape their type needs', () => {
  it('refuses KPI items sent as strings instead of rendering empty cards', async () => {
    const r = await run(
      blocks([
        { type: 'kpis', items: ['Revenue: $1.2M'] },
        { type: 'narrative', content: 'ok' },
      ])
    )
    const html = fs.readFileSync(r.artifact!.path, 'utf8')
    expect(html).not.toContain('<p class="kpi-card__label"></p>')
    expect(r.content).toContain(
      'data.blocks[0].items[0] must be a KPI object {label, value}; received a string ("Revenue: $1.2M")'
    )
  })

  it('refuses incidents sent as strings', async () => {
    const r = await run(
      blocks([
        { type: 'incidents', items: ['10:00 DB down'] },
        { type: 'divider' },
        { type: 'bullets', items: ['x'] },
      ])
    )
    expect(r.content).toContain('data.blocks[0].items[0] must be an incident object {time, title}')
  })

  it('fails without writing a file when no block could be shown', async () => {
    const r = await run(blocks([{ type: 'kpis', items: ['Revenue: $1.2M'] }]))
    expect(r.success).toBe(false)
    expect(r.error).toContain('Nothing on the dashboard could be shown')
    expect(r.error).toContain('data.blocks[0].items[0] must be a KPI object')
    expect(fs.readdirSync(outputDir)).toEqual([])
  })

  it('keeps the block titles of tables, callouts and KPI grids', async () => {
    const { html } = await render(
      blocks([
        { type: 'table', title: 'TABLE_TITLE', spec: { headers: ['a'], rows: [['1']] } },
        { type: 'callout', title: 'CALLOUT_TITLE', content: 'c' },
        { type: 'kpis', title: 'KPIS_TITLE', items: [{ label: 'k', value: 1 }] },
      ])
    )
    expect(html).toContain('TABLE_TITLE')
    expect(html).toContain('CALLOUT_TITLE')
    expect(html).toContain('KPIS_TITLE')
  })

  it('gives every sparkline its own id', async () => {
    const kpis = { type: 'kpis', items: [{ label: 'k', value: 1, sparkline: [1, 2, 3] }] }
    const { html } = await render(blocks([kpis, kpis]))
    const ids = [...html.matchAll(/id="(sparkline-\d+)"/g)].map(m => m[1])
    expect(ids).toEqual(['sparkline-0', 'sparkline-1'])
  })
})

describe('charts are checked before the page is written', () => {
  it('maps the extended types onto what Chart.js draws', async () => {
    const chart = (type: string) => ({
      type,
      labels: ['a', 'b', 'c'],
      datasets: [
        { label: 'x', data: [5, -2, 3] },
        { label: 'y', data: [1, 2, 3] },
      ],
    })
    const { html } = await render({
      data: {
        title: 'T',
        charts: ['stackedBar', 'stackedArea', 'mixedBarLine', 'funnel', 'gauge', 'waterfall'].map(
          chart
        ),
      },
    })
    const [stackedBar, stackedArea, mixed, funnel, gauge, waterfall] = chartSpecs(html)
    expect(stackedBar).toMatchObject({ type: 'bar', stacked: true })
    expect(stackedArea).toMatchObject({ type: 'line', stacked: true })
    expect((stackedArea.datasets as Array<{ fill: unknown }>).map(d => d.fill)).toEqual([
      'origin',
      '-1',
    ])
    expect((mixed.datasets as Array<{ type?: string }>).map(d => d.type)).toEqual([
      undefined,
      'line',
    ])
    expect(funnel).toMatchObject({ type: 'bar', indexAxis: 'y', labels: ['a', 'c', 'b'] })
    expect(gauge).toMatchObject({ type: 'doughnut', gauge: { value: '5', max: '100' } })
    expect(waterfall).toMatchObject({ type: 'bar', labels: ['a', 'b', 'c', 'Total'] })
    expect((waterfall.datasets as Array<{ data: unknown }>)[0].data).toEqual([
      [0, 5],
      [5, 3],
      [3, 6],
      [0, 6],
    ])
  })

  it('turns an unknown or missing type into a note in its card', async () => {
    const { html, notes } = await render({
      data: {
        title: 'T',
        charts: [
          { type: 'sunburst', labels: ['a'], datasets: [{ data: [1] }] },
          { labels: ['a'], datasets: [{ data: [1] }] },
          { type: 'bar', labels: ['a'], datasets: [{ data: [1] }] },
        ],
      },
    })
    expect(chartSpecs(html).map(s => s.type)).toEqual(['bar'])
    expect(notes).toContain(
      'data.charts[0].type "sunburst" is not a chart type; use one of: line, bar'
    )
    expect(notes).toContain('data.charts[1].type is missing')
    expect(html.match(/chart-card__note">This chart could not be drawn/g)).toHaveLength(2)
  })

  it('returns the normalizer notes to the agent, naming the dashboard field', async () => {
    const { notes } = await render({
      data: {
        title: 'T',
        charts: [{ type: 'bar', labels: ['a', 'b', 'c', 'd'], datasets: [{ data: ['1', 2] }] }],
      },
    })
    expect(notes).toContain('`data.charts[0].labels` had 4 entries for 2 value(s)')
    expect(notes).toContain('data.charts[0].datasets[0]: read 1 value(s) written as text')
  })

  it('names the hero chart field as the caller wrote it', async () => {
    const { notes } = await render({
      template: 'financial-review',
      data: {
        title: 'T',
        kpis: [{ label: 'k', value: 1 }],
        heroChart: { type: 'bar', labels: ['a', 'b', 'c'], datasets: [{ data: [1, 2] }] },
      },
    })
    expect(notes).toContain('`data.heroChart.labels` had 3 entries for 2 value(s)')
    expect(notes).not.toContain('heroChart[0]')

    const broken = await render({
      template: 'financial-review',
      data: {
        title: 'T',
        kpis: [{ label: 'k', value: 1 }],
        heroChart: { type: 'nope', datasets: [{ data: [1] }] },
      },
    })
    expect(broken.notes).toContain('data.heroChart.type "nope" is not a chart type')
  })

  it('says when a gauge leaves values out', async () => {
    const { notes } = await render({
      data: {
        title: 'T',
        charts: [{ type: 'gauge', labels: ['cpu', 'mem'], datasets: [{ data: [40, 80] }] }],
      },
    })
    expect(notes).toContain(
      'data.charts[0]: the gauge shows one value, so 1 more in datasets[0].data was left out.'
    )
  })

  it('shows the legend only when a series is named', async () => {
    const { html } = await render({
      data: {
        title: 'T',
        charts: [
          { type: 'bar', labels: ['a'], datasets: [{ data: [1] }] },
          { type: 'bar', labels: ['a'], datasets: [{ label: 'Named', data: [1] }] },
          { type: 'pie', labels: ['a'], datasets: [{ data: [1] }] },
        ],
      },
    })
    expect(chartSpecs(html).map(s => s.legend)).toEqual([false, true, true])
  })
})

describe('Chart.js is inlined only when it is used', () => {
  it('leaves the bundle out of a page with no charts or sparklines', async () => {
    const { html } = await render({
      data: { title: 'T', sections: [{ type: 'bullets', content: ['x'] }] },
    })
    expect(html).not.toContain('Chart.js v')
    expect(html).not.toContain('<script')
    expect(html.length).toBeLessThan(60_000)
  })

  it('shows chart values as a table when the bundle is not inlined, and says so', async () => {
    const { html, notes } = await render({
      inlineChartJs: false,
      data: {
        title: 'T',
        kpis: [{ label: 'k', value: 1, sparkline: [1, 2] }],
        charts: [
          { type: 'bar', labels: ['Jan', 'Feb'], datasets: [{ label: 'Sales', data: [4, 7] }] },
        ],
      },
    })
    expect(html).not.toContain('<canvas')
    expect(html).toMatch(/<th>Sales<\/th>.*<td>Jan<\/td><td>4<\/td>.*<td>Feb<\/td><td>7<\/td>/s)
    expect(notes).toContain('inlineChartJs is false, so charts are shown as tables of their values')
  })

  it('finds the bundle through the package entry point', () => {
    expect(loadChartJsBundle()).toMatch(/Chart\.js v4/)
  })
})

describe('what the agent is told', () => {
  it('says which fields the chosen template does not show', async () => {
    const { notes } = await render({
      data: {
        title: 'T',
        kpis: [{ label: 'k', value: 1 }],
        services: [{ name: 'API', status: 'down' }],
      },
    })
    expect(notes).toContain("data.services is only shown by template 'operations-pulse'")
  })

  it('names the heading it needs when data has no title', async () => {
    const r = await run({ data: { kpis: [] } })
    expect(r.success).toBe(false)
    expect(r.error).toContain('data.title is required')
  })
})

describe('KPI deltas', () => {
  it('lets a falling figure be good news', async () => {
    const { html } = await render({
      data: {
        title: 'T',
        kpis: [
          {
            label: 'Churn',
            value: '2.1%',
            delta: '-0.3pp',
            deltaDirection: 'down',
            deltaSentiment: 'good',
          },
        ],
      },
    })
    expect(html).toContain('data-direction="down" data-sentiment="good"')
  })

  it('keeps the old reading when no sentiment is given', async () => {
    const { html } = await render({
      data: { title: 'T', kpis: [{ label: 'x', value: 1, delta: '+1', deltaDirection: 'up' }] },
    })
    expect(html).toContain('data-direction="up" data-sentiment="good"')
  })
})

describe('value tables without Chart.js', () => {
  it('lists scatter points one per row', async () => {
    const { html } = await render({
      inlineChartJs: false,
      data: {
        title: 'T',
        charts: [
          {
            type: 'scatter',
            datasets: [
              {
                label: 'pts',
                data: [
                  { x: 1, y: 2 },
                  { x: 3, y: 5 },
                ],
              },
            ],
          },
        ],
      },
    })
    expect(html).toMatch(/<td>1<\/td><td>\(1, 2\)<\/td>.*<td>2<\/td><td>\(3, 5\)<\/td>/s)
  })
})
