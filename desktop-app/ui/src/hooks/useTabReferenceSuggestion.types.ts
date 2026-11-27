import type { FilesResolvedLocation, SuggestedReference } from '@lib/tabReferenceSuggestion.types'
import type { WorkspaceTab } from '@lib/workspaceTabs.types'
import type { NavItem } from '@/uiTypes'

export type TabReferenceSuggestionInput = {
  activeTab: WorkspaceTab | null | undefined
  navItem: NavItem
  filesResolvedLocation: FilesResolvedLocation
  /** Changes whenever GFS authority may have changed (env, auth, principal, team). */
  authorityScope: string
  drawerVisible: boolean
}

export type TabReferenceSuggestion = {
  /**
   * The active tab's file, or the folder Files is open on, resolved and
   * validated; `null` when none is offered.
   */
  candidate: SuggestedReference | null
  /** Report an observed change of `uri`. Stable; only the current target re-keys, and a folder's key never moves. */
  invalidate: (uri: string) => void
}
