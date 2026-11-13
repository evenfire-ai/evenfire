// @vitest-environment jsdom
import { useReducer } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClientProvider } from '@tanstack/react-query'
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import fc, { type AsyncCommand, type Scheduler } from 'fast-check'
import { DESKTOP_ROUTES } from '@constants/navigation'
import { installMockClerum } from '@hooks/domain/__tests__/__fixtures__/mockClerum'
import { useNavigationController } from '@hooks/domain/useNavigationController'
import { useNotificationsController } from '@hooks/domain/useNotificationsController'
import { useAppController } from '@hooks/useAppController'
import { buildGfsResourceActions, getGfsMenuActions } from '@lib/gfsResourceActions'
import { desktopQueryClient } from '@lib/queryClient'
import {
  activeWorkspaceTab,
  closeWorkspaceTab,
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
import {
  accessibleResource,
  childView,
  listAccessiblePage,
  listChildrenPage,
  previewDownloadResult,
  resolveResource,
  resolvedDirectory,
  resolvedFile,
  resourceAffordances,
} from '@/gfs/__fixtures__/gfsProducerFixtures'

type AppController = ReturnType<typeof useAppController>
type WorkspaceState = AppController['workspaceTabs']
type WorkspaceStateUpdater = WorkspaceState | ((state: WorkspaceState) => WorkspaceState)

const appHarness = vi.hoisted(() => ({
  controller: null as unknown as AppController,
  useRealNavigationController: false,
  forceRender: () => {},
  shortcutCommand: null as unknown as (commandId: string, source: 'host' | 'sandbox') => void,
  shortcutRegistrationCount: 0,
  lastShortcutCommand: null as string | null,
  filesPagePendingActions: [] as unknown[],
  filesPageLatestPendingAction: null as unknown,
  filesPageRenderCount: 0,
  filesPageLastLocation: null as { gfsUri: string | null; name: string | null } | null,
  filesPageReportLocation: null as ((gfsUri: string | null, name: string | null) => void) | null,
  previewPagePendingActions: [] as unknown[],
  sandboxUiShortcutAppRef: null as string | null,
  latestConversationNotification: null as unknown as {
    kind: string
    teamId?: string
    chatId?: string
  } | null,
}))

const allowNotificationDelivery = () => true
const grantDesktopNotification = async () => 'granted' as const
const noopAsync = async () => {}
const noop = () => {}

function useReactiveController(): AppController {
  const [, force] = useReducer((count: number) => count + 1, 0)
  const navigation = useNavigationController()
  appHarness.forceRender = force
  let controller = appHarness.controller
  if (appHarness.useRealNavigationController) {
    controller = {
      ...controller,
      ...navigation,
      activeWorkspaceTab: navigation.activeTab,
    } as AppController
    appHarness.controller = controller
    return controller
  }
  const activeTab = activeWorkspaceTab(controller.workspaceTabs)
  ;(controller as { activeWorkspaceTab: unknown }).activeWorkspaceTab = activeTab
  ;(controller as { navItem: unknown }).navItem = controller.appsPickerActive
    ? DESKTOP_ROUTES.apps
    : mapKindToRoute(activeTab)
  return controller
}

vi.mock('@hooks/useAppController', () => ({ useAppController: vi.fn() }))
vi.mock('@hooks/useAgentChatActionsValue', () => ({ useAgentChatActionsValue: () => ({}) }))
vi.mock('@hooks/useWindowFocusBridge', () => ({ useWindowFocusBridge: () => {} }))
vi.mock('@components/AppHeader', async () => {
  const { useNotificationsContext } = await import('@contexts/NotificationsContext')
  return {
    AppHeader: ({
      drawerAvailable,
      onToggleChatDrawer,
    }: {
      drawerAvailable: boolean
      onToggleChatDrawer: () => void
    }) => {
      const { notifications, handleOpenNotification } = useNotificationsContext()
      const conversationNotification = notifications.find(
        notification => notification.kind === 'assistant_reply'
      )
      appHarness.latestConversationNotification = conversationNotification ?? null
      return (
        <>
          {drawerAvailable ? (
            <button type="button" aria-label="Toggle chat drawer" onClick={onToggleChatDrawer} />
          ) : null}
          {conversationNotification ? (
            <button
              type="button"
              aria-label="Open conversation notification"
              onClick={() => void handleOpenNotification(conversationNotification)}
            />
          ) : null}
        </>
      )
    },
  }
})
vi.mock('@components/BootSplash', () => ({ BootSplash: () => null }))
vi.mock('@components/ChatDrawer', () => ({
  ChatDrawer: ({ children, header }: { children: React.ReactNode; header: React.ReactNode }) => (
    <>
      {header}
      {children}
    </>
  ),
}))
vi.mock('@components/ChatLocalSearch', () => ({ ChatLocalSearch: () => null }))
vi.mock('@components/ChatViewWorkspace', () => ({
  ChatViewWorkspace: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock('@components/CommandPalette', () => ({ CommandPalette: () => null }))
vi.mock('@components/GfsImagePreview', () => ({ GfsImagePreview: () => null }))
vi.mock('@components/PluginConsentModal', () => ({ PluginConsentModal: () => null }))
vi.mock('@components/RightRailShell', () => ({
  RightRailShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock('@components/WindowTitleBar', () => ({
  TitlebarActionsPortal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  WindowTitleBar: () => null,
}))
vi.mock('@pages/AgentsPage', () => ({ AgentsPage: () => null }))
vi.mock('@pages/AuthPage', () => ({ AuthPage: () => null }))
vi.mock('@pages/ChatPage', () => ({ ChatPage: () => null }))
vi.mock('@pages/McpServersPage', () => ({ McpServersPage: () => null }))
vi.mock('@pages/OnboardingPage', () => ({ OnboardingPage: () => null }))
vi.mock('@pages/SandboxUiPage', () => ({
  SandboxUiPage: ({ shortcutApp }: { shortcutApp?: { appRef: string } | null }) => {
    appHarness.sandboxUiShortcutAppRef = shortcutApp?.appRef ?? null
    return null
  },
}))
vi.mock('@pages/SettingsPage', () => ({ SettingsPage: () => null }))
vi.mock('@pages/UnavailablePage', () => ({ UnavailablePage: () => null }))
vi.mock('@pages/WorkflowsPage', () => ({ WorkflowsPage: () => null }))
vi.mock('@pages/FilesPage', async importOriginal => {
  const actual = await importOriginal<typeof import('@pages/FilesPage')>()
  return {
    ...actual,
    FilesPage: (props: React.ComponentProps<typeof actual.FilesPage>) => {
      appHarness.filesPageRenderCount += 1
      appHarness.filesPageLatestPendingAction = props.pendingResourceAction ?? null
      appHarness.filesPageReportLocation = props.onLocationChange ?? null
      if (props.pendingResourceAction) {
        appHarness.filesPagePendingActions.push(props.pendingResourceAction)
      }
      return (
        <actual.FilesPage
          {...props}
          onLocationChange={(gfsUri, name) => {
            appHarness.filesPageLastLocation = { gfsUri, name }
            props.onLocationChange?.(gfsUri, name)
          }}
        />
      )
    },
  }
})
vi.mock('@pages/FilePreviewPage', async importOriginal => {
  const actual = await importOriginal<typeof import('@pages/FilePreviewPage')>()
  return {
    ...actual,
    FilePreviewPage: (props: React.ComponentProps<typeof actual.FilePreviewPage>) => {
      if (props.pendingResourceAction) {
        appHarness.previewPagePendingActions.push(props.pendingResourceAction)
      }
      return <actual.FilePreviewPage {...props} />
    },
  }
})

vi.mocked(useAppController).mockImplementation(useReactiveController)

function makeController(workspaceTabs = createWorkspaceTabsState('chat-tab-1')): AppController {
  let controller: AppController
  let tabSequence = 2
  let navigationIntentSequence = 0
  const nextWorkspaceTabId = vi.fn(() => `integration-tab-${tabSequence++}`)
  const noop = vi.fn()
  const setWorkspaceTabs = vi.fn((updater: WorkspaceStateUpdater) => {
    const next = typeof updater === 'function' ? updater(controller.workspaceTabs) : updater
    if (next === controller.workspaceTabs) return
    controller.workspaceTabs = next
    appHarness.forceRender()
  })
  const clearAppsPicker = vi.fn(() => {
    if (!controller.appsPickerActive) return
    controller.appsPickerActive = false
    appHarness.forceRender()
  })
  const beginUserNavigationIntent = vi.fn(() => {
    navigationIntentSequence += 1
    controller.navigationIntentSequence = navigationIntentSequence
    appHarness.forceRender()
    return navigationIntentSequence
  })
  const isNavigationIntentCurrent = vi.fn(
    (sequence: number) => sequence === navigationIntentSequence
  )
  const selectWorkspaceTabById = vi.fn((id: string) => {
    if (!controller.workspaceTabs.tabs.some(tab => tab.id === id)) return false
    beginUserNavigationIntent()
    clearAppsPicker()
    setWorkspaceTabs(state => selectWorkspaceTab(state, id))
    return true
  })
  const showAppsPicker = vi.fn(() => {
    controller.appsPickerActive = true
    appHarness.forceRender()
  })
  const handleNavSelect = vi.fn((item: AppController['navItem']) => {
    if (item === DESKTOP_ROUTES.chat) {
      controller.selectedAgent = null
      clearAppsPicker()
      setWorkspaceTabs(state => {
        const active = activeWorkspaceTab(state)
        if (active?.kind === 'chat') return state
        const lastChat = [...state.tabs].reverse().find(tab => tab.kind === 'chat')
        return lastChat
          ? { ...state, activeTabId: lastChat.id }
          : newChatTab(state, nextWorkspaceTabId(), null)
      })
    } else if (item === DESKTOP_ROUTES.files) {
      clearAppsPicker()
      setWorkspaceTabs(state => openFilesTab(state, { id: nextWorkspaceTabId() }))
    } else {
      const section = settingsSectionForRoute(item)
      if (section)
        setWorkspaceTabs(state => openSettingsTab(state, { id: nextWorkspaceTabId(), section }))
    }
    appHarness.forceRender()
  })

  controller = {
    booting: false,
    initialExperienceLoading: false,
    busy: false,
    statusText: '',
    statusTone: 'info',
    isAuthenticated: true,
    sessionGeneration: 1,
    authenticatedPrincipalIdentity: 'integration-user:integration@example.test',
    availableTeamIds: ['team-a'],
    teamDirectoryHydrated: true,
    me: {
      id: 'integration-user',
      email: 'integration@example.test',
      name: 'Integration User',
      picture: null,
      teamId: 'team-a',
      teamName: 'Team A',
      role: 'member',
    },
    currentTeamId: 'team-a',
    navItem: DESKTOP_ROUTES.chat,
    selectedAgent: null,
    selectedAgentRoute: null,
    workspaceTabs,
    setWorkspaceTabs,
    activeWorkspaceTab: undefined,
    nextWorkspaceTabId,
    appsPickerActive: false,
    showAppsPicker,
    clearAppsPicker,
    navigationIntentSequence,
    beginUserNavigationIntent,
    isNavigationIntentCurrent,
    selectWorkspaceTabById,
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
    desktopEnvironmentSetupComplete: true,
    pendingDesktopEnvironmentSetup: null,
    desktopReleaseStatus: null,
    showRuntimeConfigSelector: false,
    runtimeConfigMissing: false,
    authTransitioning: false,
    handleEnsureTeamContext: vi.fn(async () => false),
    getCurrentTeamId: vi.fn(() => 'team-a'),
    isHostAccessBlocked: vi.fn(() => false),
    handleSelectChatAgent: vi.fn(
      (agentRef: string, options: { chatId?: string; keepNavItem?: boolean } = {}) => {
        controller.selectedAgent = agentRef
        controller.activeChatId = options.chatId ?? null
        if (!options.keepNavItem) {
          setWorkspaceTabs(state =>
            options.chatId
              ? openChatTab(state, { id: nextWorkspaceTabId(), agentRef, chatId: options.chatId })
              : newChatTab(state, nextWorkspaceTabId(), agentRef)
          )
        }
        appHarness.forceRender()
      }
    ),
    handleOpenNotification: vi.fn(
      (
        notification: { kind?: string; agentName: string; chatId?: string },
        options?: { keepNavItem?: boolean; navigationIntentSequence?: number }
      ) => {
        if (notification.kind !== 'assistant_reply') return
        controller.handleSelectChatAgent(notification.agentName, {
          ...(notification.chatId ? { chatId: notification.chatId } : {}),
          selectLatest: false,
          ...(options?.keepNavItem ? { keepNavItem: true } : {}),
        })
      }
    ),
    handleNavSelect,
    openFilesSectionWithReceipt: vi.fn((path: string | null = null) => {
      const intentSequence = beginUserNavigationIntent()
      clearAppsPicker()
      const next = openFilesTab(controller.workspaceTabs, { id: nextWorkspaceTabId(), path })
      setWorkspaceTabs(next)
      return next.activeTabId ? { ownerTabId: next.activeTabId, intentSequence } : null
    }),
    openFilesSection: vi.fn((path: string | null = null) => {
      controller.openFilesSectionWithReceipt(path)
    }),
    openPreviewSectionWithReceipt: vi.fn(preview => {
      const intentSequence = beginUserNavigationIntent()
      clearAppsPicker()
      const next = openPreviewTab(controller.workspaceTabs, {
        id: nextWorkspaceTabId(),
        title: preview.name,
        gfsUri: preview.gfsUri,
        fileKind: preview.kind,
        byteLength: preview.bytes,
        ...(preview.version !== undefined ? { resourceVersion: preview.version } : {}),
        ...('mimeType' in preview ? { mimeType: preview.mimeType } : {}),
      })
      setWorkspaceTabs(next)
      return next.activeTabId ? { ownerTabId: next.activeTabId, intentSequence } : null
    }),
    openPreviewSection: vi.fn(preview => {
      controller.openPreviewSectionWithReceipt(preview)
    }),
    handleLogout: noop,
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
  } as unknown as AppController
  return controller
}

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void }

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

type HarnessResource = Awaited<ReturnType<typeof resolvedFile>>
type PreviewDownload = Awaited<ReturnType<typeof previewDownloadResult>>
type HarnessGfsOptions = {
  accessibleRows?: ReturnType<typeof accessibleResource>[]
  childRowsByParent?: Map<string, ReturnType<typeof childView>[]>
  affordanceBits?: string[]
}

let originalClipboardDescriptor: PropertyDescriptor | undefined
let originalCreateObjectUrlDescriptor: PropertyDescriptor | undefined

function installClerum(
  resources: HarnessResource[],
  deferredByUri: ReadonlyMap<string, { promise: Promise<unknown> }> = new Map(),
  options: HarnessGfsOptions = {}
) {
  const rootPage = listAccessiblePage(
    options.accessibleRows ??
      resources.map(resource =>
        accessibleResource(
          resource.resourceId,
          resource.name,
          resource.kind === 'directory' ? 'directory' : 'file',
          {
            gfsUri: resource.gfsUri,
            parentResourceId: resource.parentResourceId,
            version: resource.version,
            bytes: resource.bytes,
          }
        )
      )
  )
  const resolveResourceByUri = vi.fn(async (uri: string) => {
    const pending = deferredByUri.get(uri)
    if (pending) return pending.promise
    const resource = resources.find(candidate => candidate.gfsUri === uri)
    if (!resource) throw new Error(`Unexpected GFS resolve: ${uri}`)
    return resolveResource(resource)
  })
  const deleteResource = vi.fn(async () => ({}))
  const createFolder = vi.fn(async () => ({}))
  const createFileFromPath = vi.fn(async () => ({}))
  const replaceFileFromPath = vi.fn(async () => ({}))
  const moveResource = vi.fn(async () => ({}))
  let userNavigationGeneration = 0
  const gfs = {
    getUserNavigationGeneration: vi.fn(() => userNavigationGeneration),
    advanceUserNavigationGeneration: vi.fn(() => (userNavigationGeneration += 1)),
    listAccessible: vi.fn(async () => rootPage),
    listChildren: vi.fn(async (resourceId: string) =>
      listChildrenPage(options.childRowsByParent?.get(resourceId) ?? [])
    ),
    resolve: resolveResourceByUri,
    affordances: vi.fn(async () =>
      resourceAffordances(options.affordanceBits ?? ['read', 'write', 'delete'])
    ),
    deleteResource,
    createFolder,
    createFileFromPath,
    replaceFileFromPath,
    moveResource,
    copyDeepLink: vi.fn(async () => ({ url: 'https://profile.fixture.test/link' })),
    download: vi.fn(),
    downloadPreview: vi.fn(async (gfsUri: string, _maxBytes: number) => {
      const resource = resources.find(candidate => candidate.gfsUri === gfsUri)
      if (!resource) throw new Error(`Unexpected GFS preview download: ${gfsUri}`)
      return previewDownloadResult(
        resource,
        new TextEncoder().encode('# fixture preview\n').buffer,
        _maxBytes
      )
    }),
    getPathForFile: vi.fn((file: File) => file.name),
    onDeepLink: vi.fn(() => vi.fn()),
    listPendingDeepLinks: vi.fn(async () => ({ links: [] })),
    acknowledgeDeepLink: vi.fn(async () => undefined),
  }
  const previousBridge = window.clerum
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: {
      ...previousBridge,
      app: { rendererReady: vi.fn(async () => undefined) },
      auth: {
        getDesktopAppInfo: vi.fn(async () => ({ version: 'test' })),
        getSessionGeneration: vi.fn(async () => 1),
      },
      shortcuts: {
        onCommand: vi.fn((handler: (commandId: string, source: 'host' | 'sandbox') => void) => {
          appHarness.shortcutCommand = (commandId, source) => {
            appHarness.lastShortcutCommand = commandId
            handler(commandId, source)
          }
          appHarness.shortcutRegistrationCount += 1
          return vi.fn()
        }),
      },
      sandboxUi: {
        onSessionInvalidated: vi.fn(() => vi.fn()),
        listApps: vi.fn(async () => ({ apps: [] })),
        listPendingDeepLinks: vi.fn(async () => ({ links: [] })),
        clearPendingDeepLinks: vi.fn(async () => undefined),
        acknowledgeDeepLink: vi.fn(async () => undefined),
        onDeepLink: vi.fn(() => vi.fn()),
        close: vi.fn(async () => undefined),
        getLocation: vi.fn(async () => null),
        focusActive: vi.fn(async () => true),
        setVisible: vi.fn(async () => undefined),
      },
      team: { directory: vi.fn(async () => ({ teams: [] })) },
      agents: { listMine: vi.fn(async () => ({ agents: [] })) },
      gfs,
    } as unknown as Window['clerum'],
  })
  return {
    gfs,
    deleteResource,
    createFolder,
    createFileFromPath,
    replaceFileFromPath,
    moveResource,
  }
}

function renderApp() {
  return render(
    <QueryClientProvider client={desktopQueryClient}>
      <App />
    </QueryClientProvider>
  )
}

async function produceLatestSidebarSession() {
  const clerum = installMockClerum()
  await clerum.chat.create('agent-a', 'drawer-sidebar-session')
  const index = await clerum.readIndex('agent-a')
  expect(index.chats).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: 'drawer-sidebar-session', title: 'New Chat' }),
    ])
  )
  return index.chats.map(chat => ({ ...chat, agentRef: 'agent-a' }))
}

function produceConversationNotification() {
  const controller = renderHook(() =>
    useNotificationsController({
      isAuthenticated: false,
      notificationSoundVolume: 0,
      canDeliverChatResponseNotification: allowNotificationDelivery,
      showDesktopNotification: grantDesktopNotification,
      decideApproval: noopAsync,
      pushToast: noop,
      setStatus: noop,
    })
  )
  act(() =>
    controller.result.current.pushNotification({
      kind: 'assistant_reply',
      agentName: 'agent-a',
      chatId: 'notification-chat',
      teamId: 'team-a',
      text: 'New reply',
      timestamp: 1,
    })
  )
  const notification = controller.result.current.notifications[0]
  controller.unmount()
  if (!notification) throw new Error('The notification producer did not emit a reply')
  return notification
}

function getWorkspaceTabButtons(label: string): HTMLButtonElement[] {
  const toolbar = screen.getByRole('toolbar', { name: 'Workspace tabs' })
  return within(toolbar).getAllByRole('button', { name: label }) as HTMLButtonElement[]
}

async function chooseDeleteAction(resourceName: string) {
  await chooseRowAction(resourceName, 'Delete')
}

function getResourceTreeRow(resourceName: string): HTMLElement | null {
  return (
    screen
      .queryAllByRole('treeitem')
      .find(
        item => item.querySelector('.da-file-explorer__name')?.textContent?.trim() === resourceName
      ) ?? null
  )
}

async function findResourceTreeRow(resourceName: string): Promise<HTMLElement> {
  await waitFor(() => expect(getResourceTreeRow(resourceName)).toBeTruthy())
  const row = getResourceTreeRow(resourceName)
  if (!row) throw new Error(`Could not find the exact sidebar row for ${resourceName}`)
  return row
}

async function openRowActions(resourceName: string) {
  const row = await findResourceTreeRow(resourceName)
  const rowLabel = row.querySelector<HTMLButtonElement>('.da-file-explorer__label')
  if (!rowLabel) throw new Error(`The sidebar row label is unavailable for ${resourceName}`)
  rowLabel.focus()
  fireEvent.keyDown(rowLabel, {
    key: 'F10',
    shiftKey: true,
  })
  return screen.findByRole('menu', { name: `Actions for ${resourceName}` })
}

async function chooseRowAction(resourceName: string, actionName: string) {
  await openRowActions(resourceName)
  if (actionName === 'Share') {
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Share' }))
    const shareMenu = await screen.findByRole('menu', { name: `Share options for ${resourceName}` })
    fireEvent.click(within(shareMenu).getByRole('menuitem', { name: 'Share' }))
    return
  }
  if (['Copy link', 'Copy file ID', 'Copy folder ID'].includes(actionName)) {
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Share' }))
    await screen.findByRole('menu', { name: `Share options for ${resourceName}` })
  }
  fireEvent.click(await screen.findByRole('menuitem', { name: actionName }))
}

async function chooseFilesAction(resourceName: string, actionName: string) {
  const browser = screen.getByRole('region', { name: 'EvenDrive browser' })
  fireEvent.click(within(browser).getByRole('button', { name: `Options for ${resourceName}` }))
  const menu = await screen.findByRole('menu', { name: `Actions for ${resourceName}` })
  if (['Copy link', 'Copy file ID', 'Copy folder ID'].includes(actionName)) {
    fireEvent.mouseEnter(within(menu).getByRole('menuitem', { name: 'Share' }))
    const shareMenu = await screen.findByRole('menu', { name: `Share options for ${resourceName}` })
    fireEvent.click(within(shareMenu).getByRole('menuitem', { name: actionName }))
    return
  }
  if (actionName === 'Share') {
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Share' }))
    const shareMenu = await screen.findByRole('menu', { name: `Share options for ${resourceName}` })
    fireEvent.click(within(shareMenu).getByRole('menuitem', { name: 'Share' }))
    return
  }
  fireEvent.click(within(menu).getByRole('menuitem', { name: actionName }))
}

async function chooseCurrentFilesAction(resourceName: string, actionName: string) {
  fireEvent.click(await screen.findByRole('button', { name: `Options for ${resourceName}` }))
  const menu = await screen.findByRole('menu', { name: `Actions for ${resourceName}` })
  fireEvent.click(await within(menu).findByRole('menuitem', { name: actionName }))
}

async function choosePreviewAction(resourceName: string, actionName: string) {
  const preview = document.querySelector<HTMLElement>('.da-gfs-preview-page')
  if (!preview) throw new Error('The current Preview page is not mounted')
  fireEvent.click(within(preview).getByRole('button', { name: `Options for ${resourceName}` }))
  const menu = await screen.findByRole('menu', { name: `Actions for ${resourceName}` })
  fireEvent.click(within(menu).getByRole('menuitem', { name: actionName }))
}

async function expectActionAtConsumer(
  observedRequests: unknown[],
  targetUri: string,
  actionId: string
) {
  await waitFor(() =>
    expect(observedRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: expect.any(Number), targetUri, actionId }),
      ])
    )
  )
}

async function confirmDelete(resourceName: string) {
  const title = await screen.findByText(`Delete ${resourceName}?`)
  const dialog = title.closest<HTMLElement>('[role="dialog"], [role="alertdialog"]')
  if (!dialog) throw new Error(`Delete confirmation for ${resourceName} is not in a dialog`)
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
}

async function openLiveTargetInSameFilesTab() {
  const sourceFolder = await resolveResource(
    resolvedDirectory('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'Source folder')
  )
  const targetFolder = await resolveResource(
    resolvedDirectory('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'Target folder', {
      parentResourceId: sourceFolder.resourceId,
    })
  )
  const targetRow = childView(targetFolder.resourceId, targetFolder.name, 'directory', {
    gfsUri: targetFolder.gfsUri,
    parentResourceId: sourceFolder.resourceId,
    version: targetFolder.version,
  })
  const { gfs, createFolder, createFileFromPath } = installClerum(
    [sourceFolder, targetFolder],
    new Map(),
    {
      accessibleRows: [
        accessibleResource(sourceFolder.resourceId, sourceFolder.name, 'directory', {
          gfsUri: sourceFolder.gfsUri,
        }),
      ],
      childRowsByParent: new Map([[sourceFolder.resourceId, [targetRow]]]),
    }
  )
  const controller = makeController(
    openFilesTab(createWorkspaceTabsState('chat-tab-1'), {
      id: 'same-files-tab',
      path: sourceFolder.gfsUri,
    })
  )
  controller.desktopEnvironmentSetupComplete = false
  appHarness.controller = controller
  renderApp()

  fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
  const sourceRow = await screen.findByRole('treeitem', { name: /Source folder/ })
  fireEvent.click(within(sourceRow).getByRole('button', { name: 'Expand Source folder' }))
  await findResourceTreeRow('Target folder')
  const filesBrowser = screen.getByRole('region', { name: 'EvenDrive browser' })
  fireEvent.click(within(filesBrowser).getByRole('button', { name: 'Target folder' }))

  await waitFor(() =>
    expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)).toMatchObject({
      id: 'same-files-tab',
      kind: 'files',
      files: { path: targetFolder.gfsUri },
    })
  )
  return { sourceFolder, targetFolder, gfs, createFolder, createFileFromPath }
}

const targetA = await resolveResource(
  resolvedFile('22222222222222222222222222222222', 'target-a.txt')
)
const targetB = await resolveResource(
  resolvedFile('33333333333333333333333333333333', 'target-b.txt')
)

function mockSidebarBounds() {
  const getBoundingClientRect = HTMLElement.prototype.getBoundingClientRect
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    if (this.classList.contains('left-nav')) {
      const width = 328
      const height = window.innerHeight || 768
      return {
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: width,
        bottom: height,
        width,
        height,
        toJSON: () => ({}),
      } as DOMRect
    }
    return getBoundingClientRect.call(this)
  })
}

beforeEach(() => {
  originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  originalCreateObjectUrlDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
  desktopQueryClient.clear()
  appHarness.forceRender = () => {}
  appHarness.shortcutCommand = () => {}
  appHarness.shortcutRegistrationCount = 0
  appHarness.lastShortcutCommand = null
  appHarness.filesPagePendingActions = []
  appHarness.filesPageLatestPendingAction = null
  appHarness.filesPageRenderCount = 0
  appHarness.filesPageLastLocation = null
  appHarness.filesPageReportLocation = null
  appHarness.previewPagePendingActions = []
  appHarness.sandboxUiShortcutAppRef = null
  appHarness.latestConversationNotification = null
  appHarness.controller = makeController()
  appHarness.useRealNavigationController = false
  vi.mocked(useAppController).mockImplementation(useReactiveController)
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn() })),
  })
  mockSidebarBounds()
})

afterEach(() => {
  cleanup()
  desktopQueryClient.clear()
  if (originalClipboardDescriptor) {
    Object.defineProperty(navigator, 'clipboard', originalClipboardDescriptor)
  } else {
    Reflect.deleteProperty(navigator, 'clipboard')
  }
  if (originalCreateObjectUrlDescriptor) {
    Object.defineProperty(URL, 'createObjectURL', originalCreateObjectUrlDescriptor)
  } else {
    Reflect.deleteProperty(URL, 'createObjectURL')
  }
  delete (window as { clerum?: unknown }).clerum
  vi.restoreAllMocks()
})

describe('App → Files action lifecycle integration', () => {
  it('keeps sidebar folder and file menus aligned with the shared action producer', async () => {
    const folder = await resolveResource(
      resolvedDirectory('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'Parity folder')
    )
    const file = await resolveResource(
      resolvedFile('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'parity-file.md')
    )
    const capabilities = ['read', 'write', 'delete', 'manage_acl', 'share']
    installClerum([folder, file], new Map(), { affordanceBits: capabilities })
    renderApp()

    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /Parity folder/ })
    await screen.findByRole('treeitem', { name: /parity-file\.md/ })

    const handlers = {
      refresh: () => {},
      share: () => {},
      'copy-link': () => {},
      'copy-route': () => {},
      'open-route': () => {},
      'open-folder': () => {},
      rename: () => {},
      move: () => {},
      'new-folder': () => {},
      'upload-file': () => {},
      'copy-content': () => {},
      preview: () => {},
      download: () => {},
      replace: () => {},
      delete: () => {},
    }
    const expectedFor = (kind: 'directory' | 'file', uri: string) =>
      getGfsMenuActions(
        buildGfsResourceActions({
          kind,
          uri,
          handlers,
          canRename: true,
          canMove: false,
          canCreateFolder: kind === 'directory',
          canUpload: kind === 'directory',
          canShare: true,
          canCopyContent: kind === 'file',
          canPreview: kind === 'file',
          canDownload: kind === 'file',
          canReplace: kind === 'file',
          canOpenFolder: kind === 'directory',
          canDelete: true,
        })
      )
        .filter(action => !['copy-link', 'copy-route'].includes(action.id))
        .map(action => ({ id: action.id, label: action.label }))

    for (const resource of [folder, file]) {
      const row = screen
        .getAllByRole('treeitem')
        .find(item => item.textContent?.includes(resource.name))
      expect(row).toBeTruthy()
      const menu = await openRowActions(resource.name)
      const expected = expectedFor(
        resource.kind === 'directory' ? 'directory' : 'file',
        resource.gfsUri
      )
      await waitFor(() => {
        const actual = Array.from(menu.querySelectorAll<HTMLElement>('[data-gfs-action]')).map(
          item => ({ id: item.dataset.gfsAction, label: item.textContent?.trim() })
        )
        expect(actual).toEqual(expected)
      })
      fireEvent.keyDown(menu, { key: 'Escape' })
    }
  })

  it('matches Files copy-link and copy-ID producers for the exact clicked URI', async () => {
    const file = await resolveResource(
      resolvedFile('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'copy-target.txt')
    )
    const { gfs } = installClerum([file])
    appHarness.controller = makeController(
      openFilesTab(createWorkspaceTabsState('chat-tab-1'), { id: 'files-root', path: null })
    )
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    renderApp()

    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await findResourceTreeRow(file.name)
    await chooseFilesAction(file.name, 'Copy link')
    await waitFor(() => expect(gfs.copyDeepLink).toHaveBeenCalledWith(file.gfsUri))
    await chooseFilesAction(file.name, 'Copy file ID')
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(file.gfsUri))
    const filesOutcome = {
      linkInputs: gfs.copyDeepLink.mock.calls,
      copiedIds: writeText.mock.calls,
    }

    gfs.copyDeepLink.mockClear()
    writeText.mockClear()
    await chooseRowAction(file.name, 'Copy link')
    await waitFor(() => expect(gfs.copyDeepLink).toHaveBeenCalledWith(file.gfsUri))
    await chooseRowAction(file.name, 'Copy file ID')
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(file.gfsUri))
    expect({ linkInputs: gfs.copyDeepLink.mock.calls, copiedIds: writeText.mock.calls }).toEqual(
      filesOutcome
    )
  })

  it('opens the same Files-owned Share dialog from a sidebar action', async () => {
    const parent = await resolveResource(
      resolvedDirectory('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'Share parent')
    )
    const file = await resolveResource(
      resolvedFile('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'share-target.txt', {
        parentResourceId: parent.resourceId,
      })
    )
    installClerum([parent, file], new Map(), {
      accessibleRows: [
        accessibleResource(parent.resourceId, parent.name, 'directory', {
          gfsUri: parent.gfsUri,
        }),
      ],
      childRowsByParent: new Map([
        [
          parent.resourceId,
          [
            childView(file.resourceId, file.name, 'file', {
              parentResourceId: parent.resourceId,
              version: file.version,
            }),
          ],
        ],
      ]),
      affordanceBits: ['read', 'manage_acl'],
    })
    Object.assign(window.clerum.team, {
      directory: vi.fn(async () => ({ items: [] })),
    })
    Object.assign(window.clerum.agents, {
      listMine: vi.fn(async () => []),
    })
    appHarness.controller = makeController(
      openFilesTab(createWorkspaceTabsState('chat-tab-1'), {
        id: 'files-parent',
        path: parent.gfsUri,
      })
    )
    renderApp()

    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    const sidebarParent = await screen.findByRole('treeitem', { name: /Share parent/ })
    fireEvent.click(within(sidebarParent).getByRole('button', { name: 'Expand Share parent' }))
    await findResourceTreeRow(file.name)
    await chooseFilesAction(file.name, 'Share')
    const filesDialog = await screen.findByRole('dialog', { name: `Share file ${file.name}` })
    const filesDialogName = filesDialog.getAttribute('aria-label')
    fireEvent.click(within(filesDialog).getByRole('button', { name: 'Close share dialog' }))

    await chooseRowAction(file.name, 'Share')
    const sidebarDialog = await screen.findByRole('dialog', { name: `Share file ${file.name}` })
    expect(sidebarDialog.getAttribute('aria-label')).toBe(filesDialogName)
    expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)).toMatchObject({
      kind: 'files',
      files: { path: null },
    })
  })

  it('opens the clicked folder through the same Files route as the row action', async () => {
    const folder = await resolveResource(
      resolvedDirectory('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'Open target folder')
    )
    installClerum([folder])
    appHarness.controller = makeController(
      openFilesTab(createWorkspaceTabsState('chat-tab-1'), { id: 'files-root', path: null })
    )
    renderApp()

    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await findResourceTreeRow(folder.name)
    await chooseFilesAction(folder.name, 'Open folder')
    await waitFor(() =>
      expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)).toMatchObject({
        kind: 'files',
        files: { path: folder.gfsUri },
      })
    )
    const filesOutcome = activeWorkspaceTab(appHarness.controller.workspaceTabs)?.files?.path

    await chooseRowAction(folder.name, 'Open folder')
    await waitFor(() =>
      expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)?.files?.path).toBe(
        folder.gfsUri
      )
    )
    expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)?.files?.path).toBe(filesOutcome)
  })

  it('opens Preview with the same resource version as the Files action', async () => {
    const file = await resolveResource(
      resolvedFile('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'preview-target.md', { version: 7 })
    )
    installClerum([file])
    appHarness.controller = makeController(
      openFilesTab(createWorkspaceTabsState('chat-tab-1'), { id: 'files-root', path: null })
    )
    renderApp()

    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await findResourceTreeRow(file.name)
    await chooseFilesAction(file.name, 'Preview')
    await waitFor(() =>
      expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)).toMatchObject({
        kind: 'preview',
        preview: { gfsUri: file.gfsUri, resourceVersion: file.version },
      })
    )
    const filesPreview = activeWorkspaceTab(appHarness.controller.workspaceTabs)?.preview

    await chooseRowAction(file.name, 'Preview')
    await waitFor(() =>
      expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)).toMatchObject({
        kind: 'preview',
        preview: { gfsUri: file.gfsUri, resourceVersion: file.version },
      })
    )
    expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)?.preview).toEqual(filesPreview)
  })

  it('routes unreadable authorized sidebar actions through the exact Files parent row', async () => {
    const parent = await resolveResource(
      resolvedDirectory('11111111111111111111111111111111', 'Vault')
    )
    const child = childView('44444444444444444444444444444444', 'secret.pdf', 'file', {
      parentResourceId: parent.resourceId,
      readable: false,
      version: 7,
    })
    const renameResource = vi.fn(async () => ({}))
    const { gfs } = installClerum([parent], new Map(), {
      accessibleRows: [
        accessibleResource(parent.resourceId, parent.name, 'directory', {
          gfsUri: parent.gfsUri,
        }),
      ],
      childRowsByParent: new Map([[parent.resourceId, [child]]]),
      affordanceBits: ['write', 'delete'],
    })
    const resolve = gfs.resolve
    Object.assign(gfs, {
      renameResource,
      resolve: vi.fn(async (uri: string) => {
        if (uri === child.gfsUri) throw new Error('403 Forbidden: unreadable resource')
        return resolve(uri)
      }),
    })

    appHarness.controller = makeController(
      openFilesTab(createWorkspaceTabsState('chat-tab-1'), {
        id: 'files-parent',
        path: parent.gfsUri,
      })
    )
    renderApp()
    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    const sidebarParent = await screen.findByRole('treeitem', { name: /Vault/ })
    fireEvent.click(within(sidebarParent).getByRole('button', { name: 'Expand Vault' }))
    await findResourceTreeRow('secret.pdf')
    const unreadableSidebarMenu = await openRowActions('secret.pdf')
    expect(
      await within(unreadableSidebarMenu).findByRole('menuitem', { name: 'Rename' })
    ).toBeTruthy()
    expect(
      within(unreadableSidebarMenu).queryByRole('menuitem', { name: 'Replace file' })
    ).toBeNull()
    fireEvent.keyDown(unreadableSidebarMenu, { key: 'Escape' })

    const filesBrowser = screen.getByRole('region', { name: 'EvenDrive browser' })
    fireEvent.click(within(filesBrowser).getByRole('button', { name: 'Options for secret.pdf' }))
    const filesMenu = await screen.findByRole('menu', { name: 'Actions for secret.pdf' })
    expect(within(filesMenu).queryByRole('menuitem', { name: 'Replace file' })).toBeNull()
    fireEvent.click(within(filesMenu).getByRole('menuitem', { name: 'Rename' }))
    const filesRenameForm = await screen.findByRole('form', { name: 'Rename resource' })
    fireEvent.change(within(filesRenameForm).getByLabelText('New name'), {
      target: { value: 'renamed-secret.pdf' },
    })
    fireEvent.click(within(filesRenameForm).getByRole('button', { name: 'Save name' }))
    await waitFor(() =>
      expect(renameResource).toHaveBeenCalledWith(child.resourceId, 'renamed-secret.pdf', 'main', 7)
    )

    renameResource.mockClear()
    await chooseRowAction('secret.pdf', 'Rename')
    const sidebarRenameForm = await screen.findByRole('form', { name: 'Rename resource' })
    expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)).toMatchObject({
      id: 'files-parent',
      kind: 'files',
      files: { path: parent.gfsUri },
    })
    fireEvent.change(within(sidebarRenameForm).getByLabelText('New name'), {
      target: { value: 'sidebar-renamed-secret.pdf' },
    })
    fireEvent.click(within(sidebarRenameForm).getByRole('button', { name: 'Save name' }))
    await waitFor(() =>
      expect(renameResource).toHaveBeenCalledWith(
        child.resourceId,
        'sidebar-renamed-secret.pdf',
        'main',
        7
      )
    )
    expect(renameResource).toHaveBeenCalledTimes(1)
    expect(gfs.resolve).not.toHaveBeenCalledWith(child.gfsUri)
  })

  it('does not rename a newer resource version after the sidebar route resolves', async () => {
    const parentResourceId = '11111111111111111111111111111111'
    const resourceId = '44444444444444444444444444444444'
    const parent = await resolveResource(resolvedDirectory(parentResourceId, 'Vault'))
    const resolvedVersion = await resolveResource(
      resolvedFile(resourceId, 'report.txt', { parentResourceId, version: 8 })
    )
    const clickedRow = childView(resourceId, 'report.txt', 'file', {
      parentResourceId,
      readable: true,
      version: 7,
    })
    const renameResource = vi.fn(async () => ({}))
    const { gfs } = installClerum([parent, resolvedVersion], new Map(), {
      accessibleRows: [
        accessibleResource(parent.resourceId, parent.name, 'directory', {
          gfsUri: parent.gfsUri,
        }),
      ],
      childRowsByParent: new Map([[parentResourceId, [clickedRow]]]),
      affordanceBits: ['write'],
    })
    Object.assign(gfs, { renameResource })

    renderApp()
    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    const sidebarParent = await screen.findByRole('treeitem', { name: /Vault/ })
    fireEvent.click(within(sidebarParent).getByRole('button', { name: 'Expand Vault' }))
    await findResourceTreeRow('report.txt')
    await chooseRowAction('report.txt', 'Rename')

    await waitFor(() => expect(gfs.resolve).toHaveBeenCalledWith(clickedRow.gfsUri))
    await waitFor(() => expect(appHarness.filesPageLatestPendingAction).toBeNull())
    expect(screen.queryAllByRole('form', { name: 'Rename resource' })).toHaveLength(0)
    expect(renameResource).not.toHaveBeenCalled()
    expect(appHarness.controller.pushToast).not.toHaveBeenCalledWith(
      'Renamed to report.txt',
      'success'
    )
  })

  it('cancels a pending Files action when the session generation changes', async () => {
    const target = await resolveResource(
      resolvedFile('44444444444444444444444444444444', 'session-target.txt', { version: 3 })
    )
    const delayedTarget = deferred<unknown>()
    const { deleteResource, gfs } = installClerum(
      [target],
      new Map([[target.gfsUri, delayedTarget]])
    )
    appHarness.controller = makeController()
    renderApp()

    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await findResourceTreeRow(target.name)
    await chooseDeleteAction(target.name)
    await expectActionAtConsumer(appHarness.filesPagePendingActions, target.gfsUri, 'delete')
    await waitFor(() => expect(gfs.resolve).toHaveBeenCalledWith(target.gfsUri))

    act(() => {
      appHarness.controller.sessionGeneration = 2
      appHarness.forceRender()
    })
    await waitFor(() => expect(appHarness.filesPageLatestPendingAction).toBeNull())
    await act(async () => {
      delayedTarget.resolve(target)
      await delayedTarget.promise
    })
    expect(deleteResource).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: `Delete ${target.name}?` })).toBeNull()
  })

  it('matches Files cancellation when a delayed sidebar action is superseded', async () => {
    type Model = { done: boolean }
    type Real = {
      scheduler: Scheduler
      cancelSidebarDelete: (scheduler: Scheduler) => Promise<void>
    }
    class CompareCancelledDelete implements AsyncCommand<Model, Real> {
      check(model: Model) {
        return !model.done
      }

      async run(model: Model, real: Real) {
        await real.cancelSidebarDelete(real.scheduler)
        model.done = true
      }

      toString() {
        return 'compare direct Files and sidebar Delete cancellation'
      }
    }

    const parentResourceId = '11111111111111111111111111111111'
    const resourceId = '44444444444444444444444444444444'
    const parent = await resolveResource(resolvedDirectory(parentResourceId, 'Vault'))
    const target = await resolveResource(
      resolvedFile(resourceId, 'report.txt', { parentResourceId, version: 3 })
    )
    const child = childView(resourceId, target.name, 'file', {
      parentResourceId,
      readable: true,
      version: target.version,
    })
    const { gfs, deleteResource } = installClerum([parent, target], new Map(), {
      accessibleRows: [
        accessibleResource(parent.resourceId, parent.name, 'directory', {
          gfsUri: parent.gfsUri,
        }),
      ],
      childRowsByParent: new Map([[parentResourceId, [child]]]),
      affordanceBits: ['delete'],
    })
    appHarness.controller = makeController(
      openFilesTab(createWorkspaceTabsState('chat-tab-1'), {
        id: 'files-parent',
        path: parent.gfsUri,
      })
    )
    renderApp()
    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    const sidebarParent = await screen.findByRole('treeitem', { name: /Vault/ })
    fireEvent.click(within(sidebarParent).getByRole('button', { name: 'Expand Vault' }))
    await findResourceTreeRow('report.txt')

    const filesBrowser = screen.getByRole('region', { name: 'EvenDrive browser' })
    fireEvent.click(within(filesBrowser).getByRole('button', { name: 'Options for report.txt' }))
    const filesMenu = await screen.findByRole('menu', { name: 'Actions for report.txt' })
    fireEvent.click(within(filesMenu).getByRole('menuitem', { name: 'Delete' }))
    expect(await screen.findByRole('dialog', { name: 'Delete report.txt?' })).toBeTruthy()
    fireEvent.click(screen.getByTestId('nav-chat'))
    await waitFor(() =>
      expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)?.kind).toBe('chat')
    )
    expect(screen.queryByRole('dialog', { name: 'Delete report.txt?' })).toBeNull()
    expect(deleteResource).not.toHaveBeenCalled()
    const filesOutcome = {
      deleteCalls: deleteResource.mock.calls,
      dialogs: screen.queryAllByRole('dialog').map(dialog => dialog.textContent),
      toasts: vi.mocked(appHarness.controller.pushToast).mock.calls,
      activeKind: activeWorkspaceTab(appHarness.controller.workspaceTabs)?.kind,
    }

    vi.mocked(appHarness.controller.pushToast).mockClear()
    const originalResolve = gfs.resolve
    const command = new CompareCancelledDelete()
    const schedulerArbitrary = fc.scheduler()
    await fc.assert(
      fc.asyncProperty(
        schedulerArbitrary,
        fc.commands([fc.constant(command)], { maxCommands: 1, size: '+1' }),
        async (scheduler, commands) => {
          Object.assign(gfs, {
            resolve: vi.fn(async (uri: string) => {
              const result = originalResolve(uri)
              return uri === target.gfsUri
                ? scheduler.schedule(result, 'Files target resolution')
                : result
            }),
          })
          const model: Model = { done: false }
          const real: Real = {
            scheduler,
            cancelSidebarDelete: async activeScheduler => {
              await chooseDeleteAction('report.txt')
              await waitFor(() =>
                expect(appHarness.filesPageLatestPendingAction).toMatchObject({
                  actionId: 'delete',
                  targetUri: target.gfsUri,
                })
              )
              fireEvent.click(screen.getByTestId('nav-chat'))
              await waitFor(() =>
                expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)?.kind).toBe('chat')
              )
              await activeScheduler.waitAll()
            },
          }
          const generatedCommands = [...commands]
          if (generatedCommands.length === 0) generatedCommands.push(command)
          await fc.asyncModelRun(() => ({ model, real }), generatedCommands)
          expect(model.done).toBe(true)
          expect(deleteResource).not.toHaveBeenCalled()
          expect(screen.queryByRole('dialog', { name: 'Delete report.txt?' })).toBeNull()
          const sidebarOutcome = {
            deleteCalls: deleteResource.mock.calls,
            dialogs: screen.queryAllByRole('dialog').map(dialog => dialog.textContent),
            toasts: vi.mocked(appHarness.controller.pushToast).mock.calls,
            activeKind: activeWorkspaceTab(appHarness.controller.workspaceTabs)?.kind,
          }
          expect(sidebarOutcome).toEqual(filesOutcome)
        }
      ),
      { numRuns: 1, seed: 281109 }
    )
  })

  it('executes an action on the live same-tab Files route after S → T navigation', async () => {
    const { targetFolder } = await openLiveTargetInSameFilesTab()

    await chooseRowAction(targetFolder.name, 'Delete')

    expect(await screen.findByText(`Delete ${targetFolder.name}?`)).toBeTruthy()
    expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)).toMatchObject({
      id: 'same-files-tab',
      kind: 'files',
      files: { path: targetFolder.gfsUri },
    })
    expect(
      appHarness.controller.workspaceTabs.tabs.filter(tab => tab.kind === 'files')
    ).toHaveLength(1)
  })

  it('opens the exact ancestor destination when acting on A after the same tab moves A → B', async () => {
    const { sourceFolder, targetFolder, createFolder } = await openLiveTargetInSameFilesTab()

    expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)).toMatchObject({
      id: 'same-files-tab',
      kind: 'files',
      files: { path: targetFolder.gfsUri },
    })
    expect(
      appHarness.controller.workspaceTabs.tabs.find(tab => tab.id === 'same-files-tab')
    ).toMatchObject({
      files: { path: targetFolder.gfsUri },
    })

    await chooseRowAction(sourceFolder.name, 'New folder')

    const dialog = await screen.findByRole('dialog', { name: 'New folder' })
    expect(dialog.textContent).toContain(`Create a new folder in ${sourceFolder.name}.`)
    await expectActionAtConsumer(
      appHarness.filesPagePendingActions,
      sourceFolder.gfsUri,
      'new-folder'
    )

    const activeTab = activeWorkspaceTab(appHarness.controller.workspaceTabs)
    expect(activeTab).toMatchObject({ kind: 'files', files: { path: sourceFolder.gfsUri } })
    expect(activeTab?.id).not.toBe('same-files-tab')
    expect(
      appHarness.controller.workspaceTabs.tabs.find(tab => tab.id === 'same-files-tab')
    ).toMatchObject({ id: 'same-files-tab', kind: 'files', files: { path: targetFolder.gfsUri } })
    expect(
      appHarness.controller.workspaceTabs.tabs.filter(tab => tab.kind === 'files')
    ).toHaveLength(2)

    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Folder name' }), {
      target: { value: 'Created in ancestor' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create folder' }))
    await waitFor(() =>
      expect(createFolder).toHaveBeenCalledWith(
        sourceFolder.resourceId,
        'Created in ancestor',
        'main'
      )
    )
  })

  it('matches the Files New folder handler for the exact clicked folder', async () => {
    const { sourceFolder, targetFolder, createFolder } = await openLiveTargetInSameFilesTab()
    fireEvent.click(
      within(screen.getByRole('region', { name: 'EvenDrive browser' })).getByRole('button', {
        name: sourceFolder.name,
      })
    )
    await waitFor(() =>
      expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)).toMatchObject({
        kind: 'files',
        files: { path: sourceFolder.gfsUri },
      })
    )

    await chooseFilesAction(targetFolder.name, 'New folder')
    const filesDialog = await screen.findByRole('dialog', { name: 'New folder' })
    expect(filesDialog.textContent).toContain(`Create a new folder in ${targetFolder.name}.`)
    fireEvent.change(within(filesDialog).getByRole('textbox', { name: 'Folder name' }), {
      target: { value: 'Created from sidebar' },
    })
    fireEvent.click(within(filesDialog).getByRole('button', { name: 'Create folder' }))
    await waitFor(() => expect(createFolder).toHaveBeenCalledTimes(1))
    const filesCalls = createFolder.mock.calls.map(call => [...call])
    createFolder.mockClear()

    await chooseRowAction(targetFolder.name, 'New folder')
    const sidebarDialog = await screen.findByRole('dialog', { name: 'New folder' })
    expect(sidebarDialog.textContent).toContain(`Create a new folder in ${targetFolder.name}.`)
    expect(sidebarDialog.contains(document.activeElement), document.activeElement?.outerHTML).toBe(
      true
    )
    fireEvent.change(within(sidebarDialog).getByRole('textbox', { name: 'Folder name' }), {
      target: { value: 'Created from sidebar' },
    })
    fireEvent.click(within(sidebarDialog).getByRole('button', { name: 'Create folder' }))

    await waitFor(() => expect(createFolder).toHaveBeenCalledTimes(1))
    expect(createFolder.mock.calls.map(call => [...call])).toEqual(filesCalls)
  })

  it('matches the Files upload handler and destination for the clicked folder', async () => {
    const { targetFolder, createFileFromPath } = await openLiveTargetInSameFilesTab()
    const filesBrowser = screen.getByRole('region', { name: 'EvenDrive browser' })
    const uploadInput = within(filesBrowser).getByLabelText('Upload file', {
      selector: 'input[type="file"]',
    }) as HTMLInputElement
    const clickChooser = vi.spyOn(uploadInput, 'click').mockImplementation(() => undefined)

    await chooseCurrentFilesAction(targetFolder.name, 'Upload file')
    await waitFor(() => expect(clickChooser).toHaveBeenCalledTimes(1))
    const upload = new File(['test upload'], 'sidebar-upload.md', { type: 'text/markdown' })
    fireEvent.change(uploadInput, { target: { files: [upload] } })
    await waitFor(() => expect(createFileFromPath).toHaveBeenCalledTimes(1))
    const filesCalls = createFileFromPath.mock.calls.map(call => [...call])
    createFileFromPath.mockClear()
    clickChooser.mockClear()

    await chooseRowAction(targetFolder.name, 'Upload file')
    await waitFor(() => expect(clickChooser).toHaveBeenCalledTimes(1))
    const sidebarUpload = new File(['test upload'], 'sidebar-upload.md', { type: 'text/markdown' })
    fireEvent.change(uploadInput, { target: { files: [sidebarUpload] } })
    await waitFor(() => expect(createFileFromPath).toHaveBeenCalledTimes(1))
    expect(createFileFromPath.mock.calls.map(call => [...call])).toEqual(filesCalls)
    expect(filesCalls[0]).toEqual([
      targetFolder.resourceId,
      'sidebar-upload.md',
      'sidebar-upload.md',
      'main',
    ])
  })

  it('uses the Files save-to-disk handler for Download from the sidebar', async () => {
    const file = await resolveResource(
      resolvedFile('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'download-target.txt')
    )
    const { gfs } = installClerum([file])
    const download = vi.fn(async () => ({ bytes: new Uint8Array([1, 2, 3]).buffer }))
    Object.assign(gfs, { download })
    appHarness.controller = makeController(
      openFilesTab(createWorkspaceTabsState('chat-tab-1'), { id: 'files-root', path: null })
    )
    const anchorDownloads: Array<{ filename: string; href: string }> = []
    const createObjectUrl = vi.fn(() => 'blob:sidebar-parity')
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: createObjectUrl,
    })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement
    ) {
      anchorDownloads.push({ filename: this.download, href: this.href })
    })
    renderApp()

    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await findResourceTreeRow(file.name)
    await chooseFilesAction(file.name, 'Download')
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(anchorDownloads).toHaveLength(1))
    const filesOutcome = {
      downloadInputs: download.mock.calls,
      filenames: anchorDownloads.map(anchor => anchor.filename),
    }

    download.mockClear()
    anchorDownloads.length = 0
    createObjectUrl.mockClear()
    vi.mocked(appHarness.controller.pushToast).mockClear()
    await chooseRowAction(file.name, 'Download')
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(anchorDownloads).toHaveLength(1))
    expect({
      downloadInputs: download.mock.calls,
      filenames: anchorDownloads.map(anchor => anchor.filename),
    }).toEqual(filesOutcome)
    expect(download.mock.calls[0]).toEqual([file.gfsUri])
    expect(anchorDownloads[0]?.filename).toBe(file.name)
    expect(appHarness.controller.pushToast).toHaveBeenCalledWith(
      `Downloaded ${file.name}`,
      'success'
    )
  })

  it('completes Replace through the Files handler with the selected file and clicked version', async () => {
    const file = await resolveResource(
      resolvedFile('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'replace-target.bin', { version: 7 })
    )
    const { gfs, replaceFileFromPath } = installClerum([file], new Map(), {
      affordanceBits: ['read', 'write'],
    })
    appHarness.controller = makeController(
      openFilesTab(createWorkspaceTabsState('chat-tab-1'), { id: 'files-root', path: null })
    )
    renderApp()

    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    const row = await findResourceTreeRow(file.name)
    const menu = await openRowActions(file.name)
    await within(menu).findByRole('menuitem', { name: 'Replace file' })
    const sidebarInput = within(row).getByLabelText(`Replace ${file.name}`) as HTMLInputElement
    const openSidebarChooser = vi.spyOn(sidebarInput, 'click').mockImplementation(() => undefined)
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Replace file' }))
    await waitFor(() => expect(openSidebarChooser).toHaveBeenCalledTimes(1))
    const replacement = new File(['replacement bytes'], 'replacement.txt', {
      type: 'text/plain',
    })
    fireEvent.change(sidebarInput, { target: { files: [replacement] } })
    await waitFor(() =>
      expect(replaceFileFromPath).toHaveBeenCalledWith(file.resourceId, replacement.name, 'main', 7)
    )
    expect(gfs.getPathForFile).toHaveBeenCalledWith(replacement)
    expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)).toMatchObject({
      kind: 'files',
      files: { path: null },
    })
  })

  it('reuses an inactive exact-destination Files tab and completes the pending action', async () => {
    const target = await resolveResource(
      resolvedFile('22222222222222222222222222222222', 'existing-target.txt')
    )
    const initialTabs = openFilesTab(createWorkspaceTabsState('chat-tab-1'), {
      id: 'existing-target-files',
      path: target.gfsUri,
    })
    appHarness.controller = makeController(selectWorkspaceTab(initialTabs, 'chat-tab-1'))
    installClerum([target])
    renderApp()

    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /existing-target\.txt/ })
    await chooseDeleteAction(target.name)

    expect(await screen.findByText(`Delete ${target.name}?`)).toBeTruthy()
    expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)).toMatchObject({
      id: 'existing-target-files',
      kind: 'files',
      files: { path: null },
    })
    expect(
      appHarness.controller.workspaceTabs.tabs.filter(tab => tab.kind === 'files')
    ).toHaveLength(1)
  })

  it('hands a sidebar action from Chat with no Files tab to the exact ready resource once', async () => {
    const deferredTarget = deferred<unknown>()
    const deferredByUri = new Map([[targetA.gfsUri, deferredTarget]])
    const { gfs, deleteResource } = installClerum([targetA], deferredByUri)
    appHarness.controller.desktopEnvironmentSetupComplete = false
    renderApp()

    expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)?.kind).toBe('chat')
    expect(appHarness.controller.workspaceTabs.tabs.some(tab => tab.kind === 'files')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /target-a\.txt/ })
    await chooseDeleteAction('target-a.txt')

    const breadcrumb = await screen.findByRole('button', { name: 'Shared with me' })
    expect((breadcrumb as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByText('Delete target-a.txt?')).toBeNull()
    expect(gfs.resolve).toHaveBeenCalledWith(targetA.gfsUri)
    await expectActionAtConsumer(appHarness.filesPagePendingActions, targetA.gfsUri, 'delete')
    expect(deleteResource).not.toHaveBeenCalled()

    await act(async () => {
      deferredTarget.resolve(targetA)
      await deferredTarget.promise
    })
    await confirmDelete('target-a.txt')
    await waitFor(() => expect(deleteResource).toHaveBeenCalledTimes(1))
    expect(deleteResource.mock.calls[0]).toEqual([targetA.resourceId, 'main', targetA.version])
    expect(gfs.resolve).toHaveBeenCalledWith(targetA.gfsUri)
  })

  it('cancels a pending sidebar action when its active owner tab is selected again', async () => {
    const deferredTarget = deferred<unknown>()
    const deferredByUri = new Map([[targetA.gfsUri, deferredTarget]])
    const { gfs, deleteResource } = installClerum([targetA], deferredByUri)
    appHarness.controller.desktopEnvironmentSetupComplete = false
    renderApp()

    expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)?.kind).toBe('chat')
    expect(appHarness.controller.workspaceTabs.tabs.some(tab => tab.kind === 'files')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /target-a\.txt/ })
    await chooseDeleteAction('target-a.txt')

    const breadcrumb = await screen.findByRole('button', { name: 'Shared with me' })
    expect((breadcrumb as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByText('Delete target-a.txt?')).toBeNull()
    expect(gfs.resolve).toHaveBeenCalledWith(targetA.gfsUri)
    expect(deleteResource).not.toHaveBeenCalled()

    const tabs = within(screen.getByRole('toolbar', { name: 'Workspace tabs' })).getAllByRole(
      'button'
    )
    const activeTab = tabs.find(tab => tab.getAttribute('aria-pressed') === 'true')
    expect(activeTab).toBeTruthy()
    fireEvent.click(activeTab as HTMLButtonElement)

    await act(async () => {
      deferredTarget.resolve(targetA)
      await deferredTarget.promise
    })
    expect(screen.queryByText('Delete target-a.txt?')).toBeNull()
    expect(deleteResource).not.toHaveBeenCalled()
    expect(gfs.resolve).toHaveBeenCalledWith(targetA.gfsUri)
  })

  it('cancels a pending folder action when the sidebar reopens the same active folder', async () => {
    const folder = await resolveResource(
      resolvedDirectory('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'Folder A')
    )
    const deferredFolder = deferred<unknown>()
    const { gfs, createFolder } = installClerum(
      [folder],
      new Map([[folder.gfsUri, deferredFolder]])
    )
    appHarness.controller = makeController(
      openFilesTab(createWorkspaceTabsState('chat-tab-1'), {
        id: 'folder-a-owner',
        path: folder.gfsUri,
      })
    )
    appHarness.controller.desktopEnvironmentSetupComplete = false
    renderApp()

    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    const folderRow = await screen.findByRole('treeitem', { name: /Folder A/ })
    const openFilesSection = appHarness.controller.openFilesSectionWithReceipt
    await chooseRowAction('Folder A', 'New folder')
    expect(openFilesSection).toHaveBeenCalledWith(folder.gfsUri)
    await waitFor(() => expect(gfs.resolve).toHaveBeenCalledWith(folder.gfsUri))
    await expectActionAtConsumer(appHarness.filesPagePendingActions, folder.gfsUri, 'new-folder')
    expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)?.id).toBe('folder-a-owner')
    expect(screen.queryByRole('dialog', { name: 'New folder' })).toBeNull()

    const intentBeforeSelection = appHarness.controller.navigationIntentSequence
    fireEvent.doubleClick(within(folderRow).getByRole('button', { name: 'Folder A' }))
    expect(appHarness.controller.navigationIntentSequence).toBeGreaterThan(intentBeforeSelection)
    expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)).toMatchObject({
      id: 'folder-a-owner',
      kind: 'files',
      files: { path: folder.gfsUri },
    })

    await act(async () => {
      deferredFolder.resolve(folder)
      await deferredFolder.promise
    })
    expect(screen.queryByRole('dialog', { name: 'New folder' })).toBeNull()
    expect(createFolder).not.toHaveBeenCalled()
  })

  it('cancels a pending sidebar action when a tabs shortcut reselects its active owner', async () => {
    const deferredTarget = deferred<unknown>()
    const deferredByUri = new Map([[targetA.gfsUri, deferredTarget]])
    const { gfs, deleteResource } = installClerum([targetA], deferredByUri)
    appHarness.controller.desktopEnvironmentSetupComplete = false
    renderApp()

    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /target-a\.txt/ })
    await chooseDeleteAction('target-a.txt')

    const breadcrumb = await screen.findByRole('button', { name: 'Shared with me' })
    expect((breadcrumb as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByText('Delete target-a.txt?')).toBeNull()
    expect(gfs.resolve).toHaveBeenCalledWith(targetA.gfsUri)
    await expectActionAtConsumer(appHarness.filesPagePendingActions, targetA.gfsUri, 'delete')
    expect(deleteResource).not.toHaveBeenCalled()

    expect(appHarness.shortcutRegistrationCount).toBeGreaterThan(0)
    expect(appHarness.controller.workspaceTabs.tabs).toHaveLength(2)
    const ownerTabId = activeWorkspaceTab(appHarness.controller.workspaceTabs)?.id
    const activeTabIndex = appHarness.controller.workspaceTabs.tabs.findIndex(
      tab => tab.id === ownerTabId
    )
    expect(activeTabIndex).toBeGreaterThanOrEqual(0)
    const intentBeforeSelection = appHarness.controller.navigationIntentSequence
    expect(
      document.querySelector(
        '[role="dialog"][aria-modal="true"], .da-plugin-consent[role="dialog"]'
      )
    ).toBeNull()
    const commandId = `tabs.select${activeTabIndex + 1}`
    act(() => appHarness.shortcutCommand(commandId, 'host'))
    expect(appHarness.lastShortcutCommand).toBe(commandId)
    expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)?.id).toBe(ownerTabId)
    expect(appHarness.controller.navigationIntentSequence).toBeGreaterThan(intentBeforeSelection)
    await act(async () => {
      deferredTarget.resolve(targetA)
      await deferredTarget.promise
    })

    expect(screen.queryByText('Delete target-a.txt?')).toBeNull()
    expect(deleteResource).not.toHaveBeenCalled()
  })

  it('cancels a pending Files action when the drawer chat switcher advances user intent', async () => {
    const deferredTarget = deferred<unknown>()
    const deferredByUri = new Map([[targetA.gfsUri, deferredTarget]])
    const { gfs, deleteResource } = installClerum([targetA], deferredByUri)
    appHarness.controller.desktopEnvironmentSetupComplete = false
    renderApp()

    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /target-a\.txt/ })
    await chooseDeleteAction('target-a.txt')

    const breadcrumb = await screen.findByRole('button', { name: 'Shared with me' })
    expect((breadcrumb as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByText('Delete target-a.txt?')).toBeNull()
    expect(gfs.resolve).toHaveBeenCalledWith(targetA.gfsUri)
    await expectActionAtConsumer(appHarness.filesPagePendingActions, targetA.gfsUri, 'delete')
    expect(deleteResource).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Toggle chat drawer' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Open chats' }))
    const chats = await screen.findByRole('listbox', { name: 'Open chats' })
    const currentChat = within(chats).getByRole('option', { name: 'New chat' })
    const intentBeforeSelection = appHarness.controller.navigationIntentSequence
    fireEvent.click(currentChat)
    expect(appHarness.controller.navigationIntentSequence).toBeGreaterThan(intentBeforeSelection)
    await act(async () => {
      deferredTarget.resolve(targetA)
      await deferredTarget.promise
    })

    expect(screen.queryByText('Delete target-a.txt?')).toBeNull()
    expect(deleteResource).not.toHaveBeenCalled()
  })

  it('cancels a pending Files action when the sidebar selects a chat in the open drawer', async () => {
    const deferredTarget = deferred<unknown>()
    const latestChatSessions = await produceLatestSidebarSession()
    const { gfs, deleteResource } = installClerum(
      [targetA],
      new Map([[targetA.gfsUri, deferredTarget]])
    )
    appHarness.controller.desktopEnvironmentSetupComplete = false
    appHarness.controller.latestChatSessions = latestChatSessions
    renderApp()

    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /target-a\.txt/ })
    await chooseDeleteAction('target-a.txt')
    await waitFor(() => expect(gfs.resolve).toHaveBeenCalledWith(targetA.gfsUri))
    expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)).toMatchObject({
      kind: 'files',
      files: { path: targetA.gfsUri },
    })
    expect(
      ((await screen.findByRole('button', { name: 'Shared with me' })) as HTMLButtonElement)
        .disabled
    ).toBe(true)
    await expectActionAtConsumer(appHarness.filesPagePendingActions, targetA.gfsUri, 'delete')
    expect(deleteResource).not.toHaveBeenCalled()

    const ownerTabId = activeWorkspaceTab(appHarness.controller.workspaceTabs)?.id
    fireEvent.click(screen.getByRole('button', { name: 'Toggle chat drawer' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open New Chat' }))
    expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)?.id).toBe(ownerTabId)
    expect(appHarness.controller.handleSelectChatAgent).toHaveBeenCalledWith(
      'agent-a',
      expect.objectContaining({
        chatId: 'drawer-sidebar-session',
        keepNavItem: true,
        selectLatest: false,
      })
    )

    await act(async () => {
      deferredTarget.resolve(targetA)
      await deferredTarget.promise
    })
    expect(screen.queryByText('Delete target-a.txt?')).toBeNull()
    expect(deleteResource).not.toHaveBeenCalled()
  })

  it('cancels a pending Files action when a notification selects a drawer chat', async () => {
    const deferredTarget = deferred<unknown>()
    const { gfs, deleteResource } = installClerum(
      [targetA],
      new Map([[targetA.gfsUri, deferredTarget]])
    )
    appHarness.controller.desktopEnvironmentSetupComplete = false
    appHarness.controller.notifications = [produceConversationNotification()]
    renderApp()

    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /target-a\.txt/ })
    await chooseDeleteAction('target-a.txt')
    await waitFor(() => expect(gfs.resolve).toHaveBeenCalledWith(targetA.gfsUri))
    expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)).toMatchObject({
      kind: 'files',
      files: { path: targetA.gfsUri },
    })
    expect(
      ((await screen.findByRole('button', { name: 'Shared with me' })) as HTMLButtonElement)
        .disabled
    ).toBe(true)
    expect(screen.queryByText('Delete target-a.txt?')).toBeNull()
    await expectActionAtConsumer(appHarness.filesPagePendingActions, targetA.gfsUri, 'delete')

    fireEvent.click(screen.getByRole('button', { name: 'Toggle chat drawer' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open conversation notification' }))
    expect(appHarness.controller.handleOpenNotification).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'notification-chat' }),
      { keepNavItem: true }
    )
    expect(appHarness.controller.selectedAgent).toBe('agent-a')
    expect(appHarness.controller.activeChatId).toBe('notification-chat')
    expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)?.kind).toBe('files')

    await act(async () => {
      deferredTarget.resolve(targetA)
      await deferredTarget.promise
    })
    expect(screen.queryByText('Delete target-a.txt?')).toBeNull()
    expect(deleteResource).not.toHaveBeenCalled()
    expect(gfs.download).not.toHaveBeenCalled()
    expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)?.kind).toBe('files')
  })

  it('cancels a pending Files action when sidebar navigation selects Chat', async () => {
    const deferredTarget = deferred<unknown>()
    const deferredByUri = new Map([[targetA.gfsUri, deferredTarget]])
    const { gfs, deleteResource } = installClerum([targetA], deferredByUri)
    appHarness.controller.desktopEnvironmentSetupComplete = false
    renderApp()

    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /target-a\.txt/ })
    await chooseDeleteAction('target-a.txt')

    expect(
      ((await screen.findByRole('button', { name: 'Shared with me' })) as HTMLButtonElement)
        .disabled
    ).toBe(true)
    expect(gfs.resolve).toHaveBeenCalledWith(targetA.gfsUri)
    expect(deleteResource).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('nav-chat'))
    await waitFor(() =>
      expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)?.kind).toBe('chat')
    )

    await act(async () => {
      deferredTarget.resolve(targetA)
      await deferredTarget.promise
    })
    const filesTab = getWorkspaceTabButtons('Files').find(
      tab => tab.getAttribute('aria-pressed') !== 'true'
    )
    expect(filesTab).toBeTruthy()
    fireEvent.click(filesTab as HTMLButtonElement)
    await waitFor(() =>
      expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)?.kind).toBe('files')
    )
    expect(screen.queryByText('Delete target-a.txt?')).toBeNull()
    expect(deleteResource).not.toHaveBeenCalled()
  })

  it('cancels a pending sidebar action when its Files owner tab closes', async () => {
    const deferredTarget = deferred<unknown>()
    const deferredByUri = new Map([[targetA.gfsUri, deferredTarget]])
    const { gfs, deleteResource } = installClerum([targetA], deferredByUri)
    renderApp()

    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /target-a\.txt/ })
    await chooseDeleteAction('target-a.txt')

    const breadcrumb = await screen.findByRole('button', { name: 'Shared with me' })
    expect((breadcrumb as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByText('Delete target-a.txt?')).toBeNull()
    expect(deleteResource).not.toHaveBeenCalled()

    const ownerTab = getWorkspaceTabButtons('Files').find(
      tab => tab.getAttribute('aria-pressed') === 'true'
    )
    expect(ownerTab).toBeTruthy()
    const ownerTitle = ownerTab?.getAttribute('aria-label')
    expect(ownerTitle).toBeTruthy()
    expect(gfs.resolve).toHaveBeenCalledWith(targetA.gfsUri)
    fireEvent.click(screen.getByRole('button', { name: `Close ${ownerTitle}` }))
    await waitFor(() => {
      expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)?.kind).toBe('chat')
      expect(appHarness.controller.workspaceTabs.tabs.some(tab => tab.kind === 'files')).toBe(false)
    })

    await act(async () => {
      deferredTarget.resolve(targetA)
      await deferredTarget.promise
    })
    expect(screen.queryByText('Delete target-a.txt?')).toBeNull()
    expect(deleteResource).not.toHaveBeenCalled()
  })

  it('distinguishes an active Files-root tab from no Files tab and completes the same handoff', async () => {
    const workspaceTabs = openFilesTab(createWorkspaceTabsState('chat-tab-1'), {
      id: 'root-files-tab',
      path: null,
    })
    appHarness.controller = makeController(workspaceTabs)
    const { deleteResource } = installClerum([targetA], new Map(), {
      accessibleRows: [
        accessibleResource(targetA.resourceId, targetA.name, 'file', {
          gfsUri: targetA.gfsUri,
          version: targetA.version,
          permissions: ['read', 'write', 'delete', 'manage_acl', 'share'],
        }),
      ],
    })
    renderApp()

    const rootTab = getWorkspaceTabButtons('Files')[0]
    expect(rootTab?.getAttribute('aria-pressed')).toBe('true')
    expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)).toMatchObject({
      id: 'root-files-tab',
      kind: 'files',
      files: { path: null },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /target-a\.txt/ })
    vi.mocked(appHarness.controller.pushToast).mockClear()
    await chooseFilesAction(targetA.name, 'Delete')
    const filesDialog = await screen.findByText(`Delete ${targetA.name}?`)
    await confirmDelete(targetA.name)
    await waitFor(() => expect(deleteResource).toHaveBeenCalledTimes(1))
    const filesOutcome = {
      calls: deleteResource.mock.calls.map(call => [...call]),
      feedback: vi.mocked(appHarness.controller.pushToast).mock.calls.map(call => [...call]),
      title: filesDialog.textContent,
    }
    deleteResource.mockClear()
    vi.mocked(appHarness.controller.pushToast).mockClear()

    await chooseDeleteAction('target-a.txt')
    const sidebarDialog = await screen.findByText(`Delete ${targetA.name}?`)
    await confirmDelete('target-a.txt')

    await waitFor(() => expect(deleteResource).toHaveBeenCalledTimes(1))
    expect({
      calls: deleteResource.mock.calls.map(call => [...call]),
      feedback: vi.mocked(appHarness.controller.pushToast).mock.calls.map(call => [...call]),
      title: sidebarDialog.textContent,
    }).toEqual(filesOutcome)
    expect(filesOutcome.calls[0]).toEqual([targetA.resourceId, 'main', targetA.version])
  })

  it('cancels on a reachable root-tab switch before target arrival and never revives on return', async () => {
    const workspaceTabs = openFilesTab(createWorkspaceTabsState('chat-tab-1'), {
      id: 'root-files-tab',
      path: null,
    })
    appHarness.controller = makeController(workspaceTabs)
    const deferredTarget = deferred<unknown>()
    const { deleteResource, gfs } = installClerum(
      [targetA],
      new Map([[targetA.gfsUri, deferredTarget]])
    )
    renderApp()

    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /target-a\.txt/ })
    await chooseDeleteAction('target-a.txt')

    const targetBreadcrumb = await screen.findByRole('button', { name: 'Shared with me' })
    expect((targetBreadcrumb as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByText('Delete target-a.txt?')).toBeNull()
    await waitFor(() => expect(gfs.resolve).toHaveBeenCalledWith(targetA.gfsUri))
    expect(deleteResource).not.toHaveBeenCalled()
    const tabs = getWorkspaceTabButtons('Files')
    expect(tabs).toHaveLength(2)

    fireEvent.click(tabs[0]!)
    await waitFor(() => expect(tabs[0]?.getAttribute('aria-pressed')).toBe('true'))
    await act(async () => {
      deferredTarget.resolve(targetA)
      await deferredTarget.promise
    })
    const targetTab = getWorkspaceTabButtons('Files')[1]
    expect(targetTab).toBeDefined()
    fireEvent.click(targetTab!)
    await waitFor(() =>
      expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)).toMatchObject({
        kind: 'files',
        files: { path: null },
      })
    )
    expect(gfs.resolve.mock.calls.filter(([uri]) => uri === targetA.gfsUri)).toHaveLength(1)
    expect(screen.queryByRole('heading', { name: 'Preview' })).toBeNull()
    expect(screen.queryByText('Delete target-a.txt?')).toBeNull()
    expect(deleteResource).not.toHaveBeenCalled()
  })

  it.each([
    { actionName: 'Download', clipboardCount: 0, linkCopyCount: 0, expectedDownloads: [1, 1, 1] },
    { actionName: 'Copy link', clipboardCount: 0, linkCopyCount: 1, expectedDownloads: [0, 0, 0] },
    {
      actionName: 'Copy file ID',
      clipboardCount: 1,
      linkCopyCount: 0,
      expectedDownloads: [0, 0, 0],
    },
  ])(
    'reproduces R2-H1 $actionName download counts with App and real navigation controller',
    async ({ actionName, clipboardCount, linkCopyCount, expectedDownloads }) => {
      const archive = await resolveResource(
        resolvedFile('abababababababababababababababab', 'archive.bin')
      )
      const { gfs } = installClerum([archive])
      const download = vi.fn(async () => ({ bytes: new Uint8Array([1, 2, 3]).buffer }))
      Object.assign(gfs, { download })
      const clipboardWrite = vi.fn(async (_value: string) => {})
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: clipboardWrite },
      })
      const savedFiles: string[] = []
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        value: vi.fn(() => 'blob:r2-h1-repro'),
      })
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
        this: HTMLAnchorElement
      ) {
        savedFiles.push(this.download)
      })
      appHarness.useRealNavigationController = true
      renderApp()

      fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
      await findResourceTreeRow(archive.name)
      await chooseRowAction(archive.name, actionName)
      await waitFor(() => expect(download).toHaveBeenCalledTimes(expectedDownloads[0]!))
      await waitFor(() => expect(savedFiles).toHaveLength(expectedDownloads[0]!))
      await waitFor(() => expect(clipboardWrite).toHaveBeenCalledTimes(clipboardCount))
      await waitFor(() => expect(gfs.copyDeepLink).toHaveBeenCalledTimes(linkCopyCount))

      const filesOwnerId = activeWorkspaceTab(appHarness.controller.workspaceTabs)?.id
      expect(filesOwnerId).toBeTruthy()
      expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)?.kind).toBe('files')
      const counts = [download.mock.calls.length]

      for (const expectedCount of expectedDownloads.slice(1)) {
        act(() => appHarness.controller.selectWorkspaceTabById('chat-tab-1'))
        await waitFor(() =>
          expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)?.kind).toBe('chat')
        )
        act(() => appHarness.controller.selectWorkspaceTabById(filesOwnerId!))
        await waitFor(() => expect(download).toHaveBeenCalledTimes(expectedCount))
        await waitFor(() => expect(savedFiles).toHaveLength(expectedCount))
        counts.push(download.mock.calls.length)
      }

      expect(counts).toEqual(expectedDownloads)
      expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)?.files?.path).toBeNull()
      expect(clipboardWrite).toHaveBeenCalledTimes(clipboardCount)
      expect(gfs.copyDeepLink).toHaveBeenCalledTimes(linkCopyCount)
      expect(screen.queryByRole('heading', { name: 'Preview' })).toBeNull()
    }
  )

  it('models generated Files returns against App and the production navigation controller', async () => {
    type Model = { active: 'files' | 'chat'; effects: number; path: string | null }
    type Real = {
      scheduler: Scheduler
      ownerTabId: string
      targetUri: string
      initialResolveCount: number
      returnToFiles: () => Promise<void>
    }
    class ReturnToFiles implements AsyncCommand<Model, Real> {
      check(model: Model) {
        return model.active === 'files'
      }

      async run(model: Model, real: Real) {
        await real.returnToFiles()
        model.active = 'files'
        expect(model.effects).toBe(1)
        expect(model.path).toBeNull()
        expect(
          appHarness.controller.workspaceTabs.tabs.find(tab => tab.id === real.ownerTabId)
        ).toMatchObject({ kind: 'files', files: { path: model.path } })
      }

      toString() {
        return 'leave and return to the consumed Files tab'
      }
    }

    const command = new ReturnToFiles()
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.commands([fc.constant(command)], { maxCommands: 3 }),
        async (scheduler, commands) => {
          const archive = await resolveResource(
            resolvedFile('abababababababababababababababab', 'archive.bin')
          )
          const { gfs } = installClerum([archive])
          const originalResolve = gfs.resolve
          Object.assign(gfs, {
            resolve: vi.fn((uri: string) =>
              scheduler.schedule(originalResolve(uri), 'action-owned Files resolution')
            ),
          })
          const download = vi.fn(async () => ({ bytes: new Uint8Array([1]).buffer }))
          Object.assign(gfs, { download })
          const savedFiles: string[] = []
          vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
            this: HTMLAnchorElement
          ) {
            savedFiles.push(this.download)
          })
          appHarness.useRealNavigationController = true
          renderApp()
          fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
          await findResourceTreeRow(archive.name)
          await chooseRowAction(archive.name, 'Download')
          await scheduler.waitAll()
          await waitFor(() => expect(download).toHaveBeenCalledTimes(1))
          await waitFor(() => expect(savedFiles).toHaveLength(1))

          const activeTab = activeWorkspaceTab(appHarness.controller.workspaceTabs)
          expect(activeTab?.kind).toBe('files')
          const ownerTabId = activeTab!.id
          const initialResolveCount = gfs.resolve.mock.calls.filter(
            ([uri]) => uri === archive.gfsUri
          ).length
          const model: Model = { active: 'files', effects: 1, path: null }
          const real: Real = {
            scheduler,
            ownerTabId,
            targetUri: archive.gfsUri,
            initialResolveCount,
            returnToFiles: async () => {
              act(() => appHarness.controller.selectWorkspaceTabById('chat-tab-1'))
              await waitFor(() =>
                expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)?.kind).toBe('chat')
              )
              act(() => appHarness.controller.selectWorkspaceTabById(ownerTabId))
              await waitFor(() =>
                expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)?.kind).toBe('files')
              )
              expect(gfs.resolve.mock.calls.filter(([uri]) => uri === archive.gfsUri)).toHaveLength(
                initialResolveCount
              )
              expect(download).toHaveBeenCalledTimes(1)
              expect(screen.queryByRole('heading', { name: 'Preview' })).toBeNull()
            },
          }
          try {
            await fc.asyncModelRun(() => ({ model, real }), [...commands])
            expect(model.effects).toBe(1)
            expect(download).toHaveBeenCalledTimes(1)
            expect(savedFiles).toHaveLength(1)
          } finally {
            cleanup()
            vi.restoreAllMocks()
            mockSidebarBounds()
          }
        }
      ),
      { numRuns: 3, endOnFailure: true }
    )
  })

  it('generates resolve, cancellation, supersession and return orderings with a reference reducer', async () => {
    type Model = {
      active: 'chat' | 'old-files' | 'new-files'
      oldStatus: 'pending' | 'resolved' | 'cancelled' | 'superseded'
      oldRequestId: number
      oldOwnerId: string
      oldDownloads: number
      oldPath: string | null
      oldLocationReported: boolean
      consumedSeed: { requestId: number; path: string } | null
      newCopies: number
      newPath: string | null
      session: number
      intent: number
    }
    type Event =
      | { kind: 'resolve-old' }
      | { kind: 'report-old-location' }
      | { kind: 'cancel-old' }
      | { kind: 'supersede-old' }
      | { kind: 'return-old' }
    const reduceModel = (model: Model, event: Event): Model => {
      switch (event.kind) {
        case 'resolve-old':
          return {
            ...model,
            oldStatus: 'resolved',
            oldDownloads: 1,
            oldPath: null,
            consumedSeed: { requestId: model.oldRequestId, path: realOldUri },
          }
        case 'report-old-location':
          return { ...model, oldLocationReported: true, oldPath: realOldUri }
        case 'cancel-old':
          return {
            ...model,
            active: 'chat',
            oldStatus: 'cancelled',
            oldPath: null,
            consumedSeed: { requestId: model.oldRequestId, path: realOldUri },
            intent: model.intent + 1,
          }
        case 'supersede-old':
          return {
            ...model,
            active: 'new-files',
            oldStatus: 'superseded',
            oldPath: null,
            consumedSeed: { requestId: model.oldRequestId, path: realOldUri },
            newCopies: 1,
            newPath: null,
            intent: model.intent + 1,
          }
        case 'return-old':
          return { ...model, active: 'old-files' }
      }
    }
    const realOldUri = 'gfs://main/abababababababababababababababab'
    type Real = {
      scheduler: Scheduler
      oldOwnerId: string
      oldUri: string
      newUri: string
      resolveOld: (expectDownload: boolean) => Promise<void>
      reportOldLocation: () => Promise<void>
      cancelOld: () => Promise<void>
      supersedeOld: () => Promise<void>
      returnOld: () => Promise<void>
      download: ReturnType<typeof vi.fn>
      savedFiles: string[]
      oldResolveCount: () => number
      newResolveCount: () => number
    }
    class ResolveOld implements AsyncCommand<Model, Real> {
      check(model: Model) {
        return model.oldStatus === 'pending' && model.oldLocationReported
      }
      async run(model: Model, real: Real) {
        await real.resolveOld(true)
        Object.assign(model, reduceModel(model, { kind: 'resolve-old' }))
        expect(real.download).toHaveBeenCalledTimes(model.oldDownloads)
        expect(real.savedFiles).toHaveLength(model.oldDownloads)
        expect(model.oldPath).toBeNull()
        expect(
          appHarness.controller.workspaceTabs.tabs.find(tab => tab.id === real.oldOwnerId)
        ).toMatchObject({ kind: 'files', files: { path: null } })
      }
      toString() {
        return 'resolve and acknowledge the pending old file action'
      }
    }
    class ReportOldLocation implements AsyncCommand<Model, Real> {
      check(model: Model) {
        return model.oldStatus === 'pending' && !model.oldLocationReported
      }
      async run(model: Model, real: Real) {
        await real.reportOldLocation()
        Object.assign(model, reduceModel(model, { kind: 'report-old-location' }))
        await waitFor(() =>
          expect(
            appHarness.controller.workspaceTabs.tabs.find(tab => tab.id === real.oldOwnerId)
          ).toMatchObject({ kind: 'files', files: { path: real.oldUri } })
        )
      }
      toString() {
        return 'report the action-owned URI while its action is still pending'
      }
    }
    class CancelOld implements AsyncCommand<Model, Real> {
      check(model: Model) {
        return model.oldStatus === 'pending'
      }
      async run(model: Model, real: Real) {
        await real.cancelOld()
        Object.assign(model, reduceModel(model, { kind: 'cancel-old' }))
        expect(model.oldPath).toBeNull()
      }
      toString() {
        return 'switch to Chat and cancel the pending old action'
      }
    }
    class SupersedeOld implements AsyncCommand<Model, Real> {
      check(model: Model) {
        return model.oldStatus === 'pending'
      }
      async run(model: Model, real: Real) {
        await real.supersedeOld()
        Object.assign(model, reduceModel(model, { kind: 'supersede-old' }))
        expect(model.oldPath).toBeNull()
        expect(model.newCopies).toBe(1)
        expect(model.newPath).toBeNull()
      }
      toString() {
        return 'accept a new-URI action into a distinct Files owner'
      }
    }
    class SessionChange implements AsyncCommand<Model, Real> {
      check(model: Model) {
        return model.oldStatus === 'pending'
      }
      async run(model: Model, real: Real) {
        act(() => {
          appHarness.controller.sessionGeneration = 2
          appHarness.forceRender()
        })
        await real.cancelOld()
        Object.assign(model, {
          active: 'chat',
          oldStatus: 'cancelled',
          oldPath: null,
          consumedSeed: { requestId: model.oldRequestId, path: real.oldUri },
          session: model.session + 1,
          intent: model.intent + 1,
        })
        expect(model.session).toBe(2)
        expect(model.oldPath).toBeNull()
      }
      toString() {
        return 'change session while the Files action is resolving'
      }
    }
    class SettleStaleOld implements AsyncCommand<Model, Real> {
      check(model: Model) {
        return model.oldStatus === 'cancelled' || model.oldStatus === 'superseded'
      }
      async run(model: Model, real: Real) {
        await real.resolveOld(false)
        expect(real.download).toHaveBeenCalledTimes(model.oldDownloads)
        expect(real.savedFiles).toHaveLength(model.oldDownloads)
        expect(real.oldResolveCount()).toBe(1)
      }
      toString() {
        return 'settle the stale old resolver after cancellation or replacement'
      }
    }
    class ReturnOld implements AsyncCommand<Model, Real> {
      check(model: Model) {
        return model.oldStatus !== 'pending'
      }
      async run(model: Model, real: Real) {
        await real.returnOld()
        Object.assign(model, reduceModel(model, { kind: 'return-old' }))
        expect(model.active).toBe('old-files')
        expect(model.oldPath).toBeNull()
        expect(real.oldResolveCount()).toBe(1)
        expect(real.download).toHaveBeenCalledTimes(model.oldDownloads)
        expect(real.newResolveCount()).toBe(model.newCopies)
      }
      toString() {
        return 'return to the old Files owner without replay'
      }
    }

    const commands = [
      new ResolveOld(),
      new ReportOldLocation(),
      new CancelOld(),
      new SupersedeOld(),
      new SessionChange(),
      new SettleStaleOld(),
      new ReturnOld(),
    ]
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.commands(
          commands.map(command => fc.constant(command)),
          { maxCommands: 4 }
        ),
        async (scheduler, generatedCommands) => {
          const generated = [...generatedCommands]
          const names = generated.map(command => command.toString())
          const reportIndex = names.findIndex(name => name.includes('action-owned URI'))
          const resolveIndex = names.findIndex(name => name.includes('resolve and acknowledge'))
          const otherTerminalIndices = names
            .map((name, index) => ({ name, index }))
            .filter(({ name }) =>
              /cancel the pending old action|distinct Files owner|change session/.test(name)
            )
            .map(({ index }) => index)
          fc.pre(
            reportIndex >= 0 &&
              resolveIndex > reportIndex &&
              otherTerminalIndices.every(index => index > resolveIndex)
          )
          const oldFile = await resolveResource(
            resolvedFile('abababababababababababababababab', 'archive.bin')
          )
          const newFile = await resolveResource(
            resolvedFile('cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd', 'second.bin')
          )
          const { gfs, deleteResource } = installClerum([oldFile, newFile])
          const originalResolve = gfs.resolve
          let oldResolveCount = 0
          Object.assign(gfs, {
            resolve: vi.fn((uri: string) => {
              if (uri === oldFile.gfsUri) {
                oldResolveCount += 1
                return scheduler.schedule(
                  new Promise(resolve => {
                    setTimeout(() => {
                      originalResolve(uri).then(resolve)
                    }, 0)
                  }),
                  'old file resolution'
                )
              }
              return originalResolve(uri)
            }),
          })
          const download = vi.fn(async () => ({ bytes: new Uint8Array([1]).buffer }))
          Object.assign(gfs, { download })
          const savedFiles: string[] = []
          vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
            this: HTMLAnchorElement
          ) {
            savedFiles.push(this.download)
          })
          appHarness.useRealNavigationController = true
          renderApp()
          fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
          await findResourceTreeRow(oldFile.name)
          await findResourceTreeRow(newFile.name)
          await chooseRowAction(oldFile.name, 'Download')
          await waitFor(() => expect(oldResolveCount).toBe(1))
          const oldOwner = activeWorkspaceTab(appHarness.controller.workspaceTabs)
          expect(oldOwner?.kind).toBe('files')
          const initialModel: Model = {
            active: 'old-files',
            oldStatus: 'pending',
            oldRequestId: (appHarness.filesPageLatestPendingAction as { id: number }).id,
            oldOwnerId: oldOwner!.id,
            oldDownloads: 0,
            oldPath: oldFile.gfsUri,
            oldLocationReported: false,
            consumedSeed: null,
            newCopies: 0,
            newPath: null,
            session: 1,
            intent: 1,
          }
          const real: Real = {
            scheduler,
            oldOwnerId: oldOwner!.id,
            oldUri: oldFile.gfsUri,
            newUri: newFile.gfsUri,
            reportOldLocation: async () => {
              act(() => appHarness.filesPageReportLocation?.(oldFile.gfsUri, oldFile.name))
            },
            resolveOld: async expectDownload => {
              await act(async () => scheduler.waitAll())
              await waitFor(() => expect(oldResolveCount).toBeGreaterThanOrEqual(1))
              await Promise.resolve()
              await waitFor(() => expect(download).toHaveBeenCalledTimes(expectDownload ? 1 : 0))
              await waitFor(() => expect(savedFiles).toHaveLength(expectDownload ? 1 : 0))
            },
            cancelOld: async () => {
              act(() => appHarness.controller.selectWorkspaceTabById('chat-tab-1'))
              await waitFor(() =>
                expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)?.kind).toBe('chat')
              )
            },
            supersedeOld: async () => {
              await chooseRowAction(newFile.name, 'Copy link')
              await waitFor(() => expect(gfs.copyDeepLink).toHaveBeenCalledTimes(1))
            },
            returnOld: async () => {
              if (activeWorkspaceTab(appHarness.controller.workspaceTabs)?.id !== 'chat-tab-1') {
                act(() => appHarness.controller.selectWorkspaceTabById('chat-tab-1'))
                await waitFor(() =>
                  expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)?.kind).toBe('chat')
                )
              }
              act(() => appHarness.controller.selectWorkspaceTabById(oldOwner!.id))
              await waitFor(() =>
                expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)?.id).toBe(
                  oldOwner!.id
                )
              )
            },
            download,
            savedFiles,
            oldResolveCount: () => oldResolveCount,
            newResolveCount: () =>
              gfs.resolve.mock.calls.filter(([uri]) => uri === newFile.gfsUri).length,
          }
          let model = initialModel
          try {
            if (!generated.length)
              generated.push(new CancelOld(), new SettleStaleOld(), new ReturnOld())
            await fc.asyncModelRun(() => ({ model, real }), generated)
            if (model.oldStatus === 'pending') {
              await new SessionChange().run(model, real)
            }
            if (model.oldStatus === 'cancelled' || model.oldStatus === 'superseded') {
              await real.resolveOld(false)
              await real.returnOld()
              Object.assign(model, reduceModel(model, { kind: 'return-old' }))
            }
            await scheduler.waitAll()
            await waitFor(() => expect(appHarness.filesPageLatestPendingAction).toBeNull())
            expect(download).toHaveBeenCalledTimes(model.oldDownloads)
            expect(savedFiles).toHaveLength(model.oldDownloads)
            expect(oldResolveCount).toBe(1)
            expect(deleteResource).not.toHaveBeenCalled()
            expect(screen.queryByRole('heading', { name: 'Preview' })).toBeNull()
            if (model.consumedSeed) {
              expect(model.consumedSeed).toEqual({
                requestId: model.oldRequestId,
                path: oldFile.gfsUri,
              })
              expect(model.oldOwnerId).toBe(oldOwner!.id)
            }
          } finally {
            cleanup()
            vi.restoreAllMocks()
            mockSidebarBounds()
          }
        }
      ),
      { numRuns: 5, maxSkipsPerRun: 1000, endOnFailure: true, seed: 281110 }
    )
  })

  it('runs explicit-link and close-owner commands through real Files navigation', async () => {
    type Model = {
      activeTabId: string
      requestId: number
      consumedSeed: { requestId: number; path: string } | null
      session: number
      intent: number
      path: string | null
      downloads: number
      explicit: boolean
      closed: boolean
    }
    type Real = {
      scheduler: Scheduler
      ownerTabId: string
      archiveUri: string
      download: ReturnType<typeof vi.fn>
    }
    class ExplicitDeepLink implements AsyncCommand<Model, Real> {
      check(model: Model) {
        return model.consumedSeed !== null && !model.explicit && !model.closed
      }
      async run(model: Model, real: Real) {
        act(() => appHarness.controller.openFilesSectionWithReceipt(real.archiveUri))
        await real.scheduler.waitAll()
        await waitFor(() => expect(real.download).toHaveBeenCalledTimes(1))
        expect(screen.queryByRole('heading', { name: 'Preview' })).toBeNull()
        model.explicit = true
        model.consumedSeed = null
        model.path = real.archiveUri
        model.downloads = 1
        const explicitOwner = activeWorkspaceTab(appHarness.controller.workspaceTabs)
        expect(explicitOwner?.id).not.toBe(real.ownerTabId)
        model.activeTabId = explicitOwner!.id
        expect(
          appHarness.controller.workspaceTabs.tabs.find(tab => tab.id === model.activeTabId)
        ).toMatchObject({ kind: 'files', files: { path: real.archiveUri } })
      }
      toString() {
        return 'Open an explicit non-action file deep link'
      }
    }
    class CloseOwner implements AsyncCommand<Model, Real> {
      check(model: Model) {
        return model.explicit && !model.closed
      }
      async run(model: Model, real: Real) {
        act(() =>
          appHarness.controller.setWorkspaceTabs(state => closeWorkspaceTab(state, real.ownerTabId))
        )
        await waitFor(() =>
          expect(
            appHarness.controller.workspaceTabs.tabs.some(tab => tab.id === real.ownerTabId)
          ).toBe(false)
        )
        model.closed = true
        model.path = real.archiveUri
        expect(model.requestId).toBeGreaterThan(0)
        expect(model.session).toBe(1)
        expect(model.intent).toBeGreaterThan(0)
      }
      toString() {
        return 'Close the Files owner after an explicit request settles'
      }
    }

    const scheduler = fc.sample(fc.scheduler(), { numRuns: 1 })[0]!
    const archive = await resolveResource(
      resolvedFile('abababababababababababababababab', 'archive.bin')
    )
    const { gfs } = installClerum([archive])
    const originalDownload = gfs.download
    const download = vi.fn((uri: string) =>
      scheduler.schedule(originalDownload(uri), 'explicit file download operation')
    )
    Object.assign(gfs, { download })
    const clipboardWrite = vi.fn(async (_value: string) => {})
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: clipboardWrite },
    })
    appHarness.useRealNavigationController = true
    renderApp()
    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await findResourceTreeRow(archive.name)
    await chooseRowAction(archive.name, 'Copy file ID')
    await scheduler.waitAll()
    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledTimes(1))
    const owner = activeWorkspaceTab(appHarness.controller.workspaceTabs)
    expect(owner?.kind).toBe('files')
    const ownerTabId = owner!.id
    const requestId = (appHarness.filesPagePendingActions.at(-1) as { id: number }).id
    const model: Model = {
      activeTabId: ownerTabId,
      requestId,
      consumedSeed: { requestId, path: archive.gfsUri },
      session: 1,
      intent: 1,
      path: null,
      downloads: 0,
      explicit: false,
      closed: false,
    }
    const real: Real = {
      scheduler,
      ownerTabId,
      archiveUri: archive.gfsUri,
      download,
    }
    const explicit = new ExplicitDeepLink()
    const close = new CloseOwner()
    await fc.asyncModelRun(() => ({ model, real }), [explicit, close])
    await scheduler.waitAll()
    expect(model).toMatchObject({
      consumedSeed: null,
      downloads: 1,
      explicit: true,
      closed: true,
    })
    expect(download).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('heading', { name: 'Preview' })).toBeNull()
  })

  it('re-arms a same-owner same-URI successor under its own action request', async () => {
    const firstResolve = deferred<unknown>()
    const archive = await resolveResource(
      resolvedFile('abababababababababababababababab', 'archive.bin')
    )
    const { gfs, deleteResource } = installClerum([archive])
    const originalResolve = gfs.resolve
    let targetCallCount = 0
    Object.assign(gfs, {
      resolve: vi.fn((uri: string) => {
        if (uri === archive.gfsUri && targetCallCount++ === 0) return firstResolve.promise
        return originalResolve(uri)
      }),
    })
    appHarness.useRealNavigationController = true
    renderApp()

    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await findResourceTreeRow(archive.name)
    await chooseDeleteAction(archive.name)
    await waitFor(() => expect(gfs.resolve).toHaveBeenCalledWith(archive.gfsUri))
    await chooseRowAction(archive.name, 'Copy link')
    await waitFor(() => expect(gfs.copyDeepLink).toHaveBeenCalledTimes(1))
    expect(targetCallCount).toBe(2)
    expect(deleteResource).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)).toMatchObject({
        kind: 'files',
        files: { path: null },
      })
    )
    await act(async () => {
      firstResolve.resolve(archive)
      await firstResolve.promise
    })
    expect(deleteResource).not.toHaveBeenCalled()
    expect(gfs.copyDeepLink).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('heading', { name: 'Preview' })).toBeNull()
  })

  it('supersedes a delayed action into another Files owner without replaying the old owner', async () => {
    const firstResolve = deferred<unknown>()
    const archive = await resolveResource(
      resolvedFile('abababababababababababababababab', 'archive.bin')
    )
    const second = await resolveResource(
      resolvedFile('cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd', 'second.bin')
    )
    const { gfs, deleteResource } = installClerum([archive, second])
    const originalResolve = gfs.resolve
    let archiveCalls = 0
    Object.assign(gfs, {
      resolve: vi.fn((uri: string) => {
        if (uri === archive.gfsUri && archiveCalls++ === 0) return firstResolve.promise
        return originalResolve(uri)
      }),
    })
    appHarness.useRealNavigationController = true
    renderApp()

    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await findResourceTreeRow(archive.name)
    await findResourceTreeRow(second.name)
    await chooseDeleteAction(archive.name)
    await waitFor(() => expect(gfs.resolve).toHaveBeenCalledWith(archive.gfsUri))
    const oldOwner = activeWorkspaceTab(appHarness.controller.workspaceTabs)
    expect(oldOwner?.kind).toBe('files')
    const oldOwnerId = oldOwner!.id

    await chooseRowAction(second.name, 'Copy link')
    await waitFor(() => expect(gfs.copyDeepLink).toHaveBeenCalledTimes(1))
    const newOwner = activeWorkspaceTab(appHarness.controller.workspaceTabs)
    expect(newOwner?.kind).toBe('files')
    expect(newOwner!.id).not.toBe(oldOwnerId)
    expect(
      appHarness.controller.workspaceTabs.tabs.find(tab => tab.id === oldOwnerId)
    ).toMatchObject({ kind: 'files', files: { path: null } })
    const archiveResolveCount = archiveCalls
    const secondResolveCount = gfs.resolve.mock.calls.filter(
      ([uri]) => uri === second.gfsUri
    ).length

    await act(async () => {
      firstResolve.resolve(archive)
      await firstResolve.promise
    })
    expect(deleteResource).not.toHaveBeenCalled()
    act(() => appHarness.controller.selectWorkspaceTabById(oldOwnerId))
    await waitFor(() =>
      expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)?.id).toBe(oldOwnerId)
    )
    expect(archiveCalls).toBe(archiveResolveCount)
    expect(gfs.resolve.mock.calls.filter(([uri]) => uri === second.gfsUri)).toHaveLength(
      secondResolveCount
    )
    expect(gfs.copyDeepLink).toHaveBeenCalledTimes(1)
    expect(
      appHarness.controller.workspaceTabs.tabs.find(tab => tab.id === newOwner!.id)
    ).toMatchObject({ kind: 'files', files: { path: null } })
    expect(screen.queryByRole('heading', { name: 'Preview' })).toBeNull()
  })

  it.each(['tab-selection', 'session-change'] as const)(
    'cancels a delayed action on real %s and keeps its file path consumed',
    async cancellation => {
      const delayedTarget = deferred<unknown>()
      const archive = await resolveResource(
        resolvedFile('abababababababababababababababab', 'archive.bin')
      )
      const { gfs, deleteResource } = installClerum([archive])
      const originalResolve = gfs.resolve
      let targetCalls = 0
      Object.assign(gfs, {
        resolve: vi.fn((uri: string) => {
          if (uri === archive.gfsUri) {
            targetCalls += 1
            return delayedTarget.promise
          }
          return originalResolve(uri)
        }),
      })
      appHarness.useRealNavigationController = true
      renderApp()
      fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
      await findResourceTreeRow(archive.name)
      await chooseDeleteAction(archive.name)
      await waitFor(() => expect(targetCalls).toBe(1))
      const owner = activeWorkspaceTab(appHarness.controller.workspaceTabs)
      expect(owner?.kind).toBe('files')

      if (cancellation === 'session-change') {
        act(() => {
          appHarness.controller.sessionGeneration = 2
          appHarness.forceRender()
        })
        await waitFor(() => expect(appHarness.filesPageLatestPendingAction).toBeNull())
      }
      act(() => appHarness.controller.selectWorkspaceTabById('chat-tab-1'))
      await waitFor(() =>
        expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)?.kind).toBe('chat')
      )
      expect(
        appHarness.controller.workspaceTabs.tabs.find(tab => tab.id === owner!.id)
      ).toMatchObject({ kind: 'files', files: { path: null } })
      await act(async () => {
        delayedTarget.resolve(archive)
        await delayedTarget.promise
      })
      act(() => appHarness.controller.selectWorkspaceTabById(owner!.id))
      await waitFor(() =>
        expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)?.id).toBe(owner!.id)
      )
      expect(targetCalls).toBe(1)
      expect(deleteResource).not.toHaveBeenCalled()
      expect(screen.queryByRole('heading', { name: 'Preview' })).toBeNull()
    }
  )

  it('closes a pending action owner without stealing the explicit Files owner', async () => {
    const locationScheduler = fc.sample(fc.scheduler(), { numRuns: 1 })[0]!
    type Model = {
      oldOwnerId: string
      explicitOwnerId: string | null
      requestId: number
      active: 'old-files' | 'chat' | 'explicit-files'
      consumedSeed: { requestId: number; path: string } | null
      oldDownloads: number
      explicitDownloads: number
      locationReports: number
      settled: boolean
      path: string | null
    }
    type Real = {
      scheduler: Scheduler
      oldOwnerId: string
      oldUri: string
      explicitUri: string
      resolveOld: () => Promise<void>
      closeOldOwner: () => Promise<void>
      openExplicitOwner: () => Promise<string>
      reportLocation: () => Promise<void>
      explicitOwnerId: string | null
      oldResolveCount: () => number
      download: ReturnType<typeof vi.fn>
    }
    const reduce = (model: Model, event: 'close' | 'explicit' | 'settle-old'): Model => {
      if (event === 'close') return { ...model, active: 'chat', consumedSeed: null, path: null }
      if (event === 'explicit')
        return {
          ...model,
          active: 'explicit-files',
          explicitOwnerId: 'new-explicit-owner',
          explicitDownloads: 1,
          path: 'explicit-uri',
        }
      return { ...model, oldDownloads: 0 }
    }
    class CloseOldOwner implements AsyncCommand<Model, Real> {
      check(model: Model) {
        return model.active === 'old-files'
      }
      async run(model: Model, real: Real) {
        await real.closeOldOwner()
        Object.assign(model, reduce(model, 'close'))
        expect(model.consumedSeed).toBeNull()
        expect(
          appHarness.controller.workspaceTabs.tabs.some(tab => tab.id === real.oldOwnerId)
        ).toBe(false)
      }
      toString() {
        return 'CloseOwner: close the pending Files owner'
      }
    }
    class ExplicitDeepLink implements AsyncCommand<Model, Real> {
      check(model: Model) {
        return model.active === 'chat' && model.consumedSeed === null
      }
      async run(model: Model, real: Real) {
        const newOwnerId = await real.openExplicitOwner()
        Object.assign(model, reduce(model, 'explicit'))
        model.explicitOwnerId = newOwnerId
        expect(
          appHarness.controller.workspaceTabs.tabs.find(tab => tab.id === newOwnerId)
        ).toMatchObject({ kind: 'files', files: { path: real.explicitUri } })
      }
      toString() {
        return 'ExplicitDeepLink: open a new Files owner'
      }
    }
    class ReportLocation implements AsyncCommand<Model, Real> {
      check(model: Model) {
        return (
          model.active === 'explicit-files' &&
          model.explicitOwnerId !== null &&
          model.locationReports === 0
        )
      }
      async run(_model: Model, real: Real) {
        await real.reportLocation()
        _model.locationReports += 1
        expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)).toMatchObject({
          id: real.explicitOwnerId,
          kind: 'files',
          files: { path: real.explicitUri },
        })
      }
      toString() {
        return 'ReportLocation: report the explicit Files location'
      }
    }
    class SettleStaleOld implements AsyncCommand<Model, Real> {
      check(model: Model) {
        return model.active === 'explicit-files' && model.explicitOwnerId !== null && !model.settled
      }
      async run(model: Model, real: Real) {
        await real.resolveOld()
        Object.assign(model, reduce(model, 'settle-old'))
        model.settled = true
        expect(real.oldResolveCount()).toBe(1)
        expect(real.download).toHaveBeenCalledTimes(model.explicitDownloads)
        expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)).toMatchObject({
          id: model.explicitOwnerId,
          kind: 'files',
          files: { path: real.explicitUri },
        })
        expect(
          appHarness.controller.workspaceTabs.tabs.some(tab => tab.id === real.oldOwnerId)
        ).toBe(false)
        expect(appHarness.filesPageLatestPendingAction).toBeNull()
      }
      toString() {
        return 'SettleStaleResolver: settle without changing the explicit owner'
      }
    }

    const scheduler = fc.sample(fc.scheduler(), { numRuns: 1 })[0]!
    const archive = await resolveResource(
      resolvedFile('abababababababababababababababab', 'archive.bin')
    )
    const second = await resolveResource(
      resolvedFile('cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd', 'second.bin')
    )
    const oldResolution = deferred<unknown>()
    const { gfs } = installClerum([archive, second])
    const originalResolve = gfs.resolve
    let oldResolveCount = 0
    Object.assign(gfs, {
      resolve: vi.fn((uri: string) => {
        if (uri === archive.gfsUri) {
          oldResolveCount += 1
          return scheduler.schedule(oldResolution.promise, 'pending old file resolver')
        }
        return originalResolve(uri)
      }),
    })
    const originalDownload = gfs.download
    const download = vi.fn((uri: string) => originalDownload(uri))
    Object.assign(gfs, { download })
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:r2-h1-pending-owner'),
    })
    appHarness.useRealNavigationController = true
    renderApp()
    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await findResourceTreeRow(archive.name)
    await findResourceTreeRow(second.name)
    await chooseRowAction(archive.name, 'Download')
    await waitFor(() => expect(oldResolveCount).toBe(1))
    const owner = activeWorkspaceTab(appHarness.controller.workspaceTabs)
    expect(owner?.kind).toBe('files')
    const ownerTabId = owner!.id
    const requestId = (appHarness.filesPagePendingActions.at(-1) as { id: number }).id
    const model: Model = {
      oldOwnerId: ownerTabId,
      explicitOwnerId: null,
      requestId,
      active: 'old-files',
      consumedSeed: { requestId, path: archive.gfsUri },
      oldDownloads: 0,
      explicitDownloads: 0,
      locationReports: 0,
      settled: false,
      path: archive.gfsUri,
    }
    const real: Real = {
      scheduler,
      oldOwnerId: ownerTabId,
      oldUri: archive.gfsUri,
      explicitUri: second.gfsUri,
      explicitOwnerId: null,
      resolveOld: async () => {
        await act(async () => {
          oldResolution.resolve(archive)
          await oldResolution.promise
          await scheduler.waitAll()
        })
      },
      closeOldOwner: async () => {
        act(() =>
          appHarness.controller.setWorkspaceTabs(state => closeWorkspaceTab(state, ownerTabId))
        )
        await waitFor(() =>
          expect(appHarness.controller.workspaceTabs.tabs.some(tab => tab.id === ownerTabId)).toBe(
            false
          )
        )
        await waitFor(() =>
          expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)?.kind).toBe('chat')
        )
      },
      openExplicitOwner: async () => {
        act(() => appHarness.controller.openFilesSectionWithReceipt(second.gfsUri))
        await waitFor(() =>
          expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)).toMatchObject({
            kind: 'files',
            files: { path: second.gfsUri },
          })
        )
        await waitFor(() => expect(download).toHaveBeenCalledTimes(1))
        const active = activeWorkspaceTab(appHarness.controller.workspaceTabs)
        real.explicitOwnerId = active!.id
        return active!.id
      },
      reportLocation: async () => {
        const scheduledReport = locationScheduler
          .schedule(Promise.resolve(), 'Files location report')
          .then(() => appHarness.filesPageReportLocation?.(second.gfsUri, second.name))
        await act(async () => locationScheduler.waitFor(scheduledReport))
      },
      oldResolveCount: () => oldResolveCount,
      download,
    }
    const close = new CloseOldOwner()
    const explicit = new ExplicitDeepLink()
    const report = new ReportLocation()
    const settle = new SettleStaleOld()
    const generated = fc
      .sample(
        fc.commands(
          [close, explicit, report, settle].map(command => fc.constant(command)),
          { maxCommands: 4, size: '+1' }
        ),
        { numRuns: 10000, seed: 281110 }
      )
      .map(sample => [...sample])
      .find(commands => {
        const names = commands.map(command => command.toString().split(':', 1)[0])
        return (
          names.length === 4 &&
          names[0] === 'CloseOwner' &&
          names[1] === 'ExplicitDeepLink' &&
          new Set(names.slice(2)).size === 2 &&
          names.slice(2).includes('ReportLocation') &&
          names.slice(2).includes('SettleStaleResolver')
        )
      })
    expect(generated).toBeDefined()
    await fc.asyncModelRun(() => ({ model, real }), generated!)
    expect(model).toMatchObject({
      active: 'explicit-files',
      consumedSeed: null,
      explicitDownloads: 1,
      locationReports: 1,
      settled: true,
      oldDownloads: 0,
      path: 'explicit-uri',
    })
    expect(download).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('heading', { name: 'Preview' })).toBeNull()
  })

  it('keeps a consumed file path at root after Rename reports the same URI', async () => {
    const scheduler = fc.sample(fc.scheduler(), { numRuns: 1 })[0]!
    const file = await resolveResource(
      resolvedFile('abababababababababababababababab', 'before.txt')
    )
    const renameResource = vi.fn(() =>
      scheduler.schedule(Promise.resolve({}), 'Rename operation before location acknowledgment')
    )
    const { gfs } = installClerum([file], new Map(), { affordanceBits: ['write'] })
    Object.assign(gfs, { renameResource })
    appHarness.useRealNavigationController = true
    renderApp()
    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await findResourceTreeRow(file.name)
    await chooseRowAction(file.name, 'Rename')
    const renameForms = await screen.findAllByRole('form', { name: 'Rename resource' })
    const renameForm = renameForms.at(-1)!
    fireEvent.change(within(renameForm).getByLabelText('New name'), {
      target: { value: 'after.txt' },
    })
    fireEvent.click(within(renameForm).getByRole('button', { name: 'Save name' }))
    await waitFor(() => expect(renameResource).toHaveBeenCalledTimes(1))
    await scheduler.waitAll()
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'after.txt' }).length).toBeGreaterThan(0)
    )
    await waitFor(() =>
      expect(appHarness.filesPageLastLocation).toMatchObject({
        gfsUri: file.gfsUri,
        name: 'before.txt',
      })
    )
    await waitFor(() =>
      expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)).toMatchObject({
        kind: 'files',
        files: { path: null },
      })
    )
    const resolveCount = gfs.resolve.mock.calls.filter(([uri]) => uri === file.gfsUri).length
    act(() => appHarness.controller.selectWorkspaceTabById('chat-tab-1'))
    await waitFor(() =>
      expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)?.kind).toBe('chat')
    )
    const filesTab = appHarness.controller.workspaceTabs.tabs.find(tab => tab.kind === 'files')
    expect(filesTab).toBeDefined()
    act(() => appHarness.controller.selectWorkspaceTabById(filesTab!.id))
    await waitFor(() =>
      expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)?.kind).toBe('files')
    )
    expect(gfs.resolve.mock.calls.filter(([uri]) => uri === file.gfsUri)).toHaveLength(resolveCount)
    expect(renameResource).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('heading', { name: 'Preview' })).toBeNull()
  })

  it('keeps in-page folder navigation from replaying its previous Files seed', async () => {
    const parent = await resolveResource(
      resolvedDirectory('abababababababababababababababab', 'Parent folder')
    )
    const child = await resolveResource(
      resolvedDirectory('cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd', 'Child folder', {
        parentResourceId: parent.resourceId,
      })
    )
    const childRow = childView(child.resourceId, child.name, 'directory', {
      gfsUri: child.gfsUri,
      parentResourceId: parent.resourceId,
      version: child.version,
    })
    const { gfs } = installClerum([parent, child], new Map(), {
      accessibleRows: [
        accessibleResource(parent.resourceId, parent.name, 'directory', {
          gfsUri: parent.gfsUri,
        }),
      ],
      childRowsByParent: new Map([[parent.resourceId, [childRow]]]),
    })
    const originalResolve = gfs.resolve
    Object.assign(gfs, {
      resolve: vi.fn((uri: string) => originalResolve(uri)),
    })
    appHarness.useRealNavigationController = true
    renderApp()
    act(() => appHarness.controller.openFilesSectionWithReceipt(null))
    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    const filesBrowser = screen.getByRole('region', { name: 'EvenDrive browser' })
    fireEvent.click(await within(filesBrowser).findByRole('button', { name: parent.name }))
    await waitFor(() =>
      expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)).toMatchObject({
        kind: 'files',
        files: { path: parent.gfsUri },
      })
    )
    await within(filesBrowser).findByRole('button', { name: child.name })
    const parentResolveCount = gfs.resolve.mock.calls.filter(
      ([uri]) => uri === parent.gfsUri
    ).length
    fireEvent.click(within(filesBrowser).getByRole('button', { name: child.name }))
    await waitFor(() =>
      expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)).toMatchObject({
        kind: 'files',
        files: { path: child.gfsUri },
      })
    )
    expect(gfs.resolve.mock.calls.filter(([uri]) => uri === parent.gfsUri)).toHaveLength(
      parentResolveCount
    )
  })

  it('does not preview a markdown file on return after a Files-owned Copy ID action', async () => {
    const markdown = await resolveResource(
      resolvedFile('acacacacacacacacacacacacacacacac', 'readme.md')
    )
    const { gfs } = installClerum([markdown])
    const clipboardWrite = vi.fn(async (_value: string) => {})
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: clipboardWrite },
    })
    appHarness.useRealNavigationController = true
    renderApp()
    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await findResourceTreeRow(markdown.name)
    await chooseRowAction(markdown.name, 'Copy file ID')
    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)).toMatchObject({
        kind: 'files',
        files: { path: null },
      })
    )
    const targetResolveCount = gfs.resolve.mock.calls.filter(
      ([uri]) => uri === markdown.gfsUri
    ).length
    const filesTab = activeWorkspaceTab(appHarness.controller.workspaceTabs)
    expect(filesTab?.kind).toBe('files')
    act(() => appHarness.controller.selectWorkspaceTabById('chat-tab-1'))
    await waitFor(() =>
      expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)?.kind).toBe('chat')
    )
    act(() => appHarness.controller.selectWorkspaceTabById(filesTab!.id))
    await waitFor(() =>
      expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)?.kind).toBe('files')
    )
    expect(gfs.resolve.mock.calls.filter(([uri]) => uri === markdown.gfsUri)).toHaveLength(
      targetResolveCount
    )
    expect(clipboardWrite).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('heading', { name: 'Preview' })).toBeNull()
  })

  it('preserves explicit markdown deep-link Preview through the production navigation hook', async () => {
    const markdown = await resolveResource(
      resolvedFile('efefefefefefefefefefefefefefefef', 'guide.md')
    )
    const { gfs } = installClerum([markdown])
    appHarness.useRealNavigationController = true
    renderApp()

    act(() => appHarness.controller.openFilesSectionWithReceipt(markdown.gfsUri))
    await waitFor(() =>
      expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)).toMatchObject({
        kind: 'preview',
        preview: { gfsUri: markdown.gfsUri },
      })
    )
    expect(
      getWorkspaceTabButtons(markdown.name).find(tab => tab.getAttribute('aria-pressed') === 'true')
    ).toBeTruthy()
    expect(gfs.download).not.toHaveBeenCalled()
    expect(gfs.downloadPreview).toHaveBeenCalledWith(markdown.gfsUri, expect.any(Number))
  })

  it('preserves explicit non-previewable deep-link download and tab-path behavior', async () => {
    const archive = await resolveResource(
      resolvedFile('abababababababababababababababab', 'archive.bin')
    )
    const { gfs } = installClerum([archive])
    const savedFiles: string[] = []
    const download = vi.fn(async () => ({ bytes: new Uint8Array([1]).buffer }))
    Object.assign(gfs, { download })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement
    ) {
      savedFiles.push(this.download)
    })
    appHarness.useRealNavigationController = true
    renderApp()

    act(() => appHarness.controller.openFilesSectionWithReceipt(archive.gfsUri))
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(savedFiles).toHaveLength(1))
    expect(
      within(screen.getByRole('navigation', { name: 'File location' })).getByText('Shared with me')
    ).toBeTruthy()
    await waitFor(() =>
      expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)).toMatchObject({
        kind: 'files',
        files: { path: archive.gfsUri },
      })
    )
    const filesTab = activeWorkspaceTab(appHarness.controller.workspaceTabs)
    expect(filesTab).toMatchObject({ kind: 'files', files: { path: archive.gfsUri } })

    act(() => appHarness.controller.selectWorkspaceTabById('chat-tab-1'))
    await waitFor(() =>
      expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)?.kind).toBe('chat')
    )
    act(() => appHarness.controller.selectWorkspaceTabById(filesTab!.id))
    await waitFor(() => expect(download).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(savedFiles).toHaveLength(2))
    expect(gfs.resolve.mock.calls.filter(([uri]) => uri === archive.gfsUri)).toHaveLength(2)
    expect(
      within(screen.getByRole('navigation', { name: 'File location' })).getByText('Shared with me')
    ).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Preview' })).toBeNull()
  })

  it('does not replay a completed action after reaching its target, leaving, and returning', async () => {
    const workspaceTabs = openFilesTab(createWorkspaceTabsState('chat-tab-1'), {
      id: 'root-files-tab',
      path: null,
    })
    appHarness.controller = makeController(workspaceTabs)
    const { gfs } = installClerum([targetA])
    renderApp()

    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /target-a\.txt/ })
    await chooseRowAction('target-a.txt', 'Copy link')
    await waitFor(() => expect(gfs.copyDeepLink).toHaveBeenCalledWith(targetA.gfsUri))
    await waitFor(() =>
      expect(appHarness.controller.pushToast).toHaveBeenCalledWith(
        'Shareable EvenDrive link copied',
        'success'
      )
    )
    await waitFor(() =>
      expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)).toMatchObject({
        kind: 'files',
        files: { path: null },
      })
    )

    const targetResolveCount = gfs.resolve.mock.calls.filter(
      ([uri]) => uri === targetA.gfsUri
    ).length
    fireEvent.click(getWorkspaceTabButtons('Files')[0]!)
    await waitFor(() => expect(screen.queryByText('Delete target-a.txt?')).toBeNull())
    fireEvent.click(getWorkspaceTabButtons('Files')[0]!)
    await waitFor(() =>
      expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)).toMatchObject({
        kind: 'files',
        files: { path: null },
      })
    )
    expect(gfs.resolve.mock.calls.filter(([uri]) => uri === targetA.gfsUri).length).toBe(
      targetResolveCount
    )
    expect(screen.queryByRole('heading', { name: 'Preview' })).toBeNull()
    expect(screen.queryByText('Delete target-a.txt?')).toBeNull()
    expect(gfs.copyDeepLink).toHaveBeenCalledTimes(1)
  })

  it('ignores an older unmount acknowledgement while a newer row action resolves', async () => {
    const oldTarget = deferred<unknown>()
    const { deleteResource, gfs } = installClerum(
      [targetA, targetB],
      new Map([[targetA.gfsUri, oldTarget]])
    )
    renderApp()

    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /target-a\.txt/ })
    await screen.findByRole('treeitem', { name: /target-b\.txt/ })
    await chooseDeleteAction('target-a.txt')
    await waitFor(() => expect(gfs.resolve).toHaveBeenCalledWith(targetA.gfsUri))
    expect(deleteResource).not.toHaveBeenCalled()
    await chooseDeleteAction('target-b.txt')
    await confirmDelete('target-b.txt')

    await waitFor(() => expect(deleteResource).toHaveBeenCalledTimes(1))
    expect(deleteResource.mock.calls[0]).toEqual([targetB.resourceId, 'main', targetB.version])
    await act(async () => {
      oldTarget.resolve(targetA)
      await oldTarget.promise
    })
    expect(screen.queryByText('Delete target-a.txt?')).toBeNull()
    expect(deleteResource).toHaveBeenCalledTimes(1)
  })

  it.each([false, true])(
    'matches the Files Move handler and exact parent context (readable: %s)',
    async readable => {
      const parent = await resolveResource(
        resolvedDirectory('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'Shared parent')
      )
      const target = await resolveResource(
        resolvedFile('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'unreadable-child.txt', {
          parentResourceId: parent.resourceId,
        })
      )
      const destination = await resolveResource(
        resolvedDirectory('dddddddddddddddddddddddddddddddd', 'Move destination')
      )
      const unreadableChild = childView(target.resourceId, target.name, 'file', {
        gfsUri: target.gfsUri,
        parentResourceId: parent.resourceId,
        version: target.version,
        readable,
      })
      const { gfs, moveResource } = installClerum([parent, target, destination], new Map(), {
        accessibleRows: [
          accessibleResource(parent.resourceId, parent.name, 'directory', {
            gfsUri: parent.gfsUri,
          }),
          accessibleResource(destination.resourceId, destination.name, 'directory', {
            gfsUri: destination.gfsUri,
          }),
        ],
        childRowsByParent: new Map([[parent.resourceId, [unreadableChild]]]),
      })
      appHarness.controller = makeController(
        openFilesTab(createWorkspaceTabsState('chat-tab-1'), {
          id: 'files-parent',
          path: parent.gfsUri,
        })
      )
      renderApp()

      fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
      const parentRow = await screen.findByRole('treeitem', { name: /Shared parent/ })
      fireEvent.click(within(parentRow).getByRole('button', { name: 'Expand Shared parent' }))
      await findResourceTreeRow('unreadable-child.txt')

      await chooseFilesAction(target.name, 'Move to')
      const filesDialog = await screen.findByRole('dialog', {
        name: 'Move file unreadable-child.txt',
      })
      const filesDialogText = filesDialog.textContent
      expect(
        filesDialog.querySelector('.da-gfs-move-dialog__current-location')?.textContent
      ).toContain('Shared parent')
      fireEvent.click(await within(filesDialog).findByRole('button', { name: destination.name }))
      fireEvent.click(
        within(filesDialog).getByRole('button', { name: `Move here (${destination.name})` })
      )
      await waitFor(() =>
        expect(moveResource).toHaveBeenCalledWith(
          target.resourceId,
          destination.resourceId,
          'main',
          target.version,
          undefined,
          1
        )
      )
      const filesCalls = moveResource.mock.calls.map(call => [...call])
      moveResource.mockClear()

      const parentResolveCountBeforeSidebar = gfs.resolve.mock.calls.filter(
        ([uri]) => uri === parent.gfsUri
      ).length
      await chooseRowAction(target.name, 'Move to')
      expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)).toMatchObject({
        kind: 'files',
        files: { path: parent.gfsUri },
      })
      await waitFor(() => expect(appHarness.filesPageLastLocation?.gfsUri).toBe(parent.gfsUri))

      const dialog = await screen.findByRole('dialog', { name: 'Move file unreadable-child.txt' })
      const sidebarDialogText = dialog.textContent
      expect(dialog.querySelector('.da-gfs-move-dialog__current-location')?.textContent).toContain(
        'Shared parent'
      )
      fireEvent.click(await within(dialog).findByRole('button', { name: destination.name }))
      fireEvent.click(
        within(dialog).getByRole('button', { name: `Move here (${destination.name})` })
      )

      await waitFor(() =>
        expect(moveResource).toHaveBeenCalledWith(
          target.resourceId,
          destination.resourceId,
          'main',
          target.version,
          undefined,
          1
        )
      )
      expect(moveResource.mock.calls.map(call => [...call])).toEqual(filesCalls)
      expect(sidebarDialogText).toBe(filesDialogText)
      expect(gfs.resolve.mock.calls.filter(([uri]) => uri === parent.gfsUri)).toHaveLength(
        parentResolveCountBeforeSidebar
      )
    }
  )

  it('omits Move for a shared-root row without source parent', async () => {
    const target = await resolveResource(
      resolvedFile('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'root-move.txt')
    )
    const { moveResource } = installClerum([target], new Map(), {
      accessibleRows: [
        accessibleResource(target.resourceId, target.name, 'file', { gfsUri: target.gfsUri }),
      ],
    })
    renderApp()
    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /root-move\.txt/ })
    const menu = await openRowActions('root-move.txt')
    expect(within(menu).queryByRole('menuitem', { name: 'Move to' })).toBeNull()
    expect(within(menu).getByRole('menuitem', { name: 'Share' })).toBeTruthy()
    expect(moveResource).not.toHaveBeenCalled()
  })

  it('keeps copy-content owned by the matching Preview page', async () => {
    const markdown = await resolveResource(
      resolvedFile('44444444444444444444444444444444', 'preview-source.md')
    )
    const { gfs, deleteResource } = installClerum([markdown])
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    appHarness.controller = makeController(
      openFilesTab(createWorkspaceTabsState('chat-tab-1'), { id: 'files-root', path: null })
    )
    renderApp()

    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /preview-source\.md/ })

    await chooseFilesAction(markdown.name, 'Preview')
    await screen.findByRole('heading', { name: markdown.name, level: 2 })
    await choosePreviewAction(markdown.name, 'Copy content')
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    const filesOutcome = writeText.mock.calls.map(call => [...call])
    const previewDownloads = gfs.downloadPreview.mock.calls.map(call => [...call])
    expect(previewDownloads[0]?.[0]).toBe(markdown.gfsUri)
    writeText.mockClear()

    await chooseRowAction('preview-source.md', 'Copy content')

    await waitFor(() =>
      expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)).toMatchObject({
        kind: 'preview',
        preview: { gfsUri: markdown.gfsUri, fileKind: 'markdown' },
      })
    )
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    expect(writeText.mock.calls[0]).toEqual(['# fixture preview\n'])
    expect(writeText.mock.calls.map(call => [...call])).toEqual(filesOutcome)
    expect(gfs.downloadPreview.mock.calls.map(call => [...call])).toEqual(previewDownloads)
    expect(deleteResource).not.toHaveBeenCalled()
  })

  it('cancels a pending Preview copy when its active Preview tab is selected again', async () => {
    const resource = await resolveResource(
      resolvedFile('55555555555555555555555555555555', 'copy-target.md')
    )
    const { gfs } = installClerum([resource])
    const deferredPreview = deferred<PreviewDownload>()
    gfs.downloadPreview.mockImplementation(async () => deferredPreview.promise)
    const writeText = vi.fn(async (_text: string) => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    appHarness.controller.desktopEnvironmentSetupComplete = false
    renderApp()

    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /copy-target\.md/ })
    await chooseRowAction('copy-target.md', 'Copy content')
    await waitFor(() =>
      expect(gfs.downloadPreview).toHaveBeenCalledWith(resource.gfsUri, 2_097_152)
    )
    await expectActionAtConsumer(
      appHarness.previewPagePendingActions,
      resource.gfsUri,
      'copy-content'
    )
    await screen.findByRole('heading', { name: 'copy-target.md', level: 2 })
    const activePreviewTab = getWorkspaceTabButtons('copy-target.md').find(
      tab => tab.getAttribute('aria-pressed') === 'true'
    )
    expect(activePreviewTab).toBeTruthy()
    fireEvent.click(activePreviewTab as HTMLButtonElement)

    await act(async () => {
      deferredPreview.resolve(
        await previewDownloadResult(
          resource,
          new TextEncoder().encode('# Preview body').buffer,
          2_097_152
        )
      )
      await deferredPreview.promise
    })
    await screen.findByRole('heading', { name: 'Preview body' })
    expect(writeText).not.toHaveBeenCalled()
  })
})
