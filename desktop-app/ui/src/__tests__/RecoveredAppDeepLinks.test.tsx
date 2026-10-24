// @vitest-environment jsdom
import { type ReactNode, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentTaskTrackerProvider } from '@contexts/AgentTaskTrackerContext'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { buildSandboxUiDeepLink, parseSandboxUiDeepLink } from '@clerum/desktop-app-links'
import { buildGfsResourceDeepLink, parseGfsResourceDeepLink } from '@clerum/desktop-app-links'
import { DESKTOP_ROUTES, SIDEBAR_COLLAPSED_KEY } from '@constants/navigation'
import { useAppController } from '@hooks/useAppController'
import { resetComposerDraftStore } from '@lib/composerDraftStore'
import type { EmbedOwnershipMachine } from '@lib/embedOwnershipMachine.types'
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
  resolveDeniedMessage,
  resolveResource,
  resolvedDirectory,
  resolvedFile,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
import type { DesktopCommandId } from '../../../src/desktopCommands'
import { GfsResourceDeepLinkQueue } from '../../../src/gfsResourceDeepLinkQueue'
import { SandboxUiDeepLinkQueue } from '../../../src/sandboxUiDeepLinkQueue'
import type { AccessCatalog } from '../../../src/types'
import {
  HARNESS_ME,
  installAppControllerClerum,
} from '../hooks/domain/__tests__/__fixtures__/appControllerHarness'
import { desktopQueryKeys } from '../hooks/domain/queryKeys'
import type { NavItem } from '../uiTypes'
import { type SandboxUiMainFake, createSandboxUiMainFake } from './__fixtures__/sandboxUiMainFake'

// The sandbox main fake installs a fetch stub for its token mint. The real
// ApiError producer below needs Node's native fetch for its loopback fixture.
const nativeFetch = globalThis.fetch

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

async function produceDeniedGfsMessage(
  ...args: Parameters<typeof resolveDeniedMessage>
): Promise<string> {
  const sandboxFetch = globalThis.fetch
  vi.stubGlobal('fetch', nativeFetch)
  try {
    return await resolveDeniedMessage(...args)
  } finally {
    vi.stubGlobal('fetch', sandboxFetch)
  }
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
    onShellOverlayOpenChange?: (open: boolean) => void
  },
}))

const chatLocalSearchHarness = vi.hoisted(() => ({ rendered: vi.fn() }))
const filesPageHarness = vi.hoisted(() => ({
  pendingGfsUri: null as string | null,
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
  props: null as null | {
    gfsUri?: string
    onOpenRoute?: () => void
    onRenameCommitted?: (gfsUri: string) => void
  },
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
    availableSandboxUiApps?: SidebarLaunchApp[]
    onOpenSandboxUiApp?: (app: SidebarLaunchApp) => void
    onSelect?: (item: NavItem) => void
  },
}))

const sandboxUiPageHarness = vi.hoisted(() => ({
  props: null as null | {
    embed: EmbedOwnershipMachine
    headerShellOverlayOpen?: boolean
    deepLinkShellOverlayOpen?: boolean
    localSearchRequestId?: number
  },
}))
const SLOT_BOUNDS = { x: 16, y: 12, width: 400, height: 300, dpr: 1 }

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
  IconButton: () => null,
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
      const { composerFocusRequestId, workspaceChatTabId } = useChatComposerStateContext()
      const { selectedAgent } = useNavigationContext()
      const [draft, setDraft] = useComposerDraft(null, selectedAgent ?? undefined)
      const composerRef = useRef<HTMLTextAreaElement | null>(null)
      useEffect(() => {
        if (composerFocusRequestId > 0) composerRef.current?.focus()
      }, [composerFocusRequestId])
      return (
        <textarea
          data-testid="chat-page-surface"
          data-workspace-chat-tab-id={workspaceChatTabId ?? ''}
          data-composer-focus-request-id={composerFocusRequestId}
          data-composer-draft={draft}
          ref={composerRef}
          onChange={event => setDraft(event.currentTarget.value)}
          value={draft}
        />
      )
    },
  }
})
vi.mock('@pages/FilesPage', () => ({
  FilesPage: (props: {
    pendingGfsUri?: string | null
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
  }) => {
    const handledRequestIdRef = useRef(0)
    const [resolvedUri, setResolvedUri] = useState<string | null>(null)
    const pendingLink = props.pendingGfsDeepLink
    const visibleTabId = props.workspaceTabId ?? filesPageHarness.activeTabId
    filesPageHarness.pendingGfsUri = props.pendingGfsUri ?? null
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
      filesPageHarness.resolveRequests.push({
        id: pendingLink.id,
        tabId,
        uri: pendingLink.uri,
      })
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
// The page is stubbed, but like the real one it measures the slot for every
// launch while it is mounted, so launches reach main.
vi.mock('@pages/SandboxUiPage', () => ({
  SandboxUiPage: (props: NonNullable<typeof sandboxUiPageHarness.props>) => {
    sandboxUiPageHarness.props = props
    const { embed } = props
    useLayoutEffect(() => embed.registerMeasurer(async () => SLOT_BOUNDS), [embed])
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
type WorkspaceNavigationSnapshot = Pick<
  AppController,
  | 'workspaceTabs'
  | 'selectedAgent'
  | 'selectedAgentRoute'
  | 'appsPickerActive'
  | 'lastActiveChatTabId'
>

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
    controller.navigationIntentSequence = testNavigationIntentSequence
    forceControllerRender()
    return testNavigationIntentSequence
  })
  const isNavigationIntentCurrent = vi.fn(
    (sequence: number) => sequence === testNavigationIntentSequence
  )
  const captureWorkspaceNavigation = vi.fn(
    (): WorkspaceNavigationSnapshot => ({
      workspaceTabs: controller.workspaceTabs,
      selectedAgent: controller.selectedAgent,
      selectedAgentRoute: controller.selectedAgentRoute,
      appsPickerActive: controller.appsPickerActive,
      lastActiveChatTabId: controller.lastActiveChatTabId,
    })
  )
  const restoreWorkspaceNavigation = vi.fn(
    (snapshot: WorkspaceNavigationSnapshot, expectedIntentSequence: number) => {
      if (!isNavigationIntentCurrent(expectedIntentSequence)) return null
      testNavigationIntentSequence += 1
      controller.navigationIntentSequence = testNavigationIntentSequence
      controller.workspaceTabs = snapshot.workspaceTabs
      controller.selectedAgent = snapshot.selectedAgent
      controller.selectedAgentRoute = snapshot.selectedAgentRoute
      controller.appsPickerActive = snapshot.appsPickerActive
      controller.lastActiveChatTabId = snapshot.lastActiveChatTabId
      forceControllerRender()
      return testNavigationIntentSequence
    }
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
      controller.navigationIntentSequence = testNavigationIntentSequence
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
      principalGeneration: number
    ) => {
      if (!isGfsResourceNavigationCurrent(request, principalGeneration)) return false
      setWorkspaceTabs(
        openPreviewTab(controller.workspaceTabs, {
          id: nextWorkspaceTabId(),
          title: preview.name,
          gfsUri: preview.gfsUri,
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
    lastActiveChatTabId: null,
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
      beginUserNavigationIntent()
      setWorkspaceTabs((state: WorkspaceState) =>
        openFilesTab(state, { id: nextWorkspaceTabId(), path })
      )
    }),
    openPreviewSection: vi.fn((preview: Parameters<AppController['openPreviewSection']>[0]) => {
      beginUserNavigationIntent()
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
    }),
    navigationIntentSequence: testNavigationIntentSequence,
    beginUserNavigationIntent,
    isNavigationIntentCurrent,
    captureWorkspaceNavigation,
    restoreWorkspaceNavigation,
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
  let main: SandboxUiMainFake
  const closeSandboxUi = vi.fn((...args: Parameters<SandboxUiMainFake['bridge']['close']>) =>
    main.bridge.close(...args)
  )
  const openSandboxUi = vi.fn((...args: Parameters<SandboxUiMainFake['bridge']['open']>) =>
    main.bridge.open(...args)
  )
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
    confirmDialogHarness.props = null
    confirmDialogHarness.mountedCount = 0
    appHeaderHarness.props = null
    chatLocalSearchHarness.rendered.mockReset()
    commandPaletteHarness.props = null
    filesPageHarness.pendingGfsUri = null
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
    closeSandboxUi.mockImplementation((...args: Parameters<SandboxUiMainFake['bridge']['close']>) =>
      main.bridge.close(...args)
    )
    openSandboxUi.mockImplementation((...args: Parameters<SandboxUiMainFake['bridge']['open']>) =>
      main.bridge.open(...args)
    )
    getSandboxUiLocation.mockResolvedValue(null)
    main = createSandboxUiMainFake()
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
          ...main.bridge,
          close: closeSandboxUi,
          open: openSandboxUi,
          getLocation: getSandboxUiLocation,
          listApps,
          listPendingDeepLinks,
          clearPendingDeepLinks,
          acknowledgeDeepLink,
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
          onDeepLink: vi.fn((callback: (link: GfsResourceDeepLinkEnvelope) => void) => {
            emitGfsDeepLink = callback
            return vi.fn()
          }),
        },
      } as unknown as Window['clerum'],
    })
  })

  // An app launched the way the sidebar does, into a new app tab. The stubbed
  // page measures for it, and main mounts it unless told otherwise.
  const LIVE_APP = { appRef: 'ns/app', label: 'App', defaultPath: '/' }

  function embedState() {
    const embed = sandboxUiPageHarness.props?.embed
    if (!embed) throw new Error('the Apps page is not mounted')
    return embed.getSnapshot()
  }

  function embedPhase(): string | undefined {
    const state = embedState()
    return state.owner === null ? undefined : state.views.get(state.owner)?.phase
  }

  async function launchLiveApp(
    app: { appRef: string; label: string; defaultPath: string } = LIVE_APP
  ) {
    await act(async () => {
      sidebarHarness.props?.onOpenSandboxUiApp?.(app)
      await Promise.resolve()
    })
  }

  async function waitForMounted() {
    await waitFor(() => expect(embedPhase()).toBe('mounted'))
  }
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
      const errorMessage = await produceDeniedGfsMessage(
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
      fileKind: 'markdown',
      byteLength: 4,
    })
    const openFilesSection = vi.fn((path: string | null = null) => {
      currentController.setWorkspaceTabs(state => openFilesTab(state, { id: 'files-root', path }))
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

  it("wires Preview rename through App's canonical-URI metadata refresh", async () => {
    const resource = await resolveResource(
      resolvedFile('77777777777777777777777777777777', 'renamed-report.md')
    )
    const workspaceTabs = openPreviewTab(createWorkspaceTabsState('chat-tab-1'), {
      id: 'preview-rename-owner',
      title: 'report.md',
      gfsUri: resource.gfsUri,
      fileKind: 'markdown',
      byteLength: 4,
      resourceVersion: 0,
    })
    resolveGfsResource.mockResolvedValue(resource)
    currentController = makeController({
      initialExperienceLoading: false,
      workspaceTabs,
    })
    render(<App />)

    await waitFor(() => expect(previewPageHarness.props?.onRenameCommitted).toBeTypeOf('function'))
    await act(async () => {
      previewPageHarness.props?.onRenameCommitted?.(resource.gfsUri)
      await Promise.resolve()
    })

    await waitFor(() =>
      expect(
        currentController.workspaceTabs.tabs.find(tab => tab.id === 'preview-rename-owner')?.title
      ).toBe('renamed-report.md')
    )
    expect(resolveGfsResource).toHaveBeenCalledWith(resource.gfsUri)
    expect(currentController.workspaceTabs.activeTabId).toBe('preview-rename-owner')
    expect(
      currentController.workspaceTabs.tabs.find(tab => tab.id === 'preview-rename-owner')?.preview
        ?.gfsUri
    ).toBe(resource.gfsUri)
  })

  // With universal-tabs an open app is a `kind:'app'` tab in the global strip, so
  // opening/closing an app no longer auto-collapses or restores the sidebar. The
  // manual toggle and its persistence are the only things that move the sidebar.
  it('does not collapse or restore the sidebar when an app opens and closes', async () => {
    window.localStorage.clear()
    currentController = makeController({
      initialExperienceLoading: false,
      navItem: DESKTOP_ROUTES.apps,
    } as Partial<AppController>)
    render(<App />)
    expect(sidebarHarness.props?.collapsed).toBe(false)

    await launchLiveApp()
    await waitForMounted()
    // Opening an app leaves the sidebar exactly as it was, and touches nothing in
    // the saved preference.
    expect(sidebarHarness.props?.collapsed).toBe(false)
    expect(window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY)).toBeNull()

    await act(async () => emitCommand?.('app.backToApps'))
    await waitFor(() => expect(embedState().owner).toBeNull())
    expect(sidebarHarness.props?.collapsed).toBe(false)
  })

  it('keeps the manual sidebar toggle and its persistence intact while an app is open', async () => {
    window.localStorage.clear()
    currentController = makeController({
      initialExperienceLoading: false,
      navItem: DESKTOP_ROUTES.apps,
    } as Partial<AppController>)
    render(<App />)

    await launchLiveApp()
    await waitForMounted()
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
    await act(async () => emitCommand?.('app.backToApps'))
    await waitFor(() => expect(embedState().owner).toBeNull())
    expect(sidebarHarness.props?.collapsed).toBe(false)
  })

  it('respects a saved collapsed preference regardless of app open/close', async () => {
    window.localStorage.clear()
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, '1')
    currentController = makeController({
      initialExperienceLoading: false,
      navItem: DESKTOP_ROUTES.apps,
    } as Partial<AppController>)
    render(<App />)
    expect(sidebarHarness.props?.collapsed).toBe(true)

    main.failNextOpen(new Error('open rejected'))
    await launchLiveApp()
    await waitFor(() => expect(embedState().failure?.kind).toBe('open'))
    expect(sidebarHarness.props?.collapsed).toBe(true)
  })

  it('drops the shell overlays raised over an app whose view is gone while its tab stays', async () => {
    currentController = makeController({
      initialExperienceLoading: false,
      navItem: DESKTOP_ROUTES.apps,
    } as Partial<AppController>)
    render(<App />)
    await launchLiveApp()
    await waitForMounted()
    act(() => appHeaderHarness.props?.onShellOverlayOpenChange?.(true))
    expect(sandboxUiPageHarness.props?.headerShellOverlayOpen).toBe(true)

    await act(() => main.crash())

    await waitFor(() => expect(embedState().failure?.kind).toBe('crashed'))
    expect(sandboxUiPageHarness.props?.headerShellOverlayOpen).toBe(false)
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
      navigationIntentAlreadyStarted: true,
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
              fileKind: 'markdown',
              byteLength: 4,
            })

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

  it('routes contextual search to the current sandbox app without opening global search', async () => {
    currentController = makeController({
      initialExperienceLoading: false,
      navItem: DESKTOP_ROUTES.apps,
      selectedAgent: 'alpha',
    } as Partial<AppController>)
    render(<App />)
    const held = main.holdNextOpen()
    await launchLiveApp()
    await waitFor(() => expect(openSandboxUi).toHaveBeenCalledTimes(1))

    // Still opening: nothing to search yet.
    act(() => emitCommand?.('search.current'))
    expect(sandboxUiPageHarness.props?.localSearchRequestId).toBe(0)
    await act(async () => held().resolve())
    await waitForMounted()
    act(() => emitCommand?.('search.current'))
    expect(sandboxUiPageHarness.props?.localSearchRequestId).toBe(1)
    expect(appHeaderHarness.props?.searchFocusRequestId).toBe(0)

    await launchLiveApp({ appRef: 'ns/replacement', label: 'Replacement app', defaultPath: '/' })
    await waitFor(() => expect(openSandboxUi).toHaveBeenCalledTimes(2))
    await waitForMounted()
    act(() => emitCommand?.('search.current'))
    expect(sandboxUiPageHarness.props?.localSearchRequestId).toBe(2)
  })

  it('opens the palette, executes eligible registry actions, and captures the sandbox view', async () => {
    currentController = makeController({
      initialExperienceLoading: false,
      navItem: DESKTOP_ROUTES.apps,
      selectedAgent: 'alpha',
    } as Partial<AppController>)
    render(<App />)
    await launchLiveApp()
    act(() => emitCommand?.('commands.open', 'sandbox'))

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

  it('routes approved contextual palette actions through shell and app owners', async () => {
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

    const held = main.holdNextOpen()
    await launchLiveApp()
    await waitFor(() => expect(openSandboxUi).toHaveBeenCalledTimes(1))
    act(() => emitCommand?.('commands.open'))
    expect(commandPaletteHarness.props?.isEligible('app.refresh')).toBe(false)
    await act(async () => held().resolve())
    await waitForMounted()
    expect(commandPaletteHarness.props?.isEligible('app.refresh')).toBe(true)

    // Refresh reloads the live view in place: no close, no new view.
    const first = main.openCall(0).launchId
    await act(async () => commandPaletteHarness.props?.onExecute('app.refresh'))
    await act(() => main.settle())
    expect(main.liveReloads()).toBe(1)
    expect(main.live()?.launchId).toBe(first)
    expect(openSandboxUi).toHaveBeenCalledTimes(1)
    expect(closeSandboxUi).not.toHaveBeenCalled()

    act(() => emitCommand?.('commands.open'))
    await act(async () => commandPaletteHarness.props?.onExecute('app.backToApps'))
    await waitFor(() => expect(embedState().owner).toBeNull())
    expect(closeSandboxUi).toHaveBeenLastCalledWith({ launchId: first })
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
      expect(commandPaletteHarness.props?.isEligible('app.refresh')).toBe(false)
    })
  })

  afterEach(async () => {
    cleanup()
    resetComposerDraftStore()
    vi.useRealTimers()
    await main.dispose()
  })

  // The deep link's launch reached main (`times` opens so far). Main mounts it
  // unless the test told the fake to hold or fail that open.
  async function waitForAppOpen(times = 1): Promise<void> {
    await waitFor(() => expect(openSandboxUi).toHaveBeenCalledTimes(times))
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
    await waitForAppOpen()

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
    await waitForAppOpen()

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
    expect(openSandboxUi).not.toHaveBeenCalled()
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
    await waitForAppOpen()
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
    await waitForAppOpen()

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

  it('preserves the originating chat workspace when an unavailable cross-team link rolls back', async () => {
    currentController = makeController({
      initialExperienceLoading: false,
      navItem: DESKTOP_ROUTES.chat,
      selectedAgent: 'alpha',
      activeChatId: 'chat-1',
    } as Partial<AppController>)
    render(<App />)
    await waitFor(() => expect(emitDeepLink).not.toBeNull())
    const originWorkspace = currentController.workspaceTabs

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
    expect(currentController.workspaceTabs).toEqual(originWorkspace)
    expect(currentController.selectedAgent).toBe('alpha')
  })

  it('restores a team-A-only selection after a produced unavailable app link rolls back', async () => {
    const existingBridge = window.clerum
    const { clerum } = installAppControllerClerum({
      me: { teamId: 'team-a', teamName: 'Team A' },
      teamDirectory: { items: [], currentTeamId: 'team-a' },
    })
    let activeTeamId = 'team-a'
    const catalogFor = (teamId: string, agentName: string): AccessCatalog => ({
      userId: HARNESS_ME.id,
      teamId,
      userContextIds: [],
      userAgentNames: [],
      teamContextIds: [],
      teamAgentNames: [agentName],
      contextIds: [],
      agentNames: [agentName],
      mcpServersByAgent: {},
      agentContextByName: { [agentName]: null },
      agentProviderByName: { [agentName]: null },
      agentDisplayByName: { [agentName]: agentName },
    })
    const switchTeam = vi.fn(async (teamId: string) => {
      activeTeamId = teamId
      return {
        authenticated: true,
        me: { ...HARNESS_ME, teamId, teamName: teamId === 'team-a' ? 'Team A' : 'Team B' },
      }
    })
    const refreshCatalog = vi.fn(async () =>
      activeTeamId === 'team-a'
        ? catalogFor('team-a', 'team-a-only-agent')
        : catalogFor('team-b', 'team-b-only-agent')
    )
    Object.assign(window.clerum.team, { switch: switchTeam })
    Object.assign(window.clerum.access, { refreshCatalog })

    let resolveApps!: (value: { apps: [] }) => void
    let targetAppsLoading = false
    let targetAppsCalls = 0
    const pendingAppsResult = () =>
      new Promise<{ apps: [] }>(resolve => {
        resolveApps = resolve
      })
    let targetAppsResult = pendingAppsResult()
    listApps.mockImplementation(async () => {
      if (activeTeamId !== 'team-b') return { apps: [] }
      targetAppsCalls += 1
      targetAppsLoading = targetAppsCalls >= 2
      return targetAppsResult
    })
    const queue = new SandboxUiDeepLinkQueue()
    acknowledgeDeepLink.mockImplementation(async (id: number) => queue.acknowledge(id))
    const appBridge = existingBridge
    Object.assign(clerum, {
      shortcuts: appBridge.shortcuts,
      app: appBridge.app,
      gfs: appBridge.gfs,
      sandboxUi: {
        ...appBridge.sandboxUi,
        listPendingDeepLinks: vi.fn(async () => ({ links: [] })),
        onDeepLink: vi.fn((callback: (link: SandboxUiDeepLinkEnvelope) => void) => {
          emitDeepLink = callback
          return vi.fn()
        }),
        acknowledgeDeepLink,
      },
    })

    const actual =
      await vi.importActual<typeof import('@hooks/useAppController')>('@hooks/useAppController')
    const realController: { current: AppController | null } = { current: null }
    const restoredWorkspaceTabs: WorkspaceState[] = []
    vi.mocked(useAppController).mockImplementation(() => {
      realController.current = actual.useAppController()
      const restoreWorkspaceNavigation = realController.current.restoreWorkspaceNavigation
      realController.current.restoreWorkspaceNavigation = (snapshot, expectedIntentSequence) => {
        restoredWorkspaceTabs.push(snapshot.workspaceTabs)
        return restoreWorkspaceNavigation(snapshot, expectedIntentSequence)
      }
      return realController.current
    })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <AgentTaskTrackerProvider>
          <App />
        </AgentTaskTrackerProvider>
      </QueryClientProvider>
    )

    await waitFor(() => expect(realController.current?.initialExperienceLoading).toBe(false))
    await waitFor(() =>
      expect(
        queryClient.getQueryData<AccessCatalog>(desktopQueryKeys.accessCatalog)?.teamAgentNames
      ).toEqual(['team-a-only-agent'])
    )
    act(() => {
      realController.current?.handleSelectChatAgent('team-a-only-agent', {
        selectLatest: false,
      })
    })
    let originWorkspace = realController.current?.workspaceTabs
    expect(realController.current?.selectedAgent).toBe('team-a-only-agent')
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    const target = parseSandboxUiDeepLink(
      buildSandboxUiDeepLink({ recipeNs: 'ns', recipeName: 'missing', teamId: 'team-b' })
    )
    if (!target) throw new Error('The production app-link parser rejected the fixture URL')
    const producedLink = queue.enqueue(target)
    act(() => emitDeepLink?.(producedLink))
    await confirmPendingAppLink()
    originWorkspace = realController.current?.workspaceTabs
    await waitFor(() => expect(targetAppsLoading).toBe(true))
    await waitFor(() => expect(realController.current?.currentTeamId).toBe('team-b'))
    await waitFor(() =>
      expect(
        queryClient.getQueryData<AccessCatalog>(desktopQueryKeys.accessCatalog)?.teamAgentNames
      ).toEqual(['team-b-only-agent'])
    )
    expect(switchTeam).toHaveBeenCalledWith('team-b')
    await act(async () => {
      resolveApps({ apps: [] })
    })

    await waitFor(() => expect(realController.current?.currentTeamId).toBe('team-a'))
    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(producedLink.id))
    expect(realController.current?.workspaceTabs).toEqual(originWorkspace)
    expect(realController.current?.selectedAgent).toBe('team-a-only-agent')
    expect(restoredWorkspaceTabs).toEqual([originWorkspace])
    expect(switchTeam).toHaveBeenNthCalledWith(1, 'team-b')
    expect(switchTeam).toHaveBeenNthCalledWith(2, 'team-a')

    targetAppsCalls = 0
    targetAppsLoading = false
    targetAppsResult = pendingAppsResult()
    const explicitTarget = parseSandboxUiDeepLink(
      buildSandboxUiDeepLink({
        recipeNs: 'ns',
        recipeName: 'missing-after-selection',
        teamId: 'team-b',
      })
    )
    if (!explicitTarget) throw new Error('The production app-link parser rejected the fixture URL')
    const explicitLink = queue.enqueue(explicitTarget)
    act(() => emitDeepLink?.(explicitLink))
    await confirmPendingAppLink()
    await waitFor(() => expect(targetAppsLoading).toBe(true))
    await waitFor(() => expect(realController.current?.currentTeamId).toBe('team-b'))
    await waitFor(() =>
      expect(
        queryClient.getQueryData<AccessCatalog>(desktopQueryKeys.accessCatalog)?.teamAgentNames
      ).toEqual(['team-b-only-agent'])
    )
    act(() => {
      realController.current?.handleSelectChatAgent('team-b-only-agent', {
        selectLatest: false,
      })
    })
    expect(realController.current?.selectedAgent).toBe('team-b-only-agent')
    await act(async () => {
      resolveApps({ apps: [] })
    })
    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(explicitLink.id))
    expect(realController.current?.currentTeamId).toBe('team-b')
    expect(realController.current?.selectedAgent).toBe('team-b-only-agent')
    expect(restoredWorkspaceTabs).toEqual([originWorkspace])
  })

  it('clears the prior principal selection across an authenticated → null → B transition', async () => {
    const existingBridge = window.clerum
    const { clerum, handle } = installAppControllerClerum({
      me: { teamId: 'team-a', teamName: 'Team A' },
      teamDirectory: { items: [], currentTeamId: 'team-a' },
    })
    Object.assign(clerum, {
      shortcuts: existingBridge.shortcuts,
      app: existingBridge.app,
      gfs: existingBridge.gfs,
      sandboxUi: existingBridge.sandboxUi,
    })
    const actual =
      await vi.importActual<typeof import('@hooks/useAppController')>('@hooks/useAppController')
    const realController: { current: AppController | null } = { current: null }
    vi.mocked(useAppController).mockImplementation(() => {
      realController.current = actual.useAppController()
      return realController.current
    })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <AgentTaskTrackerProvider>
          <App />
        </AgentTaskTrackerProvider>
      </QueryClientProvider>
    )

    await waitFor(() => expect(realController.current?.isAuthenticated).toBe(true))
    await waitFor(() => expect(realController.current?.initialExperienceLoading).toBe(false))
    act(() => {
      realController.current?.handleSelectChatAgent('agent-x', {
        chatId: 'principal-a-chat',
        title: 'Principal A conversation',
        selectLatest: false,
      })
      realController.current?.openFilesSection('gfs://main/0123456789abcdef0123456789abcdef')
    })
    expect(realController.current?.selectedAgent).toBe('agent-x')
    expect(realController.current?.workspaceTabs.tabs.some(tab => tab.kind === 'files')).toBe(true)

    handle.getSessionState
      .mockResolvedValueOnce({ authenticated: false, me: null })
      .mockResolvedValueOnce({
        authenticated: true,
        me: {
          ...HARNESS_ME,
          id: 'user-b',
          email: 'user-b@example.test',
          teamId: 'team-b',
          teamName: 'Team B',
        },
      })
    await act(async () => realController.current?.loadSession())
    await waitFor(() => expect(realController.current?.isAuthenticated).toBe(false))
    await waitFor(() => {
      const state = realController.current?.workspaceTabs
      expect(state?.tabs).toHaveLength(1)
      expect(state?.tabs[0]).toMatchObject({ kind: 'chat', chat: { chatId: null } })
    })
    expect.soft(activeWorkspaceTab(realController.current!.workspaceTabs)?.kind).toBe('chat')
    expect
      .soft(
        activeWorkspaceTab(realController.current!.workspaceTabs)?.kind === 'chat'
          ? activeWorkspaceTab(realController.current!.workspaceTabs)?.chat?.agentRef
          : undefined
      )
      .toBeNull()

    await act(async () => realController.current?.loadSession())
    await waitFor(() => expect(realController.current?.currentTeamId).toBe('team-b'))
    await waitFor(() => expect(realController.current?.initialExperienceLoading).toBe(false))

    expect(realController.current?.workspaceTabs.tabs).toHaveLength(1)
    expect(realController.current?.workspaceTabs.tabs[0]).toMatchObject({
      kind: 'chat',
      chat: { chatId: null },
    })
    const activeBTab = activeWorkspaceTab(realController.current!.workspaceTabs)
    expect.soft(activeBTab?.kind === 'chat' ? activeBTab.chat?.agentRef : undefined).toBeNull()
    expect.soft(realController.current?.selectedAgent).toBeNull()
  })

  it('routes same-agent New Chat drafts through the active workspace tab', async () => {
    const existingBridge = window.clerum
    const { clerum } = installAppControllerClerum({ agentNames: ['agent-x'] })
    Object.assign(clerum, {
      shortcuts: existingBridge.shortcuts,
      app: existingBridge.app,
      gfs: existingBridge.gfs,
      sandboxUi: existingBridge.sandboxUi,
    })
    const actual =
      await vi.importActual<typeof import('@hooks/useAppController')>('@hooks/useAppController')
    const realController: { current: AppController | null } = { current: null }
    vi.mocked(useAppController).mockImplementation(() => {
      realController.current = actual.useAppController()
      return realController.current
    })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <AgentTaskTrackerProvider>
          <App />
        </AgentTaskTrackerProvider>
      </QueryClientProvider>
    )

    await waitFor(() => expect(realController.current?.isAuthenticated).toBe(true))
    await waitFor(() => expect(realController.current?.initialExperienceLoading).toBe(false))
    await act(async () => {
      realController.current?.handleSelectChatAgent('agent-x', { selectLatest: false })
    })
    await waitFor(() =>
      expect(activeWorkspaceTab(realController.current!.workspaceTabs)?.kind).toBe('chat')
    )
    const tabA = activeWorkspaceTab(realController.current!.workspaceTabs)
    if (!tabA || tabA.kind !== 'chat') throw new Error('the controller did not create New Chat A')

    const composer = screen.getByTestId('chat-page-surface') as HTMLTextAreaElement
    expect(composer.dataset.workspaceChatTabId).toBe(tabA.id)
    fireEvent.change(composer, { target: { value: 'draft owned by A' } })
    expect(composer.value).toBe('draft owned by A')

    act(() => realController.current?.openFilesSection(null))
    await act(async () => {
      realController.current?.handleSelectChatAgent('agent-x', { selectLatest: false })
    })
    const tabB = activeWorkspaceTab(realController.current!.workspaceTabs)
    if (!tabB || tabB.kind !== 'chat' || tabB.id === tabA.id) {
      throw new Error('the controller did not create a second same-agent New Chat tab')
    }
    await waitFor(() =>
      expect(
        (screen.getByTestId('chat-page-surface') as HTMLTextAreaElement).dataset.workspaceChatTabId
      ).toBe(tabB.id)
    )

    const composerB = screen.getByTestId('chat-page-surface') as HTMLTextAreaElement
    expect.soft(composerB.value).toBe('')
    fireEvent.change(composerB, { target: { value: 'draft owned by B' } })
    expect(composerB.value).toBe('draft owned by B')

    act(() => realController.current?.selectWorkspaceTabById(tabA.id))
    expect((screen.getByTestId('chat-page-surface') as HTMLTextAreaElement).value).toBe(
      'draft owned by A'
    )
    act(() => realController.current?.selectWorkspaceTabById(tabB.id))
    expect
      .soft((screen.getByTestId('chat-page-surface') as HTMLTextAreaElement).value)
      .toBe('draft owned by B')
  })

  it('closes the active embed before switching teams for a failed cross-team handoff', async () => {
    let viewLiveAtSwitch: unknown = 'not switched'
    const ensureTeamContext = vi.fn(async (): Promise<boolean> => {
      if (viewLiveAtSwitch === 'not switched') viewLiveAtSwitch = main.live()
      return true
    })
    currentController = makeController({
      initialExperienceLoading: false,
      navItem: DESKTOP_ROUTES.apps,
      handleEnsureTeamContext: ensureTeamContext,
    })
    render(<App />)
    await waitFor(() => expect(sandboxUiPageHarness.props).not.toBeNull())

    await launchLiveApp({ appRef: 'ns/current', label: 'Current App', defaultPath: '/' })
    await waitForMounted()
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/missing', teamId: 'team-b' })
    })
    await confirmPendingAppLink()

    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(1))
    expect(closeSandboxUi).toHaveBeenCalledOnce()
    expect(closeSandboxUi).toHaveBeenCalledWith({ launchId: main.openCall(0).launchId })
    // The team switch waited for main to release the view, not just for the close.
    expect(viewLiveAtSwitch).toBeNull()
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

    await waitForAppOpen()
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

    await waitForAppOpen()
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
    const held = main.holdNextOpen()
    await confirmPendingAppLink()

    await waitForAppOpen()
    await act(async () => {
      await new Promise(resolve => window.setTimeout(resolve, 0))
    })
    expect(acknowledgeDeepLink).not.toHaveBeenCalled()

    await act(async () => held().resolve())

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
    await waitForAppOpen()

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
    expect(ensureTeamContext).toHaveBeenCalledWith({
      teamId: 'team-b',
      announce: true,
    })
    expect(ensureTeamContext).not.toHaveBeenCalledWith({
      teamId: 'team-a',
      announce: true,
    })

    await act(async () => {
      vi.advanceTimersByTime(1_000)
      await Promise.resolve()
    })
    await waitFor(() => expect(currentController.pushToast).toHaveBeenCalledTimes(2))
    expect(liveTeamId).toBe('team-b')
    expect(ensureTeamContext.mock.calls.every(([request]) => request.teamId === 'team-b')).toBe(
      true
    )

    ready = true
    await act(async () => {
      vi.advanceTimersByTime(2_000)
      await Promise.resolve()
    })
    await waitForAppOpen()

    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(1))
    expect(liveTeamId).toBe('team-b')
    expect(ensureTeamContext.mock.calls.every(([request]) => request.teamId === 'team-b')).toBe(
      true
    )
  })

  it('defers a cross-team link whose open mounts and then fails, with its error', async () => {
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
    main.failNextOpenAfterMount(new Error('attach failed'))
    await confirmPendingAppLink()
    await waitForAppOpen()

    await waitFor(() => {
      expect(currentController.pushToast).toHaveBeenCalledWith('attach failed', 'error')
    })
    await act(async () => {
      await main.settle()
    })
    expect(main.reported('sandboxUi:released')).toEqual([
      expect.objectContaining({ reason: 'open_failed' }),
    ])
    expect(acknowledgeDeepLink).not.toHaveBeenCalled()
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
    currentController.handleSelectChatAgent('alpha', {
      chatId: 'origin-chat',
      title: 'Origin conversation',
    })
    currentController.openFilesSection('gfs://main/0123456789abcdef0123456789abcdef')
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
    const originWorkspace = currentController.workspaceTabs
    const originAgent = currentController.selectedAgent

    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/app', teamId: 'team-b' })
    })
    main.failNextOpen(new Error('native mount failed'))
    await confirmPendingAppLink()
    await waitForAppOpen()

    await waitFor(() => {
      expect(currentController.pushToast).toHaveBeenCalledWith('native mount failed', 'error')
    })
    expect(liveTeamId).toBe('team-b')
    expect(currentController.workspaceTabs.tabs).toEqual(
      expect.arrayContaining(originWorkspace.tabs)
    )
    expect(activeWorkspaceTab(currentController.workspaceTabs)?.kind).toBe('app')
    expect(activeWorkspaceTab(currentController.workspaceTabs)?.app?.appRef).toBe('ns/app')
    expect(currentController.selectedAgent).toBe(originAgent)
    expect(ensureTeamContext).toHaveBeenNthCalledWith(1, { teamId: 'team-b', announce: true })
    expect(ensureTeamContext).not.toHaveBeenCalledWith({
      teamId: 'team-a',
      announce: true,
    })
    expect(acknowledgeDeepLink).not.toHaveBeenCalled()

    await act(async () => {
      vi.advanceTimersByTime(1_000)
      await Promise.resolve()
    })
    await waitForAppOpen(2)

    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(1))
    expect(acknowledgeDeepLink).toHaveBeenCalledTimes(1)
    expect(liveTeamId).toBe('team-b')
    expect(currentController.workspaceTabs).not.toEqual(originWorkspace)
    expect(ensureTeamContext.mock.calls.every(([request]) => request.teamId === 'team-b')).toBe(
      true
    )
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
    main.failNextOpen(new Error('native mount failed'))
    await confirmPendingAppLink()
    await waitForAppOpen()

    await waitFor(() => {
      expect(currentController.pushToast).toHaveBeenCalledWith('native mount failed', 'error')
    })
    expect(liveTeamId).toBe('team-b')
    expect(ensureTeamContext).toHaveBeenCalledTimes(1)

    const workspaceBeforeManualSwitch = currentController.workspaceTabs
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
    // A later same-principal team switch preserves the workspace that was
    // current when the user made that switch; it does not roll back to the
    // link's older origin after the retry detects the team mismatch.
    expect(currentController.workspaceTabs).toEqual(workspaceBeforeManualSwitch)
    expect(currentController.navItem).toBe(DESKTOP_ROUTES.apps)
    expect(acknowledgeDeepLink).not.toHaveBeenCalled()

    await act(async () => {
      vi.advanceTimersByTime(60_000)
      await Promise.resolve()
    })
    expect(liveTeamId).toBe('team-c')
    expect(ensureTeamContext).toHaveBeenCalledTimes(1)
    expect(acknowledgeDeepLink).not.toHaveBeenCalled()
  })

  it('preserves newer explicit navigation when a cross-team app mount fails', async () => {
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
    listApps.mockResolvedValue({ apps: [READY_APP, READY_APP_B] })
    render(<App />)
    await launchAppFromSidebar('ns/app-b')
    getSandboxUiLocation.mockResolvedValue({ appRef: 'ns/app-b', routePath: '/origin/live' })
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    const heldTargetOpen = main.holdNextOpen()
    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/app', teamId: 'team-b' })
    })
    await confirmPendingAppLink()
    await waitForAppOpen(2)
    act(() => {
      sidebarHarness.props?.onSelect?.(DESKTOP_ROUTES.settings)
    })
    await act(async () => heldTargetOpen().reject(new Error('native mount failed')))

    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(1))
    expect(liveTeamId).toBe('team-b')
    expect(currentController.navItem).toBe(DESKTOP_ROUTES.settings)
    expect(currentController.workspaceTabs.tabs.some(tab => tab.kind === 'settings')).toBe(true)
    expect(main.live()).toBeNull()
    expect(ensureTeamContext).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(1_000)
      await Promise.resolve()
    })
    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(1))
    expect(acknowledgeDeepLink).toHaveBeenCalledOnce()
    expect(liveTeamId).toBe('team-b')
    expect(currentController.navItem).toBe(DESKTOP_ROUTES.settings)
    expect(ensureTeamContext).toHaveBeenCalledTimes(1)
  })

  it('keeps a real newer workspace tab selected when an older app-link catalog request fails', async () => {
    const existingBridge = window.clerum
    let activeTeamId = 'team-a'
    const { clerum } = installAppControllerClerum({
      me: { teamId: 'team-a', teamName: 'Team A' },
      teamDirectory: { items: [], currentTeamId: 'team-a' },
    })
    Object.assign(clerum, {
      shortcuts: existingBridge.shortcuts,
      app: existingBridge.app,
      gfs: existingBridge.gfs,
      sandboxUi: existingBridge.sandboxUi,
    })
    Object.assign(window.clerum.team, {
      switch: vi.fn(async (teamId: string) => {
        activeTeamId = teamId
        return {
          authenticated: true,
          me: {
            ...HARNESS_ME,
            teamId,
            teamName: teamId === 'team-a' ? 'Team A' : 'Team B',
          },
        }
      }),
    })
    const actual =
      await vi.importActual<typeof import('@hooks/useAppController')>('@hooks/useAppController')
    const realController: { current: AppController | null } = { current: null }
    const restoreRequests: number[] = []
    vi.mocked(useAppController).mockImplementation(() => {
      realController.current = actual.useAppController()
      const restoreWorkspaceNavigation = realController.current.restoreWorkspaceNavigation
      realController.current.restoreWorkspaceNavigation = (snapshot, expectedIntentSequence) => {
        restoreRequests.push(expectedIntentSequence)
        return restoreWorkspaceNavigation(snapshot, expectedIntentSequence)
      }
      return realController.current
    })
    const queue = new SandboxUiDeepLinkQueue()
    acknowledgeDeepLink.mockImplementation(async id => queue.acknowledge(id))
    let rejectTargetApps!: (error: Error) => void
    const pendingTargetApps = new Promise<{ apps: (typeof READY_APP)[] }>((_, reject) => {
      rejectTargetApps = reject
    })
    let targetTeamAppListCalls = 0
    listApps.mockImplementation(async () => {
      if (activeTeamId === 'team-b') {
        targetTeamAppListCalls += 1
        return pendingTargetApps
      }
      return { apps: [READY_APP] }
    })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <AgentTaskTrackerProvider>
          <App />
        </AgentTaskTrackerProvider>
      </QueryClientProvider>
    )

    await waitFor(() => expect(realController.current?.isAuthenticated).toBe(true))
    await waitFor(() => expect(realController.current?.initialExperienceLoading).toBe(false))
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    const target = parseSandboxUiDeepLink(
      buildSandboxUiDeepLink({ recipeNs: 'ns', recipeName: 'app', teamId: 'team-b' })
    )
    if (!target) throw new Error('The production app-link parser rejected the fixture URL')
    const link = queue.enqueue(target)
    act(() => emitDeepLink?.(link))
    await confirmPendingAppLink()
    await waitFor(() => expect(realController.current?.currentTeamId).toBe('team-b'))
    await waitFor(() => expect(targetTeamAppListCalls).toBeGreaterThan(0))

    act(() => realController.current?.handleNavSelect(DESKTOP_ROUTES.settings))
    expect(realController.current?.navItem).toBe(DESKTOP_ROUTES.settings)
    await act(async () => rejectTargetApps(new Error('target catalog request failed')))

    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(link.id))
    expect(realController.current?.currentTeamId).toBe('team-b')
    expect(realController.current?.navItem).toBe(DESKTOP_ROUTES.settings)
    expect(activeWorkspaceTab(realController.current!.workspaceTabs)?.kind).toBe('settings')
    expect(restoreRequests).toEqual([])
    expect(openSandboxUi).not.toHaveBeenCalled()
    expect(main.live()).toBeNull()
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
    await waitForAppOpen()

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
    main.failNextOpen(new Error('native mount failed'))
    await confirmPendingAppLink()
    await waitForAppOpen()

    expect(acknowledgeDeepLink).not.toHaveBeenCalledWith(1)

    act(() => {
      emitDeepLink?.({ id: 2, appRef: 'ns/next' })
    })
    await confirmPendingAppLink()
    await waitForAppOpen(2)

    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(2))
    expect(acknowledgeDeepLink).not.toHaveBeenCalledWith(1)
  })

  // ── the route an app tab is left on, and deep links left before mounting ──

  const READY_APP = {
    appRef: 'ns/app',
    title: 'Linked App',
    defaultPath: '/',
    ready: true,
    phase: 'active',
  }

  const READY_APP_B = {
    ...READY_APP,
    appRef: 'ns/app-b',
    title: 'Second linked app',
  }

  const appTabs = () => currentController.workspaceTabs.tabs.filter(tab => tab.kind === 'app')

  // Launch an app straight through the sidebar (`onOpenSandboxUiApp`), the same
  // path the real app-picker uses — no deep-link confirm ceremony.
  async function launchAppFromSidebar(appRef = 'ns/app'): Promise<void> {
    const app = await waitFor(() => {
      const available = sidebarHarness.props?.availableSandboxUiApps?.find(a => a.appRef === appRef)
      if (!available) throw new Error(`${appRef} was not available to the sidebar`)
      return available
    })
    const opens = openSandboxUi.mock.calls.length
    await act(async () => {
      sidebarHarness.props?.onOpenSandboxUiApp?.(app)
      await Promise.resolve()
    })
    await waitFor(() => expect(openSandboxUi).toHaveBeenCalledTimes(opens + 1), {
      timeout: 5_000,
    })
    await waitFor(() => expect(embedPhase()).toBe('mounted'), { timeout: 5_000 })
  }

  async function selectTab(index: 0 | 1 | 2): Promise<void> {
    await waitFor(() => expect(emitCommand).not.toBeNull())
    await act(async () => {
      emitCommand?.(`tabs.select${index + 1}` as DesktopCommandId)
      await new Promise(resolve => window.setTimeout(resolve, 0))
    })
  }

  it('restores the route an app tab was left on when it is reactivated', async () => {
    currentController = makeController({ initialExperienceLoading: false })
    listApps.mockResolvedValue({ apps: [READY_APP] })
    render(<App />)
    await launchAppFromSidebar()
    // Launched at the default route.
    expect(main.openCall(0).routePath).toBeUndefined()

    main.navigate('/tickets/42')
    await selectTab(0)
    await waitFor(() => expect(appTabs()[0]?.app?.savedRoutePath).toBe('/tickets/42'))
    expect(closeSandboxUi).toHaveBeenCalledTimes(1)

    await selectTab(1)
    await waitFor(() => expect(openSandboxUi).toHaveBeenCalledTimes(2))
    expect(main.openCall(1).routePath).toBe('/tickets/42')
  })

  it('preserves the live app route when an unavailable cross-team link restores the origin workspace', async () => {
    currentController = makeController({
      initialExperienceLoading: false,
      selectedAgent: 'alpha',
      selectedAgentRoute: 'mcp-servers',
    } as Partial<AppController>)
    listApps.mockImplementation(async () =>
      currentController.getCurrentTeamId() === 'team-a' ? { apps: [READY_APP] } : { apps: [] }
    )
    render(<App />)
    await launchAppFromSidebar()

    const originWorkspace = currentController.workspaceTabs
    const appTab = activeWorkspaceTab(originWorkspace)
    expect(appTab?.kind).toBe('app')
    if (appTab?.kind !== 'app') throw new Error('The app picker did not create an app tab')

    // The embed reports this current route as it is closed for the cross-team
    // handoff. App persists it through the real workspace tab producer.
    getSandboxUiLocation.mockResolvedValue({ appRef: 'ns/app', routePath: '/tickets/live' })
    main.navigate('/tickets/live')
    closeSandboxUi.mockClear()
    act(() => emitDeepLink?.({ id: 1, appRef: 'ns/missing', teamId: 'team-b' }))
    await confirmPendingAppLink()

    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(1))
    expect(closeSandboxUi).toHaveBeenCalledOnce()
    const expectedWorkspace = setAppTabSavedRoutePath(originWorkspace, appTab.id, '/tickets/live')
    expect(currentController.workspaceTabs).toEqual(expectedWorkspace)
    expect(currentController.workspaceTabs.activeTabId).toBe(appTab.id)
    await waitFor(() => expect(openSandboxUi).toHaveBeenCalledTimes(2))
    await waitForMounted()
    expect(main.live()?.appRef).toBe(appTab.app?.appRef)
    expect(main.live()?.routePath).toBe('/tickets/live')
    expect(currentController.selectedAgent).toBe('alpha')
    expect(currentController.selectedAgentRoute).toBe('mcp-servers')
    expect(currentController.handleEnsureTeamContext).toHaveBeenNthCalledWith(2, {
      teamId: 'team-a',
      announce: true,
    })
  })

  it('does not restore or relaunch an origin app when team rollback fails', async () => {
    let liveTeamId = 'team-a'
    const existingBridge = window.clerum
    const { clerum } = installAppControllerClerum({
      me: { teamId: 'team-a', teamName: 'Team A' },
      teamDirectory: { items: [], currentTeamId: 'team-a' },
    })
    Object.assign(clerum, {
      shortcuts: existingBridge.shortcuts,
      app: existingBridge.app,
      gfs: existingBridge.gfs,
      sandboxUi: existingBridge.sandboxUi,
    })
    const switchTeam = vi.fn(async (teamId: string) => {
      if (teamId === 'team-a' && liveTeamId === 'team-b') {
        throw new Error('origin team is unavailable')
      }
      liveTeamId = teamId
      return {
        authenticated: true,
        me: {
          ...HARNESS_ME,
          teamId,
          teamName: teamId === 'team-a' ? 'Team A' : 'Team B',
        },
      }
    })
    Object.assign(window.clerum.team, { switch: switchTeam })
    const actual =
      await vi.importActual<typeof import('@hooks/useAppController')>('@hooks/useAppController')
    const realController: { current: AppController | null } = { current: null }
    vi.mocked(useAppController).mockImplementation(() => {
      realController.current = actual.useAppController()
      return realController.current
    })
    listApps.mockImplementation(async () =>
      liveTeamId === 'team-a' ? { apps: [READY_APP] } : { apps: [] }
    )
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <AgentTaskTrackerProvider>
          <App />
        </AgentTaskTrackerProvider>
      </QueryClientProvider>
    )
    await waitFor(() => expect(realController.current?.isAuthenticated).toBe(true))
    await waitFor(() => expect(realController.current?.initialExperienceLoading).toBe(false))
    await launchAppFromSidebar()
    const originWorkspace = realController.current!.workspaceTabs
    expect(activeWorkspaceTab(originWorkspace)?.kind).toBe('app')
    expect(main.live()?.appRef).toBe('ns/app')

    act(() => emitDeepLink?.({ id: 1, appRef: 'ns/missing', teamId: 'team-b' }))
    await confirmPendingAppLink()
    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(1))

    expect.soft(liveTeamId).toBe('team-b')
    expect.soft(realController.current?.currentTeamId).toBe('team-b')
    expect
      .soft(sidebarHarness.props?.availableSandboxUiApps)
      .not.toContainEqual(expect.objectContaining({ appRef: 'ns/app' }))
    expect.soft(openSandboxUi).toHaveBeenCalledTimes(1)
    expect.soft(main.live()).toBeNull()
  })

  it('preserves the live app after an unavailable same-team link', async () => {
    listApps.mockResolvedValue({ apps: [READY_APP] })
    currentController = makeController({ initialExperienceLoading: false })
    render(<App />)
    await launchAppFromSidebar()

    // Drive a non-default route through the same native-location producer App
    // reads when the real embed is deactivated, then remount that owning tab.
    getSandboxUiLocation.mockResolvedValue({ appRef: 'ns/app', routePath: '/tickets/live' })
    main.navigate('/tickets/live')
    await selectTab(0)
    await waitFor(() => expect(appTabs()[0]?.app?.savedRoutePath).toBe('/tickets/live'))
    await selectTab(1)
    await waitFor(() => expect(openSandboxUi).toHaveBeenCalledTimes(2))
    await waitForMounted()
    await waitFor(() => expect(main.live()?.routePath).toBe('/tickets/live'))

    const originWorkspace = currentController.workspaceTabs
    const originTab = activeWorkspaceTab(originWorkspace)
    expect(originTab?.kind).toBe('app')
    if (originTab?.kind !== 'app') throw new Error('The app picker did not create an app tab')
    const originLiveView = main.live()
    expect(originLiveView?.appRef).toBe('ns/app')
    expect(originLiveView?.routePath).toBe('/tickets/live')

    closeSandboxUi.mockClear()
    getSandboxUiLocation.mockClear()
    act(() => emitDeepLink?.({ id: 1, appRef: 'ns/missing', teamId: 'team-a' }))
    await confirmPendingAppLink()

    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(1))
    expect(currentController.pushToast).toHaveBeenCalledWith(
      "Could not open app link: You don't have access to this app in the linked team",
      'error'
    )
    expect(main.live()).toEqual(originLiveView)
    expect(currentController.workspaceTabs).toEqual(originWorkspace)
    expect(closeSandboxUi).not.toHaveBeenCalled()
    expect(getSandboxUiLocation).not.toHaveBeenCalled()
  })

  it('does not relaunch an app tab after a cross-team link finds no active embed to close', async () => {
    let liveTeamId = 'team-a'
    const ensureTeamContext = vi.fn(async ({ teamId }: { teamId?: string }) => {
      if (!teamId || teamId === liveTeamId) return false
      liveTeamId = teamId
      return true
    })
    listApps.mockImplementation(async () =>
      liveTeamId === 'team-a' ? { apps: [READY_APP] } : { apps: [] }
    )
    currentController = makeController({
      initialExperienceLoading: false,
      handleEnsureTeamContext: ensureTeamContext,
      getCurrentTeamId: () => liveTeamId,
    })
    render(<App />)
    await launchAppFromSidebar()

    // Persist a non-default route through App's normal tab-deactivation reader
    // before the native unsolicited-close callback removes the live embed.
    getSandboxUiLocation.mockResolvedValue({ appRef: 'ns/app', routePath: '/tickets/live' })
    main.navigate('/tickets/live')
    await selectTab(0)
    await waitFor(() => expect(appTabs()[0]?.app?.savedRoutePath).toBe('/tickets/live'))
    await selectTab(1)
    await waitFor(() => expect(openSandboxUi).toHaveBeenCalledTimes(2))
    await waitForMounted()
    await waitFor(() => expect(main.live()?.routePath).toBe('/tickets/live'))

    const originWorkspace = currentController.workspaceTabs
    const originTab = activeWorkspaceTab(originWorkspace)
    expect(originTab?.kind).toBe('app')
    if (originTab?.kind !== 'app') throw new Error('The app picker did not create an app tab')
    expect(originTab.app?.savedRoutePath).toBe('/tickets/live')
    const originRequestId = main.live()?.launchId

    // The native unsolicited-close producer leaves the app tab selected but unmounted.
    await act(async () => main.crash())
    await waitFor(() => expect(embedState().owner).toBeNull())
    expect(main.live()).toBeNull()

    closeSandboxUi.mockClear()
    getSandboxUiLocation.mockClear()
    act(() => emitDeepLink?.({ id: 1, appRef: 'ns/missing', teamId: 'team-b' }))
    await confirmPendingAppLink()

    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(1))
    expect(currentController.pushToast).toHaveBeenCalledWith(
      "Could not open app link: You don't have access to this app in the linked team",
      'error'
    )
    expect(liveTeamId).toBe('team-a')
    expect(currentController.workspaceTabs.activeTabId).toBe(originTab.id)
    expect(currentController.workspaceTabs.tabs).toContainEqual(originTab)
    expect(currentController.workspaceTabs).toEqual(originWorkspace)
    expect(main.live()).toBeNull()
    expect(originRequestId).toBeDefined()
    expect(closeSandboxUi).not.toHaveBeenCalled()
    expect(getSandboxUiLocation).not.toHaveBeenCalled()
    expect(ensureTeamContext).toHaveBeenCalledTimes(2)
  })

  it('preserves the live origin app when native close rejects before a cross-team handoff', async () => {
    const ensureTeamContext = vi.fn(async () => false)
    listApps.mockResolvedValue({ apps: [READY_APP] })
    currentController = makeController({
      initialExperienceLoading: false,
      handleEnsureTeamContext: ensureTeamContext,
    })
    render(<App />)
    await launchAppFromSidebar()

    // Drive a live route through App's tab-deactivation reader and restore the
    // same embed before the native close bridge rejects its handoff request.
    getSandboxUiLocation.mockResolvedValue({ appRef: 'ns/app', routePath: '/tickets/live' })
    main.navigate('/tickets/live')
    await selectTab(0)
    await waitFor(() => expect(appTabs()[0]?.app?.savedRoutePath).toBe('/tickets/live'))
    await selectTab(1)
    await waitFor(() => expect(openSandboxUi).toHaveBeenCalledTimes(2))
    await waitForMounted()
    await waitFor(() => expect(main.live()?.routePath).toBe('/tickets/live'))

    const originWorkspace = currentController.workspaceTabs
    const originLiveView = main.live()
    expect(originLiveView?.appRef).toBe('ns/app')
    expect(originLiveView?.launchId).toBeDefined()

    closeSandboxUi.mockRejectedValue(new Error('native close rejected'))
    closeSandboxUi.mockClear()
    getSandboxUiLocation.mockClear()
    ensureTeamContext.mockClear()
    listApps.mockClear()
    act(() => emitDeepLink?.({ id: 1, appRef: 'ns/missing', teamId: 'team-b' }))
    await confirmPendingAppLink()

    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(1))
    expect(closeSandboxUi).toHaveBeenCalledOnce()
    expect(getSandboxUiLocation).not.toHaveBeenCalled()
    expect(ensureTeamContext).not.toHaveBeenCalled()
    expect(listApps).not.toHaveBeenCalled()
    expect(currentController.pushToast).toHaveBeenCalledWith(
      'Could not open app link: the current app could not be safely closed.',
      'error'
    )
    expect(currentController.workspaceTabs).toEqual(originWorkspace)
    expect(activeWorkspaceTab(currentController.workspaceTabs)?.kind).toBe('app')
    expect(activeWorkspaceTab(currentController.workspaceTabs)?.app?.savedRoutePath).toBe(
      '/tickets/live'
    )
    expect(main.live()).toEqual(originLiveView)
  })

  it('keeps two tabs of the same app on their own routes when alternating (§5)', async () => {
    currentController = makeController({ initialExperienceLoading: false })
    listApps.mockResolvedValue({ apps: [READY_APP] })
    render(<App />)

    // Two tabs of the same app: [chat, A, B].
    await launchAppFromSidebar()
    main.navigate('/tickets/A')
    await launchAppFromSidebar() // leaves A (its view reports /tickets/A), opens B
    await waitFor(() => expect(appTabs()).toHaveLength(2))
    await waitFor(() => expect(appTabs()[0]?.app?.savedRoutePath).toBe('/tickets/A'))

    main.navigate('/tickets/B')
    await selectTab(1) // index 1 = A
    await waitFor(() => expect(openSandboxUi).toHaveBeenCalledTimes(3))
    expect(appTabs()[1]?.app?.savedRoutePath).toBe('/tickets/B')
    expect(main.openCall(2).routePath).toBe('/tickets/A')

    await waitForMounted()
    await selectTab(2) // index 2 = B
    await waitFor(() => expect(openSandboxUi).toHaveBeenCalledTimes(4))
    expect(main.openCall(3).routePath).toBe('/tickets/B')
  })

  it('does not close a view main already tore down when its tab is left', async () => {
    currentController = makeController({ initialExperienceLoading: false })
    listApps.mockResolvedValue({ apps: [READY_APP] })
    render(<App />)
    await launchAppFromSidebar()

    await act(() => main.crash())
    await waitFor(() => expect(embedState().failure?.kind).toBe('crashed'))

    await selectTab(0)
    expect(closeSandboxUi).not.toHaveBeenCalled()
    // A crash leaves no route behind: reopening must not land on a crashing page.
    expect(appTabs()[0]?.app?.savedRoutePath).toBeUndefined()
  })

  it('persists the outgoing app route on a deep-link team handoff', async () => {
    const ensureTeamContext = vi.fn(async (): Promise<boolean> => true)
    currentController = makeController({
      initialExperienceLoading: false,
      handleEnsureTeamContext: ensureTeamContext,
    })
    listApps.mockResolvedValue({ apps: [READY_APP] })
    render(<App />)
    await launchAppFromSidebar()
    const outgoingId = appTabs()[0]?.id
    main.navigate('/handoff/route')

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
    expect(closeSandboxUi).toHaveBeenCalledWith({ launchId: main.openCall(0).launchId })
  })

  it('acks a cross-team link left before it mounted without retrying it or switching teams back', async () => {
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
    listApps.mockResolvedValue({ apps: [READY_APP] })
    render(<App />)
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    main.holdNextOpen()
    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/app', teamId: 'team-b' })
    })
    await confirmPendingAppLink()
    await waitForAppOpen()
    expect(liveTeamId).toBe('team-b')

    // The user leaves the link's tab while its view is still opening.
    await selectTab(0)

    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(1))
    expect(ensureTeamContext).toHaveBeenCalledTimes(1)
    expect(liveTeamId).toBe('team-b')
    expect(confirmDialogHarness.props?.title).not.toBe('App link could not be opened')
    expect(currentController.pushToast).not.toHaveBeenCalledWith(
      expect.stringContaining('Could not open app link'),
      'error'
    )
    // No retry: the link is gone and nothing reopens the app later.
    await act(async () => {
      await new Promise(resolve => window.setTimeout(resolve, 50))
    })
    expect(openSandboxUi).toHaveBeenCalledTimes(1)
  })

  it('keeps the user where they navigated when a cross-team link is abandoned', async () => {
    let liveTeamId = 'team-a'
    const ensureTeamContext = vi.fn(async ({ teamId }: { teamId?: string }) => {
      if (!teamId || teamId === liveTeamId) return false
      liveTeamId = teamId
      return true
    })
    currentController = makeController({
      initialExperienceLoading: false,
      navItem: DESKTOP_ROUTES.chat,
      selectedAgent: 'alpha',
      activeChatId: 'chat-1',
      handleEnsureTeamContext: ensureTeamContext,
      getCurrentTeamId: () => liveTeamId,
    } as Partial<AppController>)
    listApps.mockResolvedValue({ apps: [READY_APP] })
    render(<App />)
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    main.holdNextOpen()
    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/app', teamId: 'team-b' })
    })
    await confirmPendingAppLink()
    await waitForAppOpen()
    expect(liveTeamId).toBe('team-b')

    // The user goes to Files while the linked app is still opening.
    act(() => {
      currentController.handleNavSelect(DESKTOP_ROUTES.files)
    })

    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(1))
    await act(async () => {
      await new Promise(resolve => window.setTimeout(resolve, 50))
    })
    expect(liveTeamId).toBe('team-b')
    expect(activeWorkspaceTab(currentController.workspaceTabs)?.kind).toBe('files')
    expect(openSandboxUi).toHaveBeenCalledTimes(1)
  })

  it('stops a deep link waiting on its launch when App unmounts, without acting on it', async () => {
    currentController = makeController({ initialExperienceLoading: false })
    listApps.mockResolvedValue({ apps: [READY_APP] })
    const view = render(<App />)
    await waitFor(() => expect(emitDeepLink).not.toBeNull())

    main.holdNextOpen()
    act(() => {
      emitDeepLink?.({ id: 1, appRef: 'ns/app' })
    })
    await confirmPendingAppLink()
    await waitForAppOpen()

    view.unmount()
    await act(async () => {
      await new Promise(resolve => window.setTimeout(resolve, 0))
    })
    // The pending link stays with main for the next renderer to pick up.
    expect(acknowledgeDeepLink).not.toHaveBeenCalled()
  })
})
