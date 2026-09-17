import type { WorkspaceTab } from '@lib/workspaceTabs.types'

export type WorkspaceTabStripProps = {
  tabs: WorkspaceTab[]
  activeTabId: string | null
  onSelect: (id: string) => void
  onClose: (id: string) => void
  panelId?: string
}
