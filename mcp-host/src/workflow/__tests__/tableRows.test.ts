import { describe, expect, it } from 'vitest'
import { headerText, normalizeTableRows } from '../tableRows'

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
