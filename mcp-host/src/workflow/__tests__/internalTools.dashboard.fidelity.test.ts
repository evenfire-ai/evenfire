/**
 * Everything the caller passed reaches the page as written, or the agent is
 * told what was changed or left out: list blocks, table cells, KPI figures,
 * footer provenance, series colors and gauge readings.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { INTERNAL_TOOLS } from '../internalTools'
import type { InternalToolResult } from '../types'

let outputDir: string

beforeEach(() => {
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-dash-fidelity-'))
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

function chartSpecs(html: string): Array<Record<string, unknown>> {
  const m = /var charts = (\[.*?\]);\n/s.exec(html)
  return m ? JSON.parse(m[1]) : []
}

const narrative = { type: 'narrative', content: 'Kept' }

describe('custom list blocks', () => {
  it.each([
    ['kpis', { kpis: [{ label: 'Revenue', value: 1 }] }, 'kpis', /kpi-card__value">1</],
    [
      'charts-grid',
      { charts: [{ type: 'bar', title: 'Grid', labels: ['a'], datasets: [{ data: [1] }] }] },
      'charts',
      /Grid<\/h3>/,
    ],
    ['incidents', { incidents: [{ time: '1', title: 'DB down' }] }, 'incidents', /DB down<\/h4>/],
    [
      'service-health',
      { items: [{ name: 'API', status: 'healthy' }] },
      'items',
      /health-card__name">API</,
    ],
  ])(
    'reads a %s block list sent under %j and says which field to use',
    async (type, list, alias, shown) => {
      const { html, notes } = await render(blocks([narrative, { type, ...list }]))
      expect(html).toMatch(shown)
      const field = type === 'service-health' ? 'services' : 'items'
      expect(notes).toContain(`data.blocks[1]: the list was read from ${alias}; name it ${field}.`)
    }
  )

  it.each([
    ['kpis', 'items', 'cards'],
    ['charts-grid', 'items', 'charts'],
    ['incidents', 'items', 'incidents'],
    ['service-health', 'services', 'services'],
  ])('reports a %s block with no list instead of dropping it', async (type, field, noun) => {
    for (const block of [{ type }, { type, [field]: [] }]) {
      const { html, notes } = await render(blocks([narrative, block]))
      const message = `data.blocks[1].${field} is missing or empty; a '${type}' block lists its ${noun} in ${field}`
      expect(notes).toContain(message)
      expect(html).toContain(message.replace(/'/g, '&#39;'))
      expect(html).toContain('Kept')
    }
  })

  it('fails without a file when the only block is an empty list', async () => {
    const r = await run(blocks([{ type: 'kpis', items: [] }]))
    expect(r.success).toBe(false)
    expect(r.error).toContain("data.blocks[0].items is missing or empty; a 'kpis' block")
    expect(fs.readdirSync(outputDir)).toEqual([])
  })
})

describe('tables', () => {
  it('pads short rows, trims long ones and says what was left out', async () => {
    const { html, notes } = await render({
      data: {
        title: 'T',
        tables: [
          {
            headers: ['A', 'B', 'C'],
            rows: [['1'], ['1', '2', '3', '4', '5'], ['x', 'y', 'z', '', null]],
          },
        ],
      },
    })
    const rows = [...html.matchAll(/<tr>(<td>.*?)<\/tr>/g)].map(m => m[1].match(/<td>/g)!.length)
    expect(rows).toEqual([3, 3, 3])
    expect(html).not.toContain('<td>4</td>')
    expect(notes).toContain(
      'data.tables[0].rows[1] has 5 cells for 3 headers; the extra 2 were left out. Add headers for them or drop them.'
    )
    expect(notes).toContain(
      'data.tables[0]: 1 row(s) have fewer cells than the 3 headers and end in empty cells.'
    )
    expect(notes).not.toContain('rows[2]')
  })

  it('lets a wide table scroll on screen and fit the page in print', async () => {
    const { html } = await render({ data: { title: 'T', kpis: [{ label: 'x', value: 1 }] } })
    expect(html).toMatch(/\.data-table-wrap \{[^}]*overflow-x: auto/)
    expect(html).not.toMatch(/\.data-table-wrap \{[^}]*overflow: hidden/)
    const printBlock = /@media print \{([\s\S]*?)\n\}/.exec(html)![1]
    expect(printBlock).toMatch(
      /\.data-table--wide thead th, \.data-table--wide tbody td \{[^}]*overflow-wrap: anywhere/
    )
  })

  it('marks a table as wide above 8 columns', async () => {
    const headers = (n: number) => Array.from({ length: n }, (_, i) => `H${i}`)
    const { html } = await render({
      data: {
        title: 'T',
        tables: [
          { headers: headers(8), rows: [headers(8)] },
          { headers: headers(9), rows: [headers(9)] },
        ],
      },
    })
    expect([...html.matchAll(/<table class="([^"]+)">/g)].map(m => m[1])).toEqual([
      'data-table',
      'data-table data-table--wide',
    ])
  })

  it('lets a long URL or ID wrap inside its cell and keeps ordinary words whole', async () => {
    const url = 'https://example.com/a/very/long/path?with=query&and=more'
    const { html } = await render({
      data: {
        title: 'T',
        tables: [
          {
            headers: ['Link', 'Notes'],
            rows: [
              [url, 'Renewal negotiations continue'],
              ['**bold**', 'x'],
            ],
          },
        ],
      },
    })
    const cell = /<td>(https:.*?)<\/td>/.exec(html)![1]
    expect(cell).toContain('<wbr>')
    expect(cell.replace(/<wbr>/g, '')).toBe(
      'https:&#x2F;&#x2F;example.com&#x2F;a&#x2F;very&#x2F;long&#x2F;path?with=query&amp;and=more'
    )
    expect(html).toContain('<td>Renewal negotiations continue</td>')
    expect(html).toContain('<td><strong>bold</strong></td>')
  })
})

describe('KPI figures', () => {
  it.each([
    [0.1 + 0.2, '0.3'],
    [0.4523809523809524, '0.4524'],
    [123456789012, '123,456,789,012'],
    [1234567.891, '1,234,567.89'],
    [-42, '-42'],
    [0, '0'],
  ])('prints the number %s as %s', async (value, shown) => {
    const { html } = await render({ data: { title: 'T', kpis: [{ label: 'k', value }] } })
    expect(html).toContain(`<p class="kpi-card__value">${shown}</p>`)
  })

  it('signs a numeric delta and points its arrow the same way', async () => {
    const { html } = await render({
      data: {
        title: 'T',
        kpis: [
          { label: 'Churn', value: 2.1, delta: -0.3 },
          { label: 'NPS', value: 48, delta: 5 },
          { label: 'Flat', value: 1, delta: 0 },
          { label: 'Given', value: 1, delta: 5, deltaDirection: 'neutral' },
        ],
      },
    })
    expect(html).toContain('data-direction="down" data-sentiment="bad">-0.3</p>')
    expect(html).toContain('data-direction="up" data-sentiment="good">+5</p>')
    expect(html).toContain('data-direction="neutral" data-sentiment="neutral">0</p>')
    expect(html).toContain('data-direction="neutral" data-sentiment="neutral">+5</p>')
  })

  it('prints a numeric service metric like a KPI', async () => {
    const { html } = await render({
      template: 'operations-pulse',
      data: {
        title: 'T',
        services: [{ name: 'API', status: 'healthy', metric: 1234.5678, delta: -2 }],
      },
    })
    expect(html).toContain('<p class="health-card__metric">1,234.57</p>')
    expect(html).toContain('data-direction="down" data-sentiment="bad">-2</p>')
  })
})

describe('long words', () => {
  it('wraps long words in the hero and cards instead of clipping them', async () => {
    const { html } = await render({ data: { title: 'T', kpis: [{ label: 'x', value: 1 }] } })
    const rule = /([^{}]+)\{[^}]*overflow-wrap: anywhere;[^}]*\}/g
    const selectors = [...html.matchAll(rule)].map(m => m[1]).join(',')
    for (const cls of [
      '.hero__title',
      '.hero__headline',
      '.kpi-card__label',
      '.kpi-card__value',
      '.kpi-card__delta',
      '.chart-card__title',
    ]) {
      expect(selectors).toContain(cls)
    }
  })
})

describe('service status and incident severity', () => {
  it('colors common status words and keeps the text the caller wrote', async () => {
    const { html, notes } = await render({
      template: 'operations-pulse',
      data: {
        title: 'T',
        services: [
          { name: 'A', status: 'operational' },
          { name: 'B', status: 'Outage' },
          { name: 'C', status: 'rebooting' },
          { name: 'D', status: 'Unknown' },
        ],
      },
    })
    expect(html).toMatch(/data-status="healthy">[\s\S]*?OPERATIONAL/)
    expect(html).toMatch(/data-status="down">[\s\S]*?OUTAGE/)
    expect(html).toMatch(/data-status="unknown">[\s\S]*?REBOOTING/)
    expect(notes).toContain(
      'data.services[2].status "rebooting" is not healthy, degraded, down or maintenance, so the card is grey.'
    )
    expect(notes).not.toContain('data.services[3]')
  })

  it('treats words that name Object properties as unknown', async () => {
    const { html, notes } = await render({
      template: 'operations-pulse',
      data: {
        title: 'T',
        services: [{ name: 'A', status: 'constructor' }],
        incidents: [{ time: '10:00', title: 'a', severity: '__proto__' }],
      },
    })
    expect(html).toContain('data-status="unknown"')
    expect(html).not.toMatch(/native code|\[object Object\]/)
    expect(notes).toContain('data.services[0].status "constructor" is not healthy')
    expect(notes).toContain('data.incidents[0].severity "__proto__" is not critical')
  })

  it('shows the severity the caller wrote and colors the known ones', async () => {
    const { html, notes } = await render({
      template: 'operations-pulse',
      data: {
        title: 'T',
        incidents: [
          { time: '10:00', title: 'a', severity: 'medium' },
          { time: '10:05', title: 'b', severity: 'P1' },
          { title: 'no time', severity: 'sev9' },
        ],
      },
    })
    expect(html).toContain('<span class="severity-badge severity-med">MEDIUM</span>')
    expect(html).toContain('<span class="severity-badge severity-high">P1</span>')
    expect(html).toContain('<span class="severity-badge severity-info">SEV9</span>')
    expect(html).toContain('no time</h4>')
    expect(notes).toContain(
      'data.incidents[2].severity "sev9" is not critical, high, medium, low or info, so it is shown in the info color.'
    )
  })
})

describe('footer provenance', () => {
  it('shows the author and run ID beside the date', async () => {
    const { html } = await render({
      branding: { footerText: 'Internal' },
      data: {
        title: 'Meta',
        meta: { date: '22 de septiembre de 2026', author: 'Ana García', runId: 'run-2026-09-22' },
        kpis: [{ label: 'x', value: 1 }],
      },
    })
    expect(html).toContain(
      '<span>Internal · Ana García · run-2026-09-22 · 22 de septiembre de 2026</span>'
    )
  })

  it('reads a numeric date as a timestamp and keeps a year as written', async () => {
    const stamp = Date.UTC(2026, 8, 22, 12)
    const epoch = await render({
      data: { title: 'M', meta: { date: stamp }, kpis: [{ label: 'x', value: 1 }] },
    })
    expect(epoch.html).toContain('<span>September 22, 2026</span>')
    const seconds = await render({
      data: { title: 'M', meta: { date: stamp / 1000 }, kpis: [{ label: 'x', value: 1 }] },
    })
    expect(seconds.html).toContain('<span>September 22, 2026</span>')
    const year = await render({
      data: { title: 'M', meta: { date: 2026 }, kpis: [{ label: 'x', value: 1 }] },
    })
    expect(year.html).toContain('<span>2026</span>')
  })
})

describe('series colors from the caller', () => {
  it('replaces a value that is not a color with the palette and says so', async () => {
    const { html, notes } = await render({
      data: {
        title: 'T',
        charts: [
          {
            type: 'pie',
            labels: ['a', 'b', 'c', 'd', 'e'],
            datasets: [
              {
                data: [1, 2, 3, 4, 5],
                backgroundColor: [
                  '#ff0000',
                  'notacolor',
                  'url(x)',
                  'rgba(0, 0, 0, 0.5)',
                  'SteelBlue',
                ],
                borderColor: 'nope',
              },
            ],
          },
        ],
      },
    })
    const [pie] = chartSpecs(html)
    const ds = (pie.datasets as Array<Record<string, unknown>>)[0]
    expect(ds.backgroundColor).toEqual([
      '#ff0000',
      '$chart-1',
      '$chart-2',
      'rgba(0, 0, 0, 0.5)',
      'SteelBlue',
    ])
    expect(ds.borderColor).toBe('$surface')
    expect(notes).toContain(
      'data.charts[0].datasets[0].backgroundColor[1] "notacolor" is not a CSS color, so the palette color was used. Pass hex such as "#2563eb", rgb(), hsl() or a color name.'
    )
    expect(notes).toContain(
      'data.charts[0].datasets[0].backgroundColor[2] "url(x)" is not a CSS color'
    )
    expect(notes).toContain('data.charts[0].datasets[0].borderColor "nope" is not a CSS color')
  })

  it('reports many bad colors in a few lines and quickly', async () => {
    const n = 5_000
    const junk = `rgb(${'1,'.repeat(50_000)}`
    const started = Date.now()
    const { notes } = await render({
      data: {
        title: 'T',
        charts: [
          {
            type: 'pie',
            labels: Array.from({ length: n }, (_, i) => `L${i}`),
            datasets: [
              {
                data: Array.from({ length: n }, () => 1),
                backgroundColor: Array.from({ length: n }, () => junk),
              },
            ],
          },
        ],
      },
    })
    expect(Date.now() - started).toBeLessThan(30_000)
    expect(notes.match(/is not a CSS color/g)).toHaveLength(3)
    expect(notes).toContain(`data.charts[0]: ${n - 3} more colors are not CSS colors`)
    expect(notes).toContain(JSON.stringify(`${junk.slice(0, 40)}…`))
  }, 60_000)

  it('keeps the modern color functions a browser canvas paints', async () => {
    const colors = ['hsl(210deg 50% 40% / 0.8)', 'oklch(0.62 0.19 259.8)', 'hwb(120 10% 20%)']
    const { html, notes } = await render({
      data: {
        title: 'T',
        charts: [
          {
            type: 'pie',
            labels: ['a', 'b', 'c'],
            datasets: [{ data: [1, 2, 3], backgroundColor: colors }],
          },
        ],
      },
    })
    const [pie] = chartSpecs(html)
    expect((pie.datasets as Array<Record<string, unknown>>)[0].backgroundColor).toEqual(colors)
    expect(notes).not.toContain('CSS color')
  })
})

/** The color the page script paints for a token: the palette index wraps at 7. */
function painted(token: unknown): string {
  return String(token).replace(/^\$chart-(\d+)/, (_, n) => `$chart-${Number(n) % 7}`)
}

describe('many series', () => {
  it('gives every series past the palette its own shade and dash, and says so', async () => {
    const datasets = Array.from({ length: 10 }, (_, i) => ({ label: `S${i}`, data: [i, i + 1] }))
    const { html, notes } = await render({
      data: { title: 'T', charts: [{ type: 'line', labels: ['a', 'b'], datasets }] },
    })
    const [line] = chartSpecs(html)
    const styles = (line.datasets as Array<Record<string, unknown>>).map(ds =>
      JSON.stringify([painted(ds.borderColor), ds.borderDash ?? null])
    )
    expect(new Set(styles).size).toBe(10)
    expect(notes).toContain(
      'data.charts[0] has 10 series and the palette 7 colors, so series 8-10 repeat them in fainter shades. Fewer series read better.'
    )
  })

  it('names the one series past the palette', async () => {
    const datasets = Array.from({ length: 8 }, (_, i) => ({ label: `S${i}`, data: [i, i + 1] }))
    const { notes } = await render({
      data: { title: 'T', charts: [{ type: 'bar', labels: ['a', 'b'], datasets }] },
    })
    expect(notes).toContain(
      'data.charts[0] has 8 series and the palette 7 colors, so series 8 repeats one in a fainter shade.'
    )
  })

  it('gives slices past the palette a fainter shade', async () => {
    const labels = Array.from({ length: 9 }, (_, i) => `L${i}`)
    const { html } = await render({
      data: {
        title: 'T',
        charts: [{ type: 'pie', labels, datasets: [{ data: labels.map((_, i) => i + 1) }] }],
      },
    })
    const [pie] = chartSpecs(html)
    const colors = (pie.datasets as Array<Record<string, unknown>>)[0].backgroundColor as string[]
    expect(new Set(colors.map(painted)).size).toBe(9)
  })

  it('says nothing about the palette when the caller colored every slice', async () => {
    const labels = Array.from({ length: 9 }, (_, i) => `L${i}`)
    const backgroundColor = labels.map((_, i) => `#0000${String(i).padStart(2, '0')}`)
    const { notes } = await render({
      data: {
        title: 'T',
        charts: [
          { type: 'pie', labels, datasets: [{ data: labels.map(() => 1), backgroundColor }] },
        ],
      },
    })
    expect(notes).not.toContain('palette')
  })
})

describe('gauge', () => {
  it('reads out the actual value and its label while the dial stays within range', async () => {
    const { html, notes } = await render({
      data: {
        title: 'T',
        charts: [{ type: 'gauge', title: 'Load', labels: ['Uptime'], datasets: [{ data: [180] }] }],
      },
    })
    const [gauge] = chartSpecs(html)
    expect(gauge.gauge).toEqual({ value: '180', max: '100' })
    expect((gauge.datasets as Array<{ data: number[] }>)[0].data).toEqual([100, 0])
    expect(html).toContain('<p class="chart-card__caption">Uptime</p>')
    expect(notes).toContain(
      'data.charts[0]: the gauge value 180 is outside 0..100, so the dial is drawn full and the readout shows 180.'
    )
  })

  it('asks no labels of a gauge', async () => {
    const { notes } = await render({
      data: { title: 'T', charts: [{ type: 'gauge', datasets: [{ data: [72] }] }] },
    })
    expect(notes).not.toContain('labels')
  })
})

describe('value tables without Chart.js', () => {
  it('keeps the radius of a bubble', async () => {
    const { html } = await render({
      inlineChartJs: false,
      data: {
        title: 'T',
        charts: [{ type: 'bubble', datasets: [{ label: 'b', data: [{ x: 1, y: 2, r: 9 }] }] }],
      },
    })
    expect(html).toContain('<td>(1, 2, 9)</td>')
  })
})

describe('section headings', () => {
  it('keeps a section heading with the content it titles', async () => {
    const { html } = await render({
      data: {
        title: 'T',
        charts: [{ type: 'bar', labels: ['a'], datasets: [{ data: [1] }] }],
        tables: [{ title: 'Open issues', headers: ['A'], rows: [['1']] }],
      },
    })
    expect(html).toMatch(
      /<section class="section"><h2 class="section__title">Visual Trends<\/h2><section class="chart-grid">[\s\S]*?<\/section><\/section>/
    )
    expect(html).toMatch(
      /<section class="section"><h2 class="section__title">Open issues<\/h2>\s*<div class="data-table-wrap">[\s\S]*?<\/div><\/section>/
    )
    const printBlock = /@media print \{([\s\S]*?)\n\}/.exec(html)![1]
    expect(printBlock).toMatch(/\.section__title \{[^}]*break-after: avoid/)
  })
})

describe('defaultThemeMode', () => {
  it('follows a light viewer when the default is dark', async () => {
    const { html } = await render({
      defaultThemeMode: 'dark',
      data: { title: 'T', kpis: [{ label: 'x', value: 1 }] },
    })
    const light =
      /@media \(prefers-color-scheme: light\) \{\s*:root:not\(\[data-theme\]\) \{([\s\S]*?)\}/.exec(
        html
      )
    expect(light).not.toBeNull()
    expect(light![1]).toContain('--bg: #')
    expect(html).not.toContain('@media (prefers-color-scheme: dark)')
  })

  it('follows a dark viewer when the default is light', async () => {
    const { html } = await render({ data: { title: 'T', kpis: [{ label: 'x', value: 1 }] } })
    expect(html).toContain('@media (prefers-color-scheme: dark)')
    expect(html).not.toContain('@media (prefers-color-scheme: light)')
  })
})
