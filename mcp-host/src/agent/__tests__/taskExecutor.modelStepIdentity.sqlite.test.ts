import { afterEach, describe, expect, it, vi } from 'vitest'
import { config as appConfig } from '../../config'
import { ConversationManager } from '../../core/conversation/conversation'
import { toModelStepCheckpointView } from '../../core/conversation/modelStepCheckpointView'
import { makeSqliteStore } from '../../core/conversation/persistence/__tests__/testHelpers'
import { ModelStepCheckpointStore } from '../../core/conversation/persistence/modelStepCheckpointStore'
import { LlmError, LlmErrorCode } from '../../core/errors'
import { SimpleEventEmitter } from '../../core/orchestration/eventEmitter'
import { createModelStepCheckpointRecorder } from '../../core/orchestration/modelStepCheckpointRecorder'
import {
  ApprovalExpiredError,
  type ChatMessage,
  FinishReason,
  type ToolCall,
} from '../../core/types'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import { CodexProxyError } from '../../llm/codexLlmProxyClient'
import { CodexSubscriptionProvider } from '../../llm/codexSubscription'
import { FailoverEngine } from '../../llm/failover/engine'
import type { LlmPolicy } from '../../llm/failover/types'
import type { SingleTurnProvider } from '../../llm/types'
import { logger } from '../../logger'
import { McpManager } from '../../mcp/manager'
import type { Task, TaskError } from '../../queue/types'
import type { McpTool } from '../../types'
import { TaskExecutor, type TaskExecutorDeps } from '../taskExecutor'

const NOW = 1_700_000_000_000
const SESSION_KEY = 'identity-user:rpc:identity-channel:default'
const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
/**
 * The real Codex classifier the production adapter applies to a proxy failure;
 * classifyError reads the thrown error alone, so the provider deps are unused.
 */
const codexClassifier = new CodexSubscriptionProvider('primary-model', {
  authorizer: { authorize: vi.fn() },
  proxy: { stream: vi.fn() },
  attemptContext: vi.fn(),
} as never)
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
    classifyError: error =>
      // The 503 arm is the production failure shape: the real Codex classifier
      // decides the class, the retryability and the provider-native code, as
      // LlmPortAdapter.handleProviderError does (#1043 §2.1).
      error instanceof Error && error.message === 'upstream 503'
        ? codexClassifier.classifyError(new CodexProxyError('provider_unavailable', error.message))
        : {
            code: LlmErrorCode.ApiCallFailed,
            retryable: false,
            message: error instanceof Error ? error.message : String(error),
          },
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
  await new TaskExecutor(nextTask, nextDeps).run()
  await handle.persistQueue.drain()
  return verdict
}

async function waitingOrigin(
  withConfirmed = true,
  afterApproval: Reply | ((call: number) => Reply) = { error: new Error('upstream 503') }
) {
  Object.assign(appConfig, {
    enableApproval: true,
    dynamicToolsEnabled: false,
    promptCacheEnabled: false,
  })
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  const handle = makeSqliteStore()
  const manager = new McpManager()
  vi.spyOn(manager, 'getAllTools').mockReturnValue([
    { name: 'server__write', serverName: 'server', inputSchema: { type: 'object' } },
    { name: 'publisher__publish', serverName: 'publisher', inputSchema: { type: 'object' } },
  ])
  const execute = vi.spyOn(manager, 'callTool').mockResolvedValue({
    toolName: 'server__write',
    result: { content: [{ type: 'text', text: 'approved effect completed' }] },
    isError: false,
  })
  const llm = provider('openai', (_messages, call) =>
    call === 1
      ? {
          calls: [
            ...(withConfirmed
              ? [{ id: 'before-approval', name: 'system_info', arguments: {} }]
              : []),
            { id: 'approved-write', name: 'server__write', arguments: {} },
          ],
        }
      : typeof afterApproval === 'function'
        ? afterApproval(call)
        : afterApproval
  )
  const original = task('approval-origin')
  const originalDeps = deps(handle, llm, manager)
  originalDeps.taskLifecycle.register(original)
  const executor = new TaskExecutor(original, originalDeps)
  await executor.run()
  expect(executor.executorState).toBe('waiting_approval')
  expect(originalDeps.onApprovalNeeded).toHaveBeenCalledTimes(1)
  expect(llm.calls()).toBe(1)
  return { handle, execute, llm, original, originalDeps, executor }
}

async function claimedContinuation(
  llm: SingleTurnProvider,
  spilloverResolver?: TaskExecutorDeps['spilloverResolver']
) {
  const origin = await waitingOrigin()
  await origin.executor.resumeAfterApproval(false)
  const row = header(origin.handle)
  expect(row.status).toBe('resumable')
  const checkpoints = origin.originalDeps.modelStepCheckpoints!.store
  const claim = await checkpoints.claim({
    sessionKey: SESSION_KEY,
    checkpointId: row.checkpoint_id,
    version: row.version,
    hostInstanceId: 'instance-a',
    newTaskId: 'cleanup-continuation',
    leaseMs: 300_000,
  })
  if (claim.outcome !== 'claimed') throw new Error(`Claim failed: ${claim.outcome}`)
  const nextTask = task('cleanup-continuation')
  nextTask.modelStepContinuation = {
    checkpointId: row.checkpoint_id,
    originTaskId: origin.original.id,
    originTurnNumber: row.origin_turn_number,
    provider: row.provider,
    model: row.model,
    fence: claim.fence,
    confirmedResults: claim.snapshot.tools.confirmed,
    taskBudget: row.task_budget,
    onVerdict: vi.fn(),
  }
  const nextDeps: TaskExecutorDeps = {
    ...origin.originalDeps,
    llmProvider: llm,
    spilloverResolver,
    coreEvents: new SimpleEventEmitter(),
    taskLifecycle: new TaskLifecycle(),
    onFail: vi.fn(),
    onComplete: vi.fn(),
    onApprovalNeeded: vi.fn(),
  }
  nextDeps.taskLifecycle.register(nextTask)
  origin.execute.mockClear()
  return {
    handle: origin.handle,
    execute: origin.execute,
    checkpoints,
    fence: claim.fence,
    task: nextTask,
    deps: nextDeps,
    executor: new TaskExecutor(nextTask, nextDeps),
  }
}

function approvalProvider() {
  return provider('openai', (_messages, call) =>
    call === 1
      ? {
          calls: [
            { id: 'continuation-before-approval', name: 'system_info', arguments: {} },
            { id: 'continuation-approved-write', name: 'publisher__publish', arguments: {} },
          ],
        }
      : { content: 'approved continuation completed' }
  )
}

describe('real-producer checkpoint identity regressions', () => {
  afterEach(() => {
    Object.assign(appConfig, savedConfig)
    vi.restoreAllMocks()
  })

  it.each([false, true])(
    '#1156: expired approval releases the local turn with replacement owner=%s',
    async replacement => {
      const resolve = vi.fn()
      const llm = approvalProvider()
      const f = await claimedContinuation(llm, {
        resolve,
        probe: vi.fn(async () => ({ alive: [], expired: [] })),
      })
      try {
        await f.executor.run()
        expect(f.executor.executorState).toBe('waiting_approval')
        expect(f.deps.onApprovalNeeded).toHaveBeenCalledTimes(1)
        const approval = f.executor.pendingApproval!
        const expired = new ApprovalExpiredError({
          code: 'approval_expired',
          request_id: approval.request_id,
          task_id: f.task.id,
          tool_name: approval.tool_name,
          expired_refs: [],
          user_message: 'Approved content has expired.',
        })
        let replacementFence = f.fence
        resolve.mockImplementationOnce(async () => {
          if (replacement) {
            const replacementStore = new ModelStepCheckpointStore(f.handle.persistQueue, {
              now: () => NOW + 300_001,
              blockedTtlMs: 7 * 24 * 3_600_000,
            })
            const claim = await replacementStore.claim({
              sessionKey: SESSION_KEY,
              checkpointId: f.fence.checkpointId,
              version: header(f.handle).version,
              hostInstanceId: 'replacement-instance',
              newTaskId: 'replacement-task',
              leaseMs: 300_000,
            })
            expect(claim.outcome).toBe('claimed')
            if (claim.outcome !== 'claimed') throw new Error(`Claim failed: ${claim.outcome}`)
            replacementFence = claim.fence
          }
          throw expired
        })
        const failTurn = vi.spyOn(f.deps.conversationManager, 'failTurn')
        await f.executor.resumeAfterApproval(false)
        await f.handle.persistQueue.drain()
        expect(resolve).toHaveBeenCalledTimes(1)
        expect(f.deps.onFail).toHaveBeenCalledExactlyOnceWith(
          f.task,
          expect.objectContaining({ code: 'approval_expired', message: expired.message })
        )
        const conversation = f.deps.conversationManager.getSessionByKey(SESSION_KEY)!
        expect(conversation.state).toBe('idle')
        expect(conversation.activeTaskId).toBeUndefined()
        expect(
          f.handle.worker.db.prepare('SELECT state, active_task_id FROM sessions').get()
        ).toEqual({
          state: 'idle',
          active_task_id: null,
        })
        expect(f.execute).toHaveBeenCalledTimes(0)
        expect(llm.calls()).toBe(1)
        if (replacement) {
          expect(header(f.handle)).toMatchObject({
            status: 'claimed',
            claim_owner: replacementFence.owner,
            claim_generation: replacementFence.generation,
          })
          expect(replacementFence.generation).toBeGreaterThan(f.fence.generation)
          expect(failTurn).toHaveBeenCalledExactlyOnceWith(conversation)
        } else {
          expect(header(f.handle).status).toBe('abandoned')
          expect(failTurn).toHaveBeenCalledExactlyOnceWith(conversation, {
            fence: f.fence,
            activeTaskId: f.task.id,
            originTurnNumber: f.task.modelStepContinuation!.originTurnNumber,
          })
        }
      } finally {
        await f.handle.shutdown()
      }
    }
  )

  it('#1156: expired approval keeps approval_expired when the abandon rejects', async () => {
    const resolve = vi.fn()
    const f = await claimedContinuation(approvalProvider(), {
      resolve,
      probe: vi.fn(async () => ({ alive: [], expired: [] })),
    })
    try {
      await f.executor.run()
      expect(f.executor.executorState).toBe('waiting_approval')
      const approval = f.executor.pendingApproval!
      const expired = new ApprovalExpiredError({
        code: 'approval_expired',
        request_id: approval.request_id,
        task_id: f.task.id,
        tool_name: approval.tool_name,
        expired_refs: [],
        user_message: 'Approved content has expired.',
      })
      resolve.mockRejectedValueOnce(expired)
      const transition = f.checkpoints.transition.bind(f.checkpoints)
      const rejected = vi
        .spyOn(f.checkpoints, 'transition')
        .mockImplementation((sessionKey, fence, input) => {
          if (input.to === 'abandoned') throw new TypeError('abandon failure body')
          return transition(sessionKey, fence, input)
        })
      const logged = vi.spyOn(logger, 'error')
      await f.executor.resumeAfterApproval(false)
      expect(resolve).toHaveBeenCalledTimes(1)
      expect(rejected).toHaveBeenCalledWith(
        SESSION_KEY,
        f.fence,
        expect.objectContaining({ to: 'abandoned' })
      )
      expect(f.deps.onFail).toHaveBeenCalledExactlyOnceWith(
        f.task,
        expect.objectContaining({ code: 'approval_expired', message: expired.message })
      )
      expect(logged).toHaveBeenCalledWith(
        {
          taskId: f.task.id,
          checkpointId: f.fence.checkpointId,
          op: 'abandon',
          errorName: 'TypeError',
        },
        'Model-step continuation cleanup failed'
      )
      expect(header(f.handle).status).toBe('claimed')
      expect(f.execute).toHaveBeenCalledTimes(0)
    } finally {
      await f.handle.shutdown()
    }
  })

  it('#1157: a lost claim at approval keeps its error when releasing the turn rejects', async () => {
    const llm = approvalProvider()
    const f = await claimedContinuation(llm)
    try {
      await f.executor.run()
      expect(f.executor.executorState).toBe('waiting_approval')
      const renew = vi.spyOn(f.checkpoints, 'renewLease').mockResolvedValue(false)
      const releaseError = new TypeError('turn release failure body')
      const failTurn = vi
        .spyOn(f.deps.conversationManager, 'failTurn')
        .mockRejectedValue(releaseError)
      const deny = vi.spyOn(f.deps.conversationManager, 'deny').mockRejectedValue(releaseError)
      const logged = vi.spyOn(logger, 'error')
      await f.executor.resumeAfterApproval(false)
      expect(renew).toHaveBeenCalled()
      expect(failTurn.mock.calls.length + deny.mock.calls.length).toBeGreaterThan(0)
      expect(f.deps.onFail).toHaveBeenCalledExactlyOnceWith(
        f.task,
        expect.objectContaining({
          message: 'Model-step continuation claim was lost during approval',
        })
      )
      expect(logged).toHaveBeenCalledWith(
        {
          taskId: f.task.id,
          checkpointId: f.fence.checkpointId,
          op: 'fail_turn',
          errorName: 'TypeError',
        },
        'Model-step continuation cleanup failed'
      )
      expect(f.execute).toHaveBeenCalledTimes(0)
      expect(llm.calls()).toBe(1)
    } finally {
      await f.handle.shutdown()
    }
  })

  it.each([
    { entry: 'run', cleanup: 'abandon' },
    { entry: 'run', cleanup: 'fail_turn' },
    { entry: 'resume', cleanup: 'abandon' },
    { entry: 'resume', cleanup: 'fail_turn' },
  ] as const)(
    'D1/#1157: $entry preserves the loop error when $cleanup rejects',
    async ({ entry, cleanup }) => {
      const llm = approvalProvider()
      const f = await claimedContinuation(llm)
      try {
        if (entry === 'resume') {
          await f.executor.run()
          expect(f.executor.executorState).toBe('waiting_approval')
          expect(f.deps.onApprovalNeeded).toHaveBeenCalledTimes(1)
        }
        const loopError = new LlmError(
          'original loop failure',
          'openai',
          LlmErrorCode.RateLimited,
          true
        )
        const emit = f.deps.coreEvents.emit.bind(f.deps.coreEvents)
        const loop = vi.spyOn(f.deps.coreEvents, 'emit').mockImplementation(event => {
          if (event.type === 'loop:iteration') throw loopError
          emit(event)
        })
        const cleanupError = new TypeError('cleanup failure body must not be logged')
        const rejected =
          cleanup === 'abandon'
            ? vi.spyOn(f.checkpoints, 'transition').mockRejectedValue(cleanupError)
            : vi.spyOn(f.deps.conversationManager, 'failTurn').mockRejectedValue(cleanupError)
        const logged = vi.spyOn(logger, 'error')
        const escaped = await (
          entry === 'run' ? f.executor.run() : f.executor.resumeAfterApproval(false)
        ).then(
          () => undefined,
          error => error
        )
        expect(loop).toHaveBeenCalledWith(expect.objectContaining({ type: 'loop:iteration' }))
        expect(rejected).toHaveBeenCalled()
        expect(f.deps.onFail).toHaveBeenCalledExactlyOnceWith(
          f.task,
          expect.objectContaining({ code: loopError.code, message: loopError.message })
        )
        expect(logged).toHaveBeenCalledWith(
          {
            taskId: f.task.id,
            checkpointId: f.fence.checkpointId,
            op: cleanup,
            errorName: 'TypeError',
          },
          'Model-step continuation cleanup failed'
        )
        expect(escaped).toBeUndefined()
        expect(f.executor.executorState).toBe('failed')
        if (cleanup === 'abandon') {
          expect(header(f.handle).status).toBe('claimed')
          expect(await f.checkpoints.renewLease(SESSION_KEY, f.fence, 300_000)).toBe(true)
        }
      } finally {
        await f.handle.shutdown()
      }
    }
  )

  it.each(['tool_dispatch', 'tool_result'] as const)(
    'M-1: fresh approval completes when append rejects at %s',
    async kind => {
      const f = await waitingOrigin(true, { content: 'approved effect accepted' })
      try {
        const checkpoints = f.originalDeps.modelStepCheckpoints!.store
        const append = checkpoints.append.bind(checkpoints)
        const rejected = vi.fn()
        vi.spyOn(checkpoints, 'append').mockImplementation(async (...args) => {
          if (args[2].some(entry => entry.kind === kind && entry.toolCallId === 'approved-write')) {
            rejected()
            throw new Error('injected approval append failure')
          }
          return append(...args)
        })
        await f.executor.resumeAfterApproval(false)
        expect(rejected).toHaveBeenCalledTimes(1)
        expect(f.execute).toHaveBeenCalledTimes(1)
        expect(f.llm.calls()).toBe(2)
        expect(f.llm.requests[1]!.filter(m => m.tool_call_id === 'approved-write')).toEqual([
          expect.objectContaining({
            content: expect.stringContaining('approved effect completed'),
          }),
        ])
        expect(f.originalDeps.onComplete).toHaveBeenCalledExactlyOnceWith(f.original)
        expect(f.originalDeps.onFail).not.toHaveBeenCalled()
        expect(await checkpoints.loadLive(SESSION_KEY)).toBeNull()
        expect(header(f.handle)).toBeUndefined()
      } finally {
        await f.handle.shutdown()
      }
    }
  )

  it.each(['tool_dispatch', 'tool_result'] as const)(
    'M-1: continuation approval fails when append rejects at %s',
    async kind => {
      const llm = approvalProvider()
      const f = await claimedContinuation(llm)
      try {
        await f.executor.run()
        expect(f.executor.executorState).toBe('waiting_approval')
        expect(f.deps.onApprovalNeeded).toHaveBeenCalledTimes(1)
        const append = f.checkpoints.append.bind(f.checkpoints)
        const rejected = vi.fn()
        vi.spyOn(f.checkpoints, 'append').mockImplementation(async (...args) => {
          if (
            args[2].some(
              entry => entry.kind === kind && entry.toolCallId === 'continuation-approved-write'
            )
          ) {
            rejected()
            throw new Error('injected continuation append failure')
          }
          return append(...args)
        })
        await f.executor.resumeAfterApproval(false)
        expect(rejected).toHaveBeenCalledTimes(1)
        expect(f.deps.onFail).toHaveBeenCalledExactlyOnceWith(
          f.task,
          expect.objectContaining({
            code: LlmErrorCode.ApiCallFailed,
            message: `Model-step continuation approved ${kind === 'tool_dispatch' ? 'dispatch' : 'result'} could not be recorded`,
          })
        )
        expect(f.execute).toHaveBeenCalledTimes(kind === 'tool_dispatch' ? 0 : 1)
        expect(llm.calls()).toBe(1)
        expect(header(f.handle).status).toBe('abandoned')
        expect(f.deps.onComplete).not.toHaveBeenCalled()
      } finally {
        await f.handle.shutdown()
      }
    }
  )

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
        // The 503 is retried once automatically before it settles (N=1).
        expect(llm.calls()).toBe(3)
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
      // The 503 is retried once automatically before it settles (N=1).
      expect(llm.calls()).toBe(3)
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

  it('C-1: the checkpoint keeps the configured pair after fallback tool results', async () => {
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
      // Two fallback calls plus the automatic retry of the failed step (N=1).
      expect(fallback.calls()).toBe(3)
      expect(header(handle)).toMatchObject({
        status: 'resumable',
        provider: 'claude',
        model: 'primary-model',
      })
    } finally {
      await handle.shutdown()
    }
  })
  it.each([true, false])(
    'C-5: warm approval (prior tool=%s) offers Retry after 503 and completes without replay',
    async withConfirmed => {
      const f = await waitingOrigin(withConfirmed)
      try {
        if (withConfirmed) expect(header(f.handle)).toMatchObject({ status: 'open' })
        else expect(header(f.handle)).toBeUndefined()
        await f.executor.resumeAfterApproval(false)
        await f.handle.persistQueue.drain()
        expect(f.execute).toHaveBeenCalledTimes(1)
        // The post-approval 503 is retried once automatically (N=1).
        expect(f.llm.calls()).toBe(3)
        expect(f.llm.requests[1]!.filter(m => m.tool_call_id === 'approved-write')).toEqual([
          expect.objectContaining({
            tool_call_id: 'approved-write',
            content: expect.stringContaining('approved effect completed'),
          }),
        ])
        expect(header(f.handle)).toMatchObject({ status: 'resumable' })
        expect(
          toModelStepCheckpointView(
            (await f.originalDeps.modelStepCheckpoints!.store.loadLive(SESSION_KEY))!
          )
        ).toMatchObject({ retryAvailable: true, tools: { confirmed: withConfirmed ? 2 : 1 } })
        expect(f.originalDeps.onFail).toHaveBeenCalledWith(
          f.original,
          expect.objectContaining({
            code: LlmErrorCode.ModelOverloaded,
            modelStepCheckpointId: header(f.handle).checkpoint_id,
          })
        )
        const resumed = provider('openai', () => ({ content: 'approval continuation completed' }))
        const verdict = await continueTurn(f.handle, f.original, f.originalDeps, resumed)
        expect(verdict).toHaveBeenCalledWith({ kind: 'started' })
        expect(resumed.calls()).toBe(1)
        expect(resumed.requests[0]!.filter(m => m.tool_call_id === 'approved-write')).toEqual([
          expect.objectContaining({
            tool_call_id: 'approved-write',
            content: expect.stringContaining('approved effect completed'),
          }),
        ])
        expect(f.execute).toHaveBeenCalledTimes(1)
        expect(header(f.handle).status).toBe('completed')
      } finally {
        await f.handle.shutdown()
      }
    }
  )

  it.each(['deny', 'cancel'] as const)(
    'C-5: %s abandons the retained open approval checkpoint',
    async action => {
      const f = await waitingOrigin()
      try {
        expect(header(f.handle)).toMatchObject({ status: 'open' })
        const settled = vi.spyOn(f.originalDeps.modelStepCheckpoints!.store, 'transition')
        if (action === 'deny') await f.executor.deny()
        else {
          f.executor.abort()
          await f.executor.waitForCompletion()
          expect(f.executor.signal.aborted).toBe(true)
        }
        await f.handle.persistQueue.drain()
        expect(settled).toHaveBeenCalledWith(
          SESSION_KEY,
          expect.objectContaining({ checkpointId: expect.any(String) }),
          { from: ['open'], to: 'abandoned' }
        )
        expect(await settled.mock.results[0]!.value).not.toBeNull()
        expect(header(f.handle)).toBeUndefined()
        expect(f.execute).toHaveBeenCalledTimes(0)
        expect(f.llm.calls()).toBe(1)
      } finally {
        await f.handle.shutdown()
      }
    }
  )

  // #1043 §2.1 (F11) — the production shape: the warm-approval origin keeps the
  // approved result, its model step fails once, and the automatic retry answers
  // inside the same task without executing the approved tool again.
  it('H7: a warm-approval origin survives a dispatched 503 through the automatic retry', async () => {
    const f = await waitingOrigin(true, call =>
      call === 2 ? { error: new Error('upstream 503') } : { content: 'answer after the retry' }
    )
    try {
      await f.executor.resumeAfterApproval(true)
      await f.handle.persistQueue.drain()

      // Three calls: the approval request, the failed step and its retry.
      expect(f.llm.calls()).toBe(3)
      expect(f.originalDeps.onComplete).toHaveBeenCalledTimes(1)
      expect(f.originalDeps.onFail).not.toHaveBeenCalled()
      expect(f.execute).toHaveBeenCalledTimes(1)
      // The retry reuses the approved result instead of re-running the tool.
      expect(
        f.llm.requests[2]!.filter(message => message.tool_call_id === 'approved-write')
      ).toEqual([
        expect.objectContaining({
          tool_call_id: 'approved-write',
          content: expect.stringContaining('approved effect completed'),
        }),
      ])
      // The answered origin turn is persisted and its checkpoint purged, so no
      // resumable row is left behind.
      expect(
        f.handle.worker.db.prepare("SELECT content FROM messages WHERE role = 'assistant'").all()
      ).toEqual([{ content: 'answer after the retry' }])
      expect(header(f.handle)).toBeUndefined()
    } finally {
      await f.handle.shutdown()
    }
  })

  it('C-5: boot abandons an open approval checkpoint and cold resume offers no Retry', async () => {
    const f = await waitingOrigin()
    try {
      const row = header(f.handle)
      expect(row).toMatchObject({ status: 'open' })
      const checkpoints = f.originalDeps.modelStepCheckpoints!.store
      expect(await checkpoints.bootReap('replacement-instance')).toEqual({
        abandoned: 1,
        reopened: 0,
      })
      expect(header(f.handle)).toBeUndefined()
      const cold = new TaskExecutor(f.original, f.originalDeps)
      await cold.rehydrateWaitingApproval(SESSION_KEY, f.executor.pendingApproval!)
      await cold.resumeAfterApproval(false)
      expect(f.execute).toHaveBeenCalledTimes(1)
      expect(f.llm.calls()).toBe(2)
      expect(f.originalDeps.onFail).toHaveBeenCalledWith(
        f.original,
        expect.objectContaining({ code: LlmErrorCode.ModelOverloaded })
      )
      expect(
        (f.originalDeps.onFail as ReturnType<typeof vi.fn>).mock.calls[0]![1].modelStepCheckpointId
      ).toBeUndefined()
      expect(await checkpoints.loadLive(SESSION_KEY)).toBeNull()
    } finally {
      await f.handle.shutdown()
    }
  })

  it('C-6: failed resumable settlement abandons the header and preserves the original turn error', async () => {
    Object.assign(appConfig, {
      enableApproval: false,
      dynamicToolsEnabled: false,
      promptCacheEnabled: false,
    })
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const handle = makeSqliteStore()
    try {
      const llm = provider('openai', (_messages, call) =>
        call === 1
          ? { calls: [{ id: 'tool-before-failure', name: 'system_info', arguments: {} }] }
          : { error: new Error('upstream 503') }
      )
      const original = task('settlement-failure')
      const originalDeps = deps(handle, llm)
      const checkpoints = originalDeps.modelStepCheckpoints!.store
      const writes = vi.spyOn(checkpoints, 'transition').mockImplementationOnce(async () => {
        throw new Error('injected write failure')
      })
      originalDeps.taskLifecycle.register(original)
      await new TaskExecutor(original, originalDeps).run()
      // The 503 is retried once automatically before settlement (N=1).
      expect(llm.calls()).toBe(3)
      expect(llm.requests[1]!.filter(m => m.role === 'tool')).toHaveLength(1)
      expect(originalDeps.onFail).toHaveBeenCalledWith(
        original,
        expect.objectContaining({
          code: LlmErrorCode.ModelOverloaded,
          message: 'upstream 503',
          providerCode: 'provider_unavailable',
        })
      )
      expect(writes).toHaveBeenCalledTimes(2)
      expect(writes).toHaveBeenLastCalledWith(SESSION_KEY, expect.any(Object), {
        from: ['open'],
        to: 'abandoned',
      })
      expect(await writes.mock.results[1]!.value).not.toBeNull()
      expect(header(handle)).toBeUndefined()
      expect(await checkpoints.sweep()).toMatchObject({ purgedCheckpoints: 0 })
      expect(header(handle)).toBeUndefined()
    } finally {
      await handle.shutdown()
    }
  })

  it.each(['write_failure', 'fence_lost'] as const)(
    'C-6: cleanup %s logs safe fields and preserves the original failure',
    async cleanup => {
      Object.assign(appConfig, {
        enableApproval: false,
        dynamicToolsEnabled: false,
        promptCacheEnabled: false,
      })
      vi.spyOn(Date, 'now').mockReturnValue(NOW)
      const handle = makeSqliteStore()
      try {
        const llm = provider('openai', (_messages, call) =>
          call === 1
            ? { calls: [{ id: 'confirmed-tool', name: 'system_info', arguments: {} }] }
            : { error: new Error('upstream 503') }
        )
        const original = task('cleanup-failure')
        const originalDeps = deps(handle, llm)
        const writes = vi
          .spyOn(originalDeps.modelStepCheckpoints!.store, 'transition')
          .mockRejectedValueOnce(new Error('initial storage failure'))
        if (cleanup === 'write_failure')
          writes.mockRejectedValueOnce(new Error('private checkpoint body'))
        else writes.mockResolvedValueOnce(null)
        const warning = vi.spyOn(logger, 'warn')
        originalDeps.taskLifecycle.register(original)
        await new TaskExecutor(original, originalDeps).run()
        // The 503 is retried once automatically before settlement (N=1).
        expect(llm.calls()).toBe(3)
        expect(llm.requests[1]!.some(m => m.tool_call_id === 'confirmed-tool')).toBe(true)
        expect(writes).toHaveBeenCalledTimes(2)
        expect(warning).toHaveBeenCalledWith(
          { checkpointId: header(handle).checkpoint_id, op: 'abandon', errorName: 'Error' },
          'model-step checkpoint cleanup failed after resumable settlement failure'
        )
        expect(originalDeps.onFail).toHaveBeenCalledExactlyOnceWith(
          original,
          expect.objectContaining({
            code: LlmErrorCode.ModelOverloaded,
            message: 'upstream 503',
            providerCode: 'provider_unavailable',
          })
        )
        expect(
          (originalDeps.onFail as ReturnType<typeof vi.fn>).mock.calls[0]![1].modelStepCheckpointId
        ).toBeUndefined()
      } finally {
        await handle.shutdown()
      }
    }
  )
  it('C-3: a reaped reused-ID dispatch stays unknown and continuation never replays the confirmed tool', async () => {
    Object.assign(appConfig, {
      enableApproval: false,
      dynamicToolsEnabled: false,
      promptCacheEnabled: false,
    })
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const handle = makeSqliteStore()
    try {
      const manager = new McpManager()
      vi.spyOn(manager, 'getAllTools').mockReturnValue([
        { name: 'server__write', serverName: 'server', inputSchema: { type: 'object' } },
      ])
      const execute = vi.spyOn(manager, 'callTool').mockResolvedValue({
        toolName: 'server__write',
        result: { content: [{ type: 'text', text: 'confirmed first effect' }] },
        isError: false,
      })
      const call = { id: 'call_0', name: 'server__write', arguments: {} }
      const llm = provider('openai', (_messages, attempt) =>
        attempt === 1 ? { calls: [call] } : { error: new Error('upstream 503') }
      )
      const original = task('reused-id-origin')
      const originalDeps = deps(handle, llm, manager)
      originalDeps.taskLifecycle.register(original)
      await new TaskExecutor(original, originalDeps).run()
      expect(execute).toHaveBeenCalledTimes(1)
      // The 503 is retried once automatically before it settles (N=1).
      expect(llm.calls()).toBe(3)
      const checkpoints = originalDeps.modelStepCheckpoints!.store
      const row = header(handle)
      expect(row.status).toBe('resumable')
      const claim = await checkpoints.claim({
        sessionKey: SESSION_KEY,
        checkpointId: row.checkpoint_id,
        version: row.version,
        hostInstanceId: 'interrupted-instance',
        newTaskId: 'interrupted-task',
        leaseMs: 300_000,
      })
      if (claim.outcome !== 'claimed') throw new Error(`Claim failed: ${claim.outcome}`)
      const recordedMessages = (await checkpoints.loadEntries(SESSION_KEY, row.checkpoint_id))
        .filter(entry => entry.kind === 'message')
        .map(entry => JSON.parse(entry.payload) as ChatMessage)
      const recorder = createModelStepCheckpointRecorder({
        store: checkpoints,
        sessionKey: SESSION_KEY,
        mode: {
          kind: 'continuation',
          fence: claim.fence,
          confirmedResults: claim.snapshot.tools.confirmed,
          loopState: claim.snapshot.header.loop_state,
        },
        redact: text => text,
        taskBudget: () => claim.snapshot.header.task_budget,
        resumableTtlMs: 86_400_000,
        attachmentTtlMs: 3_600_000,
        now: () => NOW,
        onFenceLost: () => {
          throw new Error('Unexpected producer fence loss')
        },
      })
      await recorder.begin(recordedMessages)
      await recorder.syncMessages([
        ...recordedMessages,
        { role: 'assistant', content: '', tool_calls: [call] },
      ])
      await recorder.recordDispatch(call)
      // Simulate process loss between the durable dispatch and its tool effect.
      expect((await checkpoints.loadLive(SESSION_KEY))!.tools).toEqual({
        confirmed: 1,
        unknown: 1,
        notDispatched: 0,
      })
      expect(await checkpoints.bootReap('instance-a')).toEqual({ abandoned: 0, reopened: 1 })
      expect(header(handle).status).toBe('resumable')
      const resumed = provider('openai', () => ({ content: 'Recovered without replay' }))
      const verdict = await continueTurn(handle, original, originalDeps, resumed)
      expect(verdict).toHaveBeenCalledWith({ kind: 'started' })
      expect(resumed.calls()).toBe(1)
      expect(
        resumed.requests[0]!.filter(m => m.role === 'tool' && m.tool_call_id === 'call_0')
      ).toEqual([
        expect.objectContaining({ content: expect.stringContaining('confirmed first effect') }),
        expect.objectContaining({ content: 'Tool outcome unknown; not re-executed' }),
      ])
      expect(execute).toHaveBeenCalledTimes(1)
      expect(originalDeps.onComplete).toHaveBeenCalledTimes(1)
      expect(header(handle).status).toBe('completed')
    } finally {
      await handle.shutdown()
    }
  })
})
