/**
 * Provider-aware token counter. Replaces the legacy heuristic
 * (`core/conversation/compaction.ts:estimateTokens`) as the primary signal
 * for compaction triggers, pressure-tier selection, and (future) prompt-cache
 * breakpoints.
 *
 * Implementations live next to this file:
 *   - AnthropicTokenCounter  → `client.messages.countTokens` (GA, free)
 *   - OpenAITokenCounter     → `tiktoken` (model-matched encoding)
 *   - FallbackTokenCounter   → heuristic + documented bias factor (ZAI/Bailian)
 *
 * Contract:
 *   - `count()` is async — Anthropic does a network call; OpenAI awaits warmup
 *     of the WASM-backed encoder once.
 *   - `count()` MUST NOT throw. Any provider error is logged, the
 *     `clerum_tokenizer_fallback_total` counter is incremented, and the result
 *     falls back to a conservative upper bound (heuristic × 1.5).
 *   - When the counter has no information about a piece of content (e.g. an
 *     unknown image), it returns an *upper bound* — over-estimating triggers
 *     early compaction; under-estimating risks provider context overflow.
 *   - `countSync()` is a non-network best-effort variant for code paths that
 *     cannot await. For Anthropic it returns the heuristic upper bound; for
 *     OpenAI/Fallback it returns the same value as `count()` after warmup.
 *   - `recordObservedUsage()` lets the next compaction decision skip the
 *     network call and use the authoritative `input_tokens` from the last
 *     response (Hermes `update_from_response` pattern).
 *
 * See `.specs/mcp-hermes/implementation-plans/P2-tokenizer.md` for the design.
 */
import type { LlmProvider } from '../../llm/registryCore'
import type { ChatMessage, ToolDefinition } from '../types'

// Normally a registered LlmProvider id, plus the literal 'unknown' sentinel the
// safe-fallback path uses when a provider reports a non-registry type. Keeping
// the sentinel in the type (rather than the raw type string) bounds the
// `provider` metric-label cardinality. See createTokenCounter() in ./index.ts.
export type TokenCounterProvider = LlmProvider | 'unknown'

export interface TokenCounter {
  readonly providerName: TokenCounterProvider
  readonly modelName: string

  /**
   * Authoritative token count for a message list. May be expensive (network
   * for Anthropic). Call at compaction-decision points, not in tight loops.
   */
  count(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: { signal?: AbortSignal }
  ): Promise<number>

  /**
   * Synchronous best-effort count. Never network, never lazy-loads encoders.
   * Callers should `await warmup()` once before relying on the OpenAI value.
   */
  countSync(messages: ChatMessage[], tools?: ToolDefinition[]): number

  /**
   * Pre-load any state needed by `countSync` (e.g. tiktoken encoding). Safe
   * to call multiple times; idempotent.
   */
  warmup(): Promise<void>

  /**
   * Update the counter's notion of "last known true count" from a provider
   * usage report. Called by `LlmPortAdapter.recordUsage` after every
   * successful round-trip.
   *
   * `decision_heuristic` is the byte heuristic of that same request, counted
   * the way the context manager counts it. The next decision uses
   * `input_tokens` as a floor and adds the heuristic growth since this stamp.
   * A report without the heuristic clears any previous baseline so a stale
   * delta is not applied to a newer bill.
   */
  recordObservedUsage(usage: ObservedTokenUsage): void

  /**
   * Last observed input_tokens from the provider (set by
   * `recordObservedUsage`). Null until the first response of the session.
   */
  lastObservedInputTokens(): number | null

  /**
   * Byte heuristic of the request that produced `lastObservedInputTokens`.
   * Optional so test doubles that only implement the original counter still
   * type-check; a missing method means "no baseline", and the observation is
   * then a floor with no growth delta.
   */
  lastObservedDecisionHeuristic?(): number | null
}

/** Provider usage plus the decision heuristic of the request that was billed. */
export interface ObservedTokenUsage {
  input_tokens: number
  output_tokens: number
  decision_heuristic?: number
}

/** Baseline stored beside `input_tokens`. `null` when the report did not carry one. */
export function observedDecisionHeuristic(usage: ObservedTokenUsage): number | null {
  const value = usage.decision_heuristic
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.max(0, Math.round(value))
}

/**
 * Project the next decision from the last billed input.
 *
 * `projected = observed + currentHeuristic - baselineHeuristic`.
 * Returns `observed` when the baseline is missing, and `null` when nothing
 * has been observed yet. Callers take `max(liveCount, projected)` so a stale
 * observation cannot under-count a larger live heuristic.
 */
export function projectObservedDecisionTokens(
  counter: {
    lastObservedInputTokens(): number | null
    lastObservedDecisionHeuristic?(): number | null
  },
  currentHeuristic: number
): number | null {
  const observed = counter.lastObservedInputTokens()
  if (observed == null || !Number.isFinite(observed)) return null
  const baseline = counter.lastObservedDecisionHeuristic?.()
  if (baseline == null || !Number.isFinite(baseline)) return Math.max(0, Math.round(observed))
  return Math.max(0, Math.round(observed + currentHeuristic - baseline))
}
