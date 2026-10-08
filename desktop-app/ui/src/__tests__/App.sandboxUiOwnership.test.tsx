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

// Ownership of the native sandbox-ui embed. The WebContentsView paints above the
// renderer DOM, so whichever app tab owns it must emit `sandboxUi.close()` when
// the user leaves it — even after an open on that tab failed, because main may
// still hold a view (a failure before the open IPC never reaches main at all),
// and also when the app was opened from the in-page picker grid, which must
// create that owning tab. These cases drive the REAL SandboxUiPage
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
    onSelect?: (item: string) => void
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
    // Only the Apps entry matters here: like the real navigation controller it
    // shows the instance-less picker instead of opening a tab.
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

describe('App sandbox-ui embed always has an owning app tab', () => {
  let currentController: AppController
  let openGfsResourceCb: ((resource: OpenGfsPayload) => void) | null
  let shortcutCommandCb: ((commandId: string, source: string) => void) | null
  let sandboxUi: ReturnType<typeof makeSandboxUiBridge>
  let slotRect: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    sidebarHarness.props = null
    openGfsResourceCb = null
    shortcutCommandCb = null
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

  it('opens an app from the in-page picker grid as its own active tab that closes the embed on leave', async () => {
    // Reach the picker from a conversation through the sidebar, as a user does.
    currentController.selectedAgent = 'agent-a'
    currentController.activeChatId = 'chat-1'
    ;(currentController as { chatList: unknown }).chatList = [{ id: 'chat-1', title: 'Planning' }]
    render(<App />)
    await waitFor(() => expect(sandboxUi.listApps).toHaveBeenCalled())
    act(() => sidebarHarness.props?.onSelect?.(DESKTOP_ROUTES.apps))
    expect(currentController.appsPickerActive).toBe(true)

    fireEvent.click(await screen.findByRole('button', { name: 'Open Alpha' }))

    await waitFor(() => expect(sandboxUi.open).toHaveBeenCalledTimes(1))
    const activeTab = activeWorkspaceTab(currentController.workspaceTabs)
    expect(activeTab?.kind).toBe('app')
    expect(activeTab?.app?.appRef).toBe(ALPHA!.appRef)
    expect(currentController.appsPickerActive).toBe(false)
    // The drawer comes up with the conversation the picker was reached from.
    expect(currentController.handleSelectChatAgent).toHaveBeenCalledWith(
      'agent-a',
      expect.objectContaining({ chatId: 'chat-1', keepNavItem: true })
    )
    expect(sandboxUi.close).not.toHaveBeenCalled()

    await handOffMarkdownFromPlugin()

    await waitFor(() => expect(sandboxUi.close).toHaveBeenCalledTimes(1))
  })

  // main tags `sandboxUi:closed` with the appRef it composed from the open
  // request (`${recipeNs}/${recipeName}` in the `sandboxUi:open` handler).
  // Derive it from the open() call the real page sent instead of restating it.
  function closedEventFor(openCall: number): { appRef: string } {
    const request = sandboxUi.open.mock.calls[openCall]![0] as {
      recipeNs: string
      recipeName: string
    }
    return { appRef: `${request.recipeNs}/${request.recipeName}` }
  }

  function emitSandboxUiClosed(event: { appRef: string }) {
    const listeners = sandboxUi.onClosed.mock.calls as unknown as Array<
      [(args: { appRef: string }) => void]
    >
    const unsubscribed = new Set(
      sandboxUi.onClosed.mock.results
        .map((result, index) =>
          (result.value as ReturnType<typeof vi.fn>).mock.calls.length > 0 ? index : -1
        )
        .filter(index => index >= 0)
    )
    act(() => {
      listeners.forEach(([listener], index) => {
        if (!unsubscribed.has(index)) listener(event)
      })
    })
  }

  it('keeps the live embed owned when a late closed event belongs to the app it replaced', async () => {
    await renderWithLiveApp(ALPHA)
    act(() => sidebarHarness.props?.onOpenSandboxUiApp?.(BETA!))
    await waitFor(() => expect(sandboxUi.open).toHaveBeenCalledTimes(2))
    await act(async () => {
      await new Promise(resolve => window.setTimeout(resolve, 0))
    })

    emitSandboxUiClosed(closedEventFor(0))

    await handOffMarkdownFromPlugin()
    await waitFor(() => expect(sandboxUi.close).toHaveBeenCalledTimes(1))
  })

  it('keeps the newer launch owned when a superseded open resolves late and its view then dies', async () => {
    render(<App />)
    await waitFor(() => expect(sandboxUi.listApps).toHaveBeenCalled())
    await act(async () => {
      await Promise.resolve()
    })
    let resolveAlphaOpen: () => void = () => {}
    sandboxUi.open.mockImplementationOnce(
      () => new Promise<undefined>(resolve => (resolveAlphaOpen = () => resolve(undefined)))
    )
    act(() => sidebarHarness.props?.onOpenSandboxUiApp?.(ALPHA!))
    await waitFor(() => expect(sandboxUi.open).toHaveBeenCalledTimes(1))
    act(() => sidebarHarness.props?.onOpenSandboxUiApp?.(BETA!))
    await waitFor(() => expect(sandboxUi.open).toHaveBeenCalledTimes(2))

    // main serves the opens in order: Alpha mounts first, and its renderer dies
    // before Beta's open replaces it.
    await act(async () => {
      resolveAlphaOpen()
      await new Promise(resolve => window.setTimeout(resolve, 0))
    })
    emitSandboxUiClosed(closedEventFor(0))

    await handOffMarkdownFromPlugin()
    await waitFor(() => expect(sandboxUi.close).toHaveBeenCalledTimes(1))
  })

  it('drops the owner when the closed event belongs to the live embed', async () => {
    await renderWithLiveApp(ALPHA)
    act(() => sidebarHarness.props?.onOpenSandboxUiApp?.(BETA!))
    await waitFor(() => expect(sandboxUi.open).toHaveBeenCalledTimes(2))
    await act(async () => {
      await new Promise(resolve => window.setTimeout(resolve, 0))
    })

    emitSandboxUiClosed(closedEventFor(1))

    await handOffMarkdownFromPlugin()
    await act(async () => {
      await new Promise(resolve => window.setTimeout(resolve, 0))
    })
    // main already tore the view down: nothing is left to close.
    expect(sandboxUi.close).not.toHaveBeenCalled()
  })

  it('opens a grid pick shown inside an app tab after back-to-apps as its own tab, leaving that tab intact', async () => {
    await renderWithLiveApp(ALPHA)
    const alphaTab = activeWorkspaceTab(currentController.workspaceTabs)
    expect(alphaTab?.kind).toBe('app')

    // The in-view "Back to apps" button is gone by design; the host shortcut
    // command is the remaining real entry point.
    act(() => shortcutCommandCb?.('app.backToApps', 'host'))
    await waitFor(() => expect(sandboxUi.close).toHaveBeenCalledTimes(1))
    // Still inside the Alpha tab, now showing the picker grid.
    expect(currentController.workspaceTabs.activeTabId).toBe(alphaTab!.id)

    fireEvent.click(await screen.findByRole('button', { name: 'Open Beta' }))

    await waitFor(() => expect(sandboxUi.open).toHaveBeenCalledTimes(2))
    const activeTab = activeWorkspaceTab(currentController.workspaceTabs)
    expect(activeTab?.id).not.toBe(alphaTab!.id)
    expect(activeTab?.kind).toBe('app')
    expect(activeTab?.app?.appRef).toBe(BETA!.appRef)
    const alphaAfter = currentController.workspaceTabs.tabs.find(tab => tab.id === alphaTab!.id)
    expect(alphaAfter?.app?.appRef).toBe(ALPHA!.appRef)
    expect(alphaAfter?.title).toBe(alphaTab!.title)
  })
})
