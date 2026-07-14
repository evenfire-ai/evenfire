/**
 * T1.2 — Pre-pruning pass executed BEFORE invoking the LLM.
 *
 * Four deterministic, LLM-free passes that try to recover context tokens
 * before the tiered compactor (MoveToWorkspace / Summarize / Truncate)
 * pays an LLM call:
 *
 *   1. Dedup tool outputs by canonical SHA-256 content hash.
 *   2. One-line-summarize oversized tool outputs that live outside the
 *      protected tail.
 *   3. JSON-safe truncate oversized `assistant.tool_calls[].arguments`.
 *   4. Strip historical media (image content parts) from anything before
 *      the latest user message.
 *
 * Filosofía: CPU local es gratis comparado con tokens del LLM. Cada pasada
 * es individualmente toggleable y un no-op si la condición no aplica. Si el
 * flag master está apagado, la función NO se invoca; los tiers existentes
 * corren bit-idénticos al pre-T1.2.
 *
 * Spec: `.specs/mcp-hermes/implementation-plans/T1.2-pre-pruning.md`.
 *
 * Invariantes críticas:
 *   - **Linkages preserved**: pre-prune nunca inserta ni borra mensajes,
 *     nunca toca `tool_call_id` ni `assistant.tool_calls[].id`. Sólo
 *     muta `content` (string) y `arguments` (objeto). El caller corre
 *     `validateToolLinkages` post-step como red de seguridad hard-fail.
 *   - **Protected tail**: los últimos K turns (K = `protectedTailTurns`)
 *     viven completos. Pre-prune sólo opera en `[0, protectedTailStart)`.
 *   - **Pure**: la función retorna una copia con los mensajes mutados
 *     reemplazados por copias nuevas; las entradas intactas mantienen
 *     identidad referencial. Caller decide cuándo asignar.
 */
import { createHash } from 'node:crypto'
import { Counter } from 'prom-client'
import { extractInputPreview } from '../orchestration/toolUseLoop'
import { heuristicCount } from '../tokenizer/heuristic'
import type { ChatMessage, MessageContentPart, ToolCall } from '../types'

// T1.2 — Co-located Prometheus instrument (same pattern as `contextManager.ts`'s
// `clerumCompactionTotal` and `tokenizer/metrics.ts`). One counter is enough:
// the savings ratio can be derived from the running totals against the input
// token gauge from P.1 once it lands.
export const clerumPrePruneSavingsTokensTotal = new Counter({
  name: 'clerum_pre_prune_savings_tokens_total',
  help: 'Heuristic tokens reclaimed by T1.2 pre-pruning (sum of pre - post per call).',
})

export interface PrePruneOptions {
  /** Cuántos turns proteger del tail (default 3). */
  protectedTailTurns: number
  /**
   * Pass 2: tool messages con `heuristicCount` > este threshold se reemplazan
   * por un one-line summary (default 200 tokens).
   */
  summaryThresholdTokens: number
  /**
   * Pass 3: `JSON.stringify(arguments)` se trunca cuando excede este budget
   * (default 4096 bytes ≈ ~1024 tokens).
   */
  maxArgsBytes: number
  dedupEnabled: boolean
  oneLineSummariesEnabled: boolean
  jsonSafeTruncateEnabled: boolean
  stripMediaEnabled: boolean
}

export const DEFAULT_PRE_PRUNE_OPTIONS: PrePruneOptions = {
  protectedTailTurns: 3,
  summaryThresholdTokens: 200,
  maxArgsBytes: 4096,
  dedupEnabled: true,
  oneLineSummariesEnabled: true,
  jsonSafeTruncateEnabled: true,
  stripMediaEnabled: true,
}

const DUPLICATE_PREFIX = '[duplicate of tool_call_id='

export interface PrePruneResult {
  messages: ChatMessage[]
  preTokens: number
  postTokens: number
  passesApplied: string[]
}

/**
 * Run the four-pass pre-prune over the message array. Returns the mutated
 * copy plus pre/post token counts (heuristic) and a list of passes that
 * actually fired. Caller (`PressureContextManager`) emits the observability
 * event with this payload.
 */
export function prePrune(
  messages: ChatMessage[],
  opts: PrePruneOptions = DEFAULT_PRE_PRUNE_OPTIONS
): PrePruneResult {
  const preTokens = heuristicCount(messages)
  const protectedTailStart = computeProtectedTailStart(messages, opts.protectedTailTurns)
  const passesApplied: string[] = []

  let out = messages
  if (opts.dedupEnabled) {
    const next = dedupToolResults(out, protectedTailStart)
    if (next !== out) {
      passesApplied.push('dedup')
      out = next
    }
  }
  if (opts.oneLineSummariesEnabled) {
    const next = oneLineSummaries(out, protectedTailStart, opts.summaryThresholdTokens)
    if (next !== out) {
      passesApplied.push('one_line_summaries')
      out = next
    }
  }
  if (opts.jsonSafeTruncateEnabled) {
    const next = jsonSafeTruncateArgs(out, protectedTailStart, opts.maxArgsBytes)
    if (next !== out) {
      passesApplied.push('json_safe_truncate')
      out = next
    }
  }
  if (opts.stripMediaEnabled) {
    const next = stripHistoricalMedia(out, protectedTailStart)
    if (next !== out) {
      passesApplied.push('strip_media')
      out = next
    }
  }

  const postTokens = heuristicCount(out)
  return { messages: out, preTokens, postTokens, passesApplied }
}

/**
 * Compute the protected-tail start index. The last K user messages start
 * the protected region; pre-prune leaves `messages[protectedTailStart..]`
 * untouched. Returns `0` when there are fewer than K user messages — in
 * that case the whole array is tail and no pass mutates anything.
 *
 * Mirrors the `splitTurns()` convention (each user message starts a turn).
 * When T1.3's `alignBoundary` is invoked by the caller around the cut we
 * compute here, the aligned cut is conservatively pushed earlier in cases
 * where it would split a tool-call pair — that's safe, the protected
 * region only grows.
 */
export function computeProtectedTailStart(messages: ChatMessage[], tailTurns: number): number {
  if (tailTurns <= 0) return messages.length
  let count = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      count++
      if (count >= tailTurns) return i
    }
  }
  return 0
}

// ─── Pass 1 — Dedup tool outputs ────────────────────────────────────────────

/**
 * Collapse `tool` messages with identical canonicalized content into
 * back-references pointing at the first occurrence's `tool_call_id`. Only
 * touches `messages[0..protectedTailStart)`; the tail is left intact so the
 * LLM sees the most recent results in full.
 *
 * Canonicalization: JSON parsed-and-re-serialized with sorted keys for any
 * object value, falling back to whitespace normalization for non-JSON
 * content. Two semantically-identical payloads with different key orders
 * (or extra whitespace) hash to the same value.
 */
export function dedupToolResults(
  messages: ChatMessage[],
  protectedTailStart: number
): ChatMessage[] {
  if (protectedTailStart <= 0) return messages
  const seen = new Map<string, { tool_call_id: string }>()
  let mutated: ChatMessage[] | null = null
  for (let i = 0; i < Math.min(protectedTailStart, messages.length); i++) {
    const msg = messages[i]
    if (msg.role !== 'tool') continue
    if (!msg.tool_call_id) continue
    if (msg.content.startsWith(DUPLICATE_PREFIX)) continue
    const h = hash(msg.content)
    const prior = seen.get(h)
    if (prior) {
      if (mutated === null) mutated = messages.slice()
      mutated[i] = {
        ...msg,
        content: `${DUPLICATE_PREFIX}${prior.tool_call_id}]`,
      }
    } else {
      seen.set(h, { tool_call_id: msg.tool_call_id })
    }
  }
  return mutated ?? messages
}

// ─── Pass 2 — One-line summaries ────────────────────────────────────────────

/**
 * Replace `tool` messages outside the protected tail whose heuristic token
 * count exceeds `threshold` with a one-line descriptor. Skips messages
 * already collapsed by pass 1. Preserves `tool_call_id` (linkage invariant).
 *
 * Output format: `[<tool_name>] <args summary> -> <result summary>, <N> bytes`.
 * If the agent later needs the full output, it will re-invoke the tool —
 * which then trips pass 1 dedup against the live tail.
 */
export function oneLineSummaries(
  messages: ChatMessage[],
  protectedTailStart: number,
  threshold: number
): ChatMessage[] {
  if (protectedTailStart <= 0) return messages
  let mutated: ChatMessage[] | null = null
  for (let i = 0; i < Math.min(protectedTailStart, messages.length); i++) {
    const msg = messages[i]
    if (msg.role !== 'tool') continue
    if (msg.content.startsWith(DUPLICATE_PREFIX)) continue
    const tokens = heuristicCount([msg])
    if (tokens <= threshold) continue
    const byteCount = msg.content.length
    const toolName = msg.name ?? 'unknown'
    const argsSummary = inferArgsSummary(messages, msg.tool_call_id)
    const resultSummary = inferResultSummary(msg.content)
    const line = `[${toolName}] ${argsSummary} -> ${resultSummary}, ${byteCount} bytes`
    if (mutated === null) mutated = messages.slice()
    mutated[i] = { ...msg, content: line }
  }
  return mutated ?? messages
}

function inferArgsSummary(messages: ChatMessage[], toolCallId: string | undefined): string {
  if (!toolCallId) return '(args unknown)'
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'assistant' || !m.tool_calls) continue
    const tc = m.tool_calls.find(c => c.id === toolCallId)
    if (!tc) continue
    const preview = extractInputPreview(tc.name, tc.arguments)
    if (preview) {
      return preview.length > 80 ? preview.slice(0, 77) + '…' : preview
    }
    const serialized = safeStringifyArgs(tc.arguments)
    return serialized.length > 80 ? `args=${serialized.slice(0, 77)}…` : `args=${serialized}`
  }
  return '(args unknown)'
}

function inferResultSummary(content: string): string {
  const firstLine = content.split('\n')[0] ?? ''
  return firstLine.length > 80 ? firstLine.slice(0, 77) + '…' : firstLine
}

function safeStringifyArgs(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args)
  } catch {
    return '(unserializable)'
  }
}

// ─── Pass 3 — JSON-safe truncation of tool_calls arguments ──────────────────

/**
 * Trim oversized `assistant.tool_calls[].arguments` while keeping the JSON
 * parseable. The provider rejects with HTTP 400 on malformed args, so a
 * naive `substring()` would crash the next call.
 *
 * Strategy: clone the args object, repeatedly find the longest string field
 * (depth-first, including nested objects/arrays) and shrink it with a
 * trailing `… (truncated, N chars omitted)` marker. Stop when the
 * serialized payload fits the budget, when there are no more strings to
 * cut, or after a small iteration cap (defence against pathological shapes).
 */
export function jsonSafeTruncateArgs(
  messages: ChatMessage[],
  protectedTailStart: number,
  maxBytes: number
): ChatMessage[] {
  if (protectedTailStart <= 0) return messages
  let mutated: ChatMessage[] | null = null
  for (let i = 0; i < Math.min(protectedTailStart, messages.length); i++) {
    const msg = messages[i]
    if (msg.role !== 'assistant' || !msg.tool_calls || msg.tool_calls.length === 0) continue
    let toolCallsMutated: ToolCall[] | null = null
    for (let j = 0; j < msg.tool_calls.length; j++) {
      const tc = msg.tool_calls[j]
      const serialized = safeStringifyArgs(tc.arguments)
      if (serialized.length <= maxBytes) continue
      const truncated = jsonSafeTruncate(tc.arguments, maxBytes)
      if (toolCallsMutated === null) toolCallsMutated = msg.tool_calls.slice()
      toolCallsMutated[j] = { ...tc, arguments: truncated }
    }
    if (toolCallsMutated !== null) {
      if (mutated === null) mutated = messages.slice()
      mutated[i] = { ...msg, tool_calls: toolCallsMutated }
    }
  }
  return mutated ?? messages
}

function jsonSafeTruncate(
  args: Record<string, unknown>,
  maxBytes: number
): Record<string, unknown> {
  const clone = structuredClone(args)
  let serialized = JSON.stringify(clone)
  let iterations = 0
  const MAX_ITER = 50
  while (serialized.length > maxBytes && iterations < MAX_ITER) {
    const longest = findLongestStringField(clone)
    if (!longest) break
    const { ref, key, value } = longest
    const overflow = serialized.length - maxBytes
    // Leave room for the truncation marker (~40-50 chars) so the next
    // serialization fits in the budget.
    const newLen = Math.max(0, value.length - overflow - 50)
    const replacement =
      newLen < 10
        ? `… (truncated, ${value.length} chars omitted)`
        : value.slice(0, newLen) + `… (truncated, ${value.length - newLen} chars omitted)`
    // ref/key carry a union (object|array, string|number). Narrow once at
    // assignment so TS accepts the indexed write either way.
    ;(ref as Record<string | number, unknown>)[key] = replacement
    serialized = JSON.stringify(clone)
    iterations++
  }
  return clone
}

interface LongestStringRef {
  ref: Record<string, unknown> | unknown[]
  key: string | number
  value: string
}

function findLongestStringField(root: unknown): LongestStringRef | null {
  let best: LongestStringRef | null = null
  function walk(node: unknown): void {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const v = node[i]
        if (typeof v === 'string') {
          if (!best || v.length > best.value.length) {
            best = { ref: node, key: i, value: v }
          }
        } else if (v && typeof v === 'object') {
          walk(v)
        }
      }
      return
    }
    const obj = node as Record<string, unknown>
    for (const k of Object.keys(obj)) {
      const v = obj[k]
      if (typeof v === 'string') {
        if (!best || v.length > best.value.length) {
          best = { ref: obj, key: k, value: v }
        }
      } else if (v && typeof v === 'object') {
        walk(v)
      }
    }
  }
  walk(root)
  if (best === null) return null
  // Sneak past the writable-key restriction: arrays support numeric writes.
  return best as LongestStringRef
}

// ─── Pass 4 — Strip historical media ────────────────────────────────────────

/**
 * Replace `image` content parts in every message strictly before the
 * protected-tail region with `[image redacted — see turn N]` text parts.
 * The protected tail (last K user messages and everything after) keeps its
 * images intact — that's where the live frame for a vision call lives, and
 * also where T1.3's `alignBoundary` guarantees pre-prune cannot strand a
 * tool pair.
 *
 * Today (pre-B.7) mcp-host doesn't propagate `contentParts` between turns
 * via `buildMessageHistory`, so this pass mostly fires inside long
 * within-turn loops (e.g. repeated `desktop_screenshot`). Kept as a
 * preventive guardrail for the B.7 future.
 *
 * Prior to the B3 fix this function used its own `findLastUserIndex` and
 * stripped images from every message before the last user — bypassing the
 * `protectedTailTurns` invariant that passes 1-3 already honor.
 */
export function stripHistoricalMedia(
  messages: ChatMessage[],
  protectedTailStart: number
): ChatMessage[] {
  if (protectedTailStart <= 0) return messages
  let mutated: ChatMessage[] | null = null
  for (let i = 0; i < protectedTailStart; i++) {
    const msg = messages[i]
    if (!msg.contentParts || msg.contentParts.length === 0) continue
    const hasImage = msg.contentParts.some(p => p.type === 'image')
    if (!hasImage) continue
    const newParts: MessageContentPart[] = msg.contentParts.map(part =>
      part.type === 'image' ? { type: 'text', text: `[image redacted — see turn ${i}]` } : part
    )
    if (mutated === null) mutated = messages.slice()
    mutated[i] = { ...msg, contentParts: newParts }
  }
  return mutated ?? messages
}

// ─── Canonicalization + hashing ─────────────────────────────────────────────

/**
 * Normalize a `tool` message's `content` string before hashing. Two
 * semantically-identical payloads (same JSON keys in different orders,
 * varying whitespace) canonicalize to the same string so pass 1 collapses
 * them. Non-JSON content gets whitespace-normalized only.
 *
 * Exported for tests; production callers go through `hash()`.
 */
export function canonicalize(content: string): string {
  const trimmed = content.trim()
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      const parsed = JSON.parse(trimmed)
      return JSON.stringify(parsed, sortedReplacer)
    } catch {
      // fall through to whitespace normalization
    }
  }
  return trimmed.replace(/\s+/g, ' ')
}

function sortedReplacer(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const k of Object.keys(obj).sort()) {
      sorted[k] = obj[k]
    }
    return sorted
  }
  return value
}

export function hash(content: string): string {
  return createHash('sha256').update(canonicalize(content)).digest('hex')
}
