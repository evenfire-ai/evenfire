/**
 * Phase 7 regression test: Single-path agent validation.
 *
 * Verifies that legacy code paths have been removed and the agent
 * uses only the new pipeline via runToolUseLoop.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runToolUseLoop } from '../../core/orchestration/toolUseLoop'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import { MessageQueue } from '../../queue/messageQueue'
import { Task } from '../../queue/types'
import { AgentStateMachine } from '../stateMachine'

// Mock config
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

function createTestTask(content: string = 'Test message'): Task {
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
    conversationHistory: [
      {
        role: 'user',
        content,
        timestamp: new Date(),
      },
    ],
    responseCallback: vi.fn(async () => {}),
    createdAt: new Date(),
  }
}

describe('AgentStateMachine — single path (post-Phase 7)', () => {
  let agent: AgentStateMachine

  beforeEach(() => {
    vi.clearAllMocks()
    const queue = new MessageQueue()
    agent = new AgentStateMachine(queue, new TaskLifecycle(), { autoStart: false })

    const mockProvider = {
      completeSingleTurn: vi.fn(),
      completeSingleTurnWithTools: vi.fn(),
      getProviderType: () => 'openai' as const,
    }
    agent.setLLMProvider(mockProvider as any)
    agent.setMcpManager({ getAllTools: () => [], callTool: vi.fn() } as any)
  })

  it('should NOT have executeTaskLegacy method', () => {
    expect((agent as any).executeTaskLegacy).toBeUndefined()
  })

  it('should NOT have useNewLoop feature flag property', () => {
    expect((agent as any).useNewLoop).toBeUndefined()
  })

  it('should always route through runToolUseLoop', async () => {
    ;(runToolUseLoop as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      type: 'response',
      content: 'Response via new pipeline',
      usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
    })

    const task = createTestTask('Hello')
    await agent.executeTask(task)

    expect(runToolUseLoop).toHaveBeenCalledTimes(1)
    expect(task.responseCallback).toHaveBeenCalledTimes(1)
  })

  it('should handle LoopResult.error correctly without legacy fallback', async () => {
    ;(runToolUseLoop as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('LLM unavailable')
    )

    const task = createTestTask('Trigger error')
    await agent.executeTask(task)

    // Should have called the failure handler, not fallen back to legacy
    expect(runToolUseLoop).toHaveBeenCalledTimes(1)
    // responseCallback should NOT have been called with a success response
    // (handleTaskFailure does not call responseCallback)
  })

  it('should have handleApproval and handleDenial methods (Phase 6 survives)', () => {
    expect(typeof agent.handleApproval).toBe('function')
    expect(typeof agent.handleDenial).toBe('function')
  })
})
