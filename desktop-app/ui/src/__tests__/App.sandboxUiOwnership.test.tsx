// @vitest-environment jsdom
import { StrictMode, useEffect, useReducer } from 'react'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import fc from 'fast-check'
import { DESKTOP_ROUTES } from '@constants/navigation'
import { useAppController } from '@hooks/useAppController'
import type { EmbedEvent, Launch } from '@lib/embedOwnership.types'
import type { EmbedOwnershipMachine } from '@lib/embedOwnershipMachine.types'
import type { GfsPreviewResource } from '@lib/gfsPreview'
import { desktopQueryDefaults } from '@lib/queryClient'
import { toActiveSandboxUiApps } from '@lib/sandboxUiAppSelection'
import type { SandboxUiAppListing } from '@lib/sandboxUiAppSelection.types'
import {
  activeWorkspaceTab,
  createWorkspaceTabsState,
  newChatTab,
  openAppTab,
  openFilesTab,
  openPreviewTab,
  selectWorkspaceTab,
  setAppTabSavedRoutePath,
} from '@lib/workspaceTabs'
import { mapKindToRoute } from '@lib/workspaceTabsRoute'
import { App } from '@/App'
import type { SandboxUiDeepLinkEnvelope } from '@/App.types'
import { openGfsResourcePayload, resolvedFile } from '@/gfs/__fixtures__/gfsProducerFixtures'
import { PluginConsentGate } from '../../../src/pluginConsentGate'
import type { PluginConsentRequest } from '../../../src/pluginSdkProtocol'
import type { PinnedPluginSurface } from '../../../src/pluginSurfaceRegistry'
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

// Wiring of App to the embed ownership machine: which event each gesture
// dispatches, in which commit, and that the real SandboxUiPage paints what the
// machine holds. Who owns the embed under every interleaving is not decided
// here: the reducer's table and the property suite against the real main
// process cover that.

const machineHarness = vi.hoisted(() => ({
  machine: null as null | EmbedOwnershipMachine,
  // Every intent/relaunch App dispatched, with what the machine and the store
  // held at that moment.
  launches: [] as Array<{
    type: 'intent' | 'relaunch'
    launch: Launch
    projectedTab: string | null
    storeActiveTab: string | null
  }>,
  events: [] as EmbedEvent[],
  afterDispatch: null as null | ((event: EmbedEvent) => void),
  storeActiveTab: () => null as string | null,
}))

vi.mock('@lib/embedOwnershipMachine', async importOriginal => {
  const actual = await importOriginal<typeof import('@lib/embedOwnershipMachine')>()
  return {
    createEmbedOwnershipMachine: (
      deps: Parameters<typeof actual.createEmbedOwnershipMachine>[0]
    ) => {
      const machine = actual.createEmbedOwnershipMachine(deps)
      const dispatch = machine.dispatch
      machine.dispatch = (event: EmbedEvent) => {
        machineHarness.events.push(event)
        if (event.type === 'intent' || event.type === 'relaunch') {
          machineHarness.launches.push({
            type: event.type,
            launch: event.launch,
            projectedTab: machine.getSnapshot().activeAppTabId,
            storeActiveTab: machineHarness.storeActiveTab(),
          })
        }
        dispatch(event)
        machineHarness.afterDispatch?.(event)
      }
      machineHarness.machine = machine
      return machine
    },
  }
})

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
type AppController = ReturnType<typeof useAppController>

const sidebarHarness = vi.hoisted(() => ({
  renderActual: false,
  props: null as null | {
    activeSandboxUiApp?: { appRef: string } | null
    compactMode?: boolean
    compactMenuOpen?: boolean
    onCompactMenuOpenChange?: (open: boolean, closeFocus?: string) => void
    onSettingsMenuOpenChange?: (open: boolean) => void
    onSelect?: (item: string) => void
    onOpenSandboxUiApp?: (app: {
      appRef: string
      label: string
      defaultPath: string
      icon?: string
    }) => void
  },
}))
const confirmDialogHarness = vi.hoisted(() => ({
  props: null as null | { title?: string; onConfirm: () => void },
}))
const gfsPreviewHarness = vi.hoisted(() => ({
  props: null as null | { onClose: () => void },
}))
const consentHarness = vi.hoisted(() => ({
  props: null as null | { request: { promptId: string } },
}))
const sandboxUiPageHarness = vi.hoisted(() => ({
  props: null as null | {
    sidebarShellOverlayOpen?: boolean
    appRootOverlayOpen?: boolean
  },
}))

vi.mock('@hooks/useAppController', () => ({ useAppController: vi.fn() }))
vi.mock('@hooks/useAgentChatActionsValue', () => ({ useAgentChatActionsValue: () => ({}) }))
vi.mock('@components/AppHeader', () => ({ AppHeader: () => null }))
vi.mock('@components/ChatLocalSearch', () => ({ ChatLocalSearch: () => null }))
vi.mock('@components/CommandPalette', () => ({ CommandPalette: () => null }))
vi.mock('@components/BootSplash', () => ({ BootSplash: () => null }))
vi.mock('@components/ConfirmDialog', () => ({
  ConfirmDialog: (props: NonNullable<typeof confirmDialogHarness.props>) => {
    confirmDialogHarness.props = props
    return null
  },
}))
vi.mock('@components/GfsImagePreview', () => ({
  GfsImagePreview: (props: NonNullable<typeof gfsPreviewHarness.props>) => {
    gfsPreviewHarness.props = props
    return null
  },
}))
vi.mock('@components/PluginConsentModal', () => ({
  PluginConsentModal: (props: NonNullable<typeof consentHarness.props>) => {
    consentHarness.props = props
    return <div data-testid="plugin-consent-modal" data-prompt-id={props.request.promptId} />
  },
}))
vi.mock('@components/SidebarNav', async importOriginal => {
  const actual = await importOriginal<typeof import('@components/SidebarNav')>()
  return {
    ...actual,
    SidebarNav: (props: Parameters<typeof actual.SidebarNav>[0]) => {
      sidebarHarness.props = props as NonNullable<typeof sidebarHarness.props>
      return sidebarHarness.renderActual ? <actual.SidebarNav {...props} /> : null
    },
  }
})
vi.mock('@pages/AgentsPage', () => ({ AgentsPage: () => null }))
vi.mock('@pages/AuthPage', () => ({ AuthPage: () => null }))
vi.mock('@pages/ChatPage', () => ({ ChatPage: () => null }))
vi.mock('@pages/ContextDetailsPage', () => ({ ContextDetailsPage: () => null }))
vi.mock('@pages/ContextsPage', () => ({ ContextsPage: () => null }))
vi.mock('@pages/FilesPage', () => ({ FilesPage: () => null }))
vi.mock('@pages/FilePreviewPage', () => ({ FilePreviewPage: () => null }))
vi.mock('@pages/McpServersPage', () => ({ McpServersPage: () => null }))
vi.mock('@pages/SettingsPage', () => ({ SettingsPage: () => null }))
vi.mock('@pages/SandboxUiPage', async importOriginal => {
  const actual = await importOriginal<typeof import('@pages/SandboxUiPage')>()
  return {
    ...actual,
    SandboxUiPage: (props: Parameters<typeof actual.SandboxUiPage>[0]) => {
      sandboxUiPageHarness.props = props
      return <actual.SandboxUiPage {...props} />
    },
  }
})
vi.mock('@pages/TeamDetailsPage', () => ({ TeamDetailsPage: () => null }))
vi.mock('@pages/TeamsPage', () => ({ TeamsPage: () => null }))
vi.mock('@pages/UnavailablePage', () => ({ UnavailablePage: () => null }))
vi.mock('@pages/WorkflowsPage', () => ({ WorkflowsPage: () => null }))

// Store-faithful controller (same contract as App.chatDrawer.test.tsx): `navItem`
// derives from the active tab, and every navigation drives the real store
// producers. A write lands in the store at once and reaches App on its next
// render, which is how a store update can be pending when a gesture runs.
function makeController(): AppController {
  const noop = vi.fn()
  let controller: AppController
  let tabSequence = 2
  let navigationIntentSequence = 0
  const beginNavigationIntent = () => {
    navigationIntentSequence += 1
    controller.navigationIntentSequence = navigationIntentSequence
    forceControllerRender()
    return navigationIntentSequence
  }
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
  const openPreviewSection = vi.fn((preview: GfsPreviewResource) => {
    controller.beginUserNavigationIntent()
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
  })
  const openFilesSection = vi.fn((path: string | null = null) => {
    controller.beginUserNavigationIntent()
    clearAppsPicker()
    setWorkspaceTabs((state: WorkspaceState) =>
      openFilesTab(state, { id: nextWorkspaceTabId(), path })
    )
  })
  const showAppsPicker = vi.fn(() => {
    controller.beginUserNavigationIntent()
    if (controller.appsPickerActive) return
    if (activeWorkspaceTab(controller.workspaceTabs)?.kind === 'app') return
    controller.appsPickerActive = true
    forceControllerRender()
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
    navigationIntentSequence,
    beginUserNavigationIntent: vi.fn(beginNavigationIntent),
    isNavigationIntentCurrent: vi.fn(sequence => sequence === navigationIntentSequence),
    captureWorkspaceNavigation: vi.fn(() => ({
      workspaceTabs: controller.workspaceTabs,
      selectedAgent: controller.selectedAgent,
      selectedAgentRoute: controller.selectedAgentRoute,
      appsPickerActive: controller.appsPickerActive,
      lastActiveChatTabId:
        activeWorkspaceTab(controller.workspaceTabs)?.kind === 'chat'
          ? (activeWorkspaceTab(controller.workspaceTabs)?.id ?? null)
          : null,
    })),
    restoreWorkspaceNavigation: vi.fn((snapshot, expectedIntentSequence) => {
      if (expectedIntentSequence !== navigationIntentSequence) return null
      const restoredIntent = beginNavigationIntent()
      controller.workspaceTabs = snapshot.workspaceTabs
      controller.selectedAgent = snapshot.selectedAgent
      controller.selectedAgentRoute = snapshot.selectedAgentRoute
      controller.appsPickerActive = snapshot.appsPickerActive
      controller.lastActiveChatTabId = snapshot.lastActiveChatTabId
      forceControllerRender()
      return restoredIntent
    }),
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
    handleSelectChatAgent: vi.fn(() => forceControllerRender()),
    handleOpenNotification: vi.fn(async () => undefined),
    handleNavSelect: vi.fn((item: string) => {
      if (item === DESKTOP_ROUTES.apps) showAppsPicker()
    }),
    handleLogout: vi.fn(),
    pushToast: vi.fn(),
    setStatus: noop,
    setBooting: noop,
  } as unknown as AppController
  return controller
}

const APP_LISTING: SandboxUiAppListing[] = [
  {
    appRef: 'sandbox-recipes/alpha',
    title: 'Alpha',
    defaultPath: '/',
    ready: true,
    phase: 'active',
    updatedAt: null,
  },
  {
    appRef: 'sandbox-recipes/beta',
    title: 'Beta',
    defaultPath: '/',
    ready: true,
    phase: 'active',
    updatedAt: null,
  },
]
// What the real sidebar hands to `onOpenSandboxUiApp`: App's own mapping of the
// listing it loaded.
const [ALPHA, BETA] = toActiveSandboxUiApps(APP_LISTING)

const MEASURED_SLOT = {
  x: 0,
  y: 0,
  top: 12,
  left: 16,
  right: 416,
  bottom: 312,
  width: 400,
  height: 300,
  toJSON: () => ({}),
} as DOMRect

function makeSandboxUiBridge(main: SandboxUiMainFake) {
  return {
    ...main.bridge,
    listApps: vi.fn().mockResolvedValue({ apps: APP_LISTING }),
    listPendingDeepLinks: vi.fn().mockResolvedValue({ links: [] }),
    clearPendingDeepLinks: vi.fn().mockResolvedValue(undefined),
    acknowledgeDeepLink: vi.fn().mockResolvedValue(undefined),
    onDeepLink: vi.fn(() => vi.fn()),
    onFindResult: vi.fn(() => vi.fn()),
    setVisible: vi.fn().mockResolvedValue(undefined),
    setBounds: vi.fn().mockResolvedValue(undefined),
    capturePreview: vi.fn().mockResolvedValue(null),
    stopFindInPage: vi.fn().mockResolvedValue(undefined),
    focusActive: vi.fn().mockResolvedValue(true),
  }
}

type OpenGfsPayload = Awaited<ReturnType<typeof openGfsResourcePayload>>

function latestListener<T>(subscribe: ReturnType<typeof vi.fn>): (event: T) => void {
  const calls = subscribe.mock.calls as unknown as Array<[(event: T) => void]>
  return calls[calls.length - 1]![0]
}

function flushMacrotask() {
  return act(async () => {
    await new Promise(resolve => window.setTimeout(resolve, 0))
  })
}

describe('App wires gestures and main events to the embed ownership machine', () => {
  let controller: AppController
  let openGfsResourceCb: ((resource: OpenGfsPayload) => void) | null
  let consentRequestedCb: ((request: PluginConsentRequest) => void) | null
  let consentCancelledCb: ((event: { promptId: string }) => void) | null
  let shortcutCommandCb: ((commandId: string, source: string) => void) | null
  let sandboxUi: ReturnType<typeof makeSandboxUiBridge>
  let main: SandboxUiMainFake
  // A `flushSync` from inside a render or effect does not flush: React only
  // warns about it. The seam depends on flushing, so the warning fails the test.
  let flushSyncErrors: string[]

  beforeEach(() => {
    vi.clearAllMocks()
    sidebarHarness.props = null
    sidebarHarness.renderActual = false
    confirmDialogHarness.props = null
    gfsPreviewHarness.props = null
    consentHarness.props = null
    sandboxUiPageHarness.props = null
    machineHarness.machine = null
    machineHarness.launches = []
    machineHarness.events = []
    machineHarness.afterDispatch = null
    openGfsResourceCb = null
    consentRequestedCb = null
    consentCancelledCb = null
    shortcutCommandCb = null
    flushSyncErrors = []
    const consoleError = console.error.bind(console)
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      const text = args.map(String).join(' ')
      if (text.includes('flushSync')) flushSyncErrors.push(text)
      else consoleError(...args)
    })
    controller = makeController()
    machineHarness.storeActiveTab = () => controller.workspaceTabs.activeTabId
    vi.mocked(useAppController).mockImplementation(() => useReactiveController(controller))
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0)
      return 1
    })
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = vi.fn()
        unobserve = vi.fn()
        disconnect = vi.fn()
      }
    )
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(MEASURED_SLOT)
    main = createSandboxUiMainFake()
    sandboxUi = makeSandboxUiBridge(main)
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        shortcuts: {
          onCommand: vi.fn((cb: (commandId: string, source: string) => void) => {
            shortcutCommandCb = cb
            return vi.fn()
          }),
        },
        app: { rendererReady: vi.fn().mockResolvedValue(undefined) },
        sandboxUi,
        pluginSdk: {
          onOpenGfsResource: vi.fn((cb: (resource: OpenGfsPayload) => void) => {
            openGfsResourceCb = cb
            return vi.fn()
          }),
          onConsentRequested: vi.fn((cb: (request: PluginConsentRequest) => void) => {
            consentRequestedCb = cb
            return vi.fn()
          }),
          onConsentCancelled: vi.fn((cb: (event: { promptId: string }) => void) => {
            consentCancelledCb = cb
            return vi.fn()
          }),
        },
      } as unknown as Window['clerum'],
    })
  })

  afterEach(async () => {
    cleanup()
    await new Promise(resolve => window.setTimeout(resolve, 0))
    await main.dispose()
    expect(flushSyncErrors).toEqual([])
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    delete (window as { clerum?: unknown }).clerum
  })

  function machine(): EmbedOwnershipMachine {
    const current = machineHarness.machine
    if (!current) throw new Error('App did not create its embed machine')
    return current
  }

  function owner() {
    const state = machine().getSnapshot()
    return state.owner === null ? undefined : state.views.get(state.owner)
  }

  // I-commit: every launch reaches the machine after the commit that activates
  // its tab was projected, or names a tab the store did not leave active.
  function expectLaunchesAfterTheirCommit(minLaunches: number) {
    expect(machineHarness.launches.length).toBeGreaterThanOrEqual(minLaunches)
    for (const entry of machineHarness.launches) {
      if (entry.storeActiveTab === entry.launch.tabId) {
        expect(entry.projectedTab).toBe(entry.launch.tabId)
      }
    }
  }

  async function renderApp() {
    // App mounts GfsDragSessionProvider, which reads Query state: the render
    // needs a real QueryClient (fresh per render, production cache defaults)
    // instead of the app-level singleton provider it gets in production.
    const queryClient = new QueryClient({ defaultOptions: desktopQueryDefaults })
    render(<App />, {
      wrapper: ({ children }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      ),
    })
    await waitFor(() => expect(sandboxUi.listApps).toHaveBeenCalled())
    await flushMacrotask()
  }

  async function openFromSidebar(app: typeof ALPHA, openCount: number) {
    act(() => sidebarHarness.props?.onOpenSandboxUiApp?.(app!))
    await waitFor(() => expect(sandboxUi.open).toHaveBeenCalledTimes(openCount))
    await flushMacrotask()
  }

  async function shortcut(commandId: string) {
    await act(async () => {
      shortcutCommandCb?.(commandId, 'host')
      await new Promise(resolve => window.setTimeout(resolve, 0))
    })
  }

  function tabOf(appRef: string) {
    return controller.workspaceTabs.tabs.find(tab => tab.app?.appRef === appRef)
  }

  function lastLaunch() {
    return machineHarness.launches.at(-1)!
  }

  it('launches a sidebar pick into its own new tab, named from the catalog', async () => {
    await renderApp()
    await openFromSidebar(ALPHA, 1)

    const tab = tabOf(ALPHA!.appRef)!
    expect(lastLaunch()).toMatchObject({
      type: 'intent',
      launch: {
        tabId: tab.id,
        appRef: ALPHA!.appRef,
        route: { kind: 'tab' },
        app: { label: 'Alpha', defaultPath: '/' },
      },
    })
    expect(main.openCall(0)).toMatchObject({
      launchId: lastLaunch().launch.launchId,
      title: 'Alpha',
    })
    expect(owner()?.phase).toBe('mounted')
    expect(await screen.findByRole('button', { name: 'Refresh app content' })).toBeTruthy()
    expect(sidebarHarness.props?.activeSandboxUiApp?.appRef).toBe(ALPHA!.appRef)
  })

  it('launches a picker-grid pick into its own new tab', async () => {
    await renderApp()
    act(() => sidebarHarness.props?.onSelect?.(DESKTOP_ROUTES.apps))
    fireEvent.click(await screen.findByRole('button', { name: 'Open Beta' }))
    await waitFor(() => expect(sandboxUi.open).toHaveBeenCalledTimes(1))

    expect(activeWorkspaceTab(controller.workspaceTabs)?.app?.appRef).toBe(BETA!.appRef)
    expect(lastLaunch().launch.tabId).toBe(controller.workspaceTabs.activeTabId)
    expectLaunchesAfterTheirCommit(1)
  })

  it('paints the launch as loading until main confirms the mount', async () => {
    await renderApp()
    const held = main.holdNextOpen()
    act(() => sidebarHarness.props?.onOpenSandboxUiApp?.(ALPHA!))
    await waitFor(() => expect(sandboxUi.open).toHaveBeenCalledTimes(1))

    expect(screen.getByText('Loading app')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Refresh app content' })).toBeNull()

    await act(async () => held().resolve())
    expect(await screen.findByRole('button', { name: 'Refresh app content' })).toBeTruthy()
    expect(screen.queryByText('Loading app')).toBeNull()
  })

  it('paints a rejected open as the failure banner of its tab', async () => {
    await renderApp()
    main.failNextOpen(new Error('open rejected'))
    act(() => sidebarHarness.props?.onOpenSandboxUiApp?.(ALPHA!))

    expect(await screen.findByText(`${ALPHA!.appRef}: open rejected`)).toBeTruthy()
    expect(screen.queryByTestId('sandbox-ui-mounted')).toBeNull()
    expect(sidebarHarness.props?.activeSandboxUiApp ?? null).toBeNull()
  })

  it('closes the view when the user leaves its tab and reopens it at the route it was left on', async () => {
    await renderApp()
    await openFromSidebar(ALPHA, 1)
    const first = main.openCall(0).launchId
    main.navigate('/inbox')

    fireEvent.click(screen.getByRole('button', { name: 'New chat', pressed: false }))
    await flushMacrotask()

    expect(sandboxUi.close).toHaveBeenCalledWith({ launchId: first })
    // The deactivation continuation persists the final route as main and both
    // ownership lanes settle.
    await act(() => main.settle())
    expect(tabOf(ALPHA!.appRef)?.app?.savedRoutePath).toBe('/inbox')

    fireEvent.click(screen.getByRole('button', { name: 'Alpha', pressed: false }))
    await waitFor(() => expect(sandboxUi.open).toHaveBeenCalledTimes(2))
    expect(lastLaunch()).toMatchObject({
      type: 'intent',
      launch: { route: { kind: 'tab', routePath: '/inbox' } },
    })
    expect(main.openCall(1).routePath).toBe('/inbox')
    expectLaunchesAfterTheirCommit(2)
  })

  it('leaves a live view alone when its active tab is clicked again (Q4)', async () => {
    await renderApp()
    await openFromSidebar(ALPHA, 1)

    fireEvent.click(screen.getByRole('button', { name: 'Alpha', pressed: true }))
    await flushMacrotask()

    expect(lastLaunch().type).toBe('intent')
    expect(sandboxUi.open).toHaveBeenCalledTimes(1)
    expect(sandboxUi.close).not.toHaveBeenCalled()
    expect(owner()?.launchId).toBe(main.openCall(0).launchId)
  })

  it('shows a crash with Reopen, which relaunches the tab through the seam', async () => {
    await renderApp()
    await openFromSidebar(ALPHA, 1)

    await act(() => main.crash())
    expect(await screen.findByText('The app closed unexpectedly.')).toBeTruthy()
    expect(sidebarHarness.props?.activeSandboxUiApp ?? null).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }))
    await waitFor(() => expect(sandboxUi.open).toHaveBeenCalledTimes(2))
    expect(lastLaunch()).toMatchObject({
      type: 'relaunch',
      launch: { tabId: tabOf(ALPHA!.appRef)!.id, route: { kind: 'tab' } },
    })
    expect(await screen.findByRole('button', { name: 'Refresh app content' })).toBeTruthy()
    expect(screen.queryByText('The app closed unexpectedly.')).toBeNull()
  })

  it('shows a crash while the app is still opening with Reopen (DEC-10)', async () => {
    await renderApp()
    const held = main.holdNextOpen()
    main.crashNextMount()
    act(() => sidebarHarness.props?.onOpenSandboxUiApp?.(ALPHA!))
    await waitFor(() => expect(sandboxUi.open).toHaveBeenCalledTimes(1))
    expect(screen.getByText('Loading app')).toBeTruthy()

    // The view mounts and its renderer dies before the open settles.
    held().resolve()
    expect(await screen.findByText('The app closed unexpectedly.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }))
    await waitFor(() => expect(sandboxUi.open).toHaveBeenCalledTimes(2))
    expect(lastLaunch().type).toBe('relaunch')
  })

  it('relaunches a dead view when its tab is clicked again', async () => {
    await renderApp()
    await openFromSidebar(ALPHA, 1)
    await act(() => main.crash())
    await screen.findByText('The app closed unexpectedly.')

    fireEvent.click(screen.getByRole('button', { name: 'Alpha', pressed: true }))
    await waitFor(() => expect(sandboxUi.open).toHaveBeenCalledTimes(2))
    expect(lastLaunch().type).toBe('intent')
  })

  it('reloads a healthy view in place from Refresh: same view, same route, no relaunch', async () => {
    await renderApp()
    await openFromSidebar(ALPHA, 1)
    const first = main.openCall(0).launchId
    main.navigate('/tickets/7')

    fireEvent.click(screen.getByRole('button', { name: 'Refresh app content' }))
    await act(() => main.settle())

    expect(main.liveReloads()).toBe(1)
    expect(main.live()).toEqual({ launchId: first, appRef: ALPHA!.appRef, routePath: '/tickets/7' })
    expect(sandboxUi.open).toHaveBeenCalledTimes(1)
    expect(sandboxUi.close).not.toHaveBeenCalled()
    expect(main.reported('sandboxUi:released')).toEqual([])
    expect(owner()?.launchId).toBe(first)
    expect(screen.getByRole('button', { name: 'Refresh app content' })).toBeTruthy()
  })

  it('reloads a healthy view in place from the app.refresh command', async () => {
    await renderApp()
    await openFromSidebar(ALPHA, 1)
    const first = main.openCall(0).launchId

    await shortcut('app.refresh')
    await act(() => main.settle())

    expect(main.liveReloads()).toBe(1)
    expect(main.live()?.launchId).toBe(first)
    expect(sandboxUi.open).toHaveBeenCalledTimes(1)
    expect(sandboxUi.close).not.toHaveBeenCalled()
    expect(flushSyncErrors).toEqual([])
  })

  // Refresh is offered while the last render showed a mounted view, but the
  // machine can move on before React renders again. Refresh then reopens the
  // tab: it never reloads a view that is not mounted, gone or still opening.
  it('relaunches from app.refresh when the view ended before React rendered it', async () => {
    await renderApp()
    await openFromSidebar(ALPHA, 1)
    const first = main.openCall(0).launchId

    await act(async () => {
      void main.crash()
      const release = main.reported('sandboxUi:released').at(-1) as Parameters<
        EmbedOwnershipMachine['onReleased']
      >[0]
      expect(release).toMatchObject({ launchId: first, reason: 'crashed' })
      machineHarness.machine!.onReleased(release)
      shortcutCommandCb?.('app.refresh', 'host')
    })
    await act(() => main.settle())

    expect(sandboxUi.reload).not.toHaveBeenCalled()
    expect(lastLaunch().type).toBe('relaunch')
    expect(main.live()?.launchId).toBe(main.openCall(1).launchId)
  })

  it('relaunches from app.refresh while the relaunch before it is still opening', async () => {
    await renderApp()
    await openFromSidebar(ALPHA, 1)
    await act(() => main.refreshFailed(new Error('mint failed')))
    const retry = await screen.findByRole('button', { name: 'Retry' })

    act(() => {
      fireEvent.click(retry)
      shortcutCommandCb?.('app.refresh', 'host')
    })
    await act(() => main.settle())

    expect(sandboxUi.reload).not.toHaveBeenCalled()
    expect(machineHarness.launches.slice(-2).map(entry => entry.type)).toEqual([
      'relaunch',
      'relaunch',
    ])
    expect(main.live()?.launchId).toBe(machineHarness.launches.at(-1)!.launch.launchId)
    expect(main.liveReloads()).toBe(0)
  })

  it("shows the live view's session failure with Retry, which relaunches it", async () => {
    await renderApp()
    await openFromSidebar(ALPHA, 1)
    const first = main.openCall(0).launchId

    await act(() => main.refreshFailed(new Error('mint failed')))
    expect(await screen.findByText('Session refresh failed: mint failed.')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(sandboxUi.open).toHaveBeenCalledTimes(2))
    expect(lastLaunch().type).toBe('relaunch')
    expect(sandboxUi.close).toHaveBeenCalledWith({ launchId: first })
    // The banner belonged to the view that was replaced.
    await waitFor(() => expect(screen.queryByText(/Session refresh failed/)).toBeNull())
  })

  it('clears the session failure and its Retry once a resumed refresh of the same view succeeds', async () => {
    await renderApp()
    await openFromSidebar(ALPHA, 1)
    const first = main.openCall(0).launchId
    main.navigate('/tickets/7')

    await act(() => main.refreshFailed(new Error('mint failed')))
    expect(await screen.findByText('Session refresh failed: mint failed.')).toBeTruthy()
    const liveBefore = main.live()

    await act(() => main.hostReturned())
    await act(() => main.settle())

    expect(main.reported('sandboxUi:refreshRecovered')).toEqual([
      { appRef: ALPHA!.appRef, launchId: first },
    ])
    await waitFor(() => expect(screen.queryByText(/Session refresh failed/)).toBeNull())
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    expect(sandboxUi.open).toHaveBeenCalledTimes(1)
    expect(sandboxUi.close).not.toHaveBeenCalled()
    expect(main.live()).toEqual(liveBefore)
    expect(main.live()).toEqual({ launchId: first, appRef: ALPHA!.appRef, routePath: '/tickets/7' })
  })

  // The machine drops a recovery of a launch that no longer owns the embed, so a
  // late one cannot take down the failure of the view that replaced it.
  it("keeps a relaunched view's session failure when a recovery of the view it replaced arrives late", async () => {
    await renderApp()
    await openFromSidebar(ALPHA, 1)
    const first = main.openCall(0).launchId
    await act(() => main.refreshFailed(new Error('mint failed')))
    await act(() => main.hostReturned())
    await act(() => main.settle())
    const staleRecovery = main.reported('sandboxUi:refreshRecovered').at(-1) as {
      appRef: string
      launchId: string
    }
    expect(staleRecovery).toEqual({ appRef: ALPHA!.appRef, launchId: first })

    await act(() => main.refreshFailed(new Error('mint failed')))
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(sandboxUi.open).toHaveBeenCalledTimes(2))
    await act(() => main.settle())
    const second = main.openCall(1).launchId
    expect(main.live()?.launchId).toBe(second)
    await act(() => main.refreshFailed(new Error('second view failed')))
    expect(await screen.findByText('Session refresh failed: second view failed.')).toBeTruthy()

    act(() => latestListener<typeof staleRecovery>(sandboxUi.onRefreshRecovered)(staleRecovery))
    await flushMacrotask()

    expect(screen.getByText('Session refresh failed: second view failed.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
  })

  it('ignores the session failure of a view it already replaced', async () => {
    await renderApp()
    await openFromSidebar(ALPHA, 1)
    const first = main.openCall(0).launchId

    // The replaced view's loop gives up before the open replacing it reaches main.
    act(() => sidebarHarness.props?.onOpenSandboxUiApp?.(BETA!))
    await act(() => main.refreshFailed(new Error('stale failure')))
    await act(() => main.settle())

    expect(main.reported('sandboxUi:refreshError')).toEqual([
      expect.objectContaining({ launchId: first, message: 'stale failure' }),
    ])
    expect(screen.queryByText(/Session refresh failed/)).toBeNull()
    expect(main.live()?.launchId).toBe(main.openCall(1).launchId)
  })

  it('goes back to apps on the app.backToApps command, keeping the tab', async () => {
    await renderApp()
    await openFromSidebar(ALPHA, 1)
    const alphaTab = controller.workspaceTabs.activeTabId

    await shortcut('app.backToApps')

    expect(machineHarness.events.at(-1)).toEqual({ type: 'backToApps' })
    expect(sandboxUi.close).toHaveBeenCalledWith({ launchId: main.openCall(0).launchId })
    expect(controller.workspaceTabs.activeTabId).toBe(alphaTab)
    expect(await screen.findByRole('button', { name: 'Open Beta' })).toBeTruthy()
  })

  it('renames the live tab after its title and ignores titles of other views', async () => {
    await renderApp()
    await openFromSidebar(ALPHA, 1)

    await act(() => main.retitle('Alpha Inbox'))
    expect(screen.getByRole('button', { name: 'Alpha Inbox', pressed: true })).toBeTruthy()

    // The view an open replaces retitles itself before that open reaches main.
    const first = main.openCall(0).launchId
    act(() => sidebarHarness.props?.onOpenSandboxUiApp?.(BETA!))
    await act(() => main.retitle('Stale'))
    await act(() => main.settle())

    expect(main.reported('sandboxUi:titleChanged')).toContainEqual(
      expect.objectContaining({ launchId: first, title: 'Stale' })
    )
    expect(main.live()?.launchId).toBe(main.openCall(1).launchId)
    expect(screen.getByRole('button', { name: 'Alpha Inbox', pressed: false })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Stale' })).toBeNull()
  })

  it('launches the app tab of a confirmed deep link at its explicit route and acks it once mounted', async () => {
    await renderApp()
    act(() =>
      latestListener<SandboxUiDeepLinkEnvelope>(sandboxUi.onDeepLink)({
        id: 1,
        appRef: ALPHA!.appRef,
        path: '/tasks/42',
      })
    )
    await waitFor(() => expect(confirmDialogHarness.props?.title).toBe('Open app link?'))
    await act(async () => confirmDialogHarness.props?.onConfirm())

    await waitFor(() => expect(sandboxUi.acknowledgeDeepLink).toHaveBeenCalledWith(1))
    expect(lastLaunch()).toMatchObject({
      type: 'intent',
      launch: { route: { kind: 'explicit', routePath: '/tasks/42' } },
    })
    expect(main.openCall(0).routePath).toBe('/tasks/42')
    expectLaunchesAfterTheirCommit(1)
  })

  it('acks a deep link left before it mounted without retrying it, and keeps the queue moving (K23)', async () => {
    await renderApp()
    // The user leaves the deep link's tab through a shortcut in the very turn
    // its launch reaches the machine, before anything else gets to render.
    machineHarness.afterDispatch = event => {
      if (event.type !== 'intent') return
      machineHarness.afterDispatch = null
      shortcutCommandCb?.('tabs.select1', 'host')
    }
    act(() =>
      latestListener<SandboxUiDeepLinkEnvelope>(sandboxUi.onDeepLink)({
        id: 1,
        appRef: ALPHA!.appRef,
      })
    )
    await waitFor(() => expect(confirmDialogHarness.props?.title).toBe('Open app link?'))
    await act(async () => confirmDialogHarness.props?.onConfirm())

    await waitFor(() => expect(sandboxUi.acknowledgeDeepLink).toHaveBeenCalledWith(1))
    expect(sandboxUi.open).not.toHaveBeenCalled()
    expect(controller.workspaceTabs.activeTabId).toBe('chat-tab-1')
    expect(machine().getSnapshot().views.size).toBe(0)

    act(() =>
      latestListener<SandboxUiDeepLinkEnvelope>(sandboxUi.onDeepLink)({
        id: 2,
        appRef: BETA!.appRef,
      })
    )
    await waitFor(() => expect(confirmDialogHarness.props?.title).toBe('Open app link?'))
    await act(async () => confirmDialogHarness.props?.onConfirm())
    await waitFor(() => expect(sandboxUi.acknowledgeDeepLink).toHaveBeenCalledWith(2))
    expect(main.openCall(0).recipeName).toBe('beta')
    expect(sandboxUi.acknowledgeDeepLink).toHaveBeenCalledTimes(2)
  })

  // App resolves app tabs against its own catalog, refreshed on window focus and
  // every 30 s. Firing the real focus listener drives that refresh.
  async function refreshCatalogOnFocus() {
    const calls = sandboxUi.listApps.mock.calls.length
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => expect(sandboxUi.listApps.mock.calls.length).toBeGreaterThan(calls))
    await flushMacrotask()
  }

  const BETA_RESTARTING: SandboxUiAppListing[] = APP_LISTING.map(app =>
    app.appRef === BETA!.appRef ? { ...app, ready: false, phase: 'pending' } : app
  )

  it('closes the live view and shows the picker for an app tab the catalog cannot resolve, then relaunches it named from the catalog', async () => {
    await renderApp()
    await openFromSidebar(BETA, 1)
    // The app renames its own tab; that title must never name it to main.
    await act(() => main.retitle('Beta Inbox'))
    await openFromSidebar(ALPHA, 2)
    const alpha = main.openCall(1).launchId
    const betaTab = tabOf(BETA!.appRef)!

    // Beta's pod restarts: App's next refresh drops it from the resolvable list.
    sandboxUi.listApps.mockResolvedValue({ apps: BETA_RESTARTING })
    await refreshCatalogOnFocus()
    main.navigate('/inbox')
    fireEvent.click(screen.getByRole('button', { name: 'Beta Inbox', pressed: false }))
    // Alpha retitles itself before the close the click sent reaches main.
    await act(() => main.retitle('Alpha Late'))
    await act(() => main.settle())

    expect(sandboxUi.close).toHaveBeenCalledWith({ launchId: alpha })
    expect(sandboxUi.open).toHaveBeenCalledTimes(2)
    expect(controller.workspaceTabs.activeTabId).toBe(betaTab.id)
    expect(owner()).toBeUndefined()
    expect(screen.queryByTestId('sandbox-ui-mounted')).toBeNull()
    expect(await screen.findByRole('button', { name: 'Open Alpha' })).toBeTruthy()
    // Alpha's late title does not relabel Beta, and Alpha keeps its route.
    expect(main.reported('sandboxUi:titleChanged')).toContainEqual(
      expect.objectContaining({ launchId: alpha, title: 'Alpha Late' })
    )
    expect(controller.workspaceTabs.tabs.find(tab => tab.id === betaTab.id)?.title).toBe(
      'Beta Inbox'
    )
    expect(tabOf(ALPHA!.appRef)?.app?.savedRoutePath).toBe('/inbox')

    // Beta is ready again: clicking its tab relaunches it.
    sandboxUi.listApps.mockResolvedValue({ apps: APP_LISTING })
    await refreshCatalogOnFocus()
    fireEvent.click(screen.getByRole('button', { name: 'Beta Inbox', pressed: true }))
    await waitFor(() => expect(sandboxUi.open).toHaveBeenCalledTimes(3))
    expect(main.openCall(2)).toMatchObject({ recipeName: 'beta', title: 'Beta' })
    expect(await screen.findByRole('button', { name: 'Refresh app content' })).toBeTruthy()
  })

  it('does not relaunch a grid-opened app tab App has not resolved yet when the user returns to it', async () => {
    // App's catalog predates Beta becoming ready.
    sandboxUi.listApps.mockResolvedValue({ apps: BETA_RESTARTING })
    await renderApp()
    await openFromSidebar(ALPHA, 1)

    // Beta turns ready between App refreshes; the picker grid loads its own list.
    sandboxUi.listApps.mockResolvedValue({ apps: APP_LISTING })
    fireEvent.click(screen.getByRole('button', { name: 'New chat', pressed: false }))
    await flushMacrotask()
    act(() => sidebarHarness.props?.onSelect?.(DESKTOP_ROUTES.apps))
    fireEvent.click(await screen.findByRole('button', { name: 'Open Beta' }))
    await waitFor(() => expect(sandboxUi.open).toHaveBeenCalledTimes(2))
    expect(main.openCall(1)).toMatchObject({ recipeName: 'beta', title: 'Beta' })
    const betaTab = activeWorkspaceTab(controller.workspaceTabs)!
    await flushMacrotask()

    fireEvent.click(screen.getByRole('button', { name: 'Alpha', pressed: false }))
    await waitFor(() => expect(sandboxUi.open).toHaveBeenCalledTimes(3))
    await flushMacrotask()

    // Back to Beta before App's next refresh: it cannot be relaunched yet.
    fireEvent.click(screen.getByRole('button', { name: 'Beta', pressed: false }))
    await flushMacrotask()
    expect(sandboxUi.open).toHaveBeenCalledTimes(3)
    expect(sandboxUi.close).toHaveBeenLastCalledWith({ launchId: main.openCall(2).launchId })
    expect(controller.workspaceTabs.activeTabId).toBe(betaTab.id)
    expect(screen.queryByTestId('sandbox-ui-mounted')).toBeNull()

    await refreshCatalogOnFocus()
    fireEvent.click(screen.getByRole('button', { name: 'Beta', pressed: true }))
    await waitFor(() => expect(sandboxUi.open).toHaveBeenCalledTimes(4))
    expect(main.openCall(3).recipeName).toBe('beta')
  })

  it('opens a grid pick App has not resolved yet as its own tab, leaving the tab it was picked from intact', async () => {
    // App's catalog predates Beta becoming ready; the page's grid sees it ready.
    sandboxUi.listApps.mockResolvedValueOnce({ apps: BETA_RESTARTING })
    await renderApp()
    await openFromSidebar(ALPHA, 1)
    const alphaTab = activeWorkspaceTab(controller.workspaceTabs)!

    await shortcut('app.backToApps')
    fireEvent.click(await screen.findByRole('button', { name: 'Open Beta' }))

    await waitFor(() => expect(sandboxUi.open).toHaveBeenCalledTimes(2))
    expect(main.openCall(1)).toMatchObject({ recipeName: 'beta', title: 'Beta' })
    const active = activeWorkspaceTab(controller.workspaceTabs)!
    expect(active.id).not.toBe(alphaTab.id)
    expect(owner()?.tabId).toBe(active.id)
    expect(await screen.findByRole('button', { name: 'Refresh app content' })).toBeTruthy()
    const alphaAfter = controller.workspaceTabs.tabs.find(tab => tab.id === alphaTab.id)
    expect(alphaAfter?.app?.appRef).toBe(ALPHA!.appRef)
  })

  // A store update can be pending when a gesture runs (here, one written while
  // App had not rendered yet). The reveal is picked from App's last render, but
  // the updater lands on the pending store: the launch must follow the store.
  function seedTabs(): void {
    let state = createWorkspaceTabsState('chat-tab-1')
    state = openAppTab(state, { id: 'ws-tab-90', appRef: ALPHA!.appRef, title: 'Alpha' })
    state = newChatTab(state, 'ws-tab-91', null)
    controller.workspaceTabs = state
  }

  it('launches the app tab a relative shortcut lands on over a pending store update (DEC-9 a)', async () => {
    seedTabs()
    await renderApp()
    // Tabs: [New chat, Alpha, New chat (active)]. From App's render, "next"
    // wraps to the first chat; from the pending store it reaches Alpha.
    act(() => {
      controller.setWorkspaceTabs(state => selectWorkspaceTab(state, 'chat-tab-1'))
      shortcutCommandCb?.('tabs.next', 'host')
    })
    await waitFor(() => expect(sandboxUi.open).toHaveBeenCalledTimes(1))

    expect(controller.workspaceTabs.activeTabId).toBe('ws-tab-90')
    expect(owner()?.tabId).toBe('ws-tab-90')
    expect(await screen.findByRole('button', { name: 'Refresh app content' })).toBeTruthy()
    expectLaunchesAfterTheirCommit(1)
  })

  it('launches the app neighbour of a tab closed right after a pending update activated it', async () => {
    seedTabs()
    await renderApp()
    // Tabs: [New chat (chat-tab-1), Alpha, New chat (active)]. The pending update
    // activates chat-tab-1; the user closes it from the strip App last rendered.
    act(() => {
      controller.setWorkspaceTabs(state => selectWorkspaceTab(state, 'chat-tab-1'))
      fireEvent.click(screen.getAllByRole('button', { name: 'Close New chat' })[0]!)
    })
    await flushMacrotask()

    expect(controller.workspaceTabs.activeTabId).toBe('ws-tab-90')
    expect(owner()?.tabId).toBe('ws-tab-90')
    expect(sandboxUi.open).toHaveBeenCalledTimes(1)
  })

  it('launches an app tab a pending update activated when the user closes another tab', async () => {
    seedTabs()
    await renderApp()
    // Tabs: [New chat (chat-tab-1), Alpha, New chat (active)]. The pending update
    // activates Alpha; the user closes chat-tab-1, which is active in neither.
    act(() => {
      controller.setWorkspaceTabs(state => selectWorkspaceTab(state, 'ws-tab-90'))
      fireEvent.click(screen.getAllByRole('button', { name: 'Close New chat' })[0]!)
    })
    await flushMacrotask()

    expect(controller.workspaceTabs.tabs.map(tab => tab.id)).toEqual(['ws-tab-90', 'ws-tab-91'])
    expect(controller.workspaceTabs.activeTabId).toBe('ws-tab-90')
    expect(owner()?.tabId).toBe('ws-tab-90')
    expect(sandboxUi.open).toHaveBeenCalledTimes(1)
    expect(main.openCall(0).recipeName).toBe('alpha')
  })

  it('does not relaunch a failed app tab when another tab is closed', async () => {
    await renderApp()
    main.failNextOpen(new Error('open rejected'))
    act(() => sidebarHarness.props?.onOpenSandboxUiApp?.(ALPHA!))
    expect(await screen.findByText(`${ALPHA!.appRef}: open rejected`)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Close New chat' }))
    await flushMacrotask()

    expect(controller.workspaceTabs.tabs.map(tab => tab.id)).toEqual([tabOf(ALPHA!.appRef)!.id])
    expect(sandboxUi.open).toHaveBeenCalledTimes(1)
    expect(machineHarness.launches).toHaveLength(1)
    expect(screen.getByText(`${ALPHA!.appRef}: open rejected`)).toBeTruthy()
  })

  it('launches nothing when a pending reset removed the tab a shortcut picked (DEC-9 b)', async () => {
    seedTabs()
    await renderApp()
    act(() => {
      controller.setWorkspaceTabs(createWorkspaceTabsState('chat-tab-1'))
      shortcutCommandCb?.('tabs.select2', 'host')
    })
    await flushMacrotask()

    expect(controller.workspaceTabs.activeTabId).toBe('chat-tab-1')
    expect(machineHarness.launches).toEqual([])
    expect(sandboxUi.open).not.toHaveBeenCalled()
    expect(sidebarHarness.props?.activeSandboxUiApp ?? null).toBeNull()
  })

  it('launches every tab shortcut and strip gesture after its commit (I-commit)', async () => {
    await renderApp()
    await openFromSidebar(ALPHA, 1)
    await openFromSidebar(BETA, 2)
    // Tabs: [New chat, Alpha, Beta].
    // After every gesture an active app tab has a launch that owns it (T4).
    const expectActiveAppTabOwned = () => {
      const active = activeWorkspaceTab(controller.workspaceTabs)
      if (active?.kind !== 'app') return
      expect(owner()?.tabId).toBe(active.id)
      expect(owner()?.appRef).toBe(active.app?.appRef)
    }
    for (const commandId of [
      'tabs.select1',
      'tabs.select2',
      'tabs.next',
      'tabs.previous',
      'tabs.selectLast',
      'tabs.select1',
      'chat.closeTab',
    ]) {
      await shortcut(commandId)
      expectActiveAppTabOwned()
    }
    fireEvent.click(screen.getByRole('button', { name: 'Beta', pressed: false }))
    await flushMacrotask()

    expect(owner()?.appRef).toBe(BETA!.appRef)
    expectActiveAppTabOwned()
    expect(await screen.findByRole('button', { name: 'Refresh app content' })).toBeTruthy()
    expectLaunchesAfterTheirCommit(7)
  })

  it('closes the view when a plugin hands off to a preview tab', async () => {
    await renderApp()
    await openFromSidebar(ALPHA, 1)
    const navigationIntentBeforePlugin = controller.navigationIntentSequence
    const payload = await openGfsResourcePayload(
      resolvedFile('md1', 'README.md', { gfsUri: 'gfs://main/md1' })
    )
    act(() => openGfsResourceCb?.(payload))
    await flushMacrotask()

    expect(controller.navItem).toBe(DESKTOP_ROUTES.preview)
    expect(controller.navigationIntentSequence).toBe(navigationIntentBeforePlugin + 1)
    expect(sandboxUi.close).toHaveBeenCalledWith({ launchId: main.openCall(0).launchId })
    await act(() => main.settle())
    expect(machine().getSnapshot().views.size).toBe(0)
  })

  it('opens a tab at the route the store kept for it when the machine has none', async () => {
    // A route the store holds that no view of this renderer reported (the store
    // outlived the views that left it).
    let state = createWorkspaceTabsState('chat-tab-1')
    state = openAppTab(state, { id: 'ws-tab-90', appRef: ALPHA!.appRef, title: 'Alpha' })
    state = setAppTabSavedRoutePath(state, 'ws-tab-90', '/kept')
    state = selectWorkspaceTab(state, 'chat-tab-1')
    controller.workspaceTabs = state
    await renderApp()

    fireEvent.click(screen.getByRole('button', { name: 'Alpha', pressed: false }))
    await waitFor(() => expect(sandboxUi.open).toHaveBeenCalledTimes(1))

    expect(lastLaunch().launch.route).toEqual({ kind: 'tab', routePath: '/kept' })
    expect(main.openCall(0).routePath).toBe('/kept')
  })

  it('keeps its machine alive through StrictMode effect replay', async () => {
    const queryClient = new QueryClient({ defaultOptions: desktopQueryDefaults })
    render(
      <StrictMode>
        <App />
      </StrictMode>,
      {
        wrapper: ({ children }) => (
          <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        ),
      }
    )
    await waitFor(() => expect(sandboxUi.listApps).toHaveBeenCalled())
    await flushMacrotask()

    act(() => sidebarHarness.props?.onOpenSandboxUiApp?.(ALPHA!))
    await waitFor(() => expect(sandboxUi.open).toHaveBeenCalledTimes(1))
    expect(await screen.findByRole('button', { name: 'Refresh app content' })).toBeTruthy()
  })

  it('transfers compact-close focus to the visible current route after desktop entry', async () => {
    let modeChange: ((event: MediaQueryListEvent) => void) | null = null
    const media = {
      matches: true,
      media: '(max-width: 759px)',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn((_type: string, listener: EventListenerOrEventListenerObject) => {
        modeChange = listener as (event: MediaQueryListEvent) => void
      }),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => media)
    )
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue({
      length: 1,
      item: () => null,
      [Symbol.iterator]: function* () {
        yield {} as DOMRect
      },
    } as DOMRectList)
    sidebarHarness.renderActual = true

    await renderApp()
    const trigger = screen.getByTestId('compact-navigation-toggle')
    expect(sidebarHarness.props?.compactMode).toBe(true)
    fireEvent.click(trigger)
    await waitFor(() => expect(sidebarHarness.props?.compactMenuOpen).toBe(true))
    expect(document.querySelector('#desktop-sidebar-navigation')).toBeTruthy()
    const close = document.querySelector('.sidebar-compact-close') as HTMLElement
    expect(close).toBeTruthy()
    close.focus()
    expect(document.activeElement).toBe(close)

    act(() => {
      media.matches = false
      modeChange?.({ matches: false } as MediaQueryListEvent)
    })

    const routeItem = screen.getByTestId('nav-chat')
    await waitFor(() => {
      expect(document.activeElement).toBe(routeItem)
      expect(routeItem.closest('[inert], [aria-hidden="true"]')).toBeNull()
      expect(document.querySelector('.left-nav.compact-open')).toBeNull()
    })
    expect(routeItem.isConnected).toBe(true)
    expect(routeItem.getAttribute('data-compact-navigation-focus-owner')).toBe('true')
    sidebarHarness.renderActual = false
  })

  it('transfers settled compact-trigger focus to desktop navigation after mode entry', async () => {
    let modeChange: ((event: MediaQueryListEvent) => void) | null = null
    const media = {
      matches: true,
      media: '(max-width: 759px)',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn((_type: string, listener: EventListenerOrEventListenerObject) => {
        modeChange = listener as (event: MediaQueryListEvent) => void
      }),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => media)
    )
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue({
      length: 1,
      item: () => null,
      [Symbol.iterator]: function* () {
        yield {} as DOMRect
      },
    } as DOMRectList)
    sidebarHarness.renderActual = true

    await renderApp()
    fireEvent.click(screen.getByTestId('compact-navigation-toggle'))
    await waitFor(() => expect(sidebarHarness.props?.compactMenuOpen).toBe(true))

    const close = document.querySelector('.sidebar-compact-close') as HTMLElement
    const trigger = screen.getByTestId('compact-navigation-toggle')
    expect(close).toBeTruthy()
    close.focus()
    fireEvent.click(close)
    await waitFor(() => {
      expect(sidebarHarness.props?.compactMenuOpen).toBe(false)
      expect(document.activeElement).toBe(trigger)
    })

    act(() => {
      media.matches = false
      modeChange?.({ matches: false } as MediaQueryListEvent)
    })

    const routeItem = screen.getByTestId('nav-chat')
    await waitFor(() => {
      expect(document.activeElement).toBe(routeItem)
      expect(routeItem.closest('[inert], [aria-hidden="true"]')).toBeNull()
      expect(document.querySelector('.left-nav.compact-open')).toBeNull()
    })
    expect(routeItem.isConnected).toBe(true)
    expect(routeItem.getAttribute('data-compact-navigation-focus-owner')).toBe('true')
    sidebarHarness.renderActual = false
  })

  it('transfers settled dismissal focus when desktop CSS already cleared trigger focus', async () => {
    let modeChange: ((event: MediaQueryListEvent) => void) | null = null
    const media = {
      matches: true,
      media: '(max-width: 759px)',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn((_type: string, listener: EventListenerOrEventListenerObject) => {
        modeChange = listener as (event: MediaQueryListEvent) => void
      }),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => media)
    )
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue({
      length: 1,
      item: () => null,
      [Symbol.iterator]: function* () {
        yield {} as DOMRect
      },
    } as DOMRectList)
    sidebarHarness.renderActual = true

    await renderApp()
    const trigger = screen.getByTestId('compact-navigation-toggle')
    fireEvent.click(trigger)
    await waitFor(() => expect(sidebarHarness.props?.compactMenuOpen).toBe(true))

    const close = document.querySelector('.sidebar-compact-close') as HTMLElement
    close.focus()
    fireEvent.click(close)
    await waitFor(() => {
      expect(sidebarHarness.props?.compactMenuOpen).toBe(false)
      expect(document.activeElement).toBe(trigger)
    })

    // The media-query CSS hides this control before React's mode commit. Model
    // the browser clearing its focus while the trigger becomes display:none.
    trigger.blur()
    expect(document.activeElement).toBe(document.body)
    act(() => {
      media.matches = false
      modeChange?.({ matches: false } as MediaQueryListEvent)
    })

    const routeItem = screen.getByTestId('nav-chat')
    await waitFor(() => {
      expect(document.activeElement).toBe(routeItem)
      expect(routeItem.closest('[inert], [aria-hidden="true"]')).toBeNull()
      expect(document.querySelector('.left-nav.compact-open')).toBeNull()
    })
    expect(routeItem.isConnected).toBe(true)
    expect(routeItem.getAttribute('data-compact-navigation-focus-owner')).toBe('true')
    sidebarHarness.renderActual = false
  })

  it('preserves a later desktop control focus after settled compact dismissal', async () => {
    let modeChange: ((event: MediaQueryListEvent) => void) | null = null
    const media = {
      matches: true,
      media: '(max-width: 759px)',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn((_type: string, listener: EventListenerOrEventListenerObject) => {
        modeChange = listener as (event: MediaQueryListEvent) => void
      }),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => media)
    )
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue({
      length: 1,
      item: () => null,
      [Symbol.iterator]: function* () {
        yield {} as DOMRect
      },
    } as DOMRectList)
    sidebarHarness.renderActual = true

    await renderApp()
    const trigger = screen.getByTestId('compact-navigation-toggle')
    fireEvent.click(trigger)
    await waitFor(() => expect(sidebarHarness.props?.compactMenuOpen).toBe(true))
    const close = document.querySelector('.sidebar-compact-close') as HTMLElement
    close.focus()
    fireEvent.click(close)
    await waitFor(() => expect(document.activeElement).toBe(trigger))

    const windowControl = screen.getByRole('button', { name: 'Minimize window' })
    windowControl.focus()
    expect(document.activeElement).toBe(windowControl)
    act(() => {
      media.matches = false
      modeChange?.({ matches: false } as MediaQueryListEvent)
    })

    await waitFor(() => expect(document.querySelector('.left-nav.compact-open')).toBeNull())
    expect(document.activeElement).toBe(windowControl)
    sidebarHarness.renderActual = false
  })

  it('clears compact Settings before revealing native content on desktop entry', async () => {
    let modeChange: ((event: MediaQueryListEvent) => void) | null = null
    const media = {
      matches: true,
      media: '(max-width: 759px)',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn((_type: string, listener: EventListenerOrEventListenerObject) => {
        modeChange = listener as (event: MediaQueryListEvent) => void
      }),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => media)
    )
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue({
      length: 1,
      item: () => null,
      [Symbol.iterator]: function* () {
        yield {} as DOMRect
      },
    } as DOMRectList)
    sidebarHarness.renderActual = true

    await renderApp()
    await waitFor(() => expect(sidebarHarness.props?.compactMode).toBe(true))
    act(() => sidebarHarness.props?.onOpenSandboxUiApp?.(ALPHA!))
    await waitFor(() => expect(sandboxUi.open).toHaveBeenCalledTimes(1))
    await flushMacrotask()

    fireEvent.click(screen.getByTestId('compact-navigation-toggle'))
    await waitFor(() => expect(sidebarHarness.props?.compactMenuOpen).toBe(true))
    const settings = screen.getByTestId('nav-settings-menu')
    fireEvent.click(settings)
    expect(settings.getAttribute('aria-expanded')).toBe('true')
    const focusedSettingsItem = document.querySelector(
      '.sidebar-settings-menu [role="menuitem"]'
    ) as HTMLElement
    focusedSettingsItem.focus()
    expect(document.activeElement).toBe(focusedSettingsItem)
    await waitFor(() => expect(sandboxUiPageHarness.props?.sidebarShellOverlayOpen).toBe(true))
    expect(sandboxUi.setVisible).toHaveBeenLastCalledWith(false)

    act(() => {
      media.matches = false
      modeChange?.({ matches: false } as MediaQueryListEvent)
    })

    await waitFor(() => {
      expect(sidebarHarness.props?.compactMenuOpen).toBe(false)
      expect(document.querySelector('.sidebar-settings-menu')).toBeNull()
      expect(settings.getAttribute('aria-expanded')).toBe('false')
      expect(sandboxUiPageHarness.props?.sidebarShellOverlayOpen).toBe(false)
    })
    const routeItem = screen.getByTestId('nav-sandbox-ui')
    await waitFor(() => expect(document.activeElement).toBe(routeItem))
    expect(routeItem.isConnected).toBe(true)
    expect(routeItem.closest('[inert], [aria-hidden="true"]')).toBeNull()
    await waitFor(() => expect(sandboxUi.setVisible).toHaveBeenLastCalledWith(true))
    const finalVisibleCall = sandboxUi.setVisible.mock.invocationCallOrder.at(-1)
    const finalBoundsCall = sandboxUi.setBounds.mock.invocationCallOrder.at(-1)
    expect(finalBoundsCall).toBeDefined()
    expect(finalVisibleCall).toBeGreaterThan(finalBoundsCall!)
    sidebarHarness.renderActual = false
  })

  it('keeps the native view hidden while compact navigation alone is open', async () => {
    const media = {
      matches: true,
      media: '(max-width: 759px)',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }
    vi.stubGlobal('innerWidth', 700)
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => media)
    )
    sidebarHarness.renderActual = true

    await renderApp()
    act(() => sidebarHarness.props?.onOpenSandboxUiApp?.(ALPHA!))
    await waitFor(() => expect(sandboxUi.open).toHaveBeenCalledTimes(1))
    await flushMacrotask()
    await waitFor(() => expect(sandboxUi.setVisible).toHaveBeenLastCalledWith(true))
    sandboxUi.setVisible.mockClear()

    fireEvent.click(screen.getByTestId('compact-navigation-toggle'))
    await waitFor(() => expect(sidebarHarness.props?.compactMenuOpen).toBe(true))
    expect(screen.queryByRole('menu', { name: 'Settings' })).toBeNull()
    expect(screen.getByTestId('nav-settings-menu').getAttribute('aria-expanded')).toBe('false')
    await waitFor(() => expect(sandboxUiPageHarness.props?.sidebarShellOverlayOpen).toBe(true))
    await waitFor(() => expect(sandboxUi.setVisible).toHaveBeenLastCalledWith(false))
    expect(sandboxUi.setVisible.mock.calls.some(([visible]) => visible === true)).toBe(false)

    fireEvent.click(document.querySelector('.sidebar-compact-close') as HTMLElement)
    await waitFor(() => expect(sidebarHarness.props?.compactMenuOpen).toBe(false))
    await waitFor(() => expect(sandboxUiPageHarness.props?.sidebarShellOverlayOpen).toBe(false))
    await waitFor(() => expect(sandboxUi.setVisible).toHaveBeenLastCalledWith(true))
    sidebarHarness.renderActual = false
  })

  it('cancels a live resize in the App breakpoint event before React commits compact mode', async () => {
    let modeChange: ((event: MediaQueryListEvent) => void) | null = null
    const media = {
      matches: false,
      media: '(max-width: 759px)',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn((_type: string, listener: EventListenerOrEventListenerObject) => {
        modeChange = listener as (event: MediaQueryListEvent) => void
      }),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }
    vi.stubGlobal('innerWidth', 1200)
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => media)
    )
    vi.stubGlobal(
      'PointerEvent',
      class extends MouseEvent {
        pointerId: number
        isPrimary: boolean

        constructor(type: string, init: PointerEventInit = {}) {
          super(type, init)
          this.pointerId = init.pointerId ?? 0
          this.isPrimary = init.isPrimary ?? true
        }
      }
    )
    Object.defineProperty(window, 'PointerEvent', {
      configurable: true,
      value: (globalThis as { PointerEvent?: unknown }).PointerEvent,
    })
    window.localStorage.setItem('clerum.ui.sidebarWidth', '460')
    sidebarHarness.renderActual = true

    await renderApp()
    const separator = document.querySelector('.sidebar-resize-handle') as HTMLElement
    expect(separator).toBeTruthy()
    fireEvent.pointerDown(separator, { button: 0, clientX: 460, pointerId: 73 })
    fireEvent.pointerMove(separator, { clientX: 450, pointerId: 73 })
    expect(window.localStorage.getItem('clerum.ui.sidebarWidth')).toBe('460')
    expect(document.body.classList.contains('sidebar-resizing')).toBe(true)

    act(() => {
      media.matches = true
      modeChange?.({ matches: true } as MediaQueryListEvent)
      fireEvent.pointerUp(separator, { clientX: 450, pointerId: 73 })
    })

    await waitFor(() => expect(sidebarHarness.props?.compactMode).toBe(true))
    expect(window.localStorage.getItem('clerum.ui.sidebarWidth')).toBe('460')
    expect(document.body.classList.contains('sidebar-resizing')).toBe(false)

    act(() => {
      media.matches = false
      modeChange?.({ matches: false } as MediaQueryListEvent)
    })
    await waitFor(() => expect(sidebarHarness.props?.compactMode).toBe(false))
    expect(document.querySelector('.sidebar-resize-handle')?.getAttribute('aria-valuenow')).toBe(
      '460'
    )
    sidebarHarness.renderActual = false
  })

  it('keeps the native view hidden after compact Settings closes while a GFS preview remains open', async () => {
    const media = {
      matches: true,
      media: '(max-width: 759px)',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }
    vi.stubGlobal('innerWidth', 700)
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => media)
    )
    sidebarHarness.renderActual = true

    await renderApp()
    act(() => sidebarHarness.props?.onOpenSandboxUiApp?.(ALPHA!))
    await waitFor(() => expect(sandboxUi.open).toHaveBeenCalledTimes(1))
    await flushMacrotask()
    sandboxUi.setVisible.mockClear()
    sandboxUi.setBounds.mockClear()

    fireEvent.click(screen.getByTestId('compact-navigation-toggle'))
    await waitFor(() => expect(sidebarHarness.props?.compactMenuOpen).toBe(true))
    const settings = screen.getByTestId('nav-settings-menu')
    fireEvent.click(settings)
    expect(settings.getAttribute('aria-expanded')).toBe('true')
    expect(sandboxUiPageHarness.props?.sidebarShellOverlayOpen).toBe(true)

    const payload = await openGfsResourcePayload(
      resolvedFile('img1', 'image.png', {
        gfsUri: 'gfs://main/img1.png',
      })
    )
    act(() => openGfsResourceCb?.(payload))
    await waitFor(() => expect(sandboxUiPageHarness.props?.appRootOverlayOpen).toBe(true))

    fireEvent.click(document.querySelector('.sidebar-compact-close') as HTMLElement)
    await waitFor(() => expect(sidebarHarness.props?.compactMenuOpen).toBe(false))
    expect(document.querySelector('.sidebar-settings-menu')).toBeNull()
    expect(settings.getAttribute('aria-expanded')).toBe('false')
    expect(sandboxUiPageHarness.props?.sidebarShellOverlayOpen).toBe(false)
    expect(sandboxUiPageHarness.props?.appRootOverlayOpen).toBe(true)
    expect(sandboxUi.setVisible.mock.calls.some(([visible]) => visible === true)).toBe(false)

    act(() => gfsPreviewHarness.props?.onClose())
    await waitFor(() => expect(sandboxUiPageHarness.props?.appRootOverlayOpen).toBe(false))
    await waitFor(() =>
      expect(sandboxUi.setVisible.mock.calls.some(([visible]) => visible === true)).toBe(true)
    )
    const finalVisibleCall = sandboxUi.setVisible.mock.calls
      .map(([visible]) => visible)
      .lastIndexOf(true)
    const finalBoundsCall = sandboxUi.setBounds.mock.invocationCallOrder.at(-1)
    const visibleCallOrder = sandboxUi.setVisible.mock.invocationCallOrder[finalVisibleCall]
    expect(finalBoundsCall).toBeDefined()
    expect(visibleCallOrder).toBeGreaterThan(finalBoundsCall!)
    sidebarHarness.renderActual = false
  })

  it('clears the App Settings owner on the real sidebar shortcut while GFS still blocks reveal', async () => {
    const media = {
      matches: true,
      media: '(max-width: 759px)',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }
    vi.stubGlobal('innerWidth', 700)
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => media)
    )
    sidebarHarness.renderActual = true

    await renderApp()
    act(() => sidebarHarness.props?.onOpenSandboxUiApp?.(ALPHA!))
    await waitFor(() => expect(sandboxUi.open).toHaveBeenCalledTimes(1))
    await flushMacrotask()
    sandboxUi.setVisible.mockClear()

    fireEvent.click(screen.getByTestId('compact-navigation-toggle'))
    await waitFor(() => expect(sidebarHarness.props?.compactMenuOpen).toBe(true))
    const settings = screen.getByTestId('nav-settings-menu')
    fireEvent.click(settings)
    expect(settings.getAttribute('aria-expanded')).toBe('true')
    expect(sandboxUiPageHarness.props?.sidebarShellOverlayOpen).toBe(true)

    const payload = await openGfsResourcePayload(
      resolvedFile('img5', 'fifth.png', { gfsUri: 'gfs://main/img5.png' })
    )
    act(() => openGfsResourceCb?.(payload))
    await waitFor(() => expect(sandboxUiPageHarness.props?.appRootOverlayOpen).toBe(true))

    act(() => shortcutCommandCb?.('sidebar.toggle', 'host'))
    await waitFor(() => expect(sidebarHarness.props?.compactMenuOpen).toBe(false))
    expect(document.querySelector('.sidebar-settings-menu')).toBeNull()
    expect(settings.getAttribute('aria-expanded')).toBe('false')
    expect(sandboxUiPageHarness.props?.sidebarShellOverlayOpen).toBe(false)
    expect(sandboxUiPageHarness.props?.appRootOverlayOpen).toBe(true)
    expect(sandboxUi.setVisible.mock.calls.some(([visible]) => visible === true)).toBe(false)
    sidebarHarness.renderActual = false
  })

  it('keeps a GFS preview blocking native reveal after the consent prompt is cancelled', async () => {
    await renderApp()
    act(() => sidebarHarness.props?.onOpenSandboxUiApp?.(ALPHA!))
    await waitFor(() => expect(sandboxUi.open).toHaveBeenCalledTimes(1))
    await flushMacrotask()
    sandboxUi.setVisible.mockClear()
    sandboxUi.setBounds.mockClear()

    const mount: PinnedPluginSurface = {
      pluginId: 'plugin-1',
      pluginTitle: 'Plugin',
      surface: 'sandbox-ui-embed',
      webContentsId: 101,
      generation: 1,
    }
    const consentGate = new PluginConsentGate({
      store: {
        list: async () => [],
        get: async () => null,
        put: async () => undefined,
        touch: async () => undefined,
        revoke: async () => undefined,
        revokeAllForPlugin: async () => undefined,
      },
      isMountCurrent: candidate => candidate === mount,
      presentPrompt: request => consentRequestedCb?.(request),
      cancelPrompt: promptId => consentCancelledCb?.({ promptId }),
      setSurfaceVisible: async (visible, requestedMount) => {
        if (requestedMount !== mount) return false
        sandboxUi.setVisible(visible)
        return true
      },
      isWindowReady: () => true,
      now: () => 1_700_000_000_000,
      sleep: async () => undefined,
    })
    const pendingConsent = consentGate.ensure({
      envKey: 'testenv_0123456789ab',
      userId: 'user-1',
      pluginId: 'plugin-1',
      pluginTitle: 'Plugin',
      mount,
      capabilities: ['identity.read'],
    })
    await waitFor(() => expect(sandboxUiPageHarness.props?.appRootOverlayOpen).toBe(true))
    expect(screen.getByTestId('plugin-consent-modal').getAttribute('data-prompt-id')).toEqual(
      expect.any(String)
    )

    const payload = await openGfsResourcePayload(
      resolvedFile('img2', 'second.png', {
        gfsUri: 'gfs://main/img2.png',
      })
    )
    act(() => openGfsResourceCb?.(payload))
    await waitFor(() => expect(gfsPreviewHarness.props).not.toBeNull())

    act(() => consentGate.resetPlugin('plugin-1'))
    await pendingConsent
    await waitFor(() => expect(sandboxUiPageHarness.props?.appRootOverlayOpen).toBe(true))
    expect(screen.queryByTestId('plugin-consent-modal')).toBeNull()
    expect(sandboxUi.setVisible.mock.calls.some(([visible]) => visible === true)).toBe(false)

    act(() => gfsPreviewHarness.props?.onClose())
    await waitFor(() => expect(sandboxUiPageHarness.props?.appRootOverlayOpen).toBe(false))
    await waitFor(() =>
      expect(sandboxUi.setVisible.mock.calls.some(([visible]) => visible === true)).toBe(true)
    )
    const finalVisibleCall = sandboxUi.setVisible.mock.calls
      .map(([visible]) => visible)
      .lastIndexOf(true)
    const finalBoundsCall = sandboxUi.setBounds.mock.invocationCallOrder.at(-1)
    expect(finalBoundsCall).toBeDefined()
    expect(sandboxUi.setVisible.mock.invocationCallOrder[finalVisibleCall]).toBeGreaterThan(
      finalBoundsCall!
    )
  })

  it('keeps a GFS preview close from revealing while Settings remains active', async () => {
    await renderApp()
    act(() => sidebarHarness.props?.onOpenSandboxUiApp?.(ALPHA!))
    await waitFor(() => expect(sandboxUi.open).toHaveBeenCalledTimes(1))
    await flushMacrotask()
    sandboxUi.setVisible.mockClear()
    sandboxUi.setBounds.mockClear()

    const payload = await openGfsResourcePayload(
      resolvedFile('img3', 'third.png', { gfsUri: 'gfs://main/img3.png' })
    )
    act(() => openGfsResourceCb?.(payload))
    await waitFor(() => expect(gfsPreviewHarness.props).not.toBeNull())

    act(() => sidebarHarness.props?.onSettingsMenuOpenChange?.(true))
    await waitFor(() => expect(sandboxUiPageHarness.props?.sidebarShellOverlayOpen).toBe(true))
    expect(sandboxUiPageHarness.props?.appRootOverlayOpen).toBe(true)

    act(() => gfsPreviewHarness.props?.onClose())
    await waitFor(() => expect(sandboxUiPageHarness.props?.appRootOverlayOpen).toBe(false))
    expect(sandboxUiPageHarness.props?.sidebarShellOverlayOpen).toBe(true)
    expect(sandboxUi.setVisible.mock.calls.some(([visible]) => visible === true)).toBe(false)

    act(() => sidebarHarness.props?.onSettingsMenuOpenChange?.(false))
    await waitFor(() => expect(sandboxUiPageHarness.props?.sidebarShellOverlayOpen).toBe(false))
    await waitFor(() => expect(sandboxUi.setVisible).toHaveBeenLastCalledWith(true))
  })

  it('models GFS preview and Settings owner orderings through the real App/Page boundary', async () => {
    type Model = { preview: boolean; settings: boolean }
    type Real = { payload: OpenGfsPayload }

    const openPreview: fc.AsyncCommand<Model, Real> = {
      check: model => !model.preview,
      run: async (model, real) => {
        sandboxUi.setVisible.mockClear()
        act(() => openGfsResourceCb?.(real.payload))
        await waitFor(() => expect(gfsPreviewHarness.props).not.toBeNull())
        model.preview = true
        expect(sandboxUiPageHarness.props?.appRootOverlayOpen).toBe(true)
        expect(sandboxUi.setVisible.mock.calls.some(([visible]) => visible === true)).toBe(false)
      },
      toString: () => 'open GFS preview through the registered App event',
    }
    const closePreview: fc.AsyncCommand<Model, Real> = {
      check: model => model.preview,
      run: async (model, _real) => {
        sandboxUi.setVisible.mockClear()
        act(() => gfsPreviewHarness.props?.onClose())
        await waitFor(() => expect(sandboxUiPageHarness.props?.appRootOverlayOpen).toBe(false))
        model.preview = false
        if (model.settings) {
          expect(sandboxUi.setVisible.mock.calls.some(([visible]) => visible === true)).toBe(false)
        }
      },
      toString: () => 'close GFS preview while retaining any Settings owner',
    }
    const openSettings: fc.AsyncCommand<Model, Real> = {
      check: model => !model.settings,
      run: async model => {
        sandboxUi.setVisible.mockClear()
        act(() => sidebarHarness.props?.onSettingsMenuOpenChange?.(true))
        await waitFor(() => expect(sandboxUiPageHarness.props?.sidebarShellOverlayOpen).toBe(true))
        model.settings = true
        expect(sandboxUi.setVisible.mock.calls.some(([visible]) => visible === true)).toBe(false)
      },
      toString: () => 'open the App-mirrored Settings visibility owner',
    }
    const closeSettings: fc.AsyncCommand<Model, Real> = {
      check: model => model.settings,
      run: async model => {
        sandboxUi.setVisible.mockClear()
        act(() => sidebarHarness.props?.onSettingsMenuOpenChange?.(false))
        await waitFor(() => expect(sandboxUiPageHarness.props?.sidebarShellOverlayOpen).toBe(false))
        model.settings = false
        if (model.preview) {
          expect(sandboxUi.setVisible.mock.calls.some(([visible]) => visible === true)).toBe(false)
        } else {
          await waitFor(() => expect(sandboxUi.setVisible).toHaveBeenLastCalledWith(true))
        }
      },
      toString: () => 'close Settings while retaining any GFS preview owner',
    }
    const commands = fc.commands(
      [
        fc.constant(openPreview),
        fc.constant(closePreview),
        fc.constant(openSettings),
        fc.constant(closeSettings),
      ],
      { maxCommands: 8, size: '+1' }
    )

    await renderApp()
    act(() => sidebarHarness.props?.onOpenSandboxUiApp?.(ALPHA!))
    await waitFor(() => expect(sandboxUi.open).toHaveBeenCalledTimes(1))
    await flushMacrotask()
    const payload = await openGfsResourcePayload(
      resolvedFile('img4', 'fourth.png', { gfsUri: 'gfs://main/img4.png' })
    )

    const generated = fc.sample(commands, { seed: 11052026, numRuns: 12 })
    const sequences = generated
      .map(candidate => [...candidate])
      .filter(sequence => sequence.length > 0)
    expect(sequences.length).toBeGreaterThan(0)
    for (const sequence of sequences) {
      const model: Model = { preview: false, settings: false }
      await fc.asyncModelRun(() => ({ model, real: { payload } }), [...sequence])
      if (model.preview) act(() => gfsPreviewHarness.props?.onClose())
      if (model.settings) act(() => sidebarHarness.props?.onSettingsMenuOpenChange?.(false))
      if (model.preview || model.settings) {
        await waitFor(() => expect(sandboxUiPageHarness.props?.sidebarShellOverlayOpen).toBe(false))
      }
      await waitFor(() => expect(sandboxUi.setVisible).toHaveBeenLastCalledWith(true))
    }
  })

  it.each([
    {
      label: 'Desktop Update Required',
      open: (state: AppController) => {
        ;(state as unknown as { desktopReleaseStatus: unknown }).desktopReleaseStatus = {
          updateRequired: true,
          currentVersion: '1.0.0',
          latestVersion: '2.0.0',
        }
      },
      close: (state: AppController) => {
        ;(state as unknown as { desktopReleaseStatus: unknown }).desktopReleaseStatus = null
      },
    },
    {
      label: 'environment setup confirmation',
      open: (state: AppController) => {
        ;(
          state as unknown as { pendingDesktopEnvironmentSetup: unknown }
        ).pendingDesktopEnvironmentSetup = {
          appName: 'QA',
          externalRestApiBaseUrl: 'https://api.example.test',
        }
      },
      close: (state: AppController) => {
        ;(
          state as unknown as { pendingDesktopEnvironmentSetup: unknown }
        ).pendingDesktopEnvironmentSetup = null
      },
    },
    {
      label: 'environment switch confirmation',
      open: (state: AppController) => {
        ;(
          state as unknown as { pendingDesktopEnvironmentSwitchConfirmation: unknown }
        ).pendingDesktopEnvironmentSwitchConfirmation = {
          targetEnvironmentName: 'QA',
          targetExternalRestApiBaseUrl: 'https://qa.example.test',
          activeExternalRestApiBaseUrl: 'https://api.example.test',
        }
      },
      close: (state: AppController) => {
        ;(
          state as unknown as { pendingDesktopEnvironmentSwitchConfirmation: unknown }
        ).pendingDesktopEnvironmentSwitchConfirmation = null
      },
    },
    {
      label: 'environment setup success',
      open: (state: AppController) => {
        ;(
          state as unknown as { desktopEnvironmentSetupComplete: boolean }
        ).desktopEnvironmentSetupComplete = true
      },
      close: (state: AppController) => {
        ;(
          state as unknown as { desktopEnvironmentSetupComplete: boolean }
        ).desktopEnvironmentSetupComplete = false
      },
    },
  ])('keeps the native view hidden while $label is open', async ({ open, close }) => {
    await renderApp()
    act(() => sidebarHarness.props?.onOpenSandboxUiApp?.(ALPHA!))
    await waitFor(() => expect(sandboxUi.open).toHaveBeenCalledTimes(1))
    await flushMacrotask()
    sandboxUi.setVisible.mockClear()
    sandboxUi.setBounds.mockClear()

    act(() => {
      open(controller)
      forceControllerRender()
    })
    await waitFor(() => expect(sandboxUiPageHarness.props?.appRootOverlayOpen).toBe(true))
    expect(sandboxUi.setVisible.mock.calls.some(([visible]) => visible === true)).toBe(false)

    act(() => {
      close(controller)
      forceControllerRender()
    })
    await waitFor(() => expect(sandboxUiPageHarness.props?.appRootOverlayOpen).toBe(false))
    await waitFor(() =>
      expect(sandboxUi.setVisible.mock.calls.some(([visible]) => visible === true)).toBe(true)
    )
    const finalVisibleCall = sandboxUi.setVisible.mock.calls
      .map(([visible]) => visible)
      .lastIndexOf(true)
    const finalBoundsCall = sandboxUi.setBounds.mock.invocationCallOrder.at(-1)
    const visibleCallOrder = sandboxUi.setVisible.mock.invocationCallOrder[finalVisibleCall]
    expect(finalBoundsCall).toBeDefined()
    expect(visibleCallOrder).toBeGreaterThan(finalBoundsCall!)
  })

  it('fails the suite on a flushSync issued from inside an effect', () => {
    function FlushesInAnEffect() {
      useEffect(() => {
        flushSync(() => {})
      }, [])
      return null
    }
    render(<FlushesInAnEffect />)
    expect(flushSyncErrors.length).toBeGreaterThan(0)
    flushSyncErrors = []
  })
})
