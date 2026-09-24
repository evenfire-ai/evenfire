import type { WorkspaceTab } from '@lib/workspaceTabs.types'

export type WorkspaceTabStripProps = {
  tabs: WorkspaceTab[]
  activeTabId: string | null
  onSelect: (id: string) => void
  onClose: (id: string) => void
  /** Move a tab to `toIndex` (its desired FINAL array index; see reorderWorkspaceTab). */
  onReorder: (fromId: string, toIndex: number) => void
  panelId?: string
}
