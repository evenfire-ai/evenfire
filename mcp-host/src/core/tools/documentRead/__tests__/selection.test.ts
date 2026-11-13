import { describe, expect, it } from 'vitest'
import { decodeCursor, encodeCursor, resolvePageSelection } from '../selection'

describe('document read page selection', () => {
  it('selects every page when the specification is null', () => {
    expect(resolvePageSelection(null, 4)).toEqual([1, 2, 3, 4])
  })

  it('orders, de-duplicates and expands ranges', () => {
    expect(resolvePageSelection(' 5, 1-3 ,2 ', 8)).toEqual([1, 2, 3, 5])
  })

  it('rejects malformed, reversed, empty and out-of-range selections', () => {
    const invalid = [
      '',
      '1-',
      '-2',
      '3-1',
      '1,',
      ',2',
      '0',
      '1..3',
      '1e3',
      '+1',
      '4',
      `${'1,'.repeat(129)}1`,
    ]
    for (const specification of invalid) {
      expect(resolvePageSelection(specification, 3)).toBeNull()
    }
    expect(resolvePageSelection('1-4', 3)).toBeNull()
  })

  it('rejects a non-document page count even for a valid-looking selection', () => {
    expect(resolvePageSelection('1', 0)).toBeNull()
    expect(resolvePageSelection('1', Number.POSITIVE_INFINITY)).toBeNull()
    expect(resolvePageSelection(null, 1.5)).toBeNull()
  })

  it('accepts a selection at the character cap and rejects one past it', () => {
    // A 256-character selection, with duplicate single pages allowed and
    // de-duplicated by the production resolver.
    const boundary = `1-99${',999'.repeat(62)},999`
    expect(boundary).toHaveLength(256)
    const pageCount = 99_999
    const selected = resolvePageSelection(boundary, pageCount)
    expect(selected?.at(0)).toBe(1)
    expect(selected?.at(-1)).toBe(999)
    expect(selected?.length).toBe(100)
    expect(resolvePageSelection(`${boundary}9`, pageCount)).toBeNull()
  })
})

const DIGEST_A = 'a'.repeat(12) + '0'.repeat(52)
const DIGEST_B = 'b'.repeat(12) + '0'.repeat(52)
const REF_A = `att:m1:f1@sha256:${DIGEST_A}`
const BIND_A = DIGEST_A.slice(0, 12)

describe('document read cursors', () => {
  it('round-trips PDF and XLSX positions without making the format readable to the model', () => {
    const pdf = encodeCursor({ format: 'pdf', page: 12, charOffset: 34 }, REF_A)
    const xlsx = encodeCursor({ format: 'xlsx', sheetIndex: 5, row: 6 }, REF_A)
    expect(decodeCursor(pdf, REF_A)).toEqual({ format: 'pdf', page: 12, charOffset: 34 })
    expect(decodeCursor(xlsx, REF_A)).toEqual({ format: 'xlsx', sheetIndex: 5, row: 6 })
    expect(pdf).toBe(`v1.pdf.12.34.${BIND_A}`)
    expect(xlsx).toBe(`v1.xlsx.5.6.${BIND_A}`)
  })

  it('resumes the same bytes reattached in another message and refuses another document', () => {
    const cursor = encodeCursor({ format: 'pdf', page: 3, charOffset: 0 }, REF_A)
    // Witness: same content digest under a new message and attachment id.
    expect(decodeCursor(cursor, `att:m2:f9@sha256:${DIGEST_A}`)).toEqual({
      format: 'pdf',
      page: 3,
      charOffset: 0,
    })
    expect(decodeCursor(cursor, `att:m1:f1@sha256:${DIGEST_B}`)).toBeNull()
  })

  it('refuses a reference id without a content digest', () => {
    expect(() => encodeCursor({ format: 'pdf', page: 1, charOffset: 0 }, 'att:m1:f1')).toThrow(
      'Document reference id carries no content digest'
    )
  })

  it('rejects foreign, malformed, crossed-format and invalid cursors', () => {
    const foreign = [
      '',
      'v1.pdf',
      `v2.pdf.1.0.${BIND_A}`,
      `v1.txt.1.0.${BIND_A}`,
      `v1.pdf.0.0.${BIND_A}`,
      `v1.pdf.1.-1.${BIND_A}`,
      `v1.pdf.1.1.2.${BIND_A}`,
      `v1.xlsx.1.0.${BIND_A}`,
      `v1.xlsx.1.-1.${BIND_A}`,
      ` v1.pdf.1.0.${BIND_A}`,
      `v1.pdf.1.0.${BIND_A} `,
      `v1.pdf.0000000000.0.${BIND_A}`,
      'v1.pdf.1.0',
      `v1.pdf.1.0.${BIND_A.toUpperCase()}`,
      `v1.pdf.1.0.${BIND_A.slice(1)}`,
    ]
    for (const cursor of foreign) expect(decodeCursor(cursor, REF_A)).toBeNull()
  })

  it('keeps a PDF zero offset valid while requiring XLSX rows to start at one', () => {
    expect(decodeCursor(`v1.pdf.1.0.${BIND_A}`, REF_A)).toEqual({
      format: 'pdf',
      page: 1,
      charOffset: 0,
    })
    expect(decodeCursor(`v1.pdf.1.1.${BIND_A}`, REF_A)).toEqual({
      format: 'pdf',
      page: 1,
      charOffset: 1,
    })
    expect(decodeCursor(`v1.xlsx.1.1.${BIND_A}`, REF_A)).toEqual({
      format: 'xlsx',
      sheetIndex: 1,
      row: 1,
    })
  })
})
