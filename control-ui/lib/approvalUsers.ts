import type { AdminUser } from './api'

/** A removed (retired) member can no longer decide an approval request. */
export function isRemovedApprovalUser(user: AdminUser): boolean {
  return user.lifecycleState === 'retired'
}

/**
 * Users offered in the recipe approver select: everyone who has not been
 * removed. `storedRemoved` is the removed member a step still points at, if any,
 * so the select can show it as a disabled "(removed)" option instead of blank.
 */
export function partitionApprovalUsers(
  users: AdminUser[],
  storedTargetId: string
): { selectable: AdminUser[]; storedRemoved: AdminUser | null } {
  const selectable = users.filter(user => !isRemovedApprovalUser(user))
  const stored = users.find(user => user.id === storedTargetId)
  return {
    selectable,
    storedRemoved: stored && isRemovedApprovalUser(stored) ? stored : null,
  }
}
