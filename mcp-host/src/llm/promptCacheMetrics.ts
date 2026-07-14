/**
 * T2.2 — Prompt-cache Prometheus instruments.
 *
 * Histograms track input/cache_read/cache_write token sizes per LLM call;
 * the counter records why entries got dropped (compact, host_change,
 * model_change, identity_reconciled). The gauge surfaces the current
 * `stable_hash` for each sessionKey — the metric VALUE is always 1, the
 * hash rides as a label so a regression that flips the supposedly stable
 * tier mid-session shows up as a label-set change instead of being silent.
 *
 * Co-located with the prompt-cache module so the wiring stays self-contained
 * (same pattern as `core/tokenizer/metrics.ts`).
 */
import { Counter, Gauge, Histogram } from 'prom-client'

export const clerumPromptCacheReadTokens = new Histogram({
  name: 'clerum_prompt_cache_read_tokens',
  help: 'Tokens served from the prompt cache per LLM call (Anthropic cache_read_input_tokens).',
  buckets: [0, 256, 1024, 4096, 16384, 65536, 262144],
})

export const clerumPromptCacheWriteTokens = new Histogram({
  name: 'clerum_prompt_cache_creation_tokens',
  help: 'Tokens written to the prompt cache per LLM call (Anthropic cache_creation_input_tokens).',
  buckets: [0, 256, 1024, 4096, 16384, 65536, 262144],
})

export const clerumPromptCacheInputTokens = new Histogram({
  name: 'clerum_prompt_cache_input_tokens',
  help: 'Total billable input tokens per LLM call (denominator for the ≥0.6 cache-hit ratio gate).',
  buckets: [0, 256, 1024, 4096, 16384, 65536, 262144],
})

export const clerumPromptCacheInvalidationsTotal = new Counter({
  name: 'clerum_prompt_cache_invalidations_total',
  help: 'PromptCache invalidations by reason.',
  labelNames: ['reason'] as const,
})

export const clerumPromptStableHash = new Gauge({
  name: 'clerum_prompt_stable_hash',
  help: 'Current sha256 of the `stable` tier per session (value=1; hash carried as label).',
  labelNames: ['session_key', 'stable_hash'] as const,
})

/**
 * Pin the current sha256 of a session's `stable` tier as a gauge label-set
 * with value 1. The label-set itself is the load-bearing signal — when the
 * supposedly stable tier flips mid-session, the hash label changes and an
 * operator's `sum by (stable_hash) (clerum_prompt_stable_hash{session_key=…})`
 * shows the transition.
 */
export function stampStableHashGauge(sessionKey: string, stableHash: string): void {
  clerumPromptStableHash.labels({ session_key: sessionKey, stable_hash: stableHash }).set(1)
}
