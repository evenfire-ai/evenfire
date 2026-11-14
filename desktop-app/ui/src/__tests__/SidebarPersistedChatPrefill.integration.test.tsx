// @vitest-environment jsdom
import { type ComponentProps, type ReactNode, StrictMode } from 'react'
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentTaskTrackerProvider } from '@contexts/AgentTaskTrackerContext'
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import fc, { type AsyncCommand } from 'fast-check'
import { promises as fs } from 'node:fs'
import { installAppControllerClerum } from '@hooks/domain/__tests__/__fixtures__/appControllerHarness'
import {
  deferred,
  serverSessionMessages,
  serverSessions,
} from '@hooks/domain/__tests__/__fixtures__/catalogFixtures'
import { renderController } from '@hooks/domain/__tests__/__fixtures__/controllerHarness'
import { ipcHostAccessRevoked } from '@hooks/domain/__tests__/__fixtures__/ipcErrors'
import {
  installMockClerum,
  uninstallMockClerum,
} from '@hooks/domain/__tests__/__fixtures__/mockClerum'
import {
  getComposerDraftRevision,
  getComposerDraft as getStoredComposerDraft,
  resetComposerDraftStore,
  subscribeComposerDraft,
} from '@lib/composerDraftStore'
import * as composerDraftStore from '@lib/composerDraftStore'
import {
  clearLatestGfsConversationContext,
  getLatestGfsConversationContext,
} from '@lib/gfsConversationPrefill'
import { describeGfsReadError } from '@lib/gfsGrantErrors'
import * as persistedPrefillDecision from '@lib/persistedConversationPrefillDecision'
import { desktopQueryDefaults } from '@lib/queryClient'
import { App } from '@/App'
import { USER_SCOPE_INVALIDATED } from '@/gfs/__fixtures__/entityChangeFixtures'
import {
  accessibleResource,
  affordancesResult,
  childView,
  heldAffordances,
  listAccessiblePage,
  listChildrenPage,
  openGfsResourcePayload,
  resolveDeniedMessage,
  resolveResource,
  resolvedDirectory,
  resolvedFile,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
import { GfsClient, type GfsTransport } from '../../../src/gfs/uriHandler.js'

const drawerHeader = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }))
const receiptProbe = vi.hoisted(() => ({
  ids: [] as number[],
  statuses: [] as string[],
  scope: '',
  tabId: '',
}))
const appTestActions = vi.hoisted(() => ({
  holdHost: null as ((agentRef?: string, chatId?: string) => Promise<void>) | null,
  openTargetPromise: null as Promise<void> | null,
  selectChatAgent: null as
    | ((agentRef: string, options?: { chatId?: string; selectLatest?: boolean }) => void)
    | null,
  prefillEvents: [] as string[],
  prefillAttempts: [] as number[],
  auth: null as null | {
    setEmail: (value: string) => void
    setPassword: (value: string) => void
    handleLogout: () => Promise<void>
    handlePasswordLogin: () => Promise<void>
    loadSession: (options?: { preserveNav?: boolean }) => Promise<void>
  },
  emitEntityChange: null as ((event: unknown) => void) | null,
  scopeCommitProbe: null as null | {
    scope: string
    agentRef: string
    chatId: string
    tabId: string
  },
  firstScopeCommit: null as null | {
    scope: string
    visibleText: string | null
    projectedText: string
    originText: string
    projectedRevision: number
    originRevision: number
  },
}))
function getComposerDraft(
  chatId: string | null,
  agentRef?: string,
  tabId: string | undefined = receiptProbe.tabId || undefined,
  authorityScope: string | undefined = receiptProbe.scope || undefined
): string {
  return getStoredComposerDraft(chatId, agentRef, tabId, authorityScope)
}
vi.mock('@contexts/AgentChatProviders', async importOriginal => {
  const actual = await importOriginal<typeof import('@contexts/AgentChatProviders')>()
  const React = await import('react')
  const { AuthContext } = await import('@contexts/AuthContext')
  const { useNotificationsContext } = await import('@contexts/NotificationsContext')
  const { useNavigationContext } = await import('@contexts/NavigationContext')
  const { useChatComposerStateContext } = await import('@contexts/ChatComposerStateContext')
  const { useAgentChatActionsContext } = await import('@contexts/AgentChatActionsContext')
  const ReceiptProbe = () => {
    const {
      persistedConversationPrefillReceipt: receipt,
      workspaceChatTabId,
      authorityScope,
      pendingDeletionRevision,
      resourceActivationId,
    } = useChatComposerStateContext()
    receiptProbe.scope = authorityScope ?? ''
    receiptProbe.tabId = workspaceChatTabId ?? ''
    React.useLayoutEffect(() => {
      const probe = appTestActions.scopeCommitProbe
      if (!probe || !authorityScope || authorityScope === probe.scope) return
      if (appTestActions.firstScopeCommit) return
      appTestActions.firstScopeCommit = {
        scope: authorityScope,
        visibleText:
          (document.querySelector('[data-testid="chat-input"]') as HTMLTextAreaElement | null)
            ?.value ?? null,
        projectedText: getStoredComposerDraft(
          probe.chatId,
          probe.agentRef,
          probe.tabId,
          authorityScope
        ),
        originText: getStoredComposerDraft(probe.chatId, probe.agentRef, probe.tabId, probe.scope),
        projectedRevision: getComposerDraftRevision(
          probe.chatId,
          probe.agentRef,
          probe.tabId,
          authorityScope
        ),
        originRevision: getComposerDraftRevision(
          probe.chatId,
          probe.agentRef,
          probe.tabId,
          probe.scope
        ),
      }
    }, [authorityScope])
    const auth = React.useContext(AuthContext)
    if (receipt) {
      receiptProbe.ids.push(receipt.id)
      receiptProbe.statuses.push(receipt.status)
    }
    return React.createElement('output', {
      hidden: true,
      'data-testid': 'prefill-receipt-probe',
      'data-receipt-id': receipt?.id ?? '',
      'data-receipt-status': receipt?.status ?? 'none',
      'data-receipt-origin': receipt?.origin ?? '',
      'data-resource-uri': receipt?.resource.uri ?? '',
      'data-source-tab-id': receipt?.resource.sourceTabId ?? '',
      'data-workspace-chat-tab-id': workspaceChatTabId ?? '',
      'data-authority-scope': authorityScope ?? '',
      'data-destination-tab-id': receipt?.destinationWorkspaceTabId ?? '',
      'data-authenticated': auth?.isAuthenticated ? 'true' : 'false',
      'data-team-id': auth?.me?.teamId ?? '',
      'data-session-generation': auth?.sessionGeneration ?? '',
      'data-pending-deletion-revision': pendingDeletionRevision ?? 0,
      'data-resource-activation-id': resourceActivationId ?? '',
    })
  }
  const HostHoldProbe = () => {
    const { handleRenameChatForAgent } = useAgentChatActionsContext()
    appTestActions.holdHost = (agentRef = 'agent-a', chatId = 'chat-a') =>
      handleRenameChatForAgent(agentRef, chatId, 'Trigger host access hold')
    return null
  }
  const ScopeChangeProbe = () => {
    const { handleOpenNotification } = useNotificationsContext()
    const navigation = useNavigationContext()
    const auth = React.useContext(AuthContext)
    appTestActions.selectChatAgent = (agentRef, options) =>
      navigation.handleSelectChatAgent(agentRef, options)
    if (auth) {
      appTestActions.auth = {
        setEmail: auth.setEmail,
        setPassword: auth.setPassword,
        handleLogout: auth.handleLogout,
        handlePasswordLogin: auth.handlePasswordLogin,
        loadSession: auth.loadSession,
      }
    }
    return React.createElement('div', null, [
      React.createElement(
        'button',
        {
          key: 'cross-team',
          type: 'button',
          'data-testid': 'open-cross-team-latest-chat',
          onClick: () => {
            appTestActions.openTargetPromise = handleOpenNotification({
              id: 'cross-team-latest-chat',
              kind: 'assistant_reply',
              agentName: 'agent-a',
              teamId: 'team-2',
              text: 'Open the latest conversation in the new team',
              timestamp: 1,
              read: false,
            })
          },
        },
        'Open latest chat in another team'
      ),
      React.createElement(
        'button',
        {
          key: 'open-same-scope-stale-target',
          type: 'button',
          'data-testid': 'open-same-scope-stale-target',
          onClick: () => {
            appTestActions.openTargetPromise = handleOpenNotification({
              id: 'same-scope-stale-target',
              kind: 'assistant_reply',
              agentName: 'agent-y',
              chatId: 'chat-y',
              teamId: 'team-1',
              text: 'Open the stale target',
              timestamp: 2,
              read: false,
            })
          },
        },
        'Open same-scope stale target'
      ),
      React.createElement(
        'button',
        {
          key: 'open-second-same-scope-stale-target',
          type: 'button',
          'data-testid': 'open-second-same-scope-stale-target',
          onClick: () => {
            appTestActions.openTargetPromise = handleOpenNotification({
              id: 'second-same-scope-stale-target',
              kind: 'assistant_reply',
              agentName: 'agent-z',
              chatId: 'chat-z',
              teamId: 'team-1',
              text: 'Open the second stale target',
              timestamp: 5,
              read: false,
            })
          },
        },
        'Open second same-scope stale target'
      ),
      React.createElement(
        'button',
        {
          key: 'open-cross-team-same-chat',
          type: 'button',
          'data-testid': 'open-cross-team-same-chat',
          onClick: () => {
            appTestActions.openTargetPromise = handleOpenNotification({
              id: 'cross-team-same-chat',
              kind: 'assistant_reply',
              agentName: 'agent-a',
              chatId: CHAT,
              teamId: 'team-2',
              text: 'Open the same conversation in the new team',
              timestamp: 3,
              read: false,
            })
          },
        },
        'Open same chat in another team'
      ),
      React.createElement(
        'button',
        {
          key: 'open-team-one-same-chat',
          type: 'button',
          'data-testid': 'open-team-one-same-chat',
          onClick: () => {
            appTestActions.openTargetPromise = handleOpenNotification({
              id: 'team-one-same-chat',
              kind: 'assistant_reply',
              agentName: 'agent-a',
              chatId: CHAT,
              teamId: 'team-1',
              text: 'Return to the same conversation in Team A',
              timestamp: 4,
              read: false,
            })
          },
        },
        'Return to same chat in Team A'
      ),
    ])
  }
  return {
    ...actual,
    AgentChatProviders: ({
      children,
      ...props
    }: ComponentProps<typeof actual.AgentChatProviders>) => {
      const attemptHandlerRef = React.useRef(
        props.composerState.onPersistedConversationPrefillAttempt
      )
      attemptHandlerRef.current = props.composerState.onPersistedConversationPrefillAttempt
      const onPersistedConversationPrefillAttempt = React.useCallback(
        (receiptId: number, inputText: string) => {
          appTestActions.prefillAttempts.push(receiptId)
          return attemptHandlerRef.current?.(receiptId, inputText)
        },
        []
      )
      return React.createElement(actual.AgentChatProviders, {
        ...props,
        composerState: {
          ...props.composerState,
          onComposerPrefillEvent: (...args) => {
            appTestActions.prefillEvents.push(args[0])
            return props.composerState.onComposerPrefillEvent?.(...args)
          },
          onPersistedConversationPrefillAttempt,
        },
        children: React.createElement(
          React.Fragment,
          null,
          React.createElement(ReceiptProbe),
          React.createElement(HostHoldProbe),
          React.createElement(ScopeChangeProbe),
          children
        ),
      })
    },
  }
})

vi.mock('@components/AppHeader', () => ({
  AppHeader: (props: Record<string, unknown>) => {
    drawerHeader.props = props
    const visible = Boolean(props.chatDrawerOpen)
    const available = Boolean(props.drawerAvailable)
    return (
      <button
        type="button"
        aria-label={visible ? 'Close chat drawer' : 'Open chat drawer'}
        disabled={!available}
        onClick={props.onToggleChatDrawer as (() => void) | undefined}
      />
    )
  },
}))
vi.mock('@components/agents/ChatThread', async importOriginal => {
  const actual = await importOriginal<typeof import('@components/agents/ChatThread')>()
  const { useChatListContext } = await import('@contexts/ChatListContext')
  const React = await import('react')
  return {
    ...actual,
    ChatThread: (props: ComponentProps<typeof actual.ChatThread>) => {
      const { activeChatId } = useChatListContext()
      return React.createElement(
        React.Fragment,
        null,
        React.createElement(
          'div',
          { 'data-testid': 'chat-thread-stub' },
          activeChatId ?? 'no-active-chat'
        ),
        React.createElement(actual.ChatThread, props)
      )
    },
  }
})
vi.mock('@components/agents/ChatStateBadge', () => ({ ChatStateBadge: () => null }))
vi.mock('@components/BootSplash', () => ({ BootSplash: () => null }))
vi.mock('@components/ChatLocalSearch', () => ({ ChatLocalSearch: () => null }))
vi.mock('@components/CommandPalette', () => ({ CommandPalette: () => null }))
vi.mock('@components/GfsImagePreview', () => ({ GfsImagePreview: () => null }))
vi.mock('@components/PluginConsentModal', () => ({ PluginConsentModal: () => null }))
vi.mock('@pages/AgentsPage', () => ({ AgentsPage: () => null }))
vi.mock('@pages/AuthPage', async () => {
  const { useAuthContext } = await import('@contexts/AuthContext')
  return {
    AuthPage: () => {
      const auth = useAuthContext()
      return (
        <form
          onSubmit={event => {
            event.preventDefault()
            void auth.handlePasswordLogin()
          }}
        >
          <label>
            Email
            <input
              aria-label="Email"
              value={auth.email}
              onChange={event => auth.setEmail(event.target.value)}
            />
          </label>
          <label>
            Password
            <input
              aria-label="Password"
              type="password"
              value={auth.password}
              onChange={event => auth.setPassword(event.target.value)}
            />
          </label>
          <button type="submit">Sign in</button>
        </form>
      )
    },
  }
})
vi.mock('@pages/ContextDetailsPage', () => ({ ContextDetailsPage: () => null }))
vi.mock('@pages/ContextsPage', () => ({ ContextsPage: () => null }))
vi.mock('@pages/FilePreviewPage', () => ({ FilePreviewPage: () => null }))
vi.mock('@pages/McpServersPage', () => ({ McpServersPage: () => null }))
vi.mock('@pages/OnboardingPage', () => ({ OnboardingPage: () => null }))
vi.mock('@pages/SandboxUiPage', () => ({ SandboxUiPage: () => null }))
vi.mock('@pages/SettingsPage', () => ({ SettingsPage: () => null }))
vi.mock('@pages/UnavailablePage', () => ({ UnavailablePage: () => null }))
vi.mock('@pages/WorkflowsPage', () => ({ WorkflowsPage: () => null }))

const USER = 'agent-a'
const CHAT = 'chat-a'
const U_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const V_ID = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const PREVIEW_ID = 'cccccccccccccccccccccccccccccccc'
const OTHER_PREVIEW_ID = 'dddddddddddddddddddddddddddddddd'
const U_URI = `gfs://main/${U_ID}`
const V_URI = `gfs://main/${V_ID}`
const PREVIEW_URI = `gfs://main/${PREVIEW_ID}`
const OTHER_PREVIEW_URI = `gfs://main/${OTHER_PREVIEW_ID}`

type Setup = Awaited<ReturnType<typeof setupApp>>
type PluginOpenGfsResourcePayload = Awaited<ReturnType<typeof openGfsResourcePayload>>
let cleanupClerum: (() => void) | null = null
let resizeCallbacks: Array<(width: number) => void> = []
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let activeGfs: Setup['gfs']

type SetupAppOptions = {
  initialTeamId?: string
  prepareStore?: (clerum: ReturnType<typeof installAppControllerClerum>['clerum']) => Promise<void>
  includeSecondPreview?: boolean
  previewName?: string
}

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  })
})

async function setupApp(
  sessions = [{ agent: USER, chatId: CHAT, title: 'Earlier chat' }],
  strict = false,
  agentNames = [USER],
  withEntityChanges = false,
  options: SetupAppOptions = {}
) {
  receiptProbe.ids = []
  receiptProbe.statuses = []
  appTestActions.holdHost = null
  appTestActions.openTargetPromise = null
  appTestActions.selectChatAgent = null
  appTestActions.prefillEvents = []
  appTestActions.prefillAttempts = []
  appTestActions.auth = null
  appTestActions.emitEntityChange = null
  appTestActions.scopeCommitProbe = null
  appTestActions.firstScopeCommit = null
  const { clerum: installedClerum } = installAppControllerClerum(
    options.initialTeamId
      ? {
          agentNames,
          me: { teamId: options.initialTeamId, teamName: options.initialTeamId },
          teamDirectory: { items: [], currentTeamId: options.initialTeamId },
        }
      : { agentNames }
  )
  const clerum = installedClerum as typeof installedClerum & {
    access: { refreshCatalog: Mock }
    auth: { getSessionState: Mock }
    sandboxUi: { setVisible: Mock }
  }
  cleanupClerum = () => {
    delete (window as { clerum?: unknown }).clerum
  }
  const folderU = await resolveResource(
    resolvedDirectory(U_ID, 'Folder U', { path: '/Folder U', parentResourceId: null })
  )
  const folderV = await resolveResource(
    resolvedDirectory(V_ID, 'Folder V', {
      path: '/Folder U/Folder V',
      parentResourceId: U_ID,
    })
  )
  const previewName = options.previewName ?? 'Notes.md'
  const rootPage = await listAccessiblePage([
    accessibleResource(U_ID, 'Folder U', 'directory', {
      path: '/Folder U',
      parentResourceId: null,
    }),
  ])
  const childViews = [
    childView(V_ID, 'Folder V', 'directory', {
      path: '/Folder U/Folder V',
      parentResourceId: U_ID,
    }),
    childView(PREVIEW_ID, previewName, 'file', {
      path: '/Folder U/Notes.md',
      parentResourceId: U_ID,
      bytes: 32,
    }),
  ]
  if (options.includeSecondPreview) {
    childViews.push(
      childView(OTHER_PREVIEW_ID, 'Guide.md', 'file', {
        path: '/Folder U/Guide.md',
        parentResourceId: U_ID,
        bytes: 48,
      })
    )
  }
  const childPage = await listChildrenPage(childViews)
  const emptyPage = await listChildrenPage([])
  const affordances = await affordancesResult(heldAffordances([]))
  clerum.rpc.listSessions.mockResolvedValue(serverSessions(sessions))
  clerum.rpc.loadSessionMessages.mockResolvedValue(await serverSessionMessages(USER, CHAT))
  Object.assign(clerum.rpc, {
    getHostModels: vi.fn(async () => ({
      provider: 'zai',
      hostDefault: 'glm-5.3',
      sessionModel: null,
      degraded: false,
      models: [],
    })),
  })
  const appBridge = clerum as unknown as {
    auth: { getSessionGeneration: Mock<(...args: any[]) => any> }
    team: { switch: Mock<(...args: any[]) => any> }
  }
  Object.assign(appBridge.auth, { getSessionGeneration: vi.fn(async () => 1) })
  const gfs = {
    listAccessible: vi.fn(async () => rootPage),
    listChildren: vi.fn(async (resourceId: string) =>
      resourceId === U_ID ? childPage : emptyPage
    ),
    resolve: vi.fn(async (uri: string) => {
      if (uri === U_URI) return folderU
      if (uri === V_URI) return folderV
      if (uri === PREVIEW_URI) {
        return resolvedFile(PREVIEW_ID, previewName, {
          path: '/Folder U/Notes.md',
          parentResourceId: U_ID,
          bytes: 32,
        })
      }
      if (uri === OTHER_PREVIEW_URI) {
        return resolvedFile(OTHER_PREVIEW_ID, 'Guide.md', {
          path: '/Folder U/Guide.md',
          parentResourceId: U_ID,
          bytes: 48,
        })
      }
      throw new Error(`Unexpected GFS URI ${uri}`)
    }),
    affordances: vi.fn(async () => affordances),
    getUserNavigationGeneration: vi.fn(() => 0),
    advanceUserNavigationGeneration: vi.fn(() => 1),
    getPathForFile: vi.fn((file: File) => `/fixture/${file.name}`),
  }
  const pluginResourceListeners = new Set<(payload: PluginOpenGfsResourcePayload) => void>()
  Object.assign(clerum, {
    pluginSdk: {
      onOpenGfsResource: vi.fn((listener: (payload: PluginOpenGfsResourcePayload) => void) => {
        pluginResourceListeners.add(listener)
        return () => pluginResourceListeners.delete(listener)
      }),
    },
  })
  Object.assign(clerum, {
    gfs,
    shortcuts: { onCommand: vi.fn(() => vi.fn()) },
    app: { rendererReady: vi.fn().mockResolvedValue(undefined) },
    sandboxUi: {
      listApps: vi.fn().mockResolvedValue({ apps: [] }),
      listPendingDeepLinks: vi.fn().mockResolvedValue({ links: [] }),
      clearPendingDeepLinks: vi.fn().mockResolvedValue(undefined),
      onDeepLink: vi.fn(() => vi.fn()),
      onSessionInvalidated: vi.fn(() => vi.fn()),
      setVisible: vi.fn().mockResolvedValue(undefined),
      setBounds: vi.fn().mockResolvedValue(undefined),
      focusActive: vi.fn().mockResolvedValue(true),
      close: vi.fn().mockResolvedValue(undefined),
    },
  })
  if (withEntityChanges) {
    const subscribers = new Set<(event: unknown) => void>()
    Object.assign(clerum, {
      entityChanges: {
        subscribe: vi.fn(async (subscriber: (event: unknown) => void) => {
          subscribers.add(subscriber)
          return async () => {
            subscribers.delete(subscriber)
          }
        }),
      },
    })
    appTestActions.emitEntityChange = event => {
      subscribers.forEach(subscriber => subscriber(event))
    }
  }
  await options.prepareStore?.(clerum)
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (media: string) => ({
      matches: false,
      media,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  })
  activeGfs = gfs
  resizeCallbacks = []
  vi.stubGlobal(
    'ResizeObserver',
    class {
      private callback: ResizeObserverCallback
      private target: Element | null = null
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback
        resizeCallbacks.push(width =>
          this.callback(
            [{ target: this.target as Element, contentRect: { width } } as ResizeObserverEntry],
            this as unknown as ResizeObserver
          )
        )
      }
      observe(target: Element) {
        this.target = target
      }
      disconnect() {}
    }
  )
  drawerHeader.props = null
  const queryClient = new QueryClient({ defaultOptions: desktopQueryDefaults })
  const appTree = strict ? (
    <StrictMode>
      <App />
    </StrictMode>
  ) : (
    <App />
  )
  const view = render(
    <QueryClientProvider client={queryClient}>
      <AgentTaskTrackerProvider>{appTree}</AgentTaskTrackerProvider>
    </QueryClientProvider>
  )
  await waitFor(() => expect(screen.getByRole('button', { name: 'Files' })).toBeTruthy())
  await waitFor(() => {
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-authenticated')).toBe(
      'true'
    )
    expect(document.querySelector('.app-root')?.hasAttribute('inert')).toBe(false)
  })
  return {
    clerum,
    gfs,
    queryClient,
    view,
    emitPluginGfsResource(payload: PluginOpenGfsResourcePayload) {
      pluginResourceListeners.forEach(listener => listener(payload))
    },
  }
}

async function openFolderU() {
  fireEvent.click(screen.getByTestId('nav-files'))
  await screen.findByRole('button', { name: 'Open Folder U' })
  await clickFileName('Folder U')
  await waitFor(() => expect(getLatestGfsConversationContext()?.uri).toBe(U_URI))
}

async function clickFileName(name: string) {
  const button = Array.from(document.querySelectorAll('.da-gfs-list__name button')).find(
    element => element.textContent?.trim() === name
  )
  if (!(button instanceof HTMLElement)) throw new Error(`Missing Files row button: ${name}`)
  await act(async () => {
    fireEvent.click(button)
    await Promise.resolve()
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

async function navigateIntoV() {
  await screen.findByRole('button', { name: 'Open Folder V' })
  await clickFileName('Folder V')
  await waitFor(() => expect(getLatestGfsConversationContext()?.uri).toBe(V_URI))
}

async function restoreFolderU() {
  const breadcrumbs = screen.getByRole('navigation', { name: 'File location' })
  await act(async () => {
    fireEvent.click(within(breadcrumbs).getByRole('button', { name: 'Folder U' }))
    await Promise.resolve()
    await new Promise(resolve => setTimeout(resolve, 0))
  })
  await waitFor(() => expect(getLatestGfsConversationContext()?.uri).toBe(U_URI))
}

async function switchWorkspaceTab(title: string) {
  const strip = screen.getByRole('toolbar', { name: 'Workspace tabs' })
  fireEvent.click(within(strip).getByRole('button', { name: title }))
}

async function openChatDrawer() {
  resizeAppTo(1200)
  await waitFor(() => expect(Boolean(drawerHeader.props?.drawerAvailable)).toBe(true))
  if (!screen.queryByRole('complementary', { name: 'Chat' })) {
    const toggle = screen.getByRole('button', { name: 'Open chat drawer' })
    expect((toggle as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(toggle)
  }
  await screen.findByRole('complementary', { name: 'Chat' })
  await screen.findByTestId('chat-input')
}

async function selectSidebarConversation() {
  const button = await screen.findByRole('button', { name: 'Open Earlier chat' })
  fireEvent.click(button)
  return screen.findByTestId('chat-input')
}

function resizeAppTo(width: number) {
  const panel = document.querySelector('.content-panel') as HTMLElement | null
  if (panel && !Object.getOwnPropertyDescriptor(panel, 'clientWidth')) {
    Object.defineProperty(panel, 'clientWidth', { configurable: true, get: () => width })
  } else if (panel) {
    Object.defineProperty(panel, 'clientWidth', { configurable: true, get: () => width })
  }
  act(() => resizeCallbacks.forEach(callback => callback(width)))
}

afterEach(async () => {
  cleanup()
  await act(async () => {
    await Promise.resolve()
    await new Promise(resolve => setTimeout(resolve, 25))
    await Promise.resolve()
  })
  cleanupClerum?.()
  cleanupClerum = null
  resetComposerDraftStore()
  receiptProbe.ids = []
  receiptProbe.statuses = []
  appTestActions.holdHost = null
  appTestActions.openTargetPromise = null
  appTestActions.prefillEvents = []
  appTestActions.auth = null
  appTestActions.scopeCommitProbe = null
  appTestActions.firstScopeCommit = null
  clearLatestGfsConversationContext()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(window, 'matchMedia')
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
})

describe('r4 A6 real App persisted-conversation acceptance', () => {
  it('R2-M1 reuses retained Files context after closing its source tab on exact Chat', async () => {
    const { clerum } = await setupApp()
    await openFolderU()
    const initialInput = (await selectSidebarConversation()) as HTMLTextAreaElement
    await waitFor(() => expect(initialInput.value).toBe(U_URI))
    const context = getLatestGfsConversationContext()
    expect(context).toMatchObject({ uri: U_URI })
    expect(context?.sourceTabId).toBeTruthy()

    const strip = screen.getByRole('toolbar', { name: 'Workspace tabs' })
    fireEvent.click(within(strip).getByRole('button', { name: 'Close Folder U' }))
    await waitFor(() =>
      expect(within(strip).queryByRole('button', { name: 'Folder U' })).toBeNull()
    )
    expect(getLatestGfsConversationContext()).toMatchObject({
      uri: U_URI,
      sourceTabId: context?.sourceTabId,
    })
    expect(
      within(strip).getByRole('button', { name: 'Earlier chat' }).getAttribute('aria-pressed')
    ).toBe('true')

    fireEvent.change(initialInput, { target: { value: '' } })
    await waitFor(() => expect(getComposerDraft(CHAT, USER)).toBe(''))
    await act(async () => {
      await Promise.resolve()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(initialInput.value).toBe('')
    expect(getComposerDraft(CHAT, USER)).toBe('')
    const draftRevisionBeforeReselection = getComposerDraftRevision(
      CHAT,
      USER,
      receiptProbe.tabId,
      receiptProbe.scope
    )

    const previousReceiptId = Number(
      screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Open Earlier chat' }))
    await waitFor(() => expect(initialInput.value).toBe(U_URI))
    await waitFor(() => expect(getComposerDraft(CHAT, USER)).toBe(U_URI))
    expect(getComposerDraftRevision(CHAT, USER, receiptProbe.tabId, receiptProbe.scope)).toBe(
      draftRevisionBeforeReselection + 1
    )
    expect(
      Number(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id'))
    ).toBeGreaterThan(previousReceiptId)
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-status')).toBe(
      'consumed'
    )
    expect(screen.getByTestId('chat-thread-stub').textContent).toBe(CHAT)
    expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
  })

  it('R2-M1 reuses retained Preview context after closing its source tab on exact Chat', async () => {
    const { clerum } = await setupApp()
    await openFolderU()
    await clickFileName('Notes.md')
    await waitFor(() => expect(getLatestGfsConversationContext()?.uri).toBe(PREVIEW_URI))
    const context = getLatestGfsConversationContext()
    const input = (await selectSidebarConversation()) as HTMLTextAreaElement
    await waitFor(() => expect(input.value).toBe(PREVIEW_URI))
    expect(context?.sourceTabId).toBeTruthy()

    const strip = screen.getByRole('toolbar', { name: 'Workspace tabs' })
    fireEvent.click(within(strip).getByRole('button', { name: 'Close Notes.md' }))
    await waitFor(() =>
      expect(within(strip).queryByRole('button', { name: 'Notes.md' })).toBeNull()
    )
    expect(getLatestGfsConversationContext()).toMatchObject({
      uri: PREVIEW_URI,
      sourceTabId: context?.sourceTabId,
    })

    fireEvent.change(input, { target: { value: '' } })
    await waitFor(() => expect(getComposerDraft(CHAT, USER)).toBe(''))
    await act(async () => {
      await Promise.resolve()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(input.value).toBe('')
    expect(getComposerDraft(CHAT, USER)).toBe('')
    const draftRevisionBeforeReselection = getComposerDraftRevision(
      CHAT,
      USER,
      receiptProbe.tabId,
      receiptProbe.scope
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Open Earlier chat' }))
    await waitFor(() => expect(input.value).toBe(PREVIEW_URI))
    await waitFor(() => expect(getComposerDraft(CHAT, USER)).toBe(PREVIEW_URI))
    expect(getComposerDraftRevision(CHAT, USER, receiptProbe.tabId, receiptProbe.scope)).toBe(
      draftRevisionBeforeReselection + 1
    )
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-status')).toBe(
      'consumed'
    )
    expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
  })

  it('revalidates the selected Preview owner before a later Chat activation', async () => {
    const { clerum, gfs } = await setupApp()
    await openFolderU()
    const initialInput = (await selectSidebarConversation()) as HTMLTextAreaElement
    await waitFor(() => expect(initialInput.value).toBe(U_URI))
    fireEvent.change(initialInput, { target: { value: '' } })
    await waitFor(() => expect(getComposerDraft(CHAT, USER)).toBe(''))

    await switchWorkspaceTab('Folder U')
    await screen.findByRole('button', { name: 'Open Notes.md' })
    await clickFileName('Notes.md')
    await waitFor(() => expect(getLatestGfsConversationContext()?.uri).toBe(PREVIEW_URI))
    const previewOwner = getLatestGfsConversationContext()
    expect(previewOwner?.sourceTabId).toBeTruthy()

    await switchWorkspaceTab('Folder U')
    await waitFor(() => expect(getLatestGfsConversationContext()?.uri).toBe(U_URI))
    await switchWorkspaceTab('Earlier chat')
    const chatInput = screen.getByTestId('chat-input') as HTMLTextAreaElement
    await waitFor(() => expect(chatInput.value).toBe(U_URI))
    fireEvent.change(chatInput, { target: { value: '' } })
    await waitFor(() => expect(getComposerDraft(CHAT, USER)).toBe(''))

    const resourceCallsBeforePreviewActivation = {
      resolve: gfs.resolve.mock.calls.length,
      children: gfs.listChildren.mock.calls.length,
      affordances: gfs.affordances.mock.calls.length,
    }
    const stalePreviewResolution = deferred<Awaited<ReturnType<typeof gfs.resolve>>>()
    gfs.resolve.mockImplementationOnce(() => stalePreviewResolution.promise)
    await switchWorkspaceTab('Notes.md')
    await waitFor(() =>
      expect(gfs.resolve).toHaveBeenCalledTimes(resourceCallsBeforePreviewActivation.resolve + 1)
    )
    expect(getLatestGfsConversationContext()).toBeNull()
    await switchWorkspaceTab('Earlier chat')
    const emptyChatInput = screen.getByTestId('chat-input') as HTMLTextAreaElement
    await waitFor(() => expect(emptyChatInput.value).toBe(''))
    await act(async () => {
      stalePreviewResolution.resolve(
        await resolveResource(
          resolvedFile(PREVIEW_ID, 'Notes.md', {
            path: '/Folder U/Notes.md',
            parentResourceId: U_ID,
            bytes: 32,
          })
        )
      )
      await stalePreviewResolution.promise
      await Promise.resolve()
    })
    expect(getLatestGfsConversationContext()).toBeNull()
    expect(emptyChatInput.value).toBe('')
    expect(getComposerDraft(CHAT, USER)).toBe('')

    const resolverCallsBeforeCurrentPreview = gfs.resolve.mock.calls.length
    await switchWorkspaceTab('Notes.md')
    await waitFor(() => expect(getLatestGfsConversationContext()?.uri).toBe(PREVIEW_URI))
    expect(getLatestGfsConversationContext()?.sourceTabId).toBe(previewOwner?.sourceTabId)
    expect(gfs.resolve).toHaveBeenCalledTimes(resolverCallsBeforeCurrentPreview + 1)
    expect(gfs.resolve).toHaveBeenLastCalledWith(PREVIEW_URI)
    expect(gfs.listChildren).toHaveBeenCalledTimes(resourceCallsBeforePreviewActivation.children)
    expect(gfs.affordances).toHaveBeenCalledTimes(resourceCallsBeforePreviewActivation.affordances)

    await switchWorkspaceTab('Earlier chat')
    const returnedChatInput = screen.getByTestId('chat-input') as HTMLTextAreaElement
    await waitFor(() => expect(returnedChatInput.value).toBe(PREVIEW_URI))
    expect(getComposerDraft(CHAT, USER)).toBe(PREVIEW_URI)
    expect(returnedChatInput.value.match(/gfs:\/\//g)).toHaveLength(1)
    expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
  })

  it('C1 carries workspace-tab and drawer-switcher activation origins', async () => {
    const targetChatId = 'chat-target'
    const { clerum } = await setupApp([
      { agent: USER, chatId: CHAT, title: 'Earlier chat' },
      { agent: USER, chatId: targetChatId, title: 'Target chat' },
    ])
    await openFolderU()
    fireEvent.click(await screen.findByRole('button', { name: 'Open Earlier chat' }))
    await waitFor(() =>
      expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).value).toBe(U_URI)
    )
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: '' } })
    await waitFor(() => expect(getComposerDraft(CHAT, USER)).toBe(''))
    await switchWorkspaceTab('Folder U')
    fireEvent.click(await screen.findByRole('button', { name: 'Open Target chat' }))
    await waitFor(() =>
      expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).value).toBe(U_URI)
    )
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: '' } })
    await waitFor(() => expect(getComposerDraft(targetChatId, USER)).toBe(''))
    await switchWorkspaceTab('Folder U')
    await screen.findByRole('button', { name: 'Open Notes.md' })
    await clickFileName('Notes.md')
    await waitFor(() => expect(getLatestGfsConversationContext()?.uri).toBe(PREVIEW_URI))
    await act(async () => {
      await Promise.resolve()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(getLatestGfsConversationContext()?.uri).toBe(PREVIEW_URI)

    await switchWorkspaceTab('Earlier chat')
    await waitFor(() =>
      expect(
        screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-origin')
      ).toMatch(/workspace-chat-tab|focus|visible/)
    )
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-resource-uri')).toBe(
      PREVIEW_URI
    )
    await waitFor(() =>
      expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).value).toBe(PREVIEW_URI)
    )
    expect(getComposerDraft(CHAT, USER)).toBe(PREVIEW_URI)

    await switchWorkspaceTab('Notes.md')
    await openChatDrawer()
    fireEvent.click(screen.getByRole('button', { name: 'Open chats' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Target chat' }))
    await waitFor(() =>
      expect(screen.getByTestId('chat-thread-stub').textContent).toBe(targetChatId)
    )
    await waitFor(() =>
      expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).value).toBe(PREVIEW_URI)
    )
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-origin')).toBe(
      'drawer-chat-switcher'
    )
    expect(getComposerDraft(targetChatId, USER)).toBe(PREVIEW_URI)
    expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
  })

  it('B1 mounts real App, Sidebar, Files producer, navigation, controller, and Composer', async () => {
    const { clerum, gfs } = await setupApp()
    await openFolderU()
    const context = getLatestGfsConversationContext()
    expect(context).toMatchObject({ uri: U_URI })
    expect(context?.sourceTabId).toBeTruthy()
    const composer = await selectSidebarConversation()
    await waitFor(() => expect((composer as HTMLTextAreaElement).value).toBe(U_URI))
    expect(getComposerDraft(CHAT, USER)).toBe(U_URI)
    expect(gfs.listAccessible).toHaveBeenCalled()
    expect(gfs.listChildren).toHaveBeenCalledWith(U_ID, 'main', undefined)
    expect(screen.getByTestId('chat-thread-stub').textContent).toBe(CHAT)
    expect(
      within(screen.getByRole('toolbar', { name: 'Workspace tabs' }))
        .getByRole('button', { name: 'Earlier chat' })
        .getAttribute('aria-pressed')
    ).toBe('true')
    expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
  })

  it('B2 inserts the new Files resource after mounted drawer same-chat reselect', async () => {
    const { clerum } = await setupApp()
    await openFolderU()
    const originalContext = getLatestGfsConversationContext()
    const firstComposer = await selectSidebarConversation()
    await waitFor(() => expect((firstComposer as HTMLTextAreaElement).value).toBe(U_URI))
    expect(screen.getByTestId('chat-thread-stub').textContent).toBe(CHAT)

    await switchWorkspaceTab('Folder U')
    await openChatDrawer()
    const drawerComposer = screen.getByTestId('chat-input') as HTMLTextAreaElement
    expect(screen.getByTestId('chat-thread-stub').textContent).toBe(CHAT)
    fireEvent.change(drawerComposer, { target: { value: '' } })
    await waitFor(() => expect(getComposerDraft(CHAT, USER)).toBe(''))

    await navigateIntoV()
    const changedContext = getLatestGfsConversationContext()
    expect(changedContext).toMatchObject({ uri: V_URI, sourceTabId: originalContext?.sourceTabId })
    expect(screen.getByRole('complementary', { name: 'Chat' })).toBeTruthy()

    await openChatDrawer()
    fireEvent.click(screen.getByRole('button', { name: 'Open chats' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Earlier chat' }))
    await act(async () => {
      await Promise.resolve()
      await new Promise(resolve => setTimeout(resolve, 0))
    })

    expect(screen.getByRole('complementary', { name: 'Chat' })).toBeTruthy()
    expect(screen.getByTestId('chat-thread-stub').textContent).toBe(CHAT)
    expect({
      storeText: getComposerDraft(CHAT, USER),
      visibleText: (screen.getByTestId('chat-input') as HTMLTextAreaElement).value,
    }).toEqual({ storeText: V_URI, visibleText: V_URI })
    expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
  })

  it('B3 restores the exact Files breadcrumb URI and source owner after U to V to U', async () => {
    await setupApp()
    await openFolderU()
    const ownerU = getLatestGfsConversationContext()?.sourceTabId
    await navigateIntoV()
    expect(getLatestGfsConversationContext()).toMatchObject({ uri: V_URI, sourceTabId: ownerU })
    await restoreFolderU()
    expect(getLatestGfsConversationContext()).toMatchObject({ uri: U_URI, sourceTabId: ownerU })
    expect(activeGfs.listChildren).toHaveBeenCalledWith(U_ID, 'main', undefined)
    expect(activeGfs.listChildren).toHaveBeenCalledWith(V_ID, 'main', undefined)
  })

  it('RS10 uses the current equal-URI owner after a genuine visibility event', async () => {
    const targetChatId = 'chat-target'
    const { clerum } = await setupApp([
      { agent: USER, chatId: CHAT, title: 'Earlier chat' },
      { agent: USER, chatId: targetChatId, title: 'Target chat' },
    ])
    await openFolderU()
    const captured = getLatestGfsConversationContext()
    expect(captured).toMatchObject({ uri: U_URI })
    await openChatDrawer()
    const sidebarSelection = await screen.findByRole('button', { name: 'Open Target chat' })
    const panel = document.querySelector('.content-panel') as HTMLElement
    Object.defineProperty(panel, 'clientWidth', { configurable: true, get: () => 700 })
    act(() => {
      sidebarSelection.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      resizeCallbacks.forEach(callback => callback(700))
    })
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Chat' })).toBeNull())
    const receiptId = screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')
    const capturedOwner = captured?.sourceTabId
    expect(receiptId).not.toBe('')
    expect(capturedOwner).toBeTruthy()
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-source-tab-id')).toBe(
      capturedOwner
    )

    await navigateIntoV()
    await openFolderU()
    const equalUriOtherOwner = getLatestGfsConversationContext()
    expect(equalUriOtherOwner).toMatchObject({ uri: U_URI })
    expect(equalUriOtherOwner?.sourceTabId).not.toBe(capturedOwner)
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-resource-uri')).toBe(
      U_URI
    )
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-source-tab-id')).toBe(
      capturedOwner
    )
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')).toBe(
      receiptId
    )
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-status')).toBe(
      'suspended-resource'
    )
    expect(getComposerDraft(targetChatId, USER)).toBe('')

    expect(getLatestGfsConversationContext()).toEqual(equalUriOtherOwner)
    resizeAppTo(1200)
    const composer = (await screen.findByTestId('chat-input')) as HTMLTextAreaElement
    await act(async () => {
      await Promise.resolve()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(composer.value).toBe(U_URI)
    expect(getComposerDraft(targetChatId, USER)).toBe(U_URI)
    expect(
      Number(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id'))
    ).toBeGreaterThan(Number(receiptId))
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-status')).toBe(
      'consumed'
    )
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-source-tab-id')).toBe(
      equalUriOtherOwner?.sourceTabId
    )
    expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
  })

  it('RS9 opens a Preview from the real Files file row and captures its exact tab owner', async () => {
    const { clerum } = await setupApp()
    await openFolderU()
    const filesOwner = getLatestGfsConversationContext()?.sourceTabId

    await clickFileName('Notes.md')
    await waitFor(() => expect(getLatestGfsConversationContext()?.uri).toBe(PREVIEW_URI))
    const previewContext = getLatestGfsConversationContext()
    expect(previewContext?.sourceTabId).toBeTruthy()
    expect(previewContext?.sourceTabId).not.toBe(filesOwner)
    expect(
      within(screen.getByRole('toolbar', { name: 'Workspace tabs' }))
        .getByRole('button', { name: 'Notes.md' })
        .getAttribute('aria-pressed')
    ).toBe('true')

    const composer = await selectSidebarConversation()
    await waitFor(() => expect((composer as HTMLTextAreaElement).value).toBe(PREVIEW_URI))
    expect(getComposerDraft(CHAT, USER)).toBe(PREVIEW_URI)
    expect(getLatestGfsConversationContext()).toEqual(previewContext)
    expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
  })

  it('B6 inserts after a resource activation while the chat input is visible', async () => {
    const { clerum } = await setupApp()
    await openFolderU()
    const composer = await selectSidebarConversation()
    await waitFor(() => expect((composer as HTMLTextAreaElement).value).toBe(U_URI))
    await switchWorkspaceTab('Folder U')
    await openChatDrawer()
    const input = screen.getByTestId('chat-input') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: '' } })
    await waitFor(() => expect(getComposerDraft(CHAT, USER)).toBe(''))

    await navigateIntoV()
    expect(getLatestGfsConversationContext()).toMatchObject({ uri: V_URI })
    expect(screen.getByTestId('chat-thread-stub').textContent).toBe(CHAT)
    await waitFor(() => expect(getComposerDraft(CHAT, USER)).toBe(V_URI))
    expect(input.value).toBe(V_URI)
    expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
  })

  it('A3-5 refills once after clear and a later genuine blur/refocus', async () => {
    const { clerum, gfs } = await setupApp()
    await openFolderU()
    const input = (await selectSidebarConversation()) as HTMLTextAreaElement
    await waitFor(() => expect(input.value).toBe(U_URI))
    expect(getComposerDraft(CHAT, USER)).toBe(U_URI)
    const firstReceiptId = Number(
      screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')
    )
    const revisionAfterFirstInsertion = getComposerDraftRevision(
      CHAT,
      USER,
      receiptProbe.tabId,
      receiptProbe.scope
    )
    const accessibleCalls = gfs.listAccessible.mock.calls.length
    const resolveCalls = gfs.resolve.mock.calls.length

    fireEvent.change(input, { target: { value: '' } })
    await waitFor(() => expect(getComposerDraft(CHAT, USER)).toBe(''))
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 25))
      await Promise.resolve()
    })
    expect(input.value).toBe('')
    expect(getComposerDraftRevision(CHAT, USER, receiptProbe.tabId, receiptProbe.scope)).toBe(
      revisionAfterFirstInsertion + 1
    )

    fireEvent.blur(input)
    fireEvent.focus(input)

    await waitFor(() => expect(input.value).toBe(U_URI))
    expect(getComposerDraft(CHAT, USER)).toBe(U_URI)
    expect(input.value.match(/gfs:\/\//g)).toHaveLength(1)
    expect(getComposerDraftRevision(CHAT, USER, receiptProbe.tabId, receiptProbe.scope)).toBe(
      revisionAfterFirstInsertion + 2
    )
    expect(
      Number(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id'))
    ).toBeGreaterThan(firstReceiptId)
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-status')).toBe(
      'consumed'
    )
    expect(gfs.listAccessible).toHaveBeenCalledTimes(accessibleCalls)
    expect(gfs.resolve).toHaveBeenCalledTimes(resolveCalls)
    expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
  })

  it('A3-1 fills when reopening the Chat drawer without selecting another conversation', async () => {
    const { clerum } = await setupApp()
    await openFolderU()
    const selectedInput = (await selectSidebarConversation()) as HTMLTextAreaElement
    await act(async () => {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    })
    fireEvent.blur(selectedInput)
    fireEvent.focus(selectedInput)
    await waitFor(() => expect(selectedInput.value).toBe(U_URI))
    await switchWorkspaceTab('Folder U')
    await openChatDrawer()
    const input = screen.getByTestId('chat-input') as HTMLTextAreaElement
    await waitFor(() => expect(input.value).toBe(U_URI))

    const openReceiptId = Number(
      screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')
    )
    const revisionBeforeClear = getComposerDraftRevision(
      CHAT,
      USER,
      receiptProbe.tabId,
      receiptProbe.scope
    )
    fireEvent.change(input, { target: { value: '' } })
    await waitFor(() => expect(getComposerDraft(CHAT, USER)).toBe(''))
    expect(getComposerDraftRevision(CHAT, USER, receiptProbe.tabId, receiptProbe.scope)).toBe(
      revisionBeforeClear + 1
    )
    fireEvent.blur(input)
    fireEvent.click(screen.getByRole('button', { name: 'Close chat drawer' }))
    await waitFor(() => expect(screen.queryByTestId('chat-input')).toBeNull())
    expect(
      within(screen.getByRole('toolbar', { name: 'Workspace tabs' }))
        .getByRole('button', { name: 'Folder U' })
        .getAttribute('aria-pressed')
    ).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: 'Open chat drawer' }))
    const reopenedInput = (await screen.findByTestId('chat-input')) as HTMLTextAreaElement
    await waitFor(() => expect(reopenedInput.value).toBe(U_URI))

    expect(getComposerDraft(CHAT, USER)).toBe(U_URI)
    expect(reopenedInput.value.match(/gfs:\/\//g)).toHaveLength(1)
    expect(getComposerDraftRevision(CHAT, USER, receiptProbe.tabId, receiptProbe.scope)).toBe(
      revisionBeforeClear + 2
    )
    expect(screen.getByTestId('chat-thread-stub').textContent).toBe(CHAT)
    expect(
      within(screen.getByRole('toolbar', { name: 'Workspace tabs' }))
        .getByRole('button', { name: 'Folder U' })
        .getAttribute('aria-pressed')
    ).toBe('true')
    expect(
      Number(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id'))
    ).toBeGreaterThan(openReceiptId)
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-status')).toBe(
      'consumed'
    )
    expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
  })

  it('C1 fills on Chat route visibility with no focus or resource activation event', async () => {
    const { clerum, gfs } = await setupApp()
    await openFolderU()
    const selectedInput = (await selectSidebarConversation()) as HTMLTextAreaElement
    await waitFor(() => expect(selectedInput.value).toBe(U_URI))
    fireEvent.change(selectedInput, { target: { value: '' } })
    await waitFor(() => expect(getComposerDraft(CHAT, USER)).toBe(''))

    await switchWorkspaceTab('Folder U')
    await waitFor(() => expect(getLatestGfsConversationContext()?.uri).toBe(U_URI))
    const activationId = getLatestGfsConversationContext()?.activationId
    const revisionBeforeVisibility = getComposerDraftRevision(
      CHAT,
      USER,
      receiptProbe.tabId,
      receiptProbe.scope
    )
    const receiptBeforeVisibility = Number(
      screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')
    )
    const resolveCalls = gfs.resolve.mock.calls.length
    const listCalls = gfs.listAccessible.mock.calls.length
    const affordanceCalls = gfs.affordances.mock.calls.length
    appTestActions.prefillEvents = []

    fireEvent.click(screen.getByRole('button', { name: 'Chat' }))
    const visibleInput = (await screen.findByTestId('chat-input')) as HTMLTextAreaElement
    await waitFor(() => expect(visibleInput.value).toBe(U_URI))

    expect(appTestActions.prefillEvents).toEqual(['visible'])
    expect(getLatestGfsConversationContext()).toMatchObject({
      uri: U_URI,
      sourceTabId: expect.any(String),
      activationId,
    })
    expect(getComposerDraft(CHAT, USER)).toBe(U_URI)
    expect(visibleInput.value.match(/gfs:\/\//g)).toHaveLength(1)
    expect(getComposerDraftRevision(CHAT, USER, receiptProbe.tabId, receiptProbe.scope)).toBe(
      revisionBeforeVisibility + 1
    )
    const receiptAfterVisibility = screen.getByTestId('prefill-receipt-probe')
    expect(Number(receiptAfterVisibility.getAttribute('data-receipt-id'))).toBeGreaterThan(
      receiptBeforeVisibility
    )
    expect(receiptAfterVisibility.getAttribute('data-receipt-origin')).toBe('visible')
    expect(gfs.resolve).toHaveBeenCalledTimes(resolveCalls)
    expect(gfs.listAccessible).toHaveBeenCalledTimes(listCalls)
    expect(gfs.affordances).toHaveBeenCalledTimes(affordanceCalls)
    expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
  })

  it('a canceled real Sidebar delete leaves the target eligible', async () => {
    const { clerum } = await setupApp()
    await openFolderU()
    const composer = (await selectSidebarConversation()) as HTMLTextAreaElement
    await waitFor(() => expect(composer.value).toBe(U_URI))
    await switchWorkspaceTab('Folder U')
    await openChatDrawer()
    const input = screen.getByTestId('chat-input') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: '' } })
    await waitFor(() => expect(getComposerDraft(CHAT, USER)).toBe(''))

    fireEvent.click(screen.getByRole('button', { name: 'Session options for Earlier chat' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    const dialog = await screen.findByRole('dialog', { name: 'Delete session?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Delete session?' })).toBeNull()
    )
    expect(clerum.chat.delete).not.toHaveBeenCalled()

    fireEvent.focus(input)
    await waitFor(() => expect(input.value).toBe(U_URI))
    expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
  })

  it('T15 resolves an uncertain IPC reply from committed local status and terminalizes its receipt', async () => {
    const targetChatId = 'chat-target'
    const { clerum } = await setupApp([
      { agent: USER, chatId: CHAT, title: 'Earlier chat' },
      { agent: USER, chatId: targetChatId, title: 'Target chat' },
    ])
    await openFolderU()
    await switchWorkspaceTab('Folder U')
    await openChatDrawer()
    const panel = document.querySelector('.content-panel') as HTMLElement
    Object.defineProperty(panel, 'clientWidth', { configurable: true, get: () => 700 })
    const targetSelection = await screen.findByRole('button', { name: 'Open Target chat' })
    act(() => {
      targetSelection.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      resizeCallbacks.forEach(callback => callback(700))
    })
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Chat' })).toBeNull())
    const originalReceiptId = screen
      .getByTestId('prefill-receipt-probe')
      .getAttribute('data-receipt-id')
    expect(originalReceiptId).not.toBe('')
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-status')).toBe(
      'bound-eligible'
    )
    const destinationTabId = receiptProbe.tabId
    const authorityScope = receiptProbe.scope
    expect(getComposerDraft(targetChatId, USER, destinationTabId, authorityScope)).toBe('')
    const actualDelete = clerum.chat.delete.getMockImplementation()
    const actualDeletionStatus = clerum.chat.deletionStatus.getMockImplementation()
    if (!actualDelete || !actualDeletionStatus) {
      throw new Error('Expected real ChatStore deletion and status boundaries')
    }
    const observedStatuses: string[] = []
    clerum.chat.deletionStatus.mockImplementation(async (...args) => {
      const status = await actualDeletionStatus(...args)
      observedStatuses.push(status.status)
      return status
    })
    clerum.chat.delete.mockImplementationOnce(async (...args) => {
      await actualDelete(...args)
      throw new Error('Delete committed but its IPC reply was lost')
    })
    const indexWriteEntered = deferred<void>()
    const releaseIndexWrite = deferred<void>()
    const originalWriteFile = fs.writeFile.bind(fs)
    let indexWriteHeld = false
    const writeBarrier = vi.spyOn(fs, 'writeFile').mockImplementation(async (...args: any[]) => {
      const result = await Reflect.apply(originalWriteFile, fs, args)
      if (String(args[0]).endsWith('/index.json.tmp') && !indexWriteHeld) {
        indexWriteHeld = true
        indexWriteEntered.resolve()
        await releaseIndexWrite.promise
      }
      return result
    })

    try {
      fireEvent.click(screen.getByRole('button', { name: 'Session options for Target chat' }))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
      const dialog = await screen.findByRole('dialog', { name: 'Delete session?' })
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
      await indexWriteEntered.promise

      expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')).toBe(
        originalReceiptId
      )
      await act(async () => {
        await Promise.resolve()
        await new Promise(resolve => setTimeout(resolve, 0))
      })
      expect(getComposerDraft(targetChatId, USER, destinationTabId, authorityScope)).toBe('')
      expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
      expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')).toBe(
        originalReceiptId
      )
      expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-status')).toBe(
        'bound-eligible'
      )
      await act(async () => {
        releaseIndexWrite.resolve()
        await Promise.allSettled([
          ...clerum.chat.delete.mock.results.map(result => result.value),
          ...clerum.chat.deletionStatus.mock.results.map(result => result.value),
        ])
        await Promise.resolve()
      })
      await waitFor(() =>
        expect(
          screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-status')
        ).toBe('terminally-cancelled')
      )
      expect(clerum.chat.deletionStatus).toHaveBeenCalledWith(
        USER,
        targetChatId,
        expect.objectContaining({ teamId: 'team-1' })
      )
      expect(observedStatuses).toEqual(['deleted'])
      expect(clerum.chat.delete).toHaveBeenCalledTimes(1)
      expect((await clerum.readIndex(USER)).deletedChatTombstones).toContainEqual(
        expect.objectContaining({ chatId: targetChatId })
      )
      expect(getComposerDraft(targetChatId, USER, destinationTabId, authorityScope)).toBe('')
      expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
    } finally {
      releaseIndexWrite.resolve()
      await act(async () => {
        await Promise.allSettled([
          ...clerum.chat.delete.mock.results.map(result => result.value),
          ...clerum.chat.deletionStatus.mock.results.map(result => result.value),
        ])
        await new Promise(resolve => setTimeout(resolve, 0))
      })
      writeBarrier.mockRestore()
    }
  })

  it('ignores a delayed deleted result from a different authenticated user scope', async () => {
    const { clerum } = await setupApp()
    await openFolderU()
    await selectSidebarConversation()
    await waitFor(() => expect(getComposerDraft(CHAT, USER)).toBe(U_URI))
    await switchWorkspaceTab('Folder U')
    await openChatDrawer()

    const actualDelete = clerum.chat.delete.getMockImplementation()
    const actualDeletionStatus = clerum.chat.deletionStatus.getMockImplementation()
    if (!actualDelete || !actualDeletionStatus) {
      throw new Error('Expected real ChatStore deletion and status boundaries')
    }
    const aStatusReady = deferred<string>()
    const releaseAStatus = deferred<void>()
    clerum.chat.delete.mockImplementationOnce(async (...args) => {
      await actualDelete(...args)
      throw new Error('Committed deletion whose IPC reply was lost')
    })
    clerum.chat.deletionStatus.mockImplementation(async (...args) => {
      const status = await actualDeletionStatus(...args)
      if (args[2]?.userId === 'user-1') {
        aStatusReady.resolve(status.status)
        await releaseAStatus.promise
      }
      return status
    })

    try {
      fireEvent.click(screen.getByRole('button', { name: 'Session options for Earlier chat' }))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
      const dialog = await screen.findByRole('dialog', { name: 'Delete session?' })
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
      await waitFor(() => expect(clerum.chat.delete).toHaveBeenCalledTimes(1))
      await expect(aStatusReady.promise).resolves.toBe('deleted')

      // Switch through App's real logout and session-load paths while only the
      // already-authoritative A result delivery is held.
      let sessionState: {
        authenticated: boolean
        me: { id: string; email: string; name: string; teamId: string; teamName: string } | null
        sessionGeneration: number
      } = { authenticated: false, me: null, sessionGeneration: 2 }
      const authBridge = clerum as unknown as {
        auth: {
          getSessionState: Mock<(...args: any[]) => any>
          logout: Mock<(...args: any[]) => any>
        }
        access: { refreshCatalog: Mock<(...args: any[]) => any> }
      }
      authBridge.auth.getSessionState.mockImplementation(async () => sessionState)
      authBridge.auth.logout.mockResolvedValue({ ok: true, sessionGeneration: 2 })
      const authActions = appTestActions.auth
      if (!authActions) throw new Error('Expected the real App authentication actions')
      await act(async () => authActions.handleLogout())
      await screen.findByRole('button', { name: 'Sign in' })

      sessionState = {
        authenticated: true,
        me: {
          id: 'user-2',
          email: 'second@clerum.io',
          name: 'Second User',
          teamId: 'team-1',
          teamName: 'Team 1',
        },
        sessionGeneration: 3,
      }
      const actualRefreshCatalog = authBridge.access.refreshCatalog.getMockImplementation()
      if (!actualRefreshCatalog) throw new Error('Expected the real catalog fixture producer')
      authBridge.access.refreshCatalog.mockImplementation(async (...args: any[]) => ({
        ...(await actualRefreshCatalog(...args)),
        userId: 'user-2',
      }))
      fireEvent.change(screen.getByLabelText('Email'), {
        target: { value: 'second@clerum.io' },
      })
      fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'test-password' } })
      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
      await waitFor(() =>
        expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-authenticated')).toBe(
          'true'
        )
      )
      await waitFor(() =>
        expect(
          screen.getByTestId('prefill-receipt-probe').getAttribute('data-authority-scope')
        ).toContain('user-2')
      )

      expect(
        (
          await actualDeletionStatus(USER, CHAT, {
            environmentKey: 'harness-environment',
            userId: 'user-2',
            teamId: 'team-1',
          })
        ).status
      ).toBe('not-deleted')

      await openFolderU()
      resizeAppTo(1200)
      await waitFor(() => expect(Boolean(drawerHeader.props?.drawerAvailable)).toBe(true))
      fireEvent.click(screen.getByRole('button', { name: 'Open chat drawer' }))
      await screen.findByRole('complementary', { name: 'Chat' })
      const panel = document.querySelector('.content-panel') as HTMLElement
      Object.defineProperty(panel, 'clientWidth', { configurable: true, get: () => 700 })
      const selection = await screen.findByRole('button', { name: 'Open Earlier chat' })
      act(() => {
        selection.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        resizeCallbacks.forEach(callback => callback(700))
      })
      await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Chat' })).toBeNull())
      const bReceipt = screen.getByTestId('prefill-receipt-probe')
      const bReceiptId = bReceipt.getAttribute('data-receipt-id')
      expect(bReceiptId).not.toBe('')
      expect(bReceipt.getAttribute('data-receipt-status')).toBe('bound-eligible')
      expect(getComposerDraft(CHAT, USER)).toBe('')

      // B has a distinct authenticated user scope even though the ChatStore
      // target ID is equal. Make B's real Composer visible while A's already-
      // authoritative deleted result is still held; A's pending UI attempt
      // must not gate or suppress B's exact-scope receipt.
      resizeAppTo(1200)
      await waitFor(() => expect(screen.getByRole('complementary', { name: 'Chat' })).toBeTruthy())
      await waitFor(() =>
        expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).value).toBe(U_URI)
      )
      expect(getComposerDraft(CHAT, USER)).toBe(U_URI)
      const visibleBReceiptId = screen
        .getByTestId('prefill-receipt-probe')
        .getAttribute('data-receipt-id')
      expect(visibleBReceiptId).not.toBe(bReceiptId)
      expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')).toBe(
        visibleBReceiptId
      )
      expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-status')).toBe(
        'consumed'
      )

      await act(async () => {
        releaseAStatus.resolve()
        await Promise.resolve()
        await new Promise(resolve => setTimeout(resolve, 0))
      })
      await waitFor(() =>
        expect(clerum.chat.deletionStatus).toHaveBeenCalledWith(
          USER,
          CHAT,
          expect.objectContaining({ userId: 'user-1' })
        )
      )
      expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')).toBe(
        visibleBReceiptId
      )
      expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-status')).toBe(
        'consumed'
      )
      expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).value).toBe(U_URI)
      expect(getComposerDraft(CHAT, USER)).toBe(U_URI)

      // The stale A result must not poison B's subsequent same-target event
      // through the current-scope deleted-chat projection.
      const consumedReceiptId = Number(visibleBReceiptId)
      const input = screen.getByTestId('chat-input') as HTMLTextAreaElement
      fireEvent.change(input, { target: { value: '' } })
      await waitFor(() => expect(getComposerDraft(CHAT, USER)).toBe(''))
      fireEvent.blur(input)
      fireEvent.focus(input)
      await waitFor(() => expect(input.value).toBe(U_URI))
      expect(
        Number(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id'))
      ).toBeGreaterThan(consumedReceiptId)
      expect(input.value.match(/gfs:\/\//g)).toHaveLength(1)
      expect(getComposerDraft(CHAT, USER)).toBe(U_URI)
      expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
      expect(clerum.chat.delete).toHaveBeenCalledTimes(1)
    } finally {
      await act(async () => {
        releaseAStatus.resolve()
        await new Promise(resolve => setTimeout(resolve, 0))
      })
    }
  })

  it('T14 holds real Sidebar deletion before index commit and keeps unrelated reselection eligible', async () => {
    const { clerum } = await setupApp([
      { agent: USER, chatId: CHAT, title: 'Earlier chat' },
      { agent: USER, chatId: 'chat-unrelated', title: 'Unrelated chat' },
    ])
    await openFolderU()
    const composer = await selectSidebarConversation()
    await waitFor(() => expect((composer as HTMLTextAreaElement).value).toBe(U_URI))
    await switchWorkspaceTab('Folder U')
    await openChatDrawer()
    const input = screen.getByTestId('chat-input') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: '' } })
    await waitFor(() => expect(getComposerDraft(CHAT, USER)).toBe(''))

    const indexWriteEntered = deferred<void>()
    const releaseIndexWrite = deferred<void>()
    const originalWriteFile = fs.writeFile.bind(fs)
    const writeBarrier = vi.spyOn(fs, 'writeFile').mockImplementation(async (...args: any[]) => {
      const result = await Reflect.apply(originalWriteFile, fs, args)
      const path = String(args[0])
      if (path.endsWith('.index.json.tmp') || path.endsWith('/index.json.tmp')) {
        indexWriteEntered.resolve()
        await releaseIndexWrite.promise
      }
      return result
    })

    try {
      fireEvent.click(screen.getByRole('button', { name: 'Session options for Earlier chat' }))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
      const dialog = await screen.findByRole('dialog', { name: 'Delete session?' })
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
      await indexWriteEntered.promise

      const beforePending = Number(
        screen.getByTestId('prefill-receipt-probe').getAttribute('data-pending-deletion-revision')
      )
      expect(clerum.chat.delete).toHaveBeenCalledTimes(1)
      expect(beforePending).toBeGreaterThan(0)

      const beforeReselectId = Number(
        screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')
      )
      const beforeReselectStatus = screen
        .getByTestId('prefill-receipt-probe')
        .getAttribute('data-receipt-status')
      fireEvent.click(screen.getByRole('button', { name: 'Open Earlier chat' }))
      await waitFor(() => expect(screen.getByTestId('chat-thread-stub').textContent).toBe(CHAT))
      expect(
        Number(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id'))
      ).toBe(beforeReselectId)
      fireEvent.blur(input)
      fireEvent.focus(input)
      await act(async () => {
        await Promise.resolve()
        await new Promise(resolve => setTimeout(resolve, 0))
      })
      expect(input.value).toBe('')
      expect(getComposerDraft(CHAT, USER)).toBe('')
      expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-status')).toBe(
        beforeReselectStatus
      )
      expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()

      fireEvent.click(screen.getByRole('button', { name: 'Open Unrelated chat' }))
      await waitFor(() =>
        expect(screen.getByTestId('chat-thread-stub').textContent).toBe('chat-unrelated')
      )
      const unrelatedInput = screen.getByTestId('chat-input') as HTMLTextAreaElement
      await waitFor(() => expect(unrelatedInput.value).toBe(U_URI))
      expect(clerum.chat.delete).toHaveBeenCalledTimes(1)
    } finally {
      releaseIndexWrite.resolve()
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0))
      })
      writeBarrier.mockRestore()
    }
  })

  it('A3-20 keeps an A-team pending gate out of the same-user B-team destination', async () => {
    const { clerum } = await setupApp()
    await openFolderU()
    const initialComposer = (await selectSidebarConversation()) as HTMLTextAreaElement
    await waitFor(() => expect(initialComposer.value).toBe(U_URI))
    await switchWorkspaceTab('Folder U')
    await openChatDrawer()
    const input = screen.getByTestId('chat-input') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: '' } })
    await waitFor(() => expect(getComposerDraft(CHAT, USER)).toBe(''))
    const scopeA = receiptProbe.scope
    expect(scopeA).toContain('team-1')
    // The real ChatStore must already contain this shared destination. Without
    // a durable index, the tombstone sidecar alone makes deletion status
    // ambiguous and correctly resolves as unknown.
    await clerum.chat.create(USER, CHAT)
    expect((await clerum.readIndex(USER)).chats.map(chat => chat.id)).toContain(CHAT)

    const indexWriteEntered = deferred<void>()
    const releaseIndexWrite = deferred<void>()
    const deleteSettled = deferred<{ kind: 'fulfilled'; result: unknown } | { kind: 'rejected' }>()
    const bStatusStarted = deferred<void>()
    const bStatusResolved = deferred<'deleted' | 'not-deleted' | 'unknown'>()
    let bStatusCallCount = 0
    const bStatusObserved: Array<'deleted' | 'not-deleted' | 'unknown'> = []
    const originalWriteFile = fs.writeFile.bind(fs)
    const actualDelete = clerum.chat.delete.getMockImplementation()
    const actualDeletionStatus = clerum.chat.deletionStatus.getMockImplementation()
    if (!actualDelete || !actualDeletionStatus) {
      throw new Error('Expected the real ChatStore deletion and status boundaries')
    }
    const writeBarrier = vi.spyOn(fs, 'writeFile').mockImplementation(async (...args: any[]) => {
      const result = await Reflect.apply(originalWriteFile, fs, args)
      const path = String(args[0])
      if (path.endsWith('.index.json.tmp') || path.endsWith('/index.json.tmp')) {
        indexWriteEntered.resolve()
        await releaseIndexWrite.promise
      }
      return result
    })
    clerum.chat.delete.mockImplementation(async (...args) => {
      try {
        const result = await actualDelete(...args)
        deleteSettled.resolve({ kind: 'fulfilled', result })
        return result
      } catch {
        deleteSettled.resolve({ kind: 'rejected' })
        throw new Error('The captured ChatStore scope changed before index rename')
      }
    })
    clerum.chat.deletionStatus.mockImplementation(async (...args) => {
      const scope = args[2]
      // Match the real IPC authority fence after App has switched to team B.
      // B's status remains a real serialized ChatStore read.
      if (scope?.teamId === 'team-1') {
        throw new Error('The old team-A status request is outside current authority')
      }
      if (scope?.teamId === 'team-2') {
        bStatusCallCount += 1
        bStatusStarted.resolve()
      }
      const status = await actualDeletionStatus(...args)
      if (scope?.teamId === 'team-2') {
        bStatusObserved.push(status.status)
        bStatusResolved.resolve(status.status)
      }
      return status
    })

    try {
      fireEvent.click(screen.getByRole('button', { name: 'Session options for Earlier chat' }))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
      const dialog = await screen.findByRole('dialog', { name: 'Delete session?' })
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
      await indexWriteEntered.promise
      expect(clerum.chat.delete).toHaveBeenCalledTimes(1)

      fireEvent.click(screen.getByTestId('open-cross-team-same-chat'))
      await waitFor(() =>
        expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-team-id')).toBe(
          'team-2'
        )
      )
      await waitFor(() => expect(receiptProbe.scope).toContain(':team-2:'))
      expect(receiptProbe.scope).not.toBe(scopeA)
      const capturedScope = clerum.chat.captureDeleteFence.mock.calls[0]?.[0] as {
        environmentKey: string
        userId: string
        teamId: string
      }
      // This fixture seam mirrors the main-process ChatStore binding update
      // after App's real same-user team switch; deletion and status still run
      // through the real per-chat/index operation chain.
      clerum.setChatStoreAuthorityScope({
        ...capturedScope,
        teamId: 'team-2',
      })
      // The new-scope check waits on ChatStore's real per-chat/index queue. It
      // cannot accept the shared destination while D1 is still at precommit.
      await bStatusStarted.promise
      let bStatusSettled = false
      void bStatusResolved.promise.then(() => {
        bStatusSettled = true
      })
      await Promise.resolve()
      expect(bStatusSettled).toBe(false)
      await openFolderU()
      await openChatDrawer()
      const bComposer = screen.getByTestId('chat-input') as HTMLTextAreaElement
      fireEvent.click(await screen.findByRole('button', { name: 'Open Earlier chat' }))
      await waitFor(() => expect(bStatusCallCount).toBeGreaterThanOrEqual(2))
      const scopeB = receiptProbe.scope
      const tabB = receiptProbe.tabId
      expect(scopeB).not.toBe(scopeA)
      expect(bComposer.value).toBe('')
      expect(getStoredComposerDraft(CHAT, USER, tabB, scopeB)).toBe('')
      expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()

      releaseIndexWrite.resolve()
      const deleteOutcome = await deleteSettled.promise
      expect(deleteOutcome.kind).toBe('rejected')
      const firstBStatus = await bStatusResolved.promise
      expect(firstBStatus).toBe('not-deleted')
      await act(async () => {
        await appTestActions.openTargetPromise
        await Promise.resolve()
        await new Promise(resolve => setTimeout(resolve, 0))
      })
      expect((await clerum.readIndex(USER)).deletedChatTombstones ?? []).toHaveLength(0)
      expect(clerum.chat.deletionStatus).toHaveBeenCalledWith(
        USER,
        CHAT,
        expect.objectContaining({ teamId: 'team-2' })
      )
      await waitFor(() => expect(bStatusObserved.length).toBeGreaterThanOrEqual(2))
      // Notification admission, selection admission, and the awaiting-receipt
      // effect each use the real serialized status reader. React can replay the
      // effect as workspace state commits, so assert result correctness and
      // quiescence rather than an unsupported fixed read count.
      expect(bStatusObserved.every(status => status === 'not-deleted')).toBe(true)
      await waitFor(() => expect(bComposer.value).toBe(U_URI))
      expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-status')).toBe(
        'consumed'
      )
      await act(async () => {
        await Promise.allSettled(
          clerum.chat.deletionStatus.mock.results.map(result => result.value)
        )
        await Promise.resolve()
        await new Promise(resolve => setTimeout(resolve, 0))
      })
      const settledCalls = clerum.chat.deletionStatus.mock.results.length
      await act(async () => {
        await Promise.resolve()
        await new Promise(resolve => setTimeout(resolve, 0))
      })
      expect(clerum.chat.deletionStatus.mock.results).toHaveLength(settledCalls)
      expect(bComposer.value).toBe(U_URI)
      expect(getStoredComposerDraft(CHAT, USER, tabB, scopeB)).toBe(U_URI)
      expect(
        screen.queryByText(
          'Could not confirm whether the chat was deleted. Its status is still unknown.'
        )
      ).toBeNull()
    } finally {
      releaseIndexWrite.resolve()
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0))
      })
      writeBarrier.mockRestore()
    }
  })

  it('A3-20 lets an eligible Team B automatic write replace Team A shared-slot bytes', async () => {
    const { clerum, gfs } = await setupApp()
    await openFolderU()
    const composerA = (await selectSidebarConversation()) as HTMLTextAreaElement
    await waitFor(() => expect(composerA.value).toBe(U_URI))
    const scopeA = receiptProbe.scope
    const tabA = receiptProbe.tabId
    expect(scopeA).toContain(':team-1:')
    expect(getComposerDraft(CHAT, USER, tabA, scopeA)).toBe(U_URI)

    fireEvent.click(screen.getByTestId('open-cross-team-same-chat'))
    await act(async () => {
      await appTestActions.openTargetPromise
      await Promise.resolve()
    })
    await waitFor(() => expect(receiptProbe.scope).toContain(':team-2:'))
    const scopeB = receiptProbe.scope
    const notificationTargetTabB = receiptProbe.tabId
    clerum.setChatStoreAuthorityScope({
      environmentKey: 'harness-environment',
      userId: 'user-1',
      teamId: 'team-2',
    })
    expect(getComposerDraft(CHAT, USER, notificationTargetTabB, scopeB)).toBe('')
    expect(getComposerDraft(CHAT, USER, tabA, scopeA)).toBe(U_URI)
    expect(composerA.value).not.toBe(U_URI)

    // B publishes a different canonical resource through the real Files owner.
    fireEvent.click(screen.getByTestId('nav-files'))
    await screen.findByRole('button', { name: 'Open Folder U' })
    await clickFileName('Folder U')
    await navigateIntoV()
    expect(getLatestGfsConversationContext()).toMatchObject({ uri: V_URI })
    const fetchCountsBeforeChatActivation = [
      gfs.resolve.mock.calls.length,
      gfs.listChildren.mock.calls.length,
      gfs.affordances.mock.calls.length,
    ]

    const receiptBeforeChatTabActivation = Math.max(...receiptProbe.ids)
    await switchWorkspaceTab('Earlier chat')
    await waitFor(() =>
      expect(Math.max(...receiptProbe.ids)).toBeGreaterThan(receiptBeforeChatTabActivation)
    )
    const tabB = receiptProbe.tabId
    expect(tabB).toBe(tabA)
    expect(
      screen.getByTestId('prefill-receipt-probe').getAttribute('data-destination-tab-id')
    ).toBe(tabB)
    const composerB = screen.getByTestId('chat-input') as HTMLTextAreaElement
    await waitFor(() => expect(composerB.value).toBe(V_URI))
    expect(getStoredComposerDraft(CHAT, USER, tabB, scopeB)).toBe(V_URI)
    expect(getComposerDraft(CHAT, USER, tabA, scopeA)).toBe('')
    expect(composerB.value.match(/gfs:\/\//g)).toHaveLength(1)
    expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
    expect([
      gfs.resolve.mock.calls.length,
      gfs.listChildren.mock.calls.length,
      gfs.affordances.mock.calls.length,
    ]).toEqual(fetchCountsBeforeChatActivation)

    fireEvent.click(screen.getByTestId('open-team-one-same-chat'))
    await act(async () => {
      await appTestActions.openTargetPromise
      await Promise.resolve()
    })
    await waitFor(() => expect(receiptProbe.scope).toContain(':team-1:'))
    const returnedComposer = screen.getByTestId('chat-input') as HTMLTextAreaElement
    expect(returnedComposer.value).toBe('')
    expect(getComposerDraft(CHAT, USER, tabA, scopeA)).toBe('')
    expect(getComposerDraft(CHAT, USER, tabB, scopeB)).toBe(V_URI)
    expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
  })

  it('blocks a Team A automatic URI send during the committed Team B handoff', async () => {
    const backgroundChatId = 'background-chat'
    const { clerum } = await setupApp(
      [
        { agent: USER, chatId: CHAT, title: 'Earlier chat' },
        { agent: USER, chatId: backgroundChatId, title: 'Background chat' },
      ],
      false,
      [USER]
    )
    await openFolderU()
    await openChatDrawer()

    const stopEntered = deferred<void>()
    const releaseStop = deferred<void>()
    const teamBridge = window.clerum.team
    const teamSwitchMock = teamBridge.switch as unknown as Mock<(...args: any[]) => any>
    const originalTeamSwitch = teamSwitchMock.getMockImplementation()
    if (!originalTeamSwitch) throw new Error('Expected the real team-switch bridge')
    const originalSubscribe = clerum.rpc.subscribeHostActivity.getMockImplementation()
    if (!originalSubscribe) throw new Error('Expected the real Host activity subscription boundary')
    clerum.rpc.subscribeHostActivity.mockImplementation(async (...args) => {
      const unsubscribe = await originalSubscribe(...args)
      return async () => {
        stopEntered.resolve()
        await releaseStop.promise
        await unsubscribe()
      }
    })

    try {
      // Start a real task in a separate chat so the real App teardown must await
      // the registered Host activity unsubscribe while chat C remains sendable.
      fireEvent.click(await screen.findByRole('button', { name: 'Open Background chat' }))
      await waitFor(() =>
        expect(screen.getByTestId('chat-thread-stub').textContent).toBe(backgroundChatId)
      )
      const backgroundInput = screen.getByTestId('chat-input') as HTMLTextAreaElement
      fireEvent.change(backgroundInput, { target: { value: 'Start an activity stream' } })
      fireEvent.keyDown(backgroundInput, { key: 'Enter', shiftKey: false })
      await waitFor(() => expect(clerum.rpc.invokeHostMessage).toHaveBeenCalledOnce())
      await waitFor(() => expect(clerum.hasActivityHandler(USER)).toBe(true))
      await waitFor(() => expect(backgroundInput.value).toBe(''))

      fireEvent.click(screen.getByRole('button', { name: 'Open Earlier chat' }))
      await waitFor(() => expect(screen.getByTestId('chat-thread-stub').textContent).toBe(CHAT))
      const input = screen.getByTestId('chat-input') as HTMLTextAreaElement
      await waitFor(() => expect(input.value).toBe(U_URI))
      await waitFor(() =>
        expect((screen.getByTestId('send-button') as HTMLButtonElement).disabled).toBe(false)
      )
      const scopeA = receiptProbe.scope
      const tabA = receiptProbe.tabId
      expect(scopeA).toContain(':team-1:')
      expect(getComposerDraft(CHAT, USER, tabA, scopeA)).toBe(U_URI)

      teamSwitchMock.mockImplementation(async teamId => {
        const state = await originalTeamSwitch(teamId)
        if (teamId === 'team-2') {
          clerum.setChatStoreAuthorityScope({
            environmentKey: 'harness-environment',
            userId: 'user-1',
            teamId,
          })
        }
        return state
      })

      let switchPromise: Promise<void> | null = null
      await act(async () => {
        fireEvent.click(screen.getByTestId('open-cross-team-same-chat'))
        switchPromise = appTestActions.openTargetPromise
        expect(switchPromise).toBeTruthy()
        await stopEntered.promise
      })
      expect(teamSwitchMock).toHaveBeenCalledWith('team-2')
      expect(receiptProbe.scope).toBe(scopeA)
      const handoffInput = screen.getByTestId('chat-input') as HTMLTextAreaElement
      expect(handoffInput.value).toBe(U_URI)

      // Exercise both producer paths at the handoff boundary. The transition
      // must reject queued Enter/click without sending Team A's URI to Team B.
      expect(handoffInput.value).toBe(U_URI)
      await act(async () => {
        fireEvent.keyDown(handoffInput, { key: 'Enter', shiftKey: false })
        fireEvent.click(screen.getByTestId('send-button'))
        await new Promise(resolve => setTimeout(resolve, 0))
      })
      const originalPayload = clerum.rpc.invokeHostMessage.mock.calls[0]?.[1] as {
        content?: string
      }
      expect(originalPayload.content).toBe('Start an activity stream')
      expect(clerum.rpc.invokeHostMessage).toHaveBeenCalledOnce()
      expect(handoffInput.value).toBe(U_URI)
      expect(getComposerDraft(CHAT, USER, tabA, scopeA)).toBe(U_URI)

      releaseStop.resolve()
      await act(async () => {
        await switchPromise
        await Promise.resolve()
      })
      await waitFor(() => expect(receiptProbe.scope).toContain(':team-2:'))
      expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).value).toBe('')
      expect(getComposerDraft(CHAT, USER, tabA, scopeA)).toBe(U_URI)
      expect(getComposerDraft(CHAT, USER, tabA, receiptProbe.scope)).toBe('')
      expect(clerum.rpc.invokeHostMessage).toHaveBeenCalledOnce()
    } finally {
      releaseStop.resolve()
      teamSwitchMock.mockImplementation(originalTeamSwitch)
      clerum.rpc.subscribeHostActivity.mockImplementation(originalSubscribe)
      await Promise.resolve()
    }
  })

  it('A3-20 rejects a cold-start target until its shared tombstone is hydrated', async () => {
    const scopeA = {
      environmentKey: 'harness-environment',
      userId: 'user-1',
      teamId: 'team-1',
    }
    const scopeB = { ...scopeA, teamId: 'team-2' }
    const indexReadEntered = deferred<void>()
    const releaseIndexRead = deferred<void>()
    const statusReadEntered = deferred<'deleted' | 'not-deleted' | 'unknown'>()
    const releaseStatusRead = deferred<void>()
    let statusReadValue: 'deleted' | 'not-deleted' | 'unknown' | null = null

    const { clerum } = await setupApp(undefined, false, [USER], false, {
      initialTeamId: 'team-2',
      prepareStore: async storeBridge => {
        await storeBridge.chat.create(USER, CHAT)
        const fence = await storeBridge.chat.captureDeleteFence(scopeA)
        await storeBridge.chat.delete(USER, CHAT, fence)
        expect((await storeBridge.readIndex(USER)).deletedChatTombstones).toContainEqual({
          chatId: CHAT,
          authorityScope: expect.objectContaining({ userId: 'user-1', teamId: 'team-1' }),
        })
        storeBridge.setChatStoreAuthorityScope(scopeB)
        storeBridge.rpc.listSessions.mockResolvedValue(
          serverSessions([{ agent: USER, chatId: CHAT, title: 'Earlier chat' }])
        )
        storeBridge.chat.getIndex.mockImplementation(async agentRef => {
          const index = await storeBridge.readIndex(agentRef)
          if (agentRef === USER) {
            indexReadEntered.resolve()
            await releaseIndexRead.promise
          }
          return index
        })
        const readDeletionStatus = storeBridge.chat.deletionStatus.getMockImplementation()
        if (!readDeletionStatus) throw new Error('Expected the real ChatStore status reader')
        storeBridge.chat.deletionStatus.mockImplementation(async (...args) => {
          const status = await readDeletionStatus(...args)
          if (args[2]?.teamId === 'team-2') {
            statusReadValue = status.status
            statusReadEntered.resolve(status.status)
            await releaseStatusRead.promise
          }
          return status
        })
      },
    })

    try {
      await indexReadEntered.promise
      await openFolderU()
      await openChatDrawer()
      const input = screen.getByTestId('chat-input') as HTMLTextAreaElement
      expect(getLatestGfsConversationContext()).toMatchObject({
        uri: U_URI,
        authorityScope: expect.stringContaining(':team-2:'),
      })
      expect(input.value).toBe('')

      await act(async () => {
        fireEvent.click(screen.getByTestId('open-cross-team-same-chat'))
      })
      const targetPromise = appTestActions.openTargetPromise
      expect(targetPromise).toBeTruthy()
      const admission = await Promise.race([
        statusReadEntered.promise.then(status => ({ kind: 'status' as const, status })),
        targetPromise!.then(() => ({ kind: 'completed' as const })),
      ])

      // In a cold renderer, the durable index read is still held before its
      // tombstone has reached the renderer cache. Admission must wait for the
      // actual serialized ChatStore status, which sees Team A's shared tombstone.
      if (admission.kind === 'status') {
        expect(admission.status).toBe('deleted')
        expect(statusReadValue).toBe('deleted')
        expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).value).toBe('')
        expect(screen.getByTestId('chat-thread-stub').textContent).not.toBe(CHAT)
        expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()

        releaseStatusRead.resolve()
        await targetPromise
      } else {
        // Let an unsafe accepted target finish loading from the held real
        // index so the shared-rendered Composer assertion below sees its effect.
        releaseIndexRead.resolve()
        await targetPromise
        await waitFor(() => expect(screen.getByTestId('chat-thread-stub').textContent).toBe(CHAT))
      }

      releaseIndexRead.resolve()
      await act(async () => {
        await targetPromise
        await new Promise(resolve => setTimeout(resolve, 0))
      })
      // Assert the user-visible destination invariant at quiescence before
      // inspecting the internal status-read discriminator. A cold-cache mutant
      // must fail because the tombstoned target was accepted, not merely
      // because an expected status lookup did not occur.
      expect(screen.getByTestId('chat-thread-stub').textContent).not.toBe(CHAT)
      expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).value).toBe('')
      expect(getComposerDraft(CHAT, USER, receiptProbe.tabId, receiptProbe.scope)).toBe('')
      expect(admission.kind).toBe('status')
      expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
      expect((await clerum.readIndex(USER)).deletedChatTombstones).toContainEqual({
        chatId: CHAT,
        authorityScope: expect.objectContaining({ userId: 'user-1', teamId: 'team-1' }),
      })
    } finally {
      releaseStatusRead.resolve()
      releaseIndexRead.resolve()
      await act(async () => {
        await Promise.allSettled(
          appTestActions.openTargetPromise ? [appTestActions.openTargetPromise] : []
        )
        await new Promise(resolve => setTimeout(resolve, 0))
      })
    }
  })

  it('A3-20 keeps a committed shared tombstone out of the same-user B-team destination', async () => {
    const { clerum } = await setupApp()
    clerum.chat.getIndex.mockImplementation(agentRef => clerum.readIndex(agentRef))
    await openFolderU()
    const composer = (await selectSidebarConversation()) as HTMLTextAreaElement
    await waitFor(() => expect(composer.value).toBe(U_URI))
    await switchWorkspaceTab('Folder U')
    await openChatDrawer()
    const scopeA = receiptProbe.scope
    expect(scopeA).toContain('team-1')

    const cleanupEntered = deferred<void>()
    const releaseCleanup = deferred<void>()
    const bIndexEntered = deferred<void>()
    const releaseBIndex = deferred<void>()
    const bStatusResults: Array<ReturnType<typeof deferred<void>>> = []
    const bStatusObserved: Array<'deleted' | 'not-deleted' | 'unknown'> = []
    let bIndexCalls = 0
    let bIndexSnapshot: Awaited<ReturnType<typeof clerum.readIndex>> | null = null
    const originalRename = fs.rename.bind(fs)
    const originalRm = fs.rm.bind(fs)
    let indexCommitObserved = false
    let cleanupHeld = false
    const renameBoundary = vi.spyOn(fs, 'rename').mockImplementation(async (...args: any[]) => {
      const result = await Reflect.apply(originalRename, fs, args)
      if (String(args[0]).endsWith('/index.json.tmp')) indexCommitObserved = true
      return result
    })
    const cleanupBoundary = vi.spyOn(fs, 'rm').mockImplementation(async (...args: any[]) => {
      if (indexCommitObserved && String(args[0]).endsWith(`/${CHAT}.json`) && !cleanupHeld) {
        cleanupHeld = true
        cleanupEntered.resolve()
        await releaseCleanup.promise
      }
      return Reflect.apply(originalRm, fs, args)
    })
    clerum.chat.getIndex.mockImplementation(async agentRef => {
      const index = await clerum.readIndex(agentRef)
      if (receiptProbe.scope.includes(':team-2:')) {
        bIndexCalls += 1
        bIndexSnapshot = index
        bIndexEntered.resolve()
        await releaseBIndex.promise
      }
      return index
    })
    const actualDeletionStatus = clerum.chat.deletionStatus.getMockImplementation()
    if (!actualDeletionStatus) throw new Error('Expected the real ChatStore status boundary')
    clerum.chat.deletionStatus.mockImplementation(async (...args) => {
      const status = await actualDeletionStatus(...args)
      if (args[2]?.teamId === 'team-2') {
        const release = deferred<void>()
        bStatusResults.push(release)
        bStatusObserved.push(status.status)
        await release.promise
      }
      return status
    })
    const releaseBStatusReads = async () => {
      let released = 0
      for (let pass = 0; pass < 4; pass += 1) {
        while (released < bStatusResults.length) {
          bStatusResults[released]?.resolve()
          released += 1
        }
        await act(async () => {
          await Promise.resolve()
          await new Promise(resolve => setTimeout(resolve, 0))
        })
        if (released === bStatusResults.length) return
      }
      expect(released).toBe(bStatusResults.length)
    }

    try {
      fireEvent.click(screen.getByRole('button', { name: 'Session options for Earlier chat' }))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
      const dialog = await screen.findByRole('dialog', { name: 'Delete session?' })
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
      await cleanupEntered.promise

      const committedIndex = await clerum.readIndex(USER)
      expect(committedIndex.deletedChatTombstones).toContainEqual({
        chatId: CHAT,
        authorityScope: expect.objectContaining({ userId: 'user-1', teamId: 'team-1' }),
      })
      const capturedScope = clerum.chat.captureDeleteFence.mock.calls[0]?.[0] as {
        environmentKey: string
        userId: string
        teamId: string
      }

      fireEvent.click(screen.getByTestId('open-cross-team-same-chat'))
      await waitFor(() =>
        expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-team-id')).toBe(
          'team-2'
        )
      )
      await waitFor(() => expect(receiptProbe.scope).not.toBe(scopeA))
      const scopeB = receiptProbe.scope
      expect(scopeB).toContain('team-2')
      clerum.setChatStoreAuthorityScope({ ...capturedScope, teamId: 'team-2' })

      await waitFor(() => expect(bIndexCalls).toBeGreaterThan(0))
      await bIndexEntered.promise
      await waitFor(() => expect(bStatusResults.length).toBeGreaterThan(0))
      expect(bStatusObserved.every(status => status === 'deleted')).toBe(true)
      expect(
        (bIndexSnapshot as Awaited<ReturnType<typeof clerum.readIndex>> | null)
          ?.deletedChatTombstones
      ).toContainEqual({
        chatId: CHAT,
        authorityScope: expect.objectContaining({ userId: 'user-1', teamId: 'team-1' }),
      })
      const bTab = receiptProbe.tabId
      expect(bTab).toBeTruthy()
      expect(getStoredComposerDraft(CHAT, USER, bTab, scopeB)).toBe('')
      expect(screen.getByTestId('chat-input')).toBeTruthy()
      // The tombstone snapshot is now captured. Release this index read so the
      // real Files owner can load and restore U; the authoritative deletion
      // status responses remain held below.
      releaseBIndex.resolve()

      // Real B reads observe the committed tombstone, but their renderer results
      // are held. Restore U through its real Files owner, then issue a newer real
      // same-chat notification while the first status response is still in flight.
      // The target must remain unaccepted until those results settle.
      await openFolderU()
      const bComposer = screen.getByTestId('chat-input') as HTMLTextAreaElement
      expect(bComposer.value).toBe('')
      expect(getStoredComposerDraft(CHAT, USER, bTab, scopeB)).toBe('')
      expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()

      await new Promise(resolve => setTimeout(resolve, 0))
      fireEvent.click(screen.getByTestId('open-cross-team-same-chat'))
      const repeatedOpen = appTestActions.openTargetPromise
      expect(repeatedOpen).toBeTruthy()
      // A cached durable tombstone may reject this producer synchronously
      // without another IPC status call. If the store needs a fresh status
      // read, it remains ordered behind the held per-chat operation. Both
      // paths must keep the committed destination terminal.
      await act(async () => {
        await Promise.resolve()
        await new Promise(resolve => setTimeout(resolve, 0))
      })
      // Notification admission, selection admission, and the awaiting-receipt
      // effect use the real serialized status reader. React may replay the
      // effect during workspace commits; the bounded drain and stable-count
      // assertions below reject continuing work without an unsupported fixed
      // request count that r13 does not specify.
      expect(bStatusObserved.every(status => status === 'deleted')).toBe(true)
      expect(bComposer.value).toBe('')
      expect(getStoredComposerDraft(CHAT, USER, bTab, scopeB)).toBe('')

      await releaseBStatusReads()
      await act(async () => {
        await repeatedOpen
      })
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: 'Open Earlier chat' })).toBeNull()
      )
      expect(bComposer.value).toBe('')
      expect(getStoredComposerDraft(CHAT, USER, bTab, scopeB)).toBe('')
      releaseCleanup.resolve()
      await act(async () => {
        await Promise.allSettled(clerum.chat.delete.mock.results.map(result => result.value))
      })
      await releaseBStatusReads()
      await act(async () => {
        await Promise.allSettled(
          clerum.chat.deletionStatus.mock.results.map(result => result.value)
        )
        await new Promise(resolve => setTimeout(resolve, 0))
      })
      expect((await clerum.readIndex(USER)).deletedChatTombstones).toContainEqual({
        chatId: CHAT,
        authorityScope: expect.objectContaining({ userId: 'user-1', teamId: 'team-1' }),
      })
      expect(receiptProbe.scope).toBe(scopeB)
      expect(getStoredComposerDraft(CHAT, USER, receiptProbe.tabId || undefined, scopeB)).toBe('')
      expect(screen.queryByText(U_URI)).toBeNull()
      expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
      const statusReadsAtQuiescence = bStatusResults.length
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0))
      })
      expect(bStatusResults.length).toBe(statusReadsAtQuiescence)
    } finally {
      await act(async () => {
        for (let index = 0; index < bStatusResults.length; index += 1) {
          bStatusResults[index]?.resolve()
        }
        releaseBIndex.resolve()
        releaseCleanup.resolve()
        await Promise.allSettled(clerum.chat.delete.mock.results.map(result => result.value))
      })
      cleanupBoundary.mockRestore()
      renameBoundary.mockRestore()
    }
  })

  it('clears the automatic draft after the real target is deleted', async () => {
    const { clerum } = await setupApp()
    await openFolderU()
    const input = (await selectSidebarConversation()) as HTMLTextAreaElement
    await waitFor(() => expect(input.value).toBe(U_URI))
    expect(getComposerDraft(CHAT, USER)).toBe(U_URI)

    const receipt = screen.getByTestId('prefill-receipt-probe')
    const workspaceChatTabId = receipt.getAttribute('data-workspace-chat-tab-id')
    const authorityScope = receipt.getAttribute('data-authority-scope')
    expect(workspaceChatTabId).toBeTruthy()
    expect(authorityScope).toBeTruthy()
    expect(receipt.getAttribute('data-destination-tab-id')).toBe(workspaceChatTabId)
    expect(receipt.getAttribute('data-receipt-status')).toBe('consumed')
    expect(
      getStoredComposerDraft(CHAT, USER, workspaceChatTabId, authorityScope ?? undefined)
    ).toBe(U_URI)

    fireEvent.click(screen.getByRole('button', { name: 'Session options for Earlier chat' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    const dialog = await screen.findByRole('dialog', { name: 'Delete session?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(clerum.chat.delete).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Open Earlier chat' })).toBeNull()
    )
    expect(
      getStoredComposerDraft(CHAT, USER, workspaceChatTabId, authorityScope ?? undefined)
    ).toBe('')
    expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
  })

  it('A3-16 keeps a committed chat terminal while real artifact cleanup is held', async () => {
    const { clerum } = await setupApp()
    await openFolderU()
    const composer = (await selectSidebarConversation()) as HTMLTextAreaElement
    await waitFor(() => expect(composer.value).toBe(U_URI))
    await switchWorkspaceTab('Folder U')
    await openChatDrawer()
    const input = screen.getByTestId('chat-input') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: '' } })
    await waitFor(() => expect(getComposerDraft(CHAT, USER)).toBe(''))

    const cleanupEntered = deferred<void>()
    const releaseCleanup = deferred<void>()
    const originalRename = fs.rename.bind(fs)
    const originalRm = fs.rm.bind(fs)
    let indexCommitObserved = false
    let cleanupHeld = false
    const renameBoundary = vi.spyOn(fs, 'rename').mockImplementation(async (...args: any[]) => {
      const result = await Reflect.apply(originalRename, fs, args)
      if (String(args[0]).endsWith('/index.json.tmp')) indexCommitObserved = true
      return result
    })
    const cleanupBoundary = vi.spyOn(fs, 'rm').mockImplementation(async (...args: any[]) => {
      if (indexCommitObserved && String(args[0]).endsWith(`/${CHAT}.json`) && !cleanupHeld) {
        cleanupHeld = true
        cleanupEntered.resolve()
        await releaseCleanup.promise
      }
      return Reflect.apply(originalRm, fs, args)
    })

    try {
      fireEvent.click(screen.getByRole('button', { name: 'Session options for Earlier chat' }))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
      const dialog = await screen.findByRole('dialog', { name: 'Delete session?' })
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
      await cleanupEntered.promise

      const index = await clerum.readIndex(USER)
      expect(index.deletedChatTombstones).toContainEqual({
        chatId: CHAT,
        authorityScope: expect.objectContaining({ userId: 'user-1', teamId: 'team-1' }),
      })
      expect(index.pendingChatCleanup).toContainEqual({
        chatId: CHAT,
        authorityScope: expect.objectContaining({ userId: 'user-1', teamId: 'team-1' }),
      })
      expect(
        await clerum.chat.deletionStatus(USER, CHAT, {
          environmentKey: 'harness-environment',
          userId: 'user-1',
          teamId: 'team-1',
        })
      ).toEqual({ status: 'deleted', cleanupPending: false })
      expect(cleanupHeld).toBe(true)

      const previousReceiptId = Number(
        screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')
      )
      const previousReceiptStatus = screen
        .getByTestId('prefill-receipt-probe')
        .getAttribute('data-receipt-status')
      const previousReceiptIdentities = [...new Set(receiptProbe.ids)]
      const prefillEventsBeforeCleanup = [...appTestActions.prefillEvents]
      const draftRevisionBeforeReselect = getComposerDraftRevision(
        CHAT,
        USER,
        receiptProbe.tabId,
        receiptProbe.scope
      )
      fireEvent.click(screen.getByRole('button', { name: 'Open Earlier chat' }))
      await waitFor(() =>
        expect(
          Number(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id'))
        ).toBe(previousReceiptId)
      )
      expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-status')).toBe(
        previousReceiptStatus
      )
      expect([...new Set(receiptProbe.ids)]).toEqual(previousReceiptIdentities)
      expect(appTestActions.prefillEvents).toEqual(prefillEventsBeforeCleanup)
      expect(input.value).toBe('')
      expect(getComposerDraft(CHAT, USER)).toBe('')
      expect(getComposerDraftRevision(CHAT, USER, receiptProbe.tabId, receiptProbe.scope)).toBe(
        draftRevisionBeforeReselect
      )
      expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()

      await act(async () => {
        releaseCleanup.resolve()
        await Promise.allSettled(clerum.chat.delete.mock.results.map(result => result.value))
      })
      expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-status')).toBe(
        previousReceiptStatus
      )
      expect((await clerum.readIndex(USER)).pendingChatCleanup ?? []).toEqual([])
      expect((await clerum.readIndex(USER)).deletedChatTombstones).toContainEqual({
        chatId: CHAT,
        authorityScope: expect.objectContaining({ userId: 'user-1', teamId: 'team-1' }),
      })
      expect(input.value).toBe('')
      expect(getComposerDraft(CHAT, USER)).toBe('')
      expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
    } finally {
      await act(async () => {
        releaseCleanup.resolve()
        await Promise.allSettled(clerum.chat.delete.mock.results.map(result => result.value))
      })
      cleanupBoundary.mockRestore()
      renameBoundary.mockRestore()
    }
  })

  it('C7 terminalizes a real eligible receipt when its target commits deletion', async () => {
    const targetChatId = 'chat-target'
    const { clerum } = await setupApp([
      { agent: USER, chatId: CHAT, title: 'Earlier chat' },
      { agent: USER, chatId: targetChatId, title: 'Target chat' },
    ])
    await clerum.chat.create(USER, targetChatId)
    await openFolderU()
    await switchWorkspaceTab('Folder U')
    await openChatDrawer()
    const panel = document.querySelector('.content-panel') as HTMLElement
    Object.defineProperty(panel, 'clientWidth', { configurable: true, get: () => 700 })
    const selection = await screen.findByRole('button', { name: 'Open Target chat' })
    act(() => {
      selection.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      resizeCallbacks.forEach(callback => callback(700))
    })
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Chat' })).toBeNull())
    const receiptProbeElement = screen.getByTestId('prefill-receipt-probe')
    const receiptId = receiptProbeElement.getAttribute('data-receipt-id')
    const targetScope = receiptProbe.scope
    const targetTabId = receiptProbeElement.getAttribute('data-destination-tab-id') ?? ''
    expect(receiptId).not.toBe('')
    expect(receiptProbeElement.getAttribute('data-receipt-status')).toBe('bound-eligible')
    expect(getComposerDraft(targetChatId, USER, targetTabId, targetScope)).toBe('')

    const cleanupEntered = deferred<void>()
    const releaseCleanup = deferred<void>()
    const originalRename = fs.rename.bind(fs)
    const originalRm = fs.rm.bind(fs)
    let indexCommitObserved = false
    let cleanupHeld = false
    const renameBoundary = vi.spyOn(fs, 'rename').mockImplementation(async (...args: any[]) => {
      const result = await Reflect.apply(originalRename, fs, args)
      if (String(args[0]).endsWith('/index.json.tmp')) indexCommitObserved = true
      return result
    })
    const cleanupBoundary = vi.spyOn(fs, 'rm').mockImplementation(async (...args: any[]) => {
      if (
        indexCommitObserved &&
        String(args[0]).endsWith(`/${targetChatId}.json`) &&
        !cleanupHeld
      ) {
        cleanupHeld = true
        cleanupEntered.resolve()
        await releaseCleanup.promise
      }
      return Reflect.apply(originalRm, fs, args)
    })

    try {
      fireEvent.click(screen.getByRole('button', { name: 'Session options for Target chat' }))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
      const dialog = await screen.findByRole('dialog', { name: 'Delete session?' })
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
      await cleanupEntered.promise

      expect(indexCommitObserved).toBe(true)
      expect((await clerum.readIndex(USER)).deletedChatTombstones).toContainEqual({
        chatId: targetChatId,
        authorityScope: expect.objectContaining({ userId: 'user-1', teamId: 'team-1' }),
      })
      expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')).toBe(
        receiptId
      )
      expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-status')).toBe(
        'bound-eligible'
      )
      expect(getComposerDraft(targetChatId, USER, targetTabId, targetScope)).toBe('')
      resizeAppTo(1200)
      const input = (await screen.findByTestId('chat-input')) as HTMLTextAreaElement
      expect(input.value).toBe('')
      expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()

      await act(async () => {
        releaseCleanup.resolve()
        await Promise.allSettled(clerum.chat.delete.mock.results.map(result => result.value))
      })
      expect(clerum.chat.delete).toHaveBeenCalledTimes(1)
      await waitFor(() =>
        expect(
          screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-status')
        ).toBe('terminally-cancelled')
      )
      expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')).toBe(
        receiptId
      )
      expect(input.value).not.toContain(U_URI)
      expect(getComposerDraft(targetChatId, USER, targetTabId, targetScope)).toBe('')
      expect((await clerum.readIndex(USER)).deletedChatTombstones).toContainEqual({
        chatId: targetChatId,
        authorityScope: expect.objectContaining({ userId: 'user-1', teamId: 'team-1' }),
      })
      expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
    } finally {
      await act(async () => {
        releaseCleanup.resolve()
        await Promise.allSettled(clerum.chat.delete.mock.results.map(result => result.value))
      })
      cleanupBoundary.mockRestore()
      renameBoundary.mockRestore()
    }
  })

  it('C8 keeps deletion status behind an active real transcript write', async () => {
    const { clerum } = await setupApp()
    const actualDeletionStatus = clerum.chat.deletionStatus.getMockImplementation()
    if (!actualDeletionStatus) throw new Error('Expected the real ChatStore status operation')
    const statusSettled = deferred<string>()
    let statusCompleted = false
    clerum.chat.deletionStatus.mockImplementation(async (...args) => {
      const status = await actualDeletionStatus(...args)
      statusCompleted = true
      statusSettled.resolve(status.status)
      return status
    })
    await openFolderU()
    const initialInput = (await selectSidebarConversation()) as HTMLTextAreaElement
    await waitFor(() => expect(initialInput.value).toBe(U_URI))
    await switchWorkspaceTab('Folder U')
    await openChatDrawer()
    const input = screen.getByTestId('chat-input') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'Queued transcript write' } })
    await waitFor(() => expect(getComposerDraft(CHAT, USER)).toBe('Queued transcript write'))

    const releaseTranscriptRename = deferred<void>()
    const originalRename = fs.rename.bind(fs)
    let transcriptRenameHeld = false
    const transcriptBarrier = vi.spyOn(fs, 'rename').mockImplementation(async (...args: any[]) => {
      const result = await Reflect.apply(originalRename, fs, args)
      if (String(args[0]).includes('/next-') && !transcriptRenameHeld) {
        transcriptRenameHeld = true
        await releaseTranscriptRename.promise
      }
      return result
    })

    try {
      fireEvent.click(screen.getByTestId('send-button'))
      await waitFor(() => expect(transcriptRenameHeld).toBe(true))
      expect(clerum.chat.upsertMessages).toHaveBeenCalledWith(
        USER,
        CHAT,
        expect.arrayContaining([expect.objectContaining({ content: 'Queued transcript write' })])
      )

      // The real send has entered ChatStore's per-chat chain and atomically renamed its
      // transcript snapshot. Keep that operation unresolved while the Sidebar queues delete.
      fireEvent.change(input, { target: { value: '' } })
      await waitFor(() => expect(getComposerDraft(CHAT, USER)).toBe(''))
      fireEvent.click(screen.getByRole('button', { name: 'Session options for Earlier chat' }))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
      const dialog = await screen.findByRole('dialog', { name: 'Delete session?' })
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
      await waitFor(() => expect(clerum.chat.delete).toHaveBeenCalledTimes(1))
      expect(
        Number(
          screen.getByTestId('prefill-receipt-probe').getAttribute('data-pending-deletion-revision')
        )
      ).toBeGreaterThan(0)

      const receiptIdBeforeRefocus = Number(
        screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')
      )
      fireEvent.blur(input)
      fireEvent.focus(input)
      await waitFor(() => expect(clerum.chat.deletionStatus).toHaveBeenCalled())
      await act(async () => {
        await Promise.resolve()
        await new Promise(resolve => setTimeout(resolve, 0))
      })

      // With the complete ChatStore ordering, the status request waits behind the still-active
      // transcript and queued delete; the pending target gate therefore keeps the Composer empty.
      expect(input.value).toBe('')
      expect(getComposerDraft(CHAT, USER)).toBe('')
      expect(statusCompleted).toBe(false)
      expect(
        Number(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id'))
      ).toBeGreaterThanOrEqual(receiptIdBeforeRefocus)
      expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()

      releaseTranscriptRename.resolve()
      await expect(statusSettled.promise).resolves.toBe('deleted')
      await waitFor(() =>
        expect(
          screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-status')
        ).toBe('consumed')
      )
      expect(input.value).toBe('')
      expect(getComposerDraft(CHAT, USER)).toBe('')
      await waitFor(() => expect(clerum.rpc.invokeHostMessage).toHaveBeenCalledTimes(1))
      expect(clerum.rpc.invokeHostMessage.mock.calls[0]?.[1]).toMatchObject({
        content: 'Queued transcript write',
      })
    } finally {
      releaseTranscriptRename.resolve()
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0))
      })
      transcriptBarrier.mockRestore()
    }
  })

  it('T16 does not resurrect a consumed receipt after authoritative not-deleted status', async () => {
    const { clerum } = await setupApp()
    await openFolderU()
    const composer = (await selectSidebarConversation()) as HTMLTextAreaElement
    await waitFor(() => expect(composer.value).toBe(U_URI))
    await switchWorkspaceTab('Folder U')
    await openChatDrawer()
    const input = screen.getByTestId('chat-input') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: '' } })
    await waitFor(() => expect(getComposerDraft(CHAT, USER)).toBe(''))

    const actualDeletionStatus = clerum.chat.deletionStatus.getMockImplementation()
    if (!actualDeletionStatus) {
      throw new Error('Expected the real ChatStore deletion operations')
    }
    const statusCheckStarted = deferred<void>()
    const releaseStatusCheck = deferred<void>()
    clerum.chat.delete.mockImplementationOnce(async () => {
      throw new Error('Definitive failure before local delete operation')
    })
    clerum.chat.deletionStatus.mockImplementation(async (...args) => {
      statusCheckStarted.resolve()
      await releaseStatusCheck.promise
      return actualDeletionStatus(...args)
    })

    try {
      fireEvent.click(screen.getByRole('button', { name: 'Session options for Earlier chat' }))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
      const dialog = await screen.findByRole('dialog', { name: 'Delete session?' })
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))

      const consumedReceiptId = screen
        .getByTestId('prefill-receipt-probe')
        .getAttribute('data-receipt-id')
      const consumedReceiptStatus = screen
        .getByTestId('prefill-receipt-probe')
        .getAttribute('data-receipt-status')
      expect(input.value).toBe('')
      expect(getComposerDraft(CHAT, USER)).toBe('')
      await waitFor(() => expect(clerum.chat.deletionStatus).toHaveBeenCalled())
      await statusCheckStarted.promise
      releaseStatusCheck.resolve()

      expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')).toBe(
        consumedReceiptId
      )
      expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-status')).toBe(
        consumedReceiptStatus
      )
      expect(input.value).toBe('')
      expect(getComposerDraft(CHAT, USER)).toBe('')
      expect(clerum.chat.deletionStatus).toHaveBeenCalledWith(
        USER,
        CHAT,
        expect.objectContaining({ teamId: 'team-1' })
      )
      expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
    } finally {
      releaseStatusCheck.resolve()
    }
  })

  it('A3-25 wakes the same pre-confirmation receipt after the final no-commit gate releases', async () => {
    const targetChatId = 'chat-target'
    const oldHostAgent = 'agent-y'
    const oldHostChat = 'chat-y'
    const { clerum, gfs } = await setupApp(
      [
        { agent: USER, chatId: CHAT, title: 'Earlier chat' },
        { agent: USER, chatId: targetChatId, title: 'Target chat' },
        { agent: oldHostAgent, chatId: oldHostChat, title: 'Old host target' },
      ],
      false,
      [USER, oldHostAgent]
    )
    await openFolderU()
    await switchWorkspaceTab('Folder U')
    await openChatDrawer()
    const panel = document.querySelector('.content-panel') as HTMLElement
    Object.defineProperty(panel, 'clientWidth', { configurable: true, get: () => 700 })

    // Start an older real notification activation and hold its Host verification.
    // A later Sidebar selection below must replace its receipt before this stale
    // failure tries to cancel the captured receipt ID.
    clerum.rpc.renameSession.mockRejectedValue(await ipcHostAccessRevoked('rpc:renameSession'))
    expect(appTestActions.holdHost).toBeTypeOf('function')
    await act(async () => {
      await appTestActions.holdHost!(oldHostAgent, oldHostChat)
    })
    const oldHostVerification = deferred<ReturnType<typeof serverSessions>>()
    clerum.rpc.listSessions.mockClear()
    clerum.rpc.listSessions.mockImplementation(async (agent, _team, query) =>
      agent === oldHostAgent && query?.limit === 1
        ? oldHostVerification.promise
        : serverSessions([
            { agent: USER, chatId: CHAT },
            { agent: USER, chatId: targetChatId },
            { agent: oldHostAgent, chatId: oldHostChat },
          ])
    )
    fireEvent.click(screen.getByTestId('open-same-scope-stale-target'))
    await waitFor(() =>
      expect(clerum.rpc.listSessions).toHaveBeenCalledWith(oldHostAgent, undefined, {
        agent: oldHostAgent,
        limit: 1,
      })
    )
    const oldReceiptId = screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')
    expect(oldReceiptId).not.toBe('')

    const sidebarSelection = await screen.findByRole('button', { name: 'Open Target chat' })
    act(() => {
      sidebarSelection.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      resizeCallbacks.forEach(callback => callback(700))
    })
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Chat' })).toBeNull())
    const originalReceiptId = screen
      .getByTestId('prefill-receipt-probe')
      .getAttribute('data-receipt-id')
    expect(originalReceiptId).not.toBe('')
    expect(originalReceiptId).not.toBe(oldReceiptId)
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-status')).toBe(
      'bound-eligible'
    )
    const retainedResource = getLatestGfsConversationContext()
    expect(retainedResource).toMatchObject({ uri: U_URI })
    expect(retainedResource?.sourceTabId).toBeTruthy()
    expect(getComposerDraft(targetChatId, USER)).toBe('')
    let draftNotifications = 0
    const unsubscribeDraft = subscribeComposerDraft(
      targetChatId,
      () => {
        draftNotifications += 1
      },
      USER
    )

    const actualDelete = clerum.chat.delete.getMockImplementation()
    const actualDeletionStatus = clerum.chat.deletionStatus.getMockImplementation()
    if (!actualDelete || !actualDeletionStatus) {
      throw new Error('Expected the real serialized ChatStore delete and status operations')
    }

    const deleteFailedBeforeCommit = deferred<void>()
    const statusReadEntered = deferred<string>()
    const releaseStatusRead = deferred<void>()
    const originalWriteFile = fs.writeFile.bind(fs)
    let deleteOperationActive = false
    let failedBeforeCommit = false
    let statusReadHeld = false
    const authoritativeStatuses: string[] = []
    const writeFailure = vi.spyOn(fs, 'writeFile').mockImplementation(async (...args: any[]) => {
      if (
        deleteOperationActive &&
        String(args[0]).endsWith('/.tombstones.json.tmp') &&
        !failedBeforeCommit
      ) {
        failedBeforeCommit = true
        throw Object.assign(new Error('Controlled definitive precommit failure'), { code: 'EIO' })
      }
      return Reflect.apply(originalWriteFile, fs, args)
    })
    clerum.chat.delete.mockImplementation(async (...args) => {
      deleteOperationActive = true
      try {
        return await actualDelete(...args)
      } catch (error) {
        deleteFailedBeforeCommit.resolve()
        throw error
      } finally {
        deleteOperationActive = false
      }
    })
    clerum.chat.deletionStatus.mockImplementation(async (...args) => {
      const status = await actualDeletionStatus(...args)
      authoritativeStatuses.push(status.status)
      if (failedBeforeCommit && !statusReadHeld) {
        statusReadHeld = true
        statusReadEntered.resolve(status.status)
      }
      if (failedBeforeCommit) await releaseStatusRead.promise
      return status
    })

    try {
      const resourceListCalls = gfs.listAccessible.mock.calls.length
      const targetTabId =
        screen.getByTestId('prefill-receipt-probe').getAttribute('data-destination-tab-id') ?? ''
      expect(targetTabId).not.toBe('')
      const targetScope = receiptProbe.scope
      fireEvent.click(screen.getByRole('button', { name: 'Session options for Target chat' }))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
      const dialog = await screen.findByRole('dialog', { name: 'Delete session?' })
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))

      await deleteFailedBeforeCommit.promise
      await expect(statusReadEntered.promise).resolves.toBe('not-deleted')
      expect(failedBeforeCommit).toBe(true)
      expect((await clerum.readIndex(USER)).deletedChatTombstones ?? []).toHaveLength(0)
      expect(clerum.chat.delete).toHaveBeenCalledTimes(1)
      expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')).toBe(
        originalReceiptId
      )
      expect(
        Number(
          screen.getByTestId('prefill-receipt-probe').getAttribute('data-pending-deletion-revision')
        )
      ).toBeGreaterThan(0)
      expect(getComposerDraft(targetChatId, USER, targetTabId, targetScope)).toBe('')

      // The stale Host failure reaches the real cancellation callback while the
      // newer Sidebar receipt is protected by the actual pending-delete gate.
      // Its captured old ID must not terminalize the current receipt.
      await act(async () => {
        oldHostVerification.reject(new Error('Controlled stale Host verification failure'))
        await appTestActions.openTargetPromise
        await Promise.resolve()
      })
      expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')).toBe(
        originalReceiptId
      )
      expect(getComposerDraft(targetChatId, USER, targetTabId, targetScope)).toBe('')

      // The SidebarNav confirmation is real while the responsive Chat Composer is
      // detached. Reopening it while the status result is held is still before
      // release, so it cannot mint a replacement receipt or write the URI.
      resizeAppTo(1200)
      const restoredInput = (await screen.findByTestId('chat-input')) as HTMLTextAreaElement
      await waitFor(() =>
        expect(screen.getByTestId('chat-thread-stub').textContent).toBe(targetChatId)
      )
      expect(restoredInput.value).toBe('')
      expect(getComposerDraft(targetChatId, USER, targetTabId, targetScope)).toBe('')
      expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')).toBe(
        originalReceiptId
      )
      expect(getLatestGfsConversationContext()).toMatchObject({
        uri: U_URI,
        sourceTabId: retainedResource?.sourceTabId,
      })
      expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
      const qualifyingEventsBeforeRelease = appTestActions.prefillEvents.filter(event =>
        ['focus', 'visible', 'resource'].includes(event)
      ).length
      const draftRevisionBeforeRelease = getComposerDraftRevision(
        targetChatId,
        USER,
        targetTabId,
        targetScope
      )

      await act(async () => {
        releaseStatusRead.resolve()
        await Promise.allSettled([
          ...clerum.chat.delete.mock.results.map(result => result.value),
          ...clerum.chat.deletionStatus.mock.results.map(result => result.value),
        ])
        await Promise.resolve()
      })
      expect(restoredInput.value).toBe(U_URI)
      expect(getComposerDraft(targetChatId, USER, targetTabId, targetScope)).toBe(U_URI)
      expect(restoredInput.value.match(/gfs:\/\//g)).toHaveLength(1)
      expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')).toBe(
        originalReceiptId
      )
      expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-status')).toBe(
        'consumed'
      )
      expect(
        getComposerDraftRevision(targetChatId, USER, targetTabId, targetScope)
      ).toBeGreaterThan(draftRevisionBeforeRelease)
      expect(draftNotifications).toBe(1)
      expect(
        appTestActions.prefillEvents.filter(event =>
          ['focus', 'visible', 'resource'].includes(event)
        )
      ).toHaveLength(qualifyingEventsBeforeRelease)
      expect(gfs.listAccessible).toHaveBeenCalledTimes(resourceListCalls)
      expect(clerum.chat.delete).toHaveBeenCalledTimes(1)
      expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
      expect((await clerum.readIndex(USER)).deletedChatTombstones ?? []).toHaveLength(0)
      expect(authoritativeStatuses.length).toBeGreaterThan(0)
      expect(authoritativeStatuses.every(status => status === 'not-deleted')).toBe(true)
      expect(clerum.chat.deletionStatus.mock.calls).toEqual(
        expect.arrayContaining([
          expect.arrayContaining([
            USER,
            targetChatId,
            expect.objectContaining({ teamId: 'team-1' }),
          ]),
        ])
      )
      const settledStatusCallCount = clerum.chat.deletionStatus.mock.calls.length
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 25))
        await Promise.resolve()
      })
      expect(clerum.chat.deletionStatus).toHaveBeenCalledTimes(settledStatusCallCount)
    } finally {
      releaseStatusRead.resolve()
      unsubscribeDraft()
      writeFailure.mockRestore()
    }
  })

  it('A3-18 does not revive a receipt superseded by a newer Chat selection', async () => {
    const { clerum } = await setupApp([
      { agent: USER, chatId: CHAT, title: 'Earlier chat' },
      { agent: USER, chatId: 'chat-unrelated', title: 'Unrelated chat' },
    ])
    await openFolderU()
    const composer = (await selectSidebarConversation()) as HTMLTextAreaElement
    await waitFor(() => expect(composer.value).toBe(U_URI))
    await switchWorkspaceTab('Folder U')
    await openChatDrawer()
    const input = screen.getByTestId('chat-input') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: '' } })
    await waitFor(() => expect(getComposerDraft(CHAT, USER)).toBe(''))

    const actualDelete = clerum.chat.delete.getMockImplementation()
    const actualDeletionStatus = clerum.chat.deletionStatus.getMockImplementation()
    if (!actualDelete || !actualDeletionStatus)
      throw new Error('Expected the real ChatStore operations')
    const deleteFailedBeforeCommit = deferred<void>()
    const statusReadEntered = deferred<string>()
    const releaseStatusRead = deferred<void>()
    const originalWriteFile = fs.writeFile.bind(fs)
    let failedBeforeCommit = false
    let deleteOperationActive = false
    let statusWasHeld = false
    const writeFailure = vi.spyOn(fs, 'writeFile').mockImplementation(async (...args: any[]) => {
      if (
        deleteOperationActive &&
        String(args[0]).endsWith('/.tombstones.json.tmp') &&
        !failedBeforeCommit
      ) {
        failedBeforeCommit = true
        throw Object.assign(new Error('Controlled tombstone precommit failure'), { code: 'EIO' })
      }
      return Reflect.apply(originalWriteFile, fs, args)
    })
    clerum.chat.delete.mockImplementation(async (...args) => {
      deleteOperationActive = true
      try {
        return await actualDelete(...args)
      } catch (error) {
        deleteFailedBeforeCommit.resolve()
        throw error
      } finally {
        deleteOperationActive = false
      }
    })
    clerum.chat.deletionStatus.mockImplementation(async (...args) => {
      const result = await actualDeletionStatus(...args)
      if (failedBeforeCommit && !statusWasHeld) {
        statusWasHeld = true
        statusReadEntered.resolve(result.status)
        await releaseStatusRead.promise
      }
      return result
    })

    try {
      const initialReceiptId = Number(
        screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')
      )
      fireEvent.click(screen.getByRole('button', { name: 'Session options for Earlier chat' }))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
      const dialog = await screen.findByRole('dialog', { name: 'Delete session?' })
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))

      await deleteFailedBeforeCommit.promise
      await expect(statusReadEntered.promise).resolves.toBe('not-deleted')
      expect(failedBeforeCommit).toBe(true)
      expect(clerum.chat.delete).toHaveBeenCalledTimes(1)

      fireEvent.click(screen.getByRole('button', { name: 'Open Unrelated chat' }))
      await waitFor(() =>
        expect(screen.getByTestId('chat-thread-stub').textContent).toBe('chat-unrelated')
      )
      const supersedingReceiptId = Number(
        screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')
      )
      expect(supersedingReceiptId).toBeGreaterThan(initialReceiptId)

      releaseStatusRead.resolve()
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0))
      })
      expect(screen.getByTestId('chat-thread-stub').textContent).toBe('chat-unrelated')
      expect(
        Number(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id'))
      ).toBe(supersedingReceiptId)
      expect((await clerum.readIndex(USER)).deletedChatTombstones ?? []).toHaveLength(0)

      fireEvent.click(screen.getByRole('button', { name: 'Open Earlier chat' }))
      await waitFor(() => expect(screen.getByTestId('chat-thread-stub').textContent).toBe(CHAT))
      const latestReceiptId = Number(
        screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')
      )
      const latestInput = screen.getByTestId('chat-input') as HTMLTextAreaElement
      await waitFor(() => expect(latestInput.value).toBe(U_URI))
      expect(latestReceiptId).toBeGreaterThan(supersedingReceiptId)
      expect(getComposerDraft(CHAT, USER)).toBe(U_URI)
      expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
    } finally {
      releaseStatusRead.resolve()
      writeFailure.mockRestore()
    }
  })

  it('C9 releases the exact overlapping attempts after unknown then not-deleted status', async () => {
    const { clerum } = await setupApp()
    await openFolderU()
    const composer = (await selectSidebarConversation()) as HTMLTextAreaElement
    await waitFor(() => expect(composer.value).toBe(U_URI))
    const initialResource = getLatestGfsConversationContext()
    expect(initialResource).toMatchObject({ uri: U_URI })
    const targetChatTabId = receiptProbe.tabId
    const targetScope = receiptProbe.scope
    await switchWorkspaceTab('Folder U')
    await openChatDrawer()
    const input = screen.getByTestId('chat-input') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: '' } })
    await waitFor(() => expect(getComposerDraft(CHAT, USER)).toBe(''))

    const actualDelete = clerum.chat.delete.getMockImplementation()
    const actualDeletionStatus = clerum.chat.deletionStatus.getMockImplementation()
    if (!actualDelete || !actualDeletionStatus) {
      throw new Error('Expected the real serialized ChatStore deletion operations')
    }

    const firstStatusReadEntered = deferred<void>()
    const releaseFirstStatusRead = deferred<void>()
    const secondIndexWriteEntered = deferred<void>()
    const releaseSecondIndexWrite = deferred<void>()
    const statusResults: string[] = []
    let statusCalls = 0
    let indexWriteFailures = 0
    let firstStatusReadHeld = false
    let recoveryStatusReadFailures = 0
    let deleteOperationActive = false
    const originalReadFile = fs.readFile.bind(fs)
    const originalWriteFile = fs.writeFile.bind(fs)
    const readBarrier = vi.spyOn(fs, 'readFile').mockImplementation(async (...args: any[]) => {
      const path = String(args[0])
      if (path.endsWith('/index.json') && statusCalls === 1 && !firstStatusReadHeld) {
        firstStatusReadHeld = true
        firstStatusReadEntered.resolve()
        await releaseFirstStatusRead.promise
        throw Object.assign(new Error('Controlled authoritative status read failure'), {
          code: 'EACCES',
        })
      }
      if (path.endsWith('/index.json') && statusCalls >= 3) {
        recoveryStatusReadFailures += 1
        throw Object.assign(new Error('Controlled recovery status read failure'), {
          code: 'EACCES',
        })
      }
      return Reflect.apply(originalReadFile, fs, args)
    })
    const writeBarrier = vi.spyOn(fs, 'writeFile').mockImplementation(async (...args: any[]) => {
      const path = String(args[0])
      if (
        deleteOperationActive &&
        path.endsWith('/.tombstones.json.tmp') &&
        indexWriteFailures < 2
      ) {
        indexWriteFailures += 1
        if (indexWriteFailures === 2) {
          secondIndexWriteEntered.resolve()
          await releaseSecondIndexWrite.promise
        }
        throw Object.assign(new Error(`Controlled precommit index failure ${indexWriteFailures}`), {
          code: 'EIO',
        })
      }
      return Reflect.apply(originalWriteFile, fs, args)
    })
    clerum.chat.delete.mockImplementation(async (...args) => {
      deleteOperationActive = true
      try {
        return await actualDelete(...args)
      } finally {
        deleteOperationActive = false
      }
    })
    clerum.chat.deletionStatus.mockImplementation(async (...args) => {
      statusCalls += 1
      const status = await actualDeletionStatus(...args)
      statusResults.push(status.status)
      return status
    })

    try {
      const pendingBeforeD1 = Number(
        screen.getByTestId('prefill-receipt-probe').getAttribute('data-pending-deletion-revision')
      )
      fireEvent.click(screen.getByRole('button', { name: 'Session options for Earlier chat' }))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
      const sidebarDialog = await screen.findByRole('dialog', { name: 'Delete session?' })
      fireEvent.click(within(sidebarDialog).getByRole('button', { name: 'Delete' }))

      await firstStatusReadEntered.promise
      expect(indexWriteFailures).toBe(1)
      expect(statusCalls).toBe(1)
      expect(
        Number(
          screen.getByTestId('prefill-receipt-probe').getAttribute('data-pending-deletion-revision')
        )
      ).toBeGreaterThan(pendingBeforeD1)

      const drawer = screen.getByRole('complementary', { name: 'Chat' })
      fireEvent.click(within(drawer).getByRole('button', { name: 'New chat' }))
      const chatThreadRow = await screen.findByTestId('agent-chat-row')
      expect(chatThreadRow.getAttribute('data-chat-id')).toBe(CHAT)
      fireEvent.click(
        within(chatThreadRow).getByRole('button', { name: 'Session actions for Earlier chat' })
      )
      fireEvent.click(within(chatThreadRow).getByRole('button', { name: 'Delete' }))
      const threadDialog = await screen.findByRole('dialog', { name: 'Delete session?' })
      fireEvent.click(within(threadDialog).getByRole('button', { name: 'Delete' }))
      expect(clerum.chat.delete).toHaveBeenCalledTimes(2)

      releaseFirstStatusRead.resolve()
      await secondIndexWriteEntered.promise
      expect(statusResults).toEqual(['unknown'])
      expect(indexWriteFailures).toBe(2)
      expect(getStoredComposerDraft(CHAT, USER, targetChatTabId, targetScope)).toBe('')

      releaseSecondIndexWrite.resolve()
      await waitFor(() => expect(statusResults).toEqual(['unknown', 'not-deleted']))
      expect((await clerum.readIndex(USER)).deletedChatTombstones ?? []).toHaveLength(0)

      fireEvent.click(screen.getByRole('button', { name: 'Collapse chat drawer' }))
      await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Chat' })).toBeNull())
      await openFolderU()
      const restoredResource = getLatestGfsConversationContext()
      expect(restoredResource).toMatchObject({ uri: U_URI })
      expect(restoredResource?.sourceTabId).toBeTruthy()
      expect(restoredResource?.sourceTabId).not.toBe(initialResource?.sourceTabId)

      const finalComposer = (await selectSidebarConversation()) as HTMLTextAreaElement
      await waitFor(() =>
        expect(
          finalComposer.value,
          `statusCalls=${statusCalls}; statuses=${statusResults.join(',')}; recoveryReadFailures=${recoveryStatusReadFailures}`
        ).toBe(U_URI)
      )
      expect(getComposerDraft(CHAT, USER)).toBe(U_URI)
      expect(finalComposer.value.match(/gfs:\/\//g)).toHaveLength(1)
      expect(getLatestGfsConversationContext()).toMatchObject(restoredResource!)
      expect(statusResults).toEqual(['unknown', 'not-deleted'])
      expect(statusCalls).toBe(2)
      expect(recoveryStatusReadFailures).toBe(0)
      expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
      expect(clerum.chat.delete).toHaveBeenCalledTimes(2)
    } finally {
      releaseFirstStatusRead.resolve()
      releaseSecondIndexWrite.resolve()
      readBarrier.mockRestore()
      writeBarrier.mockRestore()
    }
  })

  it('A3-27 wakes the same receipt after D1 and D2 both prove not-deleted', async () => {
    const { clerum, gfs } = await setupApp()
    await openFolderU()
    await switchWorkspaceTab('Folder U')
    await openChatDrawer()
    const panel = document.querySelector('.content-panel') as HTMLElement
    Object.defineProperty(panel, 'clientWidth', { configurable: true, get: () => 700 })
    const selection = await screen.findByRole('button', { name: 'Open Earlier chat' })
    act(() => {
      selection.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      resizeCallbacks.forEach(callback => callback(700))
    })
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Chat' })).toBeNull())

    const receipt = screen.getByTestId('prefill-receipt-probe')
    const receiptId = receipt.getAttribute('data-receipt-id')
    const receiptStatus = receipt.getAttribute('data-receipt-status')
    const targetScope = receiptProbe.scope
    const targetTabId = receipt.getAttribute('data-destination-tab-id') ?? ''
    expect(receiptId).not.toBe('')
    expect(receiptStatus).toBe('bound-eligible')
    expect(targetTabId).not.toBe('')
    expect(getComposerDraft(CHAT, USER, targetTabId, targetScope)).toBe('')
    expect(getLatestGfsConversationContext()).toMatchObject({ uri: U_URI })
    const retainedResource = getLatestGfsConversationContext()
    expect(retainedResource?.sourceTabId).toBeTruthy()

    const actualDelete = clerum.chat.delete.getMockImplementation()
    const actualDeletionStatus = clerum.chat.deletionStatus.getMockImplementation()
    if (!actualDelete || !actualDeletionStatus) {
      throw new Error('Expected the real serialized ChatStore deletion operations')
    }

    const firstStatusReadEntered = deferred<void>()
    const releaseFirstStatusRead = deferred<void>()
    const secondDeleteWriteEntered = deferred<void>()
    const releaseSecondDeleteWrite = deferred<void>()
    const originalReadFile = fs.readFile.bind(fs)
    const originalWriteFile = fs.writeFile.bind(fs)
    const statusResults: string[] = []
    const decisionSpy = vi.spyOn(persistedPrefillDecision, 'decidePersistedConversationPrefill')
    let statusCalls = 0
    let deleteCalls = 0
    let firstStatusReadHeld = false
    let tombstoneWriteCount = 0
    const readBarrier = vi.spyOn(fs, 'readFile').mockImplementation(async (...args: any[]) => {
      const path = String(args[0])
      if (path.endsWith('/index.json') && statusCalls === 1 && !firstStatusReadHeld) {
        firstStatusReadHeld = true
        firstStatusReadEntered.resolve()
        await releaseFirstStatusRead.promise
      }
      return Reflect.apply(originalReadFile, fs, args)
    })
    const writeBarrier = vi.spyOn(fs, 'writeFile').mockImplementation(async (...args: any[]) => {
      const path = String(args[0])
      if (path.endsWith('/.tombstones.json.tmp')) {
        tombstoneWriteCount += 1
        if (tombstoneWriteCount === 1) {
          throw Object.assign(new Error('D1 failed before durable commit'), { code: 'EIO' })
        }
        if (tombstoneWriteCount === 2) {
          secondDeleteWriteEntered.resolve()
          await releaseSecondDeleteWrite.promise
          throw Object.assign(new Error('D2 failed before durable commit'), { code: 'EIO' })
        }
      }
      return Reflect.apply(originalWriteFile, fs, args)
    })
    clerum.chat.delete.mockImplementation(async (...args) => {
      deleteCalls += 1
      return actualDelete(...args)
    })
    clerum.chat.deletionStatus.mockImplementation(async (...args) => {
      statusCalls += 1
      const status = await actualDeletionStatus(...args)
      statusResults.push(status.status)
      return status
    })

    try {
      fireEvent.click(screen.getByRole('button', { name: 'Session options for Earlier chat' }))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
      const firstDialog = await screen.findByRole('dialog', { name: 'Delete session?' })
      fireEvent.click(within(firstDialog).getByRole('button', { name: 'Delete' }))
      await firstStatusReadEntered.promise
      expect(deleteCalls).toBe(1)
      expect((await clerum.readIndex(USER)).deletedChatTombstones ?? []).toHaveLength(0)

      const pendingRevisionAfterD1 = Number(
        screen.getByTestId('prefill-receipt-probe').getAttribute('data-pending-deletion-revision')
      )
      expect(pendingRevisionAfterD1).toBeGreaterThan(0)
      fireEvent.click(screen.getByRole('button', { name: 'Session options for Earlier chat' }))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
      const secondDialog = await screen.findByRole('dialog', { name: 'Delete session?' })
      fireEvent.click(within(secondDialog).getByRole('button', { name: 'Delete' }))
      await waitFor(() => expect(deleteCalls).toBe(2))
      const pendingRevisionAfterD2 = Number(
        screen.getByTestId('prefill-receipt-probe').getAttribute('data-pending-deletion-revision')
      )
      expect(pendingRevisionAfterD2).toBeGreaterThan(pendingRevisionAfterD1)
      expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')).toBe(
        receiptId
      )
      expect(getComposerDraft(CHAT, USER, targetTabId, targetScope)).toBe('')

      await act(async () => {
        releaseFirstStatusRead.resolve()
        await secondDeleteWriteEntered.promise
      })
      await waitFor(() => expect(statusResults).toEqual(['not-deleted']))
      expect(statusCalls).toBe(1)
      expect((await clerum.readIndex(USER)).deletedChatTombstones ?? []).toHaveLength(0)

      resizeAppTo(1200)
      const input = (await screen.findByTestId('chat-input')) as HTMLTextAreaElement
      await waitFor(() => expect(screen.getByTestId('chat-thread-stub').textContent).toBe(CHAT))
      const decisionsWhileD2Pending = decisionSpy.mock.calls
        .map(([decisionInput]) => decisionInput)
        .filter(decisionInput => decisionInput.eventId === Number(receiptId))
      expect(
        input.value,
        JSON.stringify({
          statusCalls,
          statusResults,
          deleteCalls,
          tombstoneWriteCount,
          pendingRevisionAfterD2,
          pendingRevision: screen
            .getByTestId('prefill-receipt-probe')
            .getAttribute('data-pending-deletion-revision'),
          receiptId,
          receiptStatus: screen
            .getByTestId('prefill-receipt-probe')
            .getAttribute('data-receipt-status'),
          scopeMatches: receiptProbe.scope === targetScope,
          decisionsWhileD2Pending,
        })
      ).toBe('')
      expect(decisionsWhileD2Pending.some(decisionInput => decisionInput.deletePending)).toBe(true)
      expect(getComposerDraft(CHAT, USER, targetTabId, targetScope)).toBe('')
      expect(getLatestGfsConversationContext()).toMatchObject({
        uri: U_URI,
        sourceTabId: retainedResource?.sourceTabId,
      })
      expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')).toBe(
        receiptId
      )
      const qualifyingEventsBeforeRelease = appTestActions.prefillEvents.filter(event =>
        ['focus', 'visible', 'resource'].includes(event)
      ).length
      const draftRevisionBeforeRelease = getComposerDraftRevision(
        CHAT,
        USER,
        targetTabId,
        targetScope
      )

      await act(async () => {
        releaseSecondDeleteWrite.resolve()
        await Promise.allSettled([
          ...clerum.chat.delete.mock.results.map(result => result.value),
          ...clerum.chat.deletionStatus.mock.results.map(result => result.value),
        ])
        await Promise.resolve()
      })
      await waitFor(() => expect(statusResults.slice(0, 2)).toEqual(['not-deleted', 'not-deleted']))
      expect(statusResults.every(status => status === 'not-deleted')).toBe(true)
      await waitFor(() => expect(input.value).toBe(U_URI))
      expect(getComposerDraft(CHAT, USER, targetTabId, targetScope)).toBe(U_URI)
      expect(input.value.match(/gfs:\/\//g)).toHaveLength(1)
      expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')).toBe(
        receiptId
      )
      expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-status')).toBe(
        'consumed'
      )
      expect(getComposerDraftRevision(CHAT, USER, targetTabId, targetScope)).toBeGreaterThan(
        draftRevisionBeforeRelease
      )
      expect(
        appTestActions.prefillEvents.filter(event =>
          ['focus', 'visible', 'resource'].includes(event)
        )
      ).toHaveLength(qualifyingEventsBeforeRelease)
      expect((await clerum.readIndex(USER)).deletedChatTombstones ?? []).toHaveLength(0)
      expect(clerum.chat.delete).toHaveBeenCalledTimes(2)
      expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
      const settledStatusCallCount = clerum.chat.deletionStatus.mock.calls.length
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 25))
        await Promise.resolve()
      })
      expect(clerum.chat.deletionStatus).toHaveBeenCalledTimes(settledStatusCallCount)
    } finally {
      releaseFirstStatusRead.resolve()
      releaseSecondDeleteWrite.resolve()
      await Promise.allSettled([
        ...clerum.chat.delete.mock.results.map(result => result.value),
        ...clerum.chat.deletionStatus.mock.results.map(result => result.value),
      ])
      readBarrier.mockRestore()
      writeBarrier.mockRestore()
      decisionSpy.mockRestore()
    }
  })

  it('A3-19 keeps the target gated when an invoked index rename leaves status unknown', async () => {
    const { clerum } = await setupApp()
    await openFolderU()
    await switchWorkspaceTab('Folder U')
    await openChatDrawer()
    const panel = document.querySelector('.content-panel') as HTMLElement
    Object.defineProperty(panel, 'clientWidth', { configurable: true, get: () => 700 })
    const selection = await screen.findByRole('button', { name: 'Open Earlier chat' })
    act(() => {
      selection.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      resizeCallbacks.forEach(callback => callback(700))
    })
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Chat' })).toBeNull())
    const receipt = screen.getByTestId('prefill-receipt-probe')
    const receiptId = receipt.getAttribute('data-receipt-id')
    const targetScope = receiptProbe.scope
    const targetTabId = receipt.getAttribute('data-destination-tab-id') ?? ''
    expect(receiptId).not.toBe('')
    expect(receipt.getAttribute('data-receipt-status')).toBe('bound-eligible')
    expect(getComposerDraft(CHAT, USER, targetTabId, targetScope)).toBe('')

    const actualDeletionStatus = clerum.chat.deletionStatus.getMockImplementation()
    if (!actualDeletionStatus) throw new Error('Expected the authoritative ChatStore status reader')
    const renameInvoked = deferred<void>()
    let rejectedIndexRename = false
    const statusResults: string[] = []
    const originalRename = fs.rename.bind(fs)
    const renameBoundary = vi.spyOn(fs, 'rename').mockImplementation(async (...args: any[]) => {
      if (String(args[0]).endsWith('/index.json.tmp') && !rejectedIndexRename) {
        rejectedIndexRename = true
        renameInvoked.resolve()
        throw Object.assign(new Error('Controlled index rename failure before commit'), {
          code: 'EIO',
        })
      }
      return Reflect.apply(originalRename, fs, args)
    })
    clerum.chat.deletionStatus.mockImplementation(async (...args) => {
      const status = await actualDeletionStatus(...args)
      statusResults.push(status.status)
      return status
    })

    try {
      fireEvent.click(screen.getByRole('button', { name: 'Session options for Earlier chat' }))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
      const dialog = await screen.findByRole('dialog', { name: 'Delete session?' })
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
      await renameInvoked.promise
      await waitFor(() => expect(statusResults).toEqual(['unknown']))

      expect(rejectedIndexRename).toBe(true)
      expect(clerum.chat.delete).toHaveBeenCalledTimes(1)
      expect(clerum.chat.deletionStatus).toHaveBeenCalledTimes(1)
      await screen.findByText(
        'Could not confirm whether the chat was deleted. Its status is still unknown.'
      )
      const pendingRevision = Number(
        screen.getByTestId('prefill-receipt-probe').getAttribute('data-pending-deletion-revision')
      )
      expect(pendingRevision).toBeGreaterThan(0)
      expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')).toBe(
        receiptId
      )
      expect(getComposerDraft(CHAT, USER, targetTabId, targetScope)).toBe('')
      expect(receiptProbe.ids).toContain(Number(receiptId))
      expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()

      const settledStatusCalls = clerum.chat.deletionStatus.mock.calls.length
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 25))
      })
      expect(clerum.chat.deletionStatus).toHaveBeenCalledTimes(settledStatusCalls)
      expect(statusResults).toEqual(['unknown'])
      expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')).toBe(
        receiptId
      )
      expect(
        Number(
          screen.getByTestId('prefill-receipt-probe').getAttribute('data-pending-deletion-revision')
        )
      ).toBe(pendingRevision)
      expect(getComposerDraft(CHAT, USER, targetTabId, targetScope)).toBe('')
      expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
    } finally {
      await Promise.allSettled([
        ...clerum.chat.delete.mock.results.map(result => result.value),
        ...clerum.chat.deletionStatus.mock.results.map(result => result.value),
      ])
      renameBoundary.mockRestore()
    }
  })

  it('A3-19 resolves an invoked rename rejection from the valid durable index', async () => {
    const { clerum } = await setupApp()
    await clerum.chat.create(USER, CHAT)
    expect((await clerum.readIndex(USER)).chats.map(chat => chat.id)).toContain(CHAT)
    await openFolderU()
    await switchWorkspaceTab('Folder U')
    await openChatDrawer()
    const input = (await selectSidebarConversation()) as HTMLTextAreaElement
    await waitFor(() => expect(input.value).toBe(U_URI))
    fireEvent.change(input, { target: { value: '' } })
    await waitFor(() => expect(getComposerDraft(CHAT, USER)).toBe(''))
    const targetScope = receiptProbe.scope
    const targetTabId = receiptProbe.tabId
    const receiptId = screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')
    const pendingBefore = Number(
      screen.getByTestId('prefill-receipt-probe').getAttribute('data-pending-deletion-revision')
    )
    const actualDeletionStatus = clerum.chat.deletionStatus.getMockImplementation()
    if (!actualDeletionStatus) throw new Error('Expected the authoritative ChatStore status reader')
    const renameInvoked = deferred<void>()
    const statusResults: string[] = []
    const originalRename = fs.rename.bind(fs)
    const renameBoundary = vi.spyOn(fs, 'rename').mockImplementation(async (...args: any[]) => {
      if (String(args[0]).endsWith('/index.json.tmp')) {
        renameInvoked.resolve()
        throw Object.assign(new Error('Controlled index rename rejection before commit'), {
          code: 'EIO',
        })
      }
      return Reflect.apply(originalRename, fs, args)
    })
    clerum.chat.deletionStatus.mockImplementation(async (...args) => {
      const status = await actualDeletionStatus(...args)
      statusResults.push(status.status)
      return status
    })

    try {
      fireEvent.click(screen.getByRole('button', { name: 'Session options for Earlier chat' }))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
      const dialog = await screen.findByRole('dialog', { name: 'Delete session?' })
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
      await renameInvoked.promise
      await waitFor(() => expect(statusResults).toEqual(['not-deleted']))

      expect(clerum.chat.delete).toHaveBeenCalledTimes(1)
      expect(clerum.chat.deletionStatus).toHaveBeenCalledTimes(1)
      const index = await clerum.readIndex(USER)
      expect(index.chats.map(chat => chat.id)).toContain(CHAT)
      expect(index.deletedChatTombstones ?? []).toHaveLength(0)
      expect(screen.getByText('Could not delete the chat. Please try again.')).toBeTruthy()
      expect(
        Number(
          screen.getByTestId('prefill-receipt-probe').getAttribute('data-pending-deletion-revision')
        )
      ).toBeGreaterThan(pendingBefore)
      expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')).toBe(
        receiptId
      )
      expect(getComposerDraft(CHAT, USER, targetTabId, targetScope)).toBe('')
      expect(input.value).toBe('')
      expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
      const settledStatusCalls = clerum.chat.deletionStatus.mock.calls.length
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 25))
      })
      expect(clerum.chat.deletionStatus).toHaveBeenCalledTimes(settledStatusCalls)
      expect(statusResults).toEqual(['not-deleted'])
    } finally {
      await Promise.allSettled([
        ...clerum.chat.delete.mock.results.map(result => result.value),
        ...clerum.chat.deletionStatus.mock.results.map(result => result.value),
      ])
      renameBoundary.mockRestore()
    }
  })

  it('A3-19 retries directory sync before resolving a post-rename deletion as deleted', async () => {
    const { clerum } = await setupApp()
    await clerum.chat.create(USER, CHAT)
    await openFolderU()
    await switchWorkspaceTab('Folder U')
    await openChatDrawer()
    const input = (await selectSidebarConversation()) as HTMLTextAreaElement
    await waitFor(() => expect(input.value).toBe(U_URI))
    fireEvent.change(input, { target: { value: '' } })
    await waitFor(() => expect(getComposerDraft(CHAT, USER)).toBe(''))
    const targetScope = receiptProbe.scope
    const targetTabId = receiptProbe.tabId
    const actualDelete = clerum.chat.delete.getMockImplementation()
    const actualDeletionStatus = clerum.chat.deletionStatus.getMockImplementation()
    if (!actualDelete || !actualDeletionStatus) {
      throw new Error('Expected real ChatStore delete and status operations')
    }
    const originalOpen = fs.open.bind(fs)
    const originalRename = fs.rename.bind(fs)
    const syncSpies: Array<{ mockRestore: () => void }> = []
    let indexRenameCompleted = false
    let postCommitSyncRejected = false
    let postCommitSyncAttempts = 0
    const statusResults: string[] = []
    const renameBoundary = vi.spyOn(fs, 'rename').mockImplementation(async (...args: any[]) => {
      const result = await Reflect.apply(originalRename, fs, args)
      if (String(args[0]).endsWith('/index.json.tmp')) indexRenameCompleted = true
      return result
    })
    const openBoundary = vi.spyOn(fs, 'open').mockImplementation(async (...args: any[]) => {
      const handle = await Reflect.apply(originalOpen, fs, args)
      if (String(args[0]).endsWith(`/${USER}`)) {
        const originalSync = handle.sync.bind(handle)
        const syncSpy = vi.spyOn(handle, 'sync').mockImplementation(async () => {
          if (indexRenameCompleted) {
            postCommitSyncAttempts += 1
            if (!postCommitSyncRejected) {
              postCommitSyncRejected = true
              throw Object.assign(new Error('Controlled post-rename directory sync failure'), {
                code: 'EIO',
              })
            }
          }
          return originalSync()
        })
        syncSpies.push(syncSpy)
      }
      return handle
    })
    clerum.chat.delete.mockImplementation((...args) => actualDelete(...args))
    clerum.chat.deletionStatus.mockImplementation(async (...args) => {
      const status = await actualDeletionStatus(...args)
      statusResults.push(status.status)
      return status
    })

    try {
      fireEvent.click(screen.getByRole('button', { name: 'Session options for Earlier chat' }))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
      const dialog = await screen.findByRole('dialog', { name: 'Delete session?' })
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
      await waitFor(() => expect(statusResults).toEqual(['deleted']))

      expect(indexRenameCompleted).toBe(true)
      expect(postCommitSyncRejected).toBe(true)
      // One initial commit sync, one authoritative status sync, then the
      // queued cleanup index write and its directory sync.
      expect(postCommitSyncAttempts).toBe(4)
      expect(clerum.chat.delete).toHaveBeenCalledTimes(1)
      expect(clerum.chat.deletionStatus).toHaveBeenCalledTimes(1)
      const index = await clerum.readIndex(USER)
      expect(index.chats.map(chat => chat.id)).not.toContain(CHAT)
      expect(index.deletedChatTombstones).toContainEqual({
        chatId: CHAT,
        authorityScope: expect.objectContaining({ userId: 'user-1', teamId: 'team-1' }),
      })
      expect(index.pendingChatCleanup ?? []).not.toContainEqual(
        expect.objectContaining({ chatId: CHAT })
      )
      expect(await clerum.persistedMessages(USER, CHAT)).toEqual([])
      await waitFor(() => {
        expect(screen.queryByRole('button', { name: 'Open Earlier chat' })).toBeNull()
        expect(screen.getByTestId('chat-thread-stub').textContent).not.toBe(CHAT)
      })
      expect(getComposerDraft(CHAT, USER, targetTabId, targetScope)).toBe('')
      expect(input.value).not.toContain(U_URI)
      expect(screen.queryByText('Could not delete the chat. Please try again.')).toBeNull()
      expect(
        screen.queryByText(
          'Could not confirm whether the chat was deleted. Its status is still unknown.'
        )
      ).toBeNull()
      expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
      const settledStatusCalls = clerum.chat.deletionStatus.mock.calls.length
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 25))
      })
      expect(clerum.chat.deletionStatus).toHaveBeenCalledTimes(settledStatusCalls)
      expect(statusResults).toEqual(['deleted'])
    } finally {
      await Promise.allSettled([
        ...clerum.chat.delete.mock.results.map(result => result.value),
        ...clerum.chat.deletionStatus.mock.results.map(result => result.value),
      ])
      openBoundary.mockRestore()
      renameBoundary.mockRestore()
      for (const syncSpy of syncSpies) syncSpy.mockRestore()
    }
  })

  it('A3-19 keeps a post-rename deletion unknown when directory sync still fails', async () => {
    const { clerum } = await setupApp()
    await clerum.chat.create(USER, CHAT)
    await clerum.chat.appendMessages(USER, CHAT, [
      { id: 'cleanup-proof-message', role: 'user', content: 'persisted transcript', timestamp: 1 },
    ])
    await openFolderU()
    await switchWorkspaceTab('Folder U')
    await openChatDrawer()
    const input = (await selectSidebarConversation()) as HTMLTextAreaElement
    await waitFor(() => expect(input.value).toBe(U_URI))
    fireEvent.change(input, { target: { value: '' } })
    await waitFor(() => expect(getComposerDraft(CHAT, USER)).toBe(''))
    const actualDelete = clerum.chat.delete.getMockImplementation()
    const actualDeletionStatus = clerum.chat.deletionStatus.getMockImplementation()
    if (!actualDelete || !actualDeletionStatus) {
      throw new Error('Expected real ChatStore delete and status operations')
    }
    const originalOpen = fs.open.bind(fs)
    const originalRename = fs.rename.bind(fs)
    const syncSpies: Array<{ mockRestore: () => void }> = []
    let indexRenameCompleted = false
    let postCommitSyncAttempts = 0
    let failPostCommitSync = true
    const statusResults: string[] = []
    const statusResolutions: Array<{ status: string; cleanupPending: boolean }> = []
    const renameBoundary = vi.spyOn(fs, 'rename').mockImplementation(async (...args: any[]) => {
      const result = await Reflect.apply(originalRename, fs, args)
      if (String(args[0]).endsWith('/index.json.tmp')) indexRenameCompleted = true
      return result
    })
    const openBoundary = vi.spyOn(fs, 'open').mockImplementation(async (...args: any[]) => {
      const handle = await Reflect.apply(originalOpen, fs, args)
      if (String(args[0]).endsWith(`/${USER}`)) {
        const originalSync = handle.sync.bind(handle)
        const syncSpy = vi.spyOn(handle, 'sync').mockImplementation(async () => {
          if (indexRenameCompleted) {
            postCommitSyncAttempts += 1
            if (failPostCommitSync) {
              throw Object.assign(new Error('Controlled post-rename directory sync failure'), {
                code: 'EIO',
              })
            }
          }
          return originalSync()
        })
        syncSpies.push(syncSpy)
      }
      return handle
    })
    clerum.chat.delete.mockImplementation((...args) => actualDelete(...args))
    clerum.chat.deletionStatus.mockImplementation(async (...args) => {
      const resolution = await actualDeletionStatus(...args)
      statusResults.push(resolution.status)
      statusResolutions.push(resolution)
      return resolution
    })

    try {
      fireEvent.click(screen.getByRole('button', { name: 'Session options for Earlier chat' }))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
      const dialog = await screen.findByRole('dialog', { name: 'Delete session?' })
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
      await waitFor(() => expect(statusResults).toHaveLength(1))
      await waitFor(() =>
        expect(
          screen.getByText(
            'Could not confirm whether the chat was deleted. Its status is still unknown.'
          )
        ).toBeTruthy()
      )

      expect(indexRenameCompleted).toBe(true)
      expect(postCommitSyncAttempts).toBe(2)
      expect(clerum.chat.delete).toHaveBeenCalledTimes(1)
      expect(clerum.chat.deletionStatus).toHaveBeenCalledTimes(1)
      expect(statusResults).toEqual(['unknown'])
      expect(statusResolutions[0]).toEqual({ status: 'unknown', cleanupPending: false })
      expect(screen.getByRole('button', { name: 'Open Earlier chat' })).toBeTruthy()
      expect(screen.getByTestId('chat-thread-stub').textContent).toBe(CHAT)
      expect(getComposerDraft(CHAT, USER)).toBe('')
      expect(input.value).toBe('')
      expect(
        screen.getByText(
          'Could not confirm whether the chat was deleted. Its status is still unknown.'
        )
      ).toBeTruthy()
      expect(screen.queryByText('Could not delete the chat. Please try again.')).toBeNull()
      expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()

      const settledStatusCalls = clerum.chat.deletionStatus.mock.calls.length
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 25))
      })
      expect(clerum.chat.deletionStatus).toHaveBeenCalledTimes(settledStatusCalls)
      expect(postCommitSyncAttempts).toBe(2)
      expect(statusResults).toEqual(['unknown'])

      // A later genuine focus performs the permitted bounded authoritative
      // recovery. It must retire the deleted destination, clear its draft and
      // finish the queued transcript cleanup without another catalog reload.
      failPostCommitSync = false
      fireEvent.blur(input)
      fireEvent.focus(input)
      await waitFor(() => expect(statusResults).toEqual(['unknown', 'deleted']))
      await waitFor(() => {
        expect(screen.queryByRole('button', { name: 'Open Earlier chat' })).toBeNull()
        expect(screen.getByTestId('chat-thread-stub').textContent).not.toBe(CHAT)
      })
      const recoveredIndex = await clerum.readIndex(USER)
      expect(recoveredIndex.pendingChatCleanup ?? []).not.toContainEqual(
        expect.objectContaining({ chatId: CHAT })
      )
      expect(await clerum.persistedMessages(USER, CHAT)).toEqual([])
      expect(statusResolutions[1]).toEqual({ status: 'deleted', cleanupPending: false })
      // The later status read retries the durability check and then the
      // confirmed deletion drains its queued cleanup entry.
      expect(postCommitSyncAttempts).toBe(5)
      expect(getComposerDraft(CHAT, USER)).toBe('')
      expect(input.value).not.toContain(U_URI)
      expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
      expect(
        screen.queryByText(
          'Chat removed. Local transcript cleanup will retry when this team is active.'
        )
      ).toBeNull()
    } finally {
      await Promise.allSettled([
        ...clerum.chat.delete.mock.results.map(result => result.value),
        ...clerum.chat.deletionStatus.mock.results.map(result => result.value),
      ])
      openBoundary.mockRestore()
      renameBoundary.mockRestore()
      for (const syncSpy of syncSpies) syncSpy.mockRestore()
    }
  })

  it('revalidates a late plugin resource result in the current team before owner publication', async () => {
    const { clerum, gfs, emitPluginGfsResource } = await setupApp()
    await clerum.chat.create(USER, CHAT)
    await openFolderU()
    const previousTeamResource = await openGfsResourcePayload(
      resolvedFile(PREVIEW_ID, 'Notes.md', {
        path: '/Folder U/Notes.md',
        parentResourceId: U_ID,
        bytes: 32,
      })
    )
    await openChatDrawer()
    await selectSidebarConversation()

    fireEvent.click(screen.getByTestId('open-cross-team-same-chat'))
    if (!appTestActions.openTargetPromise) throw new Error('Expected the real team-switch action')
    await act(async () => appTestActions.openTargetPromise)
    await waitFor(() =>
      expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-team-id')).toBe(
        'team-2'
      )
    )

    const input = screen.getByTestId('chat-input') as HTMLTextAreaElement
    await waitFor(() => expect(input.value).toBe(''))
    const scopeB = receiptProbe.scope
    const tabB = receiptProbe.tabId
    expect(scopeB).toContain(':team-2:')
    expect(getComposerDraft(CHAT, USER, tabB, scopeB)).toBe('')
    // Team switching retires the old team's resource authority. This test
    // proves the stale plugin payload cannot publish a replacement owner when
    // current-team revalidation is denied.
    expect(getLatestGfsConversationContext(scopeB)).toBeNull()
    const ownerBeforeLateResult = getLatestGfsConversationContext()
    expect(ownerBeforeLateResult).toBeNull()
    const resolveCallsBeforeLateResult = gfs.resolve.mock.calls.length
    const originalResolve = gfs.resolve.getMockImplementation()
    if (!originalResolve) throw new Error('Expected the real current-scope resolver boundary')
    gfs.resolve.mockImplementation(async uri => {
      if (uri === PREVIEW_URI) throw new Error('403 Forbidden')
      return originalResolve(uri)
    })

    try {
      await act(async () => {
        emitPluginGfsResource(previousTeamResource)
        await new Promise(resolve => setTimeout(resolve, 0))
      })

      expect(input.value).toBe('')
      expect(getComposerDraft(CHAT, USER, tabB, scopeB)).toBe('')
      expect(gfs.resolve.mock.calls.length).toBeGreaterThan(resolveCallsBeforeLateResult)
      expect(gfs.resolve).toHaveBeenCalledWith(PREVIEW_URI)
      const ownerAfterLateResult = getLatestGfsConversationContext()
      // Closing the rejected provisional tab can expose the existing Files U
      // route, which independently resolves under Team B. That current owner
      // is valid; the rejected Team A Preview must never become Team B's owner.
      if (ownerAfterLateResult) {
        expect(ownerAfterLateResult).toMatchObject({ uri: U_URI, authorityScope: scopeB })
      }
      expect(ownerAfterLateResult).not.toMatchObject({ uri: PREVIEW_URI })
      expect(getLatestGfsConversationContext(scopeB)).toEqual(ownerAfterLateResult)
      expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
      expect(
        within(screen.getByRole('toolbar', { name: 'Workspace tabs' })).queryByRole('button', {
          name: 'Notes.md',
        })
      ).toBeNull()
    } finally {
      gfs.resolve.mockImplementation(originalResolve)
    }
  })

  it('keeps a plugin Preview adopted by a newer current-authority selection', async () => {
    const { gfs, emitPluginGfsResource } = await setupApp()
    await openFolderU()
    const preview = resolvedFile(PREVIEW_ID, 'Notes.md', {
      path: '/Folder U/Notes.md',
      parentResourceId: U_ID,
      bytes: 32,
    })
    const payload = await openGfsResourcePayload(preview)
    const stalePluginResolution = deferred<Awaited<ReturnType<typeof gfs.resolve>>>()
    const callsBeforePlugin = gfs.resolve.mock.calls.length
    gfs.resolve.mockImplementationOnce(() => stalePluginResolution.promise)

    await act(async () => {
      emitPluginGfsResource(payload)
      await Promise.resolve()
    })
    await waitFor(() => expect(gfs.resolve).toHaveBeenCalledTimes(callsBeforePlugin + 1))
    const strip = screen.getByRole('toolbar', { name: 'Workspace tabs' })
    const provisionalPreview = await within(strip).findByRole('button', { name: 'Notes.md' })
    expect(getLatestGfsConversationContext()).toBeNull()

    // A separate, genuine tab selection resolves and adopts the provisional
    // Preview under current authority while the plugin's older resolver waits.
    await act(async () => {
      fireEvent.click(provisionalPreview)
    })
    await waitFor(() =>
      expect(getLatestGfsConversationContext()).toMatchObject({
        uri: PREVIEW_URI,
        sourceTabId: expect.any(String),
      })
    )
    const adoptedOwner = getLatestGfsConversationContext()
    expect(
      within(strip).getByRole('button', { name: 'Notes.md' }).getAttribute('aria-pressed')
    ).toBe('true')
    expect(gfs.resolve).toHaveBeenCalledTimes(callsBeforePlugin + 2)
    expect(gfs.resolve).toHaveBeenLastCalledWith(PREVIEW_URI)

    // The older plugin result is now stale. Its cleanup must preserve the
    // exact Preview owner independently published by the newer selection.
    await act(async () => {
      stalePluginResolution.resolve(await resolveResource(preview))
      await stalePluginResolution.promise
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(
        within(strip).getByRole('button', { name: 'Notes.md' }).getAttribute('aria-pressed')
      ).toBe('true')
    })
    expect(getLatestGfsConversationContext()).toEqual(adoptedOwner)
  })

  it('keeps a plugin Files tab adopted by a newer current-authority selection', async () => {
    const { gfs, emitPluginGfsResource } = await setupApp()
    await openFolderU()
    const payload = await openGfsResourcePayload(
      resolvedDirectory(V_ID, 'Folder V', {
        path: '/Folder U/Folder V',
        parentResourceId: U_ID,
      })
    )
    const stalePluginResolution = deferred<Awaited<ReturnType<typeof gfs.resolve>>>()
    const pluginResolveEntered = deferred<void>()
    let pluginResolveHeld = false
    const originalResolve = gfs.resolve.getMockImplementation()
    if (!originalResolve) throw new Error('Expected the real plugin resolver boundary')
    gfs.resolve.mockImplementation(async uri => {
      if (uri === V_URI && !pluginResolveHeld) {
        pluginResolveHeld = true
        pluginResolveEntered.resolve()
        return stalePluginResolution.promise
      }
      return originalResolve(uri)
    })

    await act(async () => {
      emitPluginGfsResource(payload)
      await Promise.resolve()
    })
    await pluginResolveEntered.promise
    const strip = screen.getByRole('toolbar', { name: 'Workspace tabs' })
    const provisionalFiles = await within(strip).findByRole('button', { name: 'Folder V' })
    expect(getLatestGfsConversationContext()).toMatchObject({ uri: V_URI })
    const provisionalOwner = getLatestGfsConversationContext()

    // Leaving and genuinely reselecting the Files tab causes its current owner
    // to resolve and publish the same target while the plugin's older read waits.
    await switchWorkspaceTab('New chat')
    await switchWorkspaceTab('Folder V')
    const adoptedOwner = await waitFor(() => {
      const owner = getLatestGfsConversationContext()
      expect(owner).toMatchObject({ uri: V_URI, sourceTabId: expect.any(String) })
      return owner
    })
    expect(provisionalFiles.getAttribute('aria-pressed')).toBe('true')
    expect(adoptedOwner?.sourceTabId).toBe(provisionalOwner?.sourceTabId)

    await act(async () => {
      stalePluginResolution.resolve(
        await resolveResource(
          resolvedDirectory(V_ID, 'Folder V', {
            path: '/Folder U/Folder V',
            parentResourceId: U_ID,
          })
        )
      )
      await stalePluginResolution.promise
      await Promise.resolve()
    })

    expect(getLatestGfsConversationContext()).toMatchObject({
      uri: V_URI,
      authorityScope: adoptedOwner?.authorityScope,
      sourceTabId: provisionalOwner?.sourceTabId,
    })
    await waitFor(() => {
      expect(provisionalFiles.isConnected).toBe(true)
      expect(provisionalFiles.getAttribute('aria-pressed')).toBe('true')
    })
  })

  it('hands a reselected Files seed to Preview after the current resource becomes previewable', async () => {
    const { gfs, emitPluginGfsResource } = await setupApp(undefined, false, [USER], false, {
      previewName: 'Archive.zip',
    })
    gfs.affordances.mockResolvedValue(await affordancesResult(heldAffordances(['read', 'write'])))

    let currentName = 'Archive.zip'
    let currentVersion = 1
    const originalResolve = gfs.resolve.getMockImplementation()
    const originalListChildren = gfs.listChildren.getMockImplementation()
    if (!originalResolve || !originalListChildren) {
      throw new Error('Expected the real Files resolver and child-list boundaries')
    }
    gfs.resolve.mockImplementation(async uri => {
      if (uri !== PREVIEW_URI) return originalResolve(uri)
      return resolveResource(
        resolvedFile(PREVIEW_ID, currentName, {
          path: `/Folder U/${currentName}`,
          parentResourceId: U_ID,
          bytes: 32,
          version: currentVersion,
        })
      )
    })
    gfs.listChildren.mockImplementation(async resourceId => {
      if (resourceId !== U_ID) return originalListChildren(resourceId)
      return listChildrenPage([
        childView(V_ID, 'Folder V', 'directory', {
          path: '/Folder U/Folder V',
          parentResourceId: U_ID,
        }),
        childView(PREVIEW_ID, currentName, 'file', {
          path: `/Folder U/${currentName}`,
          parentResourceId: U_ID,
          bytes: 32,
          version: currentVersion,
        }),
      ])
    })
    const renameRequestJson = vi.fn(
      async <T,>(_method: string, _url: string, options?: { body?: unknown }): Promise<T> => {
        const body = options?.body as { newName?: string; ifMatch?: number } | undefined
        if (!body?.newName || body.ifMatch !== currentVersion) {
          throw new Error('Expected the current real rename request')
        }
        currentName = body.newName
        currentVersion += 1
        return structuredClone({
          ok: true as const,
          data: { resourceId: PREVIEW_ID, version: currentVersion },
        }) as T
      }
    )
    const renameClient = new GfsClient({
      baseUrl: 'https://gfs.fixture.test',
      requestJson: renameRequestJson as GfsTransport['requestJson'],
      fetchBytes: async () => new ArrayBuffer(0),
    })
    const renameResource = vi.fn(
      async (resourceId: string, name: string, drive?: string, ifMatch?: number) => {
        const result = await renameClient.renameResource(
          { resourceId, newName: name, drive, ifMatch },
          'fixture-session'
        )
        return structuredClone(result)
      }
    )
    const download = vi.fn(async () => ({ bytes: new ArrayBuffer(0) }))
    Object.assign(gfs, { renameResource, download })

    const pluginPayload = await openGfsResourcePayload(
      resolvedFile(PREVIEW_ID, 'Archive.zip', {
        path: '/Folder U/Archive.zip',
        parentResourceId: U_ID,
        bytes: 32,
      })
    )
    await act(async () => {
      emitPluginGfsResource(pluginPayload)
      await Promise.resolve()
    })
    await waitFor(() => expect(download).toHaveBeenCalledOnce())
    const workspaceStrip = screen.getByRole('toolbar', { name: 'Workspace tabs' })
    const filesSeedTab = await within(workspaceStrip).findByRole('button', { name: 'Files' })

    // A second Files tab owns the parent folder while the first tab retains its
    // persisted Archive.zip seed.
    await openFolderU()
    fireEvent.click(await screen.findByRole('button', { name: 'Rename Archive.zip' }))
    fireEvent.change(await screen.findByRole('textbox', { name: 'New name' }), {
      target: { value: 'Notes.md' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }))
    await waitFor(() => expect(renameResource).toHaveBeenCalledOnce())
    await screen.findByRole('button', { name: 'Rename Notes.md' })
    expect(currentName).toBe('Notes.md')

    // Reselecting remounts the real Files owner. Its current-authority seed
    // resolution now hands the same resource to the Preview tab.
    const resolvesBeforeReselection = gfs.resolve.mock.calls.filter(
      ([uri]) => uri === PREVIEW_URI
    ).length
    await switchWorkspaceTab('New chat')
    expect(filesSeedTab.isConnected).toBe(true)
    fireEvent.click(filesSeedTab)
    const strip = screen.getByRole('toolbar', { name: 'Workspace tabs' })
    const previewTab = await within(strip).findByRole('button', { name: 'Notes.md' })
    await waitFor(() => expect(getLatestGfsConversationContext()?.uri).toBe(PREVIEW_URI))

    expect(gfs.resolve.mock.calls.filter(([uri]) => uri === PREVIEW_URI).length).toBeGreaterThan(
      resolvesBeforeReselection
    )
    expect(getLatestGfsConversationContext()).toMatchObject({
      uri: PREVIEW_URI,
      sourceTabId: expect.any(String),
    })
    expect(download).toHaveBeenCalledOnce()
    expect(previewTab.getAttribute('aria-pressed')).toBe('true')
  })

  it('retires a provisional plugin Preview when current resolution selects an image overlay', async () => {
    const { clerum, gfs, emitPluginGfsResource, queryClient, view } = await setupApp()
    await openFolderU()
    const payload = await openGfsResourcePayload(
      resolvedFile(PREVIEW_ID, 'Notes.md', {
        path: '/Folder U/Notes.md',
        parentResourceId: U_ID,
        bytes: 32,
      })
    )
    const currentImage = await resolveResource(
      resolvedFile(PREVIEW_ID, 'chart.png', {
        path: '/Folder U/chart.png',
        parentResourceId: U_ID,
        bytes: 32,
      })
    )
    const resolveEntered = deferred<void>()
    const currentResolve = deferred<Awaited<ReturnType<typeof gfs.resolve>>>()
    const originalResolve = gfs.resolve.getMockImplementation()
    if (!originalResolve) throw new Error('Expected the real current-scope resolver boundary')
    const strip = screen.getByRole('toolbar', { name: 'Workspace tabs' })
    gfs.resolve.mockImplementation(async uri => {
      if (uri === PREVIEW_URI) {
        resolveEntered.resolve()
        return currentResolve.promise
      }
      return originalResolve(uri)
    })

    try {
      await act(async () => {
        emitPluginGfsResource(payload)
        await Promise.resolve()
      })
      await resolveEntered.promise
      expect(await within(strip).findByRole('button', { name: 'Notes.md' })).toBeTruthy()

      await act(async () => {
        currentResolve.resolve(currentImage)
        await Promise.resolve()
      })
      await waitFor(() =>
        expect(within(strip).queryByRole('button', { name: 'Notes.md' })).toBeNull()
      )
      await waitFor(() => expect(clerum.sandboxUi.setVisible).toHaveBeenCalledWith(false))
      expect(screen.getByRole('heading', { name: 'Files' })).toBeTruthy()
      expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
    } finally {
      currentResolve.resolve(currentImage)
      gfs.resolve.mockImplementation(originalResolve)
      await queryClient.cancelQueries()
      queryClient.clear()
      view.unmount()
    }
  })

  it('refreshes a provisional plugin Preview from current-scope metadata for the same URI', async () => {
    const { clerum, gfs, emitPluginGfsResource, queryClient, view } = await setupApp()
    await openFolderU()
    const payload = await openGfsResourcePayload(
      resolvedFile(PREVIEW_ID, 'Notes.md', {
        path: '/Folder U/Notes.md',
        parentResourceId: U_ID,
        bytes: 32,
      })
    )
    const currentFile = await resolveResource(
      resolvedFile(PREVIEW_ID, 'Renamed.md', {
        path: '/Folder U/Renamed.md',
        parentResourceId: U_ID,
        bytes: 64,
        version: 2,
      })
    )
    const currentResolveEntered = deferred<void>()
    const currentResolve = deferred<Awaited<ReturnType<typeof gfs.resolve>>>()
    const originalResolve = gfs.resolve.getMockImplementation()
    if (!originalResolve) throw new Error('Expected the real current-scope resolver boundary')
    gfs.resolve.mockImplementation(async uri => {
      if (uri === PREVIEW_URI) {
        currentResolveEntered.resolve()
        return currentResolve.promise
      }
      return originalResolve(uri)
    })

    try {
      await act(async () => {
        emitPluginGfsResource(payload)
        await Promise.resolve()
      })
      const strip = screen.getByRole('toolbar', { name: 'Workspace tabs' })
      await currentResolveEntered.promise
      await within(strip).findByRole('button', { name: 'Notes.md' })
      await act(async () => {
        currentResolve.resolve(currentFile)
        await currentResolve.promise
      })
      await within(strip).findByRole('button', { name: 'Renamed.md' })
      expect(within(strip).queryByRole('button', { name: 'Notes.md' })).toBeNull()
      expect(getLatestGfsConversationContext()).toMatchObject({
        uri: PREVIEW_URI,
        authorityScope: receiptProbe.scope,
      })
      expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
    } finally {
      currentResolve.resolve(currentFile)
      gfs.resolve.mockImplementation(originalResolve)
      await queryClient.cancelQueries()
      queryClient.clear()
      view.unmount()
    }
  })

  it('retires a provisional plugin Preview when current resolution routes to Files', async () => {
    const { clerum, gfs, emitPluginGfsResource, queryClient, view } = await setupApp()
    await openFolderU()
    const payload = await openGfsResourcePayload(
      resolvedFile(PREVIEW_ID, 'Notes.md', {
        path: '/Folder U/Notes.md',
        parentResourceId: U_ID,
        bytes: 32,
      })
    )
    const currentDirectory = await resolveResource(
      resolvedDirectory(PREVIEW_ID, 'Updated folder', {
        path: '/Folder U/Updated folder',
        parentResourceId: U_ID,
      })
    )
    const originalResolve = gfs.resolve.getMockImplementation()
    if (!originalResolve) throw new Error('Expected the real current-scope resolver boundary')
    gfs.resolve.mockImplementation(async uri =>
      uri === PREVIEW_URI ? currentDirectory : originalResolve(uri)
    )

    try {
      await act(async () => {
        emitPluginGfsResource(payload)
        await Promise.resolve()
      })
      const strip = screen.getByRole('toolbar', { name: 'Workspace tabs' })
      await waitFor(() =>
        expect(within(strip).queryByRole('button', { name: 'Notes.md' })).toBeNull()
      )
      expect(screen.getByRole('heading', { name: 'Files' })).toBeTruthy()
      expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
    } finally {
      gfs.resolve.mockImplementation(originalResolve)
      await queryClient.cancelQueries()
      queryClient.clear()
      view.unmount()
    }
  })

  it('C7 gates reselection through D1 and D2 and recovers on a later focus event', async () => {
    const targetChatId = CHAT
    const { clerum } = await setupApp()
    await clerum.chat.create(USER, targetChatId)
    expect((await clerum.chat.deletionStatus(USER, targetChatId, receiptProbe.scope)).status).toBe(
      'not-deleted'
    )
    await openFolderU()
    const selectedComposer = (await selectSidebarConversation()) as HTMLTextAreaElement
    await waitFor(() => expect(selectedComposer.value).toBe(U_URI))
    await switchWorkspaceTab('Folder U')
    await openChatDrawer()
    const input = screen.getByTestId('chat-input') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: '' } })
    await waitFor(() => expect(getComposerDraft(targetChatId, USER)).toBe(''))
    const targetTabId = receiptProbe.tabId
    const targetScope = receiptProbe.scope
    expect((await clerum.chat.deletionStatus(USER, targetChatId, targetScope)).status).toBe(
      'not-deleted'
    )

    const actualDelete = clerum.chat.delete.getMockImplementation()
    const actualDeletionStatus = clerum.chat.deletionStatus.getMockImplementation()
    if (!actualDelete || !actualDeletionStatus) {
      throw new Error('Expected the real serialized ChatStore deletion operations')
    }
    const firstStatusReadEntered = deferred<void>()
    const releaseFirstStatusRead = deferred<void>()
    const secondDeleteWriteEntered = deferred<void>()
    const releaseSecondDeleteWrite = deferred<void>()
    const statusResults: string[] = []
    let statusCalls = 0
    let deleteCalls = 0
    let deleteOperationActive = false
    let firstStatusReadHeld = false
    const originalReadFile = fs.readFile.bind(fs)
    const originalWriteFile = fs.writeFile.bind(fs)
    const readBarrier = vi.spyOn(fs, 'readFile').mockImplementation(async (...args: any[]) => {
      const path = String(args[0])
      if (path.endsWith('/index.json') && statusCalls === 1 && !firstStatusReadHeld) {
        firstStatusReadHeld = true
        firstStatusReadEntered.resolve()
        await releaseFirstStatusRead.promise
      }
      return Reflect.apply(originalReadFile, fs, args)
    })
    const writeBarrier = vi.spyOn(fs, 'writeFile').mockImplementation(async (...args: any[]) => {
      const path = String(args[0])
      if (deleteOperationActive && path.endsWith('/.tombstones.json.tmp')) {
        if (deleteCalls === 1) {
          throw Object.assign(new Error('D1 failed before durable commit'), { code: 'EIO' })
        }
        if (deleteCalls === 2) {
          secondDeleteWriteEntered.resolve()
          await releaseSecondDeleteWrite.promise
          throw Object.assign(new Error('D2 failed before durable commit'), { code: 'EIO' })
        }
      }
      return Reflect.apply(originalWriteFile, fs, args)
    })
    clerum.chat.delete.mockImplementation(async (...args) => {
      deleteCalls += 1
      deleteOperationActive = true
      try {
        return await actualDelete(...args)
      } finally {
        deleteOperationActive = false
      }
    })
    clerum.chat.deletionStatus.mockImplementation(async (...args) => {
      statusCalls += 1
      const status = await actualDeletionStatus(...args)
      statusResults.push(status.status)
      return status
    })

    try {
      fireEvent.click(screen.getByRole('button', { name: 'Session options for Earlier chat' }))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
      const sidebarDialog = await screen.findByRole('dialog', { name: 'Delete session?' })
      await act(async () => {
        fireEvent.click(within(sidebarDialog).getByRole('button', { name: 'Delete' }))
        await firstStatusReadEntered.promise
      })
      expect(statusCalls).toBe(1)
      expect(deleteCalls).toBe(1)
      expect((await clerum.readIndex(USER)).deletedChatTombstones ?? []).toHaveLength(0)

      resizeAppTo(1200)
      const drawer = await screen.findByRole('complementary', { name: 'Chat' })
      fireEvent.click(within(drawer).getByRole('button', { name: 'New chat' }))
      const threadRow = await screen.findByTestId('agent-chat-row')
      expect(threadRow.getAttribute('data-chat-id')).toBe(targetChatId)
      fireEvent.click(
        within(threadRow).getByRole('button', { name: 'Session actions for Earlier chat' })
      )
      fireEvent.click(within(threadRow).getByRole('button', { name: 'Delete' }))
      const threadDialog = await screen.findByRole('dialog', { name: 'Delete session?' })
      await act(async () => {
        fireEvent.click(within(threadDialog).getByRole('button', { name: 'Delete' }))
        await Promise.resolve()
      })
      expect(deleteCalls).toBe(2)

      await act(async () => {
        releaseFirstStatusRead.resolve()
        await secondDeleteWriteEntered.promise
      })
      await waitFor(() => expect(statusResults).toEqual(['not-deleted']))
      expect(statusCalls).toBe(1)
      expect((await clerum.readIndex(USER)).deletedChatTombstones ?? []).toHaveLength(0)
      const receiptIdBeforePendingSelection = Number(
        screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')
      )
      fireEvent.click(screen.getByRole('button', { name: 'Open Earlier chat' }))
      const pendingInput = (await screen.findByTestId('chat-input')) as HTMLTextAreaElement
      await waitFor(() => expect(pendingInput.value).toBe(''))
      expect(getComposerDraft(targetChatId, USER, targetTabId, targetScope)).toBe('')
      expect(
        Number(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id'))
      ).toBe(receiptIdBeforePendingSelection)
      expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()

      await act(async () => {
        releaseSecondDeleteWrite.resolve()
        await Promise.allSettled([
          ...clerum.chat.delete.mock.results.map(result => result.value),
          ...clerum.chat.deletionStatus.mock.results.map(result => result.value),
        ])
      })
      await waitFor(() => expect(statusResults).toEqual(['not-deleted', 'not-deleted']))
      const finalInput = screen.getByTestId('chat-input') as HTMLTextAreaElement
      const receiptIdBeforeRecovery = Number(
        screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')
      )
      fireEvent.blur(finalInput)
      fireEvent.focus(finalInput)
      await waitFor(() => expect(finalInput.value).toBe(U_URI))
      expect(getComposerDraft(targetChatId, USER, targetTabId, targetScope)).toBe(U_URI)
      expect(
        Number(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id'))
      ).toBeGreaterThan(receiptIdBeforeRecovery)
      expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-status')).toBe(
        'consumed'
      )
      expect(finalInput.value.match(/gfs:\/\//g)).toHaveLength(1)
      await act(async () => {
        await Promise.allSettled(
          clerum.chat.deletionStatus.mock.results.map(result => result.value)
        )
        await Promise.resolve()
      })
      await waitFor(() => expect(statusResults).toHaveLength(statusCalls))
      expect((await clerum.readIndex(USER)).deletedChatTombstones ?? []).toHaveLength(0)
      expect(clerum.chat.delete).toHaveBeenCalledTimes(2)
      expect(statusCalls).toBe(3)
      expect(statusResults).toEqual(['not-deleted', 'not-deleted', 'not-deleted'])
      const settledStatusCallCount = clerum.chat.deletionStatus.mock.calls.length
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 25))
      })
      expect(clerum.chat.deletionStatus).toHaveBeenCalledTimes(settledStatusCallCount)
      expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
    } finally {
      releaseFirstStatusRead.resolve()
      releaseSecondDeleteWrite.resolve()
      await Promise.allSettled([
        ...clerum.chat.delete.mock.results.map(result => result.value),
        ...clerum.chat.deletionStatus.mock.results.map(result => result.value),
      ])
      readBarrier.mockRestore()
      writeBarrier.mockRestore()
    }
  })

  it('reports an unknown deletion result without releasing the target gate', async () => {
    const { clerum } = await setupApp()
    await openFolderU()
    await switchWorkspaceTab('Folder U')
    await openChatDrawer()
    const panel = document.querySelector('.content-panel') as HTMLElement
    Object.defineProperty(panel, 'clientWidth', { configurable: true, get: () => 700 })
    const selection = await screen.findByRole('button', { name: 'Open Earlier chat' })
    act(() => {
      selection.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      resizeCallbacks.forEach(callback => callback(700))
    })
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Chat' })).toBeNull())
    const originalReceiptId = screen
      .getByTestId('prefill-receipt-probe')
      .getAttribute('data-receipt-id')
    expect(originalReceiptId).not.toBe('')
    const originalReceiptStatus = screen
      .getByTestId('prefill-receipt-probe')
      .getAttribute('data-receipt-status')
    expect(originalReceiptStatus).toBe('bound-eligible')
    const resourceContext = getLatestGfsConversationContext()
    expect(resourceContext).toMatchObject({ uri: U_URI })
    const targetTabId =
      screen.getByTestId('prefill-receipt-probe').getAttribute('data-destination-tab-id') ?? ''
    const targetScope = receiptProbe.scope
    expect(targetTabId).not.toBe('')
    expect(getComposerDraft(CHAT, USER, targetTabId, targetScope)).toBe('')

    const actualDelete = clerum.chat.delete.getMockImplementation()
    const actualDeletionStatus = clerum.chat.deletionStatus.getMockImplementation()
    if (!actualDelete || !actualDeletionStatus) {
      throw new Error('Expected the real serialized ChatStore delete and status operations')
    }

    const deleteFailedBeforeCommit = deferred<void>()
    const statusReadEntered = deferred<void>()
    const releaseStatusRead = deferred<void>()
    const originalReadFile = fs.readFile.bind(fs)
    const originalWriteFile = fs.writeFile.bind(fs)
    let deleteOperationActive = false
    let failedBeforeCommit = false
    let statusReadHeld = false
    let statusReadFailureInjected = false
    let statusCalls = 0
    let pendingStatusReadFailures = 0
    const statusResults: string[] = []
    const writeFailure = vi.spyOn(fs, 'writeFile').mockImplementation(async (...args: any[]) => {
      if (
        deleteOperationActive &&
        String(args[0]).endsWith('/.tombstones.json.tmp') &&
        !failedBeforeCommit
      ) {
        failedBeforeCommit = true
        throw Object.assign(new Error('Controlled tombstone precommit failure'), { code: 'EIO' })
      }
      return Reflect.apply(originalWriteFile, fs, args)
    })
    const statusReadBarrier = vi
      .spyOn(fs, 'readFile')
      .mockImplementation(async (...args: any[]) => {
        if (pendingStatusReadFailures > 0 && String(args[0]).endsWith('/index.json')) {
          pendingStatusReadFailures -= 1
          if (!statusReadHeld) {
            statusReadHeld = true
            statusReadEntered.resolve()
            await releaseStatusRead.promise
          }
          statusReadFailureInjected = true
          throw Object.assign(new Error('Controlled authoritative status read failure'), {
            code: 'EACCES',
          })
        }
        return Reflect.apply(originalReadFile, fs, args)
      })
    clerum.chat.delete.mockImplementation(async (...args) => {
      deleteOperationActive = true
      try {
        return await actualDelete(...args)
      } catch (error) {
        deleteFailedBeforeCommit.resolve()
        throw error
      } finally {
        deleteOperationActive = false
      }
    })
    clerum.chat.deletionStatus.mockImplementation(async (...args) => {
      statusCalls += 1
      pendingStatusReadFailures += 1
      const status = await actualDeletionStatus(...args)
      statusResults.push(status.status)
      return status
    })

    try {
      fireEvent.click(screen.getByRole('button', { name: 'Session options for Earlier chat' }))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
      const dialog = await screen.findByRole('dialog', { name: 'Delete session?' })
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))

      await deleteFailedBeforeCommit.promise
      await statusReadEntered.promise
      expect(failedBeforeCommit).toBe(true)
      expect(statusCalls).toBe(1)
      expect((await clerum.readIndex(USER)).deletedChatTombstones ?? []).toHaveLength(0)

      const pendingRevision = Number(
        screen.getByTestId('prefill-receipt-probe').getAttribute('data-pending-deletion-revision')
      )
      expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')).toBe(
        originalReceiptId
      )
      expect(getComposerDraft(CHAT, USER, targetTabId, targetScope)).toBe('')
      expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()

      await act(async () => {
        releaseStatusRead.resolve()
        await Promise.allSettled([
          ...clerum.chat.delete.mock.results.map(result => result.value),
          ...clerum.chat.deletionStatus.mock.results.map(result => result.value),
        ])
        await Promise.resolve()
      })
      await screen.findByText(
        'Could not confirm whether the chat was deleted. Its status is still unknown.'
      )
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0))
      })
      expect(statusReadFailureInjected).toBe(true)
      expect(statusResults).toEqual(['unknown'])
      expect(statusCalls).toBe(1)
      expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')).toBe(
        originalReceiptId
      )
      expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-status')).toBe(
        originalReceiptStatus
      )
      expect(getComposerDraft(CHAT, USER, targetTabId, targetScope)).toBe('')
      expect((await clerum.readIndex(USER)).deletedChatTombstones ?? []).toHaveLength(0)
      expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()

      // Reopening the real Composer is an explicit lifecycle wake. Keep the
      // authoritative reader unavailable for that one bounded retry as well;
      // an unknown first result must not silently release the target gate.
      statusReadHeld = false
      appTestActions.prefillEvents = []
      resizeAppTo(1200)
      const reopenedInput = (await screen.findByTestId('chat-input')) as HTMLTextAreaElement
      await act(async () => {
        await Promise.resolve()
        await new Promise(resolve => setTimeout(resolve, 0))
      })
      const lifecycleWakeCount = appTestActions.prefillEvents.filter(event =>
        ['focus', 'visible', 'resource-activation'].includes(event)
      ).length
      expect(lifecycleWakeCount).toBeGreaterThan(0)
      expect(reopenedInput.value).toBe('')
      expect(getComposerDraft(CHAT, USER, targetTabId, targetScope)).toBe('')
      expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')).toBe(
        originalReceiptId
      )
      expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-status')).toBe(
        originalReceiptStatus
      )
      expect(
        Number(
          screen.getByTestId('prefill-receipt-probe').getAttribute('data-pending-deletion-revision')
        )
      ).toBe(pendingRevision)
      expect((await clerum.readIndex(USER)).deletedChatTombstones ?? []).toHaveLength(0)
      await waitFor(() => expect(statusCalls).toBe(1 + lifecycleWakeCount))
      expect(statusResults).toEqual(Array.from({ length: statusCalls }, () => 'unknown'))
      const settledStatusCalls = statusCalls
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 25))
      })
      expect(statusCalls).toBe(settledStatusCalls)
      expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
    } finally {
      releaseStatusRead.resolve()
      await Promise.allSettled([
        ...clerum.chat.delete.mock.results.map(result => result.value),
        ...clerum.chat.deletionStatus.mock.results.map(result => result.value),
      ])
      statusReadBarrier.mockRestore()
      writeFailure.mockRestore()
    }
  })

  it('B5 keeps the App owner and selected conversation across responsive drawer detach/remount', async () => {
    const { clerum } = await setupApp()
    await openFolderU()
    const firstComposer = await selectSidebarConversation()
    await waitFor(() => expect((firstComposer as HTMLTextAreaElement).value).toBe(U_URI))
    await switchWorkspaceTab('Folder U')
    await openChatDrawer()
    const input = screen.getByTestId('chat-input') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: '' } })
    await waitFor(() => expect(getComposerDraft(CHAT, USER)).toBe(''))
    await navigateIntoV()

    const beforeDetach = getLatestGfsConversationContext()
    expect(beforeDetach).toMatchObject({ uri: V_URI })
    const composerBeforeDetach = screen.getByTestId('chat-input')
    expect(screen.getByTestId('chat-thread-stub').textContent).toBe(CHAT)

    resizeAppTo(700)
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Chat' })).toBeNull())
    expect(screen.queryByTestId('chat-input')).toBeNull()
    expect(
      within(screen.getByRole('toolbar', { name: 'Workspace tabs' }))
        .getByRole('button', { name: 'Folder V' })
        .getAttribute('aria-pressed')
    ).toBe('true')

    await restoreFolderU()
    expect(
      within(screen.getByRole('toolbar', { name: 'Workspace tabs' }))
        .getByRole('button', { name: 'Folder U' })
        .getAttribute('aria-pressed')
    ).toBe('true')
    const whileDetached = getLatestGfsConversationContext()
    expect(whileDetached).toMatchObject({ uri: U_URI, sourceTabId: beforeDetach?.sourceTabId })

    resizeAppTo(1200)
    await screen.findByRole('complementary', { name: 'Chat' })
    const remountedComposer = await screen.findByTestId('chat-input')
    expect(remountedComposer).not.toBe(composerBeforeDetach)
    expect(screen.getByTestId('chat-thread-stub').textContent).toBe(CHAT)
    expect(getLatestGfsConversationContext()).toMatchObject(whileDetached!)
    expect((remountedComposer as HTMLTextAreaElement).value).toBe(V_URI)
    expect(getComposerDraft(CHAT, USER)).toBe(V_URI)
    expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
  })

  it('L1 considers only the verified current resource and does not refill on remount', async () => {
    const { clerum } = await setupApp()
    const initialComposer = (await selectSidebarConversation()) as HTMLTextAreaElement
    expect(initialComposer.value).toBe('')
    expect(getComposerDraft(CHAT, USER)).toBe('')
    await openFolderU()
    await openChatDrawer()

    clerum.rpc.renameSession.mockRejectedValue(await ipcHostAccessRevoked('rpc:renameSession'))
    const verificationChecks: Array<
      ReturnType<typeof deferred<ReturnType<typeof serverSessions>>>
    > = []
    clerum.rpc.listSessions.mockClear()
    clerum.rpc.listSessions.mockImplementation(async (_agent, _team, query) => {
      if (query?.limit === 1) {
        const check = deferred<ReturnType<typeof serverSessions>>()
        verificationChecks.push(check)
        return check.promise
      }
      return serverSessions([{ agent: USER, chatId: CHAT }])
    })
    expect(appTestActions.holdHost).toBeTypeOf('function')
    await act(async () => {
      await appTestActions.holdHost!()
    })
    expect(clerum.rpc.renameSession).toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: 'Open chats' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Conversation unavailable' }))
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-origin')).toBe(
      'drawer-chat-switcher'
    )
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-origin')).toBe(
      'drawer-chat-switcher'
    )
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-status')).toBe(
      'awaiting-authorization'
    )
    await waitFor(() => expect(verificationChecks.length).toBeGreaterThan(0))

    const receiptId = screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')
    expect(receiptId).not.toBe('')
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-status')).toBe(
      'awaiting-authorization'
    )
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: '' } })
    expect(getComposerDraft(CHAT, USER)).toBe('')
    expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).value).toBe('')

    await navigateIntoV()
    expect(getLatestGfsConversationContext()?.uri).toBe(V_URI)
    await act(async () => {
      for (let index = 0; index < verificationChecks.length; index += 1) {
        const check = verificationChecks[index]
        check?.resolve(serverSessions([{ agent: USER, chatId: CHAT }]))
      }
      await Promise.all(verificationChecks.map(check => check.promise))
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    await waitFor(() => {
      const probe = screen.getByTestId('prefill-receipt-probe')
      expect(probe.getAttribute('data-receipt-status')).toBe('consumed')
      expect(probe.getAttribute('data-resource-uri')).toBe(V_URI)
      expect(probe.getAttribute('data-receipt-origin')).toBe('focus')
    })
    const currentReceiptId = screen
      .getByTestId('prefill-receipt-probe')
      .getAttribute('data-receipt-id')
    expect(Number(currentReceiptId)).toBeGreaterThan(Number(receiptId))
    expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).value).toBe(U_URI)
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-resource-uri')).toBe(
      V_URI
    )
    expect(getLatestGfsConversationContext()?.uri).toBe(V_URI)
    expect(getComposerDraft(CHAT, USER)).toBe(U_URI)
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: '' } })
    expect(getComposerDraft(CHAT, USER)).toBe('')
    fireEvent.focus(screen.getByTestId('chat-input'))
    await waitFor(() =>
      expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).value).toBe(V_URI)
    )
    const refocusReceiptId = screen
      .getByTestId('prefill-receipt-probe')
      .getAttribute('data-receipt-id')
    expect(Number(refocusReceiptId)).toBeGreaterThan(Number(currentReceiptId))
    expect(getComposerDraft(CHAT, USER)).toBe(V_URI)
    expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()

    resizeAppTo(700)
    await waitFor(() => expect(screen.queryByTestId('chat-input')).toBeNull())
    resizeAppTo(1200)
    const remounted = (await screen.findByTestId('chat-input')) as HTMLTextAreaElement
    expect(remounted.value).toBe(V_URI)
    expect(
      Number(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id'))
    ).toBeGreaterThan(Number(refocusReceiptId))
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-status')).toBe(
      'consumed'
    )

    await restoreFolderU()
    expect(remounted.value).toBe(V_URI)
    expect(getComposerDraft(CHAT, USER)).toBe(V_URI)
    expect(
      Number(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id'))
    ).toBeGreaterThan(Number(refocusReceiptId))
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-status')).toBe(
      'consumed'
    )
    expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
  })

  it('L1 restores the owner-held U receipt across resize detach and exact resource restoration', async () => {
    const targetChatId = 'chat-target'
    const { clerum } = await setupApp([
      { agent: USER, chatId: CHAT, title: 'Earlier chat' },
      { agent: USER, chatId: targetChatId, title: 'Target chat' },
    ])
    await openFolderU()
    await switchWorkspaceTab('Folder U')
    await openChatDrawer()
    expect(getComposerDraft(targetChatId, USER)).toBe('')
    receiptProbe.ids = []
    receiptProbe.statuses = []

    expect(
      within(screen.getByRole('toolbar', { name: 'Workspace tabs' })).queryByRole('button', {
        name: 'Target chat',
      })
    ).toBeNull()
    const sidebarSelection = await screen.findByRole('button', { name: 'Open Target chat' })
    const panel = document.querySelector('.content-panel') as HTMLElement
    Object.defineProperty(panel, 'clientWidth', { configurable: true, get: () => 700 })
    act(() => {
      sidebarSelection.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      resizeCallbacks.forEach(callback => callback(700))
    })
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Chat' })).toBeNull())
    expect(screen.queryByTestId('chat-input')).toBeNull()
    const capturedU = getLatestGfsConversationContext()
    expect(capturedU).toMatchObject({ uri: U_URI })
    expect(getComposerDraft(targetChatId, USER)).toBe('')
    const receiptId = screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')
    expect(receiptId).not.toBe('')
    expect(
      within(screen.getByRole('toolbar', { name: 'Workspace tabs' })).getByRole('button', {
        name: 'Target chat',
      })
    ).toBeTruthy()
    expect(receiptProbe.statuses).toContain('pending-ready')

    await navigateIntoV()
    expect(getComposerDraft(targetChatId, USER)).toBe('')
    const statusAtV = screen
      .getByTestId('prefill-receipt-probe')
      .getAttribute('data-receipt-status')
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')).toBe(
      receiptId
    )
    await restoreFolderU()
    expect(getLatestGfsConversationContext()).toMatchObject({
      uri: capturedU?.uri,
      sourceTabId: capturedU?.sourceTabId,
    })
    expect(getComposerDraft(targetChatId, USER)).toBe('')
    const statusAfterRestoration = screen
      .getByTestId('prefill-receipt-probe')
      .getAttribute('data-receipt-status')
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')).toBe(
      receiptId
    )

    resizeAppTo(1200)
    const remountedInput = (await screen.findByTestId('chat-input')) as HTMLTextAreaElement
    expect(remountedInput.value).toBe(U_URI)
    expect(getComposerDraft(targetChatId, USER)).toBe(U_URI)
    const receiptProbeElement = screen.getByTestId('prefill-receipt-probe')
    expect(receiptProbeElement.getAttribute('data-receipt-status')).toBe('consumed')
    const destinationTabId = receiptProbeElement.getAttribute('data-destination-tab-id')
    expect(destinationTabId).not.toBe('')
    expect(receiptProbeElement.getAttribute('data-workspace-chat-tab-id')).toBe(destinationTabId)
    expect(statusAtV).toBe('suspended-resource')
    expect(statusAfterRestoration).toBe('bound-eligible')
    expect(
      Number(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id'))
    ).toBeGreaterThan(Number(receiptId))
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-status')).toBe(
      'consumed'
    )
    expect(receiptProbe.ids).toContain(Number(receiptId))
    expect(getLatestGfsConversationContext()).toMatchObject({
      uri: capturedU?.uri,
      sourceTabId: capturedU?.sourceTabId,
    })
    expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
  })

  it('A3-12 suspends an unconsumed receipt while the Files owner has no resource, then restores U', async () => {
    const targetChatId = 'chat-target'
    const { clerum } = await setupApp([
      { agent: USER, chatId: CHAT, title: 'Earlier chat' },
      { agent: USER, chatId: targetChatId, title: 'Target chat' },
    ])
    await openFolderU()
    await openChatDrawer()

    const panel = document.querySelector('.content-panel') as HTMLElement
    Object.defineProperty(panel, 'clientWidth', { configurable: true, get: () => 700 })
    const sidebarSelection = await screen.findByRole('button', { name: 'Open Target chat' })
    act(() => {
      sidebarSelection.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      resizeCallbacks.forEach(callback => callback(700))
    })
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Chat' })).toBeNull())

    const originalResource = getLatestGfsConversationContext()
    expect(originalResource).toMatchObject({ uri: U_URI })
    const originalReceiptId = screen
      .getByTestId('prefill-receipt-probe')
      .getAttribute('data-receipt-id')
    expect(originalReceiptId).not.toBe('')
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-status')).toBe(
      'bound-eligible'
    )
    expect(getComposerDraft(targetChatId, USER)).toBe('')

    const filesTab = screen.getByRole('toolbar', { name: 'Workspace tabs' })
    fireEvent.click(within(filesTab).getByRole('button', { name: 'Folder U' }))
    const breadcrumbs = screen.getByRole('navigation', { name: 'File location' })
    fireEvent.click(within(breadcrumbs).getByRole('button', { name: 'Shared with me' }))
    await waitFor(() => expect(getLatestGfsConversationContext()).toBeNull())
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')).toBe(
      originalReceiptId
    )
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-status')).toBe(
      'suspended-resource'
    )
    expect(getComposerDraft(targetChatId, USER)).toBe('')

    resizeAppTo(1200)
    const input = (await screen.findByTestId('chat-input')) as HTMLTextAreaElement
    expect(input.value).toBe('')
    expect(getComposerDraft(targetChatId, USER)).toBe('')
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')).toBe(
      originalReceiptId
    )
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-status')).toBe(
      'suspended-resource'
    )

    const previousActivationId = originalResource!.activationId
    await clickFileName('Folder U')
    const restoredResource = getLatestGfsConversationContext()
    expect(restoredResource).toMatchObject({
      uri: U_URI,
      sourceTabId: originalResource?.sourceTabId,
    })
    expect(restoredResource!.activationId).toBeGreaterThan(previousActivationId)
    await waitFor(() => expect(input.value).toBe(U_URI))
    expect(getComposerDraft(targetChatId, USER)).toBe(U_URI)
    expect(input.value.match(/gfs:\/\//g)).toHaveLength(1)
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-status')).toBe(
      'consumed'
    )
    expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
  })

  it('does not refill a revoked inactive Preview resource after genuine Composer refocus', async () => {
    const { clerum, gfs } = await setupApp(undefined, false, undefined, true)
    await openFolderU()
    await clickFileName('Notes.md')
    await waitFor(() => expect(getLatestGfsConversationContext()?.uri).toBe(PREVIEW_URI))
    const resource = getLatestGfsConversationContext()
    const input = (await selectSidebarConversation()) as HTMLTextAreaElement
    await waitFor(() => expect(input.value).toBe(PREVIEW_URI))
    expect(resource?.sourceTabId).toBeTruthy()

    const deniedMessage = await resolveDeniedMessage(PREVIEW_URI)
    const resolveCallsBeforeDenial = gfs.resolve.mock.calls.length
    gfs.resolve.mockRejectedValueOnce(new Error(deniedMessage))
    const emitEntityChange = appTestActions.emitEntityChange
    if (!emitEntityChange) throw new Error('Expected the App entity-change bridge')
    await act(async () => {
      emitEntityChange(USER_SCOPE_INVALIDATED)
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(gfs.resolve).toHaveBeenCalledTimes(resolveCallsBeforeDenial + 1)
      expect(screen.getByRole('toolbar', { name: 'Workspace tabs' }).textContent).toContain(
        'File unavailable'
      )
    })

    fireEvent.change(input, { target: { value: '' } })
    await waitFor(() => expect(getComposerDraft(CHAT, USER)).toBe(''))
    const scope = receiptProbe.scope
    const workspaceChatTabId = receiptProbe.tabId
    const draftRevisionAfterClear = getComposerDraftRevision(CHAT, USER, workspaceChatTabId, scope)
    fireEvent.blur(input)
    fireEvent.focus(input)
    await act(async () => {
      await Promise.resolve()
      await new Promise(resolve => setTimeout(resolve, 0))
    })

    expect(input.value).toBe('')
    expect(getComposerDraft(CHAT, USER)).toBe('')
    expect(gfs.resolve).toHaveBeenCalledTimes(resolveCallsBeforeDenial + 1)
    expect(getComposerDraftRevision(CHAT, USER, workspaceChatTabId, scope)).toBe(
      draftRevisionAfterClear
    )

    await act(async () => {
      emitEntityChange(USER_SCOPE_INVALIDATED)
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(gfs.resolve).toHaveBeenCalledTimes(resolveCallsBeforeDenial + 2)
      expect(screen.getByRole('toolbar', { name: 'Workspace tabs' }).textContent).toContain(
        'Notes.md'
      )
    })
    expect(input.value).toBe('')
    expect(getComposerDraft(CHAT, USER)).toBe('')
    expect(getLatestGfsConversationContext()).toMatchObject({
      uri: PREVIEW_URI,
      sourceTabId: resource?.sourceTabId,
      activationId: resource?.activationId,
    })

    fireEvent.blur(input)
    fireEvent.focus(input)
    await waitFor(() => expect(input.value).toBe(PREVIEW_URI))
    expect(getComposerDraft(CHAT, USER)).toBe(PREVIEW_URI)
    expect(input.value.match(/gfs:\/\//g)).toHaveLength(1)
    expect(getComposerDraftRevision(CHAT, USER, workspaceChatTabId, scope)).toBe(
      draftRevisionAfterClear + 1
    )
    expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
  })

  it('does not treat background Preview revalidation as a new resource activation', async () => {
    const { clerum, gfs, queryClient, view } = await setupApp(undefined, false, undefined, true)
    await openFolderU()
    await clickFileName('Notes.md')
    await waitFor(() => expect(getLatestGfsConversationContext()?.uri).toBe(PREVIEW_URI))
    const fullScreenInput = (await selectSidebarConversation()) as HTMLTextAreaElement
    await waitFor(() => expect(fullScreenInput.value).toBe(PREVIEW_URI))
    await switchWorkspaceTab('Notes.md')
    await openChatDrawer()
    const input = screen.getByTestId('chat-input') as HTMLTextAreaElement
    await waitFor(() => expect(input.value).toBe(PREVIEW_URI))
    expect(
      within(screen.getByRole('toolbar', { name: 'Workspace tabs' }))
        .getByRole('button', { name: 'Notes.md' })
        .getAttribute('aria-pressed')
    ).toBe('true')

    const initialContext = getLatestGfsConversationContext()
    if (!initialContext) throw new Error('Expected the active Preview resource context')
    const scope = receiptProbe.scope
    const chatTabId = receiptProbe.tabId
    const receiptIdAfterInsertion = screen
      .getByTestId('prefill-receipt-probe')
      .getAttribute('data-receipt-id')
    fireEvent.change(input, { target: { value: '' } })
    await waitFor(() => expect(getStoredComposerDraft(CHAT, USER, chatTabId, scope)).toBe(''))
    const revisionAfterClear = getComposerDraftRevision(CHAT, USER, chatTabId, scope)
    const eventsAfterClear = appTestActions.prefillEvents.length
    const attemptsAfterClear = appTestActions.prefillAttempts.length
    const previewResolvesBeforeRefresh = gfs.resolve.mock.calls.filter(
      ([uri]) => uri === PREVIEW_URI
    ).length
    const emitEntityChange = appTestActions.emitEntityChange
    if (!emitEntityChange) throw new Error('Expected the App entity-change bridge')
    const originalResolve = gfs.resolve.getMockImplementation()
    if (!originalResolve) throw new Error('Expected the real Preview resolver boundary')
    const previewRefreshEntered = deferred<void>()
    const previewRefreshResult = deferred<Awaited<ReturnType<typeof gfs.resolve>>>()
    gfs.resolve.mockImplementation(async uri => {
      if (uri === PREVIEW_URI) {
        previewRefreshEntered.resolve()
        return previewRefreshResult.promise
      }
      return originalResolve(uri)
    })

    try {
      await act(async () => {
        emitEntityChange(USER_SCOPE_INVALIDATED)
        await previewRefreshEntered.promise
      })
      await act(async () => {
        previewRefreshResult.resolve(await originalResolve(PREVIEW_URI))
        await Promise.resolve()
        await new Promise(resolve => setTimeout(resolve, 0))
        await Promise.resolve()
      })

      expect(input.value).toBe('')
      expect(getStoredComposerDraft(CHAT, USER, chatTabId, scope)).toBe('')
      expect(getComposerDraftRevision(CHAT, USER, chatTabId, scope)).toBe(revisionAfterClear)
      expect(getLatestGfsConversationContext()).toMatchObject({
        uri: initialContext.uri,
        sourceTabId: initialContext.sourceTabId,
        authorityScope: initialContext.authorityScope,
        activationId: initialContext.activationId,
      })
      expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')).toBe(
        receiptIdAfterInsertion
      )
      expect(appTestActions.prefillEvents.slice(eventsAfterClear)).toEqual([])
      expect(appTestActions.prefillAttempts).toHaveLength(attemptsAfterClear)
      expect(gfs.resolve.mock.calls.filter(([uri]) => uri === PREVIEW_URI)).toHaveLength(
        previewResolvesBeforeRefresh + 1
      )
      expect(
        within(screen.getByRole('toolbar', { name: 'Workspace tabs' }))
          .getByRole('button', { name: 'Notes.md' })
          .getAttribute('aria-pressed')
      ).toBe('true')
      expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
    } finally {
      previewRefreshResult.resolve(await originalResolve(PREVIEW_URI))
      gfs.resolve.mockImplementation(originalResolve)
      await queryClient.cancelQueries()
      queryClient.clear()
      view.unmount()
    }
  })

  it('does not reuse a revoked Preview context after its owner tab is closed', async () => {
    const { clerum, gfs } = await setupApp(undefined, false, undefined, true)
    await openFolderU()
    await clickFileName('Notes.md')
    await waitFor(() => expect(getLatestGfsConversationContext()?.uri).toBe(PREVIEW_URI))
    const resource = getLatestGfsConversationContext()
    const input = (await selectSidebarConversation()) as HTMLTextAreaElement
    await waitFor(() => expect(input.value).toBe(PREVIEW_URI))
    const deniedMessage = await resolveDeniedMessage(PREVIEW_URI)
    const resolveCallsBeforeDenial = gfs.resolve.mock.calls.length
    gfs.resolve.mockRejectedValueOnce(new Error(deniedMessage))
    const emitEntityChange = appTestActions.emitEntityChange
    if (!emitEntityChange) throw new Error('Expected the App entity-change bridge')
    await act(async () => {
      emitEntityChange(USER_SCOPE_INVALIDATED)
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(gfs.resolve).toHaveBeenCalledTimes(resolveCallsBeforeDenial + 1)
      expect(screen.getByRole('toolbar', { name: 'Workspace tabs' }).textContent).toContain(
        'File unavailable'
      )
    })

    const strip = screen.getByRole('toolbar', { name: 'Workspace tabs' })
    fireEvent.click(within(strip).getByRole('button', { name: 'Close File unavailable' }))
    await waitFor(() =>
      expect(within(strip).queryByRole('button', { name: 'File unavailable' })).toBeNull()
    )

    fireEvent.change(input, { target: { value: '' } })
    await waitFor(() => expect(getComposerDraft(CHAT, USER)).toBe(''))
    const scope = receiptProbe.scope
    const workspaceChatTabId = receiptProbe.tabId
    const revisionAfterClosingRevokedOwner = getComposerDraftRevision(
      CHAT,
      USER,
      workspaceChatTabId,
      scope
    )
    fireEvent.blur(input)
    fireEvent.focus(input)
    await act(async () => {
      await Promise.resolve()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(input.value).toBe('')
    expect(getComposerDraft(CHAT, USER)).toBe('')
    expect(getComposerDraftRevision(CHAT, USER, workspaceChatTabId, scope)).toBe(
      revisionAfterClosingRevokedOwner
    )
    expect(gfs.resolve).toHaveBeenCalledTimes(resolveCallsBeforeDenial + 1)
    expect(resource?.sourceTabId).toBeTruthy()
    expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
  })

  it('retires a retained Preview context when its held denial settles after the source closes', async () => {
    const { clerum, gfs } = await setupApp(undefined, false, undefined, true)
    await openFolderU()
    await clickFileName('Notes.md')
    await waitFor(() => expect(getLatestGfsConversationContext()?.uri).toBe(PREVIEW_URI))
    const originalContext = getLatestGfsConversationContext()
    if (!originalContext) throw new Error('Expected the Preview owner to publish its resource')
    const input = (await selectSidebarConversation()) as HTMLTextAreaElement
    await waitFor(() => expect(input.value).toBe(PREVIEW_URI))
    fireEvent.change(input, { target: { value: '' } })
    await waitFor(() => expect(getComposerDraft(CHAT, USER)).toBe(''))

    const deniedMessage = await resolveDeniedMessage(PREVIEW_URI)
    const resolveEntered = deferred<void>()
    const heldResolve = deferred<Awaited<ReturnType<typeof gfs.resolve>>>()
    const originalResolve = gfs.resolve.getMockImplementation()
    if (!originalResolve) throw new Error('Expected the real Preview resolver boundary')
    let resolverHeld = false
    gfs.resolve.mockImplementation(async uri => {
      if (uri === PREVIEW_URI && !resolverHeld) {
        resolverHeld = true
        // The App's real background refresh resolves this Preview after the
        // authenticated entity-change producer. Hold that read across closure.
        resolveEntered.resolve()
        return heldResolve.promise
      }
      return originalResolve(uri)
    })

    const emitEntityChange = appTestActions.emitEntityChange
    if (!emitEntityChange) throw new Error('Expected the App entity-change bridge')
    try {
      await act(async () => {
        emitEntityChange(USER_SCOPE_INVALIDATED)
        await Promise.resolve()
      })
      await resolveEntered.promise

      const strip = screen.getByRole('toolbar', { name: 'Workspace tabs' })
      expect(within(strip).getByRole('button', { name: 'Notes.md' })).toBeTruthy()
      fireEvent.click(within(strip).getByRole('button', { name: 'Close Notes.md' }))
      await waitFor(() =>
        expect(within(strip).queryByRole('button', { name: 'Notes.md' })).toBeNull()
      )
      expect(getLatestGfsConversationContext()).toMatchObject(originalContext)

      await act(async () => {
        heldResolve.reject(new Error(deniedMessage))
        await Promise.resolve()
        await new Promise(resolve => setTimeout(resolve, 0))
      })
      fireEvent.blur(input)
      fireEvent.focus(input)
      await act(async () => {
        await Promise.resolve()
        await new Promise(resolve => setTimeout(resolve, 0))
      })

      expect(input.value).toBe('')
      expect(getComposerDraft(CHAT, USER)).toBe('')
      expect(getLatestGfsConversationContext()).toBeNull()
      expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
    } finally {
      heldResolve.resolve(await originalResolve(PREVIEW_URI))
      gfs.resolve.mockImplementation(originalResolve)
    }
  })

  it('L9 refills only after the later genuine chat selection and visibility events', async () => {
    const { clerum } = await setupApp()
    await openFolderU()
    const firstComposer = await selectSidebarConversation()
    await waitFor(() => expect((firstComposer as HTMLTextAreaElement).value).toBe(U_URI))
    expect(getComposerDraft(CHAT, USER)).toBe(U_URI)

    await switchWorkspaceTab('Folder U')
    await openChatDrawer()
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: '' } })
    await waitFor(() => expect(getComposerDraft(CHAT, USER)).toBe(''))
    const sidebarSelection = screen.getByRole('button', { name: 'Open Earlier chat' })
    const panel = document.querySelector('.content-panel') as HTMLElement
    Object.defineProperty(panel, 'clientWidth', { configurable: true, get: () => 700 })
    act(() => {
      sidebarSelection.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      resizeCallbacks.forEach(callback => callback(700))
    })
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Chat' })).toBeNull())
    const receiptId = screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')
    expect(receiptId).not.toBe('')
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-status')).toBe(
      'bound-eligible'
    )

    await navigateIntoV()
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-status')).toBe(
      'suspended-resource'
    )
    await restoreFolderU()
    expect(getComposerDraft(CHAT, USER)).toBe('')
    resizeAppTo(1200)
    const remounted = (await screen.findByTestId('chat-input')) as HTMLTextAreaElement
    await waitFor(() => expect(remounted.value).toBe(U_URI))
    expect(getComposerDraft(CHAT, USER)).toBe(U_URI)
    expect(
      Number(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id'))
    ).toBeGreaterThan(Number(receiptId))
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-status')).toBe(
      'consumed'
    )
    expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
  })

  it('L12 keeps one dormant suspended receipt while Files remains at V and Composer is detached', async () => {
    const targetChatId = 'chat-target'
    const { clerum } = await setupApp([
      { agent: USER, chatId: CHAT, title: 'Earlier chat' },
      { agent: USER, chatId: targetChatId, title: 'Target chat' },
    ])
    await openFolderU()
    await openChatDrawer()
    const sidebarSelection = await screen.findByRole('button', { name: 'Open Target chat' })
    const panel = document.querySelector('.content-panel') as HTMLElement
    Object.defineProperty(panel, 'clientWidth', { configurable: true, get: () => 700 })
    act(() => {
      sidebarSelection.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      resizeCallbacks.forEach(callback => callback(700))
    })
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Chat' })).toBeNull())
    const receiptId = screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')

    await navigateIntoV()
    const listSessionsCalls = clerum.rpc.listSessions.mock.calls.length
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 25))
      await Promise.resolve()
    })
    expect(getLatestGfsConversationContext()?.uri).toBe(V_URI)
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')).toBe(
      receiptId
    )
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-status')).toBe(
      'suspended-resource'
    )
    expect(getComposerDraft(targetChatId, USER)).toBe('')
    expect(clerum.rpc.listSessions).toHaveBeenCalledTimes(listSessionsCalls)
    expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
  })

  it('L13 does not transfer an App-owned receipt to a newly mounted App owner', async () => {
    const targetChatId = 'chat-target'
    const sessions = [
      { agent: USER, chatId: CHAT, title: 'Earlier chat' },
      { agent: USER, chatId: targetChatId, title: 'Target chat' },
    ]
    const firstApp = await setupApp(sessions)
    await openFolderU()
    await openChatDrawer()
    const sidebarSelection = await screen.findByRole('button', { name: 'Open Target chat' })
    const panel = document.querySelector('.content-panel') as HTMLElement
    Object.defineProperty(panel, 'clientWidth', { configurable: true, get: () => 700 })
    act(() => {
      sidebarSelection.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      resizeCallbacks.forEach(callback => callback(700))
    })
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Chat' })).toBeNull())
    const oldReceiptId = screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')
    expect(oldReceiptId).not.toBe('')
    expect(getComposerDraft(targetChatId, USER)).toBe('')

    firstApp.view.unmount()
    cleanupClerum?.()
    cleanupClerum = null
    const nextApp = await setupApp(sessions)
    // The receipt is App-instance-owned. Check the new owner before sending it
    // any new resource or visibility events that may legitimately qualify a
    // fresh receipt.
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')).toBe('')
    expect(receiptProbe.ids).toEqual([])
    await openFolderU()
    await openChatDrawer()
    expect(screen.getByTestId('chat-thread-stub').textContent).not.toBe(targetChatId)
    expect(getComposerDraft(targetChatId, USER)).toBe('')
    expect(nextApp.clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
  })

  it('B6 classifies Sidebar selection while suppressed as a full Chat route', async () => {
    const { clerum } = await setupApp()
    await openFolderU()
    const resource = getLatestGfsConversationContext()
    await openChatDrawer()
    resizeAppTo(700)
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Chat' })).toBeNull())

    fireEvent.click(await screen.findByRole('button', { name: 'Open Earlier chat' }))
    await act(async () => {
      await Promise.resolve()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    const input = (await screen.findByTestId('chat-input')) as HTMLTextAreaElement
    await waitFor(() => expect(input.value).toBe(U_URI))
    // The existing Sidebar path leaves the drawer-hidden state and renders the
    // full Chat route. It cannot stand in for a pending-ready detached drawer.
    expect(getComposerDraft(CHAT, USER)).toBe(U_URI)
    expect(getLatestGfsConversationContext()).toEqual(resource)
    expect(screen.getByTestId('chat-thread-stub').textContent).toBe(CHAT)
    expect(
      within(screen.getByRole('toolbar', { name: 'Workspace tabs' }))
        .getByRole('button', { name: 'Earlier chat' })
        .getAttribute('aria-pressed')
    ).toBe('true')
    expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
  })

  it('L3 fills from V when the Composer becomes visible and preserves it on U restoration', async () => {
    const targetChatId = 'chat-target'
    const { clerum } = await setupApp([
      { agent: USER, chatId: CHAT, title: 'Earlier chat' },
      { agent: USER, chatId: targetChatId, title: 'Target chat' },
    ])
    await openFolderU()
    const firstComposer = await selectSidebarConversation()
    await waitFor(() => expect((firstComposer as HTMLTextAreaElement).value).toBe(U_URI))
    await switchWorkspaceTab('Folder U')
    await openChatDrawer()
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: '' } })
    await waitFor(() => expect(getComposerDraft(CHAT, USER)).toBe(''))
    expect(getComposerDraft(targetChatId, USER)).toBe('')

    const panel = document.querySelector('.content-panel') as HTMLElement
    Object.defineProperty(panel, 'clientWidth', { configurable: true, get: () => 700 })
    act(() => {
      screen
        .getByRole('button', { name: 'Open Target chat' })
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
      resizeCallbacks.forEach(callback => callback(700))
    })
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Chat' })).toBeNull())
    expect(screen.queryByTestId('chat-input')).toBeNull()
    const capturedU = getLatestGfsConversationContext()
    const receiptId = screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')
    expect(receiptId).not.toBe('')
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-resource-uri')).toBe(
      U_URI
    )
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-status')).toBe(
      'bound-eligible'
    )
    expect(getComposerDraft(targetChatId, USER)).toBe('')

    await navigateIntoV()
    expect(getComposerDraft(targetChatId, USER)).toBe('')
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-status')).toBe(
      'suspended-resource'
    )
    resizeAppTo(1200)
    const remounted = (await screen.findByTestId('chat-input')) as HTMLTextAreaElement
    expect(remounted.value).toBe(V_URI)
    expect(screen.getByTestId('chat-thread-stub').textContent).toBe(targetChatId)
    expect(
      Number(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id'))
    ).toBeGreaterThan(Number(receiptId))
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-status')).toBe(
      'consumed'
    )

    await restoreFolderU()
    expect(getLatestGfsConversationContext()).toMatchObject({
      uri: capturedU?.uri,
      sourceTabId: capturedU?.sourceTabId,
    })
    await waitFor(() => expect(remounted.value).toBe(V_URI))
    expect(getComposerDraft(targetChatId, USER)).toBe(V_URI)
    expect(
      Number(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id'))
    ).toBeGreaterThan(Number(receiptId))
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-status')).toBe(
      'consumed'
    )
    expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
  })

  it('L11 drawer reopen checks the current resource and preserves it on later restoration', async () => {
    const targetChatId = 'chat-target'
    const { clerum } = await setupApp([
      { agent: USER, chatId: CHAT, title: 'Earlier chat' },
      { agent: USER, chatId: targetChatId, title: 'Target chat' },
    ])
    await openFolderU()
    await openChatDrawer()
    const selectTarget = await screen.findByRole('button', { name: 'Open Target chat' })
    const closeDrawer = screen.getByRole('button', { name: 'Collapse chat drawer' })
    act(() => {
      selectTarget.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      closeDrawer.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Chat' })).toBeNull())
    const receiptId = screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')
    const destinationId = screen
      .getByTestId('prefill-receipt-probe')
      .getAttribute('data-destination-tab-id')
    expect(receiptId).not.toBe('')
    expect(destinationId).not.toBe('')
    expect(getComposerDraft(targetChatId, USER)).toBe('')

    await navigateIntoV()
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-status')).toBe(
      'suspended-resource'
    )
    expect(getComposerDraft(targetChatId, USER)).toBe('')

    await openChatDrawer()
    expect(screen.getByTestId('chat-thread-stub').textContent).toBe(targetChatId)
    expect(
      Number(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id'))
    ).toBeGreaterThan(Number(receiptId))
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-status')).toBe(
      'consumed'
    )
    expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).value).toBe(V_URI)
    expect(getComposerDraft(targetChatId, USER)).toBe(V_URI)

    await restoreFolderU()
    await waitFor(() =>
      expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).value).toBe(V_URI)
    )
    expect(getComposerDraft(targetChatId, USER)).toBe(V_URI)
    expect(
      Number(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id'))
    ).toBeGreaterThan(Number(receiptId))
    expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
  })

  it('L6 cancels the removed destination and allows a later exact U activation', async () => {
    const targetChatId = 'chat-target'
    const { clerum } = await setupApp([
      { agent: USER, chatId: CHAT, title: 'Earlier chat' },
      { agent: USER, chatId: targetChatId, title: 'Target chat' },
    ])
    await openFolderU()
    await openChatDrawer()
    const sidebarSelection = await screen.findByRole('button', { name: 'Open Target chat' })
    const panel = document.querySelector('.content-panel') as HTMLElement
    Object.defineProperty(panel, 'clientWidth', { configurable: true, get: () => 700 })
    act(() => {
      sidebarSelection.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      resizeCallbacks.forEach(callback => callback(700))
    })
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Chat' })).toBeNull())
    const receiptProbe = screen.getByTestId('prefill-receipt-probe')
    const receiptId = receiptProbe.getAttribute('data-receipt-id')
    const destinationId = receiptProbe.getAttribute('data-destination-tab-id')
    expect(receiptId).not.toBe('')
    expect(destinationId).not.toBe('')
    expect(receiptProbe.getAttribute('data-receipt-status')).toBe('bound-eligible')
    await navigateIntoV()
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-status')).toBe(
      'suspended-resource'
    )
    const strip = screen.getByRole('toolbar', { name: 'Workspace tabs' })
    fireEvent.click(within(strip).getByRole('button', { name: 'Close Target chat' }))
    await waitFor(() =>
      expect(within(strip).queryByRole('button', { name: 'Target chat' })).toBeNull()
    )
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-status')).toBe(
      'terminally-cancelled'
    )
    await restoreFolderU()
    resizeAppTo(1200)
    await waitFor(() => expect(screen.getByRole('complementary', { name: 'Chat' })).toBeTruthy())
    // The old destination is terminal. Restoring U and showing the Composer
    // are genuine later events and may create a fresh receipt for the new tab.
    expect(
      within(screen.getByRole('toolbar', { name: 'Workspace tabs' }))
        .getByRole('button', { name: 'Target chat' })
        .getAttribute('aria-pressed')
    ).toBe('false')
    expect(screen.getByTestId('chat-thread-stub').textContent).toBe(targetChatId)
    expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).value).toBe(U_URI)
    expect(getComposerDraft(targetChatId, USER)).toBe(U_URI)
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-status')).toBe(
      'consumed'
    )
    expect(
      Number(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id'))
    ).toBeGreaterThan(Number(receiptId))
    expect(
      screen.getByTestId('prefill-receipt-probe').getAttribute('data-destination-tab-id')
    ).not.toBe(destinationId)
    expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
  })

  it('L8 retires a stale receipt after the authenticated team scope changes', async () => {
    const targetChatId = 'chat-target'
    const sessions = [
      { agent: USER, chatId: CHAT, title: 'Earlier chat' },
      { agent: USER, chatId: targetChatId, title: 'Target chat' },
    ]
    const { clerum } = await setupApp(sessions)
    await openFolderU()
    await openChatDrawer()
    const sidebarSelection = await screen.findByRole('button', { name: 'Open Target chat' })
    const panel = document.querySelector('.content-panel') as HTMLElement
    Object.defineProperty(panel, 'clientWidth', { configurable: true, get: () => 700 })
    act(() => {
      sidebarSelection.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      resizeCallbacks.forEach(callback => callback(700))
    })
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Chat' })).toBeNull())
    const receiptId = screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')
    expect(receiptId).not.toBe('')
    await navigateIntoV()
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-status')).toBe(
      'suspended-resource'
    )

    fireEvent.click(screen.getByTestId('open-cross-team-latest-chat'))
    await waitFor(() =>
      expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-team-id')).toBe(
        'team-2'
      )
    )
    await waitFor(() =>
      expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-status')).toBe(
        'terminally-cancelled'
      )
    )
    expect(getComposerDraft(targetChatId, USER)).toBe('')
    expect(getStoredComposerDraft(targetChatId, USER, receiptProbe.tabId, receiptProbe.scope)).toBe(
      ''
    )
    const teamBridge = clerum as unknown as {
      team: { switch: Mock<(...args: any[]) => any> }
    }
    expect(teamBridge.team.switch).toHaveBeenCalledWith('team-2')
    expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
  })

  it('L17 masks the inserted shared draft after an authenticated scope switch', async () => {
    const { clerum } = await setupApp()
    await openFolderU()
    const input = (await selectSidebarConversation()) as HTMLTextAreaElement
    await waitFor(() => expect(input.value).toBe(U_URI))
    const scopeA = receiptProbe.scope
    const workspaceChatTabId = receiptProbe.tabId
    expect(getComposerDraft(CHAT, USER)).toBe(U_URI)

    fireEvent.click(screen.getByTestId('open-cross-team-latest-chat'))
    await waitFor(() =>
      expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-team-id')).toBe(
        'team-2'
      )
    )
    const teamBInput = (await screen.findByTestId('chat-input')) as HTMLTextAreaElement
    await waitFor(() => expect(teamBInput.value).toBe(''))

    expect(getStoredComposerDraft(CHAT, USER, workspaceChatTabId, scopeA)).toBe(U_URI)
    expect(getComposerDraft(CHAT, USER)).toBe('')
    expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
  })

  it('does not reauthorize a retained Files resource on a new-scope Composer refocus', async () => {
    const { clerum } = await setupApp()
    await openFolderU()
    const inputA = (await selectSidebarConversation()) as HTMLTextAreaElement
    await waitFor(() => expect(inputA.value).toBe(U_URI))
    const scopeA = receiptProbe.scope
    const tabA = receiptProbe.tabId
    expect(getStoredComposerDraft(CHAT, USER, tabA, scopeA)).toBe(U_URI)

    fireEvent.click(screen.getByTestId('open-cross-team-latest-chat'))
    await waitFor(() =>
      expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-team-id')).toBe(
        'team-2'
      )
    )
    const inputB = (await screen.findByTestId('chat-input')) as HTMLTextAreaElement
    await waitFor(() => expect(inputB.value).toBe(''))
    const scopeB = receiptProbe.scope
    const tabB = receiptProbe.tabId
    expect(scopeB).not.toBe(scopeA)
    expect(tabB).not.toBe(tabA)
    expect(getStoredComposerDraft(CHAT, USER, tabB, scopeB)).toBe('')
    expect(getLatestGfsConversationContext()).toBeNull()

    // Refocus is a real qualifying event, but it cannot make a resource retained
    // from Team A current in Team B without publication by the resource owner.
    fireEvent.blur(inputB)
    fireEvent.focus(inputB)
    await act(async () => {
      await Promise.resolve()
      await new Promise(resolve => setTimeout(resolve, 0))
    })

    expect(inputB.value).toBe('')
    expect(getStoredComposerDraft(CHAT, USER, tabB, scopeB)).toBe('')
    expect(getStoredComposerDraft(CHAT, USER, tabA, scopeA)).toBe(U_URI)
    expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
  })

  it('does not activate a cached Files URI in a new scope before its owner resolves it', async () => {
    const { clerum, gfs } = await setupApp()
    await openFolderU()
    const inputA = (await selectSidebarConversation()) as HTMLTextAreaElement
    await waitFor(() => expect(inputA.value).toBe(U_URI))

    fireEvent.click(screen.getByTestId('open-cross-team-latest-chat'))
    await act(async () => {
      await appTestActions.openTargetPromise
      await Promise.resolve()
    })
    await waitFor(() => expect(receiptProbe.scope).toContain(':team-2:'))
    const inputB = (await screen.findByTestId('chat-input')) as HTMLTextAreaElement
    await waitFor(() => expect(inputB.value).toBe(''))
    const scopeB = receiptProbe.scope
    const tabB = receiptProbe.tabId
    expect(getLatestGfsConversationContext()).toBeNull()

    const resolverEntered = deferred<void>()
    const releaseResolver = deferred<void>()
    let resolverReleased = false
    const releaseHeldResolver = async () => {
      if (resolverReleased) return
      resolverReleased = true
      await act(async () => {
        releaseResolver.resolve()
        await Promise.resolve()
        await new Promise(resolve => setTimeout(resolve, 0))
      })
    }
    const originalResolve = gfs.resolve.getMockImplementation()
    if (!originalResolve) throw new Error('Expected the real Files resolver boundary')
    gfs.resolve.mockImplementation(async uri => {
      if (uri === U_URI) {
        resolverEntered.resolve()
        await releaseResolver.promise
        throw new Error('403 Forbidden')
      }
      return originalResolve(uri)
    })

    try {
      await switchWorkspaceTab('Folder U')
      await resolverEntered.promise
      await switchWorkspaceTab('Earlier chat')
      const inputBeforeOwnerResolution = screen.getByTestId('chat-input') as HTMLTextAreaElement
      await waitFor(() => expect(screen.getByTestId('chat-thread-stub').textContent).toBe(CHAT))
      await act(async () => {
        await Promise.resolve()
        await new Promise(resolve => setTimeout(resolve, 0))
      })

      expect(inputBeforeOwnerResolution.value).toBe('')
      expect(getStoredComposerDraft(CHAT, USER, tabB, scopeB)).toBe('')
      expect(getLatestGfsConversationContext()).toBeNull()

      await releaseHeldResolver()
      expect(inputB.value).toBe('')
      expect(getStoredComposerDraft(CHAT, USER, tabB, scopeB)).toBe('')
      expect(getLatestGfsConversationContext()).toBeNull()
      expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
    } finally {
      await releaseHeldResolver()
      gfs.resolve.mockImplementation(originalResolve)
    }
  })

  it('does not publish another Preview owner while its current-scope resolve is pending', async () => {
    const { clerum, gfs, queryClient, view } = await setupApp(undefined, false, [USER], true, {
      includeSecondPreview: true,
    })
    const deniedMessage = await resolveDeniedMessage(OTHER_PREVIEW_URI)

    await openFolderU()
    const selectedInput = (await selectSidebarConversation()) as HTMLTextAreaElement
    await waitFor(() => expect(selectedInput.value).toBe(U_URI))
    fireEvent.change(selectedInput, { target: { value: '' } })
    await waitFor(() => expect(getComposerDraft(CHAT, USER)).toBe(''))
    await switchWorkspaceTab('Folder U')
    await openChatDrawer()
    let inputA = screen.getByTestId('chat-input') as HTMLTextAreaElement
    fireEvent.change(inputA, { target: { value: '' } })
    await waitFor(() => expect(getComposerDraft(CHAT, USER)).toBe(''))
    await screen.findByRole('button', { name: 'Open Notes.md' })
    await clickFileName('Notes.md')
    await waitFor(() => expect(getLatestGfsConversationContext()?.uri).toBe(PREVIEW_URI))
    await openChatDrawer()
    fireEvent.click(await screen.findByRole('button', { name: 'Open chats' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Earlier chat' }))
    inputA = screen.getByTestId('chat-input') as HTMLTextAreaElement
    await waitFor(() => expect(inputA.value).toBe(PREVIEW_URI))
    fireEvent.change(inputA, { target: { value: '' } })
    await waitFor(() => expect(getComposerDraft(CHAT, USER)).toBe(''))

    await switchWorkspaceTab('Folder U')
    await screen.findByRole('button', { name: 'Open Guide.md' })
    await clickFileName('Guide.md')
    await waitFor(() => expect(getLatestGfsConversationContext()?.uri).toBe(OTHER_PREVIEW_URI))
    await openChatDrawer()
    fireEvent.click(await screen.findByRole('button', { name: 'Open chats' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Earlier chat' }))
    inputA = screen.getByTestId('chat-input') as HTMLTextAreaElement
    await waitFor(() => expect(inputA.value).toBe(OTHER_PREVIEW_URI))
    fireEvent.change(inputA, { target: { value: '' } })
    await waitFor(() => expect(getComposerDraft(CHAT, USER)).toBe(''))
    const workspaceTabs = screen.getByRole('toolbar', { name: 'Workspace tabs' })
    expect(
      within(workspaceTabs).getByRole('button', { name: 'Guide.md' }).getAttribute('aria-pressed')
    ).toBe('true')

    fireEvent.click(screen.getByTestId('open-cross-team-same-chat'))
    await act(async () => {
      await appTestActions.openTargetPromise
      await Promise.resolve()
    })
    await waitFor(() => expect(receiptProbe.scope).toContain(':team-2:'))
    const scopeB = receiptProbe.scope
    const tabB = receiptProbe.tabId
    let inputB = screen.getByTestId('chat-input') as HTMLTextAreaElement
    await waitFor(() => expect(inputB.value).toBe(''))
    expect(getComposerDraft(CHAT, USER, tabB, scopeB)).toBe('')
    expect(getLatestGfsConversationContext(scopeB)).toBeNull()

    const p2ResolveEntered = deferred<void>()
    const p1RefreshEntered = deferred<void>()
    const p1RefreshResolved = deferred<void>()
    const p2Resolve = deferred<Awaited<ReturnType<typeof gfs.resolve>>>()
    const originalResolve = gfs.resolve.getMockImplementation()
    if (!originalResolve) throw new Error('Expected the real Preview resolver boundary')
    let p2ResolveStarted = false
    let secondPreviewResolveCalls = 0
    gfs.resolve.mockImplementation(async uri => {
      if (receiptProbe.scope === scopeB && uri === OTHER_PREVIEW_URI) {
        p2ResolveStarted = true
        secondPreviewResolveCalls += 1
        p2ResolveEntered.resolve()
        return p2Resolve.promise
      }
      if (receiptProbe.scope === scopeB && uri === PREVIEW_URI) {
        p1RefreshEntered.resolve()
        const result = await resolveResource(
          resolvedFile(PREVIEW_ID, 'Notes.md', {
            path: '/Folder U/Notes.md',
            parentResourceId: U_ID,
            bytes: 32,
            version: 2,
          })
        )
        p1RefreshResolved.resolve()
        return result
      }
      return originalResolve(uri)
    })

    try {
      // Selecting the cached Team-A owner in Team B starts its real current-scope
      // resolver. Keep that owner unresolved while another Preview is refreshed.
      await switchWorkspaceTab('Guide.md')
      await p2ResolveEntered.promise
      expect(getLatestGfsConversationContext(scopeB)).toBeNull()
      expect(inputB.value).toBe('')
      await openChatDrawer()
      fireEvent.click(await screen.findByRole('button', { name: 'Open chats' }))
      fireEvent.click(await screen.findByRole('option', { name: 'Earlier chat' }))
      inputB = screen.getByTestId('chat-input') as HTMLTextAreaElement
      await waitFor(() => expect(screen.getByTestId('chat-thread-stub').textContent).toBe(CHAT))
      expect(
        within(screen.getByRole('toolbar', { name: 'Workspace tabs' }))
          .getByRole('button', { name: 'Guide.md' })
          .getAttribute('aria-pressed')
      ).toBe('true')
      expect(getLatestGfsConversationContext(scopeB)).toBeNull()
      expect(inputB.value).toBe('')

      const resolveCallsBeforeInvalidation = gfs.resolve.mock.calls.length
      await act(async () => {
        appTestActions.emitEntityChange?.(USER_SCOPE_INVALIDATED)
        await p1RefreshEntered.promise
        await p1RefreshResolved.promise
        await Promise.resolve()
        await new Promise(resolve => setTimeout(resolve, 0))
      })

      // A genuine focus occurs while the current owner is still unresolved. A
      // successful background refresh of P1 must not publish active P2 in B.
      const resourcePublishedByOtherPreview = getLatestGfsConversationContext(scopeB)
      fireEvent.blur(inputB)
      fireEvent.focus(inputB)
      await act(async () => {
        await Promise.resolve()
        await new Promise(resolve => setTimeout(resolve, 0))
      })

      expect(
        gfs.resolve.mock.calls.slice(resolveCallsBeforeInvalidation).map(([uri]) => uri)
      ).toEqual(expect.arrayContaining([PREVIEW_URI, OTHER_PREVIEW_URI]))
      expect(secondPreviewResolveCalls).toBeGreaterThanOrEqual(1)
      expect(inputB.value).toBe('')
      expect(getComposerDraft(CHAT, USER, tabB, scopeB)).toBe('')
      expect(resourcePublishedByOtherPreview).toBeNull()
      expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()

      p2Resolve.reject(new Error(deniedMessage))
      await Promise.allSettled(
        gfs.resolve.mock.results.map(result => Promise.resolve(result.value))
      )
      await act(async () => {
        await Promise.resolve()
        await new Promise(resolve => setTimeout(resolve, 0))
      })
      expect(inputB.value).toBe('')
      expect(getComposerDraft(CHAT, USER, tabB, scopeB)).toBe('')
      expect(getLatestGfsConversationContext(scopeB)).toBeNull()
    } finally {
      if (p2ResolveStarted) {
        p2Resolve.reject(new Error(deniedMessage))
      }
      await Promise.allSettled(
        gfs.resolve.mock.results.map(result => Promise.resolve(result.value))
      )
      gfs.resolve.mockImplementation(originalResolve)
      await queryClient.cancelQueries()
      queryClient.clear()
      view.unmount()
    }
  })

  it('rejects a held Host target after the same principal session generation changes', async () => {
    await fc.assert(
      fc.asyncProperty(fc.scheduler(), async scheduler => {
        const targetAgent = 'agent-y'
        const targetChat = 'chat-y'
        const { clerum, gfs } = await setupApp(
          [
            { agent: USER, chatId: CHAT, title: 'Earlier chat' },
            { agent: targetAgent, chatId: targetChat, title: 'Stale target' },
          ],
          false,
          [USER, targetAgent]
        )

        await openFolderU()
        await openChatDrawer()
        const originalInput = (await selectSidebarConversation()) as HTMLTextAreaElement
        await waitFor(() => expect(originalInput.value).toBe(U_URI))
        const originalScope = receiptProbe.scope
        const originalTabId = receiptProbe.tabId
        const model = {
          sessionGeneration: 1,
          activeChat: CHAT,
          automaticOriginGeneration: 1,
          originDraft: U_URI,
          projectedDraft: U_URI,
          sends: 0,
        }
        expect(getComposerDraft(CHAT, USER)).toBe(U_URI)
        expect(receiptProbe.scope).toContain('team-1')
        expect(
          screen.getByTestId('prefill-receipt-probe').getAttribute('data-session-generation')
        ).toBe('1')

        const authBridge = clerum as unknown as {
          auth: {
            getSessionState: Mock<(...args: any[]) => any>
            getSessionGeneration: Mock<(...args: any[]) => any>
          }
        }
        let sessionState = {
          authenticated: true,
          me: {
            id: 'user-1',
            email: 'test@clerum.io',
            name: 'Test User',
            teamId: 'team-1',
            teamName: 'Team 1',
          },
          sessionGeneration: 1,
        }
        const replacementSessionResponse = deferred<typeof sessionState>()
        let replacementSessionReadRequested = false
        authBridge.auth.getSessionState.mockImplementation(async () => {
          if (sessionState.sessionGeneration === 2) {
            replacementSessionReadRequested = true
            return replacementSessionResponse.promise
          }
          return sessionState
        })
        authBridge.auth.getSessionGeneration.mockImplementation(
          async () => sessionState.sessionGeneration
        )

        clerum.rpc.renameSession.mockRejectedValue(await ipcHostAccessRevoked('rpc:renameSession'))
        expect(appTestActions.holdHost).toBeTypeOf('function')
        await act(async () => {
          await appTestActions.holdHost!(targetAgent, targetChat)
        })
        expect(clerum.rpc.renameSession).toHaveBeenCalledWith(
          targetAgent,
          targetAgent,
          targetChat,
          'Trigger host access hold'
        )

        const verification = deferred<ReturnType<typeof serverSessions>>()
        const scheduledResponseOrder: string[] = []
        clerum.rpc.listSessions.mockClear()
        clerum.rpc.listSessions.mockImplementation(async (agent, _team, query) =>
          agent === targetAgent && query?.limit === 1
            ? verification.promise
            : serverSessions([
                { agent: USER, chatId: CHAT },
                { agent: targetAgent, chatId: targetChat },
              ])
        )

        fireEvent.click(screen.getByTestId('open-same-scope-stale-target'))
        await waitFor(() =>
          expect(clerum.rpc.listSessions).toHaveBeenCalledWith(targetAgent, undefined, {
            agent: targetAgent,
            limit: 1,
          })
        )
        expect(screen.getByTestId('chat-thread-stub').textContent).toBe(CHAT)
        expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).value).toBe(U_URI)
        const originalResourceContext = getLatestGfsConversationContext()
        expect(originalResourceContext?.authorityScope).toBe(originalScope)
        const resolveCallsBeforeReplacement = gfs.resolve.mock.calls.length
        const receiptIdBeforeReplacement = screen
          .getByTestId('prefill-receipt-probe')
          .getAttribute('data-receipt-id')
        const prefillEventsBeforeReplacement = [...appTestActions.prefillEvents]

        // Reload the same authenticated principal through the real AuthContext and
        // App loadSession owner. The fixture only supplies the replacement native
        // session generation; it does not mutate renderer scope or chat selection.
        sessionState = { ...sessionState, sessionGeneration: 2 }
        model.sessionGeneration = 2
        model.projectedDraft =
          model.automaticOriginGeneration === model.sessionGeneration ? model.originDraft : ''
        expect(appTestActions.auth).not.toBeNull()
        const scheduledSessionReload = scheduler.scheduleFunction(async () => {
          const sessionReload = appTestActions.auth!.loadSession({ preserveNav: true })
          await waitFor(() => expect(replacementSessionReadRequested).toBe(true))
          scheduledResponseOrder.push('auth-session-state')
          replacementSessionResponse.resolve(sessionState)
          await sessionReload
        })()
        await act(async () => {
          await scheduler.waitFor(scheduledSessionReload)
        })
        await waitFor(() =>
          expect(
            screen.getByTestId('prefill-receipt-probe').getAttribute('data-session-generation')
          ).toBe('2')
        )
        await waitFor(() =>
          expect(gfs.resolve.mock.calls.length).toBeGreaterThan(resolveCallsBeforeReplacement)
        )
        const replacementScope = receiptProbe.scope
        expect(replacementScope).not.toBe(originalScope)
        expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-authenticated')).toBe(
          'true'
        )
        expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-team-id')).toBe(
          'team-1'
        )
        expect(receiptProbe.tabId).toBe(originalTabId)
        expect(screen.getByTestId('chat-thread-stub').textContent).toBe(CHAT)
        const retainedContext = getLatestGfsConversationContext()
        expect(retainedContext?.authorityScope).toBe(replacementScope)
        expect(retainedContext?.uri).toBe(U_URI)
        expect(retainedContext?.sourceTabId).toBe(originalResourceContext?.sourceTabId)
        expect(retainedContext?.activationId).toBeGreaterThan(
          originalResourceContext?.activationId ?? 0
        )
        // Current-scope Files revalidation restores owner authority. A URI may
        // be written only if the real Composer also emits a qualifying event
        // under the replacement scope; otherwise the old origin stays masked.
        await act(async () => {
          await Promise.resolve()
          await new Promise(resolve => setTimeout(resolve, 0))
        })
        const replacementInput = screen.getByTestId('chat-input') as HTMLTextAreaElement
        const replacementText = replacementInput.value
        const replacementDraft = getComposerDraft(CHAT, USER)
        const replacementReceipt = screen.getByTestId('prefill-receipt-probe')
        const replacementReceiptId = replacementReceipt.getAttribute('data-receipt-id')
        const newQualifyingEvents = appTestActions.prefillEvents
          .slice(prefillEventsBeforeReplacement.length)
          .filter(
            event => event === 'focus' || event === 'visible' || event === 'resource-activation'
          )
        const replacementReceiptChanged = replacementReceiptId !== receiptIdBeforeReplacement
        let replacementScopeHasNewAutomaticOrigin = false
        if (replacementReceiptChanged) {
          expect(newQualifyingEvents.length).toBeGreaterThan(0)
          expect(replacementText).toBe(U_URI)
          expect(replacementDraft).toBe(U_URI)
          expect(replacementReceipt.getAttribute('data-authority-scope')).toBe(replacementScope)
          expect(replacementReceipt.getAttribute('data-resource-uri')).toBe(U_URI)
          replacementScopeHasNewAutomaticOrigin = true
          model.automaticOriginGeneration = model.sessionGeneration
          model.projectedDraft = model.originDraft
        } else {
          expect(replacementText).toBe('')
          expect(replacementDraft).toBe('')
          expect(getStoredComposerDraft(CHAT, USER, originalTabId, replacementScope)).toBe('')
        }
        expect(replacementText).toBe(model.projectedDraft)
        expect(getStoredComposerDraft(CHAT, USER, originalTabId, replacementScope)).toBe(
          model.projectedDraft
        )
        const priorReceiptIds = [...new Set(receiptProbe.ids)]
        const workspaceStrip = screen.getByRole('toolbar', { name: 'Workspace tabs' })
        const retainedFilesTab = within(workspaceStrip).getByRole('button', {
          name: 'Folder U',
        }) as HTMLButtonElement
        expect(retainedFilesTab.getAttribute('aria-pressed')).toBe('true')
        const tabButtonsBeforeReorder = Array.from(
          workspaceStrip.querySelectorAll<HTMLButtonElement>('.chat-view-tab__select')
        )
        expect(tabButtonsBeforeReorder.length).toBeGreaterThan(1)
        const orderBeforeReorder = tabButtonsBeforeReorder.map(button => button.textContent)
        const retainedTabIndex = tabButtonsBeforeReorder.indexOf(retainedFilesTab)
        fireEvent.keyDown(retainedFilesTab, {
          key: retainedTabIndex === 0 ? 'ArrowRight' : 'ArrowLeft',
          altKey: true,
        })
        await waitFor(() => {
          expect(
            Array.from(
              workspaceStrip.querySelectorAll<HTMLButtonElement>('.chat-view-tab__select')
            ).map(button => button.textContent)
          ).not.toEqual(orderBeforeReorder)
        })

        expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).value).toBe(
          model.projectedDraft
        )
        expect(getComposerDraft(CHAT, USER)).toBe(model.projectedDraft)
        expect(getStoredComposerDraft(CHAT, USER, originalTabId, replacementScope)).toBe(
          model.projectedDraft
        )
        expect(getLatestGfsConversationContext(replacementScope)).toMatchObject({ uri: U_URI })
        expect(getStoredComposerDraft(CHAT, USER, originalTabId, originalScope)).toBe(
          replacementScopeHasNewAutomaticOrigin ? '' : U_URI
        )

        expect(replacementInput.value).toBe(model.projectedDraft)
        expect(getStoredComposerDraft(CHAT, USER, originalTabId, replacementScope)).toBe(
          model.projectedDraft
        )
        expect([...new Set(receiptProbe.ids)]).toEqual(priorReceiptIds)
        const receiptBeforeStaleHost = screen.getByTestId('prefill-receipt-probe')
        const receiptIdBeforeStaleHost = receiptBeforeStaleHost.getAttribute('data-receipt-id')
        const receiptStatusBeforeStaleHost =
          receiptBeforeStaleHost.getAttribute('data-receipt-status')
        const replacementRevisionBeforeStaleHost = getComposerDraftRevision(
          CHAT,
          USER,
          originalTabId,
          replacementScope
        )

        const scheduledHostVerification = scheduler.scheduleFunction(async () => {
          scheduledResponseOrder.push('host-list-sessions')
          verification.resolve(
            serverSessions([{ agent: targetAgent, chatId: targetChat, title: 'Stale target' }])
          )
          await appTestActions.openTargetPromise
        })()
        await act(async () => {
          await scheduler.waitFor(scheduledHostVerification)
          await new Promise(resolve => setTimeout(resolve, 0))
        })

        expect(screen.getByTestId('chat-thread-stub').textContent).toBe(model.activeChat)
        expect(receiptProbe.tabId).toBe(originalTabId)
        expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).value).toBe(
          model.projectedDraft
        )
        expect(getComposerDraft(CHAT, USER)).toBe(model.projectedDraft)
        expect(getStoredComposerDraft(CHAT, USER, originalTabId, replacementScope)).toBe(
          model.projectedDraft
        )
        expect(getComposerDraftRevision(CHAT, USER, originalTabId, replacementScope)).toBe(
          replacementRevisionBeforeStaleHost
        )
        const receiptAfterStaleHost = screen.getByTestId('prefill-receipt-probe')
        expect(receiptAfterStaleHost.getAttribute('data-receipt-id')).toBe(receiptIdBeforeStaleHost)
        expect(receiptAfterStaleHost.getAttribute('data-receipt-status')).toBe(
          receiptStatusBeforeStaleHost
        )
        expect(getStoredComposerDraft(CHAT, USER, originalTabId, originalScope)).toBe(
          replacementScopeHasNewAutomaticOrigin ? '' : U_URI
        )
        expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()

        // Team A's hidden bytes project as empty in the replacement generation.
        // A real Chat-tab activation can qualify while the revalidated resource
        // owner is current; that one write replaces the shared slot. Later
        // resource unavailability must not undo the completed insertion.
        fireEvent.change(screen.getByTestId('chat-input'), { target: { value: '' } })
        await waitFor(() => expect(getComposerDraft(CHAT, USER)).toBe(''))
        const revisionBeforeReplacementActivation = getComposerDraftRevision(
          CHAT,
          USER,
          originalTabId,
          replacementScope
        )
        const receiptBeforeReplacementActivation = screen
          .getByTestId('prefill-receipt-probe')
          .getAttribute('data-receipt-id')
        const activeChatTab = within(workspaceStrip).getByRole('button', { name: 'Earlier chat' })
        fireEvent.click(activeChatTab)
        await waitFor(() => expect(activeChatTab.getAttribute('aria-pressed')).toBe('true'))
        await waitFor(() =>
          expect(getStoredComposerDraft(CHAT, USER, originalTabId, replacementScope)).toBe(U_URI)
        )
        const replacementActivationReceipt = screen.getByTestId('prefill-receipt-probe')
        expect(replacementActivationReceipt.getAttribute('data-receipt-id')).not.toBe(
          receiptBeforeReplacementActivation
        )
        expect(replacementActivationReceipt.getAttribute('data-receipt-status')).toBe('consumed')
        const revisionAfterReplacementActivation = getComposerDraftRevision(
          CHAT,
          USER,
          originalTabId,
          replacementScope
        )
        expect(revisionAfterReplacementActivation).toBe(revisionBeforeReplacementActivation + 1)
        expect(getStoredComposerDraft(CHAT, USER, originalTabId, originalScope)).toBe('')
        expect(getLatestGfsConversationContext(replacementScope)).toMatchObject({
          uri: U_URI,
          authorityScope: replacementScope,
        })
        const ownerResolution = deferred<Awaited<ReturnType<typeof resolveResource>>>()
        const resolveCallsBeforeReactivation = gfs.resolve.mock.calls.length
        gfs.resolve.mockImplementationOnce(() => ownerResolution.promise)
        fireEvent.click(within(workspaceStrip).getByRole('button', { name: 'Folder U' }))
        await waitFor(() =>
          expect(gfs.resolve).toHaveBeenCalledTimes(resolveCallsBeforeReactivation + 1)
        )
        const ownerAfterFileActivation = getLatestGfsConversationContext(replacementScope)
        expect(ownerAfterFileActivation).toMatchObject({
          uri: U_URI,
          sourceTabId: originalResourceContext?.sourceTabId,
          authorityScope: replacementScope,
        })
        expect(getStoredComposerDraft(CHAT, USER, originalTabId, replacementScope)).toBe(U_URI)
        expect(getComposerDraftRevision(CHAT, USER, originalTabId, replacementScope)).toBe(
          revisionAfterReplacementActivation
        )
        expect(getStoredComposerDraft(CHAT, USER, originalTabId, originalScope)).toBe('')
        const receiptAfterFileActivation = screen.getByTestId('prefill-receipt-probe')
        expect(receiptAfterFileActivation.getAttribute('data-receipt-id')).toBe(
          replacementActivationReceipt.getAttribute('data-receipt-id')
        )
        await openChatDrawer()
        const reactivatedInput = screen.getByTestId('chat-input') as HTMLTextAreaElement
        expect(reactivatedInput.value).toBe(U_URI)
        fireEvent.blur(reactivatedInput)
        fireEvent.focus(reactivatedInput)
        await act(async () => {
          await new Promise(resolve => setTimeout(resolve, 0))
        })
        expect(reactivatedInput.value).toBe(U_URI)
        expect(getStoredComposerDraft(CHAT, USER, originalTabId, replacementScope)).toBe(U_URI)
        expect(getLatestGfsConversationContext(replacementScope)).toMatchObject({
          uri: U_URI,
          sourceTabId: originalResourceContext?.sourceTabId,
          authorityScope: replacementScope,
        })
        expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')).toBe(
          replacementActivationReceipt.getAttribute('data-receipt-id')
        )
        expect(getComposerDraftRevision(CHAT, USER, originalTabId, replacementScope)).toBe(
          revisionAfterReplacementActivation
        )
        expect(getStoredComposerDraft(CHAT, USER, originalTabId, originalScope)).toBe('')

        await act(async () => {
          ownerResolution.resolve(
            await resolveResource(
              resolvedDirectory(U_ID, 'Folder U', { path: '/Folder U', parentResourceId: null })
            )
          )
          await ownerResolution.promise
        })
        await waitFor(() =>
          expect(getLatestGfsConversationContext(replacementScope)).toMatchObject({
            uri: U_URI,
            authorityScope: replacementScope,
          })
        )
        expect(getComposerDraftRevision(CHAT, USER, originalTabId, replacementScope)).toBe(
          revisionAfterReplacementActivation
        )

        await openFolderU()
        expect(getLatestGfsConversationContext(replacementScope)).toMatchObject({
          uri: U_URI,
          authorityScope: replacementScope,
        })
        const restoredInput = (await selectSidebarConversation()) as HTMLTextAreaElement
        await waitFor(() => expect(restoredInput.value).toBe(U_URI))
        expect(getStoredComposerDraft(CHAT, USER, receiptProbe.tabId, replacementScope)).toBe(U_URI)
        expect(getComposerDraftRevision(CHAT, USER, originalTabId, replacementScope)).toBe(
          revisionAfterReplacementActivation
        )
        expect(getStoredComposerDraft(CHAT, USER, originalTabId, originalScope)).toBe('')
        expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
        expect(model.sends).toBe(0)
        expect(scheduledResponseOrder).toEqual(['auth-session-state', 'host-list-sessions'])
        expect(scheduler.report().every(task => task.status === 'resolved')).toBe(true)
      }),
      { numRuns: 1, seed: 1292 }
    )
  })

  it('A6 schedules held Host completion after generated newer-Chat commands', async () => {
    const targetChat = 'chat-y'
    const newerChat = 'chat-b'
    type Model = {
      activeChat: string
      newerSelectionSeen: boolean
      drafts: Record<string, string>
      sends: number
    }
    type Real = {
      selectNewerChat: () => Promise<void>
      refocus: () => Promise<void>
      assertMatches: (model: Model) => Promise<void>
    }

    class SelectNewerChatCommand implements AsyncCommand<Model, Real> {
      check(model: Readonly<Model>) {
        return !model.newerSelectionSeen
      }
      async run(model: Model, real: Real) {
        await real.selectNewerChat()
        model.activeChat = newerChat
        model.newerSelectionSeen = true
        model.drafts[newerChat] = U_URI
        await real.assertMatches(model)
      }
      toString() {
        return `select-newer-chat:${newerChat}`
      }
    }

    class RefocusCommand implements AsyncCommand<Model, Real> {
      check() {
        return true
      }
      async run(model: Model, real: Real) {
        await real.refocus()
        await real.assertMatches(model)
      }
      toString() {
        return 'refocus-current-chat'
      }
    }

    const generatedRefocuses = fc.commands([fc.constant(new RefocusCommand())], {
      maxCommands: 2,
    })
    await fc.assert(
      fc.asyncProperty(fc.scheduler(), generatedRefocuses, async (scheduler, commands) => {
        const { clerum, queryClient, view } = await setupApp(
          [
            { agent: USER, chatId: CHAT, title: 'Earlier chat' },
            { agent: 'agent-y', chatId: targetChat, title: 'Stale target' },
            { agent: USER, chatId: newerChat, title: 'Newer chat' },
          ],
          false,
          [USER, 'agent-y']
        )
        const model: Model = {
          activeChat: CHAT,
          newerSelectionSeen: false,
          drafts: { [CHAT]: U_URI },
          sends: 0,
        }
        await openFolderU()
        await openChatDrawer()
        const inputA = (await selectSidebarConversation()) as HTMLTextAreaElement
        await waitFor(() => expect(inputA.value).toBe(U_URI))
        model.drafts[CHAT] = inputA.value
        expect(getComposerDraft(newerChat, USER)).toBe('')

        clerum.rpc.renameSession.mockRejectedValue(await ipcHostAccessRevoked('rpc:renameSession'))
        expect(appTestActions.holdHost).toBeTypeOf('function')
        await act(async () => {
          await appTestActions.holdHost!('agent-y', targetChat)
        })
        const hostResolution = deferred<ReturnType<typeof serverSessions>>()
        const hostOrder: string[] = []
        clerum.rpc.listSessions.mockClear()
        clerum.rpc.listSessions.mockImplementation(async (agent, _team, query) =>
          agent === 'agent-y' && query?.limit === 1
            ? hostResolution.promise
            : serverSessions([
                { agent: USER, chatId: CHAT },
                { agent: USER, chatId: newerChat },
                { agent: 'agent-y', chatId: targetChat },
              ])
        )
        fireEvent.click(screen.getByTestId('open-same-scope-stale-target'))
        await waitFor(() =>
          expect(clerum.rpc.listSessions).toHaveBeenCalledWith('agent-y', undefined, {
            agent: 'agent-y',
            limit: 1,
          })
        )

        const real: Real = {
          selectNewerChat: async () => {
            hostOrder.push('selection')
            await act(async () => {
              fireEvent.click(await screen.findByRole('button', { name: 'Open Newer chat' }))
              await waitFor(() =>
                expect(screen.getByTestId('chat-thread-stub').textContent).toBe(newerChat)
              )
              await waitFor(() =>
                expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).value).toBe(U_URI)
              )
            })
          },
          refocus: async () => {
            const input = screen.getByTestId('chat-input') as HTMLTextAreaElement
            await act(async () => {
              fireEvent.blur(input)
              fireEvent.focus(input)
              await new Promise(resolve => setTimeout(resolve, 0))
            })
          },
          assertMatches: async expected => {
            await act(async () => {
              await Promise.resolve()
              await new Promise(resolve => setTimeout(resolve, 0))
            })
            const input = screen.getByTestId('chat-input') as HTMLTextAreaElement
            expect(screen.getByTestId('chat-thread-stub').textContent).toBe(expected.activeChat)
            expect(input.value).toBe(expected.drafts[expected.activeChat] ?? '')
            expect(getComposerDraft(expected.activeChat, USER)).toBe(
              expected.drafts[expected.activeChat] ?? ''
            )
            expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
            expect(expected.sends).toBe(0)
          },
        }

        const initialChatTabId = receiptProbe.tabId
        const initialScope = receiptProbe.scope
        expect(getStoredComposerDraft(newerChat, USER, initialChatTabId, initialScope)).toBe('')
        const commandsToRun = [new SelectNewerChatCommand(), ...commands]
        const commandRun = fc.asyncModelRun(() => ({ model, real }), commandsToRun)
        await commandRun
        const scheduledHostCompletion = scheduler.scheduleFunction(async () => {
          hostOrder.push('host')
          await act(async () => {
            hostResolution.resolve(
              serverSessions([{ agent: 'agent-y', chatId: targetChat, title: 'Stale target' }])
            )
            if (appTestActions.openTargetPromise) await appTestActions.openTargetPromise
            await new Promise(resolve => setTimeout(resolve, 0))
          })
        })()
        await scheduler.waitFor(scheduledHostCompletion)
        await appTestActions.openTargetPromise
        await real.assertMatches(model)

        expect(scheduler.report().every(task => task.status === 'resolved')).toBe(true)
        expect(hostOrder).toEqual(['selection', 'host'])
        expect(model.activeChat).toBe(newerChat)
        expect(model.newerSelectionSeen).toBe(true)
        expect(model.drafts[newerChat]).toBe(U_URI)
        const newerReceiptId = Number(
          screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')
        )
        const activeChatTabId = receiptProbe.tabId
        const activeScope = receiptProbe.scope
        expect(appTestActions.prefillAttempts.filter(id => id === newerReceiptId)).toHaveLength(1)
        expect(
          (screen.getByTestId('chat-input') as HTMLTextAreaElement).value.match(/gfs:\/\//g)
        ).toHaveLength(1)
        expect(getComposerDraft(newerChat, USER)).toBe(U_URI)
        expect(activeScope).toBe(initialScope)
        expect(getStoredComposerDraft(newerChat, USER, activeChatTabId, activeScope)).toBe(U_URI)
        await queryClient.cancelQueries()
        queryClient.clear()
        view.unmount()
      }),
      { numRuns: 1, seed: 1 }
    )
  })

  it('A6 model-checks competing real Host completions in generated command histories', async () => {
    type Target = 'y' | 'z'
    type Model = {
      activeChat: string
      drafts: Record<string, string>
      startedTargets: Target[]
      latestTarget: Target | null
      sends: number
    }
    type Real = {
      startTarget: (target: Target) => Promise<void>
      setCurrentDraft: (value: string) => Promise<void>
      assertMatches: (model: Model) => Promise<void>
    }
    const targetInfo = {
      y: { agent: 'agent-y', chat: 'chat-y', button: 'open-same-scope-stale-target' },
      z: { agent: 'agent-z', chat: 'chat-z', button: 'open-second-same-scope-stale-target' },
    } satisfies Record<Target, { agent: string; chat: string; button: string }>

    class SetDraftCommand implements AsyncCommand<Model, Real> {
      constructor(private readonly value: string) {}
      check(model: Readonly<Model>) {
        return model.startedTargets.length === 2 && model.activeChat === CHAT
      }
      async run(model: Model, real: Real) {
        await real.setCurrentDraft(this.value)
        model.drafts[CHAT] = this.value
        await real.assertMatches(model)
      }
      toString() {
        return `edit-current-draft:${JSON.stringify(this.value)}`
      }
    }

    const commandHistory = fc.commands(
      [
        fc
          .constantFrom('', 'typed while Host checks are pending', '  ')
          .map(value => new SetDraftCommand(value)),
      ],
      { maxCommands: 4 }
    )
    const observedCompletionOrders = new Set<string>()

    await fc.assert(
      fc.asyncProperty(
        fc.scheduler<{ target: Target }>({
          act: async scheduledAction => {
            await act(scheduledAction)
          },
        }),
        commandHistory,
        async (scheduler, commands) => {
          const { clerum, queryClient, view } = await setupApp(
            [
              { agent: USER, chatId: CHAT, title: 'Earlier chat' },
              { agent: targetInfo.y.agent, chatId: targetInfo.y.chat, title: 'Target Y' },
              { agent: targetInfo.z.agent, chatId: targetInfo.z.chat, title: 'Target Z' },
            ],
            false,
            [USER, targetInfo.y.agent, targetInfo.z.agent]
          )
          const hostResponses = {
            y: deferred<ReturnType<typeof serverSessions>>(),
            z: deferred<ReturnType<typeof serverSessions>>(),
          }
          const targetPromises = new Map<Target, Promise<void>>()
          const model: Model = {
            activeChat: CHAT,
            drafts: { [CHAT]: '' },
            startedTargets: [],
            latestTarget: null,
            sends: 0,
          }

          try {
            await openFolderU()
            await openChatDrawer()
            const input = (await selectSidebarConversation()) as HTMLTextAreaElement
            await waitFor(() => expect(input.value).toBe(U_URI))
            fireEvent.change(input, { target: { value: '' } })
            await waitFor(() => expect(getStoredComposerDraft(CHAT, USER)).toBe(''))

            clerum.rpc.renameSession.mockRejectedValue(
              await ipcHostAccessRevoked('rpc:renameSession')
            )
            expect(appTestActions.holdHost).toBeTypeOf('function')
            await act(async () => {
              await appTestActions.holdHost!(targetInfo.y.agent, targetInfo.y.chat)
              await appTestActions.holdHost!(targetInfo.z.agent, targetInfo.z.chat)
            })
            clerum.rpc.listSessions.mockClear()
            clerum.rpc.listSessions.mockImplementation(async (agent, _team, query) => {
              if (query?.limit === 1 && agent === targetInfo.y.agent) {
                return scheduler.schedule(hostResponses.y.promise, 'Host sessions Y', {
                  target: 'y',
                })
              }
              if (query?.limit === 1 && agent === targetInfo.z.agent) {
                return scheduler.schedule(hostResponses.z.promise, 'Host sessions Z', {
                  target: 'z',
                })
              }
              return serverSessions([
                { agent: USER, chatId: CHAT, title: 'Earlier chat' },
                { agent: targetInfo.y.agent, chatId: targetInfo.y.chat, title: 'Target Y' },
                { agent: targetInfo.z.agent, chatId: targetInfo.z.chat, title: 'Target Z' },
              ])
            })

            const real: Real = {
              startTarget: async target => {
                const info = targetInfo[target]
                const callCountBefore = clerum.rpc.listSessions.mock.calls.length
                await act(async () => {
                  fireEvent.click(screen.getByTestId(info.button))
                })
                const operation = appTestActions.openTargetPromise
                if (!operation) throw new Error(`Missing real notification promise for ${target}`)
                targetPromises.set(target, operation)
                await waitFor(() =>
                  expect(
                    clerum.rpc.listSessions.mock.calls
                      .slice(callCountBefore)
                      .some(([agent, _team, query]) => agent === info.agent && query?.limit === 1)
                  ).toBe(true)
                )
              },
              setCurrentDraft: async value => {
                fireEvent.change(screen.getByTestId('chat-input'), { target: { value } })
                await waitFor(() => expect(getStoredComposerDraft(CHAT, USER)).toBe(value))
              },
              assertMatches: async expected => {
                await act(async () => {
                  await Promise.resolve()
                  await new Promise(resolve => setTimeout(resolve, 0))
                })
                const expectedAgent =
                  expected.activeChat === targetInfo.y.chat
                    ? targetInfo.y.agent
                    : expected.activeChat === targetInfo.z.chat
                      ? targetInfo.z.agent
                      : USER
                const expectedDraft = expected.drafts[expected.activeChat] ?? ''
                await waitFor(() => {
                  expect(screen.getByTestId('chat-thread-stub').textContent).toBe(
                    expected.activeChat
                  )
                  expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).value).toBe(
                    expectedDraft
                  )
                })
                expect(
                  getStoredComposerDraft(
                    expected.activeChat,
                    expectedAgent,
                    receiptProbe.tabId,
                    receiptProbe.scope
                  )
                ).toBe(expectedDraft)
                expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
                expect(expected.sends).toBe(0)
              },
            }

            await real.startTarget('y')
            model.startedTargets.push('y')
            model.latestTarget = 'y'
            await real.assertMatches(model)
            await real.startTarget('z')
            model.startedTargets.push('z')
            model.latestTarget = 'z'
            await real.assertMatches(model)

            await fc.asyncModelRun(() => ({ model, real }), commands)
            expect(model.startedTargets).toEqual(['y', 'z'])
            expect(model.latestTarget).not.toBeNull()
            expect(model.activeChat).toBe(CHAT)
            const originalChatText = model.drafts[CHAT]
            hostResponses.y.resolve(
              serverSessions([
                { agent: targetInfo.y.agent, chatId: targetInfo.y.chat, title: 'Target Y' },
              ])
            )
            hostResponses.z.resolve(
              serverSessions([
                { agent: targetInfo.z.agent, chatId: targetInfo.z.chat, title: 'Target Z' },
              ])
            )
            const completionOrder: Target[] = []
            const observedTargets = new Set<Target>()
            for (let completed = 0; completed < 2; completed += 1) {
              await scheduler.waitNext(1)
              const newlyCompleted = scheduler
                .report()
                .filter(
                  task =>
                    task.status === 'resolved' &&
                    (task.metadata?.target === 'y' || task.metadata?.target === 'z') &&
                    !observedTargets.has(task.metadata.target)
                )
              const target = newlyCompleted.at(-1)?.metadata?.target
              if (target !== 'y' && target !== 'z') {
                throw new Error(
                  `Missing newly completed Host response: ${JSON.stringify(scheduler.report())}`
                )
              }
              observedTargets.add(target)
              completionOrder.push(target)
              const operation = targetPromises.get(target)
              if (!operation) throw new Error(`Missing held notification promise for ${target}`)
              await act(async () => {
                await operation
                await new Promise(resolve => setTimeout(resolve, 0))
              })
              if (model.latestTarget === target) {
                const info = targetInfo[target]
                model.activeChat = info.chat
                model.drafts[info.chat] = U_URI
              }
              await real.assertMatches(model)
            }
            await Promise.all(targetPromises.values())
            expect(scheduler.report().every(task => task.status === 'resolved')).toBe(true)
            expect(scheduler.count()).toBe(0)
            expect(completionOrder).toHaveLength(2)
            observedCompletionOrders.add(completionOrder.join('>'))
            expect(model.activeChat).toBe(targetInfo[model.latestTarget!].chat)
            expect(model.drafts[CHAT]).toBe(originalChatText)
            expect(model.drafts[model.activeChat]).toBe(U_URI)
          } finally {
            hostResponses.y.resolve(
              serverSessions([{ agent: targetInfo.y.agent, chatId: targetInfo.y.chat }])
            )
            hostResponses.z.resolve(
              serverSessions([{ agent: targetInfo.z.agent, chatId: targetInfo.z.chat }])
            )
            await scheduler.waitIdle()
            await Promise.allSettled(targetPromises.values())
            await queryClient.cancelQueries()
            queryClient.clear()
            view.unmount()
            await act(async () => {
              await Promise.resolve()
              await new Promise(resolve => setTimeout(resolve, 0))
              await Promise.resolve()
            })
            cleanupClerum?.()
            cleanupClerum = null
            resetComposerDraftStore()
            receiptProbe.ids = []
            receiptProbe.statuses = []
            appTestActions.holdHost = null
            appTestActions.openTargetPromise = null
            appTestActions.selectChatAgent = null
            appTestActions.prefillEvents = []
            appTestActions.prefillAttempts = []
            appTestActions.auth = null
            appTestActions.emitEntityChange = null
            appTestActions.scopeCommitProbe = null
            appTestActions.firstScopeCommit = null
            clearLatestGfsConversationContext()
            resizeCallbacks = []
            drawerHeader.props = null
          }
        }
      ),
      { numRuns: 8, seed: 129212, endOnFailure: true }
    )
    expect(observedCompletionOrders).toEqual(new Set(['y>z', 'z>y']))
  })

  it('L7 lets a newer Sidebar selection win while the old Composer is detached', async () => {
    const { clerum } = await setupApp([
      { agent: USER, chatId: CHAT, title: 'Earlier chat' },
      { agent: USER, chatId: 'chat-b', title: 'Newer chat' },
    ])
    await openFolderU()
    const firstComposer = await selectSidebarConversation()
    await waitFor(() => expect((firstComposer as HTMLTextAreaElement).value).toBe(U_URI))
    await switchWorkspaceTab('Folder U')
    await openChatDrawer()
    await navigateIntoV()
    resizeAppTo(700)
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Chat' })).toBeNull())

    fireEvent.click(screen.getByRole('button', { name: 'Open Newer chat' }))
    await waitFor(() => expect(screen.getByTestId('chat-thread-stub').textContent).toBe('chat-b'))
    expect(
      within(screen.getByRole('toolbar', { name: 'Workspace tabs' }))
        .getByRole('button', { name: 'Newer chat' })
        .getAttribute('aria-pressed')
    ).toBe('true')
    expect(getLatestGfsConversationContext()).toMatchObject({ uri: V_URI })
    expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
  })

  it('L10 React StrictMode effect replay keeps the first visible insertion unsent', async () => {
    const { clerum, queryClient, view } = await setupApp(
      [{ agent: USER, chatId: CHAT, title: 'Earlier chat' }],
      true
    )
    await openFolderU()
    let draftNotifications = 0
    const unsubscribe = subscribeComposerDraft(
      CHAT,
      () => {
        draftNotifications += 1
      },
      USER
    )
    try {
      const composer = await selectSidebarConversation()
      await waitFor(() => expect((composer as HTMLTextAreaElement).value).toBe(U_URI))
      expect(getComposerDraft(CHAT, USER)).toBe(U_URI)
      expect(draftNotifications).toBe(1)
      const insertedReceiptId = Number(
        screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')
      )
      expect(appTestActions.prefillAttempts.filter(id => id === insertedReceiptId)).toHaveLength(1)
      const revisionAfterInsertion = getComposerDraftRevision(
        CHAT,
        USER,
        receiptProbe.tabId,
        receiptProbe.scope
      )

      await act(async () => {
        view.rerender(
          <QueryClientProvider client={queryClient}>
            <AgentTaskTrackerProvider>
              <StrictMode>
                <App />
              </StrictMode>
            </AgentTaskTrackerProvider>
          </QueryClientProvider>
        )
      })
      await act(async () => {
        await Promise.resolve()
        await new Promise(resolve => setTimeout(resolve, 0))
      })
      expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).value).toBe(U_URI)
      expect(getComposerDraft(CHAT, USER)).toBe(U_URI)
      expect(getComposerDraftRevision(CHAT, USER, receiptProbe.tabId, receiptProbe.scope)).toBe(
        revisionAfterInsertion
      )
      expect(draftNotifications).toBe(1)
      expect(appTestActions.prefillAttempts.filter(id => id === insertedReceiptId)).toHaveLength(1)
      expect(screen.getByTestId('chat-thread-stub').textContent).toBe(CHAT)
      expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
    } finally {
      unsubscribe()
    }
  })

  it('A3-22 preserves text selection and real attachments without send or navigation effects', async () => {
    const { clerum, gfs } = await setupApp()
    await openFolderU()
    const input = (await selectSidebarConversation()) as HTMLTextAreaElement
    await waitFor(() => expect(input.value).toBe(U_URI))
    const workspaceTabId = receiptProbe.tabId
    const authorityScope = receiptProbe.scope
    fireEvent.change(input, { target: { value: U_URI } })
    await waitFor(() =>
      expect(getStoredComposerDraft(CHAT, USER, workspaceTabId, authorityScope)).toBe(U_URI)
    )

    const imageBytes = Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
      ),
      character => character.charCodeAt(0)
    )
    const image = new File([imageBytes], 'chart.png', { type: 'image/png' })
    fireEvent.paste(input, { clipboardData: { files: [image], items: [] } })
    const filePicker = document.querySelector<HTMLInputElement>('.composer-file-input')
    if (!filePicker) throw new Error('The real Composer file picker is unavailable')
    fireEvent.change(filePicker, {
      target: { files: [new File(['notes'], 'notes.txt', { type: 'text/plain' })] },
    })
    await waitFor(() =>
      expect(screen.getByTestId('composer-attachments-count').textContent).toBe('2 attachments')
    )
    expect(screen.getByTestId('composer-file-chip').textContent).toContain('notes.txt')
    expect(document.querySelector('.composer-reference-icon--uploaded-image')).toBeTruthy()

    fireEvent.change(input, { target: { value: 'keep this selection' } })
    await waitFor(() =>
      expect(getStoredComposerDraft(CHAT, USER, workspaceTabId, authorityScope)).toBe(
        'keep this selection'
      )
    )
    input.setSelectionRange(2, 7)
    const userTextRevision = getComposerDraftRevision(CHAT, USER, workspaceTabId, authorityScope)
    const activeTab = within(screen.getByRole('toolbar', { name: 'Workspace tabs' })).getByRole(
      'button',
      { name: 'Earlier chat' }
    )
    const currentResourceCalls = {
      resolve: gfs.resolve.mock.calls.length,
      listAccessible: gfs.listAccessible.mock.calls.length,
      listChildren: gfs.listChildren.mock.calls.length,
      affordances: gfs.affordances.mock.calls.length,
    }
    const routeBefore = screen.getByTestId('chat-thread-stub').textContent
    appTestActions.prefillEvents = []
    fireEvent.blur(input)
    fireEvent.focus(input)
    expect(input.value).toBe('keep this selection')
    expect(input.selectionStart).toBe(2)
    expect(input.selectionEnd).toBe(7)
    expect(getComposerDraftRevision(CHAT, USER, workspaceTabId, authorityScope)).toBe(
      userTextRevision
    )
    expect(screen.getByTestId('composer-attachments-count').textContent).toBe('2 attachments')
    expect(screen.getByTestId('composer-file-chip').textContent).toContain('notes.txt')
    expect(document.querySelector('.composer-reference-icon--uploaded-image')).toBeTruthy()
    expect(activeTab.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('chat-thread-stub').textContent).toBe(routeBefore)
    expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: '' } })
    await waitFor(() =>
      expect(getStoredComposerDraft(CHAT, USER, workspaceTabId, authorityScope)).toBe('')
    )
    const emptyRevision = getComposerDraftRevision(CHAT, USER, workspaceTabId, authorityScope)
    fireEvent.blur(input)
    fireEvent.focus(input)
    await waitFor(() => expect(input.value).toBe(U_URI))
    expect(getStoredComposerDraft(CHAT, USER, workspaceTabId, authorityScope)).toBe(U_URI)
    expect(input.value.match(/gfs:\/\//g)).toHaveLength(1)
    expect(getComposerDraftRevision(CHAT, USER, workspaceTabId, authorityScope)).toBe(
      emptyRevision + 1
    )
    expect(screen.getByTestId('composer-attachments-count').textContent).toBe('2 attachments')
    expect(screen.getByTestId('composer-file-chip').textContent).toContain('notes.txt')
    expect(document.querySelector('.composer-reference-icon--uploaded-image')).toBeTruthy()
    expect(activeTab.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('chat-thread-stub').textContent).toBe(routeBefore)
    expect(gfs.resolve).toHaveBeenCalledTimes(currentResourceCalls.resolve)
    expect(gfs.listAccessible).toHaveBeenCalledTimes(currentResourceCalls.listAccessible)
    expect(gfs.listChildren).toHaveBeenCalledTimes(currentResourceCalls.listChildren)
    expect(gfs.affordances).toHaveBeenCalledTimes(currentResourceCalls.affordances)
    expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
  })

  it('A3-4 preserves a nonempty draft on genuine refocus with current Files context', async () => {
    const { clerum, gfs } = await setupApp()
    const initialInput = (await selectSidebarConversation()) as HTMLTextAreaElement
    const userText = 'keep this user-authored text'
    fireEvent.change(initialInput, { target: { value: userText } })
    initialInput.setSelectionRange(5, 14)
    const destinationTabId = receiptProbe.tabId
    const authorityScope = receiptProbe.scope
    await waitFor(() =>
      expect(getStoredComposerDraft(CHAT, USER, destinationTabId, authorityScope)).toBe(userText)
    )
    const draftRevision = getComposerDraftRevision(CHAT, USER, destinationTabId, authorityScope)

    await openFolderU()
    const input = (await selectSidebarConversation()) as HTMLTextAreaElement
    expect(input.isConnected).toBe(true)
    fireEvent.blur(input)
    fireEvent.focus(input)
    expect(appTestActions.prefillEvents).toContain('focus')
    const receiptProbeElement = screen.getByTestId('prefill-receipt-probe')
    expect(receiptProbeElement.getAttribute('data-receipt-id')).not.toBe('')
    await act(async () => {
      await Promise.resolve()
      await new Promise(resolve => setTimeout(resolve, 25))
    })

    expect(input.value).toBe(userText)
    expect(getStoredComposerDraft(CHAT, USER, destinationTabId, authorityScope)).toBe(userText)
    expect(getComposerDraftRevision(CHAT, USER, destinationTabId, authorityScope)).toBe(
      draftRevision
    )
    expect(getLatestGfsConversationContext()?.uri).toBe(U_URI)
    expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()

    const resourceCalls = {
      resolve: gfs.resolve.mock.calls.length,
      listAccessible: gfs.listAccessible.mock.calls.length,
      listChildren: gfs.listChildren.mock.calls.length,
      affordances: gfs.affordances.mock.calls.length,
    }
    const chatTab = within(screen.getByRole('toolbar', { name: 'Workspace tabs' })).getByRole(
      'button',
      { name: 'Earlier chat' }
    )
    expect(chatTab.getAttribute('aria-pressed')).toBe('true')
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 25))
    })
    expect(input.value).toBe(userText)
    expect(chatTab.getAttribute('aria-pressed')).toBe('true')
    expect(gfs.resolve).toHaveBeenCalledTimes(resourceCalls.resolve)
    expect(gfs.listAccessible).toHaveBeenCalledTimes(resourceCalls.listAccessible)
    expect(gfs.listChildren).toHaveBeenCalledTimes(resourceCalls.listChildren)
    expect(gfs.affordances).toHaveBeenCalledTimes(resourceCalls.affordances)
    expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()

    const eventsBeforeClear = [...appTestActions.prefillEvents]
    const revisionBeforeClear = getComposerDraftRevision(
      CHAT,
      USER,
      destinationTabId,
      authorityScope
    )
    fireEvent.change(input, { target: { value: '' } })
    await act(async () => {
      await Promise.resolve()
      await new Promise(resolve => setTimeout(resolve, 25))
    })
    expect(input.value).toBe('')
    expect(getStoredComposerDraft(CHAT, USER, destinationTabId, authorityScope)).toBe('')
    expect(getComposerDraftRevision(CHAT, USER, destinationTabId, authorityScope)).toBe(
      revisionBeforeClear + 1
    )
    expect(appTestActions.prefillEvents).toEqual([...eventsBeforeClear, 'input-edit'])
    expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()

    const sendButton = screen.getByTestId('send-button') as HTMLButtonElement
    fireEvent.change(input, { target: { value: userText } })
    await waitFor(() =>
      expect(getStoredComposerDraft(CHAT, USER, destinationTabId, authorityScope)).toBe(userText)
    )
    fireEvent.blur(input)
    fireEvent.focus(input)
    await act(async () => {
      await Promise.resolve()
      await new Promise(resolve => setTimeout(resolve, 25))
    })
    expect(input.value).toBe(userText)
    expect(getStoredComposerDraft(CHAT, USER, destinationTabId, authorityScope)).toBe(userText)
    expect(appTestActions.prefillEvents.slice(-1)).toEqual(['focus'])
    expect(sendButton.disabled, sendButton.outerHTML).toBe(false)
    const receiptIdBeforeSend = Number(receiptProbeElement.getAttribute('data-receipt-id'))
    const eventsBeforeSend = [...appTestActions.prefillEvents]
    fireEvent.click(sendButton)
    await waitFor(() => expect(clerum.rpc.invokeHostMessage).toHaveBeenCalledTimes(1))
    const sentPayload = clerum.rpc.invokeHostMessage.mock.calls[0]?.[1] as { content?: string }
    expect(sentPayload.content).toBe(userText)
    await waitFor(() => expect(input.value).toBe(''))
    await act(async () => {
      await Promise.resolve()
      await new Promise(resolve => setTimeout(resolve, 25))
    })
    expect(input.value).toBe('')
    expect(getStoredComposerDraft(CHAT, USER, destinationTabId, authorityScope)).toBe('')
    expect(Number(receiptProbeElement.getAttribute('data-receipt-id'))).toBe(receiptIdBeforeSend)
    expect(appTestActions.prefillEvents).toEqual(eventsBeforeSend)
    expect(clerum.rpc.invokeHostMessage).toHaveBeenCalledTimes(1)
  })

  it('A3-7 sends a B-only attachment without exposing or consuming hidden A URI bytes', async () => {
    const { clerum } = await setupApp()
    const actualRefreshCatalog = clerum.access.refreshCatalog.getMockImplementation()
    if (!actualRefreshCatalog) throw new Error('Expected the real access catalog fixture producer')
    clerum.access.refreshCatalog.mockImplementation(async (...args: any[]) => {
      const catalog = await actualRefreshCatalog(...args)
      const session = await clerum.auth.getSessionState()
      return { ...catalog, teamId: session.me?.teamId ?? catalog.teamId }
    })
    await openFolderU()
    const inputA = (await selectSidebarConversation()) as HTMLTextAreaElement
    await waitFor(() => expect(inputA.value).toBe(U_URI))
    const scopeA = receiptProbe.scope
    const tabA = receiptProbe.tabId
    expect(getStoredComposerDraft(CHAT, USER, tabA, scopeA)).toBe(U_URI)

    await switchWorkspaceTab('Folder U')
    await openChatDrawer()
    appTestActions.scopeCommitProbe = {
      scope: scopeA,
      agentRef: USER,
      chatId: CHAT,
      tabId: tabA,
    }
    fireEvent.click(screen.getByTestId('open-cross-team-latest-chat'))
    await waitFor(() => expect(appTestActions.firstScopeCommit).not.toBeNull())
    expect(appTestActions.firstScopeCommit).toMatchObject({
      visibleText: '',
      projectedText: '',
      originText: U_URI,
    })
    expect(appTestActions.firstScopeCommit?.scope).not.toBe(scopeA)
    expect(appTestActions.firstScopeCommit?.originRevision).toBeGreaterThan(0)
    await waitFor(() =>
      expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-team-id')).toBe(
        'team-2'
      )
    )
    const inputB = (await screen.findByTestId('chat-input')) as HTMLTextAreaElement
    await waitFor(() => expect(inputB.value).toBe(''))
    const scopeB = receiptProbe.scope
    expect(scopeB).not.toBe(scopeA)
    expect(getStoredComposerDraft(CHAT, USER, tabA, scopeA)).toBe(U_URI)
    expect(getComposerDraft(CHAT, USER)).toBe('')

    fireEvent.click(await screen.findByRole('button', { name: 'Open Earlier chat' }))
    await waitFor(() => expect(screen.getByTestId('chat-thread-stub').textContent).toBe(CHAT))
    const activeInputB = (await screen.findByTestId('chat-input')) as HTMLTextAreaElement
    await waitFor(() => expect(activeInputB.value).toBe(''))

    const filePicker = document.querySelector<HTMLInputElement>('.composer-file-input')
    if (!filePicker) throw new Error('The real Composer file picker is unavailable')
    fireEvent.change(filePicker, {
      target: { files: [new File(['team B notes'], 'team-b-notes.txt', { type: 'text/plain' })] },
    })
    await waitFor(() =>
      expect(screen.getByTestId('composer-file-chip').textContent).toContain('team-b-notes.txt')
    )
    await waitFor(() =>
      expect(
        document.querySelector('.composer-attachment-chip[data-file-status="ready"]')
      ).toBeTruthy()
    )
    expect(activeInputB.value).toBe('')
    const sendButton = screen.getByTestId('send-button') as HTMLButtonElement
    expect(sendButton.disabled, sendButton.outerHTML).toBe(false)
    fireEvent.click(sendButton)
    await waitFor(() => expect(clerum.rpc.invokeHostMessage).toHaveBeenCalledTimes(1))
    const payload = clerum.rpc.invokeHostMessage.mock.calls[0]?.[1] as {
      content?: string
      attachments?: Array<{ filename?: string }>
    }
    expect(payload.content).toBe('Please analyze the attached file(s).')
    expect(payload.content ?? '').not.toContain(U_URI)
    expect(payload.attachments).toHaveLength(1)
    expect(payload.attachments?.[0]?.filename).toBe('team-b-notes.txt')
    expect(getStoredComposerDraft(CHAT, USER, tabA, scopeA)).toBe(U_URI)
    expect(getStoredComposerDraft(CHAT, USER, receiptProbe.tabId, scopeB)).toBe('')
    expect(clerum.rpc.invokeHostMessage).toHaveBeenCalledTimes(1)
  })

  it('C6 keeps Team A automatic bytes when Team B sends during its real index read', async () => {
    const { clerum } = await setupApp()
    const actualRefreshCatalog = clerum.access.refreshCatalog.getMockImplementation()
    if (!actualRefreshCatalog) throw new Error('Expected the real access catalog fixture producer')
    clerum.access.refreshCatalog.mockImplementation(async (...args: any[]) => {
      const catalog = await actualRefreshCatalog(...args)
      const session = await clerum.auth.getSessionState()
      return { ...catalog, teamId: session.me?.teamId ?? catalog.teamId }
    })
    await openFolderU()
    const inputA = (await selectSidebarConversation()) as HTMLTextAreaElement
    await waitFor(() => expect(inputA.value).toBe(U_URI))
    const scopeA = receiptProbe.scope
    const chatTabId = receiptProbe.tabId
    expect(getStoredComposerDraft(CHAT, USER, chatTabId, scopeA)).toBe(U_URI)

    // Stage the ordinary attachment before changing authority. Its stable
    // attachment state means the send callback's non-scope dependencies do not
    // refresh during the held Team B index read.
    const filePicker = document.querySelector<HTMLInputElement>('.composer-file-input')
    if (!filePicker) throw new Error('The real Composer file picker is unavailable')
    await act(async () => {
      fireEvent.change(filePicker, {
        target: {
          files: [new File(['team B notes'], 'team-b-notes.txt', { type: 'text/plain' })],
        },
      })
    })
    await waitFor(() =>
      expect(screen.getByTestId('composer-file-chip').textContent).toContain('team-b-notes.txt')
    )
    await waitFor(() =>
      expect(
        document.querySelector('.composer-attachment-chip[data-file-status="ready"]')
      ).toBeTruthy()
    )

    const teamBridge = window.clerum.team
    const teamSwitchMock = teamBridge.switch as unknown as Mock<(...args: any[]) => any>
    const originalTeamSwitch = teamSwitchMock.getMockImplementation()
    if (!originalTeamSwitch) throw new Error('Expected the real team-switch bridge')
    const indexReadEntered = deferred<void>()
    const releaseIndexRead = deferred<void>()
    let holdNextIndexRead = false
    let heldIndexResult: Awaited<ReturnType<typeof clerum.readIndex>> | null = null
    teamSwitchMock.mockImplementation(async teamId => {
      const session = await originalTeamSwitch(teamId)
      clerum.setChatStoreAuthorityScope({
        environmentKey: 'harness-environment',
        userId: 'user-1',
        teamId,
      })
      if (teamId === 'team-2') holdNextIndexRead = true
      return session
    })
    clerum.chat.getIndex.mockImplementation(async agentRef => {
      const index = await clerum.readIndex(agentRef)
      if (holdNextIndexRead && agentRef === USER) {
        holdNextIndexRead = false
        heldIndexResult = index
        indexReadEntered.resolve()
        await releaseIndexRead.promise
      }
      return index
    })

    try {
      await act(async () => {
        fireEvent.click(screen.getByTestId('open-cross-team-same-chat'))
        await indexReadEntered.promise
      })
      await waitFor(() => expect(receiptProbe.scope).toContain(':team-2:'))
      await waitFor(() => expect(screen.getByTestId('chat-thread-stub').textContent).toBe(CHAT))
      const inputB = screen.getByTestId('chat-input') as HTMLTextAreaElement
      await waitFor(() => expect(inputB.value).toBe(''))
      expect(heldIndexResult).toMatchObject({ version: expect.any(Number), chats: [] })
      const scopeB = receiptProbe.scope
      expect(scopeB).not.toBe(scopeA)
      expect(receiptProbe.tabId).toBe(chatTabId)
      expect(getStoredComposerDraft(CHAT, USER, chatTabId, scopeB)).toBe('')
      expect(getStoredComposerDraft(CHAT, USER, chatTabId, scopeA)).toBe(U_URI)
      await act(async () => {
        await Promise.resolve()
        await new Promise(resolve => setTimeout(resolve, 50))
        await Promise.resolve()
      })

      const sendButton = screen.getByTestId('send-button') as HTMLButtonElement
      await waitFor(() => expect(sendButton.disabled).toBe(false))
      expect(inputB.value).toBe('')
      await act(async () => {
        fireEvent.click(sendButton)
      })
      await waitFor(() => expect(clerum.rpc.invokeHostMessage).toHaveBeenCalledTimes(1))
      const payload = clerum.rpc.invokeHostMessage.mock.calls[0]?.[1] as {
        content?: string
        attachments?: Array<{ filename?: string }>
      }
      expect(payload.content).toBe('Please analyze the attached file(s).')
      expect(payload.content ?? '').not.toContain(U_URI)
      expect(payload.attachments).toHaveLength(1)
      expect(payload.attachments?.[0]?.filename).toBe('team-b-notes.txt')
      expect(getStoredComposerDraft(CHAT, USER, chatTabId, scopeA)).toBe(U_URI)
      expect(getStoredComposerDraft(CHAT, USER, chatTabId, scopeB)).toBe('')
      expect(inputB.value).toBe('')
      expect(clerum.rpc.invokeHostMessage).toHaveBeenCalledTimes(1)
      releaseIndexRead.resolve()
      const openTargetPromise = appTestActions.openTargetPromise
      if (openTargetPromise) await openTargetPromise
      await act(async () => {
        await Promise.resolve()
        await new Promise(resolve => setTimeout(resolve, 0))
      })
      expect(getStoredComposerDraft(CHAT, USER, chatTabId, scopeA)).toBe(U_URI)

      const revisionBeforeReturn = getComposerDraftRevision(CHAT, USER, chatTabId, scopeA)
      await act(async () => {
        fireEvent.click(screen.getByTestId('open-team-one-same-chat'))
        await appTestActions.openTargetPromise
      })
      await waitFor(() => expect(receiptProbe.scope).toBe(scopeA))
      await waitFor(() => expect(receiptProbe.tabId).toBe(chatTabId))
      await waitFor(() => expect(screen.getByTestId('chat-thread-stub').textContent).toBe(CHAT))
      const returnedInput = screen.getByTestId('chat-input') as HTMLTextAreaElement
      expect(getStoredComposerDraft(CHAT, USER, chatTabId, receiptProbe.scope)).toBe(U_URI)
      expect(returnedInput.value).toBe(U_URI)
      expect(getComposerDraftRevision(CHAT, USER, chatTabId, scopeA)).toBe(revisionBeforeReturn)
      expect(clerum.rpc.invokeHostMessage).toHaveBeenCalledTimes(1)
    } finally {
      releaseIndexRead.resolve()
      teamSwitchMock.mockImplementation(originalTeamSwitch)
    }
  })

  it('C6 rebinds attachment-only send when only composer authority scope changes', async () => {
    const clerum = installMockClerum()
    cleanupClerum = uninstallMockClerum
    const scopeA = 'env-test:user-a:team-a'
    const scopeB = 'env-test:user-a:team-b'
    const chatId = 'chat-scope-send'
    const agentRef = 'agent-x'
    const workspaceChatTabId = 'workspace-chat-tab-a'
    clerum.setChatStoreAuthorityScope({
      environmentKey: 'env-test',
      userId: 'user-a',
      teamId: 'team-a',
    })
    await clerum.chat.create(agentRef, chatId)

    const controller = renderController({
      composerAuthorityScope: scopeA,
      currentEnvironmentKey: 'env-test',
      currentTeamId: 'team-a',
      currentUserId: 'user-a',
      chatAuthorityTeamId: 'team-a',
    })
    await waitFor(() => expect(clerum.chat.getIndex).toHaveBeenCalled())
    await act(async () => {
      await controller.result.current.switchToChat(agentRef, chatId)
    })
    expect(controller.result.current.activeChatId).toBe(chatId)

    expect(
      composerDraftStore.setAutomaticComposerDraft(
        { authorityScope: scopeA, agentRef, chatId, workspaceChatTabId },
        U_URI
      )
    ).toBe(true)
    expect(getStoredComposerDraft(chatId, agentRef, workspaceChatTabId, scopeA)).toBe(U_URI)
    expect(getStoredComposerDraft(chatId, agentRef, workspaceChatTabId, scopeB)).toBe('')

    act(() => {
      controller.result.current.handleAddComposerFiles(
        [new File(['Team B attachment'], 'team-b.txt', { type: 'text/plain' })],
        ''
      )
    })
    await waitFor(() =>
      expect(controller.result.current.composerFileAttachments.map(file => file.status)).toEqual([
        'ready',
      ])
    )

    controller.rerender({ composerAuthorityScope: scopeB })

    await act(async () => {
      await controller.result.current.handleSendAgentMessage('', workspaceChatTabId)
    })

    expect(clerum.rpc.invokeHostMessage).toHaveBeenCalledTimes(1)
    const request = clerum.rpc.invokeHostMessage.mock.calls[0]?.[1] as {
      content?: string
      threadId?: string
      attachments?: Array<{ filename?: string }>
    }
    expect(request.threadId).toBe(chatId)
    expect(request.content ?? '').not.toContain(U_URI)
    expect(request.attachments).toHaveLength(1)
    expect(request.attachments?.[0]?.filename).toBe('team-b.txt')
    expect(getStoredComposerDraft(chatId, agentRef, workspaceChatTabId, scopeB)).toBe('')
    expect(getStoredComposerDraft(chatId, agentRef, workspaceChatTabId, scopeA)).toBe(U_URI)
    expect(clerum.rpc.invokeHostMessage).toHaveBeenCalledTimes(1)
  })

  it('A6 checks generated real-App commands against an independent A4 draft/receipt oracle', async () => {
    type Action =
      | { kind: 'focus'; text: '' }
      | { kind: 'resource-v'; text: '' }
      | { kind: 'resource-u'; text: '' }
      | { kind: 'clear'; text: '' }
      | { kind: 'type'; text: string }
    type Model = {
      resourceUri: string
      draft: string
      qualifyingEvents: number
      automaticWrites: number
      draftRevisionChanges: number
      sent: number
    }
    type Real = {
      apply: (action: Action) => Promise<void>
      assertMatches: (model: Model, previous: Model) => Promise<void>
    }

    const transition = (model: Model, action: Action): void => {
      if (action.kind === 'resource-v') model.resourceUri = V_URI
      if (action.kind === 'resource-u') model.resourceUri = U_URI

      if (action.kind === 'clear' || action.kind === 'type') {
        const nextDraft = action.kind === 'clear' ? '' : action.text
        if (nextDraft !== model.draft) {
          model.draft = nextDraft
          model.draftRevisionChanges += 1
        }
        return
      }

      model.qualifyingEvents += 1
      if (model.draft === '') {
        model.draft = model.resourceUri
        model.automaticWrites += 1
        model.draftRevisionChanges += 1
      }
    }

    class PrefillActionCommand implements AsyncCommand<Model, Real> {
      constructor(private readonly action: Action) {}
      check(model: Readonly<Model>) {
        if (this.action.kind === 'resource-v') return model.resourceUri !== V_URI
        if (this.action.kind === 'resource-u') return model.resourceUri !== U_URI
        return true
      }
      async run(model: Model, real: Real) {
        const previous = { ...model }
        transition(model, this.action)
        await real.apply(this.action)
        await real.assertMatches(model, previous)
      }
      toString() {
        return `${this.action.kind}:${this.action.text}`
      }
    }
    const action = fc.oneof(
      fc.constant<Action>({ kind: 'focus', text: '' }),
      fc.constant<Action>({ kind: 'resource-v', text: '' }),
      fc.constant<Action>({ kind: 'resource-u', text: '' }),
      fc.constant<Action>({ kind: 'clear', text: '' }),
      fc.constant('typed text').map(text => ({ kind: 'type', text }) as const),
      fc.constant('  ').map(text => ({ kind: 'type', text }) as const)
    )
    const actionCommands = fc.commands([action.map(value => new PrefillActionCommand(value))], {
      maxCommands: 6,
    })

    await fc.assert(
      fc.asyncProperty(actionCommands, async commands => {
        const { clerum, queryClient, view } = await setupApp()
        const model: Model = {
          resourceUri: U_URI,
          draft: '',
          qualifyingEvents: 0,
          automaticWrites: 0,
          draftRevisionChanges: 0,
          sent: 0,
        }
        let baseReceiptId = 0
        let baseAttemptCount = 0
        let baseRevision = 0
        const revision = () =>
          getComposerDraftRevision(CHAT, USER, receiptProbe.tabId, receiptProbe.scope)
        const settleAndAssert = async (expected: Model) => {
          await act(async () => {
            await Promise.resolve()
            await new Promise(resolve => setTimeout(resolve, 0))
            await Promise.resolve()
          })
          const probe = screen.getByTestId('prefill-receipt-probe')
          const input = screen.getByTestId('chat-input') as HTMLTextAreaElement
          expect(input.value).toBe(expected.draft)
          expect(getComposerDraft(CHAT, USER)).toBe(expected.draft)
          expect(screen.getByTestId('chat-thread-stub').textContent).toBe(CHAT)
          expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
          const currentId = Number(probe.getAttribute('data-receipt-id'))
          expect(probe.getAttribute('data-receipt-status')).toBe('consumed')
          expect(probe.getAttribute('data-resource-uri')).toBe(expected.resourceUri)
          expect(currentId).toBe(baseReceiptId + expected.qualifyingEvents)
          expect(appTestActions.prefillAttempts.length).toBe(
            baseAttemptCount + expected.qualifyingEvents
          )
          expect(revision()).toBe(baseRevision + expected.draftRevisionChanges)
          expect(expected.sent).toBe(0)
        }

        try {
          await openFolderU()
          const beforeSelectionReceipt = Number(
            screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')
          )
          const beforeSelectionRevision = revision()
          const initialInput = (await selectSidebarConversation()) as HTMLTextAreaElement
          await waitFor(() => expect(initialInput.value).toBe(U_URI))
          expect(getComposerDraft(CHAT, USER)).toBe(U_URI)
          expect(
            Number(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id'))
          ).toBeGreaterThan(beforeSelectionReceipt)
          expect(revision()).toBeGreaterThan(beforeSelectionRevision)
          await switchWorkspaceTab('Folder U')
          await openChatDrawer()
          fireEvent.change(screen.getByTestId('chat-input'), { target: { value: '' } })
          await waitFor(() => expect(getComposerDraft(CHAT, USER)).toBe(''))

          baseReceiptId = Number(
            screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')
          )
          baseAttemptCount = appTestActions.prefillAttempts.length
          baseRevision = revision()
          expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).value).toBe('')

          const real: Real = {
            apply: async next => {
              if (next.kind === 'focus') {
                const input = screen.getByTestId('chat-input') as HTMLTextAreaElement
                fireEvent.blur(input)
                fireEvent.focus(input)
                await waitFor(() =>
                  expect(
                    Number(
                      screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')
                    )
                  ).toBe(baseReceiptId + model.qualifyingEvents)
                )
              } else if (next.kind === 'resource-v') {
                await navigateIntoV()
              } else if (next.kind === 'resource-u') {
                await restoreFolderU()
              } else if (next.kind === 'clear') {
                fireEvent.change(screen.getByTestId('chat-input'), { target: { value: '' } })
              } else if (next.kind === 'type') {
                fireEvent.change(screen.getByTestId('chat-input'), {
                  target: { value: next.text },
                })
              }
            },
            assertMatches: async expected => {
              await settleAndAssert(expected)
            },
          }
          await new PrefillActionCommand({ kind: 'focus', text: '' }).run(model, real)
          await fc.asyncModelRun(() => ({ model, real }), commands)

          expect(model.qualifyingEvents).toBeGreaterThan(0)
          expect(model.automaticWrites).toBeGreaterThan(0)
          await settleAndAssert(model)
        } finally {
          view.unmount()
          queryClient.clear()
          cleanupClerum?.()
          cleanupClerum = null
          resetComposerDraftStore()
          clearLatestGfsConversationContext()
          vi.unstubAllGlobals()
          Reflect.deleteProperty(window, 'matchMedia')
        }
      }),
      { numRuns: 12, seed: 1292 }
    )
  })

  it('does not re-activate an old Files URI while a direct link resolve is pending', async () => {
    const { clerum, gfs, queryClient, view } = await setupApp()
    const targetResolveEntered = deferred<void>()
    const targetResolve = deferred<Awaited<ReturnType<typeof gfs.resolve>>>()
    const originalResolve = gfs.resolve.getMockImplementation()
    if (!originalResolve) throw new Error('Expected the real Files resolver boundary')

    try {
      await openFolderU()
      await openChatDrawer()
      const input = (await selectSidebarConversation()) as HTMLTextAreaElement
      await waitFor(() => expect(input.value).toBe(U_URI))
      fireEvent.change(input, { target: { value: '' } })
      await waitFor(() => expect(getStoredComposerDraft(CHAT, USER)).toBe(''))

      const scope = receiptProbe.scope
      const tabId = receiptProbe.tabId
      const activationId = getLatestGfsConversationContext(scope)?.activationId
      const revisionBefore = getComposerDraftRevision(CHAT, USER, tabId, scope)
      const eventCountBefore = appTestActions.prefillEvents.length
      gfs.resolve.mockImplementation(async uri => {
        if (uri === V_URI) {
          targetResolveEntered.resolve()
          return targetResolve.promise
        }
        return originalResolve(uri)
      })

      fireEvent.click(screen.getByRole('button', { name: 'Open link' }))
      const linkDialog = await screen.findByRole('dialog', { name: 'Open from link' })
      fireEvent.change(within(linkDialog).getByLabelText('URL'), {
        target: { value: V_URI },
      })
      fireEvent.click(within(linkDialog).getByRole('button', { name: 'Open' }))
      await targetResolveEntered.promise
      await act(async () => {
        await Promise.resolve()
        await new Promise(resolve => setTimeout(resolve, 0))
      })

      // The callback's rebind to the new navigation intent must not turn the
      // old FilesPage location into a new resource activation.
      expect(input.value).toBe('')
      expect(getStoredComposerDraft(CHAT, USER, tabId, scope)).toBe('')
      expect(getComposerDraftRevision(CHAT, USER, tabId, scope)).toBe(revisionBefore)
      expect(getLatestGfsConversationContext(scope)).toMatchObject({
        uri: U_URI,
        activationId,
      })
      expect(appTestActions.prefillEvents).toHaveLength(eventCountBefore)
      expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()

      targetResolve.resolve(await originalResolve(V_URI))
      await waitFor(() => expect(getLatestGfsConversationContext(scope)?.uri).toBe(V_URI))
      await waitFor(() => expect(input.value).toBe(V_URI))
      expect(getStoredComposerDraft(CHAT, USER, tabId, scope)).toBe(V_URI)
      expect(input.value.match(/gfs:\/\//g)).toHaveLength(1)
      expect(getComposerDraftRevision(CHAT, USER, tabId, scope)).toBe(revisionBefore + 1)
      expect(appTestActions.prefillEvents.slice(eventCountBefore)).toEqual(['resource-activation'])
      expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
    } finally {
      targetResolve.resolve(await originalResolve(V_URI))
      gfs.resolve.mockImplementation(originalResolve)
      await queryClient.cancelQueries()
      queryClient.clear()
      view.unmount()
    }
  })

  it('does not publish a cached Sidebar Preview before current-scope resolve', async () => {
    const { clerum, gfs, queryClient, view } = await setupApp()
    const deniedMessage = await resolveDeniedMessage(PREVIEW_URI)
    const listRefetchEntered = deferred<void>()
    const listRefetch = deferred<Awaited<ReturnType<typeof gfs.listChildren>>>()
    const previewResolve = deferred<Awaited<ReturnType<typeof gfs.resolve>>>()
    let previewResolveStarted = false
    const originalListChildren = gfs.listChildren.getMockImplementation()
    const originalResolve = gfs.resolve.getMockImplementation()
    if (!originalListChildren || !originalResolve) {
      throw new Error('Expected real Sidebar listing and current-scope resolver boundaries')
    }

    try {
      await openFolderU()
      const expandSidebar = screen.queryByRole('button', { name: 'Expand sidebar' })
      if (expandSidebar) fireEvent.click(expandSidebar)
      const filesExplorerToggle = screen.getByTestId('nav-files-explorer-toggle')
      if (filesExplorerToggle.getAttribute('aria-expanded') !== 'true') {
        fireEvent.click(filesExplorerToggle)
      }
      await waitFor(() =>
        expect(screen.getByTestId('nav-files-explorer-toggle').getAttribute('aria-expanded')).toBe(
          'true'
        )
      )
      const tree = await screen.findByRole('tree', { name: 'Shared files' })
      fireEvent.click(within(tree).getByRole('button', { name: 'Expand Folder U' }))
      await within(tree).findByRole('button', { name: 'Notes.md' })

      await openChatDrawer()
      const input = (await selectSidebarConversation()) as HTMLTextAreaElement
      await waitFor(() => expect(input.value).toBe(U_URI))
      fireEvent.change(input, { target: { value: '' } })
      await waitFor(() => expect(getStoredComposerDraft(CHAT, USER)).toBe(''))

      const scope = receiptProbe.scope
      const tabId = receiptProbe.tabId
      const activationId = getLatestGfsConversationContext(scope)?.activationId
      const revisionBefore = getComposerDraftRevision(CHAT, USER, tabId, scope)
      const eventCountBefore = appTestActions.prefillEvents.length
      gfs.listChildren.mockImplementation(async resourceId => {
        if (resourceId === U_ID) {
          listRefetchEntered.resolve()
          return listRefetch.promise
        }
        return originalListChildren(resourceId)
      })
      await act(async () => {
        focusManager.setFocused(false)
        focusManager.setFocused(true)
        await listRefetchEntered.promise
      })
      expect(within(tree).getByRole('button', { name: 'Notes.md' })).toBeTruthy()

      gfs.resolve.mockImplementation(async uri => {
        if (uri === PREVIEW_URI) {
          previewResolveStarted = true
          return previewResolve.promise
        }
        return originalResolve(uri)
      })
      fireEvent.click(within(tree).getByRole('button', { name: 'Notes.md' }))
      await act(async () => {
        await Promise.resolve()
        await new Promise(resolve => setTimeout(resolve, 0))
      })

      expect(input.value).toBe('')
      expect(getStoredComposerDraft(CHAT, USER, tabId, scope)).toBe('')
      expect(getComposerDraftRevision(CHAT, USER, tabId, scope)).toBe(revisionBefore)
      expect(getLatestGfsConversationContext(scope)).toMatchObject({
        uri: U_URI,
        activationId,
      })
      expect(gfs.resolve).toHaveBeenCalledWith(PREVIEW_URI)
      expect(appTestActions.prefillEvents).toHaveLength(eventCountBefore)
      expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()

      previewResolve.reject(new Error(deniedMessage))
      await act(async () => {
        await Promise.resolve()
        await new Promise(resolve => setTimeout(resolve, 0))
      })
      listRefetch.reject(new Error(deniedMessage))
      await waitFor(() =>
        expect(within(tree).queryByRole('button', { name: 'Notes.md' })).toBeNull()
      )
      expect(input.value).toBe('')
      expect(getStoredComposerDraft(CHAT, USER, tabId, scope)).toBe('')
      expect(getLatestGfsConversationContext(scope)).toBeNull()
      expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
      expect(
        document.querySelector('.toast-stack .toast.tone-error .toast-body')?.textContent
      ).toBe(describeGfsReadError(new Error(deniedMessage)).message)
    } finally {
      listRefetch.resolve(await originalListChildren(U_ID))
      if (previewResolveStarted) {
        previewResolve.reject(new Error(deniedMessage))
      }
      focusManager.setFocused(undefined)
      gfs.listChildren.mockImplementation(originalListChildren)
      gfs.resolve.mockImplementation(originalResolve)
      await queryClient.cancelQueries()
      queryClient.clear()
      view.unmount()
    }
  })

  it('does not publish a cached folder owner before its current child listing is authorized', async () => {
    const { clerum, gfs, queryClient, view } = await setupApp()
    const deniedMessage = await resolveDeniedMessage(V_URI)
    const listRefetchEntered = deferred<void>()
    const listRefetch = deferred<Awaited<ReturnType<typeof gfs.listChildren>>>()
    const originalListChildren = gfs.listChildren.getMockImplementation()
    if (!originalListChildren) throw new Error('Expected the real Files child-list boundary')
    let listRefetchStarted = false

    try {
      await openFolderU()
      await openChatDrawer()
      const input = (await selectSidebarConversation()) as HTMLTextAreaElement
      await waitFor(() => expect(input.value).toBe(U_URI))
      fireEvent.change(input, { target: { value: '' } })
      await waitFor(() => expect(getStoredComposerDraft(CHAT, USER)).toBe(''))

      const scope = receiptProbe.scope
      const tabId = receiptProbe.tabId
      const revisionBefore = getComposerDraftRevision(CHAT, USER, tabId, scope)
      const eventCountBefore = appTestActions.prefillEvents.length
      gfs.listChildren.mockImplementation(async resourceId => {
        if (resourceId === V_ID) {
          listRefetchStarted = true
          listRefetchEntered.resolve()
          return listRefetch.promise
        }
        return originalListChildren(resourceId)
      })

      await screen.findByRole('button', { name: 'Open Folder V' })
      await clickFileName('Folder V')
      await listRefetchEntered.promise
      await waitFor(() => expect(gfs.resolve).toHaveBeenCalledWith(V_URI))

      // The real cached row is actionable, but neither the route transition nor
      // the still-pending current-scope listing may publish it as an owner.
      expect(input.value).toBe('')
      expect(getStoredComposerDraft(CHAT, USER, tabId, scope)).toBe('')
      expect(getComposerDraftRevision(CHAT, USER, tabId, scope)).toBe(revisionBefore)
      expect(getLatestGfsConversationContext(scope)).toBeNull()
      expect(appTestActions.prefillEvents).toHaveLength(eventCountBefore)
      expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()

      await act(async () => {
        listRefetch.reject(new Error(deniedMessage))
        await Promise.resolve()
        await new Promise(resolve => setTimeout(resolve, 0))
      })
      await waitFor(() =>
        expect(
          document.querySelector('.toast-stack .toast.tone-error .toast-body')?.textContent
        ).toBe(describeGfsReadError(new Error(deniedMessage)).message)
      )
      expect(input.value).toBe('')
      expect(getStoredComposerDraft(CHAT, USER, tabId, scope)).toBe('')
      expect(getComposerDraftRevision(CHAT, USER, tabId, scope)).toBe(revisionBefore)
      expect(getLatestGfsConversationContext(scope)).toBeNull()
      expect(appTestActions.prefillEvents).toHaveLength(eventCountBefore)
      expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
    } finally {
      if (listRefetchStarted) {
        listRefetch.reject(new Error(deniedMessage))
      } else {
        listRefetch.resolve(await originalListChildren(V_ID))
      }
      gfs.listChildren.mockImplementation(originalListChildren)
      await queryClient.cancelQueries()
      queryClient.clear()
      view.unmount()
    }
  })

  it('does not publish a cached FilesPage Preview before current-scope resolve', async () => {
    const { clerum, gfs, queryClient, view } = await setupApp()
    const deniedMessage = await resolveDeniedMessage(PREVIEW_URI)
    const previewResolveEntered = deferred<void>()
    const previewResolve = deferred<Awaited<ReturnType<typeof gfs.resolve>>>()
    const originalResolve = gfs.resolve.getMockImplementation()
    if (!originalResolve) throw new Error('Expected the real FilesPage resolver boundary')
    let previewResolveStarted = false

    try {
      await openFolderU()
      await openChatDrawer()
      const selectedInput = (await selectSidebarConversation()) as HTMLTextAreaElement
      await waitFor(() => expect(selectedInput.value).toBe(U_URI))
      fireEvent.change(selectedInput, { target: { value: '' } })
      await waitFor(() => expect(getStoredComposerDraft(CHAT, USER)).toBe(''))

      const input = selectedInput
      await screen.findByRole('button', { name: 'Open Notes.md' })
      const scope = receiptProbe.scope
      const tabId = receiptProbe.tabId
      const revisionBefore = getComposerDraftRevision(CHAT, USER, tabId, scope)
      gfs.resolve.mockImplementation(async uri => {
        if (uri === PREVIEW_URI) {
          previewResolveStarted = true
          previewResolveEntered.resolve()
          return previewResolve.promise
        }
        return originalResolve(uri)
      })

      const ownerBeforeClick = getLatestGfsConversationContext()
      expect(ownerBeforeClick?.uri).toBe(U_URI)
      // The FilesPage row is backed by the real cached listing and remains
      // actionable while its click waits for the current-authority resolver.
      expect(screen.getByRole('button', { name: 'Open Notes.md' })).toBeTruthy()

      await clickFileName('Notes.md')
      await act(async () => {
        await Promise.resolve()
        await new Promise(resolve => setTimeout(resolve, 0))
      })

      // The cached row stays actionable while current authority resolves. Its
      // click must not publish the Preview owner before that check completes.
      expect(input.value).toBe('')
      expect(getStoredComposerDraft(CHAT, USER, tabId, scope)).toBe('')
      expect(getComposerDraftRevision(CHAT, USER, tabId, scope)).toBe(revisionBefore)
      expect(getLatestGfsConversationContext(scope)).toEqual(ownerBeforeClick)
      expect(gfs.resolve).toHaveBeenCalledWith(PREVIEW_URI)
      await previewResolveEntered.promise
      expect(previewResolveStarted).toBe(true)
      expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()

      await act(async () => {
        previewResolve.reject(new Error(deniedMessage))
        await Promise.resolve()
        await new Promise(resolve => setTimeout(resolve, 0))
      })
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Open Notes.md' })).toBeTruthy()
      )
      expect(input.value).toBe('')
      expect(getStoredComposerDraft(CHAT, USER, tabId, scope)).toBe('')
      expect(getComposerDraftRevision(CHAT, USER, tabId, scope)).toBe(revisionBefore)
      expect(getLatestGfsConversationContext(scope)).toEqual(ownerBeforeClick)
      expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
      expect(
        document.querySelector('.toast-stack .toast.tone-error .toast-body')?.textContent
      ).toBe(describeGfsReadError(new Error(deniedMessage)).message)
    } finally {
      if (!previewResolveStarted) {
        previewResolve.resolve(await originalResolve(PREVIEW_URI))
      } else {
        previewResolve.reject(new Error(deniedMessage))
      }
      gfs.resolve.mockImplementation(originalResolve)
      await queryClient.cancelQueries()
      queryClient.clear()
      view.unmount()
    }
  })

  it('routes a cached Sidebar Preview to Files when current resolve is not previewable', async () => {
    const { clerum, gfs, queryClient, view } = await setupApp()
    const currentFolder = await resolveResource(
      resolvedDirectory(PREVIEW_ID, 'Notes.md', {
        path: '/Folder U/Notes.md',
        parentResourceId: U_ID,
      })
    )
    const originalResolve = gfs.resolve.getMockImplementation()
    if (!originalResolve) throw new Error('Expected the real Sidebar resolver boundary')

    try {
      await openFolderU()
      const input = (await selectSidebarConversation()) as HTMLTextAreaElement
      await waitFor(() => expect(input.value).toBe(U_URI))
      fireEvent.change(input, { target: { value: '' } })
      await waitFor(() => expect(getStoredComposerDraft(CHAT, USER)).toBe(''))

      const filesExplorerToggle = screen.getByTestId('nav-files-explorer-toggle')
      if (filesExplorerToggle.getAttribute('aria-expanded') !== 'true') {
        fireEvent.click(filesExplorerToggle)
      }
      const tree = await screen.findByRole('tree', { name: 'Shared files' })
      fireEvent.click(within(tree).getByRole('button', { name: 'Expand Folder U' }))
      await within(tree).findByRole('button', { name: 'Notes.md' })
      gfs.resolve.mockImplementation(async uri =>
        uri === PREVIEW_URI ? currentFolder : originalResolve(uri)
      )

      await act(async () => {
        fireEvent.click(within(tree).getByRole('button', { name: 'Notes.md' }))
        await new Promise(resolve => setTimeout(resolve, 0))
      })

      expect(gfs.resolve).toHaveBeenCalledWith(PREVIEW_URI)
      expect(screen.queryByRole('heading', { name: 'Files' })).not.toBeNull()
      expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
    } finally {
      gfs.resolve.mockImplementation(originalResolve)
      await queryClient.cancelQueries()
      queryClient.clear()
      view.unmount()
    }
  })
})
