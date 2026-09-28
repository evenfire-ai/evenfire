/**
 * #666 R4-M2 — the source-message metadata a pending approval persists so a
 * cold restart rebuilds the file-reference pins and attachment lines.
 */
import { describe, expect, it } from 'vitest'
import type { Attachment } from '../../core/types'
import type { IncomingMessage } from '../../server'
import { sourceMessageForResume } from '../sourceMessageForResume'

const FILE_BYTES = Buffer.from('SENTINEL-666-file-bytes')
const IMAGE_BYTES = Buffer.from('SENTINEL-666-image-bytes')

function fileAttachment(): Attachment {
  return {
    id: 'file-1',
    kind: 'file',
    mimeType: 'text/plain',
    encoding: 'base64',
    dataBase64: FILE_BYTES.toString('base64'),
    filename: 'notes.txt',
    sizeBytes: FILE_BYTES.length,
  }
}

function imageAttachment(): Attachment {
  return {
    id: 'image-1',
    kind: 'image',
    mimeType: 'image/png',
    encoding: 'base64',
    dataBase64: IMAGE_BYTES.toString('base64'),
    filename: 'logo.png',
  }
}

function sourceMessage(attachments: Attachment[]): IncomingMessage {
  return {
    content: 'Read the attached notes',
    channelType: 'rpc',
    channelId: 'chatllm',
    sender: 'user-1',
    timestamp: '2026-09-28T10:00:00Z',
    messageId: 'message-1',
    hostRef: 'chatllm',
    attachments,
    fileReferenceResolutions: [
      {
        availability: 'available',
        reference: {
          schemaVersion: 1,
          id: 'gfs:main:123@v3',
          source: {
            kind: 'gfs',
            drive: 'main',
            resourceId: '123',
            gfsUri: 'gfs://main/123',
            version: 3,
          },
          name: 'notes.txt',
          declaredMediaType: null,
          detectedMediaType: 'text/plain',
          class: 'text',
          detection: 'text_utf8',
          mismatch: false,
          byteLength: 4,
          textReadable: true,
          reader: 'text',
          modelImageInput: 'unsupported',
        },
      },
    ],
  }
}

describe('sourceMessageForResume (#666 R4-M2)', () => {
  it('keeps file metadata and reference resolutions, never inline bytes', () => {
    const resumed = sourceMessageForResume(sourceMessage([fileAttachment(), imageAttachment()]))
    expect(resumed?.attachments).toHaveLength(1)
    expect(resumed?.attachments?.[0]).toMatchObject({
      id: 'file-1',
      kind: 'file',
      filename: 'notes.txt',
    })
    expect(resumed?.attachments?.[0]).not.toHaveProperty('dataBase64')
    expect(resumed?.attachments?.[0]?.id).not.toBe('image-1')
    expect(resumed?.fileReferenceResolutions?.[0]?.reference.id).toBe('gfs:main:123@v3')
    expect(JSON.stringify(resumed)).not.toContain(FILE_BYTES.toString('base64'))
    expect(JSON.stringify(resumed)).not.toContain(IMAGE_BYTES.toString('base64'))
    expect(resumed?.messageId).toBe('message-1')
  })

  it('returns undefined without a source message', () => {
    expect(sourceMessageForResume(undefined)).toBeUndefined()
  })
})
