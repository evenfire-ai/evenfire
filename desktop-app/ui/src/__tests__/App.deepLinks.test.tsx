// @vitest-environment jsdom
import { type ReactNode, createElement, useEffect, useLayoutEffect, useReducer } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentTaskTrackerProvider } from '@contexts/AgentTaskTrackerContext'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { buildGfsResourceDeepLink, parseGfsResourceDeepLink } from '@clerum/desktop-app-links'
import type { WorkspaceTabStripProps } from '@components/WorkspaceTabStrip/types'
import { DESKTOP_ROUTES, SIDEBAR_COLLAPSED_KEY } from '@constants/navigation'
import { useAppController } from '@hooks/useAppController'
import {
  getComposerDraft,
  resetComposerDraftStore,
  setComposerDraft,
} from '@lib/composerDraftStore'
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
import type { FilesPageProps } from '@pages/FilesPage.types'
import { App } from '@/App'
import type { GfsResourceDeepLinkEnvelope, SandboxUiDeepLinkEnvelope } from '@/App.types'
import type { DesktopCommandId } from '../../../src/desktopCommands'
import { GfsResourceDeepLinkQueue } from '../../../src/gfsResourceDeepLinkQueue'
import { SandboxUiDeepLinkQueue } from '../../../src/sandboxUiDeepLinkQueue'
import { buildSandboxUiDeepLink, parseSandboxUiDeepLink } from '../../../src/sandboxUiDeepLinks'
import { installAppControllerClerum } from '../hooks/domain/__tests__/__fixtures__/appControllerHarness'
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

// The universal tab store lives inside the controller; the mock reproduces that
// contract — `navItem` is DERIVED from the store, the store is reactive, and nav
// drives it through the real producers (T1). See App.chatDrawer.test for the
// rationale.
let forceControllerRender: () => void = () => {}
type WorkspaceState = ReturnType<typeof useAppController>['workspaceTabs']

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
  },
}))

const sandboxUiPageHarness = vi.hoisted(() => ({
  props: null as null | {
    embed: EmbedOwnershipMachine
    activeAppRef?: string | null
    headerShellOverlayOpen?: boolean
    deepLinkShellOverlayOpen?: boolean
    localSearchRequestId?: number
  },
}))
const filesPageHarness = vi.hoisted(() => ({
  props: null as null | FilesPageProps,
  renderActual: false,
}))
const commonHarness = vi.hoisted(() => ({
  renderActualToastStack: false,
  renderWorkspaceSurfaces: false,
  draftProbe: {
    chatId: null as string | null,
    agentRef: null as string | null,
    tabId: null as string | null,
  },
}))
const workspaceTabStripHarness = vi.hoisted(() => ({
  props: null as null | WorkspaceTabStripProps,
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
vi.mock('@components/Common', async () => {
  const actual = await vi.importActual<typeof import('@components/Common')>('@components/Common')
  return {
    ...actual,
    Button: () => null,
    IconButton: () => null,
    ToastStack: (props: Parameters<typeof actual.ToastStack>[0]) =>
      commonHarness.renderActualToastStack ? createElement(actual.ToastStack, props) : null,
  }
})
vi.mock('@components/WorkspaceTabStrip', () => ({
  WorkspaceTabStrip: (props: WorkspaceTabStripProps) => {
    workspaceTabStripHarness.props = props
    if (!commonHarness.renderWorkspaceSurfaces) return null
    return createElement(
      'div',
      { role: 'toolbar', 'aria-label': 'Workspace tabs' },
      props.tabs.map(tab =>
        createElement(
          'button',
          {
            'aria-pressed': tab.id === props.activeTabId,
            'data-workspace-tab-id': tab.id,
            key: tab.id,
            type: 'button',
          },
          tab.title
        )
      )
    )
  },
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
vi.mock('@pages/AuthPage', () => ({
  AuthPage: () => (commonHarness.renderWorkspaceSurfaces ? <div data-testid="auth-page" /> : null),
}))
vi.mock('@pages/ChatPage', async () => {
  const { getComposerDraft } =
    await vi.importActual<typeof import('@lib/composerDraftStore')>('@lib/composerDraftStore')
  return {
    ChatPage: () => {
      if (!commonHarness.renderWorkspaceSurfaces) return null
      const { chatId, agentRef, tabId } = commonHarness.draftProbe
      const draft = chatId ? getComposerDraft(chatId, agentRef ?? undefined, tabId) : ''
      return (
        <div data-testid="chat-page-pane">
          <textarea aria-label="Draft in App pane" readOnly value={draft} />
        </div>
      )
    },
  }
})
vi.mock('@pages/FilesPage', async () => {
  const actual = await vi.importActual<typeof import('@pages/FilesPage')>('@pages/FilesPage')
  return {
    FilesPage: (props: FilesPageProps) => {
      filesPageHarness.props = props
      if (filesPageHarness.renderActual) return createElement(actual.FilesPage, props)
      if (commonHarness.renderWorkspaceSurfaces) return <div data-testid="files-page-pane" />
      return null
    },
  }
})
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
    return commonHarness.renderWorkspaceSurfaces ? <div data-testid="settings-page-pane" /> : null
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
  let navigationIntentSequence = 0
  const beginNavigationIntent = () => {
    navigationIntentSequence += 1
    controller.navigationIntentSequence = navigationIntentSequence
    return navigationIntentSequence
  }
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
      if (userNavigationGenerationAtActivation !== 0) return null
      const intentSequence = beginNavigationIntent()
      const owner = assignGfsResourceNavigationOwner(controller.workspaceTabs, uri)
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
        intentSequence: navigationIntentSequence,
        principalGeneration,
        userNavigationGeneration: 0,
        activeTabId: controller.workspaceTabs.activeTabId,
        tabs: controller.workspaceTabs.tabs,
      })
  )
  const activateGfsResourceNavigation = vi.fn(
    (request: GfsResourceNavigationRequest, principalGeneration: number) => {
      if (
        request.intentSequence !== navigationIntentSequence ||
        request.principalGeneration !== principalGeneration ||
        request.userNavigationGenerationAtActivation !== 0
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
  // Faithful nav: a store action; `navItem` is derived (useReactiveController).
  const handleNavSelect = vi.fn((item: AppController['navItem']) => {
    beginNavigationIntent()
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
    (
      agentName: string,
      options: {
        chatId?: string
        keepNavItem?: boolean
        navigationIntentAlreadyStarted?: boolean
      } = {}
    ) => {
      if (!options.keepNavItem && !options.navigationIntentAlreadyStarted) beginNavigationIntent()
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
    navigationIntentSequence,
    beginUserNavigationIntent: vi.fn(beginNavigationIntent),
    isNavigationIntentCurrent: vi.fn(sequence => sequence === navigationIntentSequence),
    captureWorkspaceNavigation: vi.fn(() => ({
      workspaceTabs: controller.workspaceTabs,
      selectedAgent: controller.selectedAgent,
      selectedAgentRoute: controller.selectedAgentRoute,
      appsPickerActive: controller.appsPickerActive,
      lastActiveChatTabId:
        activeWorkspaceTab(controller.workspaceTabs)?.kind === 'chat'
          ? (activeWorkspaceTab(controller.workspaceTabs)?.id ?? null)
          : null,
    })),
    restoreWorkspaceNavigation: vi.fn((snapshot, expectedIntentSequence) => {
      if (expectedIntentSequence !== navigationIntentSequence) return null
      const restoredIntent = beginNavigationIntent()
      controller.workspaceTabs = snapshot.workspaceTabs
      controller.selectedAgent = snapshot.selectedAgent
      controller.selectedAgentRoute = snapshot.selectedAgentRoute
      controller.appsPickerActive = snapshot.appsPickerActive
      forceControllerRender()
      return restoredIntent
    }),
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
    beginGfsResourceNavigation,
    isGfsResourceNavigationCurrent,
    activateGfsResourceNavigation,
    completeGfsResourceNavigationPreview,
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
  let realController: AppController | null = null
  let unmountRealApp: (() => void) | null = null
  let emitDeepLink: ((link: SandboxUiDeepLinkEnvelope) => void) | null
  let emitGfsDeepLink: ((link: GfsResourceDeepLinkEnvelope) => void) | null
  let emitCommand: ((commandId: DesktopCommandId, source?: 'host' | 'sandbox') => void) | null
  const clearPendingDeepLinks = vi.fn().mockResolvedValue(undefined)
  const acknowledgeDeepLink = vi.fn().mockResolvedValue(undefined)
  const listApps = vi.fn().mockResolvedValue({ apps: [] })
  const listPendingDeepLinks = vi.fn().mockResolvedValue({ links: [] })
  let gfsQueue = new GfsResourceDeepLinkQueue()
  const clearPendingGfsDeepLinks = vi.fn(async () => gfsQueue.clear())
  const acknowledgeGfsDeepLink = vi.fn(async (id: number) => gfsQueue.acknowledge(id))
  const listPendingGfsDeepLinks = vi.fn(async () => ({ links: gfsQueue.list() }))
  let main: SandboxUiMainFake
  const closeSandboxUi = () => main.bridge.close
  const openSandboxUi = () => main.bridge.open

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
    confirmDialogHarness.props = null
    confirmDialogHarness.mountedCount = 0
    appHeaderHarness.props = null
    chatLocalSearchHarness.rendered.mockReset()
    commandPaletteHarness.props = null
    settingsPageHarness.props = null
    sandboxUiPageHarness.props = null
    filesPageHarness.props = null
    filesPageHarness.renderActual = false
    commonHarness.renderActualToastStack = false
    commonHarness.renderWorkspaceSurfaces = false
    commonHarness.draftProbe = { chatId: null, agentRef: null, tabId: null }
    workspaceTabStripHarness.props = null
    sidebarHarness.props = null
    acknowledgeDeepLink.mockResolvedValue(undefined)
    listApps.mockResolvedValue({ apps: [] })
    listPendingDeepLinks.mockResolvedValue({ links: [] })
    gfsQueue = new GfsResourceDeepLinkQueue()
    clearPendingGfsDeepLinks.mockClear()
    clearPendingGfsDeepLinks.mockImplementation(async () => gfsQueue.clear())
    acknowledgeGfsDeepLink.mockClear()
    acknowledgeGfsDeepLink.mockImplementation(async id => gfsQueue.acknowledge(id))
    listPendingGfsDeepLinks.mockClear()
    listPendingGfsDeepLinks.mockImplementation(async () => ({ links: gfsQueue.list() }))
    main = createSandboxUiMainFake()
    emitDeepLink = null
    emitGfsDeepLink = null
    emitCommand = null
    currentController = makeController()
    realController = null
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
    expect(currentController.handleSelectChatAgent).toHaveBeenCalledWith(
      'alpha',
      expect.objectContaining({
        selectLatest: false,
        navigationIntentAlreadyStarted: true,
      })
    )

    act(() => emitCommand?.('composer.focus'))
    expect(currentController.handleSelectChatAgent).toHaveBeenLastCalledWith('alpha', {
      selectLatest: false,
    })
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
    await waitFor(() => expect(openSandboxUi()).toHaveBeenCalledTimes(1))

    // Still opening: nothing to search yet.
    act(() => emitCommand?.('search.current'))
    expect(sandboxUiPageHarness.props?.localSearchRequestId).toBe(0)
    await act(async () => held().resolve())
    await waitForMounted()
    act(() => emitCommand?.('search.current'))
    expect(sandboxUiPageHarness.props?.localSearchRequestId).toBe(1)
    expect(appHeaderHarness.props?.searchFocusRequestId).toBe(0)

    await launchLiveApp({ appRef: 'ns/replacement', label: 'Replacement app', defaultPath: '/' })
    await waitFor(() => expect(openSandboxUi()).toHaveBeenCalledTimes(2))
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
    await waitFor(() => expect(openSandboxUi()).toHaveBeenCalledTimes(1))
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
    expect(openSandboxUi()).toHaveBeenCalledTimes(1)
    expect(closeSandboxUi()).not.toHaveBeenCalled()

    act(() => emitCommand?.('commands.open'))
    await act(async () => commandPaletteHarness.props?.onExecute('app.backToApps'))
    await waitFor(() => expect(embedState().owner).toBeNull())
    expect(closeSandboxUi()).toHaveBeenLastCalledWith({ launchId: first })
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

  async function cleanupAppDeepLinkSuite(): Promise<void> {
    cleanup()
    unmountRealApp = null
    const bodyChildElementCount = document.body.childElementCount
    vi.useRealTimers()
    resetComposerDraftStore()
    await main.dispose()
    expect(bodyChildElementCount, 'App deep-link suite body-empty postcondition').toBe(0)
  }

  afterEach(cleanupAppDeepLinkSuite)

  // The deep link's launch reached main (`times` opens so far). Main mounts it
  // unless the test told the fake to hold or fail that open.
  async function waitForAppOpen(times = 1): Promise<void> {
    await waitFor(() => expect(openSandboxUi()).toHaveBeenCalledTimes(times))
  }

  async function confirmPendingAppLink(): Promise<void> {
    await waitFor(() => expect(confirmDialogHarness.props?.title).toBe('Open app link?'))
    await act(async () => {
      confirmDialogHarness.props?.onConfirm()
      await Promise.resolve()
    })
  }

  function produceGfsResourceDeepLink(uri: string): GfsResourceDeepLinkEnvelope {
    const target = parseGfsResourceDeepLink(buildGfsResourceDeepLink(uri))
    if (!target) throw new Error('The shared producer rejected the GFS resource URI fixture')
    return gfsQueue.enqueue(target, 0)
  }

  it('routes a shared GFS producer link to Files and acknowledges its resolved owner', async () => {
    currentController = makeController({ initialExperienceLoading: false })
    render(<App />)
    await waitFor(() => expect(emitGfsDeepLink).not.toBeNull())
    await waitFor(() => expect(listPendingGfsDeepLinks).toHaveBeenCalled())

    const uri = 'gfs://main/0123456789abcdef0123456789abcdef'
    const link = produceGfsResourceDeepLink(uri)
    act(() => emitGfsDeepLink?.(link))

    await waitFor(() =>
      expect(filesPageHarness.props?.pendingGfsDeepLink).toEqual({ id: link.id, uri })
    )
    expect(currentController.activateGfsResourceNavigation).toHaveBeenCalledOnce()
    expect(activeWorkspaceTab(currentController.workspaceTabs)).toMatchObject({
      kind: 'files',
      files: { path: null },
    })
    expect(acknowledgeGfsDeepLink).not.toHaveBeenCalled()

    act(() => {
      filesPageHarness.props?.onLocationChange?.(uri, 'Shared document.md')
      filesPageHarness.props?.onPendingGfsDeepLinkOutcome?.(link.id, 'opened')
    })

    await waitFor(() => expect(acknowledgeGfsDeepLink).toHaveBeenCalledWith(link.id))
    expect(activeWorkspaceTab(currentController.workspaceTabs)).toMatchObject({
      kind: 'files',
      files: { path: uri },
    })
    expect(gfsQueue.list()).toEqual([])
  })

  it('fences a pending producer link before blocked chat-tab access resolves', async () => {
    const uri = 'gfs://main/0123456789abcdef0123456789abcdef'
    const resource: Awaited<ReturnType<typeof window.clerum.gfs.resolve>> = {
      drive: 'main',
      resourceId: '0123456789abcdef0123456789abcdef',
      parentResourceId: null,
      gfsUri: uri,
      name: 'Shared folder',
      kind: 'directory',
      pathCache: null,
      version: 1,
    }
    let releaseResolve!: (value: typeof resource) => void
    let resolveReleased = false
    const heldResolve = new Promise<typeof resource>(resolve => {
      releaseResolve = resolve
    })
    const resolveGfs = vi.fn(() => heldResolve)
    const handleSelectChatAgent = vi.fn()
    window.clerum.gfs.resolve = resolveGfs

    currentController = makeController({
      initialExperienceLoading: false,
      workspaceTabs: openChatTab(createWorkspaceTabsState('chat-tab-1'), {
        id: 'chat-tab-1',
        agentRef: 'blocked-agent',
        chatId: 'blocked-chat',
      }),
      isHostAccessBlocked: vi.fn(() => true),
      handleSelectChatAgent,
    } as Partial<AppController>)
    filesPageHarness.renderActual = true
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    )
    await waitFor(() => expect(emitGfsDeepLink).not.toBeNull())
    await waitFor(() => expect(listPendingGfsDeepLinks).toHaveBeenCalled())

    const link = produceGfsResourceDeepLink(uri)
    act(() => emitGfsDeepLink?.(link))
    await waitFor(() => expect(resolveGfs).toHaveBeenCalledTimes(1))

    const ownerTabId = currentController.workspaceTabs.activeTabId
    expect(activeWorkspaceTab(currentController.workspaceTabs)?.kind).toBe('files')
    expect(ownerTabId).toBeTruthy()
    expect(workspaceTabStripHarness.props).not.toBeNull()

    const intentBeforeChatSelection = currentController.navigationIntentSequence
    act(() => workspaceTabStripHarness.props?.onSelect('chat-tab-1'))
    await waitFor(() => expect(currentController.workspaceTabs.activeTabId).toBe('chat-tab-1'))
    expect(currentController.navigationIntentSequence).toBe(intentBeforeChatSelection + 1)
    expect(handleSelectChatAgent).toHaveBeenCalledWith(
      'blocked-agent',
      expect.objectContaining({
        chatId: 'blocked-chat',
        navigationIntentAlreadyStarted: true,
      })
    )

    const intentBeforeOwnerReselection = currentController.navigationIntentSequence
    act(() => workspaceTabStripHarness.props?.onSelect(ownerTabId!))
    await waitFor(() => expect(currentController.workspaceTabs.activeTabId).toBe(ownerTabId))
    expect(currentController.navigationIntentSequence).toBe(intentBeforeOwnerReselection + 1)

    try {
      // The real FilesPage consumer must not call resolve again when the owner
      // tab is reselected after the user's explicit switch.
      expect(resolveGfs).toHaveBeenCalledTimes(1)
      await waitFor(() => expect(acknowledgeGfsDeepLink).toHaveBeenCalledWith(link.id))
      await act(async () => {
        releaseResolve(resource)
        resolveReleased = true
        await heldResolve
        await Promise.resolve()
      })
      await waitFor(() => expect(gfsQueue.list()).toEqual([]))
      expect(acknowledgeGfsDeepLink).toHaveBeenCalledOnce()
      expect(activeWorkspaceTab(currentController.workspaceTabs)).toMatchObject({
        kind: 'files',
        files: { path: null },
      })
    } finally {
      if (!resolveReleased) {
        await act(async () => {
          releaseResolve(resource)
          await heldResolve
          await Promise.resolve()
        })
      }
      queryClient.clear()
    }
  })

  it('advances navigation intent for New Chat without a resource prefill', async () => {
    currentController = makeController({ initialExperienceLoading: false })
    render(<App />)
    await waitFor(() => expect(emitCommand).not.toBeNull())

    const intentBeforeNewChat = currentController.navigationIntentSequence
    act(() => emitCommand?.('chat.newTab'))

    expect(currentController.navigationIntentSequence).toBe(intentBeforeNewChat + 1)
    expect(activeWorkspaceTab(currentController.workspaceTabs)?.kind).toBe('chat')
  })

  it('does not double-advance when New Chat reveals the selected agent', async () => {
    currentController = makeController({
      initialExperienceLoading: false,
      selectedAgent: 'agent-a',
      activeChatId: 'chat-1',
    } as Partial<AppController>)
    render(<App />)
    await waitFor(() => expect(emitCommand).not.toBeNull())

    const intentBeforeNewChat = currentController.navigationIntentSequence
    act(() => emitCommand?.('chat.newTab'))

    expect(currentController.navigationIntentSequence).toBe(intentBeforeNewChat + 1)
    expect(activeWorkspaceTab(currentController.workspaceTabs)?.kind).toBe('chat')
  })

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
    expect(openSandboxUi()).not.toHaveBeenCalled()
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

  it('restores the originating chat workspace when a failed cross-team link rolls back', async () => {
    currentController = makeController({
      initialExperienceLoading: false,
      navItem: DESKTOP_ROUTES.chat,
      selectedAgent: 'alpha',
      activeChatId: 'chat-1',
      workspaceTabs: openChatTab(createWorkspaceTabsState('chat-tab-1'), {
        id: 'chat-tab-1',
        agentRef: 'alpha',
        chatId: 'chat-1',
      }),
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
    expect(currentController.restoreWorkspaceNavigation).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedAgent: 'alpha',
        workspaceTabs: expect.objectContaining({
          activeTabId: 'chat-tab-1',
          tabs: expect.arrayContaining([
            expect.objectContaining({
              kind: 'chat',
              id: 'chat-tab-1',
              chat: expect.objectContaining({
                agentRef: 'alpha',
                chatId: 'chat-1',
              }),
            }),
          ]),
        }),
      }),
      expect.any(Number)
    )
    expect(currentController.handleSelectChatAgent).not.toHaveBeenCalled()
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
    expect(closeSandboxUi()).toHaveBeenCalledOnce()
    expect(closeSandboxUi()).toHaveBeenCalledWith({ launchId: main.openCall(0).launchId })
    // The team switch waited for main to release the view, not just for the close.
    expect(viewLiveAtSwitch).toBeNull()
    expect(closeSandboxUi().mock.invocationCallOrder[0]).toBeLessThan(
      ensureTeamContext.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    )
  })

  it('preserves a live app and its route when a same-team link is unavailable', async () => {
    listApps.mockResolvedValue({ apps: [READY_APP] })
    currentController = makeController({ initialExperienceLoading: false })
    render(<App />)
    await launchAppFromSidebar()
    const launchId = main.live()?.launchId
    main.navigate('/tickets/live')

    act(() => emitDeepLink?.({ id: 1, appRef: 'ns/missing' }))
    await confirmPendingAppLink()
    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(1))

    expect(closeSandboxUi()).not.toHaveBeenCalled()
    expect(openSandboxUi()).toHaveBeenCalledOnce()
    expect(embedState().owner).toBe(launchId)
    expect(main.live()).toEqual({
      launchId,
      appRef: 'ns/app',
      routePath: '/tickets/live',
    })
    expect(currentController.handleEnsureTeamContext).not.toHaveBeenCalled()
  })

  it('restores the exact origin app route after a closed cross-team handoff fails', async () => {
    listApps.mockResolvedValue({ apps: [READY_APP] })
    currentController = makeController({
      initialExperienceLoading: false,
      navItem: DESKTOP_ROUTES.apps,
    })
    render(<App />)
    await launchAppFromSidebar()
    main.navigate('/tickets/origin')
    expect(activeWorkspaceTab(currentController.workspaceTabs)?.kind).toBe('app')
    expect(activeWorkspaceTab(currentController.workspaceTabs)?.app?.appRef).toBe('ns/app')
    listApps.mockResolvedValue({ apps: [] })

    act(() => emitDeepLink?.({ id: 1, appRef: 'ns/missing', teamId: 'team-b' }))
    await confirmPendingAppLink()
    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(1))
    expect(currentController.restoreWorkspaceNavigation).toHaveBeenCalledOnce()
    expect(currentController.restoreWorkspaceNavigation).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceTabs: expect.objectContaining({
          activeTabId: currentController.workspaceTabs.tabs.find(tab => tab.kind === 'app')?.id,
        }),
      }),
      expect.any(Number)
    )
    await waitFor(() =>
      expect(sidebarHarness.props?.availableSandboxUiApps).toEqual(
        expect.arrayContaining([expect.objectContaining({ appRef: 'ns/app' })])
      )
    )
    expect(embedState().activeAppTabId).toBe(currentController.workspaceTabs.activeTabId)
    await waitForAppOpen(2)

    expect(closeSandboxUi()).toHaveBeenCalledOnce()
    expect(currentController.handleEnsureTeamContext).toHaveBeenNthCalledWith(1, {
      teamId: 'team-b',
      announce: true,
    })
    expect(currentController.handleEnsureTeamContext).toHaveBeenNthCalledWith(2, {
      teamId: 'team-a',
      announce: true,
    })
    expect(main.openCall(1).launchId).not.toBe(main.openCall(0).launchId)
    expect(main.openCall(1).routePath).toBe('/tickets/origin')
    expect(main.live()).toEqual({
      launchId: main.openCall(1).launchId,
      appRef: 'ns/app',
      routePath: '/tickets/origin',
    })
    expect(
      appTabs().find(tab => tab.id === currentController.workspaceTabs.activeTabId)?.app
    ).toMatchObject({ appRef: 'ns/app', savedRoutePath: '/tickets/origin' })
  })

  it('does not switch teams or relaunch when the active owner close is rejected', async () => {
    listApps.mockResolvedValue({ apps: [READY_APP] })
    currentController = makeController({
      initialExperienceLoading: false,
      navItem: DESKTOP_ROUTES.apps,
    })
    render(<App />)
    await launchAppFromSidebar()
    main.navigate('/tickets/live')
    const listAppsCallsBeforeLink = listApps.mock.calls.length
    closeSandboxUi().mockRejectedValueOnce(new Error('close rejected'))

    act(() => emitDeepLink?.({ id: 1, appRef: 'ns/missing', teamId: 'team-b' }))
    await confirmPendingAppLink()
    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(1))
    expect(currentController.pushToast).toHaveBeenCalledWith(
      'The current app could not be closed safely. Try launching it again.',
      'error'
    )

    expect(currentController.handleEnsureTeamContext).not.toHaveBeenCalled()
    expect(listApps).toHaveBeenCalledTimes(listAppsCallsBeforeLink)
    expect(closeSandboxUi()).toHaveBeenCalledOnce()
    expect(openSandboxUi()).toHaveBeenCalledOnce()
    expect(embedState().owner).toBe(main.openCall(0).launchId)
    expect(main.live()).toEqual({
      launchId: main.openCall(0).launchId,
      appRef: 'ns/app',
      routePath: '/tickets/live',
    })
  })

  it('opens a valid cross-team app link after the origin embed was already closed', async () => {
    const targetApp = {
      appRef: 'ns/target',
      title: 'Target App',
      defaultPath: '/',
      ready: true,
      phase: 'active',
    }
    const targetPath = '/boards/linked'
    listApps.mockResolvedValue({ apps: [READY_APP] })
    currentController = makeController({
      initialExperienceLoading: false,
      navItem: DESKTOP_ROUTES.apps,
    })
    render(<App />)
    await launchAppFromSidebar()
    main.navigate('/tickets/saved')
    await act(async () => emitCommand?.('app.backToApps'))
    await waitFor(() => expect(embedState().owner).toBeNull())
    await waitFor(() => expect(appTabs()[0]?.app?.savedRoutePath).toBe('/tickets/saved'))
    expect(main.live()).toBeNull()

    // Main's producer parses a protocol URL, queues that target and emits the
    // resulting envelope on sandboxUi:deepLink.
    const target = parseSandboxUiDeepLink(
      buildSandboxUiDeepLink({
        recipeNs: 'ns',
        recipeName: 'target',
        path: targetPath,
        teamId: 'team-b',
      })
    )
    if (!target) throw new Error('The shared producer rejected the valid app link fixture')
    const link = new SandboxUiDeepLinkQueue().enqueue(target)
    const listAppsCallsBeforeLink = listApps.mock.calls.length
    listApps.mockResolvedValue({ apps: [targetApp] })

    act(() => emitDeepLink?.(link))
    await confirmPendingAppLink()
    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(link.id))

    expect(currentController.handleEnsureTeamContext).toHaveBeenCalledWith({
      teamId: 'team-b',
      announce: true,
    })
    expect(currentController.getCurrentTeamId()).toBe('team-b')
    expect(listApps).toHaveBeenCalledTimes(listAppsCallsBeforeLink + 1)
    await waitForAppOpen(2)
    expect(main.openCall(1)).toMatchObject({
      recipeNs: 'ns',
      recipeName: 'target',
      routePath: targetPath,
    })
    expect(main.live()).toEqual({
      launchId: main.openCall(1).launchId,
      appRef: targetApp.appRef,
      routePath: targetPath,
    })
    expect(activeWorkspaceTab(currentController.workspaceTabs)).toMatchObject({
      kind: 'app',
      app: { appRef: targetApp.appRef },
    })
  })

  it('waits for outstanding origin views with Chat active and rolls back to their final route', async () => {
    listApps.mockResolvedValue({ apps: [READY_APP] })
    currentController = makeController({ initialExperienceLoading: false })

    let holdRelease = false
    let originLaunchId: string | null = null
    let deliverHeldRelease: (() => void) | null = null
    const registerReleased = main.bridge.onReleased.getMockImplementation()
    if (!registerReleased) throw new Error('the main fake has no release listener producer')
    main.bridge.onReleased.mockImplementation(listener =>
      registerReleased(event => {
        if (holdRelease && event.reason === 'closed' && event.launchId === originLaunchId) {
          deliverHeldRelease = () => listener(event)
          return
        }
        listener(event)
      })
    )

    render(<App />)
    await launchAppFromSidebar()
    originLaunchId = main.live()?.launchId ?? null
    if (!originLaunchId) throw new Error('the origin app did not mount')
    main.navigate('/tickets/live')
    holdRelease = true
    await act(async () => emitCommand?.('app.backToApps'))
    await waitFor(() => expect(deliverHeldRelease).not.toBeNull())
    expect(embedState().views.get(originLaunchId)?.phase).toBe('closeRequested')
    await selectTab(0)
    expect(activeWorkspaceTab(currentController.workspaceTabs)?.kind).toBe('chat')

    let resolveTargetApps!: (value: { apps: (typeof READY_APP)[] }) => void
    const targetApps = new Promise<{ apps: (typeof READY_APP)[] }>(resolve => {
      resolveTargetApps = resolve
    })
    const listAppsCallsBeforeLink = listApps.mock.calls.length
    listApps.mockImplementationOnce(() => targetApps)
    const target = parseSandboxUiDeepLink(
      buildSandboxUiDeepLink({
        recipeNs: 'ns',
        recipeName: 'missing',
        path: '/linked',
        teamId: 'team-b',
      })
    )
    if (!target) throw new Error('the shared producer rejected the unavailable app link fixture')
    const link = new SandboxUiDeepLinkQueue().enqueue(target)

    act(() => emitDeepLink?.(link))
    await confirmPendingAppLink()
    await waitFor(() =>
      expect(
        listApps.mock.calls.length === listAppsCallsBeforeLink + 1 ||
          embedState().handoffs.length > 0
      ).toBe(true)
    )

    await act(async () => {
      deliverHeldRelease?.()
      await Promise.resolve()
    })
    await waitFor(() => expect(appTabs()[0]?.app?.savedRoutePath).toBe('/tickets/live'))
    await waitFor(() => expect(listApps).toHaveBeenCalledTimes(listAppsCallsBeforeLink + 1))
    expect(currentController.getCurrentTeamId()).toBe('team-b')
    resolveTargetApps({ apps: [] })
    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(link.id))

    expect(currentController.getCurrentTeamId()).toBe('team-a')
    expect(activeWorkspaceTab(currentController.workspaceTabs)?.kind).toBe('chat')
    expect(appTabs()[0]?.app?.savedRoutePath).toBe('/tickets/live')
    expect(openSandboxUi()).toHaveBeenCalledTimes(1)
    expect(main.live()).toBeNull()
  })

  it('continues a cross-team link after a matching session release without relaunching origin', async () => {
    const targetApp = {
      appRef: 'ns/target',
      title: 'Target App',
      defaultPath: '/',
      ready: true,
      phase: 'active',
    }
    listApps.mockResolvedValue({ apps: [READY_APP] })
    currentController = makeController({ initialExperienceLoading: false })
    render(<App />)
    await launchAppFromSidebar()
    const originLaunchId = main.live()?.launchId
    if (!originLaunchId) throw new Error('the origin app did not mount')

    const closeMainView = closeSandboxUi().getMockImplementation()
    if (!closeMainView) throw new Error('the main close producer is unavailable')
    const closeRequestControl: { release?: () => void } = {}
    closeSandboxUi().mockImplementation(
      request =>
        new Promise((resolve, reject) => {
          closeRequestControl.release = () => {
            void Promise.resolve(closeMainView(request)).then(resolve, reject)
          }
        })
    )

    listApps.mockResolvedValueOnce({ apps: [targetApp] })
    const target = parseSandboxUiDeepLink(
      buildSandboxUiDeepLink({
        recipeNs: 'ns',
        recipeName: 'target',
        path: '/linked',
        teamId: 'team-b',
      })
    )
    if (!target) throw new Error('the shared producer rejected the target app-link fixture')
    const link = new SandboxUiDeepLinkQueue().enqueue(target)

    act(() => emitDeepLink?.(link))
    await confirmPendingAppLink()
    await waitFor(() => expect(embedState().handoffs).toHaveLength(1))
    expect(currentController.getCurrentTeamId()).toBe('team-a')

    main.endSession()
    await waitFor(() =>
      expect(
        main
          .reported('sandboxUi:released')
          .some(
            event =>
              (event as { launchId?: string; reason?: string }).launchId === originLaunchId &&
              (event as { reason?: string }).reason === 'session'
          )
      ).toBe(true)
    )
    await waitFor(() => expect(currentController.getCurrentTeamId()).toBe('team-b'))
    closeRequestControl.release?.()
    await waitForAppOpen(2)
    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(link.id))

    expect(main.openCall(1)).toMatchObject({ recipeNs: 'ns', recipeName: 'target' })
    expect(openSandboxUi()).toHaveBeenCalledTimes(2)
    expect(currentController.getCurrentTeamId()).toBe('team-b')
    expect(activeWorkspaceTab(currentController.workspaceTabs)).toMatchObject({
      kind: 'app',
      app: { appRef: targetApp.appRef },
    })
  })

  it('waits for a pending origin release before rolling back an unavailable cross-team link', async () => {
    listApps.mockResolvedValue({ apps: [READY_APP] })
    currentController = makeController({
      initialExperienceLoading: false,
      navItem: DESKTOP_ROUTES.apps,
    })

    let holdRelease = false
    let originLaunchId: string | null = null
    let deliverHeldRelease: (() => void) | null = null
    const registerReleased = main.bridge.onReleased.getMockImplementation()
    if (!registerReleased) throw new Error('the main fake has no release listener producer')
    main.bridge.onReleased.mockImplementation(listener =>
      registerReleased(event => {
        if (holdRelease && event.reason === 'closed' && event.launchId === originLaunchId) {
          deliverHeldRelease = () => listener(event)
          return
        }
        listener(event)
      })
    )

    render(<App />)
    await launchAppFromSidebar()
    originLaunchId = main.live()?.launchId ?? null
    if (!originLaunchId) throw new Error('the origin app did not mount')
    main.navigate('/tickets/saved')
    await act(async () => emitCommand?.('app.backToApps'))
    await waitFor(() => expect(embedState().owner).toBeNull())
    await waitFor(() => expect(appTabs()[0]?.app?.savedRoutePath).toBe('/tickets/saved'))

    await selectTab(0)
    await selectTab(1)
    await waitForAppOpen(2)
    await waitFor(() => expect(main.live()?.routePath).toBe('/tickets/saved'))
    originLaunchId = main.live()?.launchId ?? null
    if (!originLaunchId) throw new Error('the origin app did not remount')
    main.navigate('/tickets/live')
    expect(appTabs()[0]?.app?.savedRoutePath).toBe('/tickets/saved')
    holdRelease = true
    await act(async () => emitCommand?.('app.backToApps'))
    await waitFor(() => expect(embedState().owner).toBeNull())
    await waitFor(() => expect(deliverHeldRelease).not.toBeNull())
    expect(embedState().views.get(originLaunchId)?.phase).toBe('closeRequested')

    let resolveTargetApps!: (value: { apps: (typeof READY_APP)[] }) => void
    const targetApps = new Promise<{ apps: (typeof READY_APP)[] }>(resolve => {
      resolveTargetApps = resolve
    })
    const listAppsCallsBeforeLink = listApps.mock.calls.length
    listApps.mockImplementationOnce(() => targetApps)
    const target = parseSandboxUiDeepLink(
      buildSandboxUiDeepLink({
        recipeNs: 'ns',
        recipeName: 'missing',
        path: '/linked',
        teamId: 'team-b',
      })
    )
    if (!target) throw new Error('the shared producer rejected the unavailable app link fixture')
    const link = new SandboxUiDeepLinkQueue().enqueue(target)

    act(() => emitDeepLink?.(link))
    await confirmPendingAppLink()
    await waitFor(() =>
      expect(
        listApps.mock.calls.length === listAppsCallsBeforeLink + 1 ||
          embedState().handoffs.length > 0
      ).toBe(true)
    )

    await act(async () => {
      deliverHeldRelease?.()
      await Promise.resolve()
    })
    await waitFor(() => expect(appTabs()[0]?.app?.savedRoutePath).toBe('/tickets/live'))
    await waitFor(() => expect(listApps).toHaveBeenCalledTimes(listAppsCallsBeforeLink + 1))
    expect(currentController.getCurrentTeamId()).toBe('team-b')
    resolveTargetApps({ apps: [] })
    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(link.id))

    expect(currentController.getCurrentTeamId()).toBe('team-a')
    expect(appTabs()[0]?.app?.savedRoutePath).toBe('/tickets/live')
    expect(openSandboxUi()).toHaveBeenCalledTimes(2)
    expect(main.live()).toBeNull()
  })

  it('keeps the visible workspace and retry path when the team switch RPC rejects', async () => {
    const actualControllerModule =
      await vi.importActual<typeof import('@hooks/useAppController')>('@hooks/useAppController')
    vi.mocked(useAppController).mockImplementation(() => {
      realController = actualControllerModule.useAppController()
      return realController
    })
    const appBridge = window.clerum
    const { handle } = installAppControllerClerum({ agentNames: ['agent-x'] })
    Object.assign(window.clerum, {
      shortcuts: appBridge.shortcuts,
      app: appBridge.app,
      sandboxUi: appBridge.sandboxUi,
      gfs: appBridge.gfs,
    })
    expect(window.clerum.team.switch).toBe(handle.switchTeam)
    commonHarness.renderActualToastStack = true

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = render(
      <QueryClientProvider client={queryClient}>
        <AgentTaskTrackerProvider>
          <App />
        </AgentTaskTrackerProvider>
      </QueryClientProvider>
    )
    unmountRealApp = view.unmount
    const getController = () => {
      if (!realController) throw new Error('the real App controller did not mount')
      return realController
    }
    await waitFor(() => expect(getController().booting).toBe(false))
    await waitFor(() => expect(getController().isAuthenticated).toBe(true))
    await waitFor(() => expect(getController().initialExperienceLoading).toBe(false))
    await waitFor(() => expect(handle.refreshCatalog.mock.calls.length).toBeGreaterThanOrEqual(2))
    await waitFor(() => expect(handle.teamDirectory).toHaveBeenCalledOnce())
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    act(() => {
      getController().handleSelectChatAgent('agent-x', {
        chatId: 'chat-1',
        title: 'Conversation',
        selectLatest: false,
      })
      getController().openFilesSection('gfs://main/0123456789abcdef0123456789abcdef')
    })
    const chatTab = getController().workspaceTabs.tabs.find(
      tab => tab.kind === 'chat' && tab.chat?.chatId === 'chat-1'
    )
    if (chatTab?.kind !== 'chat') throw new Error('the chat producer did not create its tab')
    act(() => {
      expect(setComposerDraft('chat-1', 'unsent selected-tab draft', 'agent-x', chatTab.id)).toBe(
        true
      )
      getController().selectWorkspaceTabById(chatTab.id)
    })
    await waitFor(() => expect(getController().workspaceTabs.activeTabId).toBe(chatTab.id))

    const workspaceBefore = getController().workspaceTabs
    const navigationBefore = getController().captureWorkspaceNavigation()
    const catalogCallsBefore = handle.refreshCatalog.mock.calls.length
    const directoryCallsBefore = handle.teamDirectory.mock.calls.length
    const listAppsCallsBefore = listApps.mock.calls.length
    expect(getController().selectedAgent).toBe('agent-x')
    expect(getController().lastActiveChatTabId).toBe(chatTab.id)
    expect(getComposerDraft('chat-1', 'agent-x', chatTab.id)).toBe('unsent selected-tab draft')

    let rejectTeamSwitch!: (error: Error) => void
    handle.switchTeam.mockClear()
    handle.switchTeam.mockImplementationOnce(
      () => new Promise((_resolve, reject) => (rejectTeamSwitch = reject))
    )
    const target = parseSandboxUiDeepLink(
      buildSandboxUiDeepLink({
        recipeNs: 'ns',
        recipeName: 'missing',
        path: '/linked',
        teamId: 'team-2',
      })
    )
    if (!target) throw new Error('the shared producer rejected the team-switch link fixture')
    const link = new SandboxUiDeepLinkQueue().enqueue(target)
    act(() => emitDeepLink?.(link))
    await confirmPendingAppLink()
    await waitFor(() => expect(handle.switchTeam).toHaveBeenCalledWith('team-2'))
    await waitFor(() => expect(getController().busy).toBe(true))

    expect(getController().getCurrentTeamId()).toBe('team-1')
    expect(getController().workspaceTabs).toBe(workspaceBefore)
    expect(getController().captureWorkspaceNavigation()).toEqual(navigationBefore)
    expect(handle.refreshCatalog).toHaveBeenCalledTimes(catalogCallsBefore)
    expect(handle.teamDirectory).toHaveBeenCalledTimes(directoryCallsBefore)

    await act(async () => {
      rejectTeamSwitch(
        Object.assign(new Error('team switch connection failed'), { code: 'ECONNRESET' })
      )
      await Promise.resolve()
    })
    await waitFor(() => expect(getController().busy).toBe(false))
    const retryMessage = await view.findByText(
      /Could not switch to the linked team yet:.*will retry shortly/
    )
    expect(retryMessage.closest('[role="status"]')?.isConnected).toBe(true)
    expect(getController().getCurrentTeamId()).toBe('team-1')
    expect(getController().workspaceTabs).toBe(workspaceBefore)
    expect(getController().captureWorkspaceNavigation()).toEqual(navigationBefore)
    expect(getController().selectedAgent).toBe('agent-x')
    expect(getController().lastActiveChatTabId).toBe(chatTab.id)
    expect(getComposerDraft('chat-1', 'agent-x', chatTab.id)).toBe('unsent selected-tab draft')
    expect(handle.refreshCatalog).toHaveBeenCalledTimes(catalogCallsBefore)
    expect(handle.teamDirectory).toHaveBeenCalledTimes(directoryCallsBefore)
    expect(listApps).toHaveBeenCalledTimes(listAppsCallsBefore)
    expect(acknowledgeDeepLink).not.toHaveBeenCalledWith(link.id)
  })

  it('restores the origin app and keeps the link retryable when origin refresh rejects', async () => {
    const actualControllerModule =
      await vi.importActual<typeof import('@hooks/useAppController')>('@hooks/useAppController')
    let activeTeamId = 'team-1'
    let rejectOriginRefresh = false
    let injectOriginRefreshFailure = true
    vi.mocked(useAppController).mockImplementation(() => {
      realController = actualControllerModule.useAppController()
      const ensureTeamContext = realController.handleEnsureTeamContext
      realController.handleEnsureTeamContext = async target => {
        const didSwitch = await ensureTeamContext(target)
        if (target.teamId) activeTeamId = target.teamId
        if (target.teamId === 'team-2' && injectOriginRefreshFailure) {
          rejectOriginRefresh = true
          injectOriginRefreshFailure = false
        } else if (target.teamId === 'team-1' && rejectOriginRefresh) {
          // Model a refresh rejection after the real team switch has landed.
          rejectOriginRefresh = false
          throw Object.assign(new Error('origin catalog timed out'), { code: 'ETIMEDOUT' })
        }
        return didSwitch
      }
      return realController
    })
    const appBridge = window.clerum
    const { handle } = installAppControllerClerum({ agentNames: ['agent-x'] })
    Object.assign(window.clerum, {
      shortcuts: appBridge.shortcuts,
      app: appBridge.app,
      sandboxUi: appBridge.sandboxUi,
      gfs: appBridge.gfs,
    })

    const switchTeam = handle.switchTeam.getMockImplementation()
    if (!switchTeam) throw new Error('the team-switch producer is missing')
    const targetApp = { ...READY_APP, appRef: 'ns/target', title: 'Target app' }
    let rejectTargetCatalog = true
    listApps.mockImplementation(async () => {
      if (activeTeamId === 'team-2' && rejectTargetCatalog) {
        rejectTargetCatalog = false
        throw new Error('target app catalog failed')
      }
      return activeTeamId === 'team-1' ? { apps: [READY_APP] } : { apps: [targetApp] }
    })

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = render(
      <QueryClientProvider client={queryClient}>
        <AgentTaskTrackerProvider>
          <App />
        </AgentTaskTrackerProvider>
      </QueryClientProvider>
    )
    unmountRealApp = view.unmount
    const getController = () => {
      if (!realController) throw new Error('the real App controller did not mount')
      return realController
    }
    await waitFor(() => expect(getController().booting).toBe(false))
    await waitFor(() => expect(getController().isAuthenticated).toBe(true))
    await waitFor(() => expect(getController().initialExperienceLoading).toBe(false))
    await waitFor(() => expect(handle.refreshCatalog.mock.calls.length).toBeGreaterThanOrEqual(2))
    await launchAppFromSidebar()
    main.navigate('/tickets/origin')

    const openTeams: string[] = []
    const open = main.bridge.open.getMockImplementation()
    if (!open) throw new Error('the main fake has no app-open producer')
    main.bridge.open.mockImplementation(async (...args) => {
      openTeams.push(getController().getCurrentTeamId())
      return open(...args)
    })
    const target = parseSandboxUiDeepLink(
      buildSandboxUiDeepLink({
        recipeNs: 'ns',
        recipeName: 'target',
        path: '/linked',
        teamId: 'team-2',
      })
    )
    if (!target) throw new Error('the shared producer rejected the cross-team link fixture')
    const link = new SandboxUiDeepLinkQueue().enqueue(target)
    act(() => emitDeepLink?.(link))
    await confirmPendingAppLink()

    await waitFor(() => expect(getController().getCurrentTeamId()).toBe('team-1'))
    await waitFor(() => expect(openSandboxUi()).toHaveBeenCalledTimes(2))
    await waitForMounted()
    await waitFor(() => expect(confirmDialogHarness.props?.confirmLabel).toBe('Retry'))

    expect(handle.switchTeam.mock.calls.map(([teamId]) => teamId)).toEqual(['team-2', 'team-1'])
    expect(openTeams).toEqual(['team-1'])
    expect(getController().getCurrentTeamId()).toBe('team-1')
    expect(activeWorkspaceTab(getController().workspaceTabs)).toMatchObject({
      kind: 'app',
      app: { appRef: 'ns/app', savedRoutePath: '/tickets/origin' },
    })
    expect(main.live()).toMatchObject({ appRef: 'ns/app', routePath: '/tickets/origin' })
    expect(acknowledgeDeepLink).not.toHaveBeenCalledWith(link.id)

    await act(async () => {
      confirmDialogHarness.props?.onConfirm()
      await Promise.resolve()
    })
    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(link.id))
    expect(getController().getCurrentTeamId()).toBe('team-2')
    expect(main.live()?.appRef).toBe('ns/target')
    expect(openTeams).toEqual(['team-1', 'team-2'])
  })

  // The bridge returns successful logout, an unauthenticated session, then B login.
  // There is no producer for direct authenticated A→B loadSession; do not synthesize it.
  it('renders a fresh B workspace after successful A logout and null session', async () => {
    const userA = {
      id: 'user-a',
      email: 'a@example.test',
      name: 'User A',
      teamId: 'team-a',
      teamName: 'Team A',
    }
    const userB = {
      id: 'user-b',
      email: 'b@example.test',
      name: 'User B',
      teamId: 'team-b',
      teamName: 'Team B',
    }
    let session: { authenticated: boolean; me: typeof userA | typeof userB | null } = {
      authenticated: true,
      me: userA,
    }
    const actualControllerModule =
      await vi.importActual<typeof import('@hooks/useAppController')>('@hooks/useAppController')
    vi.mocked(useAppController).mockImplementation(() => {
      realController = actualControllerModule.useAppController()
      return realController
    })
    const appBridge = window.clerum
    const { handle } = installAppControllerClerum({ agentNames: ['agent-x'], me: userA })
    handle.getSessionState.mockImplementation(async () => session)
    handle.logout.mockImplementation(async () => {
      session = { authenticated: false, me: null }
      return { ok: true, sessionGeneration: 2 }
    })
    handle.passwordLogin.mockImplementation(async () => {
      session = { authenticated: true, me: userB }
      return { authenticated: true, me: userB }
    })
    Object.assign(window.clerum, {
      shortcuts: appBridge.shortcuts,
      app: appBridge.app,
      sandboxUi: appBridge.sandboxUi,
      gfs: appBridge.gfs,
    })
    commonHarness.renderWorkspaceSurfaces = true

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = render(
      <QueryClientProvider client={queryClient}>
        <AgentTaskTrackerProvider>
          <App />
        </AgentTaskTrackerProvider>
      </QueryClientProvider>
    )
    unmountRealApp = view.unmount
    const getController = () => {
      if (!realController) throw new Error('the real App controller did not mount')
      return realController
    }
    await waitFor(() => expect(getController().booting).toBe(false))
    await waitFor(() => expect(getController().isAuthenticated).toBe(true))
    await waitFor(() => expect(getController().initialExperienceLoading).toBe(false))
    await waitFor(() => expect(handle.refreshCatalog.mock.calls.length).toBeGreaterThanOrEqual(2))
    await waitFor(() => expect(handle.teamDirectory).toHaveBeenCalledOnce())

    act(() => {
      getController().handleSelectChatAgent('agent-x', {
        chatId: 'chat-a',
        title: 'A conversation',
        selectLatest: false,
      })
      getController().openFilesSection('gfs://main/0123456789abcdef0123456789abcdef')
      getController().handleNavSelect(DESKTOP_ROUTES.settings)
    })
    const chatTab = getController().workspaceTabs.tabs.find(
      tab => tab.kind === 'chat' && tab.chat?.chatId === 'chat-a'
    )
    if (chatTab?.kind !== 'chat') throw new Error('the A chat producer did not create its tab')
    commonHarness.draftProbe = { chatId: 'chat-a', agentRef: 'agent-x', tabId: chatTab.id }
    act(() => {
      expect(setComposerDraft('chat-a', 'private A draft', 'agent-x', chatTab.id)).toBe(true)
    })

    const aTabs = view.getByRole('toolbar', { name: 'Workspace tabs' })
    expect(Array.from(aTabs.querySelectorAll('button'), button => button.textContent)).toEqual([
      'A conversation',
      'Files',
      'settings',
    ])
    expect(view.getByTestId('settings-page-pane')).toBeTruthy()
    expect(getController().selectedAgent).toBe('agent-x')
    expect(getComposerDraft('chat-a', 'agent-x', chatTab.id)).toBe('private A draft')

    act(() => getController().selectWorkspaceTabById(chatTab.id))
    await waitFor(() => expect(view.getByTestId('chat-page-pane')).toBeTruthy())
    const aChatTab = aTabs.querySelector<HTMLButtonElement>(
      `[data-workspace-tab-id="${chatTab.id}"]`
    )
    expect(aChatTab?.getAttribute('aria-pressed')).toBe('true')
    expect(
      (view.getByRole('textbox', { name: 'Draft in App pane' }) as HTMLTextAreaElement).value
    ).toBe('private A draft')

    await act(async () => getController().handleLogout())
    await waitFor(() => expect(getController().isAuthenticated).toBe(false))
    expect(view.getByTestId('auth-page')).toBeTruthy()
    expect(view.queryByRole('toolbar', { name: 'Workspace tabs' })).toBeNull()
    expect(getController().selectedAgent).toBeNull()
    expect(getController().workspaceTabs.tabs).toHaveLength(1)
    expect(getComposerDraft('chat-a', 'agent-x', chatTab.id)).toBe('')

    act(() => {
      getController().setEmail(userB.email)
      getController().setPassword('test-password')
    })
    await act(async () => getController().handlePasswordLogin())
    await waitFor(() => expect(getController().me?.id).toBe(userB.id))
    await waitFor(() => expect(getController().initialExperienceLoading).toBe(false))

    const bTabs = view.getByRole('toolbar', { name: 'Workspace tabs' })
    const bTabButtons = Array.from(bTabs.querySelectorAll('button'))
    expect(bTabButtons).toHaveLength(1)
    expect(bTabButtons[0]?.textContent).toBe('New chat')
    expect(bTabButtons[0]?.getAttribute('aria-pressed')).toBe('true')
    expect(getController().getCurrentTeamId()).toBe('team-b')
    expect(getController().selectedAgent).toBeNull()
    expect(getController().workspaceTabs.tabs).toHaveLength(1)
    const bActiveTab = activeWorkspaceTab(getController().workspaceTabs)
    expect(bActiveTab).toMatchObject({
      kind: 'chat',
      chat: { agentRef: null, chatId: null },
    })
    expect(getController().lastActiveChatTabId).toBe(bActiveTab?.id)
    expect(view.getByTestId('chat-page-pane')).toBeTruthy()
    expect(view.queryByTestId('files-page-pane')).toBeNull()
    expect(view.queryByTestId('settings-page-pane')).toBeNull()
    expect(
      (view.getByRole('textbox', { name: 'Draft in App pane' }) as HTMLTextAreaElement).value
    ).toBe('')
    expect(getComposerDraft('chat-a', 'agent-x', chatTab.id)).toBe('')
  })

  it('resolves an unavailable cross-team target without relaunching a closed origin app', async () => {
    listApps.mockResolvedValue({ apps: [READY_APP] })
    currentController = makeController({
      initialExperienceLoading: false,
      navItem: DESKTOP_ROUTES.apps,
    })
    render(<App />)
    await launchAppFromSidebar()
    main.navigate('/tickets/saved')
    await act(async () => emitCommand?.('app.backToApps'))
    await waitFor(() => expect(embedState().owner).toBeNull())
    await waitFor(() => expect(appTabs()[0]?.app?.savedRoutePath).toBe('/tickets/saved'))
    expect(main.live()).toBeNull()
    const listAppsCallsBeforeLink = listApps.mock.calls.length
    listApps.mockResolvedValue({ apps: [] })

    act(() => emitDeepLink?.({ id: 1, appRef: 'ns/missing', teamId: 'team-b' }))
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
    expect(listApps).toHaveBeenCalledTimes(listAppsCallsBeforeLink + 1)
    expect(currentController.getCurrentTeamId()).toBe('team-a')
    expect(currentController.pushToast).toHaveBeenCalledWith(
      expect.stringContaining("You don't have access to this app in the linked team"),
      'error'
    )
    expect(openSandboxUi()).toHaveBeenCalledOnce()
    expect(main.live()).toBeNull()
    expect(appTabs()[0]?.app?.savedRoutePath).toBe('/tickets/saved')
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

  it('reports when explicit workspace navigation cancels a retrying app link', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    currentController = makeController({ initialExperienceLoading: false })
    currentController.workspaceTabs = openFilesTab(currentController.workspaceTabs, {
      id: 'files-tab-2',
    })
    listApps.mockResolvedValue({
      apps: [
        {
          appRef: 'ns/app',
          title: 'Linked App',
          defaultPath: '/',
          ready: false,
          phase: 'deploying',
        },
      ],
    })
    render(<App />)
    await waitFor(() => expect(emitDeepLink).not.toBeNull())
    const listAppsCallsBeforeLink = listApps.mock.calls.length

    const target = parseSandboxUiDeepLink(
      buildSandboxUiDeepLink({ recipeNs: 'ns', recipeName: 'app' })
    )
    if (!target) throw new Error('the shared producer rejected the app-link fixture')
    const link = new SandboxUiDeepLinkQueue().enqueue(target)
    act(() => emitDeepLink?.(link))
    await confirmPendingAppLink()
    await waitFor(() =>
      expect(currentController.pushToast).toHaveBeenCalledWith(
        'Linked App is still starting up. This link will retry shortly.',
        'info'
      )
    )

    const previousIntent = currentController.navigationIntentSequence
    act(() => workspaceTabStripHarness.props?.onSelect('chat-tab-1'))
    await waitFor(() => expect(currentController.workspaceTabs.activeTabId).toBe('chat-tab-1'))
    expect(currentController.navigationIntentSequence).toBeGreaterThan(previousIntent)

    await act(async () => {
      vi.advanceTimersByTime(1_000)
      await Promise.resolve()
    })
    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(link.id))

    expect(acknowledgeDeepLink).toHaveBeenCalledOnce()
    expect(listApps).toHaveBeenCalledTimes(listAppsCallsBeforeLink + 1)
    expect(openSandboxUi()).not.toHaveBeenCalled()
    expect(currentController.workspaceTabs.activeTabId).toBe('chat-tab-1')
    expect(currentController.pushToast).toHaveBeenCalledWith(
      'App link canceled because you navigated elsewhere.',
      'info'
    )
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
    expect(liveTeamId).toBe('team-a')
    expect(ensureTeamContext).toHaveBeenCalledTimes(2)
    expect(ensureTeamContext).toHaveBeenCalledWith({
      teamId: 'team-b',
      announce: true,
    })
    expect(ensureTeamContext).toHaveBeenNthCalledWith(2, { teamId: 'team-a', announce: true })

    await act(async () => {
      vi.advanceTimersByTime(1_000)
      await Promise.resolve()
    })
    await waitFor(() => expect(currentController.pushToast).toHaveBeenCalledTimes(2))
    expect(liveTeamId).toBe('team-a')
    expect(ensureTeamContext).toHaveBeenCalledTimes(4)
    expect(ensureTeamContext).toHaveBeenNthCalledWith(4, { teamId: 'team-a', announce: true })

    ready = true
    await act(async () => {
      vi.advanceTimersByTime(2_000)
      await Promise.resolve()
    })
    await waitForAppOpen()

    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(1))
    expect(liveTeamId).toBe('team-b')
    expect(ensureTeamContext).toHaveBeenCalledTimes(5)
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
    expect(liveTeamId).toBe('team-a')
    expect(ensureTeamContext).toHaveBeenCalledTimes(2)
    expect(ensureTeamContext).toHaveBeenNthCalledWith(2, { teamId: 'team-a', announce: true })
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
    main.failNextOpen(new Error('native mount failed'))
    await confirmPendingAppLink()
    await waitForAppOpen()

    await waitFor(() => {
      expect(currentController.pushToast).toHaveBeenCalledWith('native mount failed', 'error')
    })
    expect(liveTeamId).toBe('team-a')
    expect(acknowledgeDeepLink).not.toHaveBeenCalled()
    expect(ensureTeamContext).toHaveBeenCalledTimes(2)
    expect(ensureTeamContext).toHaveBeenNthCalledWith(2, { teamId: 'team-a', announce: true })

    await act(async () => {
      vi.advanceTimersByTime(1_000)
      await Promise.resolve()
    })
    await waitForAppOpen(2)

    await waitFor(() => expect(acknowledgeDeepLink).toHaveBeenCalledWith(1))
    expect(acknowledgeDeepLink).toHaveBeenCalledTimes(1)
    expect(liveTeamId).toBe('team-b')
    expect(ensureTeamContext).toHaveBeenCalledTimes(3)
    expect(ensureTeamContext).toHaveBeenNthCalledWith(2, { teamId: 'team-a', announce: true })
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
    expect(liveTeamId).toBe('team-a')
    expect(ensureTeamContext).toHaveBeenCalledTimes(2)
    expect(ensureTeamContext).toHaveBeenNthCalledWith(2, { teamId: 'team-a', announce: true })

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
    expect(ensureTeamContext).toHaveBeenCalledTimes(2)
    // The failed link restored the origin Chat tab; the manual team change and
    // later retry must not let the older link select its target app tab.
    expect(currentController.navItem).toBe(DESKTOP_ROUTES.chat)
    expect(openSandboxUi()).toHaveBeenCalledTimes(1)
    expect(acknowledgeDeepLink).not.toHaveBeenCalled()

    await act(async () => {
      vi.advanceTimersByTime(60_000)
      await Promise.resolve()
    })
    expect(liveTeamId).toBe('team-c')
    expect(ensureTeamContext).toHaveBeenCalledTimes(2)
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

  const appTabs = () => currentController.workspaceTabs.tabs.filter(tab => tab.kind === 'app')

  // Launch an app straight through the sidebar (`onOpenSandboxUiApp`), the same
  // path the real app-picker uses — no deep-link confirm ceremony.
  async function launchAppFromSidebar(appRef = 'ns/app'): Promise<void> {
    const app = await waitFor(() => {
      const available = sidebarHarness.props?.availableSandboxUiApps?.find(a => a.appRef === appRef)
      if (!available) throw new Error(`${appRef} was not available to the sidebar`)
      return available
    })
    const opens = openSandboxUi().mock.calls.length
    await act(async () => {
      sidebarHarness.props?.onOpenSandboxUiApp?.(app)
      await Promise.resolve()
    })
    await waitFor(() => expect(openSandboxUi()).toHaveBeenCalledTimes(opens + 1), {
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
    expect(closeSandboxUi()).toHaveBeenCalledTimes(1)

    await selectTab(1)
    await waitFor(() => expect(openSandboxUi()).toHaveBeenCalledTimes(2))
    expect(main.openCall(1).routePath).toBe('/tickets/42')
  })

  it('keeps two tabs of the same app on their own routes when alternating', async () => {
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
    await waitFor(() => expect(openSandboxUi()).toHaveBeenCalledTimes(3))
    expect(appTabs()[1]?.app?.savedRoutePath).toBe('/tickets/B')
    expect(main.openCall(2).routePath).toBe('/tickets/A')

    await waitForMounted()
    await selectTab(2) // index 2 = B
    await waitFor(() => expect(openSandboxUi()).toHaveBeenCalledTimes(4))
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
    expect(closeSandboxUi()).not.toHaveBeenCalled()
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
    expect(closeSandboxUi()).toHaveBeenCalledWith({ launchId: main.openCall(0).launchId })
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
    expect(openSandboxUi()).toHaveBeenCalledTimes(1)
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
    expect(openSandboxUi()).toHaveBeenCalledTimes(1)
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

  it('resets suite state even when the body-empty postcondition fails', async () => {
    const dispose = vi.spyOn(main, 'dispose')
    const chatId = 'teardown-failure-chat'
    const agentRef = 'teardown-failure-agent'
    const leakedChild = document.createElement('div')
    setComposerDraft(chatId, 'draft that teardown must clear', agentRef)
    vi.useFakeTimers({ shouldAdvanceTime: true })
    document.body.append(leakedChild)

    try {
      await expect(cleanupAppDeepLinkSuite()).rejects.toThrow(
        'App deep-link suite body-empty postcondition'
      )
      expect(vi.isFakeTimers()).toBe(false)
      expect(getComposerDraft(chatId, agentRef)).toBe('')
      expect(dispose).toHaveBeenCalledOnce()
    } finally {
      leakedChild.remove()
      if (vi.isFakeTimers()) vi.useRealTimers()
      resetComposerDraftStore()
      if (dispose.mock.calls.length === 0) await main.dispose()
    }
  })
})
