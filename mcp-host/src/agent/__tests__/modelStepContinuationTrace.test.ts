import { afterEach, describe, expect, it, vi } from 'vitest'
import { config } from '../../config'
import { ConversationManager } from '../../core/conversation/conversation'
import {
  type StoreHandle,
  makeSqliteStore,
} from '../../core/conversation/persistence/__tests__/testHelpers'
import { ModelStepCheckpointStore } from '../../core/conversation/persistence/modelStepCheckpointStore'
import { LlmErrorCode } from '../../core/errors'
import { SimpleEventEmitter } from '../../core/orchestration/eventEmitter'
import { FinishReason, type TraceContextV1 } from '../../core/types'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import type { SingleTurnProvider } from '../../llm/types'
import { McpManager } from '../../mcp/manager'
import { MessageQueue } from '../../queue/messageQueue'
import type { Task } from '../../queue/types'
import type { IncomingMessage } from '../../server/types'
import { ModelStepContinuationService } from '../modelStepContinuation'
import { sourceMessageForResume } from '../sourceMessageForResume'
import { TaskExecutor, type TaskExecutorDeps } from '../taskExecutor'
import type { ModelStepCheckpointSupport } from '../types'

let handle: StoreHandle | undefined
const savedConfig = {
  enableApproval: config.enableApproval,
  dynamicToolsEnabled: config.dynamicToolsEnabled,
}
afterEach(async () => {
  if (handle) await handle.shutdown()
  handle = undefined
  Object.assign(config, savedConfig)
  vi.restoreAllMocks()
})

describe('model-step continuation governed trace', () => {
  it('carries the fresh admission trace through the real queue and enqueues run_start', async () => {
    Object.assign(config, { enableApproval: false, dynamicToolsEnabled: false })
    const now = Date.now()
    const trace: TraceContextV1 = {
      version: 1,
      runId: 'continued-run',
      sessionId: 'chat-trace',
      origin: 'direct_chat',
      correlationRefs: [],
    }
    const message: IncomingMessage = {
      content: 'Continue the interrupted model step',
      sender: 'trace-user',
      channelType: 'rpc',
      channelId: 'chatllm',
      threadId: 'chat-trace',
      timestamp: new Date(now).toISOString(),
      hostRef: 'chatllm',
      messageId: 'origin-message',
      traceContext: { ...trace, runId: 'origin-run' },
    }
    const sessionKey = 'trace-user:rpc:chatllm:chat-trace'
    handle = makeSqliteStore()
    const manager = new ConversationManager(handle.store)
    const conversation = await manager.getOrCreate(sessionKey, {
      userId: message.sender,
      channelType: 'rpc',
      channelId: 'chatllm',
      threadId: 'chat-trace',
      source: 'rpc',
    })
    await manager.startTurn(conversation, message.content, 'origin-task')
    await manager.failTurn(conversation)
    const store = new ModelStepCheckpointStore(handle.persistQueue, {
      now: () => now,
      blockedTtlMs: 60_000,
    })
    const fence = await store.open(
      {
        checkpointId: 'checkpoint-trace',
        sessionKey,
        originTurnNumber: 1,
        originTaskId: 'origin-task',
        provider: 'openai',
        model: 'trace-model',
        hostId: 'host-trace',
        principal: message.sender!,
        loopState: JSON.stringify({ nextIteration: 0, originUserMessageIndex: 0 }),
        taskBudget: JSON.stringify({
          elapsedActiveMs: 0,
          iterationsUsed: 0,
          durationMs: 300_000,
          maxIterations: 20,
          attachmentReadLedger: { reads: 0, spentTokens: 0, bytesRead: 0 },
        }),
        sourceMessage: JSON.stringify(sourceMessageForResume(message)),
      },
      [
        {
          kind: 'message',
          toolCallId: null,
          payload: JSON.stringify({ role: 'user', content: message.content }),
        },
      ]
    )
    const version = await store.transition(sessionKey, fence, {
      from: ['open'],
      to: 'resumable',
      failedAt: now,
      expiresAt: now + 60_000,
    })
    expect(version).toBe(2)
    const checkpoints: ModelStepCheckpointSupport = {
      store,
      hostInstanceId: 'instance-trace',
      hostId: 'host-trace',
      resumableTtlMs: 60_000,
      claimLeaseMs: 300_000,
      pendingApprovalTtlMs: 60_000,
      attachmentTtlMs: 60_000,
    }
    const lifecycle = new TaskLifecycle()
    const queue = new MessageQueue()
    queue.setLifecycle(lifecycle)
    const complete = vi.fn(async () => ({
      content: 'continued answer',
      tool_calls: [],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      finish_reason: FinishReason.Stop,
    }))
    const provider: SingleTurnProvider = {
      getProviderType: () => 'openai',
      classifyError: () => ({
        code: LlmErrorCode.ApiCallFailed,
        message: 'Unexpected provider failure',
        retryable: false,
      }),
      completeSingleTurn: async () => {
        throw new Error('Unexpected tool-less completion')
      },
      completeSingleTurnWithTools: complete,
    }
    const enqueueEvent = vi.fn()
    const onComplete = vi.fn()
    let task: Task | undefined
    let execution: Promise<void> | undefined
    const service = new ModelStepContinuationService({
      checkpoints,
      conversationManager: manager,
      enqueue: (source, taskId, continuation) => {
        task = queue.createModelStepContinuationTask(source, taskId, continuation)
        expect(queue.admit(task).admitted).toBe(true)
        const executor = new TaskExecutor(task, {
          conversationManager: manager,
          llmProvider: provider,
          mcpManager: new McpManager(),
          modelName: 'trace-model',
          contextWindowTokens: 100_000,
          workspaceService: undefined,
          approvalConfig: undefined,
          config: {
            maxTaskDuration: 300_000,
            maxToolCallsPerTask: 20,
            autoStart: true,
            taskDelay: 0,
            approvalTimeout: 300_000,
          },
          coreEvents: new SimpleEventEmitter(),
          cronScheduler: null,
          taskLifecycle: lifecycle,
          onApprovalNeeded: vi.fn(),
          onComplete,
          onFail: vi.fn(),
          dynamicEnvProvider: () => ({}),
          modelStepCheckpoints: checkpoints,
          usageStaticContext: { host_ref: 'chatllm', context_ref: null, llm_secret_name: null },
          governedRunReporter: {
            enqueue: enqueueEvent,
          } as unknown as TaskExecutorDeps['governedRunReporter'],
        })
        execution = executor.run()
      },
    })
    const result = await service.continue({
      userId: message.sender!,
      agent: 'chatllm',
      chatId: 'chat-trace',
      checkpointId: 'checkpoint-trace',
      version: version!,
      traceContext: trace,
    })
    await execution
    await handle.persistQueue.drain()
    expect(result.status).toBe(202)
    expect(complete).toHaveBeenCalledTimes(1)
    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(task?.traceContext).toEqual(trace)
    expect(enqueueEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'run_start',
        runId: trace.runId,
        sessionId: trace.sessionId,
        hostRef: 'chatllm',
        origin: 'direct_chat',
      })
    )
  })
})
