/**
 * #1043 — the tool-use loop records a durable model-step checkpoint, and only
 * a 503 `provider_unavailable` after a confirmed tool result leaves it
 * resumable. Runs against the real dispatcher and SQLite schema.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import {
  type RecordedCheckpointImagePart,
  type RecordedCheckpointMessage,
  restoreCheckpointMessages,
} from '../../../agent/modelStepCheckpointAttachments'
import { TaskExecutionBudget } from '../../../agent/taskExecutionBudget'
import type { ModelStepCheckpointAttachmentRow } from '../../../db/worker/modelStepCheckpointOps'
import type { ModelStepCheckpointAttachmentInput } from '../../../db/worker/modelStepCheckpointOps'
import type { ModelStepCheckpointFence } from '../../../db/worker/modelStepCheckpointOps'
import {
  type InProcessWorkerHandle,
  createInProcessWorker,
} from '../../conversation/persistence/__tests__/testHelpers'
import { ModelStepCheckpointStore } from '../../conversation/persistence/modelStepCheckpointStore'
import { PersistQueue } from '../../conversation/persistence/persistQueue'
import { LlmError, LlmErrorCode } from '../../errors'
import type { AgentEventEmitter, ReasoningPort, Tool } from '../../interfaces'
import { BasicSafety } from '../../safety/safety'
import type {
  AgentEvent,
  Attachment,
  ChatMessage,
  MessageContentPart,
  RespondResult,
  TaskExecutionBudgetSnapshot,
  ToolResult,
} from '../../types'
import { SimpleEventEmitter } from '../eventEmitter'
import {
  type ModelStepCheckpointRecorder,
  createModelStepCheckpointRecorder,
} from '../modelStepCheckpointRecorder'
import { runToolUseLoop } from '../toolUseLoop'
import {
  buildTestConfig,
  createMockReasoning,
  createMockTool,
} from './toolUseLoopRetryableTestUtils'

const SESSION_KEY = 'user-1043:rpc:agent:default'
const SECRET = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'
const queues: PersistQueue[] = []
const workers: InProcessWorkerHandle[] = []

afterEach(async () => {
  for (const queue of queues.splice(0)) await queue.close()
  for (const worker of workers.splice(0)) worker.terminate()
})

/**
 * The default origin recorder targets index 0 — the loop's only message in the
 * single-turn fixtures. Multi-turn tests pass their capture-boundary index.
 */
function harness(
  overrides: {
    sourceAttachments?: Attachment[]
    restoredAttachments?: ModelStepCheckpointAttachmentRow[]
    attachmentTtlMs?: number
    originUserMessageIndex?: number
    now?: () => number
    taskBudget?: () => string | null
    resumableTtlMs?: number
  } = {}
) {
  const worker = createInProcessWorker(':memory:')
  workers.push(worker)
  const queue = new PersistQueue(worker.worker, { syncTimeoutMs: 5000, asyncTimeoutMs: 5000 })
  queues.push(queue)
  const now = overrides.now ?? (() => 1_000_000)
  const store = new ModelStepCheckpointStore(queue, { now, blockedTtlMs: 7 * 24 * 3_600_000 })
  const safety = new BasicSafety()
  const onFenceLost = vi.fn()
  const recorder = createModelStepCheckpointRecorder({
    store,
    sessionKey: SESSION_KEY,
    mode: {
      kind: 'origin',
      header: {
        checkpointId: 'cp-loop',
        sessionKey: SESSION_KEY,
        originTurnNumber: 1,
        originTaskId: 'task-origin',
        provider: 'codex-subscription',
        model: 'gpt-5.5',
        hostId: 'host-a',
        principal: 'user-1043',
        sourceMessage: SOURCE_MESSAGE,
      },
      originUserMessageIndex: overrides.originUserMessageIndex ?? 0,
    },
    redact: text =>
      safety.sanitizeFreeformContent(text, { secretWarning: 'secret in checkpoint' }).content,
    taskBudget: overrides.taskBudget ?? (() => JSON.stringify({ iterationsUsed: 1 })),
    resumableTtlMs: overrides.resumableTtlMs ?? 60_000,
    sourceAttachments: overrides.sourceAttachments ?? [
      {
        id: 'att-1',
        kind: 'file',
        mimeType: 'text/plain',
        encoding: 'base64',
        dataBase64: Buffer.from([1, 2, 3]).toString('base64'),
      },
    ],
    ...(overrides.restoredAttachments
      ? { restoredAttachments: overrides.restoredAttachments }
      : {}),
    attachmentTtlMs: overrides.attachmentTtlMs ?? 3_600_000,
    now,
    onFenceLost,
  })
  return { worker, store, recorder, onFenceLost }
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** A store whose clock the test drives, for continuation-recorder cases. */
function storeHarness(): {
  worker: InProcessWorkerHandle
  store: ModelStepCheckpointStore
  clock: { value: number }
} {
  const worker = createInProcessWorker(':memory:')
  workers.push(worker)
  const queue = new PersistQueue(worker.worker, { syncTimeoutMs: 5000, asyncTimeoutMs: 5000 })
  queues.push(queue)
  const clock = { value: 1_000_000 }
  return {
    worker,
    store: new ModelStepCheckpointStore(queue, {
      now: () => clock.value,
      blockedTtlMs: 7 * 24 * 3_600_000,
    }),
    clock,
  }
}

/**
 * Opens, fails and claims one checkpoint whose resumable transition wrote
 * `attachments`, then returns the fence a continuation recorder must carry.
 */
async function openClaimedCheckpoint(
  store: ModelStepCheckpointStore,
  clock: { value: number },
  attachments: ModelStepCheckpointAttachmentInput[]
): Promise<ModelStepCheckpointFence> {
  const fence = await store.open(
    {
      checkpointId: 'cp-loop',
      sessionKey: SESSION_KEY,
      originTurnNumber: 1,
      originTaskId: 'task-origin',
      provider: 'codex-subscription',
      model: 'gpt-5.5',
      hostId: 'host-a',
      principal: 'user-1043',
      loopState: JSON.stringify({ nextIteration: 3, originUserMessageIndex: 1 }),
      taskBudget: JSON.stringify({ iterationsUsed: 2 }),
      sourceMessage: SOURCE_MESSAGE,
    },
    [{ kind: 'message', toolCallId: null, payload: JSON.stringify(user) }]
  )
  await store.append(SESSION_KEY, fence, [
    { kind: 'tool_dispatch', toolCallId: 'tc_a', payload: JSON.stringify({ name: 'read_file' }) },
    {
      kind: 'tool_result',
      toolCallId: 'tc_a',
      payload: JSON.stringify({ name: 'read_file', isError: false }),
    },
  ])
  const version = await store.transition(SESSION_KEY, fence, {
    from: ['open'],
    to: 'resumable',
    failedAt: clock.value,
    expiresAt: clock.value + 7 * 24 * 3_600_000,
    attachments,
  })
  if (version === null) throw new Error('checkpoint did not become resumable')
  const claim = await store.claim({
    sessionKey: SESSION_KEY,
    checkpointId: 'cp-loop',
    version,
    hostInstanceId: 'host-instance-a',
    newTaskId: 'task-cont',
    leaseMs: 300_000,
  })
  if (claim.outcome !== 'claimed') throw new Error(`unexpected claim: ${claim.outcome}`)
  return claim.fence
}

function continuationRecorder(input: {
  store: ModelStepCheckpointStore
  fence: ModelStepCheckpointFence
  clock: { value: number }
  sourceAttachments: Attachment[]
  restoredAttachments: ModelStepCheckpointAttachmentRow[]
  attachmentTtlMs?: number
  taskBudget?: () => string | null
  loopState?: string
}) {
  const safety = new BasicSafety()
  return createModelStepCheckpointRecorder({
    store: input.store,
    sessionKey: SESSION_KEY,
    mode: {
      kind: 'continuation',
      fence: input.fence,
      confirmedResults: 1,
      loopState: input.loopState ?? JSON.stringify({ nextIteration: 3, originUserMessageIndex: 1 }),
    },
    redact: text =>
      safety.sanitizeFreeformContent(text, { secretWarning: 'secret in checkpoint' }).content,
    taskBudget: input.taskBudget ?? (() => JSON.stringify({ iterationsUsed: 3 })),
    resumableTtlMs: 60_000,
    sourceAttachments: input.sourceAttachments,
    restoredAttachments: input.restoredAttachments,
    attachmentTtlMs: input.attachmentTtlMs ?? 3_600_000,
    now: () => input.clock.value,
    onFenceLost: vi.fn(),
  })
}

function withRecorder(
  reasoning: ReturnType<typeof createMockReasoning>,
  tools: Tool[],
  recorder: ModelStepCheckpointRecorder,
  maxIterations = 4,
  overrides: { events?: AgentEventEmitter; abortSignal?: AbortSignal } = {}
) {
  return {
    ...buildTestConfig(reasoning, tools),
    modelStepCheckpointRecorder: recorder,
    maxIterations,
    ...overrides,
  }
}

/**
 * The executor's tracking emitter (`taskExecutor.buildTrackingEventEmitter`):
 * every `loop:iteration` the loop produces consumes one real task-budget
 * iteration before the event is forwarded to the service's own emitter.
 */
function budgetTrackingEvents(budget: TaskExecutionBudget): {
  events: AgentEventEmitter
  loopIterations: number[]
} {
  const forwarded = new SimpleEventEmitter()
  const loopIterations: number[] = []
  forwarded.on('loop:iteration', event => {
    if (event.type === 'loop:iteration' && typeof event.data.iteration === 'number') {
      loopIterations.push(event.data.iteration)
    }
  })
  return {
    events: {
      emit: (event: AgentEvent) => {
        if (event.type === 'loop:iteration') budget.consumeIteration()
        forwarded.emit(event)
      },
      on: (type, handler) => forwarded.on(type, handler),
      off: (type, handler) => forwarded.off(type, handler),
    },
    loopIterations,
  }
}

/**
 * The provider call spends active time before it reports the outage; the
 * controlled clock attributes exactly that time to the real budget.
 */
function advanceActiveTimeOnOutage(
  reasoning: ReasoningPort,
  clock: { value: number },
  advanceMs: number
): ReasoningPort {
  return {
    respondWithTools: reasoning.respondWithTools,
    continueWithToolResults: vi.fn(
      async (...args: Parameters<ReasoningPort['continueWithToolResults']>) => {
        const result = await reasoning.continueWithToolResults(...args)
        if (result.type === 'error') clock.value += advanceMs
        return result
      }
    ),
  }
}

/** Runs one loop with the real budget active and always pauses its timer. */
async function withStartedBudget<T>(
  budget: TaskExecutionBudget,
  controller: AbortController,
  run: () => Promise<T>
): Promise<T> {
  budget.start(controller)
  try {
    return await run()
  } finally {
    budget.pause()
  }
}

const outage = () =>
  new LlmError(
    'provider unavailable',
    'codex-subscription',
    LlmErrorCode.ModelOverloaded,
    true,
    undefined,
    503,
    'provider_unavailable'
  )

const user: ChatMessage = { role: 'user', content: 'Inspect the repository files.' }
const SOURCE_MESSAGE = JSON.stringify({
  content: 'Inspect the repository files.',
  sender: 'user-1043',
})

function header(worker: InProcessWorkerHandle) {
  return worker.db
    .prepare(
      'SELECT status, version, loop_state, task_budget, source_message FROM model_step_checkpoints'
    )
    .get() as
    | {
        status: string
        version: number
        loop_state: string
        task_budget: string | null
        source_message: string | null
      }
    | undefined
}

function attachmentRows(worker: InProcessWorkerHandle) {
  return worker.db
    .prepare('SELECT attachment_id, size_bytes, expires_at FROM model_step_checkpoint_attachments')
    .all()
}

function entries(worker: InProcessWorkerHandle) {
  return worker.db
    .prepare(
      'SELECT seq, kind, tool_call_id, payload FROM model_step_checkpoint_entries ORDER BY seq'
    )
    .all() as Array<{ seq: number; kind: string; tool_call_id: string | null; payload: string }>
}

function twoIterationsThenOutage(error: Error): RespondResult[] {
  return [
    {
      type: 'tool_calls',
      calls: [{ id: 'tc_a', name: 'read_file', arguments: { path: 'README.md' } }],
    },
    {
      type: 'tool_calls',
      calls: [
        { id: 'tc_b', name: 'read_file', arguments: { path: 'src/a.ts' } },
        { id: 'tc_c', name: 'list_dir', arguments: { path: 'src' } },
      ],
    },
    { type: 'error', error },
    { type: 'text', content: 'no further completion may run' },
  ]
}

describe('runToolUseLoop model-step checkpoint (#1043)', () => {
  it('1. a 503 provider_unavailable after confirmed tools leaves a resumable checkpoint', async () => {
    const { worker, store, recorder } = harness()
    const appendSpy = vi.spyOn(store, 'append')
    const reasoning = createMockReasoning(twoIterationsThenOutage(outage()))
    const tools = [createMockTool('read_file'), createMockTool('list_dir')]

    const result = await runToolUseLoop(withRecorder(reasoning, tools, recorder), [user])

    expect(result).toMatchObject({ type: 'error', checkpointId: 'cp-loop' })
    expect(reasoning.continueWithToolResults).toHaveBeenCalledTimes(2)
    // Liveness witness: the recorder wrote every step. Seven transactions:
    // each result shares the next write (addendum A2), so 3 dispatches, 3
    // results and 5 messages need 2 tool-call syncs + 3 dispatches + 2
    // post-batch syncs.
    expect(appendSpy).toHaveBeenCalledTimes(7)
    expect(header(worker)).toMatchObject({
      status: 'resumable',
      version: 2,
      loop_state: JSON.stringify({ nextIteration: 2, originUserMessageIndex: 0 }),
      task_budget: JSON.stringify({ iterationsUsed: 1 }),
      source_message: SOURCE_MESSAGE,
    })
    // The file bytes are written once, at the resumable transition, and expire
    // after their own TTL.
    expect(attachmentRows(worker)).toEqual([
      { attachment_id: 'att-1', size_bytes: 3, expires_at: 1_000_000 + 3_600_000 },
    ])
    const rows = entries(worker)
    expect(rows.map(r => [r.kind, r.tool_call_id])).toEqual([
      ['message', null],
      ['message', null],
      ['tool_dispatch', 'tc_a'],
      ['tool_result', 'tc_a'],
      ['message', 'tc_a'],
      ['message', null],
      ['tool_dispatch', 'tc_b'],
      ['tool_result', 'tc_b'],
      ['tool_dispatch', 'tc_c'],
      ['tool_result', 'tc_c'],
      ['message', 'tc_b'],
      ['message', 'tc_c'],
    ])
    const assistant = JSON.parse(rows[5].payload) as ChatMessage
    expect(assistant.tool_calls?.map(c => [c.id, c.arguments])).toEqual([
      ['tc_b', { path: 'src/a.ts' }],
      ['tc_c', { path: 'src' }],
    ])
    expect(JSON.parse(rows[9].payload)).toEqual({ name: 'list_dir', isError: false })
    const toolMessage = JSON.parse(rows[11].payload) as ChatMessage
    expect(toolMessage).toMatchObject({ role: 'tool', tool_call_id: 'tc_c' })
    expect(toolMessage.content).toContain('list_dir result')
  })

  it('1b. a workflow tool in the last batch keeps the workflow fallback and abandons the checkpoint', async () => {
    const { worker, recorder } = harness()
    const reasoning = createMockReasoning([
      {
        type: 'tool_calls',
        calls: [
          { id: 'tc_w', name: 'workflow_result', arguments: { name: 'treasury-risk-review' } },
        ],
      },
      { type: 'error', error: outage() },
    ])
    const workflowTool = createMockTool('workflow_result', {
      sanitize: false,
      output: JSON.stringify({
        workflowName: 'treasury-risk-review',
        result: { artifactProof: 'artifact-output-1043' },
      }),
    })

    const result = await runToolUseLoop(withRecorder(reasoning, [workflowTool], recorder), [
      { role: 'user', content: 'Show me the workflow result artifact for treasury-risk-review.' },
    ])

    expect(result.type).toBe('response')
    if (result.type !== 'response') throw new Error(`expected a response, got ${result.type}`)
    expect(result.content).toContain('artifact-output-1043')
    expect(header(worker)?.status).toBe('abandoned')
    expect(entries(worker).some(r => r.kind === 'tool_result' && r.tool_call_id === 'tc_w')).toBe(
      true
    )
  })

  it('1c. a secret in tool-call arguments and reasoning never reaches a row', async () => {
    const { worker, recorder } = harness()
    const reasoning = createMockReasoning([
      {
        type: 'tool_calls',
        content: `calling with ${SECRET}`,
        reasoning_content: `the token is ${SECRET}`,
        calls: [
          {
            id: 'tc_s',
            name: 'http_get',
            arguments: { url: 'https://example.org/status', headers: { token: SECRET } },
          },
        ],
      },
      { type: 'error', error: outage() },
    ])

    const result = await runToolUseLoop(
      withRecorder(reasoning, [createMockTool('http_get')], recorder),
      [{ role: 'user', content: `use ${SECRET} to call the endpoint` }]
    )

    expect(result).toMatchObject({ type: 'error', checkpointId: 'cp-loop' })
    const rows = entries(worker)
    expect(rows.some(r => r.payload.includes(SECRET))).toBe(false)
    // Witness: the rows exist and keep the rest of the argument.
    const assistant = rows.find(
      r => r.kind === 'message' && (JSON.parse(r.payload) as ChatMessage).tool_calls
    )
    expect(assistant).toBeDefined()
    const parsed = JSON.parse(assistant?.payload ?? '{}') as ChatMessage
    expect(parsed.tool_calls?.[0].arguments).toMatchObject({ url: 'https://example.org/status' })
    expect(parsed.reasoning_content).toContain('the token is')
    expect(parsed.reasoning_content).toContain('[REDACTED')
  })

  it('1d. inline image bytes become a durable reference and expire on their own sweep', async () => {
    const IMAGE_TTL_MS = 30_000
    const CHECKPOINT_TTL_MS = 120_000
    const clock = { value: 1_000_000 }
    const imageBytes = Buffer.from('frame bytes')
    const imagePayload = imageBytes.toString('base64')
    const userWithImage: ChatMessage = {
      role: 'user',
      content: 'Inspect the screenshot.',
      contentParts: [
        { type: 'text', text: 'Inspect the screenshot.' },
        {
          type: 'image',
          mimeType: 'image/png',
          data: imagePayload,
          width: 4,
          height: 3,
          source: { kind: 'attachment', attachmentId: 'att-image', messageId: 'msg-1' },
        },
      ],
    }
    const { worker, store, recorder } = harness({
      sourceAttachments: [],
      attachmentTtlMs: IMAGE_TTL_MS,
      resumableTtlMs: CHECKPOINT_TTL_MS,
      now: () => clock.value,
    })
    const reasoning = createMockReasoning(twoIterationsThenOutage(outage()))
    const tools = [createMockTool('read_file'), createMockTool('list_dir')]

    const result = await runToolUseLoop(withRecorder(reasoning, tools, recorder), [userWithImage])

    expect(result).toMatchObject({ type: 'error', checkpointId: 'cp-loop' })
    expect(header(worker)).toMatchObject({ status: 'resumable', version: 2 })
    const messageRows = entries(worker).filter(row => row.kind === 'message')
    const originPayload = messageRows[0]!.payload
    // The entry keeps a typed reference; the base64 bytes never reach it (C3).
    expect(originPayload).not.toContain(imagePayload)
    const recorded = JSON.parse(originPayload) as { contentParts: Array<Record<string, unknown>> }
    const reference = recorded.contentParts.find(part => part.type === 'checkpoint-image')!
    expect(reference).toMatchObject({
      checkpointAttachmentId: expect.any(String),
      checkpointAttachmentExpiresAt: 1_000_000 + IMAGE_TTL_MS,
      checkpointAttachmentDigestHex: expect.any(String),
      mimeType: 'image/png',
      width: 4,
      height: 3,
      source: { kind: 'attachment', attachmentId: 'att-image', messageId: 'msg-1' },
    })
    expect(reference).not.toHaveProperty('data')
    // The bytes live in the expiring table under the reference's id.
    expect(attachmentRows(worker)).toEqual([
      {
        attachment_id: reference.checkpointAttachmentId,
        size_bytes: imageBytes.byteLength,
        expires_at: 1_000_000 + IMAGE_TTL_MS,
      },
    ])
    // Liveness witness: while the bytes are inside their own window, the durable
    // pair rebuilds the image exactly as sent.
    const recordedMessages = messageRows.map(
      row => JSON.parse(row.payload) as RecordedCheckpointMessage
    )
    const restored = restoreCheckpointMessages(
      recordedMessages,
      await store.loadAttachments(SESSION_KEY, 'cp-loop'),
      clock.value
    )
    expect(restored.ok).toBe(true)
    if (!restored.ok) return
    const restoredPart = restored.messages[0]!.contentParts!.find(part => part.type === 'image')
    expect(restoredPart).toMatchObject({
      type: 'image',
      mimeType: 'image/png',
      data: imagePayload,
      width: 4,
      height: 3,
    })

    // The image TTL is shorter than the checkpoint TTL, so the real sweep
    // deletes the physical byte row while the header stays resumable.
    clock.value = 1_000_000 + IMAGE_TTL_MS
    expect(await store.sweep(1_000)).toEqual({
      expired: 0,
      purgedCheckpoints: 0,
      purgedAttachments: 1,
    })
    expect(attachmentRows(worker)).toEqual([])
    expect(header(worker)).toMatchObject({ status: 'resumable', version: 2 })
    // ...and the helper blocks on the reference whose own window elapsed.
    expect(
      restoreCheckpointMessages(
        recordedMessages,
        await store.loadAttachments(SESSION_KEY, 'cp-loop'),
        clock.value
      )
    ).toEqual({
      ok: false,
      failure: { code: 'missing_or_expired', attachmentId: reference.checkpointAttachmentId },
    })
  })

  it('1e. the resumable transition persists the real budget the failed calls spent', async () => {
    const DURATION_MS = 10_000
    const MAX_ITERATIONS = 6
    const FIRST_FAILED_CALL_MS = 2_000
    const SECOND_FAILED_CALL_MS = 1_500
    const clock = { value: 1_000_000 }
    // The real budget the executor keeps, on a clock this test controls.
    const budgetA = new TaskExecutionBudget(DURATION_MS, MAX_ITERATIONS, () => clock.value)
    const { worker, store, recorder, onFenceLost } = harness({
      now: () => clock.value,
      taskBudget: () => JSON.stringify(budgetA.snapshot()),
    })
    const updateSpy = vi.spyOn(store, 'updateState')
    const trackingA = budgetTrackingEvents(budgetA)
    const controllerA = new AbortController()
    const reasoningA = advanceActiveTimeOnOutage(
      createMockReasoning(twoIterationsThenOutage(outage())),
      clock,
      FIRST_FAILED_CALL_MS
    )
    const tools = [createMockTool('read_file'), createMockTool('list_dir')]

    const resultA = await withStartedBudget(budgetA, controllerA, () =>
      runToolUseLoop(
        withRecorder(reasoningA, tools, recorder, MAX_ITERATIONS, {
          events: trackingA.events,
          abortSignal: controllerA.signal,
        }),
        [user]
      )
    )

    expect(resultA).toMatchObject({ type: 'error', checkpointId: 'cp-loop' })
    // One real iteration per loop pass, including the failed call.
    expect(trackingA.loopIterations).toEqual([0, 1, 2])
    expect(budgetA.snapshot()).toMatchObject({
      iterationsUsed: 3,
      elapsedActiveMs: FIRST_FAILED_CALL_MS,
    })

    // The last durable state predates the failed call...
    const lastState = JSON.parse(updateSpy.mock.calls.at(-1)![3]!) as TaskExecutionBudgetSnapshot
    expect(lastState).toMatchObject({ iterationsUsed: 2, elapsedActiveMs: 0 })
    // ...and the resumable transition publishes the failed call's spend.
    const persistedFirst = JSON.parse(header(worker)!.task_budget!) as TaskExecutionBudgetSnapshot
    expect(persistedFirst).toEqual({
      iterationsUsed: 3,
      elapsedActiveMs: FIRST_FAILED_CALL_MS,
      durationMs: DURATION_MS,
      maxIterations: MAX_ITERATIONS,
    })
    expect(header(worker)?.status).toBe('resumable')
    expect(recorder.poisoned).toBe(false)

    // A continuation restores that snapshot; the spend is not refunded.
    const budgetB = new TaskExecutionBudget(DURATION_MS, MAX_ITERATIONS, () => clock.value)
    budgetB.restore(persistedFirst)
    expect(budgetB.remainingIterations).toBe(3)
    expect(budgetB.remainingDurationMs).toBe(8_000)

    const claimB = await store.claim({
      sessionKey: SESSION_KEY,
      checkpointId: 'cp-loop',
      version: header(worker)!.version,
      hostInstanceId: 'host-instance-a',
      newTaskId: 'task-cont-1',
      leaseMs: 300_000,
    })
    if (claimB.outcome !== 'claimed') throw new Error(`unexpected claim: ${claimB.outcome}`)
    const recorderB = continuationRecorder({
      store,
      fence: claimB.fence,
      clock,
      sourceAttachments: [],
      restoredAttachments: await store.loadAttachments(SESSION_KEY, 'cp-loop'),
      taskBudget: () => JSON.stringify(budgetB.snapshot()),
      loopState: header(worker)!.loop_state,
    })
    const updateSpyB = vi.spyOn(store, 'updateState')
    const trackingB = budgetTrackingEvents(budgetB)
    const controllerB = new AbortController()
    const reasoningB = advanceActiveTimeOnOutage(
      createMockReasoning([
        {
          type: 'tool_calls',
          calls: [{ id: 'tc_d', name: 'read_file', arguments: { path: 'src/b.ts' } }],
        },
        { type: 'error', error: outage() },
      ]),
      clock,
      SECOND_FAILED_CALL_MS
    )

    const resultB = await withStartedBudget(budgetB, controllerB, () =>
      runToolUseLoop(
        withRecorder(reasoningB, tools, recorderB, MAX_ITERATIONS, {
          events: trackingB.events,
          abortSignal: controllerB.signal,
        }),
        [user]
      )
    )

    expect(resultB).toMatchObject({ type: 'error', checkpointId: 'cp-loop' })
    expect(trackingB.loopIterations).toEqual([0, 1])
    const lastStateB = JSON.parse(updateSpyB.mock.calls.at(-1)![3]!) as TaskExecutionBudgetSnapshot
    const persistedSecond = JSON.parse(header(worker)!.task_budget!) as TaskExecutionBudgetSnapshot
    expect(persistedSecond).toEqual({
      iterationsUsed: persistedFirst.iterationsUsed + 2,
      elapsedActiveMs: FIRST_FAILED_CALL_MS + SECOND_FAILED_CALL_MS,
      durationMs: DURATION_MS,
      maxIterations: MAX_ITERATIONS,
    })
    expect(persistedSecond.iterationsUsed).toBeGreaterThan(lastStateB.iterationsUsed)
    expect(persistedSecond.elapsedActiveMs).toBeGreaterThan(lastStateB.elapsedActiveMs)
    expect(header(worker)?.status).toBe('resumable')
    expect(recorderB.poisoned).toBe(false)
    // The repeated outage keeps spending: less allowance than after the first.
    expect(budgetB.remainingIterations).toBe(1)
    expect(budgetB.remainingDurationMs).toBe(DURATION_MS - persistedSecond.elapsedActiveMs)
    expect(budgetB.remainingDurationMs).toBeLessThan(DURATION_MS - persistedFirst.elapsedActiveMs)

    // The remaining allowance still funds a real, successful call.
    const budgetC = new TaskExecutionBudget(DURATION_MS, MAX_ITERATIONS, () => clock.value)
    budgetC.restore(persistedSecond)
    expect(budgetC.remainingIterations).toBe(1)
    expect(budgetC.remainingDurationMs).toBe(DURATION_MS - persistedSecond.elapsedActiveMs)

    const claimC = await store.claim({
      sessionKey: SESSION_KEY,
      checkpointId: 'cp-loop',
      version: header(worker)!.version,
      hostInstanceId: 'host-instance-a',
      newTaskId: 'task-cont-2',
      leaseMs: 300_000,
    })
    if (claimC.outcome !== 'claimed') throw new Error(`unexpected claim: ${claimC.outcome}`)
    const recorderC = continuationRecorder({
      store,
      fence: claimC.fence,
      clock,
      sourceAttachments: [],
      restoredAttachments: await store.loadAttachments(SESSION_KEY, 'cp-loop'),
      taskBudget: () => JSON.stringify(budgetC.snapshot()),
      loopState: header(worker)!.loop_state,
    })
    const trackingC = budgetTrackingEvents(budgetC)
    const controllerC = new AbortController()

    const resultC = await withStartedBudget(budgetC, controllerC, () =>
      runToolUseLoop(
        withRecorder(
          createMockReasoning([{ type: 'text', content: 'final answer' }]),
          tools,
          recorderC,
          MAX_ITERATIONS,
          { events: trackingC.events, abortSignal: controllerC.signal }
        ),
        [user]
      )
    )

    expect(resultC).toMatchObject({ type: 'response', content: 'final answer' })
    expect(trackingC.loopIterations).toEqual([0])
    expect(budgetC.snapshot()).toMatchObject({ iterationsUsed: MAX_ITERATIONS })
    expect(budgetC.remainingIterations).toBe(0)
    expect(onFenceLost).not.toHaveBeenCalled()
  })

  it('1f. loop_state freezes the origin user message and later user messages never move it', async () => {
    const historical: ChatMessage = { role: 'user', content: 'previous turn' }
    const assistant: ChatMessage = { role: 'assistant', content: 'previous answer' }
    const origin: ChatMessage = { role: 'user', content: 'current turn' }
    const synthetic: ChatMessage = { role: 'user', content: 'loop-injected note' }
    const { worker, recorder } = harness({ originUserMessageIndex: 2 })

    await recorder.begin([historical, assistant, origin])
    await recorder.updateState(1)
    expect(JSON.parse(header(worker)!.loop_state)).toEqual({
      nextIteration: 1,
      originUserMessageIndex: 2,
    })

    // The loop appends another user-role message; the frozen identity stays on
    // the current turn's message, which is message entry 2.
    await recorder.syncMessages([historical, assistant, origin, synthetic])
    await recorder.updateState(2)
    const state = JSON.parse(header(worker)!.loop_state) as { originUserMessageIndex: number }
    expect(state.originUserMessageIndex).toBe(2)
    const messageRows = entries(worker).filter(row => row.kind === 'message')
    expect(messageRows).toHaveLength(4)
    expect(JSON.parse(messageRows[2]!.payload)).toMatchObject({
      role: 'user',
      content: 'current turn',
    })
    expect(JSON.parse(messageRows[3]!.payload)).toMatchObject({
      role: 'user',
      content: 'loop-injected note',
    })

    // Positive witness for the guard: the boundary index must point at a user
    // message, so a wrong boundary fails loud instead of retargeting.
    await expect(
      harness({ originUserMessageIndex: 1 }).recorder.begin([historical, assistant, origin])
    ).rejects.toThrow(
      'Model-step checkpoint origin user message index does not point at a user message'
    )
  })

  it('1g. a continuation keeps restored first-capture deadlines and never extends them', async () => {
    const { worker, store, clock } = storeHarness()
    const fileBytes = Buffer.from([1, 2, 3])
    const fileDeadline = clock.value + 300_000
    const imageBytes = Buffer.from('restored frame')
    const imageDeadline = clock.value + 600_000
    const fence = await openClaimedCheckpoint(store, clock, [
      {
        attachmentId: 'att-1',
        digestHex: sha256(fileBytes),
        bytes: fileBytes,
        expiresAt: fileDeadline,
      },
      {
        attachmentId: 'att-image',
        digestHex: sha256(imageBytes),
        bytes: imageBytes,
        expiresAt: imageDeadline,
      },
    ])
    const restored = await store.loadAttachments(SESSION_KEY, 'cp-loop')
    clock.value += 120_000
    const recorder = continuationRecorder({
      store,
      fence,
      clock,
      sourceAttachments: [
        {
          id: 'att-1',
          kind: 'file',
          mimeType: 'text/plain',
          encoding: 'base64',
          dataBase64: fileBytes.toString('base64'),
        },
      ],
      restoredAttachments: restored,
    })

    await recorder.begin([user])
    await recorder.updateState(4)
    // A continuation retains the frozen origin identity across its updates.
    expect(JSON.parse(header(worker)!.loop_state)).toEqual({
      nextIteration: 4,
      originUserMessageIndex: 1,
    })
    await recorder.syncMessages([
      user,
      {
        role: 'user',
        content: 'look again',
        contentParts: [
          { type: 'text', text: 'look again' },
          { type: 'image', mimeType: 'image/png', data: imageBytes.toString('base64') },
          {
            type: 'image',
            mimeType: 'image/png',
            data: Buffer.from('fresh frame').toString('base64'),
          },
        ],
      },
    ])

    const result = await recorder.settle({ type: 'error', error: outage() })

    // The retry wrote the resumable header; had it tried to move a restored
    // deadline, the store would have refused the transition and poisoned it.
    expect(result).toBe('cp-loop')
    expect(header(worker)?.status).toBe('resumable')
    const rows = await store.loadAttachments(SESSION_KEY, 'cp-loop')
    const deadlines = new Map(rows.map(row => [row.attachment_id, row.expires_at]))
    expect(deadlines.get('att-1')).toBe(fileDeadline)
    expect(deadlines.get('att-image')).toBe(imageDeadline)
    // Genuinely new bytes first captured now get their own window.
    const fresh = rows.filter(
      row => row.attachment_id !== 'att-1' && row.attachment_id !== 'att-image'
    )
    expect(fresh).toHaveLength(1)
    expect(fresh[0]!.expires_at).toBe(clock.value + 3_600_000)
  })

  it('1h. expired restored bytes are never rewritten while fresh bytes still are', async () => {
    const FRESH_TTL_MS = 3_600_000
    const { worker, store, clock } = storeHarness()
    const imageBytes = Buffer.from('restored frame')
    const freshBytes = Buffer.from('fresh tool frame')
    const firstDeadline = clock.value + 60_000
    const fence = await openClaimedCheckpoint(store, clock, [
      {
        attachmentId: 'att-image',
        digestHex: sha256(imageBytes),
        bytes: imageBytes,
        expiresAt: firstDeadline,
      },
    ])
    const inRam = await store.loadAttachments(SESSION_KEY, 'cp-loop')
    // The sweep deleted the expired row while this continuation still holds the
    // bytes in RAM.
    clock.value = firstDeadline + 1
    worker.db.prepare('DELETE FROM model_step_checkpoint_attachments').run()
    const recorder = continuationRecorder({
      store,
      fence,
      clock,
      sourceAttachments: [],
      restoredAttachments: inRam,
      attachmentTtlMs: FRESH_TTL_MS,
    })

    await recorder.begin([user])
    await recorder.syncMessages([
      user,
      {
        role: 'user',
        content: 'look again',
        contentParts: [
          { type: 'image', mimeType: 'image/png', data: imageBytes.toString('base64') },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'tc_fresh',
        content: 'screenshot captured',
        contentParts: [
          { type: 'text', text: 'screenshot captured' },
          { type: 'image', mimeType: 'image/png', data: freshBytes.toString('base64') },
        ],
      },
    ])
    const result = await recorder.settle({ type: 'error', error: outage() })

    // The header still goes resumable...
    expect(result).toBe('cp-loop')
    expect(header(worker)?.status).toBe('resumable')

    const recordedMessages = entries(worker)
      .filter(row => row.kind === 'message')
      .map(row => JSON.parse(row.payload) as RecordedCheckpointMessage)
    const freshDigest = sha256(freshBytes)
    const freshMessageIndex = recordedMessages.findIndex(message =>
      (message.contentParts ?? []).some(
        part =>
          part.type === 'checkpoint-image' && part.checkpointAttachmentDigestHex === freshDigest
      )
    )
    expect(freshMessageIndex).toBeGreaterThanOrEqual(0)
    const freshReference = (recordedMessages[freshMessageIndex]!.contentParts ?? []).find(
      (part): part is RecordedCheckpointImagePart =>
        part.type === 'checkpoint-image' && part.checkpointAttachmentDigestHex === freshDigest
    )
    if (!freshReference) throw new Error('recorded message carries no fresh image reference')

    // ...with the genuinely new tool image stored under its own first window and
    // the expired row left out (the raw SQL row check does not filter expiry).
    expect(attachmentRows(worker)).toEqual([
      {
        attachment_id: freshReference.checkpointAttachmentId,
        size_bytes: freshBytes.byteLength,
        expires_at: clock.value + FRESH_TTL_MS,
      },
    ])
    // The fresh bytes restore byte-exact through the same helper.
    const liveRows = await store.loadAttachments(SESSION_KEY, 'cp-loop')
    const freshRestored = restoreCheckpointMessages(
      [recordedMessages[freshMessageIndex]!],
      liveRows,
      clock.value
    )
    expect(freshRestored.ok).toBe(true)
    if (freshRestored.ok) {
      const restoredImage = (freshRestored.messages[0]!.contentParts ?? []).find(
        part => part.type === 'image'
      )
      expect(restoredImage).toMatchObject({
        type: 'image',
        mimeType: 'image/png',
        data: freshBytes.toString('base64'),
      })
    }
    // A full replay still blocks on the expired reference instead of silently
    // reviving an extended window.
    expect(restoreCheckpointMessages(recordedMessages, liveRows, clock.value)).toEqual({
      ok: false,
      failure: { code: 'missing_or_expired', attachmentId: 'att-image' },
    })
  })

  describe('2. any other ending abandons the checkpoint', () => {
    const cases: Array<[string, LlmError]> = [
      [
        'connection_unavailable',
        new LlmError(
          'down',
          'codex-subscription',
          LlmErrorCode.ModelOverloaded,
          true,
          undefined,
          503,
          'connection_unavailable'
        ),
      ],
      [
        'stream_duration_exceeded',
        new LlmError(
          'long',
          'codex-subscription',
          LlmErrorCode.StreamDurationExceeded,
          false,
          undefined,
          undefined,
          'stream_duration_exceeded'
        ),
      ],
      [
        'outcome_unknown',
        new LlmError(
          'unknown',
          'codex-subscription',
          LlmErrorCode.ApiCallFailed,
          false,
          undefined,
          undefined,
          'outcome_unknown'
        ),
      ],
      [
        'rate_limited',
        new LlmError(
          'slow down',
          'codex-subscription',
          LlmErrorCode.RateLimited,
          true,
          undefined,
          429,
          'rate_limited'
        ),
      ],
      [
        'tool_call_limit_exceeded',
        new LlmError(
          'limit',
          'codex-subscription',
          LlmErrorCode.ToolCallLimitExceeded,
          false,
          undefined,
          undefined,
          'tool_call_limit_exceeded'
        ),
      ],
    ]

    it.each(cases)('%s', async (_code, error) => {
      const { worker, recorder } = harness()
      const reasoning = createMockReasoning(twoIterationsThenOutage(error))
      const tools = [createMockTool('read_file'), createMockTool('list_dir')]

      const result = await runToolUseLoop(withRecorder(reasoning, tools, recorder), [user])

      expect(result.type).toBe('error')
      expect(result).not.toHaveProperty('checkpointId')
      // Witness: the checkpoint existed and recorded the confirmed tools.
      expect(entries(worker).filter(r => r.kind === 'tool_result')).toHaveLength(3)
      expect(header(worker)?.status).toBe('abandoned')
      // A checkpoint that cannot continue never writes inline file bytes.
      expect(attachmentRows(worker)).toEqual([])
    })

    it('cancellation', async () => {
      const { worker, recorder } = harness()
      const controller = new AbortController()
      const reasoning = createMockReasoning(twoIterationsThenOutage(outage()))
      const cancelling = createMockTool('list_dir')
      vi.mocked(cancelling.execute).mockImplementation(async () => {
        controller.abort()
        return { content: 'listed', duration_ms: 1, is_error: false }
      })
      const config = {
        ...withRecorder(reasoning, [createMockTool('read_file'), cancelling], recorder),
        abortSignal: controller.signal,
      }

      const result = await runToolUseLoop(config, [user])

      expect(result).toEqual({ type: 'cancelled', reason: 'signal_aborted' })
      expect(entries(worker).some(r => r.kind === 'tool_result' && r.tool_call_id === 'tc_c')).toBe(
        true
      )
      expect(header(worker)?.status).toBe('abandoned')
    })
  })

  it('3. a 503 on the first completion, before any confirmed tool, abandons', async () => {
    const { worker, recorder } = harness()
    const reasoning = createMockReasoning([{ type: 'error', error: outage() }])

    const result = await runToolUseLoop(
      withRecorder(reasoning, [createMockTool('read_file')], recorder),
      [user]
    )

    expect(result.type).toBe('error')
    expect(result).not.toHaveProperty('checkpointId')
    expect(reasoning.respondWithTools).toHaveBeenCalledTimes(1)
    expect(entries(worker).map(r => r.kind)).toEqual(['message'])
    expect(header(worker)?.status).toBe('abandoned')
  })

  it('4. a failed write in iteration 2 keeps the loop running and never leaves it resumable', async () => {
    const { worker, store, recorder, onFenceLost } = harness()
    const original = store.append.bind(store)
    let calls = 0
    vi.spyOn(store, 'append').mockImplementation(async (...args) => {
      calls += 1
      if (calls === 5) throw new Error('SQLITE_IOERR: disk I/O error')
      return original(...args)
    })
    const reasoning = createMockReasoning(twoIterationsThenOutage(outage()))
    const tools = [createMockTool('read_file'), createMockTool('list_dir')]

    const result = await runToolUseLoop(withRecorder(reasoning, tools, recorder), [user])

    expect(result.type).toBe('error')
    expect(result).not.toHaveProperty('checkpointId')
    // Witness: the loop reached the second batch and the outage after it.
    expect(tools[1].execute).toHaveBeenCalledTimes(1)
    expect(reasoning.continueWithToolResults).toHaveBeenCalledTimes(2)
    expect(recorder.poisoned).toBe(true)
    expect(onFenceLost).not.toHaveBeenCalled()
    expect(header(worker)?.status).toBe('abandoned')
  })

  it('5. a tool that throws mid-batch reads unknown; the next one is never dispatched', async () => {
    const { worker, recorder } = harness()
    const reasoning = createMockReasoning([
      {
        type: 'tool_calls',
        calls: [
          { id: 'tc_1', name: 'read_file', arguments: { path: 'a' } },
          { id: 'tc_2', name: 'publish', arguments: { target: 'b' } },
          { id: 'tc_3', name: 'read_file', arguments: { path: 'c' } },
        ],
      },
    ])
    const publish: Tool = {
      ...createMockTool('publish'),
      finalizeResult: async (): Promise<ToolResult> => {
        throw new Error('result policy rejected the output')
      },
    }

    await expect(
      runToolUseLoop(withRecorder(reasoning, [createMockTool('read_file'), publish], recorder), [
        user,
      ])
    ).rejects.toThrow('result policy rejected the output')

    expect(publish.execute).toHaveBeenCalledTimes(1)
    const ledger = entries(worker)
      .filter(r => r.kind !== 'message')
      .map(r => [r.kind, r.tool_call_id])
    expect(ledger).toEqual([
      ['tool_dispatch', 'tc_1'],
      ['tool_result', 'tc_1'],
      ['tool_dispatch', 'tc_2'],
    ])
    expect(header(worker)?.status).toBe('abandoned')
  })

  it('6. volume: 1000 tool calls are recorded; recorder overhead is measured', async () => {
    const calls = Array.from({ length: 1000 }, (_, i) => ({
      id: `tc_${i}`,
      name: 'read_file',
      arguments: { path: `f${i}` },
    }))
    const script = (): RespondResult[] => [
      { type: 'tool_calls', calls },
      { type: 'error', error: outage() },
    ]

    const baselineStart = performance.now()
    await runToolUseLoop(
      buildTestConfig(createMockReasoning(script()), [createMockTool('read_file')]),
      [user]
    )
    const baselineMs = performance.now() - baselineStart

    const { worker, recorder } = harness()
    const recordedStart = performance.now()
    const result = await runToolUseLoop(
      withRecorder(createMockReasoning(script()), [createMockTool('read_file')], recorder),
      [user]
    )
    const recordedMs = performance.now() - recordedStart

    expect(result).toMatchObject({ type: 'error', checkpointId: 'cp-loop' })
    const rows = entries(worker)
    expect(rows.filter(r => r.kind === 'tool_dispatch')).toHaveLength(1000)
    expect(rows.filter(r => r.kind === 'tool_result')).toHaveLength(1000)
    expect(rows.filter(r => r.kind === 'message')).toHaveLength(1002)
    // §5.3.12 — recorded for the PR; the batching decision is made on it.
    console.info(
      `[model-step checkpoint volume] baseline=${baselineMs.toFixed(1)}ms recorded=${recordedMs.toFixed(1)}ms overhead=${(((recordedMs - baselineMs) / baselineMs) * 100).toFixed(1)}%`
    )
  }, 120_000)
})
