import { describe, expect, it } from 'vitest'
import { effectiveGrantsPerSubject, type GrantRecord } from '../src/gfs/accessReview.js'

/**
 * P5-S03 — access review. The "effective grants per subject" report groups
 * grants by subject, including inheriting (subtree-reaching) grants, with a
 * union of effective bits.
 */

const grants: GrantRecord[] = [
  { subjectKey: 'user:ana', resourceId: 'eng', permissions: ['read', 'write', 'manage_acl'], inherit: true },
  { subjectKey: 'team:t1', resourceId: 'reports', permissions: ['read'], inherit: false },
  { subjectKey: 'user:ana', resourceId: 'q3', permissions: ['delete'], inherit: false },
]

describe('effectiveGrantsPerSubject', () => {
  it('groups grants by subject and unions effective bits', () => {
    const report = effectiveGrantsPerSubject(grants)
    const ana = report.find((r) => r.subjectKey === 'user:ana')!
    expect(ana.grants).toHaveLength(2)
    expect(ana.effectiveBits).toEqual(['delete', 'manage_acl', 'read', 'write'])
  })

  it('preserves the inherit flag (subtree-reaching grants)', () => {
    const report = effectiveGrantsPerSubject(grants)
    const ana = report.find((r) => r.subjectKey === 'user:ana')!
    const engGrant = ana.grants.find((g) => g.resourceId === 'eng')!
    expect(engGrant.inherit).toBe(true)
  })

  it('returns subjects in stable sorted order', () => {
    const report = effectiveGrantsPerSubject(grants)
    expect(report.map((r) => r.subjectKey)).toEqual(['team:t1', 'user:ana'])
  })

  it('is empty for no grants', () => {
    expect(effectiveGrantsPerSubject([])).toEqual([])
  })
})
