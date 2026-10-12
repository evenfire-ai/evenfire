/**
 * #666 — a complete task with a `kind:'file'` attachment, through the real
 * TaskExecutor, tool loop, native registry and safety. Only the model is a
 * double: it reads the turn context, calls `clerum__attachment_read` and
 * answers with what the tool returned.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { config as appConfig } from '../../config'
import {
  type AttachmentReadLedger,
  type AttachmentReadLedgerSnapshot,
  attachmentReadBudgets,
} from '../../core/attachments/attachmentReadBudget'
import { ConversationManager } from '../../core/conversation/conversation'
import { SimpleEventEmitter } from '../../core/orchestration/eventEmitter'
import { ATTACHED_FILES_INSTRUCTION } from '../../core/orchestration/turnContext'
import { ATTACHMENT_READ_TURN_STOP_MESSAGE } from '../../core/tools/attachmentRead'
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

interface TaskOptions {
  contextWindowTokens?: number
  /** The double asks for the next page (or the same offset) on every response. */
  readEveryResponse?: boolean
  /** The first response asks for an approval-gated shell command instead. */
  approvalFirst?: boolean
}

async function runTask(
  filename: string,
  mimeType: string,
  bytes: Buffer,
  options: TaskOptions = {}
) {
  const attachment = admittedFile(filename, mimeType, bytes)
  return { ...(await runTaskWith(attachment, options)), attachment }
}

/** The offset the double asks for next: the page's nextOffset, else the notice's resumeOffset. */
function nextReadOffset(messages: ChatMessage[]): number {
  const last = [...messages].reverse().find(message => message.role === 'tool')
  if (!last || last.name !== 'clerum__attachment_read') return 0
  const payload = toolPayload(last.content ?? '')
  if (typeof payload.nextOffset === 'number') return payload.nextOffset
  if (typeof payload.resumeOffset === 'number') return payload.resumeOffset
  throw new Error(`unexpected attachment read payload kind ${String(payload.kind)}`)
}

/** Without an attachment the double answers directly; with one it reads it first. */
async function runTaskWith(
  attachment: ReturnType<typeof admittedFile> | undefined,
  options: TaskOptions = {}
) {
  const call: ToolCall = {
    id: 'read-1',
    name: 'clerum__attachment_read',
    arguments: { attachmentId: 'file-1' },
  }
  const providerCalls: Array<{ messages: ChatMessage[]; toolNames: string[] }> = []
  let reads = 0
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
      if (options.approvalFirst && providerCalls.length === 1) {
        const shell: ToolCall = {
          id: 'shell-1',
          name: 'shell_exec',
          arguments: { command: "printf 'approved\\n' >> effects.txt" },
        }
        return { content: null, tool_calls: [shell], usage, finish_reason: FinishReason.ToolUse }
      }
      if (options.readEveryResponse && attachment) {
        reads += 1
        const read: ToolCall = {
          id: `read-${reads}`,
          name: 'clerum__attachment_read',
          arguments: { attachmentId: 'file-1', offset: nextReadOffset(messages) },
        }
        return { content: null, tool_calls: [read], usage, finish_reason: FinishReason.ToolUse }
      }
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
  const coreEvents = new SimpleEventEmitter()
  const toolRuns: string[] = []
  coreEvents.on('tool:completed', event => {
    toolRuns.push(`${String(event.data.toolName)}:${String(event.data.toolCallId)}`)
  })
  const deps: TaskExecutorDeps = {
    conversationManager: new ConversationManager(),
    llmProvider: provider,
    mcpManager: new McpManager(),
    workspaceService: undefined,
    modelName: 'test-model',
    ...(options.contextWindowTokens !== undefined
      ? { contextWindowTokens: options.contextWindowTokens }
      : {}),
    approvalConfig: undefined,
    config: {
      maxTaskDuration: 300000,
      maxToolCallsPerTask: options.readEveryResponse ? 100 : 10,
      autoStart: true,
      taskDelay: 0,
      approvalTimeout: 300000,
    },
    coreEvents,
    cronScheduler: null,
    taskLifecycle: lifecycle,
    onApprovalNeeded: vi.fn(),
    onComplete: vi.fn(),
    onFail: vi.fn(),
    dynamicEnvProvider: () => ({}),
  }
  const executor = new TaskExecutor(task, deps)
  await executor.run()
  return { attachment, call, deps, executor, providerCalls, task, toolRuns }
}

function ledgerOf(executor: TaskExecutor): AttachmentReadLedgerSnapshot {
  return (
    executor as unknown as { attachmentReadLedger: AttachmentReadLedger }
  ).attachmentReadLedger.snapshot()
}

/** The tool message content is the `<tool_output>` wrapper around the page JSON. */
function toolPayload(content: string): Record<string, unknown> {
  const bodyStart = content.indexOf('\n')
  const bodyEnd = content.lastIndexOf('\n</tool_output>')
  if (bodyStart < 0 || bodyEnd < 0) throw new Error('tool message is not wrapped')
  return JSON.parse(content.slice(bodyStart + 1, bodyEnd)) as Record<string, unknown>
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

  it('bounds the emitted page with the explicit turn window and debits the shared ledger', async () => {
    Object.assign(appConfig, {
      enableApproval: false,
      dynamicToolsEnabled: false,
      promptCacheEnabled: true,
    })
    // window 25_000 → page 2_500 / turn 7_500 with the notice reserve covered,
    // so the page binds (limit=page_budget) and a 65 KiB dense file cannot be
    // emitted whole; under the default 100k window it would arrive complete.
    const fileBytes = 65_535
    const { call, deps, executor, providerCalls } = await runTask(
      'dense.txt',
      'text/plain',
      Buffer.from('A'.repeat(fileBytes)),
      { contextWindowTokens: 25_000 }
    )

    expect(deps.onFail).not.toHaveBeenCalled()
    expect(executor.executorState).toBe('completed')
    expect(providerCalls).toHaveLength(2)
    const result = providerCalls[1]!.messages.find(
      message => message.role === 'tool' && message.tool_call_id === call.id
    )
    expect(result?.content).toBeTruthy()
    const payload = toolPayload(result!.content)
    expect(payload.kind).toBe('text')
    expect(payload.truncated).toBe(true)
    expect(payload.limit).toBe('page_budget')
    const byteRange = payload.byteRange as { offset: number; length: number }
    expect(byteRange.offset).toBe(0)
    expect(byteRange.length).toBeGreaterThan(0)
    expect(byteRange.length).toBeLessThan(fileBytes)
    expect(typeof payload.nextOffset).toBe('number')
    expect(payload.nextOffset as number).toBeGreaterThan(0)
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

  describe('notice overdraft ceiling (A15 U1)', () => {
    const WINDOW = 8_192
    const { turnTokens } = attachmentReadBudgets(WINDOW)
    const ceiling = turnTokens + Math.floor(turnTokens / 2)
    const reads = (from: number, to: number): string[] =>
      Array.from({ length: to - from + 1 }, (_, i) => `clerum__attachment_read:read-${from + i}`)
    /** The kind of read-k's result as the model received it on the following call. */
    const kindSeenAfter = (
      providerCalls: Array<{ messages: ChatMessage[] }>,
      index: number,
      k: number
    ) => {
      const message = providerCalls[index]!.messages.find(
        entry => entry.role === 'tool' && entry.tool_call_id === `read-${k}`
      )
      if (!message) throw new Error(`the model never received read-${k}`)
      return toolPayload(message.content ?? '').kind
    }

    it('ends the task with a stop message instead of failing it when the model keeps reading', async () => {
      Object.assign(appConfig, {
        enableApproval: false,
        dynamicToolsEnabled: false,
        promptCacheEnabled: true,
      })
      const { deps, executor, providerCalls, task, toolRuns } = await runTask(
        'long.txt',
        'text/plain',
        Buffer.alloc(400_000, 'q'),
        { contextWindowTokens: WINDOW, readEveryResponse: true }
      )

      expect(deps.onFail).not.toHaveBeenCalled()
      expect(executor.executorState).toBe('completed')
      expect(deps.onComplete).toHaveBeenCalledTimes(1)
      expect(vi.mocked(task.responseCallback!).mock.calls.map(([arg]) => arg.response)).toEqual([
        ATTACHMENT_READ_TURN_STOP_MESSAGE,
      ])
      // Measured: 19 reads ran and the model was called once per read before
      // the stop, never after it (two pages, then 16 charged notices).
      expect(toolRuns).toEqual(reads(1, 19))
      expect(providerCalls).toHaveLength(19)
      // Witness: reads 1-18 reached the model as a page or a plain notice.
      const kinds = Array.from({ length: 18 }, (_, i) => kindSeenAfter(providerCalls, i + 1, i + 1))
      expect(kinds.slice(0, 2)).toEqual(['text', 'text'])
      expect(kinds.slice(2).every(kind => kind === 'read_budget_exhausted')).toBe(true)
      expect(ledgerOf(executor).spentTokens).toBeGreaterThan(turnTokens)
      expect(ledgerOf(executor).spentTokens).toBeLessThanOrEqual(ceiling)
    })

    it('ends the task the same way after a resume that cannot prove the earlier spend', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'a15-turn-stop-'))
      const savedWorkspace = appConfig.nativeTool.workspacePath
      try {
        Object.assign(appConfig, {
          enableApproval: true,
          dynamicToolsEnabled: false,
          promptCacheEnabled: true,
        })
        appConfig.nativeTool.workspacePath = dir
        const { deps, executor, providerCalls, task, toolRuns } = await runTask(
          'long.txt',
          'text/plain',
          Buffer.alloc(400_000, 'q'),
          { contextWindowTokens: WINDOW, readEveryResponse: true, approvalFirst: true }
        )
        expect(executor.executorState).toBe('waiting_approval')
        const approval = executor.pendingApproval!
        expect(approval.task_budget?.attachmentReadLedger).toEqual({
          reads: 0,
          spentTokens: 0,
          bytesRead: 0,
        })
        // A missing carrier makes the resume exhaust the ledger (fail closed).
        delete approval.task_budget!.attachmentReadLedger
        await executor.resumeAfterApproval(false)

        expect(deps.onFail).not.toHaveBeenCalled()
        expect(executor.executorState).toBe('completed')
        expect(deps.onComplete).toHaveBeenCalledTimes(1)
        expect(vi.mocked(task.responseCallback!).mock.calls.map(([arg]) => arg.response)).toEqual([
          ATTACHMENT_READ_TURN_STOP_MESSAGE,
        ])
        // Measured: the exhausted ledger pays 8 notices from the overdraft and
        // the 9th read stops the turn.
        expect(toolRuns).toEqual(['shell_exec:shell-1', ...reads(1, 9)])
        // The shell call, then one model call after the shell result and after
        // each of reads 1-8.
        expect(providerCalls).toHaveLength(10)
        // Witness: reads 1-8 reached the model as notices, never as text.
        for (let k = 1; k <= 8; k++) {
          expect(kindSeenAfter(providerCalls, k + 1, k)).toBe('read_budget_exhausted')
        }
        const ledger = ledgerOf(executor)
        expect(ledger.reads).toBe(32)
        expect(ledger.bytesRead).toBe(0)
        expect(ledger.spentTokens).toBeGreaterThan(turnTokens)
        expect(ledger.spentTokens).toBeLessThanOrEqual(ceiling)
        // The stop is the ceiling's: the room left is less than one notice.
        const noticeCost = (ledger.spentTokens - turnTokens) / 8
        expect(Number.isInteger(noticeCost)).toBe(true)
        expect(ceiling - ledger.spentTokens).toBeLessThan(noticeCost)
      } finally {
        appConfig.nativeTool.workspacePath = savedWorkspace
        await rm(dir, { recursive: true, force: true })
      }
    })
  })
})
