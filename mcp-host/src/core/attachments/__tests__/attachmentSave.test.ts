import { describe, expect, it } from 'vitest'
import type { Attachment } from '../../types'
import { attachmentSaveAvailable, attachmentSaveName, imageSaveName } from '../attachmentSave'

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

describe('attachmentSaveName', () => {
  const file = {
    id: 'file-1',
    kind: 'file',
    mimeType: 'application/octet-stream',
    encoding: 'base64',
    dataBase64: 'AAEC',
    filename: 'blob.bin',
  } as Attachment

  it('keeps a usable name exactly, without trimming it', () => {
    expect(attachmentSaveName(image)).toBe('logo.png')
    expect(attachmentSaveName(file)).toBe('blob.bin')
    expect(attachmentSaveName({ ...file, filename: ' notes .md' })).toBe(' notes .md')
  })

  it('NFC-normalizes the name, as gfsc does', () => {
    expect(attachmentSaveName({ ...image, filename: 'cafe\u0301.png' })).toBe('caf\u00e9.png')
  })

  it('names an image without a usable name after its id and type', () => {
    for (const filename of [
      undefined,
      '',
      '   ',
      '.',
      '..',
      'shots/a.png',
      'a\u0000b.png',
      'a\nb.png',
    ]) {
      expect(imageSaveName({ ...image, filename })).toBe('image-img-1.png')
    }
    expect(imageSaveName({ ...image, filename: undefined, mimeType: 'image/jpeg' })).toBe(
      'image-img-1.jpg'
    )
  })

  it('keeps only safe id characters in a generated name', () => {
    expect(imageSaveName({ ...image, id: '../x/y\nz', filename: undefined })).toBe('image-xyz.png')
    expect(imageSaveName({ ...image, id: '///', filename: undefined })).toBe('image.png')
    expect(imageSaveName({ ...image, id: 'a'.repeat(300), filename: undefined })).toBe(
      `image-${'a'.repeat(64)}.png`
    )
  })

  it('gives a file without a usable name no name at all', () => {
    expect(attachmentSaveName({ ...file, filename: undefined })).toBeNull()
    expect(attachmentSaveName({ ...file, filename: 'dir/blob.bin' })).toBeNull()
  })
})
