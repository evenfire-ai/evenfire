/**
 * The shape of the XLSX workbook: which sheets exist and under what names,
 * where rows and images land, and how wide the columns are.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCanvas } from '@napi-rs/canvas'
import ExcelJS from 'exceljs'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { INTERNAL_TOOLS } from '../internalTools'
import type { InternalToolResult } from '../types'
import { tableWidth } from '../xlsxSheet'
import { zipEntries } from './support/zipEntries'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-xlsx-layout-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const xlsx = INTERNAL_TOOLS.find(t => t.name === 'clerum__generate_xlsx')!

function generate(args: Record<string, unknown>): Promise<InternalToolResult> {
  return xlsx.execute(args, dir)
}

async function bookOf(result: InternalToolResult): Promise<ExcelJS.Workbook> {
  expect(result.success, result.error).toBe(true)
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(result.artifact!.path)
  return wb
}

function png(name: string, width = 400, height = 200): string {
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#1e3a8a'
  ctx.fillRect(0, 0, width, height)
  fs.writeFileSync(path.join(dir, name), canvas.toBuffer('image/png'))
  return name
}

describe('rows', () => {
  it('reads rows sent as records, taking the header from their keys', async () => {
    const result = await generate({
      filename: 'o.xlsx',
      sheets: [
        {
          name: 'R',
          rows: [
            { Month: 'Jan', Revenue: 100 },
            { Month: 'Feb', Revenue: 200, Note: 'late' },
          ],
        },
      ],
    })
    const ws = (await bookOf(result)).worksheets[0]
    expect(ws.getRow(1).values).toEqual([undefined, 'Month', 'Revenue', 'Note'])
    expect(ws.getCell('B3').value).toBe(200)
    expect(ws.getCell('C3').value).toBe('late')
    expect(result.content).toMatch(/objects/)
  })

  it('takes the header from headers when it is given apart from the rows', async () => {
    const result = await generate({
      filename: 'h.xlsx',
      sheets: [{ name: 'S', headers: ['Month', 'Units'], rows: [['Jan', 3]] }],
    })
    const ws = (await bookOf(result)).worksheets[0]
    expect(ws.getCell('A1').value).toBe('Month')
    expect(ws.getCell('B2').value).toBe(3)
  })

  it('fails instead of writing an empty workbook when no row is usable', async () => {
    const result = await generate({
      filename: 'e.xlsx',
      sheets: [{ name: 'S', rows: 'Month,Revenue\nJan,100' }],
    })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/sheets\[0\]/)
    expect(result.error).toMatch(/array/)
    expect(fs.existsSync(path.join(dir, 'e.xlsx'))).toBe(false)
  })

  it('styles only the rows it wrote when a row is dropped', async () => {
    const result = await generate({
      filename: 'n.xlsx',
      sheets: [{ name: 'S', rows: [['A'], [1], null, [2]] }],
    })
    const ws = (await bookOf(result)).worksheets[0]
    expect(ws.rowCount).toBe(3)
    expect(result.content).toMatch(/left out/)
  })

  it('measures wide sheets without spreading every row into a call', () => {
    const rows = Array.from({ length: 200_000 }, (_, i) => (i === 7 ? [1, 2, 3] : [i]))
    expect(tableWidth(rows)).toBe(3)
  })
})

describe('sheet names', () => {
  it('repairs names Excel refuses and keeps them unique', async () => {
    const long = 'Resumen de ventas por region - '
    const names = [
      'Q3/Q4',
      'Sales:2026',
      '[Draft]',
      '',
      'History',
      "'Quoted'",
      'Data',
      'data',
      `${long}Enero`,
      `${long}Febrero`,
    ]
    const result = await generate({
      filename: 's.xlsx',
      sheets: names.map(name => ({ name, rows: [['A'], [1]] })),
    })
    const wb = await bookOf(result)
    const written = wb.worksheets.map(ws => ws.name)
    expect(written).toHaveLength(names.length)
    expect(new Set(written.map(n => n.toLowerCase())).size).toBe(names.length)
    for (const name of written) {
      expect(name.length).toBeLessThanOrEqual(31)
      expect(name).not.toMatch(/[\\/?*:[\]]/)
      expect(name).not.toMatch(/^'|'$/)
      expect(name).not.toBe('History')
    }
    expect(written[0]).toBe('Q3-Q4')
    expect(result.content).toContain("'Q3/Q4'")
  })

  it('does not cut an emoji in half when shortening a name', async () => {
    const result = await generate({
      filename: 'e.xlsx',
      sheets: [{ name: `${'x'.repeat(30)}📈 extra`, rows: [['A'], [1]] }],
    })
    const [ws] = (await bookOf(result)).worksheets
    expect(ws.name).toBe('x'.repeat(30))
  })
})

describe('images', () => {
  it('embeds images on a sheet that has no rows', async () => {
    png('chart.png')
    const result = await generate({
      filename: 'g.xlsx',
      sheets: [
        { name: 'Data', rows: [['A'], [1]] },
        { name: 'Charts', rows: [], images: [{ path: 'chart.png', anchor: 'B2' }] },
      ],
    })
    const wb = await bookOf(result)
    expect(wb.getWorksheet('Charts')!.getImages()).toHaveLength(1)
  })

  it('stacks images without an anchor instead of piling them up', async () => {
    png('a.png')
    png('b.png')
    const result = await generate({
      filename: 't.xlsx',
      sheets: [{ name: 'D', rows: [['A'], [1]], images: [{ path: 'a.png' }, 'b.png'] }],
    })
    const images = (await bookOf(result)).worksheets[0].getImages()
    expect(images).toHaveLength(2)
    const [first, second] = images.map(i => i.range.tl.nativeRow)
    expect(second).toBeGreaterThan(first + 200 / 20)
  })

  it('reports images it could not embed', async () => {
    fs.writeFileSync(
      path.join(dir, 'x.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="red"/></svg>'
    )
    const result = await generate({
      filename: 'm.xlsx',
      sheets: [
        { name: 'D', rows: [['A'], [1]], images: [{ path: 'nope.png' }, { path: 'x.svg' }] },
      ],
    })
    const images = (await bookOf(result)).worksheets[0].getImages()
    expect(images).toHaveLength(1)
    expect(result.content).toContain('nope.png')
  })

  it('uses the file of that name when given a path from another mode', async () => {
    png('sales.png')
    const result = await generate({
      filename: 'p.xlsx',
      sheets: [{ name: 'D', rows: [['A'], [1]], images: [{ path: '/output/sales.png' }] }],
    })
    expect((await bookOf(result)).worksheets[0].getImages()).toHaveLength(1)
    expect(result.content).toContain('/output/sales.png')
  })

  it('places the branding logo beside the data on the first sheet', async () => {
    png('logo.png', 300, 100)
    const result = await generate({
      filename: 'l.xlsx',
      branding: { companyName: 'Example Co', logoPath: 'logo.png' },
      sheets: [
        {
          name: 'D',
          rows: [
            ['A', 'B'],
            [1, 2],
          ],
        },
      ],
    })
    const [image] = (await bookOf(result)).worksheets[0].getImages()
    expect(image).toBeDefined()
    expect(image.range.tl.nativeCol).toBeGreaterThanOrEqual(2)
  })

  it('puts the logo below a title when the first sheet has no columns', async () => {
    png('logo.png', 300, 100)
    png('chart.png')
    const result = await generate({
      filename: 'l3.xlsx',
      branding: { logoPath: 'logo.png' },
      sheets: [
        { name: 'D', titleRow: { text: 'Quarterly report' }, rows: [], images: ['chart.png'] },
      ],
    })
    const [logo, chart] = (await bookOf(result)).worksheets[0].getImages()
    expect(logo.range.tl.nativeRow).toBeGreaterThanOrEqual(1)
    expect(chart.range.tl.nativeRow).toBeGreaterThan(logo.range.tl.nativeRow + 60 / 20)
  })

  it('says so when the logo is missing', async () => {
    const result = await generate({
      filename: 'l2.xlsx',
      branding: { logoPath: 'missing-logo.png' },
      sheets: [{ name: 'D', rows: [['A'], [1]] }],
    })
    expect(result.success).toBe(true)
    expect(result.content).toContain('missing-logo.png')
  })
})

describe('column widths', () => {
  it('ignores the merged title row', async () => {
    const rows = [
      ['Month', 'Units'],
      ['Jan', 1],
    ]
    const plain = await bookOf(
      await generate({ filename: 'a.xlsx', sheets: [{ name: 'S', rows }] })
    )
    const titled = await bookOf(
      await generate({
        filename: 'b.xlsx',
        sheets: [
          { name: 'S', titleRow: { text: 'Resumen trimestral de ventas por region 2026' }, rows },
        ],
      })
    )
    const widths = (wb: ExcelJS.Workbook) => wb.worksheets[0].columns.map(c => c.width)
    expect(widths(titled)).toEqual(widths(plain))
  })

  it('wraps a title wider than the table instead of cutting it off', async () => {
    const wb = await bookOf(
      await generate({
        filename: 'b.xlsx',
        sheets: [
          {
            name: 'S',
            titleRow: { text: 'Resumen trimestral de ventas por region 2026' },
            rows: [
              ['Month', 'Units'],
              ['Jan', 1],
            ],
          },
        ],
      })
    )
    const title = wb.worksheets[0].getRow(1)
    expect(title.getCell(1).alignment?.wrapText).toBe(true)
    expect(title.height).toBeGreaterThan(28)
  })

  it('leaves a title that fits on one line', async () => {
    const wb = await bookOf(
      await generate({
        filename: 'c.xlsx',
        sheets: [{ name: 'S', titleRow: { text: 'Sales' }, rows: [['Month'], ['Jan']] }],
      })
    )
    const title = wb.worksheets[0].getRow(1)
    expect(title.getCell(1).alignment?.wrapText).toBeFalsy()
    expect(title.height).toBe(28)
  })

  it('widens the only column for a sheet that holds just a title', async () => {
    const text = 'Quarterly report for the whole company'
    const wb = await bookOf(
      await generate({
        filename: 'd.xlsx',
        sheets: [{ name: 'S', titleRow: { text }, rows: [] }],
      })
    )
    expect(wb.worksheets[0].getColumn(1).width).toBeGreaterThanOrEqual(text.length)
  })

  it('counts wide CJK characters twice', async () => {
    const text = '北京市朝阳区建国门外大街一号国贸大厦三十层销售部门'
    const wb = await bookOf(
      await generate({ filename: 'u.xlsx', sheets: [{ name: 'U', rows: [['产品'], [text]] }] })
    )
    expect(wb.worksheets[0].columns[0].width).toBeGreaterThanOrEqual(text.length * 2)
  })

  it('measures numbers as they are displayed', async () => {
    const wb = await bookOf(
      await generate({
        filename: 'w.xlsx',
        sheets: [{ name: 'S', rows: [['Revenue'], [12345678.5]] }],
      })
    )
    // "$12,345,678.50 " is 15 characters wide; the raw value is 10.
    expect(wb.worksheets[0].columns[0].width).toBeGreaterThanOrEqual(15)
  })
})

describe('file names', () => {
  it('keeps two reports whose names differ only in non-Latin characters', async () => {
    const sheets = [{ name: 'S', rows: [['A'], [1]] }]
    const a = await generate({ filename: '销售报告.xlsx', sheets })
    const b = await generate({ filename: '库存报告.xlsx', sheets })
    expect(a.artifact!.name).not.toBe(b.artifact!.name)
    expect(fs.existsSync(a.artifact!.path)).toBe(true)
    expect(fs.existsSync(b.artifact!.path)).toBe(true)
  })

  it('names an unnamed workbook instead of writing a hidden file', async () => {
    const result = await generate({ filename: '', sheets: [{ name: 'S', rows: [['A'], [1]] }] })
    expect(result.artifact!.name).toBe('output.xlsx')
  })
})

describe('images sent at the top level', () => {
  it('are placed on the first sheet, with a note', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-xlsx-top-'))
    try {
      const chart = INTERNAL_TOOLS.find(t => t.name === 'clerum__generate_chart')!
      await chart.execute(
        { filename: 'c.png', type: 'bar', data: { labels: ['a'], datasets: [{ data: [1] }] } },
        dir
      )
      const result = await INTERNAL_TOOLS.find(t => t.name === 'clerum__generate_xlsx')!.execute(
        {
          filename: 't.xlsx',
          sheets: [{ name: 'S', rows: [['a'], [1]] }],
          images: [{ path: 'c.png' }],
        },
        dir
      )
      expect(result.success).toBe(true)
      expect(result.content).toContain('the top-level images were placed on the first sheet')
      const entries = [...zipEntries(result.artifact!.path).keys()]
      expect(entries.some(name => name.startsWith('xl/media/'))).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
