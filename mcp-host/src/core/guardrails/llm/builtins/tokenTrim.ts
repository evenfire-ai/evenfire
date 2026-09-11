/**
 * `token-trim` built-in (spec §7.2) — a first-party, in-process `pre` rewrite
 * contributor that reduces input tokens toward a budget by reusing the existing
 * four-pass `core/extensions/prePrune.ts` (dedup, one-line summaries, JSON-safe
 * arg truncation, historical-media strip). LLM-free; protects the tail turns.
 *
 * Budget-gated: when `maxInputTokens` is set and the request is already under it,
 * the request is left unchanged. Ordering/config are uniform with the built-in
 * chain (spec §7.2). Note: an operator who also enables the context-manager
 * prePrune will prune twice (idempotent-ish) — that is a config choice.
 */
import {
  DEFAULT_PRE_PRUNE_OPTIONS,
  type PrePruneOptions,
  prePrune,
} from '../../../extensions/prePrune'
import type { ToolCompletionRequest } from '../../../types'

export interface TokenTrimConfig {
  /** Only trim when the request's heuristic input tokens exceed this budget. */
  maxInputTokens?: number
  protectedTailTurns?: number
  summaryThresholdTokens?: number
  maxArgsBytes?: number
  dedupEnabled?: boolean
  oneLineSummariesEnabled?: boolean
  jsonSafeTruncateEnabled?: boolean
  stripMediaEnabled?: boolean
}

function toPrePruneOptions(config: TokenTrimConfig): PrePruneOptions {
  return {
    protectedTailTurns: config.protectedTailTurns ?? DEFAULT_PRE_PRUNE_OPTIONS.protectedTailTurns,
    summaryThresholdTokens:
      config.summaryThresholdTokens ?? DEFAULT_PRE_PRUNE_OPTIONS.summaryThresholdTokens,
    maxArgsBytes: config.maxArgsBytes ?? DEFAULT_PRE_PRUNE_OPTIONS.maxArgsBytes,
    dedupEnabled: config.dedupEnabled ?? DEFAULT_PRE_PRUNE_OPTIONS.dedupEnabled,
    oneLineSummariesEnabled:
      config.oneLineSummariesEnabled ?? DEFAULT_PRE_PRUNE_OPTIONS.oneLineSummariesEnabled,
    jsonSafeTruncateEnabled:
      config.jsonSafeTruncateEnabled ?? DEFAULT_PRE_PRUNE_OPTIONS.jsonSafeTruncateEnabled,
    stripMediaEnabled: config.stripMediaEnabled ?? DEFAULT_PRE_PRUNE_OPTIONS.stripMediaEnabled,
  }
}

/** Apply token-trim to a completion request, returning a new request (or the same when nothing changed). */
export function applyTokenTrim(
  request: ToolCompletionRequest,
  config: TokenTrimConfig
): ToolCompletionRequest {
  const result = prePrune(request.messages, toPrePruneOptions(config))
  // Budget gate: under budget → leave the request untouched.
  if (config.maxInputTokens !== undefined && result.preTokens <= config.maxInputTokens)
    return request
  if (result.messages === request.messages) return request // no pass fired
  return { ...request, messages: result.messages }
}
