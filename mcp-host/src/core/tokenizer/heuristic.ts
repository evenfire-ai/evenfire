/**
 * Heuristic token estimator shared by all `TokenCounter` implementations, and
 * the count that selects the compaction tier by default (see the last paragraph
 * below). Extracted from `core/conversation/compaction.ts` so the counters can
 * use it without circular imports.
 *
 * Formula: `ceil(bytes / 4) + 4` per message, where `bytes` is the UTF-8 length
 * of the text as JSON serializes it — the standard byte-pair-encoding
 * approximation, measured in the unit the provider attempt contract caps:
 * `Buffer.byteLength(JSON.stringify(request))`. A count of UTF-16 code units
 * under-reads everything that is not plain ASCII: a CJK character is 3 bytes,
 * a control character is a 6-byte `\uXXXX` escape, and every quote of JSON
 * carried as a string gains a backslash (review r2, M2).
 *
 * It replaced `floor(word_count × 1.3) + 4` in #731. A word count is a fair
 * approximation for prose, where a space arrives every few characters, and a
 * bad one for the payload that actually fills an agentic context: a tool result
 * carrying minified JSON has almost no whitespace, so the word count collapses
 * it into a few hundred "words". Measured on a 33 KB MCP result: 1,982 tokens by
 * words against 8,329 by characters. `PressureContextManager` read ~70% while
 * real pressure was ~258%, stayed in `passthrough`, and the request was refused
 * by the provider attempt contract as `request exceeds maxRequestBodyBytes`.
 *
 * This is the count that selects the compaction tier for EVERY provider in the
 * default configuration, not only a fallback: `CLERUM_TOKENIZER_DRYRUN`
 * defaults to true (`tokenizerDryrun` in `config.ts`), and under dry-run `computePressure`
 * decides the tier from this heuristic and uses an exact counter only to record
 * the delta. It is exact nowhere — it ignores `contentParts` and
 * provider-specific framing.
 */
import type { ChatMessage, ToolDefinition } from '../types'

/** UTF-8 bytes of `s` as a JSON string value, without the enclosing quotes. */
function jsonStringBytes(s: string): number {
  return Buffer.byteLength(JSON.stringify(s), 'utf8') - 2
}

/** UTF-8 bytes of `value` serialized as JSON. */
function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

export function heuristicCount(messages: ChatMessage[]): number {
  let total = 0
  for (const msg of messages) {
    total += Math.ceil(jsonStringBytes(msg.content ?? '') / 4) + 4
    // An assistant message that issues a tool call carries its payload here,
    // never in `content`; without this the whole call bills at the framing
    // overhead alone (#731). `OpenAITokenCounter.countSync` walks the same field
    // and also encodes each call's `id` and `name`; only the arguments are
    // counted here, since they carry the payload.
    for (const tc of msg.tool_calls ?? []) {
      total += Math.ceil(jsonBytes(tc.arguments ?? {}) / 4)
    }
  }
  return total
}

/**
 * Estimate the token cost of tool schemas with a byte-based heuristic
 * (`ceil(bytes / 4) + 4` per tool, bytes as JSON serializes them) — the same
 * formula `heuristicCount` uses, which this function had to itself until #731.
 * Tool schemas are dense minified JSON with virtually no whitespace, so a word
 * count collapses the whole `parameters` object into a handful of "words" and
 * underestimates by roughly 4× (a 173-char schema → ~11 word-tokens vs ~44 real
 * tokens). The `bytes / 4` ratio is the standard byte-pair-encoding
 * approximation and is a far better fit for this payload shape — and, as #731
 * established, for tool results too.
 *
 * The estimate also covers the same surface OpenAI's exact tokenizer bills for
 * a tool: `name` + `description` + `JSON.stringify(parameters)` — not just
 * `parameters` alone. The `+4` per-item framing overhead mirrors
 * `heuristicCount`. This stays a heuristic approximation for the providers that
 * have no synchronous exact tokenizer (Anthropic, and every provider on the
 * `'fallback'` tokenizer, the subscriptions included) — it is never exact, only
 * closer than the old word count.
 */
export function heuristicCountTools(tools: ToolDefinition[]): number {
  let total = 0
  for (const t of tools) {
    // name + '\n' + description + '\n' + parameters, each in its serialized bytes.
    const bytes =
      jsonStringBytes(t.name) +
      1 +
      jsonStringBytes(t.description ?? '') +
      1 +
      jsonBytes(t.parameters ?? {})
    total += Math.ceil(bytes / 4) + 4 // ~bytes/4 ≈ tokens; +4 framing, mirrors heuristicCount
  }
  return total
}
