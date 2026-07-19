import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalConfig } from '../../core/extensions/approvalTypes'
import { executeSingleTool, runToolUseLoop } from '../../core/orchestration/toolUseLoop'
import { ConversationState } from '../../core/types'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import { progressReporterRegistry } from '../../progress/sseProgressReporter'
import { MessageQueue } from '../../queue/messageQueue'
import { Task } from '../../queue/types'
import { serializeSessionKey } from '../../session'
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
  executeSingleTool: vi.fn(),
  validateToolLinkages: vi.fn(),
  extractInputPreview: vi.fn(() => 'ls'),
  buildOutputPreview: vi.fn((content: string) =>
    content
      ? {
          headLines: String(content).split('\n').slice(0, 3),
          tailLines: [],
          totalLines: String(content).split('\n').length,
          truncated: false,
        }
      : undefined
  ),
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

describe('AgentStateMachine -- approval handling', () => {
  let agent: AgentStateMachine
  let queue: MessageQueue
  let lifecycle: TaskLifecycle

  beforeEach(() => {
    vi.clearAllMocks()
    ;(runToolUseLoop as ReturnType<typeof vi.fn>).mockReset()
    ;(executeSingleTool as ReturnType<typeof vi.fn>).mockReset()
    for (const [id] of progressReporterRegistry.entries()) {
      progressReporterRegistry.delete(id)
    }
    queue = new MessageQueue()
    lifecycle = new TaskLifecycle()
    // Wire lifecycle into queue so queue.completeTask calls lifecycle.transition('completed'),
    // which SseProgressReporter catches to emit terminal event (Phase D.2).
    queue.setLifecycle(lifecycle)
    agent = new AgentStateMachine(queue, lifecycle, { autoStart: false })
    const mockProvider = {
      completeSingleTurn: vi.fn(),
      completeSingleTurnWithTools: vi.fn(),
      getProviderType: () => 'openai' as const,
    }
    agent.setLLMProvider(mockProvider as any)
    agent.setMcpManager({ getAllTools: () => [], callTool: vi.fn() } as any)
    agent.start() // Required for getState() to aggregate executor states
  })

  it('should reject approval when not in waiting_approval state (Risk 6.1)', async () => {
    // Agent is idle, no pending approvals registered
    const result = await agent.handleApproval('user-1', 'req-1', false)
    expect(result.success).toBe(false)
    expect(result.error).toContain('No pending approval for request')
  })

  it('should reject approval when requestId does not match (Risk 6.4a)', async () => {
    // Simulate need_approval result from loop
    ;(runToolUseLoop as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      type: 'need_approval',
      approval: {
        request_id: 'req-1',
        tool_name: 'shell_exec',
        parameters: { command: 'ls' },
        description: 'Shell command',
        tool_call_id: 'tc_1',
        context_snapshot: [],
      },
    })

    const task = createTestTask('user-1')
    await agent.executeTask(task)

    // Agent should be waiting_approval now
    expect(agent.getState()).toBe('waiting_approval')

    // Try to approve with wrong requestId
    const result = await agent.handleApproval('user-1', 'wrong-req-id', false)
    expect(result.success).toBe(false)
    expect(result.error).toContain('No pending approval for request')
  })

  it('should accept approval with correct userId and requestId (Risk 6.4b)', async () => {
    ;(runToolUseLoop as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        type: 'need_approval',
        approval: {
          request_id: 'req-1',
          tool_name: 'shell_exec',
          parameters: { command: 'ls' },
          description: 'Shell command',
          tool_call_id: 'tc_1',
          context_snapshot: [],
        },
      })
      // Second call (after approval resume — no snapshot so re-runs loop)
      .mockResolvedValueOnce({
        type: 'response',
        content: 'Command output: file1.txt file2.txt',
        usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
      })

    const task = createTestTask('user-1')
    await agent.executeTask(task)

    expect(agent.getState()).toBe('waiting_approval')

    const result = await agent.handleApproval('user-1', 'req-1', false)
    expect(result.success).toBe(true)
  })

  it('emits governed approval evidence only after the bound legacy gate accepts the actor', async () => {
    ;(runToolUseLoop as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        type: 'need_approval',
        approval: {
          request_id: 'req-traced',
          tool_name: 'shell_exec',
          parameters: { command: 'ls' },
          description: 'Shell command',
          tool_call_id: 'tc_traced',
          context_snapshot: [],
        },
      })
      .mockResolvedValueOnce({
        type: 'response',
        content: 'Done',
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      })
    const enqueue = vi.fn()
    const capture = vi.fn().mockResolvedValue('captured')
    agent.setUsageReporter({ enqueue: vi.fn() } as any, {
      host_ref: 'test-host',
      context_ref: null,
      llm_secret_name: null,
    })
    agent.setGovernedRunReporter({ enqueue } as any)
    agent.setApprovalPromptHistoryClient({ capture } as any)
    const task = createTestTask('user-1')
    task.traceContext = {
      version: 1,
      runId: '11111111-1111-4111-8111-111111111111',
      sessionId: 'session-traced',
      origin: 'channel_event',
      correlationRefs: [],
    }

    await agent.executeTask(task)
    expect(capture).toHaveBeenCalledWith(
      {
        approvalRequestId: 'req-traced',
        runId: '11111111-1111-4111-8111-111111111111',
        hostRef: 'test-host',
        sessionId: 'session-traced',
        origin: 'channel_event',
        prompt: 'Shell command',
      },
      []
    )
    enqueue.mockClear()

    await expect(
      agent.handleApproval('other-user', 'req-traced', false, 'telegram', 'test-channel')
    ).resolves.toMatchObject({ success: false })
    expect(enqueue).not.toHaveBeenCalled()

    await expect(
      agent.handleApproval('user-1', 'req-traced', false, 'telegram', 'test-channel')
    ).resolves.toEqual({ success: true })
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'approval',
        approvalRequestId: 'req-traced',
        sourceEventId: expect.stringMatching(/:req-traced:approved$/),
        payload: { status: 'approved', tool_name: 'shell_exec' },
      })
    )
  })

  it('should add tool to auto_approved_tools when alwaysApprove=true (6.auto)', async () => {
    ;(runToolUseLoop as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        type: 'need_approval',
        approval: {
          request_id: 'req-1',
          tool_name: 'shell_exec',
          parameters: { command: 'ls' },
          description: 'Shell command',
          tool_call_id: 'tc_1',
          context_snapshot: [],
        },
      })
      // Resume re-runs from scratch (no snapshot), returns response
      .mockResolvedValueOnce({
        type: 'response',
        content: 'Done',
        usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 },
      })

    const task = createTestTask('user-1')
    await agent.executeTask(task)

    expect(agent.getState()).toBe('waiting_approval')

    // Approve with alwaysApprove=true
    const result = await agent.handleApproval('user-1', 'req-1', true)
    expect(result.success).toBe(true)

    // Check that auto_approved_tools now includes shell_exec (conversation keyed by full session identity)
    const convManager = agent.getConversationManager()
    const sessionKey = serializeSessionKey({
      userId: 'user-1',
      channelType: 'telegram',
      channelId: 'test-channel',
    })
    await vi.waitFor(async () => {
      const conv = await convManager.getOrCreate(sessionKey)
      expect(conv.auto_approved_tools.has('shell_exec')).toBe(true)
    })
  })

  it('should transition to idle on denial', async () => {
    ;(runToolUseLoop as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      type: 'need_approval',
      approval: {
        request_id: 'req-1',
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

    const result = await agent.handleDenial('user-1', 'req-1')
    expect(result.success).toBe(true)
    expect(agent.getState()).toBe('idle')

    // responseCallback should have been called with denial message
    expect(task.responseCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        response: expect.stringContaining('denied'),
      })
    )
  })

  it('preserves attachments when resuming after approval', async () => {
    const priorAttachment = {
      id: 'att_prior',
      kind: 'image' as const,
      mimeType: 'image/jpeg' as const,
      encoding: 'base64' as const,
      dataBase64: 'cHJpb3I=',
    }
    const suspendedLoopAttachment = {
      id: 'att_suspended_loop',
      kind: 'file' as const,
      mimeType: 'application/pdf' as const,
      encoding: 'base64' as const,
      dataBase64: 'JVBERi0x',
      filename: 'research-summary.pdf',
      sourceTool: 'workflow_result',
      lane: 'workflow_result',
      sizeBytes: 14600,
    }
    const approvedToolAttachment = {
      id: 'att_approved',
      kind: 'image' as const,
      mimeType: 'image/jpeg' as const,
      encoding: 'base64' as const,
      dataBase64: 'YXBwcm92ZWQ=',
    }
    const resumedLoopAttachment = {
      id: 'att_resumed',
      kind: 'image' as const,
      mimeType: 'image/jpeg' as const,
      encoding: 'base64' as const,
      dataBase64: 'cmVzdW1lZA==',
    }

    ;(runToolUseLoop as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        type: 'need_approval',
        approval: {
          request_id: 'req-attachments',
          tool_name: 'shell_exec',
          parameters: { command: 'ls' },
          description: 'Shell command',
          tool_call_id: 'tc_1',
          context_snapshot: [
            { role: 'user', content: 'Do something' },
            {
              role: 'assistant',
              content: '',
              tool_calls: [
                { id: 'tc_prev', name: 'search', arguments: { q: 'x' } },
                { id: 'tc_1', name: 'shell_exec', arguments: { command: 'ls' } },
              ],
            },
          ],
          completed_results: [
            {
              tool_call_id: 'tc_prev',
              name: 'search',
              content: "<tool_output tool='search'>ok</tool_output>",
              is_error: false,
              attachments: [priorAttachment],
            },
          ],
          attachments: [suspendedLoopAttachment],
        },
      })
      .mockResolvedValueOnce({
        type: 'response',
        content: 'Done',
        usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
        attachments: [resumedLoopAttachment],
      })
    ;(executeSingleTool as ReturnType<typeof vi.fn>).mockResolvedValue({
      tool_call_id: 'tc_1',
      name: 'shell_exec',
      content: "<tool_output tool='shell_exec'>ok</tool_output>",
      is_error: false,
      attachments: [approvedToolAttachment],
    })

    const task = createTestTask('user-1')
    await agent.executeTask(task)
    expect(agent.getState()).toBe('waiting_approval')

    const approvalResult = await agent.handleApproval('user-1', 'req-attachments', false)
    expect(approvalResult.success).toBe(true)

    await vi.waitFor(() => {
      expect(task.responseCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          response: 'Done',
          attachments: [
            suspendedLoopAttachment,
            priorAttachment,
            approvedToolAttachment,
            resumedLoopAttachment,
          ],
        })
      )
    })
  })

  it('emits tool progress events when resuming after approval', async () => {
    ;(runToolUseLoop as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        type: 'need_approval',
        approval: {
          request_id: 'req-progress-1',
          tool_name: 'shell_exec',
          parameters: { command: 'ls' },
          description: 'Shell command',
          tool_call_id: 'tc_progress_1',
          context_snapshot: [{ role: 'user', content: 'Do something' }],
          completed_results: [],
        },
      })
      .mockResolvedValueOnce({
        type: 'response',
        content: 'Done',
        usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
      })
    ;(executeSingleTool as ReturnType<typeof vi.fn>).mockResolvedValue({
      tool_call_id: 'tc_progress_1',
      name: 'shell_exec',
      content: 'file1.txt\nfile2.txt',
      is_error: false,
      rawContent: 'file1.txt\nfile2.txt',
    })

    const task = createTestTask('user-1')
    // Register + advance to 'processing' so lifecycle transitions are legal:
    // pending → processing → completed (LEGAL_TRANSITIONS requires this order).
    queue.enqueue(task)
    queue.dequeue()
    await agent.executeTask(task)
    expect(agent.getState()).toBe('waiting_approval')

    const reporter = progressReporterRegistry.get(task.id)
    expect(reporter).toBeDefined()

    const events: Array<{ type: string; data: Record<string, unknown> }> = []
    const unsubscribe = reporter!.subscribe(event => {
      const eventData =
        event.data && typeof event.data === 'object'
          ? (event.data as unknown as Record<string, unknown>)
          : {}
      events.push({
        type: event.type,
        data: eventData,
      })
    })

    const approvalResult = await agent.handleApproval('user-1', 'req-progress-1', false)
    expect(approvalResult.success).toBe(true)

    // The subscriber attaches while the task is already suspended (post-
    // emitSuspended), so the P1 sticky replay delivers the live `suspended`
    // first, then the resume sequence follows once the approval is granted
    // once (handleApproval alwaysApprove=false → approve this request, not deny).
    await vi.waitFor(() => {
      expect(events.map(event => event.type)).toEqual([
        'suspended',
        'tool_start',
        'tool_complete',
        'terminal',
      ])
    })
    unsubscribe()

    expect(events[0]?.data.requestId).toBe('req-progress-1')
    expect(events[1]?.data.toolCallId).toBe('tc_progress_1')
    expect(events[2]?.data.toolCallId).toBe('tc_progress_1')
    expect(events[2]?.data.outputPreview).toBeDefined()
  })

  it('should auto-deny after approval timeout (BUG-7)', async () => {
    // Use a very short timeout for testing
    const shortTimeoutQueue = new MessageQueue()
    const shortTimeoutAgent = new AgentStateMachine(shortTimeoutQueue, new TaskLifecycle(), {
      autoStart: false,
      approvalTimeout: 100, // 100ms
    })
    const mockProvider = {
      completeSingleTurn: vi.fn(),
      completeSingleTurnWithTools: vi.fn(),
      getProviderType: () => 'openai' as const,
    }
    shortTimeoutAgent.setLLMProvider(mockProvider as any)
    shortTimeoutAgent.setMcpManager({ getAllTools: () => [], callTool: vi.fn() } as any)
    shortTimeoutAgent.start() // Required for getState() to aggregate executor states
    ;(runToolUseLoop as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      type: 'need_approval',
      approval: {
        request_id: 'req-timeout-1',
        tool_name: 'shell_exec',
        parameters: { command: 'ls' },
        description: 'List files',
        tool_call_id: 'tc_1',
        context_snapshot: [],
      },
    })

    const task = createTestTask()
    task.responseCallback = vi.fn(async () => {})
    await shortTimeoutAgent.executeTask(task)

    expect(shortTimeoutAgent.getState()).toBe('waiting_approval')

    await vi.waitFor(() => {
      expect(shortTimeoutAgent.getState()).toBe('idle')
      expect(task.responseCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          response: expect.stringContaining('denied'),
        })
      )
    })
  })
})
