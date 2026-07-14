import { describe, expect, it } from 'vitest'
import { ErasureError, planErasure } from '../src/gfs/erasure.js'

/**
 * P5-S03 — hard-delete/erasure. Purges every object version (GDPR) and emits a
 * NON-content audit row (records the erasure, never the erased bytes).
 */

describe('planErasure', () => {
  it('purges all object versions and emits a non-content audit row', () => {
    const plan = planErasure('res-1', ['res-1/v1', 'res-1/v2', 'res-1/v3'])
    expect(plan.purgeKeys).toHaveLength(3)
    expect(plan.auditEntry).toEqual({
      op: 'erasure',
      resourceId: 'res-1',
      outcome: 'erased',
      containsContent: false,
      versionsPurged: 3,
    })
  })

  it('records the erasure even when there are zero stored versions', () => {
    const plan = planErasure('res-1', [])
    expect(plan.auditEntry.versionsPurged).toBe(0)
    expect(plan.auditEntry.containsContent).toBe(false)
  })

  it('rejects a missing resourceId', () => {
    expect(() => planErasure('', [])).toThrow(ErasureError)
  })
})
