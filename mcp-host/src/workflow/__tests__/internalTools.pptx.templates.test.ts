/**
 * Template decks are built from `data`: every field is declared in the schema,
 * required fields are checked per template, and a wrong field name is reported.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { INTERNAL_TOOLS } from '../internalTools'
import { PPTX_TEMPLATE_FIELDS } from '../pptxTemplates'
import {
  chartValues,
  chartXmls,
  generatePptx,
  pictures,
  shapeWithText,
  slideCount,
  slideXml,
  writeImage,
} from './support/pptxXml'

let outputDir: string

beforeEach(() => {
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-pptx-tpl-'))
})

afterEach(() => {
  fs.rmSync(outputDir, { recursive: true, force: true })
})

function allText(file: string): string {
  const parts: string[] = []
  for (let n = 1; n <= slideCount(file); n++) {
    parts.push([...slideXml(file, n).matchAll(/<a:t>([^<]*)<\/a:t>/g)].map(m => m[1]).join(' '))
  }
  return parts.join('\n')
}

describe('clerum__generate_pptx — template data is declared', () => {
  it('declares every field each template reads, and says which template it belongs to', () => {
    const tool = INTERNAL_TOOLS.find(t => t.name === 'clerum__generate_pptx')!
    const data = (tool.parameters.properties as Record<string, Record<string, unknown>>).data
    const props = data.properties as Record<string, { description: string }>
    for (const [template, fields] of Object.entries(PPTX_TEMPLATE_FIELDS)) {
      for (const field of [...fields.required, ...fields.optional]) {
        expect(props[field], `${template}.${field}`).toBeDefined()
        expect(props[field].description).toContain(template)
      }
    }
  })
})

type SchemaNode = Record<string, any>

const pptxTool = INTERNAL_TOOLS.find(t => t.name === 'clerum__generate_pptx')!
const pptxParameters = pptxTool.parameters as SchemaNode

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A schema with its descriptions taken out: what a validator or a provider acts on. */
function shapeOf(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(shapeOf)
  if (!isRecord(node)) return node
  return Object.fromEntries(
    Object.entries(node)
      .filter(([key, value]) => !(key === 'description' && typeof value === 'string'))
      .map(([key, value]) => [key, shapeOf(value)])
  )
}

/**
 * `value` with only the properties `schema` declares, as a client or provider
 * that builds the call from the declared fields sends it.
 */
function declaredOnly(schema: SchemaNode | undefined, value: unknown): unknown {
  const kind = Array.isArray(value) ? 'array' : isRecord(value) ? 'object' : typeof value
  const node = schema?.anyOf
    ? (schema.anyOf as SchemaNode[]).find(branch => [branch.type].flat().includes(kind))
    : schema
  if (Array.isArray(value)) return value.map(item => declaredOnly(node?.items, item))
  if (!isRecord(value) || !node?.properties) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key in node.properties)
      .map(([key, item]) => [key, declaredOnly(node.properties[key], item)])
  )
}

describe('clerum__generate_pptx — template charts are declared', () => {
  const data = pptxParameters.properties.data.properties as Record<string, SchemaNode>
  const slideChart = pptxParameters.properties.slides.items.properties.chart as SchemaNode
  const templateCharts = (): Array<[string, SchemaNode]> =>
    Object.entries(data)
      .map(([name, node]): [string, SchemaNode] =>
        node.type === 'array' ? [`${name}[]`, node.items] : [name, node]
      )
      .filter(([, node]) => node.properties?.type?.enum?.includes('bar'))

  it('finds every chart the templates read', () => {
    expect(templateCharts().map(([name]) => name)).toEqual([
      'charts[]',
      'revenueChart',
      'breakdownChart',
      'tractionChart',
    ])
  })

  it('declares at each the fields of slides[].chart, as slides[].chart types them', () => {
    // The nested `data` form is left out of the template charts; the flat
    // fields alone draw any chart.
    const { data: nested, ...fields } = slideChart.properties as Record<string, SchemaNode>
    expect(nested).toBeDefined()
    for (const [name, node] of templateCharts()) {
      expect(shapeOf(node.properties), name).toEqual(shapeOf(fields))
      expect(node.description, name).toContain('slides[].chart')
    }
  })
})

describe('clerum__generate_pptx — template charts sent with declared fields only', () => {
  const NATIVE = {
    type: 'bar',
    title: 'Revenue by month',
    labels: ['Jul', 'Aug'],
    datasets: [{ label: 'Revenue', data: [1200, 1500] }],
    caption: 'Unaudited figures.',
  }
  const COVERS: Record<string, Record<string, unknown>> = {
    'executive-brief': { title: 'Brief' },
    'quarterly-review': { title: 'Q3 review', period: 'Q3 2026' },
    'pitch-deck': { company: 'Acme', tagline: 'T', problem: 'P', solution: 'S' },
  }
  const CHARTS: Array<[string, string, (chart: unknown) => Record<string, unknown>]> = [
    ['executive-brief', 'charts', chart => ({ charts: [chart] })],
    ['quarterly-review', 'revenueChart', chart => ({ revenueChart: chart })],
    ['quarterly-review', 'breakdownChart', chart => ({ breakdownChart: chart })],
    ['pitch-deck', 'tractionChart', chart => ({ tractionChart: chart })],
  ]

  async function sendDeclared(template: string, data: Record<string, unknown>) {
    const args = { filename: 'd.pptx', template, data: { ...COVERS[template], ...data } }
    const sent = declaredOnly(pptxParameters, args) as Record<string, unknown>
    return { sent, result: await generatePptx(sent, outputDir) }
  }

  it.each(CHARTS)('%s draws data.%s as a native chart', async (template, _field, place) => {
    const { sent, result } = await sendDeclared(template, place(NATIVE))
    expect(sent.data).toEqual({ ...COVERS[template], ...place(NATIVE) })
    expect(result.success, result.error).toBe(true)
    const file = path.join(outputDir, 'd.pptx')
    const charts = chartXmls(file)
    expect(charts).toHaveLength(1)
    expect(chartValues(charts[0])).toEqual([['1200', '1500']])
    expect(allText(file)).toContain('Revenue by month')
    expect(allText(file)).toContain('Unaudited figures.')
  })

  it.each(CHARTS)('%s draws data.%s from a chart image', async (template, _field, place) => {
    await writeImage(outputDir, 'sales.png', 400, 300)
    const chart = { path: 'sales.png', title: 'Sales', caption: 'From the chart tool.' }
    const { sent, result } = await sendDeclared(template, place(chart))
    expect(sent.data).toEqual({ ...COVERS[template], ...place(chart) })
    expect(result.success, result.error).toBe(true)
    const file = path.join(outputDir, 'd.pptx')
    expect(chartXmls(file)).toHaveLength(0)
    const withPicture = Array.from({ length: slideCount(file) }, (_, i) =>
      slideXml(file, i + 1)
    ).filter(xml => pictures(xml).length > 0)
    expect(withPicture).toHaveLength(1)
    expect(allText(file)).toContain('From the chart tool.')
  })
})

describe('clerum__generate_pptx — template data is checked', () => {
  it('names a missing required field instead of drawing "undefined Highlights"', async () => {
    const result = await generatePptx(
      {
        filename: 'q.pptx',
        template: 'quarterly-review',
        data: { title: 'Q3 review', highlights: ['Record quarter'] },
      },
      outputDir
    )
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/data\.period/)
    expect(result.error).toMatch(/quarterly-review/)
  })

  it('names the missing severity instead of failing with a TypeError', async () => {
    const result = await generatePptx(
      {
        filename: 'i.pptx',
        template: 'incident-review',
        data: { title: 'Outage', summary: 'API down', date: '2026-09-01' },
      },
      outputDir
    )
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/data\.severity/)
    expect(result.error).not.toMatch(/Cannot read/)
  })

  it('fails when every field sent was one the template does not read', async () => {
    const result = await generatePptx(
      {
        filename: 'e.pptx',
        template: 'executive-brief',
        data: { title: 'Brief', keyMetrics: [{ label: 'x', value: '1' }], summaryPoints: ['a'] },
      },
      outputDir
    )
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/keyMetrics/)
    expect(result.error).toMatch(/kpis/)
  })

  it('reads snake_case field names and reports the ones it could not place', async () => {
    const result = await generatePptx(
      {
        filename: 'e.pptx',
        template: 'executive-brief',
        data: {
          title: 'Brief',
          next_steps: ['Ship it'],
          key_takeaways: ['a'],
        },
      },
      outputDir
    )
    expect(result.success, result.error).toBe(true)
    const file = path.join(outputDir, 'e.pptx')
    expect(slideCount(file)).toBe(2)
    expect(allText(file)).toContain('Ship it')
    expect(result.content).toMatch(/next_steps/)
    expect(result.content).toMatch(/key_takeaways/)
    expect(result.content).toMatch(/takeaways/)
  })

  it('rejects a field of the wrong shape with the field name', async () => {
    const result = await generatePptx(
      {
        filename: 'e.pptx',
        template: 'executive-brief',
        data: { title: 'Brief', kpis: [{ label: 'Revenue' }] },
      },
      outputDir
    )
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/data\.kpis\[0\]\.value/)
  })
})

describe('clerum__generate_pptx — template decks read correctly', () => {
  it('adds the Outlook section only when there is an outlook', async () => {
    const result = await generatePptx(
      {
        filename: 'q.pptx',
        template: 'quarterly-review',
        data: { title: 'Q3 review', period: 'Q3 2026', highlights: ['Record quarter'] },
      },
      outputDir
    )
    expect(result.success, result.error).toBe(true)
    const file = path.join(outputDir, 'q.pptx')
    expect(allText(file)).not.toContain('Outlook')
    expect(allText(file)).toContain('Q3 2026 Highlights')
  })

  it('keeps the whole market description in the pitch deck', async () => {
    const description =
      'Global small-satellite launch services by 2030, per three independent analyst reports ' +
      'covering commercial and government demand.'
    const result = await generatePptx(
      {
        filename: 'p.pptx',
        template: 'pitch-deck',
        data: {
          company: 'Acme',
          tagline: 'Launch for everyone',
          problem: 'Launch is scarce',
          solution: 'Reusable small launchers',
          marketSize: { value: '$12B', description },
        },
      },
      outputDir
    )
    expect(result.success, result.error).toBe(true)
    expect(allText(path.join(outputDir, 'p.pptx'))).toContain(description)
  })

  it('shows team names larger than their roles', async () => {
    const result = await generatePptx(
      {
        filename: 'p.pptx',
        template: 'pitch-deck',
        data: {
          company: 'Acme',
          tagline: 'Launch',
          problem: 'P',
          solution: 'S',
          team: [{ name: 'Ada Lovelace', role: 'CEO' }],
        },
      },
      outputDir
    )
    expect(result.success, result.error).toBe(true)
    const file = path.join(outputDir, 'p.pptx')
    const teamSlide = slideCount(file)
    const xml = slideXml(file, teamSlide)
    const name = shapeWithText(xml, 'Ada Lovelace')
    const role = shapeWithText(xml, 'CEO')
    expect(name.sizes[0]).toBeGreaterThan(role.sizes[0])
  })

  it('does not print the chart title twice on a template chart slide', async () => {
    const result = await generatePptx(
      {
        filename: 'e.pptx',
        template: 'executive-brief',
        data: {
          title: 'Brief',
          charts: [
            { type: 'bar', title: 'Revenue', labels: ['a'], datasets: [{ label: 's', data: [1] }] },
          ],
        },
      },
      outputDir
    )
    expect(result.success, result.error).toBe(true)
    expect(chartXmls(path.join(outputDir, 'e.pptx'))[0]).not.toContain('<c:title>')
  })

  it('warns that slides[] is ignored when a template builds the deck', async () => {
    const result = await generatePptx(
      {
        filename: 'e.pptx',
        template: 'executive-brief',
        data: { title: 'Brief', takeaways: ['a'] },
        slides: [{ layout: 'title-bullets', title: 'x', bullets: ['y'] }],
      },
      outputDir
    )
    expect(result.success, result.error).toBe(true)
    expect(result.content).toMatch(/slides/)
  })

  it('says which templates read data when it comes with slides[] and no template', async () => {
    const result = await generatePptx(
      {
        filename: 'd.pptx',
        slides: [{ layout: 'title-bullets', title: 'x', bullets: ['y'] }],
        data: {},
      },
      outputDir
    )
    expect(result.success, result.error).toBe(true)
    expect(result.content).toContain(
      'data was ignored: it is only read when template is one of executive-brief, ' +
        'quarterly-review, incident-review, pitch-deck.'
    )
  })
})
