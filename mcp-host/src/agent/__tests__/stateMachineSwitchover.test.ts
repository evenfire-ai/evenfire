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
    nativeTool: {
      workspacePath: '/tmp',
      shellTimeout: 5000,
      httpAllowlist: [],
      envAllowlist: ['PATH'],
      memoryMaxSize: 1048576,
    },
  },
}))

// Mock the orchestration module before any imports
vi.mock('../../core/orchestration/toolUseLoop', () => ({
  runToolUseLoop: vi.fn(),
  validateToolLinkages: vi.fn(),
}))

// Helper to create a minimal task with responseCallback spy
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

describe('AgentStateMachine — executeTask result handling', () => {
  let agent: AgentStateMachine
  let queue: MessageQueue

  beforeEach(() => {
    vi.clearAllMocks()
    queue = new MessageQueue()
    agent = new AgentStateMachine(queue, new TaskLifecycle(), { autoStart: false })

    // Minimal mocks for DI instantiation (Risk 5.4)
    const mockProvider = {
      completeSingleTurn: vi.fn(),
      completeSingleTurnWithTools: vi.fn(),
      getProviderType: () => 'openai' as const,
    }
    agent.setLLMProvider(mockProvider as any)
    agent.setMcpManager({ getAllTools: () => [], callTool: vi.fn() } as any)
  })

  it('should fire responseCallback on LoopResult.response (Risk 5.3a)', async () => {
    ;(runToolUseLoop as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      type: 'response',
      content: 'Answer to question',
      usage: { input_tokens: 5, output_tokens: 15, total_tokens: 20 },
    })

    const task = createTestTask('What is 2+2?')
    await agent.executeTask(task)

    expect(task.responseCallback).toHaveBeenCalledTimes(1)
  })

  it('should send exhaustion message on LoopResult.exhaustion (Risk 5.3c)', async () => {
    ;(runToolUseLoop as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      type: 'exhaustion',
      message: 'Max iterations reached (10)',
      iterations: 10,
    })

    const task = createTestTask('Do something complex')
    await agent.executeTask(task)

    expect(task.responseCallback).toHaveBeenCalledTimes(1)
  })
})
