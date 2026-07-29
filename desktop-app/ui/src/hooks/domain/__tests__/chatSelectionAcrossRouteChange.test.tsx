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
import { DESKTOP_ROUTES } from '@constants/navigation'
import type { AppNotification } from '../../../uiTypes'
import {
  HARNESS_ME,
  extendMockClerumForAppController,
  renderAppController,
} from './__fixtures__/appControllerHarness'
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

/**
 * Freezes the chat-list reload: `chat.getIndex` never settles until the returned
 * release runs, so `loadChatList` — and therefore the `switchToChat` the
 * agent-selection effect replays a pending selection through — cannot complete.
 * That is what makes the two selection paths distinguishable: while the index is
 * stalled, a `chat.setLastActive` call can ONLY have come from an imperative
 * `switchToChat` (the fast path).
 */
function stallChatIndex() {
  let release!: () => void
  clerum.chat.getIndex.mockReturnValue(
    new Promise(resolve => {
      release = () => resolve(indexWith(TWO_CHATS))
    })
  )
  return () => release()
}

/**
 * Drains pending microtasks AND the macrotask queue inside `act`, so a negative
 * assertion is made after everything that could have run has run. Without this a
 * "did not happen" assertion only means "had not happened yet on this tick",
 * which is what makes such assertions flaky under CPU contention.
 */
async function settle() {
  await act(async () => {
    await Promise.resolve()
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

/** Contention headroom: the default 1s can expire on a cold/loaded machine. */
const SLOW = { timeout: 5000 } as const

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
    const releaseIndex = stallChatIndex()

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
      expect(clerum.rpc.loadSessionMessages).toHaveBeenCalledWith(
        'agent-x',
        'agent-x',
        'c-old',
        undefined,
        { limit: 40 }
      )
    )
    expect(result.current.activeChatId).toBe('c-old')
    // It must not fall back to the most recently updated chat.
    expect(clerum.rpc.loadSessionMessages).not.toHaveBeenCalledWith(
      'agent-x',
      'agent-x',
      'c-newest',
      undefined,
      { limit: 40 }
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
    expect(clerum.rpc.loadSessionMessages).toHaveBeenCalledWith(
      'agent-x',
      'agent-x',
      'c-old',
      undefined,
      { limit: 40 }
    )
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
      expect(clerum.rpc.loadSessionMessages).toHaveBeenCalledWith(
        'agent-x',
        'agent-x',
        'c-old',
        undefined,
        { limit: 40 }
      )
    )
    expect(result.current.activeChatId).toBe('c-old')
    expect(clerum.rpc.loadSessionMessages).not.toHaveBeenCalledWith(
      'agent-x',
      'agent-x',
      'c-newest',
      undefined,
      { limit: 40 }
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

/**
 * The tests above pin the MECHANISM (they call `setPendingChatSelection`
 * themselves). These drive the real entry points on the coordinator, so the
 * `navItem === DESKTOP_ROUTES.chat` guards in `useAppController`
 * (`handleSelectChatAgent`, `openAgentConversationTarget`) are the thing under
 * test — nobody was checking that they pick the right branch.
 *
 * How the branch is observed: only the imperative fast path runs `switchToChat`,
 * and `switchToChat` is the only caller of `chatStore.setLastActive`
 * (→ `clerum.chat.setLastActive`), which it invokes synchronously. The pending
 * path sets `activeChatId` synchronously too, but reaches `switchToChat` only
 * once the chat list resolves — so with `stallChatIndex()` holding the list open,
 * a `setLastActive(agent, chatId)` call can only mean the fast path ran.
 *
 * Determinism: every assertion is either preceded by `settle()` (negatives — so
 * "did not happen" is not merely "has not happened yet on this tick") or wrapped
 * in `waitFor` (positives), and every action is preceded by a `waitFor` on the
 * exact precondition it needs rather than assuming the boot has quiesced.
 */
describe('chat-route guard on the real selection entry points', () => {
  // The coordinator owns SSE subscriptions and timers, so each mount is torn
  // down before the outer hook deletes `window.clerum` (nested afterEach hooks
  // run first) — otherwise a surviving effect would fire against a dead bridge.
  let unmountApp: (() => void) | null = null

  afterEach(() => {
    unmountApp?.()
    unmountApp = null
  })

  /** Boots the coordinator authenticated, on the chat route, with `c-newest` open. */
  async function bootOnChatRoute() {
    clerum.chat.getIndex.mockResolvedValue(indexWith(TWO_CHATS))
    extendMockClerumForAppController(clerum)

    const app = renderAppController()
    unmountApp = app.unmount
    await waitFor(() => expect(app.result.current.booting).toBe(false), SLOW)
    await waitFor(() => expect(app.result.current.isAuthenticated).toBe(true), SLOW)
    // The access catalog must be in cache before an agent can be selected: the
    // coordinator nulls `selectedAgent` whenever it isn't in `agentNames`
    // (useAppController.ts). `initialExperienceLoading` flips to false exactly
    // when the catalog lands, so this is the honest barrier — waiting on
    // `navItem === chat` was tautological (useNavigationController starts there).
    await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false), SLOW)

    // Entering the chat route selects the agent and opens its latest chat, the
    // same way `handleNavSelect(chat)` does in the app.
    await act(async () => {
      app.result.current.handleSelectChatAgent('agent-x')
    })
    // `switchToChat` runs on well past the point where `activeChatId` flips
    // (cache read → unread clear → reconcile). Waiting only for `activeChatId`
    // let that tail land in the middle of the test below, which is precisely
    // what made these assertions load-sensitive. Wait for the whole boot
    // selection to go quiet instead, then drain what is left.
    await waitFor(() => {
      expect(app.result.current.selectedAgent).toBe('agent-x')
      expect(app.result.current.activeChatId).toBe('c-newest')
      expect(app.result.current.chatMessagesLoading).toBe(false)
    }, SLOW)
    await settle()
    return app
  }

  it('handleSelectChatAgent from another route defers to the pending selection', async () => {
    const { result } = await bootOnChatRoute()

    // The user leaves for the Apps embed. `selectedAgent` survives (the raw nav
    // handler only clears it for the agents/chat routes).
    await act(async () => {
      result.current.handleNavSelect(DESKTOP_ROUTES.apps)
    })
    await waitFor(() => {
      expect(result.current.navItem).toBe(DESKTOP_ROUTES.apps)
      expect(result.current.selectedAgent).toBe('agent-x')
    }, SLOW)
    await settle()

    clerum.chat.setLastActive.mockClear()
    clerum.rpc.loadSessionMessages.mockClear()
    const releaseIndex = stallChatIndex()

    // Clicking a session in the sidebar while off the chat route.
    act(() => {
      result.current.handleSelectChatAgent('agent-x', { chatId: 'c-old', title: 'Old chat' })
    })
    // Give the fast path every chance to fire before claiming it did not: with
    // the index stalled the pending path still cannot reach `switchToChat`, so
    // draining here only strengthens the negative below.
    await settle()

    // The guard rejected the fast path — no imperative `switchToChat` for the
    // requested chat. Scoped to the arguments so unrelated residue (a late
    // `c-newest` tail) can never decide this assertion.
    expect(clerum.chat.setLastActive).not.toHaveBeenCalledWith('agent-x', 'c-old')
    // …but the requested chat is already the active one, so `AgentWorkspace`
    // renders the thread instead of the "New chat with <agent>" empty state.
    expect(result.current.activeChatId).toBe('c-old')
    expect(result.current.navItem).toBe(DESKTOP_ROUTES.chat)

    // Once the list lands, the pending selection is replayed onto the requested chat.
    await act(async () => {
      releaseIndex()
    })
    await waitFor(
      () => expect(clerum.chat.setLastActive).toHaveBeenCalledWith('agent-x', 'c-old'),
      SLOW
    )
    await waitFor(
      () =>
        expect(clerum.rpc.loadSessionMessages).toHaveBeenCalledWith(
          'agent-x',
          'agent-x',
          'c-old',
          undefined,
          { limit: 40 }
        ),
      SLOW
    )
    expect(result.current.activeChatId).toBe('c-old')
    // Never the most recently updated chat.
    expect(clerum.chat.setLastActive).not.toHaveBeenCalledWith('agent-x', 'c-newest')
  })

  it('handleSelectChatAgent on the chat route keeps the imperative fast path', async () => {
    const { result } = await bootOnChatRoute()

    await waitFor(() => {
      expect(result.current.navItem).toBe(DESKTOP_ROUTES.chat)
      expect(result.current.selectedAgent).toBe('agent-x')
    }, SLOW)

    clerum.chat.setLastActive.mockClear()
    // The index stays stalled for the whole test: on the fast path `switchToChat`
    // owns the transition end to end, so the switch below must happen without the
    // chat list ever resolving. That also keeps the assertion strict — a stalled
    // list makes the pending path incapable of producing this call.
    void stallChatIndex()

    act(() => {
      result.current.handleSelectChatAgent('agent-x', { chatId: 'c-old', title: 'Old chat' })
    })

    await waitFor(
      () => expect(clerum.chat.setLastActive).toHaveBeenCalledWith('agent-x', 'c-old'),
      SLOW
    )
    await waitFor(() => {
      expect(result.current.activeChatId).toBe('c-old')
      expect(result.current.navItem).toBe(DESKTOP_ROUTES.chat)
    }, SLOW)

    await waitFor(
      () =>
        expect(clerum.rpc.loadSessionMessages).toHaveBeenCalledWith(
          'agent-x',
          'agent-x',
          'c-old',
          undefined,
          { limit: 40 }
        ),
      SLOW
    )
    expect(result.current.activeChatId).toBe('c-old')
  })

  it('a notification opened from another route defers to the pending selection', async () => {
    // Post-merge the whole notification card in `AppHeader` is clickable, so this
    // deep link (`handleOpenNotification` → `openAgentConversationTarget`) is the
    // second entry point behind the same guard. Same team → no team switch, so
    // the fast path is the only thing the guard can still reject.
    const { result } = await bootOnChatRoute()

    await act(async () => {
      result.current.handleNavSelect(DESKTOP_ROUTES.settings)
    })
    await waitFor(() => {
      expect(result.current.navItem).toBe(DESKTOP_ROUTES.settings)
      expect(result.current.selectedAgent).toBe('agent-x')
    }, SLOW)
    await settle()

    clerum.chat.setLastActive.mockClear()
    clerum.rpc.loadSessionMessages.mockClear()
    const releaseIndex = stallChatIndex()

    const notification: AppNotification = {
      id: 'notif-1',
      kind: 'assistant_reply',
      agentName: 'agent-x',
      chatId: 'c-old',
      teamId: HARNESS_ME.teamId,
      text: 'Agent replied',
      timestamp: Date.now(),
      read: false,
    }

    await act(async () => {
      await result.current.handleOpenNotification(notification)
    })
    await settle()

    expect(clerum.chat.setLastActive).not.toHaveBeenCalledWith('agent-x', 'c-old')
    expect(result.current.activeChatId).toBe('c-old')
    expect(result.current.navItem).toBe(DESKTOP_ROUTES.chat)

    await act(async () => {
      releaseIndex()
    })
    await waitFor(
      () => expect(clerum.chat.setLastActive).toHaveBeenCalledWith('agent-x', 'c-old'),
      SLOW
    )
    await waitFor(
      () =>
        expect(clerum.rpc.loadSessionMessages).toHaveBeenCalledWith(
          'agent-x',
          'agent-x',
          'c-old',
          undefined,
          { limit: 40 }
        ),
      SLOW
    )
    expect(result.current.activeChatId).toBe('c-old')
    expect(clerum.chat.setLastActive).not.toHaveBeenCalledWith('agent-x', 'c-newest')
  })
})
