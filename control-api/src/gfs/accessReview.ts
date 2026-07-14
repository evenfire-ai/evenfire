/**
 * gfs access review (spec plan §Security and compliance; plan P5-S03). Produces
 * the periodic "effective grants per subject" report — for each subject, every
 * grant it holds (with the resource and the inherit flag, which is what makes a
 * grant reach a subtree). Pure aggregation over the grant rows.
 */

export interface GrantRecord {
  subjectKey: string
  resourceId: string
  permissions: string[]
  inherit: boolean
}

export interface SubjectGrant {
  resourceId: string
  permissions: string[]
  /** Inheriting grants reach the whole subtree below resourceId. */
  inherit: boolean
}

export interface SubjectAccess {
  subjectKey: string
  grants: SubjectGrant[]
  /** Union of all permission bits the subject holds anywhere (review summary). */
  effectiveBits: string[]
}

/**
 * Group grants by subject into the access-review report. Subjects are returned
 * in sorted order for stable reporting; each subject's grants list is the basis
 * for "who can reach what", including inheriting (subtree-reaching) grants.
 */
export function effectiveGrantsPerSubject(grants: GrantRecord[]): SubjectAccess[] {
  const bySubject = new Map<string, SubjectGrant[]>()
  for (const g of grants) {
    const list = bySubject.get(g.subjectKey) ?? []
    list.push({ resourceId: g.resourceId, permissions: [...g.permissions], inherit: g.inherit })
    bySubject.set(g.subjectKey, list)
  }
  return [...bySubject.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([subjectKey, subjectGrants]) => ({
      subjectKey,
      grants: subjectGrants,
      effectiveBits: Array.from(new Set(subjectGrants.flatMap((sg) => sg.permissions))).sort(),
    }))
}
