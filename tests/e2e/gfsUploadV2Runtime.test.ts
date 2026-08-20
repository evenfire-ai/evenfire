import { describe, expect, it } from 'vitest'
import {
  buildGfsUploadProductMaxEnvArgs,
  parseGfsUploadProductMaxState,
  parseRenderedGfsUploadProductMax,
} from './gfsUploadV2Runtime'

function renderedDeployment(env: unknown[]): string {
  return JSON.stringify({
    spec: { template: { spec: { containers: [{ env }] } } },
  })
}

describe('GFS Upload v2 runtime product-limit helper', () => {
  it('round-trips an explicit baseline through set and restore command construction', () => {
    const baseline = parseGfsUploadProductMaxState(
      renderedDeployment([{ name: 'GFS_UPLOAD_PRODUCT_MAX_FILE_BYTES', value: '104857600' }])
    )

    expect(baseline).toEqual({ kind: 'explicit', value: 104857600 })
    expect(buildGfsUploadProductMaxEnvArgs(300 * 1024 * 1024)).toEqual([
      'CONTEXT_MAPPER_GFSC_UPLOAD_PRODUCT_MAX_FILE_BYTES=314572800',
      'CONTEXT_MAPPER_GFSC_UPLOAD_MAX_FILE_BYTES=314572800',
    ])
    expect(buildGfsUploadProductMaxEnvArgs(baseline)).toEqual([
      'CONTEXT_MAPPER_GFSC_UPLOAD_PRODUCT_MAX_FILE_BYTES=104857600',
      'CONTEXT_MAPPER_GFSC_UPLOAD_MAX_FILE_BYTES=104857600',
    ])
  })

  it('represents an absent baseline and constructs an explicit unset operation', () => {
    const baseline = parseGfsUploadProductMaxState(renderedDeployment([]))

    expect(baseline).toEqual({ kind: 'absent' })
    expect(buildGfsUploadProductMaxEnvArgs(300 * 1024 * 1024)).toEqual([
      'CONTEXT_MAPPER_GFSC_UPLOAD_PRODUCT_MAX_FILE_BYTES=314572800',
      'CONTEXT_MAPPER_GFSC_UPLOAD_MAX_FILE_BYTES=314572800',
    ])
    expect(buildGfsUploadProductMaxEnvArgs(baseline)).toEqual([
      'CONTEXT_MAPPER_GFSC_UPLOAD_PRODUCT_MAX_FILE_BYTES-',
      'CONTEXT_MAPPER_GFSC_UPLOAD_MAX_FILE_BYTES-',
    ])
  })

  it('fails closed for malformed present values instead of treating them as absent', () => {
    expect(() =>
      parseGfsUploadProductMaxState(
        renderedDeployment([{ name: 'GFS_UPLOAD_PRODUCT_MAX_FILE_BYTES', value: '' }])
      )
    ).toThrow('GFS writer rendered an invalid')
    expect(() =>
      parseGfsUploadProductMaxState(
        renderedDeployment([{ name: 'GFS_UPLOAD_PRODUCT_MAX_FILE_BYTES', value: '300MiB' }])
      )
    ).toThrow('GFS writer rendered an invalid')
  })

  it('rejects duplicate authoritative env entries and malformed deployment data', () => {
    expect(() =>
      parseRenderedGfsUploadProductMax(
        renderedDeployment([
          { name: 'GFS_UPLOAD_PRODUCT_MAX_FILE_BYTES', value: '100' },
          { name: 'GFS_UPLOAD_PRODUCT_MAX_FILE_BYTES', value: '300' },
        ])
      )
    ).toThrow('invalid rendered GFS_UPLOAD_PRODUCT_MAX_FILE_BYTES value')
    expect(() => parseRenderedGfsUploadProductMax('{"spec":{}}')).toThrow(
      'invalid rendered GFS_UPLOAD_PRODUCT_MAX_FILE_BYTES deployment shape'
    )
  })
})
