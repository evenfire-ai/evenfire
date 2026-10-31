import { describe, expect, it } from 'vitest'
import type { Attachment } from '../../types'
import { attachmentSaveAvailable, decodedBase64Length } from '../attachmentSave'

const image = {
  id: 'img-1',
  kind: 'image',
  mimeType: 'image/png',
  encoding: 'base64',
  dataBase64: 'iVBORw0KGgo=',
  filename: 'logo.png',
} as Attachment

describe('attachmentSaveAvailable', () => {
  it('is available only with gfs.write and an attachment carrying bytes', () => {
    expect(attachmentSaveAvailable(new Set(['gfs.read', 'gfs.write'] as const), [image])).toBe(true)
    expect(attachmentSaveAvailable(new Set(['gfs.read'] as const), [image])).toBe(false)
    expect(attachmentSaveAvailable(null, [image])).toBe(false)
    expect(attachmentSaveAvailable(new Set(['gfs.write'] as const), [])).toBe(false)
    expect(attachmentSaveAvailable(new Set(['gfs.write'] as const), undefined)).toBe(false)
    const resumed = { ...image, kind: 'file' } as Partial<Attachment>
    delete resumed.dataBase64
    expect(attachmentSaveAvailable(new Set(['gfs.write'] as const), [resumed as Attachment])).toBe(
      false
    )
  })
})

describe('decodedBase64Length', () => {
  it('matches Buffer decoding for every padding shape', () => {
    for (const n of [0, 1, 2, 3, 4, 5, 1024]) {
      const b64 = Buffer.alloc(n, 7).toString('base64')
      expect(decodedBase64Length(b64)).toBe(n)
    }
  })
})
