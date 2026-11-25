/**
 * Where the row was listed. Folder children carry no permission bits, so their
 * actions follow the row's own affordances; the accessible roots ("Shared with
 * me") carry their permissions on the listing itself.
 */
export type GfsRowListing = 'folder' | 'roots'

export interface GfsRowActionAvailabilityInput {
  resource: { parentResourceId?: string | null; permissions?: readonly string[] }
  listing: GfsRowListing
  rowAffordances: { held?: readonly string[] } | null | undefined
  /**
   * The exact old parent's affordances, as the caller vetted them: null when
   * they are unknown or their read failed with anything but a rate limit.
   */
  parentAffordances: { held?: readonly string[] } | null | undefined
}

export interface GfsRowActionAvailability {
  canDelete: boolean
  canRename: boolean
  canWrite: boolean
  canManage: boolean
  canMove: boolean
}
