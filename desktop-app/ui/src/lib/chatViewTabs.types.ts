export type ChatViewTab = {
  id: string
  agentRef: string | null
  chatId: string | null
  title: string
}

export type ChatViewTabsState = {
  tabs: ChatViewTab[]
  activeTabId: string
}

export type PersistedChatView = {
  id: string
  agentRef: string
  chatId: string
  title?: string
}
