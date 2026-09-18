import { describe, expect, it } from 'vitest'
import { readImageHeaderDimensions } from '../imageHeaderDimensions'

function pngIhdrStub(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(8 + 8 + 13)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  const view = new DataView(bytes.buffer)
  view.setUint32(8, 13)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

describe('readImageHeaderDimensions', () => {
  it('reads PNG IHDR width and height', () => {
    expect(readImageHeaderDimensions('image/png', pngIhdrStub(2048, 256))).toEqual({
      width: 2048,
      height: 256,
    })
  })

  it('reads a 2049 px PNG so the composer can refuse it', () => {
    expect(readImageHeaderDimensions('image/png', pngIhdrStub(2049, 128))).toEqual({
      width: 2049,
      height: 128,
    })
  })

  it('ignores bytes that are not a PNG or JPEG header', () => {
    expect(readImageHeaderDimensions('image/png', new Uint8Array([0x41]))).toBeNull()
    expect(readImageHeaderDimensions('image/jpeg', new Uint8Array([0x41]))).toBeNull()
  })
})
