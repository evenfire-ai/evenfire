/**
 * The workflow router validates against the dashboard schema, so the schema must
 * accept every shape the renderer draws. The chat path runs the renderer on
 * unvalidated arguments, which it must draw safely.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { INTERNAL_TOOLS } from '../internalTools'
import type { InternalToolDefinition, InternalToolResult } from '../types'
import { workflowRouter } from './support/workflowRouter'

const TOOL = 'clerum__generate_dashboard'

interface SchemaNode {
  type?: string | string[]
  description?: string
  enum?: string[]
  properties?: Record<string, SchemaNode>
  items?: SchemaNode
  anyOf?: SchemaNode[]
}

function dashboardTool(): InternalToolDefinition {
  return INTERNAL_TOOLS.find(t => t.name === TOOL)!
}

let outputDir: string

beforeEach(() => {
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-dash-contract-'))
})

afterEach(() => {
  fs.rmSync(outputDir, { recursive: true, force: true })
})

async function viaWorkflow(args: Record<string, unknown>): Promise<InternalToolResult> {
  const { result } = await workflowRouter(outputDir).callTool(TOOL, structuredClone(args))
  return result.content as InternalToolResult
}

/** The chat adapter executes the tool without validating its arguments. */
async function viaChat(args: Record<string, unknown>): Promise<InternalToolResult> {
  return dashboardTool().execute(structuredClone(args), outputDir)
}

function page(result: InternalToolResult): string {
  expect(result.error).toBeUndefined()
  expect(result.success).toBe(true)
  return fs.readFileSync(result.artifact!.path, 'utf8')
}

const custom = (blocks: unknown[]) => ({
  filename: 'd.html',
  template: 'custom',
  data: { title: 'T', blocks },
})

/** Inputs the renderer draws, which both validated paths must accept. */
const HANDLED: Array<[string, Record<string, unknown>, RegExp]> = [
  [
    'a numeric KPI value',
    { filename: 'd.html', data: { title: 'T', kpis: [{ label: 'NPS', value: 48 }] } },
    /kpi-card__value">48</,
  ],
  [
    'numeric and empty table cells',
    {
      filename: 'd.html',
      data: { title: 'T', tables: [{ headers: ['a', 'b', 'c'], rows: [['EU', 1200, null]] }] },
    },
    /<td>1200<\/td><td><\/td>/,
  ],
  [
    'a section written as one paragraph',
    {
      filename: 'd.html',
      data: { title: 'T', sections: [{ type: 'narrative', content: 'Hola' }] },
    },
    /<p>Hola<\/p>/,
  ],
  [
    'a series with a gap and values written as text',
    {
      filename: 'd.html',
      data: {
        title: 'T',
        charts: [
          {
            type: 'line',
            labels: ['a', 'b', 'c'],
            datasets: [{ label: 's', data: [1, null, '1,200'] }],
          },
        ],
      },
    },
    /\[1,null,1200\]/,
  ],
  [
    'one color per bar',
    {
      filename: 'd.html',
      data: {
        title: 'T',
        charts: [
          {
            type: 'bar',
            labels: ['a', 'b'],
            datasets: [{ data: [1, 2], backgroundColor: ['#111111', '#222222'] }],
          },
        ],
      },
    },
    /"#111111","#222222"/,
  ],
  [
    'a custom kpis block of KPI objects',
    custom([{ type: 'kpis', items: [{ label: 'Strategic moves', value: 12 }] }]),
    /kpi-card__value">12</,
  ],
  [
    'a custom charts-grid block of chart objects',
    custom([
      {
        type: 'charts-grid',
        items: [{ type: 'bar', title: 'Grid', labels: ['a'], datasets: [{ data: [3] }] }],
      },
    ]),
    /Grid<\/h3>/,
  ],
  [
    'a custom incidents block of incident objects',
    custom([{ type: 'incidents', items: [{ time: '10:00', title: 'DB down', severity: 'high' }] }]),
    /DB down<\/h4>/,
  ],
  [
    'custom code, callout and narrative blocks with string content',
    custom([
      { type: 'code', language: 'sql', content: 'SELECT 1;' },
      { type: 'callout', tone: 'warning', content: 'Careful' },
      { type: 'narrative', content: 'Once' },
    ]),
    /SELECT 1;.*Careful.*Once/s,
  ],
  [
    'numeric chart labels such as years',
    {
      filename: 'd.html',
      data: {
        title: 'T',
        charts: [{ type: 'bar', labels: [2024, 2025], datasets: [{ data: [1, 2] }] }],
      },
    },
    /"labels":\["2024","2025"\]/,
  ],
  [
    'a technical-report code section with its language',
    {
      filename: 'd.html',
      template: 'technical-report',
      data: { title: 'T', sections: [{ type: 'code', language: 'sql', content: ['SELECT 1;'] }] },
    },
    /code-block__lang">sql<\/div><pre><code>SELECT 1;/,
  ],
  [
    'operations-pulse services and incidents',
    {
      filename: 'd.html',
      template: 'operations-pulse',
      data: {
        title: 'T',
        services: [{ name: 'API', status: 'degraded', metric: '142 ms' }],
        incidents: [{ time: '10:42', title: 'Latency', severity: 'medium' }],
      },
    },
    /health-card" data-status="degraded".*timeline-item" data-severity="med"/s,
  ],
  [
    'a financial-review hero chart and period',
    {
      filename: 'd.html',
      template: 'financial-review',
      data: {
        title: 'T',
        period: 'Q3 2026',
        heroChart: {
          type: 'area',
          title: 'Revenue',
          labels: ['Jul', 'Aug'],
          datasets: [{ data: [1, 2] }],
        },
      },
    },
    /hero__eyebrow">Q3 2026<.*chart-card chart-card--wide/s,
  ],
  [
    'the extended chart types clerum__generate_chart draws',
    {
      filename: 'd.html',
      data: {
        title: 'T',
        charts: ['stackedBar', 'stackedArea', 'mixedBarLine', 'funnel', 'gauge', 'waterfall'].map(
          type => ({
            type,
            title: type,
            labels: ['a', 'b'],
            datasets: [
              { label: 'x', data: [3, 5] },
              { label: 'y', data: [2, 4] },
            ],
          })
        ),
      },
    },
    /"id":"chart-5"/,
  ],
  [
    'numeric KPI and service deltas and metrics',
    {
      filename: 'd.html',
      template: 'operations-pulse',
      data: {
        title: 'T',
        kpis: [{ label: 'Churn', value: 2.1, delta: -0.3 }],
        services: [{ name: 'API', status: 'healthy', metric: 142, delta: 0.2 }],
      },
    },
    /health-card__metric">142<.*data-sentiment="bad">-0\.3</s,
  ],
  [
    'a sparkline of text and gaps, and a gauge maximum written as text',
    {
      filename: 'd.html',
      data: {
        title: 'T',
        kpis: [{ label: 'k', value: 1, sparkline: ['1', null, '3'] }],
        charts: [{ type: 'gauge', gaugeMax: '10', datasets: [{ data: [3] }] }],
      },
    },
    /data-spark="\[1,null,3\]".*"max":"10"/s,
  ],
  [
    'a custom KPI block with a numeric delta',
    custom([{ type: 'kpis', items: [{ label: 'Cost', value: 1, delta: 5 }] }]),
    /data-sentiment="good">\+5</,
  ],
  [
    'a numeric footer date and numbers in section content',
    {
      filename: 'd.html',
      data: {
        title: 'T',
        meta: { date: 2026 },
        sections: [{ type: 'bullets', content: ['Units', 1200] }],
      },
    },
    /<li>1200<\/li>.*<span>2026<\/span>/s,
  ],
  [
    'status and severity words outside the listed ones, and an incident with no time',
    {
      filename: 'd.html',
      template: 'operations-pulse',
      data: {
        title: 'T',
        services: [{ name: 'API', status: 'operational' }],
        incidents: [{ title: 'x', severity: 'P1' }],
      },
    },
    /data-status="healthy".*severity-high">P1</s,
  ],
  [
    'custom blocks with rows as records, numeric bullets and a numeric KPI label',
    {
      filename: 'd.html',
      template: 'custom',
      data: {
        title: 'T',
        blocks: [
          {
            type: 'table',
            spec: { headers: ['Region', 'Revenue'], rows: [{ Region: 'NA', Revenue: 1200 }] },
          },
          { type: 'bullets', items: [2026, 'Launch'] },
          { type: 'kpis', items: [{ label: 2026, value: 5 }] },
        ],
      },
    },
    /NA.*1200.*2026.*Launch.*2026/s,
  ],
]

describe('dashboard schema accepts what the renderer handles', () => {
  it.each(HANDLED)('%s, on the workflow path', async (_label, args, rendered) => {
    expect(page(await viaWorkflow(args))).toMatch(rendered)
  })

  it.each(HANDLED)('%s, on the chat path', async (_label, args, rendered) => {
    expect(page(await viaChat(args))).toMatch(rendered)
  })
})

describe('dashboard schema rejects what cannot render, with the field to fix', () => {
  it('names an unknown chart type inside a block spec', async () => {
    const r = await viaWorkflow(
      custom([{ type: 'chart', spec: { type: 'gauge2', datasets: [{ data: [1] }] } }])
    )
    expect(r.success).toBe(false)
    expect(r.error).toContain('data/blocks/0/spec/type must be equal to one of the allowed values')
  })

  it('refuses a spacer size outside its enum, and draws a safe one without validation', async () => {
    const args = custom([{ type: 'spacer', size: 'md"><img src=x onerror=alert(1)>' }])
    const refused = await viaWorkflow(args)
    expect(refused.success).toBe(false)
    expect(refused.error).toContain('data/blocks/0/size must be equal to one of the allowed values')
    const html = page(await viaChat(args))
    expect(html).toContain('dashboard-spacer--md')
    expect(html).not.toContain('<img src=x')
  })

  it('asks for the status a service card needs', async () => {
    const r = await viaWorkflow({
      filename: 'd.html',
      template: 'operations-pulse',
      data: { title: 'T', services: [{ name: 'API' }] },
    })
    expect(r.error).toContain("data/services/0 must have required property 'status'")
  })
})

describe('dashboard schema size', () => {
  it('stays compact, since every model request carries it', () => {
    expect(JSON.stringify(dashboardTool().parameters).length).toBeLessThan(13_600)
  })

  it('points repeated shapes at the field that documents them', () => {
    const data = (dashboardTool().parameters as SchemaNode).properties!.data
    const spec = data.properties!.blocks.items!.properties!.spec
    expect(spec.properties!.type.description).toBe('As data.charts[].')
    expect(data.properties!.heroChart.properties!.datasets.description).toBe('As data.charts[].')
  })

  it('gives block specs and items the same contract as the fields they repeat', () => {
    const data = (dashboardTool().parameters as SchemaNode).properties!.data
    const block = data.properties!.blocks.items!
    const itemObject = block.properties!.items.items!.anyOf![1]
    const chartType = data.properties!.charts.items!.properties!.type
    expect(block.properties!.spec.properties!.type.enum).toEqual(chartType.enum)
    expect(itemObject.properties!.type.enum).toEqual(chartType.enum)
    expect(data.properties!.heroChart.properties!.type.enum).toEqual(chartType.enum)
    expect(block.properties!.services.items!.properties!.status.enum).toEqual(
      data.properties!.services.items!.properties!.status.enum
    )
    const kpi = data.properties!.kpis.items!.properties!
    for (const field of ['deltaDirection', 'deltaSentiment', 'accent']) {
      expect(itemObject.properties![field].enum).toEqual(kpi[field].enum)
    }
    expect(itemObject.properties!.severity.enum).toEqual(
      data.properties!.incidents.items!.properties!.severity.enum
    )
  })

  it('keeps the copied fields whose absence would misstate a value', () => {
    const data = (dashboardTool().parameters as SchemaNode).properties!.data
    const block = data.properties!.blocks.items!
    const itemObject = block.properties!.items.items!.anyOf![1]
    expect(itemObject.properties!.delta.type).toEqual(['string', 'number'])
    expect(itemObject.properties!.resolvedAt.type).toBe('string')
    for (const copy of [data.properties!.heroChart, block.properties!.spec, itemObject]) {
      expect(copy.properties!.gaugeMax.type).toEqual(['number', 'string'])
    }
  })
})

describe('dashboard schema survives Gemini', () => {
  it('gives every object node properties', () => {
    // The Gemini API rejects an OBJECT schema with no properties
    // ("properties: should be non-empty for OBJECT type").
    const empty: string[] = []
    const visit = (node: unknown, where: string): void => {
      if (!node || typeof node !== 'object' || Array.isArray(node)) return
      const n = node as Record<string, unknown>
      const types = Array.isArray(n.type) ? n.type : [n.type]
      const props = n.properties as Record<string, unknown> | undefined
      if (types.includes('object') && (!props || Object.keys(props).length === 0)) empty.push(where)
      for (const [k, v] of Object.entries(props ?? {})) visit(v, `${where}.${k}`)
      if (n.items) visit(n.items, `${where}[]`)
      if (Array.isArray(n.anyOf)) n.anyOf.forEach((b, i) => visit(b, `${where}|${i}`))
    }
    visit(dashboardTool().parameters, '')
    expect(empty).toEqual([])
  })
})
