/**
 * Heuristic token estimator — the legacy fallback shared by all `TokenCounter`
 * implementations. Extracted from `core/conversation/compaction.ts` so the
 * counters can use it without circular imports.
 *
 * Formula: `ceil(chars / 4) + 4` per message — the standard byte-pair-encoding
 * approximation, the same one `heuristicCountTools` below has always used.
 *
 * It replaced `floor(word_count × 1.3) + 4` in #731. A word count is a fair
 * approximation for prose, where a space arrives every few characters, and a
 * bad one for the payload that actually fills an agentic context: a tool result
 * carrying minified JSON has almost no whitespace, so the word count collapses
 * it into a handful of "words". Measured on a 33 KB MCP result: 1,982 tokens by
 * words against 8,329 by characters. `PressureContextManager` read ~70% while
 * real pressure was ~258%, stayed in `passthrough`, and the request was refused
 * by the provider attempt contract as `request exceeds maxRequestBodyBytes`.
 *
 * Still a heuristic, and still the last-resort fallback for offline mode and
 * provider errors — it ignores `contentParts` and provider-specific framing.
 * Never the primary path where an exact tokenizer exists.
 */
import type { ChatMessage, ToolDefinition } from '../types'

export function heuristicCount(messages: ChatMessage[]): number {
  let total = 0
  for (const msg of messages) {
    total += Math.ceil((msg.content ?? '').length / 4) + 4
  }
  return total
}

/**
 * Estimate the token cost of tool schemas with a character-based heuristic
 * (`ceil(chars / 4) + 4` per tool) — the same formula `heuristicCount` uses,
 * which this function had to itself until #731. Tool schemas are dense minified
 * JSON with virtually no whitespace, so a word count collapses the whole
 * `parameters` object into a handful of "words" and underestimates by roughly
 * 4× (a 173-char schema → ~11 word-tokens vs ~44 real tokens). The `chars / 4`
 * ratio is the standard byte-pair-encoding approximation and is a far better
 * fit for this payload shape — and, as #731 established, for tool results too.
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
