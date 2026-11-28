import type { GfsResourceActionId, GfsResourceKind } from '@lib/gfsResourceActions'

// Keyed by id rather than derived from the menu label: a label like "Move to"
// is a prompt, not a noun, and reads wrong as the subject of a sentence.
const ACTION_NOUN: Record<GfsResourceActionId, string> = {
  refresh: 'Refresh',
  'copy-link': 'Copy link',
  'open-route': 'Open link',
  rename: 'Rename',
  move: 'Move',
  'new-folder': 'New folder',
  'upload-file': 'Upload file',
  share: 'Share',
  'copy-content': 'Copy content',
  preview: 'Preview',
  download: 'Download',
  'download-zip': 'Download as zip',
  replace: 'Replace file',
  'open-folder': 'Open folder',
  delete: 'Delete',
}

/**
 * Tooltip for an EvenDrive action that is offered but cannot run. It does not
 * name a cause: the same gate covers bits that are still loading, bits that
 * failed to load and bits the user does not hold.
 */
export function unavailableReason(actionId: GfsResourceActionId): string {
  return `${ACTION_NOUN[actionId]} isn't available`
}

/** Tooltip for a read action on a resource the listing marks unreadable. */
export function readAccessReason(kind: GfsResourceKind): string {
  return `You don't have read access to this ${kind === 'directory' ? 'folder' : 'file'}`
}
