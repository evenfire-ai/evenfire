import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Request, Response } from 'express'
import { config as appConfig } from '../../config'
import { ConversationManager } from '../../core/conversation/conversation'
import { toModelStepCheckpointView } from '../../core/conversation/modelStepCheckpointView'
import {
  type StoreHandle,
  makeSqliteStore,
} from '../../core/conversation/persistence/__tests__/testHelpers'
import { ModelStepCheckpointStore } from '../../core/conversation/persistence/modelStepCheckpointStore'
import { syncTimeoutLateSettlement } from '../../core/conversation/persistence/persistQueue'
import { SqliteColdStartLoader } from '../../core/conversation/persistence/sqliteColdStartLoader'
import { SqliteConversationStore } from '../../core/conversation/persistence/sqliteConversationStore'
import { LlmErrorCode } from '../../core/errors'
import { FinishReason } from '../../core/types'
import type { WorkerMessage, WorkerOp } from '../../db/worker/protocol'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import type { SingleTurnProvider } from '../../llm/types'
import { McpManager } from '../../mcp/manager'
import { MessageQueue } from '../../queue/messageQueue'
import type { ModelStepContinuationRef, Task, TaskResponsePayload } from '../../queue/types'
import { makeHandlers } from '../../server/__tests__/testHelpers'
import { handleModelStepContinuationRoute } from '../../server/routes'
import type { IncomingMessage } from '../../server/types'
import { ModelStepContinuationService } from '../modelStepContinuation'
import { sourceMessageForResume } from '../sourceMessageForResume'
import { AgentStateMachine } from '../stateMachine'

const START = 1_700_000_000_000
const TTL = 7 * 24 * 3_600_000
const LEASE = 300_000
const USER = 'live-replay-user'
const AGENT = 'chatllm'
const HOST = 'live-replay-host'
const OLD_OWNER = 'live-replay-old-instance'
const OWNER = 'live-replay-instance'
const MODEL = 'live-replay-model'
const handles: StoreHandle[] = []
const savedConfig = {
  enableApproval: appConfig.enableApproval,
  dynamicToolsEnabled: appConfig.dynamicToolsEnabled,
}
let now: number

beforeEach(() => {
  now = START
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  Object.assign(appConfig, { enableApproval: true, dynamicToolsEnabled: false })
})

afterEach(async () => {
  Object.assign(appConfig, savedConfig)
  vi.restoreAllMocks()
  for (const handle of handles.splice(0)) await handle.shutdown()
})

function message(chatId: string): IncomingMessage {
  return {
    sender: USER,
    content: 'Continue the earlier model step',
    channelType: 'rpc',
    channelId: AGENT,
    threadId: chatId,
    messageId: `message-${chatId}`,
    timestamp: new Date(START).toISOString(),
    hostRef: HOST,
  }
}

function budget() {
  return {
    elapsedActiveMs: 0,
    iterationsUsed: 0,
    durationMs: 300_000,
    maxIterations: 20,
    attachmentReadLedger: { reads: 0, spentTokens: 0, bytesRead: 0 },
  }
}

async function resumable(
  manager: ConversationManager,
  checkpoints: ModelStepCheckpointStore,
  chatId: string
) {
  const sessionKey = `${USER}:rpc:${AGENT}:${chatId}`
  const checkpointId = `checkpoint-${chatId}`
  const originTaskId = `origin-${chatId}`
  const source = message(chatId)
  const conversation = await manager.getOrCreate(sessionKey, {
    userId: USER,
    channelType: 'rpc',
    channelId: AGENT,
    threadId: chatId,
    source: 'rpc',
  })
  await manager.startTurn(conversation, source.content, originTaskId)
  await manager.failTurn(conversation)
  const fence = await checkpoints.open(
    {
      checkpointId,
      sessionKey,
      originTurnNumber: 1,
      originTaskId,
      provider: 'zai',
      model: MODEL,
      hostId: HOST,
      principal: USER,
      loopState: JSON.stringify({ nextIteration: 0, originUserMessageIndex: 0 }),
      taskBudget: JSON.stringify(budget()),
      sourceMessage: JSON.stringify(sourceMessageForResume(source)),
    },
    [
      {
        kind: 'message',
        toolCallId: null,
        payload: JSON.stringify({ role: 'user', content: source.content }),
      },
    ]
  )
  const version = await checkpoints.transition(sessionKey, fence, {
    from: ['open'],
    to: 'resumable',
    failedAt: START,
    expiresAt: START + TTL,
  })
  if (version === null) throw new Error('Expected resumable checkpoint')
  return { sessionKey, checkpointId, conversation, version, source }
}

function fixture(
  options: {
    storeOptions?: Parameters<typeof makeSqliteStore>[0]
    detached?: boolean
  } = {}
) {
  const handle = makeSqliteStore(options.storeOptions)
  handles.push(handle)
  const checkpoints = new ModelStepCheckpointStore(handle.persistQueue, {
    now: () => now,
    blockedTtlMs: TTL,
  })
  const support = {
    store: checkpoints,
    hostInstanceId: OWNER,
    hostId: HOST,
    resumableTtlMs: TTL,
    claimLeaseMs: LEASE,
    pendingApprovalTtlMs: TTL,
    attachmentTtlMs: 3_600_000,
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
  const modelCalls = vi.fn(async () => ({
    content: 'Healthy continuation completed',
    tool_calls: [],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    finish_reason: FinishReason.Stop,
  }))
  const provider: SingleTurnProvider = {
    getProviderType: () => 'zai',
    classifyError: error => ({
      code: LlmErrorCode.ApiCallFailed,
      retryable: false,
      message: String(error),
    }),
    completeSingleTurn: async () => {
      throw new Error('Unexpected tool-less call')
    },
    completeSingleTurnWithTools: modelCalls,
  }
  stateMachine.setLLMProvider(provider, MODEL)
  stateMachine.setTaskModelResolver(() => ({
    provider,
    model: MODEL,
    contextWindowTokens: 100_000,
  }))
  stateMachine.setModelStepCheckpoints(support)
  const responses = vi.fn(async (_payload: TaskResponsePayload) => {})
  const executions: Array<Promise<boolean>> = []
  const enqueue = vi.fn(
    async (sourceMessage: IncomingMessage, id: string, continuation: ModelStepContinuationRef) => {
      const task: Task = {
        id,
        source: 'channel',
        sourceMessage,
        priority: 'normal',
        status: 'pending',
        createdAt: new Date(now),
        conversationHistory: [],
        responseCallback: responses,
        modelStepContinuation: continuation,
      }
      lifecycle.register(task)
      if (options.detached) lifecycle.transition(task.id, 'processing', 'dispatched')
      const execution = stateMachine.executeTask(task)
      executions.push(execution)
      if (!options.detached) await execution
    }
  )
  const hasLiveExecutor = (taskId: string) => stateMachine.hasLiveExecutor(taskId)
  const deps = {
    checkpoints: support,
    conversationManager: stateMachine.getConversationManager(),
    enqueue,
    hasLiveExecutor,
  }
  const service = new ModelStepContinuationService(deps)
  const row = (id: string) =>
    handle.worker.db
      .prepare(
        'SELECT status, continuation_task_id, claim_generation FROM model_step_checkpoints WHERE checkpoint_id = ?'
      )
      .get(id)
  return {
    handle,
    checkpoints,
    stateMachine,
    lifecycle,
    support,
    service,
    enqueue,
    responses,
    executions,
    modelCalls,
    hasLiveExecutor,
    row,
  }
}

async function continueHealthy(f: ReturnType<typeof fixture>, chatId: string) {
  const cp = await resumable(f.stateMachine.getConversationManager(), f.checkpoints, chatId)
  const beforeCalls = f.modelCalls.mock.calls.length
  const beforeResponses = f.responses.mock.calls.length
  const result = await f.service.continue({
    userId: USER,
    agent: AGENT,
    chatId,
    checkpointId: cp.checkpointId,
    version: cp.version,
  })
  expect(result.status).toBe(202)
  expect(f.modelCalls).toHaveBeenCalledTimes(beforeCalls + 1)
  expect(f.responses).toHaveBeenCalledTimes(beforeResponses + 1)
  expect(f.row(cp.checkpointId)).toMatchObject({ status: 'completed' })
}

describe('Model-step continuation live replay (SQLite)', () => {
  it.each(['committed', 'not committed', 'reclaimed'] as const)(
    'WP-H11: a late continuation start %s after HTTP 202',
    async outcome => {
      let release!: () => void
      let enter!: () => void
      const held = new Promise<void>(resolve => {
        release = resolve
      })
      const entered = new Promise<void>(resolve => {
        enter = resolve
      })
      const isStart = (op: WorkerOp) =>
        op.kind === 'update_session_state' &&
        op.state === 'processing' &&
        op.activeTaskId !== 'replacement-task' &&
        !!op.modelStepTurnFence
      const f = fixture({
        detached: true,
        storeOptions: {
          persistQueue: { syncTimeoutMs: 25 },
          holdOps: op => {
            if (!isStart(op)) return Promise.resolve()
            enter()
            return held
          },
        },
      })
      const chatId = `late-start-${outcome.replace(' ', '-')}`
      const cp = await resumable(f.stateMachine.getConversationManager(), f.checkpoints, chatId)
      const initialSession = f.handle.worker.db
        .prepare('SELECT state, active_task_id FROM sessions WHERE session_key = ?')
        .get(cp.sessionKey)

      let timeoutReached!: () => void
      const timedOut = new Promise<void>(resolve => {
        timeoutReached = resolve
      })
      const enqueueSync = f.handle.persistQueue.enqueueSync.bind(f.handle.persistQueue)
      vi.spyOn(f.handle.persistQueue, 'enqueueSync').mockImplementation(((
        op: WorkerOp,
        key?: string
      ) => {
        const result = enqueueSync(op, key)
        if (isStart(op)) {
          result.catch(error => {
            if (syncTimeoutLateSettlement(error)) timeoutReached()
          })
        }
        return result
      }) as typeof f.handle.persistQueue.enqueueSync)

      let startId: string | undefined
      let replyReceived!: (reply: { ok: boolean; error?: { message?: string } }) => void
      const lateReply = new Promise<{ ok: boolean; error?: { message?: string } }>(resolve => {
        replyReceived = resolve
      })
      const postMessage = f.handle.worker.worker.postMessage.bind(f.handle.worker.worker)
      vi.spyOn(f.handle.worker.worker, 'postMessage').mockImplementation(
        (message: WorkerMessage) => {
          if (isStart(message.op)) startId = message.id
          postMessage(message)
        }
      )
      f.handle.worker.worker.on('message', reply => {
        if (reply.id === startId) replyReceived(reply)
      })

      const res = { writeHead: vi.fn(), end: vi.fn() }
      const request = handleModelStepContinuationRoute(
        {
          params: { agent: AGENT, chatId, checkpointId: cp.checkpointId },
          body: { version: cp.version },
          runtimeCaller: { caller: 'rpc-proxy', userId: USER, hostRef: HOST },
          headers: {
            'x-clerum-edge-trace-context': encodeURIComponent(
              JSON.stringify({
                version: 1,
                runId: 'late-start',
                sessionId: chatId,
                origin: 'direct_chat',
                correlationRefs: [],
              })
            ),
          },
        } as unknown as Request,
        res as unknown as Response,
        makeHandlers({ modelStepContinuationHandler: request => f.service.continue(request) })
      )
      let responsesBeforeReply = -1
      let statusBeforeReply: unknown
      let replacementConversation:
        | Awaited<ReturnType<ConversationManager['getOrCreate']>>
        | undefined
      let staleExecutor: { continuationClaim: { fenceLost: boolean } } | undefined
      try {
        await entered
        await request
        await timedOut
        responsesBeforeReply = f.responses.mock.calls.length
        statusBeforeReply = f.row(cp.checkpointId)
        if (outcome === 'not committed') {
          f.handle.worker.db.exec(`
            CREATE TRIGGER reject_late_start BEFORE UPDATE OF state ON sessions
            WHEN NEW.state = 'processing'
            BEGIN SELECT RAISE(ABORT, 'late start rejected'); END;
          `)
        }
        if (outcome === 'reclaimed') {
          const body = JSON.parse(res.end.mock.calls[0]![0])
          staleExecutor = (
            f.stateMachine as unknown as {
              activeExecutors: Map<string, { continuationClaim: { fenceLost: boolean } }>
            }
          ).activeExecutors.get(body.taskId)
          if (!staleExecutor) throw new Error('Original executor is not live at reclaim')
          now += LEASE + 1
          const claim = await f.checkpoints.claim({
            sessionKey: cp.sessionKey,
            checkpointId: cp.checkpointId,
            version: cp.version,
            hostInstanceId: 'replacement-owner',
            newTaskId: 'replacement-task',
            leaseMs: LEASE,
          })
          if (claim.outcome !== 'claimed') throw new Error(`Replacement claim: ${claim.outcome}`)
          expect(claim.fence.owner).toBe('replacement-owner')
          expect(claim.fence.generation).toBe(2)
          const replacementManager = new ConversationManager(
            new SqliteConversationStore(f.handle.persistQueue, { cacheSize: 8 })
          )
          replacementConversation = await replacementManager.getOrCreate(cp.sessionKey)
          await replacementManager.resumeTurnForContinuation(
            replacementConversation,
            'replacement-task',
            1,
            null,
            undefined,
            { fence: claim.fence, activeTaskId: 'replacement-task', originTurnNumber: 1 }
          )
          expect(
            f.handle.worker.db
              .prepare('SELECT state, active_task_id FROM sessions WHERE session_key = ?')
              .get(cp.sessionKey)
          ).toEqual({ state: 'processing', active_task_id: 'replacement-task' })
          expect(f.responses).not.toHaveBeenCalled()
        }
      } finally {
        release()
      }
      const reply = await lateReply
      await Promise.all(f.executions)
      await f.handle.persistQueue.drain()

      // Witness the actual worker reply, not merely the timer or a mocked outcome.
      expect(startId).toBeDefined()
      expect(reply.ok).toBe(outcome === 'committed')
      if (outcome === 'not committed') expect(reply.error?.message).toContain('late start rejected')
      if (outcome === 'reclaimed')
        expect(reply.error?.message).toBe('model-step continuation fence mismatch')
      expect(res.writeHead).toHaveBeenCalledWith(202, { 'Content-Type': 'application/json' })
      const body = JSON.parse(res.end.mock.calls[0]![0])
      expect(body).toMatchObject({
        checkpointId: cp.checkpointId,
        status: 'claimed',
        replayed: false,
      })
      expect(responsesBeforeReply).toBe(0)
      expect(statusBeforeReply).toMatchObject({ status: 'claimed' })

      if (outcome === 'not committed') {
        expect(f.modelCalls).not.toHaveBeenCalled()
        expect(f.responses).toHaveBeenCalledTimes(1)
        expect(f.responses.mock.calls[0]![0]).toEqual(
          expect.objectContaining({ error: expect.anything() })
        )
        expect(
          f.lifecycle.get(body.taskId)?.history.filter(event => event.to === 'failed')
        ).toHaveLength(1)
        expect(
          f.handle.worker.db
            .prepare('SELECT state, active_task_id FROM sessions WHERE session_key = ?')
            .get(cp.sessionKey)
        ).toEqual(initialSession)
        expect(f.row(cp.checkpointId)).toMatchObject({ status: 'resumable' })
        const snapshot = await f.checkpoints.loadLive(cp.sessionKey)
        if (!snapshot) throw new Error('Expected a live resumable checkpoint')
        expect(toModelStepCheckpointView(snapshot)).toMatchObject({
          status: 'resumable',
          retryAvailable: true,
        })
      } else if (outcome === 'reclaimed') {
        expect(staleExecutor?.continuationClaim.fenceLost).toBe(true)
        expect(f.modelCalls).not.toHaveBeenCalled()
        expect(f.responses).toHaveBeenCalledTimes(1)
        expect(f.responses.mock.calls[0]![0]).toEqual(
          expect.objectContaining({ error: expect.anything() })
        )
        expect(
          f.lifecycle.get(body.taskId)?.history.filter(event => event.to === 'failed')
        ).toHaveLength(1)
        expect(f.row(cp.checkpointId)).toMatchObject({
          status: 'claimed',
          continuation_task_id: 'replacement-task',
          claim_generation: 2,
        })
        expect(
          f.handle.worker.db
            .prepare('SELECT state, active_task_id FROM sessions WHERE session_key = ?')
            .get(cp.sessionKey)
        ).toEqual({ state: 'processing', active_task_id: 'replacement-task' })
        expect(replacementConversation).toMatchObject({
          state: 'processing',
          activeTaskId: 'replacement-task',
        })
      } else {
        expect(f.modelCalls).toHaveBeenCalledTimes(1)
        expect(f.responses).toHaveBeenCalledTimes(1)
        expect(f.responses.mock.calls[0]![0]).toEqual(
          expect.objectContaining({ response: 'Healthy continuation completed' })
        )
        expect(f.row(cp.checkpointId)).toMatchObject({ status: 'completed' })
        expect(
          f.handle.worker.db
            .prepare('SELECT state, active_task_id FROM sessions WHERE session_key = ?')
            .get(cp.sessionKey)
        ).toEqual({ state: 'idle', active_task_id: null })
        expect(
          f.handle.worker.db
            .prepare('SELECT role, content FROM messages WHERE session_id = ? ORDER BY ordinal')
            .all(cp.conversation.id)
        ).toEqual([
          { role: 'user', content: cp.source.content },
          { role: 'assistant', content: 'Healthy continuation completed' },
        ])
      }
    }
  )

  it.each([
    ['direct storage rejection', 'start write rejected', 'resumable'],
    ['fence mismatch', 'model-step continuation fence mismatch', 'abandoned'],
    ['owner mismatch', 'model-step continuation task owner mismatch', 'abandoned'],
  ] as const)(
    'WP-H11: %s at start has the correct claim classification',
    async (_label, reason, status) => {
      const f = fixture({ detached: true })
      const cp = await resumable(
        f.stateMachine.getConversationManager(),
        f.checkpoints,
        'direct-start'
      )
      f.handle.worker.db.exec(`
      CREATE TRIGGER reject_direct_start BEFORE UPDATE OF state ON sessions
      WHEN NEW.state = 'processing'
      BEGIN SELECT RAISE(ABORT, '${reason}'); END;
    `)
      const reply = vi.fn()
      let startId: string | undefined
      const postMessage = f.handle.worker.worker.postMessage.bind(f.handle.worker.worker)
      vi.spyOn(f.handle.worker.worker, 'postMessage').mockImplementation(
        (message: WorkerMessage) => {
          if (
            message.op.kind === 'update_session_state' &&
            message.op.modelStepTurnFence &&
            message.op.state === 'processing'
          ) {
            startId = message.id
          }
          postMessage(message)
        }
      )
      f.handle.worker.worker.on('message', message => {
        if (message.id === startId) reply(message)
      })
      const result = await f.service.continue({
        userId: USER,
        agent: AGENT,
        chatId: 'direct-start',
        checkpointId: cp.checkpointId,
        version: cp.version,
      })
      await Promise.all(f.executions)
      await f.handle.persistQueue.drain()

      expect(reply).toHaveBeenCalledTimes(1)
      expect(reply.mock.calls[0]![0]).toMatchObject({ ok: false, error: { message: reason } })
      expect(result.status).toBe(202)
      expect(f.responses).toHaveBeenCalledTimes(1)
      expect(f.responses.mock.calls[0]![0]).toEqual(
        expect.objectContaining({ error: expect.anything() })
      )
      expect(f.modelCalls).not.toHaveBeenCalled()
      expect(f.row(cp.checkpointId)).toMatchObject({ status })
      const row = f.handle.worker.db
        .prepare('SELECT state, active_task_id FROM sessions WHERE session_key = ?')
        .get(cp.sessionKey)
      expect(row).toEqual({ state: 'idle', active_task_id: null })
    }
  )

  it('returns 503 when a failed executor is still registered for a live claim', async () => {
    const f = fixture()
    const cp = await resumable(f.stateMachine.getConversationManager(), f.checkpoints, 'terminal')
    const claim = await f.checkpoints.claim({
      sessionKey: cp.sessionKey,
      checkpointId: cp.checkpointId,
      version: cp.version,
      hostInstanceId: OWNER,
      newTaskId: 'terminal-task',
      leaseMs: LEASE,
    })
    if (claim.outcome !== 'claimed') throw new Error('Expected claimed checkpoint')
    await continueHealthy(f, 'neighbor-terminal')

    const registry = (
      f.stateMachine as unknown as { activeExecutors: Map<string, { executorState: string }> }
    ).activeExecutors
    const deleteEntry = registry.delete.bind(registry)
    const deletion = vi
      .spyOn(registry, 'delete')
      .mockImplementation(taskId => (taskId === 'terminal-task' ? false : deleteEntry(taskId)))
    const renew = vi
      .spyOn(f.checkpoints, 'renewLease')
      .mockRejectedValueOnce(new Error('renew failed'))
    const release = vi
      .spyOn(f.checkpoints, 'transition')
      .mockRejectedValueOnce(new Error('release failed'))
    const onVerdict = vi.fn()
    const onAdmissionError = vi.fn()
    const response = vi.fn(async () => {})
    const task: Task = {
      id: 'terminal-task',
      source: 'channel',
      sourceMessage: cp.source,
      priority: 'normal',
      status: 'pending',
      createdAt: new Date(now),
      conversationHistory: [],
      responseCallback: response,
      modelStepContinuation: {
        checkpointId: cp.checkpointId,
        originTaskId: 'origin-terminal',
        originTurnNumber: 1,
        provider: 'zai',
        model: MODEL,
        fence: claim.fence,
        confirmedResults: claim.snapshot.tools.confirmed,
        taskBudget: claim.snapshot.header.task_budget,
        onVerdict,
        onAdmissionError,
      },
    }
    f.lifecycle.register(task)
    await f.stateMachine.executeTask(task)
    expect(renew).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)
    expect(onAdmissionError).toHaveBeenCalledTimes(1)
    expect(onVerdict).not.toHaveBeenCalled()
    expect(response).toHaveBeenCalledTimes(1)
    expect(deletion).toHaveBeenCalledWith(task.id)
    expect(registry.get(task.id)?.executorState).toBe('failed')
    expect(f.row(cp.checkpointId)).toMatchObject({
      status: 'claimed',
      continuation_task_id: task.id,
      claim_generation: 1,
    })

    const result = await f.service.continue({
      userId: USER,
      agent: AGENT,
      chatId: 'terminal',
      checkpointId: cp.checkpointId,
      version: cp.version,
    })
    expect(result).toEqual({ status: 503, body: { code: 'continuation_claim_settling' } })
  })

  it('returns 503 while a durable claim has no executor and reclaims it after lease expiry', async () => {
    const f = fixture()
    const cp = await resumable(f.stateMachine.getConversationManager(), f.checkpoints, 'dead')
    const claim = await f.checkpoints.claim({
      sessionKey: cp.sessionKey,
      checkpointId: cp.checkpointId,
      version: cp.version,
      hostInstanceId: OWNER,
      newTaskId: 'dead-task',
      leaseMs: LEASE,
    })
    expect(claim.outcome).toBe('claimed')
    expect(f.row(cp.checkpointId)).toMatchObject({
      status: 'claimed',
      continuation_task_id: 'dead-task',
      claim_generation: 1,
    })
    expect(f.hasLiveExecutor('dead-task')).toBe(false)
    expect(
      f.handle.worker.db
        .prepare('SELECT state, active_task_id FROM sessions WHERE session_key = ?')
        .get(cp.sessionKey)
    ).toEqual({ state: 'idle', active_task_id: null })
    expect(cp.conversation.state).toBe('idle')
    expect(f.handle.worker.db.prepare('SELECT request_id FROM pending_approvals').all()).toEqual([])
    await continueHealthy(f, 'neighbor-dead')
    const beforeEnqueues = f.enqueue.mock.calls.length

    const res = { writeHead: vi.fn(), end: vi.fn() }
    await handleModelStepContinuationRoute(
      {
        params: { agent: AGENT, chatId: 'dead', checkpointId: cp.checkpointId },
        body: { version: cp.version },
        runtimeCaller: { caller: 'rpc-proxy', userId: USER, hostRef: HOST },
        headers: {
          'x-clerum-edge-trace-context': encodeURIComponent(
            JSON.stringify({
              version: 1,
              runId: 'replay-test',
              sessionId: 'dead',
              origin: 'direct_chat',
              correlationRefs: [],
            })
          ),
        },
      } as unknown as Request,
      res as unknown as Response,
      makeHandlers({ modelStepContinuationHandler: request => f.service.continue(request) })
    )
    expect(res.writeHead).toHaveBeenCalledWith(503, { 'Content-Type': 'application/json' })
    expect(JSON.parse(res.end.mock.calls[0]![0])).toEqual({ code: 'continuation_claim_settling' })
    expect(f.enqueue).toHaveBeenCalledTimes(beforeEnqueues)
    expect(f.row(cp.checkpointId)).toMatchObject({
      status: 'claimed',
      continuation_task_id: 'dead-task',
      claim_generation: 1,
    })

    now += LEASE + 1
    const reclaimed = await f.service.continue({
      userId: USER,
      agent: AGENT,
      chatId: 'dead',
      checkpointId: cp.checkpointId,
      version: cp.version,
    })
    expect(reclaimed.status).toBe(202)
    expect(reclaimed.body).toMatchObject({ checkpointId: cp.checkpointId, replayed: false })
    expect(f.enqueue).toHaveBeenCalledTimes(beforeEnqueues + 1)
    expect(f.row(cp.checkpointId)).toMatchObject({ status: 'completed', claim_generation: 2 })
  })

  it('replays a suspended continuation rehydrated after Host takeover', async () => {
    const f = fixture()
    const manager = f.stateMachine.getConversationManager()
    const cp = await resumable(manager, f.checkpoints, 'suspended')
    const claim = await f.checkpoints.claim({
      sessionKey: cp.sessionKey,
      checkpointId: cp.checkpointId,
      version: cp.version,
      hostInstanceId: OLD_OWNER,
      newTaskId: 'suspended-task',
      leaseMs: LEASE,
    })
    if (claim.outcome !== 'claimed') throw new Error('Expected claimed checkpoint')
    await manager.resumeTurnForContinuation(cp.conversation, 'suspended-task', 1, null, undefined, {
      fence: claim.fence,
      activeTaskId: 'suspended-task',
      originTurnNumber: 1,
    })
    await manager.suspendForApproval(cp.conversation, {
      request_id: 'suspended-approval',
      tool_name: 'shell_exec',
      tool_call_id: 'suspended-tool',
      parameters: {},
      description: 'Approve the continuation tool',
      context_snapshot: [{ role: 'user', content: cp.source.content }],
      task_budget: budget(),
      sourceMessage: sourceMessageForResume(cp.source),
    })
    expect(f.handle.worker.db.prepare('SELECT request_id FROM pending_approvals').all()).toEqual([
      { request_id: 'suspended-approval' },
    ])
    expect(await f.checkpoints.bootReap(OWNER)).toEqual({ abandoned: 0, reopened: 0 })
    const coldStore = new SqliteConversationStore(f.handle.persistQueue, { cacheSize: 8 })
    f.stateMachine.setConversationStore(coldStore)
    f.stateMachine.setColdStartLoader(new SqliteColdStartLoader(coldStore))
    expect(f.stateMachine.getConversationManager().getSessionByKey(cp.sessionKey)).toBeUndefined()
    expect(f.hasLiveExecutor('suspended-task')).toBe(false)
    await f.stateMachine.bootstrap()
    expect(f.stateMachine.getPendingApprovals().map(approval => approval.requestId)).toContain(
      'suspended-approval'
    )
    expect(f.row(cp.checkpointId)).toMatchObject({
      status: 'claimed',
      continuation_task_id: 'suspended-task',
    })
    expect(
      f.handle.worker.db
        .prepare('SELECT state, active_task_id FROM sessions WHERE session_key = ?')
        .get(cp.sessionKey)
    ).toEqual({ state: 'awaiting_approval', active_task_id: 'suspended-task' })
    expect(f.stateMachine.getConversationManager().getSessionByKey(cp.sessionKey)?.state).toBe(
      'awaiting_approval'
    )
    await continueHealthy(f, 'neighbor-suspended')
    const beforeEnqueues = f.enqueue.mock.calls.length

    const result = await f.service.continue({
      userId: USER,
      agent: AGENT,
      chatId: 'suspended',
      checkpointId: cp.checkpointId,
      version: cp.version,
    })
    expect(result).toEqual({
      status: 202,
      body: {
        taskId: 'suspended-task',
        checkpointId: cp.checkpointId,
        status: 'claimed',
        replayed: true,
      },
    })
    expect(f.hasLiveExecutor('suspended-task')).toBe(true)
    expect(f.enqueue).toHaveBeenCalledTimes(beforeEnqueues)
    expect(f.handle.worker.db.prepare('SELECT request_id FROM pending_approvals').all()).toEqual([
      { request_id: 'suspended-approval' },
    ])
  })
})
