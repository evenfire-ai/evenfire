export type WorkspaceTabKind = 'chat' | 'app' | 'files' | 'settings'

export type SettingsSection = 'connectors' | 'agents' | 'plugins' | 'settings'

export type ChatTabPayload = {
  agentRef: string | null
  chatId: string | null
}

export type AppTabPayload = {
  appRef: string
  savedRoutePath?: string
}

export type SettingsTabPayload = {
  section: SettingsSection
}

/**
 * A single tab in the universal strip. `kind` discriminates the payload:
 * `chat` carries `chat`, `app` carries `app`, `settings` carries `settings`,
 * and `files` carries no payload (single instance, R8).
 */
export type WorkspaceTab = {
  id: string
  kind: WorkspaceTabKind
  title: string
  chat?: ChatTabPayload
  app?: AppTabPayload
  settings?: SettingsTabPayload
}

/**
 * `activeTabId` is nullable: the universal workspace may be empty (§5, option
 * B). The never-empty + blank-seed invariant of `chatViewTabs` does NOT survive
 * universalization — closing the last tab leaves `activeTabId === null`.
 */
export type WorkspaceTabsState = {
  tabs: WorkspaceTab[]
  activeTabId: string | null
}

export type OpenChatTabInput = {
  id: string
  agentRef: string | null
  chatId: string | null
  title?: string
}

export type OpenAppTabInput = {
  id: string
  appRef: string
  title?: string
  savedRoutePath?: string
}

export type OpenFilesTabInput = {
  id: string
  title?: string
}

export type OpenSettingsTabInput = {
  id: string
  section: SettingsSection
  title?: string
}

/**
 * The chat currently displayed by the chat controller — the primary that
 * `reconcileWorkspaceChatTab` aligns tab state to (`chatId === null` = a blank
 * new chat).
 */
export type ActiveChat = {
  agentRef: string
  chatId: string | null
  title?: string
}
