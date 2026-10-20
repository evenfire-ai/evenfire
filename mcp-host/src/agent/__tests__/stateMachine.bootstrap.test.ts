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
import { ConversationState } from '../../core/types'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import type { SingleTurnProvider } from '../../llm/types'
import { logger } from '../../logger'
import { McpManager } from '../../mcp/manager'
import { MessageQueue } from '../../queue/messageQueue'
import type { IncomingMessage } from '../../server/types'
import { sourceMessageForResume } from '../sourceMessageForResume'
import { AgentStateMachine } from '../stateMachine'

const NOW = 1_700_000_000_000
const TTL_MS = 7 * 24 * 3_600_000
const LEASE_MS = 300_000
const CHECKPOINT_ID = 'checkpoint-boot-corrupt'
const BAD_SESSION = 'boot-user:rpc:chatllm:bad-chat'
const HEALTHY_SESSION = 'boot-user:rpc:chatllm:healthy-chat'
const HOST_INSTANCE = 'host-instance-boot'
const CORRUPT_PAYLOAD = 'not-json{{{private-checkpoint-body'
const handles: StoreHandle[] = []
const savedConfig = {
  enableApproval: appConfig.enableApproval,
  dynamicToolsEnabled: appConfig.dynamicToolsEnabled,
}

beforeEach(() => {
  Object.assign(appConfig, { enableApproval: true, dynamicToolsEnabled: false })
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
})

afterEach(async () => {
  Object.assign(appConfig, savedConfig)
  vi.restoreAllMocks()
  for (const handle of handles.splice(0)) await handle.shutdown()
})

async function bootFixture() {
  const handle = makeSqliteStore()
  handles.push(handle)
  const manager = new ConversationManager(handle.store)
  const checkpoints = new ModelStepCheckpointStore(handle.persistQueue, {
    now: () => Date.now(),
    blockedTtlMs: TTL_MS,
  })
  const message: IncomingMessage = {
    sender: 'boot-user',
    content: 'Run the approved tool',
    channelType: 'rpc',
    channelId: 'chatllm',
    threadId: 'bad-chat',
    messageId: 'boot-message',
    timestamp: new Date(NOW).toISOString(),
    hostRef: 'boot-host',
  }
  const budget = {
    elapsedActiveMs: 0,
    iterationsUsed: 1,
    durationMs: 300_000,
    maxIterations: 20,
    attachmentReadLedger: { reads: 0, spentTokens: 0, bytesRead: 0 },
  }
  const badConversation = await manager.getOrCreate(BAD_SESSION, {
    userId: message.sender,
    channelType: message.channelType,
    channelId: message.channelId,
    threadId: message.threadId,
    source: 'rpc',
  })
  await manager.startTurn(badConversation, message.content, 'origin-boot-task')
  await manager.failTurn(badConversation)
  const fence = await checkpoints.open(
    {
      checkpointId: CHECKPOINT_ID,
      sessionKey: BAD_SESSION,
      originTurnNumber: 1,
      originTaskId: 'origin-boot-task',
      provider: 'zai',
      model: 'boot-model',
      hostId: message.hostRef!,
      principal: message.sender,
      loopState: JSON.stringify({ nextIteration: 1, originUserMessageIndex: 0 }),
      taskBudget: JSON.stringify(budget),
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
  const version = await checkpoints.transition(BAD_SESSION, fence, {
    from: ['open'],
    to: 'resumable',
    failedAt: NOW,
    expiresAt: NOW + TTL_MS,
  })
  if (version === null) throw new Error('Boot fixture transition lost its fence')
  const claim = await checkpoints.claim({
    sessionKey: BAD_SESSION,
    checkpointId: CHECKPOINT_ID,
    version,
    hostInstanceId: HOST_INSTANCE,
    newTaskId: 'bad-boot-task',
    leaseMs: LEASE_MS,
  })
  if (claim.outcome !== 'claimed') throw new Error('Boot fixture claim was not acquired')
  await manager.resumeTurnForContinuation(badConversation, 'bad-boot-task', 1, null, undefined, {
    fence: claim.fence,
    activeTaskId: 'bad-boot-task',
    originTurnNumber: 1,
  })
  const healthyMessage = { ...message, threadId: 'healthy-chat', messageId: 'healthy-message' }
  const healthyConversation = await manager.getOrCreate(HEALTHY_SESSION, {
    userId: healthyMessage.sender,
    channelType: healthyMessage.channelType,
    channelId: healthyMessage.channelId,
    threadId: healthyMessage.threadId,
    source: 'rpc',
  })
  await manager.startTurn(healthyConversation, healthyMessage.content, 'healthy-boot-task')
  for (const [conversation, source, requestId] of [
    [badConversation, message, 'approval-bad'],
    [healthyConversation, healthyMessage, 'approval-healthy'],
  ] as const) {
    await manager.suspendForApproval(conversation, {
      request_id: requestId,
      tool_name: 'shell_exec',
      tool_call_id: `tool-${requestId}`,
      parameters: {},
      description: 'Boot recovery approval',
      context_snapshot: [{ role: 'user', content: source.content }],
      task_budget: budget,
      sourceMessage: sourceMessageForResume(source),
    })
  }
  const provider: SingleTurnProvider = {
    getProviderType: () => 'zai',
    classifyError: () => ({
      code: LlmErrorCode.ApiCallFailed,
      retryable: false,
      message: 'Unexpected model call',
    }),
    completeSingleTurn: async () => {
      throw new Error('Boot must not call a model')
    },
    completeSingleTurnWithTools: async () => {
      throw new Error('Boot must not call a model')
    },
  }
  const lifecycle = new TaskLifecycle()
  const queue = new MessageQueue()
  queue.setLifecycle(lifecycle)
  const stateMachine = new AgentStateMachine(queue, lifecycle, {
    autoStart: false,
    approvalTimeout: 0,
  })
  stateMachine.setConversationStore(handle.store)
  stateMachine.setMcpManager(new McpManager())
  stateMachine.setLLMProvider(provider as never, 'boot-model')
  stateMachine.setTaskModelResolver(() => ({
    provider,
    model: 'boot-model',
    contextWindowTokens: 100_000,
  }))
  stateMachine.setModelStepCheckpoints({
    store: checkpoints,
    hostInstanceId: HOST_INSTANCE,
    hostId: message.hostRef!,
    resumableTtlMs: TTL_MS,
    claimLeaseMs: LEASE_MS,
    pendingApprovalTtlMs: TTL_MS,
    attachmentTtlMs: 3_600_000,
  })
  stateMachine.setColdStartLoader(new SqliteColdStartLoader(handle.store))
  const corrupt = () =>
    handle.worker.db
      .prepare('UPDATE model_step_checkpoint_entries SET payload = ? WHERE checkpoint_id = ?')
      .run(CORRUPT_PAYLOAD, CHECKPOINT_ID)
  const approvals = () =>
    handle.worker.db.prepare('SELECT request_id FROM pending_approvals ORDER BY request_id').all()
  return {
    handle,
    manager,
    checkpoints,
    stateMachine,
    badConversation,
    healthyConversation,
    corrupt,
    approvals,
  }
}

async function expectCorruptApprovalRetired(
  f: Awaited<ReturnType<typeof bootFixture>>,
  warning: string
) {
  const warn = vi.spyOn(logger, 'warn')
  await expect(f.stateMachine.bootstrap()).resolves.toBeUndefined()
  expect(f.approvals()).toEqual([{ request_id: 'approval-healthy' }])
  expect(f.stateMachine.getPendingApprovals().map(a => a.requestId)).toEqual(['approval-healthy'])
  expect(f.badConversation.state).toBe(ConversationState.Idle)
  expect(f.badConversation.pending_approval).toBeUndefined()
  expect(f.healthyConversation.pending_approval?.request_id).toBe('approval-healthy')
  expect(warn).toHaveBeenCalledWith(
    {
      sessionKey: BAD_SESSION,
      taskId: 'bad-boot-task',
      code: 'MODEL_STEP_CHECKPOINT_CORRUPT',
    },
    warning
  )
}

describe('AgentStateMachine corrupt checkpoint boot recovery (#1043 C-2)', () => {
  it('handles corrupt loadForTask in the stateMachine catch and rehydrates the healthy session', async () => {
    const f = await bootFixture()
    expect(f.corrupt().changes).toBe(1)
    const read = vi.spyOn(f.checkpoints, 'loadForTask')
    await expectCorruptApprovalRetired(
      f,
      'Pending approval checkpoint is corrupt; retiring approval'
    )
    expect(read).toHaveBeenCalledWith(BAD_SESSION, 'bad-boot-task')

    vi.spyOn(Date, 'now').mockReturnValue(NOW + TTL_MS + 1)
    expect(await f.checkpoints.sweep()).toMatchObject({ expired: 1, purgedCheckpoints: 1 })
    expect(
      f.handle.worker.db.prepare('SELECT checkpoint_id FROM model_step_checkpoints').all()
    ).toEqual([])
    expect(
      f.handle.worker.db.prepare('SELECT seq FROM model_step_checkpoint_entries').all()
    ).toEqual([])
  })

  it('handles corrupt loadLive in the executor catch and rehydrates the healthy session', async () => {
    const f = await bootFixture()
    const loadLive = f.checkpoints.loadLive.bind(f.checkpoints)
    const read = vi.spyOn(f.checkpoints, 'loadLive').mockImplementationOnce(sessionKey => {
      expect(f.corrupt().changes).toBe(1)
      return loadLive(sessionKey)
    })
    await expectCorruptApprovalRetired(
      f,
      'Pending approval checkpoint is corrupt; retiring the approval'
    )
    expect(read).toHaveBeenCalledWith(BAD_SESSION)

    await f.manager.startTurn(f.badConversation, 'Start a new turn', 'next-boot-task')
    expect(f.handle.worker.db.prepare('SELECT status FROM model_step_checkpoints').get()).toEqual({
      status: 'abandoned',
    })
    expect(await f.checkpoints.sweep()).toMatchObject({ purgedCheckpoints: 1 })
    expect(
      f.handle.worker.db.prepare('SELECT checkpoint_id FROM model_step_checkpoints').all()
    ).toEqual([])
  })

  it.each(['worker_timeout', 'SQLITE_IOERR'])(
    'rejects bootstrap on %s from loadForTask without clearing approvals',
    async code => {
      const f = await bootFixture()
      const error =
        code === 'worker_timeout'
          ? new Error('db worker timeout (2000ms) for op=model_step_checkpoint_load_for_task')
          : Object.assign(new Error('Checkpoint worker read failed'), { code })
      const read = vi.spyOn(f.checkpoints, 'loadForTask').mockRejectedValueOnce(error)
      await expect(f.stateMachine.bootstrap()).rejects.toBe(error)
      expect(read).toHaveBeenCalledWith(BAD_SESSION, 'bad-boot-task')
      expect(f.approvals()).toEqual([
        { request_id: 'approval-bad' },
        { request_id: 'approval-healthy' },
      ])
      expect(f.badConversation.pending_approval?.request_id).toBe('approval-bad')
    }
  )
})
