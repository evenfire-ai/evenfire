import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { config as appConfig } from '../../config'
import { ConversationManager } from '../../core/conversation/conversation'
import { toModelStepCheckpointView } from '../../core/conversation/modelStepCheckpointView'
import {
  type StoreHandle,
  makeSqliteStore,
} from '../../core/conversation/persistence/__tests__/testHelpers'
import { ModelStepCheckpointStore } from '../../core/conversation/persistence/modelStepCheckpointStore'
import { LlmErrorCode } from '../../core/errors'
import { SimpleEventEmitter } from '../../core/orchestration/eventEmitter'
import { FinishReason } from '../../core/types'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import type { SingleTurnProvider } from '../../llm/types'
import { McpManager } from '../../mcp/manager'
import type { Task } from '../../queue/types'
import type { IncomingMessage } from '../../server/types'
import {
  ModelStepContinuationService,
  type ModelStepContinuationServiceDeps,
} from '../modelStepContinuation'
import { TaskExecutor, type TaskExecutorDeps } from '../taskExecutor'

const NOW = 1_700_000_000_000
const LEASE_MS = 300_000
const TTL_MS = 86_400_000
const USER = 'preparation-user'
const AGENT = 'preparation-agent'
const CHAT = 'default'
const SESSION_KEY = `${USER}:rpc:${AGENT}:${CHAT}`

let clock = NOW
const handles: StoreHandle[] = []
const savedConfig = {
  enableApproval: appConfig.enableApproval,
  dynamicToolsEnabled: appConfig.dynamicToolsEnabled,
  promptCacheEnabled: appConfig.promptCacheEnabled,
}

function provider(): SingleTurnProvider & { calls: ReturnType<typeof vi.fn> } {
  const calls = vi.fn(async () => ({
    content: 'healthy continuation completed',
    tool_calls: [],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    finish_reason: FinishReason.Stop,
  }))
  return {
    calls,
    getProviderType: () => 'openai' as never,
    classifyError: error => ({
      code: LlmErrorCode.ApiCallFailed,
      retryable: false,
      message: error instanceof Error ? error.message : String(error),
    }),
    completeSingleTurn: async () => {
      throw new Error('Unexpected tool-less completion')
    },
    completeSingleTurnWithTools: calls,
  }
}

async function fixture(options: { exhaustedBudget?: boolean } = {}) {
  const handle = makeSqliteStore()
  handles.push(handle)
  const manager = new ConversationManager(handle.store)
  const checkpoints = new ModelStepCheckpointStore(handle.persistQueue, {
    now: () => clock,
    blockedTtlMs: TTL_MS,
  })
  const message: IncomingMessage = {
    sender: USER,
    content: 'Continue the interrupted step',
    channelType: 'rpc',
    channelId: AGENT,
    threadId: CHAT,
    messageId: 'preparation-message',
    timestamp: new Date(NOW).toISOString(),
    hostRef: 'preparation-host',
  }
  const conversation = await manager.getOrCreate(SESSION_KEY, {
    userId: USER,
    channelType: 'rpc',
    channelId: AGENT,
    threadId: CHAT,
    source: 'rpc',
  })
  await manager.startTurn(conversation, message.content, 'preparation-origin')
  await manager.failTurn(conversation)
  const fence = await checkpoints.open(
    {
      checkpointId: 'preparation-checkpoint',
      sessionKey: SESSION_KEY,
      originTurnNumber: 1,
      originTaskId: 'preparation-origin',
      provider: 'openai',
      model: 'preparation-model',
      hostId: 'preparation-host',
      principal: USER,
      loopState: JSON.stringify({ nextIteration: 0, originUserMessageIndex: 0 }),
      taskBudget: JSON.stringify({
        elapsedActiveMs: 0,
        iterationsUsed: options.exhaustedBudget ? 20 : 0,
        durationMs: 300_000,
        maxIterations: 20,
        attachmentReadLedger: { reads: 0, spentTokens: 0, bytesRead: 0 },
      }),
      sourceMessage: JSON.stringify(message),
    },
    [
      {
        kind: 'message',
        toolCallId: null,
        payload: JSON.stringify({ role: 'user', content: message.content }),
      },
    ]
  )
  const version = await checkpoints.transition(SESSION_KEY, fence, {
    from: ['open'],
    to: 'resumable',
    failedAt: NOW,
    expiresAt: NOW + TTL_MS,
  })
  if (version === null) throw new Error('Fixture checkpoint was not made resumable')

  const llm = provider()
  const onFail = vi.fn()
  const onComplete = vi.fn()
  const support = {
    store: checkpoints,
    hostInstanceId: 'preparation-instance',
    hostId: 'preparation-host',
    resumableTtlMs: TTL_MS,
    pendingApprovalTtlMs: TTL_MS,
    claimLeaseMs: LEASE_MS,
    attachmentTtlMs: TTL_MS,
  }
  let executor: TaskExecutor | undefined
  let running: Promise<void> | undefined
  const liveExecutors = new Set<string>()
  const serviceDeps = {
    checkpoints: support,
    conversationManager: manager,
    hasLiveExecutor: (taskId: string) => liveExecutors.has(taskId),
    enqueue: (sourceMessage, taskId, continuation) => {
      const task: Task = {
        id: taskId,
        source: 'channel',
        sourceMessage,
        priority: 'normal',
        status: 'pending',
        createdAt: new Date(NOW),
        conversationHistory: [
          { role: 'user', content: sourceMessage.content, timestamp: new Date(NOW) },
        ],
        responseCallback: vi.fn(async () => {}),
        modelStepContinuation: continuation,
      }
      const lifecycle = new TaskLifecycle()
      lifecycle.register(task)
      const deps: TaskExecutorDeps = {
        conversationManager: manager,
        llmProvider: llm,
        mcpManager: new McpManager(),
        workspaceService: undefined,
        modelName: 'preparation-model',
        contextWindowTokens: 100_000,
        approvalConfig: undefined,
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
        onApprovalNeeded: vi.fn(),
        onComplete,
        onFail,
        dynamicEnvProvider: () => ({}),
        modelStepCheckpoints: support,
      }
      executor = new TaskExecutor(task, deps)
      liveExecutors.add(taskId)
      running = executor.run().finally(() => liveExecutors.delete(taskId))
    },
  } satisfies ModelStepContinuationServiceDeps & { hasLiveExecutor: (taskId: string) => boolean }
  const service = new ModelStepContinuationService(serviceDeps)
  const request = {
    userId: USER,
    agent: AGENT,
    chatId: CHAT,
    checkpointId: 'preparation-checkpoint',
    version,
  }
  return {
    handle,
    manager,
    checkpoints,
    service,
    request,
    llm,
    onFail,
    onComplete,
    finish: async () => {
      if (!running || !executor) throw new Error('Continuation was not enqueued')
      await running
      await executor.waitForCompletion()
      await handle.persistQueue.drain()
    },
    row: () =>
      handle.worker.db
        .prepare(
          'SELECT status, version, failed_at, expires_at, claim_expires_at FROM model_step_checkpoints WHERE checkpoint_id = ?'
        )
        .get('preparation-checkpoint') as {
        status: string
        version: number
        failed_at: number
        expires_at: number
        claim_expires_at: number | null
      },
  }
}

beforeEach(() => {
  clock = NOW
  vi.spyOn(Date, 'now').mockImplementation(() => clock)
  Object.assign(appConfig, {
    enableApproval: false,
    dynamicToolsEnabled: false,
    promptCacheEnabled: false,
  })
})

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.shutdown()
  Object.assign(appConfig, savedConfig)
  vi.restoreAllMocks()
})

async function healthyNeighbor() {
  const healthy = await fixture()
  const result = await healthy.service.continue(healthy.request)
  await healthy.finish()
  expect(result.status).toBe(202)
  expect(healthy.llm.calls).toHaveBeenCalledTimes(1)
  expect(healthy.onComplete).toHaveBeenCalledTimes(1)
  expect(healthy.onFail).not.toHaveBeenCalled()
  expect(healthy.row().status).toBe('completed')
}

describe('continuation preparation settlement (real SQLite)', () => {
  it('keeps an operational admission error when an applied block write loses its response', async () => {
    await healthyNeighbor()
    const f = await fixture({ exhaustedBudget: true })
    const blockError = new Error('block response unavailable after commit')
    const realTransition = f.checkpoints.transition.bind(f.checkpoints)
    const realLoadLive = f.checkpoints.loadLive.bind(f.checkpoints)
    let preBlockSnapshot!: Awaited<ReturnType<typeof realLoadLive>>
    const recoveryRead = vi
      .spyOn(f.checkpoints, 'loadLive')
      .mockImplementation(async sessionKey => {
        // Model a read that observed the claim just before the ambiguous write
        // committed and returns after it. The next transition still hits SQLite.
        if (preBlockSnapshot) return preBlockSnapshot
        return realLoadLive(sessionKey)
      })
    let appliedBlock: number | null | undefined
    let recovery: number | null | undefined
    const transition = vi.spyOn(f.checkpoints, 'transition').mockImplementation(async (...args) => {
      if (args[2].to === 'blocked') {
        preBlockSnapshot = await realLoadLive(args[0])
        appliedBlock = await realTransition(...args)
        throw blockError
      }
      const result = await realTransition(...args)
      if (args[2].to === 'resumable') recovery = result
      return result
    })
    const result = await f.service.continue(f.request).then(
      value => ({ value }),
      error => ({ error })
    )
    await f.finish()

    expect(preBlockSnapshot?.header.status).toBe('claimed')
    expect(recoveryRead).toHaveBeenCalledTimes(1)
    expect(transition.mock.calls.map(args => args[2].to)).toEqual(['blocked', 'resumable'])
    expect(appliedBlock).toEqual(expect.any(Number))
    expect(recovery).toBeNull()
    expect(result).toEqual({ error: blockError })
    expect(f.onFail).toHaveBeenCalledTimes(1)
    expect(f.onComplete).not.toHaveBeenCalled()
    expect(f.llm.calls).not.toHaveBeenCalled()
    expect(
      f.handle.worker.db
        .prepare(
          'SELECT status, blocked_reason FROM model_step_checkpoints WHERE checkpoint_id = ?'
        )
        .get(f.request.checkpointId)
    ).toEqual({ status: 'blocked', blocked_reason: 'budget_exhausted' })
    expect(f.manager.getSessionByKey(SESSION_KEY)).toMatchObject({
      state: 'idle',
      activeTaskId: undefined,
    })
    expect(f.handle.worker.db.prepare('SELECT state, active_task_id FROM sessions').get()).toEqual({
      state: 'idle',
      active_task_id: null,
    })
    expect(
      f.handle.worker.db.prepare('SELECT count(*) AS count FROM pending_approvals').get()
    ).toEqual({ count: 0 })
  })

  it('releases the claim and preserves Retry when a pre-effect block transition throws', async () => {
    await healthyNeighbor()
    const f = await fixture({ exhaustedBudget: true })
    const before = f.row()
    const blockError = new Error('checkpoint block transition unavailable')
    const realTransition = f.checkpoints.transition.bind(f.checkpoints)
    const transition = vi.spyOn(f.checkpoints, 'transition').mockImplementation(async (...args) => {
      if (args[2].to === 'blocked') throw blockError
      return realTransition(...args)
    })
    const result = await f.service.continue(f.request).then(
      value => ({ value }),
      error => ({ error })
    )
    await f.finish()

    expect(transition.mock.calls.map(args => args[2].to)).toEqual(['blocked', 'resumable'])
    expect(transition.mock.calls[0]![2]).toMatchObject({
      from: ['claimed'],
      to: 'blocked',
      blockedReason: 'budget_exhausted',
    })
    expect(transition.mock.calls[1]![2]).toMatchObject({
      from: ['claimed'],
      to: 'resumable',
      failedAt: before.failed_at,
      expiresAt: before.expires_at,
    })
    expect(result).toEqual({ error: blockError })
    expect(f.onFail).toHaveBeenCalledTimes(1)
    expect(f.onComplete).not.toHaveBeenCalled()
    expect(f.llm.calls).not.toHaveBeenCalled()
    expect(f.row()).toMatchObject({
      status: 'resumable',
      failed_at: before.failed_at,
      expires_at: before.expires_at,
    })
    const live = await f.checkpoints.loadLive(SESSION_KEY)
    expect(live && toModelStepCheckpointView(live, clock)).toMatchObject({
      status: 'resumable',
      retryAvailable: true,
    })
    expect(f.manager.getSessionByKey(SESSION_KEY)).toMatchObject({
      state: 'idle',
      activeTaskId: undefined,
    })
    expect(f.handle.worker.db.prepare('SELECT state, active_task_id FROM sessions').get()).toEqual({
      state: 'idle',
      active_task_id: null,
    })
    expect(
      f.handle.worker.db.prepare('SELECT count(*) AS count FROM pending_approvals').get()
    ).toEqual({ count: 0 })
  })

  it('(a) reports a settling claim after renewal and release fail, then reclaims it after expiry', async () => {
    await healthyNeighbor()
    const f = await fixture()
    const renew = vi
      .spyOn(f.checkpoints, 'renewLease')
      .mockRejectedValueOnce(new Error('renew unavailable'))
    const release = vi
      .spyOn(f.checkpoints, 'transition')
      .mockRejectedValueOnce(new Error('release unavailable'))
    const first = await f.service.continue(f.request).then(
      value => ({ value }),
      error => ({ error })
    )
    await f.finish()

    expect(renew).toHaveBeenCalledTimes(1)
    expect
      .soft(release)
      .toHaveBeenCalledWith(
        SESSION_KEY,
        expect.anything(),
        expect.objectContaining({ to: 'resumable' })
      )
    expect(first).toEqual({ error: expect.any(Error) })
    expect(f.onFail).toHaveBeenCalledTimes(1)
    expect(f.onComplete).not.toHaveBeenCalled()
    expect(f.llm.calls).not.toHaveBeenCalled()
    const claimed = f.row()
    expect(claimed).toMatchObject({ status: 'claimed', failed_at: NOW, expires_at: NOW + TTL_MS })
    expect(claimed.claim_expires_at).toBeGreaterThan(clock)
    expect(f.manager.getSessionByKey(SESSION_KEY)).toMatchObject({
      state: 'idle',
      activeTaskId: undefined,
    })
    expect(f.handle.worker.db.prepare('SELECT state, active_task_id FROM sessions').get()).toEqual({
      state: 'idle',
      active_task_id: null,
    })
    expect(
      f.handle.worker.db.prepare('SELECT count(*) AS count FROM pending_approvals').get()
    ).toEqual({ count: 0 })

    const replay = await f.service.continue(f.request)
    expect
      .soft(replay)
      .toMatchObject({ status: 503, body: { code: 'continuation_claim_settling' } })
    expect(f.onFail).toHaveBeenCalledTimes(1)
    expect(f.llm.calls).not.toHaveBeenCalled()

    renew.mockRestore()
    release.mockRestore()
    clock += LEASE_MS + 1
    const retry = await f.service.continue(f.request)
    await f.finish()
    expect(retry).toMatchObject({ status: 202, body: { replayed: false } })
    expect(f.llm.calls).toHaveBeenCalledTimes(1)
    expect(f.onComplete).toHaveBeenCalledTimes(1)
    expect(f.onFail).toHaveBeenCalledTimes(1)
    expect(f.row().status).toBe('completed')
  })

  it('(b) releases a claim after a transient entries read error and offers Retry', async () => {
    await healthyNeighbor()
    const f = await fixture()
    const readError = new Error('checkpoint entries read failed')
    const load = vi.spyOn(f.checkpoints, 'loadEntries').mockRejectedValueOnce(readError)
    const result = await f.service.continue(f.request).then(
      value => ({ value }),
      error => ({ error })
    )
    await f.finish()

    expect(load).toHaveBeenCalledTimes(1)
    expect(f.onFail).toHaveBeenCalledTimes(1)
    expect(f.onComplete).not.toHaveBeenCalled()
    expect(f.llm.calls).not.toHaveBeenCalled()
    expect.soft(result).toEqual({ error: readError })
    expect
      .soft(f.row())
      .toMatchObject({ status: 'resumable', failed_at: NOW, expires_at: NOW + TTL_MS })
    const live = await f.checkpoints.loadLive(SESSION_KEY)
    expect
      .soft(live && toModelStepCheckpointView(live, clock))
      .toMatchObject({ status: 'resumable', retryAvailable: true })
    expect(f.manager.getSessionByKey(SESSION_KEY)).toMatchObject({
      state: 'idle',
      activeTaskId: undefined,
    })
    expect(f.handle.worker.db.prepare('SELECT state, active_task_id FROM sessions').get()).toEqual({
      state: 'idle',
      active_task_id: null,
    })
    expect(
      f.handle.worker.db.prepare('SELECT count(*) AS count FROM pending_approvals').get()
    ).toEqual({ count: 0 })
  })

  it('(b2) preserves an operational error when claim release fails and permits reclaim after expiry', async () => {
    await healthyNeighbor()
    const f = await fixture()
    const readError = new Error('checkpoint entries read failed')
    const load = vi.spyOn(f.checkpoints, 'loadEntries').mockRejectedValueOnce(readError)
    const transition = vi
      .spyOn(f.checkpoints, 'transition')
      .mockRejectedValueOnce(new Error('release unavailable'))
    const result = await f.service.continue(f.request).then(
      value => ({ value }),
      error => ({ error })
    )
    await f.finish()

    expect(load).toHaveBeenCalledTimes(1)
    expect(transition).toHaveBeenCalledTimes(1)
    expect(f.onFail).toHaveBeenCalledTimes(1)
    expect(f.onComplete).not.toHaveBeenCalled()
    expect(f.llm.calls).not.toHaveBeenCalled()
    expect.soft(result).toEqual({ error: readError })
    const claimed = f.row()
    expect(claimed).toMatchObject({ status: 'claimed', failed_at: NOW, expires_at: NOW + TTL_MS })
    expect(claimed.claim_expires_at).toBeGreaterThan(clock)
    expect(f.manager.getSessionByKey(SESSION_KEY)).toMatchObject({
      state: 'idle',
      activeTaskId: undefined,
    })
    expect(f.handle.worker.db.prepare('SELECT state, active_task_id FROM sessions').get()).toEqual({
      state: 'idle',
      active_task_id: null,
    })
    expect(
      f.handle.worker.db.prepare('SELECT count(*) AS count FROM pending_approvals').get()
    ).toEqual({ count: 0 })
    clock += LEASE_MS + 1
    const reclaim = await f.checkpoints.claim({
      sessionKey: SESSION_KEY,
      checkpointId: 'preparation-checkpoint',
      version: claimed.version,
      hostInstanceId: 'replacement-instance',
      newTaskId: 'replacement-task',
      leaseMs: LEASE_MS,
    })
    expect(reclaim.outcome).toBe('claimed')
  })
})
