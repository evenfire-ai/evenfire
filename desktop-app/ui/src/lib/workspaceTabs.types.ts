export type WorkspaceTabKind = 'chat' | 'app' | 'files' | 'settings' | 'preview'

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
 * A files tab's live location (mini-spec 06 §3): `path` is the leaf `gfsUri`
 * (`gfs://<drive>/<rid>`) the browser is currently showing, or `null` for the
 * virtual root ("Shared with me"). It is the tab's dedupe key AND its
 * live-persisted location — the files analogue of `AppTabPayload.savedRoutePath`.
 */
export type FilesTabPayload = {
  path: string | null
}

/**
 * A preview tab's payload (spec 18 §3.B.1): everything a `FilePreviewPage` needs
 * to mount the right `Gfs*PreviewBody` and fail-closed re-fetch the bytes. The
 * `gfsUri` is the tab's dedupe key. `byteLength` is the file SIZE (for the
 * size-guard), never the bytes themselves — the body downloads by `gfsUri`.
 */
export type PreviewTabPayload = {
  gfsUri: string
  fileKind: 'image' | 'markdown' | 'video'
  mimeType?: string
  byteLength: number
}

/**
 * A single tab in the universal strip. `kind` discriminates the payload:
 * `chat` carries `chat`, `app` carries `app`, `settings` carries `settings`,
 * `files` carries `files` (its live gfsUri; multi-instance by path, §3 —
 * supersedes R8's single instance), and `preview` carries `preview` (a file
 * preview, multi-instance by gfsUri — spec 18 §3.B.1).
 */
export type WorkspaceTab = {
  id: string
  kind: WorkspaceTabKind
  title: string
  chat?: ChatTabPayload
  app?: AppTabPayload
  settings?: SettingsTabPayload
  files?: FilesTabPayload
  preview?: PreviewTabPayload
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
  /**
   * The gfsUri to open at (dedupe key). Absent / `undefined` ⇒ `null` (the
   * virtual root — a single root files tab).
   */
  path?: string | null
}

export type OpenSettingsTabInput = {
  id: string
  section: SettingsSection
  title?: string
}

export type OpenPreviewTabInput = {
  id: string
  title?: string
  /** The gfsUri to preview (dedupe key). */
  gfsUri: string
  fileKind: 'image' | 'markdown' | 'video'
  mimeType?: string
  byteLength: number
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
