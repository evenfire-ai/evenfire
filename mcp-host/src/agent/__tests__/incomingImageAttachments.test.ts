import { describe, expect, it } from 'vitest'
import { validateIncomingImageAttachments } from '../incomingImageAttachments'

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
    [{ ...image, dataBase64: 'a'.repeat(20) }],
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
})
