import type { ChatViewTab } from '@lib/chatViewTabs.types'

export type ChatTabsProps = {
  tabs: ChatViewTab[]
  activeTabId: string
  onSelect: (id: string) => void
  onClose: (id: string) => void
  panelId?: string
}
