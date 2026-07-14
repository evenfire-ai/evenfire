/**
 * Gap 3 Resolution: Agent-layer event bridge tests.
 *
 * Verifies that events originating at the agent layer (AgentStateMachine)
 * are properly bridged to the core SimpleEventEmitter via getCoreEvents().
 *
 * Events tested:
 *   1. tool:approval_granted  - emitted on handleApproval()
 *   2. tool:approval_denied   - emitted on handleDenial()
 *   3. state:changed          - bridged from setState() via emitEvent()
 *   4. task:completed         - bridged from handleLoopResult() via emitEvent()
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runToolUseLoop } from '../../core/orchestration/toolUseLoop'
import type { AgentEvent, AgentEventType } from '../../core/types'
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
  validateToolLinkages: vi.fn(),
}))

function createTestTask(sender: string = 'user-1'): Task {
  return {
    id: `task-${Date.now()}`,
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

describe('Gap 3 — tool:approval_granted via core SimpleEventEmitter', () => {
  let agent: AgentStateMachine
  let queue: MessageQueue

  beforeEach(() => {
    vi.clearAllMocks()
    queue = new MessageQueue()
    agent = new AgentStateMachine(queue, new TaskLifecycle(), { autoStart: false })
    const mockProvider = {
      completeSingleTurn: vi.fn(),
      completeSingleTurnWithTools: vi.fn(),
      getProviderType: () => 'openai' as const,
    }
    agent.setLLMProvider(mockProvider as any)
    agent.setMcpManager({ getAllTools: () => [], callTool: vi.fn() } as any)
    agent.start() // Required for getState() to aggregate executor states
  })

  it('should emit tool:approval_granted through coreEvents on handleApproval', async () => {
    const coreEvents = agent.getCoreEvents()
    const collected: AgentEvent[] = []
    coreEvents.on('tool:approval_granted', event => collected.push(event))

    // Mock loop returning need_approval, then response on resume
    ;(runToolUseLoop as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        type: 'need_approval',
        approval: {
          request_id: 'req-grant-1',
          tool_name: 'shell_exec',
          parameters: { command: 'ls' },
          description: 'Shell command',
          tool_call_id: 'tc_1',
          context_snapshot: [],
        },
      })
      .mockResolvedValueOnce({
        type: 'response',
        content: 'Done',
        usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 },
      })

    const task = createTestTask('user-1')
    await agent.executeTask(task)

    expect(agent.getState()).toBe('waiting_approval')

    await agent.handleApproval('user-1', 'req-grant-1', false)

    expect(collected.length).toBe(1)
    expect(collected[0].type).toBe('tool:approval_granted')
    expect((collected[0].data as Record<string, unknown>).toolName).toBe('shell_exec')
    expect((collected[0].data as Record<string, unknown>).requestId).toBe('req-grant-1')
    expect((collected[0].data as Record<string, unknown>).userId).toBe('user-1')
    expect((collected[0].data as Record<string, unknown>).alwaysApprove).toBe(false)
    expect(collected[0].timestamp).toBeInstanceOf(Date)
  })

  it('should include alwaysApprove=true in tool:approval_granted data', async () => {
    const coreEvents = agent.getCoreEvents()
    const collected: AgentEvent[] = []
    coreEvents.on('tool:approval_granted', event => collected.push(event))
    ;(runToolUseLoop as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        type: 'need_approval',
        approval: {
          request_id: 'req-always-1',
          tool_name: 'shell_exec',
          parameters: { command: 'ls' },
          description: 'Shell command',
          tool_call_id: 'tc_1',
          context_snapshot: [],
        },
      })
      .mockResolvedValueOnce({
        type: 'response',
        content: 'Done',
        usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 },
      })

    const task = createTestTask('user-1')
    await agent.executeTask(task)

    expect(agent.getState()).toBe('waiting_approval')

    await agent.handleApproval('user-1', 'req-always-1', true)

    expect(collected.length).toBe(1)
    expect((collected[0].data as Record<string, unknown>).alwaysApprove).toBe(true)
  })
})

describe('Gap 3 — tool:approval_denied via core SimpleEventEmitter', () => {
  let agent: AgentStateMachine
  let queue: MessageQueue

  beforeEach(() => {
    vi.clearAllMocks()
    queue = new MessageQueue()
    agent = new AgentStateMachine(queue, new TaskLifecycle(), { autoStart: false })
    const mockProvider = {
      completeSingleTurn: vi.fn(),
      completeSingleTurnWithTools: vi.fn(),
      getProviderType: () => 'openai' as const,
    }
    agent.setLLMProvider(mockProvider as any)
    agent.setMcpManager({ getAllTools: () => [], callTool: vi.fn() } as any)
    agent.start() // Required for getState() to aggregate executor states
  })

  it('should emit tool:approval_denied through coreEvents on handleDenial', async () => {
    const coreEvents = agent.getCoreEvents()
    const collected: AgentEvent[] = []
    coreEvents.on('tool:approval_denied', event => collected.push(event))
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

    const task = createTestTask('user-1')
    await agent.executeTask(task)

    expect(agent.getState()).toBe('waiting_approval')

    await agent.handleDenial('user-1', 'req-deny-1')

    expect(collected.length).toBe(1)
    expect(collected[0].type).toBe('tool:approval_denied')
    expect((collected[0].data as Record<string, unknown>).toolName).toBe('shell_exec')
    expect((collected[0].data as Record<string, unknown>).requestId).toBe('req-deny-1')
    expect((collected[0].data as Record<string, unknown>).userId).toBe('user-1')
    expect(collected[0].timestamp).toBeInstanceOf(Date)
  })
})

describe('Gap 3 — state:changed via core SimpleEventEmitter', () => {
  let agent: AgentStateMachine
  let queue: MessageQueue

  beforeEach(() => {
    vi.clearAllMocks()
    queue = new MessageQueue()
    agent = new AgentStateMachine(queue, new TaskLifecycle(), { autoStart: false })
    const mockProvider = {
      completeSingleTurn: vi.fn(),
      completeSingleTurnWithTools: vi.fn(),
      getProviderType: () => 'openai' as const,
    }
    agent.setLLMProvider(mockProvider as any)
    agent.setMcpManager({ getAllTools: () => [], callTool: vi.fn() } as any)
  })

  it('should emit state:changed through coreEvents when state transitions', async () => {
    const coreEvents = agent.getCoreEvents()
    const collected: AgentEvent[] = []
    coreEvents.on('state:changed', event => collected.push(event))

    // State:changed fires for lifecycle transitions (pause/resume).
    // SessionProcessor now drives task dispatch — idle→processing via setState() no longer
    // fires on executeTask(); use agent lifecycle methods to trigger state:changed.
    agent.start()
    collected.length = 0 // clear any start events

    agent.pause()
    agent.resume()

    // Should have at least 2 state transitions: idle→paused, paused→idle
    const stateChanges = collected.filter(e => e.type === 'state:changed')
    expect(stateChanges.length).toBeGreaterThanOrEqual(2)

    // Verify data shape
    for (const event of stateChanges) {
      const data = event.data as Record<string, unknown>
      expect(data).toHaveProperty('oldState')
      expect(data).toHaveProperty('newState')
      expect(event.timestamp).toBeInstanceOf(Date)
    }

    await agent.stop()
  })

  it('should emit state:changed for pause/resume transitions', async () => {
    const coreEvents = agent.getCoreEvents()
    const collected: AgentEvent[] = []
    coreEvents.on('state:changed', event => collected.push(event))

    agent.start()
    collected.length = 0 // Clear start events

    agent.pause()
    expect(collected.length).toBe(1)
    expect((collected[0].data as Record<string, unknown>).newState).toBe('paused')

    agent.resume()
    expect(collected.length).toBe(2)
    expect((collected[1].data as Record<string, unknown>).newState).toBe('idle')

    await agent.stop()
  })
})

describe('Gap 3 — task:completed via core SimpleEventEmitter', () => {
  let agent: AgentStateMachine
  let queue: MessageQueue

  beforeEach(() => {
    vi.clearAllMocks()
    queue = new MessageQueue()
    agent = new AgentStateMachine(queue, new TaskLifecycle(), { autoStart: false })
    const mockProvider = {
      completeSingleTurn: vi.fn(),
      completeSingleTurnWithTools: vi.fn(),
      getProviderType: () => 'openai' as const,
    }
    agent.setLLMProvider(mockProvider as any)
    agent.setMcpManager({ getAllTools: () => [], callTool: vi.fn() } as any)
  })

  it('should emit task:completed through coreEvents on successful task', async () => {
    const coreEvents = agent.getCoreEvents()
    const collected: AgentEvent[] = []
    coreEvents.on('task:completed', event => collected.push(event))
    ;(runToolUseLoop as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      type: 'response',
      content: 'Task done',
      usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 },
    })

    // Use executeTask directly — SessionProcessor now drives queue-based dispatch.
    agent.start()
    const task = createTestTask('user-1')
    await agent.executeTask(task)

    expect(collected.length).toBe(1)
    expect(collected[0].type).toBe('task:completed')
    const data = collected[0].data as Record<string, unknown>
    expect(data).toHaveProperty('task')
    expect(collected[0].timestamp).toBeInstanceOf(Date)

    await agent.stop()
  })

  it('should emit task:completed through coreEvents on denial', async () => {
    agent.start() // Required for getState() to aggregate executor states

    const coreEvents = agent.getCoreEvents()
    const collected: AgentEvent[] = []
    coreEvents.on('task:completed', event => collected.push(event))

    // Reset mock impl queue to avoid leakage from prior tests that enqueue without dispatch.
    ;(runToolUseLoop as ReturnType<typeof vi.fn>).mockReset()
    ;(runToolUseLoop as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      type: 'need_approval',
      approval: {
        request_id: 'req-deny-tc-1',
        tool_name: 'shell_exec',
        parameters: { command: 'rm' },
        description: 'Shell command',
        tool_call_id: 'tc_1',
        context_snapshot: [],
      },
    })

    const task = createTestTask('user-1')
    await agent.executeTask(task)

    expect(agent.getState()).toBe('waiting_approval')

    await agent.handleDenial('user-1', 'req-deny-tc-1')

    // task:completed should fire on denial (task is considered completed with denial response)
    expect(collected.length).toBe(1)
    expect(collected[0].type).toBe('task:completed')
    const data = collected[0].data as Record<string, unknown>
    expect(data).toHaveProperty('task')

    await agent.stop()
  })

  it('should emit task:completed through coreEvents on exhaustion', async () => {
    const coreEvents = agent.getCoreEvents()
    const collected: AgentEvent[] = []
    coreEvents.on('task:completed', event => collected.push(event))
    ;(runToolUseLoop as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      type: 'exhaustion',
      message: 'Max iterations reached',
      iterations: 10,
    })

    // Use executeTask directly — SessionProcessor now drives queue-based dispatch.
    agent.start()
    const task = createTestTask('user-1')
    await agent.executeTask(task)

    expect(collected.length).toBe(1)
    expect(collected[0].type).toBe('task:completed')

    await agent.stop()
  })
})

describe('Gap 3 — complete AgentEventType coverage via getCoreEvents()', () => {
  it('should expose getCoreEvents() method that returns a SimpleEventEmitter', () => {
    const queue = new MessageQueue()
    const agent = new AgentStateMachine(queue, new TaskLifecycle(), { autoStart: false })
    const coreEvents = agent.getCoreEvents()

    expect(coreEvents).toBeDefined()
    expect(typeof coreEvents.emit).toBe('function')
    expect(typeof coreEvents.on).toBe('function')
    expect(typeof coreEvents.off).toBe('function')
  })

  it('should accept subscriptions for all 14 AgentEventType values', () => {
    const queue = new MessageQueue()
    const agent = new AgentStateMachine(queue, new TaskLifecycle(), { autoStart: false })
    const coreEvents = agent.getCoreEvents()

    const allTypes: AgentEventType[] = [
      'state:changed',
      'task:started',
      'task:completed',
      'task:failed',
      'tool:called',
      'tool:completed',
      'tool:approval_needed',
      'tool:approval_granted',
      'tool:approval_denied',
      'loop:iteration',
      'loop:completed',
      'safety:input_blocked',
      'safety:output_sanitized',
      'context:compacted',
    ]

    // Should not throw for any event type
    for (const type of allTypes) {
      const handler = vi.fn()
      coreEvents.on(type, handler)
      coreEvents.off(type, handler)
    }
  })
})

/**
 * Regression — PR #291 follow-up: tool:approval_granted and tool:approval_denied
 * MUST reach Node EventEmitter subscribers (agent.on(...)), not only the
 * SimpleEventEmitter (coreEvents).
 *
 * Why: PR #291 wired messageHandler.onApprovalConsumed via `this.deps.agent.on(...)`
 * to clear pendingTaskResults after approval is consumed, but the events were
 * emitted via `this.coreEvents.emit(...)` only. The two emitters are isolated,
 * so the listener never fired in production — channel-reader kept polling and
 * surfacing stale `waiting_approval` notifications to the user.
 *
 * These tests exercise the real `agent.handleApproval()` / `agent.handleDenial()`
 * code path (no mocked emit) and assert delivery on BOTH emitters.
 */
describe('PR #291 follow-up — approval events reach Node EE subscribers', () => {
  let agent: AgentStateMachine
  let queue: MessageQueue

  beforeEach(() => {
    vi.clearAllMocks()
    queue = new MessageQueue()
    agent = new AgentStateMachine(queue, new TaskLifecycle(), { autoStart: false })
    const mockProvider = {
      completeSingleTurn: vi.fn(),
      completeSingleTurnWithTools: vi.fn(),
      getProviderType: () => 'openai' as const,
    }
    agent.setLLMProvider(mockProvider as any)
    agent.setMcpManager({ getAllTools: () => [], callTool: vi.fn() } as any)
    agent.start()
  })

  it('handleApproval emits tool:approval_granted on the Node EventEmitter', async () => {
    const nodeEvents: AgentEvent[] = []
    const coreCollected: AgentEvent[] = []
    agent.on('tool:approval_granted', event => nodeEvents.push(event as AgentEvent))
    agent.getCoreEvents().on('tool:approval_granted', event => coreCollected.push(event))
    ;(runToolUseLoop as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        type: 'need_approval',
        approval: {
          request_id: 'req-nodeee-grant-1',
          tool_name: 'shell_exec',
          parameters: { command: 'ls' },
          description: 'Shell command',
          tool_call_id: 'tc_1',
          context_snapshot: [],
        },
      })
      .mockResolvedValueOnce({
        type: 'response',
        content: 'Done',
        usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 },
      })

    const task = createTestTask('user-1')
    await agent.executeTask(task)
    expect(agent.getState()).toBe('waiting_approval')

    await agent.handleApproval('user-1', 'req-nodeee-grant-1', false)

    // Node EE subscriber MUST receive the event (was broken pre-fix).
    expect(nodeEvents.length).toBe(1)
    expect(nodeEvents[0].type).toBe('tool:approval_granted')
    const ndata = nodeEvents[0].data as Record<string, unknown>
    expect(ndata.requestId).toBe('req-nodeee-grant-1')
    expect(ndata.userId).toBe('user-1')
    expect(ndata.taskId).toBe(task.id)
    expect(ndata.toolName).toBe('shell_exec')
    expect(ndata.alwaysApprove).toBe(false)

    // coreEvents subscriber MUST also still receive it (eventWiring depends on this).
    expect(coreCollected.length).toBe(1)
    expect(coreCollected[0].type).toBe('tool:approval_granted')
    expect((coreCollected[0].data as Record<string, unknown>).requestId).toBe('req-nodeee-grant-1')
  })

  it('handleDenial emits tool:approval_denied on the Node EventEmitter', async () => {
    const nodeEvents: AgentEvent[] = []
    const coreCollected: AgentEvent[] = []
    agent.on('tool:approval_denied', event => nodeEvents.push(event as AgentEvent))
    agent.getCoreEvents().on('tool:approval_denied', event => coreCollected.push(event))
    ;(runToolUseLoop as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      type: 'need_approval',
      approval: {
        request_id: 'req-nodeee-deny-1',
        tool_name: 'shell_exec',
        parameters: { command: 'rm -rf /' },
        description: 'Dangerous command',
        tool_call_id: 'tc_1',
        context_snapshot: [],
      },
    })

    const task = createTestTask('user-1')
    await agent.executeTask(task)
    expect(agent.getState()).toBe('waiting_approval')

    await agent.handleDenial('user-1', 'req-nodeee-deny-1')

    expect(nodeEvents.length).toBe(1)
    expect(nodeEvents[0].type).toBe('tool:approval_denied')
    const ndata = nodeEvents[0].data as Record<string, unknown>
    expect(ndata.requestId).toBe('req-nodeee-deny-1')
    expect(ndata.userId).toBe('user-1')
    expect(ndata.taskId).toBe(task.id)
    expect(ndata.toolName).toBe('shell_exec')

    expect(coreCollected.length).toBe(1)
    expect(coreCollected[0].type).toBe('tool:approval_denied')
  })

  it('Node EE subscriber observes taskId so cross-task routing works', async () => {
    const granted: AgentEvent[] = []
    agent.on('tool:approval_granted', event => granted.push(event as AgentEvent))
    ;(runToolUseLoop as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        type: 'need_approval',
        approval: {
          request_id: 'req-routing-1',
          tool_name: 'shell_exec',
          parameters: { command: 'ls' },
          description: 'Shell command',
          tool_call_id: 'tc_1',
          context_snapshot: [],
        },
      })
      .mockResolvedValueOnce({
        type: 'response',
        content: 'Done',
        usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 },
      })

    const task = createTestTask('user-1')
    await agent.executeTask(task)
    await agent.handleApproval('user-1', 'req-routing-1', false)

    // taskId is what messageHandler.onApprovalConsumed routes on:
    //   `if (data.taskId !== this.task.id) return`
    // Without it, the listener early-exits on every call.
    expect(granted.length).toBe(1)
    expect((granted[0].data as Record<string, unknown>).taskId).toBe(task.id)
  })
})
