// @vitest-environment jsdom
import { type ComponentProps, type ReactNode, StrictMode } from 'react'
import { type Mock, afterEach, describe, expect, it, vi } from 'vitest'
import { AgentTaskTrackerProvider } from '@contexts/AgentTaskTrackerContext'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import fc from 'fast-check'
import { installAppControllerClerum } from '@hooks/domain/__tests__/__fixtures__/appControllerHarness'
import {
  deferred,
  serverSessionMessages,
  serverSessions,
} from '@hooks/domain/__tests__/__fixtures__/catalogFixtures'
import { ipcHostAccessRevoked } from '@hooks/domain/__tests__/__fixtures__/ipcErrors'
import { getComposerDraft, resetComposerDraftStore } from '@lib/composerDraftStore'
import {
  clearLatestGfsConversationContext,
  getLatestGfsConversationContext,
} from '@lib/gfsConversationPrefill'
import { desktopQueryDefaults } from '@lib/queryClient'
import { App } from '@/App'
import {
  accessibleResource,
  affordancesResult,
  childView,
  heldAffordances,
  listAccessiblePage,
  listChildrenPage,
  resolveResource,
  resolvedDirectory,
  resolvedFile,
} from '@/gfs/__fixtures__/gfsProducerFixtures'

const drawerHeader = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }))
const receiptProbe = vi.hoisted(() => ({ ids: [] as number[], statuses: [] as string[] }))
const appTestActions = vi.hoisted(() => ({ holdHost: null as (() => Promise<void>) | null }))
vi.mock('@contexts/AgentChatProviders', async importOriginal => {
  const actual = await importOriginal<typeof import('@contexts/AgentChatProviders')>()
  const React = await import('react')
  const { AuthContext } = await import('@contexts/AuthContext')
  const { useNotificationsContext } = await import('@contexts/NotificationsContext')
  const { useChatComposerStateContext } = await import('@contexts/ChatComposerStateContext')
  const { useAgentChatActionsContext } = await import('@contexts/AgentChatActionsContext')
  const ReceiptProbe = () => {
    const { persistedConversationPrefillReceipt: receipt, workspaceChatTabId } =
      useChatComposerStateContext()
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
      'data-authority-scope': receipt?.authorityScope ?? '',
      'data-destination-tab-id': receipt?.destinationWorkspaceTabId ?? '',
      'data-authenticated': auth?.isAuthenticated ? 'true' : 'false',
      'data-team-id': auth?.me?.teamId ?? '',
    })
  }
  const HostHoldProbe = () => {
    const { handleRenameChatForAgent } = useAgentChatActionsContext()
    appTestActions.holdHost = () =>
      handleRenameChatForAgent('agent-a', 'chat-a', 'Trigger host access hold')
    return null
  }
  const ScopeChangeProbe = () => {
    const { handleOpenNotification } = useNotificationsContext()
    return React.createElement('div', null, [
      React.createElement(
        'button',
        {
          key: 'cross-team',
          type: 'button',
          'data-testid': 'open-cross-team-latest-chat',
          onClick: () =>
            void handleOpenNotification({
              id: 'cross-team-latest-chat',
              kind: 'assistant_reply',
              agentName: 'agent-a',
              teamId: 'team-2',
              text: 'Open the latest conversation in the new team',
              timestamp: 1,
              read: false,
            }),
        },
        'Open latest chat in another team'
      ),
    ])
  }
  return {
    ...actual,
    AgentChatProviders: ({
      children,
      ...props
    }: ComponentProps<typeof actual.AgentChatProviders>) =>
      React.createElement(actual.AgentChatProviders, {
        ...props,
        children: React.createElement(
          React.Fragment,
          null,
          React.createElement(ReceiptProbe),
          React.createElement(HostHoldProbe),
          React.createElement(ScopeChangeProbe),
          children
        ),
      }),
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
vi.mock('@components/agents/ChatThread', async () => {
  const { useChatListContext } = await import('@contexts/ChatListContext')
  return {
    ChatThread: () => {
      const { activeChatId } = useChatListContext()
      return <div data-testid="chat-thread-stub">{activeChatId ?? 'no-active-chat'}</div>
    },
  }
})
vi.mock('@components/agents/ChatStateBadge', () => ({ ChatStateBadge: () => null }))
vi.mock('@components/BootSplash', () => ({ BootSplash: () => null }))
vi.mock('@components/ChatLocalSearch', () => ({ ChatLocalSearch: () => null }))
vi.mock('@components/CommandPalette', () => ({ CommandPalette: () => null }))
vi.mock('@components/ConfirmDialog', () => ({ ConfirmDialog: () => null }))
vi.mock('@components/GfsImagePreview', () => ({ GfsImagePreview: () => null }))
vi.mock('@components/PluginConsentModal', () => ({ PluginConsentModal: () => null }))
vi.mock('@pages/AgentsPage', () => ({ AgentsPage: () => null }))
vi.mock('@pages/AuthPage', () => ({ AuthPage: () => <div>Auth screen</div> }))
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
const U_URI = `gfs://main/${U_ID}`
const V_URI = `gfs://main/${V_ID}`
const PREVIEW_URI = `gfs://main/${PREVIEW_ID}`

type Setup = Awaited<ReturnType<typeof setupApp>>
let cleanupClerum: (() => void) | null = null
let resizeCallbacks: Array<(width: number) => void> = []
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let activeGfs: Setup['gfs']

async function setupApp(
  sessions = [{ agent: USER, chatId: CHAT, title: 'Earlier chat' }],
  strict = false
) {
  receiptProbe.ids = []
  receiptProbe.statuses = []
  appTestActions.holdHost = null
  const { clerum } = installAppControllerClerum({ agentNames: [USER] })
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
  const rootPage = await listAccessiblePage([
    accessibleResource(U_ID, 'Folder U', 'directory', {
      path: '/Folder U',
      parentResourceId: null,
    }),
  ])
  const childPage = await listChildrenPage([
    childView(V_ID, 'Folder V', 'directory', {
      path: '/Folder U/Folder V',
      parentResourceId: U_ID,
    }),
    childView(PREVIEW_ID, 'Notes.md', 'file', {
      path: '/Folder U/Notes.md',
      parentResourceId: U_ID,
      bytes: 32,
    }),
  ])
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
        return resolvedFile(PREVIEW_ID, 'Notes.md', {
          path: '/Folder U/Notes.md',
          parentResourceId: U_ID,
          bytes: 32,
        })
      }
      throw new Error(`Unexpected GFS URI ${uri}`)
    }),
    affordances: vi.fn(async () => affordances),
    getUserNavigationGeneration: vi.fn(() => 0),
    advanceUserNavigationGeneration: vi.fn(() => 1),
    getPathForFile: vi.fn((file: File) => `/fixture/${file.name}`),
  }
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
  return { clerum, gfs, queryClient, view }
}

async function openFolderU() {
  fireEvent.click(screen.getByRole('button', { name: 'Files' }))
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
  const toggle = screen.getByRole('button', { name: 'Open chat drawer' })
  expect((toggle as HTMLButtonElement).disabled).toBe(false)
  fireEvent.click(toggle)
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
  clearLatestGfsConversationContext()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(window, 'matchMedia')
})

describe('r4 A6 real App persisted-conversation acceptance', () => {
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
      expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-origin')).toBe(
        'workspace-chat-tab'
      )
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
    expect(changedContext).toEqual({ uri: V_URI, sourceTabId: originalContext?.sourceTabId })

    fireEvent.click(screen.getByRole('button', { name: 'Open Earlier chat' }))
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
    expect(getLatestGfsConversationContext()).toEqual({ uri: U_URI, sourceTabId: ownerU })
    expect(activeGfs.listChildren).toHaveBeenCalledWith(U_ID, 'main', undefined)
    expect(activeGfs.listChildren).toHaveBeenCalledWith(V_ID, 'main', undefined)
  })

  it('RS10 does not wake a receipt from an equal URI published by another Files tab', async () => {
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
    expect(composer.value).toBe('')
    expect(getComposerDraft(targetChatId, USER)).toBe('')
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')).toBe(
      receiptId
    )
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-status')).toBe(
      'suspended-resource'
    )
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-source-tab-id')).toBe(
      capturedOwner
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

  it('B6 does not mint an activation from focus or passive Files publication', async () => {
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
    const sidebarSelection = screen.getByRole('button', { name: 'Open Earlier chat' })
    act(() => sidebarSelection.focus())
    await act(async () => {
      await Promise.resolve()
      await new Promise(resolve => setTimeout(resolve, 0))
    })

    expect(getLatestGfsConversationContext()).toMatchObject({ uri: V_URI })
    expect(screen.getByTestId('chat-thread-stub').textContent).toBe(CHAT)
    expect(getComposerDraft(CHAT, USER)).toBe('')
    expect(input.value).toBe('')
    expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
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
    expect(whileDetached).toEqual({ uri: U_URI, sourceTabId: beforeDetach?.sourceTabId })

    resizeAppTo(1200)
    await screen.findByRole('complementary', { name: 'Chat' })
    const remountedComposer = await screen.findByTestId('chat-input')
    expect(remountedComposer).not.toBe(composerBeforeDetach)
    expect(screen.getByTestId('chat-thread-stub').textContent).toBe(CHAT)
    expect(getLatestGfsConversationContext()).toEqual(whileDetached)
    expect((remountedComposer as HTMLTextAreaElement).value).toBe('')
    expect(getComposerDraft(CHAT, USER)).toBe('')
    expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
  })

  it('L1 first considers a held U receipt at V, then restores it across detach and remount', async () => {
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
    await waitFor(() =>
      expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-status')).toBe(
        'suspended-resource'
      )
    )
    expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).value).toBe('')
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')).toBe(
      receiptId
    )
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-resource-uri')).toBe(
      U_URI
    )
    expect(getLatestGfsConversationContext()?.uri).toBe(V_URI)
    expect(getComposerDraft(CHAT, USER)).toBe('')
    expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()

    resizeAppTo(700)
    await waitFor(() => expect(screen.queryByTestId('chat-input')).toBeNull())
    resizeAppTo(1200)
    const remounted = (await screen.findByTestId('chat-input')) as HTMLTextAreaElement
    expect(remounted.value).toBe('')
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')).toBe(
      receiptId
    )
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-status')).toBe(
      'suspended-resource'
    )

    await restoreFolderU()
    await waitFor(() => expect(remounted.value).toBe(U_URI))
    expect(getComposerDraft(CHAT, USER)).toBe(U_URI)
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')).toBe(
      receiptId
    )
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
    expect(getLatestGfsConversationContext()).toEqual(capturedU)
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
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')).toBe(
      receiptId
    )
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-status')).toBe(
      'consumed'
    )
    const receiptIndex = receiptProbe.ids.indexOf(Number(receiptId))
    expect(receiptIndex).toBeGreaterThanOrEqual(0)
    expect(receiptProbe.ids.slice(receiptIndex).every(id => id === Number(receiptId))).toBe(true)
    expect(getLatestGfsConversationContext()).toEqual(capturedU)
    expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
  })

  it('L9 preserves the existing once-only pair claim after clear, suspension, and remount', async () => {
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
    await waitFor(() => expect(remounted.value).toBe(''))
    expect(getComposerDraft(CHAT, USER)).toBe('')
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')).toBe(
      receiptId
    )
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
    await openFolderU()
    await openChatDrawer()
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')).toBe('')
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

  it('L3 restores an unattempted U receipt after the Composer remounts at V', async () => {
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
    expect(remounted.value).toBe('')
    expect(screen.getByTestId('chat-thread-stub').textContent).toBe(targetChatId)
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')).toBe(
      receiptId
    )
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-status')).toBe(
      'suspended-resource'
    )

    await restoreFolderU()
    expect(getLatestGfsConversationContext()).toEqual(capturedU)
    await waitFor(() => expect(remounted.value).toBe(U_URI))
    expect(getComposerDraft(targetChatId, USER)).toBe(U_URI)
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')).toBe(
      receiptId
    )
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-status')).toBe(
      'consumed'
    )
    expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
  })

  it('L11 manual drawer close/reopen preserves the suspended receipt without a new gesture', async () => {
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
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')).toBe(
      receiptId
    )
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-status')).toBe(
      'suspended-resource'
    )
    expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).value).toBe('')
    expect(getComposerDraft(targetChatId, USER)).toBe('')

    await restoreFolderU()
    await waitFor(() =>
      expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).value).toBe(U_URI)
    )
    expect(getComposerDraft(targetChatId, USER)).toBe(U_URI)
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')).toBe(
      receiptId
    )
    expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
  })

  it('L6 removes the exact chat workspace destination while Composer is detached', async () => {
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
    // The App still owns the selected conversation and reconciles a new tab
    // after the drawer becomes visible again. The close removed the old
    // destination while detached; this is not a new Sidebar activation.
    expect(
      within(screen.getByRole('toolbar', { name: 'Workspace tabs' }))
        .getByRole('button', { name: 'Target chat' })
        .getAttribute('aria-pressed')
    ).toBe('false')
    expect(screen.getByTestId('chat-thread-stub').textContent).toBe(targetChatId)
    expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).value).toBe('')
    expect(getComposerDraft(targetChatId, USER)).toBe('')
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-status')).toBe(
      'terminally-cancelled'
    )
    expect(screen.getByTestId('prefill-receipt-probe').getAttribute('data-receipt-id')).toBe(
      receiptId
    )
    expect(
      screen.getByTestId('prefill-receipt-probe').getAttribute('data-destination-tab-id')
    ).toBe(destinationId)
    expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
  })

  it('L8 fences a suspended receipt after the authenticated team scope changes', async () => {
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
    const teamBridge = clerum as unknown as {
      team: { switch: Mock<(...args: any[]) => any> }
    }
    expect(teamBridge.team.switch).toHaveBeenCalledWith('team-2')
    expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
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
    const { clerum } = await setupApp([{ agent: USER, chatId: CHAT, title: 'Earlier chat' }], true)
    await openFolderU()
    const composer = await selectSidebarConversation()
    await waitFor(() => expect((composer as HTMLTextAreaElement).value).toBe(U_URI))
    expect(getComposerDraft(CHAT, USER)).toBe(U_URI)
    expect(screen.getByTestId('chat-thread-stub').textContent).toBe(CHAT)
    expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
  })

  it('A6 checks generated real-App commands against an independent A4 draft/receipt oracle', async () => {
    const command = fc.record({
      kind: fc.constantFrom('select', 'focus', 'resource-v', 'resource-u', 'clear', 'type'),
      text: fc.constantFrom('typed text', '  '),
    })

    await fc.assert(
      fc.asyncProperty(fc.array(command, { minLength: 1, maxLength: 6 }), async commands => {
        const { clerum, queryClient, view } = await setupApp()
        const oracle = {
          resource: { uri: U_URI, sourceTabId: '' },
          receiptId: null as number | null,
          receiptResource: null as { uri: string; sourceTabId: string } | null,
          receiptStatus: 'none',
          draft: '',
          claims: new Set<string>(),
          insertions: [] as string[],
        }
        const assertQuiescentAgreement = async () => {
          await act(async () => {
            await Promise.resolve()
            await new Promise(resolve => setTimeout(resolve, 0))
            await Promise.resolve()
          })
          const probe = screen.getByTestId('prefill-receipt-probe')
          const input = screen.getByTestId('chat-input') as HTMLTextAreaElement
          expect(input.value).toBe(oracle.draft)
          expect(getComposerDraft(CHAT, USER)).toBe(oracle.draft)
          expect(screen.getByTestId('chat-thread-stub').textContent).toBe(CHAT)
          expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
          if (oracle.receiptId !== null) {
            expect(probe.getAttribute('data-receipt-id')).toBe(String(oracle.receiptId))
            expect(probe.getAttribute('data-receipt-status')).toBe(oracle.receiptStatus)
            expect(probe.getAttribute('data-resource-uri')).toBe(oracle.receiptResource?.uri)
            expect(probe.getAttribute('data-source-tab-id')).toBe(
              oracle.receiptResource?.sourceTabId
            )
          }
        }
        const qualifyingSelection = async () => {
          const previousId = oracle.receiptId
          fireEvent.click(screen.getByRole('button', { name: 'Open Earlier chat' }))
          await waitFor(() => {
            const probe = screen.getByTestId('prefill-receipt-probe')
            expect(Number(probe.getAttribute('data-receipt-id'))).not.toBe(previousId)
            expect(probe.getAttribute('data-receipt-status')).toBe('consumed')
          })
          const probe = screen.getByTestId('prefill-receipt-probe')
          oracle.receiptId = Number(probe.getAttribute('data-receipt-id'))
          oracle.receiptResource = { ...oracle.resource }
          oracle.receiptStatus = 'consumed'
          const claimKey = `${USER}\0${CHAT}\0${oracle.resource.uri}`
          if (!oracle.claims.has(claimKey)) {
            oracle.claims.add(claimKey) // A4 P1: claim before checking the draft.
            if (oracle.draft === '') {
              oracle.draft = oracle.resource.uri
              oracle.insertions.push(claimKey)
            }
          }
          await assertQuiescentAgreement()
        }

        try {
          await openFolderU()
          oracle.resource = { ...getLatestGfsConversationContext()! }
          await openChatDrawer()
          await qualifyingSelection()

          for (const next of commands) {
            if (next.kind === 'select') {
              await qualifyingSelection()
            } else if (next.kind === 'focus') {
              act(() => screen.getByRole('button', { name: 'Open Earlier chat' }).focus())
            } else if (next.kind === 'resource-v' && oracle.resource.uri !== V_URI) {
              await navigateIntoV()
              oracle.resource = { ...getLatestGfsConversationContext()! }
            } else if (next.kind === 'resource-u' && oracle.resource.uri !== U_URI) {
              await restoreFolderU()
              oracle.resource = { ...getLatestGfsConversationContext()! }
            } else if (next.kind === 'clear') {
              fireEvent.change(screen.getByTestId('chat-input'), { target: { value: '' } })
              oracle.draft = ''
            } else if (next.kind === 'type') {
              fireEvent.change(screen.getByTestId('chat-input'), {
                target: { value: next.text },
              })
              oracle.draft = next.text
            }
            await assertQuiescentAgreement()
          }

          expect(new Set(oracle.insertions).size).toBe(oracle.insertions.length)
          expect(oracle.receiptStatus).toBe('consumed')
          expect(getComposerDraft(CHAT, USER)).toBe(oracle.draft)
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
})
