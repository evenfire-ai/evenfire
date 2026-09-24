/**
 * #666 — persistence boundary of `clerum__attachment_read`. A complete task
 * runs through the real TaskExecutor, tool loop and native registry on a
 * ConversationManager backed by the SQLite store. The final answer quotes the
 * page text the tool returned; the attachment's `dataBase64` never reaches a
 * row.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { config as appConfig } from '../../config'
import { ConversationManager } from '../../core/conversation/conversation'
import { makeSqliteStore } from '../../core/conversation/persistence/__tests__/testHelpers'
import { SimpleEventEmitter } from '../../core/orchestration/eventEmitter'
import { type ChatMessage, FinishReason, type ToolCall } from '../../core/types'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import type { SingleTurnProvider } from '../../llm/types'
import { McpManager } from '../../mcp/manager'
import type { Task } from '../../queue/types'
import { validateIncomingAttachments } from '../incomingAttachments'
import { TaskExecutor, type TaskExecutorDeps } from '../taskExecutor'

const SENTINEL = 'SENTINEL-666-sqlite-boundary'
const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 }

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

describe('clerum__attachment_read persistence boundary (#666)', () => {
  const saved = {
    enableApproval: appConfig.enableApproval,
    dynamicToolsEnabled: appConfig.dynamicToolsEnabled,
  }

  afterEach(() => {
    Object.assign(appConfig, saved)
  })

  it('persists the tool result without the attachment bytes', async () => {
    Object.assign(appConfig, { enableApproval: false, dynamicToolsEnabled: false })
    const attachment = admittedFile(Buffer.from(`Quarterly notes. ${SENTINEL}\n`))
    const call: ToolCall = {
      id: 'read-1',
      name: 'clerum__attachment_read',
      arguments: { attachmentId: 'file-1' },
    }
    let providerCalls = 0
    const provider: SingleTurnProvider = {
      getProviderType: () => 'openai',
      classifyError: () => {
        throw new Error('Unexpected provider failure')
      },
      completeSingleTurn: async () => {
        throw new Error('Unexpected non-tool completion')
      },
      completeSingleTurnWithTools: async (messages: ChatMessage[]) => {
        providerCalls += 1
        if (providerCalls === 1)
          return { content: null, tool_calls: [call], usage, finish_reason: FinishReason.ToolUse }
        const result = messages.find(m => m.role === 'tool' && m.tool_call_id === call.id)
        return {
          content: `The tool returned: ${result?.content ?? 'nothing'}`,
          tool_calls: null,
          usage,
          finish_reason: FinishReason.Stop,
        }
      },
    }
    const handle = makeSqliteStore()
    try {
      const task: Task = {
        id: 'attachment-read-sqlite',
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
        onFail: vi.fn(),
        dynamicEnvProvider: () => ({}),
      }
      const executor = new TaskExecutor(task, deps)
      await executor.run()
      await handle.persistQueue.drain()

      expect(deps.onFail).not.toHaveBeenCalled()
      expect(executor.executorState).toBe('completed')
      const db = handle.worker.db
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>
      const rows = tables.flatMap(({ name }) =>
        (db.prepare(`SELECT * FROM "${name}"`).all() as unknown[]).map(row => JSON.stringify(row))
      )
      // The task path persists the user message and the final answer, not
      // tool rows. Witness: the persisted answer quotes the tool result, so
      // the page and its reference reached a row.
      const answerRows = db
        .prepare("SELECT content FROM messages WHERE role = 'assistant' AND content IS NOT NULL")
        .all() as Array<{ content: string }>
      expect(answerRows).toHaveLength(1)
      expect(answerRows[0]!.content).toContain(attachment.fileReference!.id)
      expect(answerRows[0]!.content).toContain(SENTINEL)
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.filter(row => row.includes(attachment.dataBase64))).toEqual([])
    } finally {
      await handle.shutdown()
    }
  })
})
