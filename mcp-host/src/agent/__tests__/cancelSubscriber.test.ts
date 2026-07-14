/**
 * AgentStateMachine cancel subscriber — unit tests (spec §4.4 / Phase B.2).
 *
 * Exercises the `subscribeLifecycle()` path via real `lc.transition(...)` calls
 * so that subscriber wiring (not just the method body) is tested.
 *
 * Five scenarios:
 *  1. Processing branch  — executor.abort() called
 *  2. Waiting-approval   — full cleanup sequence
 *  3. Invariant I11      — subscriber swallows exception; later subscriber still fires
 *  4. Unknown taskId     — no executor in map, no throw
 *  5. Non-cancel transition — abort NOT called
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import { MessageQueue } from '../../queue/messageQueue'
import { AgentStateMachine } from '../stateMachine'

// ── mocks ─────────────────────────────────────────────────────────────────────

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

vi.mock('../../core/orchestration/toolUseLoop', () => ({
  runToolUseLoop: vi.fn(),
  executeSingleTool: vi.fn(),
  validateToolLinkages: vi.fn(),
}))

// ── helpers ───────────────────────────────────────────────────────────────────

function makeTask(id: string) {
  return {
    id,
    source: 'channel' as const,
    sourceMessage: {
      sender: 'user-1',
      content: 'Do something',
      channelType: 'telegram' as const,
      channelId: 'test-channel',
      messageId: 'msg-1',
      timestamp: new Date().toISOString(),
      hostRef: 'test-host',
    },
    priority: 'normal' as const,
    status: 'pending' as const,
    conversationHistory: [],
    responseCallback: vi.fn(async () => {}),
    createdAt: new Date(),
  }
}

// ── suite ─────────────────────────────────────────────────────────────────────

describe('AgentStateMachine cancel subscriber', () => {
  let lc: TaskLifecycle
  let mq: MessageQueue
  let agent: AgentStateMachine

  beforeEach(() => {
    lc = new TaskLifecycle()
    mq = new MessageQueue()
    mq.setLifecycle(lc)
    agent = new AgentStateMachine(mq, lc, { autoStart: false })
    agent.start()
  })

  // ── 1. Processing branch ────────────────────────────────────────────────────
  it('processing branch: calls executor.abort() on transition(cancelled)', () => {
    const mockExecutor = {
      abort: vi.fn(),
      pendingApproval: undefined,
      sourceTask: makeTask('t1'),
      executorState: 'processing',
    }
    ;(agent as any).activeExecutors.set('t1', mockExecutor)

    lc.register(mockExecutor.sourceTask as any)
    lc.transition('t1', 'processing', 'dispatched')
    lc.transition('t1', 'cancelled', 'user_requested')

    expect(mockExecutor.abort).toHaveBeenCalledOnce()
    // Processing branch must NOT delete the executor — run()'s finally handles it
    expect((agent as any).activeExecutors.has('t1')).toBe(true)
  })

  // ── 2. Waiting-approval branch ──────────────────────────────────────────────
  it('waiting_approval branch: clears timer, approvalMap, pending_approval, releases session, aborts, deletes executor', () => {
    const timerId = setTimeout(() => {}, 60_000)

    const task = makeTask('t2')
    const mockExecutor = {
      abort: vi.fn(),
      pendingApproval: {
        request_id: 'r2',
        tool_name: 'some_tool',
        tool_call_id: 'c2',
        parameters: {},
        description: 'test',
      },
      sourceTask: task,
      executorState: 'waiting_approval',
    }
    ;(agent as any).activeExecutors.set('t2', mockExecutor)
    ;(agent as any).approvalMap.set('r2', { taskId: 't2', timerId, registeredAt: new Date() })

    const cancelSpy = vi.spyOn(agent.getConversationManager(), 'cancelTurnBySessionKey')
    const releaseSpy = vi.spyOn(agent as any, 'releaseSessionForTask').mockImplementation(() => {})

    lc.register(task as any)
    lc.transition('t2', 'processing', 'dispatched')
    lc.transition('t2', 'waiting_approval', 'natural')
    lc.transition('t2', 'cancelled', 'user_requested')

    // approvalMap entry removed
    expect((agent as any).approvalMap.has('r2')).toBe(false)
    // conversationManager.cancelTurnBySessionKey called (BUG-9: was clearPendingApproval)
    expect(cancelSpy).toHaveBeenCalled()
    // session released
    expect(releaseSpy).toHaveBeenCalled()
    // abort called
    expect(mockExecutor.abort).toHaveBeenCalledOnce()
    // executor deleted (no finally will run for a suspended executor)
    expect((agent as any).activeExecutors.has('t2')).toBe(false)
  })

  // ── 3. Invariant I11 ────────────────────────────────────────────────────────
  it('Invariant I11: subscriber swallows exceptions; later subscribers still fire', () => {
    // Register a subscriber AFTER AgentStateMachine's subscriber.
    // Node fires subscribers in registration order, so this one fires second.
    const laterSubscriber = vi.fn()
    lc.on('transition', laterSubscriber)

    // Install an executor whose abort() throws
    const task = makeTask('t3')
    const throwingExecutor = {
      abort: () => {
        throw new Error('boom')
      },
      pendingApproval: undefined,
      sourceTask: task,
      executorState: 'processing',
    }
    ;(agent as any).activeExecutors.set('t3', throwingExecutor)

    lc.register(task as any)
    lc.transition('t3', 'processing', 'dispatched')

    // The transition must NOT throw even though abort() throws
    expect(() => lc.transition('t3', 'cancelled', 'user_requested')).not.toThrow()

    // The later subscriber must have been called (I11 invariant)
    expect(laterSubscriber).toHaveBeenCalled()
  })

  // ── 4. Unknown taskId ───────────────────────────────────────────────────────
  it('ignores non-cancel transitions for an unregistered taskId without throwing', () => {
    // lc has no record for 't-unknown' — transition() returns { kind: 'not_found' }
    // and does NOT emit, so the subscriber never fires. Either way: no throw.
    expect(() => lc.transition('t-unknown', 'cancelled', 'user_requested')).not.toThrow()
  })

  // ── 5. Non-cancel transitions ───────────────────────────────────────────────
  it('ignores non-cancel transitions; abort is NOT called', () => {
    const task = makeTask('t5')
    const mockExecutor = {
      abort: vi.fn(),
      pendingApproval: undefined,
      sourceTask: task,
      executorState: 'processing',
    }
    ;(agent as any).activeExecutors.set('t5', mockExecutor)

    lc.register(task as any)
    lc.transition('t5', 'processing', 'dispatched')
    lc.transition('t5', 'completed', 'natural')

    expect(mockExecutor.abort).not.toHaveBeenCalled()
  })
})
