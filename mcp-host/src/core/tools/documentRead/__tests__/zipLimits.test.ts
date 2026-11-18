/**
 * zach88 R1-L5 — the declared-expansion check that reads a workbook's ZIP
 * central directory before JSZip opens it. Every rejection is pinned on a
 * crafted variant of an archive JSZip reads, so each result comes from the one
 * field the variant changes.
 */
import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { checkZipExpansion } from '../zipLimits'

const END_SIGNATURE = Buffer.from([0x50, 0x4b, 0x05, 0x06])
const MALFORMED = { ok: false, reason: 'document_parse_failed' }
const EXCEEDED = { ok: false, reason: 'document_limits_exceeded', limit: 'uncompressed_bytes' }
/** Well above the 300 bytes the default archive declares. */
const LIMIT = 1_000_000

/**
 * Two STORED entries of 100 and 200 bytes. STORED data are the entries' own
 * text, so no data byte can look like a ZIP record signature.
 */
async function archive(
  entries: Record<string, string> = { 'first.txt': 'a'.repeat(100), 'second.txt': 'b'.repeat(200) }
): Promise<Buffer> {
  const zip = new JSZip()
  for (const [name, text] of Object.entries(entries)) zip.file(name, text)
  return zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' })
}

/** The last end record and the central entries it lists, as JSZip finds them. */
function layout(bytes: Buffer): { end: number; entries: number[] } {
  const end = bytes.lastIndexOf(END_SIGNATURE)
  const entries: number[] = []
  for (let at = bytes.readUInt32LE(end + 16); at < end; ) {
    entries.push(at)
    at +=
      46 + bytes.readUInt16LE(at + 28) + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32)
  }
  return { end, entries }
}

/** The entry names JSZip loads: the readable control of every variant. */
async function names(bytes: Buffer): Promise<string[]> {
  return Object.keys((await JSZip.loadAsync(bytes)).files).sort()
}

/**
 * Appends `extra` to the extra field of central entry `index`. `saturate`
 * sets its 32-bit uncompressed size to 0xffffffff, which defers the size to a
 * ZIP64 extra field.
 */
function withExtra(bytes: Buffer, index: number, extra: Buffer, saturate = true): Buffer {
  const { end, entries } = layout(bytes)
  const entry = entries[index]!
  const at = entry + 46 + bytes.readUInt16LE(entry + 28) + bytes.readUInt16LE(entry + 30)
  const result = Buffer.concat([bytes.subarray(0, at), extra, bytes.subarray(at)])
  result.writeUInt16LE(bytes.readUInt16LE(entry + 30) + extra.length, entry + 30)
  if (saturate) result.writeUInt32LE(0xffff_ffff, entry + 24)
  result.writeUInt32LE(bytes.readUInt32LE(end + 12) + extra.length, end + extra.length + 12)
  return result
}

/** A ZIP64 extended-information field; `length` below 8 leaves no room for the size. */
function zip64Field(uncompressed: bigint, length = 8): Buffer {
  const field = Buffer.alloc(4 + length)
  field.writeUInt16LE(1, 0)
  field.writeUInt16LE(length, 2)
  if (length >= 8) field.writeBigUInt64LE(uncompressed, 4)
  return field
}

/** An extra field of another kind (ID 0xcafe), skipped by a ZIP64 reader. */
const OTHER_FIELD = Buffer.from([0xfe, 0xca, 0x02, 0x00, 0x01, 0x02])

/**
 * The same archive with a ZIP64 end record and locator before its end record,
 * which then saturates `field`, so a reader must take the ZIP64 values.
 */
function zip64End(bytes: Buffer, field: 'count' | 'size' | 'offset' = 'count'): Buffer {
  const { end, entries } = layout(bytes)
  const record = Buffer.alloc(56)
  record.writeUInt32LE(0x0606_4b50, 0)
  record.writeBigUInt64LE(44n, 4)
  record.writeUInt16LE(45, 12)
  record.writeUInt16LE(45, 14)
  record.writeBigUInt64LE(BigInt(entries.length), 24)
  record.writeBigUInt64LE(BigInt(entries.length), 32)
  record.writeBigUInt64LE(BigInt(bytes.readUInt32LE(end + 12)), 40)
  record.writeBigUInt64LE(BigInt(bytes.readUInt32LE(end + 16)), 48)
  const locator = Buffer.alloc(20)
  locator.writeUInt32LE(0x0706_4b50, 0)
  locator.writeBigUInt64LE(BigInt(end), 8)
  locator.writeUInt32LE(1, 16)
  const tail = Buffer.from(bytes.subarray(end))
  if (field === 'count') {
    tail.writeUInt16LE(0xffff, 8)
    tail.writeUInt16LE(0xffff, 10)
  }
  if (field === 'size') tail.writeUInt32LE(0xffff_ffff, 12)
  if (field === 'offset') tail.writeUInt32LE(0xffff_ffff, 16)
  return Buffer.concat([bytes.subarray(0, end), record, locator, tail])
}

/** The ZIP64 locator and record of a `zip64End` archive. */
function zip64Layout(bytes: Buffer): { locator: number; record: number } {
  const locator = bytes.lastIndexOf(END_SIGNATURE) - 20
  return { locator, record: Number(bytes.readBigUInt64LE(locator + 8)) }
}

/**
 * `bytes` moved to start at `shift` in a larger file: its directory offset and
 * every local-header offset are rebased, so the archive is consistent there.
 */
function rebased(bytes: Buffer, shift: number): Buffer {
  const result = Buffer.from(bytes)
  const { end, entries } = layout(bytes)
  for (const entry of entries) {
    result.writeUInt32LE(bytes.readUInt32LE(entry + 42) + shift, entry + 42)
  }
  result.writeUInt32LE(bytes.readUInt32LE(end + 16) + shift, end + 16)
  return result
}

type Variant = (bytes: Buffer) => Buffer

describe('checkZipExpansion declared sizes', () => {
  it('accepts an archive JSZip reads up to exactly its declared total, and not one byte below', async () => {
    const bytes = await archive()
    expect(await names(bytes)).toEqual(['first.txt', 'second.txt'])
    expect(checkZipExpansion(bytes, LIMIT)).toBeUndefined()
    expect(checkZipExpansion(bytes, 300)).toBeUndefined()
    // Each entry fits 299 bytes; only their sum does not.
    expect(checkZipExpansion(bytes, 299)).toEqual(EXCEEDED)
  })

  it('accepts an empty archive JSZip reads', async () => {
    const bytes = await archive({})
    expect(await names(bytes)).toEqual([])
    expect(checkZipExpansion(bytes, LIMIT)).toBeUndefined()
  })

  it('reads a ZIP64 size after another extra field and bounds it, above safe integers too', async () => {
    const bytes = await archive()
    const declared = (size: bigint) =>
      withExtra(withExtra(bytes, 0, OTHER_FIELD, false), 0, zip64Field(size))
    // Control: the true size in a ZIP64 field after a field of another kind.
    const honest = declared(100n)
    expect(await names(honest)).toEqual(['first.txt', 'second.txt'])
    expect(checkZipExpansion(honest, 300)).toBeUndefined()
    expect(checkZipExpansion(honest, 299)).toEqual(EXCEEDED)
    expect(checkZipExpansion(declared(1n << 54n), LIMIT)).toEqual(EXCEEDED)
  })
})

describe('checkZipExpansion refuses a malformed end record', () => {
  it('accepts a comment that ends the file and refuses a byte after it', async () => {
    const bytes = await archive()
    const { end } = layout(bytes)
    const commented = Buffer.concat([bytes, Buffer.from('note')])
    commented.writeUInt16LE(4, end + 20)
    expect(await names(commented)).toEqual(['first.txt', 'second.txt'])
    expect(checkZipExpansion(commented, LIMIT)).toBeUndefined()
    expect(checkZipExpansion(Buffer.concat([commented, Buffer.from([0])]), LIMIT)).toEqual(
      MALFORMED
    )
  })

  const endRecord = (write: (bytes: Buffer, end: number) => void): Variant => {
    return bytes => {
      write(bytes, layout(bytes).end)
      return bytes
    }
  }
  it.each<[string, Variant]>([
    ['no end record', bytes => bytes.subarray(0, layout(bytes).end)],
    ['an end record cut short', bytes => bytes.subarray(0, layout(bytes).end + 21)],
    ['a comment longer than the file', endRecord((bytes, end) => bytes.writeUInt16LE(1, end + 20))],
    ['another disk number', endRecord((bytes, end) => bytes.writeUInt16LE(1, end + 4))],
    ['its directory on another disk', endRecord((bytes, end) => bytes.writeUInt16LE(1, end + 6))],
    [
      'fewer entries on this disk than in all',
      endRecord((bytes, end) => bytes.writeUInt16LE(1, end + 8)),
    ],
    [
      'a directory size that does not end at the end record',
      endRecord((bytes, end) => bytes.writeUInt32LE(bytes.readUInt32LE(end + 12) - 1, end + 12)),
    ],
    [
      'a directory offset that does not end at the end record',
      endRecord((bytes, end) => bytes.writeUInt32LE(bytes.readUInt32LE(end + 16) + 1, end + 16)),
    ],
  ])('%s', async (_label, variant) => {
    const bytes = await archive()
    expect(checkZipExpansion(bytes, LIMIT)).toBeUndefined()
    expect(checkZipExpansion(variant(Buffer.from(bytes)), LIMIT)).toEqual(MALFORMED)
  })
})

describe('checkZipExpansion refuses a malformed central directory', () => {
  const entry = (index: number, write: (bytes: Buffer, at: number) => void): Variant => {
    return bytes => {
      write(bytes, layout(bytes).entries[index]!)
      return bytes
    }
  }
  const counts = (count: number): Variant => {
    return bytes => {
      const { end } = layout(bytes)
      bytes.writeUInt16LE(count, end + 8)
      bytes.writeUInt16LE(count, end + 10)
      return bytes
    }
  }
  it.each<[string, Variant]>([
    ['an entry without the central signature', entry(1, (bytes, at) => bytes.writeUInt32LE(0, at))],
    [
      'an entry whose name runs past the directory',
      entry(1, (bytes, at) => bytes.writeUInt16LE(bytes.readUInt16LE(at + 28) + 1, at + 28)),
    ],
    [
      // Malformed before its size is trusted: the size alone would read as exceeded.
      'an entry that runs past the directory and declares 2 GiB',
      entry(1, (bytes, at) => {
        bytes.writeUInt16LE(bytes.readUInt16LE(at + 28) + 1, at + 28)
        bytes.writeUInt32LE(0x7fff_ffff, at + 24)
      }),
    ],
    [
      'an entry that starts on another disk',
      entry(0, (bytes, at) => bytes.writeUInt16LE(1, at + 34)),
    ],
    ['fewer entries than the directory holds', counts(1)],
    ['more entries than the directory can hold', counts(3)],
    [
      // Refused by the count before the walk trusts the first entry's size.
      'more entries than the directory can hold, the first declaring 2 GiB',
      bytes =>
        counts(3)(entry(0, (written, at) => written.writeUInt32LE(0x7fff_ffff, at + 24))(bytes)),
    ],
  ])('%s', async (_label, variant) => {
    const bytes = await archive()
    expect(checkZipExpansion(bytes, LIMIT)).toBeUndefined()
    expect(checkZipExpansion(variant(Buffer.from(bytes)), LIMIT)).toEqual(MALFORMED)
  })

  // Long names make a directory large enough for a third 46-byte entry by
  // size alone, so only the walk can tell that the third entry is missing.
  const longNames = () =>
    archive({ [`${'n'.repeat(80)}.txt`]: 'a', [`${'m'.repeat(80)}.txt`]: 'b' })

  it('finds a missing entry by walking a directory large enough for the count', async () => {
    const bytes = await longNames()
    expect(checkZipExpansion(bytes, LIMIT)).toBeUndefined()
    expect(checkZipExpansion(counts(3)(Buffer.from(bytes)), LIMIT)).toEqual(MALFORMED)
  })

  it('refuses a central signature too close to the directory end to hold an entry', async () => {
    // A bare signature as the directory's last four bytes: its fields would
    // lie past the end of the file, so it is malformed, not a read error.
    const bytes = await longNames()
    expect(checkZipExpansion(bytes, LIMIT)).toBeUndefined()
    const { end } = layout(bytes)
    const stub = Buffer.concat([
      bytes.subarray(0, end),
      Buffer.from([0x50, 0x4b, 0x01, 0x02]),
      bytes.subarray(end),
    ])
    const stubEnd = end + 4
    stub.writeUInt16LE(3, stubEnd + 8)
    stub.writeUInt16LE(3, stubEnd + 10)
    stub.writeUInt32LE(bytes.readUInt32LE(end + 12) + 4, stubEnd + 12)
    expect(checkZipExpansion(stub, LIMIT)).toEqual(MALFORMED)
  })
})

describe('checkZipExpansion refuses a malformed ZIP64 size', () => {
  it.each<[string, Buffer]>([
    ['a saturated size with no extra field', Buffer.alloc(0)],
    ['a saturated size with only another kind of field', OTHER_FIELD],
    ['a ZIP64 field too short for the size', zip64Field(0n, 4)],
    ['an extra field header cut short', Buffer.from([0x01, 0x00])],
    ['an extra field longer than the extra', Buffer.from([0xfe, 0xca, 0x64, 0x00, 0x01, 0x02])],
    // Its size would be read from the four bytes after the extra.
    [
      'a ZIP64 field that runs past the extra',
      Buffer.from([0x01, 0x00, 0x08, 0x00, 0x64, 0, 0, 0]),
    ],
  ])('%s', async (_label, extra) => {
    const bytes = await archive()
    // Control: the same entry with a complete ZIP64 size field.
    expect(checkZipExpansion(withExtra(bytes, 0, zip64Field(100n)), LIMIT)).toBeUndefined()
    expect(checkZipExpansion(withExtra(bytes, 0, extra), LIMIT)).toEqual(MALFORMED)
  })
})

describe('checkZipExpansion reads a ZIP64 end record', () => {
  it.each(['count', 'size', 'offset'] as const)(
    'takes the directory from the ZIP64 record when the end record saturates its %s',
    async field => {
      const bytes = zip64End(await archive(), field)
      expect(await names(bytes)).toEqual(['first.txt', 'second.txt'])
      expect(checkZipExpansion(bytes, 300)).toBeUndefined()
      expect(checkZipExpansion(bytes, 299)).toEqual(EXCEEDED)
    }
  )

  it('refuses a saturated end record with no room for a locator', () => {
    const bytes = Buffer.alloc(22)
    END_SIGNATURE.copy(bytes)
    bytes.writeUInt16LE(0xffff, 8)
    bytes.writeUInt16LE(0xffff, 10)
    expect(checkZipExpansion(bytes, LIMIT)).toEqual(MALFORMED)
  })

  const locator = (write: (bytes: Buffer, at: number) => void): Variant => {
    return bytes => {
      write(bytes, zip64Layout(bytes).locator)
      return bytes
    }
  }
  const record = (write: (bytes: Buffer, at: number) => void): Variant => {
    return bytes => {
      write(bytes, zip64Layout(bytes).record)
      return bytes
    }
  }
  it.each<[string, Variant]>([
    ['a locator without its signature', locator((bytes, at) => bytes.writeUInt32LE(0, at))],
    [
      'a record on another disk per the locator',
      locator((bytes, at) => bytes.writeUInt32LE(1, at + 4)),
    ],
    ['a locator that counts two disks', locator((bytes, at) => bytes.writeUInt32LE(2, at + 16))],
    [
      'a record offset too close to the locator',
      locator((bytes, at) => bytes.writeBigUInt64LE(BigInt(at - 55), at + 8)),
    ],
    [
      'a record offset beyond the file',
      locator((bytes, at) => bytes.writeBigUInt64LE(1n << 63n, at + 8)),
    ],
    ['a record without its signature', record((bytes, at) => bytes.writeUInt32LE(0, at))],
    ['a record size below 44', record((bytes, at) => bytes.writeBigUInt64LE(43n, at + 4))],
    [
      'a record that does not end at the locator',
      record((bytes, at) => bytes.writeBigUInt64LE(45n, at + 4)),
    ],
    ['a record on another disk', record((bytes, at) => bytes.writeUInt32LE(1, at + 16))],
    ['a record directory on another disk', record((bytes, at) => bytes.writeUInt32LE(1, at + 20))],
    [
      'fewer record entries on this disk than in all',
      record((bytes, at) => bytes.writeBigUInt64LE(1n, at + 24)),
    ],
    [
      'a record directory size that does not end at the record',
      record((bytes, at) => bytes.writeBigUInt64LE(bytes.readBigUInt64LE(at + 40) + 1n, at + 40)),
    ],
    [
      'a record count its directory cannot hold',
      record((bytes, at) => {
        bytes.writeBigUInt64LE(1n << 40n, at + 24)
        bytes.writeBigUInt64LE(1n << 40n, at + 32)
      }),
    ],
  ])('%s', async (_label, variant) => {
    const bytes = zip64End(await archive())
    expect(checkZipExpansion(bytes, LIMIT)).toBeUndefined()
    expect(checkZipExpansion(variant(Buffer.from(bytes)), LIMIT)).toEqual(MALFORMED)
  })
})

describe('checkZipExpansion checks the directory JSZip loads', () => {
  it('reads the last end record, as JSZip does, not an earlier valid one', async () => {
    // The first archive is valid and small. Its end-record comment spans a
    // second archive whose only entry declares 2 GiB, rebased so its last
    // end record is consistent where it stands. Both end records are well
    // formed, so only the choice of record decides the answer.
    const first = await archive({ 'benign.txt': 'small' })
    const second = await archive({ 'declared.bin': 'c'.repeat(10) })
    second.writeUInt32LE(0x7fff_ffff, layout(second).entries[0]! + 24)
    const prefix = Buffer.from(first)
    prefix.writeUInt16LE(second.length, layout(first).end + 20)
    const combined = Buffer.concat([prefix, rebased(second, prefix.length)])
    // Witness: JSZip opens the last end record's directory.
    expect(await names(combined)).toEqual(['declared.bin'])
    expect(checkZipExpansion(combined, LIMIT)).toEqual(EXCEEDED)
    // Control: the first archive alone is accepted.
    expect(await names(first)).toEqual(['benign.txt'])
    expect(checkZipExpansion(first, LIMIT)).toBeUndefined()
  })
})
