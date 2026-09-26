// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  getComposerDraft,
  resetComposerDraftStore,
  setComposerDraft,
} from '@lib/composerDraftStore'
import { buildLoadedChatSemanticModels } from '../../../lib/chatMessageSemantics'
import type { AgentChatMessage, ComposerImageAttachment } from '../../../uiTypes'
import { ChatThread } from '../ChatThread'

const navigationValue = { selectedAgent: 'agent-x', handleSelectChatAgent: vi.fn() }
const pushToast = vi.fn()
const notificationsValue = { decideApproval: vi.fn(), pushToast }
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
const requestComposerFocus = vi.fn()
const composerStateValue = {
  composerImageAttachments: [] as ComposerImageAttachment[],
  composerReferenceAttachments: [] as never[],
}
let messages: AgentChatMessage[] = []
let groupedMessages: Array<{ role: 'user' | 'assistant' | 'system'; items: AgentChatMessage[] }> =
  []

vi.mock('@contexts/NavigationContext', () => ({
  useNavigationContext: () => navigationValue,
}))
vi.mock('@contexts/NotificationsContext', () => ({
  useNotificationsContext: () => notificationsValue,
}))
vi.mock('@contexts/ChatComposerStateContext', () => ({
  useChatComposerStateContext: () => ({
    composerImageAttachments: composerStateValue.composerImageAttachments,
    composerReferenceAttachments: composerStateValue.composerReferenceAttachments,
    requestComposerFocus,
  }),
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

function renderWithUserMessage(user: AgentChatMessage) {
  messages = [user]
  groupedMessages = [{ role: 'user', items: [user] }]
  render(<ChatThread />)
}

afterEach(() => {
  cleanup()
  messages = []
  groupedMessages = []
  composerStateValue.composerImageAttachments = []
  composerStateValue.composerReferenceAttachments = []
  resetComposerDraftStore()
  vi.clearAllMocks()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('ChatThread resend action (TASK-42)', () => {
  it('re-populates the composer draft and re-attaches files + plugin indicators from a user message', () => {
    renderWithUserMessage(userMessageWithAttachments())

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
    // A long-thread user must notice the repopulated composer.
    expect(requestComposerFocus).toHaveBeenCalledTimes(1)
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
    expect(requestComposerFocus).toHaveBeenCalledTimes(1)
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

  describe('dirty-composer contract (PR #859 review: refuse like handleRecoverFailedAgentSend)', () => {
    it('refuses with an error toast when the composer holds draft text', () => {
      setComposerDraft('chat-1', 'a half-written draft')
      renderWithUserMessage(userMessageWithAttachments())

      fireEvent.click(screen.getByRole('button', { name: 'Resend message' }))

      expect(pushToast).toHaveBeenCalledTimes(1)
      expect(pushToast.mock.calls[0]![0]).toBe(
        'Keep or clear the current draft before resending this message.'
      )
      expect(pushToast.mock.calls[0]![1]).toBe('error')
      // The dirty draft is untouched and nothing was populated.
      expect(getComposerDraft('chat-1')).toBe('a half-written draft')
      expect(addComposerImageAttachments).not.toHaveBeenCalled()
      expect(addComposerReferenceAttachments).not.toHaveBeenCalled()
      expect(requestComposerFocus).not.toHaveBeenCalled()
    })

    it('refuses with an error toast when the composer holds pending attachments', () => {
      composerStateValue.composerImageAttachments = [
        {
          id: 'pending-1',
          name: 'already-there.png',
          mimeType: 'image/png',
          dataBase64: 'cGVuZGluZw==',
          sizeBytes: 7,
          previewDataUrl: 'data:image/png;base64,cGVuZGluZw==',
        },
      ]
      renderWithUserMessage(userMessageWithAttachments())

      fireEvent.click(screen.getByRole('button', { name: 'Resend message' }))

      expect(pushToast).toHaveBeenCalledTimes(1)
      expect(pushToast.mock.calls[0]![1]).toBe('error')
      expect(addComposerImageAttachments).not.toHaveBeenCalled()
      expect(addComposerReferenceAttachments).not.toHaveBeenCalled()
      expect(requestComposerFocus).not.toHaveBeenCalled()
    })
  })

  it("surfaces a warn toast when original attachments can't be restored (PR #859 review)", () => {
    const user: AgentChatMessage = {
      id: 'user-legacy',
      role: 'user',
      content: 'Analyze these',
      timestamp: 1,
      attachments: [
        { id: 'legacy-1', type: 'uploaded_file', label: 'old-shot.png', addedOrder: 0 },
        { id: 'legacy-2', type: 'uploaded_file', label: 'older-shot.png', addedOrder: 1 },
      ],
    }
    renderWithUserMessage(user)

    fireEvent.click(screen.getByRole('button', { name: 'Resend message' }))

    // The resend itself still happens (text restored, focus nudged)…
    expect(getComposerDraft('chat-1')).toBe('Analyze these')
    expect(requestComposerFocus).toHaveBeenCalledTimes(1)
    expect(addComposerImageAttachments).not.toHaveBeenCalled()
    // …but the loss is reported, not silent.
    expect(pushToast).toHaveBeenCalledTimes(1)
    expect(pushToast.mock.calls[0]![0]).toBe(
      "2 attachments from the original message couldn't be restored."
    )
    expect(pushToast.mock.calls[0]![1]).toBe('warn')
  })
})
