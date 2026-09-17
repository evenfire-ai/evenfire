import { describe, expect, it } from 'vitest'
import { validateIncomingImageAttachments } from '../incomingImageAttachments'

const limits = { maxCount: 2, maxBytes: 10 }
// Bytes exercise the ingress encoding/size contract, not image decoding.
const image = {
  id: 'image-1',
  kind: 'image',
  mimeType: 'image/png',
  encoding: 'base64',
  dataBase64: 'YWJj',
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
})
