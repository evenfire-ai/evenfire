import type { GfsResourceActionId } from './gfsResourceActions'
import { gfsActionNeedsAffordances } from './gfsRowActionAvailability'

/**
 * Where the target's permission bits (its own affordances and its parent's)
 * stand when a menu renders.
 */
export type GfsResourceMenuPermissionGateStatus = 'pending' | 'ok' | 'error'

export type GfsPermissionGatedMenuAction = {
  submenu?: boolean
  disabled?: boolean
}

export function withPermissionGate<A extends GfsPermissionGatedMenuAction>(
  action: A,
  actionId: GfsResourceActionId,
  permissionStatus: GfsResourceMenuPermissionGateStatus | undefined
): A {
  if (permissionStatus === undefined || permissionStatus === 'ok' || action.submenu) return action
  // Unresolved or failed bits keep the item visible but inert, so the menu
  // never offers an action the target may not allow.
  return gfsActionNeedsAffordances(actionId) ? { ...action, disabled: true } : action
}
