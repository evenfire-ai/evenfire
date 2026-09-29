import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  COMPOSER_FILE_ENTRY_METADATA_BYTES,
  COMPOSER_MAX_ATTACHMENTS,
  COMPOSER_MAX_FILE_BYTES,
  COMPOSER_MAX_NON_IMAGE_BODY_BYTES,
  COMPOSER_REQUEST_ENVELOPE_BYTES,
} from '@constants/attachments'
import {
  base64Length,
  composerFileAdmissionError,
  composerFileEntryBytes,
  composerNonImageBodyBytes,
  fileNameProblem,
  readComposerFile,
} from '../composerFileAdmission'

const EMPTY_CONTEXT = { attachedCount: 0, files: [], textBytes: 0 }

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
    ).toContain('a file can be at most 3.0 MiB')
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

  it('rejects a file whose base64 no longer fits the non-image share of the body', () => {
    const first = { filename: 'first.bin', sizeBytes: COMPOSER_MAX_FILE_BYTES }
    // Liveness witness: the first file alone is admitted, so the rejection below
    // comes from the budget check and not from a per-file or count limit.
    expect(
      composerFileAdmissionError(
        { name: 'first.bin', size: COMPOSER_MAX_FILE_BYTES },
        EMPTY_CONTEXT
      )
    ).toBeNull()
    expect(
      composerFileAdmissionError(
        { name: 'second.bin', size: COMPOSER_MAX_FILE_BYTES },
        { attachedCount: 1, files: [first], textBytes: 0 }
      )
    ).toContain('does not fit')
  })

  it('counts the message text against the same share', () => {
    const file = { name: 'a.bin', size: 1024 }
    expect(composerFileAdmissionError(file, EMPTY_CONTEXT)).toBeNull()
    expect(
      composerFileAdmissionError(file, {
        ...EMPTY_CONTEXT,
        textBytes: COMPOSER_MAX_NON_IMAGE_BODY_BYTES,
      })
    ).toContain('does not fit')
  })

  it.each([
    ['', 'has no name'],
    ['a/b.pdf', 'has a name with "/" or control characters'],
    ['a\u0007.pdf', 'has a name with "/" or control characters'],
    ['..', 'has an invalid name'],
    ['é.txt', 'has a name that is not NFC-normalized'],
    ['x'.repeat(256), 'has a name longer than 255 characters'],
  ])('rejects the name %j', (name, problem) => {
    expect(fileNameProblem(name)).toBe(problem)
    expect(composerFileAdmissionError({ name, size: 1 }, EMPTY_CONTEXT)).toContain(problem)
  })

  it('accepts a 255 code point name and a non-ASCII NFC name', () => {
    expect(fileNameProblem('x'.repeat(255))).toBeNull()
    expect(fileNameProblem('informe-ñandú.docx')).toBeNull()
  })
})

describe('composerNonImageBodyBytes (#678)', () => {
  it('adds the envelope, the text and the base64 plus metadata of each file', () => {
    const file = { filename: 'a.pdf', sizeBytes: 1000 }
    expect(composerNonImageBodyBytes({ files: [file], textBytes: 50 })).toBe(
      COMPOSER_REQUEST_ENVELOPE_BYTES +
        50 +
        base64Length(1000) +
        JSON.stringify('a.pdf').length +
        COMPOSER_FILE_ENTRY_METADATA_BYTES
    )
    expect(composerFileEntryBytes(file)).toBe(
      base64Length(1000) + JSON.stringify('a.pdf').length + COMPOSER_FILE_ENTRY_METADATA_BYTES
    )
  })

  it('measures a multi-byte name in UTF-8 bytes', () => {
    const ascii = composerFileEntryBytes({ filename: 'aaaa.txt', sizeBytes: 0 })
    const accented = composerFileEntryBytes({ filename: 'ññññ.txt', sizeBytes: 0 })
    expect(accented - ascii).toBe(4)
  })
})
