import { isUtf8 } from 'node:buffer'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

// E2E_GUARDIAN_IPC_FLOW: this pure fixture has no renderer network boundary.
// The Desktop journey that consumes it exercises the Electron IPC path.
export const GFS_LARGE_CSV_SIZE = 3_836_961
export const GFS_OLD_VISUAL_LIMIT = 3_145_728
export const GFS_LARGE_CSV_INCIDENT_SHA256 =
  '675b72d7ba4c4c6eca3a49a076ed6adcff72165805e2069bc3619bca333c9bd1'

export interface CsvMetadata {
  columns: string[]
  dataRecordCount: number
}

export interface GfsLargeCsvFixture extends CsvMetadata {
  fileName: string
  sourcePath?: string
  buffer: Buffer
  sentinel?: string
  lastRecordId?: string
  tailProof: string
  source: 'synthetic' | 'actual'
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Require a record label, so a receipt ID or checksum cannot supply the count. */
export function hasCsvDataRecordCount(summary: string, count: number): boolean {
  const digits = String(count).replace(/\B(?=(\d{3})+(?!\d))/g, '[.,\\s]?')
  const number = `(?<![\\p{L}\\p{N}_\\-\\u2212])${digits}(?![\\p{L}\\p{N}_]|[.,]\\d)`
  const countLabel =
    '\\b(?:registros|filas|(?:data[ _-]*)?(?:records|rows|(?:record|row)[ _-]*count))\\b'
  const recordLabel = '\\b(?:registros?|filas?|(?:data[ _-]*)?(?:records?|rows?))\\b'
  const description =
    '(?:(?!\\b(?:ids?|identificadores?|identifiers?|indices|índices|indexes?|positions?|posiciones)\\b)[^\\d\\n\\r.;]){0,80}'
  const afterNumber = '[\\s*\\x60_]{1,12}'
  return new RegExp(
    `(?:${countLabel}${description}${number}|${number}${afterNumber}${recordLabel})`,
    'iu'
  ).test(summary)
}

/** Extract explicit plural count claims without requiring a numeric summary. */
export function csvColumnCountClaims(summary: string): number[] {
  const label = String.raw`(?:columnas|columns)`
  const number = String.raw`(?<![\p{L}\p{N}_\-\u2212])(\d{1,3}(?:[., \t]\d{3})+|\d+)(?![\p{L}\p{N}_]|[.,]\d)`
  // Horizontal spacing cannot mistake the first numbered item below a
  // "Columns:" heading for a count of columns.
  const pattern = new RegExp(
    String.raw`(?:\b${label}\b\*{0,2}[ \t]*(?:\(|:|es|=|de|son)?[ \t]*\*{0,2}[ \t]*${number}|${number}[ \t*\x60_]{1,12}\b${label}\b)`,
    'giu'
  )
  return [...summary.matchAll(pattern)]
    .flatMap(match => [match[1], match[2]])
    .filter((raw): raw is string => Boolean(raw))
    .map(raw => Number(raw.replace(/[., \t]/g, '')))
}

/** Count distinct header mentions without returning private field names. */
export function countMissingCsvColumns(summary: string, columns: readonly string[]): number {
  const normalize = (value: string): string => value.replace(/\s+/g, ' ').trim()
  let remaining = normalize(summary)
  let missing = 0
  // Consume longer names first: "notes,value" cannot also prove "value".
  for (const column of columns.map(normalize).sort((left, right) => right.length - left.length)) {
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}_])${escapeRegExp(column)}(?![\\p{L}\\p{N}_])`,
      'u'
    )
    const match = column ? pattern.exec(remaining) : null
    if (!match) missing += 1
    else
      remaining =
        remaining.slice(0, match.index) +
        ' '.repeat(match[0].length) +
        remaining.slice(match.index + match[0].length)
  }
  return missing
}

function csvField(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

export function buildGfsLargeCsvFixture(): GfsLargeCsvFixture {
  const sentinel = `GFS_LARGE_CSV_SENTINEL_${crypto.randomUUID()}`
  const lastRecordId = `record-final-${crypto.randomUUID()}`
  let content = `${csvField('id')},${csvField('record name')},${csvField(
    'notes,value'
  )},${csvField('value')}\n`
  let contentBytes = Buffer.byteLength(content, 'utf8')
  const finalPrefix = `${csvField(lastRecordId)},${csvField('final, sentinel row')},"${sentinel}`
  const closing = `",${csvField('0')}\n`
  const minimumFinalLength = Buffer.byteLength(finalPrefix + closing, 'utf8')

  for (let index = 1; ; index += 1) {
    const multiline = index % 97 === 0
    const notes = multiline
      ? `first line\nsecond line with ""escaped quotes"" and, commas ${index}`
      : `ordinary notes ${index}`
    const row = `${csvField(`record-${index}`)},${csvField(
      `name, with comma ${index}`
    )},${csvField(notes)},${csvField(String(index % 17))}\n`
    const rowBytes = Buffer.byteLength(row, 'utf8')
    if (contentBytes + rowBytes + minimumFinalLength > GFS_LARGE_CSV_SIZE) break
    content += row
    contentBytes += rowBytes
  }

  const usedBytes = contentBytes + minimumFinalLength
  if (usedBytes > GFS_LARGE_CSV_SIZE) throw new Error('GFS large CSV fixture sizing underflow')
  const padding = 'z'.repeat(GFS_LARGE_CSV_SIZE - usedBytes)
  content += `${finalPrefix}${padding}${closing}`

  const buffer = Buffer.from(content, 'utf8')
  if (buffer.byteLength !== GFS_LARGE_CSV_SIZE)
    throw new Error(`expected exactly ${GFS_LARGE_CSV_SIZE} bytes, got ${buffer.byteLength}`)
  if (buffer.indexOf(sentinel, 'utf8') <= GFS_OLD_VISUAL_LIMIT)
    throw new Error('sentinel must start beyond the former 3 MiB visual limit')

  return {
    fileName: `gfs-large-file-${crypto.randomUUID()}.csv`,
    buffer,
    ...parseCsvMetadata(buffer),
    sentinel,
    lastRecordId,
    tailProof: crypto
      .createHash('sha256')
      .update(buffer.subarray(Math.max(0, buffer.byteLength - 4096)))
      .digest('hex')
      .slice(0, 16),
    source: 'synthetic',
  }
}

/** Independent CSV oracle; retain the header, never the data-record values. */
export function parseCsvMetadata(buffer: Buffer): CsvMetadata {
  if (!isUtf8(buffer)) throw new Error('CSV must contain valid UTF-8')
  const columns: string[] = []
  let dataRecordCount = 0
  let header = true
  let field: number[] = []
  let fieldCount = 0
  let state: 'start' | 'unquoted' | 'quoted' | 'closed' = 'start'
  let recordStarted = false

  const finishField = (): void => {
    if (header) {
      columns.push(Buffer.from(field).toString('utf8'))
      field = []
    }
    fieldCount += 1
    state = 'start'
  }
  const finishRecord = (): void => {
    finishField()
    if (header) header = false
    else {
      if (fieldCount !== columns.length)
        throw new Error(`CSV data record ${dataRecordCount + 1} has an inconsistent column count`)
      dataRecordCount += 1
    }
    fieldCount = 0
    recordStarted = false
  }

  const start = buffer.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? 3 : 0
  for (let index = start; index < buffer.length; index += 1) {
    const byte = buffer[index]!
    if (state === 'quoted') {
      if (byte === 0x22) {
        if (buffer[index + 1] === 0x22) {
          if (header) field.push(0x22)
          index += 1
        } else state = 'closed'
      } else if (header) field.push(byte)
      continue
    }
    if (byte === 0x2c) {
      finishField()
      recordStarted = true
      continue
    }
    if (byte === 0x0a || byte === 0x0d) {
      // Empty physical lines are not data records; quoted empty fields are.
      if (recordStarted) finishRecord()
      if (byte === 0x0d && buffer[index + 1] === 0x0a) index += 1
      continue
    }
    if (state === 'closed') throw new Error(`Unexpected CSV content after a quote at ${index}`)
    if (byte === 0x22) {
      if (state !== 'start') throw new Error(`Unexpected CSV quote at ${index}`)
      state = 'quoted'
    } else {
      state = 'unquoted'
      if (header) field.push(byte)
    }
    recordStarted = true
  }
  if (state === 'quoted') throw new Error('CSV contains an unterminated quoted field')
  if (recordStarted) finishRecord()
  if (header) throw new Error('CSV must contain a header record')
  return { columns, dataRecordCount }
}

/**
 * Resolve the incident-shaped CSV. CI uses the deterministic synthetic buffer;
 * a local run can provide the original customer CSV through
 * `E2E_GFS_LARGE_CSV_PATH`; its digest must match the recorded incident copy.
 * The original is never copied into the repository.
 */
export function resolveGfsLargeCsvFixture(): GfsLargeCsvFixture {
  const explicitPath = process.env.E2E_GFS_LARGE_CSV_PATH
  if (!explicitPath) return buildGfsLargeCsvFixture()

  const buffer = fs.readFileSync(explicitPath)
  if (buffer.byteLength !== GFS_LARGE_CSV_SIZE)
    throw new Error(
      `E2E_GFS_LARGE_CSV_PATH must contain exactly ${GFS_LARGE_CSV_SIZE} bytes; got ${buffer.byteLength}`
    )
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex')
  if (sha256 !== GFS_LARGE_CSV_INCIDENT_SHA256)
    throw new Error(
      `E2E_GFS_LARGE_CSV_PATH digest mismatch; expected ${GFS_LARGE_CSV_INCIDENT_SHA256}, got ${sha256}`
    )

  return {
    // The upload UI canonicalizes resource names; filesystem path/bytes stay untouched.
    fileName: path.basename(explicitPath).normalize('NFC'),
    sourcePath: explicitPath,
    buffer,
    ...parseCsvMetadata(buffer),
    tailProof: crypto
      .createHash('sha256')
      .update(buffer.subarray(Math.max(0, buffer.byteLength - 4096)))
      .digest('hex')
      .slice(0, 16),
    source: 'actual',
  }
}
