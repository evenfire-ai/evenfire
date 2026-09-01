import { describe, expect, it } from 'vitest'
import { makeTaskKey } from '@contexts/AgentTaskTrackerContext'
import type { PendingApprovalLite } from '../../../../../src/types'
import { type ApprovalDecisionTarget, resolveConnectResumeTargets } from '../approvalDecision'
import { createMcpOauthResumeBuffer } from '../mcpOauthResumeBuffer'
import { createSessionFsmStore } from '../sessionFsm'

/**
 * U5/R3-M1 cold-start buffer. The snapshots the buffer re-evaluates are DERIVED
 * from the real `sessionFsmReducer` (via `createSessionFsmStore` + the exact
 * `STREAM_SUSPENDED` transition the live tracker fires) and read through the real
 * `resolveConnectResumeTargets` — never hand-built (T1). The buffer itself is a
 * pure TTL map, so `now` is passed explicitly instead of using timers.
 */

const connectApproval = (requestId: string, mcpServerName: string): PendingApprovalLite => ({
  requestId,
  displayName: `${mcpServerName} tool`,
  reason: 'connect_required',
  mcpServerName,
})

function suspendConnect(
  store: ReturnType<typeof createSessionFsmStore>,
  agentRef: string,
  chatId: string,
  taskId: string,
  requestId: string,
  mcpServerName: string
): void {
  store.dispatch(makeTaskKey(agentRef, chatId), {
    type: 'STREAM_SUSPENDED',
    taskId,
    approval: connectApproval(requestId, mcpServerName),
  })
}

/**
 * Mimic the real consequence of a resume: the central decider dispatches
 * `APPROVAL_DECIDED`, which moves the chat out of `awaiting_approval`, so it stops
 * resolving as a connect-resume target. This is the guard the buffer leans on for
 * idempotency instead of tracking fired requestIds itself.
 */
function resumeConnect(
  store: ReturnType<typeof createSessionFsmStore>,
  agentRef: string,
  chatId: string,
  taskId: string,
  requestId: string
): void {
  store.dispatch(makeTaskKey(agentRef, chatId), {
    type: 'APPROVAL_DECIDED',
    taskId,
    requestId,
    decision: 'approve',
  })
}

describe('createMcpOauthResumeBuffer', () => {
  const resolverFor = (store: ReturnType<typeof createSessionFsmStore>) => (server: string) =>
    resolveConnectResumeTargets(store.getSnapshot(), server)

  it('cold start: an entry buffered while empty resumes once the snapshot seeds', () => {
    const store = createSessionFsmStore()
    const buffer = createMcpOauthResumeBuffer<ApprovalDecisionTarget>()
    const resolve = resolverFor(store)

    // Completion arrives before any session exists.
    buffer.add('monday', 1_000)
    expect(buffer.drain(100, resolve)).toEqual([]) // nothing to resume yet…
    expect(buffer.size()).toBe(1) // …but the entry is kept for a later snapshot.

    // The suspended session lands (real producer transition).
    suspendConnect(store, 'agent-x', 'chat-1', 'task-1', 'req-1', 'monday')

    const fired = buffer.drain(200, resolve)
    expect(fired).toEqual([
      {
        agentRef: 'agent-x',
        chatId: 'chat-1',
        taskId: 'task-1',
        requestId: 'req-1',
        decision: 'approve',
        source: 'connect_completed',
      },
    ])
    // Kept until its deadline (NOT removed on match) so later siblings resume too.
    expect(buffer.size()).toBe(1)
    // The real decider transition drops the resumed chat out of awaiting_approval…
    resumeConnect(store, 'agent-x', 'chat-1', 'task-1', 'req-1')
    // …so a later drain within the window re-fires nothing.
    expect(buffer.drain(300, resolve)).toEqual([])
  })

  it('anti-double: a resumed conversation is not fired twice (idempotent via the real APPROVAL_DECIDED transition, not by removing the entry)', () => {
    const store = createSessionFsmStore()
    const buffer = createMcpOauthResumeBuffer<ApprovalDecisionTarget>()
    const resolve = resolverFor(store)

    suspendConnect(store, 'agent-x', 'chat-1', 'task-1', 'req-1', 'monday')
    buffer.add('monday', 1_000)

    expect(buffer.drain(100, resolve)).toHaveLength(1)
    // The central decider dispatches APPROVAL_DECIDED, moving the chat out of
    // awaiting_approval — so it stops resolving as a connect-resume target.
    resumeConnect(store, 'agent-x', 'chat-1', 'task-1', 'req-1')
    // The entry is still buffered (kept until deadline), but resolve() no longer
    // returns it → no second fire. Idempotency comes from the FSM guard, not from
    // removing the entry on first match (that would drop later siblings).
    expect(buffer.drain(200, resolve)).toEqual([])
    expect(buffer.size()).toBe(1) // TTL is the only removal path
  })

  it('TTL: an entry past its deadline is discarded WITHOUT firing, even if it would match', () => {
    const store = createSessionFsmStore()
    const buffer = createMcpOauthResumeBuffer<ApprovalDecisionTarget>()
    const resolve = resolverFor(store)

    // A perfectly matchable suspension exists…
    suspendConnect(store, 'agent-x', 'chat-1', 'task-1', 'req-1', 'monday')
    buffer.add('monday', 1_000)

    // …but the drain happens after the deadline → dropped, no resume.
    expect(buffer.drain(1_001, resolve)).toEqual([])
    expect(buffer.size()).toBe(0)
  })

  it('a buffered entry with no matching server is kept until it expires', () => {
    const store = createSessionFsmStore()
    const buffer = createMcpOauthResumeBuffer<ApprovalDecisionTarget>()
    const resolve = resolverFor(store)

    // Suspension on a DIFFERENT server.
    suspendConnect(store, 'agent-x', 'chat-1', 'task-1', 'req-1', 'clickup')
    buffer.add('monday', 1_000)

    expect(buffer.drain(100, resolve)).toEqual([])
    expect(buffer.size()).toBe(1) // still waiting for a monday suspension
    expect(buffer.drain(2_000, resolve)).toEqual([]) // now expired
    expect(buffer.size()).toBe(0)
  })

  it('resumes EVERY conversation on the server, INCLUDING a sibling seeded in a LATER drain (the real per-dispatch seam; per-user grant is global)', () => {
    const store = createSessionFsmStore()
    const buffer = createMcpOauthResumeBuffer<ApprovalDecisionTarget>()
    const resolve = resolverFor(store)

    // First sibling seeded (one dispatch); completion buffered.
    suspendConnect(store, 'agent-x', 'chat-1', 'task-1', 'req-1', 'monday')
    buffer.add('monday', 1_000)

    const firstDrain = buffer.drain(100, resolve)
    expect(firstDrain.map(t => t.requestId)).toEqual(['req-1'])
    resumeConnect(store, 'agent-x', 'chat-1', 'task-1', 'req-1') // real transition

    // The SECOND sibling on the SAME server surfaces in a LATER dispatch/drain —
    // exactly how seedSessionSnapshots emits (one session per notify). A helper
    // that removed the entry on the first match would have dropped it here and
    // this sibling would NEVER resume (this is the R3-M1 review Should-fix).
    suspendConnect(store, 'agent-x', 'chat-2', 'task-2', 'req-2', 'monday')
    const secondDrain = buffer.drain(200, resolve)
    expect(secondDrain.map(t => t.requestId)).toEqual(['req-2'])
    expect(secondDrain.every(t => t.decision === 'approve')).toBe(true)

    expect(buffer.size()).toBe(1) // still kept until its deadline
  })

  it('a blank / whitespace server name is never buffered (fail-closed)', () => {
    const buffer = createMcpOauthResumeBuffer<ApprovalDecisionTarget>()
    buffer.add('', 1_000)
    buffer.add('   ', 1_000)
    expect(buffer.size()).toBe(0)
  })

  it('drain is a no-op when nothing is buffered (normal path never re-fires)', () => {
    const store = createSessionFsmStore()
    const buffer = createMcpOauthResumeBuffer<ApprovalDecisionTarget>()
    // Normal path: the completion resolved immediately so nothing was buffered.
    suspendConnect(store, 'agent-x', 'chat-1', 'task-1', 'req-1', 'monday')
    expect(buffer.size()).toBe(0)
    expect(buffer.drain(100, resolverFor(store))).toEqual([])
  })

  it('re-buffering the same server refreshes the deadline (last write wins)', () => {
    const store = createSessionFsmStore()
    const buffer = createMcpOauthResumeBuffer<ApprovalDecisionTarget>()
    const resolve = resolverFor(store)

    buffer.add('monday', 500)
    buffer.add('monday', 5_000) // a repeat completion pushes the deadline out
    expect(buffer.size()).toBe(1)

    suspendConnect(store, 'agent-x', 'chat-1', 'task-1', 'req-1', 'monday')
    // Past the FIRST deadline but within the refreshed one → still resumes.
    expect(buffer.drain(1_000, resolve)).toHaveLength(1)
  })
})
