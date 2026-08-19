// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
}))

vi.mock('@hooks/useAppController', () => ({ useAppController: vi.fn() }))
vi.mock('@hooks/useAgentChatActionsValue', () => ({ useAgentChatActionsValue: () => ({}) }))
vi.mock('@components/AppHeader', () => ({
  AppHeader: (props: NonNullable<typeof appHeaderHarness.props>) => {
    appHeaderHarness.props = props
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
    handleSelectChatAgent: vi.fn(),
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
})
