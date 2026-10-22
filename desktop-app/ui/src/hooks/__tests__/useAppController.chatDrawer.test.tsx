// @vitest-environment jsdom
import { useCallback, useLayoutEffect, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NavigationContext, useNavigationContext } from '@contexts/NavigationContext'
import { act, cleanup, waitFor } from '@testing-library/react'
import { DESKTOP_ROUTES } from '@constants/navigation'
import { ChatPage } from '@pages/ChatPage'
import {
  createCatalog,
  installAppControllerClerum,
  renderAppController,
} from '../domain/__tests__/__fixtures__/appControllerHarness'
import { deferred, serverSessions } from '../domain/__tests__/__fixtures__/catalogFixtures'
import { renderChatActionConsumer } from '../domain/__tests__/__fixtures__/chatActionConsumerHarness'
import { ipcGenericForbidden } from '../domain/__tests__/__fixtures__/ipcErrors'
import { uninstallMockClerum } from '../domain/__tests__/__fixtures__/mockClerum'
import type { useAppController } from '../useAppController'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('@components/agents/AgentWorkspace', () => ({ AgentWorkspace: () => null }))

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

  it('keeps an implicit latest load when a no-chat notification arrives before it selects a chat', async () => {
    // This goes through the production notification action instead of calling
    // setPendingChatSelection directly.  At the notification point the agent
    // and chat route are already selected, but no chat ID has materialised yet.
    const { clerum } = installAppControllerClerum({ agentNames: ['agent-x'] })
    await clerum.chat.create('agent-x', 'chat-newest')
    await clerum.chat.upsertMessages('agent-x', 'chat-newest', [
      { id: 'newest-message', role: 'user', content: 'newest history', timestamp: 1 },
    ])
    const index = await clerum.readIndex('agent-x')
    const deferredIndex = deferred<Awaited<ReturnType<typeof clerum.chat.getIndex>>>()
    const app = renderAppController()
    unmount = app.unmount

    try {
      await waitFor(() => expect(app.result.current.isAuthenticated).toBe(true))
      await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false))
      clerum.chat.getIndex.mockClear()
      clerum.chat.getIndex.mockReturnValue(deferredIndex.promise)

      act(() => {
        app.result.current.handleSelectChatAgent('agent-x', { selectLatest: true })
      })
      await waitFor(() => expect(clerum.chat.getIndex).toHaveBeenCalledTimes(1))
      expect({
        activeChatId: app.result.current.activeChatId,
        loading: app.result.current.chatMessagesLoading,
        route: app.result.current.navItem,
      }).toEqual({ activeChatId: null, loading: false, route: DESKTOP_ROUTES.chat })

      await act(async () => {
        await app.result.current.handleOpenNotification({
          id: 'n-implicit-no-chat',
          kind: 'approval_required',
          agentName: 'agent-x',
          teamId: 'team-1',
          text: 'Agent notification without a conversation',
          timestamp: Date.now(),
          read: false,
          approval: { taskId: 't-implicit', requestId: 'r-implicit' },
        } as Parameters<typeof app.result.current.handleOpenNotification>[0])
      })

      await act(async () => {
        deferredIndex.resolve(index)
      })
      await waitFor(() => {
        expect({
          activeChatId: app.result.current.activeChatId,
          messages: app.result.current.activeMessages,
          loading: app.result.current.chatMessagesLoading,
        }).toEqual({
          activeChatId: 'chat-newest',
          messages: expect.arrayContaining([expect.objectContaining({ id: 'newest-message' })]),
          loading: false,
        })
      })
    } finally {
      deferredIndex.resolve(index)
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
    await clerum.chat.upsertMessages('agent-x', 'chat-2', [
      { id: 'chat-2-message', role: 'user', content: 'requested chat history', timestamp: 2 },
    ])
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
      const activeTabBeforeOpen = app.result.current.workspaceTabs.activeTabId
      expect(
        app.result.current.workspaceTabs.tabs.find(tab => tab.id === activeTabBeforeOpen)?.chat
          ?.chatId
      ).toBe('chat-1')
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

      expect(app.result.current.workspaceTabs.activeTabId).toBe(activeTabBeforeOpen)

      expect({
        switchAttempts: clerum.chat.setLastActive.mock.calls.length - callsBeforeOpen,
        activeChatId: app.result.current.activeChatId,
        transcript: app.result.current.activeMessages,
        errorCount: app.result.current.toasts.filter(toast =>
          toast.text.includes('Could not open notification')
        ).length,
        statusText: app.result.current.statusText,
        statusTone: app.result.current.statusTone,
        loading: app.result.current.chatMessagesLoading,
      }).toEqual({
        switchAttempts: 1,
        activeChatId: 'chat-2',
        transcript: [],
        errorCount: 1,
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
    for (const chat of ['chat-1', 'chat-2']) {
      await clerum.chat.upsertMessages('agent-x', chat, [
        { id: `${chat}-history`, role: 'user', content: `${chat} stored history`, timestamp: 1 },
      ])
    }
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
      expect(app.result.current.activeMessages).toEqual([
        expect.objectContaining({ id: 'chat-1-history' }),
      ])

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
      expect(app.result.current.activeChatId).toBe('chat-2')
      expect(app.result.current.activeMessages).toEqual([])
      expect(
        app.result.current.toasts.filter(toast =>
          toast.text.includes('Could not open conversation')
        )
      ).toHaveLength(1)
    } finally {
      app.unmount()
      unmount = null
    }
  })
})

const HOST_A = 'agent-a'
const HOST_B = 'agent-b'
const HOST_C = 'agent-c'
const DISPLAY: Record<string, string> = {
  [HOST_A]: 'Research Host',
  [HOST_B]: 'Billing Host',
  [HOST_C]: 'Ops Host',
}
const VERIFY_A = `Could not verify access to ${DISPLAY[HOST_A]}.`
const GONE_A = `${DISPLAY[HOST_A]} is no longer available.`
const GONE_B = `${DISPLAY[HOST_B]} is no longer available.`

// The producer names every Host it lists, and only those.
function namesOf(refs: string[]): Record<string, string> {
  return Object.fromEntries(
    refs.map(ref => {
      const name = DISPLAY[ref]
      if (!name) throw new Error(`no display name for ${ref}`)
      return [ref, name]
    })
  )
}

async function settle() {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 20))
  })
}

/**
 * The chat drawer over Files when the Host of its conversation is held. The
 * drawer is never the stored active tab, so the keep rule has to come from the
 * Host the hold interrupted, not from the tab strip.
 */
describe('useAppController — chat drawer over a held Host', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    uninstallMockClerum()
  })

  async function holdDrawerHost(options: { dropAOnHold: boolean; hosts?: string[] }) {
    const hosts = options.hosts ?? [HOST_A, HOST_B]
    const { clerum, handle } = installAppControllerClerum({
      agentNames: hosts,
      agentDisplayByName: namesOf(hosts),
    })
    clerum.rpc.listSessions.mockImplementation(async () => serverSessions([]))
    const pending = deferred<{ agent: string; chatId: string; turns: never[] }>()
    let reads = 0
    clerum.rpc.loadSessionMessages.mockImplementation((host: string) => {
      if (host === HOST_A && ++reads === 1) return pending.promise
      return Promise.resolve({ agent: host, chatId: 'drawer-chat', turns: [] })
    })
    const trail: Array<string | null> = []
    let setMounted: (value: boolean) => void = () => undefined
    let getController: Awaited<ReturnType<typeof renderChatActionConsumer>>['getVm'] | null = null
    function Drawer() {
      const vm = useNavigationContext()
      const [mounted, set] = useState(true)
      setMounted = set
      // App passes keepNavItem for every selection made while the drawer shows.
      const select = useCallback(
        (host: string, opts: Parameters<typeof vm.handleSelectChatAgent>[1] = {}) => {
          if (!getController) throw new Error('the controller is not rendered yet')
          getController().handleSelectChatAgent(host, { ...opts, keepNavItem: true })
        },
        []
      )
      useLayoutEffect(() => {
        trail.push(vm.selectedAgent)
      }, [vm.selectedAgent])
      return vm.navItem === DESKTOP_ROUTES.files && mounted ? (
        <div data-testid="drawer-chat">
          <NavigationContext.Provider value={{ ...vm, handleSelectChatAgent: select }}>
            <ChatPage scrollContainerRef={{ current: null }} />
          </NavigationContext.Provider>
        </div>
      ) : null
    }
    const utils = await renderChatActionConsumer(<Drawer />)
    const { getVm } = utils
    getController = getVm
    await waitFor(() => expect(handle.refreshCatalog).toHaveBeenCalledTimes(2))
    act(() => {
      getVm().handleNavSelect(DESKTOP_ROUTES.files)
    })
    // App writes the drawer's open intent on every render; this drawer is open.
    getVm().chatDrawerDesiredRef.current = true
    // Liveness: the drawer's ChatPage auto-selection runs.
    await waitFor(() => expect(getVm().selectedAgent).toBe(HOST_A))
    act(() => {
      getVm().handleSelectChatAgent(HOST_A, {
        chatId: 'drawer-chat',
        selectLatest: false,
        keepNavItem: true,
      })
    })
    await waitFor(() => expect(clerum.rpc.loadSessionMessages).toHaveBeenCalled())
    expect(getVm().activeWorkspaceTab?.kind).toBe(DESKTOP_ROUTES.files)
    if (options.dropAOnHold) {
      const remaining = hosts.filter(host => host !== HOST_A)
      handle.refreshCatalog.mockImplementation(async () =>
        createCatalog(remaining, namesOf(remaining))
      )
    }
    const start = trail.length
    await act(async () => {
      pending.reject(await ipcGenericForbidden('rpc:loadSessionMessages'))
      await pending.promise.catch(() => undefined)
    })
    await waitFor(() => expect(getVm().isHostAccessBlocked(HOST_A)).toBe(true))
    await settle()
    return { ...utils, handle, trail, start, setMounted: (value: boolean) => setMounted(value) }
  }

  it('T-R5M1-1 keeps the drawer on the held Host instead of selecting another one', async () => {
    const { getVm, trail, start } = await holdDrawerHost({ dropAOnHold: false })

    // Witness: the hold deselected A.
    expect(trail.slice(start)).toEqual([null])
    expect(getVm().heldAgentRefs).toEqual([HOST_A])
    expect(getVm().keepFocusedChat).toBe(true)
    expect(getVm().selectedAgent).toBe(null)
    expect(getVm().toasts.map(toast => toast.text)).toEqual([VERIFY_A])
  })

  it('T-R5M1-2 still selects no other Host after the drawer is unmounted and mounted again', async () => {
    const { getVm, trail, start, setMounted, queryByTestId } = await holdDrawerHost({
      dropAOnHold: false,
    })

    act(() => setMounted(false))
    await settle()
    // Witness: the drawer's ChatPage left the tree and came back.
    expect(queryByTestId('drawer-chat')).toBeNull()
    act(() => setMounted(true))
    await settle()
    expect(queryByTestId('drawer-chat')).not.toBeNull()

    expect(getVm().isHostAccessBlocked(HOST_A)).toBe(true)
    expect(trail.slice(start)).toEqual([null])
    expect(getVm().selectedAgent).toBe(null)
  })

  it('T-R5M1-3 selects a listed Host and says so when the held Host leaves the catalog', async () => {
    const { getVm, trail, start } = await holdDrawerHost({ dropAOnHold: true })

    await waitFor(() => expect(getVm().selectedAgent).toBe(HOST_B))
    // Witness: A was deselected by the hold before B was picked.
    expect(trail.slice(start)).toEqual([null, HOST_B])
    expect(getVm().heldAgentRefs).toEqual([])
    expect(getVm().keepFocusedChat).toBe(false)
    expect(getVm().toasts.map(toast => toast.text)).toEqual([VERIFY_A, GONE_A])
  })

  it('T-R5M1-4 forgets the interrupted Host once the user selects another one', async () => {
    const { getVm, handle, trail, start } = await holdDrawerHost({
      dropAOnHold: false,
      hosts: [HOST_A, HOST_B, HOST_C],
    })
    expect(getVm().selectedAgent).toBe(null)

    act(() => {
      getVm().handleSelectChatAgent(HOST_B, { selectLatest: false, keepNavItem: true })
    })
    await waitFor(() => expect(getVm().selectedAgent).toBe(HOST_B))
    handle.refreshCatalog.mockImplementation(async () =>
      createCatalog([HOST_A, HOST_C], namesOf([HOST_A, HOST_C]))
    )
    await act(async () => {
      await getVm().handleRefreshWorkspaceData(DESKTOP_ROUTES.agents)
    })
    await settle()

    // Witness: B was selected, then deselected when it left; A is still held and listed.
    expect(trail.slice(start, start + 2)).toEqual([null, HOST_B])
    expect(getVm().heldAgentRefs).toEqual([HOST_A])
    expect(getVm().selectedAgent).toBe(HOST_C)
    expect(getVm().toasts.map(toast => toast.text)).toEqual([VERIFY_A, GONE_B])
  })

  it('T-R5F1-1 a hold made while no drawer showed the chat does not keep a later drawer blank', async () => {
    const { clerum, handle } = installAppControllerClerum({
      agentNames: [HOST_A, HOST_B],
      agentDisplayByName: namesOf([HOST_A, HOST_B]),
    })
    const denied = await ipcGenericForbidden('rpc:listSessions')
    const gate = deferred<void>()
    let pageReadsA = 0
    let verifyReadsA = 0
    clerum.rpc.listSessions.mockImplementation(
      async (host: string, _team: string, query?: { limit?: number }) => {
        if (host !== HOST_A) return serverSessions([])
        if (query?.limit === 1) {
          verifyReadsA += 1
          throw denied
        }
        pageReadsA += 1
        await gate.promise
        throw denied
      }
    )
    const trail: Array<string | null> = []
    let openDrawer: (value: boolean) => void = () => undefined
    let getController: Awaited<ReturnType<typeof renderChatActionConsumer>>['getVm'] | null = null
    function Drawer() {
      const vm = useNavigationContext()
      const [open, setOpen] = useState(false)
      openDrawer = setOpen
      const select = useCallback(
        (host: string, opts: Parameters<typeof vm.handleSelectChatAgent>[1] = {}) => {
          if (!getController) throw new Error('the controller is not rendered yet')
          getController().handleSelectChatAgent(host, { ...opts, keepNavItem: true })
        },
        []
      )
      const showing = open && vm.navItem === DESKTOP_ROUTES.files
      // App writes the open intent on every render (`App.tsx` chatDrawerDesired).
      useLayoutEffect(() => {
        if (getController) getController().chatDrawerDesiredRef.current = showing
      })
      useLayoutEffect(() => {
        trail.push(vm.selectedAgent)
      }, [vm.selectedAgent])
      return showing ? (
        <div data-testid="drawer-chat">
          <NavigationContext.Provider value={{ ...vm, handleSelectChatAgent: select }}>
            <ChatPage scrollContainerRef={{ current: null }} />
          </NavigationContext.Provider>
        </div>
      ) : null
    }
    const { getVm, queryByTestId } = await renderChatActionConsumer(<Drawer />)
    getController = getVm
    await waitFor(() => expect(handle.refreshCatalog).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(pageReadsA).toBeGreaterThan(0))

    // A is selected from Agents; no drawer is open when its read is denied.
    act(() => getVm().handleOpenAgentWorkspace(HOST_A))
    await waitFor(() => expect(getVm().selectedAgent).toBe(HOST_A))
    expect(getVm().navItem).toBe(DESKTOP_ROUTES.agents)
    expect(queryByTestId('drawer-chat')).toBeNull()
    await act(async () => {
      gate.resolve()
      await gate.promise
    })
    await waitFor(() => expect(getVm().isHostAccessBlocked(HOST_A)).toBe(true))
    await waitFor(() => expect(getVm().selectedAgent).toBe(null))

    act(() => getVm().handleNavSelect(DESKTOP_ROUTES.files))
    await waitFor(() => expect(getVm().activeWorkspaceTab?.kind).toBe(DESKTOP_ROUTES.files))
    expect(getVm().keepFocusedChat).toBe(false)
    act(() => openDrawer(true))
    await waitFor(() => expect(queryByTestId('drawer-chat')).not.toBeNull())
    await settle()

    // The first drawer picks the listed, not held Host, without verifying A.
    expect(getVm().isHostAccessBlocked(HOST_A)).toBe(true)
    expect(verifyReadsA).toBe(0)
    expect(getVm().selectedAgent).toBe(HOST_B)
    expect(getVm().toasts.map(toast => toast.text)).toEqual([VERIFY_A])
  })

  it('T-R5F1-2 keeps the drawer on A when the hold lands while the width hides the drawer', async () => {
    const { clerum, handle } = installAppControllerClerum({
      agentNames: [HOST_A, HOST_B],
      agentDisplayByName: namesOf([HOST_A, HOST_B]),
    })
    clerum.rpc.listSessions.mockImplementation(async () => serverSessions([]))
    const pending = deferred<{ agent: string; chatId: string; turns: never[] }>()
    let transcriptReadsA = 0
    clerum.rpc.loadSessionMessages.mockImplementation((host: string) => {
      if (host === HOST_A && ++transcriptReadsA === 1) return pending.promise
      return Promise.resolve({ agent: host, chatId: 'drawer-chat', turns: [] })
    })
    const trail: Array<string | null> = []
    let setVisible: (value: boolean) => void = () => undefined
    let getController: Awaited<ReturnType<typeof renderChatActionConsumer>>['getVm'] | null = null
    function Drawer() {
      const vm = useNavigationContext()
      const [visible, set] = useState(true)
      setVisible = set
      const select = useCallback(
        (host: string, opts: Parameters<typeof vm.handleSelectChatAgent>[1] = {}) => {
          if (!getController) throw new Error('the controller is not rendered yet')
          getController().handleSelectChatAgent(host, { ...opts, keepNavItem: true })
        },
        []
      )
      const desired = vm.navItem === DESKTOP_ROUTES.files
      // The drawer stays open while the width hides it: intent true, visibility false.
      useLayoutEffect(() => {
        if (getController) getController().chatDrawerDesiredRef.current = desired
      })
      useLayoutEffect(() => {
        trail.push(vm.selectedAgent)
      }, [vm.selectedAgent])
      return desired && visible ? (
        <div data-testid="drawer-chat">
          <NavigationContext.Provider value={{ ...vm, handleSelectChatAgent: select }}>
            <ChatPage scrollContainerRef={{ current: null }} />
          </NavigationContext.Provider>
        </div>
      ) : null
    }
    const { getVm, queryByTestId } = await renderChatActionConsumer(<Drawer />)
    getController = getVm
    await waitFor(() => expect(handle.refreshCatalog).toHaveBeenCalledTimes(2))
    act(() => getVm().handleNavSelect(DESKTOP_ROUTES.files))
    await waitFor(() => expect(queryByTestId('drawer-chat')).not.toBeNull())
    await waitFor(() => expect(getVm().selectedAgent).toBe(HOST_A))
    act(() =>
      getVm().handleSelectChatAgent(HOST_A, {
        chatId: 'drawer-chat',
        selectLatest: false,
        keepNavItem: true,
      })
    )
    await waitFor(() => expect(clerum.rpc.loadSessionMessages).toHaveBeenCalled())
    expect(transcriptReadsA).toBe(1)
    act(() => setVisible(false))
    // Witness: the drawer is hidden while its read of A is still pending.
    expect(queryByTestId('drawer-chat')).toBeNull()
    const beforeHold = trail.length
    await act(async () => {
      pending.reject(await ipcGenericForbidden('rpc:loadSessionMessages'))
      await pending.promise.catch(() => undefined)
    })
    await waitFor(() => expect(getVm().isHostAccessBlocked(HOST_A)).toBe(true))
    await waitFor(() => expect(getVm().selectedAgent).toBe(null))
    expect(getVm().heldAgentRefs).toEqual([HOST_A])

    act(() => setVisible(true))
    await waitFor(() => expect(queryByTestId('drawer-chat')).not.toBeNull())
    await settle()
    expect(getVm().isHostAccessBlocked(HOST_A)).toBe(true)
    expect(getVm().keepFocusedChat).toBe(true)
    expect(getVm().selectedAgent).toBe(null)
    expect(trail.slice(beforeHold)).toEqual([null])
  })

  it('T-R5F2-1 opening the Apps picker over Files keeps the drawer on the held Host', async () => {
    const { clerum, handle } = installAppControllerClerum({
      agentNames: [HOST_A, HOST_B],
      agentDisplayByName: namesOf([HOST_A, HOST_B]),
    })
    clerum.rpc.listSessions.mockImplementation(async () => serverSessions([]))
    const pending = deferred<{ agent: string; chatId: string; turns: never[] }>()
    let transcriptReadsA = 0
    clerum.rpc.loadSessionMessages.mockImplementation((host: string) => {
      if (host === HOST_A && ++transcriptReadsA === 1) return pending.promise
      return Promise.resolve({ agent: host, chatId: 'drawer-chat', turns: [] })
    })
    const trail: Array<string | null> = []
    let getController: Awaited<ReturnType<typeof renderChatActionConsumer>>['getVm'] | null = null
    function Drawer() {
      const vm = useNavigationContext()
      const select = useCallback(
        (host: string, opts: Parameters<typeof vm.handleSelectChatAgent>[1] = {}) => {
          if (!getController) throw new Error('the controller is not rendered yet')
          getController().handleSelectChatAgent(host, { ...opts, keepNavItem: true })
        },
        []
      )
      // The harness provides the whole controller vm; App mounts the drawer
      // over any non-chat tab, the Apps picker included (`App.tsx` drawerAvailable).
      const activeKind = (vm as { activeWorkspaceTab?: { kind: string } }).activeWorkspaceTab?.kind
      const desired = activeKind !== undefined && activeKind !== 'chat'
      useLayoutEffect(() => {
        if (getController) getController().chatDrawerDesiredRef.current = desired
      })
      useLayoutEffect(() => {
        trail.push(vm.selectedAgent)
      }, [vm.selectedAgent])
      return desired ? (
        <div data-testid="drawer-chat">
          <NavigationContext.Provider value={{ ...vm, handleSelectChatAgent: select }}>
            <ChatPage scrollContainerRef={{ current: null }} />
          </NavigationContext.Provider>
        </div>
      ) : null
    }
    const { getVm, queryByTestId } = await renderChatActionConsumer(<Drawer />)
    getController = getVm
    await waitFor(() => expect(handle.refreshCatalog).toHaveBeenCalledTimes(2))
    act(() => getVm().handleNavSelect(DESKTOP_ROUTES.files))
    await waitFor(() => expect(queryByTestId('drawer-chat')).not.toBeNull())
    await waitFor(() => expect(getVm().selectedAgent).toBe(HOST_A))
    act(() =>
      getVm().handleSelectChatAgent(HOST_A, {
        chatId: 'drawer-chat',
        selectLatest: false,
        keepNavItem: true,
      })
    )
    await waitFor(() => expect(clerum.rpc.loadSessionMessages).toHaveBeenCalled())
    await act(async () => {
      pending.reject(await ipcGenericForbidden('rpc:loadSessionMessages'))
      await pending.promise.catch(() => undefined)
    })
    await waitFor(() => expect(getVm().isHostAccessBlocked(HOST_A)).toBe(true))
    await waitFor(() => expect(getVm().selectedAgent).toBe(null))
    expect(getVm().heldAgentRefs).toEqual([HOST_A])
    const beforePicker = trail.length

    act(() => getVm().handleNavSelect(DESKTOP_ROUTES.apps))
    await waitFor(() => expect(getVm().appsPickerActive).toBe(true))
    await settle()
    // Witnesses: the picker is open, Files is still the stored tab, and the
    // drawer's ChatPage is still mounted under it.
    expect(getVm().activeWorkspaceTab?.kind).toBe(DESKTOP_ROUTES.files)
    expect(queryByTestId('drawer-chat')).not.toBeNull()
    expect(getVm().isHostAccessBlocked(HOST_A)).toBe(true)
    expect(getVm().keepFocusedChat).toBe(true)
    expect(getVm().selectedAgent).toBe(null)
    expect(trail.slice(beforePicker)).toEqual([])
  })

  // T-A29A1-1: a conversation held in the full-screen chat tab has no drawer
  // marker. Opening the drawer over Files restores that tab's chat with
  // `keepNavItem`, which verifies the held Host; the drawer must not choose
  // another Host while the verification runs.
  it.each(['verified', 'denied'] as const)(
    'keeps the held Host the drawer restores while its verification is %s',
    async outcome => {
      const { clerum, handle } = installAppControllerClerum({
        agentNames: [HOST_A, HOST_B],
        agentDisplayByName: namesOf([HOST_A, HOST_B]),
      })
      const pendingTranscript = deferred<{ agent: string; chatId: string; turns: never[] }>()
      const pendingVerify = deferred<ReturnType<typeof serverSessions>>()
      let transcriptReads = 0
      let verifyReads = 0
      clerum.rpc.loadSessionMessages.mockImplementation((host: string) => {
        if (host === HOST_A && ++transcriptReads === 1) return pendingTranscript.promise
        return Promise.resolve({ agent: host, chatId: 'saved-chat-a', turns: [] })
      })
      clerum.rpc.listSessions.mockImplementation(
        async (host: string, _team: string, query?: { limit?: number }) => {
          if (host === HOST_A && query?.limit === 1) {
            verifyReads++
            return pendingVerify.promise
          }
          return serverSessions([])
        }
      )

      const trail: Array<string | null> = []
      let openDrawer: () => void = () => {
        throw new Error('the surface is not mounted')
      }
      let rerenderOwner: () => void = () => {
        throw new Error('the controller is not mounted')
      }
      function Surface() {
        // The harness provides the whole controller vm.
        const vm = useNavigationContext() as ReturnType<typeof useAppController>
        const [open, setOpen] = useState(false)
        const available =
          vm.activeWorkspaceTab !== undefined && vm.activeWorkspaceTab.kind !== 'chat'
        const desired = available && open
        // App writes the drawer's open intent on every render.
        vm.chatDrawerDesiredRef.current = desired
        const select = useCallback(
          (host: string, opts: Parameters<typeof vm.handleSelectChatAgent>[1] = {}) => {
            vm.clearAppsPicker()
            vm.handleSelectChatAgent(host, desired ? { ...opts, keepNavItem: true } : opts)
          },
          [vm.handleSelectChatAgent, vm.clearAppsPicker, desired]
        )
        // App's drawer open over Files: no launch origin, so it restores the
        // last persisted chat tab.
        openDrawer = () => {
          setOpen(true)
          rerenderOwner()
          const hasActiveChat = Boolean(vm.selectedAgent && vm.activeChatId)
          const last =
            !hasActiveChat && vm.lastActiveChatTabId
              ? vm.workspaceTabs.tabs.find(
                  tab => tab.id === vm.lastActiveChatTabId && tab.kind === 'chat'
                )
              : undefined
          if (last?.chat?.agentRef && last.chat.chatId) {
            vm.handleSelectChatAgent(last.chat.agentRef, {
              chatId: last.chat.chatId,
              title: last.title,
              selectLatest: false,
              keepNavItem: true,
            })
          }
        }
        useLayoutEffect(() => {
          trail.push(vm.selectedAgent)
        }, [vm.selectedAgent])
        return vm.navItem === DESKTOP_ROUTES.chat || desired ? (
          <NavigationContext.Provider value={{ ...vm, handleSelectChatAgent: select }}>
            <div data-testid={desired ? 'drawer-chat' : 'full-chat'}>
              <ChatPage scrollContainerRef={{ current: null }} />
            </div>
          </NavigationContext.Provider>
        ) : null
      }

      const { getVm, queryByTestId, rerenderController } = await renderChatActionConsumer(
        <Surface />
      )
      rerenderOwner = rerenderController
      await waitFor(() => expect(handle.refreshCatalog).toHaveBeenCalledTimes(2))
      await waitFor(() => expect(getVm().selectedAgent).toBe(HOST_A))
      act(() =>
        getVm().handleSelectChatAgent(HOST_A, { chatId: 'saved-chat-a', selectLatest: false })
      )
      await waitFor(() => expect(transcriptReads).toBe(1))
      expect(queryByTestId('full-chat')).not.toBeNull()
      await act(async () => {
        pendingTranscript.reject(await ipcGenericForbidden('rpc:loadSessionMessages'))
        await pendingTranscript.promise.catch(() => undefined)
      })
      // Witnesses: A is held from the full-screen tab, and that tab is the
      // last chat tab the drawer will restore.
      await waitFor(() => expect(getVm().isHostAccessBlocked(HOST_A)).toBe(true))
      await waitFor(() => expect(getVm().selectedAgent).toBe(null))
      expect(getVm().keepFocusedChat).toBe(true)
      expect(getVm().heldHosts).toEqual([{ agentRef: HOST_A, label: DISPLAY[HOST_A] }])
      const last = getVm().lastActiveChatTabId
      expect(getVm().workspaceTabs.tabs.find(tab => tab.id === last)?.chat).toMatchObject({
        agentRef: HOST_A,
        chatId: 'saved-chat-a',
      })

      act(() => getVm().handleNavSelect(DESKTOP_ROUTES.files))
      expect(queryByTestId('full-chat')).toBeNull()
      expect(queryByTestId('drawer-chat')).toBeNull()
      act(() => openDrawer())
      // Witness: the restore reached A's verification and the drawer shows.
      await waitFor(() => expect(verifyReads).toBe(1))
      expect(queryByTestId('drawer-chat')).not.toBeNull()
      await settle()
      const selectedWhilePending = getVm().selectedAgent
      await act(async () => {
        if (outcome === 'verified') pendingVerify.resolve(serverSessions([]))
        else pendingVerify.reject(await ipcGenericForbidden('rpc:listSessions'))
        await pendingVerify.promise.catch(() => undefined)
      })
      await settle()
      expect(selectedWhilePending, 'opening the drawer must not choose B while restoring A').toBe(
        null
      )
      expect(trail).not.toContain(HOST_B)
      expect(getVm().selectedAgent).toBe(outcome === 'verified' ? HOST_A : null)
      if (outcome === 'verified') expect(getVm().activeChatId).toBe('saved-chat-a')
    }
  )
})
