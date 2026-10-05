import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { config } from '../../config'
import { ConversationManager } from '../../core/conversation/conversation'
import { makeSqliteStore } from '../../core/conversation/persistence/__tests__/testHelpers'
import { SimpleEventEmitter } from '../../core/orchestration/eventEmitter'
import { type ChatMessage, FinishReason } from '../../core/types'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import type { SingleTurnProvider } from '../../llm/types'
import { McpManager } from '../../mcp/manager'
import type { Task } from '../../queue/types'
import { validateIncomingAttachments } from '../incomingAttachments'
import { TaskExecutor } from '../taskExecutor'

const saved = {
  enableApproval: config.enableApproval,
  dynamicToolsEnabled: config.dynamicToolsEnabled,
  promptCacheEnabled: config.promptCacheEnabled,
  workspacePath: config.nativeTool.workspacePath,
}
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  Object.assign(config, {
    enableApproval: saved.enableApproval,
    dynamicToolsEnabled: saved.dynamicToolsEnabled,
    promptCacheEnabled: saved.promptCacheEnabled,
  })
  config.nativeTool.workspacePath = saved.workspacePath
})

async function fixture(readInitially = true) {
  const dir = await mkdtemp(join(tmpdir(), 'pr932-approval-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  Object.assign(config, {
    enableApproval: true,
    dynamicToolsEnabled: false,
    promptCacheEnabled: false,
  })
  config.nativeTool.workspacePath = dir
  const bytes = Buffer.from('Public first-page sentinel. '.repeat(20))
  const admitted = validateIncomingAttachments(
    [
      {
        id: 'public-file',
        kind: 'file',
        filename: 'public.txt',
        mimeType: 'text/plain',
        detectedMediaType: 'text/plain',
        encoding: 'base64',
        dataBase64: bytes.toString('base64'),
        sizeBytes: bytes.length,
        digest: { algorithm: 'sha256', hex: createHash('sha256').update(bytes).digest('hex') },
      },
    ],
    { maxCount: 20, maxBytes: 1_000_000, maxFileBytes: 11_534_336, messageId: 'public-message' }
  )
  if (!admitted.ok) throw new Error('Invalid public fixture')
  const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
  let resumed = false
  let requestReadAfterResume = false
  let afterReads = 0
  let received: ChatMessage[] = []
  const provider: SingleTurnProvider = {
    getProviderType: () => 'openai',
    classifyError: () => {
      throw new Error('Unexpected error')
    },
    completeSingleTurn: async () => {
      throw new Error('Unexpected completion')
    },
    completeSingleTurnWithTools: async messages => {
      if (resumed) {
        received = structuredClone(messages)
        if (afterReads >= (requestReadAfterResume ? 1 : 32))
          return {
            content: 'Finished bounded reads',
            usage,
            tool_calls: null,
            finish_reason: FinishReason.Stop,
          }
        const id = `read-after-${afterReads++}`
        return {
          content: null,
          usage,
          finish_reason: FinishReason.ToolUse,
          tool_calls: [
            { id, name: 'clerum__attachment_read', arguments: { attachmentId: 'public-file' } },
          ],
        }
      }
      return {
        content: null,
        usage,
        finish_reason: FinishReason.ToolUse,
        tool_calls: [
          ...(readInitially || requestReadAfterResume
            ? [
                {
                  id: 'read-first',
                  name: 'clerum__attachment_read',
                  arguments: { attachmentId: 'public-file' },
                },
              ]
            : []),
          {
            id: 'shell-first',
            name: 'shell_exec',
            arguments: { command: "printf 'approved\n' >> effects.txt" },
          },
        ],
      }
    },
  }
  const task: Task = {
    id: 'public-approval-task',
    source: 'channel',
    status: 'pending',
    priority: 'normal',
    createdAt: new Date(),
    responseCallback: vi.fn(async () => {}),
    sourceMessage: {
      sender: 'public-authenticated-user',
      channelType: 'rpc',
      channelId: 'public-channel',
      messageId: 'public-message',
      timestamp: new Date().toISOString(),
      hostRef: 'public-host',
      content: 'Read the file, then run the approved command',
      attachments: admitted.attachments,
    },
    conversationHistory: [{ role: 'user', content: 'Read the file', timestamp: new Date() }],
  }
  let store = makeSqliteStore({ dbPath: join(dir, 'state.db') })
  cleanups.push(() => store.shutdown())
  let manager = new ConversationManager(store.store)
  function executor(sourceTask = task) {
    const lifecycle = new TaskLifecycle()
    lifecycle.register(sourceTask)
    const onFail = vi.fn()
    const value = new TaskExecutor(sourceTask, {
      conversationManager: manager,
      llmProvider: provider,
      modelName: 'public-model',
      contextWindowTokens: 100_000,
      mcpManager: new McpManager(),
      workspaceService: undefined,
      approvalConfig: undefined,
      coreEvents: new SimpleEventEmitter(),
      cronScheduler: null,
      taskLifecycle: lifecycle,
      config: {
        maxTaskDuration: 300_000,
        maxToolCallsPerTask: 100,
        autoStart: true,
        taskDelay: 0,
        approvalTimeout: 0,
      },
      onApprovalNeeded: vi.fn(),
      onComplete: vi.fn(),
      onFail,
    })
    return { value, onFail }
  }
  const first = executor()
  await first.value.run()
  expect(first.onFail).not.toHaveBeenCalled()
  expect(first.value.executorState).toBe('waiting_approval')
  const original = first.value.pendingApproval!
  const ledger = original.task_budget!.attachmentReadLedger!
  expect(ledger.reads).toBe(readInitially ? 1 : 0)
  if (readInitially) expect(ledger.spentTokens).toBeGreaterThan(0)
  async function cold(mode: 'valid' | 'missing' | 'corrupt' | 'legacy' | 'zero' | 'empty') {
    const budget = JSON.parse(JSON.stringify(original.task_budget))
    if (mode === 'missing' || mode === 'empty') delete budget.attachmentReadLedger
    if (mode === 'corrupt')
      budget.attachmentReadLedger = { reads: -1, spentTokens: 0, bytesRead: 0 }
    if (mode === 'zero') {
      budget.attachmentReadLedger = { reads: 0, spentTokens: 0, bytesRead: 0 }
      requestReadAfterResume = true
    }
    const completed = (original.completed_results ?? []).map(r => ({
      ...r,
      content: '[compacted page]',
    }))
    const previousTurn = [
      { role: 'user', content: 'An earlier completed turn' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'previous-read',
            name: 'clerum__attachment_read',
            arguments: { attachmentId: 'previous-file' },
          },
        ],
      },
      {
        role: 'tool',
        name: 'clerum__attachment_read',
        tool_call_id: 'previous-read',
        content: 'Public data emitted in an earlier turn',
      },
    ]
    store.worker.db
      .prepare(
        'UPDATE pending_approvals SET task_budget = ?, completed_results = ?, context_snapshot = ? WHERE request_id = ?'
      )
      .run(
        mode === 'legacy' ? 'legacy' : JSON.stringify(budget),
        JSON.stringify(completed),
        mode === 'empty' ? '[]' : JSON.stringify([...previousTurn, ...original.context_snapshot]),
        original.request_id
      )
    await store.shutdown()
    store = makeSqliteStore({ dbPath: join(dir, 'state.db') })
    manager = new ConversationManager(store.store)
    const conversation = await manager.getOrCreate(first.value.sessionKey!)
    const persisted = conversation.pending_approval!
    expect(persisted).toBeTruthy()
    expect(persisted.sourceMessage?.attachments?.[0]).not.toHaveProperty('dataBase64')
    resumed = true
    // Match the production cold-start bridge; metadata deliberately has no bytes.
    const next = executor({
      ...task,
      sourceMessage: persisted.sourceMessage as Task['sourceMessage'],
    })
    await next.value.rehydrateWaitingApproval(first.value.sessionKey!, persisted)
    await next.value.resumeAfterApproval(false)
    return { ...next, persisted }
  }
  return {
    dir,
    first,
    original,
    ledger,
    cold,
    messages: () => received,
    resume: () => {
      resumed = true
    },
  }
}

describe('attachment budget through real approval persistence', () => {
  it('preserves spend through SQLite restart and compacted pages without replaying effects', async () => {
    const f = await fixture()
    const next = await f.cold('valid')
    expect(next.onFail.mock.calls.map(call => call[1])).toEqual([])
    expect(next.value.executorState).toBe('completed')
    expect(next.persisted.task_budget!.attachmentReadLedger).toEqual(f.ledger)
    const last = f.messages().find(m => m.tool_call_id === 'read-after-31')
    expect(last?.content).toContain('read_budget_exhausted')
    expect(await readFile(join(f.dir, 'effects.txt'), 'utf8')).toBe('approved\n')
  })
  it.each(['missing', 'corrupt', 'empty'] as const)(
    'rejects new reads with an unprovable %s carrier',
    async mode => {
      const f = await fixture()
      const next = await f.cold(mode)
      expect(next.value.executorState).toBe('failed')
      expect(next.onFail).toHaveBeenCalledTimes(1)
      expect(f.messages().some(m => m.tool_call_id === 'read-after-0')).toBe(false)
    }
  )
  it('preserves conservative exhaustion when a legacy row requires another approval', async () => {
    const f = await fixture()
    const next = await f.cold('legacy')
    expect(next.onFail).not.toHaveBeenCalled()
    expect(next.value.executorState).toBe('waiting_approval')
    expect(next.value.pendingApproval!.task_budget!.attachmentReadLedger!.reads).toBe(32)
  })
  it('keeps a warm ledger monotonic when an older snapshot claims zero spend', async () => {
    const f = await fixture()
    f.original.task_budget!.attachmentReadLedger = { reads: 0, spentTokens: 0, bytesRead: 0 }
    f.resume()
    await f.first.value.resumeAfterApproval(false)
    expect(f.first.onFail.mock.calls.map(call => call[1])).toEqual([])
    expect(f.first.value.executorState).toBe('completed')
    expect(f.messages().find(m => m.tool_call_id === 'read-after-31')?.content).toContain(
      'read_budget_exhausted'
    )
    expect(await readFile(join(f.dir, 'effects.txt'), 'utf8')).toBe('approved\n')
  })
  it('permits a first native invocation with a valid zero carrier; stripped bytes remain unavailable', async () => {
    const f = await fixture(false)
    const next = await f.cold('zero')
    expect(next.onFail).not.toHaveBeenCalled()
    expect(next.value.executorState).toBe('completed')
    const read = f.messages().find(m => m.tool_call_id === 'read-after-0')
    expect(read).toBeTruthy()
    expect(read?.content).not.toContain('read_budget_exhausted')
    expect(read?.content).not.toContain('Public first-page sentinel')
  })
})
