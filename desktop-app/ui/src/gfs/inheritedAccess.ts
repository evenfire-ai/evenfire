import { classifyGfsAclReadFailure, worstGfsCoverageClass } from '@clerum/gfs-interaction-policy'
import type { GfsCoverageClass } from '@clerum/gfs-interaction-policy'
import { GFS_BREADCRUMB_MAX_DEPTH } from '@constants/gfsBrowser'
import { isGfsSessionAuthorityFailure, parseHttpStatus } from '@lib/gfsGrantErrors'
import type { GfsInheritedAccessItem, GfsInheritedAccessResult } from './delegation.types'
import { inheritedSubjectKey, mergeInheritedAccessItem } from './inheritedAccessMerge'

/**
 * Derives the inherited access for one resource on the client. The user-plane
 * grants/shares GETs list only the rows configured directly on a resource, so
 * inheritance is reconstructed by walking the ancestor folders (the same
 * resolve-based walk the breadcrumb trail uses) and keeping the rows that
 * apply to descendants: grants with inherit=true and shares with
 * includeDescendants=true — the server's allow() rule. Rows are merged per
 * subject through the shared pure core (`@clerum/gfs-interaction-policy`, via
 * the app adapter in `inheritedAccessMerge.ts`); EVERY contributing ancestor
 * folder is kept as an editable source, so a confirmed removal revokes all of
 * them and a confirmed downgrade lowers each one above the target role
 * (R1-H1).
 *
 * Coverage (R1-H3, permissions.md T1): the walk NEVER discards rows it has
 * already folded. A resolve 403 above the readable chain is an expected
 * privacy boundary (stop, keep rows, `read-boundary`); grants and shares
 * settle INDEPENDENTLY per ancestor, so one family's 403 keeps the other
 * family's rows and the walk continues (`acl-limited`) — the readable
 * ancestor's parent id is already known from its resolve. Any other failure
 * (404/410, 429, transport, cycle, depth cap) stops the walk with the folded
 * rows and `unavailable`. A session-authority failure (401 or typed lifecycle 403) is rethrown RAW: a session
 * death is never classified as a quiet boundary and keeps traveling the
 * controller's existing fail-closed error path.
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
 *   GFS_INHERITED_WALK_MAX_DEPTH). Hitting the cap with a parent still
 *   remaining reports `unavailable` — it never invents root completion.
 * - RETAINING: rows folded before a stop are always returned; only the
 *   coverage state differs.
 * - Desktop follows parent resource IDs and Control UI follows canonical
 *   paths; the shared failure classes come from the shared policy.
 */
export async function deriveGfsInheritedAccess(
  resourceId: string,
  drive: string = DEFAULT_DRIVE
): Promise<GfsInheritedAccessResult> {
  const bySubject = new Map<string, GfsInheritedAccessItem>()
  const seenResourceIds = new Set<string>()
  const classes: GfsCoverageClass[] = []
  let readBoundary = false
  let aclDenied = false
  let stopped = false

  // Match the existing session boundary before classifying an ordinary
  // folder/ACL denial. Typed lifecycle 403s are session failures too.
  const isAuthorityFailure = (error: unknown): boolean =>
    isGfsSessionAuthorityFailure(
      error instanceof Error ? error.message : String(error ?? ''),
      'operation'
    )

  /**
   * Classify a resolve failure; session authority rethrows the original error.
   *
   * The status that decided the response is the VETTED one the main process
   * appended to the message. The shared classifier reads the first
   * `httpStatus=` token it finds, and a copy carried by the server's own body
   * sits AHEAD of the vetted suffix — so a 500 whose body mentions another
   * status was classified by that other status (RP-008). The vetted status is
   * therefore passed explicitly, and the shared reader's structured field
   * takes precedence over its own message scan.
   */
  const resolveFailureClass = (error: unknown): GfsCoverageClass => {
    if (isAuthorityFailure(error)) throw error
    const vetted = parseHttpStatus(error instanceof Error ? error.message : String(error ?? ''))
    return classifyGfsAclReadFailure(vetted === null ? error : { status: vetted })
  }

  /** Classify an ACL-list failure (same authority rule as resolve). */
  const aclFailureClass = resolveFailureClass

  let targetParentId: string | null
  try {
    const target = await window.clerum.gfs.resolve(`gfs://${drive}/${ridOf(resourceId)}`)
    seenResourceIds.add(target.resourceId)
    targetParentId = target.parentResourceId
  } catch (error) {
    // The dialog's own target maps through the same table: a 403 is a
    // read boundary with no rows; anything else is `unavailable`; a 401
    // rethrows (resolveFailureClass).
    const failureClass = resolveFailureClass(error)
    classes.push(failureClass)
    if (failureClass === 'denied') readBoundary = true
    targetParentId = null
    stopped = true
  }
  let parentResourceId = targetParentId

  while (!stopped && parentResourceId && seenResourceIds.size - 1 < GFS_BREADCRUMB_MAX_DEPTH) {
    if (seenResourceIds.has(parentResourceId)) {
      // Corrupted chain: report it, keep what was folded, never complete.
      classes.push('error')
      stopped = true
      break
    }
    seenResourceIds.add(parentResourceId)

    let parent: Awaited<ReturnType<typeof window.clerum.gfs.resolve>>
    try {
      parent = await window.clerum.gfs.resolve(`gfs://${drive}/${ridOf(parentResourceId)}`)
    } catch (error) {
      const failureClass = resolveFailureClass(error)
      classes.push(failureClass)
      if (failureClass === 'denied') readBoundary = true
      stopped = true
      break
    }
    if (parent.kind !== 'directory') {
      classes.push('error')
      stopped = true
      break
    }

    // The two ACL families settle INDEPENDENTLY (permissions.md T1): one
    // family's denial never drops the other family's rows, and a 403 keeps
    // the walk moving because this ancestor's parent id is already known.
    const settled = await Promise.allSettled([
      window.clerum.gfs.listGrants(parent.resourceId, drive),
      window.clerum.gfs.listShares(parent.resourceId, drive),
    ])
    // A session-authority failure from EITHER family rethrows before rows fold.
    for (const outcome of settled) {
      if (outcome.status === 'rejected' && isAuthorityFailure(outcome.reason)) throw outcome.reason
    }
    const grants = settled[0].status === 'fulfilled' ? settled[0].value : null
    const shares = settled[1].status === 'fulfilled' ? settled[1].value : null
    const failures = settled.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected'
    )
    let mustStop = false
    if (failures.length > 0) {
      const failureClass = worstGfsCoverageClass(
        failures.map(failure => aclFailureClass(failure.reason))
      )
      classes.push(failureClass)
      if (failureClass === 'denied') {
        // ACL-limited on this folder: contribute nothing from the denied
        // family/families, keep the fulfilled one, continue upward.
        aclDenied = true
      } else {
        // Any other family failure stops the walk — AFTER the fulfilled
        // family of THIS folder folds (rows are never discarded, only the
        // upward walk ends).
        mustStop = true
      }
    }

    // The drive root carries an empty name; its label falls back to the drive.
    const folderLabel = parent.name || drive
    for (const grant of grants ?? []) {
      if (!grant.inherit) continue
      merge(grant.subject, grant.permissions, grant.id, [], parent.resourceId, folderLabel)
    }
    for (const share of shares ?? []) {
      if (!share.includeDescendants) continue
      merge(share.subject, share.permissions, null, [share.id], parent.resourceId, folderLabel)
    }
    if (mustStop) {
      stopped = true
      break
    }

    parentResourceId = parent.parentResourceId
  }

  if (!stopped && parentResourceId) {
    // The loop exited at the depth cap with a parent still unknown — report
    // the cap, never "complete".
    classes.push('depth-cap')
  }

  const worst = worstGfsCoverageClass(classes)
  // The depth cap means the walk never reached the root: the observation is
  // incomplete in a way the quiet boundary states do not express. It must not
  // hide behind an earlier denial — the shared precedence ranks "denied"
  // first, so a walk that was denied AND truncated reported the denial and
  // never said that rows above the cap were never seen (RP-021).
  const hitDepthCap = classes.includes('depth-cap')
  const coverage =
    hitDepthCap || (worst !== 'complete' && worst !== 'denied')
      ? 'unavailable'
      : readBoundary
        ? 'read-boundary'
        : aclDenied
          ? 'acl-limited'
          : 'complete'

  return { items: [...bySubject.values()], coverage }

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
