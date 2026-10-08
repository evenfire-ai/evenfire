/**
 * #1043 — the tool-use loop records a durable model-step checkpoint, and only
 * a 503 `provider_unavailable` after a confirmed tool result leaves it
 * resumable. Runs against the real dispatcher and SQLite schema.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type InProcessWorkerHandle,
  createInProcessWorker,
} from '../../conversation/persistence/__tests__/testHelpers'
import { ModelStepCheckpointStore } from '../../conversation/persistence/modelStepCheckpointStore'
import { PersistQueue } from '../../conversation/persistence/persistQueue'
import { LlmError, LlmErrorCode } from '../../errors'
import type { Tool } from '../../interfaces'
import { BasicSafety } from '../../safety/safety'
import type { ChatMessage, RespondResult, ToolResult } from '../../types'
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

function harness() {
  const worker = createInProcessWorker(':memory:')
  workers.push(worker)
  const queue = new PersistQueue(worker.worker, { syncTimeoutMs: 5000, asyncTimeoutMs: 5000 })
  queues.push(queue)
  const store = new ModelStepCheckpointStore(queue, { now: () => 1_000_000 })
  const safety = new BasicSafety()
  const onFenceLost = vi.fn()
  const inlineFileAttachments = vi.fn(() => [
    { attachmentId: 'att-1', digestHex: 'cd'.repeat(32), bytes: new Uint8Array([1, 2, 3]) },
  ])
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
    },
    redact: text =>
      safety.sanitizeFreeformContent(text, { secretWarning: 'secret in checkpoint' }).content,
    taskBudget: () => JSON.stringify({ iterationsUsed: 1 }),
    resumableTtlMs: 60_000,
    inlineFileAttachments,
    attachmentTtlMs: 3_600_000,
    now: () => 1_000_000,
    onFenceLost,
  })
  return { worker, store, recorder, onFenceLost, inlineFileAttachments }
}

function withRecorder(
  reasoning: ReturnType<typeof createMockReasoning>,
  tools: Tool[],
  recorder: ModelStepCheckpointRecorder,
  maxIterations = 4
) {
  return {
    ...buildTestConfig(reasoning, tools),
    modelStepCheckpointRecorder: recorder,
    maxIterations,
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
    const { worker, store, recorder, inlineFileAttachments } = harness()
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
      loop_state: JSON.stringify({ nextIteration: 2 }),
      task_budget: JSON.stringify({ iterationsUsed: 1 }),
      source_message: SOURCE_MESSAGE,
    })
    // Inline file bytes are read once, at the resumable transition, and expire
    // after their own TTL.
    expect(inlineFileAttachments).toHaveBeenCalledTimes(1)
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
      const { worker, recorder, inlineFileAttachments } = harness()
      const reasoning = createMockReasoning(twoIterationsThenOutage(error))
      const tools = [createMockTool('read_file'), createMockTool('list_dir')]

      const result = await runToolUseLoop(withRecorder(reasoning, tools, recorder), [user])

      expect(result.type).toBe('error')
      expect(result).not.toHaveProperty('checkpointId')
      // Witness: the checkpoint existed and recorded the confirmed tools.
      expect(entries(worker).filter(r => r.kind === 'tool_result')).toHaveLength(3)
      expect(header(worker)?.status).toBe('abandoned')
      // A checkpoint that cannot continue never writes inline file bytes.
      expect(inlineFileAttachments).not.toHaveBeenCalled()
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
