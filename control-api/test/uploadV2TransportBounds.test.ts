import { describe, expect, it } from 'vitest'
import { assertUploadV2TransportBounds } from './helpers/uploadV2TransportBounds.js'

describe('Upload v2 transport-bound non-vacuity', () => {
  const valid = {
    writerProtocol: 1024 * 1024 * 1024,
    writerPart: 16 * 1024 * 1024,
    protocolMirrors: [1024 * 1024 * 1024],
    partMirrors: [16 * 1024 * 1024],
    relayBounds: [{ fallback: 16 * 1024 * 1024, ceiling: 16 * 1024 * 1024 }],
    gatewayBytes: 24 * 1024 * 1024,
  }

  it('accepts a complete aligned producer chain', () => {
    expect(() => assertUploadV2TransportBounds(valid)).not.toThrow()
  })

  it.each(['protocolMirrors', 'partMirrors', 'relayBounds'] as const)(
    'rejects an empty %s producer list',
    field => {
      expect(() => assertUploadV2TransportBounds({ ...valid, [field]: [] })).toThrow(
        /at least one producer/
      )
    }
  )

  it.each([
    ['writer part above its relay', { writerPart: 17 * 1024 * 1024 }],
    ['client part above its relay', { partMirrors: [17 * 1024 * 1024] }],
    ['undersized relay', { relayBounds: [{ fallback: 15, ceiling: 15 }] }],
    ['undersized gateway', { gatewayBytes: 16 * 1024 * 1024 }],
  ])('rejects %s', (_label, mutation) => {
    expect(() => assertUploadV2TransportBounds({ ...valid, ...mutation })).toThrow()
  })
})
