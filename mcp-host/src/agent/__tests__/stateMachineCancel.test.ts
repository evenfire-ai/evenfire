/**
 * AgentStateMachine cancel dispatch via TaskLifecycle.transition — unit tests.
 *
 * B.3: cancelTask() deleted; cancel is now triggered by calling
 * lifecycle.transition(taskId, 'cancelled', 'user_requested').
 * The subscriber in subscribeLifecycle() handles all dispatch logic.
 *
 * Covers: processing path (abort signal), waiting path (denial flow),
 * and unknown taskId (not_found outcome).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runToolUseLoop } from '../../core/orchestration/toolUseLoop'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import { MessageQueue } from '../../queue/messageQueue'
import { Task } from '../../queue/types'
import { AgentStateMachine } from '../stateMachine'

// Mock config to avoid CLERUM_HOST_NAME requirement
vi.mock('../../config', () => ({
  config: {
    devMode: true,
    enableApproval: true,
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

// Mock the orchestration module
vi.mock('../../core/orchestration/toolUseLoop', () => ({
  runToolUseLoop: vi.fn(),
  executeSingleTool: vi.fn(),
  validateToolLinkages: vi.fn(),
}))

function createTestTask(sender: string = 'user-1'): Task {
  return {
    id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    source: 'channel',
    sourceMessage: {
      sender,
      content: 'Do something',
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
        content: 'Do something',
        timestamp: new Date(),
      },
    ],
    responseCallback: vi.fn(async () => {}),
    createdAt: new Date(),
  }
}

function setupAgent(): { sm: AgentStateMachine; lc: TaskLifecycle } {
  const queue = new MessageQueue()
  const lc = new TaskLifecycle()
  const sm = new AgentStateMachine(queue, lc, { autoStart: false })
  const mockProvider = {
    completeSingleTurn: vi.fn(),
    completeSingleTurnWithTools: vi.fn(),
    getProviderType: () => 'openai' as const,
  }
  sm.setLLMProvider(mockProvider as any)
  sm.setMcpManager({ getAllTools: () => [], callTool: vi.fn() } as any)
  sm.start() // Required for getState() to aggregate executor states
  return { sm, lc }
}

describe('AgentStateMachine cancel via TaskLifecycle.transition', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('aborts a processing task when transition fires cancelled', async () => {
    const { sm, lc } = setupAgent()

    // Create a never-resolving loop so the task stays "processing"
    let resolveLoop!: (value: unknown) => void
    const loopPromise = new Promise(resolve => {
      resolveLoop = resolve
    })
    ;(runToolUseLoop as ReturnType<typeof vi.fn>).mockReturnValueOnce(loopPromise)

    const task = createTestTask()
    lc.register(task)

    // Start task without awaiting — it's blocked inside runToolUseLoop
    const executePromise = sm.executeTask(task)

    // Yield so executeTask enters the loop
    await new Promise(resolve => setImmediate(resolve))

    // Should be processing now
    expect(sm.getState()).toBe('processing')

    // Cancel via lifecycle transition (B.3 path)
    const outcome = lc.transition(task.id, 'cancelled', 'user_requested')
    expect(outcome.kind).toBe('applied')

    // Verify the AbortController fired — guards against a silent removal of
    // abortController.abort() in TaskExecutor.abort(). activeExecutors is
    // private, so we use a type cast scoped to this test only.
    const executor = (sm as any).activeExecutors.get(task.id)
    expect(executor.signal.aborted).toBe(true)

    // Resolve the loop promise so the executor can finish (avoids open handles)
    resolveLoop({ type: 'cancelled', reason: 'aborted' })
    await executePromise
  })

  it('cleans up waiting-approval task inline when transition fires cancelled', async () => {
    // B.3: the subscriber does inline cleanup (no handleDenial) for waiting_approval tasks.
    const { sm, lc } = setupAgent()

    ;(runToolUseLoop as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      type: 'need_approval',
      approval: {
        request_id: 'req-cancel-1',
        tool_name: 'shell_exec',
        parameters: { command: 'rm -rf /' },
        description: 'Dangerous command',
        tool_call_id: 'tc_1',
        context_snapshot: [],
      },
    })

    const task = createTestTask()
    lc.register(task)
    await sm.executeTask(task)

    // Now in waiting_approval state
    expect(sm.getState()).toBe('waiting_approval')

    // Cancel via lifecycle transition (B.3 path)
    const outcome = lc.transition(task.id, 'cancelled', 'user_requested')
    expect(outcome.kind).toBe('applied')

    // Subscriber cleans up the executor directly (no handleDenial)
    const executor = (sm as any).activeExecutors.get(task.id)
    expect(executor).toBeUndefined()

    // approvalMap entry is cleaned up
    const approvalEntry = (sm as any).approvalMap.get('req-cancel-1')
    expect(approvalEntry).toBeUndefined()
  })

  it('returns not_found when taskId is unknown', () => {
    const { lc } = setupAgent()
    const outcome = lc.transition('does-not-exist', 'cancelled', 'user_requested')
    expect(outcome.kind).toBe('not_found')
  })

  it('removes executor from activeExecutors on waiting-approval cancel', async () => {
    // Regression: verify the subscriber deletes the executor (no finally block runs for suspended
    // waiting_approval tasks — the subscriber must do it explicitly).
    const { sm, lc } = setupAgent()

    ;(runToolUseLoop as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      type: 'need_approval',
      approval: {
        request_id: 'req-ordering-1',
        tool_name: 'shell_exec',
        parameters: { command: 'whoami' },
        description: 'Check user',
        tool_call_id: 'tc_order',
        context_snapshot: [],
      },
    })

    const task = createTestTask()
    lc.register(task)
    await sm.executeTask(task)
    expect(sm.getState()).toBe('waiting_approval')

    // Confirm executor is present before cancel
    expect((sm as any).activeExecutors.has(task.id)).toBe(true)

    // Cancel via lifecycle transition (B.3 path)
    const outcome = lc.transition(task.id, 'cancelled', 'user_requested')
    expect(outcome.kind).toBe('applied')

    // Executor is removed from activeExecutors after cleanup
    expect((sm as any).activeExecutors.has(task.id)).toBe(false)
    expect((sm as any).approvalMap.has('req-ordering-1')).toBe(false)
  })
})
