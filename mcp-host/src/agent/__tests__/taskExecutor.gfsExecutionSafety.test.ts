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
import { TaskExecutor, type TaskExecutorDeps } from '../taskExecutor'

vi.mock('child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('child_process')>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})

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
  missingCallerRoot = false,
}: {
  source: TaskSource
  approvalEnabled?: boolean
  shellApprovalDisabled?: boolean
  healthy?: boolean
  missingCallerRoot?: boolean
}) {
  appConfig.enableApproval = approvalEnabled
  const { root, store } = healthy ? await healthyStore() : await unavailableStore()
  const callerWorkspace = join(root, 'users', '_system')
  await fs.mkdir(callerWorkspace, { recursive: true, mode: 0o700 })
  const call: ToolCall = { id: 'shell-safety', name: 'shell_exec', arguments: { command: 'pwd' } }
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
      return {
        content: providerCalls.length === 1 ? null : 'Shell finished.',
        tool_calls: providerCalls.length === 1 ? [call] : null,
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        finish_reason: providerCalls.length === 1 ? FinishReason.ToolUse : FinishReason.Stop,
      }
    },
  }
  const task: Task = {
    id: '22222222-2222-4222-8222-222222222222',
    source,
    status: 'pending',
    priority: 'normal',
    createdAt: new Date(),
    conversationHistory: [{ role: 'user', content: 'run pwd', timestamp: new Date() }],
    responseCallback: vi.fn(async () => undefined),
  }
  const lifecycle = new TaskLifecycle()
  lifecycle.register(task)
  const onFail = vi.fn()
  const deps: TaskExecutorDeps = {
    conversationManager: new ConversationManager(),
    llmProvider: provider,
    mcpManager: null,
    workspaceService: undefined,
    gfsDownloadStore: store,
    gfsCallerWorkspacePath: missingCallerRoot ? undefined : callerWorkspace,
    gfsProcessingLeaseProvider: store.processingLeaseProvider('_system'),
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
    onApprovalNeeded: vi.fn(),
    onComplete: vi.fn(),
    onFail,
    dynamicEnvProvider: () => ({}),
  }
  return { executor: new TaskExecutor(task, deps), providerCalls, onFail, callerWorkspace }
}

it.each([
  ['cron source', { source: 'cron' as TaskSource }],
  ['internal source', { source: 'internal' as TaskSource, approvalEnabled: false }],
  ['approval disabled', { source: 'channel' as TaskSource, approvalEnabled: false }],
  ['shell approval disabled', { source: 'channel' as TaskSource, shellApprovalDisabled: true }],
] as const)('denies managed shell during GFS recovery: %s', async (_name, options) => {
  const scenario = await shellScenario(options)
  await scenario.executor.run()

  expect(scenario.onFail).not.toHaveBeenCalled()
  expect(JSON.stringify(scenario.providerCalls)).toContain('Processing lease failed')
  expect(vi.mocked(spawn)).not.toHaveBeenCalled()
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
