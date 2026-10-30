// Every generator reports each argument it does not take: those its schema
// does not declare, less the ones it says it took under another name
// (prepared(), toolExecution.ts). This contract puts an undeclared key in
// every object the schema closes and expects each one named, so a generator
// that claims a field it does not show is caught.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { INTERNAL_TOOLS } from '../internalTools'
import { unknownArguments } from '../schemaArguments'

type SchemaNode = {
  type?: unknown
  properties?: Record<string, SchemaNode>
  items?: SchemaNode
  anyOf?: SchemaNode[]
  additionalProperties?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function branchFor(node: SchemaNode | undefined, value: unknown): SchemaNode | undefined {
  if (!node?.anyOf) return node
  const type = Array.isArray(value) ? 'array' : isRecord(value) ? 'object' : undefined
  return node.anyOf.find(branch => {
    const t = branch.type
    return type !== undefined && (Array.isArray(t) ? t.includes(type) : t === type)
  })
}

/** `value` with an undeclared `unreadN` key added to every object its schema closes. */
function withUndeclaredKeys(schema: SchemaNode, value: unknown): unknown {
  let n = 0
  const visit = (raw: SchemaNode | undefined, item: unknown): unknown => {
    const node = branchFor(raw, item)
    if (Array.isArray(item)) return item.map(entry => visit(node?.items, entry))
    if (!isRecord(item)) return item
    if (!node?.properties || node.additionalProperties !== undefined) return item
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(item)) out[key] = visit(node.properties[key], entry)
    out[`unread${n++}`] = 1
    return out
  }
  return visit(schema, value)
}

/** The note prepared() adds for `ignored`. */
function note(ignored: string[]): string {
  const listed = ignored.slice(0, 10).map(name => `'${name}'`)
  if (ignored.length > 10) listed.push(`and ${ignored.length - 10} more`)
  return `Ignored arguments this tool does not read: ${listed.join(', ')}.`
}

const CALLS: Array<[string, Record<string, unknown>]> = [
  ['clerum__generate_markdown', { filename: 'i.md', content: '# T' }],
  [
    'clerum__generate_pdf',
    {
      filename: 'i.pdf',
      title: 'T',
      body: 'x',
      branding: { companyName: 'A' },
      tables: [{ headers: ['a'], rows: [['1']] }],
    },
  ],
  [
    'clerum__generate_docx',
    {
      filename: 'i.docx',
      title: 'T',
      body: 'x',
      branding: { companyName: 'A' },
      tables: [{ headers: ['a'], rows: [['1']] }],
    },
  ],
  [
    'clerum__generate_xlsx',
    {
      filename: 'i.xlsx',
      branding: { companyName: 'A' },
      sheets: [
        {
          name: 'S',
          rows: [
            ['a', 'b'],
            [1, 2],
          ],
          titleRow: { text: 'T' },
          conditionalFormatting: [
            { column: 'a', rules: [{ greaterThan: 0, fillColor: '#dcfce7' }] },
          ],
        },
        { name: 'Two', rows: [['c'], [3]] },
      ],
    },
  ],
  [
    'clerum__generate_pptx',
    {
      filename: 'i.pptx',
      branding: { companyName: 'A' },
      slides: [
        { layout: 'title-bullets', title: 'T', bullets: ['a'] },
        {
          layout: 'title-chart',
          title: 'C',
          chart: {
            type: 'bar',
            labels: ['a'],
            datasets: [{ label: 'S', data: [{ label: 'a', value: 1 }] }],
          },
        },
        { layout: 'kpis', title: 'K', kpis: [{ label: 'R', value: '1' }] },
        { layout: 'title-table', title: 'Tb', table: { headers: ['a'], rows: [['1']] } },
      ],
    },
  ],
  [
    'clerum__generate_chart',
    {
      filename: 'i.png',
      type: 'bar',
      data: { labels: ['a', 'b'], datasets: [{ label: 'S', data: [{ label: 'a', value: 1 }, 2] }] },
    },
  ],
  [
    'clerum__generate_chart',
    {
      filename: 's.png',
      type: 'scatter',
      data: { datasets: [{ label: 'S', data: [{ x: 1, y: 2 }] }] },
    },
  ],
  [
    'clerum__generate_dashboard',
    {
      filename: 'i',
      data: {
        title: 'I',
        kpis: [{ label: 'R', value: 1 }],
        charts: [{ type: 'bar', labels: ['a'], datasets: [{ label: 'x', data: [1] }] }],
        tables: [{ headers: ['a'], rows: [[1]] }],
      },
    },
  ],
]

describe('every argument a generator does not read is named', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-ignored-args-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it.each(CALLS)('%s', async (name, args) => {
    const tool = INTERNAL_TOOLS.find(t => t.name === name)!
    const sent = withUndeclaredKeys(tool.parameters as SchemaNode, args) as Record<string, unknown>
    const expected = unknownArguments(tool.parameters, sent)
    // Witness: only the added keys are undeclared, and every nested object
    // the schema closes got one (markdown has only the top level).
    expect(expected.every(entry => /unread\d+$/.test(entry))).toBe(true)
    expect(expected.some(entry => /[.[]/.test(entry))).toBe(name !== 'clerum__generate_markdown')

    const result = await tool.execute(sent, dir)
    expect(result.success, result.error).toBe(true)
    expect(result.content).toContain(note(expected))
  })

  it('names the colors of a native deck chart, which takes its colors from the palette', async () => {
    const tool = INTERNAL_TOOLS.find(t => t.name === 'clerum__generate_pptx')!
    const sent = {
      filename: 'c.pptx',
      slides: [
        {
          layout: 'title-chart',
          title: 'C',
          chart: {
            type: 'bar',
            labels: ['a'],
            datasets: [{ label: 'S', data: [1], backgroundColor: '#ff0000', fill: true }],
          },
        },
      ],
    }
    const expected = unknownArguments(tool.parameters, sent)
    expect(expected).toEqual([
      'slides[0].chart.datasets[0].backgroundColor',
      'slides[0].chart.datasets[0].fill',
    ])
    const result = await tool.execute(sent, dir)
    expect(result.success, result.error).toBe(true)
    expect(result.content).toContain(note(expected))
  })

  it('names the fields of the first sheet when top-level images are moved onto it', async () => {
    // A 1x1 PNG in the output folder, named as the generators take images.
    fs.writeFileSync(
      path.join(dir, 'dot.png'),
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64'
      )
    )
    const tool = INTERNAL_TOOLS.find(t => t.name === 'clerum__generate_xlsx')!
    const sent = withUndeclaredKeys(tool.parameters as SchemaNode, {
      filename: 'a.xlsx',
      sheets: [{ name: 'S', rows: [['a'], [1]] }],
      images: ['dot.png'],
    }) as Record<string, unknown>
    // Top-level images is not in the schema but is read, as an alias.
    const expected = unknownArguments(tool.parameters, sent).filter(entry => entry !== 'images')
    expect(expected).toContain('sheets[0].unread0')

    const result = await tool.execute(sent, dir)
    expect(result.success, result.error).toBe(true)
    expect(result.content).toContain('placed on the first sheet')
    expect(result.content).toContain(note(expected))
  })
})
