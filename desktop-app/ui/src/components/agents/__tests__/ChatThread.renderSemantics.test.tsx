// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { buildLoadedChatSemanticModels } from '../../../lib/chatMessageSemantics'
import { installAntdDomEnvironment } from '../../../test/antdDomEnvironment'
import type { AgentChatMessage } from '../../../uiTypes'
import { ChatThread } from '../ChatThread'

const navigationValue = { selectedAgent: 'agent-x', handleSelectChatAgent: vi.fn() }
const notificationsValue = { decideApproval: vi.fn(), pushToast: vi.fn() }
const composerStateValue = {
  composerImageAttachments: [] as never[],
  composerReferenceAttachments: [] as never[],
  requestComposerFocus: vi.fn(),
}
const chatListValue = {
  chatList: [] as Array<{ id: string; title: string; updatedAt: string }>,
  chatListLoading: false,
  sessionStateByChatId: {},
}
const actionsValue = {
  chatEndRef: { current: null },
  handleSelectChat: vi.fn(),
  handleRenameChat: vi.fn(),
  captureChatDeleteFence: vi.fn(
    async (): Promise<{ agentRef: string; fence: never; hostAuthorityEpoch: number }> => {
      throw new Error('no delete target')
    }
  ),
  handleDeleteChat: vi.fn(),
}
const runtimeValue = { cancelTask: vi.fn() }
let messages: AgentChatMessage[] = []
let activeChatId: string | null = 'chat-1'

vi.mock('@contexts/NavigationContext', () => ({
  useNavigationContext: () => navigationValue,
}))
vi.mock('@contexts/NotificationsContext', () => ({
  useNotificationsContext: () => notificationsValue,
}))
vi.mock('@contexts/ChatComposerStateContext', () => ({
  useChatComposerStateContext: () => composerStateValue,
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
    activeChatId,
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

beforeEach(installAntdDomEnvironment)

afterEach(() => {
  cleanup()
  messages = []
  activeChatId = 'chat-1'
  chatListValue.chatList = []
  vi.clearAllMocks()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('ChatThread session actions', () => {
  const deletion = { agentRef: 'agent-x', fence: {} as never, hostAuthorityEpoch: 1 }

  beforeEach(() => {
    activeChatId = null
    chatListValue.chatList = [
      { id: 'chat-2', title: 'Existing session', updatedAt: '2026-10-27T12:00:00.000Z' },
    ]
  })

  it('keeps the rename action available through the Ant Design dropdown and input', async () => {
    render(<ChatThread />)

    const actionButton = screen.getByRole('button', {
      name: 'Session actions for Existing session',
    })
    expect(actionButton.getAttribute('aria-haspopup')).toBe('menu')
    expect(actionButton.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(actionButton)
    expect(actionButton.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }))

    const input = await screen.findByRole('textbox', { name: 'Rename session' })
    fireEvent.change(input, { target: { value: 'Renamed session' } })
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', charCode: 13 })

    expect(actionsValue.handleRenameChat).toHaveBeenCalledWith('chat-2', 'Renamed session')
  })

  it('keeps deletion behind the existing fence and Ant Design confirmation modal', async () => {
    actionsValue.captureChatDeleteFence.mockResolvedValueOnce(deletion)
    render(<ChatThread />)

    const actionButton = screen.getByRole('button', {
      name: 'Session actions for Existing session',
    })
    fireEvent.click(actionButton)
    expect(actionButton.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }))

    expect(actionsValue.captureChatDeleteFence).toHaveBeenCalledWith('agent-x')
    expect(await screen.findByRole('dialog')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(actionsValue.handleDeleteChat).toHaveBeenCalledWith('chat-2', deletion)
  })
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
    // Liveness witness: Ant Design Alert renders the error with alert semantics.
    expect(screen.getByRole('alert')).toBeTruthy()
    return {
      label: container.querySelector('.ant-alert-message')?.textContent,
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

  // The label is keyed by error code and the provider is appended generically,
  // so a second provider reaching the same code needs no renderer change. This
  // asserts that claim instead of assuming it.
  it('labels the Grok tool-call limit with the same copy and its own provider', () => {
    const { label, text } = renderErrorLabel('LLM_TOOL_CALL_LIMIT_EXCEEDED', 'grok-subscription')
    expect(label).toBe('Too Many Tool Calls · GROK-SUBSCRIPTION')
    expect(text).not.toContain('Model Overloaded')
  })

  // The subscription proxies refuse a tool call whose arguments are not a JSON
  // object with `invalid_tool_arguments`, which the Host maps to this code.
  it('labels an invalid model response as "Invalid Model Response", not a connection error', () => {
    const { label, text } = renderErrorLabel('LLM_INVALID_RESPONSE', 'codex-subscription')
    expect(label).toBe('Invalid Model Response · CODEX-SUBSCRIPTION')
    expect(text).not.toContain('Connection Error')
  })

  it('labels a stream duration cap as "Response Took Too Long", not "Model Overloaded"', () => {
    const { label, text } = renderErrorLabel('LLM_STREAM_DURATION_EXCEEDED', 'grok-subscription')
    expect(label).toBe('Response Took Too Long · GROK-SUBSCRIPTION')
    expect(text).not.toContain('Model Overloaded')
  })

  it('labels a context length error as "Conversation Too Long"', () => {
    expect(renderErrorLabel('LLM_CONTEXT_LENGTH_EXCEEDED').label).toBe('Conversation Too Long')
  })

  it('still labels an overload as "Model Overloaded"', () => {
    expect(renderErrorLabel('LLM_MODEL_OVERLOADED').label).toBe('Model Overloaded')
  })

  // G1-8 (#720): the Host reports a control plane that did not answer with its
  // own code, so the user does not read it as a model or network failure.
  it('labels a control-plane outage as "Control Plane Unavailable"', () => {
    const { label, text } = renderErrorLabel('LLM_CONTROL_PLANE_UNAVAILABLE', 'codex-subscription')
    expect(label).toBe('Control Plane Unavailable · CODEX-SUBSCRIPTION')
    expect(text).not.toContain('Model Overloaded')
    expect(text).not.toContain('Connection Error')
  })

  // Review round 2 L12 (#720): an upstream 4xx is a refusal, not a network
  // failure, so it no longer shares "Connection Error" with LLM_API_CALL_FAILED.
  it('labels an upstream rejection as "Provider Rejected Request"', () => {
    const { label, text } = renderErrorLabel('LLM_UPSTREAM_REJECTED', 'grok-subscription')
    expect(label).toBe('Provider Rejected Request · GROK-SUBSCRIPTION')
    expect(text).not.toContain('Connection Error')
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
  expect(screen.getByRole('alert')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Download' }))
  expect(clicked).toEqual(['report.md'])
  expect(createObjectURL).toHaveBeenCalledWith(
    expect.objectContaining({ size: 8, type: 'text/markdown' })
  )
  expect(revokeObjectURL).toHaveBeenCalledWith('blob:unit-download')
  expect(screen.getByRole('alert')).toBeTruthy()
})
