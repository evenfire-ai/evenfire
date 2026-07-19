import { describe, expect, it } from 'vitest'
import { GFS_IMAGE_PREVIEW_MAX_BYTES } from '@constants/gfsImagePreview'
import { assertGfsImagePreviewSize, gfsImagePreviewMimeType } from '@lib/gfsImagePreview'

describe('gfsImagePreviewMimeType', () => {
  it.each([
    ['photo.avif', 'image/avif'],
    ['scan.bmp', 'image/bmp'],
    ['animation.gif', 'image/gif'],
    ['photo.jpeg', 'image/jpeg'],
    ['photo.JPG', 'image/jpeg'],
    ['avatar.png', 'image/png'],
    ['diagram.svg', 'image/svg+xml'],
    ['image.webp', 'image/webp'],
  ])('maps %s to %s', (fileName, expected) => {
    expect(gfsImagePreviewMimeType(fileName)).toBe(expected)
  })

  it.each(['README', 'report.pdf', 'notes.txt'])('does not preview %s as an image', fileName => {
    expect(gfsImagePreviewMimeType(fileName)).toBeNull()
  })
})

describe('assertGfsImagePreviewSize', () => {
  it('rejects images above the preview limit', () => {
    expect(() => assertGfsImagePreviewSize(GFS_IMAGE_PREVIEW_MAX_BYTES + 1)).toThrow(
      'Image previews are limited to 10 MB.'
    )
  })
})
