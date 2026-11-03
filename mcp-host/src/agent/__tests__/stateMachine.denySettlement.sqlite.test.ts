import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Request, Response } from 'express'
import { config as appConfig } from '../../config'
import { ConversationManager } from '../../core/conversation/conversation'
import {
  type StoreHandle,
  makeSqliteStore,
} from '../../core/conversation/persistence/__tests__/testHelpers'
import { ModelStepCheckpointStore } from '../../core/conversation/persistence/modelStepCheckpointStore'
import { SqliteColdStartLoader } from '../../core/conversation/persistence/sqliteColdStartLoader'
import { LlmErrorCode } from '../../core/errors'
import { FinishReason } from '../../core/types'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import type { SingleTurnProvider } from '../../llm/types'
import { logger } from '../../logger'
import { McpManager } from '../../mcp/manager'
import { MessageQueue } from '../../queue/messageQueue'
import { makeHandlers } from '../../server/__tests__/testHelpers'
import { handleApprovalRoute } from '../../server/routes'
import type { IncomingMessage } from '../../server/types'
import { sourceMessageForResume } from '../sourceMessageForResume'
import { AgentStateMachine } from '../stateMachine'
import { TaskExecutor } from '../taskExecutor'

const USER = 'denial-user'
const AGENT = 'chatllm'
const PROVIDER = 'openai'
const MODEL = 'denial-test-model'
const OWNER = 'denial-host-instance'
const LEASE = 300_000
const TTL = 86_400_000
const originalApprovalSetting = appConfig.enableApproval
const originalDynamicSetting = appConfig.dynamicToolsEnabled
type Fixture = {
  handle: StoreHandle
  manager: ConversationManager
  checkpoints: ModelStepCheckpointStore
  lifecycle: TaskLifecycle
  queue: MessageQueue
  machine: AgentStateMachine
  provider: SingleTurnProvider
}
const openFixtures: Fixture[] = []

function source(chat: string): IncomingMessage {
  return {
    sender: USER,
    content: 'Run the requested tool',
    channelType: 'rpc',
    channelId: AGENT,
    threadId: chat,
    messageId: `message-${chat}`,
    timestamp: new Date().toISOString(),
    hostRef: AGENT,
  }
}

function sessionKey(chat: string): string {
  return `${USER}:rpc:${AGENT}:${chat}`
}

async function makeFixture(): Promise<Fixture> {
  const handle = makeSqliteStore()
  const manager = new ConversationManager(handle.store)
  const checkpoints = new ModelStepCheckpointStore(handle.persistQueue, {
    now: () => Date.now(),
    blockedTtlMs: TTL,
  })
  const lifecycle = new TaskLifecycle()
  const queue = new MessageQueue()
  queue.setLifecycle(lifecycle)
  const machine = new AgentStateMachine(queue, lifecycle, {
    maxTaskDuration: LEASE,
    maxToolCallsPerTask: 20,
    approvalTimeout: LEASE,
    autoStart: false,
    taskDelay: 0,
  })
  machine.setConversationStore(handle.store)
  const provider: SingleTurnProvider = {
    getProviderType: () => PROVIDER,
    classifyError: error => ({
      code: LlmErrorCode.ApiCallFailed,
      retryable: false,
      message: error instanceof Error ? error.message : String(error),
    }),
    completeSingleTurn: async () => {
      throw new Error('Unexpected tool-less call')
    },
    completeSingleTurnWithTools: vi.fn(async () => ({
      content: 'neighbor completed',
      tool_calls: [],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      finish_reason: FinishReason.Stop,
    })),
  }
  machine.setLLMProvider(provider, MODEL)
  machine.setTaskModelResolver(selections =>
    selections?.[PROVIDER] === MODEL
      ? { provider, model: MODEL, contextWindowTokens: 100_000 }
      : null
  )
  machine.setMcpManager(new McpManager())
  machine.setModelStepCheckpoints({
    store: checkpoints,
    hostInstanceId: OWNER,
    hostId: 'host-a',
    resumableTtlMs: TTL,
    pendingApprovalTtlMs: TTL,
    claimLeaseMs: LEASE,
    attachmentTtlMs: TTL,
  })
  machine.setColdStartLoader(new SqliteColdStartLoader(handle.store))
  const fixture = { handle, manager, checkpoints, lifecycle, queue, machine, provider }
  openFixtures.push(fixture)
  return fixture
}

async function seedApproval(f: Fixture, chat: string, continuation: boolean) {
  const key = sessionKey(chat)
  const taskId = `task-${chat}`
  const requestId = `request-${chat}`
  const msg = source(chat)
  const conversation = await f.manager.getOrCreate(key, {
    userId: USER,
    channelType: 'rpc',
    channelId: AGENT,
    threadId: chat,
    source: 'rpc',
  })
  const taskBudget = {
    elapsedActiveMs: 0,
    iterationsUsed: 0,
    durationMs: LEASE,
    maxIterations: 20,
    attachmentReadLedger: { reads: 0, spentTokens: 0, bytesRead: 0 },
  }
  const call = { id: `tool-${chat}`, name: 'shell_exec', arguments: { command: 'printf neighbor' } }
  if (continuation) {
    await f.manager.startTurn(conversation, msg.content, `origin-${chat}`)
    await f.manager.failTurn(conversation)
    const fence = await f.checkpoints.open(
      {
        checkpointId: `checkpoint-${chat}`,
        sessionKey: key,
        originTurnNumber: 1,
        originTaskId: `origin-${chat}`,
        provider: PROVIDER,
        model: MODEL,
        hostId: 'host-a',
        principal: USER,
        loopState: JSON.stringify({ nextIteration: 0, originUserMessageIndex: 0 }),
        taskBudget: JSON.stringify(taskBudget),
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
    const version = await f.checkpoints.transition(key, fence, {
      from: ['open'],
      to: 'resumable',
      failedAt: Date.now(),
      expiresAt: Date.now() + TTL,
    })
    if (version === null) throw new Error('Could not prepare resumable checkpoint')
    const claim = await f.checkpoints.claim({
      sessionKey: key,
      checkpointId: `checkpoint-${chat}`,
      version,
      hostInstanceId: OWNER,
      newTaskId: taskId,
      leaseMs: LEASE,
    })
    if (claim.outcome !== 'claimed') throw new Error(`Could not claim checkpoint: ${claim.outcome}`)
    expect(
      await f.checkpoints.append(key, claim.fence, [
        {
          kind: 'message',
          toolCallId: null,
          payload: JSON.stringify({ role: 'assistant', content: null, tool_calls: [call] }),
        },
      ])
    ).toBe(true)
    await f.manager.resumeTurnForContinuation(conversation, taskId, 1, null, undefined, {
      fence: claim.fence,
      activeTaskId: taskId,
      originTurnNumber: 1,
    })
  } else {
    await f.manager.startTurn(conversation, msg.content, taskId)
  }
  await f.manager.suspendForApproval(conversation, {
    request_id: requestId,
    tool_name: call.name,
    tool_call_id: call.id,
    parameters: call.arguments,
    description: 'Approve the tool',
    context_snapshot: [
      { role: 'user', content: msg.content },
      { role: 'assistant', content: '', tool_calls: [call] },
    ],
    task_budget: taskBudget,
    sourceMessage: sourceMessageForResume(msg),
  })
  return { key, taskId, requestId, conversation }
}

async function bootstrap(f: Fixture) {
  await f.machine.bootstrap()
  return (f.machine as unknown as { activeExecutors: Map<string, TaskExecutor> }).activeExecutors
}

function collectTerminalEvents(machine: AgentStateMachine, taskId: string): string[] {
  const terminal: string[] = []
  for (const type of ['task:completed', 'task:failed']) {
    machine.on(type, (event: { data: { task: { id: string } } }) => {
      if (event.data.task.id === taskId) terminal.push(type)
    })
  }
  return terminal
}

async function postDenial(machine: AgentStateMachine, requestId: string) {
  const response = { writeHead: vi.fn(), end: vi.fn() }
  await handleApprovalRoute(
    {
      runtimeCaller: { caller: 'rpc-proxy', hostRef: AGENT, userId: USER },
      body: { userId: USER, requestId },
    } as unknown as Request,
    response as unknown as Response,
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

async function neighborCompletes(f: Fixture) {
  const resume = vi.spyOn(TaskExecutor.prototype, 'resumeAfterApproval')
  expect(await f.machine.handleApproval(USER, 'request-neighbor', false, 'rpc', AGENT)).toEqual({
    success: true,
  })
  expect(resume).toHaveBeenCalledOnce()
  await resume.mock.results[0]!.value
  expect(f.provider.completeSingleTurnWithTools).toHaveBeenCalledOnce()
  expect(
    f.handle.worker.db
      .prepare('SELECT status FROM model_step_checkpoints WHERE checkpoint_id = ?')
      .get('checkpoint-neighbor')
  ).toEqual({ status: 'completed' })
  resume.mockRestore()
}

async function completed(executor: TaskExecutor): Promise<boolean> {
  return Promise.race([
    executor.waitForCompletion().then(() => true),
    new Promise<boolean>(resolve => setTimeout(() => resolve(false), 100)),
  ])
}

afterEach(async () => {
  Object.assign(appConfig, {
    enableApproval: originalApprovalSetting,
    dynamicToolsEnabled: originalDynamicSetting,
  })
  vi.restoreAllMocks()
  for (const f of openFixtures.splice(0)) {
    const internals = f.machine as unknown as {
      approvalMap: Map<string, { timerId?: ReturnType<typeof setTimeout> }>
      activeExecutors: Map<string, TaskExecutor>
    }
    for (const entry of internals.approvalMap.values())
      if (entry.timerId) clearTimeout(entry.timerId)
    for (const executor of internals.activeExecutors.values()) {
      await (
        executor as unknown as { stopContinuationLease(): Promise<void> }
      ).stopContinuationLease()
    }
    await f.handle.shutdown()
  }
})

describe('denial settlement with SQLite', () => {
  it.each([true, false])(
    'approval timeout emits no second terminal when denial fails (continuation=%s)',
    async continuation => {
      Object.assign(appConfig, { enableApproval: true, dynamicToolsEnabled: false })
      const f = await makeFixture()
      const target = await seedApproval(f, 'timeout', continuation)
      await seedApproval(f, 'neighbor', true)
      const active = await bootstrap(f)
      const executor = active.get(target.taskId)!
      expect(executor.executorState).toBe('waiting_approval')
      expect(
        f.handle.worker.db
          .prepare('SELECT request_id FROM pending_approvals WHERE request_id = ?')
          .get(target.requestId)
      ).toEqual({ request_id: target.requestId })

      // Model a live task whose lifecycle is registered; cold-bootstrap
      // lifecycle restoration is a separately scoped follow-up.
      f.lifecycle.register(executor.sourceTask)
      expect(f.lifecycle.transition(target.taskId, 'processing', 'dispatched').kind).toBe('applied')
      const response = vi.fn(async () => {})
      executor.sourceTask.responseCallback = response
      const logged = vi.spyOn(logger, 'error')
      const terminal = collectTerminalEvents(f.machine, target.taskId)
      const trace = vi.spyOn(
        f.machine as unknown as { enqueueTaskTrace: (...args: unknown[]) => void },
        'enqueueTaskTrace'
      )
      const completion = vi.spyOn(
        executor as unknown as { resolveCompletion: () => void },
        'resolveCompletion'
      )
      const deny = vi.spyOn(executor, 'deny')
      if (continuation) {
        const transition = f.checkpoints.transition.bind(f.checkpoints)
        vi.spyOn(f.checkpoints, 'transition').mockImplementation(async (key, fence, change) => {
          if (fence.checkpointId === 'checkpoint-timeout' && change.to === 'abandoned')
            throw new Error('timeout abandon unavailable')
          return transition(key, fence, change)
        })
      } else {
        const persist = f.handle.store.persistApprovalResolved.bind(f.handle.store)
        vi.spyOn(f.handle.store, 'persistApprovalResolved').mockImplementation(
          async (conversation, requestId, decision, expectedTaskId) => {
            if (requestId === target.requestId) throw new Error('timeout denial unavailable')
            await persist(conversation, requestId, decision, expectedTaskId)
          }
        )
      }

      ;(
        f.machine as unknown as { handleApprovalTimeout: (requestId: string) => void }
      ).handleApprovalTimeout(target.requestId)
      await executor.waitForCompletion()
      await expect(deny.mock.results[0]!.value).rejects.toThrow()
      await neighborCompletes(f)

      expect(
        f.lifecycle
          .get(target.taskId)
          ?.history.filter(entry => ['completed', 'failed', 'cancelled'].includes(entry.to))
      ).toMatchObject([{ to: 'completed', reason: 'approval_timeout' }])
      expect.soft(terminal).toEqual([])
      expect.soft(response).not.toHaveBeenCalled()
      expect.soft(completion).toHaveBeenCalledTimes(1)
      expect(executor.executorState).toBe('completed')
      expect(logged).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: target.taskId }),
        'Denial settlement failed after task became terminal'
      )
      const runEnds = trace.mock.calls.filter(args => args[1] === 'run_end')
      expect(runEnds.some(args => (args[0] as { id: string }).id !== target.taskId)).toBe(true)
      expect
        .soft(runEnds.filter(args => (args[0] as { id: string }).id === target.taskId))
        .toEqual([])
      if (continuation) {
        expect(
          f.handle.worker.db
            .prepare('SELECT status FROM model_step_checkpoints WHERE checkpoint_id = ?')
            .get('checkpoint-timeout')
        ).toEqual({ status: 'claimed' })
        expect(
          f.handle.worker.db
            .prepare('SELECT request_id FROM pending_approvals WHERE request_id = ?')
            .get(target.requestId)
        ).toBeUndefined()
      } else {
        expect(
          f.handle.worker.db
            .prepare('SELECT request_id FROM pending_approvals WHERE request_id = ?')
            .get(target.requestId)
        ).toEqual({ request_id: target.requestId })
      }
    }
  )

  it('approval timeout emits no second terminal when continuation denial succeeds', async () => {
    Object.assign(appConfig, { enableApproval: true, dynamicToolsEnabled: false })
    const f = await makeFixture()
    const target = await seedApproval(f, 'timeout-success', true)
    await seedApproval(f, 'neighbor', true)
    const executor = (await bootstrap(f)).get(target.taskId)!
    expect(executor.executorState).toBe('waiting_approval')
    f.lifecycle.register(executor.sourceTask)
    expect(f.lifecycle.transition(target.taskId, 'processing', 'dispatched').kind).toBe('applied')
    const terminal = collectTerminalEvents(f.machine, target.taskId)
    const response = vi.fn(async () => {})
    executor.sourceTask.responseCallback = response
    const deny = vi.spyOn(executor, 'deny')
    ;(
      f.machine as unknown as { handleApprovalTimeout: (requestId: string) => void }
    ).handleApprovalTimeout(target.requestId)
    await executor.waitForCompletion()
    await expect(deny.mock.results[0]!.value).resolves.toBeUndefined()
    await neighborCompletes(f)
    expect(
      f.lifecycle
        .get(target.taskId)
        ?.history.filter(entry => ['completed', 'failed', 'cancelled'].includes(entry.to))
    ).toMatchObject([{ to: 'completed', reason: 'approval_timeout' }])
    expect(terminal).toEqual([])
    expect(response).not.toHaveBeenCalled()
    expect(
      f.handle.worker.db
        .prepare('SELECT status FROM model_step_checkpoints WHERE checkpoint_id = ?')
        .get('checkpoint-timeout-success')
    ).toEqual({ status: 'abandoned' })
  })

  it('an admitted live approval settles the task and lifecycle once when denial persistence fails', async () => {
    Object.assign(appConfig, { enableApproval: true, dynamicToolsEnabled: false })
    const f = await makeFixture()
    vi.mocked(f.provider.completeSingleTurnWithTools).mockResolvedValueOnce({
      content: null,
      tool_calls: [{ id: 'live-tool', name: 'shell_exec', arguments: { command: 'printf live' } }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      finish_reason: FinishReason.ToolUse,
    })
    const task = f.queue.createTaskFromMessage(source('live'))
    expect(f.queue.admit(task)).toEqual({ admitted: true })
    expect(f.queue.dequeue()).toBe(task)
    expect(await f.machine.executeTask(task)).toBe(true)
    const executor = (
      f.machine as unknown as { activeExecutors: Map<string, TaskExecutor> }
    ).activeExecutors.get(task.id)!
    expect(executor.executorState).toBe('waiting_approval')
    expect(f.lifecycle.get(task.id)?.status).toBe('processing')
    const approval = executor.pendingApproval!
    expect(approval.request_id).toBeTruthy()
    expect(
      f.handle.worker.db
        .prepare('SELECT COUNT(*) AS n FROM pending_approvals WHERE request_id = ?')
        .get(approval.request_id)
    ).toEqual({ n: 1 })
    const write = vi
      .spyOn(f.handle.store, 'persistApprovalResolved')
      .mockRejectedValueOnce(new Error('denial persistence unavailable'))
    const terminal = collectTerminalEvents(f.machine, task.id)
    const lifecycleTerminal: string[] = []
    f.lifecycle.on('transition', event => {
      if (event.taskId === task.id && ['completed', 'failed', 'cancelled'].includes(event.to))
        lifecycleTerminal.push(event.to)
    })
    const response = await postDenial(f.machine, approval.request_id)
    expect(write).toHaveBeenCalledOnce()
    expect(response.status).toBe(200)
    expect(response.body.code).toBe('denial_not_saved')
    expect(await completed(executor)).toBe(true)
    expect(terminal).toEqual(['task:completed'])
    expect(lifecycleTerminal).toEqual(['completed'])
    expect(task.status).toBe('completed')
    expect(f.lifecycle.get(task.id)?.status).toBe(task.status)
  })

  it('c2: an ordinary denial whose durable write fails reports denial_not_saved only after settlement', async () => {
    Object.assign(appConfig, { enableApproval: true, dynamicToolsEnabled: false })
    const f = await makeFixture()
    const target = await seedApproval(f, 'ordinary', false)
    await seedApproval(f, 'neighbor', true)
    const active = await bootstrap(f)
    const executor = active.get(target.taskId)!
    expect(f.lifecycle.get(target.taskId)).toBeNull()
    expect(executor.executorState).toBe('waiting_approval')
    expect(
      f.handle.worker.db
        .prepare('SELECT COUNT(*) AS n FROM pending_approvals WHERE request_id = ?')
        .get(target.requestId)
    ).toEqual({ n: 1 })
    expect(
      f.handle.worker.db
        .prepare('SELECT state, active_task_id FROM sessions WHERE session_key = ?')
        .get(target.key)
    ).toEqual({ state: 'awaiting_approval', active_task_id: target.taskId })
    expect(target.conversation.pending_approval?.request_id).toBe(target.requestId)
    const original = f.handle.store.persistApprovalResolved.bind(f.handle.store)
    const write = vi
      .spyOn(f.handle.store, 'persistApprovalResolved')
      .mockImplementation(async (conv, requestId, decision) => {
        if (requestId === target.requestId) throw new Error('denial persistence unavailable')
        await original(conv, requestId, decision)
      })
    const terminal = collectTerminalEvents(f.machine, target.taskId)
    const response = await postDenial(f.machine, target.requestId)
    expect(write).toHaveBeenCalledOnce()
    expect(write.mock.calls[0]?.slice(0, 3)).toEqual([
      target.conversation,
      target.requestId,
      'deny',
    ])
    await neighborCompletes(f)
    expect.soft(response.status).toBe(200)
    expect.soft(response.body).toEqual({
      success: false,
      code: 'denial_not_saved',
      error: 'The tool call was cancelled, but the denial could not be saved.',
    })
    expect.soft(await completed(executor)).toBe(true)
    expect.soft(executor.executorState).not.toBe('waiting_approval')
    expect.soft(terminal).toEqual(['task:completed'])
    expect.soft(executor.sourceTask.status).toBe('completed')
    expect(target.conversation.state).toBe('idle')
    expect(target.conversation.pending_approval).toBeUndefined()
    expect(
      f.handle.worker.db
        .prepare('SELECT state, active_task_id FROM sessions WHERE session_key = ?')
        .get(target.key)
    ).toEqual({ state: 'awaiting_approval', active_task_id: target.taskId })
    expect(
      f.handle.worker.db
        .prepare('SELECT COUNT(*) AS n FROM pending_approvals WHERE request_id = ?')
        .get(target.requestId)
    ).toEqual({ n: 1 })
  })

  it('c: failed claim abandonment is an operational denial failure and resolves completion once', async () => {
    Object.assign(appConfig, { enableApproval: true, dynamicToolsEnabled: false })
    const f = await makeFixture()
    const target = await seedApproval(f, 'continuation', true)
    await seedApproval(f, 'neighbor', true)
    const active = await bootstrap(f)
    const executor = active.get(target.taskId)!
    expect(f.lifecycle.get(target.taskId)).toBeNull()
    expect(executor.executorState).toBe('waiting_approval')
    expect(
      f.handle.worker.db
        .prepare('SELECT COUNT(*) AS n FROM pending_approvals WHERE request_id = ?')
        .get(target.requestId)
    ).toEqual({ n: 1 })
    expect(
      f.handle.worker.db
        .prepare('SELECT status FROM model_step_checkpoints WHERE checkpoint_id = ?')
        .get('checkpoint-continuation')
    ).toEqual({ status: 'claimed' })
    expect(
      f.handle.worker.db
        .prepare('SELECT state, active_task_id FROM sessions WHERE session_key = ?')
        .get(target.key)
    ).toEqual({ state: 'awaiting_approval', active_task_id: target.taskId })
    expect(target.conversation.pending_approval?.request_id).toBe(target.requestId)
    const original = f.checkpoints.transition.bind(f.checkpoints)
    const transition = vi
      .spyOn(f.checkpoints, 'transition')
      .mockImplementation(async (key, fence, change) => {
        if (fence.checkpointId === 'checkpoint-continuation' && change.to === 'abandoned')
          throw new Error('abandon write unavailable')
        return original(key, fence, change)
      })
    const terminal = collectTerminalEvents(f.machine, target.taskId)
    const response = await postDenial(f.machine, target.requestId)
    expect(transition).toHaveBeenCalledWith(
      target.key,
      expect.objectContaining({ checkpointId: 'checkpoint-continuation' }),
      expect.objectContaining({ to: 'abandoned' })
    )
    await neighborCompletes(f)
    expect.soft(response.status).toBeGreaterThanOrEqual(400)
    expect.soft(response.body.code).not.toBe('denial_not_saved')
    expect.soft(await completed(executor)).toBe(true)
    expect.soft(executor.executorState).not.toBe('waiting_approval')
    expect.soft(terminal).toEqual(['task:failed'])
    expect.soft(executor.sourceTask.status).toBe('failed')
    expect(target.conversation.state).toBe('idle')
    expect(target.conversation.pending_approval).toBeUndefined()
    expect(
      f.handle.worker.db
        .prepare('SELECT state, active_task_id FROM sessions WHERE session_key = ?')
        .get(target.key)
    ).toEqual({ state: 'idle', active_task_id: null })
    expect(
      f.handle.worker.db
        .prepare('SELECT status FROM model_step_checkpoints WHERE checkpoint_id = ?')
        .get('checkpoint-continuation')
    ).toEqual({ status: 'claimed' })
    expect(
      f.handle.worker.db
        .prepare('SELECT COUNT(*) AS n FROM pending_approvals WHERE request_id = ?')
        .get(target.requestId)
    ).toEqual({ n: 0 })
  })
})
