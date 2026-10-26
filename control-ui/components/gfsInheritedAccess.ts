import {
  classifyGfsAclReadFailure,
  gfsAncestorPathsOf,
  gfsHttpStatusOf,
  worstGfsCoverageClass,
} from '@clerum/gfs-interaction-policy'
import {
  type GfsResourceByPathView,
  apiGet,
  getGfsGrants,
  getGfsResourceByPath,
  getGfsShares,
} from '@lib/api'
import type {
  GfsInheritedAccessCoverage,
  GfsInheritedAccessItem,
  GfsInheritedAccessResult,
} from './GfsGrantPanel.types'
import { inheritedSubjectKey, mergeInheritedAccessItem } from './gfsInheritedAccessMerge'

/** `/docs/report.md` → `['/docs', '/']` (nearest ancestor first, depth-capped). */
export function gfsAncestorPaths(path: string): string[] {
  return gfsAncestorPathsOf(path)
}

/**
 * Reconstruct inherited observations from the operator endpoints' direct rows.
 * A later failed read never removes a member already proved by a readable
 * ancestor. Coverage distinguishes partial observations from a complete empty
 * result; grants and shares settle independently on each ancestor (P1-H1).
 *
 * Control UI normally has intrinsic operator access, unlike the Desktop
 * folder-owner plane. Rate limits and transient failures can still interrupt
 * this walk. Session/context expiry and cancellation rethrow before publishing
 * any result; apiRead owns the global authentication boundary. Structured
 * producer status wins over error prose, including a 500 body mentioning 401.
 */
export async function loadGfsInheritedAccess(
  target: { path: string | null; gfsUri?: string | null },
  drive: string,
  signal?: AbortSignal
): Promise<GfsInheritedAccessResult> {
  const bySubject = new Map<string, GfsInheritedAccessItem>()
  const result = (coverage: GfsInheritedAccessCoverage): GfsInheritedAccessResult => ({
    items: [...bySubject.values()],
    coverage,
  })
  const readFailure = (error: unknown) => {
    if (
      signal?.aborted ||
      (error instanceof DOMException && error.name === 'AbortError') ||
      gfsHttpStatusOf(error) === 401
    ) {
      throw error
    }
    return classifyGfsAclReadFailure(error)
  }
  if (signal?.aborted) throw signal.reason

  let canonicalPath = target.path
  if (!canonicalPath) {
    if (!target.gfsUri) return result('unavailable')
    try {
      const resolved = (await apiGet(
        '/api/v1/gfs/resolve',
        { uri: target.gfsUri },
        { signal }
      )) as { path?: string | null; kind?: string }
      if (signal?.aborted) throw signal.reason
      if (resolved.kind && resolved.kind !== 'directory' && resolved.kind !== 'file') {
        return result('unavailable')
      }
      canonicalPath = resolved.path ?? null
    } catch (error) {
      return result(readFailure(error) === 'denied' ? 'read-boundary' : 'unavailable')
    }
    if (!canonicalPath) return result('unavailable')
  }

  let coverage: GfsInheritedAccessCoverage = 'complete'
  const ancestorPaths = gfsAncestorPaths(canonicalPath)
  for (const ancestorPath of ancestorPaths) {
    if (signal?.aborted) throw signal.reason
    let folder: GfsResourceByPathView
    try {
      folder = await getGfsResourceByPath(drive, ancestorPath, signal)
    } catch (error) {
      return result(readFailure(error) === 'denied' ? 'read-boundary' : 'unavailable')
    }
    if (signal?.aborted) throw signal.reason
    if (folder.kind !== 'directory') return result('unavailable')

    const settled = await Promise.allSettled([
      getGfsGrants(folder.resourceId, drive, signal),
      getGfsShares(folder.resourceId, drive, signal),
    ])
    if (signal?.aborted) throw signal.reason
    // Inspect both failures before folding: a fulfilled sibling cannot turn
    // genuine session expiry into a partial-success observation.
    const failures = settled.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected'
    )
    const worst = worstGfsCoverageClass(failures.map(failure => readFailure(failure.reason)))
    const mustStop = worst !== 'complete' && worst !== 'denied'
    if (worst === 'denied') coverage = 'acl-limited'
    const grants = settled[0].status === 'fulfilled' ? settled[0].value.items : []
    const shares = settled[1].status === 'fulfilled' ? settled[1].value.items : []
    const folderLabel = folder.name || drive
    for (const grant of grants) {
      if (!grant.inherit) continue
      fold(grant.subject, grant.permissions, grant.id, [], folder.resourceId, folderLabel)
    }
    for (const share of shares) {
      if (!share.includeDescendants) continue
      fold(share.subject, share.permissions, null, [share.id], folder.resourceId, folderLabel)
    }
    // Preserve the successful family on this ancestor before an unavailable
    // stop; ordinary ACL denials retain that family and allow the walk upward.
    if (mustStop) return result('unavailable')
  }
  // The shared path helper caps its result; no root means traversal stopped
  // at that cap, not that every ancestor was observed.
  if (ancestorPaths.length > 0 && ancestorPaths.at(-1) !== '/') return result('unavailable')
  return result(coverage)

  function fold(
    subject: { type: string; id?: string },
    permissions: string[],
    grantId: string | null,
    shareIds: string[],
    resourceId: string,
    name: string
  ): void {
    const key = inheritedSubjectKey(subject)
    bySubject.set(
      key,
      mergeInheritedAccessItem(
        bySubject.get(key) ?? null,
        { subject, permissions, grantId, shareIds },
        {
          resourceId,
          name,
        }
      )
    )
  }
}
