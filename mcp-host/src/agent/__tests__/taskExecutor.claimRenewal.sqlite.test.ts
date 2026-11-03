import { afterEach, describe, expect, it, vi } from 'vitest'
import { config as appConfig } from '../../config'
import { ConversationManager } from '../../core/conversation/conversation'
import { toModelStepCheckpointView } from '../../core/conversation/modelStepCheckpointView'
import { makeSqliteStore } from '../../core/conversation/persistence/__tests__/testHelpers'
import { ModelStepCheckpointStore } from '../../core/conversation/persistence/modelStepCheckpointStore'
import { LlmError, LlmErrorCode } from '../../core/errors'
import { AUTO_RETRY_TEST_TIMEOUT_MS } from '../../core/orchestration/__tests__/modelStepRetryTestTimeout'
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
import { GrokProxyError } from '../../llm/grokLlmProxyClient'
import { GrokSubscriptionProvider } from '../../llm/grokSubscription'
import type { ClassifiedError, SingleTurnProvider } from '../../llm/types'
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
/**
 * The same for Grok: the executor's provider identity must survive the port's
 * classification so the loop-level retry gate sees `grok-subscription`.
 */
const grokClassifier = new GrokSubscriptionProvider('grok-4.6', {
  authorizer: { authorize: vi.fn() },
  proxy: { stream: vi.fn() },
  attemptContext: vi.fn(),
} as never)

interface ProviderIdentity {
  kind: 'openai' | 'grok-subscription'
  classify: (error: Error) => ClassifiedError
}
const CODEX_IDENTITY: ProviderIdentity = {
  kind: 'openai',
  classify: error =>
    codexClassifier.classifyError(new CodexProxyError('provider_unavailable', error.message)),
}
const GROK_IDENTITY: ProviderIdentity = {
  kind: 'grok-subscription',
  classify: error =>
    grokClassifier.classifyError(new GrokProxyError('provider_unavailable', error.message)),
}
const savedConfig = {
  enableApproval: appConfig.enableApproval,
  dynamicToolsEnabled: appConfig.dynamicToolsEnabled,
  promptCacheEnabled: appConfig.promptCacheEnabled,
  nativeToolPresentation: appConfig.nativeToolPresentation,
  nativeToolDiscoveryBytes: appConfig.nativeToolDiscoveryBytes,
  codexToolPresentation: appConfig.codexToolPresentation,
  modelStepAutoRetries: appConfig.modelStepAutoRetries,
}

type Reply = { calls?: ToolCall[]; content?: string; error?: Error }
function provider(
  kind: string,
  answer: (messages: ChatMessage[], call: number) => Reply,
  classifyWith: (error: Error) => ClassifiedError = CODEX_IDENTITY.classify
): SingleTurnProvider & {
  calls(): number
  requests: ChatMessage[][]
  classifications: ClassifiedError[]
} {
  let count = 0
  const requests: ChatMessage[][] = []
  const classifications: ClassifiedError[] = []
  return {
    calls: () => count,
    requests,
    classifications,
    getProviderType: () => kind as never,
    classifyError: error => {
      // The 503 arm is the production failure shape: the real provider
      // classifier decides the class, the retryability and the provider-native
      // code, as LlmPortAdapter.handleProviderError does (#1043 §2.1).
      if (error instanceof Error && error.message === 'upstream 503') {
        const classified = classifyWith(error)
        classifications.push(classified)
        return classified
      }
      return {
        code: LlmErrorCode.ApiCallFailed,
        retryable: false,
        message: error instanceof Error ? error.message : String(error),
      }
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
  afterApproval: Reply | ((call: number) => Reply) = { error: new Error('upstream 503') },
  identity: ProviderIdentity = CODEX_IDENTITY
) {
  Object.assign(appConfig, {
    enableApproval: true,
    dynamicToolsEnabled: false,
    promptCacheEnabled: false,
    // 'grok-subscription' is an OAuth-broker presentation target, so the tool
    // presentation comes from this flag instead of `dynamicToolsEnabled`; the
    // discovery bridge would hide `server__write` behind `clerum__tool_call`.
    codexToolPresentation: 'direct',
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
  const llm = provider(
    identity.kind,
    (_messages, call) =>
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
          : afterApproval,
    identity.classify
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

function pendingApprovalCount(handle: ReturnType<typeof makeSqliteStore>): number {
  const row = handle.worker.db.prepare('SELECT COUNT(*) AS n FROM pending_approvals').get() as {
    n: number
  }
  return row.n
}

/**
 * P3 precheck, spec test (g): "approval-time renew rejects once:
 * `pending_approvals` count 0 (liveness: the row existed before the renew),
 * one terminal signal, claim `resumable` or expired by lease."
 *
 * At HEAD 7907a1dac the renew throw is `ContinuationLeaseRenewalError`
 * (taskExecutor.ts:899-919) raised from `requireContinuationClaim` before
 * `conversationManager.approve` (:1482-1483); the catch (:1768-1773) skips
 * `abandon` and runs a fenced `failTurn`, which never deletes the
 * pending_approvals row (sqliteConversationStore.ts:1015-1057).
 */
describe('P3 precheck (g)', () => {
  afterEach(() => {
    Object.assign(appConfig, savedConfig)
    vi.restoreAllMocks()
  })

  it(
    '(g) approval-time renew rejection must leave pending_approvals count 0',
    async () => {
      const healthy = await claimedContinuation(provider('openai', () => ({ content: 'done' })))
      try {
        await healthy.executor.run()
        expect(healthy.deps.onComplete).toHaveBeenCalledTimes(1)
        expect(healthy.deps.onFail).not.toHaveBeenCalled()
        expect(header(healthy.handle).status).toBe('completed')
      } finally {
        await healthy.handle.shutdown()
      }
      const llm = approvalProvider()
      const f = await claimedContinuation(llm)
      try {
        await f.executor.run()
        expect(f.executor.executorState).toBe('waiting_approval')
        const approval = f.executor.pendingApproval!
        expect(approval.request_id).toBeTruthy()

        // Liveness: the row existed before the renew.
        expect(pendingApprovalCount(f.handle)).toBe(1)

        const renew = vi
          .spyOn(f.checkpoints, 'renewLease')
          .mockRejectedValueOnce(new TypeError('renew rejection body'))

        await f.executor.resumeAfterApproval(false)
        await f.handle.persistQueue.drain()

        expect(renew).toHaveBeenCalledTimes(1)

        // Exactly one terminal signal.
        expect(f.deps.onFail).toHaveBeenCalledTimes(1)
        expect(f.deps.onComplete).toHaveBeenCalledTimes(0)

        // Diagnostics for the evidence record.
        console.log(
          'P3-OBSERVED ' +
            JSON.stringify({
              pendingApprovals: pendingApprovalCount(f.handle),
              claimStatus: header(f.handle).status,
              onFail: vi.mocked(f.deps.onFail).mock.calls.length,
              onComplete: vi.mocked(f.deps.onComplete).mock.calls.length,
            })
        )
        // The spec's assertion: no orphan approval row survives.
        expect(pendingApprovalCount(f.handle)).toBe(0)

        // The claim is resumable, or expired so a later reclaim works.
        const status = header(f.handle).status
        if (status !== 'resumable') {
          const laterStore = new ModelStepCheckpointStore(f.handle.persistQueue, {
            now: () => NOW + 300_001,
            blockedTtlMs: 7 * 24 * 3_600_000,
          })
          const later = await laterStore.claim({
            sessionKey: SESSION_KEY,
            checkpointId: f.fence.checkpointId,
            version: header(f.handle).version,
            hostInstanceId: 'replacement-instance',
            newTaskId: 'replacement-task',
            leaseMs: 300_000,
          })
          expect(later.outcome).toBe('claimed')
        }
      } finally {
        await f.handle.shutdown()
      }
    },
    AUTO_RETRY_TEST_TIMEOUT_MS
  )

  it(
    '(d) does not transition a claim twice after an approved loop settles and throws',
    async () => {
      const healthy = await claimedContinuation(provider('openai', () => ({ content: 'done' })))
      try {
        await healthy.executor.run()
        expect(healthy.deps.onComplete).toHaveBeenCalledTimes(1)
        expect(header(healthy.handle).status).toBe('completed')
      } finally {
        await healthy.handle.shutdown()
      }

      const llm = provider('openai', (_messages, call) =>
        call === 1
          ? {
              calls: [
                { id: 'continuation-approved-write', name: 'publisher__publish', arguments: {} },
              ],
            }
          : { error: new Error('terminal provider failure') }
      )
      const f = await claimedContinuation(llm)
      try {
        await f.executor.run()
        expect(f.executor.executorState).toBe('waiting_approval')
        expect(pendingApprovalCount(f.handle)).toBe(1)
        const recorder = (
          f.executor as unknown as {
            continuationClaim: { recorder: ReturnType<typeof createModelStepCheckpointRecorder> }
          }
        ).continuationClaim.recorder
        const settle = recorder.settle.bind(recorder)
        vi.spyOn(recorder, 'settle').mockImplementation(async result => {
          const value = await settle(result)
          if (result?.type !== 'need_approval') throw new Error('after applied settlement')
          return value
        })
        const transition = vi.spyOn(f.checkpoints, 'transition')
        await f.executor.resumeAfterApproval(false)
        await f.handle.persistQueue.drain()
        expect(f.execute).toHaveBeenCalledTimes(1)
        expect(f.deps.onFail).toHaveBeenCalledTimes(1)
        expect(f.deps.onComplete).not.toHaveBeenCalled()
        expect(header(f.handle).status).toBe('abandoned')
        expect(
          transition.mock.calls.filter(([, , input]) => input.to === 'abandoned')
        ).toHaveLength(1)
      } finally {
        await f.handle.shutdown()
      }
    },
    AUTO_RETRY_TEST_TIMEOUT_MS
  )
})
