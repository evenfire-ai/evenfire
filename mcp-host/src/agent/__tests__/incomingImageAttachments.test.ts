import { describe, expect, it } from 'vitest'
import {
  INCOMING_IMAGE_MAX_COUNT,
  validateIncomingImageAttachments,
} from '../incomingImageAttachments'

const limits = { maxCount: 2, maxBytes: 10 }
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
    expect(validateIncomingImageAttachments(undefined, limits)).toEqual({
      ok: true,
      attachments: undefined,
    })
    expect(validateIncomingImageAttachments([image], limits)).toEqual({
      ok: true,
      attachments: [image],
    })
    const jpeg = {
      ...image,
      mimeType: 'image/jpeg',
      dataBase64: JPEG_SIGNATURE.toString('base64'),
    }
    expect(validateIncomingImageAttachments([jpeg], limits)).toEqual({
      ok: true,
      attachments: [jpeg],
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
    const result = validateIncomingImageAttachments(raw, limits)
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
      expect(validateIncomingImageAttachments([{ ...image, dataBase64 }], limits)).toEqual({
        ok: true,
        attachments: [{ ...image, dataBase64 }],
      })
    })

    it.each([11, 12])(
      'rejects a %i-byte PNG on its decoded size (its base64 fits the pre-decode bound)',
      size => {
        const dataBase64 = pngOfSize(size)
        // Precondition: only the decoded-size check can reject this input.
        expect(dataBase64.length).toBeLessThanOrEqual(encodedBound)
        const result = validateIncomingImageAttachments([{ ...image, dataBase64 }], limits)
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
      const result = validateIncomingImageAttachments([{ ...image, dataBase64 }], limits)
      expect(result.ok === false && result.error.message).toBe(SIZE_MESSAGE)
    })

    it('rejects oversized input before decoding it', () => {
      // Too long for the bound AND not canonical base64 (length is not a
      // multiple of 4). Only the pre-decode length check can answer with the
      // size message; without it the shape check answers "invalid base64".
      const dataBase64 = 'A'.repeat(encodedBound + 5)
      const result = validateIncomingImageAttachments([{ ...image, dataBase64 }], limits)
      expect(result.ok === false && result.error.message).toBe(SIZE_MESSAGE)
    })
  })

  it('does not trust caller-supplied attachment metadata', () => {
    expect(
      validateIncomingImageAttachments(
        [{ ...image, sourceTool: 'workflow_result', extra: true }],
        limits
      )
    ).toEqual({ ok: true, attachments: [image] })
  })

  it('accepts a valid image whose base64 exceeds the old regex stack limit', () => {
    // The grouped-quantifier base64 regex allocates one V8 backtrack frame per
    // 4-character group and throws RangeError above ~4.47M characters. 3.5 MiB
    // of image is ~4.67M characters, so this input reproduces that crash.
    const bytes = Buffer.alloc(3_500_000)
    PNG_SIGNATURE.copy(bytes, 0)
    const dataBase64 = bytes.toString('base64')
    expect(dataBase64.length).toBeGreaterThan(4_470_000)
    const result = validateIncomingImageAttachments([{ ...image, dataBase64 }], {
      maxCount: 2,
      maxBytes: 4_000_000,
    })
    expect(result.ok).toBe(true)
    expect(result.ok && result.attachments?.[0]?.dataBase64.length).toBe(dataBase64.length)
  })

  it.each(['AAA', 'AAAA=AAA', 'A===', 'AA=A'])(
    'rejects the non-canonical base64 shape %s without decoding',
    dataBase64 => {
      const result = validateIncomingImageAttachments([{ ...image, dataBase64 }], {
        maxCount: 2,
        maxBytes: 4_000_000,
      })
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'LLM_INVALID_ATTACHMENT', retryable: false },
      })
      expect(result.ok === false && result.error.message).toContain('invalid base64 data')
    }
  )

  it('rejects bytes whose signature does not match the declared mime', () => {
    const result = validateIncomingImageAttachments(
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
    expect(INCOMING_IMAGE_MAX_COUNT).toBe(20)
    const hostLimits = { maxCount: INCOMING_IMAGE_MAX_COUNT, maxBytes: 10 }
    const batch = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ ...image, id: `image-${index + 1}` }))

    const admitted = validateIncomingImageAttachments(batch(20), hostLimits)
    expect(admitted.ok && admitted.attachments?.length).toBe(20)

    const rejected = validateIncomingImageAttachments(batch(21), hostLimits)
    expect(rejected).toMatchObject({ ok: false, error: { code: 'LLM_INVALID_ATTACHMENT' } })
    expect(rejected.ok === false && rejected.error.message).toContain('Too many image attachments')
  })
})
