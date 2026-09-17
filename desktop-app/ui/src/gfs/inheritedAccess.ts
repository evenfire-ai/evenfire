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
 * includeDescendants=true — the server's allow() rule. The walk is
 * best-effort: ancestors this caller cannot resolve or whose ACL it may not
 * view (view-ACL = manage-ACL server-side) are skipped. Rows are merged per
 * subject through the pure merge core (`inheritedAccessMerge.ts`, property
 * tested in R1-M2); EVERY contributing ancestor folder is kept as an editable
 * source, so a confirmed removal revokes all of them and a confirmed
 * downgrade lowers each one above the target role (R1-H1).
 */

const DEFAULT_DRIVE = 'main'

function ridOf(resourceId: string): string {
  return resourceId.replace(/-/g, '').toLowerCase()
}

export async function deriveGfsInheritedAccess(
  resourceId: string,
  drive: string = DEFAULT_DRIVE
): Promise<GfsInheritedAccessItem[]> {
  const target = await window.clerum.gfs.resolve(`gfs://${drive}/${ridOf(resourceId)}`)
  const bySubject = new Map<string, GfsInheritedAccessItem>()
  const seenResourceIds = new Set([target.resourceId])
  let parentResourceId = target.parentResourceId

  while (parentResourceId && seenResourceIds.size - 1 < GFS_BREADCRUMB_MAX_DEPTH) {
    if (seenResourceIds.has(parentResourceId)) break
    seenResourceIds.add(parentResourceId)

    let parent: Awaited<ReturnType<typeof window.clerum.gfs.resolve>>
    try {
      parent = await window.clerum.gfs.resolve(`gfs://${drive}/${ridOf(parentResourceId)}`)
    } catch {
      // A direct file grant can be readable while its parent is not; stop at
      // the first ancestor the caller may not resolve.
      break
    }
    if (parent.kind !== 'directory') break

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
      // Viewing an ancestor's ACL requires manage_acl on it; an ancestor
      // this caller may not view contributes no rows.
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
