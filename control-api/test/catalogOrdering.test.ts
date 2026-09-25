import { describe, expect, it } from 'vitest'
import { mergeCatalogCandidateStreams } from '../src/services/access/accessCatalogMerge.js'
import {
  catalogKey,
  catalogKeyEquals,
  compareCatalogKey,
} from '../src/services/access/catalogContracts.js'

const environmentId = 'cluster.local/evenfire'

function byteOrder(left: string, right: string): number {
  const encoder = new TextEncoder()
  const leftBytes = encoder.encode(left)
  const rightBytes = encoder.encode(right)
  for (let index = 0; index < Math.min(leftBytes.length, rightBytes.length); index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return leftBytes[index]! - rightBytes[index]!
  }
  return leftBytes.length - rightBytes.length
}

describe('catalog UTF-8 byte ordering contract', () => {
  it('uses exact identity and byte order for mixed-case and canonically equivalent keys', () => {
    const zeta = catalogKey(environmentId, 'host', 'ns/Zeta')
    const alpha = catalogKey(environmentId, 'host', 'ns/alpha')
    const composed = catalogKey(environmentId, 'host', 'ns/e\u0301')
    const precomposed = catalogKey(environmentId, 'host', 'ns/é')

    expect(Math.sign(compareCatalogKey(zeta, alpha))).toBe(
      Math.sign(byteOrder('ns/Zeta', 'ns/alpha'))
    )
    expect(catalogKeyEquals(composed, precomposed)).toBe(false)

    const stream = [zeta, alpha].map(key => ({
      key,
      canonicalId: `host:${key[2]}`,
      validUntil: null,
    }))
    expect(mergeCatalogCandidateStreams([{ streamId: 'host', candidates: stream }], 2)).toEqual(
      stream
    )
  })
})
