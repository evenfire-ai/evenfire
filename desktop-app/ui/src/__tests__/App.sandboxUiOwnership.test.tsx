// @vitest-environment jsdom
import { StrictMode, useEffect, useReducer } from 'react'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
  props: null as null | {
    activeSandboxUiApp?: { appRef: string } | null
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
vi.mock('@pages/FilePreviewPage', () => ({ FilePreviewPage: () => null }))
vi.mock('@pages/McpServersPage', () => ({ McpServersPage: () => null }))
vi.mock('@pages/SettingsPage', () => ({ SettingsPage: () => null }))
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
    clearAppsPicker()
    setWorkspaceTabs((state: WorkspaceState) =>
      openFilesTab(state, { id: nextWorkspaceTabId(), path })
    )
  })
  const showAppsPicker = vi.fn(() => {
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
  let shortcutCommandCb: ((commandId: string, source: string) => void) | null
  let sandboxUi: ReturnType<typeof makeSandboxUiBridge>
  let main: SandboxUiMainFake
  // A `flushSync` from inside a render or effect does not flush: React only
  // warns about it. The seam depends on flushing, so the warning fails the test.
  let flushSyncErrors: string[]

  beforeEach(() => {
    vi.clearAllMocks()
    sidebarHarness.props = null
    confirmDialogHarness.props = null
    machineHarness.machine = null
    machineHarness.launches = []
    machineHarness.events = []
    machineHarness.afterDispatch = null
    openGfsResourceCb = null
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
    const payload = await openGfsResourcePayload(
      resolvedFile('md1', 'README.md', { gfsUri: 'gfs://main/md1' })
    )
    act(() => openGfsResourceCb?.(payload))
    await flushMacrotask()

    expect(controller.navItem).toBe(DESKTOP_ROUTES.preview)
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
