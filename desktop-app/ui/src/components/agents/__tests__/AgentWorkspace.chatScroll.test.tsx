// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentChatActionsProvider } from '@contexts/AgentChatActionsContext'
import { ChatListProvider } from '@contexts/ChatListContext'
import { ChatThreadStateProvider } from '@contexts/ChatThreadStateContext'
import { McpRuntimeProvider } from '@contexts/McpRuntimeContext'
import { NavigationContext } from '@contexts/NavigationContext'
import { NotificationsContext } from '@contexts/NotificationsContext'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { createRoot } from 'react-dom/client'
import { useChatScroll } from '@hooks/domain/useChatScroll'
import { buildLoadedChatSemanticModels } from '@lib/chatMessageSemantics'
import type { AgentChatMessage } from '../../../uiTypes'
import { AgentWorkspace } from '../AgentWorkspace'

vi.mock('@hooks/domain/useAgentsDataController', () => ({
  useAgentsDataController: () => ({ agentNames: ['agent-x'] }),
}))
vi.mock('@hooks/domain/useContextsDataController', () => ({
  useContextsDataController: () => ({ accessCatalog: null }),
}))
vi.mock('@hooks/domain/useTeamsDataController', () => ({
  useTeamsDataController: () => ({
    teams: [],
    currentTeamId: '',
    teamMembers: [],
    teamDirectory: {},
    ensureHydrated: vi.fn(async () => undefined),
  }),
}))
vi.mock('@contexts/AuthContext', () => ({
  useAuthContext: () => ({ me: null }),
}))
vi.mock('@hooks/domain/useMcpServersDataController', () => ({
  useMcpServersDataController: () => ({
    agentContextByName: {},
    // AgentWorkspace reads agentDisplayByName for the visible agent name
    // (R1-M3); the mock must supply it or the display lookup dereferences
    // undefined.
    agentDisplayByName: {},
    selectedAgentMcpServers: [],
  }),
}))
vi.mock('../ComposerPanel', () => ({ ComposerPanel: () => null }))
vi.mock('../ContextWindowIndicator', () => ({ ContextWindowIndicator: () => null }))
vi.mock('../InFlightAssistantPlaceholder', () => ({ InFlightAssistantPlaceholder: () => null }))
vi.mock('../NudgeArea', () => ({ NudgeArea: () => null }))
vi.mock('../ChatStateBadge', () => ({ ChatStateBadge: () => null }))
vi.mock('@components/MessageArtifactActions', () => ({ MessageArtifactActions: () => null }))

const actEnvGlobal = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
actEnvGlobal.IS_REACT_ACT_ENVIRONMENT = true

const baseMessages: AgentChatMessage[] = [
  { id: 'a-user', role: 'user', content: 'First message', timestamp: 1 },
  { id: 'a-assistant', role: 'assistant', content: 'Latest message', timestamp: 2 },
]

function ChatActionsProvider({
  activeChatId,
  messages,
  chatMessagesLoading,
  children,
}: {
  activeChatId: string
  messages: AgentChatMessage[]
  chatMessagesLoading: boolean
  children: ReactNode
}) {
  const { chatEndRef, scrollChatToBottom } = useChatScroll({
    selectedAgent: 'agent-x',
    activeChatId,
    chatMessages: messages,
    chatMessagesLoading,
    agentSending: false,
    activeChatProgress: {},
  })

  return (
    <AgentChatActionsProvider
      value={
        {
          chatEndRef,
          scrollChatToBottom,
          clearComposerSendError: vi.fn(),
          handleAddComposerImageAttachments: vi.fn(),
          handleAddComposerReferenceAttachments: vi.fn(),
          handleCreateChat: vi.fn(),
          handleDeleteChat: vi.fn(),
          handleDeleteChatForAgent: vi.fn(),
          handleRemoveComposerImageAttachment: vi.fn(),
          handleRemoveComposerReferenceAttachment: vi.fn(),
          handleRenameChat: vi.fn(),
          handleRenameChatForAgent: vi.fn(),
          handleRetryFailedAgentSend: vi.fn(),
          handleSelectChat: vi.fn(),
          handleSendAgentMessage: vi.fn(),
          handleUpdateComposerImageAttachment: vi.fn(),
        } as never
      }
    >
      {children}
    </AgentChatActionsProvider>
  )
}

function WorkspaceHarness({
  activeChatId,
  messages = baseMessages,
  chatMessagesLoading = false,
}: {
  activeChatId: string
  messages?: AgentChatMessage[]
  chatMessagesLoading?: boolean
}) {
  const groupedMessages = messages.reduce<
    Array<{ role: 'user' | 'assistant' | 'system'; items: AgentChatMessage[] }>
  >((groups, message) => {
    const previous = groups.at(-1)
    if (previous?.role === message.role) previous.items.push(message)
    else groups.push({ role: message.role, items: [message] })
    return groups
  }, [])

  return (
    <NavigationContext.Provider
      value={
        {
          navItem: 'agents',
          selectedAgent: 'agent-x',
          selectedAgentRoute: 'details',
          selectedContext: null,
          selectedTeam: null,
          handleNavSelect: vi.fn(),
          handleOpenAgentWorkspace: vi.fn(),
          handleSelectChatAgent: vi.fn(),
          handleBackToAgents: vi.fn(),
          handleOpenContextDetails: vi.fn(),
          handleBackToContexts: vi.fn(),
          handleOpenTeamDetails: vi.fn(),
          handleBackToTeams: vi.fn(),
        } as never
      }
    >
      <McpRuntimeProvider
        value={{
          hostRuntimeStatus: null,
          hostRuntimeLoading: false,
          hostRuntimeError: null,
          hostRuntimeLastUpdatedAt: null,
          hostRuntimeIsStale: false,
          activeLlmModel: null,
          activeLlmProvider: null,
          mcpHealthRefreshing: false,
          handleRefreshMcpHealth: vi.fn(),
          cancelTask: vi.fn(),
        }}
      >
        <NotificationsContext.Provider
          value={
            {
              notifications: [],
              unreadNotificationCount: 0,
              notificationActionById: {},
              pendingApprovals: [],
              pendingApprovalsLoading: false,
              pendingApprovalActionId: null,
              toasts: [],
              markNotificationsRead: vi.fn(),
              clearNotifications: vi.fn(),
              removeNotification: vi.fn(),
              resolveApprovalNotification: vi.fn(),
              decideApproval: vi.fn(),
              handleOpenNotification: vi.fn(),
              handleApproveNotification: vi.fn(),
              handleDenyNotification: vi.fn(),
              handleRefreshPendingApprovals: vi.fn(),
              handleDecidePendingApproval: vi.fn(),
            } as never
          }
        >
          <ChatListProvider
            value={{
              activeChatId,
              chatList: [],
              chatListLoading: false,
              latestChatSessions: [],
              latestChatSessionsLoading: false,
              sessionStateByChatId: {},
              sessionStateByChatKey: {},
            }}
          >
            <ChatThreadStateProvider
              value={{
                activeChatId,
                activeMessages: messages,
                groupedMessages,
                chatMessagesLoading,
                hasOlderMessages: false,
                olderMessagesLoading: false,
                handleLoadOlderMessages: vi.fn(),
                activityByMessageId: {},
                progressByMessageId: {},
                localSearchQuery: '',
                localSearchCurrentMatch: null,
                semanticModelsByMessageId: new Map(
                  buildLoadedChatSemanticModels(messages).map(model => [model.messageId, model])
                ),
              }}
            >
              <ChatActionsProvider
                activeChatId={activeChatId}
                messages={messages}
                chatMessagesLoading={chatMessagesLoading}
              >
                <AgentWorkspace mode="chat" scrollContainerRef={{ current: null }} />
              </ChatActionsProvider>
            </ChatThreadStateProvider>
          </ChatListProvider>
        </NotificationsContext.Provider>
      </McpRuntimeProvider>
    </NavigationContext.Provider>
  )
}

function setScrollableThread(scrollTop = 0) {
  const thread = screen.getByTestId('message-list')
  let position = scrollTop
  Object.defineProperties(thread, {
    clientHeight: { configurable: true, value: 200 },
    scrollHeight: { configurable: true, value: 800 },
    scrollTop: {
      configurable: true,
      get: () => position,
      set: (value: number) => {
        position = value
      },
    },
  })
  return {
    thread,
    getScrollTop: () => position,
    setScrollTop: (value: number) => (position = value),
  }
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.clearAllMocks()
})

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  })
})

describe('AgentWorkspace chat scroll control', () => {
  it('delays the control for each chat and never carries A visibility into B', async () => {
    vi.useFakeTimers()
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const previousActEnvironment = actEnvGlobal.IS_REACT_ACT_ENVIRONMENT
    actEnvGlobal.IS_REACT_ACT_ENVIRONMENT = false
    try {
      flushSync(() => root.render(<WorkspaceHarness activeChatId="chat-a" />))
      const { thread } = setScrollableThread()

      fireEvent.scroll(thread)
      expect(screen.queryByRole('button', { name: 'Scroll to latest messages' })).toBeNull()
      await advance(249)
      expect(screen.queryByRole('button', { name: 'Scroll to latest messages' })).toBeNull()
      await advance(1)
      expect(screen.getByRole('button', { name: 'Scroll to latest messages' })).toBeTruthy()

      flushSync(() => root.render(<WorkspaceHarness activeChatId="chat-b" />))
      expect(
        within(container).queryByRole('button', { name: 'Scroll to latest messages' })
      ).toBeNull()

      const { thread: chatBThread } = setScrollableThread()
      fireEvent.scroll(chatBThread)
      await advance(249)
      expect(screen.queryByRole('button', { name: 'Scroll to latest messages' })).toBeNull()
      await advance(1)
      expect(screen.getByRole('button', { name: 'Scroll to latest messages' })).toBeTruthy()
    } finally {
      flushSync(() => root.unmount())
      container.remove()
      actEnvGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
    }
  })

  it('cancels an A timer before it can make the control visible in B', async () => {
    vi.useFakeTimers()
    const view = render(<WorkspaceHarness activeChatId="chat-a" />)
    const { thread } = setScrollableThread()

    fireEvent.scroll(thread)
    await advance(100)
    view.rerender(<WorkspaceHarness activeChatId="chat-b" />)
    await advance(300)

    expect(screen.queryByRole('button', { name: 'Scroll to latest messages' })).toBeNull()
  })

  it('cancels before the delay when returning to latest and scrolls the rendered thread on click', async () => {
    vi.useFakeTimers()
    const view = render(<WorkspaceHarness activeChatId="chat-a" />)
    const { thread, getScrollTop, setScrollTop } = setScrollableThread()

    fireEvent.scroll(thread)
    setScrollTop(600)
    fireEvent.scroll(thread)
    await advance(300)
    expect(screen.queryByRole('button', { name: 'Scroll to latest messages' })).toBeNull()

    setScrollTop(0)
    fireEvent.scroll(thread)
    await advance(250)
    fireEvent.click(screen.getByRole('button', { name: 'Scroll to latest messages' }))
    await advance(100)

    expect(getScrollTop()).toBe(800)
    view.unmount()
  })

  it('opens both cached and hydrated provider transcripts at their latest rendered message', async () => {
    vi.useFakeTimers()
    const cachedView = render(<WorkspaceHarness activeChatId="cached-chat" />)
    const cachedThread = setScrollableThread()
    await advance(100)
    expect(cachedThread.getScrollTop()).toBe(800)
    cachedView.unmount()

    const remoteView = render(
      <WorkspaceHarness activeChatId="remote-chat" messages={[]} chatMessagesLoading />
    )
    const remoteThread = setScrollableThread()
    remoteThread.setScrollTop(0)
    remoteView.rerender(
      <WorkspaceHarness
        activeChatId="remote-chat"
        messages={baseMessages}
        chatMessagesLoading={false}
      />
    )
    await advance(100)

    expect(remoteThread.getScrollTop()).toBe(800)
  })

  it('keeps a reader at older history when provider messages append', async () => {
    vi.useFakeTimers()
    const view = render(<WorkspaceHarness activeChatId="chat-a" />)
    const thread = setScrollableThread()
    await advance(200)
    thread.setScrollTop(0)

    view.rerender(
      <WorkspaceHarness
        activeChatId="chat-a"
        messages={[
          ...baseMessages,
          { id: 'new-assistant', role: 'assistant', content: 'New reply', timestamp: 3 },
        ]}
      />
    )
    await advance(100)

    expect(thread.getScrollTop()).toBe(0)
  })
})
