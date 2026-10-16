import type { WorkspaceTab } from '@lib/workspaceTabs.types'

export type WorkspaceTabStripProps = {
  tabs: WorkspaceTab[]
  activeTabId: string | null
  /** Chat tab currently waiting for Host access verification. */
  pendingTabId?: string | null
  /** Chat tab whose verified conversation is still loading. */
  loadingTabId?: string | null
  /** Chat tab whose Host access check failed and can be retried. */
  unavailableTabId?: string | null
  /** Why the unavailable chat tab cannot currently be opened. */
  unavailableReason?: 'access' | 'conversation' | 'team-context'
  onSelect: (id: string) => void
  onClose: (id: string) => void
  /** Move a tab to `toIndex` (its desired FINAL array index; see reorderWorkspaceTab). */
  onReorder: (fromId: string, toIndex: number) => void
  panelId?: string
}
