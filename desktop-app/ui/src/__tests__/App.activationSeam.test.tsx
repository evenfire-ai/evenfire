// @vitest-environment jsdom
import { useReducer } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { DESKTOP_ROUTES } from '@constants/navigation'
import { useAppController } from '@hooks/useAppController'
import type { GfsPreviewResource } from '@lib/gfsPreview'
import { desktopQueryDefaults } from '@lib/queryClient'
import { toActiveSandboxUiApps } from '@lib/sandboxUiAppSelection'
import type { SandboxUiAppListing } from '@lib/sandboxUiAppSelection.types'
import {
  activeWorkspaceTab,
  createWorkspaceTabsState,
  openChatTab,
  openFilesTab,
  openPreviewTab,
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

// Every gesture that activates an app tab must do it through App's single
// activation seam, which commits the store and the launch together under
// `flushSync`. A store write that activates an app tab from anywhere else (an
// effect, a late async continuation, a new handler) lands in a later commit than
// the launch it belongs to. These tests record, for every store write, whether
// it ran inside a `flushSync` callback, and fail on any app-tab activation that
// did not. The callback body — not the commit that follows it — is what counts:
// effects flushed by that sync commit are NOT inside the seam.
// The probe only catches activations in the scenarios driven here; the static
// guarantee is the `flushSync` call-site check at the end of this file.

const seamProbe = vi.hoisted(() => ({ depth: 0 }))

vi.mock('react-dom', async importOriginal => {
  const actual = await importOriginal<typeof import('react-dom')>()
  return {
    ...actual,
    flushSync: <R,>(fn: () => R): R =>
      actual.flushSync(() => {
        seamProbe.depth += 1
        try {
          return fn()
        } finally {
          seamProbe.depth -= 1
        }
      }),
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

type StoreWrite = { activatedAppTabId: string | null; insideSeam: boolean }

// Store-faithful controller: `navItem` derives from the active tab and every
// navigation drives the real store producers. Each write is recorded with
// whether it was issued from inside a `flushSync` callback.
function makeController(writes: StoreWrite[]): AppController {
  const noop = vi.fn()
  let controller: AppController
  let tabSequence = 2
  const nextWorkspaceTabId = vi.fn(() => `ws-tab-${tabSequence++}`)
  const setWorkspaceTabs = vi.fn((updater: unknown) => {
    const previous = controller.workspaceTabs
    const next =
      typeof updater === 'function'
        ? (updater as (state: WorkspaceState) => WorkspaceState)(previous)
        : (updater as WorkspaceState)
    const activated =
      next.activeTabId !== previous.activeTabId ? activeWorkspaceTab(next) : undefined
    writes.push({
      activatedAppTabId: activated?.kind === 'app' ? activated.id : null,
      insideSeam: seamProbe.depth > 0,
    })
    if (next === previous) return
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
type ShortcutListener = (commandId: string, source: string) => void

// The latest subscriber of a bridge `on*` registration, i.e. the listener App
// currently has wired.
function latestListener<T>(subscribe: ReturnType<typeof vi.fn>): (event: T) => void {
  const calls = subscribe.mock.calls as unknown as Array<[(event: T) => void]>
  return calls[calls.length - 1]![0]
}

function flushMacrotask() {
  return act(async () => {
    await new Promise(resolve => window.setTimeout(resolve, 0))
  })
}

describe('App activates app tabs only through its activation seam', () => {
  let controller: AppController
  let writes: StoreWrite[]
  let flushSyncErrors: string[]
  let openGfsResourceCb: ((resource: OpenGfsPayload) => void) | null
  let shortcutCommandCb: ShortcutListener | null
  let sandboxUi: ReturnType<typeof makeSandboxUiBridge>
  let main: SandboxUiMainFake

  beforeEach(() => {
    vi.clearAllMocks()
    seamProbe.depth = 0
    sidebarHarness.props = null
    confirmDialogHarness.props = null
    openGfsResourceCb = null
    shortcutCommandCb = null
    writes = []
    flushSyncErrors = []
    const consoleError = console.error.bind(console)
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      const text = args.map(String).join(' ')
      if (text.includes('flushSync')) flushSyncErrors.push(text)
      else consoleError(...args)
    })
    controller = makeController(writes)
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
          onCommand: vi.fn((cb: ShortcutListener) => {
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
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    delete (window as { clerum?: unknown }).clerum
  })

  // The invariant, checked at the end of every scenario. `minActivations` keeps
  // a scenario from passing vacuously when it never activated an app tab.
  function expectActivationsOnlyThroughSeam(minActivations: number) {
    const appActivations = writes.filter(write => write.activatedAppTabId !== null)
    expect(appActivations.filter(write => !write.insideSeam)).toEqual([])
    expect(appActivations.length).toBeGreaterThanOrEqual(minActivations)
    expect(flushSyncErrors).toEqual([])
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
    await act(async () => {
      await Promise.resolve()
    })
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

  function activeTab() {
    return activeWorkspaceTab(controller.workspaceTabs)
  }

  it('opens apps from the sidebar and the picker grid through the seam', async () => {
    await renderApp()
    await openFromSidebar(ALPHA, 1)
    expect(activeTab()?.app?.appRef).toBe(ALPHA!.appRef)

    await shortcut('app.backToApps')
    fireEvent.click(await screen.findByRole('button', { name: 'Open Beta' }))
    await waitFor(() => expect(sandboxUi.open).toHaveBeenCalledTimes(2))
    expect(activeTab()?.app?.appRef).toBe(BETA!.appRef)

    expectActivationsOnlyThroughSeam(2)
  })

  it('activates app tabs from the strip (select and close-to-neighbor) through the seam', async () => {
    await renderApp()
    await openFromSidebar(ALPHA, 1)

    fireEvent.click(screen.getByRole('button', { name: 'New chat', pressed: false }))
    await flushMacrotask()
    fireEvent.click(screen.getByRole('button', { name: 'Alpha', pressed: false }))
    await waitFor(() => expect(sandboxUi.open).toHaveBeenCalledTimes(2))
    await flushMacrotask()

    // Closing the active chat tab activates its right neighbor, the Alpha tab.
    fireEvent.click(screen.getByRole('button', { name: 'New chat', pressed: false }))
    await flushMacrotask()
    fireEvent.click(screen.getByRole('button', { name: 'Close New chat' }))
    await waitFor(() => expect(sandboxUi.open).toHaveBeenCalledTimes(3))
    expect(activeTab()?.app?.appRef).toBe(ALPHA!.appRef)

    // open #1 (sidebar) + strip select + close-to-neighbor.
    expectActivationsOnlyThroughSeam(3)
  })

  it('activates app tabs from tab shortcuts through the seam', async () => {
    await renderApp()
    await openFromSidebar(ALPHA, 1)
    await openFromSidebar(BETA, 2)
    // Tabs: [New chat, Alpha, Beta].

    await shortcut('tabs.select1')
    await shortcut('tabs.select2')
    expect(activeTab()?.app?.appRef).toBe(ALPHA!.appRef)
    await shortcut('tabs.next')
    expect(activeTab()?.app?.appRef).toBe(BETA!.appRef)
    await shortcut('tabs.previous')
    expect(activeTab()?.app?.appRef).toBe(ALPHA!.appRef)
    await shortcut('tabs.select1')
    await shortcut('tabs.selectLast')
    expect(activeTab()?.app?.appRef).toBe(BETA!.appRef)
    await shortcut('tabs.select1')
    await shortcut('chat.closeTab')
    expect(activeTab()?.app?.appRef).toBe(ALPHA!.appRef)

    // 2 sidebar opens + select2, next, previous, selectLast, closeTab.
    expectActivationsOnlyThroughSeam(7)
  })

  it('activates the app tab of a confirmed deep link through the seam', async () => {
    await renderApp()
    act(() => {
      latestListener<SandboxUiDeepLinkEnvelope>(sandboxUi.onDeepLink)({
        id: 1,
        appRef: ALPHA!.appRef,
      })
    })
    await waitFor(() => expect(confirmDialogHarness.props?.title).toBe('Open app link?'))
    await act(async () => {
      confirmDialogHarness.props?.onConfirm()
      await Promise.resolve()
    })

    await waitFor(() => expect(sandboxUi.open).toHaveBeenCalledTimes(1))
    expect(activeTab()?.app?.appRef).toBe(ALPHA!.appRef)
    expectActivationsOnlyThroughSeam(1)
  })

  it('keeps every other store writer from activating an app tab', async () => {
    controller.selectedAgent = 'agent-a'
    controller.activeChatId = 'chat-1'
    ;(controller as { chatList: unknown }).chatList = [{ id: 'chat-1', title: 'Planning' }]
    controller.workspaceTabs = openChatTab(createWorkspaceTabsState('chat-tab-1'), {
      id: 'ws-tab-90',
      agentRef: 'agent-a',
      chatId: 'chat-1',
      title: 'Planning',
    })
    await renderApp()
    // composer.focus on the chat route reveals the active chat through the seam.
    await shortcut('composer.focus')

    await openFromSidebar(ALPHA, 1)
    // A title from the live embed renames its tab.
    await act(() => main.retitle('Alpha Inbox'))
    // Leaving the app persists its route, and a plugin handoff opens a preview.
    main.navigate('/inbox')
    const payload = await openGfsResourcePayload(
      resolvedFile('md1', 'README.md', { gfsUri: 'gfs://main/md1' })
    )
    act(() => openGfsResourceCb?.(payload))
    await waitFor(() =>
      expect(
        controller.workspaceTabs.tabs.find(tab => tab.app?.appRef === ALPHA!.appRef)?.app
          ?.savedRoutePath
      ).toBe('/inbox')
    )
    expect(activeTab()?.kind).toBe('preview')

    // A new chat tab, then a principal change resets the store.
    await shortcut('chat.newTab')
    ;(controller as { authenticatedPrincipalIdentity: string }).authenticatedPrincipalIdentity =
      'user-b:user-b@example.com'
    act(() => forceControllerRender())
    await flushMacrotask()
    expect(controller.workspaceTabs.activeTabId).toBe('chat-tab-1')

    // Only the sidebar open activated an app tab.
    expectActivationsOnlyThroughSeam(1)
    expect(writes.filter(write => write.activatedAppTabId !== null)).toHaveLength(1)
  })

  // A store write that lands between App's last render and a gesture (here a
  // title from the live embed) must survive the gesture's own store write.
  async function renderWithRetitledLiveAlpha(gesture: () => void) {
    await renderApp()
    await openFromSidebar(ALPHA, 1)
    // The title is in, but App has not rendered it, when the gesture runs.
    await act(async () => {
      await main.retitle('Alpha Inbox')
      gesture()
    })
    await flushMacrotask()
  }

  it('keeps a pending store update when a tab shortcut activates another tab', async () => {
    await renderWithRetitledLiveAlpha(() => shortcutCommandCb?.('tabs.select1', 'host'))

    expect(screen.getByRole('button', { name: 'New chat', pressed: true })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Alpha Inbox', pressed: false })).toBeTruthy()
    expectActivationsOnlyThroughSeam(1)
  })

  it('keeps a pending store update when the strip closes another tab', async () => {
    await renderWithRetitledLiveAlpha(() =>
      fireEvent.click(screen.getByRole('button', { name: 'Close New chat' }))
    )

    expect(screen.queryByRole('button', { name: 'New chat' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Alpha Inbox', pressed: true })).toBeTruthy()
    expectActivationsOnlyThroughSeam(1)
  })
})

// `flushSync` is what makes the seam a seam: a second call site would be a
// second, unaudited activation path, and one inside an effect would not flush.
describe('flushSync call sites in the renderer', () => {
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap(name => {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) {
        return name === '__tests__' || name === 'node_modules' ? [] : sourceFiles(path)
      }
      return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
    })
  }

  it('calls flushSync only from the activation seam in App', () => {
    const root = join(__dirname, '..')
    const sites = sourceFiles(root).flatMap(path =>
      readFileSync(path, 'utf8')
        .split('\n')
        .filter(line => /\bflushSync\(/.test(line))
        .map(line => `${relative(root, path)}: ${line.trim()}`)
    )
    expect(sites).toEqual(['App.tsx: flushSync(() => {'])
  })
})
