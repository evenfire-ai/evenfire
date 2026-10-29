// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskTracker, makeTaskKey } from '@contexts/AgentTaskTrackerContext'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { trackerStateToTaskProgress } from '@hooks/domain/trackerToProgress'
import { buildLoadedChatSemanticModels } from '../../../lib/chatMessageSemantics'
import type { AgentChatMessage, TaskProgress } from '../../../uiTypes'
import { ChatThread } from '../ChatThread'
import { accessCatalogFromWire } from './__fixtures__/accessCatalog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The ChatThread renders its suspended `ProgressStepper` (the Connect button) only
// for a `role: 'user'` group whose message id has an entry in `progressByMessageId`.
// The context values are mutated per-test; the mock factories read them lazily.
const navigationValue = { selectedAgent: 'agent-x', handleSelectChatAgent: vi.fn() }
const notificationsValue = { decideApproval: vi.fn(), pushToast: vi.fn() }
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
const placeholderProps = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }))
vi.mock('../InFlightAssistantPlaceholder', () => ({
  InFlightAssistantPlaceholder: (props: Record<string, unknown>) => {
    placeholderProps.last = props
    return null
  },
}))
vi.mock('../NudgeArea', () => ({ NudgeArea: () => null }))
vi.mock('../ChatStateBadge', () => ({ ChatStateBadge: () => null }))
vi.mock('@components/MessageArtifactActions', () => ({ MessageArtifactActions: () => null }))

/**
 * T1: the `connect_required` progress is DERIVED from the real producer — a live
 * `TaskTracker` fed the exact `suspended` stream event, then mapped through the
 * production `trackerStateToTaskProgress` — NOT a hand-built literal. So the
 * `progress.suspendedInfo` the ChatThread renders has the real shape.
 */
type ProgressHandler = (e: unknown) => void | Promise<void>

async function deriveConnectRequiredProgress(): Promise<TaskProgress> {
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
        connectMcpServer,
      },
    },
  })
  const tracker = new TaskTracker()
  const key = makeTaskKey('agent-x', 'chat-1')
  tracker.start(key, 'task-1', 'msg-1')
  await Promise.resolve() // let subscribeTaskProgress register the handler
  if (!handler) throw new Error('no progress handler registered')
  // `handler` is reassigned inside a closure, so TS won't narrow the null away
  // after the guard above — the runtime throw already made it non-null.
  const fire = handler as ProgressHandler
  await fire({
    type: 'suspended',
    data: {
      taskId: 'task-1',
      requestId: 'req-1',
      displayName: 'monday tool',
      reason: 'connect_required',
      mcpServerName: 'monday',
    },
  })
  const state = tracker.get(key)
  if (!state) throw new Error('tracker produced no state')
  return trackerStateToTaskProgress(state)
}

let connectMcpServer: ReturnType<typeof vi.fn>

beforeEach(() => {
  connectMcpServer = vi.fn(() => Promise.reject(new Error('403 not a member')))
  userMessage = { id: 'msg-1', role: 'user', content: 'hi', timestamp: 1 }
  progressByMessageId = {}
  placeholderProps.last = null
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  delete (window as { clerum?: unknown }).clerum
})

describe('ChatThread — connect failure (R4-L1)', () => {
  it('catches a rejecting connectMcpServer from the in-chat Connect button (no unhandled rejection)', async () => {
    progressByMessageId = { 'msg-1': await deriveConnectRequiredProgress() }
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const { getByTestId } = render(<ChatThread />)

    const btn = getByTestId('connect-mcp-btn')
    await act(async () => {
      fireEvent.click(btn)
      // Let the rejected connect promise settle so the call-site `.catch` runs.
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(connectMcpServer).toHaveBeenCalledWith('monday', 'agent-x', undefined)
    // The rejection is handled by the ChatThread call-site `.catch` — it does NOT
    // float as an unhandled rejection. Its observable is the error log; revert the
    // `.catch` to `void connectMcpServer(...)` and this assertion goes red.
    expect(errSpy).toHaveBeenCalledWith(
      '[connect] connectMcpServer failed',
      expect.objectContaining({ mcpServerName: 'monday' })
    )
    errSpy.mockRestore()
  })
})

// A `grantScope: context` connector is authorized against a Context, and the
// McpServer no longer names one, so the chat must send the Context of the Host it
// is chatting with or control-api rejects the authorize-url request.
describe('ChatThread — Connect sends the agent Host Context', () => {
  it('passes the selected agent context (from the access catalog) as contextId', async () => {
    const catalog = await accessCatalogFromWire([
      { name: 'agent-x', contextRef: 'ctx-sales' },
      { name: 'agent-y', contextRef: 'ctx-ops' },
    ])
    progressByMessageId = { 'msg-1': await deriveConnectRequiredProgress() }
    connectMcpServer.mockImplementation(() => Promise.resolve())

    const { getByTestId } = render(<ChatThread agentContextByName={catalog.agentContextByName} />)
    await act(async () => {
      fireEvent.click(getByTestId('connect-mcp-btn'))
      await Promise.resolve()
    })

    expect(connectMcpServer).toHaveBeenCalledTimes(1)
    expect(connectMcpServer).toHaveBeenCalledWith('monday', 'agent-x', 'ctx-sales')
  })

  it('sends no contextId when the agent Host has no Context', async () => {
    const catalog = await accessCatalogFromWire([{ name: 'agent-x', contextRef: null }])
    progressByMessageId = { 'msg-1': await deriveConnectRequiredProgress() }
    connectMcpServer.mockImplementation(() => Promise.resolve())

    const { getByTestId } = render(<ChatThread agentContextByName={catalog.agentContextByName} />)
    await act(async () => {
      fireEvent.click(getByTestId('connect-mcp-btn'))
      await Promise.resolve()
    })

    expect(connectMcpServer).toHaveBeenCalledWith('monday', 'agent-x', undefined)
  })

  it('hands the access catalog context map to the in-flight placeholder', async () => {
    const catalog = await accessCatalogFromWire([{ name: 'agent-x', contextRef: 'ctx-sales' }])

    render(<ChatThread agentContextByName={catalog.agentContextByName} />)

    expect(placeholderProps.last?.agentContextByName).toEqual({ 'agent-x': 'ctx-sales' })
  })
})
