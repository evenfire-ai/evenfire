import { hasGfsMoveSourcePermissions } from './gfsMovePermissions'
import type {
  GfsRowActionAvailability,
  GfsRowActionAvailabilityInput,
} from './gfsRowActionAvailability.types'

/**
 * Which row actions a resource may offer. Presentation only: every action
 * rechecks the exact resource authority before it opens an editor or mutates,
 * and the server enforces it again.
 */
export function gfsRowActionAvailability({
  resource,
  listing,
  rowAffordances,
  parentAffordances,
}: GfsRowActionAvailabilityInput): GfsRowActionAvailability {
  const held = (bit: string): boolean =>
    listing === 'folder'
      ? Boolean(rowAffordances?.held?.includes(bit))
      : Boolean(resource.permissions?.includes(bit))
  return {
    canDelete: held('delete'),
    // Rename needs `write` on the resource itself.
    canRename: held('write'),
    canWrite: held('write'),
    // The ACL modal needs `manage_acl` (viewing the ACL is managing it
    // server-side), so a read-only row must not offer an entry that 403s.
    canManage: held('manage_acl'),
    // Move needs authority on the exact old parent, never the row's own bits
    // or the virtual root.
    canMove:
      Boolean(resource.parentResourceId) && hasGfsMoveSourcePermissions(parentAffordances?.held),
  }
}
