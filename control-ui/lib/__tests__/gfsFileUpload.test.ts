import { describe, expect, it } from 'vitest'
import { GFS_FILE_UPLOAD_MAX_BYTES } from '@constants/gfsFileUpload'
import { assertGfsFileUploadSize } from '@lib/gfsFileUpload'

describe('assertGfsFileUploadSize', () => {
  it('accepts files at the upload limit', () => {
    expect(() => assertGfsFileUploadSize(GFS_FILE_UPLOAD_MAX_BYTES)).not.toThrow()
  })

  it('rejects files above the upload limit', () => {
    expect(() => assertGfsFileUploadSize(GFS_FILE_UPLOAD_MAX_BYTES + 1)).toThrow(
      'GFS uploads are limited to 10 MB per file.'
    )
  })
})
