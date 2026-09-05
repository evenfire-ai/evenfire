import { makeTaskKey } from '@contexts/AgentTaskTrackerContext'
import type {
  PendingApprovalLite,
  SessionLifecycleState,
  SessionTokensLite,
} from '../../../../src/types'

/**
 * SessionFSM — pure reducer for the per-chat session lifecycle projection
 * (spec-v2 §4.1). Replaces the ad-hoc `setSessionStateByChatKey` mutations
 * scattered across the god-hook with a single, testable state machine keyed by
 * `chatKey` (`agentRef::chatId`).
 *
 * The reducer is pure: it returns the next state plus a list of *effect
 * descriptors* (notification emission, unread mirror to disk, coordinator
 * release, reconcile scheduling). A thin effects module (the hook) is the only
 * thing that acts on them — the reducer itself performs no I/O.
 *
 * Cardinal rules (each covered by a transition test):
 *  - R1 stale-drop: a `taskId`-bearing stream event whose `taskId` ≠ the chat's
 *    current `activeTaskId` (when one is known) is discarded — a late event from
 *    a superseded task can never mutate the active task's state. Staleness is
 *    keyed on `taskId` alone: the tracker is the single writer per chatKey and
 *    always fires `onTracker*` with the current task's id, so a mismatch means a
 *    superseded/duplicate event. (The former `epoch` guard on these events was
 *    vacuous — no dispatch site ever supplied an epoch — so it was removed.)
 *  - R2 snapshot-never-degrades: a `SERVER_SNAPSHOT` captured before a newer
 *    local `SEND_STARTED` (stale `snapshotEpoch`) is dropped; and an idle/parity
 *    snapshot never downgrades a live in-flight phase (mirrors
 *    `mergeSeededSessionStates`). `epoch` still exists for THIS rule (bumped on
 *    every `SEND_STARTED`, compared against `snapshotEpoch`).
 *  - R3 approval decisions: only `server`/`stream` sources set
 *    `awaiting_approval`; a local `APPROVAL_DECIDED` optimistically moves to
 *    `processing`; a following `APPROVAL_DECISION_FAILED` reverts UNLESS a
 *    later stream/server event already arrived for the task or the requestId no
 *    longer matches (suppression — a decision that reached the server must not
 *    resurrect the gate).
 *  - R4 stream-loss is not terminal: recovery routes through `reconcileChat`,
 *    which flips `syncing` via `RECONCILE_STARTED` and schedules the re-derive.
 *  - R5 teardown: `CHAT_DELETED` removes the entry and emits a
 *    `coordinator_release` effect.
 */

export type SessionPhase = 'idle' | 'sending' | 'processing' | 'awaiting_approval' | 'offline'

export interface SessionFsmState {
  phase: SessionPhase
  activeTaskId?: string
  /** Monotonic per-chatKey; bumped on every `SEND_STARTED`. Drives R1/R2. */
  epoch: number
  pendingApproval?: PendingApprovalLite
  /** True while a reconcile is in flight for this chat (badge). */
  syncing: boolean
  /** Persisted-to-disk badge mirror (GAP-N2). The reducer only flips the flag;
   *  the effect writes it through. */
  unreadTerminal: boolean
  tokens?: SessionTokensLite
  /** Underlying server lifecycle when `phase==='offline'`, so the UI can still
   *  show Running/Awaiting beneath the offline banner. */
  offlineUnderlying?: SessionLifecycleState
  /** R3 bookkeeping — an optimistic local decision awaiting server/stream
   *  confirmation. `superseded` is set once any stream/server event for the task
   *  arrives after the decision. NOT projected to the UI. */
  decision?: { requestId: string; approval?: PendingApprovalLite; superseded: boolean }
  /** GAP-N3 dedupe — the last approval for which a notification was emitted.
   *  NOT projected. */
  notified?: { taskId: string; requestId: string }
}

export const initialSessionFsmState: SessionFsmState = {
  phase: 'idle',
  epoch: 0,
  syncing: false,
  unreadTerminal: false,
}

export type SessionFsmEvent =
  /** Local send began (task id not yet known). Bumps the epoch. */
  | { type: 'SEND_STARTED'; taskId?: string }
  /** The POST returned a task id. */
  | { type: 'TASK_CREATED'; taskId: string }
  | { type: 'STREAM_SUSPENDED'; taskId: string; approval: PendingApprovalLite }
  | { type: 'STREAM_RESUMED'; taskId: string }
  | {
      type: 'STREAM_TERMINAL'
      taskId: string
      status: 'completed' | 'failed' | 'cancelled'
      /** When explicitly `false`, a terminal on a non-visible chat marks unread. */
      chatVisible?: boolean
    }
  | {
      type: 'SERVER_SNAPSHOT'
      state: SessionLifecycleState
      activeTaskId?: string
      pendingApproval?: PendingApprovalLite
      tokens?: SessionTokensLite
      /** The epoch captured when the reconcile fetch STARTED (R2). */
      snapshotEpoch?: number
    }
  | { type: 'APPROVAL_DECIDED'; taskId: string; requestId: string; decision: 'approve' | 'deny' }
  | { type: 'APPROVAL_DECISION_FAILED'; taskId: string; requestId: string }
  | { type: 'RECONCILE_STARTED' }
  | { type: 'RECONCILE_FINISHED' }
  | { type: 'WENT_OFFLINE'; underlying?: SessionLifecycleState }
  | { type: 'BACK_ONLINE' }
  | { type: 'CHAT_OPENED' }
  | { type: 'CHAT_DELETED' }
  | { type: 'RESET' }

export type SessionFsmEffect =
  | { type: 'emit_approval_notification'; taskId: string; requestId: string; displayName: string }
  | { type: 'mark_unread' }
  | { type: 'clear_unread' }
  | { type: 'coordinator_release' }
  | { type: 'schedule_reconcile'; reason: string }

export interface SessionFsmReducerResult {
  /** `null` means the entry is torn down (removed from the store map). */
  state: SessionFsmState | null
  effects: SessionFsmEffect[]
}

function mapServerStateToPhase(state: SessionLifecycleState): SessionPhase {
  switch (state) {
    case 'processing':
      return 'processing'
    case 'awaiting_approval':
      return 'awaiting_approval'
    default:
      return 'idle'
  }
}

function mapPhaseToServerState(phase: SessionPhase): SessionLifecycleState {
  switch (phase) {
    case 'processing':
    case 'sending':
      return 'processing'
    case 'awaiting_approval':
      return 'awaiting_approval'
    default:
      return 'idle'
  }
}

/**
 * R1: a taskId-bearing stream event for a task that is NOT the chat's current
 * `activeTaskId` cannot mutate the active task's projection, so it is dropped.
 * Guarded on a KNOWN active task: when `activeTaskId` is undefined (no live task
 * recorded yet — e.g. a badge freshly seeding before its `activeTaskId` lands) a
 * live event is processed rather than dropped, so only a genuine cross-task
 * mismatch is ever discarded. A matching taskId is never stale (a live task's own
 * SSE may lag after a reconnect). Staleness is keyed on taskId alone — the tracker
 * (single writer per chatKey) always fires `onTracker*` with the current task's
 * id, so a mismatch is a superseded/duplicate event.
 */
function isStale(state: SessionFsmState, taskId: string | undefined): boolean {
  if (!taskId || !state.activeTaskId) return false
  return taskId !== state.activeTaskId
}

/** Mark a pending optimistic decision as superseded by a real stream/server event. */
function markDecisionSuperseded(
  decision: SessionFsmState['decision']
): SessionFsmState['decision'] {
  if (!decision) return undefined
  return { ...decision, superseded: true }
}

export function sessionFsmReducer(
  state: SessionFsmState,
  event: SessionFsmEvent
): SessionFsmReducerResult {
  switch (event.type) {
    case 'SEND_STARTED':
      return {
        state: {
          ...state,
          phase: 'sending',
          // Bumps the R2 epoch (compared against SERVER_SNAPSHOT's snapshotEpoch).
          epoch: state.epoch + 1,
          // Adopt the new task id (the POST already returned it in prod): R1 then
          // drops a late terminal for the PREVIOUS task, since its taskId no longer
          // matches this `activeTaskId`, instead of downgrading this fresh send.
          activeTaskId: event.taskId,
          pendingApproval: undefined,
          syncing: false,
          offlineUnderlying: undefined,
          decision: undefined,
          notified: undefined,
        },
        effects: [],
      }

    case 'TASK_CREATED':
      return {
        state: {
          ...state,
          phase: 'processing',
          activeTaskId: event.taskId,
          pendingApproval: undefined,
          syncing: false,
        },
        effects: [],
      }

    case 'STREAM_SUSPENDED': {
      if (isStale(state, event.taskId)) return { state, effects: [] }
      const effects: SessionFsmEffect[] = []
      const alreadyNotified =
        state.notified?.taskId === event.taskId &&
        state.notified?.requestId === event.approval.requestId
      const next: SessionFsmState = {
        ...state,
        phase: 'awaiting_approval',
        activeTaskId: event.taskId,
        pendingApproval: event.approval,
        syncing: false,
        offlineUnderlying: undefined,
        decision: markDecisionSuperseded(state.decision),
      }
      // GAP-N3: notify only on a genuine stream-driven transition, deduped by
      // (taskId, requestId). A sticky re-emit or a repeat suspended is swallowed.
      // U5: a `connect_required` suspension is NOT a tool approval — emitting the
      // generic "approve" notification would let its decide-action resume the task
      // WITHOUT a grant (401 → re-suspend loop). The in-chat "Connect <server>"
      // prompt is its surface; the badge still flips to awaiting_approval below,
      // and the connect completion resumes it via the same approval RPC.
      const isConnectRequired = event.approval.reason === 'connect_required'
      if (!alreadyNotified && !isConnectRequired) {
        effects.push({
          type: 'emit_approval_notification',
          taskId: event.taskId,
          requestId: event.approval.requestId,
          displayName: event.approval.displayName,
        })
        next.notified = { taskId: event.taskId, requestId: event.approval.requestId }
      }
      return { state: next, effects }
    }

    case 'STREAM_RESUMED': {
      if (isStale(state, event.taskId)) return { state, effects: [] }
      return {
        state: {
          ...state,
          phase: 'processing',
          activeTaskId: event.taskId,
          pendingApproval: undefined,
          syncing: false,
          decision: markDecisionSuperseded(state.decision),
        },
        effects: [],
      }
    }

    case 'STREAM_TERMINAL': {
      if (isStale(state, event.taskId)) return { state, effects: [] }
      const effects: SessionFsmEffect[] = []
      const next: SessionFsmState = {
        ...state,
        phase: 'idle',
        activeTaskId: undefined,
        pendingApproval: undefined,
        syncing: false,
        offlineUnderlying: undefined,
        decision: undefined,
        notified: undefined,
      }
      if (event.status !== 'cancelled' && event.chatVisible === false) {
        if (!state.unreadTerminal) effects.push({ type: 'mark_unread' })
        next.unreadTerminal = true
      }
      return { state: next, effects }
    }

    case 'SERVER_SNAPSHOT': {
      // R2: a snapshot captured before a newer local send must not win.
      if (event.snapshotEpoch != null && event.snapshotEpoch < state.epoch) {
        return { state: state.syncing ? { ...state, syncing: false } : state, effects: [] }
      }
      const snapLive = event.state === 'processing' || event.state === 'awaiting_approval'
      const liveInFlight =
        state.phase === 'processing' ||
        state.phase === 'sending' ||
        state.phase === 'awaiting_approval'
      // Parity with mergeSeededSessionStates: an idle/parity snapshot never
      // downgrades a live in-flight phase (the snapshot may predate the send).
      if (liveInFlight && !snapLive) {
        return { state: state.syncing ? { ...state, syncing: false } : state, effects: [] }
      }
      const next: SessionFsmState = {
        ...state,
        phase: mapServerStateToPhase(event.state),
        activeTaskId: event.activeTaskId,
        pendingApproval: event.state === 'awaiting_approval' ? event.pendingApproval : undefined,
        tokens: event.tokens ?? state.tokens,
        syncing: false,
        offlineUnderlying: undefined,
        decision: markDecisionSuperseded(state.decision),
      }
      // A snapshot pendingApproval seeds the badge and pre-arms dedupe so a later
      // live STREAM_SUSPENDED for the same request does NOT re-notify — but the
      // snapshot itself never emits a notification.
      if (event.state === 'awaiting_approval' && event.pendingApproval && event.activeTaskId) {
        next.notified = { taskId: event.activeTaskId, requestId: event.pendingApproval.requestId }
      }
      return { state: next, effects: [] }
    }

    case 'APPROVAL_DECIDED': {
      // R3: optimistic move to processing (badge flips immediately, no live
      // stream required). Reconcile confirms convergence.
      return {
        state: {
          ...state,
          phase: 'processing',
          activeTaskId: event.taskId,
          pendingApproval: undefined,
          decision: {
            requestId: event.requestId,
            approval: state.pendingApproval,
            superseded: false,
          },
        },
        effects: [{ type: 'schedule_reconcile', reason: 'approval_decided' }],
      }
    }

    case 'APPROVAL_DECISION_FAILED': {
      // 5(b): reconcile ALWAYS — convergence can't depend on a live stream.
      const reconcile: SessionFsmEffect = {
        type: 'schedule_reconcile',
        reason: 'approval_decision_failed',
      }
      const d = state.decision
      if (!d || d.requestId !== event.requestId) {
        // The requestId no longer matches (a newer approval took over) → suppress.
        return { state, effects: [reconcile] }
      }
      if (d.superseded) {
        // A stream/server event already advanced the task → suppress the revert,
        // clear the bookkeeping (an approve that reached the server must not
        // resurrect the gate).
        return { state: { ...state, decision: undefined }, effects: [reconcile] }
      }
      return {
        state: {
          ...state,
          phase: 'awaiting_approval',
          pendingApproval: d.approval,
          decision: undefined,
        },
        effects: [reconcile],
      }
    }

    case 'RECONCILE_STARTED':
      return { state: state.syncing ? state : { ...state, syncing: true }, effects: [] }

    case 'RECONCILE_FINISHED':
      return { state: state.syncing ? { ...state, syncing: false } : state, effects: [] }

    case 'WENT_OFFLINE':
      return {
        state: {
          ...state,
          phase: 'offline',
          syncing: false,
          // A repeated WENT_OFFLINE (reconcileChat re-dispatches it, without
          // `underlying`, on every network error) must NOT degrade the badge: when
          // already offline, `mapPhaseToServerState('offline')` would return 'idle'
          // and clobber a preserved 'processing'/'awaiting_approval'. Keep the
          // existing `offlineUnderlying` in that case; a caller-supplied one wins.
          offlineUnderlying:
            event.underlying ??
            (state.phase === 'offline'
              ? state.offlineUnderlying
              : mapPhaseToServerState(state.phase)),
        },
        effects: [],
      }

    case 'BACK_ONLINE':
      return {
        state: {
          ...state,
          phase: state.offlineUnderlying
            ? mapServerStateToPhase(state.offlineUnderlying)
            : state.phase === 'offline'
              ? 'idle'
              : state.phase,
          offlineUnderlying: undefined,
          syncing: true,
        },
        effects: [{ type: 'schedule_reconcile', reason: 'back_online' }],
      }

    case 'CHAT_OPENED': {
      if (!state.unreadTerminal) return { state, effects: [] }
      return { state: { ...state, unreadTerminal: false }, effects: [{ type: 'clear_unread' }] }
    }

    case 'CHAT_DELETED':
      // R5: teardown emits the coordinator release as an effect.
      return { state: null, effects: [{ type: 'coordinator_release' }] }

    case 'RESET':
      return { state: null, effects: [] }

    default: {
      // Exhaustiveness guard — every event variant is handled above.
      const _exhaustive: never = event
      void _exhaustive
      return { state, effects: [] }
    }
  }
}

/**
 * Public UI projection — the `SessionStateLite` shape the sidebar/header read
 * today. Keeping the projection here lets the god-hook derive
 * `sessionStateByChatKey` from the FSM without changing its public contract.
 */
export interface SessionStateProjection {
  state: SessionLifecycleState
  activeTaskId?: string
  pendingApproval?: PendingApprovalLite
  syncing: boolean
  offlineMode?: boolean
  tokens?: SessionTokensLite
}

export function projectSessionState(fsm: SessionFsmState): SessionStateProjection {
  const underlying =
    fsm.phase === 'offline' ? (fsm.offlineUnderlying ?? 'idle') : mapPhaseToServerState(fsm.phase)
  return {
    state: underlying,
    activeTaskId: fsm.activeTaskId,
    pendingApproval: fsm.phase === 'awaiting_approval' ? fsm.pendingApproval : undefined,
    syncing: fsm.syncing,
    ...(fsm.phase === 'offline' ? { offlineMode: true } : {}),
    ...(fsm.tokens ? { tokens: fsm.tokens } : {}),
  }
}

/**
 * Minimal external store (spec §8-P1: reducer + `useSyncExternalStore`, no new
 * libs). Holds the per-chatKey map, applies the reducer, and returns the effects
 * to the caller (the effects module) to run. `getSnapshot` returns a stable map
 * reference so React only re-renders on an actual change.
 */
export interface SessionFsmStore {
  dispatch(chatKey: string, event: SessionFsmEvent): SessionFsmEffect[]
  getState(chatKey: string): SessionFsmState | undefined
  getSnapshot(): Record<string, SessionFsmState>
  subscribe(listener: () => void): () => void
  reset(): void
}

/**
 * The session-summary shape from `listSessions().items[number]` — the subset of
 * fields the badge projection seeds from.
 */
export interface SeedSessionSummary {
  chatId: string
  state?: SessionLifecycleState
  activeTaskId?: string
  pendingApproval?: PendingApprovalLite
  tokens?: SessionTokensLite
}

/**
 * Seed the per-chat badge projection for one agent's server sessions by
 * dispatching a `SERVER_SNAPSHOT` per chat. Shared by the two sidebar loaders
 * (useChatListController cross-agent + useAgentChatController per-agent); D4 /
 * §4.1 R2 owns "a snapshot never degrades a live task". SERVER_SNAPSHOT emits no
 * effects, so a bare dispatch is safe.
 */
export function seedSessionSnapshots(
  fsm: SessionFsmStore,
  agentRef: string,
  sessions: readonly SeedSessionSummary[]
): void {
  for (const session of sessions) {
    fsm.dispatch(makeTaskKey(agentRef, session.chatId), {
      type: 'SERVER_SNAPSHOT',
      state: session.state ?? 'idle',
      activeTaskId: session.activeTaskId,
      pendingApproval: session.pendingApproval,
      tokens: session.tokens,
    })
  }
}

export function createSessionFsmStore(): SessionFsmStore {
  let map: Record<string, SessionFsmState> = {}
  const listeners = new Set<() => void>()

  const notify = () => {
    for (const listener of listeners) listener()
  }

  return {
    dispatch(chatKey, event) {
      const prev = map[chatKey] ?? initialSessionFsmState
      const { state, effects } = sessionFsmReducer(prev, event)
      if (state === null) {
        if (chatKey in map) {
          const { [chatKey]: _removed, ...rest } = map
          map = rest
          notify()
        }
        return effects
      }
      if (state !== prev) {
        map = { ...map, [chatKey]: state }
        notify()
      }
      return effects
    },
    getState(chatKey) {
      return map[chatKey]
    },
    getSnapshot() {
      return map
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    reset() {
      if (Object.keys(map).length === 0) return
      map = {}
      notify()
    },
  }
}
