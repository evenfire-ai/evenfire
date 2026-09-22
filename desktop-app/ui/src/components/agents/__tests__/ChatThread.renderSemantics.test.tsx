// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
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

describe('ChatThread error code labels', () => {
  function renderErrorLabel(errorCode: string, errorProvider?: string) {
    messages = [
      {
        id: `error-${errorCode}`,
        role: 'assistant',
        content: 'The agent stopped.',
        timestamp: 1,
        isError: true,
        errorCode,
        ...(errorProvider ? { errorProvider } : {}),
      },
    ]
    const { container } = render(<ChatThread />)
    const response = screen.getByTestId('agent-response')
    // Liveness witness: the message rendered as an error bubble.
    expect(response.classList.contains('chat-bubble--error')).toBe(true)
    return {
      label: container.querySelector('.error-bubble-label')?.textContent,
      text: response.textContent,
    }
  }

  it('labels a tool-call limit as "Too Many Tool Calls", not "Model Overloaded"', () => {
    const { label, text } = renderErrorLabel('LLM_TOOL_CALL_LIMIT_EXCEEDED')
    expect(label).toBe('Too Many Tool Calls')
    expect(text).not.toContain('Model Overloaded')
  })

  it('appends the provider that raised the tool-call limit to the label', () => {
    const { label } = renderErrorLabel('LLM_TOOL_CALL_LIMIT_EXCEEDED', 'codex-subscription')
    expect(label).toBe('Too Many Tool Calls · CODEX-SUBSCRIPTION')
  })

  it('labels a context length error as "Conversation Too Long"', () => {
    expect(renderErrorLabel('LLM_CONTEXT_LENGTH_EXCEEDED').label).toBe('Conversation Too Long')
  })

  it('still labels an overload as "Model Overloaded"', () => {
    expect(renderErrorLabel('LLM_MODEL_OVERLOADED').label).toBe('Model Overloaded')
  })

  it('keeps the generic "Error" label for an unknown code', () => {
    expect(renderErrorLabel('LLM_SOMETHING_UNMAPPED').label).toBe('Error')
  })
})

it('keeps generated files visible and downloadable on an interrupted error message', () => {
  messages = [
    {
      id: 'interrupted',
      role: 'assistant',
      content: 'Task interrupted',
      timestamp: 1,
      isError: true,
      errorCode: 'TASK_ITERATION_LIMIT',
      attachments: [
        {
          id: 'report',
          type: 'response_file',
          label: 'report.md',
          filename: 'report.md',
          mimeType: 'text/markdown',
          encoding: 'base64',
          dataBase64: 'IyByZXBvcnQ=',
        },
      ],
    },
  ]
  // Only the browser download boundary is replaced in this component test.
  const createObjectURL = vi.fn(() => 'blob:unit-download')
  const revokeObjectURL = vi.fn()
  const NativeURL = URL
  vi.stubGlobal(
    'URL',
    class extends NativeURL {
      static createObjectURL = createObjectURL
      static revokeObjectURL = revokeObjectURL
    }
  )
  const clicked: string[] = []
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement
  ) {
    clicked.push(this.download)
  })
  render(<ChatThread />)
  expect(screen.getByText('Task interrupted', { selector: '.error-bubble-message' })).toBeTruthy()
  expect(screen.getByTestId('agent-response').classList.contains('chat-bubble--error')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Download' }))
  expect(clicked).toEqual(['report.md'])
  expect(createObjectURL).toHaveBeenCalledWith(
    expect.objectContaining({ size: 8, type: 'text/markdown' })
  )
  expect(revokeObjectURL).toHaveBeenCalledWith('blob:unit-download')
  expect(screen.getByTestId('agent-response').classList.contains('chat-bubble--error')).toBe(true)
})
