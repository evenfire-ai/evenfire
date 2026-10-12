import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { spawn } from 'child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { config as appConfig } from '../../config'
import { ConversationManager } from '../../core/conversation/conversation'
import {
  type StoreHandle,
  makeSqliteStore,
} from '../../core/conversation/persistence/__tests__/testHelpers'
import { SqliteConversationStore } from '../../core/conversation/persistence/sqliteConversationStore'
import { STATELESS_CRON_APPROVAL_PROMPT } from '../../core/extensions/mcpApprovalGateController'
import { SimpleEventEmitter } from '../../core/orchestration/eventEmitter'
import { HttpRequestTool } from '../../core/tools/httpRequest'
import { type ChatMessage, FinishReason, type ToolCall } from '../../core/types'
import { GfsDownloadStore } from '../../internalTools/gfsDownloadStore'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import type { SingleTurnProvider } from '../../llm/types'
import { MessageQueue } from '../../queue'
import type { Task } from '../../queue/types'
import { STATELESS_ALLOW_CRON_MANAGE_ENV } from '../../statelessCronPolicy'
import { resolveCallerRootBinding } from '../../workspace/callerRootBinding'
import { ScopedWorkspaceProvider } from '../../workspace/scopedWorkspace'
import { CronScheduler } from '../cronScheduler'
import { TaskExecutor, type TaskExecutorDeps, resolveTaskSessionKey } from '../taskExecutor'

// statfs reports the volume sized to its free space, so the disk's occupancy
// never meets the store's free-space floor.
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  const { freeSpaceSizedStatfs } = await import('../../__tests__/fixtures/gfsStoreTestKit')
  return { ...actual, statfs: freeSpaceSizedStatfs(actual.statfs) }
})

// Observe process admission while retaining the real shell, registry, approval
// controllers, conversation manager and caller-bound GFS store.
vi.mock('child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('child_process')>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})

const savedConfig = {
  enableApproval: appConfig.enableApproval,
  codexToolPresentation: appConfig.codexToolPresentation,
  dynamicToolsEnabled: appConfig.dynamicToolsEnabled,
  promptCacheEnabled: appConfig.promptCacheEnabled,
  statelessLifecycle: appConfig.statelessLifecycle,
  nativeTool: appConfig.nativeTool,
}
const savedAllowCronManage = process.env[STATELESS_ALLOW_CRON_MANAGE_ENV]
const stores: GfsDownloadStore[] = []
const roots: string[] = []
const sqliteHandles: StoreHandle[] = []

beforeEach(() => {
  Object.assign(appConfig, {
    enableApproval: true,
    codexToolPresentation: 'direct',
    dynamicToolsEnabled: false,
    promptCacheEnabled: false,
  })
  vi.clearAllMocks()
})

afterEach(async () => {
  for (const handle of sqliteHandles.splice(0)) await handle.shutdown()
  for (const store of stores.splice(0)) await store.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  Object.assign(appConfig, savedConfig)
  if (savedAllowCronManage === undefined) delete process.env[STATELESS_ALLOW_CRON_MANAGE_ENV]
  else process.env[STATELESS_ALLOW_CRON_MANAGE_ENV] = savedAllowCronManage
  vi.unstubAllGlobals()
})

function shellCall(id: string, command: string): ToolCall {
  return { id, name: 'shell_exec', arguments: { command } }
}

const firstCommand = 'printf first-approved-result'
const failingCommand = `${firstCommand}; exit 127`
// Use the verified test runtime; no assumption about Python or an ambient Node.
const secondCommand = `'${process.execPath.replace(/'/g, "'\\''")}' -e 'process.stdout.write("second-approved-result")'`

function riskyFollowUp(name: 'http_request' | 'cron_manage', id = `${name}-follow-up`): ToolCall {
  if (name === 'http_request') return { id, name, arguments: { url: 'https://example.test/' } }
  return { id, name, arguments: { action: 'list' } }
}

type SessionTool = 'shell_exec' | 'http_request' | 'cron_manage'

function sessionToolCall(name: SessionTool, id: string): ToolCall {
  return name === 'shell_exec' ? shellCall(id, firstCommand) : riskyFollowUp(name, id)
}

type StoreState = 'available' | 'closed' | 'uninitialized'

// A null entry ends the turn with a plain answer; later entries serve the next turn.
async function scenario(
  calls: (ToolCall | null)[],
  guardrailAsk = false,
  conversationManager = new ConversationManager(),
  storeState: StoreState = 'available',
  persistentShellApproval = true,
  options: { maxToolCalls?: number; requireDownloadApproval?: boolean } = {}
) {
  const root = await mkdtemp(join(tmpdir(), 'gfs-live-approval-'))
  roots.push(root)
  const store = new GfsDownloadStore(root)
  stores.push(store)
  if (storeState !== 'uninitialized') await store.initialize()
  if (storeState === 'closed') await store.close()
  const task: Task = {
    id: randomUUID(),
    source: 'channel',
    status: 'pending',
    priority: 'normal',
    createdAt: new Date(),
    sourceMessage: {
      sender: 'gfs-caller',
      content: 'Process the governed file',
      channelType: 'rpc',
      channelId: 'gfs-live-approval-channel',
      messageId: 'gfs-live-approval-message',
      timestamp: new Date().toISOString(),
      hostRef: 'gfs-live-approval-host',
    },
    conversationHistory: [
      { role: 'user', content: 'Process the governed file', timestamp: new Date() },
    ],
    responseCallback: vi.fn(async () => undefined),
  }
  const callerBinding = resolveCallerRootBinding(
    new ScopedWorkspaceProvider(root),
    task.sourceMessage
  )
  if (!callerBinding.root)
    throw new Error(`Test caller binding failed: ${callerBinding.failureCode}`)
  const callerWorkspace = callerBinding.root
  const releaseReceiptOwner = vi.spyOn(store, 'releaseReceiptOwner')
  const providerCalls: ChatMessage[][] = []
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
    completeSingleTurnWithTools: async messages => {
      providerCalls.push(structuredClone(messages))
      const call = calls[providerCalls.length - 1]
      return {
        content: call ? null : 'Governed processing complete.',
        tool_calls: call ? [call] : null,
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        finish_reason: call ? FinishReason.ToolUse : FinishReason.Stop,
      }
    },
  }

  const sessionKey = resolveTaskSessionKey(task)
  const conversation = await conversationManager.getOrCreate(sessionKey, {
    userId: task.sourceMessage!.sender,
    channelType: task.sourceMessage!.channelType,
    channelId: task.sourceMessage!.channelId,
  })
  conversation.auto_approved_tools = new Set(persistentShellApproval ? ['shell_exec'] : [])

  const lifecycle = new TaskLifecycle()
  lifecycle.register(task)
  const onApprovalNeeded = vi.fn()
  const onComplete = vi.fn()
  const onFail = vi.fn()
  const deps: TaskExecutorDeps = {
    conversationManager,
    llmProvider: provider,
    mcpManager: null,
    workspaceService: undefined,
    gfsDownloadStore: store,
    gfsCallerWorkspacePath: callerWorkspace,
    modelName: 'fixture-model',
    approvalConfig: {
      defaultPolicy: 'channel_users',
      channels: {},
      ...(options.requireDownloadApproval ? { tools: { clerum__gfs_download: true } } : {}),
    },
    guardrailsConfig: guardrailAsk
      ? {
          rules: [
            {
              id: 'ask-every-shell-call',
              action: 'ask',
              match: { tool: { provenance: 'native', name: 'shell_exec' } },
            },
          ],
        }
      : undefined,
    config: {
      maxTaskDuration: 30_000,
      maxToolCallsPerTask: options.maxToolCalls ?? 10,
      autoStart: true,
      taskDelay: 0,
      approvalTimeout: 30_000,
    },
    coreEvents: new SimpleEventEmitter(),
    cronScheduler: new CronScheduler(new MessageQueue()),
    taskLifecycle: lifecycle,
    onApprovalNeeded,
    onComplete,
    onFail,
    dynamicEnvProvider: () => ({}),
  }

  return {
    task,
    deps,
    store,
    sessionKey,
    conversation,
    executor: new TaskExecutor(task, deps),
    providerCalls,
    releaseReceiptOwner,
    onApprovalNeeded,
    onComplete,
    onFail,
  }
}

type Scenario = Awaited<ReturnType<typeof scenario>>

/** Runs the next user turn of the same conversation through a new task and executor. */
async function nextTurn(s: Scenario, conversationManager = s.deps.conversationManager) {
  const task: Task = {
    ...s.task,
    id: randomUUID(),
    status: 'pending',
    createdAt: new Date(),
    sourceMessage: {
      ...s.task.sourceMessage!,
      content: 'Process it again',
      messageId: `gfs-live-approval-message-${randomUUID()}`,
    },
    conversationHistory: [{ role: 'user', content: 'Process it again', timestamp: new Date() }],
    responseCallback: vi.fn(async () => undefined),
  }
  s.deps.taskLifecycle!.register(task)
  const executor = new TaskExecutor(task, { ...s.deps, conversationManager })
  expect(resolveTaskSessionKey(task)).toBe(s.sessionKey)
  await executor.run()
  return executor
}

// Shell approval is session-scoped (SESSION_SCOPED_APPROVAL_TOOLS): one approval
// covers later shell_exec calls of the conversation while it stays in memory.
// Only clerum__gfs_download keeps per-call live approval.
it('runs shell without a new approval when shell_exec is persistently approved', async () => {
  const call = shellCall('first-shell-call', firstCommand)
  const s = await scenario([call])
  await s.executor.run()

  expect(s.onFail).not.toHaveBeenCalled()
  // Witness: the command ran, with its exact arguments, and the turn finished.
  expect(spawn).toHaveBeenCalledTimes(1)
  expect(vi.mocked(spawn).mock.calls[0].slice(0, 2)).toEqual(['/bin/sh', ['-c', firstCommand]])
  expect(s.executor.executorState).toBe('completed')
  expect(s.onApprovalNeeded).not.toHaveBeenCalled()
})

// X6 covers an unavailable store with source 'cron'. These cases pin the channel
// path: delivery is withdrawn, and persistent shell approval still applies.
it.each([
  ['store closed', 'closed'] as const,
  ['store never initialized', 'uninitialized'] as const,
])(
  'applies persistent shell approval while the GFS download store is unavailable: %s',
  async (_label, storeState) => {
    const call = shellCall('unavailable-store-shell-call', firstCommand)
    const s = await scenario([call], false, new ConversationManager(), storeState)
    // Witness: the store wired into the executor reports itself unavailable.
    expect(s.store.isAvailable()).toBe(false)
    const isAvailable = vi.spyOn(s.store, 'isAvailable')

    await s.executor.run()

    // Witness: the executor consulted the unavailable store for this task.
    expect(isAvailable.mock.calls.length).toBeGreaterThan(0)
    expect(s.onFail).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(vi.mocked(spawn).mock.calls[0].slice(0, 2)).toEqual(['/bin/sh', ['-c', firstCommand]])
    expect(s.executor.executorState).toBe('completed')
    expect(s.onApprovalNeeded).not.toHaveBeenCalled()
  }
)

it('one shell approval covers the rest of the turn: two shell calls, one approval', async () => {
  const firstCall = shellCall('first-shell-call', firstCommand)
  const secondCall = shellCall('second-shell-call', secondCommand)
  const s = await scenario(
    [firstCall, secondCall],
    false,
    new ConversationManager(),
    'available',
    false
  )
  await s.executor.run()

  expect(s.executor.pendingApproval).toMatchObject({
    tool_name: 'shell_exec',
    tool_call_id: firstCall.id,
    authorization_scope: 'turn_tools',
  })
  expect(spawn).not.toHaveBeenCalled()
  await s.executor.resumeAfterApproval(false)

  expect(s.onFail).not.toHaveBeenCalled()
  // Witness: both commands ran, in order, after a single approval.
  expect(vi.mocked(spawn).mock.calls.map(call => call[1])).toEqual([
    ['-c', firstCommand],
    ['-c', secondCommand],
  ])
  const secondResult = s.providerCalls[2].find(
    message => message.role === 'tool' && message.tool_call_id === secondCall.id
  )
  expect(secondResult?.content).toContain('second-approved-result')
  expect(s.executor.executorState).toBe('completed')
  expect(s.onApprovalNeeded).toHaveBeenCalledTimes(1)
})

// SESSION_SCOPED_APPROVAL_TOOLS: one approval of shell_exec, http_request or
// cron_manage covers that tool alone. A plain approval lasts for the current
// task; "always" lasts for later tasks while the conversation stays in memory.
async function sessionToolScenario(toolName: SessionTool, persistent: boolean) {
  // http_request resolves and pins its own socket; the tool boundary is the witness.
  const httpExecute = vi
    .spyOn(HttpRequestTool.prototype, 'execute')
    .mockResolvedValue({ content: 'follow-up body', duration_ms: 1, is_error: false })
  const first = sessionToolCall(toolName, 'session-first')
  const s = await scenario(
    [
      first,
      sessionToolCall(toolName, 'session-same-task'),
      null,
      sessionToolCall(toolName, 'session-next-task'),
      null,
    ],
    false,
    new ConversationManager(),
    'available',
    false
  )
  const listJobs = vi.spyOn(s.deps.cronScheduler!, 'getAllJobs')
  const executions = () =>
    toolName === 'shell_exec'
      ? vi.mocked(spawn).mock.calls.length
      : toolName === 'http_request'
        ? httpExecute.mock.calls.length
        : listJobs.mock.calls.length
  await s.executor.run()

  // Witness: the first call suspended with an approval card and did not run.
  expect(s.executor.pendingApproval).toMatchObject({
    tool_name: toolName,
    tool_call_id: first.id,
    authorization_scope: 'turn_tools',
  })
  expect(s.onApprovalNeeded).toHaveBeenCalledTimes(1)
  expect(executions()).toBe(0)
  await s.executor.resumeAfterApproval(persistent)

  // Witness: the second call of the same task ran without a card.
  expect(s.onFail).not.toHaveBeenCalled()
  expect(s.executor.executorState).toBe('completed')
  expect(executions()).toBe(2)
  expect(s.onApprovalNeeded).toHaveBeenCalledTimes(1)
  return { s, executions }
}

it.each(['shell_exec', 'http_request', 'cron_manage'] as const)(
  'a plain %s approval covers its later calls in the same task and a new task asks again',
  async toolName => {
    const { s, executions } = await sessionToolScenario(toolName, false)
    expect(s.conversation.task_approved_tools).toEqual(new Set([toolName]))
    expect(s.conversation.auto_approved_tools).toEqual(new Set())

    const next = await nextTurn(s)

    expect(s.onFail).not.toHaveBeenCalled()
    expect(next.executorState).toBe('waiting_approval')
    expect(next.pendingApproval).toMatchObject({
      tool_name: toolName,
      tool_call_id: 'session-next-task',
      authorization_scope: 'turn_tools',
    })
    expect(s.onApprovalNeeded).toHaveBeenCalledTimes(2)
    expect(executions()).toBe(2)
  }
)

it.each(['shell_exec', 'http_request', 'cron_manage'] as const)(
  'an "always" %s approval covers its calls in later tasks',
  async toolName => {
    const { s, executions } = await sessionToolScenario(toolName, true)
    expect(s.conversation.auto_approved_tools).toEqual(new Set([toolName]))

    const next = await nextTurn(s)

    expect(s.onFail).not.toHaveBeenCalled()
    expect(next.executorState).toBe('completed')
    // Witness: the next task's call executed, still with the single card.
    expect(executions()).toBe(3)
    expect(s.onApprovalNeeded).toHaveBeenCalledTimes(1)
    expect(s.providerCalls).toHaveLength(5)
  }
)

it('a plain shell_exec approval covers 31 later shell calls of the same task', async () => {
  const later = Array.from({ length: 31 }, (_, index) =>
    shellCall(`many-shell-${index}`, firstCommand)
  )
  const s = await scenario(
    [shellCall('many-shell-first', firstCommand), ...later],
    false,
    new ConversationManager(),
    'available',
    false,
    { maxToolCalls: 40 }
  )
  await s.executor.run()
  expect(s.executor.pendingApproval).toMatchObject({ tool_name: 'shell_exec' })
  expect(spawn).not.toHaveBeenCalled()
  await s.executor.resumeAfterApproval(false)

  expect(s.onFail).not.toHaveBeenCalled()
  expect(s.executor.executorState).toBe('completed')
  // Witness: all 32 shell calls ran after the single card.
  expect(spawn).toHaveBeenCalledTimes(32)
  expect(s.onApprovalNeeded).toHaveBeenCalledTimes(1)
})

it('a plain shell_exec approval still covers shell after a clerum__gfs_download card in the same task', async () => {
  const download: ToolCall = {
    id: 'live-download',
    name: 'clerum__gfs_download',
    arguments: { drive: 'main', resourceId: 'governed-resource', expectedVersion: 7 },
  }
  const s = await scenario(
    [
      shellCall('before-download', firstCommand),
      download,
      shellCall('after-download', secondCommand),
    ],
    false,
    new ConversationManager(),
    'available',
    false,
    { requireDownloadApproval: true }
  )
  await s.executor.run()
  expect(s.executor.pendingApproval).toMatchObject({ tool_name: 'shell_exec' })
  await s.executor.resumeAfterApproval(false)

  // Witness: the live download card interrupted the task after the first shell call.
  expect(spawn).toHaveBeenCalledTimes(1)
  expect(s.executor.executorState).toBe('waiting_approval')
  expect(s.executor.pendingApproval).toMatchObject({
    tool_name: 'clerum__gfs_download',
    tool_call_id: download.id,
    authorization_scope: 'exact_invocation',
  })
  expect(s.onApprovalNeeded).toHaveBeenCalledTimes(2)
  await s.executor.resumeAfterApproval(false)

  expect(s.onFail).not.toHaveBeenCalled()
  expect(s.executor.executorState).toBe('completed')
  expect(vi.mocked(spawn).mock.calls.map(call => call[1])).toEqual([
    ['-c', firstCommand],
    ['-c', secondCommand],
  ])
  expect(s.onApprovalNeeded).toHaveBeenCalledTimes(2)
})

it('after a shell_exec approval, cron_manage and http_request still suspend for their own approval', async () => {
  // http_request resolves and pins its own socket; the tool boundary is the witness.
  const httpExecute = vi
    .spyOn(HttpRequestTool.prototype, 'execute')
    .mockResolvedValue({ content: 'follow-up body', duration_ms: 1, is_error: false })
  const shell = shellCall('session-shell', firstCommand)
  const sameTurnShell = shellCall('session-shell-again', secondCommand)
  const cron = riskyFollowUp('cron_manage')
  const http = riskyFollowUp('http_request')
  const s = await scenario(
    [shell, sameTurnShell, cron, http],
    false,
    new ConversationManager(),
    'available',
    false
  )
  const listJobs = vi.spyOn(s.deps.cronScheduler!, 'getAllJobs')
  await s.executor.run()
  expect(s.executor.pendingApproval).toMatchObject({
    tool_name: 'shell_exec',
    tool_call_id: shell.id,
  })
  await s.executor.resumeAfterApproval(false)

  // Witness: both shell calls of this turn ran under the one shell approval.
  expect(vi.mocked(spawn).mock.calls.map(call => call[1])).toEqual([
    ['-c', firstCommand],
    ['-c', secondCommand],
  ])
  expect(s.executor.executorState).toBe('waiting_approval')
  expect(s.executor.pendingApproval).toMatchObject({
    tool_name: 'cron_manage',
    tool_call_id: cron.id,
    authorization_scope: 'turn_tools',
  })
  expect(listJobs).not.toHaveBeenCalled()
  expect(s.conversation.task_approved_tools).toEqual(new Set(['shell_exec']))
  expect(s.conversation.auto_approved_tools).toEqual(new Set())
  await s.executor.resumeAfterApproval(false)

  expect(listJobs).toHaveBeenCalledOnce()
  expect(s.executor.executorState).toBe('waiting_approval')
  expect(s.executor.pendingApproval).toMatchObject({
    tool_name: 'http_request',
    tool_call_id: http.id,
    authorization_scope: 'turn_tools',
  })
  expect(httpExecute).not.toHaveBeenCalled()
  await s.executor.resumeAfterApproval(false)

  expect(s.onFail).not.toHaveBeenCalled()
  expect(httpExecute).toHaveBeenCalledOnce()
  expect(s.executor.executorState).toBe('completed')
  expect(s.onApprovalNeeded).toHaveBeenCalledTimes(3)
  expect(s.conversation.task_approved_tools).toEqual(
    new Set(['shell_exec', 'cron_manage', 'http_request'])
  )
  expect(s.conversation.auto_approved_tools).toEqual(new Set())
})

it('on a stateless host every cron_manage create asks, and an approved create card runs only that call', async () => {
  // Stateless host with cron management explicitly allowed: create/enable are forced approvals.
  Object.assign(appConfig, {
    statelessLifecycle: true,
    nativeTool: { ...appConfig.nativeTool, statelessLifecycle: true },
  })
  process.env[STATELESS_ALLOW_CRON_MANAGE_ENV] = 'true'
  const createCall = (id: string, name: string): ToolCall => ({
    id,
    name: 'cron_manage',
    arguments: { action: 'create', name, schedule: '0 0 1 1 *', task: 'yearly report' },
  })
  const s = await scenario(
    [
      riskyFollowUp('cron_manage', 'stateless-list'),
      riskyFollowUp('cron_manage', 'stateless-list-again'),
      createCall('stateless-create', 'first-schedule'),
      createCall('stateless-create-again', 'second-schedule'),
    ],
    false,
    new ConversationManager(),
    'available',
    false
  )
  const scheduler = s.deps.cronScheduler!
  const listJobs = vi.spyOn(scheduler, 'getAllJobs')
  await s.executor.run()
  expect(s.executor.pendingApproval).toMatchObject({
    tool_name: 'cron_manage',
    tool_call_id: 'stateless-list',
    authorization_scope: 'turn_tools',
  })
  await s.executor.resumeAfterApproval(false)

  // Witness: both list calls ran under the plain list approval, then the create suspended.
  expect(listJobs).toHaveBeenCalledTimes(2)
  expect(s.conversation.task_approved_tools).toEqual(new Set(['cron_manage']))
  expect(s.executor.executorState).toBe('waiting_approval')
  expect(s.executor.pendingApproval).toMatchObject({
    tool_name: 'cron_manage',
    tool_call_id: 'stateless-create',
    authorization_scope: 'exact_invocation',
    description: STATELESS_CRON_APPROVAL_PROMPT,
  })
  expect(s.onApprovalNeeded).toHaveBeenCalledTimes(2)
  expect(scheduler.getAllJobs()).toEqual([])
  await s.executor.resumeAfterApproval(true)

  // Witness: the approved create ran; the next create asked again.
  expect(scheduler.getAllJobs().map(job => job.name)).toEqual(['first-schedule'])
  expect(s.executor.executorState).toBe('waiting_approval')
  expect(s.executor.pendingApproval).toMatchObject({
    tool_name: 'cron_manage',
    tool_call_id: 'stateless-create-again',
    authorization_scope: 'exact_invocation',
  })
  expect(s.onApprovalNeeded).toHaveBeenCalledTimes(3)
  // The exact create approval, even with "always", stored nothing new.
  expect(s.conversation.task_approved_tools).toEqual(new Set(['cron_manage']))
  expect(s.conversation.auto_approved_tools).toEqual(new Set())
  expect(s.onFail).not.toHaveBeenCalled()
})

it('asks again for a plain shell_exec approval when a cold resume rebuilds the conversation mid-task', async () => {
  const handle = makeSqliteStore()
  sqliteHandles.push(handle)
  const s = await scenario(
    [
      shellCall('cold-task-first', firstCommand),
      riskyFollowUp('cron_manage', 'cold-task-cron'),
      shellCall('cold-task-after-resume', secondCommand),
    ],
    false,
    new ConversationManager(handle.store),
    'available',
    false
  )
  const listJobs = vi.spyOn(s.deps.cronScheduler!, 'getAllJobs')
  await s.executor.run()
  await s.executor.resumeAfterApproval(false)

  // Witness: the approved shell_exec ran, then the task suspended on cron_manage.
  expect(spawn).toHaveBeenCalledTimes(1)
  expect(s.executor.pendingApproval).toMatchObject({ tool_name: 'cron_manage' })
  expect(s.conversation.task_approved_tools).toEqual(new Set(['shell_exec']))

  const coldManager = new ConversationManager(
    new SqliteConversationStore(handle.persistQueue, { cacheSize: 8 })
  )
  const coldConversation = await coldManager.getOrCreate(s.sessionKey)
  expect(coldConversation).not.toBe(s.conversation)
  expect(coldConversation.task_approved_tools).toBeUndefined()
  const cold = new TaskExecutor(s.task, { ...s.deps, conversationManager: coldManager })
  await cold.rehydrateWaitingApproval(s.sessionKey, coldConversation.pending_approval!)
  await cold.resumeAfterApproval(false)

  expect(s.onFail).not.toHaveBeenCalled()
  // Witness: the rehydrated task resumed and ran the approved cron_manage call.
  expect(listJobs).toHaveBeenCalledOnce()
  expect(cold.executorState).toBe('waiting_approval')
  expect(cold.pendingApproval).toMatchObject({
    tool_name: 'shell_exec',
    tool_call_id: 'cold-task-after-resume',
  })
  expect(spawn).toHaveBeenCalledTimes(1)
})

it('asks again for an "always" shell_exec approval after a cold resume rebuilds the conversation', async () => {
  const handle = makeSqliteStore()
  sqliteHandles.push(handle)
  const s = await scenario(
    [
      shellCall('cold-first', firstCommand),
      shellCall('cold-same-turn', secondCommand),
      null,
      shellCall('cold-next-turn', firstCommand),
    ],
    false,
    new ConversationManager(handle.store),
    'available',
    false
  )
  await s.executor.run()
  await s.executor.resumeAfterApproval(true)

  // Witness: before the cold resume, the approved shell_exec proceeded without a card.
  expect(s.executor.executorState).toBe('completed')
  expect(spawn).toHaveBeenCalledTimes(2)
  expect(s.onApprovalNeeded).toHaveBeenCalledTimes(1)
  expect(s.conversation.auto_approved_tools).toEqual(new Set(['shell_exec']))

  const coldManager = new ConversationManager(
    new SqliteConversationStore(handle.persistQueue, { cacheSize: 8 })
  )
  const coldConversation = await coldManager.getOrCreate(s.sessionKey)
  expect(coldConversation).not.toBe(s.conversation)
  expect(coldConversation.auto_approved_tools.size).toBe(0)
  const cold = await nextTurn(s, coldManager)

  expect(s.onFail).not.toHaveBeenCalled()
  expect(cold.executorState).toBe('waiting_approval')
  expect(cold.pendingApproval).toMatchObject({
    tool_name: 'shell_exec',
    tool_call_id: 'cold-next-turn',
  })
  expect(spawn).toHaveBeenCalledTimes(2)
  expect(s.onApprovalNeeded).toHaveBeenCalledTimes(2)
})

it.each(['http_request', 'cron_manage'] as const)(
  'cold-resumes SQLite NULL shell scope without granting the next %s from an old wildcard',
  async followUp => {
    const handle = makeSqliteStore()
    sqliteHandles.push(handle)
    const manager = new ConversationManager(handle.store)
    const s = await scenario(
      [shellCall('legacy-shell', firstCommand), riskyFollowUp(followUp)],
      false,
      manager,
      'available',
      false
    )
    const listJobs = vi.spyOn(s.deps.cronScheduler!, 'getAllJobs')
    const fetchMock = vi.fn(async () => new Response('Unexpected remote result'))
    vi.stubGlobal('fetch', fetchMock)
    await s.executor.run()
    const saved = s.executor.pendingApproval!
    // Model the migration's actual legacy column value on a row produced by the
    // real persistSuspend path. A new cache forces the real select/reconstructor.
    handle.worker.db
      .prepare('UPDATE pending_approvals SET authorization_scope = NULL WHERE request_id = ?')
      .run(saved.request_id)
    s.conversation.auto_approved_tools.add('*')
    const coldManager = new ConversationManager(
      new SqliteConversationStore(handle.persistQueue, { cacheSize: 8 })
    )
    const coldConversation = await coldManager.getOrCreate(s.sessionKey)
    expect(coldConversation).not.toBe(s.conversation)
    expect(coldConversation.pending_approval?.authorization_scope).toBeUndefined()
    expect(coldConversation.auto_approved_tools.size).toBe(0)
    // A compatibility cache can also retain the old wildcard. Rehydration and
    // resolution both fence it while preserving separately explicit grants.
    coldConversation.auto_approved_tools = new Set(['*', 'trusted-server'])
    const cold = new TaskExecutor(s.task, { ...s.deps, conversationManager: coldManager })
    await cold.rehydrateWaitingApproval(s.sessionKey, coldConversation.pending_approval!)
    await cold.resumeAfterApproval(true)

    expect(s.onFail).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledOnce()
    expect(cold.executorState).toBe('waiting_approval')
    expect(cold.pendingApproval?.tool_name).toBe(followUp)
    expect(coldConversation.auto_approved_tools).toEqual(new Set(['trusted-server']))
    expect(listJobs).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  }
)

it('preserves separately explicit cron consent after a legacy SQLite shell resume', async () => {
  const handle = makeSqliteStore()
  sqliteHandles.push(handle)
  const s = await scenario(
    [shellCall('legacy-shell', firstCommand), riskyFollowUp('cron_manage')],
    false,
    new ConversationManager(handle.store),
    'available',
    false
  )
  await s.executor.run()
  handle.worker.db
    .prepare('UPDATE pending_approvals SET authorization_scope = NULL WHERE request_id = ?')
    .run(s.executor.pendingApproval!.request_id)
  const coldManager = new ConversationManager(
    new SqliteConversationStore(handle.persistQueue, { cacheSize: 8 })
  )
  const coldConversation = await coldManager.getOrCreate(s.sessionKey)
  coldConversation.auto_approved_tools = new Set(['*', 'cron_manage'])
  const listJobs = vi.spyOn(s.deps.cronScheduler!, 'getAllJobs')
  const cold = new TaskExecutor(s.task, { ...s.deps, conversationManager: coldManager })
  await cold.rehydrateWaitingApproval(s.sessionKey, coldConversation.pending_approval!)
  await cold.resumeAfterApproval(false)

  expect(s.onFail).not.toHaveBeenCalled()
  expect(cold.executorState).toBe('completed')
  expect(listJobs).toHaveBeenCalledOnce()
  expect(coldConversation.auto_approved_tools).toEqual(new Set(['cron_manage']))
})

const resumeCases = [
  { firstExit: 0, repeatedCommand: false, alwaysApprove: false, rehydrate: false },
  { firstExit: 0, repeatedCommand: true, alwaysApprove: true, rehydrate: false },
  { firstExit: 127, repeatedCommand: false, alwaysApprove: true, rehydrate: false },
  { firstExit: 127, repeatedCommand: true, alwaysApprove: false, rehydrate: false },
  { firstExit: 0, repeatedCommand: true, alwaysApprove: false, rehydrate: true },
  { firstExit: 127, repeatedCommand: false, alwaysApprove: false, rehydrate: true },
  // A guardrail `action: 'ask'` rule is what keeps shell approval per call now
  // that one shell_exec approval covers the tool for the rest of the task.
].map(c => ({ ...c, guardrailAsk: true }))

it.each(resumeCases)(
  'requires new approval after exit $firstExit (repeated=$repeatedCommand, persistent=$alwaysApprove, rehydrated=$rehydrate, guardrailAsk=$guardrailAsk)',
  async ({ firstExit, repeatedCommand, alwaysApprove, rehydrate, guardrailAsk }) => {
    const approvedCommand = firstExit === 127 ? failingCommand : firstCommand
    const firstCall = shellCall('first-shell-call', approvedCommand)
    const secondCall = shellCall(
      'second-shell-call',
      repeatedCommand ? approvedCommand : secondCommand
    )
    const s = await scenario([firstCall, secondCall], guardrailAsk)
    await s.executor.run()
    const firstApproval = s.executor.pendingApproval!
    expect(firstApproval.tool_call_id).toBe(firstCall.id)
    expect(firstApproval.context_snapshot.length).toBeGreaterThan(0)
    expect(spawn).not.toHaveBeenCalled()

    let executor = s.executor
    if (rehydrate) {
      executor = new TaskExecutor(s.task, s.deps)
      await executor.rehydrateWaitingApproval(s.sessionKey, firstApproval)
    }
    await executor.resumeAfterApproval(alwaysApprove)

    // The approved frozen call executes once, including its real exit status.
    expect(s.onFail).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(vi.mocked(spawn).mock.calls[0].slice(0, 2)).toEqual(['/bin/sh', ['-c', approvedCommand]])
    expect(s.providerCalls).toHaveLength(2)
    const firstResult = s.providerCalls[1].find(
      message => message.role === 'tool' && message.tool_call_id === firstCall.id
    )
    expect(firstResult?.content).toContain('first-approved-result')
    if (firstExit === 127) expect(firstResult?.content).toContain('exit code 127')
    else expect(firstResult?.content).not.toContain('Command failed')

    // Neither the residual pending snapshot nor the original persistent entry
    // authorizes a new live call; exact consent creates no wildcard or new grant.
    expect(s.conversation.auto_approved_tools).toEqual(new Set(['shell_exec']))
    expect(executor.executorState).toBe('waiting_approval')
    expect(executor.pendingApproval).toMatchObject({
      tool_name: secondCall.name,
      tool_call_id: secondCall.id,
      parameters: secondCall.arguments,
    })
    expect(executor.pendingApproval!.request_id).not.toBe(firstApproval.request_id)
    expect(s.onApprovalNeeded).toHaveBeenCalledTimes(2)
    expect(s.onComplete).not.toHaveBeenCalled()

    // A second explicit approval is sufficient; it does not re-execute A.
    await executor.resumeAfterApproval(false)
    expect(s.onFail).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(vi.mocked(spawn).mock.calls.map(call => call[1])).toEqual([
      ['-c', approvedCommand],
      ['-c', secondCall.arguments.command],
    ])
    expect(s.providerCalls).toHaveLength(3)
    const secondResult = s.providerCalls[2].find(
      message => message.role === 'tool' && message.tool_call_id === secondCall.id
    )
    expect(secondResult?.content).toContain(
      repeatedCommand ? 'first-approved-result' : 'second-approved-result'
    )
    if (!repeatedCommand) expect(secondResult?.content).not.toContain('Command failed')
    expect(executor.executorState).toBe('completed')
    expect(s.onComplete).toHaveBeenCalledExactlyOnceWith(s.task)
    expect(s.onApprovalNeeded).toHaveBeenCalledTimes(2)
  }
)

it.each([true])(
  'reissues live approval without a frozen snapshot (guardrailAsk=%s)',
  async guardrailAsk => {
    const firstCall = shellCall('first-shell-call', firstCommand)
    const secondCall = shellCall('regenerated-shell-call', secondCommand)
    const s = await scenario([firstCall, secondCall], guardrailAsk)
    await s.executor.run()
    const firstApproval = s.executor.pendingApproval!
    firstApproval.context_snapshot = []

    await s.executor.resumeAfterApproval(false)

    expect(s.onFail).not.toHaveBeenCalled()
    expect(s.executor.executorState).toBe('waiting_approval')
    expect(s.executor.pendingApproval).toMatchObject({
      tool_call_id: secondCall.id,
      parameters: secondCall.arguments,
    })
    expect(s.executor.pendingApproval!.request_id).not.toBe(firstApproval.request_id)
    expect(s.onApprovalNeeded).toHaveBeenCalledTimes(2)
    expect(spawn).not.toHaveBeenCalled()
  }
)
