// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { buildLoadedChatSemanticModels } from '../../../lib/chatMessageSemantics'
import type { AgentChatMessage } from '../../../uiTypes'
import { ChatThread } from '../ChatThread'

const navigationValue = { selectedAgent: 'agent-x', handleSelectChatAgent: vi.fn() }
const notificationsValue = { decideApproval: vi.fn() }
const chatListValue = {
  chatList: [],
  chatListLoading: false,
  sessionStateByChatId: {},
}
const actionsValue = {
  chatEndRef: { current: null },
  handleSelectChat: vi.fn(),
  handleRenameChat: vi.fn(),
  handleDeleteChat: vi.fn(),
}
const runtimeValue = { cancelTask: vi.fn() }
let messages: AgentChatMessage[] = []

vi.mock('@contexts/NavigationContext', () => ({
  useNavigationContext: () => navigationValue,
}))
vi.mock('@contexts/NotificationsContext', () => ({
  useNotificationsContext: () => notificationsValue,
}))
vi.mock('@contexts/ChatListContext', () => ({
  useChatListContext: () => chatListValue,
}))
vi.mock('@contexts/AgentChatActionsContext', () => ({
  useAgentChatActionsContext: () => actionsValue,
}))
vi.mock('@contexts/McpRuntimeContext', () => ({
  useMcpRuntimeContext: () => runtimeValue,
}))
vi.mock('@contexts/ChatThreadStateContext', () => ({
  useChatThreadStateContext: () => ({
    activeMessages: messages,
    groupedMessages: [{ role: 'assistant', items: messages }],
    chatMessagesLoading: false,
    hasOlderMessages: false,
    olderMessagesLoading: false,
    handleLoadOlderMessages: vi.fn(),
    activeChatId: 'chat-1',
    activityByMessageId: {},
    progressByMessageId: {},
    localSearchQuery: '',
    localSearchCurrentMatch: null,
    semanticModelsByMessageId: new Map(
      buildLoadedChatSemanticModels(messages).map(model => [model.messageId, model])
    ),
  }),
}))
vi.mock('../InFlightAssistantPlaceholder', () => ({ InFlightAssistantPlaceholder: () => null }))
vi.mock('../NudgeArea', () => ({ NudgeArea: () => null }))
vi.mock('../ChatStateBadge', () => ({ ChatStateBadge: () => null }))
vi.mock('@components/MessageArtifactActions', () => ({ MessageArtifactActions: () => null }))

afterEach(() => {
  cleanup()
  messages = []
  vi.clearAllMocks()
})

describe('ChatThread semantic renderer compatibility', () => {
  it('keeps the compact error preview when local search is closed', () => {
    const content = 'x'.repeat(220)
    messages = [
      {
        id: 'error-1',
        role: 'assistant',
        content,
        timestamp: 1,
        isError: true,
      },
    ]

    const { container } = render(<ChatThread />)

    expect(container.querySelector('.error-bubble-message')?.textContent).toBe(
      `${content.slice(0, 177)}...`
    )
    expect(container.querySelector('.error-bubble-details-text')?.textContent).toBe(content)
  })
})
