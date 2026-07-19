import { describe, expect, it } from 'vitest'
import { GFS_IMAGE_PREVIEW_MAX_BYTES } from '@constants/gfsImagePreview'
import { assertGfsImagePreviewSize, gfsImagePreviewMimeType } from '@lib/gfsImagePreview'

describe('gfsImagePreview', () => {
  it('detects supported image names', () => {
    expect(gfsImagePreviewMimeType('diagram.PNG')).toBe('image/png')
    expect(gfsImagePreviewMimeType('architecture.svg')).toBe('image/svg+xml')
  })

  it('rejects images above the preview limit', () => {
    expect(() => assertGfsImagePreviewSize(GFS_IMAGE_PREVIEW_MAX_BYTES + 1)).toThrow(
      'Image previews are limited to 10 MB.'
    )
  })
})
