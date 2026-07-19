/**
 * Provider-fallback (R5) — Prometheus instrument.
 *
 * Registered on the prom-client global register so it rides the existing
 * mcp-host GET /metrics endpoint (same pattern as `llm/promptCacheMetrics.ts`
 * and `config/allowlistMetrics.ts`). mcp-host convention prefixes instrument
 * names with `clerum_`.
 */
import { Counter } from 'prom-client'

/**
 * Incremented once per actual switch from one `(provider/model)` pair to a
 * configured fallback pair (spec §3-R5.9). `reason` is the {@link FailoverClass}
 * that triggered the switch, or `boot` for a boot-time fallback (spec §3-R5.10).
 */
export const llmFallbackTotal = new Counter({
  name: 'clerum_llm_fallback_total',
  help: 'Times mcp-host switched from one LLM provider/model pair to a configured fallback.',
  labelNames: ['from', 'to', 'reason'] as const,
})
