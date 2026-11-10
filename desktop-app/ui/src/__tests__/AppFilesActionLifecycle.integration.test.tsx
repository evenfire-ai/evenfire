// @vitest-environment jsdom
import { useReducer } from 'react'
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
import fc, { type AsyncCommand, type Scheduler } from 'fast-check'
import { DESKTOP_ROUTES } from '@constants/navigation'
import { installAppControllerClerum } from '@hooks/domain/__tests__/__fixtures__/appControllerHarness'
import { installMockClerum } from '@hooks/domain/__tests__/__fixtures__/mockClerum'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
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
  downloadResult,
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
  appHarness.forceRender = force
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
  const isSessionGenerationCurrent = vi.fn(
    (generation: number | null) => generation === controller.sessionGeneration
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
    isSessionGenerationCurrent,
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

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
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

async function renderActualA01App(
  resources: Array<Awaited<ReturnType<typeof resolveResource>>>,
  writeText: (text: string) => Promise<void>,
  options: { readable?: boolean } = {}
) {
  const byUri = new Map(resources.map(resource => [resource.gfsUri, resource]))
  const accessPage = await listAccessiblePage(
    resources.map(resource =>
      Object.assign(
        accessibleResource(
          resource.resourceId,
          resource.name,
          resource.kind as 'file' | 'directory',
          {
            gfsUri: resource.gfsUri,
            parentResourceId: resource.parentResourceId,
            version: resource.version,
          }
        ),
        { readable: options.readable ?? true }
      )
    )
  )
  const sessionAuthority = {
    authenticated: true,
    generation: 1,
    me: {
      id: 'a01-user',
      email: 'a01@example.test',
      name: 'A01 User',
      teamId: 'team-a',
      teamName: 'Team A',
    },
  }
  const { clerum } = installAppControllerClerum({
    me: { teamId: 'team-a', teamName: 'Team A' },
    teamDirectory: { items: [], currentTeamId: 'team-a' },
    desktopEnvironmentHandoffProducer: {
      getSessionState: async () => ({
        authenticated: sessionAuthority.authenticated,
        me: sessionAuthority.authenticated ? sessionAuthority.me : null,
        sessionGeneration: sessionAuthority.generation,
      }),
      getSessionGeneration: () => sessionAuthority.generation,
      getRuntimeConfigState: () => ({
        configured: true,
        isLocalhost: false,
        selectorVisible: true,
        activeOptionId: null,
        currentConfig: undefined,
        envKey: 'a01-environment',
        storagePath: '/a01/runtime-configs',
        options: [],
      }),
      selectRuntimeConfigForHandoff: async () => {
        throw new Error('unused A01 probe boundary')
      },
      logout: async () => {
        sessionAuthority.authenticated = false
        sessionAuthority.generation += 1
        return sessionAuthority.generation
      },
    },
  })
  const gfs = {
    listAccessible: vi.fn(async () => accessPage),
    listChildren: vi.fn(async () => await listChildrenPage([])),
    affordances: vi.fn(async () => await resourceAffordances(['read', 'write'])),
    download: vi.fn(async () => await downloadResult(resources[0]!)),
    resolve: vi.fn(async (uri: string) => {
      const resource = byUri.get(uri)
      if (!resource) throw new Error(`unexpected GFS resolve: ${uri}`)
      return resource
    }),
  }
  Object.assign(clerum, {
    gfs,
    app: { rendererReady: vi.fn(async () => undefined) },
    shortcuts: { onCommand: vi.fn(() => vi.fn()) },
    sandboxUi: {
      onReleased: vi.fn(() => vi.fn()),
      onSessionInvalidated: vi.fn(() => vi.fn()),
      onDeepLink: vi.fn(() => vi.fn()),
      listApps: vi.fn(async () => ({ apps: [] })),
      listPendingDeepLinks: vi.fn(async () => ({ links: [] })),
      clearPendingDeepLinks: vi.fn(async () => 0),
      acknowledgeDeepLink: vi.fn(async () => undefined),
      setVisible: vi.fn(async () => undefined),
      focusActive: vi.fn(async () => undefined),
    },
  })
  const actual =
    await vi.importActual<typeof import('@hooks/useAppController')>('@hooks/useAppController')
  const realController: { current: AppController | null } = { current: null }
  vi.mocked(useAppController).mockImplementation(() => {
    realController.current = actual.useAppController()
    return realController.current
  })
  render(
    <QueryClientProvider client={desktopQueryClient}>
      <AgentTaskTrackerProvider>
        <App />
      </AgentTaskTrackerProvider>
    </QueryClientProvider>
  )
  await waitFor(() => expect(realController.current?.isAuthenticated).toBe(true))
  await waitFor(() => expect(realController.current?.initialExperienceLoading).toBe(false))
  return { controller: realController, gfs, clerum, writeText, sessionAuthority }
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
    fireEvent.mouseEnter(await screen.findByRole('menuitem', { name: 'Share' }))
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
  appHarness.previewPagePendingActions = []
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
  if (originalCreateObjectUrlDescriptor) {
    Object.defineProperty(URL, 'createObjectURL', originalCreateObjectUrlDescriptor)
  } else {
    Reflect.deleteProperty(URL, 'createObjectURL')
  }
  delete (window as { clerum?: unknown }).clerum
  vi.restoreAllMocks()
})

describe('App → Files action lifecycle integration', () => {
  it('A01 model: Copy ID preserves Chat with the real controller', async () => {
    const file = await resolveResource(
      resolvedFile('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'a01-real-controller.txt')
    )
    const writeCalls: string[] = []
    let scheduler!: Scheduler
    const writeText = vi.fn(async (text: string) => {
      writeCalls.push(text)
      return scheduler
        .schedule(Promise.resolve(text), 'clipboard write settlement')
        .then(() => undefined)
    })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const { controller: realController, gfs } = await renderActualA01App([file], writeText)
    act(() => realController.current?.handleSelectChatAgent('agent-x', { selectLatest: false }))
    await waitFor(() =>
      expect(activeWorkspaceTab(realController.current!.workspaceTabs)?.kind).toBe('chat')
    )
    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /a01-real-controller\.txt/ })
    type Model = {
      invoked: boolean
      expectedClipboard: string | null
      expectedActiveKind: 'chat'
    }
    type Real = {
      scheduler: Scheduler
      invokeClickedCopy: () => Promise<void>
    }
    class InvokeCapturedCopy implements AsyncCommand<Model, Real> {
      check(model: Readonly<Model>) {
        return !model.invoked
      }

      async run(model: Model, real: Real) {
        await real.invokeClickedCopy()
        model.invoked = true
        model.expectedClipboard = file.gfsUri
      }

      toString() {
        return 'invoke Copy ID for the captured resource'
      }
    }
    const command = new InvokeCapturedCopy()
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.commands([fc.constant(command)], { maxCommands: 1, size: '+1' }),
        async (activeScheduler, commands) => {
          scheduler = activeScheduler
          const model: Model = {
            invoked: false,
            expectedClipboard: null,
            expectedActiveKind: 'chat',
          }
          const real: Real = {
            scheduler: activeScheduler,
            invokeClickedCopy: async () => {
              await chooseRowAction(file.name, 'Copy file ID')
              await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
              await activeScheduler.waitAll()
            },
          }
          const generatedCommands = [...commands]
          if (generatedCommands.length === 0) generatedCommands.push(command)
          await fc.asyncModelRun(() => ({ model, real }), generatedCommands)

          // Independent A4 oracle: the click target and owner contract define
          // the expected bytes and active surface, not App's dispatch code.
          expect(model.invoked).toBe(true)
          expect(model.expectedClipboard).toBe(file.gfsUri)
          expect(writeCalls).toEqual([file.gfsUri])
          expect(activeWorkspaceTab(realController.current!.workspaceTabs)?.kind).toBe(
            model.expectedActiveKind
          )
          expect(screen.queryAllByRole('dialog')).toHaveLength(0)
          expect(gfs.download).not.toHaveBeenCalled()
        }
      ),
      { numRuns: 1, seed: 281110 }
    )
  })

  it('A01 copies from the sidebar while an embedded app remains active', async () => {
    const file = await resolveResource(
      resolvedFile('17171717171717171717171717171717', 'a01-while-app-active.md')
    )
    const writeText = vi.fn(async (_text: string) => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const { controller } = await renderActualA01App([file], writeText)
    act(() => {
      controller.current?.setWorkspaceTabs(state =>
        openAppTab(state, { id: 'a01-app-tab', appRef: 'a01-test-app', title: 'A01 test app' })
      )
    })
    await waitFor(() =>
      expect(activeWorkspaceTab(controller.current!.workspaceTabs)).toMatchObject({
        kind: 'app',
        id: 'a01-app-tab',
      })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /a01-while-app-active\.md/ })

    await chooseRowAction(file.name, 'Copy file ID')
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(file.gfsUri))
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(activeWorkspaceTab(controller.current!.workspaceTabs)).toMatchObject({
      kind: 'app',
      id: 'a01-app-tab',
    })
    expect(screen.queryAllByRole('dialog')).toHaveLength(0)
  })

  it('A01 copies from the sidebar while Preview remains active', async () => {
    const file = await resolveResource(
      resolvedFile('20202020202020202020202020202020', 'a01-while-preview-active.md')
    )
    const writeText = vi.fn(async (_text: string) => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const { controller, gfs } = await renderActualA01App([file], writeText)
    act(() => {
      controller.current?.setWorkspaceTabs(state =>
        openPreviewTab(state, {
          id: 'a01-preview-tab',
          title: file.name,
          gfsUri: file.gfsUri,
          fileKind: 'markdown',
          mimeType: 'text/markdown',
          byteLength: 24,
          resourceVersion: file.version,
        })
      )
    })
    await waitFor(() =>
      expect(activeWorkspaceTab(controller.current!.workspaceTabs)).toMatchObject({
        kind: 'preview',
        id: 'a01-preview-tab',
      })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /a01-while-preview-active\.md/ })
    const downloadsBeforeCopy = gfs.download.mock.calls.length

    await chooseRowAction(file.name, 'Copy file ID')
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(file.gfsUri))
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(activeWorkspaceTab(controller.current!.workspaceTabs)).toMatchObject({
      kind: 'preview',
      id: 'a01-preview-tab',
    })
    expect(gfs.download).toHaveBeenCalledTimes(downloadsBeforeCopy)
    expect(screen.queryAllByRole('dialog')).toHaveLength(0)
  })

  it('A01 copies the exact clicked folder ID from the sidebar', async () => {
    const folder = await resolveResource(
      resolvedDirectory('21212121212121212121212121212121', 'a01-folder-target')
    )
    const writeText = vi.fn(async (_text: string) => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const { controller } = await renderActualA01App([folder], writeText)
    act(() => controller.current?.handleSelectChatAgent('agent-x', { selectLatest: false }))
    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /a01-folder-target/ })

    await chooseRowAction(folder.name, 'Copy folder ID')
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(folder.gfsUri))
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(controller.current?.toasts).toContainEqual(
      expect.objectContaining({ text: 'Folder ID copied', tone: 'success' })
    )
    expect(activeWorkspaceTab(controller.current!.workspaceTabs)?.kind).toBe('chat')
    expect(screen.queryAllByRole('dialog')).toHaveLength(0)
  })

  it('A01 model: A stays the clipboard target after selecting B', async () => {
    const resourceA = await resolveResource(
      resolvedFile('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'a01-a.txt')
    )
    const resourceB = await resolveResource(
      resolvedFile('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'a01-b.txt')
    )
    let scheduler!: Scheduler
    const writeCalls: string[] = []
    const settledValues: string[] = []
    const writeText = vi.fn(async (text: string) => {
      writeCalls.push(text)
      const settlement = scheduler.schedule(Promise.resolve(text), 'clipboard settlement')
      void settlement.then(value => settledValues.push(value))
      return settlement.then(() => undefined)
    })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const { controller, gfs } = await renderActualA01App([resourceA, resourceB], writeText)
    act(() => controller.current?.handleSelectChatAgent('agent-x', { selectLatest: false }))
    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /a01-a\.txt/ })
    await screen.findByRole('treeitem', { name: /a01-b\.txt/ })

    type Model = {
      copiedUri: string | null
      selectedUri: string | null
      invoked: boolean
    }
    type Real = {
      scheduler: Scheduler
      copyA: () => Promise<void>
      selectB: () => Promise<void>
    }
    class CopyClickedA implements AsyncCommand<Model, Real> {
      check(model: Readonly<Model>) {
        return model.copiedUri === null
      }

      async run(model: Model, real: Real) {
        await real.copyA()
        model.copiedUri = resourceA.gfsUri
        model.invoked = true
      }

      toString() {
        return 'click Copy ID on row A'
      }
    }
    class SelectB implements AsyncCommand<Model, Real> {
      check(model: Readonly<Model>) {
        return model.selectedUri === null
      }

      async run(model: Model, real: Real) {
        await real.selectB()
        model.selectedUri = resourceB.gfsUri
      }

      toString() {
        return 'select row B'
      }
    }
    const copyA = new CopyClickedA()
    const selectB = new SelectB()
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.commands([fc.constantFrom(copyA, selectB)], { maxCommands: 2, size: '+1' }),
        async (activeScheduler, generated) => {
          scheduler = activeScheduler
          const model: Model = { copiedUri: null, selectedUri: null, invoked: false }
          const real: Real = {
            scheduler: activeScheduler,
            copyA: async () => {
              await chooseRowAction(resourceA.name, 'Copy file ID')
              await waitFor(() => expect(writeCalls).toHaveLength(1))
            },
            selectB: async () => {
              fireEvent.click(await screen.findByRole('button', { name: resourceB.name }))
              await waitFor(() =>
                expect(activeWorkspaceTab(controller.current!.workspaceTabs)).toMatchObject({
                  kind: 'preview',
                  preview: { gfsUri: resourceB.gfsUri },
                })
              )
            },
          }
          const commands = [...generated]
          if (!commands.some(command => command instanceof CopyClickedA)) commands.push(copyA)
          if (!commands.some(command => command instanceof SelectB)) commands.push(selectB)
          await fc.asyncModelRun(() => ({ model, real }), commands)
          await activeScheduler.waitAll()

          // Independent event model: selected-row state and click-bound target
          // are distinct. The user event itself supplies the URI expectation.
          expect(model.copiedUri).toBe(resourceA.gfsUri)
          expect(model.selectedUri).toBe(resourceB.gfsUri)
          expect(model.invoked).toBe(true)
          expect(writeCalls).toEqual([resourceA.gfsUri])
          expect(settledValues).toEqual([resourceA.gfsUri])
          expect(gfs.download).not.toHaveBeenCalled()
          expect(screen.queryAllByRole('dialog')).toHaveLength(0)
        }
      ),
      { numRuns: 1, seed: 281111 }
    )
  })

  it.each([
    {
      outcome: 'fulfillment',
      write: async (_text: string) => undefined,
      toast: { text: 'File ID copied', tone: 'success' },
    },
    {
      outcome: 'rejection',
      write: async (_text: string) => {
        throw new Error('clipboard unavailable')
      },
      toast: { text: 'Could not copy the file ID: clipboard unavailable', tone: 'error' },
    },
  ])('A01 preserves Files feedback on clipboard $outcome', async ({ write, toast }) => {
    const file = await resolveResource(
      resolvedFile('cccccccccccccccccccccccccccccccc', 'a01-feedback.txt')
    )
    const writeText = vi.fn(write)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const { controller } = await renderActualA01App([file], writeText)
    act(() => controller.current?.handleSelectChatAgent('agent-x', { selectLatest: false }))
    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /a01-feedback\.txt/ })
    await chooseRowAction(file.name, 'Copy file ID')
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(controller.current?.toasts).toContainEqual(expect.objectContaining(toast))
    )
    expect(writeText).toHaveBeenCalledWith(file.gfsUri)
  })

  it('A01 cancels a queued copy before invocation after session revocation', async () => {
    const file = await resolveResource(
      resolvedFile('dddddddddddddddddddddddddddddddd', 'a01-before-logout.txt')
    )
    const writeText = vi.fn(async (_text: string) => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const { controller, gfs, sessionAuthority } = await renderActualA01App([file], writeText)
    act(() => controller.current?.handleSelectChatAgent('agent-x', { selectLatest: false }))
    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /a01-before-logout\.txt/ })
    const pendingPermission = deferred<Awaited<ReturnType<typeof resourceAffordances>>>()
    gfs.affordances.mockImplementation(async () => {
      return pendingPermission.promise
    })

    await chooseRowAction(file.name, 'Copy file ID')
    await waitFor(() => expect(gfs.affordances).toHaveBeenCalledWith(file.resourceId, 'main'))
    await act(async () => controller.current?.handleLogout())
    expect(sessionAuthority).toMatchObject({ authenticated: false, generation: 2 })
    await act(async () => pendingPermission.resolve(await resourceAffordances(['read'])))
    expect(writeText).not.toHaveBeenCalled()
    expect(controller.current?.toasts).not.toContainEqual(
      expect.objectContaining({ text: 'File ID copied', tone: 'success' })
    )
  })

  it('A01 leaves an invoked clipboard write to settle naturally after logout', async () => {
    const file = await resolveResource(
      resolvedFile('eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', 'a01-after-logout.txt')
    )
    const pendingClipboard = deferred<void>()
    const calls: string[] = []
    let settledText: string | null = null
    const writeText = vi.fn(async (text: string) => {
      calls.push(text)
      await pendingClipboard.promise
      settledText = text
    })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const { controller, sessionAuthority } = await renderActualA01App([file], writeText)
    act(() => controller.current?.handleSelectChatAgent('agent-x', { selectLatest: false }))
    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /a01-after-logout\.txt/ })

    await chooseRowAction(file.name, 'Copy file ID')
    await waitFor(() => expect(calls).toEqual([file.gfsUri]))
    await act(async () => controller.current?.handleLogout())
    expect(sessionAuthority).toMatchObject({ authenticated: false, generation: 2 })
    expect(settledText).toBeNull()
    await act(async () => {
      pendingClipboard.resolve()
      await pendingClipboard.promise
    })
    await waitFor(() => expect(settledText).toBe(file.gfsUri))
    expect(calls).toEqual([file.gfsUri])
  })

  it('A01 preserves rejection feedback when an invoked write rejects after logout', async () => {
    const file = await resolveResource(
      resolvedFile('eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', 'a01-after-logout-reject.txt')
    )
    const pendingClipboard = deferred<void>()
    const writeText = vi.fn(async (_text: string) => pendingClipboard.promise)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const { controller } = await renderActualA01App([file], writeText)
    act(() => controller.current?.handleSelectChatAgent('agent-x', { selectLatest: false }))
    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /a01-after-logout-reject\.txt/ })

    await chooseRowAction(file.name, 'Copy file ID')
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(file.gfsUri))
    await act(async () => controller.current?.handleLogout())
    await act(async () => {
      pendingClipboard.reject(new Error('clipboard interrupted'))
      await pendingClipboard.promise.catch(() => undefined)
    })
    await waitFor(() =>
      expect(controller.current?.toasts).toContainEqual(
        expect.objectContaining({
          text: 'Could not copy the file ID: clipboard interrupted',
          tone: 'error',
        })
      )
    )
    expect(controller.current?.toasts).not.toContainEqual(
      expect.objectContaining({ text: 'File ID copied', tone: 'success' })
    )
    expect(writeText).toHaveBeenCalledTimes(1)
  })

  it('A01 cancels a batched route request before its React commit', async () => {
    const file = await resolveResource(
      resolvedFile('ffffffffffffffffffffffffffffffff', 'a01-batched.txt')
    )
    const writeText = vi.fn(async (_text: string) => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const { controller } = await renderActualA01App([file], writeText)
    act(() => controller.current?.handleSelectChatAgent('agent-x', { selectLatest: false }))
    const chatTabId = controller.current!.workspaceTabs.activeTabId
    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /a01-batched\.txt/ })
    const menu = await openRowActions(file.name)
    fireEvent.mouseEnter(within(menu).getByRole('menuitem', { name: 'Share' }))
    const shareMenu = await screen.findByRole('menu', { name: `Share options for ${file.name}` })
    const copyAction = within(shareMenu).getByRole('menuitem', { name: 'Copy file ID' })

    // A no-route copy request and a subsequent navigation intent share one
    // React batch. The intent change must cancel the pending pre-invocation copy.
    act(() => {
      fireEvent.click(copyAction)
      expect(controller.current?.selectWorkspaceTabById(chatTabId!)).toBe(true)
    })
    await waitFor(() =>
      expect(activeWorkspaceTab(controller.current!.workspaceTabs)?.kind).toBe('chat')
    )
    await waitFor(() => expect(appHarness.filesPageLatestPendingAction).toBeNull())
    expect(writeText).not.toHaveBeenCalled()
    expect(screen.queryAllByRole('dialog')).toHaveLength(0)
  })

  it('A01 keeps Copy ID eligible for an unreadable resource', async () => {
    const file = await resolveResource(
      resolvedFile('11111111111111111111111111111111', 'a01-unreadable.txt')
    )
    const writeText = vi.fn(async (_text: string) => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const { controller, gfs } = await renderActualA01App([file], writeText, { readable: false })
    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /a01-unreadable\.txt/ })

    await chooseRowAction(file.name, 'Copy file ID')
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(file.gfsUri))
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(gfs.download).not.toHaveBeenCalled()
    expect(screen.queryAllByRole('dialog')).toHaveLength(0)
    expect(activeWorkspaceTab(controller.current!.workspaceTabs)?.kind).toBe('chat')
  })

  it('A01 rejects a clicked row removed from the live parent cache', async () => {
    const file = await resolveResource(
      resolvedFile('13131313131313131313131313131313', 'a01-removed-row.txt')
    )
    const writeText = vi.fn(async (_text: string) => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const { controller } = await renderActualA01App([file], writeText)
    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /a01-removed-row\.txt/ })
    const menu = await openRowActions(file.name)
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Share' }))
    const shareMenu = await screen.findByRole('menu', { name: `Share options for ${file.name}` })
    const copyAction = within(shareMenu).getByRole('menuitem', { name: 'Copy file ID' })
    const emptyPage = await listAccessiblePage([])

    act(() => {
      desktopQueryClient.setQueryData(
        desktopQueryKeys.gfsAccessible('a01-environment:a01-user:team-a', 'main', 1),
        { pages: [emptyPage], pageParams: [undefined] }
      )
      fireEvent.click(copyAction)
    })

    await waitFor(() =>
      expect(controller.current?.toasts).toContainEqual(
        expect.objectContaining({
          text: 'This resource is no longer available from its parent folder.',
          tone: 'error',
        })
      )
    )
    expect(writeText).not.toHaveBeenCalled()
    expect(activeWorkspaceTab(controller.current!.workspaceTabs)?.kind).toBe('chat')
  })

  it('A01 waits for the existing permission producer before writing', async () => {
    const file = await resolveResource(
      resolvedFile('14141414141414141414141414141414', 'a01-permission-pending.txt')
    )
    const pendingPermission = deferred<Awaited<ReturnType<typeof resourceAffordances>>>()
    const writeText = vi.fn(async (_text: string) => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const { controller, gfs } = await renderActualA01App([file], writeText)
    gfs.affordances.mockImplementation(async () => pendingPermission.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /a01-permission-pending\.txt/ })
    await chooseRowAction(file.name, 'Copy file ID')
    await waitFor(() => expect(gfs.affordances).toHaveBeenCalledTimes(1))
    expect(writeText).not.toHaveBeenCalled()

    await act(async () => pendingPermission.resolve(await resourceAffordances(['read'])))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(file.gfsUri))
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(activeWorkspaceTab(controller.current!.workspaceTabs)?.kind).toBe('chat')
  })

  it('A01 reports an existing authority error without invoking the clipboard', async () => {
    const file = await resolveResource(
      resolvedFile('22222222222222222222222222222222', 'a01-authority-error.txt')
    )
    const writeText = vi.fn(async (_text: string) => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const { controller, gfs } = await renderActualA01App([file], writeText)
    gfs.affordances.mockRejectedValue(
      new Error(
        "Error invoking remote method 'gfs:affordances': Error: gfs download failed: 429: " +
          'Too Many Requests retryAfterSeconds=7'
      )
    )
    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /a01-authority-error\.txt/ })

    await chooseRowAction(file.name, 'Copy file ID')
    await waitFor(() =>
      expect(controller.current?.toasts).toContainEqual(
        expect.objectContaining({
          text:
            'Could not verify permissions for a01-authority-error.txt: ' +
            'Too many file requests — try again in 7s.',
          tone: 'error',
        })
      )
    )
    expect(writeText).not.toHaveBeenCalled()
  })

  it('A01 rejects an old menu callback after synchronous session revocation', async () => {
    const file = await resolveResource(
      resolvedFile('15151515151515151515151515151515', 'a01-old-session.txt')
    )
    const writeText = vi.fn(async (_text: string) => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const { controller, clerum } = await renderActualA01App([file], writeText)
    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    const menu = await openRowActions(file.name)
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Share' }))
    const shareMenu = await screen.findByRole('menu', { name: `Share options for ${file.name}` })
    const copyAction = within(shareMenu).getByRole('menuitem', { name: 'Copy file ID' })
    const authBridge = clerum as unknown as {
      auth: { onExternalLogout: ReturnType<typeof vi.fn> }
    }
    const onExternalLogout = authBridge.auth.onExternalLogout.mock.calls.at(-1)?.[0] as
      | (() => void)
      | undefined

    expect(onExternalLogout).toBeTypeOf('function')
    act(() => {
      onExternalLogout?.()
      fireEvent.click(copyAction)
    })

    expect(writeText).not.toHaveBeenCalled()
    expect(controller.current?.isAuthenticated).toBe(false)
  })

  it('A01 rejects a stale generation before React publishes the replacement session', async () => {
    const file = await resolveResource(
      resolvedFile('18181818181818181818181818181818', 'a01-generation-replaced.txt')
    )
    const writeText = vi.fn(async (_text: string) => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const { controller, sessionAuthority } = await renderActualA01App([file], writeText)
    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    const menu = await openRowActions(file.name)
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Share' }))
    const shareMenu = await screen.findByRole('menu', { name: `Share options for ${file.name}` })
    const copyAction = within(shareMenu).getByRole('menuitem', { name: 'Copy file ID' })
    await waitFor(() =>
      expect(
        desktopQueryClient.getQueryData(
          desktopQueryKeys.gfsAffordances(
            'a01-environment:a01-user:team-a',
            file.resourceId,
            'main',
            1
          )
        )
      ).toBeTruthy()
    )
    sessionAuthority.generation = 2

    await act(async () => {
      const loading = controller.current!.loadSession({ preserveNav: true })
      for (
        let turn = 0;
        turn < 10 && controller.current!.isSessionGenerationCurrent(1);
        turn += 1
      ) {
        await Promise.resolve()
      }
      expect(controller.current!.isSessionGenerationCurrent(1)).toBe(false)
      expect(controller.current?.isAuthenticated).toBe(true)
      expect(
        desktopQueryClient.getQueryData(
          desktopQueryKeys.gfsAccessible('a01-environment:a01-user:team-a', 'main', 1)
        )
      ).toBeTruthy()
      expect(
        desktopQueryClient.getQueryState(
          desktopQueryKeys.gfsAffordances(
            'a01-environment:a01-user:team-a',
            file.resourceId,
            'main',
            1
          )
        )?.status
      ).toBe('success')
      expect(
        controller.current!.isNavigationIntentCurrent(controller.current!.navigationIntentSequence)
      ).toBe(true)
      fireEvent.click(copyAction)
      await loading
    })

    expect(writeText).not.toHaveBeenCalled()
    expect(controller.current?.sessionGeneration).toBe(2)
  })

  it('A01 rejects a stale row callback during the real team-switch generation gap', async () => {
    const file = await resolveResource(
      resolvedFile('19191919191919191919191919191919', 'a01-team-switch-gap.txt')
    )
    const writeText = vi.fn(async (_text: string) => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const { controller, clerum } = await renderActualA01App([file], writeText)
    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    const menu = await openRowActions(file.name)
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Share' }))
    const shareMenu = await screen.findByRole('menu', { name: `Share options for ${file.name}` })
    const copyAction = within(shareMenu).getByRole('menuitem', { name: 'Copy file ID' })
    await waitFor(() =>
      expect(
        desktopQueryClient.getQueryData(
          desktopQueryKeys.gfsAffordances(
            'a01-environment:a01-user:team-a',
            file.resourceId,
            'main',
            1
          )
        )
      ).toBeTruthy()
    )
    const teamBridge = clerum as unknown as {
      team: { switch: ReturnType<typeof vi.fn> }
    }
    const teamSwitch = deferred<{
      authenticated: true
      me: NonNullable<AppController['me']>
      sessionGeneration: number
    }>()
    teamBridge.team.switch.mockReturnValue(teamSwitch.promise)

    await act(async () => {
      const switching = controller.current!.handleEnsureTeamContext({ teamId: 'team-b' })
      teamSwitch.resolve({
        authenticated: true,
        me: { ...controller.current!.me!, teamId: 'team-b', teamName: 'team-b' },
        sessionGeneration: 2,
      })
      for (
        let turn = 0;
        turn < 20 && controller.current!.isSessionGenerationCurrent(1);
        turn += 1
      ) {
        await Promise.resolve()
      }
      expect(controller.current!.isSessionGenerationCurrent(1)).toBe(false)
      expect(controller.current?.isAuthenticated).toBe(true)
      expect(controller.current?.me?.teamId).toBe('team-a')
      expect(copyAction.isConnected).toBe(true)
      fireEvent.click(copyAction)
      await switching
    })

    expect(writeText).not.toHaveBeenCalled()
  })

  it('A01 cancels a pending copy when a new tab intent commits', async () => {
    const file = await resolveResource(
      resolvedFile('16161616161616161616161616161616', 'a01-navigation-pending.txt')
    )
    const pendingPermission = deferred<Awaited<ReturnType<typeof resourceAffordances>>>()
    const writeText = vi.fn(async (_text: string) => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const { controller, gfs } = await renderActualA01App([file], writeText)
    gfs.affordances.mockImplementation(async () => pendingPermission.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /a01-navigation-pending\.txt/ })
    await chooseRowAction(file.name, 'Copy file ID')
    await waitFor(() => expect(gfs.affordances).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByTestId('nav-files'))
    await waitFor(() =>
      expect(activeWorkspaceTab(controller.current!.workspaceTabs)?.kind).toBe('files')
    )
    await act(async () => pendingPermission.resolve(await resourceAffordances(['read'])))

    expect(writeText).not.toHaveBeenCalled()
    expect(controller.current?.toasts).not.toContainEqual(
      expect.objectContaining({ text: 'File ID copied', tone: 'success' })
    )
  })

  it('A01 limits clipboard effects to one per accepted click', async () => {
    const file = await resolveResource(
      resolvedFile('12121212121212121212121212121212', 'a01-repeat.txt')
    )
    const writeText = vi.fn(async (_text: string) => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const { gfs } = await renderActualA01App([file], writeText)
    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /a01-repeat\.txt/ })

    await chooseRowAction(file.name, 'Copy file ID')
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    await chooseRowAction(file.name, 'Copy file ID')
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2))
    expect(writeText.mock.calls.map(([uri]) => uri)).toEqual([file.gfsUri, file.gfsUri])
    expect(gfs.download).not.toHaveBeenCalled()
    expect(screen.queryAllByRole('dialog')).toHaveLength(0)
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
      files: { path: file.gfsUri },
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
      files: { path: file.gfsUri },
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
