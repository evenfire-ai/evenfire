/**
 * #666 — a complete task with a `kind:'file'` attachment, through the real
 * TaskExecutor, tool loop, native registry and safety. Only the model is a
 * double: it reads the turn context, calls `clerum__attachment_read` and
 * answers with what the tool returned.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { config as appConfig } from '../../config'
import { ConversationManager } from '../../core/conversation/conversation'
import { SimpleEventEmitter } from '../../core/orchestration/eventEmitter'
import { ATTACHED_FILES_INSTRUCTION } from '../../core/orchestration/turnContext'
import { type ChatMessage, FinishReason, type ToolCall } from '../../core/types'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import type { SingleTurnProvider } from '../../llm/types'
import { McpManager } from '../../mcp/manager'
import type { Task } from '../../queue/types'
import { validateIncomingAttachments } from '../incomingAttachments'
import { TaskExecutor, type TaskExecutorDeps } from '../taskExecutor'

const SENTINEL = 'SENTINEL-666-integration'
const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 }

function admittedFile(filename: string, mimeType: string, bytes: Buffer) {
  const result = validateIncomingAttachments(
    [
      {
        id: 'file-1',
        kind: 'file',
        mimeType,
        detectedMediaType: mimeType,
        encoding: 'base64',
        dataBase64: bytes.toString('base64'),
        filename,
        sizeBytes: bytes.length,
        digest: { algorithm: 'sha256', hex: createHash('sha256').update(bytes).digest('hex') },
      },
    ],
    { maxCount: 20, maxBytes: 1_000_000, maxFileBytes: 3_145_728, messageId: 'message-1' }
  )
  if (!result.ok) throw new Error(`fixture rejected: ${result.error.code}`)
  return result.attachments![0]!
}

function lastUserText(messages: ChatMessage[]): string {
  const user = [...messages].reverse().find(message => message.role === 'user')
  if (!user) throw new Error('the provider received no user message')
  return user.content ?? ''
}

async function runTask(filename: string, mimeType: string, bytes: Buffer) {
  const attachment = admittedFile(filename, mimeType, bytes)
  return { ...(await runTaskWith(attachment)), attachment }
}

/** Without an attachment the double answers directly; with one it reads it first. */
async function runTaskWith(attachment: ReturnType<typeof admittedFile> | undefined) {
  const call: ToolCall = {
    id: 'read-1',
    name: 'clerum__attachment_read',
    arguments: { attachmentId: 'file-1' },
  }
  const providerCalls: Array<{ messages: ChatMessage[]; toolNames: string[] }> = []
  const provider: SingleTurnProvider = {
    getProviderType: () => 'openai',
    classifyError: () => {
      throw new Error('Unexpected provider failure')
    },
    completeSingleTurn: async () => {
      throw new Error('Unexpected non-tool completion')
    },
    completeSingleTurnWithTools: async (messages, tools) => {
      providerCalls.push({
        messages: structuredClone(messages),
        toolNames: tools.map(tool => tool.name),
      })
      if (providerCalls.length === 1 && attachment) {
        return { content: null, tool_calls: [call], usage, finish_reason: FinishReason.ToolUse }
      }
      const result = messages.find(
        message => message.role === 'tool' && message.tool_call_id === call.id
      )
      return {
        content: `The tool returned: ${result?.content ?? 'nothing'}`,
        tool_calls: null,
        usage,
        finish_reason: FinishReason.Stop,
      }
    },
  }
  const task: Task = {
    id: `attachment-read-${attachment?.filename ?? 'none'}`,
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
      ...(attachment ? { attachments: [attachment] } : {}),
    },
    conversationHistory: [
      { role: 'user', content: 'Analyze the attached file', timestamp: new Date() },
    ],
    responseCallback: vi.fn(async () => {}),
  }
  const lifecycle = new TaskLifecycle()
  lifecycle.register(task)
  const deps: TaskExecutorDeps = {
    conversationManager: new ConversationManager(),
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
  return { attachment, call, deps, executor, providerCalls, task }
}

describe('clerum__attachment_read through a complete task (#666)', () => {
  const saved = {
    enableApproval: appConfig.enableApproval,
    dynamicToolsEnabled: appConfig.dynamicToolsEnabled,
    promptCacheEnabled: appConfig.promptCacheEnabled,
  }

  afterEach(() => {
    Object.assign(appConfig, saved)
  })

  it('lists the text file, reads it in the same turn and answers with its sentinel', async () => {
    Object.assign(appConfig, {
      enableApproval: false,
      dynamicToolsEnabled: false,
      promptCacheEnabled: true,
    })
    const { attachment, call, deps, executor, providerCalls } = await runTask(
      'notes.txt',
      'text/plain',
      Buffer.from(`Quarterly notes. ${SENTINEL}\n`)
    )

    expect(deps.onFail).not.toHaveBeenCalled()
    expect(executor.executorState).toBe('completed')
    expect(providerCalls).toHaveLength(2)

    // Turn 1: the tool is presented and the file is listed, never inlined.
    const reference = attachment.fileReference!
    const firstUserText = lastUserText(providerCalls[0]!.messages)
    expect(providerCalls[0]!.toolNames).toContain('clerum__attachment_read')
    expect(firstUserText).toContain(
      `attached_file: id="file-1" name="notes.txt" class=${reference.class} bytes=${reference.byteLength} reader=text\n`
    )
    expect(firstUserText).toContain(ATTACHED_FILES_INSTRUCTION)
    expect(firstUserText).not.toContain(SENTINEL)

    // Turn 2: the tool trace carries the call and its sanitized text result.
    const second = providerCalls[1]!.messages
    expect(second.flatMap(message => message.tool_calls ?? []).map(tool => tool.name)).toContain(
      'clerum__attachment_read'
    )
    const result = second.find(
      message => message.role === 'tool' && message.tool_call_id === call.id
    )
    expect(result?.content).toContain(SENTINEL)
    expect(result?.content).toContain('"kind":"text"')
    expect(result?.content).not.toContain('�')
    expect(deps.onComplete).toHaveBeenCalledTimes(1)
  })

  it('returns a binary result for a PDF, and the model never sees its bytes', async () => {
    Object.assign(appConfig, {
      enableApproval: false,
      dynamicToolsEnabled: false,
      promptCacheEnabled: true,
    })
    const { attachment, call, deps, executor, providerCalls } = await runTask(
      'report.pdf',
      'application/pdf',
      Buffer.from(`%PDF-1.7\n${SENTINEL}\n%%EOF\n`)
    )

    expect(deps.onFail).not.toHaveBeenCalled()
    expect(executor.executorState).toBe('completed')
    expect(providerCalls).toHaveLength(2)
    expect(lastUserText(providerCalls[0]!.messages)).toContain(
      `attached_file: id="file-1" name="report.pdf" class=${attachment.fileReference!.class} bytes=${attachment.fileReference!.byteLength} reader=none\n`
    )
    const result = providerCalls[1]!.messages.find(
      message => message.role === 'tool' && message.tool_call_id === call.id
    )
    // Witness: the tool answered with the typed binary result.
    expect(result?.content).toContain('"kind":"binary"')
    expect(result?.content).toContain('"reason":"no_reader_for_class"')
    const everything = JSON.stringify(providerCalls.map(entry => entry.messages))
    expect(everything).not.toContain(SENTINEL)
  })

  it('lists attached files with the prompt cache off, so the tool stays usable', async () => {
    Object.assign(appConfig, {
      enableApproval: false,
      dynamicToolsEnabled: false,
      promptCacheEnabled: false,
    })
    const { attachment, call, deps, executor, providerCalls } = await runTask(
      'notes.txt',
      'text/plain',
      Buffer.from(`Quarterly notes. ${SENTINEL}\n`)
    )

    expect(deps.onFail).not.toHaveBeenCalled()
    expect(executor.executorState).toBe('completed')
    const firstUserText = lastUserText(providerCalls[0]!.messages)
    expect(firstUserText.startsWith('<turn-context>')).toBe(true)
    expect(firstUserText).toContain(
      `attached_file: id="file-1" name="notes.txt" class=${attachment.fileReference!.class} bytes=${attachment.fileReference!.byteLength} reader=text\n`
    )
    const result = providerCalls[1]!.messages.find(
      message => message.role === 'tool' && message.tool_call_id === call.id
    )
    expect(result?.content).toContain(SENTINEL)
  })

  it('adds no turn-context block with the prompt cache off and no attached file', async () => {
    Object.assign(appConfig, {
      enableApproval: false,
      dynamicToolsEnabled: false,
      promptCacheEnabled: false,
    })
    const { deps, executor, providerCalls } = await runTaskWith(undefined)

    // Witness: the task ran and the model received the user's message.
    expect(deps.onFail).not.toHaveBeenCalled()
    expect(executor.executorState).toBe('completed')
    expect(providerCalls).toHaveLength(1)
    expect(lastUserText(providerCalls[0]!.messages)).toBe('Analyze the attached file')
    expect(providerCalls[0]!.toolNames).not.toContain('clerum__attachment_read')
  })
})
