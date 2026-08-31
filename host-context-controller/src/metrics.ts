/**
 * Prometheus metrics for the Host Context Controller (HCC).
 *
 * Uses a dedicated Registry to avoid polluting the global default registry.
 * Metrics follow the naming convention: clerum_hcc_<metric>_<unit>.
 */
import { Counter, Gauge, Histogram, Registry } from 'prom-client'

const REGISTRY_KEY = Symbol.for('clerum.hcc.prometheus.registry')
type MetricsGlobal = typeof globalThis & { [REGISTRY_KEY]?: Registry }
const metricsGlobal = globalThis as MetricsGlobal
const newRegistry = !metricsGlobal[REGISTRY_KEY]
export const registry = (metricsGlobal[REGISTRY_KEY] ??= new Registry())

if (newRegistry) registry.setDefaultLabels({ service: 'host-context-controller' })

function counter(options: {
  name: string
  help: string
  labelNames?: readonly string[]
}): Counter<string> {
  const existing = registry.getSingleMetric(options.name)
  if (existing) return existing as Counter<string>
  return new Counter({
    ...options,
    labelNames: [...(options.labelNames ?? [])],
    registers: [registry],
  })
}

function gauge(options: {
  name: string
  help: string
  labelNames?: readonly string[]
}): Gauge<string> {
  const existing = registry.getSingleMetric(options.name)
  if (existing) return existing as Gauge<string>
  return new Gauge({
    ...options,
    labelNames: [...(options.labelNames ?? [])],
    registers: [registry],
  })
}

/**
 * Buckets spanning sub-second admission through the urgent (5s), watch-recovery
 * (15s), and wake (45s) budgets, plus longer diagnostic tails. Shared by every
 * HCC reconcile/recovery latency histogram.
 */
const RECONCILE_LATENCY_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 15, 45, 120] as const

/**
 * Pass-duration buckets. Shared admission histograms top at 120s; GKE watch
 * recycle and the #462 duration criterion need an explicit 300s cut plus tails.
 */
export const NETWORKPOLICY_PASS_DURATION_BUCKETS = [
  1, 5, 15, 60, 120, 300, 600, 1200, 1800, 3600,
] as const

/** Idempotent Histogram helper mirroring counter()/gauge(). */
function histogram(options: {
  name: string
  help: string
  labelNames?: readonly string[]
  buckets?: readonly number[]
}): Histogram<string> {
  const existing = registry.getSingleMetric(options.name)
  if (existing) return existing as Histogram<string>
  return new Histogram({
    name: options.name,
    help: options.help,
    labelNames: [...(options.labelNames ?? [])],
    buckets: [...(options.buckets ?? RECONCILE_LATENCY_BUCKETS)],
    registers: [registry],
  })
}

export const mcpServersTotal = gauge({
  name: 'clerum_hcc_mcpservers_total',
  help: 'Total number of McpServer CRDs tracked by HCC',
  labelNames: ['status'] as const,
})

export const networkPoliciesTotal = gauge({
  name: 'clerum_hcc_networkpolicies_total',
  help: 'Total number of NetworkPolicies managed by HCC',
  labelNames: ['layer'] as const,
})

export const initialConvergenceRetriesTotal = counter({
  name: 'clerum_hcc_initial_convergence_retries_total',
  help: 'Initial background convergence retries scheduled after a failed fleet pass.',
  labelNames: ['lane'] as const,
})

export const initialConvergenceLastSuccessTimestampSeconds = gauge({
  name: 'clerum_hcc_initial_convergence_last_success_timestamp_seconds',
  help: 'Unix timestamp of the last successful initial background convergence pass.',
  labelNames: ['lane'] as const,
})

export const initialConvergenceSwallowedTotal = counter({
  name: 'clerum_hcc_initial_convergence_swallowed_total',
  help: 'Initial background convergence requests that returned without certifying.',
  labelNames: ['lane', 'sink'] as const,
})

export const initialConvergenceEffectsDroppedTotal = counter({
  name: 'clerum_hcc_initial_convergence_effects_dropped_total',
  help: 'Positive NetworkPolicy effects dropped because the pass inventory lease was retired.',
  labelNames: ['lane', 'kind'] as const,
})

export const initialConvergencePassResultsTotal = counter({
  name: 'clerum_hcc_initial_convergence_pass_results_total',
  help: 'Named outcomes of initial background convergence passes.',
  labelNames: ['lane', 'result'] as const,
})

export const initialConvergencePassDurationSeconds = histogram({
  name: 'clerum_hcc_initial_convergence_pass_duration_seconds',
  help: 'Seconds spent in an initial background convergence pass, labeled by named result.',
  labelNames: ['lane', 'result'] as const,
  buckets: NETWORKPOLICY_PASS_DURATION_BUCKETS,
})

export const networkPolicySafetyPassDurationSeconds = histogram({
  name: 'clerum_hcc_networkpolicy_safety_pass_duration_seconds',
  help: 'Seconds until an authoritative NetworkPolicy safety pass has revoked stale allows.',
  labelNames: ['outcome'] as const,
  buckets: NETWORKPOLICY_PASS_DURATION_BUCKETS,
})

export const networkPolicySafetyPassPoliciesTotal = counter({
  name: 'clerum_hcc_networkpolicy_safety_pass_policies_total',
  help: 'NetworkPolicies listed and revoked by authoritative HCC safety passes.',
  labelNames: ['operation'] as const,
})

export const netPolOrphansDeletedTotal = counter({
  name: 'clerum_hcc_netpol_orphans_deleted_total',
  help: 'Orphan NetworkPolicies deleted by an HCC fullReconcile sweep.',
  labelNames: ['lane'] as const,
})

export const netPolOrphanSweepCappedTotal = counter({
  name: 'clerum_hcc_netpol_orphan_sweep_capped_total',
  help: 'NetworkPolicy orphan sweeps that refused deletes because the candidate count exceeded the absolute or percent cap. The pass still certifies.',
  labelNames: ['reason'] as const,
})

export const netPolResyncTicksSkippedTotal = counter({
  name: 'clerum_hcc_netpol_resync_ticks_skipped_total',
  help: 'Periodic NetworkPolicy resync ticks skipped because a full pass (`pass-in-flight`) or a defaults-only tick (`defaults-only-in-flight`) was already in flight.',
  labelNames: ['reason'] as const,
})

export const netPolDefaultsOnlyTicksTotal = counter({
  name: 'clerum_hcc_netpol_defaults_only_ticks_total',
  help: 'NetworkPolicy defaults-only ticks by named result (success/error).',
  labelNames: ['result'] as const,
})

export const netPolDefaultsOnlyTickDurationSeconds = histogram({
  name: 'clerum_hcc_netpol_defaults_only_tick_duration_seconds',
  help: 'Seconds spent in a NetworkPolicy defaults-only tick, labeled by named result.',
  labelNames: ['result'] as const,
  buckets: NETWORKPOLICY_PASS_DURATION_BUCKETS,
})

export const contextReconciliationsTotal = counter({
  name: 'clerum_hcc_context_reconciliations_total',
  help: 'Total Context CRD reconciliations',
  labelNames: ['result'] as const,
})

export const bindingReconciliationsTotal = counter({
  name: 'clerum_hcc_binding_reconciliations_total',
  help: 'Total binding policy reconciliations',
  labelNames: ['result'] as const,
})

export const secretInformerEventsTotal = counter({
  name: 'clerum_hcc_secret_informer_events_total',
  help: 'Secret informer events received',
  labelNames: ['type'] as const,
})

export const secretInformerReconnectsTotal = counter({
  name: 'clerum_hcc_secret_informer_reconnects_total',
  help: 'Secret informer reconnection attempts',
})

export const secretInformerRunning = gauge({
  name: 'clerum_hcc_secret_informer_running',
  help: '1 when the SecretInformer watch is currently established, 0 when stopped or reconnecting',
})

export const mcpserverMissingSecret = gauge({
  name: 'clerum_hcc_mcpserver_missing_secret',
  help: '1 when an McpServer references a non-existent Secret',
  labelNames: ['namespace', 'name', 'secret_name'] as const,
})

export const infrastructureTelemetryEnqueuedTotal = counter({
  name: 'clerum_hcc_infrastructure_telemetry_enqueued_total',
  help: 'Infrastructure telemetry projections accepted by the bounded HCC reporter.',
  labelNames: ['telemetry_type'] as const,
})

export const infrastructureTelemetryDroppedTotal = counter({
  name: 'clerum_hcc_infrastructure_telemetry_dropped_total',
  help: 'Infrastructure telemetry projections dropped by the bounded HCC reporter.',
  labelNames: ['telemetry_type', 'reason'] as const,
})

export const infrastructureTelemetryFlushesTotal = counter({
  name: 'clerum_hcc_infrastructure_telemetry_flushes_total',
  help: 'Completed HCC infrastructure telemetry flush attempts.',
  labelNames: ['result'] as const,
})

export const infrastructureTelemetryRetriesTotal = counter({
  name: 'clerum_hcc_infrastructure_telemetry_retries_total',
  help: 'Infrastructure telemetry retries scheduled after a failed flush.',
  labelNames: ['telemetry_type'] as const,
})

export const infrastructureTelemetryGapsTotal = counter({
  name: 'clerum_hcc_infrastructure_telemetry_gaps_total',
  help: 'Infrastructure telemetry evidence gaps that block complete trace or cost coverage.',
  labelNames: ['telemetry_type', 'reason'] as const,
})

export const administrativeOutcomeReporterTotal = counter({
  name: 'clerum_hcc_administrative_outcome_reporter_total',
  help: 'Administrative outcome reporter enqueue, flush, and drop outcomes.',
  labelNames: ['result'] as const,
})

// Low-cardinality Host-scoped MCP API decisions. Resource names, JWT IDs,
// Contexts, and Secret selectors must never become metric labels.
export const mcpHostApiRequestsTotal = counter({
  name: 'clerum_hcc_mcp_host_api_requests_total',
  help: 'Host-scoped MCP API requests by route class, outcome, and bounded reason.',
  labelNames: ['action', 'outcome', 'reason'] as const,
})

// ── Host reconciliation scheduler telemetry (issue #791 follow-up) ──
// Low-cardinality labels only — never host names, users, teams, or session IDs.

export const hostReconcileQueueWaitSeconds = histogram({
  name: 'clerum_hcc_host_reconcile_queue_wait_seconds',
  help: 'Seconds a Host reconcile waited between dispatch and its per-Host chain admitting it.',
  labelNames: ['lane', 'outcome'] as const,
})

export const hostReconcileDurationSeconds = histogram({
  name: 'clerum_hcc_host_reconcile_duration_seconds',
  help: 'Seconds a Host reconcile body executed after admission to its per-Host chain.',
  labelNames: ['source', 'outcome'] as const,
})

export const hostReconcileInFlight = gauge({
  name: 'clerum_hcc_host_reconcile_in_flight',
  help: 'Host reconciles currently executing, by lane (urgent/retry/fleet).',
  labelNames: ['lane'] as const,
})

export const hostWatchRecoverySeconds = histogram({
  name: 'clerum_hcc_host_watch_recovery_seconds',
  help: 'Seconds for Host watch LIST-to-WATCH recovery phases (list/watch/total).',
  labelNames: ['phase', 'outcome'] as const,
})

export const hostFleetRequestsTotal = counter({
  name: 'clerum_hcc_host_fleet_requests_total',
  help: 'Host fleet reconcile requests by coalescing result (started/coalesced/trailing/failed).',
  labelNames: ['result'] as const,
})

// Closed `error` names; never a Host name.
export const hostFleetBenignSupersessionsTotal = counter({
  name: 'clerum_hcc_host_fleet_benign_supersessions_total',
  help: 'Host fleet workers withdrawn because a name-equivalent benign supersession retired the pass.',
  labelNames: ['error'] as const,
})

// Closed `decision` set: applied | retry.
export const hostFleetLifecycleCatchTotal = counter({
  name: 'clerum_hcc_host_fleet_lifecycle_catch_total',
  help: 'Host fleet catch-path decisions while a CommunicationChannel lifecycle generation is in flight (applied when hostFailures is empty, retry otherwise).',
  labelNames: ['decision'] as const,
})

// #493: successful replace() only, inside replaceWithConflictRetry. Kind is
// next.kind ?? 'unknown'. Direct Role PUTs stay invisible until G5.
export const writesTotal = counter({
  name: 'clerum_hcc_writes_total',
  help: 'Successful Kubernetes replace() calls issued through replaceWithConflictRetry, by object kind.',
  labelNames: ['kind'] as const,
})

// Twin of writesTotal. Incremented when isUpToDate returns true, before the
// helper returns without replace(). Label set is {kind} only — policy_type
// belongs to #526.
export const writeSkipsTotal = counter({
  name: 'clerum_hcc_write_skips_total',
  help: 'No-op Kubernetes replaces skipped by replaceWithConflictRetry because the merged object was already up to date, by object kind.',
  labelNames: ['kind'] as const,
})

export const hostCleanupDeferredTotal = counter({
  name: 'clerum_hcc_host_cleanup_deferred_total',
  help: 'Orphan Host cleanup deferrals by bounded reason.',
  labelNames: ['reason'] as const,
})

// #827 (Addendum 4 item 5): bounded, low-cardinality Host deletion cleanup
// counter. `outcome` is a small fixed set — never a Host name — so cardinality
// stays flat regardless of fleet size.
//   queued     — a disappeared Host was enqueued for authoritative delete cleanup
//   confirmed  — the fresh authoritative snapshot confirmed the Host is gone
//   completed  — the delete cleanup finished (bundle removed / already absent)
//   retried    — a delete cleanup failed and is left to the safety-net sweep
//   superseded — a stale delete was suppressed because a same-name Host was recreated
export const hostDeleteCleanupTotal = counter({
  name: 'clerum_hcc_host_delete_cleanup_total',
  help: 'Host deletion cleanup by outcome (queued/confirmed/completed/retried/superseded).',
  labelNames: ['outcome'] as const,
})

// issue #299 Phase 2 — provider-CIDR drift canary. Incremented every reconcile
// in which a provider-mode binding resolved IP(s) OUTSIDE its declared ranges
// (the declared ranges may be stale or the host mis-mapped). Availability is
// still protected — those IPs enter the /32 window — but this makes staleness
// loud. Low-cardinality: `dns` is the declared host, never a resolved IP.
export const externalEgressProviderDriftTotal = counter({
  name: 'clerum_hcc_external_egress_provider_drift_total',
  help: 'Resolved IPs outside declared provider ranges (issue #299 drift canary).',
  labelNames: ['server', 'dns'] as const,
})

// External-egress DNS retry saturation (#205 audit R3-M4 / R2-L1). A binding
// whose DNS never resolves is retried forever at the capped (maximum) backoff;
// without this signal the still-denied binding converges nowhere yet stays
// invisible. Tracks the COUNT of servers pinned at the cap — never a per-server
// label — so cardinality stays flat regardless of fleet size.
export const externalEgressRetriesAtCap = gauge({
  name: 'clerum_hcc_external_egress_retries_at_cap',
  help: 'McpServers whose external-egress DNS retry is pinned at the capped (maximum) backoff, i.e. repeatedly failing to converge.',
})
