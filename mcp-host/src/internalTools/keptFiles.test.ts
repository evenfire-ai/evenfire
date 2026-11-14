// The secret scan of every file saved to GFS from the Host volume: decided
// from the bytes alone, it refuses only on a secret found, and every other
// outcome (including its own failure) is an upload reported as not scanned.
import { afterEach, describe, expect, it, vi } from 'vitest'
import JSZip from 'jszip'
import { gzipSync } from 'node:zlib'
import { GFS_FILE_LIMITS } from './gfsFilePolicy'
import {
  SCAN_CHUNK_CHARS,
  SCAN_OVERLAP_CHARS,
  SCAN_TEXT_MAX_BYTES,
  scanFileForSecrets,
  scanForSecrets,
} from './keptFiles'

// Both readers pass through unless a test makes one throw; the counters are
// the witnesses that the scan reached them.
const readers = vi.hoisted(() => ({
  officeThrows: false,
  officeCalls: 0,
  formatThrows: false,
  formatCalls: 0,
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
    isNonTextFormat: (bytes: Uint8Array) => {
      readers.formatCalls++
      if (readers.formatThrows) throw new Error('forced format check failure')
      return actual.isNonTextFormat(bytes)
    },
  }
})

const SYNTHETIC = 'synthetic-scan-probe-value'
const entries = [{ name: 'PROBE', value: SYNTHETIC }]
const NON_ASCII = 'contraseña-Ünico-2026'
const nonAscii = [{ name: 'PASS', value: NON_ASCII }]
const NUM = [{ name: 'NUM', value: '98765432' }]
const FOUND = { state: 'secret_found' }
const SCANNED = { state: 'scanned' }
const BINARY = { state: 'not_scanned', reason: 'binary_format' }
const TOO_LARGE = { state: 'not_scanned', reason: 'too_large_to_scan' }

/**
 * A value split by markdown emphasis, which the printed forms take out of any
 * text: only the text matcher can find it, not the byte search.
 */
const split = (value: string) => `${value.slice(0, 10)}**${value.slice(10, 15)}**${value.slice(15)}`
const holdsBytes = (bytes: Buffer, value: string) => bytes.includes(Buffer.from(value, 'utf8'))
const line = (value: string) => `2026-11-12 run ok, value ${value} stored\n`
const latin1 = (text: string) => Buffer.from(text, 'latin1')

afterEach(() => {
  readers.officeThrows = false
  readers.officeCalls = 0
  readers.formatThrows = false
  readers.formatCalls = 0
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

/** `length` bytes from a fixed generator, each at least `min` (1 keeps out 0x00). */
function seeded(length: number, min = 0): Buffer {
  const out = Buffer.alloc(length)
  let state = 0x2545f491
  for (let index = 0; index < length; index++) {
    state = (state * 1103515245 + 12345) >>> 0
    out[index] = min + ((state >>> 16) % (256 - min))
  }
  return out
}

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
      'an encrypted Office file (a compound file, not a zip) with no readable value',
      () =>
        Buffer.concat([
          Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
          seeded(512, 1),
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

  it('does not read bytes that start like a PDF as text, and finds a value in clear in them', () => {
    const body = `BT (${split(SYNTHETIC)}) Tj ET\n`
    const pdf = Buffer.from(`%PDF-1.7\n${body}`)
    expect(holdsBytes(pdf, SYNTHETIC)).toBe(false)
    expect(scanForSecrets(pdf, entries)).toEqual(BINARY)
    // The same bytes without the header line are text holding the entry.
    expect(scanForSecrets(Buffer.from(body), entries)).toEqual(FOUND)
    // A value in clear behind the header is found in the bytes.
    expect(scanForSecrets(Buffer.from(`%PDF-1.7\nBT (${SYNTHETIC}) Tj ET\n`), entries)).toEqual(
      FOUND
    )
  })

  it('matches text up to 4 MiB and does not classify one byte more', () => {
    const tail = ` ${split(SYNTHETIC)}\n`
    const exact = Buffer.alloc(SCAN_TEXT_MAX_BYTES, 0x61)
    exact.write(tail, SCAN_TEXT_MAX_BYTES - tail.length)
    expect(holdsBytes(exact, SYNTHETIC)).toBe(false)
    expect(scanForSecrets(exact, entries)).toEqual(FOUND)
    expect(readers.formatCalls).toBe(1)

    const over = Buffer.concat([Buffer.from('a'), exact])
    expect(over.length).toBe(SCAN_TEXT_MAX_BYTES + 1)
    expect(scanForSecrets(over, entries)).toEqual(TOO_LARGE)
    expect(readers.formatCalls).toBe(1)
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
    // Deflated, the value is not in the package's bytes: only the package
    // reader can find it. The media part is xorshift noise, which deflate
    // cannot shrink below 4 MiB.
    const noise = Buffer.alloc(5 * 1024 * 1024)
    let state = 0x2545f491
    for (let index = 0; index < noise.length; index++) {
      state ^= state << 13
      state ^= state >>> 17
      state ^= state << 5
      noise[index] = state & 0xff
    }
    const bigDocx = await docx(`id ${SYNTHETIC}`, { 'word/media/noise.bin': noise })
    expect(bigDocx.length).toBeGreaterThan(SCAN_TEXT_MAX_BYTES)
    expect(holdsBytes(bigDocx, SYNTHETIC)).toBe(false)
    expect(scanForSecrets(bigDocx, entries)).toEqual({ state: 'secret_found' })
    expect(readers.officeCalls).toBe(1)
  }, 30_000)

  it('refuses a stored package whose write time holds a value, and passes the same package deflated', async () => {
    const created = {
      'docProps/core.xml': '<dcterms:created>2026-11-14T10:00:00Z</dcterms:created>',
    }
    const stamp = [{ name: 'STAMP', value: '2026-11-14T10' }]
    expect(scanForSecrets(await docx('nothing', created, true), stamp)).toEqual(FOUND)
    // Witness: deflated, the bytes do not hold the value and the package
    // reader exempts write times.
    const deflated = await docx('nothing', created)
    expect(holdsBytes(deflated, '2026-11-14T10')).toBe(false)
    expect(scanForSecrets(deflated, stamp)).toEqual(SCANNED)
    expect(readers.officeCalls).toBe(1)
  })

  it('reports its own failure as not scanned instead of throwing', async () => {
    readers.officeThrows = true
    const clean = await docx('nothing here')
    expect(scanForSecrets(clean, entries)).toEqual({ state: 'not_scanned', reason: 'scan_error' })
    expect(readers.officeCalls).toBe(1)

    readers.formatCalls = 0
    readers.formatThrows = true
    expect(scanForSecrets(Buffer.from('plain text\n'), entries)).toEqual({
      state: 'not_scanned',
      reason: 'scan_error',
    })
    expect(readers.formatCalls).toBe(1)
  })

  it('reads nothing inside a package when there are no entries, but still tells binary from text', async () => {
    expect(scanForSecrets(Buffer.from(SYNTHETIC), [])).toEqual({ state: 'scanned' })
    expect(scanForSecrets(await docx(SYNTHETIC), [])).toEqual({ state: 'scanned' })
    expect(readers.officeCalls).toBe(0)
    expect(scanForSecrets(PNG, [])).toEqual({ state: 'not_scanned', reason: 'binary_format' })
  })

  it('does not search a file above the GFS file limit for bytes', async () => {
    const over = Buffer.alloc(GFS_FILE_LIMITS.maxFileBytes + 1, 0x61)
    over.write(SYNTHETIC, 100)
    expect(scanForSecrets(over, entries)).toEqual(TOO_LARGE)
    // Witness: the same bytes one byte shorter are searched.
    expect(scanForSecrets(over.subarray(1), entries)).toEqual(FOUND)
  }, 60_000)

  it('never refuses a file for an entry with an empty value', () => {
    const empty = [{ name: 'EMPTY', value: '' }]
    expect(scanForSecrets(Buffer.from('plain text'), empty)).toEqual(SCANNED)
    expect(scanForSecrets(PNG, empty)).toEqual(BINARY)
    // Witnesses: a value of four characters that the same kinds of file hold
    // is found, in text and in binary data.
    expect(scanForSecrets(Buffer.from('plain text'), [{ name: 'E', value: 'text' }])).toEqual(FOUND)
    const random = Buffer.concat([seeded(256), Buffer.from('abcd'), seeded(256)])
    expect(scanForSecrets(random, [{ name: 'E', value: 'abcd' }])).toEqual(FOUND)
  })

  it('does not search for a value shorter than four characters', () => {
    const bytes = latin1('caf\xe9 abcd')
    expect(scanForSecrets(bytes, [{ name: 'SHORT', value: 'abc' }])).toEqual(BINARY)
    expect(scanForSecrets(Buffer.from('abc abc\n'), [{ name: 'SHORT', value: 'abc' }])).toEqual(
      SCANNED
    )
    // Witness: the same bytes with a value of four characters are refused.
    expect(scanForSecrets(bytes, [{ name: 'FOUR', value: 'abcd' }])).toEqual(FOUND)
  })
})

// Every file is searched for the bytes of each value. A file with no zero byte
// and no binary signature is also matched as text: as UTF-8 or, when its bytes
// are not UTF-8, as Latin-1. Only UTF-8 text can be `scanned`.
describe('scanForSecrets on files that are not plain UTF-8 text', () => {
  const utf16be = (text: string) => Buffer.from(text, 'utf16le').swap16()

  it.each([
    ['ANSI colour', (v: string) => `\x1b[32m${line(v)}\x1b[0m`],
    ['a form feed', (v: string) => `page one\f${line(v)}`],
    ['a control character', (v: string) => `\x01${line(v)}`],
  ])('finds a value in UTF-8 text with %s, and scans it clean', (_label, make) => {
    expect(scanForSecrets(Buffer.from(make(SYNTHETIC)), entries)).toEqual(FOUND)
    expect(scanForSecrets(Buffer.from(make('nothing')), entries)).toEqual(SCANNED)
  })

  it('finds a value written in Latin-1, and never calls Latin-1 text scanned', () => {
    const text = (v: string) => latin1(`caf\xe9 \xff ${line(v)}`)
    expect(scanForSecrets(text(SYNTHETIC), entries)).toEqual(FOUND)
    // The file holds the value's Latin-1 bytes, not its UTF-8 bytes.
    expect(holdsBytes(text(NON_ASCII), NON_ASCII)).toBe(false)
    expect(scanForSecrets(text(NON_ASCII), nonAscii)).toEqual(FOUND)
    expect(scanForSecrets(text('nothing'), entries)).toEqual(BINARY)
    expect(scanForSecrets(text('nothing'), nonAscii)).toEqual(BINARY)
    expect(scanForSecrets(text('nothing'), [])).toEqual(BINARY)
  })

  it('finds a value split by markup and a separated number in Latin-1 text', () => {
    const marked = latin1(`caf\xe9 \xff ${line(split(SYNTHETIC))}`)
    expect(holdsBytes(marked, SYNTHETIC)).toBe(false)
    expect(scanForSecrets(marked, entries)).toEqual(FOUND)
    const number = latin1('caf\xe9 card 98.765.432 end\n')
    expect(holdsBytes(number, '98765432')).toBe(false)
    expect(scanForSecrets(number, NUM)).toEqual(FOUND)
  })

  it.each([
    ['UTF-16LE with a byte order mark', (t: string) => Buffer.from(`﻿${t}`, 'utf16le')],
    ['UTF-16BE with a byte order mark', (t: string) => utf16be(`﻿${t}`)],
    ['UTF-16LE without a byte order mark', (t: string) => Buffer.from(t, 'utf16le')],
    ['UTF-16BE without a byte order mark', (t: string) => utf16be(t)],
  ])(
    'does not read %s: a value written in it is not found and the file is not scanned',
    (_label, make) => {
      expect(scanForSecrets(make(line(SYNTHETIC)), entries)).toEqual(BINARY)
      expect(scanForSecrets(make(line('nothing')), entries)).toEqual(BINARY)
      expect(scanForSecrets(make(line('nothing')), [])).toEqual(BINARY)
    }
  )

  it.each([100, 101])(
    'finds a value in clear in text with one stray zero byte, and does not call it scanned (padding %i)',
    pad => {
      const stray = (value: string) => {
        const text = Buffer.from(`${'x'.repeat(pad)} ${line(value)}`)
        const odd = text.length % 2 ? Buffer.concat([text, Buffer.from('y')]) : text
        odd[pad] = 0
        return odd
      }
      expect(scanForSecrets(stray(SYNTHETIC), entries)).toEqual(FOUND)
      expect(scanForSecrets(stray('nothing'), entries)).toEqual(BINARY)
      expect(scanForSecrets(stray('nothing'), [])).toEqual(BINARY)
    }
  )

  it('reads UTF-8 with one invalid byte as Latin-1: an ASCII split value is found, a non-ASCII one is not', () => {
    const shape = (v: string) =>
      Buffer.concat([Buffer.from('header '), Buffer.from([0xff]), Buffer.from(` ${line(v)}`)])
    expect(scanForSecrets(shape(NON_ASCII), nonAscii)).toEqual(FOUND)
    expect(holdsBytes(shape(split(SYNTHETIC)), SYNTHETIC)).toBe(false)
    expect(scanForSecrets(shape(split(SYNTHETIC)), entries)).toEqual(FOUND)
    // The stated limit: split by markup, the UTF-8 bytes of a non-ASCII value
    // read as Latin-1 do not spell it. Witness: the same value whole is found.
    expect(scanForSecrets(shape(split(NON_ASCII)), nonAscii)).toEqual(BINARY)
    expect(scanForSecrets(Buffer.from(line(split(NON_ASCII))), nonAscii)).toEqual(FOUND)
    for (const e of [nonAscii, entries, []])
      expect(scanForSecrets(shape('nothing'), e)).toEqual(BINARY)
  })

  it('finds an ASCII split value in UTF-8 cut in the middle of a character', () => {
    const cut = Buffer.from(`key: ${split(SYNTHETIC)} ñ`).subarray(0, -1)
    expect(scanForSecrets(cut, entries)).toEqual(FOUND)
  })

  it('does not read a file with a zero byte or a binary signature as Latin-1', () => {
    const text = latin1(`caf\xe9 log ${line(split(SYNTHETIC))}`)
    const zero = Buffer.from(text)
    zero[2] = 0
    expect(scanForSecrets(zero, entries)).toEqual(BINARY)
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), text])
    expect(scanForSecrets(pdf, entries)).toEqual(BINARY)
    // Witness: the same Latin-1 bytes without the zero byte or the header line.
    expect(scanForSecrets(text, entries)).toEqual(FOUND)
  })

  it('finds a value in clear in every file, whatever its bytes', () => {
    const zero = Buffer.from(`log ${line(SYNTHETIC)}`)
    zero[1] = 0
    expect(scanForSecrets(zero, entries)).toEqual(FOUND)
    const pdf = latin1(`%PDF-1.7\ncaf\xe9 ${line(SYNTHETIC)}`)
    expect(scanForSecrets(pdf, entries)).toEqual(FOUND)
    const samples = Buffer.alloc(4096)
    for (let index = 0; index < 2048; index++) samples[index * 2] = 1 + (index % 255)
    expect(scanForSecrets(Buffer.concat([samples, Buffer.from(SYNTHETIC)]), entries)).toEqual(FOUND)
    expect(scanForSecrets(samples, entries)).toEqual(BINARY)
  })

  it('does not call short binary data with no zero byte scanned, and still finds a value in it', () => {
    const binary = seeded(512, 1)
    expect(scanForSecrets(binary, entries)).toEqual(BINARY)
    expect(scanForSecrets(binary, [])).toEqual(BINARY)
    const withValue = Buffer.concat([binary.subarray(0, 200), Buffer.from(SYNTHETIC), binary])
    expect(scanForSecrets(withValue, entries)).toEqual(FOUND)
  })

  it('does not find a value written in UTF-16 after CJK text', () => {
    const cjk = Buffer.from(`${'漢字テキスト'.repeat(40)}${SYNTHETIC}`, 'utf16le')
    expect(scanForSecrets(cjk, entries)).toEqual(BINARY)
  })

  it('does not read binary formats as text, and finds a value in clear in one', async () => {
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]),
      seeded(4096),
    ])
    for (const bytes of [
      jpeg,
      gzipSync(Buffer.from(line(SYNTHETIC))),
      seeded(64 * 1024),
      PNG,
      Buffer.from(`%PDF-1.7\n${line('nothing')}`),
    ]) {
      expect(scanForSecrets(bytes, entries)).toEqual(BINARY)
      expect(scanForSecrets(bytes, [])).toEqual(BINARY)
    }
    expect(scanForSecrets(Buffer.from(`%PDF-1.7\n${line(SYNTHETIC)}`), entries)).toEqual(FOUND)
  })

  it('calls only UTF-8 text scanned when the Host has no values', () => {
    expect(scanForSecrets(Buffer.from(`\x1b[1m${line('a')}`), [])).toEqual(SCANNED)
    expect(scanForSecrets(Buffer.from(`caf\xe9 ${line('a')}`, 'latin1'), [])).toEqual(BINARY)
    expect(scanForSecrets(Buffer.from(`﻿${line('a')}`, 'utf16le'), [])).toEqual(BINARY)
  })

  it('finds a value in clear after a UTF-16 head at every alignment, and does not call the file scanned', () => {
    const tail = Buffer.from(` ${line(SYNTHETIC)}`)
    for (const head of [
      Buffer.from('a'.repeat(80_000), 'utf16le'),
      // 64 KiB: the tail starts on a block boundary.
      Buffer.from('a'.repeat(32_768), 'utf16le'),
    ]) {
      for (const pad of [0, 1]) {
        const withValue = Buffer.concat([head, Buffer.alloc(pad, 0x20), tail])
        expect(scanForSecrets(withValue, entries)).toEqual(FOUND)
      }
      const value = 'contraseña-Ünico-2026'
      const utf8Tail = Buffer.from(` key ${value} end`)
      expect(scanForSecrets(Buffer.concat([head, utf8Tail]), [{ name: 'PASS', value }])).toEqual(
        FOUND
      )
      expect(scanForSecrets(Buffer.concat([head, Buffer.from(' clean tail ')]), entries)).toEqual(
        BINARY
      )
      const longTail = Buffer.concat([head, Buffer.from('t'.repeat(70_000))])
      expect(scanForSecrets(longTail, entries)).toEqual(BINARY)
    }
  })

  it('does not call UTF-16 scanned, and finds only a value written in clear after it', () => {
    const head = Buffer.from('a'.repeat(80_000), 'utf16le')
    expect(scanForSecrets(Buffer.concat([head, Buffer.from(` ${SYNTHETIC} `)]), entries)).toEqual(
      FOUND
    )
    expect(scanForSecrets(Buffer.concat([head, Buffer.from(' clean tail ')]), entries)).toEqual(
      BINARY
    )
    expect(scanForSecrets(Buffer.from(`﻿${line(SYNTHETIC)}`, 'utf16le'), entries)).toEqual(BINARY)
    expect(scanForSecrets(Buffer.from(`﻿${line('nothing')}`, 'utf16le'), [])).toEqual(BINARY)
  })

  it('never calls 16-bit binary samples scanned', () => {
    const samples = Buffer.alloc(4096)
    for (let index = 0; index < 2048; index++) samples[index * 2] = 1 + (index % 255)
    const withValue = Buffer.concat([samples, Buffer.from(SYNTHETIC.padEnd(26, ' '))])
    expect(scanForSecrets(withValue, entries)).toEqual(FOUND)
    expect(scanForSecrets(samples, entries)).toEqual(BINARY)
  })

  it('finds only what Latin-1 spells in legacy-encoded text, and never calls it scanned', () => {
    // Windows-1252: euro sign 0x80, curly quotes 0x93 and 0x94.
    const cp1252 = (value: Buffer) =>
      Buffer.concat([Buffer.from('price '), Buffer.from([0x80, 0x93]), Buffer.from(' key '), value])
    const euroValue = '€uro“key”-2026'
    const euro = [{ name: 'EURO', value: euroValue }]
    const encodedEuro = Buffer.from([
      0x80,
      ...Buffer.from('uro'),
      0x93,
      ...Buffer.from('key'),
      0x94,
      ...Buffer.from('-2026'),
    ])
    expect(scanForSecrets(cp1252(encodedEuro), euro)).toEqual(BINARY)
    expect(scanForSecrets(cp1252(Buffer.from(SYNTHETIC)), entries)).toEqual(FOUND)
    const marked = cp1252(Buffer.from(split(SYNTHETIC)))
    expect(holdsBytes(marked, SYNTHETIC)).toBe(false)
    expect(scanForSecrets(marked, entries)).toEqual(FOUND)
    expect(scanForSecrets(cp1252(Buffer.from('nothing')), entries)).toEqual(BINARY)
    // Shift_JIS: パスワード.
    const sjis = Buffer.from([0x83, 0x70, 0x83, 0x58, 0x83, 0x8f, 0x81, 0x5b, 0x83, 0x68])
    const japanese = [{ name: 'JP', value: 'パスワード-2026' }]
    const sjisText = (value: Buffer) =>
      Buffer.concat([Buffer.from('id '), value, Buffer.from('-2026\n')])
    expect(scanForSecrets(sjisText(sjis), japanese)).toEqual(BINARY)
    expect(
      scanForSecrets(Buffer.concat([sjisText(sjis), Buffer.from(SYNTHETIC)]), entries)
    ).toEqual(FOUND)
  })
})

// Above 4 MiB, up to the GFS file limit, the file is searched for bytes and its
// text, UTF-8 or the Latin-1 reading, is matched in overlapping windows between
// other tasks.
describe('scanFileForSecrets on large text', () => {
  const MIB = 1024 * 1024
  const SIZE = 6 * MIB
  const FILLER = 'col_a,col_b,"quoted, value",<b>bold</b> [label](http://example.test/x) note\n'
  const STRIDE = SCAN_CHUNK_CHARS - SCAN_OVERLAP_CHARS
  const windowEnd = (k: number) => k * STRIDE + SCAN_CHUNK_CHARS

  /** SIZE characters of filler with `insert` written at `at`. */
  function text(insert = '', at = 0, size = SIZE): string {
    const base = FILLER.repeat(Math.ceil(size / FILLER.length)).slice(0, size)
    return base.slice(0, at) + insert + base.slice(at + insert.length)
  }
  /** The same text as Latin-1 bytes that are not UTF-8: one byte per character. */
  function latin1Text(insert = '', at = 0): Buffer {
    const bytes = Buffer.from(text(insert, at), 'latin1')
    Buffer.from('\x1b[31mcaf\xe9\x1b[0m ', 'latin1').copy(bytes, 0)
    return bytes
  }
  /** The same text as UTF-8 with one invalid byte. */
  function brokenUtf8(insert = '', at = 0): Buffer {
    const bytes = Buffer.from(text(insert, at))
    bytes[100] = 0xff
    return bytes
  }

  it('finds a split value in the middle of a window', async () => {
    const bytes = Buffer.from(text(split(SYNTHETIC), windowEnd(3) - SCAN_CHUNK_CHARS / 2))
    expect(holdsBytes(bytes, SYNTHETIC)).toBe(false)
    expect(await scanFileForSecrets(bytes, entries)).toEqual(FOUND)
  }, 60_000)

  it.each([0, 1, 2])(
    'finds a split value that straddles the end of window %i',
    async k => {
      const bytes = Buffer.from(text(split(SYNTHETIC), windowEnd(k) - 8))
      expect(holdsBytes(bytes, SYNTHETIC)).toBe(false)
      expect(await scanFileForSecrets(bytes, entries)).toEqual(FOUND)
    },
    60_000
  )

  it('finds a value split by markup across a window end', async () => {
    const split = `${SYNTHETIC.slice(0, 10)}<b>${SYNTHETIC.slice(10)}`
    const bytes = Buffer.from(text(split, windowEnd(1) - 8))
    expect(await scanFileForSecrets(bytes, entries)).toEqual(FOUND)
  }, 60_000)

  it('finds a number written with separators across a window end', async () => {
    const bytes = Buffer.from(text(' 98.765.432 ', windowEnd(0) - 6))
    expect(await scanFileForSecrets(bytes, [{ name: 'NUM', value: '98765432' }])).toEqual(FOUND)
  }, 60_000)

  it('finds a split value right after a surrogate pair that sits on a window end', async () => {
    const bytes = Buffer.from(text(`\u{1F600}${split(SYNTHETIC)}`, windowEnd(0) - 1))
    expect(holdsBytes(bytes, SYNTHETIC)).toBe(false)
    expect(await scanFileForSecrets(bytes, entries)).toEqual(FOUND)
  }, 60_000)

  it('finds a split value in the last, short window, and scans clean text to the end', async () => {
    const marked = split(SYNTHETIC)
    const last = Buffer.from(text(marked, SIZE - marked.length - 1))
    expect(holdsBytes(last, SYNTHETIC)).toBe(false)
    expect(await scanFileForSecrets(last, entries)).toEqual(FOUND)
    expect(await scanFileForSecrets(Buffer.from(text()), entries)).toEqual(SCANNED)
    expect(await scanFileForSecrets(Buffer.from(text()), [])).toEqual(SCANNED)
  }, 60_000)

  it('finds a split value in large Latin-1 text with ANSI colour, in the windows', async () => {
    const marked = split(SYNTHETIC)
    for (const at of [windowEnd(0) - 8, windowEnd(2) - 8, SIZE - marked.length - 1]) {
      const bytes = latin1Text(marked, at)
      expect(holdsBytes(bytes, SYNTHETIC)).toBe(false)
      expect(await scanFileForSecrets(bytes, entries)).toEqual(FOUND)
    }
    const number = latin1Text(' 98.765.432 ', windowEnd(0) - 6)
    expect(holdsBytes(number, '98765432')).toBe(false)
    expect(await scanFileForSecrets(number, NUM)).toEqual(FOUND)
  }, 120_000)

  it('reads large UTF-8 text with one invalid byte as Latin-1: an ASCII split value is found across a window end, a non-ASCII one is not', async () => {
    const ascii = brokenUtf8(split(SYNTHETIC), windowEnd(0) - 8)
    expect(holdsBytes(ascii, SYNTHETIC)).toBe(false)
    expect(await scanFileForSecrets(ascii, entries)).toEqual(FOUND)
    // The stated limit, and its witness: the same value whole, at the same place.
    const at = windowEnd(0) - 8
    expect(await scanFileForSecrets(brokenUtf8(split(NON_ASCII), at), nonAscii)).toEqual(BINARY)
    expect(await scanFileForSecrets(brokenUtf8(NON_ASCII, at), nonAscii)).toEqual(FOUND)
  }, 120_000)

  it('never calls large text that is not UTF-8 scanned', async () => {
    const long = [{ name: 'LONG', value: 'k'.repeat(SCAN_OVERLAP_CHARS + 1) }]
    for (const e of [entries, long, []]) {
      expect(await scanFileForSecrets(latin1Text(), e)).toEqual(BINARY)
      expect(await scanFileForSecrets(brokenUtf8(), e)).toEqual(BINARY)
    }
    // Witness that the long entry is what makes clean UTF-8 text too large.
    expect(await scanFileForSecrets(Buffer.from(text()), long)).toEqual(TOO_LARGE)
  }, 120_000)

  it('finds a value in clear in large binary data, and does not read it as text', async () => {
    expect(await scanFileForSecrets(seeded(SIZE), entries)).toEqual(BINARY)
    const pdf = (body: Buffer) => Buffer.concat([Buffer.from('%PDF-1.7\n'), body])
    expect(await scanFileForSecrets(pdf(Buffer.from(text(SYNTHETIC, MIB))), entries)).toEqual(FOUND)
    const stray = (body: Buffer) => {
      body[100] = 0
      return body
    }
    expect(await scanFileForSecrets(stray(Buffer.from(text(SYNTHETIC, MIB))), entries)).toEqual(
      FOUND
    )
    // A split value behind a signature or a zero byte is not read as text.
    const marked = split(SYNTHETIC)
    expect(await scanFileForSecrets(pdf(latin1Text(marked, MIB)), entries)).toEqual(BINARY)
    expect(await scanFileForSecrets(stray(latin1Text(marked, MIB)), entries)).toEqual(BINARY)
    // Witness: the same Latin-1 bytes alone.
    expect(await scanFileForSecrets(latin1Text(marked, MIB), entries)).toEqual(FOUND)
  }, 120_000)

  it('does not scan a file above the GFS file limit', async () => {
    const over = Buffer.alloc(GFS_FILE_LIMITS.maxFileBytes + 1, 0x61)
    expect(await scanFileForSecrets(over, entries)).toEqual({
      state: 'not_scanned',
      reason: 'too_large_to_scan',
    })
  }, 60_000)

  it('misses a value split by more than the overlap of markup: the stated limit', async () => {
    const far = (gap: number) =>
      `${SYNTHETIC.slice(0, 10)}<b title="${'m'.repeat(gap)}">${SYNTHETIC.slice(10)}`
    // Placed so that no window holds both halves: it starts 96 KiB before a
    // window's end and reaches past the start of the next one.
    const at = windowEnd(4) - 96 * 1024
    expect(await scanFileForSecrets(Buffer.from(text(far(100 * 1024), at)), entries)).toEqual(
      SCANNED
    )
    // Witness: the same halves 1 KiB apart, at the same place, are found.
    const near = Buffer.from(text(far(1024), at))
    expect(holdsBytes(near, SYNTHETIC)).toBe(false)
    expect(await scanFileForSecrets(near, entries)).toEqual(FOUND)
    // Within 4 MiB the whole-text pass finds the far split.
    expect(scanForSecrets(Buffer.from(text(far(100 * 1024), MIB, 3 * MIB)), entries)).toEqual(FOUND)
    // In text that is not UTF-8 the same far split is not found either, and the
    // file is not scanned.
    expect(await scanFileForSecrets(latin1Text(far(100 * 1024), at), entries)).toEqual(BINARY)
  }, 120_000)

  it('reports a value longer than the overlap as too large to scan in large UTF-8 text', async () => {
    const long = [{ name: 'LONG', value: 'k'.repeat(SCAN_OVERLAP_CHARS + 1) }]
    expect(await scanFileForSecrets(Buffer.from(text()), long)).toEqual({
      state: 'not_scanned',
      reason: 'too_large_to_scan',
    })
  }, 60_000)

  it('finds a value in clear after a large UTF-16 head', async () => {
    const head = Buffer.from('a'.repeat((5 * MIB) / 2), 'utf16le')
    const withValue = Buffer.concat([head, Buffer.from(` ${SYNTHETIC} tail `)])
    expect(await scanFileForSecrets(withValue, entries)).toEqual(FOUND)
    expect(
      await scanFileForSecrets(Buffer.concat([head, Buffer.from(' clean tail ')]), entries)
    ).toEqual(BINARY)
  }, 60_000)

  it('does not read 5 MiB of UTF-16: a value written in it is not found and the file is not scanned', async () => {
    const utf16 = (insert: string) =>
      Buffer.from(`﻿${text(insert, 2 * MIB, (5 * MIB) / 2)}`, 'utf16le')
    expect(utf16(SYNTHETIC).length).toBeGreaterThan(SCAN_TEXT_MAX_BYTES)
    expect(await scanFileForSecrets(utf16(SYNTHETIC), entries)).toEqual(BINARY)
    expect(await scanFileForSecrets(utf16(''), entries)).toEqual(BINARY)
  }, 60_000)

  it('reads a package above the GFS file limit with the package reader only', async () => {
    const noise = Buffer.from(
      Array.from({ length: GFS_FILE_LIMITS.maxFileBytes }, (_, i) => (i * 7919) % 251)
    )
    const big = await docx(
      'nothing here',
      { 'word/media/noise.bin': Buffer.concat([noise, Buffer.from(SYNTHETIC)]) },
      true
    )
    expect(big.length).toBeGreaterThan(GFS_FILE_LIMITS.maxFileBytes)
    expect(holdsBytes(big, SYNTHETIC)).toBe(true)
    expect(await scanFileForSecrets(big, entries)).toEqual(SCANNED)
    expect(readers.officeCalls).toBe(1)
    // Witness: the same part in a package within the limit is found by bytes.
    const small = await docx(
      'nothing here',
      { 'word/media/noise.bin': Buffer.concat([noise.subarray(0, 4096), Buffer.from(SYNTHETIC)]) },
      true
    )
    expect(await scanFileForSecrets(small, entries)).toEqual(FOUND)
  }, 120_000)

  it('lets other tasks run between windows', async () => {
    let ticks = 0
    let running = true
    const tick = () => {
      ticks += 1
      if (running) setImmediate(tick)
    }
    let ranFirst = false
    setImmediate(() => {
      ranFirst = true
    })
    setImmediate(tick)
    const scanning = scanFileForSecrets(Buffer.from(text()), entries)
    const result = await scanning
    running = false
    expect(result).toEqual({ state: 'scanned' })
    expect(ranFirst).toBe(true)
    expect(ticks).toBeGreaterThanOrEqual(Math.floor(SIZE / STRIDE))
  }, 60_000)
})
