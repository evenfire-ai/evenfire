/**
 * Shared stateless-lifecycle types. HostReconciler, the
 * StatelessLifecycleExecutor and the StatelessLifecycleTracker all import
 * from here, so the tracker carries no back-reference into
 * hostReconciler.ts.
 */
import { HostCondition, HostLifecycleState, HostLifecycleStatus } from './types'

/**
 * Effective lifecycle of a Host after the reconcile-time rejection checks.
 * `stateless` is false when spec.lifecycle.stateless is off OR a confirmed
 * incompatibility applies. Cache uncertainty keeps the stateless runtime
 * identity but blocks suspension until channel authority returns.
 */
export interface EffectiveHostLifecycle {
  stateless: boolean
  state: HostLifecycleState
  suspensionBlocked?: boolean
}

/** Reconcile-time lifecycle assessment: effective mode + durable status + condition. */
export interface HostLifecycleAssessment {
  effective: EffectiveHostLifecycle
  lifecycle: HostLifecycleStatus
  condition: Omit<HostCondition, 'lastTransitionTime'>
  /** Stage 6 (W5): durable verdict of the stateless pull-policy guard. */
  pullPolicyCondition: Omit<HostCondition, 'lastTransitionTime'>
}

/**
 * Outcome of a heartbeat-driven suspend commit attempt:
 *   - 'suspended'         — the durable suspended write committed.
 *   - 'already_suspended' — the fresh CR is already suspended (idempotent
 *     drained-report retry); the caller keeps answering drain:true.
 *   - 'skipped_stale'     — the commit no-opped because the drained evidence
 *     aged between decision and commit (fresh state no longer draining, a
 *     wake handled past the entry epoch, or a wake pending in fresh). The
 *     caller MUST answer drain:false so the pod un-fences and the next beat
 *     re-evaluates on fresh evidence instead of re-fencing a woken pod.
 */
export type SuspendFromHeartbeatOutcome = 'suspended' | 'already_suspended' | 'skipped_stale'
