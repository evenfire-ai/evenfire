import { afterEach, describe, expect, it, vi } from 'vitest'
import { config as appConfig } from '../../config'
import { ConversationManager } from '../../core/conversation/conversation'
import {
  type StoreHandle,
  makeSqliteStore,
} from '../../core/conversation/persistence/__tests__/testHelpers'
import { ModelStepCheckpointStore } from '../../core/conversation/persistence/modelStepCheckpointStore'
import { LlmErrorCode } from '../../core/errors'
import { SimpleEventEmitter } from '../../core/orchestration/eventEmitter'
import { type ChatMessage, FinishReason, type ToolCall } from '../../core/types'
import type { ModelStepCheckpointFence } from '../../db/worker/modelStepCheckpointOps'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import type { SingleTurnProvider } from '../../llm/types'
import { McpManager } from '../../mcp/manager'
import type { Task } from '../../queue/types'
import type { IncomingMessage } from '../../server/types'
import { sourceMessageForResume } from '../sourceMessageForResume'
import { TaskExecutor, type TaskExecutorDeps } from '../taskExecutor'

const LEASE_MS = 300_000
const TTL_MS = 86_400_000
const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
const savedConfig = {
  enableApproval: appConfig.enableApproval,
  dynamicToolsEnabled: appConfig.dynamicToolsEnabled,
  promptCacheEnabled: appConfig.promptCacheEnabled,
  modelStepAutoRetries: appConfig.modelStepAutoRetries,
}

type Answer = { content?: string; calls?: ToolCall[] }
function provider(answer: () => Promise<Answer>) {
  let calls = 0
  const llm: SingleTurnProvider = {
    getProviderType: () => 'openai' as never,
    classifyError: error => ({
      code: LlmErrorCode.ApiCallFailed,
      retryable: false,
      message: error instanceof Error ? error.message : String(error),
    }),
    completeSingleTurn: async () => {
      throw new Error('Unexpected tool-less completion')
    },
    completeSingleTurnWithTools: async (_messages: ChatMessage[]) => {
      calls++
      const result = await answer()
      return {
        content: result.content ?? null,
        tool_calls: result.calls ?? [],
        usage,
        finish_reason: result.calls ? FinishReason.ToolUse : FinishReason.Stop,
      }
    },
  }
  return { llm, calls: () => calls }
}

function task(id: string, message: IncomingMessage): Task {
  return {
    id,
    source: 'channel',
    sourceMessage: message,
    priority: 'normal',
    status: 'pending',
    createdAt: new Date(),
    conversationHistory: [{ role: 'user', content: message.content, timestamp: new Date() }],
    responseCallback: vi.fn(async () => {}),
  }
}

type Fixture = {
  message: IncomingMessage
  sessionKey: string
  checkpointId: string
  fence: ModelStepCheckpointFence
  budget: string
}

async function seed(
  handle: StoreHandle,
  manager: ConversationManager,
  checkpoints: ModelStepCheckpointStore,
  clock: number,
  name: string
): Promise<Fixture> {
  const message: IncomingMessage = {
    sender: 'owner-user',
    content: `Continue ${name}`,
    channelType: 'rpc',
    channelId: 'chatllm',
    threadId: name,
    messageId: `message-${name}`,
    timestamp: new Date(clock).toISOString(),
    hostRef: 'host-a',
  }
  const sessionKey = `owner-user:rpc:chatllm:${name}`
  const origin = `origin-${name}`
  const checkpointId = `checkpoint-${name}`
  const budget = JSON.stringify({
    elapsedActiveMs: 0,
    iterationsUsed: 0,
    durationMs: 300_000,
    maxIterations: 20,
    attachmentReadLedger: { reads: 0, spentTokens: 0, bytesRead: 0 },
  })
  const conv = await manager.getOrCreate(sessionKey, {
    userId: 'owner-user',
    channelType: 'rpc',
    channelId: 'chatllm',
    threadId: name,
    source: 'rpc',
  })
  await manager.startTurn(conv, message.content, origin)
  await manager.failTurn(conv)
  const open = await checkpoints.open(
    {
      checkpointId,
      sessionKey,
      originTurnNumber: 1,
      originTaskId: origin,
      provider: 'openai',
      model: 'checkpoint-model',
      hostId: 'host-a',
      principal: 'owner-user',
      loopState: JSON.stringify({ nextIteration: 0, originUserMessageIndex: 0 }),
      taskBudget: budget,
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
  const version = await checkpoints.transition(sessionKey, open, {
    from: ['open'],
    to: 'resumable',
    failedAt: clock,
    expiresAt: clock + TTL_MS,
  })
  if (version === null) throw new Error('Fixture did not become resumable')
  const claim = await checkpoints.claim({
    sessionKey,
    checkpointId,
    version,
    hostInstanceId: `host-${name}-a`,
    newTaskId: `continuation-${name}-a`,
    leaseMs: LEASE_MS,
  })
  if (claim.outcome !== 'claimed') throw new Error(`Fixture claim: ${claim.outcome}`)
  await handle.persistQueue.drain()
  return { message, sessionKey, checkpointId, fence: claim.fence, budget }
}

function execution(
  fixture: Fixture,
  manager: ConversationManager,
  checkpoints: ModelStepCheckpointStore,
  name: string,
  fence: ModelStepCheckpointFence,
  llm: SingleTurnProvider
) {
  const onVerdict = vi.fn()
  const t = task(name, fixture.message)
  t.modelStepContinuation = {
    checkpointId: fixture.checkpointId,
    originTaskId: `origin-${fixture.message.threadId}`,
    originTurnNumber: 1,
    provider: 'openai',
    model: 'checkpoint-model',
    fence,
    confirmedResults: 0,
    taskBudget: fixture.budget,
    onVerdict,
  }
  const lifecycle = new TaskLifecycle()
  lifecycle.register(t)
  lifecycle.transition(t.id, 'processing', 'dispatched')
  const onFail = vi.fn(() => lifecycle.transition(t.id, 'failed', 'error:test'))
  const onComplete = vi.fn(() => lifecycle.transition(t.id, 'completed', 'natural'))
  const onApprovalNeeded = vi.fn(() => lifecycle.transition(t.id, 'waiting_approval', 'natural'))
  const deps: TaskExecutorDeps = {
    conversationManager: manager,
    llmProvider: llm,
    mcpManager: new McpManager(),
    workspaceService: undefined,
    modelName: 'checkpoint-model',
    contextWindowTokens: 100_000,
    approvalConfig: { defaultPolicy: 'channel_users', channels: {}, tools: { shell_exec: true } },
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
    onApprovalNeeded,
    onComplete,
    onFail,
    dynamicEnvProvider: () => ({}),
    modelStepCheckpoints: {
      store: checkpoints,
      hostInstanceId: 'host-a',
      hostId: 'host-a',
      resumableTtlMs: TTL_MS,
      claimLeaseMs: LEASE_MS,
      pendingApprovalTtlMs: TTL_MS,
      attachmentTtlMs: 3_600_000,
    },
  }
  return {
    executor: new TaskExecutor(t, deps),
    lifecycle,
    taskId: t.id,
    task: t,
    onFail,
    onComplete,
    onApprovalNeeded,
    onVerdict,
  }
}

function session(handle: StoreHandle, key: string) {
  return handle.worker.db
    .prepare('SELECT state, active_task_id FROM sessions WHERE session_key = ?')
    .get(key)
}
function approval(handle: StoreHandle, taskId: string) {
  return handle.worker.db
    .prepare('SELECT request_id, task_id FROM pending_approvals WHERE task_id = ?')
    .get(taskId)
}
function checkpoint(handle: StoreHandle, id: string) {
  return handle.worker.db
    .prepare(
      'SELECT status, continuation_task_id FROM model_step_checkpoints WHERE checkpoint_id = ?'
    )
    .get(id)
}

describe('concurrent continuation settlement', () => {
  afterEach(() => {
    Object.assign(appConfig, savedConfig)
    vi.restoreAllMocks()
  })

  it('settles a suspended continuation once when denial and cancellation overlap', async () => {
    Object.assign(appConfig, {
      enableApproval: true,
      dynamicToolsEnabled: false,
      promptCacheEnabled: false,
      modelStepAutoRetries: 0,
    })
    const clock = Date.now()
    const handle = makeSqliteStore()
    const manager = new ConversationManager(handle.store)
    const checkpoints = new ModelStepCheckpointStore(handle.persistQueue, {
      now: () => clock,
      blockedTtlMs: TTL_MS,
    })
    let releaseTransition!: () => void
    let announceTransition!: () => void
    const transitionGate = new Promise<void>(resolve => {
      releaseTransition = resolve
    })
    const transitionEntered = new Promise<void>(resolve => {
      announceTransition = resolve
    })
    let denial: Promise<void> | undefined
    try {
      const fixture = await seed(handle, manager, checkpoints, clock, 'race')
      const asking = provider(async () => ({
        calls: [{ id: 'race-tool', name: 'shell_exec', arguments: { command: 'printf held' } }],
      }))
      const target = execution(
        fixture,
        manager,
        checkpoints,
        'continuation-race-a',
        fixture.fence,
        asking.llm
      )
      await target.executor.run()
      expect(asking.calls()).toBe(1)
      expect(target.onApprovalNeeded).toHaveBeenCalledTimes(1)
      expect(target.executor.executorState).toBe('waiting_approval')
      expect(target.lifecycle.getStatus(target.taskId)).toBe('waiting_approval')
      expect(session(handle, fixture.sessionKey)).toEqual({
        state: 'awaiting_approval',
        active_task_id: target.taskId,
      })
      expect(approval(handle, target.taskId)).toMatchObject({ task_id: target.taskId })
      const before = handle.worker.db
        .prepare('SELECT status, version FROM model_step_checkpoints WHERE checkpoint_id = ?')
        .get(fixture.checkpointId) as { status: string; version: number }
      expect(before.status).toBe('claimed')

      const neighbor = await seed(handle, manager, checkpoints, clock, 'race-neighbor')
      const neighborProvider = provider(async () => ({ content: 'healthy neighbor completed' }))
      const healthy = execution(
        neighbor,
        manager,
        checkpoints,
        'continuation-race-neighbor-a',
        neighbor.fence,
        neighborProvider.llm
      )
      await healthy.executor.run()
      await handle.persistQueue.drain()
      expect(neighborProvider.calls()).toBe(1)
      expect(healthy.onComplete).toHaveBeenCalledTimes(1)
      expect(healthy.lifecycle.getStatus(healthy.taskId)).toBe('completed')
      expect(checkpoint(handle, neighbor.checkpointId)).toEqual({
        status: 'completed',
        continuation_task_id: healthy.taskId,
      })

      const originalTransition = checkpoints.transition.bind(checkpoints)
      const transition = vi
        .spyOn(checkpoints, 'transition')
        .mockImplementation(async (key, fence, change) => {
          if (fence.checkpointId === fixture.checkpointId && change.to === 'abandoned') {
            announceTransition()
            await transitionGate
          }
          return originalTransition(key, fence, change)
        })
      const paths = target.executor as unknown as { abandonModelStepContinuation(): Promise<void> }
      const abandon = vi.spyOn(paths, 'abandonModelStepContinuation')
      let completions = 0
      const completion = target.executor.waitForCompletion().then(() => {
        completions++
      })
      denial = target.executor.deny()
      await transitionEntered
      expect(session(handle, fixture.sessionKey)).toEqual({ state: 'idle', active_task_id: null })
      expect(approval(handle, target.taskId)).toBeUndefined()
      expect(checkpoint(handle, fixture.checkpointId)).toEqual({
        status: 'claimed',
        continuation_task_id: target.taskId,
      })
      target.executor.abort()
      await vi.waitFor(() => expect(abandon).toHaveBeenCalledTimes(2))
      expect(transition).toHaveBeenCalledTimes(1)
      expect(completions).toBe(0)
      expect(target.lifecycle.getStatus(target.taskId)).toBe('cancelled')
      releaseTransition()
      await Promise.all([denial, completion])
      await handle.persistQueue.drain()

      expect(transition).toHaveBeenCalledTimes(1)
      expect(completions).toBe(1)
      expect(
        handle.worker.db
          .prepare('SELECT status, version FROM model_step_checkpoints WHERE checkpoint_id = ?')
          .get(fixture.checkpointId)
      ).toEqual({ status: 'abandoned', version: before.version + 1 })
      expect(session(handle, fixture.sessionKey)).toEqual({ state: 'idle', active_task_id: null })
      expect(approval(handle, target.taskId)).toBeUndefined()
      expect(
        target.lifecycle
          .get(target.taskId)
          ?.history.filter(entry => ['cancelled', 'failed', 'completed'].includes(entry.to))
      ).toHaveLength(1)
      expect(target.lifecycle.getStatus(target.taskId)).toBe('cancelled')
      expect.soft(target.onComplete).not.toHaveBeenCalled()
      expect(target.onFail).not.toHaveBeenCalled()
      expect.soft(target.task.responseCallback).not.toHaveBeenCalled()
    } finally {
      releaseTransition()
      await denial?.catch(() => {})
      await handle.shutdown()
    }
  }, 20_000)
})
