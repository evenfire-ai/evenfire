// @vitest-environment jsdom
import { type ReactElement, type ReactNode, useEffect, useLayoutEffect, useReducer } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, waitFor } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DESKTOP_ROUTES, SIDEBAR_COLLAPSED_KEY } from '@constants/navigation'
import { useAppController } from '@hooks/useAppController'
import type { EmbedOwnershipMachine } from '@lib/embedOwnershipMachine.types'
import { desktopQueryDefaults } from '@lib/queryClient'
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
import { type SandboxUiMainFake, createSandboxUiMainFake } from './__fixtures__/sandboxUiMainFake'

// The sandbox-ui main fake runs the real main process; these are the
// layers under it that the suite does not stand up.
vi.mock(
  'electron',
  async () =>
    (await import('../../../src/__tests__/__fixtures__/sandboxUiElectronFakes')).electronModule
)
vi.mock(
  '../../../src/config',
  async () =>
    (await import('../../../src/__tests__/__fixtures__/sandboxUiMainModuleMocks')).configModule
)
vi.mock(
  '../../../src/sandboxUiPartitionGc',
  async () =>
    (await import('../../../src/__tests__/__fixtures__/sandboxUiMainModuleMocks')).partitionGcModule
)
vi.mock(
  '../../../src/rpcTokenManager',
  async () =>
    (await import('../../../src/__tests__/__fixtures__/sandboxUiMainModuleMocks'))
      .rpcTokenManagerModule
)
vi.mock(
  '../../../src/authClient',
  async () =>
    (await import('../../../src/__tests__/__fixtures__/sandboxUiMainModuleMocks')).authClientModule
)
vi.mock(
  '../../../src/tokenStore',
  async () =>
    (await import('../../../src/__tests__/__fixtures__/sandboxUiMainModuleMocks')).tokenStoreModule
)

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
    body?: ReactNode
    cancelLabel?: string
    confirmLabel?: string
    onCancel: () => void
    onConfirm: () => void
  },
}))

const appHeaderHarness = vi.hoisted(() => ({
  props: null as null | {
    placement?: 'default' | 'titlebar'
    searchFocusRequestId?: number
    notificationOpenRequestId?: number
    onShellOverlayOpenChange?: (open: boolean) => void
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
    embed: EmbedOwnershipMachine
    headerShellOverlayOpen?: boolean
    deepLinkShellOverlayOpen?: boolean
    localSearchRequestId?: number
  },
}))
const SLOT_BOUNDS = { x: 16, y: 12, width: 400, height: 300, dpr: 1 }

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
vi.mock('@components/Common', () => ({
  Button: () => null,
  IconButton: () => null,
  ToastStack: () => null,
}))
vi.mock('@components/ConfirmDialog', () => ({
  ConfirmDialog: (props: {
    title: string
    body?: ReactNode
    onCancel: () => void
    onConfirm: () => void
  }) => {
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
// The page is stubbed, but like the real one it measures the slot for every
// launch while it is mounted, so launches reach main.
vi.mock('@pages/SandboxUiPage', () => ({
  SandboxUiPage: (props: NonNullable<typeof sandboxUiPageHarness.props>) => {
    sandboxUiPageHarness.props = props
    const { embed } = props
    useLayoutEffect(() => embed.registerMeasurer(async () => SLOT_BOUNDS), [embed])
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
    isHostAccessBlocked: vi.fn(() => false),
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

// App mounts GfsDragSessionProvider, which reads Query state: every bare
// App render needs a real QueryClient (fresh per render, production cache
// defaults) instead of the app-level singleton provider it gets in prod.
function renderApp(ui: ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: desktopQueryDefaults })
  return render(ui, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  })
}

describe('App deep-link orchestration', () => {
  let currentController: AppController
  let emitDeepLink: ((link: SandboxUiDeepLinkEnvelope) => void) | null
  let emitCommand: ((commandId: DesktopCommandId, source?: 'host' | 'sandbox') => void) | null
  const clearPendingDeepLinks = vi.fn().mockResolvedValue(undefined)
  const acknowledgeDeepLink = vi.fn().mockResolvedValue(undefined)
  const listApps = vi.fn().mockResolvedValue({ apps: [] })
  const listPendingDeepLinks = vi.fn().mockResolvedValue({ links: [] })
  let main: SandboxUiMainFake
  const closeSandboxUi = () => main.bridge.close
  const openSandboxUi = () => main.bridge.open

  it('prompts to add an environment when a Profile Portal handoff has no saved match', () => {
    const linkProvidedName = 'Tenant from profile link '.repeat(5)
    currentController = makeController({
      initialExperienceLoading: false,
      pendingDesktopEnvironmentSetup: {
        appName: linkProvidedName,
        externalRestApiBaseUrl: 'https://api.example.test',
        rpcProxyBaseUrl: 'https://rpc.example.test',
      },
    } as Partial<AppController>)

    renderApp(<App />)

    expect(confirmDialogHarness.props?.title).toBe('Add desktop environment?')
    const dialogBody = renderToStaticMarkup(<>{confirmDialogHarness.props?.body}</>)
    expect(dialogBody).toContain(
      'Review this External REST API host. Continue only if you trust it.'
    )
    expect(dialogBody).toContain('<strong>api.example.test</strong>')
    expect(dialogBody).toContain('Profile link label (unverified):')
    expect(dialogBody).toContain(`${linkProvidedName.slice(0, 63)}…`)
    expect(dialogBody).not.toContain(linkProvidedName.slice(64))
    expect(dialogBody).toContain('https://api.example.test')
    expect(dialogBody).not.toContain('https://rpc.example.test')
  })

  it('wires environment switch confirmation actions to the controller', () => {
    const cancelSwitch = vi.fn()
    const confirmSwitch = vi.fn()
    const linkProvidedName = 'Tenant from profile link '.repeat(5)
    currentController = makeController({
      initialExperienceLoading: false,
      pendingDesktopEnvironmentSwitchConfirmation: {
        activeEnvironmentName: 'Current environment',
        activeExternalRestApiBaseUrl: 'https://current-api.example.test/api/v1',
        targetEnvironmentName: linkProvidedName,
        targetExternalRestApiBaseUrl: 'https://target-api.example.test/api/v1',
      },
      handleCancelDesktopEnvironmentSwitchConfirmation: cancelSwitch,
      handleConfirmDesktopEnvironmentSwitchConfirmation: confirmSwitch,
    } as Partial<AppController>)

    renderApp(<App />)

    expect(confirmDialogHarness.props?.title).toBe('Switch desktop environment?')
    expect(confirmDialogHarness.props?.confirmLabel).toBe('Sign out and switch')
    const dialogBody = renderToStaticMarkup(<>{confirmDialogHarness.props?.body}</>)
    expect(dialogBody).toContain('<strong>current-api.example.test</strong>')
    expect(dialogBody).toContain('<strong>target-api.example.test</strong>')
    expect(dialogBody).toContain('Profile link label (unverified):')
    expect(dialogBody).toContain(`${linkProvidedName.slice(0, 63)}…`)
    expect(dialogBody).not.toContain(linkProvidedName.slice(64))
    act(() => confirmDialogHarness.props?.onCancel())
    expect(cancelSwitch).toHaveBeenCalledOnce()
    act(() => confirmDialogHarness.props?.onConfirm())
    expect(confirmSwitch).toHaveBeenCalledOnce()
  })

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
    main = createSandboxUiMainFake()
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
          ...main.bridge,
          listApps,
          listPendingDeepLinks,
          clearPendingDeepLinks,
          acknowledgeDeepLink,
          focusActive: vi.fn().mockResolvedValue(true),
          onDeepLink: vi.fn((callback: (link: SandboxUiDeepLinkEnvelope) => void) => {
            emitDeepLink = callback
            return vi.fn()
          }),
        },
      } as unknown as Window['clerum'],
    })
  })

  // An app launched the way the sidebar does, into a new app tab. The stubbed
  // page measures for it, and main mounts it unless told otherwise.
  const LIVE_APP = { appRef: 'ns/app', label: 'App', defaultPath: '/' }

  function embedState() {
    const embed = sandboxUiPageHarness.props?.embed
    if (!embed) throw new Error('the Apps page is not mounted')
    return embed.getSnapshot()
  }

  function embedPhase(): string | undefined {
    const state = embedState()
    return state.owner === null ? undefined : state.views.get(state.owner)?.phase
  }

  async function launchLiveApp(
    app: { appRef: string; label: string; defaultPath: string } = LIVE_APP
  ) {
    await act(async () => {
      sidebarHarness.props?.onOpenSandboxUiApp?.(app)
      await Promise.resolve()
    })
  }

  async function waitForMounted() {
    await waitFor(() => expect(embedPhase()).toBe('mounted'))
  }

  // With universal-tabs an open app is a `kind:'app'` tab in the global strip, so
  // opening/closing an app no longer auto-collapses or restores the sidebar. The
  // manual toggle and its persistence are the only things that move the sidebar.
  it('does not collapse or restore the sidebar when an app opens and closes', async () => {
    window.localStorage.clear()
    currentController = makeController({
      initialExperienceLoading: false,
      navItem: DESKTOP_ROUTES.apps,
    } as Partial<AppController>)
    renderApp(<App />)
    expect(sidebarHarness.props?.collapsed).toBe(false)

    await launchLiveApp()
    await waitForMounted()
    // Opening an app leaves the sidebar exactly as it was, and touches nothing in
    // the saved preference.
    expect(sidebarHarness.props?.collapsed).toBe(false)
    expect(window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY)).toBeNull()

    await act(async () => emitCommand?.('app.backToApps'))
    await waitFor(() => expect(embedState().owner).toBeNull())
    expect(sidebarHarness.props?.collapsed).toBe(false)
  })

  it('keeps the manual sidebar toggle and its persistence intact while an app is open', async () => {
    window.localStorage.clear()
    currentController = makeController({
      initialExperienceLoading: false,
      navItem: DESKTOP_ROUTES.apps,
    } as Partial<AppController>)
    renderApp(<App />)

    await launchLiveApp()
    await waitForMounted()
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
    await act(async () => emitCommand?.('app.backToApps'))
    await waitFor(() => expect(embedState().owner).toBeNull())
    expect(sidebarHarness.props?.collapsed).toBe(false)
  })

  it('respects a saved collapsed preference regardless of app open/close', async () => {
    window.localStorage.clear()
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, '1')
    currentController = makeController({
      initialExperienceLoading: false,
      navItem: DESKTOP_ROUTES.apps,
    } as Partial<AppController>)
    renderApp(<App />)
    expect(sidebarHarness.props?.collapsed).toBe(true)

    main.failNextOpen(new Error('open rejected'))
    await launchLiveApp()
    await waitFor(() => expect(embedState().failure?.kind).toBe('open'))
    expect(sidebarHarness.props?.collapsed).toBe(true)
  })

  it('drops the shell overlays raised over an app whose view is gone while its tab stays', async () => {
    currentController = makeController({
      initialExperienceLoading: false,
      navItem: DESKTOP_ROUTES.apps,
    } as Partial<AppController>)
    renderApp(<App />)
    await launchLiveApp()
    await waitForMounted()
    act(() => appHeaderHarness.props?.onShellOverlayOpenChange?.(true))
    expect(sandboxUiPageHarness.props?.headerShellOverlayOpen).toBe(true)

    await act(() => main.crash())

    await waitFor(() => expect(embedState().failure?.kind).toBe('crashed'))
    expect(sandboxUiPageHarness.props?.headerShellOverlayOpen).toBe(false)
  })

  it('uses the shared titlebar header on every authenticated route', () => {
    const routes = Object.values(DESKTOP_ROUTES)

    for (const navItem of routes) {
      currentController = makeController({
        initialExperienceLoading: false,
        navItem,
      } as Partial<AppController>)
      const view = renderApp(<App />)

      expect(appHeaderHarness.props?.placement).toBe('titlebar')

      view.unmount()
    }
  })

  it('runs registered new-tab and composer-focus commands through existing chat selection', () => {
    currentController = makeController({
      initialExperienceLoading: false,
      selectedAgent: 'alpha',
    } as Partial<AppController>)
    renderApp(<App />)

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
    renderApp(<App />)

    act(() => emitCommand?.('search.open'))
    expect(appHeaderHarness.props?.searchFocusRequestId).toBe(1)
    expect(chatLocalSearchHarness.rendered).not.toHaveBeenCalled()

    act(() => emitCommand?.('search.current'))
    expect(chatLocalSearchHarness.rendered).toHaveBeenCalled()
    expect(appHeaderHarness.props?.searchFocusRequestId).toBe(1)
  })

  it('suppresses application commands while plugin consent owns the app surface', () => {
    currentController = makeController({ initialExperienceLoading: false })
    renderApp(<App />)
    const consent = document.createElement('div')
    consent.className = 'da-plugin-consent'
    consent.setAttribute('role', 'dialog')
    document.body.append(consent)

    act(() => emitCommand?.('search.open'))

    expect(appHeaderHarness.props?.searchFocusRequestId).toBe(0)
    consent.remove()
  })

  it('routes contextual search to the current sandbox app without opening global search', async () => {
    currentController = makeController({
      initialExperienceLoading: false,
      navItem: DESKTOP_ROUTES.apps,
      selectedAgent: 'alpha',
    } as Partial<AppController>)
    renderApp(<App />)
    const held = main.holdNextOpen()
    await launchLiveApp()
    await waitFor(() => expect(openSandboxUi()).toHaveBeenCalledTimes(1))

    // Still opening: nothing to search yet.
    act(() => emitCommand?.('search.current'))
    expect(sandboxUiPageHarness.props?.localSearchRequestId).toBe(0)
    await act(async () => held().resolve())
    await waitForMounted()
    act(() => emitCommand?.('search.current'))
    expect(sandboxUiPageHarness.props?.localSearchRequestId).toBe(1)
    expect(appHeaderHarness.props?.searchFocusRequestId).toBe(0)

    await launchLiveApp({ appRef: 'ns/replacement', label: 'Replacement app', defaultPath: '/' })
    await waitFor(() => expect(openSandboxUi()).toHaveBeenCalledTimes(2))
    await waitForMounted()
    act(() => emitCommand?.('search.current'))
    expect(sandboxUiPageHarness.props?.localSearchRequestId).toBe(2)
  })

  it('opens the palette, executes eligible registry actions, and captures the sandbox view', async () => {
    currentController = makeController({
      initialExperienceLoading: false,
      navItem: DESKTOP_ROUTES.apps,
      selectedAgent: 'alpha',
    } as Partial<AppController>)
    renderApp(<App />)
    await launchLiveApp()
    act(() => emitCommand?.('commands.open', 'sandbox'))

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
    renderApp(<App />)
    act(() => emitCommand?.('commands.open', 'sandbox'))
    act(() => commandPaletteHarness.props?.onClose())

    await waitFor(() => expect(window.clerum.sandboxUi.focusActive).toHaveBeenCalledOnce())
  })

  it('opens Settings Shortcuts through the registered palette action', () => {
    currentController = makeController({ initialExperienceLoading: false })
    renderApp(<App />)
    act(() => emitCommand?.('commands.open'))
    act(() => commandPaletteHarness.props?.onExecute('settings.shortcuts'))

    expect(currentController.handleNavSelect).toHaveBeenCalledWith(DESKTOP_ROUTES.settings)
    expect(settingsPageHarness.props?.shortcutsFocusRequestId).toBe(1)
  })

  it('routes approved core palette actions through their existing owners', () => {
    currentController = makeController({ initialExperienceLoading: false })
    renderApp(<App />)
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

  it('routes approved contextual palette actions through shell and app owners', async () => {
    currentController = makeController({ initialExperienceLoading: false })
    renderApp(<App />)
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

    const held = main.holdNextOpen()
    await launchLiveApp()
    await waitFor(() => expect(openSandboxUi()).toHaveBeenCalledTimes(1))
    act(() => emitCommand?.('commands.open'))
    expect(commandPaletteHarness.props?.isEligible('app.refresh')).toBe(false)
    await act(async () => held().resolve())
    await waitForMounted()
    expect(commandPaletteHarness.props?.isEligible('app.refresh')).toBe(true)

    // Refresh reloads the live view in place: no close, no new view.
    const first = main.openCall(0).launchId
    await act(async () => commandPaletteHarness.props?.onExecute('app.refresh'))
    await act(() => main.settle())
    expect(main.liveReloads()).toBe(1)
    expect(main.live()?.launchId).toBe(first)
    expect(openSandboxUi()).toHaveBeenCalledTimes(1)
    expect(closeSandboxUi()).not.toHaveBeenCalled()

    act(() => emitCommand?.('commands.open'))
    await act(async () => commandPaletteHarness.props?.onExecute('app.backToApps'))
    await waitFor(() => expect(embedState().owner).toBeNull())
    expect(closeSandboxUi()).toHaveBeenLastCalledWith({ launchId: first })
  })

  it('resets controlled command requests with the authenticated shell lifetime', async () => {
    currentController = makeController({ initialExperienceLoading: false })
    const { rerender } = renderApp(<App />)

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
      expect(commandPaletteHarness.props?.isEligible('app.refresh')).toBe(false)
    })
  })

  afterEach(async () => {
    vi.useRealTimers()
    await main.dispose()
  })

  // The deep link's launch reached main (`times` opens so far). Main mounts it
  // unless the test told the fake to hold or fail that open.
  async function waitForAppOpen(times = 1): Promise<void> {
    await waitFor(() => expect(openSandboxUi()).toHaveBeenCalledTimes(times))
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
    const { rerender } = renderApp(<App />)
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
    await waitForAppOpen()

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
    renderApp(<App />)
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/app' })
    })

    await waitFor(() => expect(confirmDialogHarness.props?.title).toBe('Open app link?'))
    expect(currentController.handleNavSelect).not.toHaveBeenCalledWith(DESKTOP_ROUTES.apps)
    expect(acknowledgeDeepLink).not.toHaveBeenCalled()

    await confirmPendingAppLink()
    await waitForAppOpen()

    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(1))
    // The launch drives the store (an app tab), so `navItem` derives to the Apps
    // route — the observable, not the retired `handleNavSelect(apps)` call.
    expect(currentController.navItem).toBe(DESKTOP_ROUTES.apps)
  })

  it('acknowledges an authenticated app link when confirmation is cancelled', async () => {
    currentController = makeController({ initialExperienceLoading: false })
    renderApp(<App />)
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
    expect(openSandboxUi()).not.toHaveBeenCalled()
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
    renderApp(<App />)
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
    await waitForAppOpen()
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
    renderApp(<App />)
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
    renderApp(<App />)
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
    renderApp(<App />)
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/app' })
      emitDeepLink?.({ id: 1, appRef: 'ns/app' })
    })

    await confirmPendingAppLink()
    await waitForAppOpen()

    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(1))
    expect(acknowledgeDeepLink).toHaveBeenCalledTimes(1)
    // Launched exactly once — the store put the shell on the Apps route (the
    // observable that replaced the retired single `handleNavSelect(apps)` call).
    expect(currentController.navItem).toBe(DESKTOP_ROUTES.apps)
  })

  it('never presents a user A link after user B becomes authenticated', async () => {
    const { rerender } = renderApp(<App />)
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
    const { rerender } = renderApp(<App />)

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
    renderApp(<App />)
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
    renderApp(<App />)
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
    let viewLiveAtSwitch: unknown = 'not switched'
    const ensureTeamContext = vi.fn(async (): Promise<boolean> => {
      if (viewLiveAtSwitch === 'not switched') viewLiveAtSwitch = main.live()
      return true
    })
    currentController = makeController({
      initialExperienceLoading: false,
      navItem: DESKTOP_ROUTES.apps,
      handleEnsureTeamContext: ensureTeamContext,
    })
    renderApp(<App />)
    await waitFor(() => expect(sandboxUiPageHarness.props).not.toBeNull())

    await launchLiveApp({ appRef: 'ns/current', label: 'Current App', defaultPath: '/' })
    await waitForMounted()
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/missing', teamId: 'team-b' })
    })
    await confirmPendingAppLink()

    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(1))
    expect(closeSandboxUi()).toHaveBeenCalledOnce()
    expect(closeSandboxUi()).toHaveBeenCalledWith({ launchId: main.openCall(0).launchId })
    // The team switch waited for main to release the view, not just for the close.
    expect(viewLiveAtSwitch).toBeNull()
    expect(closeSandboxUi().mock.invocationCallOrder[0]).toBeLessThan(
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
    renderApp(<App />)
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/app', teamId: 'team-b' })
    })
    await confirmPendingAppLink()

    await waitForAppOpen()
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
    renderApp(<App />)
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
    renderApp(<App />)
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/app' })
    })
    await confirmPendingAppLink()

    await waitForAppOpen()
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
    renderApp(<App />)
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/app' })
    })
    const held = main.holdNextOpen()
    await confirmPendingAppLink()

    await waitForAppOpen()
    await act(async () => {
      await new Promise(resolve => window.setTimeout(resolve, 0))
    })
    expect(acknowledgeDeepLink).not.toHaveBeenCalled()

    await act(async () => held().resolve())

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
    renderApp(<App />)
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
    await waitForAppOpen()

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
    renderApp(<App />)
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
    await waitForAppOpen()

    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(1))
    expect(liveTeamId).toBe('team-b')
    expect(ensureTeamContext).toHaveBeenCalledTimes(1)
  })

  it('defers a cross-team link whose open mounts and then fails, with its error', async () => {
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
    renderApp(<App />)
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/app', teamId: 'team-b' })
    })
    main.failNextOpenAfterMount(new Error('attach failed'))
    await confirmPendingAppLink()
    await waitForAppOpen()

    await waitFor(() => {
      expect(currentController.pushToast).toHaveBeenCalledWith('attach failed', 'error')
    })
    await act(async () => {
      await main.settle()
    })
    expect(main.reported('sandboxUi:released')).toEqual([
      expect.objectContaining({ reason: 'open_failed' }),
    ])
    expect(acknowledgeDeepLink).not.toHaveBeenCalled()
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
    renderApp(<App />)
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/app', teamId: 'team-b' })
    })
    main.failNextOpen(new Error('native mount failed'))
    await confirmPendingAppLink()
    await waitForAppOpen()

    await waitFor(() => {
      expect(currentController.pushToast).toHaveBeenCalledWith('native mount failed', 'error')
    })
    expect(liveTeamId).toBe('team-b')
    expect(acknowledgeDeepLink).not.toHaveBeenCalled()

    await act(async () => {
      vi.advanceTimersByTime(1_000)
      await Promise.resolve()
    })
    await waitForAppOpen(2)

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
    renderApp(<App />)
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/app', teamId: 'team-b' })
    })
    main.failNextOpen(new Error('native mount failed'))
    await confirmPendingAppLink()
    await waitForAppOpen()

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
    expect(openSandboxUi()).toHaveBeenCalledTimes(1)
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
    renderApp(<App />)
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
    await waitForAppOpen()

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
    renderApp(<App />)
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
    renderApp(<App />)
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
    renderApp(<App />)
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/app' })
    })
    main.failNextOpen(new Error('native mount failed'))
    await confirmPendingAppLink()
    await waitForAppOpen()

    expect(acknowledgeDeepLink).not.toHaveBeenCalledWith(1)

    act(() => {
      emitDeepLink?.({ id: 2, appRef: 'ns/next' })
    })
    await confirmPendingAppLink()
    await waitForAppOpen(2)

    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(2))
    expect(acknowledgeDeepLink).not.toHaveBeenCalledWith(1)
  })

  // ── the route an app tab is left on, and deep links left before mounting ──

  const READY_APP = {
    appRef: 'ns/app',
    title: 'Linked App',
    defaultPath: '/',
    ready: true,
    phase: 'active',
  }

  const appTabs = () => currentController.workspaceTabs.tabs.filter(tab => tab.kind === 'app')

  // Launch an app straight through the sidebar (`onOpenSandboxUiApp`), the same
  // path the real app-picker uses — no deep-link confirm ceremony.
  async function launchAppFromSidebar(appRef = 'ns/app'): Promise<void> {
    const app = await waitFor(() => {
      const available = sidebarHarness.props?.availableSandboxUiApps?.find(a => a.appRef === appRef)
      if (!available) throw new Error(`${appRef} was not available to the sidebar`)
      return available
    })
    const opens = openSandboxUi().mock.calls.length
    await act(async () => {
      sidebarHarness.props?.onOpenSandboxUiApp?.(app)
      await Promise.resolve()
    })
    await waitFor(() => expect(openSandboxUi()).toHaveBeenCalledTimes(opens + 1), {
      timeout: 5_000,
    })
    await waitFor(() => expect(embedPhase()).toBe('mounted'), { timeout: 5_000 })
  }

  async function selectTab(index: 0 | 1 | 2): Promise<void> {
    await waitFor(() => expect(emitCommand).not.toBeNull())
    await act(async () => {
      emitCommand?.(`tabs.select${index + 1}` as DesktopCommandId)
      await new Promise(resolve => window.setTimeout(resolve, 0))
    })
  }

  it('restores the route an app tab was left on when it is reactivated', async () => {
    currentController = makeController({ initialExperienceLoading: false })
    listApps.mockResolvedValue({ apps: [READY_APP] })
    renderApp(<App />)
    await launchAppFromSidebar()
    // Launched at the default route.
    expect(main.openCall(0).routePath).toBeUndefined()

    main.navigate('/tickets/42')
    await selectTab(0)
    await waitFor(() => expect(appTabs()[0]?.app?.savedRoutePath).toBe('/tickets/42'))
    expect(closeSandboxUi()).toHaveBeenCalledTimes(1)

    await selectTab(1)
    await waitFor(() => expect(openSandboxUi()).toHaveBeenCalledTimes(2))
    expect(main.openCall(1).routePath).toBe('/tickets/42')
  })

  it('keeps two tabs of the same app on their own routes when alternating', async () => {
    currentController = makeController({ initialExperienceLoading: false })
    listApps.mockResolvedValue({ apps: [READY_APP] })
    renderApp(<App />)

    // Two tabs of the same app: [chat, A, B].
    await launchAppFromSidebar()
    main.navigate('/tickets/A')
    await launchAppFromSidebar() // leaves A (its view reports /tickets/A), opens B
    await waitFor(() => expect(appTabs()).toHaveLength(2))
    await waitFor(() => expect(appTabs()[0]?.app?.savedRoutePath).toBe('/tickets/A'))

    main.navigate('/tickets/B')
    await selectTab(1) // index 1 = A
    await waitFor(() => expect(openSandboxUi()).toHaveBeenCalledTimes(3))
    expect(appTabs()[1]?.app?.savedRoutePath).toBe('/tickets/B')
    expect(main.openCall(2).routePath).toBe('/tickets/A')

    await waitForMounted()
    await selectTab(2) // index 2 = B
    await waitFor(() => expect(openSandboxUi()).toHaveBeenCalledTimes(4))
    expect(main.openCall(3).routePath).toBe('/tickets/B')
  })

  it('does not close a view main already tore down when its tab is left', async () => {
    currentController = makeController({ initialExperienceLoading: false })
    listApps.mockResolvedValue({ apps: [READY_APP] })
    renderApp(<App />)
    await launchAppFromSidebar()

    await act(() => main.crash())
    await waitFor(() => expect(embedState().failure?.kind).toBe('crashed'))

    await selectTab(0)
    expect(closeSandboxUi()).not.toHaveBeenCalled()
    // A crash leaves no route behind: reopening must not land on a crashing page.
    expect(appTabs()[0]?.app?.savedRoutePath).toBeUndefined()
  })

  it('persists the outgoing app route on a deep-link team handoff', async () => {
    const ensureTeamContext = vi.fn(async (): Promise<boolean> => true)
    currentController = makeController({
      initialExperienceLoading: false,
      handleEnsureTeamContext: ensureTeamContext,
    })
    listApps.mockResolvedValue({ apps: [READY_APP] })
    renderApp(<App />)
    await launchAppFromSidebar()
    const outgoingId = appTabs()[0]?.id
    main.navigate('/handoff/route')

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
    expect(closeSandboxUi()).toHaveBeenCalledWith({ launchId: main.openCall(0).launchId })
  })

  it('acks a cross-team link left before it mounted without retrying it or switching teams back', async () => {
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
    listApps.mockResolvedValue({ apps: [READY_APP] })
    renderApp(<App />)
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    main.holdNextOpen()
    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/app', teamId: 'team-b' })
    })
    await confirmPendingAppLink()
    await waitForAppOpen()
    expect(liveTeamId).toBe('team-b')

    // The user leaves the link's tab while its view is still opening.
    await selectTab(0)

    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(1))
    expect(ensureTeamContext).toHaveBeenCalledTimes(1)
    expect(liveTeamId).toBe('team-b')
    expect(confirmDialogHarness.props?.title).not.toBe('App link could not be opened')
    expect(currentController.pushToast).not.toHaveBeenCalledWith(
      expect.stringContaining('Could not open app link'),
      'error'
    )
    // No retry: the link is gone and nothing reopens the app later.
    await act(async () => {
      await new Promise(resolve => window.setTimeout(resolve, 50))
    })
    expect(openSandboxUi()).toHaveBeenCalledTimes(1)
  })

  it('keeps the user where they navigated when a cross-team link is abandoned', async () => {
    let liveTeamId = 'team-a'
    const ensureTeamContext = vi.fn(async ({ teamId }: { teamId?: string }) => {
      if (!teamId || teamId === liveTeamId) return false
      liveTeamId = teamId
      return true
    })
    currentController = makeController({
      initialExperienceLoading: false,
      navItem: DESKTOP_ROUTES.chat,
      selectedAgent: 'alpha',
      activeChatId: 'chat-1',
      handleEnsureTeamContext: ensureTeamContext,
      getCurrentTeamId: () => liveTeamId,
    } as Partial<AppController>)
    listApps.mockResolvedValue({ apps: [READY_APP] })
    renderApp(<App />)
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    main.holdNextOpen()
    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/app', teamId: 'team-b' })
    })
    await confirmPendingAppLink()
    await waitForAppOpen()
    expect(liveTeamId).toBe('team-b')

    // The user goes to Files while the linked app is still opening.
    act(() => {
      currentController.handleNavSelect(DESKTOP_ROUTES.files)
    })

    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(1))
    await act(async () => {
      await new Promise(resolve => window.setTimeout(resolve, 50))
    })
    expect(liveTeamId).toBe('team-b')
    expect(activeWorkspaceTab(currentController.workspaceTabs)?.kind).toBe('files')
    expect(openSandboxUi()).toHaveBeenCalledTimes(1)
  })

  it('stops a deep link waiting on its launch when App unmounts, without acting on it', async () => {
    currentController = makeController({ initialExperienceLoading: false })
    listApps.mockResolvedValue({ apps: [READY_APP] })
    const view = renderApp(<App />)
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    main.holdNextOpen()
    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/app' })
    })
    await confirmPendingAppLink()
    await waitForAppOpen()

    view.unmount()
    await act(async () => {
      await new Promise(resolve => window.setTimeout(resolve, 0))
    })
    // The pending link stays with main for the next renderer to pick up.
    expect(acknowledgeDeepLink).not.toHaveBeenCalled()
  })
})
