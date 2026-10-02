import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

// E2E_GUARDIAN_IPC_FLOW: this pure fixture has no renderer network boundary.
// The Desktop journey that consumes it exercises the Electron IPC path.
export const GFS_LARGE_CSV_SIZE = 3_836_961
export const GFS_OLD_VISUAL_LIMIT = 3_145_728
export const GFS_LARGE_CSV_INCIDENT_SHA256 =
  '675b72d7ba4c4c6eca3a49a076ed6adcff72165805e2069bc3619bca333c9bd1'

export interface GfsLargeCsvFixture {
  fileName: string
  sourcePath?: string
  buffer: Buffer
  recordCount: number
  sentinel?: string
  tailProof: string
  source: 'synthetic' | 'actual'
}

function csvField(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

export function buildGfsLargeCsvFixture(): GfsLargeCsvFixture {
  const sentinel = `GFS_LARGE_CSV_SENTINEL_${crypto.randomUUID()}`
  let content = `${csvField('id')},${csvField('record name')},${csvField(
    'notes,value'
  )},${csvField('value')}\n`
  let contentBytes = Buffer.byteLength(content, 'utf8')
  let recordCount = 1
  const finalPrefix = `${csvField('record-final')},${csvField('final, sentinel row')},"${sentinel}`
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
    recordCount += 1
  }

  const usedBytes = contentBytes + minimumFinalLength
  if (usedBytes > GFS_LARGE_CSV_SIZE) throw new Error('GFS large CSV fixture sizing underflow')
  const padding = 'z'.repeat(GFS_LARGE_CSV_SIZE - usedBytes)
  content += `${finalPrefix}${padding}${closing}`
  recordCount += 1

  const buffer = Buffer.from(content, 'utf8')
  if (buffer.byteLength !== GFS_LARGE_CSV_SIZE)
    throw new Error(`expected exactly ${GFS_LARGE_CSV_SIZE} bytes, got ${buffer.byteLength}`)
  if (buffer.indexOf(sentinel, 'utf8') <= GFS_OLD_VISUAL_LIMIT)
    throw new Error('sentinel must start beyond the former 3 MiB visual limit')

  return {
    fileName: `gfs-large-file-${crypto.randomUUID()}.csv`,
    buffer,
    recordCount,
    sentinel,
    tailProof: crypto
      .createHash('sha256')
      .update(buffer.subarray(Math.max(0, buffer.byteLength - 4096)))
      .digest('hex')
      .slice(0, 16),
    source: 'synthetic',
  }
}

function countCsvRecords(buffer: Buffer): number {
  let records = 0
  let insideQuotes = false
  let sawRecordBytes = false
  for (const byte of buffer) {
    if (byte === 0x22) {
      insideQuotes = !insideQuotes
      sawRecordBytes = true
      continue
    }
    if (byte === 0x0a && !insideQuotes) {
      records += 1
      sawRecordBytes = false
      continue
    }
    if (byte !== 0x0d) sawRecordBytes = true
  }
  return records + (sawRecordBytes ? 1 : 0)
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
    fileName: path.basename(explicitPath),
    sourcePath: explicitPath,
    buffer,
    recordCount: countCsvRecords(buffer),
    tailProof: crypto
      .createHash('sha256')
      .update(buffer.subarray(Math.max(0, buffer.byteLength - 4096)))
      .digest('hex')
      .slice(0, 16),
    source: 'actual',
  }
}
