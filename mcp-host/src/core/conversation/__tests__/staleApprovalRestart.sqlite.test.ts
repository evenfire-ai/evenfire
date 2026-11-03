/**
 * WP-H9a — a refused stale-approval cleanup deletes only its own row.
 *
 * Sequence under test (the T1 residue): the cleanup of approval A fails and
 * leaves its row behind, the origin turn then fails, the continuation B claims
 * the same turn and suspends for its own approval, and A's queued retry runs
 * while B is the session's current approval. The retry must refuse to touch B's
 * session (RAM and durable) and must still delete A's own row: otherwise A
 * outlives every cold read until the next boot prune, and
 * `selectPendingApprovalBySession` returns it as the session's pending
 * approval.
 *
 * The final part restarts on a fresh store over the same database file and
 * boots through `AgentStateMachine.bootstrap` + `SqliteColdStartLoader`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { sourceMessageForResume } from '../../../agent/sourceMessageForResume'
import { AgentStateMachine } from '../../../agent/stateMachine'
import { config as appConfig } from '../../../config'
import { LlmErrorCode } from '../../../core/errors'
import { ConversationState } from '../../../core/types'
import { TaskLifecycle } from '../../../lifecycle/taskLifecycle'
import type { SingleTurnProvider } from '../../../llm/types'
import { logger } from '../../../logger'
import { McpManager } from '../../../mcp/manager'
import { MessageQueue } from '../../../queue/messageQueue'
import type { IncomingMessage } from '../../../server/types'
import { ConversationManager } from '../conversation'
import { type StoreHandle, makeSqliteStore } from '../persistence/__tests__/testHelpers'
import { ModelStepCheckpointStore } from '../persistence/modelStepCheckpointStore'
import { SqliteColdStartLoader } from '../persistence/sqliteColdStartLoader'

const TTL_MS = 86_400_000
const LEASE_MS = 300_000
const HOST_ID = 'wp-h9a-host'
const POD_A_INSTANCE = 'wp-h9a-pod-a'
const POD_B_INSTANCE = 'wp-h9a-pod-b'
const USER = 'wp-h9a-user'
const CHAT = 'wp-h9a-chat'
const SESSION_KEY = `${USER}:rpc:chatllm:${CHAT}`
const MODEL = 'wp-h9a-model'
const ORIGIN_TASK_ID = 'wp-h9a-origin-task'
const CONTINUATION_TASK_ID = 'wp-h9a-continuation-task'

const savedConfig = {
  enableApproval: appConfig.enableApproval,
  dynamicToolsEnabled: appConfig.dynamicToolsEnabled,
}

beforeEach(() => {
  Object.assign(appConfig, { enableApproval: true, dynamicToolsEnabled: false })
})

afterEach(() => {
  Object.assign(appConfig, savedConfig)
  vi.restoreAllMocks()
})

function incoming(): IncomingMessage {
  return {
    sender: USER,
    content: 'Continue the saved turn',
    channelType: 'rpc',
    channelId: 'chatllm',
    threadId: CHAT,
    messageId: 'wp-h9a-message',
    timestamp: new Date().toISOString(),
    hostRef: HOST_ID,
  }
}

function budget() {
  return {
    elapsedActiveMs: 0,
    iterationsUsed: 0,
    durationMs: TTL_MS,
    maxIterations: 20,
    attachmentReadLedger: { reads: 0, spentTokens: 0, bytesRead: 0 },
  }
}

function checkpointsFor(pod: StoreHandle): ModelStepCheckpointStore {
  return new ModelStepCheckpointStore(pod.persistQueue, {
    now: () => Date.now(),
    blockedTtlMs: TTL_MS,
  })
}

function bootAgent(pod: StoreHandle, checkpoints: ModelStepCheckpointStore): AgentStateMachine {
  const provider: SingleTurnProvider = {
    getProviderType: () => 'openai',
    classifyError: () => ({
      code: LlmErrorCode.ApiCallFailed,
      retryable: false,
      message: 'Boot must not call a model',
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
  stateMachine.setConversationStore(pod.store)
  stateMachine.setMcpManager(new McpManager())
  stateMachine.setLLMProvider(provider, MODEL)
  stateMachine.setTaskModelResolver(() => ({
    provider,
    model: MODEL,
    contextWindowTokens: 100_000,
  }))
  stateMachine.setModelStepCheckpoints({
    store: checkpoints,
    hostInstanceId: POD_B_INSTANCE,
    hostId: HOST_ID,
    resumableTtlMs: TTL_MS,
    claimLeaseMs: LEASE_MS,
    pendingApprovalTtlMs: TTL_MS,
    attachmentTtlMs: 3_600_000,
  })
  stateMachine.setColdStartLoader(new SqliteColdStartLoader(pod.store))
  return stateMachine
}

describe('stale pending-approval refusal (WP-H9a)', () => {
  let dbPath: string
  const open: StoreHandle[] = []

  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-h9a-'))
    dbPath = path.join(dir, 'state.db')
  })

  afterEach(async () => {
    for (const handle of open.splice(0)) await handle.shutdown()
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true })
  })

  it('deletes only the refused row and reboots the owning approval', async () => {
    const msg = incoming()
    // The first `delete_pending_approval` for request-A fails at the worker,
    // exactly like a transient SQLite failure in A's cleanup.
    let failACleanupOnce = true
    const podA = makeSqliteStore({
      dbPath,
      holdOps: async op => {
        if (
          failACleanupOnce &&
          op.kind === 'delete_pending_approval' &&
          op.requestId === 'request-A'
        ) {
          failACleanupOnce = false
          throw new Error('SQLITE_IOERR: injected approval cleanup failure')
        }
      },
    })
    open.push(podA)
    const managerA = new ConversationManager(podA.store)
    const checkpointsA = checkpointsFor(podA)
    const conversation = await managerA.getOrCreate(SESSION_KEY, {
      userId: msg.sender,
      channelType: msg.channelType,
      channelId: msg.channelId,
      threadId: msg.threadId,
      source: 'rpc',
    })
    const pendingRows = () =>
      podA.worker.db
        .prepare('SELECT request_id, task_id FROM pending_approvals ORDER BY registered_at')
        .all()
    const sessionRow = (handle: StoreHandle = podA) =>
      handle.worker.db
        .prepare(
          'SELECT state, ended_at, end_reason, active_task_id, active_trace_context FROM sessions WHERE session_key = ?'
        )
        .get(SESSION_KEY)

    await managerA.startTurn(conversation, msg.content, ORIGIN_TASK_ID)
    await managerA.suspendForApproval(conversation, {
      request_id: 'request-A',
      tool_name: 'shell_exec',
      tool_call_id: 'call-A',
      parameters: {},
      description: 'stale approval',
      context_snapshot: [{ role: 'user', content: msg.content }],
      task_budget: budget(),
      sourceMessage: sourceMessageForResume(msg),
    })
    expect(pendingRows()).toEqual([{ request_id: 'request-A', task_id: ORIGIN_TASK_ID }])
    await expect(managerA.clearPendingApproval(SESSION_KEY, 'request-A')).rejects.toThrow(
      'injected approval cleanup failure'
    )
    // A's cleanup failed after clearing RAM: its durable row survives and the
    // session row still names A. The activity liveness witness is above.
    expect(pendingRows()).toEqual([{ request_id: 'request-A', task_id: ORIGIN_TASK_ID }])
    expect(sessionRow()).toMatchObject({
      state: 'awaiting_approval',
      active_task_id: ORIGIN_TASK_ID,
    })
    await managerA.failTurn(conversation)

    // B is the continuation of the same origin turn; it claims the checkpoint
    // and suspends for its own approval.
    const fence = await checkpointsA.open(
      {
        checkpointId: 'wp-h9a-checkpoint',
        sessionKey: SESSION_KEY,
        originTurnNumber: 1,
        originTaskId: ORIGIN_TASK_ID,
        provider: 'openai',
        model: MODEL,
        hostId: HOST_ID,
        principal: USER,
        loopState: JSON.stringify({ nextIteration: 0, originUserMessageIndex: 0 }),
        taskBudget: JSON.stringify(budget()),
        sourceMessage: JSON.stringify(sourceMessageForResume(msg)),
      },
      [
        {
          kind: 'message',
          toolCallId: null,
          payload: JSON.stringify({ role: 'user', content: msg.content }),
        },
      ]
    )
    const version = await checkpointsA.transition(SESSION_KEY, fence, {
      from: ['open'],
      to: 'resumable',
      failedAt: Date.now(),
      expiresAt: Date.now() + TTL_MS,
    })
    if (version === null) throw new Error('fixture failed to make the checkpoint resumable')
    const claim = await checkpointsA.claim({
      sessionKey: SESSION_KEY,
      checkpointId: fence.checkpointId,
      version,
      hostInstanceId: POD_A_INSTANCE,
      newTaskId: CONTINUATION_TASK_ID,
      leaseMs: LEASE_MS,
    })
    if (claim.outcome !== 'claimed') throw new Error(`fixture claim failed: ${claim.outcome}`)
    await managerA.resumeTurnForContinuation(
      conversation,
      CONTINUATION_TASK_ID,
      1,
      null,
      undefined,
      {
        fence: claim.fence,
        activeTaskId: CONTINUATION_TASK_ID,
        originTurnNumber: 1,
      }
    )
    await managerA.suspendForApproval(conversation, {
      request_id: 'request-B',
      tool_name: 'shell_exec',
      tool_call_id: 'call-B',
      parameters: {},
      description: 'current approval',
      context_snapshot: [{ role: 'user', content: msg.content }],
      task_budget: budget(),
      sourceMessage: sourceMessageForResume(msg),
    })
    expect(pendingRows()).toEqual([
      { request_id: 'request-A', task_id: ORIGIN_TASK_ID },
      { request_id: 'request-B', task_id: CONTINUATION_TASK_ID },
    ])
    const approvalB = conversation.pending_approval
    const updatedAt = conversation.updated_at
    const traceContext = conversation.traceContext
    const beforeSession = sessionRow()
    const warn = vi.spyOn(logger, 'warn')

    // A's queued retry fires while B is current: refused, but A's own row must
    // not outlive the retry.
    const cleared = await managerA.clearPendingApproval(SESSION_KEY, 'request-A')
    await podA.persistQueue.drain()

    expect(cleared).toBe(false)
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: SESSION_KEY,
        requestId: 'request-A',
        currentRequestId: 'request-B',
      }),
      expect.any(String)
    )
    // The refused row is gone; B's row and the owning session row are untouched.
    expect(pendingRows()).toEqual([{ request_id: 'request-B', task_id: CONTINUATION_TASK_ID }])
    // No session write followed the refusal: every column `update_session_state`
    // can move is byte-identical to the snapshot taken before it.
    expect(sessionRow()).toEqual(beforeSession)
    expect(sessionRow()).toMatchObject({
      state: 'awaiting_approval',
      active_task_id: CONTINUATION_TASK_ID,
    })
    expect(conversation.pending_approval).toBe(approvalB)
    expect(conversation.state).toBe(ConversationState.AwaitingApproval)
    expect(conversation.activeTaskId).toBe(CONTINUATION_TASK_ID)
    expect(conversation.traceContext).toBe(traceContext)
    expect(conversation.updated_at).toBe(updatedAt)

    // Restart: a fresh store over the same file, the production boot path, and
    // B rehydrated as the one resolvable approval.
    await podA.shutdown()
    open.splice(open.indexOf(podA), 1)
    const podB = makeSqliteStore({ dbPath })
    open.push(podB)
    const checkpointsB = checkpointsFor(podB)
    await checkpointsB.bootReap(POD_B_INSTANCE)
    const stateMachine = bootAgent(podB, checkpointsB)
    await expect(stateMachine.bootstrap()).resolves.toBeUndefined()
    expect(stateMachine.getPendingApprovals().map(a => a.requestId)).toEqual(['request-B'])
    expect(sessionRow(podB)).toMatchObject({
      state: 'awaiting_approval',
      active_task_id: CONTINUATION_TASK_ID,
    })
    // The rehydrated executor owns B: its deny is accepted once.
    await expect(stateMachine.handleDenial(USER, 'request-B', 'rpc', 'chatllm')).resolves.toEqual({
      success: true,
    })
    expect(pendingRowsFor(podB)).toEqual([])
  })
})

function pendingRowsFor(pod: StoreHandle) {
  return pod.worker.db.prepare('SELECT request_id FROM pending_approvals').all()
}
