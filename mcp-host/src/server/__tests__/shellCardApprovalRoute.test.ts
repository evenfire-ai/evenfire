import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Request, Response } from 'express'
import { AgentStateMachine } from '../../agent/stateMachine'
import { resolveTaskSessionKey } from '../../agent/taskExecutor'
import type { ApprovalConfig, ApprovalDecision } from '../../core/extensions/approvalTypes'
import { executeSingleTool, runToolUseLoop } from '../../core/orchestration/toolUseLoop'
import type { Conversation, PendingApproval } from '../../core/types'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import { IncomingMessageHandler, type PendingTaskEntry } from '../../messageHandler'
import { progressReporterRegistry } from '../../progress/sseProgressReporter'
import type { ProgressEvent } from '../../progress/types'
import { MessageQueue } from '../../queue/messageQueue'
import type { Task } from '../../queue/types'
import { ResultStore } from '../../resultStore'
import { projectGfsApproval } from '../../visualInput/suspension'
import { handleApprovalRoute } from '../routes'
import type { IncomingMessage } from '../types'
import { makeHandlers } from './testHelpers'

vi.mock('../../config', () => ({
  config: {
    devMode: true,
    contextMaxTokens: 100_000,
    enableApproval: true,
    enableNudge: false,
    nudgeMaxIterations: 3,
    devModelName: 'test-model',
    devModelProvider: 'openai',
    nativeTool: {
      workspacePath: '/tmp',
      shellTimeout: 5000,
      httpAllowlist: [],
      envAllowlist: ['PATH'],
      memoryMaxSize: 1048576,
    },
  },
}))

vi.mock('../../core/orchestration/toolUseLoop', () => ({
  runToolUseLoop: vi.fn(),
  executeSingleTool: vi.fn(),
  validateToolLinkages: vi.fn(),
  extractInputPreview: vi.fn(() => 'printf shell-card'),
  buildOutputPreview: vi.fn((content: string) =>
    content
      ? {
          headLines: String(content).split('\n').slice(0, 3),
          tailLines: [],
          totalLines: String(content).split('\n').length,
          truncated: false,
        }
      : undefined
  ),
}))

const COMMAND = 'printf shell-card'
const BOTH_FLAGS = { channelCommandOffered: true, desktopCommandOffered: true }

const bodyFixture = {
  requestId: 'req-shell',
  alwaysApprove: false,
  shellAction: 'command',
}

const responseLoop = {
  type: 'response' as const,
  content: 'done',
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
}

function policy(
  ceiling: 'manual' | 'auto' | 'allow_all',
  allowModeChange: boolean
): ApprovalConfig {
  return {
    defaultPolicy: 'channel_users',
    modeCeiling: ceiling,
    channels: {
      telegram: { enabled: true, allowModeChange },
      email: { enabled: true, allowModeChange },
      slack: { enabled: true, allowModeChange },
    },
  }
}

function makeRes() {
  const captured: { statusCode?: number; jsonBody?: unknown } = {}
  const res = {
    writeHead: vi.fn().mockImplementation((status: number) => {
      captured.statusCode = status
      return res
    }),
    end: vi.fn().mockImplementation((body?: string) => {
      if (typeof body === 'string') captured.jsonBody = JSON.parse(body)
      return res
    }),
  } as unknown as Response
  return {
    get statusCode() {
      return captured.statusCode
    },
    get jsonBody() {
      return captured.jsonBody as { success?: boolean } | undefined
    },
    res,
  }
}

function makeReq(body: Record<string, unknown>, surface: 'desktop' | 'channel'): Request {
  const runtimeCaller =
    surface === 'desktop'
      ? { caller: 'rpc-proxy', userId: 'user-1', hostRef: 'host-1' }
      : { caller: 'channel-reader', channelType: 'telegram', channelId: 'C-1', sender: 'user-1' }
  return {
    runtimeCaller,
    params: {},
    body,
    query: {},
    headers: {},
  } as unknown as Request
}

function toolResult(id: string, name: string) {
  return {
    tool_call_id: id,
    name,
    content: 'ok',
    is_error: false,
    rawContent: 'ok',
  }
}

function card(
  requestId: string,
  toolName: string,
  parameters: Record<string, unknown>,
  extras: Partial<PendingApproval> = {}
): PendingApproval {
  return {
    request_id: requestId,
    tool_name: toolName,
    parameters,
    description: `Tool "${toolName}" requires approval`,
    tool_call_id: `tc-${requestId}`,
    context_snapshot: [{ role: 'user', content: 'Do something' }],
    authorization_scope: 'turn_tools',
    ...extras,
  }
}

describe('shell card approval route', () => {
  let agent: AgentStateMachine
  let queue: MessageQueue
  let lifecycle: TaskLifecycle
  let taskSeq = 0

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(runToolUseLoop).mockReset()
    vi.mocked(executeSingleTool).mockReset()
    vi.mocked(runToolUseLoop).mockResolvedValue(responseLoop)
    vi.mocked(executeSingleTool).mockImplementation(async call => toolResult(call.id, call.name))
    for (const [id] of progressReporterRegistry.entries()) {
      progressReporterRegistry.delete(id)
    }
    queue = new MessageQueue()
    lifecycle = new TaskLifecycle()
    queue.setLifecycle(lifecycle)
    agent = new AgentStateMachine(queue, lifecycle, { autoStart: false })
    agent.setLLMProvider({
      completeSingleTurn: vi.fn(),
      completeSingleTurnWithTools: vi.fn(),
      getProviderType: () => 'openai' as const,
    } as never)
    agent.setMcpManager({ getAllTools: () => [], callTool: vi.fn() } as never)
    agent.start()
    taskSeq += 1
  })

  function conversationFor(task: Task): Conversation {
    const conv = agent.getConversationManager().getSessionByKey(resolveTaskSessionKey(task))
    if (!conv) throw new Error('missing conversation')
    return conv
  }

  function suspend(task: Task, approval: PendingApproval): Promise<boolean> {
    vi.mocked(runToolUseLoop).mockResolvedValueOnce({ type: 'need_approval', approval })
    queue.enqueue(task)
    queue.dequeue()
    return agent.executeTask(task)
  }

  function taskFor(channelType: 'rpc' | 'telegram', channelId: string): Task {
    return {
      id: `task-${taskSeq}-${channelType}-${channelId}`,
      source: 'channel',
      sourceMessage: {
        sender: 'user-1',
        content: 'Do something',
        channelType,
        channelId,
        messageId: 'msg-1',
        timestamp: new Date().toISOString(),
        hostRef: 'host-1',
      },
      priority: 'normal',
      status: 'pending',
      conversationHistory: [{ role: 'user', content: 'Do something', timestamp: new Date() }],
      responseCallback: vi.fn(async () => {}),
      createdAt: new Date(),
    }
  }

  async function post(
    body: Record<string, unknown>,
    approved: boolean,
    surface: 'desktop' | 'channel'
  ) {
    const approvalHandler = vi.fn(async (decision: ApprovalDecision) => {
      if (!decision.approved) {
        return agent.handleDenial(
          decision.userId,
          decision.requestId,
          decision.channelType,
          decision.channelId
        )
      }
      return agent.handleApproval(
        decision.userId,
        decision.requestId,
        decision.alwaysApprove,
        decision.channelType,
        decision.channelId,
        decision.shellAction
      )
    })
    const out = makeRes()
    await handleApprovalRoute(
      makeReq(body, surface),
      out.res,
      approved,
      makeHandlers({ approvalHandler })
    )
    return { out, approvalHandler }
  }

  async function answerAndRun(
    task: Task,
    body: Record<string, unknown>,
    surface: 'desktop' | 'channel',
    approved = true
  ) {
    const posted = await post(body, approved, surface)
    if (approved && posted.out.statusCode === 200 && posted.out.jsonBody?.success) {
      await vi.waitFor(() => expect(executeSingleTool).toHaveBeenCalledTimes(1))
    }
    return posted
  }

  function openAuto() {
    const live = policy('allow_all', true)
    agent.setApprovalConfig(live, live)
  }

  it.each(['once', 'command', 'shell'] as const)(
    'shellAction %s leaves the matching auto_shell_grants state',
    async action => {
      openAuto()
      const task = taskFor('rpc', 'host-1')
      const approval = card(
        bodyFixture.requestId,
        'shell_exec',
        { command: COMMAND },
        {
          authorization_scope: 'exact_invocation',
          shellCard: BOTH_FLAGS,
        }
      )
      expect(await suspend(task, approval)).toBe(true)
      conversationFor(task).approval_mode = 'auto'

      const posted = await answerAndRun(
        task,
        { ...bodyFixture, shellAction: action, alwaysApprove: false },
        'desktop'
      )

      expect(posted.out.statusCode).toBe(200)
      expect(posted.approvalHandler).toHaveBeenCalledWith(
        expect.objectContaining({ approved: true, alwaysApprove: false, shellAction: action })
      )
      expect(executeSingleTool).toHaveBeenCalledTimes(1)
      expect(executeSingleTool).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'shell_exec', arguments: { command: COMMAND } }),
        expect.anything()
      )
      const grants = conversationFor(task).auto_shell_grants
      expect(grants.wholeTool).toBe(action === 'shell')
      expect([...grants.commands]).toEqual(action === 'command' ? [COMMAND] : [])
      expect(conversationFor(task).auto_approved_tools.has('shell_exec')).toBe(false)
      expect(conversationFor(task).task_approved_tools?.has('shell_exec') ?? false).toBe(false)
    }
  )

  it.each([
    ['nope', true],
    ['', true],
    [null, true],
    [1, true],
    [true, true],
    ['SHELL', true],
    ['nope', false],
  ] as const)('shellAction %j on approved=%s returns 400', async (shellAction, approved) => {
    const approvalHandler = vi.fn()
    const out = makeRes()
    await handleApprovalRoute(
      makeReq({ ...bodyFixture, shellAction }, 'desktop'),
      out.res,
      approved,
      makeHandlers({ approvalHandler })
    )
    expect(out.statusCode).toBe(400)
    expect(approvalHandler).not.toHaveBeenCalled()
  })

  it('an approve with no shellAction runs once and stores nothing', async () => {
    openAuto()
    const task = taskFor('rpc', 'host-1')
    expect(
      await suspend(
        task,
        card(
          bodyFixture.requestId,
          'shell_exec',
          { command: COMMAND },
          {
            authorization_scope: 'exact_invocation',
            shellCard: BOTH_FLAGS,
          }
        )
      )
    ).toBe(true)
    conversationFor(task).approval_mode = 'auto'

    const posted = await answerAndRun(
      task,
      { requestId: bodyFixture.requestId, alwaysApprove: false },
      'desktop'
    )

    expect(posted.out.statusCode).toBe(200)
    expect(posted.approvalHandler).toHaveBeenCalledTimes(1)
    expect(posted.approvalHandler.mock.calls[0]?.[0].shellAction).toBeUndefined()
    expect(posted.approvalHandler.mock.calls[0]?.[0].alwaysApprove).toBe(false)
    expect(conversationFor(task).auto_shell_grants).toEqual({
      wholeTool: false,
      commands: new Set(),
    })
  })

  it('alwaysApprove on a descriptor card resolves to once even when shellAction is shell', async () => {
    openAuto()
    const task = taskFor('rpc', 'host-1')
    expect(
      await suspend(
        task,
        card(
          bodyFixture.requestId,
          'shell_exec',
          { command: COMMAND },
          {
            authorization_scope: 'exact_invocation',
            shellCard: BOTH_FLAGS,
          }
        )
      )
    ).toBe(true)
    conversationFor(task).approval_mode = 'auto'

    await answerAndRun(
      task,
      { ...bodyFixture, shellAction: 'shell', alwaysApprove: true },
      'desktop'
    )

    const conv = conversationFor(task)
    expect(conv.auto_shell_grants).toEqual({ wholeTool: false, commands: new Set() })
    expect(conv.auto_approved_tools.has('shell_exec')).toBe(false)
    expect(executeSingleTool).toHaveBeenCalledTimes(1)
  })

  it('a shellAction on a card without the descriptor runs once and stores no shell grant', async () => {
    openAuto()
    const task = taskFor('rpc', 'host-1')
    expect(
      await suspend(
        task,
        card(
          bodyFixture.requestId,
          'shell_exec',
          { command: COMMAND },
          {
            authorization_scope: 'exact_invocation',
          }
        )
      )
    ).toBe(true)
    conversationFor(task).approval_mode = 'auto'

    const posted = await answerAndRun(task, { ...bodyFixture, shellAction: 'command' }, 'desktop')

    expect(posted.approvalHandler).toHaveBeenCalledWith(
      expect.objectContaining({ shellAction: 'command' })
    )
    const conv = conversationFor(task)
    expect(conv.auto_shell_grants).toEqual({ wholeTool: false, commands: new Set() })
    expect(conv.auto_approved_tools).toEqual(new Set())
    expect(conv.task_approved_tools?.has('shell_exec') ?? false).toBe(false)
    expect(executeSingleTool).toHaveBeenCalledTimes(1)
  })

  it('command from a desktop whose flag is false resolves to once', async () => {
    openAuto()
    const task = taskFor('rpc', 'host-1')
    expect(
      await suspend(
        task,
        card(
          bodyFixture.requestId,
          'shell_exec',
          { command: COMMAND },
          {
            authorization_scope: 'exact_invocation',
            shellCard: { channelCommandOffered: true, desktopCommandOffered: false },
          }
        )
      )
    ).toBe(true)
    conversationFor(task).approval_mode = 'auto'

    await answerAndRun(task, bodyFixture, 'desktop')

    expect([...conversationFor(task).auto_shell_grants.commands]).toEqual([])
    expect(executeSingleTool).toHaveBeenCalledTimes(1)
  })

  it('command from a channel whose flag is false resolves to once', async () => {
    openAuto()
    const task = taskFor('telegram', 'C-1')
    expect(
      await suspend(
        task,
        card(
          bodyFixture.requestId,
          'shell_exec',
          { command: COMMAND },
          {
            authorization_scope: 'exact_invocation',
            shellCard: { channelCommandOffered: false, desktopCommandOffered: true },
          }
        )
      )
    ).toBe(true)
    conversationFor(task).approval_mode = 'auto'

    await answerAndRun(
      task,
      { ...bodyFixture, userId: 'user-1', channelType: 'telegram', channelId: 'C-1' },
      'channel'
    )

    expect([...conversationFor(task).auto_shell_grants.commands]).toEqual([])
    expect(conversationFor(task).auto_shell_grants.wholeTool).toBe(false)
    expect(executeSingleTool).toHaveBeenCalledTimes(1)
  })

  it('command after only allowModeChange turns false resolves to once', async () => {
    openAuto()
    const task = taskFor('telegram', 'C-1')
    expect(
      await suspend(
        task,
        card(
          bodyFixture.requestId,
          'shell_exec',
          { command: COMMAND },
          {
            authorization_scope: 'exact_invocation',
            shellCard: BOTH_FLAGS,
          }
        )
      )
    ).toBe(true)
    const conv = conversationFor(task)
    expect(conv.channel_type).toBe('telegram')
    conv.approval_mode = 'auto'
    openAuto()
    const closed = policy('allow_all', false)
    agent.setApprovalConfig(closed, closed)

    await answerAndRun(
      task,
      { ...bodyFixture, userId: 'user-1', channelType: 'telegram', channelId: 'C-1' },
      'channel'
    )

    expect(conv.auto_shell_grants).toEqual({ wholeTool: false, commands: new Set() })
    expect(executeSingleTool).toHaveBeenCalledTimes(1)
  })

  it('deny records a denial and resets auto_shell_grants', async () => {
    openAuto()
    const task = taskFor('telegram', 'C-1')
    expect(
      await suspend(
        task,
        card(
          bodyFixture.requestId,
          'shell_exec',
          { command: COMMAND },
          {
            authorization_scope: 'exact_invocation',
            shellCard: BOTH_FLAGS,
          }
        )
      )
    ).toBe(true)
    const conv = conversationFor(task)
    conv.approval_mode = 'auto'
    conv.auto_shell_grants = { wholeTool: true, commands: new Set(['printf keep']) }
    conv.auto_approved_tools.add('shell_exec')

    const posted = await post(
      {
        ...bodyFixture,
        shellAction: 'shell',
        userId: 'user-1',
        channelType: 'telegram',
        channelId: 'C-1',
      },
      false,
      'channel'
    )

    expect(posted.out.statusCode).toBe(200)
    expect(posted.out.jsonBody?.success).toBe(true)
    expect(posted.approvalHandler).toHaveBeenCalledWith(
      expect.objectContaining({ approved: false, alwaysApprove: false })
    )
    expect(conv.denials?.get('shell_exec')).toBe('user-1')
    expect(conv.auto_shell_grants).toEqual({ wholeTool: false, commands: new Set() })
    expect(conv.auto_approved_tools.has('shell_exec')).toBe(false)
    expect(executeSingleTool).not.toHaveBeenCalled()
  })

  it('Always on a waiting manual HTTP card stores nothing after the mode is allow_all', async () => {
    const task = taskFor('rpc', 'host-1')
    expect(
      await suspend(task, card('req-http', 'http_request', { url: 'https://example.test/once' }))
    ).toBe(true)
    const conv = conversationFor(task)
    conv.approval_mode = 'allow_all'
    const live = policy('allow_all', true)
    agent.setApprovalConfig(live, live)

    await answerAndRun(task, { requestId: 'req-http', alwaysApprove: true }, 'desktop')

    expect(executeSingleTool).toHaveBeenCalledTimes(1)
    expect(executeSingleTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'http_request' }),
      expect.anything()
    )
    expect(conv.auto_approved_tools).toEqual(new Set())
    expect(conv.task_approved_tools ?? new Set()).toEqual(new Set())
  })

  it('Always on a waiting MCP turn_tools card stores nothing after the mode is allow_all', async () => {
    const task = taskFor('rpc', 'host-1')
    expect(await suspend(task, card('req-mcp', 'docs__lookup', { query: 'shell card' }))).toBe(true)
    const conv = conversationFor(task)
    conv.approval_mode = 'allow_all'
    const live = policy('allow_all', true)
    agent.setApprovalConfig(live, live)

    await answerAndRun(task, { requestId: 'req-mcp', alwaysApprove: true }, 'desktop')

    expect(executeSingleTool).toHaveBeenCalledTimes(1)
    expect(conv.auto_approved_tools.has('docs__lookup')).toBe(false)
    expect(conv.task_approved_tools?.has('docs__lookup') ?? false).toBe(false)
  })

  it('Always on the same HTTP card stores the name while the mode is still manual', async () => {
    const task = taskFor('rpc', 'host-1')
    expect(
      await suspend(task, card('req-http-manual', 'http_request', { url: 'https://example.test' }))
    ).toBe(true)

    await answerAndRun(task, { requestId: 'req-http-manual', alwaysApprove: true }, 'desktop')

    expect(conversationFor(task).auto_approved_tools).toEqual(new Set(['http_request']))
    expect(executeSingleTool).toHaveBeenCalledTimes(1)
  })

  it('an ordinary cron_manage turn_tools card answered in allow_all stores its task grant', async () => {
    const task = taskFor('rpc', 'host-1')
    expect(
      await suspend(
        task,
        card('req-cron', 'cron_manage', { action: 'create' }, { authorization_scope: 'turn_tools' })
      )
    ).toBe(true)
    const conv = conversationFor(task)
    conv.approval_mode = 'allow_all'
    const live = policy('allow_all', true)
    agent.setApprovalConfig(live, live)

    await answerAndRun(task, { requestId: 'req-cron', alwaysApprove: false }, 'desktop')

    expect(conv.task_approved_tools).toEqual(new Set(['cron_manage']))
    expect(conv.auto_approved_tools.has('cron_manage')).toBe(false)
    expect(executeSingleTool).toHaveBeenCalledTimes(1)
  })

  it('a cron_forced exact_invocation card answered in allow_all stores nothing', async () => {
    const task = taskFor('rpc', 'host-1')
    expect(
      await suspend(
        task,
        card(
          'req-cron-forced',
          'cron_manage',
          { action: 'create' },
          { authorization_scope: 'exact_invocation' }
        )
      )
    ).toBe(true)
    const conv = conversationFor(task)
    conv.approval_mode = 'allow_all'
    const live = policy('allow_all', true)
    agent.setApprovalConfig(live, live)

    await answerAndRun(task, { requestId: 'req-cron-forced', alwaysApprove: true }, 'desktop')

    expect(conv.auto_approved_tools.has('cron_manage')).toBe(false)
    expect(conv.task_approved_tools?.has('cron_manage') ?? false).toBe(false)
    expect(executeSingleTool).toHaveBeenCalledTimes(1)
  })

  it('the poll response and the SSE event carry shellCard', async () => {
    const shellCard = { channelCommandOffered: true, desktopCommandOffered: false }
    const approval = card(
      'req-project',
      'shell_exec',
      { command: COMMAND },
      {
        authorization_scope: 'exact_invocation',
        shellCard,
      }
    )
    vi.mocked(runToolUseLoop).mockResolvedValueOnce({ type: 'need_approval', approval })

    const pending = new ResultStore<PendingTaskEntry>(60_000, entry => entry.storedAt)
    const message: IncomingMessage = {
      sender: 'user-1',
      content: 'Do something',
      channelType: 'rpc',
      channelId: 'host-1',
      messageId: 'msg-project',
      timestamp: new Date().toISOString(),
      hostRef: 'host-1',
    }
    const handler = new IncomingMessageHandler(message, {
      messageQueue: queue,
      agent,
      pendingTaskResults: pending,
      getModel: () => 'test-model',
      sanitizeAttachments: attachments => attachments,
      timeoutMs: 5_000,
      taskLifecycle: lifecycle,
    })
    const responsePromise = handler.execute()
    const syncTask = queue.dequeue()
    expect(syncTask).not.toBeNull()
    await agent.executeTask(syncTask!)
    const response = await responsePromise
    expect(response.approval?.shellCard).toEqual(shellCard)

    const reporter = progressReporterRegistry.get(syncTask!.id)
    expect(reporter).toBeDefined()
    const events: ProgressEvent[] = []
    reporter!.subscribe(event => events.push(event))
    expect(events[0]).toMatchObject({ type: 'suspended', data: { shellCard } })

    vi.mocked(runToolUseLoop).mockResolvedValueOnce({
      type: 'need_approval',
      approval: card(
        'req-poll',
        'shell_exec',
        { command: COMMAND },
        {
          authorization_scope: 'exact_invocation',
          shellCard,
        }
      ),
    })
    const asyncPending = new ResultStore<PendingTaskEntry>(60_000, entry => entry.storedAt)
    const asyncHandler = new IncomingMessageHandler(
      { ...message, channelId: 'host-poll', messageId: 'msg-poll' },
      {
        messageQueue: queue,
        agent,
        pendingTaskResults: asyncPending,
        getModel: () => 'test-model',
        sanitizeAttachments: attachments => attachments,
        taskLifecycle: lifecycle,
      }
    )
    const started = asyncHandler.executeAsync()
    const asyncTask = queue.dequeue()
    expect(asyncTask?.id).toBe(started.taskId)
    await agent.executeTask(asyncTask!)
    const stored = asyncPending.get(asyncTask!.id)
    expect(stored?.approval?.shellCard).toEqual(shellCard)

    const messageHandlerModule = await import('../../messageHandler')
    const project = Reflect.get(messageHandlerModule, 'projectTaskResultApproval') as
      | ((
          taskId: string,
          approval: NonNullable<PendingTaskEntry['approval']>
        ) => { shellCard?: PendingApproval['shellCard'] })
      | undefined
    expect(typeof project).toBe('function')
    expect(project!(asyncTask!.id, stored!.approval!).shellCard).toEqual(shellCard)
  })

  it('the suspension allowlist keeps shellCard', () => {
    const approval = card(
      'req-allow',
      'shell_exec',
      { command: COMMAND },
      {
        authorization_scope: 'exact_invocation',
        shellCard: { channelCommandOffered: true, desktopCommandOffered: false },
      }
    )
    const projected = projectGfsApproval(approval)
    expect(projected.shellCard).toEqual(approval.shellCard)
    expect(projectGfsApproval(projected)).toEqual(projected)
  })
})
