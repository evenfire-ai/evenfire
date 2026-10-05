import { describe, expect, it } from 'vitest'
import { crc32, createZipWriter } from '../zipWriter'

/** Reads a STORED zip back through its end-of-central-directory record. */
function readStoredZip(archive: Uint8Array): Array<{ name: string; bytes: Uint8Array }> {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength)
  const decoder = new TextDecoder()

  // EOCD is the last structure; comment length is 0, so it is the final 22 bytes.
  const eocdOffset = archive.length - 22
  expect(view.getUint32(eocdOffset, true)).toBe(0x06054b50)
  const entryCount = view.getUint16(eocdOffset + 10, true)
  const centralDirectoryOffset = view.getUint32(eocdOffset + 16, true)

  const entries: Array<{ name: string; bytes: Uint8Array }> = []
  let cursor = centralDirectoryOffset
  for (let index = 0; index < entryCount; index += 1) {
    expect(view.getUint32(cursor, true)).toBe(0x02014b50)
    const crc = view.getUint32(cursor + 16, true)
    const size = view.getUint32(cursor + 20, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const localHeaderOffset = view.getUint32(cursor + 42, true)
    const name = decoder.decode(archive.subarray(cursor + 46, cursor + 46 + nameLength))

    expect(view.getUint32(localHeaderOffset, true)).toBe(0x04034b50)
    expect(view.getUint16(localHeaderOffset + 8, true)).toBe(0) // STORED
    const localNameLength = view.getUint16(localHeaderOffset + 26, true)
    const dataOffset = localHeaderOffset + 30 + localNameLength
    const bytes = archive.subarray(dataOffset, dataOffset + size)
    expect(bytes.length).toBe(size)
    expect(crc32(bytes)).toBe(crc)

    entries.push({ name, bytes })
    cursor += 46 + nameLength
  }
  return entries
}

function textBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

describe('crc32', () => {
  it('matches the known CRC-32 check vector', () => {
    expect(crc32(textBytes('123456789'))).toBe(0xcbf43926)
  })

  it('is empty-input stable', () => {
    expect(crc32(new Uint8Array(0))).toBe(0)
  })
})

describe('createZipWriter', () => {
  it('writes a single stored entry that reads back byte-identical', () => {
    const writer = createZipWriter()
    writer.addFile('folder/hello.txt', textBytes('hello evenfire'))
    const archive = writer.build()

    expect(readStoredZip(archive)).toEqual([
      { name: 'folder/hello.txt', bytes: textBytes('hello evenfire') },
    ])
  })

  it('writes multiple nested entries in add order', () => {
    const writer = createZipWriter()
    const payloadA = textBytes('aaa')
    const payloadB = new Uint8Array([0, 1, 2, 250, 251, 255])
    const payloadC = new Uint8Array(0)
    writer.addFile('root/b.bin', payloadB)
    writer.addFile('root/sub/deep/a.txt', payloadA)
    writer.addFile('root/empty.dat', payloadC)

    expect(writer.entryCount()).toBe(3)
    expect(readStoredZip(writer.build())).toEqual([
      { name: 'root/b.bin', bytes: payloadB },
      { name: 'root/sub/deep/a.txt', bytes: payloadA },
      { name: 'root/empty.dat', bytes: payloadC },
    ])
  })

  it('de-duplicates repeated entry names instead of colliding', () => {
    const writer = createZipWriter()
    writer.addFile('docs/plan.md', textBytes('first'))
    writer.addFile('docs/plan.md', textBytes('second'))

    const names = readStoredZip(writer.build()).map(entry => entry.name)
    expect(names).toEqual(['docs/plan.md', 'docs/plan (2).md'])
    expect(writer.has('docs/plan.md')).toBe(true)
    expect(writer.has('docs/plan (2).md')).toBe(true)
  })

  it('de-duplicates case-insensitive collisions so portable extractors never overwrite (R1-L1)', () => {
    const writer = createZipWriter()
    writer.addFile('Report.txt', textBytes('upper'))
    writer.addFile('report.txt', textBytes('lower'))
    writer.addFile('REPORT.TXT', textBytes('shout'))

    const entries = readStoredZip(writer.build())
    expect(entries.map(entry => entry.name)).toEqual([
      'Report.txt',
      'report (2).txt',
      'REPORT (3).TXT',
    ])
    // Distinct content survives the rename, byte-identical.
    const contentDecoder = new TextDecoder()
    expect(entries.map(entry => contentDecoder.decode(entry.bytes))).toEqual([
      'upper',
      'lower',
      'shout',
    ])
    expect(writer.has('report.txt')).toBe(true)
    // Case-insensitive membership: the shout-case original collides with the
    // set even though it was renamed on write.
    expect(writer.has('REPORT.TXT')).toBe(true)
    expect(writer.has('report (4).txt')).toBe(false)
  })

  it('marks names as UTF-8 in both header sets', () => {
    const writer = createZipWriter()
    writer.addFile('报告/tafel-übe.png', textBytes('x'))
    const archive = writer.build()
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength)

    const eocdOffset = archive.length - 22
    const centralDirectoryOffset = view.getUint32(eocdOffset + 16, true)
    expect(view.getUint32(centralDirectoryOffset, true)).toBe(0x02014b50)
    expect(view.getUint16(centralDirectoryOffset + 8, true) & 0x0800).toBe(0x0800)

    const localHeaderOffset = view.getUint32(centralDirectoryOffset + 42, true)
    expect(view.getUint32(localHeaderOffset, true)).toBe(0x04034b50)
    expect(view.getUint16(localHeaderOffset + 6, true) & 0x0800).toBe(0x0800)
  })

  it('produces an empty but valid archive with no entries', () => {
    const writer = createZipWriter()
    const archive = writer.build()
    expect(archive.length).toBe(22)
    expect(readStoredZip(archive)).toEqual([])
  })

  it('emits exactly the declared structure — no slack, no assembly copy (M2)', () => {
    const writer = createZipWriter()
    const a = textBytes('first-entry')
    const b = textBytes('b')
    writer.addFile('root/a.txt', a)
    writer.addFile('root/nested/b.bin', b)

    const archive = writer.build()
    // 30+name+size local records, 46+name central records, 22-byte EOCD.
    const expected =
      30 +
      'root/a.txt'.length +
      a.length +
      (30 + 'root/nested/b.bin'.length + b.length) +
      (46 + 'root/a.txt'.length) +
      (46 + 'root/nested/b.bin'.length) +
      22
    expect(archive.length).toBe(expected)
  })

  it('accepts a caller-provided capacity and keeps the same bytes', () => {
    const payload = textBytes('pre-sized payload')
    const writer = createZipWriter({ initialCapacityBytes: 1 })
    writer.addFile('docs/plan.md', payload)

    const archive = writer.build()
    expect(archive.length).toBe(
      30 + 'docs/plan.md'.length + payload.length + 46 + 'docs/plan.md'.length + 22
    )
    expect(readStoredZip(archive)).toEqual([{ name: 'docs/plan.md', bytes: payload }])
  })
})
