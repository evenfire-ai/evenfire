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

  // M8: pin the `reason !== 'connect_required'` guard. This is the ONLY thing
  // keeping the unsigned deep-link (R4-M7) from driving an Approve on a suspension
  // that is not an OAuth connect. The two cases below carry a MATCHING
  // mcpServerName, so the mcpServerName guard alone does NOT exclude them — only
  // the reason guard does. Deleting `approval.reason !== 'connect_required'` makes
  // both return a resume target → these go red (the mutant dies).
  it('M8: does NOT resume an approval_required suspension even when mcpServerName matches', () => {
    const store = createSessionFsmStore()
    // A generic tool approval that (defensively) still carries an mcpServerName.
    suspend(store, 'agentA', 'chatA1', 'taskA', {
      requestId: 'reqA',
      displayName: 'monday tool',
      reason: 'approval_required',
      mcpServerName: 'monday',
    })

    expect(resolveConnectResumeTargets(store.getSnapshot(), 'monday')).toEqual([])
  })

  it('M8: does NOT resume a reasonless suspension even when mcpServerName matches', () => {
    const store = createSessionFsmStore()
    suspend(store, 'agentA', 'chatA1', 'taskA', {
      requestId: 'reqA',
      displayName: 'monday tool',
      mcpServerName: 'monday',
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
