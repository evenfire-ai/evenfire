import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GFS_LARGE_CSV_SIZE,
  GFS_OLD_VISUAL_LIMIT,
  buildGfsLargeCsvFixture,
  countMissingCsvColumns,
  hasCsvDataRecordCount,
  parseCsvMetadata,
  resolveGfsLargeCsvFixture,
} from '../../test/e2e-playwright/helpers/gfsLargeFileCsvFixture'

describe('large-file CSV fixture oracle', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('derives header fields and counts multiline records with escaped quotes', () => {
    const buffer = Buffer.from(
      '\uFEFF"record,id","said ""hello""","multi\nline"\r\n' +
        '"row,1","value with ""quotes""","line one\r\nline two"\r\n' +
        'row-2,,tail'
    )
    expect(parseCsvMetadata(buffer)).toEqual({
      columns: ['record,id', 'said "hello"', 'multi\nline'],
      dataRecordCount: 2,
    })
  })

  it.each(['\n', '\r\n', '\r'])('handles %j record endings without counting blank lines', end => {
    expect(parseCsvMetadata(Buffer.from(`first,second${end}${end}1,2${end}3,4${end}`))).toEqual({
      columns: ['first', 'second'],
      dataRecordCount: 2,
    })
  })

  it('counts empty fields and preserves Unicode header names', () => {
    expect(parseCsvMetadata(Buffer.from('á,列,📁\n,,\n"","",'))).toEqual({
      columns: ['á', '列', '📁'],
      dataRecordCount: 2,
    })
  })

  it.each([
    ['a,b\nrow,"unfinished', 'unterminated quoted field'],
    ['a,b\nrow,"closed"trailer\n', 'content after a quote'],
    ['a,b\nrow,un"quoted\n', 'Unexpected CSV quote'],
    ['a,b\nrow\n', 'inconsistent column count'],
    ['a,b\nrow,value,extra\n', 'inconsistent column count'],
    ['', 'header record'],
  ])('rejects malformed CSV %j without echoing record values', (text, message) => {
    expect(() => parseCsvMetadata(Buffer.from(text))).toThrow(message)
  })

  it('rejects invalid UTF-8 instead of deriving replacement-character columns', () => {
    expect(() => parseCsvMetadata(Buffer.from([0xff]))).toThrow()
  })

  it('accepts a header-only CSV with no data records', () => {
    expect(parseCsvMetadata(Buffer.from('first,second'))).toEqual({
      columns: ['first', 'second'],
      dataRecordCount: 0,
    })
  })

  it.each(['size', 'digest'] as const)('keeps the opt-in original %s guard', guard => {
    const directory = mkdtempSync(join(tmpdir(), 'gfs-large-csv-guard-'))
    const filePath = join(directory, 'invalid-original.csv')
    try {
      // A synthetic invalid file exercises each guard without the original
      // customer input, and must fail before the CSV parser sees any records.
      writeFileSync(filePath, guard === 'size' ? 'id\n' : Buffer.alloc(GFS_LARGE_CSV_SIZE, 0x61), {
        mode: 0o600,
      })
      vi.stubEnv('E2E_GFS_LARGE_CSV_PATH', filePath)
      expect(() => resolveGfsLargeCsvFixture()).toThrow(
        guard === 'size' ? 'must contain exactly' : 'digest mismatch'
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('independently counts the exact-size synthetic file past the former inline boundary', () => {
    const csv = buildGfsLargeCsvFixture()
    const text = csv.buffer.toString('utf8')
    expect(csv.buffer.byteLength).toBe(GFS_LARGE_CSV_SIZE)
    expect(csv.buffer.indexOf(csv.sentinel!, 'utf8')).toBeGreaterThan(GFS_OLD_VISUAL_LIMIT)
    expect(csv.buffer.indexOf(csv.lastRecordId!, 'utf8')).toBeGreaterThan(GFS_OLD_VISUAL_LIMIT)
    expect(csv.columns).toEqual(['id', 'record name', 'notes,value', 'value'])
    expect(csv.dataRecordCount).toBe((text.match(/^"record-\d+"/gm) ?? []).length + 1)
    expect(text.split('\n').length - 1).toBeGreaterThan(csv.dataRecordCount + 1)
    expect(text).toContain(`"${csv.lastRecordId}","final, sentinel row"`)
    expect(csv.lastRecordId).toMatch(/^record-final-[0-9a-f-]{36}$/)
    expect(text).toContain('""""escaped quotes""""')
    expect(csv.source).toBe('synthetic')
  })
})

describe('large-file CSV summary assertions', () => {
  it.each([
    ['Hay 923 registros de datos, sin contar la cabecera.', 923, true],
    ['**Registros de datos (sin cabecera):** 923.', 923, true],
    ['Rows (excluding header): 923', 923, true],
    ['data_record_count: 923', 923, true],
    ['El archivo tiene **923** filas.', 923, true],
    ['Contiene 38.410 registros.', 38_410, true],
    ['Records: 38,410', 38_410, true],
    ['38 410 data rows', 38_410, true],
    ['Checksum: abc923def. Rows: 924', 923, false],
    ['Checksum: 923; filas: 924', 923, false],
    ['Columnas: 923; registros: 924', 923, false],
    ['Last record ID: 923. There are 924 data records.', 923, false],
    ['Último registro identificador: 923. Contiene 924 registros.', 923, false],
    ['Registros IDs: 923; contiene 924 registros.', 923, false],
    ['Registros: 9,2,3', 923, false],
    ['Registros: 1923', 923, false],
    ['Registros: 9230', 923, false],
    ['Registros: -923', 923, false],
    ['Registros: 923.4', 923, false],
  ] as const)('binds the expected count to record meaning in %j', (summary, count, matches) => {
    expect(hasCsvDataRecordCount(summary, count)).toBe(matches)
  })

  it('does not let a compound header satisfy a missing shorter column', () => {
    expect(countMissingCsvColumns('Columnas: notes,value', ['notes,value', 'value'])).toBe(1)
    expect(
      countMissingCsvColumns('Columnas: "notes,value", "value"', ['notes,value', 'value'])
    ).toBe(0)
  })

  it('requires independent mentions for duplicate column names', () => {
    expect(countMissingCsvColumns('Columnas: value', ['value', 'value'])).toBe(1)
    expect(countMissingCsvColumns('Columnas: value, value', ['value', 'value'])).toBe(0)
  })

  it('matches complete field names rather than substrings or regular expressions', () => {
    expect(countMissingCsvColumns('Columnas: valid', ['id'])).toBe(1)
    expect(countMissingCsvColumns('Columnas: notesXvalue', ['notes.value'])).toBe(1)
    expect(
      countMissingCsvColumns('Columnas: á, 列, 📁, price (USD), A+B', [
        'á',
        '列',
        '📁',
        'price (USD)',
        'A+B',
      ])
    ).toBe(0)
  })
})
