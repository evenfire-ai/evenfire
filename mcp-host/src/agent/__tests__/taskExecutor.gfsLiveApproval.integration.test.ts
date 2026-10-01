import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { config as appConfig } from '../../config'
import { ConversationManager } from '../../core/conversation/conversation'
import { SimpleEventEmitter } from '../../core/orchestration/eventEmitter'
import { type ChatMessage, FinishReason, type ToolCall } from '../../core/types'
import type { GfsDownloadStore } from '../../internalTools/gfsDownloadStore'
import type { GfsProcessingLeaseProvider } from '../../internalTools/gfsProcessingLease'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import type { SingleTurnProvider } from '../../llm/types'
import type { Task } from '../../queue/types'
import { TaskExecutor, type TaskExecutorDeps, resolveTaskSessionKey } from '../taskExecutor'

const savedConfig = {
  enableApproval: appConfig.enableApproval,
  codexToolPresentation: appConfig.codexToolPresentation,
  dynamicToolsEnabled: appConfig.dynamicToolsEnabled,
  promptCacheEnabled: appConfig.promptCacheEnabled,
}

const processingLeases: GfsProcessingLeaseProvider = {
  acquireProcessingLease: async () => ({
    leaseId: 'gfs-live-approval-lease',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }),
  releaseProcessingLease: async () => undefined,
}

beforeEach(() => {
  Object.assign(appConfig, {
    enableApproval: true,
    codexToolPresentation: 'direct',
    dynamicToolsEnabled: false,
    promptCacheEnabled: false,
  })
})

afterEach(() => {
  Object.assign(appConfig, savedConfig)
})

it('requires live shell approval for GFS processing despite wildcard auto-approval', async () => {
  const shellCall: ToolCall = {
    id: 'gfs-shell-call',
    name: 'shell_exec',
    arguments: { command: 'printf bounded-result' },
  }
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
      providerCalls.push(messages)
      if (providerCalls.length === 1) {
        return {
          content: null,
          tool_calls: [shellCall],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          finish_reason: FinishReason.ToolUse,
        }
      }
      throw new Error('A suspended shell command must not reach another provider round-trip')
    },
  }

  const task: Task = {
    id: 'gfs-live-shell-approval',
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

  const conversationManager = new ConversationManager()
  const conversation = await conversationManager.getOrCreate(resolveTaskSessionKey(task), {
    userId: task.sourceMessage!.sender,
    channelType: task.sourceMessage!.channelType,
    channelId: task.sourceMessage!.channelId,
  })
  conversation.auto_approved_tools = new Set(['*'])

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
    gfsDownloadStore: {} as GfsDownloadStore,
    gfsCallerWorkspacePath: '/tmp/gfs-live-approval-caller',
    gfsProcessingLeaseProvider: processingLeases,
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
  }

  const executor = new TaskExecutor(task, deps)
  await executor.run()

  expect(onFail).not.toHaveBeenCalled()
  expect(executor.executorState).toBe('waiting_approval')
  expect(executor.pendingApproval).toMatchObject({
    tool_name: 'shell_exec',
    tool_call_id: shellCall.id,
  })
  expect(onApprovalNeeded).toHaveBeenCalledTimes(1)
  expect(providerCalls).toHaveLength(1)
})
