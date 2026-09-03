import { describe, expect, it } from 'vitest'
import {
  GFS_UPLOAD_V2_PROTOCOL_MAX_BYTES,
  validateGfsRuntimeImageMarker,
  validateGfsUploadProductMaxBytes,
} from '../../../tests/e2e/gfsUploadV2Runtime'

const base = {
  clusterFingerprint: 'cluster-a',
  imagesGeneratedAt: '2026-08-12T18:00:00Z',
}

describe('GFS Upload v2 runtime image marker contract', () => {
  it('accepts local image mode without a registry tag', () => {
    expect(() =>
      validateGfsRuntimeImageMarker({ ...base, imageSource: 'local', imageTag: '' })
    ).not.toThrow()
  })

  it('requires an immutable tag for GHCR image mode', () => {
    expect(() =>
      validateGfsRuntimeImageMarker({ ...base, imageSource: 'ghcr', imageTag: '' })
    ).toThrow(/GHCR image marker/)
  })

  it('rejects a marker that omits the imageTag field entirely', () => {
    expect(() => validateGfsRuntimeImageMarker({ ...base, imageSource: 'local' })).toThrow(
      /lacks cluster fingerprint/
    )
  })

  it('rejects an image source outside the supported acquisition modes', () => {
    expect(() =>
      validateGfsRuntimeImageMarker({ ...base, imageSource: 'unknown', imageTag: '' })
    ).toThrow(/unsupported imageSource/)
  })

  it('rejects a marker whose fingerprint or image acquisition stamp is stale', () => {
    expect(() =>
      validateGfsRuntimeImageMarker(
        { ...base, imageSource: 'local', imageTag: '' },
        { imageSource: 'local', imageTag: '', clusterFingerprint: 'cluster-b' }
      )
    ).toThrow(/clusterFingerprint/)
    expect(() =>
      validateGfsRuntimeImageMarker(
        { ...base, imageSource: 'local', imageTag: '' },
        { imagesGeneratedAt: '2026-08-12T19:00:00Z' }
      )
    ).toThrow(/imagesGeneratedAt/)
  })
})

describe('GFS Upload v2 runtime product maximum contract', () => {
  it.each([1, 100 * 1024 * 1024, 200 * 1024 * 1024, 300 * 1024 * 1024])(
    'accepts a bounded integer product maximum of %i bytes',
    value => {
      expect(validateGfsUploadProductMaxBytes(value)).toBe(value)
    }
  )

  it('accepts the exact protocol maximum', () => {
    expect(validateGfsUploadProductMaxBytes(GFS_UPLOAD_V2_PROTOCOL_MAX_BYTES)).toBe(
      GFS_UPLOAD_V2_PROTOCOL_MAX_BYTES
    )
  })

  it.each([
    0,
    -1,
    1.5,
    GFS_UPLOAD_V2_PROTOCOL_MAX_BYTES + 1,
    Number.MAX_SAFE_INTEGER + 1,
    '209715200',
    null,
    undefined,
  ])('rejects invalid product maximum %p before mutating a runtime', value => {
    expect(() => validateGfsUploadProductMaxBytes(value)).toThrow(/invalid GFS Upload v2/)
  })
})
