/**
 * #1043 — AgentStateMachine's pre-executor continuation model gate. The
 * checkpoint store is real SQLite; the LLM provider is the only transport
 * double. These tests prove the checkpoint pair wins over the live session
 * selection and that unsupported Hosts fail without running a model.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { config as appConfig } from '../../config'
import { ConversationManager } from '../../core/conversation/conversation'
import {
  type StoreHandle,
  makeSqliteStore,
} from '../../core/conversation/persistence/__tests__/testHelpers'
import { ModelStepCheckpointStore } from '../../core/conversation/persistence/modelStepCheckpointStore'
import { SqliteColdStartLoader } from '../../core/conversation/persistence/sqliteColdStartLoader'
import { LlmErrorCode } from '../../core/errors'
import { type ChatMessage, FinishReason } from '../../core/types'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import type { SingleTurnProvider } from '../../llm/types'
import { McpManager } from '../../mcp/manager'
import { MessageQueue } from '../../queue/messageQueue'
import type {
  ModelStepContinuationRef,
  Task,
  TaskError,
  TaskResponsePayload,
} from '../../queue/types'
import type { IncomingMessage } from '../../server/types'
import { sourceMessageForResume } from '../sourceMessageForResume'
import { AgentStateMachine } from '../stateMachine'
import {
  type ModelStepCheckpointExecutionSupport,
  TaskExecutor,
  resolveTaskSessionKey,
} from '../taskExecutor'
import type { ResolvedTaskModel } from '../types'

const USER = 'user-state-b2'
const AGENT = 'chatllm'
const CHAT = 'chat-state-b2'
const SESSION_KEY = `${USER}:rpc:${AGENT}:${CHAT}`
const NOW = 1_700_000_000_000
const RESUMABLE_TTL_MS = 7 * 24 * 3_600_000
const LEASE_MS = 300_000
const USAGE = { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
const PIN = { provider: 'zai', model: 'checkpoint-pinned-model' }

const handles: StoreHandle[] = []
const savedConfig = {
  enableApproval: appConfig.enableApproval,
  dynamicToolsEnabled: appConfig.dynamicToolsEnabled,
}

type ProviderWithCalls = SingleTurnProvider & { requests: ChatMessage[][]; calls: () => number }

function provider(type: string): ProviderWithCalls {
  let invocations = 0
  const requests: ChatMessage[][] = []
  return {
    requests,
    calls: () => invocations,
    getProviderType: () => type as never,
    classifyError: error => ({
      code: LlmErrorCode.ApiCallFailed,
      retryable: false,
      message: error instanceof Error ? error.message : String(error),
    }),
    completeSingleTurn: async () => {
      throw new Error('Unexpected tool-less completion')
    },
    completeSingleTurnWithTools: async (messages: ChatMessage[]) => {
      invocations += 1
      requests.push(messages)
      return {
        content: 'pinned continuation answer',
        tool_calls: [],
        usage: USAGE,
        finish_reason: FinishReason.Stop,
      }
    },
  }
}

function message(): IncomingMessage {
  return {
    sender: USER,
    content: 'Continue with the checkpoint model',
    channelType: 'rpc',
    channelId: AGENT,
    threadId: CHAT,
    messageId: 'message-state-b2',
    timestamp: new Date(NOW).toISOString(),
    hostRef: 'host-state-b2',
  }
}

function task(
  continuation: ModelStepContinuationRef,
  responseCallback?: (payload: TaskResponsePayload) => Promise<void>
): Task {
  return {
    id: 'task-continuation-state-b2',
    source: 'channel',
    sourceMessage: message(),
    traceContext: null,
    priority: 'normal',
    status: 'pending',
    createdAt: new Date(NOW),
    conversationHistory: [
      { role: 'user', content: 'Continue with the checkpoint model', timestamp: new Date(NOW) },
    ],
    responseCallback,
    modelStepContinuation: continuation,
  }
}

async function claimedCheckpoint(handle: StoreHandle, manager?: ConversationManager) {
  const checkpoints = new ModelStepCheckpointStore(handle.persistQueue, {
    now: () => NOW,
    blockedTtlMs: RESUMABLE_TTL_MS,
  })
  const conversationManager = manager ?? new ConversationManager(handle.store)
  const conversation = await conversationManager.getOrCreate(SESSION_KEY, {
    userId: USER,
    channelType: 'rpc',
    channelId: AGENT,
    threadId: CHAT,
    source: 'rpc',
  })
  await conversationManager.startTurn(conversation, message().content, 'task-origin-state-b2')
  await conversationManager.failTurn(conversation)
  const fence = await checkpoints.open(
    {
      checkpointId: 'checkpoint-state-b2',
      sessionKey: SESSION_KEY,
      originTurnNumber: 1,
      originTaskId: 'task-origin-state-b2',
      provider: PIN.provider,
      model: PIN.model,
      hostId: 'host-a',
      principal: USER,
      loopState: JSON.stringify({ nextIteration: 0, originUserMessageIndex: 0 }),
      taskBudget: JSON.stringify({
        elapsedActiveMs: 0,
        iterationsUsed: 0,
        durationMs: 300_000,
        maxIterations: 20,
        attachmentReadLedger: { reads: 0, spentTokens: 0, bytesRead: 0 },
      }),
      sourceMessage: JSON.stringify(message()),
    },
    [
      {
        kind: 'message',
        toolCallId: null,
        payload: JSON.stringify({ role: 'user', content: 'Continue with the checkpoint model' }),
      },
    ]
  )
  const resumable = await checkpoints.transition(SESSION_KEY, fence, {
    from: ['open'],
    to: 'resumable',
    failedAt: NOW,
    expiresAt: NOW + RESUMABLE_TTL_MS,
  })
  if (resumable === null) throw new Error('checkpoint fixture could not become resumable')
  const claim = await checkpoints.claim({
    sessionKey: SESSION_KEY,
    checkpointId: 'checkpoint-state-b2',
    version: resumable,
    hostInstanceId: 'host-instance-state-b2',
    newTaskId: 'task-continuation-state-b2',
    leaseMs: LEASE_MS,
  })
  if (claim.outcome !== 'claimed')
    throw new Error(`checkpoint fixture claim failed: ${claim.outcome}`)
  return { checkpoints, fence: claim.fence, taskBudget: claim.snapshot.header.task_budget }
}

function support(
  handle: StoreHandle,
  checkpoints: ModelStepCheckpointStore
): ModelStepCheckpointExecutionSupport {
  return {
    store: checkpoints,
    hostInstanceId: 'host-instance-state-b2',
    hostId: 'host-a',
    resumableTtlMs: RESUMABLE_TTL_MS,
    claimLeaseMs: LEASE_MS,
    pendingApprovalTtlMs: RESUMABLE_TTL_MS,
    attachmentTtlMs: 3_600_000,
  }
}

function agent(handle?: StoreHandle) {
  const lifecycle = new TaskLifecycle()
  const queue = new MessageQueue()
  queue.setLifecycle(lifecycle)
  const stateMachine = new AgentStateMachine(queue, lifecycle, {
    maxTaskDuration: 300_000,
    maxToolCallsPerTask: 20,
    autoStart: false,
    taskDelay: 0,
    approvalTimeout: 300_000,
  })
  if (handle) stateMachine.setConversationStore(handle.store)
  stateMachine.setMcpManager(new McpManager())
  return { stateMachine, lifecycle }
}

function delivered(responseCallback: ReturnType<typeof vi.fn>) {
  return responseCallback.mock.calls[0]?.[0] as { error?: TaskError; response?: string }
}

beforeEach(() => {
  Object.assign(appConfig, { enableApproval: false, dynamicToolsEnabled: false })
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
})

afterEach(async () => {
  Object.assign(appConfig, savedConfig)
  vi.restoreAllMocks()
  for (const handle of handles.splice(0)) await handle.shutdown()
})

describe('AgentStateMachine model-step continuation model pinning (#1043)', () => {
  it('blocks an unavailable pinned approval checkpoint and rehydrates the next session', async () => {
    Object.assign(appConfig, { enableApproval: true })
    const handle = makeSqliteStore()
    handles.push(handle)
    const manager = new ConversationManager(handle.store)
    const { checkpoints, fence, taskBudget } = await claimedCheckpoint(handle, manager)
    const badConversation = manager.getSessionByKey(SESSION_KEY)!
    await manager.resumeTurnForContinuation(badConversation, 'task-continuation-state-b2', 1, null)
    await manager.suspendForApproval(badConversation, {
      request_id: 'approval-unavailable',
      tool_name: 'shell_exec',
      tool_call_id: 'tc-unavailable',
      parameters: {},
      description: 'Unavailable model approval',
      context_snapshot: [{ role: 'user', content: message().content }],
      task_budget: JSON.parse(taskBudget!),
      sourceMessage: sourceMessageForResume(message()),
    })

    const healthyMessage = { ...message(), threadId: 'healthy-chat', messageId: 'healthy-message' }
    const healthySessionKey = `${USER}:rpc:${AGENT}:healthy-chat`
    const healthyConversation = await manager.getOrCreate(healthySessionKey, {
      userId: USER,
      channelType: 'rpc',
      channelId: AGENT,
      threadId: 'healthy-chat',
      source: 'rpc',
    })
    await manager.startTurn(healthyConversation, healthyMessage.content, 'healthy-task')
    await manager.suspendForApproval(healthyConversation, {
      request_id: 'approval-healthy',
      tool_name: 'shell_exec',
      tool_call_id: 'tc-healthy',
      parameters: {},
      description: 'Healthy session approval',
      context_snapshot: [{ role: 'user', content: healthyMessage.content }],
      task_budget: JSON.parse(taskBudget!),
      sourceMessage: sourceMessageForResume(healthyMessage),
    })

    const { stateMachine } = agent(handle)
    stateMachine.setLLMProvider(provider('openai') as never, 'host-default-model')
    stateMachine.setTaskModelResolver(() => null)
    stateMachine.setModelStepCheckpoints(support(handle, checkpoints))
    stateMachine.setColdStartLoader(new SqliteColdStartLoader(handle.store))

    await stateMachine.bootstrap()
    await handle.persistQueue.drain()

    expect(
      handle.worker.db
        .prepare(
          'SELECT status, blocked_reason FROM model_step_checkpoints WHERE checkpoint_id = ?'
        )
        .get(fence.checkpointId)
    ).toEqual({ status: 'blocked', blocked_reason: 'model_unavailable' })
    expect(stateMachine.getPendingApprovals().map(approval => approval.requestId)).toEqual([
      'approval-healthy',
    ])
    expect(badConversation.pending_approval).toBeUndefined()
    expect(healthyConversation.pending_approval?.request_id).toBe('approval-healthy')
  })

  it('rehydrates a waiting approval with the checkpoint model after Host takeover', async () => {
    Object.assign(appConfig, { enableApproval: true })
    const handle = makeSqliteStore()
    handles.push(handle)
    const manager = new ConversationManager(handle.store)
    const { checkpoints, fence, taskBudget } = await claimedCheckpoint(handle, manager)
    const call = {
      id: 'tc-cold-approval',
      name: 'shell_exec',
      arguments: { command: 'printf cold-approval' },
    }
    expect(
      await checkpoints.append(SESSION_KEY, fence, [
        {
          kind: 'message',
          toolCallId: null,
          payload: JSON.stringify({ role: 'assistant', content: null, tool_calls: [call] }),
        },
      ])
    ).toBe(true)
    const conversation = manager.getSessionByKey(SESSION_KEY)!
    await manager.resumeTurnForContinuation(conversation, 'task-continuation-state-b2', 1, null)
    await manager.suspendForApproval(conversation, {
      request_id: 'approval-cold-state',
      tool_name: 'shell_exec',
      tool_call_id: call.id,
      parameters: call.arguments,
      description: 'Approve the checkpoint tool',
      context_snapshot: [
        { role: 'user', content: message().content },
        { role: 'assistant', content: '', tool_calls: [call] },
      ],
      task_budget: JSON.parse(taskBudget!),
      sourceMessage: sourceMessageForResume(message()),
    })
    expect(await checkpoints.bootReap('host-instance-cold-state')).toEqual({
      abandoned: 0,
      reopened: 0,
    })

    const { stateMachine } = agent(handle)
    const defaultProvider = provider('openai')
    const pinnedProvider = provider(PIN.provider)
    stateMachine.setLLMProvider(defaultProvider as never, 'host-default-model')
    stateMachine.setTaskModelResolver(selections =>
      selections?.[PIN.provider] === PIN.model
        ? { provider: pinnedProvider, model: PIN.model, contextWindowTokens: 100_000 }
        : null
    )
    stateMachine.setModelStepCheckpoints({
      ...support(handle, checkpoints),
      hostInstanceId: 'host-instance-cold-state',
    })
    stateMachine.setColdStartLoader(new SqliteColdStartLoader(handle.store))
    await stateMachine.bootstrap()
    const resumeSpy = vi.spyOn(TaskExecutor.prototype, 'resumeAfterApproval')
    expect(
      await stateMachine.handleApproval(USER, 'approval-cold-state', true, 'rpc', AGENT)
    ).toEqual({ success: true })
    await resumeSpy.mock.results[0]!.value
    await handle.persistQueue.drain()

    expect(pinnedProvider.calls()).toBe(1)
    expect(defaultProvider.calls()).toBe(0)
    expect(
      handle.worker.db
        .prepare('SELECT status FROM model_step_checkpoints WHERE checkpoint_id = ?')
        .get(fence.checkpointId)
    ).toEqual({ status: 'completed' })
  })
  it('12. runs the checkpoint provider and model even when the session selected another pair', async () => {
    const handle = makeSqliteStore()
    handles.push(handle)
    const { stateMachine, lifecycle } = agent(handle)
    const manager = stateMachine.getConversationManager()
    const { checkpoints, fence, taskBudget } = await claimedCheckpoint(handle, manager)
    const defaultProvider = provider('openai')
    const sessionProvider = provider('openai')
    const pinnedProvider = provider(PIN.provider)
    stateMachine.setLLMProvider(defaultProvider as never, 'host-default-model')
    const resolverCalls: Array<Record<string, string> | undefined> = []
    stateMachine.setTaskModelResolver(selections => {
      resolverCalls.push(selections)
      if (selections?.[PIN.provider] === PIN.model) {
        return {
          provider: pinnedProvider,
          model: PIN.model,
          contextWindowTokens: 100_000,
        } satisfies ResolvedTaskModel
      }
      return {
        provider: sessionProvider,
        model: 'session-selected-model',
      } satisfies ResolvedTaskModel
    })
    stateMachine.setModelStepCheckpoints(support(handle, checkpoints))

    const conversation = await manager.getOrCreate(SESSION_KEY, {
      userId: USER,
      channelType: 'rpc',
      channelId: AGENT,
      threadId: CHAT,
      source: 'rpc',
    })
    manager.setModelSelection(conversation, 'openai', 'session-selected-model')

    const onVerdict = vi.fn()
    const responseCallback = vi.fn(async () => {})
    const continuationTask = task(
      {
        checkpointId: fence.checkpointId,
        originTaskId: 'task-origin-state-b2',
        originTurnNumber: 1,
        provider: PIN.provider,
        model: PIN.model,
        fence,
        confirmedResults: 0,
        taskBudget,
        onVerdict,
      },
      responseCallback
    )
    lifecycle.register(continuationTask)
    expect(resolveTaskSessionKey(continuationTask)).toBe(SESSION_KEY)
    expect(
      handle.worker.db
        .prepare(
          'SELECT session_key, status, claim_owner FROM model_step_checkpoints WHERE checkpoint_id = ?'
        )
        .get(fence.checkpointId)
    ).toEqual({
      session_key: SESSION_KEY,
      status: 'claimed',
      claim_owner: fence.owner,
    })
    const usageEvents: Array<{ provider: string; model: string }> = []
    stateMachine.setUsageReporter(
      {
        enqueue: (event: { provider: string; model: string }) => usageEvents.push(event),
      } as never,
      {
        host_ref: 'host-state-b2',
        context_ref: null,
        llm_secret_name: null,
      }
    )

    await stateMachine.executeTask(continuationTask)
    await handle.persistQueue.drain()

    expect(delivered(responseCallback).error).toBeUndefined()
    expect(delivered(responseCallback).response).toBe('pinned continuation answer')
    expect(resolverCalls).toEqual([{ [PIN.provider]: PIN.model }])
    expect(pinnedProvider.calls()).toBe(1)
    expect(sessionProvider.calls()).toBe(0)
    expect(defaultProvider.calls()).toBe(0)
    expect(usageEvents).toEqual([
      expect.objectContaining({ provider: PIN.provider, model: PIN.model }),
    ])
    expect(onVerdict).toHaveBeenCalledWith({ kind: 'started' })
    expect(delivered(responseCallback).response).toBe('pinned continuation answer')
    expect(
      handle.worker.db
        .prepare('SELECT status FROM model_step_checkpoints WHERE checkpoint_id = ?')
        .get(fence.checkpointId)
    ).toEqual({ status: 'completed' })
  })

  it('12. blocks model_unavailable when the pinned pair cannot be resolved', async () => {
    const handle = makeSqliteStore()
    handles.push(handle)
    const { checkpoints, fence, taskBudget } = await claimedCheckpoint(handle)
    const { stateMachine, lifecycle } = agent()
    const llm = provider('openai')
    stateMachine.setLLMProvider(llm as never, 'host-default-model')
    stateMachine.setTaskModelResolver(() => null)
    stateMachine.setModelStepCheckpoints(support(handle, checkpoints))
    const onVerdict = vi.fn()
    const responseCallback = vi.fn(async () => {})
    const continuationTask = task(
      {
        checkpointId: fence.checkpointId,
        originTaskId: 'task-origin-state-b2',
        originTurnNumber: 1,
        provider: PIN.provider,
        model: PIN.model,
        fence,
        confirmedResults: 0,
        taskBudget,
        onVerdict,
      },
      responseCallback
    )
    lifecycle.register(continuationTask)

    await stateMachine.executeTask(continuationTask)
    await handle.persistQueue.drain()

    expect(llm.calls()).toBe(0)
    expect(onVerdict).toHaveBeenCalledWith({
      kind: 'blocked',
      blockedReason: 'model_unavailable',
    })
    expect(delivered(responseCallback).error).toMatchObject({
      code: 'model_step_checkpoint_blocked',
      retryable: false,
      provider: PIN.provider,
    })
    expect(
      handle.worker.db
        .prepare(
          'SELECT status, blocked_reason FROM model_step_checkpoints WHERE checkpoint_id = ?'
        )
        .get(fence.checkpointId)
    ).toEqual({ status: 'blocked', blocked_reason: 'model_unavailable' })
  })

  it('12. emits lost when the Host has no model-step checkpoint support', async () => {
    const handle = makeSqliteStore()
    handles.push(handle)
    const { fence, taskBudget } = await claimedCheckpoint(handle)
    const { stateMachine, lifecycle } = agent()
    const llm = provider('openai')
    stateMachine.setLLMProvider(llm as never, 'host-default-model')
    const onVerdict = vi.fn()
    const responseCallback = vi.fn(async () => {})
    const continuationTask = task(
      {
        checkpointId: fence.checkpointId,
        originTaskId: 'task-origin-state-b2',
        originTurnNumber: 1,
        provider: PIN.provider,
        model: PIN.model,
        fence,
        confirmedResults: 0,
        taskBudget,
        onVerdict,
      },
      responseCallback
    )
    lifecycle.register(continuationTask)

    await stateMachine.executeTask(continuationTask)

    expect(llm.calls()).toBe(0)
    expect(onVerdict).toHaveBeenCalledWith({ kind: 'lost' })
    expect(delivered(responseCallback).error).toMatchObject({
      code: 'model_step_checkpoint_not_found',
      retryable: false,
      provider: PIN.provider,
    })
    expect(
      handle.worker.db
        .prepare('SELECT status FROM model_step_checkpoints WHERE checkpoint_id = ?')
        .get(fence.checkpointId)
    ).toEqual({ status: 'claimed' })
  })
})
