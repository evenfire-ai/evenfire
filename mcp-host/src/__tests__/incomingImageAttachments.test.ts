import { describe, expect, it, vi } from 'vitest'
import { VISUAL_LIMITS } from '@clerum/llm-provider-attempt-contract'
import type { Attachment } from '../core/types'
import { sanitizeIncomingAttachments } from '../incomingImageAttachments'
import { JPEG_2X2_BASE64, PNG_2X2_BASE64 } from '../llm/__tests__/codexImageFixtures'

const MAX_BYTES = 52_428_800

function imageAttachment(id: string, mimeType: 'image/png' | 'image/jpeg'): Attachment {
  return {
    id,
    kind: 'image',
    mimeType,
    encoding: 'base64',
    dataBase64: mimeType === 'image/png' ? PNG_2X2_BASE64 : JPEG_2X2_BASE64,
  }
}

describe('sanitizeIncomingAttachments', () => {
  it('keeps five composer images even when the outbound response cap is 3', () => {
    const incoming = [1, 2, 3, 4, 5].map(index =>
      imageAttachment(`img-${index}`, index % 2 === 0 ? 'image/jpeg' : 'image/png')
    )
    const kept = sanitizeIncomingAttachments(incoming, MAX_BYTES)
    expect(kept).toHaveLength(5)
    expect(kept?.map(attachment => attachment.id)).toEqual([
      'img-1',
      'img-2',
      'img-3',
      'img-4',
      'img-5',
    ])
  })

  it('keeps the contract ceiling and drops the rest fail-visible', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const incoming = Array.from({ length: VISUAL_LIMITS.maxImages + 1 }, (_, index) =>
      imageAttachment(`img-${index + 1}`, 'image/png')
    )
    const kept = sanitizeIncomingAttachments(incoming, MAX_BYTES)
    expect(kept).toHaveLength(VISUAL_LIMITS.maxImages)
    expect(warn).toHaveBeenCalledWith(
      `[Main] Dropping 1 incoming image attachment(s) beyond ${VISUAL_LIMITS.maxImages}`
    )
    warn.mockRestore()
  })

  it('skips non-image attachments instead of occupying an inbound slot', () => {
    const incoming: Attachment[] = [
      {
        id: 'file-1',
        kind: 'file',
        mimeType: 'application/pdf',
        encoding: 'base64',
        dataBase64: PNG_2X2_BASE64,
      },
      imageAttachment('img-1', 'image/png'),
    ]
    expect(
      sanitizeIncomingAttachments(incoming, MAX_BYTES)?.map(attachment => attachment.id)
    ).toEqual(['img-1'])
  })
})
