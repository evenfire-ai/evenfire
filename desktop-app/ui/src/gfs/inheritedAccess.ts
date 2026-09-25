import { GFS_BREADCRUMB_MAX_DEPTH } from '@constants/gfsBrowser'
import type { GfsInheritedAccessItem } from './delegation.types'
import { inheritedSubjectKey, mergeInheritedAccessItem } from './inheritedAccessMerge'

export { planInheritedRoleChange, strongestInheritedSource } from './inheritedAccessMerge'

/**
 * Derives the inherited access for one resource on the client. The user-plane
 * grants/shares GETs list only the rows configured directly on a resource, so
 * inheritance is reconstructed by walking the ancestor folders (the same
 * resolve-based walk the breadcrumb trail uses) and keeping the rows that
 * apply to descendants: grants with inherit=true and shares with
 * includeDescendants=true — the server's allow() rule. Derivation is
 * all-or-nothing: if a required ancestor or its ACL cannot be read, callers
 * must show an incomplete-access notice rather than an empty/partial result.
 * Rows are merged per subject through the pure merge core
 * (`inheritedAccessMerge.ts`, property
 * tested in R1-M4); EVERY contributing ancestor folder is kept as an editable
 * source, so a confirmed removal revokes all of them and a confirmed
 * downgrade lowers each one above the target role (R1-H1).
 */

const DEFAULT_DRIVE = 'main'

function ridOf(resourceId: string): string {
  return resourceId.replace(/-/g, '').toLowerCase()
}

/**
 * Walk semantics (R1-M1, unified with the control-ui walk in
 * control-ui/components/gfsInheritedAccess.ts):
 * - BOUNDED in depth: at most GFS_BREADCRUMB_MAX_DEPTH ancestors are visited
 *   (the control-ui path walk caps itself with the same number via
 *   GFS_INHERITED_WALK_MAX_DEPTH).
 * - COMPLETE or FAILED: every ancestor must resolve and both ACL lists must
 *   load. Any failure throws the same derivation error used by Control UI;
 *   the UI can then distinguish incomplete data from no inherited access.
 * - Desktop follows parent resource IDs and Control UI follows canonical
 *   paths, but both surfaces use the same failure rule.
 */
export async function deriveGfsInheritedAccess(
  resourceId: string,
  drive: string = DEFAULT_DRIVE
): Promise<GfsInheritedAccessItem[]> {
  const target = await window.clerum.gfs.resolve(`gfs://${drive}/${ridOf(resourceId)}`)
  const bySubject = new Map<string, GfsInheritedAccessItem>()
  const seenResourceIds = new Set([target.resourceId])
  let parentResourceId = target.parentResourceId

  while (parentResourceId && seenResourceIds.size - 1 < GFS_BREADCRUMB_MAX_DEPTH) {
    if (seenResourceIds.has(parentResourceId)) {
      throw new Error('inherited_access_derivation_failed')
    }
    seenResourceIds.add(parentResourceId)

    let parent: Awaited<ReturnType<typeof window.clerum.gfs.resolve>>
    try {
      parent = await window.clerum.gfs.resolve(`gfs://${drive}/${ridOf(parentResourceId)}`)
    } catch {
      throw new Error('inherited_access_derivation_failed')
    }
    if (parent.kind !== 'directory') throw new Error('inherited_access_derivation_failed')

    // The drive root carries an empty name; its label falls back to the drive.
    const folderLabel = parent.name || drive
    try {
      const [grants, shares] = await Promise.all([
        window.clerum.gfs.listGrants(parent.resourceId, drive),
        window.clerum.gfs.listShares(parent.resourceId, drive),
      ])
      for (const grant of grants) {
        if (!grant.inherit) continue
        merge(grant.subject, grant.permissions, grant.id, [], parent.resourceId, folderLabel)
      }
      for (const share of shares) {
        if (!share.includeDescendants) continue
        merge(share.subject, share.permissions, null, [share.id], parent.resourceId, folderLabel)
      }
    } catch {
      // A missing ACL read can hide inherited access, so do not return a
      // partial result that looks complete.
      throw new Error('inherited_access_derivation_failed')
    }

    parentResourceId = parent.parentResourceId
  }

  return [...bySubject.values()]

  /** Folds one inheriting row into the per-subject map via the pure core. */
  function merge(
    subject: { type: string; id?: string },
    permissions: string[],
    grantId: string | null,
    shareIds: string[],
    folderResourceId: string,
    folderLabel: string
  ): void {
    const key = inheritedSubjectKey(subject)
    bySubject.set(
      key,
      mergeInheritedAccessItem(
        bySubject.get(key) ?? null,
        { subject, permissions, grantId, shareIds },
        { resourceId: folderResourceId, name: folderLabel }
      )
    )
  }
}
