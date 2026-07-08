import type { Conversation, Turn } from '../core/types'
import { getDisplayName } from '../progress/intentExtraction'
import type { ContextBreakdownWire, SessionTokensWire, TurnToolStepWire } from './types'

// Wire projections: map a Conversation / Turn to the runtime API shapes served
// by `/v1/runtime/sessions` and `/messages` (per-session + per-turn token
// usage, and per-turn tool steps). Pure functions, unit-tested in isolation.

/**
 * Project a Conversation's lifetime token mirror into the wire shape served by
 * `/v1/runtime/sessions` and `/messages`.
 *
 * Returns `undefined` when the session has had no LLM call yet, so the desktop
 * shows no counter. `cacheRead`/`cacheWrite` are included ONLY when the model
 * reported cache info (`cacheTokensReported`) — distinguishing "0 because no
 * cache hit" (Anthropic) from "absent because the provider doesn't report
 * cache" (OpenAI / zai / bailian).
 */
export function projectSessionTokens(conversation: Conversation): SessionTokensWire | undefined {
  const hasTokens =
    !!conversation.input_tokens ||
    !!conversation.output_tokens ||
    !!conversation.cache_read_tokens ||
    !!conversation.cache_write_tokens
  if (!hasTokens) return undefined
  return {
    input: conversation.input_tokens ?? 0,
    output: conversation.output_tokens ?? 0,
    ...(conversation.cacheTokensReported
      ? {
          cacheRead: conversation.cache_read_tokens ?? 0,
          cacheWrite: conversation.cache_write_tokens ?? 0,
        }
      : {}),
  }
}

/**
 * Project a Conversation's send-time context-window breakdown into the wire
 * shape served on-demand by `/v1/runtime/sessions/:agent/:chatId/context-breakdown`.
 *
 * Returns `undefined` when the session has no snapshot yet (cold-load before
 * the first turn). `fillRatio = totalInputTokens / maxTokens`. `cacheHitRate`
 * is included ONLY when the model reported cache info (`cacheTokensReported`),
 * computed from the SAME lifetime columns `projectSessionTokens` reads (#11) —
 * no new columns. `cache_read / (cache_read + input)`.
 */
export function projectContextBreakdown(
  conversation: Conversation
): ContextBreakdownWire | undefined {
  const breakdown = conversation.contextBreakdown
  if (!breakdown) return undefined
  const fillRatio = breakdown.maxTokens > 0 ? breakdown.totalInputTokens / breakdown.maxTokens : 0
  let cacheHitRate: number | undefined
  if (conversation.cacheTokensReported) {
    const cacheRead = conversation.cache_read_tokens ?? 0
    const input = conversation.input_tokens ?? 0
    const denom = cacheRead + input
    // Omit cacheHitRate entirely when there's no usage yet (denom === 0):
    // emitting 0 here would render a misleading "Average cache hit rate 0.0%".
    if (denom > 0) cacheHitRate = cacheRead / denom
  }
  return {
    buckets: { ...breakdown.buckets },
    totalInputTokens: breakdown.totalInputTokens,
    maxTokens: breakdown.maxTokens,
    fillRatio,
    ...(cacheHitRate !== undefined ? { cacheHitRate } : {}),
    capturedAtTurn: breakdown.capturedAtTurn,
  }
}

/**
 * Project one turn's token usage into the wire shape for `/messages`.
 *
 * Returns `undefined` for a turn with no recorded usage. Unlike the session
 * projection (which carries a separate `cacheTokensReported` flag), the per-turn
 * mirror preserves "unreported" faithfully: a defined `cache_*` field IS the
 * "model reports cache" signal, so cacheRead/cacheWrite are included exactly
 * when the turn has them defined (Anthropic's defined 0 included; OpenAI's
 * undefined omitted).
 */
export function projectTurnTokens(turn: Turn): SessionTokensWire | undefined {
  const hasTokens =
    !!turn.input_tokens ||
    !!turn.output_tokens ||
    !!turn.cache_read_tokens ||
    !!turn.cache_write_tokens
  if (!hasTokens) return undefined
  const cacheReported =
    turn.cache_read_tokens !== undefined || turn.cache_write_tokens !== undefined
  return {
    input: turn.input_tokens ?? 0,
    output: turn.output_tokens ?? 0,
    ...(cacheReported
      ? { cacheRead: turn.cache_read_tokens ?? 0, cacheWrite: turn.cache_write_tokens ?? 0 }
      : {}),
  }
}

/**
 * Project a turn's tool calls to the minimal wire shape the desktop progress
 * stepper needs (#582), so its "N tools" list survives a reload / cold-load (the
 * live SSE steps are renderer-only). NEVER exposes raw arguments or tool output —
 * only the server-derived `displayName`, the canonical tool name (already shown
 * live), state, duration, and a redacted `errorSummary`.
 *
 * `redactError` MUST mirror the live SSE path's redaction (secret-scrub via
 * `Safety.sanitizeOutput` + `sanitizeError` strip/truncate): the persisted
 * `tc.error` (cold-loaded raw from `messages.content`, `reconstruct.ts`) is NOT
 * sanitized at rest, so the boundary is enforced here. Required (not optional) so
 * a caller can't accidentally ship the raw error. Returns `undefined` for a turn
 * with no tool calls.
 */
export function projectTurnToolSteps(
  turn: Turn,
  redactError: (toolName: string, rawError: string) => string
): TurnToolStepWire[] | undefined {
  if (!turn.tool_calls?.length) return undefined
  return turn.tool_calls.map(tc => {
    const summary = tc.error ? redactError(tc.name, tc.error) : ''
    return {
      toolName: tc.name,
      displayName: getDisplayName(tc.name),
      state: tc.error ? ('error' as const) : ('completed' as const),
      ...(tc.duration_ms != null ? { durationMs: tc.duration_ms } : {}),
      ...(summary ? { errorSummary: summary } : {}),
    }
  })
}
