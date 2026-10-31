// @vitest-environment jsdom
import { useLayoutEffect, useReducer } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentTaskTrackerProvider } from '@contexts/AgentTaskTrackerContext'
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
import { DESKTOP_ROUTES } from '@constants/navigation'
import { NOTIFICATION_SETTINGS_STORAGE_KEY } from '@constants/notificationSettings'
import { installAppControllerClerum } from '@hooks/domain/__tests__/__fixtures__/appControllerHarness'
import { ipcHostAccessRevoked } from '@hooks/domain/__tests__/__fixtures__/ipcErrors'
import { installMockClerum } from '@hooks/domain/__tests__/__fixtures__/mockClerum'
import { buildGfsSessionScope } from '@hooks/domain/useGfsBrowserController'
import { useNotificationsController } from '@hooks/domain/useNotificationsController'
import { useAppController } from '@hooks/useAppController'
import { buildGfsResourceActions, getGfsMenuActions } from '@lib/gfsResourceActions'
import { desktopQueryClient } from '@lib/queryClient'
import {
  activeWorkspaceTab,
  createWorkspaceTabsState,
  newChatTab,
  openAppTab,
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
  forceRender: () => {},
  shortcutCommand: null as unknown as (commandId: string, source: 'host' | 'sandbox') => void,
  shortcutRegistrationCount: 0,
  lastShortcutCommand: null as string | null,
  filesPagePendingActions: [] as unknown[],
  filesPageLatestPendingAction: null as unknown,
  filesPageRenderCount: 0,
  filesPageLastLocation: null as { gfsUri: string | null; name: string | null } | null,
  previewPagePendingActions: [] as unknown[],
  beforeNativeAgentConversationNotification: null as null | (() => void),
  nativeNotificationContinuation: null as null | Promise<void>,
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

function useReactiveController(options?: {
  onBeforeNativeAgentConversationNotification?: () => void
}): AppController {
  const [, force] = useReducer((count: number) => count + 1, 0)
  appHarness.forceRender = force
  appHarness.beforeNativeAgentConversationNotification =
    options?.onBeforeNativeAgentConversationNotification ?? null
  const controller = appHarness.controller
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
    openAgentConversationFromNotification: vi.fn(
      async (target: { agentName: string; chatId?: string }) => {
        appHarness.beforeNativeAgentConversationNotification?.()
        await appHarness.nativeNotificationContinuation
        controller.handleSelectChatAgent(target.agentName, {
          ...(target.chatId ? { chatId: target.chatId } : {}),
          selectLatest: false,
        })
      }
    ),
    handleNavSelect,
    openFilesSection: vi.fn((path: string | null = null) => {
      const intentSequence = beginUserNavigationIntent()
      clearAppsPicker()
      const next = openFilesTab(controller.workspaceTabs, { id: nextWorkspaceTabId(), path })
      setWorkspaceTabs(next)
      return next.activeTabId ? { ownerTabId: next.activeTabId, intentSequence } : null
    }),
    openPreviewSection: vi.fn((preview, sessionScope?: string) => {
      clearAppsPicker()
      setWorkspaceTabs(state =>
        openPreviewTab(state, {
          id: nextWorkspaceTabId(),
          title: preview.name,
          gfsUri: preview.gfsUri,
          ...(sessionScope !== undefined ? { sessionScope } : {}),
          fileKind: preview.kind,
          byteLength: preview.bytes,
          ...(preview.version !== undefined ? { resourceVersion: preview.version } : {}),
          ...('mimeType' in preview ? { mimeType: preview.mimeType } : {}),
        })
      )
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

function resourceByteLength(resource: HarnessResource): number {
  if (typeof resource.bytes !== 'number') {
    throw new Error(`Expected fixture resource ${resource.gfsUri} to include a byte length`)
  }
  return resource.bytes
}

let originalClipboardDescriptor: PropertyDescriptor | undefined

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
  const moveResource = vi.fn(async () => ({}))
  const gfs = {
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
  return { gfs, deleteResource, createFolder, createFileFromPath, moveResource }
}

function renderApp() {
  return render(
    <QueryClientProvider client={desktopQueryClient}>
      <App />
    </QueryClientProvider>
  )
}

async function renderAppWithRealController(options?: { onTeamBLayoutCommit?: () => void }) {
  const gfsRuntimeBridge = window.clerum as unknown as Record<string, any>
  const { handle } = installAppControllerClerum({ agentNames: ['agent-a'] })
  const controllerBridge = window.clerum as unknown as Record<string, any>
  Object.assign(controllerBridge, {
    app: gfsRuntimeBridge.app,
    shortcuts: gfsRuntimeBridge.shortcuts,
    sandboxUi: gfsRuntimeBridge.sandboxUi,
    gfs: gfsRuntimeBridge.gfs,
  })
  Object.assign(controllerBridge.auth as object, gfsRuntimeBridge.auth)

  const actualControllerModule =
    await vi.importActual<typeof import('@hooks/useAppController')>('@hooks/useAppController')
  let liveController: AppController | null = null
  vi.mocked(useAppController).mockImplementation(controllerOptions => {
    liveController = actualControllerModule.useAppController(controllerOptions)
    useLayoutEffect(() => {
      if (liveController?.currentTeamId === 'team-2') options?.onTeamBLayoutCommit?.()
    }, [liveController?.currentTeamId])
    return liveController
  })
  render(
    <QueryClientProvider client={desktopQueryClient}>
      <AgentTaskTrackerProvider>
        <App />
      </AgentTaskTrackerProvider>
    </QueryClientProvider>
  )

  const currentController = () => {
    if (!liveController) throw new Error('The real App controller did not mount')
    return liveController
  }
  await waitFor(() => expect(currentController().isAuthenticated).toBe(true))
  await waitFor(() => expect(currentController().initialExperienceLoading).toBe(false))
  return { currentController, handle }
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

async function chooseRowAction(resourceName: string, actionName: string) {
  const row = screen
    .getAllByRole('treeitem')
    .find(
      item => item.querySelector('.da-file-explorer__name')?.textContent?.trim() === resourceName
    )
  if (!row) throw new Error(`Could not find the exact sidebar row for ${resourceName}`)
  fireEvent.click(within(row).getByRole('button', { name: `Options for ${resourceName}` }))
  if (['Copy link', 'Copy file ID', 'Copy folder ID'].includes(actionName)) {
    fireEvent.mouseEnter(await screen.findByRole('menuitem', { name: 'Share' }))
  }
  fireEvent.click(await screen.findByRole('menuitem', { name: actionName }))
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
  await screen.findByRole('button', { name: 'Options for Target folder' })
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

beforeEach(() => {
  originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  desktopQueryClient.clear()
  appHarness.forceRender = () => {}
  appHarness.shortcutCommand = () => {}
  appHarness.shortcutRegistrationCount = 0
  appHarness.lastShortcutCommand = null
  appHarness.filesPagePendingActions = []
  appHarness.filesPageLatestPendingAction = null
  appHarness.filesPageRenderCount = 0
  appHarness.filesPageLastLocation = null
  appHarness.previewPagePendingActions = []
  appHarness.beforeNativeAgentConversationNotification = null
  appHarness.nativeNotificationContinuation = null
  appHarness.sandboxUiShortcutAppRef = null
  appHarness.latestConversationNotification = null
  appHarness.controller = makeController()
  vi.mocked(useAppController).mockImplementation(useReactiveController)
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn() })),
  })
})

afterEach(() => {
  cleanup()
  desktopQueryClient.clear()
  if (originalClipboardDescriptor) {
    Object.defineProperty(navigator, 'clipboard', originalClipboardDescriptor)
  } else {
    Reflect.deleteProperty(navigator, 'clipboard')
  }
  delete (window as { clerum?: unknown }).clerum
  vi.restoreAllMocks()
})

describe('App → Files action lifecycle integration', () => {
  it('closes a loaded workspace Preview when the same principal switches teams', async () => {
    const markdown = '# Team A private content'
    const markdownBytes = new TextEncoder().encode(markdown)
    const resource = await resolveResource(
      resolvedFile('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'team-a-private.md', {
        bytes: markdownBytes.byteLength,
      })
    )
    const { gfs } = installClerum([resource])
    const downloadPreview = vi.fn((_uri: string, maxBytes: number) =>
      previewDownloadResult(resource, markdownBytes.buffer, maxBytes)
    )
    Object.assign(gfs, { downloadPreview })
    const { currentController, handle } = await renderAppWithRealController()
    const principalIdentity = currentController().authenticatedPrincipalIdentity
    const teamAScope = buildGfsSessionScope(
      currentController().runtimeConfigState?.envKey,
      currentController().isAuthenticated,
      currentController().me
    )
    if (!teamAScope) throw new Error('The authenticated team scope was not available')
    act(() =>
      currentController().openPreviewSection(
        {
          gfsUri: resource.gfsUri,
          kind: 'markdown',
          name: resource.name,
          bytes: resourceByteLength(resource),
          version: resource.version,
        },
        teamAScope
      )
    )

    expect(await screen.findByText('Team A private content')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Options for team-a-private.md' }))
    expect(screen.getByRole('menuitem', { name: 'Copy content' })).toBeTruthy()
    expect(downloadPreview).toHaveBeenCalledTimes(1)

    await act(async () => {
      await currentController().handleEnsureTeamContext({ teamId: 'team-2' })
    })

    expect(handle.switchTeam).toHaveBeenCalledWith('team-2')
    expect(currentController().authenticatedPrincipalIdentity).toBe(principalIdentity)
    expect(currentController().me?.teamId).toBe('team-2')
    expect(
      buildGfsSessionScope(
        currentController().runtimeConfigState?.envKey,
        currentController().isAuthenticated,
        currentController().me
      )
    ).not.toBe(teamAScope)
    await waitFor(() =>
      expect(
        currentController().workspaceTabs.tabs.filter(tab => tab.kind === 'preview')
      ).toHaveLength(0)
    )
    expect(screen.queryByText('Team A private content')).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Copy content' })).toBeNull()
    expect(downloadPreview).toHaveBeenCalledTimes(1)
  })

  it('drops a Files seed resolved during a real same-principal team switch', async () => {
    const markdownBytes = new TextEncoder().encode('# Team A pending resource')
    const resource = await resolveResource(
      resolvedFile('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'pending-team-a.md', {
        bytes: markdownBytes.byteLength,
      })
    )
    const pendingResolve = deferred<HarnessResource>()
    const { gfs } = installClerum([resource], new Map([[resource.gfsUri, pendingResolve]]))
    const downloadPreview = vi.fn((_uri: string, maxBytes: number) =>
      previewDownloadResult(resource, markdownBytes.buffer, maxBytes)
    )
    Object.assign(gfs, { downloadPreview })
    const { currentController, handle } = await renderAppWithRealController({
      onTeamBLayoutCommit: () => pendingResolve.resolve(resource),
    })
    const principalIdentity = currentController().authenticatedPrincipalIdentity

    act(() => currentController().openFilesSection(resource.gfsUri))
    await waitFor(() => expect(gfs.resolve).toHaveBeenCalledWith(resource.gfsUri))

    await act(async () => {
      await currentController().handleEnsureTeamContext({ teamId: 'team-2' })
      await pendingResolve.promise
    })

    expect(handle.switchTeam).toHaveBeenCalledWith('team-2')
    expect(currentController().currentTeamId).toBe('team-2')
    expect(currentController().authenticatedPrincipalIdentity).toBe(principalIdentity)
    expect(currentController().workspaceTabs.tabs.some(tab => tab.kind === 'preview')).toBe(false)
    expect(downloadPreview).not.toHaveBeenCalled()
  })

  it('drops a pending Preview download, closes inactive previews, and does not replay on switch-back', async () => {
    const resourceA = await resolveResource(
      resolvedFile('dddddddddddddddddddddddddddddddd', 'loaded-team-a.md')
    )
    const resourceB = await resolveResource(
      resolvedFile('eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', 'pending-team-a.md')
    )
    const bytesA = new TextEncoder().encode('# Loaded Team A content')
    const bytesB = new TextEncoder().encode('# Pending Team A content')
    const resultA = await previewDownloadResult(resourceA, bytesA.buffer)
    const resultB = await previewDownloadResult(resourceB, bytesB.buffer)
    const pendingA = deferred<PreviewDownload>()
    const pendingB = deferred<PreviewDownload>()
    const { gfs } = installClerum([resourceA, resourceB])
    const downloadPreview = vi.fn((uri: string) =>
      uri === resourceA.gfsUri ? pendingA.promise : pendingB.promise
    )
    Object.assign(gfs, { downloadPreview })
    const { currentController } = await renderAppWithRealController({
      onTeamBLayoutCommit: () => pendingB.resolve(resultB),
    })
    const teamAScope = buildGfsSessionScope(
      currentController().runtimeConfigState?.envKey,
      currentController().isAuthenticated,
      currentController().me
    )
    if (!teamAScope) throw new Error('Team A scope was not available')

    act(() =>
      currentController().openPreviewSection(
        {
          gfsUri: resourceA.gfsUri,
          kind: 'markdown',
          name: resourceA.name,
          bytes: resourceByteLength(resourceA),
          version: resourceA.version,
        },
        teamAScope
      )
    )
    await waitFor(() =>
      expect(downloadPreview).toHaveBeenCalledWith(resourceA.gfsUri, expect.any(Number))
    )
    await act(async () => {
      pendingA.resolve(resultA)
      await pendingA.promise
    })
    expect(await screen.findByText('Loaded Team A content')).toBeTruthy()

    act(() =>
      currentController().openPreviewSection(
        {
          gfsUri: resourceB.gfsUri,
          kind: 'markdown',
          name: resourceB.name,
          bytes: resourceByteLength(resourceB),
          version: resourceB.version,
        },
        teamAScope
      )
    )
    await waitFor(() =>
      expect(downloadPreview).toHaveBeenCalledWith(resourceB.gfsUri, expect.any(Number))
    )
    expect(
      currentController().workspaceTabs.tabs.filter(tab => tab.kind === 'preview')
    ).toHaveLength(2)

    await act(async () => {
      await currentController().handleEnsureTeamContext({ teamId: 'team-2' })
      await pendingB.promise
    })
    expect(
      currentController().workspaceTabs.tabs.filter(tab => tab.kind === 'preview')
    ).toHaveLength(0)
    expect(screen.queryByText('Pending Team A content')).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Copy content' })).toBeNull()

    await act(async () => {
      await currentController().handleEnsureTeamContext({ teamId: 'team-1' })
    })
    expect(
      currentController().workspaceTabs.tabs.filter(tab => tab.kind === 'preview')
    ).toHaveLength(0)
    expect(downloadPreview).toHaveBeenCalledTimes(2)
  })

  it('keeps a newer explicit Chat selection when Preview scope cleanup runs', async () => {
    const resource = await resolveResource(
      resolvedFile('ffffffffffffffffffffffffffffffff', 'latest-selection.md')
    )
    installClerum([resource])
    Object.assign(window.clerum.sandboxUi, {
      listApps: vi.fn(async () => ({
        apps: [
          {
            appRef: 'ns/selection-app',
            title: 'Selection app',
            defaultPath: '/',
            ready: true,
            phase: 'active',
          },
        ],
      })),
    })
    const controller = makeController()
    const teamAScope = buildGfsSessionScope('', true, controller.me)
    if (!teamAScope) throw new Error('Team A scope was not available')
    const appTab = openAppTab(controller.workspaceTabs, {
      id: 'selection-app-tab',
      appRef: 'ns/selection-app',
      title: 'Selection app',
    })
    const workspaceTabs = openPreviewTab(appTab, {
      id: 'selection-preview-tab',
      title: resource.name,
      gfsUri: resource.gfsUri,
      fileKind: 'markdown',
      byteLength: resourceByteLength(resource),
      sessionScope: teamAScope,
    })
    controller.workspaceTabs = workspaceTabs
    appHarness.controller = controller
    let injectExplicitChatSelection = false
    const setWorkspaceTabs = controller.setWorkspaceTabs
    controller.setWorkspaceTabs = vi.fn(updater => {
      if (injectExplicitChatSelection) {
        injectExplicitChatSelection = false
        controller.selectWorkspaceTabById('chat-tab-1')
      }
      setWorkspaceTabs(updater)
    })
    renderApp()
    await screen.findByRole('heading', { name: /fixture preview/i })

    act(() => {
      controller.me = { ...controller.me!, teamId: 'team-b' }
      controller.currentTeamId = 'team-b'
      injectExplicitChatSelection = true
      appHarness.forceRender()
    })

    await waitFor(() =>
      expect(controller.workspaceTabs.tabs.some(tab => tab.kind === 'preview')).toBe(false)
    )
    expect(activeWorkspaceTab(controller.workspaceTabs)).toMatchObject({
      id: 'chat-tab-1',
      kind: 'chat',
    })
    expect(appHarness.sandboxUiShortcutAppRef).toBeNull()
  })

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
      fireEvent.click(
        within(row as HTMLElement).getByRole('button', { name: `Options for ${resource.name}` })
      )
      const menu = await screen.findByRole('menu', { name: `Actions for ${resource.name}` })
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

  it('opens and submits New folder against the exact live same-tab destination', async () => {
    const { targetFolder, createFolder } = await openLiveTargetInSameFilesTab()

    await chooseRowAction(targetFolder.name, 'New folder')
    const dialog = await screen.findByRole('dialog', { name: 'New folder' })
    expect(dialog.textContent).toContain(`Create a new folder in ${targetFolder.name}.`)
    expect(dialog.contains(document.activeElement), document.activeElement?.outerHTML).toBe(true)

    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Folder name' }), {
      target: { value: 'Created from sidebar' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create folder' }))

    await waitFor(() =>
      expect(createFolder).toHaveBeenCalledWith(
        targetFolder.resourceId,
        'Created from sidebar',
        'main'
      )
    )
  })

  it('opens the file chooser and uploads into the exact live same-tab destination', async () => {
    const { targetFolder, createFileFromPath } = await openLiveTargetInSameFilesTab()
    const filesBrowser = screen.getByRole('region', { name: 'EvenDrive browser' })
    const uploadInput = within(filesBrowser).getByLabelText('Upload file', {
      selector: 'input[type="file"]',
    }) as HTMLInputElement
    const clickChooser = vi.spyOn(uploadInput, 'click').mockImplementation(() => undefined)

    await chooseRowAction(targetFolder.name, 'Upload file')
    await waitFor(() => expect(clickChooser).toHaveBeenCalledTimes(1))
    const upload = new File(['test upload'], 'sidebar-upload.md', { type: 'text/markdown' })
    fireEvent.change(uploadInput, { target: { files: [upload] } })

    await waitFor(() =>
      expect(createFileFromPath).toHaveBeenCalledWith(
        targetFolder.resourceId,
        'sidebar-upload.md',
        'sidebar-upload.md',
        'main'
      )
    )
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
      files: { path: target.gfsUri },
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
    const openFilesSection = appHarness.controller.openFilesSection
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
    const intentBeforeSelection = appHarness.controller.navigationIntentSequence
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
    expect(appHarness.controller.navigationIntentSequence).toBeGreaterThan(intentBeforeSelection)
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
    const intentBeforeSelection = appHarness.controller.navigationIntentSequence
    fireEvent.click(screen.getByRole('button', { name: 'Open conversation notification' }))
    expect(appHarness.controller.handleOpenNotification).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'notification-chat' }),
      {
        keepNavItem: true,
        navigationIntentSequence: intentBeforeSelection + 1,
      }
    )
    expect(appHarness.controller.selectedAgent).toBe('agent-a')
    expect(appHarness.controller.activeChatId).toBe('notification-chat')
    expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)?.kind).toBe('files')
    expect(appHarness.controller.navigationIntentSequence).toBeGreaterThan(intentBeforeSelection)

    await act(async () => {
      deferredTarget.resolve(targetA)
      await deferredTarget.promise
    })
    expect(screen.queryByText('Delete target-a.txt?')).toBeNull()
    expect(deleteResource).not.toHaveBeenCalled()
    expect(gfs.download).not.toHaveBeenCalled()
    expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)?.kind).toBe('files')
  })

  it('cancels a pending Files action before a native desktop conversation notification', async () => {
    const deferredTarget = deferred<unknown>()
    const notificationResolution = deferred<void>()
    appHarness.nativeNotificationContinuation = notificationResolution.promise
    const { gfs, deleteResource } = installClerum(
      [targetA],
      new Map([[targetA.gfsUri, deferredTarget]])
    )
    appHarness.controller.desktopEnvironmentSetupComplete = false
    renderApp()

    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /target-a\.txt/ })
    await chooseDeleteAction('target-a.txt')
    await waitFor(() => expect(gfs.resolve).toHaveBeenCalledWith(targetA.gfsUri))
    await expectActionAtConsumer(appHarness.filesPagePendingActions, targetA.gfsUri, 'delete')

    let nativeNotificationOpen!: Promise<void>
    act(() => {
      const nativeNotificationController = appHarness.controller as AppController & {
        openAgentConversationFromNotification: (target: {
          agentName: string
          chatId?: string
          teamId?: string
        }) => Promise<void>
      }
      nativeNotificationOpen = nativeNotificationController.openAgentConversationFromNotification({
        agentName: 'agent-a',
        chatId: 'notification-chat',
        teamId: 'team-a',
      })
    })
    expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)?.kind).toBe('files')

    await act(async () => {
      deferredTarget.resolve(targetA)
      await deferredTarget.promise
    })

    expect(screen.queryByText('Delete target-a.txt?')).toBeNull()
    notificationResolution.resolve()
    await act(async () => nativeNotificationOpen)

    expect(screen.queryByText('Delete target-a.txt?')).toBeNull()
    expect(appHarness.controller.activeChatId).toBe('notification-chat')
    expect(deleteResource).not.toHaveBeenCalled()
    expect(gfs.download).not.toHaveBeenCalled()
  })

  it('opens a produced cross-team reply through App and the real controller', async () => {
    const { gfs } = installClerum([])
    const gfsRuntimeBridge = window.clerum as unknown as Record<string, any>
    const { clerum, handle } = installAppControllerClerum({ agentNames: ['agent-a'] })
    const controllerBridge = window.clerum as unknown as Record<string, any>
    Object.assign(controllerBridge, {
      app: gfsRuntimeBridge.app,
      shortcuts: gfsRuntimeBridge.shortcuts,
      sandboxUi: gfsRuntimeBridge.sandboxUi,
      gfs,
    })
    Object.assign(controllerBridge.auth as object, gfsRuntimeBridge.auth)
    await clerum.chat.create('agent-a', 'produced-cross-team-chat')
    clerum.rpc.invokeHostMessage.mockResolvedValue({ taskId: 'produced-cross-team-task' })
    clerum.rpc.getTaskResult.mockResolvedValue({ response: 'A team two reply' })
    const previousNotificationSettings = window.localStorage.getItem(
      NOTIFICATION_SETTINGS_STORAGE_KEY
    )
    window.localStorage.setItem(
      NOTIFICATION_SETTINGS_STORAGE_KEY,
      JSON.stringify({ inApp: 'always', desktop: 'never', soundVolume: 0 })
    )

    const actualControllerModule =
      await vi.importActual<typeof import('@hooks/useAppController')>('@hooks/useAppController')
    let liveController: AppController | null = null
    vi.mocked(useAppController).mockImplementation(options => {
      liveController = actualControllerModule.useAppController(options)
      return liveController
    })
    render(
      <QueryClientProvider client={desktopQueryClient}>
        <AgentTaskTrackerProvider>
          <App />
        </AgentTaskTrackerProvider>
      </QueryClientProvider>
    )

    try {
      const currentController = () => {
        if (!liveController) throw new Error('The real App controller did not mount')
        return liveController
      }
      await waitFor(() => expect(currentController().isAuthenticated).toBe(true))
      await waitFor(() => expect(currentController().initialExperienceLoading).toBe(false))

      await act(async () => {
        await currentController().handleEnsureTeamContext({ teamId: 'team-2' })
      })
      await waitFor(() => expect(currentController().currentTeamId).toBe('team-2'))
      act(() =>
        currentController().handleSelectChatAgent('agent-a', {
          chatId: 'produced-cross-team-chat',
          selectLatest: false,
        })
      )
      await waitFor(() => expect(currentController().activeChatId).toBe('produced-cross-team-chat'))
      await waitFor(() => expect(currentController().chatMessagesLoading).toBe(false))
      act(() => currentController().handleNavSelect(DESKTOP_ROUTES.files))

      const sendPromise = currentController().handleSendAgentMessage('Create a team reply')
      await waitFor(() => expect(clerum.hasProgressHandler('produced-cross-team-task')).toBe(true))
      await act(async () => {
        clerum.emitTaskProgress('produced-cross-team-task', {
          type: 'open',
          taskId: 'produced-cross-team-task',
          hostRef: 'agent-a',
        })
        clerum.emitTaskProgress('produced-cross-team-task', {
          type: 'terminal',
          data: { taskId: 'produced-cross-team-task', status: 'completed' },
        })
        await sendPromise
      })
      await waitFor(() => expect(appHarness.latestConversationNotification?.teamId).toBe('team-2'))
      const producedNotification = appHarness.latestConversationNotification
      expect(producedNotification).toMatchObject({ teamId: 'team-2' })
      const notificationChatId = producedNotification?.chatId
      expect(notificationChatId).toBeTruthy()
      const notificationButton = await screen.findByRole('button', {
        name: 'Open conversation notification',
      })

      await act(async () => {
        await currentController().handleEnsureTeamContext({ teamId: 'team-1' })
      })
      await waitFor(() => expect(currentController().currentTeamId).toBe('team-1'))
      fireEvent.click(notificationButton)

      await waitFor(() => expect(currentController().currentTeamId).toBe('team-2'))
      await waitFor(() => expect(currentController().activeChatId).toBe(notificationChatId))
      expect(currentController().navItem).toBe(DESKTOP_ROUTES.chat)
      expect(currentController().selectedAgent).toBe('agent-a')
      expect(activeWorkspaceTab(currentController().workspaceTabs)).toMatchObject({
        kind: 'chat',
        chat: { agentRef: 'agent-a', chatId: notificationChatId },
      })
      expect((handle.switchTeam.mock.calls as Array<[string]>).map(([teamId]) => teamId)).toEqual([
        'team-2',
        'team-1',
        'team-2',
      ])
    } finally {
      if (previousNotificationSettings === null) {
        window.localStorage.removeItem(NOTIFICATION_SETTINGS_STORAGE_KEY)
      } else {
        window.localStorage.setItem(NOTIFICATION_SETTINGS_STORAGE_KEY, previousNotificationSettings)
      }
    }
  })

  it('cancels a pending Files action through a produced native notification while Host verification waits', async () => {
    const deferredTarget = deferred<unknown>()
    const { gfs, deleteResource } = installClerum(
      [targetA],
      new Map([[targetA.gfsUri, deferredTarget]])
    )
    const gfsRuntimeBridge = window.clerum as unknown as Record<string, any>
    const { clerum } = installAppControllerClerum({ agentNames: ['agent-a'] })
    const controllerBridge = window.clerum as unknown as Record<string, any>
    Object.assign(controllerBridge, {
      app: gfsRuntimeBridge.app,
      shortcuts: gfsRuntimeBridge.shortcuts,
      sandboxUi: gfsRuntimeBridge.sandboxUi,
      gfs,
    })
    Object.assign(controllerBridge.auth as object, gfsRuntimeBridge.auth)
    await clerum.chat.create('agent-a', 'native-notification-chat')
    clerum.rpc.invokeHostMessage.mockResolvedValue({ taskId: 'native-notification-task' })
    clerum.rpc.getTaskResult.mockResolvedValue({ response: 'A desktop reply' })
    const previousNotificationSettings = window.localStorage.getItem(
      NOTIFICATION_SETTINGS_STORAGE_KEY
    )
    window.localStorage.setItem(
      NOTIFICATION_SETTINGS_STORAGE_KEY,
      JSON.stringify({ inApp: 'always', desktop: 'always', soundVolume: 0 })
    )

    const notificationBridge = controllerBridge.notifications as {
      show: (payload: { id: string }) => Promise<{ supported: boolean; id: string }>
      onClick: (callback: (event: { id: string }) => void) => () => void
    }
    let notificationId: string | null = null
    let clickHandler: ((event: { id: string }) => void) | null = null
    notificationBridge.show = vi.fn(async payload => {
      notificationId = payload.id
      return { supported: true, id: payload.id }
    })
    notificationBridge.onClick = vi.fn(callback => {
      clickHandler = callback
      return vi.fn()
    })

    const originalNotification = Object.getOwnPropertyDescriptor(window, 'Notification')
    class GrantedNotification {
      static permission = 'granted'
      static requestPermission = async () => 'granted' as NotificationPermission
      constructor(_title: string, _options?: NotificationOptions) {}
      close() {}
    }
    Object.defineProperty(window, 'Notification', {
      configurable: true,
      value: GrantedNotification,
    })

    const actualControllerModule =
      await vi.importActual<typeof import('@hooks/useAppController')>('@hooks/useAppController')
    let liveController: AppController | null = null
    vi.mocked(useAppController).mockImplementation(options => {
      liveController = actualControllerModule.useAppController(options)
      return liveController
    })
    const queryClient = desktopQueryClient
    render(
      <QueryClientProvider client={queryClient}>
        <AgentTaskTrackerProvider>
          <App />
        </AgentTaskTrackerProvider>
      </QueryClientProvider>
    )

    try {
      const currentController = () => {
        if (!liveController) throw new Error('The real App controller did not mount')
        return liveController
      }
      await waitFor(() => expect(currentController().isAuthenticated).toBe(true))
      await waitFor(() => expect(currentController().initialExperienceLoading).toBe(false))
      act(() =>
        currentController().handleSelectChatAgent('agent-a', {
          chatId: 'native-notification-chat',
          selectLatest: false,
        })
      )
      await waitFor(() => expect(currentController().activeChatId).toBe('native-notification-chat'))
      await waitFor(() => expect(currentController().chatMessagesLoading).toBe(false))
      act(() => currentController().handleNavSelect(DESKTOP_ROUTES.files))
      await waitFor(() => expect(currentController().navItem).toBe(DESKTOP_ROUTES.files))

      fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
      await screen.findByRole('treeitem', { name: /target-a\.txt/ })
      await chooseDeleteAction('target-a.txt')
      await waitFor(() => expect(gfs.resolve).toHaveBeenCalledWith(targetA.gfsUri))
      await expectActionAtConsumer(appHarness.filesPagePendingActions, targetA.gfsUri, 'delete')
      await waitFor(() => expect(notificationBridge.onClick).toHaveBeenCalled())

      const sendPromise = currentController().handleSendAgentMessage('Create a reply')
      await waitFor(() => expect(clerum.hasProgressHandler('native-notification-task')).toBe(true))
      await act(async () => {
        clerum.emitTaskProgress('native-notification-task', {
          type: 'open',
          taskId: 'native-notification-task',
          hostRef: 'agent-a',
        })
        clerum.emitTaskProgress('native-notification-task', {
          type: 'terminal',
          data: { taskId: 'native-notification-task', status: 'completed' },
        })
        await sendPromise
      })
      await waitFor(() => expect(notificationBridge.show).toHaveBeenCalledTimes(1))
      expect(notificationId).toBeTruthy()
      expect(clickHandler).toBeTypeOf('function')
      const notificationChatId = currentController().activeChatId
      expect(notificationChatId).toBeTruthy()

      clerum.rpc.renameSession.mockRejectedValue(await ipcHostAccessRevoked('rpc:renameSession'))
      await act(async () => {
        await currentController().handleRenameChatForAgent(
          'agent-a',
          'native-notification-chat',
          'Renamed'
        )
      })
      expect(currentController().isHostAccessBlocked('agent-a')).toBe(true)
      const previousStatus = currentController().statusText
      const verification = deferred<{ items: unknown[] }>()
      const verificationStarted = deferred<void>()
      clerum.rpc.listSessions.mockImplementation(
        async (_hostRef: string, _teamId: string | undefined, query?: { limit?: number }) => {
          if (query?.limit === 1) {
            verificationStarted.resolve()
            return verification.promise
          }
          return { items: [] }
        }
      )

      act(() => clickHandler?.({ id: notificationId! }))
      await act(async () => verificationStarted.promise)
      expect(currentController().navItem).toBe(DESKTOP_ROUTES.files)
      await waitFor(() => expect(appHarness.filesPageLatestPendingAction).toBeNull())
      const liveLocationBeforeResolve = appHarness.filesPageLastLocation?.gfsUri ?? null
      await act(async () => {
        deferredTarget.resolve(targetA)
        await deferredTarget.promise
        await new Promise(resolve => setTimeout(resolve, 0))
      })

      // Give the producer-backed resolver and FilesPage effects a task turn.
      // Cancellation leaves the live route where it was; without the App bridge,
      // FilesPage reports the exact target and opens Delete.
      expect(appHarness.filesPageLastLocation?.gfsUri ?? null).toBe(liveLocationBeforeResolve)
      expect(screen.queryByText('Delete target-a.txt?')).toBeNull()
      expect(deleteResource).not.toHaveBeenCalled()
      expect(gfs.download).not.toHaveBeenCalled()
      expect(currentController().statusText).toBe(previousStatus)

      await act(async () => {
        verification.resolve({ items: [] })
        await verification.promise
      })
      await waitFor(() => expect(currentController().navItem).toBe(DESKTOP_ROUTES.chat))
      expect(currentController().activeChatId).toBe(notificationChatId)
    } finally {
      if (previousNotificationSettings === null) {
        window.localStorage.removeItem(NOTIFICATION_SETTINGS_STORAGE_KEY)
      } else {
        window.localStorage.setItem(NOTIFICATION_SETTINGS_STORAGE_KEY, previousNotificationSettings)
      }
      if (originalNotification) {
        Object.defineProperty(window, 'Notification', originalNotification)
      } else {
        Reflect.deleteProperty(window, 'Notification')
      }
    }
  })

  it('does not download a canceled non-previewable action seed after notification selection', async () => {
    const binary = await resolveResource(
      resolvedFile('66666666666666666666666666666666', 'target-a.bin')
    )
    const deferredTarget = deferred<unknown>()
    const { gfs, deleteResource } = installClerum(
      [binary],
      new Map([[binary.gfsUri, deferredTarget]])
    )
    appHarness.controller.desktopEnvironmentSetupComplete = false
    appHarness.controller.notifications = [produceConversationNotification()]
    renderApp()

    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /target-a\.bin/ })
    await chooseDeleteAction('target-a.bin')
    await waitFor(() => expect(gfs.resolve).toHaveBeenCalledWith(binary.gfsUri))
    await expectActionAtConsumer(appHarness.filesPagePendingActions, binary.gfsUri, 'delete')

    fireEvent.click(screen.getByRole('button', { name: 'Toggle chat drawer' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open conversation notification' }))
    await act(async () => {
      deferredTarget.resolve(binary)
      await deferredTarget.promise
    })

    expect(gfs.download).not.toHaveBeenCalled()
    expect(deleteResource).not.toHaveBeenCalled()
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
    const { deleteResource } = installClerum([targetA])
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
    await chooseDeleteAction('target-a.txt')
    await confirmDelete('target-a.txt')

    await waitFor(() => expect(deleteResource).toHaveBeenCalledTimes(1))
    expect(deleteResource.mock.calls[0]).toEqual([targetA.resourceId, 'main', targetA.version])
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
        kind: 'preview',
        preview: { gfsUri: targetA.gfsUri },
      })
    )
    expect(screen.queryByText('Delete target-a.txt?')).toBeNull()
    expect(deleteResource).not.toHaveBeenCalled()
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
        files: { path: targetA.gfsUri },
      })
    )

    const targetResolveCount = gfs.resolve.mock.calls.filter(
      ([uri]) => uri === targetA.gfsUri
    ).length
    fireEvent.click(getWorkspaceTabButtons('Files')[0]!)
    await waitFor(() => expect(screen.queryByText('Delete target-a.txt?')).toBeNull())
    fireEvent.click(getWorkspaceTabButtons('target-a.txt')[0]!)
    await waitFor(() =>
      expect(
        gfs.resolve.mock.calls.filter(([uri]) => uri === targetA.gfsUri).length
      ).toBeGreaterThan(targetResolveCount)
    )
    await waitFor(() =>
      expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)).toMatchObject({
        kind: 'preview',
        preview: { gfsUri: targetA.gfsUri },
      })
    )
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
    'moves a child through its exact parent (readable: %s)',
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
      const { moveResource } = installClerum([parent, target, destination], new Map(), {
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
      renderApp()

      fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
      const parentRow = await screen.findByRole('treeitem', { name: /Shared parent/ })
      fireEvent.click(within(parentRow).getByRole('button', { name: 'Expand Shared parent' }))
      await screen.findByRole('button', { name: 'Options for unreadable-child.txt' })
      await chooseRowAction(target.name, 'Move to')

      const dialog = await screen.findByRole('dialog', { name: 'Move file unreadable-child.txt' })
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
    const row = await screen.findByRole('treeitem', { name: /root-move\.txt/ })
    fireEvent.click(within(row).getByRole('button', { name: 'Options for root-move.txt' }))
    const menu = await screen.findByRole('menu', { name: 'Actions for root-move.txt' })
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
    renderApp()

    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /preview-source\.md/ })
    await chooseRowAction('preview-source.md', 'Copy content')

    await waitFor(() =>
      expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)).toMatchObject({
        kind: 'preview',
        preview: { gfsUri: markdown.gfsUri, fileKind: 'markdown' },
      })
    )
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    expect(writeText.mock.calls[0]).toEqual(['# fixture preview\n'])
    expect(gfs.downloadPreview).toHaveBeenCalled()
    expect(gfs.downloadPreview.mock.calls[0]?.[0]).toBe(markdown.gfsUri)
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

describe('App explicit Chat intent handoff through the real controller', () => {
  it.each([null, 'agent-a'])(
    'closes Files into its Chat neighbor with exactly one intent (agent: %s)',
    async agentRef => {
      installClerum([])
      const { currentController } = await renderAppWithRealController()
      const workspace = openFilesTab(createWorkspaceTabsState('intent-chat-owner', agentRef), {
        id: 'files-to-close',
        path: null,
      })
      act(() => currentController().setWorkspaceTabs(workspace))
      await waitFor(() =>
        expect(activeWorkspaceTab(currentController().workspaceTabs)?.id).toBe('files-to-close')
      )
      const before = currentController().navigationIntentSequence
      fireEvent.click(screen.getByRole('button', { name: 'Close Files' }))
      await waitFor(() => {
        expect(currentController().navItem).toBe(DESKTOP_ROUTES.chat)
        expect(activeWorkspaceTab(currentController().workspaceTabs)?.id).toBe('intent-chat-owner')
        expect(
          currentController().workspaceTabs.tabs.some(tab => tab.id === 'files-to-close')
        ).toBe(false)
      })
      expect(currentController().navigationIntentSequence).toBe(before + 1)
    }
  )

  it.each(['chat', 'files'] as const)(
    'creates New chat once from %s and records later active-tab reselection once',
    async surface => {
      installClerum([])
      const { currentController } = await renderAppWithRealController()
      const chatWorkspace = createWorkspaceTabsState('prior-chat', 'agent-a')
      act(() =>
        currentController().setWorkspaceTabs(
          surface === 'files'
            ? openFilesTab(chatWorkspace, { id: 'files-before-new', path: null })
            : chatWorkspace
        )
      )
      const before = currentController().navigationIntentSequence
      const newChatAction = screen
        .getAllByRole('button', { name: 'New chat' })
        .find(button => !button.hasAttribute('aria-pressed'))
      if (!newChatAction) throw new Error('The explicit New chat action did not render')
      fireEvent.click(newChatAction)
      if (surface === 'files') {
        // Files supports the existing drawer diversion; New chat must not replace it.
        await screen.findByRole('button', { name: 'Open chats' })
      } else {
        await waitFor(() => expect(currentController().navItem).toBe(DESKTOP_ROUTES.chat))
      }
      const selected = activeWorkspaceTab(currentController().workspaceTabs)
      expect(selected?.kind).toBe(surface)
      expect(currentController().navigationIntentSequence).toBe(before + 1)
      const newChatIntent = currentController().navigationIntentSequence
      const tab = getWorkspaceTabButtons(selected!.title).find(
        button => button.getAttribute('aria-pressed') === 'true'
      )
      if (!tab) throw new Error('New chat did not select a rendered workspace tab')
      fireEvent.click(tab)
      expect(currentController().navigationIntentSequence).toBe(newChatIntent + 1)
      expect(currentController().isNavigationIntentCurrent(newChatIntent)).toBe(false)
      expect(activeWorkspaceTab(currentController().workspaceTabs)?.id).toBe(selected!.id)
      expect(currentController().navItem).toBe(
        surface === 'files' ? DESKTOP_ROUTES.files : DESKTOP_ROUTES.chat
      )
    }
  )
})
