// @vitest-environment jsdom
import { useReducer } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DESKTOP_ROUTES } from '@constants/navigation'
import { useNavigationController } from '@hooks/domain/useNavigationController'
import { useAppController } from '@hooks/useAppController'
import { MarkdownDraftOwner } from '@lib/markdownDraftOwner'
import { desktopQueryClient } from '@lib/queryClient'
import {
  activeWorkspaceTab,
  createWorkspaceTabsState,
  openPreviewTab,
  selectWorkspaceTab,
} from '@lib/workspaceTabs'
import type { WorkspaceTab, WorkspaceTabsState } from '@lib/workspaceTabs.types'
import { mapKindToRoute } from '@lib/workspaceTabsRoute'
import { App } from '@/App'

type AppController = ReturnType<typeof useAppController>
type WorkspaceStateUpdater =
  | WorkspaceTabsState
  | ((state: WorkspaceTabsState) => WorkspaceTabsState)
type SessionPreclearNotice = {
  transitionId: number
  sessionGeneration: number
  reason: 'logout' | 'session-ended' | 'environment-change'
}

const harness = vi.hoisted(() => ({
  controller: null as unknown as AppController,
  forceRender: () => {},
  onPreclear: null as ((notice: SessionPreclearNotice) => void) | null,
  onPreclearCancelled: null as ((notice: SessionPreclearNotice) => void) | null,
  onSessionCleared: null as (() => void) | null,
  acknowledge: async (_notice: SessionPreclearNotice) => true,
}))

vi.mock('@hooks/useAppController', () => ({ useAppController: vi.fn() }))
vi.mock('@hooks/useAgentChatActionsValue', () => ({ useAgentChatActionsValue: () => ({}) }))
vi.mock('@hooks/useWindowFocusBridge', () => ({ useWindowFocusBridge: () => {} }))
vi.mock('@components/AppHeader', () => ({ AppHeader: () => null }))
vi.mock('@components/BootSplash', () => ({ BootSplash: () => null }))
vi.mock('@components/ChatDrawer', () => ({ ChatDrawer: ({ children }: any) => children }))
vi.mock('@components/ChatLocalSearch', () => ({ ChatLocalSearch: () => null }))
vi.mock('@components/ChatSwitcher', () => ({ ChatSwitcher: () => null }))
vi.mock('@components/ChatViewWorkspace', () => ({
  ChatViewWorkspace: ({ children }: any) => children,
}))
vi.mock('@components/CommandPalette', () => ({ CommandPalette: () => null }))
vi.mock('@components/GfsImagePreview', () => ({ GfsImagePreview: () => null }))
vi.mock('@components/PluginConsentModal', () => ({ PluginConsentModal: () => null }))
vi.mock('@components/RightRailShell', () => ({ RightRailShell: ({ children }: any) => children }))
vi.mock('@components/SidebarNav', () => ({ SidebarNav: () => null }))
vi.mock('@components/WindowTitleBar', () => ({
  TitlebarActionsPortal: ({ children }: any) => children,
  WindowTitleBar: () => null,
}))
vi.mock('@components/WorkspaceTabStrip', () => ({
  WorkspaceTabStrip: ({
    tabs,
    onClose,
  }: {
    tabs: WorkspaceTab[]
    onClose: (id: string) => void
  }) => (
    <div role="toolbar" aria-label="Workspace tabs">
      {tabs.map(tab => (
        <button
          key={tab.id}
          type="button"
          aria-label={`Close ${tab.title}`}
          onClick={() => onClose(tab.id)}
        >
          Close {tab.title}
        </button>
      ))}
    </div>
  ),
}))
vi.mock('@pages/AgentsPage', () => ({ AgentsPage: () => null }))
vi.mock('@pages/AuthPage', () => ({ AuthPage: () => null }))
vi.mock('@pages/ChatPage', () => ({ ChatPage: () => null }))
vi.mock('@pages/FilePreviewPage', async () => {
  const { MarkdownEditorSurface } =
    await import('@components/GfsMarkdownPreview/MarkdownEditorSurface')
  return {
    FilePreviewPage: ({
      fileName,
      gfsUri,
      tabId,
    }: {
      fileName: string
      gfsUri: string
      tabId: string
    }) => {
      const owner = harness.controller.markdownDraftOwner
      const binding = {
        principalOwner: harness.controller.markdownPrincipalOwner!,
        scopeKey: 'integration-principal-owner/team-a/default',
        tabId,
        gfsUri,
      }
      const record = owner.get(binding)
      if (!record) return <div data-testid="preview" />
      return (
        <MarkdownEditorSurface
          binding={binding}
          fileName={fileName}
          mode="edit"
          onChange={value => owner.type(binding, value)}
          owner={owner}
          value={record.draft}
        />
      )
    },
  }
})
vi.mock('@pages/FilesPage', () => ({ FilesPage: () => null }))
vi.mock('@pages/McpServersPage', () => ({ McpServersPage: () => null }))
vi.mock('@pages/OnboardingPage', () => ({ OnboardingPage: () => null }))
vi.mock('@pages/SandboxUiPage', () => ({ SandboxUiPage: () => null }))
vi.mock('@pages/SettingsPage', () => ({ SettingsPage: () => null }))
vi.mock('@pages/UnavailablePage', () => ({ UnavailablePage: () => null }))
vi.mock('@pages/WorkflowsPage', () => ({ WorkflowsPage: () => null }))

function useReactiveController(): AppController {
  const [, force] = useReducer((count: number) => count + 1, 0)
  useNavigationController()
  harness.forceRender = force
  const controller = harness.controller
  const activeTab = activeWorkspaceTab(controller.workspaceTabs)
  ;(controller as { activeWorkspaceTab: unknown }).activeWorkspaceTab = activeTab
  ;(controller as { navItem: unknown }).navItem = mapKindToRoute(activeTab)
  return controller
}

vi.mocked(useAppController).mockImplementation(useReactiveController)

function makeController(workspaceTabs: WorkspaceTabsState): AppController {
  const markdownDraftOwner = new MarkdownDraftOwner()
  let controller: AppController
  let sequence = 1
  const noop = vi.fn()
  const setWorkspaceTabs = vi.fn((updater: WorkspaceStateUpdater) => {
    const next = typeof updater === 'function' ? updater(controller.workspaceTabs) : updater
    if (next === controller.workspaceTabs) return
    controller.workspaceTabs = next
    harness.forceRender()
  })
  const clearAppsPicker = vi.fn(() => {
    if (!controller.appsPickerActive) return
    controller.appsPickerActive = false
    harness.forceRender()
  })
  const beginUserNavigationIntent = vi.fn(() => {
    controller.navigationIntentSequence += 1
    harness.forceRender()
    return controller.navigationIntentSequence
  })
  controller = {
    markdownDraftOwner,
    markdownPrincipalOwner: 'integration-principal-owner',
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
    navItem: DESKTOP_ROUTES.files,
    selectedAgent: null,
    selectedAgentRoute: null,
    workspaceTabs,
    setWorkspaceTabs,
    activeWorkspaceTab: undefined,
    nextWorkspaceTabId: vi.fn(() => `new-${sequence++}`),
    appsPickerActive: false,
    showAppsPicker: noop,
    clearAppsPicker,
    navigationIntentSequence: 0,
    beginUserNavigationIntent,
    isNavigationIntentCurrent: vi.fn(() => true),
    selectWorkspaceTabById: vi.fn((id: string) => {
      setWorkspaceTabs(state => selectWorkspaceTab(state, id))
      return true
    }),
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
    handleSelectChatAgent: noop,
    handleOpenNotification: noop,
    handleNavSelect: noop,
    openFilesSectionWithReceipt: vi.fn(() => null),
    openFilesSection: noop,
    openPreviewSectionWithReceipt: vi.fn(() => null),
    openPreviewSection: noop,
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

function installAuthBridge(overrides: Record<string, unknown> = {}) {
  const previous = window.clerum
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: {
      ...previous,
      app: { rendererReady: vi.fn(async () => undefined) },
      auth: {
        getDesktopAppInfo: vi.fn(async () => ({ version: 'test' })),
        getSessionGeneration: vi.fn(async () => 1),
        getSessionState: vi.fn(async () => ({
          authenticated: true,
          sessionGeneration: 1,
          me: null,
        })),
        getRuntimeConfigState: vi.fn(async () => ({ options: [], activeOptionId: null })),
        acknowledgeSessionPreclear: vi.fn((notice: SessionPreclearNotice) =>
          harness.acknowledge(notice)
        ),
        onSessionPreclear: vi.fn((callback: (notice: SessionPreclearNotice) => void) => {
          harness.onPreclear = callback
          return vi.fn()
        }),
        onSessionPreclearCancelled: vi.fn((callback: (notice: SessionPreclearNotice) => void) => {
          harness.onPreclearCancelled = callback
          return vi.fn()
        }),
        onSessionCleared: vi.fn((callback: () => void) => {
          harness.onSessionCleared = callback
          return vi.fn()
        }),
        authorizeMarkdownTabClose: vi.fn(async () => 'granted'),
        getMarkdownTabCloseDocumentEpoch: vi.fn(() => '11111111-1111-4111-8111-111111111111'),
        getMarkdownTabClosePermitStatus: vi.fn(async () => 'granted'),
        cancelMarkdownTabClosePermit: vi.fn(async () => 'cancelled'),
        consumeMarkdownTabClosePermit: vi.fn(async () => 'consumed'),
        acknowledgeMarkdownTabClose: vi.fn(
          async (binding: { sequence: number }) => binding.sequence + 1
        ),
        getRendererSessionView: vi.fn(async () => null),
        commitRendererSessionView: vi.fn(async () => false),
        onExternalLogout: vi.fn(() => vi.fn()),
        ...overrides,
      },
      shortcuts: { onCommand: vi.fn(() => vi.fn()) },
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
        reload: vi.fn(async () => undefined),
      },
      team: { directory: vi.fn(async () => ({ teams: [] })) },
      agents: { listMine: vi.fn(async () => ({ agents: [] })) },
      gfs: {
        getUserNavigationGeneration: vi.fn(() => 0),
        advanceUserNavigationGeneration: vi.fn(() => 1),
        acknowledgeDeepLink: vi.fn(async () => undefined),
      },
      pluginSdk: {
        onConsentRequested: vi.fn(() => vi.fn()),
        onConsentCancelled: vi.fn(() => vi.fn()),
        onOpenGfsResource: vi.fn(() => vi.fn()),
      },
    } as unknown as Window['clerum'],
  })
  return () => Object.defineProperty(window, 'clerum', { configurable: true, value: previous })
}

afterEach(() => {
  cleanup()
  harness.controller?.markdownDraftOwner.quit()
  harness.controller = null as unknown as AppController
  harness.onPreclear = null
  harness.onPreclearCancelled = null
  harness.onSessionCleared = null
  desktopQueryClient.clear()
})

describe('App Markdown close recovery', () => {
  it('reconciles a lost grant through same-session recovery before removing the exact draft', async () => {
    let rejectAuthorize!: (error: Error) => void
    let resolveConsume!: (state: string) => void
    let mainState = 'unknown'
    let statusAttempts = 0
    const authCalls = {
      authorizeMarkdownTabClose: vi.fn(
        () =>
          new Promise<string>((_resolve, reject) => {
            mainState = 'granted'
            rejectAuthorize = reject
          })
      ),
      getMarkdownTabClosePermitStatus: vi.fn(async () => {
        statusAttempts += 1
        if (statusAttempts === 1) throw new Error('lost status response')
        return mainState
      }),
      cancelMarkdownTabClosePermit: vi.fn(async () => {
        mainState = 'cancelled'
        return mainState
      }),
      consumeMarkdownTabClosePermit: vi.fn(
        () =>
          new Promise<string>(resolve => {
            resolveConsume = state => {
              mainState = state
              resolve(state)
            }
          })
      ),
    }
    const restoreBridge = installAuthBridge(authCalls)
    const tabId = 'markdown-close-tab'
    const gfsUri = 'gfs://main/markdown-close-recovery'
    const tabs = openPreviewTab(createWorkspaceTabsState('chat-tab-1'), {
      id: tabId,
      title: 'recovery.md',
      gfsUri,
      fileKind: 'markdown',
      byteLength: 32,
    })
    harness.controller = makeController(tabs)
    const owner = harness.controller.markdownDraftOwner
    const binding = {
      principalOwner: harness.controller.markdownPrincipalOwner!,
      scopeKey: 'integration-principal-owner/team-a/default',
      tabId,
      gfsUri,
    }
    owner.open(binding, { sessionGeneration: 1 })
    const read = owner.beginStableRead(binding)!
    owner.completeStableRead(read, { content: 'saved', version: 1, stable: true })
    const capability = owner.beginCapabilityRefresh(binding)!
    owner.completeCapabilityRefresh(capability, true)
    owner.beginEdit(binding)
    owner.type(binding, 'unsaved exact draft')

    render(
      <QueryClientProvider client={desktopQueryClient}>
        <App />
      </QueryClientProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Close recovery.md' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Discard and Close' }))
    await waitFor(() => expect(authCalls.authorizeMarkdownTabClose).toHaveBeenCalledOnce())

    const editor = await screen.findByRole('textbox', {
      name: 'Edit Markdown source for recovery.md',
    })
    await waitFor(() => expect(editor.closest('[inert]')).not.toBeNull())
    expect(screen.getByRole('status').textContent).toContain('Editing is paused')
    fireEvent.change(editor, { target: { value: 'keystroke during close permit' } })
    expect(owner.get(binding)?.draft).toBe('unsaved exact draft')

    const notice = {
      transitionId: 99,
      sessionGeneration: 1,
      reason: 'logout' as const,
    }
    act(() => harness.onPreclear?.(notice))
    expect(await screen.findByTestId('markdown-auth-neutral-surface')).toBeTruthy()
    expect(owner.get(binding)).toMatchObject({ draft: 'unsaved exact draft', closeReserved: true })

    await act(async () => {
      harness.onPreclearCancelled?.(notice)
      await Promise.resolve()
      await Promise.resolve()
    })
    await waitFor(() => expect(authCalls.getMarkdownTabClosePermitStatus).toHaveBeenCalled())
    expect(owner.get(binding)).toMatchObject({
      draft: 'unsaved exact draft',
      closeReserved: true,
      closeAuthorizationPending: true,
    })
    expect(authCalls.cancelMarkdownTabClosePermit).not.toHaveBeenCalled()
    await waitFor(() => expect(authCalls.consumeMarkdownTabClosePermit).toHaveBeenCalledOnce())
    expect(owner.get(binding)).toMatchObject({ draft: 'unsaved exact draft', closeReserved: true })
    expect(harness.controller.workspaceTabs.tabs.some(tab => tab.id === tabId)).toBe(true)

    await act(async () => resolveConsume('consumed'))
    expect(owner.get(binding)).toBeNull()
    await waitFor(() =>
      expect(harness.controller.workspaceTabs.tabs.some(tab => tab.id === tabId)).toBe(false)
    )

    await act(async () => rejectAuthorize(new Error('lost authorization response')))
    restoreBridge()
  })

  it('retries a lost cancel response and keeps a rebound tab outside the old close request', async () => {
    let mainState = 'unknown'
    let statusAttempts = 0
    let cancelAttempts = 0
    let resolveConsume!: (state: string) => void
    const authCalls = {
      authorizeMarkdownTabClose: vi.fn<() => Promise<string>>(async () => {
        throw new Error('authorization response lost before main received the request')
      }),
      getMarkdownTabClosePermitStatus: vi.fn(async () => {
        statusAttempts += 1
        if (statusAttempts === 1) return 'unknown'
        return mainState
      }),
      cancelMarkdownTabClosePermit: vi.fn<() => Promise<string>>(async () => {
        cancelAttempts += 1
        mainState = 'cancelled'
        throw new Error('cancellation response lost')
      }),
      consumeMarkdownTabClosePermit: vi.fn(
        () =>
          new Promise<string>(resolve => {
            resolveConsume = state => {
              mainState = state
              resolve(state)
            }
          })
      ),
    }
    const restoreBridge = installAuthBridge(authCalls)
    const tabId = 'markdown-close-rebound-tab'
    const originalUri = 'gfs://main/markdown-before-rebind'
    const reboundUri = 'gfs://main/markdown-after-rebind'
    const tabs = openPreviewTab(createWorkspaceTabsState('chat-tab-1'), {
      id: tabId,
      title: 'rebound.md',
      gfsUri: originalUri,
      fileKind: 'markdown',
      byteLength: 32,
    })
    harness.controller = makeController(tabs)
    const owner = harness.controller.markdownDraftOwner
    const originalBinding = {
      principalOwner: harness.controller.markdownPrincipalOwner!,
      scopeKey: 'integration-principal-owner/team-a/default',
      tabId,
      gfsUri: originalUri,
    }
    owner.open(originalBinding, { sessionGeneration: 1 })
    const originalRead = owner.beginStableRead(originalBinding)!
    owner.completeStableRead(originalRead, { content: 'saved original', version: 1, stable: true })
    const originalCapability = owner.beginCapabilityRefresh(originalBinding)!
    owner.completeCapabilityRefresh(originalCapability, true)
    owner.beginEdit(originalBinding)
    owner.type(originalBinding, 'discarded original draft')

    render(
      <QueryClientProvider client={desktopQueryClient}>
        <App />
      </QueryClientProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Close rebound.md' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Discard and Close' }))
    await waitFor(() => expect(authCalls.cancelMarkdownTabClosePermit).toHaveBeenCalledOnce())
    await waitFor(() => expect(authCalls.getMarkdownTabClosePermitStatus).toHaveBeenCalledTimes(2))
    expect(authCalls.consumeMarkdownTabClosePermit).not.toHaveBeenCalled()
    expect(owner.get(originalBinding)).toMatchObject({
      draft: 'discarded original draft',
      closeReserved: false,
    })
    expect(harness.controller.workspaceTabs.tabs.some(tab => tab.id === tabId)).toBe(true)

    mainState = 'granted'
    statusAttempts = 0
    cancelAttempts = 0
    authCalls.authorizeMarkdownTabClose.mockImplementation(async () => 'granted')
    authCalls.getMarkdownTabClosePermitStatus.mockImplementation(async () => mainState)
    authCalls.cancelMarkdownTabClosePermit.mockImplementation(async () => 'granted')

    const closeAgain = screen.getByRole('button', { name: 'Close rebound.md' })
    fireEvent.click(closeAgain)
    fireEvent.click(await screen.findByRole('button', { name: 'Discard and Close' }))
    await waitFor(() => expect(authCalls.consumeMarkdownTabClosePermit).toHaveBeenCalledOnce())

    const reboundBinding = { ...originalBinding, gfsUri: reboundUri }
    act(() =>
      harness.controller.setWorkspaceTabs(state => ({
        ...state,
        tabs: state.tabs.map(tab => {
          if (tab.id !== tabId || tab.kind !== 'preview' || !tab.preview) return tab
          return { ...tab, preview: { ...tab.preview, gfsUri: reboundUri } }
        }),
      }))
    )
    owner.open(reboundBinding, { sessionGeneration: 1 })
    await act(async () => resolveConsume('consumed'))

    expect(owner.get(originalBinding)).toBeNull()
    expect(owner.get(reboundBinding)).not.toBeNull()
    expect(
      harness.controller.workspaceTabs.tabs.some(
        tab => tab.id === tabId && tab.kind === 'preview' && tab.preview?.gfsUri === reboundUri
      )
    ).toBe(true)
    restoreBridge()
  })
})
