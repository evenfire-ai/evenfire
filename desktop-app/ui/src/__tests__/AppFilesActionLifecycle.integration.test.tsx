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
import type {
  FilesPathIntentReceipt,
  ResolveFilesConvergenceLocation,
} from '@hooks/domain/useNavigationController'
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
  setFilesTabPath,
  setFilesTabUnavailable,
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
  filesPagePropsByTab: new Map<string, import('@pages/FilesPage.types').FilesPageProps>(),
  sidebarMutationClaims: [] as Array<{ id: number; claimed: boolean }>,
  captureFilesPagePropsOnly: false,
  renderTitlebarRoot: false,
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
  WindowTitleBar: ({ leadingRef }: { leadingRef?: (node: HTMLDivElement | null) => void }) =>
    appHarness.renderTitlebarRoot ? <div ref={leadingRef} /> : null,
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
      if (props.workspaceTabId) appHarness.filesPagePropsByTab.set(props.workspaceTabId, props)
      appHarness.filesPageLatestPendingAction =
        props.pendingResourceAction ?? props.pendingSidebarLocalAction ?? null
      if (props.pendingResourceAction) {
        appHarness.filesPagePendingActions.push(props.pendingResourceAction)
      }
      if (props.pendingSidebarLocalAction) {
        appHarness.filesPagePendingActions.push(props.pendingSidebarLocalAction)
      }
      if (appHarness.captureFilesPagePropsOnly) return null
      return (
        <actual.FilesPage
          {...props}
          onSidebarLocalActionMutationClaim={requestId => {
            const claimed = props.onSidebarLocalActionMutationClaim?.(requestId) ?? true
            appHarness.sidebarMutationClaims.push({ id: requestId, claimed })
            return claimed
          }}
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
  const filesPathOwners = new Map<
    string,
    {
      path: string | null
      revision: number
      sequence: number
      mutationEpoch: number
      pendingEpoch: number | null
      intentPending: boolean
      inFlight: boolean
    }
  >()
  let filesMutationEpoch = 0
  const ownerForFilesTab = (tabId: string) => {
    const tab = controller.workspaceTabs.tabs.find(
      candidate => candidate.id === tabId && candidate.kind === 'files'
    )
    if (!tab || tab.kind !== 'files') return null
    let owner = filesPathOwners.get(tabId)
    const path = tab.files?.path ?? null
    if (!owner) {
      owner = {
        path,
        revision: 0,
        sequence: 0,
        mutationEpoch: filesMutationEpoch,
        pendingEpoch: null,
        intentPending: false,
        inFlight: false,
      }
      filesPathOwners.set(tabId, owner)
    }
    return owner
  }
  const beginFilesPathIntent = vi.fn((tabId: string): FilesPathIntentReceipt | null => {
    const owner = ownerForFilesTab(tabId)
    if (!owner) return null
    owner.sequence += 1
    owner.intentPending = true
    owner.mutationEpoch = filesMutationEpoch
    return {
      tabId,
      sequence: owner.sequence,
      path: owner.path,
      pathRevision: owner.revision,
      mutationEpoch: owner.mutationEpoch,
    }
  })
  const commitFilesPathIntent = vi.fn(
    (receipt: FilesPathIntentReceipt, path: string | null, name: string | null): boolean => {
      const owner = filesPathOwners.get(receipt.tabId)
      if (!owner || owner.sequence !== receipt.sequence || !owner.intentPending) return false
      owner.intentPending = false
      owner.path = path
      owner.revision += 1
      const mutationArrived = filesMutationEpoch > receipt.mutationEpoch
      if (mutationArrived) owner.pendingEpoch = filesMutationEpoch
      setWorkspaceTabs(state =>
        setFilesTabPath(
          state,
          receipt.tabId,
          path,
          mutationArrived ? undefined : (name ?? undefined)
        )
      )
      return true
    }
  )
  const failFilesPathIntent = vi.fn((receipt: FilesPathIntentReceipt): boolean => {
    const owner = filesPathOwners.get(receipt.tabId)
    if (!owner || owner.sequence !== receipt.sequence || !owner.intentPending) return false
    owner.intentPending = false
    if (
      owner.path === receipt.path &&
      owner.revision === receipt.pathRevision &&
      filesMutationEpoch > receipt.mutationEpoch
    )
      owner.pendingEpoch = filesMutationEpoch
    return true
  })
  const recordFilesMutation = vi.fn(() => {
    filesMutationEpoch += 1
    controller.filesMutationEpoch = filesMutationEpoch
    for (const tab of controller.workspaceTabs.tabs) {
      if (tab.kind !== 'files') continue
      const owner = ownerForFilesTab(tab.id)
      if (owner) owner.pendingEpoch = filesMutationEpoch
    }
    appHarness.forceRender()
    return filesMutationEpoch
  })
  const markFilesPathsUnavailable = vi.fn(() => {
    for (const tab of controller.workspaceTabs.tabs) {
      if (tab.kind === 'files' && tab.files?.path) {
        setWorkspaceTabs(state => setFilesTabUnavailable(state, tab.id, true))
      }
    }
  })
  const reconcileFilesConvergence = vi.fn(
    async (generation: number, resolver: ResolveFilesConvergenceLocation): Promise<void> => {
      await Promise.all(
        controller.workspaceTabs.tabs.map(async tab => {
          if (tab.kind !== 'files') return
          const owner = ownerForFilesTab(tab.id)
          const path = tab.files?.path ?? null
          if (
            !owner ||
            !path ||
            owner.pendingEpoch === null ||
            owner.intentPending ||
            owner.inFlight
          )
            return
          const captured = {
            path,
            revision: owner.revision,
            sequence: owner.sequence,
            epoch: owner.pendingEpoch,
          }
          owner.pendingEpoch = null
          owner.inFlight = true
          try {
            const response = await resolver(path, generation)
            const currentTab = controller.workspaceTabs.tabs.find(
              candidate => candidate.id === tab.id
            )
            if (
              currentTab?.kind === 'files' &&
              (currentTab.files?.path ?? null) === captured.path &&
              owner.path === captured.path &&
              owner.revision === captured.revision &&
              owner.sequence === captured.sequence &&
              !owner.intentPending &&
              filesMutationEpoch === captured.epoch
            ) {
              if (response.available) {
                owner.path = response.location.gfsUri
                owner.revision += 1
                setWorkspaceTabs(state =>
                  setFilesTabPath(state, tab.id, response.location.gfsUri, response.location.name)
                )
              } else {
                setWorkspaceTabs(state => setFilesTabUnavailable(state, tab.id, true))
              }
            }
          } catch {
            setWorkspaceTabs(state => setFilesTabUnavailable(state, tab.id, true))
          } finally {
            owner.inFlight = false
          }
        })
      )
    }
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
    filesMutationEpoch,
    beginFilesPathIntent,
    commitFilesPathIntent,
    failFilesPathIntent,
    recordFilesMutation,
    markFilesPathsUnavailable,
    reconcileFilesConvergence,
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
        if (
          typeof options?.navigationIntentSequence === 'number' &&
          options.navigationIntentSequence > navigationIntentSequence
        ) {
          navigationIntentSequence = options.navigationIntentSequence
          controller.navigationIntentSequence = navigationIntentSequence
          appHarness.forceRender()
        }
        controller.handleSelectChatAgent(notification.agentName, {
          ...(notification.chatId ? { chatId: notification.chatId } : {}),
          selectLatest: false,
          ...(options?.keepNavItem ? { keepNavItem: true } : {}),
        })
      }
    ),
    openAgentConversationFromNotification: vi.fn(
      async (target: { agentName: string; chatId?: string }) => {
        beginUserNavigationIntent()
        appHarness.beforeNativeAgentConversationNotification?.()
        await appHarness.nativeNotificationContinuation
        controller.handleSelectChatAgent(target.agentName, {
          ...(target.chatId ? { chatId: target.chatId } : {}),
          selectLatest: false,
          keepNavItem: activeWorkspaceTab(controller.workspaceTabs)?.kind !== 'chat',
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
  const dispatchFileExplorerMutation = vi.fn(async request => ({
    resourceId: request.target.resourceId,
    version: request.target.version + 1,
  }))
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
    dispatchFileExplorerMutation,
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
    moveResource,
    dispatchFileExplorerMutation,
  }
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
  const { gfs, createFolder, createFileFromPath, dispatchFileExplorerMutation } = installClerum(
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
  return {
    sourceFolder,
    targetFolder,
    gfs,
    createFolder,
    createFileFromPath,
    dispatchFileExplorerMutation,
  }
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
  appHarness.filesPagePropsByTab.clear()
  appHarness.sidebarMutationClaims = []
  appHarness.captureFilesPagePropsOnly = false
  appHarness.renderTitlebarRoot = false
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
    const { sourceFolder, targetFolder, dispatchFileExplorerMutation } =
      await openLiveTargetInSameFilesTab()

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
    expect(activeTab).toMatchObject({
      id: 'same-files-tab',
      kind: 'files',
      files: { path: targetFolder.gfsUri },
    })
    expect(
      appHarness.controller.workspaceTabs.tabs.find(tab => tab.id === 'same-files-tab')
    ).toMatchObject({ id: 'same-files-tab', kind: 'files', files: { path: targetFolder.gfsUri } })
    expect(
      appHarness.controller.workspaceTabs.tabs.filter(tab => tab.kind === 'files')
    ).toHaveLength(1)

    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Folder name' }), {
      target: { value: 'Created in ancestor' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create folder' }))
    await waitFor(() =>
      expect(dispatchFileExplorerMutation).toHaveBeenCalledWith({
        operation: 'create-folder',
        target: {
          resourceId: sourceFolder.resourceId,
          drive: 'main',
          gfsUri: sourceFolder.gfsUri,
          kind: 'directory',
          version: sourceFolder.version,
          name: sourceFolder.name,
          parentResourceId: null,
          sessionGeneration: 1,
        },
        name: 'Created in ancestor',
      })
    )
  })

  it('opens and submits New folder against the exact live same-tab destination', async () => {
    const { sourceFolder, targetFolder, dispatchFileExplorerMutation } =
      await openLiveTargetInSameFilesTab()

    await chooseRowAction(targetFolder.name, 'New folder')
    const dialog = await screen.findByRole('dialog', { name: 'New folder' })
    expect(dialog.textContent).toContain(`Create a new folder in ${targetFolder.name}.`)
    expect(dialog.contains(document.activeElement), document.activeElement?.outerHTML).toBe(true)

    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Folder name' }), {
      target: { value: 'Created from sidebar' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create folder' }))

    await waitFor(() =>
      expect(dispatchFileExplorerMutation).toHaveBeenCalledWith({
        operation: 'create-folder',
        target: {
          resourceId: targetFolder.resourceId,
          drive: 'main',
          gfsUri: targetFolder.gfsUri,
          kind: 'directory',
          version: targetFolder.version,
          name: targetFolder.name,
          parentResourceId: sourceFolder.resourceId,
          sessionGeneration: 1,
        },
        name: 'Created from sidebar',
      })
    )
  })

  it('opens the file chooser and uploads into the exact live same-tab destination', async () => {
    const { sourceFolder, targetFolder, dispatchFileExplorerMutation } =
      await openLiveTargetInSameFilesTab()
    const uploadInput = screen.getByLabelText('Upload file', {
      selector: 'input[type="file"]',
    }) as HTMLInputElement
    const clickChooser = vi.spyOn(uploadInput, 'click').mockImplementation(() => undefined)

    await chooseRowAction(targetFolder.name, 'Upload file')
    await waitFor(() => expect(clickChooser).toHaveBeenCalledTimes(1))
    const upload = new File(['test upload'], 'sidebar-upload.md', { type: 'text/markdown' })
    fireEvent.change(uploadInput, { target: { files: [upload] } })

    await waitFor(() =>
      expect(dispatchFileExplorerMutation).toHaveBeenCalledWith({
        operation: 'upload',
        target: {
          resourceId: targetFolder.resourceId,
          drive: 'main',
          gfsUri: targetFolder.gfsUri,
          kind: 'directory',
          version: targetFolder.version,
          name: targetFolder.name,
          parentResourceId: sourceFolder.resourceId,
          sessionGeneration: 1,
        },
        name: 'sidebar-upload.md',
        filePath: 'sidebar-upload.md',
      })
    )
  })

  it('keeps Chat selected while presenting an action for an exact Files target', async () => {
    const target = await resolveResource(
      resolvedFile('22222222222222222222222222222222', 'existing-target.txt')
    )
    const initialTabs = openFilesTab(createWorkspaceTabsState('chat-tab-1'), {
      id: 'existing-target-files',
      path: target.gfsUri,
    })
    appHarness.controller = makeController(selectWorkspaceTab(initialTabs, 'chat-tab-1'))
    const { gfs, dispatchFileExplorerMutation } = installClerum([target])
    renderApp()

    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /existing-target\.txt/ })
    await chooseDeleteAction(target.name)

    expect(await screen.findByText(`Delete ${target.name}?`)).toBeTruthy()
    expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)?.kind).toBe('chat')
    expect(
      appHarness.controller.workspaceTabs.tabs.filter(tab => tab.kind === 'files')
    ).toHaveLength(1)
    expect(gfs.resolve).not.toHaveBeenCalledWith(target.gfsUri)

    await confirmDelete(target.name)
    await waitFor(() =>
      expect(dispatchFileExplorerMutation).toHaveBeenCalledWith({
        operation: 'delete',
        target: {
          resourceId: target.resourceId,
          drive: 'main',
          gfsUri: target.gfsUri,
          kind: 'file',
          version: target.version,
          name: target.name,
          parentResourceId: target.parentResourceId,
          sessionGeneration: 1,
        },
      })
    )
    expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)?.kind).toBe('chat')
  })

  it('hands a sidebar action from Chat with no Files tab to the exact ready resource once', async () => {
    const { gfs, deleteResource, dispatchFileExplorerMutation } = installClerum([targetA])
    appHarness.controller.desktopEnvironmentSetupComplete = false
    renderApp()

    expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)?.kind).toBe('chat')
    expect(appHarness.controller.workspaceTabs.tabs.some(tab => tab.kind === 'files')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /target-a\.txt/ })
    await chooseDeleteAction('target-a.txt')

    expect(await screen.findByText('Delete target-a.txt?')).toBeTruthy()
    expect(gfs.resolve).not.toHaveBeenCalledWith(targetA.gfsUri)
    await expectActionAtConsumer(appHarness.filesPagePendingActions, targetA.gfsUri, 'delete')
    expect(deleteResource).not.toHaveBeenCalled()
    expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)?.kind).toBe('chat')
    expect(appHarness.controller.workspaceTabs.tabs.some(tab => tab.kind === 'files')).toBe(false)

    await confirmDelete('target-a.txt')
    await waitFor(() =>
      expect(dispatchFileExplorerMutation).toHaveBeenCalledWith({
        operation: 'delete',
        target: {
          resourceId: targetA.resourceId,
          drive: 'main',
          gfsUri: targetA.gfsUri,
          kind: 'file',
          version: targetA.version,
          name: targetA.name,
          parentResourceId: targetA.parentResourceId,
          sessionGeneration: 1,
        },
      })
    )
    expect(gfs.resolve).not.toHaveBeenCalledWith(targetA.gfsUri)
  })

  it('keeps a pending sidebar action bound when its active owner tab is selected again', async () => {
    const { gfs, deleteResource } = installClerum([targetA])
    appHarness.controller.desktopEnvironmentSetupComplete = false
    renderApp()

    expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)?.kind).toBe('chat')
    expect(appHarness.controller.workspaceTabs.tabs.some(tab => tab.kind === 'files')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /target-a\.txt/ })
    await chooseDeleteAction('target-a.txt')

    expect(await screen.findByText('Delete target-a.txt?')).toBeTruthy()
    expect(gfs.resolve).not.toHaveBeenCalledWith(targetA.gfsUri)
    expect(deleteResource).not.toHaveBeenCalled()

    const tabs = within(screen.getByRole('toolbar', { name: 'Workspace tabs' })).getAllByRole(
      'button'
    )
    const activeTab = tabs.find(tab => tab.getAttribute('aria-pressed') === 'true')
    expect(activeTab).toBeTruthy()
    expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)?.kind).toBe('chat')
    fireEvent.click(activeTab as HTMLButtonElement)

    expect(await screen.findByText('Delete target-a.txt?')).toBeTruthy()
    await expectActionAtConsumer(appHarness.filesPagePendingActions, targetA.gfsUri, 'delete')
    expect(deleteResource).not.toHaveBeenCalled()
    expect(gfs.resolve).not.toHaveBeenCalledWith(targetA.gfsUri)
  })

  it('keeps a pending folder action bound when the sidebar reopens its source folder', async () => {
    const folder = await resolveResource(
      resolvedDirectory('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'Folder A')
    )
    const { gfs, createFolder } = installClerum([folder])
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
    const resolveCallsBeforeAction = gfs.resolve.mock.calls.filter(
      ([uri]) => uri === folder.gfsUri
    ).length
    const openFilesSection = appHarness.controller.openFilesSection
    await chooseRowAction('Folder A', 'New folder')
    expect(await screen.findByRole('dialog', { name: 'New folder' })).toBeTruthy()
    expect(openFilesSection).not.toHaveBeenCalled()
    expect(gfs.resolve.mock.calls.filter(([uri]) => uri === folder.gfsUri).length).toBe(
      resolveCallsBeforeAction
    )
    await expectActionAtConsumer(appHarness.filesPagePendingActions, folder.gfsUri, 'new-folder')
    expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)?.id).toBe('folder-a-owner')
    expect(screen.queryByRole('dialog', { name: 'New folder' })).toBeTruthy()

    const intentBeforeSelection = appHarness.controller.navigationIntentSequence
    fireEvent.doubleClick(within(folderRow).getByRole('button', { name: 'Folder A' }))
    expect(appHarness.controller.navigationIntentSequence).toBeGreaterThan(intentBeforeSelection)
    expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)).toMatchObject({
      id: 'folder-a-owner',
      kind: 'files',
      files: { path: folder.gfsUri },
    })

    expect(screen.queryByRole('dialog', { name: 'New folder' })).toBeTruthy()
    expect(createFolder).not.toHaveBeenCalled()
  })

  it('keeps a pending sidebar action bound when a tabs shortcut reselects its owner', async () => {
    const { gfs, deleteResource } = installClerum([targetA])
    appHarness.controller.desktopEnvironmentSetupComplete = false
    renderApp()

    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /target-a\.txt/ })
    await chooseDeleteAction('target-a.txt')

    expect(await screen.findByText('Delete target-a.txt?')).toBeTruthy()
    expect(gfs.resolve).not.toHaveBeenCalledWith(targetA.gfsUri)
    await expectActionAtConsumer(appHarness.filesPagePendingActions, targetA.gfsUri, 'delete')
    expect(deleteResource).not.toHaveBeenCalled()

    expect(appHarness.shortcutRegistrationCount).toBeGreaterThan(0)
    expect(appHarness.controller.workspaceTabs.tabs).toHaveLength(1)
    const ownerTabId = activeWorkspaceTab(appHarness.controller.workspaceTabs)?.id
    const activeTabIndex = appHarness.controller.workspaceTabs.tabs.findIndex(
      tab => tab.id === ownerTabId
    )
    expect(activeTabIndex).toBeGreaterThanOrEqual(0)
    expect(document.querySelector('[role="dialog"][aria-modal="true"]')).toBeTruthy()
    const commandId = `tabs.select${activeTabIndex + 1}`
    act(() => appHarness.shortcutCommand(commandId, 'host'))
    expect(appHarness.lastShortcutCommand).toBe(commandId)
    expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)?.id).toBe(ownerTabId)
    expect(await screen.findByText('Delete target-a.txt?')).toBeTruthy()
    await expectActionAtConsumer(appHarness.filesPagePendingActions, targetA.gfsUri, 'delete')
    expect(deleteResource).not.toHaveBeenCalled()
  })

  it('keeps a pending Files action when the drawer chat switcher advances user intent', async () => {
    const { gfs, deleteResource } = installClerum([targetA])
    appHarness.controller = makeController(
      openFilesTab(createWorkspaceTabsState('chat-tab-1'), { id: 'files-root', path: null })
    )
    appHarness.controller.desktopEnvironmentSetupComplete = false
    renderApp()

    fireEvent.click(screen.getByRole('button', { name: 'Toggle chat drawer' }))
    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /target-a\.txt/ })
    await chooseDeleteAction('target-a.txt')

    expect(await screen.findByText('Delete target-a.txt?')).toBeTruthy()
    expect(gfs.resolve).not.toHaveBeenCalledWith(targetA.gfsUri)
    await expectActionAtConsumer(appHarness.filesPagePendingActions, targetA.gfsUri, 'delete')
    expect(deleteResource).not.toHaveBeenCalled()

    fireEvent.click(await screen.findByRole('button', { name: 'Open chats' }))
    const chats = await screen.findByRole('listbox', { name: 'Open chats' })
    const currentChat = within(chats).getByRole('option', { name: 'New chat' })
    const intentBeforeSelection = appHarness.controller.navigationIntentSequence
    fireEvent.click(currentChat)
    expect(appHarness.controller.navigationIntentSequence).toBeGreaterThan(intentBeforeSelection)
    expect(await screen.findByText('Delete target-a.txt?')).toBeTruthy()
    await expectActionAtConsumer(appHarness.filesPagePendingActions, targetA.gfsUri, 'delete')
    expect(deleteResource).not.toHaveBeenCalled()
  })

  it('keeps a pending Files action when the sidebar selects a chat in the open drawer', async () => {
    const latestChatSessions = await produceLatestSidebarSession()
    const { gfs, deleteResource } = installClerum([targetA])
    appHarness.controller = makeController(
      openFilesTab(createWorkspaceTabsState('chat-tab-1'), { id: 'files-root', path: null })
    )
    appHarness.controller.desktopEnvironmentSetupComplete = false
    appHarness.controller.latestChatSessions = latestChatSessions
    renderApp()

    fireEvent.click(screen.getByRole('button', { name: 'Toggle chat drawer' }))
    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /target-a\.txt/ })
    await chooseDeleteAction('target-a.txt')
    expect(await screen.findByText('Delete target-a.txt?')).toBeTruthy()
    expect(gfs.resolve).not.toHaveBeenCalledWith(targetA.gfsUri)
    await expectActionAtConsumer(appHarness.filesPagePendingActions, targetA.gfsUri, 'delete')
    expect(deleteResource).not.toHaveBeenCalled()

    const ownerTabId = activeWorkspaceTab(appHarness.controller.workspaceTabs)?.id
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

    expect(await screen.findByText('Delete target-a.txt?')).toBeTruthy()
    await expectActionAtConsumer(appHarness.filesPagePendingActions, targetA.gfsUri, 'delete')
    expect(deleteResource).not.toHaveBeenCalled()
    expect(appHarness.controller.navigationIntentSequence).toBeGreaterThan(intentBeforeSelection)
  })

  it('keeps a pending Files action when a notification selects a drawer chat', async () => {
    const { gfs, deleteResource } = installClerum([targetA])
    appHarness.controller = makeController(
      openFilesTab(createWorkspaceTabsState('chat-tab-1'), { id: 'files-root', path: null })
    )
    appHarness.controller.desktopEnvironmentSetupComplete = false
    appHarness.controller.notifications = [produceConversationNotification()]
    renderApp()

    fireEvent.click(screen.getByRole('button', { name: 'Toggle chat drawer' }))
    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /target-a\.txt/ })
    await chooseDeleteAction('target-a.txt')
    expect(await screen.findByText('Delete target-a.txt?')).toBeTruthy()
    expect(gfs.resolve).not.toHaveBeenCalledWith(targetA.gfsUri)
    await expectActionAtConsumer(appHarness.filesPagePendingActions, targetA.gfsUri, 'delete')

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

    expect(await screen.findByText('Delete target-a.txt?')).toBeTruthy()
    await expectActionAtConsumer(appHarness.filesPagePendingActions, targetA.gfsUri, 'delete')
    expect(deleteResource).not.toHaveBeenCalled()
    expect(gfs.download).not.toHaveBeenCalled()
    expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)?.kind).toBe('files')
  })

  it('keeps a local Files action while a native desktop conversation notification opens', async () => {
    const notificationResolution = deferred<void>()
    appHarness.nativeNotificationContinuation = notificationResolution.promise
    const { gfs, deleteResource } = installClerum([targetA])
    appHarness.controller = makeController(
      openFilesTab(createWorkspaceTabsState('chat-tab-1'), { id: 'files-root', path: null })
    )
    appHarness.controller.desktopEnvironmentSetupComplete = false
    renderApp()

    fireEvent.click(screen.getByRole('button', { name: 'Toggle chat drawer' }))
    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /target-a\.txt/ })
    await chooseDeleteAction('target-a.txt')
    expect(await screen.findByText('Delete target-a.txt?')).toBeTruthy()
    expect(gfs.resolve).not.toHaveBeenCalledWith(targetA.gfsUri)
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

    expect(await screen.findByText('Delete target-a.txt?')).toBeTruthy()
    notificationResolution.resolve()
    await act(async () => nativeNotificationOpen)

    expect(await screen.findByText('Delete target-a.txt?')).toBeTruthy()
    await expectActionAtConsumer(appHarness.filesPagePendingActions, targetA.gfsUri, 'delete')
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

  it('keeps a local Files action bound through native notification Host verification', async () => {
    const { gfs, deleteResource } = installClerum([targetA])
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
      expect(await screen.findByText('Delete target-a.txt?')).toBeTruthy()
      expect(gfs.resolve).not.toHaveBeenCalledWith(targetA.gfsUri)
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
      expect(await screen.findByText('Delete target-a.txt?')).toBeTruthy()
      await expectActionAtConsumer(appHarness.filesPagePendingActions, targetA.gfsUri, 'delete')
      expect(gfs.resolve).not.toHaveBeenCalledWith(targetA.gfsUri)
      expect(deleteResource).not.toHaveBeenCalled()
      expect(gfs.download).not.toHaveBeenCalled()
      expect(currentController().statusText).toBe(previousStatus)

      await act(async () => {
        verification.resolve({ items: [] })
        await verification.promise
      })
      await waitFor(() => expect(currentController().navItem).toBe(DESKTOP_ROUTES.chat))
      expect(currentController().activeChatId).toBe(notificationChatId)
      expect(await screen.findByText('Delete target-a.txt?')).toBeTruthy()
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

  it('keeps a non-previewable local action after notification selection without downloading', async () => {
    const binary = await resolveResource(
      resolvedFile('66666666666666666666666666666666', 'target-a.bin')
    )
    const { gfs, deleteResource } = installClerum([binary])
    appHarness.controller.desktopEnvironmentSetupComplete = false
    appHarness.controller.notifications = [produceConversationNotification()]
    renderApp()

    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /target-a\.bin/ })
    await chooseDeleteAction('target-a.bin')
    expect(await screen.findByText('Delete target-a.bin?')).toBeTruthy()
    expect(gfs.resolve).not.toHaveBeenCalledWith(binary.gfsUri)
    await expectActionAtConsumer(appHarness.filesPagePendingActions, binary.gfsUri, 'delete')

    fireEvent.click(screen.getByRole('button', { name: 'Open conversation notification' }))

    expect(await screen.findByText('Delete target-a.bin?')).toBeTruthy()
    await expectActionAtConsumer(appHarness.filesPagePendingActions, binary.gfsUri, 'delete')
    expect(gfs.download).not.toHaveBeenCalled()
    expect(deleteResource).not.toHaveBeenCalled()
    expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)?.kind).toBe('chat')
  })

  it('keeps a pending sidebar action bound when sidebar navigation selects Chat', async () => {
    appHarness.controller = makeController(
      openFilesTab(createWorkspaceTabsState('chat-tab-1'), { id: 'files-root', path: null })
    )
    const { gfs, deleteResource } = installClerum([targetA])
    appHarness.controller.desktopEnvironmentSetupComplete = false
    renderApp()

    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /target-a\.txt/ })
    await chooseDeleteAction('target-a.txt')

    expect(await screen.findByText('Delete target-a.txt?')).toBeTruthy()
    expect(gfs.resolve).not.toHaveBeenCalledWith(targetA.gfsUri)
    expect(deleteResource).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('nav-chat'))
    await waitFor(() =>
      expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)?.kind).toBe('chat')
    )
    expect(await screen.findByText('Delete target-a.txt?')).toBeTruthy()
    await expectActionAtConsumer(appHarness.filesPagePendingActions, targetA.gfsUri, 'delete')
    expect(gfs.resolve).not.toHaveBeenCalledWith(targetA.gfsUri)
    expect(deleteResource).not.toHaveBeenCalled()
  })

  it('keeps a pending sidebar action bound when its Files owner tab closes', async () => {
    appHarness.controller = makeController(
      openFilesTab(createWorkspaceTabsState('chat-tab-1'), { id: 'files-owner', path: null })
    )
    const { gfs, dispatchFileExplorerMutation } = installClerum([targetA])
    renderApp()

    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /target-a\.txt/ })
    await chooseDeleteAction('target-a.txt')

    expect(await screen.findByText('Delete target-a.txt?')).toBeTruthy()
    expect(gfs.resolve).not.toHaveBeenCalledWith(targetA.gfsUri)
    await expectActionAtConsumer(appHarness.filesPagePendingActions, targetA.gfsUri, 'delete')

    const ownerTab = getWorkspaceTabButtons('Files').find(
      tab => tab.getAttribute('aria-pressed') === 'true'
    )
    expect(ownerTab).toBeTruthy()
    const ownerTitle = ownerTab?.getAttribute('aria-label')
    expect(ownerTitle).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: `Close ${ownerTitle}` }))
    await waitFor(() => {
      expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)?.kind).toBe('chat')
      expect(appHarness.controller.workspaceTabs.tabs.some(tab => tab.kind === 'files')).toBe(false)
    })

    expect(await screen.findByText('Delete target-a.txt?')).toBeTruthy()
    await confirmDelete('target-a.txt')
    await waitFor(() =>
      expect(dispatchFileExplorerMutation).toHaveBeenCalledWith({
        operation: 'delete',
        target: {
          resourceId: targetA.resourceId,
          drive: 'main',
          gfsUri: targetA.gfsUri,
          kind: 'file',
          version: targetA.version,
          name: targetA.name,
          parentResourceId: targetA.parentResourceId,
          sessionGeneration: 1,
        },
      })
    )
  })

  it('distinguishes an active Files-root tab from no Files tab and completes the same handoff', async () => {
    const workspaceTabs = openFilesTab(createWorkspaceTabsState('chat-tab-1'), {
      id: 'root-files-tab',
      path: null,
    })
    appHarness.controller = makeController(workspaceTabs)
    const { gfs, deleteResource, dispatchFileExplorerMutation } = installClerum([targetA])
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
    expect(await screen.findByText('Delete target-a.txt?')).toBeTruthy()
    expect(gfs.resolve).not.toHaveBeenCalledWith(targetA.gfsUri)
    await confirmDelete('target-a.txt')

    await waitFor(() =>
      expect(dispatchFileExplorerMutation).toHaveBeenCalledWith({
        operation: 'delete',
        target: {
          resourceId: targetA.resourceId,
          drive: 'main',
          gfsUri: targetA.gfsUri,
          kind: 'file',
          version: targetA.version,
          name: targetA.name,
          parentResourceId: targetA.parentResourceId,
          sessionGeneration: 1,
        },
      })
    )
    expect(deleteResource).not.toHaveBeenCalled()
  })

  it('keeps a local action bound while switching between Files tabs', async () => {
    const workspaceTabs = openFilesTab(createWorkspaceTabsState('chat-tab-1'), {
      id: 'root-files-tab',
      path: null,
    })
    appHarness.controller = makeController(workspaceTabs)
    const { deleteResource, gfs, dispatchFileExplorerMutation } = installClerum([targetA])
    renderApp()

    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /target-a\.txt/ })
    await chooseDeleteAction('target-a.txt')

    expect(await screen.findByText('Delete target-a.txt?')).toBeTruthy()
    expect(gfs.resolve).not.toHaveBeenCalledWith(targetA.gfsUri)
    expect(deleteResource).not.toHaveBeenCalled()
    const toolbar = within(screen.getByRole('toolbar', { name: 'Workspace tabs' }))
    const chatTab = toolbar.getByRole('button', { name: 'New chat' })
    fireEvent.click(chatTab)
    await waitFor(() =>
      expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)?.kind).toBe('chat')
    )
    expect(await screen.findByText('Delete target-a.txt?')).toBeTruthy()
    await expectActionAtConsumer(appHarness.filesPagePendingActions, targetA.gfsUri, 'delete')
    fireEvent.click(getWorkspaceTabButtons('Files')[0]!)
    await waitFor(() =>
      expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)?.id).toBe('root-files-tab')
    )
    expect(await screen.findByText('Delete target-a.txt?')).toBeTruthy()
    await confirmDelete('target-a.txt')
    await waitFor(() =>
      expect(dispatchFileExplorerMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'delete',
          target: expect.objectContaining({
            resourceId: targetA.resourceId,
            gfsUri: targetA.gfsUri,
            version: targetA.version,
            sessionGeneration: 1,
          }),
        })
      )
    )
    expect(deleteResource).not.toHaveBeenCalled()
  })

  it('does not replay a pending Delete after its Files presenter remounts', async () => {
    const workspaceTabs = openFilesTab(createWorkspaceTabsState('chat-tab-1'), {
      id: 'delete-remount-files',
      path: null,
    })
    appHarness.controller = makeController(selectWorkspaceTab(workspaceTabs, 'chat-tab-1'))
    const { dispatchFileExplorerMutation } = installClerum([targetA])
    const mutation = deferred<{ resourceId: string; version: number }>()
    dispatchFileExplorerMutation.mockImplementation(() => mutation.promise)
    renderApp()

    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /target-a\.txt/ })
    await chooseDeleteAction('target-a.txt')
    await confirmDelete('target-a.txt')
    await waitFor(() => expect(dispatchFileExplorerMutation).toHaveBeenCalledTimes(1))

    fireEvent.click(getWorkspaceTabButtons('Files')[0]!)
    await waitFor(() =>
      expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)?.id).toBe(
        'delete-remount-files'
      )
    )
    await confirmDelete('target-a.txt')
    expect(dispatchFileExplorerMutation).toHaveBeenCalledTimes(1)

    await act(async () => {
      mutation.resolve({ resourceId: targetA.resourceId, version: targetA.version + 1 })
      await mutation.promise
    })
    await waitFor(() => expect(screen.queryByText('Delete target-a.txt?')).toBeNull())
    expect(dispatchFileExplorerMutation).toHaveBeenCalledTimes(1)
    expect(dispatchFileExplorerMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'delete',
        target: expect.objectContaining({
          resourceId: targetA.resourceId,
          gfsUri: targetA.gfsUri,
          version: targetA.version,
          sessionGeneration: 1,
        }),
      })
    )
  })

  it('does not replay an in-flight Upload after its Files presenter remounts', async () => {
    const folder = await resolveResource(
      resolvedDirectory('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'upload-target')
    )
    const workspaceTabs = openFilesTab(createWorkspaceTabsState('chat-tab-1'), {
      id: 'upload-remount-files',
      path: null,
    })
    appHarness.controller = makeController(selectWorkspaceTab(workspaceTabs, 'chat-tab-1'))
    const { dispatchFileExplorerMutation } = installClerum([folder])
    const mutation = deferred<{ resourceId: string; version: number }>()
    dispatchFileExplorerMutation.mockImplementation(() => mutation.promise)
    renderApp()

    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /upload-target/ })
    await chooseRowAction('upload-target', 'Upload file')
    const firstInput = screen.getByLabelText('Upload file', {
      selector: 'input[type="file"]',
    }) as HTMLInputElement
    fireEvent.change(firstInput, {
      target: { files: [new File(['first'], 'first.txt', { type: 'text/plain' })] },
    })
    await waitFor(() => expect(dispatchFileExplorerMutation).toHaveBeenCalledTimes(1))

    fireEvent.click(getWorkspaceTabButtons('Files')[0]!)
    await waitFor(() =>
      expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)?.id).toBe(
        'upload-remount-files'
      )
    )
    const remountedInput = screen.getByLabelText('Upload file', {
      selector: 'input[type="file"]',
    }) as HTMLInputElement
    fireEvent.change(remountedInput, {
      target: { files: [new File(['second'], 'second.txt', { type: 'text/plain' })] },
    })
    await act(async () => Promise.resolve())
    expect(appHarness.sidebarMutationClaims).toContainEqual(
      expect.objectContaining({ claimed: false })
    )
    expect(dispatchFileExplorerMutation).toHaveBeenCalledTimes(1)

    await act(async () => {
      mutation.resolve({ resourceId: folder.resourceId, version: folder.version + 1 })
      await mutation.promise
    })
    await waitFor(() =>
      expect(appHarness.controller.pushToast).toHaveBeenCalledWith('Uploaded first.txt', 'success')
    )
    expect(dispatchFileExplorerMutation).toHaveBeenCalledTimes(1)
    expect(dispatchFileExplorerMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'upload',
        target: expect.objectContaining({
          resourceId: folder.resourceId,
          gfsUri: folder.gfsUri,
          version: folder.version,
          sessionGeneration: 1,
        }),
        name: 'first.txt',
      })
    )
  })

  it('does not replay an in-flight Replace after its Files presenter remounts', async () => {
    const workspaceTabs = openFilesTab(createWorkspaceTabsState('chat-tab-1'), {
      id: 'replace-remount-files',
      path: null,
    })
    appHarness.controller = makeController(selectWorkspaceTab(workspaceTabs, 'chat-tab-1'))
    const { dispatchFileExplorerMutation } = installClerum([targetA])
    const mutation = deferred<{ resourceId: string; version: number }>()
    dispatchFileExplorerMutation.mockImplementation(() => mutation.promise)
    renderApp()

    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /target-a\.txt/ })
    await chooseRowAction('target-a.txt', 'Replace file')
    const firstInput = screen.getByLabelText('Replace target-a.txt', {
      selector: 'input[type="file"]',
    }) as HTMLInputElement
    fireEvent.change(firstInput, {
      target: { files: [new File(['first'], 'first.txt', { type: 'text/plain' })] },
    })
    await waitFor(() => expect(dispatchFileExplorerMutation).toHaveBeenCalledTimes(1))

    fireEvent.click(getWorkspaceTabButtons('Files')[0]!)
    await waitFor(() =>
      expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)?.id).toBe(
        'replace-remount-files'
      )
    )
    await act(async () => Promise.resolve())
    expect(appHarness.sidebarMutationClaims).toContainEqual(
      expect.objectContaining({ claimed: false })
    )
    expect(dispatchFileExplorerMutation).toHaveBeenCalledTimes(1)

    await act(async () => {
      mutation.resolve({ resourceId: targetA.resourceId, version: targetA.version + 1 })
      await mutation.promise
    })
    await waitFor(() =>
      expect(appHarness.controller.pushToast).toHaveBeenCalledWith(
        'Replaced target-a.txt',
        'success'
      )
    )
    expect(dispatchFileExplorerMutation).toHaveBeenCalledTimes(1)
    expect(dispatchFileExplorerMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'replace',
        target: expect.objectContaining({
          resourceId: targetA.resourceId,
          gfsUri: targetA.gfsUri,
          version: targetA.version,
          sessionGeneration: 1,
        }),
      })
    )
  })

  it('rechecks a Files path after an explicit navigation settles across a mutation', async () => {
    const savedDirectory = await resolveResource(
      resolvedDirectory('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'Saved directory')
    )
    const explicitDirectory = await resolveResource(
      resolvedDirectory('cccccccccccccccccccccccccccccccc', 'Explicit directory')
    )
    const workspaceTabs = openFilesTab(createWorkspaceTabsState('chat-tab-1'), {
      id: 'files-convergence-intent',
      path: savedDirectory.gfsUri,
    })
    appHarness.controller = makeController(workspaceTabs)
    const { gfs } = installClerum([savedDirectory, explicitDirectory])
    const reconciledLocation = await resolveResource(
      resolvedDirectory('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'Authorized location')
    )
    const resolveConvergenceLocation = vi.fn(async () => ({
      available: true as const,
      location: {
        resourceId: reconciledLocation.resourceId,
        rid: reconciledLocation.rid,
        gfsUri: reconciledLocation.gfsUri,
        name: reconciledLocation.name,
        kind: 'directory' as const,
        version: reconciledLocation.version,
      },
      breadcrumbs: [],
    }))
    Object.assign(gfs, { resolveConvergenceLocation })
    appHarness.captureFilesPagePropsOnly = true
    renderApp()

    const initialReconcileCalls = vi.mocked(appHarness.controller.reconcileFilesConvergence).mock
      .calls.length
    const filesProps = appHarness.filesPagePropsByTab.get('files-convergence-intent')
    let receipt: FilesPathIntentReceipt | null = null
    act(() => {
      receipt = filesProps?.onExplicitNavigationIntent?.() ?? null
    })
    expect(receipt).not.toBeNull()

    act(() => appHarness.controller.recordFilesMutation())
    await waitFor(() =>
      expect(
        vi.mocked(appHarness.controller.reconcileFilesConvergence).mock.calls.length
      ).toBeGreaterThan(initialReconcileCalls)
    )
    expect(resolveConvergenceLocation).not.toHaveBeenCalled()

    act(() => {
      filesProps?.onExplicitNavigationResult?.(
        receipt,
        true,
        explicitDirectory.gfsUri,
        explicitDirectory.name
      )
    })
    await waitFor(() => expect(resolveConvergenceLocation).toHaveBeenCalledTimes(1))
    expect(appHarness.controller.commitFilesPathIntent).toHaveBeenCalledWith(
      receipt,
      explicitDirectory.gfsUri,
      explicitDirectory.name
    )
    expect(resolveConvergenceLocation).toHaveBeenCalledWith(explicitDirectory.gfsUri, 1, undefined)
    await waitFor(() =>
      expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)).toMatchObject({
        id: 'files-convergence-intent',
        kind: 'files',
        files: { path: reconciledLocation.gfsUri },
      })
    )
  })

  it('does not let a stale Files tab navigation result settle the active tab receipt', async () => {
    const directoryA = await resolveResource(
      resolvedDirectory('dddddddddddddddddddddddddddddddd', 'Navigation A')
    )
    const directoryB = await resolveResource(
      resolvedDirectory('eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', 'Navigation B')
    )
    const filesA = openFilesTab(createWorkspaceTabsState('chat-tab-1'), {
      id: 'files-navigation-a',
      path: directoryA.gfsUri,
    })
    const filesAB = openFilesTab(filesA, { id: 'files-navigation-b', path: directoryB.gfsUri })
    appHarness.controller = makeController(selectWorkspaceTab(filesAB, 'files-navigation-a'))
    installClerum([directoryA, directoryB])
    renderApp()

    const propsA = appHarness.filesPagePropsByTab.get('files-navigation-a')
    let receiptA: FilesPathIntentReceipt | null = null
    act(() => {
      receiptA = propsA?.onExplicitNavigationIntent?.() ?? null
    })
    expect(receiptA).not.toBeNull()

    act(() => appHarness.controller.selectWorkspaceTabById('files-navigation-b'))
    const propsB = appHarness.filesPagePropsByTab.get('files-navigation-b')
    let receiptB: FilesPathIntentReceipt | null = null
    act(() => {
      receiptB = propsB?.onExplicitNavigationIntent?.() ?? null
    })
    expect(receiptB).not.toBeNull()
    expect((receiptB as FilesPathIntentReceipt | null)?.tabId).toBe('files-navigation-b')

    act(() => {
      propsA?.onExplicitNavigationResult?.(receiptA, true, directoryA.gfsUri, directoryA.name)
    })
    expect(appHarness.controller.commitFilesPathIntent).not.toHaveBeenCalled()
    expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)).toMatchObject({
      id: 'files-navigation-b',
      kind: 'files',
      files: { path: directoryB.gfsUri },
    })

    act(() => {
      propsB?.onExplicitNavigationResult?.(receiptB, true, directoryA.gfsUri, directoryA.name)
    })
    expect(appHarness.controller.commitFilesPathIntent).toHaveBeenCalledTimes(1)
    expect(appHarness.controller.commitFilesPathIntent).toHaveBeenCalledWith(
      receiptB,
      directoryA.gfsUri,
      directoryA.name
    )
    expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)).toMatchObject({
      id: 'files-navigation-b',
      kind: 'files',
      files: { path: directoryA.gfsUri },
    })
  })

  it('fences a refresh result after its Files page unmounts and another tab starts navigation', async () => {
    const directoryA = await resolveResource(
      resolvedDirectory('ffffffffffffffffffffffffffffffff', 'Refresh A')
    )
    const directoryB = await resolveResource(
      resolvedDirectory('11111111111111111111111111111112', 'Refresh B')
    )
    const filesA = openFilesTab(createWorkspaceTabsState('chat-tab-1'), {
      id: 'files-refresh-a',
      path: directoryA.gfsUri,
    })
    const filesAB = openFilesTab(filesA, { id: 'files-refresh-b', path: directoryB.gfsUri })
    appHarness.controller = makeController(selectWorkspaceTab(filesAB, 'files-refresh-a'))
    const { gfs } = installClerum([directoryA, directoryB])
    appHarness.renderTitlebarRoot = true
    renderApp()

    await waitFor(() => expect(gfs.resolve).toHaveBeenCalledWith(directoryA.gfsUri))
    const pendingRefresh = deferred<Awaited<ReturnType<typeof resolveResource>>>()
    gfs.resolve.mockImplementationOnce(() => pendingRefresh.promise)
    const actionsToolbar = within(screen.getByRole('toolbar', { name: 'EvenDrive actions' }))
    fireEvent.click(actionsToolbar.getByRole('button', { name: 'Refresh' }))

    await waitFor(() => expect(gfs.resolve).toHaveBeenCalledTimes(2))
    act(() => appHarness.controller.selectWorkspaceTabById('files-refresh-b'))
    await waitFor(() =>
      expect(appHarness.filesPageLastLocation).toEqual({
        gfsUri: directoryB.gfsUri,
        name: directoryB.name,
      })
    )
    const propsB = appHarness.filesPagePropsByTab.get('files-refresh-b')
    let receiptB: FilesPathIntentReceipt | null = null
    act(() => {
      receiptB = propsB?.onExplicitNavigationIntent?.() ?? null
    })
    expect((receiptB as FilesPathIntentReceipt | null)?.tabId).toBe('files-refresh-b')
    const commitsBeforeOldPageSettles = vi.mocked(appHarness.controller.commitFilesPathIntent).mock
      .calls.length

    await act(async () => {
      pendingRefresh.resolve(directoryA)
      await pendingRefresh.promise
    })
    expect(vi.mocked(appHarness.controller.commitFilesPathIntent)).toHaveBeenCalledTimes(
      commitsBeforeOldPageSettles
    )
    expect(appHarness.controller.pushToast).not.toHaveBeenCalledWith(
      'EvenDrive refreshed',
      'success'
    )
    expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)).toMatchObject({
      id: 'files-refresh-b',
      kind: 'files',
      files: { path: directoryB.gfsUri },
    })
  })

  it('does not replay a completed sidebar action after leaving and returning', async () => {
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
    await waitFor(() => expect(gfs.copyDeepLink).toHaveBeenCalledWith(targetA.gfsUri, 1))
    await waitFor(() =>
      expect(appHarness.controller.pushToast).toHaveBeenCalledWith(
        'EvenDrive link copied.',
        'success'
      )
    )
    expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)).toMatchObject({
      kind: 'files',
      files: { path: null },
    })
    expect(gfs.resolve).not.toHaveBeenCalledWith(targetA.gfsUri)

    const chatTab = within(screen.getByRole('toolbar', { name: 'Workspace tabs' })).getByRole(
      'button',
      { name: 'New chat' }
    )
    fireEvent.click(chatTab)
    expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)?.kind).toBe('chat')
    fireEvent.click(getWorkspaceTabButtons('Files')[0]!)
    expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)).toMatchObject({
      kind: 'files',
      files: { path: null },
    })
    expect(gfs.resolve).not.toHaveBeenCalledWith(targetA.gfsUri)
    expect(gfs.copyDeepLink).toHaveBeenCalledTimes(1)
  })

  it('copies a sidebar link without navigating the Files tab to the clicked row', async () => {
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
    await waitFor(() => expect(gfs.copyDeepLink).toHaveBeenCalledWith(targetA.gfsUri, 1))
    await waitFor(() =>
      expect(appHarness.controller.pushToast).toHaveBeenCalledWith(
        'EvenDrive link copied.',
        'success'
      )
    )
    expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)).toMatchObject({
      kind: 'files',
      files: { path: null },
    })
    expect(gfs.copyDeepLink).toHaveBeenCalledTimes(1)
    expect(gfs.resolve).not.toHaveBeenCalledWith(targetA.gfsUri)
  })

  it('copies the exact sidebar ID from Chat without changing the selected workspace tab', async () => {
    const { gfs } = installClerum([targetA])
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    renderApp()

    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /target-a\.txt/ })
    const chatTab = activeWorkspaceTab(appHarness.controller.workspaceTabs)
    expect(chatTab?.kind).toBe('chat')
    await chooseRowAction('target-a.txt', 'Copy file ID')

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(targetA.gfsUri))
    expect(activeWorkspaceTab(appHarness.controller.workspaceTabs)?.id).toBe(chatTab?.id)
    expect(gfs.resolve).not.toHaveBeenCalledWith(targetA.gfsUri)
  })

  it('dispatches the newer clicked row after the earlier action is canceled', async () => {
    const { deleteResource, gfs, dispatchFileExplorerMutation } = installClerum([targetA, targetB])
    renderApp()

    fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
    await screen.findByRole('treeitem', { name: /target-a\.txt/ })
    await screen.findByRole('treeitem', { name: /target-b\.txt/ })
    await chooseDeleteAction('target-a.txt')
    expect(await screen.findByText('Delete target-a.txt?')).toBeTruthy()
    expect(gfs.resolve).not.toHaveBeenCalledWith(targetA.gfsUri)
    expect(deleteResource).not.toHaveBeenCalled()
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Delete target-a.txt?' })).getByRole('button', {
        name: 'Cancel',
      })
    )
    await chooseDeleteAction('target-b.txt')
    expect(await screen.findByText('Delete target-b.txt?')).toBeTruthy()
    await confirmDelete('target-b.txt')

    await waitFor(() =>
      expect(dispatchFileExplorerMutation).toHaveBeenCalledWith({
        operation: 'delete',
        target: {
          resourceId: targetB.resourceId,
          drive: 'main',
          gfsUri: targetB.gfsUri,
          kind: 'file',
          version: targetB.version,
          name: targetB.name,
          parentResourceId: targetB.parentResourceId,
          sessionGeneration: 1,
        },
      })
    )
    expect(screen.queryByText('Delete target-a.txt?')).toBeNull()
    expect(deleteResource).not.toHaveBeenCalled()
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
      const { gfs, moveResource, dispatchFileExplorerMutation } = installClerum(
        [parent, target, destination],
        new Map(),
        {
          accessibleRows: [
            accessibleResource(parent.resourceId, parent.name, 'directory', {
              gfsUri: parent.gfsUri,
            }),
            accessibleResource(destination.resourceId, destination.name, 'directory', {
              gfsUri: destination.gfsUri,
            }),
          ],
          childRowsByParent: new Map([[parent.resourceId, [unreadableChild]]]),
        }
      )
      renderApp()

      fireEvent.click(screen.getByRole('button', { name: 'Expand file explorer' }))
      const parentRow = await screen.findByRole('treeitem', { name: /Shared parent/ })
      fireEvent.click(within(parentRow).getByRole('button', { name: 'Expand Shared parent' }))
      await findResourceTreeRow('unreadable-child.txt')
      await chooseRowAction(target.name, 'Move to')

      if (!readable) expect(gfs.resolve).not.toHaveBeenCalledWith(target.gfsUri)

      const dialog = await screen.findByRole('dialog', { name: 'Move file unreadable-child.txt' })
      expect(dialog.querySelector('.da-gfs-move-dialog__current-location')?.textContent).toContain(
        'Shared parent'
      )
      fireEvent.click(await within(dialog).findByRole('button', { name: destination.name }))
      fireEvent.click(
        within(dialog).getByRole('button', { name: `Move here (${destination.name})` })
      )

      await waitFor(() =>
        expect(dispatchFileExplorerMutation).toHaveBeenCalledWith({
          operation: 'move',
          target: {
            resourceId: target.resourceId,
            drive: 'main',
            gfsUri: target.gfsUri,
            kind: 'file',
            version: target.version,
            name: target.name,
            parentResourceId: parent.resourceId,
            sessionGeneration: 1,
          },
          destinationResourceId: destination.resourceId,
        })
      )
      if (!readable) expect(gfs.resolve).not.toHaveBeenCalledWith(target.gfsUri)
      expect(moveResource).not.toHaveBeenCalled()
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
