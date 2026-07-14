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
   */
  recordObservedUsage(usage: { input_tokens: number; output_tokens: number }): void

  /**
   * Last observed input_tokens from the provider (set by
   * `recordObservedUsage`). Null until the first response of the session.
   * Used as an authoritative shortcut when the message list shape is
   * stable across calls.
   */
  lastObservedInputTokens(): number | null
}
