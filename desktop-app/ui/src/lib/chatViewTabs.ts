import type { ChatViewTab, ChatViewTabsState, PersistedChatView } from './chatViewTabs.types'

export function createChatViewTabsState(
  id: string,
  agentRef: string | null = null
): ChatViewTabsState {
  return {
    tabs: [{ id, agentRef, chatId: null, title: 'New chat' }],
    activeTabId: id,
  }
}

export function activeChatViewTab(state: ChatViewTabsState): ChatViewTab {
  return state.tabs.find(tab => tab.id === state.activeTabId) ?? state.tabs[0]!
}

export function addBlankChatViewTab(
  state: ChatViewTabsState,
  id: string,
  agentRef: string | null
): ChatViewTabsState {
  return {
    tabs: [...state.tabs, { id, agentRef, chatId: null, title: 'New chat' }],
    activeTabId: id,
  }
}

export function focusBlankChatViewTab(
  state: ChatViewTabsState,
  id: string,
  agentRef: string
): ChatViewTabsState {
  const active = activeChatViewTab(state)
  if (active.chatId === null) {
    return {
      tabs: state.tabs.map(tab =>
        tab.id === active.id ? { ...tab, agentRef, title: 'New chat' } : tab
      ),
      activeTabId: active.id,
    }
  }
  return addBlankChatViewTab(state, id, agentRef)
}

export function openPersistedChatViewTab(
  state: ChatViewTabsState,
  view: PersistedChatView
): ChatViewTabsState {
  const existing = state.tabs.find(
    tab => tab.agentRef === view.agentRef && tab.chatId === view.chatId
  )
  if (existing) {
    const title = view.title?.trim()
    return {
      tabs: title
        ? state.tabs.map(tab => (tab.id === existing.id ? { ...tab, title } : tab))
        : state.tabs,
      activeTabId: existing.id,
    }
  }

  const active = activeChatViewTab(state)
  const next: ChatViewTab = {
    id: active.chatId === null ? active.id : view.id,
    agentRef: view.agentRef,
    chatId: view.chatId,
    title: view.title?.trim() || 'Conversation',
  }
  if (active.chatId === null) {
    return {
      tabs: state.tabs.map(tab => (tab.id === active.id ? next : tab)),
      activeTabId: next.id,
    }
  }
  return { tabs: [...state.tabs, next], activeTabId: next.id }
}

/**
 * Single reconciler for the invariant `chatViewTabs.activeTabId ≡ the displayed
 * chat` (minispec 04, approach A). `vm.activeChatId` is PRIMARY; the tab state is
 * DERIVED from it. Used by both the full-screen chat route and the app drawer.
 *
 * Hard rules (anti-loop):
 * - Idempotent: when the active tab already reflects `active` (same agent+chat,
 *   and the title already matches when one is supplied), it returns the SAME
 *   `state` reference so `setChatViewTabs` bails out — no re-render, no ping-pong
 *   with the drawer reveal paths (which dedupe by `(agentRef, chatId)` too).
 * - Never spawns a duplicate persisted tab (dedupes by `(agentRef, chatId)`).
 * - Blank branch (`active.chatId === null`): never cascades new blank tabs; it
 *   keeps the already-active blank tab, only aligning its agent.
 * - Never drives `switchToChat` — it only derives tab state.
 */
export function reconcileChatViewTabs(
  state: ChatViewTabsState,
  active: { agentRef: string; chatId: string | null; title?: string } | null,
  newTabId: string
): ChatViewTabsState {
  if (!active || !active.agentRef) return state
  if (active.chatId === null) {
    const current = activeChatViewTab(state)
    if (current.chatId === null) {
      // Already showing a blank tab — align its agent, never spawn a new one.
      return current.agentRef === active.agentRef
        ? state
        : {
            tabs: state.tabs.map(tab =>
              tab.id === current.id ? { ...tab, agentRef: active.agentRef } : tab
            ),
            activeTabId: current.id,
          }
    }
    return focusBlankChatViewTab(state, newTabId, active.agentRef)
  }
  const existing = state.tabs.find(
    tab => tab.agentRef === active.agentRef && tab.chatId === active.chatId
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
  return openPersistedChatViewTab(state, {
    id: newTabId,
    agentRef: active.agentRef,
    chatId: active.chatId,
    title: active.title,
  })
}

export function selectChatViewTab(state: ChatViewTabsState, id: string): ChatViewTabsState {
  return state.tabs.some(tab => tab.id === id) ? { ...state, activeTabId: id } : state
}

export function selectChatViewTabAt(state: ChatViewTabsState, index: number): ChatViewTabsState {
  const target = state.tabs[index]
  return target ? { ...state, activeTabId: target.id } : state
}

export function selectLastChatViewTab(state: ChatViewTabsState): ChatViewTabsState {
  return { ...state, activeTabId: state.tabs.at(-1)!.id }
}

export function cycleChatViewTab(
  state: ChatViewTabsState,
  direction: 'next' | 'previous'
): ChatViewTabsState {
  if (state.tabs.length < 2) return state
  const activeIndex = Math.max(
    0,
    state.tabs.findIndex(tab => tab.id === state.activeTabId)
  )
  const offset = direction === 'next' ? 1 : -1
  const targetIndex = (activeIndex + offset + state.tabs.length) % state.tabs.length
  return { ...state, activeTabId: state.tabs[targetIndex]!.id }
}

export function closeChatViewTab(
  state: ChatViewTabsState,
  id: string,
  fallbackId: string
): ChatViewTabsState {
  const closingIndex = state.tabs.findIndex(tab => tab.id === id)
  if (closingIndex < 0) return state
  if (state.tabs.length === 1) {
    return createChatViewTabsState(fallbackId, state.tabs[0]?.agentRef ?? null)
  }
  const tabs = state.tabs.filter(tab => tab.id !== id)
  if (state.activeTabId !== id) return { tabs, activeTabId: state.activeTabId }
  const neighbor = tabs[Math.min(closingIndex, tabs.length - 1)]!
  return { tabs, activeTabId: neighbor.id }
}
