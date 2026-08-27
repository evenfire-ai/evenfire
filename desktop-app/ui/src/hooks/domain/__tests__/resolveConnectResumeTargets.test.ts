import { describe, expect, it } from 'vitest'
import { makeTaskKey } from '@contexts/AgentTaskTrackerContext'
import type { PendingApprovalLite } from '../../../../../src/types'
import { resolveConnectResumeTargets } from '../approvalDecision'
import { createSessionFsmStore } from '../sessionFsm'

/**
 * T1: the FSM snapshot the correlation reads is DERIVED from the real
 * `sessionFsmReducer` (via `createSessionFsmStore`), not hand-built — a
 * `connect_required` suspension is fed through the exact `STREAM_SUSPENDED`
 * transition the live tracker fires, so the entries have the real shape.
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

describe('resolveConnectResumeTargets — U5 deep-link correlation (T5, concurrency)', () => {
  it('resumes ONLY the conversation whose mcpServerName matches, with 2 concurrent suspensions on different servers', () => {
    const store = createSessionFsmStore()
    suspend(store, 'agentA', 'chatA1', 'taskA', connectApproval('reqA', 'monday'))
    suspend(store, 'agentB', 'chatB1', 'taskB', connectApproval('reqB', 'clickup'))

    const targets = resolveConnectResumeTargets(store.getSnapshot(), 'monday')

    expect(targets).toEqual([
      {
        agentRef: 'agentA',
        chatId: 'chatA1',
        taskId: 'taskA',
        requestId: 'reqA',
        decision: 'approve',
        source: 'connect_completed',
      },
    ])
    // The clickup suspension must be left untouched.
    expect(targets.some(t => t.requestId === 'reqB')).toBe(false)
  })

  it('resumes EVERY conversation suspended on the same server (per-user grant is global)', () => {
    const store = createSessionFsmStore()
    suspend(store, 'agentA', 'chat1', 'task1', connectApproval('req1', 'monday'))
    suspend(store, 'agentA', 'chat2', 'task2', connectApproval('req2', 'monday'))

    const targets = resolveConnectResumeTargets(store.getSnapshot(), 'monday')

    expect(targets).toHaveLength(2)
    expect(new Set(targets.map(t => t.requestId))).toEqual(new Set(['req1', 'req2']))
    expect(targets.every(t => t.decision === 'approve')).toBe(true)
  })

  it('never matches a generic (approval_required) suspension on the same chat model', () => {
    const store = createSessionFsmStore()
    // A plain tool approval — no reason / mcpServerName.
    suspend(store, 'agentA', 'chatA1', 'taskA', {
      requestId: 'reqA',
      displayName: 'some tool',
    })

    expect(resolveConnectResumeTargets(store.getSnapshot(), 'monday')).toEqual([])
  })

  it('an empty / whitespace mcpServerName correlates to nothing (fail-closed)', () => {
    const store = createSessionFsmStore()
    suspend(store, 'agentA', 'chatA1', 'taskA', connectApproval('reqA', 'monday'))

    expect(resolveConnectResumeTargets(store.getSnapshot(), '')).toEqual([])
    expect(resolveConnectResumeTargets(store.getSnapshot(), '   ')).toEqual([])
  })
})
