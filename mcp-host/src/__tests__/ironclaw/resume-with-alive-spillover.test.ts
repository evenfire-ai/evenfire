/**
 * IronClaw invariant #2 golden (P.3 §6.2): when a snapshot carries spillover
 * refs that are still alive, the resolver swaps the blob bodies in and the
 * loop continues identically to the no-spillover case.
 *
 * P.3 ships the contract; T1.5 ships the FS-backed resolver. This test pins
 * the contract — the resolver MUST see the lateral `spillover_ref` field
 * (P0-002 Opción D) and the resolved string MUST land in the tool message
 * delivered to `runToolUseLoop`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskExecutor, type TaskExecutorDeps } from '../../agent/taskExecutor'
import { ConversationManager } from '../../core/conversation/conversation'
import { SimpleEventEmitter } from '../../core/orchestration/eventEmitter'
import type { SpilloverResolver } from '../../core/orchestration/spilloverResolver'
import { executeSingleTool, runToolUseLoop } from '../../core/orchestration/toolUseLoop'
import { registerDesktopTools } from '../../core/tools/desktopTools'
import type { ChatMessage, ToolResult } from '../../core/types'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import type { Task } from '../../queue/types'

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

function makeTask(): Task {
  return {
    id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    source: 'channel',
    sourceMessage: {
      sender: 'user-1',
      content: 'Read it',
      channelType: 'telegram',
      channelId: 'test-channel',
      messageId: 'msg-1',
      timestamp: new Date().toISOString(),
      hostRef: 'test-host',
    },
    priority: 'normal',
    status: 'pending',
    conversationHistory: [{ role: 'user', content: 'Read it', timestamp: new Date() }],
    responseCallback: vi.fn(async () => {}),
    createdAt: new Date(),
  }
}

function makeDeps(
  overrides: Partial<TaskExecutorDeps> & { spilloverResolver: SpilloverResolver }
): TaskExecutorDeps {
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

describe('IronClaw invariant #2: resume with alive spillover ref', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(registerDesktopTools).mockResolvedValue(undefined)
  })

  it('resolves the ref, injects the blob, continues the loop verbatim', async () => {
    const resolver: SpilloverResolver = {
      resolve: vi.fn(async (m: Pick<ChatMessage, 'content' | 'spillover_ref'>) => {
        if (m.spillover_ref === 'spillover://task/t1') return 'BLOB CONTENT FOR t1'
        return m.content
      }),
      probe: vi.fn(async () => ({ alive: [], expired: [] })),
    }

    // First loop returns need_approval with a snapshot that carries a
    // spillover ref on the first completed result and inline content on the
    // second. Second loop (post-resume) returns a final text response.
    vi.mocked(runToolUseLoop)
      .mockResolvedValueOnce({
        type: 'need_approval',
        approval: {
          request_id: 'req-1',
          tool_name: 'shell_exec',
          parameters: { command: 'rm -rf /tmp/foo' },
          description: 'destructive op',
          tool_call_id: 'tc_approved',
          context_snapshot: [
            { role: 'user', content: 'Read it' },
            {
              role: 'assistant',
              content: '',
              tool_calls: [
                { id: 't1', name: 'fs_read', arguments: {} },
                { id: 't2', name: 'fs_list', arguments: {} },
                {
                  id: 'tc_approved',
                  name: 'shell_exec',
                  arguments: { command: 'rm -rf /tmp/foo' },
                },
              ],
            },
          ],
          completed_results: [
            {
              tool_call_id: 't1',
              name: 'fs_read',
              content: '<<rich summary>>',
              spillover_ref: 'spillover://task/t1',
              is_error: false,
            },
            {
              tool_call_id: 't2',
              name: 'fs_list',
              content: 'inline-result-2',
              is_error: false,
            },
          ],
        },
      } as any)
      .mockResolvedValueOnce({ type: 'response', content: 'all done' } as any)

    vi.mocked(executeSingleTool).mockResolvedValueOnce({
      tool_call_id: 'tc_approved',
      name: 'shell_exec',
      content: 'removed',
      is_error: false,
    } satisfies ToolResult)

    const task = makeTask()
    const deps = makeDeps({ spilloverResolver: resolver })
    const executor = new TaskExecutor(task, deps)

    await executor.run()
    expect(executor.executorState).toBe('waiting_approval')

    await executor.resumeAfterApproval(false)

    // 1. The resolver was invoked with the lateral spillover_ref shape (Opción D).
    expect(resolver.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ spillover_ref: 'spillover://task/t1' })
    )
    expect(resolver.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'inline-result-2', spillover_ref: undefined })
    )

    // 2. The blob string reached runToolUseLoop's reconstructed messages.
    const resumeCall = vi.mocked(runToolUseLoop).mock.calls.at(-1)
    const messages = (resumeCall?.[1] ?? []) as ChatMessage[]
    expect(messages).toContainEqual(
      expect.objectContaining({ role: 'tool', content: 'BLOB CONTENT FOR t1', tool_call_id: 't1' })
    )
    expect(messages).toContainEqual(
      expect.objectContaining({ role: 'tool', content: 'inline-result-2', tool_call_id: 't2' })
    )
    expect(messages).toContainEqual(
      expect.objectContaining({ role: 'tool', content: 'removed', tool_call_id: 'tc_approved' })
    )

    // 3. The approved tool actually executed.
    expect(executeSingleTool).toHaveBeenCalledTimes(1)
    expect(executor.executorState).toBe('completed')
  })
})
