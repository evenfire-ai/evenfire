/**
 * #1043 — origin recorder of a fresh turn. A complete task runs through the
 * real TaskExecutor, tool loop and native registry on a ConversationManager
 * backed by the SQLite store. A 503 `provider_unavailable` after a confirmed
 * `clerum__attachment_read` leaves a resumable checkpoint whose header names
 * the turn, the principal and the source message (without bytes), whose task
 * budget carries the attachment read ledger, and whose attachment row holds
 * the upload bytes for their own TTL. The failure reaches `onFail` with the
 * checkpoint id.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { config as appConfig } from '../../config'
import { ConversationManager } from '../../core/conversation/conversation'
import { toModelStepCheckpointView } from '../../core/conversation/modelStepCheckpointView'
import { makeSqliteStore } from '../../core/conversation/persistence/__tests__/testHelpers'
import { ModelStepCheckpointStore } from '../../core/conversation/persistence/modelStepCheckpointStore'
import { LlmErrorCode } from '../../core/errors'
import { SimpleEventEmitter } from '../../core/orchestration/eventEmitter'
import { type ChatMessage, FinishReason, type ToolCall } from '../../core/types'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import type { SingleTurnProvider } from '../../llm/types'
import { McpManager } from '../../mcp/manager'
import type { Task, TaskError } from '../../queue/types'
import { createSessionRouteHandlers } from '../../server/sessionRouteHandlers'
import { validateIncomingAttachments } from '../incomingAttachments'
import { TaskExecutor, type TaskExecutorDeps } from '../taskExecutor'

const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
const NOW = 1_700_000_000_000
const RESUMABLE_TTL_MS = 7 * 24 * 3_600_000
const ATTACHMENT_TTL_MS = 3_600_000
const UPLOAD = Buffer.from('Quarterly notes. SENTINEL-1043-origin\n')

function admittedFile(bytes: Buffer) {
  const result = validateIncomingAttachments(
    [
      {
        id: 'file-1',
        kind: 'file',
        mimeType: 'text/plain',
        detectedMediaType: 'text/plain',
        encoding: 'base64',
        dataBase64: bytes.toString('base64'),
        filename: 'notes.txt',
        sizeBytes: bytes.length,
        digest: { algorithm: 'sha256', hex: createHash('sha256').update(bytes).digest('hex') },
      },
    ],
    { maxCount: 20, maxBytes: 1_000_000, maxFileBytes: 3_145_728, messageId: 'message-1' }
  )
  if (!result.ok) throw new Error(`fixture rejected: ${result.error.code}`)
  return result.attachments![0]!
}

/**
 * `toolCallsBeforeOutage` completions request `clerum__attachment_read`; the
 * next one fails with an upstream 503.
 */
function outageProvider(toolCallsBeforeOutage: number) {
  let calls = 0
  const provider: SingleTurnProvider = {
    getProviderType: () => 'openai',
    classifyError: () => ({
      code: LlmErrorCode.ModelOverloaded,
      retryable: true,
      message: 'provider unavailable',
      httpStatus: 503,
      providerCode: 'provider_unavailable',
    }),
    completeSingleTurn: async () => {
      throw new Error('Unexpected non-tool completion')
    },
    completeSingleTurnWithTools: async (_messages: ChatMessage[]) => {
      calls += 1
      if (calls > toolCallsBeforeOutage) throw new Error('upstream 503')
      const call: ToolCall = {
        id: `read-${calls}`,
        name: 'clerum__attachment_read',
        arguments: { attachmentId: 'file-1' },
      }
      return { content: null, tool_calls: [call], usage, finish_reason: FinishReason.ToolUse }
    },
  }
  return { provider, calls: () => calls }
}

async function runOutageTask(toolCallsBeforeOutage: number, withCheckpoints = true) {
  const attachment = admittedFile(UPLOAD)
  const handle = makeSqliteStore()
  const { provider, calls } = outageProvider(toolCallsBeforeOutage)
  const task: Task = {
    id: 'model-step-origin',
    source: 'channel',
    status: 'pending',
    priority: 'normal',
    createdAt: new Date(),
    sourceMessage: {
      sender: 'authenticated-user',
      content: 'Analyze the attached file',
      channelType: 'rpc',
      channelId: 'isolated-channel',
      messageId: 'message-1',
      timestamp: new Date().toISOString(),
      hostRef: 'fixture-host',
      attachments: [attachment],
    },
    conversationHistory: [
      { role: 'user', content: 'Analyze the attached file', timestamp: new Date() },
    ],
    responseCallback: vi.fn(async () => {}),
  }
  const lifecycle = new TaskLifecycle()
  lifecycle.register(task)
  const onFail = vi.fn<(task: Task, error: TaskError) => void>()
  const deps: TaskExecutorDeps = {
    conversationManager: new ConversationManager(handle.store),
    llmProvider: provider,
    mcpManager: new McpManager(),
    workspaceService: undefined,
    modelName: 'test-model',
    approvalConfig: undefined,
    config: {
      maxTaskDuration: 300000,
      maxToolCallsPerTask: 10,
      autoStart: true,
      taskDelay: 0,
      approvalTimeout: 300000,
    },
    coreEvents: new SimpleEventEmitter(),
    cronScheduler: null,
    taskLifecycle: lifecycle,
    onApprovalNeeded: vi.fn(),
    onComplete: vi.fn(),
    onFail,
    dynamicEnvProvider: () => ({}),
    ...(withCheckpoints
      ? {
          modelStepCheckpoints: {
            store: new ModelStepCheckpointStore(handle.persistQueue, { now: () => NOW }),
            hostInstanceId: 'host-instance-1',
            hostId: 'host-a',
            resumableTtlMs: RESUMABLE_TTL_MS,
            claimLeaseMs: 300_000,
            attachmentTtlMs: ATTACHMENT_TTL_MS,
          },
        }
      : {}),
  }
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  const executor = new TaskExecutor(task, deps)
  await executor.run()
  await handle.persistQueue.drain()
  return { handle, attachment, onFail, providerCalls: calls() }
}

interface HeaderRow {
  checkpoint_id: string
  status: string
  session_key: string
  origin_turn_number: number
  origin_task_id: string
  provider: string
  model: string
  host_id: string
  principal: string
  task_budget: string | null
  source_message: string | null
  expires_at: number | null
}

describe('TaskExecutor origin model-step checkpoint (#1043)', () => {
  const saved = {
    enableApproval: appConfig.enableApproval,
    dynamicToolsEnabled: appConfig.dynamicToolsEnabled,
  }

  afterEach(() => {
    Object.assign(appConfig, saved)
    vi.restoreAllMocks()
  })

  it('a 503 after a confirmed tool leaves a resumable checkpoint named in the TaskError', async () => {
    Object.assign(appConfig, { enableApproval: false, dynamicToolsEnabled: false })
    const { handle, attachment, onFail, providerCalls } = await runOutageTask(1)
    try {
      expect(providerCalls).toBe(2)
      expect(onFail).toHaveBeenCalledTimes(1)
      const taskError = onFail.mock.calls[0]![1]
      expect(taskError).toMatchObject({
        code: LlmErrorCode.ModelOverloaded,
        providerCode: 'provider_unavailable',
        retryable: true,
      })

      const db = handle.worker.db
      const headers = db.prepare('SELECT * FROM model_step_checkpoints').all() as HeaderRow[]
      expect(headers).toHaveLength(1)
      const header = headers[0]!
      expect(taskError.modelStepCheckpointId).toBe(header.checkpoint_id)
      const turnNumbers = db
        .prepare("SELECT turn_number FROM messages WHERE role = 'user'")
        .all() as Array<{ turn_number: number }>
      expect(turnNumbers).toEqual([{ turn_number: header.origin_turn_number }])
      expect(header).toMatchObject({
        status: 'resumable',
        origin_task_id: 'model-step-origin',
        provider: 'openai',
        model: 'test-model',
        host_id: 'host-a',
        principal: 'authenticated-user',
        expires_at: NOW + RESUMABLE_TTL_MS,
      })

      const sourceMessage = JSON.parse(header.source_message!) as {
        sender: string
        attachments: Array<Record<string, unknown>>
      }
      expect(sourceMessage.sender).toBe('authenticated-user')
      expect(sourceMessage.attachments.map(a => a.id)).toEqual(['file-1'])
      expect(sourceMessage.attachments[0]).not.toHaveProperty('dataBase64')

      const budget = JSON.parse(header.task_budget!) as {
        iterationsUsed: number
        attachmentReadLedger: unknown
      }
      expect(budget.iterationsUsed).toBeGreaterThan(0)
      expect(budget.attachmentReadLedger).toBeDefined()

      const bytes = db
        .prepare(
          'SELECT attachment_id, digest_hex, size_bytes, bytes, expires_at FROM model_step_checkpoint_attachments'
        )
        .all() as Array<{
        attachment_id: string
        digest_hex: string
        size_bytes: number
        bytes: Buffer
        expires_at: number
      }>
      expect(bytes).toHaveLength(1)
      expect(bytes[0]).toMatchObject({
        attachment_id: 'file-1',
        digest_hex: attachment.digest!.hex,
        size_bytes: UPLOAD.length,
        expires_at: NOW + ATTACHMENT_TTL_MS,
      })
      expect(Buffer.compare(bytes[0]!.bytes, UPLOAD)).toBe(0)

      // The session read serves the checkpoint under the same key the
      // executor wrote it with.
      expect(header.session_key).toBe('authenticated-user:rpc:isolated-channel:default')
      const store = new ModelStepCheckpointStore(handle.persistQueue, { now: () => NOW })
      const { handleSessionMessages } = createSessionRouteHandlers({
        getConversationManager: () => new ConversationManager(handle.store),
        redactToolError: (_tool, raw) => raw,
        redactTitle: raw => raw,
        loadModelStepCheckpoint: async sessionKey => {
          const live = await store.loadLive(sessionKey)
          return live ? toModelStepCheckpointView(live) : undefined
        },
      })
      const page = await handleSessionMessages(
        'authenticated-user',
        'isolated-channel',
        'default',
        {}
      )
      expect(page?.turns).toHaveLength(1)
      expect(page?.modelStepCheckpoint).toEqual({
        checkpointId: header.checkpoint_id,
        version: 2,
        status: 'resumable',
        retryAvailable: true,
        originTaskId: 'model-step-origin',
        provider: 'openai',
        model: 'test-model',
        tools: { confirmed: 1, unknown: 0, notDispatched: 0 },
        failedAt: new Date(NOW).toISOString(),
        expiresAt: new Date(NOW + RESUMABLE_TTL_MS).toISOString(),
      })
    } finally {
      await handle.shutdown()
    }
  })

  it('a 503 before any tool abandons the checkpoint and the TaskError names none', async () => {
    Object.assign(appConfig, { enableApproval: false, dynamicToolsEnabled: false })
    const { handle, onFail, providerCalls } = await runOutageTask(0)
    try {
      expect(providerCalls).toBe(1)
      expect(onFail).toHaveBeenCalledTimes(1)
      const taskError = onFail.mock.calls[0]![1]
      expect(taskError.providerCode).toBe('provider_unavailable')
      expect(taskError).not.toHaveProperty('modelStepCheckpointId')
      const db = handle.worker.db
      // Liveness witness: the recorder opened the header, then abandoned it.
      expect(db.prepare('SELECT status FROM model_step_checkpoints').all()).toEqual([
        { status: 'abandoned' },
      ])
      expect(db.prepare('SELECT * FROM model_step_checkpoint_attachments').all()).toEqual([])
    } finally {
      await handle.shutdown()
    }
  })

  it('without checkpoint support the same failure writes no checkpoint', async () => {
    Object.assign(appConfig, { enableApproval: false, dynamicToolsEnabled: false })
    const { handle, onFail, providerCalls } = await runOutageTask(1, false)
    try {
      // Liveness witness: the tool ran and the outage reached onFail.
      expect(providerCalls).toBe(2)
      expect(onFail).toHaveBeenCalledTimes(1)
      expect(onFail.mock.calls[0]![1].providerCode).toBe('provider_unavailable')
      expect(onFail.mock.calls[0]![1]).not.toHaveProperty('modelStepCheckpointId')
      expect(handle.worker.db.prepare('SELECT * FROM model_step_checkpoints').all()).toEqual([])
    } finally {
      await handle.shutdown()
    }
  })
})
