/**
 * Read entries out of the DOCX, XLSX and PPTX files the generators write,
 * without a zip dependency the runtime does not ship. Sizes come from the
 * central directory because writers that stream (ExcelJS) leave them zero in
 * the local headers.
 */
import * as fs from 'fs'
import * as zlib from 'zlib'

export function zipEntries(file: string): Map<string, Buffer> {
  const buf = fs.readFileSync(file)
  let eocd = -1
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error(`${file} is not a zip archive`)
  const count = buf.readUInt16LE(eocd + 10)
  let at = buf.readUInt32LE(eocd + 16)
  const out = new Map<string, Buffer>()
  for (let n = 0; n < count; n++) {
    const method = buf.readUInt16LE(at + 10)
    const compressed = buf.readUInt32LE(at + 20)
    const nameLen = buf.readUInt16LE(at + 28)
    const extraLen = buf.readUInt16LE(at + 30)
    const commentLen = buf.readUInt16LE(at + 32)
    const localAt = buf.readUInt32LE(at + 42)
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen)
    const dataAt = localAt + 30 + buf.readUInt16LE(localAt + 26) + buf.readUInt16LE(localAt + 28)
    const data = buf.subarray(dataAt, dataAt + compressed)
    out.set(name, method === 0 ? Buffer.from(data) : zlib.inflateRawSync(data))
    at += 46 + nameLen + extraLen + commentLen
  }
  return out
}

export function zipEntryText(file: string, name: string): string {
  const entry = zipEntries(file).get(name)
  if (!entry) throw new Error(`${name} not found in ${file}`)
  return entry.toString('utf8')
}

/** Characters an XML 1.0 document may not contain; a match means a file Office rejects. */
export const XML_FORBIDDEN_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/
