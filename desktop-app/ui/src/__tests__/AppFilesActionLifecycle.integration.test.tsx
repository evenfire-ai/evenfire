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
import userEvent from '@testing-library/user-event'
import fc, { type AsyncCommand, type Scheduler } from 'fast-check'
import {
  assertD5a,
  d5aRevokeRetrySensitivityControl,
  d5aSensitivityControl,
  d5bExpectedOutcome,
  initialD5a,
  transitionD5a,
} from '@components/SidebarNav/FileExplorerTree/sidebar-context-menu-a4-reference'
import { DESKTOP_ROUTES } from '@constants/navigation'
import { installAppControllerClerum } from '@hooks/domain/__tests__/__fixtures__/appControllerHarness'
import { installMockClerum } from '@hooks/domain/__tests__/__fixtures__/mockClerum'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
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
  openAppTab,
  openChatTab,
  openFilesTab,
  openPreviewTab,
  openSettingsTab,
  selectWorkspaceTab,
} from '@lib/workspaceTabs'
import { mapKindToRoute, settingsSectionForRoute } from '@lib/workspaceTabsRoute'
import { App } from '@/App'
import type { GfsResourceDeepLinkEnvelope } from '@/App.types'
import {
  accessibleResource,
  childView,
  downloadResult,
  gfsRouteFailureMessage,
  listAccessiblePage,
  listChildrenPage,
  previewDownloadResult,
  resolveResource,
  resolvedDirectory,
  resolvedFile,
  resourceAffordances,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
import { listChildrenPaged } from '../../../../control-api/src/gfs/tree.js'
import { type A01A4Input, evaluateA01A4 } from '../test-utils/a01CopyIdR17A4Oracle'

type AppController = ReturnType<typeof useAppController>
type WorkspaceState = AppController['workspaceTabs']
type WorkspaceStateUpdater = WorkspaceState | ((state: WorkspaceState) => WorkspaceState)
type PushToast = NonNullable<AppController['pushToast']>
type GfsAffordances = typeof window.clerum.gfs.affordances
type GfsAffordancesMock = {
  getMockImplementation: () => GfsAffordances | undefined
  mockImplementation: (implementation: GfsAffordances) => unknown
  mock: { calls: Parameters<GfsAffordances>[] }
}

function recordedToastCalls(): Parameters<PushToast>[] {
  const pushToast = appHarness.controller.pushToast as unknown as {
    mock: { calls: Parameters<PushToast>[] }
  }
  return pushToast.mock.calls
}

function affordanceMock(gfs: { affordances: unknown }): GfsAffordancesMock {
  return gfs.affordances as GfsAffordancesMock
}

const appHarness = vi.hoisted(() => ({
  controller: null as unknown as AppController,
  useRealNavigationController: false,
  forceRender: () => {},
  shortcutCommand: null as unknown as (commandId: string, source: 'host' | 'sandbox') => void,
  shortcutRegistrationCount: 0,
  lastShortcutCommand: null as string | null,
  filesPagePendingActions: [] as unknown[],
  filesPageLatestPendingAction: null as unknown,
  filesPageCurrentnessById: new Map<number, (requestId: number) => boolean>(),
  filesPageResourceByRequestId: new Map<number, string>(),
  filesPageHandledEvents: [] as Array<{
    id: number
    resourceUri: string | null
    permissionSettled: boolean
  }>,
  d5aPermissionSettledUris: new Set<string>(),
  d5aPostPermissionAckIds: new Set<number>(),
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
  emitGfsDeepLink: null as ((link: GfsResourceDeepLinkEnvelope) => void) | null,
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
        appHarness.filesPageResourceByRequestId.set(
          props.pendingResourceAction.id,
          props.pendingResourceAction.targetUri
        )
        if (props.isPendingResourceActionCurrent) {
          appHarness.filesPageCurrentnessById.set(
            props.pendingResourceAction.id,
            props.isPendingResourceActionCurrent
          )
        }
      }
      return (
        <actual.FilesPage
          {...props}
          onLocationChange={(gfsUri, name) => {
            appHarness.filesPageLastLocation = { gfsUri, name }
            props.onLocationChange?.(gfsUri, name)
          }}
          onPendingResourceActionHandled={requestId => {
            const resourceUri = appHarness.filesPageResourceByRequestId.get(requestId) ?? null
            const permissionSettled = resourceUri
              ? appHarness.d5aPermissionSettledUris.has(resourceUri)
              : false
            appHarness.filesPageHandledEvents.push({
              id: requestId,
              resourceUri,
              permissionSettled,
            })
            if (permissionSettled) appHarness.d5aPostPermissionAckIds.add(requestId)
            props.onPendingResourceActionHandled?.(requestId)
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
    onDeepLink: vi.fn((listener: (link: GfsResourceDeepLinkEnvelope) => void) => {
      appHarness.emitGfsDeepLink = listener
      return vi.fn()
    }),
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

function holdExactTargetResolve(
  gfs: ReturnType<typeof installClerum>['gfs'],
  targetUri: string,
  pending: Deferred<unknown>
) {
  const originalResolve = gfs.resolve.getMockImplementation()
  if (!originalResolve) throw new Error('Expected the GFS resolve boundary mock')
  gfs.resolve.mockClear()
  gfs.resolve.mockImplementation(uri =>
    uri === targetUri ? pending.promise : originalResolve(uri)
  )
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
  options: {
    readable?: boolean
    accessibleRows?: ReturnType<typeof accessibleResource>[]
    operatorRootResourceId?: string
    childRowsByParent?: Map<string, ReturnType<typeof childView>[]>
  } = {}
) {
  const byUri = new Map(resources.map(resource => [resource.gfsUri, resource]))
  const accessiblePage = await listAccessiblePage(
    options.accessibleRows ??
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
  const accessPage = options.operatorRootResourceId
    ? {
        ...accessiblePage,
        rootResourceId: options.operatorRootResourceId,
        view: 'operator' as const,
      }
    : accessiblePage
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
    listChildren: vi.fn(
      async (resourceId: string) =>
        await listChildrenPage(options.childRowsByParent?.get(resourceId) ?? [])
    ),
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
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Share' }))
    await screen.findByRole('menu', { name: `Share options for ${resourceName}` })
  }
  fireEvent.click(await screen.findByRole('menuitem', { name: actionName }))
}

async function chooseRowActionByKeyboard(resourceName: string, actionName: string) {
  const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  const clipboardWriteText = clipboardDescriptor?.value?.writeText as
    | Clipboard['writeText']
    | undefined
  const user = userEvent.setup()
  if (clipboardDescriptor) {
    Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
  } else {
    Reflect.deleteProperty(navigator, 'clipboard')
  }
  if (clipboardWriteText) expect(navigator.clipboard.writeText).toBe(clipboardWriteText)
  const menu = await openRowActions(resourceName)
  const shareTrigger = within(menu).getByRole('menuitem', { name: 'Share' })
  shareTrigger.focus()
  await user.keyboard('{ArrowRight}')
  const submenu = await screen.findByRole('menu', { name: `Share options for ${resourceName}` })
  const submenuItems = within(submenu).getAllByRole('menuitem')
  const targetIndex = submenuItems.findIndex(item => item.textContent?.trim() === actionName)
  if (targetIndex < 0) throw new Error(`Keyboard submenu action is unavailable: ${actionName}`)
  for (let index = 0; index <= submenuItems.length; index += 1) {
    if (document.activeElement === submenuItems[targetIndex]) break
    await user.keyboard('{ArrowDown}')
  }
  await waitFor(() => expect(document.activeElement).toBe(submenuItems[targetIndex]))
  await user.keyboard('{Enter}')
  await waitFor(() =>
    expect(screen.queryByRole('menu', { name: `Actions for ${resourceName}` })).toBeNull()
  )
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
  appHarness.filesPageResourceByRequestId.clear()
  appHarness.filesPageHandledEvents = []
  appHarness.d5aPermissionSettledUris.clear()
  appHarness.d5aPostPermissionAckIds.clear()
  appHarness.filesPageCurrentnessById.clear()
  appHarness.filesPageRenderCount = 0
  appHarness.filesPageLastLocation = null
  appHarness.filesPageReportLocation = null
  appHarness.previewPagePendingActions = []
  appHarness.sandboxUiShortcutAppRef = null
  appHarness.latestConversationNotification = null
  appHarness.emitGfsDeepLink = null
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

  it.each([
    { kind: 'file', action: 'Copy file ID', name: 'a01-shared-root-file.md' },
    { kind: 'folder', action: 'Copy folder ID', name: 'a01-shared-root-folder' },
  ])(
    'A01 copies an accessible root $kind with parent metadata while an embedded app remains active',
    async ({ kind, action, name }) => {
      const parentResourceId = 'abababababababababababababababab'
      const resource = await resolveResource(
        kind === 'file'
          ? resolvedFile('18181818181818181818181818181818', name, { parentResourceId })
          : resolvedDirectory('18181818181818181818181818181818', name, { parentResourceId })
      )
      const writeText = vi.fn(async (_text: string) => undefined)
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText },
      })
      const { controller, gfs } = await renderActualA01App([resource], writeText)
      const scope = 'a01-environment:a01-user:team-a'
      const accessibleKey = desktopQueryKeys.gfsAccessible(scope, 'main', 1)
      const parentChildrenKey = desktopQueryKeys.gfsChildren(scope, parentResourceId, 'main', 1)

      act(() => {
        controller.current?.setWorkspaceTabs(state =>
          openAppTab(state, {
            id: 'a01-shared-app-tab',
            appRef: 'a01-test-app',
            title: 'A01 test app',
          })
        )
      })
      await waitFor(() =>
        expect(activeWorkspaceTab(controller.current!.workspaceTabs)).toMatchObject({
          kind: 'app',
          id: 'a01-shared-app-tab',
        })
      )
      fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
      await screen.findByRole('treeitem', { name: new RegExp(name) })
      await waitFor(() => {
        expect(gfs.listAccessible).toHaveBeenCalled()
        expect(
          desktopQueryClient.getQueryCache().find({ queryKey: accessibleKey })?.state.data
        ).toBeDefined()
      })
      expect(
        desktopQueryClient.getQueryCache().find({ queryKey: parentChildrenKey })
      ).toBeUndefined()
      await chooseRowAction(resource.name, action)

      expect(gfs.affordances).toHaveBeenCalledWith(resource.resourceId, 'main')
      expect.soft(writeText).toHaveBeenCalledWith(resource.gfsUri)
      expect.soft(writeText).toHaveBeenCalledTimes(1)
      expect.soft(controller.current?.toasts).not.toContainEqual(
        expect.objectContaining({
          text: 'This resource is no longer available from its parent folder.',
          tone: 'error',
        })
      )
      expect(activeWorkspaceTab(controller.current!.workspaceTabs)).toMatchObject({
        kind: 'app',
        id: 'a01-shared-app-tab',
      })
      expect(screen.queryAllByRole('dialog')).toHaveLength(0)
      expect(gfs.download).not.toHaveBeenCalled()
    }
  )

  it.each(['settings', 'files'] as const)(
    'A01 copies the same accessible root file with parent metadata while %s is active',
    async surface => {
      const resource = await resolveResource(
        resolvedFile('19191919191919191919191919191919', `a01-root-${surface}.md`, {
          parentResourceId: 'abababababababababababababababab',
        })
      )
      const writeText = vi.fn(async (_text: string) => undefined)
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText },
      })
      const { controller } = await renderActualA01App([resource], writeText)

      if (surface === 'settings') {
        fireEvent.click(screen.getByTestId('nav-settings-menu'))
        fireEvent.click(screen.getByTestId('nav-settings'))
      } else {
        fireEvent.click(screen.getByTestId('nav-files'))
      }
      await waitFor(() =>
        expect(activeWorkspaceTab(controller.current!.workspaceTabs)?.kind).toBe(surface)
      )
      const ownerTabId = activeWorkspaceTab(controller.current!.workspaceTabs)!.id
      const explorerToggle = screen.getByTestId('nav-files-explorer-toggle')
      if (explorerToggle.getAttribute('aria-expanded') !== 'true') {
        fireEvent.click(explorerToggle)
      }
      await screen.findByRole('treeitem', { name: /a01-root-/ })

      await chooseRowAction(resource.name, 'Copy file ID')

      await waitFor(() => expect(writeText).toHaveBeenCalledWith(resource.gfsUri))
      expect(writeText).toHaveBeenCalledTimes(1)
      expect(activeWorkspaceTab(controller.current!.workspaceTabs)).toMatchObject({
        kind: surface,
        id: ownerTabId,
      })
      expect(
        controller.current?.toasts.some(
          toast => toast.text === 'This resource is no longer available from its parent folder.'
        )
      ).toBe(false)
      expect(screen.queryAllByRole('dialog')).toHaveLength(0)
    }
  )

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
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Share' }))
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

  it('A01 model probe: same URI identity with refreshed version remains copyable', async () => {
    const file = await resolveResource(
      resolvedFile('abababababababababababababababab', 'a01-version-v0.txt')
    )
    const pendingPermission = deferred<Awaited<ReturnType<typeof resourceAffordances>>>()
    const writeText = vi.fn(async (_text: string) => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const { controller, gfs } = await renderActualA01App([file], writeText)
    const invalidate = vi.spyOn(desktopQueryClient, 'invalidateQueries')
    gfs.affordances.mockImplementation(async () => pendingPermission.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /a01-version-v0\.txt/ })
    await chooseRowAction(file.name, 'Copy file ID')
    await waitFor(() => expect(gfs.affordances).toHaveBeenCalledTimes(1))

    const refreshedPage = await listAccessiblePage([
      accessibleResource(file.resourceId, 'a01-version-v1.txt', 'file', {
        gfsUri: file.gfsUri,
        parentResourceId: file.parentResourceId,
        version: file.version + 1,
      }),
    ])
    act(() => {
      desktopQueryClient.setQueryData(
        desktopQueryKeys.gfsAccessible('a01-environment:a01-user:team-a', 'main', 1),
        { pages: [refreshedPage], pageParams: [undefined] }
      )
    })
    await act(async () => pendingPermission.resolve(await resourceAffordances(['read'])))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(file.gfsUri))
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(invalidate).not.toHaveBeenCalled()
    expect(controller.current?.toasts).not.toContainEqual(
      expect.objectContaining({
        text: 'This resource is no longer available from its parent folder.',
      })
    )
    expect(activeWorkspaceTab(controller.current!.workspaceTabs)?.kind).toBe('chat')
  })

  it('A01 model probe: changed URI is rejected and refreshes its exact parent query once', async () => {
    const file = await resolveResource(
      resolvedFile('acacacacacacacacacacacacacacacac', 'a01-uri-v0.txt', {
        parentResourceId: 'abababababababababababababababab',
      })
    )
    const pendingPermission = deferred<Awaited<ReturnType<typeof resourceAffordances>>>()
    const writeText = vi.fn(async (_text: string) => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const { controller, gfs } = await renderActualA01App([file], writeText)
    const queryKey = desktopQueryKeys.gfsAccessible('a01-environment:a01-user:team-a', 'main', 1)
    const invalidate = vi.spyOn(desktopQueryClient, 'invalidateQueries')
    gfs.affordances.mockImplementation(async () => pendingPermission.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /a01-uri-v0\.txt/ })
    await chooseRowAction(file.name, 'Copy file ID')
    await waitFor(() => expect(gfs.affordances).toHaveBeenCalledTimes(1))

    const changedUri = `gfs://main/${'cd'.repeat(16)}`
    const changedPage = await listAccessiblePage([
      accessibleResource(file.resourceId, file.name, 'file', {
        gfsUri: changedUri,
        parentResourceId: file.parentResourceId,
        version: file.version + 1,
      }),
    ])
    act(() =>
      desktopQueryClient.setQueryData(queryKey, { pages: [changedPage], pageParams: [undefined] })
    )
    await act(async () => pendingPermission.resolve(await resourceAffordances(['read'])))

    await waitFor(() =>
      expect(controller.current?.toasts).toContainEqual(
        expect.objectContaining({
          text: 'This resource is no longer available from its parent folder.',
          tone: 'error',
        })
      )
    )
    expect(writeText).not.toHaveBeenCalled()
    expect(invalidate).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey, exact: true, refetchType: 'active' }),
      expect.anything()
    )
    expect(invalidate).toHaveBeenCalledTimes(1)
  })

  it.each([
    {
      field: 'resource ID',
      row: (file: Awaited<ReturnType<typeof resolveResource>>) =>
        accessibleResource('ea'.repeat(16), file.name, 'file', {
          gfsUri: file.gfsUri,
          parentResourceId: file.parentResourceId,
          version: file.version,
        }),
    },
    {
      field: 'kind',
      row: (file: Awaited<ReturnType<typeof resolveResource>>) =>
        accessibleResource(file.resourceId, file.name, 'directory', {
          gfsUri: file.gfsUri,
          parentResourceId: file.parentResourceId,
          version: file.version,
        }),
    },
    {
      field: 'parent binding',
      row: (file: Awaited<ReturnType<typeof resolveResource>>, otherParentId: string) =>
        accessibleResource(file.resourceId, file.name, 'file', {
          gfsUri: file.gfsUri,
          parentResourceId: otherParentId,
          version: file.version,
        }),
    },
  ])('A01 r17 rejects a changed $field without substituting the clicked URI', async testCase => {
    const file = await resolveResource(
      resolvedFile('ec'.repeat(16), `a01-binding-${testCase.field.replaceAll(' ', '-')}.txt`)
    )
    const otherParent = await resolveResource(resolvedDirectory('ed'.repeat(16), 'other-parent'))
    const replacement = testCase.row(file, otherParent.resourceId)
    const mismatchedPage = await listAccessiblePage([replacement])
    const pendingPermission = deferred<Awaited<ReturnType<typeof resourceAffordances>>>()
    const writeText = vi.fn(async (_text: string) => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const { controller, gfs } = await renderActualA01App([file], writeText)
    const queryKey = desktopQueryKeys.gfsAccessible('a01-environment:a01-user:team-a', 'main', 1)
    const invalidate = vi.spyOn(desktopQueryClient, 'invalidateQueries')
    gfs.affordances.mockImplementation(async () => pendingPermission.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await findResourceTreeRow(file.name)
    await chooseRowAction(file.name, 'Copy file ID')
    await waitFor(() => expect(gfs.affordances).toHaveBeenCalledTimes(1))

    act(() =>
      desktopQueryClient.setQueryData(queryKey, {
        pages: [mismatchedPage],
        pageParams: [undefined],
      })
    )
    await act(async () => pendingPermission.resolve(await resourceAffordances(['read'])))

    await waitFor(() =>
      expect(controller.current?.toasts).toContainEqual(
        expect.objectContaining({
          text: 'This resource is no longer available from its parent folder.',
          tone: 'error',
        })
      )
    )
    expect(writeText).not.toHaveBeenCalled()
    expect(invalidate).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey, exact: true, refetchType: 'active' }),
      expect.anything()
    )
    expect(invalidate).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(desktopQueryClient.isFetching({ queryKey, exact: true })).toBe(0))
  })

  it('A01 H1: linked-admin operator root Copy ID accepts omitted parent metadata', async () => {
    const id = 'c4'.repeat(16)
    const file = await resolveResource(resolvedFile(id, 'a01-operator-root.txt'))
    const operatorPage = await listChildrenPaged(
      {
        listChildren: async () => [
          {
            resourceId: id,
            name: file.name,
            kind: 'file',
            pathCache: `/${file.name}`,
            bytes: 4,
            version: 1,
            updatedAt: '2026-11-13T00:00:00.000Z',
          },
        ],
      },
      'main',
      'operator-root',
      { limit: 20 }
    )
    const rawOperatorRoot = operatorPage.items[0]
    expect(rawOperatorRoot).toBeDefined()
    expect(rawOperatorRoot).not.toHaveProperty('parentResourceId')
    const writeText = vi.fn(async (_uri: string) => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const invalidate = vi.spyOn(desktopQueryClient, 'invalidateQueries')
    const { controller } = await renderActualA01App([file], writeText, {
      accessibleRows: [rawOperatorRoot as unknown as ReturnType<typeof accessibleResource>],
      operatorRootResourceId: 'c5'.repeat(16),
    })
    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await findResourceTreeRow(file.name)
    const toggle = screen.getByRole('button', { name: 'Collapse file explorer' })
    const focusToggle = vi.spyOn(toggle, 'focus')

    await chooseRowAction(file.name, 'Copy file ID')
    await act(async () => Promise.resolve())

    expect(writeText).toHaveBeenCalledOnce()
    expect(writeText).toHaveBeenCalledWith(file.gfsUri)
    expect(controller.current?.toasts).not.toContainEqual(
      expect.objectContaining({
        text: 'This resource is no longer available from its parent folder.',
        tone: 'error',
      })
    )
    expect(invalidate).not.toHaveBeenCalled()
    expect(focusToggle).not.toHaveBeenCalled()
  })

  it('A01 model probe: changed child URI refreshes only its exact parent query once', async () => {
    const parent = await resolveResource(resolvedDirectory('ce'.repeat(16), 'a01-child-parent'))
    const file = await resolveResource(
      resolvedFile('cf'.repeat(16), 'a01-child-v0.txt', {
        parentResourceId: parent.resourceId,
      })
    )
    const clickedRow = childView(file.resourceId, file.name, 'file', {
      gfsUri: file.gfsUri,
      parentResourceId: parent.resourceId,
      version: file.version,
    })
    const pendingPermission = deferred<Awaited<ReturnType<typeof resourceAffordances>>>()
    const writeText = vi.fn(async (_text: string) => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const { controller, gfs } = await renderActualA01App([parent, file], writeText, {
      accessibleRows: [
        accessibleResource(parent.resourceId, parent.name, 'directory', {
          gfsUri: parent.gfsUri,
          parentResourceId: null,
          version: parent.version,
        }),
      ],
      childRowsByParent: new Map([[parent.resourceId, [clickedRow]]]),
    })
    const queryKey = desktopQueryKeys.gfsChildren(
      'a01-environment:a01-user:team-a',
      parent.resourceId,
      'main',
      1
    )
    const invalidate = vi.spyOn(desktopQueryClient, 'invalidateQueries')
    gfs.affordances.mockImplementation(async () => pendingPermission.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    const parentRow = await screen.findByRole('treeitem', { name: /a01-child-parent/ })
    fireEvent.click(within(parentRow).getByRole('button', { name: /Expand a01-child-parent/ }))
    await waitFor(() => expect(gfs.listChildren).toHaveBeenCalled())
    await findResourceTreeRow(file.name)
    await chooseRowAction(file.name, 'Copy file ID')
    await waitFor(() => expect(gfs.affordances).toHaveBeenCalledTimes(1))

    const changedRow = childView(file.resourceId, file.name, 'file', {
      gfsUri: `gfs://main/${'d0'.repeat(16)}`,
      parentResourceId: parent.resourceId,
      version: file.version + 1,
    })
    const changedPage = await listChildrenPage([changedRow])
    act(() =>
      desktopQueryClient.setQueryData(queryKey, { pages: [changedPage], pageParams: [undefined] })
    )
    await act(async () => pendingPermission.resolve(await resourceAffordances(['read'])))

    await waitFor(() =>
      expect(controller.current?.toasts).toContainEqual(
        expect.objectContaining({
          text: 'This resource is no longer available from its parent folder.',
          tone: 'error',
        })
      )
    )
    expect(writeText).not.toHaveBeenCalled()
    expect(invalidate).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey, exact: true, refetchType: 'active' }),
      expect.anything()
    )
    expect(invalidate).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(gfs.listChildren).toHaveBeenCalledTimes(2))
    expect(activeWorkspaceTab(controller.current!.workspaceTabs)?.kind).toBe('chat')
  })

  it('A01 D4: focuses the explorer toggle before a mismatch refetch removes the row', async () => {
    const parent = await resolveResource(resolvedDirectory('d1'.repeat(16), 'a01-focus-parent'))
    const file = await resolveResource(
      resolvedFile('d2'.repeat(16), 'a01-focus-child.txt', {
        parentResourceId: parent.resourceId,
      })
    )
    const clickedRow = childView(file.resourceId, file.name, 'file', {
      gfsUri: file.gfsUri,
      parentResourceId: parent.resourceId,
      version: file.version,
    })
    const pendingPermission = deferred<Awaited<ReturnType<typeof resourceAffordances>>>()
    const writeText = vi.fn(async (_text: string) => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const { controller, gfs } = await renderActualA01App([parent, file], writeText, {
      accessibleRows: [
        accessibleResource(parent.resourceId, parent.name, 'directory', {
          gfsUri: parent.gfsUri,
          parentResourceId: null,
          version: parent.version,
        }),
      ],
      childRowsByParent: new Map([[parent.resourceId, [clickedRow]]]),
    })
    const queryKey = desktopQueryKeys.gfsChildren(
      'a01-environment:a01-user:team-a',
      parent.resourceId,
      'main',
      1
    )
    const invalidate = vi.spyOn(desktopQueryClient, 'invalidateQueries')
    gfs.affordances.mockImplementation(async () => pendingPermission.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    const parentRow = await screen.findByRole('treeitem', { name: /a01-focus-parent/ })
    const parentLabel = parentRow.querySelector<HTMLButtonElement>('.da-file-explorer__label')
    expect(parentLabel).toBeTruthy()
    fireEvent.click(within(parentRow).getByRole('button', { name: /Expand a01-focus-parent/ }))
    const clickedLabel = (await findResourceTreeRow(file.name)).querySelector<HTMLButtonElement>(
      '.da-file-explorer__label'
    )
    expect(clickedLabel).toBeTruthy()
    const callsBeforeRefetch = gfs.listChildren.mock.calls.length
    const pendingRefetch = deferred<Awaited<ReturnType<typeof listChildrenPage>>>()
    gfs.listChildren.mockImplementation(async () =>
      gfs.listChildren.mock.calls.length > callsBeforeRefetch
        ? pendingRefetch.promise
        : await listChildrenPage([clickedRow])
    )
    await chooseRowActionByKeyboard(file.name, 'Copy file ID')
    await waitFor(() => expect(gfs.affordances).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(document.activeElement).toBe(clickedLabel))

    const changedRow = childView(file.resourceId, file.name, 'file', {
      gfsUri: `gfs://main/${'d3'.repeat(16)}`,
      parentResourceId: parent.resourceId,
      version: file.version + 1,
    })
    const changedPage = await listChildrenPage([changedRow])
    act(() =>
      desktopQueryClient.setQueryData(queryKey, { pages: [changedPage], pageParams: [undefined] })
    )
    await act(async () => pendingPermission.resolve(await resourceAffordances(['read'])))
    const toggle = screen.getByTestId('nav-files-explorer-toggle')
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(desktopQueryClient.isFetching({ queryKey, exact: true })).toBe(1))
    expect(getResourceTreeRow(file.name)).not.toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(toggle))
    await act(async () => pendingRefetch.resolve(await listChildrenPage([])))
    await waitFor(() => expect(gfs.listChildren).toHaveBeenCalledTimes(callsBeforeRefetch + 1))
    await waitFor(() => expect(getResourceTreeRow(file.name)).toBeNull())
    await waitFor(() => expect(desktopQueryClient.isFetching({ queryKey, exact: true })).toBe(0))

    expect(writeText).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(toggle)
    expect(invalidate).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey, exact: true, refetchType: 'active' }),
      expect.anything()
    )
    expect(invalidate).toHaveBeenCalledTimes(1)
    expect(controller.current?.toasts).toContainEqual(
      expect.objectContaining({
        text: 'This resource is no longer available from its parent folder.',
        tone: 'error',
      })
    )
    expect(activeWorkspaceTab(controller.current!.workspaceTabs)?.kind).toBe('chat')
  })

  it('A01 D3: restores focus when a root refresh removes the keyboard action opener', async () => {
    const file = await resolveResource(resolvedFile('d4'.repeat(16), 'a01-root-removal-focus.txt'))
    const pendingPermission = deferred<Awaited<ReturnType<typeof resourceAffordances>>>()
    const writeText = vi.fn(async (_text: string) => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const { controller, gfs } = await renderActualA01App([file], writeText)
    const emptyPage = await listAccessiblePage([])
    const queryKey = desktopQueryKeys.gfsAccessible('a01-environment:a01-user:team-a', 'main', 1)
    const toggle = screen.getByTestId('nav-files-explorer-toggle')
    gfs.affordances.mockImplementation(async () => pendingPermission.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /a01-root-removal-focus\.txt/ })
    await chooseRowActionByKeyboard(file.name, 'Copy file ID')
    await waitFor(() => expect(gfs.affordances).toHaveBeenCalledTimes(1))
    const opener = getResourceTreeRow(file.name)?.querySelector<HTMLButtonElement>(
      '.da-file-explorer__label'
    )
    if (!opener) throw new Error('The keyboard Copy ID opener did not remain mounted')
    await waitFor(() => expect(document.activeElement).toBe(opener))

    const invalidate = vi.spyOn(desktopQueryClient, 'invalidateQueries')
    const pendingRootRefresh = deferred<Awaited<ReturnType<typeof listAccessiblePage>>>()
    gfs.listAccessible.mockImplementation(async () => pendingRootRefresh.promise)
    let rootRefresh!: Promise<void>
    act(() => {
      rootRefresh = desktopQueryClient.invalidateQueries({
        queryKey,
        exact: true,
        refetchType: 'active',
      })
    })
    await waitFor(() => expect(gfs.listAccessible).toHaveBeenCalledTimes(2))
    act(() =>
      desktopQueryClient.setQueryData(queryKey, { pages: [emptyPage], pageParams: [undefined] })
    )
    await waitFor(() => expect(getResourceTreeRow(file.name)).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(toggle))
    expect(toggle.isConnected).toBe(true)
    expect(desktopQueryClient.isFetching({ queryKey, exact: true })).toBe(1)
    expect(gfs.affordances).toHaveBeenCalledTimes(1)
    expect(writeText).not.toHaveBeenCalled()
    expect(activeWorkspaceTab(controller.current!.workspaceTabs)?.kind).toBe('chat')

    await act(async () => {
      pendingRootRefresh.resolve(emptyPage)
      await pendingRootRefresh.promise
      await rootRefresh
    })
    await waitFor(() => expect(desktopQueryClient.isFetching({ queryKey, exact: true })).toBe(0))

    await act(async () => pendingPermission.resolve(await resourceAffordances(['read'])))
    await waitFor(() =>
      expect(controller.current?.toasts).toContainEqual(
        expect.objectContaining({
          text: 'This resource is no longer available from its parent folder.',
          tone: 'error',
        })
      )
    )
    expect(writeText).not.toHaveBeenCalled()
    await waitFor(() => expect(desktopQueryClient.isFetching({ queryKey, exact: true })).toBe(0))
    expect(invalidate).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey, exact: true, refetchType: 'active' }),
      expect.anything()
    )
    expect(activeWorkspaceTab(controller.current!.workspaceTabs)?.kind).toBe('chat')
  })

  it.each(['timer-before-commit', 'commit-before-timer'] as const)(
    'A01 r17 S14/S28: %s preserves connected focus across the real menu timer and row commit',
    async order => {
      const file = await resolveResource(
        resolvedFile('d7'.repeat(16), `a01-menu-timer-${order}.txt`)
      )
      const emptyPage = await listAccessiblePage([])
      const pendingPermission = deferred<Awaited<ReturnType<typeof resourceAffordances>>>()
      const pendingRootRefresh = deferred<Awaited<ReturnType<typeof listAccessiblePage>>>()
      const writeText = vi.fn(async (_text: string) => undefined)
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
      const { controller, gfs } = await renderActualA01App([file], writeText)
      const queryKey = desktopQueryKeys.gfsAccessible('a01-environment:a01-user:team-a', 'main', 1)
      const toggle = screen.getByTestId('nav-files-explorer-toggle')
      const invalidate = vi.spyOn(desktopQueryClient, 'invalidateQueries')
      gfs.affordances.mockImplementation(async () => pendingPermission.promise)
      fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
      const row = await findResourceTreeRow(file.name)
      const opener = row.querySelector<HTMLButtonElement>('.da-file-explorer__label')
      if (!opener) throw new Error('The keyboard Copy ID opener did not mount')
      opener.focus()

      const user = userEvent.setup()
      await user.keyboard('{Shift>}{F10}{/Shift}')
      const menu = await screen.findByRole('menu', { name: `Actions for ${file.name}` })
      const shareTrigger = within(menu).getByRole('menuitem', { name: 'Share' })
      shareTrigger.focus()
      await user.keyboard('{ArrowRight}')
      const submenu = await screen.findByRole('menu', { name: `Share options for ${file.name}` })
      const action = within(submenu).getByRole('menuitem', { name: 'Copy file ID' })
      action.focus()
      expect(document.activeElement).toBe(action)

      const originalSetTimeout = window.setTimeout.bind(window)
      const originalClearTimeout = window.clearTimeout.bind(window)
      const focusTimerId = originalSetTimeout(() => undefined, 0)
      let runMenuFocusReturn: (() => void) | null = null
      const setTimeoutSpy = vi.spyOn(window, 'setTimeout').mockImplementation(((
        handler: TimerHandler,
        timeout?: number,
        ...args: unknown[]
      ) => {
        if (
          timeout === 0 &&
          typeof handler === 'function' &&
          handler.toString().includes('restoreTriggerAfterActionRef.current = false')
        ) {
          runMenuFocusReturn = () => handler(...args)
          return focusTimerId
        }
        return originalSetTimeout(handler as (...callbackArgs: never[]) => void, timeout, ...args)
      }) as typeof window.setTimeout)
      const clearedTimers: unknown[] = []
      const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout').mockImplementation(handle => {
        clearedTimers.push(handle)
        originalClearTimeout(handle as NodeJS.Timeout | undefined)
      })

      // detail=0 is the browser click synthesized by keyboard activation; this invokes the
      // production menu handler that arms its actual zero-delay focus-return effect.
      fireEvent.click(action, { detail: 0 })
      await waitFor(() => expect(gfs.affordances).toHaveBeenCalledTimes(1))
      await waitFor(() =>
        expect(screen.queryByRole('menu', { name: `Actions for ${file.name}` })).toBeNull()
      )
      expect(runMenuFocusReturn).toBeTypeOf('function')

      const callsBeforeRootRefresh = gfs.listAccessible.mock.calls.length
      gfs.listAccessible.mockImplementation(async () => pendingRootRefresh.promise)
      let rootRefresh!: Promise<void>
      act(() => {
        rootRefresh = desktopQueryClient.invalidateQueries({
          queryKey,
          exact: true,
          refetchType: 'active',
        })
      })
      await waitFor(() =>
        expect(gfs.listAccessible).toHaveBeenCalledTimes(callsBeforeRootRefresh + 1)
      )

      if (order === 'timer-before-commit') {
        act(() => runMenuFocusReturn?.())
        expect(document.activeElement).toBe(opener)
      }

      await act(async () => {
        pendingRootRefresh.resolve(emptyPage)
        await pendingRootRefresh.promise
        await rootRefresh
      })
      await waitFor(() => expect(getResourceTreeRow(file.name)).toBeNull())
      await waitFor(() => expect(document.activeElement).toBe(toggle))
      expect(toggle.isConnected).toBe(true)

      if (order === 'commit-before-timer') {
        expect(clearedTimers).toContain(focusTimerId)
        // A callback already dequeued when unmount cleanup runs cannot reclaim focus.
        act(() => runMenuFocusReturn?.())
        expect(document.activeElement).toBe(toggle)
      }

      gfs.listAccessible.mockImplementation(async () => emptyPage)
      await act(async () => pendingPermission.resolve(await resourceAffordances(['read'])))
      await waitFor(() =>
        expect(controller.current?.toasts).toContainEqual(
          expect.objectContaining({
            text: 'This resource is no longer available from its parent folder.',
            tone: 'error',
          })
        )
      )
      await waitFor(() => expect(desktopQueryClient.isFetching({ queryKey, exact: true })).toBe(0))

      expect(writeText).not.toHaveBeenCalled()
      expect(invalidate).toHaveBeenCalledTimes(2)
      expect(
        invalidate.mock.calls.every(
          ([filters]) =>
            JSON.stringify(filters?.queryKey) === JSON.stringify(queryKey) &&
            filters?.exact === true
        )
      ).toBe(true)
      expect(document.activeElement).toBe(toggle)
      expect(activeWorkspaceTab(controller.current!.workspaceTabs)?.kind).toBe('chat')
      expect(screen.queryAllByRole('dialog')).toHaveLength(0)
      originalClearTimeout(focusTimerId)
      setTimeoutSpy.mockRestore()
      clearTimeoutSpy.mockRestore()
    }
  )

  it('A01 D3 G2: ancestor removal restores focus while the clicked parent query remains valid', async () => {
    const parent = await resolveResource(resolvedDirectory('d5'.repeat(16), 'a01-surviving-parent'))
    const file = await resolveResource(
      resolvedFile('d6'.repeat(16), 'a01-ancestor-focus-child.txt', {
        parentResourceId: parent.resourceId,
      })
    )
    const clickedRow = childView(file.resourceId, file.name, 'file', {
      gfsUri: file.gfsUri,
      parentResourceId: parent.resourceId,
      version: file.version,
    })
    const pendingPermission = deferred<Awaited<ReturnType<typeof resourceAffordances>>>()
    const writeText = vi.fn(async (_text: string) => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const { controller, gfs } = await renderActualA01App([parent, file], writeText, {
      accessibleRows: [
        accessibleResource(parent.resourceId, parent.name, 'directory', {
          gfsUri: parent.gfsUri,
          parentResourceId: null,
          version: parent.version,
        }),
      ],
      childRowsByParent: new Map([[parent.resourceId, [clickedRow]]]),
    })
    const parentQueryKey = desktopQueryKeys.gfsAccessible(
      'a01-environment:a01-user:team-a',
      'main',
      1
    )
    const toggle = screen.getByTestId('nav-files-explorer-toggle')
    const invalidate = vi.spyOn(desktopQueryClient, 'invalidateQueries')
    gfs.affordances.mockImplementation(async () => pendingPermission.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    const parentTreeRow = await screen.findByRole('treeitem', { name: /a01-surviving-parent/ })
    fireEvent.click(
      within(parentTreeRow).getByRole('button', { name: /Expand a01-surviving-parent/ })
    )
    await findResourceTreeRow(file.name)
    await chooseRowActionByKeyboard(file.name, 'Copy file ID')
    await waitFor(() => expect(gfs.affordances).toHaveBeenCalledTimes(1))
    const opener = getResourceTreeRow(file.name)?.querySelector<HTMLButtonElement>(
      '.da-file-explorer__label'
    )
    if (!opener) throw new Error('The keyboard Copy ID opener did not remain mounted')
    await waitFor(() => expect(document.activeElement).toBe(opener))

    gfs.listAccessible.mockImplementation(async () => await listAccessiblePage([]))
    await act(async () =>
      desktopQueryClient.invalidateQueries({ queryKey: parentQueryKey, exact: true })
    )
    await waitFor(() => expect(getResourceTreeRow(parent.name)).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(toggle))
    expect(toggle.isConnected).toBe(true)
    expect(gfs.affordances).toHaveBeenCalledTimes(1)
    expect(writeText).not.toHaveBeenCalled()

    const laterFocus = screen.getByTestId('nav-chat')
    laterFocus.focus()
    await act(async () => pendingPermission.resolve(await resourceAffordances(['read'])))
    await waitFor(() =>
      expect(controller.current?.toasts).toContainEqual(
        expect.objectContaining({
          text: 'File ID copied',
          tone: 'success',
        })
      )
    )
    await waitFor(() =>
      expect(desktopQueryClient.isFetching({ queryKey: parentQueryKey, exact: true })).toBe(0)
    )
    expect(document.activeElement).toBe(laterFocus)
    expect(invalidate).toHaveBeenCalledTimes(1)
    expect(activeWorkspaceTab(controller.current!.workspaceTabs)?.kind).toBe('chat')
  })

  it('A01 r17 S35: an older D2 result cannot steal a newer keyboard Copy ID focus', async () => {
    const first = await resolveResource(resolvedFile('d7'.repeat(16), 'a01-older-copy.txt'))
    const second = await resolveResource(resolvedFile('d8'.repeat(16), 'a01-newer-copy.txt'))
    const pendingFirstPermission = deferred<Awaited<ReturnType<typeof resourceAffordances>>>()
    const pendingSecondPermission = deferred<Awaited<ReturnType<typeof resourceAffordances>>>()
    const pendingFirstRefetch = deferred<Awaited<ReturnType<typeof listAccessiblePage>>>()
    const writeText = vi.fn(async (_text: string) => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const { controller, gfs } = await renderActualA01App([first, second], writeText)
    const queryKey = desktopQueryKeys.gfsAccessible('a01-environment:a01-user:team-a', 'main', 1)
    const invalidate = vi.spyOn(desktopQueryClient, 'invalidateQueries')
    gfs.affordances.mockImplementation(() =>
      gfs.affordances.mock.calls.length === 1
        ? pendingFirstPermission.promise
        : pendingSecondPermission.promise
    )
    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /a01-older-copy\.txt/ })
    await screen.findByRole('treeitem', { name: /a01-newer-copy\.txt/ })
    const callsBeforeRefetch = gfs.listAccessible.mock.calls.length
    gfs.listAccessible.mockImplementation(async () =>
      gfs.listAccessible.mock.calls.length > callsBeforeRefetch
        ? pendingFirstRefetch.promise
        : await listAccessiblePage([
            accessibleResource(first.resourceId, first.name, 'file', {
              gfsUri: first.gfsUri,
              parentResourceId: first.parentResourceId,
              version: first.version,
            }),
            accessibleResource(second.resourceId, second.name, 'file', {
              gfsUri: second.gfsUri,
              parentResourceId: second.parentResourceId,
              version: second.version,
            }),
          ])
    )

    await chooseRowActionByKeyboard(first.name, 'Copy file ID')
    await waitFor(() => expect(gfs.affordances).toHaveBeenCalledWith(first.resourceId, 'main'))
    const mismatchedPage = await listAccessiblePage([
      accessibleResource(first.resourceId, first.name, 'file', {
        gfsUri: `gfs://main/${'d9'.repeat(16)}`,
        parentResourceId: first.parentResourceId,
        version: first.version + 1,
      }),
      accessibleResource(second.resourceId, second.name, 'file', {
        gfsUri: second.gfsUri,
        parentResourceId: second.parentResourceId,
        version: second.version,
      }),
    ])
    act(() =>
      desktopQueryClient.setQueryData(queryKey, {
        pages: [mismatchedPage],
        pageParams: [undefined],
      })
    )
    await act(async () => pendingFirstPermission.resolve(await resourceAffordances(['read'])))
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(gfs.listAccessible).toHaveBeenCalledTimes(callsBeforeRefetch + 1))

    const newerOpener = getResourceTreeRow(second.name)?.querySelector<HTMLButtonElement>(
      '.da-file-explorer__label'
    )
    expect(newerOpener).toBeTruthy()
    await chooseRowActionByKeyboard(second.name, 'Copy file ID')
    await waitFor(() => expect(gfs.affordances).toHaveBeenCalledWith(second.resourceId, 'main'))
    await waitFor(() => expect(document.activeElement).toBe(newerOpener))

    const currentPage = await listAccessiblePage([
      accessibleResource(second.resourceId, second.name, 'file', {
        gfsUri: second.gfsUri,
        parentResourceId: second.parentResourceId,
        version: second.version,
      }),
    ])
    await act(async () => {
      pendingFirstRefetch.resolve(currentPage)
      await pendingFirstRefetch.promise
    })
    await waitFor(() => expect(getResourceTreeRow(first.name)).toBeNull())
    await waitFor(() => expect(desktopQueryClient.isFetching({ queryKey, exact: true })).toBe(0))
    expect(document.activeElement).toBe(newerOpener)

    await act(async () => pendingSecondPermission.resolve(await resourceAffordances(['read'])))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(second.gfsUri))
    expect(writeText.mock.calls.map(([uri]) => uri)).toEqual([second.gfsUri])
    expect(invalidate).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey, exact: true, refetchType: 'active' }),
      expect.anything()
    )
    expect(invalidate).toHaveBeenCalledTimes(1)
    expect(controller.current?.toasts).toContainEqual(
      expect.objectContaining({
        text: 'This resource is no longer available from its parent folder.',
        tone: 'error',
      })
    )
    expect(controller.current?.toasts).toContainEqual(
      expect.objectContaining({ text: 'File ID copied', tone: 'success' })
    )
    expect(activeWorkspaceTab(controller.current!.workspaceTabs)?.kind).toBe('chat')
    expect(screen.queryAllByRole('dialog')).toHaveLength(0)
  })

  it('A01 model probe: name-only refresh preserves canonical target identity', async () => {
    const file = await resolveResource(
      resolvedFile('adadadadadadadadadadadadadadadad', 'a01-name-before.txt')
    )
    const pendingPermission = deferred<Awaited<ReturnType<typeof resourceAffordances>>>()
    const writeText = vi.fn(async (_text: string) => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const { controller, gfs } = await renderActualA01App([file], writeText)
    const invalidate = vi.spyOn(desktopQueryClient, 'invalidateQueries')
    gfs.affordances.mockImplementation(async () => pendingPermission.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /a01-name-before\.txt/ })
    await chooseRowAction(file.name, 'Copy file ID')
    await waitFor(() => expect(gfs.affordances).toHaveBeenCalledTimes(1))
    const renamedPage = await listAccessiblePage([
      accessibleResource(file.resourceId, 'a01-name-after.txt', 'file', {
        gfsUri: file.gfsUri,
        parentResourceId: file.parentResourceId,
        version: file.version,
      }),
    ])
    act(() =>
      desktopQueryClient.setQueryData(
        desktopQueryKeys.gfsAccessible('a01-environment:a01-user:team-a', 'main', 1),
        { pages: [renamedPage], pageParams: [undefined] }
      )
    )
    await act(async () => pendingPermission.resolve(await resourceAffordances(['read'])))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(file.gfsUri))
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(invalidate).not.toHaveBeenCalled()
    expect(controller.current?.toasts).not.toContainEqual(
      expect.objectContaining({
        text: 'This resource is no longer available from its parent folder.',
      })
    )
    expect(activeWorkspaceTab(controller.current!.workspaceTabs)?.kind).toBe('chat')
  })

  it('A01 model probe: replacement resource ID is never substituted', async () => {
    const file = await resolveResource(resolvedFile('b0'.repeat(16), 'a01-id-before.txt'))
    const pendingPermission = deferred<Awaited<ReturnType<typeof resourceAffordances>>>()
    const writeText = vi.fn(async (_text: string) => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const { controller, gfs } = await renderActualA01App([file], writeText)
    const queryKey = desktopQueryKeys.gfsAccessible('a01-environment:a01-user:team-a', 'main', 1)
    const invalidate = vi.spyOn(desktopQueryClient, 'invalidateQueries')
    gfs.affordances.mockImplementation(async () => pendingPermission.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /a01-id-before\.txt/ })
    await chooseRowAction(file.name, 'Copy file ID')
    await waitFor(() => expect(gfs.affordances).toHaveBeenCalledTimes(1))
    const replacementId = 'b1'.repeat(16)
    const page = await listAccessiblePage([
      accessibleResource(replacementId, file.name, 'file', {
        gfsUri: file.gfsUri,
        parentResourceId: file.parentResourceId,
        version: file.version,
      }),
    ])
    act(() => desktopQueryClient.setQueryData(queryKey, { pages: [page], pageParams: [undefined] }))
    await act(async () => pendingPermission.resolve(await resourceAffordances(['read'])))
    await waitFor(() =>
      expect(controller.current?.toasts).toContainEqual(
        expect.objectContaining({
          text: 'This resource is no longer available from its parent folder.',
          tone: 'error',
        })
      )
    )
    expect(writeText).not.toHaveBeenCalled()
    expect(invalidate).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey, exact: true, refetchType: 'active' }),
      expect.anything()
    )
    expect(invalidate).toHaveBeenCalledTimes(1)
  })

  it('A01 model probe: changed kind is rejected and refreshes exact parent once', async () => {
    const file = await resolveResource(resolvedFile('b2'.repeat(16), 'a01-kind-before.txt'))
    const pendingPermission = deferred<Awaited<ReturnType<typeof resourceAffordances>>>()
    const writeText = vi.fn(async (_text: string) => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const { controller, gfs } = await renderActualA01App([file], writeText)
    const queryKey = desktopQueryKeys.gfsAccessible('a01-environment:a01-user:team-a', 'main', 1)
    const invalidate = vi.spyOn(desktopQueryClient, 'invalidateQueries')
    gfs.affordances.mockImplementation(async () => pendingPermission.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /a01-kind-before\.txt/ })
    await chooseRowAction(file.name, 'Copy file ID')
    await waitFor(() => expect(gfs.affordances).toHaveBeenCalledTimes(1))
    const page = await listAccessiblePage([
      accessibleResource(file.resourceId, file.name, 'directory', {
        gfsUri: file.gfsUri,
        parentResourceId: file.parentResourceId,
        version: file.version,
      }),
    ])
    act(() => desktopQueryClient.setQueryData(queryKey, { pages: [page], pageParams: [undefined] }))
    await act(async () => pendingPermission.resolve(await resourceAffordances(['read'])))
    await waitFor(() =>
      expect(controller.current?.toasts).toContainEqual(
        expect.objectContaining({
          text: 'This resource is no longer available from its parent folder.',
          tone: 'error',
        })
      )
    )
    expect(writeText).not.toHaveBeenCalled()
    expect(invalidate).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey, exact: true, refetchType: 'active' }),
      expect.anything()
    )
    expect(invalidate).toHaveBeenCalledTimes(1)
  })

  it('A01 model probe: reparented target is rejected and refreshes clicked parent once', async () => {
    const file = await resolveResource(resolvedFile('b3'.repeat(16), 'a01-parent-before.txt'))
    const pendingPermission = deferred<Awaited<ReturnType<typeof resourceAffordances>>>()
    const writeText = vi.fn(async (_text: string) => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const { controller, gfs } = await renderActualA01App([file], writeText)
    const queryKey = desktopQueryKeys.gfsAccessible('a01-environment:a01-user:team-a', 'main', 1)
    const invalidate = vi.spyOn(desktopQueryClient, 'invalidateQueries')
    gfs.affordances.mockImplementation(async () => pendingPermission.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /a01-parent-before\.txt/ })
    await chooseRowAction(file.name, 'Copy file ID')
    await waitFor(() => expect(gfs.affordances).toHaveBeenCalledTimes(1))
    const page = await listAccessiblePage([
      accessibleResource(file.resourceId, file.name, 'file', {
        gfsUri: file.gfsUri,
        parentResourceId: 'moved-parent',
        version: file.version,
      }),
    ])
    act(() => desktopQueryClient.setQueryData(queryKey, { pages: [page], pageParams: [undefined] }))
    await act(async () => pendingPermission.resolve(await resourceAffordances(['read'])))
    await waitFor(() =>
      expect(controller.current?.toasts).toContainEqual(
        expect.objectContaining({
          text: 'This resource is no longer available from its parent folder.',
          tone: 'error',
        })
      )
    )
    expect(writeText).not.toHaveBeenCalled()
    expect(invalidate).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey, exact: true, refetchType: 'active' }),
      expect.anything()
    )
    expect(invalidate).toHaveBeenCalledTimes(1)
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

  it('A01 closes keyboard focus recovery after stable-identity clipboard success', async () => {
    const file = await resolveResource(
      resolvedFile('27272727272727272727272727272727', 'a01-focus-terminal-success.txt')
    )
    const writeText = vi.fn(async (_text: string) => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const { controller, gfs } = await renderActualA01App([file], writeText)
    const queryKey = desktopQueryKeys.gfsAccessible('a01-environment:a01-user:team-a', 'main', 1)
    const emptyPage = await listAccessiblePage([])
    const changedPage = await listAccessiblePage([
      accessibleResource(file.resourceId, `${file.name}.renamed`, 'file', {
        gfsUri: file.gfsUri,
        parentResourceId: file.parentResourceId,
        version: file.version + 1,
      }),
    ])
    const pendingPermission = deferred<Awaited<ReturnType<typeof resourceAffordances>>>()
    gfs.affordances.mockImplementation(async () => pendingPermission.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /a01-focus-terminal-success\.txt/ })
    await chooseRowActionByKeyboard(file.name, 'Copy file ID')
    await waitFor(() => expect(gfs.affordances).toHaveBeenCalledTimes(1))
    const opener = getResourceTreeRow(file.name)?.querySelector<HTMLButtonElement>(
      '.da-file-explorer__label'
    )
    if (!opener) throw new Error('The keyboard Copy ID opener did not remain mounted')
    act(() =>
      desktopQueryClient.setQueryData(queryKey, { pages: [changedPage], pageParams: [undefined] })
    )
    await act(async () => pendingPermission.resolve(await resourceAffordances(['read'])))
    await waitFor(() =>
      expect(controller.current?.toasts).toContainEqual(
        expect.objectContaining({ text: 'File ID copied', tone: 'success' })
      )
    )
    expect(writeText).toHaveBeenCalledWith(file.gfsUri)
    expect(writeText).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(document.activeElement).toBe(opener))
    expect(controller.current?.toasts).not.toContainEqual(
      expect.objectContaining({
        text: 'This resource is no longer available from its parent folder.',
        tone: 'error',
      })
    )
    expect(activeWorkspaceTab(controller.current!.workspaceTabs)?.kind).toBe('chat')
    expect(screen.queryAllByRole('dialog')).toHaveLength(0)

    act(() =>
      desktopQueryClient.setQueryData(queryKey, { pages: [emptyPage], pageParams: [undefined] })
    )
    await waitFor(() => expect(opener.isConnected).toBe(false))
    await waitFor(() => expect(getResourceTreeRow(file.name)).toBeNull())
    expect(document.activeElement).toBe(document.body)
  })

  it('A01 closes keyboard focus recovery after permission failure', async () => {
    const file = await resolveResource(
      resolvedFile('28282828282828282828282828282828', 'a01-focus-terminal-permission.txt')
    )
    const writeText = vi.fn(async (_text: string) => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const { controller, gfs } = await renderActualA01App([file], writeText)
    const queryKey = desktopQueryKeys.gfsAccessible('a01-environment:a01-user:team-a', 'main', 1)
    const emptyPage = await listAccessiblePage([])
    gfs.affordances.mockRejectedValue(new Error('permission unavailable'))
    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /a01-focus-terminal-permission\.txt/ })
    await chooseRowActionByKeyboard(file.name, 'Copy file ID')
    const opener = getResourceTreeRow(file.name)?.querySelector<HTMLButtonElement>(
      '.da-file-explorer__label'
    )
    if (!opener) throw new Error('The keyboard Copy ID opener did not remain mounted')
    await waitFor(() => expect(document.activeElement).toBe(opener))
    await waitFor(() =>
      expect(controller.current?.toasts).toContainEqual(
        expect.objectContaining({ tone: 'error', text: expect.stringContaining('permission') })
      )
    )
    expect(writeText).not.toHaveBeenCalled()
    expect(activeWorkspaceTab(controller.current!.workspaceTabs)?.kind).toBe('chat')
    expect(screen.queryAllByRole('dialog')).toHaveLength(0)

    act(() =>
      desktopQueryClient.setQueryData(queryKey, { pages: [emptyPage], pageParams: [undefined] })
    )
    await waitFor(() => expect(opener.isConnected).toBe(false))
    await waitFor(() => expect(getResourceTreeRow(file.name)).toBeNull())
    expect(document.activeElement).toBe(document.body)
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

  it('A01 M1: retires pending Copy ID permission across completed team switches without changing tabs', async () => {
    const file = await resolveResource(
      resolvedFile('20202020202020202020202020202020', 'a01-team-switch-pending-copy.txt')
    )
    const pendingPermission = deferred<Awaited<ReturnType<typeof resourceAffordances>>>()
    const writeText = vi.fn(async (_text: string) => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const { controller, gfs, clerum, sessionAuthority } = await renderActualA01App(
      [file],
      writeText
    )
    gfs.affordances.mockImplementation(async () => pendingPermission.promise)
    const teamBridge = clerum as unknown as {
      team: { switch: ReturnType<typeof vi.fn> }
    }
    teamBridge.team.switch.mockImplementation(async (teamId: string) => {
      sessionAuthority.me.teamId = teamId
      sessionAuthority.generation += 1
      return {
        authenticated: true,
        me: sessionAuthority.me,
        sessionGeneration: sessionAuthority.generation,
      }
    })

    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /a01-team-switch-pending-copy\.txt/ })
    const originalTabId = activeWorkspaceTab(controller.current!.workspaceTabs)?.id
    const originalNavigationIntent = controller.current!.navigationIntentSequence
    const originalSessionGeneration = controller.current!.sessionGeneration
    await chooseRowAction(file.name, 'Copy file ID')
    await waitFor(() => expect(gfs.affordances).toHaveBeenCalledWith(file.resourceId, 'main'))

    await act(async () => {
      await controller.current!.handleEnsureTeamContext({ teamId: 'team-b' })
      await controller.current!.handleEnsureTeamContext({ teamId: 'team-a' })
    })
    expect(controller.current?.me?.teamId).toBe('team-a')
    expect(controller.current?.sessionGeneration).not.toBe(originalSessionGeneration)
    expect(activeWorkspaceTab(controller.current!.workspaceTabs)?.id).toBe(originalTabId)
    expect(controller.current?.navigationIntentSequence).toBe(originalNavigationIntent)

    await act(async () => pendingPermission.resolve(await resourceAffordances(['read'])))

    expect(writeText).not.toHaveBeenCalled()
    expect(controller.current?.toasts).not.toContainEqual(
      expect.objectContaining({ text: 'File ID copied', tone: 'success' })
    )
    expect(
      controller.current?.toasts.some(
        toast => toast.tone === 'error' && toast.text.includes(file.name)
      )
    ).toBe(false)
    expect(controller.current?.toasts).not.toContainEqual(
      expect.objectContaining({
        text: 'This resource is no longer available from its parent folder.',
        tone: 'error',
      })
    )
    expect(controller.current?.me?.teamId).toBe('team-a')
    expect(activeWorkspaceTab(controller.current!.workspaceTabs)?.id).toBe(originalTabId)
    expect(controller.current?.navigationIntentSequence).toBe(originalNavigationIntent)
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
    expect(appHarness.filesPagePendingActions).toEqual(
      expect.arrayContaining([expect.objectContaining({ navigationUri: parent.gfsUri })])
    )
    fireEvent.click(within(sidebarDialog).getByRole('button', { name: 'Close share dialog' }))
    await waitFor(() =>
      expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)).toMatchObject({
        kind: 'files',
        files: { path: parent.gfsUri },
      })
    )
    expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)).toMatchObject({
      kind: 'files',
      files: { path: parent.gfsUri },
    })
  })

  it('reuses the Files owner and converges to a file parent after browsing elsewhere', async () => {
    const parent = await resolveResource(
      resolvedDirectory('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'Owner parent')
    )
    const otherFolder = await resolveResource(
      resolvedDirectory('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'Other folder', {
        parentResourceId: parent.resourceId,
      })
    )
    const file = await resolveResource(
      resolvedFile('cccccccccccccccccccccccccccccccc', 'owner-target.txt', {
        parentResourceId: parent.resourceId,
      })
    )
    const { gfs } = installClerum([parent, otherFolder, file], new Map(), {
      accessibleRows: [
        accessibleResource(parent.resourceId, parent.name, 'directory', {
          gfsUri: parent.gfsUri,
        }),
      ],
      childRowsByParent: new Map([
        [
          parent.resourceId,
          [
            childView(otherFolder.resourceId, otherFolder.name, 'directory', {
              parentResourceId: parent.resourceId,
            }),
            childView(file.resourceId, file.name, 'file', {
              parentResourceId: parent.resourceId,
            }),
          ],
        ],
      ]),
    })
    const parentResolution = deferred<unknown>()
    const originalResolve = gfs.resolve
    let holdParentResolution = false
    Object.assign(gfs, {
      resolve: vi.fn((uri: string) => {
        if (holdParentResolution && uri === parent.gfsUri) return parentResolution.promise
        return originalResolve(uri)
      }),
    })
    appHarness.controller = makeController(
      openFilesTab(createWorkspaceTabsState('chat-tab-1'), {
        id: 'owner-files-tab',
        path: parent.gfsUri,
      })
    )
    renderApp()

    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    const sidebarParent = await screen.findByRole('treeitem', { name: /Owner parent/ })
    fireEvent.click(within(sidebarParent).getByRole('button', { name: 'Expand Owner parent' }))
    await findResourceTreeRow(file.name)
    await chooseRowAction(file.name, 'Copy link')
    await waitFor(() => expect(gfs.copyDeepLink).toHaveBeenCalledTimes(1))

    const browser = screen.getByRole('region', { name: 'EvenDrive browser' })
    fireEvent.click(within(browser).getByRole('button', { name: otherFolder.name }))
    await waitFor(() =>
      expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)).toMatchObject({
        id: 'owner-files-tab',
        kind: 'files',
        files: { path: otherFolder.gfsUri },
      })
    )
    const nestedResolveCountBeforeReselect = gfs.resolve.mock.calls.filter(
      ([uri]) => uri === otherFolder.gfsUri
    ).length
    fireEvent.click(getWorkspaceTabButtons(otherFolder.name)[0]!)
    await waitFor(() =>
      expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)).toMatchObject({
        id: 'owner-files-tab',
        kind: 'files',
        files: { path: otherFolder.gfsUri },
      })
    )
    expect(gfs.resolve.mock.calls.filter(([uri]) => uri === otherFolder.gfsUri)).toHaveLength(
      nestedResolveCountBeforeReselect
    )
    const resolveCountBeforeRepeat = gfs.resolve.mock.calls.filter(
      ([uri]) => uri === parent.gfsUri
    ).length
    fireEvent.click(screen.getByTestId('nav-chat'))
    await waitFor(() =>
      expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)?.kind).toBe('chat')
    )

    const parentResolveCountBeforeAction = gfs.resolve.mock.calls.filter(
      ([uri]) => uri === parent.gfsUri
    ).length
    holdParentResolution = true
    await chooseRowAction(file.name, 'Copy link')
    await waitFor(() =>
      expect(gfs.resolve.mock.calls.filter(([uri]) => uri === parent.gfsUri)).toHaveLength(
        parentResolveCountBeforeAction + 1
      )
    )
    // Flush the controller state update and React effects while the first
    // resolve remains pending. D2's request marker must prevent this rerender
    // from starting another parent resolve.
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(gfs.resolve.mock.calls.filter(([uri]) => uri === parent.gfsUri)).toHaveLength(
      parentResolveCountBeforeAction + 1
    )
    await act(async () => {
      parentResolution.resolve(parent)
      await parentResolution.promise
    })
    await waitFor(() => expect(gfs.copyDeepLink).toHaveBeenCalledTimes(2))

    expect(
      appHarness.controller.workspaceTabs.tabs.filter(tab => tab.kind === 'files')
    ).toHaveLength(1)
    expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)).toMatchObject({
      id: 'owner-files-tab',
      kind: 'files',
      files: { path: parent.gfsUri },
    })
    expect(gfs.resolve.mock.calls.filter(([uri]) => uri === parent.gfsUri)).toHaveLength(
      resolveCountBeforeRepeat + 1
    )
    expect(gfs.download).not.toHaveBeenCalled()

    const filesBrowser = screen.getByRole('region', { name: 'EvenDrive browser' })
    fireEvent.click(within(filesBrowser).getByRole('button', { name: 'Shared with me' }))
    await waitFor(() =>
      expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)).toMatchObject({
        id: 'owner-files-tab',
        kind: 'files',
        files: { path: null },
      })
    )
    const rootResolveCount = gfs.resolve.mock.calls.length
    fireEvent.click(getWorkspaceTabButtons('Files')[0]!)
    await waitFor(() =>
      expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)?.id).toBe('owner-files-tab')
    )
    expect(gfs.resolve).toHaveBeenCalledTimes(rootResolveCount)
    expect(
      appHarness.controller.workspaceTabs.tabs.filter(tab => tab.kind === 'files')
    ).toHaveLength(1)
  })

  it('opens the clicked folder through the same Files route as the row action', async () => {
    const folder = await resolveResource(
      resolvedDirectory('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'Open target folder')
    )
    installClerum([folder])
    appHarness.controller = makeController(
      openFilesTab(createWorkspaceTabsState('chat-tab-1'), {
        id: 'files-root',
        path: null,
      })
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
        if (uri === child.gfsUri)
          throw new Error('403 Forbidden: unreadable resource httpStatus=403')
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
    await waitFor(() => expect(gfs.resolve).toHaveBeenCalledWith(child.gfsUri))
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
    const d5bExpected = d5bExpectedOutcome(
      {
        resourceId,
        gfsUri: clickedRow.gfsUri,
        kind: clickedRow.kind,
        parentResourceId,
        version: 7,
      },
      {
        resourceId: resolvedVersion.resourceId,
        gfsUri: resolvedVersion.gfsUri,
        kind: resolvedVersion.kind,
        parentResourceId: resolvedVersion.parentResourceId,
        version: resolvedVersion.version,
      }
    )
    const renameResource = vi.fn(
      async (_resourceId: string, _name: string, _drive: string, _version: number) => ({})
    )
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

    await waitFor(() => expect(gfs.resolve).toHaveBeenCalledWith(parent.gfsUri))
    await waitFor(() => expect(appHarness.filesPageLatestPendingAction).toBeNull())
    expect(screen.queryAllByRole('form', { name: 'Rename resource' })).toHaveLength(0)
    expect(renameResource).not.toHaveBeenCalled()
    expect(appHarness.controller.pushToast).not.toHaveBeenCalledWith(
      'Renamed to report.txt',
      'success'
    )
    expect(
      vi
        .mocked(appHarness.controller.pushToast)
        .mock.calls.filter(
          ([message, tone]) =>
            message === 'This resource changed before the action could run.' && tone === 'error'
        )
    ).toHaveLength(1)
    expect({
      disposition: 'reject',
      mutationCount: renameResource.mock.calls.length,
      operationVersion: renameResource.mock.calls[0]?.[3] ?? null,
      staleFeedbackCount: vi
        .mocked(appHarness.controller.pushToast)
        .mock.calls.filter(
          ([message, tone]) =>
            message === 'This resource changed before the action could run.' && tone === 'error'
        ).length,
    }).toEqual(d5bExpected)
  })

  it('does not rename a target that moved after the sidebar row was captured', async () => {
    const parentResourceId = '11111111111111111111111111111111'
    const movedParentResourceId = '22222222222222222222222222222222'
    const resourceId = '44444444444444444444444444444444'
    const parent = await resolveResource(resolvedDirectory(parentResourceId, 'Vault'))
    const movedTarget = await resolveResource(
      resolvedFile(resourceId, 'report.txt', {
        parentResourceId: movedParentResourceId,
        version: 7,
      })
    )
    const clickedRow = childView(resourceId, 'report.txt', 'file', {
      parentResourceId,
      readable: true,
      version: 7,
    })
    const d5bExpected = d5bExpectedOutcome(
      {
        resourceId,
        gfsUri: clickedRow.gfsUri,
        kind: clickedRow.kind,
        parentResourceId,
        version: 7,
      },
      {
        resourceId: movedTarget.resourceId,
        gfsUri: movedTarget.gfsUri,
        kind: movedTarget.kind,
        parentResourceId: movedTarget.parentResourceId,
        version: movedTarget.version,
      }
    )
    const renameResource = vi.fn(
      async (_resourceId: string, _name: string, _drive: string, _version: number) => ({})
    )
    const { gfs } = installClerum([parent, movedTarget], new Map(), {
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

    await waitFor(() => expect(gfs.resolve).toHaveBeenCalledWith(movedTarget.gfsUri))
    await waitFor(() => expect(appHarness.filesPageLatestPendingAction).toBeNull())
    expect(screen.queryAllByRole('form', { name: 'Rename resource' })).toHaveLength(0)
    expect(renameResource).not.toHaveBeenCalled()
    expect(
      vi
        .mocked(appHarness.controller.pushToast)
        .mock.calls.filter(
          ([message, tone]) =>
            message === 'This resource changed before the action could run.' && tone === 'error'
        )
    ).toHaveLength(1)
    expect({
      disposition: 'reject',
      mutationCount: renameResource.mock.calls.length,
      operationVersion: renameResource.mock.calls[0]?.[3] ?? null,
      staleFeedbackCount: vi
        .mocked(appHarness.controller.pushToast)
        .mock.calls.filter(
          ([message, tone]) =>
            message === 'This resource changed before the action could run.' && tone === 'error'
        ).length,
    }).toEqual(d5bExpected)
  })

  it('does not rename a file when the authoritative target changed kind', async () => {
    const parentResourceId = '11111111111111111111111111111111'
    const resourceId = '44444444444444444444444444444444'
    const parent = await resolveResource(resolvedDirectory(parentResourceId, 'Vault'))
    const currentDirectory = await resolveResource(
      resolvedDirectory(resourceId, 'report.txt', { parentResourceId, version: 7 })
    )
    const clickedRow = childView(resourceId, 'report.txt', 'file', {
      parentResourceId,
      readable: true,
      version: 7,
    })
    const expected = d5bExpectedOutcome(
      {
        resourceId,
        gfsUri: clickedRow.gfsUri,
        kind: clickedRow.kind,
        parentResourceId,
        version: 7,
      },
      {
        resourceId: currentDirectory.resourceId,
        gfsUri: currentDirectory.gfsUri,
        kind: currentDirectory.kind,
        parentResourceId: currentDirectory.parentResourceId,
        version: currentDirectory.version,
      }
    )
    const renameResource = vi.fn(
      async (_resourceId: string, _name: string, _drive: string, _version: number) => ({})
    )
    const { gfs } = installClerum([parent, currentDirectory], new Map(), {
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

    await waitFor(() => expect(gfs.resolve).toHaveBeenCalledWith(currentDirectory.gfsUri))
    await waitFor(() => expect(appHarness.filesPageLatestPendingAction).toBeNull())
    expect(screen.queryAllByRole('form', { name: 'Rename resource' })).toHaveLength(0)
    expect(renameResource).not.toHaveBeenCalled()
    expect({
      disposition: 'reject',
      mutationCount: renameResource.mock.calls.length,
      operationVersion: renameResource.mock.calls[0]?.[3] ?? null,
      staleFeedbackCount: vi
        .mocked(appHarness.controller.pushToast)
        .mock.calls.filter(
          ([message, tone]) =>
            message === 'This resource changed before the action could run.' && tone === 'error'
        ).length,
    }).toEqual(expected)
  })

  it('keeps Rename available when the authoritative target remains at the captured version', async () => {
    const parentResourceId = '11111111111111111111111111111111'
    const resourceId = '44444444444444444444444444444444'
    const parent = await resolveResource(resolvedDirectory(parentResourceId, 'Vault'))
    const currentTarget = await resolveResource(
      resolvedFile(resourceId, 'report.txt', { parentResourceId, version: 7 })
    )
    const clickedRow = childView(resourceId, 'report.txt', 'file', {
      parentResourceId,
      readable: true,
      version: 7,
    })
    const d5bExpected = d5bExpectedOutcome(
      {
        resourceId,
        gfsUri: clickedRow.gfsUri,
        kind: clickedRow.kind,
        parentResourceId,
        version: 7,
      },
      {
        resourceId: currentTarget.resourceId,
        gfsUri: currentTarget.gfsUri,
        kind: currentTarget.kind,
        parentResourceId: currentTarget.parentResourceId,
        version: currentTarget.version,
      }
    )
    const renameResource = vi.fn(
      async (_resourceId: string, _name: string, _drive: string, _version: number) => ({})
    )
    const { gfs } = installClerum([parent, currentTarget], new Map(), {
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

    const renameForm = await screen.findByRole('form', { name: 'Rename resource' })
    fireEvent.change(within(renameForm).getByLabelText('New name'), {
      target: { value: 'renamed-report.txt' },
    })
    fireEvent.click(within(renameForm).getByRole('button', { name: 'Save name' }))
    await waitFor(() =>
      expect(renameResource).toHaveBeenCalledWith(resourceId, 'renamed-report.txt', 'main', 7)
    )
    expect(renameResource).toHaveBeenCalledTimes(1)
    expect({
      disposition: 'admit',
      mutationCount: renameResource.mock.calls.length,
      operationVersion: renameResource.mock.calls[0]?.[3] ?? null,
      staleFeedbackCount: vi
        .mocked(appHarness.controller.pushToast)
        .mock.calls.filter(
          ([message, tone]) =>
            message === 'This resource changed before the action could run.' && tone === 'error'
        ).length,
    }).toEqual(d5bExpected)
  })

  it('fails closed when target resolution returns a typed session-authority 403', async () => {
    const file = await resolveResource(
      resolvedFile('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'authority-target.txt', { version: 7 })
    )
    const { gfs } = installClerum([file], new Map(), {
      affordanceBits: ['read', 'write', 'delete'],
    })
    const renameResource = vi.fn(async () => ({}))
    Object.assign(gfs, { renameResource })
    const authorityFailure = await gfsRouteFailureMessage(
      client => client.resolveUri(file.gfsUri, 'fixture-session-token'),
      403,
      { code: 'operator_link_inactive', message: 'operator link is inactive' }
    )
    const originalResolve = gfs.resolve.getMockImplementation()
    if (!originalResolve) throw new Error('Expected the GFS resolve boundary mock')
    gfs.resolve.mockImplementation(uri =>
      uri === file.gfsUri ? Promise.reject(new Error(authorityFailure)) : originalResolve(uri)
    )
    appHarness.useRealNavigationController = true
    appHarness.controller = makeController(
      openFilesTab(createWorkspaceTabsState('chat-tab-1'), { id: 'files-root', path: null })
    )
    renderApp()

    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await findResourceTreeRow(file.name)
    await chooseRowAction(file.name, 'Rename')

    const accessQuery = () =>
      desktopQueryClient
        .getQueryCache()
        .findAll()
        .find(query => query.queryKey[1] === 'gfs-access')
    await waitFor(() => expect(gfs.resolve).toHaveBeenCalledWith(file.gfsUri))
    await waitFor(() =>
      expect(accessQuery()?.state.data).toMatchObject({ status: 'revoked', revokeRevision: 1 })
    )
    await waitFor(() => expect(desktopQueryClient.isFetching()).toBe(0))
    await waitFor(() => expect(desktopQueryClient.isMutating()).toBe(0))

    expect(gfs.resolve).toHaveBeenCalledWith(file.gfsUri)
    expect(screen.queryAllByRole('form', { name: 'Rename resource' })).toHaveLength(0)
    expect(renameResource).not.toHaveBeenCalled()
    expect(recordedToastCalls().filter(([message]) => message === authorityFailure)).toHaveLength(0)
  })

  it('fails closed when Replace target resolution returns a typed session-authority 403', async () => {
    const file = await resolveResource(
      resolvedFile('cccccccccccccccccccccccccccccccc', 'authority-replace.bin', { version: 7 })
    )
    const { gfs, replaceFileFromPath } = installClerum([file], new Map(), {
      affordanceBits: ['read', 'write'],
    })
    const authorityFailure = await gfsRouteFailureMessage(
      client => client.resolveUri(file.gfsUri, 'fixture-session-token'),
      403,
      { code: 'gfs_operator_link_invalid', message: 'operator link is invalid' }
    )
    const originalResolve = gfs.resolve.getMockImplementation()
    if (!originalResolve) throw new Error('Expected the GFS resolve boundary mock')
    gfs.resolve.mockImplementation(uri =>
      uri === file.gfsUri ? Promise.reject(new Error(authorityFailure)) : originalResolve(uri)
    )
    appHarness.useRealNavigationController = true
    appHarness.controller = makeController(
      openFilesTab(createWorkspaceTabsState('chat-tab-1'), { id: 'files-root', path: null })
    )
    renderApp()

    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    const row = await findResourceTreeRow(file.name)
    await chooseRowAction(file.name, 'Replace file')
    const input = within(row).getByLabelText(`Replace ${file.name}`) as HTMLInputElement
    fireEvent.change(input, {
      target: {
        files: [new File(['replacement'], 'replacement.bin', { type: 'application/octet-stream' })],
      },
    })

    const accessQuery = () =>
      desktopQueryClient
        .getQueryCache()
        .findAll()
        .find(query => query.queryKey[1] === 'gfs-access')
    await waitFor(() => expect(gfs.resolve).toHaveBeenCalledWith(file.gfsUri))
    await waitFor(() =>
      expect(accessQuery()?.state.data).toMatchObject({ status: 'revoked', revokeRevision: 1 })
    )
    await waitFor(() => expect(desktopQueryClient.isFetching()).toBe(0))
    await waitFor(() => expect(desktopQueryClient.isMutating()).toBe(0))

    expect(gfs.resolve).toHaveBeenCalledWith(file.gfsUri)
    expect(replaceFileFromPath).not.toHaveBeenCalled()
    expect(recordedToastCalls().some(([message]) => message === `Replaced ${file.name}`)).toBe(
      false
    )
  })

  it('settles an authoritative target lookup error without opening a stale Rename UI', async () => {
    const parentResourceId = '11111111111111111111111111111111'
    const resourceId = '44444444444444444444444444444444'
    const parent = await resolveResource(resolvedDirectory(parentResourceId, 'Vault'))
    const clickedRow = childView(resourceId, 'report.txt', 'file', {
      parentResourceId,
      readable: true,
      version: 7,
    })
    const { gfs } = installClerum([parent], new Map(), {
      accessibleRows: [
        accessibleResource(parent.resourceId, parent.name, 'directory', {
          gfsUri: parent.gfsUri,
        }),
      ],
      childRowsByParent: new Map([[parentResourceId, [clickedRow]]]),
      affordanceBits: ['write'],
    })
    const originalResolve = gfs.resolve.getMockImplementation()
    if (!originalResolve) throw new Error('Expected the GFS resolver boundary mock')
    gfs.resolve.mockImplementation(uri =>
      uri === clickedRow.gfsUri
        ? Promise.reject(new Error('503 Service Unavailable'))
        : originalResolve(uri)
    )
    const renameResource = vi.fn(async () => ({}))
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
    expect(
      recordedToastCalls().filter(
        ([message, tone]) => message === '503 Service Unavailable' && tone === 'error'
      )
    ).toHaveLength(1)
  })

  it('settles a deleted current target without opening Rename or invoking a mutation', async () => {
    const parentResourceId = '11111111111111111111111111111111'
    const resourceId = '44444444444444444444444444444444'
    const parent = await resolveResource(resolvedDirectory(parentResourceId, 'Vault'))
    const clickedRow = childView(resourceId, 'report.txt', 'file', {
      parentResourceId,
      readable: true,
      version: 7,
    })
    const { gfs } = installClerum([parent], new Map(), {
      accessibleRows: [
        accessibleResource(parent.resourceId, parent.name, 'directory', {
          gfsUri: parent.gfsUri,
        }),
      ],
      childRowsByParent: new Map([[parentResourceId, [clickedRow]]]),
      affordanceBits: ['write'],
    })
    const originalResolve = gfs.resolve.getMockImplementation()
    if (!originalResolve) throw new Error('Expected the GFS resolver boundary mock')
    gfs.resolve.mockImplementation(uri =>
      uri === clickedRow.gfsUri
        ? Promise.reject(new Error('404 Not Found: resource deleted'))
        : originalResolve(uri)
    )
    const renameResource = vi.fn(async () => ({}))
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
    expect(
      recordedToastCalls().filter(
        ([message, tone]) => message === '404 Not Found: resource deleted' && tone === 'error'
      )
    ).toHaveLength(1)
  })

  it('cancels a pending Files action when the session generation changes', async () => {
    const target = await resolveResource(
      resolvedFile('44444444444444444444444444444444', 'session-target.txt', { version: 3 })
    )
    const delayedTarget = deferred<unknown>()
    const { deleteResource, gfs } = installClerum([target])
    appHarness.controller = makeController()
    renderApp()

    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await findResourceTreeRow(target.name)
    holdExactTargetResolve(gfs, target.gfsUri, delayedTarget)
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

  it('keeps Retry state after an already-dispatched Replace 401 reaches FilesPage catch', async () => {
    const fileA = await resolveResource(
      resolvedFile('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'authority-source.bin', { version: 2 })
    )
    const fileB = await resolveResource(
      resolvedFile('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'replace-target.bin', { version: 7 })
    )
    const { gfs, replaceFileFromPath } = installClerum([fileA, fileB], new Map(), {
      affordanceBits: ['read', 'write', 'delete'],
    })
    appHarness.controller = makeController(
      openFilesTab(createWorkspaceTabsState('chat-tab-1'), { id: 'files-root', path: null })
    )
    let rejectReplace!: (reason: unknown) => void
    const replacePending = new Promise<{}>((_resolve, reject) => {
      rejectReplace = reject
    })
    replaceFileFromPath.mockImplementation(() => replacePending)
    const authorityFailureA = await gfsRouteFailureMessage(
      client => client.affordances(fileA.resourceId, 'fixture-session-token', 'main'),
      401,
      { code: 'unauthorized', message: 'source operation revoked the session' }
    )
    const authorityFailureB = await gfsRouteFailureMessage(
      client =>
        client.replaceFile(
          {
            resourceId: fileB.resourceId,
            encodedData: 'bmV3',
            drive: 'main',
            ifMatch: fileB.version,
          },
          'fixture-session-token'
        ),
      401,
      { code: 'unauthorized', message: 'delayed Replace operation from old access interval' }
    )
    const authorityFailureCurrent = await gfsRouteFailureMessage(
      client =>
        client.replaceFile(
          {
            resourceId: fileB.resourceId,
            encodedData: 'bmV3',
            drive: 'main',
            ifMatch: fileB.version,
          },
          'fixture-session-token'
        ),
      401,
      { code: 'unauthorized', message: 'current Replace operation denied' }
    )
    const normalAffordances = affordanceMock(gfs).getMockImplementation()
    if (!normalAffordances) throw new Error('Expected the real GFS affordance boundary mock')
    let rejectPermissionA = false
    affordanceMock(gfs).mockImplementation((resourceId: string, drive?: string) => {
      if (rejectPermissionA && resourceId === fileA.resourceId)
        return Promise.reject(new Error(authorityFailureA))
      return normalAffordances(resourceId, drive)
    })
    renderApp()
    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    const rowB = await findResourceTreeRow(fileB.name)
    await chooseRowAction(fileB.name, 'Replace file')
    const inputB = within(rowB).getByLabelText(`Replace ${fileB.name}`) as HTMLInputElement
    const replacement = new File(['new bytes'], 'replacement.txt', { type: 'text/plain' })
    fireEvent.change(inputB, { target: { files: [replacement] } })
    await waitFor(() => expect(replaceFileFromPath).toHaveBeenCalledTimes(1))

    const accessQuery = () =>
      desktopQueryClient
        .getQueryCache()
        .findAll()
        .find(query => query.queryKey[1] === 'gfs-access')
    const permissionQueryA = desktopQueryClient
      .getQueryCache()
      .findAll()
      .find(
        query => query.queryKey.includes(fileA.resourceId) && query.queryKey.includes('affordances')
      )
    expect(permissionQueryA).toBeTruthy()
    rejectPermissionA = true
    await act(async () => {
      await desktopQueryClient.invalidateQueries({
        queryKey: permissionQueryA!.queryKey,
        exact: true,
        refetchType: 'none',
      })
    })
    await openRowActions(fileA.name)
    await waitFor(() =>
      expect(accessQuery()?.state.data).toMatchObject({ status: 'revoked', revokeRevision: 1 })
    )
    rejectPermissionA = false
    const listCallsBeforeRetry = gfs.listAccessible.mock.calls.length
    fireEvent.click(screen.getAllByRole('button', { name: 'Retry file access' })[0]!)
    await waitFor(() =>
      expect(accessQuery()?.state.data).toMatchObject({ status: 'active', revokeRevision: 1 })
    )
    await waitFor(() =>
      expect(gfs.listAccessible.mock.calls.length).toBeGreaterThan(listCallsBeforeRetry)
    )
    await waitFor(() => expect(desktopQueryClient.isFetching()).toBe(0))
    const retrySnapshot = desktopQueryClient
      .getQueryCache()
      .findAll()
      .find(query => query.queryKey.some(part => part === 'accessible'))?.state.data
    expect(retrySnapshot).toBeTruthy()

    await act(async () => rejectReplace(new Error(authorityFailureB)))
    await waitFor(() => expect(desktopQueryClient.isMutating()).toBe(0))
    await waitFor(() => expect(desktopQueryClient.isFetching()).toBe(0))

    const observed = {
      accessStatus: accessQuery()?.state.data,
      retrySnapshot: desktopQueryClient
        .getQueryCache()
        .findAll()
        .find(query => query.queryKey.some(part => part === 'accessible'))?.state.data,
      replaceCalls: replaceFileFromPath.mock.calls.length,
      pending: desktopQueryClient.isFetching() + desktopQueryClient.isMutating(),
    }
    expect(observed.accessStatus).toMatchObject({ status: 'active', revokeRevision: 1 })
    expect(observed.retrySnapshot).toEqual(retrySnapshot)
    expect(observed.replaceCalls).toBe(1)
    expect(observed.pending).toBe(0)
    expect(appHarness.controller.pushToast).toHaveBeenCalledWith(authorityFailureB, 'error')

    replaceFileFromPath.mockImplementationOnce(() =>
      Promise.reject(new Error(authorityFailureCurrent))
    )
    const currentRowB = await findResourceTreeRow(fileB.name)
    await chooseRowAction(fileB.name, 'Replace file')
    const currentInputB = within(currentRowB).getByLabelText(
      `Replace ${fileB.name}`
    ) as HTMLInputElement
    fireEvent.change(currentInputB, { target: { files: [replacement] } })
    await waitFor(() => expect(replaceFileFromPath).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(appHarness.controller.pushToast).toHaveBeenCalledWith(authorityFailureCurrent, 'error')
    )
    await waitFor(() =>
      expect(accessQuery()?.state.data).toMatchObject({ status: 'revoked', revokeRevision: 2 })
    )
    await waitFor(() => expect(desktopQueryClient.isMutating()).toBe(0))
    expect(
      recordedToastCalls().filter(([message]) => message === authorityFailureCurrent)
    ).toHaveLength(1)
  })

  it('keeps the Retry snapshot when dispatched Replace succeeds after access Retry', async () => {
    const fileA = await resolveResource(
      resolvedFile('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'authority-source.bin', { version: 2 })
    )
    const fileB = await resolveResource(
      resolvedFile('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'replace-target.bin', { version: 7 })
    )
    const { gfs, replaceFileFromPath } = installClerum([fileA, fileB], new Map(), {
      affordanceBits: ['read', 'write', 'delete'],
    })
    appHarness.controller = makeController(
      openFilesTab(createWorkspaceTabsState('chat-tab-1'), { id: 'files-root', path: null })
    )
    let resolveReplace!: (value: {}) => void
    const replacePending = new Promise<{}>(resolve => {
      resolveReplace = resolve
    })
    replaceFileFromPath.mockImplementation(() => replacePending)
    const authorityFailureA = await gfsRouteFailureMessage(
      client => client.affordances(fileA.resourceId, 'fixture-session-token', 'main'),
      401,
      { code: 'unauthorized', message: 'source operation revoked the session' }
    )
    const normalAffordances = affordanceMock(gfs).getMockImplementation()
    if (!normalAffordances) throw new Error('Expected the real GFS affordance boundary mock')
    let rejectPermissionA = false
    affordanceMock(gfs).mockImplementation((resourceId: string, drive?: string) => {
      if (rejectPermissionA && resourceId === fileA.resourceId)
        return Promise.reject(new Error(authorityFailureA))
      return normalAffordances(resourceId, drive)
    })
    renderApp()
    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    const rowB = await findResourceTreeRow(fileB.name)
    await chooseRowAction(fileB.name, 'Replace file')
    const inputB = within(rowB).getByLabelText(`Replace ${fileB.name}`) as HTMLInputElement
    const replacement = new File(['new bytes'], 'replacement.txt', { type: 'text/plain' })
    fireEvent.change(inputB, { target: { files: [replacement] } })
    await waitFor(() => expect(replaceFileFromPath).toHaveBeenCalledTimes(1))

    const accessQuery = () =>
      desktopQueryClient
        .getQueryCache()
        .findAll()
        .find(query => query.queryKey[1] === 'gfs-access')
    const permissionQueryA = desktopQueryClient
      .getQueryCache()
      .findAll()
      .find(
        query => query.queryKey.includes(fileA.resourceId) && query.queryKey.includes('affordances')
      )
    expect(permissionQueryA).toBeTruthy()
    rejectPermissionA = true
    await act(async () => {
      await desktopQueryClient.invalidateQueries({
        queryKey: permissionQueryA!.queryKey,
        exact: true,
        refetchType: 'none',
      })
    })
    await openRowActions(fileA.name)
    await waitFor(() =>
      expect(accessQuery()?.state.data).toMatchObject({ status: 'revoked', revokeRevision: 1 })
    )
    rejectPermissionA = false
    const listCallsBeforeRetry = gfs.listAccessible.mock.calls.length
    fireEvent.click(screen.getAllByRole('button', { name: 'Retry file access' })[0]!)
    await waitFor(() =>
      expect(accessQuery()?.state.data).toMatchObject({ status: 'active', revokeRevision: 1 })
    )
    await waitFor(() =>
      expect(gfs.listAccessible.mock.calls.length).toBeGreaterThan(listCallsBeforeRetry)
    )
    await waitFor(() => expect(desktopQueryClient.isFetching()).toBe(0))
    const retrySnapshot = desktopQueryClient
      .getQueryCache()
      .findAll()
      .find(query => query.queryKey.some(part => part === 'accessible'))?.state.data
    expect(retrySnapshot).toBeTruthy()
    const listCallsBeforeReplaceSettlement = gfs.listAccessible.mock.calls.length

    await act(async () => resolveReplace({ resultVersion: 8 }))
    await waitFor(() => expect(desktopQueryClient.isMutating()).toBe(0))
    await waitFor(() => expect(desktopQueryClient.isFetching()).toBe(0))

    const observed = {
      accessStatus: accessQuery()?.state.data,
      retrySnapshot: desktopQueryClient
        .getQueryCache()
        .findAll()
        .find(query => query.queryKey.some(part => part === 'accessible'))?.state.data,
      replaceCalls: replaceFileFromPath.mock.calls.length,
      pending: desktopQueryClient.isFetching() + desktopQueryClient.isMutating(),
    }
    expect(observed.accessStatus).toMatchObject({ status: 'active', revokeRevision: 1 })
    expect(observed.retrySnapshot).toEqual(retrySnapshot)
    expect(gfs.listAccessible).toHaveBeenCalledTimes(listCallsBeforeReplaceSettlement)
    expect(observed.replaceCalls).toBe(1)
    expect(observed.pending).toBe(0)
    expect(appHarness.controller.pushToast).toHaveBeenCalledWith(
      `Replaced ${fileB.name}`,
      'success'
    )
    expect(
      recordedToastCalls().filter(([message]) => message === `Replaced ${fileB.name}`)
    ).toHaveLength(1)
  })

  it('reuses an inactive exact-destination Files tab and completes the pending action', async () => {
    const target = await resolveResource(
      resolvedFile('22222222222222222222222222222222', 'existing-target.txt')
    )
    const initialTabs = openFilesTab(createWorkspaceTabsState('chat-tab-1'), {
      id: 'existing-target-files',
      path: null,
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
    const { gfs, deleteResource } = installClerum([targetA])
    appHarness.controller.desktopEnvironmentSetupComplete = false
    renderApp()

    expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)?.kind).toBe('chat')
    expect(appHarness.controller.workspaceTabs.tabs.some(tab => tab.kind === 'files')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /target-a\.txt/ })
    holdExactTargetResolve(gfs, targetA.gfsUri, deferredTarget)
    await chooseDeleteAction('target-a.txt')

    const breadcrumb = await screen.findByRole('button', { name: 'Shared with me' })
    expect((breadcrumb as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByText('Delete target-a.txt?')).toBeNull()
    await waitFor(() => expect(gfs.resolve).toHaveBeenCalledWith(targetA.gfsUri))
    await expectActionAtConsumer(appHarness.filesPagePendingActions, targetA.gfsUri, 'delete')
    expect(deleteResource).not.toHaveBeenCalled()

    await act(async () => {
      deferredTarget.resolve(targetA)
      await deferredTarget.promise
    })
    await confirmDelete('target-a.txt')
    await waitFor(() => expect(deleteResource).toHaveBeenCalledTimes(1))
    expect(deleteResource.mock.calls[0]).toEqual([targetA.resourceId, 'main', targetA.version])
    await waitFor(() => expect(gfs.resolve).toHaveBeenCalledWith(targetA.gfsUri))
  })

  it('cancels a pending sidebar action when its active owner tab is selected again', async () => {
    const deferredTarget = deferred<unknown>()
    const { gfs, deleteResource } = installClerum([targetA])
    appHarness.controller.desktopEnvironmentSetupComplete = false
    renderApp()

    expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)?.kind).toBe('chat')
    expect(appHarness.controller.workspaceTabs.tabs.some(tab => tab.kind === 'files')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /target-a\.txt/ })
    holdExactTargetResolve(gfs, targetA.gfsUri, deferredTarget)
    await chooseDeleteAction('target-a.txt')

    const breadcrumb = await screen.findByRole('button', { name: 'Shared with me' })
    expect((breadcrumb as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByText('Delete target-a.txt?')).toBeNull()
    await waitFor(() => expect(gfs.resolve).toHaveBeenCalledWith(targetA.gfsUri))
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
    await waitFor(() => expect(gfs.resolve).toHaveBeenCalledWith(targetA.gfsUri))
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
    const { gfs, deleteResource } = installClerum([targetA])
    appHarness.controller.desktopEnvironmentSetupComplete = false
    renderApp()

    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /target-a\.txt/ })
    holdExactTargetResolve(gfs, targetA.gfsUri, deferredTarget)
    await chooseDeleteAction('target-a.txt')

    const breadcrumb = await screen.findByRole('button', { name: 'Shared with me' })
    expect((breadcrumb as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByText('Delete target-a.txt?')).toBeNull()
    await waitFor(() => expect(gfs.resolve).toHaveBeenCalledWith(targetA.gfsUri))
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
    const { gfs, deleteResource } = installClerum([targetA])
    appHarness.controller.desktopEnvironmentSetupComplete = false
    renderApp()

    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /target-a\.txt/ })
    holdExactTargetResolve(gfs, targetA.gfsUri, deferredTarget)
    await chooseDeleteAction('target-a.txt')

    const breadcrumb = await screen.findByRole('button', { name: 'Shared with me' })
    expect((breadcrumb as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByText('Delete target-a.txt?')).toBeNull()
    await waitFor(() => expect(gfs.resolve).toHaveBeenCalledWith(targetA.gfsUri))
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
    const { gfs, deleteResource } = installClerum([targetA])
    appHarness.controller.desktopEnvironmentSetupComplete = false
    appHarness.controller.latestChatSessions = latestChatSessions
    renderApp()

    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /target-a\.txt/ })
    holdExactTargetResolve(gfs, targetA.gfsUri, deferredTarget)
    await chooseDeleteAction('target-a.txt')
    await waitFor(() => expect(gfs.resolve).toHaveBeenCalledWith(targetA.gfsUri))
    expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)).toMatchObject({
      kind: 'files',
      files: { path: null },
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
    const { gfs, deleteResource } = installClerum([targetA])
    appHarness.controller.desktopEnvironmentSetupComplete = false
    appHarness.controller.notifications = [produceConversationNotification()]
    renderApp()

    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /target-a\.txt/ })
    holdExactTargetResolve(gfs, targetA.gfsUri, deferredTarget)
    await chooseDeleteAction('target-a.txt')
    await waitFor(() => expect(gfs.resolve).toHaveBeenCalledWith(targetA.gfsUri))
    expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)).toMatchObject({
      kind: 'files',
      files: { path: null },
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
    const { gfs, deleteResource } = installClerum([targetA])
    appHarness.controller.desktopEnvironmentSetupComplete = false
    renderApp()

    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /target-a\.txt/ })
    holdExactTargetResolve(gfs, targetA.gfsUri, deferredTarget)
    await chooseDeleteAction('target-a.txt')

    expect(
      ((await screen.findByRole('button', { name: 'Shared with me' })) as HTMLButtonElement)
        .disabled
    ).toBe(true)
    await waitFor(() => expect(gfs.resolve).toHaveBeenCalledWith(targetA.gfsUri))
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
    const { gfs, deleteResource } = installClerum([targetA])
    renderApp()

    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /target-a\.txt/ })
    holdExactTargetResolve(gfs, targetA.gfsUri, deferredTarget)
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
    await waitFor(() => expect(gfs.resolve).toHaveBeenCalledWith(targetA.gfsUri))
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
    const { deleteResource, gfs } = installClerum([targetA])
    renderApp()

    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /target-a\.txt/ })
    holdExactTargetResolve(gfs, targetA.gfsUri, deferredTarget)
    await chooseDeleteAction('target-a.txt')

    const targetBreadcrumb = await screen.findByRole('button', { name: 'Shared with me' })
    expect((targetBreadcrumb as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByText('Delete target-a.txt?')).toBeNull()
    await waitFor(() => expect(gfs.resolve).toHaveBeenCalledWith(targetA.gfsUri))
    expect(deleteResource).not.toHaveBeenCalled()
    const tabs = getWorkspaceTabButtons('Files')
    expect(tabs).toHaveLength(1)

    fireEvent.click(tabs[0]!)
    await waitFor(() => expect(tabs[0]?.getAttribute('aria-pressed')).toBe('true'))
    await act(async () => {
      deferredTarget.resolve(targetA)
      await deferredTarget.promise
    })
    await waitFor(() =>
      expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)).toMatchObject({
        id: 'root-files-tab',
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

      let activeTab = activeWorkspaceTab(appHarness.controller.workspaceTabs)
      if (actionName === 'Copy file ID') {
        expect(activeTab?.kind).toBe('chat')
        expect(appHarness.controller.workspaceTabs.tabs.some(tab => tab.kind === 'files')).toBe(
          false
        )
        act(() => appHarness.controller.openFilesSectionWithReceipt())
        await waitFor(() =>
          expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)?.kind).toBe('files')
        )
        activeTab = activeWorkspaceTab(appHarness.controller.workspaceTabs)
      }

      const filesOwnerId = activeTab?.id
      expect(filesOwnerId).toBeTruthy()
      expect(activeTab?.kind).toBe('files')
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
      returnCount: number
      returnToFiles: () => Promise<void>
    }
    class ReturnToFiles implements AsyncCommand<Model, Real> {
      check(model: Model) {
        return model.active === 'files'
      }

      async run(model: Model, real: Real) {
        await real.returnToFiles()
        real.returnCount += 1
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
        fc
          .commands([fc.constant(command)], { maxCommands: 3 })
          .filter(generated => [...generated].length > 0),
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
            returnCount: 0,
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
            expect(real.returnCount).toBeGreaterThan(0)
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

  it('generates stale location report, resolver completion and Files return histories', async () => {
    type Model = {
      active: 'chat' | 'old-files'
      oldStatus: 'pending' | 'resolved'
      oldOwnerId: string
      oldDownloads: number
      oldPath: string | null
      oldLocationReported: boolean
      consumedSeed: { requestId: number; path: string } | null
    }
    type Event = { kind: 'resolve-old' } | { kind: 'report-old-location' } | { kind: 'return-old' }
    const reduceModel = (model: Model, event: Event): Model => {
      switch (event.kind) {
        case 'resolve-old':
          return {
            ...model,
            oldStatus: 'resolved',
            oldDownloads: 1,
            oldPath: null,
            consumedSeed: null,
          }
        case 'report-old-location':
          return { ...model, oldLocationReported: true, oldPath: null }
        case 'return-old':
          return { ...model, active: 'old-files' }
      }
    }
    type Real = {
      scheduler: Scheduler
      oldOwnerId: string
      oldUri: string
      resolveOld: (expectDownload: boolean) => Promise<void>
      reportOldLocation: () => Promise<void>
      returnOld: () => Promise<void>
      download: ReturnType<typeof vi.fn>
      savedFiles: string[]
      oldDownloadCount: () => number
      events: string[]
    }
    class ResolveOld implements AsyncCommand<Model, Real> {
      check(model: Model) {
        return model.oldStatus === 'pending' && model.oldLocationReported
      }
      async run(model: Model, real: Real) {
        await real.resolveOld(true)
        real.events.push('resolve-old')
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
        real.events.push('report-old-location')
        Object.assign(model, reduceModel(model, { kind: 'report-old-location' }))
        await waitFor(() =>
          expect(
            appHarness.controller.workspaceTabs.tabs.find(tab => tab.id === real.oldOwnerId)
          ).toMatchObject({ kind: 'files', files: { path: null } })
        )
      }
      toString() {
        return 'report the action-owned URI while its action is still pending'
      }
    }
    class ReturnOld implements AsyncCommand<Model, Real> {
      check(model: Model) {
        return model.oldStatus !== 'pending' && model.active !== 'old-files'
      }
      async run(model: Model, real: Real) {
        await real.returnOld()
        real.events.push('return-old')
        Object.assign(model, reduceModel(model, { kind: 'return-old' }))
        expect(model.active).toBe('old-files')
        expect(model.oldPath).toBeNull()
        expect(real.oldDownloadCount()).toBe(1)
        expect(real.download).toHaveBeenCalledTimes(model.oldDownloads)
      }
      toString() {
        return 'return to the old Files owner without replay'
      }
    }

    const commands = [new ResolveOld(), new ReportOldLocation(), new ReturnOld()]
    const generatedCommandsArbitrary = fc
      .commands(
        commands.map(command => fc.constant(command)),
        { maxCommands: 5 }
      )
      .filter(generated => {
        const names = [...generated].map(command => command.toString())
        const reportIndex = names.findIndex(name => name.includes('action-owned URI'))
        const resolveIndex = names.findIndex(name => name.includes('resolve and acknowledge'))
        const returnIndex = names.findIndex(name => name.includes('return to the old Files owner'))
        return reportIndex >= 0 && resolveIndex > reportIndex && returnIndex > resolveIndex
      })
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        generatedCommandsArbitrary,
        async (scheduler, generatedCommands) => {
          const generated = [...generatedCommands]
          const oldFile = await resolveResource(
            resolvedFile('abababababababababababababababab', 'archive.bin')
          )
          const { gfs } = installClerum([oldFile])
          let oldDownloadCount = 0
          const download = vi.fn((uri: string) => {
            expect(uri).toBe(oldFile.gfsUri)
            oldDownloadCount += 1
            return scheduler.schedule(
              Promise.resolve({ bytes: new Uint8Array([1]).buffer }),
              'old file download'
            )
          })
          Object.assign(gfs, {
            download,
          })
          const savedFiles: string[] = []
          Object.defineProperty(URL, 'createObjectURL', {
            configurable: true,
            value: vi.fn(() => 'blob:r30-stale-location'),
          })
          vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
            this: HTMLAnchorElement
          ) {
            savedFiles.push(this.download)
          })
          appHarness.useRealNavigationController = true
          renderApp()
          fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
          await findResourceTreeRow(oldFile.name)
          await chooseRowAction(oldFile.name, 'Download')
          await waitFor(() => expect(oldDownloadCount).toBe(1))
          await waitFor(() =>
            expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)?.kind).toBe('files')
          )
          const oldOwner = activeWorkspaceTab(appHarness.controller.workspaceTabs)
          expect(oldOwner?.kind).toBe('files')
          act(() => appHarness.controller.selectWorkspaceTabById('chat-tab-1'))
          await waitFor(() =>
            expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)?.kind).toBe('chat')
          )
          const initialModel: Model = {
            active: 'chat',
            oldStatus: 'pending',
            oldOwnerId: oldOwner!.id,
            oldDownloads: 0,
            oldPath: null,
            oldLocationReported: false,
            consumedSeed: null,
          }
          const real: Real = {
            scheduler,
            oldOwnerId: oldOwner!.id,
            oldUri: oldFile.gfsUri,
            events: [],
            reportOldLocation: async () => {
              act(() => appHarness.filesPageReportLocation?.(oldFile.gfsUri, oldFile.name))
            },
            resolveOld: async expectDownload => {
              await act(async () => scheduler.waitAll())
              await waitFor(() => expect(oldDownloadCount).toBeGreaterThanOrEqual(1))
              await Promise.resolve()
              await waitFor(() => expect(download).toHaveBeenCalledTimes(expectDownload ? 1 : 0))
              await waitFor(() => expect(savedFiles).toHaveLength(expectDownload ? 1 : 0))
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
            oldDownloadCount: () => oldDownloadCount,
          }
          let model = initialModel
          try {
            await fc.asyncModelRun(() => ({ model, real }), generated)
            expect(model.oldStatus).toBe('resolved')
            expect(model.oldLocationReported).toBe(true)
            expect(model.oldPath).toBeNull()
            expect(model.consumedSeed).toBeNull()
            expect(model.active).toBe('old-files')
            await scheduler.waitAll()
            await waitFor(() => expect(appHarness.filesPageLatestPendingAction).toBeNull())
            expect(download).toHaveBeenCalledTimes(model.oldDownloads)
            expect(savedFiles).toHaveLength(model.oldDownloads)
            expect(oldDownloadCount).toBe(1)
            expect(real.events).toEqual(['report-old-location', 'resolve-old', 'return-old'])
            expect(screen.queryByRole('heading', { name: 'Preview' })).toBeNull()
            if (model.consumedSeed) {
              expect(model.consumedSeed.path).toBe(oldFile.gfsUri)
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
        return !model.explicit && !model.closed
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
    act(() => appHarness.controller.openFilesSectionWithReceipt())
    await waitFor(() =>
      expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)).toMatchObject({
        kind: 'files',
        files: { path: null },
      })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await findResourceTreeRow(archive.name)
    await chooseRowAction(archive.name, 'Copy file ID')
    await scheduler.waitAll()
    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledTimes(1))
    const owner = activeWorkspaceTab(appHarness.controller.workspaceTabs)
    expect(owner?.kind).toBe('files')
    const ownerTabId = owner!.id
    expect(appHarness.filesPagePendingActions).toHaveLength(0)
    const model: Model = {
      activeTabId: ownerTabId,
      requestId: 0,
      consumedSeed: null,
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
    expect(targetCallCount).toBe(1)
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
    expect(newOwner!.id).toBe(oldOwnerId)
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
    const { gfs, deleteResource } = installClerum([archive, second])
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
    await chooseDeleteAction(archive.name)
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
      consumedSeed: null,
      oldDownloads: 0,
      explicitDownloads: 0,
      locationReports: 0,
      settled: false,
      path: null,
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
    expect(deleteResource).not.toHaveBeenCalled()
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
    act(() => appHarness.filesPageReportLocation?.(file.gfsUri, 'before.txt'))
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
    act(() => appHarness.controller.openFilesSectionWithReceipt())
    await waitFor(() =>
      expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)).toMatchObject({
        kind: 'files',
        files: { path: null },
      })
    )
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

  it('lets a confirmed GFS deep link replace the action owner expected location', async () => {
    const parent = await resolveResource(
      resolvedDirectory('11111111111111111111111111111111', 'Vault')
    )
    const file = await resolveResource(
      resolvedFile('44444444444444444444444444444444', 'report.txt', {
        parentResourceId: parent.resourceId,
      })
    )
    const linkedFolder = await resolveResource(
      resolvedDirectory('55555555555555555555555555555555', 'Linked folder')
    )
    const { gfs } = installClerum([parent, file, linkedFolder], new Map(), {
      accessibleRows: [
        accessibleResource(parent.resourceId, parent.name, 'directory', {
          gfsUri: parent.gfsUri,
        }),
        accessibleResource(linkedFolder.resourceId, linkedFolder.name, 'directory', {
          gfsUri: linkedFolder.gfsUri,
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
    })
    const download = vi.fn(async () => ({ bytes: new Uint8Array([1]).buffer }))
    const savedFiles: string[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement
    ) {
      savedFiles.push(this.download)
    })
    Object.assign(gfs, { download })
    appHarness.useRealNavigationController = true
    renderApp()

    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    const parentRow = await screen.findByRole('treeitem', { name: /Vault/ })
    fireEvent.click(within(parentRow).getByRole('button', { name: 'Expand Vault' }))
    await chooseRowAction(file.name, 'Download')
    await waitFor(() => expect(download).toHaveBeenCalledOnce())
    expect(savedFiles).toEqual([file.name])
    await waitFor(() => expect(appHarness.filesPageLatestPendingAction).toBeNull())
    expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)).toMatchObject({
      kind: 'files',
      files: { path: parent.gfsUri },
    })

    const link: GfsResourceDeepLinkEnvelope = {
      id: 1,
      uri: linkedFolder.gfsUri,
      userNavigationGenerationAtActivation: 0,
    }
    await waitFor(() => expect(appHarness.emitGfsDeepLink).toBeTypeOf('function'))
    act(() => appHarness.emitGfsDeepLink?.(link))
    await screen.findByRole('dialog', { name: 'Open EvenDrive link?' })
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    await waitFor(() => expect(gfs.resolve).toHaveBeenCalledWith(linkedFolder.gfsUri))
    await waitFor(() => expect(appHarness.filesPageReportLocation).toBeTypeOf('function'))
    act(() => {
      appHarness.filesPageReportLocation?.(linkedFolder.gfsUri, linkedFolder.name)
    })

    await waitFor(() =>
      expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)).toMatchObject({
        kind: 'files',
        files: { path: linkedFolder.gfsUri },
      })
    )
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

  it('A01 r17 D4: rejected D2 refetch preserves fallback focus', async () => {
    const file = await resolveResource(resolvedFile('db'.repeat(16), 'a01-r16-refetch-error.txt'))
    const changedPage = await listAccessiblePage([
      accessibleResource(file.resourceId, file.name, 'file', {
        gfsUri: `gfs://main/${'dc'.repeat(16)}`,
        parentResourceId: file.parentResourceId,
        version: file.version + 1,
      }),
    ])
    const pendingPermission = deferred<Awaited<ReturnType<typeof resourceAffordances>>>()
    const pendingRefetch = deferred<Awaited<ReturnType<typeof listAccessiblePage>>>()
    const writeText = vi.fn(async (_text: string) => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const { controller, gfs } = await renderActualA01App([file], writeText)
    const queryKey = desktopQueryKeys.gfsAccessible('a01-environment:a01-user:team-a', 'main', 1)
    const invalidationFocus: Element[] = []
    const originalInvalidate = desktopQueryClient.invalidateQueries.bind(desktopQueryClient)
    const invalidate = vi
      .spyOn(desktopQueryClient, 'invalidateQueries')
      .mockImplementation((filters, options) => {
        if (
          JSON.stringify(filters?.queryKey) === JSON.stringify(queryKey) &&
          filters?.exact === true
        ) {
          invalidationFocus.push(document.activeElement as Element)
        }
        return originalInvalidate(filters, options)
      })
    gfs.affordances.mockImplementation(async () => pendingPermission.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /a01-r16-refetch-error\.txt/ })
    await chooseRowActionByKeyboard(file.name, 'Copy file ID')
    await waitFor(() => expect(gfs.affordances).toHaveBeenCalledTimes(1))
    const opener = getResourceTreeRow(file.name)?.querySelector<HTMLButtonElement>(
      '.da-file-explorer__label'
    )
    expect(opener).toBeTruthy()
    act(() =>
      desktopQueryClient.setQueryData(queryKey, { pages: [changedPage], pageParams: [undefined] })
    )
    gfs.listAccessible.mockImplementation(async () => pendingRefetch.promise)
    await act(async () => pendingPermission.resolve(await resourceAffordances(['read'])))
    await waitFor(() =>
      expect(controller.current?.toasts).toContainEqual(
        expect.objectContaining({
          text: 'This resource is no longer available from its parent folder.',
          tone: 'error',
        })
      )
    )
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(gfs.listAccessible).toHaveBeenCalledTimes(2))
    const toggle = screen.getByTestId('nav-files-explorer-toggle')
    expect(invalidationFocus).toEqual([toggle])
    pendingRefetch.reject(new Error('controlled accessible-row refetch failure'))
    await expect(pendingRefetch.promise).rejects.toThrow(
      'controlled accessible-row refetch failure'
    )
    await waitFor(() => expect(getResourceTreeRow(file.name)).toBeTruthy())

    expect(writeText).not.toHaveBeenCalled()
    expect(invalidate).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey, exact: true, refetchType: 'active' }),
      expect.anything()
    )
    expect(invalidate).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(toggle)
    await waitFor(() => expect(desktopQueryClient.isFetching({ queryKey, exact: true })).toBe(0))
    expect(document.activeElement).toBe(toggle)
    expect(activeWorkspaceTab(controller.current!.workspaceTabs)?.kind).toBe('chat')
    expect(screen.queryAllByRole('dialog')).toHaveLength(0)
  })

  it('A01 r17 D4 G2: mismatch focuses the connected toggle before parent refetch', async () => {
    const file = await resolveResource(resolvedFile('e1'.repeat(16), 'a01-d4-focus-boundary.txt'))
    const mismatchedPage = await listAccessiblePage([
      accessibleResource(file.resourceId, file.name, 'file', {
        gfsUri: `gfs://main/${'e2'.repeat(16)}`,
        parentResourceId: file.parentResourceId,
        version: file.version + 1,
      }),
    ])
    const pendingPermission = deferred<Awaited<ReturnType<typeof resourceAffordances>>>()
    const writeText = vi.fn(async (_text: string) => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const { controller, gfs } = await renderActualA01App([file], writeText)
    const queryKey = desktopQueryKeys.gfsAccessible('a01-environment:a01-user:team-a', 'main', 1)
    const toggle = screen.getByTestId('nav-files-explorer-toggle')
    const invalidationFocus: Element[] = []
    const originalInvalidate = desktopQueryClient.invalidateQueries.bind(desktopQueryClient)
    const invalidate = vi
      .spyOn(desktopQueryClient, 'invalidateQueries')
      .mockImplementation((filters, options) => {
        if (
          JSON.stringify(filters?.queryKey) === JSON.stringify(queryKey) &&
          filters?.exact === true
        ) {
          invalidationFocus.push(document.activeElement as Element)
        }
        return originalInvalidate(filters, options)
      })
    gfs.affordances.mockImplementation(async () => pendingPermission.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /a01-d4-focus-boundary\.txt/ })
    await chooseRowActionByKeyboard(file.name, 'Copy file ID')
    await waitFor(() => expect(gfs.affordances).toHaveBeenCalledTimes(1))
    const opener = getResourceTreeRow(file.name)?.querySelector<HTMLButtonElement>(
      '.da-file-explorer__label'
    )
    if (!opener) throw new Error('The D4 keyboard Copy ID opener was not mounted')
    await waitFor(() => expect(document.activeElement).toBe(opener))

    gfs.listAccessible.mockImplementation(async () => mismatchedPage)
    act(() =>
      desktopQueryClient.setQueryData(queryKey, {
        pages: [mismatchedPage],
        pageParams: [undefined],
      })
    )
    await act(async () => pendingPermission.resolve(await resourceAffordances(['read'])))
    await waitFor(() =>
      expect(controller.current?.toasts).toContainEqual(
        expect.objectContaining({
          text: 'This resource is no longer available from its parent folder.',
          tone: 'error',
        })
      )
    )
    expect(document.activeElement).toBe(toggle)
    expect(toggle.isConnected).toBe(true)
    expect(invalidationFocus).toEqual([toggle])
    expect(writeText).not.toHaveBeenCalled()
    await waitFor(() => expect(desktopQueryClient.isFetching({ queryKey, exact: true })).toBe(0))
    expect(invalidate).toHaveBeenCalledTimes(1)
    expect(activeWorkspaceTab(controller.current!.workspaceTabs)?.kind).toBe('chat')
    expect(screen.queryAllByRole('dialog')).toHaveLength(0)
  })

  type DifferentialFocusModel = {
    contract: A01A4Input
    opened: boolean
    mode: 'identity-update' | 'root-removal' | 'terminal-mismatch' | null
    started: boolean
    drained: boolean
    audited: boolean
    userIntent: boolean
    ownerSuperseded: boolean
    focusTarget: 'chat' | 'files' | 'sibling' | 'session' | null
    eventOrder: string[]
  }

  function resolveA01FocusTarget(
    target: 'body' | 'opener' | 'toggle' | 'chat' | 'files' | 'sibling',
    controls: {
      body: HTMLElement
      opener: HTMLElement
      toggle: HTMLElement
      chat: HTMLElement
      files: HTMLElement
      sibling: HTMLElement
    }
  ) {
    return controls[target]
  }

  type DifferentialFocusReal = {
    scheduler: Scheduler
    opener: HTMLButtonElement
    toggle: HTMLButtonElement
    filesRoute: HTMLButtonElement
    userControl: HTMLButtonElement
    transientControl: HTMLButtonElement
    open: () => Promise<void>
    start: (mode: 'identity-update' | 'root-removal' | 'terminal-mismatch') => Promise<void>
    supersedeFocus: () => void
    supersedeTransientFocus: () => void
    supersedeOwner: () => void
    supersedeSession: () => Promise<void>
    drain: (model: DifferentialFocusModel) => Promise<string[]>
    audit: (model: DifferentialFocusModel) => Promise<void>
  }
  class DifferentialOpenCopy implements AsyncCommand<
    DifferentialFocusModel,
    DifferentialFocusReal
  > {
    check(model: Readonly<DifferentialFocusModel>) {
      return !model.opened
    }
    async run(model: DifferentialFocusModel, real: DifferentialFocusReal) {
      await real.open()
      model.opened = true
    }
    toString() {
      return 'open Copy ID while permission is pending'
    }
  }
  class DifferentialIdentityRace implements AsyncCommand<
    DifferentialFocusModel,
    DifferentialFocusReal
  > {
    check(model: Readonly<DifferentialFocusModel>) {
      return model.opened && !model.started
    }
    async run(model: DifferentialFocusModel, real: DifferentialFocusReal) {
      model.mode = 'identity-update'
      model.contract.binding = 'metadata-only'
      await real.start('identity-update')
      model.started = true
    }
    toString() {
      return 'race a current-row identity update against permission settlement'
    }
  }
  class DifferentialRootRace implements AsyncCommand<
    DifferentialFocusModel,
    DifferentialFocusReal
  > {
    check(model: Readonly<DifferentialFocusModel>) {
      return model.opened && !model.started
    }
    async run(model: DifferentialFocusModel, real: DifferentialFocusReal) {
      model.mode = 'root-removal'
      model.contract.binding = 'different-uri'
      await real.start('root-removal')
      model.started = true
    }
    toString() {
      return 'race a root-query row removal against permission settlement'
    }
  }
  class DifferentialTerminalMismatch implements AsyncCommand<
    DifferentialFocusModel,
    DifferentialFocusReal
  > {
    check(model: Readonly<DifferentialFocusModel>) {
      return model.opened && !model.started
    }
    async run(model: DifferentialFocusModel, real: DifferentialFocusReal) {
      model.mode = 'terminal-mismatch'
      model.contract.binding = 'missing'
      await real.start('terminal-mismatch')
      model.contract.permissionGranted = true
      model.contract.d2Observed = true
      model.started = true
    }
    toString() {
      return 'introduce a real URI mismatch while the keyboard opener stays mounted'
    }
  }
  class DifferentialConcurrentDrain implements AsyncCommand<
    DifferentialFocusModel,
    DifferentialFocusReal
  > {
    check(model: Readonly<DifferentialFocusModel>) {
      return model.started && !model.drained
    }
    async run(model: DifferentialFocusModel, real: DifferentialFocusReal) {
      model.eventOrder = await real.drain(model)
      model.drained = true
    }
    toString() {
      return 'settle concurrently pending producers in scheduler-selected order'
    }
  }
  class DifferentialUserFocus implements AsyncCommand<
    DifferentialFocusModel,
    DifferentialFocusReal
  > {
    check(model: Readonly<DifferentialFocusModel>) {
      return model.started && !model.userIntent && !model.drained
    }
    async run(model: DifferentialFocusModel, real: DifferentialFocusReal) {
      real.supersedeFocus()
      model.userIntent = true
      model.focusTarget = 'chat'
      model.contract.newerFocus = 'chat'
      model.contract.newerFocusConnected = true
    }
    toString() {
      return 'user focuses Go to Chat while the real parent refetch is pending'
    }
  }
  class DifferentialOwnerSupersession implements AsyncCommand<
    DifferentialFocusModel,
    DifferentialFocusReal
  > {
    check(model: Readonly<DifferentialFocusModel>) {
      return model.started && !model.ownerSuperseded && !model.drained
    }
    async run(model: DifferentialFocusModel, real: DifferentialFocusReal) {
      real.supersedeOwner()
      model.ownerSuperseded = true
      model.focusTarget = 'files'
      model.contract.navigationCurrent = false
      model.contract.ownerCurrent = false
      model.contract.newerFocus = 'files'
      model.contract.newerFocusConnected = true
      model.contract.surface = 'files'
    }
    toString() {
      return 'navigate to Files while the real parent refetch is pending'
    }
  }
  class DifferentialSessionSupersession implements AsyncCommand<
    DifferentialFocusModel,
    DifferentialFocusReal
  > {
    check(model: Readonly<DifferentialFocusModel>) {
      return (
        model.started &&
        model.mode === 'terminal-mismatch' &&
        !model.ownerSuperseded &&
        !model.drained
      )
    }
    async run(model: DifferentialFocusModel, real: DifferentialFocusReal) {
      await real.supersedeSession()
      model.ownerSuperseded = true
      model.userIntent = true
      model.focusTarget = 'session'
      model.contract.sessionCurrent = false
    }
    toString() {
      return 'logout while the real parent refetch is pending'
    }
  }
  class DifferentialTransientFocus implements AsyncCommand<
    DifferentialFocusModel,
    DifferentialFocusReal
  > {
    check(model: Readonly<DifferentialFocusModel>) {
      return model.started && !model.userIntent && !model.ownerSuperseded && !model.drained
    }
    async run(model: DifferentialFocusModel, real: DifferentialFocusReal) {
      real.supersedeTransientFocus()
      model.userIntent = true
      model.focusTarget = 'sibling'
      model.contract.newerFocus = 'sibling'
      model.contract.newerFocusConnected = true
    }
    toString() {
      return 'focus a sibling row before D2 removes both rows'
    }
  }
  class DifferentialAudit implements AsyncCommand<DifferentialFocusModel, DifferentialFocusReal> {
    check(model: Readonly<DifferentialFocusModel>) {
      return model.drained && !model.audited
    }
    async run(model: DifferentialFocusModel, real: DifferentialFocusReal) {
      await real.audit(model)
      model.audited = true
    }
    toString() {
      return 'compare quiescent App observations with the independent A4 model'
    }
  }

  it('A01 r17 A6: generated real-App differential event and promise schedules', async () => {
    const file = await resolveResource(resolvedFile('e5'.repeat(16), 'a01-r17-generated.txt'))
    const sibling = await resolveResource(resolvedFile('e6'.repeat(16), 'a01-r17-sibling.txt'))
    const clickedUri = file.gfsUri
    const changedPage = await listAccessiblePage([
      accessibleResource(file.resourceId, file.name, 'file', {
        gfsUri: file.gfsUri,
        parentResourceId: file.parentResourceId,
        version: file.version + 1,
        name: `${file.name}.renamed`,
      }),
      accessibleResource(sibling.resourceId, sibling.name, 'file', {
        gfsUri: sibling.gfsUri,
        parentResourceId: sibling.parentResourceId,
        version: sibling.version,
      }),
    ])
    const mismatchedPage = await listAccessiblePage([
      accessibleResource(file.resourceId, file.name, 'file', {
        gfsUri: `gfs://main/${'a7'.repeat(16)}`,
        parentResourceId: file.parentResourceId,
        version: file.version + 1,
      }),
      accessibleResource(sibling.resourceId, sibling.name, 'file', {
        gfsUri: sibling.gfsUri,
        parentResourceId: sibling.parentResourceId,
        version: sibling.version,
      }),
    ])
    const observedCases = new Set<string>()

    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.commands(
          [
            fc.constant(new DifferentialOpenCopy()),
            fc.constant(new DifferentialIdentityRace()),
            fc.constant(new DifferentialRootRace()),
            fc.constant(new DifferentialTerminalMismatch()),
            fc.constant(new DifferentialUserFocus()),
            fc.constant(new DifferentialOwnerSupersession()),
            fc.constant(new DifferentialSessionSupersession()),
            fc.constant(new DifferentialTransientFocus()),
            fc.constant(new DifferentialConcurrentDrain()),
            fc.constant(new DifferentialAudit()),
          ],
          { maxCommands: 18, size: 'max' }
        ),
        async (scheduler, generatedCommands) => {
          vi.restoreAllMocks()
          cleanup()
          mockSidebarBounds()
          desktopQueryClient.clear()
          const pendingPermission = deferred<Awaited<ReturnType<typeof resourceAffordances>>>()
          const pendingD2Refetch = deferred<Awaited<ReturnType<typeof listAccessiblePage>>>()
          const emptyPage = await listAccessiblePage([])
          const writeText = vi.fn(async (_text: string) => undefined)
          Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText },
          })
          const { controller, gfs } = await renderActualA01App([file, sibling], writeText)
          const queryKey = desktopQueryKeys.gfsAccessible(
            'a01-environment:a01-user:team-a',
            'main',
            1
          )
          let opener: HTMLButtonElement | null = null
          expect(navigator.clipboard.writeText).toBe(writeText)
          expect(window.navigator.clipboard.writeText).toBe(writeText)
          const exactInvalidationFocus: Element[] = []
          const exactInvalidationOpenerConnected: boolean[] = []
          const originalInvalidate = desktopQueryClient.invalidateQueries.bind(desktopQueryClient)
          const d2Invalidation = vi
            .spyOn(desktopQueryClient, 'invalidateQueries')
            .mockImplementation((filters, options) => {
              if (
                JSON.stringify(filters?.queryKey) === JSON.stringify(queryKey) &&
                filters?.exact === true
              ) {
                exactInvalidationFocus.push(document.activeElement as Element)
                exactInvalidationOpenerConnected.push(opener?.isConnected ?? false)
              }
              return originalInvalidate(filters, options)
            })
          const parentInvalidationCount = () =>
            d2Invalidation.mock.calls.filter(
              ([filters]) =>
                JSON.stringify(filters?.queryKey) === JSON.stringify(queryKey) &&
                filters?.exact === true
            ).length
          gfs.affordances.mockImplementation(async () => pendingPermission.promise)
          fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
          await screen.findByRole('treeitem', { name: /a01-r17-generated\.txt/ })
          opener =
            getResourceTreeRow(file.name)?.querySelector<HTMLButtonElement>(
              '.da-file-explorer__label'
            ) ?? null
          const toggle = screen.getByTestId('nav-files-explorer-toggle') as HTMLButtonElement
          const filesRoute = screen.getByRole('button', { name: 'Files' }) as HTMLButtonElement
          const userControl = screen.getByRole('button', {
            name: 'Go to Chat',
          }) as HTMLButtonElement
          const transientControl =
            getResourceTreeRow(sibling.name)?.querySelector<HTMLButtonElement>(
              '.da-file-explorer__label'
            ) ?? null
          if (!transientControl) throw new Error('The sibling focus target is unavailable')
          expect(opener).toBeTruthy()
          let mode: 'identity-update' | 'root-removal' | 'terminal-mismatch' | null = null
          let rootInvalidation: Promise<void> | undefined
          let userFocusSuperseded = false
          let ownerSuperseded = false
          let transientFocusSuperseded = false
          let sessionSuperseded = false
          const eventOrder: string[] = []
          const keyboardFocusScenario = true
          const real: DifferentialFocusReal = {
            scheduler,
            opener: opener!,
            toggle,
            filesRoute,
            userControl,
            transientControl: transientControl!,
            open: async () => {
              if (keyboardFocusScenario) {
                await chooseRowActionByKeyboard(file.name, 'Copy file ID')
              } else {
                await chooseRowAction(file.name, 'Copy file ID')
              }
              await waitFor(() => expect(gfs.affordances).toHaveBeenCalledTimes(1))
              if (keyboardFocusScenario) {
                await waitFor(() => expect(document.activeElement).toBe(opener))
              }
            },
            start: async nextMode => {
              mode = nextMode
              d2Invalidation.mockClear()
              if (nextMode === 'root-removal') {
                gfs.listAccessible.mockImplementation(async () => pendingD2Refetch.promise)
                rootInvalidation = desktopQueryClient.invalidateQueries({
                  queryKey,
                  exact: true,
                  refetchType: 'active',
                })
                await waitFor(() => expect(gfs.listAccessible).toHaveBeenCalledTimes(2))
              } else if (nextMode === 'terminal-mismatch') {
                gfs.listAccessible.mockImplementation(async () => pendingD2Refetch.promise)
                act(() => {
                  desktopQueryClient.setQueryData(queryKey, {
                    pages: [mismatchedPage],
                    pageParams: [undefined],
                  })
                })
                await scheduler.waitFor(
                  scheduler
                    .schedule(Promise.resolve(), 'permission result starts real D2 refetch')
                    .then(async () => {
                      eventOrder.push('permission-result')
                      await act(async () => {
                        pendingPermission.resolve(await resourceAffordances(['read']))
                      })
                    })
                )
                await waitFor(() => expect(getResourceTreeRow(file.name)).toBeTruthy())
                await waitFor(() => expect(d2Invalidation).toHaveBeenCalledTimes(1))
                await waitFor(() => expect(gfs.listAccessible).toHaveBeenCalledTimes(2))
                expect(exactInvalidationOpenerConnected).toEqual([true])
                expect(exactInvalidationFocus[0]).toBe(toggle)
              }
            },
            supersedeFocus: () => {
              userControl.focus()
              userFocusSuperseded = true
              eventOrder.push('user-focus')
              expect(document.activeElement).toBe(userControl)
            },
            supersedeTransientFocus: () => {
              transientControl!.focus()
              userFocusSuperseded = true
              transientFocusSuperseded = true
              eventOrder.push('transient-user-focus')
              expect(document.activeElement).toBe(transientControl)
            },
            supersedeOwner: () => {
              filesRoute.focus()
              fireEvent.click(filesRoute)
              userFocusSuperseded = true
              ownerSuperseded = true
              eventOrder.push('owner-navigation')
              expect(document.activeElement).toBe(filesRoute)
            },
            supersedeSession: async () => {
              await act(async () => controller.current?.handleLogout())
              sessionSuperseded = true
              eventOrder.push('session-logout')
              expect(controller.current?.isAuthenticated).toBe(false)
            },
            drain: async model => {
              if (mode === 'root-removal') {
                // S24: the real root producer removes the opener while the actual
                // affordance producer remains unresolved. Keep this ordering explicit.
                const rootResult = scheduler
                  .schedule(Promise.resolve(), 'real root producer result before permission')
                  .then(async () => {
                    eventOrder.push('root-result')
                    await act(async () => pendingD2Refetch.resolve(emptyPage))
                  })
                await scheduler.waitFor(rootResult)
                await act(async () => rootInvalidation)
                await waitFor(() => expect(getResourceTreeRow(file.name)).toBeNull())
                model.contract.openerConnected = false
                model.contract.newerFocusConnected =
                  model.focusTarget === 'files'
                    ? filesRoute.isConnected
                    : model.focusTarget === 'chat'
                      ? userControl.isConnected
                      : model.focusTarget === 'sibling' && transientControl!.isConnected
                const beforePermission = evaluateA01A4(model.contract)
                expect(document.activeElement).toBe(
                  resolveA01FocusTarget(beforePermission.focus, {
                    body: document.body,
                    opener: opener!,
                    toggle,
                    chat: userControl,
                    files: filesRoute,
                    sibling: transientControl!,
                  })
                )
                const expectedFocus =
                  model.focusTarget === 'session' || model.focusTarget === 'sibling'
                    ? document.body
                    : model.focusTarget === 'files'
                      ? filesRoute
                      : model.focusTarget === 'chat'
                        ? userControl
                        : toggle
                expect(document.activeElement).toBe(expectedFocus)
                d2Invalidation.mockClear()
                await scheduler.waitFor(
                  scheduler
                    .schedule(Promise.resolve(), 'permission result after root removal')
                    .then(async () => {
                      await act(async () => {
                        eventOrder.push('permission-result')
                        pendingPermission.resolve(await resourceAffordances(['read']))
                      })
                    })
                )
                if (!ownerSuperseded) {
                  model.contract.permissionGranted = true
                  model.contract.d2Observed = true
                }
                await scheduler.waitAll()
                if (ownerSuperseded) {
                  expect(controller.current?.toasts).not.toContainEqual(
                    expect.objectContaining({
                      text: 'This resource is no longer available from its parent folder.',
                      tone: 'error',
                    })
                  )
                  expect(parentInvalidationCount()).toBe(0)
                  expect(gfs.listAccessible).toHaveBeenCalledTimes(2)
                } else {
                  await waitFor(() =>
                    expect(controller.current?.toasts).toContainEqual(
                      expect.objectContaining({
                        text: 'This resource is no longer available from its parent folder.',
                        tone: 'error',
                      })
                    )
                  )
                  await waitFor(() => expect(gfs.listAccessible).toHaveBeenCalledTimes(3))
                  expect(parentInvalidationCount()).toBe(1)
                }
                await waitFor(() =>
                  expect(desktopQueryClient.isFetching({ queryKey, exact: true })).toBe(0)
                )
                return [...eventOrder]
              }
              if (mode === 'terminal-mismatch') {
                await waitFor(() => expect(d2Invalidation).toHaveBeenCalledTimes(1))
                await waitFor(() => expect(gfs.listAccessible).toHaveBeenCalledTimes(2))
                const d2Result = scheduler
                  .schedule(Promise.resolve(), 'real D2 parent-query result')
                  .then(async () => {
                    await act(async () => pendingD2Refetch.resolve(emptyPage))
                  })
                await scheduler.waitFor(d2Result)
                await act(async () => d2Invalidation.mock.results[0]?.value)
                await waitFor(() =>
                  expect(desktopQueryClient.isFetching({ queryKey, exact: true })).toBe(0)
                )
                await waitFor(() => expect(getResourceTreeRow(file.name)).toBeNull())
                await waitFor(() => expect(getResourceTreeRow(sibling.name)).toBeNull())
                model.contract.openerConnected = false
                model.contract.newerFocusConnected =
                  model.focusTarget === 'files'
                    ? filesRoute.isConnected
                    : model.focusTarget === 'chat'
                      ? userControl.isConnected
                      : model.focusTarget === 'sibling' && transientControl!.isConnected
                if (sessionSuperseded) {
                  expect(toggle.isConnected).toBe(false)
                  expect(document.activeElement).toBe(document.body)
                  expect(writeText).not.toHaveBeenCalled()
                  expect(parentInvalidationCount()).toBe(1)
                  observedCases.add('terminal-mismatch:session-logout')
                  return [...eventOrder]
                }
                await waitFor(() =>
                  expect(controller.current?.toasts).toContainEqual(
                    expect.objectContaining({
                      text: 'This resource is no longer available from its parent folder.',
                      tone: 'error',
                    })
                  )
                )
                return [...eventOrder]
              }
              const runQuery = scheduler
                .schedule(Promise.resolve(), 'current row identity query result')
                .then(() => {
                  act(() => {
                    eventOrder.push('identity-update')
                    desktopQueryClient.setQueryData(queryKey, {
                      pages: [changedPage],
                      pageParams: [undefined],
                    })
                  })
                })
              const runPermission = scheduler
                .schedule(Promise.resolve(), 'real permission producer result')
                .then(async () => {
                  await act(async () => {
                    eventOrder.push('permission-result')
                    pendingPermission.resolve(await resourceAffordances(['read']))
                  })
                })
              await scheduler.waitFor(Promise.all([runQuery, runPermission]))
              model.contract.permissionGranted = true
              await act(async () => scheduler.waitIdle())
              if (ownerSuperseded) {
                expect(writeText).not.toHaveBeenCalled()
              } else {
                await waitFor(() => expect(writeText).toHaveBeenCalledWith(clickedUri))
              }
              expect(runQuery).toBeDefined()
              expect(runPermission).toBeDefined()
              return [...eventOrder]
            },
            audit: async model => {
              if (model.mode === 'root-removal') {
                const expected = evaluateA01A4(model.contract)
                expect(writeText.mock.calls.map(([value]) => value)).toEqual(expected.writes)
                expect(parentInvalidationCount()).toBe(expected.exactParentInvalidations)
                expect(activeWorkspaceTab(controller.current!.workspaceTabs)?.kind).toBe(
                  expected.surface
                )
                expect(screen.queryAllByRole('dialog')).toHaveLength(0)
                expect(document.activeElement).toBe(
                  resolveA01FocusTarget(expected.focus, {
                    body: document.body,
                    opener: opener!,
                    toggle,
                    chat: userControl,
                    files: filesRoute,
                    sibling: transientControl!,
                  })
                )
                observedCases.add('root-removal:root-first')
                return
              }
              if (model.mode === 'terminal-mismatch') {
                const expected = evaluateA01A4(model.contract)
                expect(writeText.mock.calls.map(([value]) => value)).toEqual(expected.writes)
                const hasStaleError =
                  controller.current?.toasts.some(
                    toast =>
                      toast.text === 'This resource is no longer available from its parent folder.'
                  ) ?? false
                expect(hasStaleError).toBe(expected.staleError)
                expect(parentInvalidationCount()).toBe(expected.exactParentInvalidations)
                expect(activeWorkspaceTab(controller.current!.workspaceTabs)?.kind).toBe(
                  expected.surface
                )
                expect(screen.queryAllByRole('dialog')).toHaveLength(0)
                expect(document.activeElement).toBe(
                  resolveA01FocusTarget(expected.focus, {
                    body: document.body,
                    opener: opener!,
                    toggle,
                    chat: userControl,
                    files: filesRoute,
                    sibling: transientControl!,
                  })
                )
                observedCases.add(
                  `terminal-mismatch:${ownerSuperseded ? 'owner-navigation' : transientFocusSuperseded ? 'transient-user-focus' : 'user-focus'}`
                )
                return
              }
              const expected = evaluateA01A4(model.contract)
              expect(writeText.mock.calls.map(([value]) => value)).toEqual(expected.writes)
              const hasStaleError =
                controller.current?.toasts.some(
                  toast =>
                    toast.text === 'This resource is no longer available from its parent folder.'
                ) ?? false
              expect(hasStaleError).toBe(expected.staleError)
              expect(parentInvalidationCount()).toBe(expected.exactParentInvalidations)
              expect(activeWorkspaceTab(controller.current!.workspaceTabs)?.kind).toBe(
                expected.surface
              )
              expect(screen.queryAllByRole('dialog')).toHaveLength(0)
              const focusMatches =
                document.activeElement ===
                resolveA01FocusTarget(expected.focus, {
                  body: document.body,
                  opener: opener!,
                  toggle,
                  chat: userControl,
                  files: filesRoute,
                  sibling: transientControl!,
                })
              const queryWins =
                model.eventOrder.indexOf('identity-update') <
                model.eventOrder.indexOf('permission-result')
              const caseKey = `${mode}:${queryWins ? 'query-first' : 'permission-first'}`
              observedCases.add(caseKey)
              expect(focusMatches).toBe(true)
              expect(opener!.isConnected).toBe(true)
            },
          }
          const model: DifferentialFocusModel = {
            contract: {
              clickedUri,
              requestCurrent: true,
              permissionGranted: false,
              binding: 'same',
              d2Observed: false,
              sessionCurrent: true,
              navigationCurrent: true,
              ownerCurrent: true,
              newerFocus: null,
              newerFocusConnected: false,
              openerConnected: true,
              toggleConnected: true,
              surface: 'chat',
            },
            opened: false,
            mode: null,
            started: false,
            drained: false,
            audited: false,
            userIntent: false,
            ownerSuperseded: false,
            focusTarget: null,
            eventOrder: [],
          }
          try {
            await fc.asyncModelRun(() => ({ model, real }), generatedCommands)
            fc.pre(model.opened && model.started && model.drained && model.audited)
            expect(model.opened && model.started && model.drained && model.audited).toBe(true)
            expect(model.mode).not.toBeNull()
          } finally {
            await act(async () => {
              if (!eventOrder.includes('permission-result')) {
                pendingPermission.resolve(await resourceAffordances(['read']))
              }
              pendingD2Refetch.resolve(changedPage)
              await pendingD2Refetch.promise
              await scheduler.waitAll()
            })
            cleanup()
            desktopQueryClient.clear()
          }
        }
      ),
      { numRuns: 60, maxSkipsPerRun: 100, seed: 1606 }
    )
    expect([...observedCases].some(value => value.startsWith('identity-update:query-first'))).toBe(
      true
    )
    expect(
      [...observedCases].some(value => value.startsWith('identity-update:permission-first'))
    ).toBe(true)
    expect(observedCases.has('root-removal:root-first')).toBe(true)
    expect(observedCases.has('terminal-mismatch:user-focus')).toBe(true)
    expect(observedCases.has('terminal-mismatch:owner-navigation')).toBe(true)
    expect(observedCases.has('terminal-mismatch:transient-user-focus')).toBe(true)
    expect(observedCases.has('terminal-mismatch:session-logout')).toBe(true)
  }, 180_000)
  const createD5aGeneratedFixture = async () => {
    cleanup()
    desktopQueryClient.clear()
    appHarness.controller = makeController()
    appHarness.filesPagePendingActions = []
    appHarness.filesPageCurrentnessById.clear()
    appHarness.filesPageHandledEvents = []
    appHarness.d5aPermissionSettledUris.clear()
    appHarness.d5aPostPermissionAckIds.clear()
    const resourceAId = '44444444444444444444444444444444'
    const resourceBId = '55555555555555555555555555555555'
    const fileA = await resolveResource(resolvedFile(resourceAId, 'first-root.txt', { version: 7 }))
    const fileB = await resolveResource(
      resolvedFile(resourceBId, 'second-root.txt', { version: 3 })
    )
    const permissionA = deferred<Awaited<ReturnType<typeof resourceAffordances>>>()
    const permissionB = deferred<Awaited<ReturnType<typeof resourceAffordances>>>()
    const { gfs } = installClerum([fileA, fileB], new Map(), {
      accessibleRows: [
        accessibleResource(resourceAId, fileA.name, 'file', {
          gfsUri: fileA.gfsUri,
          version: 7,
          permissions: ['read', 'write'],
        }),
        accessibleResource(resourceBId, fileB.name, 'file', {
          gfsUri: fileB.gfsUri,
          version: 3,
          permissions: ['read', 'write'],
        }),
      ],
    })
    const initialAffordances = affordanceMock(gfs).getMockImplementation()
    expect(initialAffordances).toBeTruthy()
    let holdA = false
    let holdB = false
    affordanceMock(gfs).mockImplementation((resourceId: string) => {
      if (resourceId === resourceAId && holdA)
        return permissionA.promise.then(
          result => {
            appHarness.d5aPermissionSettledUris.add(fileA.gfsUri)
            return result
          },
          error => {
            appHarness.d5aPermissionSettledUris.add(fileA.gfsUri)
            throw error
          }
        )
      if (resourceId === resourceBId && holdB)
        return permissionB.promise.then(
          result => {
            appHarness.d5aPermissionSettledUris.add(fileB.gfsUri)
            return result
          },
          error => {
            appHarness.d5aPermissionSettledUris.add(fileB.gfsUri)
            throw error
          }
        )
      return initialAffordances!(resourceId, 'main')
    })
    renderApp()
    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await findResourceTreeRow(fileA.name)
    await findResourceTreeRow(fileB.name)

    const queryFor = (resourceId: string) =>
      desktopQueryClient
        .getQueryCache()
        .findAll()
        .find(
          query => query.queryKey.includes(resourceId) && query.queryKey.includes('affordances')
        )
    const requestFor = (uri: string) =>
      appHarness.filesPagePendingActions.find(
        (candidate): candidate is { id: number; targetUri: string } =>
          Boolean(candidate && typeof candidate === 'object' && 'targetUri' in candidate) &&
          (candidate as { targetUri: string }).targetUri === uri
      )
    const invalidate = async (resourceId: string) => {
      const query = queryFor(resourceId)
      expect(query).toBeTruthy()
      await waitFor(() => expect(query!.state.status).toBe('success'))
      await desktopQueryClient.invalidateQueries({
        queryKey: query!.queryKey,
        exact: true,
        refetchType: 'none',
      })
      return query!
    }
    let requestA: { id: number; targetUri: string } | undefined
    let requestB: { id: number; targetUri: string } | undefined
    let queryA: NonNullable<ReturnType<typeof queryFor>> | undefined
    let queryB: NonNullable<ReturnType<typeof queryFor>> | undefined
    let aPermissionWasPendingBeforeB = false
    let bPermissionWasPending = false
    const startA = async () => {
      const menu = await openRowActions(fileA.name)
      queryA = await invalidate(resourceAId)
      holdA = true
      fireEvent.click(await within(menu).findByRole('menuitem', { name: 'Rename' }))
      await waitFor(() => expect(gfs.affordances).toHaveBeenCalledWith(resourceAId, 'main'))
      requestA = requestFor(fileA.gfsUri)
      expect(requestA).toBeTruthy()
      await waitFor(() => expect(queryA!.state.fetchStatus).toBe('fetching'))
      aPermissionWasPendingBeforeB = queryA!.state.fetchStatus === 'fetching'
      return requestA!
    }
    const startB = async () => {
      if (!aPermissionWasPendingBeforeB) throw new Error('A permission was not pending before B')
      const menu = await openRowActions(fileB.name)
      queryB = await invalidate(resourceBId)
      holdB = true
      fireEvent.click(await within(menu).findByRole('menuitem', { name: 'Rename' }))
      await waitFor(() => expect(gfs.affordances).toHaveBeenCalledWith(resourceBId, 'main'))
      requestB = requestFor(fileB.gfsUri)
      expect(requestB).toBeTruthy()
      await waitFor(() => expect(queryB!.state.fetchStatus).toBe('fetching'))
      bPermissionWasPending = queryB!.state.fetchStatus === 'fetching'
      return requestB!
    }
    const settleA = async (result: 'denied' | 'rejected') => {
      if (!queryA || !requestA) throw new Error('A permission request was not started')
      if (result === 'denied') permissionA.resolve(await resourceAffordances(['read']))
      else permissionA.reject(new Error('permission service unavailable for first-root.txt'))
      await waitFor(() => expect(queryA!.state.fetchStatus).not.toBe('fetching'))
      expect(appHarness.filesPageCurrentnessById.get(requestA.id)?.(requestA.id)).toBe(false)
      expect(
        recordedToastCalls().some(
          ([message]) => typeof message === 'string' && message.includes(fileA.name)
        )
      ).toBe(false)
    }
    const settleB = async (result: 'denied' | 'error' | 'allowed') => {
      if (!queryB || !requestB) throw new Error('B permission request was not started')
      if (result === 'denied') permissionB.resolve(await resourceAffordances(['read']))
      else if (result === 'allowed')
        permissionB.resolve(await resourceAffordances(['read', 'write']))
      else permissionB.reject(new Error('permission service unavailable for second-root.txt'))
      await waitFor(() => expect(queryB!.state.fetchStatus).not.toBe('fetching'))
      if (result === 'denied') {
        await waitFor(() =>
          expect(recordedToastCalls()).toContainEqual([
            `You do not have write access to ${fileB.name}.`,
            'error',
          ])
        )
      } else if (result === 'error') {
        await waitFor(() =>
          expect(
            recordedToastCalls().some(
              ([message]) => typeof message === 'string' && message.includes(`for ${fileB.name}`)
            )
          ).toBe(true)
        )
      } else {
        await screen.findByRole('form', { name: 'Rename resource' })
        expect((screen.getByLabelText('New name') as HTMLInputElement).value).toBe(fileB.name)
      }
    }
    return {
      startA,
      startB,
      settleA,
      settleB,
      observeD5a: (model: ReturnType<typeof initialD5a>) => {
        const feedback = recordedToastCalls().flatMap(([message]) => {
          if (typeof message !== 'string') return []
          const resource = message.includes(fileA.name)
            ? 'A'
            : message.includes(fileB.name)
              ? 'B'
              : null
          return resource ? [{ resource, message }] : []
        })
        const dialog = screen.queryByRole('form', { name: 'Rename resource' })
        const queryPending = desktopQueryClient.isFetching() > 0
        const modelChecks = assertD5a(model)
        const violations = Object.entries(modelChecks)
          .filter(([, passes]) => !passes)
          .map(([name]) => `model:${name}`)
        if (feedback.some(item => item.resource === 'A'))
          violations.push('stale A feedback was emitted')
        if (queryPending) violations.push('permission query remains pending')
        const actualFeedback = feedback.map(item => ({
          requestId: item.resource === 'A' ? requestA!.id : requestB!.id,
          resource: item.resource,
          session: 1,
          revokeRevision: 0,
          result: item.message.startsWith('You do not have')
            ? ('denied' as const)
            : ('error' as const),
        }))
        const actualUi = dialog
          ? [{ requestId: requestB!.id, resource: 'B', session: 1, revokeRevision: 0 }]
          : []
        if (JSON.stringify(actualFeedback) !== JSON.stringify(model.feedback))
          violations.push('mounted feedback differs from independent D5a A4 model')
        if (JSON.stringify(actualUi) !== JSON.stringify(model.ui))
          violations.push('mounted action UI differs from independent D5a A4 model')
        return {
          requestA: requestA?.id,
          requestB: requestB?.id,
          aPermissionWasPendingBeforeB,
          bPermissionWasPending,
          pending: desktopQueryClient.isFetching(),
          sensitivity: d5aSensitivityControl(),
          aCurrentDuringPermission: requestA
            ? (appHarness.filesPageCurrentnessById.get(requestA.id)?.(requestA.id) ?? null)
            : null,
          bCurrentDuringPermission: requestB
            ? (appHarness.filesPageCurrentnessById.get(requestB.id)?.(requestB.id) ?? null)
            : null,
          aCurrentAfterB: requestA
            ? (appHarness.filesPageCurrentnessById.get(requestA.id)?.(requestA.id) ?? null)
            : null,
          bCurrentAfterB: requestB
            ? (appHarness.filesPageCurrentnessById.get(requestB.id)?.(requestB.id) ?? null)
            : null,
          feedback,
          actualFeedback,
          actualUi,
          modelExpected: { feedback: model.feedback, ui: model.ui, checks: modelChecks },
          dialogValue: (dialog?.querySelector('input') as HTMLInputElement | null)?.value ?? null,
          queryPending,
          violations,
        }
      },
      resourceNames: { A: fileA.name, B: fileB.name },
    }
  }

  const runD5aPermissionSuccessorProbe = async (
    staleA: 'denied' | 'rejected' | 'authority',
    currentB: 'denied' | 'error' | 'allowed',
    completionOrder: 'A-then-B' | 'B-then-A' | 'fc.scheduler',
    scheduler?: Scheduler,
    assertContract = true,
    heldTargetResolution?: Deferred<unknown>
  ) => {
    cleanup()
    desktopQueryClient.clear()
    appHarness.controller = makeController()
    appHarness.filesPagePendingActions = []
    appHarness.filesPageCurrentnessById.clear()
    const resourceAId = '44444444444444444444444444444444'
    const resourceBId = '55555555555555555555555555555555'
    const fileA = await resolveResource(resolvedFile(resourceAId, 'first-root.txt', { version: 7 }))
    const fileB = await resolveResource(
      resolvedFile(resourceBId, 'second-root.txt', { version: 3 })
    )
    const permissionA = deferred<Awaited<ReturnType<typeof resourceAffordances>>>()
    const permissionB = deferred<Awaited<ReturnType<typeof resourceAffordances>>>()
    const renameResource = vi.fn(async () => ({}))
    const { gfs } = installClerum([fileA, fileB], new Map(), {
      accessibleRows: [
        accessibleResource(resourceAId, fileA.name, 'file', {
          gfsUri: fileA.gfsUri,
          version: 7,
          permissions: ['read', 'write'],
        }),
        accessibleResource(resourceBId, fileB.name, 'file', {
          gfsUri: fileB.gfsUri,
          version: 3,
          permissions: ['read', 'write'],
        }),
      ],
    })
    const initialAffordances = affordanceMock(gfs).getMockImplementation()
    expect(initialAffordances).toBeTruthy()
    let holdA = false
    let holdB = false
    let accessStateAtRevoke: unknown = null
    let retryListAccessibleCalls = 0
    let bTargetResolveWasHeld = false
    let bCurrentAtTargetAwait: boolean | null = null
    affordanceMock(gfs).mockImplementation((resourceId: string) => {
      if (resourceId === resourceAId && holdA)
        return permissionA.promise.then(
          result => {
            appHarness.d5aPermissionSettledUris.add(fileA.gfsUri)
            return result
          },
          error => {
            appHarness.d5aPermissionSettledUris.add(fileA.gfsUri)
            throw error
          }
        )
      if (resourceId === resourceBId && holdB)
        return permissionB.promise.then(
          result => {
            appHarness.d5aPermissionSettledUris.add(fileB.gfsUri)
            return result
          },
          error => {
            appHarness.d5aPermissionSettledUris.add(fileB.gfsUri)
            throw error
          }
        )
      return initialAffordances!(resourceId, 'main')
    })
    Object.assign(gfs, { renameResource })
    renderApp()
    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await findResourceTreeRow(fileA.name)
    await findResourceTreeRow(fileB.name)
    if (heldTargetResolution) holdExactTargetResolve(gfs, fileB.gfsUri, heldTargetResolution)

    const menuA = await openRowActions(fileA.name)
    const renameA = await within(menuA).findByRole('menuitem', { name: 'Rename' })
    const queryA = desktopQueryClient
      .getQueryCache()
      .findAll()
      .find(query => query.queryKey.includes(resourceAId) && query.queryKey.includes('affordances'))
    expect(queryA?.state.status).toBe('success')
    await desktopQueryClient.invalidateQueries({
      queryKey: queryA!.queryKey,
      exact: true,
      refetchType: 'none',
    })
    holdA = true
    fireEvent.click(renameA)
    await waitFor(() => expect(gfs.affordances).toHaveBeenCalledWith(resourceAId, 'main'))
    const requestA = appHarness.filesPagePendingActions.find(
      (candidate): candidate is { id: number; targetUri: string } =>
        Boolean(candidate && typeof candidate === 'object' && 'targetUri' in candidate) &&
        (candidate as { targetUri: string }).targetUri === fileA.gfsUri
    )
    expect(requestA).toBeTruthy()
    await waitFor(() => expect(queryA!.state.fetchStatus).toBe('fetching'))
    const aPermissionWasPendingBeforeB = queryA!.state.fetchStatus === 'fetching'
    const aCurrentDuringPermission =
      appHarness.filesPageCurrentnessById.get(requestA!.id)?.(requestA!.id) ?? null

    const menuB = await openRowActions(fileB.name)
    const renameB = await within(menuB).findByRole('menuitem', { name: 'Rename' })
    const queryB = desktopQueryClient
      .getQueryCache()
      .findAll()
      .find(query => query.queryKey.includes(resourceBId) && query.queryKey.includes('affordances'))
    expect(queryB?.state.status).toBe('success')
    await desktopQueryClient.invalidateQueries({
      queryKey: queryB!.queryKey,
      exact: true,
      refetchType: 'none',
    })
    holdB = true
    fireEvent.click(renameB)
    await waitFor(() => expect(gfs.affordances).toHaveBeenCalledWith(resourceBId, 'main'))
    const requestB = appHarness.filesPagePendingActions.find(
      (candidate): candidate is { id: number; targetUri: string } =>
        Boolean(candidate && typeof candidate === 'object' && 'targetUri' in candidate) &&
        (candidate as { targetUri: string }).targetUri === fileB.gfsUri
    )
    expect(requestB).toBeTruthy()
    expect(requestB!.id).not.toBe(requestA!.id)
    await waitFor(() => expect(queryB!.state.fetchStatus).toBe('fetching'))
    const bPermissionWasPending = queryB!.state.fetchStatus === 'fetching'
    const bCurrentDuringPermission =
      appHarness.filesPageCurrentnessById.get(requestB!.id)?.(requestB!.id) ?? null
    const aCurrentAfterB =
      appHarness.filesPageCurrentnessById.get(requestA!.id)?.(requestA!.id) ?? null
    const sameFilesOwner =
      activeWorkspaceTab(appHarness.controller.workspaceTabs)?.kind === 'files' &&
      appHarness.controller.workspaceTabs.tabs.filter(tab => tab.kind === 'files').length === 1
    let model = initialD5a()
    model = transitionD5a(model, { type: 'request', id: requestA!.id, resource: 'A', session: 1 })
    model = transitionD5a(model, {
      type: 'permission-start',
      id: 101,
      requestId: requestA!.id,
      resource: 'A',
      session: 1,
    })
    model = transitionD5a(model, { type: 'request', id: requestB!.id, resource: 'B', session: 1 })
    model = transitionD5a(model, {
      type: 'permission-start',
      id: 102,
      requestId: requestB!.id,
      resource: 'B',
      session: 1,
    })

    const resolveA = async () => {
      await act(async () => {
        if (staleA === 'denied') permissionA.resolve(await resourceAffordances(['read']))
        else if (staleA === 'authority') {
          const failure = await gfsRouteFailureMessage(
            client => client.affordances(resourceAId, 'fixture-session-token', 'main'),
            401,
            { code: 'unauthorized', message: 'captured session denied' }
          )
          permissionA.reject(new Error(failure))
        } else permissionA.reject(new Error(`500 permission service unavailable for ${fileA.name}`))
        await Promise.resolve()
        await Promise.resolve()
      })
      await waitFor(() => expect(queryA!.state.fetchStatus).not.toBe('fetching'))
      const hadEarlyAcknowledgment = appHarness.filesPageHandledEvents.some(
        event => event.id === requestA!.id && !event.permissionSettled
      )
      if (staleA === 'authority') {
        await waitFor(() =>
          expect(
            desktopQueryClient
              .getQueryCache()
              .findAll()
              .some(
                query =>
                  query.queryKey[1] === 'gfs-access' &&
                  (query.state.data as { status?: string } | undefined)?.status === 'revoked'
              )
          ).toBe(true)
        )
        accessStateAtRevoke = desktopQueryClient
          .getQueryCache()
          .findAll()
          .find(query => query.queryKey[1] === 'gfs-access')?.state.data
        const listCallsBeforeRetry = gfs.listAccessible.mock.calls.length
        const retryButtons = screen.getAllByRole('button', { name: 'Retry file access' })
        fireEvent.click(retryButtons[0]!)
        await waitFor(() =>
          expect(
            desktopQueryClient
              .getQueryCache()
              .findAll()
              .find(query => query.queryKey[1] === 'gfs-access')?.state.data
          ).toMatchObject({ status: 'active', revokeRevision: 1 })
        )
        await waitFor(() =>
          expect(gfs.listAccessible.mock.calls.length).toBeGreaterThan(listCallsBeforeRetry)
        )
        await waitFor(() => expect(desktopQueryClient.isFetching()).toBe(0))
        retryListAccessibleCalls = gfs.listAccessible.mock.calls.length - listCallsBeforeRetry
      } else if (hadEarlyAcknowledgment) {
        await waitFor(() =>
          expect(
            recordedToastCalls().some(
              ([message]) => typeof message === 'string' && message.includes(fileA.name)
            )
          ).toBe(true)
        )
      } else {
        expect(appHarness.filesPageCurrentnessById.get(requestA!.id)?.(requestA!.id)).toBe(false)
        expect(
          recordedToastCalls().some(
            ([message]) => typeof message === 'string' && message.includes(fileA.name)
          )
        ).toBe(false)
      }
    }
    const resolveB = async () => {
      await act(async () => {
        if (currentB === 'denied') permissionB.resolve(await resourceAffordances(['read']))
        else if (currentB === 'allowed')
          permissionB.resolve(await resourceAffordances(['read', 'write']))
        else permissionB.reject(new Error(`500 permission service unavailable for ${fileB.name}`))
        await Promise.resolve()
        await Promise.resolve()
      })
      if (staleA === 'authority') {
        await waitFor(() =>
          expect(appHarness.d5aPermissionSettledUris.has(fileB.gfsUri)).toBe(true)
        )
        if (heldTargetResolution) {
          await waitFor(() => expect(gfs.resolve).toHaveBeenCalledWith(fileB.gfsUri))
          bTargetResolveWasHeld = true
          bCurrentAtTargetAwait =
            appHarness.filesPageCurrentnessById.get(requestB!.id)?.(requestB!.id) ?? null
        } else {
          await waitFor(() => expect(desktopQueryClient.isFetching()).toBe(0))
        }
      } else await waitFor(() => expect(queryB!.state.fetchStatus).not.toBe('fetching'))
      const hadEarlyAcknowledgment = appHarness.filesPageHandledEvents.some(
        event => event.id === requestB!.id && !event.permissionSettled
      )
      if (!hadEarlyAcknowledgment && staleA !== 'authority') {
        await waitFor(() => expect(appHarness.d5aPostPermissionAckIds.has(requestB!.id)).toBe(true))
      }
      if (currentB === 'denied') {
        await waitFor(() =>
          expect(
            recordedToastCalls().filter(
              ([message]) => message === `You do not have write access to ${fileB.name}.`
            )
          ).toHaveLength(1)
        )
      } else if (currentB === 'error') {
        await waitFor(() =>
          expect(
            recordedToastCalls().filter(
              ([message]) => typeof message === 'string' && message.includes(`for ${fileB.name}`)
            )
          ).toHaveLength(1)
        )
      } else if (staleA === 'authority') {
        // A current-session 401 has already revoked shared access. Let B's
        // real permission continuation settle; the final mounted/model
        // comparison below records any unauthorized Rename UI as expected RED.
        await act(async () => {
          await Promise.resolve()
          await Promise.resolve()
        })
      } else {
        if (heldTargetResolution) {
          await waitFor(() => expect(gfs.resolve).toHaveBeenCalledWith(fileB.gfsUri))
          bTargetResolveWasHeld = true
        } else {
          await screen.findByRole('form', { name: 'Rename resource' })
          expect((screen.getByLabelText('New name') as HTMLInputElement).value).toBe(fileB.name)
        }
      }
    }
    const settleModelA = () => {
      model = transitionD5a(model, {
        type: 'permission-settle',
        id: 101,
        result: staleA === 'authority' ? 'session-authority' : staleA,
      })
    }
    const settleModelB = () => {
      model = transitionD5a(model, {
        type: 'permission-settle',
        id: 102,
        result: currentB,
      })
    }
    const schedulerCompletionOrder: string[] = []
    if (completionOrder === 'fc.scheduler') {
      if (!scheduler) throw new Error('D5a scheduler order requires fc.scheduler()')
      const scheduledA = scheduler
        .schedule(Promise.resolve('denied'), 'A permission completion')
        .then(async () => {
          schedulerCompletionOrder.push('A')
          await resolveA()
          settleModelA()
        })
      const scheduledB = scheduler
        .schedule(Promise.resolve('denied'), 'B permission completion')
        .then(async () => {
          schedulerCompletionOrder.push('B')
          await resolveB()
          settleModelB()
        })
      await scheduler.waitIdle()
      await Promise.all([scheduledA, scheduledB])
    } else if (completionOrder === 'A-then-B') {
      schedulerCompletionOrder.push('A', 'B')
      await resolveA()
      settleModelA()
      if (staleA === 'authority') model = transitionD5a(model, { type: 'retry' })
      await resolveB()
      settleModelB()
    } else {
      schedulerCompletionOrder.push('B', 'A')
      await resolveB()
      settleModelB()
      await resolveA()
      settleModelA()
    }
    if (heldTargetResolution) {
      if (!bTargetResolveWasHeld) throw new Error('B exact-target resolver was not held')
      await act(async () => heldTargetResolution.resolve(fileB))
    }
    await waitFor(() => expect(desktopQueryClient.isFetching()).toBe(0))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    const toastCalls = recordedToastCalls().map(([message, tone]) => ({
      message,
      tone,
    }))
    model = transitionD5a(model, { type: 'quiesce' })
    const modelChecks = assertD5a(model)
    type ActualFeedback =
      | {
          requestId: null
          resource: 'unowned'
          session: number
          result: 'unowned'
          message: string
        }
      | {
          requestId: number
          resource: 'A' | 'B'
          session: number
          revokeRevision: number
          result: 'denied' | 'error'
        }
    const actualFeedback = toastCalls.flatMap<ActualFeedback>(call => {
      const resource = call.message.includes(fileA.name)
        ? 'A'
        : call.message.includes(fileB.name)
          ? 'B'
          : null
      // Keep every visible toast in the mounted observation. A generic
      // cancellation toast has no current request owner and must not vanish
      // from the independent model comparison.
      if (!resource)
        return [
          {
            requestId: null,
            resource: 'unowned' as const,
            session: 1,
            result: 'unowned' as const,
            message: call.message,
          },
        ]
      return [
        {
          requestId: resource === 'A' ? requestA!.id : requestB!.id,
          resource,
          session: 1,
          revokeRevision: 0,
          result: call.message.startsWith('You do not have')
            ? ('denied' as const)
            : ('error' as const),
        },
      ]
    })
    const actualUi = screen.queryByRole('form', { name: 'Rename resource' })
      ? [{ requestId: requestB!.id, resource: 'B', session: 1, revokeRevision: 0 }]
      : []
    const observed = {
      requestA: requestA!.id,
      requestB: requestB!.id,
      sameFilesOwner,
      aPermissionWasPendingBeforeB,
      bPermissionWasPending,
      aCurrentDuringPermission,
      aCurrentAfterB,
      bCurrentDuringPermission,
      handledEvents: appHarness.filesPageHandledEvents.filter(event =>
        [requestA!.id, requestB!.id].includes(event.id)
      ),
      aPostPermissionAck: appHarness.d5aPostPermissionAckIds.has(requestA!.id),
      bPostPermissionAck: appHarness.d5aPostPermissionAckIds.has(requestB!.id),
      permissionCalls: affordanceMock(gfs).mock.calls.map(([id]) => id),
      toastCalls,
      renameDialogForB: screen.queryByRole('form', { name: 'Rename resource' }) !== null,
      renameDialogValue:
        (screen.queryByLabelText('New name') as HTMLInputElement | null)?.value ?? null,
      renameMutations: renameResource.mock.calls.length,
      accessState:
        desktopQueryClient
          .getQueryCache()
          .findAll()
          .find(query => query.queryKey[1] === 'gfs-access')?.state.data ?? null,
      accessStateAtRevoke,
      retryListAccessibleCalls,
      bTargetResolveWasHeld,
      bCurrentAtTargetAwait,
      pending: desktopQueryClient.isFetching(),
      completionOrder: schedulerCompletionOrder.join(' → '),
      modelExpected: { feedback: model.feedback, ui: model.ui, checks: modelChecks },
      mountedObserved: { feedback: actualFeedback, ui: actualUi },
      sensitivity: d5aSensitivityControl(),
      revokeRetrySensitivity: d5aRevokeRetrySensitivityControl(),
      violations: [] as string[],
    }
    expect(observed.sameFilesOwner).toBe(true)
    expect(observed.aPermissionWasPendingBeforeB).toBe(true)
    expect(observed.bPermissionWasPending).toBe(true)
    expect(observed.permissionCalls).toEqual(expect.arrayContaining([resourceAId, resourceBId]))
    expect(observed.pending).toBe(0)
    const violations: string[] = []
    if (
      staleA === 'authority' &&
      (observed.accessStateAtRevoke as { status?: string } | null)?.status !== 'revoked'
    )
      violations.push('real current-session authority failure did not revoke access')
    if (
      staleA === 'authority' &&
      (observed.accessState as { status?: string } | null)?.status !== 'active'
    )
      violations.push('real Retry file access did not restore the shared active state')
    if (staleA === 'authority' && observed.retryListAccessibleCalls < 1)
      violations.push('Retry did not re-enter the real server-backed GFS query path')
    if (!d5aSensitivityControl()) violations.push('D5a oracle missed stale-feedback sensitivity')
    if (!d5aRevokeRetrySensitivityControl())
      violations.push('D5a oracle missed the revoke/Retry revision sensitivity')
    if (JSON.stringify(actualFeedback) !== JSON.stringify(model.feedback))
      violations.push('mounted feedback/effects differ from independent D5a A4 oracle')
    if (actualFeedback.some(item => item.resource === 'unowned'))
      violations.push('unowned generic feedback was emitted')
    if (JSON.stringify(actualUi) !== JSON.stringify(model.ui))
      violations.push('mounted dialog ownership differs from independent D5a A4 oracle')
    if (observed.aCurrentDuringPermission !== true)
      violations.push('A lost its App receipt before its permission continuation settled')
    if (observed.aCurrentAfterB !== false)
      violations.push('B did not supersede the existing A receipt')
    if (observed.bCurrentDuringPermission !== true)
      violations.push(
        'B did not retain its App receipt while its permission continuation was pending'
      )
    // Superseded A settles silently; its request receipt remains canceled and
    // does not receive an acknowledgement that could clear B.
    if (!observed.bPostPermissionAck && staleA !== 'authority')
      violations.push('B continuation did not reach its post-permission terminal acknowledgment')
    if (staleA === 'denied') {
      if (
        toastCalls.some(call => call.message === `You do not have write access to ${fileA.name}.`)
      )
        violations.push('stale A denial feedback was emitted')
    } else if (staleA === 'authority') {
      if (toastCalls.some(call => call.message.includes(fileA.name)))
        violations.push('current-session authority failure emitted stale A feedback')
    } else if (toastCalls.some(call => call.message.includes(fileA.name))) {
      violations.push('stale A rejection feedback was emitted')
    }
    if (currentB === 'denied') {
      if (
        toastCalls.filter(call => call.message === `You do not have write access to ${fileB.name}.`)
          .length !== 1
      )
        violations.push('current B denial feedback did not appear exactly once')
      if (observed.renameDialogForB) violations.push('denied B opened Rename UI')
    } else if (currentB === 'error') {
      if (toastCalls.filter(call => call.message.includes(`for ${fileB.name}`)).length !== 1)
        violations.push('current B permission error did not appear exactly once')
      if (observed.renameDialogForB) violations.push('failed B opened Rename UI')
    } else if (staleA === 'authority') {
      if (observed.renameDialogForB)
        violations.push('B opened Rename UI after A globally revoked the session')
      if (toastCalls.some(call => call.message.includes(fileB.name)))
        violations.push('B emitted action feedback after global revocation')
    } else {
      if (!observed.renameDialogForB || observed.renameDialogValue !== fileB.name)
        violations.push('allowed current B did not open its own Rename UI')
      if (toastCalls.some(call => call.message.includes(fileA.name)))
        violations.push('stale A feedback replaced the successful B outcome')
    }
    expect(renameResource).not.toHaveBeenCalled()
    observed.violations = violations
    console.info('D5a real permission continuation probe', JSON.stringify(observed))
    if (assertContract) expect(violations).toEqual([])
    return observed
  }

  it('reaches held A and B permission continuations before A denial and settles current B denial', async () => {
    await runD5aPermissionSuccessorProbe('denied', 'denied', 'A-then-B')
  })

  it('reaches held A and B permission continuations before A rejection and settles current B error', async () => {
    await runD5aPermissionSuccessorProbe('rejected', 'error', 'A-then-B')
  })

  it('settles current B successfully before stale A denial without replacing B UI', async () => {
    await runD5aPermissionSuccessorProbe('denied', 'allowed', 'B-then-A')
  })

  it('keeps A authority cancellation feedback silent after revocation and Retry', async () => {
    const observed = await runD5aPermissionSuccessorProbe(
      'authority',
      'allowed',
      'A-then-B',
      undefined,
      false
    )
    expect(
      observed.toastCalls.filter(
        call =>
          !call.message.includes('first-root.txt') && !call.message.includes('second-root.txt')
      )
    ).toEqual([])
    expect(observed.mountedObserved.feedback).toEqual([])
    expect(observed.modelExpected.feedback).toEqual([])
    expect(observed.renameDialogForB).toBe(false)
    expect(observed.violations).toEqual([])
  })

  it('fences B target completion across A revoke and Retry at a new access revision', async () => {
    const targetResolution = deferred<unknown>()
    const observed = await runD5aPermissionSuccessorProbe(
      'authority',
      'allowed',
      'B-then-A',
      undefined,
      true,
      targetResolution
    )
    expect(observed.bTargetResolveWasHeld).toBe(true)
    expect(observed.bCurrentAtTargetAwait).toBe(true)
    expect(observed.accessState).toMatchObject({ status: 'active', revokeRevision: 1 })
    expect(observed.renameDialogForB).toBe(false)
    expect(observed.renameMutations).toBe(0)
    expect(observed.violations).toEqual([])
  })

  it('covers stale A outcomes against every current B outcome in both completion orders', async () => {
    const matrix = (['denied', 'rejected'] as const).flatMap(staleA =>
      (['denied', 'error', 'allowed'] as const).flatMap(currentB =>
        (['A-then-B', 'B-then-A'] as const).map(completionOrder => ({
          staleA,
          currentB,
          completionOrder,
        }))
      )
    )
    const results = []
    for (const scenario of matrix) {
      const observed = await runD5aPermissionSuccessorProbe(
        scenario.staleA,
        scenario.currentB,
        scenario.completionOrder,
        undefined,
        false
      )
      expect(observed.requestA).not.toBe(observed.requestB)
      expect(observed.sameFilesOwner).toBe(true)
      expect(observed.aPermissionWasPendingBeforeB).toBe(true)
      expect(observed.bPermissionWasPending).toBe(true)
      expect(observed.pending).toBe(0)
      expect(observed.completionOrder).toBe(
        scenario.completionOrder === 'A-then-B' ? 'A → B' : 'B → A'
      )
      const staleFeedback =
        scenario.staleA === 'denied'
          ? 'stale A denial feedback was emitted'
          : 'stale A rejection feedback was emitted'
      expect(observed.violations).not.toContain(staleFeedback)
      expect(observed.violations).not.toContain(
        'mounted feedback/effects differ from independent D5a A4 oracle'
      )
      const bToasts = observed.toastCalls.filter(call => call.message.includes('second-root.txt'))
      if (scenario.currentB === 'denied') {
        expect(bToasts).toEqual([
          { message: 'You do not have write access to second-root.txt.', tone: 'error' },
        ])
        expect(observed.renameDialogForB).toBe(false)
      } else if (scenario.currentB === 'error') {
        expect(bToasts).toHaveLength(1)
        expect(bToasts[0]!.message).toContain('permission service unavailable for second-root.txt')
        expect(observed.renameDialogForB).toBe(false)
      } else {
        expect(observed.renameDialogForB).toBe(true)
        expect(observed.renameDialogValue).toBe('second-root.txt')
      }
      results.push({ ...scenario, violations: observed.violations })
    }
    console.info(
      'D5a stale/current outcome matrix',
      JSON.stringify({
        cases: results.length,
        staleResults: [...new Set(results.map(result => result.staleA))],
        currentResults: [...new Set(results.map(result => result.currentB))],
        completionOrders: [...new Set(results.map(result => result.completionOrder))],
        allObservedRealPendingPair: results.length === 12,
        expectedRedCases: results.filter(result =>
          result.violations.some(value => value.startsWith('stale A '))
        ).length,
      })
    )
    expect(results).toHaveLength(12)
  })

  it('runs competing D5a permission completions through fc.commands and fc.scheduler', async () => {
    type Model = {
      aStarted: boolean
      bStarted: boolean
      aQueued: boolean
      bQueued: boolean
      drained: boolean
      requestA?: number
      requestB?: number
      events: string[]
    }
    type Trace = {
      scheduler: Scheduler
      fixture?: Awaited<ReturnType<typeof createD5aGeneratedFixture>>
      d5a: ReturnType<typeof initialD5a>
      tasks: Promise<unknown>[]
      order: string[]
      violations?: string[]
      observed?: {
        violations: string[]
        aPermissionWasPendingBeforeB: boolean
        bPermissionWasPending: boolean
        queryPending: boolean
        sensitivity: boolean
      }
    }
    class StartPair implements AsyncCommand<Model, Trace> {
      check(model: Readonly<Model>) {
        return !model.aStarted && !model.bStarted
      }
      async run(model: Model, real: Trace) {
        real.fixture ??= await createD5aGeneratedFixture()
        const requestA = await real.fixture.startA()
        model.aStarted = true
        model.requestA = requestA.id
        model.events.push('sidebar-action-A')
        real.d5a = transitionD5a(real.d5a, {
          type: 'request',
          id: requestA.id,
          resource: 'A',
          session: 1,
        })
        real.d5a = transitionD5a(real.d5a, {
          type: 'permission-start',
          id: 101,
          requestId: requestA.id,
          resource: 'A',
          session: 1,
        })
        const requestB = await real.fixture.startB()
        model.bStarted = true
        model.requestB = requestB.id
        model.events.push('sidebar-action-B-supersedes-A')
        real.d5a = transitionD5a(real.d5a, {
          type: 'request',
          id: requestB.id,
          resource: 'B',
          session: 1,
        })
        real.d5a = transitionD5a(real.d5a, {
          type: 'permission-start',
          id: 102,
          requestId: requestB.id,
          resource: 'B',
          session: 1,
        })
      }
      toString() {
        return 'real sidebar A starts pending before successor B supersedes it'
      }
    }
    class QueueA implements AsyncCommand<Model, Trace> {
      check(model: Readonly<Model>) {
        return model.aStarted && model.bStarted && !model.aQueued
      }
      async run(model: Model, real: Trace) {
        model.aQueued = true
        real.tasks.push(
          real.scheduler.scheduleFunction(async () => {
            real.order.push('A')
            await real.fixture!.settleA('denied')
            real.d5a = transitionD5a(real.d5a, {
              type: 'permission-settle',
              id: 101,
              result: 'denied',
            })
            return 'A'
          })()
        )
      }
      toString() {
        return 'schedule the held real A permission completion'
      }
    }
    class QueueB implements AsyncCommand<Model, Trace> {
      check(model: Readonly<Model>) {
        return model.aStarted && model.bStarted && !model.bQueued
      }
      async run(model: Model, real: Trace) {
        model.bQueued = true
        real.tasks.push(
          real.scheduler.scheduleFunction(async () => {
            real.order.push('B')
            await real.fixture!.settleB('denied')
            real.d5a = transitionD5a(real.d5a, {
              type: 'permission-settle',
              id: 102,
              result: 'denied',
            })
            return 'B'
          })()
        )
      }
      toString() {
        return 'schedule the held real B permission completion'
      }
    }
    class Drain implements AsyncCommand<Model, Trace> {
      check(model: Readonly<Model>) {
        return model.aQueued && model.bQueued && !model.drained
      }
      async run(model: Model, real: Trace) {
        await act(async () => {
          await real.scheduler.waitIdle()
          await Promise.all(real.tasks)
        })
        real.d5a = transitionD5a(real.d5a, { type: 'quiesce' })
        assertD5a(real.d5a)
        real.observed = real.fixture!.observeD5a(real.d5a)
        real.violations = real.observed.violations
        model.drained = true
        model.events.push('quiesce-after-A-and-B-terminal-barriers')
      }
      toString() {
        return 'drain scheduled completions and compare mounted A4 state'
      }
    }
    const scenarioArbitrary = fc.tuple(
      fc.scheduler(),
      fc.commands([fc.constant(new QueueA()), fc.constant(new QueueB())], {
        maxCommands: 2,
        size: '+1',
      })
    )
    const generatedScenarios = fc.sample(scenarioArbitrary, {
      numRuns: 512,
      seed: 20261114,
    })
    const validScenarios = generatedScenarios.filter(([, generated]) => {
      const names = [...generated].map(command => command.toString())
      return (
        names.some(name => name.startsWith('schedule the held real A')) &&
        names.some(name => name.startsWith('schedule the held real B'))
      )
    })
    const queueOrders = new Set(
      validScenarios.map(([, generated]) => {
        const names = [...generated].map(command => command.toString())
        return names.findIndex(name => name.startsWith('schedule the held real A')) <
          names.findIndex(name => name.startsWith('schedule the held real B'))
          ? 'queue-A-then-B'
          : 'queue-B-then-A'
      })
    )
    const queueOrderFor = (generated: Iterable<AsyncCommand<Model, Trace>>) => {
      const names = [...generated].map(command => command.toString())
      return names.findIndex(name => name.startsWith('schedule the held real A')) <
        names.findIndex(name => name.startsWith('schedule the held real B'))
        ? 'queue-A-then-B'
        : 'queue-B-then-A'
    }
    const selectedScenarios = [
      validScenarios.find(([, generated]) => queueOrderFor(generated) === 'queue-A-then-B'),
      validScenarios.find(([, generated]) => queueOrderFor(generated) === 'queue-B-then-A'),
    ].filter((scenario): scenario is (typeof validScenarios)[number] => Boolean(scenario))
    expect(new Set(selectedScenarios.map(([, commands]) => queueOrderFor(commands))).size).toBe(2)
    const traces: Array<{ events: string[]; order: string; violations: string[] }> = []
    for (const [scheduler, generated] of selectedScenarios) {
      const model: Model = {
        aStarted: false,
        bStarted: false,
        aQueued: false,
        bQueued: false,
        drained: false,
        events: [],
      }
      const real: Trace = {
        scheduler,
        d5a: initialD5a(),
        tasks: [],
        order: [],
      }
      await fc.asyncModelRun(() => ({ model, real }), [new StartPair(), ...generated, new Drain()])
      expect(real.fixture).toBeTruthy()
      expect(model.events).toEqual([
        'sidebar-action-A',
        'sidebar-action-B-supersedes-A',
        'quiesce-after-A-and-B-terminal-barriers',
      ])
      expect(model.requestB).not.toBe(model.requestA)
      expect(real.observed!.aPermissionWasPendingBeforeB).toBe(true)
      expect(real.observed!.bPermissionWasPending).toBe(true)
      expect(real.observed!.queryPending).toBe(false)
      expect(real.observed!.sensitivity).toBe(true)
      expect(real.violations).not.toContain('stale A feedback was emitted')
      traces.push({
        events: model.events,
        order: real.order.join(' → '),
        violations: real.violations ?? [],
      })
      cleanup()
      desktopQueryClient.clear()
    }
    console.info('D5a generated command/scheduler coverage', {
      generatedRuns: generatedScenarios.length,
      completeHistories: traces.length,
      zeroCommandHistories: generatedScenarios.filter(([, commands]) => [...commands].length === 0)
        .length,
      partialOrRejectedHistories: generatedScenarios.length - validScenarios.length,
      observedA2Histories: new Set(traces.map(trace => trace.events.join('|'))).size,
      orders: traces.map(trace => trace.order),
      queuedOrders: [...queueOrders],
      staleFeedbackCount: traces.filter(trace =>
        trace.violations.includes('stale A feedback was emitted')
      ).length,
    })
    expect(traces.length).toBeGreaterThan(0)
    expect(new Set(traces.map(trace => trace.events.join('|'))).size).toBeGreaterThan(0)
    expect(traces.every(trace => !trace.violations.includes('stale A feedback was emitted'))).toBe(
      true
    )
  })
})
