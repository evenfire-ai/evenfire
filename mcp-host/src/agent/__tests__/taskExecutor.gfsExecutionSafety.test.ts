import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { spawn } from 'child_process'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { config as appConfig } from '../../config'
import { ConversationManager } from '../../core/conversation/conversation'
import { SimpleEventEmitter } from '../../core/orchestration/eventEmitter'
import { type ChatMessage, FinishReason, type ToolCall } from '../../core/types'
import { GfsDownloadStore } from '../../internalTools/gfsDownloadStore'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import type { SingleTurnProvider } from '../../llm/types'
import type { Task, TaskSource } from '../../queue/types'
import { resolveCallerRootBinding } from '../../workspace/callerRootBinding'
import { ScopedWorkspaceProvider } from '../../workspace/scopedWorkspace'
import { TaskExecutor, type TaskExecutorDeps } from '../taskExecutor'

vi.mock('child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('child_process')>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})

const { clientFactory } = vi.hoisted(() => ({ clientFactory: vi.fn() }))
// Only GFSC's external boundary is doubled; the store, registry, approval gate,
// TaskExecutor and shell are real.
vi.mock('../../internalTools/gfsClient', async importOriginal => ({
  ...(await importOriginal<typeof import('../../internalTools/gfsClient')>()),
  getGfsToolScopes: () => new Set(['gfs.read']),
  createGfscClient: clientFactory,
}))

const largeResourceId = 'c'.repeat(32)
const largeFile = {
  source: {
    kind: 'gfs' as const,
    drive: 'main',
    resourceId: largeResourceId,
    gfsUri: `gfs://main/${largeResourceId}`,
    name: 'large.csv',
    version: 7,
  },
  size: 3_836_961,
}
let gfsClient: {
  accessible: ReturnType<typeof vi.fn>
  list: ReturnType<typeof vi.fn>
  read: ReturnType<typeof vi.fn>
  readMetadata: ReturnType<typeof vi.fn>
  download: ReturnType<typeof vi.fn>
  stat: ReturnType<typeof vi.fn>
  resolve: ReturnType<typeof vi.fn>
}

const savedConfig = {
  enableApproval: appConfig.enableApproval,
  codexToolPresentation: appConfig.codexToolPresentation,
  dynamicToolsEnabled: appConfig.dynamicToolsEnabled,
  promptCacheEnabled: appConfig.promptCacheEnabled,
}
const roots: string[] = []
const stores: GfsDownloadStore[] = []

beforeEach(() => {
  Object.assign(appConfig, {
    enableApproval: true,
    codexToolPresentation: 'direct',
    dynamicToolsEnabled: false,
    promptCacheEnabled: false,
  })
  vi.clearAllMocks()
  const unexpected = (name: string) =>
    vi.fn(async () => {
      throw new Error(`Unexpected GFSC ${name} call`)
    })
  gfsClient = {
    accessible: unexpected('accessible'),
    list: unexpected('list'),
    read: unexpected('read'),
    readMetadata: vi.fn(async () => structuredClone(largeFile)),
    download: unexpected('download'),
    stat: unexpected('stat'),
    resolve: unexpected('resolve'),
  }
  clientFactory.mockReturnValue(gfsClient)
})

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close().catch(() => undefined)
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
  Object.assign(appConfig, savedConfig)
})

async function unavailableStore() {
  const root = await fs.mkdtemp(join(tmpdir(), 'gfs-shell-safety-'))
  roots.push(root)
  await fs.mkdir(join(root, '.gfs-download-store'), { mode: 0o700 })
  const store = new GfsDownloadStore(root)
  stores.push(store)
  await store.initialize().catch(() => undefined)
  return { root, store }
}

/**
 * A store whose ledger carries a processing lease written by a pre-#1019 Host
 * that crashed: expired, empty, and owned by a foreign writer session.
 */
async function legacyLeaseStore() {
  const root = await fs.mkdtemp(join(tmpdir(), 'gfs-shell-safety-legacy-'))
  roots.push(root)
  const first = new GfsDownloadStore(root)
  await first.initialize()
  await first.close()
  const ledgerPath = join(root, '.gfs-download-store', 'ledger-v1.json')
  const ledger = JSON.parse(await fs.readFile(ledgerPath, 'utf8'))
  const leaseId = '77777777-7777-4777-8777-777777777777'
  ledger.processingLeases = {
    [leaseId]: {
      leaseId,
      callerIdentity: '_system',
      recordIds: [],
      acquiredAt: new Date(Date.now() - 120_000).toISOString(),
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      writerSessionId: '88888888-8888-4888-8888-888888888888',
    },
  }
  await fs.writeFile(ledgerPath, JSON.stringify(ledger), { mode: 0o600 })
  const store = new GfsDownloadStore(root)
  stores.push(store)
  await store.initialize()
  return { root, store }
}

async function healthyStore() {
  const root = await fs.mkdtemp(join(tmpdir(), 'gfs-shell-safety-healthy-'))
  roots.push(root)
  const store = new GfsDownloadStore(root)
  stores.push(store)
  await store.initialize()
  return { root, store }
}

async function shellScenario({
  source,
  approvalEnabled = true,
  shellApprovalDisabled = false,
  healthy = false,
  legacyLease = false,
  channelCaller = false,
  missingCallerRoot = false,
  calls = [{ id: 'shell-safety', name: 'shell_exec', arguments: { command: 'pwd' } }],
}: {
  source: TaskSource
  approvalEnabled?: boolean
  shellApprovalDisabled?: boolean
  healthy?: boolean
  legacyLease?: boolean
  channelCaller?: boolean
  missingCallerRoot?: boolean
  calls?: ToolCall[]
}) {
  appConfig.enableApproval = approvalEnabled
  const { root, store } = legacyLease
    ? await legacyLeaseStore()
    : healthy
      ? await healthyStore()
      : await unavailableStore()
  const sourceMessage = channelCaller
    ? {
        sender: 'gfs-safety-caller',
        content: 'run pwd',
        channelType: 'rpc' as const,
        channelId: 'gfs-safety-channel',
        messageId: 'gfs-safety-message',
        timestamp: new Date().toISOString(),
        hostRef: 'gfs-safety-host',
      }
    : undefined
  let callerWorkspace = join(root, 'users', '_system')
  if (sourceMessage) {
    const binding = resolveCallerRootBinding(new ScopedWorkspaceProvider(root), sourceMessage)
    if (!binding.root) throw new Error(`Test caller binding failed: ${binding.failureCode}`)
    callerWorkspace = binding.root
  }
  await fs.mkdir(callerWorkspace, { recursive: true, mode: 0o700 })
  const providerCalls: ChatMessage[][] = []
  const advertisedTools: string[][] = []
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
    completeSingleTurnWithTools: async (messages, tools) => {
      providerCalls.push(structuredClone(messages))
      advertisedTools.push(tools.map(tool => tool.name))
      const call = calls[providerCalls.length - 1]
      return {
        content: call ? null : 'Shell finished.',
        tool_calls: call ? [call] : null,
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        finish_reason: call ? FinishReason.ToolUse : FinishReason.Stop,
      }
    },
  }
  const task: Task = {
    id: '22222222-2222-4222-8222-222222222222',
    source,
    status: 'pending',
    priority: 'normal',
    createdAt: new Date(),
    ...(sourceMessage ? { sourceMessage } : {}),
    conversationHistory: [{ role: 'user', content: 'run pwd', timestamp: new Date() }],
    responseCallback: vi.fn(async () => undefined),
  }
  const lifecycle = new TaskLifecycle()
  lifecycle.register(task)
  const onFail = vi.fn()
  const onApprovalNeeded = vi.fn()
  const deps: TaskExecutorDeps = {
    conversationManager: new ConversationManager(),
    llmProvider: provider,
    mcpManager: null,
    workspaceService: undefined,
    gfsDownloadStore: store,
    gfsCallerWorkspacePath: missingCallerRoot ? undefined : callerWorkspace,
    modelName: 'fixture-model',
    approvalConfig: {
      defaultPolicy: 'channel_users',
      channels: {},
      ...(shellApprovalDisabled ? { tools: { shell_exec: false } } : {}),
    },
    config: {
      maxTaskDuration: 30_000,
      maxToolCallsPerTask: 10,
      autoStart: true,
      taskDelay: 0,
      approvalTimeout: 30_000,
    },
    coreEvents: new SimpleEventEmitter(),
    cronScheduler: null,
    taskLifecycle: lifecycle,
    onApprovalNeeded,
    onComplete: vi.fn(),
    onFail,
    dynamicEnvProvider: () => ({}),
  }
  return {
    executor: new TaskExecutor(task, deps),
    providerCalls,
    advertisedTools,
    onFail,
    onApprovalNeeded,
    callerWorkspace,
    store,
  }
}

it.each([
  ['cron source', { source: 'cron' as TaskSource }],
  ['internal source', { source: 'internal' as TaskSource, approvalEnabled: false }],
  ['approval disabled', { source: 'channel' as TaskSource, approvalEnabled: false }],
  ['shell approval disabled', { source: 'channel' as TaskSource, shellApprovalDisabled: true }],
] as const)(
  'runs managed shell on the caller root while the GFS store needs recovery: %s',
  async (_name, options) => {
    const scenario = await shellScenario(options)
    expect(scenario.store.isAvailable()).toBe(false)
    await scenario.executor.run()

    expect(scenario.onFail).not.toHaveBeenCalled()
    expect(JSON.stringify(scenario.providerCalls)).toContain(scenario.callerWorkspace)
    expect(spawn).toHaveBeenCalledOnce()
  }
)

it('X1: an inherited legacy lease no longer blocks an approved shell or GFS delivery', async () => {
  const scenario = await shellScenario({
    source: 'channel',
    legacyLease: true,
    channelCaller: true,
  })
  expect(scenario.store.isAvailable()).toBe(true)
  await scenario.executor.run()
  expect(scenario.executor.executorState).toBe('waiting_approval')
  expect(scenario.onApprovalNeeded).toHaveBeenCalledTimes(1)
  expect(scenario.advertisedTools[0]).toContain('clerum__gfs_download')
  expect(scenario.advertisedTools[0]).toContain('shell_exec')

  await scenario.executor.resumeAfterApproval(false)

  expect(scenario.onFail).not.toHaveBeenCalled()
  expect(spawn).toHaveBeenCalledOnce()
  const toolResult = JSON.stringify(scenario.providerCalls.at(-1))
  expect(toolResult).toContain(scenario.callerWorkspace)
  expect(toolResult).not.toContain('Processing lease failed')
  expect(toolResult).not.toContain('download_busy')
})

it('X2: a store at corrupt_store_ledger keeps shell and GFS reads but withdraws delivery', async () => {
  const scenario = await shellScenario({
    source: 'cron',
    calls: [
      {
        id: 'gfs-read-large',
        name: 'clerum__gfs_read',
        arguments: { drive: 'main', resourceId: largeResourceId },
      },
      { id: 'shell-safety', name: 'shell_exec', arguments: { command: 'pwd' } },
    ],
  })
  expect(scenario.store.isAvailable()).toBe(false)
  await scenario.executor.run()

  expect(scenario.onFail).not.toHaveBeenCalled()
  const firstTools = scenario.advertisedTools[0]!
  expect(firstTools).toEqual(
    expect.arrayContaining([
      'shell_exec',
      'clerum__gfs_read',
      'clerum__gfs_list',
      'clerum__gfs_stat',
    ])
  )
  expect(firstTools).not.toContain('clerum__gfs_download')
  expect(gfsClient.readMetadata).toHaveBeenCalledOnce()
  expect(gfsClient.download).not.toHaveBeenCalled()
  expect(JSON.stringify(scenario.providerCalls[1])).toContain('workspace_delivery_unavailable')
  expect(spawn).toHaveBeenCalledOnce()
  expect(JSON.stringify(scenario.providerCalls.at(-1))).toContain(scenario.callerWorkspace)
})

it.each([
  ['cron source', { source: 'cron' as TaskSource }],
  ['internal source', { source: 'internal' as TaskSource, approvalEnabled: false }],
  ['approval disabled', { source: 'channel' as TaskSource, approvalEnabled: false }],
  ['shell consent disabled', { source: 'channel' as TaskSource, shellApprovalDisabled: true }],
] as const)(
  'keeps healthy non-GFS shell behavior on the trusted system root: %s',
  async (_name, options) => {
    const scenario = await shellScenario({ ...options, healthy: true })
    await scenario.executor.run()

    expect(scenario.onFail).not.toHaveBeenCalled()
    expect(JSON.stringify(scenario.providerCalls)).toContain(scenario.callerWorkspace)
    expect(spawn).toHaveBeenCalledOnce()
  }
)

it.each(['cron', 'internal'] as const)(
  'denies %s shell when the trusted caller root is absent',
  async source => {
    const scenario = await shellScenario({
      source,
      healthy: true,
      approvalEnabled: false,
      missingCallerRoot: true,
    })
    await scenario.executor.run()

    expect(scenario.onFail).not.toHaveBeenCalled()
    expect(JSON.stringify(scenario.providerCalls)).toContain('no verified caller workspace')
    expect(spawn).not.toHaveBeenCalled()
  }
)
