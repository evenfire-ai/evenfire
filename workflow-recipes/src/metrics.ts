/**
 * Prometheus metrics for the Workload Recipes Controller (WRC).
 *
 * Uses a dedicated Registry to avoid polluting the global default registry.
 * Controller metrics keep the clerum_wrc_ prefix. Workflow runtime metrics use
 * workflow_* names so coordinator and broker dashboards can share labels.
 */
import { Counter, Gauge, Histogram, Registry } from 'prom-client'

const REGISTRY_KEY = Symbol.for('clerum.wrc.prometheus.registry')
type MetricsGlobal = typeof globalThis & { [REGISTRY_KEY]?: Registry }
const metricsGlobal = globalThis as MetricsGlobal
const newRegistry = !metricsGlobal[REGISTRY_KEY]
export const registry = (metricsGlobal[REGISTRY_KEY] ??= new Registry())

if (newRegistry) registry.setDefaultLabels({ service: 'workflow-recipes' })

type MetricOptions = { name: string; help: string; labelNames?: readonly string[] }

function counter(options: MetricOptions): Counter<string> {
  const existing = registry.getSingleMetric(options.name)
  if (existing) return existing as Counter<string>
  return new Counter({
    ...options,
    labelNames: [...(options.labelNames ?? [])],
    registers: [registry],
  })
}

function gauge(options: MetricOptions): Gauge<string> {
  const existing = registry.getSingleMetric(options.name)
  if (existing) return existing as Gauge<string>
  return new Gauge({
    ...options,
    labelNames: [...(options.labelNames ?? [])],
    registers: [registry],
  })
}

function histogram(options: MetricOptions & { buckets: number[] }): Histogram<string> {
  const existing = registry.getSingleMetric(options.name)
  if (existing) return existing as Histogram<string>
  return new Histogram({
    ...options,
    labelNames: [...(options.labelNames ?? [])],
    registers: [registry],
  })
}

export const recipesTotal = gauge({
  name: 'clerum_wrc_recipes_total',
  help: 'Total number of WorkflowRecipes by phase',
  labelNames: ['phase'] as const,
})

export const reconciliationsTotal = counter({
  name: 'clerum_wrc_reconciliations_total',
  help: 'Total WorkflowRecipe reconciliations',
  labelNames: ['result'] as const,
})

/**
 * Stale NetworkPolicies the reap was FORBIDDEN from deleting (issue #582).
 *
 * A 403 here is an enforcement leak: the policy is no longer desired but stays
 * enforced, and no code path will retry it into existence-or-absence. It does not
 * fail the recipe — a latched phase would be both invisible (nothing renders a
 * recipe's phase outside kubectl) and sticky — so this counter plus the
 * `NetworkPolicyReapFailed` condition are the durable signal. Alert on any
 * sustained non-zero value.
 *
 * Also answers issue #578's criticism that a persistent failure raises no metric.
 */
export const networkPolicyReapDeniedTotal = counter({
  name: 'clerum_wrc_networkpolicy_reap_denied_total',
  help: 'NetworkPolicy reap operations denied by RBAC (401/403); stale policies remain enforced',
  // `operation` matters more than `family` for triage: `delete` leaks one policy,
  // `list` means the controller is blind to a whole namespace and reaped nothing
  // there. A denied list carries `family: 'all'` because no policy was examined.
  labelNames: ['family', 'operation'] as const,
})

export const mcpSessionsActive = gauge({
  name: 'clerum_wrc_mcp_sessions_active',
  help: 'Number of active MCP sessions',
})

export const policyViolationsTotal = counter({
  name: 'clerum_wrc_policy_violations_total',
  help: 'Total policy violations detected',
  labelNames: ['policy', 'rule'] as const,
})

export const workflowStepDurationSeconds = histogram({
  name: 'workflow_step_duration_seconds',
  help: 'Workflow step execution duration by executor type and step kind',
  labelNames: ['executor', 'stepKind', 'status'] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300],
})

export const workflowStepTotal = counter({
  name: 'workflow_step_total',
  help: 'Workflow steps completed by executor type and final status',
  labelNames: ['executor', 'stepKind', 'status'] as const,
})

export const governedTraceEnqueuedTotal = counter({
  name: 'clerum_wrc_governed_trace_enqueued_total',
  help: 'Best-effort governed trace events accepted by the WRC local buffer',
  labelNames: ['family', 'type'] as const,
})

export const governedTraceDroppedTotal = counter({
  name: 'clerum_wrc_governed_trace_dropped_total',
  help: 'Best-effort governed trace events dropped by the WRC local buffer',
  labelNames: ['family', 'type', 'reason'] as const,
})

export const governedTraceFlushesTotal = counter({
  name: 'clerum_wrc_governed_trace_flushes_total',
  help: 'WRC governed trace flush outcomes',
  labelNames: ['family', 'result'] as const,
})

export const governedTraceRetriesTotal = counter({
  name: 'clerum_wrc_governed_trace_retries_total',
  help: 'WRC governed trace retries scheduled after a failed flush',
  labelNames: ['family', 'type'] as const,
})

export const governedTraceGapsTotal = counter({
  name: 'clerum_wrc_governed_trace_gaps_total',
  help: 'WRC governed trace evidence gaps that block complete trace or cost coverage',
  labelNames: ['family', 'type', 'reason'] as const,
})
