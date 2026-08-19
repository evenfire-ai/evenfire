// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, waitFor } from '@testing-library/react'
import { DESKTOP_ROUTES } from '@constants/navigation'
import {
  installAppControllerClerum,
  renderAppController,
} from '../domain/__tests__/__fixtures__/appControllerHarness'
import { uninstallMockClerum } from '../domain/__tests__/__fixtures__/mockClerum'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * The chat drawer coexists with the live app on the `apps` route. Selecting a
 * chat for the drawer must swap the shared <ChatPage>'s conversation WITHOUT
 * navigating to the full-screen chat route (which would tear down the embed).
 * `keepNavItem` is the single seam that breaks the XOR coupling — these pins
 * fail against the parent commit, where the option does not exist and
 * `handleSelectChatAgent` always flips `navItem` to `chat`.
 */
describe('useAppController — chat drawer keepNavItem', () => {
  let unmount: (() => void) | null = null

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    unmount?.()
    unmount = null
    vi.restoreAllMocks()
    uninstallMockClerum()
  })

  it('keeps the apps route AND loads the requested chat with keepNavItem', async () => {
    installAppControllerClerum({ agentNames: ['agent-x'] })
    const app = renderAppController()
    unmount = app.unmount

    await waitFor(() => expect(app.result.current.isAuthenticated).toBe(true))
    await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false))

    act(() => {
      app.result.current.handleNavSelect(DESKTOP_ROUTES.apps)
    })
    expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.apps)

    act(() => {
      app.result.current.handleSelectChatAgent('agent-x', {
        chatId: 'chat-1',
        title: 'Drawer chat',
        selectLatest: false,
        keepNavItem: true,
      })
    })

    // The route stays on `apps` so the live embed survives, AND the requested
    // conversation actually finishes loading — the observable the user sees, not
    // a pending selection left stuck spinning (T4).
    expect(app.result.current.selectedAgent).toBe('agent-x')
    expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.apps)
    await waitFor(() => expect(app.result.current.chatMessagesLoading).toBe(false))
    expect(app.result.current.activeChatId).toBe('chat-1')
  })

  it('loads the chat when keepNavItem re-selects the already-selected agent without a route change', async () => {
    // Regression for the drawer-reopen / switcher Blocker: selecting a chat of
    // the ALREADY-selected agent while staying on `apps` changes neither
    // `selectedAgent` nor `navItem`, so the agent-selection effect never replays
    // the pending selection. Without an imperative switch the message list is
    // wiped and STUCK LOADING — the observable below (chatMessagesLoading stays
    // true at the parent commit).
    installAppControllerClerum({ agentNames: ['agent-x'] })
    const app = renderAppController()
    unmount = app.unmount

    await waitFor(() => expect(app.result.current.isAuthenticated).toBe(true))
    await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false))

    // Land on `apps` with agent-x already the selected agent.
    act(() => {
      app.result.current.handleSelectChatAgent('agent-x', { chatId: 'chat-1', selectLatest: false })
    })
    await waitFor(() => expect(app.result.current.selectedAgent).toBe('agent-x'))
    act(() => {
      app.result.current.handleNavSelect(DESKTOP_ROUTES.apps)
    })
    await waitFor(() => expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.apps))

    // Now re-select a DIFFERENT chat of the SAME agent, in-drawer (keepNavItem),
    // with no route change — the case the agent-selection effect cannot cover.
    act(() => {
      app.result.current.handleSelectChatAgent('agent-x', {
        chatId: 'chat-2',
        title: 'Second chat',
        selectLatest: false,
        keepNavItem: true,
      })
    })

    expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.apps)
    expect(app.result.current.activeChatId).toBe('chat-2')
    // The chat resolves instead of spinning forever.
    await waitFor(() => expect(app.result.current.chatMessagesLoading).toBe(false))
  })

  it('bypasses the same-route fast path with keepNavItem so a concurrent route change survives', async () => {
    installAppControllerClerum({ agentNames: ['agent-x'] })
    const app = renderAppController()
    unmount = app.unmount

    await waitFor(() => expect(app.result.current.isAuthenticated).toBe(true))
    await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false))

    // Land on the chat route with the agent selected — this is exactly the state
    // where the fast path (same agent + same-route + chatId) would fire.
    act(() => {
      app.result.current.handleSelectChatAgent('agent-x', { chatId: 'chat-1', selectLatest: false })
    })
    await waitFor(() => expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.chat))
    await waitFor(() => expect(app.result.current.selectedAgent).toBe('agent-x'))

    // Launch-from-chat batches a route change to `apps` with a keepNavItem chat
    // selection. `nav.navItem` still reads `chat` when the selection runs, so the
    // fast path would set navItem back to `chat` and leave no pending selection to
    // survive the route change. keepNavItem must force the pending-selection path.
    act(() => {
      app.result.current.handleNavSelect(DESKTOP_ROUTES.apps)
      app.result.current.handleSelectChatAgent('agent-x', {
        chatId: 'chat-2',
        title: 'Seeded from conversation',
        selectLatest: false,
        keepNavItem: true,
      })
    })

    expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.apps)
    // Observable: chat-2 is actually loaded, not stuck spinning (T4).
    await waitFor(() => expect(app.result.current.chatMessagesLoading).toBe(false))
    expect(app.result.current.activeChatId).toBe('chat-2')
  })

  it('navigates to the full-screen chat route without keepNavItem', async () => {
    installAppControllerClerum({ agentNames: ['agent-x'] })
    const app = renderAppController()
    unmount = app.unmount

    await waitFor(() => expect(app.result.current.isAuthenticated).toBe(true))
    await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false))

    act(() => {
      app.result.current.handleNavSelect(DESKTOP_ROUTES.apps)
    })
    expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.apps)

    act(() => {
      app.result.current.handleSelectChatAgent('agent-x', {
        chatId: 'chat-1',
        title: 'Full screen chat',
        selectLatest: false,
      })
    })

    expect(app.result.current.selectedAgent).toBe('agent-x')
    expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.chat)
  })

  it('opens a conversation notification in the drawer (keepNavItem) without ejecting to full-screen', async () => {
    // minispec 04 approach C — the real openAgentConversationTarget must honor
    // keepNavItem (App passes it while the app embed is live): surface the chat
    // without flipping navItem to the chat route.
    installAppControllerClerum({ agentNames: ['agent-x'] })
    const app = renderAppController()
    unmount = app.unmount

    await waitFor(() => expect(app.result.current.isAuthenticated).toBe(true))
    await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false))

    // Land on `apps` with agent-x already selected (mirrors the live-embed state).
    act(() => {
      app.result.current.handleSelectChatAgent('agent-x', { chatId: 'chat-1', selectLatest: false })
    })
    await waitFor(() => expect(app.result.current.selectedAgent).toBe('agent-x'))
    act(() => {
      app.result.current.handleNavSelect(DESKTOP_ROUTES.apps)
    })
    await waitFor(() => expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.apps))

    // Open the (approval's) conversation on a background chat, same team, same
    // agent, WITH keepNavItem — the gesture App fires while the embed is live.
    await act(async () => {
      await app.result.current.handleOpenNotification(
        {
          id: 'n1',
          kind: 'approval_required',
          agentName: 'agent-x',
          chatId: 'chat-2',
          teamId: 'team-1',
          text: 'Approval needed',
          timestamp: Date.now(),
          read: false,
          approval: { taskId: 't1', requestId: 'r1' },
        } as Parameters<typeof app.result.current.handleOpenNotification>[0],
        { keepNavItem: true }
      )
    })

    // Anti-eject: stayed on apps, and the drawer's displayed chat is the target.
    expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.apps)
    expect(app.result.current.activeChatId).toBe('chat-2')
    await waitFor(() => expect(app.result.current.chatMessagesLoading).toBe(false))
  })
})
