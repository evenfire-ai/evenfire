import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { readImageHeaderDimensions } from '../imageHeaderDimensions'

const { declaredHeaderPng, jpegOfSize, padJpegToSize } = createRequire(__filename)(
  '../../../../../packages/llm-provider-attempt-contract/testImageFixtures.cjs'
) as {
  declaredHeaderPng: (width: number, height: number) => Buffer
  jpegOfSize: (targetBytes: number, width?: number, height?: number) => Buffer
  padJpegToSize: (jpeg: Buffer, targetBytes: number) => Buffer
}

describe('readImageHeaderDimensions', () => {
  it('reads PNG IHDR width and height from the shared fixture', () => {
    const bytes = declaredHeaderPng(2048, 256)
    expect(readImageHeaderDimensions('image/png', bytes)).toEqual({
      width: 2048,
      height: 256,
    })
  })

  it('reads a 2049 px PNG so the Codex composer can refuse it', () => {
    const bytes = declaredHeaderPng(2049, 128)
    expect(readImageHeaderDimensions('image/png', bytes)).toEqual({
      width: 2049,
      height: 128,
    })
  })

  it('reads a baseline JPEG SOF0 size', () => {
    const bytes = jpegOfSize(64, 640, 480)
    expect(readImageHeaderDimensions('image/jpeg', bytes)).toEqual({
      width: 640,
      height: 480,
    })
  })

  it('skips a COM segment and still reads JPEG dimensions', () => {
    const baseline = jpegOfSize(64, 320, 200)
    const padded = padJpegToSize(baseline, baseline.length + 16)
    expect(readImageHeaderDimensions('image/jpeg', padded)).toEqual({
      width: 320,
      height: 200,
    })
  })

  it('returns null for a truncated JPEG that never reaches SOF', () => {
    expect(readImageHeaderDimensions('image/jpeg', new Uint8Array([0xff, 0xd8, 0xff, 0xc0]))).toBe(
      null
    )
  })

  it('ignores bytes that are not a PNG or JPEG header', () => {
    expect(readImageHeaderDimensions('image/png', new Uint8Array([0x41]))).toBeNull()
    expect(readImageHeaderDimensions('image/jpeg', new Uint8Array([0x41]))).toBeNull()
  })
})
