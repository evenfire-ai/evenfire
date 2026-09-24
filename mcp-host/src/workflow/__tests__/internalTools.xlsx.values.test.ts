/**
 * What lands in each XLSX cell: its type, its number format and the rules that
 * style it. Each file is read back with ExcelJS, because a success flag says
 * nothing about whether "1,234.50" became a number Excel can sum.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { INTERNAL_TOOLS } from '../internalTools'
import { StepMcpRouter } from '../stepRouter'
import type { InternalToolResult } from '../types'
import { zipEntryText } from './support/zipEntries'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-xlsx-values-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const xlsx = INTERNAL_TOOLS.find(t => t.name === 'clerum__generate_xlsx')!

async function generate(args: Record<string, unknown>): Promise<InternalToolResult> {
  return xlsx.execute(args, dir)
}

async function sheetOf(result: InternalToolResult, index = 0): Promise<ExcelJS.Worksheet> {
  expect(result.success, result.error).toBe(true)
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(result.artifact!.path)
  return wb.worksheets[index]
}

async function oneSheet(rows: unknown[][], extra: Record<string, unknown> = {}) {
  const result = await generate({ filename: 'v.xlsx', sheets: [{ name: 'S', rows, ...extra }] })
  return { result, ws: await sheetOf(result) }
}

function fillOf(cell: ExcelJS.Cell): string | undefined {
  const fill = cell.fill as ExcelJS.FillPattern | undefined
  return fill?.fgColor?.argb
}

describe('numbers reach the sheet as numbers', () => {
  it('accepts numeric, boolean and null cells on the workflow path', async () => {
    const router = new StepMcpRouter(() => {
      throw new Error('no MCP servers in this test')
    })
    router.registerInternalTools(INTERNAL_TOOLS, dir)
    const { result } = await router.callTool('clerum__generate_xlsx', {
      filename: 'wf.xlsx',
      sheets: [
        {
          name: 'S',
          rows: [
            ['Month', 'Revenue', 'Units', 'Paid'],
            ['Jan', 12500.5, 320, true],
            ['Feb', 13900, null, false],
          ],
          conditionalFormatting: [{ column: 1, rules: [{ equals: 13900, fillColor: '#fee2e2' }] }],
        },
      ],
    })
    expect(result.isError).toBe(false)
    const ws = await sheetOf(result.content as InternalToolResult)
    expect(ws.getCell('B2').value).toBe(12500.5)
    expect(ws.getCell('C2').value).toBe(320)
    expect(ws.getCell('D2').value).toBe(true)
    expect(fillOf(ws.getCell('B3'))).toBe('FFFEE2E2')
  })

  it('converts numbers, currency and percents written as text', async () => {
    const { ws } = await oneSheet([
      ['Item', 'Amount', 'Pct', 'Price', 'Delta'],
      ['A', '1,234.50', '45%', '$1,200', '-300'],
      ['B', '980', '12.5%', '€2,500.75', '-12.5'],
    ])
    expect(ws.getCell('B2').value).toBe(1234.5)
    expect(ws.getCell('B3').value).toBe(980)
    expect(ws.getCell('C2').value).toBeCloseTo(0.45, 12)
    expect(ws.getCell('C2').numFmt).toMatch(/%/)
    expect(ws.getCell('C3').value).toBeCloseTo(0.125, 12)
    expect(ws.getCell('D2').value).toBe(1200)
    expect(ws.getCell('D2').numFmt).toContain('"$"')
    expect(ws.getCell('D3').value).toBe(2500.75)
    expect(ws.getCell('D3').numFmt).toContain('"€"')
    expect(ws.getCell('E2').value).toBe(-300)
    expect(ws.getCell('E3').value).toBe(-12.5)
  })

  it('keeps identifiers and ambiguous text as text', async () => {
    const { result, ws } = await oneSheet([
      ['Code', 'Card', 'Phone', 'Weight', 'Monto'],
      ['00123', '4111111111111111', '+1 555 0100', '12 kg', '1.200'],
    ])
    expect(ws.getCell('A2').value).toBe('00123')
    expect(ws.getCell('B2').value).toBe('4111111111111111')
    expect(ws.getCell('C2').value).toBe('+1 555 0100')
    expect(ws.getCell('D2').value).toBe('12 kg')
    // "1.200" is 1.2 in English and 1200 in Spanish: text, and the agent is told.
    expect(ws.getCell('E2').value).toBe('1.200')
    expect(result.content).toContain("'1.200'")
  })

  it('does not reinterpret text in a column declared as text', async () => {
    const { ws } = await oneSheet([['Ref'], ['1,234'], ['45%']], { columnFormats: { Ref: 'text' } })
    expect(ws.getCell('A2').value).toBe('1,234')
    expect(ws.getCell('A3').value).toBe('45%')
  })

  it('turns strict ISO 8601 dates into dates', async () => {
    const { result, ws } = await oneSheet([
      ['Fecha', 'Stamp', 'Bad'],
      ['2026-09-22', '2026-09-23T10:00:00Z', '2026-02-30'],
      ['2026-09-24', '2026-09-23T10:00:00-06:00', '22/09/2026'],
    ])
    const a2 = ws.getCell('A2')
    expect(a2.value).toBeInstanceOf(Date)
    expect((a2.value as Date).toISOString()).toBe('2026-09-22T00:00:00.000Z')
    expect(a2.numFmt).toBe('yyyy-mm-dd')
    const b2 = ws.getCell('B2')
    expect((b2.value as Date).toISOString()).toBe('2026-09-23T10:00:00.000Z')
    expect(b2.numFmt).toBe('yyyy-mm-dd hh:mm')
    expect((ws.getCell('B3').value as Date).toISOString()).toBe('2026-09-23T16:00:00.000Z')
    expect(result.content).toMatch(/UTC/)
    expect(ws.getCell('C2').value).toBe('2026-02-30')
    expect(ws.getCell('C3').value).toBe('22/09/2026')
  })

  it('keeps dates Excel would show a day late as text', async () => {
    const { result, ws } = await oneSheet([
      ['Fecha'],
      ['1900-01-15'],
      ['1900-02-28'],
      ['1900-03-01'],
    ])
    expect(ws.getCell('A2').value).toBe('1900-01-15')
    expect(ws.getCell('A3').value).toBe('1900-02-28')
    expect((ws.getCell('A4').value as Date).toISOString()).toBe('1900-03-01T00:00:00.000Z')
    // Serial 61 is 1900-03-01 in Excel, which counts a 29 February 1900.
    expect(zipEntryText(result.artifact!.path, 'xl/worksheets/sheet1.xml')).toMatch(
      /<c r="A4"[^>]*><v>61<\/v>/
    )
  })

  it('names cells that could not take the format their column asked for', async () => {
    const long = 'x'.repeat(100)
    const { result, ws } = await oneSheet(
      [
        ['Fecha', 'Monto', 'Units'],
        ['22/09/2026', '1.234,50', long],
        ['2026-09-22', 1234.5, 3],
      ],
      { columnFormats: { Fecha: 'date', Monto: 'currency:EUR', Units: 'integer' } }
    )
    expect(ws.getCell('A2').value).toBe('22/09/2026')
    expect(ws.getCell('B3').numFmt).toContain('€')
    expect(result.content).toMatch(/'Fecha'.*'22\/09\/2026'.*ISO 8601/)
    expect(result.content).toMatch(/'Monto'.*'1\.234,50'.*JSON number/)
    expect(result.content).toContain(`'${'x'.repeat(40)}…'`)
    expect(result.content).not.toContain(long)
  })

  it('keeps an identifier column all numbers or all text, never a mix', async () => {
    const { ws } = await oneSheet([
      ['Order ID', 'Zip'],
      [100234, '02134'],
      ['100235', '90210'],
    ])
    expect(ws.getCell('A3').value).toBe(100235)
    expect(ws.getCell('A3').numFmt).toBe('0')
    expect(ws.getCell('B2').value).toBe('02134')
    expect(ws.getCell('B3').value).toBe('90210')
  })
})

describe('characters outside the BMP', () => {
  it('writes every emoji whole, wherever it falls in the shared strings', async () => {
    // 9,000 emoji are 18,000 UTF-16 units, so one straddles the 16,384 mark.
    const text = '\u{1F600}'.repeat(9000)
    const result = await generate({
      filename: 'e.xlsx',
      sheets: [{ name: 'E', rows: [['Emoji'], [text]] }],
    })
    expect(result.success, result.error).toBe(true)
    const shared = zipEntryText(result.artifact!.path, 'xl/sharedStrings.xml')
    expect(shared).not.toContain('\uFFFD')
    expect(shared).toContain(text)
  })
})

describe('column formats', () => {
  it('reads 0-100 values in a percent column as percentage points', async () => {
    const { ws } = await oneSheet([
      ['Conversion rate %', 'Share'],
      [12.5, 0.12],
      [45, 0.45],
    ])
    expect(ws.getCell('A2').value).toBeCloseTo(0.125, 12)
    expect(ws.getCell('A3').value).toBeCloseTo(0.45, 12)
    expect(ws.getCell('A2').numFmt).toMatch(/%$/)
    expect(ws.getCell('B2').value).toBe(0.12)
    expect(ws.getCell('B2').numFmt).toMatch(/%$/)
  })

  it('matches header words, not fragments of them', async () => {
    const { ws } = await oneSheet([
      ['Candidates', 'Strategy score', 'Carrier', 'Feedback score', 'Shareholders'],
      [12, 85, 3, 4.5, 20],
    ])
    expect(ws.getCell('A2').value).toBe(12)
    expect(ws.getCell('A2').numFmt).not.toMatch(/y/)
    expect(ws.getCell('B2').numFmt ?? '').not.toMatch(/%/)
    expect(ws.getCell('C2').numFmt ?? '').not.toMatch(/\$/)
    expect(ws.getCell('D2').numFmt ?? '').not.toMatch(/\$/)
    expect(ws.getCell('E2').numFmt ?? '').not.toMatch(/%/)
  })

  it('understands Spanish and Portuguese headers', async () => {
    const { ws } = await oneSheet([
      ['Fecha', 'Tasa de conversión', 'Importe EUR', 'Preço (R$)'],
      [46023, 0.12, 8100.25, 99.9],
    ])
    expect(ws.getCell('A2').value).toBeInstanceOf(Date)
    expect(ws.getCell('A2').numFmt).toBe('yyyy-mm-dd')
    expect(ws.getCell('B2').numFmt).toMatch(/%$/)
    expect(ws.getCell('C2').numFmt).toContain('"€"')
    expect(ws.getCell('D2').numFmt).toContain('"R$"')
  })

  it('writes years and identifiers without a thousands separator', async () => {
    const { ws } = await oneSheet([
      ['Year', 'Order ID', 'Año', 'Units'],
      [2026, 100234, 2025, 1500],
    ])
    expect(ws.getCell('A2').numFmt).toBe('0')
    expect(ws.getCell('B2').numFmt).toBe('0')
    expect(ws.getCell('C2').numFmt).toBe('0')
    expect(ws.getCell('D2').numFmt).toBe('#,##0')
  })

  it('uses the currency the header names instead of assuming dollars', async () => {
    const { ws } = await oneSheet(
      [
        ['Cost EUR', 'Monto MXN', 'Revenue', 'Fee'],
        [8100.25, 99000, 1200.5, 10],
      ],
      { columnFormats: { Fee: 'currency:GBP' } }
    )
    expect(ws.getCell('A2').numFmt).toContain('"€"')
    expect(ws.getCell('A2').numFmt).not.toContain('"$"')
    expect(ws.getCell('B2').numFmt).toContain('"MX$"')
    expect(ws.getCell('C2').numFmt).toContain('"$"')
    expect(ws.getCell('D2').numFmt).toContain('"£"')
  })

  it('resolves columnFormats keys by header in any case, letter or index', async () => {
    const { result, ws } = await oneSheet(
      [
        ['Month', 'Total', 'Net', 'Tax'],
        ['Jan', 1500.5, 20, 0.16],
      ],
      {
        columnFormats: {
          total: 'currencyUsd',
          C: 'currencyEur',
          '3': 'percentage',
          Missing: 'decimal',
          Month: 'money please',
        },
      }
    )
    expect(ws.getCell('B2').numFmt).toContain('"$"')
    expect(ws.getCell('C2').numFmt).toContain('"€"')
    expect(ws.getCell('D2').numFmt).toBe('0.0%')
    expect(result.content).toContain("'Missing'")
    expect(result.content).toContain("'money please'")
  })
})

describe('conditional formatting', () => {
  it('finds the column by header, letter or 0-based index and compares numbers as numbers', async () => {
    const { result, ws } = await oneSheet(
      [
        ['Status', 'Amount', 'Quick Win'],
        ['Late', '1,500', 1],
        ['ok', 100, '0'],
      ],
      {
        conditionalFormatting: [
          { column: 'status', rules: [{ equals: 'late', fillColor: '#fee2e2' }] },
          { column: 'B', rules: [{ greaterThan: 1000, fillColor: '#dcfce7' }] },
          { column: 1, rules: [{ equals: '100', fillColor: '#fef9c3' }] },
          { column: 'Quick Win', rules: [{ equals: 1, fillColor: '#fef3c7' }] },
          { column: 'Nope', rules: [{ equals: 1, fillColor: '#000000' }] },
        ],
      }
    )
    expect(fillOf(ws.getCell('A2'))).toBe('FFFEE2E2')
    expect(fillOf(ws.getCell('B2'))).toBe('FFDCFCE7')
    expect(fillOf(ws.getCell('B3'))).toBe('FFFEF9C3')
    expect(fillOf(ws.getCell('C2'))).toBe('FFFEF3C7')
    expect(fillOf(ws.getCell('C3'))).not.toBe('FFFEF3C7')
    expect(result.content).toContain("'Nope'")
  })

  it('compares percentages and currency with the number as written', async () => {
    const { ws } = await oneSheet(
      [
        ['Growth %', 'Price'],
        ['45%', '$1,200'],
        [12, '$80'],
      ],
      {
        conditionalFormatting: [
          { column: 'Growth %', rules: [{ greaterThan: 40, fillColor: '#dcfce7' }] },
          { column: 'Price', rules: [{ between: [1000, 2000], fillColor: '#fee2e2' }] },
        ],
      }
    )
    expect(fillOf(ws.getCell('A2'))).toBe('FFDCFCE7')
    expect(fillOf(ws.getCell('A3'))).not.toBe('FFDCFCE7')
    expect(fillOf(ws.getCell('B2'))).toBe('FFFEE2E2')
    expect(fillOf(ws.getCell('B3'))).not.toBe('FFFEE2E2')
  })

  it('tests regex and contains against the text as written', async () => {
    const { ws } = await oneSheet([['Price'], ['$1,200'], ['80']], {
      conditionalFormatting: [
        { column: 'Price', rules: [{ regex: '^\\$', fillColor: '#fee2e2' }] },
      ],
    })
    expect(fillOf(ws.getCell('A2'))).toBe('FFFEE2E2')
    expect(fillOf(ws.getCell('A3'))).not.toBe('FFFEE2E2')
  })
})

describe('colors', () => {
  it('accepts shorthand hex and CSS names, and falls back with a warning otherwise', async () => {
    const result = await generate({
      filename: 'c.xlsx',
      sheets: [
        {
          name: 'S',
          titleRow: { text: 'T', fillColor: '#f00', fontColor: 'white' },
          rows: [['v'], [5], [6]],
          conditionalFormatting: [
            {
              column: 'v',
              rules: [
                { equals: 5, fillColor: 'green' },
                { equals: 6, fillColor: 'not-a-color' },
              ],
            },
          ],
        },
      ],
    })
    const ws = await sheetOf(result)
    expect(fillOf(ws.getCell('A1'))).toBe('FFFF0000')
    expect(fillOf(ws.getCell('A3'))).toBe('FF008000')
    expect(result.content).toContain('conditionalFormatting[0].rules[1].fillColor')
  })

  it('reads #RRGGBBAA as CSS and a bare 8-digit hex as Excel ARGB', async () => {
    const result = await generate({
      filename: 'c8.xlsx',
      sheets: [
        {
          name: 'S',
          titleRow: { text: 'T', fillColor: '#ff000080' },
          rows: [['v'], [5]],
          conditionalFormatting: [{ column: 'v', rules: [{ equals: 5, fillColor: 'FF1E3A8A' }] }],
        },
      ],
    })
    const ws = await sheetOf(result)
    expect(fillOf(ws.getCell('A1'))).toBe('FFFF0000')
    expect(fillOf(ws.getCell('A3'))).toBe('FF1E3A8A')
  })
})

describe('signs, identifiers and text left as sent', () => {
  it('reads a leading plus as a sign on a quantity, and keeps phone numbers as text', async () => {
    const { ws } = await oneSheet([
      ['Metric', 'Change %', 'Change $', 'Delta', 'Phone'],
      ['Revenue', '+12%', '+$144', '+5', '+34600111222'],
      ['Churn', '-3%', '-$0.15', '-3', '+1 555 0100'],
      ['NPS', '+0.5%', '+$0.2', '+1,500', '+1-800-555-0100'],
    ])
    expect(ws.getCell('B2').value).toBeCloseTo(0.12, 12)
    expect(ws.getCell('B4').value).toBeCloseTo(0.005, 12)
    expect(ws.getCell('C2').value).toBe(144)
    expect(ws.getCell('C4').value).toBe(0.2)
    expect(ws.getCell('D2').value).toBe(5)
    expect(ws.getCell('D4').value).toBe(1500)
    expect(ws.getCell('E2').value).toBe('+34600111222')
    expect(ws.getCell('E3').value).toBe('+1 555 0100')
    expect(ws.getCell('E4').value).toBe('+1-800-555-0100')
  })

  it('keeps showing the plus a number was written with', async () => {
    const { ws } = await oneSheet([
      ['Dial prefix', 'Score change', 'Share'],
      ['+44', '+5', '+12%'],
      ['+1', '-3', '-3%'],
    ])
    expect(ws.getCell('A2').value).toBe(44)
    expect(ws.getCell('A2').numFmt).toMatch(/^\+/)
    expect(ws.getCell('B2').value).toBe(5)
    expect(ws.getCell('B2').numFmt).toMatch(/^\+[^;]*;-/)
    expect(ws.getCell('B3').numFmt ?? '').not.toMatch(/^\+/)
    expect(ws.getCell('C2').numFmt).toMatch(/^\+[^;]*%/)
  })

  it('reads accounting parentheses as a sign on a quantity, and notes refused dates', async () => {
    const { ws, result } = await oneSheet([
      ['Account', 'Q1', 'Q2', 'Note', 'Booked on'],
      ['A', 1200, '($300)', '(1)', '2026-02-27'],
      ['B', '(500)', '(1,200.50)', '(2)', '2026-02-29'],
      ['C', 700, 1200, '(3)', '1899-12-31'],
    ])
    expect(ws.getCell('B3').value).toBe(-500)
    expect(ws.getCell('C2').value).toBe(-300)
    expect(ws.getCell('C3').value).toBe(-1200.5)
    expect(ws.getCell('D2').value).toBe('(1)')
    expect(ws.getCell('E3').value).toBe('2026-02-29')
    expect(result.content).toContain(
      "column 'Booked on': 2 dates such as '2026-02-29' were kept as text"
    )
  })

  it('writes identifier columns without thousands separators', async () => {
    const headers = [
      'Invoice No.',
      'Invoice #',
      'Account number',
      'Employee number',
      'Número de factura',
      'NIF',
      'Ticket',
    ]
    const { ws } = await oneSheet([
      [...headers, 'Number of employees'],
      [10023, 10023, 1234567890, 4501, 20260001, 12345678, 5521, 1500],
    ])
    headers.forEach((_, c) => expect(ws.getRow(2).getCell(c + 1).numFmt).toBe('0'))
    expect(ws.getCell('H2').numFmt).toBe('#,##0')
  })

  it('keeps a column of codes as text when any of them has a leading zero', async () => {
    const { result, ws } = await oneSheet([['Account'], ['0012345678'], ['1234567890'], [9]])
    expect(ws.getCell('A2').value).toBe('0012345678')
    expect(ws.getCell('A3').value).toBe('1234567890')
    expect(ws.getCell('A4').value).toBe('9')
    expect(result.content).toContain("'0012345678'")
  })

  it('names number- and date-looking text it could not read, once per column', async () => {
    const { result, ws } = await oneSheet([
      ['Concepto', 'Importe', 'Tasa', 'Precio', 'Fecha', 'Delta', 'Big'],
      ['Alquiler', '1.234,50', '12,5%', '€1.200,00', '22/09/2026', '−12.5', '1e6'],
      ['Luz', '98,10', '3,1%', '€80,00', '23/09/2026', '−3', '2e6'],
    ])
    expect(ws.getCell('B2').value).toBe('1.234,50')
    // U+2212 is a minus sign and nothing else.
    expect(ws.getCell('F2').value).toBe(-12.5)
    const notes = result.content ?? ''
    for (const column of ['Importe', 'Tasa', 'Precio', 'Fecha', 'Big']) {
      expect(notes).toMatch(new RegExp(`'${column}': 2 values such as '[^']+' were kept as text`))
    }
    expect(notes).not.toContain("'Concepto'")
    expect(notes).not.toContain("'Delta'")
  })

  it("cuts text at Excel's 32,767-character cell limit and says where", async () => {
    const long = 'x'.repeat(40_000)
    const { result, ws } = await oneSheet(
      [
        ['Notes', 'Other'],
        [long, 'ok'],
      ],
      { titleRow: { text: `T${long}` } }
    )
    expect((ws.getCell('A3').value as string).length).toBe(32_767)
    expect((ws.getCell('A1').value as string).length).toBe(32_767)
    expect(result.content).toContain('cell A3 was cut to 32,767 characters')
    expect(result.content).toContain('titleRow.text was cut to 32,767 characters')
  })

  it('does not split an emoji when cutting at the cell limit', async () => {
    const text = `${'x'.repeat(32_766)}\u{1F600}tail`
    const { ws } = await oneSheet([['Notes'], [text]])
    expect(ws.getCell('A2').value).toBe('x'.repeat(32_766))
  })
})

describe('percent columns and format codes', () => {
  it('says how an inferred percent column was read', async () => {
    const { result, ws } = await oneSheet([
      ['Month', 'Churn %', 'Interest rate %', 'Share'],
      ['Jan', 0.8, 0.25, 0.12],
      ['Feb', 1.1, 0.5, 0.45],
      ['Mar', 0.9, 0.75, 0.3],
    ])
    // Past 1 with a '%' header, 1.1 is 1.1%, not 110%.
    expect(ws.getCell('B3').value).toBe(0.011)
    expect(result.content).toMatch(/'Churn %'.*percentage points.*'Churn %': 'percent'/)
    expect(ws.getCell('C2').value).toBe(0.25)
    expect(result.content).toMatch(/'Interest rate %'.*fractions \(0\.8 = 80%\).*percentPoints/)
    expect(result.content).toMatch(/'Share'.*fractions/)
  })

  it('refuses Excel format codes with more than four sections or unbalanced quotes', async () => {
    const { result, ws } = await oneSheet(
      [
        ['A', 'B', 'C', 'D'],
        [1.5, 2.5, 3.5, 4.5],
      ],
      { columnFormats: { A: '#,##0.0;;;;', B: '0;0;0;0;0', C: '0 "kg', D: '#,##0.0;;;' } }
    )
    expect(ws.getCell('A2').numFmt).not.toBe('#,##0.0;;;;')
    expect(ws.getCell('B2').numFmt).not.toBe('0;0;0;0;0')
    expect(ws.getCell('C2').numFmt).not.toBe('0 "kg')
    expect(ws.getCell('D2').numFmt).toBe('#,##0.0;;;')
    for (const key of ["['A']", "['B']", "['C']"]) expect(result.content).toContain(key)
    expect(result.content).not.toContain("['D']")
  })
})

describe('regex rules', () => {
  it('reports an invalid regex as invalid, not as slow', async () => {
    const { result } = await oneSheet([['Region'], ['North']], {
      conditionalFormatting: [{ column: 'Region', rules: [{ regex: '[', fillColor: '#000000' }] }],
    })
    expect(result.content).toContain('rules[0].regex is not a valid regular expression')
    expect(result.content).not.toContain('nested repetition')
  })

  it('stops regexes that backtrack exponentially within one time budget', async () => {
    const evil = ['^(a|a)*$', '^(a|aa)*$', '^(\\w|\\d)*$']
    const sheet = (name: string) => ({
      name,
      rows: [
        ['Name'],
        ...Array.from({ length: 20 }, (_, i) => [`${(i % 2 ? '1' : 'a').repeat(35 + i)}!`]),
      ],
      conditionalFormatting: [
        { column: 'Name', rules: evil.map(regex => ({ regex, fillColor: '#fee2e2' })) },
      ],
    })
    const started = Date.now()
    const result = await generate({ filename: 'redos.xlsx', sheets: [sheet('A'), sheet('B')] })
    // Loose, so a slow machine passes; one unbounded match of these takes minutes.
    expect(Date.now() - started).toBeLessThan(15_000)
    expect(result.success, result.error).toBe(true)
    expect(result.content).toContain('regex took too long to test')
    // A rule after the budget ran out is not blamed on its own pattern.
    expect(result.content).toMatch(/regex was skipped: the regex rules before it used the 500 ms/)
    const ws = await sheetOf(result)
    expect(fillOf(ws.getCell('A2'))).not.toBe('FFFEE2E2')
  }, 30_000)

  it('runs thousands of cheap regex rules within the budget', async () => {
    // Setting up matching per rule would use the budget before the rules do.
    const sheet = (s: number) => ({
      name: `S${s}`,
      rows: [['Code'], ...Array.from({ length: 20 }, (_, i) => [`FAIL-${i}`])],
      conditionalFormatting: [
        {
          column: 'Code',
          rules: Array.from({ length: 40 }, (_, r) => ({
            regex: `^FAIL-${r % 20}$`,
            fillColor: '#fee2e2',
          })),
        },
      ],
    })
    const result = await generate({
      filename: 'many.xlsx',
      sheets: Array.from({ length: 50 }, (_, s) => sheet(s)),
    })
    expect(result.success, result.error).toBe(true)
    expect(result.content ?? '').not.toContain('regex')
  }, 30_000)

  it('sizes a title of very many lines', async () => {
    const result = await generate({
      filename: 'title.xlsx',
      sheets: [{ name: 'T', titleRow: { text: 'line\n'.repeat(200_000) }, rows: [] }],
    })
    expect(result.success, result.error).toBe(true)
    expect(result.content).toContain('titleRow.text was cut to 32,767 characters')
  }, 30_000)

  it('still runs ordinary regex rules on a large sheet', async () => {
    const rows = [['Code'], ...Array.from({ length: 20_000 }, (_, i) => [`R-${i}`])]
    const { result, ws } = await oneSheet(rows, {
      conditionalFormatting: [
        { column: 'Code', rules: [{ regex: '^R-1\\d*5$', fillColor: '#fee2e2' }] },
      ],
    })
    expect(result.content ?? '').not.toContain('took too long')
    expect(fillOf(ws.getCell('A17'))).toBe('FFFEE2E2')
    expect(fillOf(ws.getCell('A18'))).not.toBe('FFFEE2E2')
  }, 30_000)
})

describe('formats that fit the value', () => {
  it('keeps the format of a percent or another currency under a requested format, with a note', async () => {
    const { result, ws } = await oneSheet(
      [
        ['Growth', 'Share', 'Price'],
        ['45%', '$1,200', '$1,200'],
        [12, 0.3, '€50'],
      ],
      { columnFormats: { Growth: 'integer', Share: 'percent', Price: 'currency:EUR' } }
    )
    expect(ws.getCell('A2').numFmt).toBe('0%')
    expect(ws.getCell('B2').numFmt).toContain('"$"')
    expect(ws.getCell('C2').numFmt).toContain('"$"')
    expect(ws.getCell('C3').numFmt).toContain('€')
    expect(ws.getCell('A3').numFmt).toBe('#,##0')
    expect(result.content).toContain("column 'Growth': '45%' does not fit the format")
  })

  it('reads amounts under headers that name an identifier word as amounts', async () => {
    const { ws } = await oneSheet([
      ['Ticket price', 'Code coverage', 'Mobile revenue', 'Ticket'],
      ['$45.00', '85%', '$1,200', '00123'],
    ])
    expect(ws.getCell('A2').value).toBe(45)
    expect(ws.getCell('B2').value).toBe(0.85)
    expect(ws.getCell('C2').value).toBe(1200)
    expect(ws.getCell('D2').value).toBe('00123')
  })

  it('keeps counts under event words as counts, and dates them only when the header says so', async () => {
    const { ws } = await oneSheet([
      ['Accounts created', 'Created at'],
      [24512, 46000],
    ])
    expect(ws.getCell('A2').value).toBe(24512)
    expect(ws.getCell('B2').value).toBeInstanceOf(Date)
  })

  it('shows as many decimals as the values need, and a percent cell its own', async () => {
    const { ws } = await oneSheet([
      ['p-value', 'Latitude', 'Score', 'Pct mix'],
      [0.0012, 40.416775, 12.5, '12.5%'],
      [0.00004, -3.7038, 3.25, 5],
    ])
    expect(ws.getCell('A2').numFmt).toBe('#,##0.00000')
    expect(ws.getCell('B2').numFmt).toBe('#,##0.000000')
    expect(ws.getCell('C2').numFmt).toBe('#,##0.00')
    expect(ws.getCell('D2').numFmt).toBe('0.0%')
  })

  it('refuses an image anchor outside the sheet with a message naming it', async () => {
    const chart = INTERNAL_TOOLS.find(t => t.name === 'clerum__generate_chart')!
    await chart.execute(
      { filename: 'c.png', type: 'bar', data: { labels: ['a'], datasets: [{ data: [1] }] } },
      dir
    )
    const result = await generate({
      filename: 'a.xlsx',
      sheets: [{ name: 'S', rows: [['a'], [1]], images: [{ path: 'c.png', anchor: 'ZZZ1' }] }],
    })
    expect(result.success).toBe(false)
    expect(result.error).toContain('Invalid cell anchor "ZZZ1"')
  })
})
