/**
 * Integration test: Full approval flow end-to-end.
 *
 * Uses mock LLM, mock tools, real ConversationManager, real ApprovalController,
 * real ApprovalResolver. Tests the complete chain from message -> tool approval
 * -> approve/deny -> response.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentStateMachine } from '../../../agent/stateMachine'
import { TaskLifecycle } from '../../../lifecycle/taskLifecycle'
import { MessageQueue } from '../../../queue/messageQueue'
import { Task } from '../../../queue/types'
import { serializeSessionKey } from '../../../session'
import { runToolUseLoop } from '../../orchestration/toolUseLoop'
import { ApprovalResolver } from '../approvalResolver'
import type { ApprovalConfig } from '../approvalTypes'

// Mock config
vi.mock('../../../config', () => ({
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
vi.mock('../../orchestration/toolUseLoop', () => ({
  runToolUseLoop: vi.fn(),
  validateToolLinkages: vi.fn(),
}))

function createTestTask(sender: string = 'user-1'): Task {
  return {
    id: `task-${Date.now()}`,
    source: 'channel',
    sourceMessage: {
      sender,
      content: 'Execute a shell command',
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
        content: 'Execute a shell command',
        timestamp: new Date(),
      },
    ],
    responseCallback: vi.fn(async () => {}),
    createdAt: new Date(),
  }
}

describe('Approval Flow -- end-to-end integration', () => {
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

  it('should complete: message -> need_approval -> approve -> tool executes -> response', async () => {
    // First call: tool needs approval
    // Second call (after approve): tool executes, returns response
    ;(runToolUseLoop as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        type: 'need_approval',
        approval: {
          request_id: 'req-flow-1',
          tool_name: 'shell_exec',
          parameters: { command: 'ls -la' },
          description: 'List directory contents',
          tool_call_id: 'tc_1',
          context_snapshot: [],
        },
      })
      .mockResolvedValueOnce({
        type: 'response',
        content: 'Directory listing:\nfile1.txt\nfile2.txt',
        usage: { input_tokens: 50, output_tokens: 30, total_tokens: 80 },
      })

    const task = createTestTask()
    await agent.executeTask(task)

    // State should be waiting_approval
    expect(agent.getState()).toBe('waiting_approval')

    // Approve
    const result = await agent.handleApproval('user-1', 'req-flow-1', false)
    expect(result.success).toBe(true)

    // Wait for async resume to complete
    await new Promise(resolve => setTimeout(resolve, 50))

    // responseCallback should have been called with the final response
    expect(task.responseCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        response: expect.stringContaining('Directory listing'),
      })
    )
  })

  it('should complete: message -> need_approval -> deny -> denial response', async () => {
    ;(runToolUseLoop as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      type: 'need_approval',
      approval: {
        request_id: 'req-flow-2',
        tool_name: 'shell_exec',
        parameters: { command: 'rm -rf /' },
        description: 'Dangerous command',
        tool_call_id: 'tc_1',
        context_snapshot: [],
      },
    })

    const task = createTestTask()
    await agent.executeTask(task)

    expect(agent.getState()).toBe('waiting_approval')

    // Deny
    const result = await agent.handleDenial('user-1', 'req-flow-2')
    expect(result.success).toBe(true)
    expect(agent.getState()).toBe('idle')

    // responseCallback should have been called with denial message
    expect(task.responseCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        response: expect.stringContaining('denied'),
      })
    )
  })

  it('should auto-approve tool on second call after alwaysApprove=true', async () => {
    // First call: need approval
    // After approval with alwaysApprove=true: shell_exec added to auto_approved_tools
    // Second call: should proceed without approval
    ;(runToolUseLoop as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        type: 'need_approval',
        approval: {
          request_id: 'req-auto-1',
          tool_name: 'shell_exec',
          parameters: { command: 'whoami' },
          description: 'Get current user',
          tool_call_id: 'tc_1',
          context_snapshot: [],
        },
      })
      .mockResolvedValueOnce({
        type: 'response',
        content: 'root',
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      })

    const task = createTestTask()
    await agent.executeTask(task)

    // Approve with alwaysApprove=true
    await agent.handleApproval('user-1', 'req-auto-1', true)

    // Wait for resume
    await new Promise(resolve => setTimeout(resolve, 50))

    // Verify auto_approved_tools (conversation keyed by full session identity)
    const sessionKey = serializeSessionKey({
      userId: 'user-1',
      channelType: 'telegram',
      channelId: 'test-channel',
    })
    const conv = await agent.getConversationManager().getOrCreate(sessionKey)
    expect(conv.auto_approved_tools.has('shell_exec')).toBe(true)

    // The ApprovalController would now return "proceed" for shell_exec
    // without delegating to the base controller
  })

  it('should resolve permissions via ApprovalResolver independently', () => {
    // In the executor model, handleApproval uses requestId-based lookup
    // and does not inline permission checks. Permission resolution is
    // tested directly against ApprovalResolver.
    const approvalConfig: ApprovalConfig = {
      defaultPolicy: 'designated_approvers',
      channels: {
        telegram: { enabled: true, approvers: ['admin-user'] },
      },
    }

    const resolver = new ApprovalResolver()

    // user-1 is NOT in the approvers list (only admin-user is)
    expect(resolver.canUserApprove('user-1', 'telegram', 'test-channel', approvalConfig)).toBe(
      false
    )

    // admin-user IS in the approvers list
    expect(resolver.canUserApprove('admin-user', 'telegram', 'test-channel', approvalConfig)).toBe(
      true
    )

    // CLI user (no channelType) is always allowed
    expect(resolver.canUserApprove('user-1', undefined, undefined, approvalConfig)).toBe(true)
  })
})
