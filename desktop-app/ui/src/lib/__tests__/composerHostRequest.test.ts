import { describe, expect, it } from 'vitest'
import { classifyBytes } from '@clerum/gfs-interaction-policy'
import type { ComposerImageAttachment, ReadyComposerFileAttachment } from '../../uiTypes'
import {
  composerRequestBaseContent,
  mapComposerAttachmentsToHostRequest,
} from '../composerHostRequest'

const NOTES = new TextEncoder().encode('meeting notes\n')

const image: ComposerImageAttachment = {
  id: 'img-1',
  name: 'photo.png',
  mimeType: 'image/png',
  dataBase64: 'iVBORw0KGgo=',
  sizeBytes: 8,
  previewDataUrl: 'blob:preview',
}

const file: ReadyComposerFileAttachment = {
  id: 'file-1',
  type: 'file',
  status: 'ready',
  filename: 'notes.txt',
  sizeBytes: NOTES.length,
  declaredMediaType: 'text/plain',
  classification: classifyBytes({
    bytes: NOTES,
    totalByteLength: NOTES.length,
    declaredMediaType: 'text/plain',
    filename: 'notes.txt',
  }),
  dataBase64: 'bWVldGluZyBub3Rlcwo=',
  digestHex: 'a'.repeat(64),
}

describe('mapComposerAttachmentsToHostRequest (#678)', () => {
  it('posts images first, then files, in the Host wire shape', () => {
    const mapped = mapComposerAttachmentsToHostRequest([image], [file])

    expect(mapped).toEqual([
      {
        id: 'img-1',
        kind: 'image',
        mimeType: 'image/png',
        encoding: 'base64',
        dataBase64: 'iVBORw0KGgo=',
        filename: 'photo.png',
      },
      {
        id: 'file-1',
        kind: 'file',
        filename: 'notes.txt',
        mimeType: 'text/plain',
        detectedMediaType: file.classification.detectedMediaType,
        encoding: 'base64',
        dataBase64: 'bWVldGluZyBub3Rlcwo=',
        sizeBytes: NOTES.length,
        digest: { algorithm: 'sha256', hex: 'a'.repeat(64) },
      },
    ])
    // The serialized key order is what the proxies measure; pin it.
    expect(Object.keys(mapped[1]!)).toEqual([
      'id',
      'kind',
      'filename',
      'mimeType',
      'detectedMediaType',
      'encoding',
      'dataBase64',
      'sizeBytes',
      'digest',
    ])
    expect(file.classification.detectedMediaType).toBe('text/plain')
  })

  it('posts nothing for an empty composer', () => {
    expect(mapComposerAttachmentsToHostRequest([], [])).toEqual([])
  })
})

describe('composerRequestBaseContent (#678)', () => {
  it('keeps typed text whatever is attached', () => {
    expect(composerRequestBaseContent('hello', 1, 1)).toBe('hello')
  })

  it.each([
    [1, 1, 'Please analyze the attached image(s) and file(s).'],
    [0, 2, 'Please analyze the attached file(s).'],
    [3, 0, 'Please analyze the attached image(s).'],
    [0, 0, 'Please use the attached context.'],
  ])(
    'names what is attached when the draft is empty (%i images, %i files)',
    (images, files, text) => {
      expect(composerRequestBaseContent('', images, files)).toBe(text)
    }
  )
})
