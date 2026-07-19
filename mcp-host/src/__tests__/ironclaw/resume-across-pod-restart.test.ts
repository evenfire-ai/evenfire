/**
 * IronClaw invariant #3 golden (P.3 §6.4): pending_approvals survive a Pod
 * restart by being rehydrated from durable storage before SessionProcessor
 * starts processing new messages.
 *
 * T2.1 ships the real SqliteColdStartLoader. This test pins the contract
 * (ColdStartLoader interface + agent.setColdStartLoader + agent.bootstrap)
 * using a hand-rolled mock that simulates persistence. When T2.1 lands, an
 * analogous test will exercise the real loader end-to-end.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AgentStateMachine,
  type ColdStartLoader,
  type RehydratedApproval,
} from '../../agent/stateMachine'
import type { PendingApproval } from '../../core/types'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import { MessageQueue } from '../../queue/messageQueue'
import { serializeSessionKey } from '../../session'

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

describe('IronClaw invariant #3: resume across Pod restart', () => {
  let agent: AgentStateMachine

  beforeEach(() => {
    agent = new AgentStateMachine(new MessageQueue(), new TaskLifecycle(), { autoStart: false })
    agent.setLLMProvider({
      completeSingleTurn: vi.fn(),
      completeSingleTurnWithTools: vi.fn(),
      getProviderType: () => 'openai' as const,
    } as any)
    agent.setMcpManager({ getAllTools: () => [], callTool: vi.fn() } as any)
  })

  async function seedRehydratedApproval(opts: {
    requestId: string
    taskId: string
    sessionKey: string
    sourceMessage: Record<string, unknown>
    expiresAt?: number
  }): Promise<PendingApproval> {
    const approval: PendingApproval = {
      request_id: opts.requestId,
      tool_name: 'shell_exec',
      parameters: { command: 'ls' },
      description: 'queued before restart',
      tool_call_id: `tc_${opts.requestId}`,
      context_snapshot: [],
    }
    const manager = agent.getConversationManager()
    const conv = await manager.getOrCreate(opts.sessionKey)
    await manager.startTurn(conv, 'run a gated command', opts.taskId)
    await manager.suspendForApproval(conv, approval)
    const loader: ColdStartLoader = {
      loadPendingApprovals: vi.fn(
        async (): Promise<RehydratedApproval[]> => [
          {
            request_id: opts.requestId,
            task_id: opts.taskId,
            session_key: opts.sessionKey,
            approval,
            source_message: opts.sourceMessage,
            expiresAt: opts.expiresAt,
          },
        ]
      ),
    }
    agent.setColdStartLoader(loader)
    await agent.bootstrap()
    return approval
  }

  it('fails closed when durable approval metadata lacks its session key', async () => {
    const loader: ColdStartLoader = {
      loadPendingApprovals: vi.fn(
        async (): Promise<RehydratedApproval[]> => [
          {
            request_id: 'req-r1',
            task_id: 'task-r1',
            approval: {
              request_id: 'req-r1',
              tool_name: 'shell_exec',
              parameters: { command: 'ls' },
              description: 'queued before restart',
              tool_call_id: 'tc_r1',
              context_snapshot: [],
            },
            source_message: {
              sender: 'alice',
              channelType: 'telegram',
              channelId: 'c-1',
            },
          },
        ]
      ),
    }

    agent.setColdStartLoader(loader)
    await expect(agent.bootstrap()).rejects.toThrow('missing its session key')
  })

  it('cold-start with empty loader is a no-op (P.3 default)', async () => {
    // NoOpColdStartLoader is the default — bootstrap() must be safe to call
    // even when no rehydration is needed.
    await agent.bootstrap()
    expect(agent.getPendingApprovals()).toEqual([])
  })

  it('D.2 — bootstrap reaps processing sessions BEFORE rehydrating approvals', async () => {
    const order: string[] = []
    const loader: ColdStartLoader = {
      reapProcessingSessions: vi.fn(async () => {
        order.push('reap')
        return []
      }),
      loadPendingApprovals: vi.fn(async (): Promise<RehydratedApproval[]> => {
        order.push('rehydrate')
        return []
      }),
    }
    agent.setColdStartLoader(loader)
    await agent.bootstrap()

    expect(loader.reapProcessingSessions).toHaveBeenCalledTimes(1)
    expect(loader.loadPendingApprovals).toHaveBeenCalledTimes(1)
    expect(order).toEqual(['reap', 'rehydrate']) // reap runs first
  })

  it('D.2 — a reaper failure does NOT block approval rehydration', async () => {
    const loader: ColdStartLoader = {
      reapProcessingSessions: vi.fn(async () => {
        throw new Error('reap boom')
      }),
      loadPendingApprovals: vi.fn(async (): Promise<RehydratedApproval[]> => []),
    }
    agent.setColdStartLoader(loader)
    await expect(agent.bootstrap()).resolves.toBeUndefined()
    expect(loader.loadPendingApprovals).toHaveBeenCalledTimes(1) // still ran
  })

  it('reaps only expired awaiting approvals before loading live approvals', async () => {
    const order: string[] = []
    const loader: ColdStartLoader = {
      reapProcessingSessions: vi.fn(async () => {
        order.push('reap-processing')
        return []
      }),
      reapExpiredAwaitingApprovalSessions: vi.fn(async () => {
        order.push('reap-expired')
        return []
      }),
      loadPendingApprovals: vi.fn(async (): Promise<RehydratedApproval[]> => {
        order.push('load')
        return []
      }),
    }
    agent.setColdStartLoader(loader)
    await agent.bootstrap()

    expect(loader.reapExpiredAwaitingApprovalSessions).toHaveBeenCalledTimes(1)
    expect(order).toEqual(['reap-processing', 'reap-expired', 'load'])
  })

  it('fails closed when the expired-approval sweep fails', async () => {
    const loader: ColdStartLoader = {
      reapProcessingSessions: vi.fn(async () => []),
      reapExpiredAwaitingApprovalSessions: vi.fn(async () => {
        throw new Error('awaiting reap boom')
      }),
      loadPendingApprovals: vi.fn(async (): Promise<RehydratedApproval[]> => []),
    }
    agent.setColdStartLoader(loader)
    await expect(agent.bootstrap()).rejects.toThrow('awaiting reap boom')
    expect(loader.loadPendingApprovals).not.toHaveBeenCalled()
  })

  it('rehydrated approvals reject decisions from a different owner channel before a legitimate approval succeeds', async () => {
    const sessionKey = serializeSessionKey({
      userId: 'alice',
      channelType: 'telegram',
      channelId: 'chat-1',
    })
    await seedRehydratedApproval({
      requestId: 'req-bound',
      taskId: 'task-bound',
      sessionKey,
      sourceMessage: {
        sender: 'alice',
        channelType: 'telegram',
        channelId: 'chat-1',
      },
    })

    await expect(agent.handleApproval('mallory', 'req-bound', false)).resolves.toMatchObject({
      success: false,
      error: 'Approval decision does not match the originating user',
    })

    await expect(
      agent.handleApproval('alice', 'req-bound', false, 'telegram', 'chat-2')
    ).resolves.toMatchObject({
      success: false,
      error: 'Approval decision does not match the originating channel',
    })

    await expect(
      agent.handleApproval('alice', 'req-bound', false, 'telegram', 'chat-1')
    ).resolves.toMatchObject({ success: true })
  })

  it('rehydrated approvals keep expiresAt active after bootstrap', async () => {
    vi.useFakeTimers()
    try {
      const now = new Date('2026-07-12T12:00:00.000Z')
      vi.setSystemTime(now)
      const sessionKey = serializeSessionKey({
        userId: 'alice',
        channelType: 'telegram',
        channelId: 'chat-1',
      })
      await seedRehydratedApproval({
        requestId: 'req-expiring',
        taskId: 'task-expiring',
        sessionKey,
        sourceMessage: {
          sender: 'alice',
          channelType: 'telegram',
          channelId: 'chat-1',
        },
        expiresAt: now.getTime() + 1_000,
      })

      vi.setSystemTime(now.getTime() + 1_001)

      await expect(
        agent.handleApproval('alice', 'req-expiring', false, 'telegram', 'chat-1')
      ).resolves.toMatchObject({
        success: false,
        error: 'Approval request has expired',
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it.todo(
    'cold-start drops expired approvals by TTL and notifies user (requires T2.1 SqliteColdStartLoader)'
  )

  // NOTE: the "rehydrate executor across restart" todo is intentionally dropped.
  // Spec decision #4 chose "pod restart = reap, not auto-resume": there is no
  // executor rehydration, so a restart-interrupted approval is reaped to idle
  // rather than resumed. The reap behaviour is covered end-to-end by the
  // SqliteConversationStore reapAwaitingApprovalSessions tests.
})
