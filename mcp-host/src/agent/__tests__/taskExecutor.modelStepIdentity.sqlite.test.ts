import { afterEach, describe, expect, it, vi } from 'vitest'
import { config as appConfig } from '../../config'
import { ConversationManager } from '../../core/conversation/conversation'
import { makeSqliteStore } from '../../core/conversation/persistence/__tests__/testHelpers'
import { ModelStepCheckpointStore } from '../../core/conversation/persistence/modelStepCheckpointStore'
import { LlmErrorCode } from '../../core/errors'
import { SimpleEventEmitter } from '../../core/orchestration/eventEmitter'
import { type ChatMessage, FinishReason, type ToolCall } from '../../core/types'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import { FailoverEngine } from '../../llm/failover/engine'
import type { LlmPolicy } from '../../llm/failover/types'
import type { SingleTurnProvider } from '../../llm/types'
import { McpManager } from '../../mcp/manager'
import type { Task, TaskError } from '../../queue/types'
import type { McpTool } from '../../types'
import { TaskExecutor, type TaskExecutorDeps } from '../taskExecutor'

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
      store: new ModelStepCheckpointStore(handle.persistQueue, { now: () => NOW }),
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
  await new TaskExecutor(nextTask, nextDeps).run()
  await handle.persistQueue.drain()
  return verdict
}

describe('real-producer checkpoint identity regressions', () => {
  afterEach(() => {
    Object.assign(appConfig, savedConfig)
    vi.restoreAllMocks()
  })

  it.each([
    { removed: false, expected: 'started' },
    { removed: true, expected: 'blocked' },
  ])(
    'R3-H1: bridge destination removed=$removed yields $expected',
    async ({ removed, expected }) => {
      Object.assign(appConfig, {
        enableApproval: false,
        dynamicToolsEnabled: true,
        promptCacheEnabled: false,
      })
      vi.spyOn(Date, 'now').mockReturnValue(NOW)
      const handle = makeSqliteStore()
      try {
        const manager = new McpManager()
        const tools: McpTool[] = [
          {
            name: 'server__part__write',
            serverName: 'server__part',
            inputSchema: { type: 'object' },
          },
        ]
        vi.spyOn(manager, 'getAllTools').mockImplementation(() => tools)
        const execution = vi.spyOn(manager, 'callTool').mockResolvedValue({
          toolName: tools[0]!.name,
          result: { content: [{ type: 'text', text: 'effect completed' }] },
          isError: false,
        })
        const llm = provider('openai', (_messages, call) =>
          call === 1
            ? {
                calls: [
                  {
                    id: 'bridge-1',
                    name: 'clerum__tool_call',
                    arguments: { name: tools[0]!.name, arguments: {} },
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
        expect(llm.calls()).toBe(2)
        expect(execution).toHaveBeenCalledTimes(1)
        expect(header(handle).status).toBe('resumable')
        if (removed) tools.length = 0
        const resumed = provider('openai', () => ({ content: 'historical result accepted' }))
        const verdict = await continueTurn(handle, original, originalDeps, resumed)
        if (removed) {
          expect(verdict).toHaveBeenCalledWith({ kind: 'blocked', blockedReason: 'grant_revoked' })
          expect(resumed.calls()).toBe(0)
        } else {
          expect(verdict).toHaveBeenCalledWith({ kind: expected })
          expect(resumed.calls()).toBe(1)
        }
      } finally {
        await handle.shutdown()
      }
    }
  )

  it('R3-H1: a deferred native bridge destination resolves before continuation', async () => {
    Object.assign(appConfig, {
      enableApproval: false,
      dynamicToolsEnabled: false,
      promptCacheEnabled: false,
      nativeToolPresentation: 'auto',
      nativeToolDiscoveryBytes: 1,
    })
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const handle = makeSqliteStore()
    try {
      const original = task('identity-native')
      const llm = provider('openai', (_messages, call) =>
        call === 1
          ? {
              calls: [
                {
                  id: 'native-1',
                  name: 'clerum__tool_call',
                  arguments: { name: 'system_info', arguments: {} },
                },
              ],
            }
          : { error: new Error('upstream 503') }
      )
      const originalDeps = deps(handle, llm)
      originalDeps.taskLifecycle.register(original)
      await new TaskExecutor(original, originalDeps).run()
      await handle.persistQueue.drain()
      expect(llm.calls()).toBe(2)
      expect(header(handle).status).toBe('resumable')
      const resumed = provider('openai', () => ({ content: 'native result accepted' }))
      const verdict = await continueTurn(handle, original, originalDeps, resumed)
      expect(verdict).toHaveBeenCalledWith({ kind: 'started' })
      expect(resumed.calls()).toBe(1)
    } finally {
      await handle.shutdown()
    }
  })

  it.each([
    { name: 'missing destination', arguments: {} },
    { name: 'invalid arguments', arguments: { name: 'system_info', arguments: [] } },
  ])('R3-H1: $name in a persisted bridge envelope fails closed', async ({ arguments: invalid }) => {
    Object.assign(appConfig, {
      enableApproval: false,
      dynamicToolsEnabled: false,
      promptCacheEnabled: false,
      nativeToolPresentation: 'auto',
      nativeToolDiscoveryBytes: 1,
    })
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const handle = makeSqliteStore()
    try {
      const original = task('identity-invalid')
      const llm = provider('openai', (_messages, call) =>
        call === 1
          ? {
              calls: [
                {
                  id: 'native-1',
                  name: 'clerum__tool_call',
                  arguments: { name: 'system_info', arguments: {} },
                },
              ],
            }
          : { error: new Error('upstream 503') }
      )
      const originalDeps = deps(handle, llm)
      originalDeps.taskLifecycle.register(original)
      await new TaskExecutor(original, originalDeps).run()
      await handle.persistQueue.drain()
      expect(header(handle).status).toBe('resumable')
      const row = handle.worker.db
        .prepare(
          "SELECT seq, payload FROM model_step_checkpoint_entries WHERE kind = 'message' AND payload LIKE '%clerum__tool_call%'"
        )
        .get() as { seq: number; payload: string }
      const recorded = JSON.parse(row.payload) as ChatMessage
      recorded.tool_calls![0]!.arguments = invalid
      handle.worker.db
        .prepare(
          'UPDATE model_step_checkpoint_entries SET payload = ? WHERE checkpoint_id = ? AND seq = ?'
        )
        .run(JSON.stringify(recorded), header(handle).checkpoint_id, row.seq)
      const resumed = provider('openai', () => ({ content: 'must not be reached' }))
      const verdict = await continueTurn(handle, original, originalDeps, resumed)
      expect(verdict).toHaveBeenCalledWith({ kind: 'blocked', blockedReason: 'grant_revoked' })
      expect(resumed.calls()).toBe(0)
    } finally {
      await handle.shutdown()
    }
  })

  it('R3-M1: the checkpoint names the fallback that produced the tool result', async () => {
    Object.assign(appConfig, {
      enableApproval: false,
      dynamicToolsEnabled: false,
      promptCacheEnabled: false,
    })
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const handle = makeSqliteStore()
    try {
      const primary = provider('claude', () => ({ error: new Error('upstream 503') }))
      const fallback = provider('openai', (_messages, call) =>
        call === 1
          ? { calls: [{ id: 'system-1', name: 'system_info', arguments: {} }] }
          : { error: new Error('upstream 503') }
      )
      const policy: LlmPolicy = {
        cooldownSeconds: 300,
        triggerOn: ['provider_unavailable'],
        fallbacks: [{ provider: 'openai', model: 'fallback-model' }],
      }
      const original = task('identity-failover')
      const originalDeps = deps(handle, primary)
      originalDeps.failover = {
        policy,
        engine: new FailoverEngine(policy, { metricInc: () => {} }),
        buildProvider: () => fallback,
      }
      originalDeps.taskLifecycle.register(original)
      await new TaskExecutor(original, originalDeps).run()
      await handle.persistQueue.drain()
      expect(primary.calls()).toBe(1)
      expect(fallback.calls()).toBe(2)
      expect(header(handle)).toMatchObject({
        status: 'resumable',
        provider: 'openai',
        model: 'fallback-model',
      })
    } finally {
      await handle.shutdown()
    }
  })
})
