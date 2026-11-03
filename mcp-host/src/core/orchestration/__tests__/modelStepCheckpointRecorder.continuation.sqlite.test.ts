import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskExecutor, type TaskExecutorDeps } from '../../../agent/taskExecutor'
import { config as appConfig } from '../../../config'
import { ConversationManager } from '../../../core/conversation/conversation'
import { toModelStepCheckpointView } from '../../../core/conversation/modelStepCheckpointView'
import { makeSqliteStore } from '../../../core/conversation/persistence/__tests__/testHelpers'
import { ModelStepCheckpointStore } from '../../../core/conversation/persistence/modelStepCheckpointStore'
import { LlmError, LlmErrorCode } from '../../../core/errors'
import { SimpleEventEmitter } from '../../../core/orchestration/eventEmitter'
import { type ChatMessage, FinishReason, type ToolCall } from '../../../core/types'
import { TaskLifecycle } from '../../../lifecycle/taskLifecycle'
import type { SingleTurnProvider } from '../../../llm/types'
import { McpManager } from '../../../mcp/manager'
import type { Task, TaskError } from '../../../queue/types'
import type { McpTool } from '../../../types'
import { createModelStepCheckpointRecorder } from '../modelStepCheckpointRecorder'
import { AUTO_RETRY_TEST_TIMEOUT_MS } from './modelStepRetryTestTimeout'

const NOW = 1_700_000_000_000
const SESSION_KEY = 'identity-user:rpc:identity-channel:default'
const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
const savedConfig = {
  enableApproval: appConfig.enableApproval,
  dynamicToolsEnabled: appConfig.dynamicToolsEnabled,
  promptCacheEnabled: appConfig.promptCacheEnabled,
  nativeToolPresentation: appConfig.nativeToolPresentation,
  nativeToolDiscoveryBytes: appConfig.nativeToolDiscoveryBytes,
  modelStepAutoRetries: appConfig.modelStepAutoRetries,
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

async function claimedRecorder() {
  const handle = makeSqliteStore()
  const manager = new ConversationManager(handle.store)
  await manager.getOrCreate(SESSION_KEY, {
    userId: 'identity-user',
    channelType: 'rpc',
    channelId: 'identity-channel',
    threadId: 'default',
    source: 'rpc',
  })
  const store = new ModelStepCheckpointStore(handle.persistQueue, {
    now: () => NOW,
    blockedTtlMs: 86_400_000,
  })
  const open = await store.open(
    {
      checkpointId: 'recorder-claim',
      sessionKey: SESSION_KEY,
      originTurnNumber: 1,
      originTaskId: 'recorder-origin',
      provider: 'openai',
      model: 'primary-model',
      hostId: 'host-a',
      principal: 'identity-user',
      loopState: JSON.stringify({ nextIteration: 0, originUserMessageIndex: 0 }),
      taskBudget: JSON.stringify({
        elapsedActiveMs: 0,
        iterationsUsed: 0,
        durationMs: 300_000,
        maxIterations: 10,
        attachmentReadLedger: { reads: 0, spentTokens: 0, bytesRead: 0 },
      }),
      sourceMessage: JSON.stringify(task('recorder-origin').sourceMessage),
    },
    [
      {
        kind: 'message',
        toolCallId: null,
        payload: JSON.stringify({ role: 'user', content: 'hello' }),
      },
      {
        kind: 'message',
        toolCallId: null,
        payload: JSON.stringify({
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'confirmed', name: 'server__read', arguments: {} }],
        }),
      },
      {
        kind: 'tool_dispatch',
        toolCallId: 'confirmed',
        payload: JSON.stringify({ name: 'server__read' }),
      },
      {
        kind: 'tool_result',
        toolCallId: 'confirmed',
        payload: JSON.stringify({ name: 'server__read', isError: false }),
      },
      {
        kind: 'message',
        toolCallId: 'confirmed',
        payload: JSON.stringify({
          role: 'tool',
          tool_call_id: 'confirmed',
          name: 'server__read',
          content: 'read completed',
        }),
      },
    ]
  )
  const version = await store.transition(SESSION_KEY, open, {
    from: ['open'],
    to: 'resumable',
    failedAt: NOW,
    expiresAt: NOW + 86_400_000,
  })
  if (version === null) throw new Error('Recorder fixture was not resumable')
  const claim = await store.claim({
    sessionKey: SESSION_KEY,
    checkpointId: 'recorder-claim',
    version,
    hostInstanceId: 'instance-a',
    newTaskId: 'recorder-continuation',
    leaseMs: 300_000,
  })
  if (claim.outcome !== 'claimed') throw new Error(`Recorder fixture claim: ${claim.outcome}`)
  const onFenceLost = vi.fn()
  const recorder = createModelStepCheckpointRecorder({
    store,
    sessionKey: SESSION_KEY,
    mode: {
      kind: 'continuation',
      fence: claim.fence,
      confirmedResults: 1,
      loopState: JSON.stringify({ nextIteration: 0, originUserMessageIndex: 0 }),
    },
    redact: text => text,
    taskBudget: () => null,
    resumableTtlMs: 86_400_000,
    attachmentTtlMs: 3_600_000,
    now: () => NOW,
    onFenceLost,
  })
  return { handle, store, recorder, onFenceLost }
}

describe('E2 poisoned continuation settlement with SQLite', () => {
  afterEach(() => {
    Object.assign(appConfig, savedConfig)
    vi.restoreAllMocks()
  })

  it.each(['operational', 'lost'] as const)(
    'direct dispatch %s is exposed to the owner without an intermediate abandon',
    async outcome => {
      const f = await claimedRecorder()
      try {
        const append = vi.spyOn(f.store, 'append')
        if (outcome === 'operational')
          append.mockRejectedValueOnce(new Error('dispatch unavailable'))
        else append.mockResolvedValueOnce(false)
        const transition = vi.spyOn(f.store, 'transition')
        const error = await f.recorder
          .recordDispatch({ id: 'direct', name: 'server__read', arguments: {} })
          .then(
            () => undefined,
            err => err
          )
        expect(append).toHaveBeenCalledTimes(1)
        expect.soft(error).toMatchObject({ kind: outcome })
        expect(f.onFenceLost).toHaveBeenCalledTimes(outcome === 'lost' ? 1 : 0)
        await f.recorder.settle(undefined)
        expect.soft(transition).not.toHaveBeenCalled()
        expect.soft(header(f.handle).status).toBe('claimed')
        expect(f.recorder.appliedSettlement).toBeUndefined()
      } finally {
        await f.handle.shutdown()
      }
    }
  )

  it.each(['operational', 'lost'] as const)(
    'a %s tool-call envelope write stops the following dispatch without abandoning the claim',
    async outcome => {
      const f = await claimedRecorder()
      try {
        const user: ChatMessage = { role: 'user', content: 'continue' }
        const call = { id: 'new-call', name: 'server__read', arguments: {} }
        await f.recorder.begin([user])
        const append = vi.spyOn(f.store, 'append')
        if (outcome === 'operational')
          append.mockRejectedValueOnce(new Error('envelope unavailable'))
        else append.mockResolvedValueOnce(false)
        const transition = vi.spyOn(f.store, 'transition')
        await f.recorder.syncMessages([
          user,
          { role: 'assistant', content: '', tool_calls: [call] },
        ])
        expect(append).toHaveBeenCalledTimes(1)
        expect(f.recorder.poisoned).toBe(true)
        const error = await f.recorder.recordDispatch(call).then(
          () => undefined,
          err => err
        )

        expect.soft(error).toMatchObject({ kind: outcome })
        expect(append).toHaveBeenCalledTimes(1)
        expect(f.onFenceLost).toHaveBeenCalledTimes(outcome === 'lost' ? 1 : 0)
        await f.recorder.settle(undefined)
        expect.soft(transition).not.toHaveBeenCalled()
        expect.soft(header(f.handle).status).toBe('claimed')
        expect(f.recorder.appliedSettlement).toBeUndefined()
      } finally {
        await f.handle.shutdown()
      }
    }
  )

  it('a failed post-effect result write is not reclassified as a pre-dispatch failure', async () => {
    const f = await claimedRecorder()
    try {
      const first = { id: 'effect-call', name: 'server__read', arguments: {} }
      await f.recorder.recordDispatch(first)
      const effect = vi.fn()
      effect()
      const append = vi
        .spyOn(f.store, 'append')
        .mockRejectedValueOnce(new Error('result unavailable'))
      await f.recorder.recordResult(first, {
        tool_call_id: first.id,
        name: first.name,
        content: 'effect completed',
        is_error: false,
      })
      expect(effect).toHaveBeenCalledTimes(1)
      expect(append).toHaveBeenCalledTimes(1)
      const entries = await f.store.loadEntries(SESSION_KEY, 'recorder-claim')
      expect(entries).toContainEqual(
        expect.objectContaining({ kind: 'tool_dispatch', tool_call_id: first.id })
      )
      expect(
        entries.some(entry => entry.kind === 'tool_result' && entry.tool_call_id === first.id)
      ).toBe(false)
      const later = { id: 'later-call', name: 'server__read', arguments: {} }
      const error = await f.recorder.recordDispatch(later).then(
        () => undefined,
        err => err
      )
      expect(error).toBeInstanceOf(Error)
      expect(error.kind).toBeUndefined()
      expect(append).toHaveBeenCalledTimes(1)
      await f.recorder.settle(undefined)
      expect(header(f.handle).status).toBe('abandoned')
      expect(f.recorder.appliedSettlement).toBe('abandoned')
    } finally {
      await f.handle.shutdown()
    }
  })

  it('executor releases a failed resumable settlement and delivers the original provider error', async () => {
    Object.assign(appConfig, {
      enableApproval: false,
      dynamicToolsEnabled: true,
      promptCacheEnabled: false,
      modelStepAutoRetries: 0,
    })
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const handles: ReturnType<typeof makeSqliteStore>[] = []
    const prepareOrigin = async () => {
      const handle = makeSqliteStore()
      handles.push(handle)
      const manager = new McpManager()
      const tool: McpTool = {
        name: 'server__read',
        serverName: 'server',
        inputSchema: { type: 'object' },
      }
      vi.spyOn(manager, 'getAllTools').mockReturnValue([tool])
      const execution = vi.spyOn(manager, 'callTool').mockResolvedValue({
        toolName: tool.name,
        result: { content: [{ type: 'text', text: 'origin effect completed' }] },
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
      const original = task('settlement-origin')
      const originalDeps = deps(handle, llm, manager)
      originalDeps.taskLifecycle.register(original)
      await new TaskExecutor(original, originalDeps).run()
      await handle.persistQueue.drain()
      expect(execution).toHaveBeenCalledTimes(1)
      expect(originalDeps.onFail).toHaveBeenCalledTimes(1)
      expect(header(handle).status).toBe('resumable')
      return { handle, original, originalDeps, execution }
    }
    try {
      const healthy = await prepareOrigin()
      const healthyModel = provider('openai', () => ({ content: 'neighbor completed' }))
      const healthyResult = await continueTurn(
        healthy.handle,
        healthy.original,
        healthy.originalDeps,
        healthyModel
      )
      expect(healthyResult.verdict).toHaveBeenCalledExactlyOnceWith({ kind: 'started' })
      expect(healthyModel.calls()).toBe(1)
      expect(healthy.originalDeps.onComplete).toHaveBeenCalledTimes(1)
      expect(header(healthy.handle).status).toBe('completed')

      const f = await prepareOrigin()
      const store = f.originalDeps.modelStepCheckpoints!.store
      const originalTimes = f.handle.worker.db
        .prepare('SELECT failed_at, expires_at FROM model_step_checkpoints')
        .get()
      const realTransition = store.transition.bind(store)
      let resumableAttempts = 0
      const transition = vi.spyOn(store, 'transition').mockImplementation(async (...args) => {
        if (args[2].to === 'resumable' && ++resumableAttempts === 1)
          throw new Error('SQLITE_IOERR resumable')
        return realTransition(...args)
      })
      const failedModel = provider('openai', () => ({ error: new Error('upstream 503') }))
      const resumed = await continueTurn(f.handle, f.original, f.originalDeps, failedModel)

      expect(resumed.verdict).toHaveBeenCalledExactlyOnceWith({ kind: 'started' })
      expect(failedModel.calls()).toBe(1)
      expect(transition.mock.calls.filter(args => args[2].to === 'resumable')).toHaveLength(2)
      expect(transition.mock.calls.filter(args => args[2].to === 'abandoned')).toHaveLength(0)
      expect(f.originalDeps.onFail).toHaveBeenCalledTimes(2)
      expect(f.originalDeps.onComplete).not.toHaveBeenCalled()
      expect(vi.mocked(f.originalDeps.onFail).mock.calls.at(-1)).toEqual([
        expect.objectContaining({ id: 'identity-continuation' }),
        expect.objectContaining({
          code: LlmErrorCode.ModelOverloaded,
          message: 'upstream 503',
          providerCode: 'provider_unavailable',
          retryable: true,
        }),
      ])
      expect(header(f.handle).status).toBe('resumable')
      expect(
        f.handle.worker.db.prepare('SELECT failed_at, expires_at FROM model_step_checkpoints').get()
      ).toEqual(originalTimes)
      const live = await store.loadLive(SESSION_KEY)
      expect(live && toModelStepCheckpointView(live, NOW)).toMatchObject({
        status: 'resumable',
        retryAvailable: true,
      })
      expect(
        f.handle.worker.db.prepare('SELECT state, active_task_id FROM sessions').get()
      ).toEqual({ state: 'idle', active_task_id: null })
      expect(
        f.handle.worker.db.prepare('SELECT count(*) AS count FROM pending_approvals').get()
      ).toEqual({ count: 0 })
      expect(f.originalDeps.conversationManager.getSessionByKey(SESSION_KEY)).toMatchObject({
        state: 'idle',
        activeTaskId: undefined,
      })
    } finally {
      for (const handle of handles) await handle.shutdown()
    }
  })

  it.each(['resumable', 'abandoned'] as const)(
    'exposes only an applied continuation %s settlement',
    async outcome => {
      const f = await claimedRecorder()
      try {
        const error = new LlmError(
          'provider unavailable',
          'openai',
          LlmErrorCode.ModelOverloaded,
          true,
          undefined,
          503,
          'provider_unavailable'
        )
        const transition = vi.spyOn(f.store, 'transition')
        await f.recorder.settle(outcome === 'resumable' ? { type: 'error', error } : undefined)
        expect(transition).toHaveBeenCalledTimes(1)
        expect(header(f.handle).status).toBe(outcome)
        expect(f.recorder.appliedSettlement).toBe(outcome)
        expect(f.recorder.claimReleased).toBe(true)
      } finally {
        await f.handle.shutdown()
      }
    }
  )

  it.each(['operational', 'lost'] as const)(
    'reports %s when a resumable settlement is not applied, retaining the loop error',
    async outcome => {
      const f = await claimedRecorder()
      try {
        const loopError = new LlmError(
          'provider unavailable',
          'openai',
          LlmErrorCode.ModelOverloaded,
          true,
          undefined,
          503,
          'provider_unavailable'
        )
        const storageError = new Error('resumable transition unavailable')
        const transition = vi.spyOn(f.store, 'transition')
        if (outcome === 'operational') transition.mockRejectedValueOnce(storageError)
        else transition.mockResolvedValueOnce(null)
        const error = await f.recorder.settle({ type: 'error', error: loopError }).then(
          () => undefined,
          err => err
        )

        expect(transition).toHaveBeenCalledTimes(1)
        expect(transition).toHaveBeenCalledWith(
          SESSION_KEY,
          expect.anything(),
          expect.objectContaining({ from: ['claimed'], to: 'resumable' })
        )
        expect.soft(error).toMatchObject({ kind: outcome })
        expect.soft(error?.loopError).toBe(loopError)
        if (outcome === 'operational') expect.soft(error).toHaveProperty('cause', storageError)
        expect(f.onFenceLost).toHaveBeenCalledTimes(outcome === 'lost' ? 1 : 0)
        expect(header(f.handle).status).toBe('claimed')
        expect(f.recorder.appliedSettlement).toBeUndefined()
        expect(f.recorder.claimReleased).toBe(false)
      } finally {
        await f.handle.shutdown()
      }
    }
  )

  it(
    'M4: a failed abandon is not released and executor cleanup abandons the owned claim',
    async () => {
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
        const appendOperation = store.append.bind(store)
        const resultWriteFailure = vi.fn()
        const append = vi.spyOn(store, 'append').mockImplementation(async (...args) => {
          if (
            args[2].some(entry => entry.kind === 'tool_result') &&
            !resultWriteFailure.mock.calls.length
          ) {
            resultWriteFailure()
            throw new Error('SQLITE_IOERR result')
          }
          return appendOperation(...args)
        })
        const transition = store.transition.bind(store)
        let abandonAttempts = 0
        const transitions = vi.spyOn(store, 'transition').mockImplementation(async (...args) => {
          if (args[2].to === 'abandoned' && ++abandonAttempts === 1)
            throw new Error('SQLITE_IOERR abandon')
          return transition(...args)
        })
        const cleanupPrototype = TaskExecutor.prototype as unknown as {
          abandonModelStepContinuation(): Promise<void>
          continuationClaim: { claimReleased: boolean }
        }
        const abandon = cleanupPrototype.abandonModelStepContinuation
        const releasedBeforeCleanup: boolean[] = []
        vi.spyOn(cleanupPrototype, 'abandonModelStepContinuation').mockImplementation(
          async function (this: typeof cleanupPrototype) {
            releasedBeforeCleanup.push(this.continuationClaim.claimReleased)
            return abandon.call(this)
          }
        )
        const resumed = provider('openai', (_messages, call) =>
          call <= 2
            ? {
                calls: [
                  {
                    id: `resumed-call-${call}`,
                    name: 'clerum__tool_call',
                    arguments: { name: tool.name, arguments: {} },
                  },
                ],
              }
            : { content: 'Read finished.' }
        )
        const { verdict, executor } = await continueTurn(handle, original, originalDeps, resumed)
        expect(verdict).toHaveBeenCalledWith({ kind: 'started' })
        // The first resumed tool ran before its result write failed. A later
        // dispatch is refused and retains the existing terminal treatment.
        expect(resumed.calls()).toBe(2)
        expect(append).toHaveBeenCalled()
        expect(resultWriteFailure).toHaveBeenCalledTimes(1)
        expect(execution).toHaveBeenCalledTimes(2)
        expect(transitions.mock.calls.filter(args => args[2].to === 'abandoned')).toHaveLength(2)
        expect(releasedBeforeCleanup).toEqual([false])
        expect(header(handle).status).toBe('abandoned')
        expect(
          (executor as unknown as { continuationClaim: { claimReleased: boolean } })
            .continuationClaim.claimReleased
        ).toBe(true)
      } finally {
        await handle.shutdown()
      }
    },
    AUTO_RETRY_TEST_TIMEOUT_MS
  )

  it('R3-L1: a rejected continuation dispatch write stops before the tool effect', async () => {
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
      const original = task('dispatch-gate-origin')
      const originalDeps = deps(handle, llm, manager)
      originalDeps.taskLifecycle.register(original)
      await new TaskExecutor(original, originalDeps).run()
      await handle.persistQueue.drain()
      expect(header(handle).status).toBe('resumable')
      expect(execution).toHaveBeenCalledTimes(1)

      const store = originalDeps.modelStepCheckpoints!.store
      const append = store.append.bind(store)
      const dispatched = vi.fn()
      vi.spyOn(store, 'append').mockImplementation(async (sessionKey, fence, entries) => {
        if (entries.some(entry => entry.kind === 'tool_dispatch')) {
          dispatched(entries)
          throw new Error('SQLITE_IOERR dispatch')
        }
        return append(sessionKey, fence, entries)
      })
      const resumed = provider('openai', () => ({
        calls: [
          {
            id: 'resumed-dispatch-call',
            name: 'clerum__tool_call',
            arguments: { name: tool.name, arguments: {} },
          },
        ],
      }))
      const { verdict } = await continueTurn(handle, original, originalDeps, resumed)
      expect(verdict).toHaveBeenCalledWith({ kind: 'started' })
      expect(dispatched).toHaveBeenCalledTimes(1)
      expect(dispatched.mock.calls[0]![0]).toEqual([
        expect.objectContaining({ kind: 'tool_dispatch', toolCallId: 'resumed-dispatch-call' }),
      ])
      // The origin effect is the only one; the resumed call never executed.
      expect(execution).toHaveBeenCalledTimes(1)
      // The origin's terminal 503 and the continuation's dispatch failure.
      expect(originalDeps.onFail).toHaveBeenCalledTimes(2)
      const continuationFailure = vi.mocked(originalDeps.onFail).mock.calls.at(-1)!
      expect(continuationFailure[0].id).toBe('identity-continuation')
      expect(continuationFailure[1]).toMatchObject({
        message: expect.stringContaining('dispatch'),
      })
      expect(header(handle).status).toBe('resumable')
      const live = await store.loadLive(SESSION_KEY)
      expect(live && toModelStepCheckpointView(live, NOW)).toMatchObject({
        status: 'resumable',
        retryAvailable: true,
      })
    } finally {
      await handle.shutdown()
    }
  })
})
