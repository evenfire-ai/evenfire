/**
 * Prometheus metrics for the Workload Recipes Controller (WRC).
 *
 * Uses a dedicated Registry to avoid polluting the global default registry.
 * Controller metrics keep the clerum_wrc_ prefix. Workflow runtime metrics use
 * workflow_* names so coordinator and broker dashboards can share labels.
 */
import { Counter, Gauge, Histogram, Registry } from 'prom-client'

export const registry = new Registry()

registry.setDefaultLabels({ service: 'workflow-recipes' })

export const recipesTotal = new Gauge({
  name: 'clerum_wrc_recipes_total',
  help: 'Total number of WorkflowRecipes by phase',
  labelNames: ['phase'] as const,
  registers: [registry],
})

export const reconciliationsTotal = new Counter({
  name: 'clerum_wrc_reconciliations_total',
  help: 'Total WorkflowRecipe reconciliations',
  labelNames: ['result'] as const,
  registers: [registry],
})

export const mcpSessionsActive = new Gauge({
  name: 'clerum_wrc_mcp_sessions_active',
  help: 'Number of active MCP sessions',
  registers: [registry],
})

export const policyViolationsTotal = new Counter({
  name: 'clerum_wrc_policy_violations_total',
  help: 'Total policy violations detected',
  labelNames: ['policy', 'rule'] as const,
  registers: [registry],
})

export const workflowStepDurationSeconds = new Histogram({
  name: 'workflow_step_duration_seconds',
  help: 'Workflow step execution duration by executor type and step kind',
  labelNames: ['executor', 'stepKind', 'status'] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300],
  registers: [registry],
})

export const workflowStepTotal = new Counter({
  name: 'workflow_step_total',
  help: 'Workflow steps completed by executor type and final status',
  labelNames: ['executor', 'stepKind', 'status'] as const,
  registers: [registry],
})
