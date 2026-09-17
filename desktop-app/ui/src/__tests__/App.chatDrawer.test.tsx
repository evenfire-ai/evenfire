// @vitest-environment jsdom
import { useReducer } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useNotificationsContext } from '@contexts/NotificationsContext'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DESKTOP_ROUTES } from '@constants/navigation'
import { useAppController } from '@hooks/useAppController'
import {
  activeWorkspaceTab,
  createWorkspaceTabsState,
  newChatTab,
  openChatTab,
  openFilesTab,
  openSettingsTab,
} from '@lib/workspaceTabs'
import { mapKindToRoute, settingsSectionForRoute } from '@lib/workspaceTabsRoute'
import { App } from '@/App'
import type { AppNotification } from '@/uiTypes'

// The universal tab store now lives inside the controller (single writer;
// `navItem` derives from the active tab). These tests mock the controller, so
// the mock reproduces that contract faithfully: `navItem` is DERIVED from the
// store in `useReactiveController` (never a hand-set field), `setWorkspaceTabs`
// bails out on an unchanged reference like React's setState, and the nav /
// selection handlers drive the store through the real producers so the real
// reconcile effect and real ChatSwitcher stay store-driven (T1).
let forceControllerRender: () => void = () => {}

function useReactiveController(controller: AppController): AppController {
  const [, force] = useReducer((count: number) => count + 1, 0)
  forceControllerRender = force
  const activeTab = activeWorkspaceTab(controller.workspaceTabs)
  ;(controller as { activeWorkspaceTab: unknown }).activeWorkspaceTab = activeTab
  ;(controller as { navItem: unknown }).navItem = controller.appsPickerActive
    ? DESKTOP_ROUTES.apps
    : mapKindToRoute(activeTab)
  return controller
}

type WorkspaceState = ReturnType<typeof useAppController>['workspaceTabs']

// Store-driving helpers that mirror the real controller (focus a chat tab /
// activate a specific chat), reused by the mock's nav + selection handlers.
function focusChatState(state: WorkspaceState, nextId: string): WorkspaceState {
  const active = activeWorkspaceTab(state)
  if (active?.kind === 'chat') return state
  const lastChat = [...state.tabs].reverse().find(tab => tab.kind === 'chat')
  return lastChat ? { ...state, activeTabId: lastChat.id } : newChatTab(state, nextId, null)
}
function activateChatState(
  state: WorkspaceState,
  agentRef: string | null,
  chatId: string | null,
  nextId: string
): WorkspaceState {
  return chatId
    ? openChatTab(state, { id: nextId, agentRef, chatId })
    : newChatTab(state, nextId, agentRef)
}

// Keep @components/Common, ChatDrawer and ChatSwitcher REAL so the drawer's
// open-chats switcher renders and can be driven. Everything else that App mounts
// is stubbed to null / prop-capture.
const sidebarHarness = vi.hoisted(() => ({
  props: null as null | {
    onOpenSandboxUiApp?: (app: { appRef: string; label: string; defaultPath: string }) => void
  },
}))
const sandboxUiPageHarness = vi.hoisted(() => ({
  props: null as null | {
    onEmbeddedAppMounted?: () => void
    onEmbedBoundsApplied?: () => void
    onEmbedSlotTopChange?: (topPx: number) => void
    onEmbedSlotRightChange?: (rightPx: number) => void
  },
}))
const appHeaderHarness = vi.hoisted(() => ({
  props: null as null | {
    notificationTrayMode?: 'drawer' | 'overlay'
    notificationTrayLeft?: number | null
    // Drawer toggle moved to the app header (mini-spec 04a §C): the drawer's
    // effective visibility and its toggle are now driven from here, on EVERY
    // route (the header is portaled into the title bar unconditionally), not from
    // the apps-only SandboxUiPage.
    drawerAvailable?: boolean
    chatDrawerOpen?: boolean
    onToggleChatDrawer?: () => void
  },
  // Captured from context so tests can drive the "open conversation" gesture the
  // notification tray fires.
  openNotification: null as null | ((notification: AppNotification) => Promise<void>),
}))

vi.mock('@hooks/useAppController', () => ({ useAppController: vi.fn() }))
vi.mock('@hooks/useAgentChatActionsValue', () => ({ useAgentChatActionsValue: () => ({}) }))
vi.mock('@components/AppHeader', () => ({
  AppHeader: (props: NonNullable<typeof appHeaderHarness.props>) => {
    appHeaderHarness.props = props
    appHeaderHarness.openNotification = useNotificationsContext().handleOpenNotification
    return null
  },
}))
vi.mock('@components/ChatLocalSearch', () => ({ ChatLocalSearch: () => null }))
vi.mock('@components/CommandPalette', () => ({ CommandPalette: () => null }))
vi.mock('@components/BootSplash', () => ({ BootSplash: () => null }))
vi.mock('@components/ConfirmDialog', () => ({ ConfirmDialog: () => null }))
vi.mock('@components/GfsImagePreview', () => ({ GfsImagePreview: () => null }))
vi.mock('@components/PluginConsentModal', () => ({ PluginConsentModal: () => null }))
vi.mock('@components/SidebarNav', () => ({
  SidebarNav: (props: NonNullable<typeof sidebarHarness.props>) => {
    sidebarHarness.props = props
    return null
  },
}))
vi.mock('@pages/AgentsPage', () => ({ AgentsPage: () => null }))
vi.mock('@pages/AuthPage', () => ({ AuthPage: () => null }))
// The real ChatPage is heavy; stub it, but surface the two things the drawer/
// full-screen conversation is supposed to carry — the active chat identity and
// the composer-focus pulse — through the real composer-state context. That lets
// the eject test assert the RENDERED conversation (and its focus request) rather
// than hand-written controller state.
vi.mock('@pages/ChatPage', async () => {
  const { useChatComposerStateContext } = await import('@contexts/ChatComposerStateContext')
  return {
    ChatPage: () => {
      const { activeChatId, composerFocusRequestId } = useChatComposerStateContext()
      return (
        <div
          data-testid="chat-page-surface"
          data-active-chat-id={activeChatId ?? ''}
          data-composer-focus-request-id={composerFocusRequestId}
        />
      )
    },
  }
})
vi.mock('@pages/ContextDetailsPage', () => ({ ContextDetailsPage: () => null }))
vi.mock('@pages/ContextsPage', () => ({ ContextsPage: () => null }))
vi.mock('@pages/FilesPage', () => ({ FilesPage: () => null }))
vi.mock('@pages/McpServersPage', () => ({ McpServersPage: () => null }))
vi.mock('@pages/SandboxUiPage', () => ({
  SandboxUiPage: (props: NonNullable<typeof sandboxUiPageHarness.props>) => {
    sandboxUiPageHarness.props = props
    return null
  },
}))
vi.mock('@pages/SettingsPage', () => ({ SettingsPage: () => null }))
vi.mock('@pages/TeamDetailsPage', () => ({ TeamDetailsPage: () => null }))
vi.mock('@pages/TeamsPage', () => ({ TeamsPage: () => null }))
vi.mock('@pages/UnavailablePage', () => ({ UnavailablePage: () => null }))
vi.mock('@pages/WorkflowsPage', () => ({ WorkflowsPage: () => null }))

type AppController = ReturnType<typeof useAppController>

function makeController(overrides: Partial<AppController> = {}): AppController {
  const noop = vi.fn()
  let controller: AppController
  let tabSequence = 2
  const nextWorkspaceTabId = vi.fn(() => `ws-tab-${tabSequence++}`)
  // React-setState-faithful: bail out on an unchanged reference (so the
  // idempotent reconcile effect can't spin), otherwise commit + re-render.
  const setWorkspaceTabs = vi.fn((updater: unknown) => {
    const next =
      typeof updater === 'function'
        ? (updater as (state: AppController['workspaceTabs']) => AppController['workspaceTabs'])(
            controller.workspaceTabs
          )
        : (updater as AppController['workspaceTabs'])
    if (next === controller.workspaceTabs) return
    controller.workspaceTabs = next
    forceControllerRender()
  })
  const clearAppsPicker = vi.fn(() => {
    if (!controller.appsPickerActive) return
    controller.appsPickerActive = false
    forceControllerRender()
  })
  const showAppsPicker = vi.fn(() => {
    // The picker residual is redundant when an app tab is already active.
    if (controller.appsPickerActive) return
    if (activeWorkspaceTab(controller.workspaceTabs)?.kind === 'app') return
    controller.appsPickerActive = true
    forceControllerRender()
  })
  // Faithful to the real controller: nav is a store action. `navItem` is derived
  // (useReactiveController), so these drive the store — never set navItem.
  const handleNavSelect = vi.fn((item: AppController['navItem']) => {
    if (item === DESKTOP_ROUTES.chat) {
      controller.selectedAgent = null
      clearAppsPicker()
      setWorkspaceTabs((state: WorkspaceState) => focusChatState(state, nextWorkspaceTabId()))
    } else if (item === DESKTOP_ROUTES.apps) {
      showAppsPicker()
    } else if (item === DESKTOP_ROUTES.files) {
      clearAppsPicker()
      setWorkspaceTabs((state: WorkspaceState) => openFilesTab(state, { id: nextWorkspaceTabId() }))
    } else {
      const section = settingsSectionForRoute(item)
      if (section) {
        if (section === 'agents') controller.selectedAgent = null
        clearAppsPicker()
        setWorkspaceTabs((state: WorkspaceState) =>
          openSettingsTab(state, { id: nextWorkspaceTabId(), section })
        )
      }
    }
    forceControllerRender()
  })
  // Faithful to the real vm: selecting an agent/chat moves the primary
  // `vm.activeChatId`/`selectedAgent`, and (non-keepNavItem) activates the chat
  // tab so `navItem` derives to `chat`. `keepNavItem` leaves the active tab (the
  // app tab) untouched so the route stays on `apps`.
  const handleSelectChatAgent = vi.fn(
    (agentName: string, options: { chatId?: string; keepNavItem?: boolean } = {}) => {
      controller.selectedAgent = agentName
      controller.activeChatId = options.chatId ?? null
      if (!options.keepNavItem) {
        clearAppsPicker()
        setWorkspaceTabs((state: WorkspaceState) =>
          activateChatState(state, agentName, options.chatId ?? null, nextWorkspaceTabId())
        )
      }
      forceControllerRender()
    }
  )
  // Faithful to the real openAgentConversationTarget: `keepNavItem` (passed by
  // App's drawer-aware wrapper) surfaces the chat WITHOUT flipping navItem;
  // otherwise it ejects to the full-screen chat route.
  const handleOpenNotification = vi.fn(
    (
      notification: { kind?: string; agentName?: string; chatId?: string },
      options: { keepNavItem?: boolean } = {}
    ) => {
      // Faithful routing: workflow notifications navigate to the plugins section;
      // sdk notifications navigate away without touching the agent chat state.
      if (notification.kind === 'workflow_completed') {
        clearAppsPicker()
        setWorkspaceTabs((state: WorkspaceState) =>
          openSettingsTab(state, { id: nextWorkspaceTabId(), section: 'plugins' })
        )
        forceControllerRender()
        return Promise.resolve()
      }
      if (notification.kind === 'sdk_notification') return Promise.resolve()
      controller.selectedAgent = notification.agentName ?? controller.selectedAgent
      controller.activeChatId = notification.chatId ?? null
      if (!options.keepNavItem) {
        clearAppsPicker()
        setWorkspaceTabs((state: WorkspaceState) =>
          activateChatState(
            state,
            controller.selectedAgent,
            notification.chatId ?? null,
            nextWorkspaceTabId()
          )
        )
      }
      forceControllerRender()
      return Promise.resolve()
    }
  )
  controller = {
    booting: false,
    initialExperienceLoading: false,
    busy: false,
    statusText: '',
    statusTone: 'info',
    isAuthenticated: true,
    authenticatedPrincipalIdentity: 'user-a:user-a@example.com',
    me: { id: 'user-a', email: 'user-a@example.com', name: 'User A', teamId: 'team-a' },
    currentTeamId: 'team-a',
    navItem: DESKTOP_ROUTES.chat,
    selectedAgent: null,
    selectedAgentRoute: null,
    selectedContext: null,
    selectedTeam: null,
    workspaceTabs: createWorkspaceTabsState('chat-tab-1'),
    setWorkspaceTabs,
    activeWorkspaceTab: undefined,
    nextWorkspaceTabId,
    appsPickerActive: false,
    showAppsPicker,
    clearAppsPicker,
    activateWorkspaceChatTab: noop,
    activeChatId: null,
    chatList: [],
    latestChatSessions: [],
    notifications: [],
    toasts: [],
    pendingApprovals: [],
    composerImageAttachments: [],
    composerReferenceAttachments: [],
    groupedMessages: [],
    activeMessages: [],
    notificationActionById: {},
    sessionStateByChatId: {},
    sessionStateByChatKey: {},
    activityByMessageId: {},
    progressByMessageId: {},
    agentLastActiveByAgent: {},
    dependencyHealth: null,
    hasDependencyOutage: false,
    desktopEnvironmentSetupComplete: false,
    pendingDesktopEnvironmentSetup: null,
    desktopReleaseStatus: null,
    showRuntimeConfigSelector: false,
    runtimeConfigMissing: false,
    authTransitioning: false,
    handleEnsureTeamContext: vi.fn(async () => false),
    getCurrentTeamId: vi.fn(() => 'team-a'),
    handleSelectChatAgent,
    handleOpenNotification,
    handleNavSelect,
    handleLogout: vi.fn(),
    pushToast: vi.fn(),
    setStatus: noop,
    setBooting: noop,
    ...overrides,
  } as unknown as AppController
  // `navItem` is derived from the store (useReactiveController), so an override
  // that names a starting route is translated into the store state that derives
  // to it — never a hand-set `navItem` field.
  if (overrides.navItem) {
    const route = overrides.navItem
    if (route === DESKTOP_ROUTES.apps) {
      controller.appsPickerActive = true
    } else if (route === DESKTOP_ROUTES.files) {
      controller.workspaceTabs = openFilesTab(controller.workspaceTabs, { id: 'seed-files' })
    } else if (route !== DESKTOP_ROUTES.chat) {
      const section = settingsSectionForRoute(route)
      if (section) {
        controller.workspaceTabs = openSettingsTab(controller.workspaceTabs, {
          id: `seed-${section}`,
          section,
        })
      }
    }
  }
  return controller
}

// dev extended ChatMetadata (SidebarChatEntry's base) with the now-required
// createdAt/updatedAt/messageCount fields; the fixture carries them so it
// matches vm.chatList's real shape. The values are inert for these tests,
// which assert on the displayed title.
const CHAT_LIST_TS = '2024-01-01T00:00:00.000Z'
const CHAT_LIST = [
  {
    id: 'chat-1',
    title: 'First chat',
    agentRef: 'alpha',
    createdAt: CHAT_LIST_TS,
    updatedAt: CHAT_LIST_TS,
    messageCount: 0,
  },
  {
    id: 'chat-2',
    title: 'Second chat',
    agentRef: 'alpha',
    createdAt: CHAT_LIST_TS,
    updatedAt: CHAT_LIST_TS,
    messageCount: 0,
  },
]

describe('App chat drawer — reopen preserves the last-viewed chat', () => {
  let currentController: AppController

  beforeEach(() => {
    vi.clearAllMocks()
    sidebarHarness.props = null
    sandboxUiPageHarness.props = null
    appHeaderHarness.props = null
    appHeaderHarness.openNotification = null
    currentController = makeController()
    vi.mocked(useAppController).mockImplementation(() => useReactiveController(currentController))
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        shortcuts: { onCommand: vi.fn(() => vi.fn()) },
        app: { rendererReady: vi.fn().mockResolvedValue(undefined) },
        sandboxUi: {
          listApps: vi.fn().mockResolvedValue({ apps: [] }),
          listPendingDeepLinks: vi.fn().mockResolvedValue({ links: [] }),
          clearPendingDeepLinks: vi.fn().mockResolvedValue(undefined),
          onDeepLink: vi.fn(() => vi.fn()),
          setVisible: vi.fn().mockResolvedValue(undefined),
          setBounds: vi.fn().mockResolvedValue(undefined),
          focusActive: vi.fn().mockResolvedValue(true),
          close: vi.fn().mockResolvedValue(undefined),
        },
      } as unknown as Window['clerum'],
    })
  })

  afterEach(() => {
    cleanup()
    delete (window as { clerum?: unknown }).clerum
  })

  it('reopening the drawer keeps the switched-to chat instead of re-seeding the origin', () => {
    currentController = makeController({
      selectedAgent: 'alpha',
      activeChatId: 'chat-1',
      navItem: DESKTOP_ROUTES.chat,
      chatList: CHAT_LIST,
    } as Partial<AppController>)
    const { rerender } = render(<App />)

    // Open a second real tab (chat-2), then return to chat-1 — mirrors a user
    // who has both conversations open and is viewing chat-1 when they launch.
    act(() => {
      currentController.activeChatId = 'chat-2'
      rerender(<App />)
    })
    act(() => {
      currentController.activeChatId = 'chat-1'
      rerender(<App />)
    })

    // Launch the app from chat-1: seeds + opens the drawer with chat-1 active.
    act(() => {
      sidebarHarness.props?.onOpenSandboxUiApp?.({
        appRef: 'ns/app',
        label: 'App',
        defaultPath: '/',
      })
    })
    expect(appHeaderHarness.props?.chatDrawerOpen).toBe(true)
    expect(screen.getByRole('button', { name: 'Open chats' }).textContent).toContain('First chat')

    // Switch to chat-2 in the drawer switcher.
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Open chats' })))
    act(() => fireEvent.click(screen.getByRole('option', { name: 'Second chat' })))
    expect(screen.getByRole('button', { name: 'Open chats' }).textContent).toContain('Second chat')

    // Close the drawer, then reopen it.
    act(() => appHeaderHarness.props?.onToggleChatDrawer?.())
    expect(appHeaderHarness.props?.chatDrawerOpen).toBe(false)
    act(() => appHeaderHarness.props?.onToggleChatDrawer?.())
    expect(appHeaderHarness.props?.chatDrawerOpen).toBe(true)

    // Reopen must preserve chat-2, not jump back to the chat-1 origin.
    expect(screen.getByRole('button', { name: 'Open chats' }).textContent).toContain('Second chat')
  })

  // The header's "Open chat in full screen" CTA must EJECT the drawer's ACTIVE
  // conversation — the one the user switched to inside the drawer, not the launch
  // origin — to the full-screen chat route. That is the non-drawer branch of
  // revealChatViewTab (leaveSandboxForChat + a selection WITHOUT keepNavItem),
  // not the in-drawer swap. Launch from chat-1 but switch to chat-2 first, so the
  // origin and the active chat differ: only then does asserting the eject carries
  // chat-2 prove that the switched-to conversation survives the expansion (with
  // both equal, an eject that hard-coded the origin would pass just the same).
  it('ejects the switched-to drawer conversation (chat-2) to the full-screen chat route on "Open chat in full screen"', () => {
    currentController = makeController({
      selectedAgent: 'alpha',
      activeChatId: 'chat-1',
      navItem: DESKTOP_ROUTES.chat,
      chatList: CHAT_LIST,
    } as Partial<AppController>)
    const { rerender } = render(<App />)

    // Open both conversations as real tabs (chat-2, then back to chat-1) so the
    // drawer switcher lists both — the user has chat-2 open and is viewing chat-1
    // when they launch.
    act(() => {
      currentController.activeChatId = 'chat-2'
      rerender(<App />)
    })
    act(() => {
      currentController.activeChatId = 'chat-1'
      rerender(<App />)
    })

    // Launch from chat-1: the drawer opens over the live embed on the apps route.
    act(() => {
      sidebarHarness.props?.onOpenSandboxUiApp?.({
        appRef: 'ns/app',
        label: 'App',
        defaultPath: '/',
      })
    })
    expect(appHeaderHarness.props?.chatDrawerOpen).toBe(true)
    expect(currentController.navItem).toBe(DESKTOP_ROUTES.apps)
    expect(screen.getByRole('button', { name: 'Collapse chat drawer' })).toBeTruthy()

    // Switch to chat-2 in the drawer switcher — the conversation that must survive
    // the expansion. Prove it landed through the real switcher AND the rendered
    // ChatPage surface (its active-chat id), not the controller mock.
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Open chats' })))
    act(() => fireEvent.click(screen.getByRole('option', { name: 'Second chat' })))
    expect(screen.getByRole('button', { name: 'Open chats' }).textContent).toContain('Second chat')
    const drawerSurface = screen.getByTestId('chat-page-surface')
    expect(drawerSurface.getAttribute('data-active-chat-id')).toBe('chat-2')
    const focusBeforeExpand = Number(drawerSurface.getAttribute('data-composer-focus-request-id'))

    // Ignore the selections the switch itself performed; assert only on the CTA.
    vi.mocked(currentController.handleSelectChatAgent).mockClear()

    act(() => fireEvent.click(screen.getByRole('button', { name: 'Open chat in full screen' })))

    // Ejected to the full-screen chat route, carrying chat-2 (the switched-to
    // conversation), NOT the chat-1 launch origin. Assert the RENDERED full-screen
    // conversation surface and the composer-focus pulse the CTA fires — the two
    // things the expansion is supposed to hand off.
    expect(currentController.navItem).toBe(DESKTOP_ROUTES.chat)
    const fullScreenSurface = screen.getByTestId('chat-page-surface')
    expect(fullScreenSurface.getAttribute('data-active-chat-id')).toBe('chat-2')
    expect(
      Number(fullScreenSurface.getAttribute('data-composer-focus-request-id'))
    ).toBeGreaterThan(focusBeforeExpand)
    // The eject uses the non-drawer branch: the mock only flips navItem when the
    // selection omits keepNavItem, so this pins the eject path (not the in-drawer
    // swap) and confirms the selection targets chat-2.
    expect(currentController.handleSelectChatAgent).toHaveBeenLastCalledWith(
      'alpha',
      expect.objectContaining({ chatId: 'chat-2' })
    )
    expect(
      vi.mocked(currentController.handleSelectChatAgent).mock.calls.at(-1)?.[1]?.keepNavItem
    ).not.toBe(true)
    // The drawer unmounts once the embed is torn down: its collapse CTA is gone.
    expect(screen.queryByRole('button', { name: 'Collapse chat drawer' })).toBeNull()
  })

  // The drawer's not-ready subtree is `inert`, and a `focus()` fired inside an
  // inert subtree is a silent no-op. So the `chat.switcher` shortcut (which opens
  // the drawer, then opens+focuses the switcher) must defer the open until the
  // embed acks its bounds and the drawer is READY — bumping on visibility alone
  // would open the option list while still inert, leaving it unfocused. This pins
  // that ordering at the observable level: options appear only after ready.
  it('defers the chat.switcher open until the drawer is ready, not merely visible', () => {
    currentController = makeController({
      selectedAgent: 'alpha',
      activeChatId: 'chat-1',
      navItem: DESKTOP_ROUTES.chat,
      chatList: CHAT_LIST,
    } as Partial<AppController>)
    let commandCb: ((commandId: string, source: string) => void) | null = null
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        shortcuts: {
          onCommand: vi.fn((cb: (commandId: string, source: string) => void) => {
            commandCb = cb
            return vi.fn()
          }),
        },
        app: { rendererReady: vi.fn().mockResolvedValue(undefined) },
        sandboxUi: {
          listApps: vi.fn().mockResolvedValue({ apps: [] }),
          listPendingDeepLinks: vi.fn().mockResolvedValue({ links: [] }),
          clearPendingDeepLinks: vi.fn().mockResolvedValue(undefined),
          onDeepLink: vi.fn(() => vi.fn()),
          setVisible: vi.fn().mockResolvedValue(undefined),
          setBounds: vi.fn().mockResolvedValue(undefined),
          focusActive: vi.fn().mockResolvedValue(true),
          close: vi.fn().mockResolvedValue(undefined),
        },
      } as unknown as Window['clerum'],
    })

    render(<App />)

    // Launch the app and mark the embed mounted so `chat.switcher` (eligibility
    // `app-mounted`) is dispatchable, then manually close the drawer so the
    // shortcut takes the "open the drawer first, defer focus" branch.
    act(() => {
      sidebarHarness.props?.onOpenSandboxUiApp?.({
        appRef: 'ns/app',
        label: 'App',
        defaultPath: '/',
      })
    })
    act(() => sandboxUiPageHarness.props?.onEmbeddedAppMounted?.())
    act(() => appHeaderHarness.props?.onToggleChatDrawer?.())
    expect(appHeaderHarness.props?.chatDrawerOpen).toBe(false)

    // Fire the shortcut: the drawer reopens but has NOT acked its bounds, so its
    // subtree is inert. The switcher must stay CLOSED — no options rendered yet.
    act(() => commandCb?.('chat.switcher', 'shortcut-host'))
    expect(appHeaderHarness.props?.chatDrawerOpen).toBe(true)
    expect(screen.queryByRole('option')).toBeNull()

    // Embed acks its bounds → drawer becomes ready (inert lifted) → the deferred
    // request fires and the switcher opens, now focusable.
    act(() => sandboxUiPageHarness.props?.onEmbedBoundsApplied?.())
    expect(screen.queryAllByRole('option').length).toBeGreaterThan(0)
  })

  // `composer.focus` (Mod+Shift+L) must reach the loaded composer shown IN the
  // drawer, not only the full-screen chat route. The command's reveal is already
  // drawer-aware (revealChatViewTab with keepNavItem); the eligibility gate was
  // the only thing pinning it to `navItem === chat`. With the app live and the
  // drawer showing a loaded chat, the command must run through in-drawer chat
  // selection instead of being dropped as ineligible.
  it('runs composer.focus against the loaded chat shown in the drawer', () => {
    currentController = makeController({
      selectedAgent: 'alpha',
      activeChatId: 'chat-1',
      navItem: DESKTOP_ROUTES.chat,
      chatList: CHAT_LIST,
    } as Partial<AppController>)
    let commandCb: ((commandId: string, source: string) => void) | null = null
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        shortcuts: {
          onCommand: vi.fn((cb: (commandId: string, source: string) => void) => {
            commandCb = cb
            return vi.fn()
          }),
        },
        app: { rendererReady: vi.fn().mockResolvedValue(undefined) },
        sandboxUi: {
          listApps: vi.fn().mockResolvedValue({ apps: [] }),
          listPendingDeepLinks: vi.fn().mockResolvedValue({ links: [] }),
          clearPendingDeepLinks: vi.fn().mockResolvedValue(undefined),
          onDeepLink: vi.fn(() => vi.fn()),
          setVisible: vi.fn().mockResolvedValue(undefined),
          setBounds: vi.fn().mockResolvedValue(undefined),
          focusActive: vi.fn().mockResolvedValue(true),
          close: vi.fn().mockResolvedValue(undefined),
        },
      } as unknown as Window['clerum'],
    })

    render(<App />)

    // Launch from chat-1: drawer opens over the live embed with chat-1 active.
    act(() => {
      sidebarHarness.props?.onOpenSandboxUiApp?.({
        appRef: 'ns/app',
        label: 'App',
        defaultPath: '/',
      })
    })
    expect(appHeaderHarness.props?.chatDrawerOpen).toBe(true)
    expect(currentController.navItem).toBe(DESKTOP_ROUTES.apps)

    // Ignore any selection the launch itself performed; assert only on the command.
    vi.mocked(currentController.handleSelectChatAgent).mockClear()

    act(() => commandCb?.('composer.focus', 'shortcut-host'))

    // Observable: the command was eligible in the drawer and reached in-drawer
    // chat selection (keepNavItem — it must not eject to the full-screen route).
    expect(currentController.handleSelectChatAgent).toHaveBeenLastCalledWith(
      'alpha',
      expect.objectContaining({ keepNavItem: true })
    )
    expect(currentController.navItem).toBe(DESKTOP_ROUTES.apps)
  })

  it('reverts the notification tray to overlay form while the chat drawer is visible', () => {
    currentController = makeController({
      selectedAgent: 'alpha',
      activeChatId: 'chat-1',
      navItem: DESKTOP_ROUTES.chat,
      chatList: CHAT_LIST,
    } as Partial<AppController>)
    render(<App />)

    // Launch from chat-1: the chat drawer becomes visible over the live embed.
    act(() => {
      sidebarHarness.props?.onOpenSandboxUiApp?.({
        appRef: 'ns/app',
        label: 'App',
        defaultPath: '/',
      })
    })
    expect(appHeaderHarness.props?.chatDrawerOpen).toBe(true)
    // Both drawers share the same fixed right-rail rect, so the notification tray
    // must NOT use its drawer form while the chat drawer is up — it reverts to the
    // overlay/popover form (handled by the existing shell-overlay freeze).
    expect(appHeaderHarness.props?.notificationTrayMode).toBe('overlay')

    // Closing the chat drawer (app still mounted) restores the tray's drawer form.
    act(() => appHeaderHarness.props?.onToggleChatDrawer?.())
    expect(appHeaderHarness.props?.chatDrawerOpen).toBe(false)
    expect(appHeaderHarness.props?.notificationTrayMode).toBe('drawer')
  })

  it('passes the measured embed edge to the notification drawer while chat is closed', () => {
    currentController = makeController({ navItem: DESKTOP_ROUTES.apps } as Partial<AppController>)
    render(<App />)

    act(() => {
      sidebarHarness.props?.onOpenSandboxUiApp?.({
        appRef: 'ns/app',
        label: 'App',
        defaultPath: '/',
      })
      sandboxUiPageHarness.props?.onEmbedSlotRightChange?.(716)
    })

    expect(appHeaderHarness.props?.notificationTrayMode).toBe('drawer')
    expect(appHeaderHarness.props?.notificationTrayLeft).toBe(716)
  })

  it('keeps the notification rail boundary through a same-edge app reopen', () => {
    currentController = makeController({ navItem: DESKTOP_ROUTES.apps } as Partial<AppController>)
    render(<App />)

    act(() => {
      sidebarHarness.props?.onOpenSandboxUiApp?.({
        appRef: 'ns/app-a',
        label: 'App A',
        defaultPath: '/',
      })
      sandboxUiPageHarness.props?.onEmbedSlotRightChange?.(716)
    })
    expect(appHeaderHarness.props?.notificationTrayLeft).toBe(716)

    act(() => sandboxUiPageHarness.props?.onEmbeddedAppBack?.())
    expect(appHeaderHarness.props?.notificationTrayMode).toBe('overlay')
    expect(appHeaderHarness.props?.notificationTrayLeft).toBeNull()

    act(() => {
      sidebarHarness.props?.onOpenSandboxUiApp?.({
        appRef: 'ns/app-b',
        label: 'App B',
        defaultPath: '/',
      })
    })

    // The real SandboxUiPage producer dedupes its unchanged 716px slot edge
    // until its next lifecycle. The titlebar must retain the existing boundary
    // while the refreshed embedded app reaches readiness.
    expect(appHeaderHarness.props?.notificationTrayMode).toBe('drawer')
    expect(appHeaderHarness.props?.notificationTrayLeft).toBe(716)

    act(() => sandboxUiPageHarness.props?.onEmbedSlotRightChange?.(744))
    expect(appHeaderHarness.props?.notificationTrayLeft).toBe(744)
  })

  // #2 — reconciler covers the drawer (minispec 04 approach A). The ChatThread
  // session list moves `vm.activeChatId` via switchToChat WITHOUT touching
  // chatViewTabs. Simulate that (mutate activeChatId as the vm would) and assert
  // the drawer switcher re-derives to the displayed chat.
  it('syncs the drawer switcher when the displayed chat changes outside the tab path', () => {
    currentController = makeController({
      selectedAgent: 'alpha',
      activeChatId: 'chat-1',
      navItem: DESKTOP_ROUTES.chat,
      chatList: CHAT_LIST,
    } as Partial<AppController>)
    const { rerender } = render(<App />)

    // Launch from chat-1 → drawer opens on chat-1.
    act(() => {
      sidebarHarness.props?.onOpenSandboxUiApp?.({
        appRef: 'ns/app',
        label: 'App',
        defaultPath: '/',
      })
    })
    expect(appHeaderHarness.props?.chatDrawerOpen).toBe(true)
    expect(screen.getByRole('button', { name: 'Open chats' }).textContent).toContain('First chat')

    // The ChatThread session list picks chat-2: switchToChat moves activeChatId
    // only — no tab-state call. The reconciler must re-derive the switcher.
    act(() => {
      currentController.activeChatId = 'chat-2'
      rerender(<App />)
    })

    expect(currentController.navItem).toBe(DESKTOP_ROUTES.apps)
    expect(screen.getByRole('button', { name: 'Open chats' }).textContent).toContain('Second chat')
  })

  // #3 — open-conversation gesture is drawer-aware (minispec 04 approach C). An
  // approval on a background chat, opened from the tray, must surface in the
  // drawer (navItem stays apps) instead of ejecting to the full-screen route.
  it('surfaces an open-conversation gesture in the drawer instead of ejecting', async () => {
    currentController = makeController({
      selectedAgent: 'alpha',
      activeChatId: 'chat-1',
      navItem: DESKTOP_ROUTES.chat,
      chatList: CHAT_LIST,
    } as Partial<AppController>)
    const { rerender } = render(<App />)

    // Launch from chat-1 → drawer open, app live, navItem apps.
    act(() => {
      sidebarHarness.props?.onOpenSandboxUiApp?.({
        appRef: 'ns/app',
        label: 'App',
        defaultPath: '/',
      })
    })
    expect(appHeaderHarness.props?.chatDrawerOpen).toBe(true)
    expect(currentController.navItem).toBe(DESKTOP_ROUTES.apps)

    // Open the conversation the approval is on (chat-2, a background chat) via the
    // notification tray's gesture.
    await act(async () => {
      await appHeaderHarness.openNotification?.({
        id: 'n1',
        kind: 'approval_required',
        agentName: 'alpha',
        chatId: 'chat-2',
      } as unknown as Parameters<NonNullable<typeof appHeaderHarness.openNotification>>[0])
    })
    act(() => rerender(<App />))

    // Observable: the drawer now shows the approval's chat AND we did not eject
    // to the full-screen chat route.
    expect(currentController.navItem).toBe(DESKTOP_ROUTES.apps)
    expect(appHeaderHarness.props?.chatDrawerOpen).toBe(true)
    expect(currentController.activeChatId).toBe('chat-2')
    expect(currentController.handleOpenNotification).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'chat-2' }),
      { keepNavItem: true }
    )
    expect(screen.getByRole('button', { name: 'Open chats' }).textContent).toContain('Second chat')
  })

  // #3b — cross-team gesture must EJECT to full-screen, not surface in the drawer.
  // `handleOpenNotificationInDrawer` only surfaces in-drawer when the notification's
  // team matches the current one; a cross-team conversation tears the embed down on
  // the team switch, so opening the drawer would flash it and leave chatDrawerOpen
  // stuck. With teamId 'team-b' (the harness getCurrentTeamId is 'team-a') the wrap
  // must fall back to the plain handleOpenNotification WITHOUT keepNavItem.
  it('ejects a cross-team open-conversation gesture instead of surfacing it in the drawer', async () => {
    currentController = makeController({
      selectedAgent: 'alpha',
      activeChatId: null,
      navItem: DESKTOP_ROUTES.chat,
      chatList: CHAT_LIST,
    } as Partial<AppController>)
    const { rerender } = render(<App />)

    // Launch from the picker (no origin) → app live, apps route, drawer CLOSED.
    act(() => {
      sidebarHarness.props?.onOpenSandboxUiApp?.({
        appRef: 'ns/app',
        label: 'App',
        defaultPath: '/',
      })
    })
    expect(currentController.navItem).toBe(DESKTOP_ROUTES.apps)
    expect(appHeaderHarness.props?.chatDrawerOpen).toBe(false)

    // The approval is on a chat in a DIFFERENT team (team-b vs the harness team-a).
    await act(async () => {
      await appHeaderHarness.openNotification?.({
        id: 'n2',
        kind: 'approval_required',
        agentName: 'alpha',
        chatId: 'chat-2',
        teamId: 'team-b',
      } as unknown as Parameters<NonNullable<typeof appHeaderHarness.openNotification>>[0])
    })
    act(() => rerender(<App />))

    // The drawer never opened, and the gesture ran through the plain path WITHOUT
    // keepNavItem — the eject the full-screen route needs so a team switch survives.
    expect(appHeaderHarness.props?.chatDrawerOpen).toBe(false)
    expect(currentController.handleOpenNotification).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'chat-2' }),
      undefined
    )
  })

  // Regression for the C wrap opening the drawer for EVERY notification kind: it
  // must only open for gestures that actually surface in the drawer, not for the
  // kinds handleOpenNotification navigates away for (workflow_completed → plugins,
  // sdk_notification → its target). Otherwise the drawer flashes and chatDrawerOpen
  // gets stuck true.
  it('does not open the drawer for notifications that navigate away (workflow / sdk)', async () => {
    currentController = makeController({
      selectedAgent: 'alpha',
      activeChatId: null,
      navItem: DESKTOP_ROUTES.chat,
      chatList: CHAT_LIST,
    } as Partial<AppController>)
    const { rerender } = render(<App />)

    // Launch from the picker (no origin) → app live, apps route, drawer CLOSED.
    act(() => {
      sidebarHarness.props?.onOpenSandboxUiApp?.({
        appRef: 'ns/app',
        label: 'App',
        defaultPath: '/',
      })
    })
    expect(currentController.navItem).toBe(DESKTOP_ROUTES.apps)
    expect(appHeaderHarness.props?.chatDrawerOpen).toBe(false)

    // sdk_notification navigates to its own target — must NOT open the drawer.
    await act(async () => {
      await appHeaderHarness.openNotification?.({
        id: 's1',
        kind: 'sdk_notification',
      } as unknown as Parameters<NonNullable<typeof appHeaderHarness.openNotification>>[0])
    })
    expect(appHeaderHarness.props?.chatDrawerOpen).toBe(false)

    // workflow_completed navigates to plugins; returning to apps must NOT find a
    // drawer the user never asked for (the "stuck true" symptom).
    await act(async () => {
      await appHeaderHarness.openNotification?.({
        id: 'w1',
        kind: 'workflow_completed',
      } as unknown as Parameters<NonNullable<typeof appHeaderHarness.openNotification>>[0])
    })
    act(() => {
      currentController.navItem = DESKTOP_ROUTES.apps
      rerender(<App />)
    })
    expect(appHeaderHarness.props?.chatDrawerOpen).toBe(false)
  })

  // An agent-conversation notification with an empty agentName has nothing to
  // load — the controller bails on `if (!targetAgent) return`. The in-drawer wrap
  // re-encodes that routing, so it must mirror the same guard; otherwise it opens
  // the drawer and passes keepNavItem for a gesture that loads nothing, leaving the
  // drawer up with a blank composer.
  it('does not open the drawer for a conversation notification with an empty agentName', async () => {
    currentController = makeController({
      selectedAgent: 'alpha',
      activeChatId: null,
      navItem: DESKTOP_ROUTES.chat,
      chatList: CHAT_LIST,
    } as Partial<AppController>)
    const { rerender } = render(<App />)

    // Launch from the picker (no origin) → app live, apps route, drawer CLOSED.
    act(() => {
      sidebarHarness.props?.onOpenSandboxUiApp?.({
        appRef: 'ns/app',
        label: 'App',
        defaultPath: '/',
      })
    })
    expect(currentController.navItem).toBe(DESKTOP_ROUTES.apps)
    expect(appHeaderHarness.props?.chatDrawerOpen).toBe(false)

    // Conversation notification whose agentName is blank → nothing to surface.
    await act(async () => {
      await appHeaderHarness.openNotification?.({
        id: 'n3',
        kind: 'approval_required',
        agentName: '   ',
        chatId: 'chat-2',
      } as unknown as Parameters<NonNullable<typeof appHeaderHarness.openNotification>>[0])
    })
    act(() => rerender(<App />))

    // The drawer never opened, and the gesture ran through the plain path WITHOUT
    // keepNavItem (the controller itself will then no-op on the empty agent).
    expect(appHeaderHarness.props?.chatDrawerOpen).toBe(false)
    expect(currentController.handleOpenNotification).toHaveBeenCalledWith(
      expect.objectContaining({ agentName: '   ' }),
      undefined
    )
  })
})

// Mini-spec 05: below the minimum panel width the drawer is SUPPRESSED (hidden,
// app takes full width) without clearing the user's open intent, so it reappears
// when the window re-widens; a MANUAL close clears the intent, so it stays gone.
// `SandboxUiPage.chatDrawerOpen` mirrors effective visibility (App passes
// `chatDrawerVisible`), and the "Open chats" switcher only mounts while visible —
// both are the observable outputs asserted here. The panel width is driven
// through the real producer path: a stubbed ResizeObserver captures the hook's
// sync callback, and the content-panel's clientWidth is made mutable so firing
// the callback re-measures exactly as a window resize would.
describe('App chat drawer — narrow-width suppression (mini-spec 05)', () => {
  let currentController: AppController
  let panelClientWidth: number
  let fireResize: () => void

  beforeEach(() => {
    vi.clearAllMocks()
    sidebarHarness.props = null
    sandboxUiPageHarness.props = null
    appHeaderHarness.props = null
    appHeaderHarness.openNotification = null
    panelClientWidth = 2000
    fireResize = () => {}
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          fireResize = () => cb()
        }
        observe() {}
        disconnect() {}
      }
    )
    currentController = makeController({
      selectedAgent: 'alpha',
      activeChatId: 'chat-1',
      navItem: DESKTOP_ROUTES.chat,
      chatList: CHAT_LIST,
    } as Partial<AppController>)
    vi.mocked(useAppController).mockImplementation(() => useReactiveController(currentController))
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        shortcuts: { onCommand: vi.fn(() => vi.fn()) },
        app: { rendererReady: vi.fn().mockResolvedValue(undefined) },
        sandboxUi: {
          listApps: vi.fn().mockResolvedValue({ apps: [] }),
          listPendingDeepLinks: vi.fn().mockResolvedValue({ links: [] }),
          clearPendingDeepLinks: vi.fn().mockResolvedValue(undefined),
          onDeepLink: vi.fn(() => vi.fn()),
          setVisible: vi.fn().mockResolvedValue(undefined),
          setBounds: vi.fn().mockResolvedValue(undefined),
          focusActive: vi.fn().mockResolvedValue(true),
          close: vi.fn().mockResolvedValue(undefined),
        },
      } as unknown as Window['clerum'],
    })
  })

  afterEach(() => {
    cleanup()
    delete (window as { clerum?: unknown }).clerum
    vi.unstubAllGlobals()
  })

  // Make the live content-panel report a mutable clientWidth so the ResizeObserver
  // callback measures our test width instead of jsdom's un-laid-out 0.
  function bindPanelWidth() {
    const el = document.querySelector('.content-panel') as HTMLElement | null
    if (el && !Object.getOwnPropertyDescriptor(el, 'clientWidth')) {
      Object.defineProperty(el, 'clientWidth', {
        configurable: true,
        get: () => panelClientWidth,
      })
    }
  }

  function resizeTo(width: number) {
    panelClientWidth = width
    bindPanelWidth()
    act(() => fireResize())
  }

  it('suppresses the drawer below the threshold and restores it on re-widen, but a manual close stays closed', () => {
    render(<App />)

    // Launch from chat-1: the drawer opens over the live embed. The first sync
    // reads a 0 panel (jsdom), which is not "too narrow", so it starts visible.
    act(() => {
      sidebarHarness.props?.onOpenSandboxUiApp?.({
        appRef: 'ns/app',
        label: 'App',
        defaultPath: '/',
      })
    })
    expect(appHeaderHarness.props?.chatDrawerOpen).toBe(true)
    expect(screen.queryByRole('button', { name: 'Open chats' })).not.toBeNull()

    // Narrow the panel below CHAT_DRAWER_MIN_PANEL_WIDTH (846): the drawer is
    // suppressed and the app takes the full width (no gutter class).
    resizeTo(800)
    expect(appHeaderHarness.props?.chatDrawerOpen).toBe(false)
    expect(screen.queryByRole('button', { name: 'Open chats' })).toBeNull()

    // Re-widen above the threshold: the open intent was never cleared, so the
    // drawer reappears on its own.
    resizeTo(1200)
    expect(appHeaderHarness.props?.chatDrawerOpen).toBe(true)
    expect(screen.queryByRole('button', { name: 'Open chats' })).not.toBeNull()

    // Manual close while visible clears the intent.
    act(() => appHeaderHarness.props?.onToggleChatDrawer?.())
    expect(appHeaderHarness.props?.chatDrawerOpen).toBe(false)

    // Widening (or any resize) must NOT bring a manually-closed drawer back.
    resizeTo(2000)
    expect(appHeaderHarness.props?.chatDrawerOpen).toBe(false)
    expect(screen.queryByRole('button', { name: 'Open chats' })).toBeNull()
  })

  // Repro of round-4 #1: below the minimum panel width the drawer is suppressed
  // (correctly — there is no room to dock it beside the embed). A `Mod+T` new-chat
  // gesture must therefore fall back to the full-screen chat route, NOT be diverted
  // into the hidden drawer — which would create a chat no surface can reach. The
  // divert decision keys off `chatDrawerDivertable` (available && !panelTooNarrow),
  // not `chatDrawerAvailable`, so at a narrow width the gesture ejects to chat.
  it('routes a new-chat gesture to full-screen chat when the panel is too narrow to dock the drawer', () => {
    let commandCb: ((commandId: string, source: string) => void) | null = null
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        shortcuts: {
          onCommand: vi.fn((cb: (commandId: string, source: string) => void) => {
            commandCb = cb
            return vi.fn()
          }),
        },
        app: { rendererReady: vi.fn().mockResolvedValue(undefined) },
        sandboxUi: {
          listApps: vi.fn().mockResolvedValue({ apps: [] }),
          listPendingDeepLinks: vi.fn().mockResolvedValue({ links: [] }),
          clearPendingDeepLinks: vi.fn().mockResolvedValue(undefined),
          onDeepLink: vi.fn(() => vi.fn()),
          setVisible: vi.fn().mockResolvedValue(undefined),
          setBounds: vi.fn().mockResolvedValue(undefined),
          focusActive: vi.fn().mockResolvedValue(true),
          close: vi.fn().mockResolvedValue(undefined),
        },
      } as unknown as Window['clerum'],
    })

    render(<App />)

    // Launch the app (drawer available), then narrow the panel below 846 so the
    // drawer is suppressed: app is live, but the drawer is not a divertable surface.
    act(() => {
      sidebarHarness.props?.onOpenSandboxUiApp?.({
        appRef: 'ns/app',
        label: 'App',
        defaultPath: '/',
      })
    })
    resizeTo(800)
    expect(appHeaderHarness.props?.chatDrawerOpen).toBe(false)
    expect(currentController.navItem).toBe(DESKTOP_ROUTES.apps)

    // Mod+T: the new chat must land on the full-screen chat route (reachable),
    // not in the suppressed drawer (orphaned).
    act(() => commandCb?.('chat.newTab', 'shortcut-host'))

    expect(currentController.navItem).toBe(DESKTOP_ROUTES.chat)
  })

  it('publishes the rail top from the measured embed slot on app tabs, falling back until measured', () => {
    render(<App />)

    act(() => {
      sidebarHarness.props?.onOpenSandboxUiApp?.({
        appRef: 'ns/app',
        label: 'App',
        defaultPath: '/',
      })
    })
    expect(appHeaderHarness.props?.chatDrawerOpen).toBe(true)

    const panel = document.querySelector('.content-panel') as HTMLElement
    expect(panel.className).toContain('content-panel--chat-drawer-open')
    // The gutter width var is always present on the panel while docked (§A1).
    expect(panel.style.getPropertyValue('--chat-drawer-width')).not.toBe('')

    // The rail's top now lives on the RightRailShell (--rail-top), not the panel.
    // On an app tab it stays absent until the embed reports a measured top, so the
    // shell's static CSS fallback applies (§A2).
    const rail = document.querySelector('.right-rail-shell') as HTMLElement
    expect(rail).not.toBeNull()
    expect(rail.getAttribute('data-occupant')).toBe('chat-drawer')
    expect(rail.style.getPropertyValue('--rail-top')).toBe('')

    // The embed reports a wrapped-header top through the real callback path.
    act(() => sandboxUiPageHarness.props?.onEmbedSlotTopChange?.(140))
    expect(
      (document.querySelector('.right-rail-shell') as HTMLElement).style.getPropertyValue(
        '--rail-top'
      )
    ).toBe('140px')
  })
})

// Mini-spec 04a — the drawer is universal (available over any non-chat tab), its
// toggle lives in the app header, and it mounts once at the workspace level so it
// survives non-chat tab switches. These drive the real App + real ChatDrawer/
// ChatSwitcher through the mocked controller's store producers.
describe('App chat drawer — universal availability (mini-spec 04a)', () => {
  let currentController: AppController

  beforeEach(() => {
    vi.clearAllMocks()
    sidebarHarness.props = null
    sandboxUiPageHarness.props = null
    appHeaderHarness.props = null
    appHeaderHarness.openNotification = null
    currentController = makeController({
      selectedAgent: 'alpha',
      activeChatId: 'chat-1',
      navItem: DESKTOP_ROUTES.chat,
      chatList: CHAT_LIST,
    } as Partial<AppController>)
    vi.mocked(useAppController).mockImplementation(() => useReactiveController(currentController))
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        shortcuts: { onCommand: vi.fn(() => vi.fn()) },
        app: { rendererReady: vi.fn().mockResolvedValue(undefined) },
        sandboxUi: {
          listApps: vi.fn().mockResolvedValue({ apps: [] }),
          listPendingDeepLinks: vi.fn().mockResolvedValue({ links: [] }),
          clearPendingDeepLinks: vi.fn().mockResolvedValue(undefined),
          onDeepLink: vi.fn(() => vi.fn()),
          setVisible: vi.fn().mockResolvedValue(undefined),
          setBounds: vi.fn().mockResolvedValue(undefined),
          focusActive: vi.fn().mockResolvedValue(true),
          close: vi.fn().mockResolvedValue(undefined),
        },
      } as unknown as Window['clerum'],
    })
  })

  afterEach(() => {
    cleanup()
    delete (window as { clerum?: unknown }).clerum
  })

  // R2: available on app/files/settings, never on chat.
  it('makes the drawer available on non-chat tabs and hides it on chat tabs (R2)', () => {
    render(<App />)
    expect(appHeaderHarness.props?.drawerAvailable).toBe(false) // chat tab

    act(() => currentController.handleNavSelect(DESKTOP_ROUTES.files))
    expect(appHeaderHarness.props?.drawerAvailable).toBe(true)

    act(() => currentController.handleNavSelect(DESKTOP_ROUTES.settings))
    expect(appHeaderHarness.props?.drawerAvailable).toBe(true)

    act(() =>
      sidebarHarness.props?.onOpenSandboxUiApp?.({
        appRef: 'ns/app',
        label: 'App',
        defaultPath: '/',
      })
    )
    expect(appHeaderHarness.props?.drawerAvailable).toBe(true)

    act(() => currentController.handleNavSelect(DESKTOP_ROUTES.chat))
    expect(appHeaderHarness.props?.drawerAvailable).toBe(false)
  })

  // §A2 T3: on a DOM tab (no embed) the drawer is ready — interactive, not inert —
  // the moment it opens, in the same frame. Fails on the committed 2b, where the
  // drawer is not even available over a DOM tab.
  it('makes the drawer interactive immediately on a DOM tab, never inert (§A2)', () => {
    currentController = makeController({
      selectedAgent: 'alpha',
      activeChatId: 'chat-1',
      navItem: DESKTOP_ROUTES.files,
      chatList: CHAT_LIST,
    } as Partial<AppController>)
    const { container } = render(<App />)
    expect(appHeaderHarness.props?.drawerAvailable).toBe(true)

    act(() => appHeaderHarness.props?.onToggleChatDrawer?.())

    const drawer = container.querySelector('.chat-drawer') as HTMLElement | null
    expect(drawer).not.toBeNull()
    // No native view to ack a shrunk-bounds gate → ready immediately, not inert.
    expect(drawer!.getAttribute('data-ready')).toBe('true')
    expect(drawer!.hasAttribute('inert')).toBe(false)
  })

  // R5 + DEC-2: the drawer is global; switching between non-chat kinds keeps it
  // open and never lets the chat reconcile steal focus onto a chat tab.
  it('keeps the drawer intact across non-chat tab switches without stealing focus (R5/DEC-2)', () => {
    render(<App />)
    act(() => currentController.handleNavSelect(DESKTOP_ROUTES.files))
    act(() => appHeaderHarness.props?.onToggleChatDrawer?.())
    expect(appHeaderHarness.props?.chatDrawerOpen).toBe(true)
    expect(document.querySelector('.chat-drawer')).not.toBeNull()

    // Switch to a settings tab: drawer stays open AND the reconcile (which runs
    // while the drawer is visible with a chat active) keeps the settings tab
    // active — it does not re-home focus to a chat tab.
    act(() => currentController.handleNavSelect(DESKTOP_ROUTES.settings))
    expect(currentController.navItem).toBe(DESKTOP_ROUTES.settings)
    expect(appHeaderHarness.props?.chatDrawerOpen).toBe(true)
    expect(document.querySelector('.chat-drawer')).not.toBeNull()

    // Back to files: still open, still not stolen to chat.
    act(() => currentController.handleNavSelect(DESKTOP_ROUTES.files))
    expect(currentController.navItem).toBe(DESKTOP_ROUTES.files)
    expect(appHeaderHarness.props?.chatDrawerOpen).toBe(true)
  })

  // R4: selecting a chat tab with the drawer open collapses the drawer before the
  // chat shows, and clears the open intent so returning to a non-chat tab does not
  // silently re-open it.
  it('collapses the drawer before the chat and clears the intent when a chat tab is selected (R4)', () => {
    render(<App />)
    act(() =>
      sidebarHarness.props?.onOpenSandboxUiApp?.({
        appRef: 'ns/app',
        label: 'App',
        defaultPath: '/',
      })
    )
    expect(appHeaderHarness.props?.chatDrawerOpen).toBe(true)
    expect(document.querySelector('.chat-drawer')).not.toBeNull()

    // Select the chat tab from the strip (full-screen chat).
    act(() => fireEvent.click(screen.getByRole('button', { name: 'First chat' })))
    expect(currentController.navItem).toBe(DESKTOP_ROUTES.chat)
    expect(document.querySelector('.chat-drawer')).toBeNull()
    expect(appHeaderHarness.props?.chatDrawerOpen).toBe(false)
    expect(appHeaderHarness.props?.drawerAvailable).toBe(false)

    // Return to the app tab: the drawer stays closed (intent cleared by R4). Were
    // the intent left set, `drawerAvailable && chatDrawerOpen` would re-open it.
    act(() => fireEvent.click(screen.getByRole('button', { name: 'App' })))
    expect(currentController.navItem).toBe(DESKTOP_ROUTES.apps)
    expect(appHeaderHarness.props?.drawerAvailable).toBe(true)
    expect(appHeaderHarness.props?.chatDrawerOpen).toBe(false)
    expect(document.querySelector('.chat-drawer')).toBeNull()
  })

  // Right-rail single-occupancy (E): while the chat drawer holds the rail the
  // notification tray is forced to its overlay/popover form (never the app-drawer
  // form), so opening the tray can't close the drawer. Collapsing the drawer frees
  // the rail and the tray reclaims its drawer form — the tray behavior is intact.
  it('keeps the notification tray out of the rail while the chat drawer occupies it', () => {
    render(<App />)
    act(() =>
      sidebarHarness.props?.onOpenSandboxUiApp?.({
        appRef: 'ns/app',
        label: 'App',
        defaultPath: '/',
      })
    )
    expect(appHeaderHarness.props?.chatDrawerOpen).toBe(true)
    expect(appHeaderHarness.props?.notificationTrayMode).toBe('overlay')
    expect(document.querySelector('.chat-drawer')).not.toBeNull()

    act(() => appHeaderHarness.props?.onToggleChatDrawer?.())
    expect(appHeaderHarness.props?.chatDrawerOpen).toBe(false)
    expect(appHeaderHarness.props?.notificationTrayMode).toBe('drawer')
  })
})
