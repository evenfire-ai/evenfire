/**
 * AgentStateMachine — lifecycle & state management tests.
 *
 * Covers: start/stop/pause/resume, task processing, stats tracking,
 * and event emission.  Approval flows are tested in approval.test.ts.
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

// Mock the orchestration module
vi.mock('../../core/orchestration/toolUseLoop', () => ({
  runToolUseLoop: vi.fn(),
  executeSingleTool: vi.fn(),
  validateToolLinkages: vi.fn(),
}))

function createTestTask(content: string = 'Test'): Task {
  return {
    id: `task-${Date.now()}`,
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
  const lifecycle = new TaskLifecycle()
  const queue = new MessageQueue()
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

// ---------------------------------------------------------------------------
// 1. Lifecycle (start / stop / pause / resume)
// ---------------------------------------------------------------------------

describe('AgentStateMachine — lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should start in idle state', () => {
    const { agent } = setupAgent()
    expect(agent.getState()).toBe('idle')
  })

  it('should transition through start/pause/resume/stop', async () => {
    const { agent } = setupAgent()
    agent.start()
    expect(agent.getState()).toBe('idle') // idle until task arrives

    agent.pause()
    expect(agent.getState()).toBe('paused')

    agent.resume()
    expect(agent.getState()).toBe('idle')

    await agent.stop()
    expect(agent.getState()).toBe('idle')
  })

  it('should not start twice', () => {
    const { agent } = setupAgent()
    agent.start()
    agent.start() // should be a no-op
    expect(agent.getState()).toBe('idle')
  })
})

// ---------------------------------------------------------------------------
// 2. Task processing
// ---------------------------------------------------------------------------

describe('AgentStateMachine — task processing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should process a task and call responseCallback on success', async () => {
    const { agent } = setupAgent()
    ;(runToolUseLoop as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      type: 'response',
      content: 'Hello!',
    })

    const task = createTestTask('Hi')
    await agent.executeTask(task)

    expect(task.responseCallback).toHaveBeenCalledWith(
      expect.objectContaining({ response: 'Hello!' })
    )
  })

  it('should handle LLM errors gracefully', async () => {
    const { agent } = setupAgent()
    ;(runToolUseLoop as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Provider unavailable')
    )

    const task = createTestTask('Fail')
    await agent.executeTask(task)

    // Task should be failed, not crashed
    expect(task.status).toBe('failed')
  })

  it('should fail task when no LLM provider is set', async () => {
    const queue = new MessageQueue()
    const agent = new AgentStateMachine(queue, new TaskLifecycle(), { autoStart: false })
    // Do NOT set LLM provider

    const task = createTestTask('No provider')
    await agent.executeTask(task)

    expect(task.status).toBe('failed')
  })

  it('should handle exhaustion result', async () => {
    const { agent } = setupAgent()
    ;(runToolUseLoop as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      type: 'exhaustion',
      message: 'Max iterations reached',
    })

    const task = createTestTask('Exhaust')
    await agent.executeTask(task)

    expect(task.responseCallback).toHaveBeenCalledWith(
      expect.objectContaining({ response: 'Max iterations reached' })
    )
  })
})

// ---------------------------------------------------------------------------
// 3. Stats tracking
// ---------------------------------------------------------------------------

describe('AgentStateMachine — stats', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should track task statistics', async () => {
    const { agent, lifecycle } = setupAgent()
    ;(runToolUseLoop as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      type: 'response',
      content: 'Done',
    })

    const task = createTestTask()
    // Register + dispatch with lifecycle so stats are tracked (Phase E: getStats() derives
    // from lifecycle). SessionProcessor normally does this; here we do it manually.
    lifecycle.register(task)
    lifecycle.transition(task.id, 'processing', 'dispatched')
    await agent.executeTask(task)

    const stats = agent.getStats()
    expect(stats.tasksSucceeded).toBe(1)
    expect(stats.tasksFailed).toBe(0)
  })

  it('should report uptime', () => {
    const { agent } = setupAgent()
    const stats = agent.getStats()
    expect(stats.uptime).toBeGreaterThanOrEqual(0)
  })
})

// ---------------------------------------------------------------------------
// 4. Event emission
// ---------------------------------------------------------------------------

describe('AgentStateMachine — events', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should emit state:changed events', () => {
    const { agent } = setupAgent()
    const events: unknown[] = []
    agent.on('state:changed', e => events.push(e))

    agent.start()
    agent.pause()
    agent.resume()

    expect(events.length).toBeGreaterThanOrEqual(2)
  })

  it('should emit task:completed on success', async () => {
    const { agent } = setupAgent()
    ;(runToolUseLoop as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      type: 'response',
      content: 'OK',
    })

    const events: unknown[] = []
    agent.on('task:completed', e => events.push(e))

    const task = createTestTask()
    await agent.executeTask(task)

    expect(events).toHaveLength(1)
  })

  it('should emit task:failed on error', async () => {
    const { agent } = setupAgent()
    ;(runToolUseLoop as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Boom'))

    const events: unknown[] = []
    agent.on('task:failed', e => events.push(e))

    const task = createTestTask()
    await agent.executeTask(task)

    expect(events).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 5. PR-186 M6 — handleApprovalTimeout uses 'approval_timeout' reason
// ---------------------------------------------------------------------------

describe('AgentStateMachine — approval timeout reason (PR-186 M6)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('PR-186 M6: handleApprovalTimeout transitions lifecycle with reason=approval_timeout', () => {
    const { agent, lifecycle } = setupAgent()

    // Register a task and advance it to waiting_approval so the lifecycle
    // has a valid record that can accept the timeout transition.
    const task = createTestTask()
    lifecycle.register(task)
    lifecycle.transition(task.id, 'processing', 'dispatched')
    lifecycle.transition(task.id, 'waiting_approval', 'natural')

    // Build a mock executor in waiting_approval state
    const mockExecutor = {
      deny: vi.fn(),
      abort: vi.fn(),
      pendingApproval: {
        request_id: 'r-timeout',
        tool_name: 'some_tool',
        tool_call_id: 'tc-timeout',
        parameters: {},
        description: 'test',
      },
      sourceTask: task,
      executorState: 'waiting_approval',
    }
    ;(agent as any).activeExecutors.set(task.id, mockExecutor)
    ;(agent as any).approvalMap.set('r-timeout', {
      taskId: task.id,
      timerId: undefined,
      registeredAt: new Date(),
    })

    // Trigger the private method directly (bypassing the timer)
    ;(agent as any).handleApprovalTimeout('r-timeout')

    // The lifecycle record must be terminal with reason='approval_timeout'
    const record = lifecycle.get(task.id)
    expect(record).toBeDefined()
    expect(record!.status).toBe('completed')
    expect(record!.reason).toBe('approval_timeout')

    // executor.deny() must still be called to send the denial response
    expect(mockExecutor.deny).toHaveBeenCalledOnce()

    // approvalMap entry must be cleaned up
    expect((agent as any).approvalMap.has('r-timeout')).toBe(false)

    // executor must be removed from active map
    expect((agent as any).activeExecutors.has(task.id)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 6. PR-193 review #2 — cleanup-before-transition ordering
// ---------------------------------------------------------------------------

describe('AgentStateMachine — cleanup-before-transition ordering (PR-193 review #2)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('REVIEW-2: handleApprovalTimeout deletes approvalMap+activeExecutors BEFORE firing transition', () => {
    const { agent, lifecycle } = setupAgent()

    // Register a task and advance it to waiting_approval (mirrors M6 setup exactly)
    const task = createTestTask()
    task.id = 't-review-2'
    lifecycle.register(task)
    lifecycle.transition(task.id, 'processing', 'dispatched')
    lifecycle.transition(task.id, 'waiting_approval', 'natural')

    const mockExecutor = {
      deny: vi.fn(),
      abort: vi.fn(),
      pendingApproval: {
        request_id: 'r-review-2',
        tool_name: 'some_tool',
        tool_call_id: 'tc-review-2',
        parameters: {},
        description: 'test',
      },
      sourceTask: task,
      executorState: 'waiting_approval',
    }
    ;(agent as any).activeExecutors.set(task.id, mockExecutor)
    ;(agent as any).approvalMap.set('r-review-2', {
      taskId: task.id,
      timerId: undefined,
      registeredAt: new Date(),
    })

    // Install a subscriber that snapshots coordinator state at the moment
    // the transition event fires. EventEmitter.emit() is synchronous, so
    // the snapshot captures whatever state exists at emit-time.
    const snapshotsAtTransition: Array<{ hasApprovalEntry: boolean; hasExecutorEntry: boolean }> =
      []
    lifecycle.on('transition', ev => {
      if (ev.taskId !== 't-review-2') return
      if (ev.to !== 'completed') return
      snapshotsAtTransition.push({
        hasApprovalEntry: (agent as any).approvalMap.has('r-review-2'),
        hasExecutorEntry: (agent as any).activeExecutors.has('t-review-2'),
      })
    })

    // Trigger the private method directly (bypassing the timer)
    ;(agent as any).handleApprovalTimeout('r-review-2')

    // Exactly one snapshot must have been taken (the completed transition)
    expect(snapshotsAtTransition).toHaveLength(1)
    // At the moment the transition fired, both maps must already be cleaned
    expect(snapshotsAtTransition[0]).toEqual({ hasApprovalEntry: false, hasExecutorEntry: false })
  })
})

// ---------------------------------------------------------------------------
// 4. compactSession concurrency guard (B2)
// ---------------------------------------------------------------------------

describe('AgentStateMachine — compactSession concurrency', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('compactSession returns session_busy when another compaction is already in flight for the same session', async () => {
    // Regression for B2: two overlapping POST /v1/runtime/compact calls used
    // to both pass the executor check, then race on conv.compactionState and
    // on the daily-log append across the LLM await. The compactionsInFlight
    // set guarantees mutual exclusion among operator-triggered compactions.
    const { agent } = setupAgent()
    const conv = await (agent as any).conversationManager.getOrCreate('test-key-b2')
    expect(conv).toBeDefined()

    // Simulate an in-flight operator compaction by pre-populating the guard.
    ;(agent as any).compactionsInFlight.add('test-key-b2')

    const result = await agent.compactSession({ sessionKey: 'test-key-b2' })
    expect(result.kind).toBe('session_busy')
  })

  it('compactSession releases the slot when the session is not found (early-return path)', async () => {
    // Ensures the in-flight guard does not leak when the method short-circuits.
    // not_found returns BEFORE adding to the set, so the set must stay empty.
    const { agent } = setupAgent()
    const result = await agent.compactSession({ sessionKey: 'never-existed' })
    expect(result.kind).toBe('not_found')
    expect((agent as any).compactionsInFlight.size).toBe(0)
  })

  it('compactSession returns session_busy when an executor owns the session under its serialized key (H1 regression)', async () => {
    // H1 regression: before the session-key identity fix, conversation.user_id
    // was the bare sender while TaskExecutor.sessionKey returned user_id, so the
    // executor-busy guard `exec.sessionKey === opts.sessionKey` compared a bare
    // sender against the serialized key and could NEVER match — the guard was
    // dead code in production. With session_key stored on the Conversation and
    // surfaced by the getter, a realistic serialized key now matches.
    const { agent } = setupAgent()
    const sessionKey = 'user-abc:rpc:default:thread-1'
    const conv = await (agent as any).conversationManager.getOrCreate(sessionKey, {
      userId: 'user-abc',
      channelType: 'rpc',
      channelId: 'default',
      threadId: 'thread-1',
    })
    // Sanity: the conversation stores the serialized key (not the bare sender).
    expect(conv.session_key).toBe(sessionKey)
    expect(conv.user_id).toBe('user-abc')

    // A mock executor that owns this session reports the SERIALIZED key — same
    // shape TaskExecutor.sessionKey returns (session_key ?? user_id).
    const mockExecutor = { sessionKey: conv.session_key ?? conv.user_id }
    ;(agent as any).activeExecutors.set('task-h1', mockExecutor)

    const result = await agent.compactSession({ sessionKey })
    expect(result.kind).toBe('session_busy')
  })
})

// ---------------------------------------------------------------------------
// 5. clearPendingApproval retry queue (B5)
// ---------------------------------------------------------------------------

describe('AgentStateMachine — clearPendingApproval retry queue', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('B5 — enqueues a retry entry when clearPendingApproval rejects', async () => {
    // Regression: pre-B5 the lifecycle subscriber did
    // `clearPendingApproval(...).catch(log)` and dropped the failure. The
    // orphan SQLite row would be resurrected at next boot. Now: failures
    // land in `clearPendingApprovalRetries` keyed by sessionKey, awaiting
    // bounded retry.
    const { agent } = setupAgent()
    const cm = (agent as any).conversationManager
    cm.clearPendingApproval = vi.fn().mockRejectedValue(new Error('worker crashed'))
    ;(agent as any).tryClearPendingApproval('session-X')
    // Let the rejection propagate to the scheduler.
    await new Promise(r => setImmediate(r))

    const entry = (agent as any).clearPendingApprovalRetries.get('session-X')
    expect(entry).toBeDefined()
    expect(entry.attempts).toBe(1)
    expect(entry.nextTry).toBeGreaterThan(Date.now())
  })

  it('B5 — drops the entry on success after a prior failure', async () => {
    const { agent } = setupAgent()
    const cm = (agent as any).conversationManager
    // First call fails, second succeeds.
    cm.clearPendingApproval = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce(undefined)
    ;(agent as any).tryClearPendingApproval('session-Y')
    await new Promise(r => setImmediate(r))
    expect((agent as any).clearPendingApprovalRetries.has('session-Y')).toBe(true)

    // Manually re-attempt; on success the entry is removed.
    ;(agent as any).tryClearPendingApproval('session-Y')
    await new Promise(r => setImmediate(r))
    expect((agent as any).clearPendingApprovalRetries.has('session-Y')).toBe(false)
  })

  it('B5 — gives up after MAX_ATTEMPTS and logs the orphan', async () => {
    const { agent } = setupAgent()
    const cm = (agent as any).conversationManager
    cm.clearPendingApproval = vi.fn().mockRejectedValue(new Error('persistent'))

    // Burn through MAX_ATTEMPTS + 1 attempts; the last one should clear the
    // entry (gave up) rather than re-schedule.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const max = (agent.constructor as any).CLEAR_RETRY_MAX_ATTEMPTS as number
    for (let i = 0; i < max + 1; i++) {
      ;(agent as any).tryClearPendingApproval('session-Z')
      await new Promise(r => setImmediate(r))
    }
    expect((agent as any).clearPendingApprovalRetries.has('session-Z')).toBe(false)
    // Final attempt logged the "exhausted" message.
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/exhausted.*retries/))
    errSpy.mockRestore()
  })
})
