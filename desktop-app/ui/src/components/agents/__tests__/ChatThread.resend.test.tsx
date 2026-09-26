// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { getComposerDraft, resetComposerDraftStore } from '@lib/composerDraftStore'
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
const addComposerImageAttachments = vi.fn()
const addComposerReferenceAttachments = vi.fn()
const actionsValue = {
  chatEndRef: { current: null },
  handleSelectChat: vi.fn(),
  handleRenameChat: vi.fn(),
  handleDeleteChat: vi.fn(),
  handleAddComposerImageAttachments: addComposerImageAttachments,
  handleAddComposerReferenceAttachments: addComposerReferenceAttachments,
}
const runtimeValue = { cancelTask: vi.fn() }
let messages: AgentChatMessage[] = []
let groupedMessages: Array<{ role: 'user' | 'assistant' | 'system'; items: AgentChatMessage[] }> =
  []

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
    groupedMessages,
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

const PNG_BASE64 = 'aGVsbG8='

function userMessageWithAttachments(): AgentChatMessage {
  return {
    id: 'user-1',
    role: 'user',
    content: 'Summarize the chart with the plugin',
    timestamp: 1,
    attachments: [
      {
        id: 'img-1',
        type: 'uploaded_file',
        label: 'chart.png',
        addedOrder: 0,
        filename: 'chart.png',
        mimeType: 'image/png',
        encoding: 'base64',
        dataBase64: PNG_BASE64,
        sizeBytes: 5,
      },
      {
        id: 'chip-plugin',
        type: 'plugin',
        label: 'profits/revenue',
        addedOrder: 1,
      },
    ],
  }
}

afterEach(() => {
  cleanup()
  messages = []
  groupedMessages = []
  resetComposerDraftStore()
  vi.clearAllMocks()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('ChatThread resend action (TASK-42)', () => {
  it('re-populates the composer draft and re-attaches files + plugin indicators from a user message', () => {
    const user = userMessageWithAttachments()
    messages = [user]
    groupedMessages = [{ role: 'user', items: [user] }]

    render(<ChatThread />)

    fireEvent.click(screen.getByRole('button', { name: 'Resend message' }))

    expect(getComposerDraft('chat-1')).toBe('Summarize the chart with the plugin')
    expect(addComposerImageAttachments).toHaveBeenCalledTimes(1)
    expect(addComposerImageAttachments.mock.calls[0]![0]).toEqual([
      expect.objectContaining({
        name: 'chart.png',
        mimeType: 'image/png',
        dataBase64: PNG_BASE64,
        sizeBytes: 5,
        previewDataUrl: `data:image/png;base64,${PNG_BASE64}`,
      }),
    ])
    expect(addComposerReferenceAttachments).toHaveBeenCalledTimes(1)
    expect(addComposerReferenceAttachments.mock.calls[0]![0]).toEqual([
      {
        id: 'plugin:profits:revenue',
        type: 'plugin',
        namespace: 'profits',
        name: 'revenue',
        label: 'revenue',
      },
    ])
  })

  it('resending from an assistant message re-issues the originating user prompt (text + attachments + indicators)', () => {
    const user = userMessageWithAttachments()
    const assistant: AgentChatMessage = {
      id: 'assistant-1',
      role: 'assistant',
      content: 'Here is the summary you asked for.',
      timestamp: 2,
      attachments: [
        {
          id: 'generated-1',
          type: 'response_file',
          label: 'summary.md',
          filename: 'summary.md',
          mimeType: 'text/markdown',
          encoding: 'base64',
          dataBase64: 'IyBzdW1tYXJ5',
        },
      ],
    }
    messages = [user, assistant]
    groupedMessages = [
      { role: 'user', items: [user] },
      { role: 'assistant', items: [assistant] },
    ]

    render(<ChatThread />)

    fireEvent.click(screen.getByRole('button', { name: 'Resend prompt' }))

    // The draft carries the USER prompt, not the assistant reply.
    expect(getComposerDraft('chat-1')).toBe('Summarize the chart with the plugin')
    expect(addComposerImageAttachments).toHaveBeenCalledTimes(1)
    expect(addComposerImageAttachments.mock.calls[0]![0]).toEqual([
      expect.objectContaining({ name: 'chart.png', dataBase64: PNG_BASE64 }),
    ])
    expect(addComposerReferenceAttachments).toHaveBeenCalledTimes(1)
    expect(addComposerReferenceAttachments.mock.calls[0]![0]).toEqual([
      expect.objectContaining({ type: 'plugin', namespace: 'profits', name: 'revenue' }),
    ])
  })

  it('hides the resend action on an assistant message with no preceding user prompt', () => {
    const assistant: AgentChatMessage = {
      id: 'assistant-only',
      role: 'assistant',
      content: 'A reply with no user turn before it.',
      timestamp: 1,
    }
    messages = [assistant]
    groupedMessages = [{ role: 'assistant', items: [assistant] }]

    render(<ChatThread />)

    expect(screen.queryByRole('button', { name: 'Resend prompt' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Resend message' })).toBeNull()
  })

  it('offers resend on an assistant error bubble (the most common retry case)', () => {
    const user = userMessageWithAttachments()
    const errorReply: AgentChatMessage = {
      id: 'assistant-error',
      role: 'assistant',
      content: 'LLM blew up',
      timestamp: 2,
      isError: true,
      errorCode: 'LLM_MODEL_OVERLOADED',
    }
    messages = [user, errorReply]
    groupedMessages = [
      { role: 'user', items: [user] },
      { role: 'assistant', items: [errorReply] },
    ]

    render(<ChatThread />)

    fireEvent.click(screen.getByRole('button', { name: 'Resend prompt' }))
    expect(getComposerDraft('chat-1')).toBe('Summarize the chart with the plugin')
    expect(addComposerImageAttachments).toHaveBeenCalledTimes(1)
  })
})
