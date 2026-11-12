// The secret scan of every file saved to GFS from the Host volume: decided
// from the bytes alone, it refuses only on a secret found, and every other
// outcome (including its own failure) is an upload reported as not scanned.
import { afterEach, describe, expect, it, vi } from 'vitest'
import JSZip from 'jszip'
import { SCAN_TEXT_MAX_BYTES, scanForSecrets } from './keptFiles'

// Both readers pass through unless a test makes one throw; the counters are
// the witnesses that the scan reached them.
const readers = vi.hoisted(() => ({
  officeThrows: false,
  officeCalls: 0,
  decodeThrows: false,
  decodeCalls: 0,
}))
vi.mock('../artifacts/officePackageText', async original => {
  const actual = await original<typeof import('../artifacts/officePackageText')>()
  return {
    ...actual,
    officePackageHasText: (...args: Parameters<typeof actual.officePackageHasText>) => {
      readers.officeCalls++
      if (readers.officeThrows) throw new Error('forced office reader failure')
      return actual.officePackageHasText(...args)
    },
  }
})
vi.mock('./textContent', async original => {
  const actual = await original<typeof import('./textContent')>()
  return {
    ...actual,
    decodeTextContent: (bytes: Uint8Array) => {
      readers.decodeCalls++
      if (readers.decodeThrows) throw new Error('forced decode failure')
      return actual.decodeTextContent(bytes)
    },
  }
})

const SYNTHETIC = 'synthetic-scan-probe-value'
const entries = [{ name: 'PROBE', value: SYNTHETIC }]

afterEach(() => {
  readers.officeThrows = false
  readers.officeCalls = 0
  readers.decodeThrows = false
  readers.decodeCalls = 0
})

function zip(parts: Record<string, string | Buffer>, store = false): Promise<Buffer> {
  const z = new JSZip()
  for (const [name, data] of Object.entries(parts)) z.file(name, data)
  return z.generateAsync({ type: 'nodebuffer', compression: store ? 'STORE' : 'DEFLATE' })
}

function docx(text: string, extra: Record<string, string | Buffer> = {}, store = false) {
  return zip(
    {
      '[Content_Types].xml': '<Types/>',
      'word/document.xml': `<w:document><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
      ...extra,
    },
    store
  )
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])

describe('scanForSecrets', () => {
  it('finds an entry in text, and passes the same text without it', () => {
    expect(scanForSecrets(Buffer.from(`token: ${SYNTHETIC}\n`), entries)).toEqual({
      state: 'secret_found',
    })
    expect(scanForSecrets(Buffer.from('token: none\n'), entries)).toEqual({ state: 'scanned' })
  })

  it('finds an entry split by markup through the printed forms of the text', () => {
    const split = Buffer.from('key: synthetic-scan-**probe**-value\n')
    expect(split.toString('utf8')).not.toContain(SYNTHETIC)
    expect(scanForSecrets(split, entries)).toEqual({ state: 'secret_found' })
  })

  it('reads an Office package part by part and passes a clean one', async () => {
    expect(scanForSecrets(await docx(`id ${SYNTHETIC}`), entries)).toEqual({
      state: 'secret_found',
    })
    expect(scanForSecrets(await docx('nothing here'), entries)).toEqual({ state: 'scanned' })
    expect(readers.officeCalls).toBe(2)
  })

  it.each([
    ['an empty file', () => Buffer.alloc(0), { state: 'not_scanned', reason: 'empty_file' }],
    [
      'a plain zip',
      () => zip({ 'notes.txt': SYNTHETIC }),
      { state: 'not_scanned', reason: 'binary_format' },
    ],
    ['an image', () => PNG, { state: 'not_scanned', reason: 'binary_format' }],
    [
      'Latin-1 text',
      () => Buffer.from(`caf\xe9 ${SYNTHETIC}`, 'latin1'),
      { state: 'not_scanned', reason: 'binary_format' },
    ],
    [
      'UTF-16 text',
      () => Buffer.from(`﻿${SYNTHETIC}`, 'utf16le'),
      { state: 'not_scanned', reason: 'binary_format' },
    ],
    [
      'an encrypted Office file (a compound file, not a zip)',
      () =>
        Buffer.concat([
          Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
          Buffer.from(SYNTHETIC),
        ]),
      { state: 'not_scanned', reason: 'binary_format' },
    ],
    [
      'a truncated package with no central directory',
      async () => {
        const whole = await docx(SYNTHETIC)
        return whole.subarray(0, whole.length - 40)
      },
      { state: 'not_scanned', reason: 'binary_format' },
    ],
    [
      'a package whose entries exceed the limit',
      async () => {
        const parts: Record<string, string> = { '[Content_Types].xml': '<Types/>' }
        for (let n = 0; n < 4100; n++) parts[`p/${n}.xml`] = '<a/>'
        return zip(parts, true)
      },
      { state: 'not_scanned', reason: 'binary_format' },
    ],
    [
      'a package with a corrupt part',
      async () => {
        const good = await docx(`text ${SYNTHETIC} and more text to compress well well well`)
        const out = Buffer.from(good)
        // Corrupt the deflated data of the document part.
        const at = out.indexOf(Buffer.from('word/document.xml')) + 'word/document.xml'.length
        for (let i = at; i < at + 12 && i < out.length; i++) out[i] = 0xff
        return out
      },
      { state: 'not_scanned', reason: 'office_package_unreadable' },
    ],
    [
      'a sheet with a formula',
      () =>
        zip({
          '[Content_Types].xml': '<Types/>',
          'xl/worksheets/sheet1.xml': '<sheetData><c r="A1"><f>1+1</f><v>2</v></c></sheetData>',
        }),
      { state: 'not_scanned', reason: 'office_package_unreadable' },
    ],
  ] as const)('uploads %s as not scanned', async (_label, make, expected) => {
    expect(scanForSecrets(await make(), entries)).toEqual(expected)
  })

  it('does not inflate a package past the limit and reports it unreadable', async () => {
    const big = await docx('x', { 'word/media/big.xml': Buffer.alloc(70 * 1024 * 1024, 0x61) })
    expect(big.length).toBeLessThan(SCAN_TEXT_MAX_BYTES)
    expect(scanForSecrets(big, entries)).toEqual({
      state: 'not_scanned',
      reason: 'office_package_unreadable',
    })
    // Building and compressing 70 MiB takes seconds on a loaded runner.
  }, 30_000)

  it('never decodes bytes that start like a PDF as text', () => {
    const body = `BT (${SYNTHETIC}) Tj ET\n`
    expect(scanForSecrets(Buffer.from(`%PDF-1.7\n${body}`), entries)).toEqual({
      state: 'not_scanned',
      reason: 'binary_format',
    })
    // The same bytes without the header line are text holding the entry.
    expect(scanForSecrets(Buffer.from(body), entries)).toEqual({ state: 'secret_found' })
  })

  it('reads text up to 4 MiB and does not decode one byte more', () => {
    const tail = ` ${SYNTHETIC}\n`
    const exact = Buffer.alloc(SCAN_TEXT_MAX_BYTES, 0x61)
    exact.write(tail, SCAN_TEXT_MAX_BYTES - tail.length)
    expect(scanForSecrets(exact, entries)).toEqual({ state: 'secret_found' })
    expect(readers.decodeCalls).toBe(1)

    const over = Buffer.concat([Buffer.from('a'), exact])
    expect(over.length).toBe(SCAN_TEXT_MAX_BYTES + 1)
    expect(scanForSecrets(over, entries)).toEqual({
      state: 'not_scanned',
      reason: 'too_large_to_scan',
    })
    expect(readers.decodeCalls).toBe(1)
  })

  it('reports any large file that is not an Office package as too large, and still reads a large package', async () => {
    const bigPng = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)])
    expect(scanForSecrets(bigPng, entries)).toEqual({
      state: 'not_scanned',
      reason: 'too_large_to_scan',
    })
    const smallPng = Buffer.concat([PNG, Buffer.alloc(1024 * 1024)])
    expect(scanForSecrets(smallPng, entries)).toEqual({
      state: 'not_scanned',
      reason: 'binary_format',
    })
    const filler = Buffer.from(Array.from({ length: 5 * 1024 * 1024 }, (_, i) => (i * 7919) % 251))
    const bigDocx = await docx(`id ${SYNTHETIC}`, { 'word/media/noise.bin': filler }, true)
    expect(bigDocx.length).toBeGreaterThan(SCAN_TEXT_MAX_BYTES)
    expect(scanForSecrets(bigDocx, entries)).toEqual({ state: 'secret_found' })
    expect(readers.officeCalls).toBe(1)
  }, 30_000)

  it('reports its own failure as not scanned instead of throwing', async () => {
    readers.officeThrows = true
    expect(scanForSecrets(await docx(SYNTHETIC), entries)).toEqual({
      state: 'not_scanned',
      reason: 'scan_error',
    })
    expect(readers.officeCalls).toBe(1)

    readers.decodeCalls = 0
    readers.decodeThrows = true
    expect(scanForSecrets(Buffer.from(SYNTHETIC), entries)).toEqual({
      state: 'not_scanned',
      reason: 'scan_error',
    })
    expect(readers.decodeCalls).toBe(1)
  })

  it('reads nothing inside a package when there are no entries, but still tells binary from text', async () => {
    expect(scanForSecrets(Buffer.from(SYNTHETIC), [])).toEqual({ state: 'scanned' })
    expect(scanForSecrets(await docx(SYNTHETIC), [])).toEqual({ state: 'scanned' })
    expect(readers.officeCalls).toBe(0)
    expect(scanForSecrets(PNG, [])).toEqual({ state: 'not_scanned', reason: 'binary_format' })
  })
})
