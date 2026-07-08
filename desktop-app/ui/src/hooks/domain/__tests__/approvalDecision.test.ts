import { describe, expect, it, vi } from 'vitest'
import { makeTaskKey } from '@contexts/AgentTaskTrackerContext'
import {
  type ApprovalDecisionTarget,
  type DecideApprovalDeps,
  classifyApprovalResult,
  decideApproval,
} from '../approvalDecision'
import { createSessionFsmStore } from '../sessionFsm'

describe('classifyApprovalResult', () => {
  it('success:true → ok', () => {
    expect(classifyApprovalResult({ success: true })).toBe('ok')
  })

  it('the two known already-decided messages → already_decided', () => {
    expect(
      classifyApprovalResult({ success: false, error: 'No pending approval for request req-9' })
    ).toBe('already_decided')
    expect(
      classifyApprovalResult({ success: false, error: 'Task is no longer awaiting approval' })
    ).toBe('already_decided')
  })

  it('any other success:false → failed (default-conservative)', () => {
    expect(classifyApprovalResult({ success: false, error: 'Agent not initialized' })).toBe(
      'failed'
    )
    expect(classifyApprovalResult({ success: false })).toBe('failed')
  })
})

const target: ApprovalDecisionTarget = {
  agentRef: 'agent-a',
  chatId: 'chat-1',
  teamId: 'team-1',
  taskId: 't1',
  requestId: 'req-1',
  decision: 'approve',
  source: 'in_chat',
}
const chatKey = makeTaskKey('agent-a', 'chat-1')

function buildDeps(overrides: Partial<DecideApprovalDeps> = {}): DecideApprovalDeps {
  const fsm = createSessionFsmStore()
  return {
    fsm,
    approve: vi.fn(async () => ({ success: true })),
    deny: vi.fn(async () => ({ success: true })),
    reconcile: vi.fn(),
    resolveApprovalNotification: vi.fn(),
    pushToast: vi.fn(),
    ...overrides,
  }
}

/** Seed the FSM into `awaiting_approval` for the target request. */
function seedAwaiting(deps: DecideApprovalDeps) {
  deps.fsm.dispatch(chatKey, {
    type: 'SERVER_SNAPSHOT',
    state: 'awaiting_approval',
    activeTaskId: 't1',
    pendingApproval: { requestId: 'req-1', displayName: 'shell.exec' },
  })
}

describe('decideApproval — happy path (5 steps)', () => {
  it('optimistically flips to processing, calls RPC with teamId, resolves + toasts', async () => {
    const deps = buildDeps()
    seedAwaiting(deps)
    await decideApproval(deps, target)

    expect(deps.fsm.getState(chatKey)?.phase).toBe('processing')
    expect(deps.approve).toHaveBeenCalledWith(target)
    expect(deps.resolveApprovalNotification).toHaveBeenCalledWith({
      agentName: 'agent-a',
      taskId: 't1',
      requestId: 'req-1',
      state: 'approved',
    })
    // R3 (§4.7.4 step 4): success schedules a reconcile so the badge converges
    // even without a live stream.
    expect(deps.reconcile).toHaveBeenCalledWith(chatKey, 'approval_decided', target.taskId)
    expect(deps.pushToast).toHaveBeenCalledWith('Approved request for agent-a.', 'success')
  })
})

describe('decideApproval — guard (step 1)', () => {
  it('no-ops with an info toast when already decided from another surface', async () => {
    const deps = buildDeps()
    // FSM already past the gate (processing) — not awaiting this request.
    deps.fsm.dispatch(chatKey, { type: 'SEND_STARTED', taskId: 't1' })
    deps.fsm.dispatch(chatKey, { type: 'TASK_CREATED', taskId: 't1' })
    await decideApproval(deps, target)
    expect(deps.approve).not.toHaveBeenCalled()
    expect(deps.pushToast).toHaveBeenCalledWith('That request was already handled.', 'info')
  })

  it('skips the guard AND the optimistic dispatch when the chatKey has no entry (bell)', async () => {
    const deps = buildDeps()
    await decideApproval(deps, { ...target, source: 'inapp_bell' })
    // No optimistic entry created.
    expect(deps.fsm.getState(chatKey)).toBeUndefined()
    expect(deps.approve).toHaveBeenCalledWith({ ...target, source: 'inapp_bell' })
    expect(deps.resolveApprovalNotification).toHaveBeenCalled()
  })
})

describe('decideApproval — failure (step 5)', () => {
  it('5a already_decided: converge (resolve + reconcile), no revert', async () => {
    const deps = buildDeps({
      approve: vi.fn(async () => ({
        success: false,
        error: 'No pending approval for request req-1',
      })),
    })
    seedAwaiting(deps)
    await decideApproval(deps, target)
    // Optimistic processing is kept (converged), not reverted.
    expect(deps.fsm.getState(chatKey)?.phase).toBe('processing')
    expect(deps.resolveApprovalNotification).toHaveBeenCalled()
    expect(deps.reconcile).toHaveBeenCalledWith(chatKey, 'approval_conflict', target.taskId)
    expect(deps.pushToast).toHaveBeenCalledWith('That request was already decided.', 'info')
  })

  it('5b genuine failure (success:false unknown): revert + ALWAYS reconcile + error toast', async () => {
    const deps = buildDeps({
      approve: vi.fn(async () => ({ success: false, error: 'Agent not initialized' })),
    })
    seedAwaiting(deps)
    await decideApproval(deps, target)
    expect(deps.fsm.getState(chatKey)?.phase).toBe('awaiting_approval')
    expect(deps.reconcile).toHaveBeenCalledWith(chatKey, 'approval_decision_failed', target.taskId)
    expect(deps.pushToast).toHaveBeenCalledWith(
      'Failed to approve request: Agent not initialized',
      'error'
    )
  })

  it('5b thrown error (network/HTTP): revert + reconcile + error toast', async () => {
    const deps = buildDeps({
      approve: vi.fn(async () => {
        throw new Error('fetch failed')
      }),
    })
    seedAwaiting(deps)
    await decideApproval(deps, target)
    expect(deps.fsm.getState(chatKey)?.phase).toBe('awaiting_approval')
    expect(deps.reconcile).toHaveBeenCalledWith(chatKey, 'approval_decision_failed', target.taskId)
    expect(deps.pushToast).toHaveBeenCalledWith('Failed to approve request: fetch failed', 'error')
  })

  it('does NOT revert when a stream event advanced the task before the failure (suppression)', async () => {
    let resumeDuringRpc = false
    const deps = buildDeps({
      approve: vi.fn(async () => {
        resumeDuringRpc = true
        return { success: false, error: 'Agent not initialized' }
      }),
    })
    seedAwaiting(deps)
    // Simulate the approve reaching the server: a resume streams in after the
    // optimistic dispatch but before we process the (client-side) failure.
    const originalApprove = deps.approve
    deps.approve = vi.fn(async t => {
      const r = await originalApprove(t)
      if (resumeDuringRpc) deps.fsm.dispatch(chatKey, { type: 'STREAM_RESUMED', taskId: 't1' })
      return r
    })
    await decideApproval(deps, target)
    // Suppressed: stays processing despite the failure.
    expect(deps.fsm.getState(chatKey)?.phase).toBe('processing')
  })
})
