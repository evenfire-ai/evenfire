import { type PrePruneOptions, prePrune } from '../extensions/prePrune'
import { heuristicCount } from '../tokenizer/heuristic'
import type { TokenCounter } from '../tokenizer/tokenCounter'
import { ChatMessage } from '../types'

/**
 * Estimate token count for a message array.
 *
 * @deprecated since P.2 — prefer `LlmPort.getTokenCounter().countSync(...)` or
 * the async `count(...)` variant. Kept exported as a thin alias over
 * `heuristicCount` so existing call sites and tests continue to work while
 * the codebase migrates.
 */
export function estimateTokens(messages: ChatMessage[]): number {
  return heuristicCount(messages)
}

/**
 * Split non-system messages into turns.
 * Each "user" message starts a new turn (user + assistant + tool messages).
 */
export function splitTurns(nonSystemMsgs: ChatMessage[]): ChatMessage[][] {
  const turns: ChatMessage[][] = []
  let currentTurn: ChatMessage[] = []

  for (const msg of nonSystemMsgs) {
    if (msg.role === 'user' && currentTurn.length > 0) {
      turns.push(currentTurn)
      currentTurn = []
    }
    currentTurn.push(msg)
  }
  if (currentTurn.length > 0) {
    turns.push(currentTurn)
  }

  return turns
}

// ─── T1.3 — Boundary alignment + last-user anchor ───────────────────────────

function isAssistantToolLead(msg: ChatMessage | undefined | null): boolean {
  return (
    !!msg && msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0
  )
}

function isToolResult(msg: ChatMessage | undefined | null): boolean {
  return !!msg && msg.role === 'tool' && typeof msg.tool_call_id === 'string'
}

/**
 * Does any contiguous tool result in `messages[fromIdx..]` match one of the
 * assistant.tool_calls ids at `leadIdx`? Walks forward while role === 'tool'.
 */
function hasMatchingToolAfter(messages: ChatMessage[], leadIdx: number, fromIdx: number): boolean {
  const lead = messages[leadIdx]
  if (!isAssistantToolLead(lead)) return false
  const ids = new Set(lead.tool_calls!.map(tc => tc.id))
  for (let j = fromIdx; j < messages.length; j++) {
    const m = messages[j]
    if (m.role !== 'tool') break
    if (m.tool_call_id && ids.has(m.tool_call_id)) return true
  }
  return false
}

/**
 * Does ANY tool result in the entire array match one of the assistant's
 * tool_calls ids at `leadIdx`? Used for the pathological "orphan everywhere"
 * forward-alignment check (Regla 2).
 */
function hasMatchingToolAnywhere(messages: ChatMessage[], leadIdx: number): boolean {
  const lead = messages[leadIdx]
  if (!isAssistantToolLead(lead)) return false
  const ids = new Set(lead.tool_calls!.map(tc => tc.id))
  for (let j = 0; j < messages.length; j++) {
    if (j === leadIdx) continue
    const m = messages[j]
    if (m.role === 'tool' && m.tool_call_id && ids.has(m.tool_call_id)) return true
  }
  return false
}

/**
 * Is `messages[idx]` a tool result whose lead assistant lives strictly before
 * it? Walks back through contiguous tool messages to find the lead candidate.
 */
function isOrphanToolResult(messages: ChatMessage[], idx: number): boolean {
  const here = messages[idx]
  if (!isToolResult(here)) return false
  let i = idx - 1
  while (i >= 0 && messages[i].role === 'tool') {
    i--
  }
  if (i < 0) return false
  const leader = messages[i]
  if (!isAssistantToolLead(leader)) return false
  return leader.tool_calls!.some(tc => tc.id === here.tool_call_id)
}

/**
 * Find the index of the last `user` message, or -1 if none.
 */
export function findLastUserIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return i
  }
  return -1
}

/**
 * Translate a turn-array index into a message-array index. Returns the flat
 * `nonSystemMsgs` index of the first message of `turns[turnIdx]`. For
 * `turnIdx === turns.length` returns the total message count (i.e. "past the
 * end" — useful when keepRecent is 0).
 */
export function turnIndexToMessageIndex(turns: ChatMessage[][], turnIdx: number): number {
  const clamped = Math.max(0, Math.min(turnIdx, turns.length))
  let sum = 0
  for (let i = 0; i < clamped; i++) {
    sum += turns[i].length
  }
  return sum
}

/**
 * T1.3 — Align a proposed cut so it never splits an assistant.tool_calls /
 * tool pair, and so the last user message always survives.
 *
 * `proposedCut` is the index in `messages` such that `messages[0..proposedCut-1]`
 * is archived and `messages[proposedCut..]` is kept. Returns the aligned cut.
 *
 * Three rules applied in order:
 *   1. Backward — walk back while the cut splits a tool-call pair (the
 *      message immediately before the cut is an assistant lead whose tool
 *      results live forward of the cut, OR the message at the cut is an
 *      orphan tool result whose lead lives before).
 *   2. Forward — if after Rule 1 the cut still lands on an assistant lead
 *      with NO matching tool result anywhere, advance the cut past it
 *      (drops the orphan assistant from the kept set).
 *   3. Last-user anchor — if the cut would archive the most recent user
 *      message, lower the cut to that user's index.
 *
 * Pure function. O(n). No allocations beyond per-check id sets.
 */
export function alignBoundary(messages: ChatMessage[], proposedCut: number): number {
  let cut = Math.max(0, Math.min(proposedCut, messages.length))

  // Rule 1 — backward alignment over tool-call pairs.
  while (cut > 0) {
    const left = messages[cut - 1]
    const here = cut < messages.length ? messages[cut] : null

    if (isAssistantToolLead(left) && hasMatchingToolAfter(messages, cut - 1, cut)) {
      cut -= 1
      continue
    }
    if (here && isOrphanToolResult(messages, cut)) {
      cut -= 1
      continue
    }
    break
  }

  // Rule 2 — forward alignment for completely-orphan assistant.tool_calls.
  if (cut < messages.length) {
    const here = messages[cut]
    if (isAssistantToolLead(here) && !hasMatchingToolAnywhere(messages, cut)) {
      cut += 1
    }
  }

  // Rule 3 — last-user anchor.
  const lastUserIdx = findLastUserIndex(messages)
  if (lastUserIdx >= 0 && lastUserIdx < cut) {
    cut = lastUserIdx
  }

  return cut
}

/**
 * T1.4 — Compute the compaction effectiveness ratio `post/pre`.
 *
 * Returns `1.0` for the degenerate `pre === 0` case so callers always get a
 * defined number. Re-used by `PressureContextManager.manage()` and exposed for
 * tests; the manager uses `estimateTokens` (heuristic) — keep that path stable
 * so the trigger threshold and the effectiveness measurement disagree at most
 * by their shared rounding.
 */
export function measureCompactionRatio(pre: ChatMessage[], post: ChatMessage[]): number {
  const preTokens = estimateTokens(pre)
  if (preTokens <= 0) return 1.0
  return estimateTokens(post) / preTokens
}

/**
 * Apply an aligned cut to a split system/non-system pair. Convenience wrapper
 * used by every compaction tier: feed it the system messages, the flat
 * non-system messages, and the cut proposed by the tier policy. Returns the
 * kept array (with system prepended) and the archived subarray.
 */
export function applyAlignedCut(
  systemMsgs: ChatMessage[],
  nonSystemMsgs: ChatMessage[],
  proposedCut: number
): { kept: ChatMessage[]; archived: ChatMessage[] } {
  const cut = alignBoundary(nonSystemMsgs, proposedCut)
  const archived = nonSystemMsgs.slice(0, cut)
  const tail = nonSystemMsgs.slice(cut)
  return { kept: [...systemMsgs, ...tail], archived }
}

// ───────────────────────────────────────────────────────────────────────────

/**
 * Compact conversation by keeping only the N most recent turns.
 *
 * Risk 5.5: Never compact the current turn's messages.
 * The first message (system prompt) is always preserved.
 *
 * Strategy:
 * 1. Always keep the system message (index 0)
 * 2. Find user/assistant turn boundaries
 * 3. Apply the T1.3 boundary aligner so cuts never split tool pairs and
 *    never archive the last user message.
 */
export function compactConversation(
  messages: ChatMessage[],
  maxTurns: number = 5,
  threshold: number = 80000,
  counter?: TokenCounter,
  prePruneOpts?: { enabled: boolean; options?: PrePruneOptions }
): ChatMessage[] {
  // T1.2: optional pre-prune BEFORE the threshold check. Disabled by default
  // (caller passes the env-gated flag). Pre-prune is a no-op if it doesn't
  // mutate anything, so cheap to leave in the call chain.
  let working = messages
  if (prePruneOpts?.enabled) {
    const result = prePrune(messages, prePruneOpts.options)
    working = result.messages
  }

  // P.2: prefer the provider-aware counter when available. `countSync` is a
  // best-effort path that never makes a network call — for Anthropic it
  // returns the heuristic upper bound, for OpenAI/tiktoken it's exact after
  // warmup. The caller (`runAgentLoop`) issues warmup at executor start.
  const tokenCount = counter ? counter.countSync(working) : heuristicCount(working)
  if (tokenCount < threshold) {
    return working
  }

  const systemMsgs = working.filter(m => m.role === 'system')
  const nonSystemMsgs = working.filter(m => m.role !== 'system')

  const turns = splitTurns(nonSystemMsgs)
  if (turns.length <= maxTurns) return working

  const proposedCut = turnIndexToMessageIndex(turns, turns.length - maxTurns)
  const { kept } = applyAlignedCut(systemMsgs, nonSystemMsgs, proposedCut)
  return kept
}
