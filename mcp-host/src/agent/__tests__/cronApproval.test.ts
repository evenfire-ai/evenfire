/**
 * Cron approval scope differential tests (issue #529 design decision).
 *
 * Scheduled cron execution is autonomous — the runtime approval gate does NOT apply
 * to tasks with source === 'cron'. Interactive channel tasks remain gated.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runToolUseLoop } from '../../core/orchestration/toolUseLoop'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import { MessageQueue } from '../../queue/messageQueue'
import type { Task } from '../../queue/types'
import { SessionProcessor } from '../../session'
import { type PendingCronResult, wireCronDispatch } from '../cronDispatch'
import { CronScheduler } from '../cronScheduler'
import { AgentStateMachine } from '../stateMachine'

// ---------------------------------------------------------------------------
// Mock config and orchestration
// ---------------------------------------------------------------------------

vi.mock('../../config', () => ({
  config: {
    devMode: true,
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
  validateToolLinkages: vi.fn(),
}))

const approvalGateConstructs = {
  unified: 0,
  approval: 0,
}

vi.mock('../../core/extensions/mcpApprovalGateController', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../../core/extensions/mcpApprovalGateController')>()
  return {
    ...actual,
    UnifiedApprovalGateController: class extends actual.UnifiedApprovalGateController {
      constructor(...args: ConstructorParameters<typeof actual.UnifiedApprovalGateController>) {
        approvalGateConstructs.unified++
        super(...args)
      }
    },
  }
})

vi.mock('../../core/extensions/approvalController', async importOriginal => {
  const actual = await importOriginal<typeof import('../../core/extensions/approvalController')>()
  return {
    ...actual,
    ApprovalController: class extends actual.ApprovalController {
      constructor(...args: ConstructorParameters<typeof actual.ApprovalController>) {
        approvalGateConstructs.approval++
        super(...args)
      }
    },
  }
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createChannelTask(sender = 'user-1'): Task {
  return {
    id: `channel-${Date.now()}`,
    source: 'channel',
    sourceMessage: {
      sender,
      content: 'Execute a gated tool',
      channelType: 'telegram',
      channelId: 'test-channel',
      messageId: 'msg-1',
      timestamp: new Date().toISOString(),
      hostRef: 'test-host',
    },
    priority: 'normal',
    status: 'pending',
    conversationHistory: [
      {
        role: 'user',
        content: 'Execute a gated tool',
        timestamp: new Date(),
      },
    ],
    responseCallback: vi.fn(async () => {}),
    createdAt: new Date(),
  }
}

const needApprovalResult = {
  type: 'need_approval' as const,
  approval: {
    request_id: 'req-gated-1',
    tool_name: 'http_request',
    parameters: { url: 'https://example.com', method: 'GET' },
    description: 'Fetch URL',
    tool_call_id: 'tc_1',
    context_snapshot: [],
  },
}

const successResult = {
  type: 'response' as const,
  content: 'Cron task completed successfully',
  usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Cron approval scope — differential contract (issue #529)', () => {
  let scheduler: CronScheduler
  let queue: MessageQueue
  let lifecycle: TaskLifecycle
  let agent: AgentStateMachine
  let pendingCronResults: Map<string, PendingCronResult>
  let sessionProcessor: SessionProcessor

  const origin = {
    channelType: 'telegram' as const,
    channelId: '-5130716657',
    sender: '516801777',
  }

  beforeEach(() => {
    vi.clearAllMocks()
    approvalGateConstructs.unified = 0
    approvalGateConstructs.approval = 0

    lifecycle = new TaskLifecycle()
    queue = new MessageQueue()
    queue.setLifecycle(lifecycle)
    scheduler = new CronScheduler(queue)
    agent = new AgentStateMachine(queue, lifecycle, { autoStart: false })
    agent.setLLMProvider({
      completeSingleTurn: vi.fn(),
      completeSingleTurnWithTools: vi.fn(),
      getProviderType: () => 'openai' as const,
    } as any)
    agent.setMcpManager({ getAllTools: () => [], callTool: vi.fn() } as any)
    agent.start()
    pendingCronResults = new Map()

    sessionProcessor = new SessionProcessor({
      maxConcurrent: 3,
      lifecycle,
      executor: async (task: Task) => agent.executeTask(task),
    })
    agent.setSessionProcessor(sessionProcessor)

    wireCronDispatch(scheduler, {
      sessionProcessor,
      pendingCronResults,
      sanitizeAttachments: attachments => attachments,
    })
  })

  afterEach(() => {
    scheduler.stop()
    agent.stop()
  })

  async function waitForIdle(timeoutMs = 3000): Promise<void> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      if (agent.getState() === 'idle') return
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw new Error(
      `Agent did not return to idle within ${timeoutMs}ms (state=${agent.getState()})`
    )
  }

  it('UT-5: cron task with approval enabled runs to completion without suspension', async () => {
    ;(runToolUseLoop as ReturnType<typeof vi.fn>).mockResolvedValueOnce(successResult)

    const job = scheduler.createJob('HN News', '35 1 1 3 *', 'fetch news', undefined, origin)
    const task = scheduler.triggerJob(job!.id)
    await waitForIdle()

    expect(agent.getState()).toBe('idle')
    expect(pendingCronResults.has(`${task!.id}:approval`)).toBe(false)

    const completed = [...pendingCronResults.entries()].find(
      ([, entry]) => entry.status === 'completed'
    )
    expect(completed).toBeDefined()
    expect(completed![1].cronJobName).toBe('HN News')
    expect(approvalGateConstructs.unified).toBe(0)
    expect(approvalGateConstructs.approval).toBe(0)
  })

  it('UT-6: cron result delivery with origin still works', async () => {
    ;(runToolUseLoop as ReturnType<typeof vi.fn>).mockResolvedValueOnce(successResult)

    const job = scheduler.createJob(
      'Delivery Test',
      '0 * * * *',
      'deliver result',
      undefined,
      origin
    )
    const task = scheduler.triggerJob(job!.id)
    await waitForIdle()

    expect(pendingCronResults.has(task!.id)).toBe(true)
    const entry = pendingCronResults.get(task!.id)!
    expect(entry.status).toBe('completed')
    expect(entry.cronJobId).toBe(job!.id)
    expect(entry.cronJobName).toBe('Delivery Test')
    expect(entry.origin).toEqual(origin)
    expect(entry.response).toContain('Cron task completed successfully')
  })

  it('UT-7: differential — gated tool suspends for channel task, proceeds for cron task', async () => {
    ;(runToolUseLoop as ReturnType<typeof vi.fn>).mockResolvedValue(needApprovalResult)

    const channelTask = createChannelTask()
    lifecycle.register(channelTask)
    await agent.executeTask(channelTask)
    expect(agent.getState()).toBe('waiting_approval')
    const channelUnifiedCount = approvalGateConstructs.unified
    const channelApprovalCount = approvalGateConstructs.approval
    expect(channelUnifiedCount).toBeGreaterThan(0)
    expect(channelApprovalCount).toBeGreaterThan(0)

    agent.stop()
    agent = new AgentStateMachine(queue, lifecycle, { autoStart: false })
    agent.setLLMProvider({
      completeSingleTurn: vi.fn(),
      completeSingleTurnWithTools: vi.fn(),
      getProviderType: () => 'openai' as const,
    } as any)
    agent.setMcpManager({ getAllTools: () => [], callTool: vi.fn() } as any)
    agent.start()
    sessionProcessor = new SessionProcessor({
      maxConcurrent: 3,
      lifecycle,
      executor: async (task: Task) => agent.executeTask(task),
    })
    agent.setSessionProcessor(sessionProcessor)
    wireCronDispatch(scheduler, {
      sessionProcessor,
      pendingCronResults,
      sanitizeAttachments: attachments => attachments,
    })

    const unifiedBeforeCron = approvalGateConstructs.unified
    const approvalBeforeCron = approvalGateConstructs.approval

    ;(runToolUseLoop as ReturnType<typeof vi.fn>).mockResolvedValueOnce(successResult)

    const job = scheduler.createJob('Cron Bypass', '0 * * * *', 'autonomous run', undefined, origin)
    const cronTask = scheduler.triggerJob(job!.id)
    await waitForIdle()

    expect(agent.getState()).toBe('idle')
    expect(approvalGateConstructs.unified).toBe(unifiedBeforeCron)
    expect(approvalGateConstructs.approval).toBe(approvalBeforeCron)
    expect(pendingCronResults.has(`${cronTask!.id}:approval`)).toBe(false)
  })
})
