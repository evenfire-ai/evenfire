// @vitest-environment jsdom
/**
 * Regression tests for opening a chat session while coming from ANOTHER route
 * (the Apps embed, the agent workspace, settings…).
 *
 * The agent-selection effect in `useAgentChatController` depends on `navItem`
 * (deps `[currentTeamId, navItem, selectedAgent]`), so a route change re-runs it.
 * When it re-runs with no pending selection it takes its reset branch
 * (`activeChatId -> null`, messages cleared, spinner off) — which `AgentWorkspace`
 * renders as the "New chat with <agent>" empty state — and then auto-selects
 * `merged[0]`, the most recently updated chat, NOT the one the user asked for.
 *
 * `useAppController.handleSelectChatAgent` therefore only takes its imperative
 * `switchToChat` fast path while already on the chat route; from any other route
 * it must go through the pending-selection path, which survives the re-run. The
 * two affected entry points are the sidebar session list
 * (`SidebarNav` -> `onSelectChatAgent`) and "back to conversation"
 * (`App.handleSandboxUiBackToConversation`); both funnel through the same
 * selector, so these tests pin the mechanism both rely on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, waitFor } from '@testing-library/react'
import { renderController } from './__fixtures__/controllerHarness'
import { type MockClerum, installMockClerum, uninstallMockClerum } from './__fixtures__/mockClerum'

let clerum: MockClerum
let uuidCounter = 0

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  uuidCounter = 0
  vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(
    () => `uuid-${++uuidCounter}` as `${string}-${string}-${string}-${string}-${string}`
  )
  clerum = installMockClerum()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  uninstallMockClerum()
})

const chatMeta = (id: string, updatedAt: string, title = id) => ({
  id,
  title,
  createdAt: '2026-05-01T00:00:00Z',
  updatedAt,
  messageCount: 1,
})

/** `c-newest` sorts first in the merged list — the chat the buggy path fell back to. */
const TWO_CHATS = [
  chatMeta('c-newest', '2026-05-03T00:00:00Z', 'Newest chat'),
  chatMeta('c-old', '2026-05-01T00:00:00Z', 'Old chat'),
]

const indexWith = (chats: ReturnType<typeof chatMeta>[]) => ({
  version: 1,
  lastActiveChatId: null,
  onboardingDismissed: false,
  chats,
})

describe('selecting a chat session across a route change', () => {
  it('app -> session never renders the new-chat empty state and opens the requested chat', async () => {
    clerum.chat.getIndex.mockResolvedValue(indexWith(TWO_CHATS))

    // The user is reading a chat session…
    const { result, rerender } = renderController({ navItem: 'chat' })
    await waitFor(() => expect(result.current.activeChatId).toBe('c-newest'))

    // …then opens an embedded app. `selectedAgent` survives the route change
    // (useNavigationController only clears it for the agents/chat routes).
    await act(async () => {
      rerender({ navItem: 'sandbox-ui' })
    })

    // Drop the mount-time auto-select of `c-newest` so the assertions below only
    // see what the session click itself opened.
    clerum.rpc.loadSessionMessages.mockClear()

    // Stall the chat-list reload so the render that follows the route change is
    // observable instead of being immediately overwritten by the list load.
    let releaseIndex!: () => void
    clerum.chat.getIndex.mockReturnValue(
      new Promise(resolve => {
        releaseIndex = () => resolve(indexWith(TWO_CHATS))
      })
    )

    // The user clicks the OLDER session in the sidebar. Post-fix the selector
    // records a pending selection before flipping the route back to chat.
    act(() => {
      result.current.setPendingChatSelection('agent-x', 'c-old', { title: 'Old chat' })
      rerender({ navItem: 'chat' })
    })

    // The requested chat is already active — `AgentWorkspace` renders the thread
    // (activeChatId set), never the "New chat with" greeting (activeChatId null).
    expect(result.current.activeChatId).toBe('c-old')
    expect(result.current.chatMessagesLoading).toBe(true)

    await act(async () => {
      releaseIndex()
    })

    await waitFor(() =>
      expect(clerum.rpc.loadSessionMessages).toHaveBeenCalledWith('agent-x', 'agent-x', 'c-old')
    )
    expect(result.current.activeChatId).toBe('c-old')
    // It must not fall back to the most recently updated chat.
    expect(clerum.rpc.loadSessionMessages).not.toHaveBeenCalledWith(
      'agent-x',
      'agent-x',
      'c-newest'
    )
  })

  it('session -> session stays on the imperative fast path with no intermediate blank', async () => {
    clerum.chat.getIndex.mockResolvedValue(indexWith(TWO_CHATS))
    const { result, rerender } = renderController({ navItem: 'chat' })
    await waitFor(() => expect(result.current.activeChatId).toBe('c-newest'))

    // Same route, same agent → the selection effect's deps are unchanged, so it
    // does not re-run and `switchToChat` owns the transition end to end.
    act(() => {
      void result.current.switchToChat('agent-x', 'c-old')
      rerender({ navItem: 'chat' })
    })
    expect(result.current.activeChatId).toBe('c-old')

    await waitFor(() => expect(result.current.chatMessagesLoading).toBe(false))
    expect(result.current.activeChatId).toBe('c-old')
    expect(clerum.rpc.loadSessionMessages).toHaveBeenCalledWith('agent-x', 'agent-x', 'c-old')
  })

  it('notification -> session from another route opens the notified chat', async () => {
    // `openAgentConversationTarget` shares the same guard. Its pending selection
    // carries no title (AgentConversationNotificationTarget has no title field),
    // so this also pins that a title-less `specific` selection still sets the
    // active chat synchronously — no blank frame, no `merged[0]` fallback.
    clerum.chat.getIndex.mockResolvedValue(indexWith(TWO_CHATS))
    const { result, rerender } = renderController({ navItem: 'chat' })
    await waitFor(() => expect(result.current.activeChatId).toBe('c-newest'))

    await act(async () => {
      rerender({ navItem: 'sandbox-ui' })
    })
    clerum.rpc.loadSessionMessages.mockClear()

    act(() => {
      result.current.setPendingChatSelection('agent-x', 'c-old')
      rerender({ navItem: 'chat' })
    })

    expect(result.current.activeChatId).toBe('c-old')

    await waitFor(() =>
      expect(clerum.rpc.loadSessionMessages).toHaveBeenCalledWith('agent-x', 'agent-x', 'c-old')
    )
    expect(result.current.activeChatId).toBe('c-old')
    expect(clerum.rpc.loadSessionMessages).not.toHaveBeenCalledWith(
      'agent-x',
      'agent-x',
      'c-newest'
    )
  })

  it('characterization: an imperative switch alone does NOT survive a route change', async () => {
    // Why the selector must not use `switchToChat` when arriving from another
    // route. This pins the effect behaviour the fix routes around — if the effect
    // ever stops resetting on a bare route change, revisit the guard in
    // `useAppController.handleSelectChatAgent` (the fast path could widen again).
    clerum.chat.getIndex.mockResolvedValue(indexWith(TWO_CHATS))
    const { result, rerender } = renderController({ navItem: 'chat' })
    await waitFor(() => expect(result.current.activeChatId).toBe('c-newest'))

    await act(async () => {
      rerender({ navItem: 'sandbox-ui' })
    })

    await act(async () => {
      void result.current.switchToChat('agent-x', 'c-old')
      rerender({ navItem: 'chat' })
    })

    // The effect re-ran, found no pending selection, wiped the imperative
    // selection and auto-selected the most recent chat instead.
    await waitFor(() => expect(result.current.activeChatId).toBe('c-newest'))
  })
})
