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

// Text the display rule refuses (control characters, a legacy encoding, UTF-16)
// is still searched before a save. The verdict says `scanned` only when one
// reading is the file as it was written; a value found in any reading refuses.
describe('scanForSecrets on text the display rule refuses', () => {
  const NON_ASCII = 'contraseña-Ünico-2026'
  const nonAscii = [{ name: 'PASS', value: NON_ASCII }]
  const FOUND = { state: 'secret_found' }
  const SCANNED = { state: 'scanned' }
  const BINARY = { state: 'not_scanned', reason: 'binary_format' }
  const utf16be = (text: string) => Buffer.from(text, 'utf16le').swap16()
  const line = (value: string) => `2026-11-12 run ok, value ${value} stored\n`

  it.each([
    ['ANSI colour', (v: string) => `\x1b[32m${line(v)}\x1b[0m`],
    ['a form feed', (v: string) => `page one\f${line(v)}`],
    ['a control character', (v: string) => `\x01${line(v)}`],
  ])('finds a value in UTF-8 text with %s, and scans it clean', (_label, make) => {
    expect(scanForSecrets(Buffer.from(make(SYNTHETIC)), entries)).toEqual(FOUND)
    expect(scanForSecrets(Buffer.from(make('nothing')), entries)).toEqual(SCANNED)
  })

  it('finds a value in Latin-1 text, and scans it clean when every value is ASCII', () => {
    const latin1 = (v: string) => Buffer.from(`caf\xe9 \xff ${line(v)}`, 'latin1')
    expect(scanForSecrets(latin1(SYNTHETIC), entries)).toEqual(FOUND)
    expect(scanForSecrets(latin1(NON_ASCII), nonAscii)).toEqual(FOUND)
    expect(scanForSecrets(latin1('nothing'), entries)).toEqual(SCANNED)
    // A non-ASCII value may be spelled otherwise in the file's real encoding.
    expect(scanForSecrets(latin1('nothing'), nonAscii)).toEqual(BINARY)
  })

  it.each([
    ['UTF-16LE with a byte order mark', (t: string) => Buffer.from(`﻿${t}`, 'utf16le')],
    ['UTF-16BE with a byte order mark', (t: string) => utf16be(`﻿${t}`)],
    ['UTF-16LE without a byte order mark', (t: string) => Buffer.from(t, 'utf16le')],
    ['UTF-16BE without a byte order mark', (t: string) => utf16be(t)],
  ])('finds a value in %s, and scans it clean', (_label, make) => {
    expect(scanForSecrets(make(line(SYNTHETIC)), entries)).toEqual(FOUND)
    expect(scanForSecrets(make(line('nothing')), entries)).toEqual(SCANNED)
    expect(scanForSecrets(make(line('nothing')), [])).toEqual(SCANNED)
  })

  it.each([100, 101])(
    'does not read ASCII text with one stray zero byte as UTF-16 (padding %i)',
    pad => {
      const text = Buffer.from(`${'x'.repeat(pad)} ${line(SYNTHETIC)}`)
      const odd = text.length % 2 ? Buffer.concat([text, Buffer.from('y')]) : text
      odd[pad] = 0
      expect(scanForSecrets(odd, entries)).toEqual(BINARY)
      expect(scanForSecrets(odd, [])).toEqual(BINARY)
    }
  )

  it('finds a non-ASCII value in UTF-8 text with one invalid byte', () => {
    const shape = (v: string) =>
      Buffer.concat([Buffer.from('header '), Buffer.from([0xff]), Buffer.from(` ${line(v)}`)])
    expect(scanForSecrets(shape(NON_ASCII), nonAscii)).toEqual(FOUND)
    expect(scanForSecrets(shape('nothing'), nonAscii)).toEqual(BINARY)
    expect(scanForSecrets(shape('nothing'), entries)).toEqual(SCANNED)
    expect(scanForSecrets(shape('nothing'), [])).toEqual(SCANNED)
  })

  it('does not call short binary data with no zero byte scanned, and still finds a value in it', () => {
    const binary = seeded(512, 1)
    expect(scanForSecrets(binary, entries)).toEqual(BINARY)
    expect(scanForSecrets(binary, [])).toEqual(BINARY)
    const withValue = Buffer.concat([binary.subarray(0, 200), Buffer.from(SYNTHETIC), binary])
    expect(scanForSecrets(withValue, entries)).toEqual(FOUND)
  })

  it('does not read BOM-less UTF-16 of CJK text, whose zero bytes are too few', () => {
    const cjk = Buffer.from(`${'漢字テキスト'.repeat(40)}${SYNTHETIC}`, 'utf16le')
    expect(scanForSecrets(cjk, entries)).toEqual(BINARY)
  })

  it('keeps binary formats unread', async () => {
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]),
      seeded(4096),
    ])
    for (const bytes of [
      jpeg,
      gzipSync(Buffer.from(line(SYNTHETIC))),
      seeded(64 * 1024),
      PNG,
      Buffer.from(`%PDF-1.7\n${line(SYNTHETIC)}`),
    ]) {
      expect(scanForSecrets(bytes, entries)).toEqual(BINARY)
      expect(scanForSecrets(bytes, [])).toEqual(BINARY)
    }
  })

  it('scans every new text shape as written when the Host has no values', () => {
    for (const bytes of [
      Buffer.from(`\x1b[1m${line('a')}`),
      Buffer.from(`caf\xe9 ${line('a')}`, 'latin1'),
      Buffer.from(`﻿${line('a')}`, 'utf16le'),
    ])
      expect(scanForSecrets(bytes, [])).toEqual(SCANNED)
  })

  it('never calls a UTF-16 head with a text tail scanned while missing the tail', () => {
    const head = Buffer.from('a'.repeat(80_000), 'utf16le')
    const tail = Buffer.from(` ${line(SYNTHETIC)}`)
    const withValue = Buffer.concat([
      head,
      tail.length % 2 ? Buffer.concat([tail, Buffer.from(' ')]) : tail,
    ])
    expect(scanForSecrets(withValue, entries)).not.toEqual(SCANNED)
    expect([FOUND, BINARY]).toContainEqual(scanForSecrets(withValue, entries))
    // A non-ASCII value in a UTF-8 tail that shares the last 64 KiB block with
    // the UTF-16 head is found in the UTF-8 reading.
    const value = 'contraseña-Ünico-2026'
    let utf8Tail = Buffer.from(` key ${value} end`)
    if (utf8Tail.length % 2) utf8Tail = Buffer.concat([utf8Tail, Buffer.from(' ')])
    expect(scanForSecrets(Buffer.concat([head, utf8Tail]), [{ name: 'PASS', value }])).toEqual(
      FOUND
    )
    // The clean file shows zero bytes at one parity in every block and decodes
    // as UTF-16 with no control character, so it is read as UTF-16; nothing is
    // found in any reading: scanned.
    const clean = Buffer.concat([head, Buffer.from(' clean tail ')])
    expect(scanForSecrets(clean, entries)).toEqual(SCANNED)
    // A tail longer than a block shows no zero bytes there: not read as UTF-16.
    const longTail = Buffer.concat([head, Buffer.from('t'.repeat(70_000))])
    expect(scanForSecrets(longTail, entries)).toEqual(BINARY)
  })

  it('never calls 16-bit binary samples scanned', () => {
    const samples = Buffer.alloc(4096)
    for (let index = 0; index < 2048; index++) samples[index * 2] = 1 + (index % 255)
    const withValue = Buffer.concat([samples, Buffer.from(SYNTHETIC.padEnd(26, ' '))])
    expect(scanForSecrets(withValue, entries)).not.toEqual(SCANNED)
    expect(scanForSecrets(samples, entries)).toEqual(BINARY)
  })

  it('does not call legacy-encoded text scanned when a value is not ASCII', () => {
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

// Text above 4 MiB, up to the GFS file limit, is read in overlapping windows
// between other tasks.
describe('scanFileForSecrets on large text', () => {
  const MIB = 1024 * 1024
  const SIZE = 6 * MIB
  const FILLER = 'col_a,col_b,"quoted, value",<b>bold</b> [label](http://example.test/x) note\n'
  const STRIDE = SCAN_CHUNK_CHARS - SCAN_OVERLAP_CHARS
  const FOUND = { state: 'secret_found' }
  const BINARY = { state: 'not_scanned', reason: 'binary_format' }
  const windowEnd = (k: number) => k * STRIDE + SCAN_CHUNK_CHARS

  /** SIZE characters of filler with `insert` written at `at`. */
  function text(insert = '', at = 0, size = SIZE): string {
    const base = FILLER.repeat(Math.ceil(size / FILLER.length)).slice(0, size)
    return base.slice(0, at) + insert + base.slice(at + insert.length)
  }

  it('finds a value in the middle of a window', async () => {
    const bytes = Buffer.from(text(SYNTHETIC, windowEnd(3) - SCAN_CHUNK_CHARS / 2))
    expect(await scanFileForSecrets(bytes, entries)).toEqual(FOUND)
  }, 60_000)

  it.each([0, 1, 2])(
    'finds a value that straddles the end of window %i',
    async k => {
      const bytes = Buffer.from(text(SYNTHETIC, windowEnd(k) - 10))
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

  it('finds a value right after a surrogate pair that sits on a window end', async () => {
    const bytes = Buffer.from(text(`\u{1F600}${SYNTHETIC}`, windowEnd(0) - 1))
    expect(await scanFileForSecrets(bytes, entries)).toEqual(FOUND)
  }, 60_000)

  it('finds a value in the last, short window, and scans clean text to the end', async () => {
    const last = Buffer.from(text(SYNTHETIC, SIZE - SYNTHETIC.length - 1))
    expect(await scanFileForSecrets(last, entries)).toEqual(FOUND)
    expect(await scanFileForSecrets(Buffer.from(text()), entries)).toEqual({ state: 'scanned' })
    expect(await scanFileForSecrets(Buffer.from(text()), [])).toEqual({ state: 'scanned' })
  }, 60_000)

  it('finds a value in large text with ANSI colour and Latin-1 bytes', async () => {
    const latin1 = Buffer.from(`\x1b[31mcaf\xe9\x1b[0m ${text(SYNTHETIC, 3 * MIB)}`, 'latin1')
    expect(await scanFileForSecrets(latin1, entries)).toEqual(FOUND)
  }, 60_000)

  it('finds a non-ASCII value across a window end in large UTF-8 text with one invalid byte', async () => {
    const value = 'contraseña-Ünico-2026'
    const head = 'h'.repeat(100)
    // Decoded, the invalid byte is one character, so the value starts 10
    // characters before the end of the first window.
    const rest = text(value, windowEnd(0) - 10 - head.length - 1, SIZE)
    const bytes = Buffer.concat([Buffer.from(head), Buffer.from([0xff]), Buffer.from(rest)])
    expect(await scanFileForSecrets(bytes, [{ name: 'PASS', value }])).toEqual(FOUND)
  }, 60_000)

  it('keeps large binary data unread, and says why', async () => {
    expect(await scanFileForSecrets(seeded(SIZE), entries)).toEqual(BINARY)
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from(text(SYNTHETIC, MIB))])
    expect(await scanFileForSecrets(pdf, entries)).toEqual(BINARY)
    const stray = Buffer.from(text(SYNTHETIC, MIB))
    stray[100] = 0
    expect(await scanFileForSecrets(stray, entries)).toEqual(BINARY)
  }, 60_000)

  it('does not scan a file above the GFS file limit', async () => {
    const over = Buffer.alloc(GFS_FILE_LIMITS.maxFileBytes + 1, 0x61)
    expect(await scanFileForSecrets(over, entries)).toEqual({
      state: 'not_scanned',
      reason: 'too_large_to_scan',
    })
  }, 60_000)

  it('misses a value split by more than the overlap of markup: the stated limit', async () => {
    const split = `${SYNTHETIC.slice(0, 10)}<b title="${'m'.repeat(100 * 1024)}">${SYNTHETIC.slice(10)}`
    // Placed so that no window holds both halves: it starts 96 KiB before a
    // window's end and reaches past the start of the next one.
    const bytes = Buffer.from(text(split, windowEnd(4) - 96 * 1024))
    expect(await scanFileForSecrets(bytes, entries)).toEqual({ state: 'scanned' })
    // Within 4 MiB the whole-text pass finds the same split value.
    expect(scanForSecrets(Buffer.from(text(split, MIB, 3 * MIB)), entries)).toEqual(FOUND)
  }, 60_000)

  it('reports a value longer than the overlap as too large to scan in large text', async () => {
    const long = [{ name: 'LONG', value: 'k'.repeat(SCAN_OVERLAP_CHARS + 1) }]
    expect(await scanFileForSecrets(Buffer.from(text()), long)).toEqual({
      state: 'not_scanned',
      reason: 'too_large_to_scan',
    })
  }, 60_000)

  it('never calls a large UTF-16 head with a text tail scanned', async () => {
    const head = Buffer.from('a'.repeat((5 * MIB) / 2), 'utf16le')
    const withValue = Buffer.concat([head, Buffer.from(` ${SYNTHETIC} tail `)])
    expect([FOUND, BINARY]).toContainEqual(await scanFileForSecrets(withValue, entries))
  }, 60_000)

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
