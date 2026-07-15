/**
 * Transitive folder-ownership delegation (spec community.md §Delegation and
 * folder ownership).
 *
 * Delegation is not a separate mechanism — it is the no-escalation grant engine
 * (P2-S01 assertMayGrant) applied at every hop, with the grantor's subject set
 * resolved through P2-S02 (resolvePrincipalSubjects, so a user delegates on the
 * strength of its own AND its teams' grants). Because each hop is itself a
 * grant that must pass the no-escalation check, an N-hop chain
 * (operator → owner → sub-owner → sub-owner …) is valid iff every hop holds
 * `manage_acl` and the bits it hands on within its subtree — and no hop can ever
 * exceed the bits it was given. This module composes those two pieces; it adds
 * no new authority.
 */
import {
  type GfsCaller,
  GfsGrantError,
  type GfsPermission,
  type GfsSubject,
  type GrantsDb,
  assertMayGrant,
} from '../routes/gfs/grants.js'
import { type Principal, resolvePrincipalSubjects } from './subjects.js'

/**
 * Build the no-escalation caller for a real principal, resolving its full
 * subject set (self + teams) via P2-S02. A principal is never the operator —
 * the cluster operator authenticates as an operator, not as a user/host
 * principal — so isOperator is false and every grant it makes is checked.
 */
export async function callerForPrincipal(db: GrantsDb, principal: Principal): Promise<GfsCaller> {
  const subjects = await resolvePrincipalSubjects(db, principal)
  return {
    isOperator: false,
    subjects,
    actorKey: `${principal.type}:${principal.id}`,
  }
}

/**
 * Whether `principal` may delegate `permissions` to `target` on `resourceId` —
 * the no-escalation check (P2-S01) over the principal's fully resolved subjects
 * (P2-S02). Returns true/false rather than throwing, for chain validation and
 * UI affordance checks; the authoritative enforcement remains assertMayGrant on
 * the write path.
 */
export async function canDelegate(
  db: GrantsDb,
  principal: Principal,
  drive: string,
  resourceId: string,
  permissions: GfsPermission[],
  target: GfsSubject,
  opts: { isShare: boolean } = { isShare: false }
): Promise<boolean> {
  const caller = await callerForPrincipal(db, principal)
  try {
    await assertMayGrant(db, caller, drive, resourceId, permissions, target, opts)
    return true
  } catch (err) {
    if (err instanceof GfsGrantError) return false
    throw err
  }
}
