// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, waitFor } from '@testing-library/react'
import { DESKTOP_ROUTES } from '@constants/navigation'
import {
  installAppControllerClerum,
  renderAppController,
} from '../domain/__tests__/__fixtures__/appControllerHarness'
import { deferred } from '../domain/__tests__/__fixtures__/catalogFixtures'
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
    expect(app.result.current.activeChatId).toBe('chat-1')
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

  it('preserves the visible conversation while a no-chat notification is opened', async () => {
    const { clerum } = installAppControllerClerum({ agentNames: ['agent-x'] })
    await clerum.chat.create('agent-x', 'chat-1')
    await clerum.chat.upsertMessages('agent-x', 'chat-1', [
      { id: 'chat-1-message', role: 'user', content: 'visible chat history', timestamp: 1 },
    ])
    const originalSetLastActive = clerum.chat.setLastActive.getMockImplementation()
    if (!originalSetLastActive) throw new Error('Expected the mock setLastActive implementation')
    const entered = deferred<void>()
    const release = deferred<void>()
    const returned = deferred<void>()
    let held = false
    clerum.chat.setLastActive.mockImplementation(async (agentRef, chatId) => {
      if (agentRef === 'agent-x' && chatId === 'chat-1' && !held) {
        held = true
        entered.resolve()
        await release.promise
      }
      await originalSetLastActive(agentRef, chatId)
      if (held && chatId === 'chat-1') returned.resolve()
    })
    const app = renderAppController()
    unmount = app.unmount

    try {
      await waitFor(() => expect(app.result.current.isAuthenticated).toBe(true))
      await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false))

      act(() => {
        app.result.current.handleSelectChatAgent('agent-x', {
          chatId: 'chat-1',
          selectLatest: false,
        })
      })
      await act(async () => {
        await entered.promise
      })
      expect(app.result.current.activeChatId).toBe('chat-1')
      expect(app.result.current.chatMessagesLoading).toBe(true)

      await act(async () => {
        await app.result.current.handleOpenNotification({
          id: 'n-no-chat',
          kind: 'approval_required',
          agentName: 'agent-x',
          teamId: 'team-1',
          text: 'Open agent notification',
          timestamp: Date.now(),
          read: false,
          approval: { taskId: 't1', requestId: 'r1' },
        } as Parameters<typeof app.result.current.handleOpenNotification>[0])
      })
      const loadingAfterNotification = app.result.current.chatMessagesLoading

      await act(async () => {
        release.resolve()
        await returned.promise
      })
      await waitFor(() => expect(app.result.current.chatMessagesLoading).toBe(false))

      expect({
        activeChatId: app.result.current.activeChatId,
        loadingAfterNotification,
        messages: app.result.current.activeMessages,
        loadingAfter: app.result.current.chatMessagesLoading,
      }).toEqual({
        activeChatId: 'chat-1',
        loadingAfterNotification: true,
        messages: expect.arrayContaining([expect.objectContaining({ id: 'chat-1-message' })]),
        loadingAfter: false,
      })
    } finally {
      release.resolve()
      await act(async () => {
        await returned.promise
      })
      app.unmount()
      unmount = null
    }
  })

  it('reports a failed notification switch without starting an unobserved fallback', async () => {
    const { clerum } = installAppControllerClerum({ agentNames: ['agent-x'] })
    await clerum.chat.create('agent-x', 'chat-1')
    await clerum.chat.upsertMessages('agent-x', 'chat-1', [
      { id: 'chat-1-message', role: 'user', content: 'first chat', timestamp: 1 },
    ])
    await clerum.chat.create('agent-x', 'chat-2')
    const app = renderAppController()
    unmount = app.unmount

    try {
      await waitFor(() => expect(app.result.current.isAuthenticated).toBe(true))
      await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false))
      act(() => {
        app.result.current.handleSelectChatAgent('agent-x', {
          chatId: 'chat-1',
          selectLatest: false,
        })
      })
      await waitFor(() => {
        expect(app.result.current.activeChatId).toBe('chat-1')
        expect(app.result.current.chatMessagesLoading).toBe(false)
      })

      const callsBeforeOpen = clerum.chat.setLastActive.mock.calls.length
      clerum.chat.setLastActive.mockRejectedValueOnce(new Error('chat store write failed'))
      await act(async () => {
        await app.result.current.handleOpenNotification({
          id: 'n-failing-chat',
          kind: 'approval_required',
          agentName: 'agent-x',
          chatId: 'chat-2',
          teamId: 'team-1',
          text: 'Open chat two',
          timestamp: Date.now(),
          read: false,
          approval: { taskId: 't2', requestId: 'r2' },
        } as Parameters<typeof app.result.current.handleOpenNotification>[0])
      })
      await waitFor(() => expect(app.result.current.chatMessagesLoading).toBe(false))

      expect({
        switchAttempts: clerum.chat.setLastActive.mock.calls.length - callsBeforeOpen,
        statusText: app.result.current.statusText,
        statusTone: app.result.current.statusTone,
        loading: app.result.current.chatMessagesLoading,
      }).toEqual({
        switchAttempts: 1,
        statusText: expect.stringContaining('Could not open notification'),
        statusTone: 'error',
        loading: false,
      })
    } finally {
      app.unmount()
      unmount = null
    }
  })

  it('reports a failed direct chat-tab switch', async () => {
    const { clerum } = installAppControllerClerum({ agentNames: ['agent-x'] })
    await clerum.chat.create('agent-x', 'chat-1')
    await clerum.chat.create('agent-x', 'chat-2')
    const app = renderAppController()
    unmount = app.unmount

    try {
      await waitFor(() => expect(app.result.current.isAuthenticated).toBe(true))
      await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false))
      act(() => {
        app.result.current.handleSelectChatAgent('agent-x', {
          chatId: 'chat-1',
          selectLatest: false,
        })
      })
      await waitFor(() => {
        expect(app.result.current.activeChatId).toBe('chat-1')
        expect(app.result.current.chatMessagesLoading).toBe(false)
      })

      const callsBeforeSwitch = clerum.chat.setLastActive.mock.calls.length
      clerum.chat.setLastActive.mockRejectedValueOnce(new Error('chat store write failed'))
      act(() => {
        app.result.current.handleSelectChatAgent('agent-x', {
          chatId: 'chat-2',
          selectLatest: false,
        })
      })

      await waitFor(() => {
        expect(app.result.current.statusText).toContain('Could not open conversation')
        expect(app.result.current.statusTone).toBe('error')
        expect(app.result.current.chatMessagesLoading).toBe(false)
      })
      expect(clerum.chat.setLastActive).toHaveBeenCalledTimes(callsBeforeSwitch + 1)
    } finally {
      app.unmount()
      unmount = null
    }
  })
})
