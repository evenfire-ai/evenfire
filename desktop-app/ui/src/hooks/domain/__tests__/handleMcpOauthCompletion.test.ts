import { describe, expect, it, vi } from 'vitest'
import { makeTaskKey } from '@contexts/AgentTaskTrackerContext'
import type { PendingApprovalLite } from '../../../../../src/types'
import { handleMcpOauthCompletion } from '../approvalDecision'
import { createSessionFsmStore } from '../sessionFsm'

/**
 * U3 invariants (spec 11), driven off the REAL `sessionFsmReducer` snapshot (T1)
 * — a `connect_required` suspension is fed through the exact `STREAM_SUSPENDED`
 * transition the live tracker fires, never hand-built.
 */
function suspend(
  store: ReturnType<typeof createSessionFsmStore>,
  agentRef: string,
  chatId: string,
  taskId: string,
  approval: PendingApprovalLite
): void {
  store.dispatch(makeTaskKey(agentRef, chatId), { type: 'STREAM_SUSPENDED', taskId, approval })
}

const connectApproval = (requestId: string, mcpServerName: string): PendingApprovalLite => ({
  requestId,
  displayName: `${mcpServerName} tool`,
  reason: 'connect_required',
  mcpServerName,
})

describe('handleMcpOauthCompletion — U3 proactive + coexistence', () => {
  it('T5#1 · no suspended turn → refreshes the connectors panel, resumes nothing (proactive branch)', () => {
    const store = createSessionFsmStore()
    // The panel "Authorize" flow: no turn is waiting on this server.
    const decide = vi.fn()
    const refreshConnectors = vi.fn()

    const result = handleMcpOauthCompletion(
      {
        getSnapshot: () => store.getSnapshot(),
        decide,
        refreshConnectors,
      },
      'monday'
    )

    expect(decide).not.toHaveBeenCalled()
    expect(refreshConnectors).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ resumedCount: 0, wasProactive: true })
  })

  it('T5#2 · a turn is suspended on the server → resumes the turn AND refreshes the panel (coexistence)', () => {
    const store = createSessionFsmStore()
    suspend(store, 'agentA', 'chatA1', 'taskA', connectApproval('reqA', 'monday'))
    const decide = vi.fn()
    const refreshConnectors = vi.fn()

    const result = handleMcpOauthCompletion(
      {
        getSnapshot: () => store.getSnapshot(),
        decide,
        refreshConnectors,
      },
      'monday'
    )

    // The reactive resume is NOT broken…
    expect(decide).toHaveBeenCalledTimes(1)
    expect(decide).toHaveBeenCalledWith(
      expect.objectContaining({
        agentRef: 'agentA',
        chatId: 'chatA1',
        taskId: 'taskA',
        requestId: 'reqA',
        decision: 'approve',
        source: 'connect_completed',
      })
    )
    // …AND the panel is refreshed in the same completion.
    expect(refreshConnectors).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ resumedCount: 1, wasProactive: false })
  })

  it('resumes every conversation suspended on the same server, refreshing once', () => {
    const store = createSessionFsmStore()
    suspend(store, 'agentA', 'chat1', 'task1', connectApproval('req1', 'monday'))
    suspend(store, 'agentA', 'chat2', 'task2', connectApproval('req2', 'monday'))
    const decide = vi.fn()
    const refreshConnectors = vi.fn()

    const result = handleMcpOauthCompletion(
      { getSnapshot: () => store.getSnapshot(), decide, refreshConnectors },
      'monday'
    )

    expect(decide).toHaveBeenCalledTimes(2)
    // A single refresh per completion — the queue's (server,provider) dedup keeps
    // a cold-start replay from double-firing; a redundant invalidate is idempotent.
    expect(refreshConnectors).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ resumedCount: 2, wasProactive: false })
  })
})
