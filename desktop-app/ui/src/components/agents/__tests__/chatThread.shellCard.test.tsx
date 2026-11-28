// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskTracker, makeTaskKey } from '@contexts/AgentTaskTrackerContext'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { trackerStateToTaskProgress } from '@hooks/domain/trackerToProgress'
import { buildLoadedChatSemanticModels } from '../../../lib/chatMessageSemantics'
import {
  beginApprovalModeFirstSend,
  noteHostApprovalModeFromSession,
  resetHostApprovalModeStore,
} from '../../../lib/hostApprovalModeStore'
import type { AgentChatMessage, TaskProgress } from '../../../uiTypes'
import { ApprovalModePicker } from '../ApprovalModePicker'
import { ChatThread } from '../ChatThread'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const navigationValue = { selectedAgent: 'agent-x', handleSelectChatAgent: vi.fn() }
const notificationsValue: { decideApproval: ReturnType<typeof vi.fn> } = {
  decideApproval: vi.fn(),
}
const composerStateValue = {
  composerImageAttachments: [] as never[],
  composerReferenceAttachments: [] as never[],
  requestComposerFocus: vi.fn(),
}
const chatListValue = { chatList: [], chatListLoading: false, sessionStateByChatId: {} }
const actionsValue = {
  chatEndRef: { current: null },
  handleSelectChat: vi.fn(),
  handleRenameChat: vi.fn(),
  captureChatDeleteFence: vi.fn(async () => {
    throw new Error('no delete target')
  }),
  handleDeleteChat: vi.fn(),
}
const runtimeValue = { cancelTask: vi.fn() }

let userMessage: AgentChatMessage
let progressByMessageId: Record<string, TaskProgress>

vi.mock('@contexts/NavigationContext', () => ({ useNavigationContext: () => navigationValue }))
vi.mock('@contexts/NotificationsContext', () => ({
  useNotificationsContext: () => notificationsValue,
}))
vi.mock('@contexts/ChatComposerStateContext', () => ({
  useChatComposerStateContext: () => composerStateValue,
}))
vi.mock('@contexts/ChatListContext', () => ({ useChatListContext: () => chatListValue }))
vi.mock('@contexts/AgentChatActionsContext', () => ({
  useAgentChatActionsContext: () => actionsValue,
}))
vi.mock('@contexts/McpRuntimeContext', () => ({ useMcpRuntimeContext: () => runtimeValue }))
vi.mock('@contexts/ChatThreadStateContext', () => ({
  useChatThreadStateContext: () => ({
    activeMessages: [userMessage],
    groupedMessages: [{ role: 'user', items: [userMessage] }],
    chatMessagesLoading: false,
    hasOlderMessages: false,
    olderMessagesLoading: false,
    handleLoadOlderMessages: vi.fn(),
    activeChatId: 'chat-1',
    activityByMessageId: {},
    progressByMessageId,
    localSearchQuery: '',
    localSearchCurrentMatch: null,
    semanticModelsByMessageId: new Map(
      buildLoadedChatSemanticModels([userMessage]).map(model => [model.messageId, model])
    ),
  }),
}))
vi.mock('../InFlightAssistantPlaceholder', () => ({ InFlightAssistantPlaceholder: () => null }))
vi.mock('../NudgeArea', () => ({ NudgeArea: () => null }))
vi.mock('../ChatStateBadge', () => ({ ChatStateBadge: () => null }))
vi.mock('@components/MessageArtifactActions', () => ({ MessageArtifactActions: () => null }))

type ProgressHandler = (e: unknown) => void | Promise<void>

const shellCard = {
  channelCommandOffered: true,
  desktopCommandOffered: true,
}

async function deriveApprovalProgress(
  suspendedExtras: Record<string, unknown> = {}
): Promise<TaskProgress> {
  let handler: ProgressHandler | null = null
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    writable: true,
    value: {
      rpc: {
        subscribeTaskProgress: vi.fn(async (_h: string, _t: string, onEvent: ProgressHandler) => {
          handler = onEvent
          return async () => undefined
        }),
        getTaskResult: vi.fn(async () => ({ response: 'ok' })),
        cancelTask: vi.fn(async () => undefined),
      },
    },
  })
  const tracker = new TaskTracker()
  const key = makeTaskKey('agent-x', 'chat-1')
  tracker.start(key, 'task-1', 'msg-1')
  await Promise.resolve()
  if (!handler) throw new Error('no progress handler registered')
  const fire = handler as ProgressHandler
  await fire({
    type: 'suspended',
    data: {
      taskId: 'task-1',
      requestId: 'req-1',
      displayName: 'Shell',
      reason: 'approval_required',
      ...suspendedExtras,
    },
  })
  const state = tracker.get(key)
  if (!state) throw new Error('tracker produced no state')
  return trackerStateToTaskProgress(state)
}

beforeEach(() => {
  userMessage = { id: 'msg-1', role: 'user', content: 'hi', timestamp: 1 }
  progressByMessageId = {}
  notificationsValue.decideApproval = vi.fn().mockResolvedValue('ok')
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  resetHostApprovalModeStore()
  delete (window as { clerum?: unknown }).clerum
})

describe('ChatThread — auto shell card', () => {
  it.each([
    ['approval-shell-once-btn', 'once', 'Allow once'],
    ['approval-shell-command-btn', 'command', 'Allow this command'],
    ['approval-shell-always-btn', 'shell', 'Always allow shell'],
  ] as const)('%s sends shellAction %s', async (testId, action, label) => {
    progressByMessageId = {
      'msg-1': await deriveApprovalProgress({
        shellCard,
        inputPreview: { text: 'ls', truncated: false },
      }),
    }
    const { getByTestId } = render(<ChatThread />)
    const button = getByTestId(testId)
    expect(button.textContent).toBe(label)

    await act(async () => {
      fireEvent.click(button)
    })

    expect(notificationsValue.decideApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        agentRef: 'agent-x',
        chatId: 'chat-1',
        taskId: 'task-1',
        requestId: 'req-1',
        decision: 'approve',
        shellAction: action,
        source: 'in_chat',
      })
    )
  })

  it('Deny calls the deny path and does not send a shell action', async () => {
    progressByMessageId = {
      'msg-1': await deriveApprovalProgress({
        shellCard,
        inputPreview: { text: 'ls', truncated: false },
      }),
    }
    const { getByTestId } = render(<ChatThread />)

    await act(async () => {
      fireEvent.click(getByTestId('approval-deny-btn'))
    })

    expect(notificationsValue.decideApproval).toHaveBeenCalledTimes(1)
    const target = notificationsValue.decideApproval.mock.calls[0]![0] as {
      decision: string
      shellAction?: string
      alwaysApprove?: boolean
    }
    expect(target.decision).toBe('deny')
    expect(target.shellAction).toBeUndefined()
    expect(target.alwaysApprove).not.toBe(true)
  })

  it('hides Allow this command when desktopCommandOffered is false, even if a command is previewed', async () => {
    progressByMessageId = {
      'msg-1': await deriveApprovalProgress({
        shellCard: { channelCommandOffered: true, desktopCommandOffered: false },
        inputPreview: { text: 'ls -la', truncated: false },
      }),
    }
    const { getByTestId, queryByTestId, queryByText } = render(<ChatThread />)

    expect(queryByTestId('approval-shell-command-btn')).toBeNull()
    expect(queryByText('Allow this command')).toBeNull()
    expect(getByTestId('approval-shell-once-btn')).not.toBeNull()
    expect(getByTestId('approval-shell-always-btn')).not.toBeNull()
    expect(getByTestId('approval-deny-btn')).not.toBeNull()
  })

  it('does not offer Allow this command when the shell card has no preview', async () => {
    progressByMessageId = {
      'msg-1': await deriveApprovalProgress({
        shellCard: { channelCommandOffered: true, desktopCommandOffered: true },
      }),
    }
    const { queryByTestId, getByTestId } = render(<ChatThread />)

    expect(queryByTestId('approval-shell-command-btn')).toBeNull()
    expect(getByTestId('approval-shell-once-btn')).not.toBeNull()
  })

  it('does not offer Allow this command from a truncated or redacted preview', async () => {
    progressByMessageId = {
      'msg-1': await deriveApprovalProgress({
        shellCard: { channelCommandOffered: true, desktopCommandOffered: true },
        inputPreview: { text: 'echo [redacted]', truncated: true },
      }),
    }
    const { queryByTestId, getByTestId } = render(<ChatThread />)

    expect(queryByTestId('approval-shell-command-btn')).toBeNull()
    expect(getByTestId('approval-shell-once-btn')).not.toBeNull()
  })

  it("a card without shellCard shows today's buttons", async () => {
    progressByMessageId = { 'msg-1': await deriveApprovalProgress() }
    const { getByTestId, queryByTestId } = render(<ChatThread />)

    expect(getByTestId('approval-approve-btn').textContent).toBe('Approve')
    expect(getByTestId('approval-always-approve-btn').textContent).toBe('Always approve')
    expect(getByTestId('approval-deny-btn').textContent).toBe('Deny')
    expect(queryByTestId('approval-shell-once-btn')).toBeNull()
    expect(queryByTestId('approval-shell-command-btn')).toBeNull()
    expect(queryByTestId('approval-shell-always-btn')).toBeNull()
  })
})

describe('ApprovalModePicker', () => {
  const setApprovalMode = vi.fn()

  beforeEach(() => {
    setApprovalMode.mockReset()
    setApprovalMode.mockResolvedValue({
      approvalMode: 'allow_all',
      modeCeiling: 'allow_all',
      channelCap: 'allow_all',
      effectiveApprovalMode: 'allow_all',
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      writable: true,
      value: {
        rpc: {
          setApprovalMode,
          loadSessionMessages: vi.fn(),
        },
      },
    })
  })

  it('asks for confirmation before Allow all', async () => {
    noteHostApprovalModeFromSession('agent-x', 'chat-1', {
      approvalMode: 'manual',
      modeCeiling: 'allow_all',
      channelCap: 'allow_all',
      effectiveApprovalMode: 'manual',
      shellClassifierAvailable: true,
    })
    const { getByTestId, queryByTestId } = render(
      <ApprovalModePicker agentRef="agent-x" chatId="chat-1" />
    )

    fireEvent.click(getByTestId('approval-mode-picker'))
    fireEvent.click(getByTestId('approval-mode-option-allow-all'))

    expect(setApprovalMode).not.toHaveBeenCalled()
    expect(getByTestId('approval-mode-confirm-allow-all')).not.toBeNull()

    fireEvent.click(getByTestId('approval-mode-cancel-allow-all'))
    expect(setApprovalMode).not.toHaveBeenCalled()
    expect(queryByTestId('approval-mode-confirm-allow-all')).toBeNull()

    fireEvent.click(getByTestId('approval-mode-picker'))
    fireEvent.click(getByTestId('approval-mode-option-allow-all'))
    await act(async () => {
      fireEvent.click(getByTestId('approval-mode-confirm-allow-all'))
    })

    expect(setApprovalMode).toHaveBeenCalledTimes(1)
    expect(setApprovalMode).toHaveBeenCalledWith('agent-x', 'agent-x', 'chat-1', 'allow_all')
  })

  it('is disabled and closes its menu while the first send is in flight', async () => {
    const { getByTestId, queryByTestId } = render(
      <ApprovalModePicker agentRef="agent-x" chatId="chat-new" />
    )
    const trigger = getByTestId('approval-mode-picker')
    fireEvent.click(trigger)
    expect(getByTestId('approval-mode-option-manual')).not.toBeNull()

    let send!: ReturnType<typeof beginApprovalModeFirstSend>
    act(() => {
      send = beginApprovalModeFirstSend('agent-x', 'chat-new')
    })

    expect(trigger.getAttribute('aria-disabled')).toBe('true')
    expect(queryByTestId('approval-mode-option-manual')).toBeNull()
    fireEvent.click(trigger)
    expect(queryByTestId('approval-mode-option-manual')).toBeNull()
    expect(setApprovalMode).not.toHaveBeenCalled()

    act(() => {
      send.release()
    })
    expect(trigger.getAttribute('aria-disabled')).toBeNull()
    expect(queryByTestId('approval-mode-option-manual')).toBeNull()
    fireEvent.click(trigger)
    await act(async () => {
      fireEvent.click(getByTestId('approval-mode-option-auto'))
    })
    expect(setApprovalMode).toHaveBeenCalledWith('agent-x', 'agent-x', 'chat-new', 'auto')
  })

  it('closes an open Allow all confirmation when the first send starts', () => {
    const { getByTestId, queryByTestId } = render(
      <ApprovalModePicker agentRef="agent-x" chatId="chat-new" />
    )
    fireEvent.click(getByTestId('approval-mode-picker'))
    fireEvent.click(getByTestId('approval-mode-option-allow-all'))
    expect(getByTestId('approval-mode-confirm-allow-all')).not.toBeNull()

    act(() => {
      beginApprovalModeFirstSend('agent-x', 'chat-new')
    })

    expect(queryByTestId('approval-mode-confirm-allow-all')).toBeNull()
    expect(setApprovalMode).not.toHaveBeenCalled()
  })

  it('shows the shell note when the classifier is unavailable', () => {
    noteHostApprovalModeFromSession('agent-x', 'chat-1', {
      approvalMode: 'auto',
      modeCeiling: 'allow_all',
      channelCap: 'allow_all',
      effectiveApprovalMode: 'auto',
      shellClassifierAvailable: false,
    })
    const { getByTestId } = render(<ApprovalModePicker agentRef="agent-x" chatId="chat-1" />)

    expect(getByTestId('approval-mode-label').textContent).toBe('Auto-approve')
    expect(getByTestId('approval-mode-classifier-note').textContent).toBe(
      'shell always asks on this model'
    )
  })

  it('shows the save error when the mode write fails', async () => {
    setApprovalMode.mockRejectedValue(new Error('Set approval mode failed (500)'))
    noteHostApprovalModeFromSession('agent-x', 'chat-1', {
      approvalMode: 'manual',
      modeCeiling: 'allow_all',
      channelCap: 'allow_all',
      effectiveApprovalMode: 'manual',
      shellClassifierAvailable: true,
    })
    const { getByTestId, queryByTestId } = render(
      <ApprovalModePicker agentRef="agent-x" chatId="chat-1" />
    )

    fireEvent.click(getByTestId('approval-mode-picker'))
    await act(async () => {
      fireEvent.click(getByTestId('approval-mode-option-auto'))
    })

    expect(getByTestId('approval-mode-write-error').textContent).toBe(
      'The approval mode could not be saved.'
    )
    expect(queryByTestId('approval-mode-label')).toBeNull()
  })

  it('hides the shell note when the classifier is available', () => {
    noteHostApprovalModeFromSession('agent-x', 'chat-1', {
      approvalMode: 'auto',
      modeCeiling: 'allow_all',
      channelCap: 'allow_all',
      effectiveApprovalMode: 'auto',
      shellClassifierAvailable: true,
    })
    const { getByTestId, queryByTestId } = render(
      <ApprovalModePicker agentRef="agent-x" chatId="chat-1" />
    )

    expect(getByTestId('approval-mode-label').textContent).toBe('Auto-approve')
    expect(queryByTestId('approval-mode-classifier-note')).toBeNull()
  })
})
