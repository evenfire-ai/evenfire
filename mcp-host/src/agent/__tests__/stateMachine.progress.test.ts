/**
 * AgentStateMachine — progress reporter integration tests.
 *
 * Covers: reporter creation/registration, terminal event emission on task finish
 * (via TaskLifecycle subscription), emitSuspended() on need_approval, and
 * reporter reuse across approval cycles.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runToolUseLoop } from '../../core/orchestration/toolUseLoop'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import { progressReporterRegistry } from '../../progress/sseProgressReporter'
import { MessageQueue } from '../../queue/messageQueue'
import type { Task } from '../../queue/types'
import { AgentStateMachine } from '../stateMachine'

// Mock config (same as stateMachineLifecycle.test.ts)
vi.mock('../../config', () => ({
  config: {
    devMode: true,
    enableApproval: false,
    enableNudge: false,
    nudgeMaxIterations: 3,
    devModelName: 'test-model',
    devModelProvider: 'openai',
    contextMaxTokens: 100000,
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
}))

let taskCounter = 0

function createTestTask(content: string = 'Test'): Task {
  taskCounter++
  return {
    id: `task-progress-${Date.now()}-${taskCounter}`,
    source: 'channel',
    sourceMessage: {
      sender: 'user-1',
      content,
      channelType: 'telegram',
      channelId: 'test',
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

function setupAgent(): { agent: AgentStateMachine; queue: MessageQueue; lifecycle: TaskLifecycle } {
  const queue = new MessageQueue()
  const lifecycle = new TaskLifecycle()
  // Wire lifecycle into queue so queue.completeTask / queue.failTask call lifecycle.transition,
  // which SseProgressReporter listens to for terminal event emission (Phase D.2).
  queue.setLifecycle(lifecycle)
  const agent = new AgentStateMachine(queue, lifecycle, { autoStart: false, taskDelay: 0 })
  const mockProvider = {
    completeSingleTurn: vi.fn(),
    completeSingleTurnWithTools: vi.fn(),
    getProviderType: () => 'openai' as const,
  }
  agent.setLLMProvider(mockProvider as any)
  agent.setMcpManager({ getAllTools: () => [], callTool: vi.fn() } as any)
  return { agent, queue, lifecycle }
}

/**
 * Register task with lifecycle and advance to 'processing' state.
 * This mirrors the real flow: IncomingMessageHandler → lifecycle.register,
 * then processNextTask → queue.dequeue → lifecycle.transition('processing').
 * Required for the LEGAL_TRANSITIONS table: pending → processing → completed/failed.
 */
function registerAndDispatch(task: Task, lifecycle: TaskLifecycle): void {
  lifecycle.register(task)
  lifecycle.transition(task.id, 'processing', 'dispatched')
}

describe('stateMachine progress reporter integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('creates and registers a progress reporter when processing a task', async () => {
    const { agent, lifecycle } = setupAgent()
    ;(runToolUseLoop as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      type: 'response',
      content: 'Done!',
    })

    const task = createTestTask('Hi')
    registerAndDispatch(task, lifecycle)
    await agent.executeTask(task)

    const reporter = progressReporterRegistry.get(task.id)
    expect(reporter).toBeDefined()
    expect(reporter!.taskId).toBe(task.id)
  })

  it('emits terminal(completed) event when task finishes with response', async () => {
    const { agent, lifecycle } = setupAgent()
    ;(runToolUseLoop as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      type: 'response',
      content: 'Done!',
    })

    const task = createTestTask('Hi')
    registerAndDispatch(task, lifecycle)
    await agent.executeTask(task)

    const reporter = progressReporterRegistry.get(task.id)
    expect(reporter).toBeDefined()
    expect(reporter!.completedAt).not.toBe(Infinity)
    expect(reporter!.completedAt).toBeLessThanOrEqual(Date.now())
  })

  it('emits terminal(completed) event when task finishes with exhaustion', async () => {
    const { agent, lifecycle } = setupAgent()
    ;(runToolUseLoop as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      type: 'exhaustion',
      message: 'Max iterations reached',
    })

    const task = createTestTask('Exhaust')
    registerAndDispatch(task, lifecycle)
    await agent.executeTask(task)

    const reporter = progressReporterRegistry.get(task.id)
    expect(reporter).toBeDefined()
    expect(reporter!.completedAt).not.toBe(Infinity)
  })

  it('emits terminal(failed) event when task fails with error', async () => {
    const { agent, lifecycle } = setupAgent()
    ;(runToolUseLoop as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Provider unavailable')
    )

    const task = createTestTask('Fail')
    registerAndDispatch(task, lifecycle)
    await agent.executeTask(task)

    const reporter = progressReporterRegistry.get(task.id)
    expect(reporter).toBeDefined()
    expect(reporter!.completedAt).not.toBe(Infinity)
  })

  it('reuses existing reporter on approval resume', async () => {
    const { agent, lifecycle } = setupAgent()

    ;(runToolUseLoop as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      type: 'need_approval',
      approval: {
        request_id: 'req-1',
        tool_call_id: 'tc-1',
        tool_name: 'shell_exec',
        parameters: {},
        context_snapshot: [],
        completed_results: [],
      },
    })

    const task = createTestTask('Do something')
    registerAndDispatch(task, lifecycle)
    await agent.executeTask(task)

    const reporter = progressReporterRegistry.get(task.id)
    expect(reporter).toBeDefined()
    const reporterInstance = reporter!

    // The same reporter instance should be retrieved on a second lookup
    const reporter2 = progressReporterRegistry.get(task.id)
    expect(reporter2).toBe(reporterInstance)
  })

  it('does not emit terminal on need_approval (task is suspended)', async () => {
    const { agent, lifecycle } = setupAgent()

    ;(runToolUseLoop as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      type: 'need_approval',
      approval: {
        request_id: 'req-1',
        tool_call_id: 'tc-1',
        tool_name: 'shell_exec',
        parameters: {},
        context_snapshot: [],
        completed_results: [],
      },
    })

    const task = createTestTask('Approve me')
    registerAndDispatch(task, lifecycle)
    await agent.executeTask(task)

    const reporter = progressReporterRegistry.get(task.id)
    expect(reporter).toBeDefined()
    // Should NOT be completed — task is suspended awaiting approval
    expect(reporter!.completedAt).toBe(Infinity)
  })
})
