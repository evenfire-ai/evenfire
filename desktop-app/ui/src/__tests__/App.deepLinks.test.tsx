// @vitest-environment jsdom
import { type ReactNode, useEffect, useReducer, useRef, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { buildGfsResourceDeepLink, parseGfsResourceDeepLink } from '@clerum/desktop-app-links'
import { DESKTOP_ROUTES, SIDEBAR_COLLAPSED_KEY } from '@constants/navigation'
import type { GfsBrowserChild } from '@hooks/domain/useGfsBrowserController'
import { useAppController } from '@hooks/useAppController'
import { resetComposerDraftStore } from '@lib/composerDraftStore'
import {
  clearLatestGfsConversationContext,
  recordLatestGfsConversationContext,
} from '@lib/gfsConversationPrefill'
import type { GfsResourceActionId, GfsResourceActionRequest } from '@lib/gfsResourceActions'
import {
  type GfsResourceNavigationRequest,
  assignGfsResourceNavigationOwner,
  canCompleteGfsResourceNavigation,
  isGfsResourceNavigationOwnerPresent,
} from '@lib/gfsResourceNavigationIntent'
import {
  activeWorkspaceTab,
  createFilesTab,
  createWorkspaceTabsState,
  newChatTab,
  openChatTab,
  openFilesTab,
  openPreviewTab,
  openSettingsTab,
  selectWorkspaceTab,
  setAppTabSavedRoutePath,
} from '@lib/workspaceTabs'
import { mapKindToRoute, settingsSectionForRoute } from '@lib/workspaceTabsRoute'
import { App } from '@/App'
import type { GfsResourceDeepLinkEnvelope, SandboxUiDeepLinkEnvelope } from '@/App.types'
import {
  childView,
  listChildrenPage,
  resolveDeniedMessage,
  resolveResource,
  resolvedDirectory,
  resolvedFile,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
import type { DesktopCommandId } from '../../../src/desktopCommands'
import { GfsResourceDeepLinkQueue } from '../../../src/gfsResourceDeepLinkQueue'

// The universal tab store lives inside the controller; the mock reproduces that
// contract — `navItem` is DERIVED from the store, the store is reactive, and nav
// drives it through the real producers (T1). See App.chatDrawer.test for the
// rationale.
let forceControllerRender: () => void = () => {}
let testNavigationIntentSequence = 0
let testUserNavigationGeneration = 0
type WorkspaceState = ReturnType<typeof useAppController>['workspaceTabs']

function produceGfsResourceDeepLink(
  uri: string,
  queue = new GfsResourceDeepLinkQueue(),
  userNavigationGenerationAtActivation = testUserNavigationGeneration
): GfsResourceDeepLinkEnvelope {
  const target = parseGfsResourceDeepLink(buildGfsResourceDeepLink(uri))
  if (!target) throw new Error('The shared producer rejected the GFS resource URI fixture')
  return queue.enqueue(target, userNavigationGenerationAtActivation)
}

function useReactiveController(controller: AppController): AppController {
  const [, force] = useReducer((count: number) => count + 1, 0)
  forceControllerRender = force
  const activeTab = activeWorkspaceTab(controller.workspaceTabs)
  filesPageHarness.activeTabId = activeTab?.id ?? null
  filesPageHarness.activeFilesRoute =
    activeTab?.kind === 'files' ? (activeTab.files?.path ?? null) : null
  controller.navigationIntentSequence = testNavigationIntentSequence
  ;(controller as { activeWorkspaceTab: unknown }).activeWorkspaceTab = activeTab
  ;(controller as { navItem: unknown }).navItem = controller.appsPickerActive
    ? DESKTOP_ROUTES.apps
    : mapKindToRoute(activeTab)
  return controller
}

const confirmDialogHarness = vi.hoisted(() => ({
  rendered: vi.fn(),
  // Counts how many ConfirmDialogs are actually on screen right now,
  // independently of the overlay signal, so the signal<->dialog invariant can
  // be asserted without reading a stale `props` snapshot after unmount. A count
  // (not a boolean) so a second concurrent dialog's cleanup cannot falsely mark
  // the surface empty while the first is still mounted.
  mountedCount: 0,
  props: null as null | {
    title: string
    body?: ReactNode
    cancelLabel?: string
    confirmLabel?: string
    onCancel: () => void
    onConfirm: () => void
  },
}))

const appHeaderHarness = vi.hoisted(() => ({
  props: null as null | {
    placement?: 'default' | 'titlebar'
    searchFocusRequestId?: number
    notificationOpenRequestId?: number
    gfsAuthorizationChangeEpoch?: number
    onOpenGfsResource?: (uri: string) => void
    onToggleChatDrawer?: () => void
  },
}))

const chatLocalSearchHarness = vi.hoisted(() => ({ rendered: vi.fn() }))
const filesPageHarness = vi.hoisted(() => ({
  pendingGfsUri: null as string | null,
  routeDialogRequestId: 0,
  pendingResourceAction: null as GfsResourceActionRequest | null,
  onLocationChange: null as ((uri: string | null, name: string | null) => void) | null,
  onPendingResourceActionHandled: null as ((requestId: number) => void) | null,
  activeTabId: null as string | null,
  activeFilesRoute: null as string | null,
  mountCount: 0,
  handledRouteRequestIds: [] as number[],
  resolveOnDeepLink: false,
  resolveRequests: [] as Array<{ id: number; tabId: string; uri: string }>,
  props: null as null | {
    pendingGfsDeepLink?: { id: number; uri: string } | null
    onLocationChange?: (uri: string | null, name: string | null) => void
    onExplicitNavigationIntent?: () => void
    workspaceTabId?: string
    routeDialogRequestId?: number
    onRouteDialogRequestHandled?: (requestId: number) => void
    onPendingGfsDeepLinkOutcome?: (
      id: number,
      outcome: 'opened' | 'terminal' | 'retryable' | 'superseded'
    ) => void
  },
}))
const previewPageHarness = vi.hoisted(() => ({
  props: null as null | { onOpenRoute?: () => void },
}))

const commandPaletteHarness = vi.hoisted(() => ({
  props: null as null | {
    isEligible: (commandId: DesktopCommandId) => boolean
    onClose: () => void
    onExecute: (commandId: DesktopCommandId) => void
  },
}))

type SidebarLaunchApp = { appRef: string; label: string; defaultPath: string; routePath?: string }
const sidebarHarness = vi.hoisted(() => ({
  props: null as null | {
    toggleRequestId?: number
    collapsed?: boolean
    onCollapsedChange?: (next: boolean) => void
    onGfsResourceAction?: (
      resource: GfsBrowserChild,
      actionId: GfsResourceActionId,
      file?: File
    ) => void
    availableSandboxUiApps?: SidebarLaunchApp[]
    onOpenSandboxUiApp?: (app: SidebarLaunchApp) => void
  },
}))

const sandboxUiPageHarness = vi.hoisted(() => ({
  props: null as null | {
    headerShellOverlayOpen?: boolean
    deepLinkShellOverlayOpen?: boolean
    shortcutApp?: {
      appRef: string
      label?: string
      defaultPath?: string
      routePath?: string
    } | null
    shortcutOpenRequestId?: number
    localSearchRequestId?: number
    actionRequest?: {
      id: number
      action: 'refresh' | 'back-to-apps'
    } | null
    onEmbeddedAppOpening?: (app: {
      appRef: string
      label: string
      icon?: string | null
      defaultPath: string
      routePath?: string
    }) => void
    onEmbeddedAppMounted?: () => void
    onEmbeddedAppBack?: () => void
    onEmbeddedAppOpenFailed?: () => void
    onShortcutOpenResult?: (
      requestId: number,
      result: { status: 'mounted' } | { status: 'failed'; message: string }
    ) => void | Promise<void>
  },
}))

vi.mock('@hooks/useAppController', () => ({
  useAppController: vi.fn(),
}))

vi.mock('@hooks/useAgentChatActionsValue', () => ({
  useAgentChatActionsValue: () => ({}),
}))

vi.mock('@components/AppHeader', () => ({
  AppHeader: (props: NonNullable<typeof appHeaderHarness.props>) => {
    appHeaderHarness.props = props
    return null
  },
}))
vi.mock('@components/ChatLocalSearch', () => ({
  ChatLocalSearch: () => {
    chatLocalSearchHarness.rendered()
    return null
  },
}))
vi.mock('@components/CommandPalette', () => ({
  CommandPalette: (props: NonNullable<typeof commandPaletteHarness.props>) => {
    commandPaletteHarness.props = props
    return <div role="dialog" aria-modal="true" aria-label="Command palette" />
  },
}))
vi.mock('@components/BootSplash', () => ({ BootSplash: () => null }))
vi.mock('@components/ChatDrawer', () => ({
  ChatDrawer: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock('@components/Common', () => ({
  Button: (props: Record<string, unknown>) => (
    <button
      aria-controls={props['aria-controls'] as string | undefined}
      aria-label={props['aria-label'] as string | undefined}
      aria-pressed={props['aria-pressed'] as boolean | undefined}
      className={props.className as string | undefined}
      onClick={props.onClick as (() => void) | undefined}
      type="button"
    >
      {props.children as ReactNode}
    </button>
  ),
  ToastStack: () => null,
}))
vi.mock('@components/ConfirmDialog', () => ({
  ConfirmDialog: (props: {
    title: string
    body?: ReactNode
    onCancel: () => void
    onConfirm: () => void
  }) => {
    confirmDialogHarness.rendered(props)
    confirmDialogHarness.props = props
    useEffect(() => {
      confirmDialogHarness.mountedCount += 1
      return () => {
        confirmDialogHarness.mountedCount -= 1
      }
    }, [])
    return null
  },
}))
vi.mock('@components/SidebarNav', () => ({
  SidebarNav: (props: NonNullable<typeof sidebarHarness.props>) => {
    sidebarHarness.props = props
    return null
  },
}))
vi.mock('@pages/AgentsPage', () => ({ AgentsPage: () => null }))
vi.mock('@pages/AuthPage', () => ({ AuthPage: () => null }))
vi.mock('@pages/FilePreviewPage', () => ({
  FilePreviewPage: (props: NonNullable<typeof previewPageHarness.props>) => {
    previewPageHarness.props = props
    return null
  },
}))
vi.mock('@pages/ChatPage', async () => {
  const { useEffect, useRef } = await import('react')
  const { useChatComposerStateContext } = await import('@contexts/ChatComposerStateContext')
  const { useNavigationContext } = await import('@contexts/NavigationContext')
  const { useComposerDraft } = await import('@hooks/useComposerDraft')
  return {
    ChatPage: () => {
      const { composerFocusRequestId } = useChatComposerStateContext()
      const { selectedAgent } = useNavigationContext()
      const [draft] = useComposerDraft(null, selectedAgent ?? undefined)
      const composerRef = useRef<HTMLTextAreaElement | null>(null)
      useEffect(() => {
        if (composerFocusRequestId > 0) composerRef.current?.focus()
      }, [composerFocusRequestId])
      return (
        <textarea
          data-testid="chat-page-surface"
          data-composer-focus-request-id={composerFocusRequestId}
          data-composer-draft={draft}
          ref={composerRef}
          value={draft}
          readOnly
        />
      )
    },
  }
})
vi.mock('@pages/FilesPage', () => ({
  FilesPage: (props: {
    pendingGfsUri?: string | null
    routeDialogRequestId?: number
    pendingResourceAction?: GfsResourceActionRequest | null
    onLocationChange?: (uri: string | null, name: string | null) => void
    onPendingResourceActionHandled?: (requestId: number) => void
    pendingGfsDeepLink?: { id: number; uri: string } | null
    onExplicitNavigationIntent?: () => void
    workspaceTabId?: string
    onRouteDialogRequestHandled?: (requestId: number) => void
    onPendingGfsDeepLinkOutcome?: (
      id: number,
      outcome: 'opened' | 'terminal' | 'retryable' | 'superseded'
    ) => void
  }) => {
    const handledRequestIdRef = useRef(0)
    const [resolvedUri, setResolvedUri] = useState<string | null>(null)
    const pendingLink = props.pendingGfsDeepLink
    const visibleTabId = props.workspaceTabId ?? filesPageHarness.activeTabId
    filesPageHarness.pendingGfsUri = props.pendingGfsUri ?? null
    filesPageHarness.routeDialogRequestId = props.routeDialogRequestId ?? 0
    filesPageHarness.pendingResourceAction = props.pendingResourceAction ?? null
    filesPageHarness.onLocationChange = props.onLocationChange ?? null
    filesPageHarness.onPendingResourceActionHandled = props.onPendingResourceActionHandled ?? null
    filesPageHarness.props = props
    useEffect(() => {
      filesPageHarness.mountCount += 1
      return () => {
        filesPageHarness.mountCount -= 1
      }
    }, [])
    useEffect(() => {
      const requestId = props.routeDialogRequestId ?? 0
      if (!requestId || handledRequestIdRef.current === requestId) return
      handledRequestIdRef.current = requestId
      filesPageHarness.handledRouteRequestIds.push(requestId)
      props.onRouteDialogRequestHandled?.(requestId)
    }, [props.onRouteDialogRequestHandled, props.routeDialogRequestId])
    useEffect(() => {
      if (!filesPageHarness.resolveOnDeepLink || !pendingLink) return
      let current = true
      const tabId = visibleTabId ?? 'unknown'
      filesPageHarness.resolveRequests.push({ id: pendingLink.id, tabId, uri: pendingLink.uri })
      const resolve = window.clerum.gfs?.resolve
      if (!resolve) throw new Error('The producer-backed GFS resolver is unavailable')
      void resolve(pendingLink.uri).then(
        resource => {
          if (!current) return
          const resolved = resource as { gfsUri?: string; name?: string }
          setResolvedUri(resolved.gfsUri ?? pendingLink.uri)
          props.onLocationChange?.(resolved.gfsUri ?? pendingLink.uri, resolved.name ?? null)
          props.onPendingGfsDeepLinkOutcome?.(pendingLink.id, 'opened')
        },
        () => {
          if (current) props.onPendingGfsDeepLinkOutcome?.(pendingLink.id, 'terminal')
        }
      )
      return () => {
        current = false
      }
    }, [
      pendingLink?.id,
      pendingLink?.uri,
      props.onLocationChange,
      props.onPendingGfsDeepLinkOutcome,
      props.workspaceTabId,
      visibleTabId,
    ])
    return (
      <section
        data-testid="files-page-surface"
        data-tab-id={visibleTabId ?? ''}
        data-saved-route={filesPageHarness.activeFilesRoute ?? ''}
        data-pending-resource-uri={props.pendingGfsDeepLink?.uri ?? ''}
        data-resolved-resource-uri={resolvedUri ?? ''}
      />
    )
  },
}))
vi.mock('@pages/McpServersPage', () => ({ McpServersPage: () => null }))
vi.mock('@pages/SandboxUiPage', () => ({
  SandboxUiPage: (props: NonNullable<typeof sandboxUiPageHarness.props>) => {
    sandboxUiPageHarness.props = props
    return null
  },
}))
const settingsPageHarness = vi.hoisted(() => ({
  props: null as null | { shortcutsFocusRequestId?: number },
}))
vi.mock('@pages/SettingsPage', () => ({
  SettingsPage: (props: NonNullable<typeof settingsPageHarness.props>) => {
    settingsPageHarness.props = props
    return null
  },
}))
vi.mock('@pages/UnavailablePage', () => ({ UnavailablePage: () => null }))
vi.mock('@pages/WorkflowsPage', () => ({ WorkflowsPage: () => null }))

type AppController = ReturnType<typeof useAppController>

function makeController(overrides: Partial<AppController> = {}): AppController {
  const noop = vi.fn()
  let liveTeamId = String(overrides.currentTeamId || 'team-a')
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
  const beginUserNavigationIntent = vi.fn(() => {
    testNavigationIntentSequence += 1
    testUserNavigationGeneration += 1
    forceControllerRender()
    return testNavigationIntentSequence
  })
  const isNavigationIntentCurrent = vi.fn(
    (sequence: number) => sequence === testNavigationIntentSequence
  )
  const showAppsPicker = vi.fn(() => {
    if (controller.appsPickerActive) return
    if (activeWorkspaceTab(controller.workspaceTabs)?.kind === 'app') return
    controller.appsPickerActive = true
    forceControllerRender()
  })
  const ensureTeamContext = vi.fn(async (target: { teamId?: string }): Promise<boolean> => {
    const targetTeamId = String(target.teamId || '').trim()
    if (!targetTeamId || targetTeamId === liveTeamId) return false
    liveTeamId = targetTeamId
    return true
  })
  const beginGfsResourceNavigation = vi.fn(
    (
      id: number,
      uri: string,
      principalGeneration: number,
      userNavigationGenerationAtActivation: number
    ): GfsResourceNavigationRequest | null => {
      if (userNavigationGenerationAtActivation !== testUserNavigationGeneration) return null
      testNavigationIntentSequence += 1
      forceControllerRender()
      const intentSequence = testNavigationIntentSequence
      const state = controller.workspaceTabs
      const owner = assignGfsResourceNavigationOwner(state, uri)
      return {
        id,
        uri,
        ownerTabId: owner.createDestination ? nextWorkspaceTabId() : owner.ownerTabId,
        createDestination: owner.createDestination,
        intentSequence,
        principalGeneration,
        userNavigationGenerationAtActivation,
      }
    }
  )
  const isGfsResourceNavigationCurrent = vi.fn(
    (request: GfsResourceNavigationRequest, principalGeneration: number) =>
      canCompleteGfsResourceNavigation(request, {
        intentSequence: testNavigationIntentSequence,
        principalGeneration,
        userNavigationGeneration: testUserNavigationGeneration,
        activeTabId: controller.workspaceTabs.activeTabId,
        tabs: controller.workspaceTabs.tabs,
      })
  )
  const activateGfsResourceNavigation = vi.fn(
    (request: GfsResourceNavigationRequest, principalGeneration: number) => {
      if (
        !isNavigationIntentCurrent(request.intentSequence) ||
        request.principalGeneration !== principalGeneration ||
        request.userNavigationGenerationAtActivation !== testUserNavigationGeneration
      ) {
        return false
      }
      const state = controller.workspaceTabs
      if (request.createDestination) {
        if (state.tabs.some(tab => tab.id === request.ownerTabId)) return false
        setWorkspaceTabs(createFilesTab(state, { id: request.ownerTabId, path: null }))
      } else {
        if (!isGfsResourceNavigationOwnerPresent(request, state.tabs)) return false
        setWorkspaceTabs(selectWorkspaceTab(state, request.ownerTabId))
      }
      return controller.workspaceTabs.activeTabId === request.ownerTabId
    }
  )
  const completeGfsResourceNavigationPreview = vi.fn(
    (
      request: GfsResourceNavigationRequest,
      preview: Parameters<AppController['completeGfsResourceNavigationPreview']>[1],
      principalGeneration: number,
      _returnLocation?: { gfsUri: string | null; name: string | null },
      sessionScope?: string
    ) => {
      if (!isGfsResourceNavigationCurrent(request, principalGeneration)) return false
      setWorkspaceTabs(
        openPreviewTab(controller.workspaceTabs, {
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
      return controller.workspaceTabs.activeTabId !== request.ownerTabId
    }
  )
  const selectWorkspaceTabById = vi.fn((id: string) => {
    if (!controller.workspaceTabs.tabs.some(tab => tab.id === id)) return false
    beginUserNavigationIntent()
    clearAppsPicker()
    setWorkspaceTabs((state: WorkspaceState) => selectWorkspaceTab(state, id))
    return true
  })
  // Faithful nav: a store action; `navItem` is derived (useReactiveController).
  const handleNavSelect = vi.fn((item: AppController['navItem']) => {
    beginUserNavigationIntent()
    if (item === DESKTOP_ROUTES.chat) {
      controller.selectedAgent = null
      clearAppsPicker()
      setWorkspaceTabs((state: WorkspaceState) => {
        const active = activeWorkspaceTab(state)
        if (active?.kind === 'chat') return state
        const lastChat = [...state.tabs].reverse().find(tab => tab.kind === 'chat')
        return lastChat
          ? { ...state, activeTabId: lastChat.id }
          : newChatTab(state, nextWorkspaceTabId(), null)
      })
    } else if (item === DESKTOP_ROUTES.apps) {
      showAppsPicker()
    } else if (item === DESKTOP_ROUTES.files) {
      clearAppsPicker()
      setWorkspaceTabs((state: WorkspaceState) => openFilesTab(state, { id: nextWorkspaceTabId() }))
    } else {
      const section = settingsSectionForRoute(item)
      if (section) {
        if (section === 'agents') controller.selectedAgent = null
        clearAppsPicker()
        setWorkspaceTabs((state: WorkspaceState) =>
          openSettingsTab(state, { id: nextWorkspaceTabId(), section })
        )
      }
    }
    forceControllerRender()
  })
  const handleSelectChatAgent = vi.fn(
    (agentName: string, options: { chatId?: string; keepNavItem?: boolean } = {}) => {
      controller.selectedAgent = agentName
      controller.activeChatId = options.chatId ?? null
      if (!options.keepNavItem) {
        clearAppsPicker()
        setWorkspaceTabs((state: WorkspaceState) => {
          const chatId = options.chatId ?? null
          return chatId
            ? openChatTab(state, { id: nextWorkspaceTabId(), agentRef: agentName, chatId })
            : newChatTab(state, nextWorkspaceTabId(), agentName)
        })
      }
      forceControllerRender()
    }
  )
  controller = {
    booting: false,
    initialExperienceLoading: true,
    busy: false,
    statusText: '',
    statusTone: 'info',
    isAuthenticated: true,
    authenticatedPrincipalIdentity: 'user-a:user-a@example.com',
    availableTeamIds: ['team-a', 'team-b'],
    teamDirectoryHydrated: true,
    me: {
      id: 'user-a',
      email: 'user-a@example.com',
      name: 'User A',
      picture: null,
      teamId: 'team-a',
      teamName: 'Team A',
      role: 'member',
    },
    currentTeamId: 'team-a',
    navItem: DESKTOP_ROUTES.chat,
    selectedAgent: null,
    selectedAgentRoute: null,
    workspaceTabs: createWorkspaceTabsState('chat-tab-1'),
    setWorkspaceTabs,
    activeWorkspaceTab: undefined,
    nextWorkspaceTabId,
    appsPickerActive: false,
    showAppsPicker,
    clearAppsPicker,
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
    desktopEnvironmentSetupComplete: false,
    pendingDesktopEnvironmentSetup: null,
    desktopReleaseStatus: null,
    showRuntimeConfigSelector: false,
    runtimeConfigMissing: false,
    authTransitioning: false,
    handleEnsureTeamContext: ensureTeamContext,
    getCurrentTeamId: vi.fn(() => liveTeamId),
    isHostAccessBlocked: vi.fn(() => false),
    handleSelectChatAgent,
    handleNavSelect,
    openFilesSection: vi.fn((path: string | null = null) => {
      const intentSequence = beginUserNavigationIntent()
      const next = openFilesTab(controller.workspaceTabs, { id: nextWorkspaceTabId(), path })
      setWorkspaceTabs(next)
      return next.activeTabId ? { ownerTabId: next.activeTabId, intentSequence } : null
    }),
    openPreviewSection: vi.fn(
      (preview: Parameters<AppController['openPreviewSection']>[0], sessionScope?: string) => {
        beginUserNavigationIntent()
        setWorkspaceTabs((state: WorkspaceState) =>
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
      }
    ),
    navigationIntentSequence: testNavigationIntentSequence,
    beginUserNavigationIntent,
    isNavigationIntentCurrent,
    beginGfsResourceNavigation,
    isGfsResourceNavigationCurrent,
    activateGfsResourceNavigation,
    completeGfsResourceNavigationPreview,
    selectWorkspaceTabById,
    handleLogout: vi.fn(),
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
    ...overrides,
  } as unknown as AppController
  // `navItem` is derived from the store; translate a starting-route override into
  // the store state that derives to it.
  if (overrides.navItem) {
    const route = overrides.navItem
    if (route === DESKTOP_ROUTES.apps) {
      controller.appsPickerActive = true
    } else if (route === DESKTOP_ROUTES.files) {
      controller.workspaceTabs = openFilesTab(controller.workspaceTabs, { id: 'seed-files' })
    } else if (route !== DESKTOP_ROUTES.chat) {
      const section = settingsSectionForRoute(route)
      if (section) {
        controller.workspaceTabs = openSettingsTab(controller.workspaceTabs, {
          id: `seed-${section}`,
          section,
        })
      }
    }
  }
  return controller
}

describe('App deep-link orchestration', () => {
  let currentController: AppController
  let emitDeepLink: ((link: SandboxUiDeepLinkEnvelope) => void) | null
  let emitGfsDeepLink: ((link: GfsResourceDeepLinkEnvelope) => void) | null
  let emitCommand: ((commandId: DesktopCommandId, source?: 'host' | 'sandbox') => void) | null
  const clearPendingDeepLinks = vi.fn().mockResolvedValue(undefined)
  const acknowledgeDeepLink = vi.fn().mockResolvedValue(undefined)
  const listApps = vi.fn().mockResolvedValue({ apps: [] })
  const listPendingDeepLinks = vi.fn().mockResolvedValue({ links: [] })
  const acknowledgeGfsDeepLink = vi.fn().mockResolvedValue(undefined)
  const listPendingGfsDeepLinks = vi.fn().mockResolvedValue({ links: [] })
  const resolveGfsResource = vi.fn()
  const clearPendingGfsDeepLinks = vi.fn().mockResolvedValue(1)
  const closeSandboxUi = vi.fn().mockResolvedValue(undefined)
  // Route-persistence read (mini-spec 05). Defaults to "on the default route"
  // (null) so unrelated launch/deactivation tests behave exactly as before;
  // the persistence tests override the resolved value per case.
  const getSandboxUiLocation = vi.fn().mockResolvedValue(null)

  it('prompts to add an environment when a Profile Portal handoff has no saved match', () => {
    const linkProvidedName = 'Tenant from profile link '.repeat(5)
    currentController = makeController({
      initialExperienceLoading: false,
      pendingDesktopEnvironmentSetup: {
        appName: linkProvidedName,
        externalRestApiBaseUrl: 'https://api.example.test',
        rpcProxyBaseUrl: 'https://rpc.example.test',
      },
    } as Partial<AppController>)

    render(<App />)

    expect(confirmDialogHarness.props?.title).toBe('Add desktop environment?')
    const dialogBody = renderToStaticMarkup(<>{confirmDialogHarness.props?.body}</>)
    expect(dialogBody).toContain(
      'Review this External REST API host. Continue only if you trust it.'
    )
    expect(dialogBody).toContain('<strong>api.example.test</strong>')
    expect(dialogBody).toContain('Profile link label (unverified):')
    expect(dialogBody).toContain(`${linkProvidedName.slice(0, 63)}…`)
    expect(dialogBody).not.toContain(linkProvidedName.slice(64))
    expect(dialogBody).toContain('https://api.example.test')
    expect(dialogBody).not.toContain('https://rpc.example.test')
  })

  it('wires environment switch confirmation actions to the controller', () => {
    const cancelSwitch = vi.fn()
    const confirmSwitch = vi.fn()
    const linkProvidedName = 'Tenant from profile link '.repeat(5)
    currentController = makeController({
      initialExperienceLoading: false,
      pendingDesktopEnvironmentSwitchConfirmation: {
        activeEnvironmentName: 'Current environment',
        activeExternalRestApiBaseUrl: 'https://current-api.example.test/api/v1',
        targetEnvironmentName: linkProvidedName,
        targetExternalRestApiBaseUrl: 'https://target-api.example.test/api/v1',
      },
      handleCancelDesktopEnvironmentSwitchConfirmation: cancelSwitch,
      handleConfirmDesktopEnvironmentSwitchConfirmation: confirmSwitch,
    } as Partial<AppController>)

    render(<App />)

    expect(confirmDialogHarness.props?.title).toBe('Switch desktop environment?')
    expect(confirmDialogHarness.props?.confirmLabel).toBe('Sign out and switch')
    const dialogBody = renderToStaticMarkup(<>{confirmDialogHarness.props?.body}</>)
    expect(dialogBody).toContain('<strong>current-api.example.test</strong>')
    expect(dialogBody).toContain('<strong>target-api.example.test</strong>')
    expect(dialogBody).toContain('Profile link label (unverified):')
    expect(dialogBody).toContain(`${linkProvidedName.slice(0, 63)}…`)
    expect(dialogBody).not.toContain(linkProvidedName.slice(64))
    act(() => confirmDialogHarness.props?.onCancel())
    expect(cancelSwitch).toHaveBeenCalledOnce()
    act(() => confirmDialogHarness.props?.onConfirm())
    expect(confirmSwitch).toHaveBeenCalledOnce()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    testNavigationIntentSequence = 0
    testUserNavigationGeneration = 0
    resetComposerDraftStore()
    clearLatestGfsConversationContext()
    confirmDialogHarness.props = null
    confirmDialogHarness.mountedCount = 0
    appHeaderHarness.props = null
    chatLocalSearchHarness.rendered.mockReset()
    commandPaletteHarness.props = null
    filesPageHarness.pendingGfsUri = null
    filesPageHarness.routeDialogRequestId = 0
    filesPageHarness.pendingResourceAction = null
    filesPageHarness.onLocationChange = null
    filesPageHarness.onPendingResourceActionHandled = null
    filesPageHarness.activeTabId = null
    filesPageHarness.activeFilesRoute = null
    filesPageHarness.mountCount = 0
    filesPageHarness.handledRouteRequestIds = []
    filesPageHarness.resolveOnDeepLink = false
    filesPageHarness.resolveRequests = []
    filesPageHarness.props = null
    previewPageHarness.props = null
    settingsPageHarness.props = null
    sandboxUiPageHarness.props = null
    sidebarHarness.props = null
    acknowledgeDeepLink.mockResolvedValue(undefined)
    acknowledgeGfsDeepLink.mockResolvedValue(undefined)
    resolveGfsResource.mockReset()
    clearPendingGfsDeepLinks.mockResolvedValue(1)
    listApps.mockResolvedValue({ apps: [] })
    listPendingDeepLinks.mockResolvedValue({ links: [] })
    listPendingGfsDeepLinks.mockResolvedValue({ links: [] })
    closeSandboxUi.mockResolvedValue(undefined)
    getSandboxUiLocation.mockResolvedValue(null)
    emitDeepLink = null
    emitGfsDeepLink = null
    emitCommand = null
    currentController = makeController()
    vi.mocked(useAppController).mockImplementation(() => useReactiveController(currentController))

    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        shortcuts: {
          onCommand: vi.fn(
            (callback: (commandId: DesktopCommandId, source: 'host' | 'sandbox') => void) => {
              emitCommand = (commandId, source = 'host') => callback(commandId, source)
              return vi.fn()
            }
          ),
        },
        app: {
          rendererReady: vi.fn().mockResolvedValue(undefined),
        },
        sandboxUi: {
          listApps,
          listPendingDeepLinks,
          clearPendingDeepLinks,
          acknowledgeDeepLink,
          close: closeSandboxUi,
          getLocation: getSandboxUiLocation,
          focusActive: vi.fn().mockResolvedValue(true),
          onDeepLink: vi.fn((callback: (link: SandboxUiDeepLinkEnvelope) => void) => {
            emitDeepLink = callback
            return vi.fn()
          }),
        },
        gfs: {
          acknowledgeDeepLink: acknowledgeGfsDeepLink,
          clearPendingDeepLinks: clearPendingGfsDeepLinks,
          listPendingDeepLinks: listPendingGfsDeepLinks,
          resolve: resolveGfsResource,
          getUserNavigationGeneration: () => testUserNavigationGeneration,
          onDeepLink: vi.fn((callback: (link: GfsResourceDeepLinkEnvelope) => void) => {
            emitGfsDeepLink = callback
            return vi.fn()
          }),
        },
      } as unknown as Window['clerum'],
    })
  })

  it('retains a cold resource link through authentication and bootstrap readiness', async () => {
    const uri = 'gfs://main/0123456789abcdef0123456789abcdef'
    const link = produceGfsResourceDeepLink(uri)
    listPendingGfsDeepLinks.mockResolvedValueOnce({ links: [link] })
    currentController = makeController({
      booting: false,
      initialExperienceLoading: false,
      isAuthenticated: false,
      authenticatedPrincipalIdentity: null,
    } as Partial<AppController>)
    const { rerender } = render(<App />)

    await waitFor(() => expect(listPendingGfsDeepLinks).toHaveBeenCalledOnce())
    expect(currentController.openFilesSection).not.toHaveBeenCalled()
    expect(acknowledgeGfsDeepLink).not.toHaveBeenCalled()

    currentController = makeController({
      booting: false,
      initialExperienceLoading: true,
      isAuthenticated: true,
      authenticatedPrincipalIdentity: 'user-a:user-a@example.com',
    } as Partial<AppController>)
    rerender(<App />)
    expect(currentController.openFilesSection).not.toHaveBeenCalled()
    expect(acknowledgeGfsDeepLink).not.toHaveBeenCalled()

    currentController = makeController({
      booting: false,
      initialExperienceLoading: false,
      isAuthenticated: true,
      authenticatedPrincipalIdentity: 'user-a:user-a@example.com',
    } as Partial<AppController>)
    rerender(<App />)

    await waitFor(() =>
      expect(currentController.activateGfsResourceNavigation).toHaveBeenCalledOnce()
    )
    await waitFor(() => expect(filesPageHarness.pendingGfsUri).toBeNull())
    expect(acknowledgeGfsDeepLink).not.toHaveBeenCalled()
    expect(filesPageHarness.props?.pendingGfsDeepLink).toEqual({ id: link.id, uri: link.uri })
    act(() => filesPageHarness.props?.onPendingGfsDeepLinkOutcome?.(link.id, 'opened'))
    await waitFor(() => expect(acknowledgeGfsDeepLink).toHaveBeenCalledWith(link.id))
  })

  it('forwards the App GFS invalidation epoch to HeaderActions search', async () => {
    type TestGfsInvalidation = {
      type: 'scope.invalidated'
      schemaVersion: 1
      cursor: string
      scopes: Array<'gfs' | 'authorization'>
    }
    let emitEntityChange: ((event: TestGfsInvalidation) => void) | null = null
    const currentClerum = window.clerum
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        ...currentClerum,
        entityChanges: {
          subscribe: vi.fn(async (onEvent: (event: TestGfsInvalidation) => void) => {
            emitEntityChange = onEvent
            return vi.fn(async () => undefined)
          }),
        },
      } as unknown as Window['clerum'],
    })
    currentController = makeController({
      initialExperienceLoading: false,
      selectedAgent: 'agent-a',
      activeChatId: 'chat-session-a',
      workspaceTabs: openChatTab(createWorkspaceTabsState('chat-tab-1'), {
        id: 'chat-session-tab',
        agentRef: 'agent-a',
        chatId: 'chat-session-a',
      }),
    } as Partial<AppController>)

    render(<App />)
    await screen.findByTestId('chat-page-surface')
    expect(appHeaderHarness.props?.gfsAuthorizationChangeEpoch).toBe(0)
    await waitFor(() => expect(emitEntityChange).toBeTypeOf('function'))

    act(() =>
      emitEntityChange?.({
        type: 'scope.invalidated',
        schemaVersion: 1,
        cursor: 'cursor-expansion-test',
        scopes: ['gfs'],
      })
    )

    await waitFor(() => expect(appHeaderHarness.props?.gfsAuthorizationChangeEpoch).toBe(1))

    act(() => currentController.handleNavSelect(DESKTOP_ROUTES.files))
    await waitFor(() => expect(appHeaderHarness.props?.onToggleChatDrawer).toBeTypeOf('function'))
    act(() => appHeaderHarness.props?.onToggleChatDrawer?.())
    await waitFor(() => expect(screen.getByTestId('chat-page-surface')).toBeTruthy())
    expect(appHeaderHarness.props?.gfsAuthorizationChangeEpoch).toBe(1)

    act(() =>
      emitEntityChange?.({
        type: 'scope.invalidated',
        schemaVersion: 1,
        cursor: 'cursor-expansion-drawer-test',
        scopes: ['authorization'],
      })
    )
    await waitFor(() => expect(appHeaderHarness.props?.gfsAuthorizationChangeEpoch).toBe(2))
  })

  it('advances the GFS search epoch across logout and same-principal relogin', async () => {
    currentController = makeController({
      initialExperienceLoading: false,
      selectedAgent: 'agent-a',
      activeChatId: 'chat-session-a',
      workspaceTabs: openChatTab(createWorkspaceTabsState('chat-tab-1'), {
        id: 'initial-chat-tab',
        agentRef: 'agent-a',
        chatId: 'chat-session-a',
      }),
    } as Partial<AppController>)
    render(<App />)

    await screen.findByTestId('chat-page-surface')
    expect(appHeaderHarness.props?.gfsAuthorizationChangeEpoch).toBe(0)

    act(() => {
      currentController.isAuthenticated = false
      currentController.authenticatedPrincipalIdentity = null
      forceControllerRender()
    })
    await waitFor(() => expect(screen.queryByTestId('chat-page-surface')).toBeNull())

    act(() => {
      currentController.isAuthenticated = true
      currentController.authenticatedPrincipalIdentity = 'user-a:user-a@example.com'
      forceControllerRender()
    })

    await screen.findByTestId('chat-page-surface')
    expect(appHeaderHarness.props?.gfsAuthorizationChangeEpoch).toBe(2)
  })

  it('opens the existing route dialog from a sidebar row without selecting that row', async () => {
    const resource = (
      await listChildrenPage([
        childView('0123456789abcdef0123456789abcdef', 'Sidebar folder', 'directory'),
      ])
    ).items[0]
    if (!resource) throw new Error('The producer fixture did not return the sidebar folder')
    const openFilesSection = vi.fn((path: string | null = null) => {
      const intentSequence = currentController.beginUserNavigationIntent()
      const next = openFilesTab(currentController.workspaceTabs, {
        id: 'sidebar-open-route-files',
        path,
      })
      currentController.setWorkspaceTabs(next)
      return next.activeTabId ? { ownerTabId: next.activeTabId, intentSequence } : null
    })
    currentController = makeController({
      initialExperienceLoading: false,
      openFilesSection,
    } as Partial<AppController>)

    render(<App />)

    act(() => sidebarHarness.props?.onGfsResourceAction?.(resource, 'open-route'))

    expect(openFilesSection).toHaveBeenCalledOnce()
    expect(openFilesSection).toHaveBeenCalledWith(null)
    expect(openFilesSection).not.toHaveBeenCalledWith(resource.gfsUri)
    await waitFor(() => expect(filesPageHarness.handledRouteRequestIds).toContain(1))
    expect(filesPageHarness.routeDialogRequestId).toBe(0)
    expect(filesPageHarness.pendingGfsUri).toBeNull()
  })

  it('routes unreadable-row Move through its parent and preserves the exact target', async () => {
    const parentResourceId = '0123456789abcdef0123456789abcdef'
    const resource = (
      await listChildrenPage([
        childView('abcdefabcdefabcdefabcdefabcdefab', 'secret.pdf', 'file', {
          parentResourceId,
          readable: false,
        }),
      ])
    ).items[0]
    if (!resource) throw new Error('The producer fixture did not return the unreadable file')
    const parentUri = `gfs://main/${parentResourceId}`
    const openFilesSection = vi.fn((path: string | null) => {
      const intentSequence = currentController.beginUserNavigationIntent()
      const next = openFilesTab(currentController.workspaceTabs, {
        id: 'sidebar-unreadable-move-files',
        path,
      })
      currentController.setWorkspaceTabs(next)
      return next.activeTabId ? { ownerTabId: next.activeTabId, intentSequence } : null
    })
    currentController = makeController({
      initialExperienceLoading: false,
      openFilesSection,
    } as Partial<AppController>)

    render(<App />)

    act(() => sidebarHarness.props?.onGfsResourceAction?.(resource, 'move'))

    await waitFor(() => expect(openFilesSection).toHaveBeenCalledWith(parentUri))
    await waitFor(() =>
      expect(filesPageHarness.pendingResourceAction).toMatchObject({
        id: 1,
        targetUri: resource.gfsUri,
        actionId: 'move',
        navigationUri: parentUri,
        targetResource: {
          resourceId: resource.resourceId,
          name: resource.name,
          kind: resource.kind,
          version: resource.version,
          parentResourceId,
        },
      })
    )
    expect(filesPageHarness.pendingGfsUri).toBe(parentUri)
  })

  it('cancels a pending sidebar action when live navigation supersedes its route', async () => {
    const sourceUri = 'gfs://main/11111111111111111111111111111111'
    const target = (
      await listChildrenPage([
        childView('22222222222222222222222222222222', 'replacement.txt', 'file'),
      ])
    ).items[0]
    if (!target) throw new Error('The producer fixture did not return the sidebar file')
    currentController = makeController({
      initialExperienceLoading: false,
      workspaceTabs: openFilesTab(createWorkspaceTabsState('chat-tab-1'), {
        id: 'source-files',
        path: sourceUri,
      }),
    } as Partial<AppController>)

    render(<App />)
    await waitFor(() => expect(filesPageHarness.onLocationChange).not.toBeNull())

    act(() =>
      sidebarHarness.props?.onGfsResourceAction?.(
        target,
        'replace',
        new File(['replacement'], 'replacement.txt')
      )
    )
    const requestId = filesPageHarness.pendingResourceAction?.id
    expect(filesPageHarness.pendingResourceAction).toMatchObject({
      targetUri: target.gfsUri,
      actionId: 'replace',
    })
    expect(filesPageHarness.pendingGfsUri).toBe(target.gfsUri)

    act(() => filesPageHarness.props?.onExplicitNavigationIntent?.())
    act(() =>
      filesPageHarness.onLocationChange?.('gfs://main/33333333333333333333333333333333', 'Other')
    )
    await waitFor(() => expect(filesPageHarness.pendingResourceAction).toBeNull())

    act(() => filesPageHarness.onLocationChange?.(target.gfsUri, target.name))
    expect(filesPageHarness.pendingResourceAction).toBeNull()
    expect(filesPageHarness.onPendingResourceActionHandled).toBeTypeOf('function')
    expect(requestId).toBe(1)
  })

  it('cancels after the target route is left and ignores an older action acknowledgement', async () => {
    const sourceUri = 'gfs://main/11111111111111111111111111111111'
    const rows = await listChildrenPage([
      childView('22222222222222222222222222222222', 'first.txt', 'file'),
      childView('44444444444444444444444444444444', 'second.txt', 'file'),
    ])
    const [first, second] = rows.items
    if (!first || !second) throw new Error('The producer fixture did not return both sidebar files')
    currentController = makeController({
      initialExperienceLoading: false,
      workspaceTabs: openFilesTab(createWorkspaceTabsState('chat-tab-1'), {
        id: 'source-files',
        path: sourceUri,
      }),
    } as Partial<AppController>)

    render(<App />)
    await waitFor(() => expect(filesPageHarness.onLocationChange).not.toBeNull())

    act(() =>
      sidebarHarness.props?.onGfsResourceAction?.(first, 'replace', new File(['1'], '1.txt'))
    )
    const firstRequestId = filesPageHarness.pendingResourceAction?.id
    expect(firstRequestId).toBeDefined()

    act(() => filesPageHarness.onLocationChange?.(first.gfsUri, first.name))
    act(() => filesPageHarness.props?.onExplicitNavigationIntent?.())
    act(() => filesPageHarness.onLocationChange?.(sourceUri, 'Source'))
    await waitFor(() => expect(filesPageHarness.pendingResourceAction).toBeNull())

    act(() => sidebarHarness.props?.onGfsResourceAction?.(second, 'rename'))
    const secondRequestId = filesPageHarness.pendingResourceAction?.id
    expect(secondRequestId).toBeGreaterThan(firstRequestId ?? 0)

    act(() => filesPageHarness.onPendingResourceActionHandled?.(firstRequestId ?? -1))
    expect(filesPageHarness.pendingResourceAction?.id).toBe(secondRequestId)
  })

  it('routes a warm resource link to the active Files destination and acknowledges it', async () => {
    currentController = makeController({
      booting: false,
      initialExperienceLoading: false,
      isAuthenticated: true,
      authenticatedPrincipalIdentity: 'user-a:user-a@example.com',
    } as Partial<AppController>)
    render(<App />)
    const link = produceGfsResourceDeepLink('gfs://main/abcdefabcdefabcdefabcdefabcdefab')
    await waitFor(() => expect(emitGfsDeepLink).not.toBeNull())

    act(() => {
      emitGfsDeepLink?.(link)
    })

    await waitFor(() =>
      expect(currentController.activateGfsResourceNavigation).toHaveBeenCalledOnce()
    )
    await waitFor(() => expect(filesPageHarness.pendingGfsUri).toBeNull())
    expect(acknowledgeGfsDeepLink).not.toHaveBeenCalled()
    expect(filesPageHarness.props?.pendingGfsDeepLink).toEqual({ id: link.id, uri: link.uri })
    act(() => filesPageHarness.props?.onPendingGfsDeepLinkOutcome?.(link.id, 'opened'))
    await waitFor(() => expect(acknowledgeGfsDeepLink).toHaveBeenCalledWith(link.id))
  })

  it('routes in-app resource links through the authenticated navigation owner', async () => {
    const uri = 'gfs://main/acacacacacacacacacacacacacacacac'
    currentController = makeController({
      initialExperienceLoading: false,
      isAuthenticated: true,
      authenticatedPrincipalIdentity: 'user-a:user-a@example.com',
    } as Partial<AppController>)
    const activateGfsResourceNavigation = vi.spyOn(
      currentController,
      'activateGfsResourceNavigation'
    )
    render(<App />)

    await waitFor(() => expect(listPendingGfsDeepLinks).toHaveBeenCalled())
    await waitFor(() => expect(appHeaderHarness.props?.onOpenGfsResource).toBeTypeOf('function'))
    act(() => appHeaderHarness.props?.onOpenGfsResource?.(uri))

    await waitFor(() => expect(activateGfsResourceNavigation).toHaveBeenCalledOnce())
    const request = activateGfsResourceNavigation.mock.calls[0]?.[0]
    expect(request?.uri).toBe(uri)
    expect(currentController.beginUserNavigationIntent).toHaveBeenCalled()
    expect(filesPageHarness.props?.pendingGfsDeepLink).toMatchObject({ uri })
    expect(filesPageHarness.props?.pendingGfsDeepLink?.id).toBeGreaterThan(0)
    expect(acknowledgeGfsDeepLink).not.toHaveBeenCalled()

    const requestId = filesPageHarness.props?.pendingGfsDeepLink?.id
    expect(requestId).toBeDefined()
    act(() => filesPageHarness.props?.onPendingGfsDeepLinkOutcome?.(requestId!, 'opened'))
    await waitFor(() => expect(filesPageHarness.props?.pendingGfsDeepLink).toBeNull())
    expect(acknowledgeGfsDeepLink).not.toHaveBeenCalled()
  })

  it('does not let a link activated before a Chat selection take over an inactive Files root', async () => {
    const uri = 'gfs://main/abababababababababababababababab'
    const queue = new GfsResourceDeepLinkQueue()
    const link = produceGfsResourceDeepLink(uri, queue)
    acknowledgeGfsDeepLink.mockImplementation(async id => {
      queue.acknowledge(id)
    })
    let workspaceTabs = openFilesTab(createWorkspaceTabsState('chat-tab-1'), {
      id: 'files-root',
      path: null,
      title: 'Files root',
    })
    workspaceTabs = selectWorkspaceTab(workspaceTabs, 'chat-tab-1')
    currentController = makeController({
      initialExperienceLoading: false,
      workspaceTabs,
    })
    render(<App />)
    await waitFor(() => expect(emitGfsDeepLink).not.toBeNull())

    const chatButton = screen.getByRole('button', { name: 'New chat' })
    chatButton.focus()
    expect(link.userNavigationGenerationAtActivation).toBe(0)
    fireEvent.click(chatButton)
    expect(chatButton.getAttribute('aria-pressed')).toBe('true')

    // The queue captured generation 0 at activation. The explicit Chat click
    // happens before the renderer receives this delayed event.
    act(() => emitGfsDeepLink?.(link))

    const activeTabButton = screen
      .getByRole('toolbar', { name: 'Workspace tabs' })
      .querySelector('button[aria-pressed="true"]')
    expect(activeTabButton?.getAttribute('aria-label')).toBe('New chat')
    expect(currentController.workspaceTabs.activeTabId).toBe('chat-tab-1')
    expect(
      currentController.workspaceTabs.tabs.find(tab => tab.id === 'files-root')?.files?.path
    ).toBeNull()
    expect(screen.queryByTestId('files-page-surface')).toBeNull()
    expect(filesPageHarness.resolveRequests).toEqual([])
    expect(document.activeElement).toBe(chatButton)
    await waitFor(() => expect(acknowledgeGfsDeepLink).toHaveBeenCalledWith(link.id))
    expect(acknowledgeGfsDeepLink).toHaveBeenCalledTimes(1)
    expect(queue.list()).toEqual([])
    expect(currentController.pushToast).not.toHaveBeenCalled()

    act(() => emitGfsDeepLink?.(link))
    expect(filesPageHarness.resolveRequests).toEqual([])
    expect(acknowledgeGfsDeepLink).toHaveBeenCalledTimes(1)
    expect(currentController.workspaceTabs.activeTabId).toBe('chat-tab-1')
  })

  it('keeps newer explicit link navigation and reserves a separate Files destination', async () => {
    const uri = 'gfs://main/acacacacacacacacacacacacacacacac'
    let workspaceTabs = openFilesTab(createWorkspaceTabsState('chat-tab-1'), {
      id: 'files-root',
      path: null,
      title: 'Files root',
    })
    workspaceTabs = selectWorkspaceTab(workspaceTabs, 'chat-tab-1')
    currentController = makeController({
      initialExperienceLoading: false,
      workspaceTabs,
    })
    render(<App />)
    await waitFor(() => expect(emitGfsDeepLink).not.toBeNull())

    const chatButton = screen.getByRole('button', { name: 'New chat' })
    chatButton.focus()
    fireEvent.click(chatButton)
    expect(currentController.workspaceTabs.activeTabId).toBe('chat-tab-1')
    expect(testUserNavigationGeneration).toBeGreaterThan(0)
    const link = produceGfsResourceDeepLink(uri)
    expect(link.userNavigationGenerationAtActivation).toBe(testUserNavigationGeneration)
    act(() => emitGfsDeepLink?.(link))

    await waitFor(() =>
      expect(currentController.activateGfsResourceNavigation).toHaveBeenCalledOnce()
    )
    const destinationTab = currentController.workspaceTabs.tabs.find(
      tab => tab.kind === 'files' && tab.id !== 'files-root'
    )
    expect(destinationTab?.id).toBeTruthy()
    const activeTabButton = screen
      .getByRole('toolbar', { name: 'Workspace tabs' })
      .querySelector('button[aria-pressed="true"]')
    expect(activeTabButton?.getAttribute('aria-label')).toBe('Files')
    expect(currentController.workspaceTabs.tabs).toHaveLength(3)
    expect(currentController.workspaceTabs.activeTabId).not.toBe('files-root')
    expect(
      currentController.workspaceTabs.tabs.find(tab => tab.id === 'files-root')?.files?.path
    ).toBeNull()
    expect(screen.getByTestId('files-page-surface').getAttribute('data-tab-id')).toBe(
      currentController.workspaceTabs.activeTabId
    )
    expect(filesPageHarness.props?.pendingGfsDeepLink).toEqual({ id: link.id, uri })
    expect(filesPageHarness.resolveRequests).toEqual([])
    expect(acknowledgeGfsDeepLink).not.toHaveBeenCalled()
  })

  it('creates a destination for an accepted link when no Files tab exists', async () => {
    const uri = 'gfs://main/adadadadadadadadadadadadadadadad'
    const queue = new GfsResourceDeepLinkQueue()
    const link = produceGfsResourceDeepLink(uri, queue)
    const producerResource = await resolveResource(
      resolvedFile('adadadadadadadadadadadadadadadad', 'linked-note.md')
    )
    resolveGfsResource.mockResolvedValue(producerResource)
    acknowledgeGfsDeepLink.mockImplementation(async id => {
      queue.acknowledge(id)
    })
    filesPageHarness.resolveOnDeepLink = true
    currentController = makeController({ initialExperienceLoading: false })
    render(<App />)
    await waitFor(() => expect(emitGfsDeepLink).not.toBeNull())

    act(() => emitGfsDeepLink?.(link))
    await waitFor(() =>
      expect(currentController.activateGfsResourceNavigation).toHaveBeenCalledOnce()
    )

    const ownerId = currentController.workspaceTabs.activeTabId
    expect(ownerId).toBeTruthy()
    expect(currentController.workspaceTabs.tabs.filter(tab => tab.kind === 'files')).toHaveLength(1)
    expect(currentController.workspaceTabs.activeTabId).toBe(ownerId)
    expect(screen.getByTestId('files-page-surface').getAttribute('data-tab-id')).toBe(ownerId)
    await waitFor(() => expect(filesPageHarness.resolveRequests).toHaveLength(1))
    await waitFor(() =>
      expect(
        screen.getByTestId('files-page-surface').getAttribute('data-resolved-resource-uri')
      ).toBe(uri)
    )
    expect(filesPageHarness.props?.pendingGfsDeepLink).toBeNull()
    await waitFor(() => expect(acknowledgeGfsDeepLink).toHaveBeenCalledWith(link.id))
    expect(currentController.workspaceTabs.tabs.find(tab => tab.id === ownerId)?.files?.path).toBe(
      uri
    )
    expect(queue.list()).toEqual([])
    expect(acknowledgeGfsDeepLink).toHaveBeenCalledTimes(1)
  })

  it('does not replay a canceled destination when the user selects its tab later', async () => {
    const uri = 'gfs://main/aeaeaeaeaeaeaeaeaeaeaeaeaeaeaeae'
    const link = produceGfsResourceDeepLink(uri)
    const producerResource = await resolveResource(
      resolvedFile('aeaeaeaeaeaeaeaeaeaeaeaeaeaeaeae', 'stale.md')
    )
    let resolveLink!: (resource: unknown) => void
    resolveGfsResource.mockImplementation(
      () =>
        new Promise(resolve => {
          resolveLink = resolve
        })
    )
    filesPageHarness.resolveOnDeepLink = true
    currentController = makeController({ initialExperienceLoading: false })
    render(<App />)
    await waitFor(() => expect(emitGfsDeepLink).not.toBeNull())

    act(() => emitGfsDeepLink?.(link))
    await waitFor(() => expect(filesPageHarness.resolveRequests).toHaveLength(1))
    const ownerId = currentController.workspaceTabs.activeTabId
    expect(currentController.workspaceTabs.activeTabId).toBe(ownerId)

    fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
    await waitFor(() => expect(acknowledgeGfsDeepLink).toHaveBeenCalledWith(link.id))
    await act(async () => {
      resolveLink(producerResource)
      await Promise.resolve()
    })
    expect(currentController.workspaceTabs.activeTabId).toBe('chat-tab-1')
    expect(currentController.workspaceTabs.tabs.find(tab => tab.id === ownerId)?.files?.path).toBe(
      null
    )
    expect(acknowledgeGfsDeepLink).toHaveBeenCalledTimes(1)
    expect(currentController.pushToast).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Files' }))
    expect(currentController.workspaceTabs.activeTabId).toBe(ownerId)
    expect(filesPageHarness.props?.pendingGfsDeepLink).toBeNull()
    expect(filesPageHarness.resolveRequests).toHaveLength(1)
    expect(acknowledgeGfsDeepLink).toHaveBeenCalledTimes(1)
  })

  it('releases a retryable link when a newer valid link arrives', async () => {
    const uriA = 'gfs://main/afafafafafafafafafafafafafafafaf'
    const uriB = 'gfs://main/bfbfbfbfbfbfbfbfbfbfbfbfbfbfbfbf'
    const queue = new GfsResourceDeepLinkQueue()
    const linkA = produceGfsResourceDeepLink(uriA, queue)
    const producerResource = await resolveResource(
      resolvedFile('bfbfbfbfbfbfbfbfbfbfbfbfbfbfbfbf', 'newer.md')
    )
    const workspaceTabs = openFilesTab(createWorkspaceTabsState('chat-tab-1'), {
      id: 'files-owner',
      path: uriA,
      title: 'Files owner',
    })
    let resolveB!: (resource: unknown) => void
    resolveGfsResource.mockImplementation(
      () =>
        new Promise(resolve => {
          resolveB = resolve
        })
    )
    filesPageHarness.resolveOnDeepLink = true
    currentController = makeController({ initialExperienceLoading: false, workspaceTabs })
    render(<App />)
    await waitFor(() => expect(emitGfsDeepLink).not.toBeNull())

    act(() => emitGfsDeepLink?.(linkA))
    await waitFor(() => expect(filesPageHarness.resolveRequests).toHaveLength(1))
    act(() => filesPageHarness.props?.onPendingGfsDeepLinkOutcome?.(linkA.id, 'retryable'))
    expect(acknowledgeGfsDeepLink).not.toHaveBeenCalled()

    const linkB = produceGfsResourceDeepLink(uriB, queue)
    act(() => emitGfsDeepLink?.(linkB))
    await waitFor(() => expect(filesPageHarness.resolveRequests).toHaveLength(2))
    await waitFor(() => expect(acknowledgeGfsDeepLink).toHaveBeenCalledWith(linkA.id))
    expect(filesPageHarness.resolveRequests[1]).toEqual({
      id: linkB.id,
      tabId: 'files-owner',
      uri: uriB,
    })
    expect(filesPageHarness.props?.pendingGfsDeepLink).toEqual({ id: linkB.id, uri: uriB })
    expect(acknowledgeGfsDeepLink).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveB(producerResource)
      await Promise.resolve()
      await Promise.resolve()
    })
    await waitFor(() => expect(acknowledgeGfsDeepLink).toHaveBeenCalledWith(linkB.id))
    expect(acknowledgeGfsDeepLink).toHaveBeenCalledTimes(2)
    expect(
      currentController.workspaceTabs.tabs.find(tab => tab.id === 'files-owner')?.files?.path
    ).toBe(uriB)
    expect(currentController.pushToast).not.toHaveBeenCalled()
  })

  it('keeps Files B selected and unchanged when a link owned by Files A resolves late', async () => {
    const uriA = 'gfs://main/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const uriB = 'gfs://main/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    const linkA = produceGfsResourceDeepLink(uriA)
    const producerResource = await resolveResource(
      resolvedFile('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'linked-note.md')
    )
    let resolveA!: (resource: unknown) => void
    const deferredA = new Promise<unknown>(resolve => {
      resolveA = resolve
    })
    resolveGfsResource.mockImplementation(() => deferredA)
    filesPageHarness.resolveOnDeepLink = true

    let workspaceTabs = openFilesTab(createWorkspaceTabsState('chat-tab-1'), {
      id: 'files-a',
      path: uriA,
      title: 'Files A',
    })
    workspaceTabs = openFilesTab(workspaceTabs, {
      id: 'files-b',
      path: uriB,
      title: 'Files B',
    })
    workspaceTabs = { ...workspaceTabs, activeTabId: 'files-a' }
    currentController = makeController({
      initialExperienceLoading: false,
      workspaceTabs,
    })
    render(<App />)
    await waitFor(() => expect(emitGfsDeepLink).not.toBeNull())

    act(() => emitGfsDeepLink?.(linkA))
    await waitFor(() => expect(filesPageHarness.resolveRequests).toHaveLength(1))
    expect(filesPageHarness.resolveRequests[0]).toEqual({
      id: linkA.id,
      tabId: 'files-a',
      uri: uriA,
    })
    expect(screen.getByRole('button', { name: 'Files A' }).getAttribute('aria-pressed')).toBe(
      'true'
    )

    const filesBTabButton = screen.getByRole('button', { name: 'Files B' })
    filesBTabButton.focus()
    fireEvent.click(filesBTabButton)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Files B' }).getAttribute('aria-pressed')).toBe(
        'true'
      )
    )
    expect(screen.getByTestId('files-page-surface').getAttribute('data-saved-route')).toBe(uriB)

    await act(async () => {
      resolveA(producerResource)
      await Promise.resolve()
      await Promise.resolve()
    })

    const activeTabButton = screen
      .getByRole('toolbar', { name: 'Workspace tabs' })
      .querySelector('button[aria-pressed="true"]')
    expect(activeTabButton?.getAttribute('aria-label')).toBe('Files B')
    expect(
      currentController.workspaceTabs.tabs.find(tab => tab.id === 'files-b')?.files?.path
    ).toBe(uriB)
    expect(screen.queryByTestId('files-page-surface')?.getAttribute('data-tab-id')).toBe('files-b')
    expect(screen.queryByTestId('files-page-surface')?.getAttribute('data-saved-route')).toBe(uriB)
    expect(
      screen.queryByTestId('files-page-surface')?.getAttribute('data-pending-resource-uri')
    ).toBe('')
    expect(document.activeElement).toBe(filesBTabButton)
    expect(filesPageHarness.resolveRequests).toEqual([
      { id: linkA.id, tabId: 'files-a', uri: uriA },
    ])
    expect(acknowledgeGfsDeepLink).toHaveBeenCalledTimes(1)
    expect(acknowledgeGfsDeepLink).toHaveBeenCalledWith(linkA.id)
    expect(currentController.pushToast).not.toHaveBeenCalled()
    expect(currentController.activateGfsResourceNavigation).toHaveBeenCalledTimes(1)
  })

  it('settles a pending link when its owner explicitly navigates within Files', async () => {
    const ownerUri = 'gfs://main/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const link = produceGfsResourceDeepLink('gfs://main/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
    const producerResource = await resolveResource(
      resolvedFile('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'linked-note.md')
    )
    let resolveLink!: (resource: unknown) => void
    resolveGfsResource.mockImplementation(
      () =>
        new Promise(resolve => {
          resolveLink = resolve
        })
    )
    filesPageHarness.resolveOnDeepLink = true
    const workspaceTabs = openFilesTab(createWorkspaceTabsState('chat-tab-1'), {
      id: 'files-owner',
      path: ownerUri,
      title: 'Files owner',
    })
    currentController = makeController({ initialExperienceLoading: false, workspaceTabs })
    render(<App />)
    await waitFor(() => expect(emitGfsDeepLink).not.toBeNull())

    act(() => emitGfsDeepLink?.(link))
    await waitFor(() => expect(filesPageHarness.resolveRequests).toHaveLength(1))
    expect(filesPageHarness.props?.pendingGfsDeepLink).toEqual({ id: link.id, uri: link.uri })
    expect(filesPageHarness.pendingGfsUri).toBe(ownerUri)

    act(() => filesPageHarness.props?.onExplicitNavigationIntent?.())
    await waitFor(() => expect(acknowledgeGfsDeepLink).toHaveBeenCalledOnce())
    await waitFor(() => expect(filesPageHarness.props?.pendingGfsDeepLink).toBeNull())
    expect(filesPageHarness.pendingGfsUri).toBe(ownerUri)
    expect(currentController.navigationIntentSequence).toBeGreaterThan(1)
    act(() => filesPageHarness.props?.onLocationChange?.(null, 'Files'))

    await act(async () => {
      resolveLink(producerResource)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(currentController.workspaceTabs.activeTabId).toBe('files-owner')
    expect(
      currentController.workspaceTabs.tabs.find(tab => tab.id === 'files-owner')?.files?.path
    ).toBeNull()
    expect(filesPageHarness.resolveRequests).toHaveLength(1)
    expect(acknowledgeGfsDeepLink).toHaveBeenCalledOnce()
    expect(acknowledgeGfsDeepLink).toHaveBeenCalledWith(link.id)
    expect(currentController.pushToast).not.toHaveBeenCalled()
  })

  it.each([403, 404, 410, 503])(
    'does not surface a late HTTP %i result on Files B after the user selects it',
    async status => {
      const uriA = 'gfs://main/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      const uriB = 'gfs://main/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
      const linkA = produceGfsResourceDeepLink(uriA)
      const errorMessage = await resolveDeniedMessage(
        uriA,
        { code: 'resource_unavailable', message: 'resource is unavailable' },
        status
      )
      expect(errorMessage).toContain(`httpStatus=${status}`)
      let rejectA!: (error: Error) => void
      resolveGfsResource.mockImplementation(
        () =>
          new Promise((_, reject) => {
            rejectA = reject
          })
      )
      filesPageHarness.resolveOnDeepLink = true

      let workspaceTabs = openFilesTab(createWorkspaceTabsState('chat-tab-1'), {
        id: 'files-a',
        path: uriA,
        title: 'Files A',
      })
      workspaceTabs = openFilesTab(workspaceTabs, {
        id: 'files-b',
        path: uriB,
        title: 'Files B',
      })
      workspaceTabs = { ...workspaceTabs, activeTabId: 'files-a' }
      currentController = makeController({ initialExperienceLoading: false, workspaceTabs })
      render(<App />)
      await waitFor(() => expect(emitGfsDeepLink).not.toBeNull())

      act(() => emitGfsDeepLink?.(linkA))
      await waitFor(() => expect(filesPageHarness.resolveRequests).toHaveLength(1))
      fireEvent.click(screen.getByRole('button', { name: 'Files B' }))
      await waitFor(() => expect(acknowledgeGfsDeepLink).toHaveBeenCalledTimes(1))

      await act(async () => {
        rejectA(new Error(errorMessage))
        await Promise.resolve()
      })

      expect(
        screen
          .getByRole('toolbar', { name: 'Workspace tabs' })
          .querySelector('button[aria-pressed="true"]')
          ?.getAttribute('aria-label')
      ).toBe('Files B')
      expect(
        currentController.workspaceTabs.tabs.find(tab => tab.id === 'files-b')?.files?.path
      ).toBe(uriB)
      expect(
        screen.queryByTestId('files-page-surface')?.getAttribute('data-pending-resource-uri')
      ).toBe('')
      expect(acknowledgeGfsDeepLink).toHaveBeenCalledTimes(1)
      expect(acknowledgeGfsDeepLink).toHaveBeenCalledWith(linkA.id)
      expect(currentController.pushToast).not.toHaveBeenCalled()
    }
  )

  it.each([
    {
      sequence: ['Files B', 'Files C'],
      expectedLabel: 'Files C',
      expectedTabId: 'files-c',
    },
    { sequence: ['New chat'], expectedLabel: 'New chat', expectedTabId: 'chat-tab-1' },
    {
      sequence: ['Files B', 'Files A'],
      expectedLabel: 'Files A',
      expectedTabId: 'files-a',
    },
  ])(
    'preserves the final explicit selection for $sequence after the canceled link resolves',
    async ({ sequence, expectedLabel, expectedTabId }) => {
      const uriA = 'gfs://main/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      const uriB = 'gfs://main/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
      const uriC = 'gfs://main/cccccccccccccccccccccccccccccccc'
      const linkA = produceGfsResourceDeepLink(uriA)
      const producerResource = await resolveResource(
        resolvedFile('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'linked-note.md')
      )
      let resolveA!: (resource: unknown) => void
      resolveGfsResource.mockImplementation(
        () =>
          new Promise(resolve => {
            resolveA = resolve
          })
      )
      filesPageHarness.resolveOnDeepLink = true

      let workspaceTabs = createWorkspaceTabsState('chat-tab-1')
      workspaceTabs = openFilesTab(workspaceTabs, { id: 'files-a', path: uriA, title: 'Files A' })
      workspaceTabs = openFilesTab(workspaceTabs, { id: 'files-b', path: uriB, title: 'Files B' })
      workspaceTabs = openFilesTab(workspaceTabs, { id: 'files-c', path: uriC, title: 'Files C' })
      workspaceTabs = { ...workspaceTabs, activeTabId: 'files-a' }
      currentController = makeController({ initialExperienceLoading: false, workspaceTabs })
      render(<App />)
      await waitFor(() => expect(emitGfsDeepLink).not.toBeNull())
      act(() => emitGfsDeepLink?.(linkA))
      await waitFor(() => expect(filesPageHarness.resolveRequests).toHaveLength(1))

      let finalButton: HTMLElement | null = null
      for (const label of sequence) {
        const button = screen.getByRole('button', { name: label })
        button.focus()
        fireEvent.click(button)
        finalButton = button
      }
      await waitFor(() => expect(acknowledgeGfsDeepLink).toHaveBeenCalledTimes(1))
      expect(
        screen
          .getByRole('toolbar', { name: 'Workspace tabs' })
          .querySelector('button[aria-pressed="true"]')
          ?.getAttribute('aria-label')
      ).toBe(expectedLabel)

      await act(async () => {
        resolveA(producerResource)
        await Promise.resolve()
        await Promise.resolve()
      })

      expect(
        screen
          .getByRole('toolbar', { name: 'Workspace tabs' })
          .querySelector('button[aria-pressed="true"]')
          ?.getAttribute('aria-label')
      ).toBe(expectedLabel)
      expect(currentController.workspaceTabs.activeTabId).toBe(expectedTabId)
      expect(document.activeElement).toBe(finalButton)
      expect(filesPageHarness.resolveRequests).toHaveLength(1)
      expect(acknowledgeGfsDeepLink).toHaveBeenCalledTimes(1)
      expect(acknowledgeGfsDeepLink).toHaveBeenCalledWith(linkA.id)
      expect(currentController.pushToast).not.toHaveBeenCalled()
      expect(
        currentController.workspaceTabs.tabs.find(tab => tab.id === 'files-b')?.files?.path
      ).toBe(uriB)
    }
  )

  it('cancels the owner request when Files A closes before its resolver settles', async () => {
    const uriA = 'gfs://main/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const uriB = 'gfs://main/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    const linkA = produceGfsResourceDeepLink(uriA)
    const producerResource = await resolveResource(
      resolvedFile('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'linked-note.md')
    )
    let resolveA!: (resource: unknown) => void
    resolveGfsResource.mockImplementation(
      () =>
        new Promise(resolve => {
          resolveA = resolve
        })
    )
    filesPageHarness.resolveOnDeepLink = true
    let workspaceTabs = createWorkspaceTabsState('chat-tab-1')
    workspaceTabs = openFilesTab(workspaceTabs, { id: 'files-a', path: uriA, title: 'Files A' })
    workspaceTabs = openFilesTab(workspaceTabs, { id: 'files-b', path: uriB, title: 'Files B' })
    workspaceTabs = { ...workspaceTabs, activeTabId: 'files-a' }
    currentController = makeController({ initialExperienceLoading: false, workspaceTabs })
    render(<App />)
    await waitFor(() => expect(emitGfsDeepLink).not.toBeNull())
    act(() => emitGfsDeepLink?.(linkA))
    await waitFor(() => expect(filesPageHarness.resolveRequests).toHaveLength(1))

    fireEvent.click(screen.getByRole('button', { name: 'Close Files A' }))
    const activeAfterClose = screen
      .getByRole('toolbar', { name: 'Workspace tabs' })
      .querySelector('button[aria-pressed="true"]')
    const activeLabelAfterClose = activeAfterClose?.getAttribute('aria-label')
    await waitFor(() => expect(acknowledgeGfsDeepLink).toHaveBeenCalledTimes(1))
    await act(async () => {
      resolveA(producerResource)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.queryByRole('button', { name: 'Files A' })).toBeNull()
    expect(
      screen
        .getByRole('toolbar', { name: 'Workspace tabs' })
        .querySelector('button[aria-pressed="true"]')
        ?.getAttribute('aria-label')
    ).toBe(activeLabelAfterClose)
    expect(filesPageHarness.resolveRequests).toHaveLength(1)
    expect(currentController.workspaceTabs.tabs.some(tab => tab.id === 'files-a')).toBe(false)
    expect(acknowledgeGfsDeepLink).toHaveBeenCalledWith(linkA.id)
    expect(currentController.pushToast).not.toHaveBeenCalled()
  })

  it('settles newer resource links without letting an older out-of-order result take over', async () => {
    const uriA = 'gfs://main/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const uriB = 'gfs://main/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    const queue = new GfsResourceDeepLinkQueue()
    const linkA = produceGfsResourceDeepLink(uriA, queue)
    const linkB = produceGfsResourceDeepLink(uriB, queue)
    const resourceA = await resolveResource(
      resolvedFile('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'older.md')
    )
    const resourceB = await resolveResource(
      resolvedFile('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'newer.md')
    )
    const deferred = new Map<string, (resource: unknown) => void>()
    resolveGfsResource.mockImplementation(
      (uri: string) =>
        new Promise(resolve => {
          deferred.set(uri, resolve)
        })
    )
    filesPageHarness.resolveOnDeepLink = true
    let workspaceTabs = createWorkspaceTabsState('chat-tab-1')
    workspaceTabs = openFilesTab(workspaceTabs, { id: 'files-a', path: uriA, title: 'Files A' })
    workspaceTabs = openFilesTab(workspaceTabs, { id: 'files-b', path: uriB, title: 'Files B' })
    workspaceTabs = { ...workspaceTabs, activeTabId: 'files-a' }
    currentController = makeController({ initialExperienceLoading: false, workspaceTabs })
    render(<App />)
    await waitFor(() => expect(emitGfsDeepLink).not.toBeNull())

    act(() => emitGfsDeepLink?.(linkA))
    await waitFor(() => expect(filesPageHarness.resolveRequests).toHaveLength(1))
    act(() => emitGfsDeepLink?.(linkB))
    await waitFor(() => expect(filesPageHarness.resolveRequests).toHaveLength(2))
    await waitFor(() => expect(acknowledgeGfsDeepLink).toHaveBeenCalledWith(linkA.id))

    await act(async () => {
      deferred.get(uriB)?.(resourceB)
      await Promise.resolve()
      await Promise.resolve()
    })
    await waitFor(() => expect(acknowledgeGfsDeepLink).toHaveBeenCalledWith(linkB.id))
    const savedPathAfterB = currentController.workspaceTabs.tabs.find(tab => tab.id === 'files-a')
      ?.files?.path
    expect(savedPathAfterB).toBe(uriB)

    await act(async () => {
      deferred.get(uriA)?.(resourceA)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(currentController.workspaceTabs.activeTabId).toBe('files-a')
    expect(
      currentController.workspaceTabs.tabs.find(tab => tab.id === 'files-a')?.files?.path
    ).toBe(uriB)
    expect(filesPageHarness.resolveRequests).toHaveLength(2)
    expect(acknowledgeGfsDeepLink).toHaveBeenCalledTimes(2)
    expect(acknowledgeGfsDeepLink).toHaveBeenCalledWith(linkA.id)
    expect(acknowledgeGfsDeepLink).toHaveBeenCalledWith(linkB.id)
    expect(currentController.pushToast).not.toHaveBeenCalled()
  })

  it('keeps Files C selected after both canceled Files A and Files B links resolve', async () => {
    const uriA = 'gfs://main/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const uriB = 'gfs://main/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    const uriC = 'gfs://main/cccccccccccccccccccccccccccccccc'
    const queue = new GfsResourceDeepLinkQueue()
    const linkA = produceGfsResourceDeepLink(uriA, queue)
    let linkB: GfsResourceDeepLinkEnvelope
    const resourceA = await resolveResource(
      resolvedFile('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'older-a.md')
    )
    const resourceB = await resolveResource(
      resolvedFile('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'older-b.md')
    )
    const deferred = new Map<string, (resource: unknown) => void>()
    resolveGfsResource.mockImplementation(
      (uri: string) =>
        new Promise(resolve => {
          deferred.set(uri, resolve)
        })
    )
    filesPageHarness.resolveOnDeepLink = true

    let workspaceTabs = createWorkspaceTabsState('chat-tab-1')
    workspaceTabs = openFilesTab(workspaceTabs, { id: 'files-a', path: uriA, title: 'Files A' })
    workspaceTabs = openFilesTab(workspaceTabs, { id: 'files-b', path: uriB, title: 'Files B' })
    workspaceTabs = openFilesTab(workspaceTabs, { id: 'files-c', path: uriC, title: 'Files C' })
    workspaceTabs = { ...workspaceTabs, activeTabId: 'files-a' }
    currentController = makeController({ initialExperienceLoading: false, workspaceTabs })
    render(<App />)
    await waitFor(() => expect(emitGfsDeepLink).not.toBeNull())

    act(() => emitGfsDeepLink?.(linkA))
    await waitFor(() => expect(filesPageHarness.resolveRequests).toHaveLength(1))
    fireEvent.click(screen.getByRole('button', { name: 'Files B' }))
    await waitFor(() => expect(acknowledgeGfsDeepLink).toHaveBeenCalledWith(linkA.id))

    linkB = produceGfsResourceDeepLink(uriB, queue)
    act(() => emitGfsDeepLink?.(linkB))
    await waitFor(() => expect(filesPageHarness.resolveRequests).toHaveLength(2))
    expect(filesPageHarness.resolveRequests[1]).toEqual({
      id: linkB.id,
      tabId: 'files-b',
      uri: uriB,
    })
    fireEvent.click(screen.getByRole('button', { name: 'Files C' }))
    await waitFor(() => expect(acknowledgeGfsDeepLink).toHaveBeenCalledWith(linkB.id))

    await act(async () => {
      deferred.get(uriB)?.(resourceB)
      await Promise.resolve()
      deferred.get(uriA)?.(resourceA)
      await Promise.resolve()
    })

    const activeTabButton = screen
      .getByRole('toolbar', { name: 'Workspace tabs' })
      .querySelector('button[aria-pressed="true"]')
    expect(activeTabButton?.getAttribute('aria-label')).toBe('Files C')
    expect(currentController.workspaceTabs.activeTabId).toBe('files-c')
    expect(
      currentController.workspaceTabs.tabs.find(tab => tab.id === 'files-a')?.files?.path
    ).toBe(uriA)
    expect(
      currentController.workspaceTabs.tabs.find(tab => tab.id === 'files-b')?.files?.path
    ).toBe(uriB)
    expect(
      currentController.workspaceTabs.tabs.find(tab => tab.id === 'files-c')?.files?.path
    ).toBe(uriC)
    expect(acknowledgeGfsDeepLink).toHaveBeenCalledTimes(2)
    expect(acknowledgeGfsDeepLink).toHaveBeenCalledWith(linkA.id)
    expect(acknowledgeGfsDeepLink).toHaveBeenCalledWith(linkB.id)
    expect(currentController.pushToast).not.toHaveBeenCalled()
  })

  it('clears a pending resource link at logout and accepts a new link for the next principal', async () => {
    const queue = new GfsResourceDeepLinkQueue()
    const linkA = produceGfsResourceDeepLink('gfs://main/11111111111111111111111111111111', queue)
    clearPendingGfsDeepLinks.mockImplementation(() => Promise.resolve(queue.clear()))
    const pushToast = currentController.pushToast
    currentController = makeController({
      booting: true,
      initialExperienceLoading: false,
      authenticatedPrincipalIdentity: 'user-a:user-a@example.com',
      pushToast,
    })
    const { rerender } = render(<App />)
    await waitFor(() => expect(emitGfsDeepLink).not.toBeNull())
    act(() => emitGfsDeepLink?.(linkA))

    currentController = makeController({
      booting: false,
      initialExperienceLoading: false,
      isAuthenticated: false,
      authenticatedPrincipalIdentity: null,
      pushToast,
    })
    rerender(<App />)

    currentController = makeController({
      booting: false,
      initialExperienceLoading: false,
      authenticatedPrincipalIdentity: 'user-b:user-b@example.com',
      pushToast,
    })
    rerender(<App />)
    await waitFor(() => expect(clearPendingGfsDeepLinks).toHaveBeenCalledOnce())

    const linkB = produceGfsResourceDeepLink('gfs://main/22222222222222222222222222222222', queue)
    act(() => emitGfsDeepLink?.(linkB))
    await waitFor(() =>
      expect(currentController.activateGfsResourceNavigation).toHaveBeenCalledOnce()
    )
    expect(filesPageHarness.props?.pendingGfsDeepLink).toEqual({ id: linkB.id, uri: linkB.uri })
  })

  it('clears pending resource links on a direct principal change', async () => {
    const queue = new GfsResourceDeepLinkQueue()
    const linkA = produceGfsResourceDeepLink('gfs://main/33333333333333333333333333333333', queue)
    clearPendingGfsDeepLinks.mockImplementation(() => Promise.resolve(queue.clear()))
    const pushToast = currentController.pushToast
    currentController = makeController({
      booting: true,
      initialExperienceLoading: false,
      authenticatedPrincipalIdentity: 'user-a:user-a@example.com',
      pushToast,
    })
    const { rerender } = render(<App />)
    await waitFor(() => expect(emitGfsDeepLink).not.toBeNull())
    act(() => emitGfsDeepLink?.(linkA))

    const openForB = vi.fn()
    currentController = makeController({
      booting: false,
      initialExperienceLoading: false,
      authenticatedPrincipalIdentity: 'user-b:user-b@example.com',
      openFilesSection: openForB,
      pushToast,
    })
    rerender(<App />)

    expect(openForB).not.toHaveBeenCalled()
    await waitFor(() => expect(clearPendingGfsDeepLinks).toHaveBeenCalledOnce())
  })

  it('ignores a cold pending-list response from the previous principal', async () => {
    const queue = new GfsResourceDeepLinkQueue()
    const staleLink = produceGfsResourceDeepLink(
      'gfs://main/44444444444444444444444444444444',
      queue
    )
    let resolveColdList!: (value: { links: GfsResourceDeepLinkEnvelope[] }) => void
    listPendingGfsDeepLinks.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveColdList = resolve
        })
    )
    clearPendingGfsDeepLinks.mockImplementation(() => Promise.resolve(queue.clear()))
    const pushToast = currentController.pushToast
    currentController = makeController({
      booting: true,
      initialExperienceLoading: false,
      authenticatedPrincipalIdentity: 'user-a:user-a@example.com',
      pushToast,
    })
    const { rerender } = render(<App />)
    await waitFor(() => expect(listPendingGfsDeepLinks).toHaveBeenCalledOnce())

    const openForB = vi.fn()
    currentController = makeController({
      booting: false,
      initialExperienceLoading: false,
      authenticatedPrincipalIdentity: 'user-b:user-b@example.com',
      openFilesSection: openForB,
      pushToast,
    })
    rerender(<App />)

    await act(async () => {
      resolveColdList({ links: [staleLink] })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(openForB).not.toHaveBeenCalled()
    await waitFor(() => expect(clearPendingGfsDeepLinks).toHaveBeenCalledOnce())
    expect(acknowledgeGfsDeepLink).not.toHaveBeenCalled()
  })

  it('deduplicates current-principal events and ignores stale acknowledgments', async () => {
    const queue = new GfsResourceDeepLinkQueue()
    const linkA = produceGfsResourceDeepLink('gfs://main/55555555555555555555555555555555', queue)
    clearPendingGfsDeepLinks.mockImplementation(() => Promise.resolve(queue.clear()))
    const pushToast = currentController.pushToast
    currentController = makeController({
      booting: false,
      initialExperienceLoading: false,
      authenticatedPrincipalIdentity: 'user-a:user-a@example.com',
      pushToast,
    })
    const { rerender } = render(<App />)
    await waitFor(() => expect(emitGfsDeepLink).not.toBeNull())
    act(() => emitGfsDeepLink?.(linkA))
    await waitFor(() =>
      expect(currentController.activateGfsResourceNavigation).toHaveBeenCalledOnce()
    )
    const staleOutcome = filesPageHarness.props?.onPendingGfsDeepLinkOutcome
    expect(staleOutcome).toBeTypeOf('function')

    currentController = makeController({
      booting: false,
      initialExperienceLoading: false,
      authenticatedPrincipalIdentity: 'user-b:user-b@example.com',
      pushToast,
    })
    rerender(<App />)
    await waitFor(() => expect(clearPendingGfsDeepLinks).toHaveBeenCalledOnce())

    const linkB = produceGfsResourceDeepLink('gfs://main/66666666666666666666666666666666', queue)
    act(() => {
      emitGfsDeepLink?.(linkB)
      emitGfsDeepLink?.(linkB)
    })
    await waitFor(() =>
      expect(currentController.activateGfsResourceNavigation).toHaveBeenCalledOnce()
    )

    act(() => staleOutcome?.(linkA.id, 'opened'))
    expect(acknowledgeGfsDeepLink).not.toHaveBeenCalled()
    expect(filesPageHarness.props?.pendingGfsDeepLink).toEqual({ id: linkB.id, uri: linkB.uri })
  })

  it('handles repeated Open route requests while FilesPage remains mounted', async () => {
    const workspaceTabs = openPreviewTab(createWorkspaceTabsState('chat-tab-1'), {
      id: 'preview-route-request',
      title: 'Quarterly report.md',
      gfsUri: 'gfs://main/77777777777777777777777777777777',
      sessionScope: ':user-a:team-a',
      fileKind: 'markdown',
      byteLength: 4,
    })
    const openFilesSection = vi.fn((path: string | null = null) => {
      const intentSequence = currentController.beginUserNavigationIntent()
      const next = openFilesTab(currentController.workspaceTabs, { id: 'files-root', path })
      currentController.setWorkspaceTabs(next)
      return next.activeTabId ? { ownerTabId: next.activeTabId, intentSequence } : null
    })
    currentController = makeController({
      initialExperienceLoading: false,
      workspaceTabs,
      openFilesSection,
    })
    render(<App />)

    await waitFor(() => expect(previewPageHarness.props?.onOpenRoute).toBeTypeOf('function'))
    const openRoute = previewPageHarness.props?.onOpenRoute
    act(() => openRoute?.())
    await waitFor(() => expect(filesPageHarness.handledRouteRequestIds).toEqual([1]))
    expect(filesPageHarness.mountCount).toBe(1)

    act(() => openRoute?.())
    await waitFor(() => expect(filesPageHarness.handledRouteRequestIds).toEqual([1, 2]))
    expect(filesPageHarness.mountCount).toBe(1)
    expect(openFilesSection).toHaveBeenCalledTimes(2)
  })

  // With universal-tabs an open app is a `kind:'app'` tab in the global strip, so
  // opening/closing an app no longer auto-collapses or restores the sidebar. The
  // manual toggle and its persistence are the only things that move the sidebar.
  it('does not collapse or restore the sidebar when an app opens and closes', () => {
    window.localStorage.clear()
    currentController = makeController({
      initialExperienceLoading: false,
      navItem: DESKTOP_ROUTES.apps,
    } as Partial<AppController>)
    render(<App />)
    expect(sidebarHarness.props?.collapsed).toBe(false)

    act(() => {
      sandboxUiPageHarness.props?.onEmbeddedAppOpening?.({
        appRef: 'ns/app',
        label: 'App',
        defaultPath: '/',
      })
    })
    // Guard against a vacuous assertion: the app must actually be active for
    // "the sidebar didn't move" to mean anything.
    expect(sandboxUiPageHarness.props?.shortcutApp?.appRef).toBe('ns/app')
    // Opening an app leaves the sidebar exactly as it was, and touches nothing in
    // the saved preference.
    expect(sidebarHarness.props?.collapsed).toBe(false)
    expect(window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY)).toBeNull()

    act(() => sandboxUiPageHarness.props?.onEmbeddedAppBack?.())
    expect(sidebarHarness.props?.collapsed).toBe(false)
  })

  it('keeps the manual sidebar toggle and its persistence intact while an app is open', () => {
    window.localStorage.clear()
    currentController = makeController({
      initialExperienceLoading: false,
      navItem: DESKTOP_ROUTES.apps,
    } as Partial<AppController>)
    render(<App />)

    act(() => {
      sandboxUiPageHarness.props?.onEmbeddedAppOpening?.({
        appRef: 'ns/app',
        label: 'App',
        defaultPath: '/',
      })
    })
    expect(sidebarHarness.props?.collapsed).toBe(false)

    // The user collapses the sidebar manually while the app is open: it collapses
    // and the choice persists.
    act(() => sidebarHarness.props?.onCollapsedChange?.(true))
    expect(sidebarHarness.props?.collapsed).toBe(true)
    expect(window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY)).toBe('1')

    // Expanding again is likewise user-driven and persists.
    act(() => sidebarHarness.props?.onCollapsedChange?.(false))
    expect(sidebarHarness.props?.collapsed).toBe(false)
    expect(window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY)).toBe('0')

    // Closing the app leaves the user's manual state untouched.
    act(() => sandboxUiPageHarness.props?.onEmbeddedAppBack?.())
    expect(sidebarHarness.props?.collapsed).toBe(false)
  })

  it('respects a saved collapsed preference regardless of app open/close', () => {
    window.localStorage.clear()
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, '1')
    currentController = makeController({
      initialExperienceLoading: false,
      navItem: DESKTOP_ROUTES.apps,
    } as Partial<AppController>)
    render(<App />)
    expect(sidebarHarness.props?.collapsed).toBe(true)

    act(() => {
      sandboxUiPageHarness.props?.onEmbeddedAppOpening?.({
        appRef: 'ns/app',
        label: 'App',
        defaultPath: '/',
      })
    })
    // Guard against a vacuous assertion: the app must actually be active here.
    expect(sandboxUiPageHarness.props?.shortcutApp?.appRef).toBe('ns/app')
    expect(sidebarHarness.props?.collapsed).toBe(true)

    act(() => sandboxUiPageHarness.props?.onEmbeddedAppOpenFailed?.())
    expect(sidebarHarness.props?.collapsed).toBe(true)
  })

  it('uses the shared titlebar header on every authenticated route', () => {
    const routes = Object.values(DESKTOP_ROUTES)

    for (const navItem of routes) {
      currentController = makeController({
        initialExperienceLoading: false,
        navItem,
      } as Partial<AppController>)
      const view = render(<App />)

      expect(appHeaderHarness.props?.placement).toBe('titlebar')

      view.unmount()
    }
  })

  it('runs registered new-tab and composer-focus commands through existing chat selection', () => {
    currentController = makeController({
      initialExperienceLoading: false,
      selectedAgent: 'alpha',
    } as Partial<AppController>)
    render(<App />)

    act(() => emitCommand?.('chat.newTab'))
    expect(currentController.handleSelectChatAgent).toHaveBeenCalledWith('alpha', {
      selectLatest: false,
    })

    act(() => emitCommand?.('composer.focus'))
    expect(currentController.handleSelectChatAgent).toHaveBeenLastCalledWith('alpha', {
      selectLatest: false,
    })
  })

  it.each(['folder route', 'file preview'])(
    'seeds the new chat composer from an active %s',
    async source => {
      const resource =
        source === 'folder route'
          ? await resolveResource(
              resolvedDirectory('0123456789abcdef0123456789abcdef', 'Shared folder')
            )
          : await resolveResource(
              resolvedFile('abcdefabcdefabcdefabcdefabcdefab', 'Quarterly report.md')
            )
      const workspaceTabs =
        source === 'folder route'
          ? openFilesTab(createWorkspaceTabsState('chat-tab-1'), {
              id: 'files-tab',
              path: resource.gfsUri,
            })
          : openPreviewTab(createWorkspaceTabsState('chat-tab-1'), {
              id: 'preview-tab',
              title: resource.name,
              gfsUri: resource.gfsUri,
              sessionScope: ':user-a:team-a',
              fileKind: 'markdown',
              byteLength: 4,
            })

      const activeTab = activeWorkspaceTab(workspaceTabs)
      if (activeTab?.kind === 'files' || activeTab?.kind === 'preview') {
        recordLatestGfsConversationContext(activeTab)
      }

      const sendMessage = vi.fn().mockResolvedValue(undefined)
      currentController = makeController({
        initialExperienceLoading: false,
        selectedAgent: 'alpha',
        workspaceTabs,
        handleSendAgentMessage: sendMessage,
      } as Partial<AppController>)
      const view = render(<App />)

      act(() => emitCommand?.('chat.newTab'))

      const composerSurface = screen
        .getAllByTestId('chat-page-surface')
        .find(element => element.getAttribute('data-composer-draft') === resource.gfsUri) as
        | HTMLTextAreaElement
        | undefined
      if (!composerSurface)
        throw new Error('The rendered composer did not receive the resource draft')
      expect(composerSurface.getAttribute('data-composer-draft')).toBe(resource.gfsUri)
      expect(
        Number(composerSurface.getAttribute('data-composer-focus-request-id'))
      ).toBeGreaterThan(0)
      view.rerender(<App />)
      await waitFor(() => expect(composerSurface.value).toBe(resource.gfsUri))
      expect(sendMessage).not.toHaveBeenCalled()
    }
  )

  it('keeps the resource draft and focuses the composer when ChatPage selects an agent', async () => {
    const resource = await resolveResource(
      resolvedDirectory('0123456789abcdef0123456789abcdef', 'Shared folder')
    )
    const workspaceTabs = openFilesTab(createWorkspaceTabsState('chat-tab-1'), {
      id: 'files-tab',
      path: resource.gfsUri,
    })
    const activeTab = activeWorkspaceTab(workspaceTabs)
    if (activeTab?.kind === 'files') recordLatestGfsConversationContext(activeTab)
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    currentController = makeController({
      initialExperienceLoading: false,
      workspaceTabs,
      handleSendAgentMessage: sendMessage,
    } as Partial<AppController>)
    render(<App />)

    act(() => emitCommand?.('chat.newTab'))
    const composerSurface = screen.getByTestId('chat-page-surface') as HTMLTextAreaElement
    expect(composerSurface.value).toBe(resource.gfsUri)

    // ChatPage selects the latest agent after the route opens; model that same
    // state transition through the controller's existing selection action.
    act(() => currentController.handleSelectChatAgent('alpha', { selectLatest: false }))

    await waitFor(() => expect(composerSurface.value).toBe(resource.gfsUri))
    await waitFor(() =>
      expect((document.activeElement as HTMLElement).dataset.testid).toBe('chat-page-surface')
    )
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('keeps global and contextual search commands on distinct host surfaces', () => {
    currentController = makeController({
      initialExperienceLoading: false,
      selectedAgent: 'alpha',
      activeChatId: 'chat-1',
    } as Partial<AppController>)
    render(<App />)

    act(() => emitCommand?.('search.open'))
    expect(appHeaderHarness.props?.searchFocusRequestId).toBe(1)
    expect(chatLocalSearchHarness.rendered).not.toHaveBeenCalled()

    act(() => emitCommand?.('search.current'))
    expect(chatLocalSearchHarness.rendered).toHaveBeenCalled()
    expect(appHeaderHarness.props?.searchFocusRequestId).toBe(1)
  })

  it('suppresses application commands while plugin consent owns the app surface', () => {
    currentController = makeController({ initialExperienceLoading: false })
    render(<App />)
    const consent = document.createElement('div')
    consent.className = 'da-plugin-consent'
    consent.setAttribute('role', 'dialog')
    document.body.append(consent)

    act(() => emitCommand?.('search.open'))

    expect(appHeaderHarness.props?.searchFocusRequestId).toBe(0)
    consent.remove()
  })

  it('routes contextual search to the current sandbox app without opening global search', () => {
    currentController = makeController({
      initialExperienceLoading: false,
      navItem: DESKTOP_ROUTES.apps,
      selectedAgent: 'alpha',
    } as Partial<AppController>)
    render(<App />)
    act(() => {
      sandboxUiPageHarness.props?.onEmbeddedAppOpening?.({
        appRef: 'ns/app',
        label: 'App',
        defaultPath: '/',
      })
    })

    act(() => emitCommand?.('search.current'))
    expect(sandboxUiPageHarness.props?.localSearchRequestId).toBe(0)
    act(() => sandboxUiPageHarness.props?.onEmbeddedAppMounted?.())
    act(() => emitCommand?.('search.current'))
    expect(sandboxUiPageHarness.props?.localSearchRequestId).toBe(1)
    expect(appHeaderHarness.props?.searchFocusRequestId).toBe(0)

    act(() => {
      sandboxUiPageHarness.props?.onEmbeddedAppOpening?.({
        appRef: 'ns/replacement',
        label: 'Replacement app',
        defaultPath: '/',
      })
      sandboxUiPageHarness.props?.onEmbeddedAppMounted?.()
    })
    act(() => emitCommand?.('search.current'))
    expect(sandboxUiPageHarness.props?.localSearchRequestId).toBe(2)
  })

  it('opens the palette, executes eligible registry actions, and captures the sandbox view', () => {
    currentController = makeController({
      initialExperienceLoading: false,
      navItem: DESKTOP_ROUTES.apps,
      selectedAgent: 'alpha',
    } as Partial<AppController>)
    render(<App />)
    act(() => {
      sandboxUiPageHarness.props?.onEmbeddedAppOpening?.({
        appRef: 'ns/app',
        label: 'App',
        defaultPath: '/',
      })
      emitCommand?.('commands.open', 'sandbox')
    })

    expect(commandPaletteHarness.props).not.toBeNull()
    expect(sandboxUiPageHarness.props?.headerShellOverlayOpen).toBe(true)
    expect(commandPaletteHarness.props?.isEligible('search.current')).toBe(true)

    act(() => commandPaletteHarness.props?.onExecute('search.open'))
    expect(appHeaderHarness.props?.searchFocusRequestId).toBe(1)
    expect(document.querySelector('[aria-label="Command palette"]')).toBeNull()
  })

  it('restores native app focus when a sandbox-opened palette is dismissed', async () => {
    currentController = makeController({
      initialExperienceLoading: false,
      navItem: DESKTOP_ROUTES.apps,
    } as Partial<AppController>)
    render(<App />)
    act(() => emitCommand?.('commands.open', 'sandbox'))
    act(() => commandPaletteHarness.props?.onClose())

    await waitFor(() => expect(window.clerum.sandboxUi.focusActive).toHaveBeenCalledOnce())
  })

  it('opens Settings Shortcuts through the registered palette action', () => {
    currentController = makeController({ initialExperienceLoading: false })
    render(<App />)
    act(() => emitCommand?.('commands.open'))
    act(() => commandPaletteHarness.props?.onExecute('settings.shortcuts'))

    expect(currentController.handleNavSelect).toHaveBeenCalledWith(DESKTOP_ROUTES.settings)
    expect(settingsPageHarness.props?.shortcutsFocusRequestId).toBe(1)
  })

  it('routes approved core palette actions through their existing owners', () => {
    currentController = makeController({ initialExperienceLoading: false })
    render(<App />)
    act(() => emitCommand?.('commands.open'))

    act(() => commandPaletteHarness.props?.onExecute('settings.open'))
    expect(currentController.handleNavSelect).toHaveBeenLastCalledWith(DESKTOP_ROUTES.settings)

    act(() => commandPaletteHarness.props?.onExecute('navigate.chat'))
    expect(currentController.handleNavSelect).toHaveBeenLastCalledWith(DESKTOP_ROUTES.chat)
    act(() => commandPaletteHarness.props?.onExecute('navigate.apps'))
    expect(currentController.handleNavSelect).toHaveBeenLastCalledWith(DESKTOP_ROUTES.apps)
    act(() => commandPaletteHarness.props?.onExecute('navigate.agents'))
    expect(currentController.handleNavSelect).toHaveBeenLastCalledWith(DESKTOP_ROUTES.agents)

    act(() => commandPaletteHarness.props?.onExecute('notifications.open'))
    expect(appHeaderHarness.props?.notificationOpenRequestId).toBe(1)
    act(() => commandPaletteHarness.props?.onExecute('auth.logout'))
    expect(currentController.handleLogout).toHaveBeenCalledOnce()
  })

  it('routes approved contextual palette actions through shell and app owners', () => {
    currentController = makeController({ initialExperienceLoading: false })
    render(<App />)
    act(() => emitCommand?.('commands.open'))

    for (const [commandId, route] of [
      ['navigate.plugins', DESKTOP_ROUTES.plugins],
      ['navigate.connectors', DESKTOP_ROUTES.connectors],
      ['navigate.files', DESKTOP_ROUTES.files],
    ] as const) {
      act(() => commandPaletteHarness.props?.onExecute(commandId))
      expect(currentController.handleNavSelect).toHaveBeenLastCalledWith(route)
    }

    act(() => commandPaletteHarness.props?.onExecute('sidebar.toggle'))
    expect(sidebarHarness.props?.toggleRequestId).toBe(1)

    // `navItem` is derived from the store; the instance-less Apps picker residual
    // puts the shell on the Apps route so the contextual app commands apply.
    act(() => {
      currentController.appsPickerActive = true
      forceControllerRender()
    })
    act(() => emitCommand?.('commands.open'))
    act(() => {
      sandboxUiPageHarness.props?.onEmbeddedAppOpening?.({
        appRef: 'ns/app',
        label: 'App',
        defaultPath: '/',
      })
    })
    expect(commandPaletteHarness.props?.isEligible('app.refresh')).toBe(false)
    act(() => sandboxUiPageHarness.props?.onEmbeddedAppMounted?.())
    expect(commandPaletteHarness.props?.isEligible('app.refresh')).toBe(true)
    act(() => commandPaletteHarness.props?.onExecute('app.refresh'))
    expect(sandboxUiPageHarness.props?.actionRequest).toEqual({ id: 1, action: 'refresh' })
    act(() => commandPaletteHarness.props?.onExecute('app.backToApps'))
    expect(sandboxUiPageHarness.props?.actionRequest).toEqual({ id: 2, action: 'back-to-apps' })
  })

  it('resets controlled command requests with the authenticated shell lifetime', async () => {
    currentController = makeController({ initialExperienceLoading: false })
    const { rerender } = render(<App />)

    act(() => emitCommand?.('commands.open'))
    act(() => commandPaletteHarness.props?.onExecute('notifications.open'))
    act(() => commandPaletteHarness.props?.onExecute('sidebar.toggle'))

    expect(appHeaderHarness.props?.notificationOpenRequestId).toBe(1)
    expect(sidebarHarness.props?.toggleRequestId).toBe(1)

    currentController = makeController({
      initialExperienceLoading: false,
      authenticatedPrincipalIdentity: 'user-b:user-b@example.com',
      navItem: DESKTOP_ROUTES.apps,
    })
    rerender(<App />)

    await waitFor(() => {
      expect(appHeaderHarness.props?.notificationOpenRequestId).toBe(0)
      expect(sidebarHarness.props?.toggleRequestId).toBe(0)
      expect(sandboxUiPageHarness.props?.actionRequest).toBeNull()
      expect(commandPaletteHarness.props?.isEligible('app.refresh')).toBe(false)
    })
  })

  afterEach(() => {
    cleanup()
    resetComposerDraftStore()
    vi.useRealTimers()
  })

  async function reportShortcutOpenResult(
    result: { status: 'mounted' } | { status: 'failed'; message: string } = {
      status: 'mounted',
    }
  ): Promise<void> {
    await waitFor(() => {
      expect(sandboxUiPageHarness.props?.shortcutOpenRequestId).toBeGreaterThan(0)
    })
    const props = sandboxUiPageHarness.props
    // Bound to its own const: TypeScript discards the narrowing of a property
    // inside a callback, because the object could be mutated in between.
    const requestId = props?.shortcutOpenRequestId
    if (!props || !requestId) throw new Error('Sandbox UI shortcut was not requested')
    await act(async () => {
      await props.onShortcutOpenResult?.(requestId, result)
      await Promise.resolve()
    })
  }

  async function confirmPendingAppLink(): Promise<void> {
    await waitFor(() => expect(confirmDialogHarness.props?.title).toBe('Open app link?'))
    await act(async () => {
      confirmDialogHarness.props?.onConfirm()
      await Promise.resolve()
    })
  }

  it('keeps logged-out app links pending until the user confirms after login', async () => {
    currentController = makeController({
      initialExperienceLoading: false,
      isAuthenticated: false,
      authenticatedPrincipalIdentity: null,
      me: null,
      currentTeamId: '',
    } as unknown as Partial<AppController>)
    listApps.mockResolvedValue({
      apps: [
        {
          appRef: 'ns/app',
          title: 'Linked App',
          defaultPath: '/',
          ready: true,
          phase: 'active',
        },
      ],
    })
    const { rerender } = render(<App />)
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/app' })
    })

    await act(async () => {
      await Promise.resolve()
    })
    expect(confirmDialogHarness.props).toBeNull()
    expect(currentController.handleNavSelect).not.toHaveBeenCalledWith(DESKTOP_ROUTES.apps)
    expect(acknowledgeDeepLink).not.toHaveBeenCalled()

    currentController = makeController({ initialExperienceLoading: false })
    rerender(<App />)

    await waitFor(() => expect(confirmDialogHarness.props?.title).toBe('Open app link?'))
    expect(currentController.handleNavSelect).not.toHaveBeenCalledWith(DESKTOP_ROUTES.apps)
    expect(acknowledgeDeepLink).not.toHaveBeenCalled()

    await act(async () => {
      confirmDialogHarness.props?.onConfirm()
      await Promise.resolve()
    })
    await reportShortcutOpenResult()

    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(1))
  })

  it('requires confirmation before navigating an authenticated app link', async () => {
    currentController = makeController({ initialExperienceLoading: false })
    listApps.mockResolvedValue({
      apps: [
        {
          appRef: 'ns/app',
          title: 'Linked App',
          defaultPath: '/',
          ready: true,
          phase: 'active',
        },
      ],
    })
    render(<App />)
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/app' })
    })

    await waitFor(() => expect(confirmDialogHarness.props?.title).toBe('Open app link?'))
    expect(currentController.handleNavSelect).not.toHaveBeenCalledWith(DESKTOP_ROUTES.apps)
    expect(acknowledgeDeepLink).not.toHaveBeenCalled()

    await confirmPendingAppLink()
    await reportShortcutOpenResult()

    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(1))
    // The launch drives the store (an app tab), so `navItem` derives to the Apps
    // route — the observable, not the retired `handleNavSelect(apps)` call.
    expect(currentController.navItem).toBe(DESKTOP_ROUTES.apps)
  })

  it('acknowledges an authenticated app link when confirmation is cancelled', async () => {
    currentController = makeController({ initialExperienceLoading: false })
    render(<App />)
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/app' })
    })

    await waitFor(() => expect(confirmDialogHarness.props?.title).toBe('Open app link?'))
    await act(async () => {
      confirmDialogHarness.props?.onCancel()
      await Promise.resolve()
    })

    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(1))
    expect(currentController.handleNavSelect).not.toHaveBeenCalledWith(DESKTOP_ROUTES.apps)
    expect(sandboxUiPageHarness.props?.shortcutOpenRequestId).toBeUndefined()
  })

  it('signals a deep-link overlay to the sandbox page while the confirm dialog is open', async () => {
    currentController = makeController({
      initialExperienceLoading: false,
      navItem: DESKTOP_ROUTES.apps,
    })
    listApps.mockResolvedValue({
      apps: [
        {
          appRef: 'ns/app',
          title: 'Linked App',
          defaultPath: '/',
          ready: true,
          phase: 'active',
        },
      ],
    })
    render(<App />)
    await waitFor(() => expect(sandboxUiPageHarness.props).not.toBeNull())
    // The native WebContentsView paints above renderer DOM, so the overlay
    // signal must stay off until a deep-link dialog actually needs to show.
    expect(sandboxUiPageHarness.props?.deepLinkShellOverlayOpen).toBe(false)
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/app' })
    })

    await waitFor(() => expect(confirmDialogHarness.props?.title).toBe('Open app link?'))
    expect(sandboxUiPageHarness.props?.deepLinkShellOverlayOpen).toBe(true)

    await confirmPendingAppLink()
    await reportShortcutOpenResult()
    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(1))
    await waitFor(() => expect(sandboxUiPageHarness.props?.deepLinkShellOverlayOpen).toBe(false))
  })

  it('keeps the deep-link overlay signal raised while the failure dialog is open', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const ensureTeamContext = vi.fn(async () => {
      throw Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' })
    })
    currentController = makeController({
      initialExperienceLoading: false,
      navItem: DESKTOP_ROUTES.apps,
      handleEnsureTeamContext: ensureTeamContext,
    })
    render(<App />)
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/app', teamId: 'team-b' })
    })
    await confirmPendingAppLink()

    for (const delay of [1_000, 2_000, 4_000, 8_000, 15_000]) {
      await act(async () => {
        vi.advanceTimersByTime(delay)
        await Promise.resolve()
      })
    }

    await waitFor(() =>
      expect(confirmDialogHarness.props?.title).toBe('App link could not be opened')
    )
    expect(sandboxUiPageHarness.props?.deepLinkShellOverlayOpen).toBe(true)

    await act(async () => {
      confirmDialogHarness.props?.onCancel()
      await Promise.resolve()
    })

    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(1))
    await waitFor(() => expect(sandboxUiPageHarness.props?.deepLinkShellOverlayOpen).toBe(false))
  })

  it('drops the overlay signal in lockstep with the dialog when Retry is chosen', async () => {
    // T5: the deep-link overlay signal and the dialog derive from one App-level
    // expression, so this pins that Retry (the failure dialog's onConfirm ->
    // handleRetryFailedSandboxUiDeepLink) never leaves the embed hidden with a
    // dialog still owning the screen, nor a dialog on screen with the embed
    // shown. The invariant asserted: a mounted deep-link dialog implies the
    // signal is raised, and once the signal drops no deep-link dialog is
    // mounted. Retry is distinct from Dismiss here — it must not acknowledge
    // the link, it re-drives the open.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const ensureTeamContext = vi.fn(async () => {
      throw Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' })
    })
    currentController = makeController({
      initialExperienceLoading: false,
      navItem: DESKTOP_ROUTES.apps,
      handleEnsureTeamContext: ensureTeamContext,
    })
    render(<App />)
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/app', teamId: 'team-b' })
    })
    await confirmPendingAppLink()

    for (const delay of [1_000, 2_000, 4_000, 8_000, 15_000]) {
      await act(async () => {
        vi.advanceTimersByTime(delay)
        await Promise.resolve()
      })
    }

    // Failure dialog is up: a mounted deep-link dialog must keep the signal
    // raised so the native WebContentsView does not paint over it.
    await waitFor(() =>
      expect(confirmDialogHarness.props?.title).toBe('App link could not be opened')
    )
    expect(confirmDialogHarness.mountedCount).toBeGreaterThan(0)
    expect(sandboxUiPageHarness.props?.deepLinkShellOverlayOpen).toBe(true)

    const ensureCallsBeforeRetry = ensureTeamContext.mock.calls.length

    // Retry — the failure dialog's onConfirm, not onCancel.
    await act(async () => {
      confirmDialogHarness.props?.onConfirm()
      await Promise.resolve()
    })

    // Retry clears the failure and re-drives the open in the same commit the
    // predicates go null, so the dialog unmounts as the signal drops. The
    // dialog value and the overlay signal are a single derived expression, so
    // they move in lockstep by construction. The assertions below check the
    // settled final state (dialog unmounted, signal false), not each render
    // frame. Retry never acknowledges (that is Dismiss).
    await waitFor(() => expect(sandboxUiPageHarness.props?.deepLinkShellOverlayOpen).toBe(false))
    expect(confirmDialogHarness.mountedCount).toBe(0)
    expect(acknowledgeDeepLink).not.toHaveBeenCalled()
    // The retry actually re-attempted the open (handleRetryFailedSandboxUiDeepLink
    // ran), rather than just tearing the dialog down.
    expect(ensureTeamContext.mock.calls.length).toBeGreaterThan(ensureCallsBeforeRetry)
  })

  it('does not duplicate an authenticated confirmation for the same link id', async () => {
    currentController = makeController({ initialExperienceLoading: false })
    listApps.mockResolvedValue({
      apps: [
        {
          appRef: 'ns/app',
          title: 'Linked App',
          defaultPath: '/',
          ready: true,
          phase: 'active',
        },
      ],
    })
    render(<App />)
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/app' })
      emitDeepLink?.({ id: 1, appRef: 'ns/app' })
    })

    await confirmPendingAppLink()
    await reportShortcutOpenResult()

    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(1))
    expect(acknowledgeDeepLink).toHaveBeenCalledTimes(1)
    // Launched exactly once — the store put the shell on the Apps route (the
    // observable that replaced the retired single `handleNavSelect(apps)` call).
    expect(currentController.navItem).toBe(DESKTOP_ROUTES.apps)
  })

  it('never presents a user A link after user B becomes authenticated', async () => {
    const { rerender } = render(<App />)
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/user-a-app', teamId: 'team-a' })
    })
    await waitFor(() => expect(confirmDialogHarness.props?.title).toBe('Open app link?'))
    confirmDialogHarness.rendered.mockClear()

    currentController = makeController({
      initialExperienceLoading: false,
      authenticatedPrincipalIdentity: 'user-b:user-b@example.com',
      me: {
        id: 'user-b',
        email: 'user-b@example.com',
        name: 'User B',
        picture: null,
        teamId: 'team-b',
        teamName: 'Team B',
        role: 'member',
      },
      currentTeamId: 'team-b',
    })
    rerender(<App />)

    expect(confirmDialogHarness.rendered).not.toHaveBeenCalled()
    await waitFor(() => expect(clearPendingDeepLinks).toHaveBeenCalledOnce())
    expect(currentController.handleEnsureTeamContext).not.toHaveBeenCalled()
    expect(acknowledgeDeepLink).not.toHaveBeenCalled()

    act(() => {
      emitDeepLink?.({ id: 2, appRef: 'ns/user-b-app', teamId: 'team-b' })
    })
    await waitFor(() => expect(confirmDialogHarness.rendered).toHaveBeenCalledOnce())
    expect(confirmDialogHarness.props?.title).toBe('Open app link?')
    expect(currentController.handleNavSelect).not.toHaveBeenCalledWith(DESKTOP_ROUTES.apps)
    expect(acknowledgeDeepLink).not.toHaveBeenCalled()
  })

  it('drops a stale cold-list response after the authenticated identity changes', async () => {
    let resolveColdList!: (value: { links: SandboxUiDeepLinkEnvelope[] }) => void
    listPendingDeepLinks.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveColdList = resolve
        })
    )
    const { rerender } = render(<App />)

    currentController = makeController({
      initialExperienceLoading: false,
      authenticatedPrincipalIdentity: 'user-b:user-b@example.com',
      me: {
        id: 'user-b',
        email: 'user-b@example.com',
        name: 'User B',
        picture: null,
        teamId: 'team-b',
        teamName: 'Team B',
        role: 'member',
      },
      currentTeamId: 'team-b',
    })
    rerender(<App />)
    await waitFor(() => expect(clearPendingDeepLinks).toHaveBeenCalledOnce())

    await act(async () => {
      resolveColdList({ links: [{ id: 1, appRef: 'ns/app', teamId: 'team-a' }] })
      await Promise.resolve()
    })

    expect(currentController.handleEnsureTeamContext).not.toHaveBeenCalled()
    expect(acknowledgeDeepLink).not.toHaveBeenCalled()
  })

  it('restores the previous team when the linked app is unavailable', async () => {
    currentController = makeController({ initialExperienceLoading: false })
    render(<App />)
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/missing', teamId: 'team-b' })
    })
    await confirmPendingAppLink()

    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(1))
    expect(currentController.handleEnsureTeamContext).toHaveBeenNthCalledWith(1, {
      teamId: 'team-b',
      announce: true,
    })
    expect(currentController.handleEnsureTeamContext).toHaveBeenNthCalledWith(2, {
      teamId: 'team-a',
      announce: true,
    })
    expect(currentController.pushToast).toHaveBeenCalledWith(
      expect.stringContaining("You don't have access"),
      'error'
    )
  })

  // Guard for conversationOrigin use (3): retiring back-to-conversation must not
  // touch the deep-link team restore, which re-selects the originating chat after
  // rolling a failed cross-team link back to the original team. Passes before and
  // after the retirement.
  it('re-selects the originating chat when a failed cross-team link rolls the team back', async () => {
    currentController = makeController({
      initialExperienceLoading: false,
      navItem: DESKTOP_ROUTES.chat,
      selectedAgent: 'alpha',
      activeChatId: 'chat-1',
    } as Partial<AppController>)
    render(<App />)
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/missing', teamId: 'team-b' })
    })
    await confirmPendingAppLink()

    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(1))
    // Team rolled back to the original, then the origin chat re-selected.
    expect(currentController.handleEnsureTeamContext).toHaveBeenNthCalledWith(2, {
      teamId: 'team-a',
      announce: true,
    })
    expect(currentController.handleSelectChatAgent).toHaveBeenCalledWith('alpha', {
      selectLatest: false,
      chatId: 'chat-1',
      title: 'Conversation',
    })
  })

  it('closes the active embed before switching teams for a failed cross-team handoff', async () => {
    const ensureTeamContext = vi.fn(async (): Promise<boolean> => true)
    currentController = makeController({
      initialExperienceLoading: false,
      navItem: DESKTOP_ROUTES.apps,
      handleEnsureTeamContext: ensureTeamContext,
    })
    render(<App />)
    await waitFor(() => expect(sandboxUiPageHarness.props).not.toBeNull())

    act(() => {
      sandboxUiPageHarness.props?.onEmbeddedAppOpening?.({
        appRef: 'ns/current',
        label: 'Current App',
        defaultPath: '/',
      })
    })
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/missing', teamId: 'team-b' })
    })
    await confirmPendingAppLink()

    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(1))
    expect(closeSandboxUi).toHaveBeenCalledOnce()
    expect(closeSandboxUi.mock.invocationCallOrder[0]).toBeLessThan(
      ensureTeamContext.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    )
  })

  it('lets the server authorize a linked team even when the local directory is empty', async () => {
    currentController = makeController({
      initialExperienceLoading: false,
      availableTeamIds: [],
      teamDirectoryHydrated: false,
    })
    listApps.mockResolvedValue({
      apps: [
        {
          appRef: 'ns/app',
          title: 'App',
          defaultPath: '/',
          ready: true,
          phase: 'active',
          updatedAt: null,
        },
      ],
    })
    render(<App />)
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/app', teamId: 'team-b' })
    })
    await confirmPendingAppLink()

    await reportShortcutOpenResult()
    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(1))
    expect(currentController.handleEnsureTeamContext).toHaveBeenCalledWith({
      teamId: 'team-b',
      announce: true,
    })
    expect(currentController.pushToast).not.toHaveBeenCalledWith(
      "Could not open app link: You don't have access to this app in the linked team",
      'error'
    )
  })

  it('does not roll back a team the user selected while a linked app was loading', async () => {
    let liveTeamId = 'team-a'
    const ensureTeamContext = vi.fn(async ({ teamId }: { teamId?: string }) => {
      if (!teamId || teamId === liveTeamId) return false
      liveTeamId = teamId
      return true
    })
    let resolveApps!: (value: { apps: [] }) => void
    listApps.mockResolvedValueOnce({ apps: [] }).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveApps = resolve
        })
    )
    currentController = makeController({
      initialExperienceLoading: false,
      handleEnsureTeamContext: ensureTeamContext,
      getCurrentTeamId: () => liveTeamId,
    })
    render(<App />)
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/missing', teamId: 'team-b' })
    })
    await confirmPendingAppLink()
    await waitFor(() => expect(ensureTeamContext).toHaveBeenCalledTimes(1))
    liveTeamId = 'team-c'
    await act(async () => {
      resolveApps({ apps: [] })
    })
    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(1))

    expect(ensureTeamContext).toHaveBeenCalledTimes(1)
    expect(liveTeamId).toBe('team-c')
  })

  it('contains a synchronously throwing acknowledgement bridge', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    currentController = makeController({ initialExperienceLoading: false })
    listApps.mockResolvedValue({
      apps: [
        {
          appRef: 'ns/app',
          title: 'App',
          defaultPath: '/',
          ready: true,
          phase: 'active',
        },
      ],
    })
    acknowledgeDeepLink.mockImplementationOnce(() => {
      throw new Error('bridge unavailable')
    })
    render(<App />)
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/app' })
    })
    await confirmPendingAppLink()

    await reportShortcutOpenResult()
    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(1))
    expect(currentController.pushToast).not.toHaveBeenCalledWith(
      expect.stringContaining('bridge unavailable'),
      'error'
    )
    expect(consoleWarn).toHaveBeenCalledWith(
      '[Desktop] Could not acknowledge app deep link:',
      expect.objectContaining({ message: 'bridge unavailable' })
    )
    consoleWarn.mockRestore()
  })

  it('acks a ready app link only after the native mount succeeds', async () => {
    currentController = makeController({ initialExperienceLoading: false })
    listApps.mockResolvedValue({
      apps: [
        {
          appRef: 'ns/app',
          title: 'Linked App',
          defaultPath: '/',
          ready: true,
          phase: 'active',
        },
      ],
    })
    render(<App />)
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/app' })
    })
    await confirmPendingAppLink()

    await waitFor(() => {
      expect(sandboxUiPageHarness.props?.shortcutOpenRequestId).toBeGreaterThan(0)
    })
    expect(acknowledgeDeepLink).not.toHaveBeenCalled()

    await reportShortcutOpenResult()

    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(1))
  })

  it('retries a starting app link and opens it when the app becomes ready', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    currentController = makeController({ initialExperienceLoading: false })
    let ready = false
    listApps.mockImplementation(async () => ({
      apps: [
        {
          appRef: 'ns/app',
          title: 'Linked App',
          defaultPath: '/',
          ready,
          phase: ready ? 'active' : 'deploying',
        },
      ],
    }))
    render(<App />)
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/app' })
    })
    await confirmPendingAppLink()

    await waitFor(() => {
      expect(currentController.pushToast).toHaveBeenCalledWith(
        'Linked App is still starting up. This link will retry shortly.',
        'info'
      )
    })
    expect(acknowledgeDeepLink).not.toHaveBeenCalled()

    ready = true
    await act(async () => {
      vi.advanceTimersByTime(1_000)
      await Promise.resolve()
    })
    await reportShortcutOpenResult()

    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(1))
  })

  it('keeps the target team during cross-team starting app retries', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let liveTeamId = 'team-a'
    const ensureTeamContext = vi.fn(async ({ teamId }: { teamId?: string }) => {
      if (!teamId || teamId === liveTeamId) return false
      liveTeamId = teamId
      return true
    })
    currentController = makeController({
      initialExperienceLoading: false,
      handleEnsureTeamContext: ensureTeamContext,
      getCurrentTeamId: () => liveTeamId,
    })
    let ready = false
    listApps.mockImplementation(async () => ({
      apps: [
        {
          appRef: 'ns/app',
          title: 'Linked App',
          defaultPath: '/',
          ready,
          phase: ready ? 'active' : 'deploying',
        },
      ],
    }))
    render(<App />)
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/app', teamId: 'team-b' })
    })
    await confirmPendingAppLink()

    await waitFor(() => {
      expect(currentController.pushToast).toHaveBeenCalledWith(
        'Linked App is still starting up. This link will retry shortly.',
        'info'
      )
    })
    expect(liveTeamId).toBe('team-b')
    expect(ensureTeamContext).toHaveBeenCalledTimes(1)
    expect(ensureTeamContext).toHaveBeenCalledWith({
      teamId: 'team-b',
      announce: true,
    })

    await act(async () => {
      vi.advanceTimersByTime(1_000)
      await Promise.resolve()
    })
    await waitFor(() => expect(currentController.pushToast).toHaveBeenCalledTimes(2))
    expect(liveTeamId).toBe('team-b')
    expect(ensureTeamContext).toHaveBeenCalledTimes(1)

    ready = true
    await act(async () => {
      vi.advanceTimersByTime(2_000)
      await Promise.resolve()
    })
    await reportShortcutOpenResult()

    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(1))
    expect(liveTeamId).toBe('team-b')
    expect(ensureTeamContext).toHaveBeenCalledTimes(1)
  })

  it('retries a failed cross-team native mount without treating its own restore as a user switch', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let liveTeamId = 'team-a'
    const ensureTeamContext = vi.fn(async ({ teamId }: { teamId?: string }) => {
      if (!teamId || teamId === liveTeamId) return false
      liveTeamId = teamId
      return true
    })
    currentController = makeController({
      initialExperienceLoading: false,
      handleEnsureTeamContext: ensureTeamContext,
      getCurrentTeamId: () => liveTeamId,
    })
    listApps.mockResolvedValue({
      apps: [
        {
          appRef: 'ns/app',
          title: 'Linked App',
          defaultPath: '/',
          ready: true,
          phase: 'active',
        },
      ],
    })
    render(<App />)
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/app', teamId: 'team-b' })
    })
    await confirmPendingAppLink()
    await reportShortcutOpenResult({ status: 'failed', message: 'native mount failed' })

    await waitFor(() => {
      expect(currentController.pushToast).toHaveBeenCalledWith('native mount failed', 'error')
    })
    expect(liveTeamId).toBe('team-b')
    expect(acknowledgeDeepLink).not.toHaveBeenCalled()

    await act(async () => {
      vi.advanceTimersByTime(1_000)
      await Promise.resolve()
    })
    await reportShortcutOpenResult()

    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(1))
    expect(acknowledgeDeepLink).toHaveBeenCalledTimes(1)
    expect(liveTeamId).toBe('team-b')
    expect(ensureTeamContext).toHaveBeenCalledTimes(1)
    expect(currentController.pushToast).not.toHaveBeenCalledWith(
      expect.stringContaining('you switched teams'),
      'error'
    )
  })

  it('does not override a manual team switch during a failed cross-team native-mount retry', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let liveTeamId = 'team-a'
    const ensureTeamContext = vi.fn(async ({ teamId }: { teamId?: string }) => {
      if (!teamId || teamId === liveTeamId) return false
      liveTeamId = teamId
      return true
    })
    currentController = makeController({
      initialExperienceLoading: false,
      handleEnsureTeamContext: ensureTeamContext,
      getCurrentTeamId: () => liveTeamId,
    })
    listApps.mockResolvedValue({
      apps: [
        {
          appRef: 'ns/app',
          title: 'Linked App',
          defaultPath: '/',
          ready: true,
          phase: 'active',
        },
      ],
    })
    render(<App />)
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/app', teamId: 'team-b' })
    })
    await confirmPendingAppLink()
    await reportShortcutOpenResult({ status: 'failed', message: 'native mount failed' })

    await waitFor(() => {
      expect(currentController.pushToast).toHaveBeenCalledWith('native mount failed', 'error')
    })
    expect(liveTeamId).toBe('team-b')
    expect(ensureTeamContext).toHaveBeenCalledTimes(1)

    liveTeamId = 'team-c'
    await act(async () => {
      vi.advanceTimersByTime(1_000)
      await Promise.resolve()
    })

    await waitFor(() => expect(currentController.pushToast).toHaveBeenCalledTimes(2))
    const nativeMountFailures = vi
      .mocked(currentController.pushToast)
      .mock.calls.filter(([message, tone]) => message === 'native mount failed' && tone === 'error')
    expect(nativeMountFailures).toHaveLength(1)
    expect(currentController.pushToast).toHaveBeenCalledWith(
      expect.stringContaining('you switched teams'),
      'error'
    )
    expect(confirmDialogHarness.props?.title).toBe('App link could not be opened')
    expect(liveTeamId).toBe('team-c')
    expect(ensureTeamContext).toHaveBeenCalledTimes(1)
    // The launch put the shell on the Apps route via the store (observable that
    // replaced the retired single `handleNavSelect(apps)` call).
    expect(currentController.navItem).toBe(DESKTOP_ROUTES.apps)
    expect(sandboxUiPageHarness.props?.shortcutOpenRequestId).toBe(1)
    expect(acknowledgeDeepLink).not.toHaveBeenCalled()

    await act(async () => {
      vi.advanceTimersByTime(60_000)
      await Promise.resolve()
    })
    expect(liveTeamId).toBe('team-c')
    expect(ensureTeamContext).toHaveBeenCalledTimes(1)
    expect(acknowledgeDeepLink).not.toHaveBeenCalled()
  })

  it('retries a transient team-context failure and opens without duplicate mounts', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let liveTeamId = 'team-a'
    const transientError = Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' })
    const ensureTeamContext = vi
      .fn()
      .mockRejectedValueOnce(transientError)
      .mockImplementation(async ({ teamId }: { teamId?: string }) => {
        if (!teamId || teamId === liveTeamId) return false
        liveTeamId = teamId
        return true
      })
    currentController = makeController({
      initialExperienceLoading: false,
      handleEnsureTeamContext: ensureTeamContext,
      getCurrentTeamId: () => liveTeamId,
    })
    listApps.mockResolvedValue({
      apps: [
        {
          appRef: 'ns/app',
          title: 'Linked App',
          defaultPath: '/',
          ready: true,
          phase: 'active',
        },
      ],
    })
    render(<App />)
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/app', teamId: 'team-b' })
    })
    await confirmPendingAppLink()

    await waitFor(() => {
      expect(currentController.pushToast).toHaveBeenCalledWith(
        'Could not switch to the linked team yet: fetch failed. This link will retry shortly.',
        'info'
      )
    })
    expect(acknowledgeDeepLink).not.toHaveBeenCalled()

    await act(async () => {
      vi.advanceTimersByTime(1_000)
      await Promise.resolve()
    })
    await reportShortcutOpenResult()

    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(1))
    expect(acknowledgeDeepLink).toHaveBeenCalledTimes(1)
    // Launched exactly once onto the Apps route via the store (observable that
    // replaced the retired single `handleNavSelect(apps)` call).
    expect(currentController.navItem).toBe(DESKTOP_ROUTES.apps)
    expect(liveTeamId).toBe('team-b')
  })

  it('keeps a transient team-context failure pending when retry budget is exhausted', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const ensureTeamContext = vi.fn(async () => {
      throw Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' })
    })
    currentController = makeController({
      initialExperienceLoading: false,
      handleEnsureTeamContext: ensureTeamContext,
    })
    render(<App />)
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/app', teamId: 'team-b' })
    })
    await confirmPendingAppLink()

    await waitFor(() => expect(ensureTeamContext).toHaveBeenCalledTimes(1))
    await waitFor(() => {
      expect(currentController.pushToast).toHaveBeenCalledWith(
        'Could not switch to the linked team yet: fetch failed. This link will retry shortly.',
        'info'
      )
    })

    for (const [index, delay] of [1_000, 2_000, 4_000, 8_000, 15_000].entries()) {
      await act(async () => {
        vi.advanceTimersByTime(delay)
        await Promise.resolve()
      })
      await waitFor(() => expect(ensureTeamContext).toHaveBeenCalledTimes(index + 2))
    }

    await waitFor(() => {
      expect(confirmDialogHarness.props?.title).toBe('App link could not be opened')
    })
    expect(ensureTeamContext).toHaveBeenCalledTimes(6)
    expect(acknowledgeDeepLink).not.toHaveBeenCalled()
  })

  it('does not retry permanent team access failures', async () => {
    const ensureTeamContext = vi.fn(async () => {
      throw new Error('403 forbidden: not a member of team-b')
    })
    currentController = makeController({
      initialExperienceLoading: false,
      handleEnsureTeamContext: ensureTeamContext,
    })
    render(<App />)
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/app', teamId: 'team-b' })
    })
    await confirmPendingAppLink()

    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(1))
    expect(ensureTeamContext).toHaveBeenCalledTimes(1)
    expect(confirmDialogHarness.props?.title).not.toBe('App link could not be opened')
  })

  it('keeps a failed native mount unacked and continues with later links', async () => {
    currentController = makeController({ initialExperienceLoading: false })
    listApps.mockResolvedValue({
      apps: [
        {
          appRef: 'ns/app',
          title: 'Linked App',
          defaultPath: '/',
          ready: true,
          phase: 'active',
        },
        {
          appRef: 'ns/next',
          title: 'Next App',
          defaultPath: '/',
          ready: true,
          phase: 'active',
        },
      ],
    })
    render(<App />)
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/app' })
    })
    await confirmPendingAppLink()
    await reportShortcutOpenResult({ status: 'failed', message: 'native mount failed' })

    expect(acknowledgeDeepLink).not.toHaveBeenCalledWith(1)

    act(() => {
      emitDeepLink?.({ id: 2, appRef: 'ns/next' })
    })
    await confirmPendingAppLink()
    await waitFor(() => {
      expect(sandboxUiPageHarness.props?.shortcutOpenRequestId).toBeGreaterThan(1)
    })
    await reportShortcutOpenResult()

    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(2))
    expect(acknowledgeDeepLink).not.toHaveBeenCalledWith(1)
  })

  // ── mini-spec 05: Phase-1 app persistence by URL restoration ────────────────

  const READY_APP = {
    appRef: 'ns/app',
    title: 'Linked App',
    defaultPath: '/',
    ready: true,
    phase: 'active',
  }

  // A genuinely distinct app: a different appRef, so cross-app lifecycle
  // isolation tests exercise App A → App B rather than a second tab of App A.
  const READY_APP_B = {
    appRef: 'ns/app-b',
    title: 'Linked App B',
    defaultPath: '/',
    ready: true,
    phase: 'active',
  }

  const appTabs = () => currentController.workspaceTabs.tabs.filter(tab => tab.kind === 'app')

  // Launch an app straight through the sidebar (`onOpenSandboxUiApp`), the same
  // path the real app-picker uses — no deep-link confirm ceremony. Defaults to
  // `ns/app`; pass a distinct appRef to launch another app the sidebar offers.
  async function launchAppFromSidebar(appRef = 'ns/app'): Promise<void> {
    const app = await waitFor(() => {
      const available = sidebarHarness.props?.availableSandboxUiApps?.find(a => a.appRef === appRef)
      if (!available) throw new Error(`${appRef} was not available to the sidebar`)
      return available
    })
    await act(async () => {
      sidebarHarness.props?.onOpenSandboxUiApp?.(app)
      await Promise.resolve()
    })
    await waitFor(() => expect(sandboxUiPageHarness.props?.shortcutApp?.appRef).toBe(appRef))
  }

  async function selectTab(index: 0 | 1 | 2): Promise<void> {
    await waitFor(() => expect(emitCommand).not.toBeNull())
    await act(async () => {
      emitCommand?.(`tabs.select${index + 1}` as DesktopCommandId)
      await Promise.resolve()
    })
  }

  it('restores the saved route when an app tab is reactivated (mini-spec 05 §3, T3)', async () => {
    currentController = makeController({ initialExperienceLoading: false })
    listApps.mockResolvedValue({ apps: [READY_APP] })
    render(<App />)
    await launchAppFromSidebar()
    // Launched at the default route — nothing persisted yet.
    expect(sandboxUiPageHarness.props?.shortcutApp?.routePath).toBeUndefined()

    // The embed navigated to a non-default route. This is the shape the real
    // producer emits (sandboxUiDriver.test.ts proves '/tickets/42' for a nested
    // view URL; appService.getSandboxUiLocation reshapes it to { appRef, routePath }).
    getSandboxUiLocation.mockResolvedValue({ appRef: 'ns/app', routePath: '/tickets/42' })

    // Deactivate → the store reads the route and persists it on the app tab.
    await selectTab(0)
    await waitFor(() => expect(appTabs()[0]?.app?.savedRoutePath).toBe('/tickets/42'))

    // Reactivate → the embed re-mounts at the saved route, not the default path.
    await selectTab(1)
    await waitFor(() =>
      expect(sandboxUiPageHarness.props?.shortcutApp?.routePath).toBe('/tickets/42')
    )
  })

  it('keeps two tabs of the same app on their own routes when alternating (§5)', async () => {
    currentController = makeController({ initialExperienceLoading: false })
    listApps.mockResolvedValue({ apps: [READY_APP] })
    render(<App />)

    // Two tabs of the same app: [chat, A, B].
    await launchAppFromSidebar()
    getSandboxUiLocation.mockResolvedValue({ appRef: 'ns/app', routePath: '/tickets/A' })
    await launchAppFromSidebar() // deactivates A (persists /tickets/A), activates B
    await waitFor(() => expect(appTabs()).toHaveLength(2))
    await waitFor(() => expect(appTabs()[0]?.app?.savedRoutePath).toBe('/tickets/A'))

    // B navigates to its own route, then we switch back to A.
    getSandboxUiLocation.mockResolvedValue({ appRef: 'ns/app', routePath: '/tickets/B' })
    await selectTab(1) // index 1 = A
    await waitFor(() => expect(appTabs()[1]?.app?.savedRoutePath).toBe('/tickets/B'))
    await waitFor(() =>
      expect(sandboxUiPageHarness.props?.shortcutApp?.routePath).toBe('/tickets/A')
    )

    // Back to B restores B's own route.
    await selectTab(2) // index 2 = B
    await waitFor(() =>
      expect(sandboxUiPageHarness.props?.shortcutApp?.routePath).toBe('/tickets/B')
    )
  })

  it('closes the embed exactly once on deactivation — the store is the single emitter (§3)', async () => {
    currentController = makeController({ initialExperienceLoading: false })
    listApps.mockResolvedValue({ apps: [READY_APP] })
    render(<App />)
    await launchAppFromSidebar()

    closeSandboxUi.mockClear()
    getSandboxUiLocation.mockClear()

    await selectTab(0) // deactivate to the seeded chat tab
    await waitFor(() => expect(closeSandboxUi).toHaveBeenCalledTimes(1))
    expect(getSandboxUiLocation).toHaveBeenCalledTimes(1)
  })

  it('does not re-close after an UNsolicited close reconciles the tab as not mounted (§3)', async () => {
    currentController = makeController({ initialExperienceLoading: false })
    listApps.mockResolvedValue({ apps: [READY_APP] })
    render(<App />)
    await launchAppFromSidebar()

    // Unsolicited teardown (crash / quit / partition GC) arrives while the app
    // tab is still active: the store reconciles its liveness to "not mounted".
    await act(async () => {
      sandboxUiPageHarness.props?.onEmbeddedAppBack?.()
      await Promise.resolve()
    })

    closeSandboxUi.mockClear()
    getSandboxUiLocation.mockClear()

    // A later deactivation must not persist/close a dead embed.
    await selectTab(0)
    await act(async () => {
      await Promise.resolve()
    })
    expect(closeSandboxUi).not.toHaveBeenCalled()
    expect(getSandboxUiLocation).not.toHaveBeenCalled()
  })

  it('closes an embed re-mounted within the still-active app tab (Blocker — arm-on-open)', async () => {
    currentController = makeController({ initialExperienceLoading: false })
    listApps.mockResolvedValue({ apps: [READY_APP] })
    render(<App />)
    await launchAppFromSidebar()

    // Back-to-apps / unsolicited onClosed clears the liveness ref but leaves the
    // app tab active (the in-page Apps grid is shown, no tab change).
    await act(async () => {
      sandboxUiPageHarness.props?.onEmbeddedAppBack?.()
      await Promise.resolve()
    })

    // Re-mount the embed DIRECTLY from the in-page grid: this only fires
    // onEmbeddedAppOpening — it does NOT create or select a store tab. Before the
    // arm-on-open fix the liveness ref stays null here, so the deactivation
    // effect early-returns on the next switch and the native view leaks; with the
    // fix, onEmbeddedAppOpening arms the ref to the active app tab.
    await act(async () => {
      sandboxUiPageHarness.props?.onEmbeddedAppOpening?.({
        appRef: 'ns/app',
        label: 'Linked App',
        defaultPath: '/',
      })
      await Promise.resolve()
    })

    closeSandboxUi.mockClear()

    // Switching to a chat tab must close the re-mounted embed exactly once.
    await selectTab(0)
    await waitFor(() => expect(closeSandboxUi).toHaveBeenCalledTimes(1))
  })

  it('persists the outgoing app route on a deep-link handoff (§3, Should-fix)', async () => {
    const ensureTeamContext = vi.fn(async (): Promise<boolean> => true)
    currentController = makeController({
      initialExperienceLoading: false,
      handleEnsureTeamContext: ensureTeamContext,
    })
    listApps.mockResolvedValue({ apps: [READY_APP] })
    render(<App />)
    await launchAppFromSidebar()
    const outgoingId = appTabs()[0]?.id

    // The outgoing embed is on a non-default route when a cross-team deep link
    // hands off — the handoff must persist it, same as the deactivation effect.
    getSandboxUiLocation.mockResolvedValue({ appRef: 'ns/app', routePath: '/handoff/route' })

    await waitFor(() => expect(emitDeepLink).not.toBeNull())
    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/app', teamId: 'team-b' })
    })
    await confirmPendingAppLink()

    await waitFor(() =>
      expect(
        currentController.workspaceTabs.tabs.find(tab => tab.id === outgoingId)?.app?.savedRoutePath
      ).toBe('/handoff/route')
    )
    expect(getSandboxUiLocation).toHaveBeenCalled()
    expect(closeSandboxUi).toHaveBeenCalled()
  })

  // R1-H1 (mini-spec 07): the deactivation continuation reads the outgoing
  // route over IPC and then closes the singleton embed. If the user reactivates
  // the SAME app tab before that read resolves, the stale continuation must not
  // tear down the just-reopened embed nor overwrite the live tab's route with
  // the value it read from the view that is already gone. The read is deferred
  // here so the reactivation lands while it is in flight. The resolved value uses
  // the same `{ appRef, routePath }` contract shape the rest of the suite uses
  // (pinned by sandboxUiDriver.test.ts); the gate aborts before routePath is read
  // on the raced path, so its exact value does not matter to this test.
  function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(res => {
      resolve = res
    })
    return { promise, resolve }
  }

  it('does not close or overwrite an app tab reactivated before the stale getLocation resolves (R1-H1, T3)', async () => {
    currentController = makeController({ initialExperienceLoading: false })
    listApps.mockResolvedValue({ apps: [READY_APP] })
    render(<App />)
    await launchAppFromSidebar() // tabs: [chat, A]; A is live

    closeSandboxUi.mockClear()
    getSandboxUiLocation.mockClear()

    // Defer the deactivation read so App A can be reactivated while it is still
    // in flight. Only the deactivation continuation calls getLocation here
    // (reactivation early-returns before any read), so one deferred call is exact.
    const pendingLocation = createDeferred<{ appRef: string; routePath?: string }>()
    getSandboxUiLocation.mockReturnValueOnce(pendingLocation.promise)

    // Deactivate A → seeded chat tab: dispatches the read-then-close continuation.
    await selectTab(0)
    // Reactivate A before the old read resolves: a newer activation now owns the
    // active view and the embed is re-mounted for A.
    await selectTab(1)

    // The stale read finally resolves with A's earlier route.
    await act(async () => {
      pendingLocation.resolve({ appRef: 'ns/app', routePath: '/stale/route' })
      await Promise.resolve()
      await Promise.resolve()
    })

    // Liveness witnesses (M4): the negative assertions below pass vacuously if the
    // deactivation never reads/closes at all, so pin that the read-then-close DID
    // run (exactly the deferred call) and that A is genuinely re-mounted and live.
    expect(getSandboxUiLocation).toHaveBeenCalledTimes(1)
    expect(sandboxUiPageHarness.props?.shortcutApp?.appRef).toBe('ns/app')

    // Observable result: the reopened embed was NOT torn down, and the live tab's
    // route was NOT clobbered by the stale value. (At the pre-fix head the stale
    // continuation closes the reopened embed and persists '/stale/route' onto A.)
    expect(closeSandboxUi).not.toHaveBeenCalled()
    expect(appTabs()[0]?.app?.savedRoutePath).not.toBe('/stale/route')
  })

  it('does not close a different app opened before the stale getLocation resolves (R1-H1, T3)', async () => {
    currentController = makeController({ initialExperienceLoading: false })
    // Two genuinely distinct apps: A's stale continuation must not tear down B.
    listApps.mockResolvedValue({ apps: [READY_APP, READY_APP_B] })
    render(<App />)
    await launchAppFromSidebar('ns/app') // tabs: [chat, A]; A is live

    closeSandboxUi.mockClear()
    getSandboxUiLocation.mockClear()

    const pendingLocation = createDeferred<{ appRef: string; routePath?: string }>()
    getSandboxUiLocation.mockReturnValueOnce(pendingLocation.promise)

    // Deactivate A → seeded chat tab (A's read in flight).
    await selectTab(0)
    // Open a DIFFERENT app (B, distinct appRef) before A's read resolves; B is live.
    await launchAppFromSidebar('ns/app-b')
    await waitFor(() => expect(appTabs()).toHaveLength(2))

    // The stale read resolves with A's route, while B owns the active view.
    await act(async () => {
      pendingLocation.resolve({ appRef: 'ns/app', routePath: '/stale/route' })
      await Promise.resolve()
      await Promise.resolve()
    })

    // Liveness witness (M4): A's deactivation read-then-close DID run (exactly the
    // deferred call — launching B early-returns before any read), so the negative
    // assertions below are not vacuously green.
    expect(getSandboxUiLocation).toHaveBeenCalledTimes(1)
    // Observable result: B stays the live view and its embed survives (no close).
    // (At the pre-fix head the stale continuation closes the newly-opened B embed.)
    expect(sandboxUiPageHarness.props?.shortcutApp?.appRef).toBe('ns/app-b')
    expect(closeSandboxUi).not.toHaveBeenCalled()
    expect(appTabs()[1]?.app?.appRef).toBe('ns/app-b')
    // Cross-app persist isolation: the stale read carried A's appRef, so the pre-fix
    // continuation would clobber A's own route with '/stale/route'. The gate aborts
    // that persist once B owns the active view, so A's route stays untouched.
    expect(appTabs()[0]?.app?.appRef).toBe('ns/app')
    expect(appTabs()[0]?.app?.savedRoutePath).not.toBe('/stale/route')
    expect(appTabs()[1]?.app?.savedRoutePath).toBeUndefined()
  })

  // R3-H1: closeActiveSandboxUiEmbedForHandoff re-checks the activation generation
  // after its `getLocation()` read, so a handoff superseded mid-read never clobbers
  // the live tab's route nor tears down the embed that now owns the active view. That
  // post-read check is the reachable guard: it aborts before both the persist AND the
  // close, since no `await` separates them (the second gen check right before close is
  // a defensive re-check for a future edit that would add one — it cannot fire on its
  // own with today's control flow). No test exercised the reachable guard: removing it
  // left the suite green. This defers the handoff's read, supersedes it with a plain
  // deactivation (which bumps the generation and closes the embed itself), then
  // resolves the stale read and asserts the handoff added neither a stale persist
  // nor a second close.
  it('does not persist or close for a superseded deep-link handoff (R3-H1, T3)', async () => {
    const ensureTeamContext = vi.fn(async (): Promise<boolean> => true)
    currentController = makeController({
      initialExperienceLoading: false,
      handleEnsureTeamContext: ensureTeamContext,
    })
    // The deep link targets an UNAVAILABLE app (ns/missing) so the post-handoff
    // open fails cleanly instead of relaunching an app and muddying the assertions.
    listApps.mockResolvedValue({ apps: [READY_APP] })
    render(<App />)
    await launchAppFromSidebar('ns/app') // tabs: [chat, A]; A live, liveRef = A
    const outgoingId = appTabs()[0]?.id

    closeSandboxUi.mockClear()
    getSandboxUiLocation.mockClear()

    // Defer the HANDOFF's read so a newer activation can bump the generation while
    // it is in flight (only the handoff reads before the supersede below).
    const pendingLocation = createDeferred<{ appRef: string; routePath?: string }>()
    getSandboxUiLocation.mockReturnValueOnce(pendingLocation.promise)

    // A cross-team deep link drives closeActiveSandboxUiEmbedForHandoff, which reads
    // the outgoing route (deferred here) before it would persist + close.
    await waitFor(() => expect(emitDeepLink).not.toBeNull())
    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/missing', teamId: 'team-b' })
    })
    await confirmPendingAppLink()
    await waitFor(() => expect(getSandboxUiLocation).toHaveBeenCalledTimes(1), { timeout: 5000 })

    // Supersede the handoff: switch to the seeded chat tab. The deactivation effect
    // bumps the activation generation AND closes A's embed itself, all while the
    // handoff's read is still pending.
    await selectTab(0)
    await waitFor(() => expect(closeSandboxUi).toHaveBeenCalledTimes(1))

    // The superseded handoff read finally resolves with A's earlier route.
    await act(async () => {
      pendingLocation.resolve({ appRef: 'ns/app', routePath: '/stale/handoff' })
      await Promise.resolve()
      await Promise.resolve()
    })

    // The post-read gen check aborts the superseded continuation: A is NOT persisted
    // with the stale route, and the handoff emits NO second close on top of the
    // deactivation's. With that guard removed the handoff clobbers A with
    // '/stale/handoff' AND closes a second time.
    const appA = currentController.workspaceTabs.tabs.find(tab => tab.id === outgoingId)
    expect(appA?.app?.savedRoutePath).not.toBe('/stale/handoff')
    expect(closeSandboxUi).toHaveBeenCalledTimes(1)
  })

  // R3-M1 (the missing half of R1-H1): the deactivation continuation must validate
  // that the route it read belongs to the OUTGOING tab's app before persisting it.
  // On an app→app switch the incoming `open()` can reach main before this read
  // resolves, so `getLocation` can surface the INCOMING app's location within a
  // single activation generation — the generation gate does not catch that. Without
  // the appRef guard, App B's route lands on App A's tab.
  it('does not persist the incoming app route onto the outgoing tab (R3-M1, T3)', async () => {
    currentController = makeController({ initialExperienceLoading: false })
    // Two genuinely distinct apps so the read can carry the WRONG app's location.
    listApps.mockResolvedValue({ apps: [READY_APP, READY_APP_B] })
    render(<App />)
    await launchAppFromSidebar('ns/app') // tabs: [chat, A]; A live
    const outgoingId = appTabs()[0]?.id

    // The deactivation read returns the INCOMING app's location (B), not A's.
    getSandboxUiLocation.mockResolvedValue({ appRef: 'ns/app-b', routePath: '/b/route' })

    await launchAppFromSidebar('ns/app-b') // deactivates A (reads B's location), activates B
    await waitFor(() => expect(appTabs()).toHaveLength(2))
    // Let A's deactivation continuation run to completion.
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    // Observable result: A keeps its own identity and is NOT saved with B's route.
    // The read's appRef ('ns/app-b') did not match A's ('ns/app'), so the persist
    // fell back to undefined. (At the pre-guard head A.savedRoutePath === '/b/route'.)
    const appA = currentController.workspaceTabs.tabs.find(tab => tab.id === outgoingId)
    expect(appA?.app?.appRef).toBe('ns/app')
    expect(appA?.app?.savedRoutePath).not.toBe('/b/route')
    expect(appA?.app?.savedRoutePath).toBeUndefined()
  })

  // R4-M1 (regression of R3-M1's fix 8a9c45f5d): the appRef guard fell back to
  // `undefined` on a foreign read, and setAppTabSavedRoutePath treats `undefined`
  // as an authoritative CLEAR — so a foreign/stale read did not merely "skip
  // saving B", it ERASED A's own previously-saved route. §3 Option A: a foreign
  // or failed read must PRESERVE (never call the setter). Both seam sites.
  it('preserves the outgoing tab route when the deactivation read surfaces a foreign app (R4-M1, §3, T3)', async () => {
    currentController = makeController({ initialExperienceLoading: false })
    listApps.mockResolvedValue({ apps: [READY_APP, READY_APP_B] })
    render(<App />)
    await launchAppFromSidebar('ns/app') // tabs: [chat, A]; A live & active
    const outgoingId = appTabs()[0]!.id

    // Seed A's OWN saved route through the real store producer.
    act(() => {
      currentController.setWorkspaceTabs(state =>
        setAppTabSavedRoutePath(state, outgoingId, '/a/own')
      )
    })
    expect(appTabs()[0]?.app?.savedRoutePath).toBe('/a/own')

    // app→app switch whose deactivation read resolves the INCOMING app's location
    // within one activation generation (deferred so it lands after B is active).
    getSandboxUiLocation.mockClear()
    const pendingLocation = createDeferred<{ appRef: string; routePath?: string }>()
    getSandboxUiLocation.mockReturnValueOnce(pendingLocation.promise)
    await launchAppFromSidebar('ns/app-b') // deactivates A, reads (deferred)
    await waitFor(() => expect(getSandboxUiLocation).toHaveBeenCalled())
    await act(async () => {
      pendingLocation.resolve({ appRef: 'ns/app-b', routePath: '/b/route' })
      await Promise.resolve()
      await Promise.resolve()
    })

    // Liveness witness (M4): A's deactivation read genuinely ran. A later
    // read may also occur while the incoming app activates.
    expect(getSandboxUiLocation).toHaveBeenCalled()
    // Observable: A keeps its OWN route — the foreign read must not clear it.
    // (Pre-fix, the mismatch fell back to undefined → setter CLEARED '/a/own'.)
    const appA = currentController.workspaceTabs.tabs.find(tab => tab.id === outgoingId)
    expect(appA?.app?.savedRoutePath).toBe('/a/own')
  })

  it('preserves the outgoing tab route when the handoff read surfaces a foreign app (R4-M1, §3, T3)', async () => {
    const ensureTeamContext = vi.fn(async (): Promise<boolean> => true)
    currentController = makeController({
      initialExperienceLoading: false,
      handleEnsureTeamContext: ensureTeamContext,
    })
    listApps.mockResolvedValue({ apps: [READY_APP] })
    render(<App />)
    await launchAppFromSidebar('ns/app') // A live & active
    const outgoingId = appTabs()[0]!.id

    act(() => {
      currentController.setWorkspaceTabs(state =>
        setAppTabSavedRoutePath(state, outgoingId, '/a/own')
      )
    })
    expect(appTabs()[0]?.app?.savedRoutePath).toBe('/a/own')

    // A cross-team deep link drives closeActiveSandboxUiEmbedForHandoff; its read
    // of the outgoing embed surfaces a FOREIGN app's location.
    getSandboxUiLocation.mockResolvedValue({ appRef: 'ns/app-b', routePath: '/b/route' })
    await waitFor(() => expect(emitDeepLink).not.toBeNull())
    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/missing', teamId: 'team-b' })
    })
    await confirmPendingAppLink()
    await waitFor(() => expect(getSandboxUiLocation).toHaveBeenCalled())
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    // Observable: the handoff must not erase A's own route on a foreign read.
    // (Pre-fix, the mismatch fell back to undefined → setter CLEARED '/a/own'.)
    const appA = currentController.workspaceTabs.tabs.find(tab => tab.id === outgoingId)
    expect(appA?.app?.savedRoutePath).toBe('/a/own')
  })
})
