/**
 * Page layout of the generated DOCX: wide tables, which Word would squeeze
 * until numbers break mid-digit, and the footer.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { DOCX_PALETTES } from '../docxStyle'
import { buildDocxTable } from '../docxTable'
import { INTERNAL_TOOLS } from '../internalTools'
import type { InternalToolResult } from '../types'
import { zipEntryText } from './support/zipEntries'

let outputDir: string

beforeEach(() => {
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-docx-layout-'))
})

afterEach(() => {
  fs.rmSync(outputDir, { recursive: true, force: true })
})

async function generate(args: Record<string, unknown>): Promise<InternalToolResult> {
  const tool = INTERNAL_TOOLS.find(t => t.name === 'clerum__generate_docx')!
  return tool.execute({ filename: 'd.docx', ...args }, outputDir)
}

function documentXml(r: InternalToolResult): string {
  expect(r.success, r.error).toBe(true)
  return zipEntryText(r.artifact!.path, 'word/document.xml')
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Section properties in document order, with the tables each section holds. */
function sections(xml: string): Array<{ landscape: boolean; width: number; tables: string[] }> {
  const body = xml.slice(xml.indexOf('<w:body>'))
  const out: Array<{ landscape: boolean; width: number; tables: string[] }> = []
  let at = 0
  for (const m of body.matchAll(/<w:sectPr[\s\S]*?<\/w:sectPr>/g)) {
    const chunk = body.slice(at, m.index)
    at = m.index + m[0].length
    const size = /<w:pgSz ([^>]*)\/>/.exec(m[0])?.[1] ?? ''
    out.push({
      landscape: /w:orient="landscape"/.test(size),
      width: Number(/w:w="(\d+)"/.exec(size)?.[1] ?? 0),
      tables: chunk.match(/<w:tbl>[\s\S]*?<\/w:tbl>/g) ?? [],
    })
  }
  return out
}

function grid(table: string): number[] {
  return [...table.matchAll(/<w:gridCol w:w="(\d+)"\/>/g)].map(m => Number(m[1]))
}

/** The type size of the table's body cells, in points. */
function cellSize(table: string): number {
  const sizes = [...table.matchAll(/<w:sz w:val="(\d+)"\/>/g)].map(m => Number(m[1]))
  return Math.min(...sizes) / 2
}

/** Left and right cell margins of the table's body cells, in twips. */
function cellMargins(table: string): number {
  const left = Number(/<w:left w:type="dxa" w:w="(\d+)"\/>/.exec(table)?.[1] ?? 0)
  const right = Number(/<w:right w:type="dxa" w:w="(\d+)"\/>/.exec(table)?.[1] ?? 0)
  return left + right
}

/** Calibri's advance widths, in ems, for the characters of these tests. */
const CALIBRI_EM: Record<string, number> = {
  '0': 0.507,
  '1': 0.507,
  '2': 0.507,
  '3': 0.507,
  '4': 0.507,
  '5': 0.507,
  '6': 0.507,
  '7': 0.507,
  '8': 0.507,
  '9': 0.507,
  ',': 0.25,
  '.': 0.252,
}

/** Twips a number needs on one line at `size` points in Calibri. */
function numberTwips(text: string, size: number): number {
  return [...text].reduce((sum, ch) => sum + CALIBRI_EM[ch], 0) * size * 20
}

describe('generate_docx wide tables', () => {
  const headers = ['Metric', ...MONTHS]
  const row = (label: string, value: string) => [label, ...MONTHS.map(() => value)]

  it('moves a table too wide for portrait onto a landscape page and says so', async () => {
    const r = await generate({
      body: 'Intro\n\nOutro',
      tables: [{ headers, rows: [row('Revenue (USD)', '1,234,567.00'), row('Cost', '877198.64')] }],
    })
    const all = sections(documentXml(r))
    const holding = all.find(s => s.tables.length > 0)!
    expect(holding.landscape).toBe(true)
    expect(holding.width).toBeGreaterThan(16000)
    expect(all.filter(s => !s.landscape).length).toBeGreaterThan(0)
    const table = holding.tables[0]
    const size = cellSize(table)
    const widths = grid(table)
    expect(widths).toHaveLength(13)
    for (const w of widths.slice(1)) {
      expect(w - cellMargins(table)).toBeGreaterThanOrEqual(numberTwips('1,234,567.00', size))
    }
    expect(widths.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(16838 - 2 * 1440)
    expect(r.content).toMatch(/tables\[0\].*landscape/)
  })

  it('keeps a table that fits on the portrait page, in one section and at full size', async () => {
    const r = await generate({
      body: 'x',
      tables: [{ headers: ['Region', 'Revenue'], rows: [['North', '1,234,567.00']] }],
    })
    const all = sections(documentXml(r))
    expect(all).toHaveLength(1)
    expect(all[0].landscape).toBe(false)
    expect(cellSize(all[0].tables[0])).toBe(11)
    expect(r.content).not.toMatch(/landscape/)
  })

  it('says which columns still break when even landscape is too narrow', async () => {
    const wide = Array.from({ length: 30 }, (_, i) => `C${i + 1}`)
    const r = await generate({
      body: 'x',
      tables: [{ headers: wide, rows: [wide.map(() => '1662242.74')] }],
    })
    const all = sections(documentXml(r))
    expect(all.find(s => s.tables.length > 0)!.landscape).toBe(true)
    expect(r.content).toMatch(/tables\[0\]: words in 'C1', 'C2', 'C3' and 27 more column/)
    expect(r.content).toMatch(/split the table or leave out columns/)
  })

  it('moves a wide markdown table in the body and names it', async () => {
    const line = (cells: string[]) => `| ${cells.join(' | ')} |`
    const body = [
      'Before',
      '',
      line(headers),
      line(headers.map(() => '---')),
      line(row('Revenue', '1,234,567.00')),
      '',
      'After',
    ].join('\n')
    const r = await generate({ body })
    const all = sections(documentXml(r))
    expect(all.find(s => s.tables.length > 0)!.landscape).toBe(true)
    // The text after the table returns to portrait.
    expect(all[all.length - 1].landscape).toBe(false)
    expect(r.content).toMatch(/The body's table 1 .*landscape/)
  })

  it('repeats the header and footer in every section', async () => {
    const r = await generate({
      body: 'x',
      branding: { companyName: 'Acme', footerText: 'Confidential' },
      tables: [{ headers, rows: [row('Revenue', '1,234,567.00')] }],
    })
    const xml = documentXml(r)
    const sectPrs = xml.match(/<w:sectPr[\s\S]*?<\/w:sectPr>/g) ?? []
    expect(sectPrs.length).toBeGreaterThan(1)
    for (const s of sectPrs) {
      expect(s).toMatch(/<w:headerReference w:type="default"/)
      expect(s).toMatch(/<w:footerReference w:type="default"/)
    }
  })
})

describe('generate_docx table layout on large input', () => {
  it.each([
    [
      '5,000 rows of 13 numeric cells',
      () => {
        const rows = Array.from({ length: 5000 }, (_, r) => [
          `Row ${r}`,
          ...MONTHS.map((_m, c) => (r * 1000.37 + c).toFixed(2)),
        ])
        return { headers: ['Metric', ...MONTHS], rows }
      },
    ],
    [
      'one 1 MB cell without spaces',
      () => ({ headers: ['A', 'B'], rows: [['x'.repeat(1_000_000), 'y']] }),
    ],
    [
      'one 1 MB cell of short words',
      () => ({ headers: ['A', 'B'], rows: [['ab '.repeat(350_000), 'y']] }),
    ],
  ])(
    'sizes %s in bounded time',
    (_name, make) => {
      const { headers, rows } = make()
      const started = Date.now()
      buildDocxTable(headers, rows, DOCX_PALETTES.default, 'striped', [], 'tables[0]')
      // Loose, so a slow machine passes; sizing that went quadratic would take minutes.
      expect(Date.now() - started).toBeLessThan(20_000)
    },
    60_000
  )
})

describe('generate_docx footer', () => {
  function footerTexts(file: string): string[] {
    const xml = zipEntryText(file, 'word/footer1.xml')
    return [...xml.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map(m => m[1])
  }

  it('breaks a footer written on several lines where it was broken', async () => {
    const r = await generate({ body: 'x', branding: { footerText: 'Line 1\nLine 2\nLine 3' } })
    expect(r.success, r.error).toBe(true)
    const xml = zipEntryText(r.artifact!.path, 'word/footer1.xml')
    expect(xml).not.toMatch(/<w:t[^>]*>[^<]*\n/)
    expect(footerTexts(r.artifact!.path)).toEqual(
      expect.arrayContaining(['Line 1', 'Line 2', 'Line 3'])
    )
    expect(xml.match(/<w:br\/>/g)).toHaveLength(2)
    expect(r.content).not.toMatch(/footerText/)
  })

  it('keeps six lines, as the PDF does, and says the rest was cut', async () => {
    const text = Array.from({ length: 8 }, (_, i) => `L${i + 1}`).join('\n')
    const r = await generate({ body: 'x', branding: { footerText: text } })
    expect(r.success, r.error).toBe(true)
    const kept = footerTexts(r.artifact!.path)
    expect(kept).toContain('L6...')
    expect(kept).not.toContain('L7')
    expect(r.content).toMatch(/branding\.footerText takes 8 lines.*only 6/)
  })
})
