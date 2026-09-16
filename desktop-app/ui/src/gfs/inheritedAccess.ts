import { GFS_BREADCRUMB_MAX_DEPTH } from '@constants/gfsBrowser'
import type { GfsInheritedAccessItem, GfsInheritedAccessSource } from './delegation.types'

/**
 * Derives the inherited access for one resource on the client. The user-plane
 * grants/shares GETs list only the rows configured directly on a resource, so
 * inheritance is reconstructed by walking the ancestor folders (the same
 * resolve-based walk the breadcrumb trail uses) and keeping the rows that
 * apply to descendants: grants with inherit=true and shares with
 * includeDescendants=true — the server's allow() rule. The walk is
 * best-effort: ancestors this caller cannot resolve or whose ACL it may not
 * view (view-ACL = manage-ACL server-side) are skipped. Each subject keeps
 * the strongest contributing folder as its editable `source` (with the
 * grant/share ids to mutate), so a confirmed change is applied on the folder
 * that configures the access.
 */

const DEFAULT_DRIVE = 'main'

function ridOf(resourceId: string): string {
  return resourceId.replace(/-/g, '').toLowerCase()
}

function subjectKey(subject: { type: string; id?: string }): string {
  return `${subject.type}:${subject.id ?? ''}`
}

/** Editor-strength rows (write/delete/manage_acl) outrank read-only rows. */
function isEditorPermissions(permissions: string[]): boolean {
  return permissions.some(permission => ['write', 'delete', 'manage_acl'].includes(permission))
}

interface InheritingRow {
  subject: { type: string; id?: string }
  permissions: string[]
  grantId: string | null
  shareIds: string[]
}

function sourceFor(
  row: InheritingRow,
  folderResourceId: string,
  folderLabel: string
): GfsInheritedAccessSource {
  return {
    resourceId: folderResourceId,
    name: folderLabel,
    permissions: [...row.permissions],
    grantId: row.grantId,
    shareIds: [...row.shareIds],
  }
}

function mergeInto(
  bySubject: Map<string, GfsInheritedAccessItem>,
  row: InheritingRow,
  folderResourceId: string,
  folderLabel: string
): void {
  const key = subjectKey(row.subject)
  const existing = bySubject.get(key)
  if (!existing) {
    bySubject.set(key, {
      subject: row.subject,
      permissions: [...row.permissions],
      inheritedFrom: [folderLabel],
      source: sourceFor(row, folderResourceId, folderLabel),
    })
    return
  }
  existing.permissions = [...new Set([...existing.permissions, ...row.permissions])]
  if (!existing.inheritedFrom.includes(folderLabel)) {
    existing.inheritedFrom.push(folderLabel)
  }
  if (existing.source.resourceId === folderResourceId) {
    // A grant and a share for one subject on the same folder are edited
    // together: union the ids so the change consolidates both rows.
    existing.source = {
      ...existing.source,
      permissions: [...new Set([...existing.source.permissions, ...row.permissions])],
      grantId: existing.source.grantId ?? row.grantId,
      shareIds: [...new Set([...existing.source.shareIds, ...row.shareIds])],
    }
  } else if (
    !isEditorPermissions(existing.source.permissions) &&
    isEditorPermissions(row.permissions)
  ) {
    // The editable source is the strongest contributing folder (nearest
    // among equals): editing a weaker ancestor could not change the
    // subject's effective access.
    existing.source = sourceFor(row, folderResourceId, folderLabel)
  }
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
        mergeInto(
          bySubject,
          {
            subject: grant.subject,
            permissions: grant.permissions,
            grantId: grant.id,
            shareIds: [],
          },
          parent.resourceId,
          folderLabel
        )
      }
      for (const share of shares) {
        if (!share.includeDescendants) continue
        mergeInto(
          bySubject,
          {
            subject: share.subject,
            permissions: share.permissions,
            grantId: null,
            shareIds: [share.id],
          },
          parent.resourceId,
          folderLabel
        )
      }
    } catch {
      // Viewing an ancestor's ACL requires manage_acl on it; an ancestor
      // this caller may not view contributes no rows.
    }

    parentResourceId = parent.parentResourceId
  }

  return [...bySubject.values()]
}
