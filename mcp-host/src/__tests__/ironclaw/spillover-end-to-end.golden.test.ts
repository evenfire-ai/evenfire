/**
 * T1.5 — End-to-end IronClaw goldens that exercise the REAL FsSpilloverResolver
 * + SpilloverStorage (no mocks for the resolver). Sister file to
 * `resume-with-{alive,expired}-spillover.test.ts`, which pin the P.3 contract
 * via mock resolvers.
 *
 * Covers the two acceptance criteria from `T1.5-spillover.md §6.1`:
 *   1. resume with alive spillover → blob body swapped into the LLM-bound
 *      tool message; approved tool runs; loop continues to completion.
 *   2. resume with expired spillover → resume aborts with `approval_expired`;
 *      approved tool NEVER executed; conversation released to Idle.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { TaskExecutor, type TaskExecutorDeps } from '../../agent/taskExecutor'
import { ConversationManager } from '../../core/conversation/conversation'
import { SimpleEventEmitter } from '../../core/orchestration/eventEmitter'
import { executeSingleTool, runToolUseLoop } from '../../core/orchestration/toolUseLoop'
import { SpilloverStorage } from '../../core/spillover'
import { registerDesktopTools } from '../../core/tools/desktopTools'
import { type ChatMessage, ConversationState, type ToolResult } from '../../core/types'
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
    id: `taske2e${Math.random().toString(36).slice(2, 10)}`,
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
  overrides: Partial<TaskExecutorDeps> & { spilloverStorage: SpilloverStorage }
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

describe('IronClaw end-to-end with real FsSpilloverResolver', () => {
  let workspace: string
  let storage: SpilloverStorage

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(registerDesktopTools).mockResolvedValue(undefined)
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ironclaw-spillover-'))
    storage = new SpilloverStorage({
      workspacePath: workspace,
      thresholdBytes: 32,
      ttlMs: 60_000,
      gcIntervalMs: 0,
    })
  })

  afterEach(async () => {
    storage.stopGc()
    await fs.rm(workspace, { recursive: true, force: true })
  })

  it('resumes with the blob body inlined when the ref is alive (T1.5 §6.1.1)', async () => {
    const blob = 'BLOB-BODY-' + 'X'.repeat(500)
    const summary = await storage.maybePersist({
      taskId: 'taske2e',
      toolCallId: 't1',
      toolName: 'file_read',
      content: blob,
      isError: false,
    })
    expect(summary).not.toBeNull()
    const ref = summary!.spillover_ref
    const summaryJson = JSON.stringify(summary)

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
                { id: 't1', name: 'file_read', arguments: {} },
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
              name: 'file_read',
              content: summaryJson,
              spillover_ref: ref,
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
    const executor = new TaskExecutor(task, makeDeps({ spilloverStorage: storage }))

    await executor.run()
    expect(executor.executorState).toBe('waiting_approval')

    await executor.resumeAfterApproval(false)

    expect(executor.executorState).toBe('completed')
    // The resumed messages must contain the FULL blob body (resolver swapped
    // it in), not the summary JSON.
    const resumeCall = vi.mocked(runToolUseLoop).mock.calls.at(-1)
    const messages = (resumeCall?.[1] ?? []) as ChatMessage[]
    expect(messages).toContainEqual(
      expect.objectContaining({ role: 'tool', content: blob, tool_call_id: 't1' })
    )
    expect(messages).toContainEqual(
      expect.objectContaining({ role: 'tool', content: 'removed', tool_call_id: 'tc_approved' })
    )
    expect(executeSingleTool).toHaveBeenCalledTimes(1)
  })

  it('aborts with approval_expired when the ref has been deleted (T1.5 §6.1.2)', async () => {
    // First persist the blob (so we have a real ref), then delete it to
    // simulate TTL eviction.
    const summary = await storage.maybePersist({
      taskId: 'taske2e',
      toolCallId: 't1',
      toolName: 'file_read',
      content: 'BLOB-' + 'X'.repeat(500),
      isError: false,
    })
    const ref = summary!.spillover_ref
    await storage._testOnlyDelete('taske2e', 't1')

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
              { id: 't1', name: 'file_read', arguments: {} },
              { id: 'tc_approved', name: 'shell_exec', arguments: { command: 'rm -rf /tmp/foo' } },
            ],
          },
        ],
        completed_results: [
          {
            tool_call_id: 't1',
            name: 'file_read',
            content: JSON.stringify(summary),
            spillover_ref: ref,
            is_error: false,
          },
        ],
      },
    } as any)

    let captured: TaskError | undefined
    const task = makeTask()
    const deps = makeDeps({
      spilloverStorage: storage,
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

    expect(executeSingleTool).not.toHaveBeenCalled()
    expect(runToolUseLoop).toHaveBeenCalledTimes(1)
    expect(captured).toEqual(
      expect.objectContaining({
        code: 'approval_expired',
        retryable: false,
      })
    )
    expect(captured?.message).toContain('expired')
    expect(executor.executorState).toBe('failed')
    expect(convBeforeResume.state).toBe(ConversationState.Idle)
  })
})
