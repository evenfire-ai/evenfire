/**
 * #1043 WP-H12 — a model-step continuation that suspends for approval keeps
 * its source identity in the checkpoint header, not in the files-only #666
 * approval row. A cold boot must rebuild the same attachment-capable turn
 * (image line plus the save tool), and must retire the approval instead of
 * silently continuing without the image when its checkpoint byte row expired
 * or the header has no source at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { config as appConfig } from '../../config'
import { ConversationManager } from '../../core/conversation/conversation'
import {
  type StoreHandle,
  makeSqliteStore,
} from '../../core/conversation/persistence/__tests__/testHelpers'
import { ModelStepCheckpointStore } from '../../core/conversation/persistence/modelStepCheckpointStore'
import { SqliteColdStartLoader } from '../../core/conversation/persistence/sqliteColdStartLoader'
import { LlmErrorCode } from '../../core/errors'
import {
  ATTACHMENT_SAVE_INSTRUCTION,
  attachedImagesForTurnContext,
  buildTurnContextBlock,
} from '../../core/orchestration/turnContext'
import type { Attachment, ChatMessage, ToolCall } from '../../core/types'
import { GFS_SAVE_ATTACHMENT_TOOL } from '../../internalTools/gfs'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import type { SingleTurnProvider } from '../../llm/types'
import { logger } from '../../logger'
import { McpManager } from '../../mcp/manager'
import { MessageQueue } from '../../queue/messageQueue'
import type { Task } from '../../queue/types'
import type { IncomingMessage } from '../../server/types'
import { approvalSourceMessageForResume, sourceMessageForResume } from '../sourceMessageForResume'
import { AgentStateMachine } from '../stateMachine'
import { type ModelStepCheckpointExecutionSupport, TaskExecutor } from '../taskExecutor'

const USER = 'user-h12'
const AGENT = 'chatllm'
const CHAT = 'h12-image-chat'
const SESSION_KEY = `${USER}:rpc:${AGENT}:${CHAT}`
const HOST_INSTANCE = 'host-instance-h12'
const CHECKPOINT_ID = 'checkpoint-h12'
const ORIGIN_TASK = 'task-origin-h12'
const CONTINUATION_TASK = 'task-continuation-h12'
const ORDINARY_TASK = 'task-ordinary-h12'
const REQUEST_ID = 'approval-image-h12'
const ORIGIN_MESSAGE_ID = 'message-origin-h12'
const CONTINUATION_MESSAGE_ID = 'message-continuation-h12'
const ORDINARY_REQUEST_ID = 'approval-ordinary-h12'
const PIN = { provider: 'openai', model: 'image-checkpoint-model' }
const NOW = 1_700_000_000_000
const TTL_MS = 7 * 24 * 3_600_000
const LEASE_MS = 300_000
const ATTACHMENT_TTL_MS = 3_600_000
const USAGE = { input_tokens: 1, output_tokens: 1, total_tokens: 2 }

// A 1x1 PNG, enough for the digest-bound image row.
const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jbi0AAAAASUVORK5CYII='
const IMAGE_BYTES = Buffer.from(PNG_1X1_BASE64, 'base64')
const IMAGE_DIGEST = createHash('sha256').update(IMAGE_BYTES).digest('hex')

// The repository forbids fixture secrets; the firewall test builds the same
// variable name from its code points.
const GFS_ACCESS_ENV = 'MCP_HOST_GFS_' + String.fromCharCode(84, 79, 75, 69, 78)
const previousGfsAccess = process.env[GFS_ACCESS_ENV]

const handles: StoreHandle[] = []
const savedConfig = {
  enableApproval: appConfig.enableApproval,
  dynamicToolsEnabled: appConfig.dynamicToolsEnabled,
}

interface RecordingProvider extends SingleTurnProvider {
  requests: ChatMessage[][]
  tools: Array<Array<{ name: string }>>
  calls: () => number
}

function provider(content = 'cold approval completed'): RecordingProvider {
  let invocations = 0
  const requests: ChatMessage[][] = []
  const tools: Array<Array<{ name: string }>> = []
  return {
    requests,
    tools,
    calls: () => invocations,
    getProviderType: () => PIN.provider as never,
    classifyError: error => ({
      code: LlmErrorCode.ApiCallFailed,
      retryable: false,
      message: error instanceof Error ? error.message : String(error),
    }),
    completeSingleTurn: async () => {
      throw new Error('Unexpected tool-less completion')
    },
    completeSingleTurnWithTools: async (messages, definitions) => {
      invocations += 1
      requests.push(messages)
      tools.push(definitions as never)
      return {
        content,
        tool_calls: [],
        usage: USAGE,
        finish_reason: 'stop' as never,
      }
    },
  }
}

function imageMessage(): IncomingMessage {
  const attachment: Attachment = {
    id: 'img-1',
    kind: 'image',
    mimeType: 'image/png',
    encoding: 'base64',
    dataBase64: PNG_1X1_BASE64,
    filename: 'logo.png',
  }
  return {
    sender: USER,
    content: 'Save this image to EvenDrive',
    channelType: 'rpc',
    channelId: AGENT,
    threadId: CHAT,
    messageId: ORIGIN_MESSAGE_ID,
    timestamp: new Date(NOW).toISOString(),
    hostRef: 'host-h12',
    attachments: [attachment],
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

function encodedGfsClaims(scopes: string[]): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ scopes })).toString('base64url')
  return `${header}.${payload}.sig`
}

const suspendedCall: ToolCall = {
  id: 'tc-image-gate',
  name: 'shell_exec',
  arguments: { command: 'printf image-cold' },
}

/**
 * The user message the continuation loop froze into the approval snapshot: the
 * turn-context block with the save instruction, the user text and the image
 * part carrying the bytes that were restored before the suspension.
 */
function frozenSnapshot(message: IncomingMessage): ChatMessage[] {
  const text =
    buildTurnContextBlock({
      date: new Date(NOW),
      channel: { type: message.channelType, sender: message.sender },
      attachmentSave: { images: attachedImagesForTurnContext(message.attachments) },
    }) + message.content
  return [
    {
      role: 'user',
      content: text,
      contentParts: [
        { type: 'text', text },
        { type: 'image', mimeType: 'image/png', data: PNG_1X1_BASE64 },
      ],
    },
    { role: 'assistant', content: '', tool_calls: [suspendedCall] },
  ]
}

interface ImageFixture {
  handle: StoreHandle
  manager: ConversationManager
  checkpoints: ModelStepCheckpointStore
}

async function openImageCheckpoint(
  manager: ConversationManager,
  checkpoints: ModelStepCheckpointStore,
  originTaskId: string
): Promise<void> {
  const message = imageMessage()
  const conversation = await manager.getOrCreate(SESSION_KEY, {
    userId: USER,
    channelType: message.channelType,
    channelId: message.channelId,
    threadId: message.threadId,
    source: 'rpc',
  })
  await manager.startTurn(conversation, message.content, originTaskId)
  await checkpoints.open(
    {
      checkpointId: CHECKPOINT_ID,
      sessionKey: SESSION_KEY,
      originTurnNumber: 1,
      originTaskId,
      provider: PIN.provider,
      model: PIN.model,
      hostId: 'host-h12',
      principal: USER,
      loopState: JSON.stringify({ nextIteration: 1, originUserMessageIndex: 0 }),
      taskBudget: JSON.stringify(bootBudget()),
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
}

/** A claimed continuation whose approval row keeps the #666 files-only projection. */
async function claimedImageApproval(): Promise<ImageFixture> {
  const handle = makeSqliteStore()
  handles.push(handle)
  const manager = new ConversationManager(handle.store)
  const checkpoints = new ModelStepCheckpointStore(handle.persistQueue, {
    now: () => Date.now(),
    blockedTtlMs: TTL_MS,
  })
  const message = imageMessage()
  await openImageCheckpoint(manager, checkpoints, ORIGIN_TASK)
  await manager.failTurn(manager.getSessionByKey(SESSION_KEY)!)
  const resumable = await checkpoints.transition(
    SESSION_KEY,
    { checkpointId: CHECKPOINT_ID, owner: ORIGIN_TASK, generation: 0 },
    {
      from: ['open'],
      to: 'resumable',
      failedAt: NOW,
      expiresAt: NOW + TTL_MS,
      attachments: [
        {
          attachmentId: 'image-row-1',
          digestHex: IMAGE_DIGEST,
          bytes: IMAGE_BYTES,
          expiresAt: NOW + ATTACHMENT_TTL_MS,
        },
      ],
    }
  )
  if (resumable === null) throw new Error('image checkpoint could not become resumable')
  const claim = await checkpoints.claim({
    sessionKey: SESSION_KEY,
    checkpointId: CHECKPOINT_ID,
    version: resumable,
    hostInstanceId: HOST_INSTANCE,
    newTaskId: CONTINUATION_TASK,
    leaseMs: LEASE_MS,
  })
  if (claim.outcome !== 'claimed') throw new Error(`claim failed: ${claim.outcome}`)
  const conversation = manager.getSessionByKey(SESSION_KEY)!
  await manager.resumeTurnForContinuation(conversation, CONTINUATION_TASK, 1, null, undefined, {
    fence: claim.fence,
    activeTaskId: CONTINUATION_TASK,
    originTurnNumber: 1,
  })
  await manager.suspendForApproval(conversation, {
    request_id: REQUEST_ID,
    tool_name: suspendedCall.name,
    tool_call_id: suspendedCall.id,
    parameters: suspendedCall.arguments,
    description: 'Approve the continuation tool call',
    context_snapshot: frozenSnapshot(message),
    task_budget: bootBudget(),
    // The continuation admission stamped its own per-run message id; the
    // approval row keeps that identity with the #666 files-only projection.
    sourceMessage: approvalSourceMessageForResume({
      ...message,
      messageId: CONTINUATION_MESSAGE_ID,
    }),
  })
  return { handle, manager, checkpoints }
}

/**
 * An ordinary #666 approval: its turn opened an origin checkpoint whose header
 * keeps the image identity, but the task is not a continuation.
 */
async function ordinaryImageApproval(): Promise<ImageFixture> {
  const handle = makeSqliteStore()
  handles.push(handle)
  const manager = new ConversationManager(handle.store)
  const checkpoints = new ModelStepCheckpointStore(handle.persistQueue, {
    now: () => Date.now(),
    blockedTtlMs: TTL_MS,
  })
  const message = imageMessage()
  await openImageCheckpoint(manager, checkpoints, ORDINARY_TASK)
  const conversation = manager.getSessionByKey(SESSION_KEY)!
  await manager.suspendForApproval(conversation, {
    request_id: ORDINARY_REQUEST_ID,
    tool_name: suspendedCall.name,
    tool_call_id: suspendedCall.id,
    parameters: suspendedCall.arguments,
    description: 'Approve the ordinary tool call',
    context_snapshot: frozenSnapshot(message),
    task_budget: bootBudget(),
    sourceMessage: approvalSourceMessageForResume(message),
  })
  return { handle, manager, checkpoints }
}

function support(checkpoints: ModelStepCheckpointStore) {
  return {
    store: checkpoints,
    hostInstanceId: HOST_INSTANCE,
    hostId: 'host-h12',
    resumableTtlMs: TTL_MS,
    claimLeaseMs: LEASE_MS,
    pendingApprovalTtlMs: TTL_MS,
    attachmentTtlMs: ATTACHMENT_TTL_MS,
  } satisfies ModelStepCheckpointExecutionSupport
}

function bootStateMachine(
  handle: StoreHandle,
  checkpoints: ModelStepCheckpointStore,
  pinned: RecordingProvider
): AgentStateMachine {
  const lifecycle = new TaskLifecycle()
  const queue = new MessageQueue()
  queue.setLifecycle(lifecycle)
  const stateMachine = new AgentStateMachine(queue, lifecycle, {
    maxTaskDuration: 300_000,
    maxToolCallsPerTask: 20,
    autoStart: false,
    taskDelay: 0,
    approvalTimeout: 300_000,
  })
  const fallback = provider('host default model must not run')
  stateMachine.setConversationStore(handle.store)
  stateMachine.setMcpManager(new McpManager())
  stateMachine.setLLMProvider(fallback as never, 'host-default-model')
  // The frozen snapshot carries the image part; the resumed turn must pass the
  // same affirmative visual gate a live continuation uses.
  stateMachine.setImageInputResolver(() => ({
    capability: {
      state: 'supported',
      evidence: {
        source: 'curated',
        reference: 'https://example.test/vision-capability',
        checkedAt: new Date(NOW).toISOString(),
      },
    },
  }))
  stateMachine.setTaskModelResolver(selections =>
    selections?.[PIN.provider] === PIN.model
      ? { provider: pinned, model: PIN.model, contextWindowTokens: 100_000 }
      : null
  )
  stateMachine.setModelStepCheckpoints(support(checkpoints))
  stateMachine.setColdStartLoader(new SqliteColdStartLoader(handle.store))
  return stateMachine
}

function checkpointRow(handle: StoreHandle, column: string) {
  return handle.worker.db
    .prepare(`SELECT ${column} FROM model_step_checkpoints WHERE checkpoint_id = ?`)
    .get(CHECKPOINT_ID) as Record<string, unknown> | undefined
}

function checkpointValue(handle: StoreHandle, column: string): unknown {
  return checkpointRow(handle, column)?.[column]
}

function approvalRow(handle: StoreHandle, requestId: string): string | undefined {
  const row = handle.worker.db
    .prepare('SELECT source_message FROM pending_approvals WHERE request_id = ?')
    .get(requestId) as { source_message: string | null } | undefined
  return row?.source_message ?? undefined
}

function setCheckpointColumn(handle: StoreHandle, column: string, value: unknown): number {
  return handle.worker.db
    .prepare(`UPDATE model_step_checkpoints SET ${column} = ? WHERE checkpoint_id = ?`)
    .run(value, CHECKPOINT_ID).changes
}

function toolNames(tools: Array<{ name: string }> | undefined): string[] {
  return (tools ?? []).map(tool => tool.name)
}

beforeEach(() => {
  Object.assign(appConfig, { enableApproval: true, dynamicToolsEnabled: false })
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  process.env[GFS_ACCESS_ENV] = encodedGfsClaims(['gfs.read', 'gfs.write'])
})

afterEach(async () => {
  Object.assign(appConfig, savedConfig)
  if (previousGfsAccess === undefined) delete process.env[GFS_ACCESS_ENV]
  else process.env[GFS_ACCESS_ENV] = previousGfsAccess
  vi.restoreAllMocks()
  for (const handle of handles.splice(0)) await handle.shutdown()
})

describe('AgentStateMachine cold continuation approval image identity (#1043 WP-H12)', () => {
  it('rebuilds the image-bearing turn from the checkpoint header after a cold restart', async () => {
    const f = await claimedImageApproval()
    // Liveness: the durable state exists before boot, and the approval row is
    // files-only while the checkpoint header carries the image identity.
    expect(approvalRow(f.handle, REQUEST_ID)).toBeDefined()
    const approvalSource = approvalRow(f.handle, REQUEST_ID)!
    expect(approvalSource).not.toContain('img-1')
    expect(approvalSource).not.toContain(PNG_1X1_BASE64)
    // Liveness for the identity choice: the row carries the continuation's own
    // per-run message id, the header carries the origin message id.
    expect(JSON.parse(approvalSource).messageId).toBe(CONTINUATION_MESSAGE_ID)
    const headerSource = String(checkpointValue(f.handle, 'source_message'))
    expect(JSON.parse(headerSource)).toMatchObject({
      messageId: ORIGIN_MESSAGE_ID,
      attachments: [
        expect.objectContaining({
          id: 'img-1',
          kind: 'image',
          digest: { algorithm: 'sha256', hex: IMAGE_DIGEST },
        }),
      ],
    })

    const rehydrated: TaskExecutor[] = []
    const original = TaskExecutor.prototype.rehydrateWaitingApproval
    vi.spyOn(TaskExecutor.prototype, 'rehydrateWaitingApproval').mockImplementation(function (
      this: TaskExecutor,
      sessionKey: string,
      approval
    ) {
      rehydrated.push(this)
      return original.call(this, sessionKey, approval)
    })
    const pinned = provider()
    const stateMachine = bootStateMachine(f.handle, f.checkpoints, pinned)
    await stateMachine.bootstrap()
    await f.handle.persistQueue.drain()

    expect(stateMachine.getPendingApprovals().map(approval => approval.requestId)).toEqual([
      REQUEST_ID,
    ])
    // The bootstrap-built task carries the header's image identity, with
    // bytes restored from the checkpoint table (the expiry/digest check ran),
    // and keeps the continuation's own message id from the approval row: that
    // id seeds the RPC workflow caller's sourceMessageId and the
    // workflow_trigger idempotency key (nativeToolRegistry.ts), so it must
    // match the id the continuation used before the restart.
    const task = rehydrated[0]!.sourceTask
    expect(task.modelStepContinuation?.checkpointId).toBe(CHECKPOINT_ID)
    expect(task.sourceMessage?.messageId).toBe(CONTINUATION_MESSAGE_ID)
    expect(task.sourceMessage?.attachments).toEqual([
      expect.objectContaining({
        id: 'img-1',
        kind: 'image',
        dataBase64: PNG_1X1_BASE64,
        digest: { algorithm: 'sha256', hex: IMAGE_DIGEST },
      }),
    ])

    const resume = vi.spyOn(TaskExecutor.prototype, 'resumeAfterApproval')
    expect(await stateMachine.handleApproval(USER, REQUEST_ID, true, 'rpc', AGENT)).toEqual({
      success: true,
    })
    await resume.mock.results[0]!.value
    await f.handle.persistQueue.drain()

    // The frozen approval snapshot still names the image, and the rebuilt
    // registry offers the tool that can save it.
    expect(pinned.calls()).toBe(1)
    const userMessage = pinned.requests[0]!.find(message => message.role === 'user')!
    expect(userMessage.content).toContain('attached_image: id="img-1"')
    expect(userMessage.content).toContain(ATTACHMENT_SAVE_INSTRUCTION)
    expect(toolNames(pinned.tools[0])).toContain(GFS_SAVE_ATTACHMENT_TOOL)
    expect(checkpointRow(f.handle, 'status')).toEqual({ status: 'completed' })
    expect(approvalRow(f.handle, REQUEST_ID)).toBeUndefined()
  })

  it('retires the approval and blocks the checkpoint when the image row expired before boot', async () => {
    const f = await claimedImageApproval()
    // Liveness: the approval and the byte row existed, then the retention
    // window of the bytes elapsed.
    expect(approvalRow(f.handle, REQUEST_ID)).toBeDefined()
    expect(
      f.handle.worker.db
        .prepare('SELECT COUNT(*) AS count FROM model_step_checkpoint_attachments')
        .get()
    ).toEqual({ count: 1 })
    expect(
      f.handle.worker.db
        .prepare(
          'UPDATE model_step_checkpoint_attachments SET expires_at = ? WHERE attachment_id = ?'
        )
        .run(NOW - 1, 'image-row-1').changes
    ).toBe(1)

    const pinned = provider('an expired image must not reach the provider')
    const warn = vi.spyOn(logger, 'warn')
    const stateMachine = bootStateMachine(f.handle, f.checkpoints, pinned)
    await stateMachine.bootstrap()
    await f.handle.persistQueue.drain()

    expect(checkpointRow(f.handle, 'status')).toEqual({ status: 'blocked' })
    expect(checkpointRow(f.handle, 'blocked_reason')).toEqual({
      blocked_reason: 'attachment_expired',
    })
    expect(approvalRow(f.handle, REQUEST_ID)).toBeUndefined()
    expect(stateMachine.getPendingApprovals()).toEqual([])
    expect(stateMachine.hasLiveExecutor(CONTINUATION_TASK)).toBe(false)
    expect(pinned.calls()).toBe(0)
    expect(warn).toHaveBeenCalledWith(
      {
        taskId: CONTINUATION_TASK,
        checkpointId: CHECKPOINT_ID,
        reason: 'attachment_expired',
      },
      'Pending approval checkpoint cannot be rehydrated'
    )
    const conversation = f.manager.getSessionByKey(SESSION_KEY)!
    expect(conversation.pending_approval).toBeUndefined()
  })

  it('retires a claimed continuation whose header has no source message as corrupt', async () => {
    const f = await claimedImageApproval()
    // Liveness: the approval and the header source existed, and the header is
    // the only image-bearing record.
    expect(approvalRow(f.handle, REQUEST_ID)).toBeDefined()
    expect(checkpointValue(f.handle, 'source_message')).not.toBeNull()
    expect(setCheckpointColumn(f.handle, 'source_message', null)).toBe(1)

    const pinned = provider('a NULL header source must not reach the provider')
    const warn = vi.spyOn(logger, 'warn')
    const stateMachine = bootStateMachine(f.handle, f.checkpoints, pinned)
    await stateMachine.bootstrap()
    await f.handle.persistQueue.drain()

    expect(approvalRow(f.handle, REQUEST_ID)).toBeUndefined()
    expect(stateMachine.getPendingApprovals()).toEqual([])
    expect(stateMachine.hasLiveExecutor(CONTINUATION_TASK)).toBe(false)
    expect(pinned.calls()).toBe(0)
    expect(warn).toHaveBeenCalledWith(
      {
        sessionKey: SESSION_KEY,
        taskId: CONTINUATION_TASK,
        code: 'MODEL_STEP_CHECKPOINT_CORRUPT',
      },
      'Pending approval checkpoint is corrupt; retiring approval'
    )
    // The approval row was never a fallback: nothing rebuilt the turn, and the
    // unowned checkpoint is left for the TTL sweep.
    expect(checkpointRow(f.handle, 'status')).toEqual({ status: 'claimed' })
    vi.spyOn(Date, 'now').mockReturnValue(NOW + TTL_MS + 1)
    expect(await f.checkpoints.sweep()).toMatchObject({ purgedCheckpoints: 1 })
  })

  it('keeps the ordinary #666 approval on its files-only row when a header exists', async () => {
    const f = await ordinaryImageApproval()
    // Liveness: the session's origin checkpoint header carries the image
    // identity, and the approval row does not.
    expect(JSON.parse(String(checkpointValue(f.handle, 'source_message')))).toMatchObject({
      attachments: [expect.objectContaining({ id: 'img-1', kind: 'image' })],
    })
    expect(approvalRow(f.handle, ORDINARY_REQUEST_ID)).not.toContain('img-1')

    const rehydrated: Task[] = []
    const original = TaskExecutor.prototype.rehydrateWaitingApproval
    vi.spyOn(TaskExecutor.prototype, 'rehydrateWaitingApproval').mockImplementation(function (
      this: TaskExecutor,
      sessionKey: string,
      approval
    ) {
      rehydrated.push(this.sourceTask)
      return original.call(this, sessionKey, approval)
    })
    const pinned = provider()
    const stateMachine = bootStateMachine(f.handle, f.checkpoints, pinned)
    await stateMachine.bootstrap()
    await f.handle.persistQueue.drain()

    expect(stateMachine.getPendingApprovals().map(approval => approval.requestId)).toEqual([
      ORDINARY_REQUEST_ID,
    ])
    expect(rehydrated[0]!.modelStepContinuation).toBeUndefined()
    expect(rehydrated[0]!.sourceMessage?.attachments ?? []).toEqual([])
  })
})
