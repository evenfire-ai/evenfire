// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskTracker, makeTaskKey } from '@contexts/AgentTaskTrackerContext'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { trackerStateToTaskProgress } from '@hooks/domain/trackerToProgress'
import { buildLoadedChatSemanticModels } from '../../../lib/chatMessageSemantics'
import type { AgentChatMessage, TaskProgress } from '../../../uiTypes'
import { ChatThread } from '../ChatThread'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The ChatThread renders its suspended `ProgressStepper` (Approve / Always approve /
// Deny) only for a `role: 'user'` group whose message id has an entry in
// `progressByMessageId`.
// The context values are mutated per-test; the mock factories read them lazily.
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

/**
 * The approval progress is DERIVED from the real producer — a live `TaskTracker`
 * fed the exact `suspended` stream event, then mapped through the production
 * `trackerStateToTaskProgress` — so the `progress.suspendedInfo` the ChatThread
 * renders has the real shape.
 */
type ProgressHandler = (e: unknown) => void | Promise<void>

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
  await Promise.resolve() // let subscribeTaskProgress register the handler
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
  delete (window as { clerum?: unknown }).clerum
})

describe('ChatThread — in-chat Always approve', () => {
  it('sends decision approve with alwaysApprove:true through the central decider', async () => {
    progressByMessageId = { 'msg-1': await deriveApprovalProgress() }
    const { getByTestId } = render(<ChatThread />)

    await act(async () => {
      fireEvent.click(getByTestId('approval-always-approve-btn'))
    })

    expect(notificationsValue.decideApproval).toHaveBeenCalledTimes(1)
    expect(notificationsValue.decideApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        agentRef: 'agent-x',
        chatId: 'chat-1',
        taskId: 'task-1',
        requestId: 'req-1',
        decision: 'approve',
        alwaysApprove: true,
        source: 'in_chat',
      })
    )
  })

  it('plain Approve does not ask the host to allowlist the tool', async () => {
    progressByMessageId = { 'msg-1': await deriveApprovalProgress() }
    const { getByTestId } = render(<ChatThread />)

    await act(async () => {
      fireEvent.click(getByTestId('approval-approve-btn'))
    })

    const target = notificationsValue.decideApproval.mock.calls[0]![0] as {
      decision: string
      alwaysApprove?: boolean
    }
    expect(target.decision).toBe('approve')
    expect(target.alwaysApprove).not.toBe(true)
  })

  it('a failed settlement re-enables Always approve for a retry', async () => {
    notificationsValue.decideApproval = vi.fn().mockResolvedValueOnce('failed')
    progressByMessageId = { 'msg-1': await deriveApprovalProgress() }
    const { getByTestId } = render(<ChatThread />)

    await act(async () => {
      fireEvent.click(getByTestId('approval-always-approve-btn'))
    })

    const btn = getByTestId('approval-always-approve-btn')
    expect(btn.hasAttribute('disabled')).toBe(false)
    expect(btn.textContent).toBe('Always approve')
  })

  it('hides Always approve when the suspension disallows it', async () => {
    progressByMessageId = {
      'msg-1': await deriveApprovalProgress({ alwaysApproveAllowed: false }),
    }
    const { getByTestId, queryByTestId } = render(<ChatThread />)

    expect(queryByTestId('approval-always-approve-btn')).toBeNull()
    expect(getByTestId('approval-approve-btn')).not.toBeNull()
  })
})
