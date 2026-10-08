import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import type { Attachment } from '../../core/types'
import { inlineFileAttachmentBytes } from '../modelStepCheckpointAttachments'

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

function attachment(overrides: Partial<Attachment> & Pick<Attachment, 'id' | 'kind'>): Attachment {
  return { mimeType: 'text/plain', encoding: 'base64', dataBase64: '', ...overrides }
}

describe('inlineFileAttachmentBytes (#1043)', () => {
  it('returns the raw bytes and digest of inline files only', () => {
    const file = Buffer.from('file bytes')
    const image = Buffer.from('image bytes')
    const result = inlineFileAttachmentBytes([
      attachment({
        id: 'file-1',
        kind: 'file',
        dataBase64: file.toString('base64'),
        digest: { algorithm: 'sha256', hex: sha256(file) },
      }),
      attachment({ id: 'image-1', kind: 'image', dataBase64: image.toString('base64') }),
      attachment({ id: 'file-empty', kind: 'file' }),
    ])
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ attachmentId: 'file-1', digestHex: sha256(file) })
    expect(Buffer.compare(Buffer.from(result[0]!.bytes), file)).toBe(0)
  })

  it('refuses bytes that do not match the admitted digest', () => {
    expect(() =>
      inlineFileAttachmentBytes([
        attachment({
          id: 'file-1',
          kind: 'file',
          dataBase64: Buffer.from('tampered').toString('base64'),
          digest: { algorithm: 'sha256', hex: sha256(Buffer.from('original')) },
        }),
      ])
    ).toThrow('Inline attachment file-1 does not match its admitted digest')
  })

  it('returns nothing for a turn without attachments', () => {
    expect(inlineFileAttachmentBytes(undefined)).toEqual([])
  })
})
