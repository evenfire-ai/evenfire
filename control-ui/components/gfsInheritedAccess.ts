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
 * in R1-M2); EVERY contributing ancestor folder is kept as an editable source
 * (with the grant/share ids to mutate), so a confirmed removal revokes all of
 * them and a confirmed downgrade lowers each one above the target role
 * (R1-H1).
 */

/**
 * Walk semantics (R1-L3, unified with the desktop walk in
 * desktop-app/ui/src/gfs/inheritedAccess.ts):
 * - BOUNDED in depth: at most GFS_INHERITED_WALK_MAX_DEPTH ancestors are
 *   visited (the desktop rid-chain walk bounds itself with the same number
 *   via GFS_BREADCRUMB_MAX_DEPTH).
 * - BEST-EFFORT skip-and-continue: an ancestor that cannot be resolved or
 *   whose ACL cannot be listed (moved, deleted, rate-limited, unviewable) is
 *   skipped and the walk CONTINUES with the remaining ancestors — per-ancestor
 *   failures never fail the derivation. Only a walk that resolves NO ancestor
 *   at all reports a total failure (R1-M3).
 * - Because this walk addresses ancestors by canonical PATH, each ancestor is
 *   independent: skipping one still leaves every higher path reachable. The
 *   desktop walk chains parent ids instead and can only stop when an ancestor
 *   cannot be resolved at all — that single divergence is documented at its
 *   walk site.
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
      bySubject.set(
        key,
        mergeInheritedAccessItem(bySubject.get(key) ?? null, row, {
          resourceId: folder.resourceId,
          name: folderLabel,
        })
      )
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
