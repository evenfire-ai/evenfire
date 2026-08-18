import { describe, expect, it } from 'vitest'
import { validateGfsRuntimeImageMarker } from '../../../tests/e2e/gfsUploadV2Runtime'

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
