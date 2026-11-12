// The kept-files delete and the keep-refusal context as TaskExecutor wires them:
// which turns register the delete, that every call of it asks the user, and
// what the turn context says when a message's attachments were not kept.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { config as appConfig } from '../../config'
import { ConversationManager } from '../../core/conversation/conversation'
import { SimpleEventEmitter } from '../../core/orchestration/eventEmitter'
import {
  ATTACHMENTS_NOT_KEPT_INSTRUCTION,
  DELETE_OFFER_INSTRUCTION,
} from '../../core/orchestration/turnContext'
import {
  type Attachment,
  type ChatMessage,
  FinishReason,
  type PendingApproval,
  type ToolCall,
  type ToolDefinition,
} from '../../core/types'
import { GfsDownloadStore } from '../../internalTools/gfsDownloadStore'
import {
  SAVE_LEDGER_DIR,
  ledgerRecordFileName,
  writeSaveLedgerRecord,
} from '../../internalTools/keptFiles'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import type { SingleTurnProvider } from '../../llm/types'
import {
  KEPT_FILES_DELETE_APPROVAL_TOOL,
  projectApprovalInputPreview,
} from '../../progress/approvalInputPreview'
import { MessageQueue } from '../../queue'
import type { Task } from '../../queue/types'
import { CALLER_OUTPUTS_DIR } from '../../workspace/callerOutputs'
import { resolveCallerRootBinding } from '../../workspace/callerRootBinding'
import { ScopedWorkspaceProvider } from '../../workspace/scopedWorkspace'
import { CronScheduler } from '../cronScheduler'
import { AgentStateMachine } from '../stateMachine'
import { TaskExecutor, type TaskExecutorDeps, resolveTaskSessionKey } from '../taskExecutor'

// statfs reports the volume sized to its free space, so the disk's occupancy
// never meets the store's free-space floor.
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  const { freeSpaceSizedStatfs } = await import('../../__tests__/fixtures/gfsStoreTestKit')
  return { ...actual, statfs: freeSpaceSizedStatfs(actual.statfs) }
})

const DELETE = 'clerum__kept_files_delete'
const LIST = 'clerum__kept_files_list'
const ACCESS_ENV = `MCP_HOST_GFS_${String.fromCharCode(84, 79, 75, 69, 78)}`
const previousAccess = process.env[ACCESS_ENV]
const HOUR = 3_600_000
const KEPT_NAME = 'kept-report.md'
const KEPT_BYTES = 321
const KEPT_ID = 'a1b2c3d4e5f6'
// The kept file's time, an hour before the run: its record and its listing say it.
const KEPT_CREATED_AT = new Date(Date.now() - HOUR)

const savedConfig = {
  enableApproval: appConfig.enableApproval,
  codexToolPresentation: appConfig.codexToolPresentation,
  dynamicToolsEnabled: appConfig.dynamicToolsEnabled,
  promptCacheEnabled: appConfig.promptCacheEnabled,
}
const stores: GfsDownloadStore[] = []
const roots: string[] = []

function setScopes(scopes: string[]): void {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const claims = Buffer.from(JSON.stringify({ scopes })).toString('base64url')
  process.env[ACCESS_ENV] = `${header}.${claims}.sig`
}

beforeEach(() => {
  Object.assign(appConfig, {
    enableApproval: true,
    codexToolPresentation: 'direct',
    dynamicToolsEnabled: false,
    promptCacheEnabled: false,
  })
  setScopes(['gfs.read', 'gfs.write'])
})

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  Object.assign(appConfig, savedConfig)
  if (previousAccess === undefined) delete process.env[ACCESS_ENV]
  else process.env[ACCESS_ENV] = previousAccess
})

interface Options {
  calls: (ToolCall | null)[]
  source?: Task['source']
  autoApproved?: string[]
  approvalTools?: Record<string, boolean>
  keepRefusal?: { code: string; neededBytes?: number }
  attachments?: Attachment[]
}

/** A generated file and its save record in the caller's outputs folder, an hour old. */
function keptGenerated(callerRoot: string): { id: string; file: string; record: string } {
  const outputs = join(callerRoot, CALLER_OUTPUTS_DIR)
  fs.mkdirSync(outputs, { recursive: true, mode: 0o700 })
  const at = KEPT_CREATED_AT
  const file = join(outputs, KEPT_NAME)
  fs.writeFileSync(file, Buffer.alloc(KEPT_BYTES, 0x61))
  fs.utimesSync(file, at, at)
  const id = KEPT_ID
  writeSaveLedgerRecord(outputs, {
    id,
    name: KEPT_NAME,
    format: 'md',
    outcome: 'delivered',
    createdAt: at.toISOString(),
    deliveredSha256: '0'.repeat(64),
  })
  return { id, file, record: join(outputs, SAVE_LEDGER_DIR, ledgerRecordFileName(KEPT_NAME)) }
}

const deleteCall: ToolCall = {
  id: 'delete-kept-file',
  name: DELETE,
  arguments: {
    files: [
      {
        kind: 'generated',
        id: KEPT_ID,
        name: KEPT_NAME,
        createdAt: KEPT_CREATED_AT.toISOString(),
        sizeBytes: KEPT_BYTES,
      },
    ],
  },
}

const transformCall: ToolCall = {
  id: 'transform-first',
  name: 'json_transform',
  arguments: { data: { kept: true }, expression: 'kept' },
}

async function scenario(options: Options) {
  const root = await mkdtemp(join(tmpdir(), 'kept-delete-wiring-'))
  roots.push(root)
  const store = new GfsDownloadStore(root)
  stores.push(store)
  await store.initialize()
  const task: Task = {
    id: randomUUID(),
    source: options.source ?? 'channel',
    status: 'pending',
    priority: 'normal',
    createdAt: new Date(),
    sourceMessage: {
      sender: 'kept-files-caller',
      content: 'Clean up my kept files',
      channelType: 'rpc',
      channelId: 'kept-delete-channel',
      messageId: 'kept-delete-message',
      timestamp: new Date().toISOString(),
      hostRef: 'kept-delete-host',
      ...(options.keepRefusal ? { keepRefusal: options.keepRefusal } : {}),
      ...(options.attachments ? { attachments: options.attachments } : {}),
    },
    conversationHistory: [
      { role: 'user', content: 'Clean up my kept files', timestamp: new Date() },
    ],
    responseCallback: vi.fn(async () => undefined),
  }
  const binding = resolveCallerRootBinding(new ScopedWorkspaceProvider(root), task.sourceMessage)
  if (!binding.root) throw new Error(`Test caller binding failed: ${binding.failureCode}`)
  const callerRoot = binding.root
  const kept = keptGenerated(callerRoot)

  const providerCalls: ChatMessage[][] = []
  const providerTools: string[][] = []
  const provider: SingleTurnProvider = {
    getProviderType: () => 'codex-subscription',
    classifyError: () => ({
      code: 'LLM_UNKNOWN_ERROR' as never,
      retryable: false,
      message: 'fixture classification is never used',
    }),
    completeSingleTurn: async () => {
      throw new Error('Unexpected non-tool completion')
    },
    completeSingleTurnWithTools: async (messages, tools: ToolDefinition[]) => {
      providerCalls.push(structuredClone(messages))
      providerTools.push(tools.map(tool => tool.name))
      const call = options.calls[providerCalls.length - 1]
      return {
        content: call ? null : 'Done.',
        tool_calls: call ? [call] : null,
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        finish_reason: call ? FinishReason.ToolUse : FinishReason.Stop,
      }
    },
  }

  const conversationManager = new ConversationManager()
  const conversation = await conversationManager.getOrCreate(resolveTaskSessionKey(task), {
    userId: task.sourceMessage!.sender,
    channelType: task.sourceMessage!.channelType,
    channelId: task.sourceMessage!.channelId,
  })
  conversation.auto_approved_tools = new Set(options.autoApproved ?? [])

  const lifecycle = new TaskLifecycle()
  lifecycle.register(task)
  const onApprovalNeeded = vi.fn()
  const onFail = vi.fn()
  const deps: TaskExecutorDeps = {
    conversationManager,
    llmProvider: provider,
    mcpManager: null,
    workspaceService: undefined,
    gfsDownloadStore: store,
    gfsCallerWorkspacePath: callerRoot,
    modelName: 'fixture-model',
    approvalConfig: {
      defaultPolicy: 'channel_users',
      channels: {},
      ...(options.approvalTools ? { tools: options.approvalTools } : {}),
    },
    config: {
      maxTaskDuration: 30_000,
      maxToolCallsPerTask: 10,
      autoStart: true,
      taskDelay: 0,
      approvalTimeout: 30_000,
    },
    coreEvents: new SimpleEventEmitter(),
    cronScheduler: new CronScheduler(new MessageQueue()),
    taskLifecycle: lifecycle,
    onApprovalNeeded,
    onComplete: vi.fn(),
    onFail,
    dynamicEnvProvider: () => ({}),
  }
  return {
    executor: new TaskExecutor(task, deps),
    kept,
    providerCalls,
    providerTools,
    onApprovalNeeded,
    onFail,
  }
}

type Scenario = Awaited<ReturnType<typeof scenario>>

function toolResult(s: Scenario, callId: string): string | undefined {
  for (const messages of s.providerCalls) {
    const found = messages.find(m => m.role === 'tool' && m.tool_call_id === callId)
    if (found) return typeof found.content === 'string' ? found.content : JSON.stringify(found)
  }
  return undefined
}

/** The `<turn-context>` block of the last user message of the first provider call. */
function firstTurnContext(s: Scenario): string {
  const user = [...s.providerCalls[0]].reverse().find(m => m.role === 'user')
  const match = /<turn-context>[\s\S]*?<\/turn-context>/.exec(user?.content ?? '')
  if (!match) throw new Error('the first provider call carries no turn-context block')
  return match[0]
}

/**
 * transform → delete → answer. The transform runs with no card (the grant is
 * live); the delete suspends for an exact-invocation approval and deletes the
 * kept file only after it.
 */
async function expectDeleteAsksThenDeletes(s: Scenario): Promise<void> {
  await s.executor.run()

  // Witness that the grant is live: the transform ran with no approval.
  const transformed = toolResult(s, transformCall.id)
  expect(transformed).toBeDefined()
  expect(transformed).not.toMatch(/Tool not found|approval/i)
  expect(s.executor.pendingApproval).toMatchObject({
    tool_name: DELETE,
    authorization_scope: 'exact_invocation',
  })
  expect(s.onApprovalNeeded).toHaveBeenCalledTimes(1)
  expect(fs.existsSync(s.kept.file)).toBe(true)
  expect(fs.existsSync(s.kept.record)).toBe(true)

  await s.executor.resumeAfterApproval(false)

  expect(s.onFail).not.toHaveBeenCalled()
  expect(s.executor.executorState).toBe('completed')
  expect(fs.existsSync(s.kept.file)).toBe(false)
  expect(fs.existsSync(s.kept.record)).toBe(false)
}

/**
 * The delete is absent from the tools the model is offered, and a call of it
 * deletes nothing. Where the approval gate is active it asks for any name it
 * does not know as a whole-turn approval; approving that card still reaches
 * no delete tool.
 */
async function expectDeleteAbsent(s: Scenario, gateAsksForUnknownName: boolean): Promise<void> {
  await s.executor.run()
  if (gateAsksForUnknownName) {
    expect(s.executor.pendingApproval).toMatchObject({
      tool_name: DELETE,
      authorization_scope: 'turn_tools',
    })
    await s.executor.resumeAfterApproval(false)
  }

  expect(s.onFail).not.toHaveBeenCalled()
  expect(s.executor.executorState).toBe('completed')
  // Witness: the same scope and registry branch registered the listing.
  expect(s.providerTools[0]).toContain(LIST)
  expect(s.providerTools[0]).not.toContain(DELETE)
  expect(toolResult(s, deleteCall.id)).toContain(`Tool not found: ${DELETE}`)
  expect(fs.existsSync(s.kept.file)).toBe(true)
  expect(fs.existsSync(s.kept.record)).toBe(true)
}

describe('the kept-files delete asks the user on every call', () => {
  it('asks for the delete even when every tool of the conversation is approved', async () => {
    const s = await scenario({ calls: [transformCall, deleteCall, null], autoApproved: ['*'] })
    await expectDeleteAsksThenDeletes(s)
  })

  it('asks for the delete even after an earlier "always" grant of the delete', async () => {
    const s = await scenario({
      calls: [transformCall, deleteCall, null],
      autoApproved: [DELETE, 'json_transform'],
    })
    await expectDeleteAsksThenDeletes(s)
  })
})

describe('the kept-files delete does not exist where a call would not ask the user', () => {
  it('is not registered when approval is disabled', async () => {
    appConfig.enableApproval = false
    await expectDeleteAbsent(await scenario({ calls: [deleteCall, null] }), false)
  })

  it('is not registered for an unattended cron task', async () => {
    await expectDeleteAbsent(await scenario({ calls: [deleteCall, null], source: 'cron' }), false)
  })

  it('is not registered for an unattended internal task', async () => {
    await expectDeleteAbsent(
      await scenario({ calls: [deleteCall, null], source: 'internal' }),
      true
    )
  })

  it('is not registered when the Host turns its approval off', async () => {
    await expectDeleteAbsent(
      await scenario({ calls: [deleteCall, null], approvalTools: { [DELETE]: false } }),
      true
    )
  })
})

describe('a refused keep in the turn context', () => {
  it('reaches the model with the offer of the caller’s own kept files', async () => {
    const s = await scenario({
      calls: [null],
      keepRefusal: { code: 'host_quota_exceeded', neededBytes: KEPT_BYTES },
      attachments: [fileAttachment()],
    })
    await s.executor.run()

    expect(s.onFail).not.toHaveBeenCalled()
    const block = firstTurnContext(s)
    expect(block).toContain(
      `attachments_not_kept: code=host_quota_exceeded needed_bytes=${KEPT_BYTES}`
    )
    const offered = block.split('\n').filter(line => line.startsWith('deletable_file:'))
    expect(offered).toHaveLength(1)
    expect(offered[0]).toContain(`id=${KEPT_ID}`)
    expect(block).toContain(DELETE_OFFER_INSTRUCTION)
  })

  it('says only that nothing was kept when the turn has no delete', async () => {
    appConfig.enableApproval = false
    const s = await scenario({
      calls: [null],
      keepRefusal: { code: 'host_quota_exceeded', neededBytes: KEPT_BYTES },
      attachments: [fileAttachment()],
    })
    await s.executor.run()

    expect(s.onFail).not.toHaveBeenCalled()
    const block = firstTurnContext(s)
    // Witness: the refusal itself reached the block.
    expect(block).toContain('attachments_not_kept: code=host_quota_exceeded')
    expect(block).toContain(ATTACHMENTS_NOT_KEPT_INSTRUCTION)
    expect(block).not.toContain('deletable_file:')
    expect(block).not.toContain(DELETE)
  })
})

function fileAttachment(): Attachment {
  const data = Buffer.from('quarterly figures\n')
  return {
    id: 'att-notes',
    kind: 'file',
    mimeType: 'text/plain',
    encoding: 'base64',
    dataBase64: data.toString('base64'),
    filename: 'notes.txt',
    sizeBytes: data.byteLength,
  }
}

describe('the delete card shows the file the call deletes', () => {
  it('carries the listed size and date into the approval, the card and the channel text', async () => {
    const s = await scenario({ calls: [deleteCall, null] })
    await s.executor.run()
    const approval = s.executor.pendingApproval!
    expect(approval.parameters).toMatchObject(deleteCall.arguments)
    const shown = `created ${KEPT_CREATED_AT.toISOString().slice(0, 19).replace('T', ' ')} UTC`
    const line = `generated: "${KEPT_NAME}" — ${KEPT_BYTES} B (${KEPT_BYTES} bytes), ${shown}`
    const desktop = projectApprovalInputPreview(
      KEPT_FILES_DELETE_APPROVAL_TOOL,
      approval.parameters,
      text => text
    )!
    expect(desktop.text.split('\n')).toContain(line)
    const channel = (
      AgentStateMachine.prototype as unknown as {
        buildApprovalNotification(a: PendingApproval, u: string, c?: string): string
      }
    ).buildApprovalNotification.call(
      {
        approvalConfig: { defaultPolicy: 'channel_users', channels: {}, tools: {} },
        secretEntriesProvider: () => [],
      },
      approval,
      'kept-files-caller',
      'slack'
    )
    expect(channel.split('\n')).toContain(line)
    expect(fs.existsSync(s.kept.file)).toBe(true)
    await s.executor.resumeAfterApproval(false)
    expect(s.onFail).not.toHaveBeenCalled()
    expect(fs.existsSync(s.kept.file)).toBe(false)
  })

  it('deletes nothing for a call that names the file by kind, id and name only', async () => {
    const oldShape: ToolCall = {
      id: 'delete-old-shape',
      name: DELETE,
      arguments: { files: [{ kind: 'generated', id: KEPT_ID, name: KEPT_NAME }] },
    }
    const s = await scenario({ calls: [oldShape, null] })
    await s.executor.run()
    // Recorded: the card is asked first; the argument check refuses after approval.
    expect(s.executor.pendingApproval).toMatchObject({ tool_name: DELETE })
    await s.executor.resumeAfterApproval(false)
    expect(s.onFail).not.toHaveBeenCalled()
    // The registry's schema check refuses the call before the tool runs.
    expect(toolResult(s, oldShape.id)).toContain('Invalid arguments')
    expect(fs.existsSync(s.kept.file)).toBe(true)
  })
})
