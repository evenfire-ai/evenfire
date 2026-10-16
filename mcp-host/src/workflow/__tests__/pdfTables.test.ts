import { describe, expect, it } from 'vitest'
import { LANDSCAPE, PORTRAIT, type TableLayoutInput, layoutPdfTable } from '../pdfTables'

/** Half an em per character, bold a little wider. */
const measure = (text: string, bold: boolean) => text.length * (bold ? 0.55 : 0.5)

function input(overrides: Partial<TableLayoutInput>): TableLayoutInput {
  return {
    headers: ['A', 'B'],
    rows: [],
    cellPadding: 8,
    ruleWidth: 0,
    allowLandscape: true,
    label: 'tables[0]',
    ...overrides,
  }
}

const room = (page: { width: number }, columns: number) => page.width - columns * 8

describe('PDF table layout', () => {
  it('fills the printable width, giving wider content more of it', () => {
    const fit = layoutPdfTable(
      input({ rows: [['short', 'a much longer cell of text']] }),
      measure,
      []
    )
    expect(fit.widths.reduce((a, b) => a + b, 0)).toBeCloseTo(room(PORTRAIT, 2), 5)
    expect(fit.widths[1]).toBeGreaterThan(fit.widths[0])
    expect(fit.landscape).toBe(false)
    expect(fit.fontSize).toBe(11)
  })

  it('never makes a column narrower than its longest ordinary word', () => {
    const fit = layoutPdfTable(
      input({ headers: ['Key', 'Notes'], rows: [['Identifier', 'word '.repeat(200)]] }),
      measure,
      []
    )
    expect(fit.widths[0]).toBeGreaterThanOrEqual(measure('Identifier', false) * 11)
  })

  it('lets a URL break inside its cell instead of widening the table', () => {
    const url = `https://example.com/${'x'.repeat(400)}`
    const fit = layoutPdfTable(
      input({ headers: ['A', 'B', 'C'], rows: [['a', url, 'c']] }),
      measure,
      []
    )
    expect(fit.widths.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(room(PORTRAIT, 3) + 0.01)
    expect(fit.landscape).toBe(false)
  })

  it('shrinks the type, then turns the page, for many columns', () => {
    const headers = Array.from({ length: 13 }, (_, i) => `Column${i}`)
    const rows = [headers.map(() => '$1,234,567.00')]
    const warnings: string[] = []
    const fit = layoutPdfTable(input({ headers, rows }), measure, warnings)
    expect(fit.landscape).toBe(true)
    expect(fit.widths.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(room(LANDSCAPE, 13) + 0.01)
    expect(warnings[0]).toMatch(/tables\[0\] has more columns than a portrait page/)
  })

  it('stays portrait when landscape is not allowed', () => {
    const headers = Array.from({ length: 13 }, (_, i) => `Column${i}`)
    const fit = layoutPdfTable(
      input({ headers, rows: [headers.map(() => '$1,234,567.00')], allowLandscape: false }),
      measure,
      []
    )
    expect(fit.landscape).toBe(false)
    expect(fit.widths.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(room(PORTRAIT, 13) + 0.01)
  })

  it('lets rows break when one is taller than a page', () => {
    const short = layoutPdfTable(input({ rows: [['a', 'b']] }), measure, [])
    expect(short.dontBreakRows).toBe(true)
    expect(short.keepWithHeaderRows).toBe(1)
    const tall = layoutPdfTable(input({ rows: [['a', 'word '.repeat(3000)]] }), measure, [])
    expect(tall.dontBreakRows).toBe(false)
    expect(tall.keepWithHeaderRows).toBe(0)
  })

  it('leaves less room for rows when the footer grows the bottom margin', () => {
    // About 420pt tall with its header: within 80% of the usual page, not of one with a 260pt margin.
    const rows = [['a', 'word '.repeat(500)]]
    expect(layoutPdfTable(input({ rows }), measure, []).dontBreakRows).toBe(true)
    expect(layoutPdfTable(input({ rows, bottomMargin: 260 }), measure, []).dontBreakRows).toBe(
      false
    )
  })

  it('says which columns break words when no page and size can hold them', () => {
    const headers = Array.from({ length: 20 }, (_, i) => `Column${i}`)
    const warnings: string[] = []
    layoutPdfTable(input({ headers, rows: [headers.map(() => '1,234,567.00')] }), measure, warnings)
    expect(warnings.join(' ')).toMatch(
      /tables\[0\]: words in 'Column0', 'Column1', 'Column2' and \d+ more column\(s\) are wider than those columns.*split the table/
    )
  })

  it('uses the widths asked for: points, percentages, auto and star', () => {
    const fit = layoutPdfTable(
      input({
        headers: ['A', 'B', 'C', 'D'],
        rows: [['a', 'b', 'cc', 'd']],
        requested: [60, '20%', 'auto', '*'],
      }),
      measure,
      []
    )
    const space = room(PORTRAIT, 4)
    expect(fit.widths[0]).toBe(60)
    expect(fit.widths[1]).toBeCloseTo(space * 0.2, 5)
    expect(fit.widths[2]).toBeLessThan(40)
    expect(fit.widths.reduce((a, b) => a + b, 0)).toBeCloseTo(space, 5)
  })

  it('scales widths that add up to more than the page and says so', () => {
    const warnings: string[] = []
    const fit = layoutPdfTable(input({ requested: ['600', 400] }), measure, warnings)
    expect(fit.widths.reduce((a, b) => a + b, 0)).toBeCloseTo(room(PORTRAIT, 2), 5)
    expect(fit.widths[0] / fit.widths[1]).toBeCloseTo(1.5, 5)
    expect(warnings[0]).toMatch(/tables\[0\]\.widths add up to 1000 pt/)
  })

  it('keeps a shared column as wide as its longest word beside wide fixed ones', () => {
    const warnings: string[] = []
    const fit = layoutPdfTable(
      input({
        headers: ['A', 'B', 'C'],
        rows: [['a', 'b', 'WIDEEND alpha']],
        requested: [400, 400, '*'],
      }),
      measure,
      warnings
    )
    expect(fit.widths[2]).toBeGreaterThanOrEqual(measure('WIDEEND', false) * fit.fontSize)
    expect(fit.widths.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(room(PORTRAIT, 3) + 0.01)
    expect(warnings[0]).toMatch(/scaled down to fit/)
  })

  it('shrinks the type or turns the page for auto widths before breaking words', () => {
    const headers = Array.from({ length: 14 }, (_, i) => `C${i}`)
    const fit = layoutPdfTable(
      input({
        headers,
        rows: [headers.map(() => '1,234,567.00')],
        requested: headers.map(() => 'auto'),
      }),
      measure,
      []
    )
    for (const w of fit.widths) {
      expect(w).toBeGreaterThanOrEqual(measure('1,234,567.00', false) * fit.fontSize)
    }
  })

  it('reports a fixed width too narrow for its words', () => {
    const warnings: string[] = []
    const fit = layoutPdfTable(
      input({ headers: ['Key', 'B'], rows: [['Identification', 'b']], requested: [20, '*'] }),
      measure,
      warnings
    )
    expect(fit.widths[0]).toBe(20)
    expect(warnings.join(' ')).toMatch(
      /words in 'Key' are wider than that column.*widen it in tables\[0\]\.widths/
    )
  })

  it('ignores widths of the wrong length or kind, with a note', () => {
    const warnings: string[] = []
    layoutPdfTable(input({ requested: [100] }), measure, warnings)
    layoutPdfTable(input({ requested: ['wide', 100] }), measure, warnings)
    expect(warnings[0]).toMatch(/has 1 entries for 2 columns/)
    expect(warnings[1]).toMatch(/widths\[0\] \("wide"\) is not a number of points/)
  })
})
