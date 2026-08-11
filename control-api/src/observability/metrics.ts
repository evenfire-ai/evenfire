import client, { Counter, Gauge, Histogram, Registry } from 'prom-client'

/**
 * Prometheus metrics for workflow approvals feature.
 *
 * Metric naming follows Prometheus conventions:
 *   - `*_total` for monotonic counters
 *   - `*_seconds` for latency histograms
 *   - labels kept low-cardinality (status/decision/result/bucket_type/status_code)
 *
 * The default registry is re-used so node process metrics (event loop lag,
 * heap, gc pauses) are exposed on /metrics alongside app metrics.
 */
export const registry: Registry = client.register

// Collect default Node process metrics once. Guard against double-registration
// when tests import this module more than once via module-graph re-entry.
const DEFAULT_METRICS_COLLECTED = Symbol.for('clerum.controlApi.defaultMetricsCollected')
type GlobalWithFlag = typeof globalThis & { [DEFAULT_METRICS_COLLECTED]?: boolean }
const globalWithFlag = globalThis as GlobalWithFlag
if (!globalWithFlag[DEFAULT_METRICS_COLLECTED]) {
  client.collectDefaultMetrics({ register: registry })
  globalWithFlag[DEFAULT_METRICS_COLLECTED] = true
}

/**
 * Helper: get-or-create a metric so hot-reload / repeated imports in tests
 * don't throw "A metric with the name X has already been registered".
 */
function getOrCreateCounter<Labels extends string>(opts: {
  name: string
  help: string
  labelNames: Labels[]
}): Counter<Labels> {
  const existing = registry.getSingleMetric(opts.name)
  if (existing) return existing as Counter<Labels>
  return new Counter<Labels>({ ...opts, registers: [registry] })
}

function getOrCreateHistogram<Labels extends string>(opts: {
  name: string
  help: string
  labelNames: Labels[]
  buckets?: number[]
}): Histogram<Labels> {
  const existing = registry.getSingleMetric(opts.name)
  if (existing) return existing as Histogram<Labels>
  return new Histogram<Labels>({ ...opts, registers: [registry] })
}

function getOrCreateGauge<Labels extends string>(opts: {
  name: string
  help: string
  labelNames: Labels[]
}): Gauge<Labels> {
  const existing = registry.getSingleMetric(opts.name)
  if (existing) return existing as Gauge<Labels>
  return new Gauge<Labels>({ ...opts, registers: [registry] })
}

// ─── Approval lifecycle counters ──────────────────────────────────────────
export const approvalsCreatedTotal = getOrCreateCounter({
  name: 'user_approval_requests_created_total',
  help: 'Count of workflow approval requests created, labelled by resulting status.',
  labelNames: ['status'] as const as Array<'status'>,
})

export const approvalsDecidedTotal = getOrCreateCounter({
  name: 'user_approval_requests_decided_total',
  help: 'Count of workflow approval requests decided (approve|deny).',
  labelNames: ['decision'] as const as Array<'decision'>,
})

export const approvalsExpiredTotal = getOrCreateCounter({
  name: 'user_approval_requests_expired_total',
  help: 'Count of workflow approval requests that transitioned to expired.',
  labelNames: [] as string[],
})

export const approvalsCancelledTotal = getOrCreateCounter({
  name: 'user_approval_requests_cancelled_total',
  help: 'Count of workflow approval requests that transitioned to cancelled.',
  labelNames: [] as string[],
})

export const approvalsDurationSeconds = getOrCreateHistogram({
  name: 'user_approval_requests_duration_seconds',
  help: 'Duration from approval creation to terminal decision (approve/deny).',
  labelNames: ['decision'] as const as Array<'decision'>,
  buckets: [1, 5, 15, 30, 60, 300, 900, 3600, 21600, 86400, 604800],
})

// ─── Notification stream/outbox metrics ──────────────────────────────────
export const notificationEventsEnqueuedTotal = getOrCreateCounter({
  name: 'notification_events_enqueued_total',
  help: 'Count of notification events enqueued in the durable outbox.',
  labelNames: ['event_type'] as const as Array<'event_type'>,
})

export const notificationOutboxEnqueueFailuresTotal = getOrCreateCounter({
  name: 'notification_outbox_enqueue_failures_total',
  help: 'Count of notification outbox enqueue failures.',
  labelNames: ['event_type'] as const as Array<'event_type'>,
})

// Figure D multi-bot: a user-bound approval delivery was skipped because no bot
// credential could be resolved for its CommunicationChannel. Distinct from a
// provider send failure — surfaces a suppression vector (e.g. a missing/deleted
// channel Secret) that would otherwise be invisible. Alert on rate > 0.
export const workflowApprovalDeliverySkippedNoBotTotal = getOrCreateCounter({
  name: 'workflow_approval_delivery_skipped_no_bot_total',
  help: 'Count of user-bound approval deliveries skipped because no bot credential resolved for the channel.',
  labelNames: ['medium'] as const as Array<'medium'>,
})

export const notificationStreamConnectionsActive = getOrCreateGauge({
  name: 'notification_stream_connections_active',
  help: 'Active Desktop notification stream connections.',
  labelNames: [] as string[],
})

export const notificationStreamEventsSentTotal = getOrCreateCounter({
  name: 'notification_stream_events_sent_total',
  help: 'Count of events written to Desktop notification streams.',
  labelNames: ['event_type'] as const as Array<'event_type'>,
})

export const notificationStreamEventsFilteredTotal = getOrCreateCounter({
  name: 'notification_stream_events_filtered_total',
  help: 'Count of notification stream events filtered before delivery.',
  labelNames: ['reason'] as const as Array<'reason'>,
})

export const notificationStreamDisconnectsTotal = getOrCreateCounter({
  name: 'notification_stream_disconnects_total',
  help: 'Count of Desktop notification stream disconnects.',
  labelNames: ['reason'] as const as Array<'reason'>,
})

export const notificationStreamSnapshotSize = getOrCreateHistogram({
  name: 'notification_stream_snapshot_size',
  help: 'Number of active approval notifications in each stream snapshot.',
  labelNames: [] as string[],
  buckets: [0, 1, 2, 5, 10, 20, 50],
})

// ─── Auth token counters ──────────────────────────────────────────────────
export const mcpHostJwtIssueTotal = getOrCreateCounter({
  name: 'workflow_auth_issue_total',
  help: 'Count of workflow access/refresh token issuance events.',
  labelNames: ['kind'] as const as Array<'kind'>, // access | refresh
})

export const oauthBrokerJwtIssueTotal = getOrCreateCounter({
  name: 'oauth_broker_jwt_issue_total',
  help: 'Count of recipe OAuth broker token issuance events labelled by result.',
  labelNames: ['result'] as const as Array<'result'>, // issued | recipe_not_found | not_background_access
})

export const mcpHostJwtRefreshTotal = getOrCreateCounter({
  name: 'workflow_auth_refresh_total',
  help: 'Count of workflow refresh attempts labelled by result.',
  labelNames: ['result'] as const as Array<'result'>, // success | failed | rotated
})

export const mcpHostJwtRefreshDurationSeconds = getOrCreateHistogram({
  name: 'workflow_auth_refresh_duration_seconds',
  help: 'Duration of the workflow refresh endpoint.',
  labelNames: ['result'] as const as Array<'result'>,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
})

// Task #20: Re-issue recovery endpoint counter. Labels stay low-cardinality
// and do NOT leak which specific validation failed in the response body —
// the label is emitted server-side in a `finally` block regardless of
// the opaque 401 surfaced to the caller.
// Label values:
//   ok             — validation passed, fresh token pair minted
//   invalid_sig    — JWT signature / iss / aud / scope / format rejected
//   invalid_claims — JWT verified but failed refresh-token claim validation
//   expired_beyond_reissue_grace — signed refresh token is too old to reissue
//   revoked        — jti already present in workflow_revoked_refresh_jtis
//   mismatch       — recipe_name body did not match JWT sub's recipe component
//   rate_limited   — limiter denied before handler ran (emitted in middleware)
//   bad_request    — missing/malformed body or bearer token
export const mcpHostJwtReissueTotal = getOrCreateCounter({
  name: 'workflow_auth_reissue_requests_total',
  help: 'Count of workflow auth re-issue attempts labelled by result.',
  labelNames: ['result'] as const as Array<'result'>,
})

// ─── HTTP counters / histograms (scoped to workflow-approvals endpoints) ──
export const mcpHostHttpTotal = getOrCreateCounter({
  name: 'mcp_host_http_total',
  help: 'Count of HTTP requests to workflow-approvals endpoints.',
  labelNames: ['route', 'method', 'status_code'] as const as Array<
    'route' | 'method' | 'status_code'
  >,
})

export const mcpHostHttpDurationSeconds = getOrCreateHistogram({
  name: 'mcp_host_http_duration_seconds',
  help: 'HTTP latency histogram for workflow-approvals endpoints.',
  labelNames: ['route', 'method', 'status_code'] as const as Array<
    'route' | 'method' | 'status_code'
  >,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
})

// ─── Expiry cron metrics ──────────────────────────────────────────────────
export const approvalsExpiryRunsTotal = getOrCreateCounter({
  name: 'user_approval_requests_expiry_runs_total',
  help: 'Count of expiry cron sweeps.',
  labelNames: ['result'] as const as Array<'result'>, // ok | error
})

export const approvalsExpiredByCronTotal = getOrCreateCounter({
  name: 'user_approval_requests_expired_by_cron_total',
  help: 'Total rows marked expired by the expiry cron.',
  labelNames: [] as string[],
})

export const approvalsExpiryDurationSeconds = getOrCreateHistogram({
  name: 'user_approval_requests_expiry_duration_seconds',
  help: 'Duration of each expiry cron sweep.',
  labelNames: [] as string[],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
})

// ─── Archival cron metrics ────────────────────────────────────────────────
export const approvalsArchiveRunsTotal = getOrCreateCounter({
  name: 'user_approval_requests_archive_runs_total',
  help: 'Count of approval archive cron sweeps.',
  labelNames: ['result'] as const as Array<'result'>, // ok | error
})

export const approvalsArchivedTotal = getOrCreateCounter({
  name: 'user_approval_requests_archived_total',
  help: 'Total rows archived (moved from workflow_approval_requests to archive).',
  labelNames: [] as string[],
})

export const approvalsArchiveDurationSeconds = getOrCreateHistogram({
  name: 'user_approval_requests_archive_duration_seconds',
  help: 'Duration of each archive cron sweep.',
  labelNames: [] as string[],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
})

// ─── Rate limiter metrics ─────────────────────────────────────────────────
export const rateLimitHitsTotal = getOrCreateCounter({
  name: 'rate_limit_hits_total',
  help: 'Rate-limiter hits, labelled by bucket_type and result (allowed|denied).',
  labelNames: ['bucket_type', 'result'] as const as Array<'bucket_type' | 'result'>,
})

export const aggregateAccessShadowComparisonsTotal = getOrCreateCounter({
  name: 'aggregate_access_shadow_comparisons_total',
  help: 'Count of bounded aggregate-access shadow comparisons by family and safe outcome.',
  labelNames: ['family', 'outcome'] as const as Array<'family' | 'outcome'>,
})

export const aggregateAccessShadowDifferencesTotal = getOrCreateCounter({
  name: 'aggregate_access_shadow_differences_total',
  help: 'Count of canonical resource differences observed by bounded access shadowing.',
  labelNames: ['family', 'direction'] as const as Array<'family' | 'direction'>,
})

// ─── Workflow-run archival cron metrics (DB-first, replaces CRD reaper) ──
export const workflowRunsArchiveRunsTotal = getOrCreateCounter({
  name: 'workflow_runs_archive_runs_total',
  help: 'Count of workflow-run archive cron sweeps.',
  labelNames: ['result'] as const as Array<'result'>, // ok | error | skipped_lock
})

export const workflowRunsArchivedTotal = getOrCreateCounter({
  name: 'workflow_runs_archived_total',
  help: 'Total terminal workflow runs archived (moved from workflow_runs to workflow_runs_audit).',
  labelNames: [] as string[],
})

export const workflowRunsChildDeleteTotal = getOrCreateCounter({
  name: 'workflow_runs_child_delete_total',
  help: 'Count of child WorkflowRecipe deletes triggered by archive cron, labelled by result.',
  labelNames: ['result'] as const as Array<'result'>, // ok | not_found | error
})

export const workflowRunsArchiveDurationSeconds = getOrCreateHistogram({
  name: 'workflow_runs_archive_duration_seconds',
  help: 'Duration of each workflow-run archive cron sweep.',
  labelNames: [] as string[],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
})

// ─── Fase 5 — schedule-worker metrics (DB-backed scheduler) ──────────────
// Replaces K8s CronJob scheduler. Each sweep acquires a cross-replica advisory
// lock on hashtext('wrc-schedule-worker-v1'); matured rows in workflow_schedules
// translate into workflow_runs inserts via workflowRunService.createRun().
export const workflowScheduleWorkerRunsTotal = getOrCreateCounter({
  name: 'wrc_schedule_worker_runs_total',
  help: 'Count of schedule-worker sweeps, labelled by result.',
  labelNames: ['result'] as const as Array<'result'>, // ok | error | skipped_lock
})

export const workflowScheduleWorkerFiresTotal = getOrCreateCounter({
  name: 'wrc_schedule_worker_fires_total',
  help: 'Count of individual schedule fires translated into workflow_runs rows.',
  labelNames: ['result'] as const as Array<'result'>, // ok | error
})

export const workflowScheduleWorkerDurationSeconds = getOrCreateHistogram({
  name: 'wrc_schedule_worker_duration_seconds',
  help: 'Duration of each schedule-worker sweep.',
  labelNames: [] as string[],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
})

// ─── Plugin Workload SDK (plan §5.3) ────────────────────────────────────

export const pluginWorkloadSdkAuthDecisionsTotal = getOrCreateCounter({
  name: 'clerum_plugin_workload_sdk_auth_decisions_total',
  help: 'Authorization decisions per recipe and method family (authorized | structured error code).',
  labelNames: ['recipe', 'method', 'decision'] as const as Array<'recipe' | 'method' | 'decision'>,
})

export const pluginWorkloadSdkNotificationAuthDurationSeconds = getOrCreateHistogram({
  name: 'clerum_plugin_workload_sdk_notification_auth_duration_seconds',
  help: 'clientNotifications authorization latency (SLO p99 < 500ms).',
  labelNames: ['recipe'] as const as Array<'recipe'>,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
})

export const pluginWorkloadSdkMaintenanceRunsTotal = getOrCreateCounter({
  name: 'clerum_plugin_workload_sdk_maintenance_runs_total',
  help: 'Plugin Workload SDK maintenance sweeps (stale-invocations + idempotency pruning).',
  labelNames: ['result'] as const as Array<'result'>, // ok | error
})

// ─── Governed tracing foundation ──────────────────────────────────────────
// Keep these dimensions bounded. Run, event, request, session, human, agent,
// team, recipe, Host, workload, and correlation identifiers are trace data,
// never Prometheus labels.
export const governedTraceAcceptedTotal = getOrCreateCounter({
  name: 'governed_trace_accepted_total',
  help: 'Count of governed trace events accepted for persistence.',
  labelNames: ['family', 'source', 'type'] as const as Array<'family' | 'source' | 'type'>,
})

export const governedTraceReplayedTotal = getOrCreateCounter({
  name: 'governed_trace_replayed_total',
  help: 'Count of governed trace events accepted as idempotent replays.',
  labelNames: ['family', 'source', 'type'] as const as Array<'family' | 'source' | 'type'>,
})

export const governedTraceRejectedTotal = getOrCreateCounter({
  name: 'governed_trace_rejected_total',
  help: 'Count of governed trace events rejected before persistence.',
  labelNames: ['family', 'source', 'type'] as const as Array<'family' | 'source' | 'type'>,
})

export const governedTraceConflictingTotal = getOrCreateCounter({
  name: 'governed_trace_conflicting_total',
  help: 'Count of governed trace events rejected because an idempotency key conflicted.',
  labelNames: ['family', 'source', 'type'] as const as Array<'family' | 'source' | 'type'>,
})

export const governedTraceIngestDurationSeconds = getOrCreateHistogram({
  name: 'governed_trace_ingest_duration_seconds',
  help: 'Duration of governed trace ingestion and stream registration.',
  labelNames: ['family', 'source'] as const as Array<'family' | 'source'>,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
})

export const governedTraceBatchSize = getOrCreateHistogram({
  name: 'governed_trace_batch_size',
  help: 'Number of events submitted in each governed tracing ingestion batch.',
  labelNames: ['family', 'source'] as const as Array<'family' | 'source'>,
  buckets: [1, 2, 5, 10, 25, 50, 100],
})

export const governedTraceQueryCount = getOrCreateHistogram({
  name: 'governed_trace_query_count',
  help: 'Database query round trips used by each governed family append transaction.',
  labelNames: ['family', 'source'] as const as Array<'family' | 'source'>,
  buckets: [1, 2, 3, 4, 5, 8, 13],
})

export const governedTraceReadDurationSeconds = getOrCreateHistogram({
  name: 'governed_trace_read_duration_seconds',
  help: 'Duration of governed trace read operations.',
  labelNames: ['family'] as const as Array<'family'>,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
})

export const governedTracePoolAcquisitionDurationSeconds = getOrCreateHistogram({
  name: 'governed_trace_pool_acquisition_duration_seconds',
  help: 'Time spent acquiring a governed tracing database pool connection.',
  labelNames: ['pool'] as const as Array<'pool'>,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2],
})

export const governedTracePoolRejectionsTotal = getOrCreateCounter({
  name: 'governed_trace_pool_rejections_total',
  help: 'Count of governed tracing work rejected because its pool could not serve it.',
  labelNames: ['pool'] as const as Array<'pool'>,
})

export const governedTracePoolConnections = getOrCreateGauge({
  name: 'governed_trace_pool_connections',
  help: 'Current active, idle, and waiting connection counts for governed tracing pools.',
  labelNames: ['pool', 'state'] as const as Array<'pool' | 'state'>,
})

export const governedTracePoolStatementTimeoutsTotal = getOrCreateCounter({
  name: 'governed_trace_pool_statement_timeouts_total',
  help: 'Governed tracing statements cancelled by the configured pool timeout.',
  labelNames: ['pool'] as const as Array<'pool'>,
})

export const GOVERNED_TRACE_OPERATIONAL_ERROR_REASONS = [
  'unsupported_content_type',
  'invalid_json',
  'body_too_large',
  'batch_too_large',
  'capacity_exhausted',
  'event_rejected',
  'idempotency_conflict',
  'submission_failed',
  'pool_rejected',
  'statement_timeout',
  'attribution_binding_unavailable',
  'attribution_binding_conflict',
  'prompt_history_disabled',
  'prompt_history_key_unavailable',
  'prompt_history_rejected',
] as const

export type GovernedTraceOperationalErrorReason =
  (typeof GOVERNED_TRACE_OPERATIONAL_ERROR_REASONS)[number]

export const GOVERNED_TRACE_OPERATIONAL_SCOPES = [
  'agent_run',
  'administrative',
  'infrastructure_telemetry',
  'read',
  'pool',
] as const

export type GovernedTraceOperationalScope = (typeof GOVERNED_TRACE_OPERATIONAL_SCOPES)[number]

export const governedTraceAdmissionRequestsTotal = getOrCreateCounter({
  name: 'governed_trace_admission_requests_total',
  help: 'Count of governed tracing requests admitted or rejected at the request boundary.',
  labelNames: ['family', 'result', 'reason'] as const as Array<'family' | 'result' | 'reason'>,
})

export const governedTraceRequestBodyBytes = getOrCreateHistogram({
  name: 'governed_trace_request_body_bytes',
  help: 'Raw byte size of governed tracing JSON request bodies accepted by the parser.',
  labelNames: ['family'] as const as Array<'family'>,
  buckets: [1_024, 4_096, 16_384, 65_536, 131_072, 262_144, 393_216, 524_288],
})

export const governedTraceInFlightRequests = getOrCreateGauge({
  name: 'governed_trace_in_flight_requests',
  help: 'Current governed tracing requests inside the control-api admission limiter.',
  labelNames: [] as string[],
})

export const governedTraceOperationalErrorsTotal = getOrCreateCounter({
  name: 'governed_trace_operational_errors_total',
  help: 'Count of bounded governed tracing operational error occurrences.',
  labelNames: ['scope', 'reason'] as const as Array<'scope' | 'reason'>,
})

export const governedTraceLastErrorTimestampSeconds = getOrCreateGauge({
  name: 'governed_trace_last_error_timestamp_seconds',
  help: 'Unix timestamp of the most recent bounded governed tracing operational error.',
  labelNames: ['scope', 'reason'] as const as Array<'scope' | 'reason'>,
})

export function recordGovernedTraceOperationalError(
  scope: GovernedTraceOperationalScope,
  reason: GovernedTraceOperationalErrorReason,
  timestampSeconds = Date.now() / 1_000
): void {
  governedTraceOperationalErrorsTotal.inc({ scope, reason })
  governedTraceLastErrorTimestampSeconds.set({ scope, reason }, timestampSeconds)
}
// ─── LLM allowlist ConfigMap materialization (spec §3-R3.4 / V7) ─────────
// Increments when the `clerum-llm-allowed-models` ConfigMap write fails after
// its short retry — either during a CRUD mutation (phase=mutation, the route
// then answers 503) or during the non-fatal boot reconcile (phase=boot). A
// rate > 0 means Postgres and the delivered ConfigMap have drifted.
export const llmAllowlistConfigMapWriteFailuresTotal = getOrCreateCounter({
  name: 'clerum_llm_allowlist_configmap_write_failures_total',
  help: 'Count of failed clerum-llm-allowed-models ConfigMap writes, labelled by phase.',
  labelNames: ['phase'] as const as Array<'phase'>, // mutation | boot
})
