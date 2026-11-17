import type { DocumentJobFailure } from './types'

const END_SIGNATURE = Buffer.from([0x50, 0x4b, 0x05, 0x06])
const UINT32_MAX = 0xffff_ffff

/** Read central-directory metadata without asking an inflater to open an entry. */
export function checkZipExpansion(
  source: Uint8Array,
  maxUncompressedBytes: number
): DocumentJobFailure | undefined {
  const bytes = Buffer.from(source.buffer, source.byteOffset, source.byteLength)
  const malformed: DocumentJobFailure = { ok: false, reason: 'document_parse_failed' }
  const exceeded: DocumentJobFailure = {
    ok: false,
    reason: 'document_limits_exceeded',
    limit: 'uncompressed_bytes',
  }
  // JSZip selects the last end signature too. Reject an invalid last record
  // rather than checking a different directory from the one it would load.
  const end = bytes.lastIndexOf(END_SIGNATURE)
  if (end < 0 || end + 22 > bytes.length) return malformed
  if (end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length) return malformed
  if (bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0) return malformed
  if (bytes.readUInt16LE(end + 8) !== bytes.readUInt16LE(end + 10)) return malformed

  let count = BigInt(bytes.readUInt16LE(end + 10))
  let size = BigInt(bytes.readUInt32LE(end + 12))
  let offset = BigInt(bytes.readUInt32LE(end + 16))
  let directoryEnd = end
  if (count === 0xffffn || size === BigInt(UINT32_MAX) || offset === BigInt(UINT32_MAX)) {
    const locator = end - 20
    if (locator < 0 || bytes.readUInt32LE(locator) !== 0x0706_4b50) return malformed
    if (bytes.readUInt32LE(locator + 4) !== 0 || bytes.readUInt32LE(locator + 16) !== 1) {
      return malformed
    }
    const recordOffset = bytes.readBigUInt64LE(locator + 8)
    if (recordOffset + 56n > BigInt(locator)) return malformed
    const record = Number(recordOffset)
    if (bytes.readUInt32LE(record) !== 0x0606_4b50) return malformed
    const recordSize = bytes.readBigUInt64LE(record + 4)
    if (recordSize < 44n || recordOffset + 12n + recordSize !== BigInt(locator)) return malformed
    if (bytes.readUInt32LE(record + 16) !== 0 || bytes.readUInt32LE(record + 20) !== 0) {
      return malformed
    }
    count = bytes.readBigUInt64LE(record + 32)
    if (bytes.readBigUInt64LE(record + 24) !== count) return malformed
    size = bytes.readBigUInt64LE(record + 40)
    offset = bytes.readBigUInt64LE(record + 48)
    directoryEnd = record
  }
  if (offset + size !== BigInt(directoryEnd) || count * 46n > size) return malformed
  let cursor = Number(offset)
  let total = 0n
  const limit = BigInt(maxUncompressedBytes)
  for (let entry = 0n; entry < count; entry += 1n) {
    if (cursor + 46 > directoryEnd || bytes.readUInt32LE(cursor) !== 0x0201_4b50) {
      return malformed
    }
    const nameLength = bytes.readUInt16LE(cursor + 28)
    const extraLength = bytes.readUInt16LE(cursor + 30)
    const commentLength = bytes.readUInt16LE(cursor + 32)
    const extraStart = cursor + 46 + nameLength
    const extraEnd = extraStart + extraLength
    const next = extraEnd + commentLength
    if (next > directoryEnd || bytes.readUInt16LE(cursor + 34) !== 0) return malformed
    let uncompressed = BigInt(bytes.readUInt32LE(cursor + 24))
    if (uncompressed === BigInt(UINT32_MAX)) {
      // ZIP64 puts the uncompressed size first when its 32-bit field is saturated.
      let found = false
      for (let field = extraStart; field < extraEnd; ) {
        if (field + 4 > extraEnd) return malformed
        const id = bytes.readUInt16LE(field)
        const length = bytes.readUInt16LE(field + 2)
        if (field + 4 + length > extraEnd) return malformed
        if (id === 1) {
          if (length < 8) return malformed
          uncompressed = bytes.readBigUInt64LE(field + 4)
          found = true
          break
        }
        field += 4 + length
      }
      if (!found) return malformed
    }
    total += uncompressed
    if (uncompressed > limit || total > limit) return exceeded
    cursor = next
  }
  return cursor === directoryEnd ? undefined : malformed
}
