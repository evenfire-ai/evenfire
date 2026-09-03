import { describe, expect, it } from 'vitest'
import {
  GFS_UPLOAD_V2_DEFAULT_CONCURRENCY,
  GFS_UPLOAD_V2_DEFAULT_PRODUCT_MAX_BYTES,
  GFS_UPLOAD_V2_FALLBACK_CONCURRENCY,
  GFS_UPLOAD_V2_INSTABILITY_FAILURE_THRESHOLD,
  GFS_UPLOAD_V2_MAX_PART_BYTES,
  GFS_UPLOAD_V2_PREFERRED_PART_BYTES,
  GFS_UPLOAD_V2_PROTOCOL_MAX_BYTES,
  GfsUploadGeometryError,
  disabledGfsUploadV2Capability,
  isGfsUploadV2Route,
  partCountFor,
  partGeometry,
  validateGeometry,
  validatePartGeometry,
} from './protocol'

describe('GFS Upload v2 frozen contract', () => {
  it('uses binary product/request boundaries without advertising v2', () => {
    expect(GFS_UPLOAD_V2_DEFAULT_PRODUCT_MAX_BYTES).toBe(209_715_200)
    expect(GFS_UPLOAD_V2_PROTOCOL_MAX_BYTES).toBe(1_073_741_824)
    expect(GFS_UPLOAD_V2_PREFERRED_PART_BYTES).toBe(8_388_608)
    expect(GFS_UPLOAD_V2_MAX_PART_BYTES).toBe(16_777_216)
    expect(GFS_UPLOAD_V2_DEFAULT_CONCURRENCY).toBe(4)
    expect(GFS_UPLOAD_V2_FALLBACK_CONCURRENCY).toBe(2)
    expect(GFS_UPLOAD_V2_INSTABILITY_FAILURE_THRESHOLD).toBe(3)
    expect(disabledGfsUploadV2Capability()).toEqual({
      enabled: false,
      maxFileBytes: 0,
      preferredChunkBytes: 0,
      maxChunkBytes: 0,
    })
  })

  it('calculates exact 8 MiB geometry at the product boundary', () => {
    const geometry = {
      expectedBytes: GFS_UPLOAD_V2_DEFAULT_PRODUCT_MAX_BYTES,
      partBytes: GFS_UPLOAD_V2_PREFERRED_PART_BYTES,
    }
    expect(partCountFor(geometry)).toBe(25)
    expect(partGeometry(geometry, 0)).toEqual({
      partNumber: 0,
      offsetBytes: 0,
      lengthBytes: 8_388_608,
    })
    expect(partGeometry(geometry, 24)).toEqual({
      partNumber: 24,
      offsetBytes: 201_326_592,
      lengthBytes: 8_388_608,
    })
    expect(() => partGeometry(geometry, 25)).toThrow('invalid part number')
  })

  it('enforces the hard whole-file protocol ceiling in the geometry validator', () => {
    expect(() =>
      validateGeometry({
        expectedBytes: GFS_UPLOAD_V2_PROTOCOL_MAX_BYTES,
        partBytes: GFS_UPLOAD_V2_MAX_PART_BYTES,
      })
    ).not.toThrow()

    expect(() =>
      validateGeometry({
        expectedBytes: GFS_UPLOAD_V2_PROTOCOL_MAX_BYTES + 1,
        partBytes: GFS_UPLOAD_V2_MAX_PART_BYTES,
      })
    ).toThrowError(
      expect.objectContaining({
        name: 'GfsUploadGeometryError',
        code: 'invalid_expected_bytes',
      }) as GfsUploadGeometryError
    )
  })

  it('accepts a short final part and rejects mismatched offset or length', () => {
    const geometry = { expectedBytes: 8_388_609, partBytes: 8_388_608 }
    const finalPart = partGeometry(geometry, 1)
    expect(finalPart).toEqual({ partNumber: 1, offsetBytes: 8_388_608, lengthBytes: 1 })
    expect(() => validatePartGeometry(geometry, { ...finalPart, offsetBytes: 0 })).toThrow(
      'offset must be 8388608'
    )
    expect(() => validatePartGeometry(geometry, { ...finalPart, lengthBytes: 8_388_608 })).toThrow(
      'length must be 1'
    )
  })

  it('pins the preferred and hard part boundaries and rejects invalid geometry deterministically', () => {
    const preferred = {
      expectedBytes: GFS_UPLOAD_V2_PREFERRED_PART_BYTES,
      partBytes: GFS_UPLOAD_V2_PREFERRED_PART_BYTES,
    }
    expect(partCountFor(preferred)).toBe(1)
    expect(partGeometry(preferred, 0).lengthBytes).toBe(GFS_UPLOAD_V2_PREFERRED_PART_BYTES)

    const hardMaximum = {
      expectedBytes: GFS_UPLOAD_V2_MAX_PART_BYTES,
      partBytes: GFS_UPLOAD_V2_MAX_PART_BYTES,
    }
    expect(partCountFor(hardMaximum)).toBe(1)
    expect(partGeometry(hardMaximum, 0).lengthBytes).toBe(GFS_UPLOAD_V2_MAX_PART_BYTES)

    expect(() => validateGeometry({ expectedBytes: 1, partBytes: 0 })).toThrow(
      'partBytes must be an integer'
    )
    expect(() =>
      validateGeometry({
        expectedBytes: GFS_UPLOAD_V2_MAX_PART_BYTES,
        partBytes: GFS_UPLOAD_V2_MAX_PART_BYTES + 1,
      })
    ).toThrow('partBytes must be an integer')
    expect(() =>
      partGeometry({ expectedBytes: 0, partBytes: GFS_UPLOAD_V2_PREFERRED_PART_BYTES }, 0)
    ).toThrow('invalid part number')
  })

  it.each([
    [0, 1 * 1024 * 1024],
    [1, 1 * 1024 * 1024],
    [1_048_577, 1 * 1024 * 1024],
    [16 * 1024 * 1024 + 1, 8 * 1024 * 1024],
    [209_715_200, 16 * 1024 * 1024],
  ])('keeps generated geometry contiguous for expected=%d part=%d', (expectedBytes, partBytes) => {
    const geometry = { expectedBytes, partBytes }
    const count = partCountFor(geometry)
    const parts = Array.from({ length: count }, (_, partNumber) =>
      partGeometry(geometry, partNumber)
    )
    expect(parts.reduce((sum, part) => sum + part.lengthBytes, 0)).toBe(expectedBytes)
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index]!
      expect(part.offsetBytes).toBe(
        index === 0 ? 0 : parts[index - 1]!.offsetBytes + parts[index - 1]!.lengthBytes
      )
      expect(part.lengthBytes).toBeGreaterThan(0)
      expect(part.lengthBytes).toBeLessThanOrEqual(partBytes)
      validatePartGeometry(geometry, part)
    }
  })

  it('recognizes only the exact v2 routes', () => {
    expect(isGfsUploadV2Route('/v1/capabilities')).toBe(true)
    expect(isGfsUploadV2Route('/v1/uploads')).toBe(true)
    expect(isGfsUploadV2Route('/v1/uploads/01234567-89ab-cdef-0123-456789abcdef/parts/0')).toBe(
      true
    )
    expect(isGfsUploadV2Route('/v1/resources/0123456789abcdef0123456789abcdef')).toBe(false)
    expect(isGfsUploadV2Route('/v1/uploads/not-an-id/parts/0')).toBe(false)
    expect(isGfsUploadV2Route('/v1/uploads/------------------------------------/parts/0')).toBe(
      false
    )
  })
})
