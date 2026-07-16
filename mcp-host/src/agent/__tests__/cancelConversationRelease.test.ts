/**
 * BUG-8 regression tests: cancel must release conversation turn lock.
 *
 * Two cancel paths:
 *  1. Processing branch — executor's handleLoopResult('cancelled') must call
 *     conversationManager.failTurn() so conv.state returns to Idle.
 *  2. Waiting-approval branch — cancel subscriber calls clearPendingApproval()
 *     which must also reset conv.state to Idle (not just clear pending_approval).
 *
 * Both tests verify the same invariant:
 *   after cancel, conv.state === Idle AND a subsequent startTurn does NOT throw.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ConversationManager } from '../../core/conversation/conversation'
import { SimpleEventEmitter } from '../../core/orchestration/eventEmitter'
import { runToolUseLoop } from '../../core/orchestration/toolUseLoop'
import { registerDesktopTools } from '../../core/tools/desktopTools'
import { ConversationState } from '../../core/types'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import { MessageQueue } from '../../queue'
import type { Task } from '../../queue/types'
import { serializeSessionKey } from '../../session/types'
import { AgentStateMachine } from '../stateMachine'
import { TaskExecutor, type TaskExecutorDeps } from '../taskExecutor'

// ── mocks (match taskExecutor.test.ts pattern) ───────────────────────────────

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

// ── helpers ───────────────────────────────────────────────────────────────────

function createTask(id?: string): Task {
  return {
    id: id ?? `task-bug8-${Date.now()}`,
    source: 'channel' as const,
    sourceMessage: {
      sender: 'bug8-user',
      content: 'test',
      channelType: 'telegram' as const,
      channelId: 'bug8-channel',
      messageId: 'msg-bug8',
      timestamp: new Date().toISOString(),
      hostRef: 'test-host',
    },
    priority: 'normal' as const,
    status: 'pending' as const,
    conversationHistory: [{ role: 'user' as const, content: 'test', timestamp: new Date() }],
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

describe('BUG-8: cancel releases conversation lock', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(registerDesktopTools).mockResolvedValue(undefined)
  })

  // ── Test 1: processing branch ───────────────────────────────────────────────
  //
  // The handleLoopResult 'cancelled' case in TaskExecutor did NOT call
  // conversationManager.failTurn(), leaving conv.state stuck in Processing.
  // Fix: add failTurn() call to parity with the 'error' case.
  it('processing branch: handleLoopResult cancelled releases conversation lock (BUG-8 Part A)', async () => {
    // The tool-use loop returns 'cancelled' (checkpoint detection after abort)
    ;(runToolUseLoop as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      type: 'cancelled',
      reason: 'user_requested',
    })

    const lc = new TaskLifecycle()
    const cm = new ConversationManager()
    const task = createTask('t-bug8-processing')

    // Register the task so transition() works
    lc.register(task)
    lc.transition(task.id, 'processing', 'dispatched')

    const deps = createDeps({ conversationManager: cm, taskLifecycle: lc })
    const executor = new TaskExecutor(task, deps)

    // Run — handleLoopResult 'cancelled' fires (loop resolves cancelled immediately)
    await executor.run()

    // The executor computes a sessionKey internally and manages the conversation.
    // We must look up the same key the executor uses:
    // serializeSessionKey({ userId: 'bug8-user', channelType: 'telegram', channelId: 'bug8-channel', threadId: undefined })
    const sessionKey = serializeSessionKey({
      userId: 'bug8-user',
      channelType: 'telegram',
      channelId: 'bug8-channel',
      threadId: undefined,
    })
    const conv = await cm.getOrCreate(sessionKey)

    // Invariant: state must be Idle after cancelled (BUG-8: was Processing)
    expect(conv.state).toBe(ConversationState.Idle)
    expect(conv.pending_approval).toBeUndefined()

    // Subsequent startTurn must NOT throw — proves the lock is released
    await expect(cm.startTurn(conv, 'post-cancel message', 'test-task')).resolves.toBeDefined()
  })

  // ── Test 2: waiting_approval branch ────────────────────────────────────────
  //
  // The cancel subscriber called clearPendingApproval(sessionKey) which only
  // cleared conv.pending_approval but did NOT reset conv.state from
  // AwaitingApproval to Idle.
  // Fix: strengthen clearPendingApproval to also set conv.state = Idle.
  it('waiting_approval branch: clearPendingApproval resets state to Idle (BUG-8 Part B)', async () => {
    const cm = new ConversationManager()

    // Build sessionKey exactly as the cancel subscriber does:
    // serializeSessionKey({ userId: msg.sender, channelType, channelId, threadId })
    const sessionKey = serializeSessionKey({
      userId: 'user-bug8',
      channelType: 'telegram',
      channelId: 'ch-bug8',
      threadId: undefined,
    })
    const conv = await cm.getOrCreate(sessionKey)

    // Drive to AwaitingApproval (executor suspended for approval)
    await cm.startTurn(conv, 'initial message', 'test-task')
    await cm.suspendForApproval(conv, {
      request_id: 'r-bug8',
      tool_name: 'some__tool',
      tool_call_id: 'c-bug8',
      parameters: {},
      description: 'needs approval',
      context_snapshot: [],
    })
    expect(conv.state).toBe(ConversationState.AwaitingApproval)
    expect(conv.pending_approval?.request_id).toBe('r-bug8')

    // Simulate what the cancel subscriber does
    await cm.clearPendingApproval(sessionKey)

    // Invariant: both pending_approval AND state must be reset (BUG-8: state was stuck)
    expect(conv.pending_approval).toBeUndefined()
    expect(conv.state).toBe(ConversationState.Idle)

    // Subsequent startTurn must NOT throw — proves the lock is released
    await expect(cm.startTurn(conv, 'post-cancel message', 'test-task')).resolves.toBeDefined()
    expect(conv.state).toBe(ConversationState.Processing)
  })

  // ── Test 3: clearPendingApproval no-ops on unknown key ────────────────────
  it('clearPendingApproval no-ops safely on unknown session key', async () => {
    const cm = new ConversationManager()
    await expect(cm.clearPendingApproval('does-not-exist')).resolves.toBeUndefined()
  })
})

describe('BUG-9 integration: buildMessageHistory clean after cancel + next turn', () => {
  it('BUG-9 integration: buildMessageHistory is clean after cancel + next turn', async () => {
    const lc = new TaskLifecycle()
    const mq = new MessageQueue()
    mq.setLifecycle(lc)
    const agent = new AgentStateMachine(mq, lc)
    const cm = agent.getConversationManager()

    const sessionKey = 'bug9-session-processing'
    const conv = await cm.getOrCreate(sessionKey)
    await cm.startTurn(conv, 'essay please', 'test-task')
    // Simulate the fix: cancelled case calls cancelTurn (not failTurn)
    cm.cancelTurn(conv)
    await cm.startTurn(conv, '12 - 32', 'test-task')

    const history = cm.buildMessageHistory(conv)
    expect(history.map(m => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(history[1].content).toBe('[Task cancelled by user before completion]')
  })
})
