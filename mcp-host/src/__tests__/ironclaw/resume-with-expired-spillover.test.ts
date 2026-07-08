/**
 * IronClaw invariant #2 golden (P.3 §6.3): when a snapshot carries an
 * expired spillover ref, the resume FAILS explicitly with `approval_expired`
 * — we never silently regenerate the prior tool call (audit invariant).
 *
 * Negative assertions worth their own line:
 *   - the approved tool is NOT executed
 *   - the loop is NOT re-entered
 *   - onFail receives `code: 'approval_expired'` (distinct from
 *     `approval_timeout`)
 *   - the conversation transitions back to Idle so the session unblocks
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskExecutor, type TaskExecutorDeps } from '../../agent/taskExecutor'
import { ConversationManager } from '../../core/conversation/conversation'
import { SimpleEventEmitter } from '../../core/orchestration/eventEmitter'
import type { SpilloverResolver } from '../../core/orchestration/spilloverResolver'
import { executeSingleTool, runToolUseLoop } from '../../core/orchestration/toolUseLoop'
import { registerDesktopTools } from '../../core/tools/desktopTools'
import { ApprovalExpiredError, ConversationState } from '../../core/types'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import type { Task, TaskError } from '../../queue/types'

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

describe('IronClaw invariant #2: resume with expired spillover ref', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(registerDesktopTools).mockResolvedValue(undefined)
  })

  it('fails with approval_expired WITHOUT executing the approved tool', async () => {
    const expiredRefUri = 'spillover://task/old'
    const resolver: SpilloverResolver = {
      resolve: vi.fn(async () => {
        throw new ApprovalExpiredError({
          code: 'approval_expired',
          request_id: 'req-1',
          task_id: 'task',
          tool_name: 'fs_read',
          expired_refs: [expiredRefUri],
          user_message:
            'The data your approval referenced has expired. Please re-issue the original command.',
        })
      }),
      probe: vi.fn(async () => ({ alive: [], expired: [expiredRefUri] })),
    }

    vi.mocked(runToolUseLoop).mockResolvedValueOnce({
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
              { id: 'tc_approved', name: 'shell_exec', arguments: { command: 'rm -rf /tmp/foo' } },
            ],
          },
        ],
        completed_results: [
          {
            tool_call_id: 't1',
            name: 'fs_read',
            content: '<<rich summary>>',
            spillover_ref: expiredRefUri,
            is_error: false,
          },
        ],
      },
    } as any)

    let captured: TaskError | undefined
    const task = makeTask()
    const deps = makeDeps({
      spilloverResolver: resolver,
      onFail: (_t, err) => {
        captured = err
      },
    })
    const executor = new TaskExecutor(task, deps)

    await executor.run()
    expect(executor.executorState).toBe('waiting_approval')
    const convBeforeResume = await deps.conversationManager.getOrCreate(
      'user-1:telegram:test-channel:default'
    )
    expect(convBeforeResume.state).toBe(ConversationState.AwaitingApproval)

    await executor.resumeAfterApproval(false)

    // 1. The approved tool was NEVER executed.
    expect(executeSingleTool).not.toHaveBeenCalled()
    // 2. The loop was NOT re-entered (only the initial run() call, no resume call).
    expect(runToolUseLoop).toHaveBeenCalledTimes(1)
    // 3. onFail received the distinguishing code.
    expect(captured).toEqual(
      expect.objectContaining({
        code: 'approval_expired',
        retryable: false,
      })
    )
    expect(captured?.message).toContain('expired')
    // 4. The executor moved to failed and the conversation released back to Idle.
    expect(executor.executorState).toBe('failed')
    expect(convBeforeResume.state).toBe(ConversationState.Idle)
  })
})
