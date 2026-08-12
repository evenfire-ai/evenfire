import { makeTaskKey, parseTaskKey } from '@contexts/AgentTaskTrackerContext'
import type { ApprovalDecisionResult } from '../../../../src/types'
import type { SessionFsmState, SessionFsmStore } from './sessionFsm'

/**
 * Central approval-decision logic (spec-v2 §4.7.4). All four decision surfaces
 * (desktop-notification action, in-app bell, in-chat gate, in-flight
 * placeholder) funnel through `decideApproval` so the badge converges the same
 * way from every entry point — closing V8/GAP-N1 (a decision made without a
 * live stream used to leave the sidebar badge stale).
 *
 * The function is dependency-injected (no direct `window.clerum`/React access)
 * so it is exhaustively unit-testable against a real `createSessionFsmStore()`.
 */

/**
 * mcp-host returns HTTP 200 with `{success:false, error}` for an already-decided
 * request. These are the two known messages (`stateMachine.ts:820-828`); matched
 * conservatively — any OTHER `success:false` is treated as a genuine failure
 * (default-conservative per §4.7.4; N6 would replace this with a structured code).
 */
export const APPROVAL_ALREADY_DECIDED_MARKERS = [
  'No pending approval for request',
  'Task is no longer awaiting approval',
] as const

export type ApprovalOutcome = 'ok' | 'already_decided' | 'failed'

/** Classify a settled approve/deny result. A thrown error (network / non-ok
 *  HTTP) is mapped to `'failed'` by the caller's catch. A nullish result is
 *  treated as success (back-compat: a void RPC that resolved without a body). */
export function classifyApprovalResult(
  result: ApprovalDecisionResult | null | undefined
): ApprovalOutcome {
  if (!result || result.success) return 'ok'
  const error = result.error ?? ''
  if (APPROVAL_ALREADY_DECIDED_MARKERS.some(marker => error.includes(marker))) {
    return 'already_decided'
  }
  return 'failed'
}

export interface ApprovalDecisionTarget {
  /** hostRef ≡ agent (V1/R4). */
  agentRef: string
  chatId: string
  /** Present on surfaces that decide cross-team (notification/bell); the main
   *  process mints the RPC token for this team with it. */
  teamId?: string | null
  taskId: string
  requestId: string
  decision: 'approve' | 'deny'
  // `connect_completed` (U5): the OAuth deep-link returned for an mcp-server;
  // the suspended task is resumed through the SAME approval RPC (mcp-host
  // re-executes the tool with the freshly-minted grant). Always an approve.
  source: 'desktop_notification' | 'inapp_bell' | 'in_chat' | 'placeholder' | 'connect_completed'
}

/**
 * U5 (mcp-oauth reactive consent) — deep-link correlation.
 *
 * Given the FSM snapshot and the `mcpServerName` carried on the OAuth
 * `oauth-completed?source=mcp` deep link, return the resume target for EVERY
 * conversation currently suspended on that server. Correlating by `mcpServerName`
 * (not client_id) is robust to 2+ concurrent suspensions:
 *   - suspensions on OTHER servers do not match and are left untouched;
 *   - a per-user grant is global to the user, so once the connect completes,
 *     every conversation waiting on that server can resume — this returns them all;
 *   - it reads only the FSM snapshot (the single source of truth already used by
 *     resume/reconcile), so no ephemeral client_id→conversation map is needed and
 *     it survives an app restart (the durable suspension re-seeds the snapshot).
 *
 * Pure and total: unit-testable without React. Always yields `decision:'approve'`
 * — a connect completion only ever resumes.
 */
export function resolveConnectResumeTargets(
  snapshot: Record<string, SessionFsmState>,
  mcpServerName: string
): ApprovalDecisionTarget[] {
  const server = String(mcpServerName || '').trim()
  if (!server) return []
  const targets: ApprovalDecisionTarget[] = []
  for (const [chatKey, entry] of Object.entries(snapshot)) {
    const approval = entry.pendingApproval
    if (
      entry.phase !== 'awaiting_approval' ||
      !approval ||
      approval.reason !== 'connect_required' ||
      approval.mcpServerName !== server ||
      !entry.activeTaskId
    ) {
      continue
    }
    const { agentRef, chatId } = parseTaskKey(chatKey)
    targets.push({
      agentRef,
      chatId,
      taskId: entry.activeTaskId,
      requestId: approval.requestId,
      decision: 'approve',
      source: 'connect_completed',
    })
  }
  return targets
}

export interface DecideApprovalDeps {
  fsm: SessionFsmStore
  approve: (target: ApprovalDecisionTarget) => Promise<ApprovalDecisionResult>
  deny: (target: ApprovalDecisionTarget) => Promise<ApprovalDecisionResult>
  /** Unified `reconcileChat` gate (§4.3). Re-derives server truth for the chat;
   *  `taskId` lets the idle branch fall back to the durable `getTaskResult`
   *  (GAP-H1) when the decision produced no session turn (deny pre-executor). */
  reconcile: (chatKey: string, reason: string, taskId?: string) => void
  resolveApprovalNotification: (args: {
    agentName: string
    taskId: string
    requestId: string
    state: 'approved' | 'denied'
  }) => void
  pushToast: (message: string, tone: 'success' | 'error' | 'info') => void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The five ordered steps of §4.7.4. The order is part of the contract.
 */
export async function decideApproval(
  deps: DecideApprovalDeps,
  target: ApprovalDecisionTarget
): Promise<void> {
  const chatKey = makeTaskKey(target.agentRef, target.chatId)
  const entry = deps.fsm.getState(chatKey)
  const hasEntry = !!entry
  const resolvedState: 'approved' | 'denied' = target.decision === 'approve' ? 'approved' : 'denied'
  const verb = target.decision === 'approve' ? 'Approved' : 'Denied'

  // Step 1 — double-decision guard. Skipped when the chatKey has NO entry (bell
  // deciding a chat never loaded / another team after RESET): the server is
  // idempotent, so blocking would be a false negative.
  if (hasEntry) {
    const awaitingThis =
      entry!.phase === 'awaiting_approval' && entry!.pendingApproval?.requestId === target.requestId
    if (!awaitingThis) {
      deps.pushToast('That request was already handled.', 'info')
      return
    }
    // Step 2 — optimistic dispatch: badge flips to Running immediately.
    deps.fsm.dispatch(chatKey, {
      type: 'APPROVAL_DECIDED',
      taskId: target.taskId,
      requestId: target.requestId,
      decision: target.decision,
    })
  }

  // Step 3 — RPC (teamId carried by the surface; retry-after-refresh is Fase 4).
  let result: ApprovalDecisionResult
  try {
    result = target.decision === 'approve' ? await deps.approve(target) : await deps.deny(target)
  } catch (error) {
    // Network / non-ok HTTP → genuine failure (5b): revert with suppression +
    // ALWAYS reconcile (convergence can't depend on a live stream).
    if (hasEntry) {
      deps.fsm.dispatch(chatKey, {
        type: 'APPROVAL_DECISION_FAILED',
        taskId: target.taskId,
        requestId: target.requestId,
      })
    }
    deps.reconcile(chatKey, 'approval_decision_failed', target.taskId)
    deps.pushToast(`Failed to ${target.decision} request: ${errorMessage(error)}`, 'error')
    return
  }

  const outcome = classifyApprovalResult(result)

  // Step 4 — success. Convergence after an approve arrives via STREAM_RESUMED or
  // the reconcile R3 schedules (spec §4.7.4 step 4 / R3): honour that scheduled
  // reconcile through the same single-flight gate so the badge converges even
  // without a live stream (parity with the already_decided / failure paths).
  if (outcome === 'ok') {
    deps.resolveApprovalNotification({
      agentName: target.agentRef,
      taskId: target.taskId,
      requestId: target.requestId,
      state: resolvedState,
    })
    deps.reconcile(chatKey, 'approval_decided', target.taskId)
    deps.pushToast(`${verb} request for ${target.agentRef}.`, 'success')
    return
  }

  // Step 5a — already decided by another channel: converge, no revert.
  if (outcome === 'already_decided') {
    deps.resolveApprovalNotification({
      agentName: target.agentRef,
      taskId: target.taskId,
      requestId: target.requestId,
      state: resolvedState,
    })
    deps.pushToast('That request was already decided.', 'info')
    deps.reconcile(chatKey, 'approval_conflict', target.taskId)
    return
  }

  // Step 5b — genuine `success:false` failure: revert (suppression in reducer) +
  // ALWAYS reconcile.
  if (hasEntry) {
    deps.fsm.dispatch(chatKey, {
      type: 'APPROVAL_DECISION_FAILED',
      taskId: target.taskId,
      requestId: target.requestId,
    })
  }
  deps.reconcile(chatKey, 'approval_decision_failed', target.taskId)
  deps.pushToast(
    `Failed to ${target.decision} request: ${result.error ?? 'unknown error'}`,
    'error'
  )
}
