/**
 * Issue #1016 — pure cadence policy for the WRC periodic timers. Timers run a
 * narrow check and escalate to a full reconcile only on observed change; this
 * module owns the intervals, the settle rule and the per-recipe cadence state.
 */
import {
  VERIFIED_AT_REFRESH_MS,
  hasPendingTransportNetworkReadiness,
  recipeHasExternalExactHostEgress,
  recipeReferencesNamedSecrets,
  runtimeCredentialRefreshIntervalMs,
  workflowNeedsInfrastructureReconcile,
  workflowNeedsWorkloadStatusRefresh,
} from './recipePredicates'
import type { WorkflowRecipeCRD } from './types'
import {
  MIN_RUNTIME_TOKEN_FILE_REFRESH_LEAD_SECONDS,
  runtimeTokenFileRefreshLeadSeconds,
} from './workflow/workflowReconciler'

export type ReconcileTrigger =
  | 'watch'
  | 'notify'
  | 'secret_watch'
  | 'oauth_broker'
  | 'transient_retry'
  | 'infra_retry'
  | 'sdk_liveness'
  | 'ownership'
  | 'workload_status'
  | 'egress_fallback'
  | 'steady_backstop'
export type TimerName =
  | 'egress'
  | 'ownership'
  | 'workload_status'
  | 'sdk_liveness'
  | 'infra_retry'
  | 'steady_backstop'
export type Coalesce = false | 'spacing' | 'backstop'
export interface ReconcileCadenceOutput {
  dnsBlocks: ReadonlyArray<'recipe_egress' | 'runtime_http_egress'>
  /** undefined = no ownership gate ran this pass */
  enforcedOwnership?: string
  repairPending: boolean
}
export interface ReconcileOutcome {
  ran: boolean
  settled: boolean
  enforcedOwnership?: string
}

type CadenceConfig = Parameters<typeof runtimeCredentialRefreshIntervalMs>[0] & {
  runtimeTokenTtlSeconds: number
  runtimeTokenRefreshBeforeSeconds: number
}

export function coalesceSpacingMs(config: CadenceConfig): number {
  return Math.floor(runtimeCredentialRefreshIntervalMs(config) / 2)
}

/**
 * Steady-state full-reconcile backstop: late enough to stay quiet, early enough
 * that the worst-case token-file remint (one slipped tick on top of the backstop
 * and the coalescing tick) still lands >= the file-refresh margin before expiry.
 * `degenerate` means the lead leaves no room, so the backstop collapses to every tick.
 */
export function steadyBackstopMs(config: CadenceConfig): { ms: number; degenerate: boolean } {
  const tickMs = runtimeCredentialRefreshIntervalMs(config)
  const leadMs = runtimeTokenFileRefreshLeadSeconds(config) * 1000
  const derived = leadMs - MIN_RUNTIME_TOKEN_FILE_REFRESH_LEAD_SECONDS * 1000 - 2 * tickMs
  if (derived <= tickMs) return { ms: tickMs, degenerate: true }
  return { ms: Math.min(VERIFIED_AT_REFRESH_MS, derived), degenerate: false }
}

export function isSettledResult(r: {
  requeueAfterMs?: number
  cadence?: { repairPending: boolean }
}): boolean {
  return !r.requeueAfterMs && r.cadence?.repairPending !== true
}

/**
 * Issue #637 — a steady-state recipe that projects a name-based Secret needs the
 * same periodic ownership re-classification that pure-workload recipes get through
 * `workflowNeedsWorkloadStatusRefresh`. That predicate deliberately excludes
 * workflow recipes (status is workflowExecution-driven) and SDK-only recipes
 * (capability state is owned by the full reconciler), so without this gate a Secret
 * re-labeled foreign was revoked solely by the event-driven SecretWatcher, with no
 * deterministic timer fallback if a watch event was delayed or coalesced.
 *
 * Issue #1016 widens this to stepless Plugin Workload SDK recipes (§3.4, the #637
 * stepless-SDK gap): they are excluded from the workload status refresh too, so
 * they previously had no ownership timer at all.
 */
export function workflowNeedsOwnershipBackstop(recipe: WorkflowRecipeCRD): boolean {
  if (recipe.metadata.deletionTimestamp) return false
  const isWorkflow = (recipe.spec.steps ?? []).length > 0
  if (!isWorkflow && !recipe.spec.pluginWorkloadSdk) return false
  return recipeReferencesNamedSecrets(recipe)
}

export function classifyInfrastructureRetry(
  recipe: WorkflowRecipeCRD
): 'none' | 'stuck' | 'sdk_liveness' {
  if (!workflowNeedsInfrastructureReconcile(recipe)) return 'none'
  const isWorkflow = (recipe.spec.steps ?? []).length > 0
  const wfPhase = recipe.status?.workflowExecution?.phase
  if (hasPendingTransportNetworkReadiness(recipe)) return 'stuck'
  if (isWorkflow && (wfPhase === 'initializing' || wfPhase === 'recovering')) return 'stuck'
  if (recipe.spec.pluginWorkloadSdk) return 'sdk_liveness'
  return 'stuck'
}

export function needsSteadyBackstop(recipe: WorkflowRecipeCRD): boolean {
  if (recipe.metadata.deletionTimestamp) return false
  return (
    workflowNeedsInfrastructureReconcile(recipe) ||
    (workflowNeedsWorkloadStatusRefresh(recipe) && recipeReferencesNamedSecrets(recipe)) ||
    workflowNeedsOwnershipBackstop(recipe) ||
    recipeHasExternalExactHostEgress(recipe)
  )
}

/** Per-recipe cadence state. Lazily created by the watcher (Object.create harness-safe). */
export class CadenceState {
  private readonly starts = new Map<string, number>()
  private readonly settled = new Map<string, number>()
  private readonly ownership = new Map<string, string>()
  private readonly noGate = new Map<string, string>()
  readonly pendingTimerTasks = new Set<string>()

  recordPassStart(name: string, at: number): void {
    this.starts.set(name, at)
  }
  lastStartAt(name: string): number | undefined {
    return this.starts.get(name)
  }
  lastSettledAt(name: string): number | undefined {
    return this.settled.get(name)
  }
  enforcedOwnership(name: string): string | undefined {
    return this.ownership.get(name)
  }
  noGateSignature(name: string): string | undefined {
    return this.noGate.get(name)
  }
  setNoGateSignature(name: string, sig: string): void {
    this.noGate.set(name, sig)
  }
  recordObservedOwnership(name: string, sig: string): void {
    this.ownership.set(name, sig)
  }

  /** Stamp a settled pass. `enforced` undefined => no gate ran => keep the previous signature. */
  recordSettled(name: string, startedAt: number, enforced: string | undefined): void {
    this.settled.set(name, startedAt)
    if (enforced !== undefined) {
      this.ownership.set(name, enforced)
      this.noGate.delete(name)
    }
  }

  forget(name: string): void {
    this.starts.delete(name)
    this.settled.delete(name)
    this.ownership.delete(name)
    this.noGate.delete(name)
    for (const key of this.pendingTimerTasks) {
      if (key.endsWith(`:${name}`)) this.pendingTimerTasks.delete(key)
    }
  }
}
