// @vitest-environment jsdom
import { useReducer } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DESKTOP_ROUTES } from '@constants/navigation'
import { useAppController } from '@hooks/useAppController'
import type { GfsPreviewResource } from '@lib/gfsPreview'
import { toActiveSandboxUiApps } from '@lib/sandboxUiAppSelection'
import type { SandboxUiAppListing } from '@lib/sandboxUiAppSelection.types'
import {
  activeWorkspaceTab,
  createWorkspaceTabsState,
  openFilesTab,
  openPreviewTab,
} from '@lib/workspaceTabs'
import { mapKindToRoute } from '@lib/workspaceTabsRoute'
import { App } from '@/App'
import { openGfsResourcePayload, resolvedFile } from '@/gfs/__fixtures__/gfsProducerFixtures'

// Ownership of the native sandbox-ui embed across a FAILED relaunch. The
// WebContentsView paints above the renderer DOM, so whichever app tab owns it
// must emit `sandboxUi.close()` when the user leaves it — even after an open on
// that tab failed, because main may still hold a view (a failure before the
// open IPC never reaches main at all). These cases drive the REAL SandboxUiPage
// (its open/catch path is the producer under test) and the REAL tab strip; the
// App harness in App.chatDrawer.test.tsx stubs SandboxUiPage and so cannot.

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

const sidebarHarness = vi.hoisted(() => ({
  props: null as null | {
    onOpenSandboxUiApp?: (app: {
      appRef: string
      label: string
      defaultPath: string
      icon?: string
    }) => void
  },
}))

vi.mock('@hooks/useAppController', () => ({ useAppController: vi.fn() }))
vi.mock('@hooks/useAgentChatActionsValue', () => ({ useAgentChatActionsValue: () => ({}) }))
vi.mock('@components/AppHeader', () => ({ AppHeader: () => null }))
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
vi.mock('@pages/FilePreviewPage', () => ({ FilePreviewPage: () => null }))
vi.mock('@pages/McpServersPage', () => ({ McpServersPage: () => null }))
vi.mock('@pages/SettingsPage', () => ({ SettingsPage: () => null }))
vi.mock('@pages/TeamDetailsPage', () => ({ TeamDetailsPage: () => null }))
vi.mock('@pages/TeamsPage', () => ({ TeamsPage: () => null }))
vi.mock('@pages/UnavailablePage', () => ({ UnavailablePage: () => null }))
vi.mock('@pages/WorkflowsPage', () => ({ WorkflowsPage: () => null }))

type AppController = ReturnType<typeof useAppController>

// Store-faithful controller (same contract as App.chatDrawer.test.tsx): `navItem`
// derives from the active tab, and every navigation drives the real store
// producers.
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
  const openFilesSection = vi.fn((path: string | null = null) => {
    clearAppsPicker()
    setWorkspaceTabs((state: WorkspaceState) =>
      openFilesTab(state, { id: nextWorkspaceTabId(), path })
    )
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
    forceControllerRender()
  })
  const showAppsPicker = vi.fn(() => {
    if (controller.appsPickerActive) return
    if (activeWorkspaceTab(controller.workspaceTabs)?.kind === 'app') return
    controller.appsPickerActive = true
    forceControllerRender()
  })
  const handleSelectChatAgent = vi.fn(() => forceControllerRender())
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
    handleSelectChatAgent,
    handleOpenNotification: vi.fn(async () => undefined),
    handleNavSelect: vi.fn(),
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

// Any rejection of the open IPC takes the same failure path; its text only
// picks the banner copy, which these tests deliberately do not assert.
const OPEN_REJECTED = new Error('open rejected')

// The failure banner is prefixed with the appRef of the failed launch. Waiting
// on that prefix (not on the copy) pins the moment the page has handled the
// failure, before the test leaves the tab.
async function waitForLaunchFailure(appRef: string) {
  const prefix = `${appRef}: `
  expect(await screen.findByText(text => text.startsWith(prefix))).toBeTruthy()
}

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
const UNMEASURED_SLOT = { ...MEASURED_SLOT, width: 0, height: 0, right: 16, bottom: 12 } as DOMRect

function makeSandboxUiBridge() {
  return {
    listApps: vi.fn().mockResolvedValue({ apps: APP_LISTING }),
    listPendingDeepLinks: vi.fn().mockResolvedValue({ links: [] }),
    clearPendingDeepLinks: vi.fn().mockResolvedValue(undefined),
    onDeepLink: vi.fn(() => vi.fn()),
    onTitleChanged: vi.fn(() => vi.fn()),
    onClosed: vi.fn(() => vi.fn()),
    onRefreshError: vi.fn(() => vi.fn()),
    onFindResult: vi.fn(() => vi.fn()),
    open: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    getLocation: vi.fn().mockResolvedValue(null),
    setVisible: vi.fn().mockResolvedValue(undefined),
    setBounds: vi.fn().mockResolvedValue(undefined),
    capturePreview: vi.fn().mockResolvedValue(null),
    stopFindInPage: vi.fn().mockResolvedValue(undefined),
    focusActive: vi.fn().mockResolvedValue(true),
    reload: vi.fn().mockResolvedValue(undefined),
  }
}

type OpenGfsPayload = Awaited<ReturnType<typeof openGfsResourcePayload>>

describe('App sandbox-ui ownership survives a failed relaunch', () => {
  let currentController: AppController
  let openGfsResourceCb: ((resource: OpenGfsPayload) => void) | null
  let sandboxUi: ReturnType<typeof makeSandboxUiBridge>
  let slotRect: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    sidebarHarness.props = null
    openGfsResourceCb = null
    currentController = makeController()
    vi.mocked(useAppController).mockImplementation(() => useReactiveController(currentController))
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
    slotRect = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue(MEASURED_SLOT)
    sandboxUi = makeSandboxUiBridge()
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        shortcuts: { onCommand: vi.fn(() => vi.fn()) },
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
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    delete (window as { clerum?: unknown }).clerum
  })

  async function renderWithLiveApp(app: typeof ALPHA) {
    render(<App />)
    // The strip relaunch resolves the tab's app against the loaded listing.
    await waitFor(() => expect(sandboxUi.listApps).toHaveBeenCalled())
    await act(async () => {
      await Promise.resolve()
    })
    act(() => sidebarHarness.props?.onOpenSandboxUiApp?.(app!))
    await waitFor(() => expect(sandboxUi.open).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(currentController.navItem).toBe(DESKTOP_ROUTES.apps))
  }

  function clickActiveStripTab(label: string) {
    const activeTab = currentController.workspaceTabs.tabs.find(
      tab => tab.id === currentController.workspaceTabs.activeTabId
    )
    expect(activeTab?.kind).toBe('app')
    // The strip marks the active tab with aria-pressed.
    fireEvent.click(screen.getByRole('button', { name: label, pressed: true }))
  }

  async function handOffMarkdownFromPlugin() {
    const payload = await openGfsResourcePayload(
      resolvedFile('md1', 'README.md', { gfsUri: 'gfs://main/md1' })
    )
    act(() => openGfsResourceCb?.(payload))
    expect(currentController.navItem).toBe(DESKTOP_ROUTES.preview)
  }

  it('closes the embed when a plugin handoff leaves the app tab after a relaunch rejected by main', async () => {
    await renderWithLiveApp(ALPHA)
    expect(sandboxUi.close).not.toHaveBeenCalled()

    sandboxUi.open.mockRejectedValueOnce(OPEN_REJECTED)
    clickActiveStripTab('Alpha')
    await waitFor(() => expect(sandboxUi.open).toHaveBeenCalledTimes(2))
    await waitForLaunchFailure(ALPHA!.appRef)

    await handOffMarkdownFromPlugin()

    await waitFor(() => expect(sandboxUi.close).toHaveBeenCalledTimes(1))
  })

  it('closes the embed when a relaunch fails before reaching main (slot never measured)', async () => {
    await renderWithLiveApp(ALPHA)

    slotRect.mockReturnValue(UNMEASURED_SLOT)
    clickActiveStripTab('Alpha')
    await waitForLaunchFailure(ALPHA!.appRef)
    // The failure happened before the open IPC: main still holds the old view.
    expect(sandboxUi.open).toHaveBeenCalledTimes(1)

    slotRect.mockReturnValue(MEASURED_SLOT)
    await handOffMarkdownFromPlugin()

    await waitFor(() => expect(sandboxUi.close).toHaveBeenCalledTimes(1))
  })

  it('closes the embed when leaving an app tab whose open failed after an app-to-app switch', async () => {
    await renderWithLiveApp(ALPHA)

    sandboxUi.open.mockRejectedValueOnce(OPEN_REJECTED)
    act(() => sidebarHarness.props?.onOpenSandboxUiApp?.(BETA!))
    await waitFor(() => expect(sandboxUi.open).toHaveBeenCalledTimes(2))
    await waitForLaunchFailure(BETA!.appRef)
    // app→app hands the embed over; it is never closed on the way in.
    expect(sandboxUi.close).not.toHaveBeenCalled()

    await handOffMarkdownFromPlugin()

    await waitFor(() => expect(sandboxUi.close).toHaveBeenCalledTimes(1))
  })
})
