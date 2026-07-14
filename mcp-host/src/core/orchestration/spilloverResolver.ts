/**
 * IronClaw invariant #2 (P.3): contract for resolving tool-result spillover
 * references at resume time.
 *
 * Background: when a tool's output exceeds the inline threshold, T1.5 writes
 * the body to `${WORKSPACE}/spillover/<task_id>/<tool_call_id>.json` and
 * stamps a `spillover_ref` URI on the corresponding ChatMessage/ToolResult.
 * `content` stays a string (a rich summary) so the wire format never breaks.
 *
 * At resume time the loop reconstructs `messages[]` from
 * `approval.context_snapshot + approval.completed_results + executed-tool`.
 * If any of those entries carries a `spillover_ref`, the resolver swaps in
 * the full body. If the blob is missing (TTL expired / GC'd) the resolver
 * throws ApprovalExpiredError — we NEVER silently regenerate the tool call.
 *
 * P.3 ships the contract and a StubSpilloverResolver. T1.5 ships the
 * FS-backed implementation.
 */
import type { ChatMessage, ToolResult } from '../types'

export interface SpilloverResolver {
  /**
   * Resolve a possibly-spillover entry to inline content for LLM injection.
   *
   * Contract:
   * - If `m.spillover_ref` is undefined: return `m.content` as-is.
   * - If `m.spillover_ref` is set and the blob exists: return the full body.
   * - If `m.spillover_ref` is set but the blob is gone (TTL expired / GC'd):
   *   THROW `ApprovalExpiredError` with the failing ref URI in `expired_refs`.
   *
   * MUST NOT silently regenerate the original tool call — the audit invariant
   * is that what executes equals what the user approved.
   */
  resolve(m: Pick<ChatMessage, 'content' | 'spillover_ref'>): Promise<string>

  /**
   * Probe-only variant: check whether all refs in a snapshot are still alive
   * without loading them. Used at cold-start sweep (T2.1) to mark expired
   * approvals upfront. Receives URIs only.
   */
  probe(refs: string[]): Promise<{ alive: string[]; expired: string[] }>
}

/**
 * O(1) predicate, no JSON parse — re-exported from here for callers that
 * only need the shape check (loop, taskExecutor).
 */
export function hasSpilloverRef(
  m: Pick<ChatMessage, 'spillover_ref'> | Pick<ToolResult, 'spillover_ref'>
): boolean {
  return typeof m.spillover_ref === 'string' && m.spillover_ref.length > 0
}

/**
 * No-op stub used until T1.5 ships the real resolver. During P.3 the snapshot
 * never contains refs (no writer exists yet), so `resolve` only ever sees
 * `spillover_ref === undefined` in production and throws if it doesn't —
 * which surfaces a programming error fast instead of silently mis-behaving.
 */
export class StubSpilloverResolver implements SpilloverResolver {
  async resolve(m: Pick<ChatMessage, 'content' | 'spillover_ref'>): Promise<string> {
    if (!m.spillover_ref) return m.content
    throw new Error(
      `[StubSpilloverResolver] spillover refs not yet supported (T1.5 pending); got ${m.spillover_ref}`
    )
  }

  async probe(): Promise<{ alive: string[]; expired: string[] }> {
    return { alive: [], expired: [] }
  }
}
