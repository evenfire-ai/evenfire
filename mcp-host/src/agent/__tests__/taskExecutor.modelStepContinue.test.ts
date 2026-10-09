/**
 * #1043 — continuation execution over a real SQLite checkpoint. These tests
 * seed a durable origin turn and checkpoint, then run TaskExecutor without
 * replacing its tool loop or checkpoint store. Only the LLM provider and the
 * GFS metadata client are test doubles.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import {
  type FileReferenceV1,
  buildGfsFileReference,
  classifyBytes,
} from '@clerum/gfs-interaction-policy'
import { config as appConfig } from '../../config'
import { LlmPortAdapter } from '../../core/adapters/llmPortAdapter'
import { ConversationManager } from '../../core/conversation/conversation'
import {
  type StoreHandle,
  makeSqliteStore,
} from '../../core/conversation/persistence/__tests__/testHelpers'
import { ModelStepCheckpointStore } from '../../core/conversation/persistence/modelStepCheckpointStore'
import { LlmErrorCode } from '../../core/errors'
import { SimpleEventEmitter } from '../../core/orchestration/eventEmitter'
import { buildTurnContextBlock } from '../../core/orchestration/turnContext'
import {
  type AgentEvent,
  type ChatMessage,
  FinishReason,
  type MessageContentPart,
  type ToolCall,
} from '../../core/types'
import type { ModelStepCheckpointFence } from '../../db/worker/modelStepCheckpointOps'
import { GfscHttpError } from '../../internalTools/gfsClient'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import { FailoverEngine } from '../../llm/failover/engine'
import type { LlmPolicy } from '../../llm/failover/types'
import type { SingleTurnProvider } from '../../llm/types'
import { McpManager } from '../../mcp/manager'
import type { ModelStepContinuationRef, Task, TaskError } from '../../queue/types'
import type { IncomingMessage } from '../../server/types'
import type { FileReferenceGfsAccess } from '../fileReferenceGfsGate'
import {
  type FileReferenceGfscClient,
  referencedFilesForTurnContext,
} from '../fileReferenceResolver'
import { fileReferenceCheckError } from '../incomingAdmission'
import { validateIncomingAttachments } from '../incomingAttachments'
import { TaskExecutor, type TaskExecutorDeps } from '../taskExecutor'

const USER = 'user-b2'
const AGENT = 'chatllm'
const CHAT = 'chat-b2'
const SESSION_KEY = `${USER}:rpc:${AGENT}:${CHAT}`
const NOW = 1_700_000_000_000
const RESUMABLE_TTL_MS = 7 * 24 * 3_600_000
const ATTACHMENT_TTL_MS = 3_600_000
const LEASE_MS = 300_000
const UPLOAD = Buffer.from('Quarterly notes. SENTINEL-1043-continuation\n')
const RID = '1234567890abcdef1234567890abcdef'
const USAGE = { input_tokens: 1, output_tokens: 1, total_tokens: 2 }

const handles: StoreHandle[] = []
let clock = NOW
let dateNow: typeof Date.now
const savedConfig = {
  enableApproval: appConfig.enableApproval,
  dynamicToolsEnabled: appConfig.dynamicToolsEnabled,
  promptCacheEnabled: appConfig.promptCacheEnabled,
}

type ProviderScript = (
  messages: ChatMessage[]
) =>
  | { calls?: ToolCall[]; content?: string; error?: Error }
  | Promise<{ calls?: ToolCall[]; content?: string; error?: Error }>

interface RecordingProvider extends SingleTurnProvider {
  requests: ChatMessage[][]
  calls: () => number
}

function provider(
  type: string = 'openai',
  script: ProviderScript = () => ({ content: 'continuation final answer' })
): RecordingProvider {
  let invocations = 0
  const requests: ChatMessage[][] = []
  const object: RecordingProvider = {
    requests,
    calls: () => invocations,
    getProviderType: () => type as never,
    classifyError: error => ({
      code:
        error instanceof Error && error.message.includes('upstream 503')
          ? LlmErrorCode.ModelOverloaded
          : LlmErrorCode.ApiCallFailed,
      retryable: error instanceof Error && error.message.includes('upstream 503') ? true : false,
      message: error instanceof Error ? error.message : String(error),
      httpStatus:
        error instanceof Error && error.message.includes('upstream 503') ? 503 : undefined,
      providerCode:
        error instanceof Error && error.message.includes('upstream 503')
          ? 'provider_unavailable'
          : undefined,
    }),
    completeSingleTurn: async () => {
      throw new Error('Unexpected tool-less completion')
    },
    completeSingleTurnWithTools: async (messages: ChatMessage[]) => {
      invocations += 1
      requests.push(messages)
      const result = await script(messages)
      if (result.error) throw result.error
      if (result.calls) {
        return {
          content: result.content ?? null,
          tool_calls: result.calls,
          usage: USAGE,
          finish_reason: FinishReason.ToolUse,
        }
      }
      return {
        content: result.content ?? 'continuation final answer',
        tool_calls: [],
        usage: USAGE,
        finish_reason: FinishReason.Stop,
      }
    },
  }
  return object
}

function fileAttachment(digestHex = createHash('sha256').update(UPLOAD).digest('hex')) {
  const admittedDigest = createHash('sha256').update(UPLOAD).digest('hex')
  const admission = validateIncomingAttachments(
    [
      {
        id: 'file-b2',
        kind: 'file',
        mimeType: 'text/plain',
        detectedMediaType: 'text/plain',
        encoding: 'base64',
        dataBase64: UPLOAD.toString('base64'),
        filename: 'notes-b2.txt',
        sizeBytes: UPLOAD.length,
        digest: { algorithm: 'sha256', hex: admittedDigest },
      },
    ],
    { maxCount: 20, maxBytes: 1_000_000, maxFileBytes: 3_145_728, messageId: 'message-b2' }
  )
  if (!admission.ok) {
    throw new Error(
      `attachment fixture rejected: ${admission.error.code}: ${admission.error.message}`
    )
  }
  const attachment = { ...admission.attachments![0]! }
  attachment.digest = { algorithm: 'sha256', hex: digestHex }
  delete (attachment as Partial<typeof attachment>).dataBase64
  return attachment
}

function gfsReference(): FileReferenceV1 {
  const built = buildGfsFileReference({
    drive: 'main',
    resourceId: RID,
    gfsUri: `gfs://main/${RID}`,
    version: 3,
    name: 'notes-b2.md',
    declaredMediaType: 'text/markdown',
    byteLength: 120,
    classification: classifyBytes({
      bytes: new Uint8Array(0),
      totalByteLength: 120,
      declaredMediaType: 'text/markdown',
      filename: 'notes-b2.md',
    }),
  })
  if (!built.ok) throw new Error(built.message)
  return built.value
}

function sourceMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    sender: USER,
    content: 'Continue the interrupted model step',
    channelType: 'rpc',
    channelId: AGENT,
    threadId: CHAT,
    messageId: 'message-b2',
    timestamp: new Date(NOW).toISOString(),
    hostRef: 'host-b2',
    ...overrides,
  }
}

function budget(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    elapsedActiveMs: 0,
    iterationsUsed: 0,
    durationMs: 300_000,
    maxIterations: 20,
    attachmentReadLedger: { reads: 0, spentTokens: 0, bytesRead: 0 },
    ...overrides,
  })
}

interface CheckpointFixture {
  handle: StoreHandle
  manager: ConversationManager
  checkpoints: ModelStepCheckpointStore
  message: IncomingMessage
  fence: ModelStepCheckpointFence
  taskBudget: string
  confirmedResults: number
  claimedVersion: number
}

async function claimedCheckpoint(options: {
  message?: IncomingMessage
  entries?: Parameters<ModelStepCheckpointStore['append']>[2]
  confirmedResults?: number
  taskBudget?: string
  withAttachment?: boolean
  checkpointId?: string
  /** The user message as the origin sent it (production records it with its turn-context block). */
  recordedUserContent?: string
  recordedUserParts?: MessageContentPart[]
}): Promise<CheckpointFixture> {
  const handle = makeSqliteStore()
  handles.push(handle)
  const manager = new ConversationManager(handle.store)
  const checkpoints = new ModelStepCheckpointStore(handle.persistQueue, { now: () => clock })
  const message = options.message ?? sourceMessage()
  const conversation = await manager.getOrCreate(SESSION_KEY, {
    userId: USER,
    channelType: 'rpc',
    channelId: AGENT,
    threadId: CHAT,
    source: 'rpc',
  })
  await manager.startTurn(conversation, message.content, 'task-origin-b2')
  await manager.failTurn(conversation)

  const checkpointId = options.checkpointId ?? 'checkpoint-b2'
  const initialEntries = [
    {
      kind: 'message' as const,
      toolCallId: null,
      payload: JSON.stringify({
        role: 'user',
        content: options.recordedUserContent ?? message.content,
        ...(options.recordedUserParts ? { contentParts: options.recordedUserParts } : {}),
      }),
    },
  ]
  const openFence = await checkpoints.open(
    {
      checkpointId,
      sessionKey: SESSION_KEY,
      originTurnNumber: 1,
      originTaskId: 'task-origin-b2',
      provider: 'openai',
      model: 'checkpoint-model',
      hostId: 'host-a',
      principal: USER,
      loopState: JSON.stringify({ nextIteration: 0, originUserMessageIndex: 0 }),
      taskBudget: options.taskBudget ?? budget(),
      sourceMessage: JSON.stringify(message),
    },
    initialEntries
  )
  const appended = await checkpoints.append(SESSION_KEY, openFence, options.entries ?? [])
  if (!appended) throw new Error('checkpoint fixture append was rejected')
  const taskBudget = options.taskBudget ?? budget()
  const attachments =
    options.withAttachment === true
      ? [
          {
            attachmentId: 'file-b2',
            digestHex: createHash('sha256').update(UPLOAD).digest('hex'),
            bytes: UPLOAD,
            expiresAt: NOW + ATTACHMENT_TTL_MS,
          },
        ]
      : []
  const resumableVersion = await checkpoints.transition(SESSION_KEY, openFence, {
    from: ['open'],
    to: 'resumable',
    failedAt: NOW,
    expiresAt: NOW + RESUMABLE_TTL_MS,
    ...(attachments.length > 0 ? { attachments } : {}),
  })
  if (resumableVersion === null) throw new Error('checkpoint fixture could not become resumable')
  const claim = await checkpoints.claim({
    sessionKey: SESSION_KEY,
    checkpointId,
    version: resumableVersion,
    hostInstanceId: 'host-instance-b2',
    newTaskId: 'task-continuation-b2',
    leaseMs: LEASE_MS,
  })
  if (claim.outcome !== 'claimed') {
    throw new Error(`checkpoint fixture claim failed: ${claim.outcome}`)
  }
  return {
    handle,
    manager,
    checkpoints,
    message,
    fence: claim.fence,
    taskBudget,
    confirmedResults: options.confirmedResults ?? 0,
    claimedVersion: claim.snapshot.header.version,
  }
}

function continuationRef(
  fixture: CheckpointFixture,
  onVerdict: ModelStepContinuationRef['onVerdict'],
  options: { taskId?: string; fence?: ModelStepCheckpointFence } = {}
): ModelStepContinuationRef {
  return {
    checkpointId: fixture.fence.checkpointId,
    originTaskId: 'task-origin-b2',
    originTurnNumber: 1,
    provider: 'openai',
    model: 'checkpoint-model',
    fence: options.fence ?? fixture.fence,
    confirmedResults: fixture.confirmedResults,
    taskBudget: fixture.taskBudget,
    onVerdict,
  }
}

async function runContinuation(
  fixture: CheckpointFixture,
  llmProvider: SingleTurnProvider,
  options: {
    events?: SimpleEventEmitter
    onVerdict?: ModelStepContinuationRef['onVerdict']
    deps?: Partial<TaskExecutorDeps>
    taskId?: string
    fence?: ModelStepCheckpointFence
  } = {}
): Promise<{
  task: Task
  executor: TaskExecutor
  onFail: ReturnType<typeof vi.fn<(task: Task, error: TaskError) => void>>
  onComplete: ReturnType<typeof vi.fn<(task: Task) => void>>
  onApprovalNeeded: ReturnType<typeof vi.fn>
  verdict: ReturnType<typeof vi.fn>
}> {
  const onFail = vi.fn<(task: Task, error: TaskError) => void>()
  const onComplete = vi.fn<(task: Task) => void>()
  const onApprovalNeeded = vi.fn()
  const verdict = vi.fn(options.onVerdict)
  const taskId = options.taskId ?? 'task-continuation-b2'
  const task: Task = {
    id: taskId,
    source: 'channel',
    sourceMessage: fixture.message,
    traceContext: null,
    priority: 'normal',
    status: 'pending',
    createdAt: new Date(NOW),
    conversationHistory: [
      { role: 'user', content: fixture.message.content, timestamp: new Date(NOW) },
    ],
    responseCallback: vi.fn(async () => {}),
    modelStepContinuation: continuationRef(fixture, verdict, {
      taskId: options.taskId,
      fence: options.fence,
    }),
  }
  const lifecycle = new TaskLifecycle()
  lifecycle.register(task)
  const executor = new TaskExecutor(task, {
    conversationManager: fixture.manager,
    llmProvider,
    mcpManager: new McpManager(),
    workspaceService: undefined,
    modelName: 'checkpoint-model',
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
    onApprovalNeeded,
    onComplete,
    onFail,
    dynamicEnvProvider: () => ({}),
    modelStepCheckpoints: {
      store: fixture.checkpoints,
      hostInstanceId: 'host-instance-b2',
      hostId: 'host-a',
      resumableTtlMs: RESUMABLE_TTL_MS,
      claimLeaseMs: LEASE_MS,
      pendingApprovalTtlMs: RESUMABLE_TTL_MS,
      attachmentTtlMs: ATTACHMENT_TTL_MS,
      ...options.deps?.modelStepCheckpoints,
    },
    ...options.deps,
    // Keep the caller-supplied event emitter observable even if other deps change.
    ...(options.events ? { coreEvents: options.events } : {}),
  } satisfies TaskExecutorDeps)
  return { task, executor, onFail, onComplete, onApprovalNeeded, verdict }
}

async function expireAndReclaimFixture(
  fixture: CheckpointFixture,
  taskId: string
): Promise<ModelStepCheckpointFence> {
  // Advance the injected checkpoint clock past A's lease while its provider
  // call is still pending. B claims directly from the expired claimed row.
  clock += LEASE_MS + 1
  expect(header(fixture.handle).status).toBe('claimed')
  const reclaimed = await fixture.checkpoints.claim({
    sessionKey: SESSION_KEY,
    checkpointId: fixture.fence.checkpointId,
    version: header(fixture.handle).version,
    hostInstanceId: 'host-instance-replacement',
    newTaskId: taskId,
    leaseMs: LEASE_MS,
  })
  if (reclaimed.outcome !== 'claimed') {
    throw new Error(`fixture replacement claim failed: ${reclaimed.outcome}`)
  }
  return reclaimed.fence
}

interface HeaderRow {
  checkpoint_id: string
  status: string
  version: number
  blocked_reason: string | null
  claim_owner: string | null
  claim_generation: number | null
}

function header(handle: StoreHandle, checkpointId = 'checkpoint-b2'): HeaderRow {
  const row = handle.worker.db
    .prepare(
      `SELECT checkpoint_id, status, version, blocked_reason, claim_owner, claim_generation
       FROM model_step_checkpoints WHERE checkpoint_id = ?`
    )
    .get(checkpointId) as HeaderRow | undefined
  if (!row) throw new Error(`checkpoint row missing: ${checkpointId}`)
  return row
}

function turnRows(handle: StoreHandle): Array<{
  ordinal: number
  role: string
  content: string | null
  turn_number: number
  model_step_checkpoint_id: string | null
}> {
  return handle.worker.db
    .prepare(
      `SELECT ordinal, role, content, turn_number, model_step_checkpoint_id
       FROM messages ORDER BY ordinal`
    )
    .all() as never
}

function toolCallNames(events: SimpleEventEmitter): string[] {
  const names: string[] = []
  const listener = (event: AgentEvent) => {
    if (event.type === 'tool:called' && typeof event.data.toolName === 'string') {
      names.push(event.data.toolName)
    }
  }
  events.on('tool:called', listener)
  return names
}

function checkpointEntries(handle: StoreHandle, checkpointId = 'checkpoint-b2') {
  return handle.worker.db
    .prepare(
      `SELECT kind, tool_call_id FROM model_step_checkpoint_entries
       WHERE checkpoint_id = ? ORDER BY seq`
    )
    .all(checkpointId) as Array<{ kind: string; tool_call_id: string | null }>
}

function gfsView(fields: Record<string, unknown> = {}) {
  return {
    ok: true,
    data: {
      resourceId: RID,
      rid: RID,
      drive: 'main',
      gfsUri: `gfs://main/${RID}`,
      kind: 'file',
      name: 'notes-b2.md',
      version: 3,
      bytes: 120,
      ...fields,
    },
  }
}

beforeEach(() => {
  clock = NOW
  dateNow = Date.now
  vi.spyOn(Date, 'now').mockImplementation(() => clock)
})

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.shutdown()
  Object.assign(appConfig, savedConfig)
  vi.useRealTimers()
  Date.now = dateNow
  vi.restoreAllMocks()
})

describe('TaskExecutor model-step continuation (#1043)', () => {
  beforeEach(() => {
    Object.assign(appConfig, { enableApproval: false, dynamicToolsEnabled: false })
  })

  it('1. replays confirmed results, keeps tools idle, and completes the origin turn', async () => {
    const entries = [
      {
        kind: 'message' as const,
        toolCallId: null,
        payload: JSON.stringify({
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'confirmed-1', name: 'system_info', arguments: {} },
            { id: 'confirmed-2', name: 'system_info', arguments: {} },
          ],
        }),
      },
      {
        kind: 'tool_dispatch' as const,
        toolCallId: 'confirmed-1',
        payload: '{"name":"system_info"}',
      },
      {
        kind: 'tool_result' as const,
        toolCallId: 'confirmed-1',
        payload: '{"name":"system_info","isError":false}',
      },
      {
        kind: 'message' as const,
        toolCallId: 'confirmed-1',
        payload: JSON.stringify({
          role: 'tool',
          tool_call_id: 'confirmed-1',
          name: 'system_info',
          content: 'confirmed result one',
        }),
      },
      {
        kind: 'tool_dispatch' as const,
        toolCallId: 'confirmed-2',
        payload: '{"name":"system_info"}',
      },
      {
        kind: 'tool_result' as const,
        toolCallId: 'confirmed-2',
        payload: '{"name":"system_info","isError":false}',
      },
      {
        kind: 'message' as const,
        toolCallId: 'confirmed-2',
        payload: JSON.stringify({
          role: 'tool',
          tool_call_id: 'confirmed-2',
          name: 'system_info',
          content: 'confirmed result two',
        }),
      },
    ]
    const fixture = await claimedCheckpoint({ entries, confirmedResults: 2 })
    const events = new SimpleEventEmitter()
    const toolNames = toolCallNames(events)
    const llm = provider()
    const run = await runContinuation(fixture, llm, { events })
    await run.executor.run()
    await fixture.handle.persistQueue.drain()

    expect(llm.calls()).toBe(1)
    const sent = llm.requests[0]!
    expect(
      sent
        .filter(message => message.role !== 'system')
        .map(message => [message.role, message.content])
    ).toEqual([
      ['user', expect.stringContaining('Continue the interrupted model step')],
      ['assistant', ''],
      ['tool', 'confirmed result one'],
      ['tool', 'confirmed result two'],
    ])
    expect(toolNames).toEqual([])
    expect(run.verdict).toHaveBeenCalledTimes(1)
    expect(run.verdict).toHaveBeenCalledWith({ kind: 'started' })
    expect(run.onFail).not.toHaveBeenCalled()
    expect(run.onComplete).toHaveBeenCalledTimes(1)
    expect(header(fixture.handle)).toMatchObject({ status: 'completed', version: 4 })
    expect(turnRows(fixture.handle)).toEqual([
      expect.objectContaining({ role: 'user', turn_number: 1 }),
      expect.objectContaining({
        role: 'assistant',
        content: 'continuation final answer',
        turn_number: 1,
        model_step_checkpoint_id: 'checkpoint-b2',
      }),
    ])
  })

  it('2. synthesizes unknown and not-dispatched tool outcomes without executing them', async () => {
    const entries = [
      {
        kind: 'message' as const,
        toolCallId: null,
        payload: JSON.stringify({
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'confirmed-1', name: 'system_info', arguments: {} },
            { id: 'unknown-1', name: 'system_info', arguments: {} },
            { id: 'not-dispatched-1', name: 'system_info', arguments: {} },
          ],
        }),
      },
      {
        kind: 'tool_dispatch' as const,
        toolCallId: 'confirmed-1',
        payload: '{"name":"system_info"}',
      },
      {
        kind: 'tool_result' as const,
        toolCallId: 'confirmed-1',
        payload: '{"name":"system_info","isError":false}',
      },
      {
        kind: 'message' as const,
        toolCallId: 'confirmed-1',
        payload: JSON.stringify({
          role: 'tool',
          tool_call_id: 'confirmed-1',
          name: 'system_info',
          content: 'confirmed result one',
        }),
      },
      {
        kind: 'tool_dispatch' as const,
        toolCallId: 'unknown-1',
        payload: '{"name":"system_info"}',
      },
    ]
    const fixture = await claimedCheckpoint({ entries, confirmedResults: 1 })
    const events = new SimpleEventEmitter()
    const toolNames = toolCallNames(events)
    const llm = provider()
    const run = await runContinuation(fixture, llm, { events })
    await run.executor.run()
    await fixture.handle.persistQueue.drain()

    const sent = llm.requests[0]!
    expect(sent.filter(message => message.role === 'tool').map(message => message.content)).toEqual(
      ['confirmed result one', 'Tool outcome unknown; not re-executed', 'Not executed']
    )
    expect(sent.map(message => message.tool_call_id)).toContain('unknown-1')
    expect(sent.map(message => message.tool_call_id)).toContain('not-dispatched-1')
    expect(llm.calls()).toBe(1)
    expect(toolNames).toEqual([])
    expect(header(fixture.handle)).toMatchObject({ status: 'completed', version: 4 })
  })

  it('3. reports a lost lease before start and does not reopen the origin turn', async () => {
    const fixture = await claimedCheckpoint({})
    const released = await fixture.checkpoints.transition(SESSION_KEY, fixture.fence, {
      from: ['claimed'],
      to: 'resumable',
      failedAt: NOW,
      expiresAt: NOW + RESUMABLE_TTL_MS,
    })
    if (released === null) throw new Error('checkpoint fixture could not release its first claim')
    const reclaimed = await fixture.checkpoints.claim({
      sessionKey: SESSION_KEY,
      checkpointId: fixture.fence.checkpointId,
      version: released,
      hostInstanceId: 'host-instance-other-b2',
      newTaskId: 'task-continuation-other-b2',
      leaseMs: LEASE_MS,
    })
    if (reclaimed.outcome !== 'claimed') {
      throw new Error(`checkpoint fixture re-claim failed: ${reclaimed.outcome}`)
    }
    const llm = provider()
    const run = await runContinuation(fixture, llm)
    await run.executor.run()
    await fixture.handle.persistQueue.drain()

    expect(llm.calls()).toBe(0)
    expect(run.verdict).toHaveBeenCalledWith({ kind: 'lost' })
    expect(run.onFail).toHaveBeenCalledTimes(1)
    expect(run.onFail.mock.calls[0]![1]).toMatchObject({
      code: 'model_step_checkpoint_not_found',
      retryable: false,
      provider: 'openai',
    })
    expect(turnRows(fixture.handle)).toEqual([
      expect.objectContaining({ role: 'user', content: 'Continue the interrupted model step' }),
    ])
  })

  it('4. blocks an exhausted task budget before reopening the turn', async () => {
    const exhausted = budget({ iterationsUsed: 20 })
    const fixture = await claimedCheckpoint({ taskBudget: exhausted })
    const llm = provider()
    const run = await runContinuation(fixture, llm)
    await run.executor.run()
    await fixture.handle.persistQueue.drain()

    expect(llm.calls()).toBe(0)
    expect(run.verdict).toHaveBeenCalledWith({
      kind: 'blocked',
      blockedReason: 'budget_exhausted',
    })
    expect(run.onFail).toHaveBeenCalledTimes(1)
    expect(run.onFail.mock.calls[0]![1]).toMatchObject({
      code: 'model_step_checkpoint_blocked',
      retryable: false,
      provider: 'openai',
    })
    expect(header(fixture.handle)).toMatchObject({
      status: 'blocked',
      version: 4,
      blocked_reason: 'budget_exhausted',
    })
    expect(turnRows(fixture.handle)).toEqual([
      expect.objectContaining({ role: 'user', turn_number: 1 }),
    ])
  })

  it.each([
    ['missing row', 'missing'],
    ['expired row', 'expired'],
    ['row digest mismatch', 'row-digest'],
    ['attachment digest mismatch', 'attachment-digest'],
  ] as const)('5. blocks %s as attachment_expired', async (_name, defect) => {
    const message = sourceMessage({ attachments: [fileAttachment()] })
    const fixture = await claimedCheckpoint({
      message,
      withAttachment: true,
      taskBudget: budget({
        attachmentReadLedger: { reads: 1, spentTokens: 20, bytesRead: UPLOAD.length },
      }),
    })
    if (defect === 'missing') {
      fixture.handle.worker.db
        .prepare('DELETE FROM model_step_checkpoint_attachments WHERE checkpoint_id = ?')
        .run(fixture.fence.checkpointId)
    } else if (defect === 'expired') {
      fixture.handle.worker.db
        .prepare(
          'UPDATE model_step_checkpoint_attachments SET expires_at = ? WHERE checkpoint_id = ?'
        )
        .run(NOW - 1, fixture.fence.checkpointId)
    } else if (defect === 'row-digest') {
      fixture.handle.worker.db
        .prepare('UPDATE model_step_checkpoint_attachments SET bytes = ? WHERE checkpoint_id = ?')
        .run(Buffer.from('tampered bytes'), fixture.fence.checkpointId)
    }
    const llm = provider()
    const run = await runContinuation(
      defect === 'attachment-digest'
        ? {
            ...fixture,
            message: sourceMessage({
              attachments: [fileAttachment('0'.repeat(32))],
            }),
          }
        : fixture,
      llm
    )
    await run.executor.run()
    await fixture.handle.persistQueue.drain()

    expect(llm.calls()).toBe(0)
    expect(run.verdict).toHaveBeenCalledWith({
      kind: 'blocked',
      blockedReason: 'attachment_expired',
    })
    expect(run.onFail).toHaveBeenCalledTimes(1)
    expect(header(fixture.handle)).toMatchObject({
      status: 'blocked',
      version: 4,
      blocked_reason: 'attachment_expired',
    })
  })

  it('5. restores valid bytes and lets the model read them during the continuation', async () => {
    const message = sourceMessage({ attachments: [fileAttachment()] })
    const fixture = await claimedCheckpoint({
      message,
      withAttachment: true,
      entries: [
        {
          kind: 'message' as const,
          toolCallId: null,
          payload: JSON.stringify({
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'old-read', name: 'clerum__attachment_read', arguments: {} }],
          }),
        },
        {
          kind: 'tool_dispatch' as const,
          toolCallId: 'old-read',
          payload: '{"name":"clerum__attachment_read"}',
        },
        {
          kind: 'tool_result' as const,
          toolCallId: 'old-read',
          payload: '{"name":"clerum__attachment_read","isError":false}',
        },
        {
          kind: 'message' as const,
          toolCallId: 'old-read',
          payload: JSON.stringify({
            role: 'tool',
            tool_call_id: 'old-read',
            name: 'clerum__attachment_read',
            content: 'old confirmed attachment result',
          }),
        },
      ],
      confirmedResults: 1,
      taskBudget: budget({
        iterationsUsed: 1,
        attachmentReadLedger: { reads: 1, spentTokens: 20, bytesRead: UPLOAD.length },
      }),
    })
    const events = new SimpleEventEmitter()
    const toolNames = toolCallNames(events)
    const llm = provider(undefined, messages => {
      if (
        messages.some(message => message.role === 'tool' && message.tool_call_id === 'new-read')
      ) {
        return { content: 'read the restored file' }
      }
      return {
        calls: [
          {
            id: 'new-read',
            name: 'clerum__attachment_read',
            arguments: { attachmentId: 'file-b2' },
          },
        ],
      }
    })
    const run = await runContinuation(fixture, llm, { events })
    await run.executor.run()
    await fixture.handle.persistQueue.drain()

    expect(toolNames).toEqual(['clerum__attachment_read'])
    expect(llm.calls()).toBe(2)
    expect(
      llm.requests[1]!.some(message => message.content?.includes('SENTINEL-1043-continuation'))
    ).toBe(true)
    expect(fixture.message.attachments![0]!.dataBase64).toBe(UPLOAD.toString('base64'))
    expect(header(fixture.handle)).toMatchObject({ status: 'completed', version: 4 })
  })

  it.each([
    ['transient', new GfscHttpError(503, 'unavailable'), undefined, true],
    ['invalid', new GfscHttpError(400, 'bad reference'), undefined, false],
    ['contract', new GfscHttpError(418, 'unexpected'), undefined, false],
    ['credentials', undefined, 'credentials_failed', false],
  ] as const)(
    '6. releases a claimed checkpoint and fails admission-style on %s',
    async (failure, error, gateStatus, retryable) => {
      const reference = gfsReference()
      const message = sourceMessage({
        attachments: [fileAttachment()],
        fileReferenceResolutions: [{ availability: 'available', reference }],
      })
      const fixture = await claimedCheckpoint({ message, withAttachment: true })
      const gate = vi.fn<() => FileReferenceGfsAccess>(() =>
        gateStatus === 'credentials_failed'
          ? { status: 'credentials_failed', errorClass: 'TokenReadError' }
          : {
              status: 'available',
              client: {
                resolve: vi.fn(async () => {
                  throw error
                }),
              },
            }
      )
      const llm = provider()
      const run = await runContinuation(fixture, llm, {
        deps: {
          modelStepCheckpoints: {
            store: fixture.checkpoints,
            hostInstanceId: 'host-instance-b2',
            hostId: 'host-a',
            resumableTtlMs: RESUMABLE_TTL_MS,
            claimLeaseMs: LEASE_MS,
            pendingApprovalTtlMs: RESUMABLE_TTL_MS,
            attachmentTtlMs: ATTACHMENT_TTL_MS,
            fileReferenceGfsGate: gate,
            gfsSurfaceRuntimeCapability: () => ({
              workspaceFile: true,
              localExecutor: true,
              visual: false,
            }),
          },
        },
      })
      await run.executor.run()
      await fixture.handle.persistQueue.drain()

      expect(gate).toHaveBeenCalledTimes(1)
      expect(llm.calls()).toBe(0)
      expect(run.verdict).toHaveBeenCalledTimes(1)
      expect(run.verdict).toHaveBeenCalledWith({ kind: 'reference_check_failed' })
      expect(run.onFail).toHaveBeenCalledTimes(1)
      expect(run.onFail.mock.calls[0]![1]).toEqual(fileReferenceCheckError(failure, 'openai'))
      expect(run.onFail.mock.calls[0]![1].retryable).toBe(retryable)
      expect(header(fixture.handle)).toMatchObject({ status: 'resumable', version: 4 })
      expect(
        fixture.handle.worker.db
          .prepare('SELECT COUNT(*) AS n FROM model_step_checkpoint_attachments')
          .get()
      ).toMatchObject({ n: 1 })
    }
  )

  it('6. blocks when an available reference became unavailable', async () => {
    const reference = gfsReference()
    const message = sourceMessage({
      fileReferenceResolutions: [{ availability: 'available', reference }],
    })
    const fixture = await claimedCheckpoint({ message })
    const resolve = vi.fn<FileReferenceGfscClient['resolve']>(async () => {
      throw new GfscHttpError(403, 'denied')
    })
    const llm = provider()
    const run = await runContinuation(fixture, llm, {
      deps: {
        modelStepCheckpoints: {
          store: fixture.checkpoints,
          hostInstanceId: 'host-instance-b2',
          hostId: 'host-a',
          resumableTtlMs: RESUMABLE_TTL_MS,
          claimLeaseMs: LEASE_MS,
          pendingApprovalTtlMs: RESUMABLE_TTL_MS,
          attachmentTtlMs: ATTACHMENT_TTL_MS,
          fileReferenceGfsGate: () => ({ status: 'available', client: { resolve } }),
          gfsSurfaceRuntimeCapability: () => ({
            workspaceFile: false,
            localExecutor: false,
            visual: false,
          }),
        },
      },
    })
    await run.executor.run()
    await fixture.handle.persistQueue.drain()

    expect(resolve).toHaveBeenCalledTimes(1)
    expect(llm.calls()).toBe(0)
    expect(run.verdict).toHaveBeenCalledWith({
      kind: 'blocked',
      blockedReason: 'reference_unavailable',
    })
    expect(run.onFail).toHaveBeenCalledTimes(1)
    expect(run.onFail.mock.calls[0]![1]).toMatchObject({
      code: 'model_step_checkpoint_blocked',
      provider: 'openai',
    })
    expect(header(fixture.handle)).toMatchObject({
      status: 'blocked',
      version: 4,
      blocked_reason: 'reference_unavailable',
    })
  })

  it('6. resolves references again and sends the new availability to the model', async () => {
    const reference = gfsReference()
    const message = sourceMessage({
      fileReferenceResolutions: [{ availability: 'stale', reference, resolvedVersion: 3 }],
    })
    const fixture = await claimedCheckpoint({ message })
    const resolve = vi.fn<FileReferenceGfscClient['resolve']>(async () => gfsView())
    const llm = provider()
    const run = await runContinuation(fixture, llm, {
      deps: {
        modelStepCheckpoints: {
          store: fixture.checkpoints,
          hostInstanceId: 'host-instance-b2',
          hostId: 'host-a',
          resumableTtlMs: RESUMABLE_TTL_MS,
          claimLeaseMs: LEASE_MS,
          pendingApprovalTtlMs: RESUMABLE_TTL_MS,
          attachmentTtlMs: ATTACHMENT_TTL_MS,
          fileReferenceGfsGate: () => ({ status: 'available', client: { resolve } }),
          gfsSurfaceRuntimeCapability: () => ({
            workspaceFile: true,
            localExecutor: true,
            visual: false,
          }),
        },
      },
    })
    await run.executor.run()
    await fixture.handle.persistQueue.drain()

    expect(resolve).toHaveBeenCalledTimes(1)
    expect(message.fileReferenceResolutions).toEqual([
      expect.objectContaining({ availability: 'available', reference }),
    ])
    expect(llm.calls()).toBe(1)
    const serializedRequest = JSON.stringify(llm.requests[0])
    expect(serializedRequest).toContain(reference.id)
    expect(serializedRequest).toContain('availability=available')
    expect(header(fixture.handle)).toMatchObject({ status: 'completed', version: 4 })
  })

  it('6. replaces the recorded origin turn-context block instead of replaying it', async () => {
    const reference = gfsReference()
    const staleResolutions = [{ availability: 'stale' as const, reference, resolvedVersion: 3 }]
    const message = sourceMessage({ fileReferenceResolutions: staleResolutions })
    const originDate = new Date('2020-01-02T03:04:05.000Z')
    const originBlock = buildTurnContextBlock({
      date: originDate,
      channel: { type: 'rpc', sender: USER },
      referencedFiles: referencedFilesForTurnContext(staleResolutions),
    })
    expect(originBlock).toContain('availability=stale')
    const fixture = await claimedCheckpoint({
      message,
      recordedUserContent: originBlock + message.content,
    })
    const resolve = vi.fn<FileReferenceGfscClient['resolve']>(async () => gfsView())
    const llm = provider()
    const run = await runContinuation(fixture, llm, {
      deps: {
        modelStepCheckpoints: {
          store: fixture.checkpoints,
          hostInstanceId: 'host-instance-b2',
          hostId: 'host-a',
          resumableTtlMs: RESUMABLE_TTL_MS,
          claimLeaseMs: LEASE_MS,
          pendingApprovalTtlMs: RESUMABLE_TTL_MS,
          attachmentTtlMs: ATTACHMENT_TTL_MS,
          fileReferenceGfsGate: () => ({ status: 'available', client: { resolve } }),
          gfsSurfaceRuntimeCapability: () => ({
            workspaceFile: true,
            localExecutor: true,
            visual: false,
          }),
        },
      },
    })
    await run.executor.run()
    await fixture.handle.persistQueue.drain()

    expect(resolve).toHaveBeenCalledTimes(1)
    expect(llm.calls()).toBe(1)
    const userMessages = llm.requests[0]!.filter(m => m.role === 'user')
    expect(userMessages).toHaveLength(1)
    const sent = userMessages[0]!.content
    // Exactly one block, built by the continuation from its own resolutions.
    expect(sent.split('<turn-context>')).toHaveLength(2)
    expect(sent).toContain('availability=available')
    expect(sent).not.toContain('availability=stale')
    expect(sent).not.toContain(originDate.toISOString())
    expect(sent.endsWith(`</turn-context>\n\n${message.content}`)).toBe(true)
    expect(header(fixture.handle)).toMatchObject({ status: 'completed', version: 4 })
  })

  it('6a. preserves a user-pasted context fence when the origin added no block', async () => {
    appConfig.promptCacheEnabled = false
    const block = buildTurnContextBlock({
      date: new Date('2020-01-02T03:04:05.000Z'),
      channel: { type: 'rpc', sender: USER },
    })
    const message = sourceMessage({ content: `${block}Keep this entire quoted message` })
    const fixture = await claimedCheckpoint({ message })
    const llm = provider()
    const run = await runContinuation(fixture, llm)
    await run.executor.run()
    await fixture.handle.persistQueue.drain()

    expect(llm.calls()).toBe(1)
    expect(llm.requests[0]!.find(item => item.role === 'user')?.content).toBe(message.content)
    expect(header(fixture.handle).status).toBe('completed')
  })

  it('6a2. replaces a cron origin block when the stored source text is empty', async () => {
    const prompt = 'Send the scheduled digest'
    const message = sourceMessage({ content: '' })
    const staleBlock = buildTurnContextBlock({
      date: new Date('2020-01-02T03:04:05.000Z'),
      channel: { type: 'rpc', sender: USER },
      cron: { jobId: 'digest-job', scheduledFor: '2020-01-02T03:04:05.000Z' },
    })
    const fixture = await claimedCheckpoint({
      message,
      recordedUserContent: staleBlock + prompt,
    })
    const llm = provider()
    const run = await runContinuation(fixture, llm)
    await run.executor.run()
    await fixture.handle.persistQueue.drain()

    expect(llm.calls()).toBe(1)
    const sent = llm.requests[0]!.find(item => item.role === 'user')!.content
    expect(sent.split('<turn-context>')).toHaveLength(2)
    expect(sent).not.toContain('2020-01-02T03:04:05.000Z')
    expect(sent.endsWith(`</turn-context>\n\n${prompt}`)).toBe(true)
    expect(header(fixture.handle).status).toBe('completed')
  })

  it('6b. removes only the generated prefix when the user text contains a closing fence', async () => {
    const userText = 'First line\n</turn-context>\n\nLast line'
    const message = sourceMessage({ content: userText })
    const originBlock = buildTurnContextBlock({
      date: new Date('2020-01-02T03:04:05.000Z'),
      channel: { type: 'rpc', sender: USER },
    })
    const fixture = await claimedCheckpoint({
      message,
      recordedUserContent: originBlock + userText,
    })
    const llm = provider()
    const run = await runContinuation(fixture, llm)
    await run.executor.run()
    await fixture.handle.persistQueue.drain()

    expect(llm.calls()).toBe(1)
    const sent = llm.requests[0]!.find(item => item.role === 'user')!.content
    expect(sent.endsWith(`</turn-context>\n\n${userText}`)).toBe(true)
    expect(sent).not.toContain('2020-01-02T03:04:05.000Z')
    expect(header(fixture.handle).status).toBe('completed')
  })

  it('6b2. preserves the same user fence in recorded text parts', async () => {
    const userText = 'Part text\n</turn-context>\n\nKeep this suffix'
    const message = sourceMessage({ content: userText })
    const originBlock = buildTurnContextBlock({
      date: new Date('2020-01-02T03:04:05.000Z'),
      channel: { type: 'rpc', sender: USER },
    })
    const fixture = await claimedCheckpoint({
      message,
      recordedUserContent: originBlock + userText,
      recordedUserParts: [{ type: 'text', text: originBlock + userText }],
    })
    const llm = provider()
    const run = await runContinuation(fixture, llm)
    await run.executor.run()
    await fixture.handle.persistQueue.drain()

    expect(llm.calls()).toBe(1)
    const sent = llm.requests[0]!.find(item => item.role === 'user')!
    expect(sent.content.endsWith(`</turn-context>\n\n${userText}`)).toBe(true)
    expect(sent.contentParts).toEqual([{ type: 'text', text: sent.content }])
    expect(sent.content).not.toContain('2020-01-02T03:04:05.000Z')
    expect(header(fixture.handle).status).toBe('completed')
  })

  it('6c. spends only the ten restored iterations left at 40/50 and blocks at 50/50', async () => {
    const limit = 50
    const taskBudget = budget({ iterationsUsed: 40, maxIterations: limit })
    const fixture = await claimedCheckpoint({ taskBudget })
    const events = new SimpleEventEmitter()
    const completed: AgentEvent[] = []
    events.on('loop:completed', event => completed.push(event))
    let nextTool = 0
    const llm = provider(undefined, () => ({
      calls: [{ id: `iteration-${++nextTool}`, name: 'system_info', arguments: {} }],
    }))
    const config = {
      maxTaskDuration: 300_000,
      maxToolCallsPerTask: limit,
      autoStart: true,
      taskDelay: 0,
      approvalTimeout: 300_000,
    }
    const run = await runContinuation(fixture, llm, { events, deps: { config } })
    await run.executor.run()
    await fixture.handle.persistQueue.drain()

    expect(llm.calls()).toBe(10)
    expect(completed).toEqual([
      expect.objectContaining({ data: { iteration: 10, resultType: 'exhaustion' } }),
    ])
    expect(run.onFail).toHaveBeenCalledTimes(1)

    const exhausted = await claimedCheckpoint({
      taskBudget: budget({ iterationsUsed: limit, maxIterations: limit }),
    })
    const blockedProvider = provider()
    const blocked = await runContinuation(exhausted, blockedProvider, { deps: { config } })
    await blocked.executor.run()
    await exhausted.handle.persistQueue.drain()

    expect(blockedProvider.calls()).toBe(0)
    expect(blocked.verdict).toHaveBeenCalledWith({
      kind: 'blocked',
      blockedReason: 'budget_exhausted',
    })
    expect(header(exhausted.handle).status).toBe('blocked')
  })

  it('7. blocks when a recorded tool grant is no longer present', async () => {
    const entries = [
      {
        kind: 'message' as const,
        toolCallId: null,
        payload: JSON.stringify({
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'revoked-1', name: 'no_such_recorded_tool', arguments: {} }],
        }),
      },
    ]
    const fixture = await claimedCheckpoint({ entries })
    const llm = provider()
    const run = await runContinuation(fixture, llm)
    await run.executor.run()
    await fixture.handle.persistQueue.drain()

    expect(llm.calls()).toBe(0)
    expect(run.verdict).toHaveBeenCalledWith({ kind: 'blocked', blockedReason: 'grant_revoked' })
    expect(run.onFail).toHaveBeenCalledTimes(1)
    expect(header(fixture.handle)).toMatchObject({
      status: 'blocked',
      version: 4,
      blocked_reason: 'grant_revoked',
    })
  })

  it('8. records a new confirmed result and leaves a second outage resumable', async () => {
    const entries = [
      {
        kind: 'message' as const,
        toolCallId: null,
        payload: JSON.stringify({
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'confirmed-1', name: 'system_info', arguments: {} }],
        }),
      },
      {
        kind: 'tool_dispatch' as const,
        toolCallId: 'confirmed-1',
        payload: '{"name":"system_info"}',
      },
      {
        kind: 'tool_result' as const,
        toolCallId: 'confirmed-1',
        payload: '{"name":"system_info","isError":false}',
      },
      {
        kind: 'message' as const,
        toolCallId: 'confirmed-1',
        payload: JSON.stringify({
          role: 'tool',
          tool_call_id: 'confirmed-1',
          name: 'system_info',
          content: 'old confirmed result',
        }),
      },
    ]
    const fixture = await claimedCheckpoint({ entries, confirmedResults: 1 })
    const events = new SimpleEventEmitter()
    const toolNames = toolCallNames(events)
    const llm = provider(undefined, messages => {
      if (
        messages.some(
          message => message.role === 'tool' && message.tool_call_id === 'new-confirmed-1'
        )
      ) {
        return { error: new Error('upstream 503') }
      }
      return {
        calls: [{ id: 'new-confirmed-1', name: 'system_info', arguments: {} }],
      }
    })
    const run = await runContinuation(fixture, llm, { events })
    await run.executor.run()
    await fixture.handle.persistQueue.drain()

    expect(toolNames).toEqual(['system_info'])
    expect(llm.calls()).toBe(2)
    expect(run.onFail).toHaveBeenCalledTimes(1)
    expect(run.onFail.mock.calls[0]![1]).toMatchObject({
      code: LlmErrorCode.ModelOverloaded,
      providerCode: 'provider_unavailable',
      modelStepCheckpointId: 'checkpoint-b2',
    })
    expect(header(fixture.handle)).toMatchObject({ status: 'resumable', version: 4 })
    const ledger = checkpointEntries(fixture.handle)
    expect(ledger.filter(entry => entry.kind === 'tool_result')).toHaveLength(2)
    expect(ledger).toContainEqual({ kind: 'tool_result', tool_call_id: 'new-confirmed-1' })
  })

  it('9. abandons and cancels the reopened turn after abort', async () => {
    const fixture = await claimedCheckpoint({})
    const llm = provider(undefined, () => new Promise(() => {}))
    const run = await runContinuation(fixture, llm)
    const execution = run.executor.run()
    const started = vi.waitFor(() => {
      expect(run.verdict).toHaveBeenCalledWith({ kind: 'started' })
    })
    await started
    run.executor.abort()
    await execution
    await fixture.handle.persistQueue.drain()

    expect(llm.calls()).toBe(1)
    expect(header(fixture.handle)).toMatchObject({ status: 'abandoned', version: 4 })
    expect(turnRows(fixture.handle)).toEqual([
      expect.objectContaining({ role: 'user', turn_number: 1 }),
      expect.objectContaining({
        role: 'assistant',
        content: '[Task cancelled by user before completion]',
        turn_number: 1,
        model_step_checkpoint_id: null,
      }),
    ])
  })

  it('9a. a stale cancelled continuation leaves the turn for its replacement', async () => {
    const fixture = await claimedCheckpoint({})
    const stale = provider(undefined, () => new Promise(() => {}))
    const staleRun = await runContinuation(fixture, stale)
    const staleExecution = staleRun.executor.run()
    await vi.waitFor(() => {
      expect(staleRun.verdict).toHaveBeenCalledWith({ kind: 'started' })
      expect(stale.calls()).toBe(1)
    })
    const replacementFence = await expireAndReclaimFixture(fixture, 'task-continuation-replacement')
    const replacement = provider(undefined, () => ({ content: 'replacement final answer' }))
    const replacementRun = await runContinuation(fixture, replacement, {
      taskId: 'task-continuation-replacement',
      fence: replacementFence,
    })

    staleRun.executor.abort()
    await staleExecution
    await fixture.handle.persistQueue.drain()

    expect(stale.calls()).toBe(1)
    expect(header(fixture.handle)).toMatchObject({ status: 'claimed', version: 4 })
    expect(turnRows(fixture.handle)).toEqual([
      expect.objectContaining({ role: 'user', turn_number: 1 }),
    ])
    expect(
      fixture.handle.worker.db
        .prepare(
          `SELECT state, active_task_id FROM sessions WHERE session_key = ?
           UNION ALL SELECT status, continuation_task_id FROM model_step_checkpoints WHERE checkpoint_id = ?`
        )
        .all(SESSION_KEY, 'checkpoint-b2')
    ).toEqual([
      { state: 'processing', active_task_id: 'task-continuation-b2' },
      { state: 'claimed', active_task_id: 'task-continuation-replacement' },
    ])
    expect(fixture.manager.getSessionByKey(SESSION_KEY)).toMatchObject({
      state: 'processing',
      activeTaskId: 'task-continuation-b2',
    })

    await replacementRun.executor.run()
    await fixture.handle.persistQueue.drain()

    expect(replacement.calls()).toBe(1)
    expect(replacementRun.onComplete).toHaveBeenCalledTimes(1)
    expect(header(fixture.handle)).toMatchObject({ status: 'completed', version: 5 })
    expect(turnRows(fixture.handle)).toEqual([
      expect.objectContaining({ role: 'user', turn_number: 1 }),
      expect.objectContaining({
        role: 'assistant',
        content: 'replacement final answer',
        turn_number: 1,
        model_step_checkpoint_id: 'checkpoint-b2',
      }),
    ])
  })

  it('9b. rejected stale completion rolls back RAM and lets the replacement finish', async () => {
    const fixture = await claimedCheckpoint({})
    const originalPersistComplete = fixture.handle.store.persistTurnComplete.bind(
      fixture.handle.store
    )
    let enterPersistGate!: () => void
    let releasePersistGate!: () => void
    const persistGate = new Promise<void>(resolve => {
      releasePersistGate = resolve
    })
    const persistEntered = new Promise<void>(resolve => {
      enterPersistGate = resolve
    })
    fixture.handle.store.persistTurnComplete = async (conversation, response, options) => {
      enterPersistGate()
      await persistGate
      return originalPersistComplete(conversation, response, options)
    }

    let resolveStaleProvider!: (value: {}) => void
    const stale = provider(
      undefined,
      () =>
        new Promise<{}>(resolve => {
          resolveStaleProvider = resolve
        })
    )
    const staleRun = await runContinuation(fixture, stale)
    const staleExecution = staleRun.executor.run()
    await vi.waitFor(() => {
      expect(staleRun.verdict).toHaveBeenCalledWith({ kind: 'started' })
      expect(stale.calls()).toBe(1)
    })
    resolveStaleProvider({})
    await persistEntered
    const replacementFence = await expireAndReclaimFixture(fixture, 'task-continuation-replacement')
    releasePersistGate()
    await staleExecution
    await fixture.handle.persistQueue.drain()

    expect(staleRun.onComplete).toHaveBeenCalledTimes(0)
    expect(turnRows(fixture.handle)).toEqual([
      expect.objectContaining({ role: 'user', turn_number: 1 }),
    ])

    const replacement = provider(undefined, () => ({ content: 'winner final answer' }))
    const replacementRun = await runContinuation(fixture, replacement, {
      taskId: 'task-continuation-replacement',
      fence: replacementFence,
    })
    await replacementRun.executor.run()
    await fixture.handle.persistQueue.drain()

    expect(replacementRun.onComplete).toHaveBeenCalledTimes(1)
    expect(header(fixture.handle)).toMatchObject({ status: 'completed', version: 5 })
    expect(turnRows(fixture.handle)).toEqual([
      expect.objectContaining({ role: 'user', turn_number: 1 }),
      expect.objectContaining({
        role: 'assistant',
        content: 'winner final answer',
        turn_number: 1,
        model_step_checkpoint_id: 'checkpoint-b2',
      }),
    ])
  })

  it('9. abandons and fails the reopened turn after a non-abort error', async () => {
    const fixture = await claimedCheckpoint({})
    const llm = provider(undefined, () => ({ error: new Error('model transport failed') }))
    const run = await runContinuation(fixture, llm)
    await run.executor.run()
    await fixture.handle.persistQueue.drain()

    expect(llm.calls()).toBe(1)
    expect(run.onFail).toHaveBeenCalledTimes(1)
    expect(run.onFail.mock.calls[0]![1]).toMatchObject({
      code: LlmErrorCode.ApiCallFailed,
      retryable: false,
    })
    expect(header(fixture.handle)).toMatchObject({ status: 'abandoned', version: 4 })
    expect(turnRows(fixture.handle)).toEqual([
      expect.objectContaining({ role: 'user', turn_number: 1 }),
    ])
  })

  it('10. ends a reopened turn with the limit message and abandons the checkpoint', async () => {
    const fixture = await claimedCheckpoint({ taskBudget: budget({ durationMs: 100 }) })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    let enteredProvider!: () => void
    const providerEntered = new Promise<void>(resolve => {
      enteredProvider = resolve
    })
    const llm = provider(undefined, () => {
      enteredProvider()
      return new Promise(resolve => setTimeout(() => resolve({}), 250))
    })
    const run = await runContinuation(fixture, llm)
    const execution = run.executor.run()
    await providerEntered
    expect(llm.calls()).toBe(1)
    await vi.advanceTimersByTimeAsync(101)
    await execution
    await fixture.handle.persistQueue.drain()

    expect(llm.calls()).toBe(1)
    expect(run.onFail).toHaveBeenCalledTimes(1)
    expect(run.onFail.mock.calls[0]![1].code).toBe('TASK_DURATION_LIMIT')
    expect(header(fixture.handle)).toMatchObject({ status: 'abandoned', version: 4 })
    expect(turnRows(fixture.handle)).toEqual([
      expect.objectContaining({ role: 'user', turn_number: 1 }),
      expect.objectContaining({
        role: 'assistant',
        content: expect.stringContaining('active execution reached 100ms'),
        turn_number: 1,
        model_step_checkpoint_id: null,
      }),
    ])
  })

  it('10b. expires during preparation before provider entry', async () => {
    const fixture = await claimedCheckpoint({ taskBudget: budget({ durationMs: 100 }) })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    let enterPreparation!: () => void
    let releasePreparation!: () => void
    const preparationEntered = new Promise<void>(resolve => {
      enterPreparation = resolve
    })
    const preparationGate = new Promise<void>(resolve => {
      releasePreparation = resolve
    })
    const getOrCreate = fixture.manager.getOrCreate.bind(fixture.manager)
    fixture.manager.getOrCreate = async (...args) => {
      enterPreparation()
      await preparationGate
      return getOrCreate(...args)
    }
    const llm = provider(undefined, () => ({ content: 'would have answered' }))
    const run = await runContinuation(fixture, llm)
    const execution = run.executor.run()
    await preparationEntered
    await vi.advanceTimersByTimeAsync(101)
    releasePreparation()
    await execution
    await fixture.handle.persistQueue.drain()

    expect(run.onFail).toHaveBeenCalledTimes(1)
    expect(run.onFail.mock.calls[0]![1].code).toBe('TASK_DURATION_LIMIT')
    expect(llm.calls()).toBe(0)
    expect(header(fixture.handle).status).toBe('abandoned')
  })

  it('11. approval keeps the claim and records the approved result before completion', async () => {
    Object.assign(appConfig, { enableApproval: true })
    const fixture = await claimedCheckpoint({})
    const llm = provider(undefined, messages => {
      if (messages.some(message => message.role === 'tool')) {
        return { content: 'approved continuation final answer' }
      }
      return {
        calls: [
          {
            id: 'approval-1',
            name: 'shell_exec',
            arguments: { command: 'printf approval-boundary' },
          },
        ],
      }
    })
    const run = await runContinuation(fixture, llm, {
      deps: {
        approvalConfig: {
          defaultPolicy: 'channel_users',
          channels: {},
          tools: { shell_exec: true },
        },
      },
    })
    await run.executor.run()
    expect(run.onApprovalNeeded).toHaveBeenCalledTimes(1)
    expect(run.executor.executorState).toBe('waiting_approval')
    expect(header(fixture.handle)).toMatchObject({ status: 'claimed', version: 3 })

    await run.executor.resumeAfterApproval(true)
    await fixture.handle.persistQueue.drain()

    expect(llm.calls()).toBe(2)
    expect(run.onComplete).toHaveBeenCalledTimes(1)
    expect(header(fixture.handle)).toMatchObject({ status: 'completed', version: 4 })
    expect(
      fixture.handle.worker.db
        .prepare(
          `SELECT kind, tool_call_id FROM model_step_checkpoint_entries
           WHERE checkpoint_id = ? AND tool_call_id = ?
             AND kind IN ('tool_dispatch', 'tool_result') ORDER BY seq`
        )
        .all('checkpoint-b2', 'approval-1')
    ).toEqual([
      { kind: 'tool_dispatch', tool_call_id: 'approval-1' },
      { kind: 'tool_result', tool_call_id: 'approval-1' },
    ])
    expect(turnRows(fixture.handle)).toEqual([
      expect.objectContaining({ role: 'user', turn_number: 1 }),
      expect.objectContaining({
        role: 'assistant',
        content: 'approved continuation final answer',
        turn_number: 1,
        model_step_checkpoint_id: 'checkpoint-b2',
      }),
    ])
  })

  it('11b. a provider outage after approval retries without executing the approved tool again', async () => {
    Object.assign(appConfig, { enableApproval: true })
    const fixture = await claimedCheckpoint({})
    const llm = provider(undefined, messages =>
      messages.some(message => message.role === 'tool')
        ? { error: new Error('upstream 503') }
        : {
            calls: [
              {
                id: 'approval-retry',
                name: 'shell_exec',
                arguments: { command: 'printf approved-once' },
              },
            ],
          }
    )
    const first = await runContinuation(fixture, llm, {
      deps: {
        approvalConfig: {
          defaultPolicy: 'channel_users',
          channels: {},
          tools: { shell_exec: true },
        },
      },
    })
    await first.executor.run()
    expect(header(fixture.handle)).toMatchObject({ status: 'claimed', version: 3 })
    await first.executor.resumeAfterApproval(true)
    expect(first.onFail).toHaveBeenCalledTimes(1)
    expect(header(fixture.handle)).toMatchObject({ status: 'resumable', version: 4 })

    const retryClaim = await fixture.checkpoints.claim({
      sessionKey: SESSION_KEY,
      checkpointId: 'checkpoint-b2',
      version: 4,
      hostInstanceId: 'host-instance-retry',
      newTaskId: 'task-retry',
      leaseMs: LEASE_MS,
    })
    if (retryClaim.outcome !== 'claimed') {
      throw new Error(`Retry claim failed: ${retryClaim.outcome}`)
    }
    expect(retryClaim.snapshot.tools.confirmed).toBe(1)
    fixture.taskBudget = retryClaim.snapshot.header.task_budget!
    fixture.confirmedResults = retryClaim.snapshot.tools.confirmed
    const retryProvider = provider(undefined, () => ({ content: 'retry final answer' }))
    const retry = await runContinuation(fixture, retryProvider, {
      taskId: 'task-retry',
      fence: retryClaim.fence,
    })
    await retry.executor.run()
    await fixture.handle.persistQueue.drain()

    expect(retry.onComplete).toHaveBeenCalledTimes(1)
    expect(retryProvider.calls()).toBe(1)
    expect(retryProvider.requests[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'tool', tool_call_id: 'approval-retry' }),
      ])
    )
    expect(
      fixture.handle.worker.db
        .prepare(
          `SELECT kind FROM model_step_checkpoint_entries
           WHERE checkpoint_id = ? AND tool_call_id = ? AND kind = 'tool_dispatch'`
        )
        .all('checkpoint-b2', 'approval-retry')
    ).toHaveLength(1)
    expect(header(fixture.handle)).toMatchObject({ status: 'completed', version: 6 })
  })

  it('11b2. a poisoned approval with a failed abandon stops its lease without releasing the claim', async () => {
    Object.assign(appConfig, { enableApproval: true })
    const fixture = await claimedCheckpoint({})
    const append = vi
      .spyOn(fixture.checkpoints, 'append')
      .mockRejectedValueOnce(new Error('append failed'))
    const transition = fixture.checkpoints.transition.bind(fixture.checkpoints)
    vi.spyOn(fixture.checkpoints, 'transition').mockImplementation((sessionKey, fence, input) => {
      if (input.to === 'abandoned') throw new Error('abandon failed')
      return transition(sessionKey, fence, input)
    })
    const llm = provider(undefined, () => ({
      calls: [
        { id: 'approval-poison', name: 'shell_exec', arguments: { command: 'printf poison' } },
      ],
    }))
    const run = await runContinuation(fixture, llm, {
      deps: {
        approvalConfig: {
          defaultPolicy: 'channel_users',
          channels: {},
          tools: { shell_exec: true },
        },
      },
    })
    await expect(run.executor.run()).rejects.toThrow('abandon failed')
    expect(append).toHaveBeenCalled()
    expect(llm.calls()).toBe(1)
    expect(header(fixture.handle).status).toBe('claimed')
    const internals = run.executor as unknown as {
      continuationClaimReleased: boolean
      continuationLeaseStop: unknown
    }
    expect(internals.continuationClaimReleased).toBe(false)
    expect(internals.continuationLeaseStop).toBeUndefined()

    const healthy = await claimedCheckpoint({})
    const healthyRun = await runContinuation(
      healthy,
      provider(undefined, () => ({
        calls: [{ id: 'approval-live', name: 'shell_exec', arguments: { command: 'printf live' } }],
      })),
      {
        deps: {
          approvalConfig: {
            defaultPolicy: 'channel_users',
            channels: {},
            tools: { shell_exec: true },
          },
        },
      }
    )
    await healthyRun.executor.run()
    expect(healthyRun.executor.executorState).toBe('waiting_approval')
    expect(header(healthy.handle).status).toBe('claimed')
    expect(
      (healthyRun.executor as unknown as { continuationLeaseStop: unknown }).continuationLeaseStop
    ).toBeTypeOf('function')
    await healthyRun.executor.deny()
  })

  it('11c. an approval holds the claim past its short lease until denial releases the session', async () => {
    Object.assign(appConfig, { enableApproval: true })
    const fixture = await claimedCheckpoint({})
    // Approval starts near the checkpoint deadline; its own seven-day TTL
    // extends beyond that deadline.
    clock += 6 * 24 * 3_600_000
    const llm = provider(undefined, () => ({
      calls: [{ id: 'approval-lease', name: 'shell_exec', arguments: { command: 'printf held' } }],
    }))
    const run = await runContinuation(fixture, llm, {
      deps: {
        approvalConfig: {
          defaultPolicy: 'channel_users',
          channels: {},
          tools: { shell_exec: true },
        },
      },
    })
    await run.executor.run()
    clock += 2 * 24 * 3_600_000 + LEASE_MS + 1
    const swept = await fixture.checkpoints.sweep(RESUMABLE_TTL_MS)
    expect(swept.expired).toBe(0)
    const competing = await fixture.checkpoints.claim({
      sessionKey: SESSION_KEY,
      checkpointId: 'checkpoint-b2',
      version: 3,
      hostInstanceId: 'competing-host',
      newTaskId: 'competing-task',
      leaseMs: LEASE_MS,
    })
    expect(competing).toEqual({ outcome: 'replayed', taskId: 'task-continuation-b2' })
    expect(llm.calls()).toBe(1)

    await run.executor.deny()
    await fixture.handle.persistQueue.drain()
    expect(header(fixture.handle)).toMatchObject({ status: 'abandoned', version: 4 })
    expect(
      fixture.handle.worker.db
        .prepare('SELECT COUNT(*) AS count FROM pending_approvals WHERE task_id = ?')
        .get('task-continuation-b2')
    ).toEqual({ count: 0 })
    expect(
      fixture.handle.worker.db
        .prepare('SELECT state, active_task_id FROM sessions WHERE session_key = ?')
        .get(SESSION_KEY)
    ).toEqual({ state: 'idle', active_task_id: null })
    const conversation = fixture.manager.getSessionByKey(SESSION_KEY)!
    await fixture.manager.startTurn(conversation, 'A new request after denial', 'task-after-denial')
    expect(conversation.activeTaskId).toBe('task-after-denial')
  })

  it('11d. a restarted Host adopts the waiting claim and records the approved result', async () => {
    Object.assign(appConfig, { enableApproval: true })
    const fixture = await claimedCheckpoint({})
    const initial = provider(undefined, () => ({
      calls: [{ id: 'approval-cold', name: 'shell_exec', arguments: { command: 'printf cold' } }],
    }))
    const first = await runContinuation(fixture, initial, {
      deps: {
        approvalConfig: {
          defaultPolicy: 'channel_users',
          channels: {},
          tools: { shell_exec: true },
        },
      },
    })
    await first.executor.run()
    const pending = first.executor.pendingApproval!
    expect(pending).toBeDefined()
    expect(await fixture.checkpoints.bootReap('host-instance-cold')).toEqual({
      abandoned: 0,
      reopened: 0,
    })
    const adopted = await fixture.checkpoints.loadLive(SESSION_KEY)
    expect(adopted?.header).toMatchObject({
      status: 'claimed',
      claim_owner: 'host-instance-cold',
      claim_generation: 2,
    })
    fixture.taskBudget = adopted!.header.task_budget!
    fixture.confirmedResults = adopted!.tools.confirmed
    const resumedProvider = provider(undefined, () => ({ content: 'cold approval completed' }))
    const resumed = await runContinuation(fixture, resumedProvider, {
      fence: {
        checkpointId: 'checkpoint-b2',
        owner: 'host-instance-cold',
        generation: 2,
      },
      deps: {
        modelStepCheckpoints: {
          store: fixture.checkpoints,
          hostInstanceId: 'host-instance-cold',
          hostId: 'host-a',
          resumableTtlMs: RESUMABLE_TTL_MS,
          claimLeaseMs: LEASE_MS,
          pendingApprovalTtlMs: RESUMABLE_TTL_MS,
          attachmentTtlMs: ATTACHMENT_TTL_MS,
        },
      },
    })
    await resumed.executor.rehydrateWaitingApproval(SESSION_KEY, pending)
    await resumed.executor.resumeAfterApproval(true)
    expect(resumed.onComplete).toHaveBeenCalledTimes(1)
    expect(resumedProvider.calls()).toBe(1)
    expect(header(fixture.handle)).toMatchObject({ status: 'completed', version: 4 })
    expect(
      fixture.handle.worker.db
        .prepare(
          `SELECT kind FROM model_step_checkpoint_entries
           WHERE checkpoint_id = ? AND tool_call_id = ? AND kind = 'tool_result'`
        )
        .all('checkpoint-b2', 'approval-cold')
    ).toHaveLength(1)
  })

  it('11e. cancelling a suspended continuation releases approval, claim and session', async () => {
    Object.assign(appConfig, { enableApproval: true })
    const fixture = await claimedCheckpoint({})
    const llm = provider(undefined, () => ({
      calls: [
        { id: 'approval-cancel', name: 'shell_exec', arguments: { command: 'printf cancel' } },
      ],
    }))
    const run = await runContinuation(fixture, llm, {
      deps: {
        approvalConfig: {
          defaultPolicy: 'channel_users',
          channels: {},
          tools: { shell_exec: true },
        },
      },
    })
    await run.executor.run()
    expect(run.executor.executorState).toBe('waiting_approval')
    const requestId = run.executor.pendingApproval!.request_id
    fixture.manager.cancelTurnBySessionKey(SESSION_KEY)
    await fixture.manager.clearPendingApproval(SESSION_KEY, requestId)
    run.executor.abort()
    await run.executor.waitForCompletion()
    await fixture.handle.persistQueue.drain()

    expect(header(fixture.handle)).toMatchObject({ status: 'abandoned', version: 4 })
    expect(
      fixture.handle.worker.db
        .prepare('SELECT COUNT(*) AS count FROM pending_approvals WHERE task_id = ?')
        .get('task-continuation-b2')
    ).toEqual({ count: 0 })
    expect(
      fixture.handle.worker.db
        .prepare('SELECT state, active_task_id FROM sessions WHERE session_key = ?')
        .get(SESSION_KEY)
    ).toEqual({ state: 'idle', active_task_id: null })
    const conversation = fixture.manager.getSessionByKey(SESSION_KEY)!
    await fixture.manager.startTurn(
      conversation,
      'A new request after cancellation',
      'task-after-cancel'
    )
    expect(conversation.activeTaskId).toBe('task-after-cancel')
  })

  it('11f. boot expiry reaps the approval and its checkpoint before a new turn', async () => {
    Object.assign(appConfig, { enableApproval: true })
    const fixture = await claimedCheckpoint({})
    const llm = provider(undefined, () => ({
      calls: [
        { id: 'approval-expiry', name: 'shell_exec', arguments: { command: 'printf expiry' } },
      ],
    }))
    const run = await runContinuation(fixture, llm, {
      deps: {
        approvalConfig: {
          defaultPolicy: 'channel_users',
          channels: {},
          tools: { shell_exec: true },
        },
      },
    })
    await run.executor.run()
    expect(run.executor.executorState).toBe('waiting_approval')
    clock += RESUMABLE_TTL_MS + LEASE_MS + 1
    expect(await fixture.checkpoints.bootReap('host-after-expiry')).toEqual({
      abandoned: 0,
      reopened: 1,
    })
    const reaped = await fixture.handle.store.reapExpiredAwaitingApprovalSessions(clock)
    expect(reaped).toHaveLength(1)
    expect(header(fixture.handle)).toMatchObject({ status: 'abandoned', version: 5 })
    expect(
      fixture.handle.worker.db
        .prepare('SELECT COUNT(*) AS count FROM pending_approvals WHERE task_id = ?')
        .get('task-continuation-b2')
    ).toEqual({ count: 0 })
    expect(
      fixture.handle.worker.db
        .prepare('SELECT state, active_task_id FROM sessions WHERE session_key = ?')
        .get(SESSION_KEY)
    ).toEqual({ state: 'idle', active_task_id: null })
    const conversation = await fixture.manager.getOrCreate(SESSION_KEY, {
      userId: USER,
      channelType: 'rpc',
      channelId: AGENT,
      threadId: CHAT,
      source: 'rpc',
    })
    await fixture.manager.startTurn(conversation, 'A new request after expiry', 'task-after-expiry')
    expect(conversation.activeTaskId).toBe('task-after-expiry')
  })

  it('12. keeps the fresh turn-context on the origin user when a later user message exists', async () => {
    const reference = gfsReference()
    const staleResolutions = [{ availability: 'stale' as const, reference, resolvedVersion: 3 }]
    const message = sourceMessage({ fileReferenceResolutions: staleResolutions })
    const originDate = new Date('2020-01-02T03:04:05.000Z')
    const originBlock = buildTurnContextBlock({
      date: originDate,
      channel: { type: 'rpc', sender: USER },
      referencedFiles: referencedFilesForTurnContext(staleResolutions),
    })
    const fixture = await claimedCheckpoint({
      message,
      recordedUserContent: originBlock + message.content,
      entries: [
        {
          kind: 'message',
          toolCallId: null,
          payload: JSON.stringify({ role: 'user', content: 'LOOP-INJECTED-USER' }),
        },
      ],
    })
    const resolve = vi.fn<FileReferenceGfscClient['resolve']>(async () => gfsView())
    const llm = provider()
    const run = await runContinuation(fixture, llm, {
      deps: {
        modelStepCheckpoints: {
          store: fixture.checkpoints,
          hostInstanceId: 'host-instance-b2',
          hostId: 'host-a',
          resumableTtlMs: RESUMABLE_TTL_MS,
          claimLeaseMs: LEASE_MS,
          pendingApprovalTtlMs: RESUMABLE_TTL_MS,
          attachmentTtlMs: ATTACHMENT_TTL_MS,
          fileReferenceGfsGate: () => ({ status: 'available', client: { resolve } }),
          gfsSurfaceRuntimeCapability: () => ({
            workspaceFile: true,
            localExecutor: true,
            visual: false,
          }),
        },
      },
    })
    await run.executor.run()
    await fixture.handle.persistQueue.drain()
    expect(llm.calls()).toBe(1)
    const users = llm.requests[0]!.filter(item => item.role === 'user')
    expect(users.map(item => item.content)).toEqual([
      expect.stringContaining('availability=available'),
      'LOOP-INJECTED-USER',
    ])
    expect(users[1]!.content).not.toContain('<turn-context>')
    expect(users[0]!.content).not.toContain('availability=stale')
    expect(header(fixture.handle)).toMatchObject({ status: 'completed' })
  })

  it('13. blocks a missing checkpoint image while a live image reaches the provider and completes', async () => {
    const missing = await claimedCheckpoint({
      entries: [
        {
          kind: 'message',
          toolCallId: null,
          payload: JSON.stringify({
            role: 'user',
            content: 'image turn',
            contentParts: [
              {
                type: 'checkpoint-image',
                checkpointAttachmentId: 'img-missing',
                checkpointAttachmentExpiresAt: NOW + ATTACHMENT_TTL_MS,
                checkpointAttachmentDigestHex: 'ab'.repeat(32),
                mimeType: 'image/png',
              },
            ],
          }),
        },
      ],
    })
    const blocked = provider()
    const blockedRun = await runContinuation(missing, blocked)
    await blockedRun.executor.run()
    await missing.handle.persistQueue.drain()
    expect(blocked.calls()).toBe(0)
    expect(blockedRun.verdict).toHaveBeenCalledWith({
      kind: 'blocked',
      blockedReason: 'attachment_expired',
    })

    const imageBytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jbi0AAAAASUVORK5CYII=',
      'base64'
    )
    const imageDigest = createHash('sha256').update(imageBytes).digest('hex')
    const imageSource = {
      kind: 'attachment' as const,
      attachmentId: 'img-live',
      messageId: 'message-b2',
    }
    const healthy = await claimedCheckpoint({
      entries: [
        {
          kind: 'message',
          toolCallId: null,
          payload: JSON.stringify({
            role: 'user',
            content: '',
            contentParts: [
              {
                type: 'checkpoint-image',
                checkpointAttachmentId: 'img-live',
                checkpointAttachmentExpiresAt: NOW + ATTACHMENT_TTL_MS,
                checkpointAttachmentDigestHex: imageDigest,
                mimeType: 'image/png',
                width: 1,
                height: 1,
                source: imageSource,
              },
            ],
          }),
        },
      ],
    })
    healthy.handle.worker.db
      .prepare(
        `INSERT INTO model_step_checkpoint_attachments
       (checkpoint_id, attachment_id, digest_hex, size_bytes, bytes, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'checkpoint-b2',
        'img-live',
        imageDigest,
        imageBytes.byteLength,
        imageBytes,
        NOW + ATTACHMENT_TTL_MS,
        NOW
      )
    const llm = provider(undefined, () => ({ content: 'image continuation answer' }))
    const run = await runContinuation(healthy, llm, {
      deps: {
        imageInput: () => ({
          capability: {
            state: 'supported',
            evidence: {
              source: 'curated',
              reference: 'https://example.test/vision-capability',
              checkedAt: new Date(NOW).toISOString(),
            },
          },
        }),
      },
    })
    await run.executor.run()
    await healthy.handle.persistQueue.drain()
    expect(llm.calls()).toBe(1)
    const image = llm.requests[0]!.flatMap(message => message.contentParts ?? []).find(
      part => part.type === 'image'
    )
    expect(image).toMatchObject({
      type: 'image',
      data: imageBytes.toString('base64'),
      mimeType: 'image/png',
      width: 1,
      height: 1,
      source: imageSource,
    })
    expect(image).not.toHaveProperty('checkpointAttachmentId')
    expect(
      healthy.handle.worker.db
        .prepare('SELECT COUNT(*) AS n FROM model_step_checkpoint_attachments')
        .get()
    ).toEqual({ n: 0 })
    expect(header(healthy.handle)).toMatchObject({ status: 'completed' })
    expect(turnRows(healthy.handle)).toEqual([
      expect.objectContaining({ role: 'user', turn_number: 1 }),
      expect.objectContaining({
        role: 'assistant',
        content: 'image continuation answer',
        turn_number: 1,
      }),
    ])
  })

  it('14. keeps a pinned continuation off failover and still completes on the primary', async () => {
    const entries = [
      {
        kind: 'message' as const,
        toolCallId: null,
        payload: JSON.stringify({
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'confirmed-k1', name: 'system_info', arguments: {} }],
        }),
      },
      {
        kind: 'tool_dispatch' as const,
        toolCallId: 'confirmed-k1',
        payload: '{"name":"system_info"}',
      },
      {
        kind: 'tool_result' as const,
        toolCallId: 'confirmed-k1',
        payload: '{"name":"system_info","isError":false}',
      },
      {
        kind: 'message' as const,
        toolCallId: 'confirmed-k1',
        payload: JSON.stringify({
          role: 'tool',
          tool_call_id: 'confirmed-k1',
          name: 'system_info',
          content: 'old confirmed result',
        }),
      },
    ]
    const policy: LlmPolicy = {
      cooldownSeconds: 300,
      triggerOn: ['provider_unavailable'],
      fallbacks: [{ provider: 'fallback', model: 'fallback-model' }],
    }
    const fallback = provider('fallback', () => ({ content: 'fallback answer' }))
    const buildProvider = vi.fn(() => fallback)
    const failover = {
      engine: new FailoverEngine(policy, { metricInc: () => {} }),
      policy,
      buildProvider,
    }
    const fixture = await claimedCheckpoint({ entries, confirmedResults: 1 })
    const outage = provider(undefined, () => ({ error: new Error('upstream 503') }))
    const failed = await runContinuation(fixture, outage, { deps: { failover } })
    await failed.executor.run()
    await fixture.handle.persistQueue.drain()
    expect(buildProvider).not.toHaveBeenCalled()
    expect(fallback.calls()).toBe(0)
    expect(header(fixture.handle)).toMatchObject({ status: 'resumable' })

    const reclaimed = await fixture.checkpoints.claim({
      sessionKey: SESSION_KEY,
      checkpointId: fixture.fence.checkpointId,
      version: header(fixture.handle).version,
      hostInstanceId: 'host-instance-b2',
      newTaskId: 'task-continuation-retry',
      leaseMs: LEASE_MS,
    })
    if (reclaimed.outcome !== 'claimed') throw new Error(reclaimed.outcome)
    const primary = provider(undefined, () => ({ content: 'pinned primary answer' }))
    const retried = await runContinuation(fixture, primary, {
      taskId: 'task-continuation-retry',
      fence: reclaimed.fence,
      deps: { failover },
    })
    await retried.executor.run()
    await fixture.handle.persistQueue.drain()
    expect(buildProvider).not.toHaveBeenCalled()
    expect(primary.calls()).toBe(1)
    expect(header(fixture.handle)).toMatchObject({ status: 'completed' })
    expect(turnRows(fixture.handle)).toContainEqual(
      expect.objectContaining({ role: 'assistant', content: 'pinned primary answer' })
    )

    const plainTask: Task = {
      id: 'task-ordinary-failover',
      source: 'channel',
      sourceMessage: fixture.message,
      traceContext: null,
      priority: 'normal',
      status: 'pending',
      createdAt: new Date(NOW),
      conversationHistory: [],
    }
    const ordinary = new TaskExecutor(plainTask, {
      conversationManager: fixture.manager,
      llmProvider: outage,
      mcpManager: new McpManager(),
      workspaceService: undefined,
      approvalConfig: undefined,
      modelName: 'checkpoint-model',
      contextWindowTokens: 100_000,
      config: {
        maxTaskDuration: 300_000,
        maxToolCallsPerTask: 20,
        autoStart: true,
        taskDelay: 0,
        approvalTimeout: 300_000,
      },
      coreEvents: new SimpleEventEmitter(),
      cronScheduler: null,
      taskLifecycle: new TaskLifecycle(),
      onApprovalNeeded: vi.fn(),
      onComplete: vi.fn(),
      onFail: vi.fn(),
      dynamicEnvProvider: () => ({}),
      failover,
    })
    const wrapped = (
      ordinary as unknown as {
        wrapFailoverPort: (
          port: LlmPortAdapter,
          conversation: unknown
        ) => { completeWithTools: (request: unknown) => Promise<unknown> }
      }
    ).wrapFailoverPort(
      new LlmPortAdapter(outage, 'checkpoint-model', 'openai'),
      fixture.manager.getSessionByKey(SESSION_KEY)
    )
    await wrapped.completeWithTools({
      messages: [{ role: 'user', content: 'ordinary failover' }],
      tools: [],
    })
    expect(buildProvider).toHaveBeenCalledTimes(1)
    expect(fallback.calls()).toBe(1)
  })

  it('15. a rejected response completion abandons the owned checkpoint and a later turn can finish', async () => {
    const fixture = await claimedCheckpoint({})
    const originalPersistComplete = fixture.handle.store.persistTurnComplete.bind(
      fixture.handle.store
    )
    let completions = 0
    fixture.handle.store.persistTurnComplete = async (conversation, response, options) => {
      completions += 1
      if (completions === 1) throw new Error('durable completion rejected')
      return originalPersistComplete(conversation, response, options)
    }
    const llm = provider(undefined, () => ({ content: 'false response' }))
    const run = await runContinuation(fixture, llm)
    await run.executor.run()
    await fixture.handle.persistQueue.drain()

    expect(run.onComplete).not.toHaveBeenCalled()
    expect(header(fixture.handle)).toMatchObject({ status: 'abandoned' })
    expect(turnRows(fixture.handle).map(row => row.content)).not.toContain('false response')
    expect(turnRows(fixture.handle)).toEqual([
      expect.objectContaining({ role: 'user', content: fixture.message.content, turn_number: 1 }),
    ])

    const conversation = fixture.manager.getSessionByKey(SESSION_KEY)
    if (!conversation) throw new Error('continuation conversation is missing')
    await fixture.manager.startTurn(conversation, 'next question', 'task-next')
    await fixture.manager.completeTurn(conversation, 'next answer')
    await fixture.handle.persistQueue.drain()

    expect(turnRows(fixture.handle).map(row => row.content)).not.toContain('false response')
    expect(turnRows(fixture.handle)).toEqual([
      expect.objectContaining({ role: 'user', content: fixture.message.content, turn_number: 1 }),
      expect.objectContaining({ role: 'user', content: 'next question', turn_number: 2 }),
      expect.objectContaining({ role: 'assistant', content: 'next answer', turn_number: 2 }),
    ])
  })
})
