import { describe, expect, it } from 'vitest'
import {
  legacySecurityCutoffRejects,
  legacySecurityCutoffRejectsSql,
} from '../src/services/auth/legacySecurityCutoff.js'

describe('V1 security cutoff rule', () => {
  it('rejects an iat at or before the cutoff instant and accepts the next second', () => {
    const cutoff = new Date('2030-03-17T17:46:40.250Z')
    const second = Math.floor(cutoff.getTime() / 1000)

    expect(legacySecurityCutoffRejects(second - 1, cutoff)).toBe(true)
    expect(legacySecurityCutoffRejects(second, cutoff)).toBe(true)
    expect(legacySecurityCutoffRejects(second + 1, cutoff)).toBe(false)
  })

  it('reads a text timestamp the same way as a Date', () => {
    expect(legacySecurityCutoffRejects(1_900_000_000, '2030-03-17T17:46:40.000Z')).toBe(true)
    expect(legacySecurityCutoffRejects(1_900_000_001, '2030-03-17T17:46:40.000Z')).toBe(false)
  })

  it('applies no cutoff when the user has none', () => {
    expect(legacySecurityCutoffRejects(1, null)).toBe(false)
    expect(legacySecurityCutoffRejects(1, undefined)).toBe(false)
    // Liveness witness: the same iat is rejected by a cutoff at that second.
    expect(legacySecurityCutoffRejects(1, new Date(1000))).toBe(true)
  })

  it('fails loudly on a cutoff that is not a valid instant', () => {
    expect(() => legacySecurityCutoffRejects(1, new Date(Number.NaN))).toThrow(
      'invalid V1 security cutoff'
    )
    expect(() => legacySecurityCutoffRejects(1, 'not-a-timestamp')).toThrow(
      'invalid V1 security cutoff'
    )
  })

  it('builds the same comparison in SQL', () => {
    expect(legacySecurityCutoffRejectsSql('$7::bigint', 'epoch.valid_after')).toBe(
      '$7::bigint <= EXTRACT(EPOCH FROM epoch.valid_after)'
    )
  })
})
