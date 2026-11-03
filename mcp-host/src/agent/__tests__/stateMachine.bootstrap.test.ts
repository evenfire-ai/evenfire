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

const USER = 'boot-user'
const MODEL = 'boot-model'
const HOST_ID = 'boot-host'

function bootMessage(threadId: string, messageId: string): IncomingMessage {
  return {
    sender: USER,
    content: 'Run the approved tool',
    channelType: 'rpc',
    channelId: 'chatllm',
    threadId,
    messageId,
    timestamp: new Date(NOW).toISOString(),
    hostRef: HOST_ID,
  }
}

function bootBudget() {
  return {
    elapsedActiveMs: 0,
    iterationsUsed: 1,
    durationMs: 300_000,
    maxIterations: 20,
    attachmentReadLedger: { reads: 0, spentTokens: 0, bytesRead: 0 },
  }
}

interface ClaimedApprovalSpec {
  threadId: string
  messageId: string
  checkpointId: string
  originTaskId: string
  continuationTaskId: string
  requestId: string
}

/**
 * A session whose origin turn is reopened by a claimed continuation waiting on
 * its approval — the durable state boot must recover. The checkpoint is written
 * by the real open/transition/claim ops, so `loop_state` is producer-shaped.
 */
async function claimedApprovalSession(
  handle: StoreHandle,
  manager: ConversationManager,
  checkpoints: ModelStepCheckpointStore,
  spec: ClaimedApprovalSpec
) {
  const sessionKey = `${USER}:rpc:chatllm:${spec.threadId}`
  const message = bootMessage(spec.threadId, spec.messageId)
  const budget = bootBudget()
  const conversation = await manager.getOrCreate(sessionKey, {
    userId: message.sender,
    channelType: message.channelType,
    channelId: message.channelId,
    threadId: message.threadId,
    source: 'rpc',
  })
  await manager.startTurn(conversation, message.content, spec.originTaskId)
  await manager.failTurn(conversation)
  const fence = await checkpoints.open(
    {
      checkpointId: spec.checkpointId,
      sessionKey,
      originTurnNumber: 1,
      originTaskId: spec.originTaskId,
      provider: 'zai',
      model: MODEL,
      hostId: HOST_ID,
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
  const version = await checkpoints.transition(sessionKey, fence, {
    from: ['open'],
    to: 'resumable',
    failedAt: NOW,
    expiresAt: NOW + TTL_MS,
  })
  if (version === null) throw new Error('Boot fixture transition lost its fence')
  const claim = await checkpoints.claim({
    sessionKey,
    checkpointId: spec.checkpointId,
    version,
    hostInstanceId: HOST_INSTANCE,
    newTaskId: spec.continuationTaskId,
    leaseMs: LEASE_MS,
  })
  if (claim.outcome !== 'claimed') throw new Error('Boot fixture claim was not acquired')
  await manager.resumeTurnForContinuation(
    conversation,
    spec.continuationTaskId,
    1,
    null,
    undefined,
    {
      fence: claim.fence,
      activeTaskId: spec.continuationTaskId,
      originTurnNumber: 1,
    }
  )
  await manager.suspendForApproval(conversation, {
    request_id: spec.requestId,
    tool_name: 'shell_exec',
    tool_call_id: `tool-${spec.requestId}`,
    parameters: {},
    description: 'Boot recovery approval',
    context_snapshot: [{ role: 'user', content: message.content }],
    task_budget: budget,
    sourceMessage: sourceMessageForResume(message),
  })
  return {
    conversation,
    sessionKey,
    requestId: spec.requestId,
    continuationTaskId: spec.continuationTaskId,
  }
}

function bootStateMachine(
  handle: StoreHandle,
  checkpoints: ModelStepCheckpointStore
): AgentStateMachine {
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
  stateMachine.setLLMProvider(provider as never, MODEL)
  stateMachine.setTaskModelResolver(() => ({
    provider,
    model: MODEL,
    contextWindowTokens: 100_000,
  }))
  stateMachine.setModelStepCheckpoints({
    store: checkpoints,
    hostInstanceId: HOST_INSTANCE,
    hostId: HOST_ID,
    resumableTtlMs: TTL_MS,
    claimLeaseMs: LEASE_MS,
    pendingApprovalTtlMs: TTL_MS,
    attachmentTtlMs: 3_600_000,
  })
  stateMachine.setColdStartLoader(new SqliteColdStartLoader(handle.store))
  return stateMachine
}

async function bootFixture() {
  const handle = makeSqliteStore()
  handles.push(handle)
  const manager = new ConversationManager(handle.store)
  const checkpoints = new ModelStepCheckpointStore(handle.persistQueue, {
    now: () => Date.now(),
    blockedTtlMs: TTL_MS,
  })
  const bad = await claimedApprovalSession(handle, manager, checkpoints, {
    threadId: 'bad-chat',
    messageId: 'boot-message',
    checkpointId: CHECKPOINT_ID,
    originTaskId: 'origin-boot-task',
    continuationTaskId: 'bad-boot-task',
    requestId: 'approval-bad',
  })
  const badConversation = bad.conversation
  const healthyMessage = bootMessage('healthy-chat', 'healthy-message')
  const healthyConversation = await manager.getOrCreate(HEALTHY_SESSION, {
    userId: healthyMessage.sender,
    channelType: healthyMessage.channelType,
    channelId: healthyMessage.channelId,
    threadId: healthyMessage.threadId,
    source: 'rpc',
  })
  await manager.startTurn(healthyConversation, healthyMessage.content, 'healthy-boot-task')
  await manager.suspendForApproval(healthyConversation, {
    request_id: 'approval-healthy',
    tool_name: 'shell_exec',
    tool_call_id: 'tool-approval-healthy',
    parameters: {},
    description: 'Boot recovery approval',
    context_snapshot: [{ role: 'user', content: healthyMessage.content }],
    task_budget: bootBudget(),
    sourceMessage: sourceMessageForResume(healthyMessage),
  })
  const stateMachine = bootStateMachine(handle, checkpoints)
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

  it('retires NULL and non-object loop states at boot and resolves the valid neighbour once', async () => {
    const handle = makeSqliteStore()
    handles.push(handle)
    const manager = new ConversationManager(handle.store)
    const checkpoints = new ModelStepCheckpointStore(handle.persistQueue, {
      now: () => Date.now(),
      blockedTtlMs: TTL_MS,
    })
    const nullLoop = await claimedApprovalSession(handle, manager, checkpoints, {
      threadId: 'null-loop-chat',
      messageId: 'null-loop-message',
      checkpointId: 'checkpoint-null-loop',
      originTaskId: 'null-loop-origin',
      continuationTaskId: 'null-loop-task',
      requestId: 'approval-null-loop',
    })
    const malformedLoop = await claimedApprovalSession(handle, manager, checkpoints, {
      threadId: 'malformed-loop-chat',
      messageId: 'malformed-loop-message',
      checkpointId: 'checkpoint-malformed-loop',
      originTaskId: 'malformed-loop-origin',
      continuationTaskId: 'malformed-loop-task',
      requestId: 'approval-malformed-loop',
    })
    const validLoop = await claimedApprovalSession(handle, manager, checkpoints, {
      threadId: 'valid-loop-chat',
      messageId: 'valid-loop-message',
      checkpointId: 'checkpoint-valid-loop',
      originTaskId: 'valid-loop-origin',
      continuationTaskId: 'valid-loop-task',
      requestId: 'approval-valid-loop',
    })
    const setLoopState = handle.worker.db.prepare(
      'UPDATE model_step_checkpoints SET loop_state = ? WHERE checkpoint_id = ?'
    )
    expect(setLoopState.run(null, 'checkpoint-null-loop').changes).toBe(1)
    expect(setLoopState.run('{}', 'checkpoint-malformed-loop').changes).toBe(1)
    const stateMachine = bootStateMachine(handle, checkpoints)
    const approvals = () =>
      handle.worker.db.prepare('SELECT request_id FROM pending_approvals ORDER BY request_id').all()
    // Liveness: all three approvals are durable and projected before boot, so
    // their later retirement is boot's work and not an empty fixture.
    expect(approvals()).toEqual([
      { request_id: 'approval-malformed-loop' },
      { request_id: 'approval-null-loop' },
      { request_id: 'approval-valid-loop' },
    ])
    for (const pending of [nullLoop, malformedLoop, validLoop]) {
      expect(pending.conversation.pending_approval?.request_id).toBe(pending.requestId)
    }
    const warn = vi.spyOn(logger, 'warn')

    await expect(stateMachine.bootstrap()).resolves.toBeUndefined()

    expect(approvals()).toEqual([{ request_id: 'approval-valid-loop' }])
    expect(stateMachine.getPendingApprovals().map(approval => approval.requestId)).toEqual([
      'approval-valid-loop',
    ])
    for (const retired of [nullLoop, malformedLoop]) {
      expect(retired.conversation.state).toBe(ConversationState.Idle)
      expect(retired.conversation.pending_approval).toBeUndefined()
      expect(warn).toHaveBeenCalledWith(
        {
          sessionKey: retired.sessionKey,
          taskId: retired.continuationTaskId,
          code: 'MODEL_STEP_CHECKPOINT_CORRUPT',
        },
        'Pending approval checkpoint is corrupt; retiring approval'
      )
    }
    expect(validLoop.conversation.pending_approval?.request_id).toBe('approval-valid-loop')
    // The valid neighbour is registered exactly once, so one decision settles it.
    expect(await stateMachine.handleDenial(USER, 'approval-valid-loop', 'rpc', 'chatllm')).toEqual({
      success: true,
    })
    expect(approvals()).toEqual([])
    expect(await stateMachine.handleDenial(USER, 'approval-valid-loop', 'rpc', 'chatllm')).toEqual({
      success: false,
      error: 'No pending approval for request approval-valid-loop',
    })
  })
})
