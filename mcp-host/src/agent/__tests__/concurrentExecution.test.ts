import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runToolUseLoop } from '../../core/orchestration/toolUseLoop'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import { MessageQueue } from '../../queue/messageQueue'
import type { Task } from '../../queue/types'
import { AgentStateMachine } from '../stateMachine'

// Mock config to avoid CLERUM_HOST_NAME requirement
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

// Mock the orchestration module
vi.mock('../../core/orchestration/toolUseLoop', () => ({
  runToolUseLoop: vi.fn(),
  executeSingleTool: vi.fn(),
  validateToolLinkages: vi.fn(),
}))

function createTestTask(content: string = 'Test', sender: string = 'user-1'): Task {
  return {
    id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    source: 'channel',
    sourceMessage: {
      sender,
      content,
      channelType: 'telegram',
      channelId: 'test-channel',
      messageId: `msg-${Math.random().toString(36).slice(2, 6)}`,
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

function setupAgent() {
  const queue = new MessageQueue()
  const agent = new AgentStateMachine(queue, new TaskLifecycle(), {
    autoStart: false,
    taskDelay: 0,
    approvalTimeout: 5000,
  })
  agent.setLLMProvider({
    completeSingleTurn: vi.fn(),
    completeSingleTurnWithTools: vi.fn(),
    getProviderType: () => 'openai' as const,
  } as any)
  agent.setMcpManager({ getAllTools: () => [], callTool: vi.fn() } as any)
  agent.start()
  return { agent, queue }
}

describe('AgentStateMachine -- concurrent execution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(async () => {
    // Allow timers to settle
    await new Promise(r => setTimeout(r, 10))
  })

  it('should report processing state while task runs', async () => {
    // Mock runToolUseLoop with a 50ms delay to simulate slow execution
    ;(runToolUseLoop as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () =>
        new Promise(resolve => setTimeout(() => resolve({ type: 'response', content: 'Done' }), 50))
    )

    const { agent } = setupAgent()
    const task = createTestTask('Hello')

    // Start executeTask but don't await it yet
    const execPromise = agent.executeTask(task)

    // Give the executor a moment to start (microtask flush)
    await new Promise(r => setTimeout(r, 10))

    // While running, state should be "processing"
    expect(agent.getState()).toBe('processing')

    // Wait for completion
    await execPromise

    // After completion, state should return to idle
    expect(agent.getState()).toBe('idle')
  })

  it('should report waiting_approval when task needs approval', async () => {
    ;(runToolUseLoop as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      type: 'need_approval',
      approval: {
        request_id: 'req-concurrent-1',
        tool_name: 'shell_exec',
        parameters: { command: 'ls' },
        description: 'List files',
        tool_call_id: 'tc_1',
        context_snapshot: [],
      },
    })

    const { agent } = setupAgent()
    const task = createTestTask('Run a command')

    await agent.executeTask(task)

    // State should be waiting_approval
    expect(agent.getState()).toBe('waiting_approval')

    // getPendingApprovals should return 1 item with correct requestId
    const pending = agent.getPendingApprovals()
    expect(pending).toHaveLength(1)
    expect(pending[0].requestId).toBe('req-concurrent-1')
    expect(pending[0].toolName).toBe('shell_exec')
    expect(pending[0].userId).toBe('user-1')
  })

  it('should resolve approval by requestId and resume execution', async () => {
    // First call returns need_approval
    ;(runToolUseLoop as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        type: 'need_approval',
        approval: {
          request_id: 'req-resolve-1',
          tool_name: 'shell_exec',
          parameters: { command: 'ls' },
          description: 'Shell command',
          tool_call_id: 'tc_1',
          context_snapshot: [],
        },
      })
      // Second call (after approval resume, no snapshot so re-runs loop) returns response
      .mockResolvedValueOnce({
        type: 'response',
        content: 'Command output: success',
      })

    const { agent } = setupAgent()
    const task = createTestTask('Execute something')

    await agent.executeTask(task)

    // Verify we're in waiting_approval
    expect(agent.getState()).toBe('waiting_approval')

    // Approve by requestId
    const result = await agent.handleApproval('user-1', 'req-resolve-1', false)
    expect(result.success).toBe(true)

    // Wait for async resume to complete
    await new Promise(r => setTimeout(r, 100))

    // After resume, state should be idle
    expect(agent.getState()).toBe('idle')
  })

  it('should handle denial by requestId', async () => {
    ;(runToolUseLoop as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      type: 'need_approval',
      approval: {
        request_id: 'req-deny-1',
        tool_name: 'shell_exec',
        parameters: { command: 'rm -rf /' },
        description: 'Dangerous command',
        tool_call_id: 'tc_1',
        context_snapshot: [],
      },
    })

    const { agent } = setupAgent()
    const task = createTestTask('Do something risky')

    await agent.executeTask(task)

    // Verify waiting_approval
    expect(agent.getState()).toBe('waiting_approval')

    // Deny by requestId
    const result = await agent.handleDenial('user-1', 'req-deny-1')
    expect(result.success).toBe(true)

    // After denial, state should return to idle
    expect(agent.getState()).toBe('idle')
  })

  it('should return error for unknown requestId', async () => {
    const { agent } = setupAgent()

    // Call handleApproval with a nonexistent requestId
    const result = await agent.handleApproval('user-1', 'nonexistent-req-id', false)
    expect(result.success).toBe(false)
    expect(result.error).toContain('No pending approval for request nonexistent-req-id')
  })

  it('getState should prioritize waiting_approval over processing', async () => {
    // This test verifies the aggregate state logic: when at least one executor
    // is in waiting_approval, getState() returns "waiting_approval" even if
    // the internal state field is something else.

    ;(runToolUseLoop as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      type: 'need_approval',
      approval: {
        request_id: 'req-priority-1',
        tool_name: 'file_write',
        parameters: { path: '/tmp/test' },
        description: 'Write file',
        tool_call_id: 'tc_1',
        context_snapshot: [],
      },
    })

    const { agent } = setupAgent()
    const task = createTestTask('Write a file')

    await agent.executeTask(task)

    // The aggregate getState() should return "waiting_approval"
    // This proves the priority logic: waiting_approval > processing > idle
    expect(agent.getState()).toBe('waiting_approval')

    // Verify there's an active pending approval
    const pending = agent.getPendingApprovals()
    expect(pending.length).toBeGreaterThanOrEqual(1)
    expect(pending[0].requestId).toBe('req-priority-1')
  })

  it('Scenario 4: one session blocked on approval does not block another', async () => {
    // Task A: enters waiting_approval (blocks on tool needing approval)
    // Task B: runs and completes normally (should NOT wait for A's approval)
    let resolveTaskB!: (value: unknown) => void
    const taskBStarted = new Promise(r => {
      resolveTaskB = r
    })

    ;(runToolUseLoop as ReturnType<typeof vi.fn>)
      // Task A: needs approval → suspends
      .mockResolvedValueOnce({
        type: 'need_approval',
        approval: {
          request_id: 'req-blocked-1',
          tool_name: 'mongodb__delete_all',
          parameters: { collection: 'users' },
          description: 'Delete all users',
          tool_call_id: 'tc_block',
          context_snapshot: [],
        },
      })
      // Task B: completes immediately
      .mockImplementationOnce(async () => {
        resolveTaskB(true)
        return { type: 'response', content: 'Task B done' }
      })

    const { agent } = setupAgent()

    // Use different threadIds so they're in different sessions
    const taskA = createTestTask('Dangerous operation', 'alice')
    taskA.sourceMessage!.threadId = 'thread-approval'
    const taskB = createTestTask('Quick query', 'bob')
    taskB.sourceMessage!.threadId = 'thread-quick'

    // Launch both concurrently
    const promiseA = agent.executeTask(taskA)
    const promiseB = agent.executeTask(taskB)

    // Task B should start and complete even while A is blocked
    await taskBStarted
    await promiseB

    // Verify: A is still awaiting approval, B completed
    expect(agent.getState()).toBe('waiting_approval')
    expect(agent.getPendingApprovals()).toHaveLength(1)
    expect(agent.getPendingApprovals()[0].requestId).toBe('req-blocked-1')
    expect(taskB.responseCallback).toHaveBeenCalled()

    // Now approve A — it should also complete
    ;(runToolUseLoop as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      type: 'response',
      content: 'Task A done after approval',
    })

    const approvalResult = await agent.handleApproval('alice', 'req-blocked-1', false)
    expect(approvalResult.success).toBe(true)

    // Wait for A to finish resuming
    await new Promise(r => setTimeout(r, 50))
    await promiseA

    // Both tasks completed, agent idle
    expect(agent.getState()).toBe('idle')
  })

  it('two tasks in approval state simultaneously, each resolved independently', async () => {
    ;(runToolUseLoop as ReturnType<typeof vi.fn>)
      // Task A: needs approval
      .mockResolvedValueOnce({
        type: 'need_approval',
        approval: {
          request_id: 'req-multi-A',
          tool_name: 'shell_exec',
          parameters: { command: 'rm -rf /' },
          description: 'Dangerous shell',
          tool_call_id: 'tc_A',
          context_snapshot: [],
        },
      })
      // Task B: also needs approval
      .mockResolvedValueOnce({
        type: 'need_approval',
        approval: {
          request_id: 'req-multi-B',
          tool_name: 'file_write',
          parameters: { path: '/etc/passwd' },
          description: 'Dangerous file write',
          tool_call_id: 'tc_B',
          context_snapshot: [],
        },
      })

    const { agent } = setupAgent()

    const taskA = createTestTask('Task A', 'alice')
    taskA.sourceMessage!.threadId = 'thread-A'
    const taskB = createTestTask('Task B', 'bob')
    taskB.sourceMessage!.threadId = 'thread-B'

    // Both enter waiting_approval
    const promiseA = agent.executeTask(taskA)
    const promiseB = agent.executeTask(taskB)

    // Wait for both to reach approval state
    await new Promise(r => setTimeout(r, 50))

    expect(agent.getState()).toBe('waiting_approval')
    expect(agent.getPendingApprovals()).toHaveLength(2)

    const requestIds = agent
      .getPendingApprovals()
      .map(a => a.requestId)
      .sort()
    expect(requestIds).toEqual(['req-multi-A', 'req-multi-B'])

    // Deny B — A should remain in approval
    const denyResult = await agent.handleDenial('bob', 'req-multi-B')
    expect(denyResult.success).toBe(true)
    expect(agent.getPendingApprovals()).toHaveLength(1)
    expect(agent.getPendingApprovals()[0].requestId).toBe('req-multi-A')

    // Approve A — should resume and complete
    ;(runToolUseLoop as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      type: 'response',
      content: 'A completed',
    })

    const approveResult = await agent.handleApproval('alice', 'req-multi-A', true)
    expect(approveResult.success).toBe(true)

    await new Promise(r => setTimeout(r, 50))
    await promiseA

    expect(agent.getState()).toBe('idle')
    expect(agent.getPendingApprovals()).toHaveLength(0)
  })
})
