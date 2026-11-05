import { describe, expect, it } from 'vitest'
import { delegationAffordances } from '../../../../src/gfs/delegation.js'
import { hasExactGfsReadAuthority } from '../gfsReadAuthority'

describe('hasExactGfsReadAuthority', () => {
  it('accepts the real AppService projection when the exact held bits include read', () => {
    expect(hasExactGfsReadAuthority(delegationAffordances(new Set(['read']), false))).toBe(true)
  })

  it('rejects denied, malformed, unknown-bit, and duplicate-bit projections', () => {
    expect(hasExactGfsReadAuthority(delegationAffordances(new Set(), false))).toBe(false)
    expect(hasExactGfsReadAuthority({ held: ['read'] })).toBe(false)
    expect(
      hasExactGfsReadAuthority({
        held: ['read', 'forged'],
        canDelegate: false,
        grantableBits: [],
        canCreateShare: false,
      })
    ).toBe(false)
    expect(
      hasExactGfsReadAuthority({
        held: ['read', 'read'],
        canDelegate: false,
        grantableBits: [],
        canCreateShare: false,
      })
    ).toBe(false)
  })
})
