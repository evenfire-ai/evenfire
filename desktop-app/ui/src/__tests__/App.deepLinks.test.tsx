// @vitest-environment jsdom
import { useEffect, useReducer } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, waitFor } from '@testing-library/react'
import { DESKTOP_ROUTES, SIDEBAR_COLLAPSED_KEY } from '@constants/navigation'
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
import type { SandboxUiDeepLinkEnvelope } from '@/App.types'
import type { DesktopCommandId } from '../../../src/desktopCommands'

// The universal tab store lives inside the controller; the mock reproduces that
// contract — `navItem` is DERIVED from the store, the store is reactive, and nav
// drives it through the real producers (T1). See App.chatDrawer.test for the
// rationale.
let forceControllerRender: () => void = () => {}
type WorkspaceState = ReturnType<typeof useAppController>['workspaceTabs']

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

const confirmDialogHarness = vi.hoisted(() => ({
  rendered: vi.fn(),
  // Counts how many ConfirmDialogs are actually on screen right now,
  // independently of the overlay signal, so the signal<->dialog invariant can
  // be asserted without reading a stale `props` snapshot after unmount. A count
  // (not a boolean) so a second concurrent dialog's cleanup cannot falsely mark
  // the surface empty while the first is still mounted.
  mountedCount: 0,
  props: null as null | {
    title: string
    onCancel: () => void
    onConfirm: () => void
  },
}))

const appHeaderHarness = vi.hoisted(() => ({
  props: null as null | {
    placement?: 'default' | 'titlebar'
    searchFocusRequestId?: number
    notificationOpenRequestId?: number
  },
}))

const chatLocalSearchHarness = vi.hoisted(() => ({ rendered: vi.fn() }))

const commandPaletteHarness = vi.hoisted(() => ({
  props: null as null | {
    isEligible: (commandId: DesktopCommandId) => boolean
    onClose: () => void
    onExecute: (commandId: DesktopCommandId) => void
  },
}))

type SidebarLaunchApp = { appRef: string; label: string; defaultPath: string; routePath?: string }
const sidebarHarness = vi.hoisted(() => ({
  props: null as null | {
    toggleRequestId?: number
    collapsed?: boolean
    onCollapsedChange?: (next: boolean) => void
    availableSandboxUiApps?: SidebarLaunchApp[]
    onOpenSandboxUiApp?: (app: SidebarLaunchApp) => void
  },
}))

const sandboxUiPageHarness = vi.hoisted(() => ({
  props: null as null | {
    headerShellOverlayOpen?: boolean
    deepLinkShellOverlayOpen?: boolean
    shortcutApp?: {
      appRef: string
      label?: string
      defaultPath?: string
      routePath?: string
    } | null
    shortcutOpenRequestId?: number
    localSearchRequestId?: number
    actionRequest?: {
      id: number
      action: 'refresh' | 'back-to-apps'
    } | null
    onEmbeddedAppOpening?: (app: {
      appRef: string
      label: string
      icon?: string | null
      defaultPath: string
      routePath?: string
    }) => void
    onEmbeddedAppMounted?: () => void
    onEmbeddedAppBack?: () => void
    onEmbeddedAppRemoved?: () => void
    onShortcutOpenResult?: (
      requestId: number,
      result: { status: 'mounted' } | { status: 'failed'; message: string }
    ) => void | Promise<void>
  },
}))

vi.mock('@hooks/useAppController', () => ({
  useAppController: vi.fn(),
}))

vi.mock('@hooks/useAgentChatActionsValue', () => ({
  useAgentChatActionsValue: () => ({}),
}))

vi.mock('@components/AppHeader', () => ({
  AppHeader: (props: NonNullable<typeof appHeaderHarness.props>) => {
    appHeaderHarness.props = props
    return null
  },
}))
vi.mock('@components/ChatLocalSearch', () => ({
  ChatLocalSearch: () => {
    chatLocalSearchHarness.rendered()
    return null
  },
}))
vi.mock('@components/CommandPalette', () => ({
  CommandPalette: (props: NonNullable<typeof commandPaletteHarness.props>) => {
    commandPaletteHarness.props = props
    return <div role="dialog" aria-modal="true" aria-label="Command palette" />
  },
}))
vi.mock('@components/BootSplash', () => ({ BootSplash: () => null }))
vi.mock('@components/Common', () => ({ Button: () => null, ToastStack: () => null }))
vi.mock('@components/ConfirmDialog', () => ({
  ConfirmDialog: (props: { title: string; onCancel: () => void; onConfirm: () => void }) => {
    confirmDialogHarness.rendered(props)
    confirmDialogHarness.props = props
    useEffect(() => {
      confirmDialogHarness.mountedCount += 1
      return () => {
        confirmDialogHarness.mountedCount -= 1
      }
    }, [])
    return null
  },
}))
vi.mock('@components/SidebarNav', () => ({
  SidebarNav: (props: NonNullable<typeof sidebarHarness.props>) => {
    sidebarHarness.props = props
    return null
  },
}))
vi.mock('@pages/AgentsPage', () => ({ AgentsPage: () => null }))
vi.mock('@pages/AuthPage', () => ({ AuthPage: () => null }))
vi.mock('@pages/ChatPage', () => ({ ChatPage: () => null }))
vi.mock('@pages/FilesPage', () => ({ FilesPage: () => null }))
vi.mock('@pages/McpServersPage', () => ({ McpServersPage: () => null }))
vi.mock('@pages/SandboxUiPage', () => ({
  SandboxUiPage: (props: NonNullable<typeof sandboxUiPageHarness.props>) => {
    sandboxUiPageHarness.props = props
    return null
  },
}))
const settingsPageHarness = vi.hoisted(() => ({
  props: null as null | { shortcutsFocusRequestId?: number },
}))
vi.mock('@pages/SettingsPage', () => ({
  SettingsPage: (props: NonNullable<typeof settingsPageHarness.props>) => {
    settingsPageHarness.props = props
    return null
  },
}))
vi.mock('@pages/UnavailablePage', () => ({ UnavailablePage: () => null }))
vi.mock('@pages/WorkflowsPage', () => ({ WorkflowsPage: () => null }))

type AppController = ReturnType<typeof useAppController>

function makeController(overrides: Partial<AppController> = {}): AppController {
  const noop = vi.fn()
  let liveTeamId = String(overrides.currentTeamId || 'team-a')
  let controller: AppController
  let tabSequence = 2
  const nextWorkspaceTabId = vi.fn(() => `ws-tab-${tabSequence++}`)
  const setWorkspaceTabs = vi.fn((updater: unknown) => {
    const next =
      typeof updater === 'function'
        ? (updater as (state: WorkspaceState) => WorkspaceState)(controller.workspaceTabs)
        : (updater as WorkspaceState)
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
    if (controller.appsPickerActive) return
    if (activeWorkspaceTab(controller.workspaceTabs)?.kind === 'app') return
    controller.appsPickerActive = true
    forceControllerRender()
  })
  const ensureTeamContext = vi.fn(async (target: { teamId?: string }): Promise<boolean> => {
    const targetTeamId = String(target.teamId || '').trim()
    if (!targetTeamId || targetTeamId === liveTeamId) return false
    liveTeamId = targetTeamId
    return true
  })
  // Faithful nav: a store action; `navItem` is derived (useReactiveController).
  const handleNavSelect = vi.fn((item: AppController['navItem']) => {
    if (item === DESKTOP_ROUTES.chat) {
      controller.selectedAgent = null
      clearAppsPicker()
      setWorkspaceTabs((state: WorkspaceState) => {
        const active = activeWorkspaceTab(state)
        if (active?.kind === 'chat') return state
        const lastChat = [...state.tabs].reverse().find(tab => tab.kind === 'chat')
        return lastChat
          ? { ...state, activeTabId: lastChat.id }
          : newChatTab(state, nextWorkspaceTabId(), null)
      })
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
  const handleSelectChatAgent = vi.fn(
    (agentName: string, options: { chatId?: string; keepNavItem?: boolean } = {}) => {
      controller.selectedAgent = agentName
      controller.activeChatId = options.chatId ?? null
      if (!options.keepNavItem) {
        clearAppsPicker()
        setWorkspaceTabs((state: WorkspaceState) => {
          const chatId = options.chatId ?? null
          return chatId
            ? openChatTab(state, { id: nextWorkspaceTabId(), agentRef: agentName, chatId })
            : newChatTab(state, nextWorkspaceTabId(), agentName)
        })
      }
      forceControllerRender()
    }
  )
  controller = {
    booting: false,
    initialExperienceLoading: true,
    busy: false,
    statusText: '',
    statusTone: 'info',
    isAuthenticated: true,
    authenticatedPrincipalIdentity: 'user-a:user-a@example.com',
    availableTeamIds: ['team-a', 'team-b'],
    teamDirectoryHydrated: true,
    me: {
      id: 'user-a',
      email: 'user-a@example.com',
      name: 'User A',
      picture: null,
      teamId: 'team-a',
      teamName: 'Team A',
      role: 'member',
    },
    currentTeamId: 'team-a',
    navItem: DESKTOP_ROUTES.chat,
    selectedAgent: null,
    selectedAgentRoute: null,
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
    handleEnsureTeamContext: ensureTeamContext,
    getCurrentTeamId: vi.fn(() => liveTeamId),
    handleSelectChatAgent,
    handleNavSelect,
    handleLogout: vi.fn(),
    pushToast: vi.fn(),
    setStatus: noop,
    setBooting: noop,
    setEmail: noop,
    setPassword: noop,
    setDesktopSetupAuthorizationToken: noop,
    setRuntimeConfigSetupName: noop,
    setRuntimeConfigSetupExternalRestApiBaseUrl: noop,
    setRuntimeConfigSetupRpcProxyBaseUrl: noop,
    setPendingDesktopEnvironmentSetup: noop,
    setDesktopEnvironmentSetupComplete: noop,
    ...overrides,
  } as unknown as AppController
  // `navItem` is derived from the store; translate a starting-route override into
  // the store state that derives to it.
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

describe('App deep-link orchestration', () => {
  let currentController: AppController
  let emitDeepLink: ((link: SandboxUiDeepLinkEnvelope) => void) | null
  let emitCommand: ((commandId: DesktopCommandId, source?: 'host' | 'sandbox') => void) | null
  const clearPendingDeepLinks = vi.fn().mockResolvedValue(undefined)
  const acknowledgeDeepLink = vi.fn().mockResolvedValue(undefined)
  const listApps = vi.fn().mockResolvedValue({ apps: [] })
  const listPendingDeepLinks = vi.fn().mockResolvedValue({ links: [] })
  const closeSandboxUi = vi.fn().mockResolvedValue(undefined)
  // Route-persistence read (mini-spec 05). Defaults to "on the default route"
  // (null) so unrelated launch/deactivation tests behave exactly as before;
  // the persistence tests override the resolved value per case.
  const getSandboxUiLocation = vi.fn().mockResolvedValue(null)

  beforeEach(() => {
    vi.clearAllMocks()
    confirmDialogHarness.props = null
    confirmDialogHarness.mountedCount = 0
    appHeaderHarness.props = null
    chatLocalSearchHarness.rendered.mockReset()
    commandPaletteHarness.props = null
    settingsPageHarness.props = null
    sandboxUiPageHarness.props = null
    sidebarHarness.props = null
    acknowledgeDeepLink.mockResolvedValue(undefined)
    listApps.mockResolvedValue({ apps: [] })
    listPendingDeepLinks.mockResolvedValue({ links: [] })
    closeSandboxUi.mockResolvedValue(undefined)
    getSandboxUiLocation.mockResolvedValue(null)
    emitDeepLink = null
    emitCommand = null
    currentController = makeController()
    vi.mocked(useAppController).mockImplementation(() => useReactiveController(currentController))

    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        shortcuts: {
          onCommand: vi.fn(
            (callback: (commandId: DesktopCommandId, source: 'host' | 'sandbox') => void) => {
              emitCommand = (commandId, source = 'host') => callback(commandId, source)
              return vi.fn()
            }
          ),
        },
        app: {
          rendererReady: vi.fn().mockResolvedValue(undefined),
        },
        sandboxUi: {
          listApps,
          listPendingDeepLinks,
          clearPendingDeepLinks,
          acknowledgeDeepLink,
          close: closeSandboxUi,
          getLocation: getSandboxUiLocation,
          focusActive: vi.fn().mockResolvedValue(true),
          onDeepLink: vi.fn((callback: (link: SandboxUiDeepLinkEnvelope) => void) => {
            emitDeepLink = callback
            return vi.fn()
          }),
        },
      } as unknown as Window['clerum'],
    })
  })

  // With universal-tabs an open app is a `kind:'app'` tab in the global strip, so
  // opening/closing an app no longer auto-collapses or restores the sidebar. The
  // manual toggle and its persistence are the only things that move the sidebar.
  it('does not collapse or restore the sidebar when an app opens and closes', () => {
    window.localStorage.clear()
    currentController = makeController({
      initialExperienceLoading: false,
      navItem: DESKTOP_ROUTES.apps,
    } as Partial<AppController>)
    render(<App />)
    expect(sidebarHarness.props?.collapsed).toBe(false)

    act(() => {
      sandboxUiPageHarness.props?.onEmbeddedAppOpening?.({
        appRef: 'ns/app',
        label: 'App',
        defaultPath: '/',
      })
    })
    // Guard against a vacuous assertion: the app must actually be active for
    // "the sidebar didn't move" to mean anything.
    expect(sandboxUiPageHarness.props?.shortcutApp?.appRef).toBe('ns/app')
    // Opening an app leaves the sidebar exactly as it was, and touches nothing in
    // the saved preference.
    expect(sidebarHarness.props?.collapsed).toBe(false)
    expect(window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY)).toBeNull()

    act(() => sandboxUiPageHarness.props?.onEmbeddedAppBack?.())
    expect(sidebarHarness.props?.collapsed).toBe(false)
  })

  it('keeps the manual sidebar toggle and its persistence intact while an app is open', () => {
    window.localStorage.clear()
    currentController = makeController({
      initialExperienceLoading: false,
      navItem: DESKTOP_ROUTES.apps,
    } as Partial<AppController>)
    render(<App />)

    act(() => {
      sandboxUiPageHarness.props?.onEmbeddedAppOpening?.({
        appRef: 'ns/app',
        label: 'App',
        defaultPath: '/',
      })
    })
    expect(sidebarHarness.props?.collapsed).toBe(false)

    // The user collapses the sidebar manually while the app is open: it collapses
    // and the choice persists.
    act(() => sidebarHarness.props?.onCollapsedChange?.(true))
    expect(sidebarHarness.props?.collapsed).toBe(true)
    expect(window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY)).toBe('1')

    // Expanding again is likewise user-driven and persists.
    act(() => sidebarHarness.props?.onCollapsedChange?.(false))
    expect(sidebarHarness.props?.collapsed).toBe(false)
    expect(window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY)).toBe('0')

    // Closing the app leaves the user's manual state untouched.
    act(() => sandboxUiPageHarness.props?.onEmbeddedAppBack?.())
    expect(sidebarHarness.props?.collapsed).toBe(false)
  })

  it('respects a saved collapsed preference regardless of app open/close', () => {
    window.localStorage.clear()
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, '1')
    currentController = makeController({
      initialExperienceLoading: false,
      navItem: DESKTOP_ROUTES.apps,
    } as Partial<AppController>)
    render(<App />)
    expect(sidebarHarness.props?.collapsed).toBe(true)

    act(() => {
      sandboxUiPageHarness.props?.onEmbeddedAppOpening?.({
        appRef: 'ns/app',
        label: 'App',
        defaultPath: '/',
      })
    })
    // Guard against a vacuous assertion: the app must actually be active here.
    expect(sandboxUiPageHarness.props?.shortcutApp?.appRef).toBe('ns/app')
    expect(sidebarHarness.props?.collapsed).toBe(true)

    act(() => sandboxUiPageHarness.props?.onEmbeddedAppRemoved?.())
    expect(sidebarHarness.props?.collapsed).toBe(true)
  })

  it('uses the shared titlebar header on every authenticated route', () => {
    const routes = Object.values(DESKTOP_ROUTES)

    for (const navItem of routes) {
      currentController = makeController({
        initialExperienceLoading: false,
        navItem,
      } as Partial<AppController>)
      const view = render(<App />)

      expect(appHeaderHarness.props?.placement).toBe('titlebar')

      view.unmount()
    }
  })

  it('runs registered new-tab and composer-focus commands through existing chat selection', () => {
    currentController = makeController({
      initialExperienceLoading: false,
      selectedAgent: 'alpha',
    } as Partial<AppController>)
    render(<App />)

    act(() => emitCommand?.('chat.newTab'))
    expect(currentController.handleSelectChatAgent).toHaveBeenCalledWith('alpha', {
      selectLatest: false,
    })

    act(() => emitCommand?.('composer.focus'))
    expect(currentController.handleSelectChatAgent).toHaveBeenLastCalledWith('alpha', {
      selectLatest: false,
    })
  })

  it('keeps global and contextual search commands on distinct host surfaces', () => {
    currentController = makeController({
      initialExperienceLoading: false,
      selectedAgent: 'alpha',
      activeChatId: 'chat-1',
    } as Partial<AppController>)
    render(<App />)

    act(() => emitCommand?.('search.open'))
    expect(appHeaderHarness.props?.searchFocusRequestId).toBe(1)
    expect(chatLocalSearchHarness.rendered).not.toHaveBeenCalled()

    act(() => emitCommand?.('search.current'))
    expect(chatLocalSearchHarness.rendered).toHaveBeenCalled()
    expect(appHeaderHarness.props?.searchFocusRequestId).toBe(1)
  })

  it('suppresses application commands while plugin consent owns the app surface', () => {
    currentController = makeController({ initialExperienceLoading: false })
    render(<App />)
    const consent = document.createElement('div')
    consent.className = 'da-plugin-consent'
    consent.setAttribute('role', 'dialog')
    document.body.append(consent)

    act(() => emitCommand?.('search.open'))

    expect(appHeaderHarness.props?.searchFocusRequestId).toBe(0)
    consent.remove()
  })

  it('routes contextual search to the current sandbox app without opening global search', () => {
    currentController = makeController({
      initialExperienceLoading: false,
      navItem: DESKTOP_ROUTES.apps,
      selectedAgent: 'alpha',
    } as Partial<AppController>)
    render(<App />)
    act(() => {
      sandboxUiPageHarness.props?.onEmbeddedAppOpening?.({
        appRef: 'ns/app',
        label: 'App',
        defaultPath: '/',
      })
    })

    act(() => emitCommand?.('search.current'))
    expect(sandboxUiPageHarness.props?.localSearchRequestId).toBe(0)
    act(() => sandboxUiPageHarness.props?.onEmbeddedAppMounted?.())
    act(() => emitCommand?.('search.current'))
    expect(sandboxUiPageHarness.props?.localSearchRequestId).toBe(1)
    expect(appHeaderHarness.props?.searchFocusRequestId).toBe(0)

    act(() => {
      sandboxUiPageHarness.props?.onEmbeddedAppOpening?.({
        appRef: 'ns/replacement',
        label: 'Replacement app',
        defaultPath: '/',
      })
      sandboxUiPageHarness.props?.onEmbeddedAppMounted?.()
    })
    act(() => emitCommand?.('search.current'))
    expect(sandboxUiPageHarness.props?.localSearchRequestId).toBe(2)
  })

  it('opens the palette, executes eligible registry actions, and captures the sandbox view', () => {
    currentController = makeController({
      initialExperienceLoading: false,
      navItem: DESKTOP_ROUTES.apps,
      selectedAgent: 'alpha',
    } as Partial<AppController>)
    render(<App />)
    act(() => {
      sandboxUiPageHarness.props?.onEmbeddedAppOpening?.({
        appRef: 'ns/app',
        label: 'App',
        defaultPath: '/',
      })
      emitCommand?.('commands.open', 'sandbox')
    })

    expect(commandPaletteHarness.props).not.toBeNull()
    expect(sandboxUiPageHarness.props?.headerShellOverlayOpen).toBe(true)
    expect(commandPaletteHarness.props?.isEligible('search.current')).toBe(true)

    act(() => commandPaletteHarness.props?.onExecute('search.open'))
    expect(appHeaderHarness.props?.searchFocusRequestId).toBe(1)
    expect(document.querySelector('[aria-label="Command palette"]')).toBeNull()
  })

  it('restores native app focus when a sandbox-opened palette is dismissed', async () => {
    currentController = makeController({
      initialExperienceLoading: false,
      navItem: DESKTOP_ROUTES.apps,
    } as Partial<AppController>)
    render(<App />)
    act(() => emitCommand?.('commands.open', 'sandbox'))
    act(() => commandPaletteHarness.props?.onClose())

    await waitFor(() => expect(window.clerum.sandboxUi.focusActive).toHaveBeenCalledOnce())
  })

  it('opens Settings Shortcuts through the registered palette action', () => {
    currentController = makeController({ initialExperienceLoading: false })
    render(<App />)
    act(() => emitCommand?.('commands.open'))
    act(() => commandPaletteHarness.props?.onExecute('settings.shortcuts'))

    expect(currentController.handleNavSelect).toHaveBeenCalledWith(DESKTOP_ROUTES.settings)
    expect(settingsPageHarness.props?.shortcutsFocusRequestId).toBe(1)
  })

  it('routes approved core palette actions through their existing owners', () => {
    currentController = makeController({ initialExperienceLoading: false })
    render(<App />)
    act(() => emitCommand?.('commands.open'))

    act(() => commandPaletteHarness.props?.onExecute('settings.open'))
    expect(currentController.handleNavSelect).toHaveBeenLastCalledWith(DESKTOP_ROUTES.settings)

    act(() => commandPaletteHarness.props?.onExecute('navigate.chat'))
    expect(currentController.handleNavSelect).toHaveBeenLastCalledWith(DESKTOP_ROUTES.chat)
    act(() => commandPaletteHarness.props?.onExecute('navigate.apps'))
    expect(currentController.handleNavSelect).toHaveBeenLastCalledWith(DESKTOP_ROUTES.apps)
    act(() => commandPaletteHarness.props?.onExecute('navigate.agents'))
    expect(currentController.handleNavSelect).toHaveBeenLastCalledWith(DESKTOP_ROUTES.agents)

    act(() => commandPaletteHarness.props?.onExecute('notifications.open'))
    expect(appHeaderHarness.props?.notificationOpenRequestId).toBe(1)
    act(() => commandPaletteHarness.props?.onExecute('auth.logout'))
    expect(currentController.handleLogout).toHaveBeenCalledOnce()
  })

  it('routes approved contextual palette actions through shell and app owners', () => {
    currentController = makeController({ initialExperienceLoading: false })
    render(<App />)
    act(() => emitCommand?.('commands.open'))

    for (const [commandId, route] of [
      ['navigate.plugins', DESKTOP_ROUTES.plugins],
      ['navigate.connectors', DESKTOP_ROUTES.connectors],
      ['navigate.files', DESKTOP_ROUTES.files],
    ] as const) {
      act(() => commandPaletteHarness.props?.onExecute(commandId))
      expect(currentController.handleNavSelect).toHaveBeenLastCalledWith(route)
    }

    act(() => commandPaletteHarness.props?.onExecute('sidebar.toggle'))
    expect(sidebarHarness.props?.toggleRequestId).toBe(1)

    // `navItem` is derived from the store; the instance-less Apps picker residual
    // puts the shell on the Apps route so the contextual app commands apply.
    act(() => {
      currentController.appsPickerActive = true
      forceControllerRender()
    })
    act(() => emitCommand?.('commands.open'))
    act(() => {
      sandboxUiPageHarness.props?.onEmbeddedAppOpening?.({
        appRef: 'ns/app',
        label: 'App',
        defaultPath: '/',
      })
    })
    expect(commandPaletteHarness.props?.isEligible('app.refresh')).toBe(false)
    act(() => sandboxUiPageHarness.props?.onEmbeddedAppMounted?.())
    expect(commandPaletteHarness.props?.isEligible('app.refresh')).toBe(true)
    act(() => commandPaletteHarness.props?.onExecute('app.refresh'))
    expect(sandboxUiPageHarness.props?.actionRequest).toEqual({ id: 1, action: 'refresh' })
    act(() => commandPaletteHarness.props?.onExecute('app.backToApps'))
    expect(sandboxUiPageHarness.props?.actionRequest).toEqual({ id: 2, action: 'back-to-apps' })
  })

  it('resets controlled command requests with the authenticated shell lifetime', async () => {
    currentController = makeController({ initialExperienceLoading: false })
    const { rerender } = render(<App />)

    act(() => emitCommand?.('commands.open'))
    act(() => commandPaletteHarness.props?.onExecute('notifications.open'))
    act(() => commandPaletteHarness.props?.onExecute('sidebar.toggle'))

    expect(appHeaderHarness.props?.notificationOpenRequestId).toBe(1)
    expect(sidebarHarness.props?.toggleRequestId).toBe(1)

    currentController = makeController({
      initialExperienceLoading: false,
      authenticatedPrincipalIdentity: 'user-b:user-b@example.com',
      navItem: DESKTOP_ROUTES.apps,
    })
    rerender(<App />)

    await waitFor(() => {
      expect(appHeaderHarness.props?.notificationOpenRequestId).toBe(0)
      expect(sidebarHarness.props?.toggleRequestId).toBe(0)
      expect(sandboxUiPageHarness.props?.actionRequest).toBeNull()
      expect(commandPaletteHarness.props?.isEligible('app.refresh')).toBe(false)
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function reportShortcutOpenResult(
    result: { status: 'mounted' } | { status: 'failed'; message: string } = {
      status: 'mounted',
    }
  ): Promise<void> {
    await waitFor(() => {
      expect(sandboxUiPageHarness.props?.shortcutOpenRequestId).toBeGreaterThan(0)
    })
    const props = sandboxUiPageHarness.props
    if (!props?.shortcutOpenRequestId) throw new Error('Sandbox UI shortcut was not requested')
    await act(async () => {
      await props.onShortcutOpenResult?.(props.shortcutOpenRequestId, result)
      await Promise.resolve()
    })
  }

  async function confirmPendingAppLink(): Promise<void> {
    await waitFor(() => expect(confirmDialogHarness.props?.title).toBe('Open app link?'))
    await act(async () => {
      confirmDialogHarness.props?.onConfirm()
      await Promise.resolve()
    })
  }

  it('keeps logged-out app links pending until the user confirms after login', async () => {
    currentController = makeController({
      initialExperienceLoading: false,
      isAuthenticated: false,
      authenticatedPrincipalIdentity: null,
      me: null,
      currentTeamId: '',
    } as unknown as Partial<AppController>)
    listApps.mockResolvedValue({
      apps: [
        {
          appRef: 'ns/app',
          title: 'Linked App',
          defaultPath: '/',
          ready: true,
          phase: 'active',
        },
      ],
    })
    const { rerender } = render(<App />)
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/app' })
    })

    await act(async () => {
      await Promise.resolve()
    })
    expect(confirmDialogHarness.props).toBeNull()
    expect(currentController.handleNavSelect).not.toHaveBeenCalledWith(DESKTOP_ROUTES.apps)
    expect(acknowledgeDeepLink).not.toHaveBeenCalled()

    currentController = makeController({ initialExperienceLoading: false })
    rerender(<App />)

    await waitFor(() => expect(confirmDialogHarness.props?.title).toBe('Open app link?'))
    expect(currentController.handleNavSelect).not.toHaveBeenCalledWith(DESKTOP_ROUTES.apps)
    expect(acknowledgeDeepLink).not.toHaveBeenCalled()

    await act(async () => {
      confirmDialogHarness.props?.onConfirm()
      await Promise.resolve()
    })
    await reportShortcutOpenResult()

    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(1))
  })

  it('requires confirmation before navigating an authenticated app link', async () => {
    currentController = makeController({ initialExperienceLoading: false })
    listApps.mockResolvedValue({
      apps: [
        {
          appRef: 'ns/app',
          title: 'Linked App',
          defaultPath: '/',
          ready: true,
          phase: 'active',
        },
      ],
    })
    render(<App />)
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/app' })
    })

    await waitFor(() => expect(confirmDialogHarness.props?.title).toBe('Open app link?'))
    expect(currentController.handleNavSelect).not.toHaveBeenCalledWith(DESKTOP_ROUTES.apps)
    expect(acknowledgeDeepLink).not.toHaveBeenCalled()

    await confirmPendingAppLink()
    await reportShortcutOpenResult()

    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(1))
    // The launch drives the store (an app tab), so `navItem` derives to the Apps
    // route — the observable, not the retired `handleNavSelect(apps)` call.
    expect(currentController.navItem).toBe(DESKTOP_ROUTES.apps)
  })

  it('acknowledges an authenticated app link when confirmation is cancelled', async () => {
    currentController = makeController({ initialExperienceLoading: false })
    render(<App />)
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/app' })
    })

    await waitFor(() => expect(confirmDialogHarness.props?.title).toBe('Open app link?'))
    await act(async () => {
      confirmDialogHarness.props?.onCancel()
      await Promise.resolve()
    })

    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(1))
    expect(currentController.handleNavSelect).not.toHaveBeenCalledWith(DESKTOP_ROUTES.apps)
    expect(sandboxUiPageHarness.props?.shortcutOpenRequestId).toBeUndefined()
  })

  it('signals a deep-link overlay to the sandbox page while the confirm dialog is open', async () => {
    currentController = makeController({
      initialExperienceLoading: false,
      navItem: DESKTOP_ROUTES.apps,
    })
    listApps.mockResolvedValue({
      apps: [
        {
          appRef: 'ns/app',
          title: 'Linked App',
          defaultPath: '/',
          ready: true,
          phase: 'active',
        },
      ],
    })
    render(<App />)
    await waitFor(() => expect(sandboxUiPageHarness.props).not.toBeNull())
    // The native WebContentsView paints above renderer DOM, so the overlay
    // signal must stay off until a deep-link dialog actually needs to show.
    expect(sandboxUiPageHarness.props?.deepLinkShellOverlayOpen).toBe(false)
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/app' })
    })

    await waitFor(() => expect(confirmDialogHarness.props?.title).toBe('Open app link?'))
    expect(sandboxUiPageHarness.props?.deepLinkShellOverlayOpen).toBe(true)

    await confirmPendingAppLink()
    await reportShortcutOpenResult()
    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(1))
    await waitFor(() => expect(sandboxUiPageHarness.props?.deepLinkShellOverlayOpen).toBe(false))
  })

  it('keeps the deep-link overlay signal raised while the failure dialog is open', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const ensureTeamContext = vi.fn(async () => {
      throw Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' })
    })
    currentController = makeController({
      initialExperienceLoading: false,
      navItem: DESKTOP_ROUTES.apps,
      handleEnsureTeamContext: ensureTeamContext,
    })
    render(<App />)
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/app', teamId: 'team-b' })
    })
    await confirmPendingAppLink()

    for (const delay of [1_000, 2_000, 4_000, 8_000, 15_000]) {
      await act(async () => {
        vi.advanceTimersByTime(delay)
        await Promise.resolve()
      })
    }

    await waitFor(() =>
      expect(confirmDialogHarness.props?.title).toBe('App link could not be opened')
    )
    expect(sandboxUiPageHarness.props?.deepLinkShellOverlayOpen).toBe(true)

    await act(async () => {
      confirmDialogHarness.props?.onCancel()
      await Promise.resolve()
    })

    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(1))
    await waitFor(() => expect(sandboxUiPageHarness.props?.deepLinkShellOverlayOpen).toBe(false))
  })

  it('drops the overlay signal in lockstep with the dialog when Retry is chosen', async () => {
    // T5: the deep-link overlay signal and the dialog derive from one App-level
    // expression, so this pins that Retry (the failure dialog's onConfirm ->
    // handleRetryFailedSandboxUiDeepLink) never leaves the embed hidden with a
    // dialog still owning the screen, nor a dialog on screen with the embed
    // shown. The invariant asserted: a mounted deep-link dialog implies the
    // signal is raised, and once the signal drops no deep-link dialog is
    // mounted. Retry is distinct from Dismiss here — it must not acknowledge
    // the link, it re-drives the open.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const ensureTeamContext = vi.fn(async () => {
      throw Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' })
    })
    currentController = makeController({
      initialExperienceLoading: false,
      navItem: DESKTOP_ROUTES.apps,
      handleEnsureTeamContext: ensureTeamContext,
    })
    render(<App />)
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/app', teamId: 'team-b' })
    })
    await confirmPendingAppLink()

    for (const delay of [1_000, 2_000, 4_000, 8_000, 15_000]) {
      await act(async () => {
        vi.advanceTimersByTime(delay)
        await Promise.resolve()
      })
    }

    // Failure dialog is up: a mounted deep-link dialog must keep the signal
    // raised so the native WebContentsView does not paint over it.
    await waitFor(() =>
      expect(confirmDialogHarness.props?.title).toBe('App link could not be opened')
    )
    expect(confirmDialogHarness.mountedCount).toBeGreaterThan(0)
    expect(sandboxUiPageHarness.props?.deepLinkShellOverlayOpen).toBe(true)

    const ensureCallsBeforeRetry = ensureTeamContext.mock.calls.length

    // Retry — the failure dialog's onConfirm, not onCancel.
    await act(async () => {
      confirmDialogHarness.props?.onConfirm()
      await Promise.resolve()
    })

    // Retry clears the failure and re-drives the open in the same commit the
    // predicates go null, so the dialog unmounts as the signal drops. The
    // dialog value and the overlay signal are a single derived expression, so
    // they move in lockstep by construction. The assertions below check the
    // settled final state (dialog unmounted, signal false), not each render
    // frame. Retry never acknowledges (that is Dismiss).
    await waitFor(() => expect(sandboxUiPageHarness.props?.deepLinkShellOverlayOpen).toBe(false))
    expect(confirmDialogHarness.mountedCount).toBe(0)
    expect(acknowledgeDeepLink).not.toHaveBeenCalled()
    // The retry actually re-attempted the open (handleRetryFailedSandboxUiDeepLink
    // ran), rather than just tearing the dialog down.
    expect(ensureTeamContext.mock.calls.length).toBeGreaterThan(ensureCallsBeforeRetry)
  })

  it('does not duplicate an authenticated confirmation for the same link id', async () => {
    currentController = makeController({ initialExperienceLoading: false })
    listApps.mockResolvedValue({
      apps: [
        {
          appRef: 'ns/app',
          title: 'Linked App',
          defaultPath: '/',
          ready: true,
          phase: 'active',
        },
      ],
    })
    render(<App />)
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/app' })
      emitDeepLink?.({ id: 1, appRef: 'ns/app' })
    })

    await confirmPendingAppLink()
    await reportShortcutOpenResult()

    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(1))
    expect(acknowledgeDeepLink).toHaveBeenCalledTimes(1)
    // Launched exactly once — the store put the shell on the Apps route (the
    // observable that replaced the retired single `handleNavSelect(apps)` call).
    expect(currentController.navItem).toBe(DESKTOP_ROUTES.apps)
  })

  it('never presents a user A link after user B becomes authenticated', async () => {
    const { rerender } = render(<App />)
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/user-a-app', teamId: 'team-a' })
    })
    await waitFor(() => expect(confirmDialogHarness.props?.title).toBe('Open app link?'))
    confirmDialogHarness.rendered.mockClear()

    currentController = makeController({
      initialExperienceLoading: false,
      authenticatedPrincipalIdentity: 'user-b:user-b@example.com',
      me: {
        id: 'user-b',
        email: 'user-b@example.com',
        name: 'User B',
        picture: null,
        teamId: 'team-b',
        teamName: 'Team B',
        role: 'member',
      },
      currentTeamId: 'team-b',
    })
    rerender(<App />)

    expect(confirmDialogHarness.rendered).not.toHaveBeenCalled()
    await waitFor(() => expect(clearPendingDeepLinks).toHaveBeenCalledOnce())
    expect(currentController.handleEnsureTeamContext).not.toHaveBeenCalled()
    expect(acknowledgeDeepLink).not.toHaveBeenCalled()

    act(() => {
      emitDeepLink?.({ id: 2, appRef: 'ns/user-b-app', teamId: 'team-b' })
    })
    await waitFor(() => expect(confirmDialogHarness.rendered).toHaveBeenCalledOnce())
    expect(confirmDialogHarness.props?.title).toBe('Open app link?')
    expect(currentController.handleNavSelect).not.toHaveBeenCalledWith(DESKTOP_ROUTES.apps)
    expect(acknowledgeDeepLink).not.toHaveBeenCalled()
  })

  it('drops a stale cold-list response after the authenticated identity changes', async () => {
    let resolveColdList!: (value: { links: SandboxUiDeepLinkEnvelope[] }) => void
    listPendingDeepLinks.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveColdList = resolve
        })
    )
    const { rerender } = render(<App />)

    currentController = makeController({
      initialExperienceLoading: false,
      authenticatedPrincipalIdentity: 'user-b:user-b@example.com',
      me: {
        id: 'user-b',
        email: 'user-b@example.com',
        name: 'User B',
        picture: null,
        teamId: 'team-b',
        teamName: 'Team B',
        role: 'member',
      },
      currentTeamId: 'team-b',
    })
    rerender(<App />)
    await waitFor(() => expect(clearPendingDeepLinks).toHaveBeenCalledOnce())

    await act(async () => {
      resolveColdList({ links: [{ id: 1, appRef: 'ns/app', teamId: 'team-a' }] })
      await Promise.resolve()
    })

    expect(currentController.handleEnsureTeamContext).not.toHaveBeenCalled()
    expect(acknowledgeDeepLink).not.toHaveBeenCalled()
  })

  it('restores the previous team when the linked app is unavailable', async () => {
    currentController = makeController({ initialExperienceLoading: false })
    render(<App />)
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/missing', teamId: 'team-b' })
    })
    await confirmPendingAppLink()

    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(1))
    expect(currentController.handleEnsureTeamContext).toHaveBeenNthCalledWith(1, {
      teamId: 'team-b',
      announce: true,
    })
    expect(currentController.handleEnsureTeamContext).toHaveBeenNthCalledWith(2, {
      teamId: 'team-a',
      announce: true,
    })
    expect(currentController.pushToast).toHaveBeenCalledWith(
      expect.stringContaining("You don't have access"),
      'error'
    )
  })

  // Guard for conversationOrigin use (3): retiring back-to-conversation must not
  // touch the deep-link team restore, which re-selects the originating chat after
  // rolling a failed cross-team link back to the original team. Passes before and
  // after the retirement.
  it('re-selects the originating chat when a failed cross-team link rolls the team back', async () => {
    currentController = makeController({
      initialExperienceLoading: false,
      navItem: DESKTOP_ROUTES.chat,
      selectedAgent: 'alpha',
      activeChatId: 'chat-1',
    } as Partial<AppController>)
    render(<App />)
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/missing', teamId: 'team-b' })
    })
    await confirmPendingAppLink()

    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(1))
    // Team rolled back to the original, then the origin chat re-selected.
    expect(currentController.handleEnsureTeamContext).toHaveBeenNthCalledWith(2, {
      teamId: 'team-a',
      announce: true,
    })
    expect(currentController.handleSelectChatAgent).toHaveBeenCalledWith('alpha', {
      selectLatest: false,
      chatId: 'chat-1',
      title: 'Conversation',
    })
  })

  it('closes the active embed before switching teams for a failed cross-team handoff', async () => {
    const ensureTeamContext = vi.fn(async (): Promise<boolean> => true)
    currentController = makeController({
      initialExperienceLoading: false,
      navItem: DESKTOP_ROUTES.apps,
      handleEnsureTeamContext: ensureTeamContext,
    })
    render(<App />)
    await waitFor(() => expect(sandboxUiPageHarness.props).not.toBeNull())

    act(() => {
      sandboxUiPageHarness.props?.onEmbeddedAppOpening?.({
        appRef: 'ns/current',
        label: 'Current App',
        defaultPath: '/',
      })
    })
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/missing', teamId: 'team-b' })
    })
    await confirmPendingAppLink()

    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(1))
    expect(closeSandboxUi).toHaveBeenCalledOnce()
    expect(closeSandboxUi.mock.invocationCallOrder[0]).toBeLessThan(
      ensureTeamContext.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    )
  })

  it('lets the server authorize a linked team even when the local directory is empty', async () => {
    currentController = makeController({
      initialExperienceLoading: false,
      availableTeamIds: [],
      teamDirectoryHydrated: false,
    })
    listApps.mockResolvedValue({
      apps: [
        {
          appRef: 'ns/app',
          title: 'App',
          defaultPath: '/',
          ready: true,
          phase: 'active',
          updatedAt: null,
        },
      ],
    })
    render(<App />)
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/app', teamId: 'team-b' })
    })
    await confirmPendingAppLink()

    await reportShortcutOpenResult()
    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(1))
    expect(currentController.handleEnsureTeamContext).toHaveBeenCalledWith({
      teamId: 'team-b',
      announce: true,
    })
    expect(currentController.pushToast).not.toHaveBeenCalledWith(
      "Could not open app link: You don't have access to this app in the linked team",
      'error'
    )
  })

  it('does not roll back a team the user selected while a linked app was loading', async () => {
    let liveTeamId = 'team-a'
    const ensureTeamContext = vi.fn(async ({ teamId }: { teamId?: string }) => {
      if (!teamId || teamId === liveTeamId) return false
      liveTeamId = teamId
      return true
    })
    let resolveApps!: (value: { apps: [] }) => void
    listApps.mockResolvedValueOnce({ apps: [] }).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveApps = resolve
        })
    )
    currentController = makeController({
      initialExperienceLoading: false,
      handleEnsureTeamContext: ensureTeamContext,
      getCurrentTeamId: () => liveTeamId,
    })
    render(<App />)
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/missing', teamId: 'team-b' })
    })
    await confirmPendingAppLink()
    await waitFor(() => expect(ensureTeamContext).toHaveBeenCalledTimes(1))
    liveTeamId = 'team-c'
    await act(async () => {
      resolveApps({ apps: [] })
    })
    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(1))

    expect(ensureTeamContext).toHaveBeenCalledTimes(1)
    expect(liveTeamId).toBe('team-c')
  })

  it('contains a synchronously throwing acknowledgement bridge', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    currentController = makeController({ initialExperienceLoading: false })
    listApps.mockResolvedValue({
      apps: [
        {
          appRef: 'ns/app',
          title: 'App',
          defaultPath: '/',
          ready: true,
          phase: 'active',
        },
      ],
    })
    acknowledgeDeepLink.mockImplementationOnce(() => {
      throw new Error('bridge unavailable')
    })
    render(<App />)
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/app' })
    })
    await confirmPendingAppLink()

    await reportShortcutOpenResult()
    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(1))
    expect(currentController.pushToast).not.toHaveBeenCalledWith(
      expect.stringContaining('bridge unavailable'),
      'error'
    )
    expect(consoleWarn).toHaveBeenCalledWith(
      '[Desktop] Could not acknowledge app deep link:',
      expect.objectContaining({ message: 'bridge unavailable' })
    )
    consoleWarn.mockRestore()
  })

  it('acks a ready app link only after the native mount succeeds', async () => {
    currentController = makeController({ initialExperienceLoading: false })
    listApps.mockResolvedValue({
      apps: [
        {
          appRef: 'ns/app',
          title: 'Linked App',
          defaultPath: '/',
          ready: true,
          phase: 'active',
        },
      ],
    })
    render(<App />)
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/app' })
    })
    await confirmPendingAppLink()

    await waitFor(() => {
      expect(sandboxUiPageHarness.props?.shortcutOpenRequestId).toBeGreaterThan(0)
    })
    expect(acknowledgeDeepLink).not.toHaveBeenCalled()

    await reportShortcutOpenResult()

    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(1))
  })

  it('retries a starting app link and opens it when the app becomes ready', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    currentController = makeController({ initialExperienceLoading: false })
    let ready = false
    listApps.mockImplementation(async () => ({
      apps: [
        {
          appRef: 'ns/app',
          title: 'Linked App',
          defaultPath: '/',
          ready,
          phase: ready ? 'active' : 'deploying',
        },
      ],
    }))
    render(<App />)
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/app' })
    })
    await confirmPendingAppLink()

    await waitFor(() => {
      expect(currentController.pushToast).toHaveBeenCalledWith(
        'Linked App is still starting up. This link will retry shortly.',
        'info'
      )
    })
    expect(acknowledgeDeepLink).not.toHaveBeenCalled()

    ready = true
    await act(async () => {
      vi.advanceTimersByTime(1_000)
      await Promise.resolve()
    })
    await reportShortcutOpenResult()

    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(1))
  })

  it('keeps the target team during cross-team starting app retries', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let liveTeamId = 'team-a'
    const ensureTeamContext = vi.fn(async ({ teamId }: { teamId?: string }) => {
      if (!teamId || teamId === liveTeamId) return false
      liveTeamId = teamId
      return true
    })
    currentController = makeController({
      initialExperienceLoading: false,
      handleEnsureTeamContext: ensureTeamContext,
      getCurrentTeamId: () => liveTeamId,
    })
    let ready = false
    listApps.mockImplementation(async () => ({
      apps: [
        {
          appRef: 'ns/app',
          title: 'Linked App',
          defaultPath: '/',
          ready,
          phase: ready ? 'active' : 'deploying',
        },
      ],
    }))
    render(<App />)
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/app', teamId: 'team-b' })
    })
    await confirmPendingAppLink()

    await waitFor(() => {
      expect(currentController.pushToast).toHaveBeenCalledWith(
        'Linked App is still starting up. This link will retry shortly.',
        'info'
      )
    })
    expect(liveTeamId).toBe('team-b')
    expect(ensureTeamContext).toHaveBeenCalledTimes(1)
    expect(ensureTeamContext).toHaveBeenCalledWith({
      teamId: 'team-b',
      announce: true,
    })

    await act(async () => {
      vi.advanceTimersByTime(1_000)
      await Promise.resolve()
    })
    await waitFor(() => expect(currentController.pushToast).toHaveBeenCalledTimes(2))
    expect(liveTeamId).toBe('team-b')
    expect(ensureTeamContext).toHaveBeenCalledTimes(1)

    ready = true
    await act(async () => {
      vi.advanceTimersByTime(2_000)
      await Promise.resolve()
    })
    await reportShortcutOpenResult()

    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(1))
    expect(liveTeamId).toBe('team-b')
    expect(ensureTeamContext).toHaveBeenCalledTimes(1)
  })

  it('retries a failed cross-team native mount without treating its own restore as a user switch', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let liveTeamId = 'team-a'
    const ensureTeamContext = vi.fn(async ({ teamId }: { teamId?: string }) => {
      if (!teamId || teamId === liveTeamId) return false
      liveTeamId = teamId
      return true
    })
    currentController = makeController({
      initialExperienceLoading: false,
      handleEnsureTeamContext: ensureTeamContext,
      getCurrentTeamId: () => liveTeamId,
    })
    listApps.mockResolvedValue({
      apps: [
        {
          appRef: 'ns/app',
          title: 'Linked App',
          defaultPath: '/',
          ready: true,
          phase: 'active',
        },
      ],
    })
    render(<App />)
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/app', teamId: 'team-b' })
    })
    await confirmPendingAppLink()
    await reportShortcutOpenResult({ status: 'failed', message: 'native mount failed' })

    await waitFor(() => {
      expect(currentController.pushToast).toHaveBeenCalledWith('native mount failed', 'error')
    })
    expect(liveTeamId).toBe('team-b')
    expect(acknowledgeDeepLink).not.toHaveBeenCalled()

    await act(async () => {
      vi.advanceTimersByTime(1_000)
      await Promise.resolve()
    })
    await reportShortcutOpenResult()

    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(1))
    expect(acknowledgeDeepLink).toHaveBeenCalledTimes(1)
    expect(liveTeamId).toBe('team-b')
    expect(ensureTeamContext).toHaveBeenCalledTimes(1)
    expect(currentController.pushToast).not.toHaveBeenCalledWith(
      expect.stringContaining('you switched teams'),
      'error'
    )
  })

  it('does not override a manual team switch during a failed cross-team native-mount retry', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let liveTeamId = 'team-a'
    const ensureTeamContext = vi.fn(async ({ teamId }: { teamId?: string }) => {
      if (!teamId || teamId === liveTeamId) return false
      liveTeamId = teamId
      return true
    })
    currentController = makeController({
      initialExperienceLoading: false,
      handleEnsureTeamContext: ensureTeamContext,
      getCurrentTeamId: () => liveTeamId,
    })
    listApps.mockResolvedValue({
      apps: [
        {
          appRef: 'ns/app',
          title: 'Linked App',
          defaultPath: '/',
          ready: true,
          phase: 'active',
        },
      ],
    })
    render(<App />)
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/app', teamId: 'team-b' })
    })
    await confirmPendingAppLink()
    await reportShortcutOpenResult({ status: 'failed', message: 'native mount failed' })

    await waitFor(() => {
      expect(currentController.pushToast).toHaveBeenCalledWith('native mount failed', 'error')
    })
    expect(liveTeamId).toBe('team-b')
    expect(ensureTeamContext).toHaveBeenCalledTimes(1)

    liveTeamId = 'team-c'
    await act(async () => {
      vi.advanceTimersByTime(1_000)
      await Promise.resolve()
    })

    await waitFor(() => expect(currentController.pushToast).toHaveBeenCalledTimes(2))
    const nativeMountFailures = vi
      .mocked(currentController.pushToast)
      .mock.calls.filter(([message, tone]) => message === 'native mount failed' && tone === 'error')
    expect(nativeMountFailures).toHaveLength(1)
    expect(currentController.pushToast).toHaveBeenCalledWith(
      expect.stringContaining('you switched teams'),
      'error'
    )
    expect(confirmDialogHarness.props?.title).toBe('App link could not be opened')
    expect(liveTeamId).toBe('team-c')
    expect(ensureTeamContext).toHaveBeenCalledTimes(1)
    // The launch put the shell on the Apps route via the store (observable that
    // replaced the retired single `handleNavSelect(apps)` call).
    expect(currentController.navItem).toBe(DESKTOP_ROUTES.apps)
    expect(sandboxUiPageHarness.props?.shortcutOpenRequestId).toBe(1)
    expect(acknowledgeDeepLink).not.toHaveBeenCalled()

    await act(async () => {
      vi.advanceTimersByTime(60_000)
      await Promise.resolve()
    })
    expect(liveTeamId).toBe('team-c')
    expect(ensureTeamContext).toHaveBeenCalledTimes(1)
    expect(acknowledgeDeepLink).not.toHaveBeenCalled()
  })

  it('retries a transient team-context failure and opens without duplicate mounts', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let liveTeamId = 'team-a'
    const transientError = Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' })
    const ensureTeamContext = vi
      .fn()
      .mockRejectedValueOnce(transientError)
      .mockImplementation(async ({ teamId }: { teamId?: string }) => {
        if (!teamId || teamId === liveTeamId) return false
        liveTeamId = teamId
        return true
      })
    currentController = makeController({
      initialExperienceLoading: false,
      handleEnsureTeamContext: ensureTeamContext,
      getCurrentTeamId: () => liveTeamId,
    })
    listApps.mockResolvedValue({
      apps: [
        {
          appRef: 'ns/app',
          title: 'Linked App',
          defaultPath: '/',
          ready: true,
          phase: 'active',
        },
      ],
    })
    render(<App />)
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/app', teamId: 'team-b' })
    })
    await confirmPendingAppLink()

    await waitFor(() => {
      expect(currentController.pushToast).toHaveBeenCalledWith(
        'Could not switch to the linked team yet: fetch failed. This link will retry shortly.',
        'info'
      )
    })
    expect(acknowledgeDeepLink).not.toHaveBeenCalled()

    await act(async () => {
      vi.advanceTimersByTime(1_000)
      await Promise.resolve()
    })
    await reportShortcutOpenResult()

    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(1))
    expect(acknowledgeDeepLink).toHaveBeenCalledTimes(1)
    // Launched exactly once onto the Apps route via the store (observable that
    // replaced the retired single `handleNavSelect(apps)` call).
    expect(currentController.navItem).toBe(DESKTOP_ROUTES.apps)
    expect(liveTeamId).toBe('team-b')
  })

  it('keeps a transient team-context failure pending when retry budget is exhausted', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const ensureTeamContext = vi.fn(async () => {
      throw Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' })
    })
    currentController = makeController({
      initialExperienceLoading: false,
      handleEnsureTeamContext: ensureTeamContext,
    })
    render(<App />)
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/app', teamId: 'team-b' })
    })
    await confirmPendingAppLink()

    await waitFor(() => expect(ensureTeamContext).toHaveBeenCalledTimes(1))
    await waitFor(() => {
      expect(currentController.pushToast).toHaveBeenCalledWith(
        'Could not switch to the linked team yet: fetch failed. This link will retry shortly.',
        'info'
      )
    })

    for (const [index, delay] of [1_000, 2_000, 4_000, 8_000, 15_000].entries()) {
      await act(async () => {
        vi.advanceTimersByTime(delay)
        await Promise.resolve()
      })
      await waitFor(() => expect(ensureTeamContext).toHaveBeenCalledTimes(index + 2))
    }

    await waitFor(() => {
      expect(confirmDialogHarness.props?.title).toBe('App link could not be opened')
    })
    expect(ensureTeamContext).toHaveBeenCalledTimes(6)
    expect(acknowledgeDeepLink).not.toHaveBeenCalled()
  })

  it('does not retry permanent team access failures', async () => {
    const ensureTeamContext = vi.fn(async () => {
      throw new Error('403 forbidden: not a member of team-b')
    })
    currentController = makeController({
      initialExperienceLoading: false,
      handleEnsureTeamContext: ensureTeamContext,
    })
    render(<App />)
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/app', teamId: 'team-b' })
    })
    await confirmPendingAppLink()

    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(1))
    expect(ensureTeamContext).toHaveBeenCalledTimes(1)
    expect(confirmDialogHarness.props?.title).not.toBe('App link could not be opened')
  })

  it('keeps a failed native mount unacked and continues with later links', async () => {
    currentController = makeController({ initialExperienceLoading: false })
    listApps.mockResolvedValue({
      apps: [
        {
          appRef: 'ns/app',
          title: 'Linked App',
          defaultPath: '/',
          ready: true,
          phase: 'active',
        },
        {
          appRef: 'ns/next',
          title: 'Next App',
          defaultPath: '/',
          ready: true,
          phase: 'active',
        },
      ],
    })
    render(<App />)
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/app' })
    })
    await confirmPendingAppLink()
    await reportShortcutOpenResult({ status: 'failed', message: 'native mount failed' })

    expect(acknowledgeDeepLink).not.toHaveBeenCalledWith(1)

    act(() => {
      emitDeepLink?.({ id: 2, appRef: 'ns/next' })
    })
    await confirmPendingAppLink()
    await waitFor(() => {
      expect(sandboxUiPageHarness.props?.shortcutOpenRequestId).toBeGreaterThan(1)
    })
    await reportShortcutOpenResult()

    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(2))
    expect(acknowledgeDeepLink).not.toHaveBeenCalledWith(1)
  })

  // ── mini-spec 05: Phase-1 app persistence by URL restoration ────────────────

  const READY_APP = {
    appRef: 'ns/app',
    title: 'Linked App',
    defaultPath: '/',
    ready: true,
    phase: 'active',
  }

  // A genuinely distinct app: a different appRef, so cross-app lifecycle
  // isolation tests exercise App A → App B rather than a second tab of App A.
  const READY_APP_B = {
    appRef: 'ns/app-b',
    title: 'Linked App B',
    defaultPath: '/',
    ready: true,
    phase: 'active',
  }

  const appTabs = () => currentController.workspaceTabs.tabs.filter(tab => tab.kind === 'app')

  // Launch an app straight through the sidebar (`onOpenSandboxUiApp`), the same
  // path the real app-picker uses — no deep-link confirm ceremony. Defaults to
  // `ns/app`; pass a distinct appRef to launch another app the sidebar offers.
  async function launchAppFromSidebar(appRef = 'ns/app'): Promise<void> {
    await waitFor(() =>
      expect(sidebarHarness.props?.availableSandboxUiApps?.some(a => a.appRef === appRef)).toBe(
        true
      )
    )
    const app = sidebarHarness.props?.availableSandboxUiApps?.find(a => a.appRef === appRef)
    if (!app) throw new Error(`${appRef} was not available to the sidebar`)
    await act(async () => {
      sidebarHarness.props?.onOpenSandboxUiApp?.(app)
      await Promise.resolve()
    })
    await waitFor(() => expect(sandboxUiPageHarness.props?.shortcutApp?.appRef).toBe(appRef))
  }

  async function selectTab(index: 0 | 1 | 2): Promise<void> {
    await waitFor(() => expect(emitCommand).not.toBeNull())
    await act(async () => {
      emitCommand?.(`tabs.select${index + 1}` as DesktopCommandId)
      await Promise.resolve()
    })
  }

  it('restores the saved route when an app tab is reactivated (mini-spec 05 §3, T3)', async () => {
    currentController = makeController({ initialExperienceLoading: false })
    listApps.mockResolvedValue({ apps: [READY_APP] })
    render(<App />)
    await launchAppFromSidebar()
    // Launched at the default route — nothing persisted yet.
    expect(sandboxUiPageHarness.props?.shortcutApp?.routePath).toBeUndefined()

    // The embed navigated to a non-default route. This is the shape the real
    // producer emits (sandboxUiDriver.test.ts proves '/tickets/42' for a nested
    // view URL; appService.getSandboxUiLocation reshapes it to { appRef, routePath }).
    getSandboxUiLocation.mockResolvedValue({ appRef: 'ns/app', routePath: '/tickets/42' })

    // Deactivate → the store reads the route and persists it on the app tab.
    await selectTab(0)
    await waitFor(() => expect(appTabs()[0]?.app?.savedRoutePath).toBe('/tickets/42'))

    // Reactivate → the embed re-mounts at the saved route, not the default path.
    await selectTab(1)
    await waitFor(() =>
      expect(sandboxUiPageHarness.props?.shortcutApp?.routePath).toBe('/tickets/42')
    )
  })

  it('keeps two tabs of the same app on their own routes when alternating (§5)', async () => {
    currentController = makeController({ initialExperienceLoading: false })
    listApps.mockResolvedValue({ apps: [READY_APP] })
    render(<App />)

    // Two tabs of the same app: [chat, A, B].
    await launchAppFromSidebar()
    getSandboxUiLocation.mockResolvedValue({ appRef: 'ns/app', routePath: '/tickets/A' })
    await launchAppFromSidebar() // deactivates A (persists /tickets/A), activates B
    await waitFor(() => expect(appTabs()).toHaveLength(2))
    await waitFor(() => expect(appTabs()[0]?.app?.savedRoutePath).toBe('/tickets/A'))

    // B navigates to its own route, then we switch back to A.
    getSandboxUiLocation.mockResolvedValue({ appRef: 'ns/app', routePath: '/tickets/B' })
    await selectTab(1) // index 1 = A
    await waitFor(() => expect(appTabs()[1]?.app?.savedRoutePath).toBe('/tickets/B'))
    await waitFor(() =>
      expect(sandboxUiPageHarness.props?.shortcutApp?.routePath).toBe('/tickets/A')
    )

    // Back to B restores B's own route.
    await selectTab(2) // index 2 = B
    await waitFor(() =>
      expect(sandboxUiPageHarness.props?.shortcutApp?.routePath).toBe('/tickets/B')
    )
  })

  it('closes the embed exactly once on deactivation — the store is the single emitter (§3)', async () => {
    currentController = makeController({ initialExperienceLoading: false })
    listApps.mockResolvedValue({ apps: [READY_APP] })
    render(<App />)
    await launchAppFromSidebar()

    closeSandboxUi.mockClear()
    getSandboxUiLocation.mockClear()

    await selectTab(0) // deactivate to the seeded chat tab
    await waitFor(() => expect(closeSandboxUi).toHaveBeenCalledTimes(1))
    expect(getSandboxUiLocation).toHaveBeenCalledTimes(1)
  })

  it('does not re-close after an UNsolicited close reconciles the tab as not mounted (§3)', async () => {
    currentController = makeController({ initialExperienceLoading: false })
    listApps.mockResolvedValue({ apps: [READY_APP] })
    render(<App />)
    await launchAppFromSidebar()

    // Unsolicited teardown (crash / quit / partition GC) arrives while the app
    // tab is still active: the store reconciles its liveness to "not mounted".
    await act(async () => {
      sandboxUiPageHarness.props?.onEmbeddedAppBack?.()
      await Promise.resolve()
    })

    closeSandboxUi.mockClear()
    getSandboxUiLocation.mockClear()

    // A later deactivation must not persist/close a dead embed.
    await selectTab(0)
    await act(async () => {
      await Promise.resolve()
    })
    expect(closeSandboxUi).not.toHaveBeenCalled()
    expect(getSandboxUiLocation).not.toHaveBeenCalled()
  })

  it('closes an embed re-mounted within the still-active app tab (Blocker — arm-on-open)', async () => {
    currentController = makeController({ initialExperienceLoading: false })
    listApps.mockResolvedValue({ apps: [READY_APP] })
    render(<App />)
    await launchAppFromSidebar()

    // Back-to-apps / unsolicited onClosed clears the liveness ref but leaves the
    // app tab active (the in-page Apps grid is shown, no tab change).
    await act(async () => {
      sandboxUiPageHarness.props?.onEmbeddedAppBack?.()
      await Promise.resolve()
    })

    // Re-mount the embed DIRECTLY from the in-page grid: this only fires
    // onEmbeddedAppOpening — it does NOT create or select a store tab. Before the
    // arm-on-open fix the liveness ref stays null here, so the deactivation
    // effect early-returns on the next switch and the native view leaks; with the
    // fix, onEmbeddedAppOpening arms the ref to the active app tab.
    await act(async () => {
      sandboxUiPageHarness.props?.onEmbeddedAppOpening?.({
        appRef: 'ns/app',
        label: 'Linked App',
        defaultPath: '/',
      })
      await Promise.resolve()
    })

    closeSandboxUi.mockClear()

    // Switching to a chat tab must close the re-mounted embed exactly once.
    await selectTab(0)
    await waitFor(() => expect(closeSandboxUi).toHaveBeenCalledTimes(1))
  })

  it('persists the outgoing app route on a deep-link handoff (§3, Should-fix)', async () => {
    const ensureTeamContext = vi.fn(async (): Promise<boolean> => true)
    currentController = makeController({
      initialExperienceLoading: false,
      handleEnsureTeamContext: ensureTeamContext,
    })
    listApps.mockResolvedValue({ apps: [READY_APP] })
    render(<App />)
    await launchAppFromSidebar()
    const outgoingId = appTabs()[0]?.id

    // The outgoing embed is on a non-default route when a cross-team deep link
    // hands off — the handoff must persist it, same as the deactivation effect.
    getSandboxUiLocation.mockResolvedValue({ appRef: 'ns/app', routePath: '/handoff/route' })

    await waitFor(() => expect(emitDeepLink).not.toBeNull())
    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/app', teamId: 'team-b' })
    })
    await confirmPendingAppLink()

    await waitFor(() =>
      expect(
        currentController.workspaceTabs.tabs.find(tab => tab.id === outgoingId)?.app?.savedRoutePath
      ).toBe('/handoff/route')
    )
    expect(getSandboxUiLocation).toHaveBeenCalled()
    expect(closeSandboxUi).toHaveBeenCalled()
  })

  // R1-H1 (mini-spec 07): the deactivation continuation reads the outgoing
  // route over IPC and then closes the singleton embed. If the user reactivates
  // the SAME app tab before that read resolves, the stale continuation must not
  // tear down the just-reopened embed nor overwrite the live tab's route with
  // the value it read from the view that is already gone. The read is deferred
  // here so the reactivation lands while it is in flight. The resolved value uses
  // the same `{ appRef, routePath }` contract shape the rest of the suite uses
  // (pinned by sandboxUiDriver.test.ts); the gate aborts before routePath is read
  // on the raced path, so its exact value does not matter to this test.
  function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(res => {
      resolve = res
    })
    return { promise, resolve }
  }

  it('does not close or overwrite an app tab reactivated before the stale getLocation resolves (R1-H1, T3)', async () => {
    currentController = makeController({ initialExperienceLoading: false })
    listApps.mockResolvedValue({ apps: [READY_APP] })
    render(<App />)
    await launchAppFromSidebar() // tabs: [chat, A]; A is live

    closeSandboxUi.mockClear()

    // Defer the deactivation read so App A can be reactivated while it is still
    // in flight. Only the deactivation continuation calls getLocation here
    // (reactivation early-returns before any read), so one deferred call is exact.
    const pendingLocation = createDeferred<{ appRef: string; routePath?: string }>()
    getSandboxUiLocation.mockReturnValueOnce(pendingLocation.promise)

    // Deactivate A → seeded chat tab: dispatches the read-then-close continuation.
    await selectTab(0)
    // Reactivate A before the old read resolves: a newer activation now owns the
    // active view and the embed is re-mounted for A.
    await selectTab(1)

    // The stale read finally resolves with A's earlier route.
    await act(async () => {
      pendingLocation.resolve({ appRef: 'ns/app', routePath: '/stale/route' })
      await Promise.resolve()
      await Promise.resolve()
    })

    // Observable result: the reopened embed was NOT torn down, and the live tab's
    // route was NOT clobbered by the stale value. (At the pre-fix head the stale
    // continuation closes the reopened embed and persists '/stale/route' onto A.)
    expect(closeSandboxUi).not.toHaveBeenCalled()
    expect(appTabs()[0]?.app?.savedRoutePath).not.toBe('/stale/route')
  })

  it('does not close a different app opened before the stale getLocation resolves (R1-H1, T3)', async () => {
    currentController = makeController({ initialExperienceLoading: false })
    // Two genuinely distinct apps: A's stale continuation must not tear down B.
    listApps.mockResolvedValue({ apps: [READY_APP, READY_APP_B] })
    render(<App />)
    await launchAppFromSidebar('ns/app') // tabs: [chat, A]; A is live

    closeSandboxUi.mockClear()

    const pendingLocation = createDeferred<{ appRef: string; routePath?: string }>()
    getSandboxUiLocation.mockReturnValueOnce(pendingLocation.promise)

    // Deactivate A → seeded chat tab (A's read in flight).
    await selectTab(0)
    // Open a DIFFERENT app (B, distinct appRef) before A's read resolves; B is live.
    await launchAppFromSidebar('ns/app-b')
    await waitFor(() => expect(appTabs()).toHaveLength(2))

    // The stale read resolves with A's route, while B owns the active view.
    await act(async () => {
      pendingLocation.resolve({ appRef: 'ns/app', routePath: '/stale/route' })
      await Promise.resolve()
      await Promise.resolve()
    })

    // Observable result: B stays the live view and its embed survives (no close).
    // (At the pre-fix head the stale continuation closes the newly-opened B embed.)
    expect(sandboxUiPageHarness.props?.shortcutApp?.appRef).toBe('ns/app-b')
    expect(closeSandboxUi).not.toHaveBeenCalled()
    expect(appTabs()[1]?.app?.appRef).toBe('ns/app-b')
    // Cross-app persist isolation: the stale read carried A's appRef, so the pre-fix
    // continuation would clobber A's own route with '/stale/route'. The gate aborts
    // that persist once B owns the active view, so A's route stays untouched.
    expect(appTabs()[0]?.app?.appRef).toBe('ns/app')
    expect(appTabs()[0]?.app?.savedRoutePath).not.toBe('/stale/route')
    expect(appTabs()[1]?.app?.savedRoutePath).toBeUndefined()
  })

  // R3-M1 (the missing half of R1-H1): the deactivation continuation must validate
  // that the route it read belongs to the OUTGOING tab's app before persisting it.
  // On an app→app switch the incoming `open()` can reach main before this read
  // resolves, so `getLocation` can surface the INCOMING app's location within a
  // single activation generation — the generation gate does not catch that. Without
  // the appRef guard, App B's route lands on App A's tab.
  it('does not persist the incoming app route onto the outgoing tab (R3-M1, T3)', async () => {
    currentController = makeController({ initialExperienceLoading: false })
    // Two genuinely distinct apps so the read can carry the WRONG app's location.
    listApps.mockResolvedValue({ apps: [READY_APP, READY_APP_B] })
    render(<App />)
    await launchAppFromSidebar('ns/app') // tabs: [chat, A]; A live
    const outgoingId = appTabs()[0]?.id

    // The deactivation read returns the INCOMING app's location (B), not A's.
    getSandboxUiLocation.mockResolvedValue({ appRef: 'ns/app-b', routePath: '/b/route' })

    await launchAppFromSidebar('ns/app-b') // deactivates A (reads B's location), activates B
    await waitFor(() => expect(appTabs()).toHaveLength(2))
    // Let A's deactivation continuation run to completion.
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    // Observable result: A keeps its own identity and is NOT saved with B's route.
    // The read's appRef ('ns/app-b') did not match A's ('ns/app'), so the persist
    // fell back to undefined. (At the pre-guard head A.savedRoutePath === '/b/route'.)
    const appA = currentController.workspaceTabs.tabs.find(tab => tab.id === outgoingId)
    expect(appA?.app?.appRef).toBe('ns/app')
    expect(appA?.app?.savedRoutePath).not.toBe('/b/route')
    expect(appA?.app?.savedRoutePath).toBeUndefined()
  })
})
