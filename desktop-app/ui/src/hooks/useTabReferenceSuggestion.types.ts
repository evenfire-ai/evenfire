import type { FilesResolvedLocation } from '@lib/tabReferenceSuggestion.types'
import type { WorkspaceTab } from '@lib/workspaceTabs.types'
import type { ComposerGlobalFileReference, NavItem } from '@/uiTypes'

export type TabReferenceSuggestionInput = {
  activeTab: WorkspaceTab | null | undefined
  navItem: NavItem
  filesResolvedLocation: FilesResolvedLocation
  /** Changes whenever GFS authority may have changed (env, auth, principal, team). */
  authorityScope: string
  drawerVisible: boolean
}

export type TabReferenceSuggestion = {
  /** The active tab's file, resolved and validated, or `null` when none is offered. */
  candidate: ComposerGlobalFileReference | null
  /** Report an observed change of `uri`. Stable; only the current target re-keys. */
  invalidate: (uri: string) => void
}
