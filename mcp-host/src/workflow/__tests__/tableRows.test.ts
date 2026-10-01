import { describe, expect, it } from 'vitest'
import { headerText, normalizeTableRows } from '../tableRows'
import { sheetTable } from '../xlsxSheet'

describe('normalizeTableRows', () => {
  it('passes array rows through untouched', () => {
    const warnings: string[] = []
    expect(normalizeTableRows([['a', 1, null]], ['A', 'B', 'C'], 'tables[0]', warnings)).toEqual([
      ['a', 1, null],
    ])
    expect(warnings).toEqual([])
  })

  it('reads record rows by header name, ignoring case and spaces', () => {
    const warnings: string[] = []
    const rows = normalizeTableRows(
      [
        { Name: 'Ana', Amount: 1200 },
        { ' name ': 'Luis', amount: 900, extra: 'x' },
      ],
      ['Name', 'Amount'],
      'tables[0]',
      warnings
    )
    expect(rows).toEqual([
      ['Ana', 1200],
      ['Luis', 900],
    ])
    expect(warnings).toEqual([
      'tables[0]: 2 row(s) were objects and were read by header name; send each row as an array of cells in header order.',
      "tables[0]: the key(s) 'extra' match no header, so those values were left out.",
    ])
  })

  it('reads a key that names no header but a 0-based column, as the schema example does', () => {
    const warnings: string[] = []
    const rows = normalizeTableRows(
      [{ '0': 'Ana', '1': 1200 }, { Name: 'Luis', '0': 'ignored', ' 1 ': 900 }, { '2': 'x' }],
      ['Name', 'Amount'],
      'tables[0]',
      warnings
    )
    expect(rows).toEqual([
      ['Ana', 1200],
      ['Luis', 900],
      [undefined, undefined],
    ])
    expect(warnings[1]).toBe(
      "tables[0]: the key(s) '2' match no header, so those values were left out."
    )
  })

  it('reads a key that is a header before reading it as a column index', () => {
    const rows = normalizeTableRows([{ '1': 'by name', '0': 'first' }], ['Q', '1'], 't', [])
    expect(rows).toEqual([['first', 'by name']])
  })

  it('takes record values in order when there are no headers', () => {
    expect(normalizeTableRows([{ a: 1, b: 2 }], undefined, 's', [])).toEqual([[1, 2]])
  })

  it('drops what is not a row and says so', () => {
    const warnings: string[] = []
    expect(normalizeTableRows([['ok'], 'text', null, 3], ['A'], 'sheets[1]', warnings)).toEqual([
      ['ok'],
    ])
    expect(warnings).toEqual([
      'sheets[1]: 3 row(s) were neither an array nor an object and were left out.',
    ])
    const more: string[] = []
    expect(normalizeTableRows('a,b', ['A'], 'tables[2]', more)).toEqual([])
    expect(more).toEqual(['tables[2]: rows must be an array of rows; they were left out.'])
  })
})

describe('headerText', () => {
  it('shows numeric headers and blanks null', () => {
    expect(headerText(2026)).toBe('2026')
    expect(headerText(null)).toBe('')
    expect(headerText('Q1')).toBe('Q1')
  })
})

describe('sheetTable', () => {
  it('makes one column of record keys that differ only in case or surrounding space', () => {
    const warnings: string[] = []
    const table = sheetTable(
      {
        rows: [
          { Name: 'Ana', Amount: 1 },
          { 'name ': 'Luis', amount: 2 },
        ],
      },
      'sheets[0]',
      warnings
    )
    expect(table.header).toEqual(['Name', 'Amount'])
    expect(table.rows).toEqual([
      ['Ana', 1],
      ['Luis', 2],
    ])
  })
})
