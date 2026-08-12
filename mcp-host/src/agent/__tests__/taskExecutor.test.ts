import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ConversationManager } from '../../core/conversation/conversation'
import { LlmError, LlmErrorCode } from '../../core/errors'
import { SimpleEventEmitter } from '../../core/orchestration/eventEmitter'
import { executeSingleTool, runToolUseLoop } from '../../core/orchestration/toolUseLoop'
import { registerDesktopTools } from '../../core/tools/desktopTools'
import {
  requestEffectiveWorkflowList,
  resolveEffectiveWorkflowTarget,
} from '../../core/tools/workflowEffectiveTargets'
import type { Attachment, ChatMessage, MessageContentPart, TraceContextV1 } from '../../core/types'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import type { Task, TaskError } from '../../queue/types'
import { resolveProviderWorkflowCallerContext } from '../../workflow/providerWorkflowCallerContextClient'
import { TaskExecutor, type TaskExecutorDeps } from '../taskExecutor'

vi.mock('../../config', () => ({
  config: {
    devMode: true,
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
      })
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
        metadata: { connect_required: { mcpServerName: 'monday', provider: 'monday' } },
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
      provider: 'monday',
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

  it.each(['openai', 'claude', 'zai', 'bailian'] as const)(
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
      expect(userMessage.contentParts).toEqual([
        { type: 'text', text: 'Analyze this image' },
        {
          type: 'image',
          mimeType: 'image/jpeg',
          data: 'ZmFrZS1pbWFnZS1iYXNlNjQ=',
        },
      ] satisfies MessageContentPart[])
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
    expect(userMessage.contentParts).toEqual([
      { type: 'text', text: 'User attached image(s).' },
      {
        type: 'image',
        mimeType: 'image/png',
        data: 'cG5n',
      },
    ] satisfies MessageContentPart[])
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
