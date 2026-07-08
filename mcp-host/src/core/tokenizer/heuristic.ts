/**
 * Heuristic token estimator — the legacy fallback shared by all `TokenCounter`
 * implementations. Extracted from `core/conversation/compaction.ts` so the
 * counters can use it without circular imports.
 *
 * Formula (Risk 5.6 in the original code): `floor(word_count × 1.3) + 4` per
 * message. Nominally accurate to ±25%; significantly worse for tool-heavy
 * conversations because it ignores `tool_calls` payloads, `contentParts`,
 * and provider-specific framing overhead. Keep as the last-resort fallback
 * for offline mode and provider errors — never as the primary path.
 */
import type { ChatMessage, ToolDefinition } from '../types'

export function heuristicCount(messages: ChatMessage[]): number {
  let total = 0
  for (const msg of messages) {
    const wordCount = (msg.content ?? '').split(/\s+/).length
    total += Math.floor(wordCount * 1.3) + 4
  }
  return total
}

/**
 * Estimate the token cost of tool schemas with a character-based heuristic
 * (`ceil(chars / 4) + 4` per tool). Unlike messages, tool schemas are dense
 * minified JSON with virtually no whitespace, so a word count collapses the
 * whole `parameters` object into a handful of "words" and underestimates by
 * roughly 4× (a 173-char schema → ~11 word-tokens vs ~44 real tokens). The
 * `chars / 4` ratio is the standard byte-pair-encoding approximation and is a
 * far better fit for this payload shape.
 *
 * The estimate also covers the same surface OpenAI's exact tokenizer bills for
 * a tool: `name` + `description` + `JSON.stringify(parameters)` — not just
 * `parameters` alone. The `+4` per-item framing overhead mirrors
 * `heuristicCount`. This stays a heuristic approximation for the providers that
 * have no synchronous exact tokenizer (Anthropic, and the zai/bailian fallback)
 * — it is never exact, only closer than the old word count.
 */
export function heuristicCountTools(tools: ToolDefinition[]): number {
  let total = 0
  for (const t of tools) {
    const text = `${t.name}\n${t.description ?? ''}\n${JSON.stringify(t.parameters ?? {})}`
    total += Math.ceil(text.length / 4) + 4 // ~chars/4 ≈ tokens; +4 framing, mirrors heuristicCount
  }
  return total
}
