/**
 * Prometheus instruments for the tokenizer subsystem. Co-located with the
 * counter implementations (same pattern as `workspace/scanner.ts`'s
 * `memoryScanRejectionsTotal`).
 *
 * Labels:
 *   - provider: any registered LlmProvider id (see llm/registryCore.ts)
 *   - reason:   'no_native_api' | 'rate_limit' | 'count_call_failed' |
 *               'unknown_model' | 'offline' | 'no_warmup'
 *   - tier_chosen / from / to: 'passthrough' | 'workspace' | 'summarize' | 'truncate'
 */
import { Counter, Histogram } from 'prom-client'

export const tokenizerFallbackTotal = new Counter({
  name: 'clerum_tokenizer_fallback_total',
  help: 'Token counter fallback to the heuristic estimator (per provider/reason).',
  labelNames: ['provider', 'reason'] as const,
})

export const tokenizerCountDurationSeconds = new Histogram({
  name: 'clerum_tokenizer_count_duration_seconds',
  help: 'Latency of TokenCounter.count() per provider (network or local).',
  labelNames: ['provider'] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
})

export const tokenizerDryrunDelta = new Histogram({
  name: 'clerum_tokenizer_dryrun_delta',
  help: 'Ratio real/heuristic during the recalibration dry-run period.',
  labelNames: ['provider', 'tier_chosen'] as const,
  buckets: [0.5, 0.75, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0],
})

export const tokenizerDryrunTierMismatchTotal = new Counter({
  name: 'clerum_tokenizer_dryrun_tier_mismatch_total',
  help: 'Count of dry-run decisions where the real counter would have chosen a different tier than the heuristic.',
  labelNames: ['from', 'to'] as const,
})

export type TokenizerFallbackReason =
  | 'no_native_api'
  | 'rate_limit'
  | 'count_call_failed'
  | 'unknown_model'
  | 'offline'
  | 'no_warmup'
