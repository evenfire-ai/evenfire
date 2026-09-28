import {
  type GfsResourceByPathView,
  getGfsGrants,
  getGfsResourceByPath,
  getGfsShares,
} from '@lib/api'
import type { GfsInheritedAccessItem } from './GfsGrantPanel.types'
import { inheritedSubjectKey, mergeInheritedAccessItem } from './gfsInheritedAccessMerge'

export { planInheritedRoleChange, strongestInheritedSource } from './gfsInheritedAccessMerge'

/**
 * Frontend inheritance derivation for the Share dialog. The grants/shares GETs
 * list only the rows configured directly on one resource, so a file's
 * inherited access is derived by walking the ancestor folders of the
 * resource's canonical path and keeping the rows that apply to descendants
 * (grants with inherit=true, shares with includeDescendants=true — the same
 * rule the server's allow() evaluation uses). Rows are merged per subject
 * through the pure merge core (`gfsInheritedAccessMerge.ts`, property tested
 * in R1-M4); EVERY contributing ancestor folder is kept as an editable source
 * (with the grant/share ids to mutate), so a confirmed removal revokes all of
 * them and a confirmed downgrade lowers each one above the target role
 * (R1-H1). If any required ancestor or ACL read fails, the derivation fails
 * visibly instead of returning a result that looks complete.
 */

/**
 * Walk semantics (R1-M1, unified with the desktop walk in
 * desktop-app/ui/src/gfs/inheritedAccess.ts):
 * - BOUNDED in depth: at most GFS_INHERITED_WALK_MAX_DEPTH ancestors are
 *   visited (the desktop rid-chain walk bounds itself with the same number
 *   via GFS_BREADCRUMB_MAX_DEPTH).
 * - COMPLETE or FAILED: every ancestor path must resolve to a directory and
 *   both ACL lists must load. Any failure throws the same derivation error as
 *   Desktop, so the UI cannot mistake partial data for no inherited access.
 * - This walk addresses ancestors by canonical PATH while Desktop follows
 *   parent resource IDs. The traversal differs, but the failure contract is
 *   shared.
 */
const GFS_INHERITED_WALK_MAX_DEPTH = 64

/** `/docs/report.md` → `['/docs', '/']` (nearest ancestor first, depth-capped). */
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
  // Nearest-first cap, mirroring the desktop rid-chain walk's bound.
  return ancestors.slice(0, GFS_INHERITED_WALK_MAX_DEPTH)
}

interface InheritingRow {
  subject: { type: string; id?: string }
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
 * Derives inherited access only when every ancestor and ACL list is available.
 * Any incomplete walk throws `inherited_access_derivation_failed`, so the
 * caller can distinguish a read failure from a complete empty result. The
 * drive root carries an empty name, so its label falls back to the drive name,
 * matching the browser breadcrumb.
 */
export async function loadGfsInheritedAccess(
  path: string,
  drive: string,
  signal?: AbortSignal
): Promise<GfsInheritedAccessItem[]> {
  const bySubject = new Map<string, GfsInheritedAccessItem>()
  const ancestorPaths = gfsAncestorPaths(path)
  for (const ancestorPath of ancestorPaths) {
    let folder: GfsResourceByPathView
    try {
      folder = await getGfsResourceByPath(drive, ancestorPath, signal)
    } catch (error) {
      if (signal?.aborted) throw error
      throw new Error('inherited_access_derivation_failed')
    }
    if (folder.kind !== 'directory') {
      throw new Error('inherited_access_derivation_failed')
    }
    let rows: InheritingRow[]
    try {
      rows = await listInheritingRows(folder, drive, signal)
    } catch (error) {
      if (signal?.aborted) throw error
      throw new Error('inherited_access_derivation_failed')
    }
    const folderLabel = folder.name || drive
    for (const row of rows) {
      const key = inheritedSubjectKey(row.subject)
      bySubject.set(
        key,
        mergeInheritedAccessItem(bySubject.get(key) ?? null, row, {
          resourceId: folder.resourceId,
          name: folderLabel,
        })
      )
    }
  }
  return [...bySubject.values()]
}
