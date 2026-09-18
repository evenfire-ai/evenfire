import type {
  ActiveChat,
  AppTabPayload,
  OpenAppTabInput,
  OpenChatTabInput,
  OpenFilesTabInput,
  OpenSettingsTabInput,
  WorkspaceTab,
  WorkspaceTabsState,
} from './workspaceTabs.types'

/**
 * Universal tab store — the pure algebra of the single global strip (spec 01
 * §4.1). It reuses the order/dedupe/select/cycle/reconcile logic of
 * `chatViewTabs` for the `kind:'chat'` sub-slice, but LIFTS OUT the
 * "list is never empty + re-seed a blank chat" invariant that does not survive
 * universalization (§5, option B):
 *   - the workspace may be empty; `activeTabId` is nullable;
 *   - `firstWorkspaceTab`/`lastWorkspaceTab` are TOTAL (never throw);
 *   - closing the last tab leaves an empty workspace — it does NOT re-seed.
 * This store is the sole owner of tab identity and which tab is active;
 * chat loading (`selectedAgent`, pending-selection) stays in its controllers.
 *
 * Contract: callers MUST supply a unique `id` for every opened tab. Ids are the
 * identity used for select/cycle/close; a reused id yields two tabs sharing an
 * id, and `closeWorkspaceTab` would then filter BOTH out at once.
 */

const isBlankChatTab = (tab: WorkspaceTab | undefined): boolean =>
  tab?.kind === 'chat' && (tab.chat?.chatId ?? null) === null

// ---- accessors (total: never throw on an empty list) ------------------------

export function firstWorkspaceTab(tabs: WorkspaceTab[]): WorkspaceTab | undefined {
  return tabs[0]
}

export function lastWorkspaceTab(tabs: WorkspaceTab[]): WorkspaceTab | undefined {
  return tabs.at(-1)
}

export function activeWorkspaceTab(state: WorkspaceTabsState): WorkspaceTab | undefined {
  return state.tabs.find(tab => tab.id === state.activeTabId)
}

// ---- constructors -----------------------------------------------------------

/** Boot seed: one active blank chat tab (preserves "boot to chat", §5). */
export function createWorkspaceTabsState(
  id: string,
  agentRef: string | null = null
): WorkspaceTabsState {
  return {
    tabs: [{ id, kind: 'chat', title: 'New chat', chat: { agentRef, chatId: null } }],
    activeTabId: id,
  }
}

/** Empty workspace — the state left after closing the last tab (§5). */
export function createEmptyWorkspaceTabsState(): WorkspaceTabsState {
  return { tabs: [], activeTabId: null }
}

function appendBlankChatTab(
  state: WorkspaceTabsState,
  id: string,
  agentRef: string | null
): WorkspaceTabsState {
  const tab: WorkspaceTab = {
    id,
    kind: 'chat',
    title: 'New chat',
    chat: { agentRef, chatId: null },
  }
  return { tabs: [...state.tabs, tab], activeTabId: id }
}

// ---- open / focus (identity rules R6–R9, spec 01 §4.1) ----------------------

/**
 * Open or focus a chat tab (R7). Persisted chats (`chatId !== null`) dedupe by
 * `agentRef + chatId` (a chatId is unique to its agent, so this is dedupe by
 * chatId). A port of `openPersistedChatViewTab` with the kind guard from §1:
 * it only collapses into the active tab when that tab is a BLANK CHAT tab.
 */
export function openChatTab(
  state: WorkspaceTabsState,
  input: OpenChatTabInput
): WorkspaceTabsState {
  const { id, agentRef, chatId } = input
  const title = input.title?.trim()

  if (chatId !== null) {
    const existing = state.tabs.find(
      tab => tab.kind === 'chat' && tab.chat?.agentRef === agentRef && tab.chat?.chatId === chatId
    )
    if (existing) {
      return {
        tabs:
          title && existing.title !== title
            ? state.tabs.map(tab => (tab.id === existing.id ? { ...tab, title } : tab))
            : state.tabs,
        activeTabId: existing.id,
      }
    }
  }

  const current = activeWorkspaceTab(state)
  const collapseIntoBlank = current !== undefined && isBlankChatTab(current)
  const next: WorkspaceTab = {
    id: collapseIntoBlank ? current!.id : id,
    kind: 'chat',
    title: title || (chatId === null ? 'New chat' : 'Conversation'),
    chat: { agentRef, chatId },
  }
  if (collapseIntoBlank) {
    return {
      tabs: state.tabs.map(tab => (tab.id === current!.id ? next : tab)),
      activeTabId: next.id,
    }
  }
  return { tabs: [...state.tabs, next], activeTabId: next.id }
}

/**
 * "New chat" (`focusBlankChatViewTab` port with the §1 kind guard): if the
 * active tab is already a blank chat, reuse it (align the agent); otherwise —
 * including when the active tab is app/files/settings or there is none — ADD a
 * new blank chat tab. Never collapses into a non-chat active tab.
 */
export function newChatTab(
  state: WorkspaceTabsState,
  id: string,
  agentRef: string | null = null
): WorkspaceTabsState {
  const current = activeWorkspaceTab(state)
  if (current && isBlankChatTab(current)) {
    return {
      tabs: state.tabs.map(tab =>
        tab.id === current.id
          ? { ...tab, title: 'New chat', chat: { agentRef, chatId: null } }
          : tab
      ),
      activeTabId: current.id,
    }
  }
  return appendBlankChatTab(state, id, agentRef)
}

/** Apps ALWAYS open a new tab, keyed by tab-id — no dedupe by appRef (R9). */
export function openAppTab(state: WorkspaceTabsState, input: OpenAppTabInput): WorkspaceTabsState {
  const tab: WorkspaceTab = {
    id: input.id,
    kind: 'app',
    title: input.title?.trim() || 'App',
    app: {
      appRef: input.appRef,
      ...(input.savedRoutePath !== undefined ? { savedRoutePath: input.savedRoutePath } : {}),
    },
  }
  return { tabs: [...state.tabs, tab], activeTabId: input.id }
}

/**
 * Persist the current in-app route on an app tab (mini-spec 05 §3). The store
 * governs the embed lifecycle: on deactivation the route is read from the live
 * embed and written here so reactivation can re-mount at it. `routePath ===
 * undefined` CLEARS any saved route (the tab reopens at its default path) — the
 * key is dropped rather than stored as `undefined`. A no-op (same reference)
 * when the tab is missing, is not an app tab, or already holds this route, so a
 * `setState` bails out. Closing a tab removes it, so a persist racing a close
 * simply no-ops.
 */
export function setAppTabSavedRoutePath(
  state: WorkspaceTabsState,
  tabId: string,
  routePath: string | undefined
): WorkspaceTabsState {
  const target = state.tabs.find(tab => tab.id === tabId && tab.kind === 'app')
  if (!target?.app) return state
  if (target.app.savedRoutePath === routePath) return state
  const nextApp: AppTabPayload = {
    appRef: target.app.appRef,
    ...(routePath !== undefined ? { savedRoutePath: routePath } : {}),
  }
  return {
    ...state,
    tabs: state.tabs.map(tab => (tab.id === tabId ? { ...tab, app: nextApp } : tab)),
  }
}

/** Files: single instance — focus the existing tab if present (R8). */
export function openFilesTab(
  state: WorkspaceTabsState,
  input: OpenFilesTabInput
): WorkspaceTabsState {
  const existing = state.tabs.find(tab => tab.kind === 'files')
  const title = input.title?.trim()
  if (existing) {
    return {
      tabs:
        title && existing.title !== title
          ? state.tabs.map(tab => (tab.id === existing.id ? { ...tab, title } : tab))
          : state.tabs,
      activeTabId: existing.id,
    }
  }
  const tab: WorkspaceTab = { id: input.id, kind: 'files', title: title || 'Files' }
  return { tabs: [...state.tabs, tab], activeTabId: input.id }
}

/** Settings: unique per `section` — focus the existing section tab (R6). */
export function openSettingsTab(
  state: WorkspaceTabsState,
  input: OpenSettingsTabInput
): WorkspaceTabsState {
  const existing = state.tabs.find(
    tab => tab.kind === 'settings' && tab.settings?.section === input.section
  )
  const title = input.title?.trim()
  if (existing) {
    return {
      tabs:
        title && existing.title !== title
          ? state.tabs.map(tab => (tab.id === existing.id ? { ...tab, title } : tab))
          : state.tabs,
      activeTabId: existing.id,
    }
  }
  const tab: WorkspaceTab = {
    id: input.id,
    kind: 'settings',
    title: title || input.section,
    settings: { section: input.section },
  }
  return { tabs: [...state.tabs, tab], activeTabId: input.id }
}

// ---- selection / cycling (universal: over ALL tabs, any kind) ---------------

export function selectWorkspaceTab(state: WorkspaceTabsState, id: string): WorkspaceTabsState {
  return state.tabs.some(tab => tab.id === id) ? { ...state, activeTabId: id } : state
}

export function selectWorkspaceTabAt(state: WorkspaceTabsState, index: number): WorkspaceTabsState {
  const target = state.tabs[index]
  return target ? { ...state, activeTabId: target.id } : state
}

export function selectLastWorkspaceTab(state: WorkspaceTabsState): WorkspaceTabsState {
  const last = lastWorkspaceTab(state.tabs)
  return last ? { ...state, activeTabId: last.id } : state
}

export function cycleWorkspaceTab(
  state: WorkspaceTabsState,
  direction: 'next' | 'previous'
): WorkspaceTabsState {
  if (state.tabs.length < 2) return state
  const activeIndex = Math.max(
    0,
    state.tabs.findIndex(tab => tab.id === state.activeTabId)
  )
  const offset = direction === 'next' ? 1 : -1
  const targetIndex = (activeIndex + offset + state.tabs.length) % state.tabs.length
  return { ...state, activeTabId: state.tabs[targetIndex]!.id }
}

// ---- close (no re-seed; empty workspace allowed, §5) ------------------------

/**
 * Close a tab. Unlike `closeChatViewTab`, it never re-seeds a blank chat: when
 * the last tab closes, the workspace becomes empty (`activeTabId === null`).
 * When the active tab closes, the right neighbor (any kind) is activated.
 */
export function closeWorkspaceTab(state: WorkspaceTabsState, id: string): WorkspaceTabsState {
  const closingIndex = state.tabs.findIndex(tab => tab.id === id)
  if (closingIndex < 0) return state
  const tabs = state.tabs.filter(tab => tab.id !== id)
  if (tabs.length === 0) return { tabs, activeTabId: null }
  if (state.activeTabId !== id) return { tabs, activeTabId: state.activeTabId }
  const neighbor = tabs[Math.min(closingIndex, tabs.length - 1)]!
  return { tabs, activeTabId: neighbor.id }
}

// ---- reconcile (chat sub-slice; idempotent) ---------------------------------

/**
 * Aligns the chat-tab state to the chat the controller currently displays
 * (a port of `reconcileChatViewTabs`, §3: same logic, universal trigger). The
 * displayed `active` chat is PRIMARY; tab state is DERIVED from it.
 *
 * Anti-loop rules preserved from the origin:
 * - Idempotent: when the active tab already reflects `active` (same agent+chat,
 *   title already matching when supplied), it returns the SAME `state`
 *   reference so a `setState` bails out.
 * - Never spawns a duplicate persisted chat tab (dedupe by `agentRef + chatId`).
 * - Blank branch: keeps the already-active blank chat tab, only aligning its
 *   agent; from any other active tab it appends one blank chat tab.
 * - It only touches chat tabs; app/files/settings tabs are left untouched.
 */
export function reconcileWorkspaceChatTab(
  state: WorkspaceTabsState,
  active: ActiveChat | null,
  newTabId: string
): WorkspaceTabsState {
  if (!active || !active.agentRef) return state
  const current = activeWorkspaceTab(state)

  if (active.chatId === null) {
    if (current && isBlankChatTab(current)) {
      return current.chat?.agentRef === active.agentRef
        ? state
        : {
            tabs: state.tabs.map(tab =>
              tab.id === current.id
                ? { ...tab, chat: { agentRef: active.agentRef, chatId: null } }
                : tab
            ),
            activeTabId: current.id,
          }
    }
    return appendBlankChatTab(state, newTabId, active.agentRef)
  }

  const existing = state.tabs.find(
    tab =>
      tab.kind === 'chat' &&
      tab.chat?.agentRef === active.agentRef &&
      tab.chat?.chatId === active.chatId
  )
  const title = active.title?.trim()
  if (existing) {
    const isActive = state.activeTabId === existing.id
    const titleMatches = !title || existing.title === title
    if (isActive && titleMatches) return state
    return {
      tabs:
        title && existing.title !== title
          ? state.tabs.map(tab => (tab.id === existing.id ? { ...tab, title } : tab))
          : state.tabs,
      activeTabId: existing.id,
    }
  }
  return openChatTab(state, {
    id: newTabId,
    agentRef: active.agentRef,
    chatId: active.chatId,
    title: active.title,
  })
}
