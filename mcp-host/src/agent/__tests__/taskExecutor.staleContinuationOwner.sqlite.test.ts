import { afterEach, describe, expect, it, vi } from 'vitest'
import { config as appConfig } from '../../config'
import { ConversationManager } from '../../core/conversation/conversation'
import {
  type StoreHandle,
  makeSqliteStore,
} from '../../core/conversation/persistence/__tests__/testHelpers'
import { ModelStepCheckpointStore } from '../../core/conversation/persistence/modelStepCheckpointStore'
import { SqliteColdStartLoader } from '../../core/conversation/persistence/sqliteColdStartLoader'
import { SqliteConversationStore } from '../../core/conversation/persistence/sqliteConversationStore'
import { LlmErrorCode } from '../../core/errors'
import { SimpleEventEmitter } from '../../core/orchestration/eventEmitter'
import { type ChatMessage, FinishReason, type ToolCall } from '../../core/types'
import type { ModelStepCheckpointFence } from '../../db/worker/modelStepCheckpointOps'
import { ModelStepBoundaryNotCommittedError } from '../../db/worker/protocol'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import type { SingleTurnProvider } from '../../llm/types'
import { McpManager } from '../../mcp/manager'
import { MessageQueue } from '../../queue/messageQueue'
import type { Task } from '../../queue/types'
import { makeHandlers } from '../../server/__tests__/testHelpers'
import { handleApprovalRoute } from '../../server/routes'
import type { IncomingMessage } from '../../server/types'
import { sourceMessageForResume } from '../sourceMessageForResume'
import { AgentStateMachine } from '../stateMachine'
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
  const onFail = vi.fn()
  const onComplete = vi.fn()
  const onApprovalNeeded = vi.fn()
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

function activeExecutors(machine: AgentStateMachine) {
  return (machine as unknown as { activeExecutors: Map<string, TaskExecutor> }).activeExecutors
}

async function postDenial(machine: AgentStateMachine, requestId: string) {
  const response = { writeHead: vi.fn(), end: vi.fn() }
  await handleApprovalRoute(
    {
      runtimeCaller: { caller: 'rpc-proxy', hostRef: 'chatllm', userId: 'owner-user' },
      body: { userId: 'owner-user', requestId },
    } as never,
    response as never,
    false,
    makeHandlers({
      approvalHandler: decision =>
        machine.handleDenial(
          decision.userId,
          decision.requestId,
          decision.channelType,
          decision.channelId
        ),
    })
  )
  return {
    status: response.writeHead.mock.calls[0]?.[0] as number,
    body: JSON.parse(response.end.mock.calls[0]?.[0] as string) as {
      success: boolean
      code?: string
      error?: string
    },
  }
}

function insertApprovalRow(handle: StoreHandle, row: Record<string, unknown>) {
  const columns = Object.keys(row)
  handle.worker.db
    .prepare(
      `INSERT INTO pending_approvals (${columns.join(', ')})
       VALUES (${columns.map(() => '?').join(', ')})`
    )
    .run(...columns.map(column => row[column]))
}

describe('stale continuation ownership across separate SQLite caches', () => {
  afterEach(() => {
    Object.assign(appConfig, savedConfig)
    vi.restoreAllMocks()
  })

  it('restores a losing cache after a late owner-mismatch rejection', async () => {
    const handle = makeSqliteStore()
    const manager = new ConversationManager(handle.store)
    try {
      const key = 'owner-user:rpc:chatllm:late-owner'
      const conversation = await manager.getOrCreate(key)
      await manager.startTurn(conversation, 'first request', 'late-owner-a', {
        version: 1,
        runId: 'late-owner-trace',
        origin: 'direct_chat',
        correlationRefs: [],
      })
      const before = {
        state: conversation.state,
        pending_approval: conversation.pending_approval,
        activeTaskId: conversation.activeTaskId,
        traceContext: conversation.traceContext,
        updated_at: conversation.updated_at,
        completedAt: conversation.turns.at(-1)?.completed_at,
      }
      const beforeSession = session(handle, key)
      expect(beforeSession).toEqual({ state: 'processing', active_task_id: 'late-owner-a' })
      const failure = new ModelStepBoundaryNotCommittedError(
        new Error('model-step continuation task owner mismatch')
      )
      const persist = vi.spyOn(handle.store, 'persistTurnFail').mockRejectedValueOnce(failure)
      await expect(manager.failTurn(conversation, undefined, 'late-owner-a')).rejects.toBe(failure)
      expect(persist).toHaveBeenCalledTimes(1)
      expect.soft(conversation).toMatchObject({
        state: before.state,
        pending_approval: before.pending_approval,
        activeTaskId: before.activeTaskId,
        traceContext: before.traceContext,
        updated_at: before.updated_at,
      })
      expect.soft(conversation.turns.at(-1)?.completed_at).toBe(before.completedAt)
      const startError = await manager
        .startTurn(conversation, 'unexpected follow-up', 'late-follow-up')
        .then(
          () => null,
          error => error
        )
      expect.soft(startError).toMatchObject({ code: 'CONV_INVALID_TRANSITION' })
      expect.soft(session(handle, key)).toEqual(beforeSession)
    } finally {
      await handle.shutdown()
    }
  })

  it('preserves the replacement owner and approval when the stale owner loses its fence', async () => {
    Object.assign(appConfig, {
      enableApproval: true,
      dynamicToolsEnabled: false,
      promptCacheEnabled: false,
      modelStepAutoRetries: 0,
    })
    let clock = Date.now()
    const handle = makeSqliteStore()
    const managerA = new ConversationManager(handle.store)
    const checkpoints = new ModelStepCheckpointStore(handle.persistQueue, {
      now: () => clock,
      blockedTtlMs: TTL_MS,
    })
    let rejectA!: (error: Error) => void
    const held = new Promise<Answer>((_resolve, reject) => {
      rejectA = reject
    })
    let runA: ReturnType<typeof execution> | undefined
    let runB: ReturnType<typeof execution> | undefined
    let promiseA: Promise<void> | undefined
    let rejectSameOwner: ((error: Error) => void) | undefined
    let promiseSameOwner: Promise<void> | undefined
    try {
      const fixture = await seed(handle, managerA, checkpoints, clock, 'stale')
      const staleProvider = provider(() => held)
      runA = execution(
        fixture,
        managerA,
        checkpoints,
        'continuation-stale-a',
        fixture.fence,
        staleProvider.llm
      )
      promiseA = runA.executor.run()
      await vi.waitFor(() => {
        expect(staleProvider.calls()).toBe(1)
        expect(runA!.onVerdict).toHaveBeenCalledWith({ kind: 'started' })
      })
      expect(session(handle, fixture.sessionKey)).toEqual({
        state: 'processing',
        active_task_id: 'continuation-stale-a',
      })
      expect(managerA.getSessionByKey(fixture.sessionKey)).toMatchObject({
        state: 'processing',
        activeTaskId: 'continuation-stale-a',
      })

      clock += LEASE_MS + 1
      const row = handle.worker.db
        .prepare('SELECT version FROM model_step_checkpoints WHERE checkpoint_id = ?')
        .get(fixture.checkpointId) as { version: number }
      const claimedB = await checkpoints.claim({
        sessionKey: fixture.sessionKey,
        checkpointId: fixture.checkpointId,
        version: row.version,
        hostInstanceId: 'host-stale-b',
        newTaskId: 'continuation-stale-b',
        leaseMs: LEASE_MS,
      })
      if (claimedB.outcome !== 'claimed') throw new Error(`Replacement claim: ${claimedB.outcome}`)
      expect(claimedB.fence.generation).toBeGreaterThan(fixture.fence.generation)
      const managerB = new ConversationManager(
        new SqliteConversationStore(handle.persistQueue, { cacheSize: 8 })
      )
      const replacementProvider = provider(async () => ({
        calls: [{ id: 'approval-b', name: 'shell_exec', arguments: { command: 'printf held' } }],
      }))
      runB = execution(
        fixture,
        managerB,
        checkpoints,
        'continuation-stale-b',
        claimedB.fence,
        replacementProvider.llm
      )
      await runB.executor.run()
      expect(replacementProvider.calls()).toBe(1)
      expect(runB.executor.executorState).toBe('waiting_approval')
      expect(runB.onApprovalNeeded).toHaveBeenCalledTimes(1)
      expect(session(handle, fixture.sessionKey)).toEqual({
        state: 'awaiting_approval',
        active_task_id: 'continuation-stale-b',
      })
      const beforeApproval = approval(handle, 'continuation-stale-b')
      expect(beforeApproval).toMatchObject({ task_id: 'continuation-stale-b' })
      expect(checkpoint(handle, fixture.checkpointId)).toEqual({
        status: 'claimed',
        continuation_task_id: 'continuation-stale-b',
      })

      const losing = managerA.getSessionByKey(fixture.sessionKey)!
      losing.traceContext = {
        version: 1,
        runId: 'stale-owner-trace',
        origin: 'direct_chat',
        correlationRefs: [],
      }
      const losingBefore = {
        state: losing.state,
        pending_approval: losing.pending_approval,
        activeTaskId: losing.activeTaskId,
        traceContext: losing.traceContext,
        updated_at: losing.updated_at,
      }
      rejectA(new Error('held provider failed after replacement'))
      await promiseA
      await handle.persistQueue.drain()
      expect.soft(losing).toMatchObject(losingBefore)
      const staleStartError = await managerA
        .startTurn(losing, 'unexpected follow-up', 'stale-follow-up')
        .then(
          () => null,
          error => error
        )
      expect.soft(staleStartError).toMatchObject({ code: 'CONV_INVALID_TRANSITION' })
      expect.soft(session(handle, fixture.sessionKey)).toEqual({
        state: 'awaiting_approval',
        active_task_id: 'continuation-stale-b',
      })
      expect.soft(approval(handle, 'continuation-stale-b')).toEqual(beforeApproval)
      const afterSession = session(handle, fixture.sessionKey)
      const afterApproval = approval(handle, 'continuation-stale-b')
      const afterCheckpoint = checkpoint(handle, fixture.checkpointId)
      const replacementRam = managerB.getSessionByKey(fixture.sessionKey)
      expect(
        runA.lifecycle
          .get(runA.taskId)
          ?.history.filter(entry => ['cancelled', 'failed', 'completed'].includes(entry.to))
      ).toHaveLength(1)
      expect(runA.onComplete).not.toHaveBeenCalled()
      expect(runB.onFail).not.toHaveBeenCalled()
      expect(replacementRam).toMatchObject({
        state: 'awaiting_approval',
        activeTaskId: 'continuation-stale-b',
      })

      // Same-owner release must still retire B's approval and its claim.
      await runB.executor.deny()
      await handle.persistQueue.drain()
      expect(runB.onComplete).toHaveBeenCalledTimes(1)
      expect(session(handle, fixture.sessionKey)).toEqual({ state: 'idle', active_task_id: null })
      expect(approval(handle, 'continuation-stale-b')).toBeUndefined()
      expect(checkpoint(handle, fixture.checkpointId)).toEqual({
        status: 'abandoned',
        continuation_task_id: 'continuation-stale-b',
      })

      // Independent continuation sharing the same SQLite worker completes.
      const neighbor = await seed(handle, managerA, checkpoints, clock, 'neighbor')
      const neighborProvider = provider(async () => ({ content: 'healthy neighbor completed' }))
      const healthy = execution(
        neighbor,
        managerA,
        checkpoints,
        'continuation-neighbor-a',
        neighbor.fence,
        neighborProvider.llm
      )
      await healthy.executor.run()
      await handle.persistQueue.drain()
      expect(neighborProvider.calls()).toBe(1)
      expect(healthy.onComplete).toHaveBeenCalledTimes(1)
      expect(healthy.onFail).not.toHaveBeenCalled()
      expect(checkpoint(handle, neighbor.checkpointId)).toEqual({
        status: 'completed',
        continuation_task_id: 'continuation-neighbor-a',
      })

      // Loss of the claim alone must not leave A's still-owned session stuck.
      const sameOwner = await seed(handle, managerA, checkpoints, clock, 'same-owner')
      const heldSameOwner = new Promise<Answer>((_resolve, reject) => {
        rejectSameOwner = reject
      })
      const sameOwnerProvider = provider(() => heldSameOwner)
      const sameOwnerRun = execution(
        sameOwner,
        managerA,
        checkpoints,
        'continuation-same-owner-a',
        sameOwner.fence,
        sameOwnerProvider.llm
      )
      promiseSameOwner = sameOwnerRun.executor.run()
      await vi.waitFor(() => expect(sameOwnerProvider.calls()).toBe(1))
      expect(session(handle, sameOwner.sessionKey)).toEqual({
        state: 'processing',
        active_task_id: 'continuation-same-owner-a',
      })
      clock += LEASE_MS + 1
      const sameOwnerRow = handle.worker.db
        .prepare('SELECT version FROM model_step_checkpoints WHERE checkpoint_id = ?')
        .get(sameOwner.checkpointId) as { version: number }
      const nextClaim = await checkpoints.claim({
        sessionKey: sameOwner.sessionKey,
        checkpointId: sameOwner.checkpointId,
        version: sameOwnerRow.version,
        hostInstanceId: 'host-same-owner-b',
        newTaskId: 'continuation-same-owner-b',
        leaseMs: LEASE_MS,
      })
      expect(nextClaim.outcome).toBe('claimed')
      rejectSameOwner!(new Error('held provider failed after claim loss'))
      await promiseSameOwner
      await handle.persistQueue.drain()
      expect(session(handle, sameOwner.sessionKey)).toEqual({
        state: 'idle',
        active_task_id: null,
      })
      expect(checkpoint(handle, sameOwner.checkpointId)).toEqual({
        status: 'claimed',
        continuation_task_id: 'continuation-same-owner-b',
      })

      expect.soft(afterCheckpoint).toEqual({
        status: 'claimed',
        continuation_task_id: 'continuation-stale-b',
      })
      expect.soft(afterApproval).toEqual(beforeApproval)
      expect.soft(afterSession).toEqual({
        state: 'awaiting_approval',
        active_task_id: 'continuation-stale-b',
      })

      // A stale approval cache must not delete a replacement approval or clear
      // its session when the lost-fence cleanup follows the deny path.
      const approvalKey = 'owner-user:rpc:chatllm:approval-owner'
      const staleApproval = await managerA.getOrCreate(approvalKey)
      await managerA.startTurn(staleApproval, 'first request', 'approval-owner-a', {
        version: 1,
        runId: 'stale-approval-trace',
        origin: 'direct_chat',
        correlationRefs: [],
      })
      await managerA.suspendForApproval(staleApproval, {
        request_id: 'approval-owner-request-a',
        tool_name: 'shell_exec',
        tool_call_id: 'approval-owner-call-a',
        parameters: {},
        description: 'first request',
        context_snapshot: [],
        task_budget: {
          elapsedActiveMs: 0,
          iterationsUsed: 1,
          durationMs: 300_000,
          maxIterations: 20,
        },
      })
      const approvalManagerB = new ConversationManager(
        new SqliteConversationStore(handle.persistQueue, { cacheSize: 8 })
      )
      const approvalB = await approvalManagerB.getSessionByKeyAsync(approvalKey)
      if (!approvalB) throw new Error('Replacement approval session missing')
      await approvalManagerB.deny(approvalB, 'approval-owner-a')
      await approvalManagerB.startTurn(approvalB, 'next request', 'approval-owner-b')
      await approvalManagerB.suspendForApproval(approvalB, {
        request_id: 'approval-owner-request-b',
        tool_name: 'shell_exec',
        tool_call_id: 'approval-owner-call-b',
        parameters: {},
        description: 'next request',
        context_snapshot: [],
        task_budget: {
          elapsedActiveMs: 0,
          iterationsUsed: 1,
          durationMs: 300_000,
          maxIterations: 20,
        },
      })
      expect(staleApproval).toMatchObject({
        state: 'awaiting_approval',
        activeTaskId: 'approval-owner-a',
      })
      expect.soft(session(handle, approvalKey)).toEqual({
        state: 'awaiting_approval',
        active_task_id: 'approval-owner-b',
      })
      const approvalBeforeStaleDeny = approval(handle, 'approval-owner-b')
      expect(approvalBeforeStaleDeny).toMatchObject({ request_id: 'approval-owner-request-b' })
      const staleApprovalBefore = {
        state: staleApproval.state,
        pending_approval: staleApproval.pending_approval,
        activeTaskId: staleApproval.activeTaskId,
        traceContext: staleApproval.traceContext,
        updated_at: staleApproval.updated_at,
      }
      await expect(managerA.deny(staleApproval, 'approval-owner-a')).rejects.toThrow(
        'model-step continuation task owner mismatch'
      )
      expect.soft(staleApproval).toMatchObject(staleApprovalBefore)
      const staleApprovalStartError = await managerA
        .startTurn(staleApproval, 'unexpected follow-up', 'approval-stale-follow-up')
        .then(
          () => null,
          error => error
        )
      expect.soft(staleApprovalStartError).toMatchObject({ code: 'CONV_INVALID_TRANSITION' })
      expect(session(handle, approvalKey)).toEqual({
        state: 'awaiting_approval',
        active_task_id: 'approval-owner-b',
      })
      expect(approval(handle, 'approval-owner-b')).toEqual(approvalBeforeStaleDeny)
      expect(approvalB).toMatchObject({
        state: 'awaiting_approval',
        activeTaskId: 'approval-owner-b',
      })
      await approvalManagerB.deny(approvalB, 'approval-owner-b')
      expect(session(handle, approvalKey)).toEqual({ state: 'idle', active_task_id: null })
      expect(approval(handle, 'approval-owner-b')).toBeUndefined()
    } finally {
      rejectA?.(new Error('fixture cleanup'))
      await promiseA?.catch(() => {})
      rejectSameOwner?.(new Error('fixture cleanup'))
      await promiseSameOwner?.catch(() => {})
      if (runB?.executor.executorState === 'waiting_approval') await runB.executor.deny()
      await handle.shutdown()
    }
  }, 20_000)

  it('scopes executor denial to the continuation owner and preserves the replacement approval', async () => {
    Object.assign(appConfig, {
      enableApproval: true,
      dynamicToolsEnabled: false,
      promptCacheEnabled: false,
      modelStepAutoRetries: 0,
    })
    let clock = Date.now()
    const handle = makeSqliteStore()
    const lifecycle = new TaskLifecycle()
    const queue = new MessageQueue()
    queue.setLifecycle(lifecycle)
    const machineA = new AgentStateMachine(queue, lifecycle, {
      maxTaskDuration: 300_000,
      maxToolCallsPerTask: 20,
      autoStart: false,
      taskDelay: 0,
      approvalTimeout: 300_000,
    })
    const checkpoints = new ModelStepCheckpointStore(handle.persistQueue, {
      now: () => clock,
      blockedTtlMs: TTL_MS,
    })
    const coldProvider = provider(async () => ({ content: 'not reached before assertions' }))
    machineA.setConversationStore(handle.store)
    machineA.setMcpManager(new McpManager())
    machineA.setLLMProvider(coldProvider.llm, 'checkpoint-model')
    machineA.setTaskModelResolver(selections =>
      selections?.openai === 'checkpoint-model'
        ? {
            provider: coldProvider.llm,
            model: 'checkpoint-model',
            contextWindowTokens: 100_000,
          }
        : null
    )
    machineA.setModelStepCheckpoints({
      store: checkpoints,
      hostInstanceId: 'host-deny-owner-a',
      hostId: 'host-a',
      resumableTtlMs: TTL_MS,
      claimLeaseMs: LEASE_MS,
      pendingApprovalTtlMs: TTL_MS,
      attachmentTtlMs: 3_600_000,
    })
    machineA.setColdStartLoader(new SqliteColdStartLoader(handle.store))
    const managerA = machineA.getConversationManager()

    try {
      const fixture = await seed(handle, managerA, checkpoints, clock, 'deny-owner')
      const taskA = 'continuation-deny-owner-a'
      const requestA = 'request-deny-owner-a'
      const conversationA = await managerA.getOrCreate(fixture.sessionKey, {
        userId: 'owner-user',
        channelType: 'rpc',
        channelId: 'chatllm',
        threadId: 'deny-owner',
        source: 'rpc',
      })
      await managerA.resumeTurnForContinuation(conversationA, taskA, 1, null, undefined, {
        fence: fixture.fence,
        activeTaskId: taskA,
        originTurnNumber: 1,
      })
      await managerA.suspendForApproval(conversationA, {
        request_id: requestA,
        tool_name: 'shell_exec',
        tool_call_id: 'tool-deny-owner-a',
        parameters: { command: 'printf a' },
        description: 'Approve the first continuation tool',
        context_snapshot: [{ role: 'user', content: fixture.message.content }],
        task_budget: {
          elapsedActiveMs: 0,
          iterationsUsed: 1,
          durationMs: 300_000,
          maxIterations: 20,
        },
        sourceMessage: sourceMessageForResume(fixture.message),
      })
      await machineA.bootstrap()
      const executorA = activeExecutors(machineA).get(taskA)!
      expect(executorA.executorState).toBe('waiting_approval')
      lifecycle.register(executorA.sourceTask)
      expect(lifecycle.transition(taskA, 'processing', 'dispatched').kind).toBe('applied')
      const terminal: string[] = []
      machineA.on('task:failed', event => {
        if (event.data.task.id === taskA) terminal.push('task:failed')
      })
      machineA.on('task:completed', event => {
        if (event.data.task.id === taskA) terminal.push('task:completed')
      })
      const responseCallback = vi.fn(async (_delivery: { error?: unknown }) => {})
      executorA.sourceTask.responseCallback = responseCallback
      const staleApprovalRow = handle.worker.db
        .prepare('SELECT * FROM pending_approvals WHERE task_id = ?')
        .get(taskA) as Record<string, unknown>
      expect(staleApprovalRow.request_id).toBe(requestA)

      const managerB = new ConversationManager(
        new SqliteConversationStore(handle.persistQueue, { cacheSize: 8 })
      )
      const conversationB = await managerB.getSessionByKeyAsync(fixture.sessionKey)
      if (!conversationB) throw new Error('Replacement cache did not load the suspended session')
      await managerB.deny(conversationB, taskA)
      const taskB = 'replacement-deny-owner-b'
      await managerB.startTurn(conversationB, 'replacement request', taskB)
      await managerB.suspendForApproval(conversationB, {
        request_id: 'request-deny-owner-b',
        tool_name: 'shell_exec',
        tool_call_id: 'tool-deny-owner-b',
        parameters: { command: 'printf b' },
        description: 'Approve the replacement tool',
        context_snapshot: [{ role: 'user', content: 'replacement request' }],
        task_budget: {
          elapsedActiveMs: 0,
          iterationsUsed: 1,
          durationMs: 300_000,
          maxIterations: 20,
        },
      })
      // The stale cleanup interleaving leaves A's already-written approval row
      // behind after another cache has moved the session to B. Restore that
      // exact residue without rewriting B's durable session.
      insertApprovalRow(handle, staleApprovalRow)
      const beforeSession = session(handle, fixture.sessionKey)
      const beforeApprovalB = approval(handle, taskB)
      const beforeApprovalA = approval(handle, taskA)
      const beforeCheckpoint = checkpoint(handle, fixture.checkpointId)
      expect(beforeSession).toEqual({
        state: 'awaiting_approval',
        active_task_id: taskB,
      })
      expect(beforeApprovalB).toMatchObject({ task_id: taskB })
      expect(beforeApprovalA).toMatchObject({ request_id: requestA, task_id: taskA })
      expect(beforeCheckpoint).toEqual({
        status: 'abandoned',
        continuation_task_id: taskA,
      })

      const response = await postDenial(machineA, requestA)
      await handle.persistQueue.drain()
      expect(response.status).toBe(500)
      expect(response.body).toEqual({
        success: false,
        error: 'The tool call denial could not be completed.',
      })
      expect(terminal).toEqual(['task:failed'])
      expect(responseCallback).toHaveBeenCalledTimes(1)
      const failureDelivery = responseCallback.mock.calls[0]?.[0]
      expect(failureDelivery).toHaveProperty('error')
      expect(
        lifecycle
          .get(taskA)
          ?.history.filter(entry => ['cancelled', 'failed', 'completed'].includes(entry.to))
      ).toHaveLength(1)
      expect(conversationA).toMatchObject({
        state: 'awaiting_approval',
        activeTaskId: taskA,
      })
      expect(conversationA.pending_approval?.request_id).toBe(requestA)
      expect(session(handle, fixture.sessionKey)).toEqual(beforeSession)
      expect(approval(handle, taskA)).toEqual(beforeApprovalA)
      expect(approval(handle, taskB)).toEqual(beforeApprovalB)
      expect(checkpoint(handle, fixture.checkpointId)).toEqual(beforeCheckpoint)

      const coldStore = new SqliteConversationStore(handle.persistQueue, { cacheSize: 8 })
      const coldLifecycle = new TaskLifecycle()
      const coldQueue = new MessageQueue()
      coldQueue.setLifecycle(coldLifecycle)
      const coldMachine = new AgentStateMachine(coldQueue, coldLifecycle, {
        maxTaskDuration: 300_000,
        maxToolCallsPerTask: 20,
        autoStart: false,
        taskDelay: 0,
        approvalTimeout: 300_000,
      })
      coldMachine.setConversationStore(coldStore)
      coldMachine.setMcpManager(new McpManager())
      coldMachine.setLLMProvider(coldProvider.llm, 'checkpoint-model')
      coldMachine.setTaskModelResolver(selections =>
        selections?.openai === 'checkpoint-model'
          ? {
              provider: coldProvider.llm,
              model: 'checkpoint-model',
              contextWindowTokens: 100_000,
            }
          : null
      )
      coldMachine.setModelStepCheckpoints({
        store: checkpoints,
        hostInstanceId: 'host-deny-owner-a',
        hostId: 'host-a',
        resumableTtlMs: TTL_MS,
        claimLeaseMs: LEASE_MS,
        pendingApprovalTtlMs: TTL_MS,
        attachmentTtlMs: 3_600_000,
      })
      coldMachine.setColdStartLoader(new SqliteColdStartLoader(coldStore))
      await coldMachine.bootstrap()
      const rehydrated = activeExecutors(coldMachine).get(taskB)!
      expect(rehydrated.executorState).toBe('waiting_approval')
      expect(approval(handle, taskA)).toBeUndefined()
      expect(approval(handle, taskB)).toEqual(beforeApprovalB)
      expect(session(handle, fixture.sessionKey)).toEqual(beforeSession)
      expect(
        coldMachine.getConversationManager().getSessionByKey(fixture.sessionKey)
      ).toMatchObject({
        state: 'awaiting_approval',
        activeTaskId: taskB,
      })
    } finally {
      await handle.shutdown()
    }
  }, 20_000)
})
