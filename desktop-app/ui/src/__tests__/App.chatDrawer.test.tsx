// @vitest-environment jsdom
import { useReducer } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentTaskTrackerProvider } from '@contexts/AgentTaskTrackerContext'
import { useNotificationsContext } from '@contexts/NotificationsContext'
import { QueryClientProvider, useInfiniteQuery, useQueries, useQuery } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DESKTOP_ROUTES } from '@constants/navigation'
import { installAppControllerClerum } from '@hooks/domain/__tests__/__fixtures__/appControllerHarness'
import { deferred as makeDeferred } from '@hooks/domain/__tests__/__fixtures__/catalogFixtures'
import { ipcGenericForbidden } from '@hooks/domain/__tests__/__fixtures__/ipcErrors'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import { useAppController } from '@hooks/useAppController'
import type { GfsPreviewResource } from '@lib/gfsPreview'
import { desktopQueryClient } from '@lib/queryClient'
import {
  activeWorkspaceTab,
  createEmptyWorkspaceTabsState,
  createWorkspaceTabsState,
  newChatTab,
  openChatTab,
  openFilesTab,
  openPreviewTab,
  openSettingsTab,
  selectWorkspaceTab,
} from '@lib/workspaceTabs'
import { mapKindToRoute, settingsSectionForRoute } from '@lib/workspaceTabsRoute'
import { App } from '@/App'
import { USER_SCOPE_INVALIDATED } from '@/gfs/__fixtures__/entityChangeFixtures'
import {
  openGfsResourcePayload,
  resolveDeniedMessage,
  resolvedFile,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
import type { AppNotification, NavItem } from '@/uiTypes'
import { ChatStore } from '../../../src/chatStore'

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
    onSelect?: (item: NavItem) => void
  },
}))
const sandboxUiPageHarness = vi.hoisted(() => ({
  props: null as null | {
    onEmbeddedAppMounted?: () => void
    onEmbeddedAppBack?: () => void
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
  notifications: [] as AppNotification[],
  unreadNotificationCount: 0,
}))
const navigationHarness = vi.hoisted(() => ({
  selectChatAgent: null as null | ((agentRef: string, options?: { chatId?: string }) => void),
}))

vi.mock('@hooks/useAppController', () => ({ useAppController: vi.fn() }))
vi.mock('@hooks/useAgentChatActionsValue', () => ({ useAgentChatActionsValue: () => ({}) }))
vi.mock('@components/AppHeader', () => ({
  AppHeader: (props: NonNullable<typeof appHeaderHarness.props>) => {
    appHeaderHarness.props = props
    const notificationsContext = useNotificationsContext()
    appHeaderHarness.openNotification = notificationsContext.handleOpenNotification
    appHeaderHarness.notifications = notificationsContext.notifications
    appHeaderHarness.unreadNotificationCount = notificationsContext.unreadNotificationCount
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
  const { useNavigationContext } = await import('@contexts/NavigationContext')
  return {
    ChatPage: () => {
      const { activeChatId, composerFocusRequestId } = useChatComposerStateContext()
      navigationHarness.selectChatAgent = useNavigationContext().handleSelectChatAgent
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
vi.mock('@pages/FilePreviewPage', () => ({ FilePreviewPage: () => null }))
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
  let navigationIntent = 0
  const beginNavigationIntent = vi.fn(() => ++navigationIntent)
  const isNavigationIntentCurrent = vi.fn((intent: number) => navigationIntent === intent)
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
  // Faithful to the real controller's openFilesSection: open/focus a files tab at
  // `path` through the real store producer (dedupe by path lives in the store).
  const openFilesSection = vi.fn((path: string | null = null) => {
    clearAppsPicker()
    setWorkspaceTabs((state: WorkspaceState) =>
      openFilesTab(state, { id: nextWorkspaceTabId(), path })
    )
    forceControllerRender()
  })
  // Faithful to the real controller's openPreviewSection: open/focus a preview
  // tab for a previewable file through the real store producer (dedupe by gfsUri).
  const openPreviewSection = vi.fn((preview: GfsPreviewResource) => {
    clearAppsPicker()
    setWorkspaceTabs((state: WorkspaceState) =>
      openPreviewTab(state, {
        id: nextWorkspaceTabId(),
        title: preview.name,
        gfsUri: preview.gfsUri,
        fileKind: preview.kind,
        byteLength: preview.bytes,
        ...(preview.version !== undefined ? { resourceVersion: preview.version } : {}),
        ...('mimeType' in preview ? { mimeType: preview.mimeType } : {}),
      })
    )
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
  const handleNavSelect = vi.fn(
    (
      item: AppController['navItem'],
      options?: {
        onFocusedChat?: (focusedChat: { agentRef: string; chatId: string }) => boolean
      }
    ) => {
      beginNavigationIntent()
      if (item === DESKTOP_ROUTES.chat) {
        controller.selectedAgent = null
        clearAppsPicker()
        setWorkspaceTabs((state: WorkspaceState) => focusChatState(state, nextWorkspaceTabId()))
        const focused = activeWorkspaceTab(controller.workspaceTabs)
        if (focused?.kind === 'chat' && focused.chat?.agentRef && focused.chat.chatId) {
          const identity = { agentRef: focused.chat.agentRef, chatId: focused.chat.chatId }
          if (options?.onFocusedChat?.(identity) !== true) {
            controller.handleSelectChatAgent(identity.agentRef, {
              chatId: identity.chatId,
              selectLatest: false,
            })
          }
        }
      } else if (item === DESKTOP_ROUTES.apps) {
        showAppsPicker()
      } else if (item === DESKTOP_ROUTES.files) {
        clearAppsPicker()
        setWorkspaceTabs((state: WorkspaceState) =>
          openFilesTab(state, { id: nextWorkspaceTabId() })
        )
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
    }
  )
  const setSelectedAgent = vi.fn((agent: string | null) => {
    controller.selectedAgent = agent
    forceControllerRender()
  })
  const clearActiveChat = vi.fn(() => {
    controller.activeChatId = null
    controller.activeMessages = []
    forceControllerRender()
  })
  // Faithful to the real vm: selecting an agent/chat moves the primary
  // `vm.activeChatId`/`selectedAgent`, and (non-keepNavItem) activates the chat
  // tab so `navItem` derives to `chat`. `keepNavItem` leaves the active tab (the
  // app tab) untouched so the route stays on `apps`.
  const handleSelectChatAgent = vi.fn(
    (agentName: string, options: { chatId?: string; keepNavItem?: boolean } = {}) => {
      beginNavigationIntent()
      controller.selectedAgent = agentName
      if (options.chatId && controller.isChatDeleted(agentName, options.chatId)) {
        if (!options.keepNavItem) {
          clearAppsPicker()
          setWorkspaceTabs((state: WorkspaceState) =>
            activateChatState(state, agentName, options.chatId ?? null, nextWorkspaceTabId())
          )
        }
        forceControllerRender()
        return
      }
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
      notification: { id?: string; kind?: string; agentName?: string; chatId?: string },
      options: { keepNavItem?: boolean } = {}
    ) => {
      beginNavigationIntent()
      if (notification.id) controller.markNotificationRead(notification.id)
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
    teamContextRevision: 0,
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
    openFilesSection,
    openPreviewSection,
    lastActiveChatTabId: null,
    activeChatId: null,
    chatList: [],
    latestChatSessions: [],
    notifications: [],
    toasts: [],
    markNotificationRead: vi.fn(),
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
    isHostAccessBlocked: vi.fn(() => false),
    isChatDeleted: vi.fn(() => false),
    verifyHostAccess: vi.fn(async () => true),
    verifyConversationAccess: vi.fn(async () => ({
      authorityScope: 'test-scope',
      teamContextRevision: controller.teamContextRevision,
      hostAuthorityEpoch: 0,
    })),
    isConversationAccessProofCurrent: vi.fn(
      (_agentRef: string, _chatId: string, proof: { teamContextRevision: number }) =>
        proof.teamContextRevision === controller.teamContextRevision
    ),
    isConversationAccessVerifiedForCurrentTeam: vi.fn(() => false),
    setSelectedAgent,
    clearActiveChat,
    beginNavigationIntent,
    isNavigationIntentCurrent,
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

const CHAT_TAB_A = {
  id: 'chat-a',
  title: 'Conversation A',
  createdAt: CHAT_LIST_TS,
  updatedAt: CHAT_LIST_TS,
  messageCount: 0,
} satisfies AppController['chatList'][number]
const CHAT_TAB_B = {
  id: 'chat-b',
  title: 'Conversation B',
  createdAt: CHAT_LIST_TS,
  updatedAt: CHAT_LIST_TS,
  messageCount: 0,
} satisfies AppController['chatList'][number]
const CHAT_TAB_B_LATEST = {
  ...CHAT_TAB_B,
  agentRef: 'agent-b',
} satisfies AppController['latestChatSessions'][number]
const CHAT_TAB_ACCESS_LIST = [CHAT_TAB_A, CHAT_TAB_B]

function deferredBoolean() {
  let resolve!: (value: boolean) => void
  const promise = new Promise<boolean>(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('App workspace chat tabs with held Host access', () => {
  let currentController: AppController
  let verificationChecks: ReturnType<typeof deferredBoolean>[]

  beforeEach(() => {
    vi.clearAllMocks()
    const chatA = openChatTab(createWorkspaceTabsState('chat-a', 'agent-a'), {
      id: 'chat-a',
      agentRef: 'agent-a',
      chatId: 'chat-a',
      title: 'Conversation A',
    })
    const chatB = openChatTab(chatA, {
      id: 'chat-b',
      agentRef: 'agent-b',
      chatId: 'chat-b',
      title: 'Conversation B',
    })
    const workspaceTabs = selectWorkspaceTab(chatB, 'chat-a')
    let hostAccessBlocked = true
    verificationChecks = [deferredBoolean(), deferredBoolean()]
    let verificationIndex = 0

    currentController = makeController({
      workspaceTabs,
      selectedAgent: 'agent-a',
      activeChatId: 'chat-a',
      chatList: CHAT_TAB_ACCESS_LIST,
      latestChatSessions: [CHAT_TAB_B_LATEST],
      hostAuthorityRevision: 0,
      isHostAccessBlocked: vi.fn((agentRef: string) => agentRef === 'agent-b' && hostAccessBlocked),
      verifyHostAccess: vi.fn(() => {
        const check = verificationChecks[verificationIndex++]!
        return check.promise.then(verified => {
          if (verified) {
            hostAccessBlocked = false
            currentController.hostAuthorityRevision += 1
          }
          return verified
        })
      }),
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
    navigationHarness.selectChatAgent = null
    delete (window as { clerum?: unknown }).clerum
  })

  async function mountProductionApp(
    options: {
      agentNames?: string[]
      chats?: Array<[agentRef: string, chatId: string]>
      holdTeamDirectory?: boolean
      nullSessionTeam?: boolean
      onLoadSessionMessages?: (
        chatId: string,
        args: Parameters<typeof window.clerum.rpc.loadSessionMessages>,
        load: typeof window.clerum.rpc.loadSessionMessages
      ) => ReturnType<typeof window.clerum.rpc.loadSessionMessages>
    } = {}
  ) {
    const originalBridge = window.clerum
    const { clerum, handle } = installAppControllerClerum({
      agentNames: options.agentNames ?? ['agent-x'],
    })
    const directory = makeDeferred<{ items: []; currentTeamId: string }>()
    if (options.nullSessionTeam) {
      handle.getSessionState.mockResolvedValue({
        authenticated: true,
        me: {
          id: 'user-1',
          email: 'test@clerum.io',
          name: 'Test User',
          teamId: null,
          teamName: null,
          role: null,
        },
      })
    }
    if (options.holdTeamDirectory) {
      handle.teamDirectory.mockImplementation(() => directory.promise)
    }
    for (const [agentRef, chatId] of options.chats ?? []) {
      await clerum.chat.create(agentRef, chatId)
      await clerum.chat.upsertMessages(agentRef, chatId, [
        {
          id: `${chatId}-message`,
          role: 'user',
          content: `${chatId} cached content`,
          timestamp: 1,
        },
      ])
    }
    clerum.chat.getIndex.mockImplementation(agentRef => clerum.readIndex(agentRef))
    if (options.onLoadSessionMessages) {
      const originalLoad = clerum.rpc.loadSessionMessages.getMockImplementation()!
      clerum.rpc.loadSessionMessages.mockImplementation((...args) =>
        options.onLoadSessionMessages!(
          String(args[2]),
          args as Parameters<typeof window.clerum.rpc.loadSessionMessages>,
          originalLoad
        )
      )
    }
    Object.assign(window.clerum, {
      app: originalBridge.app,
      shortcuts: originalBridge.shortcuts,
      sandboxUi: originalBridge.sandboxUi,
    })
    const actual =
      await vi.importActual<typeof import('@hooks/useAppController')>('@hooks/useAppController')
    let currentLive!: AppController
    const live = new Proxy({} as AppController, {
      get: (_target, property) => currentLive[property as keyof AppController],
      set: (_target, property, value) => {
        ;(currentLive as unknown as Record<PropertyKey, unknown>)[property] = value
        return true
      },
    })
    vi.mocked(useAppController).mockImplementation(() => {
      currentLive = actual.useAppController()
      return live
    })
    desktopQueryClient.clear()
    render(
      <QueryClientProvider client={desktopQueryClient}>
        <AgentTaskTrackerProvider>
          <App />
        </AgentTaskTrackerProvider>
      </QueryClientProvider>
    )
    await waitFor(() => expect(live.initialExperienceLoading).toBe(false))
    return {
      clerum,
      handle,
      directory,
      get live() {
        return live
      },
    }
  }

  async function addProductionChatTabs(
    live: AppController,
    chats: Array<[agentRef: string, chatId: string]>
  ) {
    act(() => {
      live.setWorkspaceTabs(state =>
        chats.reduce(
          (next, [agentRef, chatId]) =>
            openChatTab(next, {
              id: `tab-${chatId}`,
              agentRef,
              chatId,
              title: chatId,
            }),
          state
        )
      )
    })
    await waitFor(() =>
      expect(live.workspaceTabs.tabs.filter(tab => tab.kind === 'chat')).toHaveLength(chats.length)
    )
  }

  async function clickProductionChatTab(live: AppController, chatId: string) {
    const tabIndex = live.workspaceTabs.tabs.findIndex(
      tab => tab.kind === 'chat' && tab.chat?.chatId === chatId
    )
    expect(tabIndex).toBeGreaterThanOrEqual(0)
    fireEvent.click(document.querySelectorAll('.chat-view-tab__select')[tabIndex]!)
    await waitFor(() =>
      expect(
        live.workspaceTabs.tabs.find(tab => tab.id === live.workspaceTabs.activeTabId)?.chat?.chatId
      ).toBe(chatId)
    )
  }

  async function selectProductionChatTab(live: AppController, chatId: string) {
    const tabIndex = live.workspaceTabs.tabs.findIndex(
      tab => tab.kind === 'chat' && tab.chat?.chatId === chatId
    )
    expect(tabIndex).toBeGreaterThanOrEqual(0)
    const buttons = document.querySelectorAll('.chat-view-tab__select')
    fireEvent.click(buttons[tabIndex]!)
    await waitFor(() => expect(live.activeChatId).toBe(chatId))
    await waitFor(() => expect(live.chatMessagesLoading).toBe(false))
  }

  it('keeps a failed selected tab focused when an unrelated tab closes', async () => {
    currentController.workspaceTabs = openChatTab(currentController.workspaceTabs, {
      id: 'chat-d',
      agentRef: 'agent-a',
      chatId: 'chat-d',
      title: 'Conversation D',
    })
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: 'Conversation unavailable' }))
    await act(async () => verificationChecks[0]!.resolve(false))
    expect(
      currentController.workspaceTabs.tabs.find(
        tab => tab.id === currentController.workspaceTabs.activeTabId
      )?.id
    ).toBe('chat-b')

    fireEvent.click(screen.getByRole('button', { name: 'Close Conversation D' }))
    act(() => {
      currentController.chatList = [{ ...CHAT_TAB_A, title: 'Renamed A' }, CHAT_TAB_B]
      forceControllerRender()
    })

    expect(currentController.workspaceTabs.activeTabId).toBe('chat-b')
    expect(
      screen
        .getByRole('button', { name: 'Conversation unavailable, access check failed' })
        .getAttribute('aria-pressed')
    ).toBe('true')
  })

  it('keeps the last selected conversation through a delayed team-directory update', async () => {
    const chats: Array<[string, string]> = [
      ['agent-x', 'chat-1'],
      ['agent-x', 'chat-2'],
      ['agent-x', 'chat-3'],
      ['agent-x', 'chat-4'],
      ['agent-x', 'chat-5'],
    ]
    const { clerum, directory, live } = await mountProductionApp({
      holdTeamDirectory: true,
      nullSessionTeam: true,
      chats,
    })
    await addProductionChatTabs(live, chats)
    await clickProductionChatTab(live, 'chat-4')
    await waitFor(() => expect(live.activeChatId).toBe('chat-4'))
    await waitFor(() => expect(live.chatMessagesLoading).toBe(false))
    expect(screen.getByTestId('chat-page-surface').getAttribute('data-active-chat-id')).toBe(
      'chat-4'
    )

    await act(async () => directory.resolve({ items: [], currentTeamId: 'team-1' }))
    await waitFor(() => expect(live.getCurrentTeamId()).toBe('team-1'))
    expect(live.teamContextRevision).toBe(0)
    await waitFor(() => expect(live.chatMessagesLoading).toBe(false))

    expect(live.activeChatId).toBe('chat-4')
    expect(
      live.workspaceTabs.tabs.find(tab => tab.id === live.workspaceTabs.activeTabId)?.chat?.chatId
    ).toBe('chat-4')
    expect(screen.getByTestId('chat-page-surface').getAttribute('data-active-chat-id')).toBe(
      'chat-4'
    )
    expect(clerum.rpc.loadSessionMessages).toHaveBeenCalled()
  })

  it('advances the team-context revision after a confirmed team switch', async () => {
    const { handle, live } = await mountProductionApp({ nullSessionTeam: true })
    await waitFor(() => expect(live.getCurrentTeamId()).toBe('team-1'))
    const initialRevision = live.teamContextRevision ?? 0

    // Keep the session's team null so the directory supplies the current team
    // both before and after this confirmed switch.
    handle.switchTeam.mockImplementation(async teamId => {
      handle.teamDirectory.mockResolvedValue({ items: [], currentTeamId: teamId })
      return {
        authenticated: true,
        me: {
          id: 'user-1',
          email: 'test@clerum.io',
          name: 'Test User',
          teamId: null,
          teamName: null,
          role: null,
        },
      }
    })
    await act(async () => {
      await live.handleEnsureTeamContext({ teamId: 'team-2' })
    })

    await waitFor(() => {
      expect(live.getCurrentTeamId()).toBe('team-2')
      expect(live.teamContextRevision).toBeGreaterThan(initialRevision)
    })
  })

  it('does not restore local chat history after a team reset before exact access succeeds', async () => {
    const chats: Array<[string, string]> = [['agent-x', 'chat-1']]
    const { clerum, handle, live } = await mountProductionApp({ chats })
    act(() => live.handleSelectChatAgent('agent-x', { chatId: 'chat-1' }))
    await waitFor(() => expect(live.activeChatId).toBe('chat-1'))
    await waitFor(() => expect(live.chatMessagesLoading).toBe(false))
    await waitFor(() =>
      expect(
        live.workspaceTabs.tabs.some(tab => tab.kind === 'chat' && tab.chat?.chatId === 'chat-1')
      ).toBe(true)
    )
    const selectedTabId = live.workspaceTabs.activeTabId
    expect(screen.getByTestId('chat-page-surface').getAttribute('data-active-chat-id')).toBe(
      'chat-1'
    )

    const exactAccess = makeDeferred<Awaited<ReturnType<typeof clerum.rpc.loadSessionMessages>>>()
    const originalLoad = clerum.rpc.loadSessionMessages.getMockImplementation()!
    const localReadsInTeam2: Array<{
      chatId: string
      teamContextRevision: number
      activeChatId: string | null
    }> = []
    const originalLocalLoad = clerum.chat.loadMessages.getMockImplementation()!
    clerum.chat.loadMessages.mockImplementation(async (...args) => {
      if (live.getCurrentTeamId() === 'team-2') {
        localReadsInTeam2.push({
          chatId: args[1],
          teamContextRevision: live.teamContextRevision,
          activeChatId: live.activeChatId ?? null,
        })
      }
      return originalLocalLoad(...args)
    })
    clerum.rpc.loadSessionMessages.mockClear()
    clerum.rpc.loadSessionMessages.mockImplementation(async (...args) => {
      if (args[2] === 'chat-1') return exactAccess.promise
      return originalLoad(...args)
    })

    handle.teamDirectory.mockResolvedValue({ items: [], currentTeamId: 'team-2' })
    await act(async () => {
      await live.handleEnsureTeamContext({ teamId: 'team-2', announce: false })
    })
    await waitFor(() => expect(live.teamContextRevision).toBe(1))

    expect(localReadsInTeam2).toEqual([])
    expect(live.activeChatId).toBeNull()
    expect(live.workspaceTabs.activeTabId).toBe(selectedTabId)
    expect(screen.queryByTestId('chat-page-surface')).toBeNull()

    const tabIndex = live.workspaceTabs.tabs.findIndex(
      tab => tab.kind === 'chat' && tab.chat?.chatId === 'chat-1'
    )
    fireEvent.click(document.querySelectorAll('.chat-view-tab__select')[tabIndex]!)
    await waitFor(() =>
      expect(
        clerum.rpc.loadSessionMessages.mock.calls.some(
          ([agentRef, query, chatId]) =>
            agentRef === 'agent-x' && query === 'agent-x' && chatId === 'chat-1'
        )
      ).toBe(true)
    )
    await waitFor(() => expect(screen.getByText('Checking access to conversation…')).toBeTruthy())
    expect(localReadsInTeam2).toEqual([])

    await act(async () => exactAccess.resolve({ agent: 'agent-x', chatId: 'chat-1', turns: [] }))
    await waitFor(() => expect(localReadsInTeam2.some(read => read.chatId === 'chat-1')).toBe(true))
    await waitFor(() => expect(live.chatMessagesLoading).toBe(false))
    expect(screen.getByTestId('chat-page-surface').getAttribute('data-active-chat-id')).toBe(
      'chat-1'
    )
  })

  it('keeps latest-chat selection available after a team reset from a blank chat', async () => {
    const chats: Array<[string, string]> = [['agent-x', 'chat-1']]
    const { handle, live } = await mountProductionApp({ chats })
    act(() => live.handleSelectChatAgent('agent-x', { selectLatest: false }))
    await waitFor(() => {
      expect(live.activeChatId).toBeNull()
      const activeTab = activeWorkspaceTab(live.workspaceTabs)
      expect(activeTab?.kind).toBe('chat')
      if (activeTab?.kind === 'chat') expect(activeTab.chat?.chatId ?? null).toBeNull()
    })

    handle.teamDirectory.mockResolvedValue({ items: [], currentTeamId: 'team-2' })
    await act(async () => {
      await live.handleEnsureTeamContext({ teamId: 'team-2', announce: false })
    })

    await waitFor(() => expect(live.teamContextRevision).toBe(1))
    await waitFor(() => expect(live.activeChatId).toBe('chat-1'))
    await waitFor(() => expect(live.chatMessagesLoading).toBe(false))
    const activeTab = activeWorkspaceTab(live.workspaceTabs)
    expect(activeTab?.kind).toBe('chat')
    if (activeTab?.kind === 'chat') expect(activeTab.chat?.chatId).toBe('chat-1')
  })

  it('drops explicit chat selection authority when the team context changes', async () => {
    const chatA = openChatTab(createWorkspaceTabsState('chat-a', 'agent-a'), {
      id: 'chat-a',
      agentRef: 'agent-a',
      chatId: 'chat-a',
      title: 'Conversation A',
    })
    const chatB = openChatTab(chatA, {
      id: 'chat-b',
      agentRef: 'agent-b',
      chatId: 'chat-b',
      title: 'Conversation B',
    })
    currentController = makeController({
      workspaceTabs: selectWorkspaceTab(chatB, 'chat-a'),
      selectedAgent: 'agent-a',
      activeChatId: 'chat-a',
      chatList: CHAT_TAB_ACCESS_LIST,
      latestChatSessions: [CHAT_TAB_B_LATEST],
      isHostAccessBlocked: vi.fn(() => false),
      verifyHostAccess: vi.fn(async () => true),
    } as Partial<AppController>)
    render(<App />)

    const selectChatAgent = vi.spyOn(currentController, 'handleSelectChatAgent')
    fireEvent.click(screen.getByRole('button', { name: 'Conversation B' }))
    await waitFor(() => expect(currentController.activeChatId).toBe('chat-b'))
    const selectionCallCount = selectChatAgent.mock.calls.length
    expect(currentController.workspaceTabs.activeTabId).toBe('chat-b')

    act(() => {
      currentController.activeChatId = null
      currentController.selectedAgent = null
      currentController.teamContextRevision += 1
      forceControllerRender()
    })

    expect(currentController.activeChatId).toBeNull()
    expect(selectChatAgent).toHaveBeenCalledTimes(selectionCallCount)
    expect(currentController.workspaceTabs.activeTabId).toBe('chat-b')
    expect(
      screen.getByRole('button', { name: 'Conversation B, team changed' }).getAttribute('title')
    ).toBe('Team changed while this conversation was opening. Select to retry.')
    expect(
      screen.getByText(
        'The team changed while this conversation was opening. Select this tab to retry.'
      )
    ).toBeTruthy()
  })

  it('checks the exact chat in the new team before revealing its cached transcript', async () => {
    const chats: Array<[string, string]> = [['agent-x', 'chat-1']]
    const { clerum, handle, live } = await mountProductionApp({ chats })
    await addProductionChatTabs(live, chats)
    await clickProductionChatTab(live, 'chat-1')
    await waitFor(() => expect(live.chatMessagesLoading).toBe(false))
    const localReadsInTeam2: string[] = []
    const originalLocalLoad = clerum.chat.loadMessages.getMockImplementation()!
    clerum.chat.loadMessages.mockImplementation(async (...args) => {
      if (live.getCurrentTeamId() === 'team-2') localReadsInTeam2.push(args[1])
      return originalLocalLoad(...args)
    })

    handle.teamDirectory.mockResolvedValue({ items: [], currentTeamId: 'team-2' })
    await act(async () => {
      await live.handleEnsureTeamContext({ teamId: 'team-2', announce: false })
    })
    await waitFor(() => expect(live.teamContextRevision).toBeGreaterThan(0))
    expect(localReadsInTeam2).not.toContain('chat-1')
    const denied = await ipcGenericForbidden('rpc:loadSessionMessages')
    const exactChatCheck =
      makeDeferred<Awaited<ReturnType<typeof clerum.rpc.loadSessionMessages>>>()
    const originalLoad = clerum.rpc.loadSessionMessages.getMockImplementation()!
    clerum.rpc.loadSessionMessages.mockClear()
    clerum.rpc.loadSessionMessages.mockImplementation(async (...args) => {
      if (args[2] === 'chat-1') {
        await exactChatCheck.promise
        throw denied
      }
      return originalLoad(...args)
    })

    const tabIndex = live.workspaceTabs.tabs.findIndex(
      tab => tab.kind === 'chat' && tab.chat?.chatId === 'chat-1'
    )
    fireEvent.click(document.querySelectorAll('.chat-view-tab__select')[tabIndex]!)
    const exactChatCallCount = () =>
      clerum.rpc.loadSessionMessages.mock.calls.filter(
        args => args[0] === 'agent-x' && args[1] === 'agent-x' && args[2] === 'chat-1'
      ).length
    await waitFor(() =>
      expect(clerum.rpc.loadSessionMessages).toHaveBeenCalledWith('agent-x', 'agent-x', 'chat-1')
    )
    expect(screen.getByText('Checking access to conversation…')).toBeTruthy()
    expect(screen.queryByTestId('chat-page-surface')).toBeNull()
    expect(localReadsInTeam2).not.toContain('chat-1')

    fireEvent.click(document.querySelectorAll('.chat-view-tab__select')[tabIndex]!)
    await waitFor(() => expect(exactChatCallCount()).toBeGreaterThanOrEqual(2))
    expect(screen.queryByTestId('chat-page-surface')).toBeNull()

    await act(async () => exactChatCheck.resolve({ agent: 'agent-x', chatId: 'chat-1', turns: [] }))
    await waitFor(() =>
      expect(
        screen.getByText(
          'The team changed while this conversation was opening. Select this tab to retry.'
        )
      ).toBeTruthy()
    )
    expect(screen.queryByTestId('chat-page-surface')).toBeNull()

    fireEvent.click(document.querySelectorAll('.chat-view-tab__select')[tabIndex]!)
    await waitFor(() => expect(exactChatCallCount()).toBeGreaterThanOrEqual(3))
    expect(screen.queryByTestId('chat-page-surface')).toBeNull()
  })

  it('discards an exact-chat authorization if the team changes again while it is pending', async () => {
    const chats: Array<[string, string]> = [['agent-x', 'chat-1']]
    const { clerum, handle, live } = await mountProductionApp({ chats })
    await addProductionChatTabs(live, chats)
    await clickProductionChatTab(live, 'chat-1')

    handle.teamDirectory.mockResolvedValue({ items: [], currentTeamId: 'team-2' })
    await act(async () => {
      await live.handleEnsureTeamContext({ teamId: 'team-2', announce: false })
    })
    await waitFor(() => expect(live.teamContextRevision).toBe(1))

    const authorization = makeDeferred<Awaited<ReturnType<typeof clerum.rpc.loadSessionMessages>>>()
    const originalLoad = clerum.rpc.loadSessionMessages.getMockImplementation()!
    clerum.rpc.loadSessionMessages.mockClear()
    clerum.rpc.loadSessionMessages.mockImplementation(async (...args) => {
      if (args[2] === 'chat-1') return authorization.promise
      return originalLoad(...args)
    })
    const tabIndex = live.workspaceTabs.tabs.findIndex(
      tab => tab.kind === 'chat' && tab.chat?.chatId === 'chat-1'
    )
    fireEvent.click(document.querySelectorAll('.chat-view-tab__select')[tabIndex]!)
    await waitFor(() =>
      expect(clerum.rpc.loadSessionMessages).toHaveBeenCalledWith('agent-x', 'agent-x', 'chat-1')
    )

    handle.teamDirectory.mockResolvedValue({ items: [], currentTeamId: 'team-3' })
    await act(async () => {
      await live.handleEnsureTeamContext({ teamId: 'team-3', announce: false })
    })
    await waitFor(() => expect(live.teamContextRevision).toBe(2))
    await act(async () => authorization.resolve({ agent: 'agent-x', chatId: 'chat-1', turns: [] }))

    await waitFor(() =>
      expect(
        screen.getByText(
          'The team changed while this conversation was opening. Select this tab to retry.'
        )
      ).toBeTruthy()
    )
    expect(screen.queryByTestId('chat-page-surface')).toBeNull()
  })

  it('does not auto-select the previous agent while another agent tab awaits access', async () => {
    const chats: Array<[string, string]> = [
      ['agent-x', 'chat-1'],
      ['agent-y', 'chat-2'],
    ]
    const { clerum, handle, live } = await mountProductionApp({ chats })
    await addProductionChatTabs(live, chats)
    await clickProductionChatTab(live, 'chat-1')
    await waitFor(() => expect(live.chatMessagesLoading).toBe(false))

    handle.teamDirectory.mockResolvedValue({ items: [], currentTeamId: 'team-2' })
    await act(async () => {
      await live.handleEnsureTeamContext({ teamId: 'team-2', announce: false })
    })
    await waitFor(() => expect(live.teamContextRevision).toBe(1))

    const localReadsInTeam3: Array<{ agentRef: string; chatId: string }> = []
    const originalLocalLoad = clerum.chat.loadMessages.getMockImplementation()!
    clerum.chat.loadMessages.mockImplementation(async (...args) => {
      if (live.getCurrentTeamId() === 'team-3') {
        localReadsInTeam3.push({ agentRef: args[0], chatId: args[1] })
      }
      return originalLocalLoad(...args)
    })

    const authorization = makeDeferred<Awaited<ReturnType<typeof clerum.rpc.loadSessionMessages>>>()
    const originalLoad = clerum.rpc.loadSessionMessages.getMockImplementation()!
    clerum.rpc.loadSessionMessages.mockClear()
    clerum.rpc.loadSessionMessages.mockImplementation(async (...args) => {
      if (args[2] === 'chat-2') return authorization.promise
      return originalLoad(...args)
    })
    await clickProductionChatTab(live, 'chat-2')
    await waitFor(() =>
      expect(clerum.rpc.loadSessionMessages).toHaveBeenCalledWith('agent-y', 'agent-y', 'chat-2')
    )
    expect(live.selectedAgent).toBe('agent-x')

    handle.teamDirectory.mockResolvedValue({ items: [], currentTeamId: 'team-3' })
    await act(async () => {
      await live.handleEnsureTeamContext({ teamId: 'team-3', announce: false })
    })
    await waitFor(() => expect(live.teamContextRevision).toBe(2))
    expect(localReadsInTeam3).toEqual([])
    expect(live.workspaceTabs.activeTabId).toBe('tab-chat-2')

    await act(async () => authorization.resolve({ agent: 'agent-y', chatId: 'chat-2', turns: [] }))
    await waitFor(() =>
      expect(
        screen.getByText(
          'The team changed while this conversation was opening. Select this tab to retry.'
        )
      ).toBeTruthy()
    )
    expect(localReadsInTeam3).toEqual([])
    expect(screen.queryByTestId('chat-page-surface')).toBeNull()
  })

  it('rechecks an older chat tab after switching away across team contexts', async () => {
    const chats: Array<[string, string]> = [
      ['agent-x', 'chat-1'],
      ['agent-x', 'chat-2'],
    ]
    const { clerum, handle, live } = await mountProductionApp({ chats })
    await addProductionChatTabs(live, chats)
    act(() => live.handleNavSelect(DESKTOP_ROUTES.files))
    await waitFor(() => expect(live.navItem).toBe(DESKTOP_ROUTES.files))
    await clickProductionChatTab(live, 'chat-1')

    handle.teamDirectory.mockResolvedValue({ items: [], currentTeamId: 'team-2' })
    await act(async () => {
      await live.handleEnsureTeamContext({ teamId: 'team-2', announce: false })
    })
    await waitFor(() => expect(live.teamContextRevision).toBe(1))
    expect(screen.queryByTestId('chat-page-surface')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Files' }))
    await waitFor(() => expect(live.navItem).toBe(DESKTOP_ROUTES.files))

    const authorization = makeDeferred<Awaited<ReturnType<typeof clerum.rpc.loadSessionMessages>>>()
    const originalLoad = clerum.rpc.loadSessionMessages.getMockImplementation()!
    clerum.rpc.loadSessionMessages.mockClear()
    clerum.rpc.loadSessionMessages.mockImplementation(async (...args) => {
      if (args[2] === 'chat-2') return authorization.promise
      return originalLoad(...args)
    })
    await clickProductionChatTab(live, 'chat-2')

    await waitFor(() =>
      expect(clerum.rpc.loadSessionMessages).toHaveBeenCalledWith('agent-x', 'agent-x', 'chat-2')
    )
    expect(screen.getByText('Checking access to conversation…')).toBeTruthy()
    expect(screen.queryByTestId('chat-page-surface')).toBeNull()

    await act(async () => authorization.resolve({ agent: 'agent-x', chatId: 'chat-2', turns: [] }))
    await waitFor(() => expect(live.activeChatId).toBe('chat-2'))
    await waitFor(() => expect(live.chatMessagesLoading).toBe(false))
    expect(screen.getByTestId('chat-page-surface').getAttribute('data-active-chat-id')).toBe(
      'chat-2'
    )
  })

  it('verifies access before restoring a stale chat into the drawer', async () => {
    const chats: Array<[string, string]> = [['agent-x', 'chat-1']]
    const { clerum, handle, live } = await mountProductionApp({ chats })
    await addProductionChatTabs(live, chats)
    await clickProductionChatTab(live, 'chat-1')
    await waitFor(() => expect(live.activeChatId).toBe('chat-1'))
    await waitFor(() => expect(live.chatMessagesLoading).toBe(false))

    handle.teamDirectory.mockResolvedValue({ items: [], currentTeamId: 'team-2' })
    await act(async () => {
      await live.handleEnsureTeamContext({ teamId: 'team-2', announce: false })
    })
    await waitFor(() => expect(live.teamContextRevision).toBe(1))

    const denied = await ipcGenericForbidden('rpc:loadSessionMessages')
    const authorization = makeDeferred<Awaited<ReturnType<typeof clerum.rpc.loadSessionMessages>>>()
    const originalLoad = clerum.rpc.loadSessionMessages.getMockImplementation()!
    clerum.rpc.loadSessionMessages.mockClear()
    clerum.rpc.loadSessionMessages.mockImplementation(async (...args) => {
      if (args[2] === 'chat-1') {
        await authorization.promise
        throw denied
      }
      return originalLoad(...args)
    })

    act(() => live.handleNavSelect(DESKTOP_ROUTES.files))
    await waitFor(() => expect(live.navItem).toBe(DESKTOP_ROUTES.files))
    act(() => appHeaderHarness.props?.onToggleChatDrawer?.())

    await waitFor(() =>
      expect(
        clerum.rpc.loadSessionMessages.mock.calls.some(
          args => args[0] === 'agent-x' && args[1] === 'agent-x' && args[2] === 'chat-1'
        )
      ).toBe(true)
    )
    expect(screen.getByText('Checking access to conversation…')).toBeTruthy()
    expect(screen.queryByTestId('chat-page-surface')).toBeNull()

    await act(async () => authorization.resolve({ agent: 'agent-x', chatId: 'chat-1', turns: [] }))
    await waitFor(() =>
      expect(
        screen.getByText(
          'The team changed while this conversation was opening. Select this tab to retry.'
        )
      ).toBeTruthy()
    )
    expect(screen.queryByTestId('chat-page-surface')).toBeNull()
  })

  it('waits for exact chat access before opening a cross-team notification', async () => {
    const chats: Array<[string, string]> = [
      ['agent-x', 'chat-1'],
      ['agent-x', 'chat-2'],
    ]
    const { clerum, handle, live } = await mountProductionApp({ chats })
    await addProductionChatTabs(live, chats)
    await clickProductionChatTab(live, 'chat-1')
    await waitFor(() => expect(live.chatMessagesLoading).toBe(false))

    handle.teamDirectory.mockResolvedValue({ items: [], currentTeamId: 'team-2' })
    const authorization = makeDeferred<Awaited<ReturnType<typeof clerum.rpc.loadSessionMessages>>>()
    const originalLoad = clerum.rpc.loadSessionMessages.getMockImplementation()!
    clerum.rpc.loadSessionMessages.mockClear()
    clerum.rpc.loadSessionMessages.mockImplementation(async (...args) => {
      if (args[2] === 'chat-2') return authorization.promise
      return originalLoad(...args)
    })

    let opening!: Promise<void>
    act(() => {
      opening = appHeaderHarness.openNotification!({
        id: 'cross-team-chat-open',
        kind: 'assistant_reply',
        agentName: 'agent-x',
        chatId: 'chat-2',
        teamId: 'team-2',
        text: 'new-team reply',
        timestamp: Date.now(),
        read: false,
      } as AppNotification)
    })

    await waitFor(() => expect(live.teamContextRevision).toBe(1))
    await waitFor(() =>
      expect(clerum.rpc.loadSessionMessages).toHaveBeenCalledWith('agent-x', 'agent-x', 'chat-2')
    )
    expect(
      screen.queryByTestId('chat-page-surface')?.getAttribute('data-active-chat-id') ?? null
    ).not.toBe('chat-2')

    await act(async () => {
      authorization.resolve({ agent: 'agent-x', chatId: 'chat-2', turns: [] })
      await opening
    })
    await waitFor(() => expect(live.activeChatId).toBe('chat-2'))
    await waitFor(() => expect(live.chatMessagesLoading).toBe(false))
    expect(screen.getByTestId('chat-page-surface').getAttribute('data-active-chat-id')).toBe(
      'chat-2'
    )
  })

  it('keeps a same-team notification on its requested tab while stale access is checked', async () => {
    const chatA = openChatTab(createWorkspaceTabsState('chat-1', 'alpha'), {
      id: 'chat-1',
      agentRef: 'alpha',
      chatId: 'chat-1',
      title: 'First chat',
    })
    const chatB = openChatTab(chatA, {
      id: 'chat-2',
      agentRef: 'alpha',
      chatId: 'chat-2',
      title: 'Second chat',
    })
    const authorization =
      makeDeferred<Awaited<ReturnType<AppController['verifyConversationAccess']>>>()
    currentController = makeController({
      workspaceTabs: selectWorkspaceTab(chatB, 'chat-1'),
      selectedAgent: 'alpha',
      activeChatId: 'chat-1',
      chatList: CHAT_LIST,
      verifyConversationAccess: vi.fn(() => authorization.promise),
    } as Partial<AppController>)
    render(<App />)
    act(() => {
      currentController.teamContextRevision += 1
      currentController.setWorkspaceTabs(state => ({ ...state }))
    })

    await act(async () => {
      await appHeaderHarness.openNotification!({
        id: 'same-team-stale-chat-open',
        kind: 'assistant_reply',
        agentName: 'alpha',
        chatId: 'chat-2',
        teamId: 'team-a',
        text: 'reply',
        timestamp: Date.now(),
        read: false,
      } as AppNotification)
    })

    expect(currentController.verifyConversationAccess).toHaveBeenCalledWith('alpha', 'chat-2')
    expect(currentController.handleOpenNotification).not.toHaveBeenCalled()
    expect(currentController.markNotificationRead).toHaveBeenCalledWith('same-team-stale-chat-open')
    expect(currentController.activeWorkspaceTab?.id).toBe('chat-2')
    expect(screen.getByText('Checking access to conversation…')).toBeTruthy()
    expect(screen.queryByTestId('chat-page-surface')).toBeNull()

    await act(async () => authorization.resolve(null))
    await waitFor(() =>
      expect(
        screen.getByText(
          'The team changed while this conversation was opening. Select this tab to retry.'
        )
      ).toBeTruthy()
    )
    expect(currentController.activeWorkspaceTab?.id).toBe('chat-2')
    expect(screen.queryByTestId('chat-page-surface')).toBeNull()
  })

  it('checks a stale active chat before composer.focus reveals it', async () => {
    let commandHandler: Parameters<typeof window.clerum.shortcuts.onCommand>[0] | null = null
    const currentBridge = window.clerum
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        ...currentBridge,
        shortcuts: {
          ...currentBridge.shortcuts,
          onCommand: vi.fn((callback: typeof commandHandler) => {
            commandHandler = callback
            return vi.fn()
          }),
        },
      },
    })

    const chat = openChatTab(createWorkspaceTabsState('chat-1', 'alpha'), {
      id: 'chat-1',
      agentRef: 'alpha',
      chatId: 'chat-1',
      title: 'First chat',
    })
    const authorization =
      makeDeferred<Awaited<ReturnType<AppController['verifyConversationAccess']>>>()
    currentController = makeController({
      workspaceTabs: chat,
      selectedAgent: 'alpha',
      activeChatId: 'chat-1',
      chatList: CHAT_LIST,
      verifyConversationAccess: vi.fn(() => authorization.promise),
    } as Partial<AppController>)
    render(<App />)
    act(() => {
      currentController.teamContextRevision += 1
      currentController.setWorkspaceTabs(state => ({ ...state }))
    })

    act(() => commandHandler?.('composer.focus', 'host'))
    expect(currentController.verifyConversationAccess).toHaveBeenCalledWith('alpha', 'chat-1')
    expect(currentController.activeWorkspaceTab?.id).toBe('chat-1')
    expect(screen.getByText('Checking access to conversation…')).toBeTruthy()
    expect(screen.queryByTestId('chat-page-surface')).toBeNull()

    await act(async () => authorization.resolve(null))
    await waitFor(() =>
      expect(
        screen.getByText(
          'The team changed while this conversation was opening. Select this tab to retry.'
        )
      ).toBeTruthy()
    )
    expect(currentController.activeWorkspaceTab?.id).toBe('chat-1')
    expect(screen.queryByTestId('chat-page-surface')).toBeNull()
  })

  it('routes sidebar Chats focus through exact access verification for a stale chat', async () => {
    const chat = openChatTab(createWorkspaceTabsState('chat-1', 'alpha'), {
      id: 'chat-1',
      agentRef: 'alpha',
      chatId: 'chat-1',
      title: 'First chat',
    })
    const settings = openSettingsTab(chat, { id: 'settings-1', section: 'settings' })
    const authorization =
      makeDeferred<Awaited<ReturnType<AppController['verifyConversationAccess']>>>()
    currentController = makeController({
      workspaceTabs: settings,
      selectedAgent: 'alpha',
      activeChatId: 'chat-1',
      chatList: CHAT_LIST,
      verifyConversationAccess: vi.fn(() => authorization.promise),
    } as Partial<AppController>)
    render(<App />)
    act(() => {
      currentController.teamContextRevision += 1
      currentController.setWorkspaceTabs(state => ({ ...state }))
    })

    act(() => sidebarHarness.props?.onSelect?.(DESKTOP_ROUTES.chat))

    expect(currentController.verifyConversationAccess).toHaveBeenCalledWith('alpha', 'chat-1')
    expect(currentController.handleSelectChatAgent).not.toHaveBeenCalled()
    expect(currentController.activeWorkspaceTab?.id).toBe('chat-1')
    expect(screen.getByText('Checking access to conversation…')).toBeTruthy()
    expect(screen.queryByTestId('chat-page-surface')).toBeNull()

    await act(async () =>
      authorization.resolve({
        authorityScope: 'test-scope',
        teamContextRevision: currentController.teamContextRevision,
        hostAuthorityEpoch: 0,
      })
    )
    await waitFor(() =>
      expect(screen.getByTestId('chat-page-surface').getAttribute('data-active-chat-id')).toBe(
        'chat-1'
      )
    )
  })

  it('checks a stale focused chat before the sidebar Chats route reveals it', async () => {
    const chats: Array<[string, string]> = [['agent-x', 'chat-1']]
    const { clerum, handle, live } = await mountProductionApp({ chats })
    await addProductionChatTabs(live, chats)
    await clickProductionChatTab(live, 'chat-1')

    handle.teamDirectory.mockResolvedValue({ items: [], currentTeamId: 'team-2' })
    await act(async () => {
      await live.handleEnsureTeamContext({ teamId: 'team-2', announce: false })
    })
    await waitFor(() => expect(live.teamContextRevision).toBe(1))

    act(() => live.handleNavSelect(DESKTOP_ROUTES.files))
    await waitFor(() => expect(live.navItem).toBe(DESKTOP_ROUTES.files))

    const authorization = makeDeferred<Awaited<ReturnType<typeof clerum.rpc.loadSessionMessages>>>()
    const originalLoad = clerum.rpc.loadSessionMessages.getMockImplementation()!
    clerum.rpc.loadSessionMessages.mockClear()
    clerum.rpc.loadSessionMessages.mockImplementation(async (...args) => {
      if (args[2] === 'chat-1') return authorization.promise
      return originalLoad(...args)
    })

    act(() => sidebarHarness.props?.onSelect?.(DESKTOP_ROUTES.chat))

    await waitFor(() =>
      expect(clerum.rpc.loadSessionMessages).toHaveBeenCalledWith('agent-x', 'agent-x', 'chat-1')
    )
    expect(screen.getByText('Checking access to conversation…')).toBeTruthy()
    expect(screen.queryByTestId('chat-page-surface')).toBeNull()
    expect(live.activeWorkspaceTab?.chat?.chatId).toBe('chat-1')

    await act(async () => authorization.resolve({ agent: 'agent-x', chatId: 'chat-1', turns: [] }))
    await waitFor(() => expect(live.activeChatId).toBe('chat-1'))
    await waitFor(() => expect(live.chatMessagesLoading).toBe(false))
    expect(screen.getByTestId('chat-page-surface').getAttribute('data-active-chat-id')).toBe(
      'chat-1'
    )
  })

  it('rejects an exact-chat proof that is stale at the reveal boundary', async () => {
    const chatA = openChatTab(createWorkspaceTabsState('chat-a', 'agent-a'), {
      id: 'chat-a',
      agentRef: 'agent-a',
      chatId: 'chat-a',
      title: 'Conversation A',
    })
    const chatB = openChatTab(chatA, {
      id: 'chat-b',
      agentRef: 'agent-b',
      chatId: 'chat-b',
      title: 'Conversation B',
    })
    currentController = makeController({
      workspaceTabs: selectWorkspaceTab(chatB, 'chat-a'),
      selectedAgent: 'agent-a',
      activeChatId: 'chat-a',
      chatList: CHAT_TAB_ACCESS_LIST,
      verifyConversationAccess: vi.fn(async () => ({
        authorityScope: 'old-scope',
        teamContextRevision: 1,
        hostAuthorityEpoch: 0,
      })),
      isConversationAccessProofCurrent: vi.fn(() => false),
      isConversationAccessVerifiedForCurrentTeam: vi.fn(() => false),
      isNavigationIntentCurrent: vi.fn(() => true),
    } as Partial<AppController>)
    render(<App />)

    act(() => {
      currentController.teamContextRevision = 1
      currentController.activeChatId = null
      currentController.selectedAgent = null
      forceControllerRender()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Conversation B' }))

    await waitFor(() =>
      expect(currentController.verifyConversationAccess).toHaveBeenCalledWith('agent-b', 'chat-b')
    )
    await waitFor(() =>
      expect(
        screen.getByText(
          'The team changed while this conversation was opening. Select this tab to retry.'
        )
      ).toBeTruthy()
    )
    expect(currentController.isConversationAccessProofCurrent).toHaveBeenCalledWith(
      'agent-b',
      'chat-b',
      expect.objectContaining({ teamContextRevision: 1 })
    )
    expect(screen.queryByTestId('chat-page-surface')).toBeNull()
  })

  it('keeps the newest tab focused when an older cross-team notification finishes switching teams', async () => {
    const chats: Array<[string, string]> = [
      ['agent-x', 'chat-1'],
      ['agent-x', 'chat-2'],
      ['agent-x', 'chat-3'],
    ]
    const { handle, live } = await mountProductionApp({ chats })
    await addProductionChatTabs(live, chats)
    await clickProductionChatTab(live, 'chat-1')
    const switchResult = makeDeferred<{
      authenticated: true
      me: {
        id: string
        email: string
        name: string
        teamId: string
        teamName: string
        role: string
      }
    }>()
    handle.switchTeam.mockReturnValue(switchResult.promise)

    let opening!: Promise<void>
    act(() => {
      opening = appHeaderHarness.openNotification!({
        id: 'old-team-open',
        kind: 'assistant_reply',
        agentName: 'agent-x',
        chatId: 'chat-2',
        teamId: 'team-2',
        text: 'older notification',
        timestamp: Date.now(),
        read: false,
      } as AppNotification)
    })
    await waitFor(() => expect(handle.switchTeam).toHaveBeenCalledWith('team-2'))

    await clickProductionChatTab(live, 'chat-3')
    expect(live.activeChatId).toBe('chat-3')
    const initialRevision = live.teamContextRevision ?? 0
    handle.teamDirectory.mockResolvedValue({ items: [], currentTeamId: 'team-2' })
    await act(async () => {
      switchResult.resolve({
        authenticated: true,
        me: {
          id: 'user-1',
          email: 'test@clerum.io',
          name: 'Test User',
          teamId: 'team-2',
          teamName: 'Team 2',
          role: 'member',
        },
      })
      await opening
    })

    expect(
      live.workspaceTabs.tabs.find(tab => tab.id === live.workspaceTabs.activeTabId)?.chat?.chatId
    ).toBe('chat-3')
    const selectedTab = live.workspaceTabs.tabs.find(
      tab => tab.id === live.workspaceTabs.activeTabId
    )!
    expect(
      screen
        .getByRole('button', { name: `${selectedTab.title}, team changed` })
        .getAttribute('aria-pressed')
    ).toBe('true')
    expect(
      screen.getByText(
        'The team changed while this conversation was opening. Select this tab to retry.'
      )
    ).toBeTruthy()
    expect(screen.queryByTestId('chat-page-surface')).toBeNull()
    await waitFor(() => expect(live.teamContextRevision).toBeGreaterThan(initialRevision))
  })

  it('selects a neighboring drawer chat when closing the displayed conversation', () => {
    const chatOne = openChatTab(createWorkspaceTabsState('chat-one', 'alpha'), {
      id: 'tab-chat-1',
      agentRef: 'alpha',
      chatId: 'chat-1',
      title: 'First chat',
    })
    const chatTwo = openChatTab(chatOne, {
      id: 'tab-chat-2',
      agentRef: 'alpha',
      chatId: 'chat-2',
      title: 'Second chat',
    })
    currentController = makeController({
      workspaceTabs: openFilesTab(chatTwo, { id: 'files-tab' }),
      selectedAgent: 'alpha',
      activeChatId: 'chat-2',
      chatList: CHAT_LIST,
    } as Partial<AppController>)
    render(<App />)
    act(() => appHeaderHarness.props?.onToggleChatDrawer?.())

    expect(document.querySelector('.chat-drawer')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Close Second chat' }))

    expect(currentController.navItem).toBe(DESKTOP_ROUTES.files)
    expect(currentController.activeChatId).toBe('chat-1')
    expect(
      currentController.workspaceTabs.tabs.some(
        tab => tab.kind === 'chat' && tab.chat?.chatId === 'chat-2'
      )
    ).toBe(false)
  })

  it('clears the displayed conversation when closing the final full-screen chat tab', () => {
    const tabs = openChatTab(createWorkspaceTabsState('last-chat', 'agent-x'), {
      id: 'last-chat-tab',
      agentRef: 'agent-x',
      chatId: 'last-chat',
      title: 'Last chat',
    })
    currentController = makeController({
      workspaceTabs: tabs,
      selectedAgent: 'agent-x',
      activeChatId: 'last-chat',
    } as Partial<AppController>)
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: 'Close Last chat' }))

    expect(currentController.workspaceTabs.tabs).toHaveLength(0)
    expect(currentController.selectedAgent).toBeNull()
    expect(currentController.activeChatId).toBeNull()
    expect(screen.queryByTestId('chat-page-surface')).toBeNull()
    expect(screen.getByText('Nothing open')).toBeTruthy()
  })

  it('clears a closed active chat when a non-chat workspace tab becomes active', () => {
    const chat = openChatTab(createEmptyWorkspaceTabsState(), {
      id: 'closed-chat-tab',
      agentRef: 'agent-x',
      chatId: 'closed-chat',
      title: 'Closed chat',
    })
    const tabs = selectWorkspaceTab(openFilesTab(chat, { id: 'files-tab' }), 'closed-chat-tab')
    currentController = makeController({
      workspaceTabs: tabs,
      selectedAgent: 'agent-x',
      activeChatId: 'closed-chat',
    } as Partial<AppController>)
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: 'Close Closed chat' }))

    expect(activeWorkspaceTab(currentController.workspaceTabs)?.kind).toBe('files')
    expect(currentController.selectedAgent).toBeNull()
    expect(currentController.activeChatId).toBeNull()
    act(() => appHeaderHarness.props?.onToggleChatDrawer?.())
    expect(screen.getByRole('button', { name: 'Open chats' })).toBeTruthy()
    expect(
      currentController.workspaceTabs.tabs.some(
        tab => tab.kind === 'chat' && tab.chat?.chatId === 'closed-chat'
      )
    ).toBe(false)
  })

  it('restores a launch-origin chat after its last drawer tab was closed', () => {
    const tabs = openChatTab(createWorkspaceTabsState('origin-chat', 'alpha'), {
      id: 'origin-chat-tab',
      agentRef: 'alpha',
      chatId: 'origin-chat',
      title: 'Origin chat',
    })
    currentController = makeController({
      workspaceTabs: tabs,
      selectedAgent: 'alpha',
      activeChatId: 'origin-chat',
    } as Partial<AppController>)
    render(<App />)

    act(() => {
      sidebarHarness.props?.onOpenSandboxUiApp?.({
        appRef: 'ns/app',
        label: 'App',
        defaultPath: '/',
      })
    })
    expect(appHeaderHarness.props?.chatDrawerOpen).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Close Origin chat' }))
    expect(
      currentController.workspaceTabs.tabs.some(
        tab => tab.kind === 'chat' && tab.chat?.chatId === 'origin-chat'
      )
    ).toBe(false)

    act(() => appHeaderHarness.props?.onToggleChatDrawer?.())
    act(() => appHeaderHarness.props?.onToggleChatDrawer?.())

    expect(
      currentController.workspaceTabs.tabs.some(
        tab => tab.kind === 'chat' && tab.chat?.chatId === 'origin-chat'
      )
    ).toBe(true)
  })

  it('keeps a pending drawer selection when closing the previously displayed chat', async () => {
    const drawerB = openChatTab(createWorkspaceTabsState('seed-chat', 'agent-a'), {
      id: 'drawer-chat-b',
      agentRef: 'agent-a',
      chatId: 'chat-b',
      title: 'Conversation B',
    })
    const chatC = openChatTab(drawerB, {
      id: 'drawer-chat-c',
      agentRef: 'agent-b',
      chatId: 'chat-c',
      title: 'Conversation C',
    })
    currentController.workspaceTabs = openFilesTab(chatC, { id: 'files-tab' })
    currentController.selectedAgent = 'agent-a'
    currentController.activeChatId = 'chat-b'
    currentController.chatList = [
      ...CHAT_TAB_ACCESS_LIST,
      { ...CHAT_TAB_B, id: 'chat-c', title: 'Conversation C' },
    ]
    forceControllerRender()
    render(<App />)
    act(() => appHeaderHarness.props?.onToggleChatDrawer?.())

    fireEvent.click(screen.getByRole('button', { name: 'Open chats' }))
    fireEvent.click(
      screen
        .getAllByRole('option', { name: 'Conversation unavailable' })
        .find(option => option.getAttribute('aria-selected') === 'false')!
    )
    expect(screen.getByText('Checking access to conversation…')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open chats' }).getAttribute('aria-busy')).toBe(
      'true'
    )

    fireEvent.click(screen.getByRole('button', { name: 'Close Conversation B' }))
    act(() => {
      currentController.chatList = [
        { ...CHAT_TAB_A, title: 'Renamed A' },
        { ...CHAT_TAB_B, id: 'chat-c', title: 'Renamed C' },
      ]
      forceControllerRender()
    })

    expect(currentController.workspaceTabs.activeTabId).toBe('files-tab')
    expect(currentController.workspaceTabs.tabs.some(tab => tab.id === 'chat-b')).toBe(false)
    expect(
      currentController.workspaceTabs.tabs.some(
        tab => tab.kind === 'chat' && tab.chat?.chatId === 'chat-b'
      )
    ).toBe(false)
    expect(screen.getByRole('button', { name: 'Open chats' }).textContent).toContain(
      'Conversation unavailable'
    )
    expect(screen.getByText('Checking access to conversation…')).toBeTruthy()

    await act(async () => verificationChecks[0]!.resolve(false))
    expect(screen.getByText('Could not verify access. Select this tab to retry.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open chats' }).textContent).toContain(
      'Conversation unavailable'
    )
  })

  it('shows terminal access failure after an older conversation load succeeds', async () => {
    const chats: Array<[string, string]> = [
      ['agent-a', 'chat-1'],
      ['agent-b', 'chat-2'],
      ['agent-c', 'chat-3'],
      ['agent-a', 'chat-4'],
      ['agent-b', 'chat-5'],
    ]
    const { clerum, live } = await mountProductionApp({
      agentNames: ['agent-a', 'agent-b', 'agent-c'],
      chats,
    })
    await addProductionChatTabs(live, chats)

    const lateOne = makeDeferred<void>(),
      lateTwo = makeDeferred<void>()
    const originalLoad = clerum.rpc.loadSessionMessages.getMockImplementation()!
    const denied = await ipcGenericForbidden('rpc:loadSessionMessages')
    let firstOne = true,
      firstTwo = true
    clerum.rpc.loadSessionMessages.mockClear()
    clerum.rpc.loadSessionMessages.mockImplementation(async (...args) => {
      const chatId = String(args[2])
      if (chatId === 'chat-1' && firstOne) {
        firstOne = false
        await lateOne.promise
      }
      if (chatId === 'chat-2' && firstTwo) {
        firstTwo = false
        await lateTwo.promise
      }
      if (chatId === 'chat-3') throw denied
      return originalLoad(...args)
    })

    for (const chatId of ['chat-1', 'chat-2']) {
      await clickProductionChatTab(live, chatId)
      await waitFor(() =>
        expect(clerum.rpc.loadSessionMessages.mock.calls.some(args => args[2] === chatId)).toBe(
          true
        )
      )
    }
    await clickProductionChatTab(live, 'chat-3')
    await waitFor(() =>
      expect(clerum.rpc.loadSessionMessages.mock.calls.some(args => args[2] === 'chat-3')).toBe(
        true
      )
    )
    await act(async () => {
      lateTwo.resolve()
      lateOne.resolve()
      await Promise.resolve()
    })

    expect(
      live.workspaceTabs.tabs.find(tab => tab.id === live.workspaceTabs.activeTabId)?.chat?.chatId
    ).toBe('chat-3')
    expect(screen.queryByText('Loading conversation…')).toBeNull()
    expect(screen.queryByTestId('chat-page-surface')).toBeNull()
    expect(screen.getByText('Could not verify access. Select this tab to retry.')).toBeTruthy()
  })

  it('ignores a failed old notification open after the user selects another tab', async () => {
    const chats = Array.from(
      { length: 5 },
      (_, index) => ['agent-x', `chat-${index + 1}`] as [string, string]
    )
    const { clerum, live } = await mountProductionApp({ chats })
    await addProductionChatTabs(live, chats)
    await clickProductionChatTab(live, 'chat-5')
    await waitFor(() => expect(live.activeChatId).toBe('chat-5'))
    await waitFor(() => expect(live.chatMessagesLoading).toBe(false))

    const tempRoot = await mkdtemp(join(tmpdir(), 'desktop-chat-selection-'))
    const blockedStorePath = join(tempRoot, 'not-a-directory')
    await writeFile(blockedStorePath, 'fixture file blocks ChatStore directory creation')
    const blockedStore = new ChatStore(blockedStorePath)
    const pendingWrite = makeDeferred<void>()
    let firstA = true
    clerum.chat.setLastActive.mockClear()
    clerum.chat.setLastActive.mockImplementation(async (agentRef, chatId) => {
      if (chatId === 'chat-1' && firstA) {
        firstA = false
        await pendingWrite.promise
        await blockedStore.setLastActiveChatId(agentRef, chatId)
      }
    })
    try {
      let opening!: Promise<void>
      act(() => {
        opening = appHeaderHarness.openNotification!({
          id: 'old-open',
          kind: 'assistant_reply',
          agentName: 'agent-x',
          chatId: 'chat-1',
          text: 'reply',
          timestamp: Date.now(),
          read: false,
        } as AppNotification)
      })
      await waitFor(() =>
        expect(clerum.chat.setLastActive.mock.calls.some(([, chatId]) => chatId === 'chat-1')).toBe(
          true
        )
      )
      await clickProductionChatTab(live, 'chat-2')
      await clickProductionChatTab(live, 'chat-3')
      await waitFor(() => expect(live.activeChatId).toBe('chat-3'))
      await act(async () => {
        pendingWrite.resolve()
        await opening
      })

      expect(live.activeChatId).toBe('chat-3')
      expect(
        live.workspaceTabs.tabs.find(tab => tab.id === live.workspaceTabs.activeTabId)?.chat?.chatId
      ).toBe('chat-3')
      expect(screen.getByTestId('chat-page-surface').getAttribute('data-active-chat-id')).toBe(
        'chat-3'
      )
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('focuses a held chat immediately and keeps it focused through denial and reconciliation', async () => {
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: 'Conversation unavailable' }))

    expect(
      screen
        .getByRole('button', { name: 'Conversation unavailable, checking access' })
        .getAttribute('aria-pressed')
    ).toBe('true')
    expect(
      screen
        .getByRole('button', { name: 'Conversation unavailable, checking access' })
        .getAttribute('aria-busy')
    ).toBe('true')
    expect(
      screen
        .getByRole('button', { name: 'Conversation unavailable, checking access' })
        .getAttribute('title')
    ).toBe('Checking host access to this conversation')
    expect(screen.getByText('Checking access to conversation…')).toBeTruthy()
    expect(screen.queryByTestId('chat-page-surface')).toBeNull()

    // Updating the controller input runs App's production reconciliation effect:
    // it must update A's title without replacing the immediately focused tab.
    act(() => {
      currentController.chatList = [{ ...CHAT_TAB_A, title: 'Renamed A' }, CHAT_TAB_B]
      forceControllerRender()
    })
    expect(currentController.workspaceTabs.tabs.find(tab => tab.id === 'chat-a')?.title).toBe(
      'Renamed A'
    )
    expect(
      screen
        .getByRole('button', { name: 'Conversation unavailable, checking access' })
        .getAttribute('aria-pressed')
    ).toBe('true')
    expect(screen.getByText('Checking access to conversation…')).toBeTruthy()

    await act(async () => verificationChecks[0]!.resolve(false))
    const failedTab = screen.getByRole('button', {
      name: 'Conversation unavailable, access check failed',
    })
    expect(failedTab.getAttribute('aria-pressed')).toBe('true')
    expect(failedTab.getAttribute('title')).toBe('Could not verify host access. Select to retry.')
    expect(screen.getByText('Could not verify access. Select this tab to retry.')).toBeTruthy()
    expect(currentController.handleSelectChatAgent).not.toHaveBeenCalledWith(
      'agent-b',
      expect.anything()
    )

    fireEvent.click(failedTab)
    currentController.chatMessagesLoading = true
    await act(async () => verificationChecks[1]!.resolve(true))

    const loadingTab = screen.getByRole('button', {
      name: 'Conversation B, loading conversation',
    })
    expect(loadingTab.getAttribute('aria-busy')).toBe('true')
    expect(loadingTab.getAttribute('title')).toBe('Loading conversation')
    expect(screen.getByTestId('chat-page-surface').getAttribute('data-active-chat-id')).toBe(
      'chat-b'
    )

    act(() => {
      currentController.chatMessagesLoading = false
      forceControllerRender()
    })
    expect(
      screen.getByRole('button', { name: 'Conversation B' }).getAttribute('aria-pressed')
    ).toBe('true')
    expect(screen.getByTestId('chat-page-surface').getAttribute('data-active-chat-id')).toBe(
      'chat-b'
    )
  })

  it('ignores a late verification after another workspace tab is selected', async () => {
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: 'Conversation unavailable' }))
    fireEvent.click(screen.getByRole('button', { name: 'Conversation A' }))
    await act(async () => verificationChecks[0]!.resolve(true))

    expect(
      screen.getByRole('button', { name: 'Conversation A' }).getAttribute('aria-pressed')
    ).toBe('true')
    expect(screen.getByTestId('chat-page-surface').getAttribute('data-active-chat-id')).toBe(
      'chat-a'
    )
  })

  it('shows an unavailable state when the controller declines a deleted chat tab', async () => {
    const chatA = openChatTab(createWorkspaceTabsState('chat-a', 'agent-a'), {
      id: 'chat-a',
      agentRef: 'agent-a',
      chatId: 'chat-a',
      title: 'Conversation A',
    })
    const chatB = openChatTab(chatA, {
      id: 'chat-b',
      agentRef: 'agent-a',
      chatId: 'chat-b',
      title: 'Conversation B',
    })
    let hostAccessBlocked = true
    const verification = deferredBoolean()
    currentController = makeController({
      workspaceTabs: selectWorkspaceTab(chatB, 'chat-a'),
      // A held Host can clear the selected agent while leaving the displayed
      // conversation id in place. The deleted-chat fence then declines B.
      selectedAgent: null,
      activeChatId: 'chat-a',
      chatList: [CHAT_TAB_A],
      latestChatSessions: [],
      hostAuthorityRevision: 0,
      isChatDeleted: vi.fn(
        (agentRef: string, chatId: string) => agentRef === 'agent-a' && chatId === 'chat-b'
      ),
      isHostAccessBlocked: vi.fn((agentRef: string) => agentRef === 'agent-a' && hostAccessBlocked),
      verifyHostAccess: vi.fn(() =>
        verification.promise.then(verified => {
          if (verified) {
            hostAccessBlocked = false
            currentController.hostAuthorityRevision += 1
          }
          return verified
        })
      ),
    } as Partial<AppController>)

    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Conversation unavailable' }))
    expect(
      screen
        .getByRole('button', { name: 'Conversation unavailable, checking access' })
        .getAttribute('aria-pressed')
    ).toBe('true')

    await act(async () => verification.resolve(true))

    expect(currentController.handleSelectChatAgent).toHaveBeenCalledWith(
      'agent-a',
      expect.objectContaining({ chatId: 'chat-b', selectLatest: false })
    )
    const unavailableTab = screen.getByRole('button', {
      name: 'Conversation B, conversation unavailable',
    })
    expect(unavailableTab.getAttribute('aria-pressed')).toBe('true')
    expect(unavailableTab.getAttribute('aria-busy')).toBeNull()
    expect(unavailableTab.getAttribute('title')).toBe(
      'Conversation unavailable. Close this tab or select to retry.'
    )
    expect(
      screen.getByText(
        'This conversation is no longer available. Close this tab or select it to retry.'
      )
    ).toBeTruthy()
    expect(screen.queryByText('Loading conversation…')).toBeNull()
    expect(screen.queryByTestId('chat-page-surface')).toBeNull()

    act(() => {
      currentController.chatList = [{ ...CHAT_TAB_A, title: 'Renamed A' }]
      forceControllerRender()
    })

    expect(
      screen
        .getByRole('button', { name: 'Conversation B, conversation unavailable' })
        .getAttribute('aria-pressed')
    ).toBe('true')
    expect(
      screen.getByText(
        'This conversation is no longer available. Close this tab or select it to retry.'
      )
    ).toBeTruthy()
    expect(screen.queryByTestId('chat-page-surface')).toBeNull()
  })

  it('does not replay a selected conversation after it is marked deleted', async () => {
    const chatA = openChatTab(createWorkspaceTabsState('chat-a', 'agent-a'), {
      id: 'chat-a',
      agentRef: 'agent-a',
      chatId: 'chat-a',
      title: 'Conversation A',
    })
    const chatB = openChatTab(chatA, {
      id: 'chat-b',
      agentRef: 'agent-a',
      chatId: 'chat-b',
      title: 'Conversation B',
    })
    let deleted = false
    currentController = makeController({
      workspaceTabs: selectWorkspaceTab(chatB, 'chat-a'),
      selectedAgent: 'agent-a',
      activeChatId: 'chat-a',
      chatList: [CHAT_TAB_A, { ...CHAT_TAB_A, id: 'chat-b', title: 'Conversation B' }],
      isChatDeleted: vi.fn(
        (agentRef: string, chatId: string) =>
          deleted && agentRef === 'agent-a' && chatId === 'chat-b'
      ),
    } as Partial<AppController>)
    render(<App />)

    const selectChatAgent = vi.spyOn(currentController, 'handleSelectChatAgent')
    fireEvent.click(screen.getByRole('button', { name: 'Conversation B' }))
    await waitFor(() => expect(currentController.activeChatId).toBe('chat-b'))
    const selectionCallCount = selectChatAgent.mock.calls.length
    expect(currentController.workspaceTabs.activeTabId).toBe('chat-b')

    act(() => {
      deleted = true
      currentController.activeChatId = 'chat-a'
      forceControllerRender()
    })

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Conversation B, conversation unavailable' })
      ).toBeTruthy()
    )
    expect(currentController.workspaceTabs.activeTabId).toBe('chat-b')
    expect(selectChatAgent).toHaveBeenCalledTimes(selectionCallCount)
    expect(
      screen.getByText(
        'This conversation is no longer available. Close this tab or select it to retry.'
      )
    ).toBeTruthy()
    expect(screen.queryByTestId('chat-page-surface')).toBeNull()
  })

  it('keeps a verified same-agent tab selected during chat-list reconciliation', async () => {
    const chatA = openChatTab(createWorkspaceTabsState('chat-a', 'agent-a'), {
      id: 'chat-a',
      agentRef: 'agent-a',
      chatId: 'chat-a',
      title: 'Conversation A',
    })
    const chatB = openChatTab(chatA, {
      id: 'chat-b',
      agentRef: 'agent-a',
      chatId: 'chat-b',
      title: 'Conversation B',
    })
    let hostAccessBlocked = true
    const verification = deferredBoolean()
    currentController = makeController({
      workspaceTabs: selectWorkspaceTab(chatB, 'chat-a'),
      // A held Host clears the selected agent while retaining the displayed chat.
      selectedAgent: null,
      activeChatId: 'chat-a',
      chatList: CHAT_TAB_ACCESS_LIST,
      latestChatSessions: [{ ...CHAT_TAB_B, agentRef: 'agent-a' }],
      hostAuthorityRevision: 0,
      isHostAccessBlocked: vi.fn((agentRef: string) => agentRef === 'agent-a' && hostAccessBlocked),
      verifyHostAccess: vi.fn(() =>
        verification.promise.then(verified => {
          if (verified) {
            hostAccessBlocked = false
            currentController.hostAuthorityRevision += 1
          }
          return verified
        })
      ),
    } as Partial<AppController>)

    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Conversation unavailable' }))
    expect(
      screen
        .getByRole('button', { name: 'Conversation unavailable, checking access' })
        .getAttribute('aria-pressed')
    ).toBe('true')
    expect(screen.queryByTestId('chat-page-surface')).toBeNull()

    await act(async () => verification.resolve(true))

    expect(currentController.handleSelectChatAgent).toHaveBeenCalledWith(
      'agent-a',
      expect.objectContaining({ chatId: 'chat-b', selectLatest: false })
    )
    expect(screen.getByTestId('chat-page-surface').getAttribute('data-active-chat-id')).toBe(
      'chat-b'
    )

    act(() => {
      currentController.chatList = [CHAT_TAB_A, { ...CHAT_TAB_B, title: 'Renamed B' }]
      forceControllerRender()
    })

    expect(currentController.workspaceTabs.tabs.find(tab => tab.id === 'chat-b')?.title).toBe(
      'Renamed B'
    )
    expect(screen.getByRole('button', { name: 'Renamed B' }).getAttribute('aria-pressed')).toBe(
      'true'
    )
    expect(screen.getByTestId('chat-page-surface').getAttribute('data-active-chat-id')).toBe(
      'chat-b'
    )
  })

  it('focuses a held drawer chat immediately and hides the prior conversation until verified', async () => {
    const chatA = openChatTab(createWorkspaceTabsState('chat-a', 'agent-a'), {
      id: 'chat-a',
      agentRef: 'agent-a',
      chatId: 'chat-a',
      title: 'Conversation A',
    })
    const chatB = openChatTab(chatA, {
      id: 'chat-b',
      agentRef: 'agent-b',
      chatId: 'chat-b',
      title: 'Conversation B',
    })
    const settings = openSettingsTab(chatB, { id: 'settings-1', section: 'settings' })
    let hostAccessBlocked = true
    currentController = makeController({
      workspaceTabs: settings,
      selectedAgent: 'agent-a',
      activeChatId: 'chat-a',
      chatList: CHAT_TAB_ACCESS_LIST,
      latestChatSessions: [CHAT_TAB_B_LATEST],
      hostAuthorityRevision: 0,
      isHostAccessBlocked: vi.fn((agentRef: string) => agentRef === 'agent-b' && hostAccessBlocked),
      verifyHostAccess: vi.fn(() =>
        verificationChecks[0]!.promise.then(verified => {
          if (verified) {
            hostAccessBlocked = false
            currentController.hostAuthorityRevision += 1
          }
          return verified
        })
      ),
    } as Partial<AppController>)

    render(<App />)
    act(() => appHeaderHarness.props?.onToggleChatDrawer?.())
    fireEvent.click(screen.getByRole('button', { name: 'Open chats' }))
    fireEvent.click(screen.getByRole('option', { name: 'Conversation unavailable' }))

    expect(currentController.handleSelectChatAgent).not.toHaveBeenCalledWith(
      'agent-b',
      expect.anything()
    )
    expect(screen.getByRole('button', { name: /Open chats/ }).textContent).toContain(
      'Conversation unavailable'
    )
    expect(screen.getByRole('button', { name: /Open chats/ }).getAttribute('aria-busy')).toBe(
      'true'
    )
    expect(screen.getByRole('button', { name: /Open chats/ }).getAttribute('title')).toBe(
      'Checking host access to this conversation'
    )
    expect(screen.getByText('Checking access to conversation…')).toBeTruthy()
    expect(screen.queryByTestId('chat-page-surface')).toBeNull()
    expect(
      screen
        .getByRole('button', { name: 'Conversation unavailable, checking access' })
        .getAttribute('aria-busy')
    ).toBe('true')

    currentController.chatMessagesLoading = true
    await act(async () => verificationChecks[0]!.resolve(true))

    expect(currentController.handleSelectChatAgent).toHaveBeenCalledWith(
      'agent-b',
      expect.objectContaining({ chatId: 'chat-b', keepNavItem: true })
    )
    expect(screen.getByRole('button', { name: /Open chats/ }).getAttribute('aria-busy')).toBe(
      'true'
    )
    expect(screen.getByRole('button', { name: /Open chats/ }).getAttribute('title')).toBe(
      'Loading conversation'
    )
    expect(screen.getByTestId('chat-page-surface').getAttribute('data-active-chat-id')).toBe(
      'chat-b'
    )
  })

  it('clears a stale unavailable drawer selection when a notification opens another chat', async () => {
    const chatA = openChatTab(createWorkspaceTabsState('chat-a', 'agent-a'), {
      id: 'chat-a',
      agentRef: 'agent-a',
      chatId: 'chat-a',
      title: 'First chat',
    })
    const chatB = openChatTab(chatA, {
      id: 'chat-b',
      agentRef: 'agent-b',
      chatId: 'chat-b',
      title: 'Second chat',
    })
    const settings = openSettingsTab(chatB, { id: 'settings-1', section: 'settings' })
    currentController = makeController({
      workspaceTabs: settings,
      selectedAgent: 'agent-a',
      activeChatId: 'chat-a',
      chatList: CHAT_TAB_ACCESS_LIST,
      isHostAccessBlocked: vi.fn((agentRef: string) => agentRef === 'agent-b'),
      verifyHostAccess: vi.fn(async () => false),
    } as Partial<AppController>)
    render(<App />)
    act(() => appHeaderHarness.props?.onToggleChatDrawer?.())
    fireEvent.click(screen.getByRole('button', { name: 'Open chats' }))
    fireEvent.click(screen.getByRole('option', { name: 'Conversation unavailable' }))
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Conversation unavailable, access check failed' })
      ).toBeTruthy()
    )

    await act(async () => {
      await appHeaderHarness.openNotification!({
        id: 'new-chat-open',
        kind: 'assistant_reply',
        agentName: 'agent-a',
        chatId: 'chat-a',
        text: 'reply',
        timestamp: Date.now(),
        read: false,
      } as AppNotification)
    })

    expect(screen.getByRole('button', { name: 'Open chats' }).textContent).toContain(
      'Conversation A'
    )
    expect(screen.getByRole('button', { name: 'Open chats' }).textContent).not.toContain(
      'Conversation unavailable'
    )
  })

  it('clears a stale unavailable drawer selection when chat navigation selects another chat', async () => {
    const chatA = openChatTab(createWorkspaceTabsState('chat-a', 'agent-a'), {
      id: 'chat-a',
      agentRef: 'agent-a',
      chatId: 'chat-a',
      title: 'First chat',
    })
    const chatB = openChatTab(chatA, {
      id: 'chat-b',
      agentRef: 'agent-b',
      chatId: 'chat-b',
      title: 'Second chat',
    })
    const settings = openSettingsTab(chatB, { id: 'settings-1', section: 'settings' })
    currentController = makeController({
      workspaceTabs: settings,
      selectedAgent: 'agent-a',
      activeChatId: 'chat-a',
      chatList: CHAT_TAB_ACCESS_LIST,
      isHostAccessBlocked: vi.fn((agentRef: string) => agentRef === 'agent-b'),
      verifyHostAccess: vi.fn(async () => false),
    } as Partial<AppController>)
    render(<App />)
    act(() => appHeaderHarness.props?.onToggleChatDrawer?.())
    expect(navigationHarness.selectChatAgent).toBeTypeOf('function')
    fireEvent.click(screen.getByRole('button', { name: 'Open chats' }))
    fireEvent.click(screen.getByRole('option', { name: 'Conversation unavailable' }))
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Conversation unavailable, access check failed' })
      ).toBeTruthy()
    )

    act(() => navigationHarness.selectChatAgent?.('agent-a', { chatId: 'chat-a' }))

    await waitFor(() =>
      expect(screen.getByTestId('chat-page-surface').getAttribute('data-active-chat-id')).toBe(
        'chat-a'
      )
    )
    expect(screen.getByRole('button', { name: 'Open chats' }).textContent).toContain(
      'Conversation A'
    )
    expect(screen.getByRole('button', { name: 'Open chats' }).textContent).not.toContain(
      'Conversation unavailable'
    )
  })

  it('clears the stale unavailable selection when creating a new drawer chat', async () => {
    const chatA = openChatTab(createWorkspaceTabsState('chat-a', 'agent-a'), {
      id: 'chat-a',
      agentRef: 'agent-a',
      chatId: 'chat-a',
      title: 'Conversation A',
    })
    const chatB = openChatTab(chatA, {
      id: 'chat-b',
      agentRef: 'agent-b',
      chatId: 'chat-b',
      title: 'Conversation B',
    })
    const settings = openSettingsTab(chatB, { id: 'settings-1', section: 'settings' })
    currentController = makeController({
      workspaceTabs: settings,
      selectedAgent: 'agent-a',
      activeChatId: 'chat-a',
      verifyConversationAccess: vi.fn(async () => null),
    } as Partial<AppController>)
    render(<App />)
    act(() => appHeaderHarness.props?.onToggleChatDrawer?.())
    act(() => {
      currentController.teamContextRevision += 1
      currentController.activeChatId = null
      currentController.selectedAgent = null
      forceControllerRender()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Open chats' }))
    fireEvent.click(screen.getByRole('option', { name: 'Conversation B' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Conversation B, team changed' })).toBeTruthy()
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open chats' }))
    fireEvent.click(screen.getByRole('button', { name: '+ New chat' }))

    expect(screen.getByRole('button', { name: 'Open chats' }).textContent).not.toContain(
      'Conversation B'
    )
    expect(screen.queryByRole('button', { name: 'Conversation B, team changed' })).toBeNull()
    expect(screen.getByTestId('chat-page-surface').getAttribute('data-active-chat-id')).toBe('')
  })
})

describe('App chat drawer — reopen preserves the last-viewed chat', () => {
  let currentController: AppController

  beforeEach(() => {
    vi.clearAllMocks()
    sidebarHarness.props = null
    sandboxUiPageHarness.props = null
    appHeaderHarness.props = null
    appHeaderHarness.openNotification = null
    appHeaderHarness.notifications = []
    appHeaderHarness.unreadNotificationCount = 0
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

  it('closing the displayed drawer chat selects an open neighboring conversation', () => {
    currentController = makeController({
      selectedAgent: 'alpha',
      activeChatId: 'chat-1',
      navItem: DESKTOP_ROUTES.chat,
      chatList: CHAT_LIST,
    } as Partial<AppController>)
    const { rerender } = render(<App />)

    // Open both chats, return to chat-1, then launch the app with its drawer.
    act(() => {
      currentController.activeChatId = 'chat-2'
      rerender(<App />)
    })
    act(() => {
      currentController.activeChatId = 'chat-1'
      rerender(<App />)
    })
    act(() => {
      sidebarHarness.props?.onOpenSandboxUiApp?.({
        appRef: 'ns/app',
        label: 'App',
        defaultPath: '/',
      })
    })

    // A notification or ChatPage session-list action selects chat-2 outside the
    // drawer tab handler, so the controller identity is the only selection hint.
    act(() => {
      currentController.activeChatId = 'chat-2'
      rerender(<App />)
    })
    expect(screen.getByRole('button', { name: 'Open chats' }).textContent).toContain('Second chat')

    fireEvent.click(screen.getByRole('button', { name: 'Close Second chat' }))

    expect(currentController.activeChatId).toBe('chat-1')
    expect(currentController.workspaceTabs.tabs.some(tab => tab.id === 'chat-2')).toBe(false)
    expect(screen.getByRole('button', { name: 'Open chats' }).textContent).toContain('First chat')
    expect(currentController.handleSelectChatAgent).toHaveBeenLastCalledWith(
      'alpha',
      expect.objectContaining({ chatId: 'chat-1', keepNavItem: true })
    )
  })

  it('hides already-delivered notifications after a Host is revoked', () => {
    const notification = {
      id: 'approval-1',
      kind: 'approval_required',
      agentName: 'alpha',
      text: 'Approval required',
      timestamp: 1,
      read: false,
    } as AppNotification
    let hostBlocked = false
    let hostAuthorityRevision = 0
    const isHostAccessBlocked = vi.fn(() => hostBlocked)
    currentController = makeController({
      notifications: [notification],
      isHostAccessBlocked,
      hostAuthorityRevision,
    } as Partial<AppController>)

    const { rerender } = render(<App />)

    expect(appHeaderHarness.notifications).toEqual([notification])
    expect(appHeaderHarness.unreadNotificationCount).toBe(1)

    act(() => {
      hostBlocked = true
      hostAuthorityRevision += 1
      currentController.hostAuthorityRevision = hostAuthorityRevision
      rerender(<App />)
    })

    expect(appHeaderHarness.notifications).toEqual([])
    expect(appHeaderHarness.unreadNotificationCount).toBe(0)
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

// Mini-spec 06 §2 — an app tab is named after the embed's live `document.title`.
// The main process forwards `page-title-updated` over `sandboxUi.onTitleChanged`;
// App renames the LIVE app tab (never a background one), ignoring empty titles so
// the tab keeps its `app.label`. Driven through the real store producer + the real
// WorkspaceTabStrip so the assertion is on the rendered tab label (T4).
describe('App app-tab title — live document.title (mini-spec 06 §2)', () => {
  let currentController: AppController
  let titleChangedCb: ((args: { appRef: string; title: string }) => void) | null

  beforeEach(() => {
    vi.clearAllMocks()
    sidebarHarness.props = null
    sandboxUiPageHarness.props = null
    appHeaderHarness.props = null
    appHeaderHarness.openNotification = null
    titleChangedCb = null
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
          onTitleChanged: vi.fn((cb: (args: { appRef: string; title: string }) => void) => {
            titleChangedCb = cb
            return vi.fn()
          }),
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

  it('renames the live app tab to the embed document.title, and an empty title keeps the label', () => {
    render(<App />)

    // Launch an app: its tab starts named after the registry label ('App').
    act(() => {
      sidebarHarness.props?.onOpenSandboxUiApp?.({
        appRef: 'ns/app',
        label: 'App',
        defaultPath: '/',
      })
    })
    expect(screen.getByRole('button', { name: 'App' })).toBeTruthy()

    // The embed reports its live document.title → the tab renames to it.
    act(() => titleChangedCb?.({ appRef: 'ns/app', title: 'Ticket 42 — Acme' }))
    expect(screen.getByRole('button', { name: 'Ticket 42 — Acme' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'App' })).toBeNull()

    // A subsequent EMPTY title (mid-navigation blank) must not blank the label —
    // the tab keeps the last real title.
    act(() => titleChangedCb?.({ appRef: 'ns/app', title: '   ' }))
    expect(screen.getByRole('button', { name: 'Ticket 42 — Acme' })).toBeTruthy()
  })

  it('ignores a title event whose appRef does not match the live tab', () => {
    render(<App />)
    act(() => {
      sidebarHarness.props?.onOpenSandboxUiApp?.({
        appRef: 'ns/app',
        label: 'App',
        defaultPath: '/',
      })
    })
    // A stale title from a different app must not relabel the live tab.
    act(() => titleChangedCb?.({ appRef: 'ns/other', title: 'Wrong' }))
    expect(screen.getByRole('button', { name: 'App' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Wrong' })).toBeNull()
  })
})

// Mini-spec 06 §3 — files is multi-instance, deduped by path. A plugin deep-link
// (`pluginSdk.onOpenGfsResource`, folder / non-previewable) opens or focuses a
// files tab AT that gfsUri; two distinct gfsUris yield two tabs, re-opening the
// same one focuses it. Driven through the real store producer (openFilesTab);
// asserted on the observable files-tab list (T4).
describe('App files multi-instance — deep-link opens by path (mini-spec 06 §3)', () => {
  let currentController: AppController
  let openGfsResourceCb:
    | ((resource: { kind: string; name: string; gfsUri: string; bytes: number }) => void)
    | null

  beforeEach(() => {
    vi.clearAllMocks()
    sidebarHarness.props = null
    sandboxUiPageHarness.props = null
    appHeaderHarness.props = null
    appHeaderHarness.openNotification = null
    openGfsResourceCb = null
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
        pluginSdk: {
          onOpenGfsResource: vi.fn(
            (
              cb: (resource: { kind: string; name: string; gfsUri: string; bytes: number }) => void
            ) => {
              openGfsResourceCb = cb
              return vi.fn()
            }
          ),
        },
      } as unknown as Window['clerum'],
    })
  })

  afterEach(() => {
    cleanup()
    delete (window as { clerum?: unknown }).clerum
  })

  it('opens two files tabs for two distinct gfsUris and focuses the existing one on re-open', () => {
    render(<App />)
    const filesTabs = () => currentController.workspaceTabs.tabs.filter(t => t.kind === 'files')

    // Two distinct deep-links -> two separate files tabs, in open order.
    act(() =>
      openGfsResourceCb?.({ kind: 'directory', name: 'A', gfsUri: 'gfs://main/aaa', bytes: 0 })
    )
    act(() =>
      openGfsResourceCb?.({ kind: 'directory', name: 'B', gfsUri: 'gfs://main/bbb', bytes: 0 })
    )
    expect(filesTabs().map(t => t.files?.path)).toEqual(['gfs://main/aaa', 'gfs://main/bbb'])
    expect(currentController.navItem).toBe(DESKTOP_ROUTES.files)

    // Re-opening the FIRST gfsUri focuses the existing tab — no third tab.
    const firstId = filesTabs()[0]!.id
    act(() =>
      openGfsResourceCb?.({ kind: 'directory', name: 'A', gfsUri: 'gfs://main/aaa', bytes: 0 })
    )
    expect(filesTabs()).toHaveLength(2)
    expect(currentController.workspaceTabs.activeTabId).toBe(firstId)
  })
})

// R1-H3 — a plugin handing off a PREVIEWABLE non-image file (markdown, video, …)
// must open a PREVIEW tab directly, not a files tab seeded with that URI. The old
// image-mime-only branch sent everything else to openFilesSection, which seeded a
// files tab that immediately re-previewed and unmounted, leaving a tab that
// jumped back to preview whenever selected (a loop). The handoff now runs through
// the shared resolveGfsPreview, the same rule Files/sidebar use. Payloads are
// derived from the real producer (`openGfsResourcePayload`); tabs are asserted on
// the observable store (T4).
describe('App plugin previewable handoff — routes through resolveGfsPreview (R1-H3)', () => {
  let currentController: AppController
  let openGfsResourceCb:
    | ((resource: Awaited<ReturnType<typeof openGfsResourcePayload>>) => void)
    | null

  beforeEach(() => {
    vi.clearAllMocks()
    sidebarHarness.props = null
    sandboxUiPageHarness.props = null
    appHeaderHarness.props = null
    appHeaderHarness.openNotification = null
    openGfsResourceCb = null
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
        pluginSdk: {
          onOpenGfsResource: vi.fn(
            (cb: (resource: Awaited<ReturnType<typeof openGfsResourcePayload>>) => void) => {
              openGfsResourceCb = cb
              return vi.fn()
            }
          ),
        },
      } as unknown as Window['clerum'],
    })
  })

  afterEach(() => {
    cleanup()
    delete (window as { clerum?: unknown }).clerum
  })

  it('opens a preview tab (never a files tab) for a plugin markdown and a plugin video resource', async () => {
    const mdPayload = await openGfsResourcePayload(
      resolvedFile('md1', 'README.md', { gfsUri: 'gfs://main/md1' })
    )
    const videoPayload = await openGfsResourcePayload(
      resolvedFile('vid1', 'demo.mp4', { gfsUri: 'gfs://main/vid1' })
    )
    render(<App />)
    const previewTabs = () => currentController.workspaceTabs.tabs.filter(t => t.kind === 'preview')
    const filesTabs = () => currentController.workspaceTabs.tabs.filter(t => t.kind === 'files')

    act(() => openGfsResourceCb?.(mdPayload))
    act(() => openGfsResourceCb?.(videoPayload))

    // Observable output: one preview tab per file, tagged with its detected kind.
    expect(previewTabs().map(t => ({ uri: t.preview?.gfsUri, kind: t.preview?.fileKind }))).toEqual(
      [
        { uri: 'gfs://main/md1', kind: 'markdown' },
        { uri: 'gfs://main/vid1', kind: 'video' },
      ]
    )
    expect(previewTabs().map(t => t.preview?.resourceVersion)).toEqual([
      mdPayload.version,
      videoPayload.version,
    ])
    // No leftover files tab seeded with a previewable URI — the R1-H3 loop.
    expect(filesTabs()).toHaveLength(0)
    expect(currentController.openFilesSection).not.toHaveBeenCalled()
    expect(currentController.navItem).toBe(DESKTOP_ROUTES.preview)
  })

  it('opens a files tab (never a preview tab) for a plugin folder and a non-previewable file', async () => {
    const folderPayload = await openGfsResourcePayload(
      resolvedFile('dir1', 'Docs', { gfsUri: 'gfs://main/dir1', kind: 'directory' })
    )
    const pdfPayload = await openGfsResourcePayload(
      resolvedFile('doc1', 'report.pdf', { gfsUri: 'gfs://main/doc1' })
    )
    render(<App />)
    const previewTabs = () => currentController.workspaceTabs.tabs.filter(t => t.kind === 'preview')
    const filesTabs = () => currentController.workspaceTabs.tabs.filter(t => t.kind === 'files')

    act(() => openGfsResourceCb?.(folderPayload))
    act(() => openGfsResourceCb?.(pdfPayload))

    expect(filesTabs().map(t => t.files?.path)).toEqual(['gfs://main/dir1', 'gfs://main/doc1'])
    expect(previewTabs()).toHaveLength(0)
    expect(currentController.openPreviewSection).not.toHaveBeenCalled()
    expect(currentController.navItem).toBe(DESKTOP_ROUTES.files)
  })
})

describe('App live GFS preview revalidation', () => {
  let currentController: AppController
  let dispatchEntityChange: ((event: unknown) => void) | null

  beforeEach(() => {
    vi.clearAllMocks()
    dispatchEntityChange = null
    const workspaceTabs = openPreviewTab(createWorkspaceTabsState('chat-tab-1'), {
      id: 'preview-md',
      title: 'README.md',
      gfsUri: 'gfs://main/readme',
      fileKind: 'markdown',
      byteLength: 14,
      resourceVersion: 3,
    })
    currentController = makeController({ workspaceTabs } as Partial<AppController>)
    vi.mocked(useAppController).mockImplementation(() => useReactiveController(currentController))
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        shortcuts: { onCommand: vi.fn(() => vi.fn()) },
        app: { rendererReady: vi.fn().mockResolvedValue(undefined) },
        entityChanges: {
          subscribe: vi.fn((handler: (event: unknown) => void) => {
            dispatchEntityChange = handler
            return Promise.resolve(vi.fn())
          }),
        },
        gfs: { resolve: vi.fn() },
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
    desktopQueryClient.removeQueries({ queryKey: desktopQueryKeys.gfsRoot })
    vi.restoreAllMocks()
    delete (window as { clerum?: unknown }).clerum
  })

  it('keeps the 30-row, two-page, one-preview refresh under the 32-read budget', async () => {
    const rows = Array.from({ length: 30 }, (_, index) => ({
      resourceId: `resource-${index}`,
      rid: `rid-${index}`,
      gfsUri: `gfs://main/resource-${index}`,
      drive: 'main',
      parentResourceId: 'folder',
      name: `row-${index}.md`,
      kind: 'file' as const,
      path: null,
      version: 1,
      bytes: 1,
    }))
    const firstPage = { items: rows.slice(0, 15), nextCursor: 'page-2' }
    const secondPage = { items: rows.slice(15), nextCursor: null }
    const listChildren = vi.fn(async (_id: string, _drive?: string, cursor?: string) =>
      cursor === 'page-2' ? secondPage : firstPage
    )
    const listAccessible = vi.fn(async () => ({ items: [], nextCursor: null }))
    const affordances = vi.fn(async () => ({ held: [] }))
    const resolve = vi.mocked(window.clerum.gfs.resolve).mockResolvedValue(
      resolvedFile('readme', 'README.md', {
        gfsUri: 'gfs://main/readme',
        bytes: 14,
        version: 3,
      }) as never
    )
    Object.assign(window.clerum.gfs, { listChildren, listAccessible, affordances })

    const childrenKey = desktopQueryKeys.gfsChildren('session', 'folder', 'main')
    const accessibleKey = desktopQueryKeys.gfsAccessible('session', 'main')
    desktopQueryClient.setQueryData(childrenKey, {
      pages: [firstPage, secondPage],
      pageParams: [undefined, 'page-2'],
    })
    desktopQueryClient.setQueryData(accessibleKey, { items: [], nextCursor: null })
    rows.forEach(row => {
      desktopQueryClient.setQueryData(
        desktopQueryKeys.gfsAffordances('session', row.resourceId, 'main'),
        { held: [] }
      )
    })

    function ReadBudgetObservers() {
      useQuery({ queryKey: accessibleKey, queryFn: () => window.clerum.gfs.listAccessible('main') })
      useInfiniteQuery({
        queryKey: childrenKey,
        queryFn: ({ pageParam }) => window.clerum.gfs.listChildren('folder', 'main', pageParam),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: page => page.nextCursor ?? undefined,
      })
      useQueries({
        queries: rows.map(row => ({
          queryKey: desktopQueryKeys.gfsAffordances('session', row.resourceId, 'main'),
          queryFn: () => window.clerum.gfs.affordances(row.resourceId, 'main'),
        })),
      })
      return null
    }

    render(
      <QueryClientProvider client={desktopQueryClient}>
        <ReadBudgetObservers />
        <App />
      </QueryClientProvider>
    )
    await waitFor(() => expect(dispatchEntityChange).toBeTypeOf('function'))
    listChildren.mockClear()
    listAccessible.mockClear()
    affordances.mockClear()

    act(() => dispatchEntityChange?.({ ...USER_SCOPE_INVALIDATED }))
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(listChildren).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(listAccessible).toHaveBeenCalledTimes(1))

    const measuredReads =
      resolve.mock.calls.length + listChildren.mock.calls.length + listAccessible.mock.calls.length
    expect(affordances).not.toHaveBeenCalled()
    expect(measuredReads).toBe(4)
    expect(measuredReads).toBeLessThanOrEqual(32)
  })

  it('queues a second invalidation instead of canceling a multi-page refresh', async () => {
    let finishFirstPage!: (page: {
      items: Array<{ name: string }>
      nextCursor: string | null
    }) => void
    let readSequence = 0
    const listChildren = vi.fn((_id: string, _drive?: string, cursor?: string) => {
      readSequence += 1
      if (readSequence === 1) {
        return new Promise(resolve => {
          finishFirstPage = resolve
        })
      }
      return Promise.resolve({
        items: [{ name: `${cursor ? 'second' : 'first'}-latest` }],
        nextCursor: cursor ? null : 'page-2',
      })
    })
    Object.assign(window.clerum.gfs, { listChildren })
    const queryKey = desktopQueryKeys.gfsChildren('session', 'folder', 'main')
    desktopQueryClient.setQueryData(queryKey, {
      pages: [
        { items: [{ name: 'first-old' }], nextCursor: 'page-2' },
        { items: [{ name: 'second-old' }], nextCursor: null },
      ],
      pageParams: [undefined, 'page-2'],
    })

    function FolderRows() {
      const query = useInfiniteQuery({
        queryKey,
        queryFn: ({ pageParam }) => window.clerum.gfs.listChildren('folder', 'main', pageParam),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: page => page.nextCursor ?? undefined,
      })
      return (
        <output data-testid="folder-rows">
          {(query.data?.pages ?? [])
            .flatMap(page => page.items)
            .map(row => row.name)
            .join(',')}
        </output>
      )
    }

    render(
      <QueryClientProvider client={desktopQueryClient}>
        <FolderRows />
        <App />
      </QueryClientProvider>
    )
    await waitFor(() => expect(dispatchEntityChange).toBeTypeOf('function'))

    act(() => dispatchEntityChange?.({ ...USER_SCOPE_INVALIDATED }))
    await waitFor(() => expect(listChildren).toHaveBeenCalledTimes(1))
    act(() => dispatchEntityChange?.({ ...USER_SCOPE_INVALIDATED }))

    // The event may mark this read stale, but it cannot cancel/restart the user's
    // active page-chain read while the authoritative response is still pending.
    expect(listChildren).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('folder-rows').textContent).toBe('first-old,second-old')

    await act(async () => {
      finishFirstPage({ items: [{ name: 'first-latest' }], nextCursor: 'page-2' })
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(screen.getByTestId('folder-rows').textContent).toBe('first-latest,second-latest')
    )
    expect(listChildren).toHaveBeenCalledTimes(4)
  })

  it('hard-resyncs active permission affordances as well as open previews', async () => {
    const affordanceKey = desktopQueryKeys.gfsAffordances('session', 'folder', 'main')
    const affordances = vi.fn(async () => ({ held: ['read'] }))
    Object.assign(window.clerum.gfs, { affordances })
    desktopQueryClient.setQueryData(affordanceKey, { held: [] })
    const resolve = vi.mocked(window.clerum.gfs.resolve).mockResolvedValue(
      resolvedFile('readme', 'README.md', {
        gfsUri: 'gfs://main/readme',
        bytes: 14,
        version: 4,
      }) as never
    )

    function CurrentFolderAffordances() {
      useQuery({
        queryKey: affordanceKey,
        queryFn: () => window.clerum.gfs.affordances('folder', 'main'),
      })
      return null
    }

    render(
      <QueryClientProvider client={desktopQueryClient}>
        <CurrentFolderAffordances />
        <App />
      </QueryClientProvider>
    )
    await waitFor(() => expect(dispatchEntityChange).toBeTypeOf('function'))
    act(() =>
      dispatchEntityChange?.({
        schemaVersion: 1,
        type: 'resync_required',
        cursor: '00000000-0000-0000-0000-000000000000',
        scopes: ['gfs', 'authorization'],
      })
    )

    await waitFor(() => expect(affordances).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(1))
    expect(desktopQueryClient.getQueryData(affordanceKey)).toEqual({ held: ['read'] })
    expect(
      currentController.workspaceTabs.tabs.find(tab => tab.id === 'preview-md')?.preview
    ).toMatchObject({ resourceVersion: 4 })
  })

  it('preserves an unchanged preview during soft scope revalidation and purges only on 403', async () => {
    const resolve = vi.mocked(window.clerum.gfs.resolve)
    const invalidateQueries = vi
      .spyOn(desktopQueryClient, 'invalidateQueries')
      .mockResolvedValue(undefined)
    let finishResolve!: (value: ReturnType<typeof resolvedFile>) => void
    resolve.mockImplementationOnce(
      () =>
        new Promise(resolvePromise => {
          finishResolve = resolvePromise
        }) as never
    )
    render(<App />)
    await waitFor(() => expect(dispatchEntityChange).toBeTypeOf('function'))

    const initial = () => currentController.workspaceTabs.tabs.find(tab => tab.id === 'preview-md')
    const before = initial()
    expect(before?.kind).toBe('preview')
    act(() => dispatchEntityChange?.({ ...USER_SCOPE_INVALIDATED }))
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(1))
    const queryFilter = invalidateQueries.mock.calls.at(-1)?.[0]
    expect(queryFilter?.queryKey).toEqual(desktopQueryKeys.gfsRoot)
    expect(
      queryFilter?.predicate?.({
        queryKey: desktopQueryKeys.gfsAffordances('session', 'resource-id', 'main'),
      } as never)
    ).toBe(false)
    expect(
      queryFilter?.predicate?.({
        queryKey: desktopQueryKeys.gfsChildren('session', 'resource-id', 'main'),
      } as never)
    ).toBe(true)
    expect(initial()).toEqual(before)

    await act(async () => {
      finishResolve(
        resolvedFile('readme', 'README.md', {
          gfsUri: 'gfs://main/readme',
          bytes: 14,
          version: 3,
        })
      )
    })
    expect(initial()).toEqual(before)

    resolve.mockRejectedValueOnce(
      new Error(
        await resolveDeniedMessage(
          'gfs://main/readme',
          { code: 'upstream', message: 'dependency reported 404 while fetching' },
          500
        )
      )
    )
    act(() => dispatchEntityChange?.({ ...USER_SCOPE_INVALIDATED }))
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(2))
    expect(initial()).toEqual(before)

    resolve.mockRejectedValueOnce(new Error(await resolveDeniedMessage('gfs://main/readme')))
    act(() => dispatchEntityChange?.({ ...USER_SCOPE_INVALIDATED }))
    await waitFor(() =>
      expect(initial()?.kind === 'preview' && initial()?.preview?.unavailable).toBe(true)
    )
  })

  it('purges every open GFS preview when the authenticated session expires', async () => {
    currentController.workspaceTabs = openPreviewTab(currentController.workspaceTabs, {
      id: 'preview-image',
      title: 'diagram.png',
      gfsUri: 'gfs://main/diagram',
      fileKind: 'image',
      byteLength: 128,
      mimeType: 'image/png',
      resourceVersion: 7,
    })
    const resolve = vi.mocked(window.clerum.gfs.resolve)
    const expiredSessionMessage = await resolveDeniedMessage(
      'gfs://main/readme',
      { code: 'session_expired', message: 'session expired' },
      401
    )
    resolve.mockImplementation(uri => {
      if (uri === 'gfs://main/readme') {
        return Promise.reject(new Error(expiredSessionMessage)) as never
      }
      return new Promise(() => {}) as never
    })
    render(<App />)
    await waitFor(() => expect(dispatchEntityChange).toBeTypeOf('function'))

    act(() =>
      dispatchEntityChange?.({
        schemaVersion: 1,
        type: 'stream.closing',
        cursor: '00000000-0000-0000-0000-000000000000',
        reason: 'session_expired',
      })
    )

    await waitFor(() => {
      const previews = currentController.workspaceTabs.tabs.filter(tab => tab.kind === 'preview')
      expect(previews).toHaveLength(2)
      expect(previews.every(tab => tab.preview?.unavailable)).toBe(true)
    })
  })

  it('purges every open GFS preview for a status-free session authority failure', async () => {
    currentController.workspaceTabs = openPreviewTab(currentController.workspaceTabs, {
      id: 'preview-image',
      title: 'diagram.png',
      gfsUri: 'gfs://main/diagram',
      fileKind: 'image',
      byteLength: 128,
      mimeType: 'image/png',
      resourceVersion: 7,
    })
    const resolve = vi.mocked(window.clerum.gfs.resolve)
    resolve.mockImplementation(uri => {
      if (uri === 'gfs://main/readme')
        return Promise.reject(new Error('Not authenticated')) as never
      return new Promise(() => {}) as never
    })
    render(<App />)
    await waitFor(() => expect(dispatchEntityChange).toBeTypeOf('function'))

    act(() => dispatchEntityChange?.({ ...USER_SCOPE_INVALIDATED }))

    await waitFor(() => {
      const previews = currentController.workspaceTabs.tabs.filter(tab => tab.kind === 'preview')
      expect(previews).toHaveLength(2)
      expect(previews.every(tab => tab.preview?.unavailable)).toBe(true)
    })
  })

  it('does not retry a preview after its last tab owner closes', async () => {
    const unavailableMessage = await resolveDeniedMessage(
      'gfs://main/readme',
      { code: 'upstream', message: 'upstream unavailable' },
      503
    )
    vi.useFakeTimers()
    const resolve = vi.mocked(window.clerum.gfs.resolve)
    resolve.mockRejectedValue(new Error(unavailableMessage))
    render(<App />)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(dispatchEntityChange).toBeTypeOf('function')

    await act(async () => {
      dispatchEntityChange?.({ ...USER_SCOPE_INVALIDATED })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(resolve).toHaveBeenCalledTimes(1)

    act(() => currentController.setWorkspaceTabs({ tabs: [], activeTabId: null }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })

    expect(resolve).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
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

  // T5 invariant — on a DOM/files tab (no embed to measure) the drawer must dock
  // BELOW the global tab strip, so its right tabs are never hidden behind the
  // drawer. App measures the strip's bottom edge and publishes it as the rail's
  // `--rail-top`; without the fix the rail fell back to the static 64px CSS
  // fallback (which lands mid-strip) and covered the strip's right tabs.
  it('docks the DOM-tab drawer below the measured tab strip, not the 64px fallback (T5)', () => {
    currentController = makeController({
      selectedAgent: 'alpha',
      activeChatId: 'chat-1',
      navItem: DESKTOP_ROUTES.files,
      chatList: CHAT_LIST,
    } as Partial<AppController>)
    const { container } = render(<App />)
    expect(appHeaderHarness.props?.drawerAvailable).toBe(true)

    // jsdom lays nothing out (getBoundingClientRect is all-zero), so give the
    // global tab strip a measurable bottom edge. The rail must anchor to THIS,
    // below the strip, never the static 64px fallback.
    const strip = container.querySelector('.chat-view-tabs') as HTMLElement
    expect(strip).not.toBeNull()
    strip.getBoundingClientRect = () =>
      ({
        bottom: 128,
        top: 40,
        height: 88,
        width: 0,
        left: 0,
        right: 0,
        x: 0,
        y: 40,
        toJSON: () => ({}),
      }) as DOMRect

    act(() => appHeaderHarness.props?.onToggleChatDrawer?.())

    const rail = document.querySelector('.right-rail-shell') as HTMLElement
    expect(rail).not.toBeNull()
    expect(rail.getAttribute('data-occupant')).toBe('chat-drawer')
    // Anchored to the strip's measured bottom (128px), not the mid-strip 64px
    // fallback that would hide the strip's right tabs behind the drawer.
    expect(rail.style.getPropertyValue('--rail-top')).toBe('128px')
  })

  // §1 (mini-spec 06): toggling the drawer over a non-chat tab must not spawn a
  // fresh "New chat" tab each time. The reconcile runs with the app/files tab
  // kept active, so the blank chat is never the active tab — without the reuse
  // fix every toggle appends another blank. Assert the observable strip's blank
  // chat count (T4), not an intermediate effect.
  it('never stacks blank chat tabs when the drawer is toggled over a non-chat tab (§1)', () => {
    currentController = makeController({
      selectedAgent: 'alpha',
      activeChatId: null,
      navItem: DESKTOP_ROUTES.files,
      chatList: CHAT_LIST,
    } as Partial<AppController>)
    render(<App />)

    const blankChatCount = () =>
      currentController.workspaceTabs.tabs.filter(
        t => t.kind === 'chat' && (t.chat?.chatId ?? null) === null
      ).length

    // Boot seeds exactly one blank chat tab; opening files adds none.
    expect(blankChatCount()).toBe(1)

    // Toggle open + closed three times over the files tab, then leave it open.
    for (let i = 0; i < 3; i += 1) {
      act(() => appHeaderHarness.props?.onToggleChatDrawer?.())
      act(() => appHeaderHarness.props?.onToggleChatDrawer?.())
    }
    act(() => appHeaderHarness.props?.onToggleChatDrawer?.())
    expect(appHeaderHarness.props?.chatDrawerOpen).toBe(true)

    // Still exactly one blank chat tab — the toggles never stacked new ones.
    expect(blankChatCount()).toBe(1)
  })

  it('allows a new blank chat after closing the drawer’s final blank tab', async () => {
    const tabs = openFilesTab(createWorkspaceTabsState('blank-chat', 'alpha'), {
      id: 'files-tab',
    })
    currentController = makeController({
      workspaceTabs: tabs,
      selectedAgent: 'alpha',
      activeChatId: null,
    } as Partial<AppController>)
    render(<App />)
    act(() => appHeaderHarness.props?.onToggleChatDrawer?.())

    fireEvent.click(screen.getByRole('button', { name: 'Close New chat' }))
    expect(
      currentController.workspaceTabs.tabs.some(
        tab => tab.kind === 'chat' && tab.chat?.agentRef === 'alpha' && !tab.chat.chatId
      )
    ).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Open chats' }))
    fireEvent.click(screen.getByRole('button', { name: '+ New chat' }))

    expect(currentController.handleSelectChatAgent).toHaveBeenLastCalledWith(
      'alpha',
      expect.objectContaining({ selectLatest: false, keepNavItem: true })
    )
    await waitFor(() =>
      expect(
        currentController.workspaceTabs.tabs.some(
          tab => tab.kind === 'chat' && tab.chat?.agentRef === 'alpha' && !tab.chat.chatId
        )
      ).toBe(true)
    )
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
