import { describe, expect, it } from 'vitest'
import { assertGfsFileUploadSize } from '@lib/gfsFileUpload'

describe('assertGfsFileUploadSize', () => {
  it('allows product-policy decisions through the 1 GiB protocol maximum', () => {
    expect(() => assertGfsFileUploadSize(250 * 1024 * 1024)).not.toThrow()
    expect(() => assertGfsFileUploadSize(1024 * 1024 * 1024)).not.toThrow()
  })

  it('rejects files above the absolute protocol maximum', () => {
    expect(() => assertGfsFileUploadSize(1024 * 1024 * 1024 + 1)).toThrow(
      'GFS uploads cannot exceed the 1 GiB Upload v2 protocol maximum.'
    )
  })
})
