import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { INCOMING_ATTACHMENT_MAX_COUNT, validateIncomingAttachments } from '../incomingAttachments'

// The #669 image cases below are unchanged. They moved with the validator and
// now also pass the file options (issue #666), which the image branch never reads.
const fileOptions = { maxFileBytes: 64, messageId: 'message-1' }
const limits = { maxCount: 2, maxBytes: 10, ...fileOptions }
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff])
// Bytes exercise the ingress encoding/size contract and the declared-type
// check; they are still not a decodable image.
const image = {
  id: 'image-1',
  kind: 'image',
  mimeType: 'image/png',
  encoding: 'base64',
  dataBase64: PNG_SIGNATURE.toString('base64'),
}

describe('visual input validation', () => {
  it('preserves text-only messages and valid image bytes', () => {
    expect(validateIncomingAttachments(undefined, limits)).toEqual({
      ok: true,
      attachments: undefined,
      fileReferences: [],
    })
    expect(validateIncomingAttachments([image], limits)).toEqual({
      ok: true,
      attachments: [image],
      fileReferences: [],
    })
    const jpeg = {
      ...image,
      mimeType: 'image/jpeg',
      dataBase64: JPEG_SIGNATURE.toString('base64'),
    }
    expect(validateIncomingAttachments([jpeg], limits)).toEqual({
      ok: true,
      attachments: [jpeg],
      fileReferences: [],
    })
  })
  it.each([
    'not-a-list',
    [null],
    [{ ...image, mimeType: 'image/gif' }],
    [{ ...image, dataBase64: '' }],
    [{ ...image, dataBase64: 'YQ=' }],
    [{ ...image, dataBase64: 'YR==' }],
    [image, image, image],
    [image, { ...image, encoding: 'url' }],
  ])('rejects the whole message for invalid input %#', raw => {
    const result = validateIncomingAttachments(raw, limits)
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'LLM_INVALID_ATTACHMENT', retryable: false },
    })
    expect(result).not.toHaveProperty('attachments')
  })
  describe('size limit (maxBytes = 10)', () => {
    // A well-formed PNG of exactly `size` bytes, so a rejection can only come
    // from the size checks: the shape, re-encoding and signature checks pass.
    const pngOfSize = (size: number) =>
      Buffer.concat([PNG_SIGNATURE, Buffer.alloc(size - PNG_SIGNATURE.length)]).toString('base64')
    // The pre-decode bound on the base64 length for maxBytes = 10.
    const encodedBound = Math.ceil(limits.maxBytes / 3) * 4
    const SIZE_MESSAGE = 'An image exceeds the attachment size limit.'

    it('accepts a PNG of exactly maxBytes (control)', () => {
      const dataBase64 = pngOfSize(10)
      expect(validateIncomingAttachments([{ ...image, dataBase64 }], limits)).toEqual({
        ok: true,
        attachments: [{ ...image, dataBase64 }],
        fileReferences: [],
      })
    })

    it.each([11, 12])(
      'rejects a %i-byte PNG on its decoded size (its base64 fits the pre-decode bound)',
      size => {
        const dataBase64 = pngOfSize(size)
        // Precondition: only the decoded-size check can reject this input.
        expect(dataBase64.length).toBeLessThanOrEqual(encodedBound)
        const result = validateIncomingAttachments([{ ...image, dataBase64 }], limits)
        expect(result).toEqual({
          ok: false,
          error: {
            code: 'LLM_INVALID_ATTACHMENT',
            message: SIZE_MESSAGE,
            retryable: false,
            provider: 'unknown',
          },
        })
      }
    )

    it('rejects a 13-byte PNG whose base64 already exceeds the pre-decode bound', () => {
      const dataBase64 = pngOfSize(13)
      expect(dataBase64.length).toBeGreaterThan(encodedBound)
      const result = validateIncomingAttachments([{ ...image, dataBase64 }], limits)
      expect(result.ok === false && result.error.message).toBe(SIZE_MESSAGE)
    })

    it('rejects oversized input before decoding it', () => {
      // Too long for the bound AND not canonical base64 (length is not a
      // multiple of 4). Only the pre-decode length check can answer with the
      // size message; without it the shape check answers "invalid base64".
      const dataBase64 = 'A'.repeat(encodedBound + 5)
      const result = validateIncomingAttachments([{ ...image, dataBase64 }], limits)
      expect(result.ok === false && result.error.message).toBe(SIZE_MESSAGE)
    })
  })

  it('does not trust caller-supplied attachment metadata', () => {
    expect(
      validateIncomingAttachments(
        [{ ...image, sourceTool: 'workflow_result', extra: true }],
        limits
      )
    ).toEqual({ ok: true, attachments: [image], fileReferences: [] })
  })

  it('accepts a valid image whose base64 exceeds the old regex stack limit', () => {
    // The grouped-quantifier base64 regex allocates one V8 backtrack frame per
    // 4-character group and throws RangeError above ~4.47M characters. 3.5 MiB
    // of image is ~4.67M characters, so this input reproduces that crash.
    const bytes = Buffer.alloc(3_500_000)
    PNG_SIGNATURE.copy(bytes, 0)
    const dataBase64 = bytes.toString('base64')
    expect(dataBase64.length).toBeGreaterThan(4_470_000)
    const result = validateIncomingAttachments([{ ...image, dataBase64 }], {
      maxCount: 2,
      maxBytes: 4_000_000,
      ...fileOptions,
    })
    expect(result.ok).toBe(true)
    expect(result.ok && result.attachments?.[0]?.dataBase64.length).toBe(dataBase64.length)
  })

  it.each(['AAA', 'AAAA=AAA', 'A===', 'AA=A'])(
    'rejects the non-canonical base64 shape %s without decoding',
    dataBase64 => {
      const result = validateIncomingAttachments([{ ...image, dataBase64 }], {
        maxCount: 2,
        maxBytes: 4_000_000,
        ...fileOptions,
      })
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'LLM_INVALID_ATTACHMENT', retryable: false },
      })
      expect(result.ok === false && result.error.message).toContain('invalid base64 data')
    }
  )

  it('rejects bytes whose signature does not match the declared mime', () => {
    const result = validateIncomingAttachments(
      [{ ...image, mimeType: 'image/jpeg', dataBase64: PNG_SIGNATURE.toString('base64') }],
      limits
    )
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'LLM_INVALID_ATTACHMENT', retryable: false },
    })
    expect(result.ok === false && result.error.message).toContain(
      'does not match its declared type'
    )
  })

  it('admits 20 images per message and rejects the 21st', () => {
    expect(INCOMING_ATTACHMENT_MAX_COUNT).toBe(20)
    const hostLimits = { maxCount: INCOMING_ATTACHMENT_MAX_COUNT, maxBytes: 10, ...fileOptions }
    const batch = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ ...image, id: `image-${index + 1}` }))

    const admitted = validateIncomingAttachments(batch(20), hostLimits)
    expect(admitted.ok && admitted.attachments?.length).toBe(20)

    const rejected = validateIncomingAttachments(batch(21), hostLimits)
    expect(rejected).toMatchObject({ ok: false, error: { code: 'LLM_INVALID_ATTACHMENT' } })
    expect(rejected.ok === false && rejected.error.message).toContain('Too many image attachments')
  })
})

describe('file attachment validation (issue #666)', () => {
  const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
  const fileOf = (
    content: Buffer | string,
    filename: string,
    mimeType: string,
    detectedMediaType: string
  ) => {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
    return {
      id: `file-${filename}`,
      kind: 'file',
      mimeType,
      detectedMediaType,
      encoding: 'base64',
      dataBase64: bytes.toString('base64'),
      filename,
      sizeBytes: bytes.length,
      digest: { algorithm: 'sha256', hex: sha256(bytes) },
    }
  }
  const notes = fileOf('# Notes\n\nplain text\n', 'notes.md', 'text/markdown', 'text/markdown')

  const admitOne = (raw: unknown) => {
    const result = validateIncomingAttachments([raw], limits)
    if (!result.ok) throw new Error(`expected admission, got ${result.error.code}`)
    expect(result.attachments).toHaveLength(1)
    expect(result.fileReferences).toHaveLength(1)
    return { attachment: result.attachments![0]!, reference: result.fileReferences[0]! }
  }

  it('admits a text file and derives its reference from the host-verified bytes', () => {
    const { attachment, reference } = admitOne(notes)
    expect(reference).toEqual({
      schemaVersion: 1,
      id: `att:message-1:file-notes.md@sha256:${notes.digest.hex}`,
      source: { kind: 'attachment', attachmentId: 'file-notes.md', messageId: 'message-1' },
      name: 'notes.md',
      declaredMediaType: 'text/markdown',
      detectedMediaType: 'text/markdown',
      class: 'markdown',
      detection: 'text_utf8',
      mismatch: false,
      byteLength: notes.sizeBytes,
      digest: notes.digest,
      textReadable: true,
      reader: 'text',
      modelImageInput: 'unsupported',
    })
    expect(attachment).toEqual({
      id: 'file-notes.md',
      kind: 'file',
      mimeType: 'text/markdown',
      encoding: 'base64',
      dataBase64: notes.dataBase64,
      filename: 'notes.md',
      sizeBytes: notes.sizeBytes,
      detectedMediaType: 'text/markdown',
      digest: notes.digest,
      fileReference: reference,
    })
  })

  it.each([
    [
      'an .svg as readable text',
      fileOf(
        '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
        'logo.svg',
        'image/svg+xml',
        'image/svg+xml'
      ),
      { class: 'svg', reader: 'text', mismatch: false },
    ],
    [
      'a .bin as unreadable',
      fileOf(
        Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00]),
        'blob.bin',
        'application/octet-stream',
        'application/octet-stream'
      ),
      { class: 'binary_unsupported', reader: 'none', mismatch: false },
    ],
    [
      'a .txt carrying PDF bytes as a pdf mismatch',
      fileOf('%PDF-1.7\n%âãÏÓ\n', 'report.txt', 'text/plain', 'text/plain'),
      { class: 'pdf', reader: 'none', mismatch: true },
    ],
    [
      'a PNG sent as kind:file without a reader',
      fileOf(PNG_SIGNATURE, 'photo.png', 'image/png', 'image/png'),
      { class: 'png', reader: 'none', mismatch: false },
    ],
  ])('admits %s, never rejecting on type', (_label, file, expected) => {
    const { attachment, reference } = admitOne(file)
    expect(reference).toMatchObject(expected)
    expect(attachment.kind).toBe('file')
  })

  it('ignores the client detection: only the declared type can disagree with the host', () => {
    // The client detected plain text; the host detects markdown from the
    // extension. The client detection is not a declaration, so no mismatch.
    const { attachment, reference } = admitOne({ ...notes, detectedMediaType: 'text/plain' })
    expect(reference).toMatchObject({
      class: 'markdown',
      declaredMediaType: 'text/markdown',
      detectedMediaType: 'text/markdown',
      mismatch: false,
    })
    expect(attachment.detectedMediaType).toBe('text/markdown')

    // Witness: a declared type the host disagrees with is still recorded.
    const declaredPdf = admitOne({ ...notes, mimeType: 'application/pdf' })
    expect(declaredPdf.reference).toMatchObject({
      declaredMediaType: 'application/pdf',
      mismatch: true,
    })
  })

  it('admits an empty mimeType as no declared type', () => {
    const { attachment, reference } = admitOne({ ...notes, mimeType: '' })
    expect(reference).toMatchObject({
      declaredMediaType: null,
      detectedMediaType: 'text/markdown',
      mismatch: false,
    })
    expect(attachment.mimeType).toBe('')
  })

  it('admits a zero-byte file', () => {
    const { reference } = admitOne(fileOf('', 'empty.txt', 'text/plain', 'text/plain'))
    expect(reference).toMatchObject({ byteLength: 0, reader: 'text' })
  })

  it('admits images and files together and returns only the file references', () => {
    const result = validateIncomingAttachments([image, notes], limits)
    expect(result.ok).toBe(true)
    expect(result.ok && result.attachments?.map(a => a.kind)).toEqual(['image', 'file'])
    expect(result.ok && result.fileReferences.map(r => r.source)).toEqual([
      { kind: 'attachment', attachmentId: 'file-notes.md', messageId: 'message-1' },
    ])
  })

  it('counts images and files against one ceiling of 20', () => {
    const hostLimits = { maxCount: INCOMING_ATTACHMENT_MAX_COUNT, maxBytes: 10, ...fileOptions }
    const mixed = (count: number) =>
      Array.from({ length: count }, (_, index) =>
        index % 2 ? { ...notes, id: `file-${index}` } : { ...image, id: `image-${index}` }
      )
    const admitted = validateIncomingAttachments(mixed(20), hostLimits)
    expect(admitted.ok && admitted.attachments?.length).toBe(20)
    expect(admitted.ok && admitted.fileReferences.length).toBe(10)

    const rejected = validateIncomingAttachments(mixed(21), hostLimits)
    expect(rejected).toEqual({
      ok: false,
      error: {
        code: 'LLM_INVALID_ATTACHMENT',
        message: 'Too many attachments. Remove an attachment and try again.',
        retryable: false,
        provider: 'unknown',
      },
    })
  })

  const tooBig = fileOf('x'.repeat(65), 'big.txt', 'text/plain', 'text/plain')
  it.each([
    ['FILE_ATTACHMENT_INVALID', 'a missing digest', { ...notes, digest: undefined }],
    [
      'FILE_ATTACHMENT_INVALID',
      'an uppercase digest',
      { ...notes, digest: { algorithm: 'sha256', hex: notes.digest.hex.toUpperCase() } },
    ],
    ['FILE_ATTACHMENT_INVALID', 'a missing filename', { ...notes, filename: undefined }],
    ['FILE_ATTACHMENT_INVALID', 'a url encoding', { ...notes, encoding: 'url' }],
    [
      'FILE_ATTACHMENT_INVALID',
      'non-canonical base64',
      { ...notes, dataBase64: 'YR==', sizeBytes: 1 },
    ],
    [
      'FILE_ATTACHMENT_INVALID',
      'a declared size the bytes contradict',
      { ...notes, sizeBytes: notes.sizeBytes + 1 },
    ],
    [
      'FILE_ATTACHMENT_INVALID',
      'a name with a path separator',
      { ...notes, filename: 'dir/notes.md' },
    ],
    ['FILE_ATTACHMENT_INVALID', 'a negative declared size', { ...notes, sizeBytes: -1 }],
    [
      'FILE_ATTACHMENT_INVALID',
      'a fractional declared size',
      { ...notes, sizeBytes: notes.sizeBytes - 0.5 },
    ],
    ['FILE_ATTACHMENT_TOO_LARGE', 'decoded bytes over maxFileBytes', tooBig],
    ['FILE_ATTACHMENT_TOO_LARGE', 'a declared size over maxFileBytes', { ...notes, sizeBytes: 65 }],
    [
      'FILE_ATTACHMENT_TOO_LARGE',
      'base64 over the pre-decode bound',
      { ...notes, dataBase64: 'A'.repeat(Math.ceil(64 / 3) * 4 + 5) },
    ],
    [
      'FILE_ATTACHMENT_DIGEST_MISMATCH',
      'a digest of other bytes',
      { ...notes, digest: { algorithm: 'sha256', hex: sha256(Buffer.from('other')) } },
    ],
  ])('rejects the whole message with %s for %s', (code, _label, file) => {
    // Control: the same message without the bad file is admitted.
    expect(validateIncomingAttachments([image], limits).ok).toBe(true)
    const result = validateIncomingAttachments([image, file], limits)
    expect(result).toMatchObject({
      ok: false,
      error: { code, retryable: false, provider: 'unknown' },
    })
    expect(result).not.toHaveProperty('attachments')
  })

  it('keeps the #669 rejection for an unknown kind', () => {
    const result = validateIncomingAttachments([{ ...notes, kind: 'document' }], limits)
    expect(result).toMatchObject({ ok: false, error: { code: 'LLM_INVALID_ATTACHMENT' } })
  })

  it('rejects an attachment id sent twice, across kinds or within one', () => {
    // Witness: the same attachments with distinct ids are admitted.
    expect(validateIncomingAttachments([image, notes], limits).ok).toBe(true)
    const duplicate = {
      ok: false,
      error: {
        code: 'LLM_INVALID_ATTACHMENT',
        message: 'Each attachment id must appear once.',
        retryable: false,
        provider: 'unknown',
      },
    }
    expect(validateIncomingAttachments([image, { ...notes, id: image.id }], limits)).toEqual(
      duplicate
    )
    expect(validateIncomingAttachments([notes, notes], limits)).toEqual(duplicate)
    expect(validateIncomingAttachments([image, image], limits)).toEqual(duplicate)
  })

  it('does not ask for a rename when the reference fails for a reason other than the name', () => {
    const noMessage = validateIncomingAttachments([notes], { ...limits, messageId: '' })
    expect(noMessage).toMatchObject({
      ok: false,
      error: { code: 'FILE_ATTACHMENT_INVALID', retryable: false },
    })
    expect(noMessage.ok === false && noMessage.error.message).toMatch(
      /^A file attachment is invalid: /
    )
    expect(noMessage.ok === false && noMessage.error.message).not.toContain('Rename')

    // Witness: a name problem still asks for a rename.
    const badName = validateIncomingAttachments([{ ...notes, filename: 'dir/notes.md' }], limits)
    expect(badName.ok === false && badName.error.message).toBe(
      'A file attachment has an invalid name. Rename the file and attach it again.'
    )
  })

  it('names the list requirement when attachments are not a list', () => {
    expect(validateIncomingAttachments('not-a-list', limits)).toEqual({
      ok: false,
      error: {
        code: 'LLM_INVALID_ATTACHMENT',
        message: 'Attachments must be a list.',
        retryable: false,
        provider: 'unknown',
      },
    })
  })
})
