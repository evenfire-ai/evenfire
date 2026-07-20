/**
 * Prometheus instruments for the LLM model allowlist (spec §3-R3).
 *
 * Registered on the prom-client global register so they ride the existing
 * mcp-host GET /metrics endpoint (same pattern as `llm/promptCacheMetrics.ts`).
 * mcp-host convention prefixes instrument names with `clerum_`; the domain
 * suffixes (`llm_allowlist_missing`, `llm_model_not_allowed`) match the
 * cross-service names in the spec.
 */
import { Counter } from 'prom-client'

/**
 * Incremented once per transition into "allowlist ConfigMap absent" —
 * degraded-explicit mode where only the Host-configured model is treated as
 * permitted (spec §3-R3.5).
 */
export const llmAllowlistMissingTotal = new Counter({
  name: 'clerum_llm_allowlist_missing_total',
  help: 'Times mcp-host observed the LLM allowlist ConfigMap absent (degraded-explicit mode).',
})

/**
 * Incremented when the Host-configured model is found outside the operator
 * allowlist. Non-disruptive signal only — mcp-host does not reject the model
 * (hard enforcement is control-api/WRC, spec §3-R3.7).
 */
export const llmModelNotAllowedTotal = new Counter({
  name: 'clerum_llm_model_not_allowed_total',
  help: 'Times the Host-configured model was found outside the operator allowlist (non-disruptive signal).',
  labelNames: ['provider', 'model'] as const,
})
