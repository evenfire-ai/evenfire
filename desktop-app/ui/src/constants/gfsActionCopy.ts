import type { GfsResourceKind } from '@lib/gfsResourceActions'

/**
 * Tooltip for an EvenDrive action that is offered but cannot run. It does not
 * name a cause: the same gate covers bits that are still loading, bits that
 * failed to load and bits the user does not hold.
 */
export function unavailableReason(label: string): string {
  return `${label.replace(/(?:…|\.\.\.)$/, '').trimEnd()} isn't available`
}

/** Tooltip for a read action on a resource the listing marks unreadable. */
export function readAccessReason(kind: GfsResourceKind): string {
  return `You don't have read access to this ${kind === 'directory' ? 'folder' : 'file'}`
}
