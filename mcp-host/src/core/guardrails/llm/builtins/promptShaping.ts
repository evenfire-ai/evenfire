/**
 * `prompt-shaping` built-in (spec §7.2) — a first-party, in-process `pre` rewrite
 * contributor for the LLM lane.
 *
 * Phase 2 (increment 1): forces `temperature` / `max_tokens` / `tool_choice` on
 * the request. These are currently unset on the main reasoning lane, so this is
 * additive. System-prompt-part injection is deferred (it entangles with the
 * tiered `SystemPromptParts` cache — see `reasoning/port.ts:buildMessages`).
 */
import type { ToolCompletionRequest } from '../../../types'

export interface PromptShapingConfig {
  /** Force the sampling temperature. */
  temperature?: number
  /** Force the max output tokens. */
  maxTokens?: number
  /** Force tool-choice mode. */
  toolChoice?: 'auto' | 'none' | 'required'
  /** TODO(phase2): inject a system prompt part (needs SystemPromptParts handling). */
  systemPromptPart?: string
}

/** Apply prompt-shaping to a completion request, returning a new request. */
export function applyPromptShaping(
  request: ToolCompletionRequest,
  config: PromptShapingConfig
): ToolCompletionRequest {
  const shaped: ToolCompletionRequest = { ...request }
  if (config.temperature !== undefined) shaped.temperature = config.temperature
  if (config.maxTokens !== undefined) shaped.max_tokens = config.maxTokens
  if (config.toolChoice !== undefined) shaped.tool_choice = config.toolChoice
  // TODO(phase2): if config.systemPromptPart, inject it into systemPromptParts.
  return shaped
}
