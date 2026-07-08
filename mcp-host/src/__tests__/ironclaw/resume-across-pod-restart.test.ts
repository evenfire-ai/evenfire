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
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import { MessageQueue } from '../../queue/messageQueue'

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
  })

  it('S1 — bootstrap does NOT stamp restart-interrupted approvals into approvalMap', async () => {
    // The S1 fix (spec decision #4 "pod restart = reap, not auto-resume"): the
    // PHASE 1b reaper deletes every awaiting_approval row, so by the time
    // loadPendingApprovals runs there is nothing left to rehydrate. Even if the
    // loader returned a stale entry, bootstrap must NOT stamp the approvalMap — a
    // stamped entry with no executor is exactly the S1 bug (handleApproval hits an
    // empty activeExecutors and dead-ends with "Task is no longer awaiting
    // approval" without ever transitioning the session). So the approval must be
    // treated as gone, not re-armed.
    const loader: ColdStartLoader = {
      reapAwaitingApprovalSessions: vi.fn(async () => [
        {
          sessionId: 's-r1',
          sessionKey: 'u:rpc:agent:chat',
          userId: 'alice',
          channelType: 'telegram',
          channelId: 'c-1',
          threadId: null,
          activeTaskId: 'task-r1',
          reapedAt: Date.now(),
        },
      ]),
      // Defensive: even if a stray approval survives the reap, it must not be stamped.
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
    await agent.bootstrap()

    expect(loader.reapAwaitingApprovalSessions).toHaveBeenCalledTimes(1)
    expect(agent.getPendingApprovals()).toEqual([])
    // The map was NOT stamped: handleApproval reports the approval is unknown,
    // not the (now-impossible) "Task is no longer awaiting approval" half-state.
    const result = await agent.handleApproval('alice', 'req-r1', false)
    expect(result.error).toContain('No pending approval')
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

  it('S1 — bootstrap reaps ALL awaiting-approval (PHASE 1b) BEFORE loading approvals', async () => {
    const order: string[] = []
    const loader: ColdStartLoader = {
      reapProcessingSessions: vi.fn(async () => {
        order.push('reap-processing')
        return []
      }),
      reapAwaitingApprovalSessions: vi.fn(async () => {
        order.push('reap-awaiting')
        return []
      }),
      loadPendingApprovals: vi.fn(async (): Promise<RehydratedApproval[]> => {
        order.push('load')
        return []
      }),
    }
    agent.setColdStartLoader(loader)
    await agent.bootstrap()

    expect(loader.reapAwaitingApprovalSessions).toHaveBeenCalledTimes(1)
    // PHASE 1 → PHASE 1b → PHASE 2: the awaiting-approval reap MUST precede the
    // load so a just-deleted approval row isn't observed afterward.
    expect(order).toEqual(['reap-processing', 'reap-awaiting', 'load'])
  })

  it('S1 — an awaiting-approval reaper failure does NOT block boot', async () => {
    const loader: ColdStartLoader = {
      reapProcessingSessions: vi.fn(async () => []),
      reapAwaitingApprovalSessions: vi.fn(async () => {
        throw new Error('awaiting reap boom')
      }),
      loadPendingApprovals: vi.fn(async (): Promise<RehydratedApproval[]> => []),
    }
    agent.setColdStartLoader(loader)
    await expect(agent.bootstrap()).resolves.toBeUndefined()
    expect(loader.loadPendingApprovals).toHaveBeenCalledTimes(1) // still ran
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
