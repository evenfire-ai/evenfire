import type {
  GfsActionOpeningAuthority,
  GfsActionOpeningTarget,
} from './gfsActionOpeningAuthority.types'
import type { GfsResourceActionId } from './gfsResourceActions'

/**
 * The authority an action proves before it opens its editor. It gates the
 * opening only: every submit proves authority again, and the server
 * enforces it once more.
 */
export function gfsActionOpeningAuthority(
  target: GfsActionOpeningTarget,
  actionId: GfsResourceActionId
): GfsActionOpeningAuthority {
  switch (actionId) {
    // The Files page opens New folder without asking: its submit proves
    // `write` either way, so a caller may skip the opening check for it.
    case 'rename':
    case 'new-folder':
      return {
        kind: 'check',
        resourceId: target.resourceId,
        resourceName: target.name,
        bits: ['write'],
      }
    case 'delete':
      return {
        kind: 'check',
        resourceId: target.resourceId,
        resourceName: target.name,
        bits: ['delete'],
      }
    case 'share':
      return {
        kind: 'check',
        resourceId: target.resourceId,
        resourceName: target.name,
        bits: ['manage_acl'],
      }
    case 'move':
      // Moving is authorized on the folder the resource leaves, never on itself.
      return target.parentResourceId
        ? {
            kind: 'check',
            resourceId: target.parentResourceId,
            resourceName: 'the source folder',
            bits: ['write', 'delete'],
          }
        : { kind: 'unverifiable', message: 'Could not verify the source folder for this move.' }
    default:
      return { kind: 'none' }
  }
}
