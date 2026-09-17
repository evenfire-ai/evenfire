import {
  type GfsResourceByPathView,
  getGfsGrants,
  getGfsResourceByPath,
  getGfsShares,
} from '@lib/api'
import type { GfsSubjectInput } from '@lib/api'
import type { GfsInheritedAccessItem } from './GfsGrantPanel.types'

/**
 * Frontend inheritance derivation for the Share dialog. The grants/shares GETs
 * list only the rows configured directly on one resource, so a file's
 * inherited access is derived by walking the ancestor folders of the
 * resource's canonical path and keeping the rows that apply to descendants
 * (grants with inherit=true, shares with includeDescendants=true — the same
 * rule the server's allow() evaluation uses). Rows are merged per subject and
 * each subject keeps the strongest contributing folder as its editable
 * `source` (with the grant/share ids to mutate), so a confirmed change is
 * applied on the folder that configures the access.
 */

/** `/docs/report.md` → `['/docs', '/']` (nearest ancestor first). */
export function gfsAncestorPaths(path: string): string[] {
  const segments = (path.startsWith('/') ? path : `/${path}`)
    .split('/')
    .filter(segment => segment.length > 0)
  if (segments.length === 0) return []
  const ancestors: string[] = []
  for (let count = segments.length - 1; count > 0; count -= 1) {
    ancestors.push(`/${segments.slice(0, count).join('/')}`)
  }
  ancestors.push('/')
  return ancestors
}

/** Stable per-subject merge key. Mirrors the panel's direct-row subject key. */
function inheritedSubjectKey(subject: GfsSubjectInput): string {
  return `${subject.type}:${'id' in subject ? subject.id : ''}`
}

/** Editor-strength rows (write/delete/manage_acl) outrank read-only rows. */
function isEditorPermissions(permissions: string[]): boolean {
  return permissions.some(permission => ['write', 'delete', 'manage_acl'].includes(permission))
}

/** One inheriting row on an ancestor folder, carrying its mutable row ids. */
interface InheritingRow {
  subject: GfsSubjectInput
  permissions: string[]
  grantId: string | null
  shareIds: string[]
}

async function listInheritingRows(
  folder: GfsResourceByPathView,
  drive: string,
  signal?: AbortSignal
): Promise<InheritingRow[]> {
  const [grants, shares] = await Promise.all([
    getGfsGrants(folder.resourceId, drive, signal),
    getGfsShares(folder.resourceId, drive, signal),
  ])
  return [
    ...grants.items
      .filter(grant => grant.inherit)
      .map(grant => ({
        subject: grant.subject,
        permissions: grant.permissions,
        grantId: grant.id,
        shareIds: [],
      })),
    ...shares.items
      .filter(share => share.includeDescendants)
      .map(share => ({
        subject: share.subject,
        permissions: share.permissions,
        grantId: null,
        shareIds: [share.id],
      })),
  ]
}

/**
 * Derives the inherited access for one resource path. Ancestors that cannot be
 * resolved or listed (moved, deleted, rate-limited) are skipped — the walk is
 * best-effort. A walk that resolves NO ancestor at all learned nothing about
 * the file's ancestry and throws, so the caller can say the derivation failed
 * instead of trusting an empty list (R1-M3). The drive root carries an empty
 * name, so its label falls back to the drive name, matching the browser
 * breadcrumb.
 */
export async function loadGfsInheritedAccess(
  path: string,
  drive: string,
  signal?: AbortSignal
): Promise<GfsInheritedAccessItem[]> {
  const bySubject = new Map<string, GfsInheritedAccessItem>()
  const ancestorPaths = gfsAncestorPaths(path)
  let resolvedAncestors = 0
  for (const ancestorPath of ancestorPaths) {
    let folder: GfsResourceByPathView
    try {
      folder = await getGfsResourceByPath(drive, ancestorPath, signal)
    } catch (error) {
      if (signal?.aborted) throw error
      continue
    }
    resolvedAncestors += 1
    let rows: InheritingRow[]
    try {
      rows = await listInheritingRows(folder, drive, signal)
    } catch (error) {
      if (signal?.aborted) throw error
      continue
    }
    const folderLabel = folder.name || drive
    for (const row of rows) {
      const key = inheritedSubjectKey(row.subject)
      const existing = bySubject.get(key)
      if (!existing) {
        bySubject.set(key, {
          subject: row.subject,
          permissions: [...row.permissions],
          inheritedFrom: [folderLabel],
          source: {
            resourceId: folder.resourceId,
            name: folderLabel,
            permissions: [...row.permissions],
            grantId: row.grantId,
            shareIds: [...row.shareIds],
          },
        })
        continue
      }
      existing.permissions = [...new Set([...existing.permissions, ...row.permissions])]
      if (!existing.inheritedFrom.includes(folderLabel)) {
        existing.inheritedFrom.push(folderLabel)
      }
      const sameFolder = existing.source.resourceId === folder.resourceId
      if (sameFolder) {
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
        existing.source = {
          resourceId: folder.resourceId,
          name: folderLabel,
          permissions: [...row.permissions],
          grantId: row.grantId,
          shareIds: [...row.shareIds],
        }
      }
    }
  }
  // Every ancestor path failed to resolve: the derivation as a whole
  // failed. An empty list here would silently read as "no inherited
  // access", so the caller gets a failure it can surface (R1-M3).
  if (ancestorPaths.length > 0 && resolvedAncestors === 0) {
    throw new Error('inherited_access_derivation_failed')
  }
  return [...bySubject.values()]
}
