import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  COMPOSER_FILE_ENTRY_METADATA_BYTES,
  COMPOSER_FORWARDED_FIELDS_BYTES,
  COMPOSER_MAX_ATTACHMENTS,
  COMPOSER_MAX_FILE_BYTES,
  COMPOSER_MAX_NON_IMAGE_BODY_BYTES,
  COMPOSER_MAX_TOTAL_FILE_BASE64_BYTES,
  COMPOSER_REQUEST_ENVELOPE_BYTES,
} from '@constants/attachments'
import {
  base64Length,
  composerFileAdmissionError,
  composerFileBase64Bytes,
  composerFileDetailBytes,
  composerFileName,
  composerNonImageShareBytes,
  composerRequestBodyBytes,
  fileNameProblem,
  readComposerFile,
} from '../composerFileAdmission'
import { buildComposerFileReferences } from '../composerFileReferences'

/** UTF-8 bytes of a value as JSON.stringify writes it into the request body. */
function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length
}

/** The fixed part of the share: the envelope, the fields rpc-proxy adds, and
 *  `channelId` plus `hostRef`, both the agent `agent-1`. */
const FIXED_SHARE_BYTES =
  COMPOSER_REQUEST_ENVELOPE_BYTES + COMPOSER_FORWARDED_FIELDS_BYTES + 2 * jsonBytes('agent-1')

/** The rest of a posted request whose message text is `content`. */
function requestWithText(content = '') {
  return { content, fileReferences: [], hostRef: 'agent-1', images: [] }
}

const EMPTY_CONTEXT = { attachedCount: 0, files: [], request: requestWithText() }

function pdfBytes(): Uint8Array {
  return new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n')
}

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

describe('readComposerFile (#678)', () => {
  it('reads a PDF into base64 with the sha256 the host recomputes', async () => {
    const bytes = pdfBytes()
    const file = new File([toBuffer(bytes)], 'report.pdf', { type: 'application/pdf' })

    const result = await readComposerFile(file, 'file-1')

    expect(result.status).toBe('ready')
    if (result.status !== 'ready') throw new Error('unreachable: asserted ready above')
    expect(result.dataBase64).toBe(Buffer.from(bytes).toString('base64'))
    expect(result.digestHex).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(result.sizeBytes).toBe(bytes.byteLength)
    expect(result.declaredMediaType).toBe('application/pdf')
    expect(result.classification.class).toBe('pdf')
    expect(result.classification.mismatch).toBe(false)
  })

  it('reports a mismatch when the bytes are not what the name and type claim', async () => {
    const file = new File([toBuffer(pdfBytes())], 'notes.txt', { type: 'text/plain' })

    const result = await readComposerFile(file, 'file-2')

    if (result.status !== 'ready') throw new Error(`expected ready, got ${result.status}`)
    expect(result.classification.class).toBe('pdf')
    expect(result.classification.mismatch).toBe(true)
  })

  it('accepts a zero-byte file with the canonical empty base64', async () => {
    const result = await readComposerFile(
      new File([], 'empty.txt', { type: 'text/plain' }),
      'file-3'
    )

    if (result.status !== 'ready') throw new Error(`expected ready, got ${result.status}`)
    expect(result.dataBase64).toBe('')
    expect(result.sizeBytes).toBe(0)
    expect(result.digestHex).toBe(createHash('sha256').update(new Uint8Array(0)).digest('hex'))
  })

  it('encodes a file larger than one base64 chunk without altering it', async () => {
    const bytes = new Uint8Array(0x8000 * 3 + 5).map((_, index) => (index * 31) % 251)
    const result = await readComposerFile(new File([toBuffer(bytes)], 'blob.bin'), 'file-4')

    if (result.status !== 'ready') throw new Error(`expected ready, got ${result.status}`)
    expect(result.dataBase64).toBe(Buffer.from(bytes).toString('base64'))
    expect(result.dataBase64.length).toBe(base64Length(bytes.byteLength))
  })

  it('fails, and never sends, a file whose bytes differ in length from the reported size', async () => {
    const bytes = pdfBytes()
    const file = new File([toBuffer(bytes)], 'moving.pdf', { type: 'application/pdf' })
    Object.defineProperty(file, 'size', { value: bytes.byteLength + 7 })

    const result = await readComposerFile(file, 'file-5')

    expect(result.status).toBe('failed')
    if (result.status !== 'failed') throw new Error('unreachable: asserted failed above')
    expect(result.error).toContain('changed while it was being read')
  })

  it('fails with the read error when the file cannot be read', async () => {
    const file = new File([toBuffer(pdfBytes())], 'gone.pdf')
    Object.defineProperty(file, 'arrayBuffer', {
      value: () => Promise.reject(new Error('NotReadableError')),
    })

    const result = await readComposerFile(file, 'file-6')

    expect(result.status).toBe('failed')
    if (result.status !== 'failed') throw new Error('unreachable: asserted failed above')
    expect(result.error).toBe('gone.pdf could not be read: NotReadableError')
  })
})

describe('composerFileAdmissionError (#678)', () => {
  it('admits a file that fits every limit', () => {
    expect(composerFileAdmissionError({ name: 'a.pdf', size: 1024 }, EMPTY_CONTEXT)).toBeNull()
  })

  it('admits exactly the per-file maximum and rejects one byte more', () => {
    expect(
      composerFileAdmissionError({ name: 'a.bin', size: COMPOSER_MAX_FILE_BYTES }, EMPTY_CONTEXT)
    ).toBeNull()
    expect(
      composerFileAdmissionError(
        { name: 'a.bin', size: COMPOSER_MAX_FILE_BYTES + 1 },
        EMPTY_CONTEXT
      )
    ).toContain('a file can be at most 11.0 MiB')
  })

  it('rejects the 21st attachment and admits the 20th', () => {
    expect(
      composerFileAdmissionError(
        { name: 'a.pdf', size: 10 },
        { ...EMPTY_CONTEXT, attachedCount: COMPOSER_MAX_ATTACHMENTS - 1 }
      )
    ).toBeNull()
    expect(
      composerFileAdmissionError(
        { name: 'a.pdf', size: 10 },
        { ...EMPTY_CONTEXT, attachedCount: COMPOSER_MAX_ATTACHMENTS }
      )
    ).toContain(`at most ${COMPOSER_MAX_ATTACHMENTS} attachments`)
  })

  it('rejects a second 11 MiB file with the file quota message (#678)', () => {
    const first = { filename: 'first.bin', sizeBytes: COMPOSER_MAX_FILE_BYTES }
    // Liveness witness: the first file alone is admitted, so the rejection below
    // comes from the file quota and not from a per-file or count limit.
    expect(
      composerFileAdmissionError(
        { name: 'first.bin', size: COMPOSER_MAX_FILE_BYTES },
        EMPTY_CONTEXT
      )
    ).toBeNull()
    expect(
      composerFileAdmissionError(
        { name: 'second.bin', size: COMPOSER_MAX_FILE_BYTES },
        { attachedCount: 1, files: [first], request: requestWithText() }
      )
    ).toBe(
      'second.bin does not fit: the files in a message can take at most 16.0 MiB once encoded.'
    )
  })

  it('fills the 16 MiB file quota exactly and refuses one byte more (#678)', () => {
    const first = { filename: 'first.bin', sizeBytes: COMPOSER_MAX_FILE_BYTES }
    const context = { attachedCount: 1, files: [first], request: requestWithText() }
    // 11 MiB encodes to 15_379_116 chars; 1_048_575 B adds 1_398_100 and
    // lands on 16_777_216; 1_048_576 B adds 1_398_104.
    expect(base64Length(COMPOSER_MAX_FILE_BYTES) + base64Length(1_048_575)).toBe(
      COMPOSER_MAX_TOTAL_FILE_BASE64_BYTES
    )
    expect(composerFileAdmissionError({ name: 'fits.bin', size: 1_048_575 }, context)).toBeNull()
    expect(composerFileAdmissionError({ name: 'over.bin', size: 1_048_576 }, context)).toContain(
      'the files in a message can take at most 16.0 MiB'
    )
  })

  it('counts the message text against the 6 MiB share, not against the file quota', () => {
    const file = { name: 'a.bin', size: 1024 }
    expect(composerFileAdmissionError(file, EMPTY_CONTEXT)).toBeNull()
    expect(
      composerFileAdmissionError(file, {
        ...EMPTY_CONTEXT,
        request: requestWithText('a'.repeat(COMPOSER_MAX_NON_IMAGE_BODY_BYTES)),
      })
    ).toBe(
      'a.bin does not fit: the text and attachment details can take at most 6.0 MiB per message once encoded.'
    )
  })

  it('admits an 11 MiB file beside text that fills the 6 MiB share exactly (#678)', () => {
    const file = { name: 'big.bin', size: COMPOSER_MAX_FILE_BYTES }
    // The share holds the fixed part, the text as a JSON string (two quotes)
    // and the file's JSON name plus fixed fields; the file's base64 is credited
    // to the file quota.
    const fullShareText =
      COMPOSER_MAX_NON_IMAGE_BODY_BYTES -
      FIXED_SHARE_BYTES -
      2 -
      JSON.stringify('big.bin').length -
      COMPOSER_FILE_ENTRY_METADATA_BYTES
    expect(
      composerFileAdmissionError(file, {
        ...EMPTY_CONTEXT,
        request: requestWithText('a'.repeat(fullShareText)),
      })
    ).toBeNull()
    expect(
      composerFileAdmissionError(file, {
        ...EMPTY_CONTEXT,
        request: requestWithText('a'.repeat(fullShareText + 1)),
      })
    ).toContain('the text and attachment details can take at most 6.0 MiB')
  })

  it.each([
    ['', 'has no name'],
    ['a/b.pdf', 'has a name with "/" or control characters'],
    ['a\u0007.pdf', 'has a name with "/" or control characters'],
    ['..', 'has an invalid name'],
    ['x'.repeat(256), 'has a name longer than 255 characters'],
  ])('rejects the name %j', (name, problem) => {
    expect(fileNameProblem(name)).toBe(problem)
    expect(composerFileAdmissionError({ name, size: 1 }, EMPTY_CONTEXT)).toContain(problem)
  })

  it('composes a decomposed name at intake and still refuses one that bypassed intake', () => {
    const decomposed = 'e\u0301.txt'
    expect(composerFileName({ name: decomposed })).toBe('\u00e9.txt')
    expect(composerFileAdmissionError({ name: decomposed, size: 1 }, EMPTY_CONTEXT)).toBeNull()
    // Twin: a restored attachment carries its name as stored, with no intake.
    expect(fileNameProblem(decomposed)).toBe('has a name that is not NFC-normalized')
  })

  it('accepts a 255 code point name and a non-ASCII NFC name', () => {
    expect(fileNameProblem('x'.repeat(255))).toBeNull()
    expect(fileNameProblem('informe-ñandú.docx')).toBeNull()
  })
})

describe('composer request body accounting (#678)', () => {
  it('charges the envelope, the text and the file details, but not the file base64, to the share', () => {
    const file = { filename: 'a.pdf', sizeBytes: 1000 }
    expect(composerNonImageShareBytes({ ...requestWithText('a'.repeat(50)), files: [file] })).toBe(
      FIXED_SHARE_BYTES + 52 + JSON.stringify('a.pdf').length + COMPOSER_FILE_ENTRY_METADATA_BYTES
    )
    expect(composerFileDetailBytes(file)).toBe(
      JSON.stringify('a.pdf').length + COMPOSER_FILE_ENTRY_METADATA_BYTES
    )
  })

  it('charges the base64 of every file to the file quota', () => {
    expect(composerFileBase64Bytes([{ sizeBytes: 1000 }, { sizeBytes: 1 }, { sizeBytes: 0 }])).toBe(
      base64Length(1000) + 4
    )
  })

  it('adds the share, the file base64 and the images to size the whole body', () => {
    const files = [{ filename: 'a.pdf', sizeBytes: 1000 }]
    const request = {
      ...requestWithText('a'.repeat(50)),
      files,
      images: [{ name: 'one.png' }, { name: 'two.png' }],
    }
    // The image names and fixed fields are already in the share.
    expect(composerRequestBodyBytes(request, 8_000)).toBe(
      composerNonImageShareBytes(request) + base64Length(1000) + 8_000
    )
  })

  it('charges the text as the JSON string the request carries, escapes included (R1-H1)', () => {
    // A newline is written as two bytes (\n), plus the two quotes.
    expect(composerNonImageShareBytes({ ...requestWithText('\n'.repeat(1000)), files: [] })).toBe(
      FIXED_SHARE_BYTES + 2 * 1000 + 2
    )
    // A quote is two bytes too; a non-ASCII character keeps its UTF-8 length.
    expect(composerNonImageShareBytes({ ...requestWithText('"ñ'), files: [] })).toBe(
      FIXED_SHARE_BYTES + 2 + 2 + 2
    )
  })

  it('charges the serialized fileReferences next to the text (R1-H1)', () => {
    const fileReferences = buildComposerFileReferences(
      ['0123456789abcdef0123456789abcdef', 'fedcba9876543210fedcba9876543210'].map(
        (resourceId, index) => ({
          id: `global-file:main:${resourceId}`,
          type: 'global_file' as const,
          resourceId,
          drive: 'main',
          gfsUri: `gfs://main/${resourceId}`,
          label: `${'文'.repeat(200)}-${index}.md`,
          version: 1,
          bytes: 2048,
        })
      )
    )
    const withoutReferences = composerNonImageShareBytes({ ...requestWithText('hi'), files: [] })
    expect(
      composerNonImageShareBytes({ ...requestWithText('hi'), fileReferences, files: [] }) -
        withoutReferences
    ).toBe(new TextEncoder().encode(JSON.stringify(fileReferences)).length)
    expect(fileReferences).toHaveLength(2)
  })

  it('charges the name and fixed fields of every image to the share (R1-H1)', () => {
    const withoutImages = composerNonImageShareBytes({ ...requestWithText('hi'), files: [] })
    expect(
      composerNonImageShareBytes({
        ...requestWithText('hi'),
        files: [],
        images: [{ name: 'scan.png' }, { name: 'ñ.png' }],
      }) - withoutImages
    ).toBe(
      JSON.stringify('scan.png').length +
        JSON.stringify('ñ.png').length +
        1 +
        2 * COMPOSER_FILE_ENTRY_METADATA_BYTES
    )
  })

  it('charges the agent twice, as channelId and as hostRef (R1-H1)', () => {
    const request = { ...requestWithText('hi'), files: [] }
    expect(
      composerNonImageShareBytes({ ...request, hostRef: 'agent-12' }) -
        composerNonImageShareBytes(request)
    ).toBe(2)
  })

  it('measures a multi-byte name in UTF-8 bytes', () => {
    const ascii = composerFileDetailBytes({ filename: 'aaaa.txt' })
    const accented = composerFileDetailBytes({ filename: 'ññññ.txt' })
    expect(accented - ascii).toBe(4)
  })
})
