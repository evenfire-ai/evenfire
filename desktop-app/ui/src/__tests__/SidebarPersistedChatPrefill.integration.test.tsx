// @vitest-environment jsdom
import { useEffect, useMemo, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentChatActionsProvider } from '@contexts/AgentChatActionsContext'
import type { AgentChatActionsContextValue } from '@contexts/AgentChatActionsContext'
import { AuthContext } from '@contexts/AuthContext'
import type { AuthContextValue } from '@contexts/AuthContext'
import { ChatComposerStateProvider } from '@contexts/ChatComposerStateContext'
import type { ChatComposerStateContextValue } from '@contexts/ChatComposerStateContext'
import { ChatListProvider } from '@contexts/ChatListContext'
import type { ChatListContextValue } from '@contexts/ChatListContext'
import { ChatThreadStateProvider } from '@contexts/ChatThreadStateContext'
import type { ChatThreadStateContextValue } from '@contexts/ChatThreadStateContext'
import { NavigationContext } from '@contexts/NavigationContext'
import type { NavigationContextValue } from '@contexts/NavigationContext'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SidebarNav } from '@components/SidebarNav'
import { ComposerPanel } from '@components/agents/ComposerPanel'
import { DESKTOP_ROUTES } from '@constants/navigation'
import type { LatestSidebarChatEntry } from '@hooks/domain/useAgentChatController'
import { useNavigationController } from '@hooks/domain/useNavigationController'
import { getComposerDraft, resetComposerDraftStore } from '@lib/composerDraftStore'
import { clearLatestGfsConversationContext } from '@lib/gfsConversationPrefill'
import { openChatTab } from '@lib/workspaceTabs'
import { resolveResource, resolvedFile } from '@/gfs/__fixtures__/gfsProducerFixtures'

vi.mock('@contexts/McpRuntimeContext', () => ({
  useMcpRuntimeContext: () => ({ hostRuntimeStatus: null, activeLlmProvider: null }),
}))
vi.mock('@hooks/domain/useAgentsDataController', () => ({
  useAgentsDataController: () => ({
    accessCatalog: { userId: 'user-1', teamId: 'team-1' },
    agentNames: ['agent-a'],
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}))
vi.mock('@hooks/domain/useContextsDataController', () => ({
  useContextsDataController: () => ({ sharedFilesByContext: {}, refreshSharedFiles: vi.fn() }),
}))
vi.mock('@hooks/domain/useMcpServersDataController', () => ({
  useMcpServersDataController: () => ({
    selectedAgentMcpServers: [],
    agentContextByName: {},
    refresh: vi.fn(),
  }),
}))
vi.mock('@hooks/useHostModels', () => ({
  useHostModels: () => ({
    data: null,
    imageInput: { state: 'unknown', reason: 'model_unknown' },
    imageBlockMessage: null,
    visualSendBlocked: false,
    state: 'loading',
    effectiveModel: null,
    pending: false,
    conflicted: false,
    saving: false,
    error: null,
    loadError: null,
    selectModel: vi.fn(async () => true),
    clearError: vi.fn(),
    refresh: vi.fn(async () => undefined),
  }),
}))
vi.mock('@hooks/useDesktopAppInfo', async importOriginal => ({
  ...(await importOriginal<typeof import('@hooks/useDesktopAppInfo')>()),
  useDesktopAppInfo: () => null,
}))
vi.mock('@components/agents/ChatStateBadge', () => ({ ChatStateBadge: () => null }))

const actions = {
  chatEndRef: { current: null },
  scrollChatToBottom: vi.fn(),
  handleCreateChat: vi.fn(async () => {}),
  handleRenameChat: vi.fn(async () => {}),
  handleRenameChatForAgent: vi.fn(async () => {}),
  captureChatDeleteFence: vi.fn(async () => ({
    agentRef: 'agent-a',
    fence: {
      version: 1 as const,
      authorityScope: { environmentKey: 'test', userId: 'user-1', teamId: 'team-1' },
      bindingGeneration: 0,
      sessionGeneration: 0,
    },
    hostAuthorityEpoch: 0,
  })),
  handleDeleteChat: vi.fn(async () => {}),
  handleDeleteChatForAgent: vi.fn(async () => {}),
  handleSelectChat: vi.fn(async () => {}),
  clearComposerSendError: vi.fn(),
  handleAddComposerImageAttachments: vi.fn(),
  handleUpdateComposerImageAttachment: vi.fn(),
  handleRemoveComposerImageAttachment: vi.fn(),
  handleAddComposerFiles: vi.fn(),
  handleRemoveComposerFileAttachment: vi.fn(),
  handleAddComposerReferenceAttachments: vi.fn(),
  handleRemoveComposerReferenceAttachment: vi.fn(),
  handleClearComposerAttachments: vi.fn(),
  handleSendAgentMessage: vi.fn(async () => {}),
  handleRetryFailedAgentSend: vi.fn(async () => {}),
  handleRecoverFailedAgentSend: vi.fn(),
  handleDiscardFailedAgentSend: vi.fn(),
} satisfies AgentChatActionsContextValue

const auth = {
  busy: false,
  me: { id: 'user-1', name: 'User', email: 'user@example.com', teamId: 'team-1' },
  handleLogout: vi.fn(async () => {}),
} as unknown as AuthContextValue

const threadState = {
  activeChatId: null,
  activeMessages: [],
  groupedMessages: [],
  chatMessagesLoading: false,
  hasOlderMessages: false,
  olderMessagesLoading: false,
  handleLoadOlderMessages: vi.fn(async () => {}),
  activityByMessageId: {},
  progressByMessageId: {},
  localSearchQuery: '',
  localSearchCurrentMatch: null,
  semanticModelsByMessageId: new Map(),
} satisfies ChatThreadStateContextValue

const session = {
  agentRef: 'agent-a',
  id: 'persisted-chat',
  title: 'Earlier chat',
  updatedAt: '2026-11-02T00:00:00.000Z',
  createdAt: '2026-11-02T00:00:00.000Z',
  messageCount: 0,
} as LatestSidebarChatEntry

function Harness({
  resource,
  sourceKind,
}: {
  resource: Awaited<ReturnType<typeof resolveResource>>
  sourceKind: 'files' | 'preview'
}) {
  const navigation = useNavigationController()
  const [navItem, setNavItem] = useState<NavigationContextValue['navItem']>(DESKTOP_ROUTES.files)
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null)
  const [activeChatId, setActiveChatId] = useState<string | null>(null)
  const chatList = useMemo<ChatListContextValue>(
    () => ({
      activeChatId,
      chatList: [],
      chatListLoading: false,
      latestChatSessions: [session],
      latestChatSessionsLoading: false,
      sessionStateByChatId: {},
      sessionStateByChatKey: {},
    }),
    [activeChatId]
  )
  const composerState = useMemo<ChatComposerStateContextValue>(
    () => ({
      activeChatId,
      workspaceChatTabId: activeChatId ? 'persisted-chat-tab' : null,
      composerImageAttachments: [],
      composerFileAttachments: [],
      composerFileRefusals: [],
      composerReferenceAttachments: [],
      agentSending: false,
      agentError: null,
      failedAgentSend: null,
      activeMessageCount: 0,
      composerFocusRequestId: 0,
      requestComposerFocus: vi.fn(),
    }),
    [activeChatId]
  )

  useEffect(() => {
    if (sourceKind === 'files') {
      navigation.openFilesSection(resource.gfsUri)
      return
    }
    navigation.openPreviewSection({
      gfsUri: resource.gfsUri,
      kind: 'markdown',
      name: resource.name,
      bytes: resource.bytes ?? 1,
      ...(resource.version !== undefined ? { version: resource.version } : {}),
    })
  }, [navigation.openFilesSection, navigation.openPreviewSection, resource, sourceKind])

  const navigationValue = useMemo<NavigationContextValue>(
    () => ({
      navItem,
      selectedAgent,
      selectedAgentRoute: 'mcp-servers',
      handleNavSelect: setNavItem,
      handleOpenAgentWorkspace: vi.fn(),
      handleSelectChatAgent: (agentRef, options) => {
        const chatId = options?.chatId ?? null
        setSelectedAgent(agentRef)
        setActiveChatId(chatId)
        setNavItem(DESKTOP_ROUTES.chat)
        if (chatId) {
          navigation.setWorkspaceTabs(state =>
            openChatTab(state, {
              id: 'persisted-chat-tab',
              agentRef,
              chatId,
              title: 'Earlier chat',
            })
          )
        }
      },
      handleBackToAgents: vi.fn(),
    }),
    [navItem, navigation.setWorkspaceTabs, selectedAgent]
  )

  const sidebarProps = {
    navItem,
    collapsed: false,
    activeSandboxUiApp: null,
    availableSandboxUiApps: [],
    onCollapsedChange: vi.fn(),
    onNewChat: vi.fn(),
    onOpenSandboxUiApp: vi.fn(),
    onSelect: setNavItem,
    onOpenFilesSection: vi.fn(),
    onOpenPreviewSection: vi.fn(),
    onGfsResourceAction: vi.fn(),
    pushToast: vi.fn(),
  }

  return (
    <AuthContext.Provider value={auth}>
      <NavigationContext.Provider value={navigationValue}>
        <AgentChatActionsProvider value={actions}>
          <ChatListProvider value={chatList}>
            <ChatComposerStateProvider value={composerState}>
              <ChatThreadStateProvider value={threadState}>
                <SidebarNav {...sidebarProps} />
                <ComposerPanel inline />
              </ChatThreadStateProvider>
            </ChatComposerStateProvider>
          </ChatListProvider>
        </AgentChatActionsProvider>
      </NavigationContext.Provider>
    </AuthContext.Provider>
  )
}

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'matchMedia')
  Reflect.deleteProperty(window, 'clerum')
  resetComposerDraftStore()
  clearLatestGfsConversationContext()
})

describe('sidebar persisted chat GFS prefill', () => {
  it.each(['files', 'preview'] as const)(
    'carries the active %s URI through the real sidebar session selection to the composer',
    async sourceKind => {
      const resource = await resolveResource(
        resolvedFile('0123456789abcdef0123456789abcdef', 'Quarterly report.md')
      )
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        value: () => ({
          matches: false,
          media: '(max-width: 900px)',
          onchange: null,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          addListener: vi.fn(),
          removeListener: vi.fn(),
          dispatchEvent: vi.fn(),
        }),
      })
      Object.defineProperty(window, 'clerum', {
        configurable: true,
        value: { workflows: { list: async () => ({ items: [], count: 0 }) } },
      })
      render(<Harness resource={resource} sourceKind={sourceKind} />)

      fireEvent.click(await screen.findByRole('button', { name: 'Open Earlier chat' }))

      const composer = await screen.findByTestId('chat-input')
      await waitFor(() => expect((composer as HTMLTextAreaElement).value).toBe(resource.gfsUri))
      expect(getComposerDraft('persisted-chat', 'agent-a', 'persisted-chat-tab')).toBe(
        resource.gfsUri
      )
      expect(actions.handleSendAgentMessage).not.toHaveBeenCalled()
    }
  )
})
