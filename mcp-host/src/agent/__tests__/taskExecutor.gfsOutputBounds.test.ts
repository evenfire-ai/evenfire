import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { config as appConfig } from '../../config'
import { ConversationManager } from '../../core/conversation/conversation'
import { SimpleEventEmitter } from '../../core/orchestration/eventEmitter'
import { NoopSafety } from '../../core/safety/__tests__/noopSafety'
import { SpilloverStorage } from '../../core/spillover/storage'
import { type ChatMessage, FinishReason, type ToolCall } from '../../core/types'
import { GfsDownloadStore } from '../../internalTools/gfsDownloadStore'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import type { SingleTurnProvider } from '../../llm/types'
import { SseProgressReporter, progressReporterRegistry } from '../../progress/sseProgressReporter'
import type { SuspendedEvent } from '../../progress/types'
import type { Task } from '../../queue/types'
import { createSessionRouteHandlers } from '../../server/sessionRouteHandlers'
import { resolveCallerRootBinding } from '../../workspace/callerRootBinding'
import { ScopedWorkspaceProvider } from '../../workspace/scopedWorkspace'
import { TaskExecutor, type TaskExecutorDeps, resolveTaskSessionKey } from '../taskExecutor'

const savedConfig = {
  enableApproval: appConfig.enableApproval,
  codexToolPresentation: appConfig.codexToolPresentation,
  dynamicToolsEnabled: appConfig.dynamicToolsEnabled,
  promptCacheEnabled: appConfig.promptCacheEnabled,
  toolSpilloverThresholdBytes: appConfig.toolSpilloverThresholdBytes,
}

let callerWorkspace: string
let hostRoot: string
let store: GfsDownloadStore

beforeEach(async () => {
  hostRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gfs-output-bounds-'))
  store = new GfsDownloadStore(hostRoot)
  await store.initialize()
  Object.assign(appConfig, {
    enableApproval: true,
    codexToolPresentation: 'direct',
    dynamicToolsEnabled: false,
    promptCacheEnabled: false,
  })
})

afterEach(async () => {
  await store.close()
  Object.assign(appConfig, savedConfig)
  fs.rmSync(hostRoot, { recursive: true, force: true })
})

function makeScenario(options: {
  taskId: string
  command: string
  thresholdBytes: number
  spilloverStorage?: SpilloverStorage
  threadId?: string
}) {
  appConfig.toolSpilloverThresholdBytes = options.thresholdBytes
  const shellCall: ToolCall = {
    id: `${options.taskId}-shell-call`,
    name: 'shell_exec',
    arguments: { command: options.command },
  }
  const providerRequests: ChatMessage[][] = []
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
      providerRequests.push(messages)
      if (providerRequests.length === 1) {
        return {
          content: null,
          tool_calls: [shellCall],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          finish_reason: FinishReason.ToolUse,
        }
      }
      return {
        content: 'Processed with bounded output.',
        tool_calls: null,
        usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 },
        finish_reason: FinishReason.Stop,
      }
    },
  }

  const task: Task = {
    id: options.taskId,
    source: 'channel',
    status: 'pending',
    priority: 'normal',
    createdAt: new Date(),
    sourceMessage: {
      sender: 'gfs-caller',
      content: 'Process the governed file',
      channelType: 'rpc',
      channelId: `${options.taskId}-channel`,
      messageId: `${options.taskId}-message`,
      timestamp: new Date().toISOString(),
      hostRef: `${options.taskId}-host`,
      ...(options.threadId ? { threadId: options.threadId } : {}),
    },
    conversationHistory: [
      { role: 'user', content: 'Process the governed file', timestamp: new Date() },
    ],
    responseCallback: vi.fn(async () => undefined),
  }
  const callerBinding = resolveCallerRootBinding(
    new ScopedWorkspaceProvider(hostRoot),
    task.sourceMessage
  )
  if (!callerBinding.root)
    throw new Error(`Test caller binding failed: ${callerBinding.failureCode}`)
  callerWorkspace = callerBinding.root

  const conversationManager = new ConversationManager()
  const sessionKey = resolveTaskSessionKey(task)
  const lifecycle = new TaskLifecycle()
  lifecycle.register(task)
  const progressEvents: string[] = []
  const suspendedEvents: SuspendedEvent[] = []
  const toolStarts: string[] = []
  const reporter = new SseProgressReporter(task.id, lifecycle, NoopSafety)
  reporter.subscribe(event => {
    if (event.type === 'suspended') suspendedEvents.push(event.data)
    if (event.type === 'tool_start') toolStarts.push(event.data.toolName)
    if (event.type === 'tool_progress' && event.data.outputPreview) {
      progressEvents.push(JSON.stringify(event.data.outputPreview))
    }
  })
  progressReporterRegistry.set(task.id, reporter)

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
    },
    config: {
      maxTaskDuration: 300_000,
      maxToolCallsPerTask: 10,
      autoStart: true,
      taskDelay: 0,
      approvalTimeout: 300_000,
    },
    coreEvents: new SimpleEventEmitter(),
    cronScheduler: null,
    taskLifecycle: lifecycle,
    onApprovalNeeded,
    onComplete,
    onFail,
    dynamicEnvProvider: () => ({}),
    spilloverStorage: options.spilloverStorage,
  }

  return {
    shellCall,
    providerRequests,
    conversationManager,
    sessionKey,
    progressEvents,
    suspendedEvents,
    toolStarts,
    create: () => new TaskExecutor(task, deps),
    dispose: () => {
      progressReporterRegistry.delete(task.id)
      reporter.dispose()
    },
    run: async () => {
      const executor = new TaskExecutor(task, deps)
      await executor.run()
      return executor
    },
  }
}

function finalToolMessage(requests: ChatMessage[][]): ChatMessage {
  const message = requests.at(-1)?.find(item => item.role === 'tool')
  expect(message).toBeDefined()
  return message!
}

function assertPreviewBeforeExecution(
  scenario: ReturnType<typeof makeScenario>,
  executor: TaskExecutor
) {
  expect(scenario.suspendedEvents).toHaveLength(1)
  expect(scenario.suspendedEvents[0]).toMatchObject({
    requestId: executor.pendingApproval!.request_id,
    inputPreview: { text: scenario.shellCall.arguments.command, truncated: false },
  })
  expect(scenario.toolStarts).toEqual([])
  expect(executor.pendingApproval!.parameters).toEqual(scenario.shellCall.arguments)
  expect(executor.pendingApproval).not.toHaveProperty('inputPreview')
}

it('keeps failed GFS shell output bounded with spillover disabled', async () => {
  const proofFile = 'gfs-output-proof.txt'
  const scenario = makeScenario({
    taskId: 'gfs-shell-output-bounds',
    thresholdBytes: 2 * 1024 * 1024,
    command:
      `node -e "require('fs').writeFileSync('${proofFile}','verified');` +
      `process.stdout.write('x'.repeat(1536 * 1024))"`,
  })

  try {
    const executor = await scenario.run()
    expect(executor.executorState).toBe('waiting_approval')
    expect(fs.existsSync(path.join(callerWorkspace, proofFile))).toBe(false)
    assertPreviewBeforeExecution(scenario, executor)

    await executor.resumeAfterApproval(false)

    expect(executor.executorState).toBe('completed')
    expect(fs.readFileSync(path.join(callerWorkspace, proofFile), 'utf8')).toBe('verified')
    expect(scenario.providerRequests).toHaveLength(2)
    expect(
      Buffer.byteLength(JSON.stringify(finalToolMessage(scenario.providerRequests)), 'utf8')
    ).toBeLessThanOrEqual(1024 * 1024)
    expect(JSON.stringify(finalToolMessage(scenario.providerRequests))).toContain(
      'output_limit_exceeded'
    )
    expect(Buffer.byteLength(scenario.progressEvents.join(''), 'utf8')).toBeLessThanOrEqual(
      64 * 1024
    )

    const conversation = scenario.conversationManager.getStore().get(scenario.sessionKey)
    expect(conversation).toBeDefined()
    expect(Buffer.byteLength(JSON.stringify(conversation!.turns), 'utf8')).toBeLessThanOrEqual(
      1024 * 1024 + 64 * 1024
    )
    expect(JSON.stringify(conversation!.turns)).not.toContain('x'.repeat(8192))
  } finally {
    scenario.dispose()
  }
})

it('replaces successful oversized GFS shell output with a spillover summary', async () => {
  const storage = new SpilloverStorage({
    workspacePath: callerWorkspace,
    ttlMs: 300_000,
    thresholdBytes: 8192,
    gcIntervalMs: 0,
  })
  const scenario = makeScenario({
    taskId: 'gfs-shell-spillover-enabled',
    thresholdBytes: 8192,
    spilloverStorage: storage,
    command: `node -e "process.stdout.write('y'.repeat(16384))"`,
  })

  try {
    const executor = await scenario.run()
    await executor.resumeAfterApproval(false)

    expect(executor.executorState).toBe('completed')
    expect(scenario.providerRequests).toHaveLength(2)
    const toolMessage = finalToolMessage(scenario.providerRequests)
    expect(toolMessage.content).toContain('"spillover_ref"')
    expect(toolMessage.content).toContain('spillover://gfs-shell-spillover-enabled/')
    expect(toolMessage.content).not.toContain('y'.repeat(401))
    expect(Buffer.byteLength(toolMessage.content, 'utf8')).toBeLessThanOrEqual(4096)
  } finally {
    scenario.dispose()
  }
})

it('falls back to bounded inline output when spillover persistence fails', async () => {
  const storage = new SpilloverStorage({
    workspacePath: callerWorkspace,
    ttlMs: 300_000,
    thresholdBytes: 8192,
    gcIntervalMs: 0,
  })
  const persistError = new Error('fixture spillover store unavailable')
  vi.spyOn(storage, 'maybePersist').mockRejectedValue(persistError)
  const scenario = makeScenario({
    taskId: 'gfs-shell-spillover-failing',
    thresholdBytes: 8192,
    spilloverStorage: storage,
    command: `node -e "process.stdout.write('z'.repeat(16384))"`,
  })

  try {
    const executor = await scenario.run()
    await executor.resumeAfterApproval(false)

    expect(executor.executorState).toBe('completed')
    expect(scenario.providerRequests).toHaveLength(2)
    const toolMessage = finalToolMessage(scenario.providerRequests)
    expect(toolMessage.spillover_ref).toBeUndefined()
    expect(toolMessage.content).toContain('z'.repeat(1024))
    expect(Buffer.byteLength(toolMessage.content, 'utf8')).toBeLessThanOrEqual(32 * 1024)
  } finally {
    scenario.dispose()
    vi.restoreAllMocks()
  }
})

it('cancels before shell execution and performs no second provider round-trip', async () => {
  const proofFile = 'gfs-cancel-proof.txt'
  const scenario = makeScenario({
    taskId: 'gfs-shell-cancellation',
    thresholdBytes: 2 * 1024 * 1024,
    command:
      `node -e "require('fs').writeFileSync('${proofFile}','cancelled');` +
      `process.stdout.write('x'.repeat(1536 * 1024))"`,
  })

  try {
    const executor = await scenario.run()
    expect(executor.executorState).toBe('waiting_approval')
    assertPreviewBeforeExecution(scenario, executor)
    executor.abort()
    await executor.resumeAfterApproval(false)

    expect(executor.signal.aborted).toBe(true)
    expect(fs.existsSync(path.join(callerWorkspace, proofFile))).toBe(false)
    expect(scenario.providerRequests).toHaveLength(1)
  } finally {
    scenario.dispose()
  }
})

it('denies shell approval without executing the command', async () => {
  const proofFile = 'gfs-denial-proof.txt'
  const responsePayloads: string[] = []
  const scenario = makeScenario({
    taskId: 'gfs-shell-denial',
    thresholdBytes: 2 * 1024 * 1024,
    command: `node -e "require('fs').writeFileSync('${proofFile}','denied')"`,
  })
  try {
    const executor = await scenario.run()
    expect(executor.executorState).toBe('waiting_approval')
    assertPreviewBeforeExecution(scenario, executor)
    executor.sourceTask.responseCallback = async payload => {
      if (payload.response) responsePayloads.push(payload.response)
    }

    await executor.deny()

    expect(executor.executorState).toBe('completed')
    expect(fs.existsSync(path.join(callerWorkspace, proofFile))).toBe(false)
    expect(scenario.providerRequests).toHaveLength(1)
    expect(responsePayloads.join('\n')).toContain('was denied by the user')
  } finally {
    scenario.dispose()
  }
})

it('rehydrates a waiting GFS shell approval into a fresh executor', async () => {
  const proofFile = 'gfs-cold-resume-proof.txt'
  const scenario = makeScenario({
    taskId: 'gfs-shell-cold-resume',
    threadId: 'preview-cold-chat',
    thresholdBytes: 2 * 1024 * 1024,
    command: `node -e "require('fs').writeFileSync('${proofFile}','resumed')"`,
  })

  try {
    const first = await scenario.run()
    expect(first.executorState).toBe('waiting_approval')
    const approval = first.pendingApproval
    expect(approval).toBeDefined()
    expect(approval!.task_budget).toBeDefined()
    assertPreviewBeforeExecution(scenario, first)
    const handlers = createSessionRouteHandlers({
      getConversationManager: () => scenario.conversationManager,
      redactToolError: (_tool, text) => text,
      redactTitle: text => text,
    })
    const snapshot = await handlers.handleSessionMessages(
      'gfs-caller',
      'gfs-shell-cold-resume-channel',
      'preview-cold-chat',
      {}
    )
    expect(snapshot?.pendingApproval).toMatchObject({
      requestId: approval!.request_id,
      inputPreview: { text: scenario.shellCall.arguments.command, truncated: false },
    })
    expect(
      await handlers.handleSessionMessages(
        'another-caller',
        'gfs-shell-cold-resume-channel',
        'preview-cold-chat',
        {}
      )
    ).toBeNull()

    const second = scenario.create()
    await second.rehydrateWaitingApproval(scenario.sessionKey, approval!)
    expect(second.executorState).toBe('waiting_approval')
    expect(second.pendingApproval!.request_id).toBe(approval!.request_id)
    expect(second.pendingApproval!.parameters).toEqual(scenario.shellCall.arguments)
    expect(fs.existsSync(path.join(callerWorkspace, proofFile))).toBe(false)
    await second.resumeAfterApproval(false)

    expect(second.executorState).toBe('completed')
    expect(fs.readFileSync(path.join(callerWorkspace, proofFile), 'utf8')).toBe('resumed')
    expect(scenario.providerRequests).toHaveLength(2)
  } finally {
    scenario.dispose()
  }
})
