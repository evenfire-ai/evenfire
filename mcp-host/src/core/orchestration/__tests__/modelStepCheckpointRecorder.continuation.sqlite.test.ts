import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskExecutor, type TaskExecutorDeps } from '../../../agent/taskExecutor'
import { config as appConfig } from '../../../config'
import { ConversationManager } from '../../../core/conversation/conversation'
import { makeSqliteStore } from '../../../core/conversation/persistence/__tests__/testHelpers'
import { ModelStepCheckpointStore } from '../../../core/conversation/persistence/modelStepCheckpointStore'
import { LlmErrorCode } from '../../../core/errors'
import { SimpleEventEmitter } from '../../../core/orchestration/eventEmitter'
import { type ChatMessage, FinishReason, type ToolCall } from '../../../core/types'
import { TaskLifecycle } from '../../../lifecycle/taskLifecycle'
import type { SingleTurnProvider } from '../../../llm/types'
import { McpManager } from '../../../mcp/manager'
import type { Task, TaskError } from '../../../queue/types'
import type { McpTool } from '../../../types'

const NOW = 1_700_000_000_000
const SESSION_KEY = 'identity-user:rpc:identity-channel:default'
const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
const savedConfig = {
  enableApproval: appConfig.enableApproval,
  dynamicToolsEnabled: appConfig.dynamicToolsEnabled,
  promptCacheEnabled: appConfig.promptCacheEnabled,
  nativeToolPresentation: appConfig.nativeToolPresentation,
  nativeToolDiscoveryBytes: appConfig.nativeToolDiscoveryBytes,
}

type Reply = { calls?: ToolCall[]; content?: string; error?: Error }
function provider(
  kind: string,
  answer: (messages: ChatMessage[], call: number) => Reply
): SingleTurnProvider & { calls(): number; requests: ChatMessage[][] } {
  let count = 0
  const requests: ChatMessage[][] = []
  return {
    calls: () => count,
    requests,
    getProviderType: () => kind as never,
    classifyError: error => ({
      code:
        error instanceof Error && error.message === 'upstream 503'
          ? LlmErrorCode.ModelOverloaded
          : LlmErrorCode.ApiCallFailed,
      retryable: error instanceof Error && error.message === 'upstream 503',
      message: error instanceof Error ? error.message : String(error),
      httpStatus: error instanceof Error && error.message === 'upstream 503' ? 503 : undefined,
      providerCode:
        error instanceof Error && error.message === 'upstream 503'
          ? 'provider_unavailable'
          : undefined,
    }),
    completeSingleTurn: async () => {
      throw new Error('Unexpected tool-less completion')
    },
    completeSingleTurnWithTools: async messages => {
      count += 1
      requests.push(messages)
      const result = answer(messages, count)
      if (result.error) throw result.error
      return {
        content: result.content ?? null,
        tool_calls: result.calls ?? [],
        usage,
        finish_reason: result.calls ? FinishReason.ToolUse : FinishReason.Stop,
      }
    },
  }
}

function task(id: string, content = 'Use the tool'): Task {
  return {
    id,
    source: 'channel',
    status: 'pending',
    priority: 'normal',
    createdAt: new Date(NOW),
    sourceMessage: {
      sender: 'identity-user',
      content,
      channelType: 'rpc',
      channelId: 'identity-channel',
      messageId: 'identity-message',
      timestamp: new Date(NOW).toISOString(),
      hostRef: 'host-a',
    },
    conversationHistory: [{ role: 'user', content, timestamp: new Date(NOW) }],
    responseCallback: vi.fn(async () => {}),
  }
}

function deps(
  handle: ReturnType<typeof makeSqliteStore>,
  llm: SingleTurnProvider,
  manager = new McpManager()
): TaskExecutorDeps {
  return {
    conversationManager: new ConversationManager(handle.store),
    llmProvider: llm,
    mcpManager: manager,
    workspaceService: undefined,
    modelName: 'primary-model',
    approvalConfig: undefined,
    config: {
      maxTaskDuration: 300_000,
      maxToolCallsPerTask: 10,
      autoStart: true,
      taskDelay: 0,
      approvalTimeout: 300_000,
    },
    coreEvents: new SimpleEventEmitter(),
    cronScheduler: null,
    taskLifecycle: new TaskLifecycle(),
    onApprovalNeeded: vi.fn(),
    onComplete: vi.fn(),
    onFail: vi.fn<(task: Task, error: TaskError) => void>(),
    dynamicEnvProvider: () => ({}),
    modelStepCheckpoints: {
      store: new ModelStepCheckpointStore(handle.persistQueue, {
        now: () => NOW,
        blockedTtlMs: 7 * 24 * 3_600_000,
      }),
      hostInstanceId: 'instance-a',
      hostId: 'host-a',
      resumableTtlMs: 86_400_000,
      pendingApprovalTtlMs: 86_400_000,
      claimLeaseMs: 300_000,
      attachmentTtlMs: 3_600_000,
    },
  }
}

function header(handle: ReturnType<typeof makeSqliteStore>) {
  return handle.worker.db.prepare('SELECT * FROM model_step_checkpoints').get() as {
    checkpoint_id: string
    status: string
    version: number
    origin_turn_number: number
    provider: string
    model: string
    task_budget: string
  }
}

async function continueTurn(
  handle: ReturnType<typeof makeSqliteStore>,
  original: Task,
  originalDeps: TaskExecutorDeps,
  llm: SingleTurnProvider
) {
  const row = header(handle)
  const claim = await originalDeps.modelStepCheckpoints!.store.claim({
    sessionKey: SESSION_KEY,
    checkpointId: row.checkpoint_id,
    version: row.version,
    hostInstanceId: 'instance-a',
    newTaskId: 'identity-continuation',
    leaseMs: 300_000,
  })
  if (claim.outcome !== 'claimed') throw new Error(`Claim failed: ${claim.outcome}`)
  const verdict = vi.fn()
  const nextTask = task('identity-continuation', original.sourceMessage!.content)
  nextTask.modelStepContinuation = {
    checkpointId: row.checkpoint_id,
    originTaskId: original.id,
    originTurnNumber: row.origin_turn_number,
    provider: row.provider,
    model: row.model,
    fence: claim.fence,
    confirmedResults: 1,
    taskBudget: row.task_budget,
    onVerdict: verdict,
  }
  const nextDeps = {
    ...originalDeps,
    llmProvider: llm,
    modelName: row.model,
    taskLifecycle: new TaskLifecycle(),
  }
  nextDeps.taskLifecycle.register(nextTask)
  const executor = new TaskExecutor(nextTask, nextDeps)
  await executor.run()
  await handle.persistQueue.drain()
  return { verdict, executor }
}

describe('E2 poisoned continuation settlement with SQLite', () => {
  afterEach(() => {
    Object.assign(appConfig, savedConfig)
    vi.restoreAllMocks()
  })

  it('M4: a failed abandon is not released and executor cleanup abandons the owned claim', async () => {
    Object.assign(appConfig, {
      enableApproval: false,
      dynamicToolsEnabled: true,
      promptCacheEnabled: false,
    })
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const handle = makeSqliteStore()
    try {
      const manager = new McpManager()
      const tool: McpTool = {
        name: 'server__read',
        serverName: 'server',
        inputSchema: { type: 'object' },
      }
      vi.spyOn(manager, 'getAllTools').mockReturnValue([tool])
      const execution = vi.spyOn(manager, 'callTool').mockResolvedValue({
        toolName: tool.name,
        result: { content: [{ type: 'text', text: 'read completed' }] },
        isError: false,
      })
      const llm = provider('openai', (_messages, call) =>
        call === 1
          ? {
              calls: [
                {
                  id: 'origin-call',
                  name: 'clerum__tool_call',
                  arguments: { name: tool.name, arguments: {} },
                },
              ],
            }
          : { error: new Error('upstream 503') }
      )
      const original = task('identity-origin')
      const originalDeps = deps(handle, llm, manager)
      originalDeps.taskLifecycle.register(original)
      await new TaskExecutor(original, originalDeps).run()
      await handle.persistQueue.drain()
      expect(header(handle).status).toBe('resumable')
      expect(execution).toHaveBeenCalledTimes(1)
      const store = originalDeps.modelStepCheckpoints!.store
      const append = vi.spyOn(store, 'append').mockRejectedValueOnce(new Error('SQLITE_IOERR'))
      const transition = store.transition.bind(store)
      let abandonAttempts = 0
      const transitions = vi.spyOn(store, 'transition').mockImplementation(async (...args) => {
        if (args[2].to === 'abandoned' && ++abandonAttempts === 1)
          throw new Error('SQLITE_IOERR abandon')
        return transition(...args)
      })
      const cleanupPrototype = TaskExecutor.prototype as unknown as {
        abandonModelStepContinuation(): Promise<void>
        continuationClaimReleased: boolean
      }
      const abandon = cleanupPrototype.abandonModelStepContinuation
      const releasedBeforeCleanup: boolean[] = []
      vi.spyOn(cleanupPrototype, 'abandonModelStepContinuation').mockImplementation(async function (
        this: typeof cleanupPrototype
      ) {
        releasedBeforeCleanup.push(this.continuationClaimReleased)
        return abandon.call(this)
      })
      const resumed = provider('openai', (_messages, call) =>
        call === 1
          ? {
              calls: [
                {
                  id: 'resumed-call',
                  name: 'clerum__tool_call',
                  arguments: { name: tool.name, arguments: {} },
                },
              ],
            }
          : { content: 'Read finished.' }
      )
      const { verdict, executor } = await continueTurn(handle, original, originalDeps, resumed)
      expect(verdict).toHaveBeenCalledWith({ kind: 'started' })
      expect(resumed.calls()).toBe(2)
      expect(append).toHaveBeenCalled()
      expect(execution).toHaveBeenCalledTimes(2)
      expect(transitions.mock.calls.filter(args => args[2].to === 'abandoned')).toHaveLength(2)
      expect(releasedBeforeCleanup).toEqual([false])
      expect(header(handle).status).toBe('abandoned')
      expect(
        (executor as unknown as { continuationClaimReleased: boolean }).continuationClaimReleased
      ).toBe(true)
    } finally {
      await handle.shutdown()
    }
  })
})
