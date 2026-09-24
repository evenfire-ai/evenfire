/**
 * The arguments clerum__generate_pptx accepts, on both paths: the workflow step
 * router validates against the schema before execute() runs, the chat adapter
 * does not, and execute() itself must answer anything the schema would refuse
 * with a message naming the field, never a JavaScript TypeError or a slide that
 * prints an error inside the deck.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { INTERNAL_TOOLS } from '../internalTools'
import { generatePptx, slideCount, slideXml, tables, textShapes } from './support/pptxXml'
import { workflowRouter, workflowValidation } from './support/workflowRouter'
import { zipEntryText } from './support/zipEntries'

let outputDir: string

beforeEach(() => {
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-pptx-contract-'))
})

afterEach(() => {
  fs.rmSync(outputDir, { recursive: true, force: true })
})

const tool = INTERNAL_TOOLS.find(t => t.name === 'clerum__generate_pptx')!

const validate = (args: Record<string, unknown>) => workflowValidation(tool, args)

async function throughWorkflow(args: Record<string, unknown>) {
  const { result } = await workflowRouter(outputDir).callTool('clerum__generate_pptx', args)
  return result
}

const ACCEPTED: Array<[string, Record<string, unknown>]> = [
  [
    'numeric and empty table cells from an API',
    {
      filename: 'x.pptx',
      slides: [
        {
          layout: 'title-table',
          title: 'Regions',
          table: { headers: ['Region', 'Revenue', 'Notes'], rows: [['NA', 1200, null]] },
        },
      ],
    },
  ],
  [
    'a numeric KPI value',
    {
      filename: 'x.pptx',
      slides: [{ layout: 'kpis', title: 'K', kpis: [{ label: 'Customers', value: 1204 }] }],
    },
  ],
  [
    'years as chart labels and values written as text',
    {
      filename: 'x.pptx',
      slides: [
        {
          layout: 'title-chart',
          title: 'Revenue',
          chart: {
            type: 'line',
            labels: [2024, 2025, 2026],
            datasets: [{ label: 'Revenue', data: ['1,200', 1500, null] }],
          },
        },
      ],
    },
  ],
  [
    'a chart in the shape clerum__generate_chart takes',
    {
      filename: 'x.pptx',
      slides: [
        {
          layout: 'title-chart',
          title: 'Revenue',
          chart: { type: 'bar', data: { labels: ['a'], datasets: [{ label: 's', data: [1] }] } },
        },
      ],
    },
  ],
  [
    'an image given as a file name',
    { filename: 'x.pptx', slides: [{ layout: 'image', title: 'I', image: 'chart.png' }] },
  ],
  [
    'bullets sent as one string',
    { filename: 'x.pptx', slides: [{ layout: 'title-bullets', title: 'B', bullets: 'one\ntwo' }] },
  ],
  [
    'a typed quarterly-review payload',
    {
      filename: 'x.pptx',
      template: 'quarterly-review',
      data: {
        title: 'Q3',
        period: 'Q3 2026',
        kpis: [{ label: 'ARR', value: 1200000, delta: '+8%', deltaDirection: 'up' }],
        revenueChart: { type: 'line', labels: ['Jul'], datasets: [{ label: 'R', data: [1] }] },
        metricsTable: { headers: ['Metric', 'Value'], rows: [['NPS', 48]] },
        outlook: ['Hire'],
      },
    },
  ],
  [
    'a pitch-deck team with names and roles',
    {
      filename: 'x.pptx',
      template: 'pitch-deck',
      data: {
        company: 'Acme',
        tagline: 'T',
        problem: 'P',
        solution: 'S',
        team: [{ name: 'Ada', role: 'CEO' }],
        ask: { amount: '$5M', useOfFunds: ['Hiring'] },
      },
    },
  ],
  [
    'pitch-deck amounts sent as numbers',
    {
      filename: 'x.pptx',
      template: 'pitch-deck',
      data: {
        company: 'Acme',
        tagline: 'T',
        problem: 'P',
        solution: 'S',
        marketSize: { value: 12000000000 },
        ask: { amount: 5000000 },
      },
    },
  ],
  [
    'a KPI delta sent as a number',
    {
      filename: 'x.pptx',
      slides: [{ layout: 'kpis', title: 'K', kpis: [{ label: 'Churn', value: 2.1, delta: -0.3 }] }],
    },
  ],
]

describe('clerum__generate_pptx schema — accepts what the runtime draws', () => {
  it.each(ACCEPTED)('accepts %s', async (_label, args) => {
    expect(await validate(args)).toBe(true)
  })

  it('draws numeric and empty cells and a numeric KPI through the workflow path', async () => {
    const result = await throughWorkflow({
      filename: 'w.pptx',
      slides: [
        {
          layout: 'title-table',
          title: 'Regions',
          table: { headers: ['Region', 'Revenue', 'Notes'], rows: [['NA', 1200, null]] },
        },
        { layout: 'kpis', title: 'K', kpis: [{ label: 'Customers', value: 1204 }] },
      ],
    })
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy()
    const file = path.join(outputDir, 'w.pptx')
    expect(tables(slideXml(file, 1))[0].rows[1]).toEqual(['NA', '1200', ''])
    expect(slideXml(file, 2)).toContain('<a:t>1204</a:t>')
  })
})

describe('clerum__generate_pptx — pitch-deck amounts sent as numbers', () => {
  it('draws them grouped in thousands through the workflow path', async () => {
    const result = await throughWorkflow({
      filename: 'p.pptx',
      template: 'pitch-deck',
      data: {
        company: 'Acme',
        tagline: 'Launch for everyone',
        problem: 'Launch is scarce',
        solution: 'Reusable launchers',
        marketSize: { value: 12000000000, description: 'Global, 2030' },
        ask: { amount: 5000000, useOfFunds: ['Hiring'] },
      },
    })
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy()
    const file = path.join(outputDir, 'p.pptx')
    const text = Array.from({ length: slideCount(file) }, (_, i) => slideXml(file, i + 1)).join('')
    expect(text).toContain('<a:t>12,000,000,000</a:t>')
    expect(text).toContain('The Ask · 5,000,000')
  })
})

describe('clerum__generate_pptx schema — rejects what cannot be drawn', () => {
  it.each([
    [
      'an unknown layout',
      { filename: 'x.pptx', slides: [{ layout: 'bullets', title: 'x' }] },
      'slides/0/layout',
    ],
    [
      'a chart type with no native form',
      {
        filename: 'x.pptx',
        slides: [{ layout: 'title-chart', title: 'x', chart: { type: 'scatter' } }],
      },
      'slides/0/chart/type',
    ],
    [
      'a template list sent as a number',
      { filename: 'x.pptx', template: 'executive-brief', data: { title: 'x', takeaways: 3 } },
      'data/takeaways',
    ],
    [
      'an unknown incident severity',
      {
        filename: 'x.pptx',
        template: 'incident-review',
        data: { title: 'x', summary: 's', severity: 'sev1' },
      },
      'data/severity',
    ],
  ])('rejects %s, naming the field', async (_label, args, field) => {
    const message = await validate(args as Record<string, unknown>)
    expect(message).not.toBe(true)
    expect(String(message)).toContain(field)
  })
})

describe('clerum__generate_pptx — execute() answers malformed input by field', () => {
  it('splits bullets sent as one string into one bullet per line', async () => {
    const result = await generatePptx(
      {
        filename: 'b.pptx',
        slides: [{ layout: 'title-bullets', title: 'x', bullets: 'one\ntwo' }],
      },
      outputDir
    )
    expect(result.success, result.error).toBe(true)
    const body = textShapes(slideXml(path.join(outputDir, 'b.pptx'), 1)).find(s =>
      s.paragraphs.includes('one')
    )!
    expect(body.paragraphs).toEqual(['one', 'two'])
  })

  it('reads table rows sent as records in header order', async () => {
    const result = await generatePptx(
      {
        filename: 't.pptx',
        slides: [
          {
            layout: 'title-table',
            title: 'x',
            table: { headers: ['a', 'b'], rows: [{ b: 2, a: 1 }] },
          },
        ],
      },
      outputDir
    )
    expect(result.success, result.error).toBe(true)
    expect(tables(slideXml(path.join(outputDir, 't.pptx'), 1))[0].rows[1]).toEqual(['1', '2'])
    expect(result.content).toMatch(/header name/)
  })

  it('names a KPI without a value', async () => {
    const result = await generatePptx(
      {
        filename: 'k.pptx',
        slides: [{ layout: 'kpis', title: 'x', kpis: [{ label: 'Revenue' }] }],
      },
      outputDir
    )
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/slides\[0\]\.kpis\[0\]\.value/)
  })

  it('refuses an unknown layout with the list of layouts instead of printing it on a slide', async () => {
    const result = await generatePptx(
      { filename: 'u.pptx', slides: [{ layout: 'bullets', title: 'x', bullets: ['a'] }] },
      outputDir
    )
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/slides\[0\]\.layout/)
    expect(result.error).toMatch(/title-bullets/)
    expect(fs.existsSync(path.join(outputDir, 'u.pptx'))).toBe(false)
  })

  it('refuses a layout whose content is missing instead of an empty slide', async () => {
    const result = await generatePptx(
      {
        filename: 'e.pptx',
        slides: [
          { layout: 'title-bullets', title: 'Fine', bullets: ['a'] },
          { layout: 'title-table', title: 'No table' },
        ],
      },
      outputDir
    )
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/slides\[1\]/)
    expect(result.error).toMatch(/table/)
  })

  it('says a table with no rows shows only its headings', async () => {
    const result = await generatePptx(
      {
        filename: 't.pptx',
        slides: [
          { layout: 'title-table', title: 'Empty', table: { headers: ['A', 'B'], rows: [] } },
        ],
      },
      outputDir
    )
    expect(result.success, result.error).toBe(true)
    expect(result.content).toMatch(/slides\[0\]\.table has no rows/)
  })

  it('reports the same deck on both paths', async () => {
    const args = {
      filename: 'same.pptx',
      slides: [{ layout: 'title-bullets', title: 'x', bullets: ['a', 'b'] }],
    }
    const chat = await generatePptx(args, outputDir)
    expect(chat.success, chat.error).toBe(true)
    const chatSlides = slideCount(path.join(outputDir, 'same.pptx'))
    const workflow = await throughWorkflow(args)
    expect(workflow.isError).toBeFalsy()
    expect(slideCount(path.join(outputDir, 'same.pptx'))).toBe(chatSlides)
  })
})

describe('clerum__generate_pptx — the description matches the deck', () => {
  it('does not promise the logo on every slide or a status badge beside titles', () => {
    expect(tool.description).not.toMatch(/appears on every slide/)
    const slideProps = (
      (tool.parameters.properties as Record<string, Record<string, unknown>>).slides.items as {
        properties: Record<string, { description: string }>
      }
    ).properties
    expect(slideProps.status.description).toMatch(/cover/i)
    expect(slideProps.status.description).not.toMatch(/beside the title/)
  })

  it('says chart.type is left out when the chart is an image', () => {
    const slideProps = (
      (tool.parameters.properties as Record<string, Record<string, unknown>>).slides.items as {
        properties: Record<string, { properties: Record<string, { description: string }> }>
      }
    ).properties
    expect(slideProps.chart.properties.type.description).toMatch(
      /only for native charts.*leave it out/i
    )
  })

  it('asks for image paths as the file names clerum__generate_chart returns', () => {
    const text = JSON.stringify(tool.parameters)
    expect(text).not.toMatch(/Absolute path/)
    const pathDescriptions = [...text.matchAll(/"path":\{[^}]*"description":"([^"]+)"/g)].map(
      m => m[1]
    )
    expect(pathDescriptions.length).toBeGreaterThanOrEqual(4)
    for (const d of pathDescriptions) expect(d).toMatch(/clerum__generate_chart/)
    // A logo is not a chart, so it is asked for as a file in the output folder.
    expect(text).toMatch(/"logoPath":\{[^}]*"description":"[^"]*file name in the output folder/)
  })
})

describe('clerum__generate_pptx — document properties', () => {
  it('escapes the company name it writes into docProps/app.xml', async () => {
    const result = await generatePptx(
      {
        filename: 'amp.pptx',
        branding: { companyName: "Johnson & Johnson <R&D> O'Brien" },
        slides: [{ layout: 'cover', title: 'Q3' }],
      },
      outputDir
    )
    expect(result.success, result.error).toBe(true)
    const app = zipEntryText(path.join(outputDir, 'amp.pptx'), 'docProps/app.xml')
    expect(app).toContain('<Company>Johnson &amp; Johnson &lt;R&amp;D&gt; O&apos;Brien</Company>')
  })
})

describe('clerum__generate_pptx — mixed-direction text', () => {
  it('tags each run of a mixed Arabic and English bullet with its own language', async () => {
    const result = await generatePptx(
      {
        filename: 'mix.pptx',
        slides: [
          {
            layout: 'title-bullets',
            title: 'T',
            bullets: ['هذا نص English words في الوسط.'],
          },
        ],
      },
      outputDir
    )
    expect(result.success, result.error).toBe(true)
    const xml = slideXml(path.join(outputDir, 'mix.pptx'), 1)
    const bullet = [...xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)]
      .map(m => m[1])
      .find(p => p.includes('English'))!
    expect(bullet).toContain('rtl="1"')
    const runs = [...bullet.matchAll(/<a:rPr[^>]*lang="([^"]+)"[\s\S]*?<a:t>([^<]*)<\/a:t>/g)]
    expect(runs.map(r => r[1])).toEqual(['ar-SA', 'en-US', 'ar-SA'])
    expect(runs[1][2]).toContain('English words')
  })
})
