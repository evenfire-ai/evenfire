import { sanitizeAppTabTitle } from './sanitizeAppTabTitle'
import type {
  ActiveChat,
  AppTabPayload,
  OpenAppTabInput,
  OpenChatTabInput,
  OpenFilesTabInput,
  OpenPreviewTabInput,
  OpenSettingsTabInput,
  PreviewTabPayload,
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

/**
 * Persist the live `document.title` of an app embed on its tab (mini-spec 06
 * §2), so the strip names the tab after what the plugin currently shows. A
 * mirror of `setAppTabSavedRoutePath`: a no-op (same reference) when the tab is
 * missing, is not an app tab, or already holds this title, so a `setState`
 * bails out. The plugin-controlled title is sanitized at this entry border
 * (mini-spec 08 §2) so every render site inherits the cleaned value; a title
 * that is empty / whitespace-only OR reduces to empty after sanitizing is
 * IGNORED (keeps the previous title) — a mid-navigation blank must not blank the
 * tab label; precedence `document.title → app.label → 'App'` is resolved by the
 * caller, not here.
 */
export function setAppTabTitle(
  state: WorkspaceTabsState,
  tabId: string,
  title: string
): WorkspaceTabsState {
  const clean = sanitizeAppTabTitle(title)
  if (!clean) return state
  const target = state.tabs.find(tab => tab.id === tabId && tab.kind === 'app')
  if (!target) return state
  if (target.title === clean) return state
  return {
    ...state,
    tabs: state.tabs.map(tab => (tab.id === tabId ? { ...tab, title: clean } : tab)),
  }
}

/**
 * Files: multi-instance, deduped by `path` (mini-spec 06 §3, supersedes R8's
 * single instance). Opening a `path` that already has a files tab FOCUSES it
 * (aligning its title); otherwise a new files tab is created. An absent path is
 * the virtual root (`null`), which collapses to a single root files tab. Dedupe
 * is applied ONLY here (open-time): two tabs may later navigate to the same
 * path independently, and that is left as-is (no hot re-dedupe).
 */
export function openFilesTab(
  state: WorkspaceTabsState,
  input: OpenFilesTabInput
): WorkspaceTabsState {
  const path = input.path ?? null
  const existing = state.tabs.find(
    tab => tab.kind === 'files' && (tab.files?.path ?? null) === path
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
    kind: 'files',
    title: title || 'Files',
    files: { path },
  }
  return { tabs: [...state.tabs, tab], activeTabId: input.id }
}

/**
 * Persist the live location of a files tab (mini-spec 06 §3), the files analogue
 * of `setAppTabSavedRoutePath`: as the browser navigates, its leaf `gfsUri` is
 * written back onto the tab (with the current folder name as the title; the
 * virtual root → 'Files'). A no-op (same reference) when the tab is missing, is
 * not a files tab, or already holds this path AND title, so a `setState` bails
 * out. It does NOT re-dedupe — dedupe is an open-time rule only (§3).
 *
 * `title` is the current folder's display name (which the opaque `gfsUri` does
 * not carry), supplied by the browser; absent / empty ⇒ 'Files'. It is a GFS
 * folder name — externally-controlled input in the same threat class as a
 * preview tab's file name — so it passes through the shared tab-title sanitizer
 * at this store border (mirrors `openPreviewTab` / `setAppTabTitle`).
 */
export function setFilesTabPath(
  state: WorkspaceTabsState,
  tabId: string,
  path: string | null,
  title?: string
): WorkspaceTabsState {
  const target = state.tabs.find(tab => tab.id === tabId && tab.kind === 'files')
  if (!target) return state
  const nextPath = path ?? null
  const nextTitle = (title ? sanitizeAppTabTitle(title) : '') || 'Files'
  if ((target.files?.path ?? null) === nextPath && target.title === nextTitle) return state
  return {
    ...state,
    tabs: state.tabs.map(tab =>
      tab.id === tabId ? { ...tab, title: nextTitle, files: { path: nextPath } } : tab
    ),
  }
}

/**
 * Preview: multi-instance, deduped by `gfsUri` (spec 18 §3.B.1 — a direct clone
 * of `openFilesTab`'s open-or-focus). Opening a `gfsUri` that already has a
 * preview tab FOCUSES it (aligning its title to the current file name);
 * otherwise a new preview tab is created and activated. Dedupe is applied ONLY
 * here (open-time), matching every other open* action.
 */
export function openPreviewTab(
  state: WorkspaceTabsState,
  input: OpenPreviewTabInput
): WorkspaceTabsState {
  const existing = state.tabs.find(
    tab => tab.kind === 'preview' && tab.preview?.gfsUri === input.gfsUri
  )
  // A preview tab's title is a GFS file name — externally-controlled input in the
  // same threat class as a plugin's document.title (control chars, bidi overrides,
  // zero-width, unbounded length), so it goes through the shared tab-title
  // sanitizer at this single store border; every render site inherits the cleaned
  // value. Empty-after-sanitize falls back to 'Preview' below.
  const title = input.title ? sanitizeAppTabTitle(input.title) : ''
  const nextPreview: PreviewTabPayload = {
    gfsUri: input.gfsUri,
    fileKind: input.fileKind,
    byteLength: input.byteLength,
    ...(input.resourceVersion !== undefined ? { resourceVersion: input.resourceVersion } : {}),
    ...(input.mimeType !== undefined ? { mimeType: input.mimeType } : {}),
  }
  if (existing) {
    // Focus AND refresh the whole payload: unlike the other open* dedupe
    // branches, a preview tab's payload carries non-key fields (fileKind /
    // byteLength / mimeType) beyond its `gfsUri` key. If the resource at the URI
    // changed (a rename that keeps the URI, a replaced body), a title-only patch
    // would leave STALE metadata — and a stale small `byteLength` lets the body's
    // size-guard wave an oversized new payload through. Keep the same-reference
    // no-op when nothing actually changed so a `setState` still bails out.
    const nextTitle = title || existing.title
    const p = existing.preview
    const unchanged =
      existing.title === nextTitle &&
      p !== undefined &&
      p.gfsUri === nextPreview.gfsUri &&
      p.fileKind === nextPreview.fileKind &&
      p.byteLength === nextPreview.byteLength &&
      p.mimeType === nextPreview.mimeType &&
      p.unavailable !== true &&
      p.reloadVersion === undefined &&
      p.resourceVersion === nextPreview.resourceVersion
    return {
      tabs: unchanged
        ? state.tabs
        : state.tabs.map(tab =>
            tab.id === existing.id ? { ...tab, title: nextTitle, preview: nextPreview } : tab
          ),
      activeTabId: existing.id,
    }
  }
  const tab: WorkspaceTab = {
    id: input.id,
    kind: 'preview',
    title: title || 'Preview',
    preview: nextPreview,
  }
  return { tabs: [...state.tabs, tab], activeTabId: input.id }
}

export type PreviewTabRemoteRefresh =
  | {
      status: 'available'
      title: string
      fileKind: PreviewTabPayload['fileKind']
      mimeType?: string
      byteLength: number
      resourceVersion?: number
    }
  | { status: 'unavailable'; shellTitle: 'File unavailable' | 'Preview unavailable' }

/** Apply current authorized metadata to every tab for one stable GFS URI. */
export function refreshPreviewTab(
  state: WorkspaceTabsState,
  gfsUri: string,
  refresh: PreviewTabRemoteRefresh
): WorkspaceTabsState {
  const targets = state.tabs.filter(
    (tab): tab is WorkspaceTab & { preview: PreviewTabPayload } =>
      tab.kind === 'preview' && tab.preview?.gfsUri === gfsUri
  )
  if (targets.length === 0) return state
  let changed = false
  const tabs = state.tabs.map(tab => {
    if (tab.kind !== 'preview' || tab.preview?.gfsUri !== gfsUri) return tab
    const previous = tab.preview
    if (refresh.status === 'unavailable') {
      if (previous.unavailable && tab.title === refresh.shellTitle) return tab
      changed = true
      return {
        ...tab,
        title: refresh.shellTitle,
        preview: {
          ...previous,
          unavailable: true,
          reloadVersion: (previous.reloadVersion ?? 0) + 1,
        },
      }
    }
    if (
      refresh.resourceVersion !== undefined &&
      previous.resourceVersion !== undefined &&
      refresh.resourceVersion < previous.resourceVersion
    ) {
      return tab
    }
    const safeTitle = sanitizeAppTabTitle(refresh.title) || 'Preview'
    const unchanged =
      !previous.unavailable &&
      tab.title === safeTitle &&
      previous.fileKind === refresh.fileKind &&
      previous.mimeType === refresh.mimeType &&
      previous.byteLength === refresh.byteLength &&
      previous.resourceVersion === refresh.resourceVersion
    if (unchanged) return tab
    changed = true
    return {
      ...tab,
      title: safeTitle,
      preview: {
        gfsUri,
        fileKind: refresh.fileKind,
        byteLength: refresh.byteLength,
        ...(refresh.mimeType !== undefined ? { mimeType: refresh.mimeType } : {}),
        ...(refresh.resourceVersion !== undefined
          ? { resourceVersion: refresh.resourceVersion }
          : {}),
        reloadVersion: (previous.reloadVersion ?? 0) + 1,
      },
    }
  })
  return changed ? { ...state, tabs } : state
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

// ---- reorder (strip drag & drop / keyboard; session-only) -------------------

/**
 * Move a tab to a new position. `toIndex` is the DESIRED FINAL index of the
 * moved tab in the resulting array (0..len-1) — not an insertion slot — so the
 * caller owns "where it lands" and this stays the single source of truth.
 *
 * Reordering NEVER changes `activeTabId`: the route seam derives the active
 * tab's navItem, so with the active id fixed a pure reorder causes no route
 * churn (dragging an inactive tab past the active one, or dragging the active
 * tab itself, both keep the same tab active). Order is the array order — there
 * is no `order` field to keep in sync.
 *
 * No-ops return the SAME reference so a `setState` bails out (no render): an
 * unknown `fromId`, or a `toIndex` that clamps back to the tab's current index
 * — which by construction includes every workspace with fewer than 2 tabs.
 */
export function reorderWorkspaceTab(
  state: WorkspaceTabsState,
  fromId: string,
  toIndex: number
): WorkspaceTabsState {
  const fromIndex = state.tabs.findIndex(tab => tab.id === fromId)
  if (fromIndex < 0) return state
  const clamped = Math.max(0, Math.min(toIndex, state.tabs.length - 1))
  if (clamped === fromIndex) return state
  const tabs = [...state.tabs]
  const [moved] = tabs.splice(fromIndex, 1)
  tabs.splice(clamped, 0, moved!)
  return { ...state, tabs }
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
    // The active tab is NOT a blank chat (a non-chat tab, or a persisted chat).
    // Reuse an existing blank chat tab instead of spawning another (mini-spec 06
    // §1): in drawer mode the effect keeps the app/files tab active, so the
    // blank is never the active tab and, without this, every reconcile would
    // `appendBlankChatTab` and stack "New chat" tabs. Only append when there is
    // no blank chat tab at all — the invariant is "+1 blank at most, and only if
    // none existed". Focus the reused blank (as append activates the new one);
    // the drawer seam then keeps its non-chat tab active.
    const existingBlank = state.tabs.find(isBlankChatTab)
    if (existingBlank) {
      return existingBlank.chat?.agentRef === active.agentRef
        ? { ...state, activeTabId: existingBlank.id }
        : {
            tabs: state.tabs.map(tab =>
              tab.id === existingBlank.id
                ? { ...tab, chat: { agentRef: active.agentRef, chatId: null } }
                : tab
            ),
            activeTabId: existingBlank.id,
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
