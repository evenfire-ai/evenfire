import type { WorkspaceTab } from '@lib/workspaceTabs.types'

export type ChatSwitcherProps = {
  /** Chat sub-slice of the universal store (only `kind: 'chat'` tabs). */
  tabs: WorkspaceTab[]
  /**
   * The chat tab shown in the drawer — the controller's (selectedAgent,
   * activeChatId), not the store's active tab (which is the app tab while the
   * drawer is open). `null` when the drawer has no chat yet.
   */
  activeTabId: string | null
  onSelect: (id: string) => void
  onNewChat: () => void
  /**
   * Incremented by the `chat.switcher` shortcut to open and focus the dropdown.
   * A thin view over the shared universal store — it owns no tab state of its own.
   */
  focusRequestId?: number
}
