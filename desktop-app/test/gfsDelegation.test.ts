import { describe, expect, it } from 'vitest'
import { delegationAffordances } from '../src/gfs/delegation.js'

/**
 * P4-S07 — gfs delegation affordances. A folder owner (manage_acl holder) can
 * delegate the bits it holds; a Leader without manage_acl cannot. The UI only
 * hides controls — enforcement is server-side.
 */

describe('delegationAffordances', () => {
  it('a member WITH manage_acl can delegate the bits it holds', () => {
    const a = delegationAffordances(new Set(['read', 'write', 'manage_acl']), false)
    expect(a.canDelegate).toBe(true)
    expect(a.grantableBits).toEqual(['read', 'write', 'manage_acl'])
  })

  it('a Leader WITHOUT manage_acl cannot delegate (no controls shown)', () => {
    const a = delegationAffordances(new Set(['read', 'write']), false)
    expect(a.canDelegate).toBe(false)
    expect(a.grantableBits).toEqual([])
    expect(a.canCreateShare).toBe(false)
  })

  it('reflects no-escalation: cannot offer a bit it does not hold', () => {
    const a = delegationAffordances(new Set(['read', 'manage_acl']), false)
    expect(a.grantableBits).not.toContain('write')
    expect(a.grantableBits).not.toContain('delete')
  })

  it('can create a URI share only with the share bit', () => {
    expect(delegationAffordances(new Set(['manage_acl', 'share']), false).canCreateShare).toBe(true)
    expect(delegationAffordances(new Set(['manage_acl']), false).canCreateShare).toBe(false)
  })

  it('the operator has intrinsic full authority', () => {
    const a = delegationAffordances(new Set(), true)
    expect(a.canDelegate).toBe(true)
    expect(a.grantableBits).toEqual(['read', 'write', 'delete', 'manage_acl', 'share'])
    expect(a.canCreateShare).toBe(true)
  })
})
