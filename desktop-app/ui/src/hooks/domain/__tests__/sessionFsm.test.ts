import { describe, expect, it } from 'vitest'
import {
  type SessionFsmState,
  createSessionFsmStore,
  initialSessionFsmState,
  projectSessionState,
  sessionFsmReducer,
} from '../sessionFsm'

const approval = { requestId: 'req-1', displayName: 'shell.exec' }

function stateWith(partial: Partial<SessionFsmState>): SessionFsmState {
  return { ...initialSessionFsmState, ...partial }
}

describe('sessionFsmReducer — send / task lifecycle', () => {
  it('SEND_STARTED moves to sending and bumps the epoch', () => {
    const { state } = sessionFsmReducer(initialSessionFsmState, { type: 'SEND_STARTED' })
    expect(state).toMatchObject({ phase: 'sending', epoch: 1 })
  })

  it('TASK_CREATED records the active task and moves to processing', () => {
    const { state } = sessionFsmReducer(stateWith({ phase: 'sending', epoch: 1 }), {
      type: 'TASK_CREATED',
      taskId: 't1',
    })
    expect(state).toMatchObject({ phase: 'processing', activeTaskId: 't1' })
  })

  it('SEND_STARTED clears prior approval / decision / notified bookkeeping', () => {
    const prev = stateWith({
      phase: 'awaiting_approval',
      activeTaskId: 't0',
      pendingApproval: approval,
      decision: { requestId: 'req-1', superseded: false },
      notified: { taskId: 't0', requestId: 'req-1' },
    })
    const { state } = sessionFsmReducer(prev, { type: 'SEND_STARTED', taskId: 't1' })
    expect(state).toMatchObject({ phase: 'sending', activeTaskId: 't1', epoch: 1 })
    expect(state?.pendingApproval).toBeUndefined()
    expect(state?.decision).toBeUndefined()
    expect(state?.notified).toBeUndefined()
  })
})

describe('sessionFsmReducer — R1 stale-drop (taskId-keyed)', () => {
  it('drops a stream terminal for a task that is not the active task', () => {
    const prev = stateWith({ phase: 'processing', activeTaskId: 't2' })
    const { state } = sessionFsmReducer(prev, {
      type: 'STREAM_TERMINAL',
      taskId: 't1',
      status: 'completed',
    })
    expect(state).toBe(prev)
  })

  it('does NOT drop a terminal for the active task', () => {
    const prev = stateWith({ phase: 'processing', activeTaskId: 't1' })
    const { state } = sessionFsmReducer(prev, {
      type: 'STREAM_TERMINAL',
      taskId: 't1',
      status: 'completed',
    })
    expect(state).toMatchObject({ phase: 'idle', activeTaskId: undefined })
  })

  it('drops a late terminal for the previous task after a new SEND_STARTED took over', () => {
    // Prod path: a new send POSTs, learns task t2, and dispatches SEND_STARTED with
    // that id, so `activeTaskId` becomes t2. A late STREAM_TERMINAL for the previous
    // task t1 must NOT flip the fresh `sending` back to idle. (Regression: with the
    // former vacuous `epoch` guard this terminal was PROCESSED and downgraded the send.)
    const running = sessionFsmReducer(
      stateWith({ phase: 'processing', activeTaskId: 't1', epoch: 1 }),
      { type: 'SEND_STARTED', taskId: 't2' }
    )
    expect(running.state).toMatchObject({ phase: 'sending', epoch: 2, activeTaskId: 't2' })
    const { state } = sessionFsmReducer(running.state!, {
      type: 'STREAM_TERMINAL',
      taskId: 't1',
      status: 'completed',
    })
    expect(state?.phase).toBe('sending')
    expect(state?.activeTaskId).toBe('t2')
  })

  it('does NOT drop a live event when no active task is recorded yet (badge seeding)', () => {
    // activeTaskId undefined → a live event (e.g. a rejoin that streams a resumed
    // before its SERVER_SNAPSHOT landed) is processed, never dropped.
    const prev = stateWith({ phase: 'processing', activeTaskId: undefined })
    const { state } = sessionFsmReducer(prev, { type: 'STREAM_RESUMED', taskId: 't1' })
    expect(state).toMatchObject({ phase: 'processing', activeTaskId: 't1' })
  })
})

describe('sessionFsmReducer — R2 SERVER_SNAPSHOT', () => {
  it('drops a snapshot captured before a newer local send (stale snapshotEpoch)', () => {
    const prev = stateWith({ phase: 'processing', activeTaskId: 't1', epoch: 4 })
    const { state } = sessionFsmReducer(prev, {
      type: 'SERVER_SNAPSHOT',
      state: 'idle',
      snapshotEpoch: 2,
    })
    expect(state).toMatchObject({ phase: 'processing', activeTaskId: 't1' })
  })

  it('an idle snapshot never downgrades a live processing phase', () => {
    const prev = stateWith({ phase: 'processing', activeTaskId: 't1', epoch: 1 })
    const { state } = sessionFsmReducer(prev, { type: 'SERVER_SNAPSHOT', state: 'idle' })
    expect(state?.phase).toBe('processing')
  })

  it('an idle snapshot settles an idle phase and adopts tokens', () => {
    const prev = stateWith({ phase: 'idle', syncing: true })
    const { state } = sessionFsmReducer(prev, {
      type: 'SERVER_SNAPSHOT',
      state: 'idle',
      tokens: { inputTokens: 10, outputTokens: 5 } as never,
    })
    expect(state).toMatchObject({ phase: 'idle', syncing: false })
    expect(state?.tokens).toBeDefined()
  })

  it('an awaiting_approval snapshot seeds the badge WITHOUT emitting a notification', () => {
    const prev = stateWith({ phase: 'idle' })
    const { state, effects } = sessionFsmReducer(prev, {
      type: 'SERVER_SNAPSHOT',
      state: 'awaiting_approval',
      activeTaskId: 't1',
      pendingApproval: approval,
    })
    expect(state).toMatchObject({ phase: 'awaiting_approval', activeTaskId: 't1' })
    expect(state?.pendingApproval).toEqual(approval)
    expect(effects).toEqual([])
    // Pre-arms dedupe so a later live STREAM_SUSPENDED for the same request stays quiet.
    expect(state?.notified).toEqual({ taskId: 't1', requestId: 'req-1' })
  })

  it('a processing snapshot overrides a live awaiting_approval (server is authoritative)', () => {
    const prev = stateWith({
      phase: 'awaiting_approval',
      activeTaskId: 't1',
      pendingApproval: approval,
    })
    const { state } = sessionFsmReducer(prev, {
      type: 'SERVER_SNAPSHOT',
      state: 'processing',
      activeTaskId: 't1',
    })
    expect(state).toMatchObject({ phase: 'processing' })
    expect(state?.pendingApproval).toBeUndefined()
  })
})

describe('sessionFsmReducer — R3 approval notifications (GAP-N3 dedupe)', () => {
  it('STREAM_SUSPENDED emits an approval notification on first suspend', () => {
    const { state, effects } = sessionFsmReducer(
      stateWith({ phase: 'processing', activeTaskId: 't1' }),
      {
        type: 'STREAM_SUSPENDED',
        taskId: 't1',
        approval,
      }
    )
    expect(state).toMatchObject({ phase: 'awaiting_approval', pendingApproval: approval })
    expect(effects).toEqual([
      {
        type: 'emit_approval_notification',
        taskId: 't1',
        requestId: 'req-1',
        displayName: 'shell.exec',
      },
    ])
  })

  it('a repeat STREAM_SUSPENDED for the same (taskId, requestId) does NOT re-notify', () => {
    const first = sessionFsmReducer(stateWith({ phase: 'processing', activeTaskId: 't1' }), {
      type: 'STREAM_SUSPENDED',
      taskId: 't1',
      approval,
    })
    const { effects } = sessionFsmReducer(first.state!, {
      type: 'STREAM_SUSPENDED',
      taskId: 't1',
      approval,
    })
    expect(effects).toEqual([])
  })

  it('a snapshot-seeded badge suppresses the subsequent live suspend notification', () => {
    const seeded = sessionFsmReducer(stateWith({ phase: 'idle' }), {
      type: 'SERVER_SNAPSHOT',
      state: 'awaiting_approval',
      activeTaskId: 't1',
      pendingApproval: approval,
    })
    const { effects } = sessionFsmReducer(seeded.state!, {
      type: 'STREAM_SUSPENDED',
      taskId: 't1',
      approval,
    })
    expect(effects).toEqual([])
  })
})

describe('sessionFsmReducer — R3 decision optimism / revert / suppression', () => {
  it('APPROVAL_DECIDED optimistically moves awaiting_approval → processing and schedules reconcile', () => {
    const prev = stateWith({
      phase: 'awaiting_approval',
      activeTaskId: 't1',
      pendingApproval: approval,
    })
    const { state, effects } = sessionFsmReducer(prev, {
      type: 'APPROVAL_DECIDED',
      taskId: 't1',
      requestId: 'req-1',
      decision: 'approve',
    })
    expect(state).toMatchObject({ phase: 'processing', activeTaskId: 't1' })
    expect(state?.pendingApproval).toBeUndefined()
    expect(state?.decision).toEqual({ requestId: 'req-1', approval, superseded: false })
    expect(effects).toEqual([{ type: 'schedule_reconcile', reason: 'approval_decided' }])
  })

  it('APPROVAL_DECISION_FAILED reverts to awaiting_approval when nothing superseded it', () => {
    const decided = sessionFsmReducer(
      stateWith({ phase: 'awaiting_approval', activeTaskId: 't1', pendingApproval: approval }),
      { type: 'APPROVAL_DECIDED', taskId: 't1', requestId: 'req-1', decision: 'approve' }
    )
    const { state, effects } = sessionFsmReducer(decided.state!, {
      type: 'APPROVAL_DECISION_FAILED',
      taskId: 't1',
      requestId: 'req-1',
    })
    expect(state).toMatchObject({ phase: 'awaiting_approval', pendingApproval: approval })
    expect(state?.decision).toBeUndefined()
    // 5(b): reconcile ALWAYS on failure.
    expect(effects).toEqual([{ type: 'schedule_reconcile', reason: 'approval_decision_failed' }])
  })

  it('SUPPRESSES the revert when a stream event advanced the task after the decision', () => {
    const decided = sessionFsmReducer(
      stateWith({ phase: 'awaiting_approval', activeTaskId: 't1', pendingApproval: approval }),
      { type: 'APPROVAL_DECIDED', taskId: 't1', requestId: 'req-1', decision: 'approve' }
    )
    // The approve DID reach the server: a resume streams in before the client's failure.
    const resumed = sessionFsmReducer(decided.state!, { type: 'STREAM_RESUMED', taskId: 't1' })
    const { state, effects } = sessionFsmReducer(resumed.state!, {
      type: 'APPROVAL_DECISION_FAILED',
      taskId: 't1',
      requestId: 'req-1',
    })
    expect(state?.phase).toBe('processing')
    expect(state?.decision).toBeUndefined()
    expect(effects).toEqual([{ type: 'schedule_reconcile', reason: 'approval_decision_failed' }])
  })

  it('SUPPRESSES the revert when the requestId no longer matches', () => {
    const decided = sessionFsmReducer(
      stateWith({ phase: 'awaiting_approval', activeTaskId: 't1', pendingApproval: approval }),
      { type: 'APPROVAL_DECIDED', taskId: 't1', requestId: 'req-1', decision: 'approve' }
    )
    const { state } = sessionFsmReducer(decided.state!, {
      type: 'APPROVAL_DECISION_FAILED',
      taskId: 't1',
      requestId: 'req-OTHER',
    })
    expect(state?.phase).toBe('processing')
  })
})

describe('sessionFsmReducer — R4 offline', () => {
  it('WENT_OFFLINE / BACK_ONLINE preserves and restores the underlying phase', () => {
    const off = sessionFsmReducer(stateWith({ phase: 'processing', activeTaskId: 't1' }), {
      type: 'WENT_OFFLINE',
    })
    expect(off.state).toMatchObject({ phase: 'offline', offlineUnderlying: 'processing' })
    expect(projectSessionState(off.state!)).toMatchObject({
      state: 'processing',
      offlineMode: true,
    })
    const back = sessionFsmReducer(off.state!, { type: 'BACK_ONLINE' })
    expect(back.state).toMatchObject({ phase: 'processing', syncing: true })
  })

  it('a repeated WENT_OFFLINE (no underlying) does NOT degrade the preserved sub-state', () => {
    // reconcileChat re-dispatches WENT_OFFLINE without `underlying` on every network
    // error. The second one, while already offline, must keep 'processing' — not
    // clobber it with 'idle' from mapPhaseToServerState('offline'). (Regression H4.)
    const first = sessionFsmReducer(stateWith({ phase: 'processing', activeTaskId: 't1' }), {
      type: 'WENT_OFFLINE',
    })
    expect(first.state).toMatchObject({ phase: 'offline', offlineUnderlying: 'processing' })
    const second = sessionFsmReducer(first.state!, { type: 'WENT_OFFLINE' })
    expect(second.state).toMatchObject({ phase: 'offline', offlineUnderlying: 'processing' })
    expect(projectSessionState(second.state!)).toMatchObject({ state: 'processing' })
  })

  it('WENT_OFFLINE with an explicit underlying still overrides while offline', () => {
    const first = sessionFsmReducer(stateWith({ phase: 'processing', activeTaskId: 't1' }), {
      type: 'WENT_OFFLINE',
    })
    const second = sessionFsmReducer(first.state!, {
      type: 'WENT_OFFLINE',
      underlying: 'awaiting_approval',
    })
    expect(second.state?.offlineUnderlying).toBe('awaiting_approval')
  })
})

describe('sessionFsmReducer — unread mirror (GAP-N2) & teardown (R5)', () => {
  it('STREAM_TERMINAL on a non-visible chat marks unread once', () => {
    const first = sessionFsmReducer(stateWith({ phase: 'processing', activeTaskId: 't1' }), {
      type: 'STREAM_TERMINAL',
      taskId: 't1',
      status: 'completed',
      chatVisible: false,
    })
    expect(first.state?.unreadTerminal).toBe(true)
    expect(first.effects).toEqual([{ type: 'mark_unread' }])
  })

  it('STREAM_TERMINAL on a cancelled task never marks unread', () => {
    const { state, effects } = sessionFsmReducer(
      stateWith({ phase: 'processing', activeTaskId: 't1' }),
      {
        type: 'STREAM_TERMINAL',
        taskId: 't1',
        status: 'cancelled',
        chatVisible: false,
      }
    )
    expect(state?.unreadTerminal).toBe(false)
    expect(effects).toEqual([])
  })

  it('CHAT_OPENED clears unread and mirrors the clear to disk', () => {
    const { state, effects } = sessionFsmReducer(stateWith({ unreadTerminal: true }), {
      type: 'CHAT_OPENED',
    })
    expect(state?.unreadTerminal).toBe(false)
    expect(effects).toEqual([{ type: 'clear_unread' }])
  })

  it('CHAT_DELETED tears down the entry and releases the coordinator', () => {
    const { state, effects } = sessionFsmReducer(stateWith({ phase: 'processing' }), {
      type: 'CHAT_DELETED',
    })
    expect(state).toBeNull()
    expect(effects).toEqual([{ type: 'coordinator_release' }])
  })
})

describe('createSessionFsmStore', () => {
  it('applies events per key, notifies subscribers, and returns effects', () => {
    const store = createSessionFsmStore()
    let notified = 0
    store.subscribe(() => {
      notified += 1
    })
    store.dispatch('a::c1', { type: 'SEND_STARTED' })
    expect(store.getState('a::c1')).toMatchObject({ phase: 'sending', epoch: 1 })
    const effects = store.dispatch('a::c1', {
      type: 'STREAM_SUSPENDED',
      taskId: 't1',
      approval,
    })
    expect(effects[0]?.type).toBe('emit_approval_notification')
    expect(notified).toBe(2)
  })

  it('removes the key on CHAT_DELETED and keeps a stable snapshot when unchanged', () => {
    const store = createSessionFsmStore()
    store.dispatch('a::c1', { type: 'SEND_STARTED' })
    const before = store.getSnapshot()
    // A no-op dispatch (stale drop) must not replace the snapshot reference.
    store.dispatch('a::c1', {
      type: 'SERVER_SNAPSHOT',
      state: 'idle',
      snapshotEpoch: -1,
    })
    expect(store.getSnapshot()).toBe(before)
    store.dispatch('a::c1', { type: 'CHAT_DELETED' })
    expect(store.getState('a::c1')).toBeUndefined()
  })
})
