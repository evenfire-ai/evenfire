import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { config as appConfig } from '../../config'
import { LlmPortAdapter } from '../../core/adapters/llmPortAdapter'
import { makeFakeConversation } from '../../core/conversation/__testing__/makeFakeConversation'
import { ConversationManager } from '../../core/conversation/conversation'
import { LlmError, LlmErrorCode } from '../../core/errors'
import { PressureContextManager } from '../../core/extensions/contextManager'
import { SimpleEventEmitter } from '../../core/orchestration/eventEmitter'
import { parseCodexToolPresentation } from '../../core/orchestration/toolPresentationPolicy'
import { executeSingleTool, runToolUseLoop } from '../../core/orchestration/toolUseLoop'
import { TOOL_DISCOVERY_TEXT } from '../../core/reasoning/promptBuilder'
import { registerDesktopTools } from '../../core/tools/desktopTools'
import {
  requestEffectiveWorkflowList,
  resolveEffectiveWorkflowTarget,
} from '../../core/tools/workflowEffectiveTargets'
import type { Attachment, ChatMessage, MessageContentPart, TraceContextV1 } from '../../core/types'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import { anthropicApiError } from '../../llm/__tests__/sdkErrorFixtures'
import { ClaudeProvider } from '../../llm/claude'
import { FailoverEngine } from '../../llm/failover/engine'
import type { LlmPolicy } from '../../llm/failover/types'
import { OpenAIProvider } from '../../llm/openai'
import { PromptCache } from '../../llm/promptCache'
import { logger } from '../../logger'
import type { Task, TaskError, TaskSource } from '../../queue/types'
import { resolveProviderWorkflowCallerContext } from '../../workflow/providerWorkflowCallerContextClient'
import { TaskExecutor, type TaskExecutorDeps, executionModeForSource } from '../taskExecutor'

vi.mock('../../config', () => ({
  config: {
    devMode: true,
    dynamicToolsEnabled: false,
    dynamicToolsThreshold: 60,
    codexToolPresentation: 'auto',
    codexToolDiscoveryBytes: 32768,
    enableApproval: false,
    nudgeMaxIterations: 3,
    devModelName: 'test-model',
    devModelProvider: 'openai',
    contextMaxTokens: 100000,
    nativeTool: {
      workspacePath: '/tmp',
      shellTimeout: 5000,
      maxOutputLength: 10000,
      enableShell: false,
    },
  },
}))

vi.mock('../../core/orchestration/toolUseLoop', () => ({
  runToolUseLoop: vi.fn(),
  executeSingleTool: vi.fn(),
  validateToolLinkages: vi.fn(),
  extractInputPreview: vi.fn().mockReturnValue(''),
  buildOutputPreview: vi.fn((content: string) =>
    content ? { headLines: [content], tailLines: [], totalLines: 1, truncated: false } : undefined
  ),
}))

vi.mock('../../core/tools/desktopTools', () => ({
  registerDesktopTools: vi.fn(),
}))

vi.mock('../../workflow/providerWorkflowCallerContextClient', () => ({
  resolveProviderWorkflowCallerContext: vi.fn(),
}))

vi.mock('../../core/tools/workflowEffectiveTargets', async importOriginal => {
  const actual = await importOriginal<typeof import('../../core/tools/workflowEffectiveTargets')>()
  return {
    ...actual,
    requestEffectiveWorkflowList: vi.fn(),
    resolveEffectiveWorkflowTarget: vi.fn(),
  }
})

function createTask(content: string = 'Test', sender: string = 'user-1'): Task {
  return {
    id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    source: 'channel',
    sourceMessage: {
      sender,
      content,
      channelType: 'telegram',
      channelId: 'test-channel',
      messageId: 'msg-1',
      timestamp: new Date().toISOString(),
      hostRef: 'test-host',
    },
    priority: 'normal',
    status: 'pending',
    conversationHistory: [{ role: 'user', content, timestamp: new Date() }],
    responseCallback: vi.fn(async () => {}),
    createdAt: new Date(),
  }
}

function createDeps(overrides?: Partial<TaskExecutorDeps>): TaskExecutorDeps {
  return {
    conversationManager: new ConversationManager(),
    llmProvider: {
      completeSingleTurn: vi.fn(),
      completeSingleTurnWithTools: vi.fn(),
      getProviderType: () => 'openai' as const,
    } as any,
    mcpManager: { getAllTools: () => [], callTool: vi.fn() } as any,
    workspaceService: undefined,
    config: {
      maxTaskDuration: 300000,
      maxToolCallsPerTask: 10,
      autoStart: true,
      taskDelay: 0,
      approvalTimeout: 300000,
    },
    modelName: 'test-model',
    approvalConfig: undefined,
    coreEvents: new SimpleEventEmitter(),
    cronScheduler: null,
    taskLifecycle: new TaskLifecycle(),
    onApprovalNeeded: vi.fn(),
    onComplete: vi.fn(),
    onFail: vi.fn(),
    ...overrides,
  }
}

function getLastUserMessageFromLoopCall(): ChatMessage {
  const call = vi.mocked(runToolUseLoop).mock.calls.at(-1)
  const messages = (call?.[1] ?? []) as ChatMessage[]
  const userMessage = [...messages].reverse().find(message => message.role === 'user')
  if (!userMessage) {
    throw new Error('Expected at least one user message in runToolUseLoop call')
  }
  return userMessage
}

function createImageAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: 'att-1',
    kind: 'image',
    mimeType: 'image/jpeg',
    encoding: 'base64',
    dataBase64: 'ZmFrZS1pbWFnZS1iYXNlNjQ=',
    filename: 'image.jpg',
    ...overrides,
  }
}

const workflowEnvKeys = [
  'MCP_HOST_GATEWAY_URL',
  'MCP_HOST_WORKFLOW_CONTROL_TOKEN',
  'MCP_HOST_RUNTIME_ACCESS_TOKEN',
  'MCP_HOST_RUNTIME_REFRESH_TOKEN',
] as const

function enableWorkflowProcessEnv(): () => void {
  const previous = new Map(workflowEnvKeys.map(key => [key, process.env[key]]))
  process.env.MCP_HOST_GATEWAY_URL = 'http://gateway:8092'
  process.env.MCP_HOST_WORKFLOW_CONTROL_TOKEN = 'workflow-token'
  process.env.MCP_HOST_RUNTIME_ACCESS_TOKEN = 'runtime-access'
  process.env.MCP_HOST_RUNTIME_REFRESH_TOKEN = 'runtime-refresh'
  return () => {
    for (const key of workflowEnvKeys) {
      const value = previous.get(key)
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
}

function attachTelegramProviderIdentity(task: Task): void {
  task.sourceMessage!.providerIdentity = {
    medium: 'telegram',
    providerUserId: 'tg-user-1',
    providerChannelId: 'test-channel',
  }
}

function attachSlackProviderIdentity(task: Task): void {
  task.sourceMessage!.channelType = 'slack'
  task.sourceMessage!.channelId = 'slack-channel'
  task.sourceMessage!.providerIdentity = {
    medium: 'slack',
    providerUserId: 'slack-user-1',
    providerWorkspaceId: 'slack-workspace-1',
    providerChannelId: 'slack-channel',
  }
}

function attachTeamsProviderIdentity(task: Task): void {
  task.sourceMessage!.channelType = 'teams'
  task.sourceMessage!.channelId = 'teams-conversation'
  task.sourceMessage!.threadId = 'teams-thread-1'
  task.sourceMessage!.providerIdentity = {
    medium: 'teams',
    providerUserId: 'teams-user-1',
    providerWorkspaceId: 'teams-tenant-1',
    providerChannelId: 'teams-conversation',
    providerEventId: 'teams:teams-tenant-1:teams-conversation:activity-1',
  }
}

describe('TaskExecutor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(requestEffectiveWorkflowList).mockReset()
    vi.mocked(resolveEffectiveWorkflowTarget).mockReset()
    vi.mocked(registerDesktopTools).mockResolvedValue(undefined)
  })

  it('should execute a task and call onComplete', async () => {
    ;(runToolUseLoop as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      type: 'response',
      content: 'Hello!',
    })

    const deps = createDeps()
    const task = createTask('Hello')
    const executor = new TaskExecutor(task, deps)

    await executor.run()

    expect(executor.executorState).toBe('completed')
    expect(registerDesktopTools).toHaveBeenCalledTimes(1)
    expect(deps.onComplete).toHaveBeenCalledWith(task)
    expect(task.responseCallback).toHaveBeenCalled()
  })

  it('enriches channel trace context with the persisted conversation id', async () => {
    ;(runToolUseLoop as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      type: 'response',
      content: 'Hello!',
    })
    const traceContext = {
      version: 1,
      runId: 'run-task-executor',
      origin: 'channel_event',
      correlationRefs: ['message:msg-1'],
    } satisfies TraceContextV1
    const conversationManager = new ConversationManager()
    const startTurn = vi.spyOn(conversationManager, 'startTurn')
    const deps = createDeps({ conversationManager })
    const task = createTask('Hello')
    task.traceContext = traceContext

    await new TaskExecutor(task, deps).run()

    expect(startTurn).toHaveBeenCalledWith(
      expect.any(Object),
      'Hello',
      task.id,
      expect.objectContaining({
        ...traceContext,
        sessionId: expect.stringMatching(/^conv-user-1:telegram:test-channel:default-/),
      }),
      // spec 15 — turn 1 derives the auto-title from the first input (channel
      // sessions included); a short input passes through deriveAutoTitle intact.
      'Hello'
    )
    expect(task.traceContext?.sessionId).toMatch(/^conv-user-1:telegram:test-channel:default-/)
  })

  it('should call onFail when execution throws', async () => {
    ;(runToolUseLoop as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('LLM down'))

    const deps = createDeps()
    const task = createTask('Hello')
    const executor = new TaskExecutor(task, deps)

    await executor.run()

    expect(executor.executorState).toBe('failed')
    expect(deps.onFail).toHaveBeenCalledWith(
      task,
      expect.objectContaining({
        code: 'LLM_API_CALL_FAILED',
        message: 'LLM down',
        retryable: true,
        provider: 'openai',
      })
    )
  })

  it('surfaces a provider 404 as a non-retryable LLM_MODEL_NOT_AVAILABLE TaskError', async () => {
    // Derive the LlmError from the real Claude classifier fed a real
    // Anthropic.APIError (not a hand-built shape), then wrap it exactly as
    // LlmPortAdapter.handleProviderError does, so the observable TaskError
    // carries the classified code + additive fields (incl. the correctly-nested
    // providerCode='not_found_error', not the envelope's 'error').
    const provider = new ClaudeProvider('fake-key', 'claude-sonnet-4-6')
    const err404 = anthropicApiError(404, 'not_found_error', 'model: x not found')
    const c = provider.classifyError(err404)
    const llmError = new LlmError(
      c.message,
      'claude',
      c.code,
      c.retryable,
      undefined,
      c.httpStatus,
      c.providerCode
    )
    ;(runToolUseLoop as ReturnType<typeof vi.fn>).mockRejectedValueOnce(llmError)

    const deps = createDeps()
    const task = createTask('Hello')
    const executor = new TaskExecutor(task, deps)

    await executor.run()

    expect(executor.executorState).toBe('failed')
    expect(deps.onFail).toHaveBeenCalledWith(
      task,
      expect.objectContaining({
        code: 'LLM_MODEL_NOT_AVAILABLE',
        retryable: false,
        provider: 'claude',
        httpStatus: 404,
        providerCode: 'not_found_error',
      })
    )
  })

  it('should enter waiting_approval and call onApprovalNeeded', async () => {
    ;(runToolUseLoop as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      type: 'need_approval',
      approval: {
        request_id: 'req-1',
        tool_name: 'shell_exec',
        parameters: { command: 'ls' },
        description: 'Shell command',
        tool_call_id: 'tc_1',
        context_snapshot: [],
      },
    })

    const deps = createDeps()
    const task = createTask('Run a command')
    const executor = new TaskExecutor(task, deps)

    await executor.run()

    expect(executor.executorState).toBe('waiting_approval')
    expect(deps.onApprovalNeeded).toHaveBeenCalledWith(
      'req-1',
      task.id,
      expect.objectContaining({ request_id: 'req-1' })
    )
  })

  it('should expose pendingApproval when awaiting', async () => {
    ;(runToolUseLoop as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      type: 'need_approval',
      approval: {
        request_id: 'req-2',
        tool_name: 'file_write',
        parameters: {},
        description: 'Write file',
        tool_call_id: 'tc_2',
        context_snapshot: [],
      },
    })

    const deps = createDeps()
    const task = createTask()
    const executor = new TaskExecutor(task, deps)

    await executor.run()

    expect(executor.pendingApproval).toBeDefined()
    expect(executor.pendingApproval?.request_id).toBe('req-2')
  })

  it('runs normal provider chat when workflow identity is not verified', async () => {
    const restoreEnv = enableWorkflowProcessEnv()
    vi.mocked(resolveProviderWorkflowCallerContext).mockResolvedValueOnce(null)
    vi.mocked(runToolUseLoop).mockResolvedValueOnce({
      type: 'response',
      content: 'Normal chat response',
    } as any)

    try {
      const deps = createDeps()
      const task = createTask('Hello, summarize this conversation')
      attachTelegramProviderIdentity(task)
      const executor = new TaskExecutor(task, deps)

      await executor.run()

      expect(resolveProviderWorkflowCallerContext).toHaveBeenCalledTimes(1)
      expect(runToolUseLoop).toHaveBeenCalledTimes(1)
      const loopConfig = vi.mocked(runToolUseLoop).mock.calls[0][0] as any
      const toolNames = loopConfig.toolRegistry.listDefinitions().map((def: any) => def.name)
      expect(toolNames).not.toContain('workflow_list')
      expect(toolNames).not.toContain('workflow_trigger')
      expect(task.responseCallback).toHaveBeenCalledWith({
        response: 'Normal chat response',
        attachments: undefined,
      })
    } finally {
      restoreEnv()
    }
  })

  it('fails closed without running tools when an unverified provider asks to list workflows', async () => {
    vi.mocked(resolveProviderWorkflowCallerContext).mockResolvedValueOnce(null)

    const deps = createDeps()
    const task = createTask('List the workflow recipes I can run.')
    attachTelegramProviderIdentity(task)
    const executor = new TaskExecutor(task, deps)

    await executor.run()

    expect(runToolUseLoop).not.toHaveBeenCalled()
    expect(deps.onApprovalNeeded).not.toHaveBeenCalled()
    expect(deps.onComplete).toHaveBeenCalledWith(task)
    expect(task.responseCallback).toHaveBeenCalledWith({
      response:
        'Could not verify this Telegram conversation for workflow access. Use the verified Telegram conversation connected to your Clerum account, then list workflows again.',
    })
  })

  it('treats available-workflows wording as workflow listing for unverified providers', async () => {
    vi.mocked(resolveProviderWorkflowCallerContext).mockResolvedValueOnce(null)

    const deps = createDeps()
    const task = createTask('what workflows are available?')
    attachTelegramProviderIdentity(task)
    const executor = new TaskExecutor(task, deps)

    await executor.run()

    expect(runToolUseLoop).not.toHaveBeenCalled()
    expect(task.responseCallback).toHaveBeenCalledWith({
      response:
        'Could not verify this Telegram conversation for workflow access. Use the verified Telegram conversation connected to your Clerum account, then list workflows again.',
    })
  })

  it('allows generic workflow explanation prompts for unverified providers', async () => {
    vi.mocked(resolveProviderWorkflowCallerContext).mockResolvedValueOnce(null)
    vi.mocked(runToolUseLoop).mockResolvedValueOnce({
      type: 'response',
      content: 'A workflow is an automated process.',
    } as any)

    const deps = createDeps()
    const task = createTask('what is a workflow?')
    attachTelegramProviderIdentity(task)
    const executor = new TaskExecutor(task, deps)

    await executor.run()

    expect(runToolUseLoop).toHaveBeenCalledTimes(1)
    expect(task.responseCallback).toHaveBeenCalledWith({
      response: 'A workflow is an automated process.',
      attachments: undefined,
    })
  })

  it('fails closed when a provider channel asks for workflows without provider identity', async () => {
    const deps = createDeps()
    const task = createTask('List workflows')
    const executor = new TaskExecutor(task, deps)

    await executor.run()

    expect(resolveProviderWorkflowCallerContext).not.toHaveBeenCalled()
    expect(runToolUseLoop).not.toHaveBeenCalled()
    expect(task.responseCallback).toHaveBeenCalledWith({
      response:
        'Could not verify this Telegram conversation for workflow access. Use the verified Telegram conversation connected to your Clerum account, then list workflows again.',
    })
  })

  it('uses Slack-specific workflow verification copy without adding Slack E2E coverage', async () => {
    vi.mocked(resolveProviderWorkflowCallerContext).mockResolvedValueOnce(null)

    const deps = createDeps()
    const task = createTask('List workflows')
    attachSlackProviderIdentity(task)
    const executor = new TaskExecutor(task, deps)

    await executor.run()

    expect(runToolUseLoop).not.toHaveBeenCalled()
    expect(task.responseCallback).toHaveBeenCalledWith({
      response:
        'Could not verify this Slack workspace conversation for workflow access. Use the verified Slack workspace conversation connected to your Clerum account, then list workflows again.',
    })
  })

  it('uses Teams-specific workflow verification copy for unverified Teams conversations', async () => {
    vi.mocked(resolveProviderWorkflowCallerContext).mockResolvedValueOnce(null)

    const deps = createDeps()
    const task = createTask('List workflows')
    attachTeamsProviderIdentity(task)
    const executor = new TaskExecutor(task, deps)

    await executor.run()

    expect(resolveProviderWorkflowCallerContext).toHaveBeenCalledTimes(1)
    expect(runToolUseLoop).not.toHaveBeenCalled()
    expect(task.responseCallback).toHaveBeenCalledWith({
      response:
        'Could not verify this Microsoft Teams conversation for workflow access. Use the verified Teams conversation connected to your Clerum account, then list workflows again.',
    })
  })

  it('exposes workflow tools for verified Teams provider messages', async () => {
    const restoreEnv = enableWorkflowProcessEnv()
    vi.mocked(resolveProviderWorkflowCallerContext).mockResolvedValueOnce({
      targetUserId: '00000000-0000-4000-8000-000000000001',
      conversationId: 'teams-thread-1',
      originChannelType: 'teams',
      providerUserId: 'teams-user-1',
      providerWorkspaceId: 'teams-tenant-1',
      providerChannelId: 'teams-conversation',
      providerEventId: 'teams:teams-tenant-1:teams-conversation:activity-1',
      sourceThreadId: 'teams-thread-1',
      sourceMessageContent: 'Run research-summary-workflow topic "the first pokemon"',
    })
    vi.mocked(runToolUseLoop).mockImplementationOnce(async (loopConfig: any) => {
      loopConfig.events.emit({
        type: 'tool:called',
        data: { toolName: 'workflow_trigger' },
        timestamp: new Date(),
      })
      return {
        type: 'response',
        content: 'I can run that workflow.',
      } as any
    })

    try {
      const deps = createDeps()
      const task = createTask('Run research-summary-workflow topic "the first pokemon"')
      attachTeamsProviderIdentity(task)
      const executor = new TaskExecutor(task, deps)

      await executor.run()

      expect(resolveProviderWorkflowCallerContext).toHaveBeenCalledTimes(1)
      expect(runToolUseLoop).toHaveBeenCalledTimes(1)
      const loopConfig = vi.mocked(runToolUseLoop).mock.calls[0][0] as any
      const toolNames = loopConfig.toolRegistry.listDefinitions().map((def: any) => def.name)
      expect(toolNames).toContain('workflow_list')
      expect(toolNames).toContain('workflow_trigger')
      expect(task.responseCallback).toHaveBeenCalledWith({
        response: 'I can run that workflow.',
        attachments: undefined,
      })
    } finally {
      restoreEnv()
    }
  })

  it('fails closed for unverified provider workflow trigger requests before the loop', async () => {
    vi.mocked(resolveProviderWorkflowCallerContext).mockResolvedValueOnce(null)

    const deps = createDeps()
    const task = createTask('Run risk-review with marker alpha')
    attachTelegramProviderIdentity(task)
    const executor = new TaskExecutor(task, deps)

    await executor.run()

    expect(runToolUseLoop).not.toHaveBeenCalled()
    expect(task.responseCallback).toHaveBeenCalledWith({
      response:
        'Could not verify this Telegram conversation for workflow access. Use the verified Telegram conversation connected to your Clerum account, then list workflows again.',
    })
  })

  it('replaces unverified provider workflow trigger claims with verification copy', async () => {
    vi.mocked(resolveProviderWorkflowCallerContext).mockResolvedValueOnce(null)
    vi.mocked(runToolUseLoop).mockResolvedValueOnce({
      type: 'response',
      content: 'The workflow risk-review has been triggered and is currently pending.',
    } as any)

    const deps = createDeps()
    const task = createTask('Can you help me with this request?')
    attachTelegramProviderIdentity(task)
    const executor = new TaskExecutor(task, deps)

    await executor.run()

    expect(runToolUseLoop).toHaveBeenCalledTimes(1)
    expect(task.responseCallback).toHaveBeenCalledWith({
      response:
        'Could not verify this Telegram conversation for workflow access. Use the verified Telegram conversation connected to your Clerum account, then list workflows again.',
      attachments: undefined,
    })
  })

  it('emits a terminal progress event for provider identity fail-closed responses', async () => {
    vi.mocked(resolveProviderWorkflowCallerContext).mockResolvedValueOnce(null)

    const taskLifecycle = new TaskLifecycle()
    const onComplete = vi.fn((task: Task) => {
      taskLifecycle.transition(task.id, 'completed', 'natural', {
        response: task.result?.response,
      })
    })
    const deps = createDeps({ taskLifecycle, onComplete })
    const task = createTask('List workflows')
    attachTelegramProviderIdentity(task)
    taskLifecycle.register(task)
    taskLifecycle.transition(task.id, 'processing', 'dispatched')
    const executor = new TaskExecutor(task, deps)

    await executor.run()

    const { progressReporterRegistry } = await import('../../progress/sseProgressReporter.js')
    const reporter = progressReporterRegistry.get(executor.taskId)
    expect(reporter).toBeDefined()
    const events: Array<{ type: string; data: any }> = []
    reporter!.subscribe(e => events.push(e))

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'terminal',
        data: expect.objectContaining({
          taskId: executor.taskId,
          status: 'completed',
        }),
      })
    )
  })

  it('turns provider trigger claims without workflow_trigger into effective-target clarification', async () => {
    vi.mocked(resolveProviderWorkflowCallerContext).mockResolvedValueOnce({
      targetUserId: '00000000-0000-4000-8000-000000000001',
      conversationId: 'telegram:test-channel:user-1',
      originChannelType: 'telegram',
      sourceMessageContent: 'Run risk-review with marker alpha',
    })
    vi.mocked(requestEffectiveWorkflowList).mockResolvedValueOnce({
      items: [{ name: 'risk-review' }],
    })
    vi.mocked(resolveEffectiveWorkflowTarget).mockResolvedValueOnce({
      kind: 'ambiguous',
      message:
        'risk-review is available for multiple targets: Personal, Treasury. Ask the user to choose one of these labels.',
      targets: [
        { kind: 'user', label: 'Personal' },
        { kind: 'team', label: 'Treasury' },
      ],
    })
    vi.mocked(runToolUseLoop).mockResolvedValueOnce({
      type: 'response',
      content: 'The workflow risk-review has been triggered and is currently in the Pending phase.',
    } as any)

    const deps = createDeps()
    const task = createTask('Run risk-review with marker alpha')
    task.sourceMessage!.providerIdentity = {
      medium: 'telegram',
      providerUserId: 'tg-user-1',
      providerChannelId: 'test-channel',
    }
    const executor = new TaskExecutor(task, deps)

    await executor.run()

    expect(runToolUseLoop).toHaveBeenCalledTimes(1)
    expect(resolveEffectiveWorkflowTarget).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        targetUserId: '00000000-0000-4000-8000-000000000001',
        conversationId: 'telegram:test-channel:user-1',
      }),
      'risk-review'
    )
    expect(deps.onApprovalNeeded).not.toHaveBeenCalled()
    expect(task.responseCallback).toHaveBeenCalledWith({
      response:
        'risk-review is available for multiple targets: Personal, Treasury. Ask the user to choose one of these labels.',
      attachments: undefined,
    })
  })

  it('fails closed for provider trigger requests when the model does not call workflow_trigger', async () => {
    vi.mocked(resolveProviderWorkflowCallerContext).mockResolvedValueOnce({
      targetUserId: '00000000-0000-4000-8000-000000000001',
      conversationId: 'telegram:test-channel:user-1',
      originChannelType: 'telegram',
      sourceMessageContent: 'Run membership-only with marker alpha',
    })
    vi.mocked(requestEffectiveWorkflowList).mockResolvedValueOnce({
      items: [{ name: 'risk-review' }],
    })
    vi.mocked(resolveEffectiveWorkflowTarget).mockResolvedValueOnce({
      kind: 'none',
      message: 'membership-only is not available for this conversation target.',
    })
    vi.mocked(runToolUseLoop).mockResolvedValueOnce({
      type: 'response',
      content: 'I found the available workflows. membership-only is not in your visible list.',
    } as any)

    const deps = createDeps()
    const task = createTask('Run membership-only with marker alpha')
    task.sourceMessage!.providerIdentity = {
      medium: 'telegram',
      providerUserId: 'tg-user-1',
      providerChannelId: 'test-channel',
    }
    const executor = new TaskExecutor(task, deps)

    await executor.run()

    expect(resolveEffectiveWorkflowTarget).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        targetUserId: '00000000-0000-4000-8000-000000000001',
      }),
      'membership-only'
    )
    expect(deps.onApprovalNeeded).not.toHaveBeenCalled()
    expect(task.responseCallback).toHaveBeenCalledWith({
      response: 'membership-only is not available for this conversation target.',
      attachments: undefined,
    })
  })

  it('does not rewrite provider trigger responses when workflow_trigger ran in the current turn', async () => {
    vi.mocked(resolveProviderWorkflowCallerContext).mockResolvedValueOnce({
      targetUserId: '00000000-0000-4000-8000-000000000001',
      conversationId: 'telegram:test-channel:user-1',
      originChannelType: 'telegram',
      sourceMessageContent: 'Run risk-review',
    })
    vi.mocked(runToolUseLoop).mockImplementationOnce(async (loopConfig: any) => {
      loopConfig.events.emit({
        type: 'tool:called',
        data: { toolName: 'workflow_trigger' },
        timestamp: new Date(),
      })
      return {
        type: 'response',
        content: 'The workflow risk-review has been triggered and is currently pending.',
      } as any
    })

    const deps = createDeps()
    const task = createTask('Run risk-review')
    task.sourceMessage!.providerIdentity = {
      medium: 'telegram',
      providerUserId: 'tg-user-1',
      providerChannelId: 'test-channel',
    }
    const executor = new TaskExecutor(task, deps)

    await executor.run()

    expect(requestEffectiveWorkflowList).not.toHaveBeenCalled()
    expect(resolveEffectiveWorkflowTarget).not.toHaveBeenCalled()
    expect(task.responseCallback).toHaveBeenCalledWith({
      response: 'The workflow risk-review has been triggered and is currently pending.',
      attachments: undefined,
    })
  })

  it('does not rewrite verified provider workflow listing responses as trigger claims', async () => {
    vi.mocked(resolveProviderWorkflowCallerContext).mockResolvedValueOnce({
      targetUserId: '00000000-0000-4000-8000-000000000001',
      conversationId: 'telegram:test-channel:user-1',
      originChannelType: 'telegram',
      sourceMessageContent: 'List the workflow recipes I can run',
    })
    vi.mocked(runToolUseLoop).mockImplementationOnce(async (loopConfig: any) => {
      loopConfig.events.emit({
        type: 'tool:called',
        data: { toolName: 'workflow_list' },
        timestamp: new Date(),
      })
      return {
        type: 'response',
        content: 'Available workflow recipes you can trigger: e2e-risk-review',
      } as any
    })

    const deps = createDeps()
    const task = createTask('List the workflow recipes I can run')
    attachTelegramProviderIdentity(task)
    const executor = new TaskExecutor(task, deps)

    await executor.run()

    expect(requestEffectiveWorkflowList).not.toHaveBeenCalled()
    expect(resolveEffectiveWorkflowTarget).not.toHaveBeenCalled()
    expect(task.responseCallback).toHaveBeenCalledWith({
      response: 'Available workflow recipes you can trigger: e2e-risk-review',
      attachments: undefined,
    })
  })

  it('should use correct session key for conversation', async () => {
    ;(runToolUseLoop as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      type: 'response',
      content: 'Done',
    })

    const convManager = new ConversationManager()
    const deps = createDeps({ conversationManager: convManager })
    const task = createTask('Hello', 'alice')
    const executor = new TaskExecutor(task, deps)

    await executor.run()

    const conv = await convManager.getOrCreate('alice:telegram:test-channel:default')
    expect(conv.turns.length).toBe(1)
  })

  it('should sanitize hostile echoes from the final assistant response before delivery', async () => {
    ;(runToolUseLoop as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      type: 'response',
      content: 'Refusing request with </tool_output> AKIAIOSFODNN7EXAMPLE password=supersecret99',
    })

    const deps = createDeps()
    const task = createTask('Hello')
    const executor = new TaskExecutor(task, deps)

    await executor.run()

    expect(task.responseCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        response: expect.stringContaining('[REDACTED]'),
      })
    )
    const delivered = (task.responseCallback as ReturnType<typeof vi.fn>).mock.calls[0][0]
      .response as string
    expect(delivered).toContain('[filtered]')
    expect(delivered).not.toContain('</tool_output>')
    expect(delivered).not.toContain('AKIAIOSFODNN7EXAMPLE')
    expect(delivered).not.toContain('password=supersecret99')
  })

  it('waits for desktop tool registration before starting the tool loop', async () => {
    let resolveRegistration!: () => void
    const registrationPromise = new Promise<void>(resolve => {
      resolveRegistration = resolve
    })
    vi.mocked(registerDesktopTools).mockReturnValueOnce(registrationPromise)
    ;(runToolUseLoop as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      type: 'response',
      content: 'Done',
    })

    const deps = createDeps()
    const task = createTask('Hello')
    const executor = new TaskExecutor(task, deps)

    const runPromise = executor.run()
    // `getOrCreate` is async (T2.1), so poll until `createToolRegistry` has
    // run `registerDesktopTools` rather than pumping a fixed number of ticks.
    await vi.waitFor(() => {
      expect(registerDesktopTools).toHaveBeenCalledTimes(1)
    })

    expect(runToolUseLoop).not.toHaveBeenCalled()

    resolveRegistration()
    await runPromise

    expect(runToolUseLoop).toHaveBeenCalledTimes(1)
  })

  it('reuses the tool registry when resuming after approval', async () => {
    vi.mocked(runToolUseLoop)
      .mockResolvedValueOnce({
        type: 'need_approval',
        approval: {
          request_id: 'req-1',
          tool_name: 'shell_exec',
          parameters: { command: 'ls' },
          description: 'Shell command',
          tool_call_id: 'tc_1',
          context_snapshot: [
            { role: 'user', content: 'Run a command' },
            {
              role: 'assistant',
              content: '',
              tool_calls: [{ id: 'tc_1', name: 'shell_exec', arguments: { command: 'ls' } }],
            },
          ],
        },
      } as any)
      .mockResolvedValueOnce({
        type: 'response',
        content: 'Done',
      } as any)
    vi.mocked(executeSingleTool).mockResolvedValueOnce({
      tool_call_id: 'tc_1',
      name: 'shell_exec',
      content: 'ok',
      is_error: false,
    })

    const deps = createDeps()
    const task = createTask('Run a command')
    const executor = new TaskExecutor(task, deps)

    await executor.run()
    expect(executor.executorState).toBe('waiting_approval')
    expect(registerDesktopTools).toHaveBeenCalledTimes(1)

    await executor.resumeAfterApproval(false)

    expect(registerDesktopTools).toHaveBeenCalledTimes(1)
    expect(executeSingleTool).toHaveBeenCalledTimes(1)
    expect(runToolUseLoop).toHaveBeenCalledTimes(2)
    expect(executor.executorState).toBe('completed')
    expect(deps.onComplete).toHaveBeenCalledTimes(1)
  })

  it('U5: a 401 on resume re-suspends as connect_required, then re-executes on connect (no double approval)', async () => {
    vi.mocked(runToolUseLoop)
      // Round A — the LLM calls an oauth MCP tool → approval_required.
      .mockResolvedValueOnce({
        type: 'need_approval',
        approval: {
          request_id: 'req-approve',
          tool_name: 'monday__list_boards',
          parameters: { limit: 5 },
          description: 'MCP tool',
          tool_call_id: 'tc_1',
          context_snapshot: [
            { role: 'user', content: 'list boards' },
            {
              role: 'assistant',
              content: '',
              tool_calls: [{ id: 'tc_1', name: 'monday__list_boards', arguments: { limit: 5 } }],
            },
          ],
        },
      } as any)
      // Round C — after connect, the re-executed tool feeds the loop, which responds.
      .mockResolvedValueOnce({ type: 'response', content: 'Boards: A, B' } as any)

    vi.mocked(executeSingleTool)
      // First resume (user approved) → the live tool call 401s on the oauth server.
      .mockResolvedValueOnce({
        tool_call_id: 'tc_1',
        name: 'monday__list_boards',
        content: 'MCP server monday auth failed (401)',
        is_error: true,
        metadata: { connect_required: { mcpServerName: 'monday' } },
      })
      // Second resume (user connected) → the SAME tool now succeeds.
      .mockResolvedValueOnce({
        tool_call_id: 'tc_1',
        name: 'monday__list_boards',
        content: 'ok',
        is_error: false,
      })

    const deps = createDeps()
    const task = createTask('list boards')
    const executor = new TaskExecutor(task, deps)

    await executor.run()
    expect(executor.executorState).toBe('waiting_approval')

    // Round B — approve. The tool executes and 401s → durable re-suspension as
    // connect_required. The auth error is NOT fed back to the LLM.
    await executor.resumeAfterApproval(false)
    expect(executor.executorState).toBe('waiting_approval')
    const connectCall = vi.mocked(deps.onApprovalNeeded).mock.calls.at(-1)
    expect(connectCall?.[2]).toMatchObject({
      reason: 'connect_required',
      mcpServerName: 'monday',
      tool_name: 'monday__list_boards',
      tool_call_id: 'tc_1',
    })
    // No 2nd loop yet — round B suspended instead of continuing.
    expect(runToolUseLoop).toHaveBeenCalledTimes(1)
    expect(executeSingleTool).toHaveBeenCalledTimes(1)

    // Round C — connect. The SAME tool re-executes directly (no fresh approval
    // gate — resumeAfterApproval bypasses beforeTool), then the loop completes.
    await executor.resumeAfterApproval(false)
    expect(executeSingleTool).toHaveBeenCalledTimes(2)
    expect(runToolUseLoop).toHaveBeenCalledTimes(2)
    expect(executor.executorState).toBe('completed')
    expect(deps.onComplete).toHaveBeenCalledTimes(1)
  })

  it.each(['openai', 'claude', 'zai', 'bailian', 'codex-subscription'] as const)(
    'injects text+image contentParts for %s provider',
    async providerType => {
      vi.mocked(runToolUseLoop).mockResolvedValueOnce({ type: 'response', content: 'ok' } as any)
      const deps = createDeps({
        llmProvider: {
          completeSingleTurn: vi.fn(),
          completeSingleTurnWithTools: vi.fn(),
          getProviderType: () => providerType,
        } as any,
      })
      const task = createTask('Analyze this image')
      task.sourceMessage!.attachments = [createImageAttachment()]

      const executor = new TaskExecutor(task, deps)
      await executor.run()

      const userMessage = getLastUserMessageFromLoopCall()
      expect(vi.mocked(runToolUseLoop).mock.calls[0][0].imageSourceIdentity).toBe(
        providerType === 'codex-subscription'
      )
      const parts = userMessage.contentParts ?? []
      expect(parts).toHaveLength(2)
      // The prompt-cache turn-context block rides with the text part, so
      // `content` and its text parts stay equal for the Codex V2 contract.
      expect(parts[0]).toEqual({ type: 'text', text: userMessage.content })
      expect(userMessage.content.endsWith('Analyze this image')).toBe(true)
      expect(parts[1]).toEqual({
        type: 'image',
        mimeType: 'image/jpeg',
        data: 'ZmFrZS1pbWFnZS1iYXNlNjQ=',
        ...(providerType === 'codex-subscription'
          ? { source: { kind: 'attachment', attachmentId: 'att-1', messageId: 'msg-1' } }
          : {}),
      } satisfies MessageContentPart)
    }
  )

  it('falls back to default text when source message content is empty', async () => {
    vi.mocked(runToolUseLoop).mockResolvedValueOnce({ type: 'response', content: 'ok' } as any)
    const deps = createDeps()
    const task = createTask('   ')
    task.sourceMessage!.attachments = [
      createImageAttachment({ mimeType: 'image/png', dataBase64: 'cG5n' }),
    ]

    const executor = new TaskExecutor(task, deps)
    await executor.run()

    const userMessage = getLastUserMessageFromLoopCall()
    const parts = userMessage.contentParts ?? []
    expect(parts).toHaveLength(2)
    expect(parts[0]).toEqual({ type: 'text', text: userMessage.content })
    expect(userMessage.content.endsWith('User attached image(s).')).toBe(true)
    expect(parts[1]).toEqual({
      type: 'image',
      mimeType: 'image/png',
      data: 'cG5n',
    } satisfies MessageContentPart)
  })

  it('binds image source when a Codex fallback is configured on an OpenAI primary', async () => {
    vi.mocked(runToolUseLoop).mockResolvedValueOnce({ type: 'response', content: 'ok' } as any)
    const policy: LlmPolicy = {
      fallbacks: [{ provider: 'codex-subscription', model: 'fallback-model' }],
      triggerOn: ['provider_unavailable'],
      cooldownSeconds: 30,
    }
    const deps = createDeps({
      failover: { policy, engine: new FailoverEngine(policy), buildProvider: () => null },
    })
    const task = createTask('Analyze this image')
    task.sourceMessage!.attachments = [createImageAttachment()]
    await new TaskExecutor(task, deps).run()
    const parts = getLastUserMessageFromLoopCall().contentParts ?? []
    expect(vi.mocked(runToolUseLoop).mock.calls[0][0].imageSourceIdentity).toBe(true)
    expect(parts[1]).toEqual({
      type: 'image',
      mimeType: 'image/jpeg',
      data: 'ZmFrZS1pbWFnZS1iYXNlNjQ=',
      source: { kind: 'attachment', attachmentId: 'att-1', messageId: 'msg-1' },
    } satisfies MessageContentPart)
  })

  it.each(['claude', 'codex-subscription'])(
    'selects image identity from the configured fallback %s',
    async fallback => {
      vi.mocked(runToolUseLoop).mockResolvedValueOnce({ type: 'response', content: 'ok' } as any)
      const policy: LlmPolicy = {
        fallbacks: [{ provider: fallback, model: 'fallback-model' }],
        triggerOn: ['provider_unavailable'],
        cooldownSeconds: 30,
      }
      const deps = createDeps({
        failover: { policy, engine: new FailoverEngine(policy), buildProvider: () => null },
      })
      await new TaskExecutor(createTask('hello'), deps).run()
      expect(vi.mocked(runToolUseLoop).mock.calls[0][0].imageSourceIdentity).toBe(
        fallback === 'codex-subscription'
      )
    }
  )

  it('preserves history enrichment when adding image parts', async () => {
    vi.mocked(runToolUseLoop).mockResolvedValueOnce({ type: 'response', content: 'ok' } as any)
    const deps = createDeps()
    const original = deps.conversationManager.buildMessageHistory.bind(deps.conversationManager)
    vi.spyOn(deps.conversationManager, 'buildMessageHistory').mockImplementation(conversation => {
      const messages = original(conversation)
      const last = messages[messages.length - 1]
      if (last?.role === 'user') last.content = `Conversation context: ${last.content}`
      return messages
    })
    const task = createTask('Analyze this image')
    task.sourceMessage!.attachments = [createImageAttachment()]
    await new TaskExecutor(task, deps).run()
    const message = getLastUserMessageFromLoopCall()
    expect(message.content).toContain('Conversation context: Analyze this image')
    expect(message.contentParts?.[0]).toEqual({ type: 'text', text: message.content })
  })

  it('uses the queued task id when the source message carries no delivery id', async () => {
    vi.mocked(runToolUseLoop).mockResolvedValueOnce({ type: 'response', content: 'ok' } as any)
    const deps = createDeps()
    const task = createTask('Analyze this image')
    task.sourceMessage!.messageId = '   '
    task.sourceMessage!.attachments = [createImageAttachment()]

    const executor = new TaskExecutor(task, deps)
    await executor.run()

    const parts = getLastUserMessageFromLoopCall().contentParts ?? []
    expect(parts[1]).toEqual({
      type: 'image',
      mimeType: 'image/jpeg',
      data: 'ZmFrZS1pbWFnZS1iYXNlNjQ=',
    } satisfies MessageContentPart)
  })

  it('skips contentParts when provider is unsupported', async () => {
    vi.mocked(runToolUseLoop).mockResolvedValueOnce({ type: 'response', content: 'ok' } as any)
    const deps = createDeps({
      llmProvider: {
        completeSingleTurn: vi.fn(),
        completeSingleTurnWithTools: vi.fn(),
        getProviderType: () => 'unknown',
      } as any,
    })
    const task = createTask('Analyze this image')
    task.sourceMessage!.attachments = [createImageAttachment()]

    const executor = new TaskExecutor(task, deps)
    await executor.run()

    const userMessage = getLastUserMessageFromLoopCall()
    expect(userMessage.contentParts).toBeUndefined()
  })

  it('skips contentParts when source message has no attachments', async () => {
    vi.mocked(runToolUseLoop).mockResolvedValueOnce({ type: 'response', content: 'ok' } as any)
    const deps = createDeps()
    const task = createTask('No attachments here')
    task.sourceMessage!.attachments = []

    const executor = new TaskExecutor(task, deps)
    await executor.run()

    const userMessage = getLastUserMessageFromLoopCall()
    expect(userMessage.contentParts).toBeUndefined()
  })

  it('filters out non-image attachment kinds', async () => {
    vi.mocked(runToolUseLoop).mockResolvedValueOnce({ type: 'response', content: 'ok' } as any)
    const deps = createDeps()
    const task = createTask('Analyze this attachment')
    task.sourceMessage!.attachments = [
      {
        ...createImageAttachment(),
        kind: 'document',
      } as any,
    ]

    const executor = new TaskExecutor(task, deps)
    await executor.run()

    const userMessage = getLastUserMessageFromLoopCall()
    expect(userMessage.contentParts).toBeUndefined()
  })

  it('filters out unsupported image MIME types', async () => {
    vi.mocked(runToolUseLoop).mockResolvedValueOnce({ type: 'response', content: 'ok' } as any)
    const deps = createDeps()
    const task = createTask('Analyze this attachment')
    task.sourceMessage!.attachments = [
      {
        ...createImageAttachment(),
        mimeType: 'image/gif',
      } as any,
    ]

    const executor = new TaskExecutor(task, deps)
    await executor.run()

    const userMessage = getLastUserMessageFromLoopCall()
    expect(userMessage.contentParts).toBeUndefined()
  })

  it('keeps LLM trace identities distinct and emits tool SSE events on approval resume', async () => {
    const approvalRequestId = '00000000-0000-4000-8000-000000000123'
    // Arrange: first loop returns need_approval, second loop returns a response.
    vi.mocked(runToolUseLoop)
      .mockImplementationOnce(async config => {
        config.events.emit({
          type: 'llm:completed',
          data: { iteration: 0, durationMs: 100 },
          timestamp: new Date('2026-07-14T14:59:59.000Z'),
        })
        return {
          type: 'need_approval',
          approval: {
            request_id: approvalRequestId,
            tool_name: 'shell_exec',
            tool_kind: 'internal_tool',
            tool_source_ref: 'mcp-host',
            parameters: { command: 'echo hi' },
            description: 'Shell command',
            tool_call_id: 'tc_approved',
            context_snapshot: [
              { role: 'user', content: 'Run something' },
              {
                role: 'assistant',
                content: '',
                tool_calls: [
                  { id: 'tc_approved', name: 'shell_exec', arguments: { command: 'echo hi' } },
                ],
              },
            ],
          },
        } as any
      })
      .mockImplementationOnce(async config => {
        config.events.emit({
          type: 'llm:completed',
          data: { iteration: 0, durationMs: 100 },
          timestamp: new Date('2026-07-14T15:00:01.000Z'),
        })
        return { type: 'response', content: 'Done' } as any
      })
    vi.mocked(executeSingleTool).mockImplementationOnce(async (call, config) => {
      config.events.emit({
        type: 'tool:completed',
        data: {
          toolName: call.name,
          toolCallId: call.id,
          is_error: false,
          toolKind: 'internal_tool',
          toolSourceRef: 'mcp-host',
        },
        timestamp: new Date('2026-07-14T15:00:00.000Z'),
      })
      return {
        tool_call_id: 'tc_approved',
        name: 'shell_exec',
        content: 'stdout:\nhi',
        rawContent: 'stdout:\nhi',
        is_error: false,
      }
    })

    const enqueue = vi.fn()
    const deps = createDeps({
      governedRunReporter: { enqueue } as any,
      usageStaticContext: {
        host_ref: 'test-host',
        context_ref: null,
        llm_secret_name: null,
      },
    })
    const task = createTask('Run something')
    task.traceContext = {
      version: 1,
      runId: '00000000-0000-4000-8000-000000000456',
      sessionId: 'session-1',
      origin: 'direct_chat',
      correlationRefs: [],
    }
    const executor = new TaskExecutor(task, deps)

    await executor.run()
    expect(executor.executorState).toBe('waiting_approval')

    // Subscribe to the progress reporter BEFORE resuming so we capture the events.
    const { progressReporterRegistry } = await import('../../progress/sseProgressReporter.js')
    const reporter = progressReporterRegistry.get(executor.taskId)
    expect(reporter).toBeDefined()
    const events: Array<{ type: string; data: any }> = []
    reporter!.subscribe(e => events.push(e))

    // Act
    await executor.resumeAfterApproval(false)

    // Assert: tool_start and tool_complete are both emitted for the approved tool.
    const toolStarts = events.filter(e => e.type === 'tool_start')
    const toolCompletes = events.filter(e => e.type === 'tool_complete')
    expect(toolStarts).toHaveLength(1)
    expect(toolCompletes).toHaveLength(1)

    expect(toolStarts[0].data).toMatchObject({
      toolCallId: 'tc_approved',
      toolName: 'shell_exec',
      displayName: 'Shell',
      iteration: 0,
      stepIndex: 0,
      totalSteps: 1,
    })
    expect(toolCompletes[0].data).toMatchObject({
      toolCallId: 'tc_approved',
      toolName: 'shell_exec',
      displayName: 'Shell',
      isError: false,
    })
    expect(typeof toolCompletes[0].data.durationMs).toBe('number')
    expect(toolCompletes[0].data.durationMs).toBeGreaterThanOrEqual(0)
    // outputPreview is built from rawContent; verify it was populated.
    expect(toolCompletes[0].data.outputPreview).toBeDefined()
    const toolTraceEvents = enqueue.mock.calls
      .map(([event]) => event)
      .filter(event => event.eventType === 'tool_call')
    expect(toolTraceEvents).toEqual([
      expect.objectContaining({
        eventType: 'tool_call',
        approvalRequestId,
        sourceEventId: expect.stringMatching(/:tool:tc_approved$/),
        payload: {
          status: 'succeeded',
          tool_name: 'shell_exec',
          tool_kind: 'internal_tool',
          tool_source_ref: 'mcp-host',
        },
      }),
    ])
    const llmTraceEvents = enqueue.mock.calls
      .map(([event]) => event)
      .filter(event => event.eventType === 'llm_call')
    expect(llmTraceEvents).toHaveLength(2)
    expect(new Set(llmTraceEvents.map(event => event.sourceEventId)).size).toBe(2)
    expect(llmTraceEvents.map(event => event.sourceEventId)).toEqual([
      expect.stringMatching(/:llm:1784041199000-0$/),
      expect.stringMatching(/:llm:1784041201000-0$/),
    ])
  })
})

describe('TaskExecutor error handling', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(registerDesktopTools).mockResolvedValue(undefined)
  })

  it('passes a structured TaskError to onFail when LlmError is thrown', async () => {
    const llmError = new LlmError('out of credit', 'openai', LlmErrorCode.InsufficientQuota, false)
    ;(runToolUseLoop as ReturnType<typeof vi.fn>).mockRejectedValueOnce(llmError)

    let captured: TaskError | undefined
    const deps = createDeps({
      onFail: (_task: Task, err: TaskError) => {
        captured = err
      },
    })
    const task = createTask('Hello')
    const executor = new TaskExecutor(task, deps)

    await executor.run()

    expect(captured).toEqual({
      code: 'LLM_INSUFFICIENT_QUOTA',
      message: 'out of credit',
      retryable: false,
      provider: 'openai',
    })
  })

  it.each([
    [LlmErrorCode.ToolCallLimitExceeded, 'LLM_TOOL_CALL_LIMIT_EXCEEDED', false],
    // Witness: the same path keeps an existing provider code unchanged.
    [LlmErrorCode.ModelOverloaded, 'LLM_MODEL_OVERLOADED', true],
    // The code a size refusal now carries. `codexSubscription.ts` raises
    // `request_limit_exceeded` before authorization and `classifyError` maps it
    // to this; J2 stops at that boundary, so this case is what pins the last
    // hop into the task failure the Desktop renders as "Conversation Too Long".
    // Not retryable: retrying an oversized request reproduces it (#731).
    [LlmErrorCode.ContextLengthExceeded, 'LLM_CONTEXT_LENGTH_EXCEEDED', false],
  ] as const)(
    'keeps %s from a loop error result as the task error code',
    async (code, expected, retryable) => {
      const llmError = new LlmError(
        'provider failure',
        'codex-subscription',
        code,
        retryable,
        undefined,
        undefined,
        'provider-code'
      )
      ;(runToolUseLoop as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        type: 'error',
        error: llmError,
      })

      const captured: TaskError[] = []
      const deps = createDeps({
        onFail: (_task: Task, err: TaskError) => {
          captured.push(err)
        },
      })
      const executor = new TaskExecutor(createTask('Hello'), deps)

      await executor.run()

      expect(runToolUseLoop).toHaveBeenCalledTimes(1)
      expect(captured).toEqual([
        {
          code: expected,
          message: 'provider failure',
          retryable,
          provider: 'codex-subscription',
          httpStatus: undefined,
          providerCode: 'provider-code',
        },
      ])
    }
  )

  it('does NOT invoke responseCallback from the catch block', async () => {
    const llmError = new LlmError('err', 'openai', LlmErrorCode.ApiCallFailed, false)
    ;(runToolUseLoop as ReturnType<typeof vi.fn>).mockRejectedValueOnce(llmError)

    const deps = createDeps()
    const task = createTask('Hello')
    const executor = new TaskExecutor(task, deps)

    await executor.run()

    expect(task.responseCallback).not.toHaveBeenCalled()
  })

  it('wraps non-LlmError exceptions as retryable ApiCallFailed with provider from getProviderType', async () => {
    ;(runToolUseLoop as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'))

    let captured: TaskError | undefined
    const deps = createDeps({
      onFail: (_task: Task, err: TaskError) => {
        captured = err
      },
    })
    const task = createTask('Hello')
    const executor = new TaskExecutor(task, deps)

    await executor.run()

    expect(captured?.code).toBe('LLM_API_CALL_FAILED')
    expect(captured?.retryable).toBe(true)
    expect(captured?.provider).toBe('openai')
    expect(captured?.message).toBe('boom')
  })
})

describe('TaskExecutor abort', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('abort() causes the executor to cancel mid-loop', async () => {
    // Mock a slow loop that returns cancelled (simulating checkpoint detection)
    ;(runToolUseLoop as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          // Resolve with cancelled on the next tick so abort() lands first
          setImmediate(() => resolve({ type: 'cancelled', reason: 'aborted' }))
        })
    )

    const deps = createDeps()
    const task = createTask('Hello')
    const executor = new TaskExecutor(task, deps)

    const runPromise = executor.run()

    // Abort on the next tick (while the loop promise is pending)
    setImmediate(() => executor.abort())

    await runPromise

    // M2: abort() is now a pure AbortController signal. task.status is written only by
    // TaskLifecycle (Invariant I1). In tests that call executor.abort() directly (bypassing
    // the lifecycle subscriber), the signal is aborted but task.status stays 'pending'.
    expect(executor.signal.aborted).toBe(true)
  })

  it('signal getter reflects aborted state after abort()', () => {
    const deps = createDeps()
    const task = createTask('Hello')
    const executor = new TaskExecutor(task, deps)

    expect(executor.signal.aborted).toBe(false)
    executor.abort()
    // M2: abort() only signals the AbortController. task.status is written by TaskLifecycle
    // (Invariant I1), not by abort() directly. In tests bypassing the lifecycle subscriber,
    // task.status remains 'pending'.
    expect(executor.signal.aborted).toBe(true)
  })

  it('resumeAfterApproval bails out if signal already aborted', async () => {
    // First, get the executor into waiting_approval state
    ;(runToolUseLoop as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      type: 'need_approval',
      approval: {
        request_id: 'req-abort',
        tool_name: 'shell_exec',
        parameters: { command: 'ls' },
        description: 'Shell command',
        tool_call_id: 'tc_abort',
        context_snapshot: [{ role: 'user', content: 'hello' }],
      },
    })

    const deps = createDeps()
    const task = createTask('Run a command')
    const executor = new TaskExecutor(task, deps)

    await executor.run()
    expect(executor.executorState).toBe('waiting_approval')

    // Now abort before resuming
    executor.abort()

    await executor.resumeAfterApproval(false)

    // executeSingleTool should NOT have been called
    expect(executeSingleTool).not.toHaveBeenCalled()
    // M2: abort() is a pure signal. task.status is written only by TaskLifecycle (Invariant I1).
    // The lifecycle subscriber (AgentStateMachine) drives the transition; tests calling
    // abort() directly bypass it, so asserting the AbortSignal is the correct contract here.
    expect(executor.signal.aborted).toBe(true)
  })

  it('REVIEW-1: abort() driving the lifecycle transition (idempotent defense)', () => {
    // Guard against a future caller bypassing the lifecycle subscriber.
    // In the v2 flow, abort() is called by the subscriber AFTER the transition
    // has already fired. But if something calls abort() directly (test helpers,
    // future shutdown paths, new approval-denial flows), the task should still
    // end up in 'cancelled' — not stranded at 'processing'.
    const deps = createDeps()
    const task = createTask('Hello')
    const lifecycle = deps.taskLifecycle

    lifecycle.register(task)
    lifecycle.transition(task.id, 'processing', 'dispatched')
    expect(lifecycle.getStatus(task.id)).toBe('processing')

    const executor = new TaskExecutor(task, deps)

    // DIRECT abort() call — bypass the lifecycle subscriber path
    executor.abort()

    // Signal fires AND lifecycle is in terminal state
    expect(executor.signal.aborted).toBe(true)
    expect(lifecycle.getStatus(task.id)).toBe('cancelled')
    expect(lifecycle.get(task.id)?.reason).toBe('user_requested')
  })
})

// Approach A — Full TaskExecutor canary.
// We piggy-back on the existing approval-resume pattern (see "emits tool_start
// and tool_complete SSE events around the approved tool on resume"). That path
// goes through real production wiring: TaskExecutor.buildLoopConfig() builds a
// real SseProgressReporter with `new BasicSafety(secretEntriesProvider)` and
// stashes it in the registry, then the resume path inside TaskExecutor fires
// reportToolStart and reportToolComplete with intentSummary, inputPreview,
// outputPreview, and errorSummary populated. Driving the TaskLifecycle to
// 'failed' afterwards exercises the terminal-event path with error.message.
// Together this covers every free-form field redacted at the SSE boundary.
describe('TaskExecutor — SSE redaction canary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(registerDesktopTools).mockResolvedValue(undefined)
  })

  it('does not leak ConfigStore secret values through any progress event', async () => {
    const PROBE = 'zzPROBEzz1234567890'
    const secretEntriesProvider = () => [{ name: 'PROBE_SECRET', value: PROBE }]

    // Force the orchestration helpers to inject the PROBE into the boundary
    // fields the executor passes to reportToolStart / reportToolComplete.
    const { extractInputPreview, buildOutputPreview } =
      await import('../../core/orchestration/toolUseLoop')
    vi.mocked(extractInputPreview).mockReturnValue(`curl -H "Authorization: Bearer ${PROBE}"`)
    vi.mocked(buildOutputPreview).mockReturnValue({
      headLines: [`output containing ${PROBE} on first line`],
      tailLines: [`tail line also has ${PROBE}`],
      totalLines: 2,
      truncated: false,
    })

    // First runToolUseLoop returns a need_approval whose intent_summary embeds the
    // PROBE — this becomes ToolStartEvent.intentSummary. Second call resolves the
    // tool-use loop with a final response (PROBE in there too — the reporter
    // doesn't see it, but it would be sanitized by responseSafety on delivery).
    vi.mocked(runToolUseLoop)
      .mockResolvedValueOnce({
        type: 'need_approval',
        approval: {
          request_id: 'req-canary',
          tool_name: 'shell_exec',
          parameters: { command: `echo ${PROBE}` },
          description: 'Shell command',
          tool_call_id: 'tc_canary',
          intent_summary: `I'll authenticate with token ${PROBE} to call the API`,
          context_snapshot: [
            { role: 'user', content: 'Run something' },
            {
              role: 'assistant',
              content: '',
              tool_calls: [
                { id: 'tc_canary', name: 'shell_exec', arguments: { command: `echo ${PROBE}` } },
              ],
            },
          ],
        },
      } as any)
      .mockResolvedValueOnce({
        type: 'response',
        content: `Final response that also mentions ${PROBE}`,
      } as any)

    // The executed tool returns is_error=true with PROBE in content/rawContent.
    // → ToolCompleteEvent.errorSummary (via sanitizeError) and outputPreview both
    //   carry the PROBE pre-redaction.
    vi.mocked(executeSingleTool).mockResolvedValueOnce({
      tool_call_id: 'tc_canary',
      name: 'shell_exec',
      content: `Auth rejected: token ${PROBE} is invalid`,
      rawContent: `Auth rejected: token ${PROBE} is invalid`,
      is_error: true,
    })

    const lifecycle = new TaskLifecycle()
    const deps = createDeps({ taskLifecycle: lifecycle, secretEntriesProvider })
    const task = createTask('Run something')
    lifecycle.register(task)
    lifecycle.transition(task.id, 'processing', 'dispatched')

    const executor = new TaskExecutor(task, deps)
    await executor.run()
    expect(executor.executorState).toBe('waiting_approval')

    // Subscribe AFTER run() so the reporter exists in the registry. The reporter
    // persists across run → resume so subscribers see every subsequent event.
    const { progressReporterRegistry } = await import('../../progress/sseProgressReporter.js')
    const reporter = progressReporterRegistry.get(executor.taskId)
    expect(reporter).toBeDefined()
    const captured: Array<{ type: string; data: any }> = []
    reporter!.subscribe(e => captured.push(e))

    await executor.resumeAfterApproval(false)

    // Drive a terminal lifecycle transition to fire a 'terminal' progress event
    // whose error.message contains the PROBE. The reporter's lifecycle handler
    // routes this through redactTerminal at the boundary.
    lifecycle.transition(task.id, 'failed', 'error:LLM_API_ERROR', {
      error: {
        code: 'LLM_API_ERROR',
        message: `Auth failed for token ${PROBE} — please rotate.`,
        retryable: false,
        provider: 'openai',
      },
    })

    // Sanity: we exercised tool_start, tool_complete, and terminal at minimum.
    const types = new Set(captured.map(e => e.type))
    expect(types.has('tool_start')).toBe(true)
    expect(types.has('tool_complete')).toBe(true)
    expect(types.has('terminal')).toBe(true)

    // Canary invariant: the PROBE must NOT appear anywhere in the captured
    // event stream. JSON.stringify covers every nested string field — head/
    // tail lines, intentSummary, inputPreview, errorSummary, terminal.error.
    const allText = JSON.stringify(captured)
    expect(allText).not.toContain(PROBE)

    // Bonus: prove redaction actually fired (not silent drop) by asserting the
    // marker shows up in at least one payload. This guards against a future
    // refactor that accidentally turns redaction into a no-op.
    expect(allText).toContain('[REDACTED:PROBE_SECRET]')
  })
})

describe('D3 durability barrier — a turn is never ACKed when the persist fails', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('fails the task and never calls responseCallback when persistTurnComplete rejects', async () => {
    const { InMemoryConversationStore } = await import('../../core/conversation/conversationStore')
    class RejectingStore extends InMemoryConversationStore {
      persistTurnComplete(): void {
        throw new Error('simulated fsync failure')
      }
    }
    const deps = createDeps({ conversationManager: new ConversationManager(new RejectingStore()) })
    ;(runToolUseLoop as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      type: 'response',
      content: 'Done!',
    })
    const task = createTask('Hello')

    const executor = new TaskExecutor(task, deps)
    await executor.run()

    expect(task.responseCallback).not.toHaveBeenCalled()
    expect(deps.onComplete).not.toHaveBeenCalled()
    expect(deps.onFail).toHaveBeenCalledTimes(1)
  })

  it('fails the task before the LLM loop when persistTurnStart rejects', async () => {
    const { InMemoryConversationStore } = await import('../../core/conversation/conversationStore')
    class RejectingStore extends InMemoryConversationStore {
      persistTurnStart(): void {
        throw new Error('simulated fsync failure')
      }
    }
    const deps = createDeps({ conversationManager: new ConversationManager(new RejectingStore()) })
    ;(runToolUseLoop as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      type: 'response',
      content: 'Done!',
    })
    const task = createTask('Hello')

    const executor = new TaskExecutor(task, deps)
    await executor.run()

    expect(runToolUseLoop).not.toHaveBeenCalled()
    expect(task.responseCallback).not.toHaveBeenCalled()
    expect(deps.onFail).toHaveBeenCalledTimes(1)
  })
})

describe('executionModeForSource (§6.3)', () => {
  it('treats channel tasks as interactive — a person sent the message', () => {
    expect(executionModeForSource('channel')).toBe('interactive')
  })

  it.each(['cron', 'internal'] as const)(
    'treats %s tasks as unattended so a guardrail ask fails safe to deny',
    source => {
      expect(executionModeForSource(source)).toBe('unattended')
    }
  )

  // The regression: `internal` fell through to 'interactive', so an `ask` took the
  // suspension path and parked in pending_approval with no responder — the task
  // hung. Not reachable today (createInternalTask has no production caller), which
  // is exactly why the mapping needs pinning rather than the behaviour.
  it('never labels an autonomous source interactive', () => {
    const autonomous: TaskSource[] = ['cron', 'internal']
    expect(autonomous.map(executionModeForSource)).not.toContain('interactive')
  })
})

describe('TaskExecutor Codex presentation wiring', () => {
  function makeExecutor(provider = 'codex-subscription', manager?: unknown) {
    const deps = createDeps({
      llmProvider: { getProviderType: () => provider } as any,
      ...(manager ? { mcpManager: manager as any } : {}),
    })
    const task = createTask()
    task.sourceMessage!.channelType = 'rpc'
    const executor = new TaskExecutor(task, deps) as any
    executor.conversation = { id: 'presentation-session' }
    return { executor, deps }
  }

  it('wires the real native registry, bridge and live presentation with legacy flag off', async () => {
    let count = 0
    const manager = {
      getAllTools: () =>
        Array.from({ length: count }, (_, i) => ({
          name: `fixture__tool_${i}`,
          serverName: 'fixture',
          inputSchema: { type: 'object', properties: {} },
        })),
      callTool: vi.fn(),
    }
    const { executor } = makeExecutor('codex-subscription', manager)
    const { registry, loopController, bridge } = await executor.createToolRegistry()
    const initial = await loopController.refreshTools(registry.listDefinitions())
    expect(initial.map((t: any) => t.name)).toEqual(
      expect.arrayContaining(['clerum__tool_search', 'clerum__tool_describe', 'clerum__tool_call'])
    )
    expect(bridge).toBeDefined()
    for (const n of [83, 150, 250]) {
      count = n
      const full = registry.listDefinitions()
      expect(full).toHaveLength(initial.length + n)
      expect(JSON.stringify(await loopController.refreshTools(full))).toBe(JSON.stringify(initial))
      expect(bridge.getDeferrableCatalogNames().size).toBe(n)
      expect(registry.get(`fixture__tool_${n - 1}`)).not.toBeNull()
    }
  })

  it.each([
    ['zai', 'codex-subscription'],
    ['codex-subscription', 'zai'],
  ])('keeps 250 tools selectively reachable for %s -> %s failover', async (primary, fallback) => {
    const manager = {
      getAllTools: () =>
        Array.from({ length: 250 }, (_, i) => ({
          name: `fixture__tool_${i}`,
          serverName: 'fixture',
          inputSchema: { type: 'object' },
        })),
    }
    const { executor, deps } = makeExecutor(primary, manager)
    deps.failover = { policy: { fallbacks: [{ provider: fallback, model: 'test-model' }] } } as any
    const { registry, loopController, bridge } = await executor.createToolRegistry()
    const advertised = await loopController.refreshTools(registry.listDefinitions())
    expect(bridge).toBeDefined()
    expect(advertised.some((tool: any) => tool.name.startsWith('fixture__'))).toBe(false)
    expect(advertised.some((tool: any) => tool.name === 'clerum__tool_call')).toBe(true)
    expect(bridge.getDeferrableCatalogNames().size).toBe(250)
    expect(registry.get('fixture__tool_249')).not.toBeNull()
  })

  it.each(['codex-subscription', 'zai'])(
    'default direct for %s logs the catalog without a bridge',
    async primary => {
      const previousMode = appConfig.codexToolPresentation
      const previousFlag = appConfig.dynamicToolsEnabled
      const info = vi.spyOn(logger, 'info').mockImplementation(() => {})
      appConfig.codexToolPresentation = parseCodexToolPresentation(undefined)
      appConfig.dynamicToolsEnabled = true
      try {
        const manager = {
          getAllTools: () =>
            Array.from({ length: 83 }, (_, i) => ({
              name: `fixture__tool_${i}`,
              inputSchema: { type: 'object' },
            })),
        }
        const { executor, deps } = makeExecutor(primary, manager)
        if (primary !== 'codex-subscription') {
          deps.failover = {
            policy: { fallbacks: [{ provider: 'codex-subscription', model: 'test-model' }] },
          } as any
        }
        const { registry, loopController, bridge } = await executor.createToolRegistry()
        expect(bridge).toBeUndefined()
        const full = registry.listDefinitions()
        expect(full.length).toBeGreaterThan(83)
        expect(
          full.filter((tool: any) =>
            ['clerum__tool_search', 'clerum__tool_describe', 'clerum__tool_call'].includes(
              tool.name
            )
          )
        ).toEqual([])
        expect(await loopController.refreshTools(full)).toEqual(full)
        expect(info).toHaveBeenCalledWith(
          {
            component: 'tool-presentation',
            mode: 'direct',
            strategy: 'direct',
            nativeCount: full.length - 83,
            mcpCount: 83,
            presentedCount: full.length,
            deferredCount: 0,
          },
          'Tool presentation selected'
        )
      } finally {
        appConfig.codexToolPresentation = previousMode
        appConfig.dynamicToolsEnabled = previousFlag
        info.mockRestore()
      }
    }
  )

  it('rebuilds cached discovery guidance on same-model provider switches, preserving daily snapshot', async () => {
    const previous = appConfig.promptCacheEnabled
    appConfig.promptCacheEnabled = true
    try {
      const { executor, deps } = makeExecutor('openai')
      deps.promptCache = new PromptCache()
      deps.workspaceService = {
        readIdentityFiles: vi.fn(async () => ({ identity: '', soul: '', agents: '', user: '' })),
        snapshotDailyLogs: vi.fn(async () => 'daily snapshot'),
      } as any
      executor.conversation.session_key = 'presentation-session'
      const native = [{ name: 'shell_exec', description: 'shell', parameters: {} }]
      const first = await executor.maybeGetOrBuildParts(native)
      expect(JSON.stringify(first)).not.toContain(TOOL_DISCOVERY_TEXT)
      deps.llmProvider = { getProviderType: () => 'codex-subscription' } as any
      const tools = [
        ...native,
        { name: 'clerum__tool_search', description: 'search', parameters: {} },
      ]
      const second = await executor.maybeGetOrBuildParts(tools)
      expect(JSON.stringify(second)).toContain(TOOL_DISCOVERY_TEXT)
      expect(second).not.toBe(first)
      expect(await executor.maybeGetOrBuildParts(tools)).toBe(second)
      expect(deps.workspaceService!.snapshotDailyLogs).toHaveBeenCalledTimes(1)
      deps.llmProvider = { getProviderType: () => 'openai' } as any
      expect(JSON.stringify(await executor.maybeGetOrBuildParts(native))).not.toContain(
        TOOL_DISCOVERY_TEXT
      )
    } finally {
      appConfig.promptCacheEnabled = previous
    }
  })
})

describe('TaskExecutor effective limits', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(runToolUseLoop).mockReset()
    vi.mocked(executeSingleTool).mockReset()
  })
  it('keeps an iteration budget through approval and cold rehydration', async () => {
    const task = createTask(),
      deps = createDeps()
    deps.config.maxToolCallsPerTask = 2
    const maxima: number[] = []
    vi.mocked(runToolUseLoop).mockImplementation(async config => {
      maxima.push(config.maxIterations)
      if (config.maxIterations === 0) return { type: 'exhaustion', message: 'limit', iterations: 0 }
      config.events.emit({ type: 'loop:iteration', data: { iteration: 0 }, timestamp: new Date() })
      return {
        type: 'need_approval',
        approval: {
          request_id: `r${maxima.length}`,
          tool_name: 'test',
          tool_call_id: 'tc',
          parameters: {},
          description: 'confirm',
          context_snapshot: [
            { role: 'user', content: 'work' },
            {
              role: 'assistant',
              content: '',
              tool_calls: [{ id: 'tc', name: 'test', arguments: {} }],
            },
          ],
        },
      }
    })
    vi.mocked(executeSingleTool).mockResolvedValue({
      tool_call_id: 'tc',
      name: 'test',
      content: 'done',
      is_error: false,
    })
    const first = new TaskExecutor(task, deps)
    await first.run()
    const approval = first.pendingApproval!
    expect(approval.task_budget?.iterationsUsed).toBe(1)
    const restored = new TaskExecutor(task, deps)
    await restored.rehydrateWaitingApproval(first.sessionKey!, approval)
    await restored.resumeAfterApproval(false)
    expect(restored.pendingApproval?.task_budget?.iterationsUsed).toBe(2)
    await restored.resumeAfterApproval(false)
    expect(maxima).toEqual([2, 1, 0])
    expect(executeSingleTool).toHaveBeenCalledTimes(2)
    expect(deps.onComplete).not.toHaveBeenCalled()
    expect(deps.onFail).toHaveBeenCalledWith(
      task,
      expect.objectContaining({ code: 'TASK_ITERATION_LIMIT' })
    )
  })
  it('renews a legacy approval on the same task before executing anything', async () => {
    const task = createTask(),
      deps = createDeps()
    const conv = await deps.conversationManager.getOrCreate('user-1:telegram:test-channel', {
      userId: 'user-1',
    })
    await deps.conversationManager.startTurn(conv, 'work', task.id)
    const approval = {
      request_id: 'legacy',
      tool_name: 'test',
      tool_call_id: 'tc',
      parameters: {},
      description: 'old approval',
      context_snapshot: [],
      legacy_budget: true,
    }
    await deps.conversationManager.suspendForApproval(conv, approval)
    const executor = new TaskExecutor(task, deps)
    await executor.rehydrateWaitingApproval('user-1:telegram:test-channel', approval)
    await executor.resumeAfterApproval(false)
    expect(executor.taskId).toBe(task.id)
    expect(executor.pendingApproval?.request_id).not.toBe('legacy')
    expect(executor.pendingApproval?.task_budget?.iterationsUsed).toBe(0)
    expect(executor.executorState).toBe('waiting_approval')
    expect(executeSingleTool).not.toHaveBeenCalled()
    expect(runToolUseLoop).not.toHaveBeenCalled()
  })
})

describe('TaskExecutor active duration', () => {
  afterEach(() => vi.useRealTimers())
  it.each([false, true])(
    'fails exactly once during an uncooperative LLM call (persistence failure=%s)',
    async persistFails => {
      vi.clearAllMocks()
      vi.useFakeTimers()
      const actual = await vi.importActual<typeof import('../../core/orchestration/toolUseLoop')>(
        '../../core/orchestration/toolUseLoop'
      )
      vi.mocked(runToolUseLoop).mockImplementation(actual.runToolUseLoop)
      const task = createTask(),
        deps = createDeps()
      deps.config.maxTaskDuration = 100
      if (persistFails)
        vi.spyOn(deps.conversationManager, 'completeTurn').mockRejectedValue(
          new Error('storage unavailable')
        )
      let started!: () => void
      const dispatched = new Promise<void>(resolve => {
        started = resolve
      })
      vi.mocked(deps.llmProvider.completeSingleTurnWithTools).mockImplementation(async () => {
        started()
        return new Promise(() => {}) // Deliberately ignores abort; the task boundary must still stop.
      })
      const executor = new TaskExecutor(task, deps)
      const running = executor.run()
      await dispatched
      await vi.advanceTimersByTimeAsync(100)
      await running
      expect(executor.executorState).toBe('failed')
      expect(deps.onFail).toHaveBeenCalledTimes(1)
      expect(deps.onFail).toHaveBeenCalledWith(
        task,
        expect.objectContaining({ code: 'TASK_DURATION_LIMIT' })
      )
      expect(deps.onComplete).not.toHaveBeenCalled()
      const conv = deps.conversationManager.getSessionByKey(executor.sessionKey!)
      if (!persistFails) expect(conv?.turns.at(-1)?.response).toContain('stopped before completion')
      await expect(executor.waitForCompletion()).resolves.toBeUndefined()
      expect(vi.getTimerCount()).toBe(0)
    }
  )
})

describe('TaskExecutor exhaustion and cancellation contracts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(runToolUseLoop).mockReset()
    vi.mocked(executeSingleTool).mockReset()
  })
  it('preserves the separate cost brake response and accumulated attachments', async () => {
    const deps = createDeps(),
      task = createTask()
    const attachment = createImageAttachment()
    vi.mocked(runToolUseLoop).mockResolvedValue({
      type: 'exhaustion',
      reason: 'task_budget',
      message: 'Configured budget reached',
      iterations: 1,
      attachments: [attachment],
    })
    await new TaskExecutor(task, deps).run()
    expect(task.responseCallback).toHaveBeenCalledWith({
      response: 'Configured budget reached',
      attachments: [attachment],
    })
    expect(deps.onFail).not.toHaveBeenCalled()
  })
  it('does not resurrect a cancelled legacy approval', async () => {
    const task = createTask(),
      deps = createDeps()
    deps.taskLifecycle.register(task)
    const key = 'user-1:telegram:test-channel'
    const conv = await deps.conversationManager.getOrCreate(key, { userId: 'user-1' })
    await deps.conversationManager.startTurn(conv, 'work', task.id)
    const approval = {
      request_id: 'legacy-cancel',
      tool_name: 'test',
      tool_call_id: 'tc',
      parameters: {},
      description: 'old',
      context_snapshot: [],
      legacy_budget: true,
    }
    await deps.conversationManager.suspendForApproval(conv, approval)
    const executor = new TaskExecutor(task, deps)
    await executor.rehydrateWaitingApproval(key, approval)
    executor.abort()
    await executor.resumeAfterApproval(false)
    expect(deps.onApprovalNeeded).not.toHaveBeenCalled()
    expect(deps.onFail).not.toHaveBeenCalled()
    expect(executeSingleTool).not.toHaveBeenCalled()
    await expect(executor.waitForCompletion()).resolves.toBeUndefined()
  })
})

describe('adversarial review regressions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(runToolUseLoop).mockReset()
    vi.mocked(executeSingleTool).mockReset()
  })
  afterEach(() => vi.restoreAllMocks())
  it.each([false, true])(
    'persists interruption when final sanitization crosses deadline (static=%s)',
    async isStatic => {
      let now = 0
      vi.spyOn(performance, 'now').mockImplementation(() => now)
      const deps = createDeps()
      deps.config.maxTaskDuration = 10000
      const task = createTask(isStatic ? 'list workflows' : 'Finish the work')
      const executor = new TaskExecutor(task, deps)
      const failTurn = vi.spyOn(deps.conversationManager, 'failTurn')
      const safety = executor['responseSafety']
      const sanitize = safety.sanitizeAssistantResponse.bind(safety)
      vi.spyOn(safety, 'sanitizeAssistantResponse').mockImplementation(content => {
        const result = sanitize(content)
        now = 10001 // Cross the boundary synchronously, before the timer callback can run.
        return result
      })
      if (isStatic) {
        vi.spyOn(executor as any, 'prepareChannelWorkflowCallerContext').mockImplementation(
          async () => {
            executor['workflowAccessDeniedResponse'] = 'Access denied'
          }
        )
      }
      vi.mocked(runToolUseLoop).mockResolvedValue({
        type: 'response',
        content: 'Final answer',
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      })
      await executor.run()
      expect(deps.onFail).toHaveBeenCalledWith(
        task,
        expect.objectContaining({ code: 'TASK_DURATION_LIMIT' })
      )
      expect(deps.onComplete).not.toHaveBeenCalled()
      expect(failTurn).not.toHaveBeenCalled()
      const conversation = deps.conversationManager.getSessionByKey(executor.sessionKey!)
      expect(conversation?.turns.at(-1)?.response).toContain('stopped before completion')
    }
  )
  it('retains exhaustion attachments and reports the restored effective limit', async () => {
    const deps = createDeps(),
      task = createTask(),
      attachment = createImageAttachment()
    const executor = new TaskExecutor(task, deps)
    executor['executionBudget'].restore({
      elapsedActiveMs: 0,
      iterationsUsed: 2,
      durationMs: 300000,
      maxIterations: 2,
    })
    vi.mocked(runToolUseLoop).mockResolvedValue({
      type: 'exhaustion',
      iterations: 0,
      message: 'limit',
      attachments: [attachment],
    })
    await executor.run()
    expect(deps.onFail).toHaveBeenCalledExactlyOnceWith(
      task,
      expect.objectContaining({
        code: 'TASK_ITERATION_LIMIT',
        message: expect.stringContaining('after 2 iterations'),
      }),
      [attachment]
    )
    expect(deps.onComplete).not.toHaveBeenCalled()
  })
  it('retains saved artifacts when restored time is already exhausted', async () => {
    const deps = createDeps(),
      task = createTask(),
      attachment = createImageAttachment()
    const key = 'user-1:telegram:test-channel'
    const conversation = await deps.conversationManager.getOrCreate(key, { userId: 'user-1' })
    await deps.conversationManager.startTurn(conversation, 'work', task.id)
    const approval = {
      request_id: 'expired-budget',
      tool_name: 'test',
      tool_call_id: 'tc',
      parameters: {},
      description: 'confirm',
      context_snapshot: [],
      attachments: [attachment],
      completed_results: [
        {
          tool_call_id: 'prior',
          name: 'image',
          content: 'done',
          is_error: false,
          attachments: [attachment],
        },
      ],
      task_budget: {
        elapsedActiveMs: 300000,
        iterationsUsed: 1,
        durationMs: 300000,
        maxIterations: 10,
      },
    }
    await deps.conversationManager.suspendForApproval(conversation, approval)
    const executor = new TaskExecutor(task, deps)
    await executor.rehydrateWaitingApproval(key, approval)
    await executor.resumeAfterApproval(false)
    expect(deps.onFail).toHaveBeenCalledExactlyOnceWith(
      task,
      expect.objectContaining({ code: 'TASK_DURATION_LIMIT' }),
      [attachment]
    )
    expect(executeSingleTool).not.toHaveBeenCalled()
    expect(runToolUseLoop).not.toHaveBeenCalled()
  })
})

/**
 * #654 — the failover factory must build the SDK client with the model this
 * attempt actually serves, and every failover attempt re-checks the image-input
 * capability of its OWN pair before dispatching.
 */
describe('#654 failover identity + per-attempt image guard', () => {
  const EVIDENCE = {
    source: 'curated' as const,
    reference: 'https://docs.z.ai/guides/vlm/glm-5.3-flash',
    checkedAt: '2026-09-16T00:00:00Z',
  }

  const POLICY: LlmPolicy = {
    cooldownSeconds: 300,
    triggerOn: ['insufficient_quota', 'auth', 'provider_unavailable', 'rate_limited'],
    fallbacks: [{ provider: 'openai', model: 'gpt-4o' }],
  }

  function throttledProvider(type: string) {
    return {
      completeSingleTurn: vi.fn(),
      completeSingleTurnWithTools: vi.fn(async () => {
        throw new LlmError('429', type, LlmErrorCode.RateLimited, true)
      }),
      getProviderType: () => type,
      classifyError: (err: unknown) => ({
        code: err instanceof LlmError ? err.code : LlmErrorCode.ApiCallFailed,
        retryable: true,
        message: (err as Error).message,
      }),
    } as never
  }

  function conversationStub() {
    return { id: 'conv-identity' } as never
  }

  function executorWith(overrides: Partial<TaskExecutorDeps>) {
    const deps = createDeps(overrides)
    return { deps, executor: new TaskExecutor(createTask(), deps) as never }
  }

  it('builds a SAME-provider fallback with the session model, and the SDK sends that model', async () => {
    const create = vi.fn(async (_input: unknown) => ({
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }))
    // Mirrors `buildFallbackProvider`: the SDK model comes from `entry.model`.
    const buildProvider = vi.fn(
      (entry: { model: string }) =>
        new OpenAIProvider({ chat: { completions: { create } } } as never, entry.model)
    )
    const { executor } = executorWith({
      modelName: 'gpt-5.4-mini',
      llmProvider: { getProviderType: () => 'openai' } as never,
      failover: {
        engine: new FailoverEngine(POLICY, { metricInc: () => {} }),
        policy: POLICY,
        buildProvider,
      } as never,
    })

    // Text-only request, so the #654 image guard is a no-op here and no
    // resolver is wired. The subject under test is the failover factory's model
    // identity, not the guard.
    const primaryPort = new LlmPortAdapter(throttledProvider('openai'), 'gpt-5.4-mini', 'openai')
    const wrapped = (
      executor as unknown as {
        wrapFailoverPort: (
          port: LlmPortAdapter,
          conv: unknown
        ) => { completeWithTools: (r: unknown) => Promise<unknown> }
      }
    ).wrapFailoverPort(primaryPort, conversationStub())

    await wrapped.completeWithTools({ messages: [{ role: 'user', content: 'hi' }], tools: [] })

    // The factory receives the EFFECTIVE entry (session model, not entry.model)…
    expect(buildProvider).toHaveBeenCalledWith({ provider: 'openai', model: 'gpt-5.4-mini' })
    // …and that is the model the SDK really requests (the pre-#654 bug sent 'gpt-4o').
    expect(create).toHaveBeenCalledTimes(1)
    expect((create.mock.calls[0]?.[0] as { model?: string }).model).toBe('gpt-5.4-mini')
  })

  it('re-checks the image capability of the FALLBACK pair before its SDK call', async () => {
    const claudeCreate = vi.fn(async (_input: unknown) => ({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }))
    const claudeProvider = new ClaudeProvider(
      { messages: { create: claudeCreate } } as never,
      'claude-haiku-4-5'
    )
    const buildProvider = vi.fn(() => claudeProvider)
    const crossProviderPolicy: LlmPolicy = {
      ...POLICY,
      fallbacks: [{ provider: 'claude', model: 'claude-haiku-4-5' }],
    }
    const imageInput = vi.fn((provider: string) =>
      provider === 'openai'
        ? { capability: { state: 'supported', evidence: EVIDENCE } }
        : { capability: { state: 'unsupported', evidence: EVIDENCE } }
    )
    const { executor } = executorWith({
      modelName: 'gpt-5.4-mini',
      llmProvider: { getProviderType: () => 'openai' } as never,
      imageInput: imageInput as never,
      failover: {
        engine: new FailoverEngine(crossProviderPolicy, { metricInc: () => {} }),
        policy: crossProviderPolicy,
        buildProvider,
      } as never,
    })

    // The primary pair MUST pass the image guard, otherwise the refusal happens
    // before the failover engine ever considers the fallback — that is the
    // separate "primary denial is terminal" behaviour. The primary dispatch
    // here and the fallback adapter below read this same resolver, which is
    // exactly what lets the test prove the fallback is re-checked.
    const primaryPort = new LlmPortAdapter(
      throttledProvider('openai'),
      'gpt-5.4-mini',
      'openai',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      imageInput as never
    )
    const wrapped = (
      executor as unknown as {
        wrapFailoverPort: (
          port: LlmPortAdapter,
          conv: unknown
        ) => { completeWithTools: (r: unknown) => Promise<unknown> }
      }
    ).wrapFailoverPort(primaryPort, conversationStub())

    const imageMessage = {
      role: 'user' as const,
      content: 'look',
      contentParts: [{ type: 'image' as const, mimeType: 'image/png' as const, data: 'QUJD' }],
    }
    let error: LlmError | undefined
    try {
      await wrapped.completeWithTools({ messages: [imageMessage], tools: [] })
    } catch (err) {
      error = err as LlmError
    }

    expect(buildProvider).toHaveBeenCalledWith({ provider: 'claude', model: 'claude-haiku-4-5' })
    expect(error).toBeInstanceOf(LlmError)
    expect(error?.code).toBe(LlmErrorCode.ImageInputUnsupported)
    expect(error?.provider).toBe('claude')
    // The incompatible fallback never reaches its SDK.
    expect(claudeCreate).not.toHaveBeenCalled()
    expect(imageInput).toHaveBeenCalledWith('claude', 'claude-haiku-4-5')
  })
})

describe('TaskExecutor context manager message bound (#731)', () => {
  function smallTurns(count: number): ChatMessage[] {
    const msgs: ChatMessage[] = [{ role: 'system', content: 'sys' }]
    for (let i = 0; msgs.length < count; i++) {
      msgs.push(
        i % 2 === 0 ? { role: 'user', content: `q${i}` } : { role: 'assistant', content: `a${i}` }
      )
    }
    return msgs
  }

  // Runs a task for `providerType` and hands back the context manager the loop
  // received, so its behaviour — not its private fields — is what is asserted.
  async function loopContextManager(providerType: string) {
    vi.mocked(runToolUseLoop).mockResolvedValueOnce({ type: 'response', content: 'ok' } as any)
    const deps = createDeps({
      llmProvider: {
        completeSingleTurn: vi.fn(),
        completeSingleTurnWithTools: vi.fn(),
        getProviderType: () => providerType,
      } as any,
    })
    await new TaskExecutor(createTask('hi'), deps).run()
    const loopConfig = vi.mocked(runToolUseLoop).mock.calls.at(-1)?.[0]
    if (!loopConfig) throw new Error('Expected runToolUseLoop to receive a loop config')
    return loopConfig.contextManager
  }

  it('T-R2-3c a codex-subscription task compacts past the contract message bound', async () => {
    const msgs = smallTurns(1_025)
    const managed = await (
      await loopContextManager('codex-subscription')
    ).manage(msgs, makeFakeConversation())
    expect(managed.length).toBeLessThan(1_024)
  })

  it('T-R2-3d an openai task, with no attempt contract, is not bounded by message count', async () => {
    const msgs = smallTurns(1_025)
    const contextManager = await loopContextManager('openai')
    // Liveness witness: the loop's default manager always passes through, so the
    // passthrough below proves nothing unless this is the pressure manager.
    expect(contextManager).toBeInstanceOf(PressureContextManager)
    const managed = await contextManager.manage(msgs, makeFakeConversation())
    expect(managed).toBe(msgs)
  })
})

describe('TaskExecutor subscription context window (#731 R3-4)', () => {
  beforeEach(() => {
    vi.mocked(runToolUseLoop).mockReset()
  })

  // ~150k tokens by the byte heuristic the subscription counters use: above 0.8
  // of a 100k window, below 0.8 of the 256k subscription default.
  function largeHistory(): ChatMessage[] {
    const msgs: ChatMessage[] = [{ role: 'system', content: 'sys' }]
    for (let i = 0; i < 60; i++) {
      msgs.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: 'word '.repeat(2_000) })
    }
    return msgs
  }

  function depsFor(providerType: string, contextWindowTokens?: number) {
    return createDeps({
      modelName: 'gpt-5.5',
      contextWindowTokens,
      llmProvider: {
        completeSingleTurn: vi.fn(),
        completeSingleTurnWithTools: vi.fn(),
        getProviderType: () => providerType,
      } as any,
    })
  }

  // Runs one task and hands back the context manager the loop received.
  async function loopContextManager(deps: TaskExecutorDeps) {
    vi.mocked(runToolUseLoop).mockResolvedValueOnce({ type: 'response', content: 'ok' } as any)
    await new TaskExecutor(createTask('hi'), deps).run()
    const loopConfig = vi.mocked(runToolUseLoop).mock.calls.at(-1)?.[0]
    if (!loopConfig) throw new Error('Expected runToolUseLoop to receive a loop config')
    return loopConfig.contextManager
  }

  it('T-R3-4e a codex-subscription task without a catalog window runs with the 256k default', async () => {
    const msgs = largeHistory()
    const manager = await loopContextManager(depsFor('codex-subscription'))
    expect(manager).toBeInstanceOf(PressureContextManager)
    expect(await manager.manage(msgs, makeFakeConversation())).toBe(msgs)
    // Witness: under a 100k catalog window the same history is compacted, so the
    // passthrough above is the window's doing.
    const narrow = await loopContextManager(depsFor('codex-subscription', 100_000))
    expect((await narrow.manage(msgs, makeFakeConversation())).length).toBeLessThan(msgs.length)
  })

  it('T-R3-4f logs the window and its source once per subscription task', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {})
    try {
      await loopContextManager(depsFor('codex-subscription'))
      await loopContextManager(depsFor('grok-subscription', 500_000))
      await loopContextManager(depsFor('openai'))
      const resolved = info.mock.calls
        .map(call => call[0] as Record<string, unknown>)
        .filter(fields => fields?.event === 'context_window_resolved')
      expect(resolved).toEqual([
        {
          event: 'context_window_resolved',
          component: 'TaskExecutor',
          taskId: expect.any(String),
          provider: 'codex-subscription',
          model: 'gpt-5.5',
          contextWindowTokens: 256_000,
          source: 'default',
        },
        {
          event: 'context_window_resolved',
          component: 'TaskExecutor',
          taskId: expect.any(String),
          provider: 'grok-subscription',
          model: 'gpt-5.5',
          contextWindowTokens: 500_000,
          source: 'catalog',
        },
      ])
      // Witness: all three tasks reached the loop, so the openai task logged
      // nothing because it has no subscription window, not because it never ran.
      expect(runToolUseLoop).toHaveBeenCalledTimes(3)
    } finally {
      info.mockRestore()
    }
  })
})

describe('TaskExecutor history compaction threshold follows the context window (#731)', () => {
  // ~100k tokens by either count (tiktoken reads one token per `word `, the
  // byte heuristic 125k): above the 80k literal default, below 0.8 of a 1M
  // window. The old tool result sits outside the protected tail of three turns.
  const OLD_RESULT = 'word '.repeat(100_000)
  function prunableHistory(): ChatMessage[] {
    return [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'q0' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'tc0', name: 'fetch', arguments: { url: 'https://example.test' } }],
      },
      { role: 'tool', tool_call_id: 'tc0', name: 'fetch', content: OLD_RESULT },
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'q3' },
      { role: 'assistant', content: 'a3' },
    ]
  }

  // The config mock of this file carries no pre-prune fields; these are the
  // defaults `config.ts` deploys (T-B pins the master switch).
  const DEPLOYED_PRE_PRUNE = {
    compactionPrePruneEnabled: true,
    compactionPrePruneDedup: true,
    compactionPrePruneOneLine: true,
    compactionPrePruneJsonTruncate: true,
    compactionPrePruneStripMedia: true,
    compactionPrePruneMaxArgsBytes: 4096,
    compactionPrePruneSummaryTokens: 200,
    compactionPrePruneProtectedTailTurns: 3,
  }
  const mutableConfig = appConfig as unknown as Record<string, unknown>
  let previousConfig: Record<string, unknown>
  beforeEach(() => {
    previousConfig = Object.fromEntries(
      Object.keys(DEPLOYED_PRE_PRUNE).map(key => [key, mutableConfig[key]])
    )
    Object.assign(mutableConfig, DEPLOYED_PRE_PRUNE)
  })
  afterEach(() => {
    Object.assign(mutableConfig, previousConfig)
  })

  // Runs a task whose rehydrated history is `prunableHistory()` and returns the
  // old tool result as it reached the loop.
  async function oldResultReachingLoop(contextWindowTokens: number): Promise<string | undefined> {
    vi.mocked(runToolUseLoop).mockResolvedValueOnce({ type: 'response', content: 'ok' } as any)
    const conversationManager = new ConversationManager()
    vi.spyOn(conversationManager, 'buildMessageHistory').mockReturnValue(prunableHistory())
    const deps = createDeps({ conversationManager, contextWindowTokens })
    await new TaskExecutor(createTask('hi'), deps).run()
    const call = vi.mocked(runToolUseLoop).mock.calls.at(-1)
    if (!call) throw new Error('Expected runToolUseLoop to be called')
    return call[1]?.find(m => m.role === 'tool')?.content
  }

  it('T-R2-4b a 1M window leaves a 100k-token history untouched', async () => {
    expect(await oldResultReachingLoop(1_000_000)).toBe(OLD_RESULT)
  })

  it('T-R2-4c witness: a 100k window pre-prunes the same history', async () => {
    const reached = await oldResultReachingLoop(100_000)
    expect(reached).toBeDefined()
    expect(reached!.length).toBeLessThan(OLD_RESULT.length / 10)
  })

  describe('R9-12 (M-D) rehydration measures with the context manager', () => {
    // `config.ts` deploys the dry run on: the manager decides its tier by the
    // byte heuristic alone. The config mock of this file carries no value.
    let previousDryrun: unknown
    beforeEach(() => {
      previousDryrun = mutableConfig.tokenizerDryrun
      mutableConfig.tokenizerDryrun = true
    })
    afterEach(() => {
      mutableConfig.tokenizerDryrun = previousDryrun
    })

    const WINDOW = 100_000
    // The history above with an old tool result of `words` × `word `: the
    // byte heuristic bills it ceil(5 × words / 4) + 4 tokens, and the other
    // nine messages fewer than a hundred together.
    function historyWithOldResult(words: number): ChatMessage[] {
      return prunableHistory().map(m =>
        m.role === 'tool' ? { ...m, content: 'word '.repeat(words) } : m
      )
    }

    // Runs one codex-subscription task (`FallbackTokenCounter`) whose rehydrated
    // history is `history`; returns what reached the loop and its manager.
    async function runWithHistory(history: ChatMessage[]) {
      vi.mocked(runToolUseLoop).mockResolvedValueOnce({ type: 'response', content: 'ok' } as any)
      const conversationManager = new ConversationManager()
      vi.spyOn(conversationManager, 'buildMessageHistory').mockReturnValue(history)
      const deps = createDeps({
        conversationManager,
        contextWindowTokens: WINDOW,
        llmProvider: {
          completeSingleTurn: vi.fn(),
          completeSingleTurnWithTools: vi.fn(),
          getProviderType: () => 'codex-subscription',
        } as any,
      })
      await new TaskExecutor(createTask('hi'), deps).run()
      const call = vi.mocked(runToolUseLoop).mock.calls.at(-1)
      if (!call) throw new Error('Expected runToolUseLoop to be called')
      return { reached: call[1], manager: call[0].contextManager }
    }

    it('T-R9-12a a history the manager passes through reaches the loop untouched', async () => {
      // ~64k heuristic tokens: 0.64 of the window, 0.83 under the counter's 1.3 bias.
      const history = historyWithOldResult(51_000)
      const oldResult = history.find(m => m.role === 'tool')!.content
      const { reached, manager } = await runWithHistory(history)
      // The manager this task runs with passes the same history through.
      expect(manager).toBeInstanceOf(PressureContextManager)
      expect(await manager.manage(history, makeFakeConversation())).toBe(history)
      expect(reached).toHaveLength(history.length)
      expect(reached.find(m => m.role === 'tool')?.content).toBe(oldResult)
      // Witness: in the same task setup, a history above 0.8 of the window is
      // compacted on rehydration, so the passthrough above was measured.
      const over = await runWithHistory(historyWithOldResult(68_000))
      const overResult = over.reached.find(m => m.role === 'tool')?.content
      expect(overResult).toBeDefined()
      expect(overResult!.length).toBeLessThan(68_000)
    })
  })
})

// The loop's context manager counts the system prompt the next request carries
// (R9-14, L-6). It reaches the manager through `LoopConfig.systemPrompt`; both
// prompt paths must set it, daily-log snapshot included.
describe('TaskExecutor hands the system prompt to the loop (R9-14)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  async function loopSystemPrompt(deps: TaskExecutorDeps): Promise<unknown> {
    vi.mocked(runToolUseLoop).mockResolvedValueOnce({ type: 'response', content: 'ok' } as any)
    await new TaskExecutor(createTask('hi'), deps).run()
    const call = vi.mocked(runToolUseLoop).mock.calls.at(-1)
    if (!call) throw new Error('Expected runToolUseLoop to be called')
    return call[0].systemPrompt
  }

  it('T-R9-14f the legacy path passes the assembled identity with its daily logs', async () => {
    const workspaceService = {
      assembleSystemPrompt: vi.fn(async () => 'IDENTITY\n\n## Daily Log\nDAILY-LOG-ENTRY'),
    } as any
    const systemPrompt = await loopSystemPrompt(createDeps({ workspaceService }))

    expect(workspaceService.assembleSystemPrompt).toHaveBeenCalledTimes(1)
    expect(systemPrompt).toEqual(expect.stringContaining('DAILY-LOG-ENTRY'))
    expect(systemPrompt).toEqual(expect.stringContaining('powered by the test-model model'))
  })

  it('T-R9-14g the prompt-cache path passes both tiers with the daily-log snapshot', async () => {
    const previous = appConfig.promptCacheEnabled
    appConfig.promptCacheEnabled = true
    try {
      const workspaceService = {
        readIdentityFiles: vi.fn(async () => ({
          identity: 'IDENTITY-FILE',
          soul: '',
          agents: '',
          user: '',
        })),
        snapshotDailyLogs: vi.fn(async () => 'DAILY-SNAPSHOT-ENTRY'),
      } as any
      const systemPrompt = await loopSystemPrompt(
        createDeps({ workspaceService, promptCache: new PromptCache() })
      )

      // Witness: the cache path ran, so the prompt below came from its parts.
      expect(workspaceService.snapshotDailyLogs).toHaveBeenCalledTimes(1)
      expect(systemPrompt).toEqual(expect.stringContaining('IDENTITY-FILE'))
      expect(systemPrompt).toEqual(expect.stringContaining('DAILY-SNAPSHOT-ENTRY'))
    } finally {
      appConfig.promptCacheEnabled = previous
    }
  })
})
