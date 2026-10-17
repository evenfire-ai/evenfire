/**
 * The workflow router validates arguments against the tool schema before
 * execute() runs; the other suites call execute() directly and never reach that
 * gate. These cases are arguments the runtimes handle, so the schemas must let
 * them through the router.
 */
import { describe, expect, it } from 'vitest'
import { INTERNAL_TOOLS } from '../internalTools'
import { unknownArguments } from '../schemaArguments'
import { workflowValidation } from './support/workflowRouter'

function schemaOf(name: string): Record<string, unknown> {
  const tool = INTERNAL_TOOLS.find(t => t.name === name)
  if (!tool) throw new Error(`tool ${name} not registered`)
  return tool.parameters
}

function accepts(name: string, args: Record<string, unknown>): Promise<string | true> {
  const tool = INTERNAL_TOOLS.find(t => t.name === name)
  if (!tool) throw new Error(`tool ${name} not registered`)
  return workflowValidation(tool, args)
}

const ACCEPTED: Array<[string, string, Record<string, unknown>]> = [
  [
    'a spreadsheet of numbers',
    'clerum__generate_xlsx',
    {
      filename: 'ventas.xlsx',
      sheets: [
        {
          name: 'Ventas',
          rows: [
            ['Mes', 'Monto', 'Pagado'],
            ['Ene', 1200, true],
            ['Feb', 1850.5, null],
          ],
        },
      ],
    },
  ],
  [
    'conditional formatting on a numbered column matching a number',
    'clerum__generate_xlsx',
    {
      filename: 'v.xlsx',
      sheets: [
        {
          name: 'S',
          rows: [['a'], [1]],
          conditionalFormatting: [{ column: 1, rules: [{ equals: 0, fillColor: '#fee2e2' }] }],
        },
      ],
    },
  ],
  [
    'numbers, percents and dates written as text',
    'clerum__generate_xlsx',
    {
      filename: 'v.xlsx',
      sheets: [
        {
          name: 'Ventas',
          headers: ['Fecha', 'Monto', 'Margen'],
          rows: [['2026-09-22', '$1,200.50', '45%']],
          columnFormats: { Monto: 'currency:EUR', C: 'percent', '0': 'date' },
        },
      ],
    },
  ],
  [
    'conditional formatting by column letter with every rule kind',
    'clerum__generate_xlsx',
    {
      filename: 'v.xlsx',
      sheets: [
        {
          name: 'S',
          rows: [
            ['Status', 'Amount'],
            ['Late', 1500],
          ],
          conditionalFormatting: [
            {
              column: 'B',
              rules: [
                { greaterThan: 1000, fillColor: '#f00' },
                { between: [0, 10], fontColor: 'red', bold: true },
                { equals: true },
                { contains: 'late', regex: '^L' },
              ],
            },
          ],
        },
      ],
    },
  ],
  [
    'a sheet that only holds images, named or placed',
    'clerum__generate_xlsx',
    {
      filename: 'v.xlsx',
      branding: { companyName: 'Example', logoPath: 'logo.png' },
      sheets: [
        {
          name: 'Charts',
          rows: [],
          images: ['sales.png', { path: 'costs.png', anchor: 'H2', width: 480 }],
        },
      ],
    },
  ],
  [
    'a PDF table of numbers',
    'clerum__generate_pdf',
    {
      filename: 'r.pdf',
      body: 'x',
      tables: [{ headers: ['Mes', 'Monto'], rows: [['Ene', 1200]] }],
    },
  ],
  [
    'PDF column widths in points',
    'clerum__generate_pdf',
    {
      filename: 'r.pdf',
      body: 'x',
      tables: [{ headers: ['A', 'B'], rows: [['1', '2']], widths: [120, '*'] }],
    },
  ],
  [
    'a PDF table with a numeric header, null and boolean cells',
    'clerum__generate_pdf',
    {
      filename: 'r.pdf',
      body: 'x',
      tables: [
        {
          headers: ['Region', 2026],
          rows: [
            ['North', null],
            ['South', true],
          ],
        },
      ],
    },
  ],
  [
    'PDF column widths as percentages and auto',
    'clerum__generate_pdf',
    {
      filename: 'r.pdf',
      body: 'x',
      tables: [{ headers: ['A', 'B', 'C'], rows: [['1', '2', '3']], widths: ['30%', 'auto', '*'] }],
    },
  ],
  [
    'PDF images as file names, as clerum__generate_chart returns them',
    'clerum__generate_pdf',
    {
      filename: 'r.pdf',
      body: 'x',
      images: ['sales.png', { path: 'costs.png', width: 300, alignment: 'left' }],
    },
  ],
  [
    'a DOCX table of numbers',
    'clerum__generate_docx',
    {
      filename: 'r.docx',
      body: 'x',
      tables: [{ headers: ['Mes', 'Monto'], rows: [['Ene', 1200]] }],
    },
  ],
  [
    'DOCX images as bare file names or objects',
    'clerum__generate_docx',
    {
      filename: 'r.docx',
      body: 'x',
      images: ['ventas.png', { path: 'margen.png', width: 300, alignment: 'center' }],
      branding: { logoPath: 'logo.png' },
    },
  ],
  [
    'DOCX years as table headers',
    'clerum__generate_docx',
    {
      filename: 'r.docx',
      body: 'x',
      tables: [{ headers: ['Region', 2024, 2025], rows: [['Norte', 1200, null]] }],
    },
  ],
  [
    'a bar chart of numbers with gaps',
    'clerum__generate_chart',
    {
      filename: 'c.png',
      type: 'line',
      data: { labels: ['a', 'b'], datasets: [{ data: [1, null] }] },
    },
  ],
  [
    'a scatter of {x, y} points',
    'clerum__generate_chart',
    { filename: 'c.png', type: 'scatter', data: { datasets: [{ data: [{ x: 1, y: 2 }] }] } },
  ],
  [
    'a bubble of {x, y, r} points',
    'clerum__generate_chart',
    { filename: 'c.png', type: 'bubble', data: { datasets: [{ data: [{ x: 1, y: 2, r: 5 }] }] } },
  ],
  [
    'values written as text, which the normalizer reads',
    'clerum__generate_chart',
    { filename: 'c.png', type: 'bar', data: { labels: ['a'], datasets: [{ data: ['1,200'] }] } },
  ],
  [
    '{label, value} records, which the normalizer reads',
    'clerum__generate_chart',
    {
      filename: 'c.png',
      type: 'bar',
      data: { datasets: [{ data: [{ label: 'Ene', value: 3 }] }] },
    },
  ],
  [
    'one color per point',
    'clerum__generate_chart',
    {
      filename: 'c.png',
      type: 'bar',
      data: {
        labels: ['a', 'b'],
        datasets: [{ data: [1, 2], backgroundColor: ['#111111', '#222222'] }],
      },
    },
  ],
  [
    'years sent as numeric labels',
    'clerum__generate_chart',
    {
      filename: 'c.png',
      type: 'line',
      data: { labels: [2023, 2024, '2025e'], datasets: [{ label: 'ARR', data: [1, 2, 3] }] },
    },
  ],
  [
    'a numeric dashboard KPI',
    'clerum__generate_dashboard',
    { filename: 'd.html', data: { title: 'T', kpis: [{ label: 'NPS', value: 48 }] } },
  ],
  [
    'a dashboard section written as one paragraph',
    'clerum__generate_dashboard',
    {
      filename: 'd.html',
      data: { title: 'T', sections: [{ type: 'narrative', content: 'Hola' }] },
    },
  ],
  [
    'a dashboard table of numbers',
    'clerum__generate_dashboard',
    { filename: 'd.html', data: { title: 'T', tables: [{ headers: ['a'], rows: [[1]] }] } },
  ],
  [
    'a custom kpis block carrying KPI objects',
    'clerum__generate_dashboard',
    {
      filename: 'd.html',
      template: 'custom',
      data: { title: 'T', blocks: [{ type: 'kpis', items: [{ label: 'ARR', value: 1200000 }] }] },
    },
  ],
  [
    'an operations-pulse dashboard with services and incidents',
    'clerum__generate_dashboard',
    {
      filename: 'd.html',
      template: 'operations-pulse',
      data: {
        title: 'T',
        services: [{ name: 'API', status: 'healthy', metric: '99.9%' }],
        incidents: [{ time: '10:42', title: 'Latency', severity: 'high' }],
      },
    },
  ],
  [
    'a dashboard gauge and a stacked bar with year labels',
    'clerum__generate_dashboard',
    {
      filename: 'd.html',
      data: {
        title: 'T',
        charts: [
          { type: 'gauge', gaugeMax: 10, datasets: [{ data: [7] }] },
          { type: 'stackedBar', labels: [2025, 2026], datasets: [{ data: [1, 2] }] },
        ],
      },
    },
  ],
  [
    'a dashboard table with a badge column',
    'clerum__generate_dashboard',
    {
      filename: 'd.html',
      data: {
        title: 'T',
        tables: [
          {
            headers: ['Svc', 'Status'],
            rows: [['api', 'low']],
            columnTypes: { Status: 'severity' },
          },
        ],
      },
    },
  ],
  [
    'markdown sent as an array of lines',
    'clerum__generate_markdown',
    { filename: 'n.md', content: ['# Title', 'body'] },
  ],
  [
    'PDF table rows sent as records',
    'clerum__generate_pdf',
    {
      filename: 'r.pdf',
      body: 'x',
      tables: [{ headers: ['Name', 'Qty'], rows: [{ Name: 'Widget', Qty: 3 }] }],
    },
  ],
  [
    'DOCX table rows sent as records',
    'clerum__generate_docx',
    {
      filename: 'r.docx',
      body: 'x',
      tables: [{ headers: ['Name', 'Qty'], rows: [{ Name: 'Widget', Qty: 3 }] }],
    },
  ],
  [
    'XLSX rows sent as records',
    'clerum__generate_xlsx',
    { filename: 'r.xlsx', sheets: [{ name: 'S', rows: [{ Name: 'Widget', Qty: 3 }] }] },
  ],
  [
    'PPTX table rows sent as records',
    'clerum__generate_pptx',
    {
      filename: 'r.pptx',
      slides: [
        {
          layout: 'title-table',
          title: 'T',
          table: { headers: ['Name', 'Qty'], rows: [{ Name: 'Widget', Qty: 3 }] },
        },
      ],
    },
  ],
  [
    'dashboard table rows sent as records, and [x, y] points',
    'clerum__generate_dashboard',
    {
      filename: 'd.html',
      data: {
        title: 'T',
        tables: [{ headers: ['Name', 'Qty'], rows: [{ Name: 'Widget', Qty: 3 }] }],
        charts: [
          {
            type: 'scatter',
            datasets: [
              {
                data: [
                  [1, 2],
                  [3, 4],
                ],
              },
            ],
          },
        ],
      },
    },
  ],
  [
    'chart values as {label, value} with text, and {x, y} with a category x',
    'clerum__generate_chart',
    {
      filename: 'c.png',
      type: 'bar',
      data: {
        datasets: [{ data: [{ label: 'Q1', value: '1,200' }] }, { data: [{ x: 'Jan', y: 5 }] }],
      },
    },
  ],
  [
    'null for every optional argument of a PDF',
    'clerum__generate_pdf',
    { filename: 'n.pdf', body: 'x', title: null, images: null, tables: null, palette: null },
  ],
  [
    'null for an optional chart size',
    'clerum__generate_chart',
    {
      filename: 'n.png',
      type: 'bar',
      width: null,
      height: null,
      data: { labels: ['a'], datasets: [{ data: [1] }] },
    },
  ],
  [
    'a numeric PPTX KPI',
    'clerum__generate_pptx',
    {
      filename: 'd.pptx',
      slides: [{ layout: 'kpis', title: 'K', kpis: [{ label: 'NPS', value: 48 }] }],
    },
  ],
]

describe('internal tool schemas accept what the runtimes handle, on the workflow path', () => {
  it.each(ACCEPTED)('declares every argument of %s', (_label, tool, args) => {
    expect(unknownArguments(schemaOf(tool), args)).toEqual([])
  })

  it.each(ACCEPTED)('accepts %s', async (_label, tool, args) => {
    expect(await accepts(tool, args)).toBe(true)
  })

  it('still rejects what no runtime can handle', async () => {
    // Widening for real inputs must not turn the gate into a no-op.
    expect(
      await accepts('clerum__generate_chart', {
        filename: 'c.png',
        type: 'nonsense',
        data: { datasets: [] },
      })
    ).not.toBe(true)
    expect(
      await accepts('clerum__generate_chart', {
        filename: 'c.png',
        type: 'bar',
        data: { labels: [{ text: 'Q1' }], datasets: [{ data: [1] }] },
      })
    ).not.toBe(true)
    expect(
      await accepts('clerum__generate_xlsx', {
        filename: 'v.xlsx',
        sheets: [{ name: 'S', rows: [[{ nested: true }]] }],
      })
    ).not.toBe(true)
    expect(
      await accepts('clerum__generate_xlsx', {
        filename: 'v.xlsx',
        sheets: [{ name: 'S', rows: [['H'], [{ formula: 'NOW()' }]] }],
      })
    ).not.toBe(true)
    expect(
      await accepts('clerum__generate_xlsx', {
        filename: 'v.xlsx',
        sheets: [{ name: 'S', rows: [['H'], [1]], images: [42] }],
      })
    ).not.toBe(true)
    expect(await accepts('clerum__generate_pdf', { body: 'x' })).not.toBe(true)
    expect(
      await accepts('clerum__generate_pdf', {
        filename: 'r.pdf',
        body: 'x',
        tables: [{ headers: ['Name'], rows: [{ Name: { nested: true } }] }],
      })
    ).not.toBe(true)
    expect(
      await accepts('clerum__generate_dashboard', {
        filename: 'd.html',
        data: { title: 'T', charts: [{ type: 'sunburst', datasets: [{ data: [1] }] }] },
      })
    ).not.toBe(true)
    expect(
      await accepts('clerum__generate_dashboard', {
        filename: 'd.html',
        template: 'custom',
        data: { title: 'T', blocks: [{ type: 'spacer', size: 'xl' }] },
      })
    ).not.toBe(true)
    expect(
      await accepts('clerum__generate_markdown', { filename: 'n.md', content: { text: 'x' } })
    ).not.toBe(true)
    expect(
      await accepts('clerum__generate_pdf', {
        filename: 'r.pdf',
        body: 'x',
        images: [{ width: 100 }],
      })
    ).not.toBe(true)
  })
})
