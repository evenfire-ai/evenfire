import { describe, expect, it, vi } from 'vitest'
import { sourceMessageForResume } from '../../../agent/sourceMessageForResume'
import { TaskExecutor, type TaskExecutorDeps } from '../../../agent/taskExecutor'
import { config } from '../../../config'
import { TaskLifecycle } from '../../../lifecycle/taskLifecycle'
import type { SingleTurnProvider } from '../../../llm/types'
import { logger } from '../../../logger'
import { McpManager } from '../../../mcp/manager'
import type { Task } from '../../../queue/types'
import type { IncomingMessage } from '../../../server/types'
import { LlmErrorCode } from '../../errors'
import { SimpleEventEmitter } from '../../orchestration/eventEmitter'
import { ConversationState, FinishReason } from '../../types'
import { ConversationManager } from '../conversation'
import { type StoreHandle, makeSqliteStore } from '../persistence/__tests__/testHelpers'
import { ModelStepCheckpointStore } from '../persistence/modelStepCheckpointStore'

const LEASE_MS = 300_000
const TTL_MS = 86_400_000
const HOST = 'stale-approval-host'
const INSTANCE = 'stale-approval-instance'

function incoming(chat: string): IncomingMessage {
  return {
    sender: 'stale-user',
    content: 'Continue the saved turn',
    channelType: 'rpc',
    channelId: 'stale-agent',
    threadId: chat,
    messageId: `message-${chat}`,
    timestamp: new Date().toISOString(),
    hostRef: HOST,
  }
}

function sessionKey(chat: string): string {
  return `stale-user:rpc:stale-agent:${chat}`
}

async function createClaim(
  handle: StoreHandle,
  manager: ConversationManager,
  checkpoints: ModelStepCheckpointStore,
  chat: string
) {
  const message = incoming(chat)
  const key = sessionKey(chat)
  const conversation = await manager.getOrCreate(key)
  const originTaskId = `origin-${chat}`
  const taskId = `continuation-${chat}`
  await manager.startTurn(conversation, message.content, originTaskId)
  const originTurnNumber = conversation.turns.at(-1)!.number
  await manager.failTurn(conversation)
  const budget = JSON.stringify({
    elapsedActiveMs: 0,
    iterationsUsed: 0,
    durationMs: TTL_MS,
    maxIterations: 20,
    attachmentReadLedger: { reads: 0, spentTokens: 0, bytesRead: 0 },
  })
  const fence = await checkpoints.open(
    {
      checkpointId: `checkpoint-${chat}`,
      sessionKey: key,
      originTurnNumber,
      originTaskId,
      provider: 'openai',
      model: 'stale-model',
      hostId: HOST,
      principal: 'stale-user',
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
  const version = await checkpoints.transition(key, fence, {
    from: ['open'],
    to: 'resumable',
    failedAt: Date.now(),
    expiresAt: Date.now() + TTL_MS,
  })
  if (version === null) throw new Error('fixture failed to make checkpoint resumable')
  const claim = await checkpoints.claim({
    sessionKey: key,
    checkpointId: fence.checkpointId,
    version,
    hostInstanceId: INSTANCE,
    newTaskId: taskId,
    leaseMs: LEASE_MS,
  })
  if (claim.outcome !== 'claimed') throw new Error(`fixture claim failed: ${claim.outcome}`)
  return {
    key,
    message,
    conversation,
    originTaskId,
    originTurnNumber,
    taskId,
    budget,
    fence: claim.fence,
  }
}

describe('stale pending-approval cleanup', () => {
  it('refuses request A after request B is current while a neighboring continuation completes', async () => {
    const saved = {
      enableApproval: config.enableApproval,
      dynamicToolsEnabled: config.dynamicToolsEnabled,
    }
    Object.assign(config, { enableApproval: false, dynamicToolsEnabled: false })
    const handle = makeSqliteStore()
    const warning = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    try {
      const manager = new ConversationManager(handle.store)
      const checkpoints = new ModelStepCheckpointStore(handle.persistQueue, {
        now: () => Date.now(),
        blockedTtlMs: TTL_MS,
      })
      const conversation = await manager.getOrCreate(sessionKey('current'))
      await manager.startTurn(conversation, 'old request', 'old-task')
      await manager.suspendForApproval(conversation, {
        request_id: 'request-A',
        tool_name: 'shell_exec',
        tool_call_id: 'call-A',
        parameters: {},
        description: 'old request',
        context_snapshot: [],
      })
      expect(
        handle.worker.db
          .prepare('SELECT request_id FROM pending_approvals WHERE request_id = ?')
          .get('request-A')
      ).toEqual({ request_id: 'request-A' })
      await manager.deny(conversation)

      const current = await createClaim(handle, manager, checkpoints, 'current')
      const currentFence = {
        fence: current.fence,
        activeTaskId: current.taskId,
        originTurnNumber: current.originTurnNumber,
      }
      const traceContext = {
        version: 1 as const,
        runId: 'current-run',
        origin: 'api' as const,
        correlationRefs: [],
      }
      await manager.resumeTurnForContinuation(
        conversation,
        current.taskId,
        current.originTurnNumber,
        traceContext,
        undefined,
        currentFence
      )
      await manager.suspendForApproval(conversation, {
        request_id: 'request-B',
        tool_name: 'shell_exec',
        tool_call_id: 'call-B',
        parameters: {},
        description: 'current request',
        context_snapshot: [],
      })
      const approvalB = conversation.pending_approval
      const updatedAt = conversation.updated_at
      const row = () =>
        handle.worker.db
          .prepare('SELECT state, active_task_id FROM sessions WHERE id = ?')
          .get(conversation.id)
      const pending = () =>
        handle.worker.db
          .prepare('SELECT request_id FROM pending_approvals WHERE session_id = ?')
          .all(conversation.id)
      const checkpoint = () =>
        handle.worker.db
          .prepare(
            'SELECT status, claim_owner, claim_generation FROM model_step_checkpoints WHERE checkpoint_id = ?'
          )
          .get(current.fence.checkpointId)
      expect(approvalB?.request_id).toBe('request-B')
      expect(row()).toEqual({ state: 'awaiting_approval', active_task_id: current.taskId })
      expect(pending()).toEqual([{ request_id: 'request-B' }])
      const beforeCheckpoint = checkpoint()
      expect(beforeCheckpoint).toMatchObject({ status: 'claimed' })

      const cleared = await manager.clearPendingApproval(current.key, 'request-A')
      const observed = {
        cleared,
        approval: conversation.pending_approval,
        state: conversation.state,
        activeTaskId: conversation.activeTaskId,
        traceContext: conversation.traceContext,
        updatedAt: conversation.updated_at,
        row: row(),
        pending: pending(),
        checkpoint: checkpoint(),
      }

      // The healthy continuation executes after the stale cleanup, so a passing
      // refusal cannot be explained by a dead or globally blocked store.
      const neighbor = await createClaim(handle, manager, checkpoints, 'neighbor')
      const providerCall = vi.fn(async () => ({
        content: 'neighbor completed',
        tool_calls: [],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        finish_reason: FinishReason.Stop,
      }))
      const llm: SingleTurnProvider = {
        getProviderType: () => 'openai',
        classifyError: () => ({
          code: LlmErrorCode.ApiCallFailed,
          retryable: false,
          message: 'provider failure',
        }),
        completeSingleTurn: async () => {
          throw new Error('Unexpected tool-less completion')
        },
        completeSingleTurnWithTools: providerCall,
      }
      const onComplete = vi.fn()
      const onFail = vi.fn()
      const onVerdict = vi.fn()
      const lifecycle = new TaskLifecycle()
      const task: Task = {
        id: neighbor.taskId,
        source: 'channel',
        sourceMessage: neighbor.message,
        priority: 'normal',
        status: 'pending',
        createdAt: new Date(),
        conversationHistory: [
          { role: 'user', content: neighbor.message.content, timestamp: new Date() },
        ],
        modelStepContinuation: {
          checkpointId: neighbor.fence.checkpointId,
          originTaskId: neighbor.originTaskId,
          originTurnNumber: neighbor.originTurnNumber,
          provider: 'openai',
          model: 'stale-model',
          fence: neighbor.fence,
          confirmedResults: 0,
          taskBudget: neighbor.budget,
          onVerdict,
        },
      }
      const deps: TaskExecutorDeps = {
        conversationManager: manager,
        llmProvider: llm,
        mcpManager: new McpManager(),
        workspaceService: undefined,
        modelName: 'stale-model',
        approvalConfig: undefined,
        config: {
          maxTaskDuration: LEASE_MS,
          maxToolCallsPerTask: 20,
          autoStart: true,
          taskDelay: 0,
          approvalTimeout: LEASE_MS,
        },
        coreEvents: new SimpleEventEmitter(),
        cronScheduler: null,
        taskLifecycle: lifecycle,
        onApprovalNeeded: vi.fn(),
        onComplete,
        onFail,
        dynamicEnvProvider: () => ({}),
        modelStepCheckpoints: {
          store: checkpoints,
          hostInstanceId: INSTANCE,
          hostId: HOST,
          resumableTtlMs: TTL_MS,
          pendingApprovalTtlMs: TTL_MS,
          claimLeaseMs: LEASE_MS,
          attachmentTtlMs: TTL_MS,
        },
      }
      lifecycle.register(task)
      await new TaskExecutor(task, deps).run()
      await handle.persistQueue.drain()
      expect(providerCall).toHaveBeenCalledTimes(1)
      expect(onComplete).toHaveBeenCalledTimes(1)
      expect(onFail).not.toHaveBeenCalled()
      expect(
        handle.worker.db
          .prepare('SELECT status FROM model_step_checkpoints WHERE checkpoint_id = ?')
          .get(neighbor.fence.checkpointId)
      ).toEqual({ status: 'completed' })
      expect(neighbor.conversation.state).toBe(ConversationState.Idle)
      expect(neighbor.conversation.turns.at(-1)?.response).toBe('neighbor completed')

      // Boot recovery must still be able to delete an orphan request when
      // there is no current pending approval in the cached session.
      const orphan = await manager.getOrCreate(sessionKey('orphan'))
      await manager.startTurn(orphan, 'orphan request', 'orphan-task')
      await manager.suspendForApproval(orphan, {
        request_id: 'request-orphan',
        tool_name: 'shell_exec',
        tool_call_id: 'call-orphan',
        parameters: {},
        description: 'orphan',
        context_snapshot: [],
      })
      expect(
        handle.worker.db
          .prepare('SELECT request_id FROM pending_approvals WHERE request_id = ?')
          .get('request-orphan')
      ).toEqual({ request_id: 'request-orphan' })
      orphan.pending_approval = undefined
      await expect(
        manager.clearPendingApproval(sessionKey('orphan'), 'request-orphan')
      ).resolves.not.toBe(false)
      expect(
        handle.worker.db
          .prepare('SELECT request_id FROM pending_approvals WHERE request_id = ?')
          .get('request-orphan')
      ).toBeUndefined()
      expect(
        handle.worker.db
          .prepare('SELECT state, active_task_id FROM sessions WHERE id = ?')
          .get(orphan.id)
      ).toEqual({ state: 'idle', active_task_id: null })
      expect(orphan.state).toBe(ConversationState.Idle)

      expect(observed.approval).toBe(approvalB)
      expect(observed.state).toBe(ConversationState.AwaitingApproval)
      expect(observed.activeTaskId).toBe(current.taskId)
      expect(observed.traceContext).toBe(traceContext)
      expect(observed.updatedAt).toBe(updatedAt)
      expect(observed.row).toEqual({ state: 'awaiting_approval', active_task_id: current.taskId })
      expect(observed.pending).toEqual([{ request_id: 'request-B' }])
      expect(observed.checkpoint).toEqual(beforeCheckpoint)
      expect(observed.cleared).toBe(false)
      expect(warning).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: current.key,
          requestId: 'request-A',
          currentRequestId: 'request-B',
        }),
        expect.any(String)
      )
    } finally {
      warning.mockRestore()
      Object.assign(config, saved)
      await handle.shutdown()
    }
  })
})
