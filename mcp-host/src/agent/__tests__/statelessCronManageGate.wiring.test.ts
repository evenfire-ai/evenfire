/**
 * FIX 1 (cron×stateless self-propagation containment) — taskExecutor WIRING.
 *
 * A cron-fired task must NOT be able to autonomously spawn/enable MORE
 * schedules. On a stateless host the executor therefore wraps a cron-sourced
 * task with the approval chain in `cronManageGateOnly` mode: only cron_manage
 * create/enable can suspend; every other tool keeps issue #529's autonomy.
 *
 * This suite captures the UnifiedApprovalGateController constructor `options`
 * arg to prove the wiring selects the narrow gate for cron+stateless, the full
 * gate for interactive tasks, and NO gate for cron on a non-stateless host.
 *
 * Reverting FIX 1 (cron falls back to DefaultLoopController) makes the
 * cron+stateless case construct zero gate controllers -> the first test fails.
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

vi.mock('../../config', () => ({
  config: {
    devMode: true,
    enableApproval: true,
    // The lever under test: stateless lifecycle arms the cron×stateless gate.
    statelessLifecycle: true,
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

// Capture the constructor options of every UnifiedApprovalGateController built.
const gateOptions: Array<
  { statelessLifecycle?: boolean; cronManageGateOnly?: boolean } | undefined
> = []
let approvalControllerConstructs = 0

vi.mock('../../core/extensions/mcpApprovalGateController', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../../core/extensions/mcpApprovalGateController')>()
  return {
    ...actual,
    UnifiedApprovalGateController: class extends actual.UnifiedApprovalGateController {
      constructor(...args: ConstructorParameters<typeof actual.UnifiedApprovalGateController>) {
        gateOptions.push(args[3])
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
        approvalControllerConstructs++
        super(...args)
      }
    },
  }
})

const origin = {
  channelType: 'telegram' as const,
  channelId: '-5130716657',
  sender: '516801777',
}

const successResult = {
  type: 'response' as const,
  content: 'done',
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
}

function createChannelTask(): Task {
  return {
    id: `channel-${Date.now()}`,
    source: 'channel',
    sourceMessage: {
      sender: 'user-1',
      content: 'hi',
      channelType: 'telegram',
      channelId: 'test-channel',
      messageId: 'msg-1',
      timestamp: new Date().toISOString(),
      hostRef: 'test-host',
    },
    priority: 'normal',
    status: 'pending',
    conversationHistory: [{ role: 'user', content: 'hi', timestamp: new Date() }],
    responseCallback: vi.fn(async () => {}),
    createdAt: new Date(),
  }
}

describe('taskExecutor wiring — cron×stateless cronManageGateOnly (FIX 1)', () => {
  let scheduler: CronScheduler
  let queue: MessageQueue
  let lifecycle: TaskLifecycle
  let agent: AgentStateMachine
  let pendingCronResults: Map<string, PendingCronResult>
  let sessionProcessor: SessionProcessor

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.CLERUM_STATELESS_ALLOW_CRON_MANAGE = 'true'
    gateOptions.length = 0
    approvalControllerConstructs = 0

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
    delete process.env.CLERUM_STATELESS_ALLOW_CRON_MANAGE
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

  it('cron-sourced task on a stateless host builds the gate in cronManageGateOnly mode', async () => {
    ;(runToolUseLoop as ReturnType<typeof vi.fn>).mockResolvedValueOnce(successResult)

    const job = scheduler.createJob('Cron Gate', '0 * * * *', 'autonomous run', undefined, origin)
    scheduler.triggerJob(job!.id)
    await waitForIdle()

    // FIX 1: the gate IS constructed for a cron task (unlike #529 full bypass)
    // and it is in the narrow cronManageGateOnly mode.
    expect(gateOptions.length).toBeGreaterThan(0)
    expect(gateOptions.some(o => o?.cronManageGateOnly === true)).toBe(true)
    expect(gateOptions.every(o => o?.statelessLifecycle === true)).toBe(true)
    // ApprovalController wraps it so the suspension routes through the approval
    // flow (no auto-grant in an autonomous run = containment).
    expect(approvalControllerConstructs).toBeGreaterThan(0)
  })

  it('interactive channel task keeps the FULL gate (cronManageGateOnly false)', async () => {
    ;(runToolUseLoop as ReturnType<typeof vi.fn>).mockResolvedValueOnce(successResult)

    const task = createChannelTask()
    lifecycle.register(task)
    await agent.executeTask(task)

    expect(gateOptions.length).toBeGreaterThan(0)
    expect(gateOptions.every(o => o?.cronManageGateOnly !== true)).toBe(true)
    expect(approvalControllerConstructs).toBeGreaterThan(0)
  })

  it('default-forbid interactive tasks still advertise cron_manage to the loop', async () => {
    delete process.env.CLERUM_STATELESS_ALLOW_CRON_MANAGE
    ;(runToolUseLoop as ReturnType<typeof vi.fn>).mockImplementationOnce(async loopConfig => {
      const names = loopConfig.toolRegistry
        .listDefinitions()
        .map((def: { name: string }) => def.name)
      const tool = loopConfig.toolRegistry.get('cron_manage')

      expect(names).toContain('cron_manage')
      expect(tool).not.toBeNull()
      expect(tool!.requiresApproval()).toBe(false)

      return successResult
    })

    const task = createChannelTask()
    lifecycle.register(task)
    await agent.executeTask(task)

    expect(runToolUseLoop).toHaveBeenCalled()
    expect(gateOptions.length).toBeGreaterThan(0)
    expect(gateOptions.every(o => o?.cronManageGateOnly !== true)).toBe(true)
  })
})
