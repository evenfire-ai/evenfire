// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useNotificationsContext } from '@contexts/NotificationsContext'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DESKTOP_ROUTES } from '@constants/navigation'
import { useAppController } from '@hooks/useAppController'
import { App } from '@/App'

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
    chatDrawerOpen?: boolean
    onToggleChatDrawer?: () => void
    onEmbeddedAppMounted?: () => void
  },
}))
const appHeaderHarness = vi.hoisted(() => ({
  props: null as null | { notificationTrayMode?: 'drawer' | 'overlay' },
  // Captured from context so tests can drive the "open conversation" gesture the
  // notification tray fires.
  openNotification: null as null | ((notification: unknown) => Promise<void>),
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
vi.mock('@pages/ChatPage', () => ({ ChatPage: () => null }))
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
  const handleNavSelect = vi.fn((item: AppController['navItem']) => {
    controller.navItem = item
  })
  // Faithful to the real vm: selecting an agent/chat moves the primary
  // `vm.activeChatId`/`selectedAgent` (the reconciler derives the tab from them).
  const handleSelectChatAgent = vi.fn(
    (agentName: string, options: { chatId?: string; keepNavItem?: boolean } = {}) => {
      controller.selectedAgent = agentName
      controller.activeChatId = options.chatId ?? null
      if (!options.keepNavItem) controller.navItem = DESKTOP_ROUTES.chat
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
      // Faithful routing: workflow/sdk notifications navigate away (not to the
      // chat/apps surface) — model them as leaving the agent chat state untouched.
      if (notification.kind === 'workflow_completed') {
        controller.navItem = DESKTOP_ROUTES.plugins
        return Promise.resolve()
      }
      if (notification.kind === 'sdk_notification') return Promise.resolve()
      controller.selectedAgent = notification.agentName ?? controller.selectedAgent
      controller.activeChatId = notification.chatId ?? null
      if (!options.keepNavItem) controller.navItem = DESKTOP_ROUTES.chat
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
  return controller
}

const CHAT_LIST = [
  { id: 'chat-1', title: 'First chat', agentRef: 'alpha' },
  { id: 'chat-2', title: 'Second chat', agentRef: 'alpha' },
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
    vi.mocked(useAppController).mockImplementation(() => currentController)
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
    expect(sandboxUiPageHarness.props?.chatDrawerOpen).toBe(true)
    expect(screen.getByRole('button', { name: 'Open chats' }).textContent).toContain('First chat')

    // Switch to chat-2 in the drawer switcher.
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Open chats' })))
    act(() => fireEvent.click(screen.getByRole('option', { name: 'Second chat' })))
    expect(screen.getByRole('button', { name: 'Open chats' }).textContent).toContain('Second chat')

    // Close the drawer, then reopen it.
    act(() => sandboxUiPageHarness.props?.onToggleChatDrawer?.())
    expect(sandboxUiPageHarness.props?.chatDrawerOpen).toBe(false)
    act(() => sandboxUiPageHarness.props?.onToggleChatDrawer?.())
    expect(sandboxUiPageHarness.props?.chatDrawerOpen).toBe(true)

    // Reopen must preserve chat-2, not jump back to the chat-1 origin.
    expect(screen.getByRole('button', { name: 'Open chats' }).textContent).toContain('Second chat')
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
    expect(sandboxUiPageHarness.props?.chatDrawerOpen).toBe(true)
    // Both drawers share the same fixed right-rail rect, so the notification tray
    // must NOT use its drawer form while the chat drawer is up — it reverts to the
    // overlay/popover form (handled by the existing shell-overlay freeze).
    expect(appHeaderHarness.props?.notificationTrayMode).toBe('overlay')

    // Closing the chat drawer (app still mounted) restores the tray's drawer form.
    act(() => sandboxUiPageHarness.props?.onToggleChatDrawer?.())
    expect(sandboxUiPageHarness.props?.chatDrawerOpen).toBe(false)
    expect(appHeaderHarness.props?.notificationTrayMode).toBe('drawer')
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
    expect(sandboxUiPageHarness.props?.chatDrawerOpen).toBe(true)
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
    expect(sandboxUiPageHarness.props?.chatDrawerOpen).toBe(true)
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
    expect(sandboxUiPageHarness.props?.chatDrawerOpen).toBe(true)
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
    expect(sandboxUiPageHarness.props?.chatDrawerOpen).toBe(false)

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
    expect(sandboxUiPageHarness.props?.chatDrawerOpen).toBe(false)
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
    expect(sandboxUiPageHarness.props?.chatDrawerOpen).toBe(false)

    // sdk_notification navigates to its own target — must NOT open the drawer.
    await act(async () => {
      await appHeaderHarness.openNotification?.({
        id: 's1',
        kind: 'sdk_notification',
      } as unknown as Parameters<NonNullable<typeof appHeaderHarness.openNotification>>[0])
    })
    expect(sandboxUiPageHarness.props?.chatDrawerOpen).toBe(false)

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
    expect(sandboxUiPageHarness.props?.chatDrawerOpen).toBe(false)
  })
})
