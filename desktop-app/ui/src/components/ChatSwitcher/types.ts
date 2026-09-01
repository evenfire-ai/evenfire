import type { ChatViewTab } from '@lib/chatViewTabs.types'

export type ChatSwitcherProps = {
  tabs: ChatViewTab[]
  activeTabId: string
  onSelect: (id: string) => void
  onNewChat: () => void
  /**
   * Incremented by the `chat.switcher` shortcut to open and focus the dropdown.
   * A thin view over the shared `chatViewTabs` — it owns no tab state of its own.
   */
  focusRequestId?: number
}
