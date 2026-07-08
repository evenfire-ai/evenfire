/**
 * gfs delegation affordances (spec community.md §Operator and folder-owner
 * surfaces; plan P4-S07). Folder owners (any manage_acl holder — including a
 * team `member`, NOT a `Leader` who lacks it) delegate Layer-2/3 grants from
 * Profile/Desktop. This pure helper decides which delegation controls the UI
 * SHOWS; enforcement always stays server-side (control-api/gfsc), so hiding a
 * control is a usability affordance, never the security boundary.
 *
 * No-escalation is reflected in the UI: a caller may only offer to grant bits it
 * itself holds.
 */

export const GFS_PERMISSION_BITS = ['read', 'write', 'delete', 'manage_acl', 'share'] as const
export type GfsBit = (typeof GFS_PERMISSION_BITS)[number]

export interface DelegationAffordances {
  /** Bits the caller currently holds on the resource. */
  held: GfsBit[]
  /** Whether the caller is a folder owner who can open the delegation UI. */
  canDelegate: boolean
  /** Bits the caller may offer to grant to a user/team (only bits it holds). */
  grantableBits: GfsBit[]
  /** Whether the caller can create a URI share (needs the share bit). */
  canCreateShare: boolean
}

/**
 * @param held    The bits the caller holds on the target subtree.
 * @param isOperator True for the cluster operator (intrinsic full authority).
 */
export function delegationAffordances(
  held: ReadonlySet<string>,
  isOperator: boolean
): DelegationAffordances {
  // A folder owner is any manage_acl holder; a Leader without manage_acl is not.
  const canDelegate = isOperator || held.has('manage_acl')
  const grantableBits: GfsBit[] = canDelegate
    ? GFS_PERMISSION_BITS.filter(bit => isOperator || held.has(bit))
    : []
  return {
    held: GFS_PERMISSION_BITS.filter(bit => isOperator || held.has(bit)),
    canDelegate,
    grantableBits,
    canCreateShare: canDelegate && (isOperator || held.has('share')),
  }
}
