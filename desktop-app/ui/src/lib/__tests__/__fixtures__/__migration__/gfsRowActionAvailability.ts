import { hasGfsMoveSourcePermissions } from './gfsMovePermissions'
import type { GfsResourceActionId } from './gfsResourceActions'
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

/**
 * The row actions to show while the bits are still loading or failed to load.
 * Every bit-dependent action is offered so the menu can render it inert until
 * the bits settle; Move still needs a known parent to be judged on at all.
 */
export function gfsPendingRowActionAvailability(resource: {
  parentResourceId?: string | null
}): GfsRowActionAvailability {
  return {
    canDelete: true,
    canRename: true,
    canWrite: true,
    canManage: true,
    canMove: Boolean(resource.parentResourceId),
  }
}

// Link copies need only the URI, preview and download only the
// listing's `readable` flag, and opening a folder is navigation. Every other
// action, including any added later, waits for the target's affordances.
const ACTIONS_WITHOUT_AFFORDANCES: ReadonlySet<GfsResourceActionId> = new Set([
  'copy-link',
  'preview',
  'download',
  'open-folder',
])

export function gfsActionNeedsAffordances(id: GfsResourceActionId): boolean {
  return !ACTIONS_WITHOUT_AFFORDANCES.has(id)
}
